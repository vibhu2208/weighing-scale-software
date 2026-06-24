'use strict';

const ts = require('./timestamp');

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
  return Number(n).toLocaleString('en-IN');
}

function cell(value) {
  return `<td>${escapeHtml(value ?? '')}</td>`;
}

/**
 * Build landscape tabular PDF HTML matching the Excel/CSV export columns.
 */
function buildExcelTablePdfHtml({ headers = [], rows = [], company = {}, periodLabel = '', summary = {} } = {}) {
  const headerCells = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const bodyRows = rows
    .map((values) => `<tr>${values.map((v) => cell(v)).join('')}</tr>`)
    .join('');

  const generatedAt = ts.toDisplay(ts.now());
  const companyName = company.name || 'Weighbridge Report';
  const siteName = company.siteName || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(periodLabel || 'Export Report')}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 7px;
      color: #111;
      margin: 0;
      padding: 0;
    }
    .header {
      margin-bottom: 8px;
      border-bottom: 2px solid #1e40af;
      padding-bottom: 6px;
    }
    .header h1 {
      margin: 0 0 2px;
      font-size: 14px;
      color: #1e40af;
    }
    .header .meta {
      font-size: 8px;
      color: #444;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 8px;
    }
    .summary span {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 3px 8px;
    }
    .summary strong { color: #1e40af; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th {
      background: #1e40af;
      color: #fff;
      font-weight: 700;
      text-align: center;
      padding: 4px 2px;
      border: 1px solid #1e3a8a;
      word-wrap: break-word;
    }
    td {
      padding: 3px 2px;
      border: 1px solid #cbd5e1;
      text-align: center;
      word-wrap: break-word;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #f8fafc; }
    .footer {
      margin-top: 8px;
      font-size: 7px;
      color: #64748b;
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(companyName)}</h1>
    ${siteName ? `<div class="meta">${escapeHtml(siteName)}</div>` : ''}
    <div class="meta">Closed Tickets Export · ${escapeHtml(periodLabel || 'All records')} · Generated ${escapeHtml(generatedAt)}</div>
  </div>
  <div class="summary">
    <span>Tickets: <strong>${rows.length}</strong></span>
    <span>Gross: <strong>${formatKg(summary.gross)} kg</strong></span>
    <span>Tare: <strong>${formatKg(summary.tare)} kg</strong></span>
    <span>Net: <strong>${formatKg(summary.net)} kg</strong> (${((summary.net || 0) / 1000).toFixed(2)} t)</span>
  </div>
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows || '<tr><td colspan="' + headers.length + '">No records</td></tr>'}</tbody>
  </table>
  <div class="footer">${rows.length} record(s)</div>
</body>
</html>`;
}

module.exports = {
  buildExcelTablePdfHtml,
};
