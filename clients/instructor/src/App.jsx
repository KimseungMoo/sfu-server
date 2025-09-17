import { Device } from 'mediasoup-client';
import { useEffect, useRef, useState } from 'react';

const DEFAULT_SERVER = 'http://localhost:8080';

// 개별 스트림 컴포넌트
const StreamPanel = ({ streamId, serverUrl }) => {
  const [streamKey, setStreamKey] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState({
    consumerPaused: null,
    trackMuted: null,
    trackReadyState: null,
    videoSrcObject: null,
    transportIceState: null,
    transportDtlsState: null,
    dataReceiving: null,
    bytesReceived: 0,
    packetsReceived: 0,
  });

  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const transportRef = useRef(null);
  const consumerRef = useRef(null);
  const requestSeq = useRef(0);
  const pendingRequests = useRef(new Map());
  const streamKeyRef = useRef('');
  const statsIntervalRef = useRef(null);
  const trackStatusIntervalRef = useRef(null);

  const cleanupConnection = (nextStatus = 'idle') => {
    const ws = socketRef.current;
    if (ws) {
      ws.close();
      socketRef.current = null;
    }

    const consumer = consumerRef.current;
    if (consumer) {
      try {
        consumer.close();
      } catch (err) {
        console.warn('failed to close consumer', err);
      }
      consumerRef.current = null;
    }

    const transport = transportRef.current;
    if (transport) {
      try {
        transport.close();
      } catch (err) {
        console.warn('failed to close transport', err);
      }
      transportRef.current = null;
    }

    const device = deviceRef.current;
    if (device) {
      deviceRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    for (const [, pending] of pendingRequests.current.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('connection closed'));
    }
    pendingRequests.current.clear();

    // 통계 interval 정리
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

    // Track status interval 정리
    if (trackStatusIntervalRef.current) {
      clearInterval(trackStatusIntervalRef.current);
      trackStatusIntervalRef.current = null;
    }

    setStatus(nextStatus);
  };

  useEffect(() => {
    streamKeyRef.current = streamKey;
  }, [streamKey]);

  useEffect(() => () => {
    cleanupConnection();
  }, []);

  const handleMessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.requestId) {
        const pending = pendingRequests.current.get(message.requestId);
        if (pending) {
          pendingRequests.current.delete(message.requestId);
          clearTimeout(pending.timeout);
          if (message.type === 'error') {
            pending.reject(new Error(message.message));
          } else {
            pending.resolve(message.data);
          }
        }
      }
    } catch (err) {
      console.error('failed to parse message', err);
    }
  };

  const sendRequest = (action, data = {}) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }
    const requestId = `req-${requestSeq.current += 1}`;
    const payload = {
      action,
      requestId,
      streamKey: streamKeyRef.current,
      ...data,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(requestId);
        reject(new Error('request timeout'));
      }, 30000); // 30초로 증가
      pendingRequests.current.set(requestId, { resolve, reject, timeout });
      ws.send(JSON.stringify(payload));
    });
  };

  const connect = () => {
    if (!streamKey) {
      setError('Stream key is required');
      return;
    }

    if (socketRef.current) {
      cleanupConnection('idle');
    }

    setError('');
    setStatus('connecting');

    const wsUrl = serverUrl.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl.replace(/\/$/, '')}/ws`);
    socketRef.current = ws;

    ws.onopen = async () => {
      console.log(`WebSocket connected for stream ${streamId}`);
      try {
        await mediasoupWorkflow();
      } catch (err) {
        console.error('Mediasoup workflow failed:', err);
        setError(err.message);
        cleanupConnection('error');
      }
    };

    ws.onmessage = handleMessage;
    ws.onerror = () => {
      setError('WebSocket error');
      cleanupConnection('error');
    };

    ws.onclose = () => {
      cleanupConnection('closed');
    };
  };

  const mediasoupWorkflow = async () => {
    console.log(`Starting mediasoup workflow for stream ${streamId}...`);
    
    const device = new Device();
    deviceRef.current = device;
    console.log('Device created');
    
    const routerCapabilities = await sendRequest('getRouterRtpCapabilities');
    console.log('Router capabilities received:', routerCapabilities);
    
    await device.load({ routerRtpCapabilities: routerCapabilities });
    console.log('Device loaded with router capabilities');

    const transportInfo = await sendRequest('createWebRtcTransport', { direction: 'recv' });
    console.log('Transport info received:', transportInfo);
    
    const transport = device.createRecvTransport(transportInfo);
    transportRef.current = transport;
    console.log('Recv transport created:', transport.id);

    // Transport 연결 상태 모니터링
    transport.on('connectionstatechange', (connectionState) => {
      console.log(`Transport connectionState changed for stream ${streamId}:`, connectionState);
      setDebugInfo(prev => ({ ...prev, transportConnectionState: connectionState }));
      if (connectionState === 'connected') {
        setStatus('connected');
      } else if (connectionState === 'disconnected' || connectionState === 'failed') {
        setStatus('error');
        setError('WebRTC transport connection failed');
      }
    });

    transport.on('icestatechange', (iceState) => {
      console.log(`Transport ICE state changed for stream ${streamId}:`, iceState);
      setDebugInfo(prev => ({ ...prev, transportIceState: iceState }));
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      console.log(`Transport DTLS state changed for stream ${streamId}:`, dtlsState);
      setDebugInfo(prev => ({ ...prev, transportDtlsState: dtlsState }));
    });

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      console.log(`Transport connect event for stream ${streamId} - DTLS handshake starting`);
      setStatus('connecting');
      try {
        await sendRequest('connectTransport', { transportId: transport.id, dtlsParameters });
        console.log(`Transport connected for stream ${streamId} - DTLS handshake completed`);
        callback();
      } catch (err) {
        console.error(`Transport connect failed for stream ${streamId}:`, err);
        setError('Transport connection failed: ' + err.message);
        errback(err);
      }
    });

    const consumeInfo = await sendRequest('consume', {
      transportId: transport.id,
      rtpCapabilities: device.rtpCapabilities,
    });
    console.log('Consume info received:', consumeInfo);

    const consumer = await transport.consume({
      id: consumeInfo.id,
      producerId: consumeInfo.producerId,
      kind: consumeInfo.kind,
      rtpParameters: consumeInfo.rtpParameters,
    });
    consumerRef.current = consumer;

    console.log(`Consumer created for stream ${streamId}:`, {
      id: consumer.id,
      kind: consumer.kind,
      track: consumer.track,
      trackEnabled: consumer.track.enabled,
      trackReadyState: consumer.track.readyState,
    });

    // Consumer 이벤트 모니터링 추가
    consumer.on('transportclose', () => {
      console.log(`Consumer transport closed for stream ${streamId}`);
    });

    consumer.on('producerclose', () => {
      console.log(`Consumer producer closed for stream ${streamId}`);
      setError('Producer connection lost');
    });

    consumer.on('producerpause', () => {
      console.log(`Consumer producer paused for stream ${streamId}`);
    });

    consumer.on('producerresume', () => {
      console.log(`Consumer producer resumed for stream ${streamId}`);
    });

    // Track 이벤트 모니터링
    consumer.track.addEventListener('ended', () => {
      console.log(`Consumer track ended for stream ${streamId}`);
      setError('Video track ended unexpectedly');
    });

    consumer.track.addEventListener('mute', () => {
      console.log(`Consumer track muted for stream ${streamId}`);
      setDebugInfo(prev => ({ ...prev, trackMuted: true }));
    });

    consumer.track.addEventListener('unmute', () => {
      console.log(`Consumer track unmuted for stream ${streamId}`);
      setDebugInfo(prev => ({ ...prev, trackMuted: false }));
    });

    // Track 상태 정기적으로 확인
    if (trackStatusIntervalRef.current) {
      clearInterval(trackStatusIntervalRef.current);
    }
    trackStatusIntervalRef.current = setInterval(() => {
      if (consumer.track) {
        // Track이 ended 상태인 경우 재연결 시도
        if (consumer.track.readyState === 'ended') {
          console.warn(`Track is in ended state for stream ${streamId} - connection may be lost`);
          setError('Video connection lost - track ended');
          clearInterval(trackStatusIntervalRef.current);
          trackStatusIntervalRef.current = null;
        }
      }
    }, 10000); // 10초마다 확인

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    console.log(`MediaStream created for stream ${streamId}:`, {
      id: stream.id,
      active: stream.active,
      tracks: stream.getTracks().map(track => ({
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
      })),
    });

    // MediaStream 이벤트 모니터링
    stream.addEventListener('addtrack', (event) => {
      console.log(`MediaStream track added for stream ${streamId}:`, event.track);
    });

    stream.addEventListener('removetrack', (event) => {
      console.log(`MediaStream track removed for stream ${streamId}:`, event.track);
    });

    if (videoRef.current) {
      // 기존 srcObject 정리
      if (videoRef.current.srcObject) {
        const oldStream = videoRef.current.srcObject;
        oldStream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }

      videoRef.current.srcObject = stream;
      console.log(`Video element srcObject set for stream ${streamId}`);
      setDebugInfo(prev => ({ 
        ...prev, 
        videoSrcObject: !!stream,
        trackReadyState: consumer.track.readyState,
        trackMuted: consumer.track.muted,
      }));
      
      // 비디오 엘리먼트 이벤트 리스너 추가
      const handleLoadedMetadata = () => {
        console.log(`Video metadata loaded for stream ${streamId}:`, {
          videoWidth: videoRef.current?.videoWidth,
          videoHeight: videoRef.current?.videoHeight,
          duration: videoRef.current?.duration,
        });
      };
      
      const handleCanPlay = () => {
        console.log(`Video can play for stream ${streamId}`);
        setStatus('ready');
      };
      
      const handlePlaying = () => {
        console.log(`Video is playing for stream ${streamId}`);
        setStatus('playing');
      };
      
      const handleVideoError = (e) => {
        console.error(`Video error for stream ${streamId}:`, e, videoRef.current?.error);
        setError('Video playback error: ' + (videoRef.current?.error?.message || 'Unknown error'));
      };

      // 이벤트 리스너 추가
      videoRef.current.addEventListener('loadedmetadata', handleLoadedMetadata);
      videoRef.current.addEventListener('canplay', handleCanPlay);
      videoRef.current.addEventListener('playing', handlePlaying);
      videoRef.current.addEventListener('error', handleVideoError);
      
      // 비디오 재생 시도
      try {
        await videoRef.current.play();
        console.log(`Video play() succeeded for stream ${streamId}`);
      } catch (err) {
        console.error(`Video play() failed for stream ${streamId}:`, err);
        // 자동 재생이 실패해도 에러로 처리하지 않음
      }
    }

    // Consumer resume을 별도 함수로 분리하여 재시도 가능하게 함
    const resumeConsumerWithRetry = async (retryCount = 0) => {
      try {
        console.log(`Attempting to resume consumer for stream ${streamId} (attempt ${retryCount + 1})`);
        await sendRequest('resumeConsumer', { consumerId: consumer.id });
        console.log(`Consumer resumed successfully for stream ${streamId}`);
        setDebugInfo(prev => ({ ...prev, consumerPaused: false }));
        return true;
      } catch (err) {
        console.error(`Failed to resume consumer for stream ${streamId} (attempt ${retryCount + 1}):`, err);
        
        if (retryCount < 3) { // 최대 3번 재시도
          console.log(`Retrying consumer resume for stream ${streamId} in 2 seconds...`);
          setTimeout(() => resumeConsumerWithRetry(retryCount + 1), 2000);
          return false;
        } else {
          setError('Failed to resume consumer after 3 attempts: ' + err.message);
          throw err;
        }
      }
    };

    // Consumer resume 시도
    try {
      await resumeConsumerWithRetry();
    } catch (err) {
      // 최종 실패 시에도 계속 진행 (수동으로 resume할 수 있도록)
      console.error(`All consumer resume attempts failed for stream ${streamId}:`, err);
    }
    
    // Consumer 통계 정보 주기적으로 확인
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    statsIntervalRef.current = setInterval(async () => {
      try {
        if (consumer && !consumer.closed) {
          const stats = await consumer.getStats();
          
          // 통계에서 실제 데이터 수신 여부 확인
          let receiving = false;
          let bytesReceived = 0;
          let packetsReceived = 0;
          
          stats.forEach(stat => {
            if (stat.type === 'inbound-rtp') {
              bytesReceived = stat.bytesReceived || 0;
              packetsReceived = stat.packetsReceived || 0;
              if (bytesReceived > 0 && packetsReceived > 0) {
                receiving = true;
              }
            }
          });
          
          setDebugInfo(prev => ({ 
            ...prev, 
            dataReceiving: receiving,
            bytesReceived,
            packetsReceived
          }));
        } else {
          clearInterval(statsIntervalRef.current);
          statsIntervalRef.current = null;
        }
      } catch (err) {
        console.log(`Failed to get consumer stats for stream ${streamId}:`, err);
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
    }, 5000); // 5초마다 확인
    
    // Status가 설정되지 않은 경우 기본값 설정
    setTimeout(() => {
      if (status === 'connecting') {
        setStatus('ready');
      }
    }, 3000);
  };

  const disconnect = () => {
    cleanupConnection('idle');
  };

  const handleManualResumeConsumer = async () => {
    if (!consumerRef.current) {
      setError('No consumer available');
      return;
    }
    
    try {
      await sendRequest('resumeConsumer', { consumerId: consumerRef.current.id });
      console.log(`Manual consumer resume successful for stream ${streamId}`);
      setDebugInfo(prev => ({ ...prev, consumerPaused: false }));
    } catch (err) {
      console.error(`Manual resume failed for stream ${streamId}:`, err);
      setError('Manual resume failed: ' + err.message);
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'connecting': return 'text-yellow-600';
      case 'connected':
      case 'ready':
      case 'playing': return 'text-green-600';
      case 'error': return 'text-red-600';
      case 'closed': return 'text-gray-600';
      default: return 'text-gray-400';
    }
  };

  return (
    <div className="relative w-full h-full bg-black border border-gray-500" style={{ minHeight: '100%' }}>
      {/* 상단 헤더 - 축소된 컨트롤 */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-black bg-opacity-90 p-2">
        <div className="flex items-center justify-between text-white text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">스트림 {streamId}</span>
            <div className={`text-xs ${getStatusColor()}`}>
              {status}
            </div>
          </div>
          
          {/* 축소된 컨트롤 버튼들 */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={connect}
              disabled={!streamKey || ['connecting', 'connected', 'ready', 'playing'].includes(status)}
              className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              title="Connect"
            >
              연결
            </button>
            <button 
              type="button" 
              onClick={disconnect} 
              disabled={status === 'idle' || status === 'error'}
              className="px-2 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              title="Disconnect"
            >
              해제
            </button>
            <button 
              type="button" 
              onClick={handleManualResumeConsumer} 
              disabled={!consumerRef.current}
              className="px-2 py-1 bg-orange-600 text-white rounded text-xs hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              title="Manual Resume Consumer"
            >
              스트림 시작
            </button>
          </div>
        </div>
        
        {/* Stream Key 입력 - 항상 표시 */}
        <div className="mt-2">
          <input 
            type="text"
            value={streamKey} 
            onChange={(e) => setStreamKey(e.target.value)}
            className="w-full px-2 py-1 bg-gray-800 text-white text-xs border border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent"
            placeholder="스트림 키를 입력하세요"
          />
        </div>
        
        {/* 에러 메시지 */}
        {error && (
          <div className="mt-1 text-xs text-red-400 truncate" title={error}>
            오류: {error}
          </div>
        )}
      </div>
      
      {/* 비디오 영역 - 전체 화면 */}
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted 
        className="absolute inset-0 w-full h-full object-cover"
        preload="auto"
        crossOrigin="anonymous"
      />
      
      {/* 하단 디버그 정보 */}
      {debugInfo.dataReceiving !== null && (
        <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs p-1">
          수신: {debugInfo.dataReceiving ? '✓' : '✗'} | 
          Bytes: {debugInfo.bytesReceived} | 
          Packets: {debugInfo.packetsReceived}
        </div>
      )}
    </div>
  );
};

// 메인 App 컴포넌트
export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* 상단 고정 헤더 */}
      <div className="absolute top-0 left-0 right-0 z-20 bg-black bg-opacity-90 p-2 border-b border-gray-600">
        <div className="flex items-center justify-between text-white">
          {/* <h1 className="text-lg font-bold">Instructor Client - 4분할 스트림</h1> */}
          
          <div className="flex items-center gap-2">
            <button 
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-1 bg-gray-700 text-white rounded text-sm hover:bg-gray-600"
            >
              설정 {showSettings ? '▲' : '▼'}
            </button>
          </div>
        </div>
        
        {/* 접을 수 있는 설정 패널 */}
        {showSettings && (
          <div className="mt-2 p-3 bg-gray-800 rounded">
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Server URL (전체 적용)
            </label>
            <input 
              type="text"
              value={serverUrl} 
              onChange={(e) => setServerUrl(e.target.value)} 
              className="w-full max-w-md px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              placeholder="서버 URL을 입력하세요"
            />
          </div>
        )}
      </div>
      
      {/* 4분할 스트림 그리드 - 전체 화면 */}
      <div className="absolute inset-0 pt-16">
        <div className="w-full h-full flex flex-col">
          {/* 상단 행 */}
          <div className="flex-1 flex">
            <div className="flex-1">
              <StreamPanel streamId={1} serverUrl={serverUrl} />
            </div>
            <div className="flex-1">
              <StreamPanel streamId={2} serverUrl={serverUrl} />
            </div>
          </div>
          {/* 하단 행 */}
          <div className="flex-1 flex">
            <div className="flex-1">
              <StreamPanel streamId={3} serverUrl={serverUrl} />
            </div>
            <div className="flex-1">
              <StreamPanel streamId={4} serverUrl={serverUrl} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}