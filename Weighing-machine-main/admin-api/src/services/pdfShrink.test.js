'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { shrinkReportPdf } = require('./pdfShrink');


/**
 * Smooth shapes carrying fine sensor grain, the way a camera frame does: Flate
 * barely compresses it while JPEG does well, which is the whole point of the
 * rewrite. Pure noise or a pure gradient would compress the same either way.
 */
function photoLikePixels(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base =
        128 +
        60 * Math.sin((x / width) * 6) * Math.cos((y / height) * 4) +
        40 * Math.sin((x + y) / 90);
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = base + channel * 9 + (random() - 0.5) * 26;
        pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return pixels;
}

/** A Chrome-produced PDF holding one photo, the shape reportPdfService emits. */
async function renderPdfWithPhoto() {
  // 1621x962 like the site cameras: its aspect does not match the 200x120 cell,
  // so object-fit: cover makes Chrome crop and re-encode to Flate, which is the
  // case this pass exists for. An exact 5:3 image would be passed through as
  // JPEG and left alone.
  const photo = await sharp(photoLikePixels(1621, 962), {
    raw: { width: 1621, height: 962, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <style>.cell{width:200px;height:120px;overflow:hidden}.cell img{width:100%;height:100%;object-fit:cover}</style>
    </head><body><div class="cell"><img src="data:image/jpeg;base64,${photo.toString('base64')}"/></div></body></html>`;

  const file = path.join(os.tmpdir(), `pdfshrink-test-${process.pid}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${file}`, { waitUntil: 'networkidle0' });
    return Buffer.from(
      await page.pdf({
        printBackground: true,
        width: '8.27in',
        height: '11.69in',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        preferCSSPageSize: true,
      }),
    );
  } finally {
    await browser.close();
    fs.unlinkSync(file);
  }
}

function imageDimensions(pdf) {
  return [
    ...pdf
      .toString('latin1')
      .matchAll(/\/Subtype\s*\/Image[\s\S]{0,120}?\/Width\s+(\d+)[\s\S]{0,80}?\/Height\s+(\d+)/g),
  ].map((m) => `${m[1]}x${m[2]}`);
}

test('re-encodes Chrome\'s Flate photo streams as JPEG without resizing them', async () => {
  const before = await renderPdfWithPhoto();
  assert.match(before.toString('latin1'), /\/Filter\s*\/FlateDecode/);

  const after = await shrinkReportPdf(before);

  assert.ok(after.length < before.length / 3, `expected a big drop, got ${before.length} -> ${after.length}`);
  assert.match(after.toString('latin1'), /\/Filter\s*\/DCTDecode/);
  assert.deepStrictEqual(imageDimensions(after), imageDimensions(before));
  assert.ok(after.toString('latin1').startsWith('%PDF-'));
  assert.match(after.toString('latin1'), /startxref\n\d+\n%%EOF/);
});

test('xref offsets in the rewritten file point at their objects', async () => {
  const after = await shrinkReportPdf(await renderPdfWithPhoto());
  const text = after.toString('latin1');
  const start = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.strictEqual(text.slice(start, start + 4), 'xref');
  const rows = text.slice(start).split('\n').slice(2);
  let checked = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = /^(\d{10}) \d{5} n $/.exec(rows[i]);
    if (!row) continue;
    const offset = Number(row[1]);
    if (offset === 0) continue;
    // Row 0 of the table is object 0 (the free head), so row i is object i.
    assert.match(text.slice(offset, offset + 24), new RegExp(`^${i}\\s+\\d+\\s+obj`));
    checked += 1;
  }
  assert.ok(checked > 3, 'expected several object offsets to verify');
});

test('leaves anything it does not fully understand untouched', async () => {
  const garbage = Buffer.alloc(4096, 0x41);
  assert.strictEqual(await shrinkReportPdf(garbage), garbage);

  const tiny = Buffer.from('%PDF-1.4\nnot really a pdf\n');
  assert.strictEqual(await shrinkReportPdf(tiny), tiny);

  const encrypted = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<</Encrypt 2 0 R /Root 3 0 R>>\nendobj\n`),
    Buffer.alloc(2048, 0x20),
  ]);
  assert.strictEqual(await shrinkReportPdf(encrypted), encrypted);
});

