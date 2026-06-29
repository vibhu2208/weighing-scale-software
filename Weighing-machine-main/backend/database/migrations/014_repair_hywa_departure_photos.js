'use strict';

/** HYWA stores open photos in gross/arrival; departure must be tare-only. Repair bad backfills from 007/010. */
const id = '014_repair_hywa_departure_photos';

function parseSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function pathsFromSnaps(snaps) {
  return (snaps || []).map((s) => s.path).filter(Boolean);
}

function isHywaType(vehicleType) {
  return String(vehicleType || '').trim().toLowerCase() === 'hywa';
}

function isOpenHywa(row) {
  if (row.ticket_status === 'OPEN') return true;
  return row.gross_weight != null && row.tare_weight == null;
}

function departureMatchesArrival(row) {
  return (
    row.departure_photo_1 &&
    row.departure_photo_1 === row.arrival_photo_1 &&
    row.departure_photo_2 === row.arrival_photo_2 &&
    row.departure_photo_3 === row.arrival_photo_3
  );
}

function up(db) {
  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_status, t.gross_weight, t.tare_weight,
              t.arrival_photo_1, t.arrival_photo_2, t.arrival_photo_3,
              t.departure_photo_1, t.departure_photo_2, t.departure_photo_3,
              t.image_path, t.camera_snapshots, v.vehicle_type
       FROM transactions t
       LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number`,
    )
    .all();

  const update = db.prepare(`
    UPDATE transactions SET
      departure_photo_1 = ?,
      departure_photo_2 = ?,
      departure_photo_3 = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const row of rows) {
    if (!isHywaType(row.vehicle_type)) continue;

    const snaps = parseSnapshots(row.camera_snapshots);
    const tarePaths = pathsFromSnaps(snaps.tare);
    const hasDepartureCols =
      row.departure_photo_1 || row.departure_photo_2 || row.departure_photo_3;

    if (isOpenHywa(row)) {
      if (hasDepartureCols) {
        update.run(null, null, null, row.id);
      }
      continue;
    }

    const wrongDeparture = departureMatchesArrival(row);
    const missingDeparture = !row.departure_photo_1;

    if (tarePaths.length && (missingDeparture || wrongDeparture)) {
      update.run(
        tarePaths[0] || null,
        tarePaths[1] || null,
        tarePaths[2] || null,
        row.id,
      );
    } else if (wrongDeparture && !tarePaths.length) {
      const depPath =
        row.image_path && row.image_path !== row.arrival_photo_1 ? row.image_path : null;
      update.run(depPath, null, null, row.id);
    }
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
