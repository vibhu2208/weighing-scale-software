'use strict';

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pg = require('../database/pg');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { getCameraImagePath } = require('../utils/fileStorage');
const {
  setPassSnapshots,
  existingPassSnapshots,
  photoColumnUpdates,
  cameraSlotFromId,
  mergeSnapshotsBySlot,
} = require('../utils/tripPhotos');
const { resolveVehicleType, isHywa } = require('../utils/vehicleTypes');
const { compressImageForPdfAsync } = require('../utils/pdfImageCompress');
const { siteIdAliases } = require('../utils/siteId');
const TransactionService = require('./TransactionService');
const SlipNumberService = require('./SlipNumberService');
const McgPortalService = require('./McgPortalService');
const S3Service = require('./S3Service');

const PHOTO_SLOTS = [
  { col: 'arrival_photo_1', pass: 'arrival', cam: 'cam-1', slot: 1 },
  { col: 'arrival_photo_2', pass: 'arrival', cam: 'cam-2', slot: 2 },
  { col: 'arrival_photo_3', pass: 'arrival', cam: 'cam-3', slot: 3 },
  { col: 'departure_photo_1', pass: 'departure', cam: 'cam-1', slot: 1 },
  { col: 'departure_photo_2', pass: 'departure', cam: 'cam-2', slot: 2 },
  { col: 'departure_photo_3', pass: 'departure', cam: 'cam-3', slot: 3 },
];

let cronJob = null;
let listenClient = null;
let processing = false;
let rerunRequested = false;
let started = false;
const pendingLocalIds = new Map();
const photoMissCounts = new Map();
const mirrorPushIds = [];
let mirrorPushActive = false;

const PHOTO_DOWNLOAD_CONCURRENCY = 4;
const MAX_PHOTO_MISS_CYCLES = 3;

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

