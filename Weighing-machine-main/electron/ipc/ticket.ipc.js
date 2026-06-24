'use strict';

const TransactionService = require('../../backend/services/TransactionService');
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
}

module.exports = { register, NAMESPACE };
