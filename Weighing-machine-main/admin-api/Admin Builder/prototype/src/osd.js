// In-frame camera OSD (on-screen display) timestamp handling.
//
// The camera stamp is a fixed-pitch bitmap font: "DD-MM-YYYY HH:MM:SS".
// Cameras render it as white text with a black outline, or as black text; the
// outline only shows over bright scenery. We locate it by matching that layout,
// erase it by filling from the surrounding pixels, and redraw the requested time
// with glyph templates harvested from real camera stamps (src/osd-atlas.json) so
// size, pitch, weight, colour and outline match the camera.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ProcessingError } from './errors.js';

const CELLS = 19; // "DD-MM-YYYY HH:MM:SS"
export const ATLAS_W = 24;
export const ATLAS_H = 36;
// Glyph ink is ~80% of the character pitch; the full string spans 18 pitches
// plus one glyph. Each atlas cell covers one full pitch, starting a little
// left of the glyph ink so serifs are not clipped.
export const INK_RATIO = 0.8;
export const WINDOW_OFFSET = -0.1;
const PITCH_DIVISOR = 18 + INK_RATIO;

const luma = (p, o) => 0.2126 * p[o] + 0.7152 * p[o + 1] + 0.0722 * p[o + 2];

let atlasCache = null;
export function loadAtlas() {
  if (atlasCache) return atlasCache;
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'osd-atlas.json');
  atlasCache = JSON.parse(readFileSync(file, 'utf8'));
  return atlasCache;
}

function isNearWhite(p, o, tolerance) {
  return Math.max(p[o], p[o + 1], p[o + 2]) - Math.min(p[o], p[o + 1], p[o + 2]) < tolerance;
}

function clamp8(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Scale factor relative to the ~970px-tall frames the stamp font was sampled at.
function sizeScale(height) {
  return Math.max(1, height / 970);
}

// Glyphs prepared for fast correlation: zero mean, unit norm.
let unitGlyphCache = null;
function unitGlyphs() {
  if (unitGlyphCache) return unitGlyphCache;
  const n = ATLAS_W * ATLAS_H;
  unitGlyphCache = Object.entries(loadAtlas().glyphs).map(([ch, g]) => {
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += g.mask[i];
    mean /= n;
    const z = new Float32Array(n);
    let norm = 0;
    for (let i = 0; i < n; i += 1) {
      z[i] = g.mask[i] - mean;
      norm += z[i] * z[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < n; i += 1) z[i] /= norm;
    return { ch, z, isDigit: /\d/.test(ch) };
  });
  return unitGlyphCache;
}

// The search works on the luma of the top-left region only.
function readRegion(pixels, width, height) {
  const f = sizeScale(height);
  const sw = Math.min(width, Math.round(540 * f));
  const sh = Math.min(height, Math.round(72 * f));
  const data = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) data[y * sw + x] = luma(pixels, (y * width + x) * 3);
  }
  return { data, sw, sh, f };
}

const cellBuffer = new Float32Array(ATLAS_W * ATLAS_H);

// Sample one character cell onto the atlas grid, zero mean and unit norm.
// Returns false for a flat cell, which cannot be a glyph.
function sampleCell(region, geometry, index, shiftX) {
  const { data, sw, sh } = region;
  const { left, top, bandHeight, pitch } = geometry;
  const cellLeft = left + (index + WINDOW_OFFSET) * pitch + shiftX;
  let mean = 0;
  for (let ay = 0; ay < ATLAS_H; ay += 1) {
    const yy = clampIndex(Math.round(top + ((ay + 0.5) / ATLAS_H) * bandHeight - 0.5), sh);
    for (let ax = 0; ax < ATLAS_W; ax += 1) {
      const xx = clampIndex(Math.round(cellLeft + ((ax + 0.5) / ATLAS_W) * pitch - 0.5), sw);
      const v = data[yy * sw + xx];
      cellBuffer[ay * ATLAS_W + ax] = v;
      mean += v;
    }
  }
  mean /= cellBuffer.length;
  let norm = 0;
  for (let i = 0; i < cellBuffer.length; i += 1) {
    cellBuffer[i] -= mean;
    norm += cellBuffer[i] * cellBuffer[i];
  }
  // A real glyph has real contrast; near-flat sky or black must not score on noise.
  if (norm < 16 * cellBuffer.length) return false;
  norm = Math.sqrt(norm);
  for (let i = 0; i < cellBuffer.length; i += 1) cellBuffer[i] /= norm;
  return true;
}

