'use strict';

/**
 * Insert current WB2754 into the WB2697 slot and shift existing
 * WB2697..WB2753 up by +1 (safe: only tickets that already exist).
 * Tickets WB2696 and earlier, and WB2755+, are left unchanged.
 *
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/insert-wb2754-as-wb2697.js
 * PDF regen (optional second pass): npx electron scripts/insert-wb2754-as-wb2697.js --regen-pdf
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const INSERT_FROM = 2754;
const INSERT_TO = 2697;
const TEMP_SLIP = 'ZZINS2754';

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

function parseSlipNumeric(slip) {
  const match = String(slip || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

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
    mcg: txn.mcg_status,
  };
}

function renameSlipFiles(reportsDir, fromSlip, toSlip) {
  let moved = 0;
  for (const suffix of ['_report.pdf', '.pdf']) {
    const src = path.join(reportsDir, `${fromSlip}${suffix}`);
    const dst = path.join(reportsDir, `${toSlip}${suffix}`);
    if (!fs.existsSync(src)) continue;
    if (path.resolve(src) === path.resolve(dst)) continue;
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(src, dst);
    moved += 1;
  }
  return moved;
}

async function findRemoteId(pg, remoteId, slip) {
  if (remoteId && !String(remoteId).startsWith('local-manual-')) {
    const byId = await pg.query('SELECT id FROM remote_trips WHERE id = $1 LIMIT 1', [
      remoteId,
    ]);
    if (byId.rows[0]?.id) return byId.rows[0].id;
  }
  const bySlip = await pg.query(
    'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
    [slip],
  );
  return bySlip.rows[0]?.id || null;
}

function buildPlan(db) {
  const insertSlip = formatSlip(INSERT_FROM);
  const targetSlip = formatSlip(INSERT_TO);
  const insertTxn = db
    .prepare('SELECT * FROM transactions WHERE slip_number = ? LIMIT 1')
    .get(insertSlip);
  if (!insertTxn) {
    throw new Error(`Insert ticket ${insertSlip} not found`);
  }

  const rows = db
    .prepare(
      `SELECT id, slip_number, truck_number, ticket_status, timestamp_in, timestamp_out,
              operator_name, destination, material, remote_pg_id, report_path, mcg_status
       FROM transactions
       WHERE slip_number LIKE 'WB%'
         AND CAST(substr(slip_number, 3) AS INTEGER) >= ?
         AND CAST(substr(slip_number, 3) AS INTEGER) < ?
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC`,
    )
    .all(INSERT_TO, INSERT_FROM);

  return { insertSlip, targetSlip, insertTxn, shiftRows: rows };
}

async function shiftLocalAndFiles() {
  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const SettingsService = require('../backend/services/SettingsService');
  const pg = require('../backend/database/pg');

  initDatabase();
  const db = getDb();
  const siteId = (
    process.env.WEIGHBRIDGE_ID ||
    SettingsService.get('WEIGHBRIDGE_ID') ||
    'WB-03'
  ).trim();

  const { insertSlip, targetSlip, insertTxn, shiftRows } = buildPlan(db);

  const guard2696 = TransactionService.getBySlipNumber(formatSlip(INSERT_TO - 1));
  const guardAfter = TransactionService.getBySlipNumber(formatSlip(INSERT_FROM + 1));

  console.log('INSERT', summarize(insertTxn));
  console.log(`Shift ${shiftRows.length} existing ticket(s) ${targetSlip}..${formatSlip(INSERT_FROM - 1)} +1`);
  console.log('UNCHANGED below', summarize(guard2696));
  console.log('UNCHANGED above', summarize(guardAfter) || `${formatSlip(INSERT_FROM + 1)} not found`);

  const beforeById = {
    [insertTxn.id]: { ...insertTxn, slip_number: insertTxn.slip_number },
  };
  for (const row of shiftRows) beforeById[row.id] = row;

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare(
      'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
    ).run(TEMP_SLIP, now, insertTxn.id);

    for (const row of shiftRows) {
      const num = parseSlipNumeric(row.slip_number);
      const nextSlip = formatSlip(num + 1);
      db.prepare(
        'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
      ).run(nextSlip, now, row.id);
    }

    db.prepare(
      'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
    ).run(targetSlip, now, insertTxn.id);
  });
  apply();

  console.log('\nLocal slip shift complete. Renaming report files...');

  let filesMoved = renameSlipFiles(PATHS.REPORTS, insertSlip, TEMP_SLIP);
  for (const row of shiftRows) {
    const num = parseSlipNumeric(row.slip_number);
    filesMoved += renameSlipFiles(PATHS.REPORTS, row.slip_number, formatSlip(num + 1));
  }
  filesMoved += renameSlipFiles(PATHS.REPORTS, TEMP_SLIP, targetSlip);
  console.log(`Report files renamed: ${filesMoved}`);

  const updatePath = db.prepare(
    'UPDATE transactions SET report_path = ? WHERE id = ?',
  );
  const allAffected = [
    { id: insertTxn.id, slip: targetSlip },
    ...shiftRows.map((row) => ({
      id: row.id,
      slip: formatSlip(parseSlipNumeric(row.slip_number) + 1),
    })),
  ];
  for (const item of allAffected) {
    const reportCopy = path.join(PATHS.REPORTS, `${item.slip}_report.pdf`);
    if (fs.existsSync(reportCopy)) updatePath.run(reportCopy, item.id);
  }

  const inserted = TransactionService.getById(insertTxn.id);
  if (!inserted || inserted.slip_number !== targetSlip) {
    throw new Error(`Insert ticket did not land on ${targetSlip}`);
  }
  if (inserted.truck_number !== insertTxn.truck_number) {
    throw new Error('Insert ticket truck changed unexpectedly');
  }

  const old2697 = TransactionService.getById(shiftRows[shiftRows.length - 1].id);
  const expectedOld2697 = formatSlip(INSERT_TO + 1);
  if (!old2697 || old2697.slip_number !== expectedOld2697) {
    throw new Error(
      `Old ${targetSlip} should now be ${expectedOld2697}, got ${old2697 && old2697.slip_number}`,
    );
  }

  const still2696 = TransactionService.getBySlipNumber(formatSlip(INSERT_TO - 1));
  if (guard2696 && still2696 && still2696.id !== guard2696.id) {
    throw new Error(`${formatSlip(INSERT_TO - 1)} was changed`);
  }
  const stillAfter = TransactionService.getBySlipNumber(formatSlip(INSERT_FROM + 1));
  if (guardAfter && stillAfter && stillAfter.id !== guardAfter.id) {
    throw new Error(`${formatSlip(INSERT_FROM + 1)} was changed`);
  }

  console.log('\nLOCAL AFTER');
  console.log(`${targetSlip}:`, summarize(inserted));
  console.log(`${expectedOld2697} (was ${targetSlip}):`, summarize(old2697));
  console.log(
    `${formatSlip(INSERT_FROM)} (was ${formatSlip(INSERT_FROM - 1)}):`,
    summarize(TransactionService.getBySlipNumber(formatSlip(INSERT_FROM))),
  );

  const pgOk = pg.isConfigured() && (await pg.ping());
  if (!pgOk) {
    console.log('\nPG unavailable — local shift only');
    closeDatabase();
    return { inserted, shiftRows, beforeById, siteId, pgOk: false };
  }

  console.log('\nUpdating RDS remote_trips + transactions_mirror...');
  const client = await pg.getDedicatedClient();
  try {
    await client.query('BEGIN');

    const insertRemoteId = await findRemoteId(
      { query: (text, params) => client.query(text, params) },
      insertTxn.remote_pg_id,
      insertSlip,
    );
    if (insertRemoteId) {
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        insertRemoteId,
        TEMP_SLIP,
      ]);
    }

    await client.query(
      `UPDATE transactions_mirror
       SET slip_number = $3, updated_at = now()
       WHERE site_id = $1 AND local_id = $2`,
      [siteId, insertTxn.id, TEMP_SLIP],
    );

    for (const row of shiftRows) {
      const nextSlip = formatSlip(parseSlipNumeric(row.slip_number) + 1);
      const remoteId = await findRemoteId(
        { query: (text, params) => client.query(text, params) },
        row.remote_pg_id,
        row.slip_number,
      );
      if (remoteId) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          remoteId,
          nextSlip,
        ]);
      }
      await client.query(
        `UPDATE transactions_mirror
         SET slip_number = $3, updated_at = now()
         WHERE site_id = $1 AND local_id = $2`,
        [siteId, row.id, nextSlip],
      );
    }

    if (insertRemoteId) {
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        insertRemoteId,
        targetSlip,
      ]);
    }
    await client.query(
      `UPDATE transactions_mirror
       SET slip_number = $3, updated_at = now()
       WHERE site_id = $1 AND local_id = $2`,
      [siteId, insertTxn.id, targetSlip],
    );

    await client.query('COMMIT');
    console.log('RDS commit ok', {
      insertRemoteId: insertRemoteId || null,
      shifted: shiftRows.length,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    console.warn('RDS shift failed (local already updated):', err.message);
  } finally {
    client.release();
  }

  const remoteCheck = await pg.query(
    'SELECT id, slip_number, truck_number FROM remote_trips WHERE slip_number = ANY($1::text[]) ORDER BY slip_number',
    [[targetSlip, expectedOld2697, insertSlip, TEMP_SLIP]],
  );
  console.log('RDS remote_trips check', remoteCheck.rows);

  const mirrorCheck = await pg.query(
    `SELECT local_id, slip_number, truck_number
     FROM transactions_mirror
     WHERE site_id = $1 AND local_id = ANY($2::text[])
     ORDER BY slip_number`,
    [siteId, [insertTxn.id, shiftRows[shiftRows.length - 1].id]],
  );
  console.log('RDS mirror check', mirrorCheck.rows);

  await pg.closePool();
  closeDatabase();
  return { inserted, shiftRows, beforeById, siteId, pgOk: true };
}

function regenPdfs(shiftRows, insertId) {
  const root = path.join(__dirname, '..');
  const electronBin = require('electron');
  const oneScript = path.join(__dirname, 'regen-one-report.js');
  const slips = [
    formatSlip(INSERT_TO),
    ...shiftRows
      .map((row) => formatSlip(parseSlipNumeric(row.slip_number) + 1))
      .reverse(),
  ];
  const unique = [...new Set(slips)];
  console.log(`\nRegenerating ${unique.length} PDF(s)...`);
  let ok = 0;
  let fail = 0;
  for (const slip of unique) {
    const result = spawnSync(electronBin, [oneScript, slip], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 180000,
    });
    if (result.status === 0) {
      ok += 1;
      console.log(`PDF ok ${slip}`);
    } else {
      fail += 1;
      console.warn(
        `PDF fail ${slip}:`,
        (result.stderr || result.stdout || result.error || '').toString().slice(-400),
      );
    }
  }
  console.log(`PDF regen done ok=${ok} fail=${fail}`);
  return { ok, fail, insertId };
}

async function main() {
  const args = process.argv.slice(2);
  const regenOnly = args.includes('--regen-pdf');
  const skipPdf = args.includes('--skip-pdf');

  if (regenOnly) {
    const { initPackagedStorage } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
    const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
    initDatabase();
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, slip_number, ticket_status
         FROM transactions
         WHERE slip_number LIKE 'WB%'
           AND CAST(substr(slip_number, 3) AS INTEGER) BETWEEN ? AND ?
           AND ticket_status = 'CLOSED'
         ORDER BY CAST(substr(slip_number, 3) AS INTEGER)`,
      )
      .all(INSERT_TO, INSERT_FROM);
    closeDatabase();
    regenPdfs(
      rows.map((r) => ({
        slip_number: formatSlip(parseSlipNumeric(r.slip_number) - 1),
        id: r.id,
      })),
      rows[0]?.id,
    );
    return;
  }

  const result = await shiftLocalAndFiles();
  if (!skipPdf) {
    const closedShifts = result.shiftRows.filter((row) => row.ticket_status === 'CLOSED');
    regenPdfs(closedShifts, result.inserted.id);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
