// Dev tool: measure real camera frames by stamp time, for lighting calibration.
//   node scripts/measure-frames.mjs out.json <dir> [<dir> ...]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { locateOsd, readOsdText } from '../src/osd.js';

const [, , outFile, ...dirs] = process.argv;
const GX = 6;
const GY = 4;
const seen = new Set();
const rows = [];
for (const dir of dirs) {
  for (const name of fs.readdirSync(dir).filter((f) => /^\d{4}-(ac|dc)\d?\.png$/.test(f))) {
    const file = path.join(dir, name);
    const bytes = fs.readFileSync(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const osd = locateOsd(data, w, h);
    const text = osd ? readOsdText(data, w, h, osd) : null;
    const hist = new Uint32Array(256);
    const grid = new Float64Array(GX * GY);
    const gridN = new Float64Array(GX * GY);
    let n = 0; let sum = 0; let sat = 0; let r = 0; let g = 0; let b = 0;
    for (let y = 70; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const k = (y * w + x) * 3;
        const l = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
        hist[Math.round(l)] += 1; sum += l; n += 1;
        sat += Math.max(data[k], data[k + 1], data[k + 2]) - Math.min(data[k], data[k + 1], data[k + 2]);
        r += data[k]; g += data[k + 1]; b += data[k + 2];
        const c = Math.floor((y / h) * GY) * GX + Math.floor((x / w) * GX);
        grid[c] += l; gridN[c] += 1;
      }
    }
    const pct = (p) => { let c = 0; for (let i = 0; i < 256; i += 1) { c += hist[i]; if (c >= n * p) return i; } return 255; };
    const t = text ? +text.slice(11, 13) * 60 + +text.slice(14, 16) : null;
    rows.push({
      file, name, text, minutes: t, w, h,
      L: +(sum / n).toFixed(1), p01: pct(0.01), p10: pct(0.1), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99),
      sat: +(sat / n).toFixed(1), rb: +(r / b).toFixed(3), gb: +(g / b).toFixed(3),
      grid: Array.from(grid, (v, i) => +(v / gridN[i]).toFixed(1)),
    });
  }
}
fs.writeFileSync(outFile, JSON.stringify(rows));
console.log(`${rows.length} unique frames; time read on ${rows.filter((x) => x.text).length}; no stamp ${rows.filter((x) => !x.text).length}`);
