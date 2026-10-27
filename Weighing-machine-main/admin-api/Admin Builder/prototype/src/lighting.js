import { ProcessingError } from './errors.js';
import { parseLocalDateTime, resolveLighting } from './validation.js';

const LIGHTING_KEYFRAMES = [
  { minutes: 0, preset: 'deep_night' },
  { minutes: 4 * 60 + 30, preset: 'deep_night' },
  { minutes: 6 * 60, preset: 'dawn' },
  { minutes: 7 * 60 + 30, preset: 'dawn' },
  { minutes: 9 * 60, preset: 'day' },
  { minutes: 16 * 60, preset: 'day' },
  { minutes: 17 * 60 + 45, preset: 'dusk' },
  { minutes: 19 * 60, preset: 'night' },
  { minutes: 21 * 60 + 30, preset: 'night' },
  { minutes: 24 * 60, preset: 'deep_night' },
];

const BLEND_KEYS = [
  'exposure_ev',
  'target_luminance',
  'min_exposure_ev',
  'max_exposure_ev',
  'gamma',
  'saturation',
  'contrast',
  'red_gain',
  'blue_gain',
];

export const SIMULATION_MIN_EV = -2.8;
export const SIMULATION_MAX_EV = 0.9;
const ENCODE_GAMMA = 2.2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
  const span = edge1 - edge0;
  if (span <= 0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / span, 0, 1);
  return t * t * (3 - 2 * t);
}

