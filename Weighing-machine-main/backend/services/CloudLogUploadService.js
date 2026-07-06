'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const S3Service = require('./S3Service');
const CloudUploadTracker = require('./CloudUploadTracker');
const SettingsService = require('./SettingsService');
const { isOnline } = require('../utils/connectivity');
const backupLogger = require('../utils/backupLogger');
const {
  PATHS,
  ensureDir,
  normalizePath,
  getLogPath,
} = require('../utils/fileStorage');
const { emit } = require('../utils/rendererEvents');
const logger = require('../utils/logger');

const FILE_TYPE = 'LOG';
const S3_FOLDER = 'logs';
const STAGING_SUBDIR = 'cloud';
const LOG_SOURCES = ['app.log', 'error.log', 'device.log', 'backup.log'];
const STAGING_RETENTION_DAYS = 7;

let intervalHandle = null;
let running = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** app-2026-06-07-20-30.log */
function timestampStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
}

function stagingDir() {
  return normalizePath(path.join(PATHS.LOGS, STAGING_SUBDIR));
}

function intervalMs() {
  const mins = parseInt(SettingsService.get('CLOUD_LOG_UPLOAD_INTERVAL_MINUTES') || '30', 10);
  return Math.max(5, Number.isNaN(mins) ? 30 : mins) * 60 * 1000;
}

function isLogUploadEnabled() {
  const v = SettingsService.get('CLOUD_LOG_UPLOAD_ENABLED');
  if (v === 'false') return false;
  return S3Service.isConfigured();
}

function emitProgress(step, detail) {
  emit('cloudLogUpload:progress', { step, detail, at: new Date().toISOString() });
}

function snapshotName(sourceName, stamp) {
  const base = path.basename(sourceName, path.extname(sourceName));
  return `${base}-${stamp}.log`;
}

async function createSnapshots(stamp) {
  ensureDir(stagingDir());
  const created = [];

  for (const sourceName of LOG_SOURCES) {
    const sourcePath = getLogPath(sourceName);
    if (!fs.existsSync(sourcePath)) continue;

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;

    const stagedName = snapshotName(sourceName, stamp);
    const gzName = `${stagedName}.gz`;
    const gzPath = normalizePath(path.join(stagingDir(), gzName));
    const s3Key = `${S3_FOLDER}/${gzName}`;

    try {
      const raw = await fs.promises.readFile(sourcePath);
      const compressed = await gzip(raw);
      await fs.promises.writeFile(gzPath, compressed);
      CloudUploadTracker.register(gzPath, FILE_TYPE, s3Key);
      created.push({ stagedPath: gzPath, s3Key, sourceName });
    } catch (err) {
      logger.warn('CloudLogUploadService: snapshot failed', {
        source: sourceName,
        message: err.message,
      });
    }
  }

  return created;
}

async function prepareLegacyLogUpload(row) {
  if (!row.s3_key.endsWith('.log') || row.s3_key.endsWith('.log.gz')) {
    return row;
  }
  if (!fs.existsSync(row.file_path)) {
    return row;
  }

  let stat;
  try {
    stat = fs.statSync(row.file_path);
  } catch {
    return row;
  }
  if (!stat.isFile() || stat.size < 512 * 1024) {
    return row;
  }

  const gzPath = `${row.file_path}.gz`;
  const gzKey = `${row.s3_key}.gz`;
  try {
    const raw = await fs.promises.readFile(row.file_path);
    const compressed = await gzip(raw);
    await fs.promises.writeFile(gzPath, compressed);
    try {
      await fs.promises.unlink(row.file_path);
    } catch {
      /* keep raw copy if delete fails */
    }
    return { ...row, file_path: gzPath, s3_key: gzKey };
  } catch (err) {
    logger.warn('CloudLogUploadService: legacy log gzip failed', {
      path: row.file_path,
      message: err.message,
    });
    return row;
  }
}

