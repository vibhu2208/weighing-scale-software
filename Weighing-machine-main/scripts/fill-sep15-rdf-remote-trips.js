'use strict';

/**
 * Fill the three free planned slips dated 15 Sep 2026 with RDF remote trips.
 *
 *   node scripts/fill-sep15-rdf-remote-trips.js
 *
 * Uses held (or scheduled/missed) slip_reservations on 15 Sep 2026 IST only.
 * Does not allocate a new slip at the end of the series.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../admin-api/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');
const { createRemoteTrip } = require('../admin-api/src/services/remoteTripService');

function stripSsl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

const DAY_START_IST = '2026-09-14T18:30:00.000Z';
const DAY_END_IST = '2026-09-15T18:30:00.000Z';
const HOUR_MS = 60 * 60 * 1000;

const TRIPS = [
  { truck_number: 'HR65A7668', tare_weight: 15530, gross_weight: 60260 },
  { truck_number: 'HR58E3515', tare_weight: 14850, gross_weight: 57410 },
  { truck_number: 'HR58D8715', tare_weight: 15390, gross_weight: 62300 },
];

const SHARED = {
  customer_name: 'JITENDER',
  destination: 'MUZAFFAR NAGAR',
  material: 'RDF',
  vehicle_type: 'HYWA',
};

async function pickOperator(query) {
  const siteId = (process.env.SITE_ID || 'WB - 03').trim();
  const res = await query(
    `SELECT value FROM site_settings
     WHERE key = 'operators_list' AND site_id = $1
     LIMIT 1`,
    [siteId],
  );
  let list = [];
  try {
    const parsed = JSON.parse(res.rows[0]?.value || '[]');
    if (Array.isArray(parsed)) list = parsed.map((s) => String(s).trim()).filter(Boolean);
  } catch {
    list = String(res.rows[0]?.value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const preferred = list.find((n) => /^(SHUBHAM|PARDEEP|SUNNY)$/i.test(n));
  return preferred || list[0] || 'SHUBHAM';
}

async function fireReservation(pool, id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM slip_reservations
       WHERE id = $1 AND status IN ('scheduled', 'missed')
       FOR UPDATE`,
      [id],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      throw new Error(`Reservation ${id} is not scheduled/missed`);
    }
    const slipRes = await client.query('SELECT next_slip_number() AS slip');
    const slip = slipRes.rows[0]?.slip;
    if (!slip) throw new Error('Failed to allocate slip number');
    const upd = await client.query(
      `UPDATE slip_reservations
       SET slip_number = $2,
           status = 'held',
           blocked_at = now(),
           fire_error = NULL
       WHERE id = $1
       RETURNING *`,
      [id, slip],
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const databaseUrl = (process.env.DATABASE_URL || process.env.PG_SYNC_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL / PG_SYNC_URL required');

  const pool = new Pool({
    connectionString: stripSsl(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  const query = (text, params) => pool.query(text, params);

  try {
    await query('SELECT 1');

    const reserved = await query(
      `SELECT id, slip_number, planned_at, status, note, remote_trip_id
       FROM slip_reservations
       WHERE planned_at >= $1 AND planned_at < $2
         AND status IN ('held', 'scheduled', 'missed')
       ORDER BY planned_at ASC`,
      [DAY_START_IST, DAY_END_IST],
    );

    console.log(
      `Found ${reserved.rows.length} unused planned gap(s) on 15 Sep 2026:`,
      reserved.rows.map((r) => ({
        slip: r.slip_number,
        status: r.status,
        planned_at: r.planned_at,
      })),
    );

    if (reserved.rows.length < TRIPS.length) {
      throw new Error(
        `Need ${TRIPS.length} free planned slips on 15 Sep 2026, found ${reserved.rows.length}`,
      );
    }

    const operatorName = await pickOperator(query);
    const created = [];

    for (let i = 0; i < TRIPS.length; i += 1) {
      let gap = reserved.rows[i];
      if (gap.status !== 'held' || !gap.slip_number) {
        console.log(`Blocking gap ${gap.id} (was ${gap.status})…`);
        gap = await fireReservation(pool, gap.id);
        console.log(`  held as ${gap.slip_number}`);
      }

      const taken = await query(
        `SELECT slip_number, truck_number FROM remote_trips
         WHERE UPPER(slip_number) = $1 LIMIT 1`,
        [String(gap.slip_number).toUpperCase()],
      );
      if (taken.rows[0]) {
        throw new Error(
          `Planned slip ${gap.slip_number} already has a remote trip (${taken.rows[0].truck_number})`,
        );
      }

      const trip = TRIPS[i];
      const planned = new Date(gap.planned_at);
      const payload = {
        reservation_id: gap.id,
        truck_number: trip.truck_number,
        customer_name: SHARED.customer_name,
        destination: SHARED.destination,
        material: SHARED.material,
        operator_name: operatorName,
        vehicle_type: SHARED.vehicle_type,
        tare_weight: trip.tare_weight,
        gross_weight: trip.gross_weight,
        timestamp_in: planned.toISOString(),
        timestamp_out: new Date(planned.getTime() + HOUR_MS).toISOString(),
      };

      const row = await createRemoteTrip(query, payload);
      created.push({
        slip: row.slip_number,
        truck: row.truck_number,
        material: row.material,
        customer: row.customer_name,
        destination: row.destination,
        tare: row.tare_weight,
        gross: row.gross_weight,
        net: row.net_weight,
        in: row.timestamp_in,
        out: row.timestamp_out,
      });
      console.log(
        `OK ${row.slip_number} ${row.truck_number} RDF tare=${row.tare_weight} gross=${row.gross_weight} net=${row.net_weight}`,
      );
    }

    console.log('\n=== Created ===');
    console.log(JSON.stringify(created, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
