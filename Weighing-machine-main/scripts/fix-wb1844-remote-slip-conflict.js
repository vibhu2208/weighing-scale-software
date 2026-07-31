'use strict';

/**
 * Fix remote trip that collided on slip WB1844:
 * 1) Assign a new unique slip number on RDS remote_trips
 * 2) Reset synced_to_local so local can import it
 * 3) Import into local SQLite
 */
const path = require('path');
const fs = require('fs');

const OLD_SLIP = 'WB1844';

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

function parseSlipNum(slip) {
  const m = String(slip || '').match(/^WB(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const RemoteTripSyncService = require('../backend/services/RemoteTripSyncService');

  initDatabase();

  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  const localConflict = TransactionService.getBySlipNumber(OLD_SLIP);
  console.log('Local WB1844:', localConflict ? {
    id: localConflict.id,
    truck: localConflict.truck_number,
    status: localConflict.ticket_status,
    remote_pg_id: localConflict.remote_pg_id,
  } : 'NOT FOUND');

  const remoteRes = await pg.query(
    `SELECT * FROM remote_trips WHERE slip_number = $1 ORDER BY created_at DESC`,
    [OLD_SLIP],
  );
  if (!remoteRes.rows.length) {
    throw new Error(`No remote_trips row with slip_number=${OLD_SLIP}`);
  }

  let remote = remoteRes.rows.find((r) => {
    if (!localConflict) return true;
    return !localConflict.remote_pg_id || localConflict.remote_pg_id !== r.id;
  }) || remoteRes.rows[0];

  console.log('Remote trip candidate:', {
    id: remote.id,
    slip: remote.slip_number,
    truck: remote.truck_number,
    synced_to_local: remote.synced_to_local,
    local_id: remote.local_id,
    mcg_status: remote.mcg_status,
    gross: remote.gross_weight,
    tare: remote.tare_weight,
  });

  const byPg = getDb()
    .prepare('SELECT id, slip_number, truck_number FROM transactions WHERE remote_pg_id = ?')
    .get(remote.id);
  if (byPg) {
    console.log('Already imported locally as', byPg.slip_number, byPg.id);
    await pg.closePool();
    closeDatabase();
    return;
  }

  const localMaxRow = getDb()
    .prepare(
      `SELECT slip_number FROM transactions
       WHERE slip_number LIKE 'WB%'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
       LIMIT 1`,
    )
    .get();
  const localMax = parseSlipNum(localMaxRow?.slip_number);

  const rdsCounter = await pg.getSlipCounterValue();
  const remoteMaxRes = await pg.query(
    `SELECT MAX(CAST(substring(slip_number from 3) AS BIGINT)) AS m
     FROM remote_trips WHERE slip_number ~ '^WB[0-9]+$'`,
  );
  const remoteMax = Number(remoteMaxRes.rows[0]?.m || 0);
  const nextNum = Math.max(localMax, Number(rdsCounter || 0), remoteMax) + 1;
  const newSlip = `WB${nextNum}`;

  console.log('Slip allocation:', {
    localMax,
    rdsCounter,
    remoteMax,
    newSlip,
  });

  if (TransactionService.getBySlipNumber(newSlip)) {
    throw new Error(`New slip ${newSlip} unexpectedly exists locally`);
  }
  const clash = await pg.query(
    'SELECT id FROM remote_trips WHERE slip_number = $1',
    [newSlip],
  );
  if (clash.rows.length) {
    throw new Error(`New slip ${newSlip} unexpectedly exists on RDS remote_trips`);
  }

  await pg.query(
    `UPDATE remote_trips
     SET slip_number = $2,
         synced_to_local = false,
         synced_at = NULL,
         local_id = NULL,
         mcg_status = CASE WHEN mcg_status = 'sent' THEN mcg_status ELSE 'pending' END
     WHERE id = $1`,
    [remote.id, newSlip],
  );
  console.log(`Updated RDS remote trip ${remote.id}: ${OLD_SLIP} → ${newSlip}`);

  await pg.syncSlipCounterToMax(nextNum);

  console.log('Running RemoteTripSyncService.processNow()...');
  const result = await RemoteTripSyncService.processNow();
  console.log('processNow:', result);

  const imported = TransactionService.getBySlipNumber(newSlip);
  const stillRemote = await pg.query(
    'SELECT slip_number, synced_to_local, local_id FROM remote_trips WHERE id = $1',
    [remote.id],
  );
  console.log('Local after:', imported ? {
    id: imported.id,
    slip: imported.slip_number,
    truck: imported.truck_number,
    status: imported.ticket_status,
  } : 'MISSING');
  console.log('RDS after:', stillRemote.rows[0]);

  const localStill = TransactionService.getBySlipNumber(OLD_SLIP);
  console.log('Local original WB1844 still:', localStill ? {
    id: localStill.id,
    truck: localStill.truck_number,
  } : 'MISSING');

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
