'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pg = require('../database/pg');
const logger = require('../utils/logger');
const { isOnline } = require('../utils/connectivity');
const { TICKET_STATUS } = require('../utils/constants');
const TransactionService = require('./TransactionService');
const SettingsService = require('./SettingsService');
const S3Service = require('./S3Service');
const AdminReportService = require('./AdminReportService');

let cronJob = null;
let catchUpJob = null;
let listenClient = null;
let processing = false;
let started = false;
const pushQueue = new Set();

const REMOTE_SAFE_KEYS = new Set([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
  'COMPANY_NAME',
  'COMPANY_ADDRESS',
  'COMPANY_PHONE',
  'SITE_NAME',
  'WEIGHBRIDGE_ID',
  'REPORT_COMPANY_NAME',
  'REPORT_LOGO_PATH',
  'materials_list',
  'customers_list',
  'destinations_list',
  'operators_list',
]);

function intervalSeconds() {
  return Math.max(15, parseInt(process.env.ADMIN_SYNC_INTERVAL_SECONDS || '30', 10));
}

function getSiteId() {
  return (process.env.WEIGHBRIDGE_ID || SettingsService.get('WEIGHBRIDGE_ID') || 'WB-03').trim();
}

function enqueuePush(transactionId) {
  if (transactionId) pushQueue.add(transactionId);
}

async function uploadLocalFileIfExists(localPath, s3Key) {
  if (!localPath || !S3Service.isConfigured()) return null;
  const normalized = path.resolve(localPath);
  if (!fs.existsSync(normalized)) return null;
  try {
    await S3Service.uploadFile(normalized, s3Key);
    return s3Key;
  } catch (err) {
    logger.warn('CloudAdminSync upload failed', { s3Key, message: err.message });
    return null;
  }
}

async function buildMirrorPhotoKeys(txn) {
  const siteId = getSiteId();
  const slip = txn.slip_number;
  const keys = {};
  const slots = [
    { col: 'arrival_photo_1', pass: 'arrival', slot: 1 },
    { col: 'arrival_photo_2', pass: 'arrival', slot: 2 },
    { col: 'arrival_photo_3', pass: 'arrival', slot: 3 },
    { col: 'departure_photo_1', pass: 'departure', slot: 1 },
    { col: 'departure_photo_2', pass: 'departure', slot: 2 },
    { col: 'departure_photo_3', pass: 'departure', slot: 3 },
  ];
  for (const { col, pass, slot } of slots) {
    if (!txn[col]) continue;
    const s3Key = S3Service.mirrorPhotoKey(siteId, slip, slot, pass);
    const uploaded = await uploadLocalFileIfExists(txn[col], s3Key);
    if (uploaded) keys[col] = uploaded;
  }
  return keys;
}

