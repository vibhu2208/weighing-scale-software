'use strict';

const { markReservationUsed } = require('./slipReservationService');

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

  const photoCols = [
    'arrival_photo_1',
    'arrival_photo_2',
    'arrival_photo_3',
    'departure_photo_1',
    'departure_photo_2',
    'departure_photo_3',
  ];
  for (const col of photoCols) {
    if (body[col]) payload[col] = String(body[col]).trim();
  }
  if (Array.isArray(body.photoS3Keys)) {
    for (const item of body.photoS3Keys) {
      const slot = Number(item.slot);
      const key = item.key || item.s3Key;
      const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
      if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
      payload[`${pass}_photo_${slot}`] = key;
    }
  }

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

  return trip;
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
  // Re-queue photo download even if trip data already imported locally.
  const sets = [
    ...cols.map((c, i) => `${c} = $${i + 2}`),
    'synced_to_local = false',
  ];
  const values = cols.map((c) => updates[c]);

  const res = await queryFn(
    `UPDATE remote_trips SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return res.rows[0];
}

module.exports = {
  buildCreatePayload,
  createRemoteTrip,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
};
