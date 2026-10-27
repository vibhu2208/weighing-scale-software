import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import {
  ProcessingError,
  applyLighting,
  buildDisplayOverlays,
  clampCctvOutputSize,
  detectTimestampRoi,
  formatTimestamp,
  luminancePercentile,
  meanLuminance,
  normalizeDateTimeLocal,
  parseLocalDateTime,
  processJob,
  resolveLighting,
  validateProfile,
} from '../src/index.js';

const configDir = fileURLToPath(new URL('../../config/', import.meta.url));

const tempRoot = path.resolve('.test-tmp');
let tempDirectory;

const profile = {
  schema_version: 1,
  profile_id: 'camera-test',
  profile_version: 1,
  display_name: 'Synthetic test profile',
  calibrated: false,
  expected_width: 320,
  expected_height: 160,
  timezone: 'Asia/Kolkata',
  timestamp: {
    roi: { x: 10, y: 10, width: 280, height: 28 },
    format: '%H:%M',
    font_size_px: 16,
    font_family: 'monospace',
    color_rgb: [250, 250, 250],
    reference_patch_required: true,
  },
  lighting: {
    presets: {
      deep_night: { exposure_ev: -2.1, gamma: 1.15, saturation: 0.68 },
      night: { exposure_ev: -1.5, gamma: 1.1, saturation: 0.78 },
      dawn: { exposure_ev: -0.55, gamma: 1, saturation: 0.88 },
      day: { exposure_ev: 0, gamma: 1, saturation: 1 },
      dusk: { exposure_ev: -0.65, gamma: 1, saturation: 0.9 },
    },
  },
};

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true });
  tempDirectory = await mkdtemp(path.join(tempRoot, 'case-'));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

async function writeRgbImage(filePath, width, height, pixels) {
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
}

