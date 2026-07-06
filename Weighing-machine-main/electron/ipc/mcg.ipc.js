'use strict';

const McgPortalService = require('../../backend/services/McgPortalService');

const NAMESPACE = 'mcg';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:testPost`, async () => McgPortalService.testPost());

  ipcMain.handle(`${NAMESPACE}:resendSkipped`, async (_e, transactionId) =>
    McgPortalService.resendSkippedTicket(transactionId),
  );
}

module.exports = { register, NAMESPACE };
