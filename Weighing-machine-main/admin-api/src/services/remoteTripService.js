'use strict';

const { markReservationUsed } = require('./slipReservationService');
const { getSiteId } = require('../db');

function normalizeText(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

function parseWeight(value, fieldName) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Valid ${fieldName} is required`);
  return n;
}

function parseTimestamp(value, fieldName) {
  if (!value) throw new Error(`${fieldName} is required`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${fieldName}`);
  return parsed.toISOString();
}

function buildCreatePayload(body = {}) {
  const gross = parseWeight(body.gross_weight, 'gross weight');
  const tare = parseWeight(body.tare_weight, 'tare weight');
  if (gross <= tare) throw new Error('Gross weight must be greater than tare weight');

  const timestampIn = parseTimestamp(body.timestamp_in, 'arrival time');
  const timestampOut = parseTimestamp(body.timestamp_out, 'close time');
  if (new Date(timestampOut).getTime() < new Date(timestampIn).getTime()) {
    throw new Error('Close time must be after arrival time');
  }

  const payload = {
    truck_number: normalizeText(body.truck_number, 'Vehicle number').toUpperCase(),
    customer_name: normalizeText(body.customer_name, 'Customer'),
    destination: normalizeText(body.destination, 'Destination'),
    material: normalizeText(body.material, 'Material'),
    operator_name: normalizeText(body.operator_name, 'Operator'),
    tare_weight: tare,
    gross_weight: gross,
    timestamp_in: timestampIn,
    timestamp_out: timestampOut,
    rfid_tag: body.rfid_tag ? String(body.rfid_tag).trim() : null,
    transporter: body.transporter ? String(body.transporter).trim() : null,
    vehicle_type: body.vehicle_type ? String(body.vehicle_type).trim() : null,
  };

  const slip = String(body.slip_number || '').trim();
  if (slip) payload.slip_number = slip.toUpperCase();

  return payload;
}

