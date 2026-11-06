const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
/** Half the spacing kept around each generated time, so neighbours end up more than 1 minute apart. */
const EDGE_PAD_MS = 31 * SECOND_MS;
const FALLBACK_SPAN_MS = 60 * MINUTE_MS;

export const OUT_MIN_MS = 105 * MINUTE_MS;
export const OUT_MAX_MS = 150 * MINUTE_MS;
/** When min dwell won't fit before midnight, out is randomized in this end-of-day window. */
const SAME_DAY_TAIL_MS = 5 * MINUTE_MS;
/** Weigh events on different slips must stay more than 1 minute apart. */
export const MIN_SEPARATION_MS = 61 * SECOND_MS;

function slipNumber(slip) {
  const m = String(slip || '').match(/(\d+)$/);
  return m ? Number(m[1]) : NaN;
}

function toMs(value) {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function floorToSecond(ms) {
  return Math.floor(ms / SECOND_MS) * SECOND_MS;
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** Local 23:59:59 of the calendar day that contains `ms`. */
function endOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
}

function pushOccupied(occupied, ms) {
  if (Number.isFinite(ms)) occupied.push(ms);
}

export function timesCollide(a, b, gapMs = MIN_SEPARATION_MS) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < gapMs;
}

function collidesAny(ms, occupied, gapMs = MIN_SEPARATION_MS) {
  return occupied.some((t) => timesCollide(ms, t, gapMs));
}

/**
 * Pick a random second in [lo, hi] that stays clear of occupied times.
 * Falls back to a linear scan; returns null if nothing free.
 */
export function pickAvoiding(lo, hi, occupied, random = Math.random, attempts = 48) {
  const from = floorToSecond(lo);
  const to = floorToSecond(hi);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;

  for (let i = 0; i < attempts; i += 1) {
    const span = to - from;
    const ms = floorToSecond(from + (span <= 0 ? 0 : random() * (span + SECOND_MS)));
    const capped = Math.min(to, Math.max(from, ms));
    if (!collidesAny(capped, occupied)) return capped;
  }
  for (let ms = from; ms <= to; ms += SECOND_MS) {
    if (!collidesAny(ms, occupied)) return ms;
  }
  return null;
}

/**
 * Keep out on the same local day as in. If the random dwell would cross midnight:
 * - if OUT_MIN still fits that day, randomize between OUT_MIN and min(OUT_MAX, day end)
 * - otherwise randomize only in the last few minutes of that day (still after in)
 * Always avoids occupied neighbour / sibling slip times when possible.
 */
export function clampOutToInDay(inMs, outMs, random = Math.random, occupied = []) {
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    return { outMs, shortened: false, collision: false };
  }
  if (sameLocalDay(inMs, outMs) && !collidesAny(outMs, occupied)) {
    return { outMs, shortened: false, collision: false };
  }

  const dayEnd = endOfLocalDay(inMs);
  const minOut = inMs + OUT_MIN_MS;
  let lo;
  let hi;
  if (minOut <= dayEnd) {
    lo = minOut;
    hi = Math.min(inMs + OUT_MAX_MS, dayEnd);
  } else {
    lo = Math.max(inMs + SECOND_MS, dayEnd - SAME_DAY_TAIL_MS);
    hi = dayEnd;
  }

  const shortened = !sameLocalDay(inMs, outMs);
  const picked = pickAvoiding(lo, hi, occupied, random);
  if (picked != null) {
    return { outMs: picked, shortened, collision: false };
  }

  // Last resort: stay on the same day even if a soft collision remains.
  const fallback = floorToSecond(Math.max(inMs + SECOND_MS, Math.min(hi, dayEnd)));
  return {
    outMs: fallback,
    shortened: true,
    collision: collidesAny(fallback, occupied),
  };
}

function windowKey(row) {
  return `${row.prev?.slip_number || '-'}|${row.next?.slip_number || '-'}`;
}

/**
 * The first-weigh window for a blocked slip: after the previous real ticket's
 * in time and before the next one's. Missing neighbours fall back to "now".
 */
export function neighborWindow(row, now = Date.now()) {
  const warnings = [];
  const prevAt = toMs(row.prev?.timestamp_in);
  const nextAt = toMs(row.next?.timestamp_in);

  let hi = nextAt;
  if (!Number.isFinite(hi)) {
    hi = now;
    warnings.push('No later slip yet, so the in time is capped at now');
  }
  let lo = prevAt;
  if (!Number.isFinite(lo)) {
    lo = hi - FALLBACK_SPAN_MS;
    warnings.push('No earlier slip found, so the in time is within 1 hour before the later bound');
  }
  if (hi <= lo) {
    warnings.push('Neighbouring slips are out of time order; using 1 hour after the earlier slip');
    hi = lo + FALLBACK_SPAN_MS;
  }
  return { lo, hi, warnings };
}

