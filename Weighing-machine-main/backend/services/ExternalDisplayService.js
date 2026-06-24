'use strict';

const { SerialPort } = require('serialport');
const logger = require('../utils/logger');

const STX = 0x02;
const ETX = 0x03;
/** Min gap between frames at 1200 baud (~12 bytes ≈ 100 ms on the wire). */
const MIN_TRANSMIT_MS = 250;
/** Pause after drain so the LED board can latch before the next frame. */
const WIRE_SETTLE_MS = 200;
/** Re-send the same weight periodically — some LED boards stop updating without refresh. */
const KEEPALIVE_MS = 5000;
/** TW5+150KD: STX + sign + 6 digits + decimal + XOR(2) + ETX */
const TW150KD_FRAME_BYTE_LENGTH = 12;
/** Legacy WS1: channel(1) + cmd(3) + datum(6) + XOR(2) + STX + ETX */
const WS1_FRAME_BYTE_LENGTH = 14;

const PROTOCOL_WS1 = 'ws1';
const PROTOCOL_SIGNED = 'signed';

const DEFAULTS = Object.freeze({
  enabled: true,
  port: 'COM3',
  baudRate: 1200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  channel: 0,
  command: 'WS1',
  decimalPlaces: 0,
  protocol: PROTOCOL_SIGNED,
  checksumMode: 'xor',
});

let config = { ...DEFAULTS };
let lastSentWeight = null;
let lastRequestedWeight = null;
let lastWriteAt = 0;
let lastWriteOk = true;
let lastWriteError = null;
let lastSkipReason = null;
let pendingWeight = null;
let throttleTimer = null;
let portBusy = false;
let writeChain = Promise.resolve();
let lastSentProtocol = null;
let lastSentDatum = null;
let lastSentWs1Command = null;
let persistentSerial = null;
let persistentSerialKey = '';
let flushRunning = false;
let flushAgain = false;
let queuedTxOptions = null;
let confirmTimer = null;

