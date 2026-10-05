'use strict';

/**
 * Download/apply pending edit_report images for specific slips.
 * Run: npx electron scripts/apply-edit-report-images-slips.js
 *
 * TARGET_SLIPS=WB4375,WB4372,... (optional; defaults to the six requested)
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

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

const TARGET_DEFAULT = ['WB4375', 'WB4372', 'WB4377', 'WB4477', 'WB4473', 'WB4472'];
const SKIP_NO_S3 = new Set(['WB4534']);

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);

// Force required settings for this PC.
process.env.AWS_REGION = 'eu-north-1';
process.env.AWS_S3_BUCKET = 'k1-k2';
process.env.WEIGHBRIDGE_ID = 'WB-03';
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

const targetSlips = new Set(
  String(process.env.TARGET_SLIPS || TARGET_DEFAULT.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const { initPackagedStorage, PATHS } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

    const { initDatabase, closeDatabase, getDb } = require('../backend/database/db');
    const pg = require('../backend/database/pg');
    const TransactionService = require('../backend/services/TransactionService');
    const AdminReportService = require('../backend/services/AdminReportService');
    const SettingsService = require('../backend/services/SettingsService');
    const S3Service = require('../backend/services/S3Service');
    const { siteIdAliases } = require('../backend/utils/siteId');

    initDatabase();

    // Persist correct settings into SQLite so Settings UI / S3Service stay aligned.
    SettingsService.set('WEIGHBRIDGE_ID', 'WB-03');
    SettingsService.set('AWS_REGION', 'eu-north-1');
    SettingsService.set('AWS_S3_BUCKET', 'k1-k2');
    if (process.env.AWS_ACCESS_KEY_ID) {
      SettingsService.set('AWS_ACCESS_KEY_ID', process.env.AWS_ACCESS_KEY_ID);
    }
    if (process.env.AWS_SECRET_ACCESS_KEY) {
      SettingsService.set('AWS_SECRET_ACCESS_KEY', process.env.AWS_SECRET_ACCESS_KEY);
    }
    S3Service.resetClient();

    console.log('Config:', {
      region: SettingsService.get('AWS_REGION'),
      bucket: SettingsService.get('AWS_S3_BUCKET'),
      weighbridgeId: SettingsService.get('WEIGHBRIDGE_ID'),
      s3Configured: S3Service.isConfigured(),
      imagesRoot: PATHS.IMAGES,
      dbPath: process.env.DB_PATH,
    });

    if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
    if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');
    if (!S3Service.isConfigured()) throw new Error('S3 not configured');

    const siteId = 'WB-03';
    const aliases = siteIdAliases(siteId);
    console.log('Site aliases:', aliases.join(', '));
    console.log('Target slips:', [...targetSlips].join(', '));

    const pending = await pg.query(
      `SELECT id, site_id, type, payload, status, created_at
       FROM admin_commands
       WHERE site_id = ANY($1::text[])
         AND type = 'edit_report'
         AND status = 'pending'
       ORDER BY created_at ASC`,
      [aliases],
    );
    console.log(`Pending edit_report commands: ${pending.rows.length}`);

    const results = [];
    const applied = [];

    for (const row of pending.rows) {
      const payload =
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
      const slip = String(payload.slipNumber || payload.slip_number || '')
        .trim()
        .toUpperCase();
      const photos = Array.isArray(payload.photoS3Keys) ? payload.photoS3Keys : [];
      if (!targetSlips.has(slip)) {
        console.log(`Skip (not target): ${slip || row.id}`);
        continue;
      }
      if (SKIP_NO_S3.has(slip) || photos.length === 0) {
        console.log(`Skip (no S3 images): ${slip} photos=${photos.length}`);
        results.push({ slip, photos: photos.length, status: 'skipped_no_s3' });
        continue;
      }

      console.log(`\n=== ${slip} photos=${photos.length} ===`);
      for (const p of photos) {
        console.log(`  key=${p.key || p.s3Key} pass=${p.pass} slot=${p.slot}`);
      }

      try {
        await AdminReportService.applyRemoteUpdate(payload);
        await pg.query(
          `UPDATE admin_commands
           SET status = 'applied', error = NULL, applied_at = now()
           WHERE id = $1`,
          [row.id],
        );
        console.log(`Applied ${slip}`);
        results.push({ slip, photos: photos.length, status: 'applied' });
        applied.push({ slip, photoS3Keys: photos });
      } catch (err) {
        await pg.query(
          `UPDATE admin_commands SET status = 'failed', error = $2 WHERE id = $1`,
          [row.id, err.message],
        );
        console.error(`FAILED ${slip}: ${err.message}`);
        results.push({
          slip,
          photos: photos.length,
          status: 'failed',
          error: err.message,
        });
      }
    }

    // Also recover images for target slips if commands already applied but files missing:
    // list S3 mirror keys and download into local camera paths if txn exists.
    const missingAfterApply = [];
    for (const slip of targetSlips) {
      const txn = TransactionService.getBySlipNumber(slip);
      if (!txn) {
        console.warn(`No local ticket for ${slip}`);
        missingAfterApply.push({ slip, reason: 'no_local_ticket' });
        continue;
      }
      const paths = [
        txn.arrival_photo_1,
        txn.arrival_photo_2,
        txn.arrival_photo_3,
        txn.departure_photo_1,
        txn.departure_photo_2,
        txn.departure_photo_3,
        txn.image_path,
        txn.tare_image_path,
      ].filter(Boolean);

      const existing = paths.filter((p) => fs.existsSync(p));
      console.log(
        `${slip}: local photo path refs=${paths.length}, existing files=${existing.length}`,
      );
      for (const p of existing) console.log(`  OK ${p}`);
      for (const p of paths.filter((x) => !fs.existsSync(x))) {
        console.log(`  MISSING ${p}`);
      }

      // If no local files, try downloading all mirror objects from S3.
      if (existing.length === 0) {
        const prefix = `sites/${siteId}/mirror/${slip}/`;
        const keys = await S3Service.listAllKeys(prefix);
        const jpgKeys = keys.filter((k) => /_(cam|arrival|departure)/i.test(k) || k.endsWith('.jpg'));
        console.log(`${slip}: S3 keys under ${prefix}: ${jpgKeys.length}`);
        if (!jpgKeys.length) {
          missingAfterApply.push({ slip, reason: 'no_s3_keys' });
          continue;
        }
        const photoS3Keys = [];
        for (const key of jpgKeys) {
          const m = key.match(/\/(arrival|departure)_cam-(\d)\.jpg$/i);
          if (!m) continue;
          photoS3Keys.push({
            key,
            pass: m[1].toLowerCase(),
            slot: Number(m[2]),
          });
        }
        if (photoS3Keys.length) {
          console.log(`${slip}: downloading ${photoS3Keys.length} S3 keys via applyRemoteUpdate`);
          try {
            await AdminReportService.applyRemoteUpdate({
              slipNumber: slip,
              photoS3Keys,
            });
            results.push({
              slip,
              photos: photoS3Keys.length,
              status: 'downloaded_from_s3_mirror',
            });
          } catch (err) {
            console.error(`${slip}: mirror download failed: ${err.message}`);
            missingAfterApply.push({ slip, reason: err.message });
          }
        }
      }

      const txn2 = TransactionService.getBySlipNumber(slip);
      const checkPaths = [
        txn2?.arrival_photo_1,
        txn2?.arrival_photo_2,
        txn2?.arrival_photo_3,
        txn2?.departure_photo_1,
        txn2?.departure_photo_2,
        txn2?.departure_photo_3,
        txn2?.image_path,
        txn2?.tare_image_path,
      ].filter(Boolean);
      const ok = checkPaths.filter((p) => fs.existsSync(p));
      console.log(`${slip} FINAL: ${ok.length}/${checkPaths.length} files on disk`);
      for (const p of ok) {
        const st = fs.statSync(p);
        console.log(`  ${st.size} bytes  ${p}`);
      }
      if (!ok.length) missingAfterApply.push({ slip, reason: 'still_no_local_files' });
    }

    console.log('\n=== RESULTS ===');
    console.log(JSON.stringify(results, null, 2));
    console.log('Missing:', JSON.stringify(missingAfterApply, null, 2));

    await pg.closePool();
    closeDatabase();
    app.exit(missingAfterApply.length ? 2 : 0);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
