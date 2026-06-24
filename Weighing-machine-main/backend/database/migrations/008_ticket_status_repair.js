'use strict';

/** Repair rows where legacy status is error/failed but ticket_status stayed OPEN. */
const id = '008_ticket_status_repair';

function up(db) {
  db.prepare(
    `UPDATE transactions
     SET ticket_status = 'CANCELLED', updated_at = datetime('now')
     WHERE ticket_status = 'OPEN'
       AND status IN ('error', 'failed')`,
  ).run();

  db.prepare(
    `UPDATE transactions
     SET status = 'cancelled', updated_at = datetime('now')
     WHERE status = 'error'
       AND ticket_status = 'CANCELLED'`,
  ).run();
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
