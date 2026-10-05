'use strict';

/**
 * Restore WB4418 vehicle number and gross/tare/net; keep other fields CANCEL.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-wb4418-restore-vehicle-weights.js
 */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB4418';
const TRUCK = 'HR38AL8728';
const GROSS = 37560;
const TARE = 12460;
const SITE_IDS = ['WB - 03', 'WB-03'];

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

function summarize(txn) {
  if (!txn) return null;
  return {
    slip: txn.slip_number,
    truck: txn.truck_number,
    rfid: txn.rfid_tag,
    ticket_status: txn.ticket_status,
    status: txn.status,
    material: txn.material,
    customer_name: txn.customer_name,
    destination: txn.destination,
    operator_name: txn.operator_name,
    company: txn.company,
    driver: txn.driver,
    gross_weight: txn.gross_weight,
    tare_weight: txn.tare_weight,
    net_weight: txn.net_weight,
    notes: txn.notes,
  };
}

function openLocalDb() {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_PATH, { fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  return db;
}

async function main() {
  const pg = require('../backend/database/pg');

  try {
    const localDb = openLocalDb();
    const before = localDb
      .prepare(`SELECT * FROM transactions WHERE slip_number = ?`)
      .get(SLIP);
    if (!before) throw new Error(`${SLIP} not found locally`);
    console.log('Local before:', summarize(before));

    localDb
      .prepare(
        `UPDATE transactions
         SET truck_number = ?,
             gross_weight = ?,
             tare_weight = ?,
             raw_gross_weight = ?,
             raw_tare_weight = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(TRUCK, GROSS, TARE, GROSS, TARE, before.id);

    const after = localDb
      .prepare(`SELECT * FROM transactions WHERE slip_number = ?`)
      .get(SLIP);
    console.log('Local after:', summarize(after));
    localDb.close();
  } catch (err) {
    console.log('Local SQLite skipped:', err.message);
  }

  if (!pg.isConfigured()) {
    console.log('PG not configured — local only');
    return;
  }
  if (!(await pg.ping())) {
    console.log('PG unreachable — local only');
    return;
  }

  const bySlip = await pg.query(
    `UPDATE remote_trips
     SET truck_number = $2, gross_weight = $3, tare_weight = $4
     WHERE slip_number = $1
     RETURNING id, slip_number, truck_number, ticket_status, gross_weight, tare_weight`,
    [SLIP, TRUCK, GROSS, TARE],
  );
  console.log('remote_trips by slip:', bySlip.rows);

  for (const siteId of SITE_IDS) {
    const m = await pg.query(
      `UPDATE transactions_mirror
       SET truck_number = $3,
           gross_weight = $4,
           tare_weight = $5,
           updated_at = now()
       WHERE site_id = $1 AND slip_number = $2
       RETURNING site_id, slip_number, truck_number, rfid_tag, customer_name,
                 destination, material, operator_name, transporter, ticket_status,
                 gross_weight, tare_weight, net_weight`,
      [siteId, SLIP, TRUCK, GROSS, TARE],
    );
    console.log('mirror', siteId, m.rows);
  }

  await pg.closePool();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