async function uploadOne(row) {
  const prepared = await prepareLegacyLogUpload(row);
  if (!fs.existsSync(prepared.file_path)) {
    CloudUploadTracker.markFailed(row.file_path);
    return { ok: false, reason: 'missing' };
  }

  try {
    const contentType = prepared.s3_key.endsWith('.gz') ? 'application/gzip' : 'text/plain';
    await S3Service.uploadFile(prepared.file_path, prepared.s3_key, contentType);
    CloudUploadTracker.markUploaded(row.file_path);
    backupLogger.logUploaded(prepared.s3_key);
    SettingsService.set('last_cloud_log_upload_at', new Date().toISOString());

    try {
      fs.unlinkSync(prepared.file_path);
    } catch {
      /* keep for manual cleanup */
    }
    return { ok: true };
  } catch (err) {
    CloudUploadTracker.markFailed(row.file_path);
    backupLogger.uploadFailed(prepared.s3_key, err.message);
    if (row.retry_count + 1 <= CloudUploadTracker.MAX_RETRIES) {
      backupLogger.retryAttempt(prepared.s3_key, row.retry_count + 1);
    }
    return { ok: false, error: err.message };
  }
}

async function uploadPendingLogs() {
  const pending = CloudUploadTracker.getPendingUploads().filter(
    (row) => row.file_type === FILE_TYPE,
  );
  const results = { ok: 0, failed: 0 };
  for (const row of pending) {
    // eslint-disable-next-line no-await-in-loop
    const r = await uploadOne(row);
    if (r.ok) results.ok += 1;
    else results.failed += 1;
  }
  return results;
}

function purgeOldStagingFiles() {
  const dir = stagingDir();
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - STAGING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      /* skip */
    }
  }
  return removed;
}

async function runCycle(options = {}) {
  const { manual = false, onProgress } = options;
  const progress = onProgress || emitProgress;

  if (running) {
    return { ok: false, reason: 'busy' };
  }
  if (!isLogUploadEnabled()) {
    return { ok: false, reason: 'disabled' };
  }

  running = true;
  const stamp = timestampStamp();
  progress('start', manual ? 'Manual log upload' : 'Scheduled log upload');

  const summary = {
    ok: true,
    online: false,
    stamp,
    snapshots: 0,
    upload: { ok: 0, failed: 0 },
    purged: 0,
    errors: [],
  };

  try {
    const online = await isOnline();
    summary.online = online;
    if (!online) {
      progress('skipped', 'No internet — will retry next cycle');
      return { ...summary, ok: true, skipped: true };
    }

    progress('snapshot', 'Compressing logs for upload…');
    const snapshots = await createSnapshots(stamp);
    summary.snapshots = snapshots.length;

    progress('upload', 'Uploading logs to S3…');
    summary.upload = await uploadPendingLogs();

    summary.purged = purgeOldStagingFiles();

    backupLogger.logsUploadCompleted(
      `${summary.upload.ok} uploaded, ${summary.upload.failed} failed`,
    );
    progress('complete', 'Log upload cycle finished');
    emit('cloudLogUpload:complete', summary);
    logger.info('CloudLogUploadService cycle complete', summary);
    return summary;
  } catch (err) {
    backupLogger.uploadFailed('logs-cycle', err.message);
    emit('cloudLogUpload:failed', { message: err.message });
    logger.logError('CloudLogUploadService cycle failed', err);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

function start() {
  stop();
  running = false;

  if (!S3Service.isConfigured()) {
    logger.info('CloudLogUploadService: AWS not configured — log upload idle');
    return;
  }

  const tick = () => {
    runCycle().catch((e) => logger.logError('Cloud log upload cycle', e));
  };

  intervalHandle = setInterval(tick, intervalMs());
  setTimeout(tick, 45 * 1000);
  logger.info('CloudLogUploadService started', { intervalMs: intervalMs() });
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

const CloudLogUploadService = {
  start,
  stop,
  runCycle,
  runManual: () => runCycle({ manual: true }),
  isLogUploadEnabled,
  getStatus: () => ({
    configured: S3Service.isConfigured(),
    enabled: isLogUploadEnabled(),
    running,
    intervalMs: intervalMs(),
    stagingDir: stagingDir(),
    s3Folder: S3_FOLDER,
    lastUpload: SettingsService.get('last_cloud_log_upload_at') || null,
  }),
};

module.exports = CloudLogUploadService;
