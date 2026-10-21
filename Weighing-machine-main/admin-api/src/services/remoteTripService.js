'use strict';

const { markReservationUsed, findWeighbridgeConflict } = require('./slipReservationService');
const { getList } = require('./settingsService');
const { getSiteId, getPool } = require('../db');

const ALLOWED_VEHICLE_TYPES = ['HYWA', 'TRUCK', 'TANKER', 'CONTAINER'];
const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;
const SLIP_RE = /^WB[0-9]+$/;
const MAX_WEIGHT_KG = 200000;

function compactToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function listLabel(name) {
  return (
    {
      materials: 'material',
      customers: 'customer',
      destinations: 'destination',
      operators: 'operator',
    }[name] || name
  );
}

function matchingListNames(value, lists) {
  const norm = String(value || '').trim().toLowerCase();
  if (!norm) return [];
  return Object.entries(lists || {})
    .filter(([, items]) =>
      (items || []).some((item) => String(item).trim().toLowerCase() === norm),
    )
    .map(([name]) => name);
}

function canonicalFromList(value, items) {
  const norm = String(value || '').trim().toLowerCase();
  const hit = (items || []).find((item) => String(item).trim().toLowerCase() === norm);
  return hit ? String(hit).trim() : null;
}

function looksLikeWeightText(value) {
  const text = String(value || '')
    .trim()
    .replace(/,/g, '');
  if (!/^\d+(\.\d+)?(\s*kg)?$/i.test(text)) return false;
  const n = Number(text.replace(/\s*kg/i, ''));
  return Number.isFinite(n) && n > 0 && n <= MAX_WEIGHT_KG;
}

function readWeightKg(value, fieldName, errors, key) {
  if (value === null || value === undefined || String(value).trim() === '') {
    errors[key] = `${fieldName} is required`;
    return null;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_WEIGHT_KG) {
    errors[key] = `${fieldName} must be a weight from 1 to ${MAX_WEIGHT_KG} kg`;
    return null;
  }
  return n;
}

function readRequiredTime(value, fieldName, errors, key) {
  if (!value) {
    errors[key] = `${fieldName} is required`;
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    errors[key] = `${fieldName} must be a date and time`;
    return null;
  }
  return parsed.toISOString();
}

function readMaster(raw, fieldName, listName, lists, errors, key) {
  const text = String(raw || '').trim();
  if (!text) {
    errors[key] = `${fieldName} is required`;
    return null;
  }
  if (
    looksLikeWeightText(text) ||
    SLIP_RE.test(compactToken(text)) ||
    PLATE_RE.test(compactToken(text))
  ) {
    errors[key] = `${fieldName} must be a ${listLabel(listName)}, not a weight, slip, or vehicle number`;
    return null;
  }
  const items = (lists && lists[listName]) || [];
  const hits = matchingListNames(text, lists);
  const foreign = hits.filter((name) => name !== listName);
  if (items.length) {
    const match = canonicalFromList(text, items);
    if (!match) {
      const extra = foreign.length
        ? ` That value is a saved ${foreign.map(listLabel).join(' / ')}.`
        : ' Choose one from the saved list.';
      errors[key] = `${fieldName} must match a saved ${listLabel(listName)}.${extra}`;
      return null;
    }
    return match;
  }
  if (foreign.length) {
    errors[key] = `${fieldName} is a saved ${foreign.map(listLabel).join(' / ')}, not a ${listLabel(listName)}`;
    return null;
  }
  return text;
}

/**
 * Every remote-trip field must carry the kind of data that column stores:
 * plate, kg, weigh time, or the matching saved list.
 */
