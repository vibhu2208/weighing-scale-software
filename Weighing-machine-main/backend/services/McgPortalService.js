'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const TransactionService = require('./TransactionService');
const SettingsService = require('./SettingsService');
const { isHywa } = require('../utils/vehicleTypes');

const TEST_STRING = 'TESTING';
const TEST_TARE_KG = 10000;
const TEST_GROSS_KG = 12000;
const TEST_NET_KG = 2000;

function isTruthySetting(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function getConfig() {
  return {
    enabled: isTruthySetting(SettingsService.get('MCG_PORTAL_ENABLED')),
    url: (SettingsService.get('MCG_PORTAL_URL') || '').trim(),
    apiKey: (SettingsService.get('MCG_PORTAL_API_KEY') || '').trim(),
    testMode: isTruthySetting(SettingsService.get('MCG_PORTAL_TEST_MODE')),
  };
}

function isConfigured() {
  const { enabled, url, apiKey } = getConfig();
  return enabled && !!url && !!apiKey;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** API tare timestamp: YYYY-MM-DD HH:mm:ss (local 24h). */
function formatApiTareTimestamp(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function weightToString(value) {
  if (value == null || Number.isNaN(Number(value))) return '0';
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Math.round(n));
}

function str(value) {
  if (value == null) return '';
  return String(value).trim();
}

function resolveTransporter(transaction) {
  return str(transaction.transporter) || str(transaction.vehicle?.transporter) || '';
}

function buildTestInput() {
  const now = ts.now();
  const tareIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  return {
    weighbridgeno: '00001',
    crtno: `TESTING-${ts.fileSafe()}`,
    partyname: TEST_STRING,
    partyaddress: TEST_STRING,
    vehicleno: TEST_STRING,
    item: TEST_STRING,
    customer: TEST_STRING,
    transport: TEST_STRING,
    charges: '0',
    tareweight: weightToString(TEST_TARE_KG),
    grossweight: weightToString(TEST_GROSS_KG),
    tareweightcreated: formatApiTareTimestamp(tareIso),
    grossweightcreated: ts.toDisplay12h(now),
    dispatchlocation: TEST_STRING,
    netweight: TEST_NET_KG,
  };
}

function buildPayload(transaction, { forceTestMode = false } = {}) {
  const { testMode } = getConfig();
  if (forceTestMode || testMode) {
    return { input: buildTestInput() };
  }

  const customerName = str(transaction.customer_name);
  const destination = str(transaction.destination);
  const vehicleType =
    transaction.vehicle_type || transaction.vehicle?.vehicle_type || null;
  const hywa = isHywa(vehicleType);

  return {
    input: {
      weighbridgeno: str(
        SettingsService.get('WEIGHBRIDGE_ID') || process.env.WEIGHBRIDGE_ID || 'WB - 03',
      ),
      crtno: str(transaction.slip_number),
      partyname: customerName,
      partyaddress: destination,
      vehicleno: str(transaction.truck_number),
      item: str(transaction.material),
      customer: customerName,
      transport: resolveTransporter(transaction),
      charges: '0',
      tareweight: weightToString(transaction.tare_weight),
      grossweight: weightToString(transaction.gross_weight),
      tareweightcreated: formatApiTareTimestamp(
        hywa ? transaction.timestamp_out : transaction.timestamp_in,
      ),
      grossweightcreated: ts.toDisplay12h(
        hywa ? transaction.timestamp_in : transaction.timestamp_out,
      ),
      dispatchlocation: destination,
      netweight: Number(transaction.net_weight) || 0,
    },
  };
}

function resolveEndpoint(url) {
  const trimmed = url.replace(/\/$/, '');
  return trimmed.endsWith('/weightbridge') ? trimmed : `${trimmed}/weightbridge`;
}

async function postPayload(payload, { label = 'MCG portal' } = {}) {
  const { url, apiKey } = getConfig();
  const endpoint = resolveEndpoint(url);

  try {
    const res = await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    const body = res.data;
    const ok = res.status >= 200 && res.status < 300;

    if (ok) {
      logger.info(`${label} POST succeeded`, {
        status: res.status,
        message: body?.message || 'success',
        crtno: payload?.input?.crtno,
      });
      return { ok: true, status: res.status, data: body };
    }

    logger.warn(`${label} POST failed`, {
      status: res.status,
      message: body?.message || res.statusText,
      crtno: payload?.input?.crtno,
      response: typeof body === 'object' ? body : String(body || '').slice(0, 500),
    });
    return {
      ok: false,
      status: res.status,
      error: body?.message || `HTTP ${res.status}`,
      data: body,
    };
  } catch (err) {
    logger.warn(`${label} POST error`, {
      message: err.message,
      crtno: payload?.input?.crtno,
    });
    return { ok: false, error: err.message };
  }
}

function recordMcgResult(transactionId, result) {
  const now = ts.now();
  if (result?.skipped && result?.reason === 'not_configured') {
    TransactionService.updateFields(transactionId, {
      mcg_status: 'skipped',
      mcg_error: null,
    });
    return;
  }
  if (result?.ok) {
    TransactionService.updateFields(transactionId, {
      mcg_status: 'sent',
      mcg_error: null,
      mcg_sent_at: now,
    });
    return;
  }
  TransactionService.updateFields(transactionId, {
    mcg_status: 'failed',
    mcg_error: result?.error || result?.reason || 'unknown',
  });
}

const McgPortalService = {
  getConfig,
  isConfigured,
  buildPayload,
  buildTestInput,

  async postClosedTicket(transactionId) {
    if (!isConfigured()) {
      logger.debug('MCG portal not configured — skipping', { transactionId });
      const result = { ok: true, skipped: true, reason: 'not_configured' };
      recordMcgResult(transactionId, result);
      return result;
    }

    const transaction = TransactionService.getById(transactionId);
    if (!transaction) {
      logger.warn('MCG portal post skipped — transaction not found', { transactionId });
      return { ok: false, error: 'transaction_not_found' };
    }

    if (transaction.ticket_status !== 'CLOSED') {
      logger.warn('MCG portal post skipped — ticket not closed', {
        transactionId,
        ticketStatus: transaction.ticket_status,
      });
      return { ok: false, error: 'ticket_not_closed' };
    }

    const payload = buildPayload(transaction);
    logger.info('MCG portal posting closed ticket', {
      transactionId,
      crtno: payload.input.crtno,
      testMode: getConfig().testMode,
    });

    const result = await postPayload(payload, { label: 'MCG portal' });
    recordMcgResult(transactionId, result);
    return result;
  },

  async testPost() {
    if (!isConfigured()) {
      return { ok: false, error: 'MCG portal is not enabled or missing URL/API key' };
    }

    const payload = { input: buildTestInput() };
    logger.info('MCG portal test POST', { crtno: TEST_STRING });
    return postPayload(payload, { label: 'MCG portal test' });
  },

  async resendSkippedTicket(transactionId) {
    const transaction = TransactionService.getById(transactionId);
    if (!transaction) {
      return { ok: false, error: 'transaction_not_found' };
    }
    if (transaction.ticket_status !== 'CLOSED') {
      return { ok: false, error: 'ticket_not_closed' };
    }
    if ((transaction.mcg_status || '').toLowerCase() !== 'skipped') {
      return { ok: false, error: 'not_skipped' };
    }

    logger.info('MCG portal resend for skipped ticket', {
      transactionId,
      slip: transaction.slip_number,
    });
    const result = await McgPortalService.postClosedTicket(transactionId);
    return {
      ...result,
      transaction: TransactionService.getById(transactionId),
    };
  },
};

module.exports = McgPortalService;
