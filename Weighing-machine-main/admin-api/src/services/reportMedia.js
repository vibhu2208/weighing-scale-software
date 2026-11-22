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

/**
 * Pick the photo key admin PDFs / Bulk UI should show.
 * Mirror first (Report Edit / Admin Reports truth). Empty mirror slots fall
 * back to remote_trips so Create-images keys still appear when mirror is blank.
 * Create-images vs stale weighbridge sites/ keys is enforced on write
 * (reconcile + upsertMirror), not by ignoring mirror edits here.
 */
function preferAdminPhotoKey(remoteKey, mirrorKey) {
  const remote = String(remoteKey || '').trim();
  const mirror = String(mirrorKey || '').trim();
  return mirror || remote || null;
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
 * Keeps remote id + gross-PDF cache columns; photo slots use preferAdminPhotoKey.
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
    // Normal PDF cache lane: prefer whichever side still has a fingerprint;
    // photo-key merge below drives invalidation when keys change.
    report_content_fp: remote.report_content_fp || mirror.report_content_fp,
    report_s3_key: mirror.report_s3_key || remote.report_s3_key,
  };
  for (const field of PHOTO_FIELDS) {
    merged[field] = preferAdminPhotoKey(remote[field], mirror[field]);
  }
  return merged;
}

/**
 * Resolve usable S3 photo keys for a trip row.
 * Fills from remote_trips + S3 listings when mirror columns are empty or point
 * at missing objects — same logic the edit UI uses for previews.
 *
 * @param {object} row
 * @param {{ verifyExists?: boolean }} [options]
 *   verifyExists (default true): HEAD each key. PDF generation sets false and
 *   relies on GetObject 404 instead (avoids HEAD+GET double round-trips).
 */
async function hydratePhotoKeys(row, options = {}) {
  if (!row) return row;
  const verifyExists = options.verifyExists !== false;
  const out = { ...row };

  try {
    const remote = await query(
      `SELECT arrival_photo_1, arrival_photo_2, arrival_photo_3,
              departure_photo_1, departure_photo_2, departure_photo_3,
              report_s3_key
       FROM remote_trips WHERE UPPER(slip_number) = UPPER($1) LIMIT 1`,
      [row.slip_number],
    );
    const remoteRow = remote.rows[0];
    if (remoteRow) {
      for (const field of PHOTO_FIELDS) {
        if (!out[field] && remoteRow[field]) out[field] = remoteRow[field];
      }
      if (!out.report_s3_key && remoteRow.report_s3_key) {
        out.report_s3_key = remoteRow.report_s3_key;
      }
    }
  } catch (_e) {
    /* remote_trips fallback is best-effort */
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

  const stillMissing = PHOTO_FIELDS.filter((field) => !out[field]);
  if (stillMissing.length && isConfigured() && out.slip_number) {
    const prefixes = [`remote-trips/${out.slip_number}/`];
    for (const siteId of siteIdAliases(getSiteId())) {
      prefixes.push(`sites/${siteId}/mirror/${out.slip_number}/`);
    }
    const listings = await Promise.all(prefixes.map((prefix) => listKeys(prefix, 40)));
    for (const listed of listings) {
      for (const key of listed) {
        if (!/\.(jpe?g|png|webp|gif)$/i.test(key)) continue;
        const field = inferPhotoFieldFromKey(key);
        if (field && !out[field]) out[field] = key;
      }
    }
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
        // Presign without a prior HEAD — broken keys simply fail at image load.
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
  MAX_MIRROR_SLIP_BATCH,
};
