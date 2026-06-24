'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let BrowserWindow = null;
try {
  BrowserWindow = require('electron').BrowserWindow;
} catch (_e) {
  /* server mode — slip PDF generation unavailable without Electron */
}
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const SettingsService = require('./SettingsService');
const {
  PATHS,
  ensureDir,
  normalizePath,
} = require('../utils/fileStorage');

const REPRINT_QUEUE_PATH = PATHS.REPRINT_QUEUE;
const THERMAL_QUEUE_DIR = PATHS.THERMAL_QUEUE;

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getCompanySettings() {
  return {
    name: SettingsService.get('COMPANY_NAME') || process.env.COMPANY_NAME || 'MUNICIPAL CORPORATION GURUGRAM',
    address: SettingsService.get('COMPANY_ADDRESS') || '',
    phone: SettingsService.get('COMPANY_PHONE') || '',
    siteName: SettingsService.get('SITE_NAME') || 'BANDHWARI SLF SITE GURURAM (HARYANA) DCC',
    weighbridgeId: SettingsService.get('WEIGHBRIDGE_ID') || process.env.WEIGHBRIDGE_ID || 'WB - 03',
    operator: SettingsService.get('DEFAULT_OPERATOR') || 'Operator',
  };
}

function formatKg(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toLocaleString('en-IN')} kg`;
}

function slipPaths(transactionId, date) {
  const { year, month, day } = ts.parts(date);
  const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
  return {
    pdf: normalizePath(path.join(dir, `${transactionId}_slip.pdf`)),
    thermal: normalizePath(path.join(dir, `${transactionId}_slip.txt`)),
  };
}

function buildSlipData(transaction) {
  const company = getCompanySettings();
  return {
    company,
    slip_number: transaction.slip_number,
    truck_number: transaction.truck_number,
    rfid_tag: transaction.rfid_tag,
    gross_weight: transaction.gross_weight,
    tare_weight: transaction.tare_weight,
    net_weight: transaction.net_weight,
    timestamp_in: transaction.timestamp_in,
    timestamp_out: transaction.timestamp_out,
    owner_name: transaction.owner_name,
    transporter: transaction.transporter,
    operator: company.operator,
    transaction_id: transaction.id,
  };
}

function buildSlipHtml(slip) {
  const c = slip.company;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 28px; color: #111; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #555; font-size: 11px; margin-top: 4px; }
  hr { border: none; border-top: 2px solid #333; margin: 16px 0; }
  .slip-no { font-size: 28px; font-weight: bold; margin: 12px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .label { color: #666; width: 38%; font-weight: 600; }
  .qr { margin-top: 20px; padding: 12px; border: 1px dashed #999; text-align: center; font-family: monospace; }
  .footer { margin-top: 24px; text-align: center; color: #666; font-size: 11px; }
</style></head><body>
  <h1>${c.name}</h1>
  <p class="sub">${c.siteName || c.address || ''}<br/>${c.weighbridgeId || ''}${c.phone ? `<br/>Tel: ${c.phone}` : ''}</p>
  <hr/>
  <div class="slip-no">Slip ${slip.slip_number || '—'}</div>
  <table>
    <tr><td class="label">Truck</td><td>${slip.truck_number || '—'}</td></tr>
    <tr><td class="label">RFID</td><td style="font-size:10px">${slip.rfid_tag || '—'}</td></tr>
    <tr><td class="label">Gross</td><td>${formatKg(slip.gross_weight)}</td></tr>
    <tr><td class="label">Tare</td><td>${formatKg(slip.tare_weight)}</td></tr>
    <tr><td class="label">Net</td><td><strong>${formatKg(slip.net_weight)}</strong></td></tr>
    <tr><td class="label">Time In</td><td>${ts.toDisplay(slip.timestamp_in)}</td></tr>
    <tr><td class="label">Time Out</td><td>${ts.toDisplay(slip.timestamp_out)}</td></tr>
    <tr><td class="label">Owner</td><td>${slip.owner_name || '—'}</td></tr>
    <tr><td class="label">Transporter</td><td>${slip.transporter || '—'}</td></tr>
  </table>
  <div class="qr">QR: ${slip.transaction_id}</div>
  <p class="footer">Operator: ${slip.operator} · Printed ${ts.toDisplay(ts.now())}</p>
</body></html>`;
}

