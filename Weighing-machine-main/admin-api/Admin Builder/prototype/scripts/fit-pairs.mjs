// Dev tool: fit the day-to-night transform from before/after frames of one scene.
//   node scripts/fit-pairs.mjs <day.png>:<night.png> [...]
// Quantile matching, so the two frames need not be pixel-aligned.
import sharp from 'sharp';

const Q = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.995];
const GX = 6;
const GY = 4;

async function measure(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const lumas = [];
  const grid = new Float64Array(GX * GY);
  const gridN = new Float64Array(GX * GY);
  let r = 0; let g = 0; let b = 0; let sat = 0;
  for (let y = 70; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const k = (y * w + x) * 3;
      const l = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
      lumas.push(l);
      r += data[k]; g += data[k + 1]; b += data[k + 2];
      sat += Math.max(data[k], data[k + 1], data[k + 2]) - Math.min(data[k], data[k + 1], data[k + 2]);
      const c = Math.floor((y / h) * GY) * GX + Math.floor((x / w) * GX);
      grid[c] += l; gridN[c] += 1;
    }
  }
  const mean = lumas.reduce((p, q) => p + q, 0) / lumas.length;
  lumas.sort((p, q) => p - q);
  return {
    q: Q.map((p) => lumas[Math.floor(lumas.length * p)]),
    mean, rg: r / g, bg: b / g, relSat: sat / lumas.length / mean,
    grid: Array.from(grid, (v, i) => v / gridN[i] / mean),
  };
}

const rows = [];
for (const arg of process.argv.slice(2)) {
  const [dayFile, nightFile] = arg.split(':');
  const d = await measure(dayFile);
  const n = await measure(nightFile);
  rows.push({ d, n });
  console.log(`\n${dayFile.split('/').slice(-2).join('/')} -> ${nightFile.split('/').slice(-2).join('/')}`);
  console.log(`mean ${d.mean.toFixed(1)} -> ${n.mean.toFixed(1)}  r/g ${d.rg.toFixed(3)} -> ${n.rg.toFixed(3)}  b/g ${d.bg.toFixed(3)} -> ${n.bg.toFixed(3)}  sat/mean ${d.relSat.toFixed(3)} -> ${n.relSat.toFixed(3)}`);
  console.log('quantile map (day->night):', Q.map((p, i) => `${(p * 100).toFixed(1)}%:${d.q[i].toFixed(0)}->${n.q[i].toFixed(0)}`).join(' '));
  const slopes = [];
  for (let i = 2; i < 8; i += 1) slopes.push(Math.log(n.q[i + 1] / Math.max(n.q[i], 1)) / Math.log(d.q[i + 1] / Math.max(d.q[i], 1)));
  console.log('local gamma:', slopes.map((v) => v.toFixed(2)).join(' '));
  console.log('region ratio (night/day, each over its own mean):');
  for (let y = 0; y < GY; y += 1) console.log('  ', Array.from({ length: GX }, (_, x) => (n.grid[y * GX + x] / d.grid[y * GX + x]).toFixed(2)).join(' '));
}
const avg = (f) => rows.reduce((p, r) => p + f(r), 0) / rows.length;
console.log('\nAVERAGE');
console.log('r/g gain', avg((r) => r.n.rg / r.d.rg).toFixed(3), 'b/g gain', avg((r) => r.n.bg / r.d.bg).toFixed(3), 'sat/mean ratio', avg((r) => r.n.relSat / r.d.relSat).toFixed(3));
console.log('quantile map, each normalised by its own mean:');
console.log(Q.map((p, i) => `${(p * 100).toFixed(1)}%: ${avg((r) => r.d.q[i] / r.d.mean).toFixed(2)} -> ${avg((r) => r.n.q[i] / r.n.mean).toFixed(2)}`).join('\n'));
