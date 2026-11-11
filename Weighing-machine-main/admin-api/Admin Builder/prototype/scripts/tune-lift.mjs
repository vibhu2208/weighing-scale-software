// Dev tool: sweep the night-to-day constants (LIFT in src/relight.js) against the
// reference day frames and print the aggregate look for each setting.
//   node scripts/tune-lift.mjs frames.json [max-frames] '<json of settings>' ...
// Each settings argument overrides LIFT, e.g. '{"saturation":0.2}'.
import fs from 'node:fs';
import sharp from 'sharp';
import { eraseOsd, locateOsd } from '../src/osd.js';
import { LIFT, relight } from '../src/relight.js';
import { features } from './frame-features.mjs';

const [, , framesFile, maxArg, ...settings] = process.argv;
const maxFrames = Number(maxArg) || 16;
const frames = JSON.parse(fs.readFileSync(framesFile, 'utf8')).filter((x) => x.text);
const night = frames.filter((x) => (x.minutes >= 1110 || x.minutes <= 330) && x.L < 60);
const day = frames.filter((x) => x.minutes >= 480 && x.minutes <= 960 && x.L > 60);
const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];

function sharpness(d, w, h) {
  let lap = 0; let n = 0;
  for (let y = 71; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      const l = (xx, yy) => { const k = (yy * w + xx) * 3; return 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; };
      lap += Math.abs(4 * l(x, y) - l(x - 1, y) - l(x + 1, y) - l(x, y - 1) - l(x, y + 1)); n += 1;
    }
  }
  return lap / n;
}
function redBlue(d, w, h) { let r = 0; let b = 0; for (let y = 70; y < h; y += 4) for (let x = 0; x < w; x += 4) { r += d[(y * w + x) * 3]; b += d[(y * w + x) * 3 + 2]; } return r / b; }

const stats = [];
for (const x of day) {
  const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  stats.push({ ...features(data, info.width, info.height), lap: sharpness(data, info.width, info.height), rb: redBlue(data, info.width, info.height) });
}
const line = (label, rows) => console.log(`${label.padEnd(34)} L ${med(rows.map((r) => r.L)).toFixed(0).padStart(4)}  p10 ${med(rows.map((r) => r.p10)).toFixed(0).padStart(3)}  p90 ${med(rows.map((r) => r.p90)).toFixed(0).padStart(3)}  p99 ${med(rows.map((r) => r.p99)).toFixed(0).padStart(3)}  sat ${med(rows.map((r) => r.sat)).toFixed(1).padStart(5)}  r/b ${med(rows.map((r) => r.rb)).toFixed(2)}  sharp ${med(rows.map((r) => r.lap)).toFixed(1).padStart(5)}`);
line(`REF day (${day.length})`, stats);
const step = Math.max(1, Math.floor(night.length / maxFrames));
const pick = night.filter((_, i) => i % step === 0).slice(0, maxFrames);
const base = { ...LIFT };
for (const raw of settings.length ? settings : ['{}']) {
  Object.assign(LIFT, base, JSON.parse(raw));
  const rows = [];
  for (const x of pick) {
    const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const osd = locateOsd(data, w, h);
    if (!osd) continue;
    const r = await relight(eraseOsd(data, w, h, osd), w, h, '2026-11-07T12:00:00', { skipRect: osd });
    rows.push({ ...features(r.pixels, w, h), lap: sharpness(r.pixels, w, h), rb: redBlue(r.pixels, w, h) });
  }
  line(`${raw === '{}' ? 'current' : raw}`, rows);
}