export function srgbToLinearChannel(channel) {
  const encoded = channel / 255;
  if (encoded <= 0.04045) return encoded / 12.92;
  return ((encoded + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgbChannel(linear) {
  const value = clamp(linear, 0, 1);
  const encoded = value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
  return clamp(Math.round(encoded * 255), 0, 255);
}

// One gain for the whole pixel. Near-black stays put so night noise is not
// stretched into fake detail. Specular lamps and headlights are held when
// darkening. Already-bright surfaces keep their own contrast when lifting.
export function midtoneGain(luma, exposure) {
  if (exposure === 1) return 1;
  if (exposure > 1) {
    const shadow = smoothstep(16, 48, luma);
    const highlight = 1 - smoothstep(112, 156, luma);
    return 1 + (exposure - 1) * shadow * highlight;
  }
  const active = smoothstep(12, 40, luma);
  const headlightHold = 1 - smoothstep(195, 235, luma);
  return 1 + (exposure - 1) * active * headlightHold;
}

export function presetExceedsConservativeLimits(settings, appliedEv) {
  const exposure = Number.isFinite(appliedEv) ? appliedEv : Number(settings?.exposure_ev);
  return (
    !Number.isFinite(exposure) ||
    exposure < SIMULATION_MIN_EV ||
    exposure > SIMULATION_MAX_EV ||
    (Number.isFinite(settings?.gamma) && Math.abs(settings.gamma - 1) > 0.08) ||
    (Number.isFinite(settings?.contrast) && Math.abs(settings.contrast - 1) > 0.08)
  );
}

function lerp(from, to, t) {
  return from + (to - from) * t;
}

export function meanLuminance(pixels) {
  let sum = 0;
  const count = pixels.length / 3;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    sum += 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
  }
  return count === 0 ? 0 : sum / count;
}

function sampleLuminance(pixels, offset) {
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

export function luminancePercentile(pixels, percentile) {
  const count = Math.floor(pixels.length / 3);
  if (count === 0) return 0;
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = sampleLuminance(pixels, index * 3);
  }
  values.sort();
  const rank = Math.min(count - 1, Math.max(0, Math.floor(percentile * (count - 1))));
  return values[rank];
}

export function lightingBlendForLocalTime(datetimeLocal) {
  const { hour, minute } = parseLocalDateTime(datetimeLocal);
  const minutes = hour * 60 + minute;
  let from = LIGHTING_KEYFRAMES[0];
  let to = LIGHTING_KEYFRAMES[LIGHTING_KEYFRAMES.length - 1];
  for (let index = 0; index < LIGHTING_KEYFRAMES.length - 1; index += 1) {
    if (minutes >= LIGHTING_KEYFRAMES[index].minutes && minutes <= LIGHTING_KEYFRAMES[index + 1].minutes) {
      from = LIGHTING_KEYFRAMES[index];
      to = LIGHTING_KEYFRAMES[index + 1];
      break;
    }
  }
  const span = Math.max(1, to.minutes - from.minutes);
  const t = Math.min(1, Math.max(0, (minutes - from.minutes) / span));
  return {
    from: from.preset,
    to: to.preset,
    t: Number(t.toFixed(4)),
    preset: t < 0.5 ? from.preset : to.preset,
    minutes,
  };
}

function blendSettings(fromSettings, toSettings, t) {
  const settings = { ...fromSettings };
  for (const key of BLEND_KEYS) {
    const fromValue = fromSettings[key];
    const toValue = toSettings[key];
    if (Number.isFinite(fromValue) && Number.isFinite(toValue)) {
      settings[key] = lerp(fromValue, toValue, t);
    } else if (Number.isFinite(toValue)) {
      settings[key] = toValue;
    }
  }
  return settings;
}

function resolveExposureEv(settings, sourceMean) {
  const requestedEv = Number(settings.exposure_ev);
  const minEv = Number.isFinite(settings.min_exposure_ev) ? settings.min_exposure_ev : SIMULATION_MIN_EV;
  const maxEv = Number.isFinite(settings.max_exposure_ev) ? settings.max_exposure_ev : SIMULATION_MAX_EV;
  const low = Math.max(SIMULATION_MIN_EV, minEv);
  const high = Math.min(SIMULATION_MAX_EV, maxEv);
  let chosen = requestedEv;
  if (Number.isFinite(settings.target_luminance) && sourceMean > 1) {
    chosen = ENCODE_GAMMA * Math.log2(settings.target_luminance / sourceMean);
  }
  if (!Number.isFinite(chosen)) chosen = 0;
  return clamp(chosen, low, high);
}

export function applyLighting(pixels, mode, datetimeLocal, profile) {
  if (mode === 'none') {
    return {
      pixels: Buffer.from(pixels),
      preset: 'none',
      parameters: { exposure_ev: 0, gamma: 1, saturation: 1 },
    };
  }

  const blend = mode === 'auto' ? lightingBlendForLocalTime(datetimeLocal) : null;
  const preset = blend ? blend.preset : resolveLighting(mode, datetimeLocal);
  const namedSettings = profile.lighting?.presets?.[preset];
  if (!namedSettings) {
    throw new ProcessingError(
      'MISSING_LIGHTING_PRESET',
      `Camera profile does not define a valid "${preset}" lighting preset.`,
    );
  }
  const settings = blend
    ? blendSettings(
        profile.lighting.presets[blend.from],
        profile.lighting.presets[blend.to],
        blend.t,
      )
    : namedSettings;
  if (!settings) {
    throw new ProcessingError(
      'MISSING_LIGHTING_PRESET',
      `Camera profile does not define lighting presets for the requested time.`,
    );
  }

  const sourceMean = meanLuminance(pixels);
  const sourceP10 = luminancePercentile(pixels, 0.1);
  const sourceP90 = luminancePercentile(pixels, 0.9);
  const requestedEv = Number(settings.exposure_ev);
  const exposureEv = resolveExposureEv(settings, sourceMean);
  const exposure = 2 ** exposureEv;
  const saturation = Number.isFinite(settings.saturation) ? clamp(settings.saturation, 0.55, 1.15) : 1;
  const redGain = Number.isFinite(settings.red_gain) ? clamp(settings.red_gain, 0.85, 1.15) : 1;
  const blueGain = Number.isFinite(settings.blue_gain) ? clamp(settings.blue_gain, 0.85, 1.15) : 1;
  const gainByLuma = new Float64Array(256);
  const linearLut = new Float64Array(256);
  for (let code = 0; code < 256; code += 1) {
    gainByLuma[code] = midtoneGain(code, exposure);
    linearLut[code] = srgbToLinearChannel(code);
  }
  const output = Buffer.allocUnsafe(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    const sourceLuma = sampleLuminance(pixels, offset);
    const gain = gainByLuma[Math.max(0, Math.min(255, Math.round(sourceLuma)))];
    let r = linearLut[pixels[offset]] * gain * redGain;
    let g = linearLut[pixels[offset + 1]] * gain;
    let b = linearLut[pixels[offset + 2]] * gain * blueGain;
    if (saturation !== 1) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = y + saturation * (r - y);
      g = y + saturation * (g - y);
      b = y + saturation * (b - y);
    }
    output[offset] = linearToSrgbChannel(r);
    output[offset + 1] = linearToSrgbChannel(g);
    output[offset + 2] = linearToSrgbChannel(b);
  }

  const outputMean = meanLuminance(output);
  const insufficientSource =
    (preset === 'day' || preset === 'dawn') &&
    sourceMean < 24 &&
    sourceP10 < 8;
  const nightRetainsDaylight =
    (preset === 'deep_night' || preset === 'night') &&
    sourceMean >= 68 &&
    (outputMean > 64 || outputMean > sourceMean * 0.78);

  return {
    pixels: output,
    preset,
    parameters: {
      exposure_ev: settings.exposure_ev,
      applied_exposure_ev: Number(exposureEv.toFixed(4)),
      requested_exposure_ev: Number(requestedEv.toFixed(4)),
      target_luminance: Number.isFinite(settings.target_luminance)
        ? Number(settings.target_luminance.toFixed(2))
        : null,
      curve: 'linear_midtone_chroma',
      gamma_applied: 1,
      contrast_applied: 1,
      saturation_applied: Number(saturation.toFixed(4)),
      red_gain_applied: Number(redGain.toFixed(4)),
      blue_gain_applied: Number(blueGain.toFixed(4)),
      shadow_hold_below: 16,
      highlight_hold_above: exposureEv > 0 ? 156 : 235,
      headlight_hold: exposureEv < 0,
      source_mean_luminance: Number(sourceMean.toFixed(2)),
      source_p10_luminance: Number(sourceP10.toFixed(2)),
      source_p90_luminance: Number(sourceP90.toFixed(2)),
      output_mean_luminance: Number(outputMean.toFixed(2)),
      highlight_limited: exposureEv > 0 && sourceP90 > 112,
      insufficient_source_information: insufficientSource,
      night_retains_daylight_presentation: nightRetainsDaylight,
      preset_outside_conservative_limits: presetExceedsConservativeLimits(settings, exposureEv),
      ...(blend && blend.from !== blend.to
        ? { blend: { from: blend.from, to: blend.to, t: blend.t } }
        : {}),
    },
  };
}
