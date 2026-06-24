#!/usr/bin/env node
'use strict';

/**
 * Upserts demo vehicle HR38AH6118 + RFID E200470678E064222F03010C into the live DB.
 * Run: npm run upsert-hr38-vehicle
 */
const path = require('path');

try {
  require('dotenv').config({
    path: path.resolve(__dirname, '..', '.env'),
  });
} catch (_e) {
  /* optional */
}

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../backend/database/db');
const VehicleService = require('../backend/services/VehicleService');
const ts = require('../backend/utils/timestamp');
const { TRANSACTION_STATUS, SYNC_STATUS } = require('../backend/utils/constants');

const VEHICLE = {
  vehicle_number: 'HR38AH6118',
  rfid_tag: 'E200470678E064222F03010C',
  owner_name: 'Krishna Transport Co.',
  transporter: 'Haryana Freight Lines',
  vehicle_type: 'truck',
  max_capacity: 28000,
  status: 'active',
};

const DEMO_TRANSACTIONS = [
  {
    slip: 'WB-1011',
    daysAgo: 2,
    gross: 26500,
    tare: 9200,
    sync: SYNC_STATUS.SYNCED,
    status: TRANSACTION_STATUS.SYNCED,
  },
  {
    slip: 'WB-1012',
    daysAgo: 0,
    gross: 24800,
    tare: 9100,
    sync: SYNC_STATUS.PENDING,
    status: TRANSACTION_STATUS.PRINTED,
  },
];

function seedDemoTransactions(operatorId) {
  const db = getDb();
  const now = ts.now();
  const insertTxn = db.prepare(
    `INSERT OR IGNORE INTO transactions (
      id, truck_number, rfid_tag, gross_weight, tare_weight,
      timestamp_in, timestamp_out, operator_id, slip_number,
      sync_status, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertQueue = db.prepare(
    `INSERT OR IGNORE INTO sync_queue (transaction_id, retry_count, sync_status, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  let added = 0;
  for (const t of DEMO_TRANSACTIONS) {
    const exists = db
      .prepare('SELECT id FROM transactions WHERE slip_number = ?')
      .get(t.slip);
    if (exists) continue;

    const id = uuidv4();
    const timestampIn = ts.daysAgo(t.daysAgo);
    const result = insertTxn.run(
      id,
      VEHICLE.vehicle_number,
      VEHICLE.rfid_tag,
      t.gross,
      t.tare,
      timestampIn,
      timestampIn,
      operatorId,
      t.slip,
      t.sync,
      t.status,
      timestampIn,
      now,
    );
    if (result.changes > 0) {
      added += 1;
      if (t.sync === SYNC_STATUS.PENDING) {
        insertQueue.run(id, 0, t.sync, timestampIn);
      }
    }
  }

  db.prepare(
    `UPDATE slip_counter SET current_value = 1012, updated_at = ? WHERE current_value < 1012`,
  ).run(now);

  return added;
}

function upsert() {
  const rfid = VEHICLE.rfid_tag;
  const byRfid = VehicleService.findByRFID(rfid);
  const byNumber = VehicleService.findByNumber(VEHICLE.vehicle_number);

  if (byRfid && byNumber && byRfid.id !== byNumber.id) {
    console.error(
      'Conflict: RFID and vehicle number belong to different records. Fix manually.',
    );
    process.exit(1);
  }

  const existing = byRfid || byNumber;
  if (existing) {
    const updated = VehicleService.update(existing.id, VEHICLE);
    console.log('Updated vehicle:', updated.vehicle_number, updated.rfid_tag);
    return;
  }

  const created = VehicleService.create(VEHICLE);
  console.log('Created vehicle:', created.vehicle_number, created.rfid_tag);
}

function seedTransactions() {
  const db = getDb();
  const adminRow = db
    .prepare("SELECT id FROM operators WHERE name = 'Admin' LIMIT 1")
    .get();
  if (!adminRow) {
    console.warn('No Admin operator — skipped demo transactions');
    return 0;
  }
  const added = seedDemoTransactions(adminRow.id);
  if (added > 0) {
    console.log(`Added ${added} demo transaction(s) for ${VEHICLE.vehicle_number}`);
  } else {
    console.log('Demo transactions already present (WB-1011, WB-1012)');
  }
  return added;
}

try {
  upsert();
  seedTransactions();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
