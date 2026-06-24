'use strict';

const { SerialPort } = require('serialport');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');

const DEFAULTS = Object.freeze({
  port: 'COM4',
  baudRate: 2400,
  dataBits: 7,
  parity: 'none',
  stopBits: 1,
  autoReconnectMs: 2000,
  stableWindowSize: 5,
  stableToleranceKg: 2,
  zeroHoldMs: 2500,
});

const ALTERNATE_BAUD_CONFIGS = [
  { baudRate: 2400, dataBits: 7, parity: 'none', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'even', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'odd', stopBits: 1 },
  { baudRate: 2400, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 4800, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 1200, dataBits: 8, parity: 'none', stopBits: 1 },
];

const POLL_COMMANDS = [
  Buffer.from('\r'),
  Buffer.from('P\r'),
  Buffer.from('W\r'),
  Buffer.from('?\r'),
  Buffer.from('\x05'),
  Buffer.from('S\r'),
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WeightBridgeService {
  constructor(config = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      baudRate: Number(config.baudRate || DEFAULTS.baudRate),
      dataBits: Number(config.dataBits || DEFAULTS.dataBits),
      stopBits: Number(config.stopBits || DEFAULTS.stopBits),
      parity: String(config.parity || DEFAULTS.parity).toLowerCase(),
      autoReconnectMs: Number(config.autoReconnectMs || DEFAULTS.autoReconnectMs),
      stableWindowSize: Number(config.stableWindowSize || DEFAULTS.stableWindowSize),
      stableToleranceKg: Number(config.stableToleranceKg || DEFAULTS.stableToleranceKg),
      zeroHoldMs: Number(config.zeroHoldMs || DEFAULTS.zeroHoldMs),
    };

    this.port = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.connected = false;

    this.latestRawWeight = 0;
    this.latestStableWeight = 0;
    this.latestWeight = 0;
    this.isStable = false;
    this.buffer = [];

    this.weightChangedHandlers = new Set();
    this.lastEmittedWeight = null;
    this.lastEmittedIsStable = false;
    this.textBuffer = '';
    this.zeroCandidateSince = null;
    this._lastRawLogAt = 0;
    this._portClosing = false;
    this._totalBytesReceived = 0;
    this._sessionBytes = 0;
    this._lastReceiveAt = null;
    this._lastSampleHex = '';
    this._lastSampleText = '';
    this._noDataTimer = null;
    this._baudScanDone = false;
    this._pollTimer = null;
    this._pollIndex = 0;
    this._savedSerialConfig = null;
    /** @type {string|null} Payload between STX (0x02) and ETX (0x03), or null when idle. */
    this.stxFrameBuffer = null;
  }

  async start() {
    this.intentionalClose = false;
    this._baudScanDone = false;
    await this._openPort();
    this._scheduleNoDataBaudScan();
  }

  async stop() {
    this.intentionalClose = true;
    this._clearNoDataTimer();
    this._stopPolling();
    this._clearReconnect();
    await this._closePort();
    this.connected = false;
  }

  getDiagnostics() {
    return {
      port: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
      connected: this.connected,
      totalBytesReceived: this._totalBytesReceived,
      lastReceiveAt: this._lastReceiveAt,
      lastSampleHex: this._lastSampleHex,
      lastSampleText: this._lastSampleText,
      latestWeight: this.latestWeight,
      isStable: this.isStable,
    };
  }

  async scanBaudRates(listenMs = 2500) {
    this._clearNoDataTimer();
    this._stopPolling();
    this._clearReconnect();
    this.intentionalClose = true;
    this._savedSerialConfig = {
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
    };
    const results = [];

    for (const cfg of ALTERNATE_BAUD_CONFIGS) {
      this._sessionBytes = 0;
      this._lastSampleHex = '';
      this._lastSampleText = '';
      Object.assign(this.config, cfg);
      try {
        await this._openPort();
        // eslint-disable-next-line no-await-in-loop
        await sleep(listenMs);
        const row = {
          path: this.config.port,
          ...cfg,
          bytes: this._sessionBytes,
          sampleHex: this._lastSampleHex,
          sampleText: this._lastSampleText,
          ok: this._sessionBytes > 0,
        };
        results.push(row);
        if (this._sessionBytes > 0) {
          this.intentionalClose = false;
          this._baudScanDone = true;
          this._savedSerialConfig = null;
          this._startPolling();
          logger.logDevice('weighbridge', 'info', 'Baud scan matched', row);
          return { found: true, match: row, results };
        }
      } catch (err) {
        results.push({
          path: this.config.port,
          ...cfg,
          bytes: 0,
          ok: false,
          error: err.message,
        });
      }
    }

    if (this._savedSerialConfig) {
      Object.assign(this.config, this._savedSerialConfig);
      this._savedSerialConfig = null;
    }
    this.intentionalClose = false;
    this._baudScanDone = true;
    try {
      await this._openPort();
      this._startPolling();
    } catch (_e) {
      /* optional */
    }
    return { found: false, results };
  }

  _scheduleNoDataBaudScan() {
    this._clearNoDataTimer();
    if (this._baudScanDone) return;
    this._noDataTimer = setTimeout(async () => {
      this._noDataTimer = null;
      if (this._totalBytesReceived > 0 || this.intentionalClose) return;
      logger.logDevice('weighbridge', 'info', 'No serial data yet — scanning baud rates', {
        port: this.config.port,
      });
      await this.scanBaudRates(2000);
    }, 6000);
    if (this._noDataTimer.unref) this._noDataTimer.unref();
  }

  _startPolling() {
    this._stopPolling();
    if (this.intentionalClose) return;
    this._pollTimer = setInterval(() => {
      if (this._totalBytesReceived > 0 || !this.port?.isOpen) return;
      const cmd = POLL_COMMANDS[this._pollIndex % POLL_COMMANDS.length];
      this._pollIndex += 1;
      this.port.write(cmd, () => {});
    }, 1500);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _clearNoDataTimer() {
    if (this._noDataTimer) {
      clearTimeout(this._noDataTimer);
      this._noDataTimer = null;
    }
  }

  getCurrentWeight() {
    return this.latestStableWeight;
  }

  getSnapshot() {
    return {
      weight: this.latestWeight,
      stableWeight: this.latestStableWeight,
      isStable: this.isStable,
      connected: this.connected,
      timestamp: ts.now(),
    };
  }

  onWeightChanged(handler) {
    if (typeof handler !== 'function') return () => {};
    this.weightChangedHandlers.add(handler);
    if (this.lastEmittedWeight !== null) {
      try {
        handler({
          weight: this.latestWeight,
          stableWeight: this.latestStableWeight,
          isStable: this.isStable,
          timestamp: ts.now(),
        });
      } catch (err) {
        logger.warn('WeightBridgeService listener failed', { message: err.message });
      }
    }
    return () => {
      this.weightChangedHandlers.delete(handler);
    };
  }

  async _openPort() {
    await this._closePort();

    const options = {
      path: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
      autoOpen: false,
      hupcl: false,
      rtscts: false,
    };

    const port = new SerialPort(options);
    this.port = port;

    port.on('data', (chunk) => this._handleData(chunk));
    port.on('error', (err) => {
      logger.logDevice('weighbridge', 'error', 'Serial error', {
        error: err.message,
        port: this.config.port,
      });
      this._handleDisconnect();
    });
    port.on('close', () => {
      this._handleDisconnect();
    });

    await new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    if (typeof port.set === 'function') {
      await new Promise((resolve) => {
        port.set({ dtr: true, rts: true }, () => resolve());
      });
    }

    this.connected = true;
    this._startPolling();
    logger.logDevice('weighbridge', 'connect', 'Port Connected', {
      port: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
    });
  }

  async _closePort() {
    this._stopPolling();
    const closingPort = this.port;
    this.port = null;
    if (!closingPort) return;

    this._portClosing = true;
    await new Promise((resolve) => {
      if (!closingPort.isOpen) {
        resolve();
        return;
      }
      closingPort.close(() => resolve());
    });
    this._portClosing = false;
  }

  _handleDisconnect() {
    if (this._portClosing) return;
    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;

    logger.logDevice('weighbridge', 'disconnect', 'Port Disconnected', {
      port: this.config.port,
    });

    if (!this.intentionalClose) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._clearReconnect();
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this._openPort();
      } catch (err) {
        logger.logDevice('weighbridge', 'error', 'Serial error', {
          error: err.message,
          port: this.config.port,
        });
        this._scheduleReconnect();
      }
    }, this.config.autoReconnectMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _handleData(chunk) {
    if (chunk && chunk.length) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this._totalBytesReceived += buf.length;
      this._sessionBytes += buf.length;
      this._lastReceiveAt = Date.now();
      this._lastSampleHex = buf.toString('hex').toUpperCase().slice(0, 120);
      this._lastSampleText = buf
        .toString('utf8')
        .replace(/[^\x20-\x7E]/g, '.')
        .slice(0, 80);

      if (this._pollTimer && this._totalBytesReceived > 0) {
        this._stopPolling();
      }

      const now = Date.now();
      if (now - this._lastRawLogAt > 2000) {
        this._lastRawLogAt = now;
        logger.logDevice('weighbridge', 'info', 'Serial data received', {
          port: this.config.port,
          bytes: buf.length,
          hex: this._lastSampleHex,
          text: this._lastSampleText,
        });
      }
    }

    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (!text) return;

    const hasStxEtx = text.includes('\x02') || text.includes('\x03');
    if (hasStxEtx) {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\x02') {
          this.stxFrameBuffer = '';
          continue;
        }
        if (ch === '\x03') {
          if (this.stxFrameBuffer !== null) {
            this._consumeLine(this.stxFrameBuffer);
          }
          this.stxFrameBuffer = null;
          continue;
        }
        if (this.stxFrameBuffer !== null) {
          this.stxFrameBuffer += ch;
        }
      }
      return;
    }

    const compact = text.replace(/\0/g, '').trim();

    // Short fixed frames without STX/ETX (e.g. "60" or "12345") — skip single-digit fragments.
    if (compact.length >= 2 || /[\r\n]/.test(text) || /kg|kgs/i.test(compact)) {
      this._consumeLine(text);
    }

    this.textBuffer += text;
    const lines = this.textBuffer.split(/\r\n|\n|\r/);
    this.textBuffer = lines.pop() || '';

    for (const line of lines) {
      this._consumeLine(line);
    }

    // Fallback for streams with no delimiter at all.
    if (this.textBuffer.length > 32) {
      this._consumeLine(this.textBuffer);
      this.textBuffer = '';
    }
  }

  _consumeLine(line) {
    const parsed = this._parseWeight(line);
    if (!Number.isFinite(parsed)) return;
    const nowMs = Date.now();

    if (this._looksLikePartialFrame(parsed, line)) {
      return;
    }

    // Ignore short-lived zero glitches while vehicle is still on bridge.
    if (parsed === 0 && (this.latestWeight > 0 || this.latestStableWeight > 0)) {
      if (!this.zeroCandidateSince) {
        this.zeroCandidateSince = nowMs;
        return;
      }
      if (nowMs - this.zeroCandidateSince < this.config.zeroHoldMs) {
        return;
      }
    } else {
      this.zeroCandidateSince = null;
    }

    this.latestRawWeight = parsed;
    this.latestWeight = parsed;
    this.buffer.push(parsed);
    while (this.buffer.length > this.config.stableWindowSize) {
      this.buffer.shift();
    }

    this.isStable = this._computeStable();
    if (this.isStable) {
      this.latestStableWeight = parsed;
    }

    this._emitWeightChanged(parsed);
    logger.logDevice('weighbridge', 'info', 'Weight parsed', {
      port: this.config.port,
      weight: parsed,
      isStable: this.isStable,
      raw: String(line).replace(/\0/g, ' ').trim().slice(0, 80),
    });
  }

  _computeStable() {
    if (this.buffer.length < this.config.stableWindowSize) return false;
    const min = Math.min(...this.buffer);
    const max = Math.max(...this.buffer);
    return max - min <= this.config.stableToleranceKg;
  }

  _emitWeightChanged(weight) {
    const weightChanged = this.lastEmittedWeight !== weight;
    const stableBecameTrue = this.isStable && !this.lastEmittedIsStable;

    if (!weightChanged && !stableBecameTrue) {
      return;
    }

    // Drop brief zero dropouts while a load is still on the bridge.
    if (
      weightChanged &&
      weight === 0 &&
      this.lastEmittedWeight > 0 &&
      this.zeroCandidateSince != null &&
      Date.now() - this.zeroCandidateSince < this.config.zeroHoldMs
    ) {
      return;
    }

    if (weightChanged) {
      this.lastEmittedWeight = weight;
    }
    this.lastEmittedIsStable = this.isStable;

    for (const handler of this.weightChangedHandlers) {
      try {
        handler({
          weight,
          stableWeight: this.latestStableWeight,
          isStable: this.isStable,
          timestamp: ts.now(),
        });
      } catch (err) {
        logger.warn('WeightBridgeService listener failed', { message: err.message });
      }
    }
  }

  _parseWeight(input) {
    if (!input) return null;

    let text = String(input).replace(/\0/g, ' ');
    text = text.replace(/\x02/g, '').replace(/\x03/g, '').trim();
    if (!text) return null;

    const kgMatch = text.match(/(-?\d+(?:\.\d+)?)\s*(?:kg|kgs)\b/i);
    if (kgMatch) {
      const kgValue = Number(kgMatch[1]);
      if (Number.isFinite(kgValue)) return Math.round(kgValue);
    }

    // STX/ETX style: optional stability flag then digits (e.g. "S 012345" or "N 012345")
    const stxStyle = text.match(/^[SNEB]\s*(-?\d+(?:[.,]\d+)?)/i);
    if (stxStyle) {
      const normalized = stxStyle[1].replace(',', '.');
      const kgValue = Number(normalized);
      if (Number.isFinite(kgValue)) return Math.round(kgValue);
    }

    // Six-digit weighbridge frames (e.g. "012345" or " 12345 ")
    const sixDigit = text.match(/(^|[^\d])(\d{4,6})([^\d]|$)/);
    if (sixDigit) {
      const kgValue = Number(sixDigit[2]);
      if (Number.isFinite(kgValue)) return Math.round(kgValue);
    }

    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || !matches.length) return null;

    const value = Number(matches[matches.length - 1]);
    if (!Number.isFinite(value)) return null;
    return Math.round(value);
  }

  _looksLikePartialFrame(parsed, rawLine) {
    const text = String(rawLine || '').replace(/\0/g, ' ').trim();
    if (!text) return false;
    if (/kg|kgs/i.test(text)) return false;

    // Common glitch: receive "6" between full "60" frames.
    if (
      Number.isFinite(this.latestWeight) &&
      this.latestWeight >= 10 &&
      parsed > 0 &&
      parsed * 10 === this.latestWeight
    ) {
      return true;
    }

    return false;
  }
}

