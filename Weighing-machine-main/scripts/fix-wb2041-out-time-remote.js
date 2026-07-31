'use strict';
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

  initDatabase();
  const txn = TransactionService.getBySlipNumber('WB2041');
  if (!txn?.remote_pg_id) {
    console.log('No remote_pg_id — skip RDS');
    closeDatabase();
    return;
  }
  if (!pg.isConfigured() || !(await pg.ping())) {
    console.log('PG unreachable — local only');
    closeDatabase();
    return;
  }

  const upd = await pg.query(
    `UPDATE remote_trips
     SET timestamp_out = $2::timestamptz
     WHERE id = $1
     RETURNING slip_number, timestamp_in, timestamp_out`,
    [txn.remote_pg_id, txn.timestamp_out],
  );
  console.log('RDS updated:', upd.rows[0]);
  await pg.closePool();
  closeDatabase();
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