function seedOccupied(group, targets, existing) {
  const occupied = [];
  for (const row of group) {
    pushOccupied(occupied, toMs(row.prev?.timestamp_in));
    pushOccupied(occupied, toMs(row.prev?.timestamp_out));
    pushOccupied(occupied, toMs(row.next?.timestamp_in));
    pushOccupied(occupied, toMs(row.next?.timestamp_out));
    if (targets.has(row.id)) continue;
    const ex = existing[row.id];
    if (!ex) continue;
    pushOccupied(occupied, toMs(ex.timestamp_in));
    pushOccupied(occupied, toMs(ex.timestamp_out));
  }
  return occupied;
}

/**
 * Generate in/out times for blocked slips. Slips that share the same neighbours
 * (a run of consecutive blocked slips) split that window into equal segments in
 * slip order, one random in time per segment. Only rows in `targetIds` get new
 * times, but segment positions always count the whole run so a partial
 * regenerate stays in order with the rest.
 *
 * `existing` maps id → { timestamp_in, timestamp_out } for non-target slips so
 * regenerated times stay clear of siblings already on the form.
 *
 * Returns { [id]: { timestamp_in, timestamp_out, warnings } } with ISO strings.
 */
export function generateFillTimes(
  rows,
  targetIds,
  { now = Date.now(), random = Math.random, existing = {} } = {},
) {
  const targets = new Set(targetIds);
  const groups = new Map();
  for (const row of rows) {
    const key = windowKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = {};
  // Shared across groups so late same-day outs from different gaps cannot collide.
  const globalOccupied = [];
  for (const row of rows) {
    if (targets.has(row.id)) continue;
    const ex = existing[row.id];
    if (!ex) continue;
    pushOccupied(globalOccupied, toMs(ex.timestamp_in));
    pushOccupied(globalOccupied, toMs(ex.timestamp_out));
  }

  for (const group of groups.values()) {
    group.sort((a, b) => slipNumber(a.slip_number) - slipNumber(b.slip_number));
    const { lo, hi, warnings } = neighborWindow(group[0], now);
    const segment = (hi - lo) / group.length;
    const tight = segment < 2 * EDGE_PAD_MS + SECOND_MS;
    const occupied = [...globalOccupied, ...seedOccupied(group, targets, existing)];

    group.forEach((row, i) => {
      if (!targets.has(row.id)) return;
      const segStart = lo + i * segment;
      const segFrom = tight ? segStart + segment / 2 : segStart + EDGE_PAD_MS;
      const segTo = tight ? segStart + segment / 2 : segStart + segment - EDGE_PAD_MS;

      let inMs = pickAvoiding(segFrom, segTo, occupied, random);
      if (inMs == null) {
        inMs = floorToSecond(segStart + segment / 2);
      }

      let outMs = floorToSecond(inMs + OUT_MIN_MS + random() * (OUT_MAX_MS - OUT_MIN_MS));
      const rowWarnings = [...warnings];
      // Own in time is occupied for the out pick.
      const occupiedForOut = [...occupied, inMs];
      if (!sameLocalDay(inMs, outMs) || collidesAny(outMs, occupiedForOut)) {
        const clamped = clampOutToInDay(inMs, outMs, random, occupiedForOut);
        outMs = clamped.outMs;
        if (clamped.shortened) {
          rowWarnings.push('Out time shortened to stay on the same day as in time');
        }
        if (clamped.collision) {
          rowWarnings.push('Could not fully clear other slip times; check in/out manually');
        }
      }

      pushOccupied(occupied, inMs);
      pushOccupied(occupied, outMs);
      pushOccupied(globalOccupied, inMs);
      pushOccupied(globalOccupied, outMs);

      if (tight) {
        rowWarnings.push(
          `Only ${Math.round((hi - lo) / SECOND_MS)}s between neighbours for ${group.length} slip(s); times may be under 1 minute apart`,
        );
      }
      out[row.id] = {
        timestamp_in: new Date(inMs).toISOString(),
        timestamp_out: new Date(outMs).toISOString(),
        warnings: rowWarnings,
      };
    });
  }
  return out;
}
