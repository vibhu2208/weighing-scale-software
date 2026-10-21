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

export function normalizeShareSlots(slots) {
  return [...new Set((slots || []).map(Number).filter((n) => SLOT_NUMS.includes(n)))].sort(
    (a, b) => a - b,
  );
}

export function defaultShareConfig() {
  return { arrival: [], departure: [] };
}

export function slotCode(pass, slot) {
  return `${pass === 'departure' ? 'dc' : 'ac'}${slot}`;
}

/** Slots that receive the same photo as `slot` for this pass (includes `slot`). */
export function sharedSlotsFor(pass, slot, shareConfig) {
  const group = normalizeShareSlots(shareConfig?.[pass]);
  if (group.length < 2 || !group.includes(Number(slot))) return [Number(slot)];
  return group;
}

export function shareConfigLabel(shareConfig) {
  const parts = [];
  for (const pass of ['arrival', 'departure']) {
    const group = normalizeShareSlots(shareConfig?.[pass]);
    if (group.length < 2) continue;
    parts.push(group.map((slot) => slotCode(pass, slot).toUpperCase()).join('='));
  }
  return parts.join(' · ') || 'Cameras independent';
}

/**
 * When a share group is set (e.g. AC1=AC2), copy a ready assignment onto empty
 * sibling slots on the same trip. An explicit file for a sibling slot wins.
 */
export function expandSharedAssignments(assignments, shareConfig = {}) {
  const list = assignments || [];
  const ready = list.filter((a) => a.ready && a.trip && a.parsed);
  const occupied = new Set(ready.map((a) => `${a.trip.id}:${a.parsed.pass}:${a.parsed.slot}`));
  const extra = [];

  for (const pass of ['arrival', 'departure']) {
    const group = normalizeShareSlots(shareConfig[pass]);
    if (group.length < 2) continue;

    const byTrip = new Map();
    for (const item of ready) {
      if (item.parsed.pass !== pass || !group.includes(item.parsed.slot)) continue;
      const bucket = byTrip.get(item.trip.id) || [];
      bucket.push(item);
      byTrip.set(item.trip.id, bucket);
    }

    for (const sources of byTrip.values()) {
      const source = sources.slice().sort((a, b) => a.parsed.slot - b.parsed.slot)[0];
      if (isOpenTicket(source.trip.ticket_status) && pass === 'departure') continue;
      for (const slot of group) {
        const key = `${source.trip.id}:${pass}:${slot}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        extra.push({
          ...source,
          copiedFrom: source.parsed.code,
          parsed: {
            ...source.parsed,
            slot,
            code: slotCode(pass, slot),
          },
          replace: tripPhotoFilled(source.trip, pass, slot),
          warning: `Copied from ${source.parsed.code.toUpperCase()} (camera share)`,
          error: '',
          ready: true,
        });
      }
    }
  }

  return extra.length ? [...list, ...extra] : list;
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
