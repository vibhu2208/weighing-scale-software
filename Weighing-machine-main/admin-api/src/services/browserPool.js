'use strict';

const fs = require('fs');

/**
 * Shared Chromium for slip PDF rendering.
 * Cold-launching puppeteer per PDF costs 1–3s and thrashs memory under ZIP load.
 * Pages are still created per job; only the browser process is reused.
 */

let browserPromise = null;
let launchLock = null;
let activePages = 0;
const waitQueue = [];
let resolvedExecutablePath;

const PAGE_TIMEOUT_MS = Number(process.env.PDF_PAGE_TIMEOUT_MS || 60000);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

function maxConcurrency() {
  const n = Number(process.env.PDF_BROWSER_CONCURRENCY || 2);
  return Number.isFinite(n) && n >= 1 ? Math.min(4, Math.floor(n)) : 2;
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    const path = String(candidate || '').trim();
    if (!path) continue;
    try {
      if (fs.existsSync(path)) return path;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function resolveExecutablePath() {
  if (resolvedExecutablePath !== undefined) return resolvedExecutablePath;

  const candidates = [(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim()];
  try {
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      candidates.push(puppeteer.executablePath());
    }
  } catch {
    /* puppeteer may not be resolvable yet */
  }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  );

  resolvedExecutablePath = firstExistingPath(candidates);
  if (!resolvedExecutablePath && candidates[0]) {
    // Keep explicit env path so puppeteer surfaces a clear missing-binary error.
    resolvedExecutablePath = candidates[0];
  }
  return resolvedExecutablePath;
}

function launchArgs() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  };
  const executablePath = resolveExecutablePath();
  if (executablePath) opts.executablePath = executablePath;
  return opts;
}

async function createBrowser() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch(launchArgs());
  browser.on('disconnected', () => {
    if (browserPromise) {
      browserPromise = null;
    }
  });
  return browser;
}

async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      if (browser.isConnected()) return browser;
    } catch {
      browserPromise = null;
    }
  }
  if (!launchLock) {
    launchLock = createBrowser()
      .then((browser) => {
        browserPromise = Promise.resolve(browser);
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      })
      .finally(() => {
        launchLock = null;
      });
  }
  return launchLock;
}

function acquireSlot() {
  if (activePages < maxConcurrency()) {
    activePages += 1;
    return Promise.resolve();
  }
  // Waiters inherit the slot on handoff — do not re-increment in .then(),
  // or a concurrent acquire can oversubscribe between release and wake.
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  });
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    next();
    return;
  }
  activePages = Math.max(0, activePages - 1);
}

/**
 * Run `fn(page)` with a pooled browser page under a concurrency limit.
 * @template T
 * @param {(page: import('puppeteer').Page) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPdfPage(fn) {
  await acquireSlot();
  let page = null;
  try {
    const browser = await withTimeout(getBrowser(), PAGE_TIMEOUT_MS, 'browser launch');
    page = await browser.newPage();
    return await withTimeout(fn(page), PAGE_TIMEOUT_MS, 'PDF render');
  } catch (err) {
    // Drop a broken/hung browser so the next call relaunches and slots free.
    const msg = String(err && err.message ? err.message : err || '');
    if (
      /timed out|Target closed|Session closed|Browser disconnected|Protocol error/i.test(
        msg,
      )
    ) {
      const broken = browserPromise;
      browserPromise = null;
      if (broken) {
        broken
          .then((b) => b.close().catch(() => {}))
          .catch(() => {});
      }
    }
    throw err;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
    releaseSlot();
  }
}

async function closeBrowserPool() {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* ignore */
  }
}

module.exports = {
  withPdfPage,
  closeBrowserPool,
  maxConcurrency,
};
