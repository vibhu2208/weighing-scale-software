import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCameraCalibration, createSingleFrameCameraProfile } from './calibration.js';
import { ProcessingError } from './errors.js';
import { processJob } from './index.js';

const PROTOTYPE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_ROOT = path.resolve(PROTOTYPE_ROOT, '..');
const WEB_ROOT = path.join(PROTOTYPE_ROOT, 'web');
const DATA_ROOT = path.join(PROTOTYPE_ROOT, 'local-data');
const SAMPLE_PROFILE_PATH = path.join(BUILDER_ROOT, 'config', 'sample_camera_profile.json');
const DEFAULTS_PATH = path.join(BUILDER_ROOT, 'config', 'defaults.json');
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const TEMPORARY_PREVIEW_TTL_MS = 60 * 60 * 1000;
const TEMPORARY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DATA_URL_PATTERN = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
const ID_PATTERN = /^[a-f0-9]{32}$/;

function storagePaths(dataRoot) {
  return {
    testImages: path.join(dataRoot, 'test-images'),
    temporary: path.join(dataRoot, 'temporary'),
    outputs: path.join(dataRoot, 'outputs'),
    profiles: path.join(dataRoot, 'profiles'),
    manifests: path.join(dataRoot, 'manifests'),
  };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function allowedLocalRequest(request) {
  const host = String(request.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    return ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new ProcessingError('REQUEST_TOO_LARGE', 'Request exceeds the local prototype limit.');
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProcessingError('INVALID_REQUEST_JSON', 'Request body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProcessingError('INVALID_REQUEST_JSON', 'Request JSON must be an object.');
  }
  return parsed;
}

function decodeDataUrl(value, label) {
  if (typeof value !== 'string') {
    throw new ProcessingError('INVALID_UPLOAD', `${label} image data is required.`);
  }
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) {
    throw new ProcessingError('INVALID_UPLOAD', `${label} must be an uploaded JPEG or PNG image.`);
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) {
    throw new ProcessingError('INVALID_UPLOAD', `${label} must be no larger than 25 MB.`);
  }
  return { buffer, extension: match[1] === 'jpeg' ? '.jpg' : '.png' };
}

async function listProfiles(profilesRoot = path.join(DATA_ROOT, 'profiles')) {
  const sampleProfile = JSON.parse(await readFile(SAMPLE_PROFILE_PATH, 'utf8'));
  const profiles = [{
    profile: sampleProfile,
    referencePatchAvailable: false,
    builtIn: true,
  }];
  let entries = [];
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name)) continue;
    const profilePath = path.join(profilesRoot, entry.name, 'profile.json');
    const patchPath = path.join(profilesRoot, entry.name, 'timestamp-reference.png');
    try {
      const profile = JSON.parse(await readFile(profilePath, 'utf8'));
      let referencePatchAvailable = false;
      try {
        await readFile(patchPath);
        referencePatchAvailable = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      profiles.push({ profile, referencePatchAvailable, builtIn: false });
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return profiles;
}

async function loadProfile(profileId, profilesRoot = path.join(DATA_ROOT, 'profiles')) {
  if (profileId === 'camera_a_demo') {
    return {
      profile: JSON.parse(await readFile(SAMPLE_PROFILE_PATH, 'utf8')),
      patchPath: null,
    };
  }
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId)) {
    throw new ProcessingError('INVALID_PROFILE_ID', 'Invalid camera profile ID.');
  }
  const profileDirectory = path.join(profilesRoot, profileId);
  try {
    return {
      profile: JSON.parse(await readFile(path.join(profileDirectory, 'profile.json'), 'utf8')),
      patchPath: path.join(profileDirectory, 'timestamp-reference.png'),
    };
  } catch (error) {
    throw new ProcessingError('PROFILE_NOT_FOUND', `Camera profile "${profileId}" is unavailable: ${error.message}`);
  }
}

