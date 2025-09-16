import { useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';

const DEFAULT_SERVER = 'http://localhost:8080';

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [streamKey, setStreamKey] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const transportRef = useRef(null);
  const consumerRef = useRef(null);
  const requestSeq = useRef(0);
  const pendingRequests = useRef(new Map());
  const streamKeyRef = useRef('');

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
      }, 8000);
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
      try {
        await mediasoupWorkflow();
      } catch (err) {
        console.error(err);
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
    const device = new Device();
    deviceRef.current = device;
    const routerCapabilities = await sendRequest('getRouterRtpCapabilities');
    await device.load({ routerRtpCapabilities: routerCapabilities });

    const transportInfo = await sendRequest('createWebRtcTransport', { direction: 'recv' });
    const transport = device.createRecvTransport(transportInfo);
    transportRef.current = transport;

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

    const consumer = await transport.consume({
      id: consumeInfo.id,
      producerId: consumeInfo.producerId,
      kind: consumeInfo.kind,
      rtpParameters: consumeInfo.rtpParameters,
    });
    consumerRef.current = consumer;

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }

    await sendRequest('resumeConsumer', { consumerId: consumer.id });
    setStatus('ready');
  };

  const disconnect = () => {
    cleanupConnection('idle');
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
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={connect}
            disabled={!streamKey || status === 'connecting' || status === 'ready'}
          >
            Connect
          </button>
          <button type="button" onClick={disconnect} disabled={status === 'idle'}>
            Disconnect
          </button>
        </div>
      </div>
      <div className="status">Status: {status}</div>
      {error && <div className="error">{error}</div>}
      <video ref={videoRef} autoPlay playsInline muted controls />
    </div>
  );
}
