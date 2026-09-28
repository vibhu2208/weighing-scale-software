'use strict';

const express = require('express');
const { query, getSiteId } = require('../db');
const { authMiddleware } = require('../auth');
const {
  createRemoteTrip,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
} = require('../services/remoteTripService');
const { generateTripPdf } = require('../services/reportPdfService');
const { isConfigured, presignGet } = require('../services/s3Presign');

const router = express.Router();
router.use(authMiddleware);

async function attachTripMedia(row) {
  if (!row || !isConfigured()) return row;
  const out = { ...row };
  if (out.report_s3_key) {
    try {
      out.report_url = await presignGet(out.report_s3_key);
    } catch {
      out.report_url = null;
    }
  }
  const photoCols = [
    'arrival_photo_1',
    'arrival_photo_2',
    'arrival_photo_3',
    'departure_photo_1',
    'departure_photo_2',
    'departure_photo_3',
  ];
  out.has_photos = photoCols.some((c) => Boolean(out[c]));
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
    const built = await generateTripPdf(trip, { siteId, upload: true });

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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${built.filename}"`,
    );
    return res.send(built.pdf);
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
