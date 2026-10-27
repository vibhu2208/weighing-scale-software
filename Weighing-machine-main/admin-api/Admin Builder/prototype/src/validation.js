import path from 'node:path';
import { ProcessingError } from './errors.js';

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_PIXELS = 20_000_000;

const supportedLightingModes = new Set([
  'none',
  'auto',
  'deep_night',
  'night',
  'dawn',
  'day',
  'dusk',
]);

export function validateJob(job) {
  if (!job || typeof job !== 'object') {
    throw new ProcessingError('INVALID_JOB', 'A job object is required.');
  }
  if (job.timestamp_enabled || job.timestamp_strategy === 'display_annotation' || job.lighting_mode === 'auto') {
    job.datetime_local = normalizeDateTimeLocal(job.datetime_local);
    parseLocalDateTime(job.datetime_local);
  }
  if (typeof job.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(job.job_id)) {
    throw new ProcessingError(
      'INVALID_JOB_ID',
      'job_id must contain 1-80 letters, digits, underscores, or hyphens.',
    );
  }
  if (typeof job.profile_id !== 'string' || !job.profile_id.trim()) {
    throw new ProcessingError('INVALID_JOB', 'profile_id is required.');
  }
  if (typeof job.timestamp_enabled !== 'boolean') {
    throw new ProcessingError('INVALID_JOB', 'timestamp_enabled must be a boolean.');
  }
  if (
    job.timestamp_strategy !== undefined &&
    !['none', 'display_annotation', 'reference_patch'].includes(job.timestamp_strategy)
  ) {
    throw new ProcessingError('INVALID_TIMESTAMP_STRATEGY', 'Unsupported timestamp strategy.');
  }
  if (job.timestamp_enabled && job.timestamp_strategy === 'display_annotation') {
    throw new ProcessingError(
      'INVALID_TIMESTAMP_STRATEGY',
      'Display-time annotation cannot be combined with in-frame timestamp replacement.',
    );
  }
  if (!supportedLightingModes.has(job.lighting_mode)) {
    throw new ProcessingError(
      'INVALID_LIGHTING_MODE',
      `Unsupported lighting mode: ${String(job.lighting_mode)}.`,
    );
  }
  if (!['png', 'jpeg'].includes(job.output_format)) {
    throw new ProcessingError('INVALID_OUTPUT_FORMAT', 'output_format must be png or jpeg.');
  }
}

export function normalizeDateTimeLocal(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return `${value}:00`;
  }
  return value;
}

export function parseLocalDateTime(value) {
  if (typeof value !== 'string') {
    throw new ProcessingError(
      'INVALID_DATETIME',
      'datetime_local must use YYYY-MM-DDTHH:mm:ss without an offset.',
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new ProcessingError(
      'INVALID_DATETIME',
      'datetime_local must use YYYY-MM-DDTHH:mm:ss without an offset.',
    );
  }
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, second, 0);
  if (
    year < 1 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ProcessingError('INVALID_DATETIME', 'datetime_local is not a valid calendar time.');
  }
  return { year, month, day, hour, minute, second };
}

