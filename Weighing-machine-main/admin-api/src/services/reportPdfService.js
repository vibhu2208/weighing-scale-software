'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isConfigured,
  getObjectBuffer,
  putObject,
  mirrorReportKey,
  presignGet,
} = require('./s3Presign');
const { getSiteId } = require('../db');
const {
  buildVehicleReportHtml,
  bufferToDataUrl,
} = require('./vehicleReportHtml');

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

function ensureTempDir() {
  const dir = path.join(os.tmpdir(), 'weighbridge-admin-pdf');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadPhotoDataUrls(row) {
  const photos = {
    arrival: [null, null, null],
    departure: [null, null, null],
  };
  if (!isConfigured()) return photos;

  await Promise.all(
    PHOTO_FIELDS.map(async ({ col, pass, slot }) => {
      const key = row[col];
      if (!key) return;
      try {
        const buf = await getObjectBuffer(key);
        const src = bufferToDataUrl(buf, 'image/jpeg');
        if (src) photos[pass][slot - 1] = src;
      } catch (err) {
        console.warn('[reportPdf] photo download failed', col, err.message);
      }
    }),
  );
  return photos;
}

async function renderHtmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer');
  const tempDir = ensureTempDir();
  const tempHtml = path.join(
    tempDir,
    `render_${Date.now()}_${process.pid}.html`,
  );
  fs.writeFileSync(tempHtml, html, 'utf8');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    // file:// + data: images — match Electron loadFile + printToPDF flow
    await page.goto(`file://${tempHtml}`, {
      waitUntil: 'networkidle0',
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
              if (img.complete) finish();
              else {
                img.addEventListener('load', finish, { once: true });
                img.addEventListener('error', finish, { once: true });
              }
            }),
        ),
      );
    });
    await new Promise((r) => setTimeout(r, 300));

    // Same paper size as backend/utils/htmlToPdf.js (Electron printToPDF).
    const pdf = await page.pdf({
      printBackground: true,
      width: '8.27in',
      height: '11.69in',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tempHtml);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build a slip PDF matching the weighbridge PC layout (same HTML/CSS).
 */
async function generateTripPdf(row, options = {}) {
  if (!row?.slip_number) throw new Error('Trip row with slip_number is required');

  const photoDataUrls = await loadPhotoDataUrls(row);
  const html = buildVehicleReportHtml(
    {
      ...row,
      company: row.company || 'DCC',
      ticket_status: row.ticket_status || 'CLOSED',
    },
    companySettings(),
    photoDataUrls,
  );
  const pdf = await renderHtmlToPdfBuffer(html);

  let reportS3Key = null;
  let reportUrl = null;
  if (options.upload !== false && isConfigured()) {
    const siteId = options.siteId || getSiteId();
    reportS3Key = mirrorReportKey(siteId, row.slip_number);
    await putObject(reportS3Key, pdf, 'application/pdf');
    reportUrl = await presignGet(reportS3Key);
  }

  return {
    pdf,
    report_s3_key: reportS3Key,
    report_url: reportUrl,
    slip_number: row.slip_number,
    filename: `${row.slip_number}_report.pdf`,
  };
}

module.exports = {
  generateTripPdf,
  PHOTO_FIELDS,
};
