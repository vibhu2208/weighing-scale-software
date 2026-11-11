'use strict';

/** Soft target — above this we re-encode for report/PDF use. */
const TARGET_MAX_BYTES = 12 * 1024 * 1024;
/** Hard ceiling so a single request cannot exhaust memory. */
const ABSOLUTE_MAX_BYTES = 28 * 1024 * 1024;
/** Same report-photo budget as weighbridge RemoteTripSyncService. */
const REPORT_PHOTO_MAX_EDGE = 1920;
const REPORT_PHOTO_QUALITY = 85;

/**
 * If the buffer is over TARGET_MAX_BYTES, resize/re-encode to a report JPEG.
 * Returns only the bytes that should be stored — the oversized original is dropped.
 */
async function normalizeReportPhoto(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) {
    throw new Error('Invalid image data');
  }
  if (buf.length > ABSOLUTE_MAX_BYTES) {
    throw new Error('Image too large to process (max ~28 MB)');
  }
  if (buf.length <= TARGET_MAX_BYTES) {
    return {
      body: buf,
      resized: false,
      contentType: null,
      originalBytes: buf.length,
      storedBytes: buf.length,
    };
  }

  const sharp = require('sharp');
  const body = await sharp(buf)
    .rotate()
    .resize({
      width: REPORT_PHOTO_MAX_EDGE,
      height: REPORT_PHOTO_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: REPORT_PHOTO_QUALITY, mozjpeg: true })
    .toBuffer();

  if (!body.length) throw new Error('Image resize produced empty output');

  return {
    body,
    resized: true,
    contentType: 'image/jpeg',
    originalBytes: buf.length,
    storedBytes: body.length,
  };
}

module.exports = {
  TARGET_MAX_BYTES,
  ABSOLUTE_MAX_BYTES,
  REPORT_PHOTO_MAX_EDGE,
  REPORT_PHOTO_QUALITY,
  normalizeReportPhoto,
};
