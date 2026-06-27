'use strict';

const id = '013_mcg_status';

function columnExists(db, table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === name);
}

function up(db) {
  if (!columnExists(db, 'transactions', 'mcg_status')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN mcg_status TEXT`);
  }
  if (!columnExists(db, 'transactions', 'mcg_error')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN mcg_error TEXT`);
  }
  if (!columnExists(db, 'transactions', 'mcg_sent_at')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN mcg_sent_at TEXT`);
  }
}

function down(db) {
  /* SQLite — no drop column */
}

module.exports = { id, up, down };
