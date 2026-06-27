'use strict';

const TransactionService = require('../../backend/services/TransactionService');
const TripCaptureService = require('../../backend/services/TripCaptureService');
const {
  toPublicTransaction,
  toPublicTransactionList,
} = require('../../backend/utils/transactionPublic');

const NAMESPACE = 'tickets';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:listOpen`, async () =>
    toPublicTransactionList(TransactionService.listOpenTickets()),
  );

  ipcMain.handle(`${NAMESPACE}:cancel`, async (_e, id) =>
    toPublicTransaction(TransactionService.cancelTicket(id)),
  );

  ipcMain.handle(`${NAMESPACE}:manualCloseHywa`, async (_e, data) => {
    const result = await TripCaptureService.manualCloseHywaTicket(data || {});
    return {
      ...result,
      transaction: toPublicTransaction(result.transaction),
    };
  });
}

module.exports = { register, NAMESPACE };
