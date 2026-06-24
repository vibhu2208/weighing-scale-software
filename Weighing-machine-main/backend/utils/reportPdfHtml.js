'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ts = require('./timestamp');
const { normalizePath, PATHS } = require('./fileStorage');
const {
  parseCameraSnapshots,
  listTripCameraImages,
  photoPathFromSnapshots,
} = require('./tripPhotos');
const { isHywa, grossWeightTimestamp, tareWeightTimestamp, netWeightTimestamp } = require('./vehicleTypes');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const DEFAULT_LOGO_CANDIDATES = [
  () => path.join(PATHS.ROOT, 'backend', 'assets', 'report-logo.png'),
  () => path.join(PATHS.LOGS, 'wsscc-to-support-swachh-bharat-slider-removebg-preview.png'),
];

function resolveReportLogoPath(customPath) {
  if (customPath) {
    const resolved = normalizePath(customPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  for (const candidate of DEFAULT_LOGO_CANDIDATES) {
    const resolved = normalizePath(candidate());
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

function buildReportLogoHtml(company = {}) {
  const logoPath = resolveReportLogoPath(company.logoPath);
  const src = logoPath ? imageToDataUrl(logoPath) : null;
  if (!src) return '<div class="header-logo"></div>';
  return `<div class="header-logo"><img src="${src}" alt=""/></div>`;
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatKg(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('en-IN')} kg`;
}

function formatKgSlip(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Math.round(Number(n))} Kg`;
}

function fieldLine(label, value) {
  return `<div class="field"><span class="field-label">${escapeHtml(label)}</span> : ${escapeHtml(value || '—')}</div>`;
}

function weightLine(label, kg, timestampIso) {
  const tsText = timestampIso ? ts.toDisplay(timestampIso) : '—';
  return `<div class="weight-line">
    <span class="field-label">${escapeHtml(label)}</span> : ${formatKgSlip(kg)}
    <span class="weight-ts">(${escapeHtml(tsText)})</span>
  </div>`;
}

function photoPathForSlot(row, passLabel, slotIndex) {
  const prefix = passLabel === 'departure' ? 'departure' : 'arrival';
  const columnPath = row[`${prefix}_photo_${slotIndex}`];
  if (columnPath) return columnPath;

  const fromSnapshots = photoPathFromSnapshots(row, passLabel, slotIndex);
  if (fromSnapshots) return fromSnapshots;

  const items = listTripCameraImages(row).filter((cam) => cam.pass === passLabel);
  const byCamId = items.find((cam) => cam.id === `cam-${slotIndex}`);
  return byCamId?.path || items[slotIndex - 1]?.path || null;
}

function buildWeighmentPhotoRow(row, passLabel, sectionTitle) {
  const cells = [];

  for (let slot = 1; slot <= 3; slot += 1) {
    const filePath = photoPathForSlot(row, passLabel, slot);
    const src = filePath ? imageToDataUrl(filePath) : null;
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

function buildVehicleReportPage(row, company = {}) {
  const orgName = company.name || 'MUNICIPAL CORPORATION GURUGRAM';
  const siteName = company.siteName || company.address || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC';
  const weighbridgeId = company.weighbridgeId || 'WB - 03';
  const customerName = row.customer_name || '—';
  const destination = row.destination || '—';
  const companyName = company.reportCompanyName || 'DAYA CHARAN & COMPANY';
  const operatorName = row.operator_name || '—';

  return `<div class="vehicle-report">
    <div class="report-header">
      ${buildReportLogoHtml(company)}
      <div class="header-center">
        <div class="org-name">${escapeHtml(orgName)}</div>
        <div class="site-name">${escapeHtml(siteName)}</div>
        <div class="weighbridge-id">${escapeHtml(weighbridgeId)}</div>
      </div>
      <div class="print-date">Print Date : ${escapeHtml(ts.toDisplay(ts.now()))}</div>
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
      ${weightLine('Net Wt', row.net_weight, netWeightTimestamp(row) || row.timestamp_in)}
    </div>

    ${buildWeighmentPhotoRow(row, 'arrival', '1ST WEIGHMENTS')}
    ${buildWeighmentPhotoRow(row, 'departure', '2ND WEIGHMENTS')}

    <div class="signature-block">
      <div class="signature-label">OPERATOR'S SIGNATURE</div>
      <div class="signature-line"></div>
    </div>
  </div>`;
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

function buildCombinedCoverPage(company = {}, meta = {}) {
  const orgName = company.name || 'MUNICIPAL CORPORATION GURUGRAM';
  const siteName = company.siteName || company.address || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC';
  const weighbridgeId = company.weighbridgeId || 'WB - 03';
  const period = meta.periodLabel || meta.period || '—';
  const generated = meta.generatedAt || ts.toDisplay(ts.now());
  const totalTickets = meta.totalTickets ?? meta.total ?? 0;
  const gross = meta.gross ?? 0;
  const tare = meta.tare ?? 0;
  const net = meta.net ?? 0;

  return `<div class="cover-page">
    <div class="cover-inner">
      <div class="cover-org">${escapeHtml(orgName)}</div>
      <div class="cover-site">${escapeHtml(siteName)}</div>
      <div class="cover-weighbridge-id">${escapeHtml(weighbridgeId)}</div>
      <div class="cover-title">Weighbridge Report Pack</div>
      <table class="cover-meta">
        <tr><td class="label">Generated Date</td><td>${escapeHtml(generated)}</td></tr>
        <tr><td class="label">Report Period</td><td>${escapeHtml(period)}</td></tr>
        <tr><td class="label">Total Tickets</td><td>${escapeHtml(totalTickets)}</td></tr>
        <tr><td class="label">Total Gross Weight</td><td>${escapeHtml(formatKg(gross))}</td></tr>
        <tr><td class="label">Total Tare Weight</td><td>${escapeHtml(formatKg(tare))}</td></tr>
        <tr><td class="label">Total Net Weight</td><td>${escapeHtml(formatKg(net))}</td></tr>
      </table>
    </div>
  </div>`;
}

function buildCombinedCoverStyles() {
  return `
    .cover-page {
      page-break-after: always;
      min-height: calc(100vh - 32px);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #333;
      padding: 40px;
    }
    .cover-inner { text-align: center; width: 100%; max-width: 520px; }
    .cover-org { font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .cover-site { margin-top: 8px; font-size: 15px; color: #444; text-transform: uppercase; }
    .cover-weighbridge-id { margin-top: 6px; font-size: 14px; font-weight: 600; }
    .cover-title {
      margin: 28px 0 24px;
      font-size: 18px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-top: 2px solid #333;
      border-bottom: 2px solid #333;
      padding: 12px 0;
    }
    .cover-meta {
      width: 100%;
      border-collapse: collapse;
      margin: 0 auto;
      text-align: left;
    }
    .cover-meta td { border-bottom: 1px solid #ddd; padding: 10px 8px; font-size: 13px; }
    .cover-meta .label { width: 46%; font-weight: 600; color: #555; }
  `;
}

function buildVehicleReportHtml(rows, options = {}) {
  const { company = {}, coverMeta = null } = options;
  const list = Array.isArray(rows) ? rows : [rows];
  const ticketPages = list.map((row) => buildVehicleReportPage(row, company)).join('');
  const cover = coverMeta
    ? buildCombinedCoverPage(company, coverMeta)
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>${buildVehicleReportStyles()}<style>${buildCombinedCoverStyles()}</style></head>
<body>${cover}${ticketPages}</body></html>`;
}

function imageToDataUrl(filePath) {
  const resolved = normalizePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) return null;

  try {
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/jpeg';
    const data = fs.readFileSync(resolved).toString('base64');
    return `data:${mime};base64,${data}`;
  } catch {
    return null;
  }
}

/** Prefer file URLs in PDF HTML (smaller temp files; works with loadFile). */
function imageSrcForPdf(filePath) {
  const resolved = normalizePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    return pathToFileURL(resolved).href;
  } catch {
    return imageToDataUrl(filePath);
  }
}

function buildImageGallery(images, passLabel) {
  const items = images.filter((cam) => cam.pass === passLabel);
  if (!items.length) {
    return `<p class="no-images">No ${passLabel} pass images saved.</p>`;
  }

  const figures = items
    .map((cam) => {
      const src = imageSrcForPdf(cam.path);
      const label = escapeHtml(cam.label || cam.id || 'Camera');
      if (!src) {
        return `<figure class="cam missing"><div class="placeholder">Image missing</div><figcaption>${label}</figcaption></figure>`;
      }
      return `<figure class="cam"><img src="${src}" alt="${label}"/><figcaption>${label}</figcaption></figure>`;
    })
    .join('');

  return `<div class="gallery">${figures}</div>`;
}

function buildTripSection(row, index) {
  const images = listTripCameraImages(row);
  const vType = row.vehicle_type || row.vehicle?.vehicle_type || null;
  const hywa = isHywa(vType);
  const passTitle = (pass) => {
    if (pass === 'arrival') return 'Arrival';
    if (pass === 'departure') return 'Departure';
    return pass;
  };

  return `<section class="trip">
    <h2>Ticket ${index + 1}: ${escapeHtml(row.slip_number || row.id || '—')}</h2>

    <h3>Vehicle Information</h3>
    <table class="details">
      <tr><td class="label">Ticket number</td><td>${escapeHtml(row.slip_number || '—')}</td></tr>
      <tr><td class="label">Vehicle number</td><td>${escapeHtml(row.truck_number || '—')}</td></tr>
      <tr><td class="label">RFID tag</td><td class="mono">${escapeHtml(row.rfid_tag || '—')}</td></tr>
      <tr><td class="label">Transporter</td><td>${escapeHtml(row.transporter || '—')}</td></tr>
      <tr><td class="label">Material</td><td>${escapeHtml(row.material || '—')}</td></tr>
      <tr><td class="label">Driver</td><td>${escapeHtml(row.driver || '—')}</td></tr>
      <tr><td class="label">Operator</td><td>${escapeHtml(row.operator_id || row.operator || '—')}</td></tr>
    </table>

    <h3>Arrival Information</h3>
    <table class="details">
      <tr><td class="label">Arrival timestamp</td><td>${escapeHtml(ts.toDisplay(row.timestamp_in) || '—')}</td></tr>
      <tr><td class="label">${hywa ? 'Gross weight' : 'Tare weight'}</td><td>${formatKg(hywa ? row.gross_weight : row.tare_weight)}</td></tr>
    </table>
    <h4>Arrival photos · ${images.filter((i) => i.pass === 'arrival').length} image(s)</h4>
    ${buildImageGallery(images, 'arrival')}

    <h3>Departure Information</h3>
    <table class="details">
      <tr><td class="label">Departure timestamp</td><td>${escapeHtml(ts.toDisplay(row.timestamp_out) || '—')}</td></tr>
      <tr><td class="label">${hywa ? 'Tare weight' : 'Gross weight'}</td><td>${formatKg(hywa ? row.tare_weight : row.gross_weight)}</td></tr>
    </table>
    <h4>Departure photos · ${images.filter((i) => i.pass === 'departure').length} image(s)</h4>
    ${buildImageGallery(images, 'departure')}

    <h3>Weight Information</h3>
    <table class="details">
      <tr><td class="label">Tare weight</td><td>${formatKg(row.tare_weight)}</td></tr>
      <tr><td class="label">Gross weight</td><td>${formatKg(row.gross_weight)}</td></tr>
      <tr><td class="label">Net weight</td><td><strong>${formatKg(row.net_weight)}</strong></td></tr>
    </table>

    <h3>Audit Information</h3>
    <table class="details">
      <tr><td class="label">Ticket status</td><td>${escapeHtml(row.ticket_status || row.status || '—')}</td></tr>
      <tr><td class="label">Created time</td><td>${escapeHtml(ts.toDisplay(row.created_at) || '—')}</td></tr>
      <tr><td class="label">Closed time</td><td>${escapeHtml(ts.toDisplay(row.timestamp_out || row.updated_at) || '—')}</td></tr>
      <tr><td class="label">Transaction ID</td><td class="mono">${escapeHtml(row.id || '—')}</td></tr>
      <tr><td class="label">Sync status</td><td>${escapeHtml(row.sync_status || '—')}</td></tr>
      <tr><td class="label">Notes</td><td>${escapeHtml(row.notes || '—')}</td></tr>
    </table>
  </section>`;
}

function describeFilters(filters = {}) {
  const parts = [];
  if (filters.from || filters.to) {
    parts.push(
      `Period: ${filters.from ? ts.toDisplay(filters.from) : '—'} to ${filters.to ? ts.toDisplay(filters.to) : '—'}`,
    );
  }
  if (filters.status && filters.status !== 'all') parts.push(`Status: ${filters.status}`);
  if (filters.sync_status && filters.sync_status !== 'all') {
    parts.push(`Sync: ${filters.sync_status}`);
  }
  if (filters.truck_number) parts.push(`Truck: ${filters.truck_number}`);
  return parts.length ? parts.join(' · ') : 'All trips';
}

function buildSummaryTable(rows) {
  const summary = {
    total: rows.length,
    gross: rows.reduce((s, r) => s + (r.gross_weight || 0), 0),
    tare: rows.reduce((s, r) => s + (r.tare_weight || 0), 0),
    net: rows.reduce((s, r) => s + (r.net_weight || 0), 0),
  };

  return `<table class="summary">
    <thead>
      <tr>
        <th>Trips</th>
        <th>Gross (kg)</th>
        <th>Tare (kg)</th>
        <th>Net (kg)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${summary.total}</td>
        <td>${summary.gross.toLocaleString('en-IN')}</td>
        <td>${summary.tare.toLocaleString('en-IN')}</td>
        <td>${summary.net.toLocaleString('en-IN')}</td>
      </tr>
    </tbody>
  </table>`;
}

function buildReportStyles() {
  return `<style>
    @page { margin: 16mm; }
    body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 0; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 0 0 10px; color: #222; }
    h3 { font-size: 12px; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
    .meta { color: #666; font-size: 10px; margin-bottom: 16px; }
    .summary { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
    .summary th, .summary td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    .summary th { background: #f3f3f3; }
    .trip { page-break-after: always; margin-top: 8px; }
    .trip:last-child { page-break-after: auto; }
    .details { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    .details td { border-bottom: 1px solid #e5e5e5; padding: 6px 4px; vertical-align: top; }
    .details .label { width: 34%; color: #666; font-weight: 600; }
    .mono { font-family: Consolas, monospace; font-size: 10px; word-break: break-all; }
    .gallery { display: flex; flex-wrap: wrap; gap: 12px; }
    .cam { width: 180px; margin: 0; text-align: center; }
    .cam img { width: 180px; height: 135px; object-fit: cover; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; }
    .cam .placeholder { width: 180px; height: 135px; border: 1px dashed #aaa; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #888; background: #fafafa; }
    .cam figcaption { margin-top: 4px; font-size: 10px; color: #666; }
    .no-images { color: #888; font-style: italic; margin: 0 0 8px; }
    .notice { background: #fff8e6; border: 1px solid #f0d78c; padding: 8px 10px; margin-bottom: 16px; font-size: 10px; }
    .footer { margin-top: 24px; text-align: center; color: #888; font-size: 10px; }
  </style>`;
}

function buildDetailedReportHtml(rows, options = {}) {
  const {
    company = {},
    filters = {},
    truncated = false,
    totalCount = rows.length,
    title = 'Weighbridge Trip Report',
  } = options;

  const tripSections = rows.map((row, index) => buildTripSection(row, index)).join('');
  const truncationNotice = truncated
    ? `<p class="notice">Showing ${rows.length} of ${totalCount} trips. Narrow your date or status filters to export fewer trips with images.</p>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>${buildReportStyles()}</head>
<body>
  <h1>${escapeHtml(company.name || 'MUNICIPAL CORPORATION GURUGRAM')}</h1>
  <p class="meta">${escapeHtml(company.siteName || company.address || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC')}<br/>${escapeHtml(company.weighbridgeId || 'WB - 03')}${company.phone ? `<br/>Tel: ${escapeHtml(company.phone)}` : ''}</p>
  <h2>${escapeHtml(title)}</h2>
  <p class="meta">${escapeHtml(describeFilters(filters))}<br/>Generated ${escapeHtml(ts.toDisplay(ts.now()))}</p>
  ${buildSummaryTable(rows)}
  ${truncationNotice}
  ${tripSections}
  <p class="footer">${rows.length} trip(s) · ${escapeHtml(title)}</p>
</body></html>`;
}

module.exports = {
  escapeHtml,
  formatKg,
  formatKgSlip,
  parseCameraSnapshots,
  listTripCameraImages,
  photoPathForSlot,
  imageToDataUrl,
  imageSrcForPdf,
  buildCombinedCoverPage,
  buildDetailedReportHtml,
  buildVehicleReportHtml,
};
