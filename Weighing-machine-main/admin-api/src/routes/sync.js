'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const { getSyncStatus, listRecentCommands } = require('../services/commandService');

const router = express.Router();
router.use(authMiddleware);

router.get('/status', async (_req, res) => {
  try {
    const status = await getSyncStatus();
    const recentCommands = await listRecentCommands(30);
    return res.json({ ok: true, ...status, recentCommands });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