function buildThermalText(slip) {
  const c = slip.company;
  const col = 40;
  const pad = (s) => String(s).slice(0, col).padEnd(col);
  const lines = [
    pad(c.name.slice(0, col)),
  pad('------------------------'),
    pad(`Slip: ${slip.slip_number || '—'}`),
    pad(`Truck: ${slip.truck_number || '—'}`),
    pad(`RFID: ${(slip.rfid_tag || '—').slice(0, 20)}`),
    pad(`Gross: ${formatKg(slip.gross_weight)}`),
    pad(`Tare: ${formatKg(slip.tare_weight)}`),
    pad(`Net: ${formatKg(slip.net_weight)}`),
    pad(`In: ${ts.toDisplay(slip.timestamp_in)}`),
    pad(`Out: ${ts.toDisplay(slip.timestamp_out)}`),
    pad('------------------------'),
    pad(`QR: ${slip.transaction_id}`),
    pad(`Op: ${slip.operator}`),
  ];
  return lines.join('\n');
}

async function renderPDF(slip, transaction) {
  const paths = slipPaths(transaction.id, transaction.timestamp_in);
  const html = buildSlipHtml(slip);

  if (!BrowserWindow) {
    const err = new Error('PDF slip generation requires the desktop app (Electron)');
    err.code = 'PDF_UNAVAILABLE';
    throw err;
  }

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true },
  });

  try {
    await win.loadURL(dataUrl);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      margins: { marginType: 'default' },
    });
    fs.writeFileSync(paths.pdf, pdf);
    if (slip.slip_number) {
      const reportCopy = normalizePath(
        path.join(PATHS.REPORTS, `${slip.slip_number}.pdf`),
      );
      ensureDir(PATHS.REPORTS);
      fs.copyFileSync(paths.pdf, reportCopy);
    }
    return paths.pdf;
  } finally {
    win.destroy();
  }
}

function queueThermalFile(transactionId, text) {
  ensureDir(THERMAL_QUEUE_DIR);
  const name = `${transactionId}_${ts.fileSafe()}.txt`;
  const dest = path.join(THERMAL_QUEUE_DIR, name);
  fs.writeFileSync(dest, text, 'utf8');
  return dest;
}

