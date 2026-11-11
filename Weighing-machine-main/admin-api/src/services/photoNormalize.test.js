'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  TARGET_MAX_BYTES,
  ABSOLUTE_MAX_BYTES,
  normalizeReportPhoto,
} = require('./photoNormalize');

test('normalizeReportPhoto leaves small images unchanged', async () => {
  const small = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  assert.ok(small.length < TARGET_MAX_BYTES);
  const out = await normalizeReportPhoto(small);
  assert.equal(out.resized, false);
  assert.equal(out.body, small);
  assert.equal(out.storedBytes, small.length);
});

test('normalizeReportPhoto rejects absurd absolute sizes', async () => {
  const tooBig = Buffer.alloc(ABSOLUTE_MAX_BYTES + 1);
  await assert.rejects(() => normalizeReportPhoto(tooBig), /too large to process/i);
});

test('normalizeReportPhoto resizes oversized images and stores only the smaller JPEG', async () => {
  // Noise JPEG targeted between 12 MB and the absolute intake ceiling.
  const w = 4500;
  const h = 3200;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i * 17) & 255;
    raw[i + 1] = (i * 29) & 255;
    raw[i + 2] = (i * 43) & 255;
  }
  const input = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  assert.ok(
    input.length > TARGET_MAX_BYTES,
    `expected test JPEG > 12MB, got ${input.length}`,
  );
  assert.ok(
    input.length <= ABSOLUTE_MAX_BYTES,
    `expected test JPEG ≤ absolute max, got ${input.length}`,
  );

  const out = await normalizeReportPhoto(input);
  assert.equal(out.resized, true);
  assert.equal(out.contentType, 'image/jpeg');
  assert.ok(out.storedBytes < out.originalBytes);
  assert.ok(out.storedBytes < TARGET_MAX_BYTES);
  assert.notEqual(out.body, input);

  const meta = await sharp(out.body).metadata();
  assert.ok(meta.width <= 1920);
  assert.ok(meta.height <= 1920);
  assert.equal(meta.format, 'jpeg');
});
