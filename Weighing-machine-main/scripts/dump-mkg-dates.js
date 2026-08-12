'use strict';

/**
 * Dump closed MKG tickets with close dates for inspection.
 * Run: npx electron scripts/dump-mkg-dates.js
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
        `SELECT slip_number, company, ticket_status, truck_number,
                timestamp_in, timestamp_out, report_path
         FROM transactions
         WHERE UPPER(TRIM(COALESCE(company, ''))) = 'MKG'
           AND ticket_status = 'CLOSED'
         ORDER BY COALESCE(timestamp_out, timestamp_in)`,
      )
      .all();
    for (const r of rows) {
      const day = String(r.timestamp_out || r.timestamp_in || '').slice(0, 10);
      console.log(
        [r.slip_number, day, r.truck_number, r.timestamp_out || r.timestamp_in].join('\t'),
      );
    }
    console.log('count', rows.length);
    closeDatabase();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
