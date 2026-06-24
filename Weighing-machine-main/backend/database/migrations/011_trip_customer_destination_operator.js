'use strict';

/** Per-ticket customer, destination, operator fields and dropdown lists. */
const id = '011_trip_customer_destination_operator';

function columnExists(db, table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === name);
}

function addColumnIfMissing(db, table, name, type) {
  if (!columnExists(db, table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function seedListIfMissing(db, key, values) {
  const existing = db.prepare(`SELECT value FROM settings WHERE key = ? LIMIT 1`).get(key);
  if (existing) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(key, JSON.stringify(values), now);
}

function up(db) {
  addColumnIfMissing(db, 'transactions', 'customer_name', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'destination', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'operator_name', 'TEXT');

  seedListIfMissing(db, 'customers_list', ['MCG']);
  seedListIfMissing(db, 'destinations_list', ['MEERUT']);
  seedListIfMissing(db, 'operators_list', ['SUNNY']);
}

function down(db) {
  /* SQLite cannot drop columns easily — no-op */
}

module.exports = { id, up, down };
