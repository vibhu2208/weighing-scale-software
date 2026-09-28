'use strict';

/**
 * Seed second RDF remote trip (HR58E3515) then insert it at WB4299,
 * pushing existing WB4299..max +1. WB4298 stays HR65A7668.
 *
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/seed-second-rdf-hr58e3515.js
 */
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const SITE_IDS = ['WB - 03', 'WB-03'];
const TARGET_SLIP_NUM = 4299;

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

function istToUtcIso(hms) {
  const [hh, mm, ss] = hms.split(':').map(Number);
  const utc = Date.UTC(2026, 8, 15, 18, 30, 0) + (hh * 3600 + mm * 60 + ss) * 1000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

const TRIP = {
  truck_number: 'HR58E3515',
  tare_weight: 14860,
  gross_weight: 57420,
  timestamp_in: istToUtcIso('20:19:48'),
  timestamp_out: istToUtcIso('22:44:16'),
  customer_name: 'MCG',
  destination: 'MUZAFFAR NAGAR',
  material: 'RDF',
  operator_name: 'Umesh',
  company: 'DCC',
};

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
    material: txn.material,
    dest: txn.destination,
    tare: txn.tare_weight,
    gross: txn.gross_weight,
    in: txn.timestamp_in,
    out: txn.timestamp_out,
    operator: txn.operator_name,
  };
}

function latestPhotos(db, truckNumber) {
  return db
    .prepare(
      `SELECT arrival_photo_1, departure_photo_1
       FROM transactions
       WHERE truck_number = ?
         AND ticket_status = 'CLOSED'
         AND (
           (arrival_photo_1 IS NOT NULL AND arrival_photo_1 != '')
           OR (departure_photo_1 IS NOT NULL AND departure_photo_1 != '')
         )
       ORDER BY timestamp_in DESC
       LIMIT 1`,
    )
    .get(truckNumber);
}

