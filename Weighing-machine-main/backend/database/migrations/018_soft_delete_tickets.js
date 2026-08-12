'use strict';

const id = '018_soft_delete_tickets';

function columnExists(db, table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === name);
}

function up(db) {
  if (!columnExists(db, 'transactions', 'deleted_at')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN deleted_at TEXT`);
  }
}

function down(_db) {
  /* SQLite — no drop column */
}

module.exports = { id, up, down };
