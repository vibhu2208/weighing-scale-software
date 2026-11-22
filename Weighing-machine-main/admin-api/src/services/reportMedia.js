'use strict';

const { query, getSiteId } = require('../db');
const {
  isConfigured,
  objectExists,
  listKeys,
  inferPhotoFieldFromKey,
  presignGet,
} = require('./s3Presign');
const { siteIdAliases } = require('../siteId');
const { PHOTO_SCORE_SQL } = require('./reportQuery');
const {
  preferLastWritePhotoKey,
  pickNewestPhotoKey,
  photoKeyWriteTime,
  isVersionedAdminMirrorKey,
} = require('./adminPhotoKeys');
const { clearPdfFingerprints } = require('./pdfContentCache');

const PHOTO_FIELDS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

/** Soft cap so a bad caller cannot build an unbounded IN-list. */
const MAX_MIRROR_SLIP_BATCH = 250;

/** @deprecated use preferLastWritePhotoKey — kept as alias for tests/callers */
function preferAdminPhotoKey(remoteKey, mirrorKey, opts = {}) {
  return preferLastWritePhotoKey(remoteKey, mirrorKey, opts);
}

/**
 * Best mirror row per slip (most photo columns filled), keyed by UPPER(slip).
 * Used so Bulk zip / remote PDFs see Report Edit photos the same way as
 * GET /reports/:slip/pdf.
 */