function validateRemoteTripFields(body = {}, lists = {}) {
  const errors = {};
  const openStatus = String(body.ticket_status || 'CLOSED').trim().toUpperCase();
  if (openStatus !== 'OPEN' && openStatus !== 'CLOSED') {
    errors.ticket_status = 'Ticket must be Open or Closed';
  }
  const open = openStatus === 'OPEN';

  const vehicleType = String(body.vehicle_type || '').trim().toUpperCase();
  if (!ALLOWED_VEHICLE_TYPES.includes(vehicleType)) {
    errors.vehicle_type = 'Vehicle type must be HYWA, TRUCK, TANKER, or CONTAINER';
  }
  const hywa = vehicleType === 'HYWA';

  let slip = String(body.slip_number || '').trim();
  if (slip) {
    slip = compactToken(slip);
    if (!SLIP_RE.test(slip)) {
      errors.slip_number = 'Slip number must look like WB1234';
    }
  }

  const plate = compactToken(body.truck_number);
  if (!plate) {
    errors.truck_number = 'Vehicle number is required';
  } else if (!PLATE_RE.test(plate)) {
    errors.truck_number =
      'Vehicle number must be a registration (e.g. HR38AH6118)';
  } else if (
    matchingListNames(plate, lists).length ||
    matchingListNames(body.truck_number, lists).length
  ) {
    errors.truck_number =
      'Vehicle number matches a material, customer, destination, or operator';
  }

  let tare = null;
  let gross = null;
  if (open && hywa) {
    if (body.tare_weight != null && String(body.tare_weight).trim() !== '') {
      errors.tare_weight = 'An open HYWA ticket carries gross weight only';
    }
    gross = readWeightKg(body.gross_weight, 'Gross weight', errors, 'gross_weight');
  } else if (open) {
    if (body.gross_weight != null && String(body.gross_weight).trim() !== '') {
      errors.gross_weight = 'An open ticket for this vehicle carries tare weight only';
    }
    tare = readWeightKg(body.tare_weight, 'Tare weight', errors, 'tare_weight');
  } else {
    gross = readWeightKg(body.gross_weight, 'Gross weight', errors, 'gross_weight');
    tare = readWeightKg(body.tare_weight, 'Tare weight', errors, 'tare_weight');
    if (gross != null && tare != null && gross <= tare) {
      errors.gross_weight = 'Gross weight must be greater than tare weight';
    }
  }

  const inLabel = hywa ? 'Gross time' : 'Arrival time';
  const timestampIn = readRequiredTime(body.timestamp_in, inLabel, errors, 'timestamp_in');
  let timestampOut = null;
  if (open) {
    if (body.timestamp_out) {
      errors.timestamp_out = 'An open ticket carries the first weigh time only';
    }
  } else {
    const outLabel = hywa ? 'Tare time' : 'Close time';
    timestampOut = readRequiredTime(body.timestamp_out, outLabel, errors, 'timestamp_out');
    if (
      timestampIn &&
      timestampOut &&
      new Date(timestampOut).getTime() < new Date(timestampIn).getTime()
    ) {
      errors.timestamp_out = `${outLabel} must be after ${inLabel.toLowerCase()}`;
    }
  }

  let rfid = body.rfid_tag ? String(body.rfid_tag).trim() : '';
  if (rfid) {
    if (!/^[A-Za-z0-9:_-]{4,64}$/.test(rfid)) {
      errors.rfid_tag = 'RFID tag must be the tag id (letters, numbers, _ or -)';
    } else if (looksLikeWeightText(rfid)) {
      errors.rfid_tag = 'RFID tag looks like a weight';
    } else if (matchingListNames(rfid, lists).length) {
      errors.rfid_tag = 'RFID tag matches a material, customer, destination, or operator';
    } else if (PLATE_RE.test(compactToken(rfid)) && compactToken(rfid) !== plate) {
      errors.rfid_tag = 'RFID tag looks like a vehicle number';
    }
  }

  let transporter = body.transporter ? String(body.transporter).trim() : '';
  if (transporter) {
    if (looksLikeWeightText(transporter) || SLIP_RE.test(compactToken(transporter))) {
      errors.transporter = 'Transporter must be a name, not a weight or slip number';
    } else if (PLATE_RE.test(compactToken(transporter))) {
      errors.transporter = 'Transporter looks like a vehicle number';
    } else if (transporter.length < 2) {
      errors.transporter = 'Transporter must be a name';
    }
  }

  const material = readMaster(body.material, 'Material', 'materials', lists, errors, 'material');
  const customer = readMaster(
    body.customer_name,
    'Customer',
    'customers',
    lists,
    errors,
    'customer_name',
  );
  const destination = readMaster(
    body.destination,
    'Destination',
    'destinations',
    lists,
    errors,
    'destination',
  );
  const operator = readMaster(
    body.operator_name,
    'Operator',
    'operators',
    lists,
    errors,
    'operator_name',
  );

  return {
    errors,
    values: {
      truck_number: plate,
      customer_name: customer,
      destination,
      material,
      operator_name: operator,
      tare_weight: tare,
      gross_weight: gross,
      timestamp_in: timestampIn,
      timestamp_out: timestampOut,
      ticket_status: open ? 'OPEN' : 'CLOSED',
      status: open ? 'weighing' : 'captured',
      rfid_tag: rfid || null,
      transporter: transporter || null,
      vehicle_type: ALLOWED_VEHICLE_TYPES.includes(vehicleType) ? vehicleType : null,
      slip_number: slip || undefined,
    },
  };
}

async function loadMasterLists() {
  const [materials, customers, destinations, operators] = await Promise.all([
    getList('materials'),
    getList('customers'),
    getList('destinations'),
    getList('operators'),
  ]);
  return { materials, customers, destinations, operators };
}

