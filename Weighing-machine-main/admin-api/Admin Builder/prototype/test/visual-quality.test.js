import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  applyLighting,
  assessVisualQuality,
  meanLuminance,
  processJob,
} from '../src/index.js';

const profilePath = fileURLToPath(new URL('../../config/sample_camera_profile.json', import.meta.url));
const samplePath = fileURLToPath(new URL('../../Test-images/3515-ac1.png', import.meta.url));
const failedJobPath = fileURLToPath(new URL('../../../admin-builder-data/test-images/SOURCE_5587c79058ed48e68f18b844f390374e.png', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../Test-images/3748-ac2.png', import.meta.url));
const sample3748Path = existsSync(failedJobPath) ? failedJobPath : catalogPath;

function luma(pixels, offset) {
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

test('day grade holds near-black pixels, gray balance, and bright-panel separation', async () => {
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  const width = 64;
  const height = 32;
  const pixels = Buffer.alloc(width * height * 3);
  const paint = (x0, x1, rgb) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  };
  paint(0, 16, [4, 4, 4]);
  paint(16, 32, [100, 100, 100]);
  paint(32, 48, [170, 168, 166]);
  paint(48, 64, [210, 206, 202]);
  const day = applyLighting(pixels, 'day', '2026-10-25T12:26:10', profile);
  const shadow = luma(day.pixels, 0);
  const mid = luma(day.pixels, 20 * 3);
  const panelA = luma(day.pixels, 36 * 3);
  const panelB = luma(day.pixels, 52 * 3);
  assert.ok(shadow <= 8, `near-black rose to ${shadow}`);
  assert.ok(mid >= 95 && mid < 130, `midtone moved to ${mid}`);
  assert.ok(Math.abs(panelA - 169) <= 8, `bright panel moved to ${panelA}`);
  assert.ok(Math.abs(panelB - 207) <= 8, `brighter panel moved to ${panelB}`);
  assert.ok(panelB - panelA > 20, 'bright panels lost their separation');
  assert.ok(Math.abs(day.pixels[20 * 3] - day.pixels[20 * 3 + 1]) <= 1);
  assert.equal(day.parameters.preset_outside_conservative_limits, false);
  assert.ok(meanLuminance(day.pixels) < 140);
  const night = applyLighting(pixels, 'deep_night', '2026-10-26T00:53:00', profile);
  assert.ok(meanLuminance(night.pixels) < meanLuminance(day.pixels) - 18, 'deep night must be materially darker than day');
  assert.ok(night.parameters.applied_exposure_ev <= -1.4);
});

test('flags an unintended black rectangle and accepts a clean grade', () => {
  const width = 80;
  const height = 40;
  const source = Buffer.alloc(width * height * 3, 120);
  const damaged = Buffer.from(source);
  for (let y = 4; y < 24; y += 1) {
    for (let x = 6; x < 40; x += 1) {
      const offset = (y * width + x) * 3;
      damaged[offset] = 0;
      damaged[offset + 1] = 0;
      damaged[offset + 2] = 0;
    }
  }
  const flagged = assessVisualQuality({
    sourcePixels: source,
    outputPixels: damaged,
    width,
    height,
    lighting: { preset: 'none', parameters: { applied_exposure_ev: 0, gamma_applied: 1, contrast_applied: 1 } },
  });
  assert.equal(flagged.machineGatesPass, false);
  assert.equal(
    flagged.checks.find((item) => item.check === 'no_unintended_large_black_rectangles').pass,
    false,
  );

  const clean = assessVisualQuality({
    sourcePixels: source,
    outputPixels: source,
    width,
    height,
    lighting: { preset: 'none', parameters: { applied_exposure_ev: 0, gamma_applied: 1, contrast_applied: 1 } },
  });
  assert.equal(clean.machineGatesPass, true);
});

test('3515 day derivative keeps the camera timestamp and does not flatten the bright hood', {
  skip: existsSync(samplePath) ? false : 'requires local Test-images/3515-ac1.png (gitignored CCTV sample)',
}, async () => {
  const sourceProfile = JSON.parse(await readFile(profilePath, 'utf8'));
  const metadata = await sharp(samplePath).metadata();
  const profile = {
    ...sourceProfile,
    profile_id: 'camera-3515',
    expected_width: metadata.width,
    expected_height: metadata.height,
  };
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-3515-'));
  const result = await processJob({
    sourcePath: samplePath,
    outputRoot,
    profile,
    job: {
      job_id: '3515-day-gate',
      profile_id: profile.profile_id,
      datetime_local: '2026-10-25T12:26:10',
      timestamp_enabled: false,
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'day',
      output_format: 'png',
    },
  });
  assert.equal(result.processing_status, 'PROCESSING_COMPLETE');
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.qa_status, 'NEEDS_REVIEW');
  assert.equal(result.qa_passed, false);
  assert.equal(result.visually_approved, false);
  const qaReport = JSON.parse(await readFile(result.qa_report_path, 'utf8'));
  assert.equal(qaReport.status, 'NEEDS_REVIEW');
  assert.equal(qaReport.machine_quality_gates, 'pass');
  assert.ok(qaReport.hard_checks.every((item) => item.pass !== false));

  const source = await sharp(samplePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(result.output_image_path).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, source.info.width);
  assert.equal(output.info.height, source.info.height);
  const width = source.info.width;
  let sourceBright = 0;
  let movedBright = 0;
  let blackenedGlyphs = 0;
  let brightGlyphs = 0;
  for (let y = 0; y < 48; y += 1) {
    for (let x = 0; x < 420; x += 1) {
      const offset = (y * width + x) * 3;
      const sourceLuma = luma(source.data, offset);
      const outputLuma = luma(output.data, offset);
      if (sourceLuma > 180) {
        brightGlyphs += 1;
        if (outputLuma < 40) blackenedGlyphs += 1;
      }
    }
  }
  assert.ok(brightGlyphs > 100);
  assert.equal(blackenedGlyphs, 0);

  for (let y = 140; y < 250; y += 2) {
    for (let x = 250; x < 620; x += 2) {
      const offset = (y * width + x) * 3;
      const sourceLuma = luma(source.data, offset);
      if (sourceLuma < 150 || sourceLuma > 220) continue;
      sourceBright += 1;
      if (Math.abs(luma(output.data, offset) - sourceLuma) > 10) movedBright += 1;
    }
  }
  assert.ok(sourceBright > 50, 'expected a bright hood sample');
  assert.ok(movedBright / sourceBright < 0.08, `hood pixels moved ${movedBright}/${sourceBright}`);
  await rm(outputRoot, { recursive: true, force: true });
});

test('3748 day-to-deep-night is classified, darkened, and not auto-approved', {
  skip: existsSync(sample3748Path) ? false : 'requires a local 3748 CCTV sample (gitignored)',
}, async () => {
  const sourcePath = sample3748Path;
  const sourceProfile = JSON.parse(await readFile(profilePath, 'utf8'));
  const metadata = await sharp(sourcePath).metadata();
  const profile = {
    ...sourceProfile,
    profile_id: 'camera-3748-night',
    expected_width: metadata.width,
    expected_height: metadata.height,
    timezone: 'Asia/Kolkata',
  };
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-3748-'));
  const result = await processJob({
    sourcePath,
    outputRoot,
    profile,
    job: {
      job_id: '3748-deep-night-gate',
      profile_id: profile.profile_id,
      datetime_local: '2026-10-26T00:53:00',
      timestamp_enabled: false,
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'auto',
      output_format: 'png',
    },
  });
  assert.equal(result.processing_status, 'PROCESSING_COMPLETE');
  assert.equal(result.qa_passed, false);
  assert.equal(result.visually_approved, false);
  assert.notEqual(result.status, 'APPROVED');
  const lighting = result.operations.find((operation) => operation.name === 'adjust_lighting');
  assert.equal(lighting.preset, 'deep_night');
  assert.ok(lighting.parameters.applied_exposure_ev <= -1.4);
  const overlay = result.operations.find((operation) => operation.name === 'add_simulated_display_time_overlay');
  assert.match(overlay.text, /00:53:00/);
  assert.ok(overlay.plate.height <= 56);
  assert.ok(overlay.plate.width <= 360);

  const source = await sharp(sourcePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(result.output_image_path).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, source.info.width);
  assert.equal(output.info.height, source.info.height);
  const sourceMean = meanLuminance(source.data);
  const outputMean = meanLuminance(output.data);
  assert.ok(sourceMean >= 68, `expected a daylight source, got mean ${sourceMean}`);
  assert.ok(outputMean < sourceMean * 0.72, `night grade too weak: ${sourceMean} -> ${outputMean}`);
  assert.ok(outputMean <= 64, `night output still daylight-bright at ${outputMean}`);
  let brightGlyphs = 0;
  let blackenedGlyphs = 0;
  const width = source.info.width;
  for (let y = 0; y < 42; y += 1) {
    for (let x = 0; x < 360; x += 1) {
      const offset = (y * width + x) * 3;
      if (luma(source.data, offset) > 180) {
        brightGlyphs += 1;
        if (luma(output.data, offset) < 40) blackenedGlyphs += 1;
      }
    }
  }
  assert.ok(brightGlyphs > 40);
  assert.equal(blackenedGlyphs, 0);
  await rm(outputRoot, { recursive: true, force: true });
});
