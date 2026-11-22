'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRemoteWithMirror } = require('./reportMedia');

test('merge: later Report Edit version beats older Create images', () => {
  const older = Date.UTC(2026, 10, 23, 1, 0, 0);
  const newer = Date.UTC(2026, 10, 23, 2, 0, 0);
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T03:00:00.000Z',
    arrival_photo_1: `remote-trips/WB0001/arrival_cam-1-${older.toString(36)}aaaa.jpg`,
    departure_photo_1: `remote-trips/WB0001/departure_cam-1-${older.toString(36)}aaaa.jpg`,
    report_gross_content_fp: 'abc123',
  };
  const mirror = {
    id: 'mirror-row',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T01:30:00.000Z',
    arrival_photo_1: `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.jpg`,
    departure_photo_1: null,
    truck_number: 'MH12AB1234',
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(
    merged.arrival_photo_1,
    `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.jpg`,
  );
  assert.equal(
    merged.departure_photo_1,
    `remote-trips/WB0001/departure_cam-1-${older.toString(36)}aaaa.jpg`,
  );
});

test('merge: later Create images version beats older Report Edit', () => {
  const older = Date.UTC(2026, 10, 23, 1, 0, 0);
  const newer = Date.UTC(2026, 10, 23, 4, 0, 0);
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T01:00:00.000Z',
    arrival_photo_1: `remote-trips/WB0001/arrival_cam-1-${newer.toString(36)}aaaa.jpg`,
  };
  const mirror = {
    id: 'm-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T09:00:00.000Z',
    arrival_photo_1: `sites/WB-03/mirror/WB0001/arrival_cam-1-${older.toString(36)}bbbb.jpg`,
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(
    merged.arrival_photo_1,
    `remote-trips/WB0001/arrival_cam-1-${newer.toString(36)}aaaa.jpg`,
  );
});
