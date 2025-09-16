class PortAllocator {
  constructor(options = {}) {
    const {
      start = 6000,
      end = 7000,
      step = 2,
    } = options;
    this.start = start;
    this.end = end;
    this.step = step;
    this.next = start;
    this.released = [];
  }

  allocatePair() {
    if (this.released.length > 0) {
      return this.released.shift();
    }

    if (this.next + this.step - 1 > this.end) {
      throw new Error('No free ports available for allocation');
    }

    const rtpPort = this.next;
    this.next += this.step;

    return {
      rtpPort,
      rtcpPort: rtpPort + 1,
    };
  }

  release({ rtpPort, rtcpPort }) {
    if (typeof rtpPort !== 'number') {
      return;
    }
    this.released.push({ rtpPort, rtcpPort });
  }
}

module.exports = PortAllocator;
