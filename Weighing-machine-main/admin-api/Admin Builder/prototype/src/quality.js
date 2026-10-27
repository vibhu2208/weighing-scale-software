import { SIMULATION_MAX_EV, SIMULATION_MIN_EV } from './lighting.js';

const REPORT_SLOT_ASPECT = 200 / 120;

function lumaAt(pixels, offset) {
  return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
}

function rectOf(rect) {
  if (!rect) return null;
  const left = Math.round(rect.left ?? rect.x ?? 0);
  const top = Math.round(rect.top ?? rect.y ?? 0);
  const width = Math.round(rect.width || 0);
  const height = Math.round(rect.height || 0);
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}

function contains(rect, x, y) {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

function overlaps(a, b, margin = 0) {
  return (
    a.left < b.left + b.width + margin &&
    a.left + a.width + margin > b.left &&
    a.top < b.top + b.height + margin &&
    a.top + a.height + margin > b.top
  );
}

function inside(outer, inner, margin = 0) {
  return (
    inner.left >= outer.left + margin &&
    inner.top >= outer.top + margin &&
    inner.left + inner.width <= outer.left + outer.width - margin &&
    inner.top + inner.height <= outer.top + outer.height - margin
  );
}

export function reportSafeRect(width, height) {
  const imageAspect = width / height;
  if (imageAspect > REPORT_SLOT_ASPECT) {
    const visibleWidth = Math.max(1, Math.min(width, Math.round(height * REPORT_SLOT_ASPECT)));
    const crop = Math.max(0, Math.floor((width - visibleWidth) / 2));
    return { left: crop, top: 0, width: Math.min(width - crop, visibleWidth), height };
  }
  const visibleHeight = Math.max(1, Math.min(height, Math.round(width / REPORT_SLOT_ASPECT)));
  const crop = Math.max(0, Math.floor((height - visibleHeight) / 2));
  return { left: 0, top: crop, width, height: Math.min(height - crop, visibleHeight) };
}

function check(name, pass, details) {
  return { check: name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) };
}