function delayMs(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

function describeFrame(frame, protocol = config.protocol) {
  const hex = frame.toString('hex').toUpperCase();
  const bytes = [...frame];
  const stx = bytes[0] === STX;
  const etx = bytes[bytes.length - 1] === ETX;
  let payload = '';
  if (stx && etx && bytes.length > 2) {
    payload = Buffer.from(bytes.slice(1, -1))
      .toString('ascii')
      .replace(/[^\x20-\x7E]/g, '.');
  }
  return {
    hex,
    byteLength: frame.length,
    hasStx: stx,
    hasEtx: etx,
    payloadAscii: payload,
    protocol,
  };
}

function logDisplay(eventType, message, metadata = {}) {
  logger.logDevice('externalDisplay', eventType, message, {
    port: config.port,
    baudRate: config.baudRate,
    protocol: config.protocol,
    command: config.command,
    channel: config.channel,
    decimalPlaces: config.decimalPlaces,
    lastSentWeight,
    lastRequestedWeight,
    lastWriteOk,
    lastWriteError,
    ...metadata,
  });
}

function loadConfig() {
  let settings = {};
  try {
    const SettingsService = require('./SettingsService');
    settings = SettingsService.getAll();
  } catch (_e) {
    /* DB may not be ready */
  }

  const pick = (key, fallback) => {
    if (settings[key] !== undefined && settings[key] !== '') {
      return settings[key];
    }
    if (process.env[key] !== undefined && process.env[key] !== '') {
      return process.env[key];
    }
    return fallback;
  };

  const enabledRaw = pick('EXTERNAL_DISPLAY_ENABLED', DEFAULTS.enabled ? 'true' : 'false');
  const enabled = String(enabledRaw).toLowerCase() === 'true' || enabledRaw === '1';
  const command = String(pick('EXTERNAL_DISPLAY_COMMAND', DEFAULTS.command));
  const protocolSetting = pick('EXTERNAL_DISPLAY_PROTOCOL', '');
  const protocolRaw = String(protocolSetting || '').toLowerCase().trim();

  let protocol = PROTOCOL_SIGNED;
  if (protocolRaw === PROTOCOL_WS1) {
    protocol = PROTOCOL_WS1;
  }

  // TW5+150KD boards use 12-byte signed frames (manufacturer doc), not WS1 serial.
  if (protocol === PROTOCOL_WS1 && /^ws1$/i.test(command)) {
    logDisplay('warn', 'TW5+150KD display uses signed protocol — set display protocol to Signed ASCII', {
      command,
      configuredProtocol: protocolRaw || 'ws1',
      effectiveProtocol: PROTOCOL_SIGNED,
      note: 'See TW5+150KD data receiving string: STX + sign + 6 digits + decimal + XOR + ETX',
    });
    protocol = PROTOCOL_SIGNED;
  }

  // WS1 boards use 6-digit whole kg; decimals break the datum field.
  const decimalPlacesRaw = Number(pick('EXTERNAL_DISPLAY_DECIMAL_PLACES', '0')) || 0;
  const decimalPlaces = protocol === PROTOCOL_WS1 ? 0 : decimalPlacesRaw;

  const previousProtocol = config.protocol;
  const previousPort = config.port;

  config = {
    enabled,
    port: pick('EXTERNAL_DISPLAY_COM_PORT', DEFAULTS.port),
    baudRate: Number(pick('EXTERNAL_DISPLAY_BAUD_RATE', String(DEFAULTS.baudRate))),
    dataBits: Number(pick('EXTERNAL_DISPLAY_DATA_BITS', String(DEFAULTS.dataBits))),
    stopBits: Number(pick('EXTERNAL_DISPLAY_STOP_BITS', String(DEFAULTS.stopBits))),
    parity: String(pick('EXTERNAL_DISPLAY_PARITY', DEFAULTS.parity)).toLowerCase(),
    channel: resolveChannelNumber(pick('EXTERNAL_DISPLAY_CHANNEL', String(DEFAULTS.channel))),
    command,
    decimalPlaces,
    protocol,
    checksumMode: String(
      pick('EXTERNAL_DISPLAY_CHECKSUM_MODE', DEFAULTS.checksumMode),
    ).toLowerCase(),
  };

  if (decimalPlacesRaw > 0 && protocol === PROTOCOL_WS1) {
    logDisplay('warn', 'WS1 display ignores decimal places — forcing 0', {
      configuredDecimalPlaces: decimalPlacesRaw,
      effectiveDecimalPlaces: 0,
    });
  }

  if (
    (previousProtocol && previousProtocol !== config.protocol) ||
    (previousPort && previousPort !== config.port) ||
    (lastSentProtocol && lastSentProtocol === PROTOCOL_WS1) ||
    (lastSentWs1Command && lastSentWs1Command !== 'WS ')
  ) {
    lastSentWeight = null;
    lastSentProtocol = null;
    lastSentDatum = null;
    lastSentWs1Command = null;
  }

  return config;
}

function isEnabled() {
  if (!config || Object.keys(config).length === 0) {
    loadConfig();
  }
  return !!config.enabled;
}

function normalizeWeightKg(kg) {
  const n = Math.round(Number(kg));
  return Number.isFinite(n) ? n : 0;
}

function resolveChannelNumber(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 9) return n;
  return DEFAULTS.channel;
}

function resolveChannelByte() {
  return 0x80 + resolveChannelNumber(config.channel);
}

/** 3-char WS1 command field (padding only). */
function normalizeWs1Command(command) {
  const raw = String(command || DEFAULTS.command).toUpperCase();
  return raw.padEnd(3, ' ').slice(0, 3);
}

/**
 * 3-char command: "WS " — channel is only in 0x80+N. Keeps a fixed 14-byte frame.
 * Datum starts at payload index 4; small weights are left-aligned ("60    ").
 */
function resolveWs1CommandField() {
  return 'WS ';
}

/**
 * WS1 datum (6 chars). Large weights zero-pad; small weights left-align with spaces
 * so digits land in the LED window (WS0 + 000060 showed 00000 — the 6 was past digit 5).
 */
