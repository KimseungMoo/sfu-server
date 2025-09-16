#!/usr/bin/env node
const { spawn } = require('child_process');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key.startsWith('--')) {
      const value = args[i + 1];
      result[key.substring(2)] = value;
      i += 1;
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

async function main() {
  const options = parseArgs();
  const server = options.server || 'http://localhost:8080';
  const trainingId = options.training || 'TRAINING';
  const sessionId = options.session || 'SESSION';
  const studentId = options.student || 'STUDENT';
  const source = options.source;

  if (!source) {
    console.error('source media path is required (use --source path/to/video.mp4)');
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

  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', source,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-f', 'rtp',
    '-payload_type', String(payloadType || 96),
    '-ssrc', String(ssrc),
    targetUrl,
  ];

  console.log(`starting ffmpeg -> ${targetUrl}`);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

  const stopSession = async () => {
    try {
      await postJson(`${server}/api/session/stop`, { streamKey });
      console.log('session stopped');
    } catch (error) {
      console.error('failed to stop session', error);
    }
  };

  ffmpeg.on('exit', async () => {
    await stopSession();
  });

  process.on('SIGINT', async () => {
    ffmpeg.kill('SIGINT');
    await stopSession();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
