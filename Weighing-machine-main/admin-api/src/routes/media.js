'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const { getSiteId, query } = require('../db');
const {
  presignGet,
  presignPut,
  putObject,
  copyObject,
  getObjectBuffer,
  mirrorPhotoKey,
  mirrorPhotoThumbKey,
  remoteTripPhotoKey,
  remoteTripPhotoThumbKey,
  fillVehicleStillKey,
  isConfigured,
} = require('../services/s3Presign');
const { clearPdfFingerprints } = require('../services/pdfContentCache');

const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;

const router = express.Router();
router.use(authMiddleware);

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 MB decoded image cap

function parseImageBuffer(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('imageBase64 is required');
  }
  if (imageBase64.length > MAX_UPLOAD_BYTES * 1.4) {
    throw new Error('Image too large (max 12 MB)');
  }
  const match = imageBase64.match(/^data:image\/[\w+.-]+;base64,(.+)$/);
  const raw = match ? match[1] : imageBase64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('Invalid image data');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error('Image too large (max 12 MB)');
  }
  return buf;
}

/** Small JPEG for list grids — original stays untouched for PDFs. */
async function writePhotoThumb(fullKey, body, thumbKey) {
  try {
    const sharp = require('sharp');
    const thumb = await sharp(body)
      .rotate()
      .resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
    await putObject(thumbKey || fullKey.replace(/\.jpe?g$/i, '.thumb.jpg'), thumb, 'image/jpeg');
  } catch (err) {
    console.warn('[media] thumb skipped', err.message);
  }
}

router.get('/presign', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    const url = await presignGet(key);
    return res.json({ ok: true, url, key });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/upload-url', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const siteId = getSiteId();
    const { slip, slot, contentType, pass } = req.body || {};
    const slipNum = String(slip || '').trim();
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!slipNum || !Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = mirrorPhotoKey(siteId, slipNum, slotNum, photoPass);
    const url = await presignPut(key, contentType || 'image/jpeg');
    return res.json({ ok: true, uploadUrl: url, key });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/remote-trip-upload-url', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { slip, slot, contentType, pass } = req.body || {};
    const slipNum = String(slip || '').trim();
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!slipNum || !Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = remoteTripPhotoKey(slipNum, slotNum, photoPass);
    const url = await presignPut(key, contentType || 'image/jpeg');
    return res.json({ ok: true, uploadUrl: url, key });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Browser uploads via API (avoids S3 CORS "Failed to fetch"). */
router.post('/remote-trip-upload', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { slip, slot, contentType, pass, imageBase64 } = req.body || {};
    const slipNum = String(slip || '').trim();
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!slipNum || !Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = remoteTripPhotoKey(slipNum, slotNum, photoPass);
    const thumbKey = remoteTripPhotoThumbKey(slipNum, slotNum, photoPass);
    const body = parseImageBuffer(imageBase64);
    await putObject(key, body, contentType || 'image/jpeg');
    await writePhotoThumb(key, body, thumbKey);
    await clearPdfFingerprints(query, slipNum).catch(() => {});
    return res.json({ ok: true, key, thumbKey, slot: slotNum, pass: photoPass });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Build/refresh a list thumb after a direct S3 PUT upload. */
router.post('/remote-trip-thumb', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const key = String(req.body?.key || '').trim();
    if (!key.startsWith('remote-trips/') && !key.startsWith('sites/')) {
      return res.status(400).json({ ok: false, error: 'key not allowed' });
    }
    const body = await getObjectBuffer(key);
    if (!body) return res.status(404).json({ ok: false, error: 'object not found' });
    const thumbKey = key.replace(/\.jpe?g$/i, '.thumb.jpg');
    await writePhotoThumb(key, body, thumbKey);
    return res.json({ ok: true, key, thumbKey });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Original weighbridge stills for a fill vehicle (arrival/departure cam 1 and 2). */
router.post('/fill-vehicle-still', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { plate, slot, contentType, pass, imageBase64 } = req.body || {};
    const truck = String(plate || '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' || pass === 'departure' ? pass : '';
    if (!PLATE_RE.test(truck) || (slotNum !== 1 && slotNum !== 2) || !photoPass) {
      return res.status(400).json({
        ok: false,
        error: 'plate, pass (arrival|departure), and slot (1-2) required',
      });
    }
    const key = fillVehicleStillKey(truck, photoPass, slotNum);
    const body = parseImageBuffer(imageBase64);
    await putObject(key, body, contentType || 'image/jpeg');
    const url = await presignGet(key);
    return res.json({ ok: true, key, url, slot: slotNum, pass: photoPass });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

/**
 * Server-side S3 copy for mapped bulk-photo slots (same bytes, new key).
 * Avoids re-uploading the same base64 image for AC1→AC1+AC2 style mappings.
 */
router.post('/remote-trip-copy', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { sourceKey, slip, slot, pass } = req.body || {};
    const slipNum = String(slip || '').trim();
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    const fromKey = String(sourceKey || '').trim();
    if (!fromKey || !slipNum || !Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({
        ok: false,
        error: 'sourceKey, slip, and slot (1-3) required',
      });
    }
    if (!fromKey.startsWith('remote-trips/') && !fromKey.startsWith('sites/')) {
      return res.status(400).json({ ok: false, error: 'sourceKey not allowed' });
    }
    const key = remoteTripPhotoKey(slipNum, slotNum, photoPass);
    const thumbKey = remoteTripPhotoThumbKey(slipNum, slotNum, photoPass);
    await copyObject(fromKey, key);
    const fromThumb = fromKey.replace(/\.jpe?g$/i, '.thumb.jpg');
    try {
      await copyObject(fromThumb, thumbKey);
    } catch {
      /* source may predate thumbs */
    }
    await clearPdfFingerprints(query, slipNum).catch(() => {});
    return res.json({ ok: true, key, thumbKey, slot: slotNum, pass: photoPass, copiedFrom: fromKey });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** Mirror/report-edit uploads via API (avoids S3 CORS). */
router.post('/upload', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const siteId = getSiteId();
    const { slip, slot, contentType, pass, imageBase64 } = req.body || {};
    const slipNum = String(slip || '').trim();
    const slotNum = Number(slot);
    const photoPass = pass === 'arrival' ? 'arrival' : 'departure';
    if (!slipNum || !Number.isFinite(slotNum) || slotNum < 1 || slotNum > 3) {
      return res.status(400).json({ ok: false, error: 'slip and slot (1-3) required' });
    }
    const key = mirrorPhotoKey(siteId, slipNum, slotNum, photoPass);
    const thumbKey = mirrorPhotoThumbKey(siteId, slipNum, slotNum, photoPass);
    const body = parseImageBuffer(imageBase64);
    await putObject(key, body, contentType || 'image/jpeg');
    await writePhotoThumb(key, body, thumbKey);
    await clearPdfFingerprints(query, slipNum, siteId).catch(() => {});
    return res.json({ ok: true, key, thumbKey, slot: slotNum, pass: photoPass });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
