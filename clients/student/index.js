#!/usr/bin/env node
const os = require('os');
const { spawn } = require('child_process');

const CAMERA_LIST_FLAG = 'list-cameras';

const isMac = () => os.platform() === 'darwin';

function parseIntOrUndefined(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key.startsWith('--')) {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        result[key.substring(2)] = true;
      } else {
        result[key.substring(2)] = next;
        i += 1;
      }
    }
  }
  return result;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`request failed (${response.status}): ${error}`);
  }
  return response.json();
}

async function listCameras() {
  if (!isMac()) {
    throw new Error('camera enumeration is only supported on macOS');
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-f',
      'avfoundation',
      '-list_devices',
      'true',
      '-i',
      '',
    ]);

    let stderr = '';
    ffmpeg.stdout.on('data', (data) => {
      stderr += data.toString();
    });
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    ffmpeg.on('error', (error) => {
      reject(new Error(`failed to execute ffmpeg: ${error.message}`));
    });
    ffmpeg.on('close', () => {
      const devices = [];
      const lines = stderr.split('\n');
      let inVideoSection = false;
      for (const line of lines) {
        if (line.includes('AVFoundation video devices')) {
          inVideoSection = true;
          continue;
        }
        if (inVideoSection && line.includes('AVFoundation audio devices')) {
          inVideoSection = false;
          continue;
        }
        if (!inVideoSection) {
          continue;
        }
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          devices.push({ index: Number.parseInt(match[1], 10), name: match[2].trim() });
        }
      }
      resolve(devices);
    });
  });
}

function buildCameraFfmpegArgs({
  camera,
  framerate,
  bitrate,
  payloadType,
  ssrc,
  targetUrl,
}) {
  const args = [
    '-f', 'avfoundation',
    '-framerate', String(framerate || 30),
    // '-video_size', '1280x720',  // 명시적으로 캡처 해상도 설정
    '-pixel_format', 'uyvy422',
    '-i', `${camera}:none`,
    '-an',
    // '-vf', 'scale=1280:720',  // 출력 해상도 고정
    '-c:v', 'h264_videotoolbox',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',  // 낮은 지연시간을 위해 baseline 사용
    '-level', '3.1',
    '-g', '15',  // GOP size 감소 (keyframe 간격 단축으로 지연시간 감소)
    '-keyint_min', '15',  // Minimum keyframe interval 감소
    '-bf', '0',  // B-frames 비활성화 (지연시간 감소)
    '-sc_threshold', '0',  // Scene change threshold
    '-allow_sw', '1',  // 하드웨어 인코더 실패 시 소프트웨어 폴백 허용
    '-realtime', '1',  // 실시간 인코딩 활성화
    '-low_power', '1',  // 낮은 지연시간 모드
  ];

  if (bitrate) {
    args.push('-b:v', bitrate);
    args.push('-maxrate', bitrate);
    args.push('-bufsize', bitrate);
  } else {
    // 기본 비트레이트 설정
    args.push('-b:v', '2M');
    args.push('-maxrate', '2M');
    args.push('-bufsize', '4M');
  }

  args.push(
    '-f', 'rtp',
    '-payload_type', String(payloadType || 96),
    '-ssrc', String(ssrc),
    targetUrl,
  );

  return args;
}

function buildCameraFfmpegArgsSoftware({
  camera,
  framerate,
  bitrate,
  payloadType,
  ssrc,
  targetUrl,
}) {
  console.log('Using software encoder (libx264) as fallback');
  const args = [
    '-f', 'avfoundation',
    '-framerate', String(framerate || 30),
    '-video_size', '1280x720',  // 명시적으로 캡처 해상도 설정
    '-pixel_format', 'uyvy422',
    '-i', `${camera}:none`,
    '-an',
    '-vf', 'scale=1280:720',  // 출력 해상도 고정
    '-c:v', 'libx264',  // 소프트웨어 인코더 사용
    '-preset', 'ultrafast',  // 낮은 지연시간을 위한 설정
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', '15',  // GOP size 감소 (지연시간 감소)
    '-keyint_min', '15',  // Minimum keyframe interval 감소
    '-bf', '0',  // B-frames 비활성화
    '-sc_threshold', '0',  // Scene change threshold
    '-threads', '0',  // 모든 사용 가능한 CPU 스레드 사용
  ];

  if (bitrate) {
    args.push('-b:v', bitrate);
    args.push('-maxrate', bitrate);
    args.push('-bufsize', bitrate);
  } else {
    // 기본 비트레이트 설정
    args.push('-b:v', '2M');
    args.push('-maxrate', '2M');
    args.push('-bufsize', '4M');
  }

  args.push(
    '-f', 'rtp',
    '-payload_type', String(payloadType || 96),
    '-ssrc', String(ssrc),
    targetUrl,
  );

  return args;
}

