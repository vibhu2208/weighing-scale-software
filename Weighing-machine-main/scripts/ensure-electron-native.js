'use strict';

/**
 * Ensure native modules have Electron-compatible binaries before packaging.
 * node-gyp may fail when Visual Studio is not detected; prebuild-install works for better-sqlite3.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;

function hasBetterSqliteNode() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    path.join(ROOT, 'node_modules', 'better-sqlite3', 'lib', 'binding', `node-v128-win32-x64`, 'better_sqlite3.node'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function runPrebuild(moduleDir) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(
    npx,
    ['prebuild-install', '--runtime', 'electron', '--target', electronVersion, '--arch', 'x64'],
    { cwd: moduleDir, stdio: 'inherit', shell: true },
  );
}

if (!hasBetterSqliteNode()) {
  console.log(`ensure-electron-native: fetching better-sqlite3 for Electron ${electronVersion}`);
  runPrebuild(path.join(ROOT, 'node_modules', 'better-sqlite3'));
}

if (!hasBetterSqliteNode()) {
  console.error('ensure-electron-native: better_sqlite3.node still missing after prebuild-install');
  process.exit(1);
}

console.log('ensure-electron-native: OK');
