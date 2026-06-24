'use strict';

let getMainWindow = () => null;
const sseClients = new Set();

function setWindowGetter(fn) {
  getMainWindow = typeof fn === 'function' ? fn : () => null;
}

function addSseClient(res) {
  sseClients.add(res);
  return () => sseClients.delete(res);
}

function emit(channel, payload = {}) {
  try {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (_err) {
    /* ignore renderer unavailable */
  }

  if (!sseClients.size) return;

  const message = JSON.stringify({ channel, payload });
  for (const client of sseClients) {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (_err) {
      sseClients.delete(client);
    }
  }
}

module.exports = { setWindowGetter, addSseClient, emit };
