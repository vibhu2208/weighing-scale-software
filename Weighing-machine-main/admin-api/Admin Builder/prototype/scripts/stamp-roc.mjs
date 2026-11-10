// Dev tool: stamp detector scores on real frames against the same frames with
// the stamp cut off, to choose MIN_STAMP_SCORE.
//   node scripts/stamp-roc.mjs frames.json [extra-negative-dir]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { findOsd } from '../src/osd.js';

const [, , framesFile, extraDir] = process.argv;
const frames = JSON.parse(fs.readFileSync(framesFile, 'utf8'));
const pos = [];
const neg = [];
let ms = 0;
for (const x of frames) {
  const { data, info } = await sharp(x.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const t0 = Date.now();
  pos.push({ name: `${path.basename(path.dirname(x.file)).slice(0, 4)}/${x.name}`, ...pick(findOsd(data, info.width, info.height)) });
  ms += Date.now() - t0;
  const cut = await sharp(x.file).removeAlpha().extract({ left: 0, top: 90, width: info.width, height: info.height - 90 }).raw().toBuffer({ resolveWithObject: true });
  neg.push({ name: `cut/${x.name}`, ...pick(findOsd(cut.data, cut.info.width, cut.info.height)) });
}
if (extraDir) {
  for (const f of fs.readdirSync(extraDir).filter((n) => n.startsWith('Pasted'))) {
    const { data, info } = await sharp(path.join(extraDir, f)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    neg.push({ name: f.slice(-12), ...pick(findOsd(data, info.width, info.height)) });
  }
}
function pick(r) { return { score: r.score, polarity: r.osd?.polarity, band: r.osd?.bandHeight, pitch: r.osd?.pitch, left: r.osd?.left, top: r.osd?.top }; }
pos.sort((a, b) => a.score - b.score);
neg.sort((a, b) => b.score - a.score);
console.log('mean find ms', (ms / frames.length).toFixed(0));
console.log('lowest real:', pos.slice(0, 14).map((p) => `${p.name} ${p.score.toFixed(2)}`).join(' | '));
console.log('highest non-stamp:', neg.slice(0, 10).map((p) => `${p.name} ${p.score.toFixed(2)}`).join(' | '));
console.log('polarity:', pos.filter((p) => p.polarity === 'dark').map((p) => `${p.name} ${p.score.toFixed(2)}`).join(' | '));
for (const t of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) console.log(`threshold ${t}: real accepted ${pos.filter((p) => p.score >= t).length}/${pos.length}, non-stamp accepted ${neg.filter((p) => p.score >= t).length}/${neg.length}`);
