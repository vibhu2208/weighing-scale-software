// Dev tool: build src/osd-atlas.json (camera glyph templates) from labelled
// real-camera cells produced by collect-osd-cells.mjs.
//   node scripts/collect-osd-cells.mjs ../Test-images cells.json
//   node scripts/build-osd-atlas.mjs cells.json
// Labels were read by eye from the frames; the date on every sample is 21-10-2026.
import fs from 'node:fs';
import { ATLAS_W, ATLAS_H } from '../src/osd.js';

const LABELS = {
  '3515-ac1.png': '04:19:15', '3515-ac2.png': '04:19:15', '3515-dc1.png': '06:25:50',
  '3696-ac1.png': '15:31:32', '3696-ac2.png': '15:31:32', '3748-ac1.png': '14:02:42',
  '3748-ac2.png': '14:02:42', '3748-dc1.png': '16:03:25', '4968-ac1.png': '00:43:27',
  '4968-dc2.png': '03:55:49', '5649-ac2.png': '15:59:34', '5649-dc2.png': '18:03:50',
  '6215-ac1.png': '01:18:44', '6215-ac2.png': '01:18:44', '6215-dc1.png': '03:21:45',
  '7668-ac2.png': '13:53:53', '7668-dc1.png': '16:05:04', '7668-dc2.png': '16:05:04',
  '8715-ac1.png': '18:31:01', '8715-ac2.png': '18:31:01', '8715-dc1.png': '20:44:45',
  '8715-dc2.png': '20:44:45', '8815-ac1.png': '14:19:25', '8815-ac2.png': '14:19:25',
  '8815-dc2.png': '16:44:33',
};
const FULL = (t) => `21-10-2026 ${t}`;
const cells = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const groups = {};
for (const c of cells) {
  const t = LABELS[c.file];
  if (!t) continue;
  const ch = FULL(t)[c.index];
  (groups[ch] ??= []).push(c.mask);
}
const glyphs = {};
for (const [ch, masks] of Object.entries(groups)) {
  const mask = new Array(ATLAS_W * ATLAS_H);
  for (let k = 0; k < mask.length; k += 1) {
    const v = masks.map((m) => m[k]).sort((a, b) => a - b);
    // Upper-middle quantile keeps thin strokes that blur in some frames.
    const raw = v[Math.floor(v.length * 0.6)];
    // Levels: crush the scene haze behind the glyph, keep anti-aliased edges.
    const t = Math.max(0, Math.min(1, (raw - 0.32) / 0.5));
    mask[k] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  glyphs[ch] = { samples: masks.length, mask };
}
console.log(Object.entries(glyphs).map(([c, g]) => `${c}:${g.samples}`).join(' '));
const need = '0123456789-:'.split('').filter((c) => !glyphs[c]);
if (need.length) throw new Error(`missing glyphs: ${need}`);
fs.writeFileSync(new URL('../src/osd-atlas.json', import.meta.url), JSON.stringify({ atlas_w: ATLAS_W, atlas_h: ATLAS_H, glyphs }));
