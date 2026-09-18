const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function findUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1 AND active = 1', [email.toLowerCase().trim()]);
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

module.exports = { findUserByEmail, verifyPassword, createUser, updatePassword, requireLogin, requireAccounts };
