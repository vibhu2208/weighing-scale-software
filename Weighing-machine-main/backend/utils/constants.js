'use strict';

/**
 * System-wide constants. All exports are deep-frozen to prevent
 * accidental mutation at runtime.
 */

function deepFreeze(obj) {
  Object.keys(obj).forEach((key) => {
    const val = obj[key];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  });
  return Object.freeze(obj);
}

const TICKET_STATUS = deepFreeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
});

const TRANSACTION_STATUS = deepFreeze({
  PENDING: 'pending',
  WEIGHING: 'weighing',
  CAPTURED: 'captured',
  PRINTED: 'printed',
  SYNCED: 'synced',
  FAILED: 'failed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

const SYNC_STATUS = deepFreeze({
  PENDING: 'pending',
  SYNCED: 'synced',
  FAILED: 'failed',
  RETRY: 'retry',
});

const DEVICE_TYPE = deepFreeze({
  RFID: 'rfid',
  WEIGHBRIDGE: 'weighbridge',
  CAMERA: 'camera',
  CLOUD: 'cloud',
});

const DEVICE_STATUS = deepFreeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  WAITING: 'waiting',
  ERROR: 'error',
});

const WEIGHT_STABILITY = deepFreeze({
  STABLE: 'stable',
  UNSTABLE: 'unstable',
  ZERO: 'zero',
});

const ADAPTER_MODE = deepFreeze({
  MOCK: 'mock',
  REAL: 'real',
});

/** Default operational tunables (overridable via .env). */
const DEFAULTS = deepFreeze({
  SYNC_INTERVAL_SECONDS: 30,
  BACKUP_INTERVAL_HOURS: 4,
  MAX_RETRY_ATTEMPTS: 5,
  LOG_LEVEL: 'info',
  WEIGHT_STABLE_TOLERANCE_KG: 5,
  WEIGHT_STABLE_WINDOW_MS: 1500,
});

module.exports = {
  TICKET_STATUS,
  TRANSACTION_STATUS,
  SYNC_STATUS,
  DEVICE_TYPE,
  DEVICE_STATUS,
  WEIGHT_STABILITY,
  ADAPTER_MODE,
  DEFAULTS,
};
