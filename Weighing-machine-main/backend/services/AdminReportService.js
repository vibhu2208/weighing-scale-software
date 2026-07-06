'use strict';

const fs = require('fs');
const path = require('path');
const TransactionService = require('./TransactionService');
const ReportService = require('./ReportService');
const OperatorAuthService = require('./OperatorAuthService');
const SlipNumberService = require('./SlipNumberService');
const { saveImage } = require('../utils/fileStorage');
const { PATHS, normalizePath } = require('../utils/fileStorage');
const {
  isClosedTrip,
  cameraSlotFromId,
  existingPassSnapshots,
  mergeSnapshotsBySlot,
  photoColumnUpdates,
  setPassSnapshots,
} = require('../utils/tripPhotos');
const { resolveVehicleType, isHywa } = require('../utils/vehicleTypes');
const { TICKET_STATUS } = require('../utils/constants');
const { toPublicTransaction } = require('../utils/transactionPublic');
const logger = require('../utils/logger');

const { getDb } = require('../database/db');

function parseImageBase64(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('Invalid image data');
  }
  const match = imageBase64.match(/^data:image\/\w+;base64,(.+)$/);
  const raw = match ? match[1] : imageBase64;
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new Error('Invalid image data');
  }
  return buffer;
}

function getSlipPrefix() {
  const row = getDb().prepare('SELECT prefix FROM slip_counter ORDER BY id LIMIT 1').get();
  return row?.prefix || 'WB';
}

function normalizeSlipNumber(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) throw new Error('Slip number is required');
  const match = raw.match(/^([A-Z]+)?(\d+)$/);
  if (!match) throw new Error('Invalid slip number (e.g. WB0001 or 15)');
  const prefix = match[1] || getSlipPrefix();
  const num = parseInt(match[2], 10);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('Slip number must be greater than zero');
  }
  return `${prefix}${String(num).padStart(4, '0')}`;
}

function removeOldSlipFiles(oldSlip, keepPaths = new Set()) {
  const candidates = [
    path.join(PATHS.REPORTS, `${oldSlip}_report.pdf`),
    path.join(PATHS.REPORTS, `${oldSlip}.pdf`),
  ];
  for (const filePath of candidates) {
    if (keepPaths.has(path.resolve(filePath))) continue;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn('Failed to remove old slip file', { path: filePath, message: err.message });
    }
  }
}

function findClosedBySlip(slipNumber) {
  const slip = String(slipNumber || '').trim();
  if (!slip) return null;
  return TransactionService.getBySlipNumber(slip);
}

function requireClosedReport(txn) {
  if (!txn) {
    throw new Error('Report not found for that slip number');
  }
  if (txn.ticket_status !== TICKET_STATUS.CLOSED && !isClosedTrip(txn)) {
    throw new Error('Only closed ticket reports can be edited or deleted');
  }
  return txn;
}

function listRecentClosedReports({ search, limit = 40 } = {}) {
  OperatorAuthService.assertManualHywaSectionAccess();
  const max = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 100);
  const term = String(search || '').trim();
  let sql = `SELECT t.id, t.slip_number, t.truck_number, t.timestamp_out, t.net_weight, v.vehicle_type
             FROM transactions t
             LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number
             WHERE t.ticket_status = ?`;
  const params = [TICKET_STATUS.CLOSED];
  if (term) {
    sql += ' AND (t.slip_number LIKE ? OR UPPER(t.truck_number) LIKE ?)';
    params.push(`%${term}%`, `%${term.toUpperCase()}%`);
  }
  sql += ' ORDER BY COALESCE(t.timestamp_out, t.updated_at) DESC LIMIT ?';
  params.push(max);
  return getDb().prepare(sql).all(...params);
}

function getClosedReportBySlip(slipNumber) {
  OperatorAuthService.assertManualHywaSectionAccess();
  const txn = requireClosedReport(findClosedBySlip(slipNumber));
  return toPublicTransaction(txn);
}