async function readRgbImage(filePath) {
  return sharp(filePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function makeJob(overrides = {}) {
  return {
    job_id: 'test-job',
    profile_id: 'camera-test',
    datetime_local: '2026-10-21T03:15:00',
    timestamp_enabled: false,
    lighting_mode: 'none',
    output_format: 'png',
    ...overrides,
  };
}

async function createSource() {
  const sourcePath = path.join(tempDirectory, 'source.png');
  const pixels = Buffer.alloc(320 * 160 * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 80;
    pixels[offset + 1] = 90;
    pixels[offset + 2] = 100;
  }
  await writeRgbImage(sourcePath, 320, 160, pixels);
  return { sourcePath, pixels };
}

test('formats exact local time with zero padding and rejects invalid calendar dates', () => {
  assert.equal(formatTimestamp('2026-02-03T03:05:09', '%Y-%m-%d %H:%M:%S'), '2026-02-03 03:05:09');
  assert.throws(() => parseLocalDateTime('2026-02-30T03:05:09'), {
    code: 'INVALID_DATETIME',
  });
  assert.throws(() => parseLocalDateTime('2026-10-21T03:15:00Z'), {
    code: 'INVALID_DATETIME',
  });
});

test('automatically selects dark preset for 03:15 local time', () => {
  assert.equal(resolveLighting('auto', '2026-10-21T03:15:00'), 'deep_night');
  assert.equal(resolveLighting('auto', '2026-10-21T10:30:00'), 'day');
});

test('validates the illustrative camera profile but does not mark it calibrated', async () => {
  const sampleProfile = JSON.parse(
    await readFile(path.join(configDir, 'sample_camera_profile.json'), 'utf8'),
  );
  assert.equal(validateProfile(sampleProfile), undefined);
  assert.equal(sampleProfile.calibrated, false);
});

test('replaces timestamp from a registered patch and preserves all pre-encode pixels outside its ROI', async () => {
  const { sourcePath } = await createSource();
  const sourceBytes = await readFile(sourcePath);
  const patchPath = path.join(tempDirectory, 'reference.png');
  await writeRgbImage(patchPath, 280, 28, Buffer.alloc(280 * 28 * 3, 20));
  const result = await processJob({
    sourcePath,
    referencePatchPath: patchPath,
    outputRoot: path.join(tempDirectory, 'runs'),
    profile,
    job: makeJob({ timestamp_enabled: true }),
  });

  const source = await readRgbImage(sourcePath);
  const output = await readRgbImage(result.output_image_path);
  assert.equal(output.info.width, 320);
  assert.equal(output.info.height, 160);
  const watermark = result.operations.find((operation) => operation.name === 'add_visible_edited_derivative_watermark');
  assert.ok(watermark);
  for (let y = 0; y < 160; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      const inTimestampRoi = x >= 10 && x < 290 && y >= 10 && y < 38;
      const inWatermark =
        x >= watermark.left &&
        x < watermark.left + watermark.width &&
        y >= watermark.top &&
        y < watermark.top + watermark.height;
      if (inTimestampRoi || inWatermark) continue;
      const offset = (y * 320 + x) * 3;
      assert.deepEqual(output.data.subarray(offset, offset + 3), source.data.subarray(offset, offset + 3));
    }
  }
  const roiHasBrightTimestamp = [];
  for (let y = 10; y < 38; y += 1) {
    for (let x = 10; x < 290; x += 1) {
      const offset = (y * 320 + x) * 3;
      if (output.data[offset] > 200 && output.data[offset + 1] > 200 && output.data[offset + 2] > 200) {
        roiHasBrightTimestamp.push(true);
      }
    }
  }
  assert.ok(roiHasBrightTimestamp.length > 0);
  const watermarkOffset = (watermark.top * 320 + watermark.left) * 3;
  assert.notDeepEqual(
    output.data.subarray(watermarkOffset, watermarkOffset + 3),
    source.data.subarray(watermarkOffset, watermarkOffset + 3),
    'The derivative label should modify only its compact reserved badge.',
  );
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.qa_passed, false);

  const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8'));
  const qaReport = JSON.parse(await readFile(result.qa_report_path, 'utf8'));
  const writtenOutput = await readFile(result.output_image_path);
  assert.equal(manifest.edited_derivative, true);
  assert.equal(manifest.operations[0].text, '03:15');
  assert.equal(manifest.timestamp_strategy, 'SIMULATED_INFRAME_REVIEW');
  assert.equal(manifest.source_sha256, result.source_sha256);
  assert.equal(manifest.output_sha256, result.output_sha256);
  assert.equal(createHash('sha256').update(writtenOutput).digest('hex'), manifest.output_sha256);
  assert.equal(qaReport.qa_passed, false);
  assert.ok(qaReport.hard_checks.every((check) => check.pass !== false));
  assert.equal(
    qaReport.hard_checks.find(
      (check) =>
        check.check ===
          'pixels_outside_timestamp_roi_and_provenance_label_unchanged_before_encode',
    ).pass,
    true,
  );
});

test('fails closed when the timestamp reference patch is missing', async () => {
  const { sourcePath } = await createSource();
  await assert.rejects(
    processJob({
      sourcePath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile,
      job: makeJob({ timestamp_enabled: true }),
    }),
    (error) => error instanceof ProcessingError && error.code === 'REFERENCE_PATCH_REQUIRED',
  );
});

test('rejects reference patches with dimensions different from the timestamp ROI', async () => {
  const { sourcePath } = await createSource();
  const patchPath = path.join(tempDirectory, 'wrong-size.png');
  await writeRgbImage(patchPath, 279, 28, Buffer.alloc(279 * 28 * 3, 20));
  await assert.rejects(
    processJob({
      sourcePath,
      referencePatchPath: patchPath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile,
      job: makeJob({ timestamp_enabled: true }),
    }),
    (error) => error.code === 'REFERENCE_PATCH_DIMENSION_MISMATCH',
  );
});

test('rejects timestamp text that cannot fit inside its calibrated ROI', async () => {
  const { sourcePath } = await createSource();
  const patchPath = path.join(tempDirectory, 'narrow-patch.png');
  await writeRgbImage(patchPath, 20, 10, Buffer.alloc(20 * 10 * 3, 20));
  const narrowProfile = {
    ...profile,
    timestamp: {
      ...profile.timestamp,
      roi: { x: 10, y: 10, width: 20, height: 10 },
      format: '%Y-%m-%d %H:%M:%S',
      font_size_px: 7,
    },
  };
  await assert.rejects(
    processJob({
      sourcePath,
      referencePatchPath: patchPath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile: narrowProfile,
      job: makeJob({ timestamp_enabled: true }),
    }),
    (error) => error.code === 'TIMESTAMP_CLIPPED',
  );
});

