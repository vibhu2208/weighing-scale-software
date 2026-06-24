'use strict';

/** Store real scale readings alongside adjusted public weights. */
const id = '005_raw_weights';

function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function up(db) {
  addColumnIfMissing(db, 'transactions', 'raw_tare_weight', 'REAL');
  addColumnIfMissing(db, 'transactions', 'raw_gross_weight', 'REAL');
  addColumnIfMissing(db, 'transactions', 'weight_offset_kg', 'REAL');
}

function down(db) {
  /* SQLite — no-op */
}

module.exports = { id, up, down };
