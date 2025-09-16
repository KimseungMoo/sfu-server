# SFU 서버 미디어 파이프라인 문서

학생 클라이언트에서 전송한 H.264 RTP 스트림을 SFU 서버가 수신하여 강사 클라이언트로 WebRTC 중계하고, 동시에 MP4 파일로 녹화하는 전체 흐름을 설명합니다.

## 🏗️ 전체 아키텍처

```
┌─────────────────┐    RTP(H.264)    ┌─────────────────┐    WebRTC       ┌─────────────────┐
│   학생 클라이언트   │ ──────────────► │   SFU 서버       │ ──────────────► │   강사 클라이언트   │
│ (FFmpeg/카메라)  │                 │  (mediasoup)    │                 │  (React)        │
│ 자동 스트림 전송   │                 │  WebRTC 중계     │                 │  실시간 비디오     │
└─────────────────┘                 └─────────────────┘                 └─────────────────┘
                                              │
                                              ▼
                                     ┌─────────────────┐
                                     │   MP4 녹화 파일   │
                                     │  (VIDEO_ROOT)    │
                                     └─────────────────┘
```

## 🔧 핵심 구성 요소

### 1. RTP 수신 PlainTransport
- `/api/session/start` 호출 시 `PortAllocator`가 RTP/RTCP 포트를 할당합니다.
- `mediasoup-handler.createIngest`가 `PlainTransport`(comedia, rtcpMux=false)를 생성하고 고정 SSRC로 Producer를 등록합니다.
- `tuple` 이벤트를 통해 실제 송신자 IP:PORT 정보를 `SessionStore`에 기록합니다.

### 2. WebRTC 전달
- 강사 클라이언트는 WebSocket(`/ws`)으로 다음 시그널링 순서를 따릅니다.
  1. `action: "getRouterRtpCapabilities"`
  2. `action: "createWebRtcTransport"` (`direction: "recv"`)
  3. `action: "connectTransport"`
  4. `action: "consume"`
  5. `action: "resumeConsumer"`
- 서버는 각 요청마다 `requestId`를 요구하며, 성공 시 `{ type: "success", action, requestId, data }` 형식으로 응답합니다.

### 3. 녹화 파이프라인
- 세션 생성 후 별도의 `PlainTransport`를 생성하여 FFmpeg로 RTP를 전송합니다.
- `RecordingManager`가 SDP 파일을 생성하고 `ffmpeg -c copy`로 MP4를 저장합니다.
- 파일 경로는 `VIDEO_ROOT/<training>/<session>/<student>/<streamKey>.{sdp,mp4}` 형태입니다.

## 📡 데이터 흐름 단계

### Phase 1: 세션 생성

```http
POST /api/session/start
{
  "trainingId": "T001",
  "sessionId": "S001",
  "studentId": "ST001"
}
```

응답에는 RTP URL, RTCP 포트, SSRC, 녹화 파일 경로가 포함됩니다. 학생 클라이언트는 해당 정보로 FFmpeg를 실행합니다.

### Phase 2: 학생 RTP 전송

```bash
ffmpeg -re -stream_loop -1 -i input.mp4 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -profile:v baseline -level 3.1 -f rtp \
  -payload_type 96 -ssrc <SSRC> \
  "rtp://<SFU_IP>:<RTP_PORT>?rtcpport=<RTCP_PORT>&pkt_size=1200"
```

### Phase 3: Producer 생성

`mediasoup-handler`는 H.264 전용 코덱 파라미터를 사용하여 Producer를 만들고, 추후 WebRTC/녹화 Consumer가 재사용할 수 있도록 `rtpParameters`를 저장합니다.

### Phase 4: WebRTC Consumer 연결

```javascript
const ws = new WebSocket('ws://<SFU_HOST>:8080/ws');
let seq = 0;
const send = (action, data = {}) => new Promise((resolve, reject) => {
  const requestId = `req-${++seq}`;
  ws.send(JSON.stringify({ action, requestId, streamKey: '<STREAM_KEY>', ...data }));
  const handler = (event) => {
    const message = JSON.parse(event.data);
    if (message.requestId === requestId) {
      ws.removeEventListener('message', handler);
      if (message.type === 'error') reject(new Error(message.message));
      else resolve(message.data);
    }
  };
  ws.addEventListener('message', handler);
});
```

이후 mediasoup-client `Device`를 이용해 Transport 생성 및 Consumer 연결을 진행합니다.

```javascript
const device = new mediasoupClient.Device();
const routerCaps = await send('getRouterRtpCapabilities');
await device.load({ routerRtpCapabilities: routerCaps });

const transportInfo = await send('createWebRtcTransport', { direction: 'recv' });
const transport = device.createRecvTransport(transportInfo);
transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
  try {
    await send('connectTransport', { transportId: transport.id, dtlsParameters });
    callback();
  } catch (err) {
    errback(err);
  }
});

const consumeInfo = await send('consume', {
  transportId: transport.id,
  rtpCapabilities: device.rtpCapabilities,
});
const consumer = await transport.consume(consumeInfo);
await send('resumeConsumer', { consumerId: consumer.id });
```

### Phase 5: MP4 녹화

`RecordingManager`가 생성한 SDP는 예시와 같습니다.

```
v=0
o=- 0 0 IN IP4 127.0.0.1
s=SFU Recording
c=IN IP4 127.0.0.1
t=0 0
a=tool:libavformat 61.1
m=video 6000 RTP/AVP 96
a=rtcp:6001
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1;profile-level-id=42e01f
a=ssrc:305419896 cname:stream-305419896
```

FFmpeg는 해당 SDP를 입력으로 받아 RTP를 수신하고, `-c copy` 옵션을 통해 인코딩 없이 MP4를 저장합니다.

## 🗂️ 상태/모니터링 API

| 엔드포인트 | 설명 |
| --- | --- |
| `GET /api/sessions` | 활성 세션과 송신자(IP:PORT) 매핑 정보 |
| `GET /api/mediasoup/status` | Worker/Router/Producer/Transport 통계 |
| `GET /api/rtp/status` | 현재 녹화 중인 스트림 및 파일 경로 |
| `GET /healthz` | 서버 헬스 체크 |

## ⚠️ 유의 사항

- 모든 스트림은 고정 SSRC를 사용하여 RTP 패킷 충돌을 방지합니다.
- 학생 RTP 스트림이 시작되기 전에는 WebRTC Consumer가 생성되지 않으므로, 클라이언트에서 재시도 로직을 준비하는 것이 좋습니다.
- FFmpeg 프로세스가 종료되면 `RecordingManager`가 자동으로 정리합니다. 비정상 종료 시 `POST /api/session/stop`을 호출하세요.

이 문서를 참고하면 mediasoup 기반 SFU 서버의 전체 미디어 파이프라인과 데이터 흐름을 이해할 수 있습니다.
