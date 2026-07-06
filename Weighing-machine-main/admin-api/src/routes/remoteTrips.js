'use strict';

const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../auth');
const {
  createRemoteTrip,
  listRemoteTrips,
  getRemoteTrip,
  attachPhotos,
} = require('../services/remoteTripService');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const rows = await listRemoteTrips(query, req.query || {});
    return res.json({ ok: true, rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await getRemoteTrip(query, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    return res.json({ ok: true, trip: row });
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
