'use strict';

/**
 * Sync remote_trips + transactions_mirror for WB2599–WB2608 operator/destination fix.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-wb2599-2608-op-dest-remote.js
 */
const path = require('path');
const fs = require('fs');

const SLIPS = [
  'WB2599',
  'WB2600',
  'WB2601',
  'WB2603',
  'WB2604',
  'WB2605',
  'WB2606',
  'WB2607',
  'WB2608',
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
  const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');

  initDatabase();

  if (!pg.isConfigured()) {
    console.log('PG not configured — local only');
    closeDatabase();
    return;
  }
  if (!(await pg.ping())) {
    console.log('PG unreachable — local only');
    closeDatabase();
    return;
  }

  for (const slip of SLIPS) {
    const txn = TransactionService.getBySlipNumber(slip);
    if (!txn) {
      console.log(`${slip}: NOT FOUND locally — skip`);
      continue;
    }
    console.log('Local:', {
      slip: txn.slip_number,
      truck: txn.truck_number,
      operator: txn.operator_name,
      destination: txn.destination,
      remote_pg_id: txn.remote_pg_id,
    });

    if (txn.remote_pg_id) {
      const upd = await pg.query(
        `UPDATE remote_trips
         SET operator_name = $2, destination = $3
         WHERE id = $1
         RETURNING id, slip_number, operator_name, destination`,
        [txn.remote_pg_id, txn.operator_name, txn.destination],
      );
      console.log('remote_trips by id:', upd.rows[0] || 'no row');
    }

    const bySlip = await pg.query(
      `UPDATE remote_trips
       SET operator_name = $2, destination = $3
       WHERE slip_number = $1
       RETURNING id, slip_number, operator_name, destination`,
      [slip, txn.operator_name, txn.destination],
    );
    console.log('remote_trips by slip:', bySlip.rows);

    try {
      const push = await CloudAdminSyncService.pushTransaction(txn);
      console.log('mirror push:', push);
    } catch (err) {
      console.log('mirror push failed:', err.message);
    }
  }

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
