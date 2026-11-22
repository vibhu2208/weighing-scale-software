'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  preferLastWritePhotoKey,
  isVersionedAdminMirrorKey,
  isStableWeighbridgeMirrorKey,
} = require('./adminPhotoKeys');

test('classifies versioned admin vs stable weighbridge keys', () => {
  assert.equal(
    isVersionedAdminMirrorKey('sites/WB-03/mirror/WB0001/arrival_cam-1-abc12x.jpg'),
    true,
  );
  assert.equal(
    isStableWeighbridgeMirrorKey('sites/WB-03/mirror/WB0001/arrival_cam-1.jpg'),
    true,
  );
  assert.equal(
    isVersionedAdminMirrorKey('sites/WB-03/mirror/WB0001/arrival_cam-1.jpg'),
    false,
  );
  assert.equal(
    isStableWeighbridgeMirrorKey('remote-trips/WB0001/arrival_cam-1-v1.jpg'),
    false,
  );
});

test('Report Edit later than Create images → versioned sites wins', () => {
  const key = preferLastWritePhotoKey(
    'remote-trips/WB0001/arrival_cam-1-old.jpg',
    'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg',
    {
      remoteUpdatedAt: '2026-11-23T01:00:00.000Z',
      mirrorUpdatedAt: '2026-11-23T02:00:00.000Z',
    },
  );
  assert.equal(key, 'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg');
});

test('Create images later than Report Edit → remote-trips wins', () => {
  const key = preferLastWritePhotoKey(
    'remote-trips/WB0001/arrival_cam-1-new.jpg',
    'sites/WB-03/mirror/WB0001/arrival_cam-1-edit99.jpg',
    {
      remoteUpdatedAt: '2026-11-23T03:00:00.000Z',
      mirrorUpdatedAt: '2026-11-23T02:00:00.000Z',
    },
  );
  assert.equal(key, 'remote-trips/WB0001/arrival_cam-1-new.jpg');
});

test('stable weighbridge sites never beat Create-images even if mirror looks newer', () => {
  const key = preferLastWritePhotoKey(
    'remote-trips/WB0001/arrival_cam-1-v1.jpg',
    'sites/WB-03/mirror/WB0001/arrival_cam-1.jpg',
    {
      remoteUpdatedAt: '2026-11-23T01:00:00.000Z',
      mirrorUpdatedAt: '2026-11-23T05:00:00.000Z',
    },
  );
  assert.equal(key, 'remote-trips/WB0001/arrival_cam-1-v1.jpg');
});

test('falls back when only one side has a key', () => {
  assert.equal(
    preferLastWritePhotoKey('remote-trips/x.jpg', null),
    'remote-trips/x.jpg',
  );
  assert.equal(
    preferLastWritePhotoKey(null, 'sites/WB-03/mirror/WB0001/arrival_cam-1-e1.jpg'),
    'sites/WB-03/mirror/WB0001/arrival_cam-1-e1.jpg',
  );
});
