'use strict';

function looksLikeCancelPayload(data = {}) {
  if (data == null || typeof data !== 'object') return false;
  const cancelFlag = data.cancel;
  if (cancelFlag === true || cancelFlag === 1 || String(cancelFlag).toLowerCase() === 'true') {
    return true;
  }
  if (String(data.ticket_status || '').toUpperCase() === 'CANCELLED') return true;
  const material = String(data.material || '').trim().toUpperCase();
  const gross = Number(data.gross_weight);
  const tare = Number(data.tare_weight);
  return material === 'CANCEL' && gross === 0 && tare === 0;
}

module.exports = { looksLikeCancelPayload };
