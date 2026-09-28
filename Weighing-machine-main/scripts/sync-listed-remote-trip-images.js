'use strict';

/**
 * Backfill missing images for already-synced remote/local slips and regenerate PDFs.
 *
 * Run: npx electron scripts/sync-listed-remote-trip-images.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const DEFAULT_SLIP_NUMS = [
  2658, 2653, 2651, 2648, 2636, 2633, 2631, 2616, 2619, 2634, 2538, 2809, 2801,
  2800, 2789, 2788, 2760, 2757, 2755, 2754, 2732, 2751, 2671, 2743, 2742, 2723,
  2721, 2689, 2660,
];
const argSlips = process.argv.slice(2).filter((a) => /^\d+$|^WB\d+$/i.test(a));
const SLIP_NUMS = argSlips.length
  ? argSlips.map((a) => parseInt(String(a).replace(/^WB/i, ''), 10))
  : DEFAULT_SLIP_NUMS;
const SLIPS = SLIP_NUMS.map((n) => `WB${n}`);
const PHOTO_COLS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

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

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

function countFilled(row, cols = PHOTO_COLS) {
  if (!row) return 0;
  return cols.filter((c) => row[c] && String(row[c]).trim()).length;
}

async function upsertMirrorKeys(pg, siteIdAliases, slip, s3Keys) {
  const usable = {};
  for (const col of PHOTO_COLS) {
    if (s3Keys[col]) usable[col] = s3Keys[col];
  }
  if (!Object.keys(usable).length) return 0;
  let updated = 0;
  for (const siteId of siteIdAliases) {
    const existing = await pg.query(
      `SELECT local_id FROM transactions_mirror
       WHERE site_id = $1 AND slip_number = $2 LIMIT 1`,
      [siteId, slip],
    );
    if (!existing.rows.length) continue;
    const res = await pg.query(
      `UPDATE transactions_mirror SET
         arrival_photo_1 = COALESCE($3, arrival_photo_1),
         arrival_photo_2 = COALESCE($4, arrival_photo_2),
         arrival_photo_3 = COALESCE($5, arrival_photo_3),
         departure_photo_1 = COALESCE($6, departure_photo_1),
         departure_photo_2 = COALESCE($7, departure_photo_2),
         departure_photo_3 = COALESCE($8, departure_photo_3),
         updated_at = now()
       WHERE site_id = $1 AND slip_number = $2
       RETURNING slip_number`,
      [
        siteId,
        slip,
        usable.arrival_photo_1 || null,
        usable.arrival_photo_2 || null,
        usable.arrival_photo_3 || null,
        usable.departure_photo_1 || null,
        usable.departure_photo_2 || null,
        usable.departure_photo_3 || null,
      ],
    );
    if (res.rowCount) updated += 1;
  }
  return updated;
}

app.on('window-all-closed', () => {
  /* Keep the process alive while regenerating many PDFs. */
});

