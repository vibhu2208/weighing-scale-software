'use strict';

/** Push WB1915 to admin mirror after local edit. */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB1915';

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
  if (!txn) throw new Error(`${SLIP} not found`);
  console.log('Local:', {
    slip: txn.slip_number,
    truck: txn.truck_number,
    customer: txn.customer_name,
    destination: txn.destination,
    operator: txn.operator_name,
  });

  if (!pg.isConfigured() || !(await pg.ping())) {
    console.log('PG unavailable — local only');
    closeDatabase();
    return;
  }

  const push = await CloudAdminSyncService.pushTransaction(txn);
  console.log('mirror push:', push);
  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