function dot(z) {
  let sum = 0;
  for (let i = 0; i < z.length; i += 1) sum += cellBuffer[i] * z[i];
  return sum;
}

function clampIndex(v, size) {
  if (v < 0) return 0;
  return v >= size ? size - 1 : v;
}

const FIXED_CELLS = { 2: '-', 5: '-', 13: ':', 16: ':' };

// Agreement with the camera layout: each cell's best glyph, in one polarity for
// the whole stamp (white text, or the black text some cameras use on sky).
// Punctuation cells must be punctuation and every other cell must be a digit.
function layoutScore(region, geometry, shifts = [-0.12, -0.06, 0, 0.06, 0.12]) {
  const glyphs = unitGlyphs();
  let light = 0;
  let dark = 0;
  let cells = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (i === 10) continue;
    const fixed = FIXED_CELLS[i];
    let bestLight = -1;
    let bestDark = -1;
    for (const shift of shifts) {
      if (!sampleCell(region, geometry, i, shift * geometry.pitch)) continue;
      for (const g of glyphs) {
        if (fixed ? g.ch !== fixed : !g.isDigit) continue;
        const c = dot(g.z);
        if (c > bestLight) bestLight = c;
        if (-c > bestDark) bestDark = -c;
      }
    }
    light += Math.max(bestLight, 0);
    dark += Math.max(bestDark, 0);
    cells += 1;
  }
  return light >= dark
    ? { score: light / cells, polarity: 'light' }
    : { score: dark / cells, polarity: 'dark' };
}

// A 3x coarser copy of the glyphs: fast enough to try every position and size.
const COARSE = 3;
const COARSE_W = ATLAS_W / COARSE;
const COARSE_H = ATLAS_H / COARSE;
let coarseGlyphCache = null;
function coarseGlyphs() {
  if (coarseGlyphCache) return coarseGlyphCache;
  const n = COARSE_W * COARSE_H;
  coarseGlyphCache = Object.entries(loadAtlas().glyphs).map(([ch, g]) => {
    const z = new Float32Array(n);
    for (let y = 0; y < ATLAS_H; y += 1) {
      for (let x = 0; x < ATLAS_W; x += 1) {
        z[Math.floor(y / COARSE) * COARSE_W + Math.floor(x / COARSE)] += g.mask[y * ATLAS_W + x];
      }
    }
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += z[i];
    mean /= n;
    let norm = 0;
    for (let i = 0; i < n; i += 1) {
      z[i] -= mean;
      norm += z[i] * z[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < n; i += 1) z[i] /= norm;
    return { ch, z, isDigit: /\d/.test(ch) };
  });
  return coarseGlyphCache;
}

const coarseBuffer = new Float32Array(COARSE_W * COARSE_H);

// layoutScore on the coarse grid, with no per-cell shift: the screening pass.
function coarseScore(region, geometry) {
  const { data, sw, sh } = region;
  const glyphs = coarseGlyphs();
  const { left, top, bandHeight, pitch } = geometry;
  let light = 0;
  let dark = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (i === 10) continue;
    const cellLeft = left + (i + WINDOW_OFFSET) * pitch;
    let mean = 0;
    for (let ay = 0; ay < COARSE_H; ay += 1) {
      const yy = clampIndex(Math.round(top + ((ay + 0.5) / COARSE_H) * bandHeight - 0.5), sh);
      for (let ax = 0; ax < COARSE_W; ax += 1) {
        const xx = clampIndex(Math.round(cellLeft + ((ax + 0.5) / COARSE_W) * pitch - 0.5), sw);
        const v = data[yy * sw + xx];
        coarseBuffer[ay * COARSE_W + ax] = v;
        mean += v;
      }
    }
    mean /= coarseBuffer.length;
    let norm = 0;
    for (let k = 0; k < coarseBuffer.length; k += 1) {
      coarseBuffer[k] -= mean;
      norm += coarseBuffer[k] * coarseBuffer[k];
    }
    if (norm < 16 * coarseBuffer.length) continue;
    norm = Math.sqrt(norm);
    const fixed = FIXED_CELLS[i];
    let bestLight = 0;
    let bestDark = 0;
    for (const g of glyphs) {
      if (fixed ? g.ch !== fixed : !g.isDigit) continue;
      let c = 0;
      for (let k = 0; k < coarseBuffer.length; k += 1) c += coarseBuffer[k] * g.z[k];
      c /= norm;
      if (c > bestLight) bestLight = c;
      if (-c > bestDark) bestDark = -c;
    }
    light += bestLight;
    dark += bestDark;
  }
  return Math.max(light, dark) / 18;
}

