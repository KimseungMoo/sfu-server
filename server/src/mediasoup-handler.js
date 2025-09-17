const mediasoup = require('mediasoup');

const DEFAULT_RTC_MIN_PORT = 20000;
const DEFAULT_RTC_MAX_PORT = 21000;

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
      // console.log('Mediasoup worker already initialized');
      return;
    }

    // console.log('Initializing mediasoup worker...');
    // console.log(`Worker config: rtcMinPort=${this.config.rtcMinPort}, rtcMaxPort=${this.config.rtcMaxPort}`);
    
    try {
      this.worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: this.config.rtcMinPort,
        rtcMaxPort: this.config.rtcMaxPort,
      });
      // console.log('Mediasoup worker created successfully');
    } catch (error) {
      console.error('Failed to create mediasoup worker:', error);
      throw error;
    }

    this.worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    // console.log('Creating mediasoup router...');
    try {
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
      // console.log('Mediasoup router created successfully');
    } catch (error) {
      console.error('Failed to create mediasoup router:', error);
      throw error;
    }
  }

  async createIngest(streamKey, { port, rtcpPort, ssrc }) {
    await this.init();

    // 포트 범위 지정
    const transport = await this.router.createPlainTransport({
      listenIp: this.config.listenIp,
      rtcpMux: false,
      comedia: true,
      enableSctp: false,
      appData: { streamKey, role: 'ingest' },
      port: { min: port, max: port + 1 },
      rtcpPort: { min: rtcpPort, max: rtcpPort + 1 },
    });
    // console.log(`[RTP][INGEST] streamKey=${streamKey} rtpPort=${transport.tuple.localPort} rtcpPort=${transport.rtcpTuple?.localPort}`)

    transport.on('tuple', (tuple) => {
      if (this.onTuple) {
        this.onTuple(streamKey, tuple);
      }
    });

    // transport.on('rtcpTuple', (rtcpTuple) => {
    //   console.log(`[RTCP] streamKey=${streamKey} remote=${rtcpTuple.remoteIp}:${rtcpTuple.remotePort}`)
    // })


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

    // console.log(`Producer created for streamKey: ${streamKey}, id: ${producer.id}, kind: ${producer.kind}`);

    producer.observer.on('close', () => {
      // console.log(`Producer closed for streamKey: ${streamKey}, id: ${producer.id}`);
      this.producers.delete(streamKey);
    });

    // Producer 상태 모니터링
    // producer.on('videoorientationchange', (videoOrientation) => {
    //   console.log(`Producer video orientation changed: ${JSON.stringify(videoOrientation)}`);
    // });

    // Producer 통계 정보 주기적으로 확인 (성능을 위해 간격 증가)
    const producerStatsInterval = setInterval(async () => {
      try {
        if (!producer.closed) {
          const stats = await producer.getStats();
          // 성능을 위해 상세 로깅 감소
          // const firstStat = stats[0];
          // if (firstStat) {
          //   console.log(`Producer ${streamKey} - Bitrate: ${Math.round(firstStat.bitrate / 1000)}kbps, Packets: ${firstStat.packetCount}`);
          // }
        } else {
          clearInterval(producerStatsInterval);
        }
      } catch (err) {
        console.log(`Failed to get producer stats for ${streamKey}:`, err.message);
        clearInterval(producerStatsInterval);
      }
    }, 30000); // 30초로 간격 증가

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
    
    // console.log(`WebRTC transport created: ${transport.id}, direction: ${direction}, streamKey: ${streamKey}`);

    transport.observer.on('close', () => {
      // console.log(`WebRTC transport closed: ${transport.id}`);
      this.webRtcTransports.delete(transport.id);
    });

    // WebRTC transport 이벤트 모니터링
    // transport.on('icestatechange', (iceState) => {
    //   console.log(`WebRTC transport ${transport.id} ICE state changed to: ${iceState}`);
    // });

    // transport.on('iceselectedtuplechange', (iceSelectedTuple) => {
    //   console.log(`WebRTC transport ${transport.id} ICE selected tuple changed:`, iceSelectedTuple);
    // });

    // transport.on('dtlsstatechange', (dtlsState) => {
    //   console.log(`WebRTC transport ${transport.id} DTLS state changed to: ${dtlsState}`);
    // });

    // transport.on('sctpstatechange', (sctpState) => {
    //   console.log(`WebRTC transport ${transport.id} SCTP state changed to: ${sctpState}`);
    // });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectWebRtcTransport(transportId, dtlsParameters) {
    // console.log(`Connecting WebRTC transport: ${transportId}`);
    const transport = this.webRtcTransports.get(transportId);
    if (!transport) {
      throw new Error(`transport ${transportId} not found`);
    }
    
    // console.log(`Transport ${transportId} current states:`, {
    //   iceState: transport.iceState,
    //   dtlsState: transport.dtlsState,
    //   sctpState: transport.sctpState,
    // });
    
    await transport.connect({ dtlsParameters });
    // console.log(`WebRTC transport connected: ${transportId}`);
    
    // console.log(`Transport ${transportId} states after connect:`, {
    //   iceState: transport.iceState,
    //   dtlsState: transport.dtlsState,
    //   sctpState: transport.sctpState,
    // });
    
    return { transportId };
  }

  async consume(streamKey, transportId, rtpCapabilities) {
    // console.log(`Creating consumer for streamKey: ${streamKey}, transportId: ${transportId}`);
    
    const transport = this.webRtcTransports.get(transportId);
    if (!transport) {
      throw new Error(`transport ${transportId} not found`);
    }
    // console.log(`Transport found: ${transportId}`);
    
    const producer = this.producers.get(streamKey);
    if (!producer) {
      throw new Error(`producer for ${streamKey} not found`);
    }
    // console.log(`Producer found: ${producer.id}, kind: ${producer.kind}, paused: ${producer.paused}, closed: ${producer.closed}`);
    
    // Producer의 통계 정보 확인
    try {
      const stats = await producer.getStats();
      // console.log('Producer stats:', JSON.stringify(stats, null, 2));
    } catch (err) {
      console.log('Failed to get producer stats:', err.message);
    }

    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error('rtpCapabilities cannot consume this stream');
    }
    // console.log('RTP capabilities check passed');

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
      appData: { streamKey, role: 'webrtc-consumer' },
    });
    // console.log(`Consumer created: ${consumer.id}, kind: ${consumer.kind}, paused: ${consumer.paused}`);

    this.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => {
      // console.log(`Consumer ${consumer.id} closed for streamKey: ${streamKey}`);
      this.consumers.delete(consumer.id);
    });

    // Consumer 이벤트 모니터링
    // consumer.on('transportclose', () => {
    //   console.log(`Consumer ${consumer.id} transport closed`);
    // });

    // consumer.on('producerclose', () => {
    //   console.log(`Consumer ${consumer.id} producer closed`);
    // });

    // consumer.on('producerpause', () => {
    //   console.log(`Consumer ${consumer.id} producer paused`);
    // });

    // consumer.on('producerresume', () => {
    //   console.log(`Consumer ${consumer.id} producer resumed`);
    // });

    // consumer.on('score', (score) => {
    //   console.log(`Consumer ${consumer.id} score updated:`, score);
    // });

    // consumer.on('layerschange', (layers) => {
    //   console.log(`Consumer ${consumer.id} layers changed:`, layers);
    // });

    // Consumer 통계 정보 주기적으로 확인 (성능을 위해 간격 증가)
    const consumerStatsInterval = setInterval(async () => {
      try {
        if (!consumer.closed) {
          const stats = await consumer.getStats();
          // 성능을 위해 상세 로깅 감소
          // console.log(`Consumer ${consumer.id} - Packets: ${stats.length > 0 ? 'receiving' : 'none'}`);
        } else {
          clearInterval(consumerStatsInterval);
        }
      } catch (err) {
        console.log(`Failed to get consumer stats for ${consumer.id}:`, err.message);
        clearInterval(consumerStatsInterval);
      }
    }, 30000); // 30초로 간격 증가

    return {
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  async resumeConsumer(consumerId) {
    // console.log(`Resuming consumer: ${consumerId} - Start time: ${new Date().toISOString()}`);
    const consumer = this.consumers.get(consumerId);
    if (!consumer) {
      throw new Error(`consumer ${consumerId} not found`);
    }
    
    // console.log(`Consumer found: ${consumerId}`, {
    //   paused: consumer.paused,
    //   closed: consumer.closed,
    //   producerPaused: consumer.producerPaused,
    //   score: consumer.score,
    // });
    
    if (consumer.closed) {
      throw new Error(`consumer ${consumerId} is closed`);
    }
    
    if (!consumer.paused) {
      // console.log(`Consumer ${consumerId} is already resumed`);
      return { consumerId, alreadyResumed: true };
    }
    
    try {
      // console.log(`Calling consumer.resume() for ${consumerId} at ${new Date().toISOString()}`);
      await consumer.resume();
      // console.log(`Consumer.resume() completed for ${consumerId} at ${new Date().toISOString()}, paused: ${consumer.paused}`);
    } catch (err) {
      console.error(`Failed to resume consumer ${consumerId}:`, err);
      throw err;
    }
    
    // 즉시 상태 확인
    // console.log(`Consumer ${consumerId} state after resume:`, {
    //   paused: consumer.paused,
    //   closed: consumer.closed,
    //   producerPaused: consumer.producerPaused,
    //   score: consumer.score,
    // });
    
    // Producer도 확인
    // const streamKey = consumer.appData.streamKey;
    // if (streamKey) {
    //   const producer = this.producers.get(streamKey);
    //   if (producer) {
    //     console.log(`Producer ${producer.id} state:`, {
    //       paused: producer.paused,
    //       closed: producer.closed,
    //     });
    //   }
    // }
    
    // Consumer 상태 재확인
    setTimeout(async () => {
      try {
        const stats = await consumer.getStats();
        // console.log(`Consumer ${consumerId} stats after resume:`, JSON.stringify(stats, null, 2));
      } catch (err) {
        console.log(`Failed to get consumer stats after resume:`, err.message);
      }
    }, 1000);
    
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