test('lighting none leaves decoded pixels unchanged and deep night is darker than day', async () => {
  const { sourcePath } = await createSource();
  const outputRoot = path.join(tempDirectory, 'runs');
  const identity = await processJob({
    sourcePath,
    outputRoot,
    profile,
    job: makeJob({ job_id: 'identity' }),
  });
  const input = await readRgbImage(sourcePath);
  const same = await readRgbImage(identity.output_image_path);
  assert.deepEqual(
    same.data.subarray(0, 132 * 320 * 3),
    input.data.subarray(0, 132 * 320 * 3),
  );
  const night = await processJob({
    sourcePath,
    outputRoot,
    profile,
    job: makeJob({ job_id: 'night', lighting_mode: 'deep_night' }),
  });
  const day = await processJob({
    sourcePath,
    outputRoot,
    profile,
    job: makeJob({ job_id: 'day', lighting_mode: 'day' }),
  });
  const nightImage = await readRgbImage(night.output_image_path);
  const dayImage = await readRgbImage(day.output_image_path);
  const average = (pixels) => pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  assert.ok(average(nightImage.data) < average(dayImage.data));
});

test('writes JPEG derivatives without changing image dimensions', async () => {
  const { sourcePath } = await createSource();
  const result = await processJob({
    sourcePath,
    outputRoot: path.join(tempDirectory, 'runs'),
    profile,
    job: makeJob({ output_format: 'jpeg' }),
  });
  assert.match(result.output_image_path, /\.jpeg$/);
  const output = await sharp(result.output_image_path).metadata();
  assert.equal(output.format, 'jpeg');
  assert.equal(output.width, 320);
  assert.equal(output.height, 160);
});

