export const GROSS_MIN_KG = 65000;
export const GROSS_MAX_KG = 65500;
export const TARE_OFFSET_MIN_KG = 50;
export const TARE_OFFSET_MAX_KG = 200;
/** Compost default-tare jitter (kg). */
export const COMPOST_TARE_OFFSET_MIN_KG = 30;
export const COMPOST_TARE_OFFSET_MAX_KG = 70;
const STEP_KG = 10;

function randomStep(min, max, random) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const steps = Math.floor((hi - lo) / STEP_KG) + 1;
  return lo + Math.floor(random() * steps) * STEP_KG;
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

/** Base rounded to 10 kg, then moved `minOffset`-`maxOffset` kg up or down in 10 kg steps. */
export function generateTare(
  base,
  random = Math.random,
  minOffset = TARE_OFFSET_MIN_KG,
  maxOffset = TARE_OFFSET_MAX_KG,
) {
  const rounded = Math.round(Number(base) / STEP_KG) * STEP_KG;
  const offset = randomStep(minOffset, maxOffset, random);
  const sign = random() < 0.5 ? -1 : 1;
  let tare = rounded + sign * offset;
  if (tare <= 0) tare = rounded + offset;
  return { tare, offset: tare - rounded };
}

export function generateGross(random = Math.random) {
  return randomStep(GROSS_MIN_KG, GROSS_MAX_KG, random);
}

/**
 * Compost fill: tare = default ± 30–70 kg; net random within [netMin, netMax];
 * gross = tare + net.
 */
export function generateCompostFillWeights(
  { defaultTare, netMin, netMax, truck } = {},
  random = Math.random,
) {
  const plate = compactPlate(truck);
  const base = Number(defaultTare);
  let lo = Number(netMin);
  let hi = Number(netMax);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  if (!(base > 0) || !(lo > 0) || !(hi > 0)) {
    return {
      tare: null,
      gross: null,
      source: '',
      warning: `Compost vehicle ${plate || ''} needs default tare and net min/max in Configure`,
    };
  }
  const { tare, offset } = generateTare(
    base,
    random,
    COMPOST_TARE_OFFSET_MIN_KG,
    COMPOST_TARE_OFFSET_MAX_KG,
  );
  const netLo = Math.round(lo / STEP_KG) * STEP_KG;
  const netHi = Math.round(hi / STEP_KG) * STEP_KG;
  const net = randomStep(netLo, netHi, random);
  const gross = tare + net;
  return {
    tare,
    gross,
    source: `Compost tare from default ${base.toLocaleString('en-IN')} kg ${offset >= 0 ? '+' : '−'}${Math.abs(offset)}; net ${net.toLocaleString('en-IN')} kg (range ${lo.toLocaleString('en-IN')}–${hi.toLocaleString('en-IN')})`,
    warning: '',
  };
}

/**
 * RDF fill: tare from configured fixed tare ± 50–200 kg; gross in 65,000–65,500 band.
 * Falls back to previous-day history only if no fixed tare is configured.
 */
export function generateRdfFillWeights(
  history,
  truck,
  inMs,
  { defaultTare } = {},
  random = Math.random,
) {
  const gross = generateGross(random);
  const fixed = Number(defaultTare);
  if (fixed > 0) {
    const { tare, offset } = generateTare(fixed, random);
    return {
      tare,
      gross,
      source: `RDF tare from fixed ${fixed.toLocaleString('en-IN')} kg ${offset >= 0 ? '+' : '−'}${Math.abs(offset)}; gross ${gross.toLocaleString('en-IN')} kg`,
      warning: '',
    };
  }

  const base = pickBaseTare(history, truck, inMs);
  if (!base) {
    return {
      tare: null,
      gross,
      source: '',
      warning: `RDF vehicle ${compactPlate(truck)} needs a fixed tare in Configure (or earlier tare history)`,
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

/**
 * Tare and gross for one fill row.
 * RDF uses fixed tare (±50–200) + 65t gross band.
 * Compost uses fixed tare (±30–70) and net min/max range.
 */
export function generateFillWeights(history, truck, inMs, random = Math.random, options = {}) {
  if (String(options.kind || '').toUpperCase() === 'COMPOST') {
    return generateCompostFillWeights(
      {
        defaultTare: options.defaultTare,
        netMin: options.netMin,
        netMax: options.netMax,
        truck,
      },
      random,
    );
  }

  return generateRdfFillWeights(
    history,
    truck,
    inMs,
    { defaultTare: options.defaultTare },
    random,
  );
}
