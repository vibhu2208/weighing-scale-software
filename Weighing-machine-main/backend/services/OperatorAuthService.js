'use strict';

const { getDb } = require('../database/db');

const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MANUAL_HYWA_CLOSE_PIN = '0824';

let adminSession = null;
let manualHywaCloseSession = null;

function manualHywaClosePin() {
  const fromEnv = String(process.env.MANUAL_HYWA_CLOSE_PIN || '').trim();
  return fromEnv || DEFAULT_MANUAL_HYWA_CLOSE_PIN;
}

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
  manualHywaCloseSession = null;
  return { ok: true };
}

function isManualHywaCloseSessionActive() {
  if (!manualHywaCloseSession) return false;
  if (Date.now() > manualHywaCloseSession.expiresAt) {
    manualHywaCloseSession = null;
    return false;
  }
  return true;
}

function verifyManualHywaPin(pin) {
  const trimmed = String(pin || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Passcode is required' };
  }
  if (trimmed !== manualHywaClosePin()) {
    return { ok: false, error: 'Invalid passcode' };
  }

  const now = Date.now();
  manualHywaCloseSession = {
    unlockedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return {
    ok: true,
    expiresAt: manualHywaCloseSession.expiresAt,
  };
}

function lockManualHywaClose() {
  manualHywaCloseSession = null;
  return { ok: true };
}

function getManualHywaCloseSession() {
  if (!isManualHywaCloseSessionActive()) {
    return { active: false };
  }
  return {
    active: true,
    expiresAt: manualHywaCloseSession.expiresAt,
  };
}

function touchManualHywaCloseSession() {
  if (isManualHywaCloseSessionActive()) {
    manualHywaCloseSession.expiresAt = Date.now() + SESSION_TTL_MS;
  }
}

function assertManualHywaSectionAccess() {
  if (!isAdminSessionActive()) {
    throw new Error('Admin session required — unlock Advance Setting first');
  }
  if (!isManualHywaCloseSessionActive()) {
    throw new Error('Passcode required — unlock Manual HYWA section first');
  }
  touchSession();
  touchManualHywaCloseSession();
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
  verifyManualHywaPin,
  lockManualHywaClose,
  getManualHywaCloseSession,
  isManualHywaCloseSessionActive,
  touchManualHywaCloseSession,
  assertManualHywaSectionAccess,
};