function localPhotoExists(filePath) {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 32;
  } catch (_e) {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isJpegFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(3);
    const n = fs.readSync(fd, buf, 0, 3, 0);
    return n >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  } catch (_e) {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

async function runPool(items, limit, worker) {
  if (!items.length) return;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function ensureJpegOnDisk(filePath) {
  if (!localPhotoExists(filePath)) return filePath;
  if (isJpegFile(filePath)) return filePath;
  try {
    const converted = await compressImageForPdfAsync(filePath, {
      maxWidth: 1920,
      quality: 85,
      asJpeg: true,
    });
    if (converted?.buffer?.length) {
      await fs.promises.writeFile(filePath, converted.buffer);
    }
  } catch (err) {
    logger.warn('Remote trip photo JPEG convert failed', {
      path: filePath,
      message: err.message,
    });
  }
  return filePath;
}

async function downloadPhotoIfPresent(s3Key, localPath, options = {}) {
  const key = (s3Key || '').trim();
  if (!key) return null;
  if (!S3Service.isConfigured()) {
    logger.warn('S3 not configured — skipping photo download', { s3Key: key });
    return null;
  }

  const save = async () => {
    await S3Service.downloadFile(key, localPath);
    if (options.convertImage !== false && !/\.pdf$/i.test(key)) {
      await ensureJpegOnDisk(localPath);
    }
    return localPath;
  };

  try {
    return await save();
  } catch (err) {
    if (!S3Service.isMissingObject(err)) throw err;
    await delay(600);
    try {
      return await save();
    } catch (retryErr) {
      if (S3Service.isMissingObject(retryErr)) return null;
      throw retryErr;
    }
  }
}

function inferPhotoSlotFromKey(s3Key) {
  const base = String(s3Key || '')
    .split('/')
    .pop()
    .toLowerCase();
  if (!base) return null;
  const arrivalCam = base.match(/arrival[-_]?cam[-_]?(\d)/);
  if (arrivalCam) {
    return { pass: 'arrival', slot: Number(arrivalCam[1]), col: `arrival_photo_${arrivalCam[1]}` };
  }
  const departureCam = base.match(/departure[-_]?cam[-_]?(\d)/);
  if (departureCam) {
    return {
      pass: 'departure',
      slot: Number(departureCam[1]),
      col: `departure_photo_${departureCam[1]}`,
    };
  }
  const ac = base.match(/(?:^|[-_])ac(\d)/);
  if (ac) return { pass: 'arrival', slot: Number(ac[1]), col: `arrival_photo_${ac[1]}` };
  const dc = base.match(/(?:^|[-_])dc(\d)/);
  if (dc) return { pass: 'departure', slot: Number(dc[1]), col: `departure_photo_${dc[1]}` };
  return null;
}

function extraKeyAllowed(s3Key, row) {
  const key = String(s3Key || '').trim();
  const slip = String(row.slip_number || '');
  if (!key) return false;
  if (slip && key.includes(`/${slip}/`)) return true;
  for (const slot of PHOTO_SLOTS) {
    const colVal = String(row[slot.col] || '').trim();
    if (!colVal) continue;
    if (colVal === key) return true;
    const remotePrefix = colVal.match(/^(remote-trips\/WB\d+\/)/i);
    const mirrorPrefix = colVal.match(/^(sites\/[^/]+\/mirror\/WB\d+\/)/i);
    if (remotePrefix && key.startsWith(remotePrefix[1])) return true;
    if (mirrorPrefix && key.startsWith(mirrorPrefix[1])) return true;
  }
  return false;
}

async function collectCandidateS3Keys(row) {
  const keys = [];
  const seen = new Set();
  const add = (value) => {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) return;
    if (key.toLowerCase().endsWith('.pdf')) return;
    seen.add(key);
    keys.push(key);
  };

  for (const slot of PHOTO_SLOTS) add(row[slot.col]);

  const slip = row.slip_number;
  const prefixes = new Set();
  if (slip) prefixes.add(`remote-trips/${slip}/`);
  for (const key of keys) {
    const remotePrefix = key.match(/^(remote-trips\/WB\d+\/)/i);
    const mirrorPrefix = key.match(/^(sites\/[^/]+\/mirror\/WB\d+\/)/i);
    if (remotePrefix) prefixes.add(remotePrefix[1]);
    if (mirrorPrefix) prefixes.add(mirrorPrefix[1]);
  }

  try {
    const SettingsService = require('./SettingsService');
    const site =
      process.env.WEIGHBRIDGE_ID || SettingsService.get('WEIGHBRIDGE_ID') || 'WB-03';
    for (const sid of siteIdAliases(site)) {
      if (slip) prefixes.add(`sites/${sid}/mirror/${slip}/`);
    }
  } catch (_e) {
    /* settings optional during scripts */
  }

  if (slip && pg.isConfigured()) {
    try {
      const mirror = await pg.query(
        `SELECT arrival_photo_1, arrival_photo_2, arrival_photo_3,
                departure_photo_1, departure_photo_2, departure_photo_3
         FROM transactions_mirror WHERE slip_number = $1`,
        [slip],
      );
      for (const mrow of mirror.rows || []) {
        for (const slot of PHOTO_SLOTS) add(mrow[slot.col]);
      }
    } catch (_e) {
      /* mirror table may be unavailable */
    }
  }

  const listedGroups = await Promise.all(
    [...prefixes].map(async (prefix) => {
      try {
        return await S3Service.listKeys(prefix, 80);
      } catch (_e) {
        return [];
      }
    }),
  );
  for (const listed of listedGroups) {
    for (const key of listed) {
      if (/\.(jpe?g|png|webp|gif)$/i.test(key)) add(key);
    }
  }

  return keys.filter((key) => extraKeyAllowed(key, row));
}

function isS3ObjectKey(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  if (/^[a-zA-Z]:[\\/]/.test(key)) return false;
  if (key.startsWith('\\\\') || key.startsWith('//')) return false;
  return /^(remote-trips|sites)\//.test(key.replace(/\\/g, '/'));
}

async function downloadRemotePhotos(row, localTxnId, extraKeys = []) {
  const date = toIso(row.timestamp_in || row.timestamp_out);
  const truckNumber = row.truck_number;
  const usedS3Keys = {};
  const paths = {};
  const jobs = [];

  for (const slot of PHOTO_SLOTS) {
    const s3Key = row[slot.col];
    if (!s3Key) continue;
    if (!isS3ObjectKey(s3Key)) {
      if (localPhotoExists(s3Key)) paths[slot.col] = s3Key;
      continue;
    }
    const localPath = getCameraImagePath(localTxnId, slot.cam, slot.pass, date, {
      vehicleNumber: truckNumber,
    });
    const key = String(s3Key).trim();
    if (localPhotoExists(localPath)) {
      paths[slot.col] = localPath;
      usedS3Keys[slot.col] = key;
      continue;
    }
    jobs.push({ col: slot.col, s3Key: key, localPath });
  }

  for (const s3Key of extraKeys || []) {
    if (!extraKeyAllowed(s3Key, row)) continue;
    const inferred = inferPhotoSlotFromKey(s3Key);
    if (!inferred || paths[inferred.col] || jobs.some((job) => job.col === inferred.col)) continue;
    const localPath = getCameraImagePath(
      localTxnId,
      `cam-${inferred.slot}`,
      inferred.pass,
      date,
      { vehicleNumber: truckNumber },
    );
    if (localPhotoExists(localPath)) {
      paths[inferred.col] = localPath;
      usedS3Keys[inferred.col] = s3Key;
      continue;
    }
    jobs.push({ col: inferred.col, s3Key, localPath });
  }

  await runPool(jobs, PHOTO_DOWNLOAD_CONCURRENCY, async (job) => {
    try {
      const saved = await downloadPhotoIfPresent(job.s3Key, job.localPath);
      if (!saved) return;
      paths[job.col] = saved;
      usedS3Keys[job.col] = job.s3Key;
    } catch (err) {
      logger.warn('Remote trip photo download failed', {
        s3Key: job.s3Key,
        slip: row.slip_number,
        message: err.message,
      });
    }
  });

  let reportPath = null;
  if (row.report_s3_key) {
    const { PATHS } = require('../utils/fileStorage');
    const reportLocal = path.join(
      PATHS.REPORTS,
      `${row.slip_number}_report.pdf`,
    );
    try {
      reportPath = await downloadPhotoIfPresent(row.report_s3_key, reportLocal, {
        convertImage: false,
      });
    } catch (err) {
      logger.warn('Remote trip report download failed', {
        slip: row.slip_number,
        message: err.message,
      });
    }
  }

  return { ...paths, report_path: reportPath, _s3Keys: usedS3Keys };
}

function assertPhotosReady(row, photoPaths) {
  const missing = [];
  for (const slot of PHOTO_SLOTS) {
    const key = row[slot.col];
    if (!isS3ObjectKey(key)) continue;
    if (!localPhotoExists(photoPaths?.[slot.col])) missing.push(slot.col);
  }
  if (!missing.length) {
    photoMissCounts.delete(row.id);
    return;
  }
  const attempt = (photoMissCounts.get(row.id) || 0) + 1;
  photoMissCounts.set(row.id, attempt);
  if (attempt <= MAX_PHOTO_MISS_CYCLES) {
    throw new Error(
      `Photos not on the weighbridge yet for ${row.slip_number}: ${missing.join(', ')} (attempt ${attempt})`,
    );
  }
  logger.error('Remote trip continuing with photos still missing', {
    remoteId: row.id,
    slip: row.slip_number,
    missing,
  });
}

function enqueueMirrorPush(transactionId) {
  if (!transactionId || mirrorPushIds.includes(transactionId)) return;
  mirrorPushIds.push(transactionId);
  drainMirrorPushes().catch((err) => {
    logger.warn('Remote trip mirror push failed', { message: err.message });
  });
}

async function drainMirrorPushes() {
  if (mirrorPushActive) return;
  mirrorPushActive = true;
  try {
    const CloudAdminSyncService = require('./CloudAdminSyncService');
    while (mirrorPushIds.length) {
      const id = mirrorPushIds.shift();
      const latest = TransactionService.getById(id);
      if (!latest) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await CloudAdminSyncService.pushTransaction(latest);
      } catch (err) {
        logger.warn('Photo sync cloud mirror push failed', {
          slip: latest.slip_number,
          message: err.message,
        });
      }
    }
  } finally {
    mirrorPushActive = false;
    if (mirrorPushIds.length) {
      drainMirrorPushes().catch(() => {});
    }
  }
}

