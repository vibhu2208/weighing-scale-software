'use strict';

const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { getDb } = require('../database/db');
const RealRFIDAdapter = require('../adapters/real/RealRFIDAdapter');
const RealWeighbridgeAdapter = require('../adapters/real/RealWeighbridgeAdapter');
const RealCameraAdapter = require('../adapters/real/RealCameraAdapter');
const WebcamCameraAdapter = require('../adapters/real/WebcamCameraAdapter');
const RfidTagSelector = require('./RfidTagSelector');
const RfidBlocklistService = require('./RfidBlocklistService');

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HEALTH_INTERVAL_MS = parsePositiveInt(process.env.DEVICE_STATUS_INTERVAL_MS, 2000);
const STATUS_FULL_INTERVAL_MS = parsePositiveInt(process.env.DEVICE_STATUS_FULL_INTERVAL_MS, 10000);
const STATUS_COUNT_CACHE_MS = 5000;
const CAMERA_FRAME_MIN_MS = 500;
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 80000];
const MAX_RETRIES = 5;

let started = false;
let getMainWindow = () => null;

let rfidAdapter = null;
let rfidAdapters = [];
let weighbridgeAdapter = null;
let cameraAdapter = null;

let latestStatus = null;
let healthTimer = null;
let statusFullTimer = null;
let lastRfidSeen = null;
let cachedOpenTxnCount = { value: 0, at: 0 };
let cachedPendingSyncCount = { value: 0, at: 0 };
const lastCameraFrameAt = new Map();
let rfidScanning = false;
let latestRawWeight = 0;
let weighmentContext = { truckNumber: null, rfidTag: null };
let displayResyncTimer = null;
const DISPLAY_RESYNC_MS = 5000;
let cloudReachable = false;
let cloudStatusCheckedAt = 0;
const CLOUD_STATUS_TTL_MS = 30000;

const retryState = {
  weighbridge: { attempts: 0, timer: null },
  camera: { attempts: 0, timer: null },
};
const rfidRetryState = new Map();

const ENV_PREFERRED_KEYS = new Set([
  'USE_WEBCAM_CAMERA',
  'RFID_IP',
  'RFID_IPS',
  'RFID_PORT',
  'RFID_ANT_MASK',
  'RFID_DEBOUNCE_MS',
  'RFID_ANTENNA_POWER',
]);

function readSettingValue(key) {
  if (
    ENV_PREFERRED_KEYS.has(key) &&
    process.env[key] !== undefined &&
    process.env[key] !== ''
  ) {
    return String(process.env[key]);
  }

  try {
    const SettingsService = require('./SettingsService');
    const value = SettingsService.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  } catch (_e) {
    /* DB may not be ready during early init */
  }
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return String(process.env[key]);
  }
  return '';
}

function settingFlagTrue(key, defaultValue = false) {
  const raw = readSettingValue(key);
  if (!raw) return defaultValue;
  const flag = raw.toLowerCase();
  return flag === 'true' || flag === '1';
}

function useWebcamCamera() {
  return settingFlagTrue('USE_WEBCAM_CAMERA', false);
}

function buildConfig() {
  let settings = {};
  try {
    const SettingsService = require('./SettingsService');
    settings = SettingsService.getAll();
  } catch (_e) {
    /* DB may not be ready during early init */
  }

  const pick = (key, envKey) =>
    settings[key] || process.env[envKey || key] || undefined;
  const pickPreferEnv = (key, envKey) =>
    process.env[envKey || key] || settings[key] || undefined;
  const pickHardware = (key, envKey) => {
    const envVal = process.env[envKey || key];
    if (envVal !== undefined && envVal !== '') return envVal;
    return settings[key] || undefined;
  };

  return {
    rfid: {
      ip: pickHardware('RFID_IP'),
      ips: pickHardware('RFID_IPS'),
      port: pickHardware('RFID_PORT'),
      antMask: Number(pick('RFID_ANT_MASK')) || 1,
      debounceMs: Number(pick('RFID_DEBOUNCE_MS')) || 2500,
      antennaPower: Number(pick('RFID_ANTENNA_POWER')) || 20,
    },
    weighbridge: {
      comPort: settings.WEIGHBRIDGE_COM_PORT || pickPreferEnv('WEIGHBRIDGE_COM_PORT'),
      baudRate: settings.WEIGHBRIDGE_BAUD_RATE || pickPreferEnv('WEIGHBRIDGE_BAUD_RATE'),
      dataBits: settings.WEIGHBRIDGE_DATA_BITS || pickPreferEnv('WEIGHBRIDGE_DATA_BITS'),
      parity: settings.WEIGHBRIDGE_PARITY || pickPreferEnv('WEIGHBRIDGE_PARITY'),
      stopBits: settings.WEIGHBRIDGE_STOP_BITS || pickPreferEnv('WEIGHBRIDGE_STOP_BITS'),
    },
    externalDisplay: {
      enabled: pick('EXTERNAL_DISPLAY_ENABLED', 'EXTERNAL_DISPLAY_ENABLED'),
      comPort: settings.EXTERNAL_DISPLAY_COM_PORT || pick('EXTERNAL_DISPLAY_COM_PORT'),
      baudRate: settings.EXTERNAL_DISPLAY_BAUD_RATE || pick('EXTERNAL_DISPLAY_BAUD_RATE'),
      dataBits: settings.EXTERNAL_DISPLAY_DATA_BITS || pick('EXTERNAL_DISPLAY_DATA_BITS'),
      parity: settings.EXTERNAL_DISPLAY_PARITY || pick('EXTERNAL_DISPLAY_PARITY'),
      stopBits: settings.EXTERNAL_DISPLAY_STOP_BITS || pick('EXTERNAL_DISPLAY_STOP_BITS'),
      channel: settings.EXTERNAL_DISPLAY_CHANNEL || pick('EXTERNAL_DISPLAY_CHANNEL'),
      command: settings.EXTERNAL_DISPLAY_COMMAND || pick('EXTERNAL_DISPLAY_COMMAND'),
      decimalPlaces: settings.EXTERNAL_DISPLAY_DECIMAL_PLACES || pick('EXTERNAL_DISPLAY_DECIMAL_PLACES'),
    },
    camera: {
      rtspUrl: pick('CAMERA_RTSP_URL'),
      rtspUrlAlternates: pick('CAMERA_RTSP_URL_ALTERNATES'),
      httpSnapshotUrl: pick('CAMERA_HTTP_SNAPSHOT_URL'),
      rtspUrls: pick('CAMERA_RTSP_URLS'),
      user: pick('CAMERA_RTSP_USER'),
      password: pick('CAMERA_RTSP_PASSWORD'),
      path: pick('CAMERA_RTSP_PATH'),
      port: pick('CAMERA_RTSP_PORT'),
    },
  };
}

