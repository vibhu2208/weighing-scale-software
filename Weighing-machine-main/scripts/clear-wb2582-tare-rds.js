'use strict';

/**
 * Clear WB2582 tare weight + tare images on RDS only (mirror + remote_trips)
 * and queue edit_report(clear_tare) for the weighbridge PC.
 *
 * Prefer scripts/clear-wb2582-tare.js on the PC when possible.
 *
 * Run from Weighing-machine-main with admin-api/.env DATABASE_URL set:
 *
 *   node scripts/clear-wb2582-tare-rds.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../admin-api/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const SLIP = 'WB2582';
const SITE_IDS = ['WB - 03', 'WB-03'];

function stripSsl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

(async () => {
  const databaseUrl = (process.env.DATABASE_URL || process.env.PG_SYNC_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL / PG_SYNC_URL required');

  const pool = new Pool({
    connectionString: stripSsl(databaseUrl),
    ssl: { rejectUnauthorized: false },
  });

  const before = await pool.query(
    `SELECT site_id, slip_number, truck_number, ticket_status, vehicle_type,
            gross_weight, tare_weight,
            arrival_photo_1, departure_photo_1
     FROM transactions_mirror
     WHERE UPPER(slip_number) = UPPER($1)
     ORDER BY updated_at DESC NULLS LAST`,
    [SLIP],
  );
  if (!before.rows.length) throw new Error(`${SLIP} not found in transactions_mirror`);
  console.log('Before mirror:', before.rows);

  const row = before.rows[0];
  if (row.tare_weight == null) throw new Error(`${SLIP} has no tare_weight to clear`);
  const hywa = String(row.vehicle_type || '').trim().toLowerCase() === 'hywa';
  const photoClears = hywa
    ? `departure_photo_1 = NULL, departure_photo_2 = NULL, departure_photo_3 = NULL`
    : `arrival_photo_1 = NULL, arrival_photo_2 = NULL, arrival_photo_3 = NULL`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const siteId of SITE_IDS) {
      const upd = await client.query(
        `UPDATE transactions_mirror
         SET tare_weight = NULL,
             ticket_status = 'OPEN',
             timestamp_out = NULL,
             ${photoClears},
             updated_at = now()
         WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)
         RETURNING site_id, slip_number, ticket_status, tare_weight, gross_weight`,
        [siteId, SLIP],
      );
      if (upd.rows[0]) console.log('Mirror updated', upd.rows[0]);
    }

    const rt = await client.query(
      `UPDATE remote_trips
       SET tare_weight = NULL,
           ticket_status = 'OPEN',
           timestamp_out = NULL,
           ${photoClears},
           updated_at = now()
       WHERE UPPER(slip_number) = UPPER($1)
       RETURNING id, slip_number, ticket_status, tare_weight, gross_weight`,
      [SLIP],
    );
    if (rt.rows[0]) console.log('remote_trips updated', rt.rows[0]);

    for (const siteId of SITE_IDS) {
      const cmd = await client.query(
        `INSERT INTO admin_commands (site_id, type, payload, status, created_by)
         VALUES ($1, 'edit_report', $2::jsonb, 'pending', $3)
         RETURNING id, site_id, type, status`,
        [
          siteId,
          JSON.stringify({ slipNumber: SLIP, clear_tare: true }),
          'clear-wb2582-tare-rds.js',
        ],
      );
      console.log('Queued command', cmd.rows[0]);
    }

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

  await pool.end();
  console.log(
    `\nDone. ${SLIP} cloud tare cleared; pending edit_report(clear_tare) waits for PC (needs this code pull).`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
