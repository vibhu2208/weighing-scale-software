'use strict';

/** Add tare_image_path for two-pass weighment (empty + loaded captures). */
const id = '002_tare_image';

function up(db) {
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all();
  const has = cols.some((c) => c.name === 'tare_image_path');
  if (!has) {
    db.exec(`ALTER TABLE transactions ADD COLUMN tare_image_path TEXT`);
  }
}

function down(db) {
  /* SQLite cannot drop column easily — no-op for dev reset */
}

module.exports = { id, up, down };
