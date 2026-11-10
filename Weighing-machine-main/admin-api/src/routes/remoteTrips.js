'use strict';

const express = require('express');
const archiver = require('archiver');
const { query, getSiteId } = require('../db');
const { authMiddleware } = require('../auth');
const {
  createRemoteTrip,
  importRemoteTrips,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
  resyncRemoteTrip,
  cancelRemoteTrip,
  deleteRemoteTrip,
} = require('../services/remoteTripService');
const { createCommand } = require('../services/commandService');
const { generateTripPdf } = require('../services/reportPdfService');
const { generateRemoteTripPhoto } = require('../services/tripImageService');
const { grossWeightTimestamp } = require('../services/vehicleReportHtml');
const { isConfigured, presignGet } = require('../services/s3Presign');
const { maxConcurrency } = require('../services/browserPool');
const {
  reportZipFilename,
  uniqueZipEntryName,
  calendarDateInTz,
} = require('../services/reportZipNames');

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

function thumbKeyFromPhotoKey(key) {
  if (!key || /\.thumb\.jpe?g$/i.test(key)) return key;
  return String(key).replace(/\.jpe?g$/i, '.thumb.jpg');
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

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
    const fullKey = out[col];
    const thumbKey = thumbKeyFromPhotoKey(fullKey);
    tasks.push(
      (async () => {
        try {
          out[`${col}_url`] = await presignGet(fullKey);
        } catch {
          out[`${col}_url`] = null;
        }
        try {
          // May 404 for older uploads without thumbs; UI falls back to full.
          out[`${col}_thumb_url`] = await presignGet(thumbKey);
        } catch {
          out[`${col}_thumb_url`] = null;
        }
      })(),
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

/**
 * Stream a ZIP of trip PDFs (server-side, STORE compression).
 * Body: { ids: string[], print?: 'gross' }
 */
router.post('/zip', async (req, res) => {
  let archive = null;
  try {
    const ids = Array.isArray(req.body?.ids)
      ? [
          ...new Set(
            req.body.ids
              .map((id) => String(id || '').trim())
              .filter((id) => id && id.length <= 80),
          ),
        ]
      : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'ids required' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ ok: false, error: 'Maximum 200 reports per zip' });
    }
    const printGross = String(req.body?.print || '') === 'gross';
    const siteId = getSiteId();
    const folder = `reports-${calendarDateInTz(new Date())}`;

    const concurrency = maxConcurrency();
    const failures = [];
    const filenameCounts = new Map();
    let archived = 0;
    let clientGone = false;

    req.on('close', () => {
      clientGone = true;
    });

    // Resolve trips + names first so -2/-3 suffixes are deterministic by time/slip.
    const resolved = [];
    for (const id of ids) {
      try {
        const trip = await getRemoteTrip(query, id);
        if (!trip) {
          failures.push(`${id}: not found`);
          continue;
        }
        resolved.push(trip);
      } catch (err) {
        failures.push(`${id}: ${err.message}`);
      }
    }
    resolved.sort((a, b) => {
      const ta = new Date(a.timestamp_out || a.timestamp_in || 0).getTime();
      const tb = new Date(b.timestamp_out || b.timestamp_in || 0).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.slip_number || '').localeCompare(String(b.slip_number || ''));
    });
    const jobs = resolved.map((trip) => {
      const baseName = reportZipFilename(
        trip.truck_number,
        trip.timestamp_out || trip.timestamp_in,
      );
      return {
        trip,
        name: uniqueZipEntryName(baseName, filenameCounts),
      };
    });

    function ensureArchive() {
      if (archive) return archive;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${folder}.zip"`,
      );
      archive = archiver('zip', { store: true });
      archive.on('error', (err) => {
        console.error('[remoteTrips.zip]', err);
        try {
          res.destroy(err);
        } catch {
          /* ignore */
        }
      });
      archive.pipe(res);
      return archive;
    }

    await mapPool(jobs, concurrency, async (job) => {
      if (clientGone) return;
      try {
        const built = await generateTripPdf(job.trip, {
          siteId,
          upload: true,
          grossPrint: printGross,
          printAt: printGross ? grossWeightTimestamp(job.trip) : undefined,
        });
        if (clientGone) return;
        ensureArchive().append(built.pdf, { name: `${folder}/${job.name}` });
        archived += 1;
      } catch (err) {
        failures.push(`${job.trip.slip_number || job.trip.id}: ${err.message}`);
      }
    });

    if (clientGone) {
      try {
        if (archive) archive.abort();
      } catch {
        /* ignore */
      }
      return;
    }

    if (!archived) {
      return res.status(500).json({
        ok: false,
        error: failures[0] || 'No PDFs could be generated for zip',
        failures,
      });
    }

    if (failures.length) {
      ensureArchive().append(
        `archived=${archived}\nfailures=${failures.length}\n${failures.join('\n')}\n`,
        { name: `${folder}/_errors.txt` },
      );
    }
    await ensureArchive().finalize();
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    try {
      if (archive) archive.abort();
    } catch {
      /* ignore */
    }
    try {
      res.destroy(err);
    } catch {
      /* ignore */
    }
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const trip = await getRemoteTrip(query, req.params.id);
    if (!trip) return res.status(404).json({ ok: false, error: 'Not found' });

    const siteId = getSiteId();
    const filename = `${trip.slip_number}_report.pdf`;
    const printGross = String(req.query.print || '') === 'gross';

    const built = await generateTripPdf(trip, {
      siteId,
      upload: true,
      grossPrint: printGross,
      printAt: printGross ? grossWeightTimestamp(trip) : undefined,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (built.fromCache) res.setHeader('X-PDF-Cache', 'HIT');
    else res.setHeader('X-PDF-Cache', 'MISS');
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

router.post('/:id/generate-photo', async (req, res) => {
  try {
    const result = await generateRemoteTripPhoto(query, req.params.id, req.body || {});
    return res.json({
      ok: true,
      trip: await attachTripMedia(result.trip),
      slot: result.slot,
      pass: result.pass,
      key: result.key,
    });
  } catch (err) {
    const status = /Gemini image edit failed|timed out/.test(err.message) ? 502 : 400;
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

router.post('/:id/resync', async (req, res) => {
  try {
    const trip = await resyncRemoteTrip(query, req.params.id);
    return res.json({ ok: true, trip: await attachTripMedia(trip) });
  } catch (err) {
    const status = err.status || (/not found/i.test(err.message) ? 404 : 400);
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await cancelRemoteTrip(query, req.params.id, {
      allowAlreadyCancelled: true,
    });
    let localEditQueued = false;
    // Always queue PC cancel when we have a slip — including re-queue after a
    // failed/stuck prior command (cloud may already be CANCELLED).
    if (result.slip_number) {
      await createCommand({
        // Dedicated type so PC never runs cancel voids through weight validation.
        type: 'cancel_report',
        payload: {
          slipNumber: result.slip_number,
          cancel: true,
          ticket_status: 'CANCELLED',
          material: 'CANCEL',
          customer_name: 'CANCEL',
          destination: 'CANCEL',
          operator_name: 'CANCEL',
          company: 'CANCEL',
          gross_weight: 0,
          tare_weight: 0,
          truck_number: result.trip?.truck_number || 'CANCEL',
          timestamp_in: result.trip?.timestamp_in,
          timestamp_out: result.trip?.timestamp_out,
        },
        createdBy: req.user?.email,
      });
      localEditQueued = true;
    }
    return res.json({
      ok: true,
      trip: await attachTripMedia(result.trip),
      localEditQueued,
      requeued: Boolean(result.alreadyCancelled),
    });
  } catch (err) {
    const status = err.status || (/not found/i.test(err.message) ? 404 : 400);
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteRemoteTrip(query, req.params.id);
    let localDeleteQueued = false;
    // Always ask the PC to purge any local copy — even if cloud said Pending
    // (e.g. after Resync). Soft-delete alone can leave remote_pg_id linked and
    // a later sync pass can make the ticket look active again.
    if (result.slip_number) {
      await createCommand({
        type: 'delete_report',
        payload: { slipNumber: result.slip_number, purge: true },
        createdBy: req.user?.email,
      });
      localDeleteQueued = true;
    }
    return res.json({
      ok: true,
      deleted: true,
      slip_number: result.slip_number,
      localDeleteQueued,
      wasSynced: result.wasSynced,
    });
  } catch (err) {
    const status = err.status || (/not found/i.test(err.message) ? 404 : 500);
    return res.status(status).json({ ok: false, error: err.message });
  }
});

module.exports = router;
