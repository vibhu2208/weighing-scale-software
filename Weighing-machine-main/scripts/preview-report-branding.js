'use strict';

/**
 * Print report branding preview HTML snippets for one slip (no PDF render).
 * Run: npx electron scripts/preview-report-branding.js WB2634
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function loadEnvFile(filePath, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (overwrite || !process.env[key]) process.env[key] = val;
  }
}

const SLIP = String(process.argv[2] || 'WB2634').trim();
const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

app.whenReady().then(async () => {
  try {
    const { initPackagedStorage } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
    const { initDatabase, closeDatabase } = require('../backend/database/db');
    const TransactionService = require('../backend/services/TransactionService');
    const ReportService = require('../backend/services/ReportService');

    initDatabase();
    const txn = TransactionService.getBySlipNumber(SLIP);
    if (!txn) throw new Error(`${SLIP} not found`);

    const preview = await ReportService.getReportPreviewHtml(txn.id);
    if (!preview.ok) throw new Error(preview.error || 'preview failed');

    const html = preview.html || '';
    const siteMatch = html.match(/class="site-name">([^<]*)</);
    const companyMatch = html.match(/Company_Name<\/span> : ([^<]*)</);
    console.log(
      JSON.stringify(
        {
          slip: txn.slip_number,
          company: txn.company,
          siteName: siteMatch ? siteMatch[1] : null,
          companyName: companyMatch ? companyMatch[1] : null,
          hasDCC: /\bDCC\b/.test(html),
          hasMKG: /\bMKG\b/.test(html),
          hasDayaCharan: /DAYA CHARAN/i.test(html),
        },
        null,
        2,
      ),
    );

    closeDatabase();
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
