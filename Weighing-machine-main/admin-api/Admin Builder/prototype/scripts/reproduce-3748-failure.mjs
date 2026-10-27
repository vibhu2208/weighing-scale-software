import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  applyLighting,
  lightingBlendForLocalTime,
  parseLocalDateTime,
  processJob,
  resolveLighting,
} from '../src/index.js';

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderRoot = path.resolve(prototypeRoot, '..');
const adminApiRoot = path.resolve(builderRoot, '..');
const outDir = path.join(adminApiRoot, 'admin-builder-data/diagnostics-3748');
const profileTemplate = JSON.parse(await readFile(path.join(builderRoot, 'config/sample_camera_profile.json'), 'utf8'));
const defaults = JSON.parse(await readFile(path.join(builderRoot, 'config/defaults.json'), 'utf8'));

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function luma(p, o) {
  return 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];
}
function summarize(pixels, width, height) {
  const n = width * height;
  let sum = 0;
  let clipLo = 0;
  let clipHi = 0;
  const rgb = [0, 0, 0];
  const samples = [];
  for (let o = 0; o < pixels.length; o += 3) {
    const v = luma(pixels, o);
    sum += v;
    rgb[0] += pixels[o];
    rgb[1] += pixels[o + 1];
    rgb[2] += pixels[o + 2];
    if (v <= 2) clipLo += 1;
    if (v >= 250) clipHi += 1;
    if ((o / 3) % 8 === 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))];
  return {
    width,
    height,
    mean: +(sum / n).toFixed(2),
    p10: +pct(0.1).toFixed(1),
    p50: +pct(0.5).toFixed(1),
    p90: +pct(0.9).toFixed(1),
    clipLoPct: +((100 * clipLo) / n).toFixed(3),
    clipHiPct: +((100 * clipHi) / n).toFixed(3),
    meanRgb: rgb.map((v) => +(v / n).toFixed(1)),
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

const sources = [
  {
    name: 'SOURCE_5587_failed_job',
    path: path.join(adminApiRoot, 'admin-builder-data/test-images/SOURCE_5587c79058ed48e68f18b844f390374e.png'),
  },
  { name: '3748-ac2', path: path.join(builderRoot, 'Test-images/3748-ac2.png') },
  { name: '3748-ac1', path: path.join(builderRoot, 'Test-images/3748-ac1.png') },
];

const datetimeLocal = '2026-10-26T00:53:00';
const parsed = parseLocalDateTime(datetimeLocal);
const blend = lightingBlendForLocalTime(datetimeLocal);
const resolved = resolveLighting('auto', datetimeLocal);
let timezoneValid = true;
try {
  new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata' }).format(new Date());
} catch {
  timezoneValid = false;
}

await mkdir(outDir, { recursive: true });
const reports = [];
for (const source of sources) {
  const bytes = await readFile(source.path);
  const decoded = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  const profile = {
    ...profileTemplate,
    profile_id: `repro-${source.name}`.replaceAll('_', '-').slice(0, 64),
    expected_width: width,
    expected_height: height,
    timezone: 'Asia/Kolkata',
    lighting: defaults.lighting,
  };
  const lighting = applyLighting(decoded.data, 'auto', datetimeLocal, profile);
  const jobDir = path.join(outDir, source.name);
  await mkdir(jobDir, { recursive: true });
  await sharp(lighting.pixels, { raw: { width, height, channels: 3 } }).png().toFile(path.join(jobDir, '02-lighting-only.png'));
  await sharp(decoded.data, { raw: { width, height, channels: 3 } }).png().toFile(path.join(jobDir, '01-source.png'));
  const result = await processJob({
    sourcePath: source.path,
    outputRoot: path.join(jobDir, 'job'),
    profile,
    job: {
      job_id: profile.profile_id,
      profile_id: profile.profile_id,
      datetime_local: datetimeLocal,
      timestamp_enabled: false,
      timestamp_strategy: 'display_annotation',
      lighting_mode: 'auto',
      output_format: 'png',
    },
  });
  const output = await sharp(result.output_image_path).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  await sharp(result.output_image_path).resize(200, 120, { fit: 'cover' }).png().toFile(path.join(jobDir, '08-report-slot-200x120.png'));
  const qa = JSON.parse(await readFile(result.qa_report_path, 'utf8'));
  reports.push({
    source: source.name,
    sourcePath: source.path,
    sourceHash: sha256(bytes),
    outputHash: result.output_sha256,
    sourceStats: summarize(decoded.data, width, height),
    lightingStats: summarize(lighting.pixels, width, height),
    outputStats: summarize(output.data, output.info.width, output.info.height),
    lightingDiff: pixelDiff(decoded.data, lighting.pixels),
    outputDiff: pixelDiff(decoded.data, output.data),
    parsed,
    blend,
    resolved,
    timezone: profile.timezone,
    timezoneValid,
    lightingPreset: lighting.preset,
    lightingParameters: lighting.parameters,
    defaultsDeepNight: defaults.lighting.presets.deep_night,
    sharpOps: [
      'decode srgb raw',
      'applyLighting pixel loop (linear midtone gain only; gamma/saturation/contrast unused)',
      'composite simulated badge',
      'png encode compressionLevel 6',
    ],
    jobStatus: result.status,
    qa_passed: result.qa_passed,
    qa_status: qa.status,
    machine_quality_gates: qa.machine_quality_gates,
    failedChecks: qa.hard_checks.filter((c) => c.pass === false),
    visual_metrics: qa.visual_metrics,
    operations: result.operations.map((op) => ({
      name: op.name,
      preset: op.preset,
      parameters: op.parameters,
      text: op.text,
      plate: op.plate,
    })),
    warnings: result.warnings,
    payload: {
      datetime_local: datetimeLocal,
      timezone: 'Asia/Kolkata',
      lighting_mode: 'auto',
      timestamp_strategy: 'display_annotation',
      timestamp_enabled: false,
      output_format: 'png',
    },
  });
}

await writeFile(path.join(outDir, 'reproduction-report.json'), `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify(reports.map((r) => ({
  source: r.source,
  dims: `${r.sourceStats.width}x${r.sourceStats.height}`,
  sourceMean: r.sourceStats.mean,
  lightingMean: r.lightingStats.mean,
  outputMean: r.outputStats.mean,
  meanAbsLuma: r.lightingDiff.meanAbsLuma,
  changedPct: r.lightingDiff.changedPct,
  preset: r.lightingPreset,
  appliedEv: r.lightingParameters.applied_exposure_ev,
  requestedEv: r.lightingParameters.exposure_ev,
  blend: r.blend,
  resolved,
  tz: r.timezone,
  jobStatus: r.jobStatus,
  qa: r.qa_status,
  gates: r.machine_quality_gates,
  failed: r.failedChecks.map((c) => c.check),
})), null, 2));
