# SFU Server

Mediasoup 기반 SFU 서버와 테스트용 학생/강사 클라이언트입니다. 학생 클라이언트가 FFmpeg 으로 H.264 RTP 스트림을 전송하면 SFU 서버가 이를 수신하여 mediasoup Producer를 구성하고, 강사 클라이언트(WebRTC Consumer)로 스트리밍하면서 동시에 MP4 파일로 저장합니다.

## 프로젝트 구조

```
.
├── server/                # SFU 서버 (Express + mediasoup)
├── clients/
│   ├── student/           # RTP 전송용 FFmpeg 학생 클라이언트
│   └── instructor/        # React 기반 강사 WebRTC 클라이언트
└── README.md
```

## 1. SFU 서버

### 설치 및 실행

```bash
cd server
npm install   # 필요한 경우 --legacy-peer-deps 옵션 사용
VIDEO_ROOT=/path/to/video npm start
```

기본 환경 변수는 아래와 같습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `VIDEO_ROOT` | `<repo>/server/video` | MP4/SDP 저장 경로 |
| `SFU_IP` | `127.0.0.1` | 학생/강사 클라이언트가 접속할 SFU 공인 IP |
| `SFU_PORT` | `5000` | 학생 RTP 입력 시작 포트 (세션마다 2씩 증가) |
| `PORT` | `8080` | HTTP & WebSocket 포트 |

### 주요 엔드포인트

- `POST /api/session/start`
  - 요청: `{ "trainingId", "sessionId", "studentId" }`
  - 응답: `{ status, streamKey, rtpUrl, rtcpPort, ssrc, payloadType, recording }`
  - 세션 생성, RTP 포트 할당, 녹화 시작
- `POST /api/session/stop`
  - 요청: `{ "streamKey" }`
  - 세션 종료 및 리소스 정리
- `GET /api/sessions`
  - 활성 세션과 RTP 송신자 매핑 정보 조회
- `GET /api/mediasoup/status`
  - mediasoup Worker/Router/Transport/Producer 상태 정보
- `GET /api/rtp/status`
  - RTP 송신자 매핑 및 녹화 파일 경로
- `GET /healthz`
  - 헬스 체크

WebSocket 시그널링(`ws://<SERVER>/ws`)

| action | 설명 |
| --- | --- |
| `getRouterRtpCapabilities` | mediasoup Router RTP Capabilities 요청 |
| `createWebRtcTransport` | `direction: "recv"` 으로 WebRTC Transport 생성 |
| `connectTransport` | DTLS 연결 완료 통보 |
| `consume` | Producer 를 소비할 Consumer 생성 |
| `resumeConsumer` | Consumer 송출 재개 |

### 내부 동작

1. 세션 생성 시 고정 SSRC 를 부여하고, `PlainTransport` 로 RTP 를 수신합니다.
2. 수신한 스트림은 mediasoup Producer 로 등록되며 WebRTC/녹화 파이프라인에 연결됩니다.
3. 별도의 `PlainTransport` 를 통해 FFmpeg(녹화)에 RTP 를 전달합니다.
4. FFmpeg 는 `{VIDEO_ROOT}/{trainingId}/{sessionId}/{studentId}/{streamKey}.(sdp|mp4)` 파일을 생성합니다.

## 2. 학생 클라이언트 (FFmpeg 송출)

### 실행 방법

```bash
cd clients/student
node index.js \
  --server http://<SFU_HOST>:8080 \
  --training T001 \
  --session S001 \
  --student ST001 \
  --source /path/to/video.mp4
```

- 서버에 세션을 생성하고 응답으로 받은 RTP 주소로 FFmpeg 를 실행합니다.
- 기본 인코딩은 `libx264` + `ultrafast/zerolatency`이며, 스트림은 무한 반복됩니다.
- 종료 시 `Ctrl+C` 로 FFmpeg 를 중단하면 세션 종료 API 가 자동 호출됩니다.

## 3. 강사 클라이언트 (React)

### 설치 및 실행

```bash
cd clients/instructor
npm install
npm run dev -- --host
```

브라우저에서 `http://<HOST>:5173` 에 접속한 뒤 다음 값을 입력합니다.

1. **Server URL** – 예: `http://<SFU_HOST>:8080`
2. **Stream Key** – `/api/session/start` 응답의 `streamKey`

`Connect` 버튼을 누르면 mediasoup-client Device 가 초기화되고, WebRTC Transport 생성 → DTLS 연결 → Consumer 생성 → 비디오 재생 순으로 진행됩니다. `Disconnect` 버튼은 현재 연결을 정리합니다.

## 4. 포트 진단 도구

```bash
node server/check-ports.js <host>
```

TCP 8080, UDP 5000, UDP 10000 포트에 대해 간단한 접근성 테스트를 수행합니다.

## 5. 개발 시 유의 사항

- 서버 로그는 최소한으로 유지하며 주요 흐름만 출력합니다.
- mediasoup 관련 로직은 `server/src/mediasoup-handler.js` 에 모듈화되어 있습니다.
- 세션당 RTP/녹화 포트는 자동 할당되며 세션 종료 시 해제됩니다.
- FFmpeg 가 설치되어 있어야 RTP 수신/녹화가 정상 동작합니다.

## 6. 참고 자료

- [사용 가이드](./USAGE_GUIDE.md) – 서버/클라이언트 실행 절차
- [미디어 파이프라인 문서](./SFU_MEDIA_PIPELINE.md) – RTP → WebRTC → MP4 흐름
- [네트워크 설정 가이드](./NETWORK_SETUP.md) – 방화벽 및 포트 구성
- [mediasoup 공식 문서](https://mediasoup.org/documentation/)
- 프로젝트에 포함된 `server/check-ports.js` 와 API 를 활용하여 상태를 확인할 수 있습니다.
