# SFU 서버 사용 가이드

이 문서는 mediasoup 기반 SFU 서버와 학생/강사 클라이언트를 빠르게 테스트하고 운영하기 위한 절차를 정리합니다. 모든 명령은 프로젝트 루트(`/workspace/sfu-server`) 기준으로 설명합니다.

## 🚀 빠른 시작

### 1. 서버 설치 및 실행

```bash
cd server
npm install
VIDEO_ROOT=/Users/you/videos npm start
```

환경 변수로 저장 경로와 시그널링 포트를 조절할 수 있습니다.

```bash
export VIDEO_ROOT=/Users/you/videos
export SFU_IP=192.168.0.49
export SFU_PORT=5000
export PORT=8080
```

### 2. 세션 생성

```bash
curl -X POST http://localhost:8080/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST001"}'
```

예상 응답:

```json
{
  "status": "ready",
  "streamKey": "d472b956-3ce4-4e49-9060-12dc86b6d660",
  "rtpUrl": "rtp://192.168.0.49:5000",
  "rtcpPort": 5001,
  "ssrc": 305419896,
  "payloadType": 96,
  "recording": {
    "directory": "/Users/you/videos/T001/S001/ST001",
    "sdpPath": "/Users/you/videos/T001/S001/ST001/d472b956-3ce4-4e49-9060-12dc86b6d660.sdp",
    "mp4Path": "/Users/you/videos/T001/S001/ST001/d472b956-3ce4-4e49-9060-12dc86b6d660.mp4"
  }
}
```

### 3. 학생 클라이언트로 RTP 스트림 송출

```bash
cd clients/student
node index.js \
  --server http://192.168.0.49:8080 \
  --training T001 \
  --session S001 \
  --student ST001 \
  --source /path/to/video.mp4
```

스크립트는 세션을 자동 생성하고 응답으로 받은 RTP 주소 및 SSRC를 이용해 FFmpeg을 실행합니다. `Ctrl+C`로 종료하면 세션 정리 API가 호출됩니다.

### 4. 강사 클라이언트에서 WebRTC 소비

```bash
cd clients/instructor
npm install
npm run dev -- --host
```

브라우저에서 `http://<HOST>:5173`에 접속하여 서버 URL과 streamKey를 입력한 뒤 **Connect**를 눌러 스트림을 시청합니다. 연결이 완료되면 비디오 요소에 실시간 영상이 표시됩니다.

## 📡 단계별 상세 가이드

### Phase 1: 환경 확인

```bash
node -v            # v18 이상 필요
ffmpeg -version    # FFmpeg 설치 확인
lsof -i :8080      # 포트 사용 여부
```

### Phase 2: 서버 모니터링

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/api/mediasoup/status | jq
curl http://localhost:8080/api/sessions | jq
```

`server/check-ports.js` 스크립트를 이용하면 외부에서 필수 포트를 동시에 점검할 수 있습니다.

```bash
node server/check-ports.js 192.168.0.49
```

### Phase 3: 다중 세션

```bash
# 세션 1
curl -X POST http://localhost:8080/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST001"}'

# 세션 2
curl -X POST http://localhost:8080/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST002"}'
```

활성 세션 및 송신자 매핑은 다음 명령으로 확인할 수 있습니다.

```bash
curl http://localhost:8080/api/sessions | jq '.senderMappings'
```

### Phase 4: 학생 클라이언트 세부 설정

macOS 카메라에서 직접 전송하려면 다음과 같이 실행합니다.

```bash
ffmpeg -f avfoundation -framerate 30 -video_size 1280x720 \
  -i 0:none -c:v libx264 -preset ultrafast -tune zerolatency \
  -an -f rtp rtp://192.168.0.49:5000
```

사용 가능한 카메라 목록은 `ffmpeg -f avfoundation -list_devices true -i ""`로 확인합니다.

### Phase 5: 강사 클라이언트 시그널링

WebSocket 시그널링은 `action`과 `requestId` 필드를 사용합니다. 아래 예시는 브라우저 콘솔에서 mediasoup 연결 절차를 수행하는 방법입니다.

```javascript
const ws = new WebSocket('ws://192.168.0.49:8080/ws');
let seq = 0;
const sendRequest = (action, data = {}) => new Promise((resolve, reject) => {
  const requestId = `req-${++seq}`;
  ws.send(JSON.stringify({ action, requestId, streamKey: '<STREAM_KEY>', ...data }));
  const handleMessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.requestId === requestId) {
      ws.removeEventListener('message', handleMessage);
      msg.type === 'error' ? reject(new Error(msg.message)) : resolve(msg.data);
    }
  };
  ws.addEventListener('message', handleMessage);
});
```

이후 mediasoup-client `Device`를 사용하여 Transport 생성 및 Consumer 생성을 진행합니다.

```javascript
const device = new mediasoupClient.Device();
const routerCaps = await sendRequest('getRouterRtpCapabilities');
await device.load({ routerRtpCapabilities: routerCaps });

const transportInfo = await sendRequest('createWebRtcTransport', { direction: 'recv' });
const transport = device.createRecvTransport(transportInfo);
transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
  try {
    await sendRequest('connectTransport', { transportId: transport.id, dtlsParameters });
    callback();
  } catch (err) {
    errback(err);
  }
});

const consumeInfo = await sendRequest('consume', {
  transportId: transport.id,
  rtpCapabilities: device.rtpCapabilities,
});
const consumer = await transport.consume(consumeInfo);
await sendRequest('resumeConsumer', { consumerId: consumer.id });
```

### Phase 6: 녹화 파일 확인

녹화 파일은 기본적으로 `VIDEO_ROOT/<trainingId>/<sessionId>/<studentId>/<streamKey>.mp4` 경로에 저장됩니다.

```bash
find "$VIDEO_ROOT" -name "*.mp4" -newermt "1 hour ago" -exec ls -lh {} \;
```

## 🐛 문제 해결

| 증상 | 확인 사항 |
| --- | --- |
| 비디오가 표시되지 않음 | Producer/Consumer 상태 (`/api/mediasoup/status`), 브라우저 콘솔 오류 |
| WebRTC 연결 실패 | 방화벽에서 10000-20000 포트 개방, 시그널링 로그 확인 |
| RTP 스트림 미도착 | `curl /api/sessions`, `node server/check-ports.js`로 포트 확인 |
| 녹화 실패 | FFmpeg 설치 상태, `VIDEO_ROOT` 권한, 서버 로그 확인 |

## 📦 추가 자료

- [네트워크 설정 가이드](./NETWORK_SETUP.md)
- [미디어 파이프라인 문서](./SFU_MEDIA_PIPELINE.md)
- `server/check-ports.js` – 필수 포트 진단 스크립트

위 단계를 따르면 학생 RTP 스트림을 SFU 서버에서 WebRTC로 중계하고 동시에 MP4로 녹화할 수 있습니다.
