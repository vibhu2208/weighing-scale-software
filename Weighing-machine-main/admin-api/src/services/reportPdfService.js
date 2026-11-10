'use strict';

const { isConfigured, getObjectBuffer } = require('./s3Presign');
const { getSiteId, query } = require('../db');
const {
  buildVehicleReportHtml,
  bufferToDataUrl,
} = require('./vehicleReportHtml');
const { hydratePhotoKeys } = require('./reportMedia');
const { shrinkReportPdf } = require('./pdfShrink');
const { withPdfPage } = require('./browserPool');
const {
  pdfContentFingerprint,
  readCachedPdf,
  writeCachedPdf,
} = require('./pdfContentCache');

const PHOTO_FIELDS = [
  { col: 'arrival_photo_1', pass: 'arrival', slot: 1 },
  { col: 'arrival_photo_2', pass: 'arrival', slot: 2 },
  { col: 'arrival_photo_3', pass: 'arrival', slot: 3 },
  { col: 'departure_photo_1', pass: 'departure', slot: 1 },
  { col: 'departure_photo_2', pass: 'departure', slot: 2 },
  { col: 'departure_photo_3', pass: 'departure', slot: 3 },
];

function companySettings() {
  const siteId = getSiteId();
  // PC settings often use "WB - 03"; SITE_ID is normalized to "WB-03".
  let displayWb = process.env.WEIGHBRIDGE_ID || '';
  if (!displayWb) {
    const m = String(siteId || '').match(/^([A-Za-z]+)(\d+)$/);
    displayWb = m ? `${m[1]} - ${m[2].padStart(2, '0')}` : siteId || 'WB - 03';
  }
  return {
    name: process.env.COMPANY_NAME || 'MUNICIPAL CORPORATION GURUGRAM',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    siteName:
      process.env.SITE_NAME ||
      process.env.COMPANY_ADDRESS ||
      'BANDHWARI SLF SITE GURURAM (HARYANA) DCC',
    weighbridgeId: displayWb,
    reportCompanyName: process.env.REPORT_COMPANY_NAME || 'DAYA CHARAN & COMPANY',
    logoPath: process.env.REPORT_LOGO_PATH || '',
  };
}

async function loadPhotoDataUrls(row, options = {}) {
  const photos = {
    arrival: [null, null, null],
    departure: [null, null, null],
  };
  const failedKeys = [];
  if (!isConfigured()) return { photos, failedKeys };

  // Prefer caller-provided hydration. Skip HEAD verifies — GetObject 404 is enough.
  const hydrated = options.photosHydrated
    ? row
    : await hydratePhotoKeys(row, { verifyExists: false });

  await Promise.all(
    PHOTO_FIELDS.map(async ({ col, pass, slot }) => {
      const key = hydrated[col];
      if (!key) return;
      try {
        const buf = await getObjectBuffer(key);
        const src = bufferToDataUrl(buf, 'image/jpeg');
        if (src) photos[pass][slot - 1] = src;
        else failedKeys.push(col);
      } catch (err) {
        failedKeys.push(col);
        console.warn('[reportPdf] photo download failed', col, err.message);
      }
    }),
  );
  return { photos, failedKeys };
}

async function renderHtmlToPdfBuffer(html) {
  return withPdfPage(async (page) => {
    // data: images are inline — no network; avoid file:// + networkidle0 + 300ms.
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map(
          (img) =>
            new Promise((resolve) => {
              const finish = () => {
                if (img.naturalWidth === 0) {
                  img.style.display = 'none';
                  const parent = img.closest('.photo-cell');
                  if (parent) parent.classList.add('empty');
                }
                resolve();
              };
              if (typeof img.decode === 'function') {
                img
                  .decode()
                  .then(finish)
                  .catch(finish);
                return;
              }
              if (img.complete) finish();
              else {
                img.addEventListener('load', finish, { once: true });
                img.addEventListener('error', finish, { once: true });
              }
            }),
        ),
      );
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    // Same paper size as backend/utils/htmlToPdf.js (Electron printToPDF).
    const pdf = await page.pdf({
      printBackground: true,
      width: '8.27in',
      height: '11.69in',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: true,
    });
    // Chrome re-embeds every photo as a raw RGB Flate stream, which turns six
    // camera frames into a ~20 MB file. Re-encode those streams as JPEG at the
    // same pixel dimensions: identical page, a fraction of the bytes.
    return shrinkReportPdf(Buffer.from(pdf));
  });
}

