'use strict';

/**
 * Shrink a Chrome/Skia-produced slip PDF without changing how it looks.
 *
 * Chrome's print-to-PDF passes a JPEG through untouched only when it can draw
 * it as-is. The slip template's photo cells are 200x120, so object-fit: cover
 * crops every ~1620x970 camera frame by a few pixels, and Chrome then re-embeds
 * the result as a raw RGB FlateDecode stream: six frames that are ~3.4 MB on
 * disk become a ~22 MB PDF. This pass re-encodes those image XObjects as baseline JPEG
 * (DCTDecode) at their original pixel dimensions: same geometry, same page
 * content, same zoom detail, roughly a tenth of the bytes.
 *
 * It only rewrites streams it fully understands and returns the input
 * untouched on anything unexpected, so a failure here can never corrupt a
 * report.
 */

const zlib = require('zlib');
const sharp = require('sharp');

const DEFAULT_QUALITY = 85;
/** Refuse to decode anything bigger than a ~64 MP image: reports never hold one. */
const MAX_PIXELS = 64 * 1024 * 1024;

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Sequential object scan that jumps over stream bytes, so binary stream data
 * can never be mistaken for an `N 0 obj` header.
 * @returns {Array|null} objects, or null when the file is not a simple
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

async function recompressImageObject(buf, object, quality, maxWidth) {
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
    raw = zlib.inflateSync(buf.subarray(object.streamStart, object.streamStart + object.streamLen), {
      maxOutputLength: width * height * 3,
    });
  } catch {
    return null;
  }
  const channels = channelsFor(dict, raw.length, width, height);
  if (!channels) return null;

  let image = sharp(raw, { raw: { width, height, channels } });
  let outWidth = width;
  let outHeight = height;
  if (maxWidth > 0 && width > maxWidth) {
    outWidth = maxWidth;
    outHeight = Math.max(1, Math.round((height * maxWidth) / width));
    image = image.resize(outWidth, outHeight);
  }
  // Baseline (never progressive): DCTDecode consumers in print drivers and
  // older readers handle baseline reliably. 4:4:4 keeps the burnt-in camera
  // timestamp and painted edges crisp.
  const jpeg = await image
    .jpeg({
      quality,
      progressive: false,
      optimiseCoding: true,
      trellisQuantisation: true,
      overshootDeringing: true,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();
  if (jpeg.length >= object.streamLen) return null;

  const newDict = dict
    .replace(/\/Filter\s*\/FlateDecode/, '/Filter /DCTDecode')
    .replace(/\/Length\s+\d+/, `/Length ${jpeg.length}`)
    .replace(/\/Width\s+\d+/, `/Width ${outWidth}`)
    .replace(/\/Height\s+\d+/, `/Height ${outHeight}`)
    .replace(/^\s*<<|>>\s*$/g, '')
    .trim();
  return { dict: newDict, data: jpeg };
}

/**
 * @param {Buffer} pdf
 * @param {{ quality?: number, maxImageWidth?: number }} [options]
 * @returns {Promise<Buffer>} a smaller PDF, or the original on any doubt.
 */
async function shrinkReportPdf(pdf, options = {}) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 1024) return pdf;
  const quality = Math.min(
    95,
    Math.max(40, options.quality ?? envInt('REPORT_PDF_JPEG_QUALITY', DEFAULT_QUALITY)),
  );
  const maxImageWidth = Math.max(0, options.maxImageWidth ?? envInt('REPORT_PDF_MAX_IMAGE_WIDTH', 0));

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

    const edits = new Map();
    for (const object of objects) {
      if (object.streamStart == null) continue;
      // eslint-disable-next-line no-await-in-loop
      const edit = await recompressImageObject(pdf, object, quality, maxImageWidth);
      if (edit) edits.set(object.num, edit);
    }
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
      rows.push(
        offset == null
          ? '0000000000 65535 f '
          : `${String(offset).padStart(10, '0')} 00000 n `,
      );
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
    console.warn('[reportPdf] shrink skipped:', err.message);
    return pdf;
  }
}

module.exports = {
  shrinkReportPdf,
  DEFAULT_QUALITY,
};
