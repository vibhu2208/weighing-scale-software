'use strict';

const REMOTE_SAFE_KEYS = new Set([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
  'COMPANY_NAME',
  'COMPANY_ADDRESS',
  'COMPANY_PHONE',
  'SITE_NAME',
  'WEIGHBRIDGE_ID',
  'REPORT_COMPANY_NAME',
  'REPORT_LOGO_PATH',
  'materials_list',
  'customers_list',
  'destinations_list',
  'operators_list',
]);

const LIST_KEYS = {
  materials: 'materials_list',
  customers: 'customers_list',
  destinations: 'destinations_list',
  operators: 'operators_list',
};

function assertRemoteKey(key) {
  if (!REMOTE_SAFE_KEYS.has(key)) {
    throw new Error(`Setting key not allowed remotely: ${key}`);
  }
}

function parseListValue(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function serializeListValue(items) {
  return JSON.stringify(Array.isArray(items) ? items : []);
}

module.exports = {
  REMOTE_SAFE_KEYS,
  LIST_KEYS,
  assertRemoteKey,
  parseListValue,
  serializeListValue,
};
