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
};
