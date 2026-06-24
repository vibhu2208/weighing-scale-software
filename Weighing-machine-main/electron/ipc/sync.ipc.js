'use strict';

const SyncQueue = require('../../backend/engine/SyncQueue');
const SyncService = require('../../backend/services/SyncService');

const NAMESPACE = 'sync';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getQueueStatus`, async () => SyncQueue.getStatus());

  ipcMain.handle(`${NAMESPACE}:triggerManualSync`, async (_e, transactionId) => {
    if (transactionId) {
      return SyncService.uploadTransaction(transactionId);
    }
    return SyncService.triggerManualSync();
  });

  ipcMain.handle(`${NAMESPACE}:getSyncHistory`, async (_e, limit) =>
    SyncService.getHistory(limit || 50),
  );
}

module.exports = { register, NAMESPACE };
