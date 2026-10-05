'use strict';

const ts = require('../../utils/timestamp');

/** Drop the old default E200 EPC prefix so all RFID tag series are accepted. */
const id = '020_clear_rfid_epc_prefix';

function up(db) {
  db.prepare(
    `UPDATE settings
     SET value = '', updated_at = ?
     WHERE key = 'RFID_EPC_PREFIX'
       AND UPPER(TRIM(value)) = 'E200'`,
  ).run(ts.now());
}

function down(db) {
  /* SQLite — no-op */
}

module.exports = { id, up, down };