function buildCreatePayload(body = {}, lists = {}) {
  const { errors, values } = validateRemoteTripFields(body, lists);
  const messages = Object.values(errors).filter(Boolean);
  if (messages.length) throw new Error(messages.join(' '));

  const open = values.ticket_status === 'OPEN';
  const payload = {
    truck_number: values.truck_number,
    customer_name: values.customer_name,
    destination: values.destination,
    material: values.material,
    operator_name: values.operator_name,
    tare_weight: values.tare_weight,
    gross_weight: values.gross_weight,
    timestamp_in: values.timestamp_in,
    timestamp_out: values.timestamp_out,
    ticket_status: values.ticket_status,
    status: values.status,
    rfid_tag: values.rfid_tag,
    transporter: values.transporter,
    vehicle_type: values.vehicle_type,
  };

  if (open) {
    // Open tickets are not posted to MCG until the weighbridge closes them.
    payload.mcg_status = 'skipped';
  }

  if (values.slip_number) payload.slip_number = values.slip_number;

  // Future close times stay hidden from the weighbridge until that moment.
  if (!open && new Date(values.timestamp_out).getTime() > Date.now()) {
    payload.synced_to_local = true;
    payload.release_at = values.timestamp_out;
    payload.mcg_status = 'waiting';
  }

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
  // Optional photo keys (so create+notify includes photos — avoids PC importing first without them).
  const photoS3Keys = Array.isArray(body.photoS3Keys) ? body.photoS3Keys : [];
  for (const item of photoS3Keys) {
    const slot = Number(item.slot);
    const key = item.key || item.s3Key;
    if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
    if (open && item.pass === 'departure') continue;
    const pass = item.pass === 'arrival' || open ? 'arrival' : 'departure';
    payload[`${pass}_photo_${slot}`] = key;
  }

  return payload;
}

/**
 * The weighbridge marks a remote trip synced before its CloudAdminSync push
 * lands in transactions_mirror (minutes when RDS is slow). A missing mirror
 * row inside this window means "not pushed yet", not "stale".
 */
const MIRROR_PUSH_GRACE_MS = 30 * 60 * 1000;

function syncedWithinMirrorGrace(row) {
  const at = row?.synced_at ? new Date(row.synced_at).getTime() : NaN;
  return Number.isFinite(at) && Date.now() - at < MIRROR_PUSH_GRACE_MS;
}

/**
 * If this slip still sits on remote_trips but the weighbridge remapped the
 * ticket locally (mirror has the same local_id under a different slip), move
 * the remote row to the local slip — or delete the stale remote row — so the
 * old slip can be reused for a new remote trip.
 */
async function releaseSlipIfLocallyRemapped(queryFn, slipNumber, siteId = getSiteId()) {
  const slip = String(slipNumber || '')
    .trim()
    .toUpperCase();
  if (!slip) return null;

  const existingRes = await queryFn(
    `SELECT * FROM remote_trips WHERE UPPER(slip_number) = $1 LIMIT 1`,
    [slip],
  );
  const existing = existingRes.rows[0];
  if (!existing) return null;

  let mirrorByLocal = null;
  if (existing.local_id) {
    const mRes = await queryFn(
      `SELECT * FROM transactions_mirror
       WHERE site_id = $1 AND local_id = $2
       LIMIT 1`,
      [siteId, existing.local_id],
    );
    mirrorByLocal = mRes.rows[0] || null;
  }

  const mirrorSlip = mirrorByLocal?.slip_number
    ? String(mirrorByLocal.slip_number).trim().toUpperCase()
    : '';

  // Local remapped: mirror kept local_id but changed slip_number.
  if (mirrorSlip && mirrorSlip !== slip) {
    const taken = await queryFn(
      `SELECT id FROM remote_trips
       WHERE UPPER(slip_number) = $1 AND id <> $2
       LIMIT 1`,
      [mirrorSlip, existing.id],
    );

    if (taken.rows[0]) {
      // New slip already owned by another remote row — drop the stale blocker.
      await queryFn(`DELETE FROM remote_trips WHERE id = $1`, [existing.id]);
      await queryFn(
        `DELETE FROM transactions_mirror
         WHERE site_id = $1 AND UPPER(slip_number) = $2`,
        [siteId, slip],
      );
      console.log('[remoteTrip] deleted stale remote row after local remap', {
        oldSlip: slip,
        localSlip: mirrorSlip,
        remoteId: existing.id,
      });
      return { action: 'deleted', oldSlip: slip, newSlip: mirrorSlip, remoteId: existing.id };
    }

    await queryFn(
      `UPDATE remote_trips SET slip_number = $2 WHERE id = $1`,
      [existing.id, mirrorSlip],
    );
    await queryFn(
      `DELETE FROM transactions_mirror
       WHERE site_id = $1 AND UPPER(slip_number) = $2
         AND (local_id IS NULL OR local_id = $3)`,
      [siteId, slip, existing.local_id],
    );
    // Keep mirror in sync with the moved remote slip (may already exist).
    try {
      await upsertMirrorFromRemoteTrip(
        queryFn,
        { ...existing, slip_number: mirrorSlip },
        siteId,
      );
    } catch (err) {
      console.warn('[remoteTrip] mirror refresh after remap move failed', err.message);
    }
    console.log('[remoteTrip] moved remote slip to match local', {
      oldSlip: slip,
      newSlip: mirrorSlip,
      remoteId: existing.id,
    });
    return { action: 'moved', oldSlip: slip, newSlip: mirrorSlip, remoteId: existing.id };
  }

  // Synced remote trip, but slip no longer exists in mirror at all → stale blocker.
  if (existing.synced_to_local && !syncedWithinMirrorGrace(existing)) {
    const mirrorBySlip = await queryFn(
      `SELECT local_id FROM transactions_mirror
       WHERE site_id = $1 AND UPPER(slip_number) = $2
       LIMIT 1`,
      [siteId, slip],
    );
    if (!mirrorBySlip.rows[0]) {
      await queryFn(`DELETE FROM remote_trips WHERE id = $1`, [existing.id]);
      console.log('[remoteTrip] deleted stale remote row missing from local mirror', {
        oldSlip: slip,
        remoteId: existing.id,
        localId: existing.local_id || null,
      });
      return { action: 'deleted', oldSlip: slip, reason: 'missing_from_mirror', remoteId: existing.id };
    }
  }

  return null;
}

