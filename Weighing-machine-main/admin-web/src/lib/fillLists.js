/** Operators used on weighbridge slips. Shared with Fill Blocked Slips. */
export const FILL_OPERATORS = [
  'ABHISHEK',
  'ANIL',
  'BRIJESH',
  'HANUMAN',
  'JITENDER',
  'KARAMVEER',
  'MANENDER',
  'MANINDER',
  'MANISH',
  'MUNESH',
  'PARDEEP',
  'PARVESH',
  'PAWAN',
  'RONAK',
  'SHUBHAM',
  'SUMIT',
  'SUNNY',
  'UMESH',
  'YATIN',
];

export const FILL_KIND_RDF = 'RDF';
export const FILL_KIND_COMPOST = 'COMPOST';
export const FILL_KINDS = [FILL_KIND_RDF, FILL_KIND_COMPOST];

/** Shared with Fill Blocked Slips and Bulk Photos. Default kind is RDF (TRUCK / tare first). */
export const FILL_VEHICLES = [
  'HR65A7668',
  'HR58D8715',
  'HR58E3515',
  'HR69E3748',
  'HR69D5649',
  'HR58C6215',
  'UP12BT4968',
  'HR58E3696',
  'HR58E8815',
  'HR38AB3093',
  'HR58E7930',
  'HR58E5799',
  'PB13BE9786',
  'UP14HT5656',
];

export function compactPlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

export function samePlate(a, b) {
  const left = compactPlate(a);
  const right = compactPlate(b);
  return Boolean(left) && left === right;
}

export function normalizeFillKind(kind) {
  return String(kind || '').trim().toUpperCase() === FILL_KIND_COMPOST
    ? FILL_KIND_COMPOST
    : FILL_KIND_RDF;
}

/**
 * RDF = TRUCK, tare first (arrival=tare, departure=gross).
 * COMPOST = HYWA, gross first (arrival=gross, departure=tare).
 */
export function fillVehicleProfile(kind) {
  if (normalizeFillKind(kind) === FILL_KIND_COMPOST) {
    return {
      kind: FILL_KIND_COMPOST,
      material: 'COMPOST',
      vehicle_type: 'HYWA',
      inLabel: 'In (gross / arrival)',
      outLabel: 'Out (tare / departure)',
      flowNote: 'HYWA · gross first',
    };
  }
  return {
    kind: FILL_KIND_RDF,
    material: 'RDF',
    vehicle_type: 'TRUCK',
    inLabel: 'In (tare / arrival)',
    outLabel: 'Out (gross / departure)',
    flowNote: 'TRUCK · tare first',
  };
}

function positiveKg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Normalize saved fill_vehicles (strings or { truck_number, kind, ... }) into typed entries. */
export function normalizeFillVehicles(items, fallbackKind = FILL_KIND_RDF) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    let plate = '';
    let kind = fallbackKind;
    let defaultTare = null;
    let netMin = null;
    let netMax = null;
    if (raw && typeof raw === 'object') {
      plate = compactPlate(raw.truck_number || raw.plate || raw.vehicle || '');
      kind = normalizeFillKind(raw.kind || raw.type || fallbackKind);
      defaultTare = positiveKg(raw.default_tare ?? raw.defaultTare);
      netMin = positiveKg(raw.net_min ?? raw.netMin);
      netMax = positiveKg(raw.net_max ?? raw.netMax);
      // Older single net_limit → treat as max, with a soft min at 85%.
      const legacyLimit = positiveKg(raw.net_limit ?? raw.netLimit);
      if (legacyLimit && !netMax) {
        netMax = legacyLimit;
        netMin = netMin || Math.round(legacyLimit * 0.85);
      }
    } else {
      const text = String(raw || '').trim();
      if (!text) continue;
      const parts = text.split('|');
      plate = compactPlate(parts[0]);
      if (parts[1]) kind = normalizeFillKind(parts[1]);
      if (parts[2]) defaultTare = positiveKg(parts[2]);
      if (parts[3]) netMin = positiveKg(parts[3]);
      if (parts[4]) netMax = positiveKg(parts[4]);
      else if (parts[3] && !parts[4]) {
        // Legacy: plate|COMPOST|tare|netLimit
        netMax = netMin;
        netMin = netMax ? Math.round(netMax * 0.85) : null;
      }
    }
    if (!plate || seen.has(plate)) continue;
    seen.add(plate);
    const entry = { truck_number: plate, kind, default_tare: defaultTare };
    if (kind === FILL_KIND_COMPOST) {
      if (netMin && netMax && netMin > netMax) {
        const swap = netMin;
        netMin = netMax;
        netMax = swap;
      }
      entry.net_min = netMin;
      entry.net_max = netMax;
    }
    out.push(entry);
  }
  return out;
}

export function defaultFillVehicles() {
  return normalizeFillVehicles(FILL_VEHICLES, FILL_KIND_RDF);
}

export function lookupFillVehicle(vehicles, plate) {
  const list = Array.isArray(vehicles) ? vehicles : [];
  return list.find((v) => samePlate(v.truck_number, plate)) || null;
}

export function fillVehiclePlates(vehicles) {
  return normalizeFillVehicles(vehicles).map((v) => v.truck_number);
}

export const DEFAULT_FILL_DESTINATION = 'MUZAFFAR NAGAR';

/** Normalize saved fill_destinations (strings or { name, kind }) into typed entries. */
export function normalizeFillDestinations(items, fallbackKind = FILL_KIND_RDF) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    let name = '';
    let kind = fallbackKind;
    if (raw && typeof raw === 'object') {
      name = String(raw.name || raw.destination || '').trim();
      kind = normalizeFillKind(raw.kind || raw.type || fallbackKind);
    } else {
      const text = String(raw || '').trim();
      if (!text) continue;
      const parts = text.split('|');
      name = String(parts[0] || '').trim();
      if (parts[1]) kind = normalizeFillKind(parts[1]);
    }
    if (!name) continue;
    const key = `${name.toLowerCase()}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind });
  }
  return out;
}

export function defaultFillDestinations() {
  return normalizeFillDestinations(
    [{ name: DEFAULT_FILL_DESTINATION, kind: FILL_KIND_RDF }],
    FILL_KIND_RDF,
  );
}

export function destinationsForKind(destinations, kind) {
  const want = normalizeFillKind(kind);
  return normalizeFillDestinations(destinations).filter((d) => d.kind === want);
}

export function fillDestinationNames(destinations) {
  const names = [];
  const seen = new Set();
  for (const item of normalizeFillDestinations(destinations)) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(item.name);
  }
  return names;
}
