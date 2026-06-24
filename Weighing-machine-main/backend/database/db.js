'use strict';

const path = require('path');
const { dialog } = (() => {
  try {
    return require('electron');
  } catch (_e) {
    return {};
  }
})();

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { PATHS, ensureDir } = require('../utils/fileStorage');
const migration001 = require('./migrations/001_initial');
const migration002 = require('./migrations/002_tare_image');
const migration003 = require('./migrations/003_camera_snapshots');
const migration004 = require('./migrations/004_cloud_uploads');
const migration005 = require('./migrations/005_raw_weights');
const migration006 = require('./migrations/006_rfid_ets_ir_settings');
const migration007 = require('./migrations/007_open_close_tickets');
const migration008 = require('./migrations/008_ticket_status_repair');
const migration009 = require('./migrations/009_sync_trip_photo_columns');
const migration010 = require('./migrations/010_repair_departure_photos');
const migration011 = require('./migrations/011_trip_customer_destination_operator');

let db = null;

function resolveDbPath() {
  const fromEnv = process.env.DB_PATH && process.env.DB_PATH.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(PATHS.ROOT, fromEnv);
  }
  return path.join(PATHS.DATABASE, 'weighbridge.db');
}

/**
 * Run all pending migrations inside a single transaction so a partial
 * migration cannot leave the database in a broken state.
 */
function runMigrations(handle = db) {
  if (!handle) {
    throw new Error('runMigrations: database is not initialised');
  }

  const migrations = [
    migration001,
    migration002,
    migration003,
    migration004,
    migration005,
    migration006,
    migration007,
    migration008,
    migration009,
    migration010,
    migration011,
  ];

  const apply = handle.transaction(() => {
    for (const migration of migrations) {
      logger.info('Running migration', { id: migration.id });
      migration.up(handle);
    }
  });

  try {
    apply();
    logger.info('Migrations complete', { count: migrations.length });
  } catch (err) {
    if (err && err.code === 'SQLITE_BUSY' && dialog && dialog.showErrorBox) {
      dialog.showErrorBox(
        'Database is locked',
        'Could not run database migrations because the database is locked. ' +
          'Please close any other instance and try again.',
      );
    }
    logger.error('Migration failed', { message: err.message, code: err.code });
    throw err;
  }
}

/** Ensure a default admin exists on fresh installs (PIN: 1234). */
function ensureDefaultAdmin(handle = db) {
  if (!handle) return;

  const existing = handle
    .prepare(
      `SELECT id FROM operators
       WHERE role = 'admin' AND status = 'active' LIMIT 1`,
    )
    .get();

  if (existing) return;

  const now = ts.now();
  handle
    .prepare(
      `INSERT INTO operators (id, name, pin, role, status, created_at)
       VALUES (?, 'Admin', '1234', 'admin', 'active', ?)`,
    )
    .run(uuidv4(), now);

  logger.info('Default admin operator created', { pin: '1234' });
}

/** Open (or create) the SQLite database. Returns the singleton. */
function initDatabase() {
  if (db) return db;

  const dbPath = resolveDbPath();
  ensureDir(path.dirname(dbPath));

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    logger.error('better-sqlite3 is not installed', { error: err.message });
    throw err;
  }

  try {
    db = new Database(dbPath, { fileMustExist: false });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    logger.info('SQLite connected', { path: dbPath, mode: 'WAL' });

    runMigrations(db);
    ensureDefaultAdmin(db);

    try {
      const TransactionService = require('../services/TransactionService');
      TransactionService.ensureSlipCounter();
    } catch (err) {
      logger.warn('slip_counter bootstrap skipped', { message: err.message });
    }

    return db;
  } catch (err) {
    logger.error('SQLite connection failed', {
      path: dbPath,
      code: err.code,
      message: err.message,
    });

    if (err && err.code === 'SQLITE_BUSY' && dialog && dialog.showErrorBox) {
      dialog.showErrorBox(
        'Database is locked',
        'The weighbridge database is currently in use by another process. ' +
          'Please close any other instance and try again.',
      );
    }
    throw err;
  }
}

/** Get the live db handle (initialise lazily). */
function getDb() {
  if (!db) initDatabase();
  return db;
}

/** Close the connection cleanly (used by reset-db / test harness). */
function closeDatabase() {
  if (db) {
    try {
      db.close();
      logger.info('SQLite connection closed');
    } catch (err) {
      logger.warn('Error closing SQLite', { message: err.message });
    } finally {
      db = null;
    }
  }
}

/** Quick health check — returns true if the connection responds. */
function ping() {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get();
    return !!row && row.ok === 1;
  } catch (err) {
    logger.error('SQLite ping failed', { message: err.message });
    return false;
  }
}

module.exports = {
  initDatabase,
  getDb,
  closeDatabase,
  ping,
  resolveDbPath,
  runMigrations,
};
