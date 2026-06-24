'use strict';

/**
 * Central IPC registrar. Each per-domain file exports `{ register(ipcMain) }`
 * and is wired in here. Phase 1: all handlers are stubs that return a
 * `not_implemented` payload but the channels exist so the renderer never
 * crashes when calling them.
 */
let electronIpcMain = null;
try {
  electronIpcMain = require('electron').ipcMain;
} catch (_e) {
  /* server mode — no Electron */
}

const MODULE_PATHS = [
  './auth.ipc',
  './transaction.ipc',
  './ticket.ipc',
  './vehicle.ipc',
  './device.ipc',
  './sync.ipc',
  './mcg.ipc',
  './workflow.ipc',
  './report.ipc',
  './settings.ipc',
  './backup.ipc',
  './storage.ipc',
];

let modules = null;
const loadErrors = [];

/** Load each IPC module independently so one broken dependency does not block the rest. */
function loadModules() {
  const loaded = [];
  for (const modulePath of MODULE_PATHS) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      loaded.push(require(modulePath));
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      loadErrors.push({ modulePath, message });
      // eslint-disable-next-line no-console
      console.error(`[ipc] Failed to load ${modulePath}:`, message);
    }
  }
  return loaded;
}

function getModules() {
  if (!modules) {
    modules = loadModules();
  }
  return modules;
}

function registerAll(ipcMainInstance) {
  const target = ipcMainInstance || electronIpcMain;
  if (!target) {
    throw new Error('ipcMain is not available (Electron not loaded)');
  }

  const loaded = getModules();
  if (loaded.length === 0) {
    throw new Error(
      'No IPC modules loaded — run npm install and check logs for require errors',
    );
  }

  const registered = [];
  const failed = [];

  for (const mod of loaded) {
    const ns = mod && mod.NAMESPACE ? mod.NAMESPACE : 'unknown';
    try {
      if (mod && typeof mod.register === 'function') {
        mod.register(target);
        registered.push(ns);
      }
    } catch (err) {
      failed.push({ namespace: ns, message: err && err.message });
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `IPC registration failed for: ${failed.map((f) => `${f.namespace} (${f.message})`).join('; ')}`,
    );
  }

  const authLoadError = loadErrors.find((e) => e.modulePath.includes('auth.ipc'));
  if (authLoadError) {
    throw new Error(`auth IPC failed to load: ${authLoadError.message}`);
  }
  if (!registered.includes('auth')) {
    throw new Error('auth IPC module did not register — admin login will not work');
  }

  return { registered, count: registered.length };
}

module.exports = { registerAll, getModules, loadErrors };
