'use strict';

/**
 * Force-rebuild PDF reports for all closed MKG tickets so site/company
 * branding shows MKG (not DCC). Spawns a fresh Electron process per slip
 * because Chromium often crashes after the first hidden BrowserWindow PDF.
 *
 * Run: node scripts/regen-mkg-reports.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const listScript = path.join(__dirname, 'list-mkg-tickets.js');
const oneScript = path.join(__dirname, 'regen-one-report.js');
const listOut = path.join(os.tmpdir(), `mkg-tickets-${process.pid}.json`);

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
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);

const listed = spawnSync(electronBin, [listScript, listOut], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
  timeout: 120000,
});
if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout || 'Failed to list MKG tickets');
  process.exit(1);
}

if (!fs.existsSync(listOut)) {
  console.error('Ticket list file was not created:', listOut);
  process.exit(1);
}

let tickets = [];
try {
  tickets = JSON.parse(fs.readFileSync(listOut, 'utf8'));
} catch (err) {
  console.error('Could not parse ticket list:', err.message);
  process.exit(1);
} finally {
  try {
    fs.unlinkSync(listOut);
  } catch {
    /* ignore */
  }
}

console.log(`Found ${tickets.length} closed MKG ticket(s) to regenerate`);
if (!tickets.length) process.exit(0);

let okCount = 0;
let failCount = 0;
for (let i = 0; i < tickets.length; i += 1) {
  const slip = tickets[i].slip_number;
  const label = `${i + 1}/${tickets.length} ${slip}`;
  process.stdout.write(`Regenerating ${label}... `);
  const result = spawnSync(electronBin, [oneScript, slip], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 180000,
  });
  if (result.status === 0) {
    okCount += 1;
    console.log('ok');
  } else {
    failCount += 1;
    console.log('FAILED');
    const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-800);
    if (tail) console.error(tail);
  }
}

console.log(`Done. ok=${okCount} failed=${failCount} total=${tickets.length}`);
process.exit(failCount ? 1 : 0);
