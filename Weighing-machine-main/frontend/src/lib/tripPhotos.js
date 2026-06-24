import { toMediaUrl } from './mediaUrl.js';

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

function isClosedTrip(row) {
  return (
    row?.ticket_status === 'CLOSED' ||
    (row?.gross_weight != null && row?.tare_weight != null)
  );
}

/** All arrival + departure images for a trip (DB columns + legacy JSON). */
export function listTripCameraImages(t) {
  if (!t) return [];

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
    if (t[col]) {
      add({ id: col, label, path: t[col], pass: 'arrival' });
    }
  }

  const departureCols = [
    ['departure_photo_1', 'Departure Photo 1'],
    ['departure_photo_2', 'Departure Photo 2'],
    ['departure_photo_3', 'Departure Photo 3'],
  ];
  for (const [col, label] of departureCols) {
    if (t[col]) {
      add({ id: col, label, path: t[col], pass: 'departure' });
    }
  }

  const snaps = parseCameraSnapshots(t.camera_snapshots);
  for (const s of snaps.tare || []) {
    add({ ...s, pass: 'arrival' });
  }
  for (const s of snaps.gross || []) {
    add({ ...s, pass: 'departure' });
  }

  if (t.tare_image_path) {
    add({
      id: 'primary-tare',
      label: 'Primary tare',
      path: t.tare_image_path,
      pass: 'arrival',
    });
  }

  if (t.image_path) {
    const pass = isClosedTrip(t) ? 'departure' : 'arrival';
    add({
      id: pass === 'departure' ? 'primary-gross' : 'primary-arrival',
      label: pass === 'departure' ? 'Primary gross' : 'Primary arrival',
      path: t.image_path,
      pass,
    });
  }

  return out;
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
  const cols =
    pass === 'departure'
      ? ['departure_photo_1', 'departure_photo_2', 'departure_photo_3']
      : ['arrival_photo_1', 'arrival_photo_2', 'arrival_photo_3'];
  return cols.map((col) => row?.[col]).filter(Boolean).map((p) => toMediaUrl(p));
}
