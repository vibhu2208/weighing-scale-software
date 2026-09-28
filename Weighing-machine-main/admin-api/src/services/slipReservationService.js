'use strict';

const { getPool, query } = require('../db');

const FIRE_EARLY_MINUTES = 5;
const MISS_AFTER_MINUTES = 30;
const WORKER_INTERVAL_MS = 30_000;
/** Planned gap times must be strictly more than 1 minute apart. */
const MIN_GAP_MS = 60 * 1000;
const MAX_BUMP_STEPS = 120;

let schemaReady = false;
let workerTimer = null;
let workerRunning = false;

async function ensureSchema(queryFn = query) {
  if (schemaReady) return;

  await queryFn(`
    CREATE TABLE IF NOT EXISTS slip_reservations (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      slip_number     TEXT UNIQUE,
      planned_at      TIMESTAMPTZ NOT NULL,
      note            TEXT,
      status          TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled', 'held', 'used', 'released', 'missed')),
      remote_trip_id  TEXT,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      blocked_at      TIMESTAMPTZ,
      fire_error      TEXT,
      used_at         TIMESTAMPTZ,
      released_at     TIMESTAMPTZ
    )
  `);

  // Migrate older installs (immediate-block schema).
  await queryFn(`ALTER TABLE slip_reservations ALTER COLUMN slip_number DROP NOT NULL`).catch(
    () => {},
  );
  await queryFn(
    `ALTER TABLE slip_reservations ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`,
  ).catch(() => {});
  await queryFn(`ALTER TABLE slip_reservations ADD COLUMN IF NOT EXISTS fire_error TEXT`).catch(
    () => {},
  );

  await queryFn(`
    DO $$
    BEGIN
      ALTER TABLE slip_reservations DROP CONSTRAINT IF EXISTS slip_reservations_status_check;
      ALTER TABLE slip_reservations
        ADD CONSTRAINT slip_reservations_status_check
        CHECK (status IN ('scheduled', 'held', 'used', 'released', 'missed'));
    EXCEPTION WHEN others THEN
      NULL;
    END $$
  `);

  await queryFn(`
    ALTER TABLE slip_reservations ALTER COLUMN status SET DEFAULT 'scheduled'
  `).catch(() => {});

  await queryFn(`
    CREATE INDEX IF NOT EXISTS idx_slip_reservations_status_planned
      ON slip_reservations (status, planned_at)
  `);
  await queryFn(`
    CREATE INDEX IF NOT EXISTS idx_slip_reservations_held
      ON slip_reservations (planned_at)
      WHERE status = 'held'
  `);
  await queryFn(`
    CREATE INDEX IF NOT EXISTS idx_slip_reservations_scheduled_fire
      ON slip_reservations (planned_at)
      WHERE status = 'scheduled'
  `);

  schemaReady = true;
}

