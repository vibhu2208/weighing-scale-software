'use strict';

/**
 * Fix + sync remote WB2186–WB2189 (local slip conflicts → rename then import).
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/sync-remote-wb2186-2189.js
 */
const path = require('path');
const fs = require('fs');

const SLIPS = ['WB2186', 'WB2187', 'WB2188', 'WB2189'];

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

function parseSlipNum(slip) {
  const m = String(slip || '').match(/^WB(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function nextFreeSlip(pg, getDb, TransactionService) {
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
  let nextNum = Math.max(localMax, Number(rdsCounter || 0), remoteMax) + 1;
  for (let i = 0; i < 80; i += 1) {
    const candidate = `WB${nextNum}`;
    const localHit = TransactionService.getBySlipNumber(candidate);
    const remoteHit = await pg.query(
      'SELECT id FROM remote_trips WHERE slip_number = $1',
      [candidate],
    );
    if (!localHit && !remoteHit.rows.length) {
      await pg.syncSlipCounterToMax(nextNum);
      return candidate;
    }
    nextNum += 1;
  }
  throw new Error('Could not allocate a free slip number');
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

  const res = await pg.query(
    `SELECT * FROM remote_trips WHERE slip_number = ANY($1::text[]) ORDER BY slip_number`,
    [SLIPS],
  );
  console.log(
    'RDS rows:',
    res.rows.map((r) => `${r.slip_number}/${r.truck_number}/synced=${r.synced_to_local}`),
  );

  for (const remote of res.rows) {
    console.log(`\n=== ${remote.slip_number} remote truck=${remote.truck_number} ===`);
    const byPg = TransactionService.getByRemotePgId(remote.id);
    if (byPg) {
      console.log(`Already imported as ${byPg.slip_number}`);
      if (!remote.synced_to_local) {
        await pg.query(
          `UPDATE remote_trips SET synced_to_local=true, synced_at=now(), local_id=$2 WHERE id=$1`,
          [remote.id, byPg.id],
        );
      }
      continue;
    }

    const local = TransactionService.getBySlipNumber(remote.slip_number);
    if (local) {
      const newSlip = await nextFreeSlip(pg, getDb, TransactionService);
      console.log(
        `Conflict local ${remote.slip_number} (${local.truck_number}/${local.ticket_status}) → ${newSlip}`,
      );
      await pg.query(
        `UPDATE remote_trips
         SET slip_number=$2, synced_to_local=false, synced_at=NULL, local_id=NULL,
             mcg_status=CASE WHEN mcg_status='sent' THEN mcg_status ELSE 'pending' END
         WHERE id=$1`,
        [remote.id, newSlip],
      );
    } else if (remote.synced_to_local) {
      await pg.query(
        `UPDATE remote_trips SET synced_to_local=false, synced_at=NULL, local_id=NULL WHERE id=$1`,
        [remote.id],
      );
    }

    const full = await pg.query('SELECT * FROM remote_trips WHERE id=$1', [remote.id]);
    const result = await RemoteTripSyncService.processRemoteRow(full.rows[0]);
    console.log('Result:', result);
    const imported = TransactionService.getByRemotePgId(remote.id);
    console.log(
      'Local:',
      imported
        ? `${imported.slip_number} ${imported.truck_number} ${imported.ticket_status} mcg=${imported.mcg_status}`
        : 'MISSING',
    );
  }

  await pg.closePool();
  closeDatabase();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
