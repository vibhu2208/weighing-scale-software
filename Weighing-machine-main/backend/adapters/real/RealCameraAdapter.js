'use strict';

const fs = require('fs');
const CameraAdapter = require('../base/CameraAdapter');
const logger = require('../../utils/logger');
const { captureRtspFrame } = require('../../utils/ffmpeg');
const { getImagePath } = require('../../utils/fileStorage');

class RealCameraAdapter extends CameraAdapter {
  constructor(config = {}) {
    super(config);
    this.rtspUrl = config.rtspUrl || '';
    this.rtspUrlAlternates = config.rtspUrlAlternates || '';
    this.httpSnapshotUrl = config.httpSnapshotUrl || '';
    this._previewActive = false;
    this._previewPaused = false;
    this._previewTimer = null;
    this._previewCallback = null;
    this._previewInFlight = false;
    this._previewIntervalMs = 2000;
  }

  _captureOptions(extra = {}) {
    return {
      alternates: this.rtspUrlAlternates,
      httpSnapshotUrl: this.httpSnapshotUrl,
      ...extra,
    };
  }

  getRtspUrl() {
    const url = String(this.rtspUrl || '').trim();
    if (!url) {
      throw new Error('CAMERA_RTSP_URL is not configured — set it in Settings or .env');
    }
    if (!url.startsWith('rtsp://')) {
      throw new Error('CAMERA_RTSP_URL must start with rtsp://');
    }
    return url;
  }

  async connect() {
    await captureRtspFrame(
      this.getRtspUrl(),
      this._captureOptions({ timeoutMs: 25000 }),
    );
    this.connected = true;
    logger.info('RTSP camera connected', {
      type: 'device',
      device: 'camera',
      url: this.getRtspUrl().replace(/:[^:@/]+@/, ':***@'),
    });
    return true;
  }

  async disconnect() {
    this.stopPreview();
    this.connected = false;
    return true;
  }

  async captureImage(transactionId) {
    if (!this.connected) {
      throw new Error('Camera is not connected');
    }
    const txnId = transactionId || `cap-${Date.now()}`;
    await this.pausePreview();
    try {
      const buffer = await captureRtspFrame(
        this.getRtspUrl(),
        this._captureOptions({ timeoutMs: 20000 }),
      );
      const destPath = getImagePath(txnId);
      fs.writeFileSync(destPath, buffer);
      logger.info('RTSP camera capture saved', {
        type: 'device',
        device: 'camera',
        path: destPath,
      });
      return destPath;
    } finally {
      this.resumePreview();
    }
  }

  startPreview(onFrame, intervalMs) {
    if (typeof onFrame !== 'function') return;
    this._previewCallback = onFrame;
    if (Number.isFinite(intervalMs) && intervalMs >= 300) {
      this._previewIntervalMs = intervalMs;
    }
    if (this._previewActive) return;
    this._previewActive = true;
    this._schedulePreviewTick(0);
  }

  stopPreview() {
    this._previewActive = false;
    this._previewPaused = false;
    this._previewCallback = null;
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
  }

  async pausePreview() {
    this._previewPaused = true;
    const deadline = Date.now() + 8000;
    while (this._previewInFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  resumePreview() {
    if (!this._previewActive || !this._previewCallback) return;
    this._previewPaused = false;
    if (!this._previewTimer && !this._previewInFlight) {
      this._schedulePreviewTick(100);
    }
  }

  _schedulePreviewTick(delayMs) {
    if (!this._previewActive) return;
    this._previewTimer = setTimeout(() => this._previewTick(), delayMs);
    if (this._previewTimer.unref) this._previewTimer.unref();
  }

  async _previewTick() {
    if (!this._previewActive || !this._previewCallback) return;

    if (this._previewPaused) {
      this._schedulePreviewTick(200);
      return;
    }

    if (!this._previewInFlight && this.connected) {
      this._previewInFlight = true;
      try {
        const buffer = await captureRtspFrame(
          this.getRtspUrl(),
          this._captureOptions({ timeoutMs: 15000 }),
        );
        this._previewCallback(buffer.toString('base64'));
      } catch (err) {
        logger.debug('RTSP preview frame failed', { message: err.message });
      } finally {
        this._previewInFlight = false;
      }
    }

    this._schedulePreviewTick(this._previewIntervalMs);
  }
}

module.exports = RealCameraAdapter;
