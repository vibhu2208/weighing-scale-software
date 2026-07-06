'use strict';

const { query, getSiteId } = require('../db');
const { REMOTE_SAFE_KEYS, LIST_KEYS, assertRemoteKey, parseListValue, serializeListValue } = require('../constants');

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
  return map;
}

async function putAdvanceSettings(values = {}, updatedBy) {
  const siteId = getSiteId();
  const keys = Object.keys(values);
  if (!keys.length) throw new Error('No settings provided');

  for (const key of keys) {
    assertRemoteKey(key);
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
