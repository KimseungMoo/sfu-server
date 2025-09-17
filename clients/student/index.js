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
    '-framerate', String(framerate || 20),  // 프레임레이트를 20fps로 감소
    '-video_size', '1280x720',  // 해상도를 720p로 감소
    '-pixel_format', 'uyvy422',
    '-i', `${camera}:none`,
    '-an',
    '-vf', 'scale=1280:720',  // 출력 해상도를 720p로 고정
    '-c:v', 'h264_videotoolbox',  // 하드웨어 인코더 사용
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', '20',  // GOP size를 20으로 증가 (CPU 부하 감소)
    '-keyint_min', '20',
    '-bf', '0',
    '-sc_threshold', '0',
    '-allow_sw', '1',
    '-realtime', '1',
    '-low_power', '1',
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
  // console.log('Using software encoder (libx264) as fallback');
  const args = [
    '-f', 'avfoundation',
    '-framerate', String(framerate || 20),  // 프레임레이트를 20fps로 감소
    '-video_size', '1280x720',  // 해상도를 720p로 감소
    '-pixel_format', 'uyvy422',
    '-i', `${camera}:none`,
    '-an',
    '-vf', 'scale=1280:720',  // 출력 해상도를 720p로 고정
    '-c:v', 'libx264',  // 소프트웨어 인코더 사용
    '-preset', 'fast',  // ultrafast 대신 fast 사용 (CPU와 품질의 균형)
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', '20',  // GOP size를 20으로 증가 (CPU 부하 감소)
    '-keyint_min', '20',
    '-bf', '0',
    '-sc_threshold', '0',
    '-threads', '2',  // CPU 스레드를 2개로 제한 (과도한 CPU 사용 방지)
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
    '-vf', 'scale=1280:720',  // 해상도를 720p로 스케일링
    '-c:v', 'libx264',
    '-preset', 'fast',  // ultrafast 대신 fast 사용
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', '30',  // GOP size (keyframe interval)
    '-keyint_min', '30',  // Minimum keyframe interval
    '-sc_threshold', '0',  // Scene change threshold
    '-threads', '2',  // CPU 스레드를 2개로 제한
    '-b:v', '1500k',  // 비트레이트를 1.5M으로 감소
    '-maxrate', '1800k',  // 최대 비트레이트 감소
    '-bufsize', '3000k',  // 버퍼 크기 감소
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
      // console.log('available cameras:');
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

  const startResponse = await postJson(`${server}/api/port/allocate`, {
    trainingId,
    sessionId,
    studentId,
  });

  const {
    streamKey,
    rtpUrl,
    rtcpPort,
    ssrc,
  } = startResponse;

  // console.log('session ready');
  // console.log(`rtpUrl: ${rtpUrl}`);
  // console.log(`rtcpPort: ${rtcpPort}`);
  // console.log(`ssrc: ${ssrc}`);

  // Build target RTP URL safely: server may already include query (e.g. '?rtcpport=...')
  let targetUrl = rtpUrl;
  const hasQuery = rtpUrl.includes('?');
  if (rtcpPort && !rtpUrl.includes('rtcpport=')) {
    targetUrl += (hasQuery ? '&' : '?') + `rtcpport=${rtcpPort}`;
  }
  // Always cap packet size for MTU safety
  targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'pkt_size=1200';
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

    // console.log(`using camera [${selected.index}] ${selected.name}`);
    ffmpegArgs = buildCameraFfmpegArgs({
      camera: selected.index,
      framerate: parseIntOrUndefined(options.framerate) || undefined,
      bitrate: options.bitrate,
      payloadType: 96,
      ssrc,
      targetUrl,
    });

    // 소프트웨어 인코더 폴백 옵션 준비
    softwareFfmpegArgs = buildCameraFfmpegArgsSoftware({
      camera: selected.index,
      framerate: parseIntOrUndefined(options.framerate) || undefined,
      bitrate: options.bitrate,
      payloadType: 96,
      ssrc,
      targetUrl,
    });
  } else {
    ffmpegArgs = buildFileFfmpegArgs({
      source,
      payloadType: 96,
      ssrc,
      targetUrl,
    });
  }

  const startFfmpeg = (args, useSoftwareEncoder = false) => {
    // console.log(`starting ffmpeg ${useSoftwareEncoder ? '(software encoder)' : '(hardware encoder)'} -> ${targetUrl}`);
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });

    const stopSession = async () => {
      try {
        await postJson(`${server}/api/stream/close`, { streamKey });
        // console.log('session stopped');
      } catch (error) {
        console.error('failed to stop session', error);
      }
    };

    ffmpeg.on('exit', async (code) => {
      if (code !== 0 && !useSoftwareEncoder && camera !== undefined && softwareFfmpegArgs) {
        // console.log(`Hardware encoder failed with code ${code}, trying software encoder...`);
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