function parseTimestamp(value, fieldName) {
  if (!value) throw new Error(`${fieldName} is required`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${fieldName}`);
  return parsed.toISOString();
}

function assertGapsMoreThanOneMinute(sortedIsoTimes, labelPrefix = 'Trip') {
  for (let i = 1; i < sortedIsoTimes.length; i += 1) {
    const prev = new Date(sortedIsoTimes[i - 1]).getTime();
    const cur = new Date(sortedIsoTimes[i]).getTime();
    const diff = cur - prev;
    if (diff <= MIN_GAP_MS) {
      const prevLabel = new Date(sortedIsoTimes[i - 1]).toLocaleString('en-IN');
      const curLabel = new Date(sortedIsoTimes[i]).toLocaleString('en-IN');
      throw new Error(
        `${labelPrefix} times must be more than 1 minute apart. ` +
          `"${curLabel}" is only ${Math.max(0, Math.round(diff / 1000))}s after "${prevLabel}".`,
      );
    }
  }
}

async function loadActiveReservationTimes(queryFn = query, excludeIds = []) {
  const res = await queryFn(
    `SELECT id, planned_at, status, slip_number
     FROM slip_reservations
     WHERE status IN ('scheduled', 'held', 'missed')
     ORDER BY planned_at ASC`,
  );
  const exclude = new Set(excludeIds.map(String));
  return (res.rows || [])
    .filter((r) => !exclude.has(String(r.id)))
    .map((r) => ({
      id: r.id,
      planned_at: new Date(r.planned_at).toISOString(),
      status: r.status,
      slip_number: r.slip_number,
    }));
}

/**
 * True if weighbridge mirror has a ticket (live kata) whose in/out falls in the same minute.
 */
async function minuteHasLiveWeighment(queryFn, siteId, plannedIso) {
  const start = new Date(plannedIso);
  if (Number.isNaN(start.getTime())) return false;
  const minuteStart = new Date(Math.floor(start.getTime() / MIN_GAP_MS) * MIN_GAP_MS);
  const minuteEnd = new Date(minuteStart.getTime() + MIN_GAP_MS);

  const res = await queryFn(
    `SELECT slip_number, ticket_status
     FROM transactions_mirror
     WHERE site_id = $1
       AND ticket_status IN ('OPEN', 'CLOSED')
       AND (
         (timestamp_in >= $2 AND timestamp_in < $3)
         OR (timestamp_out >= $2 AND timestamp_out < $3)
       )
     LIMIT 1`,
    [siteId, minuteStart.toISOString(), minuteEnd.toISOString()],
  );
  return res.rows[0] || null;
}

/**
 * If the planned minute collides with live weighbridge traffic, bump +1 minute
 * until that minute is free of mirror OPEN/CLOSED weighments.
 */
async function resolveAwayFromLiveTraffic(queryFn, siteId, plannedIso) {
  let candidate = new Date(plannedIso);
  if (Number.isNaN(candidate.getTime())) {
    throw new Error('Invalid planned time');
  }
  const bumps = [];
  for (let step = 0; step < MAX_BUMP_STEPS; step += 1) {
    const iso = candidate.toISOString();
    const live = await minuteHasLiveWeighment(queryFn, siteId, iso);
    if (!live) {
      return { planned_at: iso, bumps };
    }
    bumps.push({
      from: iso,
      reason: `weighbridge busy (slip ${live.slip_number}, ${live.ticket_status})`,
    });
    candidate = new Date(candidate.getTime() + MIN_GAP_MS);
  }
  throw new Error(
    `Could not find a free minute after ${plannedIso} — weighbridge is continuously busy`,
  );
}

function normalizeSlots(body = {}) {
  const rawSlots = Array.isArray(body.slots) ? body.slots : null;
  if (rawSlots && rawSlots.length) {
    if (rawSlots.length > 50) throw new Error('Maximum 50 reserved slips per plan');
    return rawSlots.map((slot, i) => ({
      planned_at: parseTimestamp(slot.planned_at || slot.time, `slot ${i + 1} time`),
      note: slot.note ? String(slot.note).trim() : null,
    }));
  }

  const times = Array.isArray(body.times) ? body.times : [];
  const count = Number(body.count);
  if (Number.isFinite(count) && count > 0 && times.length === 0) {
    throw new Error('Provide a planned time for each trip');
  }
  if (!times.length) throw new Error('Add at least one planned trip time');
  if (times.length > 50) throw new Error('Maximum 50 reserved slips per plan');

  const batchNote = body.note ? String(body.note).trim() : null;
  return times.map((t, i) => ({
    planned_at: parseTimestamp(t, `trip ${i + 1} time`),
    note: batchNote,
  }));
}

async function getCounterHint(queryFn = query) {
  const res = await queryFn(
    'SELECT prefix, current_value FROM slip_counter WHERE id = 1 LIMIT 1',
  );
  const row = res.rows[0];
  if (!row) return { prefix: 'WB', current_value: 0, next_slip: 'WB0001' };
  const next = Number(row.current_value || 0) + 1;
  const prefix = row.prefix || 'WB';
  return {
    prefix,
    current_value: Number(row.current_value || 0),
    next_slip: `${prefix}${String(next).padStart(4, '0')}`,
  };
}

async function planReservations(body = {}, createdBy = null) {
  await ensureSchema();
  const { getSiteId } = require('../db');
  const siteId = getSiteId();
  const slots = normalizeSlots(body);
  const batchNote = body.note ? String(body.note).trim() : null;

  // Reject batch times that are ≤1 minute apart (before live bumping).
  const batchSorted = [...slots]
    .map((s) => s.planned_at)
    .sort((a, b) => new Date(a) - new Date(b));
  assertGapsMoreThanOneMinute(batchSorted, 'Planned');

  const existing = await loadActiveReservationTimes();

  const resolved = [];
  const adjustments = [];
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const before = slot.planned_at;
    const { planned_at: after, bumps } = await resolveAwayFromLiveTraffic(
      query,
      siteId,
      before,
    );
    if (after !== before) {
      adjustments.push({
        trip: i + 1,
        requested: before,
        scheduled: after,
        bumps,
      });
    }
    resolved.push({ ...slot, planned_at: after, original_planned_at: before });
  }

  // New times vs each other (after bump) and vs already scheduled/held gaps.
  const allTimes = [
    ...existing.map((e) => e.planned_at),
    ...resolved.map((s) => s.planned_at),
  ].sort((a, b) => new Date(a) - new Date(b));
  assertGapsMoreThanOneMinute(allTimes, 'Gap');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const slot of resolved) {
      const note = slot.note || batchNote || null;
      const ins = await client.query(
        `INSERT INTO slip_reservations
           (slip_number, planned_at, note, status, created_by)
         VALUES (NULL, $1, $2, 'scheduled', $3)
         RETURNING *`,
        [slot.planned_at, note, createdBy],
      );
      created.push({
        ...ins.rows[0],
        original_planned_at: slot.original_planned_at,
      });
    }
    await client.query('COMMIT');
    return { rows: created, adjustments };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function allocateSlipOnClient(client) {
  const slipRes = await client.query('SELECT next_slip_number() AS slip');
  const slip = slipRes.rows[0]?.slip;
  if (!slip) throw new Error('Failed to allocate slip number');
  return slip;
}

async function fireOneReservation(id) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM slip_reservations
       WHERE id = $1 AND status IN ('scheduled', 'missed')
       FOR UPDATE`,
      [id],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      throw new Error('Reservation not found or already blocked/used/released');
    }

    const slip = await allocateSlipOnClient(client);
    const upd = await client.query(
      `UPDATE slip_reservations
       SET slip_number = $2,
           status = 'held',
           blocked_at = now(),
           fire_error = NULL
       WHERE id = $1
       RETURNING *`,
      [id, slip],
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function fireReservationNow(id) {
  await ensureSchema();
  return fireOneReservation(id);
}

async function fireDueReservations() {
  await ensureSchema();
  const due = await query(
    `SELECT id FROM slip_reservations
     WHERE status = 'scheduled'
       AND planned_at - ($1 * INTERVAL '1 minute') <= now()
       AND planned_at + ($2 * INTERVAL '1 minute') >= now()
     ORDER BY planned_at ASC
     LIMIT 50`,
    [FIRE_EARLY_MINUTES, MISS_AFTER_MINUTES],
  );

  const fired = [];
  for (const row of due.rows || []) {
    try {
      const held = await fireOneReservation(row.id);
      fired.push(held);
    } catch (err) {
      await query(
        `UPDATE slip_reservations SET fire_error = $2 WHERE id = $1 AND status = 'scheduled'`,
        [row.id, err.message || 'fire failed'],
      ).catch(() => {});
      console.warn('[slipReservations] fire failed', row.id, err.message);
    }
  }
  return fired;
}

async function markMissedReservations() {
  await ensureSchema();
  const res = await query(
    `UPDATE slip_reservations
     SET status = 'missed',
         fire_error = COALESCE(fire_error, 'Auto-block window expired (API/DB may have been offline)')
     WHERE status = 'scheduled'
       AND planned_at + ($1 * INTERVAL '1 minute') < now()
     RETURNING *`,
    [MISS_AFTER_MINUTES],
  );
  return res.rows || [];
}

async function runFireWorkerOnce() {
  if (workerRunning) return { fired: [], missed: [] };
  workerRunning = true;
  try {
    const fired = await fireDueReservations();
    const missed = await markMissedReservations();
    if (fired.length || missed.length) {
      console.log('[slipReservations] worker', {
        fired: fired.length,
        missed: missed.length,
      });
    }
    return { fired, missed };
  } catch (err) {
    console.warn('[slipReservations] worker error', err.message);
    return { fired: [], missed: [], error: err.message };
  } finally {
    workerRunning = false;
  }
}

function startFireWorker() {
  if (workerTimer) return;
  const tick = () => {
    runFireWorkerOnce().catch(() => {});
  };
  tick();
  workerTimer = setInterval(tick, WORKER_INTERVAL_MS);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  console.log('[slipReservations] fire worker started', {
    everySec: WORKER_INTERVAL_MS / 1000,
    fireEarlyMin: FIRE_EARLY_MINUTES,
    missAfterMin: MISS_AFTER_MINUTES,
  });
}

function stopFireWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

async function getSummary() {
  await ensureSchema();
  const res = await query(
    `SELECT status, COUNT(*)::int AS count
     FROM slip_reservations
     GROUP BY status`,
  );
  const summary = {
    scheduled: 0,
    held: 0,
    used: 0,
    released: 0,
    missed: 0,
  };
  for (const row of res.rows || []) {
    if (Object.prototype.hasOwnProperty.call(summary, row.status)) {
      summary[row.status] = Number(row.count) || 0;
    }
  }
  return summary;
}

async function listReservations(filters = {}) {
  await ensureSchema();
  const clauses = [];
  const params = [];
  let idx = 1;

  const statusFilter = String(filters.status || '').trim();
  if (statusFilter === 'active') {
    clauses.push(`status IN ('scheduled', 'held', 'missed')`);
  } else if (statusFilter && statusFilter !== 'all') {
    clauses.push(`status = $${idx}`);
    params.push(statusFilter);
    idx += 1;
  }

  if (filters.held_only === 'true' || filters.held_only === true) {
    clauses.push(`status = 'held'`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(Number(filters.limit) || 100, 300));

  const res = await query(
    `SELECT *
     FROM slip_reservations
     ${where}
     ORDER BY
       CASE status
         WHEN 'missed' THEN 0
         WHEN 'scheduled' THEN 1
         WHEN 'held' THEN 2
         WHEN 'used' THEN 3
         ELSE 4
       END,
       planned_at ASC,
       created_at DESC
     LIMIT $${idx}`,
    [...params, limit],
  );
  return res.rows || [];
}

async function getReservation(id) {
  await ensureSchema();
  const res = await query('SELECT * FROM slip_reservations WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

async function getHeldBySlip(slipNumber) {
  await ensureSchema();
  const slip = String(slipNumber || '').trim().toUpperCase();
  if (!slip) return null;
  const res = await query(
    `SELECT * FROM slip_reservations
     WHERE slip_number = $1 AND status = 'held'
     LIMIT 1`,
    [slip],
  );
  return res.rows[0] || null;
}

async function releaseReservation(id) {
  await ensureSchema();
  const res = await query(
    `UPDATE slip_reservations
     SET status = 'released', released_at = now()
     WHERE id = $1 AND status IN ('scheduled', 'held', 'missed')
     RETURNING *`,
    [id],
  );
  if (!res.rows[0]) {
    throw new Error('Reservation not found or already used/released');
  }
  return res.rows[0];
}

async function markReservationUsed(slipNumber, remoteTripId = null, queryFn = query) {
  await ensureSchema(queryFn);
  const slip = String(slipNumber || '').trim().toUpperCase();
  if (!slip) return null;

  const res = await queryFn(
    `UPDATE slip_reservations
     SET status = 'used',
         used_at = now(),
         remote_trip_id = COALESCE($2, remote_trip_id)
     WHERE slip_number = $1 AND status IN ('held', 'released')
     RETURNING *`,
    [slip, remoteTripId],
  );
  return res.rows[0] || null;
}

module.exports = {
  FIRE_EARLY_MINUTES,
  MISS_AFTER_MINUTES,
  MIN_GAP_MS,
  ensureSchema,
  getCounterHint,
  planReservations,
  listReservations,
  getSummary,
  getReservation,
  getHeldBySlip,
  releaseReservation,
  markReservationUsed,
  fireDueReservations,
  markMissedReservations,
  fireReservationNow,
  runFireWorkerOnce,
  startFireWorker,
  stopFireWorker,
};
