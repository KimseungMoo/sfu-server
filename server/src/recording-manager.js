const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class RecordingManager {
  constructor({ videoRoot }) {
    this.videoRoot = videoRoot;
    this.recordings = new Map();
  }

  ensureDirectory({ trainingId, sessionId, studentId }) {
    const dir = path.join(this.videoRoot, trainingId, sessionId, studentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  buildFilePaths(session) {
    const dir = this.ensureDirectory(session);
    const base = path.join(dir, session.streamKey);
    return {
      directory: dir,
      sdpPath: `${base}.sdp`,
      mp4Path: `${base}.mp4`,
    };
  }

  createSdpContent({ ip, port, rtcpPort, payloadType, ssrc }) {
    return [
      'v=0',
      `o=- 0 0 IN IP4 ${ip}`,
      's=SFU Recording',
      `c=IN IP4 ${ip}`,
      't=0 0',
      'a=tool:libavformat 61.1',
      `m=video ${port} RTP/AVP ${payloadType}`,
      `a=rtcp:${rtcpPort}`,
      `a=rtpmap:${payloadType} H264/90000`,
      'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f',
      `a=ssrc:${ssrc} cname:stream-${ssrc}`,
    ].join('\n');
  }

  startRecording(session, { ip, port, rtcpPort, payloadType, ssrc }) {
    const filePaths = this.buildFilePaths(session);
    const sdpContent = this.createSdpContent({ ip, port, rtcpPort, payloadType, ssrc });
    fs.writeFileSync(filePaths.sdpPath, `${sdpContent}\n`);

    const args = [
      '-protocol_whitelist', 'file,udp,rtp',
      '-i', filePaths.sdpPath,
      '-c', 'copy',
      '-movflags', 'faststart',
      '-y',
      filePaths.mp4Path,
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`recording started for ${session.streamKey} -> ${filePaths.mp4Path}`);
    this.recordings.set(session.streamKey, {
      process: child,
      filePaths,
    });

    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      console.log(`recording stopped for ${session.streamKey} (code ${code})`);
      this.recordings.delete(session.streamKey);
    });

    return filePaths;
  }

  stopRecording(streamKey) {
    const entry = this.recordings.get(streamKey);
    if (!entry) {
      return;
    }
    entry.process.kill('SIGINT');
    this.recordings.delete(streamKey);
  }

  getStatus() {
    const result = {};
    for (const [streamKey, { filePaths }] of this.recordings.entries()) {
      result[streamKey] = {
        mp4Path: filePaths.mp4Path,
        sdpPath: filePaths.sdpPath,
      };
    }
    return result;
  }
}

module.exports = RecordingManager;
