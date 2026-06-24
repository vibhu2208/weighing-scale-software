'use strict';

const VehicleService = require('../../backend/services/VehicleService');
const { toPublicTransaction } = require('../../backend/utils/transactionPublic');

const NAMESPACE = 'vehicles';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getAll`, async (_e, options) =>
    VehicleService.getAll(options || {}),
  );

  ipcMain.handle(`${NAMESPACE}:search`, async (_e, query) =>
    VehicleService.search(query),
  );

  ipcMain.handle(`${NAMESPACE}:findByNumber`, async (_e, number) =>
    VehicleService.findByNumber(number),
  );

  ipcMain.handle(`${NAMESPACE}:create`, async (_e, data) =>
    VehicleService.create(data),
  );

  ipcMain.handle(`${NAMESPACE}:update`, async (_e, id, data) =>
    VehicleService.update(id, data),
  );

  ipcMain.handle(`${NAMESPACE}:delete`, async (_e, id) =>
    VehicleService.delete(id),
  );

  ipcMain.handle(`${NAMESPACE}:findByRFID`, async (_e, rfidTag) =>
    VehicleService.findByRFID(rfidTag),
  );

  ipcMain.handle(`${NAMESPACE}:getWeighmentInfo`, async (_e, truckNumber, rfidTag) => {
    const info = VehicleService.getWeighmentInfo(truckNumber, rfidTag);
    if (info?.openTicket) {
      return { ...info, openTicket: toPublicTransaction(info.openTicket) };
    }
    return info;
  });
}

module.exports = { register, NAMESPACE };
