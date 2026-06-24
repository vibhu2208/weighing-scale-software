'use strict';

/** Backfill arrival_photo_* / departure_photo_* from camera_snapshots JSON. */
const id = '009_sync_trip_photo_columns';

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
      `SELECT id, camera_snapshots, tare_image_path, image_path,
              tare_weight, gross_weight, ticket_status,
              arrival_photo_1, departure_photo_1
       FROM transactions`,
    )
    .all();

  const update = db.prepare(`
    UPDATE transactions SET
      arrival_photo_1 = COALESCE(?, arrival_photo_1),
      arrival_photo_2 = COALESCE(?, arrival_photo_2),
      arrival_photo_3 = COALESCE(?, arrival_photo_3),
      departure_photo_1 = COALESCE(?, departure_photo_1),
      departure_photo_2 = COALESCE(?, departure_photo_2),
      departure_photo_3 = COALESCE(?, departure_photo_3),
      updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const row of rows) {
    const snaps = parseSnapshots(row.camera_snapshots);
    let tarePaths = pathsFromSnaps(snaps.tare);
    let grossPaths = pathsFromSnaps(snaps.gross);

    if (!tarePaths.length && row.tare_image_path) {
      tarePaths = [row.tare_image_path];
    }

    const closed =
      row.ticket_status === 'CLOSED' ||
      (row.gross_weight != null && row.tare_weight != null);

    if (!grossPaths.length && closed && row.image_path) {
      const arrivalSet = new Set([
        row.arrival_photo_1,
        row.tare_image_path,
        ...tarePaths,
      ].filter(Boolean));
      if (!arrivalSet.has(row.image_path)) {
        grossPaths = [row.image_path];
      }
    }

    const needsArrival = !row.arrival_photo_1 && tarePaths.length;
    const needsDeparture = !row.departure_photo_1 && grossPaths.length && closed;

    if (!needsArrival && !needsDeparture) continue;

    update.run(
      needsArrival ? tarePaths[0] || null : null,
      needsArrival ? tarePaths[1] || null : null,
      needsArrival ? tarePaths[2] || null : null,
      needsDeparture ? grossPaths[0] || null : null,
      needsDeparture ? grossPaths[1] || null : null,
      needsDeparture ? grossPaths[2] || null : null,
      row.id,
    );
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
