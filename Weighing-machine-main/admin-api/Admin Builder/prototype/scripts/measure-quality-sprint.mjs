import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { applyLighting, processJob } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const imagesDir = path.join(root, 'Test-images');
const outDir = path.resolve(root, '../admin-builder-data/quality-sprint');
const profileTemplate = JSON.parse(await readFile(path.join(root, 'config/sample_camera_profile.json'), 'utf8'));

function luma(pixels, offset) {
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

function summarize(pixels, width, height) {
  const values = [];
  let sum = 0;
  let clipLo = 0;
  let clipHi = 0;
  let colorSum = [0, 0, 0];
  const count = width * height;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const value = luma(pixels, offset);
    sum += value;
    colorSum[0] += pixels[offset];
    colorSum[1] += pixels[offset + 1];
    colorSum[2] += pixels[offset + 2];
    if (value <= 2) clipLo += 1;
    if (value >= 250) clipHi += 1;
    if ((offset / 3) % 4 === 0) values.push(value);
  }
  values.sort((a, b) => a - b);
  const pct = (p) => values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))];
  let contrast = 0;
  let contrastCount = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width - 4; x += 4) {
      const left = (y * width + x) * 3;
      const right = (y * width + x + 4) * 3;
      contrast += Math.abs(luma(pixels, left) - luma(pixels, right));
      contrastCount += 1;
    }
  }
  return {
    width,
    height,
    mean: Number((sum / count).toFixed(2)),
    p10: Number(pct(0.1).toFixed(1)),
    p50: Number(pct(0.5).toFixed(1)),
    p90: Number(pct(0.9).toFixed(1)),
    clipLoPct: Number(((100 * clipLo) / count).toFixed(3)),
    clipHiPct: Number(((100 * clipHi) / count).toFixed(3)),
    meanRgb: colorSum.map((value) => Number((value / count).toFixed(1))),
    localContrast: Number((contrast / contrastCount).toFixed(3)),
  };
}

await mkdir(outDir, { recursive: true });
const names = (await readdir(imagesDir)).filter((name) => name.endsWith('.png') && !name.startsWith('Pasted'));
const references = [];
for (const name of names.sort()) {
  const decoded = await sharp(path.join(imagesDir, name)).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  references.push({
    file: name,
    truck: name.split('-')[0],
    slot: name.replace('.png', '').split('-').slice(1).join('-'),
    ...summarize(decoded.data, decoded.info.width, decoded.info.height),
  });
}
await writeFile(path.join(outDir, 'reference-stats.json'), `${JSON.stringify(references, null, 2)}\n`);

const jobs = [
  ['3515-ac1.png', '2026-10-25T12:26:10', 'day'],
  ['3515-ac1.png', '2026-10-25T21:40:00', 'night'],
  ['3515-dc1.png', '2026-10-25T12:26:10', 'day'],
  ['8815-ac1.png', '2026-10-25T21:40:00', 'night'],
];
const jobReports = [];
for (const [file, datetime, label] of jobs) {
  const sourcePath = path.join(imagesDir, file);
  const metadata = await sharp(sourcePath).metadata();
  const profile = {
    ...profileTemplate,
    profile_id: 'quality-sprint',
    expected_width: metadata.width,
    expected_height: metadata.height,
  };
  const jobId = `${file.replace('.png', '')}-${label}`;
  const result = await processJob({
    sourcePath,
    outputRoot: path.join(outDir, 'jobs'),
    profile,
    job: {
      job_id: jobId,
      profile_id: profile.profile_id,
      datetime_local: datetime,
      timestamp_enabled: false,
      timestamp_strategy: 'display_annotation',
      lighting_mode: label,
      output_format: 'png',
    },
  });
  const source = await sharp(sourcePath).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(result.output_image_path).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lit = applyLighting(source.data, label, datetime, profile);
  const cropDir = path.join(outDir, jobId);
  await mkdir(cropDir, { recursive: true });
  const save = async (pixels, name, extract) => {
    let image = sharp(pixels, { raw: { width: source.info.width, height: source.info.height, channels: 3 } });
    if (extract) image = image.extract(extract);
    await image.png().toFile(path.join(cropDir, name));
  };
  await save(source.data, '01-source-osd.png', { left: 0, top: 0, width: 520, height: 80 });
  await save(lit.pixels, '02-lighting-osd.png', { left: 0, top: 0, width: 520, height: 80 });
  await save(output.data, '03-final-osd.png', { left: 0, top: 0, width: 520, height: 80 });
  await save(source.data, '04-source-hood.png', { left: 140, top: 60, width: 620, height: 260 });
  await save(lit.pixels, '05-lighting-hood.png', { left: 140, top: 60, width: 620, height: 260 });
  await save(output.data, '06-final-hood.png', { left: 140, top: 60, width: 620, height: 260 });
  const badgeLeft = Math.max(0, source.info.width - 560);
  await save(output.data, '07-badge-corner.png', { left: badgeLeft, top: 0, width: 560, height: 120 });
  await sharp(result.output_image_path).resize(200, 120, { fit: 'cover' }).png().toFile(path.join(cropDir, '08-report-slot-200x120.png'));
  jobReports.push({
    file,
    label,
    status: result.status,
    qa_passed: result.qa_passed,
    metrics: JSON.parse(await readFile(result.qa_report_path, 'utf8')).visual_metrics,
    machine_quality_gates: JSON.parse(await readFile(result.manifest_path, 'utf8')).machine_quality_gates,
    source: summarize(source.data, source.info.width, source.info.height),
    lighting: summarize(lit.pixels, source.info.width, source.info.height),
    output: summarize(output.data, output.info.width, output.info.height),
    output_image: result.output_image_path,
  });
}
await writeFile(path.join(outDir, 'job-metrics.json'), `${JSON.stringify(jobReports, null, 2)}\n`);
console.log(JSON.stringify(jobReports.map((job) => ({
  file: job.file,
  label: job.label,
  status: job.status,
  gates: job.machine_quality_gates,
  sourceMean: job.source.mean,
  lightingMean: job.lighting.mean,
  outputMean: job.output.mean,
  sourceContrast: job.source.localContrast,
  lightingContrast: job.lighting.localContrast,
  metrics: job.metrics,
})), null, 2));
