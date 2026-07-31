'use strict';

/**
 * Find remote trips blocked by local slip conflicts, rename to free slips, import.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-remote-slip-conflicts-and-sync.js
 */
const path = require('path');
const fs = require('fs');

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

function parseSlipNum(slip) {
  const m = String(slip || '').match(/^WB(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function nextFreeSlip(pg, getDb, TransactionService) {
  const localMaxRow = getDb()
    .prepare(
      `SELECT slip_number FROM transactions
       WHERE slip_number LIKE 'WB%'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
       LIMIT 1`,
    )
    .get();
  const localMax = parseSlipNum(localMaxRow?.slip_number);
  const rdsCounter = await pg.getSlipCounterValue();
  const remoteMaxRes = await pg.query(
    `SELECT MAX(CAST(substring(slip_number from 3) AS BIGINT)) AS m
     FROM remote_trips WHERE slip_number ~ '^WB[0-9]+$'`,
  );
  const remoteMax = Number(remoteMaxRes.rows[0]?.m || 0);
  let nextNum = Math.max(localMax, Number(rdsCounter || 0), remoteMax) + 1;
  for (let i = 0; i < 100; i += 1) {
    const candidate = `WB${nextNum}`;
    const localHit = TransactionService.getBySlipNumber(candidate);
    const remoteHit = await pg.query(
      'SELECT id FROM remote_trips WHERE slip_number = $1',
      [candidate],
    );
    if (!localHit && !remoteHit.rows.length) {
      await pg.syncSlipCounterToMax(nextNum);
      return candidate;
    }
    nextNum += 1;
  }
  throw new Error('Could not allocate a free slip number');
}

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const RemoteTripSyncService = require('../backend/services/RemoteTripSyncService');

  initDatabase();
  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  // 1) Pending rows
  // 2) "Synced" rows whose local_id points at a different truck / missing remote_pg_id match
  //    (classic slip-conflict false sync)
  const candidates = await pg.query(
    `SELECT * FROM remote_trips
     WHERE synced_to_local = false
        OR (mcg_error IS NOT NULL AND mcg_error ILIKE '%already exists%')
        OR (mcg_error IS NOT NULL AND mcg_error ILIKE '%slip%conflict%')
     ORDER BY created_at ASC
     LIMIT 80`,
  );

  // Also scan recent synced rows for false conflicts
  const recent = await pg.query(
    `SELECT * FROM remote_trips
     WHERE created_at > now() - interval '14 days'
     ORDER BY created_at DESC
     LIMIT 80`,
  );

  const byId = new Map();
  for (const row of [...candidates.rows, ...recent.rows]) {
    byId.set(row.id, row);
  }

  const toFix = [];
  for (const remote of byId.values()) {
    const byPg = TransactionService.getByRemotePgId(remote.id);
    if (byPg) continue; // truly imported

    const local = TransactionService.getBySlipNumber(remote.slip_number);
    if (!remote.synced_to_local || (local && local.remote_pg_id !== remote.id)) {
      // pending OR falsely marked synced against wrong/missing local
      if (!byPg) toFix.push(remote);
    }
  }

  console.log(`Candidates to fix/import: ${toFix.length}`);
  for (const r of toFix) {
    const local = TransactionService.getBySlipNumber(r.slip_number);
    console.log({
      slip: r.slip_number,
      truck: r.truck_number,
      synced: r.synced_to_local,
      mcg: r.mcg_status,
      mcg_error: r.mcg_error,
      conflict: local
        ? `${local.truck_number}/${local.ticket_status}/remote_pg=${local.remote_pg_id || 'null'}`
        : null,
    });
  }

  for (const remote of toFix) {
    console.log(`\n=== ${remote.slip_number} (${remote.truck_number}) ===`);

    if (TransactionService.getByRemotePgId(remote.id)) {
      console.log('Already imported — skip');
      continue;
    }

    const local = TransactionService.getBySlipNumber(remote.slip_number);
    if (local) {
      const newSlip = await nextFreeSlip(pg, getDb, TransactionService);
      console.log(
        `Rename ${remote.slip_number} → ${newSlip} (local held by ${local.truck_number}/${local.ticket_status})`,
      );
      await pg.query(
        `UPDATE remote_trips
         SET slip_number = $2,
             synced_to_local = false,
             synced_at = NULL,
             local_id = NULL,
             mcg_status = CASE WHEN mcg_status = 'sent' THEN mcg_status ELSE 'pending' END,
             mcg_error = NULL
         WHERE id = $1`,
        [remote.id, newSlip],
      );
    } else if (remote.synced_to_local) {
      console.log('Reset false-synced flag for re-import');
      await pg.query(
        `UPDATE remote_trips
         SET synced_to_local = false, synced_at = NULL, local_id = NULL, mcg_error = NULL
         WHERE id = $1`,
        [remote.id],
      );
    }

    const full = await pg.query('SELECT * FROM remote_trips WHERE id = $1', [remote.id]);
    try {
      const result = await RemoteTripSyncService.processRemoteRow(full.rows[0]);
      const imported = TransactionService.getByRemotePgId(remote.id);
      console.log('Result:', result);
      console.log(
        'Local:',
        imported
          ? `${imported.slip_number} ${imported.truck_number} ${imported.ticket_status} mcg=${imported.mcg_status}`
          : 'MISSING',
      );
    } catch (err) {
      console.error('FAILED import:', err.message);
    }
  }

  const still = await pg.query(
    `SELECT slip_number, truck_number, synced_to_local, mcg_status, mcg_error
     FROM remote_trips
     WHERE synced_to_local = false
     ORDER BY created_at ASC
     LIMIT 30`,
  );
  console.log('\nStill pending:', still.rows);

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
