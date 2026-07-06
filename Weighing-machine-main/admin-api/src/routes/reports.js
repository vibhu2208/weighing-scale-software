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
} = require('../services/reportQuery');
const { createCommand } = require('../services/commandService');
const { presignGet, isConfigured } = require('../services/s3Presign');

const router = express.Router();
router.use(authMiddleware);

async function attachMediaUrls(row) {
  if (!row || !isConfigured()) return row;
  const out = { ...row };
  const photoFields = [
    'arrival_photo_1',
    'arrival_photo_2',
    'arrival_photo_3',
    'departure_photo_1',
    'departure_photo_2',
    'departure_photo_3',
  ];
  for (const field of photoFields) {
    if (out[field]) {
      try {
        out[`${field}_url`] = await presignGet(out[field]);
      } catch {
        out[`${field}_url`] = null;
      }
    }
  }
  if (out.report_s3_key) {
    try {
      out.report_url = await presignGet(out.report_s3_key);
    } catch {
      out.report_url = null;
    }
  }
  return out;
}

router.get('/', async (req, res) => {
  try {
    const siteId = getSiteId();
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
      `SELECT * FROM transactions_mirror ${where} ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
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
      `SELECT * FROM transactions_mirror ${where} ORDER BY ${REPORT_DATE_SQL} DESC LIMIT 5000`,
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
    const siteId = getSiteId();
    const slip = String(req.params.slip || '').trim();
    const result = await query(
      'SELECT * FROM transactions_mirror WHERE site_id = $1 AND slip_number = $2 LIMIT 1',
      [siteId, slip],
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

router.post('/:slip/edit', async (req, res) => {
  try {
    const slip = String(req.params.slip || '').trim();
    const body = req.body || {};
    const cmd = await createCommand({
      type: 'edit_report',
      payload: {
        slipNumber: slip,
        gross_weight: body.gross_weight,
        tare_weight: body.tare_weight,
        timestamp_in: body.timestamp_in,
        timestamp_out: body.timestamp_out,
        material: body.material,
        customer_name: body.customer_name,
        destination: body.destination,
        operator_name: body.operator_name,
        photoS3Keys: body.photoS3Keys || [],
      },
      createdBy: req.user?.email,
    });
    return res.json({ ok: true, command: cmd });
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