function parseRfidIps(rawValue) {
  if (!rawValue) return [];
  return String(rawValue)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getActiveRfidAdapters() {
  if (Array.isArray(rfidAdapters) && rfidAdapters.length > 0) {
    return rfidAdapters;
  }
  return rfidAdapter ? [rfidAdapter] : [];
}

function getRfidRetryKey(adapter) {
  const ip = adapter?.config?.ip;
  if (ip) return `rfid:${ip}`;
  return `rfid:${adapter?.config?.readerId || 'unknown'}`;
}

function getRetryState(key) {
  if (String(key).startsWith('rfid:')) {
    if (!rfidRetryState.has(key)) {
      rfidRetryState.set(key, { attempts: 0, timer: null });
    }
    return rfidRetryState.get(key);
  }
  return retryState[key];
}

function clearRfidRetryTimers() {
  for (const state of rfidRetryState.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
  rfidRetryState.clear();
}

function buildRfidReaderStatus(adapter, index) {
  const row = deviceRow(adapter, 'rfid', {
    readerId: adapter?.config?.readerId || `reader-${index + 1}`,
    ip: adapter?.config?.ip || null,
    scanning: rfidScanning && !!adapter?.isConnected?.(),
  });
  return row;
}

function readCachedCount(cache, sql) {
  const now = Date.now();
  if (now - cache.at < STATUS_COUNT_CACHE_MS) return cache.value;
  try {
    const row = getDb().prepare(sql).get();
    cache.value = row ? row.count : 0;
    cache.at = now;
    return cache.value;
  } catch (_e) {
    return cache.value;
  }
}

function countOpenTransactions() {
  return readCachedCount(
    cachedOpenTxnCount,
    `SELECT COUNT(*) AS count FROM transactions
     WHERE status IN ('pending', 'weighing')`,
  );
}

function countPendingSync() {
  return readCachedCount(
    cachedPendingSyncCount,
    `SELECT COUNT(*) AS count FROM transactions
     WHERE sync_status IN ('pending', 'retry')`,
  );
}

function invalidateStatusCountCache() {
  cachedOpenTxnCount.at = 0;
  cachedPendingSyncCount.at = 0;
}

function patchWeighbridgeInCache(payload) {
  if (!latestStatus) latestStatus = buildStatusSnapshot();
  if (!latestStatus.weighbridge) return;
  latestStatus.weighbridge.currentWeight = payload?.weight ?? 0;
  latestStatus.weighbridge.rawWeight = payload?.rawWeight ?? payload?.weight ?? 0;
  latestStatus.weighbridge.isStable = !!payload?.isStable;
  if (payload?.weightReleaseActive != null) {
    latestStatus.weighbridge.weightReleaseActive = !!payload.weightReleaseActive;
  }
  latestStatus.weighbridge.lastSeen = ts.now();
}

function setWeighmentContext({ truckNumber, rfidTag } = {}) {
  const truck = truckNumber
    ? String(truckNumber).trim().toUpperCase()
    : null;
  const tag = rfidTag ? String(rfidTag).trim().toUpperCase() : null;
  const prevTruck = weighmentContext.truckNumber;
  weighmentContext = {
    truckNumber: truck || null,
    rfidTag: tag || null,
  };
  if (truck !== prevTruck) {
    try {
      const WeightAdjustmentService = require('./WeightAdjustmentService');
      if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
        WeightAdjustmentService.clearLiveRamp();
      }
    } catch (_e) {
      /* optional */
    }
  }
  try {
    broadcastLiveWeight();
  } catch (_e) {
    /* optional */
  }
}

function getWeighmentContext() {
  return { ...weighmentContext };
}

function clearWeighmentContext() {
  weighmentContext = { truckNumber: null, rfidTag: null };
  try {
    const WeightAdjustmentService = require('./WeightAdjustmentService');
    if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
      WeightAdjustmentService.clearLiveRamp();
    }
  } catch (_e) {
    /* optional */
  }
}

function deviceRow(adapter, type, extra = {}) {
  if (!adapter) {
    return {
      type,
      connected: false,
      mode: 'unknown',
      lastSeen: null,
      ...extra,
    };
  }
  const st = adapter.getStatus();
  return {
    type: st.type || type,
    connected: !!st.connected,
    mode: st.mode || adapter.constructor.name,
    lastSeen: ts.now(),
    ...extra,
    ...(type === 'rfid'
      ? {
          lastError: st.lastError || null,
          reconnecting: !!st.reconnecting,
        }
      : {}),
    ...(type === 'weighbridge'
      ? {
          currentWeight: extra.currentWeight ?? st.currentWeight ?? 0,
          rawWeight: extra.rawWeight ?? st.currentWeight ?? 0,
          isStable: extra.isStable != null ? !!extra.isStable : !!st.isStable,
        }
      : {}),
  };
}

