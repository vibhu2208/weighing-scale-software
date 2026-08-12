'use strict';

/**
 * Backfill transactions_mirror from remote_trips that synced to local
 * but never appeared in admin Reports.
 *
 * Usage: node scripts/backfill-remote-to-mirror.js [slip...]
 * Default: recent synced remotes missing from mirror for SITE_ID.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../admin-api/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

function stripSsl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

async function main() {
  const databaseUrl = (process.env.DATABASE_URL || process.env.PG_SYNC_URL || '').trim();
  const siteId = (process.env.SITE_ID || process.env.WEIGHBRIDGE_ID || 'WB - 03').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL / PG_SYNC_URL required');

  const pool = new Pool({
    connectionString: stripSsl(databaseUrl),
    ssl: { rejectUnauthorized: false },
  });

  const slips = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);

  const remoteRes = slips.length
    ? await pool.query(
        `SELECT * FROM remote_trips
         WHERE UPPER(slip_number) = ANY($1::text[])
         ORDER BY created_at ASC`,
        [slips],
      )
    : await pool.query(
        `SELECT rt.*
         FROM remote_trips rt
         WHERE rt.synced_to_local = true
           AND rt.local_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM transactions_mirror m
             WHERE m.site_id = $1 AND m.slip_number = rt.slip_number
           )
         ORDER BY rt.created_at DESC
         LIMIT 50`,
        [siteId],
      );

  console.log('siteId=', JSON.stringify(siteId), 'candidates=', remoteRes.rows.length);

  let upserted = 0;
  for (const row of remoteRes.rows) {
    const localId = row.local_id || row.id;
    const result = await pool.query(
      `INSERT INTO transactions_mirror (
        site_id, local_id, slip_number, truck_number, rfid_tag,
        customer_name, destination, material, operator_name, transporter, vehicle_type,
        gross_weight, tare_weight, timestamp_in, timestamp_out,
        ticket_status, sync_status, mcg_status, mcg_error,
        arrival_photo_1, arrival_photo_2, arrival_photo_3,
        departure_photo_1, departure_photo_2, departure_photo_3,
        report_s3_key, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        'CLOSED',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now()
      )
      ON CONFLICT (site_id, slip_number) DO UPDATE SET
        local_id = EXCLUDED.local_id,
        truck_number = EXCLUDED.truck_number,
        rfid_tag = EXCLUDED.rfid_tag,
        customer_name = EXCLUDED.customer_name,
        destination = EXCLUDED.destination,
        material = EXCLUDED.material,
        operator_name = EXCLUDED.operator_name,
        transporter = EXCLUDED.transporter,
        vehicle_type = EXCLUDED.vehicle_type,
        gross_weight = EXCLUDED.gross_weight,
        tare_weight = EXCLUDED.tare_weight,
        timestamp_in = EXCLUDED.timestamp_in,
        timestamp_out = EXCLUDED.timestamp_out,
        ticket_status = 'CLOSED',
        sync_status = EXCLUDED.sync_status,
        mcg_status = EXCLUDED.mcg_status,
        mcg_error = EXCLUDED.mcg_error,
        arrival_photo_1 = COALESCE(EXCLUDED.arrival_photo_1, transactions_mirror.arrival_photo_1),
        arrival_photo_2 = COALESCE(EXCLUDED.arrival_photo_2, transactions_mirror.arrival_photo_2),
        arrival_photo_3 = COALESCE(EXCLUDED.arrival_photo_3, transactions_mirror.arrival_photo_3),
        departure_photo_1 = COALESCE(EXCLUDED.departure_photo_1, transactions_mirror.departure_photo_1),
        departure_photo_2 = COALESCE(EXCLUDED.departure_photo_2, transactions_mirror.departure_photo_2),
        departure_photo_3 = COALESCE(EXCLUDED.departure_photo_3, transactions_mirror.departure_photo_3),
        report_s3_key = COALESCE(EXCLUDED.report_s3_key, transactions_mirror.report_s3_key),
        updated_at = now()
      RETURNING slip_number`,
      [
        siteId,
        localId,
        row.slip_number,
        row.truck_number,
        row.rfid_tag || null,
        row.customer_name || null,
        row.destination || null,
        row.material || null,
        row.operator_name || null,
        row.transporter || null,
        row.vehicle_type || null,
        row.gross_weight,
        row.tare_weight,
        row.timestamp_in || null,
        row.timestamp_out || null,
        row.sync_status || 'SYNCED',
        row.mcg_status || null,
        row.mcg_error || null,
        row.arrival_photo_1 || null,
        row.arrival_photo_2 || null,
        row.arrival_photo_3 || null,
        row.departure_photo_1 || null,
        row.departure_photo_2 || null,
        row.departure_photo_3 || null,
        row.report_s3_key || null,
      ],
    );
    upserted += 1;
    console.log('upserted', result.rows[0].slip_number, 'local_id=', localId);
  }

  console.log('done upserted=', upserted);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
