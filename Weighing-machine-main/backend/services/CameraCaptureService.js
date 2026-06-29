'use strict';

const logger = require('../utils/logger');
const { captureFrameFromCamera, isJpegBuffer } = require('../utils/cameraFrameCapture');
const { isBlankJpegBuffer } = require('../utils/blankFrameDetect');
const { saveCameraImage } = require('../utils/fileStorage');
const { parseCameraList } = require('../utils/cameraUrls');
const {
  getCaptureRetryCount,
  getCaptureRetryDelayMs,
  getFrameMaxAgeMs,
  useOnDemandCameraPreview,
} = require('../utils/cameraCaptureConfig');
const DeviceMonitorService = require('./DeviceMonitorService');

const CAPTURE_TIMEOUT_MS = parseInt(process.env.CAMERA_CAPTURE_TIMEOUT_MS || '10000', 10);
const CAPTURE_RETRY_COUNT = getCaptureRetryCount();
const CAPTURE_RETRY_DELAY_MS = getCaptureRetryDelayMs();
const MIN_JPEG_BYTES = parseInt(process.env.CAMERA_MIN_JPEG_BYTES || '2048', 10);

function isValidSnapshotBuffer(buffer) {
  return (
    isJpegBuffer(buffer) &&
    Buffer.isBuffer(buffer) &&
    buffer.length >= MIN_JPEG_BYTES &&
    !isBlankJpegBuffer(buffer)
  );
}

function getCamerasFromConfig(config = {}) {
  return parseCameraList(config);
}

async function pauseLivePreviews() {
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  if (MultiCameraPreviewService.isStarted()) {
    await MultiCameraPreviewService.pauseAndDrain();
    return { multi: true };
  }

  const { camera } = DeviceMonitorService.getAdapters();
  if (camera && typeof camera.pausePreview === 'function') {
    await camera.pausePreview();
    return { single: true, camera };
  }

  return null;
}

function resumeLivePreviews(previewState) {
  if (!previewState) return;

  if (previewState.multi) {
    const MultiCameraPreviewService = require('./MultiCameraPreviewService');
    MultiCameraPreviewService.resume();
    return;
  }

  if (previewState.single && previewState.camera?.resumePreview) {
    previewState.camera.resumePreview();
  }
}

async function captureCameraSnapshotOnce(
  camera,
  transactionId,
  passKey = 'capture',
  options = {},
) {
  const timeoutMs = options.timeoutMs || CAPTURE_TIMEOUT_MS;
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');

  const saveFromBuffer = (buffer, source) => {
    if (!isValidSnapshotBuffer(buffer)) {
      const reason = isBlankJpegBuffer(buffer) ? 'blank frame' : 'invalid frame';
      throw new Error(`${reason} from ${camera.label} (${buffer?.length || 0} bytes)`);
    }
    const filePath = saveCameraImage(buffer, transactionId, camera.id, passKey, options);
    logger.info(`Camera snapshot saved${source ? ` (${source})` : ''}`, {
      camera: camera.label,
      path: filePath,
      bytes: buffer.length,
      transactionId,
      passKey,
    });
    return { id: camera.id, label: camera.label, path: filePath };
  };

  const previewActive = MultiCameraPreviewService.isStarted();
  const allowPreviewCache = previewActive && !useOnDemandCameraPreview();
  const frameAt = MultiCameraPreviewService.getLastFrameTimestamp(camera.id);
  const cacheAgeMs = frameAt ? Date.now() - frameAt : null;
  const frameQuality = MultiCameraPreviewService.getLastFrameQuality(camera.id);
  const cached = MultiCameraPreviewService.getLastFrameBuffer(camera.id);
  if (
    allowPreviewCache &&
    cached &&
    isValidSnapshotBuffer(cached) &&
    cacheAgeMs != null &&
    cacheAgeMs <= getFrameMaxAgeMs() &&
    frameQuality === 'good'
  ) {
    try {
      return saveFromBuffer(cached, 'preview cache');
    } catch (err) {
      logger.warn('Preview cache snapshot save failed', {
        camera: camera.label,
        message: err.message,
        transactionId,
      });
    }
  }

  const buffer = await captureFrameFromCamera(camera, timeoutMs);
  return saveFromBuffer(buffer, 'live capture');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureCameraSnapshot(
  camera,
  transactionId,
  passKey = 'capture',
  options = {},
) {
  const maxAttempts = options.maxRetries || CAPTURE_RETRY_COUNT;
  let lastError = 'Capture failed after retries';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const snap = await captureCameraSnapshotOnce(
        camera,
        transactionId,
        passKey,
        options,
      );
      if (snap) return { snapshot: snap, error: null };
    } catch (err) {
      lastError = err.message || lastError;
      logger.warn('Camera snapshot attempt failed', {
        camera: camera.label,
        attempt,
        maxAttempts,
        message: err.message,
        transactionId,
      });
      if (attempt >= maxAttempts) {
        logger.warn('Camera snapshot failed', {
          camera: camera.label,
          message: err.message,
          transactionId,
        });
        return { snapshot: null, error: lastError };
      }
      await delay(CAPTURE_RETRY_DELAY_MS * attempt);
    }
  }
  return { snapshot: null, error: lastError };
}

