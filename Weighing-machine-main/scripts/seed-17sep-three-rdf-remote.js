'use strict';

/**
 * Seed three 17 Sep 2026 RDF remote trips after 6pm IST (append next slips).
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/seed-17sep-three-rdf-remote.js
 */
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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

/** 17 Sep 2026 IST wall-clock → UTC ISO. */
function istToUtcIso(hms) {
  const [hh, mm, ss] = hms.split(':').map(Number);
  const utc = Date.UTC(2026, 8, 16, 18, 30, 0) + (hh * 3600 + mm * 60 + ss) * 1000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function parseSlipNumeric(slip) {
  const match = String(slip || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

function formatSlip(n) {
  return `WB${String(n).padStart(4, '0')}`;
}

const SHARED = {
  customer_name: 'MCG',
  destination: 'MUZAFFAR NAGAR',
  material: 'RDF',
  operator_name: 'KARAMVEER',
  company: 'DCC',
};

const TRIPS = [
  {
    truck_number: 'HR65A7668',
    tare_weight: 16320,
    gross_weight: 62360,
    timestamp_in: istToUtcIso('18:12:38'),
    timestamp_out: istToUtcIso('20:24:09'),
  },
  {
    truck_number: 'HR58E3515',
    tare_weight: 15160,
    gross_weight: 59220,
    timestamp_in: istToUtcIso('20:28:51'),
    timestamp_out: istToUtcIso('22:46:33'),
  },
  {
    truck_number: 'HR58D8715',
    tare_weight: 16280,
    gross_weight: 61560,
    timestamp_in: istToUtcIso('22:41:17'),
    timestamp_out: istToUtcIso('23:52:08'),
  },
];

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

  for (const trip of TRIPS) {
    const existing = db
      .prepare(
        `SELECT slip_number FROM transactions
         WHERE truck_number = ?
           AND timestamp_in >= '2026-09-16T18:30:00.000Z'
           AND timestamp_in < '2026-09-17T18:30:00.000Z'
         LIMIT 1`,
      )
      .get(trip.truck_number);
    if (existing) {
      throw new Error(`${trip.truck_number} already has ${existing.slip_number} on 17 Sep`);
    }
  }

  const maxRow = db
    .prepare(
      `SELECT slip_number FROM transactions
       WHERE slip_number LIKE 'WB%'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
       LIMIT 1`,
    )
    .get();
  let nextNum = parseSlipNumeric(maxRow?.slip_number) + 1;
  console.log(`Starting from ${formatSlip(nextNum)} (after ${maxRow?.slip_number})`);

  const photoDir = path.join(PATHS.IMAGES, '2026', '09', '17');
  const created = [];

  let pgAvailable = false;
  if (pg.isConfigured()) {
    try {
      pgAvailable = await pg.ping();
    } catch (_e) {
      pgAvailable = false;
    }
    if (!pgAvailable) console.log('PG ping failed — local + MCG only');
  }

  for (const trip of TRIPS) {
    const slip = formatSlip(nextNum);
    nextNum += 1;

    if (TransactionService.getBySlipNumber(slip)) {
      throw new Error(`${slip} already exists locally`);
    }

    const vehicle = db
      .prepare('SELECT rfid_tag, vehicle_type FROM vehicles WHERE vehicle_number = ?')
      .get(trip.truck_number);
    const srcPhotos = latestPhotos(db, trip.truck_number) || {};
    const shortId = uuidv4().replace(/-/g, '').slice(0, 8);
    const arrivalPath = copyPhoto(
      srcPhotos.arrival_photo_1,
      photoDir,
      `20260917_${trip.truck_number}_arrival_cam-1_${shortId}.jpg`,
    );
    const departurePath = copyPhoto(
      srcPhotos.departure_photo_1 || srcPhotos.arrival_photo_1,
      photoDir,
      `20260917_${trip.truck_number}_departure_cam-1_${shortId}.jpg`,
    );
    const snapshots = {
      gross: arrivalPath ? [{ id: 'cam-1', label: 'Camera 1', path: arrivalPath }] : [],
      tare: departurePath ? [{ id: 'cam-1', label: 'Camera 1', path: departurePath }] : [],
    };

    let remotePgId = `local-manual-${slip}-${Date.now()}`;
    if (pgAvailable) {
      try {
        const existing = await pg.query(
          'SELECT id FROM remote_trips WHERE slip_number = $1 LIMIT 1',
          [slip],
        );
        if (existing.rows[0]?.id) {
          throw new Error(`${slip} already exists on RDS remote_trips`);
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
          slip,
          trip.truck_number,
          SHARED.customer_name,
          SHARED.destination,
          SHARED.material,
          SHARED.operator_name,
          trip.tare_weight,
          trip.gross_weight,
          trip.timestamp_in,
          trip.timestamp_out,
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
          console.log(`RDS remote_trips: ${slip} id=${remotePgId}`);
        }
      } catch (err) {
        console.log(`PG insert skipped for ${slip}: ${err.message}`);
      }
    }

    const result = TransactionService.importClosedTrip({
      id: uuidv4(),
      remote_pg_id: remotePgId,
      slip_number: slip,
      truck_number: trip.truck_number,
      rfid_tag: vehicle?.rfid_tag || null,
      customer_name: SHARED.customer_name,
      destination: SHARED.destination,
      material: SHARED.material,
      operator_name: SHARED.operator_name,
      company: SHARED.company,
      tare_weight: trip.tare_weight,
      gross_weight: trip.gross_weight,
      timestamp_in: trip.timestamp_in,
      timestamp_out: trip.timestamp_out,
      arrival_photo_1: arrivalPath,
      departure_photo_1: departurePath,
      image_path: departurePath || arrivalPath,
    });
    if (!result.imported) {
      throw new Error(`FAILED/exists: ${slip} ${trip.truck_number}`);
    }

    const txn = TransactionService.updateFields(result.transaction.id, {
      raw_tare_weight: trip.tare_weight,
      raw_gross_weight: trip.gross_weight,
      camera_snapshots: JSON.stringify(snapshots),
    });

    let mcg = { ok: false, skipped: true, reason: 'not_attempted' };
    try {
      mcg = await McgPortalService.postClosedTicket(txn.id);
    } catch (err) {
      mcg = { ok: false, error: err.message };
    }

    const net = trip.gross_weight - trip.tare_weight;
    created.push({
      slip,
      truck: trip.truck_number,
      tare: trip.tare_weight,
      gross: trip.gross_weight,
      net,
      in: trip.timestamp_in,
      out: trip.timestamp_out,
      mcg: mcg.ok
        ? 'sent'
        : mcg.skipped
          ? `skipped:${mcg.reason}`
          : `failed:${mcg.error || mcg.reason}`,
      id: txn.id,
    });
    console.log(
      `OK ${slip} ${trip.truck_number} tare=${trip.tare_weight} gross=${trip.gross_weight} net=${net} mcg=${created[created.length - 1].mcg}`,
    );
  }

  const maxCreated = nextNum - 1;
  const counter = db.prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1').get();
  if (counter && counter.current_value < maxCreated) {
    db.prepare('UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?').run(
      maxCreated,
      ts.now(),
      counter.id,
    );
    console.log(`slip_counter → ${maxCreated}`);
  }

  if (pgAvailable) {
    try {
      await pg.syncSlipCounterToMax(maxCreated);
      console.log(`RDS slip_counter synced to max ${maxCreated}`);
    } catch (err) {
      console.log(`RDS counter sync skipped: ${err.message}`);
    }
  }

  if (pg.isConfigured()) {
    try {
      await pg.closePool();
    } catch (_e) {
      /* ignore */
    }
  }

  console.log('\n=== Created ===');
  console.log(JSON.stringify(created, null, 2));
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
