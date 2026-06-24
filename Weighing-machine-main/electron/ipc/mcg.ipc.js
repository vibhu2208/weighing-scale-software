'use strict';

const McgPortalService = require('../../backend/services/McgPortalService');

const NAMESPACE = 'mcg';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:testPost`, async () => McgPortalService.testPost());
}

module.exports = { register, NAMESPACE };
