'use strict';

const { query, getSiteId } = require('../db');
const { REMOTE_SAFE_KEYS, LIST_KEYS, assertRemoteKey, parseListValue, serializeListValue } = require('../constants');

const WEIGHT_UI_KEYS = new Set([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function getWeightFeatureStatus() {
  const siteId = getSiteId();
  const res = await query(
    `SELECT key, value FROM site_settings
     WHERE site_id = $1 AND key IN (
       'WEIGHT_ADJUSTMENT_FEATURE_START_AT',
       'WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS',
       'WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES'
     )`,
    [siteId],
  );
  const map = {};
  for (const row of res.rows) map[row.key] = row.value;
  const startRaw = map.WEIGHT_ADJUSTMENT_FEATURE_START_AT;
  const days = Math.max(1, parseInt(map.WEIGHT_ADJUSTMENT_AUTO_DISABLE_DAYS || '3', 10) || 3);
  const minutes = Math.max(0, parseInt(map.WEIGHT_ADJUSTMENT_AUTO_DISABLE_MINUTES || '0', 10) || 0);
  const windowMs = minutes > 0 ? minutes * 60 * 1000 : days * MS_PER_DAY;
  if (!startRaw) {
    return { available: true, expired: false, days, minutes: minutes || null };
  }
  const start = new Date(startRaw);
  if (Number.isNaN(start.getTime())) {
    return { available: true, expired: false, days, minutes: minutes || null };
  }
  const expired = Date.now() - start.getTime() >= windowMs;
  return {
    available: !expired,
    expired,
    days,
    minutes: minutes || null,
    featureStartAt: start.toISOString(),
  };
}

async function getAdvanceSettings() {
  const siteId = getSiteId();
  const res = await query(
    'SELECT key, value, updated_at FROM site_settings WHERE site_id = $1',
    [siteId],
  );
  const map = {};
  for (const row of res.rows) {
    if (REMOTE_SAFE_KEYS.has(row.key)) {
      map[row.key] = row.value;
    }
  }
  const feature = await getWeightFeatureStatus();
  map.WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE = feature.available ? 'true' : 'false';
  if (!feature.available) {
    delete map.WEIGHT_ADJUSTMENT_ENABLED;
    delete map.WEIGHT_OFFSET_KG;
  }
  return map;
}

async function putAdvanceSettings(values = {}, updatedBy) {
  const siteId = getSiteId();
  const keys = Object.keys(values);
  if (!keys.length) throw new Error('No settings provided');

  const feature = await getWeightFeatureStatus();
  for (const key of keys) {
    if (key === 'WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE') continue;
    if (key === 'WEIGHT_ADJUSTMENT_FEATURE_START_AT') {
      throw new Error('Feature start time cannot be changed remotely');
    }
    assertRemoteKey(key);
    if (WEIGHT_UI_KEYS.has(key) && !feature.available) {
      throw new Error('Technical error: WEIGHT_ADJUSTMENT-error');
    }
    await query(
      `INSERT INTO site_settings (site_id, key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (site_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [siteId, key, String(values[key] ?? ''), updatedBy || null],
    );
  }
  return getAdvanceSettings();
}

async function getList(name) {
  const key = LIST_KEYS[name];
  if (!key) throw new Error('Unknown list name');
  const siteId = getSiteId();
  const res = await query(
    'SELECT value FROM site_settings WHERE site_id = $1 AND key = $2',
    [siteId, key],
  );
  return parseListValue(res.rows[0]?.value);
}

async function putList(name, items, updatedBy) {
  const key = LIST_KEYS[name];
  if (!key) throw new Error('Unknown list name');
  assertRemoteKey(key);
  const siteId = getSiteId();
  await query(
    `INSERT INTO site_settings (site_id, key, value, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (site_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [siteId, key, serializeListValue(items), updatedBy || null],
  );
  return parseListValue(serializeListValue(items));
}

module.exports = {
  getAdvanceSettings,
  putAdvanceSettings,
  getList,
  putList,
};
