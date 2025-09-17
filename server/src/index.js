const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');

const MediasoupHandler = require('./mediasoup-handler');
const RecordingManager = require('./recording-manager');
const SessionStore = require('./session-store');
const PortAllocator = require('./utils/port-allocator');
const { generateSsrc } = require('./utils/ssrc');

dotenv.config();

const HTTP_PORT = Number(process.env.PORT || 8080);
const SFU_IP = process.env.SFU_IP || '127.0.0.1';
const VIDEO_ROOT = process.env.VIDEO_ROOT || path.join(process.cwd(), 'video');
const RTP_START_PORT = Number(process.env.SFU_PORT || 5000);

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const mediasoupHandler = new MediasoupHandler({
  listenIp: { ip: '0.0.0.0', announcedIp: SFU_IP },
  recordListenIp: { ip: '127.0.0.1', announcedIp: undefined },
  webRtcListenIps: [
    { ip: '0.0.0.0', announcedIp: SFU_IP },
  ],
});

const sessionStore = new SessionStore();
const recordingManager = new RecordingManager({ videoRoot: VIDEO_ROOT });
const ingestPortAllocator = new PortAllocator({ start: RTP_START_PORT, end: RTP_START_PORT + 1000 });
const recordingPortAllocator = new PortAllocator({ start: 22000, end: 23000 });

mediasoupHandler.setTupleListener((streamKey, tuple) => {
  const remote = `${tuple.remoteIp}:${tuple.remotePort}`;
  // console.log(`[RTP][INGEST] streamKey=${streamKey} remote=${remote}`);
  sessionStore.addSender(streamKey, remote);
  sessionStore.updateSession(streamKey, {
    status: 'streaming',
    lastRemote: remote,
  });
});

function respond(res, status, payload) {
  res.status(status).json(payload);
}
// 포트 할당 API (이미 할당된 포트가 있으면 그 포트를 반환)
app.post('/api/port/allocate', async (req, res) => {
  const { trainingId, sessionId, studentId, streamKey: requestStreamKey } = req.body || {};
  if (!trainingId || !sessionId || !studentId) {
    respond(res, 400, { error: 'trainingId, sessionId and studentId are required' });
    return;
  }

  const streamKey = requestStreamKey || uuidv4();
  const ports = ingestPortAllocator.allocatePair();
  let recordPorts;
  let recordingStarted = false;
  // sessionStore에 동일한 streamKey가 있으면 create 안함
  const session = sessionStore.getSession(streamKey);
  if (session) {
    respond(res, 200, {
      rtpUrl: `rtp://${SFU_IP}:${ingest.rtpPort}?rtcpport=${ingest.rtcpPort}`,
      rtcpPort: ingest.rtcpPort,
      ssrc: session.ssrc,
    });
    return;
  }
  sessionStore.createSession({
    trainingId,
    sessionId,
    studentId,
    streamKey,
    ingestPorts: ports,
  });

  try {
    const ssrc = generateSsrc(streamKey);
    const ingest = await mediasoupHandler.createIngest(streamKey, {
      port: ports.rtpPort,
      rtcpPort: ports.rtcpPort,
      ssrc,
    });

    sessionStore.updateSession(streamKey, {
      ssrc,
      ingestTransportId: ingest.transportId,
      rtpParameters: ingest.rtpParameters,
    });

    recordPorts = recordingPortAllocator.allocatePair();
    sessionStore.updateSession(streamKey, { recordPorts });

    // const recordingFiles = recordingManager.startRecording(sessionStore.getSession(streamKey), {
    //   ip: '127.0.0.1',
    //   port: recordPorts.rtpPort,
    //   rtcpPort: recordPorts.rtcpPort,
    //   payloadType: 96,
    //   ssrc,
    // });
    // recordingStarted = true;

    // await mediasoupHandler.createRecordingPipeline(streamKey, {
    //   ip: '127.0.0.1',
    //   port: recordPorts.rtpPort,
    //   rtcpPort: recordPorts.rtcpPort,
    // });

    respond(res, 200, {
      rtpUrl: `rtp://${SFU_IP}:${ingest.rtpPort}?rtcpport=${ingest.rtcpPort}`,
      rtcpPort: ingest.rtcpPort,
      ssrc,
      // recording: recordingFiles,
    });
  } catch (error) {
    console.error('failed to start session', error);
    if (recordingStarted) {
      recordingManager.stopRecording(streamKey);
    }
    if (recordPorts) {
      recordingPortAllocator.release(recordPorts);
    }
    await mediasoupHandler.closeSession(streamKey).catch(() => {});
    ingestPortAllocator.release(ports);
    sessionStore.removeSession(streamKey);
    respond(res, 500, { error: 'failed to start session' });
  }
});
// 스트림 종료 API
app.post('/api/stream/close', async (req, res) => {
  const { streamKey } = req.body || {};
  if (!streamKey) {
    respond(res, 400, { error: 'streamKey is required' });
    return;
  }

  const session = sessionStore.getSession(streamKey);
  if (!session) {
    respond(res, 404, { error: 'session not found' });
    return;
  }

  try {
    recordingManager.stopRecording(streamKey);
    await mediasoupHandler.closeSession(streamKey);
    if (session.ingestPorts) {
      ingestPortAllocator.release(session.ingestPorts);
    }
    if (session.recordPorts) {
      recordingPortAllocator.release(session.recordPorts);
    }
    sessionStore.removeSession(streamKey);
    respond(res, 200, { status: 'stopped', streamKey });
  } catch (error) {
    console.error('failed to stop session', error);
    respond(res, 500, { error: 'failed to stop session' });
  }
});
// 스트림 목록 반환 API
app.get('/api/sessions', (req, res) => {
  const sessions = sessionStore.listSessions();
  const streamKeys = sessions.map((session) => session.streamKey);
  respond(res, 200, {
    // sessions: sessionStore.listSessions(),
    streamKeys,
  });
});

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendSuccess(ws, action, requestId, data) {
  send(ws, { type: 'success', action, requestId, data });
}

