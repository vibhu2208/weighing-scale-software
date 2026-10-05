'use strict';

/**
 * Push current local slips 2700-2766 to RDS remote_trips + mirror.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/sync-rds-slips-2700-2766.js
 */
const path = require('path');
const fs = require('fs');

const SITE_IDS = ['WB - 03', 'WB-03'];
const FROM = 2700;
const TO = 2766;

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
  const pg = require('../backend/database/pg');

  initDatabase();
  const local = getDb()
    .prepare(
      `SELECT id, slip_number, truck_number, remote_pg_id
       FROM transactions
       WHERE slip_number LIKE 'WB%'
         AND CAST(substr(slip_number, 3) AS INTEGER) BETWEEN ? AND ?
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER)`,
    )
    .all(FROM, TO);

  if (!pg.isConfigured() || !(await pg.ping())) throw new Error('PG unavailable');
  const client = await pg.getDedicatedClient();
  const ids = local.map((r) => r.id);
  const slips = local.map((r) => r.slip_number);

  try {
    await client.query('BEGIN');
    for (const txn of local) {
      if (!txn.remote_pg_id || String(txn.remote_pg_id).startsWith('local-manual-')) continue;
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        txn.remote_pg_id,
        `ZZR${String(txn.id).replace(/-/g, '').slice(0, 12)}`,
      ]);
    }
    for (const txn of local) {
      if (!txn.remote_pg_id || String(txn.remote_pg_id).startsWith('local-manual-')) continue;
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        txn.remote_pg_id,
        txn.slip_number,
      ]);
    }

    for (const siteId of SITE_IDS) {
      await client.query(
        `UPDATE transactions_mirror
         SET slip_number = 'ZZM' || substr(local_id, 1, 12), updated_at = now()
         WHERE site_id = $1 AND local_id = ANY($2::text[])`,
        [siteId, ids],
      );
      for (const txn of local) {
        await client.query(
          `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, txn.id, txn.slip_number],
        );
      }
    }
    await client.query('COMMIT');
    console.log('RDS synced', local.length, 'local tickets');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }

  const check = await pg.query(
    `SELECT slip_number, truck_number FROM remote_trips
     WHERE slip_number = ANY($1::text[]) ORDER BY slip_number`,
    [['WB2700', 'WB2701', 'WB2702']],
  );
  console.log('remote anchors', check.rows);
  const mirror = await pg.query(
    `SELECT slip_number, truck_number FROM transactions_mirror
     WHERE site_id = $1 AND slip_number = ANY($2::text[]) ORDER BY slip_number`,
    ['WB - 03', ['WB2700', 'WB2701', 'WB2702']],
  );
  console.log('mirror anchors', mirror.rows);
  await pg.closePool();
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
