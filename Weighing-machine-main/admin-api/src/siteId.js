'use strict';

/**
 * Weighbridge settings historically used "WB - 03" while admin-api .env uses "WB-03".
 * Mirror rows, S3 keys, and commands can exist under either spelling.
 */
function siteIdAliases(siteId) {
  const raw = String(siteId || '').trim();
  if (!raw) return ['WB-03', 'WB - 03'];
  const compact = raw.replace(/\s+/g, '');
  const match = compact.match(/^(WB)-?(\d+)$/i);
  if (!match) return [...new Set([raw, compact])];
  const prefix = match[1].toUpperCase();
  const num = match[2];
  return [...new Set([raw, compact, `${prefix}-${num}`, `${prefix} - ${num}`])];
}

module.exports = { siteIdAliases };
