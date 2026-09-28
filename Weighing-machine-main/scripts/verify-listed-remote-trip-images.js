'use strict';

/**
 * Read-only verification of listed remote trip images.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/verify-listed-remote-trip-images.js
 */
const path = require('path');
const fs = require('fs');

const SLIP_NUMS = [
  2658, 2653, 2651, 2648, 2636, 2633, 2631, 2616, 2619, 2634, 2538, 2809, 2801,
  2800, 2789, 2788, 2760, 2757, 2755, 2754, 2732, 2751, 2671, 2743, 2742, 2723,
  2721, 2689, 2660,
];
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

function countFilled(row, cols = PHOTO_COLS) {
  if (!row) return 0;
  return cols.filter((c) => row[c] && String(row[c]).trim()).length;
}

function headUrl(url) {
  return new Promise((resolve) => {
    if (!url) return resolve({ ok: false, status: 0 });
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.end();
  });
}

const appDataRoot = path.join(
  process.env.APPDATA || '',
  'weighbridge-app',
  'weighbridge-data',
);
loadEnvFile(path.join(__dirname, '..', '.env'));
loadEnvFile(path.join(appDataRoot, '.env'), true);
process.env.DB_PATH = path.join(appDataRoot, 'database', 'weighbridge.db');

async function main() {
  const { initPackagedStorage } = require('../backend/utils/fileStorage');
  initPackagedStorage(path.join(process.env.APPDATA || '', 'weighbridge-app'));
  const { initDatabase, closeDatabase } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const S3Service = require('../backend/services/S3Service');
  const { listTripCameraImages } = require('../backend/utils/tripPhotos');
  const { compressImageForPdfAsync } = require('../backend/utils/pdfImageCompress');
  const { siteIdAliases } = require('../backend/utils/siteId');
  const SettingsService = require('../backend/services/SettingsService');

  initDatabase();
  if (!pg.isConfigured() || !(await pg.ping())) throw new Error('Postgres unavailable');

  const aliases = siteIdAliases(
    process.env.WEIGHBRIDGE_ID || SettingsService.get('WEIGHBRIDGE_ID') || 'WB-03',
  );
  const remoteRes = await pg.query(
    `SELECT slip_number, synced_to_local, truck_number,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3, report_s3_key
     FROM remote_trips WHERE slip_number = ANY($1::text[])`,
    [SLIPS],
  );
  const mirrorRes = await pg.query(
    `SELECT site_id, slip_number,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3, report_s3_key
     FROM transactions_mirror WHERE slip_number = ANY($1::text[])`,
    [SLIPS],
  );
  const remoteBySlip = new Map(remoteRes.rows.map((r) => [r.slip_number, r]));
  const mirrorsBySlip = new Map();
  for (const row of mirrorRes.rows) {
    const list = mirrorsBySlip.get(row.slip_number) || [];
    list.push(row);
    mirrorsBySlip.set(row.slip_number, list);
  }

  const results = [];
  for (const slip of SLIPS) {
    const local = TransactionService.getBySlipNumber(slip);
    const remote = remoteBySlip.get(slip) || null;
    const mirrors = mirrorsBySlip.get(slip) || [];
    const images = local ? listTripCameraImages(local) : [];
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
        /* ignore */
      }
    }
    const pdfExists =
      !!(local?.report_path && fs.existsSync(local.report_path) && fs.statSync(local.report_path).size > 1000);

    const candidateKeys = [];
    const addKey = (value) => {
      const key = String(value || '').trim();
      if (key && !candidateKeys.includes(key) && !key.toLowerCase().endsWith('.pdf')) candidateKeys.push(key);
    };
    for (const col of PHOTO_COLS) {
      addKey(remote?.[col]);
      for (const m of mirrors) addKey(m[col]);
    }
    try {
      const listed = await S3Service.listKeys(`remote-trips/${slip}/`, 40);
      listed.filter((k) => /\.(jpe?g|png|webp|gif)$/i.test(k)).forEach(addKey);
    } catch (_e) {
      /* ignore */
    }
    for (const siteId of aliases) {
      try {
        const listed = await S3Service.listKeys(`sites/${siteId}/mirror/${slip}/`, 40);
        listed.filter((k) => /\.(jpe?g|png|webp|gif)$/i.test(k)).forEach(addKey);
      } catch (_e) {
        /* ignore */
      }
    }

    let urlsOk = 0;
    for (const key of candidateKeys) {
      if (await S3Service.objectExists(key)) urlsOk += 1;
    }

    const tripSynced = !!(local && local.ticket_status === 'CLOSED');
    const imagesFound = Math.max(countFilled(remote), candidateKeys.length, images.length);
    const imagesSynced = images.length;
    const visibleInReport = renderable > 0 && pdfExists;
    const status = !tripSynced
      ? 'Trip missing'
      : visibleInReport
        ? 'Fixed'
        : imagesSynced > 0
          ? 'Images on disk, report PDF missing'
          : imagesFound > 0
            ? 'Images in storage, not attached locally'
            : 'No source images found';

    const line = {
      slip,
      tripSynced,
      remoteExists: !!remote,
      remoteSynced: !!remote?.synced_to_local,
      imagesFound,
      imagesSynced,
      renderable,
      pdfExists,
      visibleInReport,
      urlsOk,
      urlCandidates: candidateKeys.length,
      mirrorPhotos: mirrors.map((m) => `${m.site_id}:${countFilled(m)}`),
      status,
    };
    results.push(line);
    console.log(
      `${slip} | ${tripSynced ? 'Yes' : 'No'} | ${imagesFound} | ${imagesSynced} | ${
        visibleInReport ? 'Yes' : 'No'
      } | ${status} | s3=${urlsOk}/${candidateKeys.length} pdf=${pdfExists} renderable=${renderable}`,
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
  console.log(
    'Fixed:',
    results.filter((r) => r.status === 'Fixed').length,
    '/',
    results.length,
  );

  await pg.closePool();
  closeDatabase();
  process.exit(results.every((r) => r.visibleInReport) ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
