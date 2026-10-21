'use strict';

const express = require('express');
const { query, getSiteId } = require('../db');
const { authMiddleware } = require('../auth');
const {
  createRemoteTrip,
  importRemoteTrips,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
} = require('../services/remoteTripService');
const { generateTripPdf } = require('../services/reportPdfService');
const { grossWeightTimestamp } = require('../services/vehicleReportHtml');
const { isConfigured, presignGet, getObjectBuffer, mirrorReportKey } = require('../services/s3Presign');

const router = express.Router();
router.use(authMiddleware);

const PHOTO_COLS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

async function attachTripMedia(row) {
  if (!row) return row;
  const out = { ...row };
  out.has_photos = PHOTO_COLS.some((c) => Boolean(out[c]));
  if (!isConfigured()) return out;

  const tasks = [];
  if (out.report_s3_key) {
    tasks.push(
      presignGet(out.report_s3_key)
        .then((url) => {
          out.report_url = url;
        })
        .catch(() => {
          out.report_url = null;
        }),
    );
  }
  for (const col of PHOTO_COLS) {
    if (!out[col]) continue;
    tasks.push(
      presignGet(out[col])
        .then((url) => {
          out[`${col}_url`] = url;
        })
        .catch(() => {
          out[`${col}_url`] = null;
        }),
    );
  }
  if (tasks.length) await Promise.all(tasks);
  return out;
}

router.get('/', async (req, res) => {
  try {
    const rows = await listRemoteTrips(query, req.query || {});
    const withMedia = await Promise.all(rows.map(attachTripMedia));
    return res.json({ ok: true, rows: withMedia });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const trip = await getRemoteTrip(query, req.params.id);
    if (!trip) return res.status(404).json({ ok: false, error: 'Not found' });

    const siteId = getSiteId();
    const filename = `${trip.slip_number}_report.pdf`;
    const printGross = String(req.query.print || '') === 'gross';
    let pdf = null;

    if (!printGross) {
      const existingKeys = [trip.report_s3_key, mirrorReportKey(siteId, trip.slip_number)].filter(
        Boolean,
      );
      for (const key of existingKeys) {
        try {
          // eslint-disable-next-line no-await-in-loop
          pdf = await getObjectBuffer(key);
        } catch {
          pdf = null;
        }
        if (pdf) break;
      }
    }

    if (!pdf) {
      const built = await generateTripPdf(trip, {
        siteId,
        upload: true,
        printAt: printGross ? grossWeightTimestamp(trip) : undefined,
      });
      pdf = built.pdf;
      if (built.report_s3_key) {
        await query(`UPDATE remote_trips SET report_s3_key = $2 WHERE id = $1`, [
          trip.id,
          built.report_s3_key,
        ]);
        await query(
          `UPDATE transactions_mirror
           SET report_s3_key = $3, updated_at = now()
           WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)`,
          [siteId, trip.slip_number, built.report_s3_key],
        );
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdf);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await getRemoteTrip(query, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true, trip: await attachTripMedia(row) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/bulk', async (req, res) => {
  try {
    const body = req.body || {};
    const trips = Array.isArray(body) ? body : body.trips;
    const dryRun = body.dry_run === true || body.dry_run === 'true';
    const result = await importRemoteTrips(query, trips, { dryRun });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const trip = await createRemoteTrip(query, req.body || {});
    return res.status(201).json({ ok: true, trip });
  } catch (err) {
    const status = err.message.includes('duplicate') || err.message.includes('unique') ? 409 : 400;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.patch('/:id/photos', async (req, res) => {
  try {
    const trip = await attachPhotos(query, req.params.id, req.body?.photoS3Keys || []);
    return res.json({ ok: true, trip });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
