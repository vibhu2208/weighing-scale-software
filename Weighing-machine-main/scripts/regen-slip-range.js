'use strict';

/**
 * Regenerate closed-ticket PDFs for a slip range (fresh Electron per slip).
 * Run: node scripts/regen-slip-range.js WB2697 WB2754
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

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

function parseSlipNumeric(slip) {
  const match = String(slip || '').match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

const FROM = parseSlipNumeric(process.argv[2] || 'WB2697');
const TO = parseSlipNumeric(process.argv[3] || 'WB2754');
if (!FROM || !TO || FROM > TO) {
  console.error('Usage: node scripts/regen-slip-range.js WB2697 WB2754');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

const listPy = `
import os, sqlite3, json, sys
p = os.path.join(os.environ['APPDATA'], 'weighbridge-app', 'weighbridge-data', 'database', 'weighbridge.db')
conn = sqlite3.connect('file:' + p + '?mode=ro', uri=True)
conn.row_factory = sqlite3.Row
from_n, to_n = int(sys.argv[1]), int(sys.argv[2])
rows = conn.execute(
    """SELECT slip_number, truck_number FROM transactions
       WHERE slip_number LIKE 'WB%'
         AND CAST(substr(slip_number, 3) AS INTEGER) BETWEEN ? AND ?
         AND ticket_status = 'CLOSED'
       ORDER BY CAST(substr(slip_number, 3) AS INTEGER)""",
    (from_n, to_n),
).fetchall()
print(json.dumps([dict(r) for r in rows]))
conn.close()
`;
const listed = spawnSync('python', ['-c', listPy, String(FROM), String(TO)], {
  encoding: 'utf8',
  env: process.env,
});
if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout || 'Failed to list slips');
  process.exit(1);
}
const rows = JSON.parse(listed.stdout);

const electronBin = require('electron');
const oneScript = path.join(__dirname, 'regen-one-report.js');
console.log(`Regenerating ${rows.length} closed PDF(s) WB${FROM}..WB${TO}`);

let ok = 0;
let fail = 0;
for (let i = 0; i < rows.length; i += 1) {
  const slip = rows[i].slip_number;
  process.stdout.write(`${i + 1}/${rows.length} ${slip} ${rows[i].truck_number}... `);
  const result = spawnSync(electronBin, [oneScript, slip], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 180000,
  });
  if (result.status === 0) {
    ok += 1;
    console.log('ok');
  } else {
    fail += 1;
    console.log('FAILED');
    const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-500);
    if (tail) console.error(tail);
  }
}

console.log(`Done. ok=${ok} failed=${fail} total=${rows.length}`);
process.exit(fail ? 1 : 0);
