'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, Menu, shell, protocol } = require('electron');

// Load .env from project root before anything else.
// Fall back to defaults instead of crashing if missing (edge case).
try {
  const dotenvPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
  } else {
    require('dotenv').config();
  }
} catch (e) {
  // dotenv is optional – continue with process defaults
  // eslint-disable-next-line no-console
  console.warn('[main] dotenv not loaded:', e && e.message);
}

const isDev = (process.env.APP_ENV || 'production') === 'development';

/** Allow renderer to load captured images from uploads/ (file:// is blocked from http origins). */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weighbridge-local',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

function registerLocalMediaProtocol() {
  const fileStorage = require('../backend/utils/fileStorage');
  const localMedia = require('../backend/utils/localMedia');

  protocol.handle('weighbridge-local', async (request) => {
    try {
      const filePath = localMedia.resolveMediaFilePath(request.url, fileStorage);
      if (!filePath || !localMedia.isAllowedMediaPath(filePath, fileStorage)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 });
      }
      return localMedia.readMediaResponse(filePath);
    } catch (err) {
      return new Response(err.message || 'Error', { status: 500 });
    }
  });
}

// Default dev URL – may be overridden if Vite picks a different port (edge case: 5173 in use)
const DEFAULT_VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);
let resolvedDevUrl = `http://localhost:${DEFAULT_VITE_PORT}`;

let mainWindow = null;

/** Lazy-loaded backend hooks. Wrapped in try/catch so a missing module
 *  during early Phase 1 doesn't crash the shell. */
function safeRequire(modulePath, label) {
  try {
    return require(modulePath);
  } catch (err) {
    console.warn(`[main] Optional module not loaded (${label}): ${err.message}`);
    return null;
  }
}

async function bootstrapBackend() {
  const logger = safeRequire('../backend/utils/logger', 'logger');
  const log = logger && (logger.default || logger);

  try {
    const { PATHS } = require('../backend/utils/fileStorage');
    log &&
      log.info &&
      log.info('Application storage paths', {
        root: PATHS.ROOT,
        database: PATHS.DATABASE,
        logs: PATHS.LOGS,
        packaged: app.isPackaged,
      });
  } catch (_e) {
    /* optional */
  }

  const tryInvoke = async (label, fn) => {
    if (typeof fn !== 'function') return;
    try {
      await fn();
      log && log.info && log.info(`[bootstrap] ${label} OK`);
    } catch (err) {
      log && log.error && log.error(`[bootstrap] ${label} failed: ${err.message}`);
    }
  };

  const db = safeRequire('../backend/database/db', 'db');
  await tryInvoke('initDatabase', db && (db.initDatabase || db.default?.initDatabase));

  const monitor = safeRequire('../backend/services/DeviceMonitorService', 'DeviceMonitorService');
  if (monitor && typeof monitor.start === 'function') {
    await tryInvoke('startDeviceMonitor', () =>
      monitor.start(() => mainWindow),
    );
  }

  const queue = safeRequire('../backend/engine/SyncQueue', 'SyncQueue');
  await tryInvoke('startSyncQueue', queue && (queue.start || queue.default?.start));

  const SlipNumberService = safeRequire(
    '../backend/services/SlipNumberService',
    'SlipNumberService',
  );
  await tryInvoke('syncSlipCounter', SlipNumberService && SlipNumberService.syncOnStartup);

  const remoteTripSync = safeRequire(
    '../backend/services/RemoteTripSyncService',
    'RemoteTripSyncService',
  );
  await tryInvoke(
    'startRemoteTripSync',
    remoteTripSync && remoteTripSync.start,
  );

  const workflow = safeRequire('../backend/engine/WorkflowEngine', 'WorkflowEngine');
  if (workflow) {
    await tryInvoke('initWorkflowEngine', async () => {
      workflow.init(() => mainWindow);
      workflow.bindDeviceEvents();
    });
  }

  const ipc = safeRequire('./ipc', 'ipc-registry');
  const registerAll = ipc && (ipc.registerAll || ipc.default?.registerAll);
  if (typeof registerAll !== 'function') {
    throw new Error(
      'IPC registry failed to load. Run "npm install" in weighbridge-app, then restart.',
    );
  }
  try {
    const result = registerAll();
    log &&
      log.info &&
      log.info('[bootstrap] registerAllIPC OK', {
        channels: result && result.count,
        namespaces: result && result.registered,
      });
  } catch (err) {
    const loadDetail =
      ipc.loadErrors && ipc.loadErrors.length
        ? `\nIPC load errors: ${ipc.loadErrors.map((e) => `${e.modulePath}: ${e.message}`).join('; ')}`
        : '';
    const message = `${err.message || err}${loadDetail}`;
    log && log.error && log.error('[bootstrap] registerAllIPC failed', { message });
    throw new Error(message);
  }

  const rendererEvents = safeRequire('../backend/utils/rendererEvents', 'rendererEvents');
  if (rendererEvents && rendererEvents.setWindowGetter) {
    rendererEvents.setWindowGetter(() => mainWindow);
  }

  const backup = safeRequire('../backend/services/BackupService', 'BackupService');
  if (backup && typeof backup.start === 'function') {
    await tryInvoke('startBackupService', () =>
      backup.start({ getWindow: () => mainWindow }),
    );
  }

  const cloudBackup = safeRequire('../backend/services/CloudBackupService', 'CloudBackupService');
  if (cloudBackup && typeof cloudBackup.start === 'function') {
    await tryInvoke('startCloudBackupService', () =>
      cloudBackup.start({ getWindow: () => mainWindow }),
    );
  }

  const cloudLogs = safeRequire('../backend/services/CloudLogUploadService', 'CloudLogUploadService');
  if (cloudLogs && typeof cloudLogs.start === 'function') {
    await tryInvoke('startCloudLogUploadService', () => cloudLogs.start());
  }

  const print = safeRequire('../backend/services/PrintService', 'PrintService');
  if (print && typeof print.processReprintQueue === 'function') {
    await tryInvoke('processReprintQueue', () => print.processReprintQueue());
  }
}

