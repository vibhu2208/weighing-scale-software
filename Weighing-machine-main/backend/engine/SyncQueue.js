'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { getDb } = require('../database/db');
const { SYNC_STATUS, DEFAULTS } = require('../utils/constants');
const SyncService = require('../services/SyncService');
const TransactionService = require('../services/TransactionService');
const DeviceMonitorService = require('../services/DeviceMonitorService');

const MAX_RETRY =
  parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || DEFAULTS.MAX_RETRY_ATTEMPTS;

let cronJob = null;
let processing = false;
const inFlight = new Set();
let lastRun = null;

function emitSyncEvent(channel, payload) {
  DeviceMonitorService.emitToRenderer(channel, payload);
}

function loadPendingRows() {
  return getDb()
    .prepare(
      `SELECT * FROM sync_queue
       WHERE sync_status IN ('pending', 'retry')
         AND retry_count < ?
       ORDER BY created_at ASC`,
    )
    .all(MAX_RETRY);
}

function enqueue(transactionId) {
  const now = ts.now();
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM sync_queue WHERE transaction_id = ?')
    .get(transactionId);

  if (existing) {
    db.prepare(
      `UPDATE sync_queue SET sync_status = 'pending', last_attempt = NULL, error_message = NULL
       WHERE transaction_id = ?`,
    ).run(transactionId);
  } else {
    db.prepare(
      `INSERT INTO sync_queue (transaction_id, retry_count, sync_status, created_at)
       VALUES (?, 0, 'pending', ?)`,
    ).run(transactionId, now);
  }

  getDb()
    .prepare(
      `UPDATE transactions SET sync_status = 'pending', updated_at = ? WHERE id = ?`,
    )
    .run(now, transactionId);

  logger.info('SyncQueue enqueued', { transactionId });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  lastRun = ts.now();

  try {
    const rows = loadPendingRows();

    for (const row of rows) {
      const id = row.transaction_id;
      if (inFlight.has(id)) continue;

      inFlight.add(id);
      try {
        await SyncService.uploadTransaction(id);
        logger.info('SyncQueue uploaded', { transactionId: id });
      } catch (err) {
        if (err.noRetry || err.critical) {
          logger.error('SyncQueue critical failure', {
            transactionId: id,
            message: err.message,
          });
          getDb()
            .prepare(
              `UPDATE sync_queue SET sync_status = 'failed', error_message = ?, last_attempt = ?
               WHERE transaction_id = ?`,
            )
            .run(err.message, ts.now(), id);
          emitSyncEvent('sync:maxRetriesReached', {
            transactionId: id,
            error: err.message,
            critical: true,
          });
        } else {
          const nextRetry = row.retry_count + 1;
          if (nextRetry >= MAX_RETRY) {
            getDb()
              .prepare(
                `UPDATE sync_queue SET sync_status = 'failed', retry_count = ?, last_attempt = ?, error_message = ?
                 WHERE transaction_id = ?`,
              )
              .run(nextRetry, ts.now(), err.message, id);
            TransactionService.markSyncFailed(id, err.message);
            emitSyncEvent('sync:maxRetriesReached', {
              transactionId: id,
              error: err.message,
            });
            logger.error('SyncQueue max retries reached', { transactionId: id });
          } else {
            getDb()
              .prepare(
                `UPDATE sync_queue SET sync_status = 'retry', retry_count = ?, last_attempt = ?, error_message = ?
                 WHERE transaction_id = ?`,
              )
              .run(nextRetry, ts.now(), err.message, id);
          }
        }
      } finally {
        inFlight.delete(id);
      }
    }
  } finally {
    processing = false;
  }
}

function getStatus() {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sync_queue WHERE sync_status IN ('pending', 'retry')`,
    )
    .get().c;
  const retry = db
    .prepare(`SELECT COUNT(*) AS c FROM sync_queue WHERE sync_status = 'retry'`)
    .get().c;
  const failed = db
    .prepare(`SELECT COUNT(*) AS c FROM sync_queue WHERE sync_status = 'failed'`)
    .get().c;

  return { pending, retry, failed, lastRun };
}

function start() {
  if (cronJob) return;

  const intervalSec = Math.max(
    5,
    parseInt(process.env.SYNC_INTERVAL_SECONDS || '30', 10),
  );
  const cronExpr =
    intervalSec >= 60
      ? `0 */${Math.max(1, Math.floor(intervalSec / 60))} * * * *`
      : `*/${intervalSec} * * * * *`;

  cronJob = cron.schedule(cronExpr, () => {
    processQueue().catch((err) => {
      logger.error('SyncQueue processQueue error', { message: err.message });
    });
  });

  logger.info('SyncQueue started', { intervalSec, maxRetry: MAX_RETRY });
  processQueue().catch(() => {});
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

module.exports = {
  start,
  stop,
  enqueue,
  processQueue,
  getStatus,
};
