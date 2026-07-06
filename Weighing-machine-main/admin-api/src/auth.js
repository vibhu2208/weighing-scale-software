'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const JWT_SECRET = () => process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRY = '24h';

async function findUserByEmail(email) {
  const res = await query(
    'SELECT id, email, password_hash, role FROM admin_users WHERE email = $1 LIMIT 1',
    [String(email).trim().toLowerCase()],
  );
  return res.rows[0] || null;
}

async function verifyLogin(email, password) {
  const user = await findUserByEmail(email);
  if (!user) return { ok: false, error: 'Invalid email or password' };
  const match = await bcrypt.compare(String(password), user.password_hash);
  if (!match) return { ok: false, error: 'Invalid email or password' };
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET(),
    { expiresIn: JWT_EXPIRY },
  );
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET());
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

async function bootstrapAdminUser() {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!email || !password) return;

  const existing = await query('SELECT COUNT(*) AS c FROM admin_users');
  if (Number(existing.rows[0].c) > 0) return;

  const hash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3)',
    [email, hash, 'admin'],
  );
  console.log('[auth] Bootstrap admin user created:', email);
}

module.exports = {
  verifyLogin,
  authMiddleware,
  bootstrapAdminUser,
};
