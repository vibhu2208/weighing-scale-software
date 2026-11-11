import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ProcessingError } from './errors.js';
import { MAX_INPUT_BYTES, MAX_PIXELS, validateProfile } from './validation.js';

const MIN_SAMPLE_COUNT = 5;
const MAX_SAMPLE_COUNT = 10;
const MAX_TOTAL_SAMPLE_PIXELS = 40_000_000;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeProfileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

async function decodeCalibrationImage(buffer, index) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_INPUT_BYTES) {
    throw new ProcessingError(
      'INVALID_CALIBRATION_IMAGE',
      `Calibration frame ${index + 1} must be a non-empty image no larger than 25 MB.`,
    );
  }
  let decoded;
  try {
    const image = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS });
    const metadata = await image.metadata();
    if (!['jpeg', 'png'].includes(metadata.format) || metadata.orientation > 1) {
      throw new ProcessingError(
        'INVALID_CALIBRATION_IMAGE',
        `Calibration frame ${index + 1} must be a JPEG/PNG with normal orientation.`,
      );
    }
    const decodedImage = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decodedImage.info.channels !== 3) {
      throw new ProcessingError(
        'INVALID_CALIBRATION_IMAGE',
        `Calibration frame ${index + 1} must be opaque RGB without an alpha channel.`,
      );
    }
    decoded = decodedImage;
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError(
      'INVALID_CALIBRATION_IMAGE',
      `Calibration frame ${index + 1} could not be decoded: ${error.message}`,
    );
  }
  if (decoded.info.channels !== 3 || decoded.info.width * decoded.info.height > MAX_PIXELS) {
    throw new ProcessingError(
      'INVALID_CALIBRATION_IMAGE',
      `Calibration frame ${index + 1} must decode to an opaque image within the pixel limit.`,
    );
  }
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    pixels: decoded.data,
    sha256: sha256(buffer),
  };
}

function medianReferencePatch(frames, roi) {
  const pixelCount = roi.width * roi.height;
  const output = Buffer.allocUnsafe(pixelCount * 3);
  const channelValues = new Array(frames.length);
  for (let y = 0; y < roi.height; y += 1) {
    for (let x = 0; x < roi.width; x += 1) {
      const targetOffset = (y * roi.width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
          const sourceOffset = ((roi.y + y) * frames[frameIndex].width + roi.x + x) * 3;
          channelValues[frameIndex] = frames[frameIndex].pixels[sourceOffset + channel];
        }
        channelValues.sort((a, b) => a - b);
        output[targetOffset + channel] = channelValues[Math.floor(channelValues.length / 2)];
      }
    }
  }
  return output;
}

