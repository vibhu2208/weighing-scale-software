'use strict';

/**
 * Export closed MKG tickets to Excel in a target folder.
 * Run: npx electron scripts/export-mkg-excel.js <outDir>
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

const outDir = String(process.argv[2] || '').trim() || path.join(require('os').homedir(), 'Desktop', 'MKG_Reports');
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
    const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
    const ReportService = require('../backend/services/ReportService');

    initDatabase();
    fs.mkdirSync(outDir, { recursive: true });

    const ids = getDb()
      .prepare(
        `SELECT id FROM transactions
         WHERE UPPER(TRIM(COALESCE(company, ''))) = 'MKG'
           AND ticket_status = 'CLOSED'
         ORDER BY slip_number`,
      )
      .all()
      .map((r) => r.id);

    if (!ids.length) throw new Error('No closed MKG tickets');

    const result = await ReportService.exportExcelByIds(ids);
    if (!result.ok) throw new Error(result.error || 'Excel export failed');

    const dest = path.join(outDir, 'MKG_tickets.xlsx');
    fs.copyFileSync(result.path, dest);
    console.error(`Excel saved: ${dest} (count=${result.count})`);

    closeDatabase();
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