async function createRemoteTrip(queryFn, body = {}) {
  const data = buildCreatePayload(body);

  // If filling a planned gap, lock in that reserved slip before insert.
  const reservationId = body.reservation_id ? String(body.reservation_id).trim() : '';
  if (reservationId) {
    const held = await queryFn(
      `SELECT * FROM slip_reservations WHERE id = $1 LIMIT 1`,
      [reservationId],
    );
    const row = held.rows[0];
    if (!row) throw new Error('Reserved slip not found');
    if (row.status === 'scheduled' || row.status === 'missed') {
      throw new Error(
        'Gap is not blocked yet — wait for auto-block (5 min before planned time) or use Block now on Plan Gaps',
      );
    }
    if (row.status !== 'held' || !row.slip_number) {
      throw new Error('Reserved slip not found or already used/released');
    }
    data.slip_number = String(row.slip_number).toUpperCase();
  }

  const cols = Object.keys(data);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => data[c]);

  const res = await queryFn(
    `INSERT INTO remote_trips (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values,
  );
  const trip = res.rows[0];

  if (trip?.slip_number) {
    try {
      await markReservationUsed(trip.slip_number, trip.id, queryFn);
    } catch (err) {
      console.warn('[remoteTrip] mark reservation used failed', err.message);
    }
  }

  // Show immediately in Admin Reports — do not wait for weighbridge CloudAdminSync.
  try {
    await upsertMirrorFromRemoteTrip(queryFn, trip);
  } catch (err) {
    console.warn('[remoteTrip] mirror upsert on create failed', err.message);
  }

  return trip;
}

/**
 * Upsert a remote trip into transactions_mirror so Admin Reports lists it.
 * Weighbridge CloudAdminSync may later refresh the same slip with local ids/photos.
 */
async function upsertMirrorFromRemoteTrip(queryFn, row, siteId = getSiteId()) {
  if (!row?.slip_number) return null;
  const localId = row.local_id || row.id;
  if (!localId) return null;

  // Avoid unique (site_id, local_id) conflicts when slip already exists with another local_id.
  await queryFn(
    `DELETE FROM transactions_mirror
     WHERE site_id = $1 AND local_id = $2 AND slip_number <> $3`,
    [siteId, localId, row.slip_number],
  );

  const res = await queryFn(
    `INSERT INTO transactions_mirror (
      site_id, local_id, slip_number, truck_number, rfid_tag,
      customer_name, destination, material, operator_name, transporter, vehicle_type,
      gross_weight, tare_weight, timestamp_in, timestamp_out,
      ticket_status, sync_status, mcg_status, mcg_error,
      arrival_photo_1, arrival_photo_2, arrival_photo_3,
      departure_photo_1, departure_photo_2, departure_photo_3,
      report_s3_key, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      'CLOSED',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now()
    )
    ON CONFLICT (site_id, slip_number) DO UPDATE SET
      local_id = EXCLUDED.local_id,
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
      ticket_status = 'CLOSED',
      sync_status = COALESCE(EXCLUDED.sync_status, transactions_mirror.sync_status),
      mcg_status = COALESCE(EXCLUDED.mcg_status, transactions_mirror.mcg_status),
      mcg_error = COALESCE(EXCLUDED.mcg_error, transactions_mirror.mcg_error),
      arrival_photo_1 = COALESCE(EXCLUDED.arrival_photo_1, transactions_mirror.arrival_photo_1),
      arrival_photo_2 = COALESCE(EXCLUDED.arrival_photo_2, transactions_mirror.arrival_photo_2),
      arrival_photo_3 = COALESCE(EXCLUDED.arrival_photo_3, transactions_mirror.arrival_photo_3),
      departure_photo_1 = COALESCE(EXCLUDED.departure_photo_1, transactions_mirror.departure_photo_1),
      departure_photo_2 = COALESCE(EXCLUDED.departure_photo_2, transactions_mirror.departure_photo_2),
      departure_photo_3 = COALESCE(EXCLUDED.departure_photo_3, transactions_mirror.departure_photo_3),
      report_s3_key = COALESCE(EXCLUDED.report_s3_key, transactions_mirror.report_s3_key),
      updated_at = now()
    RETURNING slip_number`,
    [
      siteId,
      localId,
      row.slip_number,
      row.truck_number,
      row.rfid_tag || null,
      row.customer_name || null,
      row.destination || null,
      row.material || null,
      row.operator_name || null,
      row.transporter || null,
      row.vehicle_type || null,
      row.gross_weight,
      row.tare_weight,
      row.timestamp_in || null,
      row.timestamp_out || null,
      row.sync_status || 'SYNCED',
      row.mcg_status || null,
      row.mcg_error || null,
      row.arrival_photo_1 || null,
      row.arrival_photo_2 || null,
      row.arrival_photo_3 || null,
      row.departure_photo_1 || null,
      row.departure_photo_2 || null,
      row.departure_photo_3 || null,
      row.report_s3_key || null,
    ],
  );
  return res.rows[0] || null;
}

/** Backfill synced remote trips that never landed in Admin Reports. */
async function reconcileRemoteTripsToMirror(queryFn, siteId = getSiteId(), limit = 50) {
  const missing = await queryFn(
    `SELECT rt.*
     FROM remote_trips rt
     WHERE NOT EXISTS (
       SELECT 1 FROM transactions_mirror m
       WHERE m.site_id = $1 AND m.slip_number = rt.slip_number
     )
     ORDER BY rt.created_at DESC
     LIMIT $2`,
    [siteId, limit],
  );

  let upserted = 0;
  for (const row of missing.rows || []) {
    try {
      await upsertMirrorFromRemoteTrip(queryFn, row, siteId);
      upserted += 1;
    } catch (err) {
      console.warn('[remoteTrip] reconcile mirror failed', row.slip_number, err.message);
    }
  }
  return { candidates: (missing.rows || []).length, upserted };
}

let reconcileTimer = null;

function startMirrorReconcileWorker(queryFn, everySec = 60) {
  if (reconcileTimer) return;
  const tick = async () => {
    try {
      const result = await reconcileRemoteTripsToMirror(queryFn);
      if (result.upserted > 0) {
        console.log('[remoteTrip] reconciled missing mirror rows', result);
      }
    } catch (err) {
      console.warn('[remoteTrip] reconcile worker error', err.message);
    }
  };
  tick().catch(() => {});
  reconcileTimer = setInterval(() => {
    tick().catch(() => {});
  }, Math.max(15, everySec) * 1000);
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
}

async function listRemoteTrips(queryFn, filters = {}) {
  const clauses = [];
  const params = [];
  let idx = 1;

  if (filters.pending === 'true' || filters.pending === true) {
    clauses.push('synced_to_local = false');
  }
  if (filters.search && String(filters.search).trim()) {
    const term = `%${String(filters.search).trim()}%`;
    clauses.push(
      `(slip_number ILIKE $${idx} OR truck_number ILIKE $${idx} OR customer_name ILIKE $${idx})`,
    );
    params.push(term);
    idx += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));

  const res = await queryFn(
    `SELECT id, slip_number, truck_number, customer_name, destination, material,
            operator_name, tare_weight, gross_weight, net_weight,
            timestamp_in, timestamp_out, synced_to_local, synced_at, local_id,
            mcg_status, created_at
     FROM remote_trips ${where}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    [...params, limit],
  );
  return res.rows || [];
}

async function getRemoteTrip(queryFn, id) {
  const res = await queryFn('SELECT * FROM remote_trips WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

async function attachPhotos(queryFn, id, photoS3Keys = []) {
  const row = await getRemoteTrip(queryFn, id);
  if (!row) throw new Error('Remote trip not found');
  if (row.synced_to_local) {
    throw new Error('Trip already synced to weighbridge — cannot change photos');
  }

  const updates = {};
  for (const item of photoS3Keys) {
    const slot = Number(item.slot);
    const key = item.key || item.s3Key;
    const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
    if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
    updates[`${pass}_photo_${slot}`] = key;
  }

  if (!Object.keys(updates).length) {
    return row;
  }

  const cols = Object.keys(updates);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  const values = cols.map((c) => updates[c]);

  const res = await queryFn(
    `UPDATE remote_trips SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  const trip = res.rows[0];
  if (trip) {
    try {
      await upsertMirrorFromRemoteTrip(queryFn, trip);
    } catch (err) {
      console.warn('[remoteTrip] mirror upsert on photos failed', err.message);
    }
  }
  return trip;
}

module.exports = {
  buildCreatePayload,
  createRemoteTrip,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
  upsertMirrorFromRemoteTrip,
  reconcileRemoteTripsToMirror,
  startMirrorReconcileWorker,
};
