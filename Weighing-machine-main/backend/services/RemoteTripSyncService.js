'use strict';

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cron = require('node-cron');
const pg = require('../database/pg');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { getCameraImagePath } = require('../utils/fileStorage');
const TransactionService = require('./TransactionService');
const SlipNumberService = require('./SlipNumberService');
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

function formatSlip(num) {
  return `WB${String(num).padStart(4, '0')}`;
}

async function allocateUniqueSlip() {
  const localMax = SlipNumberService.getMaxLocalSlipNumeric();
  const rdsCounter = await pg.getSlipCounterValue();
  const remoteMaxRes = await pg.query(
    `SELECT MAX(CAST(substring(slip_number from 3) AS BIGINT)) AS m
     FROM remote_trips WHERE slip_number ~ '^WB[0-9]+$'`,
  );
  const remoteMax = Number(remoteMaxRes.rows[0]?.m || 0);
  let nextNum = Math.max(localMax, Number(rdsCounter || 0), remoteMax) + 1;

  for (let i = 0; i < 100; i += 1) {
    const candidate = formatSlip(nextNum);
    const localHit = TransactionService.getBySlipNumber(candidate);
    const remoteHit = await pg.query(
      'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
      [candidate],
    );
    if (!localHit && !remoteHit.rows.length) {
      await pg.syncSlipCounterToMax(nextNum);
      return candidate;
    }
    nextNum += 1;
  }
  throw new Error('Could not allocate a free slip number for remote trip remapping');
}

