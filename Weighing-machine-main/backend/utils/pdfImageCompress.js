'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveFfmpegPath } = require('./ffmpeg');

const execFileAsync = promisify(execFile);

let nativeImage = null;
try {
  nativeImage = require('electron').nativeImage;
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') {
    nativeImage = null;
  }
} catch (_e) {
  /* server / ELECTRON_RUN_AS_NODE */
}

/** Display cells are ~120px tall; 480px keeps print sharpness without huge files. */
const DEFAULT_PHOTO_MAX_WIDTH = 480;
const DEFAULT_PHOTO_JPEG_QUALITY = 55;
const DEFAULT_LOGO_MAX_WIDTH = 176;

function compressWithNativeImage(filePath, options = {}) {
  if (!nativeImage) return null;

  try {
    const raw = fs.readFileSync(filePath);
    let image = nativeImage.createFromBuffer(raw);
    if (!image || image.isEmpty()) {
      image = nativeImage.createFromPath(filePath);
    }
    if (!image || image.isEmpty()) return null;

    const maxWidth = options.maxWidth || DEFAULT_PHOTO_MAX_WIDTH;
    const quality = options.quality ?? DEFAULT_PHOTO_JPEG_QUALITY;
    const asJpeg = options.asJpeg !== false;

    const { width, height } = image.getSize();
    if (width > maxWidth && width > 0) {
      const nextHeight = Math.max(1, Math.round((height * maxWidth) / width));
      image = image.resize({
        width: maxWidth,
        height: nextHeight,
        quality: 'better',
      });
    }

    if (asJpeg) {
      const buffer = image.toJPEG(Math.min(100, Math.max(10, quality)));
      if (buffer && buffer.length) return { buffer, mime: 'image/jpeg' };
    }

    const png = image.toPNG();
    if (png && png.length) return { buffer: png, mime: 'image/png' };
    return null;
  } catch {
    return null;
  }
}

/**
 * ffmpeg -q:v is 2 (best) … 31 (worst). Map 10–100 JPEG-style quality to that scale.
 */
function jpegQualityToFfmpegQ(quality) {
  const q = Math.min(100, Math.max(10, quality ?? DEFAULT_PHOTO_JPEG_QUALITY));
  // 55 → ~12, 80 → ~7, 40 → ~16
  return Math.min(28, Math.max(4, Math.round(31 - (q / 100) * 27)));
}

async function compressWithFfmpegAsync(filePath, options = {}) {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return null;

  const maxWidth = options.maxWidth || DEFAULT_PHOTO_MAX_WIDTH;
  const asJpeg = options.asJpeg !== false;
  const qv = jpegQualityToFfmpegQ(options.quality);
  const ext = asJpeg ? '.jpg' : '.png';
  const tempOut = path.join(
    os.tmpdir(),
    `wb-pdf-img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );

  try {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-vf',
      `scale='min(${maxWidth}\\,iw)':-2`,
    ];
    if (asJpeg) {
      args.push('-q:v', String(qv));
    } else {
      args.push('-compression_level', '9');
    }
    args.push(tempOut);

    await execFileAsync(ffmpegPath, args, {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (!fs.existsSync(tempOut)) return null;
    const buffer = fs.readFileSync(tempOut);
    if (!buffer.length) return null;
    return { buffer, mime: asJpeg ? 'image/jpeg' : 'image/png' };
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    } catch {
      /* ignore */
    }
  }
}

function compressWithFfmpegSync(filePath, options = {}) {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return null;

  const maxWidth = options.maxWidth || DEFAULT_PHOTO_MAX_WIDTH;
  const asJpeg = options.asJpeg !== false;
  const qv = jpegQualityToFfmpegQ(options.quality);
  const ext = asJpeg ? '.jpg' : '.png';
  const tempOut = path.join(
    os.tmpdir(),
    `wb-pdf-img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );

  try {
    const { execFileSync } = require('child_process');
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-vf',
      `scale='min(${maxWidth}\\,iw)':-2`,
    ];
    if (asJpeg) {
      args.push('-q:v', String(qv));
    } else {
      args.push('-compression_level', '9');
    }
    args.push(tempOut);

    execFileSync(ffmpegPath, args, {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (!fs.existsSync(tempOut)) return null;
    const buffer = fs.readFileSync(tempOut);
    if (!buffer.length) return null;
    return { buffer, mime: asJpeg ? 'image/jpeg' : 'image/png' };
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resize + re-encode an image for PDF embedding (sync).
 * Camera captures are often 2–4 MB; PDF cells only need ~20–50 KB.
 *
 * @param {string} filePath
 * @param {{ maxWidth?: number, quality?: number, asJpeg?: boolean }} [options]
 * @returns {{ buffer: Buffer, mime: string } | null}
 */
function compressImageForPdf(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const viaNative = compressWithNativeImage(filePath, options);
  if (viaNative?.buffer?.length) return viaNative;

  return compressWithFfmpegSync(filePath, options);
}

/**
 * Async variant — preferred when compressing many photos in a pack.
 */
async function compressImageForPdfAsync(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const viaNative = compressWithNativeImage(filePath, options);
  if (viaNative?.buffer?.length) return viaNative;

  return compressWithFfmpegAsync(filePath, options);
}

module.exports = {
  compressImageForPdf,
  compressImageForPdfAsync,
  DEFAULT_PHOTO_MAX_WIDTH,
  DEFAULT_PHOTO_JPEG_QUALITY,
  DEFAULT_LOGO_MAX_WIDTH,
};
