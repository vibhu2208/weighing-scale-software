'use strict';

const crypto = require('crypto');
const {
  isConfigured,
  getObjectBuffer,
  putObject,
  mirrorReportKey,
  mirrorReportGrossKey,
  presignGet,
} = require('./s3Presign');
const { getSiteId } = require('../db');

/** Bump when PDF HTML/CSS/company layout changes so S3 cache invalidates. */
const PDF_TEMPLATE_VERSION = 'v2';

/**
 * Fingerprint of the fields that affect slip PDF pixels/text.
 * When this changes, the cached PDF must be rebuilt.
 */
function pdfContentFingerprint(row, options = {}) {
  let printAt = '';
  if (options.printAt) {
    const d = new Date(options.printAt);
    printAt = Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const payload = [
    PDF_TEMPLATE_VERSION,
    process.env.COMPANY_NAME || '',
    process.env.REPORT_COMPANY_NAME || '',
    process.env.SITE_NAME || '',
    process.env.WEIGHBRIDGE_ID || '',
    options.grossPrint ? 'gross' : 'normal',
    printAt,
    row?.slip_number,
    row?.truck_number,
    row?.customer_name,
    row?.destination,
    row?.material,
    row?.operator_name,
    row?.company,
    row?.ticket_status,
    row?.vehicle_type,
    row?.gross_weight,
    row?.tare_weight,
    row?.net_weight,
    row?.timestamp_in,
    row?.timestamp_out,
    row?.updated_at,
    row?.arrival_photo_1,
    row?.arrival_photo_2,
    row?.arrival_photo_3,
    row?.departure_photo_1,
    row?.departure_photo_2,
    row?.departure_photo_3,
  ]
    .map((v) => String(v ?? ''))
    .join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Drop stored fingerprints so the next PDF rebuilds (e.g. after photo replace). */
async function clearPdfFingerprints(queryFn, slipNumber, siteId = getSiteId()) {
  const slip = String(slipNumber || '').trim();
  if (!slip || typeof queryFn !== 'function') return;
  await queryFn(
    `UPDATE remote_trips
     SET report_content_fp = NULL,
         report_gross_content_fp = NULL
     WHERE UPPER(slip_number) = UPPER($1)`,
    [slip],
  );
  await queryFn(
    `UPDATE transactions_mirror
     SET report_content_fp = NULL
     WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)`,
    [siteId, slip],
  );
}

function cacheKeyFor(row, options = {}) {
  const siteId = options.siteId || getSiteId();
  return options.grossPrint
    ? mirrorReportGrossKey(siteId, row.slip_number)
    : options.reportKey || mirrorReportKey(siteId, row.slip_number);
}

function storedFingerprint(row, options = {}) {
  return options.grossPrint
    ? row?.report_gross_content_fp
    : row?.report_content_fp;
}

function storedKey(row, options = {}) {
  if (options.grossPrint) {
    return row?.report_gross_s3_key || cacheKeyFor(row, options);
  }
  return row?.report_s3_key || cacheKeyFor(row, options);
}

/**
 * Return cached PDF buffer when fingerprint still matches and S3 object exists.
 */
async function readCachedPdf(row, options = {}) {
  if (!isConfigured() || !row?.slip_number) {
    return { hit: false, fingerprint: pdfContentFingerprint(row, options) };
  }
  const fingerprint = pdfContentFingerprint(row, options);
  if (storedFingerprint(row, options) !== fingerprint) {
    return { hit: false, fingerprint };
  }
  const key = storedKey(row, options);
  if (!key) return { hit: false, fingerprint };
  try {
    const pdf = await getObjectBuffer(key);
    if (!pdf || !pdf.length) return { hit: false, fingerprint };
    return {
      hit: true,
      fingerprint,
      pdf,
      report_s3_key: key,
      report_url: await presignGet(key).catch(() => null),
    };
  } catch {
    return { hit: false, fingerprint };
  }
}

async function writeCachedPdf(row, pdf, options = {}) {
  if (!isConfigured() || options.upload === false) {
    return {
      report_s3_key: null,
      report_url: null,
      fingerprint: pdfContentFingerprint(row, options),
    };
  }
  const fingerprint = options.fingerprint || pdfContentFingerprint(row, options);
  const key = cacheKeyFor(row, options);
  await putObject(key, pdf, 'application/pdf');
  const reportUrl = await presignGet(key).catch(() => null);
  return {
    report_s3_key: key,
    report_url: reportUrl,
    fingerprint,
  };
}

module.exports = {
  PDF_TEMPLATE_VERSION,
  pdfContentFingerprint,
  clearPdfFingerprints,
  readCachedPdf,
  writeCachedPdf,
  cacheKeyFor,
};
