'use strict';

const WorkflowEngine = require('../../backend/engine/WorkflowEngine');

const NAMESPACE = 'workflow';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getState`, async () =>
    WorkflowEngine.getCurrentState(),
  );

  ipcMain.handle(`${NAMESPACE}:manualRFID`, async (_e, tag) => {
    WorkflowEngine.manualRfid(tag);
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:acceptManualEntry`, async (_e, truckNumber) => {
    WorkflowEngine.acceptManualEntry(truckNumber);
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:abort`, async () => {
    WorkflowEngine.abort();
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:clearSessionAfterSave`, async () => {
    WorkflowEngine.clearSessionAfterSave();
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:retryPrint`, async (_e, transactionId) => {
    const result = await WorkflowEngine.retryPrint(transactionId);
    return { ok: true, ...result };
  });
}

module.exports = { register, NAMESPACE };