async function resolveProfile({ profileId, width, height, profilesRoot, fallbackProfileId }) {
  const availableProfiles = await listProfiles(profilesRoot);
  if (profileId) {
    const selected = availableProfiles.find((item) => item.profile.profile_id === profileId);
    if (!selected) {
      throw new ProcessingError('PROFILE_NOT_FOUND', `Camera profile "${profileId}" is unavailable.`);
    }
    if (
      selected.profile.expected_width !== width ||
      selected.profile.expected_height !== height
    ) {
      const fallback = JSON.parse(await readFile(SAMPLE_PROFILE_PATH, 'utf8'));
      const profile = {
        ...fallback,
        profile_id: fallbackProfileId,
        display_name: 'Unassigned view — profile framing mismatch',
        calibrated: false,
        profile_status: 'framing_mismatch',
        expected_width: width,
        expected_height: height,
      };
      return {
        profile,
        patchPath: null,
        profileSummary: {
          profile,
          referencePatchAvailable: false,
          builtIn: true,
          warning:
            `Selected view "${selected.profile.display_name}" expects ${selected.profile.expected_width}×${selected.profile.expected_height}; this frame is ${width}×${height}. No saved ROI was applied.`,
        },
      };
    }
    return {
      profile: selected.profile,
      patchPath: selected.referencePatchAvailable
        ? path.join(profilesRoot, profileId, 'timestamp-reference.png')
        : null,
      profileSummary: selected,
    };
  }

  const baseProfile = JSON.parse(await readFile(SAMPLE_PROFILE_PATH, 'utf8'));
  const profile = {
    ...baseProfile,
    profile_id: fallbackProfileId,
    display_name: 'Unassigned camera view',
    calibrated: false,
    profile_status: 'unassigned',
    expected_width: width,
    expected_height: height,
  };
  return {
    profile,
    patchPath: null,
    profileSummary: { profile, referencePatchAvailable: false, builtIn: true },
  };
}

