'use strict';

/**
 * Admin copy of the weighbridge vehicle slip HTML/CSS (reportPdfHtml.js).
 * Kept in sync so admin PDF downloads match PC-generated reports.
 */

const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isHywa(vehicleType) {
  return String(vehicleType || '')
    .trim()
    .toLowerCase() === 'hywa';
}

function grossWeightTimestamp(row) {
  return isHywa(row?.vehicle_type) ? row?.timestamp_in : row?.timestamp_out;
}

function tareWeightTimestamp(row) {
  return isHywa(row?.vehicle_type) ? row?.timestamp_out : row?.timestamp_in;
}

function netWeightTimestamp(row) {
  if (!row) return null;
  if (String(row.ticket_status || '').toUpperCase() === 'CLOSED') {
    return row.timestamp_out || row.updated_at || null;
  }
  return row.timestamp_out || null;
}

function toDisplay(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatKgSlip(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Math.round(Number(n))} Kg`;
}

function fieldLine(label, value) {
  return `<div class="field"><span class="field-label">${escapeHtml(label)}</span> : ${escapeHtml(value || '—')}</div>`;
}

function weightLine(label, kg, timestampIso) {
  const tsText = timestampIso ? toDisplay(timestampIso) : '—';
  return `<div class="weight-line">
    <span class="field-label">${escapeHtml(label)}</span> : ${formatKgSlip(kg)}
    <span class="weight-ts">(${escapeHtml(tsText)})</span>
  </div>`;
}

function brandCompanyForTicket(company = {}, ticketCompany) {
  const code = String(ticketCompany || '').trim().toUpperCase();
  if (code !== 'MKG') return company;

  const baseSite =
    company.siteName ||
    company.address ||
    'BANDHWARI SLF SITE GURURAM (HARYANA) DCC';

  let siteName = String(baseSite);
  if (/\bDCC\b/i.test(siteName)) {
    siteName = siteName.replace(/\bDCC\b/gi, 'MKG');
  } else if (!/\bMKG\b/i.test(siteName)) {
    siteName = `${siteName.replace(/\s+$/, '')} MKG`;
  }

  return {
    ...company,
    siteName,
    reportCompanyName: 'MKG',
  };
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function fileToDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:${mimeForPath(filePath)};base64,${data}`;
  } catch {
    return null;
  }
}

