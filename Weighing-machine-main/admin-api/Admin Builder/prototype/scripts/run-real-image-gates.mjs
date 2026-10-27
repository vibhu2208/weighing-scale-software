import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  applyLighting,
  lightingBlendForLocalTime,
  meanLuminance,
  parseLocalDateTime,
  processJob,
  resolveLighting,
} from '../src/index.js';

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderRoot = path.resolve(prototypeRoot, '..');
const outRoot = path.resolve(builderRoot, '../admin-builder-data/real-image-gates');
const imagesDir = path.join(builderRoot, 'Test-images');
const profileTemplate = JSON.parse(await readFile(path.join(builderRoot, 'config/sample_camera_profile.json'), 'utf8'));

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function luma(p, o) {
  return 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];
}
function summarize(pixels, width, height, excluded = []) {
  const n = width * height;
  let sum = 0;
  let clipLo = 0;
  let clipHi = 0;
  const rgb = [0, 0, 0];
  const samples = [];
  let compared = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (excluded.some((rect) => x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height)) continue;
      const o = (y * width + x) * 3;
      const v = luma(pixels, o);
      sum += v;
      rgb[0] += pixels[o];
      rgb[1] += pixels[o + 1];
      rgb[2] += pixels[o + 2];
      compared += 1;
      if (v <= 2) clipLo += 1;
      if (v >= 250) clipHi += 1;
      if (compared % 8 === 0) samples.push(v);
    }
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))];
  return {
    width,
    height,
    mean: +(sum / compared).toFixed(2),
    p10: +pct(0.1).toFixed(1),
    p50: +pct(0.5).toFixed(1),
    p90: +pct(0.9).toFixed(1),
    clipLoPct: +((100 * clipLo) / compared).toFixed(3),
    clipHiPct: +((100 * clipHi) / compared).toFixed(3),
    meanRgb: rgb.map((v) => +(v / compared).toFixed(1)),
  };
}
function pixelDiff(a, b) {
  let sum = 0;
  let changed = 0;
  let max = 0;
  const hist = { d0: 0, d1_5: 0, d6_15: 0, d16_40: 0, d41plus: 0 };
  const n = a.length / 3;
  for (let o = 0; o < a.length; o += 3) {
    const d = Math.abs(luma(a, o) - luma(b, o));
    sum += d;
    if (d > 1) changed += 1;
    if (d > max) max = d;
    if (d < 1) hist.d0 += 1;
    else if (d <= 5) hist.d1_5 += 1;
    else if (d <= 15) hist.d6_15 += 1;
    else if (d <= 40) hist.d16_40 += 1;
    else hist.d41plus += 1;
  }
  return {
    meanAbsLuma: +(sum / n).toFixed(3),
    changedPct: +((100 * changed) / n).toFixed(2),
    maxAbsLuma: +max.toFixed(2),
    hist,
  };
}

