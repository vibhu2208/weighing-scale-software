export const GROSS_MIN_KG = 65000;
export const GROSS_MAX_KG = 65500;
export const TARE_OFFSET_MIN_KG = 50;
export const TARE_OFFSET_MAX_KG = 200;
const STEP_KG = 10;

function randomStep(min, max, random) {
  const steps = Math.floor((max - min) / STEP_KG) + 1;
  return min + Math.floor(random() * steps) * STEP_KG;
}

function compactPlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function fmtDay(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit' });
}

/**
 * The vehicle's latest tare on the calendar day before `inMs` (local time);
 * failing that, its latest tare at any time before `inMs`.
 */
export function pickBaseTare(history, truck, inMs) {
  const plate = compactPlate(truck);
  if (!plate || !Number.isFinite(inMs)) return null;
  const inDay = new Date(inMs);
  const dayStart = new Date(inDay.getFullYear(), inDay.getMonth(), inDay.getDate()).getTime();
  const prevDayStart = new Date(inDay.getFullYear(), inDay.getMonth(), inDay.getDate() - 1).getTime();

  let latestPrevDay = null;
  let latestBefore = null;
  for (const row of history || []) {
    if (compactPlate(row.truck_number) !== plate) continue;
    const at = new Date(row.timestamp_in).getTime();
    const tare = Number(row.tare_weight);
    if (!Number.isFinite(at) || !(tare > 0) || at >= inMs) continue;
    const hit = { slip_number: row.slip_number, tare_weight: tare, at };
    if (!latestBefore || at > latestBefore.at) latestBefore = hit;
    if (at >= prevDayStart && at < dayStart && (!latestPrevDay || at > latestPrevDay.at)) {
      latestPrevDay = hit;
    }
  }
  if (latestPrevDay) return { ...latestPrevDay, previousDay: true };
  if (latestBefore) return { ...latestBefore, previousDay: false };
  return null;
}

/** Base rounded to 10 kg, then moved 50-200 kg up or down in 10 kg steps. */
export function generateTare(base, random = Math.random) {
  const rounded = Math.round(Number(base) / STEP_KG) * STEP_KG;
  const offset = randomStep(TARE_OFFSET_MIN_KG, TARE_OFFSET_MAX_KG, random);
  const sign = random() < 0.5 ? -1 : 1;
  let tare = rounded + sign * offset;
  if (tare <= 0) tare = rounded + offset;
  return { tare, offset: tare - rounded };
}

export function generateGross(random = Math.random) {
  return randomStep(GROSS_MIN_KG, GROSS_MAX_KG, random);
}

/** Tare and gross for one fill row. `tare` is null when the vehicle has no earlier tare. */
export function generateFillWeights(history, truck, inMs, random = Math.random) {
  const gross = generateGross(random);
  const base = pickBaseTare(history, truck, inMs);
  if (!base) {
    return {
      tare: null,
      gross,
      source: '',
      warning: `No earlier tare found for ${compactPlate(truck)}; enter tare manually`,
    };
  }
  const { tare, offset } = generateTare(base.tare_weight, random);
  const when = base.previousDay ? `previous day ${fmtDay(base.at)}` : `latest earlier, ${fmtDay(base.at)}`;
  return {
    tare,
    gross,
    source: `Tare from ${base.slip_number || 'ticket'} (${when}): ${base.tare_weight.toLocaleString('en-IN')} kg ${offset >= 0 ? '+' : '−'}${Math.abs(offset)}`,
    warning: '',
  };
}
