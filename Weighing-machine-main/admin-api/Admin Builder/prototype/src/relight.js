// Time-of-day relighting for CCTV stills (training-data derivatives).
//
// Pure pixel grading calibrated on reference frames from this site
// (scripts/measure-frames.mjs, scripts/validate-relight.mjs): a tone curve
// toward the time-of-day target, a measured night light-falloff map, a light
// colour grade, and flat ambient skylight when lifting toward day.
// Operator-placed lamps are the only added point lights. It never invents
// scene content.
import sharp from 'sharp';
import { parseLocalDateTime } from './validation.js';

// Night-to-day look, fitted to the reference day frames by
// scripts/tune-lift.mjs. Exported so the tuning script can sweep it.
export const LIFT = {
  fill: 44, // skylight added to shadows, in levels
  fillTint: 0.6, // how much of the local hue the fill takes (0 = neutral grey)
  saturation: -0.5, // night frames are relatively MORE colourful (warm lamps), so desaturate
  darkSaturation: 0.2, // gives some back where the source was darkest
  detail: 4.5, // luma detail put back after denoising
  core: 2.0, // detail below this many source levels is noise and is left out
  detailCap: 7, // most detail one edge can add (source levels): stops outlines on strong edges
  clarity: 0, // local contrast against a wide blur (adds halos; keep at 0)
  whiteBalance: 1.15, // how far toward the daytime red/blue ratio
  spread: 0.4, // restores the highlight spread a gamma lift compresses
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const hm = (h, m = 0) => h * 60 + m;

// Winter schedule set by the operator: fully dark 18:30-05:30, daylit otherwise.
// Each ramp sits on the day side, so the whole dark window is fully dark.
//   L: target mean luminance (0-255). Reference frames: day ~100, late
//      afternoon 50-77, 18:17-19:06 about 25-27, 20:06 about 14-21.
//   night: how dark and lamp-lit the scene reads (0..1).
//   warm: colour temperature shift (low sun).
export const NIGHT_START = hm(18, 30);
export const NIGHT_END = hm(5, 30);
const KEYFRAMES = [
  { m: 0,          L: 20, night: 1, warm: 0 },
  { m: hm(4, 30),  L: 20, night: 1, warm: 0 },
  { m: NIGHT_END,  L: 24, night: 1, warm: 0 },
  { m: hm(6),      L: 70, night: 0, warm: 0.05 },
  { m: hm(8),      L: 100, night: 0, warm: 0 },
  { m: hm(16),     L: 100, night: 0, warm: 0 },
  { m: hm(18),     L: 62, night: 0, warm: 0.06 },
  { m: NIGHT_START, L: 27, night: 1, warm: 0 },
  { m: hm(20),     L: 20, night: 1, warm: 0 },
  { m: hm(24),     L: 20, night: 1, warm: 0 },
];

export function ambienceForTime(datetimeLocal) {
  const { hour, minute, second } = parseLocalDateTime(datetimeLocal);
  const minutes = hour * 60 + minute + second / 60;
  let i = 0;
  while (i < KEYFRAMES.length - 2 && minutes > KEYFRAMES[i + 1].m) i += 1;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[i + 1];
  const t = smoothstep(a.m, b.m, minutes);
  return {
    minutes,
    L: lerp(a.L, b.L, t),
    night: lerp(a.night, b.night, t),
    warm: lerp(a.warm, b.warm, t),
  };
}

// Night light falloff: reference night / day luminance by frame region, each
// normalised to its frame mean (61 night and 28 day frames). The lights reach
// the foreground; the top corners fall away to black.
const FALLOFF_W = 6;
const FALLOFF_H = 4;
const NIGHT_FALLOFF = [
  0.40, 0.62, 0.71, 0.83, 0.68, 0.49,
  0.68, 0.97, 1.01, 1.14, 1.11, 0.69,
  0.90, 1.05, 1.24, 1.24, 1.07, 0.84,
  1.18, 1.20, 1.27, 1.37, 1.23, 0.91,
];

// Day-to-night tone curve fitted from before/after frames of the same scene
// (scripts/fit-pairs.mjs): [day level, night level], each relative to its own
// frame mean. Darks fall away but highlights stay within about 3.5x the mean; a
// steeper curve turns litter into glitter. The same pairs show no colour tint
// and unchanged saturation relative to brightness, so none is applied.
const NIGHT_TONE = [
  [0, 0], [0.21, 0.05], [0.37, 0.18], [0.49, 0.29], [0.7, 0.54], [0.93, 0.84],
  [1.21, 1.27], [1.61, 1.94], [1.87, 2.36], [2.53, 3.39],
];

function nightTone(x) {
  const last = NIGHT_TONE[NIGHT_TONE.length - 1];
  if (x >= last[0]) return last[1] + (x - last[0]) * 1.4;
  let i = 1;
  while (x > NIGHT_TONE[i][0]) i += 1;
  const [x0, y0] = NIGHT_TONE[i - 1];
  const [x1, y1] = NIGHT_TONE[i];
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function morph(src, w, h, radius, grow) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let hit = !grow;
      for (let dy = -radius; dy <= radius && hit !== grow; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const yy = clamp(y + dy, 0, h - 1);
          const xx = clamp(x + dx, 0, w - 1);
          if (Boolean(src[yy * w + xx]) === grow) { hit = grow; break; }
        }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

// Open sky has no light source at night, but the tone curve alone leaves it grey.
// Returns a map of the flat, bright, near-neutral region connected to the top
// edge (0..255), or null when there is none. Painted walls stay out: reference
// night frames keep them as dark colour.
async function openSkyMask(pixels, width, height) {
  const sw = Math.max(32, Math.round(width / 8));
  const sh = Math.max(20, Math.round(height / 8));
  const small = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .resize(sw, sh, { fit: 'fill', kernel: 'cubic' })
    .blur(1)
    .raw()
    .toBuffer();
  const lum = (x, y) => lumaOf(small, (y * sw + x) * 3);
  const flat = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const o = (y * sw + x) * 3;
      const v = lumaOf(small, o);
      if (v < 165 || Math.max(small[o], small[o + 1], small[o + 2]) - Math.min(small[o], small[o + 1], small[o + 2]) > 35) continue;
      const edge = Math.abs(v - lum(Math.min(x + 1, sw - 1), y)) + Math.abs(v - lum(x, Math.min(y + 1, sh - 1)));
      if (edge < 16) flat[y * sw + x] = 1;
    }
  }
  const seen = new Uint8Array(sw * sh);
  const stack = [];
  // Several rows, because the stamp can split the region from the top edge.
  const seedRows = Math.max(1, Math.round(sh * 0.1));
  for (let y = 0; y < seedRows; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      if (flat[y * sw + x] && !seen[y * sw + x]) {
        seen[y * sw + x] = 1;
        stack.push(y * sw + x);
      }
    }
  }
  let area = 0;
  const maxY = Math.round(sh * 0.6);
  while (stack.length) {
    const c = stack.pop();
    area += 1;
    const x = c % sw;
    const y = (c - x) / sw;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= sw || ny > maxY) continue;
      const n = ny * sw + nx;
      if (flat[n] && !seen[n]) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  if (area < sw * sh * 0.015) return null;
  // Coarse and slightly oversized: relight() gates it per pixel by brightness,
  // so the real edge comes from the image and branches keep their shape.
  const grown = morph(seen, sw, sh, 3, true);
  const map = Buffer.alloc(sw * sh);
  for (let i = 0; i < map.length; i += 1) map[i] = grown[i] ? 255 : 0;
  return singleChannel(
    sharp(map, { raw: { width: sw, height: sh, channels: 1 } })
      .blur(1.5)
      .resize(width, height, { fit: 'fill', kernel: 'cubic' }),
  );
}

