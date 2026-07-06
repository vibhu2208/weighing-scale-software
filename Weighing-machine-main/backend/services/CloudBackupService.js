'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { getDb, closeDatabase, resolveDbPath } = require('../database/db');
const S3Service = require('./S3Service');
const CloudUploadTracker = require('./CloudUploadTracker');
const SettingsService = require('./SettingsService');
const { isOnline } = require('../utils/connectivity');
const backupLogger = require('../utils/backupLogger');
const {
  PATHS,
  ensureDir,
  normalizePath,
} = require('../utils/fileStorage');
const { emit } = require('../utils/rendererEvents');
const logger = require('../utils/logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FILE_TYPES = {
  REPORT: 'REPORT',
  IMAGE: 'IMAGE',
  DB_BACKUP: 'DB_BACKUP',
};

const INTERVAL_MS = () => {
  const mins = parseInt(SettingsService.get('CLOUD_BACKUP_INTERVAL_MINUTES') || '60', 10);
  return Math.max(15, Number.isNaN(mins) ? 60 : mins) * 60 * 1000;
};

let intervalHandle = null;
let running = false;
let windowGetter = () => null;

function setWindowGetter(fn) {
  windowGetter = fn;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** weighbridge-YYYY-MM-DD-HH-mm.db.gz */
function cloudDbBackupBasename(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
  return `weighbridge-${stamp}`;
}

function isCloudBackupEnabled() {
  const v = SettingsService.get('CLOUD_BACKUP_ENABLED');
  if (v === 'false') return false;
  return S3Service.isConfigured();
}

function emitProgress(step, detail) {
  emit('cloudBackup:progress', { step, detail, at: new Date().toISOString() });
}

const YIELD_EVERY_DIRS = 40;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function walkFiles(rootDir, onFile) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  let dirsSinceYield = 0;
  while (stack.length) {
    if (dirsSinceYield >= YIELD_EVERY_DIRS) {
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
      else if (ent.isFile()) onFile(normalizePath(full), ent.name);
    }
  }
}

async function scanAndRegister() {
  const reportExts = new Set(['.pdf']);
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

  const registerReport = (filePath, name) => {
    const ext = path.extname(name).toLowerCase();
    if (!reportExts.has(ext)) return;
    const rel = path.basename(filePath);
    const s3Key = `reports/${rel}`;
    if (!CloudUploadTracker.isUploaded(filePath)) {
      CloudUploadTracker.register(filePath, FILE_TYPES.REPORT, s3Key);
    }
  };

  await walkFiles(PATHS.REPORTS, registerReport);
  await walkFiles(PATHS.UPLOADS, registerReport);

  const imageRoots = [
    { root: PATHS.IMAGES, prefix: 'images' },
    { root: PATHS.UPLOADS, prefix: 'images' },
  ];

  for (const { root, prefix } of imageRoots) {
    // eslint-disable-next-line no-await-in-loop
    await walkFiles(root, (filePath, name) => {
      const ext = path.extname(name).toLowerCase();
      if (!imageExts.has(ext)) return;
      if (name.includes('_slip.')) return;
      const rel = path.relative(root, filePath).split(path.sep).join('/');
      const s3Key = `${prefix}/${rel}`;
      if (!CloudUploadTracker.isUploaded(filePath)) {
        CloudUploadTracker.register(filePath, FILE_TYPES.IMAGE, s3Key);
      }
    });
  }
}

async function createSqliteGzipBackup() {
  const base = cloudDbBackupBasename();
  const dbName = `${base}.db`;
  const gzName = `${base}.db.gz`;
  ensureDir(PATHS.CLOUD_BACKUPS);
  const rawPath = normalizePath(path.join(PATHS.CLOUD_BACKUPS, dbName));
  const gzPath = normalizePath(path.join(PATHS.CLOUD_BACKUPS, gzName));
  const s3Key = `db-backups/${gzName}`;

  const db = getDb();
  await db.backup(rawPath);
  const raw = await fs.promises.readFile(rawPath);
  const compressed = await gzip(raw);
  await fs.promises.writeFile(gzPath, compressed);

  CloudUploadTracker.register(gzPath, FILE_TYPES.DB_BACKUP, s3Key);
  return { gzPath, s3Key, gzName };
}

async function uploadOne(row) {
  if (!fs.existsSync(row.file_path)) {
    CloudUploadTracker.markFailed(row.file_path);
    return { ok: false, reason: 'missing' };
  }

  try {
    await S3Service.uploadFile(row.file_path, row.s3_key);
    CloudUploadTracker.markUploaded(row.file_path);

    if (row.file_type === FILE_TYPES.REPORT) {
      backupLogger.reportUploaded(path.basename(row.file_path));
    } else if (row.file_type === FILE_TYPES.IMAGE) {
      backupLogger.imageUploaded(row.s3_key);
    } else if (row.file_type === FILE_TYPES.DB_BACKUP) {
      backupLogger.databaseBackupUploaded(row.s3_key);
      SettingsService.set('last_cloud_backup_at', new Date().toISOString());
    }
    return { ok: true };
  } catch (err) {
    CloudUploadTracker.markFailed(row.file_path);
    backupLogger.uploadFailed(row.s3_key, err.message);
    if (row.retry_count + 1 <= CloudUploadTracker.MAX_RETRIES) {
      backupLogger.retryAttempt(row.s3_key, row.retry_count + 1);
    }
    return { ok: false, error: err.message };
  }
}