function copyPhoto(src, destDir, destName) {
  if (!src || !fs.existsSync(src)) return null;
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destName);
  fs.copyFileSync(src, dest);
  return dest;
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
  const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const McgPortalService = require('../backend/services/McgPortalService');
  const pg = require('../backend/database/pg');
  const ts = require('../backend/utils/timestamp');

  initDatabase();
  const db = getDb();

  const existingTruck = db
    .prepare(
      `SELECT slip_number, timestamp_in FROM transactions
       WHERE truck_number = ? AND timestamp_in >= '2026-09-15T18:30:00.000Z'
       ORDER BY timestamp_in DESC LIMIT 1`,
    )
    .get(TRIP.truck_number);
  if (existingTruck) {
    throw new Error(
      `${TRIP.truck_number} already has ${existingTruck.slip_number} on 16 Sep`,
    );
  }

  const first = TransactionService.getBySlipNumber('WB4298');
  if (!first || first.truck_number !== 'HR65A7668') {
    throw new Error('WB4298 is not HR65A7668 — aborting second insert');
  }
  const slot = TransactionService.getBySlipNumber(formatSlip(TARGET_SLIP_NUM));
  if (!slot || slot.truck_number !== 'HR38AK0025') {
    throw new Error(
      `${formatSlip(TARGET_SLIP_NUM)} is not the expected compost ticket HR38AK0025`,
    );
  }

  const maxRow = db
    .prepare(
      `SELECT slip_number FROM transactions
       WHERE slip_number LIKE 'WB%'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
       LIMIT 1`,
    )
    .get();
  const insertFrom = (parseSlipNumeric(maxRow?.slip_number) || 0) + 1;
  const insertSlip = formatSlip(insertFrom);
  const targetSlip = formatSlip(TARGET_SLIP_NUM);
  const tempSlip = `ZZI${insertFrom}`;

  const vehicle = db
    .prepare('SELECT rfid_tag, vehicle_type FROM vehicles WHERE vehicle_number = ?')
    .get(TRIP.truck_number);

  const photoDir = path.join(PATHS.IMAGES, '2026', '09', '16');
  const srcPhotos = latestPhotos(db, TRIP.truck_number) || {};
  const shortId = uuidv4().replace(/-/g, '').slice(0, 8);
  const arrivalPath = copyPhoto(
    srcPhotos.arrival_photo_1,
    photoDir,
    `20260916_${TRIP.truck_number}_arrival_cam-1_${shortId}.jpg`,
  );
  const departurePath = copyPhoto(
    srcPhotos.departure_photo_1 || srcPhotos.arrival_photo_1,
    photoDir,
    `20260916_${TRIP.truck_number}_departure_cam-1_${shortId}.jpg`,
  );
  const snapshots = {
    gross: arrivalPath ? [{ id: 'cam-1', label: 'Camera 1', path: arrivalPath }] : [],
    tare: departurePath ? [{ id: 'cam-1', label: 'Camera 1', path: departurePath }] : [],
  };

  let pgAvailable = false;
  if (pg.isConfigured()) {
    try {
      pgAvailable = await pg.ping();
    } catch (_e) {
      pgAvailable = false;
    }
    if (!pgAvailable) console.log('PG ping failed — local insert, RDS later');
  }

  let remotePgId = `local-manual-${insertSlip}-${Date.now()}`;
  if (pgAvailable) {
    const existing = await pg.query(
      'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
      [insertSlip],
    );
    if (existing.rows[0]?.id) {
      throw new Error(`${insertSlip} already exists on RDS remote_trips`);
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
    ];
    const values = [
      insertSlip,
      TRIP.truck_number,
      TRIP.customer_name,
      TRIP.destination,
      TRIP.material,
      TRIP.operator_name,
      TRIP.tare_weight,
      TRIP.gross_weight,
      TRIP.timestamp_in,
      TRIP.timestamp_out,
      vehicle?.rfid_tag || null,
      vehicle?.vehicle_type || 'truck',
      true,
      new Date().toISOString(),
    ];
    const res = await pg.query(
      `INSERT INTO remote_trips (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id, slip_number`,
      values,
    );
    if (res.rows[0]?.id) {
      remotePgId = String(res.rows[0].id);
      console.log(`RDS remote_trips: ${insertSlip} id=${remotePgId}`);
    }
  }

  const result = TransactionService.importClosedTrip({
    id: uuidv4(),
    remote_pg_id: remotePgId,
    slip_number: insertSlip,
    truck_number: TRIP.truck_number,
    rfid_tag: vehicle?.rfid_tag || null,
    customer_name: TRIP.customer_name,
    destination: TRIP.destination,
    material: TRIP.material,
    operator_name: TRIP.operator_name,
    company: TRIP.company,
    tare_weight: TRIP.tare_weight,
    gross_weight: TRIP.gross_weight,
    timestamp_in: TRIP.timestamp_in,
    timestamp_out: TRIP.timestamp_out,
    arrival_photo_1: arrivalPath,
    departure_photo_1: departurePath,
    image_path: departurePath || arrivalPath,
  });
  if (!result.imported) {
    throw new Error(`FAILED/exists: ${insertSlip} ${TRIP.truck_number}`);
  }

  TransactionService.updateFields(result.transaction.id, {
    raw_tare_weight: TRIP.tare_weight,
    raw_gross_weight: TRIP.gross_weight,
    camera_snapshots: JSON.stringify(snapshots),
  });

  const insertTxn = TransactionService.getBySlipNumber(insertSlip);
  console.log('INSERTED at end', summarize(insertTxn));

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
    .all(TARGET_SLIP_NUM, insertFrom);

  const guardBefore = TransactionService.getBySlipNumber(formatSlip(TARGET_SLIP_NUM - 1));
  const guardAfter = TransactionService.getBySlipNumber(formatSlip(insertFrom + 1));
  console.log(
    `Shift ${shiftRows.length} ticket(s) ${targetSlip}..${formatSlip(insertFrom - 1)} +1`,
  );
  console.log('UNCHANGED below', summarize(guardBefore));
  console.log('UNCHANGED above', summarize(guardAfter) || `${formatSlip(insertFrom + 1)} not found`);

  const now = ts.now();
  const apply = db.transaction(() => {
    db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
      tempSlip,
      now,
      insertTxn.id,
    );
    for (const row of shiftRows) {
      db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
        formatSlip(parseSlipNumeric(row.slip_number) + 1),
        now,
        row.id,
      );
    }
    db.prepare('UPDATE transactions SET slip_number = ?, updated_at = ? WHERE id = ?').run(
      targetSlip,
      now,
      insertTxn.id,
    );
  });
  apply();

  let filesMoved = renameSlipFiles(PATHS.REPORTS, insertSlip, tempSlip);
  for (const row of shiftRows) {
    filesMoved += renameSlipFiles(
      PATHS.REPORTS,
      row.slip_number,
      formatSlip(parseSlipNumeric(row.slip_number) + 1),
    );
  }
  filesMoved += renameSlipFiles(PATHS.REPORTS, tempSlip, targetSlip);
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

  const counter = db.prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1').get();
  if (counter && counter.current_value < insertFrom) {
    db.prepare('UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?').run(
      insertFrom,
      now,
      counter.id,
    );
    console.log(`slip_counter → ${insertFrom}`);
  }

  const inserted = TransactionService.getById(insertTxn.id);
  if (!inserted || inserted.slip_number !== targetSlip) {
    throw new Error(`Insert ticket did not land on ${targetSlip}`);
  }
  const oldTarget = TransactionService.getById(shiftRows[shiftRows.length - 1].id);
  const expectedOldTarget = formatSlip(TARGET_SLIP_NUM + 1);
  if (!oldTarget || oldTarget.slip_number !== expectedOldTarget) {
    throw new Error(
      `Old ${targetSlip} should now be ${expectedOldTarget}, got ${oldTarget && oldTarget.slip_number}`,
    );
  }
  const stillBefore = TransactionService.getBySlipNumber(formatSlip(TARGET_SLIP_NUM - 1));
  if (guardBefore && stillBefore && stillBefore.id !== guardBefore.id) {
    throw new Error(`${formatSlip(TARGET_SLIP_NUM - 1)} was changed`);
  }

  console.log('\nLOCAL AFTER');
  console.log(`${targetSlip}:`, summarize(inserted));
  console.log(`${expectedOldTarget} (was ${targetSlip}):`, summarize(oldTarget));

  const localTickets = allAffected.map((item) => {
    const txn = TransactionService.getById(item.id);
    return { id: item.id, slip: item.slip, truck: txn.truck_number };
  });

  if (pgAvailable) {
    console.log('\nUpdating RDS...');
    const client = await pg.getDedicatedClient();
    try {
      await client.query('BEGIN');
      const insertRemoteId = await findRemoteId(client, insertTxn.remote_pg_id, insertSlip);
      if (insertRemoteId) {
        await client.query('UPDATE remote_trips SET slip_number = $2 WHERE id = $1', [
          insertRemoteId,
          tempSlip,
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
      }
      await client.query('COMMIT');
      await pg.syncSlipCounterToMax(insertFrom);
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
  }

  const finalTxn = TransactionService.getBySlipNumber(targetSlip);
  let mcg = { ok: false, skipped: true, reason: 'not_attempted' };
  try {
    mcg = await McgPortalService.postClosedTicket(finalTxn.id);
  } catch (err) {
    mcg = { ok: false, error: err.message };
  }
  console.log('MCG', mcg.ok ? 'sent' : mcg.skipped ? `skipped:${mcg.reason}` : `failed:${mcg.error || mcg.reason}`);

  try {
    const ReportService = require('../backend/services/ReportService');
    const pdf = await ReportService.regenerateTripPDF(finalTxn.id);
    console.log('PDF generated for', targetSlip, pdf && pdf.path);
  } catch (err) {
    console.log(`Report gen skipped: ${err.message}`);
  }

  try {
    const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');
    if (typeof CloudAdminSyncService.pushTransaction === 'function') {
      await CloudAdminSyncService.pushTransaction(finalTxn);
      console.log('Mirror pushed for', targetSlip);
    }
  } catch (err) {
    console.log(`Mirror push skipped: ${err.message}`);
  }

  if (pg.isConfigured()) {
    try {
      await pg.closePool();
    } catch (_e) {
      /* ignore */
    }
  }

  console.log('\n=== Second trip seeded ===');
  console.log(JSON.stringify({ ...summarize(finalTxn), mcg }, null, 2));
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