function falloffAxis(size, cells) {
  const index = new Int32Array(size);
  const frac = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const c = clamp(((i + 0.5) / size) * cells - 0.5, 0, cells - 1);
    const c0 = Math.min(Math.floor(c), cells - 2);
    index[i] = c0;
    frac[i] = c - c0;
  }
  return { index, frac };
}

function buildFalloff(width, height) {
  const ax = falloffAxis(width, FALLOFF_W);
  const ay = falloffAxis(height, FALLOFF_H);
  return (x, y) => {
    const c = ax.index[x];
    const r = ay.index[y];
    const fx = ax.frac[x];
    const fy = ay.frac[y];
    const top = lerp(NIGHT_FALLOFF[r * FALLOFF_W + c], NIGHT_FALLOFF[r * FALLOFF_W + c + 1], fx);
    const bottom = lerp(NIGHT_FALLOFF[(r + 1) * FALLOFF_W + c], NIGHT_FALLOFF[(r + 1) * FALLOFF_W + c + 1], fx);
    return lerp(top, bottom, fy);
  };
}

const lumaOf = (p, o) => 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];

// Gaussian blur on a float buffer, as three box passes. Used on the lift-to-day
// path: sharp returns 8-bit, and lifting 8-bit values by 5x or more leaves
// visible steps in the smooth parts of a dark frame.
function boxBlur1D(src, dst, len, stride, offset, r) {
  const d = 2 * r + 1;
  let acc = 0;
  for (let i = -r; i <= r; i += 1) acc += src[offset + clamp(i, 0, len - 1) * stride];
  for (let i = 0; i < len; i += 1) {
    dst[offset + i * stride] = acc / d;
    acc += src[offset + clamp(i + r + 1, 0, len - 1) * stride] - src[offset + clamp(i - r, 0, len - 1) * stride];
  }
}

