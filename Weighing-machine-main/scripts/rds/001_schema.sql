-- Weighbridge remote trips — RDS PostgreSQL schema
-- Run once on RDS as user `weighbridge` (or master) via pgAdmin/DBeaver.
-- Database: postgres
-- Host: database-1.cd66cqyiuaay.ap-south-1.rds.amazonaws.com

-- ============================================================
-- 1. Slip counter (single WB series)
-- ============================================================
CREATE TABLE IF NOT EXISTS slip_counter (
  id            INT PRIMARY KEY DEFAULT 1,
  prefix        TEXT NOT NULL DEFAULT 'WB',
  current_value BIGINT NOT NULL DEFAULT 1000,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slip_counter_singleton CHECK (id = 1)
);

INSERT INTO slip_counter (id, prefix, current_value)
VALUES (1, 'WB', 1000)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION next_slip_number()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v BIGINT;
  p TEXT;
BEGIN
  UPDATE slip_counter
  SET current_value = current_value + 1,
      updated_at = now()
  WHERE id = 1
  RETURNING current_value, prefix INTO v, p;

  IF NOT FOUND THEN
    INSERT INTO slip_counter (id, prefix, current_value)
    VALUES (1, 'WB', 1001)
    RETURNING current_value, prefix INTO v, p;
  END IF;

  RETURN p || lpad(v::text, 4, '0');
END;
$$;

-- Optional: align with your current highest local slip, e.g.:
-- UPDATE slip_counter SET current_value = 1042 WHERE id = 1;

-- Bump counter to at least a numeric max (used by weighbridge on startup)
CREATE OR REPLACE FUNCTION sync_slip_counter_to_max(p_min_value BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v BIGINT;
BEGIN
  UPDATE slip_counter
  SET current_value = GREATEST(current_value, p_min_value),
      updated_at = now()
  WHERE id = 1
  RETURNING current_value INTO v;
  RETURN v;
END;
$$;

-- ============================================================
-- 2. Remote trips queue
-- ============================================================
CREATE TABLE IF NOT EXISTS remote_trips (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slip_number       TEXT NOT NULL UNIQUE,
  truck_number      TEXT NOT NULL,
  rfid_tag          TEXT,
  customer_name     TEXT NOT NULL,
  destination       TEXT NOT NULL,
  material          TEXT NOT NULL,
  operator_name     TEXT NOT NULL,
  transporter       TEXT,
  vehicle_type      TEXT,
  tare_weight       DOUBLE PRECISION NOT NULL,
  gross_weight      DOUBLE PRECISION NOT NULL,
  net_weight        DOUBLE PRECISION GENERATED ALWAYS AS (gross_weight - tare_weight) STORED,
  timestamp_in      TIMESTAMPTZ NOT NULL,
  timestamp_out     TIMESTAMPTZ NOT NULL,
  ticket_status     TEXT NOT NULL DEFAULT 'CLOSED',
  status            TEXT NOT NULL DEFAULT 'captured',

  arrival_photo_1   TEXT,
  arrival_photo_2   TEXT,
  arrival_photo_3   TEXT,
  departure_photo_1 TEXT,
  departure_photo_2 TEXT,
  departure_photo_3 TEXT,
  report_s3_key     TEXT,

  synced_to_local   BOOLEAN NOT NULL DEFAULT false,
  synced_at         TIMESTAMPTZ,
  local_id          TEXT,
  mcg_status        TEXT NOT NULL DEFAULT 'pending',
  mcg_error         TEXT,
  mcg_sent_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_remote_trips_pending
  ON remote_trips (created_at)
  WHERE synced_to_local = false;

-- Auto-assign slip if omitted on INSERT
CREATE OR REPLACE FUNCTION remote_trips_assign_slip()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.slip_number IS NULL OR btrim(NEW.slip_number) = '' THEN
    NEW.slip_number := next_slip_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_remote_trips_slip ON remote_trips;
CREATE TRIGGER trg_remote_trips_slip
  BEFORE INSERT ON remote_trips
  FOR EACH ROW
  EXECUTE PROCEDURE remote_trips_assign_slip();

-- Notify weighbridge app for near-instant sync
CREATE OR REPLACE FUNCTION remote_trips_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('new_remote_trip', NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_remote_trips_notify ON remote_trips;
CREATE TRIGGER trg_remote_trips_notify
  AFTER INSERT ON remote_trips
  FOR EACH ROW
  EXECUTE PROCEDURE remote_trips_notify();

-- ============================================================
-- 3. Permissions (adjust passwords outside this script)
-- ============================================================
-- GRANT CONNECT ON DATABASE postgres TO weighbridge;
-- GRANT USAGE ON SCHEMA public TO weighbridge;
-- GRANT SELECT, UPDATE ON remote_trips TO weighbridge;
-- GRANT SELECT, UPDATE ON slip_counter TO weighbridge;
-- GRANT EXECUTE ON FUNCTION next_slip_number() TO weighbridge;
-- GRANT EXECUTE ON FUNCTION sync_slip_counter_to_max(BIGINT) TO weighbridge;
