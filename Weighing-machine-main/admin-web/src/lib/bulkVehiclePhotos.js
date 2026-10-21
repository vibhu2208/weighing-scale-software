/** Last 4 digits of a vehicle registration, e.g. HR58D8715 → 8715. */
export function vehicleLast4(truckNumber) {
  const compact = String(truckNumber || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  const match = compact.match(/(\d{4})$/);
  return match ? match[1] : '';
}

export function isOpenTicket(status) {
  return String(status || '').toUpperCase() === 'OPEN';
}

/**
 * Parse `8715-ac1.jpg` / `4968-dc3.png` (last 4 digits, hyphen, ac/dc + slot 1-3).
 * Also accepts 8715_ac1, 8715-ac-1, and a full plate prefix like HR58D8715-ac1.
 */
export function parseVehiclePhotoName(filename) {
  const base = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '');
  const match = base.match(/(\d{4})\s*[-_]\s*(a|d)\s*c\s*[-_]?\s*([1-3])\b/i);
  if (!match) return null;
  const arrival = match[2].toLowerCase() === 'a';
  const slot = Number(match[3]);
  return {
    last4: match[1],
    pass: arrival ? 'arrival' : 'departure',
    slot,
    code: `${arrival ? 'ac' : 'dc'}${slot}`,
  };
}

export function tripPhotoFilled(trip, pass, slot) {
  return Boolean(trip?.[`${pass}_photo_${slot}`]);
}

export function tripPhotoUrl(trip, pass, slot) {
  return trip?.[`${pass}_photo_${slot}_url`] || '';
}

export function expectedPhotoSlots(trip) {
  const arrival = [1, 2, 3].map((slot) => ({
    pass: 'arrival',
    slot,
    code: `ac${slot}`,
  }));
  if (isOpenTicket(trip?.ticket_status)) return arrival;
  return [
    ...arrival,
    ...[1, 2, 3].map((slot) => ({
      pass: 'departure',
      slot,
      code: `dc${slot}`,
    })),
  ];
}

export function filledPhotoCount(trip) {
  return expectedPhotoSlots(trip).filter((s) => tripPhotoFilled(trip, s.pass, s.slot)).length;
}

const SLOT_NUMS = [1, 2, 3];

function normalizeSlots(slots) {
  return [...new Set((slots || []).map(Number).filter((n) => SLOT_NUMS.includes(n)))].sort(
    (a, b) => a - b,
  );
}

export function defaultPhotoMapping() {
  return {
    arrival: { 1: [1, 2], 2: [3], 3: [3] },
    departure: { 1: [1], 2: [2], 3: [3] },
  };
}

export function slotCode(pass, slot) {
  return `${pass === 'departure' ? 'dc' : 'ac'}${slot}`;
}

/** Destination slots for an uploaded source camera; missing mappings keep the source slot. */
export function destinationSlotsFor(pass, slot, photoMapping) {
  const destinations = photoMapping?.[pass]?.[slot];
  return Array.isArray(destinations) ? normalizeSlots(destinations) : [Number(slot)];
}

export function photoMappingLabel(photoMapping) {
  const parts = [];
  for (const pass of ['arrival', 'departure']) {
    for (const source of SLOT_NUMS) {
      const destinations = destinationSlotsFor(pass, source, photoMapping);
      if (destinations.length === 1 && destinations[0] === source) continue;
      if (destinations.length) {
        parts.push(
          `${slotCode(pass, source).toUpperCase()} -> ${destinations
            .map((slot) => slotCode(pass, slot).toUpperCase())
            .join('+')}`,
        );
      }
    }
  }
  return parts.join(' · ') || 'Cameras mapped to themselves';
}

/**
 * Map each ready source image onto its configured destination slots. A direct
 * image for a destination takes precedence over an image routed into that slot.
 */
