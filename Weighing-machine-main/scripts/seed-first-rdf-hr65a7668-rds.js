'use strict';

/**
 * Retry RDS remote_trips insert for already-seeded WB4298.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/seed-first-rdf-hr65a7668-rds.js
 */
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
  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const pg = require('../backend/database/pg');

  initDatabase();
  const db = getDb();
  const txn = TransactionService.getBySlipNumber('WB4298');
  if (!txn || txn.truck_number !== 'HR65A7668') {
    throw new Error('WB4298 is not HR65A7668');
  }

  if (!pg.isConfigured()) throw new Error('PG not configured');
  const ok = await pg.ping();
  if (!ok) throw new Error('PG ping failed');

  const vehicle = db
    .prepare('SELECT rfid_tag, vehicle_type FROM vehicles WHERE vehicle_number = ?')
    .get(txn.truck_number);

  const existing = await pg.query(
    'SELECT id, slip_number, truck_number FROM remote_trips WHERE slip_number = $1 OR id = $2 LIMIT 1',
    [txn.slip_number, txn.remote_pg_id],
  );
  if (existing.rows[0]) {
    console.log('Already on RDS', existing.rows[0]);
    await pg.syncSlipCounterToMax(4307);
    await pg.closePool();
    closeDatabase();
    return;
  }

  const cols = [
    'slip_number',
    'truck_number',
    'customer_name',
    'destination',
    'material',
    'operator_name',
    'tare_weight',
    'gross_weight',
    'timestamp_in',
    'timestamp_out',
    'rfid_tag',
    'vehicle_type',
    'synced_to_local',
    'synced_at',
    'local_id',
  ];
  const values = [
    txn.slip_number,
    txn.truck_number,
    txn.customer_name,
    txn.destination,
    txn.material,
    txn.operator_name,
    txn.tare_weight,
    txn.gross_weight,
    txn.timestamp_in,
    txn.timestamp_out,
    txn.rfid_tag || vehicle?.rfid_tag || null,
    vehicle?.vehicle_type || 'truck',
    true,
    new Date().toISOString(),
    txn.id,
  ];
  const res = await pg.query(
    `INSERT INTO remote_trips (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id, slip_number`,
    values,
  );
  const remoteId = String(res.rows[0].id);
  db.prepare('UPDATE transactions SET remote_pg_id = ?, updated_at = ? WHERE id = ?').run(
    remoteId,
    new Date().toISOString(),
    txn.id,
  );
  await pg.syncSlipCounterToMax(4307);
  console.log('RDS inserted', res.rows[0], 'local remote_pg_id updated');

  try {
    const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');
    await CloudAdminSyncService.pushTransaction(TransactionService.getById(txn.id));
    console.log('Mirror pushed');
  } catch (err) {
    console.log('Mirror skip', err.message);
  }

  await pg.closePool();
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
