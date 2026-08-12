'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const JSZip = require('jszip');

const ReportService = require('./ReportService');
const SettingsService = require('./SettingsService');
const { isOnline } = require('../utils/connectivity');
const { probeTcp } = require('../utils/networkProbe');
const { PATHS, ensureDir, normalizePath } = require('../utils/fileStorage');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');

const SENT_KEY = 'last_daily_report_mail_date';
const RETRY_MS_DEFAULT = 5 * 60 * 1000;
const MAX_ATTACH_BYTES = 22 * 1024 * 1024;

let cronJob = null;
let retryTimer = null;
let running = false;
let pendingReportDate = null;

function envFlag(key, fallback = false) {
  const raw = SettingsService.get(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true' || raw === true || raw === '1';
}

function envStr(key, fallback = '') {
  const v = SettingsService.get(key);
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).trim();
}

function envInt(key, fallback) {
  const n = parseInt(SettingsService.get(key) || String(fallback), 10);
  return Number.isNaN(n) ? fallback : n;
}

function isMailEnabled() {
  return envFlag('MAIL_ENABLED', false) && envFlag('DAILY_REPORT_MAIL_ENABLED', false);
}

function mailTimezone() {
  return envStr('DAILY_REPORT_MAIL_TIMEZONE', 'Asia/Kolkata') || 'Asia/Kolkata';
}

function mailCronExpr() {
  return envStr('DAILY_REPORT_MAIL_CRON', '45 0 * * *') || '45 0 * * *';
}

