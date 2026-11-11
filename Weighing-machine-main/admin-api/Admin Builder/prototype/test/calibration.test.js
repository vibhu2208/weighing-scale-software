import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { createCameraCalibration } from '../src/calibration.js';
import { ProcessingError } from '../src/errors.js';

const defaultsPath = fileURLToPath(new URL('../../config/defaults.json', import.meta.url));

async function makeFrame(value) {
  const pixels = Buffer.alloc(64 * 48 * 3, value);
  return sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } })
    .png()
    .toBuffer();
}

test('creates one reusable median reference patch from five same-camera samples', async (t) => {
  const profilesDirectory = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-cal-'));
  t.after(() => rm(profilesDirectory, { recursive: true, force: true }));
  const frames = [
    await makeFrame(10),
    await makeFrame(20),
    await makeFrame(30),
    await makeFrame(40),
    await makeFrame(50),
  ];
  const result = await createCameraCalibration({
    frameBuffers: frames,
    profileId: 'camera_test',
    displayName: 'Test camera draft',
    timezone: 'Asia/Kolkata',
    roi: { x: 2, y: 2, width: 20, height: 10 },
    timestampFormat: '%H:%M:%S',
    fontSizePx: 6,
    colorRgb: [240, 240, 240],
    defaultsPath,
    profilesDirectory,
  });

  assert.equal(result.profile.calibrated, false);
  assert.equal(result.profile.calibration.sample_count, 5);
  assert.equal(result.profile.calibration.method, 'per_pixel_temporal_median');
  assert.equal(result.profile.calibration.sample_sha256.length, 5);
  assert.equal(result.profile.lighting.presets.deep_night.exposure_ev, -2.2);
  assert.equal(result.profile.lighting.presets.deep_night.target_luminance, 34);
  assert.equal(result.referencePatchBase64.length > 0, true);
  const patch = await sharp(await readFile(result.referencePatchPath)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(patch.info.width, 20);
  assert.equal(patch.info.height, 10);
  assert.equal(patch.data[0], 30);
  assert.equal(
    JSON.parse(await readFile(result.profilePath, 'utf8')).profile_id,
    'camera_test',
  );
});

test('rejects fewer than five calibration frames', async () => {
  await assert.rejects(
    createCameraCalibration({
      frameBuffers: [await makeFrame(10), await makeFrame(20)],
      profileId: 'camera_test',
      displayName: 'Test',
      timezone: 'Asia/Kolkata',
      roi: { x: 2, y: 2, width: 20, height: 10 },
      timestampFormat: '%H:%M:%S',
      fontSizePx: 6,
      colorRgb: [240, 240, 240],
      defaultsPath,
      profilesDirectory: os.tmpdir(),
    }),
    (error) => error instanceof ProcessingError && error.code === 'INVALID_CALIBRATION_SAMPLE_COUNT',
  );
});

test('rejects samples with different image dimensions', async (t) => {
  const profilesDirectory = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-cal-'));
  t.after(() => rm(profilesDirectory, { recursive: true, force: true }));
  const frames = await Promise.all(Array.from({ length: 4 }, () => makeFrame(30)));
  frames.push(
    await sharp(Buffer.alloc(64 * 47 * 3, 30), {
      raw: { width: 64, height: 47, channels: 3 },
    }).png().toBuffer(),
  );
  await assert.rejects(
    createCameraCalibration({
      frameBuffers: frames,
      profileId: 'camera_test',
      displayName: 'Test',
      timezone: 'Asia/Kolkata',
      roi: { x: 2, y: 2, width: 20, height: 10 },
      timestampFormat: '%H:%M:%S',
      fontSizePx: 6,
      colorRgb: [240, 240, 240],
      defaultsPath,
      profilesDirectory,
    }),
    (error) => error.code === 'CALIBRATION_DIMENSION_MISMATCH',
  );
});