function parseColor(value) {
  if (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/.test(value)) {
    throw new ProcessingError('INVALID_CALIBRATION_COLOR', 'Timestamp color must be a six-digit hex color.');
  }
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

async function handleCalibration(body, dataRoot = DATA_ROOT) {
  if (!Array.isArray(body.frames)) {
    throw new ProcessingError('INVALID_CALIBRATION_SAMPLE_COUNT', 'Select 5-10 calibration frames.');
  }
  const frameBuffers = body.frames.map((frame, index) =>
    decodeDataUrl(frame?.dataUrl, `Calibration frame ${index + 1}`).buffer,
  );
  const calibrated = await createCameraCalibration({
    frameBuffers,
    profileId: body.profileId,
    displayName: body.displayName,
    expectedFraming: body.expectedFraming || 'Unverified fixed-camera view',
    timezone: body.timezone,
    roi: {
      x: Number(body.roi?.x),
      y: Number(body.roi?.y),
      width: Number(body.roi?.width),
      height: Number(body.roi?.height),
    },
    timestampFormat: body.timestampFormat,
    fontSizePx: Number(body.fontSizePx),
    colorRgb: parseColor(body.color),
    defaultsPath: DEFAULTS_PATH,
    profilesDirectory: path.join(dataRoot, 'profiles'),
  });
  return {
    profile: calibrated.profile,
    referencePatchBase64: calibrated.referencePatchBase64,
    message: 'Saved a draft profile and median reference patch. Profile remains uncalibrated until reviewed.',
  };
}

async function handleSingleFrameDraft(body, dataRoot = DATA_ROOT) {
  const frame = decodeDataUrl(body.frameDataUrl, 'Calibration source');
  const profile = await createSingleFrameCameraProfile({
    frameBuffer: frame.buffer,
    profileId: body.profileId,
    displayName: body.displayName,
    expectedFraming: body.expectedFraming,
    timezone: body.timezone,
    roi: {
      x: Number(body.roi?.x),
      y: Number(body.roi?.y),
      width: Number(body.roi?.width),
      height: Number(body.roi?.height),
    },
    timestampFormat: body.timestampFormat,
    fontSizePx: Number(body.fontSizePx),
    colorRgb: parseColor(body.color),
    defaultsPath: DEFAULTS_PATH,
    profilesDirectory: path.join(dataRoot, 'profiles'),
  });
  return {
    profile,
    message:
      'Draft camera/view profile saved. It stores ROI geometry only; no hidden timestamp pixels were recovered. Routine processing remains available with a separate display-time annotation.',
  };
}

async function handleProcessing(body, { paths, pendingPreviews, activePreviews }) {
  const source = decodeDataUrl(body.sourceDataUrl, 'Source');
  let sourceMetadata;
  try {
    sourceMetadata = await sharp(source.buffer, { failOn: 'error', limitInputPixels: 20_000_000 }).metadata();
  } catch (error) {
    throw new ProcessingError('INVALID_IMAGE', `Source image cannot be decoded: ${error.message}`);
  }
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw new ProcessingError('INVALID_IMAGE', 'Source image dimensions are unavailable.');
  }
  if (!['png', 'jpeg'].includes(sourceMetadata.format)) {
    throw new ProcessingError('UNSUPPORTED_FORMAT', 'Source image must decode as JPEG or PNG.');
  }
  if (sourceMetadata.width * sourceMetadata.height > 20_000_000) {
    throw new ProcessingError('IMAGE_TOO_LARGE', 'Source image dimensions exceed the 20 million pixel limit.');
  }

  const previewId = randomUUID().replaceAll('-', '');
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'admin-builder-ui-'));
  activePreviews.add(previewId);
  try {
    const sourcePath = path.join(temporaryDirectory, `SOURCE_${previewId}${source.extension}`);
    await writeFile(sourcePath, source.buffer, { flag: 'wx' });
    const timestampEnabled = false;
    const lightingMode = 'auto';
    const outputFormat = 'png';
    const datetimeLocal =
      typeof body.datetimeLocal === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.datetimeLocal)
        ? `${body.datetimeLocal}:00`
        : body.datetimeLocal;
    let { profile, patchPath, profileSummary } = await resolveProfile({
      profileId: body.profileId,
      width: sourceMetadata.width,
      height: sourceMetadata.height,
      profilesRoot: paths.profiles,
      fallbackProfileId: `view_${previewId}`,
    });
    if (!body.profileId || profile.profile_status === 'unassigned' || profile.profile_status === 'framing_mismatch') {
      profile = {
        ...profile,
        timezone:
          typeof body.timezone === 'string' && body.timezone.trim()
            ? body.timezone.trim()
            : profile.timezone || 'Asia/Kolkata',
      };
    }
    const result = await processJob({
      sourcePath,
      outputRoot: paths.temporary,
      profile,
      job: {
        job_id: previewId,
        profile_id: profile.profile_id,
        datetime_local: datetimeLocal,
        timestamp_enabled: timestampEnabled,
        timestamp_strategy: 'display_annotation',
        lighting_mode: lightingMode,
        output_format: outputFormat,
      },
      referencePatchPath: patchPath,
    });
    const [image, manifest, qaReport] = await Promise.all([
      readFile(result.output_image_path),
      readFile(result.manifest_path, 'utf8'),
      readFile(result.qa_report_path, 'utf8'),
    ]);
    const originalFilename = `SOURCE_${previewId}${source.extension}`;
    const originalPath = path.join(paths.testImages, originalFilename);
    await writeFile(originalPath, source.buffer, { flag: 'wx' });
    const parsedManifest = JSON.parse(manifest);
    parsedManifest.uploaded_source_file = path.posix.join('test-images', originalFilename);
    parsedManifest.camera_timezone = profile.timezone;
    parsedManifest.processed_by =
      typeof body.operatorEmail === 'string' && body.operatorEmail.trim()
        ? body.operatorEmail.trim()
        : null;
    if (profileSummary.warning) {
      parsedManifest.warnings.push(profileSummary.warning);
      parsedManifest.camera_view_match = 'mismatch_visual_review_required';
    } else if (!profileSummary.builtIn) {
      parsedManifest.camera_view_match = 'explicit_selection_requires_visual_framing_review';
    } else {
      parsedManifest.camera_view_match = 'unassigned';
    }
    const parsedQaReport = JSON.parse(qaReport);
    if (profileSummary.warning || !profileSummary.builtIn) {
      const framingReviewWarning = profileSummary.warning ||
        'Image dimensions do not verify camera framing; inspect fixed scene landmarks before reusing this view profile.';
      if (!profileSummary.warning) parsedManifest.warnings.push(framingReviewWarning);
      parsedQaReport.warnings.push(framingReviewWarning);
      parsedQaReport.review_checks.push({
        check: 'selected_camera_view_framing',
        status: 'manual_review_required',
        details: framingReviewWarning,
      });
    }
    const previewRecord = {
      previewId,
      createdAt: Date.now(),
      directory: path.join(paths.temporary, previewId),
      imagePath: result.output_image_path,
      manifest: parsedManifest,
      qaReport: parsedQaReport,
    };
    pendingPreviews.set(previewId, previewRecord);
    return {
      job_id: previewId,
      preview_id: previewId,
      processing_status: result.processing_status || 'PROCESSING_COMPLETE',
      status: result.status,
      qa_status: result.qa_status || parsedManifest.qa_status,
      qa_passed: false,
      visually_approved: false,
      source_sha256: result.source_sha256,
      output_sha256: result.output_sha256,
      operations: result.operations,
      warnings: parsedManifest.warnings,
      output_image_base64: image.toString('base64'),
      profile: profileSummary.profile,
      profile_view_warning: profileSummary.warning || null,
      original_metadata_preserved_on_source: true,
      manifest: parsedManifest,
      qa_report: previewRecord.qaReport,
      output_image_path: path.basename(result.output_image_path),
    };
  } finally {
    activePreviews.delete(previewId);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function initializeStorage(paths) {
  await Promise.all([
    mkdir(paths.testImages, { recursive: true }),
    mkdir(paths.outputs, { recursive: true }),
    mkdir(paths.profiles, { recursive: true }),
    mkdir(paths.manifests, { recursive: true }),
  ]);
  await rm(paths.temporary, { recursive: true, force: true });
  await mkdir(paths.temporary, { recursive: true });
}

async function cleanupTemporaryPreviews(paths, pendingPreviews, activePreviews, now = Date.now()) {
  let entries = [];
  try {
    entries = await readdir(paths.temporary, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name) || activePreviews.has(entry.name)) continue;
    const pending = pendingPreviews.get(entry.name);
    let createdAt = pending?.createdAt;
    if (createdAt === undefined) {
      try {
        createdAt = (await stat(path.join(paths.temporary, entry.name))).mtimeMs;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    if (now - createdAt < TEMPORARY_PREVIEW_TTL_MS) continue;
    await rm(path.join(paths.temporary, entry.name), { recursive: true, force: true });
    pendingPreviews.delete(entry.name);
  }
}

async function handleSavePreview(previewId, { paths, pendingPreviews }) {
  if (!ID_PATTERN.test(previewId)) {
    throw new ProcessingError('PREVIEW_NOT_FOUND', 'This preview is unavailable or has expired.');
  }
  const preview = pendingPreviews.get(previewId);
  if (!preview) {
    throw new ProcessingError('PREVIEW_NOT_FOUND', 'This preview is unavailable or has expired. Process the image again.');
  }
  const extension = preview.manifest.output_format;
  if (!['png', 'jpeg'].includes(extension)) {
    throw new ProcessingError('INVALID_PREVIEW', 'Preview output format is invalid.');
  }
  const outputFilename = preview.manifest.output_filename;
  if (outputFilename !== `EDITED_${previewId}.${extension}`) {
    throw new ProcessingError('INVALID_PREVIEW', 'Preview output filename is invalid.');
  }
  const outputPath = path.join(paths.outputs, outputFilename);
  const manifestPath = path.join(paths.manifests, `${previewId}.json`);
  const qaPath = path.join(paths.manifests, `${previewId}.qa.json`);
  const savedAt = new Date().toISOString();
  const manifest = {
    ...preview.manifest,
    saved_at_utc: savedAt,
    saved_output_file: path.posix.join('outputs', outputFilename),
  };
  const qaReport = {
    ...preview.qaReport,
    saved_at_utc: savedAt,
    output_file: path.posix.join('outputs', outputFilename),
  };
  let outputCreated = false;
  let manifestCreated = false;
  let qaCreated = false;
  try {
    await copyFile(preview.imagePath, outputPath, fsConstants.COPYFILE_EXCL);
    outputCreated = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    manifestCreated = true;
    await writeFile(qaPath, `${JSON.stringify(qaReport, null, 2)}\n`, { flag: 'wx' });
    qaCreated = true;
  } catch (error) {
    if (qaCreated) await rm(qaPath, { force: true });
    if (manifestCreated) await rm(manifestPath, { force: true });
    if (outputCreated) await rm(outputPath, { force: true });
    if (error.code === 'EEXIST') {
      throw new ProcessingError('OUTPUT_ALREADY_EXISTS', 'A saved image with this ID already exists; process the image again.');
    }
    throw error;
  }
  pendingPreviews.delete(previewId);
  await rm(preview.directory, { recursive: true, force: true });
  return {
    saved: {
      id: previewId,
      filename: outputFilename,
      download_url: `/api/saved/${previewId}/image`,
      manifest_url: `/api/saved/${previewId}`,
      source_sha256: manifest.source_sha256,
      output_sha256: manifest.output_sha256,
      saved_at_utc: savedAt,
      output_dimensions: manifest.output_dimensions,
    },
  };
}

async function listSavedImages(paths) {
  const entries = (await readdir(paths.manifests, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && ID_PATTERN.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json') && !entry.name.endsWith('.qa.json'))
    .sort((left, right) => right.name.localeCompare(left.name));
  const images = [];
  for (const entry of entries) {
    const id = entry.name.slice(0, -'.json'.length);
    const manifest = JSON.parse(await readFile(path.join(paths.manifests, entry.name), 'utf8'));
    const expectedFilename = `EDITED_${id}.${manifest.output_format}`;
    if (manifest.output_filename !== expectedFilename || !['png', 'jpeg'].includes(manifest.output_format)) {
      throw new ProcessingError('INVALID_SAVED_MANIFEST', `Saved image manifest "${entry.name}" has an invalid output filename.`);
    }
    await stat(path.join(paths.outputs, expectedFilename));
    images.push({
      id,
      filename: expectedFilename,
      download_url: `/api/saved/${id}/image`,
      source_sha256: manifest.source_sha256,
      output_sha256: manifest.output_sha256,
      saved_at_utc: manifest.saved_at_utc,
      output_dimensions: manifest.output_dimensions,
      operations: manifest.operations,
      processing_status: manifest.processing_status || 'PROCESSING_COMPLETE',
      qa_status: manifest.qa_status || 'NEEDS_REVIEW',
      visually_approved: manifest.visually_approved === true,
    });
  }
  return images.sort((left, right) => right.saved_at_utc.localeCompare(left.saved_at_utc));
}

async function deleteSavedImages(paths, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ProcessingError('INVALID_SAVED_IDS', 'Select at least one saved image to clear.');
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id || '')))];
  if (uniqueIds.length > 50) {
    throw new ProcessingError('TOO_MANY_SAVED_IDS', 'Clear at most 50 saved images at a time.');
  }
  const deleted = [];
  const missing = [];
  for (const id of uniqueIds) {
    if (!ID_PATTERN.test(id)) {
      throw new ProcessingError('INVALID_SAVED_IDS', 'A selected image ID is invalid.');
    }
    const manifestPath = path.join(paths.manifests, `${id}.json`);
    const qaPath = path.join(paths.manifests, `${id}.qa.json`);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(id);
        continue;
      }
      throw error;
    }
    const expectedFilename = `EDITED_${id}.${manifest.output_format}`;
    if (manifest.output_filename !== expectedFilename || !['png', 'jpeg'].includes(manifest.output_format)) {
      throw new ProcessingError('INVALID_SAVED_MANIFEST', 'Saved image manifest has an invalid output filename.');
    }
    await rm(path.join(paths.outputs, expectedFilename), { force: true });
    await rm(qaPath, { force: true });
    await rm(manifestPath, { force: true });
    deleted.push(id);
  }
  return { deleted, missing };
}

