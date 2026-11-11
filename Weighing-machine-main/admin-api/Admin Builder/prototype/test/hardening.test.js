import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { drawOsd, locateOsd } from '../src/osd.js';
import { createBuilderWorkspace } from '../src/server.js';

const W = 800;
const H = 450;

function stampedFrame(value = 70) {
  const base = Buffer.alloc(W * H * 3, value);
  const osd = { left: 16, top: 10, right: 353, bottom: 33, bandHeight: 24, textWidth: 338, pitch: 338 / 18.8, textColor: [255, 255, 255] };
  return drawOsd(base, W, H, osd, '21-10-2026 04:19:15');
}

const dataUrl = (buffer, type = 'png') => `data:image/${type};base64,${buffer.toString('base64')}`;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ab-hard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createBuilderWorkspace({ dataRoot: root });
}

async function pngOf(pixels, channels = 3) {
  return sharp(pixels, { raw: { width: W, height: H, channels } }).png().toBuffer();
}

test('a frame without a camera stamp is rejected, never drawn on', async (t) => {
  const ws = await workspace(t);
  const plain = await pngOf(Buffer.alloc(W * H * 3, 90));
  await assert.rejects(
    ws.process({ sourceDataUrl: dataUrl(plain), datetimeLocal: '2026-10-21T12:00' }),
    (error) => error.code === 'OSD_NOT_FOUND',
  );
});

test('bright scene clutter is not mistaken for a stamp', () => {
  const noisy = Buffer.alloc(W * H * 3, 40);
  for (let y = 5; y < 40; y += 1) for (let x = 5; x < 440; x += 1) {
    if ((x * 7 + y * 13) % 5 < 2) noisy.fill(250, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  assert.equal(locateOsd(noisy, W, H), null);
});

test('processes JPEG, grayscale and RGBA sources', async (t) => {
  const ws = await workspace(t);
  const rgb = stampedFrame();
  const jpg = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  const gray = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).greyscale().png().toBuffer();
  for (const [name, url] of [
    ['jpeg', dataUrl(jpg, 'jpeg')],
    ['rgba', dataUrl(await pngOf(rgba, 4))],
    ['gray', dataUrl(gray)],
  ]) {
    const result = await ws.process({ sourceDataUrl: url, datetimeLocal: '2026-10-21T22:30' });
    assert.ok(result.output_image_base64, `${name} produced an image`);
    assert.notEqual(result.source_sha256, result.output_sha256, name);
    const meta = await sharp(Buffer.from(result.output_image_base64, 'base64')).metadata();
    assert.equal(meta.width, W);
    assert.equal(meta.height, H);
  }
});

test('process output carries provenance in the manifest and no visible label', async (t) => {
  const ws = await workspace(t);
  const result = await ws.process({
    sourceDataUrl: dataUrl(await pngOf(stampedFrame())),
    datetimeLocal: '2026-10-21T13:00',
    operatorEmail: 'admin@example.com',
  });
  assert.equal(result.manifest.synthetic_training_derivative, true);
  assert.equal(result.manifest.visible_label_on_image, false);
  assert.equal(result.manifest.processed_by, 'admin@example.com');
  assert.equal(result.manifest.original_source_modified, false);
  assert.ok(result.operations.some((o) => o.name === 'replace_inframe_timestamp'));
});

test('malformed lamps and datetimes are rejected or ignored safely', async (t) => {
  const ws = await workspace(t);
  const url = dataUrl(await pngOf(stampedFrame()));
  const ok = await ws.process({
    sourceDataUrl: url,
    datetimeLocal: '2026-10-21T23:00',
    lamps: [{ x: 'a', y: 1 }, null, { x: 100, y: 100, radius: 1e9, strength: 99 }, ...Array(40).fill({ x: 10, y: 10 })],
  });
  const glows = ok.operations.find((o) => o.name === 'adjust_lighting').parameters.lamp_glows;
  assert.ok(glows.every((g) => Number.isFinite(g.strength) && g.strength > 0));
  assert.ok(glows.length <= 12);
  assert.ok(glows.every((g) => g.radius <= W / 3 && g.strength <= 1));
  for (const bad of ['', 'garbage', '2026-13-45T99:99']) {
    await assert.rejects(ws.process({ sourceDataUrl: url, datetimeLocal: bad }));
  }
});

test('the workspace sheds load instead of queueing without bound', async (t) => {
  const ws = await workspace(t);
  const url = dataUrl(await pngOf(stampedFrame()));
  const jobs = Array.from({ length: 14 }, () =>
    ws.process({ sourceDataUrl: url, datetimeLocal: '2026-10-21T12:00' }).then(() => 'ok', (e) => e.code));
  const outcomes = await Promise.all(jobs);
  assert.ok(outcomes.includes('SERVER_BUSY'), 'excess jobs are refused');
  assert.ok(outcomes.filter((o) => o === 'ok').length >= 2, 'accepted jobs still complete');
});

test('a damaged saved manifest does not hide other saved images', async (t) => {
  const ws = await workspace(t);
  const url = dataUrl(await pngOf(stampedFrame()));
  const first = await ws.process({ sourceDataUrl: url, datetimeLocal: '2026-10-21T12:00' });
  await ws.save(first.preview_id);
  await writeFile(path.join(ws.paths.manifests, `${'a'.repeat(32)}.json`), '{ not json');
  const saved = await ws.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, first.preview_id);
});

test('saved ids cannot escape the storage folders', async (t) => {
  const ws = await workspace(t);
  await assert.rejects(ws.readSaved('../../etc/passwd'));
  await assert.rejects(ws.deleteSaved(['../x']));
  await assert.rejects(ws.save('../x'));
});

test('real frames with a cluttered background behind the stamp are still recognised (skipped when absent)', async (t) => {
  const { existsSync } = await import('node:fs');
  const files = ['3515-dc2.png', '7668-dc1.png'].map((f) => path.join(os.homedir(), 'Downloads', f)).filter(existsSync);
  if (!files.length) return t.skip('private camera frames not present');
  for (const file of files) {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.ok(locateOsd(data, info.width, info.height), `${path.basename(file)} stamp found`);
  }
});

test('night relight of a real day frame matches the paired night references (skipped when absent)', async (t) => {
  const { existsSync } = await import('node:fs');
  const { relight } = await import('../src/relight.js');
  const file = path.join(os.homedir(), 'Downloads', '5649-ac1.png');
  if (!existsSync(file)) return t.skip('private camera frame not present');
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const night = await relight(data, info.width, info.height, '2026-11-06T00:59:02', { skipRect: { left: 0, right: 460, top: 0, bottom: 60 } });
  const lumas = [];
  for (let i = 0; i < night.pixels.length; i += 3 * 7) {
    lumas.push(0.2126 * night.pixels[i] + 0.7152 * night.pixels[i + 1] + 0.0722 * night.pixels[i + 2]);
  }
  lumas.sort((a, b) => a - b);
  const pct = (p) => lumas[Math.floor(lumas.length * p)];
  // Paired references: mean 14-27, p50 8-25, p99 66-114.
  assert.ok(night.parameters.output_mean_luminance >= 14 && night.parameters.output_mean_luminance <= 28);
  assert.ok(pct(0.5) >= 8 && pct(0.5) <= 25);
  assert.ok(pct(0.99) >= 55 && pct(0.99) <= 120, `p99 ${pct(0.99)}`);
});
