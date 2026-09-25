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

  // Optional photo keys (so create+notify includes photos — avoids PC importing first without them).
  const photoS3Keys = Array.isArray(body.photoS3Keys) ? body.photoS3Keys : [];
  for (const item of photoS3Keys) {
    const slot = Number(item.slot);
    const key = item.key || item.s3Key;
    const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
    if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
    payload[`${pass}_photo_${slot}`] = key;
  }

  return payload;
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
  if (existing.synced_to_local) {
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

async function createRemoteTrip(queryFn, body = {}) {
  const data = buildCreatePayload(body);
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
    data.slip_number = String(row.slip_number).toUpperCase();
  }

  if (data.slip_number) {
    // Refresh all synced remote_trips from local mirror before claiming this slip.
    try {
      await reconcileRemoteTripsFromMirror(queryFn);
    } catch (err) {
      console.warn('[remoteTrip] pre-create reconcile from mirror failed', err.message);
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
          report_s3_key = COALESCE($22, report_s3_key)
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
            operator_name, tare_weight, gross_weight, net_weight, vehicle_type,
            timestamp_in, timestamp_out, synced_to_local, synced_at, local_id,
            mcg_status, created_at, report_s3_key,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3
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

  // If PC already imported the trip before photos were attached, re-queue so
  // RemoteTripSync can download the new S3 keys onto the local ticket.
  if (row.synced_to_local) {
    updates.synced_to_local = false;
    updates.synced_at = null;
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
    // Re-notify weighbridge (INSERT trigger already fired; photos often arrive after).
    try {
      await queryFn(`SELECT pg_notify('new_remote_trip', $1)`, [String(trip.id)]);
    } catch (err) {
      console.warn('[remoteTrip] photo notify failed', err.message);
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
  reconcileRemoteTripsFromMirror,
  releaseSlipIfLocallyRemapped,
  forceReleaseSlip,
  startMirrorReconcileWorker,
};
