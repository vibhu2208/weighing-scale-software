'use strict';

const SettingsService = require('./SettingsService');

const ADMIN_WEIGHT_KEYS = Object.freeze([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
]);

function roundKg(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function isEnabled() {
  return SettingsService.get('WEIGHT_ADJUSTMENT_ENABLED') === 'true';
}

function getOffsetKg() {
  const n = Number(SettingsService.get('WEIGHT_OFFSET_KG') || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Live GROSS ramp — offset grows gradually as raw rises from session base. */
let liveRampSession = null;

/** When raw has not risen (vehicle already on scale), ramp offset over this duration. */
const TIME_RAMP_MS = 6000;

/** Raw rise below this is treated as stationary (use time-based ramp). */
const STATIONARY_RISE_KG = 50;

function clearLiveRamp() {
  liveRampSession = null;
}

function getRampSpanKg() {
  const offset = getOffsetKg();
  return Math.max(offset * 20, 500);
}

function resolveIncreaseRatio(raw, pass, options = {}) {
  const rise = Math.max(0, raw - liveRampSession.baseRawKg);
  const riseRatio = Math.min(1, rise / getRampSpanKg());
  const stationary = rise < STATIONARY_RISE_KG;
  const timeRatio = stationary
    ? Math.min(1, (Date.now() - liveRampSession.startedAt) / TIME_RAMP_MS)
    : 0;
  let increaseRatio = Math.max(riseRatio, timeRatio);
  if (options.isStable && (riseRatio >= 1 || timeRatio >= 1 || stationary)) {
    increaseRatio = 1;
  }
  return increaseRatio;
}

/** Offset applies to loaded truck (gross) only — not tare or idle/live preview. */
function shouldApplyOffset(pass) {
  if (!isEnabled() || getOffsetKg() === 0) return false;
  return pass === 'GROSS';
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null, live?: boolean }} context
 */
function apply(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  if (raw <= 0) return raw;

  // Live preview / external LED should mirror the scale — offset applies on save only.
  if (context.live) return raw;

  const pass = context.pass || null;
  if (!shouldApplyOffset(pass)) return raw;

  return raw + getOffsetKg();
}

/**
 * Live display with gradual offset ramp on GROSS pass (UI + external LED).
 * Ramps by raw rise while loading; if the truck is already fully on scale,
 * ramps by time and completes to full offset when stable.
 * @param {number} rawKg
 * @param {'TARE'|'GROSS'|null} pass
 * @param {{ isStable?: boolean }} [options]
 */
function resolveLiveDisplay(rawKg, pass, options = {}) {
  const raw = roundKg(rawKg);
  if (raw <= 0) {
    clearLiveRamp();
    return raw;
  }
  if (!shouldApplyOffset(pass)) {
    clearLiveRamp();
    return raw;
  }

  const offsetKg = getOffsetKg();
  if (offsetKg <= 0) {
    clearLiveRamp();
    return raw;
  }

  if (!liveRampSession || liveRampSession.pass !== pass) {
    liveRampSession = {
      pass,
      baseRawKg: raw,
      peakRawKg: raw,
      offsetKg,
      startedAt: Date.now(),
    };
  } else {
    liveRampSession.peakRawKg = Math.max(liveRampSession.peakRawKg, raw);
    liveRampSession.baseRawKg = Math.min(liveRampSession.baseRawKg, raw);
  }

  const increaseRatio = resolveIncreaseRatio(raw, pass, options);
  const appliedOffset = roundKg(offsetKg * increaseRatio);
  return raw + appliedOffset;
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null }} context
 */
function split(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  const offsetKg = shouldApplyOffset(context.pass || null) ? getOffsetKg() : 0;
  return {
    rawKg: raw,
    adjustedKg: raw + offsetKg,
    offsetKg,
  };
}

module.exports = {
  ADMIN_WEIGHT_KEYS,
  isEnabled,
  getOffsetKg,
  shouldApplyOffset,
  apply,
  split,
  resolveLiveDisplay,
  clearLiveRamp,
};
