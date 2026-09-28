'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const {
  ensureSchema,
  getCounterHint,
  planReservations,
  listReservations,
  getSummary,
  releaseReservation,
  fireReservationNow,
  FIRE_EARLY_MINUTES,
  MISS_AFTER_MINUTES,
} = require('../services/slipReservationService');

const router = express.Router();
router.use(authMiddleware);

router.get('/hint', async (_req, res) => {
  try {
    await ensureSchema();
    const hint = await getCounterHint();
    return res.json({
      ok: true,
      hint,
      fire_early_minutes: FIRE_EARLY_MINUTES,
      miss_after_minutes: MISS_AFTER_MINUTES,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const [rows, summary] = await Promise.all([
      listReservations(req.query || {}),
      getSummary(),
    ]);
    return res.json({ ok: true, rows, summary });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/plan', async (req, res) => {
  try {
    const createdBy = req.user?.email || req.user?.id || null;
    const result = await planReservations(req.body || {}, createdBy);
    const rows = Array.isArray(result) ? result : result.rows || [];
    const adjustments = Array.isArray(result) ? [] : result.adjustments || [];
    return res.status(201).json({
      ok: true,
      rows,
      count: rows.length,
      adjustments,
      fire_early_minutes: FIRE_EARLY_MINUTES,
    });
  } catch (err) {
    const status = /required|Invalid|Maximum|at least|Provide|more than 1 minute|apart|free minute/i.test(
      err.message,
    )
      ? 400
      : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.post('/:id/fire', async (req, res) => {
  try {
    const row = await fireReservationNow(req.params.id);
    return res.json({ ok: true, row });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

router.post('/:id/release', async (req, res) => {
  try {
    const row = await releaseReservation(req.params.id);
    return res.json({ ok: true, row });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

module.exports = router;
