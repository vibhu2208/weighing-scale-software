'use strict';

/**
 * Parse settings list values (JSON array or comma-separated).
 * Used when cloud sync applies materials/customers/destinations/operators/companies.
 */
function parseOptionListValue(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || '').trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || '').trim()).filter(Boolean);
    }
  } catch (_e) {
    /* fall through */
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Union local + remote option lists (case-insensitive).
 * Keeps local names first so weighbridge-added destinations are not wiped by a
 * shorter cloud list (e.g. Fill Blocked Slips overwriting destinations_list).
 */
function mergeOptionListValues(localRaw, remoteRaw) {
  const out = [];
  const seen = new Set();
  for (const name of [...parseOptionListValue(localRaw), ...parseOptionListValue(remoteRaw)]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return JSON.stringify(out);
}

module.exports = {
  parseOptionListValue,
  mergeOptionListValues,
};
