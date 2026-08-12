'use strict';

/**
 * Swap slip numbers for the requested pairs, then refresh PDFs / RDS.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/swap-slip-pairs-2599-2608.js
 */
const path = require('path');
const fs = require('fs');

const PAIRS = [
  ['WB2599', 'WB2575'],
  ['WB2600', 'WB2577'],
  ['WB2601', 'WB2580'],
  ['WB2603', 'WB2585'],
  ['WB2604', 'WB2587'],
  ['WB2605', 'WB2588'],
  ['WB2606', 'WB2592'],
  ['WB2607', 'WB2594'],
  ['WB2608', 'WB2596'],
];

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
    id: txn.id,
    slip: txn.slip_number,
    truck: txn.truck_number,
    status: txn.ticket_status,
    operator: txn.operator_name,
    dest: txn.destination,
    material: txn.material,
    in: txn.timestamp_in,
    out: txn.timestamp_out,
    remote_pg_id: txn.remote_pg_id || null,
    mcg: txn.mcg_status,
  };
}

async function findRemoteId(pg, remoteId, slip) {
  if (remoteId) return remoteId;
  const bySlip = await pg.query(
    'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
    [slip],
  );
  return bySlip.rows[0]?.id || null;
}

async function swapRemotePair(pg, left, right, oldLeftSlip, oldRightSlip) {
  const leftId = await findRemoteId(pg, left.remote_pg_id, oldLeftSlip);
  const rightId = await findRemoteId(pg, right.remote_pg_id, oldRightSlip);
  if (!leftId && !rightId) return;

  const stamp = `${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
  const tempL = `ZZL${stamp}`;
  const tempR = `ZZR${stamp}`;

  if (leftId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      leftId,
      tempL,
    ]);
  }
  if (rightId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      rightId,
      tempR,
    ]);
  }
  if (leftId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      leftId,
      oldRightSlip,
    ]);
  }
  if (rightId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      rightId,
      oldLeftSlip,
    ]);
  }
}

async function main() {
  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const ReportService = require('../backend/services/ReportService');
  const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');

  initDatabase();
  const db = getDb();

  const allSlips = PAIRS.flat();
  const before = {};
  for (const slip of allSlips) {
    const txn = TransactionService.getBySlipNumber(slip);
    before[slip] = txn;
    console.log('BEFORE', slip, summarize(txn) || 'NOT FOUND');
    if (!txn) throw new Error(`Missing local ticket ${slip}`);
  }

  const now = new Date().toISOString();
  const swap = db.transaction(() => {
    PAIRS.forEach(([a, b], idx) => {
      const left = before[a];
      const right = before[b];
      const temp = `ZZSWAP${String(idx + 1).padStart(2, '0')}`;
      db.prepare(
        'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
      ).run(temp, now, left.id);
      db.prepare(
        'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
      ).run(a, now, right.id);
      db.prepare(
        'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
      ).run(b, now, left.id);
    });
  });
  swap();

  console.log('\nLocal swap complete.');
  for (const [a, b] of PAIRS) {
    const left = TransactionService.getById(before[a].id);
    const right = TransactionService.getById(before[b].id);
    console.log(
      `${a} (${before[a].truck_number}) -> ${left.slip_number} | ${b} (${before[b].truck_number}) -> ${right.slip_number}`,
    );
    if (left.slip_number !== b || right.slip_number !== a) {
      throw new Error(`Local swap verification failed for ${a}/${b}`);
    }
  }

  const pgOk = pg.isConfigured() && (await pg.ping());
  if (pgOk) {
    for (const [a, b] of PAIRS) {
      const left = TransactionService.getById(before[a].id);
      const right = TransactionService.getById(before[b].id);
      try {
        await swapRemotePair(pg, before[a], before[b], a, b);
        console.log(`RDS remote_trips swapped ${a} <-> ${b}`);
      } catch (err) {
        console.warn(`RDS remote_trips swap failed ${a}<->${b}:`, err.message);
      }

      try {
        await CloudAdminSyncService.deleteMirrorRow(a);
        await CloudAdminSyncService.deleteMirrorRow(b);
      } catch (err) {
        console.warn(`mirror delete failed ${a}/${b}:`, err.message);
      }
    }
  } else {
    console.log('PG unavailable — local swap only');
  }

  for (const slip of allSlips) {
    const txn = TransactionService.getBySlipNumber(slip);
    try {
      const regen = await ReportService.regenerateTripPDF(txn.id);
      console.log(`PDF ${slip}:`, regen.ok ? regen.path : regen.error);
    } catch (err) {
      console.warn(`PDF ${slip} failed:`, err.message);
    }

    if (pgOk) {
      try {
        const push = await CloudAdminSyncService.pushTransaction(
          TransactionService.getById(txn.id),
        );
        console.log(`mirror ${slip}:`, push);
      } catch (err) {
        console.warn(`mirror push ${slip} failed:`, err.message);
      }
    }
  }

  // Remove leftover PDFs that still use the pre-swap names if they no longer match.
  for (const slip of allSlips) {
    const expected = path.join(PATHS.REPORTS, `${slip}_report.pdf`);
    if (fs.existsSync(expected)) {
      console.log('report file ok', expected);
    } else {
      console.warn('missing report file', expected);
    }
  }

  console.log('\nAFTER');
  for (const [a, b] of PAIRS) {
    const nowA = TransactionService.getBySlipNumber(a);
    const nowB = TransactionService.getBySlipNumber(b);
    console.log({
      [a]: `${nowA.truck_number} was ${before[b].truck_number === nowA.truck_number ? 'the old ' + b : 'UNEXPECTED'}`,
      truckA: nowA.truck_number,
      truckB: nowB.truck_number,
      wasA: before[a].truck_number,
      wasB: before[b].truck_number,
    });
  }

  if (pgOk) await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
