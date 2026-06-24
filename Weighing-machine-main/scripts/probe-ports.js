'use strict';

const { SerialPort } = require('serialport');

const POLL_COMMANDS = [
  Buffer.from('\r'),
  Buffer.from('P\r'),
  Buffer.from('W\r'),
  Buffer.from('?\r'),
  Buffer.from('\x05'), // ENQ
  Buffer.from('S\r'),
];

const CONFIGS = [
  { baudRate: 2400, dataBits: 7, parity: 'none', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'even', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'odd', stopBits: 1 },
  { baudRate: 2400, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 4800, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 1200, dataBits: 8, parity: 'none', stopBits: 1 },
];

function probe(path, cfg, ms = 3000, poll = false) {
  return new Promise((resolve) => {
    const port = new SerialPort({ path, ...cfg, autoOpen: false, hupcl: false });
    let bytes = 0;
    let hex = '';
    let text = '';
    let done = false;
    const finish = (row) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (port.isOpen) port.close(() => resolve(row));
      else resolve(row);
    };
    const timer = setTimeout(() => finish({ path, ...cfg, bytes, hex, text }), ms);
    port.on('data', (chunk) => {
      bytes += chunk.length;
      hex += chunk.toString('hex').toUpperCase();
      text += chunk.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
    });
    port.open((err) => {
      if (err) finish({ path, ...cfg, bytes: 0, error: err.message });
      else if (typeof port.set === 'function') {
        port.set({ dtr: true, rts: true }, () => {
          if (!poll) return;
          let i = 0;
          const sendNext = () => {
            if (i >= POLL_COMMANDS.length || done) return;
            const cmd = POLL_COMMANDS[i++];
            port.write(cmd, sendNext);
          };
          setTimeout(sendNext, 200);
        });
      }
    });
  });
}

(async () => {
  const listed = await SerialPort.list();
  console.log('Ports:', listed.map((p) => `${p.path} (${p.manufacturer || '?'})`).join(', '));
  const paths = process.argv.slice(2).length ? process.argv.slice(2) : ['COM3', 'COM4'];
  const poll = process.argv.includes('--poll');
  for (const path of paths) {
    if (path === '--poll') continue;
    console.log(`\n=== ${path}${poll ? ' (with poll commands)' : ''} ===`);
    for (const cfg of CONFIGS) {
      const row = await probe(path, cfg, 2500, poll);
      const label = `${cfg.baudRate} ${cfg.dataBits}${cfg.parity[0].toUpperCase()}${cfg.stopBits}`;
      if (row.error) console.log(`  ${label}: ERROR ${row.error}`);
      else if (row.bytes > 0) {
        console.log(`  ${label}: ${row.bytes} bytes | hex=${row.hex.slice(0, 60)} | text="${row.text.trim()}"`);
      } else console.log(`  ${label}: no data`);
    }
  }
})();