function retryIntervalMs() {
  return Math.max(60_000, envInt('DAILY_REPORT_MAIL_RETRY_MS', RETRY_MS_DEFAULT));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD in the configured report timezone. */
function dateIsoInTimezone(date = new Date(), timeZone = mailTimezone()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Calendar day before `isoDate` (YYYY-MM-DD). */
function previousCalendarDay(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function targetReportDate() {
  return previousCalendarDay(dateIsoInTimezone(new Date(), mailTimezone()));
}

function alreadySent(reportDate) {
  return envStr(SENT_KEY) === reportDate;
}

function markSent(reportDate) {
  SettingsService.set(SENT_KEY, reportDate);
}

function clearRetry() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(reportDate) {
  pendingReportDate = reportDate;
  if (retryTimer) return;
  const ms = retryIntervalMs();
  retryTimer = setInterval(() => {
    if (alreadySent(reportDate) || pendingReportDate !== reportDate) {
      clearRetry();
      return;
    }
    runForDate(reportDate, { reason: 'retry' }).catch((err) => {
      logger.logError('Daily report mail retry failed', err);
    });
  }, ms);
  logger.info('Daily report mail will retry until network is available', {
    reportDate,
    retryMs: ms,
  });
}

function createTransport() {
  const host = envStr('MAIL_HOST', 'smtp.gmail.com');
  const port = envInt('MAIL_PORT', 587);
  const secure = envFlag('MAIL_SECURE', false);
  const user = envStr('MAIL_USER');
  const pass = envStr('MAIL_PASS');
  if (!user || !pass) {
    throw new Error('MAIL_USER / MAIL_PASS are not configured');
  }
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function canReachMailNetwork() {
  if (await isOnline()) return true;
  const host = envStr('MAIL_HOST', 'smtp.gmail.com');
  const port = envInt('MAIL_PORT', 587);
  const probe = await probeTcp(host, port, 4000);
  return Boolean(probe?.ok);
}

async function zipEntries(outPath, entries) {
  const zip = new JSZip();
  for (const entry of entries) {
    if (!entry?.path || !fs.existsSync(entry.path)) continue;
    const name = entry.name || path.basename(entry.path);
    // eslint-disable-next-line no-await-in-loop
    const data = await fs.promises.readFile(entry.path);
    zip.file(name, data);
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  await fs.promises.writeFile(outPath, buffer);
  return outPath;
}

async function collectTripPdfEntries(reportDate) {
  const daily = ReportService.getDailyReport(reportDate);
  const rows = (daily.rows || []).filter((r) => r.ticket_status === 'CLOSED');
  const entries = [];
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const pdf = await ReportService.exportTripPDF(row.id);
      if (pdf?.ok && pdf.path && fs.existsSync(pdf.path)) {
        entries.push({
          path: pdf.path,
          name: `trip_pdfs/${pdf.suggestedName || path.basename(pdf.path)}`,
        });
      }
    } catch (err) {
      logger.warn('Daily report mail: trip PDF skipped', {
        id: row.id,
        message: err.message,
      });
    }
  }
  return entries;
}

async function buildAttachments(reportDate) {
  const { from, to } = ts.dayBoundsRange(reportDate, reportDate);
  const filters = { from, to };
  const entries = [];
  const excel = await ReportService.exportExcel(filters);
  if (excel?.ok && excel.path) {
    entries.push({ path: excel.path, name: path.basename(excel.path) });
  }

  const dataPdf = await ReportService.exportExcelPDF(filters, {
    periodLabel: `Daily report ${reportDate}`,
  });
  if (dataPdf?.ok && dataPdf.path) {
    entries.push({ path: dataPdf.path, name: path.basename(dataPdf.path) });
  }

  let tripCount = 0;
  if (envFlag('DAILY_REPORT_MAIL_INCLUDE_TRIP_PDF', true)) {
    const tripEntries = await collectTripPdfEntries(reportDate);
    tripCount = tripEntries.length;
    entries.push(...tripEntries);
  }

  const count = excel?.count || dataPdf?.count || 0;
  if (!entries.length) {
    return { attachments: [], count: 0, tripCount: 0, empty: true };
  }

  ensureDir(PATHS.UPLOADS);
  const zipName = `daily_report_${reportDate}.zip`;
  const zipPath = normalizePath(path.join(PATHS.UPLOADS, zipName));
  await zipEntries(zipPath, entries);

  const size = fs.statSync(zipPath).size;
  if (size > MAX_ATTACH_BYTES && tripCount > 0) {
    logger.warn('Daily report ZIP too large with trip PDFs — retrying without them', {
      size,
      reportDate,
    });
    const slim = entries.filter((e) => !String(e.name).startsWith('trip_pdfs/'));
    await zipEntries(zipPath, slim);
    tripCount = 0;
  }

  const finalSize = fs.statSync(zipPath).size;
  if (finalSize > MAX_ATTACH_BYTES) {
    throw new Error(
      `Daily report ZIP is too large for email (${Math.round(finalSize / (1024 * 1024))} MB)`,
    );
  }

  return {
    attachments: [
      {
        filename: zipName,
        path: zipPath,
      },
    ],
    count,
    tripCount,
    empty: false,
    zipPath,
    zipBytes: finalSize,
  };
}

function isNetworkishError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '').toLowerCase();
  if (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ESOCKET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
    ].includes(code)
  ) {
    return true;
  }
  return (
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('getaddrinfo') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('socket') ||
    msg.includes('connection')
  );
}

async function sendMail({ reportDate, bundle }) {
  const to = envStr('MAIL_TO') || envStr('MAIL_USER');
  const from = envStr('MAIL_FROM') || envStr('MAIL_USER');
  if (!to) throw new Error('MAIL_TO is not configured');

  const wbId = envStr('WEIGHBRIDGE_ID', 'WB');
  const site = envStr('SITE_NAME', 'Weighbridge');
  const subject = `[${wbId}] Daily weighbridge report — ${reportDate}`;

  let text;
  if (bundle.empty) {
    text =
      `Daily report for ${reportDate}\n` +
      `Site: ${site}\n` +
      `Weighbridge: ${wbId}\n\n` +
      `No closed tickets were found for this date.\n`;
  } else {
    text =
      `Daily report for ${reportDate}\n` +
      `Site: ${site}\n` +
      `Weighbridge: ${wbId}\n\n` +
      `Closed tickets: ${bundle.count}\n` +
      `Trip PDFs included: ${bundle.tripCount}\n` +
      `Attachment: ${bundle.attachments[0]?.filename || 'daily report ZIP'}\n`;
  }

  const transport = createTransport();
  await transport.sendMail({
    from,
    to,
    subject,
    text,
    attachments: bundle.attachments,
  });
}

