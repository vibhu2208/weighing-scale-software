'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const { PATHS, ensureDir } = require('../utils/fileStorage');
const PrintService = require('./PrintService');
const SettingsService = require('./SettingsService');
const logger = require('../utils/logger');
const { buildVehicleReportHtml } = require('../utils/reportPdfHtml');
const { buildExcelTablePdfHtml } = require('../utils/reportTablePdfHtml');
const { renderHtmlToPdf, printHtml } = require('../utils/htmlToPdf');
const { isClosedTrip } = require('../utils/tripPhotos');
const { grossWeightTimestamp, tareWeightTimestamp, reportListingTimestamp } = require('../utils/vehicleTypes');

const MAX_TRIPS_PER_PDF = 500;

// Closed tickets belong on the net-weight (close) date; open tickets use arrival date.
const REPORT_DATE_SQL = `CASE
  WHEN t.ticket_status = 'CLOSED' THEN COALESCE(t.timestamp_out, t.updated_at)
  ELSE t.timestamp_in
END`;

const SELECT = `
  SELECT t.*, v.owner_name, v.transporter, v.vehicle_type
  FROM transactions t
  LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number
`;

const EXPORT_HEADERS = [
  'Ticket_No',
  'Customer_Name',
  'Vehicle_No',
  'Item_Name',
  'Company_Name',
  'Operator_Name',
  'Destination',
  'GrossWt',
  'TareWt',
  'NetWt',
  'GrossDate',
  'GrossTime',
  'TareDate',
  'TareTime',
  'Net_Date',
  'Net_Time',
  'EntryDate',
];

