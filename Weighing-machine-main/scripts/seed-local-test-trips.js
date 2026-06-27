#!/usr/bin/env node
'use strict';

/**
 * Inserts 2 local CLOSED test trips into SQLite (for Reports / slip-number checks).
 * Run: npm run seed-local-test-trips
 */
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_e) {
  /* optional */
}

const { v4: uuidv4 } = require('uuid');
const { initDatabase } = require('../backend/database/db');
const TransactionService = require('../backend/services/TransactionService');
const ts = require('../backend/utils/timestamp');
const { TICKET_STATUS } = require('../backend/utils/constants');

const TEST_TRIPS = [
  {
    remote_pg_id: 'local-test-trip-001',
    slip_number: 'WB2010',
    truck_number: 'HR38TEST01',
    customer_name: 'MCG',
    destination: 'MEERUT',
    material: 'C&D',
    operator_name: 'SUNNY',
    tare_weight: 8500,
    gross_weight: 25000,
  },
  {
    remote_pg_id: 'local-test-trip-002',
    slip_number: 'WB2011',
    truck_number: 'HR38TEST02',
    customer_name: 'MCG',
    destination: 'MEERUT',
    material: 'C&D',
    operator_name: 'SUNNY',
    tare_weight: 9200,
    gross_weight: 24500,
  },
];

function main() {
  initDatabase();

  const now = ts.now();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

  let added = 0;
  for (let i = 0; i < TEST_TRIPS.length; i += 1) {
    const t = TEST_TRIPS[i];
    const existing = TransactionService.getBySlipNumber(t.slip_number);
    if (existing) {
      console.log(`Skip (exists): ${t.slip_number} → ${existing.id}`);
      continue;
    }

    const result = TransactionService.importClosedTrip({
      id: uuidv4(),
      remote_pg_id: t.remote_pg_id,
      slip_number: t.slip_number,
      truck_number: t.truck_number,
      customer_name: t.customer_name,
      destination: t.destination,
      material: t.material,
      operator_name: t.operator_name,
      tare_weight: t.tare_weight,
      gross_weight: t.gross_weight,
      timestamp_in: twoHoursAgo,
      timestamp_out: i === 0 ? oneHourAgo : now,
    });

    if (result.imported) {
      added += 1;
      console.log(`Added: ${t.slip_number} truck ${t.truck_number} id=${result.transaction.id}`);
    } else {
      console.log(`Already present: ${t.slip_number}`);
    }
  }

  const db = require('../backend/database/db').getDb();
  const counter = db
    .prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1')
    .get();
  if (counter && counter.current_value < 2011) {
    db.prepare(
      'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
    ).run(2011, now, counter.id);
  }

  console.log(`\nDone. ${added} new trip(s). Open Reports → Today and search WB2010 or WB2011.`);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