test('adds a labeled simulated time without covering the source or painting black glyph holes', async () => {
  const { sourcePath, pixels } = await createSource();
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 180; x += 1) {
      const offset = (y * 320 + x) * 3;
      pixels[offset] = 235;
      pixels[offset + 1] = 235;
      pixels[offset + 2] = 235;
    }
  }
  await writeRgbImage(sourcePath, 320, 160, pixels);
  const sourceBytes = await readFile(sourcePath);
  const overlay = await buildDisplayOverlays({
    width: 320,
    height: 160,
    datetimeLocal: '2026-10-21T03:15:00',
    profile,
    lightingPreset: 'none',
    sourcePixels: pixels,
  });
  assert.match(overlay.requestedTime, /03:15/);
  assert.match(overlay.simulatedLabel, /SIMULATED/);
  assert.equal(overlay.band, null);
  const overlaySvg = Buffer.concat(overlay.overlays.map((item) => item.input)).toString('utf8');
  assert.match(overlaySvg, /SIMULATED/);
  assert.match(overlaySvg, /EDITED DERIVATIVE/);
  assert.match(overlaySvg, /NOT ORIGINAL CCTV/);
  assert.doesNotMatch(overlaySvg, /stroke=/);
  assert.ok(overlay.roi.detected);
  const coversOsd = overlay.plate.left < overlay.roi.x + overlay.roi.width &&
    overlay.plate.left + overlay.plate.width > overlay.roi.x &&
    overlay.plate.top < overlay.roi.y + overlay.roi.height &&
    overlay.plate.top + overlay.plate.height > overlay.roi.y;
  assert.equal(coversOsd, false);

  const result = await processJob({
    sourcePath,
    outputRoot: path.join(tempDirectory, 'runs'),
    profile,
    job: makeJob({
      job_id: 'display-annotation',
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'none',
    }),
  });
  const outputMetadata = await sharp(result.output_image_path).metadata();
  assert.equal(outputMetadata.width, 320);
  assert.equal(outputMetadata.height, 160);
  assert.equal(result.processing_status, 'PROCESSING_COMPLETE');
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.qa_status, 'NEEDS_REVIEW');
  assert.equal(result.qa_passed, false);
  assert.equal(result.visually_approved, false);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  const output = await readRgbImage(result.output_image_path);
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 180; x += 1) {
      const offset = (y * 320 + x) * 3;
      assert.deepEqual(output.data.subarray(offset, offset + 3), pixels.subarray(offset, offset + 3));
    }
  }
  const overlayOp = result.operations.find((operation) => operation.name === 'add_simulated_display_time_overlay');
  const sampleOffset = ((overlayOp.plate.top + overlayOp.plate.textY) * 320 + overlayOp.plate.left + overlayOp.plate.textX) * 3;
  assert.ok(output.data[sampleOffset] > 200);

  const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8'));
  const qaReport = JSON.parse(await readFile(result.qa_report_path, 'utf8'));
  assert.equal(manifest.timestamp_strategy, 'ANNOTATED_DISPLAY_TIME');
  assert.equal(manifest.qa_status, 'NEEDS_REVIEW');
  assert.equal(manifest.machine_quality_gates, 'pass');
  assert.equal(manifest.visually_approved, false);
  assert.deepEqual(manifest.scene_dimensions, { width: 320, height: 160 });
  assert.equal(manifest.output_dimensions.height, 160);
  assert.equal(manifest.operations.some((operation) => operation.name === 'replace_timestamp'), false);
  const overlayOperation = manifest.operations.find(
    (operation) => operation.name === 'add_simulated_display_time_overlay',
  );
  assert.equal(overlayOperation.represents_verified_capture_time, false);
  assert.equal(overlayOperation.original_capture_osd_preserved, true);
  assert.equal(overlayOperation.original_capture_osd_visible_on_derivative, true);
  assert.equal(overlayOperation.banner, 'EDITED DERIVATIVE - NOT ORIGINAL CCTV');
  assert.match(overlayOperation.text, /SIMULATED 03:15/);
  assert.equal(qaReport.status, 'NEEDS_REVIEW');
  assert.equal(qaReport.qa_passed, false);
  assert.ok(qaReport.hard_checks.every((item) => item.pass !== false));
});

test('keeps the simulated time badge inside the report-safe area of a full-size frame', async () => {
  const overlay = await buildDisplayOverlays({
    width: 1616,
    height: 973,
    datetimeLocal: '2026-10-21T21:40:00',
    profile: {
      ...profile,
      expected_width: 1616,
      expected_height: 973,
      timestamp: {
        ...profile.timestamp,
        roi: { x: 8, y: 8, width: 300, height: 32 },
        format: '%d-%m-%Y %H:%M:%S',
      },
    },
    lightingPreset: 'night',
  });
  assert.equal(overlay.band, null);
  assert.ok(overlay.plate.width <= 460);
  assert.ok(overlay.plate.height <= 88);
  assert.ok(overlay.plate.left + overlay.plate.width < 1616);
  assert.match(overlay.simulatedLabel, /SIMULATED 21-10-2026 21:40:00/);
  assert.match(overlay.requestedTime, /21-10-2026 21:40:00/);
});

test('rejects annotation when the image is too small for a camera timestamp', async () => {
  const sourcePath = path.join(tempDirectory, 'narrow-source.png');
  await writeRgbImage(sourcePath, 160, 48, Buffer.alloc(160 * 48 * 3, 80));
  const narrowProfile = {
    ...profile,
    expected_width: 160,
    expected_height: 48,
    timestamp: {
      ...profile.timestamp,
      roi: { x: 0, y: 0, width: 150, height: 22 },
      font_size_px: 16,
      format: '%d-%m-%Y %H:%M:%S',
    },
  };
  await assert.rejects(
    processJob({
      sourcePath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile: narrowProfile,
      job: makeJob({ timestamp_strategy: 'display_annotation', lighting_mode: 'none' }),
    }),
    (error) => error.code === 'IMAGE_TOO_SMALL_FOR_ANNOTATION',
  );
});