async function handleProfileReview(body, profilesRoot = path.join(DATA_ROOT, 'profiles')) {
  if (body.confirmed !== true) {
    throw new ProcessingError('PROFILE_REVIEW_REQUIRED', 'Explicit visual-review confirmation is required.');
  }
  if (typeof body.reviewer !== 'string' || !/^[A-Za-z0-9 _.-]{2,40}$/.test(body.reviewer.trim())) {
    throw new ProcessingError('INVALID_REVIEWER', 'Enter reviewer initials or a short identifier (2-40 characters).');
  }
  if (body.profileId === 'camera_a_demo') {
    throw new ProcessingError('BUILTIN_PROFILE_IMMUTABLE', 'The built-in demo profile cannot be marked calibrated.');
  }
  const { profile } = await loadProfile(body.profileId, profilesRoot);
  if (!profile.calibration || !Array.isArray(profile.calibration.sample_sha256)) {
    throw new ProcessingError('PROFILE_NOT_CALIBRATED', 'This profile has no completed calibration samples.');
  }
  profile.calibrated = true;
  profile.calibration.operator_review = 'approved';
  profile.calibration.reviewed_by = body.reviewer.trim();
  profile.calibration.reviewed_at_utc = new Date().toISOString();
  await writeFile(
    path.join(profilesRoot, profile.profile_id, 'profile.json'),
    `${JSON.stringify(profile, null, 2)}\n`,
    { flag: 'w' },
  );
  return { profile, message: 'Profile marked calibrated by explicit local operator attestation.' };
}

