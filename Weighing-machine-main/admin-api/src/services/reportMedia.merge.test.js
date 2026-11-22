'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeRemoteWithMirror } = require('./reportMedia');

test('merge: later Report Edit (mirror) beats older Create images', () => {
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T01:00:00.000Z',
    arrival_photo_1: 'remote-trips/WB0001/arrival_cam-1-v1.jpg',
    departure_photo_1: 'remote-trips/WB0001/departure_cam-1-v1.jpg',
    report_gross_content_fp: 'abc123',
    report_gross_s3_key: 'sites/WB-03/mirror/WB0001/report_gross.pdf',
  };
  const mirror = {
    id: 'mirror-row',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T02:00:00.000Z',
    arrival_photo_1: 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg',
    departure_photo_1: null,
    truck_number: 'MH12AB1234',
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(merged.id, 'rt-1');
  assert.equal(merged.arrival_photo_1, 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg');
  assert.equal(merged.departure_photo_1, 'remote-trips/WB0001/departure_cam-1-v1.jpg');
  assert.equal(merged.updated_at, '2026-11-23T02:00:00.000Z');
});

test('merge: later Create images (remote) beats older Report Edit', () => {
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T04:00:00.000Z',
    arrival_photo_1: 'remote-trips/WB0001/arrival_cam-1-new.jpg',
    report_gross_content_fp: 'fp',
  };
  const mirror = {
    id: 'm-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T02:00:00.000Z',
    arrival_photo_1: 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg',
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(merged.arrival_photo_1, 'remote-trips/WB0001/arrival_cam-1-new.jpg');
  assert.equal(merged.updated_at, '2026-11-23T04:00:00.000Z');
});

test('merge: stable weighbridge sites do not beat Create-images', () => {
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T01:00:00.000Z',
    arrival_photo_1: 'remote-trips/WB0001/arrival_cam-1-v1.jpg',
  };
  const mirror = {
    id: 'm-1',
    slip_number: 'WB0001',
    updated_at: '2026-11-23T09:00:00.000Z',
    arrival_photo_1: 'sites/WB-03/mirror/WB0001/arrival_cam-1.jpg',
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(merged.arrival_photo_1, 'remote-trips/WB0001/arrival_cam-1-v1.jpg');
});
