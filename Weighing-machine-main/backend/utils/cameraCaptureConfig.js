'use strict';

function isCameraRequired() {
  const env = String(process.env.REQUIRE_CAMERA_CAPTURE || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'no') return false;
  if (env === 'true' || env === '1' || env === 'yes') return true;
  return String(process.env.MANUAL_WEIGHMENT || '').trim().toLowerCase() !== 'true';
}

function getRequiredPhotoCount() {
  const explicit = parseInt(process.env.REQUIRED_PHOTOS || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (!isCameraRequired()) return 1;
  return 3;
}

/** Minimum working camera photos needed to allow Save (partial capture OK). */
function getMinPhotoCountToSave() {
  const explicit = parseInt(process.env.MIN_PHOTOS_TO_SAVE || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return 1;
}

function getCaptureRetryCount() {
  const n = parseInt(process.env.CAMERA_CAPTURE_RETRIES || '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function getCaptureRetryDelayMs() {
  const n = parseInt(process.env.CAMERA_CAPTURE_RETRY_DELAY_MS || '400', 10);
  return Number.isFinite(n) && n >= 0 ? n : 400;
}

function getFrameMaxAgeMs() {
  const n = parseInt(process.env.CAMERA_FRAME_MAX_AGE_MS || '5000', 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/** When true: no always-on preview; photos captured fresh on Save only. */
function useOnDemandCameraPreview() {
  const env = String(process.env.CAMERA_PREVIEW_ON_DEMAND || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'no') return false;
  if (env === 'true' || env === '1' || env === 'yes') return true;
  return true;
}

/** Operator captures photos manually, retries per camera, then Save. */
function useManualPhotoConfirm() {
  const env = String(process.env.MANUAL_PHOTO_CAPTURE || '').trim().toLowerCase();
  if (env === 'false' || env === '0' || env === 'no') return false;
  if (env === 'true' || env === '1' || env === 'yes') return true;
  return useOnDemandCameraPreview();
}

module.exports = {
  isCameraRequired,
  getRequiredPhotoCount,
  getMinPhotoCountToSave,
  getCaptureRetryCount,
  getCaptureRetryDelayMs,
  getFrameMaxAgeMs,
  useOnDemandCameraPreview,
  useManualPhotoConfirm,
};
