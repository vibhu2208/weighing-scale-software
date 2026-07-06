'use strict';

const express = require('express');
const { verifyLogin } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await verifyLogin(email, password);
    if (!result.ok) {
      return res.status(401).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
