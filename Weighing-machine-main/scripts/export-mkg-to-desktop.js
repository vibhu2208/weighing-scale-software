'use strict';

/**
 * Regenerate all closed MKG trip PDFs, then copy PDFs + Excel to Desktop.
 * Run: node scripts/export-mkg-to-desktop.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const listScript = path.join(__dirname, 'list-mkg-tickets.js');
const oneScript = path.join(__dirname, 'regen-one-report.js');
const excelScript = path.join(__dirname, 'export-mkg-excel.js');
const listOut = path.join(os.tmpdir(), `mkg-tickets-${process.pid}.json`);
const desktop = path.join(os.homedir(), 'Desktop');
const outDir = path.join(desktop, 'MKG_Reports');

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

loadEnvFile(path.join(root, '.env'));
loadEnvFile(
  path.join(process.env.APPDATA || '', 'weighbridge-app', 'weighbridge-data', '.env'),
  true,
);

fs.mkdirSync(outDir, { recursive: true });

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

const tickets = JSON.parse(fs.readFileSync(listOut, 'utf8'));
try {
  fs.unlinkSync(listOut);
} catch {
  /* ignore */
}

console.log(`Found ${tickets.length} closed MKG ticket(s)`);
if (!tickets.length) process.exit(0);

let okCount = 0;
let failCount = 0;
for (let i = 0; i < tickets.length; i += 1) {
  const slip = tickets[i].slip_number;
  process.stdout.write(`Regenerating ${i + 1}/${tickets.length} ${slip}... `);
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
    const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-500);
    if (tail) console.error(tail);
  }
}

console.log(`Regen done. ok=${okCount} failed=${failCount}`);

const reportsDir = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
  'reports',
);

let copied = 0;
for (const t of tickets) {
  const src = path.join(reportsDir, `${t.slip_number}_report.pdf`);
  const dest = path.join(outDir, `${t.slip_number}_report.pdf`);
  if (!fs.existsSync(src)) {
    console.error('Missing PDF:', src);
    continue;
  }
  fs.copyFileSync(src, dest);
  copied += 1;
  console.log('Copied', t.slip_number);
}

const excelResult = spawnSync(electronBin, [excelScript, outDir], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
  timeout: 120000,
});
if (excelResult.status === 0) {
  console.log((excelResult.stderr || excelResult.stdout || '').trim());
} else {
  console.error('Excel export failed');
  console.error(excelResult.stderr || excelResult.stdout);
}

console.log(`Saved ${copied} PDFs + Excel to ${outDir}`);
process.exit(failCount ? 1 : 0);
