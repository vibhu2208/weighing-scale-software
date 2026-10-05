'use strict';

/**
 * Inspect remote trip vs local vs mirror photo state for given slips.
 * Run: npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/inspect-remote-trip-images.js
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

function localFilesExist(row) {
  if (!row) return { expected: 0, onDisk: 0, missing: [] };
  const missing = [];
  let expected = 0;
  let onDisk = 0;
  for (const col of PHOTO_COLS) {
    const p = row[col];
    if (!p) continue;
    expected += 1;
    if (fs.existsSync(p)) onDisk += 1;
    else missing.push(`${col}:${p}`);
  }
  return { expected, onDisk, missing };
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

  const { initDatabase, closeDatabase, resolveDbPath } = require('../backend/database/db');
  const pg = require('../backend/database/pg');
  const TransactionService = require('../backend/services/TransactionService');
  const S3Service = require('../backend/services/S3Service');
  const { listTripCameraImages } = require('../backend/utils/tripPhotos');

  console.log('DB path:', resolveDbPath());
  console.log('S3 configured:', S3Service.isConfigured());
  initDatabase();

  if (!pg.isConfigured()) throw new Error('PG_SYNC_URL not configured');
  if (!(await pg.ping())) throw new Error('Cannot reach PostgreSQL');

  const remoteRes = await pg.query(
    `SELECT id, slip_number, truck_number, synced_to_local, synced_at, local_id,
            mcg_status, created_at,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3,
            report_s3_key
     FROM remote_trips
     WHERE slip_number = ANY($1::text[])
     ORDER BY slip_number`,
    [SLIPS],
  );

  const mirrorRes = await pg.query(
    `SELECT site_id, slip_number, truck_number, local_id,
            arrival_photo_1, arrival_photo_2, arrival_photo_3,
            departure_photo_1, departure_photo_2, departure_photo_3,
            report_s3_key
     FROM transactions_mirror
     WHERE slip_number = ANY($1::text[])
     ORDER BY slip_number, site_id`,
    [SLIPS],
  );

  const remoteBySlip = new Map();
  for (const row of remoteRes.rows) remoteBySlip.set(row.slip_number, row);
  const mirrorBySlip = new Map();
  for (const row of mirrorRes.rows) {
    const list = mirrorBySlip.get(row.slip_number) || [];
    list.push(row);
    mirrorBySlip.set(row.slip_number, list);
  }

  console.log('\n=== PER-SLIP INSPECTION ===\n');
  const summary = [];

  for (const slip of SLIPS) {
    const remote = remoteBySlip.get(slip);
    const local = TransactionService.getBySlipNumber(slip);
    const mirrors = mirrorBySlip.get(slip) || [];
    const localPhotoCols = countFilled(local);
    const remotePhotoCols = countFilled(remote);
    const disk = localFilesExist(local);
    const reportImages = local ? listTripCameraImages(local).length : 0;
    const localFilesOk = disk.expected > 0 && disk.onDisk === disk.expected;

    let s3RemoteKeys = [];
    let s3MirrorKeys = [];
    if (S3Service.isConfigured()) {
      try {
        s3RemoteKeys = await S3Service.listKeys(`remote-trips/${slip}/`, 50);
      } catch (err) {
        s3RemoteKeys = [`ERROR:${err.message}`];
      }
      for (const m of mirrors) {
        try {
          const keys = await S3Service.listKeys(`sites/${m.site_id}/mirror/${slip}/`, 50);
          s3MirrorKeys.push(`${m.site_id}:${keys.length}:${keys.join('|')}`);
        } catch (err) {
          s3MirrorKeys.push(`${m.site_id}:ERROR:${err.message}`);
        }
      }
    }

    const line = {
      slip,
      remoteExists: !!remote,
      remoteSynced: remote ? !!remote.synced_to_local : false,
      remoteId: remote?.id || null,
      truckRemote: remote?.truck_number || null,
      truckLocal: local?.truck_number || null,
      localExists: !!local,
      localRemotePgId: local?.remote_pg_id || null,
      remotePhotos: remotePhotoCols,
      remoteKeys: remote
        ? PHOTO_COLS.map((c) => (remote[c] ? `${c}=${remote[c]}` : null)).filter(Boolean)
        : [],
      localPhotos: localPhotoCols,
      localOnDisk: disk.onDisk,
      localMissing: disk.missing,
      reportVisibleCount: reportImages,
      mirrorCount: mirrors.length,
      mirrorPhotos: mirrors.map((m) => `${m.site_id}:${countFilled(m)}`),
      mirrorKeys: mirrors.flatMap((m) =>
        PHOTO_COLS.map((c) => (m[c] ? `${m.site_id}:${c}=${m[c]}` : null)).filter(Boolean),
      ),
      s3RemoteKeys,
      s3MirrorKeys,
      reportPath: local?.report_path || null,
      reportExists: local?.report_path ? fs.existsSync(local.report_path) : false,
    };
    summary.push(line);

    console.log(`--- ${slip} ---`);
    console.log(
      JSON.stringify(
        {
          trip: {
            remote: line.remoteExists,
            synced: line.remoteSynced,
            local: line.localExists,
            truckR: line.truckRemote,
            truckL: line.truckLocal,
            remotePgMatch: line.localRemotePgId && line.remoteId && String(line.localRemotePgId) === String(line.remoteId),
          },
          photos: {
            remoteCols: line.remotePhotos,
            localCols: line.localPhotos,
            onDisk: line.localOnDisk,
            reportSlots: line.reportVisibleCount,
            mirror: line.mirrorPhotos,
          },
          remoteKeys: line.remoteKeys,
          localMissing: line.localMissing,
          mirrorKeys: line.mirrorKeys,
          s3Remote: line.s3RemoteKeys,
          s3Mirror: line.s3MirrorKeys,
          report: { path: line.reportPath, exists: line.reportExists },
        },
        null,
        2,
      ),
    );
  }

  const missingRemote = SLIPS.filter((s) => !remoteBySlip.has(s));
  console.log('\n=== SUMMARY COUNTS ===');
  console.log('Requested:', SLIPS.length);
  console.log('Found in remote_trips:', remoteRes.rows.length);
  console.log('Missing from remote_trips:', missingRemote);
  console.log('Found in transactions_mirror:', mirrorRes.rows.length);
  console.log(
    'Local with 0 photo cols:',
    summary.filter((s) => s.localExists && s.localPhotos === 0).map((s) => s.slip),
  );
  console.log(
    'Remote with photo cols:',
    summary.filter((s) => s.remotePhotos > 0).map((s) => `${s.slip}:${s.remotePhotos}`),
  );
  console.log(
    'S3 remote-trips objects present:',
    summary.filter((s) => (s.s3RemoteKeys || []).length && !String(s.s3RemoteKeys[0] || '').startsWith('ERROR')).map(
      (s) => `${s.slip}:${s.s3RemoteKeys.length}`,
    ),
  );

  await pg.closePool();
  closeDatabase();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