function formatWs1Datum(kg) {
  const safe = Math.abs(normalizeWeightKg(kg));
  const text = String(safe);
  if (text.length > 6) return text.slice(-6);
  if (safe === 0) return '      ';
  if (text.length <= 4) return text.padEnd(6, ' ');
  return text.padStart(6, '0');
}

function formatWeightDatum(kg, decimalPlaces = config.decimalPlaces) {
  loadConfig();
  if (config.protocol === PROTOCOL_WS1) {
    return formatWs1Datum(kg);
  }

  const safe = Math.abs(normalizeWeightKg(kg));
  const decimals = Math.max(0, Math.min(4, Number(decimalPlaces) || 0));

  if (decimals > 0) {
    const parts = safe.toFixed(decimals).split('.');
    const withComma = `${parts[0]},${parts[1]}`;
    if (withComma.length > 6) {
      return withComma.slice(0, 6);
    }
    return withComma.padStart(6, '0');
  }

  const text = String(safe);
  if (text.length > 6) {
    return text.slice(-6);
  }
  return text.padStart(6, '0');
}

function buildXorChecksumHex(bytes) {
  let xor = 0;
  for (const b of bytes) {
    xor ^= b;
  }
  return xor.toString(16).toUpperCase().padStart(2, '0');
}

function buildSignedChecksumBytes(payloadBytes) {
  if (config.checksumMode === 'xor') {
    let xor = 0;
    for (const b of payloadBytes) {
      xor ^= b;
    }
    return Buffer.from([xor & 0xff, 0x00, 0x00]);
  }
  return Buffer.from([0x00, 0x00, 0x00]);
}

/**
 * TW5+150KD remote display — fixed 12-byte frame (manufacturer "Data Receiving String"):
 * STX(02) + sign(+/−) + 6-digit weight + decimal(0–4) + XOR hex(2) + ETX(03)
 * Default serial: 1200 8N1.
 */
function buildSignedFrame(kg) {
  const weight = normalizeWeightKg(kg);
  const sign = weight < 0 ? 0x2d : 0x2b;
  const abs = Math.abs(weight);
  const decimals = Math.max(0, Math.min(4, Number(config.decimalPlaces) || 0));
  const digits = String(abs).padStart(6, '0').slice(-6);
  const decimalByte = 0x30 + decimals;
  const bodyBytes = Buffer.concat([
    Buffer.from([sign]),
    Buffer.from(digits, 'ascii'),
    Buffer.from([decimalByte]),
  ]);
  const checksum = buildXorChecksumHex(bodyBytes);

  return Buffer.concat([
    Buffer.from([STX]),
    bodyBytes,
    Buffer.from(checksum, 'ascii'),
    Buffer.from([ETX]),
  ]);
}

function buildWs1Frame(kg) {
  const channelByte = resolveChannelByte();
  const command = resolveWs1CommandField();
  const datum = formatWs1Datum(kg);
  const payloadStr = String.fromCharCode(channelByte) + command + datum;
  const payloadBytes = Buffer.from(payloadStr, 'ascii');
  const checksum = buildXorChecksumHex(payloadBytes);

  return Buffer.concat([
    Buffer.from([STX]),
    payloadBytes,
    Buffer.from(checksum, 'ascii'),
    Buffer.from([ETX]),
  ]);
}

function frameDatumForWeight(kg) {
  const weight = normalizeWeightKg(kg);
  if (config.protocol === PROTOCOL_SIGNED) {
    const abs = Math.abs(weight);
    const digits = String(abs).padStart(6, '0').slice(-6);
    const decimals = Math.max(0, Math.min(4, Number(config.decimalPlaces) || 0));
    return `${weight >= 0 ? '+' : '-'}${digits}.${decimals}`;
  }
  return formatWs1Datum(weight);
}

