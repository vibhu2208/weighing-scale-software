'use strict';

/**
 * Push cancelled WB3571 to transactions_mirror (and remote_trips if present).
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-wb3571-cancel-remote.js
 */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB3571';
const WEIGHT = 0;
const CANCEL_LABEL = 'CANCEL';

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

  const txn = TransactionService.getBySlipNumber(SLIP);
  if (!txn) throw new Error(`${SLIP} not found locally`);
  console.log('Local:', {
    slip: txn.slip_number,
    truck: txn.truck_number,
    ticket_status: txn.ticket_status,
    gross_weight: txn.gross_weight,
    tare_weight: txn.tare_weight,
    material: txn.material,
    customer_name: txn.customer_name,
    destination: txn.destination,
    operator_name: txn.operator_name,
    company: txn.company,
    remote_pg_id: txn.remote_pg_id,
  });

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

  if (txn.remote_pg_id) {
    const upd = await pg.query(
      `UPDATE remote_trips
       SET material = $2, customer_name = $2, destination = $2, operator_name = $2,
           gross_weight = $3, tare_weight = $3
       WHERE id = $1
       RETURNING id, slip_number, material, customer_name, destination,
                 operator_name, gross_weight, tare_weight`,
      [txn.remote_pg_id, CANCEL_LABEL, WEIGHT],
    );
    console.log('remote_trips by id:', upd.rows[0] || 'no row updated by id');
  }

  const bySlip = await pg.query(
    `SELECT id, slip_number, material, customer_name, destination,
            operator_name, gross_weight, tare_weight
     FROM remote_trips WHERE slip_number = $1`,
    [SLIP],
  );
  console.log('remote_trips by slip:', bySlip.rows);

  try {
    const push = await CloudAdminSyncService.pushTransaction(txn);
    console.log('mirror push:', push);
  } catch (err) {
    console.log('mirror push failed:', err.message);
  }

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
