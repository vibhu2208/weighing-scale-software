'use strict';

const SettingsService = require('./SettingsService');
const logger = require('../utils/logger');

function normalizeTag(tag) {
  return String(tag || '').trim().toUpperCase();
}

function parseList(raw) {
  if (!raw || !String(raw).trim()) return new Set();
  const set = new Set();
  for (const part of String(raw).split(',')) {
    const t = normalizeTag(part);
    if (t) set.add(t);
  }
  return set;
}

const DEFAULT_EPC_PREFIX = 'E200';

let cachedRaw = null;
let cachedSet = null;
let cachedEpcPrefixRaw = null;
let cachedEpcPrefix = null;

function resolveEpcPrefixRaw() {
  let raw = '';
  try {
    raw = SettingsService.get('RFID_EPC_PREFIX');
  } catch (_e) {
    raw = '';
  }
  if (!String(raw || '').trim()) {
    raw = process.env.RFID_EPC_PREFIX || DEFAULT_EPC_PREFIX;
  }
  return raw;
}

function loadEpcPrefix() {
  const raw = resolveEpcPrefixRaw();
  if (raw === cachedEpcPrefixRaw && cachedEpcPrefix != null) return cachedEpcPrefix;
  cachedEpcPrefixRaw = raw;
  cachedEpcPrefix = normalizeTag(raw);
  return cachedEpcPrefix;
}

function matchesEpcSeries(tag) {
  const prefix = loadEpcPrefix();
  if (!prefix) return true;
  const normalized = normalizeTag(tag);
  return !!normalized && normalized.startsWith(prefix);
}

function resolveBlockedTagsRaw() {
  let raw = '';
  try {
    raw = SettingsService.get('RFID_BLOCKED_TAGS');
  } catch (_e) {
    raw = '';
  }
  if (!String(raw || '').trim()) {
    raw = process.env.RFID_BLOCKED_TAGS || '';
  }
  return raw;
}

function loadBlockedSet() {
  const raw = resolveBlockedTagsRaw();
  if (raw === cachedRaw && cachedSet) return cachedSet;
  cachedRaw = raw;
  cachedSet = parseList(raw);
  return cachedSet;
}

const RfidBlocklistService = {
  normalizeTag,

  getEpcPrefix() {
    return loadEpcPrefix();
  },

  matchesEpcSeries(tag) {
    return matchesEpcSeries(tag);
  },

  getBlockedTags() {
    return [...loadBlockedSet()];
  },

  isBlocked(tag) {
    const normalized = normalizeTag(tag);
    if (!normalized) return false;
    if (!matchesEpcSeries(normalized)) return true;
    return loadBlockedSet().has(normalized);
  },

  invalidateCache() {
    cachedRaw = null;
    cachedSet = null;
    cachedEpcPrefixRaw = null;
    cachedEpcPrefix = null;
  },

  logIfBlocked(tag, context = 'scan') {
    const normalized = normalizeTag(tag);
    if (!normalized) return false;
    if (!matchesEpcSeries(normalized)) {
      logger.debug('RFID tag ignored — wrong EPC series', {
        tag: normalized,
        expectedPrefix: loadEpcPrefix(),
        context,
      });
      return true;
    }
    if (!loadBlockedSet().has(normalized)) return false;
    logger.debug('RFID tag blocked', {
      tag: normalized,
      context,
    });
    return true;
  },
};

module.exports = RfidBlocklistService;
