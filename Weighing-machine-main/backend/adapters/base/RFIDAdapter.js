'use strict';

class RFIDAdapter {
  constructor(config) {
    this.config = config;
    this.connected = false;
    this.onTagDetectedCallback = null;
    this.onErrorCallback = null;
    this.onReconnectCallback = null;
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  onTagDetected(callback) {
    this.onTagDetectedCallback = callback;
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
      type: 'rfid',
      connected: this.connected,
      config: this.config,
      mode: this.constructor.name,
      scanning: false,
    };
  }

  async startScanning() {
    /* no-op — override in subclass */
  }

  async stopScanning() {
    /* no-op — override in subclass */
  }
}

module.exports = RFIDAdapter;