function getCloudConnected() {
  try {
    const SyncService = require('./SyncService');
    if (!SyncService.isCloudConfigured()) return false;
    return cloudReachable;
  } catch (_e) {
    return false;
  }
}

async function refreshCloudStatus(force = false) {
  const now = Date.now();
  if (!force && now - cloudStatusCheckedAt < CLOUD_STATUS_TTL_MS) {
    return cloudReachable;
  }

  cloudStatusCheckedAt = now;
  try {
    const SyncService = require('./SyncService');
    if (!SyncService.isCloudConfigured()) {
      cloudReachable = false;
      return false;
    }
    cloudReachable = await SyncService.testConnection();
    return cloudReachable;
  } catch (_e) {
    cloudReachable = false;
    return false;
  }
}

function buildStatusSnapshot(options = {}) {
  const { includeQueueCounts = true } = options;
  const cloudConnected = getCloudConnected();
  const activeRfidAdapters = getActiveRfidAdapters();
  const rfidConnectedCount = activeRfidAdapters.filter((a) => a?.isConnected?.()).length;
  const readerStatuses = activeRfidAdapters.map((adapter, index) =>
    buildRfidReaderStatus(adapter, index),
  );
  const pendingCount = includeQueueCounts
    ? countPendingSync()
    : latestStatus?.cloud?.pendingCount ?? 0;

  const anyReaderReconnecting = readerStatuses.some((r) => r.reconnecting);
  const aggregateLastError =
    readerStatuses.find((r) => !r.connected && r.lastError)?.lastError ||
    rfidAdapter?.getStatus?.()?.lastError ||
    null;

  const rfidStatus = deviceRow(rfidAdapter, 'rfid', {
    scanning: rfidScanning,
    readerCount: activeRfidAdapters.length,
    connectedReaders: rfidConnectedCount,
    readers: readerStatuses,
    lastError: aggregateLastError,
    reconnecting: anyReaderReconnecting,
  });
  if (rfidConnectedCount > 0) {
    rfidStatus.connected = true;
  }

  return {
    rfid: rfidStatus,
    weighbridge: (() => {
      const WeightReleaseService = require('./WeightReleaseService');
      return deviceRow(weighbridgeAdapter, 'weighbridge', {
        currentWeight: getWeighbridgeDisplayWeight(),
        rawWeight: getWeighbridgeRawWeight(),
        isStable: weighbridgeAdapter?.isStable ?? false,
        weightReleaseActive: WeightReleaseService.isActive(),
      });
    })(),
    camera: deviceRow(cameraAdapter, 'camera'),
    externalDisplay: (() => {
      try {
        const ExternalDisplayService = require('./ExternalDisplayService');
        const snap = ExternalDisplayService.getSnapshot();
        return {
          type: 'externalDisplay',
          connected: !!snap.connected,
          enabled: !!snap.enabled,
          port: snap.port || null,
          lastSentWeight: snap.lastSentWeight,
          lastRequestedWeight: snap.lastRequestedWeight,
          lastWriteOk: snap.lastWriteOk,
          lastWriteError: snap.lastWriteError || null,
          lastSkipReason: snap.lastSkipReason || null,
          lastSeen: snap.lastWriteAt ? new Date(snap.lastWriteAt).toISOString() : null,
        };
      } catch (_e) {
        return {
          type: 'externalDisplay',
          connected: false,
          enabled: false,
          port: null,
          lastSentWeight: null,
          lastSeen: null,
        };
      }
    })(),
    cloud: {
      connected: cloudConnected,
      lastSync: latestStatus?.cloud?.lastSync ?? null,
      pendingCount,
    },
  };
}

function pushStatusToRenderer(snapshot) {
  latestStatus = snapshot;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('device:statusUpdate', latestStatus);
  }
}

function emitStatusUpdate(options = {}) {
  pushStatusToRenderer(buildStatusSnapshot(options));
}

function emitLightStatusUpdate() {
  pushStatusToRenderer(buildStatusSnapshot({ includeQueueCounts: false }));
}

