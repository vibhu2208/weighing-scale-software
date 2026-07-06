'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Build a namespace where each key becomes an IPC invoker for
 * the channel `${namespace}:${method}`.
 */
function buildNamespace(namespace, methods) {
  return methods.reduce((acc, method) => {
    acc[method] = (...args) =>
      ipcRenderer.invoke(`${namespace}:${method}`, ...args);
    return acc;
  }, {});
}

const electronAPI = {
  transactions: buildNamespace('transactions', [
    'create',
    'getAll',
    'getById',
    'updateStatus',
    'getTodayStats',
  ]),

  tickets: buildNamespace('tickets', ['listOpen', 'cancel', 'manualCloseHywa']),

  vehicles: buildNamespace('vehicles', [
    'getAll',
    'create',
    'update',
    'delete',
    'findByRFID',
    'findByNumber',
    'search',
    'getWeighmentInfo',
  ]),

  devices: buildNamespace('devices', [
    'getStatus',
    'setWeighmentContext',
    'testConnection',
    'testExternalDisplay',
    'listSerialPorts',
    'probeWeighbridgePorts',
    'getRfidPower',
    'setRfidPower',
    'getTestConfig',
    'saveTestCapture',
    'saveTripCapture',
    'getRfidDisplayState',
    'syncRfid',
    'startRfidScan',
    'stopRfidScan',
    'startCameraPreview',
    'stopCameraPreview',
    'getCameraList',
    'getCameraPreviewStatus',
    'captureManualPhotos',
    'retryManualPhoto',
  ]),

  sync: buildNamespace('sync', [
    'getQueueStatus',
    'triggerManualSync',
    'getSyncHistory',
  ]),

  mcg: buildNamespace('mcg', ['testPost', 'resendSkipped']),

  workflow: buildNamespace('workflow', [
    'getState',
    'manualRFID',
    'acceptManualEntry',
    'abort',
    'clearSessionAfterSave',
    'retryPrint',
  ]),

  reports: buildNamespace('reports', [
    'getDailyReport',
    'getDateRange',
    'getFilteredReport',
    'getPaginatedReport',
    'getFilterOptions',
    'getReportPreviewHtml',
    'getSyncSummary',
    'getSlipPath',
    'reprintSlip',
    'exportCSV',
    'exportExcel',
    'exportExcelByIds',
    'exportExcelPDF',
    'exportExcelPDFByIds',
    'exportPDF',
    'exportPDFByIds',
    'exportTripPDF',
    'printReports',
    'printFilteredReports',
    'printSlip',
    'listRecentClosedReports',
    'getClosedReportBySlip',
    'adminUpdateClosedReport',
    'updateSlipNumber',
    'adminDeleteClosedReport',
  ]),

  backup: buildNamespace('backup', [
    'getList',
    'manualBackup',
    'manualLocalBackup',
    'getLastBackupTime',
    'getCloudStatus',
    'listRemoteBackups',
    'restoreBackup',
  ]),

  storage: buildNamespace('storage', [
    'getStorageStats',
    'runCleanup',
    'listThermalQueue',
    'resendThermal',
    'readMediaDataUrl',
  ]),

  settings: buildNamespace('settings', [
    'get',
    'set',
    'getAll',
    'getMaterials',
    'setMaterials',
    'getCustomers',
    'setCustomers',
    'getDestinations',
    'setDestinations',
    'getOperators',
    'setOperators',
  ]),

  auth: buildNamespace('auth', [
    'verifyPin',
    'lockAdvanced',
    'getSession',
    'verifyManualHywaPin',
    'lockManualHywaClose',
    'getManualHywaCloseSession',
  ]),

  /**
   * Subscribe to backend push events (device status, weight ticks, sync progress, etc.).
   * Returns a disposer.
   */
  on(channel, listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /** Lightweight handshake helper – useful for the "IPC bridge loaded?" check. */
  ping: () => 'pong',

  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
};

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[preload] Failed to expose electronAPI:', err);
}
