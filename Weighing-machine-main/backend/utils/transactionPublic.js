'use strict';

const RAW_FIELDS = ['raw_tare_weight', 'raw_gross_weight', 'weight_offset_kg'];

/**
 * Strip secret raw weight fields before sending transactions to renderer or cloud.
 * @param {object|null} txn
 */
function toPublicTransaction(txn) {
  if (!txn) return txn;
  const out = { ...txn };
  for (const key of RAW_FIELDS) {
    delete out[key];
  }
  return out;
}

function toPublicTransactionList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(toPublicTransaction);
}

module.exports = {
  toPublicTransaction,
  toPublicTransactionList,
  RAW_FIELDS,
};
