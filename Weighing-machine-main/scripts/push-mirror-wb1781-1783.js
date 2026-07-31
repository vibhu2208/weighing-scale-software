'use strict';

/**
 * Push specific closed slips to transactions_mirror (admin panel).
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

  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  const siteId = (process.env.WEIGHBRIDGE_ID || 'WB-03').trim();
  console.log('Site:', siteId);

  for (const slip of SLIPS) {
    const txn = TransactionService.getBySlipNumber(slip);
    if (!txn) {
      console.log(`${slip}: missing locally — skip`);
      continue;
    }
    console.log(`Pushing ${slip} (${txn.truck_number}, ${txn.ticket_status})...`);
    const result = await CloudAdminSyncService.pushTransaction(txn);
    console.log(`  push result:`, result);

    const mirror = await pg.query(
      `SELECT site_id, slip_number, truck_number, ticket_status, updated_at
       FROM transactions_mirror
       WHERE site_id = $1 AND slip_number = $2`,
      [siteId, slip],
    );
    console.log(
      `  mirror:`,
      mirror.rows[0] || 'NOT FOUND after push',
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