async function pushTransaction(txn) {
  if (!txn?.id || txn.ticket_status !== TICKET_STATUS.CLOSED) {
    return { ok: false, skipped: true };
  }

  const siteId = getSiteId();
  const photoKeys = await buildMirrorPhotoKeys(txn);
  let reportS3Key = null;
  if (txn.report_path) {
    reportS3Key = await uploadLocalFileIfExists(
      txn.report_path,
      S3Service.mirrorReportKey(siteId, txn.slip_number),
    );
  }

  await pg.query(
    `INSERT INTO transactions_mirror (
      site_id, local_id, slip_number, truck_number, rfid_tag,
      customer_name, destination, material, operator_name, transporter, vehicle_type,
      gross_weight, tare_weight, timestamp_in, timestamp_out,
      ticket_status, sync_status, mcg_status, mcg_error,
      arrival_photo_1, arrival_photo_2, arrival_photo_3,
      departure_photo_1, departure_photo_2, departure_photo_3,
      report_s3_key, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26, now()
    )
    ON CONFLICT (site_id, local_id) DO UPDATE SET
      slip_number = EXCLUDED.slip_number,
      truck_number = EXCLUDED.truck_number,
      rfid_tag = EXCLUDED.rfid_tag,
      customer_name = EXCLUDED.customer_name,
      destination = EXCLUDED.destination,
      material = EXCLUDED.material,
      operator_name = EXCLUDED.operator_name,
      transporter = EXCLUDED.transporter,
      vehicle_type = EXCLUDED.vehicle_type,
      gross_weight = EXCLUDED.gross_weight,
      tare_weight = EXCLUDED.tare_weight,
      timestamp_in = EXCLUDED.timestamp_in,
      timestamp_out = EXCLUDED.timestamp_out,
      ticket_status = EXCLUDED.ticket_status,
      sync_status = EXCLUDED.sync_status,
      mcg_status = EXCLUDED.mcg_status,
      mcg_error = EXCLUDED.mcg_error,
      arrival_photo_1 = COALESCE(EXCLUDED.arrival_photo_1, transactions_mirror.arrival_photo_1),
      arrival_photo_2 = COALESCE(EXCLUDED.arrival_photo_2, transactions_mirror.arrival_photo_2),
      arrival_photo_3 = COALESCE(EXCLUDED.arrival_photo_3, transactions_mirror.arrival_photo_3),
      departure_photo_1 = COALESCE(EXCLUDED.departure_photo_1, transactions_mirror.departure_photo_1),
      departure_photo_2 = COALESCE(EXCLUDED.departure_photo_2, transactions_mirror.departure_photo_2),
      departure_photo_3 = COALESCE(EXCLUDED.departure_photo_3, transactions_mirror.departure_photo_3),
      report_s3_key = COALESCE(EXCLUDED.report_s3_key, transactions_mirror.report_s3_key),
      updated_at = now()`,
    [
      siteId, txn.id, txn.slip_number, txn.truck_number, txn.rfid_tag || null,
      txn.customer_name || null, txn.destination || null, txn.material || null,
      txn.operator_name || null, txn.vehicle?.transporter || txn.transporter || null,
      txn.vehicle?.vehicle_type || txn.vehicle_type || null,
      txn.gross_weight, txn.tare_weight, txn.timestamp_in || null, txn.timestamp_out || null,
      txn.ticket_status, txn.sync_status || null, txn.mcg_status || null, txn.mcg_error || null,
      photoKeys.arrival_photo_1 || null, photoKeys.arrival_photo_2 || null, photoKeys.arrival_photo_3 || null,
      photoKeys.departure_photo_1 || null, photoKeys.departure_photo_2 || null, photoKeys.departure_photo_3 || null,
      reportS3Key,
    ],
  );

  return { ok: true, slip: txn.slip_number };
}

async function deleteMirrorRow(slipNumber) {
  await pg.query(
    'DELETE FROM transactions_mirror WHERE site_id = $1 AND slip_number = $2',
    [getSiteId(), slipNumber],
  );
}

async function processPushQueue() {
  const ids = [...pushQueue];
  pushQueue.clear();
  for (const id of ids) {
    const txn = TransactionService.getById(id);
    if (txn) {
      try {
        await pushTransaction(txn);
      } catch (err) {
        logger.warn('CloudAdminSync push failed', { id, message: err.message });
      }
    }
  }
}

async function pushRecentClosed() {
  const { getDb } = require('../database/db');
  const rows = getDb()
    .prepare(
      `SELECT id FROM transactions WHERE ticket_status = ?
       ORDER BY COALESCE(timestamp_out, updated_at) DESC LIMIT 100`,
    )
    .all(TICKET_STATUS.CLOSED);
  for (const row of rows) {
    const txn = TransactionService.getById(row.id);
    if (txn) {
      try {
        await pushTransaction(txn);
      } catch (err) {
        logger.warn('CloudAdminSync catch-up failed', { id: row.id, message: err.message });
      }
    }
  }
}