async function runCase(name, file, datetimeLocal, notes) {
  const sourcePath = path.join(imagesDir, file);
  const bytes = await readFile(sourcePath);
  const decoded = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  const profile = {
    ...profileTemplate,
    profile_id: `gate-${name}`.slice(0, 64),
    expected_width: width,
    expected_height: height,
    timezone: 'Asia/Kolkata',
  };
  const parsed = parseLocalDateTime(datetimeLocal);
  const blend = lightingBlendForLocalTime(datetimeLocal);
  const resolved = resolveLighting('auto', datetimeLocal);
  const lighting = applyLighting(decoded.data, 'auto', datetimeLocal, profile);
  const caseDir = path.join(outRoot, name);
  await mkdir(caseDir, { recursive: true });
  await sharp(decoded.data, { raw: { width, height, channels: 3 } }).png().toFile(path.join(caseDir, '01-source.png'));
  await sharp(lighting.pixels, { raw: { width, height, channels: 3 } }).png().toFile(path.join(caseDir, '02-lighting-only.png'));
  const result = await processJob({
    sourcePath,
    outputRoot: path.join(caseDir, 'job'),
    profile,
    job: {
      job_id: profile.profile_id.replaceAll('_', '-'),
      profile_id: profile.profile_id,
      datetime_local: datetimeLocal,
      timestamp_enabled: false,
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'auto',
      output_format: 'png',
    },
  });
  const output = await sharp(result.output_image_path).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  await sharp(result.output_image_path).resize(200, 120, { fit: 'cover' }).png().toFile(path.join(caseDir, '08-report-slot-200x120.png'));
  const overlay = result.operations.find((op) => op.name === 'add_simulated_display_time_overlay');
  const excluded = overlay?.plate ? [overlay.plate] : [];
  const qa = JSON.parse(await readFile(result.qa_report_path, 'utf8'));
  const report = {
    name,
    notes,
    file,
    datetimeLocal,
    timezone: 'Asia/Kolkata',
    parsed,
    blend,
    resolved,
    sourceHash: sha256(bytes),
    outputHash: result.output_sha256,
    sourceStats: summarize(decoded.data, width, height, excluded),
    lightingStats: summarize(lighting.pixels, width, height, excluded),
    outputStats: summarize(output.data, output.info.width, output.info.height, excluded),
    lightingDiff: pixelDiff(decoded.data, lighting.pixels),
    lightingParameters: lighting.parameters,
    processing_status: result.processing_status,
    qa_status: result.qa_status,
    visually_approved: result.visually_approved,
    machine_quality_gates: qa.machine_quality_gates,
    failedChecks: qa.hard_checks.filter((item) => item.pass === false),
    visual_metrics: qa.visual_metrics,
    plate: overlay?.plate || null,
    requested_time: overlay?.requested_time || null,
    warnings: result.warnings,
    human_review_status: 'pending',
  };
  await writeFile(path.join(caseDir, 'diagnostics.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

await mkdir(outRoot, { recursive: true });
const reports = [];
reports.push(await runCase('A-3748-ac2-deep-night', '3748-ac2.png', '2026-10-26T00:53:00', 'Day source to deep-night simulation'));
reports.push(await runCase('A2-SOURCE5587-deep-night', '3748-ac2.png', '2026-10-26T00:53:00', 'Catalog 3748-ac2 companion'));
reports.push(await runCase('B-3515-ac1-to-day', '3515-ac1.png', '2026-10-21T13:00:00', 'Night source to daytime simulation'));
reports.push(await runCase('C-8815-ac1-evening', '8815-ac1.png', '2026-10-21T18:30:00', 'Day source to evening/night'));
for (const time of ['03:00:00', '08:00:00', '13:00:00', '18:00:00', '22:00:00']) {
  reports.push(await runCase(
    `D-3748-ac2-${time.replaceAll(':', '')}`,
    '3748-ac2.png',
    `2026-10-26T${time}`,
    `Same source, requested ${time}`,
  ));
}

const failedJob = path.resolve(builderRoot, '../admin-builder-data/test-images/SOURCE_5587c79058ed48e68f18b844f390374e.png');
const failedBytes = await readFile(failedJob);
const failedDecoded = await sharp(failedBytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
const failedProfile = {
  ...profileTemplate,
  profile_id: 'gate-failed-5587',
  expected_width: failedDecoded.info.width,
  expected_height: failedDecoded.info.height,
  timezone: 'Asia/Kolkata',
};
const failedLighting = applyLighting(failedDecoded.data, 'auto', '2026-10-26T00:53:00', failedProfile);
const failedDir = path.join(outRoot, 'A-SOURCE5587-exact-failed-job');
await mkdir(path.join(failedDir, 'job'), { recursive: true });
await sharp(failedDecoded.data, { raw: { width: failedDecoded.info.width, height: failedDecoded.info.height, channels: 3 } }).png().toFile(path.join(failedDir, '01-source.png'));
await sharp(failedLighting.pixels, { raw: { width: failedDecoded.info.width, height: failedDecoded.info.height, channels: 3 } }).png().toFile(path.join(failedDir, '02-lighting-only.png'));
const failedResult = await processJob({
  sourcePath: failedJob,
  outputRoot: path.join(failedDir, 'job'),
  profile: failedProfile,
  job: {
    job_id: 'gate-failed-5587',
    profile_id: failedProfile.profile_id,
    datetime_local: '2026-10-26T00:53:00',
    timestamp_enabled: false,
    timestamp_strategy: 'display_annotation',
    lighting_mode: 'auto',
    output_format: 'png',
  },
});
await sharp(failedResult.output_image_path).resize(200, 120, { fit: 'cover' }).png().toFile(path.join(failedDir, '08-report-slot-200x120.png'));
const failedQa = JSON.parse(await readFile(failedResult.qa_report_path, 'utf8'));
reports.unshift({
  name: 'A-SOURCE5587-exact-failed-job',
  notes: 'Exact user-failed upload, OSD 26-10-2026 07:14:55, requested 00:53:00',
  sourceMean: meanLuminance(failedDecoded.data),
  lightingMean: meanLuminance(failedLighting.pixels),
  lightingParameters: failedLighting.parameters,
  processing_status: failedResult.processing_status,
  qa_status: failedResult.qa_status,
  visually_approved: failedResult.visually_approved,
  machine_quality_gates: failedQa.machine_quality_gates,
  failedChecks: failedQa.hard_checks.filter((item) => item.pass === false),
  visual_metrics: failedQa.visual_metrics,
  plate: failedResult.operations.find((op) => op.name === 'add_simulated_display_time_overlay')?.plate,
});

await writeFile(path.join(outRoot, 'summary.json'), `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify(reports.map((r) => ({
  name: r.name,
  preset: r.resolved || r.lightingParameters?.preset || r.lightingParameters && undefined,
  appliedEv: r.lightingParameters?.applied_exposure_ev,
  sourceMean: r.sourceStats?.mean ?? r.sourceMean,
  lightingMean: r.lightingStats?.mean ?? r.lightingMean,
  outputMean: r.outputStats?.mean,
  qa: r.qa_status,
  gates: r.machine_quality_gates,
  failed: (r.failedChecks || []).map((c) => c.check),
  plate: r.plate ? `${r.plate.width}x${r.plate.height}` : null,
})), null, 2));
