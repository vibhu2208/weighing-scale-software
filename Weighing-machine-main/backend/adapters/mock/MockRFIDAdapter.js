'use strict';

const RFIDAdapter = require('../base/RFIDAdapter');
const logger = require('../../utils/logger');
const ts = require('../../utils/timestamp');

const DEMO_TAGS = [
  'E280117000000208AABBCC01',
  'E280117000000208AABBCC02',
  'E280117000000208AABBCC03',
  'E280117000000208AABBCC04',
  'E280117000000208AABBCC05',
  'E200470678E064222F03010C',
];

class MockRFIDAdapter extends RFIDAdapter {
  constructor(config = {}) {
    super(config);
    this._scanTimer = null;
    this._scanning = false;
    this._antennaPower =
      Number(config.antennaPower) > 0 ? Number(config.antennaPower) : 20;
  }

  async getPowerInfo() {
    return {
      minPower: 5,
      maxPower: 30,
      currentPower: this._antennaPower,
      connected: this.connected,
      mock: true,
    };
  }

  async setAntennaPower(powerDb) {
    const power = Math.round(Number(powerDb));
    if (!Number.isFinite(power)) {
      throw new Error('Invalid antenna power value');
    }
    this._antennaPower = power;
    logger.info('Mock RFID antenna power set', {
      type: 'device',
      device: 'rfid',
      power,
    });
    return { ok: true, saved: true, applied: false, power, mock: true };
  }

  getStatus() {
    return {
      ...super.getStatus(),
      scanning: this._scanning,
    };
  }

  async connect() {
    this.connected = true;
    this._scanning = false;
    logger.info('Mock RFID connected', { type: 'device', device: 'rfid' });
    return true;
  }

  async disconnect() {
    if (this._scanTimer) {
      clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    this.connected = false;
    this._scanning = false;
    return true;
  }

  async startScanning() {
    if (!this.connected) {
      throw new Error('Mock RFID is not connected');
    }
    this._scanning = true;
    return true;
  }

  async stopScanning() {
    if (this._scanTimer) {
      clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    this._scanning = false;
    return true;
  }

  simulateScan(tagOverride, options = {}) {
    if (!this.connected) {
      logger.info('Mock RFID simulateScan skipped — not connected', {
        type: 'device',
        device: 'rfid',
      });
      return;
    }

    const tag =
      tagOverride ||
      DEMO_TAGS[Math.floor(Math.random() * DEMO_TAGS.length)];

    if (this._scanTimer) clearTimeout(this._scanTimer);

    this._scanTimer = setTimeout(() => {
      this._scanTimer = null;
      const rssi =
        options.rssi != null
          ? Number(options.rssi)
          : -30 - Math.floor(Math.random() * 40);
      const payload = {
        tag,
        rssi: Number.isFinite(rssi) ? rssi : null,
        timestamp: ts.now(),
      };
      if (typeof this.onTagDetectedCallback === 'function') {
        this.onTagDetectedCallback(payload);
      }
    }, 200);
  }

  simulateMultiScan(tagEntries) {
    if (!this.connected) {
      logger.info('Mock RFID simulateMultiScan skipped — not connected', {
        type: 'device',
        device: 'rfid',
      });
      return;
    }

    const entries = Array.isArray(tagEntries) && tagEntries.length > 0
      ? tagEntries
      : [
          { tag: DEMO_TAGS[0], rssi: -55 },
          { tag: DEMO_TAGS[1], rssi: -42 },
          { tag: DEMO_TAGS[2], rssi: -68 },
        ];

    entries.forEach((entry, index) => {
      setTimeout(() => {
        const tag = entry.tag || DEMO_TAGS[index % DEMO_TAGS.length];
        const rssi = entry.rssi != null ? Number(entry.rssi) : -40 - index * 8;
        const payload = {
          tag,
          rssi: Number.isFinite(rssi) ? rssi : null,
          timestamp: ts.now(),
        };
        if (typeof this.onTagDetectedCallback === 'function') {
          this.onTagDetectedCallback(payload);
        }
      }, 50 + index * 120);
    });
  }

  simulateDisconnect() {
    if (!this.connected) {
      logger.info('Mock RFID already disconnected', { type: 'device', device: 'rfid' });
      return;
    }
    this.connected = false;
    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(new Error('Mock RFID disconnected'));
    }
  }

  async simulateReconnect() {
    if (this.connected) {
      logger.info('Mock RFID already connected', { type: 'device', device: 'rfid' });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    this.connected = true;
    logger.info('Mock RFID reconnected', { type: 'device', device: 'rfid' });
    if (typeof this.onReconnectCallback === 'function') {
      this.onReconnectCallback();
    }
  }
}

module.exports = MockRFIDAdapter;
