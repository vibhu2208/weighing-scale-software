'use strict';

/**
 * List closed MKG tickets to a JSON file (needs Electron's better-sqlite3 build).
 * Run: npx electron scripts/list-mkg-tickets.js [out.json]
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

const outPath =
  String(process.argv[2] || '').trim() ||
  path.join(require('os').tmpdir(), 'mkg-tickets.json');

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

app.whenReady().then(() => {
  try {
    const { initPackagedStorage } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
    const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
    initDatabase();
    const rows = getDb()
      .prepare(
        `SELECT id, slip_number, company, ticket_status, report_path
         FROM transactions
         WHERE UPPER(TRIM(COALESCE(company, ''))) = 'MKG'
           AND ticket_status = 'CLOSED'
         ORDER BY slip_number`,
      )
      .all();
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8');
    console.error(`Wrote ${rows.length} MKG ticket(s) to ${outPath}`);
    closeDatabase();
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
