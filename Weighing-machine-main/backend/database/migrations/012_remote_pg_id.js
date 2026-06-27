'use strict';

/** Internal dedup for RDS remote trip import — never shown in UI or exports. */
const id = '012_remote_pg_id';

function columnExists(db, table, name) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === name);
}

function up(db) {
  if (!columnExists(db, 'transactions', 'remote_pg_id')) {
    db.exec(`ALTER TABLE transactions ADD COLUMN remote_pg_id TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_remote_pg_id
      ON transactions(remote_pg_id)
      WHERE remote_pg_id IS NOT NULL
  `);
}

function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_transactions_remote_pg_id`);
  /* SQLite — no drop column */
}

module.exports = { id, up, down };