function escapeCsv(value) {
  if (value == null) return '""';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function parseCameraSnapshotsField(raw) {
  if (!raw) return { tare: [], gross: [] };
  if (typeof raw === 'object') {
    return { tare: raw.tare || [], gross: raw.gross || [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return { tare: parsed.tare || [], gross: parsed.gross || [] };
  } catch {
    return { tare: [], gross: [] };
  }
}

function normalizeReportRow(row) {
  if (!row) return row;
  return {
    ...row,
    camera_snapshots: parseCameraSnapshotsField(row.camera_snapshots),
  };
}

function splitDateTime(iso) {
  if (!iso) return { date: '', time: '' };
  return { date: ts.toDisplayDate(iso), time: ts.toDisplayTime(iso) };
}

function reportDateIso(row) {
  const listing = reportListingTimestamp(row);
  return listing ? ts.toLocalDateIso(listing) : '';
}

function buildWhere(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.from) {
    clauses.push(`${REPORT_DATE_SQL} >= ?`);
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${REPORT_DATE_SQL} <= ?`);
    params.push(filters.to);
  }
  if (filters.truck_number) {
    clauses.push('UPPER(t.truck_number) = ?');
    params.push(String(filters.truck_number).trim().toUpperCase());
  }
  if (filters.status && filters.status !== 'all') {
    clauses.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.ticket_status && filters.ticket_status !== 'all') {
    clauses.push('t.ticket_status = ?');
    params.push(filters.ticket_status);
  }
  if (filters.sync_status && filters.sync_status !== 'all') {
    clauses.push('t.sync_status = ?');
    params.push(filters.sync_status);
  }
  if (filters.operator_name && filters.operator_name !== 'all') {
    clauses.push('t.operator_name = ?');
    params.push(filters.operator_name);
  }
  if (filters.material && filters.material !== 'all') {
    clauses.push('t.material = ?');
    params.push(filters.material);
  }
  if (filters.search && String(filters.search).trim()) {
    const term = `%${String(filters.search).trim()}%`;
    const upperTerm = `%${String(filters.search).trim().toUpperCase()}%`;
    clauses.push(`(
      t.slip_number LIKE ? OR
      UPPER(t.truck_number) LIKE ? OR
      UPPER(t.rfid_tag) LIKE ? OR
      UPPER(v.transporter) LIKE ? OR
      UPPER(t.operator_name) LIKE ? OR
      UPPER(t.material) LIKE ? OR
      UPPER(t.destination) LIKE ?
    )`);
    params.push(term, upperTerm, upperTerm, upperTerm, upperTerm, upperTerm, upperTerm);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

function slipNumberNumeric(slip) {
  if (!slip) return 0;
  const match = String(slip).match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

function sortRowsByTicketAsc(rows) {
  return [...rows].sort((a, b) => {
    const diff = slipNumberNumeric(a.slip_number) - slipNumberNumeric(b.slip_number);
    if (diff !== 0) return diff;
    return String(a.slip_number || '').localeCompare(String(b.slip_number || ''));
  });
}

function queryTransactions(filters = {}) {
  const { where, params } = buildWhere(filters);
  return getDb()
    .prepare(`${SELECT} ${where} ORDER BY ${REPORT_DATE_SQL} DESC`)
    .all(...params)
    .map(normalizeReportRow);
}

function queryTransactionsForExport(filters = {}) {
  const rows = queryTransactions(filters);
  return sortRowsByTicketAsc(rows);
}

function countTransactions(filters = {}) {
  const { where, params } = buildWhere(filters);
  return getDb()
    .prepare(`SELECT COUNT(*) AS c FROM transactions t LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number ${where}`)
    .get(...params).c;
}

function queryTransactionsPaginated(filters = {}) {
  const { where, params } = buildWhere(filters);
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 200));
  const page = Math.max(0, Number(filters.page) || 0);
  const offset = page * limit;

  const rows = getDb()
    .prepare(`${SELECT} ${where} ORDER BY ${REPORT_DATE_SQL} DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(normalizeReportRow);

  const total = countTransactions(filters);
  return {
    rows,
    pagination: {
      page,
      pageSize: limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

function summariseFromDb(filters = {}) {
  const { where, params } = buildWhere(filters);
  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.ticket_status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.ticket_status = 'CLOSED' THEN 1 ELSE 0 END) AS closed_count,
        SUM(CASE WHEN t.ticket_status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_count,
        COALESCE(SUM(t.gross_weight), 0) AS gross,
        COALESCE(SUM(t.tare_weight), 0) AS tare,
        COALESCE(SUM(t.net_weight), 0) AS net,
        COUNT(DISTINCT t.truck_number) AS vehicles,
        SUM(CASE WHEN t.report_path IS NOT NULL AND t.report_path != '' THEN 1 ELSE 0 END) AS reports_generated
      FROM transactions t
      LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number
      ${where}`,
    )
    .get(...params);

  return {
    total: row?.total || 0,
    open: row?.open_count || 0,
    closed: row?.closed_count || 0,
    cancelled: row?.cancelled_count || 0,
    gross: row?.gross || 0,
    tare: row?.tare || 0,
    net: row?.net || 0,
    vehicles: row?.vehicles || 0,
    reportsGenerated: row?.reports_generated || 0,
  };
}

function summarise(rows) {
  return {
    total: rows.length,
    gross: rows.reduce((s, r) => s + (r.gross_weight || 0), 0),
    tare: rows.reduce((s, r) => s + (r.tare_weight || 0), 0),
    net: rows.reduce((s, r) => s + (r.net_weight || 0), 0),
  };
}

function getCompanySettings() {
  return {
    name: SettingsService.get('COMPANY_NAME') || process.env.COMPANY_NAME || 'MUNICIPAL CORPORATION GURUGRAM',
    address: SettingsService.get('COMPANY_ADDRESS') || '',
    phone: SettingsService.get('COMPANY_PHONE') || '',
    siteName: SettingsService.get('SITE_NAME') || SettingsService.get('COMPANY_ADDRESS') || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC',
    weighbridgeId: SettingsService.get('WEIGHBRIDGE_ID') || process.env.WEIGHBRIDGE_ID || 'WB - 03',
    reportCompanyName: SettingsService.get('REPORT_COMPANY_NAME') || process.env.REPORT_COMPANY_NAME || 'DAYA CHARAN & COMPANY',
    logoPath: SettingsService.get('REPORT_LOGO_PATH') || process.env.REPORT_LOGO_PATH || '',
  };
}

function getSourceLocation() {
  return SettingsService.get('SITE_NAME') || SettingsService.get('COMPANY_ADDRESS') || '';
}

function enrichReportRow(row) {
  return normalizeReportRow(row);
}

function writeReportPdfBuffer(pdf, filenameBase) {
  const { year, month, day } = ts.parts();
  const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
  const filePath = path.join(dir, `${sanitizeExportBasename(filenameBase)}.pdf`);
  fs.writeFileSync(filePath, pdf);
  return filePath;
}

function filtersForClosedDataExport(filters = {}) {
  return { ...filters, ticket_status: 'CLOSED' };
}

function closedRowsForExport(rows = []) {
  return rows.filter(isClosedTrip);
}

function rowToExportValues(row, company) {
  const settings = company || getCompanySettings();
  const gross = splitDateTime(grossWeightTimestamp(row));
  const tare = splitDateTime(tareWeightTimestamp(row));
  const net = splitDateTime(reportListingTimestamp(row));

  return [
    row.slip_number,
    row.customer_name,
    row.truck_number,
    row.material,
    settings.reportCompanyName,
    row.operator_name,
    row.destination,
    row.gross_weight,
    row.tare_weight,
    row.net_weight,
    gross.date,
    gross.time,
    tare.date,
    tare.time,
    net.date,
    net.time,
    net.date,
  ];
}

function rowsByIds(transactionIds = []) {
  if (!transactionIds.length) return [];
  const placeholders = transactionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`${SELECT} WHERE t.id IN (${placeholders})`)
    .all(...transactionIds)
    .map(enrichReportRow);
  return sortRowsByTicketAsc(rows);
}

function describePeriod(filters = {}, periodLabel) {
  if (periodLabel) return periodLabel;
  if (filters.from && filters.to) {
    const fromDay = filters.from.slice(0, 10);
    const toDay = filters.to.slice(0, 10);
    return fromDay === toDay ? fromDay : `${fromDay} to ${toDay}`;
  }
  return 'All records';
}

function sanitizeExportBasename(name) {
  return String(name || 'report')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120) || 'report';
}

function buildExportBasename(filters = {}, periodLabel, rows) {
  if (filters.from && filters.to) {
    const fromDay = filters.from.slice(0, 10);
    const toDay = filters.to.slice(0, 10);
    if (fromDay && toDay) {
      return sanitizeExportBasename(
        fromDay === toDay ? fromDay : `${fromDay}_to_${toDay}`,
      );
    }
  }
  if (rows?.length) {
    const dates = rows
      .map(reportDateIso)
      .filter(Boolean)
      .sort();
    if (dates.length) {
      const from = dates[0];
      const to = dates[dates.length - 1];
      return sanitizeExportBasename(from === to ? from : `${from}_to_${to}`);
    }
  }
  if (periodLabel) {
    const label = String(periodLabel).split('·')[0].trim();
    if (label) return sanitizeExportBasename(label);
  }
  return 'all_records';
}

async function buildAndSavePdf(rows, options = {}) {
  const { filters = {}, periodLabel } = options;
  const filenameBase = options.filenamePrefix
    || buildExportBasename(filters, periodLabel, rows);
  const company = getCompanySettings();
  const summary = summarise(rows);
  const truncated = rows.length > MAX_TRIPS_PER_PDF;
  const exportRows = (truncated ? rows.slice(0, MAX_TRIPS_PER_PDF) : rows).map(enrichReportRow);

  const html = buildVehicleReportHtml(exportRows, {
    company,
    coverMeta: (exportRows.length > 1 || options.forceCover) ? {
      periodLabel: describePeriod(filters, periodLabel),
      generatedAt: ts.toDisplay(ts.now()),
      totalTickets: exportRows.length,
      gross: summary.gross,
      tare: summary.tare,
      net: summary.net,
    } : null,
  });

  const rendered = await renderHtmlToPdf(html);
  if (!rendered.ok) return rendered;

  const filePath = writeReportPdfBuffer(rendered.pdf, filenameBase);
  return {
    ok: true,
    path: filePath,
    count: exportRows.length,
    total: rows.length,
    truncated,
  };
}

async function writeExcelFile(rows, filenameBase) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Reports');

  sheet.addRow(EXPORT_HEADERS);
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E40AF' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  const company = getCompanySettings();
  for (const row of rows) {
    sheet.addRow(rowToExportValues(row, company));
  }

  sheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLength) maxLength = len;
    });
    column.width = Math.min(maxLength + 2, 40);
  });

  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const { year, month, day } = ts.parts();
  const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
  const filePath = path.join(dir, `${sanitizeExportBasename(filenameBase)}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

const ReportService = {
  getDailyReport(date) {
    const day = date || ts.toLocalDateIso(ts.todayStart());
    const { from, to } = ts.dayBoundsRange(day, day);
    const filters = { from, to };
    const rows = queryTransactions(filters);
    const summary = summariseFromDb(filters);

    return {
      date: day,
      total: rows.length,
      completed: summary.closed,
      pending: summary.open,
      failed: rows.filter((r) => r.status === 'failed' || r.status === 'error').length,
      grossTotal: summary.gross,
      tareTotal: summary.tare,
      netTotal: summary.net,
      transactions: rows,
      count: rows.length,
      rows,
      summary,
    };
  },

  getDateRangeReport(from, to, filters = {}) {
    const merged = {
      ...filters,
      from: from || filters.from,
      to: to || filters.to,
    };
    const rows = queryTransactions(merged);
    return { rows, summary: summariseFromDb(merged), filters: merged };
  },

  getFilteredReport(filters = {}) {
    if (filters.page != null || filters.limit != null) {
      return this.getPaginatedReport(filters);
    }
    const rows = queryTransactions(filters);
    return { rows, summary: summariseFromDb(filters), filters };
  },

  getPaginatedReport(filters = {}) {
    const { rows, pagination } = queryTransactionsPaginated(filters);
    return {
      rows,
      pagination,
      summary: summariseFromDb(filters),
      filters,
    };
  },

  getFilterOptions() {
    const db = getDb();
    const operators = db
      .prepare(
        `SELECT DISTINCT operator_name AS name FROM transactions
         WHERE operator_name IS NOT NULL AND operator_name != ''
         ORDER BY operator_name`,
      )
      .all()
      .map((r) => r.name);
    const materials = db
      .prepare(
        `SELECT DISTINCT material AS name FROM transactions
         WHERE material IS NOT NULL AND material != ''
         ORDER BY material`,
      )
      .all()
      .map((r) => r.name);
    return { operators, materials };
  },

  getReportPreviewHtml(transactionId) {
    const TransactionService = require('./TransactionService');
    const txn = TransactionService.getById(transactionId);
    if (!txn) {
      return { ok: false, error: 'Transaction not found' };
    }
    const row = enrichReportRow(txn);
    const html = buildVehicleReportHtml([row], { company: getCompanySettings() });
    return { ok: true, html, transactionId, slip_number: row.slip_number };
  },

  async exportCSV(filters = {}) {
    const exportFilters = filtersForClosedDataExport(filters);
    const rows = queryTransactionsForExport(exportFilters);
    if (!rows.length) {
      return { ok: false, error: 'No closed tickets match the selected filters' };
    }
    const company = getCompanySettings();
    const lines = [EXPORT_HEADERS.map(escapeCsv).join(',')];
    for (const r of rows) {
      lines.push(rowToExportValues(r, company).map(escapeCsv).join(','));
    }

    const basename = buildExportBasename(exportFilters);
    const { year, month, day } = ts.parts();
    const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
    const filePath = path.join(dir, `${basename}.csv`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    logger.info('CSV export complete', { path: filePath, count: rows.length });
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportExcel(filters = {}) {
    const exportFilters = filtersForClosedDataExport(filters);
    const rows = queryTransactionsForExport(exportFilters);
    if (!rows.length) {
      return { ok: false, error: 'No closed tickets match the selected filters' };
    }
    const basename = buildExportBasename(exportFilters);
    const filePath = await writeExcelFile(rows, basename);
    logger.info('Excel export complete', { path: filePath, count: rows.length });
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportExcelByIds(transactionIds = []) {
    const rows = closedRowsForExport(rowsByIds(transactionIds));
    if (!rows.length) return { ok: false, error: 'No closed tickets selected' };
    const basename = buildExportBasename({}, null, rows);
    const filePath = await writeExcelFile(rows, basename);
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportExcelPDF(filters = {}, options = {}) {
    const exportFilters = filtersForClosedDataExport(filters);
    const rows = queryTransactionsForExport(exportFilters);
    if (!rows.length) {
      return { ok: false, error: 'No closed tickets match the selected filters' };
    }
    const company = getCompanySettings();
    const dataRows = rows.map((row) => rowToExportValues(row, company));
    const summary = summarise(rows);
    const periodLabel = describePeriod(exportFilters, options.periodLabel);
    const html = buildExcelTablePdfHtml({
      headers: EXPORT_HEADERS,
      rows: dataRows,
      company,
      periodLabel,
      summary,
    });
    const rendered = await renderHtmlToPdf(html, { paperWidth: 11.69, paperHeight: 8.27 });
    if (!rendered.ok) return rendered;

    const basename = buildExportBasename(exportFilters, options.periodLabel, rows);
    const filePath = writeReportPdfBuffer(rendered.pdf, `${basename}_data`);
    logger.info('Excel-style PDF export complete', { path: filePath, count: rows.length });
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportExcelPDFByIds(transactionIds = [], options = {}) {
    const rows = closedRowsForExport(rowsByIds(transactionIds));
    if (!rows.length) return { ok: false, error: 'No closed tickets selected' };

    const company = getCompanySettings();
    const dataRows = rows.map((row) => rowToExportValues(row, company));
    const summary = summarise(rows);
    const html = buildExcelTablePdfHtml({
      headers: EXPORT_HEADERS,
      rows: dataRows,
      company,
      periodLabel: options.periodLabel || 'Selected closed tickets',
      summary,
    });
    const rendered = await renderHtmlToPdf(html, { paperWidth: 11.69, paperHeight: 8.27 });
    if (!rendered.ok) return rendered;

    const basename = buildExportBasename({}, options.periodLabel, rows);
    const filePath = writeReportPdfBuffer(rendered.pdf, `${basename}_data`);
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportPDF(filters = {}, options = {}) {
    const rows = queryTransactions(filters);
    if (!rows.length) return { ok: false, error: 'No tickets match the selected filters' };
    return buildAndSavePdf(rows, { filters, forceCover: true, ...options });
  },

  async exportPDFByIds(transactionIds = [], options = {}) {
    const rows = rowsByIds(transactionIds);
    if (!rows.length) return { ok: false, error: 'No tickets selected' };
    return buildAndSavePdf(rows, {
      forceCover: rows.length > 1,
      ...options,
      filenamePrefix: buildExportBasename({}, options.periodLabel, rows),
    });
  },

  resolveClosedReportPath(txn) {
    if (!txn || !isClosedTrip(txn)) return null;
    const candidates = [
      txn.report_path,
      txn.slip_number ? path.join(PATHS.REPORTS, `${txn.slip_number}_report.pdf`) : null,
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  },

  async exportTripPDF(transactionId) {
    const TransactionService = require('./TransactionService');
    const txn = TransactionService.getById(transactionId);
    if (!txn) {
      return { ok: false, error: 'Transaction not found' };
    }
    if (!isClosedTrip(txn)) {
      return { ok: false, error: 'Reports are only available for CLOSED tickets' };
    }

    const row = enrichReportRow(txn);
    const suggestedName = row.slip_number
      ? `${sanitizeExportBasename(row.slip_number)}_report.pdf`
      : 'trip_report.pdf';
    const existingPath = this.resolveClosedReportPath(row);
    if (existingPath) {
      return {
        ok: true,
        path: existingPath,
        transactionId,
        slip_number: row.slip_number,
        suggestedName,
        fromCache: true,
      };
    }
    const { photoPathForSlot } = require('../utils/reportPdfHtml');
    for (const pass of ['arrival', 'departure']) {
      for (let slot = 1; slot <= 3; slot += 1) {
        const photoPath = photoPathForSlot(row, pass, slot);
        if (photoPath && !fs.existsSync(photoPath)) {
          logger.warn('Report photo file missing on disk', {
            transactionId,
            pass,
            slot,
            path: photoPath,
          });
        }
      }
    }

    const day = reportDateIso(row);
    const vehicle = sanitizeExportBasename(row.truck_number || 'vehicle');
    const result = await buildAndSavePdf([row], {
      filenamePrefix: day ? `${day}_${vehicle}` : vehicle,
    });
    if (!result.ok) return result;

    if (row.slip_number) {
      const reportCopy = path.join(PATHS.REPORTS, `${row.slip_number}_report.pdf`);
      ensureDir(PATHS.REPORTS);
      fs.copyFileSync(result.path, reportCopy);
    }

    logger.info('Trip PDF export complete', { path: result.path, transactionId });
    return {
      ok: true,
      path: result.path,
      transactionId,
      slip_number: row.slip_number,
      suggestedName,
    };
  },

  async printReports(transactionIds = [], options = {}) {
    const rows = transactionIds.length ? rowsByIds(transactionIds) : [];
    if (!rows.length) return { ok: false, error: 'No tickets to print' };

    const company = getCompanySettings();
    const summary = summarise(rows);
    const html = buildVehicleReportHtml(rows.map(enrichReportRow), {
      company,
      coverMeta: rows.length > 1 ? {
        periodLabel: options.periodLabel || 'Selected tickets',
        generatedAt: ts.toDisplay(ts.now()),
        totalTickets: rows.length,
        gross: summary.gross,
        tare: summary.tare,
        net: summary.net,
      } : null,
    });

    return printHtml(html);
  },

  async printFilteredReports(filters = {}, options = {}) {
    const rows = queryTransactions(filters);
    if (!rows.length) return { ok: false, error: 'No tickets match the selected filters' };
    const ids = rows.slice(0, MAX_TRIPS_PER_PDF).map((r) => r.id);
    return this.printReports(ids, {
      periodLabel: describePeriod(filters, options.periodLabel),
    });
  },

  getSyncSummary() {
    const db = getDb();
    const totalSynced = db
      .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE sync_status = 'synced'`)
      .get().c;
    const totalPending = db
      .prepare(
        `SELECT COUNT(*) AS c FROM transactions WHERE sync_status IN ('pending', 'retry')`,
      )
      .get().c;
    const totalFailed = db
      .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE sync_status = 'failed'`)
      .get().c;
    const last = db
      .prepare(
        `SELECT MAX(timestamp_out) AS t FROM transactions WHERE sync_status = 'synced'`,
      )
      .get();
    return {
      totalSynced,
      totalPending,
      totalFailed,
      lastSyncAt: last?.t || null,
    };
  },

  getSlipPath(transactionId) {
    return PrintService.getSlipPath(transactionId);
  },

  async reprintSlip(transactionId) {
    return PrintService.reprintSlip(transactionId);
  },

  async printSlip(transactionId) {
    return this.reprintSlip(transactionId);
  },
};

module.exports = ReportService;
