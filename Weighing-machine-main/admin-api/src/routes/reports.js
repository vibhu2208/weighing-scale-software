'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const { query, getSiteId } = require('../db');
const { authMiddleware } = require('../auth');
const {
  queryPaginated,
  summarise,
  getFilterOptions,
  buildWhere,
  formatExportRow,
  EXPORT_HEADERS,
  REPORT_DATE_SQL,
  PHOTO_SCORE_SQL,
} = require('../services/reportQuery');
const { createCommand } = require('../services/commandService');
const {
  presignGet,
  isConfigured,
  objectExists,
  listKeys,
  inferPhotoFieldFromKey,
} = require('../services/s3Presign');
const { siteIdAliases } = require('../siteId');
const { generateTripPdf } = require('../services/reportPdfService');

const router = express.Router();
router.use(authMiddleware);

const PHOTO_FIELDS = [
  'arrival_photo_1',
  'arrival_photo_2',
  'arrival_photo_3',
  'departure_photo_1',
  'departure_photo_2',
  'departure_photo_3',
];

async function hydratePhotoKeys(row) {
  if (!row) return row;
  const out = { ...row };

  try {
    const remote = await query(
      `SELECT arrival_photo_1, arrival_photo_2, arrival_photo_3,
              departure_photo_1, departure_photo_2, departure_photo_3,
              report_s3_key
       FROM remote_trips WHERE slip_number = $1 LIMIT 1`,
      [row.slip_number],
    );
    const remoteRow = remote.rows[0];
    if (remoteRow) {
      for (const field of PHOTO_FIELDS) {
        if (!out[field] && remoteRow[field]) out[field] = remoteRow[field];
      }
      if (!out.report_s3_key && remoteRow.report_s3_key) {
        out.report_s3_key = remoteRow.report_s3_key;
      }
    }
  } catch (_e) {
    /* remote_trips fallback is best-effort */
  }

  const stillMissing = PHOTO_FIELDS.filter((field) => !out[field]);
  if (stillMissing.length && isConfigured() && out.slip_number) {
    const prefixes = [`remote-trips/${out.slip_number}/`];
    for (const siteId of siteIdAliases(getSiteId())) {
      prefixes.push(`sites/${siteId}/mirror/${out.slip_number}/`);
    }
    for (const prefix of prefixes) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await listKeys(prefix, 40);
      for (const key of listed) {
        if (!/\.(jpe?g|png|webp|gif)$/i.test(key)) continue;
        const field = inferPhotoFieldFromKey(key);
        if (field && !out[field]) out[field] = key;
      }
    }
  }

  return out;
}

async function attachMediaUrls(row) {
  const hydrated = await hydratePhotoKeys(row);
  if (!hydrated || !isConfigured()) return hydrated;
  const out = { ...hydrated };
  for (const field of PHOTO_FIELDS) {
    const key = out[field];
    if (!key) continue;
    try {
      if (!(await objectExists(key))) {
        out[field] = null;
        out[`${field}_url`] = null;
        continue;
      }
      out[`${field}_url`] = await presignGet(key);
    } catch {
      out[`${field}_url`] = null;
    }
  }
  if (out.report_s3_key) {
    try {
      if (await objectExists(out.report_s3_key)) {
        out.report_url = await presignGet(out.report_s3_key);
      } else {
        out.report_url = null;
      }
    } catch {
      out.report_url = null;
    }
  }
  return out;
}

