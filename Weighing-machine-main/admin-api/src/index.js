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
const slipReservationsRoutes = require('./routes/slipReservations');
const {
  ensureSchema: ensureSlipReservationsSchema,
  startFireWorker,
} = require('./services/slipReservationService');
const { startMirrorReconcileWorker } = require('./services/remoteTripService');
const { startVehicleReassertWorker } = require('./services/commandService');
const { query } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '25mb' }));

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
app.use('/slip-reservations', slipReservationsRoutes);

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  res.status(500).json({ ok: false, error: err.message || 'Internal error' });
});

async function bootstrap() {
  if (!isConfigured()) {
    console.warn('[api] DATABASE_URL not configured — API will fail on DB calls');
    return;
  }
  try {
    await bootstrapAdminUser();
  } catch (err) {
    console.error(
      '[auth] Bootstrap failed — run scripts/rds/002_admin_panel.sql on RDS:',
      err.message,
    );
  }
  try {
    await ensureSlipReservationsSchema();
    console.log('[api] slip_reservations schema ready');
    startFireWorker();
  } catch (err) {
    console.error(
      '[api] slip_reservations setup failed — run scripts/rds/003_slip_reservations.sql:',
      err.message,
    );
  }
  try {
    startMirrorReconcileWorker(query, 60);
    console.log('[api] remote trip → mirror reconcile worker started');
  } catch (err) {
    console.warn('[api] mirror reconcile worker failed to start', err.message);
  }
  try {
    startVehicleReassertWorker();
    console.log('[api] vehicle reassert worker started');
  } catch (err) {
    console.warn('[api] vehicle reassert worker failed to start', err.message);
  }
}

function start() {
  // Bind immediately so Vite proxy is not refused while RDS bootstrap times out.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[api] listening on port ${PORT}`);
  });
  bootstrap().catch((err) => {
    console.error('[api] bootstrap error', err);
  });
}

start();
