'use strict';

const express = require('express');
const { authMiddleware } = require('../auth');
const {
  getSyncStatus,
  listRecentCommands,
  retryCommand,
  retryFailedCommands,
} = require('../services/commandService');

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

router.post('/commands/retry-failed', async (_req, res) => {
  try {
    const result = await retryFailedCommands();
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/commands/:id/retry', async (req, res) => {
  try {
    const command = await retryCommand(req.params.id);
    return res.json({ ok: true, command });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

module.exports = router;
