const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function findUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1 AND active = 1', [email.toLowerCase().trim()]);
  return res.rows[0] || null;
}

// Used to find "the" Accounts login regardless of its current email -
// there's only ever meant to be one, managed entirely through Settings.
async function findUserByRole(role) {
  const res = await pool.query('SELECT * FROM users WHERE role = $1 AND active = 1 LIMIT 1', [role]);
  return res.rows[0] || null;
}

function verifyPassword(plainPassword, hash) {
  return bcrypt.compareSync(plainPassword, hash);
}

async function createUser(email, plainPassword, name, role) {
  const hash = bcrypt.hashSync(plainPassword, 10);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
    [email.toLowerCase().trim(), hash, name, role || 'Accounts']
  );
}

async function updatePassword(email, newPlainPassword) {
  const hash = bcrypt.hashSync(newPlainPassword, 10);
  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE email = $2',
    [hash, email.toLowerCase().trim()]
  );
}

/**
 * Creates or updates "the" Accounts login from the Settings page.
 * If an Accounts user already exists, its email is updated to match
 * (and its password too, only if a new one was given - leaving it
 * blank keeps the existing password). If none exists yet, both email
 * and password are required to create it.
 */
async function upsertAccountsUser(email, plainPassword) {
  const existing = await findUserByRole('Accounts');
  const cleanEmail = email.toLowerCase().trim();
  if (existing) {
    if (plainPassword) {
      const hash = bcrypt.hashSync(plainPassword, 10);
      await pool.query('UPDATE users SET email = $1, password_hash = $2 WHERE id = $3', [cleanEmail, hash, existing.id]);
    } else {
      await pool.query('UPDATE users SET email = $1 WHERE id = $2', [cleanEmail, existing.id]);
    }
  } else {
    if (!plainPassword) throw new Error('A password is required to create the Accounts login for the first time.');
    await createUser(cleanEmail, plainPassword, 'Accounts Team', 'Accounts');
  }
}

// Blocks any /api/* route unless someone is logged in as Admin or Accounts.
// req.session.user is set at login time (see server.js /api/login).
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  next();
}

// Some actions (deciding advances, passing/rejecting trips) are
// Accounts-only, even though Admin can see everything. Admin can still
// do these too, since Admin has full access by definition.
function requireAccounts(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  if (req.session.user.role !== 'Accounts' && req.session.user.role !== 'Admin') {
    return res.status(403).json({ ok: false, error: 'Only Accounts can do this' });
  }
  next();
}

// Settings (including the Accounts login's own email/password) are
// Admin-only - Accounts should never be able to see or change these,
// even via a direct API call.
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  if (req.session.user.role !== 'Admin') {
    return res.status(403).json({ ok: false, error: 'Only Admin can do this' });
  }
  next();
}

module.exports = { findUserByEmail, findUserByRole, verifyPassword, createUser, updatePassword, upsertAccountsUser, requireLogin, requireAccounts, requireAdmin };
