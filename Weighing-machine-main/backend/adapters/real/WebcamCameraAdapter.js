'use strict';

const CameraAdapter = require('../base/CameraAdapter');
const logger = require('../../utils/logger');

/**
 * Laptop / USB webcam mode — live preview and capture run in the Electron renderer
 * via getUserMedia. Main-process workflow captureImage() is not used here.
 */
class WebcamCameraAdapter extends CameraAdapter {
  async connect() {
    this.connected = true;
    logger.info('Webcam camera mode enabled (renderer preview)', {
      type: 'device',
      device: 'camera',
    });
    return true;
  }

  async disconnect() {
    this.connected = false;
    return true;
  }

  async captureImage() {
    throw new Error(
      'Webcam capture is handled in the Weighment screen — use the Save button',
    );
  }
}

module.exports = WebcamCameraAdapter;
