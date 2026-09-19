const { Pool } = require('pg');

// DATABASE_URL comes from Supabase (or any Postgres provider) - set as an
// environment variable, never hardcoded here. This should be a SEPARATE
// Supabase project from HRMS's - keeping the two systems' data fully
// isolated from each other, even though they're both Elkay Corporation
// internal tools.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase requires SSL; standard setting for it
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'Accounts', -- 'Admin' or 'Accounts'
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT now()
    );

    -- Master list of Doers (org members who travel and submit vouchers).
    -- Admin-managed, not self-service - matches the original Apps Script
    -- design ("admin-managed master list").
    CREATE TABLE IF NOT EXISTS doers (
      id SERIAL PRIMARY KEY,
      doer_code TEXT UNIQUE NOT NULL,
      doer_name TEXT NOT NULL,
      email TEXT,
      active TEXT DEFAULT 'Y',
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS trips (
      id SERIAL PRIMARY KEY,
      trip_code TEXT UNIQUE NOT NULL,
      initiated_by TEXT,
      doer_code TEXT NOT NULL,
      vertical TEXT,
      location_visited TEXT,
      start_date TEXT,
      purpose_of_visit TEXT,
      advance_received NUMERIC DEFAULT 0,
      end_date TEXT,
      trip_status TEXT DEFAULT 'Ongoing', -- Ongoing / Submitted / Passed / Rejected
      receipt_not_received_for TEXT,
      rejection_remark TEXT,
      closing_remarks TEXT,
      passed_by TEXT,
      passed_date TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id SERIAL PRIMARY KEY,
      voucher_id TEXT UNIQUE NOT NULL,
      trip_code TEXT NOT NULL,
      date_time TEXT,
      expense_type TEXT,
      description TEXT,
      amount NUMERIC NOT NULL,
      receipt_available TEXT DEFAULT 'Y',
      receipt_photo_url TEXT,
      no_receipt_reason TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS advance_requests (
      id SERIAL PRIMARY KEY,
      request_id TEXT UNIQUE NOT NULL,
      doer_code TEXT NOT NULL,
      purpose TEXT,
      requested_amount NUMERIC NOT NULL,
      approved_amount NUMERIC,
      status TEXT DEFAULT 'Pending', -- Pending / Approved / Rejected
      created_at TEXT,
      decided_at TEXT
    );

    -- Key-value settings, same pattern as HRMS's payroll_config table.
    -- Holds ACCOUNTS_EMAIL / ACCOUNTS_NAME from the original design.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Row Level Security, matching the security posture Elkay already
  // established on every HRMS table - enabled on every table here too,
  // from the start this time rather than catching up later.
  const tables = ['users', 'doers', 'trips', 'vouchers', 'advance_requests', 'settings'];
  for (const t of tables) {
    await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
  }

  // Catch-up for a column added after this app was first deployed -
  // CREATE TABLE IF NOT EXISTS alone doesn't retroactively add columns
  // to a table that already exists. Safe to run on every startup.
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS closing_remarks TEXT;`);
  await pool.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS voucher_pdf_drive_link TEXT;`);

  // Seeds the two Settings keys the first time only - safe to run on
  // every startup, never overwrites a value you've already changed from
  // the dashboard.
  await pool.query("INSERT INTO settings (key, value) VALUES ('ACCOUNTS_EMAIL', '') ON CONFLICT (key) DO NOTHING");
  await pool.query("INSERT INTO settings (key, value) VALUES ('ACCOUNTS_NAME', 'Elkay Accounts') ON CONFLICT (key) DO NOTHING");
}

module.exports = { pool, initSchema };
