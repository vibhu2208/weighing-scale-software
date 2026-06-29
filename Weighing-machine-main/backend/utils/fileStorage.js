'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('./timestamp');

/** Project root resolved relative to this file: backend/utils -> ../..
 * In packaged builds the code runs from `app.asar` (a file), so runtime
 * data must live in Electron's writable `userData` directory.
 * Call `initPackagedStorage()` from main.js before loading other backend modules. */
const isInAsar = String(__dirname).includes('.asar');
let ROOT = path.resolve(__dirname, '..', '..');

function buildPaths(root) {
  return {
    ROOT: root,
    UPLOADS: path.join(root, 'uploads'),
    REPORTS: path.join(root, 'reports'),
    IMAGES: path.join(root, 'images'),
    BACKUPS: path.join(root, 'backups'),
    CLOUD_BACKUPS: path.join(root, 'backups', 'cloud'),
    LOGS: path.join(root, 'logs'),
    LOG_CLOUD_STAGING: path.join(root, 'logs', 'cloud'),
    DATABASE: path.join(root, 'database'),
    THERMAL_QUEUE: path.join(root, 'logs', 'thermal_queue'),
    REPRINT_QUEUE: path.join(root, 'logs', 'reprint_queue.json'),
  };
}

/** Mutable so `initPackagedStorage` can repoint paths for installed builds. */
const PATHS = buildPaths(ROOT);

function applyRoot(root) {
  ROOT = root;
  const next = buildPaths(root);
  Object.keys(next).forEach((key) => {
    PATHS[key] = next[key];
  });
}

function ensureRuntimeDirs() {
  [
    PATHS.UPLOADS,
    PATHS.REPORTS,
    PATHS.IMAGES,
    PATHS.BACKUPS,
    PATHS.CLOUD_BACKUPS,
    PATHS.LOGS,
    PATHS.LOG_CLOUD_STAGING,
    PATHS.DATABASE,
    PATHS.THERMAL_QUEUE,
  ].forEach(ensureDir);
}

/** Must be called from Electron main before any backend module loads (packaged app). */
function initPackagedStorage(userDataPath) {
  applyRoot(path.join(userDataPath, 'weighbridge-data'));
  ensureRuntimeDirs();
  return PATHS;
}

function normalizePath(p) {
  return path.normalize(path.resolve(p));
}

/** Create a directory (and parents) if it doesn't already exist. */
function ensureDir(dir) {
  const target = normalizePath(dir);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  return target;
}

if (!isInAsar) {
  ensureRuntimeDirs();
}

function sanitizeMediaBasename(name) {
  return (
    String(name || 'UNKNOWN')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'UNKNOWN'
  );
}

function isSaveOptions(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Date) &&
    (Object.prototype.hasOwnProperty.call(value, 'vehicleNumber') ||
      Object.prototype.hasOwnProperty.call(value, 'date'))
  );
}

