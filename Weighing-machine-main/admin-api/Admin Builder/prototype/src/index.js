import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ProcessingError } from './errors.js';
import { applyLighting } from './lighting.js';
import { assessVisualQuality, reportSafeRect } from './quality.js';
import {
  MAX_INPUT_BYTES,
  MAX_PIXELS,
  formatTimestamp,
  validateInputPath,
  validateJob,
  validateProfile,
} from './validation.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeWatermarkSvg(width, height) {
  const badge = provenanceWatermark(width, height);
  const fontSize = Math.max(10, Math.min(18, Math.round(height * 0.018)));
  const label = 'EDITED DERIVATIVE - NOT ORIGINAL CCTV';
  if (badge.width > width || badge.height < fontSize + 8) {
    throw new ProcessingError(
      'IMAGE_TOO_SMALL_FOR_WATERMARK',
      'Image dimensions are too small for a clearly visible edited-derivative label.',
    );
  }
  return {
    badge,
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${badge.width}" height="${badge.height}"><rect width="${badge.width}" height="${badge.height}" fill="#111827"/><text x="8" y="${fontSize + 5}" fill="#ffffff" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${label}</text></svg>`,
    ),
  };
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function colorToHex(rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

async function loadProfile(profile, profilePath) {
  if (profile && profilePath) {
    throw new ProcessingError('INVALID_PROFILE', 'Pass either profile or profilePath, not both.');
  }
  if (profilePath) {
    let contents;
    try {
      contents = await readFile(profilePath, 'utf8');
    } catch (error) {
      throw new ProcessingError('PROFILE_READ_FAILED', `Could not read camera profile: ${error.message}`);
    }
    try {
      profile = JSON.parse(contents);
    } catch {
      throw new ProcessingError('INVALID_PROFILE', 'Camera profile must contain valid JSON.');
    }
  }
  return profile;
}

async function decodeImage(buffer, label) {
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new ProcessingError('IMAGE_TOO_LARGE', `${label} exceeds the 25 MB encoded image limit.`);
  }
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
  } catch (error) {
    throw new ProcessingError('INVALID_IMAGE', `${label} cannot be decoded: ${error.message}`);
  }
  if (!['jpeg', 'png'].includes(metadata.format)) {
    throw new ProcessingError('UNSUPPORTED_FORMAT', `${label} must decode as JPEG or PNG.`);
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
    throw new ProcessingError('IMAGE_TOO_LARGE', `${label} dimensions exceed the 20 million pixel limit.`);
  }
  if (metadata.orientation && metadata.orientation !== 1) {
    throw new ProcessingError(
      'UNSUPPORTED_ORIENTATION',
      `${label} has EXIF orientation ${metadata.orientation}; normalize it explicitly before processing.`,
    );
  }
  try {
    const decoded = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
    })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    let pixels;
    if (decoded.info.channels === 3) {
      pixels = decoded.data;
    } else if (decoded.info.channels === 4) {
      pixels = Buffer.allocUnsafe(decoded.info.width * decoded.info.height * 3);
      for (let sourceOffset = 0, targetOffset = 0; sourceOffset < decoded.data.length; sourceOffset += 4) {
        if (decoded.data[sourceOffset + 3] !== 255) {
          throw new ProcessingError(
            'UNSUPPORTED_TRANSPARENCY',
            `${label} contains transparent pixels; flatten it explicitly before processing.`,
          );
        }
        pixels[targetOffset] = decoded.data[sourceOffset];
        pixels[targetOffset + 1] = decoded.data[sourceOffset + 1];
        pixels[targetOffset + 2] = decoded.data[sourceOffset + 2];
        targetOffset += 3;
      }
    } else {
      throw new Error(`Expected 3 RGB channels or opaque RGBA, received ${decoded.info.channels}.`);
    }
    return {
      metadata,
      width: decoded.info.width,
      height: decoded.info.height,
      pixels,
    };
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError('INVALID_IMAGE', `${label} could not be decoded as RGB: ${error.message}`);
  }
}

function assertProfileDimensions(profile, width, height) {
  if (profile.expected_width !== width || profile.expected_height !== height) {
    throw new ProcessingError(
      'PROFILE_DIMENSION_MISMATCH',
      `Image is ${width}x${height}; profile expects ${profile.expected_width}x${profile.expected_height}.`,
    );
  }
}

function estimateTextWidth(text, fontSize) {
  return Math.ceil(text.length * fontSize * 0.62);
}