// ---- hardening: each case below pins a defect found in audit -----------------

test('indirect /Length (N G R) is not mistaken for a literal length', async () => {
  const pdf = await renderPdfWithPhoto();
  const text = pdf.toString('latin1');
  // Point the image's /Length at an indirect object, as a producer may.
  const tampered = Buffer.from(
    text.replace(/(\/Subtype\s*\/Image[\s\S]{0,200}?\/Length\s+)\d+/, '$1999 0 R'),
    'latin1',
  );
  assert.notStrictEqual(tampered.toString('latin1'), text, 'fixture was not tampered');
  assert.strictEqual(await shrinkReportPdf(tampered), tampered);
});

test('a declared length that misses endstream leaves the file untouched', async () => {
  const pdf = await renderPdfWithPhoto();
  const bad = Buffer.from(
    pdf
      .toString('latin1')
      .replace(/(\/Subtype\s*\/Image[\s\S]{0,200}?\/Length\s+)(\d+)/, (_m, head, n) => `${head}${Number(n) - 7}`),
    'latin1',
  );
  assert.strictEqual(await shrinkReportPdf(bad), bad);
});

test('incremental-update and linearized files are left alone', async () => {
  const pdf = await renderPdfWithPhoto();
  const appended = Buffer.concat([pdf, Buffer.from('\nxref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 1 /Prev 1>>\nstartxref\n9\n%%EOF\n')]);
  assert.strictEqual(await shrinkReportPdf(appended), appended);
  const linear = Buffer.from(pdf.toString('latin1').replace('/Producer', '/Linearized 1 /Producer'), 'latin1');
  assert.strictEqual(await shrinkReportPdf(linear), linear);
});

test('refuses an oversized declared image instead of inflating it', async () => {
  const pdf = await renderPdfWithPhoto();
  const huge = Buffer.from(
    pdf.toString('latin1').replace(/(\/Subtype\s*\/Image[\s\S]{0,120}?\/Width\s+)\d+/, '$1100000'),
    'latin1',
  );
  assert.strictEqual(await shrinkReportPdf(huge), huge);
});

// ---- the weighbridge PC copy: same rewrite, injected encoder -----------------

test('PC copy: rewrites the same PDF, keeps dimensions, gates a bad encoder', async () => {
  const pc = require('../../../backend/utils/pdfShrink');
  const encoder = (raw, w, h, channels, quality) =>
    sharp(raw, { raw: { width: w, height: h, channels } })
      .jpeg({ quality, progressive: false, chromaSubsampling: '4:4:4' })
      .toBuffer();
  const decoder = (jpeg, w, h) => sharp(jpeg).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();

  const before = await renderPdfWithPhoto();
  pc.resetEncoderCheck();
  const after = await pc.shrinkReportPdf(before, { encoder, decoder });
  assert.ok(after.length < before.length / 3, `${before.length} -> ${after.length}`);
  assert.match(after.toString('latin1'), /\/Filter\s*\/DCTDecode/);
  assert.deepStrictEqual(imageDimensions(after), imageDimensions(before));

  // A red/blue swap must be caught by the self-check, not shipped.
  pc.resetEncoderCheck();
  const swapped = (raw, w, h, channels, quality) => {
    const copy = Buffer.from(raw);
    for (let i = 0; i + 2 < copy.length; i += 3) [copy[i], copy[i + 2]] = [copy[i + 2], copy[i]];
    return encoder(copy, w, h, channels, quality);
  };
  assert.strictEqual(await pc.shrinkReportPdf(before, { encoder: swapped, decoder }), before);

  pc.resetEncoderCheck();
  assert.strictEqual(await pc.shrinkReportPdf(before, { encoder: async () => null, decoder }), before);
  pc.resetEncoderCheck();
});