test('rejects camera profile resolution mismatches and corrupt image bytes', async () => {
  const { sourcePath } = await createSource();
  await assert.rejects(
    processJob({
      sourcePath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile: { ...profile, expected_width: 321 },
      job: makeJob(),
    }),
    (error) => error.code === 'PROFILE_DIMENSION_MISMATCH',
  );
  const corruptPath = path.join(tempDirectory, 'corrupt.png');
  await writeFile(corruptPath, 'not an image');
  await assert.rejects(
    processJob({
      sourcePath: corruptPath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile,
      job: makeJob(),
    }),
    (error) => error.code === 'INVALID_IMAGE',
  );
});

test('rejects transparent source pixels rather than silently discarding alpha', async () => {
  const transparentPath = path.join(tempDirectory, 'transparent.png');
  await sharp(Buffer.alloc(320 * 160 * 4, 128), {
    raw: { width: 320, height: 160, channels: 4 },
  })
    .png()
    .toFile(transparentPath);
  await assert.rejects(
    processJob({
      sourcePath: transparentPath,
      outputRoot: path.join(tempDirectory, 'runs'),
      profile,
      job: makeJob(),
    }),
    (error) => error.code === 'UNSUPPORTED_TRANSPARENCY',
  );
});

test('rejects duplicate output job identifiers without overwriting the first result', async () => {
  const { sourcePath } = await createSource();
  const outputRoot = path.join(tempDirectory, 'runs');
  const first = await processJob({ sourcePath, outputRoot, profile, job: makeJob() });
  const originalOutput = await readFile(first.output_image_path);
  await assert.rejects(
    processJob({ sourcePath, outputRoot, profile, job: makeJob() }),
    (error) => error.code === 'JOB_ALREADY_EXISTS',
  );
  assert.deepEqual(await readFile(first.output_image_path), originalOutput);
});

test('automatic lighting uses requested local time and produces a measurable day/night difference', async () => {
  const defaults = JSON.parse(await readFile(path.join(configDir, 'defaults.json'), 'utf8'));
  const lightingProfile = { ...profile, lighting: defaults.lighting };
  const darkPixels = Buffer.alloc(320 * 160 * 3, 48);
  const brightPixels = Buffer.alloc(320 * 160 * 3, 150);
  const nightFromDay = applyLighting(brightPixels, 'auto', '2026-10-21T21:40:00', lightingProfile);
  const dayFromNight = applyLighting(darkPixels, 'auto', '2026-10-21T14:30:00', lightingProfile);
  const nightFromNight = applyLighting(darkPixels, 'auto', '2026-10-21T03:15:00', lightingProfile);
  const dayFromDay = applyLighting(brightPixels, 'auto', '2026-10-21T14:30:00', lightingProfile);

  assert.equal(nightFromDay.preset, 'night');
  assert.equal(dayFromNight.preset, 'day');
  assert.equal(nightFromNight.preset, 'deep_night');
  assert.ok(meanLuminance(nightFromDay.pixels) < meanLuminance(brightPixels) - 12);
  assert.ok(meanLuminance(dayFromNight.pixels) > meanLuminance(darkPixels) + 6);
  assert.ok(meanLuminance(dayFromNight.pixels) < meanLuminance(darkPixels) + 28);
  assert.ok(meanLuminance(nightFromNight.pixels) < meanLuminance(darkPixels));
  assert.ok(Math.abs(meanLuminance(dayFromDay.pixels) - meanLuminance(brightPixels)) < 25);
  assert.ok(nightFromDay.parameters.applied_exposure_ev < -1.0);
  assert.ok(nightFromDay.parameters.applied_exposure_ev >= -2.3);
  assert.ok(dayFromNight.parameters.applied_exposure_ev > 0.4);
  assert.ok(dayFromNight.parameters.applied_exposure_ev <= 0.85);
  assert.equal(dayFromNight.parameters.preset_outside_conservative_limits, false);
  assert.equal(dayFromNight.parameters.gamma_applied, 1);
});