async function forceReleaseSlip(queryFn, slipNumber, siteId = getSiteId()) {
  const slip = String(slipNumber || '')
    .trim()
    .toUpperCase();
  if (!slip) return null;

  const delRemote = await queryFn(
    `DELETE FROM remote_trips WHERE UPPER(slip_number) = $1
     RETURNING id, slip_number, truck_number, local_id`,
    [slip],
  );
  const delMirror = await queryFn(
    `DELETE FROM transactions_mirror
     WHERE site_id = $1 AND UPPER(slip_number) = $2
     RETURNING local_id, slip_number`,
    [siteId, slip],
  );
  if ((delRemote.rows || []).length || (delMirror.rows || []).length) {
    console.log('[remoteTrip] force-released slip', {
      slip,
      deletedRemote: delRemote.rows,
      deletedMirror: delMirror.rows,
    });
  }
  return {
    slip,
    deletedRemote: delRemote.rows || [],
    deletedMirror: delMirror.rows || [],
  };
}

async function loadRemoteTripColumns(queryFn) {
  const res = await queryFn(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'remote_trips'`,
  );
  return new Map((res.rows || []).map((r) => [r.column_name, r.is_nullable === 'YES']));
}

/**
 * ALTER TABLE needs an exclusive lock: while it waits, every other query on
 * remote_trips queues behind it and the pool runs dry. Only run DDL that is
 * actually missing, and give up quickly if the table is busy.
 */
async function runRemoteTripDdl(statements) {
  if (!statements.length) return;
  const client = await getPool().connect();
  try {
    await client.query(`SET lock_timeout = '3s'`);
    for (const sql of statements) {
      await client.query(sql);
    }
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
    client.release();
  }
}

let releaseColumnReady = false;
async function ensureReleaseColumn(queryFn) {
  if (releaseColumnReady) return;
  const cols = await loadRemoteTripColumns(queryFn);
  if (!cols.has('release_at')) {
    await runRemoteTripDdl([
      `ALTER TABLE remote_trips ADD COLUMN IF NOT EXISTS release_at TIMESTAMPTZ`,
    ]);
  }
  releaseColumnReady = true;
}

let openTicketColumnsReady = false;
/** Open tickets store only the first weigh, so the second weight and close time may be null. */
async function ensureOpenTicketColumns(queryFn) {
  if (openTicketColumnsReady) return;
  const cols = await loadRemoteTripColumns(queryFn);
  const ddl = [];
  for (const col of ['tare_weight', 'gross_weight', 'timestamp_out']) {
    if (cols.get(col) === false) {
      ddl.push(`ALTER TABLE remote_trips ALTER COLUMN ${col} DROP NOT NULL`);
    }
  }
  if (!cols.has('ticket_status')) {
    ddl.push(
      `ALTER TABLE remote_trips ADD COLUMN IF NOT EXISTS ticket_status TEXT NOT NULL DEFAULT 'CLOSED'`,
    );
  }
  await runRemoteTripDdl(ddl);
  openTicketColumnsReady = true;
}

function isHeldUntilOutTime(row) {
  if (!row?.release_at) return false;
  const at = new Date(row.release_at).getTime();
  return Number.isFinite(at) && at > Date.now();
}

/**
 * Park unsynced trips whose close time is still in the future, then release
 * any that have reached timestamp_out so the weighbridge PC imports them.
 */
async function runOutTimeRelease(queryFn) {
  await ensureReleaseColumn(queryFn);

  await queryFn(
    `UPDATE remote_trips
     SET synced_to_local = true,
         release_at = timestamp_out,
         mcg_status = CASE
           WHEN mcg_status IS NULL OR mcg_status IN ('pending', '') THEN 'waiting'
           ELSE mcg_status
         END
     WHERE synced_to_local = false
       AND local_id IS NULL
       AND timestamp_out > now()`,
  );

  const due = await queryFn(
    `UPDATE remote_trips
     SET synced_to_local = false,
         release_at = NULL,
         mcg_status = CASE WHEN mcg_status = 'waiting' THEN 'pending' ELSE mcg_status END
     WHERE release_at IS NOT NULL
       AND release_at <= now()
       AND local_id IS NULL
     RETURNING id, slip_number`,
  );

  for (const row of due.rows || []) {
    try {
      await queryFn(`SELECT pg_notify('new_remote_trip', $1)`, [String(row.id)]);
    } catch (err) {
      console.warn('[remoteTrip] out-time notify failed', row.slip_number, err.message);
    }
  }

  if ((due.rows || []).length) {
    console.log('[remoteTrip] released trips at close time', {
      count: due.rows.length,
      slips: due.rows.map((r) => r.slip_number),
    });
  }
  return { released: (due.rows || []).length };
}

let outTimeTimer = null;
function startOutTimeReleaseWorker(queryFn, intervalMs = 15000) {
  if (outTimeTimer) return;
  const tick = () => {
    runOutTimeRelease(queryFn).catch((err) => {
      console.warn('[remoteTrip] out-time release failed', err.message);
    });
  };
  tick();
  outTimeTimer = setInterval(tick, Math.max(5000, intervalMs));
  if (typeof outTimeTimer.unref === 'function') outTimeTimer.unref();
}

async function createRemoteTrip(queryFn, body = {}, options = {}) {
  await ensureReleaseColumn(queryFn);
  await ensureOpenTicketColumns(queryFn);
  const lists = options.lists || (await loadMasterLists());
  const data = buildCreatePayload(body, lists);
  const forceReplace = Boolean(body.replace_existing || body.force_replace);

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
    const clash = await findWeighbridgeConflict(row.slip_number, queryFn);
    if (clash) {
      throw new Error(
        `Slip ${row.slip_number} is already used on the weighbridge` +
          (clash.truck_number ? ` (truck ${clash.truck_number})` : '') +
          '. Release this gap and pick another slip.',
      );
    }
    data.slip_number = String(row.slip_number).toUpperCase();
  }

  if (data.slip_number) {
    // Refresh all synced remote_trips from local mirror before claiming this slip.
    if (!options.skipReconcile) {
      try {
        await reconcileRemoteTripsFromMirror(queryFn);
      } catch (err) {
        console.warn('[remoteTrip] pre-create reconcile from mirror failed', err.message);
      }
    }

    if (forceReplace) {
      await forceReleaseSlip(queryFn, data.slip_number);
    } else {
      const freed = await releaseSlipIfLocallyRemapped(queryFn, data.slip_number);
      if (!freed) {
        const clash = await queryFn(
          `SELECT slip_number, truck_number, synced_to_local
           FROM remote_trips WHERE UPPER(slip_number) = $1 LIMIT 1`,
          [String(data.slip_number).toUpperCase()],
        );
        const hit = clash.rows[0];
        if (hit) {
          throw new Error(
            `Slip ${hit.slip_number} already exists in remote trips` +
              (hit.truck_number ? ` (truck ${hit.truck_number})` : '') +
              '. Leave slip blank for auto, check "Replace existing slip", or use a free slip.',
          );
        }
      }
    }
  }

  const cols = Object.keys(data);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => data[c]);

  let res;
  try {
    res = await queryFn(
      `INSERT INTO remote_trips (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values,
    );
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('remote_trips_slip_number_key') || msg.includes('duplicate key')) {
      throw new Error(
        `Slip ${data.slip_number || '(auto)'} already exists in remote trips. ` +
          'If the weighbridge remapped that ticket locally, sync the PC then retry — or leave slip blank.',
      );
    }
    throw err;
  }
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

