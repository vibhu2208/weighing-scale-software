'use strict';

/**
 * Fix transactions_mirror slips after insert-wb2754-as-wb2697.
 * Site id in mirror is "WB - 03" (spaces), so the first pass missed it.
 *
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/fix-mirror-wb2697-2754.js
 */
const path = require('path');
const fs = require('fs');

const INSERT_FROM = 2754;
const INSERT_TO = 2697;
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

function formatSlip(n) {
  return `WB${String(n).padStart(4, '0')}`;
}

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');

  initDatabase();
  const db = getDb();
  const local = db
    .prepare(
      `SELECT id, slip_number, truck_number, ticket_status
       FROM transactions
       WHERE slip_number LIKE 'WB%'
         AND CAST(substr(slip_number, 3) AS INTEGER) BETWEEN ? AND ?
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER)`,
    )
    .all(INSERT_TO, INSERT_FROM);

  if (!pg.isConfigured() || !(await pg.ping())) {
    throw new Error('PG unavailable');
  }

  const slips = local.map((r) => r.slip_number);
  const ids = local.map((r) => r.id);
  const client = await pg.getDedicatedClient();

  try {
    await client.query('BEGIN');
    let parked = 0;
    let assigned = 0;

    for (const siteId of SITE_IDS) {
      const owned = await client.query(
        `SELECT local_id, slip_number, truck_number
         FROM transactions_mirror
         WHERE site_id = $1 AND local_id = ANY($2::text[])`,
        [siteId, ids],
      );
      const occupants = await client.query(
        `SELECT local_id, slip_number, truck_number
         FROM transactions_mirror
         WHERE site_id = $1 AND slip_number = ANY($2::text[])`,
        [siteId, slips],
      );

      const toPark = new Map();
      for (const row of [...owned.rows, ...occupants.rows]) {
        toPark.set(row.local_id, row);
      }
      if (!toPark.size) {
        console.log(`${siteId}: no mirror rows`);
        continue;
      }

      let i = 0;
      for (const row of toPark.values()) {
        i += 1;
        const temp = `ZZM${Date.now().toString(36)}${String(i).padStart(3, '0')}`;
        await client.query(
          `UPDATE transactions_mirror
           SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, row.local_id, temp],
        );
        parked += 1;
      }

      for (const txn of local) {
        const res = await client.query(
          `UPDATE transactions_mirror
           SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2
           RETURNING slip_number, truck_number`,
          [siteId, txn.id, txn.slip_number],
        );
        if (res.rows[0]) assigned += 1;
      }

      const leftover = await client.query(
        `SELECT local_id, slip_number, truck_number
         FROM transactions_mirror
         WHERE site_id = $1 AND slip_number LIKE 'ZZM%'`,
        [siteId],
      );
      if (leftover.rows.length) {
        console.log(`${siteId} leftover parked rows`, leftover.rows);
      }
    }

    await client.query('COMMIT');
    console.log('Mirror commit ok', { parked, assigned });
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
    `SELECT site_id, local_id, slip_number, truck_number
     FROM transactions_mirror
     WHERE site_id = ANY($1::text[]) AND local_id = ANY($2::text[])
     ORDER BY slip_number`,
    [SITE_IDS, ids],
  );
  let ok = 0;
  let bad = 0;
  for (const row of check.rows) {
    const loc = local.find((l) => l.id === row.local_id);
    const match = loc && loc.slip_number === row.slip_number;
    if (match) ok += 1;
    else {
      bad += 1;
      console.log('MISMATCH', row, loc && loc.slip_number);
    }
  }
  console.log(`Verify owned mirror rows ok=${ok} bad=${bad} total=${check.rows.length}`);

  const anchors = await pg.query(
    `SELECT site_id, slip_number, truck_number, local_id
     FROM transactions_mirror
     WHERE site_id = ANY($1::text[])
       AND slip_number = ANY($2::text[])
     ORDER BY slip_number`,
    [SITE_IDS, ['WB2696', 'WB2697', 'WB2698', 'WB2754', 'WB2755']],
  );
  console.log('anchors', anchors.rows);

  await pg.closePool();
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
