#!/usr/bin/env node
const net = require('net');
const dgram = require('dgram');

const target = process.argv[2] || 'localhost';
const ports = [
  { label: 'HTTP/WebSocket', protocol: 'tcp', port: Number(process.env.PORT || 8080) },
  { label: 'RTP ingest', protocol: 'udp', port: Number(process.env.SFU_PORT || 5000) },
  { label: 'mediasoup range', protocol: 'udp', port: 10000 },
];

async function checkTcp(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ port, open: false });
    }, 1500);

    socket.connect(port, host, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ port, open: true });
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve({ port, open: false });
    });
  });
}

async function checkUdp(host, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const message = Buffer.from('ping');
    socket.send(message, port, host, (error) => {
      socket.close();
      resolve({ port, open: !error });
    });
  });
}

(async () => {
  for (const item of ports) {
    let result;
    if (item.protocol === 'tcp') {
      result = await checkTcp(target, item.port);
    } else {
      result = await checkUdp(target, item.port);
    }
    const status = result.open ? 'open' : 'closed';
    console.log(`${item.protocol.toUpperCase()} ${item.port} (${item.label}): ${status}`);
  }
})();
