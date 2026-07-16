'use strict';

const dns = require('dns');
const net = require('net');
const { promisify } = require('util');

const lookup = promisify(dns.lookup);

function hostFromPgSyncUrl() {
  const url = (process.env.PG_SYNC_URL || '').trim();
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function portFromPgSyncUrl() {
  const url = (process.env.PG_SYNC_URL || '').trim();
  if (!url) return 5432;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : 5432;
  } catch {
    return 5432;
  }
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_e) {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/**
 * Non-blocking reachability check for AWS / RDS.
 * Prefer TCP to the configured Postgres host (matches real sync needs).
 * Never throws — returns false when offline or misconfigured.
 */
async function isOnline() {
  const pgHost = hostFromPgSyncUrl();
  if (pgHost) {
    if (await tcpReachable(pgHost, portFromPgSyncUrl())) return true;
  }

  const hosts = [pgHost, 'amazonaws.com'].filter(Boolean);
  for (const host of hosts) {
    try {
      await lookup(host);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

module.exports = { isOnline };
