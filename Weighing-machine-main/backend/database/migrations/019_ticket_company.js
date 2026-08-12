'use strict';

/** Per-ticket company field and companies dropdown list (DCC, MKG). */
const id = '019_ticket_company';

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
  addColumnIfMissing(db, 'transactions', 'company', 'TEXT');
  seedListIfMissing(db, 'companies_list', ['DCC', 'MKG']);
  // Backfill existing tickets so reports can filter them
  db.prepare(
    `UPDATE transactions SET company = 'DCC' WHERE company IS NULL OR TRIM(company) = ''`,
  ).run();
}

function down(db) {
  /* SQLite cannot drop columns easily — no-op */
}

module.exports = { id, up, down };
