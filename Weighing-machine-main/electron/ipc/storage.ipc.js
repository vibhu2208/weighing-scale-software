'use strict';

const {
  getStorageStats,
  deleteOlderThan,
} = require('../../backend/utils/fileStorage');
const SettingsService = require('../../backend/services/SettingsService');
const BackupService = require('../../backend/services/BackupService');

const NAMESPACE = 'storage';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getStorageStats`, async () => {
    const { getStorageStatsAsync } = require('../../backend/utils/fileStorage');
    return getStorageStatsAsync();
  });

  ipcMain.handle(`${NAMESPACE}:runCleanup`, async () => {
    const days = parseInt(SettingsService.get('IMAGE_RETENTION_DAYS') || '90', 10);
    const deleted = deleteOlderThan(Number.isNaN(days) ? 90 : days);
    return { deleted, days };
  });

  ipcMain.handle(`${NAMESPACE}:listThermalQueue`, async () => {
    const PrintService = require('../../backend/services/PrintService');
    return PrintService.listThermalQueue();
  });

  ipcMain.handle(`${NAMESPACE}:resendThermal`, async (_e, filename) => {
    const PrintService = require('../../backend/services/PrintService');
    return PrintService.resendThermalQueueFile(filename);
  });

  ipcMain.handle(`${NAMESPACE}:readMediaDataUrl`, async (_e, filePath) => {
    const fileStorage = require('../../backend/utils/fileStorage');
    const localMedia = require('../../backend/utils/localMedia');
    return localMedia.readMediaDataUrl(filePath, fileStorage);
  });
}

module.exports = { register, NAMESPACE };
