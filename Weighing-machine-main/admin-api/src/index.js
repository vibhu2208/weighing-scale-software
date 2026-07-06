'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { isConfigured } = require('./db');
const { bootstrapAdminUser } = require('./auth');

const authRoutes = require('./routes/auth');
const reportsRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const syncRoutes = require('./routes/sync');
const mediaRoutes = require('./routes/media');
const remoteTripsRoutes = require('./routes/remoteTrips');

const app = express();
const PORT = process.env.PORT || 3001;

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    db: isConfigured(),
    siteId: process.env.SITE_ID || 'WB-03',
  });
});

app.use('/auth', authRoutes);
app.use('/reports', reportsRoutes);
app.use('/settings', settingsRoutes);
app.use('/sync', syncRoutes);
app.use('/media', mediaRoutes);
app.use('/remote-trips', remoteTripsRoutes);

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  res.status(500).json({ ok: false, error: err.message || 'Internal error' });
});

async function start() {
  if (isConfigured()) {
    try {
      await bootstrapAdminUser();
    } catch (err) {
      console.error(
        '[auth] Bootstrap failed — run scripts/rds/002_admin_panel.sql on RDS:',
        err.message,
      );
    }
  } else {
    console.warn('[api] DATABASE_URL not configured — API will fail on DB calls');
  }
  app.listen(PORT, () => {
    console.log(`[api] listening on port ${PORT}`);
  });
}

start();
