// Dev tool: compare relit output against reference frames, region by region.
//   node scripts/validate-relight.mjs frames.json [sheet-dir]
// frames.json comes from measure-frames.mjs.
import fs from 'node:fs';
import sharp from 'sharp';
import { drawOsd, eraseOsd, formatOsdText, locateOsd } from '../src/osd.js';
import { relight } from '../src/relight.js';

const [, , framesFile, sheetDir] = process.argv;
const frames = JSON.parse(fs.readFileSync(framesFile, 'utf8')).filter((x) => x.text);
const isNight = (x) => (x.minutes >= 1140 || x.minutes <= 300) && x.L < 60;
const isDay = (x) => x.minutes >= 480 && x.minutes <= 960 && x.L > 60;
const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];

function measure(d, w, h) {
  const hist = new Uint32Array(256);
  const grid = new Float64Array(24);
  const gridN = new Float64Array(24);
  let n = 0; let s = 0; let sat = 0; let r = 0; let b = 0; let lap = 0; let lapN = 0;
  const L = (x, y) => { const k = (y * w + x) * 3; return 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; };
  for (let y = 70; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      const k = (y * w + x) * 3;
      const l = L(x, y);
      hist[Math.round(l)] += 1; s += l; n += 1;
      sat += Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]);
      r += d[k]; b += d[k + 2];
      const c = Math.floor((y / h) * 4) * 6 + Math.floor((x / w) * 6);
      grid[c] += l; gridN[c] += 1;
      if (y > 1) { lap += Math.abs(4 * l - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1)); lapN += 1; }
    }
  }
  const pct = (p) => { let c = 0; for (let i = 0; i < 256; i += 1) { c += hist[i]; if (c >= n * p) return i; } return 255; };
  const mean = s / n;
  return { L: mean, p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), sat: sat / n, rb: r / b, lap: lap / lapN, grid: Array.from(grid, (v, i) => v / gridN[i] / mean) };
}

async function load(x) {
  const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

async function summarise(label, list, fn) {
  const rows = [];
  for (const x of list) {
    const row = await fn(x);
    if (row) rows.push(row);
  }
  const pick = (k) => med(rows.map((r) => r[k])).toFixed(k === 'rb' ? 2 : k === 'L' || k === 'sat' || k === 'lap' ? 1 : 0);
  console.log(`${label.padEnd(22)} n${String(rows.length).padStart(3)} L ${pick('L').padStart(5)} p10 ${pick('p10').padStart(3)} p50 ${pick('p50').padStart(3)} p90 ${pick('p90').padStart(3)} p99 ${pick('p99').padStart(3)} sat ${pick('sat').padStart(5)} r/b ${pick('rb')} sharp ${pick('lap').padStart(5)}`);
  const g = new Array(24).fill(0);
  for (const r of rows) r.grid.forEach((v, i) => { g[i] += v / rows.length; });
  for (let y = 0; y < 4; y += 1) console.log(`    ${g.slice(y * 6, y * 6 + 6).map((v) => v.toFixed(2)).join(' ')}`);
}

const realNight = frames.filter(isNight);
const realDay = frames.filter(isDay);
const relit = (time) => async (x) => {
  const { data, w, h } = await load(x);
  const osd = locateOsd(data, w, h);
  if (!osd) return null;
  const r = await relight(eraseOsd(data, w, h, osd), w, h, time, { skipRect: osd });
  return measure(r.pixels, w, h);
};
await summarise('REF night', realNight, async (x) => { const { data, w, h } = await load(x); return measure(data, w, h); });
await summarise('day->night 22:00', realDay, relit('2026-11-06T22:00:00'));
await summarise('REF day', realDay, async (x) => { const { data, w, h } = await load(x); return measure(data, w, h); });
await summarise('night->day 12:00', realNight, relit('2026-11-06T12:00:00'));
await summarise('day->day 12:00', realDay, relit('2026-11-06T12:00:00'));

if (sheetDir) {
  const sheet = async (name, list, time) => {
    const tiles = [];
    for (const x of list) {
      const { data, w, h } = await load(x);
      const osd = locateOsd(data, w, h);
      if (!osd) continue;
      const r = await relight(eraseOsd(data, w, h, osd), w, h, time, { skipRect: osd });
      const fin = drawOsd(r.pixels, w, h, osd, formatOsdText(time));
      tiles.push(await sharp(fin, { raw: { width: w, height: h, channels: 3 } }).resize(400, 240, { fit: 'fill' }).png().toBuffer());
    }
    await sharp({ create: { width: 1600, height: 240 * Math.ceil(tiles.length / 4), channels: 3, background: '#000' } })
      .composite(tiles.map((b, i) => ({ input: b, left: (i % 4) * 400, top: Math.floor(i / 4) * 240 })))
      .png().toFile(`${sheetDir}/${name}.png`);
  };
  const dayPick = realDay.filter((_, i) => i % 3 === 0).slice(0, 8);
  const nightPick = realNight.filter((_, i) => i % 7 === 0).slice(0, 8);
  await sheet('day-to-night', dayPick, '2026-11-06T22:00:00');
  await sheet('night-to-day', nightPick, '2026-11-06T12:00:00');
}
