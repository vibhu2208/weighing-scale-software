'use strict';
/**
 * Restore WB2754 mirror from remote_trips + pending edit tare, keep command pending for PC.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../admin-api/.env') });
const { Pool } = require('pg');

function stripSsl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

(async () => {
  const siteId = (process.env.SITE_ID || 'WB - 03').trim();
  const pool = new Pool({
    connectionString: stripSsl(process.env.DATABASE_URL),
    ssl: { rejectUnauthorized: false },
  });

  const remote = await pool.query(`SELECT * FROM remote_trips WHERE slip_number = 'WB2754' LIMIT 1`);
  const row = remote.rows[0];
  if (!row) throw new Error('remote WB2754 not found');

  const cmd = await pool.query(
    `SELECT payload FROM admin_commands
     WHERE site_id = $1 AND type = 'edit_report' AND status = 'pending'
       AND payload->>'slipNumber' = 'WB2754'
     ORDER BY created_at DESC LIMIT 1`,
    [siteId],
  );
  const edit = cmd.rows[0]?.payload || {};
  const tare = edit.tare_weight != null ? Number(edit.tare_weight) : row.tare_weight;
  const gross = edit.gross_weight != null ? Number(edit.gross_weight) : row.gross_weight;

  await pool.query(
    `INSERT INTO transactions_mirror (
      site_id, local_id, slip_number, truck_number, rfid_tag,
      customer_name, destination, material, operator_name, transporter, vehicle_type,
      gross_weight, tare_weight, timestamp_in, timestamp_out,
      ticket_status, sync_status, mcg_status,
      arrival_photo_1, arrival_photo_2, arrival_photo_3,
      departure_photo_1, departure_photo_2, departure_photo_3,
      report_s3_key, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      'CLOSED','SYNCED',$16,$17,$18,$19,$20,$21,$22,$23, now()
    )
    ON CONFLICT (site_id, slip_number) DO UPDATE SET
      local_id = EXCLUDED.local_id,
      tare_weight = EXCLUDED.tare_weight,
      gross_weight = EXCLUDED.gross_weight,
      customer_name = EXCLUDED.customer_name,
      destination = EXCLUDED.destination,
      material = EXCLUDED.material,
      operator_name = EXCLUDED.operator_name,
      timestamp_in = EXCLUDED.timestamp_in,
      timestamp_out = EXCLUDED.timestamp_out,
      updated_at = now()
    RETURNING slip_number, tare_weight, gross_weight`,
    [
      siteId,
      row.local_id || row.id,
      row.slip_number,
      row.truck_number,
      row.rfid_tag || null,
      edit.customer_name || row.customer_name,
      edit.destination || row.destination,
      edit.material || row.material,
      edit.operator_name || row.operator_name,
      row.transporter || null,
      row.vehicle_type || null,
      gross,
      tare,
      edit.timestamp_in || row.timestamp_in,
      edit.timestamp_out || row.timestamp_out,
      row.mcg_status || null,
      row.arrival_photo_1 || null,
      row.arrival_photo_2 || null,
      row.arrival_photo_3 || null,
      row.departure_photo_1 || null,
      row.departure_photo_2 || null,
      row.departure_photo_3 || null,
      row.report_s3_key || null,
    ],
  );

  const mirror = await pool.query(
    `SELECT slip_number, tare_weight, gross_weight, updated_at
     FROM transactions_mirror WHERE site_id = $1 AND slip_number = 'WB2754'`,
    [siteId],
  );
  console.log('restored', mirror.rows[0]);
  console.log('pending command still waiting for PC apply');
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
