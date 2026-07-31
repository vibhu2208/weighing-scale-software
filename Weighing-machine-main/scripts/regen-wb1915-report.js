'use strict';

/**
 * Regenerate WB1915 trip PDF (needs real Electron, not ELECTRON_RUN_AS_NODE).
 * Run: npx electron scripts/regen-wb1915-report.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const SLIP = 'WB1915';

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
      truck: txn.truck_number,
      customer: txn.customer_name,
      destination: txn.destination,
      operator: txn.operator_name,
      material: txn.material,
      report_path: txn.report_path,
      status: txn.ticket_status,
    });

    const result = await ReportService.regenerateTripPDF(txn.id);
    console.log('regenerateTripPDF:', result);

    const after = TransactionService.getBySlipNumber(SLIP);
    console.log('After report_path:', after?.report_path);
    if (after?.report_path) {
      console.log('report exists:', fs.existsSync(after.report_path));
    }
    const slipCopy = path.join(appDataRoot, 'reports', `${SLIP}_report.pdf`);
    console.log('slip copy:', slipCopy, 'exists:', fs.existsSync(slipCopy));
    if (fs.existsSync(slipCopy)) {
      const st = fs.statSync(slipCopy);
      console.log('slip copy mtime:', st.mtime.toISOString(), 'size:', st.size);
    }

    closeDatabase();
    console.log('Done.');
    app.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
