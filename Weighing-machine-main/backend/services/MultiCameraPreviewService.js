'use strict';

const logger = require('../utils/logger');
const { captureFrameFromCamera, isJpegBuffer } = require('../utils/cameraFrameCapture');
const { analyzeJpegBuffer } = require('../utils/blankFrameDetect');
const { parseCameraList } = require('../utils/cameraUrls');

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PREVIEW_INTERVAL_MS = parsePositiveInt(process.env.CAMERA_PREVIEW_INTERVAL_MS, 900);
const PREVIEW_TIMEOUT_MS = parsePositiveInt(process.env.CAMERA_PREVIEW_TIMEOUT_MS, 3500);
const MIN_JPEG_BYTES = parsePositiveInt(process.env.CAMERA_MIN_JPEG_BYTES, 2048);

/** @type {Map<string, { active: boolean, timer: NodeJS.Timeout | null, inFlight: boolean }>} */
const loops = new Map();
/** @type {Map<string, string>} cameraId -> base64 JPEG */
const lastFrames = new Map();
/** @type {Map<string, number>} cameraId -> last good frame timestamp (ms) */
const lastFrameAt = new Map();
/** @type {Map<string, 'good' | 'blank' | 'missing'>} */
const lastFrameQuality = new Map();
let frameCallback = null;
let started = false;
let paused = false;
let activeCameras = [];

function getCamerasFromConfig(config = {}) {
  return parseCameraList(config);
}

function scheduleTick(camera, delayMs) {
  const state = loops.get(camera.id);
  if (!state?.active) return;

  state.timer = setTimeout(() => runTick(camera), delayMs);
  if (state.timer.unref) state.timer.unref();
}

async function runTick(camera) {
  const state = loops.get(camera.id);
  if (!state?.active) return;

  if (paused || state.inFlight) {
    scheduleTick(camera, paused ? 200 : PREVIEW_INTERVAL_MS);
    return;
  }

  state.inFlight = true;
  try {
    const buffer = await captureFrameFromCamera(camera, PREVIEW_TIMEOUT_MS);
    if (!isJpegBuffer(buffer) || buffer.length < MIN_JPEG_BYTES) {
      throw new Error(`Invalid preview frame (${buffer?.length || 0} bytes)`);
    }

    const quality = analyzeJpegBuffer(buffer);
    if (quality.blank) {
      lastFrameQuality.set(camera.id, 'blank');
      if (typeof frameCallback === 'function') {
        frameCallback(camera.id, null, { blank: true, reason: quality.reason });
      }
      throw new Error(`Blank preview frame (${quality.reason || 'uniform'})`);
    }

    const frame = buffer.toString('base64');
    lastFrames.set(camera.id, frame);
    lastFrameAt.set(camera.id, Date.now());
    lastFrameQuality.set(camera.id, 'good');

    if (typeof frameCallback === 'function') {
      frameCallback(camera.id, frame, { blank: false });
    }
  } catch (err) {
    if (lastFrameQuality.get(camera.id) !== 'blank') {
      lastFrameQuality.set(camera.id, 'missing');
    }
    logger.debug('Multi-camera preview frame failed', {
      camera: camera.label,
      message: err.message,
    });
  } finally {
    state.inFlight = false;
    if (state.active) {
      scheduleTick(camera, PREVIEW_INTERVAL_MS);
    }
  }
}

function beginCameraLoop(camera, delayMs = 400) {
  const existing = loops.get(camera.id);
  if (existing?.active) return false;

  loops.set(camera.id, { active: true, timer: null, inFlight: false });
  scheduleTick(camera, delayMs);

  if (!activeCameras.some((c) => c.id === camera.id)) {
    activeCameras.push(camera);
  }
  started = true;
  return true;
}

function startCamera(cameraId, config, onFrame) {
  const cameras = getCamerasFromConfig(config);
  const camera = cameras.find((c) => c.id === cameraId);
  if (!camera) {
    throw new Error(`Unknown camera: ${cameraId}`);
  }
  if (typeof onFrame === 'function') {
    frameCallback = onFrame;
  }
  paused = false;
  const began = beginCameraLoop(camera, 400);
  if (began) {
    logger.info('Camera preview started', { camera: camera.label, id: camera.id });
  }
  return camera;
}