function emitEvent(channel, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/** Throttle large JPEG frames so IPC does not freeze the renderer. */
function emitCameraFrame(cameraId, frame) {
  const key = cameraId || 'default';
  const now = Date.now();
  const last = lastCameraFrameAt.get(key) || 0;
  if (now - last < CAMERA_FRAME_MIN_MS) return;
  lastCameraFrameAt.set(key, now);
  emitEvent('device:cameraFrame', { cameraId, frame });
}

function logDeviceError(deviceType, message, metadata = {}) {
  logger.logDevice(deviceType, 'error', message, metadata);
}

function clearRetryTimer(retryKey) {
  const state = getRetryState(retryKey);
  if (state && state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleReconnect(retryKey, adapter, deviceType = null) {
  const state = getRetryState(retryKey);
  const label = deviceType || retryKey;
  if (!adapter || state.attempts >= MAX_RETRIES) {
    if (state.attempts >= MAX_RETRIES) {
      const msg = `${label} exceeded max reconnect attempts (${MAX_RETRIES})`;
      logger.error(msg, { retryKey, ip: adapter?.config?.ip || null });
      logDeviceError(label, msg, {
        critical: true,
        ip: adapter?.config?.ip || null,
      });
      emitEvent('device:criticalError', {
        deviceType: label,
        message: msg,
        ip: adapter?.config?.ip || null,
      });
    }
    return;
  }

  const delay = RETRY_DELAYS_MS[state.attempts] || 80000;
  state.attempts += 1;

  logger.info(`Scheduling ${label} reconnect`, {
    retryKey,
    ip: adapter?.config?.ip || null,
    attempt: state.attempts,
    delayMs: delay,
  });

  clearRetryTimer(retryKey);
  state.timer = setTimeout(async () => {
    state.timer = null;
    try {
      if (typeof adapter.simulateReconnect === 'function') {
        await adapter.simulateReconnect();
      } else {
        await adapter.connect();
      }
      state.attempts = 0;
      if (adapter && typeof adapter === 'object') {
        adapter._reconnecting = false;
        adapter._lastError = null;
      }
      logger.logDevice(label, 'reconnect', `${label} reconnected`, {
        ip: adapter?.config?.ip || null,
      });
      emitStatusUpdate();
    } catch (err) {
      logDeviceError(label, `Reconnect failed: ${err.message}`, {
        ip: adapter?.config?.ip || null,
      });
      scheduleReconnect(retryKey, adapter, label);
    }
  }, delay);
  if (state.timer.unref) state.timer.unref();
}

function handleAdapterError(deviceType, adapter, err) {
  const message = err && err.message ? err.message : String(err);
  logDeviceError(deviceType, message);
  adapter.connected = false;
  if (adapter && typeof adapter === 'object') {
    adapter._lastError = message;
    adapter._reconnecting = true;
  }
  emitStatusUpdate();
  scheduleReconnect(deviceType, adapter, deviceType);
}

function handleRfidAdapterError(adapter, err) {
  const message = err && err.message ? err.message : String(err);
  const ip = adapter?.config?.ip || null;
  const retryKey = getRfidRetryKey(adapter);
  const state = getRetryState(retryKey);
  if (state.timer) return;

  logDeviceError('rfid', message, { ip });
  adapter.connected = false;
  if (adapter && typeof adapter === 'object') {
    adapter._lastError = message;
    adapter._reconnecting = true;
  }
  emitStatusUpdate();
  scheduleReconnect(getRfidRetryKey(adapter), adapter, 'rfid');
}

function wireRfidSelection() {
  RfidTagSelector.onSelected((payload) => {
    emitEvent('device:rfidTag', { ...payload, locked: true });
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      if (WorkflowEngine && typeof WorkflowEngine.handleRfidTag === 'function') {
        WorkflowEngine.handleRfidTag(payload);
      }
    } catch (err) {
      logger.warn('WorkflowEngine RFID handler error', { message: err.message });
    }
  });
}

function wireRfidAdapter(adapter, sourceLabel = null) {
  adapter.onTagDetected((payload) => {
    if (!rfidScanning) return;
    if (RfidBlocklistService.logIfBlocked(payload?.tag, 'live')) {
      if (lastRfidSeen && RfidBlocklistService.isBlocked(lastRfidSeen.tag)) {
        lastRfidSeen = null;
      }
      return;
    }
    const enrichedPayload = {
      ...payload,
      sourceReader: sourceLabel || payload?.readerName || null,
      sourceIp: adapter?.config?.ip || null,
    };
    lastRfidSeen = enrichedPayload;
    if (!RfidTagSelector.isLocked()) {
      emitEvent('device:rfidLive', enrichedPayload);
    }
    RfidTagSelector.onRawTag(enrichedPayload);
  });

  adapter.onError((err) => handleRfidAdapterError(adapter, err));
  adapter.onReconnect(() => {
    const state = getRetryState(getRfidRetryKey(adapter));
    state.attempts = 0;
    if (adapter && typeof adapter === 'object') {
      adapter._reconnecting = false;
      adapter._lastError = null;
    }
    emitStatusUpdate();
  });
}

function resolvePassFromWeighmentInfo(truck, rfidTag, vehicleTypeHint) {
  const { resolveAdjustmentPass } = require('../utils/vehicleTypes');
  const TransactionService = require('./TransactionService');
  const info = TransactionService.getVehicleWeighmentInfo(truck, rfidTag);
  const isClose = info.mode === 'CLOSE';
  return resolveAdjustmentPass({
    vehicleType: vehicleTypeHint || info.vehicleType,
    isClose,
  });
}

function getWorkflowPassForAdjustment() {
  const { resolveAdjustmentPass } = require('../utils/vehicleTypes');

  try {
    const WorkflowEngine = require('../engine/WorkflowEngine');
    const state = WorkflowEngine.getCurrentState?.();
    const wfPass = state?.context?.pass;
    if (wfPass === 'TARE' || wfPass === 'GROSS') return wfPass;

    const truck = state?.context?.truckNumber;
    const vehicleType = state?.context?.vehicle?.vehicle_type || null;
    if (truck) {
      return resolvePassFromWeighmentInfo(
        truck,
        state?.context?.rfidTag,
        vehicleType,
      );
    }
  } catch (_e) {
    /* optional */
  }

  try {
    if (RfidTagSelector.isLocked()) {
      const tag = RfidTagSelector.getLockedTag();
      const VehicleService = require('./VehicleService');
      const vehicle = VehicleService.findByRFID(tag);
      if (vehicle?.vehicle_number) {
        return resolvePassFromWeighmentInfo(
          vehicle.vehicle_number,
          tag,
          vehicle.vehicle_type,
        );
      }
    }
  } catch (_e) {
    /* optional */
  }

  try {
    const truck = weighmentContext.truckNumber;
    if (truck) {
      return resolvePassFromWeighmentInfo(
        truck,
        weighmentContext.rfidTag,
        null,
      );
    }
  } catch (_e) {
    /* optional */
  }

  return 'TARE';
}

function resolveLiveDisplayWeight(rawKg, options = {}) {
  const raw = Math.round(Number(rawKg));
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  const WeightReleaseService = require('./WeightReleaseService');
  const released = WeightReleaseService.resolveDisplayKg(raw);
  if (released != null) return released;

  const WeightAdjustmentService = require('./WeightAdjustmentService');
  const pass = getWorkflowPassForAdjustment();
  const isStable =
    options.isStable != null ? !!options.isStable : isWeighbridgeStable();
  return WeightAdjustmentService.resolveLiveDisplay(raw, pass, { isStable });
}

function applyLiveWeightAdjustment(rawKg, options = {}) {
  return resolveLiveDisplayWeight(rawKg, options);
}

function getWeighbridgeRawWeight() {
  const raw = Math.round(
    Number(weighbridgeAdapter?.currentWeight ?? latestRawWeight ?? 0),
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function getWeighbridgeDisplayWeight() {
  return applyLiveWeightAdjustment(getWeighbridgeRawWeight(), {
    isStable: isWeighbridgeStable(),
  });
}

function buildAdjustedWeightPayload(payload) {
  const raw = Math.round(Number(payload?.weight ?? 0));
  latestRawWeight = Number.isFinite(raw) ? raw : 0;

  const WeightReleaseService = require('./WeightReleaseService');
  const released = WeightReleaseService.resolveDisplayKg(latestRawWeight);
  if (released != null) {
    return {
      ...payload,
      rawWeight: latestRawWeight,
      weight: released,
      weightReleaseActive: true,
    };
  }

  return {
    ...payload,
    rawWeight: latestRawWeight,
    weight: applyLiveWeightAdjustment(latestRawWeight, {
      isStable: !!payload?.isStable,
    }),
    weightReleaseActive: false,
  };
}

function isWeighbridgeStable() {
  const snap = weighbridgeAdapter?.bridgeService?.getSnapshot?.();
  if (snap && typeof snap.isStable === 'boolean') {
    return snap.isStable;
  }
  return !!weighbridgeAdapter?.isStable;
}

function startDisplayResyncTimer() {
  stopDisplayResyncTimer();
  displayResyncTimer = setInterval(() => {
    try {
      const ExternalDisplayService = require('./ExternalDisplayService');
      if (!ExternalDisplayService.isEnabled()) return;
      const rawKg = getWeighbridgeRawWeight();
      if (rawKg <= 0) return;
      if (!isWeighbridgeStable()) return;
      pushWeightToExternalDisplay(rawKg, 'keepalive');
    } catch (_e) {
      /* optional */
    }
  }, DISPLAY_RESYNC_MS);
  if (displayResyncTimer.unref) displayResyncTimer.unref();
}

function stopDisplayResyncTimer() {
  if (displayResyncTimer) {
    clearInterval(displayResyncTimer);
    displayResyncTimer = null;
  }
}

/** External LED mirrors software display (adjusted / release weight). */
function getExternalDisplayWeight() {
  return getWeighbridgeDisplayWeight();
}

function pushWeightToExternalDisplay(_kg, source = 'unknown') {
  try {
    const ExternalDisplayService = require('./ExternalDisplayService');
    if (!ExternalDisplayService.isEnabled()) return;

    const scaleRawKg = getWeighbridgeRawWeight();
    const displayKg = getWeighbridgeDisplayWeight();

    if (source === 'weightZero') {
      ExternalDisplayService.updateWeight(0, {
        source: 'weightZero',
        scaleRawKg: 0,
      });
      return;
    }

    if (displayKg <= 0) {
      return;
    }

    logger.logDevice('externalDisplay', 'push', 'Routing display weight to external display', {
      source,
      scaleRawKg,
      sendingKg: displayKg,
    });

    ExternalDisplayService.updateWeight(displayKg, {
      source,
      scaleRawKg,
      confirm: source === 'stableWeight' && displayKg > 0,
    });
  } catch (err) {
    logger.logDevice('externalDisplay', 'error', 'pushWeightToExternalDisplay failed', {
      source,
      error: err.message,
    });
  }
}

function wireWeighbridgeAdapter(adapter) {
  adapter.onWeightUpdate((payload) => {
    const adjustedPayload = buildAdjustedWeightPayload(payload);
    emitEvent('device:weightUpdate', adjustedPayload);
    patchWeighbridgeInCache(adjustedPayload);
    const rawKg = getWeighbridgeRawWeight();
    if (rawKg > 0) {
      pushWeightToExternalDisplay(rawKg, 'weightUpdate');
    }
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onWeightUpdate(adjustedPayload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onStableWeight((payload) => {
    const adjustedPayload = buildAdjustedWeightPayload({
      ...payload,
      isStable: true,
    });
    const rawKg = getWeighbridgeRawWeight();
    if (rawKg === 0) {
      pushWeightToExternalDisplay(0, 'weightZero');
    } else {
      pushWeightToExternalDisplay(rawKg, 'stableWeight');
    }
    emitEvent('device:stableWeight', adjustedPayload);
    patchWeighbridgeInCache({
      weight: adjustedPayload.weight,
      rawWeight: adjustedPayload.rawWeight,
      isStable: true,
    });
    emitLightStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      if (typeof WorkflowEngine.onStableWeight === 'function') {
        WorkflowEngine.onStableWeight(adjustedPayload);
      }
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onWeightZero((payload) => {
    latestRawWeight = 0;
    try {
      const WeightReleaseService = require('./WeightReleaseService');
      WeightReleaseService.clear();
      const WeightAdjustmentService = require('./WeightAdjustmentService');
      if (typeof WeightAdjustmentService.clearLiveRamp === 'function') {
        WeightAdjustmentService.clearLiveRamp();
      }
    } catch (_e) {
      /* optional */
    }
    pushWeightToExternalDisplay(0, 'weightZero');
    emitEvent('device:weightZero', payload);
    patchWeighbridgeInCache({ weight: 0, rawWeight: 0, isStable: true });
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onWeightZero(payload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onError((err) => handleAdapterError('weighbridge', adapter, err));
  adapter.onReconnect(() => {
    retryState.weighbridge.attempts = 0;
    emitStatusUpdate();
  });
}

function wireCameraAdapter(adapter) {
  adapter.onError((err) => handleAdapterError('camera', adapter, err));
  if (typeof adapter.onReconnect === 'function') {
    adapter.onReconnect(() => {
      retryState.camera.attempts = 0;
      emitStatusUpdate();
    });
  }
}

function createAdapters() {
  const config = buildConfig();

  const ipsFromList = parseRfidIps(config.rfid.ips);
  const uniqueIps =
    ipsFromList.length > 0
      ? [...new Set(ipsFromList)]
      : [config.rfid.ip].filter(Boolean);

  rfidAdapters = uniqueIps.map((ip, index) =>
    new RealRFIDAdapter({
      ...config.rfid,
      ip,
      readerId: `reader-${index + 1}`,
    }),
  );
  rfidAdapter = rfidAdapters[0] || null;

  weighbridgeAdapter = new RealWeighbridgeAdapter(config.weighbridge);

  if (useWebcamCamera()) {
    cameraAdapter = new WebcamCameraAdapter(config.camera);
  } else {
    cameraAdapter = new RealCameraAdapter(config.camera);
  }

  getActiveRfidAdapters().forEach((adapter, index) =>
    wireRfidAdapter(adapter, `reader-${index + 1}`),
  );
  wireRfidSelection();
  wireWeighbridgeAdapter(weighbridgeAdapter);
  wireCameraAdapter(cameraAdapter);
}

async function connectRfidAdapter(adapter) {
  const retryKey = getRfidRetryKey(adapter);
  try {
    await adapter.connect();
    const state = getRetryState(retryKey);
    state.attempts = 0;
    if (adapter && typeof adapter === 'object') {
      adapter._reconnecting = false;
      adapter._lastError = null;
    }
    logger.logDevice('rfid', 'connect', 'rfid reader connected', {
      mode: adapter.constructor.name,
      ip: adapter?.config?.ip || null,
    });
  } catch (err) {
    handleRfidAdapterError(adapter, err);
  }
}

async function connectAdapter(name, adapter) {
  try {
    await adapter.connect();
    retryState[name].attempts = 0;
    if (adapter && typeof adapter === 'object') {
      adapter._reconnecting = false;
      adapter._lastError = null;
    }
    logger.logDevice(name, 'connect', `${name} connected`, {
      mode: adapter.constructor.name,
    });
  } catch (err) {
    handleAdapterError(name, adapter, err);
  }
}

function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  if (statusFullTimer) clearInterval(statusFullTimer);

  healthTimer = setInterval(() => {
    emitLightStatusUpdate();
  }, HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();

  statusFullTimer = setInterval(() => {
    refreshCloudStatus(true)
      .catch(() => false)
      .finally(() => emitStatusUpdate({ includeQueueCounts: true }));
  }, STATUS_FULL_INTERVAL_MS);
  if (statusFullTimer.unref) statusFullTimer.unref();
}

async function start(windowGetter) {
  if (started) return;
  getMainWindow = windowGetter || (() => null);

  try {
    RfidTagSelector.unlock();
    createAdapters();

    await Promise.all([
      Promise.all(getActiveRfidAdapters().map((adapter) => connectRfidAdapter(adapter))),
      connectAdapter('weighbridge', weighbridgeAdapter),
      connectAdapter('camera', cameraAdapter),
    ]);

    try {
      const ExternalDisplayService = require('./ExternalDisplayService');
      ExternalDisplayService.loadConfig();
      if (ExternalDisplayService.isEnabled()) {
        await ExternalDisplayService.start();
        const displaySnap = ExternalDisplayService.getSnapshot();
        const bridgePort =
          weighbridgeAdapter?.config?.comPort ||
          weighbridgeAdapter?.bridgeService?.config?.port ||
          buildConfig().weighbridge?.comPort ||
          '?';
        const displayPort = displaySnap.port || '?';
        const samePort =
          String(bridgePort).toUpperCase() === String(displayPort).toUpperCase();
        logger.logDevice('externalDisplay', 'info', 'Serial port wiring', {
          weighbridgePort: bridgePort,
          displayPort,
          displayProtocol: displaySnap.protocol,
          samePort,
          warning: samePort
            ? 'Weighbridge and external display must use different COM ports'
            : null,
        });
        const syncDisplay = () => {
          pushWeightToExternalDisplay(getExternalDisplayWeight(), 'startup');
        };
        syncDisplay();
        setTimeout(syncDisplay, 1000);
        setTimeout(syncDisplay, 3000);
        setTimeout(syncDisplay, 6000);
        startDisplayResyncTimer();
      }
    } catch (err) {
      logger.warn('ExternalDisplayService failed to start', { message: err.message });
    }

    await refreshCloudStatus(true);
    latestStatus = buildStatusSnapshot();
    startHealthCheck();
    emitStatusUpdate();
    started = true;

    syncRfidToRenderer();

    logger.info('DeviceMonitorService started', {
      webcamCamera: useWebcamCamera(),
      rfid: rfidAdapter?.constructor?.name,
      weighbridge: weighbridgeAdapter?.constructor?.name,
      camera: cameraAdapter?.constructor?.name,
    });
  } catch (err) {
    started = false;
    logger.error('DeviceMonitorService failed to start', {
      message: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

async function restart(windowGetter) {
  const getter = windowGetter || getMainWindow;
  await stop();
  started = false;
  rfidAdapter = null;
  rfidAdapters = [];
  weighbridgeAdapter = null;
  cameraAdapter = null;
  latestStatus = null;
  lastRfidSeen = null;
  latestRawWeight = 0;
  cloudReachable = false;
  cloudStatusCheckedAt = 0;
  clearRfidRetryTimers();
  ['weighbridge', 'camera'].forEach((d) => {
    retryState[d].attempts = 0;
  });
  await start(getter);
}

const DEVICE_RESTART_KEYS = new Set([
  'USE_WEBCAM_CAMERA',
  'RFID_IP',
  'RFID_IPS',
  'RFID_PORT',
  'WEIGHBRIDGE_COM_PORT',
  'WEIGHBRIDGE_BAUD_RATE',
  'WEIGHBRIDGE_DATA_BITS',
  'WEIGHBRIDGE_PARITY',
  'WEIGHBRIDGE_STOP_BITS',
  'EXTERNAL_DISPLAY_ENABLED',
  'EXTERNAL_DISPLAY_COM_PORT',
  'EXTERNAL_DISPLAY_BAUD_RATE',
  'EXTERNAL_DISPLAY_DATA_BITS',
  'EXTERNAL_DISPLAY_PARITY',
  'EXTERNAL_DISPLAY_STOP_BITS',
  'EXTERNAL_DISPLAY_CHANNEL',
  'EXTERNAL_DISPLAY_COMMAND',
  'EXTERNAL_DISPLAY_DECIMAL_PLACES',
  'CAMERA_RTSP_URL',
  'CAMERA_RTSP_URLS',
  'CAMERA_RTSP_USER',
  'CAMERA_RTSP_PASSWORD',
  'CAMERA_RTSP_PATH',
  'CAMERA_RTSP_PORT',
  'CLOUD_SYNC_URL',
  'CLOUD_SYNC_TOKEN',
]);

function syncRfidBlockedTags() {
  RfidBlocklistService.invalidateCache();
  for (const adapter of getActiveRfidAdapters()) {
    if (adapter && typeof adapter.syncBlockedTags === 'function') {
      try {
        adapter.syncBlockedTags();
      } catch (_e) {
        /* optional */
      }
    }
  }
  if (lastRfidSeen && RfidBlocklistService.isBlocked(lastRfidSeen.tag)) {
    lastRfidSeen = null;
  }
}

function shouldRestartDevicesForSetting(key) {
  return DEVICE_RESTART_KEYS.has(key);
}

function stop() {
  started = false;
  rfidScanning = false;
  try {
    const MultiCameraPreviewService = require('./MultiCameraPreviewService');
    MultiCameraPreviewService.stop();
  } catch (_e) {
    /* ignore */
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (statusFullTimer) {
    clearInterval(statusFullTimer);
    statusFullTimer = null;
  }
  lastCameraFrameAt.clear();
  clearRfidRetryTimers();
  stopDisplayResyncTimer();
  ['weighbridge', 'camera'].forEach((d) => clearRetryTimer(d));

  const stopExternalDisplay = (async () => {
    try {
      const ExternalDisplayService = require('./ExternalDisplayService');
      await ExternalDisplayService.stop();
    } catch (_e) {
      /* optional */
    }
  })();

  const disconnect = async (adapter) => {
    if (adapter && adapter.isConnected()) {
      try {
        await adapter.disconnect();
      } catch (_e) {
        /* ignore */
      }
    }
  };

  return Promise.all([
    stopExternalDisplay,
    Promise.all(getActiveRfidAdapters().map((adapter) => disconnect(adapter))),
    disconnect(weighbridgeAdapter),
    disconnect(cameraAdapter),
  ]);
}

function getCurrentStatus() {
  if (latestStatus) return latestStatus;
  latestStatus = buildStatusSnapshot();
  return latestStatus;
}

function getAdapters() {
  return {
    rfid: rfidAdapter,
    rfidAll: getActiveRfidAdapters(),
    weighbridge: weighbridgeAdapter,
    camera: cameraAdapter,
  };
}

/** @deprecated use getCurrentStatus */
function getStatus() {
  return getCurrentStatus();
}

function emitToRenderer(channel, payload) {
  if (channel === 'device:cameraFrame' && payload?.frame) {
    emitCameraFrame(payload.cameraId, payload.frame);
    return;
  }
  emitEvent(channel, payload);
}

function syncRfidToRenderer() {
  const state = getRfidDisplayState();
  if (!state?.tag) return;
  if (!state.locked && !state.scanning) return;
  if (state.locked) {
    emitEvent('device:rfidTag', { ...state, locked: true });
  } else {
    emitEvent('device:rfidLive', state);
  }
}

function getRfidDisplayState() {
  const locked = RfidTagSelector.isLocked();
  const payload = RfidTagSelector.getLockedPayload();
  const liveCandidate =
    !locked && rfidScanning && lastRfidSeen ? lastRfidSeen : null;
  const live =
    liveCandidate && RfidBlocklistService.isBlocked(liveCandidate.tag)
      ? null
      : liveCandidate;
  const source = payload || live;
  return {
    locked,
    scanning: rfidScanning,
    tag: source?.tag || (locked ? RfidTagSelector.getLockedTag() : null),
    tid: source?.tid ?? null,
    rssi: source?.rssi ?? null,
    antenna: source?.antenna ?? null,
    readerName: source?.readerName ?? null,
    sourceIp: source?.sourceIp ?? null,
    timestamp: source?.timestamp || ts.now(),
  };
}

async function startRfidScan() {
  RfidTagSelector.unlock();
  lastRfidSeen = null;
  rfidScanning = true;
  syncRfidBlockedTags();
  emitEvent('device:rfidScanState', { scanning: true });

  const adapters = getActiveRfidAdapters();
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      if (!adapter?.isConnected?.()) {
        logger.warn('RFID reader skipped for scan — not connected', {
          ip: adapter?.config?.ip || null,
        });
        return;
      }
      if (adapter.startScanning) {
        await adapter.startScanning();
      }
    }),
  );

  const failures = results.filter((r) => r.status === 'rejected');
  failures.forEach((r) => {
    logger.warn('RFID startScanning failed', { message: r.reason?.message });
  });

  const connectedCount = adapters.filter((a) => a?.isConnected?.()).length;
  const startedCount = results.filter((r) => r.status === 'fulfilled').length;
  if (connectedCount > 0 && startedCount === 0) {
    rfidScanning = false;
    emitEvent('device:rfidScanState', { scanning: false });
    throw new Error('No RFID readers could start scanning');
  }

  emitStatusUpdate();
}

async function stopRfidScan() {
  rfidScanning = false;
  const adapters = getActiveRfidAdapters();
  await Promise.all(
    adapters.map((adapter) =>
      adapter?.stopScanning ? adapter.stopScanning() : Promise.resolve(),
    ),
  );
  lastRfidSeen = null;
  emitEvent('device:rfidScanState', { scanning: false });
  emitStatusUpdate();
}
function useRtspCamera() {
  return !useWebcamCamera();
}

function getCameraConfig() {
  return buildConfig().camera;
}

function getTestConfig() {
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  const {
    isCameraRequired,
    getRequiredPhotoCount,
    getMinPhotoCountToSave,
    useOnDemandCameraPreview,
    useManualPhotoConfirm,
  } = require('../utils/cameraCaptureConfig');
  const { countEnabledCameras } = require('../utils/cameraUrls');
  const cameras = MultiCameraPreviewService.getCamerasFromConfig(getCameraConfig());
  const enabledPhotos = countEnabledCameras(getCameraConfig());
  return {
    useWebcamCamera: useWebcamCamera(),
    useRtspCamera: useRtspCamera(),
    cameras: cameras.map((c) => ({
      id: c.id,
      label: c.label,
      disabled: !!c.disabled,
    })),
    cameraRequired: isCameraRequired(),
    requiredPhotos: getRequiredPhotoCount(),
    enabledPhotos,
    minPhotosToSave: getMinPhotoCountToSave(),
    cameraPreviewOnDemand: useOnDemandCameraPreview(),
    manualPhotoCapture: useManualPhotoConfirm(),
  };
}

function getCurrentRawWeight() {
  if (latestRawWeight > 0) return latestRawWeight;
  const adapter = weighbridgeAdapter;
  if (adapter && typeof adapter.currentWeight === 'number' && adapter.currentWeight > 0) {
    return Math.round(adapter.currentWeight);
  }
  return latestRawWeight;
}

/**
 * Weight used when opening/closing a ticket.
 * Prefers the stable full-frame reading so a split serial chunk ("60" from "011160")
 * cannot be saved while the indicator is actually showing a truck weight.
 */
function getCaptureWeightKg(fallbackKg) {
  const fallback = Math.round(Number(fallbackKg) || 0);
  const snap = weighbridgeAdapter?.bridgeService?.getSnapshot?.() || null;
  const stable = snap ? Math.round(Number(snap.stableWeight) || 0) : 0;
  const latest = snap
    ? Math.round(Number(snap.weight) || 0)
    : Math.round(Number(latestRawWeight) || 0);

  const isFragment = (small, full) => {
    if (!(small > 0 && full > 0) || small >= full) return false;
    const s = String(small);
    const f = String(full);
    return f.startsWith(s) || f.endsWith(s);
  };

  if (stable > 0) {
    if (snap?.isStable) return stable;
    if (latest > 0 && latest <= 120000) {
      if (latest < 1000 && stable >= 2000) return stable;
      if (stable >= 2000 && latest < stable * 0.2) return stable;
      if (isFragment(latest, stable)) return stable;
      return latest;
    }
    return stable;
  }

  if (latest > 0 && latest <= 120000) {
    if (fallback >= 2000 && latest < 1000 && isFragment(latest, fallback)) {
      return fallback;
    }
    return latest;
  }

  if (fallback > 0 && fallback <= 120000) return fallback;
  return getCurrentRawWeight();
}

function syncExternalDisplay() {
  pushWeightToExternalDisplay(getExternalDisplayWeight(), 'manual-sync');
}

function broadcastLiveWeight() {
  const raw = getWeighbridgeRawWeight();
  if (!raw) return;
  const adjustedPayload = buildAdjustedWeightPayload({
    weight: raw,
    isStable: weighbridgeAdapter?.isStable ?? false,
  });
  pushWeightToExternalDisplay(getExternalDisplayWeight(), 'broadcast');
  emitEvent('device:weightUpdate', adjustedPayload);
  patchWeighbridgeInCache(adjustedPayload);
}

module.exports = {
  start,
  stop,
  restart,
  shouldRestartDevicesForSetting,
  refreshCloudStatus,
  getCurrentStatus,
  getStatus,
  getAdapters,
  getLatestCachedStatus: () => latestStatus,
  invalidateStatusCountCache,
  emitToRenderer,
  getTestConfig,
  getCameraConfig,
  getRfidDisplayState,
  syncRfidToRenderer,
  syncRfidBlockedTags,
  syncExternalDisplay,
  broadcastLiveWeight,
  startRfidScan,
  stopRfidScan,
  getCurrentRawWeight,
  getCaptureWeightKg,
  setWeighmentContext,
  getWeighmentContext,
  clearWeighmentContext,
  getWorkflowPassForAdjustment,
  resolveLiveDisplayWeight,
};
