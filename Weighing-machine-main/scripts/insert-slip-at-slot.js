'use strict';

/**
 * Move one existing slip into an earlier slot and +1 every existing
 * ticket from the target up to (source - 1). Times/weights/photos stay.
 *
 * Run:
 *   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/insert-slip-at-slot.js WB2763 WB2700 --skip-pdf
 */
const path = require('path');
const fs = require('fs');

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

function parseSlipNumeric(slip) {
  const match = String(slip || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

function formatSlip(n) {
  return `WB${String(n).padStart(4, '0')}`;
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

async function syncMirror(client, localTickets) {
  const ids = localTickets.map((t) => t.id);
  const slips = localTickets.map((t) => t.slip);
  let parked = 0;
  let assigned = 0;
  const leftovers = [];

  for (const siteId of SITE_IDS) {
    const owned = await client.query(
      `SELECT local_id, slip_number FROM transactions_mirror
       WHERE site_id = $1 AND local_id = ANY($2::text[])`,
      [siteId, ids],
    );
    const occupants = await client.query(
      `SELECT local_id, slip_number FROM transactions_mirror
       WHERE site_id = $1 AND slip_number = ANY($2::text[])`,
      [siteId, slips],
    );
    const toPark = new Map();
    for (const row of [...owned.rows, ...occupants.rows]) {
      toPark.set(row.local_id, row);
    }
    if (!toPark.size) continue;

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

    for (const txn of localTickets) {
      const res = await client.query(
        `UPDATE transactions_mirror
         SET slip_number = $3, updated_at = now()
         WHERE site_id = $1 AND local_id = $2
         RETURNING slip_number`,
        [siteId, txn.id, txn.slip],
      );
      if (res.rows[0]) assigned += 1;
    }

    const leftover = await client.query(
      `SELECT local_id, slip_number, truck_number
       FROM transactions_mirror
       WHERE site_id = $1 AND slip_number LIKE 'ZZM%'`,
      [siteId],
    );
    leftovers.push(...leftover.rows.map((r) => ({ siteId, ...r })));
  }
  return { parked, assigned, leftovers };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const INSERT_FROM = parseSlipNumeric(args[0]);
  const INSERT_TO = parseSlipNumeric(args[1]);
  if (!INSERT_FROM || !INSERT_TO || INSERT_FROM <= INSERT_TO) {
    throw new Error('Usage: insert-slip-at-slot.js WB2763 WB2700 [--skip-pdf]');
  }
  const TEMP_SLIP = `ZZI${INSERT_FROM}`;
  const insertSlip = formatSlip(INSERT_FROM);
  const targetSlip = formatSlip(INSERT_TO);

  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const pg = require('../backend/database/pg');

  initDatabase();
  const db = getDb();

  const insertTxn = db
    .prepare('SELECT * FROM transactions WHERE slip_number = ? LIMIT 1')
    .get(insertSlip);
  if (!insertTxn) throw new Error(`Insert ticket ${insertSlip} not found`);

  const shiftRows = db
    .prepare(
      `SELECT id, slip_number, truck_number, ticket_status, timestamp_in, timestamp_out,
              operator_name, destination, material, remote_pg_id, report_path
       FROM transactions
       WHERE slip_number LIKE 'WB%'
         AND CAST(substr(slip_number, 3) AS INTEGER) >= ?
         AND CAST(substr(slip_number, 3) AS INTEGER) < ?
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC`,
    )
    .all(INSERT_TO, INSERT_FROM);

  const guardBefore = TransactionService.getBySlipNumber(formatSlip(INSERT_TO - 1));
  const guardAfter = TransactionService.getBySlipNumber(formatSlip(INSERT_FROM + 1));

  console.log('INSERT', summarize(insertTxn));
  console.log(
    `Shift ${shiftRows.length} existing ticket(s) ${targetSlip}..${formatSlip(INSERT_FROM - 1)} +1`,
  );
  console.log('UNCHANGED below', summarize(guardBefore));
  console.log(
    'UNCHANGED above',
    summarize(guardAfter) || `${formatSlip(INSERT_FROM + 1)} not found`,
  );

  const now = new Date().toISOString();
  const apply = db.transaction(() => {
    db.prepare(
      'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
    ).run(TEMP_SLIP, now, insertTxn.id);
    for (const row of shiftRows) {
      db.prepare(
        'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
      ).run(formatSlip(parseSlipNumeric(row.slip_number) + 1), now, row.id);
    }
    db.prepare(
      'UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?',
    ).run(targetSlip, now, insertTxn.id);
  });
  apply();

  let filesMoved = renameSlipFiles(PATHS.REPORTS, insertSlip, TEMP_SLIP);
  for (const row of shiftRows) {
    filesMoved += renameSlipFiles(
      PATHS.REPORTS,
      row.slip_number,
      formatSlip(parseSlipNumeric(row.slip_number) + 1),
    );
  }
  filesMoved += renameSlipFiles(PATHS.REPORTS, TEMP_SLIP, targetSlip);
  console.log(`Report files renamed: ${filesMoved}`);

  const updatePath = db.prepare('UPDATE transactions SET report_path = ? WHERE id = ?');
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
    throw new Error('Truck changed unexpectedly');
  }
  if (inserted.timestamp_in !== insertTxn.timestamp_in) {
    throw new Error('In/gross time changed unexpectedly');
  }

  const oldTarget = TransactionService.getById(shiftRows[shiftRows.length - 1].id);
  const expectedOldTarget = formatSlip(INSERT_TO + 1);
  if (!oldTarget || oldTarget.slip_number !== expectedOldTarget) {
    throw new Error(
      `Old ${targetSlip} should now be ${expectedOldTarget}, got ${oldTarget && oldTarget.slip_number}`,
    );
  }
  const stillBefore = TransactionService.getBySlipNumber(formatSlip(INSERT_TO - 1));
  if (guardBefore && stillBefore && stillBefore.id !== guardBefore.id) {
    throw new Error(`${formatSlip(INSERT_TO - 1)} was changed`);
  }
  const stillAfter = TransactionService.getBySlipNumber(formatSlip(INSERT_FROM + 1));
  if (guardAfter && stillAfter && stillAfter.id !== guardAfter.id) {
    throw new Error(`${formatSlip(INSERT_FROM + 1)} was changed`);
  }

  console.log('\nLOCAL AFTER');
  console.log(`${targetSlip}:`, summarize(inserted));
  console.log(`${expectedOldTarget} (was ${targetSlip}):`, summarize(oldTarget));

  const localTickets = allAffected.map((item) => {
    const txn = TransactionService.getById(item.id);
    return { id: item.id, slip: item.slip, truck: txn.truck_number };
  });

  if (process.argv.includes('--skip-rds')) {
    console.log('\nSkipping RDS (--skip-rds)');
    closeDatabase();
    console.log('Done.');
    return;
  }

  const pgOk = pg.isConfigured() && (await pg.ping());
  if (!pgOk) {
    console.log('\nPG unavailable — local shift only');
    closeDatabase();
    console.log('Done.');
    return;
  }

  console.log('\nUpdating RDS...');
  const client = await pg.getDedicatedClient();
  try {
    await client.query('BEGIN');
    const insertRemoteId = await findRemoteId(client, insertTxn.remote_pg_id, insertSlip);
    if (insertRemoteId) {
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        insertRemoteId,
        TEMP_SLIP,
      ]);
    }
    for (const row of shiftRows) {
      const nextSlip = formatSlip(parseSlipNumeric(row.slip_number) + 1);
      const remoteId = await findRemoteId(client, row.remote_pg_id, row.slip_number);
      if (remoteId) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          remoteId,
          nextSlip,
        ]);
      }
    }
    if (insertRemoteId) {
      await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
        insertRemoteId,
        targetSlip,
      ]);
    }

    const mirror = await syncMirror(client, localTickets);
    for (const row of mirror.leftovers || []) {
      const loc = db
        .prepare('SELECT id, slip_number, truck_number FROM transactions WHERE id = ?')
        .get(row.local_id);
      if (!loc) continue;
      const conflict = await client.query(
        `SELECT local_id FROM transactions_mirror
         WHERE site_id = $1 AND slip_number = $2 AND local_id <> $3`,
        [row.siteId, loc.slip_number, loc.id],
      );
      if (conflict.rows.length) {
        console.log('mirror leftover conflict, keep parked', row, loc.slip_number);
        continue;
      }
      await client.query(
        `UPDATE transactions_mirror
         SET slip_number = $3, updated_at = now()
         WHERE site_id = $1 AND local_id = $2`,
        [row.siteId, loc.id, loc.slip_number],
      );
      console.log('mirror leftover restored', loc.slip_number, loc.truck_number);
    }
    await client.query('COMMIT');
    console.log('RDS commit ok', {
      insertRemoteId: insertRemoteId || null,
      shifted: shiftRows.length,
      mirrorParked: mirror.parked,
      mirrorAssigned: mirror.assigned,
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

  await pg.closePool();
  closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