export async function createSingleFrameCameraProfile({
  frameBuffer,
  profileId,
  displayName,
  expectedFraming,
  timezone,
  roi,
  timestampFormat,
  fontSizePx,
  colorRgb,
  defaultsPath,
  profilesDirectory,
}) {
  if (!safeProfileId(profileId)) {
    throw new ProcessingError('INVALID_PROFILE_ID', 'Profile ID must use 1-64 letters, digits, underscores, or hyphens.');
  }
  const frame = await decodeCalibrationImage(frameBuffer, 0);
  if (
    !roi ||
    !Number.isInteger(roi.x) ||
    !Number.isInteger(roi.y) ||
    !Number.isInteger(roi.width) ||
    !Number.isInteger(roi.height) ||
    roi.x < 0 ||
    roi.y < 0 ||
    roi.width < 1 ||
    roi.height < 1 ||
    roi.x + roi.width > frame.width ||
    roi.y + roi.height > frame.height
  ) {
    throw new ProcessingError('INVALID_CALIBRATION_ROI', 'ROI must lie entirely within the source frame.');
  }
  if (typeof expectedFraming !== 'string' || expectedFraming.trim().length < 3 || expectedFraming.trim().length > 160) {
    throw new ProcessingError('INVALID_CAMERA_VIEW', 'Describe the camera view/framing in 3-160 characters.');
  }
  if (!Number.isFinite(fontSizePx) || fontSizePx < 6 || fontSizePx > roi.height - 2) {
    throw new ProcessingError('INVALID_PROFILE', 'Font size must fit inside the selected timestamp region.');
  }

  let defaults;
  try {
    defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  } catch (error) {
    throw new ProcessingError('CALIBRATION_DEFAULTS_FAILED', `Could not load camera defaults: ${error.message}`);
  }
  const profile = {
    schema_version: 1,
    profile_id: profileId,
    camera_view_id: profileId,
    profile_version: 1,
    display_name: displayName || profileId,
    expected_framing: expectedFraming.trim(),
    calibrated: false,
    profile_status: 'draft',
    expected_width: frame.width,
    expected_height: frame.height,
    timezone,
    timestamp: {
      roi,
      roi_normalized: {
        x: roi.x / frame.width,
        y: roi.y / frame.height,
        width: roi.width / frame.width,
        height: roi.height / frame.height,
      },
      format: timestampFormat,
      font_size_px: fontSizePx,
      font_family: 'monospace',
      color_rgb: colorRgb,
      reference_patch_required: false,
    },
    lighting: defaults.lighting,
    calibration: {
      method: 'single_frame_roi_draft',
      status: 'draft',
      source_frame_sha256: frame.sha256,
      source_frame_dimensions: { width: frame.width, height: frame.height },
      visual_review: 'pending',
      caveat:
        'One frame records view geometry only. It cannot reveal scene pixels hidden by the original timestamp; use display-time annotation unless a genuine clean reference is verified.',
    },
  };
  validateProfile(profile);

  const profileDirectory = path.join(profilesDirectory, profileId);
  try {
    await mkdir(profilesDirectory, { recursive: true });
    await mkdir(profileDirectory);
    await writeFile(path.join(profileDirectory, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
    return profile;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ProcessingError('PROFILE_ALREADY_EXISTS', 'A profile with this ID already exists.');
    }
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError('CALIBRATION_SAVE_FAILED', `Could not save camera profile: ${error.message}`);
  }
}

export async function createCameraCalibration({
  frameBuffers,
  profileId,
  displayName,
  expectedFraming = 'Unverified fixed-camera view',
  timezone,
  roi,
  timestampFormat,
  fontSizePx,
  colorRgb,
  defaultsPath,
  profilesDirectory,
}) {
  if (!Array.isArray(frameBuffers) || frameBuffers.length < MIN_SAMPLE_COUNT || frameBuffers.length > MAX_SAMPLE_COUNT) {
    throw new ProcessingError(
      'INVALID_CALIBRATION_SAMPLE_COUNT',
      `Calibration requires ${MIN_SAMPLE_COUNT}-${MAX_SAMPLE_COUNT} same-camera sample frames.`,
    );
  }
  if (!safeProfileId(profileId)) {
    throw new ProcessingError('INVALID_PROFILE_ID', 'Profile ID must use 1-64 letters, digits, underscores, or hyphens.');
  }
  if (
    !roi ||
    !Number.isInteger(roi.x) ||
    !Number.isInteger(roi.y) ||
    !Number.isInteger(roi.width) ||
    !Number.isInteger(roi.height) ||
    roi.x < 0 ||
    roi.y < 0 ||
    roi.width < 1 ||
    roi.height < 1
  ) {
    throw new ProcessingError('INVALID_CALIBRATION_ROI', 'ROI coordinates must be positive integer image coordinates.');
  }

  const frames = [];
  let totalPixels = 0;
  for (let index = 0; index < frameBuffers.length; index += 1) {
    const frame = await decodeCalibrationImage(frameBuffers[index], index);
    if (index > 0 && (frame.width !== frames[0].width || frame.height !== frames[0].height)) {
      throw new ProcessingError(
        'CALIBRATION_DIMENSION_MISMATCH',
        'All calibration frames must have identical dimensions and camera framing.',
      );
    }
    totalPixels += frame.width * frame.height;
    if (totalPixels > MAX_TOTAL_SAMPLE_PIXELS) {
      throw new ProcessingError(
        'CALIBRATION_TOO_LARGE',
        'Calibration frames exceed the 40 million aggregate pixel limit.',
      );
    }
    frames.push(frame);
  }

  const { width, height } = frames[0];
  if (roi.x + roi.width > width || roi.y + roi.height > height) {
    throw new ProcessingError('INVALID_CALIBRATION_ROI', 'ROI must lie entirely within the sample frame.');
  }
  const watermarkTop = height - Math.max(24, Math.round(height * 0.06));
  if (roi.y + roi.height > watermarkTop) {
    throw new ProcessingError(
      'INVALID_CALIBRATION_ROI',
      'Timestamp ROI overlaps the reserved derivative watermark area.',
    );
  }

  let defaults;
  try {
    defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  } catch (error) {
    throw new ProcessingError('CALIBRATION_DEFAULTS_FAILED', `Could not load camera defaults: ${error.message}`);
  }
  const referencePixels = medianReferencePatch(frames, roi);
  const referencePng = await sharp(referencePixels, {
    raw: { width: roi.width, height: roi.height, channels: 3 },
  })
    .png()
    .toBuffer();
  const profile = {
    schema_version: 1,
    profile_id: profileId,
    camera_view_id: profileId,
    profile_version: 1,
    display_name: displayName || profileId,
    expected_framing: expectedFraming,
    calibrated: false,
    profile_status: 'draft',
    expected_width: width,
    expected_height: height,
    timezone,
    timestamp: {
      roi,
      roi_normalized: {
        x: roi.x / width,
        y: roi.y / height,
        width: roi.width / width,
        height: roi.height / height,
      },
      format: timestampFormat,
      font_size_px: fontSizePx,
      font_family: 'monospace',
      color_rgb: colorRgb,
      reference_patch_required: true,
    },
    lighting: defaults.lighting,
    calibration: {
      method: 'per_pixel_temporal_median',
      sample_count: frames.length,
      sample_sha256: frames.map((frame) => frame.sha256),
      reference_patch_sha256: sha256(referencePng),
      operator_review: 'pending',
      caveat:
        'Median patch assumes static background and varied timestamp glyph pixels; visually inspect the patch and a processed sample.',
    },
  };
  validateProfile(profile);

  const profileDirectory = path.join(profilesDirectory, profileId);
  try {
    await mkdir(profilesDirectory, { recursive: true });
    await mkdir(profileDirectory);
    const patchPath = path.join(profileDirectory, 'timestamp-reference.png');
    const profilePath = path.join(profileDirectory, 'profile.json');
    await writeFile(patchPath, referencePng, { flag: 'wx' });
    try {
      await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      await rm(patchPath, { force: true });
      throw error;
    }
    return {
      profile,
      profilePath,
      referencePatchPath: patchPath,
      referencePatchBase64: referencePng.toString('base64'),
    };
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new ProcessingError('PROFILE_ALREADY_EXISTS', 'A profile with this ID already exists.');
    }
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError('CALIBRATION_SAVE_FAILED', `Could not save camera profile: ${error.message}`);
  }
}
