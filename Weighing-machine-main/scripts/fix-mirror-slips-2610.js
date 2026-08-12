'use strict';

const path = require('path');
const fs = require('fs');

const PAIRS = [
  ['WB2610', 'WB2666'],
  ['WB2612', 'WB2664'],
  ['WB2613', 'WB2665'],
  ['WB2616', 'WB2626'],
  ['WB2619', 'WB2625'],
  ['WB2622', 'WB2630'],
];

function loadEnvFile(filePath, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (overwrite || !process.env[key]) process.env[key] = val;
  }
}

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
  const { initDatabase, closeDatabase } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const CloudAdminSyncService = require('../backend/services/CloudAdminSyncService');

  initDatabase();
  if (!pg.isConfigured() || !(await pg.ping())) throw new Error('PG unavailable');

  const slips = PAIRS.flat();
  const existing = await pg.query(
    `SELECT site_id, local_id, slip_number, truck_number
     FROM transactions_mirror
     WHERE slip_number = ANY($1::text[])
     ORDER BY slip_number`,
    [slips],
  );
  console.log('mirror by slip:', existing.rows);

  const ids = slips
    .map((s) => TransactionService.getBySlipNumber(s)?.id)
    .filter(Boolean);
  const byLocal = await pg.query(
    `SELECT site_id, local_id, slip_number, truck_number
     FROM transactions_mirror
     WHERE local_id = ANY($1::text[])
     ORDER BY slip_number`,
    [ids],
  );
  console.log('mirror by local_id:', byLocal.rows);

  if (!existing.rows.length && !byLocal.rows.length) {
    console.log('No mirror rows — pushing swapped tickets');
    for (const slip of slips) {
      const txn = TransactionService.getBySlipNumber(slip);
      const push = await CloudAdminSyncService.pushTransaction(txn);
      console.log('pushed', slip, txn.truck_number, push);
    }
  } else {
    for (const [oldA, oldB] of PAIRS) {
      const ticketNowB = TransactionService.getBySlipNumber(oldB);
      const ticketNowA = TransactionService.getBySlipNumber(oldA);
      const stamp = `${Date.now()}${Math.floor(Math.random() * 90 + 10)}`;
      await pg.query(
        `UPDATE transactions_mirror SET slip_number = $2, updated_at = now()
         WHERE local_id = $1`,
        [ticketNowB.id, `ZZML${stamp}`],
      );
      await pg.query(
        `UPDATE transactions_mirror SET slip_number = $2, updated_at = now()
         WHERE local_id = $1`,
        [ticketNowA.id, `ZZMR${stamp}`],
      );
      await pg.query(
        `UPDATE transactions_mirror SET slip_number = $2, updated_at = now()
         WHERE local_id = $1`,
        [ticketNowB.id, oldB],
      );
      await pg.query(
        `UPDATE transactions_mirror SET slip_number = $2, updated_at = now()
         WHERE local_id = $1`,
        [ticketNowA.id, oldA],
      );
      console.log(`mirror local_id swap done ${oldA} <-> ${oldB}`);
    }
  }

  const after = await pg.query(
    `SELECT slip_number, truck_number, local_id
     FROM transactions_mirror
     WHERE slip_number = ANY($1::text[])
     ORDER BY slip_number`,
    [slips],
  );
  console.log('AFTER mirror:', after.rows);

  await pg.closePool();
  closeDatabase();
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
