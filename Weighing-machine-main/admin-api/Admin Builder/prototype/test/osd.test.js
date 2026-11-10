import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { drawOsd, eraseOsd, formatOsdText, locateOsd } from '../src/osd.js';
import { ambienceForTime, relight } from '../src/relight.js';

const W = 640;
const H = 360;

function frame(value = 40) {
  const pixels = Buffer.alloc(W * H * 3, value);
  return pixels;
}

// Synthetic stamp laid out like the camera's (pitch 18, band 24).
function frameWithStamp(text) {
  const base = frame();
  const osd = { left: 16, top: 10, right: 16 + 337, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8, textColor: [255, 255, 255] };
  return { pixels: drawOsd(base, W, H, osd, text), osd };
}

test('locates, erases and redraws a camera-style stamp', () => {
  const { pixels } = frameWithStamp('21-10-2026 04:19:15');
  const found = locateOsd(pixels, W, H);
  assert.ok(found, 'stamp should be found');
  assert.ok(Math.abs(found.left - 16) <= 2);
  const erased = eraseOsd(pixels, W, H, found);
  assert.equal(locateOsd(erased, W, H), null, 'no bright stamp should remain after erase');
  const redrawn = drawOsd(erased, W, H, found, formatOsdText('2026-10-21T13:00:00'));
  assert.notDeepEqual(redrawn, pixels);
  assert.ok(locateOsd(redrawn, W, H));
});

test('no readable ghost of the old stamp survives a lift to daylight', async () => {
  const dark = Buffer.alloc(W * H * 3, 6);
  const osd = { left: 16, top: 10, right: 353, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8, textColor: [255, 255, 255] };
  const stamped = await sharp(drawOsd(dark, W, H, osd, '21-10-2026 04:19:15'), { raw: { width: W, height: H, channels: 3 } })
    .blur(0.9).raw().toBuffer();
  const found = locateOsd(stamped, W, H);
  assert.ok(found);
  const erased = eraseOsd(stamped, W, H, found);
  let worst = 0;
  for (let y = found.top; y <= found.bottom; y += 1) {
    for (let x = found.left; x <= found.right; x += 1) worst = Math.max(worst, erased[(y * W + x) * 3] - 6);
  }
  assert.ok(worst <= 6, `residual ${worst} would be magnified by a lift`);
});

test('finds white text whatever is behind it, and black text on a bright sky', () => {
  const osd = { left: 16, top: 10, right: 353, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8 };
  const text = '21-10-2026 04:19:15';
  const cases = [
    { name: 'white on dark', bg: 30, color: [255, 255, 255], polarity: 'light' },
    { name: 'dim grey on dark', bg: 15, color: [165, 165, 165], polarity: 'light' },
    { name: 'outlined white on bright', bg: 215, color: [255, 255, 255], polarity: 'light' },
    { name: 'black on bright', bg: 205, color: [5, 5, 5], polarity: 'dark' },
  ];
  for (const { name, bg, color, polarity } of cases) {
    const stamped = drawOsd(Buffer.alloc(W * H * 3, bg), W, H, { ...osd, textColor: color, polarity }, text);
    const found = locateOsd(stamped, W, H);
    assert.ok(found, `${name}: stamp found`);
    assert.equal(found.polarity, polarity, `${name}: polarity`);
    assert.ok(Math.abs(found.left - osd.left) <= 3, `${name}: left ${found.left}`);
    assert.ok(Math.abs(found.pitch - osd.pitch) <= 0.6, `${name}: pitch ${found.pitch}`);
    const erased = eraseOsd(stamped, W, H, found);
    let worst = 0;
    for (let y = osd.top; y <= osd.bottom; y += 1) {
      for (let x = osd.left; x <= osd.right; x += 1) worst = Math.max(worst, Math.abs(erased[(y * W + x) * 3] - bg));
    }
    assert.ok(worst <= 12, `${name}: residual ${worst}`);
  }
});

