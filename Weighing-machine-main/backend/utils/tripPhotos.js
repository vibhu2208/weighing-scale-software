'use strict';

const { cameraSnapshotPassKey, isHywa } = require('./vehicleTypes');
const { normalizePath } = require('./fileStorage');

function parseCameraSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function isClosedTrip(row) {
  return (
    row?.ticket_status === 'CLOSED' ||
    (row?.gross_weight != null && row?.tare_weight != null)
  );
}

function cameraSlotFromId(id) {
  const match = String(id || '').match(/^cam-(\d+)$/i);
  if (!match) return null;
  const slot = parseInt(match[1], 10);
  return Number.isFinite(slot) && slot >= 1 && slot <= 3 ? slot : null;
}

/** Map snapshots to photo slots by camera id (cam-1 → slot 1, cam-2 → slot 2, …). */
function photoColumnFields(snapshots, kind) {
  const prefix = kind === 'departure' ? 'departure' : 'arrival';
  const slots = { 1: null, 2: null, 3: null };

  for (const snap of snapshots || []) {
    if (!snap?.path) continue;
    const slot = cameraSlotFromId(snap.id);
    if (slot) {
      slots[slot] = snap.path;
      continue;
    }
    for (let i = 1; i <= 3; i += 1) {
      if (!slots[i]) {
        slots[i] = snap.path;
        break;
      }
    }
  }

  return {
    [`${prefix}_photo_1`]: slots[1],
    [`${prefix}_photo_2`]: slots[2],
    [`${prefix}_photo_3`]: slots[3],
  };
}

/** Build snapshot list from DB photo columns for a pass. */
function snapshotsFromPhotoColumns(row, pass) {
  const prefix = pass === 'departure' ? 'departure' : 'arrival';
  const out = [];
  for (let slot = 1; slot <= 3; slot += 1) {
    const path = row?.[`${prefix}_photo_${slot}`];
    if (path) {
      out.push({ id: `cam-${slot}`, label: `Camera ${slot}`, path });
    }
  }
  return out;
}

/** Merge snapshot arrays by camera slot; newer entries replace the same slot. */
function mergeSnapshotsBySlot(existingSnapshots, newSnapshots) {
  const bySlot = new Map();

  for (const snap of existingSnapshots || []) {
    if (!snap?.path) continue;
    const slot = cameraSlotFromId(snap.id);
    if (slot) {
      bySlot.set(slot, { ...snap, id: `cam-${slot}` });
      continue;
    }
    for (let i = 1; i <= 3; i += 1) {
      if (!bySlot.has(i)) {
        bySlot.set(i, { ...snap, id: `cam-${i}` });
        break;
      }
    }
  }

  for (const snap of newSnapshots || []) {
    if (!snap?.path) continue;
    const slot = cameraSlotFromId(snap.id);
    if (slot) {
      bySlot.set(slot, { ...snap, id: `cam-${slot}` });
    }
  }

  return Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, snap]) => snap);
}

function existingPassSnapshots(row, vehicleType, passLabel) {
  const passKey = vehicleType
    ? cameraSnapshotPassKey(vehicleType, passLabel)
    : cameraSnapshotPassKeyForRow(row, passLabel);
  const fromJson = parseCameraSnapshots(row?.camera_snapshots)[passKey] || [];
  const fromCols = snapshotsFromPhotoColumns(row, passLabel);
  // DB columns are authoritative — JSON may still hold stale paths after a replace.
  return mergeSnapshotsBySlot(fromJson, fromCols);
}

function setPassSnapshots(existing, vehicleType, passLabel, mergedSnapshots) {
  const data = parseCameraSnapshots(existing);
  const passKey = cameraSnapshotPassKey(vehicleType, passLabel);
  data[passKey] = mergedSnapshots;
  return JSON.stringify(data);
}

/** Apply only the slots being replaced — leave other photo columns unchanged. */
function photoColumnUpdates(newSnapshots, pass) {
  const prefix = pass === 'departure' ? 'departure' : 'arrival';
  const updates = {};
  for (const snap of newSnapshots || []) {
    if (!snap?.path) continue;
    const slot = cameraSlotFromId(snap.id);
    if (slot) {
      updates[`${prefix}_photo_${slot}`] = snap.path;
    }
  }
  return updates;
}