async function loadBestMirrorBySlips(slips, siteId = getSiteId()) {
  const list = [
    ...new Set(
      (slips || [])
        .map((s) => String(s || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_MIRROR_SLIP_BATCH);
  const map = new Map();
  if (!list.length) return map;

  const result = await query(
    `SELECT DISTINCT ON (UPPER(slip_number)) *
     FROM transactions_mirror
     WHERE site_id = ANY($1::text[])
       AND UPPER(slip_number) = ANY($2::text[])
     ORDER BY UPPER(slip_number), ${PHOTO_SCORE_SQL} DESC`,
    [siteIdAliases(siteId), list],
  );
  for (const row of result.rows || []) {
    map.set(String(row.slip_number || '').trim().toUpperCase(), row);
  }
  return map;
}

/**
 * Merge remote_trips + transactions_mirror for admin PDF / Bulk Photos.
 * Keeps remote id + gross-PDF cache columns; photo slots use last-write-wins.
 */
function mergeRemoteWithMirror(remote, mirror) {
  if (!mirror) return remote || null;
  if (!remote) return mirror;
  const merged = {
    ...remote,
    ...mirror,
    id: remote.id,
    report_gross_content_fp: remote.report_gross_content_fp,
    report_gross_s3_key: remote.report_gross_s3_key,
    report_content_fp: remote.report_content_fp || mirror.report_content_fp,
    report_s3_key: mirror.report_s3_key || remote.report_s3_key,
  };
  const timeOpts = {
    remoteUpdatedAt: remote.updated_at,
    mirrorUpdatedAt: mirror.updated_at,
  };
  for (const field of PHOTO_FIELDS) {
    merged[field] = preferLastWritePhotoKey(remote[field], mirror[field], timeOpts);
  }
  const remoteAt = Date.parse(remote.updated_at) || 0;
  const mirrorAt = Date.parse(mirror.updated_at) || 0;
  if (mirrorAt >= remoteAt && mirror.updated_at) merged.updated_at = mirror.updated_at;
  else if (remote.updated_at) merged.updated_at = remote.updated_at;
  return merged;
}

/**
 * List S3 keys for a slip and return the newest object per camera slot.
 * Recovers Report Edit versioned keys that DB rows lost after Create images /
 * reconcile overwrote columns back to older remote-trips/ keys.
 */
async function discoverNewestPhotoKeys(slipNumber) {
  const slip = String(slipNumber || '').trim();
  const found = {};
  if (!slip || !isConfigured()) return found;

  const prefixes = [`remote-trips/${slip}/`];
  for (const siteId of siteIdAliases(getSiteId())) {
    prefixes.push(`sites/${siteId}/mirror/${slip}/`);
  }
  const listings = await Promise.all(prefixes.map((prefix) => listKeys(prefix, 80)));
  const byField = {};
  for (const listed of listings) {
    for (const key of listed) {
      if (!key || /\.thumb\.jpe?g$/i.test(key)) continue;
      const field = inferPhotoFieldFromKey(key);
      if (!field || !PHOTO_FIELDS.includes(field)) continue;
      if (!byField[field]) byField[field] = [];
      byField[field].push(key);
    }
  }
  for (const field of PHOTO_FIELDS) {
    const newest = pickNewestPhotoKey(byField[field] || []);
    if (newest) found[field] = newest;
  }
  return found;
}

function shouldReplacePhotoKey(currentKey, discoveredKey) {
  const current = String(currentKey || '').trim();
  const next = String(discoveredKey || '').trim();
  if (!next) return false;
  if (!current) return true;
  if (current === next) return false;
  const curTs = photoKeyWriteTime(current);
  const nextTs = photoKeyWriteTime(next);
  if (nextTs > curTs) return true;
  // DB points at Create-images / stable PC path but a versioned Report Edit
  // object exists — restore the edit even if timestamps tied/unknown.
  if (isVersionedAdminMirrorKey(next) && !isVersionedAdminMirrorKey(current)) {
    if (!curTs || nextTs >= curTs) return true;
  }
  return false;
}

/**
 * Persist recovered photo keys so Reports list / Bulk / zip all stay aligned.
 */
async function persistRecoveredPhotoKeys(slipNumber, updates) {
  const slip = String(slipNumber || '').trim();
  const entries = Object.entries(updates || {}).filter(([, v]) => v);
  if (!slip || !entries.length) return;

  const values = entries.map(([, v]) => v);
  const mirrorSets = entries.map(([col], i) => `${col} = $${i + 2}`);
  const mirrorSlipIdx = entries.length + 2;
  try {
    await query(
      `UPDATE transactions_mirror
       SET ${mirrorSets.join(', ')}, updated_at = now()
       WHERE site_id = ANY($1::text[]) AND UPPER(slip_number) = UPPER($${mirrorSlipIdx})`,
      [siteIdAliases(getSiteId()), ...values, slip],
    );
  } catch (err) {
    console.warn('[reportMedia] mirror photo restore failed', slip, err.message);
  }
  try {
    const rtSets = entries.map(([col], i) => `${col} = $${i + 2}`);
    await query(
      `UPDATE remote_trips
       SET ${rtSets.join(', ')}, updated_at = now()
       WHERE UPPER(slip_number) = UPPER($1)`,
      [slip, ...values],
    );
  } catch (err) {
    console.warn('[reportMedia] remote_trips photo restore failed', slip, err.message);
  }
  try {
    await clearPdfFingerprints(query, slip, getSiteId());
  } catch (_e) {
    /* best-effort */
  }
}

/**
 * Resolve usable S3 photo keys for a trip row.
 * Always scans S3 for newer versioned Report Edit / Create-images objects so
 * manual edits are restored after a later process pointed DB columns at older keys.
 *
 * @param {object} row
 * @param {{ verifyExists?: boolean, persistRecovery?: boolean }} [options]
 */
async function hydratePhotoKeys(row, options = {}) {
  if (!row) return row;
  const verifyExists = options.verifyExists !== false;
  const persistRecovery = options.persistRecovery !== false;
  const out = { ...row };

  try {
    const remote = await query(
      `SELECT arrival_photo_1, arrival_photo_2, arrival_photo_3,
              departure_photo_1, departure_photo_2, departure_photo_3,
              report_s3_key, updated_at
       FROM remote_trips WHERE UPPER(slip_number) = UPPER($1) LIMIT 1`,
      [row.slip_number],
    );
    const remoteRow = remote.rows[0];
    if (remoteRow) {
      for (const field of PHOTO_FIELDS) {
        out[field] = preferLastWritePhotoKey(remoteRow[field], out[field], {
          remoteUpdatedAt: remoteRow.updated_at,
          mirrorUpdatedAt: out.updated_at,
        });
      }
      if (!out.report_s3_key && remoteRow.report_s3_key) {
        out.report_s3_key = remoteRow.report_s3_key;
      }
    }
  } catch (_e) {
    /* remote_trips fallback is best-effort */
  }

  const recovered = {};
  if (isConfigured() && out.slip_number) {
    try {
      const discovered = await discoverNewestPhotoKeys(out.slip_number);
      for (const field of PHOTO_FIELDS) {
        const next = discovered[field];
        if (shouldReplacePhotoKey(out[field], next)) {
          recovered[field] = next;
          out[field] = next;
        } else if (!out[field] && next) {
          recovered[field] = next;
          out[field] = next;
        }
      }
    } catch (err) {
      console.warn('[reportMedia] S3 photo discovery failed', out.slip_number, err.message);
    }
  }

  if (verifyExists && isConfigured()) {
    await Promise.all(
      PHOTO_FIELDS.map(async (field) => {
        const key = out[field];
        if (!key) return;
        try {
          if (!(await objectExists(key))) out[field] = null;
        } catch {
          out[field] = null;
        }
      }),
    );
  }

  if (persistRecovery && Object.keys(recovered).length) {
    console.log('[reportMedia] restored newer admin photos', {
      slip: out.slip_number,
      fields: Object.keys(recovered),
    });
    persistRecoveredPhotoKeys(out.slip_number, recovered).catch(() => {});
  }

  return out;
}

/**
 * Upgrade a merged trip row from S3 discovery (Bulk list / zip) without
 * requiring a full hydrate HEAD pass.
 */
async function recoverPhotoKeysFromS3(row, options = {}) {
  if (!row?.slip_number || !isConfigured()) return row;
  const out = { ...row };
  const recovered = {};
  try {
    const discovered = await discoverNewestPhotoKeys(out.slip_number);
    for (const field of PHOTO_FIELDS) {
      const next = discovered[field];
      if (shouldReplacePhotoKey(out[field], next) || (!out[field] && next)) {
        recovered[field] = next;
        out[field] = next;
      }
    }
  } catch (err) {
    console.warn('[reportMedia] recoverPhotoKeysFromS3 failed', out.slip_number, err.message);
    return row;
  }
  if (options.persistRecovery !== false && Object.keys(recovered).length) {
    console.log('[reportMedia] restored newer admin photos', {
      slip: out.slip_number,
      fields: Object.keys(recovered),
    });
    persistRecoveredPhotoKeys(out.slip_number, recovered).catch(() => {});
  }
  return out;
}

async function attachMediaUrls(row) {
  const hydrated = await hydratePhotoKeys(row);
  if (!hydrated || !isConfigured()) return hydrated;
  const out = { ...hydrated };
  await Promise.all(
    PHOTO_FIELDS.map(async (field) => {
      const key = out[field];
      if (!key) return;
      try {
        out[`${field}_url`] = await presignGet(key);
      } catch {
        out[`${field}_url`] = null;
      }
    }),
  );
  if (out.report_s3_key) {
    try {
      out.report_url = await presignGet(out.report_s3_key);
    } catch {
      out.report_url = null;
    }
  }
  return out;
}

module.exports = {
  PHOTO_FIELDS,
  hydratePhotoKeys,
  attachMediaUrls,
  loadBestMirrorBySlips,
  mergeRemoteWithMirror,
  preferAdminPhotoKey,
  recoverPhotoKeysFromS3,
  discoverNewestPhotoKeys,
  MAX_MIRROR_SLIP_BATCH,
};
