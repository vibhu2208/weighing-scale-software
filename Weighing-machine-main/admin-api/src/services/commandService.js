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
    'SELECT COUNT(*) AS c FROM transactions_mirror WHERE site_id = $1',
    [siteId],
  );
  return {
    site: siteRes.rows[0] || { id: siteId },
    commands: counts.rows[0],
    mirrorCount: Number(mirror.rows[0].c),
  };
}

module.exports = { createCommand, listRecentCommands, getSyncStatus };