// Rows and columns with strong local contrast in either direction, so black
// text and outlined text are found as readily as plain white text.
function contrastMap(region) {
  const { data, sw, sh, f } = region;
  const radius = Math.max(6, Math.round(10 * f));
  const integral = new Float64Array((sw + 1) * (sh + 1));
  for (let y = 0; y < sh; y += 1) {
    let row = 0;
    for (let x = 0; x < sw; x += 1) {
      row += data[y * sw + x];
      integral[(y + 1) * (sw + 1) + x + 1] = integral[y * (sw + 1) + x + 1] + row;
    }
  }
  const hot = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(sh, y + radius + 1);
    for (let x = 0; x < sw; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(sw, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * (sw + 1) + x1] - integral[y0 * (sw + 1) + x1]
        - integral[y1 * (sw + 1) + x0] + integral[y0 * (sw + 1) + x0];
      if (Math.abs(data[y * sw + x] - sum / area) > 22) hot[y * sw + x] = 1;
    }
  }
  return hot;
}

function screenGeometries(region) {
  const { sw, sh, f } = region;
  const hot = contrastMap(region);
  const rowPrefix = new Int32Array(sh + 1);
  for (let y = 0; y < sh; y += 1) {
    let count = 0;
    for (let x = 0; x < sw; x += 1) count += hot[y * sw + x];
    rowPrefix[y + 1] = rowPrefix[y] + count;
  }
  const found = [];
  const heightStep = Math.max(2, Math.round(2 * f));
  const leftStep = Math.max(2, Math.round(2 * f));
  for (let h = Math.round(19 * f); h <= Math.round(33 * f) && h <= sh; h += heightStep) {
    const windows = [];
    for (let top = 0; top + h <= sh; top += 1) windows.push({ top, sum: rowPrefix[top + h] - rowPrefix[top] });
    windows.sort((a, b) => b.sum - a.sum);
    const tops = [];
    for (const w of windows) {
      if (tops.every((t) => Math.abs(t - w.top) >= 3 * f)) tops.push(w.top);
      if (tops.length === 4) break;
    }
    for (const top of tops) {
      for (let ratio = 0.62; ratio <= 0.921; ratio += 0.02) {
        const pitch = h * ratio;
        for (let left = 0; left <= 44 * f; left += leftStep) {
          if (left + 18.8 * pitch > sw) break;
          const geometry = { left, top, bandHeight: h, pitch };
          found.push({ geometry, score: coarseScore(region, geometry) });
        }
      }
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 12).map((c) => c.geometry);
}

function polish(region, start) {
  let best = { geometry: start, ...layoutScore(region, start) };
  for (let round = 0; round < 5; round += 1) {
    const g = best.geometry;
    const moves = [
      { left: g.left + 1 }, { left: g.left - 1 }, { top: g.top + 1 }, { top: g.top - 1 },
      { bandHeight: g.bandHeight + 1 }, { bandHeight: g.bandHeight - 1 },
      { pitch: g.pitch * 1.01 }, { pitch: g.pitch * 0.99 },
      { left: g.left + 2, pitch: g.pitch * 0.99 }, { left: g.left - 2, pitch: g.pitch * 1.01 },
      { top: g.top - 1, bandHeight: g.bandHeight + 1 }, { top: g.top - 2, bandHeight: g.bandHeight + 3 },
      { bandHeight: g.bandHeight + 3 },
    ];
    let improved = false;
    for (const move of moves) {
      const trial = { ...g, ...move };
      if (trial.top < 0 || trial.top + trial.bandHeight > region.sh) continue;
      const scored = layoutScore(region, trial);
      if (scored.score > best.score + 0.002) {
        best = { geometry: trial, ...scored };
        improved = true;
      }
    }
    if (!improved) break;
  }
  return best;
}

// Text colour from the stamp's own ink: near the bright end for light text, near
// the dark end for dark text. Stamps are neutral, so scene colour is averaged out.
function sampleTextColor(pixels, width, osd) {
  const samples = [];
  for (let y = osd.top; y <= osd.bottom; y += 1) {
    for (let x = Math.max(0, Math.round(osd.left)); x <= osd.right; x += 1) {
      const o = (y * width + x) * 3;
      samples.push([luma(pixels, o), o]);
    }
  }
  samples.sort((a, b) => a[0] - b[0]);
  const from = osd.polarity === 'dark' ? 0.03 : 0.86;
  const to = osd.polarity === 'dark' ? 0.1 : 0.94;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = Math.floor(samples.length * from); i < samples.length * to; i += 1) {
    const o = samples[i][1];
    r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2]; n += 1;
  }
  const grey = n ? Math.round((r + g + b) / (3 * n)) : 240;
  return [grey, grey, grey];
}

