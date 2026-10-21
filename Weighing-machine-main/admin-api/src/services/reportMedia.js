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

const PHOTO_FIELDS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

/**
 * Resolve usable S3 photo keys for a trip row.
 * Fills from remote_trips + S3 listings when mirror columns are empty or point
 * at missing objects — same logic the edit UI uses for previews.
 */
async function hydratePhotoKeys(row) {
  if (!row) return row;
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

  if (isConfigured()) {
    for (const field of PHOTO_FIELDS) {
      const key = out[field];
      if (!key) continue;
      try {
        if (!(await objectExists(key))) out[field] = null;
      } catch {
        out[field] = null;
      }
    }
  }

  const stillMissing = PHOTO_FIELDS.filter((field) => !out[field]);
  if (stillMissing.length && isConfigured() && out.slip_number) {
    const prefixes = [`remote-trips/${out.slip_number}/`];
    for (const siteId of siteIdAliases(getSiteId())) {
      prefixes.push(`sites/${siteId}/mirror/${out.slip_number}/`);
    }
    for (const prefix of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await listKeys(prefix, 40);
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
  for (const field of PHOTO_FIELDS) {
    const key = out[field];
    if (!key) continue;
    try {
      if (!(await objectExists(key))) {
        out[field] = null;
        out[`${field}_url`] = null;
        continue;
      }
      out[`${field}_url`] = await presignGet(key);
    } catch {
      out[`${field}_url`] = null;
    }
  }
  if (out.report_s3_key) {
    try {
      if (await objectExists(out.report_s3_key)) {
        out.report_url = await presignGet(out.report_s3_key);
      } else {
        out.report_url = null;
      }
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
};
