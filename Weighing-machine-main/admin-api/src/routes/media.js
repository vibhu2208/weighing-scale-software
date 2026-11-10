'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const { getSiteId } = require('../db');
const {
  presignGet,
  presignPut,
  putObject,
  mirrorPhotoKey,
  remoteTripPhotoKey,
  fillVehicleStillKey,
  isConfigured,
} = require('../services/s3Presign');

const PLATE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4}$/;

const router = express.Router();
router.use(authMiddleware);

function parseImageBuffer(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('imageBase64 is required');
  }
  const match = imageBase64.match(/^data:image\/[\w+.-]+;base64,(.+)$/);
  const raw = match ? match[1] : imageBase64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('Invalid image data');
  return buf;
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
    const body = parseImageBuffer(imageBase64);
    await putObject(key, body, contentType || 'image/jpeg');
    return res.json({ ok: true, key, slot: slotNum, pass: photoPass });
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
    const body = parseImageBuffer(imageBase64);
    await putObject(key, body, contentType || 'image/jpeg');
    return res.json({ ok: true, key, slot: slotNum, pass: photoPass });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
