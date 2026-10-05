'use strict';

/**
 * Set every display field on WB4418 to CANCEL (weights 0) locally and remotely.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-wb4418-cancel-all-fields.js
 */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB4418';
const CANCEL_LABEL = 'CANCEL';
const WEIGHT = 0;
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
    transporter: txn.vehicle?.transporter || txn.transporter || null,
    gross_weight: txn.gross_weight,
    tare_weight: txn.tare_weight,
    net_weight: txn.net_weight,
    notes: txn.notes,
    remote_pg_id: txn.remote_pg_id,
  };
}

function openLocalDb() {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH;
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  return db;
}

async function main() {
  const pg = require('../backend/database/pg');
  const { TICKET_STATUS, TRANSACTION_STATUS } = require('../backend/utils/constants');

  let txn = { remote_pg_id: null };
  try {
    const localDb = openLocalDb();
    txn = localDb
      .prepare(`SELECT * FROM transactions WHERE slip_number = ?`)
      .get(SLIP);
    if (!txn) throw new Error(`${SLIP} not found locally`);
    console.log('Local before:', summarize(txn));

    localDb
      .prepare(
        `UPDATE transactions
         SET truck_number = ?,
             rfid_tag = ?,
             material = ?,
             driver = ?,
             customer_name = ?,
             destination = ?,
             operator_name = ?,
             company = ?,
             notes = ?,
             ticket_status = ?,
             status = ?,
             gross_weight = ?,
             tare_weight = ?,
             raw_gross_weight = ?,
             raw_tare_weight = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        CANCEL_LABEL,
        TICKET_STATUS.CANCELLED,
        TRANSACTION_STATUS.CANCELLED,
        WEIGHT,
        WEIGHT,
        WEIGHT,
        WEIGHT,
        txn.id,
      );

    const afterLocal = localDb
      .prepare(`SELECT * FROM transactions WHERE slip_number = ?`)
      .get(SLIP);
    console.log('Local after:', summarize(afterLocal));
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

  const remoteSets = `
    truck_number = $2,
    rfid_tag = $2,
    material = $2,
    customer_name = $2,
    destination = $2,
    operator_name = $2,
    transporter = $2,
    ticket_status = $3,
    status = $4,
    gross_weight = $5,
    tare_weight = $5
  `;
  const remoteReturning = `
    RETURNING id, slip_number, truck_number, rfid_tag, material, customer_name,
              destination, operator_name, transporter, ticket_status, status,
              gross_weight, tare_weight
  `;

  if (txn.remote_pg_id) {
    const upd = await pg.query(
      `UPDATE remote_trips SET ${remoteSets} WHERE id = $1 ${remoteReturning}`,
      [txn.remote_pg_id, CANCEL_LABEL, TICKET_STATUS.CANCELLED, TRANSACTION_STATUS.CANCELLED, WEIGHT],
    );
    console.log('remote_trips by id:', upd.rows[0] || 'no row updated by id');
  }

  const bySlip = await pg.query(
    `UPDATE remote_trips SET ${remoteSets} WHERE slip_number = $1 ${remoteReturning}`,
    [SLIP, CANCEL_LABEL, TICKET_STATUS.CANCELLED, TRANSACTION_STATUS.CANCELLED, WEIGHT],
  );
  console.log('remote_trips by slip:', bySlip.rows);

  const mirrorSets = `
    truck_number = $3,
    rfid_tag = $3,
    customer_name = $3,
    destination = $3,
    material = $3,
    operator_name = $3,
    transporter = $3,
    ticket_status = $4,
    gross_weight = $5,
    tare_weight = $5,
    updated_at = now()
  `;
  const mirrorReturning = `
    RETURNING site_id, slip_number, truck_number, rfid_tag, customer_name,
              destination, material, operator_name, transporter, ticket_status,
              gross_weight, tare_weight
  `;

  for (const siteId of SITE_IDS) {
    const m = await pg.query(
      `UPDATE transactions_mirror SET ${mirrorSets}
       WHERE site_id = $1 AND slip_number = $2
       ${mirrorReturning}`,
      [siteId, SLIP, CANCEL_LABEL, TICKET_STATUS.CANCELLED, WEIGHT],
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
