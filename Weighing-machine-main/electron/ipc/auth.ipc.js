'use strict';

const OperatorAuthService = require('../../backend/services/OperatorAuthService');

const NAMESPACE = 'auth';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:verifyPin`, async (_e, pin) =>
    OperatorAuthService.verifyPin(pin),
  );

  ipcMain.handle(`${NAMESPACE}:lockAdvanced`, async () =>
    OperatorAuthService.lockAdvanced(),
  );

  ipcMain.handle(`${NAMESPACE}:getSession`, async () =>
    OperatorAuthService.getSession(),
  );
}

module.exports = { register, NAMESPACE };
