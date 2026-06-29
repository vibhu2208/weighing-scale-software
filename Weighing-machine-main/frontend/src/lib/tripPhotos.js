import { toMediaUrl } from './mediaUrl.js';
import { isClosedTicket } from './ticketStatus.js';
import { isHywa } from './vehicleTypes.js';

function parseCameraSnapshots(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return { tare: parsed.tare || [], gross: parsed.gross || [] };
    } catch {
      return { tare: [], gross: [] };
    }
  }
  return { tare: [], gross: [] };
}

function cameraSlotFromId(id) {
  const match = String(id || '').match(/^cam-(\d+)$/i);
  if (!match) return null;
  const slot = parseInt(match[1], 10);
  return Number.isFinite(slot) && slot >= 1 && slot <= 3 ? slot : null;
}

function resolveVehicleType(row) {
  return row?.vehicle_type || row?.vehicle?.vehicle_type || null;
}

function normalizePhotoPath(raw) {
  if (!raw) return '';
  return String(raw).replace(/\\/g, '/').toLowerCase();
}

function pathsMatch(a, b) {
  if (!a || !b) return false;
  return normalizePhotoPath(a) === normalizePhotoPath(b);
}

function columnPaths(row, prefix) {
  return [1, 2, 3]
    .map((slot) => row?.[`${prefix}_photo_${slot}`])
    .filter(Boolean);
}

function isHywaRow(row) {
  const explicit = resolveVehicleType(row);
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
      (isClosedTicket(row) && tarePaths.length && !departurePaths.length)
    ) {
      return true;
    }
  }

  if (colsAlignWith(arrivalPaths, tarePaths)) return false;

  if (!isClosedTicket(row) && grossPaths.length && !tarePaths.length) return true;
  if (!isClosedTicket(row) && tarePaths.length && !grossPaths.length) return false;

  if (isClosedTicket(row) && grossPaths.length && tarePaths.length && arrivalPaths.length) {
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

function photoPathFromSnapshots(row, passLabel, slotIndex) {
  const passKey = cameraSnapshotPassKeyForRow(row, passLabel);
  const snaps = parseCameraSnapshots(row?.camera_snapshots);
  const list = snaps[passKey] || [];
  const camId = `cam-${slotIndex}`;
  const match = list.find((s) => s.id === camId);
  if (match?.path) return match.path;
  return list[slotIndex - 1]?.path || null;
}

function pathLooksLikePassLabel(filePath, passLabel) {
  if (!filePath) return false;
  const normalized = normalizePhotoPath(filePath);
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

function arrivalEquivalentPaths(row) {
  const paths = new Set();
  const hywa = isHywaRow(row);

  if (hywa) {
    for (let slot = 1; slot <= 3; slot += 1) {
      const col = row?.[`arrival_photo_${slot}`];
      if (col && pathLooksLikePassLabel(col, 'arrival')) {
        paths.add(normalizePhotoPath(col));
      }
      const snap = photoPathFromSnapshots(row, 'arrival', slot);
      if (snap && pathLooksLikePassLabel(snap, 'arrival')) {
        paths.add(normalizePhotoPath(snap));
      }
    }
  } else {
    for (const col of ['arrival_photo_1', 'arrival_photo_2', 'arrival_photo_3', 'tare_image_path']) {
      const normalized = normalizePhotoPath(row?.[col]);
      if (normalized) paths.add(normalized);
    }
    const snaps = parseCameraSnapshots(row?.camera_snapshots);
    for (const snap of snaps.tare || []) {
      const normalized = normalizePhotoPath(snap?.path);
      if (normalized) paths.add(normalized);
    }
  }

  return paths;
}

function departureDuplicatesArrival(row, candidatePath) {
  if (!candidatePath) return false;
  if (pathLooksLikePassLabel(candidatePath, 'departure') && isHywaRow(row)) {
    const key = normalizePhotoPath(candidatePath);
    if (!key) return false;
    if (!arrivalEquivalentPaths(row).has(key)) return false;
    return true;
  }
  return arrivalEquivalentPaths(row).has(normalizePhotoPath(candidatePath));
}

function legacyClosePhotoPath(row, passLabel, slotIndex) {
  if (passLabel !== 'departure' || slotIndex !== 1 || !isClosedTicket(row)) return null;
  const imagePath = row?.image_path;
  if (!imagePath || departureDuplicatesArrival(row, imagePath)) return null;
  return imagePath;
}

function photoPathForSlot(row, passLabel, slotIndex) {
  if (passLabel === 'departure' && !isClosedTicket(row)) {
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

/** One photo per slot (max 3 arrival + 3 departure) — avoids duplicate paths from columns vs JSON. */
export function listTripCameraImages(t) {
  if (!t) return [];

  const out = [];
  for (const pass of ['arrival', 'departure']) {
    for (let slot = 1; slot <= 3; slot += 1) {
      const path = photoPathForSlot(t, pass, slot);
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

export function resolvePhotoSlot(photo) {
  const pass = photo?.pass === 'departure' ? 'departure' : 'arrival';
  if (photo?.slot >= 1 && photo?.slot <= 3) {
    return { pass, slot: photo.slot };
  }
  const id = String(photo?.id || '');
  const colMatch = id.match(/^(arrival|departure)_photo_(\d)$/);
  if (colMatch) {
    return { pass: colMatch[1], slot: Number(colMatch[2]) };
  }
  const camMatch = id.match(/^cam-(\d+)$/i);
  if (camMatch) {
    return { pass, slot: Number(camMatch[1]) };
  }
  return { pass, slot: 1 };
}

export function photoSlotKey(pass, slot) {
  return `${pass}:${slot}`;
}

const REPORT_PHOTO_PASS_META = [
  { pass: 'arrival', title: 'Arrival photos (1st weighment)' },
  { pass: 'departure', title: 'Departure photos (2nd weighment)' },
];

/** All report photo slots — optionally includes empty camera 1–3 slots per pass. */
export function listReportPhotoSlots(images = [], { includeEmpty = false } = {}) {
  const byKey = new Map();
  for (const img of images) {
    const { pass, slot } = resolvePhotoSlot(img);
    if (!img?.path) continue;
    byKey.set(photoSlotKey(pass, slot), { ...img, pass, slot, path: img.path });
  }

  return REPORT_PHOTO_PASS_META.map(({ pass, title }) => {
    const items = [];
    for (let slot = 1; slot <= 3; slot += 1) {
      const key = photoSlotKey(pass, slot);
      const existing = byKey.get(key);
      if (existing) {
        items.push(existing);
      } else if (includeEmpty) {
        items.push({
          id: `${pass}_photo_${slot}`,
          label: `${pass === 'arrival' ? 'Arrival' : 'Departure'} Photo ${slot}`,
          path: null,
          pass,
          slot,
          empty: true,
        });
      }
    }
    return { pass, title, items };
  }).filter((group) => includeEmpty || group.items.length > 0);
}

export function groupTripPhotosByPass(cameraImages) {
  const passes = [
    { key: 'arrival', title: 'Arrival photos' },
    { key: 'departure', title: 'Departure photos' },
  ];
  return passes
    .map(({ key, title }) => ({
      pass: key,
      title,
      items: cameraImages.filter((cam) => cam.pass === key),
    }))
    .filter((group) => group.items.length > 0);
}

export function tripPhotoUrls(row, pass) {
  const out = [];
  for (let slot = 1; slot <= 3; slot += 1) {
    const photoPath = photoPathForSlot(row, pass, slot);
    if (photoPath) out.push(toMediaUrl(photoPath));
  }
  return out;
}