export function detectTimestampRoi(pixels, width, height, fallbackRoi) {
  // OSD lives in a small top-left strip. Do not search the truck cab or sky.
  const searchHeight = Math.min(height, 42);
  const searchWidth = Math.min(width, 430);
  let minX = searchWidth;
  let minY = searchHeight;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < searchHeight; y += 1) {
    for (let x = 0; x < searchWidth; x += 1) {
      const offset = (y * width + x) * 3;
      const luma = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      if (luma < 175) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (count < 40 || maxX <= minX || maxY <= minY) {
    return fallbackRoi;
  }
  const padX = 8;
  const padY = 4;
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  return {
    x,
    y,
    width: Math.min(width - x, Math.min(430, maxX - minX + 1 + padX * 2)),
    height: Math.min(height - y, Math.min(40, maxY - minY + 1 + padY * 2)),
    detected: true,
  };
}

export function clampCctvOutputSize(width, height) {
  return { width, height, scaled: false };
}

function badgeLines(timeText) {
  return [
    `SIMULATED ${timeText}`,
    'EDITED DERIVATIVE',
    'NOT ORIGINAL CCTV',
  ];
}

function badgeTextElements(lines, font, subFont, pad) {
  const rows = [
    { text: lines[0], size: font, fill: '#f5f5f5', weight: 700, y: pad + font - 1 },
    { text: lines[1], size: subFont, fill: '#e5e7eb', weight: 600, y: pad + font + subFont + 3 },
    { text: lines[2], size: subFont, fill: '#e5e7eb', weight: 600, y: pad + font + subFont * 2 + 7 },
  ];
  return rows
    .map((row) => `<text x="${pad}" y="${row.y}" fill="${row.fill}" font-family="sans-serif" font-size="${row.size}" font-weight="${row.weight}">${escapeXml(row.text)}</text>`)
    .join('');
}

async function measureOpaqueText(svg, width, height) {
  const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = rendered;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let sample = null;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const alpha = data[offset + 3];
      if (alpha < 20) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (
        !sample &&
        alpha > 220 &&
        data[offset] > 230 &&
        data[offset + 1] > 230 &&
        data[offset + 2] > 230
      ) {
        sample = { x, y };
      }
    }
  }
  return { minX, minY, maxX, maxY, sample, width, height };
}

async function renderSimulatedBadge(timeText, maxWidth, maxHeight) {
  const lines = badgeLines(timeText);
  for (let font = 13; font >= 9; font -= 1) {
    const subFont = Math.max(8, font - 3);
    const pad = 5;
    const textWidth = Math.max(
      estimateTextWidth(lines[0], font),
      estimateTextWidth(lines[1], subFont),
      estimateTextWidth(lines[2], subFont),
    );
    const width = textWidth + pad * 2;
    const height = pad * 2 + font + subFont * 2 + 8;
    if (width > maxWidth || height > maxHeight) continue;
    const text = badgeTextElements(lines, font, subFont, pad);
    const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${text}</svg>`;
    const measured = await measureOpaqueText(textSvg, width, height);
    const inset = 4;
    const fitted = measured.maxX >= 0 &&
      measured.minX >= inset &&
      measured.minY >= inset &&
      measured.maxX <= width - 1 - inset &&
      measured.maxY <= height - 1 - inset &&
      measured.sample;
    if (!fitted) continue;
    const plateSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#141414"/>${text}</svg>`;
    return {
      svg: Buffer.from(plateSvg),
      width,
      height,
      sample: measured.sample,
      label: lines[0],
    };
  }
  throw new ProcessingError(
    'IMAGE_TOO_SMALL_FOR_ANNOTATION',
    'Image is too small for a readable simulated-time label that stays clear of the camera timestamp.',
  );
}

function placeBadge(badge, safe, osd) {
  const margin = 8;
  const right = safe.left + safe.width - badge.width - margin;
  const candidates = [
    { left: right, top: safe.top + margin },
    { left: right, top: safe.top + safe.height - badge.height - margin },
  ];
  if (osd?.detected) {
    candidates.splice(1, 0, {
      left: right,
      top: Math.min(
        safe.top + safe.height - badge.height - margin,
        osd.y + osd.height + margin,
      ),
    });
  }
  for (const candidate of candidates) {
    const plate = { left: candidate.left, top: candidate.top, width: badge.width, height: badge.height };
    const insideSafe = plate.left >= safe.left + margin &&
      plate.top >= safe.top + margin &&
      plate.left + plate.width <= safe.left + safe.width - margin &&
      plate.top + plate.height <= safe.top + safe.height - margin;
    const coversOsd = osd?.detected && overlaps(
      plate.left,
      plate.top,
      plate.width,
      plate.height,
      { left: osd.x, top: osd.y, width: osd.width, height: osd.height },
    );
    if (insideSafe && !coversOsd) return plate;
  }
  throw new ProcessingError(
    'TIMESTAMP_OVERLAP',
    'The simulated time label cannot be placed without covering the camera timestamp or leaving the report-safe area.',
  );
}

