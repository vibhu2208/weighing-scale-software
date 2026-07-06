'use strict';

const BackupService = require('../../backend/services/BackupService');
const CloudBackupService = require('../../backend/services/CloudBackupService');
const CloudLogUploadService = require('../../backend/services/CloudLogUploadService');
const { getLogPath } = require('../../backend/utils/fileStorage');

const NAMESPACE = 'backup';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getList`, async () => BackupService.getBackupList());

  ipcMain.handle(`${NAMESPACE}:getLastBackupTime`, async () =>
    BackupService.getLastBackupTime(),
  );

  /** Local SQLite file backup (existing behaviour). */
  ipcMain.handle(`${NAMESPACE}:manualLocalBackup`, async () => BackupService.manualBackup());

  /** Cloud S3 backup: DB gzip + reports + images. */
  ipcMain.handle(`${NAMESPACE}:manualBackup`, async () => CloudBackupService.runManual());

  ipcMain.handle(`${NAMESPACE}:getCloudStatus`, async () => ({
    ...CloudBackupService.getStatus(),
    backupLogPath: getLogPath('backup.log'),
    logUpload: CloudLogUploadService.getStatus(),
  }));

  ipcMain.handle(`${NAMESPACE}:getLogUploadStatus`, async () =>
    CloudLogUploadService.getStatus(),
  );

  ipcMain.handle(`${NAMESPACE}:manualLogUpload`, async () => CloudLogUploadService.runManual());

  ipcMain.handle(`${NAMESPACE}:listRemoteBackups`, async () =>
    CloudBackupService.listRemoteBackups(),
  );

  ipcMain.handle(`${NAMESPACE}:restoreBackup`, async (_evt, s3Key) =>
    CloudBackupService.restoreBackup(s3Key),
  );
}

module.exports = { register, NAMESPACE };