const BULK_MAX_TRIPS = 500;

function bulkRowLabel(body) {
  const src = body && typeof body === 'object' ? body : {};
  return {
    slip_number: src.slip_number ? compactToken(src.slip_number) : null,
    truck_number: src.truck_number ? compactToken(src.truck_number) : null,
  };
}

/**
 * Validate (and unless dryRun, create) many remote trips. Rows are created one
 * at a time so auto-assigned slips stay sequential; a failing row does not stop
 * the rest.
 */
async function importRemoteTrips(queryFn, trips, { dryRun = false } = {}) {
  if (!Array.isArray(trips) || !trips.length) {
    throw new Error('Send a non-empty "trips" array');
  }
  if (trips.length > BULK_MAX_TRIPS) {
    throw new Error(`At most ${BULK_MAX_TRIPS} trips per import (got ${trips.length})`);
  }

  await ensureReleaseColumn(queryFn);
  await ensureOpenTicketColumns(queryFn);
  const lists = await loadMasterLists();

  const slipRows = new Map();
  const results = trips.map((body, index) => {
    const row = { index, ...bulkRowLabel(body), status: 'valid', errors: [], warnings: [] };
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      row.status = 'invalid';
      row.errors.push('Row must be a JSON object');
      return row;
    }
    const { errors, values } = validateRemoteTripFields(body, lists);
    const messages = Object.values(errors).filter(Boolean);
    if (messages.length) {
      row.status = 'invalid';
      row.errors.push(...messages);
    }
    if (values.slip_number) {
      row.slip_number = values.slip_number;
      if (!slipRows.has(values.slip_number)) slipRows.set(values.slip_number, []);
      slipRows.get(values.slip_number).push(index);
    }
    return row;
  });

  for (const [slip, indexes] of slipRows) {
    if (indexes.length < 2) continue;
    for (const i of indexes) {
      results[i].status = 'invalid';
      results[i].errors.push(
        `Slip ${slip} appears ${indexes.length} times in this file (rows ${indexes.map((n) => n + 1).join(', ')})`,
      );
    }
  }

  const explicitSlips = [...slipRows.keys()];
  if (explicitSlips.length) {
    const [remoteRes, localRes] = await Promise.all([
      queryFn(
        `SELECT UPPER(slip_number) AS slip, truck_number FROM remote_trips
         WHERE UPPER(slip_number) = ANY($1)`,
        [explicitSlips],
      ),
      queryFn(
        `SELECT UPPER(m.slip_number) AS slip, m.truck_number FROM transactions_mirror m
         WHERE m.site_id = $1 AND UPPER(m.slip_number) = ANY($2)
           AND NOT EXISTS (
             SELECT 1 FROM remote_trips rt WHERE UPPER(rt.slip_number) = UPPER(m.slip_number)
           )`,
        [getSiteId(), explicitSlips],
      ),
    ]);
    const inRemote = new Map((remoteRes.rows || []).map((r) => [r.slip, r.truck_number]));
    const onWeighbridge = new Map((localRes.rows || []).map((r) => [r.slip, r.truck_number]));
    for (const row of results) {
      if (!row.slip_number || row.status !== 'valid') continue;
      const replace = Boolean(trips[row.index].replace_existing || trips[row.index].force_replace);
      if (inRemote.has(row.slip_number) && !replace) {
        const truck = inRemote.get(row.slip_number);
        row.warnings.push(
          `Slip ${row.slip_number} already exists in remote trips${truck ? ` (truck ${truck})` : ''}; ` +
            'import fails unless that row is stale or replace_existing is true',
        );
      }
      if (onWeighbridge.has(row.slip_number)) {
        const truck = onWeighbridge.get(row.slip_number);
        row.warnings.push(
          `Slip ${row.slip_number} is already used on the weighbridge${truck ? ` (truck ${truck})` : ''}`,
        );
      }
    }
  }

  if (!dryRun) {
    if (explicitSlips.length) {
      try {
        await reconcileRemoteTripsFromMirror(queryFn);
      } catch (err) {
        console.warn('[remoteTrip] bulk pre-import reconcile from mirror failed', err.message);
      }
    }
    for (const row of results) {
      if (row.status !== 'valid') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const trip = await createRemoteTrip(queryFn, trips[row.index], {
          lists,
          skipReconcile: true,
        });
        row.status = 'created';
        row.id = trip.id;
        row.slip_number = trip.slip_number;
      } catch (err) {
        row.status = 'failed';
        row.errors.push(err.message);
      }
    }
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    dry_run: Boolean(dryRun),
    summary: {
      total: results.length,
      valid: count('valid'),
      invalid: count('invalid'),
      created: count('created'),
      failed: count('failed'),
      warnings: results.filter((r) => r.warnings.length).length,
    },
    results,
  };
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
      $26,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now()
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
      gross_weight = COALESCE(EXCLUDED.gross_weight, transactions_mirror.gross_weight),
      tare_weight = COALESCE(EXCLUDED.tare_weight, transactions_mirror.tare_weight),
      timestamp_in = EXCLUDED.timestamp_in,
      timestamp_out = COALESCE(EXCLUDED.timestamp_out, transactions_mirror.timestamp_out),
      ticket_status = CASE
        WHEN transactions_mirror.ticket_status = 'CLOSED'
         AND EXCLUDED.ticket_status IS DISTINCT FROM 'CLOSED'
        THEN 'CLOSED'
        ELSE EXCLUDED.ticket_status
      END,
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
      String(row.ticket_status || 'CLOSED').toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
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

