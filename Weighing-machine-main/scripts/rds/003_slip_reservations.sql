-- Slip gap reservations — schedule times; auto-block 5 min before planned_at
-- Run once after 001_schema.sql (needs next_slip_number())
-- admin-api ensureSchema also migrates existing tables.

CREATE TABLE IF NOT EXISTS slip_reservations (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slip_number     TEXT UNIQUE,
  planned_at      TIMESTAMPTZ NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'held', 'used', 'released', 'missed')),
  remote_trip_id  TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_at      TIMESTAMPTZ,
  fire_error      TEXT,
  used_at         TIMESTAMPTZ,
  released_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_slip_reservations_status_planned
  ON slip_reservations (status, planned_at);

CREATE INDEX IF NOT EXISTS idx_slip_reservations_held
  ON slip_reservations (planned_at)
  WHERE status = 'held';

CREATE INDEX IF NOT EXISTS idx_slip_reservations_scheduled_fire
  ON slip_reservations (planned_at)
  WHERE status = 'scheduled';
