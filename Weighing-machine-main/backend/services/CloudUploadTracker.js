'use strict';

const { getDb } = require('../database/db');

const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];

function getByPath(filePath) {
  return getDb()
    .prepare('SELECT * FROM cloud_uploads WHERE file_path = ?')
    .get(filePath);
}

function isUploaded(filePath) {
  const row = getByPath(filePath);
  return row && row.uploaded === 1;
}

function register(filePath, fileType, s3Key) {
  const existing = getByPath(filePath);
  if (existing) return existing;
  getDb()
    .prepare(
      `INSERT INTO cloud_uploads (file_path, file_type, s3_key, uploaded, retry_count)
       VALUES (?, ?, ?, 0, 0)`,
    )
    .run(filePath, fileType, s3Key);
  return getByPath(filePath);
}

function markUploaded(filePath) {
  getDb()
    .prepare(
      `UPDATE cloud_uploads
       SET uploaded = 1, uploaded_at = datetime('now')
       WHERE file_path = ?`,
    )
    .run(filePath);
}

function markFailed(filePath) {
  getDb()
    .prepare(
      `UPDATE cloud_uploads
       SET retry_count = retry_count + 1,
           uploaded_at = datetime('now')
       WHERE file_path = ?`,
    )
    .run(filePath);
}

/** uploaded_at doubles as last_attempt when uploaded = 0 */
function isReadyForRetry(row) {
  if (!row || row.uploaded === 1) return false;
  if (row.retry_count >= MAX_RETRIES) return false;
  if (row.retry_count === 0) return true;
  const idx = Math.min(row.retry_count - 1, RETRY_DELAYS_MS.length - 1);
  const delay = RETRY_DELAYS_MS[idx];
  const last = new Date(row.uploaded_at || row.created_at).getTime();
  return Date.now() >= last + delay;
}

function getPendingUploads() {
  return getDb()
    .prepare(
      `SELECT * FROM cloud_uploads
       WHERE uploaded = 0 AND retry_count < ?
       ORDER BY created_at ASC`,
    )
    .all(MAX_RETRIES)
    .filter(isReadyForRetry);
}

function getStatusSummary() {
  const db = getDb();
  const pending = db
    .prepare(`SELECT COUNT(*) AS c FROM cloud_uploads WHERE uploaded = 0 AND retry_count < ?`)
    .get(MAX_RETRIES).c;
  const done = db
    .prepare(`SELECT COUNT(*) AS c FROM cloud_uploads WHERE uploaded = 1`)
    .get().c;
  const failed = db
    .prepare(`SELECT COUNT(*) AS c FROM cloud_uploads WHERE uploaded = 0 AND retry_count >= ?`)
    .get(MAX_RETRIES).c;
  return { pending, uploaded: done, exhausted: failed };
}

module.exports = {
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  getByPath,
  isUploaded,
  register,
  markUploaded,
  markFailed,
  getPendingUploads,
  getStatusSummary,
  isReadyForRetry,
};