export function expandMappedAssignments(assignments, photoMapping = {}) {
  const list = assignments || [];
  const ready = list.filter((a) => a.ready && a.trip && a.parsed);
  const candidates = new Map();
  for (const source of ready) {
    const destinations = destinationSlotsFor(
      source.parsed.pass,
      source.parsed.slot,
      photoMapping,
    );
    for (const slot of destinations) {
      if (isOpenTicket(source.trip.ticket_status) && source.parsed.pass === 'departure') continue;
      const key = `${source.trip.id}:${source.parsed.pass}:${slot}`;
      const bucket = candidates.get(key) || [];
      bucket.push({ source, slot });
      candidates.set(key, bucket);
    }
  }

  const mapped = [];
  for (const bucket of candidates.values()) {
    bucket.sort(
      (a, b) =>
        Number(b.source.parsed.slot === b.slot) -
          Number(a.source.parsed.slot === a.slot) ||
        a.source.parsed.slot - b.source.parsed.slot,
    );
    const { source, slot } = bucket[0];
    if (source.parsed.slot === slot) {
      mapped.push(source);
      continue;
    }
    mapped.push({
      ...source,
      copiedFrom: source.parsed.code,
      parsed: {
        ...source.parsed,
        slot,
        code: slotCode(source.parsed.pass, slot),
      },
      replace: tripPhotoFilled(source.trip, source.parsed.pass, slot),
      warning: `Mapped from ${source.parsed.code.toUpperCase()}`,
      error: '',
      ready: true,
    });
  }

  return [...list.filter((item) => !item.ready), ...mapped];
}

function tripTime(trip) {
  const t = new Date(trip?.timestamp_in || trip?.created_at || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function tripsMatchingLast4(trips, last4) {
  const needle = String(last4 || '');
  return (trips || [])
    .filter((trip) => vehicleLast4(trip.truck_number) === needle)
    .sort((a, b) => tripTime(a) - tripTime(b));
}

function pickTrip(parsed, trips) {
  const matches = tripsMatchingLast4(trips, parsed.last4);
  if (!matches.length) return { trip: null, matches, reason: 'no-vehicle' };
  if (matches.length === 1) return { trip: matches[0], matches, reason: 'unique' };
  const missing = matches.filter((trip) => !tripPhotoFilled(trip, parsed.pass, parsed.slot));
  const pool = missing.length ? missing : matches;
  return { trip: pool[0], matches, reason: 'ambiguous' };
}

/**
 * Map selected image files onto remote trips using the last4-ac/dc filename rule.
 * `overrides[fileId]` forces a trip id (manual pick when the last 4 is shared).
 */
export function buildPhotoAssignments(files, trips, overrides = {}) {
  const used = new Map();
  return (files || []).map((file) => {
    const parsed = parseVehiclePhotoName(file.name);
    if (!parsed) {
      return {
        fileId: file.id,
        name: file.name,
        parsed: null,
        trip: null,
        matches: [],
        ready: false,
        replace: false,
        error: 'Name must be last 4 digits, hyphen, then ac1–ac3 or dc1–dc3 (e.g. 8715-ac1.jpg)',
      };
    }

    const overrideId = overrides[file.id];
    const picked = pickTrip(parsed, trips);
    const trip =
      (overrideId && (trips || []).find((row) => String(row.id) === String(overrideId))) ||
      picked.trip;

    if (!trip) {
      return {
        fileId: file.id,
        name: file.name,
        parsed,
        trip: null,
        matches: picked.matches,
        ready: false,
        replace: false,
        error: `No remote trip with a vehicle ending ${parsed.last4}`,
      };
    }

    if (isOpenTicket(trip.ticket_status) && parsed.pass === 'departure') {
      return {
        fileId: file.id,
        name: file.name,
        parsed,
        trip,
        matches: picked.matches,
        ready: false,
        replace: false,
        error: `${trip.slip_number} is an open ticket — only arrival (ac) photos`,
      };
    }

    const slotKey = `${trip.id}:${parsed.pass}:${parsed.slot}`;
    if (used.has(slotKey)) {
      return {
        fileId: file.id,
        name: file.name,
        parsed,
        trip,
        matches: picked.matches,
        ready: false,
        replace: false,
        error: `Duplicate ${parsed.code.toUpperCase()} for ${trip.slip_number} (already using ${used.get(slotKey)})`,
      };
    }
    used.set(slotKey, file.name);

    const replace = tripPhotoFilled(trip, parsed.pass, parsed.slot);
    return {
      fileId: file.id,
      name: file.name,
      parsed,
      trip,
      matches: picked.matches,
      ready: true,
      replace,
      warning:
        picked.reason === 'ambiguous' && !overrideId
          ? `Vehicle ending ${parsed.last4} is on ${picked.matches.map((m) => m.slip_number).join(', ')} — assigned to ${trip.slip_number}`
          : '',
      error: '',
    };
  });
}