export async function buildDisplayOverlays({
  width,
  height,
  datetimeLocal,
  profile,
  lightingPreset,
  sourcePixels = null,
}) {
  const requestedTime = formatTimestamp(datetimeLocal, profile.timestamp.format);
  const lightingLabel =
    lightingPreset && lightingPreset !== 'none'
      ? lightingPreset.replaceAll('_', ' ')
      : 'unchanged';
  const fallbackRoi = profile.timestamp.roi;
  const roi = sourcePixels
    ? detectTimestampRoi(sourcePixels, width, height, fallbackRoi)
    : { ...fallbackRoi, detected: false };
  const safe = reportSafeRect(width, height);
  const maxWidth = Math.max(1, safe.width - 16);
  const maxHeight = Math.max(1, Math.min(52, safe.height - 16));
  const badge = await renderSimulatedBadge(requestedTime, maxWidth, maxHeight);
  const placed = placeBadge(badge, safe, roi.detected ? roi : null);
  const plate = {
    ...placed,
    text: badge.label,
    textX: badge.sample.x,
    textY: badge.sample.y,
  };
  return {
    overlays: [{ input: badge.svg, left: plate.left, top: plate.top }],
    requestedTime,
    simulatedLabel: badge.label,
    lightingLabel,
    bandHeight: 0,
    band: null,
    plate,
    roi,
    safe,
  };
}

function copyRegion(target, source, imageWidth, roi) {
  const rowBytes = roi.width * 3;
  for (let row = 0; row < roi.height; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = ((roi.y + row) * imageWidth + roi.x) * 3;
    source.copy(target, targetOffset, sourceOffset, sourceOffset + rowBytes);
  }
}

function provenanceWatermark(width, height) {
  const fontSize = Math.max(10, Math.min(18, Math.round(height * 0.018)));
  const badgeWidth = Math.ceil('EDITED DERIVATIVE - NOT ORIGINAL CCTV'.length * fontSize * 0.62 + 16);
  const badgeHeight = fontSize + 10;
  return {
    left: 8,
    top: height - badgeHeight - 8,
    width: badgeWidth,
    height: badgeHeight,
  };
}

function overlaps(left, top, width, height, other) {
  return (
    left < other.left + other.width &&
    left + width > other.left &&
    top < other.top + other.height &&
    top + height > other.top
  );
}

async function makeTimestampSvg(text, profile, roi) {
  const style = profile.timestamp;
  const estimatedWidth = text.length * style.font_size_px * 0.68 + 4;
  if (estimatedWidth > roi.width || style.font_size_px + 2 > roi.height) {
    throw new ProcessingError(
      'TIMESTAMP_CLIPPED',
      'Requested timestamp does not fit inside the configured ROI at the selected font size.',
    );
  }
  const color = colorToHex(style.color_rgb);
  const fontFamily = escapeXml(style.font_family);
  const escapedText = escapeXml(text);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${roi.width}" height="${roi.height}"><text x="2" y="${style.font_size_px}" fill="${color}" font-family="${fontFamily}" font-size="${style.font_size_px}" xml:space="preserve">${escapedText}</text></svg>`,
  );
  const rendered = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = rendered.info;
  for (let x = 0; x < width; x += 1) {
    const topAlpha = rendered.data[(x * channels) + 3];
    const bottomAlpha = rendered.data[((height - 1) * width + x) * channels + 3];
    if (topAlpha || bottomAlpha) {
      throw new ProcessingError('TIMESTAMP_CLIPPED', 'Rendered timestamp touches the top or bottom edge of its ROI.');
    }
  }
  for (let y = 0; y < height; y += 1) {
    const leftAlpha = rendered.data[(y * width) * channels + 3];
    const rightAlpha = rendered.data[(y * width + width - 1) * channels + 3];
    if (leftAlpha || rightAlpha) {
      throw new ProcessingError('TIMESTAMP_CLIPPED', 'Rendered timestamp touches the left or right edge of its ROI.');
    }
  }
  return svg;
}

