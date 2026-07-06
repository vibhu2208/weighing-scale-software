'use strict';

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
  const cols = Object.keys(data);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => data[c]);

  const res = await queryFn(
    `INSERT INTO remote_trips (${cols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values,
  );
  return res.rows[0];
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
  return res.rows[0];
}

module.exports = {
  buildCreatePayload,
  createRemoteTrip,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
};
