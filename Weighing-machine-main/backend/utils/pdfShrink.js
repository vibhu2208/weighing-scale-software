'use strict';

/**
 * Shrink a Chromium-produced report PDF without changing how it looks.
 *
 * Chromium passes a JPEG into the PDF untouched only when it can draw it as-is.
 * The slip template's photo cells are `flex: 1`, so their computed width is
 * fractional and `object-fit: cover` always crops by a pixel or two; Chromium
 * then re-embeds every photo as a raw RGB FlateDecode stream. That turns
 * ~136 KB of compressed photos into a ~1.9 MB single-slip PDF, and scales with
 * every page of an export pack.
 *
 * This pass re-encodes those image XObjects as baseline JPEG (DCTDecode) at
 * their original pixel dimensions: same page, same geometry, same zoom detail,
 * a fraction of the bytes.
 *
 * Admin-side copy with the same parser: admin-api/src/services/pdfShrink.js
 * (that one encodes with sharp, which the desktop app does not bundle).
 *
 * Safety: it only rewrites streams it fully understands, it proves the encoder
 * round-trips before it rewrites anything, and it returns the input untouched
 * on any doubt — so a failure here can never corrupt a report.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Both are loaded lazily: this pass must stay usable (and testable) without the
// RTSP helper's and the logger's own dependencies being present.
function ffmpegPath() {
  try {
    return require('./ffmpeg').resolveFfmpegPath();
  } catch {
    return null;
  }
}

function warn(message, meta) {
  try {
    require('./logger').warn(message, meta);
  } catch {
    console.warn(`[pdfShrink] ${message}`, meta || '');
  }
}

const DEFAULT_QUALITY = 85;
/** Refuse to decode anything bigger than a ~64 MP image: reports never hold one. */
const MAX_PIXELS = 64 * 1024 * 1024;
const ENCODE_TIMEOUT_MS = 20000;
/** Each encode is its own ffmpeg process; a pack can hold hundreds of photos. */
const ENCODE_CONCURRENCY = 4;

/** ffmpeg -q:v runs 2 (best) to 31 (worst); match pdfImageCompress's mapping. */
function jpegQualityToFfmpegQ(quality) {
  const q = Math.min(100, Math.max(10, quality ?? DEFAULT_QUALITY));
  return Math.min(28, Math.max(2, Math.round(31 - (q / 100) * 27)));
}

function runFfmpeg(args, input) {
  return new Promise((resolve) => {
    const binary = ffmpegPath();
    if (!binary) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ENCODE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdout.on('error', () => finish(null));
    child.stderr.resume();
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks);
      finish(code === 0 && out.length ? out : null);
    });
    child.stdin.on('error', () => finish(null));
    child.stdin.end(input);
  });
}

/** Raw 8-bit pixels -> baseline JPEG. Channels is 3 (RGB) or 1 (grey). */
async function encodeJpeg(raw, width, height, channels, quality) {
  const inFmt = channels === 1 ? 'gray' : 'rgb24';
  const outFmt = channels === 1 ? 'gray' : 'yuvj444p';
  return runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', inFmt, '-s', `${width}x${height}`,
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-q:v', String(jpegQualityToFfmpegQ(quality)),
      '-pix_fmt', outFmt,
      '-f', 'mjpeg', 'pipe:1',
    ],
    raw,
  );
}

/** JPEG -> raw RGB, used only by the self-check below. */
async function decodeJpeg(jpeg, width, height) {
  return runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'pipe:0',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, 'pipe:1',
    ],
    jpeg,
  );
}

let encoderCheck = null;

/**
 * Encode a known pattern and read it back before trusting the encoder on real
 * report photos. Catches a missing ffmpeg, a broken build, and a channel-order
 * mix-up (which would silently swap red and blue in every photo).
 */