async function uploadPending(typeFilter) {
  const pending = CloudUploadTracker.getPendingUploads();
  const rows = typeFilter
    ? pending.filter((r) => r.file_type === typeFilter)
    : pending;

  const results = { ok: 0, failed: 0 };
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await uploadOne(row);
    if (r.ok) results.ok += 1;
    else results.failed += 1;
  }
  return results;
}

async function runCycle(options = {}) {
  const { manual = false, onProgress } = options;
  const progress = onProgress || emitProgress;

  if (running) {
    return { ok: false, reason: 'busy' };
  }
  if (!isCloudBackupEnabled()) {
    return { ok: false, reason: 'disabled' };
  }

  running = true;
  backupLogger.backupStarted();
  progress('start', manual ? 'Manual cloud backup' : 'Scheduled cloud backup');

  const summary = {
    ok: true,
    online: false,
    dbBackup: null,
    reports: { ok: 0, failed: 0 },
    images: { ok: 0, failed: 0 },
    dbUpload: { ok: 0, failed: 0 },
    errors: [],
  };

  try {
    const online = await isOnline();
    summary.online = online;
    if (!online) {
      progress('skipped', 'No internet — will retry next cycle');
      return { ...summary, ok: true, skipped: true };
    }

    await scanAndRegister();

    progress('db', 'Creating SQLite backup…');
    let dbMeta;
    try {
      dbMeta = await createSqliteGzipBackup();
      summary.dbBackup = dbMeta.gzName;
    } catch (err) {
      summary.errors.push(`db-backup: ${err.message}`);
      logger.logError('Cloud DB backup create failed', err);
    }

    progress('reports', 'Uploading reports…');
    summary.reports = await uploadPending(FILE_TYPES.REPORT);

    progress('images', 'Uploading images…');
    summary.images = await uploadPending(FILE_TYPES.IMAGE);

    if (dbMeta) {
      progress('db-upload', 'Uploading database backup…');
      summary.dbUpload = await uploadPending(FILE_TYPES.DB_BACKUP);
    }

    backupLogger.backupCompleted(
      `reports ${summary.reports.ok}/${summary.reports.failed} images ${summary.images.ok}/${summary.images.failed}`,
    );
    progress('complete', 'Cloud backup cycle finished');
    emit('cloudBackup:complete', summary);
    return summary;
  } catch (err) {
    backupLogger.uploadFailed('cycle', err.message);
    emit('cloudBackup:failed', { message: err.message });
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

function start(config = {}) {
  if (config.getWindow) setWindowGetter(config.getWindow);
  stop();
  running = false;

  if (!S3Service.isConfigured()) {
    logger.info('CloudBackupService: AWS not configured — cloud backup idle');
    return;
  }

  const tick = () => {
    runCycle().catch((e) => logger.logError('Cloud backup cycle', e));
  };

  intervalHandle = setInterval(tick, INTERVAL_MS());
  setTimeout(tick, 30 * 1000);
  logger.info('CloudBackupService started', { intervalMs: INTERVAL_MS() });
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function listRemoteBackups() {
  if (!S3Service.isConfigured()) return [];
  const online = await isOnline();
  if (!online) return [];

  const keys = await S3Service.listKeys('db-backups/');
  return keys
    .filter((k) => k.endsWith('.db.gz'))
    .map((key) => ({
      key,
      filename: path.basename(key),
    }))
    .sort((a, b) => (a.filename < b.filename ? 1 : -1));
}

async function restoreBackup(s3Key) {
  if (!S3Service.isConfigured()) {
    throw new Error('AWS credentials are not configured');
  }
  const online = await isOnline();
  if (!online) {
    throw new Error('No internet connection — cannot download backup');
  }

  ensureDir(PATHS.CLOUD_BACKUPS);
  const localGz = normalizePath(
    path.join(PATHS.CLOUD_BACKUPS, `restore_${path.basename(s3Key)}`),
  );
  const localDb = normalizePath(
    path.join(PATHS.CLOUD_BACKUPS, `restore_${path.basename(s3Key, '.gz')}`),
  );

  await S3Service.downloadFile(s3Key, localGz);
  const compressed = await fs.promises.readFile(localGz);
  const raw = await gunzip(compressed);
  await fs.promises.writeFile(localDb, raw);

  const target = resolveDbPath();
  closeDatabase();
  ensureDir(path.dirname(target));
  fs.copyFileSync(localDb, target);

  backupLogger.info(`Database restored from ${s3Key}`);

  let app;
  try {
    app = require('electron').app;
  } catch {
    app = null;
  }

  if (app && typeof app.relaunch === 'function') {
    app.relaunch();
    app.exit(0);
  }

  return { ok: true, path: target };
}

const CloudBackupService = {
  start,
  stop,
  runCycle,
  runManual: () => runCycle({ manual: true }),
  listRemoteBackups,
  restoreBackup,
  isCloudBackupEnabled,
  getStatus: () => ({
    configured: S3Service.isConfigured(),
    enabled: isCloudBackupEnabled(),
    running,
    ...CloudUploadTracker.getStatusSummary(),
    lastCloudBackup: SettingsService.get('last_cloud_backup_at') || null,
  }),
  scanAndRegister,
};

module.exports = CloudBackupService;
