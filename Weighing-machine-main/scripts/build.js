#!/usr/bin/env node
'use strict';

/**
 * Convenience runner that ties together `vite build` and `electron-builder`.
 * The package.json `build` script invokes them directly; this file exists so
 * the build pipeline has a single point you can extend (e.g. sign installers).
 */
const { spawnSync } = require('child_process');
const path = require('path');

function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: path.resolve(__dirname, '..'),
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run('npx', ['vite', 'build', '--config', 'frontend/vite.config.js']);
run('npx', ['electron-builder', '--config', 'electron-builder.config.js']);

console.log('\n✓ Build complete. See release/ for installers.');