async function persistPdfFingerprint(row, cached, options = {}) {
  if (!cached?.fingerprint || !row?.slip_number) return;
  const siteId = options.siteId || getSiteId();
  // Always key remote_trips by slip — report routes merge mirror rows whose `id`
  // is not a remote_trips primary key.
  try {
    if (options.grossPrint) {
      await query(
        `UPDATE remote_trips
         SET report_gross_content_fp = $2,
             report_gross_s3_key = COALESCE($3, report_gross_s3_key)
         WHERE UPPER(slip_number) = UPPER($1)`,
        [row.slip_number, cached.fingerprint, cached.report_s3_key || null],
      );
      return;
    }
    await query(
      `UPDATE remote_trips
       SET report_content_fp = $2,
           report_s3_key = COALESCE($3, report_s3_key)
       WHERE UPPER(slip_number) = UPPER($1)`,
      [row.slip_number, cached.fingerprint, cached.report_s3_key || null],
    );
    // Do not touch updated_at — for CLOSED slips report_date falls back to it.
    await query(
      `UPDATE transactions_mirror
       SET report_content_fp = $3,
           report_s3_key = COALESCE($4, report_s3_key)
       WHERE site_id = $1 AND UPPER(slip_number) = UPPER($2)`,
      [siteId, row.slip_number, cached.fingerprint, cached.report_s3_key || null],
    );
  } catch (err) {
    console.warn('[reportPdf] fingerprint persist failed', err.message);
  }
}

/**
 * Build a slip PDF matching the weighbridge PC layout (same HTML/CSS).
 * Uses content-fingerprint cache: unchanged trips reuse the S3 PDF.
 */
async function generateTripPdf(row, options = {}) {
  if (!row?.slip_number) throw new Error('Trip row with slip_number is required');

  if (options.useCache !== false) {
    const cached = await readCachedPdf(row, options);
    if (cached.hit) {
      return {
        pdf: cached.pdf,
        report_s3_key: cached.report_s3_key,
        report_url: cached.report_url,
        slip_number: row.slip_number,
        filename: `${row.slip_number}_report.pdf`,
        fromCache: true,
        fingerprint: cached.fingerprint,
      };
    }
  }

  const { photos: photoDataUrls, failedKeys } = await loadPhotoDataUrls(row, options);
  const html = buildVehicleReportHtml(
    {
      ...row,
      company: row.company || 'DCC',
      ticket_status: row.ticket_status || 'CLOSED',
      print_at: options.printAt || row.print_at || undefined,
    },
    companySettings(),
    photoDataUrls,
  );
  const pdf = await renderHtmlToPdfBuffer(html);
  const fingerprint = pdfContentFingerprint(row, options);
  // Missing photos → still return PDF, but never cache as a permanent HIT.
  const cacheable = failedKeys.length === 0;

  let reportS3Key = null;
  let reportUrl = null;
  if (cacheable && options.upload !== false && isConfigured()) {
    const written = await writeCachedPdf(row, pdf, {
      ...options,
      fingerprint,
    });
    reportS3Key = written.report_s3_key;
    reportUrl = written.report_url;
    if (options.persistFingerprint !== false) {
      await persistPdfFingerprint(
        row,
        { fingerprint, report_s3_key: reportS3Key },
        options,
      );
    }
  } else if (failedKeys.length) {
    console.warn(
      '[reportPdf] skipping cache — photo fetch failed',
      row.slip_number,
      failedKeys.join(','),
    );
  }

  return {
    pdf,
    report_s3_key: reportS3Key,
    report_url: reportUrl,
    slip_number: row.slip_number,
    filename: `${row.slip_number}_report.pdf`,
    fromCache: false,
    fingerprint,
  };
}

module.exports = {
  generateTripPdf,
  loadPhotoDataUrls,
  pdfContentFingerprint,
  PHOTO_FIELDS,
};