/**
 * Refresh ALL synced remote_trips from transactions_mirror (local truth).
 * Moves remapped slips, copies weights/times/truck/etc, drops stale rows.
 */
async function reconcileRemoteTripsFromMirror(queryFn, siteId = getSiteId()) {
  const remotes = await queryFn(
    `SELECT * FROM remote_trips
     WHERE synced_to_local = true
     ORDER BY created_at DESC`,
  );

  let updated = 0;
  let deleted = 0;
  let errors = 0;

  for (const rt of remotes.rows || []) {
    try {
      let mirror = null;
      if (rt.local_id) {
        const byLocal = await queryFn(
          `SELECT * FROM transactions_mirror
           WHERE site_id = $1 AND local_id = $2
           LIMIT 1`,
          [siteId, rt.local_id],
        );
        mirror = byLocal.rows[0] || null;
      }
      if (!mirror) {
        const bySlip = await queryFn(
          `SELECT * FROM transactions_mirror
           WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)
           LIMIT 1`,
          [siteId, rt.slip_number],
        );
        mirror = bySlip.rows[0] || null;
      }

      if (!mirror) {
        if (syncedWithinMirrorGrace(rt)) continue;
        await queryFn(`DELETE FROM remote_trips WHERE id = $1`, [rt.id]);
        deleted += 1;
        console.log('[remoteTrip] removed stale remote_trips row (not in local mirror)', {
          id: rt.id,
          slip: rt.slip_number,
        });
        continue;
      }

      const newSlip = String(mirror.slip_number || '').trim().toUpperCase();
      const oldSlip = String(rt.slip_number || '').trim().toUpperCase();
      const slipToWrite = newSlip || oldSlip;

      if (newSlip && newSlip !== oldSlip) {
        const taken = await queryFn(
          `SELECT id FROM remote_trips
           WHERE UPPER(slip_number) = $1 AND id <> $2
           LIMIT 1`,
          [newSlip, rt.id],
        );
        if (taken.rows[0]) {
          await queryFn(`DELETE FROM remote_trips WHERE id = $1`, [rt.id]);
          deleted += 1;
          console.log('[remoteTrip] deleted remapped remote row (target slip taken)', {
            id: rt.id,
            oldSlip,
            newSlip,
          });
          continue;
        }
      }

      await queryFn(
        `UPDATE remote_trips SET
          slip_number = $2,
          truck_number = COALESCE(NULLIF($3, ''), truck_number),
          rfid_tag = $4,
          customer_name = COALESCE(NULLIF($5, ''), customer_name),
          destination = COALESCE(NULLIF($6, ''), destination),
          material = COALESCE(NULLIF($7, ''), material),
          operator_name = COALESCE(NULLIF($8, ''), operator_name),
          transporter = $9,
          vehicle_type = $10,
          tare_weight = COALESCE($11, tare_weight),
          gross_weight = COALESCE($12, gross_weight),
          timestamp_in = COALESCE($13, timestamp_in),
          timestamp_out = COALESCE($14, timestamp_out),
          local_id = COALESCE($15, local_id),
          arrival_photo_1 = COALESCE($16, arrival_photo_1),
          arrival_photo_2 = COALESCE($17, arrival_photo_2),
          arrival_photo_3 = COALESCE($18, arrival_photo_3),
          departure_photo_1 = COALESCE($19, departure_photo_1),
          departure_photo_2 = COALESCE($20, departure_photo_2),
          departure_photo_3 = COALESCE($21, departure_photo_3),
          report_s3_key = COALESCE($22, report_s3_key),
          ticket_status = CASE
            WHEN $23 = 'CLOSED' THEN 'CLOSED'
            WHEN ticket_status = 'CLOSED' THEN ticket_status
            ELSE COALESCE(NULLIF($23, ''), ticket_status)
          END,
          mcg_status = CASE
            WHEN $23 = 'CLOSED' AND ticket_status = 'OPEN' AND NULLIF($24, '') IS NOT NULL
            THEN $24
            ELSE mcg_status
          END
         WHERE id = $1`,
        [
          rt.id,
          slipToWrite,
          mirror.truck_number || '',
          mirror.rfid_tag || null,
          mirror.customer_name || null,
          mirror.destination || null,
          mirror.material || null,
          mirror.operator_name || null,
          mirror.transporter || null,
          mirror.vehicle_type || null,
          mirror.tare_weight != null ? Number(mirror.tare_weight) : null,
          mirror.gross_weight != null ? Number(mirror.gross_weight) : null,
          mirror.timestamp_in || null,
          mirror.timestamp_out || null,
          // Don't overwrite a real local UUID with the create-time placeholder (remote id).
          mirror.local_id && mirror.local_id !== rt.id
            ? mirror.local_id
            : rt.local_id && rt.local_id !== rt.id
              ? rt.local_id
              : mirror.local_id || rt.local_id || null,
          mirror.arrival_photo_1 || null,
          mirror.arrival_photo_2 || null,
          mirror.arrival_photo_3 || null,
          mirror.departure_photo_1 || null,
          mirror.departure_photo_2 || null,
          mirror.departure_photo_3 || null,
          mirror.report_s3_key || null,
          mirror.ticket_status || null,
          mirror.mcg_status || null,
        ],
      );
      updated += 1;
    } catch (err) {
      errors += 1;
      console.warn('[remoteTrip] reconcile from mirror failed', rt.slip_number, err.message);
    }
  }

  return {
    scanned: (remotes.rows || []).length,
    updated,
    deleted,
    errors,
  };
}

