const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class RecordingManager {
  constructor({ videoRoot }) {
    this.videoRoot = videoRoot;
    this.recordings = new Map();
    this.cleanupExistingProcesses();
  }

  cleanupExistingProcesses() {
    console.log('Cleaning up existing FFmpeg recording processes...');
    try {
      // macOS/Linux에서 FFmpeg 녹화 프로세스 찾기 및 종료
      const { spawn } = require('child_process');
      
      // FFmpeg 프로세스 중 SDP 파일을 사용하는 프로세스 찾기
      const killProcess = spawn('pkill', ['-f', 'ffmpeg.*\\.sdp'], { stdio: 'pipe' });
      
      killProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('Successfully cleaned up existing FFmpeg recording processes');
        } else {
          console.log('No existing FFmpeg recording processes found (or cleanup completed)');
        }
      });
      
      killProcess.on('error', (error) => {
        console.log('Note: Could not cleanup existing FFmpeg processes:', error.message);
      });
      
    } catch (error) {
      console.log('Note: Could not cleanup existing FFmpeg processes:', error.message);
    }
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
      `a=fmtp:${payloadType} packetization-mode=1;profile-level-id=42e01f`,
      `a=ssrc:${ssrc} cname:stream-${ssrc}`,
    ].join('\n');
  }

  startRecording(session, { ip, port, rtcpPort, payloadType, ssrc }) {
    // 동일한 streamKey로 이미 실행 중인 녹화가 있다면 중지
    this.stopRecording(session.streamKey);
    
    const filePaths = this.buildFilePaths(session);
    const sdpContent = this.createSdpContent({ ip, port, rtcpPort, payloadType, ssrc });
    fs.writeFileSync(filePaths.sdpPath, `${sdpContent}\n`);

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-protocol_whitelist', 'file,udp,rtp',
      '-fflags', '+genpts',
      '-use_wallclock_as_timestamps', '1',
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

    child.stderr.on('data', (data) => {
      const line = data.toString();
      if (line && line.trim()) {
        console.log(`[recording ${session.streamKey}] ${line.trim()}`);
      }
    });
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
    
    const process = entry.process;
    if (process && !process.killed) {
      console.log(`Stopping recording process for ${streamKey} (PID: ${process.pid})`);
      
      // 먼저 SIGINT로 정상 종료 시도
      process.kill('SIGINT');
      
      // 3초 후에도 종료되지 않으면 강제 종료
      setTimeout(() => {
        if (!process.killed) {
          console.log(`Force killing recording process for ${streamKey} (PID: ${process.pid})`);
          process.kill('SIGKILL');
        }
      }, 3000);
    }
    
    this.recordings.delete(streamKey);
  }

  stopAllRecordings() {
    console.log(`Stopping all recording processes (${this.recordings.size} active recordings)`);
    for (const streamKey of this.recordings.keys()) {
      this.stopRecording(streamKey);
    }
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
