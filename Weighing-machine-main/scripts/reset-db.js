#!/usr/bin/env node
'use strict';

/**
 * Resets the SQLite database to a clean state and reseeds demo data.
 * Guarded: refuses to run unless APP_ENV=development.
 */
const path = require('path');

try {
  require('dotenv').config({
    path: path.resolve(__dirname, '..', '.env'),
  });
} catch (_e) {
  /* dotenv is optional */
}

if ((process.env.APP_ENV || '').toLowerCase() !== 'development') {
  console.error(
    'reset-db: refusing to run because APP_ENV is not "development".\n' +
      '         Set APP_ENV=development in your environment first.',
  );
  process.exit(1);
}

const logger = require('../backend/utils/logger');
const db = require('../backend/database/db');
const seed = require('../backend/database/seeds/demo_data');
const VehicleService = require('../backend/services/VehicleService');
const TransactionService = require('../backend/services/TransactionService');
const SettingsService = require('../backend/services/SettingsService');
const { TRANSACTION_STATUS } = require('../backend/utils/constants');

/** Drop child tables before parents (sync_queue → transactions). */
const DROP_ORDER = [
  'sync_queue',
  'device_logs',
  'transactions',
  'vehicles',
  'settings',
  'operators',
  'slip_counter',
];

function dropAllTables(handle) {
  const existing = new Set(
    handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name),
  );

  // SQLite cannot change foreign_keys inside a transaction — set OFF on the connection first.
  handle.pragma('foreign_keys = OFF');

  const drop = handle.transaction(() => {
    for (const name of DROP_ORDER) {
      if (existing.has(name)) {
        handle.exec(`DROP TABLE IF EXISTS "${name}"`);
        existing.delete(name);
      }
    }
    for (const name of existing) {
      handle.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
  });

  drop();
  handle.pragma('foreign_keys = ON');
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function runServiceTests() {
  console.log('\n── Service smoke tests ──');

  const vehicles = VehicleService.getAll();
  assert(vehicles.length >= 5, `expected >= 5 vehicles, got ${vehicles.length}`);
  console.log(`✓ VehicleService.getAll() → ${vehicles.length} vehicles`);

  const byRfid = VehicleService.findByRFID('E280117000000208AABBCC01');
  assert(byRfid && byRfid.vehicle_number === 'MH12AB1234', 'findByRFID');
  console.log(`✓ VehicleService.findByRFID() → ${byRfid.vehicle_number}`);

  const missingRfid = VehicleService.findByRFID('UNKNOWN_TAG_XYZ');
  assert(missingRfid === null, 'findByRFID unknown returns null');
  console.log('✓ VehicleService.findByRFID() null for unknown tag');

  const search = VehicleService.search('sharma');
  assert(search.length >= 1, 'search by owner');
  console.log(`✓ VehicleService.search() → ${search.length} result(s)`);

  const stats = TransactionService.getTodayStats();
  assert(
    typeof stats.total === 'number' &&
      typeof stats.pending === 'number' &&
      typeof stats.completed === 'number' &&
      typeof stats.totalWeight === 'number',
    'getTodayStats shape',
  );
  console.log('✓ TransactionService.getTodayStats()', stats);

  const allTxns = TransactionService.getAll();
  assert(allTxns.length >= 10, `expected >= 10 transactions, got ${allTxns.length}`);
  console.log(`✓ TransactionService.getAll() → ${allTxns.length} transactions`);

  const synced = TransactionService.getAll({ sync_status: 'synced' });
  assert(synced.length >= 1, 'filter by sync_status');
  console.log(`✓ TransactionService.getAll(filters) synced → ${synced.length}`);

  const slip = TransactionService.generateSlipNumber();
  assert(/^WB-\d+$/.test(slip), `slip format: ${slip}`);
  console.log(`✓ TransactionService.generateSlipNumber() → ${slip}`);

  const dup = TransactionService.create({
    truck_number: 'TESTDUP01',
    gross_weight: 20000,
    tare_weight: 9000,
  });
  assert(dup.isDuplicate === false, 'first create');
  const dup2 = TransactionService.create({
    truck_number: 'TESTDUP01',
    gross_weight: 21000,
    tare_weight: 9000,
  });
  assert(dup2.isDuplicate === true && dup2.existingId, 'duplicate detection');
  console.log('✓ TransactionService.create() duplicate detection');

  const negative = TransactionService.create({
    truck_number: 'TESTNEG01',
    gross_weight: 5000,
    tare_weight: 9000,
    status: TRANSACTION_STATUS.PENDING,
  });
  assert(
    negative.transaction.status === TRANSACTION_STATUS.ERROR,
    'negative net flagged error',
  );
  console.log('✓ TransactionService.create() negative net → status error');

  const setting = SettingsService.get('RFID_IP');
  assert(setting && setting.length > 0, 'settings.get default');
  console.log(`✓ SettingsService.get('RFID_IP') → ${setting}`);

  const missingSetting = SettingsService.get('NONEXISTENT_KEY_XYZ');
  assert(missingSetting !== null && missingSetting !== undefined, 'settings default not null');
  console.log(`✓ SettingsService.get() missing key → "${missingSetting}"`);

  console.log('── All service smoke tests passed ──\n');
}

(function main() {
  let handle;
  try {
    handle = db.initDatabase();

    logger.info('reset-db: dropping tables');
    dropAllTables(handle);

    db.closeDatabase();
    handle = db.initDatabase();

    logger.info('reset-db: seeding demo data');
    const stats = seed.seed(handle) || {};

    runServiceTests();

    logger.info('reset-db: complete', stats);
    console.log('reset-db: complete', stats);
  } catch (err) {
    logger.error('reset-db failed', { message: err.message, stack: err.stack });
    console.error('reset-db failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (handle) db.closeDatabase();
  }
})();