function start(config, onFrame) {
  const cameras = getCamerasFromConfig(config);
  if (!cameras.length) {
    throw new Error('No cameras configured — set CAMERA_RTSP_URLS in .env');
  }

  if (typeof onFrame === 'function') {
    frameCallback = onFrame;
  }
  paused = false;

  cameras.forEach((camera, index) => {
    if (camera.disabled) return;
    beginCameraLoop(camera, 400 + index * 700);
  });

  logger.info('Multi-camera preview started', {
    count: cameras.length,
    cameras: cameras.map((c) => c.label),
  });
  return activeCameras.length ? activeCameras : cameras;
}

function stopCamera(cameraId) {
  const state = loops.get(cameraId);
  if (!state) return;

  state.active = false;
  if (state.timer) clearTimeout(state.timer);
  loops.delete(cameraId);
  lastFrames.delete(cameraId);
  lastFrameAt.delete(cameraId);
  lastFrameQuality.delete(cameraId);
  activeCameras = activeCameras.filter((c) => c.id !== cameraId);
  started = loops.size > 0;
  if (!started) {
    frameCallback = null;
    paused = false;
  }
  logger.info('Camera preview stopped', { id: cameraId });
}

function stop() {
  for (const state of loops.values()) {
    state.active = false;
    if (state.timer) clearTimeout(state.timer);
  }
  loops.clear();
  frameCallback = null;
  started = false;
  paused = false;
  activeCameras = [];
  lastFrames.clear();
  lastFrameAt.clear();
  lastFrameQuality.clear();
}

function isStarted() {
  return started;
}

function isPaused() {
  return paused;
}

async function pauseAndDrain() {
  paused = true;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const anyInFlight = [...loops.values()].some((state) => state.inFlight);
    if (!anyInFlight) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function resume() {
  if (!started) {
    paused = false;
    return;
  }
  paused = false;
  for (const camera of activeCameras) {
    const state = loops.get(camera.id);
    if (!state?.active || state.inFlight || state.timer) continue;
    scheduleTick(camera, 100);
  }
}

function getLastFrame(cameraId) {
  return lastFrames.get(cameraId) || null;
}

function getLastFrameBuffer(cameraId) {
  const frame = getLastFrame(cameraId);
  if (!frame) return null;
  return Buffer.from(frame, 'base64');
}

function getLastFrameTimestamp(cameraId) {
  return lastFrameAt.get(cameraId) || 0;
}

function getLastFrameQuality(cameraId) {
  return lastFrameQuality.get(cameraId) || 'missing';
}

function getPreviewStatus(options = {}) {
  const { getRequiredPhotoCount, getFrameMaxAgeMs } = require('../utils/cameraCaptureConfig');
  const maxAgeMs = options.maxAgeMs ?? getFrameMaxAgeMs();
  const requiredCount = options.requiredCount ?? getRequiredPhotoCount();
  const now = Date.now();

  const cameras = activeCameras.length
    ? activeCameras
    : getCamerasFromConfig(options.config || {});

  const items = cameras.map((cam) => {
    const at = getLastFrameTimestamp(cam.id);
    const ageMs = at ? now - at : null;
    const quality = lastFrameQuality.get(cam.id) || 'missing';
    const fresh = at > 0 && ageMs <= maxAgeMs;
    const usable = fresh && quality === 'good';
    const blank = quality === 'blank';
    return {
      id: cam.id,
      label: cam.label,
      ready: usable,
      usable,
      blank,
      quality,
      lastFrameAt: at || null,
      ageMs,
    };
  });

  const readyCount = items.filter((item) => item.usable).length;
  const blankCount = items.filter((item) => item.blank).length;
  const targetCount = Math.min(requiredCount, items.length || requiredCount);

  return {
    cameras: items,
    readyCount,
    blankCount,
    totalCount: items.length,
    requiredCount: targetCount,
    allReady: items.length > 0 && readyCount >= targetCount && blankCount === 0,
    previewStarted: started,
  };
}

module.exports = {
  start,
  startCamera,
  stop,
  stopCamera,
  pauseAndDrain,
  resume,
  isStarted,
  isPaused,
  getActiveCameras: () => activeCameras,
  getCamerasFromConfig,
  getLastFrame,
  getLastFrameBuffer,
  getLastFrameTimestamp,
  getLastFrameQuality,
  getPreviewStatus,
};