let reconcileTimer = null;

function isDbConnectivityError(err) {
  const msg = String(err && err.message ? err.message : err || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('connection terminated') ||
    msg.includes('could not connect')
  );
}

function startMirrorReconcileWorker(queryFn, everySec = 60) {
  if (reconcileTimer) return;
  const baseMs = Math.max(15, everySec) * 1000;
  let failStreak = 0;
  let nextAllowedAt = 0;
  let lastWarnAt = 0;

  const tick = async () => {
    const now = Date.now();
    if (now < nextAllowedAt) return;
    try {
      const fromLocal = await reconcileRemoteTripsFromMirror(queryFn);
      if (fromLocal.updated || fromLocal.deleted) {
        console.log('[remoteTrip] reconciled remote_trips from local mirror', fromLocal);
      }
      const result = await reconcileRemoteTripsToMirror(queryFn);
      if (result.upserted > 0) {
        console.log('[remoteTrip] reconciled missing mirror rows', result);
      }
      failStreak = 0;
      nextAllowedAt = 0;
    } catch (err) {
      failStreak += 1;
      if (isDbConnectivityError(err)) {
        // 1m → 2m → 4m … capped at 15m while RDS is unreachable
        const delayMs = Math.min(15 * 60 * 1000, baseMs * 2 ** Math.min(failStreak - 1, 4));
        nextAllowedAt = Date.now() + delayMs;
        if (now - lastWarnAt > 60 * 1000) {
          console.warn(
            `[remoteTrip] reconcile worker: DB unreachable (${err.message}); retry in ${Math.round(delayMs / 1000)}s`,
          );
          lastWarnAt = now;
        }
        return;
      }
      console.warn('[remoteTrip] reconcile worker error', err.message);
    }
  };
  tick().catch(() => {});
  reconcileTimer = setInterval(() => {
    tick().catch(() => {});
  }, baseMs);
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
}