async function remappingRemoteSlip(row, localConflict) {
  const oldSlip = row.slip_number;
  const newSlip = await allocateUniqueSlip();
  await pg.query(
    `UPDATE remote_trips
     SET slip_number = $2,
         synced_to_local = false,
         synced_at = NULL,
         local_id = NULL,
         mcg_status = CASE WHEN mcg_status = 'sent' THEN mcg_status ELSE 'pending' END,
         mcg_error = NULL
     WHERE id = $1`,
    [row.id, newSlip],
  );

  // Drop stale admin mirror row for the old slip so it cannot block reuse.
  try {
    const siteId = (process.env.CLOUD_ADMIN_SITE_ID || process.env.SITE_ID || 'WB-03').trim();
    await pg.query(
      `DELETE FROM transactions_mirror
       WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)`,
      [siteId, oldSlip],
    );
  } catch (err) {
    logger.warn('Failed to clear mirror row after remote slip remap', {
      oldSlip,
      newSlip,
      message: err.message,
    });
  }

  logger.warn('Remote trip slip remapped due to local conflict', {
    remoteId: row.id,
    oldSlip,
    newSlip,
    remoteTruck: row.truck_number,
    localTruck: localConflict?.truck_number || null,
    localId: localConflict?.id || null,
  });
  row.slip_number = newSlip;
  return newSlip;
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

async function processRemoteRow(row, attempt = 0) {
  const remoteId = row.id;

  const alreadyImported = TransactionService.getByRemotePgId(remoteId);
  if (alreadyImported) {
    // Photos may have been attached after the first import — backfill missing local files.
    try {
      const photoPaths = await downloadRemotePhotos(row, alreadyImported.id);
      const photoUpdates = {};
      for (const col of [
        'arrival_photo_1',
        'arrival_photo_2',
        'arrival_photo_3',
        'departure_photo_1',
        'departure_photo_2',
        'departure_photo_3',
      ]) {
        if (photoPaths[col] && !alreadyImported[col]) {
          photoUpdates[col] = photoPaths[col];
        }
      }
      if (photoPaths.report_path && !alreadyImported.report_path) {
        photoUpdates.report_path = photoPaths.report_path;
      }
      if (Object.keys(photoUpdates).length) {
        TransactionService.updateFields(alreadyImported.id, photoUpdates);
        logger.info('Backfilled remote trip photos onto local ticket', {
          remoteId,
          localId: alreadyImported.id,
          slip: alreadyImported.slip_number,
          fields: Object.keys(photoUpdates),
        });
      }
    } catch (err) {
      logger.warn('Remote trip photo backfill failed', {
        remoteId,
        message: err.message,
      });
    }

    await markRemoteTripSynced(remoteId, alreadyImported.id, {
      ok: true,
      skipped: true,
      reason: 'already_sent',
    });
    // Local may have remapped slip / edited fields — refresh remote_trips + mirror.
    try {
      const CloudAdminSyncService = require('./CloudAdminSyncService');
      const refreshed = TransactionService.getById(alreadyImported.id) || alreadyImported;
      await CloudAdminSyncService.syncRemoteTripFromLocal(refreshed);
      CloudAdminSyncService.enqueuePush(alreadyImported.id);
    } catch (_e) {
      /* optional */
    }
    return { ok: true, reason: 'already_imported', transactionId: alreadyImported.id };
  }

  const slipOwner = TransactionService.getBySlipNumber(row.slip_number);
  if (slipOwner && slipOwner.remote_pg_id !== remoteId) {
    await remappingRemoteSlip(row, slipOwner);
  }

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
    // Remote trips are DCC-only — never import as another company
    company: 'DCC',
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

  // Ensure vehicle type is set (HYWA needs timestamp_in = gross on reports).
  try {
    const VehicleService = require('./VehicleService');
    const vType = row.vehicle_type ? String(row.vehicle_type).trim() : 'HYWA';
    const existing = VehicleService.findByNumber(row.truck_number);
    if (!existing) {
      VehicleService.create({
        vehicle_number: row.truck_number,
        rfid_tag: row.rfid_tag || null,
        transporter: row.transporter || null,
        vehicle_type: vType,
        status: 'active',
      });
    } else if (
      vType &&
      String(existing.vehicle_type || '').toLowerCase() !== vType.toLowerCase()
    ) {
      VehicleService.update(existing.id, { vehicle_type: vType });
    }
  } catch (err) {
    logger.warn('Remote trip vehicle type sync failed', {
      truck: row.truck_number,
      message: err.message,
    });
  }

  if (!importResult.imported && transaction.remote_pg_id !== remoteId) {
    logger.warn('Remote trip import hit slip conflict after remapping check — retrying', {
      remoteId,
      slip: row.slip_number,
      remoteTruck: row.truck_number,
      localId: transaction.id,
      localTruck: transaction.truck_number,
    });
    if (attempt >= 3) {
      throw new Error(
        `Slip ${row.slip_number} still conflicts locally after remapping (truck ${transaction.truck_number})`,
      );
    }
    await remappingRemoteSlip(row, transaction);
    return processRemoteRow(row, attempt + 1);
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

  // Push into transactions_mirror so the admin Reports panel sees this trip.
  // Remote imports skip TripCaptureService, which normally calls enqueuePush.
  try {
    const CloudAdminSyncService = require('./CloudAdminSyncService');
    CloudAdminSyncService.enqueuePush(transaction.id);
    CloudAdminSyncService.processNow().catch((err) => {
      logger.warn('CloudAdminSync push after remote import failed', {
        transactionId: transaction.id,
        message: err.message,
      });
    });
  } catch (err) {
    logger.warn('CloudAdminSync enqueue after remote import failed', {
      transactionId: transaction.id,
      message: err.message,
    });
  }

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
        OR (
          mcg_error IS NOT NULL
          AND (
            mcg_error ILIKE '%already exists%'
            OR mcg_error ILIKE '%slip%conflict%'
          )
        )
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  return res.rows || [];
}

async function processNow() {
  if (processing) return { ok: true, skipped: true, reason: 'busy' };
  if (!pg.isConfigured()) return { ok: false, reason: 'not_configured' };

  // Gate on Postgres itself — generic amazonaws.com DNS can fail while RDS still works.
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
  processRemoteRow,
};
