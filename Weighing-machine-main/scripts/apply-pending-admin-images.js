'use strict';

/**
 * Apply pending admin edit commands, including uploaded photos, onto local tickets.
 * Run: npx electron scripts/apply-pending-admin-images.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

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

app.on('window-all-closed', () => {
  /* Keep the process alive while PDFs regenerate. */
});

app.whenReady().then(async () => {
  try {
    const { initPackagedStorage } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

    const { initDatabase, closeDatabase } = require('../backend/database/db');
    const pg = require('../backend/database/pg');
    const TransactionService = require('../backend/services/TransactionService');
    const AdminReportService = require('../backend/services/AdminReportService');
    const SettingsService = require('../backend/services/SettingsService');
    const { siteIdAliases } = require('../backend/utils/siteId');

    initDatabase();
    if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
    if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

    const siteId =
      process.env.WEIGHBRIDGE_ID || SettingsService.get('WEIGHBRIDGE_ID') || 'WB-03';
    const aliases = siteIdAliases(siteId);
    console.log('Site aliases:', aliases.join(', '));

    const pending = await pg.query(
      `SELECT id, site_id, type, payload, created_at
       FROM admin_commands
       WHERE site_id = ANY($1::text[]) AND status = 'pending'
       ORDER BY created_at ASC`,
      [aliases],
    );
    console.log(`Pending admin commands: ${pending.rows.length}`);

    const results = [];
    const applied = [];
    for (const row of pending.rows) {
      const payload =
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
      const slip = payload.slipNumber || payload.slip_number || '';
      const photos = Array.isArray(payload.photoS3Keys) ? payload.photoS3Keys.length : 0;
      console.log(`\n=== ${slip} ${row.type} photos=${photos} ===`);
      try {
        if (row.type === 'edit_report') {
          await AdminReportService.applyRemoteUpdate(payload);
        } else if (row.type === 'delete_report') {
          await AdminReportService.applyRemoteDelete(payload);
        } else {
          throw new Error(`Unknown command type: ${row.type}`);
        }
        await pg.query(
          `UPDATE admin_commands
           SET status = 'applied', error = NULL, applied_at = now()
           WHERE id = $1`,
          [row.id],
        );
        console.log(`Applied ${slip} locally`);
        results.push({ slip, type: row.type, photos, status: 'applied' });
        if (row.type === 'edit_report') {
          applied.push({ slip, photoS3Keys: payload.photoS3Keys || [] });
        }
      } catch (err) {
        await pg.query(
          `UPDATE admin_commands SET status = 'failed', error = $2 WHERE id = $1`,
          [row.id, err.message],
        );
        console.error(`FAILED ${slip}: ${err.message}`);
        results.push({ slip, type: row.type, photos, status: 'failed', error: err.message });
      }
    }

    for (const item of applied) {
      const txn = TransactionService.getBySlipNumber(item.slip);
      if (!txn) continue;
      const photo = {};
      for (const entry of item.photoS3Keys) {
        const slot = Number(entry.slot);
        const key = entry.key || entry.s3Key;
        const pass = entry.pass === 'arrival' ? 'arrival' : 'departure';
        if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
        photo[`${pass}_photo_${slot}`] = key;
      }
      try {
        await pg.query(
          `INSERT INTO transactions_mirror (
             site_id, local_id, slip_number, truck_number, rfid_tag,
             customer_name, destination, material, operator_name, transporter, vehicle_type,
             gross_weight, tare_weight, timestamp_in, timestamp_out,
             ticket_status, sync_status, mcg_status, mcg_error,
             arrival_photo_1, arrival_photo_2, arrival_photo_3,
             departure_photo_1, departure_photo_2, departure_photo_3,
             updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,$25, now()
           )
           ON CONFLICT (site_id, local_id) DO UPDATE SET
             slip_number = EXCLUDED.slip_number,
             truck_number = EXCLUDED.truck_number,
             customer_name = EXCLUDED.customer_name,
             destination = EXCLUDED.destination,
             material = EXCLUDED.material,
             operator_name = EXCLUDED.operator_name,
             gross_weight = EXCLUDED.gross_weight,
             tare_weight = EXCLUDED.tare_weight,
             timestamp_in = EXCLUDED.timestamp_in,
             timestamp_out = EXCLUDED.timestamp_out,
             ticket_status = EXCLUDED.ticket_status,
             arrival_photo_1 = COALESCE(EXCLUDED.arrival_photo_1, transactions_mirror.arrival_photo_1),
             arrival_photo_2 = COALESCE(EXCLUDED.arrival_photo_2, transactions_mirror.arrival_photo_2),
             arrival_photo_3 = COALESCE(EXCLUDED.arrival_photo_3, transactions_mirror.arrival_photo_3),
             departure_photo_1 = COALESCE(EXCLUDED.departure_photo_1, transactions_mirror.departure_photo_1),
             departure_photo_2 = COALESCE(EXCLUDED.departure_photo_2, transactions_mirror.departure_photo_2),
             departure_photo_3 = COALESCE(EXCLUDED.departure_photo_3, transactions_mirror.departure_photo_3),
             updated_at = now()`,
          [
            siteId,
            txn.id,
            txn.slip_number,
            txn.truck_number,
            txn.rfid_tag || null,
            txn.customer_name || null,
            txn.destination || null,
            txn.material || null,
            txn.operator_name || null,
            txn.vehicle?.transporter || txn.transporter || null,
            txn.vehicle?.vehicle_type || txn.vehicle_type || null,
            txn.gross_weight,
            txn.tare_weight,
            txn.timestamp_in || null,
            txn.timestamp_out || null,
            txn.ticket_status,
            txn.sync_status || null,
            txn.mcg_status || null,
            txn.mcg_error || null,
            photo.arrival_photo_1 || null,
            photo.arrival_photo_2 || null,
            photo.arrival_photo_3 || null,
            photo.departure_photo_1 || null,
            photo.departure_photo_2 || null,
            photo.departure_photo_3 || null,
          ],
        );
        console.log(`Mirror updated ${item.slip}`);
      } catch (pushErr) {
        console.warn(`Mirror update skipped ${item.slip}: ${pushErr.message}`);
      }
    }

    console.log('\n=== RESULTS ===');
    for (const row of results) {
      console.log(
        `${row.slip} | ${row.type} | photos=${row.photos} | ${row.status}${
          row.error ? ` | ${row.error}` : ''
        }`,
      );
    }

    const still = await pg.query(
      `SELECT COALESCE(payload->>'slipNumber', payload->>'slip_number') AS slip, status, error
       FROM admin_commands
       WHERE site_id = ANY($1::text[]) AND status IN ('pending', 'failed')
       ORDER BY created_at ASC`,
      [aliases],
    );
    console.log('Still pending or failed:', JSON.stringify(still.rows));

    await pg.closePool();
    closeDatabase();
    app.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