function normalizePassLabel(passKey) {
  const raw = String(passKey || 'capture').toLowerCase();
  if (raw.includes('departure')) return 'departure';
  if (raw.includes('arrival')) return 'arrival';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cameraIdFromPassKey(passKey) {
  const raw = String(passKey || '');
  const camMatch = raw.match(/cam-(\d+)/i);
  if (camMatch) return `cam-${camMatch[1]}`;
  return 'primary';
}

function buildPhotoFilename({ date, vehicleNumber, passKey, cameraId, transactionId }) {
  const { year, month, day } = ts.parts(date);
  const datePrefix = `${year}${month}${day}`;
  const vehicle = sanitizeMediaBasename(vehicleNumber);
  const pass = normalizePassLabel(passKey);
  const cam = String(cameraId || 'cam').replace(/[^a-zA-Z0-9_-]/g, '_');
  const shortId = String(transactionId || '')
    .replace(/-/g, '')
    .slice(0, 8);
  const parts = [datePrefix, vehicle, pass, cam];
  if (shortId) parts.push(shortId);
  return `${parts.join('_')}.jpg`;
}

function parsePathArgs(passKeyOrDate, maybeDate, maybeOptions) {
  let passKey = null;
  let date;
  let options = {};

  if (typeof passKeyOrDate === 'string' && passKeyOrDate !== '') {
    passKey = passKeyOrDate;
  } else if (passKeyOrDate instanceof Date) {
    date = passKeyOrDate;
  } else if (passKeyOrDate && !isSaveOptions(passKeyOrDate)) {
    date = passKeyOrDate;
  } else if (isSaveOptions(passKeyOrDate)) {
    options = passKeyOrDate;
  }

  if (maybeDate instanceof Date) {
    date = maybeDate;
  } else if (typeof maybeDate === 'string' && maybeDate !== '' && !isSaveOptions(maybeDate)) {
    date = maybeDate;
  } else if (isSaveOptions(maybeDate)) {
    options = { ...options, ...maybeDate };
  }

  if (isSaveOptions(maybeOptions)) {
    options = { ...options, ...maybeOptions };
  }

  if (options.date) date = options.date;

  return { passKey, date, options };
}

/**
 * Path for a transaction's captured image:
 *   images/YYYY/MM/DD/YYYYMMDD_{vehicle}_{pass}_{camera}_{shortTxnId}.jpg
 */
function getImagePath(transactionId, passKeyOrDate, maybeDate, maybeOptions) {
  if (!transactionId) {
    throw new Error('getImagePath: transactionId is required');
  }
  const { passKey, date, options } = parsePathArgs(passKeyOrDate, maybeDate, maybeOptions);
  const { year, month, day } = ts.parts(date);
  const dir = ensureDir(path.join(PATHS.IMAGES, year, month, day));
  const filename = buildPhotoFilename({
    date,
    vehicleNumber: options.vehicleNumber,
    passKey,
    cameraId: cameraIdFromPassKey(passKey),
    transactionId,
  });
  return normalizePath(path.join(dir, filename));
}

/** Per-camera snapshot under images/YYYY/MM/DD/ */
function getCameraImagePath(transactionId, cameraId, passKeyOrDate, maybeDate, maybeOptions) {
  if (!transactionId) {
    throw new Error('getCameraImagePath: transactionId is required');
  }
  const { passKey, date, options } = parsePathArgs(passKeyOrDate, maybeDate, maybeOptions);
  const { year, month, day } = ts.parts(date);
  const dir = ensureDir(path.join(PATHS.IMAGES, year, month, day));
  const filename = buildPhotoFilename({
    date,
    vehicleNumber: options.vehicleNumber,
    passKey,
    cameraId,
    transactionId,
  });
  return normalizePath(path.join(dir, filename));
}

function saveCameraImage(sourceBuffer, transactionId, cameraId, passKey, dateOrOptions, maybeOptions) {
  if (!Buffer.isBuffer(sourceBuffer)) {
    throw new Error('saveCameraImage: sourceBuffer must be a Buffer');
  }
  let pass = passKey;
  let date = dateOrOptions;
  let options = maybeOptions;
  if (passKey && typeof passKey === 'object' && passKey.getTime) {
    date = passKey;
    pass = null;
    options = dateOrOptions;
  } else if (isSaveOptions(dateOrOptions)) {
    options = dateOrOptions;
    date = undefined;
  }
  const dest = getCameraImagePath(transactionId, cameraId, pass, date, options);
  fs.writeFileSync(dest, sourceBuffer);
  return dest;
}

function saveImage(sourceBuffer, transactionId, passKey, dateOrOptions, maybeOptions) {
  if (!Buffer.isBuffer(sourceBuffer)) {
    throw new Error('saveImage: sourceBuffer must be a Buffer');
  }
  let pass = passKey;
  let date = dateOrOptions;
  let options = maybeOptions;
  if (passKey && typeof passKey === 'object' && passKey.getTime) {
    date = passKey;
    pass = null;
    options = dateOrOptions;
  } else if (isSaveOptions(dateOrOptions)) {
    options = dateOrOptions;
    date = undefined;
  }
  const dest = getImagePath(transactionId, pass, date, options);
  fs.writeFileSync(dest, sourceBuffer);
  return dest;
}

function getImage(transactionId, date) {
  const p = getImagePath(transactionId, date);
  return fs.existsSync(p) ? p : null;
}

function deleteImage(transactionId, date) {
  const candidates = [];
  const txnToken = String(transactionId || '');
  if (date) {
    const p = getImage(transactionId, date);
    if (p) candidates.push(p);
  } else {
    walkAllPhotoTrees((filePath, name) => {
      if (name === `${transactionId}.jpg` || name.includes(txnToken)) {
        candidates.push(filePath);
      }
    });
  }
  let removed = 0;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed += 1;
    }
  }
  return removed;
}

