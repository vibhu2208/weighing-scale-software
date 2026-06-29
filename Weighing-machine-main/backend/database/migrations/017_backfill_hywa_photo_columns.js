'use strict';

/** Backfill HYWA photo columns cleared when camera_snapshots still reference files on disk. */
const id = '017_backfill_hywa_photo_columns';

function parseSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function isHywaType(vehicleType) {
  return String(vehicleType || '').trim().toLowerCase() === 'hywa';
}

function pathLooksLikePass(filePath, passLabel) {
  if (!filePath) return false;
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/');
  if (passLabel === 'departure') return /departure[-_]/.test(normalized);
  return /arrival[-_]/.test(normalized);
}

function pickPassPath(candidates, passLabel) {
  const withPath = (candidates || []).filter(Boolean);
  if (!withPath.length) return null;
  const matching = withPath.filter((p) => pathLooksLikePass(p, passLabel));
  return matching[0] || withPath[0];
}

function snapPathForSlot(snaps, slot) {
  const list = snaps || [];
  const camId = `cam-${slot}`;
  const match = list.find((s) => s.id === camId);
  if (match?.path) return match.path;
  return list[slot - 1]?.path || null;
}

function resolveSlot(row, snaps, passLabel, slot) {
  const col = row[`${passLabel}_photo_${slot}`];
  const fromGross = snapPathForSlot(snaps.gross, slot);
  const fromTare = snapPathForSlot(snaps.tare, slot);
  const fromPassSnaps = passLabel === 'arrival' ? fromGross : fromTare;
  const legacy =
    passLabel === 'departure' && slot === 1 ? row.image_path : null;
  return pickPassPath([fromPassSnaps, col, legacy], passLabel) || col || null;
}

function up(db) {
  const rows = db
    .prepare(
      `SELECT t.id, t.arrival_photo_1, t.arrival_photo_2, t.arrival_photo_3,
              t.departure_photo_1, t.departure_photo_2, t.departure_photo_3,
              t.image_path, t.camera_snapshots, v.vehicle_type
       FROM transactions t
       LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number`,
    )
    .all();

  const update = db.prepare(`
    UPDATE transactions SET
      arrival_photo_1 = ?,
      arrival_photo_2 = ?,
      arrival_photo_3 = ?,
      departure_photo_1 = ?,
      departure_photo_2 = ?,
      departure_photo_3 = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const row of rows) {
    if (!isHywaType(row.vehicle_type)) continue;

    const snaps = parseSnapshots(row.camera_snapshots);
    const arrival = [1, 2, 3].map((slot) => resolveSlot(row, snaps, 'arrival', slot));
    const departure = [1, 2, 3].map((slot) => resolveSlot(row, snaps, 'departure', slot));

    const needsFix =
      (!row.arrival_photo_1 && arrival[0]) ||
      (!row.arrival_photo_2 && arrival[1]) ||
      (!row.arrival_photo_3 && arrival[2]) ||
      (!row.departure_photo_1 && departure[0]) ||
      (!row.departure_photo_2 && departure[1]) ||
      (!row.departure_photo_3 && departure[2]) ||
      (row.arrival_photo_1 && !pathLooksLikePass(row.arrival_photo_1, 'arrival') && arrival[0]) ||
      (row.departure_photo_1 &&
        !pathLooksLikePass(row.departure_photo_1, 'departure') &&
        departure[0]);

    if (!needsFix) continue;

    update.run(
      arrival[0] || row.arrival_photo_1 || null,
      arrival[1] || row.arrival_photo_2 || null,
      arrival[2] || row.arrival_photo_3 || null,
      departure[0] || row.departure_photo_1 || null,
      departure[1] || row.departure_photo_2 || null,
      departure[2] || row.departure_photo_3 || null,
      row.id,
    );
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
