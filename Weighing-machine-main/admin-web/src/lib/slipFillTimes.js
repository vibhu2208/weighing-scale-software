const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
/** Half the spacing kept around each generated time, so neighbours end up more than 1 minute apart. */
const EDGE_PAD_MS = 31 * SECOND_MS;
const FALLBACK_SPAN_MS = 60 * MINUTE_MS;

export const OUT_MIN_MS = 105 * MINUTE_MS;
export const OUT_MAX_MS = 150 * MINUTE_MS;

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

/**
 * Generate in/out times for blocked slips. Slips that share the same neighbours
 * (a run of consecutive blocked slips) split that window into equal segments in
 * slip order, one random in time per segment. Only rows in `targetIds` get new
 * times, but segment positions always count the whole run so a partial
 * regenerate stays in order with the rest.
 *
 * Returns { [id]: { timestamp_in, timestamp_out, warnings } } with ISO strings.
 */
export function generateFillTimes(rows, targetIds, { now = Date.now(), random = Math.random } = {}) {
  const targets = new Set(targetIds);
  const groups = new Map();
  for (const row of rows) {
    const key = windowKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = {};
  for (const group of groups.values()) {
    group.sort((a, b) => slipNumber(a.slip_number) - slipNumber(b.slip_number));
    const { lo, hi, warnings } = neighborWindow(group[0], now);
    const segment = (hi - lo) / group.length;
    const tight = segment < 2 * EDGE_PAD_MS + SECOND_MS;

    group.forEach((row, i) => {
      if (!targets.has(row.id)) return;
      const segStart = lo + i * segment;
      let inMs;
      if (tight) {
        inMs = segStart + segment / 2;
      } else {
        const from = segStart + EDGE_PAD_MS;
        const to = segStart + segment - EDGE_PAD_MS;
        inMs = from + random() * (to - from);
      }
      inMs = floorToSecond(inMs);
      const outMs = floorToSecond(inMs + OUT_MIN_MS + random() * (OUT_MAX_MS - OUT_MIN_MS));
      const rowWarnings = [...warnings];
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
