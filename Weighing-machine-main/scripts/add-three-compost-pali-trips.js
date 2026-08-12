'use strict';

/**
 * Add 3 CLOSED COMPOST/pali trips (HR38AC3336, HR38X3951, HR38X4672).
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/add-three-compost-pali-trips.js
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

/** IST wall-clock → UTC ISO (Aug 1 2026). */
function istToUtcIso(hms) {
  const [hh, mm, ss] = hms.split(':').map(Number);
  // Aug 1 2026 00:00 IST = Jul 31 2026 18:30 UTC
  const utc = Date.UTC(2026, 6, 31, 18, 30, 0) + ((hh * 3600 + mm * 60 + ss) * 1000);
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

const TRIPS = [
  {
    truck_number: 'HR38AC3336',
    tare_weight: 14200,
    gross_weight: 52100,
    timestamp_in: istToUtcIso('10:14:45'),
    timestamp_out: istToUtcIso('12:21:42'),
  },
  {
    truck_number: 'HR38X3951',
    tare_weight: 13600,
    gross_weight: 51500,
    timestamp_in: istToUtcIso('10:21:12'),
    timestamp_out: istToUtcIso('12:26:45'),
  },
  {
    truck_number: 'HR38X4672',
    tare_weight: 13800,
    gross_weight: 52800,
    timestamp_in: istToUtcIso('10:26:32'),
    timestamp_out: istToUtcIso('12:59:10'),
  },
];

const SHARED = {
  customer_name: 'MCG',
  destination: 'pali',
  material: 'COMPOST',
  operator_name: 'SHUBHAM',
};

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const McgPortalService = require('../backend/services/McgPortalService');
  const pg = require('../backend/database/pg');
  const ts = require('../backend/utils/timestamp');

  initDatabase();
  const db = getDb();

  const maxRow = db
    .prepare(
      `SELECT slip_number FROM transactions
       WHERE slip_number LIKE 'WB%'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER) DESC
       LIMIT 1`,
    )
    .get();
  let nextNum = Number(String(maxRow?.slip_number || 'WB0').replace(/^WB/i, '')) || 0;
  nextNum += 1;

  const created = [];

  for (const trip of TRIPS) {
    const slip = `WB${nextNum}`;
    nextNum += 1;

    const vehicle = db
      .prepare('SELECT rfid_tag, vehicle_type FROM vehicles WHERE vehicle_number = ?')
      .get(trip.truck_number);

    let remotePgId = `local-manual-${slip}-${Date.now()}`;

    if (pg.isConfigured()) {
      try {
        if (await pg.ping()) {
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
          const placeholders = cols.map((_, i) => `$${i + 1}`);
          const res = await pg.query(
            `INSERT INTO remote_trips (${cols.join(', ')})
             VALUES (${placeholders.join(', ')})
             RETURNING id, slip_number`,
            values,
          );
          if (res.rows[0]?.id) {
            remotePgId = String(res.rows[0].id);
            console.log(`RDS remote_trips: ${slip} id=${remotePgId}`);
          }
        } else {
          console.log('PG ping failed — local insert only');
        }
      } catch (err) {
        console.log(`PG insert skipped: ${err.message}`);
      }
    } else {
      console.log('PG_SYNC_URL not configured — local insert only');
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
      tare_weight: trip.tare_weight,
      gross_weight: trip.gross_weight,
      timestamp_in: trip.timestamp_in,
      timestamp_out: trip.timestamp_out,
    });

    if (!result.imported) {
      console.log(`FAILED/exists: ${slip} ${trip.truck_number}`, result.transaction?.id);
      continue;
    }

    const txn = result.transaction;
    let mcg = { ok: false, skipped: true, reason: 'not_attempted' };
    try {
      mcg = await McgPortalService.postClosedTicket(txn.id);
    } catch (err) {
      mcg = { ok: false, error: err.message };
    }

    try {
      const ReportService = require('../backend/services/ReportService');
      await ReportService.generateReport(txn.id);
    } catch (err) {
      console.log(`Report gen skipped for ${slip}: ${err.message}`);
    }

    try {
      const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');
      if (typeof CloudAdminSyncService.pushTransaction === 'function') {
        await CloudAdminSyncService.pushTransaction(txn);
      }
    } catch (err) {
      console.log(`Mirror push skipped for ${slip}: ${err.message}`);
    }

    created.push({
      slip,
      truck: trip.truck_number,
      tare: trip.tare_weight,
      gross: trip.gross_weight,
      in: trip.timestamp_in,
      out: trip.timestamp_out,
      mcg: mcg.ok ? 'sent' : mcg.skipped ? `skipped:${mcg.reason}` : `failed:${mcg.error || mcg.reason}`,
      id: txn.id,
    });
    console.log(
      `OK ${slip} ${trip.truck_number} tare=${trip.tare_weight} gross=${trip.gross_weight} mcg=${created[created.length - 1].mcg}`,
    );
  }

  const counter = db
    .prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1')
    .get();
  const maxCreated = nextNum - 1;
  if (counter && counter.current_value < maxCreated) {
    db.prepare(
      'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
    ).run(maxCreated, ts.now(), counter.id);
    console.log(`slip_counter → ${maxCreated}`);
  }

  if (pg.isConfigured()) {
    try {
      if (await pg.ping()) {
        await pg.syncSlipCounterToMax(maxCreated);
        console.log(`RDS slip_counter synced to max ${maxCreated}`);
      }
    } catch (err) {
      console.log(`RDS counter sync skipped: ${err.message}`);
    }
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
