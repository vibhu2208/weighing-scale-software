'use strict';

/**
 * Swap slip numbers for the requested pairs.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/swap-slip-pairs-2610-2666.js
 */
const path = require('path');
const fs = require('fs');

const PAIRS = [
  ['WB2610', 'WB2666'],
  ['WB2612', 'WB2664'],
  ['WB2613', 'WB2665'],
  ['WB2616', 'WB2626'],
  ['WB2619', 'WB2625'],
  ['WB2622', 'WB2630'],
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
  if (!leftId && !rightId) return { leftId, rightId };

  const stamp = `${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
  if (leftId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      leftId,
      `ZZL${stamp}`,
    ]);
  }
  if (rightId) {
    await pg.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
      rightId,
      `ZZR${stamp}`,
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
  return { leftId, rightId };
}

async function swapMirrorPair(pg, siteId, leftLocalId, rightLocalId, oldLeftSlip, oldRightSlip) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
  await pg.query(
    `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
     WHERE site_id = $1 AND local_id = $2`,
    [siteId, leftLocalId, `ZZML${stamp}`],
  );
  await pg.query(
    `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
     WHERE site_id = $1 AND local_id = $2`,
    [siteId, rightLocalId, `ZZMR${stamp}`],
  );
  const left = await pg.query(
    `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
     WHERE site_id = $1 AND local_id = $2 RETURNING slip_number`,
    [siteId, leftLocalId, oldRightSlip],
  );
  const right = await pg.query(
    `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
     WHERE site_id = $1 AND local_id = $2 RETURNING slip_number`,
    [siteId, rightLocalId, oldLeftSlip],
  );
  return { left: left.rows[0] || null, right: right.rows[0] || null };
}

function swapReportFiles(reportsDir, a, b) {
  for (const suffix of ['_report.pdf', '.pdf']) {
    const fa = path.join(reportsDir, `${a}${suffix}`);
    const fb = path.join(reportsDir, `${b}${suffix}`);
    const aExists = fs.existsSync(fa);
    const bExists = fs.existsSync(fb);
    if (!aExists && !bExists) continue;
    const tmp = path.join(reportsDir, `ZZTMP_${a}_${b}${suffix}`);
    if (aExists && bExists) {
      fs.renameSync(fa, tmp);
      fs.renameSync(fb, fa);
      fs.renameSync(tmp, fb);
    } else if (aExists) {
      fs.renameSync(fa, fb);
    } else {
      fs.renameSync(fb, fa);
    }
  }
}

async function main() {
  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const SettingsService = require('../backend/services/SettingsService');

  initDatabase();
  const db = getDb();
  const siteId = (
    process.env.WEIGHBRIDGE_ID ||
    SettingsService.get('WEIGHBRIDGE_ID') ||
    'WB-03'
  ).trim();

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
    swapReportFiles(PATHS.REPORTS, a, b);
    const leftPdf = path.join(PATHS.REPORTS, `${b}_report.pdf`);
    const rightPdf = path.join(PATHS.REPORTS, `${a}_report.pdf`);
    if (fs.existsSync(leftPdf)) {
      db.prepare('UPDATE transactions SET report_path = ? WHERE id = ?').run(
        leftPdf,
        left.id,
      );
    }
    if (fs.existsSync(rightPdf)) {
      db.prepare('UPDATE transactions SET report_path = ? WHERE id = ?').run(
        rightPdf,
        right.id,
      );
    }
  }

  const pgOk = pg.isConfigured() && (await pg.ping());
  if (pgOk) {
    for (const [a, b] of PAIRS) {
      try {
        await swapRemotePair(pg, before[a], before[b], a, b);
        console.log(`RDS remote_trips swapped ${a} <-> ${b}`);
      } catch (err) {
        console.warn(`RDS remote_trips swap failed ${a}<->${b}:`, err.message);
      }
      try {
        const mirror = await swapMirrorPair(
          pg,
          siteId,
          before[a].id,
          before[b].id,
          a,
          b,
        );
        console.log(`RDS mirror swapped ${a} <-> ${b}`, mirror);
      } catch (err) {
        console.warn(`RDS mirror swap failed ${a}<->${b}:`, err.message);
      }
    }
  } else {
    console.log('PG unavailable — local swap only');
  }

  console.log('\nAFTER');
  for (const [a, b] of PAIRS) {
    const nowA = TransactionService.getBySlipNumber(a);
    const nowB = TransactionService.getBySlipNumber(b);
    console.log({
      [a]: `${nowA.truck_number} (was ${before[a].truck_number})`,
      [b]: `${nowB.truck_number} (was ${before[b].truck_number})`,
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