function applyLocalPhotoUpdates(txn, photoPaths) {
  if (!txn?.id) return { updated: false };
  const vehicleType = resolveVehicleType(
    { vehicle_type: txn.vehicle?.vehicle_type || txn.vehicle_type },
    txn,
  );
  const updates = {};
  let snapshots = txn.camera_snapshots;

  for (const pass of ['arrival', 'departure']) {
    const newSnapshots = [];
    for (const slot of PHOTO_SLOTS.filter((item) => item.pass === pass)) {
      const nextPath = photoPaths[slot.col];
      if (!localPhotoExists(nextPath)) continue;
      if (localPhotoExists(txn[slot.col])) continue;
      updates[slot.col] = nextPath;
      newSnapshots.push({
        id: slot.cam,
        label: `Camera ${slot.slot}`,
        path: nextPath,
      });
    }
    if (!newSnapshots.length) continue;
    const working = { ...txn, ...updates, camera_snapshots: snapshots };
    const merged = mergeSnapshotsBySlot(
      existingPassSnapshots(working, vehicleType, pass),
      newSnapshots,
    );
    Object.assign(updates, photoColumnUpdates(merged, pass));
    snapshots = setPassSnapshots(snapshots, vehicleType, pass, merged);
    updates.camera_snapshots = snapshots;
    for (const snap of newSnapshots) {
      const slotNum = cameraSlotFromId(snap.id);
      if (slotNum !== 1) continue;
      if (pass === 'departure') updates.image_path = snap.path;
      else if (!isHywa(vehicleType)) updates.tare_image_path = snap.path;
    }
  }

  if (!Object.keys(updates).length) return { updated: false };
  TransactionService.updateFields(txn.id, updates);
  return { updated: true, updates };
}

