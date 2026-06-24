'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getDb } = require('../database/db');
const SettingsService = require('./SettingsService');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const {
  PATHS,
  ensureDir,
  getBackupPath,
  getBackupLogPath,
  getLogPath,
  deleteOlderThan,
} = require('../utils/fileStorage');
const { emit } = require('../utils/rendererEvents');

let backupCron = null;
let cleanupCron = null;
let windowGetter = () => null;
let running = false;

function setWindowGetter(fn) {
  windowGetter = fn;
}

function isAutoBackupEnabled() {
  const v = SettingsService.get('AUTO_BACKUP');
  return v === 'true' || v === true;
}

function getIntervalHours() {
  const n = parseInt(SettingsService.get('BACKUP_INTERVAL_HOURS') || '4', 10);
  return Math.max(1, Math.min(24, Number.isNaN(n) ? 4 : n));
}

function deleteOldBackups() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(PATHS.BACKUPS)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(PATHS.BACKUPS)) {
    const full = path.join(PATHS.BACKUPS, name);
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

async function performBackup() {
  if (running) {
    logger.warn('Backup already in progress — skipped');
    return { ok: false, reason: 'busy' };
  }
  running = true;

  try {
    const workflow = require('../engine/WorkflowEngine');
    const state = workflow.getCurrentState ? workflow.getCurrentState() : null;
    if (state && state.state && state.state !== 'IDLE') {
      logger.info(
        'Backup started during active transaction — this is safe',
        { workflowState: state.state },
      );
    }
  } catch {
    /* workflow optional */
  }

  const destPath = getBackupPath();
  ensureDir(PATHS.BACKUPS);

  try {
    const db = getDb();
    await db.backup(destPath);

    const appLog = getLogPath('app.log');
    if (fs.existsSync(appLog)) {
      fs.copyFileSync(appLog, getBackupLogPath());
    }

    deleteOldBackups();
    const stat = fs.statSync(destPath);
    const timestamp = ts.now();
    SettingsService.set('last_backup_at', timestamp);

    const payload = {
      path: destPath,
      timestamp,
      size: stat.size,
    };
    logger.info('Backup complete', payload);
    emit('backup:complete', payload);
    return { ok: true, ...payload };
  } catch (err) {
    logger.logError('Backup failed', err);
    if (err.code === 'ENOSPC') {
      emit('backup:diskFull', { message: err.message });
    } else {
      emit('backup:failed', { message: err.message });
    }
    return { ok: false, error: err.message, code: err.code };
  } finally {
    running = false;
  }
}

function runImageCleanup() {
  const enabled = SettingsService.get('IMAGE_AUTO_CLEANUP');
  if (enabled === 'false') return { skipped: true };
  const days = parseInt(SettingsService.get('IMAGE_RETENTION_DAYS') || '90', 10);
  const deleted = deleteOlderThan(Number.isNaN(days) ? 90 : days);
  logger.info('Image cleanup complete', { deleted, days });
  return { deleted, days };
}

function scheduleJobs() {
  if (backupCron) backupCron.stop();
  if (cleanupCron) cleanupCron.stop();

  if (!isAutoBackupEnabled()) {
    logger.info('Auto backup disabled');
    return;
  }

  const hours = getIntervalHours();
  const cronExpr = hours >= 24 ? '0 0 * * *' : `0 */${hours} * * *`;
  backupCron = cron.schedule(cronExpr, () => {
    performBackup().catch((e) => logger.logError('Scheduled backup', e));
  });
  logger.info('Backup schedule active', { hours, cron: cronExpr });

  cleanupCron = cron.schedule('0 3 * * 0', () => {
    runImageCleanup();
  });
}

const BackupService = {
  start(config = {}) {
    if (config.getWindow) setWindowGetter(config.getWindow);
    scheduleJobs();
    logger.info('BackupService started');
  },

  stop() {
    if (backupCron) backupCron.stop();
    if (cleanupCron) cleanupCron.stop();
    backupCron = null;
    cleanupCron = null;
  },

  performBackup,
  manualBackup: performBackup,

  getBackupList() {
    ensureDir(PATHS.BACKUPS);
    if (!fs.existsSync(PATHS.BACKUPS)) return [];
    return fs
      .readdirSync(PATHS.BACKUPS)
      .filter((f) => f.endsWith('.db'))
      .map((filename) => {
        const full = path.join(PATHS.BACKUPS, filename);
        const st = fs.statSync(full);
        return {
          filename,
          size: st.size,
          created_at: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },

  getLastBackupTime() {
    return SettingsService.get('last_backup_at') || null;
  },

  runImageCleanup,
  reschedule: scheduleJobs,
};

module.exports = BackupService;