test('white text gets a dark outline over bright scenery and black text does not', () => {
  const osd = { left: 16, top: 10, right: 353, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8, textColor: [255, 255, 255] };
  const bright = Buffer.alloc(W * H * 3, 200);
  const darkest = (buffer) => {
    let low = 255;
    for (let y = osd.top; y <= osd.bottom; y += 1) {
      for (let x = osd.left; x <= osd.right; x += 1) low = Math.min(low, buffer[(y * W + x) * 3]);
    }
    return low;
  };
  assert.ok(darkest(drawOsd(bright, W, H, osd, '21-10-2026 04:19:15')) < 100, 'white text is outlined');
  const black = drawOsd(bright, W, H, { ...osd, polarity: 'dark', textColor: [5, 5, 5] }, '21-10-2026 04:19:15');
  assert.ok(black[((osd.top - 2) * W + osd.left + 40) * 3] === 200, 'black text has no halo above it');
});

test('formats the requested time in the camera layout', () => {
  assert.equal(formatOsdText('2026-10-21T03:05'), '21-10-2026 03:05:00');
  assert.throws(() => formatOsdText('nonsense'));
});

test('relight darkens for night, brightens for day and keeps the stamp area out of the mean', async () => {
  const bright = frame(120);
  const night = await relight(bright, W, H, '2026-10-21T02:00:00');
  const day = await relight(frame(40), W, H, '2026-10-21T12:00:00');
  assert.ok(night.parameters.output_mean_luminance < 40, 'night output is dark');
  assert.ok(day.parameters.output_mean_luminance > 80, 'day output is bright');
  assert.ok(ambienceForTime('2026-10-21T12:00:00').L > ambienceForTime('2026-10-21T02:00:00').L);
});

test('the schedule is fully dark 18:30-05:30 and daylit otherwise', () => {
  const at = (t) => ambienceForTime(`2026-11-07T${t}:00`);
  for (const t of ['18:30', '19:00', '21:00', '23:59', '00:00', '03:00', '05:30']) {
    assert.equal(at(t).night, 1, `${t} is fully dark`);
    assert.ok(at(t).L <= 27, `${t} target is dark`);
  }
  for (const t of ['06:00', '07:00', '08:00', '12:00', '16:00', '18:00']) {
    assert.equal(at(t).night, 0, `${t} is daylit`);
    assert.ok(at(t).L >= 60, `${t} target is bright`);
  }
  assert.ok(at('12:00').L > at('17:30').L, 'late afternoon is dimmer than midday');
  assert.ok(at('18:15').night > 0 && at('18:15').night < 1, 'dusk ramp');
  assert.ok(at('05:45').night > 0 && at('05:45').night < 1, 'dawn ramp');
});

test('night light falls away from the foreground toward the top corners', async () => {
  const flat = frame(120);
  const night = await relight(flat, W, H, '2026-11-07T22:00:00');
  const at = (x, y) => night.pixels[(y * W + x) * 3 + 1];
  assert.ok(at(8, 8) * 2 < at(W >> 1, H - 8), 'corner is much darker than the foreground');
  const day = await relight(flat, W, H, '2026-11-07T12:00:00');
  assert.equal(day.pixels[(8 * W + 8) * 3 + 1], day.pixels[((H - 8) * W + (W >> 1)) * 3 + 1], 'no falloff by day');
});

