import { Device } from 'mediasoup-client';
import { useEffect, useRef, useState } from 'react';

const DEFAULT_SERVER = 'http://localhost:8080';

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
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
      console.log('WebSocket connected');
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
    console.log('Starting mediasoup workflow...');
    
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
      console.log('Transport connectionState changed:', connectionState);
      setDebugInfo(prev => ({ ...prev, transportConnectionState: connectionState }));
      if (connectionState === 'connected') {
        setStatus('connected');
      } else if (connectionState === 'disconnected' || connectionState === 'failed') {
        setStatus('error');
        setError('WebRTC transport connection failed');
      }
    });

    transport.on('icestatechange', (iceState) => {
      console.log('Transport ICE state changed:', iceState);
      setDebugInfo(prev => ({ ...prev, transportIceState: iceState }));
    });

    transport.on('dtlsstatechange', (dtlsState) => {
      console.log('Transport DTLS state changed:', dtlsState);
      setDebugInfo(prev => ({ ...prev, transportDtlsState: dtlsState }));
    });

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      console.log('Transport connect event - DTLS handshake starting');
      setStatus('connecting');
      try {
        await sendRequest('connectTransport', { transportId: transport.id, dtlsParameters });
        console.log('Transport connected - DTLS handshake completed');
        callback();
      } catch (err) {
        console.error('Transport connect failed:', err);
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

    console.log('Consumer created:', {
      id: consumer.id,
      kind: consumer.kind,
      track: consumer.track,
      trackEnabled: consumer.track.enabled,
      trackReadyState: consumer.track.readyState,
    });

    // Consumer 이벤트 모니터링 추가
    consumer.on('transportclose', () => {
      console.log('Consumer transport closed');
    });

    consumer.on('producerclose', () => {
      console.log('Consumer producer closed');
      setError('Producer connection lost');
    });

    consumer.on('producerpause', () => {
      console.log('Consumer producer paused');
    });

    consumer.on('producerresume', () => {
      console.log('Consumer producer resumed');
    });

    // Track 이벤트 모니터링
    consumer.track.addEventListener('ended', () => {
      console.log('Consumer track ended');
      setError('Video track ended unexpectedly');
    });

    consumer.track.addEventListener('mute', () => {
      console.log('Consumer track muted');
      setDebugInfo(prev => ({ ...prev, trackMuted: true }));
    });

    consumer.track.addEventListener('unmute', () => {
      console.log('Consumer track unmuted');
      setDebugInfo(prev => ({ ...prev, trackMuted: false }));
    });

    // Track 상태 정기적으로 확인
    if (trackStatusIntervalRef.current) {
      clearInterval(trackStatusIntervalRef.current);
    }
    trackStatusIntervalRef.current = setInterval(() => {
      if (consumer.track) {
        // console.log('Track status check:', {
        //   id: consumer.track.id,
        //   kind: consumer.track.kind,
        //   enabled: consumer.track.enabled,
        //   readyState: consumer.track.readyState,
        //   muted: consumer.track.muted,
        // });
        
        // Track이 ended 상태인 경우 재연결 시도
        if (consumer.track.readyState === 'ended') {
          console.warn('Track is in ended state - connection may be lost');
          setError('Video connection lost - track ended');
          clearInterval(trackStatusIntervalRef.current);
          trackStatusIntervalRef.current = null;
        }
      }
    }, 10000); // 10초마다 확인 (성능 향상)

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    console.log('MediaStream created:', {
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
      console.log('MediaStream track added:', event.track);
    });

    stream.addEventListener('removetrack', (event) => {
      console.log('MediaStream track removed:', event.track);
    });

    if (videoRef.current) {
      // 기존 srcObject 정리
      if (videoRef.current.srcObject) {
        const oldStream = videoRef.current.srcObject;
        oldStream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }

      videoRef.current.srcObject = stream;
      console.log('Video element srcObject set');
      setDebugInfo(prev => ({ 
        ...prev, 
        videoSrcObject: !!stream,
        trackReadyState: consumer.track.readyState,
        trackMuted: consumer.track.muted,
      }));
      
      // 비디오 엘리먼트 이벤트 리스너 추가 (기존 리스너 제거 후)
      const removeExistingListeners = () => {
        videoRef.current.removeEventListener('loadedmetadata', handleLoadedMetadata);
        videoRef.current.removeEventListener('canplay', handleCanPlay);
        videoRef.current.removeEventListener('playing', handlePlaying);
        videoRef.current.removeEventListener('timeupdate', handleTimeUpdate);
        videoRef.current.removeEventListener('error', handleVideoError);
        videoRef.current.removeEventListener('loadstart', handleLoadStart);
        videoRef.current.removeEventListener('loadeddata', handleLoadedData);
      };

      const handleLoadedMetadata = () => {
        console.log('Video metadata loaded:', {
          videoWidth: videoRef.current?.videoWidth,
          videoHeight: videoRef.current?.videoHeight,
          duration: videoRef.current?.duration,
        });
      };
      
      const handleCanPlay = () => {
        console.log('Video can play');
        setStatus('ready');
      };
      
      const handlePlaying = () => {
        console.log('Video is playing');
        setStatus('playing');
      };
      
      const handleTimeUpdate = () => {
        console.log('Video time update:', videoRef.current?.currentTime);
      };
      
      const handleVideoError = (e) => {
        console.error('Video error:', e, videoRef.current?.error);
        setError('Video playback error: ' + (videoRef.current?.error?.message || 'Unknown error'));
      };

      const handleLoadStart = () => {
        console.log('Video load start');
      };

      const handleLoadedData = () => {
        console.log('Video data loaded');
      };

      // 기존 리스너 제거
      removeExistingListeners();
      
      // 새 리스너 추가
      videoRef.current.addEventListener('loadedmetadata', handleLoadedMetadata);
      videoRef.current.addEventListener('canplay', handleCanPlay);
      videoRef.current.addEventListener('playing', handlePlaying);
      // videoRef.current.addEventListener('timeupdate', handleTimeUpdate);
      videoRef.current.addEventListener('error', handleVideoError);
      videoRef.current.addEventListener('loadstart', handleLoadStart);
      videoRef.current.addEventListener('loadeddata', handleLoadedData);
      
      // 비디오 재생 시도
      try {
        await videoRef.current.play();
        console.log('Video play() succeeded');
      } catch (err) {
        console.error('Video play() failed:', err);
        // 자동 재생이 실패해도 에러로 처리하지 않음 (사용자 상호작용 필요할 수 있음)
      }
    }

    // Consumer resume을 별도 함수로 분리하여 재시도 가능하게 함
    const resumeConsumerWithRetry = async (retryCount = 0) => {
      try {
        console.log(`Attempting to resume consumer (attempt ${retryCount + 1})`);
        await sendRequest('resumeConsumer', { consumerId: consumer.id });
        console.log('Consumer resumed successfully');
        setDebugInfo(prev => ({ ...prev, consumerPaused: false }));
        return true;
      } catch (err) {
        console.error(`Failed to resume consumer (attempt ${retryCount + 1}):`, err);
        
        if (retryCount < 3) { // 최대 3번 재시도
          console.log(`Retrying consumer resume in 2 seconds...`);
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
      console.error('All consumer resume attempts failed:', err);
    }
    
    // Consumer 트랙 상태 확인
    console.log('Consumer track after resume:', {
      enabled: consumer.track.enabled,
      readyState: consumer.track.readyState,
      muted: consumer.track.muted,
      id: consumer.track.id,
      kind: consumer.track.kind,
    });
    
    // MediaStream 상태 재확인
    console.log('MediaStream after resume:', {
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
    
    // Consumer 통계 정보 주기적으로 확인
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }
    statsIntervalRef.current = setInterval(async () => {
      try {
        if (consumer && !consumer.closed) {
          const stats = await consumer.getStats();
          // console.log('Consumer stats:', stats);
          
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
          
          // console.log(`Data receiving status: ${receiving}, bytes: ${bytesReceived}, packets: ${packetsReceived}`);
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
        console.log('Failed to get consumer stats:', err);
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
    }, 5000); // 5초마다 확인 (성능 향상)
    
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

  const manualResumeConsumer = async () => {
    if (!consumerRef.current) {
      setError('No consumer available');
      return;
    }
    
    try {
      await sendRequest('resumeConsumer', { consumerId: consumerRef.current.id });
      console.log('Manual consumer resume successful');
      setDebugInfo(prev => ({ ...prev, consumerPaused: false }));
    } catch (err) {
      console.error('Manual resume failed:', err);
      setError('Manual resume failed: ' + err.message);
    }
  };

  const refreshVideoElement = () => {
    if (!consumerRef.current || !videoRef.current) {
      setError('No consumer or video element available');
      return;
    }

    try {
      const stream = new MediaStream();
      stream.addTrack(consumerRef.current.track);
      videoRef.current.srcObject = stream;
      console.log('Video element refreshed');
      
      setDebugInfo(prev => ({ 
        ...prev, 
        videoSrcObject: !!stream,
        trackReadyState: consumerRef.current.track.readyState,
        trackMuted: consumerRef.current.track.muted,
      }));
    } catch (err) {
      console.error('Failed to refresh video element:', err);
      setError('Failed to refresh video: ' + err.message);
    }
  };

  return (
    <div className="app">
      <h1>Instructor Client</h1>
      <div className="controls">
        <label>
          Server URL
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </label>
        <label>
          Stream Key
          <input value={streamKey} onChange={(e) => setStreamKey(e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={connect}
            disabled={!streamKey || ['connecting', 'connected', 'ready', 'playing'].includes(status)}
          >
            Connect
          </button>
          <button type="button" onClick={disconnect} disabled={status === 'idle' || status === 'error'}>
            Disconnect
          </button>
          <button 
            type="button" 
            onClick={manualResumeConsumer} 
            disabled={!consumerRef.current}
            style={{ backgroundColor: '#ff9800', color: 'white' }}
          >
            Manual Resume Consumer
          </button>
          <button 
            type="button" 
            onClick={refreshVideoElement} 
            disabled={!consumerRef.current}
            style={{ backgroundColor: '#2196f3', color: 'white' }}
          >
            Refresh Video
          </button>
        </div>
      </div>
      <div className="status">Status: {status}</div>
      {error && <div className="error" style={{ color: 'red', margin: '10px 0' }}>{error}</div>}
      
      <div className="debug-info" style={{ margin: '20px 0', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '5px' }}>
        <h3>Debug Information</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          <div>Transport ICE: {debugInfo.transportIceState || 'N/A'}</div>
          <div>Transport DTLS: {debugInfo.transportDtlsState || 'N/A'}</div>
          <div>Consumer Paused: {debugInfo.consumerPaused === null ? 'N/A' : debugInfo.consumerPaused ? 'YES' : 'NO'}</div>
          <div>Track Muted: {debugInfo.trackMuted === null ? 'N/A' : debugInfo.trackMuted ? 'YES' : 'NO'}</div>
          <div>Track State: {debugInfo.trackReadyState || 'N/A'}</div>
          <div>Video SrcObject: {debugInfo.videoSrcObject === null ? 'N/A' : debugInfo.videoSrcObject ? 'SET' : 'NOT SET'}</div>
          <div style={{ color: debugInfo.dataReceiving ? 'green' : 'red' }}>
            Data Receiving: {debugInfo.dataReceiving === null ? 'N/A' : debugInfo.dataReceiving ? 'YES' : 'NO'}
          </div>
          <div>Bytes Received: {debugInfo.bytesReceived}</div>
          <div>Packets Received: {debugInfo.packetsReceived}</div>
        </div>
      </div>
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted 
        controls 
        style={{ width: '100%', maxWidth: '800px', backgroundColor: '#000' }}
        preload="auto"
        crossOrigin="anonymous"
        onLoadStart={() => console.log('Video loadstart event')}
        onLoadedData={() => console.log('Video loadeddata event')}
        onLoadedMetadata={(e) => console.log('Video loadedmetadata event:', e.target.videoWidth, 'x', e.target.videoHeight)}
        onCanPlay={() => console.log('Video canplay event')}
        onCanPlayThrough={() => console.log('Video canplaythrough event')}
        onPlaying={() => console.log('Video playing event')}
        // onTimeUpdate={() => console.log('Video timeupdate event:', videoRef.current?.currentTime)}
        onError={(e) => console.error('Video error event:', e)}
        onStalled={() => console.log('Video stalled event')}
        onSuspend={() => console.log('Video suspend event')}
        onWaiting={() => console.log('Video waiting event')}
        onProgress={() => console.log('Video progress event')}
      />
    </div>
  );
}
