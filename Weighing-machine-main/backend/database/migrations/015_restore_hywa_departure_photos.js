'use strict';

/** Restore HYWA close photos cleared by 014 when image_path or tare snapshots still hold them. */
const id = '015_restore_hywa_departure_photos';

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

function isClosedRow(row) {
  return (
    row.ticket_status === 'CLOSED' ||
    (row.gross_weight != null && row.tare_weight != null)
  );
}

function departureMatchesArrival(row) {
  return (
    row.departure_photo_1 &&
    row.departure_photo_1 === row.arrival_photo_1 &&
    row.departure_photo_2 === row.arrival_photo_2 &&
    row.departure_photo_3 === row.arrival_photo_3
  );
}

function pickDeparturePath(row, tarePaths) {
  if (tarePaths[0] && tarePaths[0] !== row.arrival_photo_1) {
    return {
      one: tarePaths[0] || null,
      two: tarePaths[1] || null,
      three: tarePaths[2] || null,
    };
  }
  if (
    row.image_path &&
    row.image_path !== row.arrival_photo_1 &&
    row.image_path !== row.departure_photo_1
  ) {
    return { one: row.image_path, two: null, three: null };
  }
  if (
    row.departure_photo_1 &&
    !departureMatchesArrival(row) &&
    row.departure_photo_1 !== row.arrival_photo_1
  ) {
    return {
      one: row.departure_photo_1,
      two: row.departure_photo_2 || null,
      three: row.departure_photo_3 || null,
    };
  }
  return null;
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
    if (!isHywaType(row.vehicle_type) || !isClosedRow(row)) continue;

    const snaps = parseSnapshots(row.camera_snapshots);
    const tarePaths = pathsFromSnaps(snaps.tare);
    const missingDeparture = !row.departure_photo_1;
    const wrongDeparture = departureMatchesArrival(row);

    if (!missingDeparture && !wrongDeparture) continue;

    const picked = pickDeparturePath(row, tarePaths);
    if (!picked) continue;

    update.run(picked.one, picked.two, picked.three, row.id);
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