async function heartbeat() {
  const siteId = getSiteId();
  await pg.query(
    `INSERT INTO sites (id, name, last_seen_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
    [siteId, SettingsService.get('SITE_NAME') || siteId],
  );
}

async function markCommand(id, status, error) {
  await pg.query(
    `UPDATE admin_commands SET status = $2, error = $3,
      applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
     WHERE id = $1`,
    [id, status, error || null],
  );
}

async function applyCommand(row) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
  if (row.type === 'edit_report') {
    await AdminReportService.applyRemoteUpdate(payload);
    await deleteMirrorRow(payload.slipNumber);
    const txn = TransactionService.getBySlipNumber(payload.slipNumber);
    if (txn) await pushTransaction(txn);
    return;
  }
  if (row.type === 'delete_report') {
    await AdminReportService.applyRemoteDelete(payload);
    await deleteMirrorRow(payload.slipNumber);
    return;
  }
  throw new Error(`Unknown command type: ${row.type}`);
}

async function pullCommands() {
  const res = await pg.query(
    `SELECT id, type, payload FROM admin_commands
     WHERE site_id = $1 AND status = 'pending'
     ORDER BY created_at ASC LIMIT 20`,
    [getSiteId()],
  );
  for (const row of res.rows || []) {
    try {
      await applyCommand(row);
      await markCommand(row.id, 'applied', null);
    } catch (err) {
      await markCommand(row.id, 'failed', err.message);
      logger.error('CloudAdminSync command failed', { id: row.id, message: err.message });
    }
  }
}

async function pullSettings() {
  const res = await pg.query('SELECT key, value FROM site_settings WHERE site_id = $1', [
    getSiteId(),
  ]);
  for (const row of res.rows || []) {
    if (!REMOTE_SAFE_KEYS.has(row.key)) continue;
    if (SettingsService.get(row.key) !== row.value) {
      SettingsService.set(row.key, row.value);
      logger.info('CloudAdminSync applied setting', { key: row.key });
    }
  }
}

async function processNow() {
  if (processing) return { ok: true, skipped: true };
  if (!pg.isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!(await isOnline())) return { ok: false, reason: 'offline' };
  if (!(await pg.ping())) return { ok: false, reason: 'ping_failed' };

  processing = true;
  try {
    await heartbeat();
    await processPushQueue();
    await pullCommands();
    await pullSettings();
    await pg.query('UPDATE sites SET last_push_at = now() WHERE id = $1', [getSiteId()]);
    return { ok: true };
  } finally {
    processing = false;
  }
}

async function startListen() {
  if (!pg.isConfigured() || listenClient) return;
  try {
    listenClient = await pg.getDedicatedClient();
    listenClient.on('error', () => { listenClient = null; });
    listenClient.on('notification', () => {
      processNow().catch((err) => {
        logger.error('CloudAdminSync notify error', { message: err.message });
      });
    });
    await listenClient.query('LISTEN new_admin_command');
    await listenClient.query('LISTEN site_settings_changed');
  } catch (err) {
    logger.warn('CloudAdminSync LISTEN failed', { message: err.message });
    if (listenClient) {
      try { listenClient.release(); } catch (_e) { /* ignore */ }
      listenClient = null;
    }
  }
}

function start() {
  if (started) return;
  if (!pg.isConfigured()) {
    logger.info('CloudAdminSync disabled — PG_SYNC_URL not configured');
    return;
  }
  started = true;
  const sec = intervalSeconds();
  const cronExpr = sec >= 60 ? `0 */${Math.max(1, Math.floor(sec / 60))} * * * *` : `*/${sec} * * * * *`;
  cronJob = cron.schedule(cronExpr, () => processNow().catch(() => {}));
  catchUpJob = cron.schedule('0 * * * * *', () => pushRecentClosed().catch(() => {}));
  logger.info('CloudAdminSync started', { siteId: getSiteId(), intervalSec: sec });
  startListen().catch(() => {});
  processNow().catch(() => {});
  pushRecentClosed().catch(() => {});
}

function stop() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (catchUpJob) { catchUpJob.stop(); catchUpJob = null; }
  if (listenClient) {
    try { listenClient.release(); } catch (_e) { /* ignore */ }
    listenClient = null;
  }
  started = false;
}

module.exports = {
  start, stop, processNow, enqueuePush, pushTransaction, deleteMirrorRow,
};