export function createBuilderWorkspace({ dataRoot = DATA_ROOT } = {}) {
  const paths = storagePaths(dataRoot);
  const pendingPreviews = new Map();
  const activePreviews = new Set();
  let storageInitialization;
  const ensureStorage = () => {
    storageInitialization ??= initializeStorage(paths);
    return storageInitialization;
  };
  return {
    paths,
    ensureStorage,
    async process(body) {
      await ensureStorage();
      return handleProcessing(body, { paths, pendingPreviews, activePreviews });
    },
    async save(previewId) {
      await ensureStorage();
      return handleSavePreview(previewId, { paths, pendingPreviews });
    },
    async list() {
      await ensureStorage();
      return listSavedImages(paths);
    },
    async listProfiles() {
      await ensureStorage();
      return listProfiles(paths.profiles);
    },
    async deleteSaved(ids) {
      await ensureStorage();
      return deleteSavedImages(paths, ids);
    },
    async readSaved(id) {
      await ensureStorage();
      if (!ID_PATTERN.test(id)) {
        throw new ProcessingError('PREVIEW_NOT_FOUND', 'This saved image is unavailable.');
      }
      const manifest = JSON.parse(await readFile(path.join(paths.manifests, `${id}.json`), 'utf8'));
      const expectedFilename = `EDITED_${id}.${manifest.output_format}`;
      if (manifest.output_filename !== expectedFilename || !['png', 'jpeg'].includes(manifest.output_format)) {
        throw new ProcessingError('INVALID_SAVED_MANIFEST', 'Saved image manifest has an invalid output filename.');
      }
      const image = await readFile(path.join(paths.outputs, expectedFilename));
      return { manifest, image, filename: expectedFilename };
    },
  };
}

