'use strict';

const { getDb } = require('../database/db');

const SESSION_TTL_MS = 30 * 60 * 1000;

let adminSession = null;

function isAdminSessionActive() {
  if (!adminSession) return false;
  if (Date.now() > adminSession.expiresAt) {
    adminSession = null;
    return false;
  }
  return adminSession.role === 'admin';
}

function verifyPin(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'PIN is required' };
  }

  const row = getDb()
    .prepare(
      `SELECT id, name, pin, role, status FROM operators
       WHERE pin = ? AND status = 'active' LIMIT 1`,
    )
    .get(trimmed);

  if (!row) {
    return { ok: false, error: 'Invalid PIN' };
  }

  if (row.role !== 'admin') {
    return { ok: false, error: 'Admin access required' };
  }

  const now = Date.now();
  adminSession = {
    operatorId: row.id,
    name: row.name,
    role: row.role,
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return {
    ok: true,
    operator: {
      id: row.id,
      name: row.name,
      role: row.role,
    },
    expiresAt: adminSession.expiresAt,
  };
}

function lockAdvanced() {
  adminSession = null;
  return { ok: true };
}

function getSession() {
  if (!isAdminSessionActive()) {
    return { active: false };
  }
  return {
    active: true,
    operator: {
      id: adminSession.operatorId,
      name: adminSession.name,
      role: adminSession.role,
    },
    expiresAt: adminSession.expiresAt,
  };
}

function touchSession() {
  if (isAdminSessionActive()) {
    adminSession.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

module.exports = {
  verifyPin,
  lockAdvanced,
  getSession,
  isAdminSessionActive,
  touchSession,
};
