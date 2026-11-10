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
    // statement_timeout via startup options — never SET on 'connect' (races pg checkout).
    const base = stripSslModeFromUrl(getConnectionString());
    const sep = base.includes('?') ? '&' : '?';
    const connectionString = `${base}${sep}options=${encodeURIComponent('-c statement_timeout=30000')}`;
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      application_name: 'admin-api',
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
  return (process.env.SITE_ID || 'WB-03').trim().replace(/\s+/g, '');
}

module.exports = { query, getPool, isConfigured, getSiteId };
