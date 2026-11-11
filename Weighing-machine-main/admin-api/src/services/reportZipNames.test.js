'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportZipFilename, uniqueZipEntryName } = require('./reportZipNames');

test('reportZipFilename uses vehicle last4 + IST date, never slip', () => {
  // 2026-11-09 18:30Z = 2026-11-10 00:00 IST
  const istMidnight = new Date('2026-11-09T18:30:00.000Z');
  const name = reportZipFilename('MH12AB4672', istMidnight);
  assert.equal(name, '4672-2026-11-10.pdf');
  assert.equal(reportZipFilename('RJ14-CD-4672', istMidnight), '4672-2026-11-10.pdf');
  assert.doesNotMatch(name, /WB|slip/i);
});

test('uniqueZipEntryName keeps three 4672 trips as numbered copies', () => {
  const counts = new Map();
  const base = reportZipFilename('MH12AB4672', new Date('2026-11-09T18:30:00.000Z'));
  assert.equal(uniqueZipEntryName(base, counts), '4672-2026-11-10.pdf');
  assert.equal(uniqueZipEntryName(base, counts), '4672-2026-11-10-2.pdf');
  assert.equal(uniqueZipEntryName(base, counts), '4672-2026-11-10-3.pdf');
});