router.get('/', async (req, res) => {
  try {
    const siteId = getSiteId();
    try {
      const { reassertVehicleFromAppliedEdits } = require('../services/commandService');
      await reassertVehicleFromAppliedEdits({ hours: 72, limit: 80 });
    } catch (_e) {
      /* optional */
    }
    const filters = req.query || {};
    const result = await queryPaginated(query, siteId, filters);
    const summary = await summarise(query, siteId, filters);
    const rows = await Promise.all(result.rows.map(attachMediaUrls));
    return res.json({ ok: true, rows, pagination: result.pagination, summary });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/filters', async (_req, res) => {
  try {
    const options = await getFilterOptions(query, getSiteId());
    return res.json({ ok: true, ...options });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/export/csv', async (req, res) => {
  try {
    const siteId = getSiteId();
    const { where, params } = buildWhere(siteId, req.query || {});
    const result = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (slip_number) *
         FROM transactions_mirror ${where}
         ORDER BY slip_number, ${PHOTO_SCORE_SQL} DESC, ${REPORT_DATE_SQL} DESC
       ) d
       ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
      params,
    );
    const lines = [EXPORT_HEADERS.map((h) => `"${h}"`).join(',')];
    for (const row of result.rows) {
      lines.push(formatExportRow(row).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="weighbridge-report.csv"');
    return res.send(lines.join('\n'));
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/export/excel', async (req, res) => {
  try {
    const siteId = getSiteId();
    const { where, params } = buildWhere(siteId, req.query || {});
    const result = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (slip_number) *
         FROM transactions_mirror ${where}
         ORDER BY slip_number, ${PHOTO_SCORE_SQL} DESC, ${REPORT_DATE_SQL} DESC
       ) d
       ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
      params,
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reports');
    ws.addRow(EXPORT_HEADERS);
    for (const row of result.rows) {
      ws.addRow(formatExportRow(row));
    }
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="weighbridge-report.xlsx"');
    await wb.xlsx.write(res);
    return res.end();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:slip', async (req, res) => {
  try {
    const aliases = siteIdAliases(getSiteId());
    const slip = String(req.params.slip || '').trim();
    const result = await query(
      `SELECT * FROM transactions_mirror
       WHERE site_id = ANY($1::text[]) AND slip_number = $2
       ORDER BY ${PHOTO_SCORE_SQL} DESC
       LIMIT 1`,
      [aliases, slip],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }
    const row = await attachMediaUrls(result.rows[0]);
    return res.json({ ok: true, report: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Build (or rebuild) the trip PDF from current mirror photo S3 keys so admin
 * downloads always include images — even when the PC uploaded an empty PDF.
 */
router.get('/:slip/pdf', async (req, res) => {
  try {
    const siteId = getSiteId();
    const slip = String(req.params.slip || '').trim();
    const result = await query(
      'SELECT * FROM transactions_mirror WHERE site_id = $1 AND slip_number = $2 LIMIT 1',
      [siteId, slip],
    );
    let row = result.rows[0] || null;
    const rt = await query(
      `SELECT * FROM remote_trips WHERE UPPER(slip_number) = UPPER($1) LIMIT 1`,
      [slip],
    );
    const remote = rt.rows[0] || null;
    if (!row && !remote) {
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }

    // Prefer mirror fields, but fill missing photo keys from remote_trips
    // (admin may have uploaded photos before the PC re-pushed the mirror).
    row = { ...(remote || {}), ...(row || {}) };
    const photoCols = [
      'arrival_photo_1',
      'arrival_photo_2',
      'arrival_photo_3',
      'departure_photo_1',
      'departure_photo_2',
      'departure_photo_3',
    ];
    for (const col of photoCols) {
      if (!row[col] && remote?.[col]) row[col] = remote[col];
    }

    const built = await generateTripPdf(row, { siteId, upload: true });

    if (built.report_s3_key) {
      await query(
        `UPDATE transactions_mirror
         SET report_s3_key = $3, updated_at = now()
         WHERE site_id = $1 AND slip_number = $2`,
        [siteId, row.slip_number, built.report_s3_key],
      );
      await query(
        `UPDATE remote_trips SET report_s3_key = $2 WHERE UPPER(slip_number) = UPPER($1)`,
        [row.slip_number, built.report_s3_key],
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${built.filename}"`,
    );
    return res.send(built.pdf);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

function normalizeAdminSlipNumber(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return '';
  const match = raw.match(/^([A-Z]+)?(\d+)$/);
  if (!match) return raw;
  const prefix = match[1] || 'WB';
  const num = parseInt(match[2], 10);
  if (!Number.isFinite(num) || num <= 0) return raw;
  return `${prefix}${String(num).padStart(4, '0')}`;
}

router.post('/:slip/edit', async (req, res) => {
  try {
    const siteId = getSiteId();
    const slip = String(req.params.slip || '').trim();
    const body = req.body || {};
    const newSlipNumber = normalizeAdminSlipNumber(body.newSlipNumber || body.slip_number);
    const truckNumber = String(body.truck_number || body.truckNumber || '')
      .trim()
      .toUpperCase();
    const payload = {
      slipNumber: slip,
      newSlipNumber: newSlipNumber || undefined,
      slip_number: newSlipNumber || undefined,
      truck_number: truckNumber || undefined,
      truckNumber: truckNumber || undefined,
      gross_weight: body.gross_weight,
      tare_weight: body.tare_weight,
      timestamp_in: body.timestamp_in,
      timestamp_out: body.timestamp_out,
      material: body.material,
      customer_name: body.customer_name,
      destination: body.destination,
      operator_name: body.operator_name,
      photoS3Keys: body.photoS3Keys || [],
    };

    // Optimistic mirror update so admin Reports show the new tare/gross immediately.
    // The weighbridge PC still applies the command to local SQLite + regenerates PDF.
    const sets = [];
    const params = [];
    let idx = 1;
    const fields = [
      ['truck_number', truckNumber || undefined],
      ['gross_weight', body.gross_weight],
      ['tare_weight', body.tare_weight],
      ['timestamp_in', body.timestamp_in],
      ['timestamp_out', body.timestamp_out],
      ['material', body.material],
      ['customer_name', body.customer_name],
      ['destination', body.destination],
      ['operator_name', body.operator_name],
    ];
    for (const [col, value] of fields) {
      if (value === undefined || value === null || value === '') continue;
      sets.push(`${col} = $${idx++}`);
      params.push(col.includes('weight') ? Number(value) : value);
    }
    if (newSlipNumber && newSlipNumber !== slip) {
      const taken = await query(
        'SELECT slip_number FROM transactions_mirror WHERE site_id = $1 AND slip_number = $2 LIMIT 1',
        [siteId, newSlipNumber],
      );
      if (taken.rows[0]) {
        return res.status(409).json({
          ok: false,
          error: `Slip number ${newSlipNumber} is already used by another report`,
        });
      }
      sets.push(`slip_number = $${idx++}`);
      params.push(newSlipNumber);
    }
    // Optimistic photo keys so Admin Reports show images before the PC applies the command.
    const photoS3Keys = Array.isArray(body.photoS3Keys) ? body.photoS3Keys : [];
    for (const item of photoS3Keys) {
      const slot = Number(item.slot);
      const key = item.key || item.s3Key;
      const pass = item.pass === 'arrival' ? 'arrival' : 'departure';
      if (!key || !Number.isFinite(slot) || slot < 1 || slot > 3) continue;
      sets.push(`${pass}_photo_${slot} = $${idx++}`);
      params.push(key);
    }
    if (sets.length) {
      sets.push('updated_at = now()');
      params.push(siteId, slip);
      await query(
        `UPDATE transactions_mirror SET ${sets.join(', ')}
         WHERE site_id = $${idx++} AND slip_number = $${idx}`,
        params,
      );
    }

    // Keep remote_trips in sync when photos / vehicle are updated via Report Edit.
    const targetSlip = newSlipNumber || slip;
    try {
      const rt = await query(
        `SELECT id FROM remote_trips
         WHERE UPPER(slip_number) = UPPER($1) OR UPPER(slip_number) = UPPER($2)
         LIMIT 1`,
        [targetSlip, slip],
      );
      if (rt.rows[0]) {
        if (photoS3Keys.length) {
          const { attachPhotos } = require('../services/remoteTripService');
          await attachPhotos(query, rt.rows[0].id, photoS3Keys);
        }
        if (truckNumber) {
          await query(
            `UPDATE remote_trips
             SET truck_number = $2, updated_at = now()
             WHERE id = $1`,
            [rt.rows[0].id, truckNumber],
          );
        }
      }
    } catch (err) {
      console.warn('[reports] remote trip sync failed', err.message);
    }

    const cmd = await createCommand({
      type: 'edit_report',
      payload,
      createdBy: req.user?.email,
    });
    return res.json({
      ok: true,
      command: cmd,
      slip_number: newSlipNumber || slip,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:slip/delete', async (req, res) => {
  try {
    const slip = String(req.params.slip || '').trim();
    const cmd = await createCommand({
      type: 'delete_report',
      payload: { slipNumber: slip },
      createdBy: req.user?.email,
    });
    return res.json({ ok: true, command: cmd });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