function shouldSkipTransmit(displayWeight, datum, options = {}) {
  if (options.force) return false;
  if (!lastWriteOk) return false;
  if (lastSentWeight !== displayWeight) return false;
  if (lastSentProtocol !== config.protocol) return false;
  if (lastSentDatum && datum && lastSentDatum !== datum) return false;
  if (
    config.protocol === PROTOCOL_WS1 &&
    lastSentWs1Command &&
    lastSentWs1Command !== resolveWs1CommandField()
  ) {
    return false;
  }
  if (
    displayWeight > 0 &&
    lastWriteAt > 0 &&
    Date.now() - lastWriteAt >= KEEPALIVE_MS
  ) {
    return false;
  }
  return true;
}

function isKeepaliveDue(displayWeight) {
  return (
    displayWeight > 0 &&
    lastWriteAt > 0 &&
    Date.now() - lastWriteAt >= KEEPALIVE_MS
  );
}

function buildFrame(kg) {
  loadConfig();
  if (config.protocol === PROTOCOL_WS1) {
    return buildWs1Frame(kg);
  }
  return buildSignedFrame(kg);
}

function getSnapshot() {
  return {
    connected: !portBusy && lastWriteOk,
    enabled: isEnabled(),
    port: config.port,
    baudRate: config.baudRate,
    protocol: config.protocol,
    lastSentWeight,
    lastRequestedWeight,
    pendingWeight,
    lastWriteOk,
    lastWriteError,
    lastSkipReason,
    lastWriteAt: lastWriteAt || null,
  };
}

function serialConfigKey() {
  return [
    config.port,
    config.baudRate,
    config.dataBits,
    config.parity,
    config.stopBits,
  ].join(':');
}

async function acquireSerial() {
  const key = serialConfigKey();
  if (persistentSerial?.isOpen && persistentSerialKey === key) {
    return persistentSerial;
  }
  await releaseSerial();
  persistentSerial = await openPortOnce();
  persistentSerialKey = key;
  return persistentSerial;
}

async function releaseSerial() {
  if (persistentSerial?.isOpen) {
    await closePort(persistentSerial);
  }
  persistentSerial = null;
  persistentSerialKey = '';
}

function openPortOnce() {
  return new Promise((resolve, reject) => {
    const serial = new SerialPort({
      path: config.port,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      autoOpen: false,
      hupcl: false,
      rtscts: false,
    });

    serial.open((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(serial);
    });
  });
}

function closePort(serial) {
  return new Promise((resolve) => {
    if (!serial || !serial.isOpen) {
      resolve();
      return;
    }
    serial.close(() => resolve());
  });
}

function writeFrame(serial, frame) {
  return new Promise((resolve, reject) => {
    serial.write(frame, (err) => {
      if (err) {
        reject(err);
        return;
      }
      serial.drain((drainErr) => {
        if (drainErr) reject(drainErr);
        else resolve();
      });
    });
  });
}

