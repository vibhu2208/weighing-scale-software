'use strict';

/**
 * Repair HYWA photo columns + camera_snapshots from filenames.
 * Safe to run on every startup (idempotent) — classifies paths by arrival/departure in the name.
 */
const id = '016_fix_hywa_swapped_photos';

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

function isOpenHywa(row) {
  if (row.ticket_status === 'OPEN') return true;
  return row.gross_weight != null && row.tare_weight == null;
}

function pathLooksLikePass(filePath, passLabel) {
  if (!filePath) return false;
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/');
  if (passLabel === 'departure') return /departure[-_]/.test(normalized);
  return /arrival[-_]/.test(normalized);
}

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of paths) {
    if (!raw) continue;
    const key = String(raw).toLowerCase().replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Collect every known path for this ticket. */
function allPhotoPaths(row, snaps) {
  const paths = [];
  for (let slot = 1; slot <= 3; slot += 1) {
    paths.push(row[`arrival_photo_${slot}`], row[`departure_photo_${slot}`]);
  }
  paths.push(row.image_path, row.tare_image_path);
  for (const bucket of ['gross', 'tare']) {
    for (const snap of snaps[bucket] || []) {
      paths.push(snap?.path);
    }
  }
  return uniquePaths(paths);
}

function classifyPaths(row, snaps) {
  const all = allPhotoPaths(row, snaps);
  const arrival = all.filter((p) => pathLooksLikePass(p, 'arrival'));
  const departure = all.filter((p) => pathLooksLikePass(p, 'departure'));
  return { arrival, departure };
}

function snapsFromPaths(paths) {
  return paths
    .filter(Boolean)
    .slice(0, 3)
    .map((filePath, index) => ({
      id: `cam-${index + 1}`,
      label: `Camera ${index + 1}`,
      path: filePath,
    }));
}

function up(db) {
  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_status, t.gross_weight, t.tare_weight,
              t.arrival_photo_1, t.arrival_photo_2, t.arrival_photo_3,
              t.departure_photo_1, t.departure_photo_2, t.departure_photo_3,
              t.image_path, t.tare_image_path, t.camera_snapshots, v.vehicle_type
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
      camera_snapshots = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const row of rows) {
    if (!isHywaType(row.vehicle_type)) continue;

    const snaps = parseSnapshots(row.camera_snapshots);
    const { arrival, departure } = classifyPaths(row, snaps);
    if (!arrival.length && !departure.length) continue;

    const open = isOpenHywa(row);
    const nextArrival = [arrival[0] || null, arrival[1] || null, arrival[2] || null];
    const nextDeparture = open
      ? [null, null, null]
      : [departure[0] || null, departure[1] || null, departure[2] || null];

    const grossSnaps = snapsFromPaths(arrival);
    const tareSnaps = open ? [] : snapsFromPaths(departure);
    const nextSnaps = JSON.stringify({ gross: grossSnaps, tare: tareSnaps });

    const colsWrong =
      nextArrival[0] !== row.arrival_photo_1 ||
      nextArrival[1] !== row.arrival_photo_2 ||
      nextArrival[2] !== row.arrival_photo_3 ||
      nextDeparture[0] !== row.departure_photo_1 ||
      nextDeparture[1] !== row.departure_photo_2 ||
      nextDeparture[2] !== row.departure_photo_3;

    const snapsWrong = nextSnaps !== (row.camera_snapshots || '');
    const swapped =
      pathLooksLikePass(row.arrival_photo_1, 'departure') ||
      pathLooksLikePass(row.departure_photo_1, 'arrival');

    if (!colsWrong && !snapsWrong && !swapped) continue;

    update.run(
      nextArrival[0],
      nextArrival[1],
      nextArrival[2],
      nextDeparture[0],
      nextDeparture[1],
      nextDeparture[2],
      nextSnaps,
      row.id,
    );
  }
}

function down(db) {
  /* no-op */
}

module.exports = { id, up, down };
