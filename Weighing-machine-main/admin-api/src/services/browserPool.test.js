'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maxConcurrency } = require('./browserPool');

test('PDF_BROWSER_CONCURRENCY defaults to 2 and caps at 4', () => {
  const prev = process.env.PDF_BROWSER_CONCURRENCY;
  try {
    delete process.env.PDF_BROWSER_CONCURRENCY;
    assert.equal(maxConcurrency(), 2);
    process.env.PDF_BROWSER_CONCURRENCY = '3';
    assert.equal(maxConcurrency(), 3);
    process.env.PDF_BROWSER_CONCURRENCY = '99';
    assert.equal(maxConcurrency(), 4);
    process.env.PDF_BROWSER_CONCURRENCY = '0';
    assert.equal(maxConcurrency(), 2);
  } finally {
    if (prev == null) delete process.env.PDF_BROWSER_CONCURRENCY;
    else process.env.PDF_BROWSER_CONCURRENCY = prev;
  }
});
