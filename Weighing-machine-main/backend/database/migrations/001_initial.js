'use strict';

/**
 * Migration 001 — Initial schema (idempotent: safe to run multiple times).
 */
const id = '001_initial';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id              TEXT PRIMARY KEY,
      truck_number    TEXT NOT NULL,
      rfid_tag        TEXT,
      gross_weight    REAL,
      tare_weight     REAL,
      net_weight      REAL GENERATED ALWAYS AS (gross_weight - tare_weight) VIRTUAL,
      timestamp_in    TEXT NOT NULL,
      timestamp_out   TEXT,
      image_path      TEXT,
      operator_id     TEXT,
      slip_number     TEXT UNIQUE,
      sync_status     TEXT NOT NULL DEFAULT 'pending',
      status          TEXT NOT NULL DEFAULT 'pending',
      notes           TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id              TEXT PRIMARY KEY,
      vehicle_number  TEXT NOT NULL UNIQUE,
      rfid_tag        TEXT UNIQUE,
      owner_name      TEXT,
      transporter     TEXT,
      vehicle_type    TEXT,
      max_capacity    REAL,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id  TEXT NOT NULL REFERENCES transactions(id),
      retry_count     INTEGER NOT NULL DEFAULT 0,
      sync_status     TEXT NOT NULL DEFAULT 'pending',
      last_attempt    TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_type     TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      message         TEXT NOT NULL,
      metadata        TEXT,
      timestamp       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operators (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      pin             TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'operator',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slip_counter (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      prefix          TEXT NOT NULL DEFAULT 'WB',
      current_value   INTEGER NOT NULL DEFAULT 1000,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp_in);
    CREATE INDEX IF NOT EXISTS idx_transactions_truck ON transactions(truck_number);
    CREATE INDEX IF NOT EXISTS idx_transactions_rfid ON transactions(rfid_tag);
    CREATE INDEX IF NOT EXISTS idx_transactions_sync ON transactions(sync_status);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_vehicles_rfid ON vehicles(rfid_tag);
    CREATE INDEX IF NOT EXISTS idx_vehicles_number ON vehicles(vehicle_number);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(sync_status);
    CREATE INDEX IF NOT EXISTS idx_device_logs_type ON device_logs(device_type);
    CREATE INDEX IF NOT EXISTS idx_device_logs_timestamp ON device_logs(timestamp);
  `);
}

function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_device_logs_timestamp;
    DROP INDEX IF EXISTS idx_device_logs_type;
    DROP INDEX IF EXISTS idx_sync_queue_status;
    DROP INDEX IF EXISTS idx_vehicles_number;
    DROP INDEX IF EXISTS idx_vehicles_rfid;
    DROP INDEX IF EXISTS idx_transactions_status;
    DROP INDEX IF EXISTS idx_transactions_sync;
    DROP INDEX IF EXISTS idx_transactions_rfid;
    DROP INDEX IF EXISTS idx_transactions_truck;
    DROP INDEX IF EXISTS idx_transactions_timestamp;
    DROP TABLE IF EXISTS slip_counter;
    DROP TABLE IF EXISTS operators;
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS device_logs;
    DROP TABLE IF EXISTS sync_queue;
    DROP TABLE IF EXISTS vehicles;
    DROP TABLE IF EXISTS transactions;
  `);
}

module.exports = { id, up, down };
