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

  ipcMain.handle(`${NAMESPACE}:verifyManualHywaPin`, async (_e, pin) =>
    OperatorAuthService.verifyManualHywaPin(pin),
  );

  ipcMain.handle(`${NAMESPACE}:lockManualHywaClose`, async () =>
    OperatorAuthService.lockManualHywaClose(),
  );

  ipcMain.handle(`${NAMESPACE}:getManualHywaCloseSession`, async () =>
    OperatorAuthService.getManualHywaCloseSession(),
  );
}

module.exports = { register, NAMESPACE };
