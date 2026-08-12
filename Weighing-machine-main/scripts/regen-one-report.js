'use strict';

/**
 * Regenerate one closed ticket PDF by slip number (fresh Electron process).
 * Run: npx electron scripts/regen-one-report.js WB2634
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

const SLIP = String(process.argv[2] || '').trim();
if (!SLIP) {
  console.error('Usage: npx electron scripts/regen-one-report.js <SLIP>');
  process.exit(1);
}

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
    console.log('Before:', {
      slip: txn.slip_number,
      company: txn.company,
      status: txn.ticket_status,
      report_path: txn.report_path,
    });

    const result = await ReportService.regenerateTripPDF(txn.id);
    console.log('regenerateTripPDF:', result);

    closeDatabase();
    app.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
