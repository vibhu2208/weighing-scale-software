'use strict';

/** Store per-pass snapshots from all configured cameras (JSON). */
const id = '003_camera_snapshots';

function up(db) {
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all();
  const has = cols.some((c) => c.name === 'camera_snapshots');
  if (!has) {
    db.exec(`ALTER TABLE transactions ADD COLUMN camera_snapshots TEXT`);
  }
}

function down(db) {
  /* SQLite cannot drop column easily — no-op for dev reset */
}

module.exports = { id, up, down };
