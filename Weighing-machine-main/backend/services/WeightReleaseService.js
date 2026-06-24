'use strict';

/** Raw must drop this many kg below peak before offset release begins. */
const DECREASE_THRESHOLD_KG = 20;

let session = null;

function roundKg(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Start post-close hold/release after a CLOSE save with offset applied.
 * @param {{ peakRawKg: number, offsetKg: number }} params
 */
function activate({ peakRawKg, offsetKg }) {
  const peak = roundKg(peakRawKg);
  const offset = roundKg(offsetKg);
  if (peak <= 0 || offset <= 0) {
    session = null;
    return;
  }
  try {
    const WeightAdjustmentService = require('./WeightAdjustmentService');
    if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
      WeightAdjustmentService.clearLiveRamp();
    }
  } catch (_e) {
    /* optional */
  }
  session = {
    peakRawKg: peak,
    offsetKg: offset,
    holdDisplayKg: peak + offset,
    phase: 'hold',
    releaseSpanKg: peak,
  };
}

function clear() {
  session = null;
}

function isActive() {
  return session != null;
}

function getSnapshot() {
  if (!session) return null;
  return { ...session, active: true };
}

/**
 * @param {number} rawKg
 * @returns {number|null} Display kg when release session is active; null otherwise.
 */
function resolveDisplayKg(rawKg) {
  if (!session) return null;

  const raw = roundKg(rawKg);
  if (raw <= 0) {
    clear();
    return 0;
  }

  const { peakRawKg, offsetKg, holdDisplayKg } = session;
  const releaseSpanKg = session.releaseSpanKg || peakRawKg;

  if (session.phase === 'hold') {
    if (raw < peakRawKg - DECREASE_THRESHOLD_KG) {
      session.phase = 'releasing';
    } else {
      return holdDisplayKg;
    }
  }

  const drop = peakRawKg - raw;
  const releaseRatio = Math.min(1, drop / releaseSpanKg);
  const remainingOffset = roundKg(offsetKg * (1 - releaseRatio));
  const display = raw + remainingOffset;

  if (remainingOffset <= 0 || display <= raw + 1) {
    clear();
    return raw;
  }

  return display;
}

module.exports = {
  DECREASE_THRESHOLD_KG,
  activate,
  clear,
  isActive,
  getSnapshot,
  resolveDisplayKg,
};
