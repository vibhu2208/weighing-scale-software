'use strict';

const fs = require('fs');
const path = require('path');
const CameraAdapter = require('../base/CameraAdapter');
const logger = require('../../utils/logger');
const { getImagePath, PATHS, ensureDir } = require('../../utils/fileStorage');

const SAMPLE_DIR = path.join(PATHS.ROOT, 'assets', 'sample-images');

/** Minimal valid 1×1 grey JPEG. */
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==',
  'base64',
);

function ensureSampleImages() {
  ensureDir(SAMPLE_DIR);
  const names = ['truck1.jpg', 'truck2.jpg', 'truck3.jpg'];
  for (const name of names) {
    const dest = path.join(SAMPLE_DIR, name);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, PLACEHOLDER_JPEG);
    }
  }
  return names.map((n) => path.join(SAMPLE_DIR, n));
}

class MockCameraAdapter extends CameraAdapter {
  constructor(config = {}) {
    super(config);
    this._samplePaths = [];
  }

  async connect() {
    this._samplePaths = ensureSampleImages();
    this.connected = true;
    logger.info('Mock Camera connected', { type: 'device', device: 'camera' });
    return true;
  }

  async disconnect() {
    this.connected = false;
    return true;
  }

  async captureImage(transactionId) {
    if (!this.connected) {
      throw new Error('Mock Camera is not connected');
    }

    const txnId = transactionId || `sim-${Date.now()}`;
    const destPath = getImagePath(txnId);

    await new Promise((r) => setTimeout(r, 500));

    try {
      const samples =
        this._samplePaths.length > 0
          ? this._samplePaths
          : ensureSampleImages();
      const src =
        samples[Math.floor(Math.random() * samples.length)] || samples[0];
      fs.copyFileSync(src, destPath);
      logger.info('Mock Camera capture saved', {
        type: 'device',
        device: 'camera',
        path: destPath,
      });
      return destPath;
    } catch (err) {
      logger.warn('Mock Camera capture failed — continuing without image', {
        message: err.message,
      });
      try {
        fs.writeFileSync(destPath, PLACEHOLDER_JPEG);
        return destPath;
      } catch (writeErr) {
        logger.warn('Mock Camera placeholder write failed', {
          message: writeErr.message,
        });
        return null;
      }
    }
  }

  simulateDisconnect() {
    if (!this.connected) {
      logger.info('Mock Camera already disconnected', {
        type: 'device',
        device: 'camera',
      });
      return;
    }
    this.connected = false;
    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(new Error('Mock Camera disconnected'));
    }
  }

  async simulateReconnect() {
    if (this.connected) {
      logger.info('Mock Camera already connected', {
        type: 'device',
        device: 'camera',
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    this._samplePaths = ensureSampleImages();
    this.connected = true;
    logger.info('Mock Camera reconnected', { type: 'device', device: 'camera' });
    if (typeof this.onReconnectCallback === 'function') {
      this.onReconnectCallback();
    }
  }
}

module.exports = MockCameraAdapter;