test('night keeps colour and does not turn bright litter into glitter', async () => {
  // A mid-grey frame with one saturated blue block and small white specks.
  const px = Buffer.alloc(W * H * 3, 90);
  for (let y = 100; y < 200; y += 1) {
    for (let x = 100; x < 300; x += 1) {
      const o = (y * W + x) * 3;
      px[o] = 20; px[o + 1] = 60; px[o + 2] = 200;
    }
  }
  for (let y = 250; y < 340; y += 12) {
    for (let x = 100; x < 500; x += 12) px.fill(250, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const { pixels, parameters } = await relight(px, W, H, '2026-11-07T22:00:00');
  const o = (150 * W + 200) * 3;
  assert.ok(pixels[o + 2] > pixels[o] * 2.5, 'blue stays blue');
  const speck = pixels[(250 * W + 100) * 3 + 1];
  const around = pixels[(256 * W + 106) * 3 + 1];
  assert.ok(speck / around < 5, `speck ${speck} against ground ${around}`);
  assert.ok(parameters.output_mean_luminance >= 16 && parameters.output_mean_luminance <= 28);
});

test('open sky goes dark at night, and the same brightness lower in the frame does not', async () => {
  const px = Buffer.alloc(W * H * 3, 70);
  for (let y = 0; y < 120; y += 1) px.fill(205, y * W * 3, (y + 1) * W * 3);
  for (let y = 250; y < 320; y += 1) {
    for (let x = 250; x < 400; x += 1) px.fill(205, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const { pixels, parameters } = await relight(px, W, H, '2026-11-07T22:00:00');
  assert.equal(parameters.open_sky_darkened, true);
  const sky = pixels[(40 * W + 320) * 3 + 1];
  const patch = pixels[(285 * W + 320) * 3 + 1];
  assert.ok(sky < patch * 0.35, `sky ${sky} against patch ${patch}`);
});

test('a saturated wall touching the top edge is not treated as sky', async () => {
  const px = Buffer.alloc(W * H * 3, 70);
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 3;
      px[o] = 30; px[o + 1] = 110; px[o + 2] = 200;
    }
  }
  const { parameters } = await relight(px, W, H, '2026-11-07T22:00:00');
  assert.equal(parameters.open_sky_darkened, false);
});

test('night-to-day light flattening lifts the dark side, not an unrelated part of the frame', async () => {
  // Left half dark, right half darker: both must rise, and keep their order.
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) px.fill(x < W / 2 ? 34 : 12, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const { pixels } = await relight(px, W, H, '2026-11-07T12:00:00');
  const row = (y) => [pixels[(y * W + 80) * 3 + 1], pixels[(y * W + 560) * 3 + 1]];
  for (const y of [40, 180, 320]) {
    const [left, right] = row(y);
    assert.ok(right > 12 && left > right, `row ${y}: left ${left}, right ${right}`);
  }
  // Same at every height: a misread map would vary by row.
  assert.ok(Math.abs(row(40)[1] - row(320)[1]) < 40, `rows ${row(40)[1]} and ${row(320)[1]}`);
});

test('black stamp text turns light when the relit background is dark', () => {
  const osd = { left: 16, top: 10, right: 353, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8, textColor: [5, 5, 5], polarity: 'dark' };
  const peak = (buffer) => {
    let high = 0;
    for (let y = osd.top; y <= osd.bottom; y += 1) {
      for (let x = osd.left; x <= osd.right; x += 1) high = Math.max(high, buffer[(y * W + x) * 3]);
    }
    return high;
  };
  assert.ok(peak(drawOsd(Buffer.alloc(W * H * 3, 25), W, H, osd, '21-10-2026 04:19:15')) > 200);
});

test('a floodlit night frame is still a night source, so it converts fully to daylight', async () => {
  // Mean ~52 like the real 03:01 floodlit frame, but with most of the frame black.
  const px = Buffer.alloc(W * H * 3, 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W * 0.45; x += 1) px.fill(112, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const { parameters } = await relight(px, W, H, '2026-11-07T08:58:49');
  assert.ok(parameters.source_nightness > 0.85, `source_nightness ${parameters.source_nightness}`);
  assert.ok(parameters.output_mean_luminance >= 90, `mean ${parameters.output_mean_luminance}`);
});

test('a dim but evenly lit afternoon frame is a day source, not night', async () => {
  const px = Buffer.alloc(W * H * 3, 52);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) px.fill(40 + ((x * 5 + y * 3) % 40), (y * W + x) * 3, (y * W + x) * 3 + 3);
  const { parameters } = await relight(px, W, H, '2026-11-07T22:00:00');
  assert.ok(parameters.source_nightness < 0.2, `source_nightness ${parameters.source_nightness}`);
});

test('lifting a night frame to day keeps lit lamps solid, with no dark hole at the centre', async () => {
  const px = Buffer.alloc(W * H * 3, 10);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = Math.hypot(x - 320, y - 220);
      const v = d < 14 ? 255 : d < 40 ? 70 + (40 - d) * 4 : 10;
      px.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
    }
  }
  const { pixels } = await relight(px, W, H, '2026-11-07T12:00:00');
  const at = (x, y) => pixels[(y * W + x) * 3 + 1];
  assert.ok(at(320, 220) >= at(320, 220 + 28) * 0.9, `centre ${at(320, 220)} against ring ${at(320, 248)}`);
  assert.ok(at(320, 220) >= 150, `lamp centre ${at(320, 220)} must stay bright`);
});

