'use strict';

const net = require('net');
const os = require('os');

function getLocalIPv4Addresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' || entry.family === 4) {
        if (!entry.internal && entry.address) {
          addresses.push(entry.address);
        }
      }
    }
  }
  return addresses;
}

function parseIpv4(ip) {
  const parts = String(ip || '')
    .trim()
    .split('.')
    .map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function sameSubnet(ipA, ipB, prefixLen = 24) {
  const a = parseIpv4(ipA);
  const b = parseIpv4(ipB);
  if (!a || !b) return false;

  const fullBytes = Math.floor(prefixLen / 8);
  const remainder = prefixLen % 8;

  for (let i = 0; i < fullBytes; i += 1) {
    if (a[i] !== b[i]) return false;
  }

  if (remainder === 0) return true;

  const mask = (0xff << (8 - remainder)) & 0xff;
  return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

function findMatchingLocalIp(readerIp, prefixLen = 24) {
  return getLocalIPv4Addresses().find((localIp) =>
    sameSubnet(localIp, readerIp, prefixLen),
  );
}

function describeSubnetMismatch(readerIp) {
  const localIps = getLocalIPv4Addresses();
  if (!localIps.length) {
    return 'This PC has no active IPv4 network address.';
  }

  return (
    `Reader ${readerIp} is not on the same subnet as this PC ` +
    `(${localIps.join(', ')}). ` +
    'Connect the PC to the reader network (e.g. 192.168.1.x) or change the reader IP in Settings / MyReaderDemo.'
  );
}

function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_e) {
        /* ignore */
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      finish({ ok: true, host, port, latencyMs: null });
    });

    socket.once('timeout', () => {
      finish({
        ok: false,
        host,
        port,
        error: 'TCP connection timed out',
        code: 'ETIMEDOUT',
      });
    });

    socket.once('error', (err) => {
      finish({
        ok: false,
        host,
        port,
        error: err.message || 'TCP connection failed',
        code: err.code || null,
      });
    });

    try {
      socket.connect(Number(port), String(host));
    } catch (err) {
      finish({
        ok: false,
        host,
        port,
        error: err.message || 'TCP connection failed',
        code: err.code || null,
      });
    }
  });
}

function formatRfidConnectError(readerIp, port, cause) {
  const localMatch = findMatchingLocalIp(readerIp);
  const message = String(cause || '').trim();

  if (!localMatch) {
    return describeSubnetMismatch(readerIp);
  }

  if (/no ping/i.test(message)) {
    return (
      `ETS-IR reader at ${readerIp}:${port} did not respond to the SDK ping. ` +
      'Check reader power, Ethernet/Wi‑Fi link, and that port 9090 is open.'
    );
  }

  if (/timed out|timeout/i.test(message)) {
    return (
      `Connection to ${readerIp}:${port} timed out. ` +
      'Ping may also show "Request timed out" when the reader is offline or on another network.'
    );
  }

  return message || `Could not connect to RFID reader at ${readerIp}:${port}`;
}

module.exports = {
  getLocalIPv4Addresses,
  sameSubnet,
  findMatchingLocalIp,
  describeSubnetMismatch,
  probeTcp,
  formatRfidConnectError,
};
