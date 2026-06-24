'use strict';

const dns = require('dns');
const { promisify } = require('util');

const resolve = promisify(dns.resolve);

/**
 * Non-blocking internet check via DNS (AWS endpoint).
 * Never throws — returns false when offline or misconfigured.
 */
async function isOnline() {
  try {
    await resolve('amazonaws.com');
    return true;
  } catch {
    return false;
  }
}

module.exports = { isOnline };