const PROBE_BAUD_CONFIGS = [
  { baudRate: 2400, dataBits: 7, parity: 'none', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'even', stopBits: 1 },
  { baudRate: 2400, dataBits: 7, parity: 'odd', stopBits: 1 },
  { baudRate: 2400, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
  { baudRate: 1200, dataBits: 8, parity: 'none', stopBits: 1 },
];

function probeSerialPort(path, serialConfig, durationMs = 3000) {
  return new Promise((resolve) => {
    const port = new SerialPort({
      path,
      baudRate: serialConfig.baudRate,
      dataBits: serialConfig.dataBits,
      parity: serialConfig.parity,
      stopBits: serialConfig.stopBits,
      autoOpen: false,
      hupcl: false,
      rtscts: false,
    });

    let bytes = 0;
    let sampleHex = '';
    let sampleText = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const close = () => resolve(result);
      if (port.isOpen) port.close(close);
      else close();
    };

    const timer = setTimeout(() => {
      finish({
        path,
        ...serialConfig,
        bytes,
        sampleHex,
        sampleText,
        ok: bytes > 0,
      });
    }, durationMs);

    port.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buf.length;
      if (sampleHex.length < 120) {
        sampleHex += buf.toString('hex').toUpperCase();
      }
      if (sampleText.length < 80) {
        sampleText += buf
          .toString('utf8')
          .replace(/[^\x20-\x7E]/g, '.');
      }
    });

    port.open((err) => {
      if (err) {
        finish({
          path,
          ...serialConfig,
          bytes: 0,
          ok: false,
          error: err.message,
        });
      }
    });
  });
}

async function probeAvailablePorts(durationMs = 2500, options = {}) {
  const skipPorts = new Set(
    (options.skipPorts || []).map((p) => String(p).toUpperCase()),
  );
  try {
    const SettingsService = require('./SettingsService');
    const displayPort = SettingsService.get('EXTERNAL_DISPLAY_COM_PORT');
    if (displayPort) skipPorts.add(String(displayPort).toUpperCase());
  } catch (_e) {
    /* optional */
  }

  const listed = await SerialPort.list();
  const paths = listed
    .map((p) => p.path)
    .filter((p) => p && !skipPorts.has(String(p).toUpperCase()));
  const results = [];

  for (const path of paths) {
    for (const cfg of PROBE_BAUD_CONFIGS) {
      // eslint-disable-next-line no-await-in-loop
      const row = await probeSerialPort(path, cfg, durationMs);
      results.push(row);
      if (row.bytes > 0) break;
    }
  }

  return { ports: listed, probes: results, skippedPorts: [...skipPorts] };
}

module.exports = WeightBridgeService;
module.exports.probeAvailablePorts = probeAvailablePorts;
