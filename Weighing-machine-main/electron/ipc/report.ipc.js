'use strict';

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const ReportService = require('../../backend/services/ReportService');

const NAMESPACE = 'reports';

function exportFiltersForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return [{ name: 'PDF', extensions: ['pdf'] }];
  if (ext === '.xlsx') return [{ name: 'Excel', extensions: ['xlsx'] }];
  if (ext === '.csv') return [{ name: 'CSV', extensions: ['csv'] }];
  return [{ name: 'All files', extensions: ['*'] }];
}

async function promptSaveExport(result, options = {}) {
  if (!result?.ok || !result.path) return result;

  const defaultPath = options.defaultPath || path.basename(result.path);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: options.title || 'Save export',
    defaultPath,
    filters: exportFiltersForPath(result.path),
  });

  if (canceled || !filePath) {
    return { ...result, cancelled: true };
  }

  if (path.resolve(filePath) !== path.resolve(result.path)) {
    fs.copyFileSync(result.path, filePath);
  }

  return { ...result, path: filePath, savedToUser: true };
}

function showExportResult(result, label = 'Export complete') {
  if (result.cancelled) return;

  if (result.path) {
    dialog.showMessageBox({
      type: 'info',
      title: label,
      message: result.truncated
        ? `${label} (${result.count} of ${result.total} trips):\n${result.path}`
        : `${label} (${result.count || 0} record(s)):\n${result.path}`,
    });
  } else if (result.error) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Export failed',
      message: result.error,
    });
  }
}

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getDailyReport`, async (_e, date) =>
    ReportService.getDailyReport(date),
  );

  ipcMain.handle(`${NAMESPACE}:getDateRange`, async (_e, from, to, filters) =>
    ReportService.getDateRangeReport(from, to, filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getFilteredReport`, async (_e, filters) =>
    ReportService.getFilteredReport(filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getPaginatedReport`, async (_e, filters) =>
    ReportService.getPaginatedReport(filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getFilterOptions`, async () =>
    ReportService.getFilterOptions(),
  );

  ipcMain.handle(`${NAMESPACE}:getReportPreviewHtml`, async (_e, transactionId) =>
    ReportService.getReportPreviewHtml(transactionId),
  );

  ipcMain.handle(`${NAMESPACE}:getSyncSummary`, async () =>
    ReportService.getSyncSummary(),
  );

  ipcMain.handle(`${NAMESPACE}:getSlipPath`, async (_e, transactionId) =>
    ReportService.getSlipPath(transactionId),
  );

  ipcMain.handle(`${NAMESPACE}:reprintSlip`, async (_e, transactionId) =>
    ReportService.reprintSlip(transactionId),
  );

  ipcMain.handle(`${NAMESPACE}:exportCSV`, async (_e, filters) => {
    const result = await ReportService.exportCSV(filters || {});
    showExportResult(result, 'CSV export complete');
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:exportExcel`, async (_e, filters) => {
    const result = await ReportService.exportExcel(filters || {});
    showExportResult(result, 'Excel export complete');
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:exportExcelByIds`, async (_e, transactionIds) => {
    const result = await ReportService.exportExcelByIds(transactionIds || []);
    showExportResult(result, 'Excel export complete');
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:exportExcelPDF`, async (_e, filters, options) => {
    const result = await ReportService.exportExcelPDF(filters || {}, options || {});
    if (!result.ok) {
      showExportResult(result, 'PDF export failed');
      return result;
    }
    const saved = await promptSaveExport(result, {
      title: 'Save Excel report PDF',
      defaultPath: `${path.basename(result.path, path.extname(result.path))}.pdf`,
    });
    showExportResult(saved, 'Excel report PDF complete');
    return saved;
  });

  ipcMain.handle(`${NAMESPACE}:exportExcelPDFByIds`, async (_e, transactionIds, options) => {
    const result = await ReportService.exportExcelPDFByIds(transactionIds || [], options || {});
    if (!result.ok) {
      showExportResult(result, 'PDF export failed');
      return result;
    }
    const saved = await promptSaveExport(result, {
      title: 'Save Excel report PDF',
      defaultPath: `${path.basename(result.path, path.extname(result.path))}.pdf`,
    });
    showExportResult(saved, 'Excel report PDF complete');
    return saved;
  });

  ipcMain.handle(`${NAMESPACE}:exportPDF`, async (_e, filters, options) => {
    const result = await ReportService.exportPDF(filters || {}, options || {});
    if (!result.ok) {
      showExportResult(result, 'PDF export failed');
      return result;
    }
    const saved = await promptSaveExport(result, {
      title: 'Save PDF report pack',
      defaultPath: `${path.basename(result.path, path.extname(result.path))}.pdf`,
    });
    showExportResult(saved, 'PDF export complete');
    return saved;
  });

  ipcMain.handle(`${NAMESPACE}:exportPDFByIds`, async (_e, transactionIds, options) => {
    const result = await ReportService.exportPDFByIds(transactionIds || [], options || {});
    if (!result.ok) {
      showExportResult(result, 'PDF export failed');
      return result;
    }
    const saved = await promptSaveExport(result, {
      title: 'Save selected PDF reports',
      defaultPath: `${path.basename(result.path, path.extname(result.path))}.pdf`,
    });
    showExportResult(saved, 'PDF export complete');
    return saved;
  });

  ipcMain.handle(`${NAMESPACE}:exportTripPDF`, async (_e, transactionId) => {
    const result = await ReportService.exportTripPDF(transactionId);
    if (!result.ok) {
      showExportResult(result, 'Report download failed');
      return result;
    }

    const saved = await promptSaveExport(result, {
      title: 'Save closed ticket report',
      defaultPath: result.suggestedName || 'trip_report.pdf',
    });
    if (saved.cancelled) return saved;

    showExportResult(saved, 'Closed report downloaded');
    return saved;
  });

  ipcMain.handle(`${NAMESPACE}:printReports`, async (_e, transactionIds, options) =>
    ReportService.printReports(transactionIds || [], options || {}),
  );

  ipcMain.handle(`${NAMESPACE}:printFilteredReports`, async (_e, filters, options) =>
    ReportService.printFilteredReports(filters || {}, options || {}),
  );

  ipcMain.handle(`${NAMESPACE}:printSlip`, async (_e, transactionId) =>
    ReportService.printSlip(transactionId),
  );
}

module.exports = { register, NAMESPACE };