function meanLumaExcluding(pixels, width, height, excluded) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (excluded.some((rect) => contains(rect, x, y))) continue;
      sum += lumaAt(pixels, (y * width + x) * 3);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export function assessVisualQuality({
  sourcePixels,
  outputPixels,
  width,
  height,
  excludedRects = [],
  badge = null,
  detectedOsd = null,
  lighting = null,
}) {
  const excluded = excludedRects.map(rectOf).filter(Boolean);
  const badgeRect = rectOf(badge);
  const safe = reportSafeRect(width, height);
  const frame = { left: 0, top: 0, width, height };
  const checks = [];

  checks.push(check(
    'output_dimensions_match_source',
    outputPixels.length === sourcePixels.length && outputPixels.length === width * height * 3,
    { width, height },
  ));

  if (badgeRect) {
    const areaFraction = (badgeRect.width * badgeRect.height) / (width * height);
    checks.push(check('simulated_badge_inside_frame', inside(frame, badgeRect, 0), badgeRect));
    checks.push(check(
      'simulated_badge_inside_report_safe_rect',
      inside(safe, badgeRect, 0),
      { badge: badgeRect, safe },
    ));
    const largeFrame = width * height >= 640 * 480;
    checks.push(check(
      'simulated_badge_area_within_limit',
      badgeRect.height <= 56 &&
        badgeRect.width <= Math.min(width - 16, 360) &&
        areaFraction <= (largeFrame ? 0.02 : 0.35),
      { areaFraction: Number(areaFraction.toFixed(4)), badge: badgeRect },
    ));
    checks.push(check(
      'simulated_badge_does_not_overlap_camera_osd',
      !(detectedOsd?.detected && overlaps(badgeRect, rectOf(detectedOsd), 4)),
      { badge: badgeRect, osd: detectedOsd || null },
    ));
  }

  let blackRunPixels = 0;
  let longestBlackRun = 0;
  let highlightClips = 0;
  let shadowCrushes = 0;
  let compared = 0;
  let colorShift = 0;
  let colorCount = 0;
  let sourceContrast = 0;
  let outputContrast = 0;
  let contrastCount = 0;

  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const excludedPixel = excluded.some((rect) => contains(rect, x, y));
      const sourceLuma = lumaAt(sourcePixels, offset);
      const outputLuma = lumaAt(outputPixels, offset);
      if (!excludedPixel && sourceLuma > 80 && outputLuma < 25) {
        run += 1;
        blackRunPixels += 1;
      } else {
        if (run > longestBlackRun) longestBlackRun = run;
        run = 0;
      }
      if ((x & 1) === 0 && (y & 1) === 0) {
        compared += 1;
        if (!excludedPixel && sourceLuma < 242 && outputLuma >= 252) highlightClips += 1;
        if (!excludedPixel && sourceLuma > 18 && outputLuma <= 3) shadowCrushes += 1;
        if (!excludedPixel) {
          const sourceCast = sourcePixels[offset] - sourcePixels[offset + 1];
          const outputCast = outputPixels[offset] - outputPixels[offset + 1];
          const sourceBlue = sourcePixels[offset + 2] - sourcePixels[offset + 1];
          const outputBlue = outputPixels[offset + 2] - outputPixels[offset + 1];
          colorShift += Math.abs(outputCast - sourceCast) + Math.abs(outputBlue - sourceBlue);
          colorCount += 1;
          if (x + 2 < width) {
            const right = (y * width + x + 2) * 3;
            if (!excluded.some((rect) => contains(rect, x + 2, y))) {
              sourceContrast += Math.abs(sourceLuma - lumaAt(sourcePixels, right));
              outputContrast += Math.abs(outputLuma - lumaAt(outputPixels, right));
              contrastCount += 1;
            }
          }
        }
      }
    }
    if (run > longestBlackRun) longestBlackRun = run;
  }

  const highlightRate = compared === 0 ? 0 : highlightClips / compared;
  const shadowRate = compared === 0 ? 0 : shadowCrushes / compared;
  const meanColorShift = colorCount === 0 ? 0 : colorShift / colorCount;
  const contrastRatio = sourceContrast < 1 ? 1 : outputContrast / sourceContrast;
  const appliedEv = Number(lighting?.parameters?.applied_exposure_ev ?? 0);
  const sat = lighting?.parameters?.saturation_applied ?? 1;
  const redGain = lighting?.parameters?.red_gain_applied ?? 1;
  const blueGain = lighting?.parameters?.blue_gain_applied ?? 1;
  const chromaBudget =
    Math.abs(1 - sat) * 50 +
    Math.abs(redGain - 1) * 90 +
    Math.abs(blueGain - 1) * 90 +
    (appliedEv < -1 ? 14 : appliedEv > 0.4 ? 6 : 4);
  const colorLimit = 12 + chromaBudget;

  checks.push(check(
    'no_unintended_large_black_rectangles',
    longestBlackRun < 12 && blackRunPixels < 250,
    { longestBlackRun, blackRunPixels },
  ));
  checks.push(check(
    'highlight_clipping_within_limit',
    highlightRate <= 0.0015,
    { highlightRate: Number(highlightRate.toFixed(5)), samples: compared },
  ));
  checks.push(check(
    'shadow_crushing_within_limit',
    shadowRate <= 0.005,
    { shadowRate: Number(shadowRate.toFixed(5)), samples: compared },
  ));
  checks.push(check(
    'color_shift_within_limit',
    meanColorShift <= colorLimit,
    { meanChannelCastChange: Number(meanColorShift.toFixed(3)), limit: colorLimit },
  ));
  checks.push(check(
    'local_contrast_not_expanded',
    contrastRatio <= 1.45,
    { contrastRatio: Number(contrastRatio.toFixed(3)), samples: contrastCount },
  ));

  const lightingOk = !lighting || lighting.preset === 'none' || (
    appliedEv >= SIMULATION_MIN_EV &&
    appliedEv <= SIMULATION_MAX_EV &&
    lighting.parameters?.preset_outside_conservative_limits !== true &&
    lighting.parameters?.gamma_applied === 1 &&
    lighting.parameters?.contrast_applied === 1
  );
  checks.push(check(
    'lighting_within_simulation_limits',
    lightingOk,
    lighting?.parameters
      ? {
          preset: lighting.preset,
          applied_exposure_ev: lighting.parameters.applied_exposure_ev,
          preset_outside_conservative_limits: lighting.parameters.preset_outside_conservative_limits === true,
          curve: lighting.parameters.curve || null,
        }
      : { preset: 'none' },
  ));

  const sourceMean = meanLumaExcluding(sourcePixels, width, height, excluded);
  const outputMean = meanLumaExcluding(outputPixels, width, height, excluded);
  const preset = lighting?.preset || 'none';
  if (preset === 'deep_night' || preset === 'night') {
    const daylightFloor = preset === 'deep_night' ? 64 : 72;
    const requiredRatio = preset === 'deep_night' ? 0.72 : 0.82;
    const brightSource = sourceMean >= 68;
    const pass = brightSource
      ? outputMean <= daylightFloor && outputMean <= sourceMean * requiredRatio
      : outputMean <= Math.max(sourceMean + 8, 70);
    checks.push(check(
      'night_simulation_not_retained_as_daylight',
      pass,
      {
        preset,
        sourceMean: Number(sourceMean.toFixed(2)),
        outputMean: Number(outputMean.toFixed(2)),
        daylightFloor,
        brightSource,
      },
    ));
  }
  if (preset === 'day' || preset === 'dawn') {
    checks.push(check(
      'day_simulation_does_not_require_invented_detail',
      lighting?.parameters?.insufficient_source_information !== true,
      {
        preset,
        sourceMean: Number(sourceMean.toFixed(2)),
        outputMean: Number(outputMean.toFixed(2)),
        insufficient_source_information: lighting?.parameters?.insufficient_source_information === true,
      },
    ));
  }

  const unsupported = lighting?.parameters?.insufficient_source_information === true;
  const failed = checks.filter((item) => item.pass === false);
  return {
    checks,
    machineGatesPass: failed.length === 0,
    unsupported,
    metrics: {
      longestBlackRun,
      blackRunPixels,
      highlightRate: Number(highlightRate.toFixed(5)),
      shadowRate: Number(shadowRate.toFixed(5)),
      meanChannelCastChange: Number(meanColorShift.toFixed(3)),
      contrastRatio: Number(contrastRatio.toFixed(3)),
      sourceMean: Number(sourceMean.toFixed(2)),
      outputMean: Number(outputMean.toFixed(2)),
    },
  };
}
