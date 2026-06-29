/**
 * API wrapper for Electron IPC (desktop) or HTTP (Docker / browser server mode).
 */

const API_BASE = import.meta.env.VITE_API_BASE || '';

const hasBridge = () =>
  typeof window !== 'undefined' && !!window.electronAPI;

export function isIpcReady() {
  return hasBridge() || typeof fetch !== 'undefined';
}

async function httpCall(namespace, method, args) {
  const res = await fetch(`${API_BASE}/api/${namespace}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json.data;
}

async function safeCall(namespace, method, args) {
  try {
    if (hasBridge()) {
      const ns = window.electronAPI[namespace];
      if (!ns || typeof ns[method] !== 'function') {
        throw new Error(`IPC method not found: ${namespace}.${method}`);
      }
      return await ns[method](...args);
    }
    return await httpCall(namespace, method, args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ipc] ${namespace}.${method} failed:`, err);
    const wrapped = new Error(
      `${namespace}.${method} failed: ${err && err.message ? err.message : 'unknown error'}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

function makeProxy(namespace, methods) {
  return methods.reduce((acc, method) => {
    acc[method] = (...args) => safeCall(namespace, method, args);
    return acc;
  }, {});
}

export const ticketAPI = makeProxy('tickets', ['listOpen', 'cancel', 'manualCloseHywa']);

export const transactionAPI = makeProxy('transactions', [
  'create',
  'getAll',
  'getById',
  'updateStatus',
  'getTodayStats',
]);

export const vehicleAPI = makeProxy('vehicles', [
  'getAll',
  'create',
  'update',
  'delete',
  'findByRFID',
  'findByNumber',
  'search',
  'getWeighmentInfo',
]);

export const deviceAPI = makeProxy('devices', [
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
]);

export const syncAPI = makeProxy('sync', [
  'getQueueStatus',
  'triggerManualSync',
  'getSyncHistory',
]);

export const mcgAPI = makeProxy('mcg', ['testPost']);

export const reportAPI = makeProxy('reports', [
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
]);

export const backupAPI = makeProxy('backup', [
  'getList',
  'manualBackup',
  'manualLocalBackup',
  'getLastBackupTime',
  'getCloudStatus',
  'listRemoteBackups',
  'restoreBackup',
]);

export const storageAPI = makeProxy('storage', [
  'getStorageStats',
  'runCleanup',
  'listThermalQueue',
  'resendThermal',
  'readMediaDataUrl',
]);

export const settingsAPI = makeProxy('settings', [
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
]);

export const authAPI = makeProxy('auth', [
  'verifyPin',
  'lockAdvanced',
  'getSession',
  'verifyManualHywaPin',
  'lockManualHywaClose',
  'getManualHywaCloseSession',
]);

export const workflowAPI = makeProxy('workflow', [
  'getState',
  'manualRFID',
  'acceptManualEntry',
  'abort',
  'clearSessionAfterSave',
  'retryPrint',
]);

let eventSource = null;
const sseListeners = new Map();

function ensureEventSource() {
  if (eventSource || typeof EventSource === 'undefined') return;
  eventSource = new EventSource(`${API_BASE}/api/events`);
  eventSource.onmessage = (event) => {
    try {
      const { channel, payload } = JSON.parse(event.data);
      const listeners = sseListeners.get(channel);
      if (listeners) listeners.forEach((fn) => fn(payload));
    } catch (_err) {
      /* ignore malformed events */
    }
  };
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    setTimeout(ensureEventSource, 3000);
  };
}

/** Subscribe to a backend push channel; returns a disposer. */
export function subscribe(channel, listener) {
  if (hasBridge() && typeof window.electronAPI.on === 'function') {
    return window.electronAPI.on(channel, listener);
  }

  ensureEventSource();
  if (!sseListeners.has(channel)) sseListeners.set(channel, new Set());
  sseListeners.get(channel).add(listener);
  return () => sseListeners.get(channel)?.delete(listener);
}

export default {
  isIpcReady,
  ticketAPI,
  transactionAPI,
  vehicleAPI,
  deviceAPI,
  syncAPI,
  reportAPI,
  backupAPI,
  storageAPI,
  settingsAPI,
  authAPI,
  workflowAPI,
  subscribe,
};