async function ensureCameraPreviewReady(camera, maxWaitMs = 5000) {
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  if (!MultiCameraPreviewService.isStarted()) return false;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = MultiCameraPreviewService.getPreviewStatus({ requiredCount: 1 });
    const camStatus = status.cameras.find((item) => item.id === camera.id);
    if (camStatus?.usable) return true;
    await delay(200);
  }
  return false;
}

/**
 * Capture snapshots from every configured camera for a transaction.
 * @returns {Promise<Array<{ id: string, label: string, path: string }>>}
 */
async function waitForPreviewWarmup(cameras, maxWaitMs = 6000) {
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  if (!MultiCameraPreviewService.isStarted()) return;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = MultiCameraPreviewService.getPreviewStatus({
      requiredCount: cameras.length,
    });
    if (status.allReady) return;
    await delay(200);
  }

  const status = MultiCameraPreviewService.getPreviewStatus({
    requiredCount: cameras.length,
  });
  logger.warn('Camera preview warmup timed out before capture', {
    readyCount: status.readyCount,
    requiredCount: status.requiredCount,
    transactionId: null,
  });
}

async function captureAllSnapshots(transactionId, passKey = 'capture', saveOptions = {}) {
  if (!transactionId) {
    throw new Error('transactionId is required for camera capture');
  }

  const config = DeviceMonitorService.getCameraConfig();
  const cameras = getCamerasFromConfig(config).filter((c) => !c.disabled);
  if (!cameras.length) {
    return { snapshots: [], failures: [] };
  }

  const captureOpts = {
    ...saveOptions,
    timeoutMs: CAPTURE_TIMEOUT_MS,
    maxRetries: CAPTURE_RETRY_COUNT,
  };

  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  const saveOnlyCapture = useOnDemandCameraPreview() || !MultiCameraPreviewService.isStarted();

  if (!saveOnlyCapture) {
    await waitForPreviewWarmup(cameras);
  } else {
    logger.info('Save-only camera capture — fresh RTSP snapshots', {
      transactionId,
      passKey,
      cameras: cameras.length,
    });
  }

  const previewState = saveOnlyCapture ? null : await pauseLivePreviews();
  try {
    const snapshots = [];
    const failures = [];
    for (let index = 0; index < cameras.length; index += 1) {
      const camera = cameras[index];
      const isLastCamera = index === cameras.length - 1;

      if (!saveOnlyCapture) {
        await ensureCameraPreviewReady(camera, isLastCamera ? 10000 : 5000);
      } else if (index > 0) {
        await delay(500);
      }

      if (index > 0 && !saveOnlyCapture) {
        await delay(isLastCamera ? 600 : 350);
      }

      const { snapshot, error } = await captureCameraSnapshot(camera, transactionId, passKey, {
        ...captureOpts,
        timeoutMs: isLastCamera ? CAPTURE_TIMEOUT_MS + 15000 : CAPTURE_TIMEOUT_MS,
        maxRetries: CAPTURE_RETRY_COUNT,
      });
      if (snapshot) {
        snapshots.push(snapshot);
      } else {
        failures.push({
          id: camera.id,
          label: camera.label,
          error: error || 'Capture failed',
        });
      }
    }
    return { snapshots, failures };
  } finally {
    if (previewState) {
      resumeLivePreviews(previewState);
    }
  }
}

async function captureSingleSnapshot(transactionId, cameraId, passKey = 'capture', saveOptions = {}) {
  if (!transactionId) {
    throw new Error('transactionId is required for camera capture');
  }

  const config = DeviceMonitorService.getCameraConfig();
  const cameras = getCamerasFromConfig(config);
  const camera = cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Unknown camera: ${cameraId}`);
  }

  const { snapshot, error } = await captureCameraSnapshot(camera, transactionId, passKey, {
    ...saveOptions,
    timeoutMs: CAPTURE_TIMEOUT_MS + 15000,
    maxRetries: CAPTURE_RETRY_COUNT,
  });

  if (!snapshot) {
    throw new Error(error || `Failed to capture photo from ${camera.label}`);
  }

  return snapshot;
}

module.exports = {
  captureAllSnapshots,
  captureSingleSnapshot,
  getCamerasFromConfig,
};
