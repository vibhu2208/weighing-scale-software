'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  preferLastWritePhotoKey,
  isVersionedAdminMirrorKey,
  isStableWeighbridgeMirrorKey,
  photoKeyWriteTime,
  pickNewestPhotoKey,
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
});

test('photoKeyWriteTime round-trips Date.now().toString(36) versions', () => {
  const ms = Date.UTC(2026, 10, 23, 1, 30, 0);
  const ver = `${ms.toString(36)}abcd`;
  const key = `sites/WB-03/mirror/WB0001/arrival_cam-1-${ver}.jpg`;
  assert.equal(photoKeyWriteTime(key), ms);
});

test('later Report Edit version beats older Create-images version', () => {
  const older = Date.UTC(2026, 10, 23, 1, 0, 0);
  const newer = Date.UTC(2026, 10, 23, 2, 0, 0);
  const createKey = `remote-trips/WB0001/arrival_cam-1-${older.toString(36)}aaaa.jpg`;
  const editKey = `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.jpg`;
  assert.equal(preferLastWritePhotoKey(createKey, editKey), editKey);
});

test('later Create images version beats older Report Edit version', () => {
  const older = Date.UTC(2026, 10, 23, 1, 0, 0);
  const newer = Date.UTC(2026, 10, 23, 3, 0, 0);
  const editKey = `sites/WB-03/mirror/WB0001/arrival_cam-1-${older.toString(36)}bbbb.jpg`;
  const createKey = `remote-trips/WB0001/arrival_cam-1-${newer.toString(36)}aaaa.jpg`;
  assert.equal(preferLastWritePhotoKey(createKey, editKey), createKey);
});

test('stable weighbridge sites never beat Create-images', () => {
  const key = preferLastWritePhotoKey(
    'remote-trips/WB0001/arrival_cam-1-mws9zzitxyg9.jpg',
    'sites/WB-03/mirror/WB0001/arrival_cam-1.jpg',
    {
      remoteUpdatedAt: '2026-11-23T01:00:00.000Z',
      mirrorUpdatedAt: '2026-11-23T05:00:00.000Z',
    },
  );
  assert.equal(key, 'remote-trips/WB0001/arrival_cam-1-mws9zzitxyg9.jpg');
});

test('pickNewestPhotoKey prefers highest version timestamp', () => {
  const older = Date.UTC(2026, 10, 23, 1, 0, 0);
  const newer = Date.UTC(2026, 10, 23, 4, 0, 0);
  const picked = pickNewestPhotoKey([
    `remote-trips/WB0001/arrival_cam-1-${older.toString(36)}aaaa.jpg`,
    `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.jpg`,
    `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.thumb.jpg`,
  ]);
  assert.equal(
    picked,
    `sites/WB-03/mirror/WB0001/arrival_cam-1-${newer.toString(36)}bbbb.jpg`,
  );
});