function removeReportPdfFiles(txn) {
  const paths = new Set();
  if (txn.report_path) paths.add(normalizePath(txn.report_path));
  if (txn.slip_number) {
    paths.add(path.join(PATHS.REPORTS, `${txn.slip_number}_report.pdf`));
  }
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn('Failed to delete report PDF', { path: filePath, message: err.message });
    }
  }
}

async function performClosedReportUpdate(data = {}) {
  const slip = String(data.slipNumber || data.slip_number || '').trim();
  const txn = requireClosedReport(
    data.transactionId
      ? TransactionService.getById(data.transactionId)
      : findClosedBySlip(slip),
  );

  const vehicleType = resolveVehicleType(
    { vehicle_type: txn.vehicle?.vehicle_type || txn.vehicle_type },
    txn,
  );

  const updates = {};

  if (data.gross_weight != null && data.gross_weight !== '') {
    const gross = Math.round(Number(data.gross_weight));
    if (!Number.isFinite(gross) || gross <= 0) throw new Error('Valid gross weight is required');
    updates.gross_weight = gross;
    updates.raw_gross_weight = gross;
  }

  if (data.tare_weight != null && data.tare_weight !== '') {
    const tare = Math.round(Number(data.tare_weight));
    if (!Number.isFinite(tare) || tare <= 0) throw new Error('Valid tare weight is required');
    updates.tare_weight = tare;
    updates.raw_tare_weight = tare;
  }

  const gross = updates.gross_weight ?? txn.gross_weight;
  const tare = updates.tare_weight ?? txn.tare_weight;
  if (gross != null && tare != null && Number(gross) < Number(tare)) {
    throw new Error('Gross weight must be greater than tare weight');
  }

  if (data.timestamp_in) {
    const parsed = new Date(data.timestamp_in);
    if (Number.isNaN(parsed.getTime())) throw new Error('Invalid arrival date/time');
    updates.timestamp_in = parsed.toISOString();
  }
  if (data.timestamp_out) {
    const parsed = new Date(data.timestamp_out);
    if (Number.isNaN(parsed.getTime())) throw new Error('Invalid close date/time');
    updates.timestamp_out = parsed.toISOString();
  }

  const textFields = ['material', 'customer_name', 'destination', 'operator_name'];
  for (const key of textFields) {
    if (data[key] != null) {
      const value = String(data[key]).trim();
      if (!value) throw new Error(`${key.replace(/_/g, ' ')} cannot be empty`);
      updates[key] = value;
    }
  }

  if (Array.isArray(data.manualImages) && data.manualImages.length) {
    const byPass = { arrival: [], departure: [] };
    for (const item of data.manualImages) {
      if (!item?.imageBase64) continue;
      const slot = Number(item.slot);
      if (!Number.isFinite(slot) || slot < 1 || slot > 3) {
        throw new Error('Invalid photo slot — use 1, 2, or 3');
      }
      const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
      const imageBuffer = parseImageBase64(item.imageBase64);
      const fileTag = pass === 'departure' ? 'departure-cam' : 'arrival-cam';
      const savedPath = saveImage(imageBuffer, txn.id, `${fileTag}-${slot}`, {
        vehicleNumber: txn.truck_number,
      });
      byPass[pass].push({ id: `cam-${slot}`, label: `Camera ${slot}`, path: savedPath });
    }

    for (const pass of ['arrival', 'departure']) {
      const newSnapshots = byPass[pass];
      if (!newSnapshots.length) continue;
      const workingRow = {
        ...txn,
        ...updates,
        camera_snapshots: updates.camera_snapshots ?? txn.camera_snapshots,
      };
      const merged = mergeSnapshotsBySlot(
        existingPassSnapshots(workingRow, vehicleType, pass),
        newSnapshots,
      );
      Object.assign(updates, photoColumnUpdates(merged, pass));
      updates.camera_snapshots = setPassSnapshots(
        updates.camera_snapshots ?? txn.camera_snapshots,
        vehicleType,
        pass,
        merged,
      );
      for (const snap of newSnapshots) {
        const slot = cameraSlotFromId(snap.id);
        if (slot !== 1) continue;
        if (pass === 'departure') updates.image_path = snap.path;
        else if (!isHywa(vehicleType)) updates.tare_image_path = snap.path;
      }
    }
  }

  if (Array.isArray(data.photoS3Keys) && data.photoS3Keys.length) {
    const S3Service = require('./S3Service');
    const { getCameraImagePath } = require('../utils/fileStorage');
    const byPass = { arrival: [], departure: [] };
    for (const item of data.photoS3Keys) {
      const slot = Number(item.slot);
      const s3Key = item.key || item.s3Key;
      if (!s3Key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
      if (!S3Service.isConfigured()) throw new Error('S3 not configured');
      const date = txn.timestamp_out || txn.timestamp_in || new Date().toISOString();
      const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
      const localPath = getCameraImagePath(txn.id, `cam-${slot}`, pass, date, {
        vehicleNumber: txn.truck_number,
      });
      await S3Service.downloadFile(s3Key, localPath);
      byPass[pass].push({ id: `cam-${slot}`, label: `Camera ${slot}`, path: localPath });
    }
    for (const pass of ['arrival', 'departure']) {
      const newSnapshots = byPass[pass];
      if (!newSnapshots.length) continue;
      const workingRow = {
        ...txn,
        ...updates,
        camera_snapshots: updates.camera_snapshots ?? txn.camera_snapshots,
      };
      const merged = mergeSnapshotsBySlot(
        existingPassSnapshots(workingRow, vehicleType, pass),
        newSnapshots,
      );
      Object.assign(updates, photoColumnUpdates(merged, pass));
      updates.camera_snapshots = setPassSnapshots(
        updates.camera_snapshots ?? txn.camera_snapshots,
        vehicleType,
        pass,
        merged,
      );
      for (const snap of newSnapshots) {
        const slot = cameraSlotFromId(snap.id);
        if (slot !== 1) continue;
        if (pass === 'departure') updates.image_path = snap.path;
        else if (!isHywa(vehicleType)) updates.tare_image_path = snap.path;
      }
    }
  }

  if (!Object.keys(updates).length) throw new Error('No changes to save');

  TransactionService.updateFields(txn.id, updates);
  const regen = await ReportService.regenerateTripPDF(txn.id);
  if (!regen.ok) throw new Error(regen.error || 'Report regeneration failed');

  const updated = TransactionService.getById(txn.id);
  return {
    ok: true,
    transaction: toPublicTransaction(updated),
    reportPath: regen.path,
    slip_number: updated.slip_number,
    transactionId: updated.id,
  };
}

async function updateClosedReport(data = {}) {
  OperatorAuthService.assertManualHywaSectionAccess();
  const result = await performClosedReportUpdate(data);
  try {
    require('./CloudAdminSyncService').enqueuePush(result.transactionId);
  } catch (_e) { /* optional */ }
  return result;
}

async function updateSlipNumber(data = {}) {
  OperatorAuthService.assertAdminAccess();

  const txn = data.transactionId
    ? TransactionService.getById(data.transactionId)
    : findClosedBySlip(data.oldSlipNumber || data.slipNumber);
  if (!txn) {
    throw new Error('Ticket not found');
  }

  const oldSlip = String(txn.slip_number || '').trim();
  if (!oldSlip) {
    throw new Error('Ticket has no slip number to change');
  }

  const newSlip = normalizeSlipNumber(data.newSlipNumber || data.slip_number);
  if (newSlip === oldSlip) {
    throw new Error('New slip number is the same as the current one');
  }

  const conflict = TransactionService.getBySlipNumber(newSlip);
  if (conflict && conflict.id !== txn.id) {
    throw new Error(`Slip number ${newSlip} is already used by another ticket`);
  }

  TransactionService.updateSlipNumber(txn.id, newSlip);

  let reportPath = null;
  if (isClosedTrip(txn)) {
    const regen = await ReportService.regenerateTripPDF(txn.id);
    if (!regen.ok) {
      TransactionService.updateSlipNumber(txn.id, oldSlip);
      throw new Error(regen.error || 'Report regeneration failed');
    }
    reportPath = regen.path;
    const keep = new Set();
    if (reportPath) keep.add(path.resolve(reportPath));
    if (newSlip) keep.add(path.resolve(path.join(PATHS.REPORTS, `${newSlip}_report.pdf`)));
    removeOldSlipFiles(oldSlip, keep);
  } else {
    const oldThermal = path.join(PATHS.REPORTS, `${oldSlip}.pdf`);
    const newThermal = path.join(PATHS.REPORTS, `${newSlip}.pdf`);
    if (fs.existsSync(oldThermal)) {
      try {
        if (fs.existsSync(newThermal)) fs.unlinkSync(newThermal);
        fs.renameSync(oldThermal, newThermal);
      } catch (err) {
        logger.warn('Could not rename thermal slip PDF', {
          oldSlip,
          newSlip,
          message: err.message,
        });
      }
    }

    const oldReport = txn.report_path ? normalizePath(txn.report_path) : null;
    if (oldReport && oldReport.includes(oldSlip)) {
      const nextReport = oldReport.replace(oldSlip, newSlip);
      try {
        if (fs.existsSync(oldReport)) {
          fs.renameSync(oldReport, nextReport);
        }
        TransactionService.updateFields(txn.id, { report_path: nextReport });
      } catch (err) {
        logger.warn('Could not rename report file for slip change', {
          oldSlip,
          newSlip,
          message: err.message,
        });
      }
    }
    removeOldSlipFiles(oldSlip);
  }

  const updated = TransactionService.getById(txn.id);
  logger.info('Slip number corrected', {
    transactionId: txn.id,
    oldSlip,
    newSlip,
    counterUnchanged: true,
  });

  return {
    ok: true,
    transaction: toPublicTransaction(updated),
    oldSlipNumber: oldSlip,
    newSlipNumber: newSlip,
    reportPath,
    nextSlipHint: SlipNumberService.getMaxLocalSlipNumeric(),
  };
}

function performClosedReportDelete(data = {}) {
  const txn = requireClosedReport(
    data.transactionId
      ? TransactionService.getById(data.transactionId)
      : findClosedBySlip(data.slipNumber || data.slip_number),
  );

  removeReportPdfFiles(txn);
  const deleted = TransactionService.deleteById(txn.id);

  logger.info('Closed report deleted by admin', {
    transactionId: txn.id,
    slip: txn.slip_number,
    remote: !!data.remote,
  });

  return {
    ok: true,
    slip_number: deleted.slip_number,
    transactionId: deleted.id,
  };
}

function deleteClosedReport(data = {}) {
  OperatorAuthService.assertManualHywaSectionAccess();
  const result = performClosedReportDelete(data);
  try {
    require('./CloudAdminSyncService').deleteMirrorRow(result.slip_number).catch(() => {});
  } catch (_e) { /* optional */ }
  return result;
}

async function applyRemoteUpdate(data = {}) {
  logger.info('Applying remote report update', { slip: data.slipNumber || data.slip_number });
  const result = await performClosedReportUpdate({ ...data, remote: true });
  try {
    require('./CloudAdminSyncService').enqueuePush(result.transactionId);
  } catch (_e) { /* optional */ }
  return result;
}

function applyRemoteDelete(data = {}) {
  logger.info('Applying remote report delete', { slip: data.slipNumber || data.slip_number });
  return performClosedReportDelete({ ...data, remote: true });
}

module.exports = {
  listRecentClosedReports,
  getClosedReportBySlip,
  updateClosedReport,
  updateSlipNumber,
  deleteClosedReport,
  applyRemoteUpdate,
  applyRemoteDelete,
};
