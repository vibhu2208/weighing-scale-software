'use strict';

const { query } = require('../db');

/**
 * Apply Phase 3 performance schema (indexes + PDF fingerprint columns).
 * Idempotent. Trigram extension may fail on locked-down roles — other steps still run.
 */
async function ensurePerfSchema() {
  try {
    await query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (err) {
    console.warn('[perfSchema] pg_trgm unavailable:', err.message);
  }

  await query(`
    ALTER TABLE transactions_mirror
      ADD COLUMN IF NOT EXISTS report_date TIMESTAMPTZ
      GENERATED ALWAYS AS (
        CASE
          WHEN ticket_status = 'CLOSED' THEN COALESCE(timestamp_out, updated_at)
          ELSE timestamp_in
        END
      ) STORED
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_mirror_site_report_date
      ON transactions_mirror (site_id, report_date DESC NULLS LAST)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_mirror_site_truck_upper
      ON transactions_mirror (site_id, (UPPER(truck_number)))
  `);

  try {
    await query(`
      CREATE INDEX IF NOT EXISTS idx_mirror_slip_trgm
        ON transactions_mirror USING gin (slip_number gin_trgm_ops)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_mirror_truck_trgm
        ON transactions_mirror USING gin ((UPPER(truck_number)) gin_trgm_ops)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_mirror_material_trgm
        ON transactions_mirror USING gin ((UPPER(COALESCE(material, ''))) gin_trgm_ops)
    `);
  } catch (err) {
    console.warn('[perfSchema] trigram indexes skipped:', err.message);
  }

  await query(`
    ALTER TABLE transactions_mirror
      ADD COLUMN IF NOT EXISTS report_content_fp TEXT
  `);
  await query(`
    ALTER TABLE remote_trips
      ADD COLUMN IF NOT EXISTS report_content_fp TEXT
  `);
  await query(`
    ALTER TABLE remote_trips
      ADD COLUMN IF NOT EXISTS report_gross_content_fp TEXT
  `);
  await query(`
    ALTER TABLE remote_trips
      ADD COLUMN IF NOT EXISTS report_gross_s3_key TEXT
  `);

  return { ok: true };
}

module.exports = { ensurePerfSchema };
