'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeRemoteWithMirror,
  preferAdminPhotoKey,
} = require('./reportMedia');

test('preferAdminPhotoKey: versioned Report Edit key beats Create-images', () => {
  assert.equal(
    preferAdminPhotoKey(
      'remote-trips/WB0001/arrival_cam-1-v1.jpg',
      'sites/WB-03/mirror/WB0001/arrival_cam-1-abc123.jpg',
    ),
    'sites/WB-03/mirror/WB0001/arrival_cam-1-abc123.jpg',
  );
});

test('preferAdminPhotoKey: mirror wins when both set (stable sites)', () => {
  assert.equal(
    preferAdminPhotoKey(
      'remote-trips/WB0001/arrival_cam-1-v1.jpg',
      'sites/WB-03/mirror/WB0001/arrival_cam-1.jpg',
    ),
    'sites/WB-03/mirror/WB0001/arrival_cam-1.jpg',
  );
});

test('preferAdminPhotoKey: falls back to remote when mirror empty', () => {
  assert.equal(
    preferAdminPhotoKey('remote-trips/WB0001/arrival_cam-1-v1.jpg', null),
    'remote-trips/WB0001/arrival_cam-1-v1.jpg',
  );
  assert.equal(preferAdminPhotoKey('remote-trips/x.jpg', ''), 'remote-trips/x.jpg');
  assert.equal(preferAdminPhotoKey(null, null), null);
});

test('mergeRemoteWithMirror prefers mirror photo keys over remote Create-images keys', () => {
  const remote = {
    id: 'rt-1',
    slip_number: 'WB0001',
    arrival_photo_1: 'remote-trips/WB0001/arrival_cam-1-v1.jpg',
    departure_photo_1: 'remote-trips/WB0001/departure_cam-1-v1.jpg',
    report_gross_content_fp: 'abc123',
    report_gross_s3_key: 'sites/WB-03/mirror/WB0001/report_gross.pdf',
    report_content_fp: 'remote-fp',
  };
  const mirror = {
    id: 'mirror-row',
    slip_number: 'WB0001',
    arrival_photo_1: 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg',
    departure_photo_1: null,
    truck_number: 'MH12AB1234',
    report_s3_key: 'sites/WB-03/mirror/WB0001/report.pdf',
  };

  const merged = mergeRemoteWithMirror(remote, mirror);
  assert.equal(merged.id, 'rt-1');
  assert.equal(merged.truck_number, 'MH12AB1234');
  assert.equal(merged.arrival_photo_1, 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg');
  assert.equal(merged.departure_photo_1, 'remote-trips/WB0001/departure_cam-1-v1.jpg');
  assert.equal(merged.report_gross_content_fp, 'abc123');
  assert.equal(merged.report_gross_s3_key, 'sites/WB-03/mirror/WB0001/report_gross.pdf');
  assert.equal(merged.report_s3_key, 'sites/WB-03/mirror/WB0001/report.pdf');
  assert.equal(merged.report_content_fp, 'remote-fp');
});

test('mergeRemoteWithMirror returns remote when mirror missing', () => {
  const remote = { id: 'rt-1', slip_number: 'WB0001' };
  assert.equal(mergeRemoteWithMirror(remote, null), remote);
});

test('mergeRemoteWithMirror returns mirror when remote missing', () => {
  const mirror = { id: 'm-1', slip_number: 'WB0001', arrival_photo_1: 'sites/x.jpg' };
  assert.equal(mergeRemoteWithMirror(null, mirror), mirror);
});
