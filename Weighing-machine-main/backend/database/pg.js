'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool = null;

function getConnectionString() {
  return (process.env.PG_SYNC_URL || '').trim();
}

function isConfigured() {
  const url = getConnectionString();
  return !!url && !url.includes('YOUR_PASSWORD');
}

function stripSslModeFromUrl(url) {
  return String(url)
    .replace(/([?&])sslmode=[^&]*(&|$)/, (_, sep, tail) => (tail === '&' ? sep : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

function getPool() {
  if (!isConfigured()) {
    throw new Error('PG_SYNC_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: stripSslModeFromUrl(getConnectionString()),
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (err) => {
      logger.warn('PostgreSQL pool error', { message: err.message });
    });
  }
  return pool;
}

async function query(text, params = []) {
  const p = getPool();
  return p.query(text, params);
}

async function getDedicatedClient() {
  const p = getPool();
  const client = await p.connect();
  return client;
}

async function ping() {
  if (!isConfigured()) return false;
  try {
    await query('SELECT 1 AS ok');
    return true;
  } catch (err) {
    logger.warn('PostgreSQL ping failed', { message: err.message });
    return false;
  }
}

async function getNextSlipNumber() {
  const res = await query('SELECT next_slip_number() AS slip');
  const slip = res.rows[0]?.slip;
  if (!slip) {
    throw new Error('next_slip_number returned no value');
  }
  return String(slip);
}

async function syncSlipCounterToMax(minValue) {
  const min = Math.max(0, Number(minValue) || 0);
  if (min <= 0) return null;
  const res = await query('SELECT sync_slip_counter_to_max($1) AS current_value', [
    min,
  ]);
  return res.rows[0]?.current_value ?? null;
}

async function getSlipCounterValue() {
  const res = await query(
    'SELECT current_value FROM slip_counter WHERE id = 1 LIMIT 1',
  );
  return res.rows[0]?.current_value ?? null;
}

function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    return p.end().catch(() => {});
  }
  return Promise.resolve();
}

module.exports = {
  isConfigured,
  query,
  getDedicatedClient,
  ping,
  getNextSlipNumber,
  syncSlipCounterToMax,
  getSlipCounterValue,
  closePool,
};
