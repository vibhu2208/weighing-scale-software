'use strict';

/**
 * Read-only: list slips where admin (remote_trips or transactions_mirror)
 * has photo keys the local ticket is missing on disk.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/find-unsynced-admin-images.js
 */
const path = require('path');
const fs = require('fs');

const PHOTO_COLS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

function loadEnvFile(filePath, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (overwrite || !process.env[key]) process.env[key] = val;
  }
}

function filled(row) {
  const out = {};
  if (!row) return out;
  for (const col of PHOTO_COLS) {
    const v = row[col] && String(row[col]).trim();
    if (v) out[col] = v;
  }
  return out;
}

function localMissing(local, adminKeys) {
  const missing = [];
  for (const col of Object.keys(adminKeys)) {
    const p = local && local[col] && String(local[col]).trim();
    if (!p || !fs.existsSync(p)) missing.push(col);
  }
  return missing;
}

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

const PHOTO_WHERE = PHOTO_COLS.map(
  (c) => `NULLIF(BTRIM(COALESCE(${c}, '')), '') IS NOT NULL`,
).join(' OR ');

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');

  initDatabase();
  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  const cmdRes = await pg.query(
    `SELECT id, site_id, type, status, error, created_at,
            COALESCE(payload->>'slipNumber', payload->>'slip_number') AS slip,
            CASE
              WHEN jsonb_typeof(payload->'photoS3Keys') = 'array'
                THEN jsonb_array_length(payload->'photoS3Keys')
              ELSE 0
            END AS photo_count
     FROM admin_commands
     WHERE status IN ('pending', 'failed')
     ORDER BY created_at ASC`,
  );
  console.log(
    'PENDING/FAILED COMMANDS',
    JSON.stringify(
      cmdRes.rows.map((row) => ({
        id: row.id,
        site_id: row.site_id,
        type: row.type,
        status: row.status,
        slip: row.slip,
        photos: Number(row.photo_count),
        error: row.error,
        created_at: row.created_at,
      })),
      null,
      2,
    ),
  );

  const remoteRes = await pg.query(
    `SELECT id, slip_number, truck_number, synced_to_local, local_id, created_at,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3
     FROM remote_trips
     WHERE ${PHOTO_WHERE}
     ORDER BY created_at DESC`,
  );

  let mirrorRows = [];
  try {
    const mirrorRes = await pg.query(
      `SELECT site_id, slip_number, local_id, updated_at,
              arrival_photo_1, arrival_photo_2, arrival_photo_3,
              departure_photo_1, departure_photo_2, departure_photo_3
       FROM transactions_mirror
       WHERE ${PHOTO_WHERE}`,
    );
    mirrorRows = mirrorRes.rows || [];
  } catch (err) {
    console.warn('mirror query failed:', err.message);
  }

  const bySlip = new Map();
  function ensure(slip) {
    if (!bySlip.has(slip)) {
      bySlip.set(slip, { slip, remote: null, mirrorSites: [], adminKeys: {} });
    }
    return bySlip.get(slip);
  }

  for (const row of remoteRes.rows) {
    const entry = ensure(row.slip_number);
    entry.remote = {
      id: row.id,
      synced_to_local: row.synced_to_local,
      truck: row.truck_number,
      created_at: row.created_at,
    };
    Object.assign(entry.adminKeys, filled(row));
  }
  for (const row of mirrorRows) {
    const entry = ensure(row.slip_number);
    const keys = filled(row);
    entry.mirrorSites.push(`${row.site_id}:${Object.keys(keys).length}`);
    for (const [col, key] of Object.entries(keys)) {
      if (!entry.adminKeys[col]) entry.adminKeys[col] = key;
    }
  }

  const gaps = [];
  for (const entry of bySlip.values()) {
    const local =
      (entry.remote && TransactionService.getByRemotePgId(entry.remote.id)) ||
      TransactionService.getBySlipNumber(entry.slip);
    const missing = localMissing(local, entry.adminKeys);
    if (!missing.length) continue;
    gaps.push({
      slip: entry.slip,
      localSlip: local?.slip_number || null,
      localStatus: local?.ticket_status || null,
      remoteSynced: entry.remote ? !!entry.remote.synced_to_local : null,
      truck: local?.truck_number || entry.remote?.truck || null,
      adminPhotoCount: Object.keys(entry.adminKeys).length,
      missing,
      mirrorSites: entry.mirrorSites,
    });
  }

  gaps.sort((a, b) => String(a.slip).localeCompare(String(b.slip)));
  console.log(
    JSON.stringify(
      {
        remoteWithPhotos: remoteRes.rows.length,
        mirrorWithPhotos: mirrorRows.length,
        slipsWithAdminPhotos: bySlip.size,
        unsynced: gaps.length,
        gaps,
      },
      null,
      2,
    ),
  );

  await pg.closePool();
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
