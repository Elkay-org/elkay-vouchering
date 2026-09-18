require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initSchema } = require('./db');
const { findUserByEmail, verifyPassword, createUser, updatePassword, requireLogin } = require('./auth');

const app = express();

// Render (and most hosting platforms) sit behind a reverse proxy that
// terminates HTTPS and forwards plain HTTP internally. Without this,
// Express can't tell the original request was actually HTTPS, which
// breaks secure-only session cookies - login appears to work but the
// session never actually persists.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' })); // generous limit for receipt photo uploads (base64)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    secure: process.env.NODE_ENV === 'production' // HTTPS only in production (Render provides this automatically)
  }
}));

/** ---------- AUTH ROUTES (Admin / Accounts only - Doers never log in) ---------- */

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email || '');
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }
    req.session.user = { email: user.email, name: user.name, role: user.role };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/change-password', requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: 'Both current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
    }
    const user = await findUserByEmail(req.session.user.email);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Current password is incorrect' });
    }
    await updatePassword(user.email, newPassword);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * One-time setup route to create your first login (Admin or Accounts),
 * same pattern as HRMS. Protected by SETUP_SECRET (an environment
 * variable you set yourself) so nobody else can use it.
 * Example: /api/setup-admin?secret=YOUR_SECRET&email=you@idett.co.in&password=...&name=You&role=Admin
 * Delete SETUP_SECRET from Render's Environment Variables once you've
 * created your login(s), to close this off.
 */
app.get('/api/setup-admin', async (req, res) => {
  try {
    if (!process.env.SETUP_SECRET) {
      return res.status(403).send('SETUP_SECRET is not set - add it in Render\'s Environment Variables first.');
    }
    if (req.query.secret !== process.env.SETUP_SECRET) {
      return res.status(403).send('Wrong secret.');
    }
    const { email, password, name, role } = req.query;
    if (!email || !password) {
      return res.status(400).send('Add ?email=...&password=...&name=...&role=Admin (or Accounts) to the URL.');
    }
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.send('A user with that email already exists. You can log in now.');
    }
    await createUser(email, password, name || email, role || 'Admin');
    res.send('Login created successfully! Go back to the app URL and log in. For safety, now remove SETUP_SECRET from Render\'s Environment Variables.');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

/** ---------- DATA ROUTES ---------- */

const { router: publicRoutes } = require('./publicRoutes');
app.use('/api/public', publicRoutes); // no login required - Doers use these directly

const apiRoutes = require('./api');
app.use('/api', apiRoutes); // requires login - Admin/Accounts dashboard only

/** ---------- FRONTEND ---------- */

// Any route not handled above falls through to the Admin/Accounts dashboard.
// The Doer portal is served separately as its own static page
// (public/doer-portal.html), matching HRMS's public-form pattern.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Vouchering server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err.message);
    process.exit(1);
  });
