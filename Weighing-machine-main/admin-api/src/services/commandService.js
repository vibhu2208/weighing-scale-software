'use strict';

const { query, getSiteId } = require('../db');

async function createCommand({ type, payload, createdBy }) {
  const siteId = getSiteId();
  const res = await query(
    `INSERT INTO admin_commands (site_id, type, payload, status, created_by)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING *`,
    [siteId, type, JSON.stringify(payload || {}), createdBy || null],
  );
  return res.rows[0];
}

async function listRecentCommands(limit = 20) {
  const siteId = getSiteId();
  const res = await query(
    `SELECT id, type, status, error, created_at, applied_at
     FROM admin_commands
     WHERE site_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [siteId, limit],
  );
  return res.rows;
}

async function getSyncStatus() {
  const siteId = getSiteId();
  const siteRes = await query(
    'SELECT id, name, last_seen_at, last_push_at FROM sites WHERE id = $1',
    [siteId],
  );
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'applied') AS applied,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed
     FROM admin_commands WHERE site_id = $1`,
    [siteId],
  );
  const mirror = await query(
    `SELECT
       COUNT(*) AS c,
       COUNT(*) FILTER (WHERE ticket_status = 'OPEN') AS open_c,
       COUNT(*) FILTER (WHERE ticket_status = 'CLOSED') AS closed_c
     FROM transactions_mirror WHERE site_id = $1`,
    [siteId],
  );
  return {
    site: siteRes.rows[0] || { id: siteId },
    commands: counts.rows[0],
    mirrorCount: Number(mirror.rows[0].c),
    mirrorOpenCount: Number(mirror.rows[0].open_c),
    mirrorClosedCount: Number(mirror.rows[0].closed_c),
  };
}

/**
 * Ask the weighbridge PC to push all local OPEN tickets into transactions_mirror.
 */
async function requestSyncOpenTickets(createdBy) {
  return createCommand({
    type: 'sync_open_tickets',
    payload: {},
    createdBy: createdBy || null,
  });
}

/**
 * Re-apply vehicle numbers from recent applied edit_report commands onto the mirror.
 * Needed while older weighbridge builds ignore truck_number then overwrite the mirror
 * with the previous plate on the next catch-up push.
 */
async function reassertVehicleFromAppliedEdits({ hours = 72, limit = 100 } = {}) {
  const siteId = getSiteId();
  const res = await query(
    `SELECT id, payload, applied_at, created_at, status
     FROM admin_commands
     WHERE site_id = $1
       AND type = 'edit_report'
       AND status IN ('applied', 'pending')
       AND COALESCE(applied_at, created_at) >= now() - ($2::text || ' hours')::interval
     ORDER BY COALESCE(applied_at, created_at) DESC
     LIMIT $3`,
    [siteId, String(Math.max(1, Number(hours) || 72)), Math.max(1, Math.min(Number(limit) || 100, 300))],
  );

  const latestBySlip = new Map();
  for (const row of res.rows || []) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
    const truck = String(payload.truck_number || payload.truckNumber || payload.vehicle_number || '')
      .trim()
      .toUpperCase();
    if (!truck) continue;
    const slips = [
      payload.newSlipNumber,
      payload.slip_number,
      payload.slipNumber,
    ]
      .map((s) => String(s || '').trim().toUpperCase())
      .filter(Boolean);
    for (const slip of [...new Set(slips)]) {
      if (!latestBySlip.has(slip)) {
        latestBySlip.set(slip, truck);
      }
    }
  }

  let updated = 0;
  for (const [slip, truck] of latestBySlip) {
    const result = await query(
      `UPDATE transactions_mirror
       SET truck_number = $3, updated_at = now()
       WHERE site_id = $1
         AND UPPER(slip_number) = $2
         AND UPPER(COALESCE(truck_number, '')) IS DISTINCT FROM $3
       RETURNING slip_number, truck_number`,
      [siteId, slip, truck],
    );
    if (result.rows[0]) {
      updated += 1;
      await query(
        `UPDATE remote_trips
         SET truck_number = $2, updated_at = now()
         WHERE UPPER(slip_number) = $1
           AND UPPER(COALESCE(truck_number, '')) IS DISTINCT FROM $2`,
        [slip, truck],
      ).catch(() => {});
    }
  }
  return { checked: latestBySlip.size, updated };
}

let vehicleReassertTimer = null;
function startVehicleReassertWorker() {
  if (vehicleReassertTimer) return;
  const tick = () => {
    reassertVehicleFromAppliedEdits().catch((err) => {
      console.warn('[sync] vehicle reassert failed', err.message);
    });
  };
  tick();
  vehicleReassertTimer = setInterval(tick, 20_000);
  if (typeof vehicleReassertTimer.unref === 'function') vehicleReassertTimer.unref();
}

/**
 * Re-queue a failed (or stuck) command so the weighbridge PC pulls it again.
 */
async function retryCommand(commandId) {
  const siteId = getSiteId();
  const id = String(commandId || '').trim();
  if (!id) throw new Error('command id required');

  const res = await query(
    `UPDATE admin_commands
     SET status = 'pending',
         error = NULL,
         applied_at = NULL
     WHERE id = $1
       AND site_id = $2
       AND status IN ('failed', 'pending')
     RETURNING id, type, status, error, created_at, applied_at`,
    [id, siteId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error('Command not found or already applied');
  }
  return row;
}

/** Re-queue all failed commands for this site. */
async function retryFailedCommands() {
  const siteId = getSiteId();
  const res = await query(
    `UPDATE admin_commands
     SET status = 'pending',
         error = NULL,
         applied_at = NULL
     WHERE site_id = $1
       AND status = 'failed'
     RETURNING id, type, status, created_at`,
    [siteId],
  );
  return { count: (res.rows || []).length, rows: res.rows || [] };
}

module.exports = {
  createCommand,
  listRecentCommands,
  getSyncStatus,
  requestSyncOpenTickets,
  reassertVehicleFromAppliedEdits,
  startVehicleReassertWorker,
  retryCommand,
  retryFailedCommands,
};
