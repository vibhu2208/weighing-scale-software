'use strict';

/**
 * Clear tare weight + tare images on WB2582 and reopen the ticket.
 *
 * Run ON the weighbridge PC (local SQLite + PG_SYNC_URL):
 *
 *   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/clear-wb2582-tare.js
 *
 * Also clears RDS mirror + remote_trips so admin Reports do not keep old arrival/departure keys
 * (routine sync COALESCE would otherwise preserve them).
 */
const path = require('path');
const fs = require('fs');

const SLIP = 'WB2582';
const SITE_IDS = ['WB - 03', 'WB-03'];

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
  const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
  const AdminReportService = require('../backend/services/AdminReportService');
  const pg = require('../backend/database/pg');

  initDatabase();
  const db = getDb();
  const before = db
    .prepare(
      `SELECT t.id, t.slip_number, t.truck_number, t.ticket_status, v.vehicle_type,
              t.gross_weight, t.tare_weight, t.tare_image_path,
              t.arrival_photo_1, t.arrival_photo_2, t.arrival_photo_3,
              t.departure_photo_1, t.departure_photo_2, t.departure_photo_3
       FROM transactions t
       LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number
       WHERE t.slip_number = ?`,
    )
    .get(SLIP);

  if (!before) {
    throw new Error(`${SLIP} not found in local SQLite`);
  }
  console.log('Before local:', before);
  if (before.tare_weight == null) {
    throw new Error(`${SLIP} has no tare_weight to clear`);
  }

  const result = await AdminReportService.applyRemoteUpdate({
    slipNumber: SLIP,
    clear_tare: true,
    remote: true,
  });
  console.log('Local clear result:', {
    ok: result.ok,
    clearedTare: result.clearedTare,
    slip: result.slip_number,
    status: result.transaction?.ticket_status,
    tare: result.transaction?.tare_weight,
    gross: result.transaction?.gross_weight,
  });

  const after = db
    .prepare(
      `SELECT slip_number, ticket_status, gross_weight, tare_weight, tare_image_path,
              arrival_photo_1, departure_photo_1, camera_snapshots
       FROM transactions WHERE slip_number = ?`,
    )
    .get(SLIP);
  console.log('After local:', after);

  if (!pg.isConfigured() || !(await pg.ping())) {
    console.warn('PG unavailable — local clear done; mirror not updated');
    closeDatabase();
    return;
  }

  const hywa = String(before.vehicle_type || '').trim().toLowerCase() === 'hywa';
  const client = await pg.getDedicatedClient();
  try {
    await client.query('BEGIN');
    for (const siteId of SITE_IDS) {
      const photoClears = hywa
        ? `departure_photo_1 = NULL, departure_photo_2 = NULL, departure_photo_3 = NULL`
        : `arrival_photo_1 = NULL, arrival_photo_2 = NULL, arrival_photo_3 = NULL`;
      const upd = await client.query(
        `UPDATE transactions_mirror
         SET tare_weight = NULL,
             ticket_status = 'OPEN',
             timestamp_out = NULL,
             ${photoClears},
             updated_at = now()
         WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)
         RETURNING site_id, slip_number, ticket_status, tare_weight, gross_weight,
                   arrival_photo_1, departure_photo_1`,
        [siteId, SLIP],
      );
      if (upd.rows[0]) console.log('Mirror updated', upd.rows[0]);
    }

    const rtPhotoClears = hywa
      ? `departure_photo_1 = NULL, departure_photo_2 = NULL, departure_photo_3 = NULL`
      : `arrival_photo_1 = NULL, arrival_photo_2 = NULL, arrival_photo_3 = NULL`;
    const rt = await client.query(
      `UPDATE remote_trips
       SET tare_weight = NULL,
           ticket_status = 'OPEN',
           timestamp_out = NULL,
           ${rtPhotoClears},
           updated_at = now()
       WHERE UPPER(slip_number) = UPPER($1)
       RETURNING id, slip_number, ticket_status, tare_weight, gross_weight`,
      [SLIP],
    );
    if (rt.rows[0]) console.log('remote_trips updated', rt.rows[0]);
    else console.log('No remote_trips row for', SLIP);

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_e) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }

  await pg.closePool();
  closeDatabase();
  console.log(
    `\nDone. ${SLIP} tare weight + tare images cleared; ticket reopened for a fresh close weigh.`,
  );
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
