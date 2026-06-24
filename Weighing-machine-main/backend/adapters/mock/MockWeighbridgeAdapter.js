'use strict';

const WeighbridgeAdapter = require('../base/WeighbridgeAdapter');
const logger = require('../../utils/logger');
const ts = require('../../utils/timestamp');

const BUFFER_SIZE = 5;
const STABILITY_TOLERANCE_KG = 30;
const NOISE_KG = 50;
const POLL_MS = 500;
const DEBOUNCE_MS = 100;

class MockWeighbridgeAdapter extends WeighbridgeAdapter {
  constructor(config = {}) {
    super(config);
    this.simulatedWeight = null;
    this._buffer = [];
    this._pollTimer = null;
    this._debounceTimer = null;
    this._stableFired = false;
    this._wasNonZero = false;
    this._lastEmittedWeight = null;
    this._lastEmittedStable = null;
  }

  async connect() {
    this.connected = true;
    this._startPolling();
    logger.info('Mock Weighbridge connected', {
      type: 'device',
      device: 'weighbridge',
    });
    return true;
  }

  async disconnect() {
    this._stopPolling();
    this.connected = false;
    return true;
  }

  async getWeight() {
    return {
      weight: this.currentWeight,
      isStable: this.isStable,
      timestamp: ts.now(),
    };
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._tick(), POLL_MS);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _tick() {
    if (!this.connected) return;

    let weight = 0;
    if (this.simulatedWeight !== null && this.simulatedWeight > 0) {
      const noise = (Math.random() - 0.5) * 2 * NOISE_KG;
      weight = Math.max(0, Math.round(this.simulatedWeight + noise));
    }

    this.currentWeight = weight;
    this._buffer.push(weight);
    if (this._buffer.length > BUFFER_SIZE) {
      this._buffer.shift();
    }

    const stable = this._computeStability();
    const wasStable = this.isStable;
    this.isStable = stable;

    const payload = {
      weight,
      isStable: stable,
      timestamp: ts.now(),
    };

    const weightChanged = this._lastEmittedWeight !== weight;
    const stableChanged = this._lastEmittedStable !== stable;
    if (weightChanged || stableChanged) {
      this._lastEmittedWeight = weight;
      this._lastEmittedStable = stable;
      if (typeof this.onWeightUpdateCallback === 'function') {
        this.onWeightUpdateCallback(payload);
      }
    }

    if (stable && !this._stableFired) {
      this._stableFired = true;
      if (typeof this.onStableCallback === 'function') {
        this.onStableCallback({ weight, timestamp: ts.now() });
      }
    }

    if (!stable) {
      this._stableFired = false;
    }

    if (weight > 0) {
      this._wasNonZero = true;
    }

    if (weight === 0 && this._wasNonZero && stable) {
      this._wasNonZero = false;
      if (typeof this.onWeightZeroCallback === 'function') {
        this.onWeightZeroCallback({ weight: 0, timestamp: ts.now() });
      }
    }
  }

  _computeStability() {
    if (this._buffer.length < BUFFER_SIZE) return false;
    const min = Math.min(...this._buffer);
    const max = Math.max(...this._buffer);
    return max - min < STABILITY_TOLERANCE_KG;
  }

  setSimulatedWeight(kg) {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.simulatedWeight = Number(kg);
      this._stableFired = false;
      if (this.simulatedWeight === 0) {
        this._buffer = [];
      }
    }, DEBOUNCE_MS);
  }

  clearWeight() {
    this.simulatedWeight = 0;
    this.currentWeight = 0;
    this.isStable = false;
    this._buffer = [];
    this._stableFired = false;
    this._wasNonZero = false;
  }

  simulateDisconnect() {
    if (!this.connected) {
      logger.info('Mock Weighbridge already disconnected', {
        type: 'device',
        device: 'weighbridge',
      });
      return;
    }
    this._stopPolling();
    this.connected = false;
    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(new Error('Mock Weighbridge disconnected'));
    }
  }

  async simulateReconnect() {
    if (this.connected) {
      logger.info('Mock Weighbridge already connected', {
        type: 'device',
        device: 'weighbridge',
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    this.connected = true;
    this._startPolling();
    logger.info('Mock Weighbridge reconnected', {
      type: 'device',
      device: 'weighbridge',
    });
    if (typeof this.onReconnectCallback === 'function') {
      this.onReconnectCallback();
    }
  }
}

module.exports = MockWeighbridgeAdapter;