async function runForDate(reportDate, options = {}) {
  if (!isMailEnabled()) {
    return { ok: false, reason: 'disabled' };
  }
  if (!reportDate) {
    return { ok: false, reason: 'no_date' };
  }
  if (alreadySent(reportDate) && !options.force) {
    clearRetry();
    pendingReportDate = null;
    return { ok: true, skipped: true, reason: 'already_sent', reportDate };
  }
  if (running) {
    return { ok: false, reason: 'busy', reportDate };
  }

  running = true;
  try {
    const online = await canReachMailNetwork();
    if (!online) {
      logger.warn('Daily report mail waiting for network', { reportDate, reason: options.reason });
      scheduleRetry(reportDate);
      return { ok: false, reason: 'offline', reportDate, willRetry: true };
    }

    const bundle = await buildAttachments(reportDate);
    await sendMail({ reportDate, bundle });
    markSent(reportDate);
    clearRetry();
    pendingReportDate = null;
    logger.info('Daily report mail sent', {
      reportDate,
      count: bundle.count,
      tripCount: bundle.tripCount,
      empty: bundle.empty,
      zipBytes: bundle.zipBytes || 0,
      reason: options.reason || 'schedule',
    });
    return { ok: true, reportDate, count: bundle.count, tripCount: bundle.tripCount };
  } catch (err) {
    logger.logError(`Daily report mail failed (${reportDate})`, err);
    if (isNetworkishError(err) || !(await canReachMailNetwork())) {
      scheduleRetry(reportDate);
      return {
        ok: false,
        reason: 'network_error',
        error: err.message,
        reportDate,
        willRetry: true,
      };
    }
    // Non-network failures still retry a few times (SMTP auth blips, temp Gmail errors)
    scheduleRetry(reportDate);
    return {
      ok: false,
      reason: 'send_error',
      error: err.message,
      reportDate,
      willRetry: true,
    };
  } finally {
    running = false;
  }
}

async function runScheduled() {
  const reportDate = targetReportDate();
  return runForDate(reportDate, { reason: 'cron' });
}

/** If app starts after 00:45 and yesterday was not mailed, catch up. */
async function catchUpIfNeeded() {
  if (!isMailEnabled()) return { ok: false, reason: 'disabled' };
  const reportDate = targetReportDate();
  if (alreadySent(reportDate)) {
    return { ok: true, skipped: true, reason: 'already_sent', reportDate };
  }
  logger.info('Daily report mail catch-up', { reportDate });
  return runForDate(reportDate, { reason: 'startup_catchup' });
}

function start() {
  stop();
  if (!isMailEnabled()) {
    logger.info('DailyReportMailService idle — mail disabled');
    return;
  }

  const expr = mailCronExpr();
  const timezone = mailTimezone();
  if (!cron.validate(expr)) {
    logger.error('DailyReportMailService invalid cron expression', { cron: expr });
    return;
  }

  cronJob = cron.schedule(
    expr,
    () => {
      runScheduled().catch((err) => logger.logError('Daily report mail cron', err));
    },
    { timezone },
  );

  logger.info('DailyReportMailService started', { cron: expr, timezone });
  setTimeout(() => {
    catchUpIfNeeded().catch((err) =>
      logger.logError('Daily report mail catch-up', err),
    );
  }, 45_000);
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  clearRetry();
  pendingReportDate = null;
  running = false;
}

const DailyReportMailService = {
  start,
  stop,
  runScheduled,
  runForDate,
  catchUpIfNeeded,
  targetReportDate,
  isMailEnabled,
  getStatus: () => ({
    enabled: isMailEnabled(),
    cron: mailCronExpr(),
    timezone: mailTimezone(),
    lastSentDate: envStr(SENT_KEY) || null,
    pendingReportDate,
    retrying: Boolean(retryTimer),
    running,
  }),
};

module.exports = DailyReportMailService;
