'use strict';

/** Ensure closed tickets have departure_photo_* populated from camera_snapshots gross. */
const id = '010_repair_departure_photos';

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

function up(db) {
  const rows = db
    .prepare(
      `SELECT id, camera_snapshots, image_path, tare_image_path,
              ticket_status, gross_weight, tare_weight,
              arrival_photo_1, arrival_photo_2, arrival_photo_3,
              departure_photo_1, departure_photo_2, departure_photo_3
       FROM transactions`,
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
    const closed =
      row.ticket_status === 'CLOSED' ||
      (row.gross_weight != null && row.tare_weight != null);
    if (!closed) continue;

    const vehicle = db
      .prepare(
        `SELECT vehicle_type FROM vehicles
         WHERE vehicle_number = (SELECT truck_number FROM transactions WHERE id = ?)
         LIMIT 1`,
      )
      .get(row.id);
    if (String(vehicle?.vehicle_type || '').trim().toLowerCase() === 'hywa') {
      continue;
    }

    const snaps = parseSnapshots(row.camera_snapshots);
    let grossPaths = pathsFromSnaps(snaps.gross);

    if (!grossPaths.length && row.image_path) {
      grossPaths = [row.image_path];
    }

    if (!grossPaths.length) continue;

    const current = [row.departure_photo_1, row.departure_photo_2, row.departure_photo_3];
    const missing = current.every((p) => !p);
    const sameAsArrival =
      row.departure_photo_1 &&
      row.departure_photo_1 === row.arrival_photo_1 &&
      row.departure_photo_2 === row.arrival_photo_2 &&
      row.departure_photo_3 === row.arrival_photo_3;

    if (!missing && !sameAsArrival) continue;

    update.run(
      grossPaths[0] || row.departure_photo_1 || null,
      grossPaths[1] || row.departure_photo_2 || null,
      grossPaths[2] || row.departure_photo_3 || null,
      row.id,
    );
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