function buildFileFfmpegArgs({
  source,
  payloadType,
  ssrc,
  targetUrl,
}) {
  return [
    '-re',
    '-stream_loop', '-1',
    '-i', source,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', '30',  // GOP size (keyframe interval)
    '-keyint_min', '30',  // Minimum keyframe interval
    '-sc_threshold', '0',  // Scene change threshold
    '-b:v', '2M',
    '-maxrate', '2M',
    '-bufsize', '4M',
    '-f', 'rtp',
    '-payload_type', String(payloadType || 96),
    '-ssrc', String(ssrc),
    targetUrl,
  ];
}

async function main() {
  const options = parseArgs();
  const server = options.server || 'http://localhost:8080';
  const trainingId = options.training || 'TRAINING';
  const sessionId = options.session || 'SESSION';
  const studentId = options.student || 'STUDENT';
  const source = options.source;
  const camera = parseIntOrUndefined(options.camera);

  if (options[CAMERA_LIST_FLAG]) {
    const devices = await listCameras();
    if (!devices.length) {
      console.log('no cameras detected');
    } else {
      console.log('available cameras:');
      devices.forEach((device) => {
        console.log(`  [${device.index}] ${device.name}`);
      });
    }
    return;
  }

  if (!source && camera === undefined) {
    console.error('provide either --source path/to/video.mp4 or --camera <index>');
    console.error('use --list-cameras to discover available camera indices');
    process.exit(1);
  }

  const startResponse = await postJson(`${server}/api/session/start`, {
    trainingId,
    sessionId,
    studentId,
  });

  const {
    streamKey,
    rtpUrl,
    rtcpPort,
    ssrc,
    payloadType,
  } = startResponse;

  console.log('session ready');
  console.log(`streamKey: ${streamKey}`);
  console.log(`rtpUrl: ${rtpUrl}`);
  console.log(`rtcpPort: ${rtcpPort}`);
  console.log(`ssrc: ${ssrc}`);

  const targetUrl = rtcpPort ? `${rtpUrl}?rtcpport=${rtcpPort}&pkt_size=1200` : `${rtpUrl}?pkt_size=1200`;
  // const targetUrl = `${rtpUrl}?pkt_size=1200`
  let ffmpegArgs;
  let softwareFfmpegArgs = null;
  if (camera !== undefined) {
    if (!isMac()) {
      console.error('camera streaming is currently supported on macOS only');
      process.exit(1);
    }

    const devices = await listCameras();
    const selected = devices.find((device) => device.index === camera);
    if (!selected) {
      console.error(`camera index ${camera} not found. use --list-cameras to view available options.`);
      process.exit(1);
    }

    console.log(`using camera [${selected.index}] ${selected.name}`);
    ffmpegArgs = buildCameraFfmpegArgs({
      camera: selected.index,
      framerate: parseIntOrUndefined(options.framerate) || undefined,
      bitrate: options.bitrate,
      payloadType,
      ssrc,
      targetUrl,
    });

    // 소프트웨어 인코더 폴백 옵션 준비
    softwareFfmpegArgs = buildCameraFfmpegArgsSoftware({
      camera: selected.index,
      framerate: parseIntOrUndefined(options.framerate) || undefined,
      bitrate: options.bitrate,
      payloadType,
      ssrc,
      targetUrl,
    });
  } else {
    ffmpegArgs = buildFileFfmpegArgs({
      source,
      payloadType,
      ssrc,
      targetUrl,
    });
  }

  const startFfmpeg = (args, useSoftwareEncoder = false) => {
    console.log(`starting ffmpeg ${useSoftwareEncoder ? '(software encoder)' : '(hardware encoder)'} -> ${targetUrl}`);
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });

    const stopSession = async () => {
      try {
        await postJson(`${server}/api/session/stop`, { streamKey });
        console.log('session stopped');
      } catch (error) {
        console.error('failed to stop session', error);
      }
    };

    ffmpeg.on('exit', async (code) => {
      if (code !== 0 && !useSoftwareEncoder && camera !== undefined && softwareFfmpegArgs) {
        console.log(`Hardware encoder failed with code ${code}, trying software encoder...`);
        startFfmpeg(softwareFfmpegArgs, true);
        return;
      }
      await stopSession();
    });

    process.on('SIGINT', async () => {
      ffmpeg.kill('SIGINT');
      await stopSession();
      process.exit(0);
    });

    return ffmpeg;
  };

  const ffmpeg = startFfmpeg(ffmpegArgs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
