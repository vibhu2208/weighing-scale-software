'use strict';

const ts = require('../../utils/timestamp');

/** Align seeded RFID settings with ETS-IR 04 SDK defaults (TCP port 9090). */
const id = '006_rfid_ets_ir_settings';

function up(db) {
  const now = ts.now();
  const update = db.prepare(
    `UPDATE settings
     SET value = ?, updated_at = ?
     WHERE key = ? AND value = ?`,
  );

  const fixes = [
    ['RFID_IP', '192.168.1.50', '192.168.1.116'],
    ['RFID_PORT', '4001', '9090'],
    ['USE_MOCK_HARDWARE', 'true', 'false'],
  ];

  for (const [key, oldValue, newValue] of fixes) {
    update.run(newValue, now, key, oldValue);
  }

  const ipsRow = db.prepare(`SELECT value FROM settings WHERE key = 'RFID_IPS'`).get();
  if (!ipsRow) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('RFID_IPS', '192.168.1.116,192.168.1.117', ?)`,
    ).run(now);
  }
}

function down(db) {
  /* SQLite — no-op */
}

module.exports = { id, up, down };
