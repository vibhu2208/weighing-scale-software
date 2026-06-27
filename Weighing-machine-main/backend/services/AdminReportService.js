'use strict';

const fs = require('fs');
const path = require('path');
const TransactionService = require('./TransactionService');
const ReportService = require('./ReportService');
const OperatorAuthService = require('./OperatorAuthService');
const { saveImage } = require('../utils/fileStorage');
const { PATHS, normalizePath } = require('../utils/fileStorage');
const { isClosedTrip } = require('../utils/tripPhotos');
const { isHywa, resolveVehicleType } = require('../utils/vehicleTypes');
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

function parseCameraSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function mergeDepartureSnapshots(existing, vehicleType, newSnapshots) {
  const data = parseCameraSnapshots(existing);
  const passKey = isHywa(vehicleType) ? 'tare' : 'gross';
  data[passKey] = newSnapshots;
  return JSON.stringify(data);
}

function mapDeparturePhotoFields(snapshots) {
  const slots = { 1: null, 2: null, 3: null };
  for (const snap of snapshots || []) {
    if (!snap?.path) continue;
    const match = String(snap.id || '').match(/^cam-(\d+)$/i);
    const slot = match ? parseInt(match[1], 10) : null;
    if (slot && slot >= 1 && slot <= 3) {
      slots[slot] = snap.path;
      continue;
    }
    for (let i = 1; i <= 3; i += 1) {
      if (!slots[i]) {
        slots[i] = snap.path;
        break;
      }
    }
  }
  return {
    departure_photo_1: slots[1],
    departure_photo_2: slots[2],
    departure_photo_3: slots[3],
  };
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

async function updateClosedReport(data = {}) {
  OperatorAuthService.assertManualHywaSectionAccess();

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
    if (!Number.isFinite(gross) || gross <= 0) {
      throw new Error('Valid gross weight is required');
    }
    updates.gross_weight = gross;
    updates.raw_gross_weight = gross;
  }

  if (data.tare_weight != null && data.tare_weight !== '') {
    const tare = Math.round(Number(data.tare_weight));
    if (!Number.isFinite(tare) || tare <= 0) {
      throw new Error('Valid tare weight is required');
    }
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
    const snapshots = [];
    for (const item of data.manualImages) {
      if (!item?.imageBase64) continue;
      const slot = Number(item.slot);
      if (!Number.isFinite(slot) || slot < 1 || slot > 3) {
        throw new Error('Invalid photo slot — use 1, 2, or 3');
      }
      const imageBuffer = parseImageBase64(item.imageBase64);
      const savedPath = saveImage(imageBuffer, txn.id, `departure-cam-${slot}`);
      snapshots.push({ id: `cam-${slot}`, label: `Camera ${slot}`, path: savedPath });
    }
    if (snapshots.length) {
      snapshots.sort((a, b) => {
        const slotA = parseInt(String(a.id).replace('cam-', ''), 10) || 0;
        const slotB = parseInt(String(b.id).replace('cam-', ''), 10) || 0;
        return slotA - slotB;
      });
      Object.assign(updates, mapDeparturePhotoFields(snapshots));
      updates.camera_snapshots = mergeDepartureSnapshots(
        txn.camera_snapshots,
        vehicleType,
        snapshots,
      );
      updates.image_path = snapshots[0].path;
    }
  }

  if (!Object.keys(updates).length) {
    throw new Error('No changes to save');
  }

  TransactionService.updateFields(txn.id, updates);
  const regen = await ReportService.regenerateTripPDF(txn.id);
  if (!regen.ok) {
    throw new Error(regen.error || 'Report regeneration failed');
  }

  const updated = TransactionService.getById(txn.id);
  return {
    ok: true,
    transaction: toPublicTransaction(updated),
    reportPath: regen.path,
  };
}

function deleteClosedReport(data = {}) {
  OperatorAuthService.assertManualHywaSectionAccess();

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
  });

  return {
    ok: true,
    slip_number: deleted.slip_number,
    transactionId: deleted.id,
  };
}

module.exports = {
  listRecentClosedReports,
  getClosedReportBySlip,
  updateClosedReport,
  deleteClosedReport,
};
