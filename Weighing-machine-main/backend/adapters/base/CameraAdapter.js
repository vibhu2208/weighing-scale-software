'use strict';

class CameraAdapter {
  constructor(config) {
    this.config = config;
    this.connected = false;
    this.onErrorCallback = null;
    this.onReconnectCallback = null;
  }

  async connect() {
    throw new Error('Must implement');
  }

  async disconnect() {
    throw new Error('Must implement');
  }

  async captureImage(transactionId) {
    throw new Error('Must implement');
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
      type: 'camera',
      connected: this.connected,
      mode: this.constructor.name,
    };
  }
}

module.exports = CameraAdapter;