function blurFloat(input, width, height, sigma) {
  const passes = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let low = Math.floor(ideal);
  if (low % 2 === 0) low -= 1;
  const high = low + 2;
  const lowCount = Math.round((12 * sigma * sigma - passes * low * low - 4 * passes * low - 3 * passes) / (-4 * low - 4));
  let a = Float32Array.from(input);
  let b = new Float32Array(input.length);
  for (let pass = 0; pass < passes; pass += 1) {
    const r = ((pass < lowCount ? low : high) - 1) / 2;
    for (let y = 0; y < height; y += 1) boxBlur1D(a, b, width, 1, y * width, r);
    for (let x = 0; x < width; x += 1) boxBlur1D(b, a, height, width, x, r);
  }
  return a;
}

// sharp returns 3 channels from 1-channel raw input unless told otherwise; the
// maps below are indexed per pixel, so they must stay single-channel.
function singleChannel(image) {
  return image.toColourspace('b-w').extractChannel(0).raw().toBuffer();
}

async function blurred(pixels, width, height, sigma) {
  return sharp(pixels, { raw: { width, height, channels: 3 } }).blur(sigma).raw().toBuffer();
}

// Source class: 0 = daylit, 1 = night. Mean brightness alone fails: floodlit
// night frames reach a mean of 52 while dim afternoon frames sit at 25-50. What
// separates them is the darkest tenth of the frame. Across 125 reference frames
// labelled by their own stamp time, night p10 is 0-13 (90% at or below 7) and day
// p10 is 17 or more (90% of frames), so p10 decides and the mean only rules out
// frames that are plainly bright.
function sourceNightness(mean, p10) {
  const dark = 1 - smoothstep(12, 18, p10);
  const dim = 1 - smoothstep(60, 80, mean);
  return Math.min(dark, dim);
}

function statsOf(pixels, width, height, skip) {
  let sum = 0;
  let r = 0;
  let b = 0;
  let n = 0;
  const hist = new Uint32Array(256);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (skip && x >= skip.left && x < skip.right && y >= skip.top && y < skip.bottom) continue;
      const o = (y * width + x) * 3;
      const l = lumaOf(pixels, o);
      sum += l;
      hist[Math.round(l)] += 1;
      r += pixels[o];
      b += pixels[o + 2];
      n += 1;
    }
  }
  let p10 = 0;
  for (let acc = 0; p10 < 255 && acc + hist[p10] < n * 0.1; p10 += 1) acc += hist[p10];
  return { mean: n ? sum / n : 0, redBlue: r / Math.max(b, 1), p10 };
}

