'use strict';

/**
 * Update remote_trips + transactions_mirror truck for WB2743 → HR38X7059
 * after local SQLite was already fixed.
 */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB2743';
const NEW_TRUCK = 'HR38X7059';
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
    rfid: txn.rfid_tag,
    vehicle_type: txn.vehicle?.vehicle_type || txn.vehicle_type || null,
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
      `UPDATE remote_trips SET truck_number = $2 WHERE id = $1
       RETURNING id, slip_number, truck_number`,
      [txn.remote_pg_id, NEW_TRUCK],
    );
    console.log('remote_trips by id:', upd.rows[0] || 'no row updated by id');
  }

  const bySlip = await pg.query(
    `UPDATE remote_trips SET truck_number = $2 WHERE slip_number = $1
     RETURNING id, slip_number, truck_number`,
    [SLIP, NEW_TRUCK],
  );
  console.log('remote_trips by slip:', bySlip.rows);

  try {
    const push = await CloudAdminSyncService.pushTransaction(txn);
    console.log('mirror push:', push);
  } catch (err) {
    console.log('mirror push failed:', err.message);
    for (const siteId of SITE_IDS) {
      try {
        const m = await pg.query(
          `UPDATE transactions_mirror
           SET truck_number = $3, rfid_tag = $4, vehicle_type = $5, updated_at = now()
           WHERE site_id = $1 AND slip_number = $2
           RETURNING site_id, slip_number, truck_number, vehicle_type`,
          [
            siteId,
            SLIP,
            NEW_TRUCK,
            txn.rfid_tag || null,
            txn.vehicle?.vehicle_type || txn.vehicle_type || 'hywa',
          ],
        );
        console.log('mirror fallback', siteId, m.rows);
      } catch (inner) {
        console.log('mirror fallback failed', siteId, inner.message);
      }
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