async function _transmitWeight(kg, options = {}) {
  loadConfig();
  if (!isEnabled()) {
    lastSkipReason = 'disabled';
    logDisplay('skip', 'Display write skipped (disabled)', {
      requestedKg: normalizeWeightKg(kg),
      source: options.source || null,
      reason: 'disabled',
    });
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const safeWeight = normalizeWeightKg(kg);
  const displayWeight = safeWeight < 0 ? 0 : safeWeight;
  lastRequestedWeight = displayWeight;

  const datum = frameDatumForWeight(displayWeight);

  if (shouldSkipTransmit(displayWeight, datum, options)) {
    lastSkipReason = 'unchanged';
    logDisplay('skip', 'Display write skipped (unchanged)', {
      requestedKg: displayWeight,
      source: options.source || null,
      scaleRawKg: options.scaleRawKg ?? null,
      reason: 'unchanged',
      datum,
      lastSentProtocol,
      effectiveProtocol: config.protocol,
    });
    return { ok: true, skipped: true, reason: 'unchanged' };
  }

  const frame = buildFrame(displayWeight);
  const frameInfo = describeFrame(frame, config.protocol);
  let serial = null;

  logDisplay('tx', 'Sending frame to external display', {
    requestedKg: displayWeight,
    source: options.source || null,
    scaleRawKg: options.scaleRawKg ?? null,
    force: !!options.force,
    datum,
    ws1Command: config.protocol === PROTOCOL_WS1 ? resolveWs1CommandField() : null,
    channelByte: config.protocol === PROTOCOL_WS1 ? resolveChannelByte() : null,
    ...frameInfo,
  });

  try {
    portBusy = true;
    serial = await acquireSerial();
    await writeFrame(serial, frame);
    await delayMs(WIRE_SETTLE_MS);

    if (
      config.protocol === PROTOCOL_SIGNED &&
      frame.length !== TW150KD_FRAME_BYTE_LENGTH
    ) {
      logDisplay('warn', 'TW5+150KD frame length unexpected', {
        byteLength: frame.length,
        expected: TW150KD_FRAME_BYTE_LENGTH,
        hex: frameInfo.hex,
      });
    } else if (
      config.protocol === PROTOCOL_WS1 &&
      frame.length !== WS1_FRAME_BYTE_LENGTH
    ) {
      logDisplay('warn', 'WS1 frame length unexpected', {
        byteLength: frame.length,
        expected: WS1_FRAME_BYTE_LENGTH,
        hex: frameInfo.hex,
      });
    }

    lastSentWeight = displayWeight;
    lastSentProtocol = config.protocol;
    lastSentDatum = datum;
    lastSentWs1Command =
      config.protocol === PROTOCOL_WS1 ? resolveWs1CommandField() : null;
    lastWriteAt = Date.now();
    lastWriteOk = true;
    lastWriteError = null;
    lastSkipReason = null;
    if (!options.test) {
      pendingWeight = displayWeight;
    }

    logDisplay('write', 'External display write OK', {
      weight: displayWeight,
      source: options.source || null,
      scaleRawKg: options.scaleRawKg ?? null,
      datum,
      ...frameInfo,
    });

    return { ok: true, weight: displayWeight, hex: frameInfo.hex, datum };
  } catch (err) {
    lastWriteOk = false;
    lastWriteError = err.message;
    lastSkipReason = 'write-failed';
    await releaseSerial();
    logDisplay('error', 'External display write FAILED', {
      error: err.message,
      requestedKg: displayWeight,
      source: options.source || null,
      scaleRawKg: options.scaleRawKg ?? null,
      datum,
      lastSentWeight,
      note: 'LED may still show an older value until a write succeeds',
      ...frameInfo,
    });
    return { ok: false, error: err.message, datum, hex: frameInfo.hex };
  } finally {
    portBusy = false;
  }
}

async function _flushLatestTransmit() {
  if (flushRunning) {
    flushAgain = true;
    return;
  }
  flushRunning = true;
  try {
    do {
      flushAgain = false;
      const target = pendingWeight;
      if (target == null) break;
      const opts = queuedTxOptions || {};
      await _transmitWeight(target, opts);
    } while (
      flushAgain ||
      (pendingWeight != null && pendingWeight !== lastSentWeight)
    );
  } finally {
    flushRunning = false;
  }
}

function _enqueueTransmit(kg, options = {}) {
  pendingWeight = normalizeWeightKg(kg);
  queuedTxOptions = { ...options };
  const next = writeChain.then(() => _flushLatestTransmit(), () => _flushLatestTransmit());
  writeChain = next.catch(() => {});
  return next;
}

function needsResync(scaleRawKg) {
  const raw = normalizeWeightKg(scaleRawKg);
  if (lastSentProtocol !== config.protocol) return true;
  if (raw <= 0) return lastSentWeight > 0;
  if (!lastWriteOk) return true;
  return lastSentWeight !== raw;
}

async function start() {
  loadConfig();
  lastSentWeight = null;
  lastRequestedWeight = null;
  lastSentProtocol = null;
  lastSentDatum = null;
  lastSentWs1Command = null;
  lastWriteOk = true;
  lastWriteError = null;
  lastSkipReason = null;
  if (!isEnabled()) {
    logger.info('ExternalDisplayService disabled');
    return;
  }
  logDisplay('info', 'Display service ready (persistent serial)', {
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
    logFile: 'logs/external-display.log',
  });
}

async function stop() {
  _clearThrottle();
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  pendingWeight = null;
  await writeChain.catch(() => {});
  await releaseSerial();
  portBusy = false;
}

function _clearThrottle() {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}

function updateWeight(kg, options = {}) {
  loadConfig();
  if (!isEnabled()) return;

  const safeWeight = normalizeWeightKg(kg);
  const displayWeight = safeWeight < 0 ? 0 : safeWeight;

  // Brief zero glitches blank the LED — only clear on explicit weightZero.
  if (displayWeight === 0 && options.source !== 'weightZero') {
    return;
  }

  pendingWeight = displayWeight;
  lastRequestedWeight = displayWeight;

  const txOptions = {
    source: options.source || 'unknown',
    scaleRawKg: options.scaleRawKg ?? null,
    force:
      !!options.force ||
      (displayWeight === 0 && options.source === 'weightZero') ||
      options.source === 'stableWeight' ||
      options.source === 'startup' ||
      options.source === 'manual-sync' ||
      options.source === 'broadcast' ||
      options.source === 'keepalive',
    confirm: !!options.confirm,
  };

  const weightChanged = displayWeight !== lastSentWeight;
  const mustSend =
    txOptions.force ||
    !lastWriteOk ||
    needsResync(displayWeight) ||
    weightChanged ||
    txOptions.source === 'keepalive' ||
    isKeepaliveDue(displayWeight);

  if (!mustSend) {
    return;
  }

  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }

  const scheduleTransmit = (delayMs = 0) => {
    const run = () => {
      const target = pendingWeight;
      if (target == null) return;
      const keepalive = isKeepaliveDue(target);
      const force =
        txOptions.force || !lastWriteOk || needsResync(target) || keepalive;
      _enqueueTransmit(target, {
        ...txOptions,
        force,
        source: keepalive ? 'keepalive' : txOptions.source,
      });
      if (txOptions.confirm && target > 0) {
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          confirmTimer = null;
          _enqueueTransmit(target, {
            ...txOptions,
            force: true,
            confirm: false,
            source: 'confirm',
          });
        }, WIRE_SETTLE_MS + MIN_TRANSMIT_MS);
        if (confirmTimer.unref) confirmTimer.unref();
      }
    };
    if (delayMs <= 0) {
      run();
      return;
    }
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      run();
    }, delayMs);
    if (throttleTimer.unref) throttleTimer.unref();
  };

  const elapsed = Date.now() - lastWriteAt;
  const delayMs = Math.max(0, MIN_TRANSMIT_MS - elapsed);

  if (shouldLogQueue(displayWeight, txOptions)) {
    logDisplay('queue', 'External display update queued', {
      requestedKg: displayWeight,
      source: txOptions.source,
      scaleRawKg: txOptions.scaleRawKg,
      pendingKg: displayWeight,
      delayMs,
      lastSentWeight,
      lastWriteOk,
      lastWriteError,
      needsResync: needsResync(displayWeight),
    });
  }

  scheduleTransmit(delayMs);
}

function shouldLogQueue(displayWeight, txOptions) {
  return (
    displayWeight !== lastSentWeight ||
    !lastWriteOk ||
    txOptions.force ||
    needsResync(displayWeight) ||
    isKeepaliveDue(displayWeight)
  );
}

async function sendTestWeight(kg) {
  loadConfig();
  const fallback = config.protocol === PROTOCOL_SIGNED ? 1234 : 123456;
  const testKg = Math.round(Number(kg));
  const safe = Number.isFinite(testKg) && testKg >= 0 ? testKg : fallback;
  const result = await _enqueueTransmit(safe, { force: true, test: true });
  return result;
}

module.exports = {
  loadConfig,
  isEnabled,
  formatWeightDatum,
  buildFrame,
  buildSignedFrame,
  buildWs1Frame,
  describeFrame,
  start,
  stop,
  updateWeight,
  sendTestWeight,
  getSnapshot,
  needsResync,
  isKeepaliveDue,
  KEEPALIVE_MS,
  PROTOCOL_WS1,
  PROTOCOL_SIGNED,
};
