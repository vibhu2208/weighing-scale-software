// Dev tool: harvest OSD glyph cells from real camera frames (Test-images/).
// Note: locateOsd verifies against the current atlas, so frames must already be
// recognisable; bootstrap a new camera font by lowering MIN_STAMP_SCORE first.
import sharp from 'sharp';
import fs from 'node:fs';
import { cellMask, locateOsd } from '../src/osd.js';

const dir = process.argv[2];
const out = process.argv[3];
const cells = [];
for (const name of fs.readdirSync(dir).filter((f) => /^\d.*\.png$/.test(f))) {
  const { data, info } = await sharp(path(dir, name)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const osd = locateOsd(data, info.width, info.height);
  if (!osd) { console.log('NO OSD', name); continue; }
  for (let i = 0; i < 19; i += 1) {
    if (i === 10) continue;
    const mask = cellMask(data, info.width, info.height, osd, i);
    cells.push({ file: name, index: i, mask: Array.from(mask) });
  }
}
fs.writeFileSync(out, JSON.stringify(cells));
console.log('cells', cells.length);
function path(a, b) { return `${a}/${b}`; }