function annotationExclusionRects(annotation) {
  return [annotation.plate, annotation.band].filter(Boolean);
}

async function loadReferencePatch(referencePatchPath, roi) {
  if (typeof referencePatchPath !== 'string' || !referencePatchPath.trim()) {
    throw new ProcessingError(
      'REFERENCE_PATCH_REQUIRED',
      'Timestamp replacement requires an operator-verified reference patch for the same camera view.',
    );
  }
  let buffer;
  try {
    buffer = await readFile(referencePatchPath);
  } catch (error) {
    throw new ProcessingError('REFERENCE_PATCH_READ_FAILED', `Could not read reference patch: ${error.message}`);
  }
  const decoded = await decodeImage(buffer, 'Reference patch');
  if (decoded.width !== roi.width || decoded.height !== roi.height) {
    throw new ProcessingError(
      'REFERENCE_PATCH_DIMENSION_MISMATCH',
      `Reference patch is ${decoded.width}x${decoded.height}; timestamp ROI is ${roi.width}x${roi.height}.`,
    );
  }
  return { ...decoded, sha256: sha256(buffer) };
}

function excludedByRects(x, y, rects) {
  return rects.some(
    (rect) =>
      rect &&
      x >= rect.left &&
      x < rect.left + rect.width &&
      y >= rect.top &&
      y < rect.top + rect.height,
  );
}

function assertPixelsOutsideRectsUnchanged(before, after, width, rects) {
  let equal = true;
  for (let y = 0; y < after.height && equal; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (excludedByRects(x, y, rects)) continue;
      const offset = (y * width + x) * 3;
      if (
        before[offset] !== after.pixels[offset] ||
        before[offset + 1] !== after.pixels[offset + 1] ||
        before[offset + 2] !== after.pixels[offset + 2]
      ) {
        equal = false;
        break;
      }
    }
  }
  return equal;
}

function buildSvgOverlay(pixels, width, height, svg, roi) {
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .composite([{ input: svg, left: roi.x, top: roi.y }])
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function toJsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeNewJobDirectory(outputRoot, jobId, artifacts) {
  const root = path.resolve(outputRoot);
  const jobDirectory = path.join(root, jobId);
  const imagePath = path.join(jobDirectory, `EDITED_${jobId}.${artifacts.extension}`);
  const manifestPath = path.join(jobDirectory, 'edit_manifest.json');
  const qaPath = path.join(jobDirectory, 'qa_report.json');
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw new ProcessingError('OUTPUT_ROOT_FAILED', `Could not create output root: ${error.message}`);
  }

  let directoryCreated = false;
  const suffix = `.tmp-${randomUUID()}`;
  const temporaryPaths = [imagePath, manifestPath, qaPath].map((filePath) => `${filePath}${suffix}`);
  try {
    await mkdir(jobDirectory);
    directoryCreated = true;
    await writeFile(temporaryPaths[0], artifacts.image, { flag: 'wx' });
    await writeFile(temporaryPaths[1], artifacts.manifest, { flag: 'wx' });
    await writeFile(temporaryPaths[2], artifacts.qaReport, { flag: 'wx' });
    await rename(temporaryPaths[0], imagePath);
    await rename(temporaryPaths[1], manifestPath);
    await rename(temporaryPaths[2], qaPath);
  } catch (error) {
    await Promise.all(temporaryPaths.map((filePath) => rm(filePath, { force: true })));
    if (directoryCreated) await rm(jobDirectory, { recursive: true, force: true });
    if (error.code === 'EEXIST') {
      throw new ProcessingError('JOB_ALREADY_EXISTS', `Output job directory already exists: ${jobId}.`);
    }
    throw new ProcessingError('OUTPUT_WRITE_FAILED', `Could not write output job: ${error.message}`);
  }
  return { jobDirectory, imagePath, manifestPath, qaPath };
}