// Best-matching stamp position and its score, whether or not it clears the
// acceptance threshold.
export function findOsd(pixels, width, height) {
  const region = readRegion(pixels, width, height);
  let winner = null;
  const screened = screenGeometries(region)
    .map((geometry) => ({ geometry, ...layoutScore(region, geometry, [-0.06, 0, 0.06]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const candidate of screened) {
    const polished = polish(region, candidate.geometry);
    if (!winner || polished.score > winner.score) winner = polished;
  }
  if (!winner) return { osd: null, score: 0 };
  const { geometry, polarity, score } = winner;
  const left = Math.round(geometry.left);
  const textWidth = Math.round(geometry.pitch * PITCH_DIVISOR);
  const osd = {
    left,
    top: geometry.top,
    right: Math.min(width - 1, left + textWidth - 1),
    bottom: geometry.top + geometry.bandHeight - 1,
    bandHeight: geometry.bandHeight,
    textWidth,
    pitch: geometry.pitch,
    polarity,
  };
  osd.textColor = sampleTextColor(pixels, width, osd);
  return { osd, score };
}

// Returns the stamp geometry, or null when no plausible stamp is found.
export const MIN_STAMP_SCORE = 0.4;

export function locateOsd(pixels, width, height) {
  const { osd, score } = findOsd(pixels, width, height);
  return osd && score >= MIN_STAMP_SCORE ? osd : null;
}

// Normalised luma of one character cell, resampled to the atlas grid. Used by
// the atlas builder (scripts/collect-osd-cells.mjs).
export function cellMask(pixels, width, height, osd, index) {
  const left = osd.left + (index + WINDOW_OFFSET) * osd.pitch;
  const mask = new Float32Array(ATLAS_W * ATLAS_H);
  let lo = 255;
  for (let ay = 0; ay < ATLAS_H; ay += 1) {
    const yy = clampIndex(Math.round(osd.top + ((ay + 0.5) / ATLAS_H) * osd.bandHeight - 0.5), height);
    for (let ax = 0; ax < ATLAS_W; ax += 1) {
      const xx = clampIndex(Math.round(left + ((ax + 0.5) / ATLAS_W) * osd.pitch - 0.5), width);
      const v = luma(pixels, (yy * width + xx) * 3);
      mask[ay * ATLAS_W + ax] = v;
      lo = Math.min(lo, v);
    }
  }
  const textL = osd.textColor[0];
  const floor = Math.min(lo, 60);
  for (let k = 0; k < mask.length; k += 1) {
    mask[k] = Math.max(0, Math.min(1, (mask[k] - floor) / Math.max(1, textL - floor)));
  }
  return mask;
}

// Read the stamp text by matching each cell against the camera glyphs. Returns
// null when the result is not a real date and time. Digit reads are approximate
// and are only used by the calibration tools.
export function readOsdText(pixels, width, height, osd) {
  const region = readRegion(pixels, width, height);
  const sign = osd.polarity === 'dark' ? -1 : 1;
  const digits = unitGlyphs().filter((g) => g.isDigit);
  const geometry = { left: osd.left, top: osd.top, bandHeight: osd.bandHeight, pitch: osd.pitch };
  let text = '';
  for (let i = 0; i < CELLS; i += 1) {
    if (i === 10) { text += ' '; continue; }
    if (FIXED_CELLS[i]) { text += FIXED_CELLS[i]; continue; }
    let best = -2;
    let bestChar = '?';
    for (const shift of [-0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18]) {
      if (!sampleCell(region, geometry, i, shift * osd.pitch)) continue;
      for (const g of digits) {
        const c = sign * dot(g.z);
        if (c > best) { best = c; bestChar = g.ch; }
      }
    }
    text += bestChar;
  }
  const m = /^(\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d):(\d\d)$/.exec(text);
  if (!m || +m[1] > 31 || +m[2] > 12 || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return null;
  return text;
}

export function formatOsdText(datetimeLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(datetimeLocal || '');
  if (!m) throw new ProcessingError('INVALID_DATETIME', 'Date/time must look like YYYY-MM-DDTHH:MM[:SS].');
  const [, y, mo, d, h, mi, s = '00'] = m;
  return `${d}-${mo}-${y} ${h}:${mi}:${s}`;
}

// Erase the old stamp: fill from surrounding pixels (distance-weighted) and
// add matching sensor noise so the patch is not flat.
export function eraseOsd(pixels, width, height, osd) {
  const f = sizeScale(height);
  // Wide enough that the fill never samples glyph edges the band estimate missed.
  const pad = Math.max(4, Math.round(osd.bandHeight * 0.35));
  const x0 = Math.max(0, osd.left - pad);
  const x1 = Math.min(width - 1, osd.right + pad);
  const y0 = Math.max(0, osd.top - pad);
  const y1 = Math.min(height - 1, osd.bottom + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // Threshold from the local background, not a fixed level: the soft halo of a
  // glyph on a near-black background is faint here but a later lift to daylight
  // would magnify it into a readable ghost of the old time.
  const lumas = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) lumas[y * w + x] = luma(pixels, ((y0 + y) * width + (x0 + x)) * 3);
  }
  const sorted = Float32Array.from(lumas).sort();
  const dark = osd.polarity === 'dark';
  const background = sorted[Math.floor(sorted.length * (dark ? 0.65 : 0.4))];
  const textLuma = 0.2126 * osd.textColor[0] + 0.7152 * osd.textColor[1] + 0.0722 * osd.textColor[2];
  const reach = Math.max(12, Math.min(0.22 * Math.abs(textLuma - background), dark ? background : 120 - background));
  const hot = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = ((y0 + y) * width + (x0 + x)) * 3;
      // Both sides: white text carries a dark outline that shows on bright scenes.
      if (Math.abs(lumas[y * w + x] - background) > reach && isNearWhite(pixels, o, 70)) hot[y * w + x] = 1;
    }
  }
  const grow = Math.max(3, Math.round(3 * f));
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!hot[y * w + x]) continue;
      for (let dy = -grow; dy <= grow; dy += 1) {
        for (let dx = -grow; dx <= grow; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) mask[yy * w + xx] = 1;
        }
      }
    }
  }
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      if (mask[y * w + x] || mask[y * w + x - 1]) continue;
      const d = luma(pixels, ((y0 + y) * width + x0 + x) * 3) - luma(pixels, ((y0 + y) * width + x0 + x - 1) * 3);
      sum += d; sum2 += d * d; count += 1;
    }
  }
  const noise = count > 10 ? Math.sqrt(Math.max(0, sum2 / count - (sum / count) ** 2) / 2) : 0;
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.7;
  const out = Buffer.from(pixels);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      let value = null;
      for (const radius of [3, 8, 18, 40].map((v) => Math.round(v * f))) {
        let r = 0;
        let g = 0;
        let b = 0;
        let wsum = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const yy = y + dy;
          const gy = y0 + yy;
          if (gy < 0 || gy >= height) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const xx = x + dx;
            const gx = x0 + xx;
            if (gx < 0 || gx >= width) continue;
            const inBox = yy >= 0 && yy < h && xx >= 0 && xx < w;
            if (inBox && mask[yy * w + xx]) continue;
            const wt = 1 / (1 + dx * dx + dy * dy);
            const o = (gy * width + gx) * 3;
            r += pixels[o] * wt; g += pixels[o + 1] * wt; b += pixels[o + 2] * wt; wsum += wt;
          }
        }
        if (wsum > 0.3) { value = [r / wsum, g / wsum, b / wsum]; break; }
      }
      if (!value) continue;
      const o = ((y0 + y) * width + (x0 + x)) * 3;
      const n = gauss() * noise;
      out[o] = clamp8(value[0] + n);
      out[o + 1] = clamp8(value[1] + n);
      out[o + 2] = clamp8(value[2] + n);
    }
  }
  return out;
}

