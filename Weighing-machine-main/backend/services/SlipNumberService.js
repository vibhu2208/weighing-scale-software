'use strict';

const { getDb } = require('../database/db');
const pg = require('../database/pg');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');

function parseSlipNumeric(slip) {
  if (!slip) return 0;
  const match = String(slip).match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}

function ensureSlipCounter(db) {
  const row = db.prepare('SELECT id FROM slip_counter LIMIT 1').get();
  if (row) return;
  const now = ts.now();
  db.prepare(
    `INSERT INTO slip_counter (prefix, current_value, updated_at)
     VALUES ('WB', 0, ?)`,
  ).run(now);
}

function generateSlipNumberLocal() {
  const db = getDb();
  const allocate = db.transaction(() => {
    ensureSlipCounter(db);
    const row = db
      .prepare(
        'SELECT id, prefix, current_value FROM slip_counter ORDER BY id LIMIT 1',
      )
      .get();
    if (!row) {
      throw new Error('slip_counter could not be initialised');
    }
    const nextValue = row.current_value + 1;
    const now = ts.now();
    db.prepare(
      'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
    ).run(nextValue, now, row.id);
    const prefix = row.prefix || 'WB';
    return `${prefix}${String(nextValue).padStart(4, '0')}`;
  });
  return allocate();
}

function getMaxLocalSlipNumeric() {
  const rows = getDb()
    .prepare(`SELECT slip_number FROM transactions WHERE slip_number IS NOT NULL`)
    .all();
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, parseSlipNumeric(row.slip_number));
  }
  const counter = getDb()
    .prepare('SELECT current_value FROM slip_counter ORDER BY id LIMIT 1')
    .get();
  if (counter?.current_value != null) {
    max = Math.max(max, Number(counter.current_value) || 0);
  }
  return max;
}

function bumpLocalSlipCounterTo(minValue) {
  const min = Math.max(0, Number(minValue) || 0);
  if (min <= 0) return;
  const db = getDb();
  ensureSlipCounter(db);
  const row = db
    .prepare('SELECT id, current_value FROM slip_counter ORDER BY id LIMIT 1')
    .get();
  if (!row) return;
  if (row.current_value >= min) return;
  db.prepare(
    'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
  ).run(min, ts.now(), row.id);
}

const SlipNumberService = {
  parseSlipNumeric,
  generateSlipNumberLocal,
  getMaxLocalSlipNumeric,

  async allocate() {
    if (pg.isConfigured()) {
      try {
        const ok = await pg.ping();
        if (ok) {
          const slip = await pg.getNextSlipNumber();
          bumpLocalSlipCounterTo(parseSlipNumeric(slip));
          return slip;
        }
      } catch (err) {
        logger.warn('RDS slip allocation failed — using local counter', {
          message: err.message,
        });
      }
    }
    return generateSlipNumberLocal();
  },

  async syncOnStartup() {
    if (!pg.isConfigured()) return { ok: false, reason: 'not_configured' };

    try {
      const ok = await pg.ping();
      if (!ok) return { ok: false, reason: 'ping_failed' };

      const localMax = getMaxLocalSlipNumeric();
      if (localMax > 0) {
        await pg.syncSlipCounterToMax(localMax);
        bumpLocalSlipCounterTo(localMax);
      }

      const rdsValue = await pg.getSlipCounterValue();
      if (rdsValue != null) {
        bumpLocalSlipCounterTo(Number(rdsValue));
      }

      logger.info('Slip counter synced with RDS', { localMax, rdsValue });
      return { ok: true, localMax, rdsValue };
    } catch (err) {
      logger.warn('Slip counter RDS sync failed', { message: err.message });
      return { ok: false, reason: err.message };
    }
  },
};

module.exports = SlipNumberService;
