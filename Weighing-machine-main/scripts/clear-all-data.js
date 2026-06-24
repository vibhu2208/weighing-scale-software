#!/usr/bin/env node
'use strict';

/**
 * Wipes local weighbridge data (DB, uploads, reports, images, backups, logs)
 * and optionally S3 prefixes: db-backups/, reports/, images/
 *
 * Usage (close the Electron app first):
 *   npm run clear-data -- --yes
 *   npm run clear-data -- --yes --s3
 *   npm run clear-data -- --yes --with-seed   # empty DB then demo seed
 */
const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_e) {
  /* optional */
}

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const purgeS3 = args.includes('--s3');
const withSeed = args.includes('--with-seed');

if (!confirmed) {
  console.error(
    'Refusing to run without --yes\n' +
      '  npm run clear-data -- --yes           # local only\n' +
      '  npm run clear-data -- --yes --s3      # local + AWS S3 backup folders\n' +
      '  npm run clear-data -- --yes --with-seed\n\n' +
      'Close the weighbridge app (npm run dev) before running.',
  );
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const WIPE_DIRS = ['uploads', 'reports', 'images', 'backups', 'logs'];

function emptyDirectory(dir) {
  const target = path.join(ROOT, dir);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    return 0;
  }
  let removed = 0;
  for (const name of fs.readdirSync(target)) {
    if (name === '.gitkeep') continue;
    const full = path.join(target, name);
    fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function removeDatabaseFiles() {
  const db = require('../backend/database/db');
  const dbPath = db.resolveDbPath();
  const related = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  db.closeDatabase();
  let removed = 0;
  for (const p of related) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed += 1;
      console.log(`  removed ${path.relative(ROOT, p)}`);
    }
  }
  return removed;
}

async function purgeS3Prefixes() {
  const S3Service = require('../backend/services/S3Service');
  if (!S3Service.isConfigured()) {
    console.log('S3: skipped (AWS credentials not set)');
    return { deleted: 0 };
  }
  const prefixes = ['db-backups/', 'reports/', 'images/', 'logs/'];
  let deleted = 0;
  for (const prefix of prefixes) {
    const keys = await S3Service.listAllKeys(prefix);
    console.log(`S3: deleting ${keys.length} object(s) under ${prefix}`);
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await S3Service.deleteFile(key);
      deleted += 1;
    }
  }
  return { deleted };
}

async function reinitDatabase() {
  const db = require('../backend/database/db');
  const handle = db.initDatabase();
  if (withSeed) {
    const seed = require('../backend/database/seeds/demo_data');
    const stats = seed.seed(handle) || {};
    console.log('Database reinitialized with demo seed:', stats);
  } else {
    console.log('Database reinitialized (empty schema, no demo data)');
  }
  db.closeDatabase();
}

(async function main() {
  console.log('=== Clear all weighbridge data ===\n');

  console.log('1) Removing SQLite database…');
  try {
    removeDatabaseFiles();
  } catch (err) {
    console.error(
      'Could not remove database (is the app still running?):\n',
      err.message,
    );
    process.exit(1);
  }

  console.log('\n2) Clearing local folders…');
  for (const dir of WIPE_DIRS) {
    const n = emptyDirectory(dir);
    console.log(`  ${dir}/ — removed ${n} item(s)`);
  }

  if (purgeS3) {
    console.log('\n3) Clearing AWS S3 backup folders…');
    try {
      const { deleted } = await purgeS3Prefixes();
      console.log(`  S3 purge complete (${deleted} objects deleted)`);
    } catch (err) {
      console.error('S3 purge failed:', err.message);
      process.exit(1);
    }
  } else {
    console.log('\n3) S3: skipped (pass --s3 to delete cloud backups too)');
  }

  console.log('\n4) Recreating empty database…');
  try {
    await reinitDatabase();
  } catch (err) {
    console.error('Database init failed:', err.message);
    process.exit(1);
  }

  console.log('\nDone. Restart the app — Reports, images, and transactions will be empty.');
  if (!purgeS3) {
    console.log(
      'Note: Old files may still exist on S3. Run with --s3 to remove them, or they could re-sync as duplicates.',
    );
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