function readIsoBound(value) {
  if (value == null || value === '') return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function listRemoteTrips(queryFn, filters = {}) {
  const clauses = [];
  const params = [];
  let idx = 1;

  if (filters.pending === 'true' || filters.pending === true) {
    clauses.push(
      `(synced_to_local = false OR (release_at IS NOT NULL AND release_at > now()))`,
    );
  }
  if (filters.search && String(filters.search).trim()) {
    const term = `%${String(filters.search).trim()}%`;
    clauses.push(
      `(slip_number ILIKE $${idx} OR truck_number ILIKE $${idx} OR customer_name ILIKE $${idx})`,
    );
    params.push(term);
    idx += 1;
  }

  const from = readIsoBound(filters.from);
  const to = readIsoBound(filters.to);
  if (from) {
    clauses.push(`COALESCE(timestamp_in, created_at) >= $${idx}`);
    params.push(from);
    idx += 1;
  }
  if (to) {
    clauses.push(`COALESCE(timestamp_in, created_at) <= $${idx}`);
    params.push(to);
    idx += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));
  const orderBy = from || to ? 'timestamp_in ASC NULLS LAST, created_at ASC' : 'created_at DESC';

  const res = await queryFn(
    `SELECT id, slip_number, truck_number, customer_name, destination, material,
            operator_name, tare_weight, gross_weight, net_weight, vehicle_type,
            timestamp_in, timestamp_out, ticket_status, synced_to_local, synced_at, local_id, release_at,
            mcg_status, created_at, report_s3_key,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3
     FROM remote_trips ${where}
     ORDER BY ${orderBy}
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

  // If PC already imported the trip before photos were attached, re-queue so
  // RemoteTripSync can download the new S3 keys onto the local ticket.
  // Held future tickets stay hidden until close time.
  const heldUntilOutTime = isHeldUntilOutTime(row);
  if (row.synced_to_local && !heldUntilOutTime) {
    updates.synced_at = null;
  }

  const cols = Object.keys(updates);
  // Re-queue photo download even if trip data already imported locally.
  const sets = [
    ...cols.map((c, i) => `${c} = $${i + 2}`),
    ...(!heldUntilOutTime ? ['synced_to_local = false'] : []),
  ];
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
    if (!isHeldUntilOutTime(trip)) {
      // Re-notify weighbridge (INSERT trigger already fired; photos often arrive after).
      try {
        await queryFn(`SELECT pg_notify('new_remote_trip', $1)`, [String(trip.id)]);
      } catch (err) {
        console.warn('[remoteTrip] photo notify failed', err.message);
      }
    }
  }
  return trip;
}

module.exports = {
  buildCreatePayload,
  validateRemoteTripFields,
  createRemoteTrip,
  importRemoteTrips,
  BULK_MAX_TRIPS,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
  upsertMirrorFromRemoteTrip,
  reconcileRemoteTripsToMirror,
  reconcileRemoteTripsFromMirror,
  releaseSlipIfLocallyRemapped,
  forceReleaseSlip,
  startMirrorReconcileWorker,
  startOutTimeReleaseWorker,
  runOutTimeRelease,
};
