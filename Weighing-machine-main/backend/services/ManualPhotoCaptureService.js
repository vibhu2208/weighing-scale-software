'use strict';

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const CameraCaptureService = require('./CameraCaptureService');
const { saveCameraImage } = require('../utils/fileStorage');
const { getRequiredPhotoCount, getMinPhotoCountToSave } = require('../utils/cameraCaptureConfig');
const { countEnabledCameras } = require('../utils/cameraUrls');
const DeviceMonitorService = require('./DeviceMonitorService');
const { isBlankJpegBuffer } = require('../utils/blankFrameDetect');
const logger = require('../utils/logger');

function normalizeSnapshots(snapshots) {
  return (snapshots || []).map((s) => ({
    id: s.id,
    label: s.label,
    path: s.path,
  }));
}

function validateSnapshots(
  snapshots,
  label = 'capture',
  { checkBlank = true, requireAllSlots = false } = {},
) {
  const minCount = getMinPhotoCountToSave();
  const configured = getRequiredPhotoCount();
  const list = normalizeSnapshots(snapshots);

  if (list.length < minCount) {
    throw new Error(
      `At least ${minCount} photo(s) required for ${label} — got ${list.length}. Capture or retry cameras.`,
    );
  }

  if (requireAllSlots) {
    const slots = new Set(list.map((s) => s.id));
    for (let i = 1; i <= configured; i += 1) {
      const camId = `cam-${i}`;
      if (!slots.has(camId) && !list[i - 1]) {
        throw new Error(
          `${configured} photo(s) required for ${label} — missing Camera ${i}. Use Capture images or Retry.`,
        );
      }
    }
  }

  for (const snap of list) {
    if (!snap.path || !fs.existsSync(snap.path)) {
      throw new Error(`Photo file missing for ${snap.label || snap.id}`);
    }
    if (checkBlank) {
      const buffer = fs.readFileSync(snap.path);
      if (isBlankJpegBuffer(buffer)) {
        throw new Error(
          `Photo from ${snap.label || snap.id} looks blank — tap Retry for that camera.`,
        );
      }
    }
  }

  return list;
}

async function captureManualSession({ sessionId, passKey = 'arrival' } = {}) {
  const id = sessionId || `manual-${uuidv4()}`;
  const { snapshots, failures } = await CameraCaptureService.captureAllSnapshots(id, passKey);
  const minCount = getMinPhotoCountToSave();
  const enabledCount = countEnabledCameras(DeviceMonitorService.getCameraConfig());

  if (snapshots.length < Math.min(minCount, enabledCount || minCount)) {
    const failedLabels = failures.map((f) => f.label).join(', ') || 'all cameras';
    throw new Error(
      `No cameras responded — need at least ${minCount} photo(s). Failed: ${failedLabels}. Check camera network and retry.`,
    );
  }

  validateSnapshots(snapshots, passKey, { checkBlank: false });

  const partial = failures.length > 0;
  if (partial) {
    logger.warn('Partial manual photo capture', {
      sessionId: id,
      passKey,
      captured: snapshots.map((s) => s.label),
      failed: failures.map((f) => f.label),
    });
  }

  logger.info('Manual photo session captured', {
    sessionId: id,
    passKey,
    count: snapshots.length,
    partial,
  });

  return {
    sessionId: id,
    passKey,
    snapshots: normalizeSnapshots(snapshots),
    failedCameras: failures,
    partial,
  };
}

async function retryManualSessionPhoto({ sessionId, cameraId, passKey = 'arrival' }) {
  if (!sessionId) {
    throw new Error('sessionId is required to retry a photo');
  }
  if (!cameraId) {
    throw new Error('cameraId is required to retry a photo');
  }

  const snap = await CameraCaptureService.captureSingleSnapshot(
    sessionId,
    cameraId,
    passKey,
  );

  validateSnapshots([snap], `${passKey} retry`, {
    checkBlank: false,
    requireAllSlots: false,
  });

  logger.info('Manual photo retried', { sessionId, cameraId, passKey, path: snap.path });

  return {
    sessionId,
    passKey,
    snapshot: {
      ...normalizeSnapshots([snap])[0],
      capturedAt: Date.now(),
    },
  };
}

function finalizeSnapshotsForTransaction(snapshots, transactionId, passKey) {
  const list = validateSnapshots(snapshots, passKey);
  const finalized = [];

  for (const snap of list) {
    const buffer = fs.readFileSync(snap.path);
    const dest = saveCameraImage(buffer, transactionId, snap.id, passKey);
    finalized.push({ id: snap.id, label: snap.label, path: dest });
  }

  return finalized;
}

module.exports = {
  captureManualSession,
  retryManualSessionPhoto,
  finalizeSnapshotsForTransaction,
  validateSnapshots,
};