function resolveVehicleTypeFromRow(row) {
  return row?.vehicle_type || row?.vehicle?.vehicle_type || null;
}

function pathsMatch(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

function columnPaths(row, prefix) {
  return [1, 2, 3]
    .map((slot) => row?.[`${prefix}_photo_${slot}`])
    .filter(Boolean);
}

/** Detect HYWA from vehicle type or how photos/weights were stored on the ticket. */
function isHywaRow(row) {
  const explicit = resolveVehicleTypeFromRow(row);
  if (explicit) return isHywa(explicit);

  const snaps = parseCameraSnapshots(row?.camera_snapshots);
  const grossPaths = (snaps.gross || []).map((s) => s.path).filter(Boolean);
  const tarePaths = (snaps.tare || []).map((s) => s.path).filter(Boolean);
  const arrivalPaths = columnPaths(row, 'arrival');
  const departurePaths = columnPaths(row, 'departure');

  const colsAlignWith = (cols, snapPaths) =>
    cols.length > 0 &&
    cols.every((col) => snapPaths.some((snapPath) => pathsMatch(col, snapPath)));

  if (colsAlignWith(arrivalPaths, grossPaths)) {
    if (
      colsAlignWith(departurePaths, tarePaths) ||
      (isClosedTrip(row) && tarePaths.length && !departurePaths.length)
    ) {
      return true;
    }
  }

  if (colsAlignWith(arrivalPaths, tarePaths)) return false;

  if (!isClosedTrip(row) && grossPaths.length && !tarePaths.length) return true;
  if (!isClosedTrip(row) && tarePaths.length && !grossPaths.length) return false;

  if (isClosedTrip(row) && grossPaths.length && tarePaths.length && arrivalPaths.length) {
    const firstArrival = arrivalPaths[0];
    if (grossPaths.some((p) => pathsMatch(p, firstArrival))) return true;
  }

  return false;
}

function cameraSnapshotPassKeyForRow(row, passLabel) {
  const hywa = isHywaRow(row);
  const departure = passLabel === 'departure';
  if (hywa) return departure ? 'tare' : 'gross';
  return departure ? 'gross' : 'tare';
}

function snapshotPathForSlot(snaps, slotIndex) {
  const list = snaps || [];
  const camId = `cam-${slotIndex}`;
  const match = list.find((s) => s.id === camId);
  if (match?.path) return match.path;
  const byIndex = list[slotIndex - 1];
  return byIndex?.path || null;
}

function photoPathFromSnapshots(row, passLabel, slotIndex) {
  const passKey = cameraSnapshotPassKeyForRow(row, passLabel);
  const snaps = parseCameraSnapshots(row?.camera_snapshots);
  return snapshotPathForSlot(snaps[passKey], slotIndex);
}

function addNormalizedPhotoPath(paths, raw) {
  if (!raw) return;
  const resolved = normalizePath(raw);
  if (resolved) paths.add(resolved);
}

function pathLooksLikePassLabel(filePath, passLabel) {
  if (!filePath) return false;
  const normalized = String(filePath).toLowerCase().replace(/\\/g, '/');
  if (passLabel === 'departure') {
    return /departure[-_]/.test(normalized);
  }
  return /arrival[-_]/.test(normalized);
}

function pickPassPath(candidates, passLabel) {
  const withPath = (candidates || []).filter(Boolean);
  if (!withPath.length) return null;
  const matching = withPath.filter((p) => pathLooksLikePassLabel(p, passLabel));
  return matching[0] || withPath[0];
}

/** All file paths that belong to the arrival / first weigh (HYWA: gross; standard: tare). */
function arrivalEquivalentPaths(row) {
  const paths = new Set();
  const hywa = isHywaRow(row);

  if (hywa) {
    for (let slot = 1; slot <= 3; slot += 1) {
      const col = row?.[`arrival_photo_${slot}`];
      if (col && pathLooksLikePassLabel(col, 'arrival')) {
        addNormalizedPhotoPath(paths, col);
      }
      const snap = photoPathFromSnapshots(row, 'arrival', slot);
      if (snap && pathLooksLikePassLabel(snap, 'arrival')) {
        addNormalizedPhotoPath(paths, snap);
      }
    }
  } else {
    for (const col of ['arrival_photo_1', 'arrival_photo_2', 'arrival_photo_3', 'tare_image_path']) {
      addNormalizedPhotoPath(paths, row?.[col]);
    }
    const snaps = parseCameraSnapshots(row?.camera_snapshots);
    for (const snap of snaps.tare || []) {
      addNormalizedPhotoPath(paths, snap?.path);
    }
  }

  return paths;
}

function departureDuplicatesArrival(row, candidatePath) {
  if (!candidatePath) return false;
  // Different pass in filename => never treat as duplicate (fixes swapped DB columns).
  if (
    pathLooksLikePassLabel(candidatePath, 'departure') &&
    isHywaRow(row)
  ) {
    const resolvedCandidate = normalizePath(candidatePath);
    if (!resolvedCandidate) return false;
    const arrivalPaths = arrivalEquivalentPaths(row);
    if (!arrivalPaths.has(resolvedCandidate)) return false;
    // Same file path listed for both passes — still a duplicate.
    return true;
  }
  const resolvedCandidate = normalizePath(candidatePath);
  if (!resolvedCandidate) return false;
  return arrivalEquivalentPaths(row).has(resolvedCandidate);
}

function legacyClosePhotoPath(row, passLabel, slotIndex) {
  if (passLabel !== 'departure' || slotIndex !== 1 || !isClosedTrip(row)) return null;
  const imagePath = row?.image_path;
  if (!imagePath || departureDuplicatesArrival(row, imagePath)) return null;
  return imagePath;
}

function photoPathForSlot(row, passLabel, slotIndex) {
  if (passLabel === 'departure' && !isClosedTrip(row)) {
    return null;
  }

  const prefix = passLabel === 'departure' ? 'departure' : 'arrival';
  const columnPath = row?.[`${prefix}_photo_${slotIndex}`];
  const snapshotPath = photoPathFromSnapshots(row, passLabel, slotIndex);
  const legacyPath = legacyClosePhotoPath(row, passLabel, slotIndex);

  let chosen;
  if (isHywaRow(row)) {
    chosen = pickPassPath([snapshotPath, columnPath, legacyPath], passLabel);
  } else {
    chosen = columnPath || snapshotPath || legacyPath;
  }

  if (!chosen) return null;

  if (passLabel === 'departure' && departureDuplicatesArrival(row, chosen)) {
    const alternate = pickPassPath(
      [snapshotPath, columnPath, legacyPath].filter(
        (p) => p && p !== chosen && !departureDuplicatesArrival(row, p),
      ),
      passLabel,
    );
    return alternate || null;
  }

  return chosen;
}

function listTripCameraImages(row) {
  if (!row) return [];

  const out = [];
  for (const pass of ['arrival', 'departure']) {
    for (let slot = 1; slot <= 3; slot += 1) {
      const path = photoPathForSlot(row, pass, slot);
      if (!path) continue;
      out.push({
        id: `${pass}_photo_${slot}`,
        label: `${pass === 'arrival' ? 'Arrival' : 'Departure'} Photo ${slot}`,
        path,
        pass,
        slot,
      });
    }
  }

  return out;
}

function countTripCameraImages(row) {
  return listTripCameraImages(row).length;
}

module.exports = {
  parseCameraSnapshots,
  cameraSlotFromId,
  photoColumnFields,
  photoColumnUpdates,
  photoPathFromSnapshots,
  photoPathForSlot,
  snapshotsFromPhotoColumns,
  mergeSnapshotsBySlot,
  existingPassSnapshots,
  setPassSnapshots,
  listTripCameraImages,
  countTripCameraImages,
  isClosedTrip,
};
