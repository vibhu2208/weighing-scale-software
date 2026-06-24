'use strict';

class WeighbridgeAdapter {
  constructor(config) {
    this.config = config;
    this.connected = false;
    this.currentWeight = 0;
    this.isStable = false;
    this.onWeightUpdateCallback = null;
    this.onStableCallback = null;
    this.onWeightZeroCallback = null;
    this.onErrorCallback = null;
    this.onReconnectCallback = null;
  }

  async connect() {
    throw new Error('Must implement');
  }

  async disconnect() {
    throw new Error('Must implement');
  }

  async getWeight() {
    throw new Error('Must implement');
  }

  onWeightUpdate(callback) {
    this.onWeightUpdateCallback = callback;
  }

  onStableWeight(callback) {
    this.onStableCallback = callback;
  }

  onWeightZero(callback) {
    this.onWeightZeroCallback = callback;
  }

  onError(callback) {
    this.onErrorCallback = callback;
  }

  onReconnect(callback) {
    this.onReconnectCallback = callback;
  }

  isConnected() {
    return this.connected;
  }

  getStatus() {
    return {
      type: 'weighbridge',
      connected: this.connected,
      currentWeight: this.currentWeight,
      isStable: this.isStable,
      mode: this.constructor.name,
    };
  }
}

module.exports = WeighbridgeAdapter;
