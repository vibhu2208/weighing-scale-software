'use strict';

/**
 * Sync remote trips WB2041, WB2040, WB2039, WB2038, WB2027, WB2026 → local.
 * On slip collision with an existing local ticket, rename the remote slip to the
 * next free number, then import.
 *
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/sync-remote-trips-wb2041-2026.js
 */
const path = require('path');
const fs = require('fs');

const SLIPS = ['WB2041', 'WB2040', 'WB2039', 'WB2038', 'WB2027', 'WB2026'];

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
  // Ensure free on both sides (skip any unexpected collision)
  for (let i = 0; i < 50; i += 1) {
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

  const { initDatabase, closeDatabase, getDb, resolveDbPath } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const RemoteTripSyncService = require('../backend/services/RemoteTripSyncService');

  console.log('DB path:', resolveDbPath());
  initDatabase();

  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL is not configured');
  if (!(await pg.ping())) {
    throw new Error('Cannot reach PostgreSQL (check network / RDS security group)');
  }

  console.log('Querying remote_trips for:', SLIPS.join(', '));
  const res = await pg.query(
    `SELECT * FROM remote_trips
     WHERE slip_number = ANY($1::text[])
     ORDER BY CAST(substring(slip_number from 3) AS BIGINT)`,
    [SLIPS],
  );

  if (!res.rows.length) {
    console.log('No matching rows in remote_trips on RDS.');
    await pg.closePool();
    closeDatabase();
    return;
  }

  for (const remote of res.rows) {
    console.log('\n---', remote.slip_number, '---');
    console.log('RDS:', {
      id: remote.id,
      truck: remote.truck_number,
      synced_to_local: remote.synced_to_local,
      local_id: remote.local_id,
      mcg_status: remote.mcg_status,
      gross: remote.gross_weight,
      tare: remote.tare_weight,
    });

    const byPg = TransactionService.getByRemotePgId(remote.id);
    if (byPg) {
      console.log(`Already imported as ${byPg.slip_number} (${byPg.id}).`);
      if (!remote.synced_to_local) {
        await pg.query(
          `UPDATE remote_trips
           SET synced_to_local = true, synced_at = now(), local_id = $2
           WHERE id = $1`,
          [remote.id, byPg.id],
        );
      }
      continue;
    }

    let slip = remote.slip_number;
    const localBySlip = TransactionService.getBySlipNumber(slip);
    if (localBySlip) {
      // Collision: local ticket is not this remote trip
      const newSlip = await nextFreeSlip(pg, getDb, TransactionService);
      console.log(
        `Slip conflict with local ${slip} (${localBySlip.truck_number}, ${localBySlip.ticket_status}). Renaming remote → ${newSlip}`,
      );
      await pg.query(
        `UPDATE remote_trips
         SET slip_number = $2,
             synced_to_local = false,
             synced_at = NULL,
             local_id = NULL,
             mcg_status = CASE WHEN mcg_status = 'sent' THEN mcg_status ELSE 'pending' END
         WHERE id = $1`,
        [remote.id, newSlip],
      );
      slip = newSlip;
    } else if (remote.synced_to_local) {
      await pg.query(
        `UPDATE remote_trips
         SET synced_to_local = false, synced_at = NULL, local_id = NULL
         WHERE id = $1`,
        [remote.id],
      );
      console.log(`Reset ${slip} to pending for re-import.`);
    } else {
      console.log(`${slip} already pending.`);
    }
  }

  console.log('\nRunning RemoteTripSyncService.processNow()...');
  const result = await RemoteTripSyncService.processNow();
  console.log('processNow:', result);

  console.log('\nVerification:');
  for (const slip of SLIPS) {
    const local = TransactionService.getBySlipNumber(slip);
    if (local) {
      console.log(
        `  ${slip}: OK truck=${local.truck_number} status=${local.ticket_status} remote_pg_id=${local.remote_pg_id || 'null'}`,
      );
    } else {
      // May have been renamed — check if any of the remotes imported under new slip
      console.log(`  ${slip}: not present under original slip (may have been renamed)`);
    }
  }

  // Show any newly imported from these remote ids
  const ids = res.rows.map((r) => r.id);
  for (const id of ids) {
    const imported = TransactionService.getByRemotePgId(id);
    const rds = await pg.query(
      'SELECT slip_number, synced_to_local, local_id FROM remote_trips WHERE id = $1',
      [id],
    );
    console.log('  remote id', id, '→ local', imported ? `${imported.slip_number}/${imported.truck_number}` : 'MISSING', '| RDS', rds.rows[0]);
  }

  await pg.closePool();
  closeDatabase();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
