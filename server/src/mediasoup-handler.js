const mediasoup = require('mediasoup');

const DEFAULT_RTC_MIN_PORT = 10000;
const DEFAULT_RTC_MAX_PORT = 20000;

class MediasoupHandler {
  constructor(config = {}) {
    this.config = {
      listenIp: config.listenIp || { ip: '0.0.0.0', announcedIp: config.announcedIp },
      recordListenIp: config.recordListenIp || { ip: '127.0.0.1', announcedIp: undefined },
      webRtcListenIps: config.webRtcListenIps || [
        { ip: '0.0.0.0', announcedIp: config.announcedIp },
      ],
      rtcMinPort: config.rtcMinPort || DEFAULT_RTC_MIN_PORT,
      rtcMaxPort: config.rtcMaxPort || DEFAULT_RTC_MAX_PORT,
    };
    this.worker = null;
    this.router = null;
    this.ingestTransports = new Map();
    this.recordTransports = new Map();
    this.webRtcTransports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.onTuple = null;
  }

  setTupleListener(listener) {
    this.onTuple = listener;
  }

  async init() {
    if (this.worker) {
      return;
    }

    this.worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: this.config.rtcMinPort,
      rtcMaxPort: this.config.rtcMaxPort,
    });

    this.worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    this.router = await this.worker.createRouter({
      mediaCodecs: [
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 96,
          rtcpFeedback: [
            { type: 'goog-remb' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
          ],
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
          },
        },
      ],
    });
  }

  async createIngest(streamKey, { port, rtcpPort, ssrc }) {
    await this.init();

    const transport = await this.router.createPlainTransport({
      listenIp: this.config.listenIp,
      rtcpMux: false,
      comedia: true,
      enableSctp: false,
      appData: { streamKey, role: 'ingest' },
      port,
      rtcpPort,
    });

    transport.on('tuple', (tuple) => {
      if (this.onTuple) {
        this.onTuple(streamKey, tuple);
      }
    });

    this.ingestTransports.set(streamKey, transport);
    transport.observer.on('close', () => {
      this.ingestTransports.delete(streamKey);
    });

    const rtpParameters = this.buildRtpParameters(ssrc);
    const producer = await transport.produce({
      kind: 'video',
      rtpParameters,
      appData: { streamKey, role: 'producer' },
    });
    this.producers.set(streamKey, producer);

    producer.observer.on('close', () => {
      this.producers.delete(streamKey);
    });

    return {
      transportId: transport.id,
      rtpPort: transport.tuple.localPort,
      rtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
      rtpParameters,
    };
  }

  async createRecordingPipeline(streamKey, { ip, port, rtcpPort }) {
    await this.init();
    const producer = this.producers.get(streamKey);
    if (!producer) {
      throw new Error(`producer not ready for ${streamKey}`);
    }

    const transport = await this.router.createPlainTransport({
      listenIp: this.config.recordListenIp,
      rtcpMux: false,
      comedia: false,
      enableSctp: false,
      appData: { streamKey, role: 'record' },
    });

    await transport.connect({ ip, port, rtcpPort });

    this.recordTransports.set(streamKey, transport);
    transport.observer.on('close', () => {
      this.recordTransports.delete(streamKey);
    });

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.router.rtpCapabilities,
      paused: true,
      appData: { streamKey, role: 'record' },
    });

    this.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => {
      this.consumers.delete(consumer.id);
    });

    await consumer.resume();

    return {
      transportId: transport.id,
      consumerId: consumer.id,
    };
  }

  async createWebRtcTransport(streamKey, direction) {
    await this.init();

    const transport = await this.router.createWebRtcTransport({
      listenIps: this.config.webRtcListenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: { streamKey, direction },
    });

    this.webRtcTransports.set(transport.id, transport);
    transport.observer.on('close', () => {
      this.webRtcTransports.delete(transport.id);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectWebRtcTransport(transportId, dtlsParameters) {
    const transport = this.webRtcTransports.get(transportId);
    if (!transport) {
      throw new Error(`transport ${transportId} not found`);
    }
    await transport.connect({ dtlsParameters });
    return { transportId };
  }

  async consume(streamKey, transportId, rtpCapabilities) {
    const transport = this.webRtcTransports.get(transportId);
    if (!transport) {
      throw new Error(`transport ${transportId} not found`);
    }
    const producer = this.producers.get(streamKey);
    if (!producer) {
      throw new Error(`producer for ${streamKey} not found`);
    }

    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error('rtpCapabilities cannot consume this stream');
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
      appData: { streamKey, role: 'webrtc-consumer' },
    });

    this.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => {
      this.consumers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  async resumeConsumer(consumerId) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new Error(`consumer ${consumerId} not found`);
    }
    await consumer.resume();
    return { consumerId };
  }

  async closeSession(streamKey) {
    const producer = this.producers.get(streamKey);
    if (producer) {
      producer.close();
    }

    const ingestTransport = this.ingestTransports.get(streamKey);
    if (ingestTransport) {
      ingestTransport.close();
    }

    const recordTransport = this.recordTransports.get(streamKey);
    if (recordTransport) {
      recordTransport.close();
    }

    for (const [consumerId, consumer] of this.consumers.entries()) {
      if (consumer.appData.streamKey === streamKey) {
        consumer.close();
        this.consumers.delete(consumerId);
      }
    }

    for (const [transportId, transport] of this.webRtcTransports.entries()) {
      if (transport.appData.streamKey === streamKey) {
        transport.close();
        this.webRtcTransports.delete(transportId);
      }
    }
  }

  buildRtpParameters(ssrc) {
    return {
      codecs: [
        {
          mimeType: 'video/H264',
          payloadType: 96,
          clockRate: 90000,
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' },
          ],
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
          },
        },
      ],
      encodings: [
        {
          ssrc,
        },
      ],
      headerExtensions: [
        {
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          id: 10,
        },
      ],
      rtcp: {
        cname: `stream-${ssrc}`,
        reducedSize: false,
        mux: false,
      },
    };
  }

  getRouterRtpCapabilities() {
    if (!this.router) {
      throw new Error('router not initialised');
    }
    return this.router.rtpCapabilities;
  }

  getStatus() {
    return {
      worker: this.worker ? { pid: this.worker.pid } : null,
      router: this.router ? { id: this.router.id } : null,
      producers: Array.from(this.producers.values()).map((producer) => ({
        id: producer.id,
        streamKey: producer.appData.streamKey,
        kind: producer.kind,
      })),
      transports: Array.from(this.webRtcTransports.values()).map((transport) => ({
        id: transport.id,
        streamKey: transport.appData.streamKey,
        direction: transport.appData.direction,
      })),
    };
  }
}

module.exports = MediasoupHandler;
