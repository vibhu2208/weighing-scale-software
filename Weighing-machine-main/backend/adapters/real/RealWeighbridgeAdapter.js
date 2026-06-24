'use strict';

const WeighbridgeAdapter = require('../base/WeighbridgeAdapter');
const logger = require('../../utils/logger');
const ts = require('../../utils/timestamp');
const WeightBridgeService = require('../../services/WeightBridgeService');

class RealWeighbridgeAdapter extends WeighbridgeAdapter {
  constructor(config = {}) {
    super(config);
    this.bridgeService = new WeightBridgeService({
      port: config.comPort || 'COM3',
      baudRate: Number(config.baudRate || 2400),
      dataBits: Number(config.dataBits || 7),
      parity: String(config.parity || 'none'),
      stopBits: Number(config.stopBits || 1),
      autoReconnectMs: Number(config.autoReconnectMs || 2000),
    });
    this._unsubscribeWeight = null;
  }

  _bindWeightListener() {
    if (this._unsubscribeWeight) {
      this._unsubscribeWeight();
      this._unsubscribeWeight = null;
    }
    this._unsubscribeWeight = this.bridgeService.onWeightChanged((payload) => {
      this.currentWeight = payload.weight;
      this.isStable = !!payload.isStable;

      if (typeof this.onWeightUpdateCallback === 'function') {
        this.onWeightUpdateCallback({
          weight: payload.weight,
          isStable: !!payload.isStable,
          timestamp: payload.timestamp || ts.now(),
        });
      }

      if (payload.isStable && typeof this.onStableCallback === 'function') {
        this.onStableCallback({
          weight: payload.stableWeight ?? payload.weight,
          timestamp: payload.timestamp || ts.now(),
        });
      }

      if (payload.weight === 0 && payload.isStable && typeof this.onWeightZeroCallback === 'function') {
        this.onWeightZeroCallback({
          weight: 0,
          timestamp: payload.timestamp || ts.now(),
        });
      }
    });
  }

  async connect() {
    if (this.connected) return true;

    this._bindWeightListener();
    await this.bridgeService.start();
    this.connected = true;

    logger.info('RealWeighbridgeAdapter connected to serial weighbridge', {
      type: 'device',
      device: 'weighbridge',
      port: this.config.comPort || 'COM3',
    });
    return true;
  }

  async disconnect() {
    if (this._unsubscribeWeight) {
      this._unsubscribeWeight();
      this._unsubscribeWeight = null;
    }
    await this.bridgeService.stop();
    this.connected = false;
    this.currentWeight = 0;
    this.isStable = false;
  }

  async getWeight() {
    const snapshot = this.bridgeService.getSnapshot();
    this.connected = snapshot.connected;
    this.currentWeight = snapshot.weight;
    this.isStable = snapshot.isStable;
    return {
      weight: snapshot.weight,
      isStable: snapshot.isStable,
      timestamp: snapshot.timestamp,
    };
  }

  getCurrentWeight() {
    return this.bridgeService.getCurrentWeight();
  }

  onWeightChanged(callback) {
    return this.bridgeService.onWeightChanged(callback);
  }

  getStatus() {
    const snapshot = this.bridgeService.getSnapshot();
    this.connected = snapshot.connected;
    this.currentWeight = snapshot.weight;
    this.isStable = snapshot.isStable;
    return {
      ...super.getStatus(),
      currentWeight: snapshot.weight,
      stableWeight: this.bridgeService.getCurrentWeight(),
      port: this.config.comPort || 'COM4',
      diagnostics: this.bridgeService.getDiagnostics(),
    };
  }

  getDiagnostics() {
    return this.bridgeService.getDiagnostics();
  }

  scanBaudRates(listenMs) {
    return this.bridgeService.scanBaudRates(listenMs);
  }
}

module.exports = RealWeighbridgeAdapter;