function sendError(ws, action, requestId, message) {
  send(ws, { type: 'error', action, requestId, message });
}

wss.on('connection', (ws) => {
  console.log('websocket connected');
  ws.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: 'error', message: 'invalid json' });
      return;
    }

    const { action, requestId, streamKey } = payload;
    if (!action || !requestId) {
      send(ws, { type: 'error', message: 'action and requestId are required' });
      return;
    }

    if (streamKey && !sessionStore.getSession(streamKey)) {
      sendError(ws, action, requestId, 'unknown streamKey');
      return;
    }

    try {
      switch (action) {
        case 'getRouterRtpCapabilities': {
          await mediasoupHandler.init();
          const data = mediasoupHandler.getRouterRtpCapabilities();
          sendSuccess(ws, action, requestId, data);
          break;
        }
        case 'createWebRtcTransport': {
          const { direction } = payload;
          if (!streamKey) {
            sendError(ws, action, requestId, 'streamKey required');
            break;
          }
          const data = await mediasoupHandler.createWebRtcTransport(streamKey, direction || 'recv');
          sendSuccess(ws, action, requestId, data);
          break;
        }
        case 'connectTransport': {
          const { transportId, dtlsParameters } = payload;
          const data = await mediasoupHandler.connectWebRtcTransport(transportId, dtlsParameters);
          sendSuccess(ws, action, requestId, data);
          break;
        }
        case 'consume': {
          const { transportId, rtpCapabilities } = payload;
          if (!streamKey) {
            sendError(ws, action, requestId, 'streamKey required');
            break;
          }
          const data = await mediasoupHandler.consume(streamKey, transportId, rtpCapabilities);
          sendSuccess(ws, action, requestId, data);
          break;
        }
        case 'resumeConsumer': {
          const { consumerId } = payload;
          const data = await mediasoupHandler.resumeConsumer(consumerId);
          sendSuccess(ws, action, requestId, data);
          break;
        }
        default:
          sendError(ws, action, requestId, `unknown action ${action}`);
      }
    } catch (error) {
      console.error(`error handling action ${action}`, error);
      sendError(ws, action, requestId, error.message);
    }
  });

  ws.on('close', () => {
    console.log('websocket closed');
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`SFU server listening on port ${HTTP_PORT}`);
  console.log(`Video files will be stored in ${VIDEO_ROOT}`);
});

// 서버 종료 시 모든 녹화 프로세스 정리
function cleanup() {
  // console.log('Server shutting down, cleaning up recording processes...');
  recordingManager.stopAllRecordings();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => {
  recordingManager.stopAllRecordings();
});
