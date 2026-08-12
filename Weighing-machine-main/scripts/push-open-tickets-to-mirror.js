'use strict';

/**
 * Push all local OPEN tickets into transactions_mirror (admin Reports).
 * Run ON the weighbridge PC (needs local SQLite + PG_SYNC_URL):
 *
 *   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/push-open-tickets-to-mirror.js
 */
const path = require('path');
const fs = require('fs');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function main() {
  loadEnv(path.join(__dirname, '..', '.env'));

  const { getDb, initDatabase } = require('../backend/database/db');
  const TransactionService = require('../backend/services/TransactionService');
  const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');
  const pg = require('../backend/database/pg');
  const { TICKET_STATUS } = require('../backend/utils/constants');

  initDatabase();

  if (!pg.isConfigured()) {
    throw new Error('PG_SYNC_URL is not configured on this PC — open tickets cannot sync');
  }

  const rows = getDb()
    .prepare(
      `SELECT id, slip_number, truck_number, ticket_status
       FROM transactions WHERE ticket_status = ?
       ORDER BY updated_at DESC`,
    )
    .all(TICKET_STATUS.OPEN);

  console.log('Local OPEN tickets:', rows.length);
  if (!rows.length) {
    console.log('No open tickets on this PC.');
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const txn = TransactionService.getById(row.id);
    try {
      const result = await CloudAdminSyncService.pushTransaction(txn);
      console.log('  pushed', row.slip_number, row.truck_number, result);
      ok += 1;
    } catch (err) {
      console.error('  FAILED', row.slip_number, err.message);
      failed += 1;
    }
  }

  console.log(`Done. ok=${ok} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
