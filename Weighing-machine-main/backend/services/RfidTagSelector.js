'use strict';

const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const RfidBlocklistService = require('./RfidBlocklistService');

const DEFAULT_SELECTION_WINDOW_MS = 800;
const DEFAULT_LOCK_TIMEOUT_MS = 120000;

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const selectionWindowMs = parsePositiveInt(
  process.env.RFID_SELECTION_WINDOW_MS,
  DEFAULT_SELECTION_WINDOW_MS,
);
const lockTimeoutMs = parsePositiveInt(
  process.env.RFID_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
);

let selectedCallback = null;
let lockedTag = null;
let lockedPayload = null;
let lockTimeout = null;
let windowTimer = null;
let windowStartedAt = null;
const windowTags = new Map();

function clearWindowTimer() {
  if (windowTimer) {
    clearTimeout(windowTimer);
    windowTimer = null;
  }
}

function clearLockTimeout() {
  if (lockTimeout) {
    clearTimeout(lockTimeout);
    lockTimeout = null;
  }
}

function resetWindow() {
  clearWindowTimer();
  windowTags.clear();
  windowStartedAt = null;
}

function normalizeRssi(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isKnownVehicleTag(tag) {
  try {
    const VehicleService = require('./VehicleService');
    return !!VehicleService.findByRFID(tag);
  } catch (_e) {
    return false;
  }
}

function pickWinner() {
  if (windowTags.size === 0) return null;

  const entries = [...windowTags.values()];
  entries.sort((a, b) => {
    const aTag = a.lastPayload?.tag;
    const bTag = b.lastPayload?.tag;
    const aKnown = isKnownVehicleTag(aTag);
    const bKnown = isKnownVehicleTag(bTag);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;

    const aRssi = a.bestRssi;
    const bRssi = b.bestRssi;

    if (aRssi != null && bRssi != null && aRssi !== bRssi) {
      return bRssi - aRssi;
    }
    if (aRssi != null && bRssi == null) return -1;
    if (aRssi == null && bRssi != null) return 1;

    if (a.readCount !== b.readCount) {
      return b.readCount - a.readCount;
    }

    if (a.firstSeenAt !== b.firstSeenAt) {
      return a.firstSeenAt - b.firstSeenAt;
    }

    return 0;
  });

  return entries[0]?.lastPayload || null;
}

function scheduleLockTimeout() {
  clearLockTimeout();
  if (lockTimeoutMs <= 0) return;

  lockTimeout = setTimeout(() => {
    lockTimeout = null;
    logger.warn('RFID tag lock timed out — resuming scan', { tag: lockedTag });
    lockedTag = null;
    lockedPayload = null;
    resetWindow();
  }, lockTimeoutMs);
  if (lockTimeout.unref) lockTimeout.unref();
}

function lockAndEmit(winner) {
  const tag = String(winner?.tag || '').trim().toUpperCase();
  if (!tag) return;

  if (lockedTag) {
    resetWindow();
    return;
  }

  const candidateCount = windowTags.size;
  lockedTag = tag;
  lockedPayload = { ...winner, tag, locked: true };
  resetWindow();
  scheduleLockTimeout();

  logger.info('RFID tag locked (strongest RSSI in window)', {
    tag: lockedTag,
    rssi: winner.rssi ?? null,
    sourceReader: winner.sourceReader ?? winner.readerName ?? null,
    sourceIp: winner.sourceIp ?? null,
    candidates: candidateCount,
  });

  if (typeof selectedCallback === 'function') {
    selectedCallback(lockedPayload);
  }
}

function finalizeWindow() {
  windowTimer = null;

  if (lockedTag) {
    resetWindow();
    return;
  }

  const winner = pickWinner();
  resetWindow();

  if (!winner) return;
  lockAndEmit(winner);
}

function scheduleWindowFinalize() {
  if (windowTimer || lockedTag) return;

  const elapsed = windowStartedAt ? Date.now() - windowStartedAt : 0;
  const remaining = Math.max(0, selectionWindowMs - elapsed);

  windowTimer = setTimeout(finalizeWindow, remaining);
  if (windowTimer.unref) windowTimer.unref();
}

function recordRawTag(payload) {
  const tag = String(payload?.tag || '').trim().toUpperCase();
  if (!tag) return;
  if (RfidBlocklistService.logIfBlocked(tag, 'selection')) return;

  const now = Date.now();
  const rssi = normalizeRssi(payload.rssi);
  const existing = windowTags.get(tag);

  if (!existing) {
    const entry = {
      bestRssi: rssi,
      readCount: 1,
      firstSeenAt: now,
      lastPayload: { ...payload, tag, timestamp: payload.timestamp || ts.now() },
    };
    windowTags.set(tag, entry);
  } else {
    existing.readCount += 1;
    if (rssi != null && (existing.bestRssi == null || rssi > existing.bestRssi)) {
      existing.bestRssi = rssi;
      existing.lastPayload = { ...payload, tag, timestamp: payload.timestamp || ts.now() };
    } else {
      existing.lastPayload = { ...payload, tag, timestamp: payload.timestamp || ts.now() };
    }
  }

  if (!windowStartedAt) windowStartedAt = now;
  scheduleWindowFinalize();
}

const RfidTagSelector = {
  onSelected(callback) {
    selectedCallback = callback;
  },

  onRawTag(payload) {
    if (lockedTag) return;
    recordRawTag(payload);
  },

  lock(tag, payload = null) {
    const normalized = String(tag || '').trim().toUpperCase();
    if (!normalized) return;
    if (RfidBlocklistService.isBlocked(normalized)) return;
    if (lockedTag === normalized) return;

    lockedTag = normalized;
    lockedPayload = {
      tag: normalized,
      timestamp: ts.now(),
      locked: true,
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
    resetWindow();
    scheduleLockTimeout();
    logger.debug('RFID tag locked (manual)', { tag: lockedTag });
  },

  unlock() {
    if (!lockedTag) return;
    logger.debug('RFID tag unlocked', { tag: lockedTag });
    lockedTag = null;
    lockedPayload = null;
    clearLockTimeout();
    resetWindow();
  },

  isLocked() {
    return !!lockedTag;
  },

  getLockedTag() {
    return lockedTag;
  },

  getLockedPayload() {
    return lockedPayload ? { ...lockedPayload } : null;
  },

  getSelectionWindowMs() {
    return selectionWindowMs;
  },
};

module.exports = RfidTagSelector;
