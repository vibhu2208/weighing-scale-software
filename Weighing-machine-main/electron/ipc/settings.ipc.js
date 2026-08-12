'use strict';

const SettingsService = require('../../backend/services/SettingsService');
const OperatorAuthService = require('../../backend/services/OperatorAuthService');
const { ADMIN_WEIGHT_KEYS } = require('../../backend/services/WeightAdjustmentService');

const NAMESPACE = 'settings';

const ADMIN_ONLY_SET = new Set(ADMIN_WEIGHT_KEYS);

const CLOUD_BACKUP_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'CLOUD_BACKUP_INTERVAL_MINUTES',
  'CLOUD_BACKUP_ENABLED',
  'CLOUD_LOG_UPLOAD_ENABLED',
  'CLOUD_LOG_UPLOAD_INTERVAL_MINUTES',
]);

const MAIL_KEYS = new Set([
  'MAIL_ENABLED',
  'DAILY_REPORT_MAIL_ENABLED',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_SECURE',
  'MAIL_USER',
  'MAIL_PASS',
  'MAIL_FROM',
  'MAIL_TO',
  'DAILY_REPORT_MAIL_CRON',
  'DAILY_REPORT_MAIL_TIMEZONE',
  'DAILY_REPORT_MAIL_INCLUDE_TRIP_PDF',
  'DAILY_REPORT_MAIL_RETRY_MS',
]);

function restartCloudBackup() {
  try {
    const CloudBackupService = require('../../backend/services/CloudBackupService');
    const CloudLogUploadService = require('../../backend/services/CloudLogUploadService');
    const S3Service = require('../../backend/services/S3Service');
    S3Service.resetClient();
    if (CloudBackupService.isCloudBackupEnabled()) {
      CloudBackupService.start();
    } else {
      CloudBackupService.stop();
    }
    if (CloudLogUploadService.isLogUploadEnabled()) {
      CloudLogUploadService.start();
    } else {
      CloudLogUploadService.stop();
    }
  } catch {
    /* optional */
  }
}

function restartDailyReportMail() {
  try {
    const DailyReportMailService = require('../../backend/services/DailyReportMailService');
    DailyReportMailService.start();
  } catch {
    /* optional */
  }
}

function filterAdminKeys(map) {
  const out = { ...map };
  const WeightAdjustmentService = require('../../backend/services/WeightAdjustmentService');
  const featureAvailable = WeightAdjustmentService.isFeatureAvailable();
  out.WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE = featureAvailable ? 'true' : 'false';

  if (!featureAvailable) {
    for (const key of ADMIN_WEIGHT_KEYS) {
      delete out[key];
    }
    return out;
  }

  if (OperatorAuthService.isAdminSessionActive()) {
    OperatorAuthService.touchSession();
    return out;
  }
  for (const key of ADMIN_WEIGHT_KEYS) {
    delete out[key];
  }
  return out;
}

function parseOptionList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanOptionList(items) {
  if (!Array.isArray(items)) {
    throw new Error('List must be an array');
  }
  return items.map((m) => String(m || '').trim()).filter(Boolean);
}

function registerListHandlers(ipcMain, listKey, getName, setName) {
  ipcMain.handle(`${NAMESPACE}:${getName}`, async () =>
    parseOptionList(SettingsService.get(listKey)),
  );

  ipcMain.handle(`${NAMESPACE}:${setName}`, async (_e, items) => {
    const cleaned = cleanOptionList(items);
    SettingsService.set(listKey, JSON.stringify(cleaned));
    return cleaned;
  });
}

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:get`, async (_e, key) => {
    if (ADMIN_ONLY_SET.has(key)) {
      const WeightAdjustmentService = require('../../backend/services/WeightAdjustmentService');
      if (!WeightAdjustmentService.isFeatureAvailable()) {
        if (key === 'WEIGHT_ADJUSTMENT_ENABLED') return 'false';
        if (key === 'WEIGHT_OFFSET_KG') return '0';
        if (key === 'WEIGHT_ADJUSTMENT_FEATURE_AVAILABLE') return 'false';
      }
      if (!OperatorAuthService.isAdminSessionActive()) {
        if (key === 'WEIGHT_ADJUSTMENT_ENABLED') return 'false';
        if (key === 'WEIGHT_OFFSET_KG') return '0';
      } else {
        OperatorAuthService.touchSession();
      }
    }
    return SettingsService.get(key);
  });

  ipcMain.handle(`${NAMESPACE}:set`, async (_e, key, value) => {
    if (ADMIN_ONLY_SET.has(key)) {
      const WeightAdjustmentService = require('../../backend/services/WeightAdjustmentService');
      WeightAdjustmentService.assertFeatureAllowsChanges();
      if (!OperatorAuthService.isAdminSessionActive()) {
        throw new Error('Admin PIN required — unlock Advance Setting first');
      }
      OperatorAuthService.touchSession();
    }

    const result = SettingsService.set(key, value);
    if (key === 'WEIGHT_ADJUSTMENT_ENABLED') {
      try {
        const WeightAdjustmentService = require('../../backend/services/WeightAdjustmentService');
        WeightAdjustmentService.onEnabledSettingChanged(value);
      } catch (_e) {
        /* optional */
      }
    }
    if (key === 'RFID_BLOCKED_TAGS' || key === 'RFID_EPC_PREFIX') {
      try {
        const RfidBlocklistService = require('../../backend/services/RfidBlocklistService');
        RfidBlocklistService.invalidateCache();
        const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
        if (typeof DeviceMonitorService.syncRfidBlockedTags === 'function') {
          DeviceMonitorService.syncRfidBlockedTags();
        }
      } catch (_e) {
        /* optional */
      }
    }
    if (['AUTO_BACKUP', 'BACKUP_INTERVAL_HOURS'].includes(key)) {
      try {
        const BackupService = require('../../backend/services/BackupService');
        BackupService.reschedule();
      } catch (_e) {
        /* optional */
      }
    }
    if (CLOUD_BACKUP_KEYS.has(key)) {
      restartCloudBackup();
    }
    if (MAIL_KEYS.has(key)) {
      restartDailyReportMail();
    }
    const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
    if (DeviceMonitorService.shouldRestartDevicesForSetting(key)) {
      try {
        await DeviceMonitorService.restart();
      } catch (err) {
        return {
          ...result,
          restartWarning: err.message || 'Device services could not restart',
        };
      }
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:getAll`, async () => filterAdminKeys(SettingsService.getAll()));

  ipcMain.handle(`${NAMESPACE}:getMaterials`, async () =>
    parseOptionList(SettingsService.get('materials_list')),
  );

  ipcMain.handle(`${NAMESPACE}:setMaterials`, async (_e, materials) => {
    const cleaned = cleanOptionList(materials);
    SettingsService.set('materials_list', JSON.stringify(cleaned));
    return cleaned;
  });

  registerListHandlers(ipcMain, 'customers_list', 'getCustomers', 'setCustomers');
  registerListHandlers(ipcMain, 'destinations_list', 'getDestinations', 'setDestinations');
  registerListHandlers(ipcMain, 'operators_list', 'getOperators', 'setOperators');
  registerListHandlers(ipcMain, 'companies_list', 'getCompanies', 'setCompanies');
}

module.exports = { register, NAMESPACE };