// lamps: [{ x, y, radius, strength }] in pixels; strength 0..1.
export async function relight(pixels, width, height, datetimeLocal, { skipRect = null, lamps = [] } = {}) {
  const amb = ambienceForTime(datetimeLocal);
  const { mean: srcMean, redBlue, p10: srcP10 } = statsOf(pixels, width, height, skipRect);
  const srcNight = sourceNightness(srcMean, srcP10);
  // delta > 0: toward night, the fitted tone curve and the falloff map apply.
  // delta < 0: toward day, a gamma lift with the falloff divided out.
  const delta = amb.night - srcNight;
  const towardNight = Math.max(delta, 0);
  const towardDay = Math.max(-delta, 0);
  const gamma = delta >= 0 ? 1 : 1 + 0.45 * delta;
  const lifting = towardDay > 0.2;
  const toneLut = new Float32Array(256);
  for (let v = 0; v < 256; v += 1) {
    if (delta < 0) {
      toneLut[v] = 255 * (v / 255) ** gamma;
    } else {
      const x = v / Math.max(srcMean, 1);
      toneLut[v] = Math.max(srcMean, 1) * lerp(x, nightTone(x), towardNight);
    }
  }
  const toneAt = (v) => {
    const c = clamp(v, 0, 255);
    const i = Math.min(Math.floor(c), 254);
    return lerp(toneLut[i], toneLut[i + 1], c - i);
  };

  // Lifting a night frame pulls its warm cast part way back toward the daytime
  // red/blue ratio of about 1.12.
  const pull = lifting ? (1.12 / Math.max(redBlue, 0.5)) ** Math.min(LIFT.whiteBalance, towardDay * LIFT.whiteBalance * 1.2) : 1;
  const rGain = clamp(Math.sqrt(pull), 0.75, 1.1) * (1 + amb.warm);
  const bGain = clamp(1 / Math.sqrt(pull), 0.92, 1.3) * (1 - amb.warm);

  // Lifting: median filter keeps edges while removing the noise a lift would
  // magnify; chroma comes from a blur so colour noise does not become confetti.
  const denoised = lifting
    ? await sharp(pixels, { raw: { width, height, channels: 3 } }).median(3).raw().toBuffer()
    : null;
  const chromaSmooth = lifting ? await blurred(pixels, width, height, Math.max(3, width / 400)) : null;
  // Float luma, denoised, plus the blurred copies that detail is taken against.
  let lumaDen = null;
  let lumaFine = null;
  let lumaWide = null;
  // Colour in near-black pixels is mostly sensor noise. Taking it from a wide
  // blur keeps the real hue of a large area (a shrub is green) and drops the
  // speckle, which a saturation boost would otherwise turn into confetti.
  let chromaWide = null;
  if (lifting) {
    const n3 = width * height;
    const sigma = Math.max(8, width / 150);
    const planes = [0, 1, 2].map((c) => {
      const plane = new Float32Array(n3);
      for (let i = 0; i < n3; i += 1) plane[i] = pixels[i * 3 + c];
      return blurFloat(plane, width, height, sigma);
    });
    chromaWide = new Float32Array(n3 * 3);
    for (let i = 0; i < n3; i += 1) {
      chromaWide[i * 3] = planes[0][i];
      chromaWide[i * 3 + 1] = planes[1][i];
      chromaWide[i * 3 + 2] = planes[2][i];
    }
  }
  if (lifting) {
    const n = width * height;
    const med = new Float32Array(n);
    for (let i = 0; i < n; i += 1) med[i] = lumaOf(denoised, i * 3);
    lumaDen = blurFloat(med, width, height, 1.0);
    lumaFine = blurFloat(lumaDen, width, height, 2.4);
    lumaWide = blurFloat(lumaDen, width, height, Math.max(9, width / 130));
  }
  // A night frame is lit in pools and daylight is even: flatten the slowly
  // varying light when lifting.
  let lowLight = null;
  if (lifting) {
    const sw = Math.max(16, Math.round(width / 8));
    const sh = Math.max(16, Math.round(height / 8));
    const small = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .resize(sw, sh, { kernel: 'lanczos3' })
      .blur(Math.max(2, sw / 14))
      .greyscale()
      .raw()
      .toBuffer();
    lowLight = await singleChannel(
      sharp(small, { raw: { width: sw, height: sh, channels: 1 } }).resize(width, height, { fit: 'fill', kernel: 'cubic' }),
    );
  }
  const flattenPower = towardDay * 0.65;
  // Lit lamps in a night source throw glare that daylight would not show.
  let glare = null;
  if (lifting && srcNight > 0.5) {
    const hot = Buffer.alloc(width * height);
    for (let i = 0; i < hot.length; i += 1) {
      const l = lumaOf(pixels, i * 3);
      hot[i] = l > 225 ? Math.round(clamp((l - 225) / 25, 0, 1) * 255) : 0;
    }
    glare = await singleChannel(sharp(hot, { raw: { width, height, channels: 1 } }).blur(Math.max(6, width / 70)));
  }
  const falloffAt = delta !== 0 ? buildFalloff(width, height) : null;
  const falloffPower = towardNight;
  // Toward day, the same map is divided out: a night source's foreground pool
  // and dark top edges are the lights, not the scene.
  const unfalloffPower = lifting ? towardDay * 0.9 : 0;
  const sky = towardNight > 0.5 ? await openSkyMask(pixels, width, height) : null;
  const lightAt = (x, y) => {
    let light = falloffPower > 0 ? falloffAt(x, y) ** falloffPower : 1;
    if (sky) {
      const i = y * width + x;
      if (sky[i] > 0) light *= 1 - (sky[i] / 255) * smoothstep(110, 165, lumaOf(pixels, i * 3)) * 0.82 * towardNight;
    }
    return light;
  };
  const boostAt = lowLight
    ? (i, x, y) => {
      const pool = clamp((srcMean / Math.max(lowLight[i], 6)) ** flattenPower, 0.8, 3.5);
      return pool * falloffAt(x, y) ** -unfalloffPower;
    }
    : () => 1;
  // Daylight fills every shadow: reference day frames have a 10th percentile of
  // about 44 where a lifted night frame would stay near black.
  // The fill is tinted by local colour below, so it lifts shadows without the
  // grey veil a neutral add puts over everything.
  const skyFill = lifting ? LIFT.fill * towardDay : 0;
  // The gamma lift compresses highlights; reference day frames reach p90 ~156 and
  // p99 ~216, so restore that spread around the mean.
  const spread = lifting ? 1 + LIFT.spread * towardDay : 1;
  // Reference day frames carry about 24 of chroma at a mean of 99. A frame lifted
  // from night starts weaker, most of all where the source was darkest, so
  // saturation is raised further the darker the source pixel was.
  const saturation = lifting ? 1 + LIFT.saturation * towardDay : 1;
  const darkSaturation = lifting ? LIFT.darkSaturation * towardDay : 0;
  const detailAmount = lifting ? LIFT.detail * towardDay : 0;
  const clarityAmount = lifting ? LIFT.clarity * towardDay : 0;
  const spreadPivot = Math.max(amb.L - skyFill, 1);

  // Solve the scale so the output mean hits the time-of-day target.
  let sum = 0;
  let count = 0;
  const samples = [];
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      if (skipRect && x >= skipRect.left && x < skipRect.right && y >= skipRect.top && y < skipRect.bottom) continue;
      const i = y * width + x;
      const v = toneAt(lumaOf(pixels, i * 3) * boostAt(i, x, y)) * lightAt(x, y);
      sum += v;
      count += 1;
      samples.push(v);
    }
  }
  let k = Math.max(amb.L - skyFill, 1) / Math.max(sum / Math.max(count, 1), 0.5);
  // Keep ordinary bright surfaces below white; lit lamps may still clip.
  samples.sort((a, b) => a - b);
  const bright = samples[Math.floor(samples.length * (lifting ? 0.97 : 0.995))] || 255;
  k = Math.min(k, (lifting ? 245 : 255) / Math.max(bright, 1));

  const holdLamps = srcNight > 0.5 && !lifting && k < 1;
  const out = Buffer.allocUnsafe(pixels.length);
  const cap = lifting ? 0.6 : 0.8;
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const i = py * width + px;
      const o = i * 3;
      let r = pixels[o];
      let g = pixels[o + 1];
      let b = pixels[o + 2];
      const y0 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let darkness = 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      if (denoised) {
        const dark = 1 - smoothstep(35, 120, y0);
        darkness = dark;
        const yd = lumaDen[i];
        // Hue source: the narrow blur where the pixel is bright enough to trust,
        // the wide one as it approaches black.
        const wide = 1 - smoothstep(10, 45, y0);
        cr = lerp(chromaSmooth[o], chromaWide[o], wide);
        cg = lerp(chromaSmooth[o + 1], chromaWide[o + 1], wide);
        cb = lerp(chromaSmooth[o + 2], chromaWide[o + 2], wide);
        const yc = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
        let yMix = y0 + (yd - y0) * dark;
        // Detail: what the fine blur leaves out, put back at the edges the denoise
        // softened; clarity: the same against a wide blur, for local contrast.
        const fine = yd - lumaFine[i];
        const cored = Math.sign(fine) * Math.min(Math.max(Math.abs(fine) - LIFT.core, 0), LIFT.detailCap);
        yMix += detailAmount * cored * (0.4 + 0.6 * dark);
        yMix += clarityAmount * (yd - lumaWide[i]);
        yMix = Math.max(yMix, 0);
        const cw = 0.9 * dark + 0.15;
        r = yMix + (r - y0) * (1 - cw) + (cr - yc) * cw;
        g = yMix + (g - y0) * (1 - cw) + (cg - yc) * cw;
        b = yMix + (b - y0) * (1 - cw) + (cb - yc) * cw;
      }
      let y = Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 0);
      if (glare && glare[i] > 0 && y < 225) {
        // The halo around a lit lamp is bloom, not scenery: take it down toward
        // the surface under it. The lamp lens itself (y >= 225) is capped below,
        // never hollowed out: subtracting at the centre punches a dark disc.
        const scale = 1 - 0.55 * (glare[i] / 255);
        r *= scale;
        g *= scale;
        b *= scale;
        y *= scale;
      }
      const yIn = y * boostAt(i, px, py);
      let yOut = k * toneAt(yIn) * lightAt(px, py);
      if (spread !== 1) yOut = Math.max(spreadPivot + (yOut - spreadPivot) * spread, 0);
      if (lifting && srcNight > 0.5 && yIn > 190) {
        // Lit lamps in a night source are not glare in daylight.
        yOut = Math.min(yOut, 185 + (Math.min(yIn, 255) - 190) * 0.3);
      }
      if (holdLamps && y0 > 180) {
        // Darkening a night source must not dim lamps with the scene.
        yOut = lerp(yOut, y0, smoothstep(180, 230, y0));
      }
      const f = y > 0.5 ? yOut / y : 0;
      r *= f * rGain;
      g *= f;
      b *= f * bGain;
      if (saturation !== 1) {
        const sat = saturation + darkSaturation * darkness;
        const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = yy + (r - yy) * sat;
        g = yy + (g - yy) * sat;
        b = yy + (b - yy) * sat;
      }
      // Limit extreme chroma from lifted colour speckle.
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx > 8 && (mx - mn) / mx > cap) {
        const sc = (cap * mx) / (mx - mn);
        const yy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = yy + (r - yy) * sc;
        g = yy + (g - yy) * sc;
        b = yy + (b - yy) * sc;
      }
      if (skyFill > 0) {
        // Fill in the local hue, not grey. The hue comes from the colour blur, so
        // noise in a near-black pixel cannot tint it.
        const ys = Math.max(0.2126 * cr + 0.7152 * cg + 0.0722 * cb, 1);
        const tr = 1 + LIFT.fillTint * (clamp(cr / ys, 0.55, 1.6) - 1);
        const tg = 1 + LIFT.fillTint * (clamp(cg / ys, 0.55, 1.6) - 1);
        const tb = 1 + LIFT.fillTint * (clamp(cb / ys, 0.55, 1.6) - 1);
        const tn = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb;
        r += (skyFill * tr) / tn;
        g += (skyFill * tg) / tn;
        b += (skyFill * tb) / tn;
      }
      // Scale an overflow back instead of hard-clipping the hue.
      const peak = Math.max(r, g, b);
      if (peak > 255) {
        const sc = 255 / peak;
        r *= sc;
        g *= sc;
        b *= sc;
      }
      out[o] = clamp(Math.round(r), 0, 255);
      out[o + 1] = clamp(Math.round(g), 0, 255);
      out[o + 2] = clamp(Math.round(b), 0, 255);
    }
  }

  // Operator-placed lamp glows (headlights, site lights) for night frames.
  const placed = [];
  if (amb.night > 0.3) {
    for (const lamp of lamps.slice(0, 12)) {
      const radius = clamp(Number.isFinite(Number(lamp.radius)) && Number(lamp.radius) > 0 ? Number(lamp.radius) : 40, 6, Math.max(width, height) / 3);
      const strength = clamp(Number.isFinite(Number(lamp.strength)) ? Number(lamp.strength) : 0.8, 0, 1) * amb.night;
      const cx = Number(lamp.x);
      const cy = Number(lamp.y);
      if (![cx, cy].every(Number.isFinite)) continue;
      const x0 = Math.max(0, Math.floor(cx - radius * 3));
      const x1 = Math.min(width - 1, Math.ceil(cx + radius * 3));
      const y0 = Math.max(0, Math.floor(cy - radius * 3));
      const y1 = Math.min(height - 1, Math.ceil(cy + radius * 3));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (radius * radius);
          const glow = Math.exp(-d2 * 0.9) * strength + Math.exp(-d2 * 12) * strength * 0.9;
          if (glow < 0.004) continue;
          const o = (y * width + x) * 3;
          out[o] = clamp(out[o] + 255 * glow * 0.98, 0, 255);
          out[o + 1] = clamp(out[o + 1] + 255 * glow * 0.92, 0, 255);
          out[o + 2] = clamp(out[o + 2] + 255 * glow * 0.78, 0, 255);
        }
      }
      placed.push({ x: cx, y: cy, radius, strength: Number(strength.toFixed(3)) });
    }
  }

  const { mean: outMean } = statsOf(out, width, height, skipRect);
  return {
    pixels: out,
    preset: amb.night > 0.5 ? (amb.L < 23 ? 'deep_night' : 'night') : amb.L >= 90 ? 'day' : amb.minutes < hm(12) ? 'dawn' : 'dusk',
    parameters: {
      engine: 'relight',
      curve: delta >= 0 ? 'paired_night_fit' : 'gamma_lift',
      target_luminance: Number(amb.L.toFixed(1)),
      source_mean_luminance: Number(srcMean.toFixed(2)),
      output_mean_luminance: Number(outMean.toFixed(2)),
      tone_gamma: Number(gamma.toFixed(3)),
      scale_k: Number(k.toFixed(4)),
      applied_exposure_ev: Number(Math.log2(Math.max(outMean, 1) / Math.max(srcMean, 1)).toFixed(3)),
      saturation_applied: Number(saturation.toFixed(3)),
      red_gain_applied: Number(rGain.toFixed(3)),
      blue_gain_applied: Number(bGain.toFixed(3)),
      night_weight: Number(amb.night.toFixed(3)),
      source_nightness: Number(srcNight.toFixed(3)),
      source_p10_luminance: srcP10,
      falloff_power: Number(falloffPower.toFixed(3)),
      open_sky_darkened: Boolean(sky),
      lamp_glows: placed,
      insufficient_source_information: srcMean < 8 && amb.night < 0.5,
    },
  };
}