export async function processJob({
  sourcePath,
  outputRoot,
  profile: suppliedProfile,
  profilePath,
  job,
  referencePatchPath,
}) {
  validateInputPath(sourcePath);
  validateJob(job);
  const profile = await loadProfile(suppliedProfile, profilePath);
  validateProfile(profile);
  const timestampStrategy =
    job.timestamp_strategy || (job.timestamp_enabled ? 'reference_patch' : 'none');
  if (job.profile_id !== profile.profile_id) {
    throw new ProcessingError('PROFILE_ID_MISMATCH', 'Job profile_id does not match the loaded camera profile.');
  }
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) {
    throw new ProcessingError('INVALID_OUTPUT', 'outputRoot is required.');
  }

  let sourceBytes;
  try {
    sourceBytes = await readFile(sourcePath);
  } catch (error) {
    throw new ProcessingError('SOURCE_READ_FAILED', `Could not read source image: ${error.message}`);
  }
  if (!sourceBytes.length) {
    throw new ProcessingError('INVALID_IMAGE', 'Source image is empty.');
  }
  if (sourceBytes.length > MAX_INPUT_BYTES) {
    throw new ProcessingError('IMAGE_TOO_LARGE', 'Source image exceeds the 25 MB encoded image limit.');
  }
  const sourceHash = sha256(sourceBytes);
  const source = await decodeImage(sourceBytes, 'Source image');
  assertProfileDimensions(profile, source.width, source.height);
  const extension = path.extname(sourcePath).toLowerCase();
  const extensionMatchesFormat =
    (source.metadata.format === 'jpeg' && ['.jpg', '.jpeg'].includes(extension)) ||
    (source.metadata.format === 'png' && extension === '.png');
  if (!extensionMatchesFormat) {
    throw new ProcessingError('FORMAT_EXTENSION_MISMATCH', 'Source filename extension does not match decoded image format.');
  }

  const lighting = applyLighting(
    source.pixels,
    job.lighting_mode,
    job.datetime_local,
    profile,
  );
  let workingPixels = lighting.pixels;
  let renderedText = null;
  let referencePatchSha256 = null;
  const roi = profile.timestamp.roi;
  const watermark = provenanceWatermark(source.width, source.height);
  if (timestampStrategy === 'reference_patch' && overlaps(roi.x, roi.y, roi.width, roi.height, watermark)) {
    throw new ProcessingError(
      'ROI_OVERLAPS_PROVENANCE_MARK',
      'Timestamp ROI overlaps the edited-derivative label.',
    );
  }
  if (job.timestamp_enabled) {
    const referencePatch = await loadReferencePatch(referencePatchPath, roi);
    referencePatchSha256 = referencePatch.sha256;
    workingPixels = Buffer.from(workingPixels);
    copyRegion(workingPixels, referencePatch.pixels, source.width, roi);
    renderedText = formatTimestamp(job.datetime_local, profile.timestamp.format);
    const svg = await makeTimestampSvg(renderedText, profile, roi);
    const composited = await buildSvgOverlay(
      workingPixels,
      source.width,
      source.height,
      svg,
      roi,
    );
    workingPixels = composited.data;
  }
  const outputWidth = source.width;
  const outputHeight = source.height;
  let imageEncoder = sharp(workingPixels, {
    raw: { width: source.width, height: source.height, channels: 3 },
  });
  let annotation = null;
  if (timestampStrategy === 'display_annotation') {
    annotation = await buildDisplayOverlays({
      width: source.width,
      height: source.height,
      datetimeLocal: job.datetime_local,
      profile,
      lightingPreset: lighting.preset,
      sourcePixels: source.pixels,
    });
    imageEncoder = sharp(workingPixels, {
      raw: { width: source.width, height: source.height, channels: 3 },
    }).composite(annotation.overlays).removeAlpha().toColourspace('srgb');
  } else {
    const watermarkOverlay = makeWatermarkSvg(source.width, source.height);
    imageEncoder = imageEncoder
      .composite([{ input: watermarkOverlay.svg, left: watermarkOverlay.badge.left, top: watermarkOverlay.badge.top }])
      .removeAlpha()
      .toColourspace('srgb');
  }

  const hardChecks = [];
  const addHardCheck = (check, passed, details = null) => {
    hardChecks.push({
      check,
      pass: passed === null ? null : Boolean(passed),
      ...(details ? { details } : {}),
    });
  };
  addHardCheck('source_decodes_within_limits', true);
  addHardCheck('profile_dimensions_match', source.width === profile.expected_width && source.height === profile.expected_height);
  addHardCheck('source_frame_dimensions_preserved', workingPixels.length === source.width * source.height * 3, {
    width: source.width,
    height: source.height,
  });
  if (job.timestamp_enabled) {
    const outsideRoiExact =
      job.lighting_mode === 'none' &&
      assertPixelsOutsideRectsUnchanged(
        source.pixels,
        { pixels: workingPixels, height: source.height },
        source.width,
        [
          { left: roi.x, top: roi.y, width: roi.width, height: roi.height },
          watermark,
        ],
      );
    addHardCheck(
      'pixels_outside_timestamp_roi_and_provenance_label_unchanged_before_encode',
      job.lighting_mode === 'none' ? outsideRoiExact : null,
      job.lighting_mode === 'none'
        ? null
        : 'Not applicable because a global lighting transform was requested.',
    );
    addHardCheck('timestamp_within_calibrated_roi', renderedText !== null);
  } else if (job.lighting_mode === 'none') {
    addHardCheck(
      'identity_transform_outside_provenance_label_before_encode',
      assertPixelsOutsideRectsUnchanged(
        source.pixels,
        { pixels: workingPixels, height: source.height },
        source.width,
        timestampStrategy === 'display_annotation' ? [] : [watermark],
      ),
    );
  }
  addHardCheck(
    'simulated_display_badge_added',
    timestampStrategy === 'display_annotation' ? Boolean(annotation?.plate) : true,
    timestampStrategy === 'display_annotation'
      ? {
          text: annotation.simulatedLabel,
          plate: annotation.plate,
          label: 'EDITED DERIVATIVE - NOT ORIGINAL CCTV',
        }
      : watermark,
  );
  addHardCheck(
    'output_not_upscaled',
    outputWidth <= source.width && outputHeight <= source.height,
    { source: { width: source.width, height: source.height }, output: { width: outputWidth, height: outputHeight } },
  );

  const encoderSettings =
    job.output_format === 'jpeg'
      ? { quality: 92, chromaSubsampling: '4:4:4' }
      : { compressionLevel: 6 };
  let outputBuffer;
  try {
    outputBuffer = await (job.output_format === 'jpeg'
      ? imageEncoder.jpeg(encoderSettings)
      : imageEncoder.png(encoderSettings)
    ).toBuffer();
  } catch (error) {
    throw new ProcessingError('OUTPUT_ENCODING_FAILED', `Could not encode the edited derivative: ${error.message}`);
  }
  const output = await decodeImage(outputBuffer, 'Processed output');
  addHardCheck(
    'encoded_scene_frame_dimensions_preserved',
    output.width === outputWidth && output.height === outputHeight,
    { source_frame: { width: source.width, height: source.height }, output: { width: output.width, height: output.height } },
  );
  if (timestampStrategy === 'display_annotation') {
    const overlayRects = annotationExclusionRects(annotation);
    const originalOsdPreserved =
      job.lighting_mode === 'none' && job.output_format === 'png'
        ? assertPixelsOutsideRectsUnchanged(
            source.pixels,
            { pixels: output.pixels, height: output.height },
            source.width,
            overlayRects,
          )
        : null;
    addHardCheck(
      'original_capture_osd_preserved_outside_simulated_overlay',
      originalOsdPreserved,
      job.lighting_mode === 'none' && job.output_format === 'png'
        ? { overlay_rects: overlayRects }
        : 'Not assessed after a lighting transform or lossy encode. The camera timestamp is not painted over.',
    );
    const sampleX = Math.min(output.width - 1, annotation.plate.left + (annotation.plate.textX || 8));
    const sampleY = Math.min(output.height - 1, annotation.plate.top + (annotation.plate.textY || 8));
    const plateSample = (sampleY * output.width + sampleX) * 3;
    addHardCheck(
      'simulated_display_badge_rendered',
      output.pixels[plateSample] > 200 && output.pixels[plateSample] !== source.pixels[plateSample],
      { plate: annotation.plate, sample: { x: sampleX, y: sampleY } },
    );
  }

  let sourceAfter;
  try {
    sourceAfter = await readFile(sourcePath);
  } catch (error) {
    throw new ProcessingError('SOURCE_VERIFY_FAILED', `Could not verify original source after processing: ${error.message}`);
  }
  const sourceUnchanged = sha256(sourceAfter) === sourceHash;
  addHardCheck('source_bytes_unchanged', sourceUnchanged);
  if (!sourceUnchanged) {
    throw new ProcessingError('SOURCE_CHANGED', 'Source image changed while the job was running.');
  }

  const outputHash = sha256(outputBuffer);
  const visualQuality = output.width === source.width && output.height === source.height
    ? assessVisualQuality({
        sourcePixels: source.pixels,
        outputPixels: output.pixels,
        width: source.width,
        height: source.height,
        excludedRects: timestampStrategy === 'display_annotation'
          ? [annotation.plate]
          : [
              watermark,
              ...(job.timestamp_enabled
                ? [{ left: roi.x, top: roi.y, width: roi.width, height: roi.height }]
                : []),
            ],
        badge: timestampStrategy === 'display_annotation' ? annotation.plate : null,
        detectedOsd: annotation?.roi?.detected ? annotation.roi : null,
        lighting,
      })
    : {
        checks: [],
        machineGatesPass: false,
        metrics: {},
      };
  for (const item of visualQuality.checks) {
    addHardCheck(item.check, item.pass, item.details);
  }
  const machineGatesPass = visualQuality.machineGatesPass && hardChecks.every((item) => item.pass !== false);
  const verifiedReference =
    job.timestamp_enabled &&
    profile.calibrated === true &&
    profile.calibration?.method === 'verified_clean_reference' &&
    profile.calibration?.operator_review === 'approved';
  const timestampOutcome = timestampStrategy === 'display_annotation'
    ? 'ANNOTATED_DISPLAY_TIME'
    : job.timestamp_enabled
      ? verifiedReference
        ? 'VERIFIED_REFERENCE'
        : 'SIMULATED_INFRAME_REVIEW'
      : 'NO_TIMESTAMP_EDIT';
  const warnings = [
    ...(profile.calibrated ? [] : ['Camera/view profile is a draft and has not been visually reviewed.']),
    ...(job.timestamp_enabled
      ? [
          verifiedReference
            ? 'Even the registered clean reference must be visually checked against this frame.'
            : 'In-frame timestamp rendering is a simulation. Hidden background pixels are not recovered and mandatory visual review is required.',
        ]
      : []),
    ...(timestampStrategy === 'display_annotation'
      ? [
          'The camera timestamp is still visible. The added time is a simulated display label and is not the capture time.',
          'Pixels hidden by the original timestamp were not reconstructed.',
        ]
      : []),
    ...(lighting.preset === 'none'
      ? []
      : [
          'Lighting is a time-dependent pixel grade of the source frame. It does not reconstruct missing night/day detail, add lamps, or change recorded geometry.',
        ]),
    ...(lighting.parameters?.insufficient_source_information
      ? ['The source does not contain enough information for a daylight simulation without inventing scene content.']
      : []),
    ...(lighting.parameters?.night_retains_daylight_presentation
      ? ['The night simulation still retains a daylight presentation and must not be treated as an acceptable night frame.']
      : []),
    ...(machineGatesPass ? [] : ['Machine visual checks flagged this derivative. It is not visually approved.']),
    'Scene geometry and visual preservation require human review.',
    'Output is an edited derivative and does not verify the camera capture time.',
    'A generated image is not an approved replacement for original CCTV evidence.',
  ];
  const operations = [
    ...(lighting.preset === 'none'
      ? []
      : [{
          name: 'adjust_lighting',
          preset: lighting.preset,
          simulation: true,
          parameters: lighting.parameters,
        }]),
    ...(job.timestamp_enabled
      ? [{
          name: 'replace_timestamp',
          operation_type: 'modify_display_timestamp_overlay',
          text: renderedText,
          roi,
          method: 'operator_supplied_reference_patch',
          reference_patch_sha256: referencePatchSha256,
          represents_verified_capture_time: false,
        }]
      : []),
    ...(timestampStrategy === 'display_annotation'
      ? [{
          name: 'add_simulated_display_time_overlay',
          text: annotation.simulatedLabel,
          requested_time: annotation.requestedTime,
          label: 'simulated_display_badge',
          lighting_label: annotation.lightingLabel,
          represents_verified_capture_time: false,
          original_capture_osd_preserved: true,
          original_capture_osd_visible_on_derivative: true,
          placement: 'report_safe_corner',
          banner: 'EDITED DERIVATIVE - NOT ORIGINAL CCTV',
          plate: annotation.plate,
        }]
      : []),
    ...(timestampStrategy === 'display_annotation'
      ? []
      : [{
      name: 'add_visible_edited_derivative_watermark',
      text: 'EDITED DERIVATIVE - NOT ORIGINAL CCTV',
      ...watermark,
      }]),
  ];
  const createdAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    product: 'Admin Builder',
    processor: { name: 'kaata-karo-image-prototype', version: '0.3.0' },
    runtime: { node: process.version, sharp: sharp.versions.sharp },
    edited_derivative: true,
    original_source_modified: false,
    source_metadata_preserved_on_original: true,
    job_id: job.job_id,
    source_filename: path.basename(sourcePath),
    output_filename: `EDITED_${job.job_id}.${job.output_format}`,
    source_sha256: sourceHash,
    output_sha256: outputHash,
    source_dimensions: { width: source.width, height: source.height },
    output_dimensions: { width: output.width, height: output.height },
    scene_dimensions: { width: output.width, height: output.height },
    source_not_upscaled: output.width <= source.width && output.height <= source.height,
    timestamp_strategy: timestampOutcome,
    requested_display_overlay_datetime_local: timestampOutcome === 'NO_TIMESTAMP_EDIT' ? null : job.datetime_local,
    requested_datetime_local: timestampOutcome === 'NO_TIMESTAMP_EDIT' ? null : job.datetime_local,
    timezone: profile.timezone,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_calibrated: profile.calibrated === true,
    profile_calibration: profile.calibration || null,
    operations,
    output_format: job.output_format,
    encoding_settings: encoderSettings,
    processed_at_utc: createdAt,
    processing_status: 'PROCESSING_COMPLETE',
    qa_status: resolveQaStatus(visualQuality, machineGatesPass),
    machine_quality_gates: machineGatesPass ? 'pass' : 'flagged',
    visual_metrics: visualQuality.metrics,
    visually_approved: false,
    operator_review: 'pending',
    human_review_status: 'pending',
    warnings,
  };
  const qaStatus = manifest.qa_status;
  const qaReport = {
    schema_version: 1,
    processing_status: 'PROCESSING_COMPLETE',
    status: qaStatus,
    qa_passed: false,
    visually_approved: false,
    human_review_status: 'pending',
    machine_quality_gates: machineGatesPass ? 'pass' : 'flagged',
    visual_metrics: visualQuality.metrics,
    hard_checks: hardChecks,
    review_checks: [
      {
        check: 'timestamp_background_recovery',
        status: job.timestamp_enabled ? 'manual_review_required' : 'not_applicable',
        details:
          timestampOutcome === 'ANNOTATED_DISPLAY_TIME'
            ? 'No background recovery attempted; original capture timestamp remains in the scene.'
            : undefined,
      },
      { check: 'report_slot_crop', status: 'manual_review_required' },
      { check: 'truck_and_weighbridge_geometry', status: 'manual_review_required' },
      { check: 'yellow_rod_and_fixed_site_features', status: 'manual_review_required' },
      {
        check: 'lighting_plausibility',
        status: lighting.preset === 'none'
          ? 'not_applicable'
          : lighting.parameters?.insufficient_source_information
            ? 'unsupported'
            : lighting.parameters?.night_retains_daylight_presentation || visualQuality.checks.some((item) => item.check === 'night_simulation_not_retained_as_daylight' && item.pass === false)
              ? 'failed'
              : 'manual_review_required',
      },
    ],
    warnings,
  };
  const paths = await writeNewJobDirectory(outputRoot, job.job_id, {
    image: outputBuffer,
    manifest: toJsonBuffer(manifest),
    qaReport: toJsonBuffer(qaReport),
    extension: job.output_format,
  });
  return {
    job_id: job.job_id,
    processing_status: 'PROCESSING_COMPLETE',
    status: qaStatus,
    qa_status: qaStatus,
    qa_passed: false,
    visually_approved: false,
    output_image_path: paths.imagePath,
    manifest_path: paths.manifestPath,
    qa_report_path: paths.qaPath,
    source_sha256: sourceHash,
    output_sha256: outputHash,
    operations,
    warnings,
  };
}

function resolveQaStatus(visualQuality, machineGatesPass) {
  if (visualQuality.unsupported) return 'UNSUPPORTED_TRANSFORMATION';
  if (!machineGatesPass) return 'QA_FAILED';
  return 'NEEDS_REVIEW';
}

export { ProcessingError } from './errors.js';
export { applyLighting, lightingBlendForLocalTime, luminancePercentile, meanLuminance, midtoneGain } from './lighting.js';
export { assessVisualQuality, reportSafeRect } from './quality.js';
export {
  formatTimestamp,
  normalizeDateTimeLocal,
  parseLocalDateTime,
  resolveLighting,
  validateJob,
  validateProfile,
} from './validation.js';
