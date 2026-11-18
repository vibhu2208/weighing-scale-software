'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const {
  getAdvanceSettings,
  putAdvanceSettings,
  getList,
  putList,
} = require('../services/settingsService');

const router = express.Router();
router.use(authMiddleware);

router.get('/advance', async (_req, res) => {
  try {
    const settings = await getAdvanceSettings();
    return res.json({ ok: true, settings });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.put('/advance', async (req, res) => {
  try {
    const settings = await putAdvanceSettings(req.body?.settings || req.body, req.user?.email);
    return res.json({ ok: true, settings });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/lists/:name', async (req, res) => {
  try {
    const items = await getList(req.params.name);
    return res.json({ ok: true, items });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

router.put('/lists/:name', async (req, res) => {
  try {
    const items = await putList(req.params.name, req.body?.items || [], req.user?.email);
    return res.json({ ok: true, items });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
