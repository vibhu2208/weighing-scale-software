// Dev tool: relight many reference frames to many clock times and compare every
// result with the reference frames of the matching class.
//   node scripts/validate-matrix.mjs frames.json [max-frames] [out.json]
// Class labels come from each frame's own stamp time: dark 18:30-05:30, day
// 07:00-17:00. Reports, per target time, how many outputs fall outside the 5th-95th
// percentile of the references on each feature (about 10% would for real frames).
import fs from 'node:fs';
import sharp from 'sharp';
import { eraseOsd, locateOsd } from '../src/osd.js';
import { relight } from '../src/relight.js';
import { features } from './frame-features.mjs';

const [, , framesFile, maxArg, outFile] = process.argv;
const maxFrames = Number(maxArg) || 30;
const frames = JSON.parse(fs.readFileSync(framesFile, 'utf8')).filter((x) => x.text);
const label = (m) => (m >= 1110 || m <= 330 ? 'night' : m >= 420 && m <= 1020 ? 'day' : null);

const KEYS = ['L', 'p10', 'p50', 'p90', 'p99', 'dark', 'bright', 'topbot', 'sat'];
const quant = (arr, p) => { const v = [...arr].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };

const refs = { night: [], day: [] };
const sources = [];
for (const x of frames) {
  const l = label(x.minutes);
  if (!l) continue;
  const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  refs[l].push(features(data, info.width, info.height));
  sources.push({ x, l });
}
const range = Object.fromEntries(Object.entries(refs).map(([c, rows]) => [c, Object.fromEntries(KEYS.map((k) => [k, [quant(rows.map((r) => r[k]), 0.05), quant(rows.map((r) => r[k]), 0.95)]]))]));
console.log(`references: night ${refs.night.length}, day ${refs.day.length}`);
for (const c of ['night', 'day']) console.log(` ${c} 5-95%:`, KEYS.map((k) => `${k} ${range[c][k][0].toFixed(2)}-${range[c][k][1].toFixed(2)}`).join('  '));

const step = Math.max(1, Math.floor(sources.length / maxFrames));
const pick = sources.filter((_, i) => i % step === 0).slice(0, maxFrames);
const times = ['06:00', '06:30', '08:58', '12:00', '16:00', '17:45', '18:15', '18:30', '19:30', '22:00', '03:00', '05:20', '05:45'];
const rows = [];
for (const { x, l } of pick) {
  const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const osd = locateOsd(data, w, h);
  if (!osd) continue;
  const erased = eraseOsd(data, w, h, osd);
  for (const t of times) {
    const r = await relight(erased, w, h, `2026-11-07T${t}:00`, { skipRect: osd });
    rows.push({ name: x.name, src: l, srcText: x.text.slice(11), time: t, nightness: r.parameters.source_nightness, ...features(r.pixels, w, h) });
  }
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(rows));

const targetClass = (t) => { const m = +t.slice(0, 2) * 60 + +t.slice(3); return m >= 1110 || m <= 330 ? 'night' : m >= 480 && m <= 960 ? 'day' : null; };
console.log('\n time  class  n   outside 5-95% of references, by feature (count)                       mean L (target)');
for (const t of times) {
  const c = targetClass(t);
  const rs = rows.filter((r) => r.time === t);
  const meanL = rs.reduce((a, r) => a + r.L, 0) / Math.max(rs.length, 1);
  if (!c) { console.log(` ${t}  ramp   ${String(rs.length).padStart(2)}  (no class)${' '.repeat(60)}${meanL.toFixed(1)}`); continue; }
  const out = KEYS.map((k) => {
    const [lo, hi] = range[c][k];
    const low = rs.filter((r) => r[k] < lo).length;
    const high = rs.filter((r) => r[k] > hi).length;
    return low || high ? `${k} ${low ? `<${low}` : ''}${high ? `>${high}` : ''}` : null;
  }).filter(Boolean);
  console.log(` ${t}  ${c.padEnd(5)}  ${String(rs.length).padStart(2)}  ${out.join('  ') || 'all within range'}`.padEnd(98) + meanL.toFixed(1));
}
// Worst individual cases: farthest outside the class range, normalised by range width.
const worst = [];
for (const r of rows) {
  const c = targetClass(r.time);
  if (!c) continue;
  let bad = 0; let which = '';
  for (const k of ['L', 'p10', 'p50', 'p90', 'dark', 'topbot']) {
    const [lo, hi] = range[c][k];
    const span = Math.max(hi - lo, 1e-6);
    const e = r[k] < lo ? (lo - r[k]) / span : r[k] > hi ? (r[k] - hi) / span : 0;
    if (e > bad) { bad = e; which = `${k}=${r[k].toFixed(2)} (ref ${lo.toFixed(2)}-${hi.toFixed(2)})`; }
  }
  if (bad > 0.35) worst.push({ bad, text: `${r.name} (${r.src} ${r.srcText}) -> ${r.time} ${c}: ${which}` });
}
worst.sort((a, b) => b.bad - a.bad);
console.log(`\nworst cases (${worst.length} outputs more than 35% of the reference range outside it):`);
for (const w of worst.slice(0, 25)) console.log(' ', w.bad.toFixed(2), w.text);