app.whenReady().then(async () => {
  try {
    const { initPackagedStorage } = require('../backend/utils/fileStorage');
    initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));

    const { initDatabase, closeDatabase, resolveDbPath } = require('../backend/database/db');
    const pg = require('../backend/database/pg');
    const TransactionService = require('../backend/services/TransactionService');
    const S3Service = require('../backend/services/S3Service');
    const { syncImportedTripPhotos } = require('../backend/services/RemoteTripSyncService');
    const { listTripCameraImages } = require('../backend/utils/tripPhotos');
    const { compressImageForPdfAsync } = require('../backend/utils/pdfImageCompress');
    const { siteIdAliases } = require('../backend/utils/siteId');
    const SettingsService = require('../backend/services/SettingsService');

    console.log('DB path:', resolveDbPath());
    initDatabase();

    if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
    if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');
    if (!S3Service.isConfigured()) throw new Error('S3 not configured');

    try {
      await pg.query(`
        DROP TRIGGER IF EXISTS trg_remote_trips_notify_photos ON remote_trips;
        CREATE TRIGGER trg_remote_trips_notify_photos
          AFTER UPDATE OF arrival_photo_1, arrival_photo_2, arrival_photo_3,
                          departure_photo_1, departure_photo_2, departure_photo_3
          ON remote_trips
          FOR EACH ROW
          EXECUTE PROCEDURE remote_trips_notify();
      `);
      console.log('RDS photo-update notify trigger ensured.');
    } catch (err) {
      console.warn('Could not create photo notify trigger:', err.message);
    }

    const remoteRes = await pg.query(
      `SELECT * FROM remote_trips WHERE slip_number = ANY($1::text[])`,
      [SLIPS],
    );
    const remoteBySlip = new Map();
    for (const row of remoteRes.rows) remoteBySlip.set(row.slip_number, row);

    const aliases = siteIdAliases(
      process.env.WEIGHBRIDGE_ID || SettingsService.get('WEIGHBRIDGE_ID') || 'WB-03',
    );
    const results = [];
    const remainingFirst = new Set([
      'WB2743',
      'WB2742',
      'WB2723',
      'WB2721',
      'WB2689',
      'WB2660',
    ]);
    const orderedSlips = [
      ...SLIPS.filter((slip) => remainingFirst.has(slip)),
      ...SLIPS.filter((slip) => !remainingFirst.has(slip)),
    ];

    for (const slip of orderedSlips) {
      const local = TransactionService.getBySlipNumber(slip);
      const remote = remoteBySlip.get(slip) || null;
      const row = {
        ...(remote || {}),
        slip_number: slip,
        truck_number: local?.truck_number || remote?.truck_number,
        timestamp_in: remote?.timestamp_in || local?.timestamp_in,
        timestamp_out: remote?.timestamp_out || local?.timestamp_out,
      };

      console.log(`\n=== ${slip} ===`);
      const beforeImages = local ? listTripCameraImages(local).length : 0;
      const existingPdf =
        local?.report_path &&
        fs.existsSync(local.report_path) &&
        fs.statSync(local.report_path).size > 1000;
      const needsRegen = remainingFirst.has(slip) || beforeImages === 0 || !existingPdf;
      let photoSync = { updated: false, regenerated: false, s3Keys: {}, s3KeysTried: [] };
      if (local) {
        try {
          console.log(
            `${slip}: downloading/attaching photos (already ${beforeImages} local, pdf=${!!existingPdf}, regen=${needsRegen})...`,
          );
          photoSync = await syncImportedTripPhotos(row, local, {
            forceRegen: needsRegen,
            regeneratePdf: needsRegen,
          });
          console.log(
            `${slip}: photoSync updated=${!!photoSync.updated} regen=${!!photoSync.regenerated}`,
          );
        } catch (err) {
          photoSync = { error: err.message, s3Keys: {}, s3KeysTried: [] };
          console.warn(`${slip}: photoSync error`, err.message);
        }
      }

      const latest = local ? TransactionService.getBySlipNumber(slip) : null;
      const images = latest ? listTripCameraImages(latest) : [];
      let renderable = 0;
      for (const img of images) {
        try {
          const compressed = await compressImageForPdfAsync(img.path, {
            maxWidth: 480,
            quality: 55,
            asJpeg: true,
          });
          if (compressed?.buffer?.length) renderable += 1;
        } catch (_e) {
          /* not renderable */
        }
      }

      const s3Keys = photoSync.s3Keys || {};
      if (!Object.keys(s3Keys).length) {
        for (const col of PHOTO_COLS) {
          const candidate = remote?.[col];
          if (candidate && (await S3Service.objectExists(candidate))) {
            s3Keys[col] = candidate;
          }
        }
      }
      for (const col of PHOTO_COLS) {
        if (s3Keys[col]) continue;
        const tried = (photoSync.s3KeysTried || []).find((key) => {
          const base = String(key).toLowerCase();
          if (col.startsWith('arrival')) return /arrival|[-_]ac\d/.test(base);
          return /departure|[-_]dc\d/.test(base);
        });
        if (tried && (await S3Service.objectExists(tried))) s3Keys[col] = tried;
      }

      const mirrorUpdated = latest
        ? await upsertMirrorKeys(pg, aliases, slip, s3Keys)
        : 0;

      let urlsOk = 0;
      let urlsTried = 0;
      for (const col of PHOTO_COLS) {
        const key = s3Keys[col];
        if (!key) continue;
        urlsTried += 1;
        if (await S3Service.objectExists(key)) urlsOk += 1;
      }

      const tripSynced = !!(latest && latest.ticket_status === 'CLOSED');
      const imagesFound = Math.max(
        countFilled(remote),
        photoSync.s3KeysTried?.length || 0,
        images.length,
      );
      const imagesSynced = images.length;
      const latestPdf =
        latest?.report_path &&
        fs.existsSync(latest.report_path) &&
        fs.statSync(latest.report_path).size > 1000;
      const visibleInReport =
        renderable > 0 && (!!photoSync.regenerated || !!latestPdf);
      const status =
        !tripSynced
          ? 'Trip missing'
          : visibleInReport
            ? 'Fixed'
            : imagesSynced > 0
              ? 'Images on disk, report regen failed'
              : imagesFound > 0
                ? 'Images found in storage, local attach failed'
                : 'No source images found';

      const line = {
        slip,
        tripSynced,
        remoteExists: !!remote,
        imagesFound,
        imagesSynced,
        renderable,
        visibleInReport,
        urlsOk,
        urlsTried,
        mirrorUpdated,
        beforeImages,
        status,
        error: photoSync.error || null,
      };
      results.push(line);
      console.log(
        `${slip}: synced=${tripSynced} found=${imagesFound} local=${imagesSynced} renderable=${renderable} report=${visibleInReport} urls=${urlsOk}/${urlsTried} ${status}`,
      );
    }

    console.log('\n=== VERIFICATION TABLE ===');
    console.log(
      'Slip/Trip No. | Trip Synced | Images Found | Images Synced | Images Visible in Report | Status',
    );
    for (const row of results) {
      console.log(
        `${row.slip} | ${row.tripSynced ? 'Yes' : 'No'} | ${row.imagesFound} | ${row.imagesSynced} | ${
          row.visibleInReport ? 'Yes' : 'No'
        } | ${row.status}`,
      );
    }

    const outFile = path.join(__dirname, 'listed-remote-trip-image-results.json');
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log('\nWrote', outFile);

    await pg.closePool();
    closeDatabase();
    app.exit(results.every((r) => r.visibleInReport) ? 0 : 1);
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err);
    app.exit(1);
  }
});
