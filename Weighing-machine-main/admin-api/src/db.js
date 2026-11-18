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

function createPool() {
  // statement_timeout via startup options — never SET on 'connect' (races pg checkout).
  const base = stripSslModeFromUrl(getConnectionString());
  const sep = base.includes('?') ? '&' : '?';
  const connectionString = `${base}${sep}options=${encodeURIComponent('-c statement_timeout=30000')}`;
  const next = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: 'admin-api',
  });
  // Idle / mid-flight socket drops must not crash the process (Unhandled 'error' on Client).
  next.on('error', (err) => {
    console.error('[db] pool error', err.message);
  });
  next.on('connect', (client) => {
    client.on('error', (err) => {
      console.error('[db] client error', err.message);
    });
  });
  return next;
}

function getPool() {
  if (!isConfigured()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

async function query(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    const code = err && err.code;
    // Drop a poisoned pool after transport failures so the next call opens fresh sockets.
    if (
      pool &&
      (code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        /timeout exceeded when trying to connect/i.test(String(err.message || '')))
    ) {
      const dead = pool;
      pool = null;
      dead.end().catch(() => {});
    }
    throw err;
  }
}

function getSiteId() {
  return (process.env.SITE_ID || 'WB-03').trim().replace(/\s+/g, '');
}

async function endPool() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => {});
}

module.exports = { query, getPool, isConfigured, getSiteId, endPool };