test('night to day lights the dark background as much as the foreground', async () => {
  // Foreground pool lit (mean ~60), the upper third almost black, like a floodlit
  // night frame: a day version must not leave that upper third murky.
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = y < H / 3 ? 3 + ((x * 7 + y * 3) % 4) : 55 + ((x * 5 + y * 11) % 14);
      px[(y * W + x) * 3] = v + 3; px[(y * W + x) * 3 + 1] = v + 1; px[(y * W + x) * 3 + 2] = v;
    }
  }
  const { pixels, parameters } = await relight(px, W, H, '2026-11-07T12:00:00');
  const meanOf = (y0, y1) => {
    let sum = 0; let n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = 0; x < W; x += 2) { sum += pixels[(y * W + x) * 3 + 1]; n += 1; }
    return sum / n;
  };
  const upper = meanOf(70, Math.floor(H / 3) - 10);
  const lower = meanOf(Math.floor(H / 2), H - 10);
  assert.ok(parameters.source_nightness > 0.85);
  // Reference day frames: top-to-bottom brightness ratio 0.48-1.37 (5th-95th percentile).
  assert.ok(upper >= 0.48 * lower, `upper ${upper.toFixed(0)} against lower ${lower.toFixed(0)}`);
  assert.ok(upper >= 55, `upper ${upper.toFixed(0)} is still murky`);
});

test('a lifted night frame does not turn noise into coloured confetti', async () => {
  const px = Buffer.alloc(W * H * 3);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < W * H; i += 1) {
    px[i * 3] = Math.floor(rnd() * 7); px[i * 3 + 1] = Math.floor(rnd() * 7); px[i * 3 + 2] = Math.floor(rnd() * 7);
  }
  const { pixels } = await relight(px, W, H, '2026-11-07T12:00:00');
  let chroma = 0; let n = 0;
  for (let y = 80; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const o = (y * W + x) * 3;
    chroma += Math.max(pixels[o], pixels[o + 1], pixels[o + 2]) - Math.min(pixels[o], pixels[o + 1], pixels[o + 2]);
    n += 1;
  }
  assert.ok(chroma / n < 14, `mean chroma ${(chroma / n).toFixed(1)} on pure noise`);
});

test('operator-placed lamps glow only at night', async () => {
  const dark = frame(30);
  const night = await relight(dark, W, H, '2026-10-21T23:00:00', { lamps: [{ x: 300, y: 200, radius: 30, strength: 1 }] });
  const day = await relight(dark, W, H, '2026-10-21T12:00:00', { lamps: [{ x: 300, y: 200, radius: 30, strength: 1 }] });
  const at = (b) => b[(200 * W + 300) * 3];
  assert.ok(at(night.pixels) > 200);
  assert.equal(day.parameters.lamp_glows.length, 0);
});

test('output of a relit frame still encodes as a PNG of the same size', async () => {
  const r = await relight(frame(90), W, H, '2026-10-21T19:30:00');
  const png = await sharp(r.pixels, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, W);
  assert.equal(meta.height, H);
});