async function syncImportedTripPhotos(row, localTxn, options = {}) {
  if (!localTxn?.id) return { updated: false, reason: 'no_local' };
  const extraKeys = await collectCandidateS3Keys({
    ...row,
    slip_number: row.slip_number || localTxn.slip_number,
    truck_number: row.truck_number || localTxn.truck_number,
    timestamp_in: row.timestamp_in || localTxn.timestamp_in,
    timestamp_out: row.timestamp_out || localTxn.timestamp_out,
  });
  const photoPaths = await downloadRemotePhotos(
    { ...localTxn, ...row, truck_number: localTxn.truck_number || row.truck_number },
    localTxn.id,
    extraKeys,
  );
  const applied = applyLocalPhotoUpdates(localTxn, photoPaths);
  let regenerated = false;
  if ((applied.updated || options.forceRegen) && options.regeneratePdf !== false) {
    try {
      const ReportService = require('./ReportService');
      const regen = await ReportService.regenerateTripPDF(localTxn.id);
      regenerated = !!regen?.ok;
      if (!regen?.ok) {
        logger.warn('Photo sync report regen failed', {
          slip: localTxn.slip_number,
          error: regen?.error,
        });
      }
    } catch (err) {
      logger.warn('Photo sync report regen failed', {
        slip: localTxn.slip_number,
        message: err.message,
      });
    }
  }
  if (applied.updated || regenerated || Object.keys(photoPaths._s3Keys || {}).length) {
    enqueueMirrorPush(localTxn.id);
  }
  return {
    updated: applied.updated,
    regenerated,
    localPaths: photoPaths,
    s3Keys: photoPaths._s3Keys || {},
    s3KeysTried: extraKeys,
  };
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

async function markRemoteTripSynced(remoteId, localId, mcgResult, row = {}) {
  const mcgStatus =
    mcgResult?.skipped && mcgResult?.reason === 'not_configured'
      ? 'skipped'
      : mcgResult?.ok
        ? 'sent'
        : 'failed';

  const photoValues = PHOTO_SLOTS.map((slot) => {
    const value = row[slot.col];
    return value ? String(value).trim() : null;
  });

  const res = await pg.query(
    `UPDATE remote_trips SET
      synced_to_local = true,
      synced_at = now(),
      local_id = $2,
      mcg_status = $3,
      mcg_error = $4,
      mcg_sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE mcg_sent_at END
     WHERE id = $1
       AND arrival_photo_1 IS NOT DISTINCT FROM $5
       AND arrival_photo_2 IS NOT DISTINCT FROM $6
       AND arrival_photo_3 IS NOT DISTINCT FROM $7
       AND departure_photo_1 IS NOT DISTINCT FROM $8
       AND departure_photo_2 IS NOT DISTINCT FROM $9
       AND departure_photo_3 IS NOT DISTINCT FROM $10
     RETURNING id`,
    [
      remoteId,
      localId,
      mcgStatus,
      mcgResult?.ok ? null : mcgResult?.error || mcgResult?.reason || null,
      ...photoValues,
    ],
  );

  if (!res.rows.length) {
    logger.info('Remote trip photos changed during sync — leaving it pending', {
      remoteId,
      slip: row.slip_number,
    });
    return { stale: true };
  }
  return { stale: false };
}

async function processRemoteRow(row, attempt = 0) {
  const remoteId = row.id;

  const alreadyImported = TransactionService.getByRemotePgId(remoteId);
  if (alreadyImported) {
    const photoSync = await syncImportedTripPhotos(row, alreadyImported);
    assertPhotosReady(row, photoSync.localPaths);
    const marked = await markRemoteTripSynced(remoteId, alreadyImported.id, {
      ok: true,
      skipped: true,
      reason: 'already_sent',
    }, row);
    if (marked.stale) {
      photoMissCounts.delete(remoteId);
      return { ok: true, reason: 'photos_updated', transactionId: alreadyImported.id };
    }
    pendingLocalIds.delete(remoteId);
    photoMissCounts.delete(remoteId);
    // Local may have remapped slip / edited fields — refresh remote_trips + mirror.
    try {
      const CloudAdminSyncService = require('./CloudAdminSyncService');
      const refreshed = TransactionService.getById(alreadyImported.id) || alreadyImported;
      await CloudAdminSyncService.syncRemoteTripFromLocal(refreshed);
      CloudAdminSyncService.enqueuePush(alreadyImported.id);
    } catch (_e) {
      /* optional */
    }
    return {
      ok: true,
      reason: 'already_imported',
      transactionId: alreadyImported.id,
      photoSync,
    };
  }

  const slipOwner = TransactionService.getBySlipNumber(row.slip_number);
  if (slipOwner && slipOwner.remote_pg_id !== remoteId) {
    await remappingRemoteSlip(row, slipOwner);
  }

  const localTxnId = pendingLocalIds.get(remoteId) || uuidv4();
  pendingLocalIds.set(remoteId, localTxnId);
  const extraKeys = await collectCandidateS3Keys(row);
  const photoPaths = await downloadRemotePhotos(row, localTxnId, extraKeys);
  assertPhotosReady(row, photoPaths);

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
      const hasPhotos = PHOTO_SLOTS.some((slot) => photoPaths[slot.col]);
      const reportResult = hasPhotos
        ? await ReportService.regenerateTripPDF(transaction.id)
        : await ReportService.exportTripPDF(transaction.id);
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

  const marked = await markRemoteTripSynced(remoteId, transaction.id, mcgResult, row);
  if (marked.stale) {
    photoMissCounts.delete(remoteId);
    return { ok: true, reason: 'photos_updated', transactionId: transaction.id };
  }
  pendingLocalIds.delete(remoteId);
  photoMissCounts.delete(remoteId);

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

function isBusy() {
  return processing;
}

async function processNow() {
  if (processing) {
    rerunRequested = true;
    return { ok: true, skipped: true, reason: 'busy' };
  }
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
    let passes = 0;
    do {
      rerunRequested = false;
      passes += 1;
      const rows = await loadPendingRows();
      for (const row of rows) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await processRemoteRow(row);
          processed += 1;
        } catch (err) {
          failed += 1;
          const waitingForPhotos = /Photos not on the weighbridge yet/.test(err.message || '');
          if (waitingForPhotos) {
            logger.warn('Remote trip waiting for photos', {
              remoteId: row.id,
              slip: row.slip_number,
              message: err.message,
            });
          } else {
            logger.error('Remote trip import failed', {
              remoteId: row.id,
              slip: row.slip_number,
              message: err.message,
            });
          }
        }
      }
    } while (rerunRequested && passes < 3);
    return { ok: true, processed, failed };
  } finally {
    processing = false;
    if (rerunRequested) {
      rerunRequested = false;
      setTimeout(() => {
        processNow().catch((err) => {
          logger.error('RemoteTripSync follow-up error', { message: err.message });
        });
      }, 400);
    }
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
  isBusy,
  processRemoteRow,
  downloadRemotePhotos,
  collectCandidateS3Keys,
  syncImportedTripPhotos,
  PHOTO_SLOTS,
};