function printThermalFile(filePath, printerName) {
  return new Promise((resolve, reject) => {
    if (!printerName) {
      resolve({ printed: false, savedOnly: true });
      return;
    }
    const safePath = filePath.replace(/'/g, "''");
    const safePrinter = printerName.replace(/'/g, "''");
    const cmd =
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "Get-Content -LiteralPath '${safePath}' | Out-Printer -Name '${safePrinter}'"`
        : `lp -d "${printerName}" "${filePath}"`;
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve({ printed: true });
    });
  });
}

function queueReprint(transactionId) {
  const queue = readJsonSafe(REPRINT_QUEUE_PATH, []);
  if (!queue.includes(transactionId)) {
    queue.push(transactionId);
    writeJsonSafe(REPRINT_QUEUE_PATH, queue);
  }
}

function dequeueReprint(transactionId) {
  const queue = readJsonSafe(REPRINT_QUEUE_PATH, []);
  writeJsonSafe(
    REPRINT_QUEUE_PATH,
    queue.filter((id) => id !== transactionId),
  );
}

async function queueThermalPrint(slip, transaction) {
  const paths = slipPaths(transaction.id, transaction.timestamp_in);
  const text = buildThermalText(slip);
  fs.writeFileSync(paths.thermal, text, 'utf8');

  const printerName = SettingsService.get('PRINTER_NAME') || process.env.PRINTER_NAME || '';
  try {
    const result = await printThermalFile(paths.thermal, printerName);
    return { ...result, path: paths.thermal, text };
  } catch (err) {
    const queued = queueThermalFile(transaction.id, text);
    logger.warn('Thermal print failed — queued', {
      message: err.message,
      queuePath: queued,
    });
    return { printed: false, queued: true, path: queued, text };
  }
}

const PrintService = {
  async generateSlip(transaction) {
    if (!transaction || !transaction.id) {
      throw new Error('Transaction required for slip generation');
    }

    const slip = buildSlipData(transaction);
    let pdfPath = null;
    let pdfError = null;

    try {
      pdfPath = await renderPDF(slip, transaction);
      dequeueReprint(transaction.id);
    } catch (err) {
      pdfError = err;
      logger.logError('PDF slip generation failed', err);
      queueReprint(transaction.id);
    }

    const thermal = await queueThermalPrint(slip, transaction);

    if (pdfError) {
      return {
        ok: false,
        pdfPending: true,
        pdfPath: null,
        thermalPath: thermal.path,
        printed: thermal.printed,
        error: pdfError.message,
      };
    }

    logger.logTransaction(transaction.id, 'Slip generated', { pdfPath });
    return {
      ok: true,
      pdfPath,
      thermalPath: thermal.path,
      printed: thermal.printed,
      queued: thermal.queued,
    };
  },

  async reprintSlip(transactionId) {
    const TransactionService = require('./TransactionService');
    const txn = TransactionService.getById(transactionId);
    if (!txn) throw new Error('Transaction not found');
    return this.generateSlip(txn);
  },

  getSlipPath(transactionId) {
    const TransactionService = require('./TransactionService');
    const txn = TransactionService.getById(transactionId);
    if (!txn) return null;
    const p = slipPaths(transactionId, txn.timestamp_in).pdf;
    return fs.existsSync(p) ? p : null;
  },

  listSlips() {
    const results = [];
    const uploads = PATHS.UPLOADS;
    if (!fs.existsSync(uploads)) return results;

    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('_slip.pdf')) {
          const st = fs.statSync(full);
          const id = ent.name.replace('_slip.pdf', '');
          results.push({
            transactionId: id,
            path: normalizePath(full),
            size: st.size,
            created_at: st.mtime.toISOString(),
          });
        }
      }
    };
    walk(uploads);
    return results.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },

  listThermalQueue() {
    ensureDir(THERMAL_QUEUE_DIR);
    return fs.readdirSync(THERMAL_QUEUE_DIR).map((filename) => {
      const full = path.join(THERMAL_QUEUE_DIR, filename);
      const st = fs.statSync(full);
      return { filename, path: full, size: st.size, created_at: st.mtime.toISOString() };
    });
  },

  async resendThermalQueueFile(filename, printerName) {
    const full = path.join(THERMAL_QUEUE_DIR, filename);
    if (!fs.existsSync(full)) throw new Error('Queue file not found');
    const name = printerName || SettingsService.get('PRINTER_NAME') || '';
    return printThermalFile(full, name);
  },

  async processReprintQueue() {
    const queue = readJsonSafe(REPRINT_QUEUE_PATH, []);
    if (!queue.length) return { processed: 0 };
    let processed = 0;
    for (const id of [...queue]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.reprintSlip(id);
        if (result.ok && result.pdfPath) {
          dequeueReprint(id);
          processed += 1;
        }
      } catch (err) {
        logger.logError(`Reprint queue item ${id}`, err);
      }
    }
    return { processed, remaining: readJsonSafe(REPRINT_QUEUE_PATH, []).length };
  },

  retryPrint: (transactionId) => PrintService.reprintSlip(transactionId),
};

module.exports = PrintService;