export function formatTimestamp(value, template) {
  const parts = parseLocalDateTime(value);
  if (typeof template !== 'string' || !template.length) {
    throw new ProcessingError('INVALID_PROFILE', 'timestamp.format must be a non-empty string.');
  }
  const values = {
    '%Y': String(parts.year).padStart(4, '0'),
    '%m': String(parts.month).padStart(2, '0'),
    '%d': String(parts.day).padStart(2, '0'),
    '%H': String(parts.hour).padStart(2, '0'),
    '%M': String(parts.minute).padStart(2, '0'),
    '%S': String(parts.second).padStart(2, '0'),
  };
  const output = template.replace(/%./g, (token) => {
    if (!(token in values)) {
      throw new ProcessingError(
        'UNSUPPORTED_TIMESTAMP_FORMAT',
        `Unsupported timestamp format token: ${token}.`,
      );
    }
    return values[token];
  });
  return output;
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new ProcessingError('INVALID_PROFILE', 'A camera profile is required.');
  }
  if (profile.schema_version !== 1) {
    throw new ProcessingError('INVALID_PROFILE', 'Only camera profile schema_version 1 is supported.');
  }
  if (typeof profile.profile_id !== 'string' || !profile.profile_id.trim()) {
    throw new ProcessingError('INVALID_PROFILE', 'profile_id is required in the camera profile.');
  }
  if (!Number.isInteger(profile.profile_version) || profile.profile_version < 1) {
    throw new ProcessingError('INVALID_PROFILE', 'profile_version must be a positive integer.');
  }
  if (typeof profile.calibrated !== 'boolean') {
    throw new ProcessingError('INVALID_PROFILE', 'calibrated must be a boolean.');
  }
  if (
    !Number.isInteger(profile.expected_width) ||
    !Number.isInteger(profile.expected_height) ||
    profile.expected_width < 1 ||
    profile.expected_height < 1 ||
    profile.expected_width * profile.expected_height > MAX_PIXELS
  ) {
    throw new ProcessingError('INVALID_PROFILE', 'Camera profile dimensions are invalid.');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: profile.timezone }).format(new Date(0));
  } catch {
    throw new ProcessingError('INVALID_PROFILE', 'The camera profile timezone is not a valid IANA timezone.');
  }
  const roi = profile.timestamp?.roi;
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
    roi.x + roi.width > profile.expected_width ||
    roi.y + roi.height > profile.expected_height
  ) {
    throw new ProcessingError('INVALID_PROFILE', 'Timestamp ROI must be a positive rectangle within profile bounds.');
  }
  if (typeof profile.timestamp?.format !== 'string' || !profile.timestamp.format) {
    throw new ProcessingError('INVALID_PROFILE', 'timestamp.format is required.');
  }
  const fontSize = profile.timestamp.font_size_px;
  if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > roi.height - 2) {
    throw new ProcessingError('INVALID_PROFILE', 'font_size_px must fit inside the timestamp ROI.');
  }
  if (!/^[A-Za-z0-9 ,_-]{1,80}$/.test(profile.timestamp.font_family || '')) {
    throw new ProcessingError('INVALID_PROFILE', 'timestamp.font_family contains unsupported characters.');
  }
  if (
    !Array.isArray(profile.timestamp.color_rgb) ||
    profile.timestamp.color_rgb.length !== 3 ||
    profile.timestamp.color_rgb.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new ProcessingError('INVALID_PROFILE', 'timestamp.color_rgb must contain three integers from 0 to 255.');
  }
  for (const [preset, settings] of Object.entries(profile.lighting?.presets || {})) {
    if (
      !supportedLightingModes.has(preset) ||
      preset === 'none' ||
      preset === 'auto' ||
      !Number.isFinite(settings.exposure_ev) ||
      settings.exposure_ev < -6 ||
      settings.exposure_ev > 2 ||
      !Number.isFinite(settings.gamma) ||
      settings.gamma < 0.4 ||
      settings.gamma > 2.5 ||
      !Number.isFinite(settings.saturation) ||
      settings.saturation < 0 ||
      settings.saturation > 2
    ) {
      throw new ProcessingError('INVALID_PROFILE', `Lighting preset "${preset}" has invalid parameters.`);
    }
    const optionalFinite = [
      ['target_luminance', 16, 200],
      ['min_exposure_ev', -3, 0.5],
      ['max_exposure_ev', -2.8, 2.5],
      ['contrast', 0.8, 1.4],
      ['red_gain', 0.7, 1.3],
      ['blue_gain', 0.7, 1.3],
    ];
    for (const [key, min, max] of optionalFinite) {
      if (settings[key] === undefined) continue;
      if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) {
        throw new ProcessingError('INVALID_PROFILE', `Lighting preset "${preset}" has invalid ${key}.`);
      }
    }
    if (
      Number.isFinite(settings.min_exposure_ev) &&
      Number.isFinite(settings.max_exposure_ev) &&
      settings.min_exposure_ev > settings.max_exposure_ev
    ) {
      throw new ProcessingError('INVALID_PROFILE', `Lighting preset "${preset}" has inverted exposure bounds.`);
    }
  }
}

export function resolveLighting(mode, datetimeLocal) {
  if (mode !== 'auto') return mode;
  const { hour, minute } = parseLocalDateTime(datetimeLocal);
  const minutes = hour * 60 + minute;
  if (minutes < 5 * 60) return 'deep_night';
  if (minutes < 7 * 60 + 30) return 'dawn';
  if (minutes < 17 * 60 + 30) return 'day';
  if (minutes < 19 * 60) return 'dusk';
  return 'night';
}

export function validateInputPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ProcessingError('INVALID_INPUT', 'A source image path is required.');
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(extension)) {
    throw new ProcessingError('UNSUPPORTED_FORMAT', 'Only JPEG and PNG input files are supported.');
  }
}
