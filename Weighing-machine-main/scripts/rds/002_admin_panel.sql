-- Weighbridge web admin panel — RDS PostgreSQL schema
-- Run once after 001_schema.sql

CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  last_seen_at  TIMESTAMPTZ,
  last_push_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sites (id, name)
VALUES ('WB-03', 'Bandhwari SLF Site')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions_mirror (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  local_id          TEXT NOT NULL,
  slip_number       TEXT NOT NULL,
  truck_number      TEXT NOT NULL,
  rfid_tag          TEXT,
  customer_name     TEXT,
  destination       TEXT,
  material          TEXT,
  operator_name     TEXT,
  transporter       TEXT,
  vehicle_type      TEXT,
  gross_weight      DOUBLE PRECISION,
  tare_weight       DOUBLE PRECISION,
  net_weight        DOUBLE PRECISION GENERATED ALWAYS AS (
    CASE
      WHEN gross_weight IS NOT NULL AND tare_weight IS NOT NULL
      THEN gross_weight - tare_weight
      ELSE NULL
    END
  ) STORED,
  timestamp_in      TIMESTAMPTZ,
  timestamp_out     TIMESTAMPTZ,
  ticket_status     TEXT NOT NULL DEFAULT 'CLOSED',
  sync_status       TEXT,
  mcg_status        TEXT,
  mcg_error         TEXT,
  arrival_photo_1   TEXT,
  arrival_photo_2   TEXT,
  arrival_photo_3   TEXT,
  departure_photo_1 TEXT,
  departure_photo_2 TEXT,
  departure_photo_3 TEXT,
  report_s3_key     TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_mirror_site_slip UNIQUE (site_id, slip_number),
  CONSTRAINT uq_mirror_site_local UNIQUE (site_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_mirror_site_updated ON transactions_mirror (site_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mirror_site_out ON transactions_mirror (site_id, timestamp_out DESC);

CREATE TABLE IF NOT EXISTS site_settings (
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (site_id, key)
);

CREATE OR REPLACE FUNCTION site_settings_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('site_settings_changed', NEW.site_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_site_settings_notify ON site_settings;
CREATE TRIGGER trg_site_settings_notify
  AFTER INSERT OR UPDATE ON site_settings
  FOR EACH ROW EXECUTE PROCEDURE site_settings_notify();

CREATE TABLE IF NOT EXISTS admin_commands (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_commands_pending
  ON admin_commands (site_id, created_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION admin_commands_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('new_admin_command', NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_commands_notify ON admin_commands;
CREATE TRIGGER trg_admin_commands_notify
  AFTER INSERT ON admin_commands
  FOR EACH ROW EXECUTE PROCEDURE admin_commands_notify();

CREATE TABLE IF NOT EXISTS site_settings_sync (
  site_id           TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  last_pulled_at    TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01'::timestamptz
);

INSERT INTO site_settings_sync (site_id) SELECT id FROM sites ON CONFLICT DO NOTHING;
