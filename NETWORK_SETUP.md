# 🌐 네트워크 및 포트 설정 가이드

mediasoup 기반 SFU 서버를 운영하기 위한 필수 포트와 방화벽 설정 가이드입니다. 서버와 클라이언트가 서로 미디어를 교환하려면 아래 항목을 반드시 확인하세요.

## 📋 필요한 포트

| 구분 | 포트 | 프로토콜 | 용도 |
| --- | --- | --- | --- |
| HTTP/WebSocket | `8080` (`PORT`) | TCP | REST API 및 WebSocket 시그널링 |
| RTP 수신 | `5000` (`SFU_PORT`) | UDP | 학생 클라이언트 RTP 스트림 수신 |
| WebRTC 미디어 | `10000-20000` | UDP/TCP | mediasoup WebRTC 전송 (강사 클라이언트) |

> 기본 포트 값은 환경 변수로 조정할 수 있습니다. 방화벽, 라우터, 클라우드 보안 그룹 등에서 동일한 포트 범위를 모두 개방해야 합니다.

## 🔧 환경 변수

```bash
# 서버 설정
export PORT=8080                    # HTTP/WebSocket 포트
export SFU_IP=192.168.0.49         # 서버 공인 IP (클라이언트와 공유)
export SFU_PORT=5000               # RTP 수신 시작 포트

# 비디오 저장 경로
export VIDEO_ROOT=/path/to/videos  # 녹화 파일 저장 위치
```

## 🔥 방화벽 설정 예시

### macOS (pfctl)

```bash
# 방화벽 상태 확인
sudo pfctl -s info

# 임시 규칙 추가
sudo pfctl -f /dev/stdin <<'RULES'
pass in proto tcp from any to any port 8080
pass in proto udp from any to any port 5000
pass in proto { tcp udp } from any to any port 10000:20000
RULES
```

### Linux (ufw)

```bash
sudo ufw allow 8080/tcp
sudo ufw allow 5000/udp
sudo ufw allow 10000:20000/udp
sudo ufw allow 10000:20000/tcp
sudo ufw enable
```

### Linux (iptables)

```bash
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 5000 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 10000:20000 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 10000:20000 -j ACCEPT
sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

### Windows (PowerShell)

```powershell
New-NetFirewallRule -DisplayName "SFU HTTP" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
New-NetFirewallRule -DisplayName "SFU RTP" -Direction Inbound -Protocol UDP -LocalPort 5000 -Action Allow
New-NetFirewallRule -DisplayName "SFU WebRTC UDP" -Direction Inbound -Protocol UDP -LocalPort 10000-20000 -Action Allow
New-NetFirewallRule -DisplayName "SFU WebRTC TCP" -Direction Inbound -Protocol TCP -LocalPort 10000-20000 -Action Allow
```

## 🌍 라우터 / NAT 구성

외부 네트워크에서 서버에 접근해야 한다면 라우터 또는 클라우드 보안 그룹에 포트 포워딩 규칙을 추가하세요.

```
TCP 8080           → 서버 IP:8080        (HTTP/WebSocket)
UDP 5000           → 서버 IP:5000        (학생 RTP 입력)
UDP 10000-20000    → 서버 IP             (WebRTC 미디어)
TCP 10000-20000    → 서버 IP             (WebRTC 대체 전송)
```

가능하다면 UPnP를 통해 자동으로 포트 매핑을 처리하거나, 테스트 목적으로 DMZ 설정을 고려할 수 있습니다.

## 🐳 Docker 환경에서의 포트 매핑

```bash
docker run -d \
  --name sfu-server \
  -p 8080:8080 \
  -p 5000:5000/udp \
  -p 10000-20000:10000-20000/udp \
  -p 10000-20000:10000-20000/tcp \
  -e SFU_IP=<호스트_IP> \
  -e PORT=8080 \
  -e SFU_PORT=5000 \
  -v $(pwd)/videos:/app/videos \
  node:18
```

Docker Compose 예시:

```yaml
version: '3.8'
services:
  sfu-server:
    build: .
    ports:
      - "8080:8080"
      - "5000:5000/udp"
      - "10000-20000:10000-20000/udp"
      - "10000-20000:10000-20000/tcp"
    environment:
      - SFU_IP=192.168.0.49
      - PORT=8080
      - SFU_PORT=5000
      - VIDEO_ROOT=/app/videos
    volumes:
      - ./videos:/app/videos
```

## 🔍 연결 테스트

### 포트 열림 확인

```bash
# 서버에서 수신 포트 확인
sudo ss -tulpn | grep -E ":(8080|5000|1[0-9]{4})"

# 외부 머신에서 확인
nmap -p 8080,5000,10000-10010 <서버_IP>
```

### WebSocket 연결 테스트

```bash
npm install -g wscat
wscat -c ws://<서버_IP>:8080/ws
```

### API 상태 확인

```bash
curl http://<서버_IP>:8080/healthz
curl http://<서버_IP>:8080/api/mediasoup/status | jq
```

### 포트 진단 스크립트

프로젝트 루트에서 다음 명령으로 필수 포트를 동시에 점검할 수 있습니다.

```bash
node server/check-ports.js <서버_IP>
```

## 🚨 트러블슈팅 체크리스트

1. **포트 충돌 여부 확인** – `sudo ss -tulpn | grep 8080`
2. **방화벽 규칙 점검** – `sudo ufw status`, `sudo pfctl -s rules`, `sudo firewall-cmd --list-all`
3. **NAT/라우터 포워딩 확인** – 수동 규칙 또는 UPnP 설정 점검
4. **브라우저 지원 확인** – 최신 Chrome/Firefox, `chrome://webrtc-internals/` 활용
5. **UDP 우선 사용** – 가능하다면 UDP 우선, TCP는 보조로 활용

## 📊 모니터링 팁

```bash
# 실시간 포트 사용 현황
watch -n 2 'ss -tuln | grep -E ":(8080|5000|1[0-9]{4})"'

# mediasoup 워커 프로세스 확인
ps aux | grep mediasoup

# 네트워크 트래픽 모니터링
sudo iftop
sudo nethogs
```

위 항목을 충족하면 학생/강사 클라이언트가 mediasoup SFU 서버와 안정적으로 통신할 수 있습니다.
