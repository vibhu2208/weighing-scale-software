-- Phase 3: faster Reports search/filter on transactions_mirror.
-- Safe to re-run (IF NOT EXISTS). Requires rights to CREATE EXTENSION (pg_trgm).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Materialized report listing date (same CASE used by admin reportQuery).
ALTER TABLE transactions_mirror
  ADD COLUMN IF NOT EXISTS report_date TIMESTAMPTZ
  GENERATED ALWAYS AS (
    CASE
      WHEN ticket_status = 'CLOSED' THEN COALESCE(timestamp_out, updated_at)
      ELSE timestamp_in
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_mirror_site_report_date
  ON transactions_mirror (site_id, report_date DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_mirror_site_truck_upper
  ON transactions_mirror (site_id, (UPPER(truck_number)));

CREATE INDEX IF NOT EXISTS idx_mirror_slip_trgm
  ON transactions_mirror USING gin (slip_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_mirror_truck_trgm
  ON transactions_mirror USING gin ((UPPER(truck_number)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_mirror_material_trgm
  ON transactions_mirror USING gin ((UPPER(COALESCE(material, ''))) gin_trgm_ops);

-- Content fingerprints so PDF cache invalidates when trip/photos change.
ALTER TABLE transactions_mirror
  ADD COLUMN IF NOT EXISTS report_content_fp TEXT;

ALTER TABLE remote_trips
  ADD COLUMN IF NOT EXISTS report_content_fp TEXT;

ALTER TABLE remote_trips
  ADD COLUMN IF NOT EXISTS report_gross_content_fp TEXT;

ALTER TABLE remote_trips
  ADD COLUMN IF NOT EXISTS report_gross_s3_key TEXT;
