'use strict';

/**
 * Sync specific remote trips WB2153, WB2154, WB2155.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/sync-remote-wb2153-2155.js
 */
const path = require('path');
const fs = require('fs');

const SLIPS = ['WB2153', 'WB2154', 'WB2155'];

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

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const RemoteTripSyncService = require('../backend/services/RemoteTripSyncService');

  initDatabase();
  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  const res = await pg.query(
    `SELECT * FROM remote_trips WHERE slip_number = ANY($1::text[]) ORDER BY slip_number`,
    [SLIPS],
  );
  console.log('Found on RDS:', res.rows.map((r) => r.slip_number));

  for (const remote of res.rows) {
    console.log(`\n=== ${remote.slip_number} ===`);
    if (TransactionService.getByRemotePgId(remote.id)) {
      console.log('Already imported');
      continue;
    }
    if (remote.synced_to_local) {
      await pg.query(
        `UPDATE remote_trips SET synced_to_local=false, synced_at=NULL, local_id=NULL WHERE id=$1`,
        [remote.id],
      );
    }
    const full = await pg.query('SELECT * FROM remote_trips WHERE id=$1', [remote.id]);
    const result = await RemoteTripSyncService.processRemoteRow(full.rows[0]);
    console.log('Result:', result);
    const local = TransactionService.getBySlipNumber(remote.slip_number);
    console.log(
      'Local:',
      local
        ? `${local.slip_number} ${local.truck_number} ${local.ticket_status}`
        : 'MISSING',
    );
  }

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