function encoderWorks(encoder, decoder) {
  encoderCheck ??= (async () => {
    const width = 16;
    const height = 16;
    const swatches = [
      [220, 30, 30], [30, 200, 30], [30, 30, 210], [230, 230, 230],
    ];
    const raw = Buffer.allocUnsafe(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = swatches[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
        const offset = (y * width + x) * 3;
        raw[offset] = r;
        raw[offset + 1] = g;
        raw[offset + 2] = b;
      }
    }
    try {
      const jpeg = await encoder(raw, width, height, 3, 90);
      if (!jpeg || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
      const back = await decoder(jpeg, width, height);
      if (!back || back.length !== raw.length) return false;
      let error = 0;
      for (let i = 0; i < raw.length; i += 1) error += Math.abs(raw[i] - back[i]);
      const mean = error / raw.length;
      if (mean > 12) {
        warn('Report PDF shrink disabled: encoder round-trip differs', { mean });
        return false;
      }
      return true;
    } catch (err) {
      warn('Report PDF shrink disabled: encoder unavailable', { message: err.message });
      return false;
    }
  })();
  return encoderCheck;
}

/**
 * Sequential object scan that jumps over stream bytes, so binary stream data
 * can never be mistaken for an `N 0 obj` header.
 * @returns {Array|null} objects, or null when this is not a simple
 *   classic-xref PDF we can safely rewrite.
 */
function parseObjects(text) {
  const objects = [];
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let from = 0;
  for (;;) {
    header.lastIndex = from;
    const match = header.exec(text);
    if (!match) break;
    const object = {
      num: Number(match[1]),
      gen: Number(match[2]),
      start: match.index,
      headerEnd: header.lastIndex,
    };
    const endobj = text.indexOf('endobj', object.headerEnd);
    if (endobj === -1) return null;
    const stream = text.indexOf('stream', object.headerEnd);
    if (stream !== -1 && stream < endobj) {
      object.dict = text.slice(object.headerEnd, stream);
      // `12 0 R` is an indirect reference, not a length of 12: bail on those.
      const length = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(object.dict);
      if (!length) return null;
      let dataStart = stream + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      object.streamStart = dataStart;
      object.streamLen = Number(length[1]);
      // The declared length must land exactly on `endstream`, or the slice is wrong.
      const tail = text.slice(dataStart + object.streamLen, dataStart + object.streamLen + 16);
      if (!/^\s*endstream/.test(tail)) return null;
      const after = text.indexOf('endobj', dataStart + object.streamLen);
      if (after === -1) return null;
      object.end = after + 'endobj'.length;
    } else {
      object.dict = text.slice(object.headerEnd, endobj);
      object.end = endobj + 'endobj'.length;
    }
    objects.push(object);
    from = object.end;
  }
  return objects.length ? objects : null;
}

/** Channel count for the colour spaces we are willing to re-encode. */
function channelsFor(dict, byteLength, width, height) {
  const pixels = width * height;
  if (!pixels) return 0;
  if (byteLength === pixels * 3 && /\/DeviceRGB|\/ICCBased/.test(dict)) return 3;
  if (byteLength === pixels && /\/DeviceGray|\/ICCBased|\/CalGray/.test(dict)) return 1;
  return 0;
}

async function recompressImageObject(pdf, object, quality, encoder) {
  const { dict } = object;
  if (!/\/Subtype\s*\/Image/.test(dict)) return null;
  if (!/\/Filter\s*\/FlateDecode/.test(dict)) return null;
  // Predictors, masks and custom decode arrays change how the bytes are read.
  if (/\/DecodeParms|\/SMask|\/Mask\b|\/ImageMask|\/Decode\s*\[/.test(dict)) return null;
  if (!/\/BitsPerComponent\s+8\b/.test(dict)) return null;
  if (/\/Indexed|\/Separation|\/DeviceN|\/DeviceCMYK/.test(dict)) return null;

  const widthMatch = /\/Width\s+(\d+)/.exec(dict);
  const heightMatch = /\/Height\s+(\d+)/.exec(dict);
  if (!widthMatch || !heightMatch) return null;
  const width = Number(widthMatch[1]);
  const height = Number(heightMatch[1]);
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) return null;

  let raw;
  try {
    raw = zlib.inflateSync(pdf.subarray(object.streamStart, object.streamStart + object.streamLen), {
      maxOutputLength: width * height * 3,
    });
  } catch {
    return null;
  }
  const channels = channelsFor(dict, raw.length, width, height);
  if (!channels) return null;

  const jpeg = await encoder(raw, width, height, channels, quality);
  if (!jpeg || jpeg.length >= object.streamLen) return null;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;

  const newDict = dict
    .replace(/\/Filter\s*\/FlateDecode/, '/Filter /DCTDecode')
    .replace(/\/Length\s+\d+/, `/Length ${jpeg.length}`)
    .replace(/^\s*<<|>>\s*$/g, '')
    .trim();
  return { dict: newDict, data: jpeg };
}

/**
 * @param {Buffer} pdf
 * @param {{ quality?: number, encoder?: Function, decoder?: Function }} [options]
 * @returns {Promise<Buffer>} a smaller PDF, or the original on any doubt.
 */
async function shrinkReportPdf(pdf, options = {}) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 1024) return pdf;
  const quality = Math.min(
    95,
    Math.max(40, Number(options.quality ?? process.env.REPORT_PDF_JPEG_QUALITY) || DEFAULT_QUALITY),
  );
  const encoder = options.encoder || encodeJpeg;
  const decoder = options.decoder || decodeJpeg;

  try {
    const text = pdf.toString('latin1');
    // Encrypted or cross-reference-stream files are out of scope.
    if (/\/Encrypt\b/.test(text)) return pdf;
    if (/\/Type\s*\/(ObjStm|XRef)\b/.test(text)) return pdf;
    // Incremental updates and linearized files carry several xref sections; one
    // fresh table would not describe them.
    if ((text.match(/startxref/g) || []).length !== 1) return pdf;
    if (/\/Prev\s+\d+|\/Linearized\b/.test(text)) return pdf;
    const root = /\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
    if (!root) return pdf;

    const objects = parseObjects(text);
    if (!objects) return pdf;
    if (!objects.some((object) => object.streamStart != null && /\/Subtype\s*\/Image/.test(object.dict))) {
      return pdf;
    }
    if (!(await encoderWorks(encoder, decoder))) return pdf;

    const edits = new Map();
    const queue = objects.filter((object) => object.streamStart != null);
    // An export pack repeats the same photo across pages often enough to be
    // worth encoding each distinct stream once.
    const byContent = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(ENCODE_CONCURRENCY, queue.length) }, async () => {
        while (next < queue.length) {
          const object = queue[next];
          next += 1;
          // The dict is part of the key: two images can share pixel bytes while
          // pointing at different ICC colour-space objects, and the rewritten
          // dict is only valid for the object it came from.
          const digest = crypto
            .createHash('sha1')
            .update(object.dict)
            .update(pdf.subarray(object.streamStart, object.streamStart + object.streamLen))
            .digest('hex');
          let edit;
          if (byContent.has(digest)) {
            edit = await byContent.get(digest);
          } else {
            const pending = recompressImageObject(pdf, object, quality, encoder);
            byContent.set(digest, pending);
            edit = await pending;
          }
          if (edit) edits.set(object.num, edit);
        }
      }),
    );
    if (!edits.size) return pdf;

    const chunks = [Buffer.from(text.slice(0, objects[0].start), 'latin1')];
    const offsets = new Map();
    let cursor = chunks[0].length;
    for (const object of objects) {
      offsets.set(object.num, cursor);
      const edit = edits.get(object.num);
      const chunk = edit
        ? Buffer.concat([
            Buffer.from(`${object.num} ${object.gen} obj\n<<${edit.dict}>>\nstream\n`, 'latin1'),
            edit.data,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ])
        : Buffer.concat([pdf.subarray(object.start, object.end), Buffer.from('\n', 'latin1')]);
      chunks.push(chunk);
      cursor += chunk.length;
    }

    const maxNum = objects.reduce((max, object) => Math.max(max, object.num), 0);
    const xrefStart = cursor;
    const rows = ['xref', `0 ${maxNum + 1}`, '0000000000 65535 f '];
    for (let num = 1; num <= maxNum; num += 1) {
      const offset = offsets.get(num);
      rows.push(offset == null ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `);
    }
    const info = /\/Info\s+(\d+)\s+\d+\s+R/.exec(text);
    const trailer =
      `trailer\n<</Size ${maxNum + 1} /Root ${root[1]} 0 R` +
      `${info ? ` /Info ${info[1]} 0 R` : ''}>>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(`${rows.join('\n')}\n${trailer}`, 'latin1'));

    const out = Buffer.concat(chunks);
    if (out.length >= pdf.length) return pdf;
    return out;
  } catch (err) {
    warn('Report PDF shrink skipped', { message: err.message });
    return pdf;
  }
}

/** Test seam: forget the cached encoder self-check. */
function resetEncoderCheck() {
  encoderCheck = null;
}

module.exports = {
  shrinkReportPdf,
  encodeJpeg,
  decodeJpeg,
  resetEncoderCheck,
  DEFAULT_QUALITY,
};
