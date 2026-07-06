'use strict';

require('dotenv').config();

const { Pool } = require('pg');

let pool = null;

function getConnectionString() {
  return (process.env.DATABASE_URL || process.env.PG_SYNC_URL || '').trim();
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
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: stripSslModeFromUrl(getConnectionString()),
      ssl: { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (err) => {
      console.error('[db] pool error', err.message);
    });
  }
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

function getSiteId() {
  return (process.env.SITE_ID || 'WB-03').trim();
}

module.exports = { query, getPool, isConfigured, getSiteId };