function sampleMask(mask, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= ATLAS_W || yy >= ATLAS_H ? 0 : mask[yy * ATLAS_W + xx] / 255);
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

// The camera outlines white text in black. It only shows over bright scenery,
// so it must be drawn to match on a frame relit to daylight.
const outlineCache = new Map();
function outlineMask(ch, mask) {
  if (outlineCache.has(ch)) return outlineCache.get(ch);
  const radius = 2;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < ATLAS_H; y += 1) {
    for (let x = 0; x < ATLAS_W; x += 1) {
      let peak = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= ATLAS_H || xx >= ATLAS_W) continue;
          peak = Math.max(peak, mask[yy * ATLAS_W + xx]);
        }
      }
      out[y * ATLAS_W + x] = peak;
    }
  }
  outlineCache.set(ch, out);
  return out;
}

// Black text is only readable on a bright background; on a frame relit to night
// the camera's stamp has to be light.
function legibleOsd(base, width, osd) {
  if (osd.polarity !== 'dark') return osd;
  let sum = 0;
  let n = 0;
  for (let y = osd.top; y <= osd.bottom; y += 2) {
    for (let x = Math.max(0, osd.left); x <= osd.right; x += 2) {
      sum += luma(base, (y * width + x) * 3);
      n += 1;
    }
  }
  return n && sum / n < 90 ? { ...osd, polarity: 'light', textColor: [235, 235, 235] } : osd;
}

