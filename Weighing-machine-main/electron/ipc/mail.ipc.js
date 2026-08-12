'use strict';

const DailyReportMailService = require('../../backend/services/DailyReportMailService');

const NAMESPACE = 'mail';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getStatus`, async () => DailyReportMailService.getStatus());

  ipcMain.handle(`${NAMESPACE}:sendDailyReportNow`, async (_e, options = {}) => {
    const reportDate =
      (options && options.reportDate) || DailyReportMailService.targetReportDate();
    return DailyReportMailService.runForDate(reportDate, {
      reason: 'manual',
      force: options?.force !== false,
    });
  });

  ipcMain.handle(`${NAMESPACE}:sendTestMail`, async () => {
    const nodemailer = require('nodemailer');
    const SettingsService = require('../../backend/services/SettingsService');
    const get = (key, fallback = '') => {
      const v = SettingsService.get(key);
      if (v === undefined || v === null || v === '') return fallback;
      return String(v).trim();
    };
    const user = get('MAIL_USER');
    const pass = get('MAIL_PASS');
    const to = get('MAIL_TO') || user;
    const from = get('MAIL_FROM') || user;
    if (!user || !pass) {
      return { ok: false, error: 'MAIL_USER / MAIL_PASS are not configured' };
    }
    if (!to) {
      return { ok: false, error: 'MAIL_TO is not configured' };
    }
    const transport = nodemailer.createTransport({
      host: get('MAIL_HOST', 'smtp.gmail.com'),
      port: parseInt(get('MAIL_PORT', '587'), 10) || 587,
      secure: String(get('MAIL_SECURE', 'false')).toLowerCase() === 'true',
      auth: { user, pass },
    });
    await transport.verify();
    await transport.sendMail({
      from,
      to,
      subject: `[${get('WEIGHBRIDGE_ID', 'WB')}] Weighbridge mail test`,
      text:
        'This is a test email from the weighbridge app.\n' +
        `Sent at: ${new Date().toISOString()}\n`,
    });
    return { ok: true, to };
  });
}

module.exports = { register, NAMESPACE };
