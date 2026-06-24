'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('./timestamp');
const { ensureDir } = require('./fileStorage');

let BrowserWindow = null;
try {
  BrowserWindow = require('electron').BrowserWindow;
} catch (_e) {
  /* server mode */
}

const PDF_UNAVAILABLE =
  'PDF export requires the desktop app (Electron). CSV export is available in server mode.';

/**
 * Render HTML to PDF via a hidden BrowserWindow.
 * Writes HTML to a temp file (avoids data: URL length limits with embedded images).
 * @param {string} html
 * @param {object} [options]
 * @returns {Promise<{ ok: true, pdf: Buffer } | { ok: false, error: string }>}
 */
async function renderHtmlToPdf(html, options = {}) {
  if (!BrowserWindow) {
    return { ok: false, error: PDF_UNAVAILABLE };
  }

  const tempDir = ensureDir(path.join(os.tmpdir(), 'weighbridge-pdf'));
  const tempHtml = path.join(tempDir, `render_${ts.fileSafe()}_${process.pid}.html`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true },
  });

  try {
    fs.writeFileSync(tempHtml, html, 'utf8');
    await win.loadFile(tempHtml);
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const imgs = Array.from(document.images || []);
        if (!imgs.length) {
          resolve(true);
          return;
        }
        let pending = imgs.length;
        const done = () => {
          pending -= 1;
          if (pending <= 0) resolve(true);
        };
        const timeout = setTimeout(() => resolve(true), 20000);
        imgs.forEach((img) => {
          const finish = () => {
            if (img.naturalWidth === 0) {
              img.style.display = 'none';
              const parent = img.closest('.photo-cell');
              if (parent) parent.classList.add('empty');
            }
            done();
          };
          if (img.complete) finish();
          else {
            img.addEventListener('load', finish, { once: true });
            img.addEventListener('error', finish, { once: true });
          }
        });
        if (pending <= 0) {
          clearTimeout(timeout);
          resolve(true);
        }
      })
    `);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      paperWidth: options.paperWidth ?? 8.27,
      paperHeight: options.paperHeight ?? 11.69,
      margins: options.margins ?? { marginType: 'default' },
    });
    return { ok: true, pdf };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    win.destroy();
    try {
      fs.unlinkSync(tempHtml);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Print HTML via a hidden BrowserWindow (desktop app only).
 * @param {string} html
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function printHtml(html) {
  if (!BrowserWindow) {
    return { ok: false, error: PDF_UNAVAILABLE };
  }

  const tempDir = ensureDir(path.join(os.tmpdir(), 'weighbridge-pdf'));
  const tempHtml = path.join(tempDir, `print_${ts.fileSafe()}_${process.pid}.html`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true },
  });

  try {
    fs.writeFileSync(tempHtml, html, 'utf8');
    await win.loadFile(tempHtml);
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const imgs = Array.from(document.images || []);
        if (!imgs.length) { resolve(true); return; }
        let pending = imgs.length;
        const done = () => { pending -= 1; if (pending <= 0) resolve(true); };
        const timeout = setTimeout(() => resolve(true), 20000);
        imgs.forEach((img) => {
          const finish = () => {
            if (img.naturalWidth === 0) {
              img.style.display = 'none';
              const parent = img.closest('.photo-cell');
              if (parent) parent.classList.add('empty');
            }
            done();
          };
          if (img.complete) finish();
          else {
            img.addEventListener('load', finish, { once: true });
            img.addEventListener('error', finish, { once: true });
          }
        });
        if (pending <= 0) { clearTimeout(timeout); resolve(true); }
      })
    `);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (success) resolve();
        else reject(new Error(failureReason || 'Print failed'));
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    win.destroy();
    try {
      fs.unlinkSync(tempHtml);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  renderHtmlToPdf,
  printHtml,
  PDF_UNAVAILABLE,
};
