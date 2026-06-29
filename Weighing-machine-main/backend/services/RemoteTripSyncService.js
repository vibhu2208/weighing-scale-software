'use strict';

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cron = require('node-cron');
const pg = require('../database/pg');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { isOnline } = require('../utils/connectivity');
const { getCameraImagePath } = require('../utils/fileStorage');
const TransactionService = require('./TransactionService');
const McgPortalService = require('./McgPortalService');
const S3Service = require('./S3Service');

let cronJob = null;
let listenClient = null;
let processing = false;
let started = false;

function intervalSeconds() {
  return Math.max(
    15,
    parseInt(process.env.REMOTE_TRIP_SYNC_INTERVAL_SECONDS || '30', 10),
  );
}

function toIso(value) {
  if (!value) return ts.now();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function downloadPhotoIfPresent(s3Key, localPath) {
  const key = (s3Key || '').trim();
  if (!key) return null;
  if (!S3Service.isConfigured()) {
    logger.warn('S3 not configured — skipping photo download', { s3Key: key });
    return null;
  }
  try {
    await S3Service.downloadFile(key, localPath);
    return localPath;
  } catch (err) {
    logger.warn('Remote trip photo download failed', {
      s3Key: key,
      message: err.message,
    });
    return null;
  }
}

async function downloadRemotePhotos(row, localTxnId) {
  const date = toIso(row.timestamp_in);
  const slots = [
    { col: 'arrival_photo_1', pass: 'arrival', cam: 'cam-1' },
    { col: 'arrival_photo_2', pass: 'arrival', cam: 'cam-2' },
    { col: 'arrival_photo_3', pass: 'arrival', cam: 'cam-3' },
    { col: 'departure_photo_1', pass: 'departure', cam: 'cam-1' },
    { col: 'departure_photo_2', pass: 'departure', cam: 'cam-2' },
    { col: 'departure_photo_3', pass: 'departure', cam: 'cam-3' },
  ];

  const paths = {};
  for (const slot of slots) {
    const s3Key = row[slot.col];
    if (!s3Key) continue;
    const localPath = getCameraImagePath(localTxnId, slot.cam, slot.pass, date, {
      vehicleNumber: row.truck_number,
    });
    // eslint-disable-next-line no-await-in-loop
    const saved = await downloadPhotoIfPresent(s3Key, localPath);
    if (saved) {
      paths[slot.col] = saved;
    }
  }

  let reportPath = null;
  if (row.report_s3_key) {
    const { PATHS } = require('../utils/fileStorage');
    const reportLocal = path.join(
      PATHS.REPORTS,
      `${row.slip_number}_report.pdf`,
    );
    reportPath = await downloadPhotoIfPresent(row.report_s3_key, reportLocal);
  }

  return { ...paths, report_path: reportPath };
}

async function markRemoteTripSynced(remoteId, localId, mcgResult) {
  const mcgStatus =
    mcgResult?.skipped && mcgResult?.reason === 'not_configured'
      ? 'skipped'
      : mcgResult?.ok
        ? 'sent'
        : 'failed';

  await pg.query(
    `UPDATE remote_trips SET
      synced_to_local = true,
      synced_at = now(),
      local_id = $2,
      mcg_status = $3,
      mcg_error = $4,
      mcg_sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE mcg_sent_at END
     WHERE id = $1`,
    [
      remoteId,
      localId,
      mcgStatus,
      mcgResult?.ok ? null : mcgResult?.error || mcgResult?.reason || null,
    ],
  );
}

async function processRemoteRow(row) {
  const remoteId = row.id;
  const localTxnId = uuidv4();
  const photoPaths = await downloadRemotePhotos(row, localTxnId);

  const importResult = TransactionService.importClosedTrip({
    id: localTxnId,
    remote_pg_id: remoteId,
    slip_number: row.slip_number,
    truck_number: row.truck_number,
    rfid_tag: row.rfid_tag,
    customer_name: row.customer_name,
    destination: row.destination,
    material: row.material,
    operator_name: row.operator_name,
    gross_weight: row.gross_weight,
    tare_weight: row.tare_weight,
    timestamp_in: toIso(row.timestamp_in),
    timestamp_out: toIso(row.timestamp_out),
    arrival_photo_1: photoPaths.arrival_photo_1 || null,
    arrival_photo_2: photoPaths.arrival_photo_2 || null,
    arrival_photo_3: photoPaths.arrival_photo_3 || null,
    departure_photo_1: photoPaths.departure_photo_1 || null,
    departure_photo_2: photoPaths.departure_photo_2 || null,
    departure_photo_3: photoPaths.departure_photo_3 || null,
    report_path: photoPaths.report_path || null,
  });

  const transaction = importResult.transaction;
  if (!transaction?.id) {
    throw new Error(`Import failed for remote trip ${remoteId}`);
  }

  if (!importResult.imported && transaction.remote_pg_id !== remoteId) {
    throw new Error(
      `Slip ${row.slip_number} already exists locally with a different source`,
    );
  }

  let mcgResult = { ok: true, skipped: true, reason: 'already_sent' };
  if (row.mcg_status !== 'sent') {
    try {
      mcgResult = await McgPortalService.postClosedTicket(transaction.id);
    } catch (err) {
      mcgResult = { ok: false, error: err.message };
      logger.warn('MCG portal post failed on remote import', {
        transactionId: transaction.id,
        message: err.message,
      });
    }
  }

  if (!photoPaths.report_path) {
    try {
      const ReportService = require('./ReportService');
      const reportResult = await ReportService.exportTripPDF(transaction.id);
      if (reportResult.ok && reportResult.path) {
        TransactionService.updateFields(transaction.id, {
          report_path: reportResult.path,
        });
      }
    } catch (err) {
      logger.warn('Auto report generation failed on remote import', {
        transactionId: transaction.id,
        message: err.message,
      });
    }
  }

  await markRemoteTripSynced(remoteId, transaction.id, mcgResult);

  logger.info('Remote trip synced to local', {
    remoteId,
    localId: transaction.id,
    slip: transaction.slip_number,
    imported: importResult.imported,
  });

  return { ok: true, transactionId: transaction.id };
}

async function loadPendingRows() {
  const res = await pg.query(
    `SELECT * FROM remote_trips
     WHERE synced_to_local = false
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  return res.rows || [];
}

async function processNow() {
  if (processing) return { ok: true, skipped: true, reason: 'busy' };
  if (!pg.isConfigured()) return { ok: false, reason: 'not_configured' };

  const online = await isOnline();
  if (!online) return { ok: false, reason: 'offline' };

  const pingOk = await pg.ping();
  if (!pingOk) {
    logger.warn(
      'RemoteTripSync skipped — cannot reach PostgreSQL (check PG_SYNC_URL, RDS security group, SSL)',
    );
    return { ok: false, reason: 'ping_failed' };
  }

  processing = true;
  let processed = 0;
  let failed = 0;

  try {
    const rows = await loadPendingRows();
    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await processRemoteRow(row);
        processed += 1;
      } catch (err) {
        failed += 1;
        logger.error('Remote trip import failed', {
          remoteId: row.id,
          slip: row.slip_number,
          message: err.message,
        });
      }
    }
    return { ok: true, processed, failed };
  } finally {
    processing = false;
  }
}

async function startListen() {
  if (!pg.isConfigured()) return;
  if (listenClient) return;

  try {
    listenClient = await pg.getDedicatedClient();
    listenClient.on('error', (err) => {
      logger.warn('PostgreSQL LISTEN client error', { message: err.message });
      listenClient = null;
    });
    listenClient.on('notification', () => {
      processNow().catch((err) => {
        logger.error('RemoteTripSync notify handler error', {
          message: err.message,
        });
      });
    });
    await listenClient.query('LISTEN new_remote_trip');
    logger.info('RemoteTripSync LISTEN new_remote_trip');
  } catch (err) {
    logger.warn('RemoteTripSync LISTEN failed — poll only', {
      message: err.message,
    });
    if (listenClient) {
      try {
        listenClient.release();
      } catch (_e) {
        /* ignore */
      }
      listenClient = null;
    }
  }
}

function start() {
  if (started) return;
  if (!pg.isConfigured()) {
    logger.info('RemoteTripSync disabled — PG_SYNC_URL not configured');
    return;
  }

  started = true;
  const sec = intervalSeconds();
  const cronExpr =
    sec >= 60
      ? `0 */${Math.max(1, Math.floor(sec / 60))} * * * *`
      : `*/${sec} * * * * *`;

  cronJob = cron.schedule(cronExpr, () => {
    processNow().catch((err) => {
      logger.error('RemoteTripSync poll error', { message: err.message });
    });
  });

  logger.info('RemoteTripSync started', { intervalSec: sec });
  startListen().catch(() => {});
  processNow().then((result) => {
    if (result?.reason === 'ping_failed') {
      logger.warn(
        'RemoteTripSync initial pull failed — fix PostgreSQL connection to import remote trips',
      );
    } else if (result?.processed > 0) {
      logger.info('RemoteTripSync initial pull complete', {
        processed: result.processed,
        failed: result.failed,
      });
    }
  }).catch((err) => {
    logger.error('RemoteTripSync initial pull error', { message: err.message });
  });
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  if (listenClient) {
    try {
      listenClient.query('UNLISTEN new_remote_trip').catch(() => {});
      listenClient.release();
    } catch (_e) {
      /* ignore */
    }
    listenClient = null;
  }
  started = false;
}

module.exports = {
  start,
  stop,
  processNow,
};