// Draw `text` onto `base` using atlas glyphs (does not mutate the input).
export function drawOsd(base, width, height, sourceOsd, text) {
  const osd = legibleOsd(base, width, sourceOsd);
  const atlas = loadAtlas();
  const out = Buffer.from(base);
  const gw = osd.pitch;
  const gh = osd.bandHeight;
  const outlined = osd.polarity !== 'dark';
  const paint = (mask, cellLeft, color, opacity) => {
    const xStart = Math.floor(cellLeft) - 1;
    const xEnd = Math.ceil(cellLeft + gw) + 1;
    for (let py = osd.top; py <= osd.bottom; py += 1) {
      if (py < 0 || py >= height) continue;
      const ay = ((py - osd.top + 0.5) / gh) * ATLAS_H - 0.5;
      for (let px = xStart; px <= xEnd; px += 1) {
        if (px < 0 || px >= width) continue;
        const ax = ((px + 0.5 - cellLeft) / gw) * ATLAS_W - 0.5;
        const a = sampleMask(mask, ax, ay) * opacity;
        if (a <= 0.01) continue;
        const o = (py * width + px) * 3;
        out[o] = clamp8(out[o] * (1 - a) + color[0] * a);
        out[o + 1] = clamp8(out[o + 1] * (1 - a) + color[1] * a);
        out[o + 2] = clamp8(out[o + 2] * (1 - a) + color[2] * a);
      }
    }
  };
  const cells = [];
  for (let i = 0; i < text.length && i < CELLS; i += 1) {
    const ch = text[i];
    if (ch === ' ') continue;
    const glyph = atlas.glyphs[ch];
    if (!glyph) throw new ProcessingError('OSD_GLYPH_MISSING', `No camera glyph template for "${ch}".`);
    cells.push({ ch, glyph, cellLeft: osd.left + (i + WINDOW_OFFSET) * osd.pitch });
  }
  if (outlined) {
    for (const { ch, glyph, cellLeft } of cells) paint(outlineMask(ch, glyph.mask), cellLeft, [8, 8, 8], 0.8);
  }
  for (const { glyph, cellLeft } of cells) paint(glyph.mask, cellLeft, osd.textColor, 1);
  return out;
}

export function planOsdReplacement(pixels, width, height, datetimeLocal) {
  const osd = locateOsd(pixels, width, height);
  if (!osd) {
    throw new ProcessingError(
      'OSD_NOT_FOUND',
      'Could not find the camera timestamp (DD-MM-YYYY HH:MM:SS) in the top-left of the frame.',
    );
  }
  return { osd, text: formatOsdText(datetimeLocal) };
}