/**
 * Wait for the Vite dev server. Retries up to 30 s.
 */
async function waitForViteDev(url, timeoutMs = 30000) {
  const start = Date.now();
  const probe = () =>
    new Promise((resolve) => {
      const req = require('http').get(url, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });

  // Try the configured port first, then scan a small range in case Vite chose another port.
  const candidates = [url];
  for (let p = DEFAULT_VITE_PORT + 1; p <= DEFAULT_VITE_PORT + 10; p += 1) {
    candidates.push(`http://localhost:${p}`);
  }

  while (Date.now() - start < timeoutMs) {
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(candidate)) {
        resolvedDevUrl = candidate;
        return candidate;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`Vite dev server not reachable at ${url} after ${timeoutMs} ms`);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: !isDev,
    title: 'Weighbridge Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true,
    },
  });

  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the default browser, not inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function loadRenderer() {
  if (isDev) {
    const url = await waitForViteDev(resolvedDevUrl, 30000);
    await mainWindow.loadURL(url);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
    await mainWindow.loadFile(indexHtml);
  }
}

function resolveLogHint() {
  try {
    const { PATHS } = require('../backend/utils/fileStorage');
    return path.join(PATHS.LOGS, 'app.log');
  } catch (_e) {
    if (app.isPackaged) {
      return path.join(app.getPath('userData'), 'weighbridge-data', 'logs', 'app.log');
    }
    return path.join(__dirname, '..', 'logs', 'app.log');
  }
}

async function startup() {
  try {
    if (app.isPackaged) {
      const { initPackagedStorage } = require('../backend/utils/fileStorage');
      initPackagedStorage(app.getPath('userData'));
      const userEnv = path.join(app.getPath('userData'), 'weighbridge-data', '.env');
      if (fs.existsSync(userEnv)) {
        try {
          require('dotenv').config({ path: userEnv });
        } catch (e) {
          console.warn('[main] user .env not loaded:', e && e.message);
        }
      }
    }

    registerLocalMediaProtocol();
    createMainWindow();
    await bootstrapBackend();
    await loadRenderer();
  } catch (err) {
    const message =
      (err && err.message) || 'Unknown error during application startup.';
    const logPath = resolveLogHint();
    // eslint-disable-next-line no-console
    console.error('[main] Startup failure:', err);
    dialog.showErrorBox(
      'Weighbridge Manager failed to start',
      `${message}\n\nLog file:\n${logPath}`,
    );
    app.exit(1);
  }
}

app.whenReady().then(startup);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) startup();
});

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[main] unhandledRejection:', reason);
});
