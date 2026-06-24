'use strict';

const TransactionService = require('../../backend/services/TransactionService');
const {
  toPublicTransaction,
  toPublicTransactionList,
} = require('../../backend/utils/transactionPublic');

const NAMESPACE = 'transactions';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:create`, async (_e, data) => {
    const result = await TransactionService.create(data);
    if (result?.transaction) {
      return { ...result, transaction: toPublicTransaction(result.transaction) };
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:getAll`, async (_e, filters) =>
    toPublicTransactionList(TransactionService.getAll(filters || {})),
  );

  ipcMain.handle(`${NAMESPACE}:getById`, async (_e, id) =>
    toPublicTransaction(TransactionService.getById(id)),
  );

  ipcMain.handle(`${NAMESPACE}:updateStatus`, async (_e, id, status) =>
    toPublicTransaction(TransactionService.updateStatus(id, status)),
  );

  ipcMain.handle(`${NAMESPACE}:getTodayStats`, async () =>
    TransactionService.getTodayStats(),
  );
}

module.exports = { register, NAMESPACE };