const WALK_YIELD_EVERY_DIRS = 40;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function walkJpegTree(root, onFile) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jpg')) onFile(normalizePath(full), ent.name);
    }
  }
}

async function walkJpegTreeAsync(root, onFile) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let dirsSinceYield = 0;
  while (stack.length) {
    if (dirsSinceYield >= WALK_YIELD_EVERY_DIRS) {
      dirsSinceYield = 0;
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirsSinceYield += 1;
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jpg')) onFile(normalizePath(full), ent.name);
    }
  }
}

function walkAllPhotoTrees(onFile) {
  walkJpegTree(PATHS.IMAGES, onFile);
  walkJpegTree(PATHS.UPLOADS, onFile);
}

async function walkAllPhotoTreesAsync(onFile) {
  await walkJpegTreeAsync(PATHS.IMAGES, onFile);
  await walkJpegTreeAsync(PATHS.UPLOADS, onFile);
}

/** @deprecated Use walkAllPhotoTrees — kept for callers that only need uploads */
function walkUploadTree(onFile) {
  walkJpegTree(PATHS.UPLOADS, onFile);
}

async function walkUploadTreeAsync(onFile) {
  await walkJpegTreeAsync(PATHS.UPLOADS, onFile);
}

function listJpegsInDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jpg') && !f.includes('_slip'))
    .map((f) => normalizePath(path.join(dir, f)));
}

function listImages(date) {
  const { year, month, day } = ts.parts(date);
  const imagesDir = path.join(PATHS.IMAGES, year, month, day);
  const uploadsDir = path.join(PATHS.UPLOADS, year, month, day);
  return [...listJpegsInDir(imagesDir), ...listJpegsInDir(uploadsDir)];
}

function tallyUploadFile(filePath, totals) {
  if (filePath.includes('_slip.')) return;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    totals.totalImages += 1;
    totals.totalSizeBytes += st.size;
    const mtime = st.mtime.toISOString();
    if (!totals.oldestDate || mtime < totals.oldestDate) totals.oldestDate = mtime;
    if (!totals.newestDate || mtime > totals.newestDate) totals.newestDate = mtime;
  } catch {
    /* skip */
  }
}

function getStorageStats() {
  const totals = {
    totalImages: 0,
    totalSizeBytes: 0,
    oldestDate: null,
    newestDate: null,
  };
  walkAllPhotoTrees((filePath) => tallyUploadFile(filePath, totals));
  return totals;
}

async function getStorageStatsAsync() {
  const totals = {
    totalImages: 0,
    totalSizeBytes: 0,
    oldestDate: null,
    newestDate: null,
  };
  await walkAllPhotoTreesAsync((filePath) => tallyUploadFile(filePath, totals));
  return totals;
}

function deleteOlderThan(days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  walkAllPhotoTrees((filePath) => {
    if (filePath.includes('_slip.')) return;
    try {
      const st = fs.statSync(filePath);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch {
      /* skip */
    }
  });
  return deleted;
}

/** Path for a new database backup file. */
function getBackupPath() {
  ensureDir(PATHS.BACKUPS);
  return normalizePath(
    path.join(PATHS.BACKUPS, `weighbridge_${ts.fileSafe()}.db`),
  );
}

function getBackupLogPath() {
  ensureDir(PATHS.BACKUPS);
  const { year, month, day } = ts.parts();
  return normalizePath(path.join(PATHS.BACKUPS, `app_${year}${month}${day}.log`));
}

/** Path for a log file under logs/. */
function getLogPath(filename) {
  ensureDir(PATHS.LOGS);
  return normalizePath(path.join(PATHS.LOGS, filename));
}

/** Renderer-safe URL (use in Electron UI). Prefer this over file://. */
function toMediaUrl(filePath) {
  const localMedia = require('./localMedia');
  return localMedia.toMediaUrl(filePath, { PATHS, normalizePath });
}

/** @deprecated Use toMediaUrl in renderer; file:// is blocked from http origins. */
function toFileUrl(filePath) {
  return toMediaUrl(filePath);
}

module.exports = {
  PATHS,
  initPackagedStorage,
  normalizePath,
  ensureDir,
  getImagePath,
  getCameraImagePath,
  saveCameraImage,
  saveImage,
  getImage,
  deleteImage,
  listImages,
  getStorageStats,
  getStorageStatsAsync,
  deleteOlderThan,
  getBackupPath,
  getBackupLogPath,
  getLogPath,
  toMediaUrl,
  toFileUrl,
};
