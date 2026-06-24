'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const TransactionService = require('./TransactionService');
const SettingsService = require('./SettingsService');
const { toPublicTransaction } = require('../utils/transactionPublic');
const { SYNC_STATUS } = require('../utils/constants');

/** Settings UI + SQLite settings table; falls back to .env via SettingsService. */
function getCloudConfig() {
  const url = (SettingsService.get('CLOUD_SYNC_URL') || '').trim();
  const token = (SettingsService.get('CLOUD_SYNC_TOKEN') || '').trim();
  return { url, token };
}

function isCloudConfigured() {
  const { url } = getCloudConfig();
  return !!url && !url.includes('example.com');
}

const SyncService = {
  isCloudConfigured,

  async testConnection() {
    const { url, token } = getCloudConfig();
    if (!url) return false;
    try {
      const res = await axios.get(`${url.replace(/\/$/, '')}/ping`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 8000,
        validateStatus: () => true,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  },

  async uploadTransaction(transactionId) {
    if (!isCloudConfigured()) {
      logger.warn('Cloud sync not configured — skipping', { transactionId });
      TransactionService.markSynced(transactionId);
      return { ok: true, skipped: true, reason: 'not_configured' };
    }

    const transaction = TransactionService.getById(transactionId);
    if (!transaction) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }

    const { url, token } = getCloudConfig();
    const endpoint = `${url.replace(/\/$/, '')}/transactions`;

    try {
      const publicTxn = toPublicTransaction(transaction);
      const res = await axios.post(
        endpoint,
        {
          ...publicTxn,
          vehicle: publicTxn.vehicle || transaction.vehicle || null,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );

      if (res.status === 401) {
        const err = new Error('Cloud sync token invalid (401)');
        err.noRetry = true;
        err.critical = true;
        throw err;
      }

      if (res.status === 429) {
        const err = new Error('Cloud rate limited (429)');
        err.retry = true;
        throw err;
      }

      if (res.status >= 500) {
        const err = new Error(`Cloud server error (${res.status})`);
        err.retry = true;
        throw err;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Cloud sync failed with status ${res.status}`);
      }

      TransactionService.markSynced(transactionId);
      return { ok: true, status: res.status };
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
        const retryErr = new Error(`Network timeout: ${err.message}`);
        retryErr.retry = true;
        throw retryErr;
      }
      throw err;
    }
  },

  async uploadBatch(transactionIds = []) {
    const results = [];
    for (const id of transactionIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.uploadTransaction(id);
        results.push({ id, ok: true, ...r });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    return results;
  },

  async triggerManualSync() {
    const pending = TransactionService.getUnsyncedTransactions();
    let pushed = 0;
    let failed = 0;
    for (const txn of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.uploadTransaction(txn.id);
        pushed += 1;
      } catch {
        failed += 1;
      }
    }
    return { ok: true, pushed, failed };
  },

  getQueueStatus() {
    const { getDb } = require('../database/db');
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
    return { pending, retry, failed };
  },

  async getHistory(limit = 50) {
    const { getDb } = require('../database/db');
    return getDb()
      .prepare(
        `SELECT sq.*, t.truck_number, t.slip_number
         FROM sync_queue sq
         JOIN transactions t ON t.id = sq.transaction_id
         ORDER BY sq.created_at DESC
         LIMIT ?`,
      )
      .all(limit);
  },
};

module.exports = SyncService;