function bufferToDataUrl(buf, mime = 'image/jpeg') {
  if (!buf?.length) return null;
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

function buildWeighmentPhotoRow(photos, sectionTitle) {
  const cells = [];
  for (let slot = 0; slot < 3; slot += 1) {
    const src = photos?.[slot] || null;
    if (src) {
      cells.push(`<div class="photo-cell"><img src="${src}" alt=""/></div>`);
    } else {
      cells.push('<div class="photo-cell empty"></div>');
    }
  }
  return `<div class="weighment-section">
    <div class="weighment-title">${escapeHtml(sectionTitle)}</div>
    <div class="photo-row">${cells.join('')}</div>
  </div>`;
}

function buildReportLogoHtml(company = {}) {
  const logoPath = company.logoPath;
  const src = logoPath ? fileToDataUrl(logoPath) : null;
  if (!src) return '<div class="header-logo"></div>';
  return `<div class="header-logo"><img src="${src}" alt=""/></div>`;
}

function buildVehicleReportStyles() {
  return `<style>
    @page { margin: 12mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 12px; color: #111; margin: 0; padding: 16px; }
    .vehicle-report {
      border: 1px solid #333;
      padding: 20px 24px 28px;
      min-height: calc(100vh - 32px);
      position: relative;
      page-break-after: always;
    }
    .vehicle-report:last-child { page-break-after: auto; }
    .report-header {
      position: relative;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      margin-bottom: 18px;
      min-height: 88px;
      padding: 0 130px 0 100px;
    }
    .header-logo {
      position: absolute;
      left: 0;
      top: 0;
      width: 88px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .header-logo img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }
    .header-center { flex: 1; text-align: center; }
    .org-name { font-size: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
    .site-name { margin-top: 4px; font-size: 13px; text-transform: uppercase; }
    .weighbridge-id { margin-top: 4px; font-size: 13px; font-weight: 600; }
    .print-date { position: absolute; top: 0; right: 0; font-size: 11px; white-space: nowrap; }
    .details-grid { display: flex; gap: 24px; margin-bottom: 16px; }
    .details-col { flex: 1; }
    .field { margin-bottom: 6px; line-height: 1.4; }
    .field-label { font-weight: 600; }
    .weights { margin: 14px 0 18px; }
    .weight-line { margin-bottom: 6px; line-height: 1.4; }
    .weight-ts { margin-left: 6px; }
    .weighment-section { margin-top: 16px; }
    .weighment-title {
      font-weight: 700;
      text-decoration: underline;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .photo-row { display: flex; gap: 10px; }
    .photo-cell {
      flex: 1;
      height: 120px;
      border: 1px solid #bbb;
      background: #f8f8f8;
      overflow: hidden;
    }
    .photo-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .photo-cell.empty { background: #fafafa; }
    .signature-block {
      position: absolute;
      right: 24px;
      bottom: 24px;
      width: 220px;
      text-align: center;
    }
    .signature-label { font-size: 11px; font-weight: 600; margin-bottom: 28px; }
    .signature-line { border-top: 1px solid #333; }
  </style>`;
}

function netWeight(row) {
  if (row.net_weight != null && Number.isFinite(Number(row.net_weight))) {
    return Number(row.net_weight);
  }
  const g = Number(row.gross_weight);
  const t = Number(row.tare_weight);
  if (Number.isFinite(g) && Number.isFinite(t)) return g - t;
  return null;
}

/**
 * @param {object} row - trip fields
 * @param {object} company - branding
 * @param {{ arrival: (string|null)[], departure: (string|null)[] }} photoDataUrls
 */
function buildVehicleReportPage(row, company = {}, photoDataUrls = {}) {
  const branded = brandCompanyForTicket(company, row.company);
  const orgName = branded.name || 'MUNICIPAL CORPORATION GURUGRAM';
  const siteName = branded.siteName || branded.address || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC';
  const weighbridgeId = branded.weighbridgeId || 'WB - 03';
  const customerName = row.customer_name || '—';
  const destination = row.destination || '—';
  const companyName = branded.reportCompanyName || 'DAYA CHARAN & COMPANY';
  const operatorName = row.operator_name || '—';
  const logoHtml = buildReportLogoHtml(branded);
  const arrivalPhotos = buildWeighmentPhotoRow(photoDataUrls.arrival, '1ST WEIGHMENTS');
  const departurePhotos = buildWeighmentPhotoRow(photoDataUrls.departure, '2ND WEIGHMENTS');

  return `<div class="vehicle-report">
    <div class="report-header">
      ${logoHtml}
      <div class="header-center">
        <div class="org-name">${escapeHtml(orgName)}</div>
        <div class="site-name">${escapeHtml(siteName)}</div>
        <div class="weighbridge-id">${escapeHtml(weighbridgeId)}</div>
      </div>
      <div class="print-date">Print Date : ${escapeHtml(toDisplay(new Date()))}</div>
    </div>

    <div class="details-grid">
      <div class="details-col">
        ${fieldLine('Slip No', row.slip_number)}
        ${fieldLine('Vehicle_No', row.truck_number)}
        ${fieldLine('Company_Name', companyName)}
        ${fieldLine('Operator_Name', operatorName)}
      </div>
      <div class="details-col">
        ${fieldLine('Destination', destination)}
        ${fieldLine('Customer_Name', customerName)}
        ${fieldLine('Material_Name', row.material)}
      </div>
    </div>

    <div class="weights">
      ${weightLine('Gross Wt', row.gross_weight, grossWeightTimestamp(row))}
      ${weightLine('Tare Wt', row.tare_weight, tareWeightTimestamp(row))}
      ${weightLine('Net Wt', netWeight(row), netWeightTimestamp(row) || row.timestamp_in)}
    </div>

    ${arrivalPhotos}
    ${departurePhotos}

    <div class="signature-block">
      <div class="signature-label">OPERATOR'S SIGNATURE</div>
      <div class="signature-line"></div>
    </div>
  </div>`;
}

function buildVehicleReportHtml(row, company = {}, photoDataUrls = {}) {
  const page = buildVehicleReportPage(row, company, photoDataUrls);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>${buildVehicleReportStyles()}</head>
<body>${page}</body></html>`;
}

module.exports = {
  buildVehicleReportHtml,
  fileToDataUrl,
  bufferToDataUrl,
  brandCompanyForTicket,
};
