'use strict';

/**
 * Swap only slip numbers WB2697 <-> WB2698.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/swap-wb2697-2698.js
 */
const path = require('path');
const fs = require('fs');

const A = 'WB2697';
const B = 'WB2698';
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
    id: txn.id,
    slip: txn.slip_number,
    truck: txn.truck_number,
    status: txn.ticket_status,
    in: txn.timestamp_in,
    out: txn.timestamp_out,
    operator: txn.operator_name,
    dest: txn.destination,
    material: txn.material,
    remote_pg_id: txn.remote_pg_id || null,
  };
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

async function findRemoteId(client, remoteId, slip) {
  if (remoteId && !String(remoteId).startsWith('local-manual-')) {
    const byId = await client.query('SELECT id FROM remote_trips WHERE id = $1 LIMIT 1', [
      remoteId,
    ]);
    if (byId.rows[0]?.id) return byId.rows[0].id;
  }
  const bySlip = await client.query(
    'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
    [slip],
  );
  return bySlip.rows[0]?.id || null;
}

async function main() {
  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');

  initDatabase();
  const db = getDb();

  const left = TransactionService.getBySlipNumber(A);
  const right = TransactionService.getBySlipNumber(B);
  console.log('BEFORE', A, summarize(left));
  console.log('BEFORE', B, summarize(right));
  if (!left || !right) throw new Error('Both tickets must exist');

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
      'ZZSWAP6978',
      now,
      left.id,
    );
    db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
      A,
      now,
      right.id,
    );
    db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
      B,
      now,
      left.id,
    );
  });
  apply();

  const afterLeft = TransactionService.getById(left.id);
  const afterRight = TransactionService.getById(right.id);
  if (afterLeft.slip_number !== B || afterRight.slip_number !== A) {
    throw new Error('Local swap verification failed');
  }
  if (
    afterLeft.truck_number !== left.truck_number ||
    afterRight.truck_number !== right.truck_number ||
    afterLeft.timestamp_in !== left.timestamp_in ||
    afterRight.timestamp_in !== right.timestamp_in
  ) {
    throw new Error('Non-slip fields changed unexpectedly');
  }

  swapReportFiles(PATHS.REPORTS, A, B);
  const leftPdf = path.join(PATHS.REPORTS, `${B}_report.pdf`);
  const rightPdf = path.join(PATHS.REPORTS, `${A}_report.pdf`);
  if (fs.existsSync(leftPdf)) {
    db.prepare('UPDATE transactions SET report_path = ? WHERE id = ?').run(leftPdf, afterLeft.id);
  }
  if (fs.existsSync(rightPdf)) {
    db.prepare('UPDATE transactions SET report_path = ? WHERE id = ?').run(
      rightPdf,
      afterRight.id,
    );
  }

  console.log('\nLOCAL AFTER');
  console.log(A, summarize(TransactionService.getBySlipNumber(A)));
  console.log(B, summarize(TransactionService.getBySlipNumber(B)));

  const pgOk = pg.isConfigured() && (await pg.ping());
  if (pgOk) {
    const client = await pg.getDedicatedClient();
    try {
      await client.query('BEGIN');
      const leftRemote = await findRemoteId(client, left.remote_pg_id, A);
      const rightRemote = await findRemoteId(client, right.remote_pg_id, B);
      const stamp = `${Date.now()}`;
      if (leftRemote) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          leftRemote,
          `ZZL${stamp}`,
        ]);
      }
      if (rightRemote) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          rightRemote,
          `ZZR${stamp}`,
        ]);
      }
      if (leftRemote) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          leftRemote,
          B,
        ]);
      }
      if (rightRemote) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          rightRemote,
          A,
        ]);
      }

      for (const siteId of SITE_IDS) {
        await client.query(
          `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, left.id, `ZZML${stamp}`],
        );
        await client.query(
          `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, right.id, `ZZMR${stamp}`],
        );
        await client.query(
          `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, left.id, B],
        );
        await client.query(
          `UPDATE transactions_mirror SET slip_number = $3, updated_at = now()
           WHERE site_id = $1 AND local_id = $2`,
          [siteId, right.id, A],
        );
      }
      await client.query('COMMIT');
      console.log('RDS swapped', { leftRemote, rightRemote });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_e) {
        /* ignore */
      }
      console.warn('RDS swap failed (local already swapped):', err.message);
    } finally {
      client.release();
    }

    const remote = await pg.query(
      'SELECT id, slip_number, truck_number FROM remote_trips WHERE slip_number = ANY($1::text[])',
      [[A, B]],
    );
    console.log('RDS remote_trips', remote.rows);
    const mirror = await pg.query(
      `SELECT site_id, slip_number, truck_number, local_id
       FROM transactions_mirror
       WHERE site_id = ANY($1::text[]) AND local_id = ANY($2::text[])
       ORDER BY slip_number`,
      [SITE_IDS, [left.id, right.id]],
    );
    console.log('RDS mirror', mirror.rows);
    await pg.closePool();
  } else {
    console.log('PG unavailable — local swap only');
  }

  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
