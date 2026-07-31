'use strict';

/**
 * Force-sync specific remote_trips slips from RDS → local SQLite.
 * Run:
 *   cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/sync-remote-trips-wb1781-1783.js
 */
const path = require('path');
const fs = require('fs');

const SLIPS = ['WB1783', 'WB1782', 'WB1781'];

function loadEnvFile(filePath, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
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

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
// Prefer installed app env (production) over project .env placeholders.
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);

// Use the live weighbridge SQLite DB under AppData.
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, resolveDbPath } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const RemoteTripSyncService = require('../backend/services/RemoteTripSyncService');

  console.log('DB path:', resolveDbPath());
  initDatabase();

  if (!pg.isConfigured()) {
    throw new Error('PG_SYNC_URL is not configured');
  }

  const pingOk = await pg.ping();
  if (!pingOk) {
    throw new Error('Cannot reach PostgreSQL (check network / RDS security group)');
  }

  console.log('Querying remote_trips for:', SLIPS.join(', '));
  const res = await pg.query(
    `SELECT id, slip_number, truck_number, synced_to_local, synced_at,
            local_id, mcg_status, created_at, timestamp_in, timestamp_out
     FROM remote_trips
     WHERE slip_number = ANY($1::text[])
     ORDER BY slip_number`,
    [SLIPS],
  );

  if (!res.rows.length) {
    console.log('No matching rows in remote_trips on RDS.');
    await pg.closePool();
    closeDatabase();
    return;
  }

  for (const row of res.rows) {
    const local = TransactionService.getBySlipNumber(row.slip_number);
    console.log('RDS:', {
      slip: row.slip_number,
      truck: row.truck_number,
      synced_to_local: row.synced_to_local,
      local_id: row.local_id,
      mcg_status: row.mcg_status,
      id: row.id,
      localPresent: !!local,
    });

    if (local) {
      console.log(
        `  Local already has ${row.slip_number} → ${local.id} (${local.ticket_status}).`,
      );
      if (!row.synced_to_local) {
        await pg.query(
          `UPDATE remote_trips
           SET synced_to_local = true, synced_at = now(), local_id = $2
           WHERE id = $1`,
          [row.id, local.id],
        );
        console.log('  Marked RDS row synced_to_local.');
      }
      continue;
    }

    // Not local yet — ensure pending so processNow will import it
    if (row.synced_to_local) {
      await pg.query(
        `UPDATE remote_trips
         SET synced_to_local = false, synced_at = NULL, local_id = NULL
         WHERE id = $1`,
        [row.id],
      );
      console.log(`  Reset ${row.slip_number} to pending for re-import.`);
    } else {
      console.log(`  ${row.slip_number} already pending.`);
    }
  }

  console.log('\nRunning RemoteTripSyncService.processNow()...');
  const result = await RemoteTripSyncService.processNow();
  console.log('processNow result:', result);

  console.log('\nLocal verification:');
  for (const slip of SLIPS) {
    const local = TransactionService.getBySlipNumber(slip);
    if (!local) {
      console.log(`  ${slip}: STILL MISSING locally`);
    } else {
      console.log(
        `  ${slip}: OK id=${local.id} truck=${local.truck_number} status=${local.ticket_status}`,
      );
    }
  }

  await pg.closePool();
  closeDatabase();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
