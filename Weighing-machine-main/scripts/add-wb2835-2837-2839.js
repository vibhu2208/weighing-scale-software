'use strict';

/**
 * Insert three CLOSED COMPOST/BADKHAL trips into empty slips WB2835, WB2837, WB2839.
 * Times are 14 Aug 2026 IST (13th night shift) so they sit in the existing gap sequence.
 *
 * Run:
 *   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/add-wb2835-2837-2839.js
 * Then PDFs:
 *   npx electron scripts/regen-one-report.js WB2835
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

/** 14 Aug 2026 IST wall-clock → UTC ISO. */
function istToUtcIso(hms) {
  const [hh, mm, ss] = hms.split(':').map(Number);
  const utc = Date.UTC(2026, 7, 13, 18, 30, 0) + (hh * 3600 + mm * 60 + ss) * 1000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

const SHARED = {
  customer_name: 'MCG',
  destination: 'BADKHAL',
  material: 'COMPOST',
  operator_name: 'YATIN',
  company: 'DCC',
};

const TRIPS = [
  {
    slip_number: 'WB2835',
    truck_number: 'HR38X7059',
    tare_weight: 14030,
    gross_weight: 49240,
    timestamp_in: istToUtcIso('02:46:41'),
    timestamp_out: istToUtcIso('04:58:46'),
  },
  {
    slip_number: 'WB2837',
    truck_number: 'HR38X3951',
    tare_weight: 13920,
    gross_weight: 51180,
    timestamp_in: istToUtcIso('02:54:24'),
    timestamp_out: istToUtcIso('05:45:16'),
  },
  {
    slip_number: 'WB2839',
    truck_number: 'HR38X4672',
    tare_weight: 13890,
    gross_weight: 51620,
    timestamp_in: istToUtcIso('02:59:58'),
    timestamp_out: istToUtcIso('06:51:09'),
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

  initDatabase();
  const db = getDb();
  const photoDir = path.join(PATHS.IMAGES, '2026', '08', '14');
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
    const slip = trip.slip_number;
    if (TransactionService.getBySlipNumber(slip)) {
      console.log(`SKIP ${slip} already exists locally`);
      continue;
    }

    const vehicle = db
      .prepare('SELECT rfid_tag, vehicle_type FROM vehicles WHERE vehicle_number = ?')
      .get(trip.truck_number);

    const srcPhotos = latestPhotos(db, trip.truck_number) || {};
    const shortId = uuidv4().replace(/-/g, '').slice(0, 8);
    const arrivalPath = copyPhoto(
      srcPhotos.arrival_photo_1,
      photoDir,
      `20260814_${trip.truck_number}_arrival_cam-1_${shortId}.jpg`,
    );
    const departurePath = copyPhoto(
      srcPhotos.departure_photo_1 || srcPhotos.arrival_photo_1,
      photoDir,
      `20260814_${trip.truck_number}_departure_cam-1_${shortId}.jpg`,
    );

    const snapshots = {
      gross: arrivalPath
        ? [{ id: 'cam-1', label: 'Camera 1', path: arrivalPath }]
        : [],
      tare: departurePath
        ? [{ id: 'cam-1', label: 'Camera 1', path: departurePath }]
        : [],
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
          vehicle?.vehicle_type || 'hywa',
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

    console.log(`Mirror push deferred for ${slip}`);

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
      arrival: Boolean(arrivalPath),
      departure: Boolean(departurePath),
    });
    console.log(
      `OK ${slip} ${trip.truck_number} tare=${trip.tare_weight} gross=${trip.gross_weight} net=${net} mcg=${created[created.length - 1].mcg}`,
    );
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
  console.error(err);
  process.exit(1);
});