export function createLocalTestServer({ dataRoot = DATA_ROOT } = {}) {
  const paths = storagePaths(dataRoot);
  const pendingPreviews = new Map();
  const activePreviews = new Set();
  let storageInitialization;
  const ensureStorage = () => {
    storageInitialization ??= initializeStorage(paths);
    return storageInitialization;
  };
  const cleanupTimer = setInterval(() => {
    cleanupTemporaryPreviews(paths, pendingPreviews, activePreviews).catch((error) => {
      console.error(`Admin Builder temporary-preview cleanup failed: ${error.message}`);
    });
  }, TEMPORARY_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  const server = createHttpServer(async (request, response) => {
    if (!allowedLocalRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'This prototype is available only from localhost.' });
      return;
    }

    try {
      await ensureStorage();
      await cleanupTemporaryPreviews(paths, pendingPreviews, activePreviews);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === '/') {
        const html = await readFile(path.join(WEB_ROOT, 'index.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        response.end(html);
        return;
      }
      if (request.method === 'GET' && pathname === '/api/profiles') {
        sendJson(response, 200, {
          ok: true,
          profiles: await listProfiles(paths.profiles),
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/saved') {
        sendJson(response, 200, { ok: true, images: await listSavedImages(paths) });
        return;
      }
      if (request.method === 'DELETE') {
        const deleteOne = /^\/api\/saved\/([a-f0-9]{32})$/.exec(pathname);
        if (!deleteOne) {
          sendJson(response, 404, { ok: false, error: 'Not found.' });
          return;
        }
        sendJson(response, 200, { ok: true, ...(await deleteSavedImages(paths, [deleteOne[1]])) });
        return;
      }
      const savedResource = /^\/api\/saved\/([a-f0-9]{32})(?:\/(image))?$/.exec(pathname);
      if (request.method === 'GET' && savedResource) {
        const [, id, imageResource] = savedResource;
        const manifest = JSON.parse(await readFile(path.join(paths.manifests, `${id}.json`), 'utf8'));
        const expectedFilename = `EDITED_${id}.${manifest.output_format}`;
        if (manifest.output_filename !== expectedFilename || !['png', 'jpeg'].includes(manifest.output_format)) {
          throw new ProcessingError('INVALID_SAVED_MANIFEST', 'Saved image manifest has an invalid output filename.');
        }
        if (imageResource) {
          const image = await readFile(path.join(paths.outputs, expectedFilename));
          response.writeHead(200, {
            'Content-Type': manifest.output_format === 'jpeg' ? 'image/jpeg' : 'image/png',
            'Content-Disposition': `inline; filename="${expectedFilename}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(image);
        } else {
          sendJson(response, 200, { ok: true, manifest });
        }
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/api/calibrate', '/api/calibrate-draft', '/api/process', '/api/profiles/review', '/api/saved/delete'].includes(pathname) &&
          !/^\/api\/previews\/[a-f0-9]{32}\/save$/.test(pathname)
      ) {
        sendJson(response, 404, { ok: false, error: 'Not found.' });
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(response, 415, { ok: false, error: 'Content-Type must be application/json.' });
        return;
      }
      const body = await readJson(request);
      const saveMatch = /^\/api\/previews\/([a-f0-9]{32})\/save$/.exec(pathname);
      const result =
        pathname === '/api/calibrate'
          ? await handleCalibration(body, dataRoot)
          : pathname === '/api/calibrate-draft'
            ? await handleSingleFrameDraft(body, dataRoot)
            : pathname === '/api/process'
            ? await handleProcessing(body, { dataRoot, paths, pendingPreviews, activePreviews })
            : pathname === '/api/profiles/review'
              ? await handleProfileReview(body, paths.profiles)
              : pathname === '/api/saved/delete'
                ? await deleteSavedImages(paths, body.ids)
              : await handleSavePreview(saveMatch[1], { paths, pendingPreviews });
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      const statusCode =
        error.code === 'REQUEST_TOO_LARGE'
          ? 413
          : error.code === 'PROFILE_NOT_FOUND' || error.code === 'PREVIEW_NOT_FOUND'
            ? 404
            : error.code === 'OUTPUT_ALREADY_EXISTS'
              ? 409
              : error.code === 'ENOENT'
                ? 404
            : error instanceof ProcessingError
              ? 400
              : 500;
      if (statusCode === 500) console.error(`Admin Builder request failed: ${error.stack || error.message}`);
      sendJson(response, statusCode, {
        ok: false,
        error: error.message || 'Prototype request failed.',
        code: error.code || 'INTERNAL_ERROR',
      });
    }
  });
  server.on('close', () => clearInterval(cleanupTimer));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArgumentIndex = process.argv.indexOf('--port');
  const requestedPort = portArgumentIndex >= 0 ? Number(process.argv[portArgumentIndex + 1]) : 4178;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    console.error('Port must be an integer from 0 through 65535.');
    process.exitCode = 1;
  } else {
    const server = createLocalTestServer();
    server.listen(requestedPort, '127.0.0.1', () => {
      const address = server.address();
      console.log(`Admin Builder isolated test UI: http://127.0.0.1:${address.port}`);
      console.log('This local prototype has no admin authentication and must not be exposed to a network.');
    });
  }
}
