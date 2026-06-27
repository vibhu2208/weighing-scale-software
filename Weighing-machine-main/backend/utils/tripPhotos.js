'use strict';

const { isHywa, cameraSnapshotPassKey } = require('./vehicleTypes');
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

function resolveVehicleTypeFromRow(row) {
  return row?.vehicle_type || row?.vehicle?.vehicle_type || null;
}

function photoPathFromSnapshots(row, passLabel, slotIndex) {
  const passKey = cameraSnapshotPassKey(resolveVehicleTypeFromRow(row), passLabel);
  const snaps = parseCameraSnapshots(row?.camera_snapshots);
  const camId = `cam-${slotIndex}`;
  const match = (snaps[passKey] || []).find((s) => s.id === camId);
  return match?.path || null;
}

function arrivalPhotoPathsOnRow(row) {
  const paths = new Set();
  for (const col of ['arrival_photo_1', 'arrival_photo_2', 'arrival_photo_3', 'tare_image_path']) {
    const raw = row?.[col];
    if (!raw) continue;
    const resolved = normalizePath(raw);
    if (resolved) paths.add(resolved);
  }
  return paths;
}

function listTripCameraImages(row) {
  if (!row) return [];

  const vehicleType = resolveVehicleTypeFromRow(row);
  const hywa = isHywa(vehicleType);
  const arrivalSnapKey = cameraSnapshotPassKey(vehicleType, 'arrival');
  const departureSnapKey = cameraSnapshotPassKey(vehicleType, 'departure');

  const seen = new Set();
  const out = [];
  const add = (item) => {
    if (!item?.path) return;
    const key = `${item.pass || 'unknown'}:${item.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  const arrivalCols = [
    ['arrival_photo_1', 'Arrival Photo 1'],
    ['arrival_photo_2', 'Arrival Photo 2'],
    ['arrival_photo_3', 'Arrival Photo 3'],
  ];
  for (const [col, label] of arrivalCols) {
    if (row[col]) {
      add({ id: col, label, path: row[col], pass: 'arrival' });
    }
  }

  const departureCols = [
    ['departure_photo_1', 'Departure Photo 1'],
    ['departure_photo_2', 'Departure Photo 2'],
    ['departure_photo_3', 'Departure Photo 3'],
  ];
  for (const [col, label] of departureCols) {
    if (row[col]) {
      add({ id: col, label, path: row[col], pass: 'departure' });
    }
  }

  const snaps = parseCameraSnapshots(row.camera_snapshots);
  for (const s of snaps[arrivalSnapKey] || []) {
    add({ ...s, pass: 'arrival' });
  }
  for (const s of snaps[departureSnapKey] || []) {
    add({ ...s, pass: 'departure' });
  }

  if (row.tare_image_path) {
    add({
      id: 'primary-tare',
      label: 'Primary tare',
      path: row.tare_image_path,
      pass: hywa ? 'departure' : 'arrival',
    });
  }

  if (row.image_path) {
    const pass = isClosedTrip(row) ? 'departure' : 'arrival';
    const resolvedImagePath = normalizePath(row.image_path);
    const duplicateArrival =
      pass === 'departure' &&
      resolvedImagePath &&
      arrivalPhotoPathsOnRow(row).has(resolvedImagePath);
    if (!duplicateArrival) {
      add({
        id: pass === 'departure' ? 'primary-gross' : 'primary-arrival',
        label: pass === 'departure' ? 'Primary gross' : 'Primary arrival',
        path: row.image_path,
        pass,
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
  photoPathFromSnapshots,
  listTripCameraImages,
  countTripCameraImages,
  isClosedTrip,
};