test('pads datetime-local values without seconds and blends lighting across dusk', async () => {
  assert.equal(normalizeDateTimeLocal('2026-10-21T19:10'), '2026-10-21T19:10:00');
  const defaults = JSON.parse(await readFile(path.join(configDir, 'defaults.json'), 'utf8'));
  const lightingProfile = { ...profile, lighting: defaults.lighting };
  const pixels = Buffer.alloc(320 * 160 * 3, 120);
  const dusk = applyLighting(pixels, 'auto', '2026-10-21T18:20:00', lightingProfile);
  assert.equal(dusk.preset, 'dusk');
  assert.equal(dusk.parameters.blend.from, 'dusk');
  assert.equal(dusk.parameters.blend.to, 'night');
  assert.ok(dusk.parameters.blend.t > 0 && dusk.parameters.blend.t < 1);
});

test('processed night simulation is darker than day simulation on the same source', async () => {
  const defaults = JSON.parse(await readFile(path.join(configDir, 'defaults.json'), 'utf8'));
  const lightingProfile = { ...profile, lighting: defaults.lighting };
  const { sourcePath } = await createSource();
  const outputRoot = path.join(tempDirectory, 'runs');
  const night = await processJob({
    sourcePath,
    outputRoot,
    profile: lightingProfile,
    job: makeJob({
      job_id: 'auto-night',
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'auto',
      datetime_local: '2026-10-21T21:40:00',
    }),
  });
  const day = await processJob({
    sourcePath,
    outputRoot,
    profile: lightingProfile,
    job: makeJob({
      job_id: 'auto-day',
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'auto',
      datetime_local: '2026-10-21T14:30:00',
    }),
  });
  const nightImage = await readRgbImage(night.output_image_path);
  const dayImage = await readRgbImage(day.output_image_path);
  const sampleMean = (image, y0, y1) => {
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const offset = (y * 320 + x) * 3;
        sum += 0.2126 * image.data[offset] + 0.7152 * image.data[offset + 1] + 0.0722 * image.data[offset + 2];
        count += 1;
      }
    }
    return sum / count;
  };
  assert.ok(sampleMean(nightImage, 80, 110) < sampleMean(dayImage, 80, 110) - 12);
  assert.match(
    night.operations.find((operation) => operation.name === 'add_simulated_display_time_overlay').text,
    /21:40:00|21:40/,
  );
  assert.equal(
    day.operations.find((operation) => operation.name === 'adjust_lighting').preset,
    'day',
  );
});

test('highlight-limited daylight does not clip existing bright pixels to white', async () => {
  const defaults = JSON.parse(await readFile(path.join(configDir, 'defaults.json'), 'utf8'));
  const lightingProfile = { ...profile, lighting: defaults.lighting };
  const pixels = Buffer.alloc(320 * 160 * 3, 40);
  for (let offset = 0; offset < 320 * 40 * 3; offset += 3) {
    pixels[offset] = 230;
    pixels[offset + 1] = 230;
    pixels[offset + 2] = 210;
  }
  const day = applyLighting(pixels, 'auto', '2026-10-21T12:30:00', lightingProfile);
  assert.equal(day.preset, 'day');
  assert.equal(day.parameters.highlight_limited, true);
  assert.ok(luminancePercentile(day.pixels, 0.9) <= 245);
  assert.ok(luminancePercentile(day.pixels, 0.9) >= 200);
  assert.ok(meanLuminance(day.pixels) < 160);
});

test('detects a bright timestamp region and never upscales 240p-class frames', () => {
  const width = 320;
  const height = 160;
  const pixels = Buffer.alloc(width * height * 3, 40);
  for (let y = 8; y < 26; y += 1) {
    for (let x = 8; x < 210; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 230;
      pixels[offset + 1] = 230;
      pixels[offset + 2] = 230;
    }
  }
  const roi = detectTimestampRoi(pixels, width, height, { x: 0, y: 0, width: 40, height: 12 });
  assert.ok(roi.detected);
  assert.ok(roi.x <= 10);
  assert.ok(roi.y <= 10);
  assert.ok(roi.width >= 150);
  assert.deepEqual(clampCctvOutputSize(1616, 973), { width: 1616, height: 973, scaled: false });
  assert.deepEqual(clampCctvOutputSize(426, 240), { width: 426, height: 240, scaled: false });
});

