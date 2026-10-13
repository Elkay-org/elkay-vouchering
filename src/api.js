const express = require('express');
const { pool } = require('./db');
const { formatDate, nextSequentialCode } = require('./idHelper');
const { requireLogin, requireAccounts, requireAdmin, upsertAccountsUser } = require('./auth');
const { sendAdvanceDecisionToDoer, sendTripDecisionToDoer } = require('./mailer');
const { uploadVoucherPdfToDrive, uploadReportToDrive } = require('./drive');
const { buildTripPdfBuffer } = require('./pdfHelper');
const { buildWeeklyReportBuffer } = require('./reportHelper');
const { getAvailableBalance } = require('./publicRoutes');
const router = express.Router();

router.use(requireLogin); // everything below requires Admin/Accounts login

// Wraps a route so any thrown/rejected error becomes a clean JSON
// error response instead of crashing the request.
function safe(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  });
}

/** ---------- DOERS (admin-managed master list) ---------- */

router.get('/doers', safe(async (req, res) => {
  const result = await pool.query('SELECT * FROM doers ORDER BY doer_name');
  res.json({ ok: true, doers: result.rows.map(toDoerJson) });
}));

router.post('/doers', safe(async (req, res) => {
  const { doerName, email } = req.body;
  if (!doerName) return res.status(400).json({ ok: false, error: 'Doer name is required.' });
  const doerCode = await nextSequentialCode(pool, 'doers', 'doer_code', 'D-', 3);
  const now = formatDate(new Date());
  const result = await pool.query(
    "INSERT INTO doers (doer_code, doer_name, email, active, created_at) VALUES ($1, $2, $3, 'Y', $4) RETURNING *",
    [doerCode, doerName, email || '', now]
  );
  res.json({ ok: true, record: toDoerJson(result.rows[0]) });
}));

router.put('/doers/:doerCode', safe(async (req, res) => {
  const { doerName, email, active } = req.body;
  const result = await pool.query(
    'UPDATE doers SET doer_name = COALESCE($1, doer_name), email = COALESCE($2, email), active = COALESCE($3, active) WHERE doer_code = $4 RETURNING *',
    [doerName, email, active, req.params.doerCode]
  );
  if (!result.rows[0]) return res.status(404).json({ ok: false, error: 'Doer not found.' });
  res.json({ ok: true, record: toDoerJson(result.rows[0]) });
}));

function toDoerJson(d) {
  return { DoerCode: d.doer_code, DoerName: d.doer_name, Email: d.email, Active: d.active, CreatedAt: d.created_at };
}

/** ---------- ADVANCE REQUESTS (Accounts decides) ---------- */

router.get('/advance-requests', safe(async (req, res) => {
  const result = await pool.query(`
    SELECT ar.*, d.doer_name FROM advance_requests ar
    JOIN doers d ON d.doer_code = ar.doer_code
    ORDER BY ar.id DESC
  `);
  res.json({ ok: true, requests: result.rows.map(r => ({ ...toAdvanceJson(r), DoerName: r.doer_name })) });
}));

router.post('/advance-requests/:requestId/decide', requireAccounts, safe(async (req, res) => {
  const { approved, approvedAmount } = req.body;
  const existing = await pool.query('SELECT * FROM advance_requests WHERE request_id = $1', [req.params.requestId]);
  const request = existing.rows[0];
  if (!request) return res.status(404).json({ ok: false, error: 'Advance request not found.' });
  if (request.status !== 'Pending') return res.status(400).json({ ok: false, error: 'This request has already been decided.' });

  const now = formatDate(new Date());
  const finalApprovedAmount = approved ? (approvedAmount || request.requested_amount) : 0;
  const result = await pool.query(
    "UPDATE advance_requests SET status = $1, approved_amount = $2, decided_at = $3 WHERE request_id = $4 RETURNING *",
    [approved ? 'Approved' : 'Rejected', finalApprovedAmount, now, req.params.requestId]
  );

  const doerResult = await pool.query('SELECT doer_name, email FROM doers WHERE doer_code = $1', [request.doer_code]);
  const doer = doerResult.rows[0];
  if (doer) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ccResult = await pool.query('SELECT email FROM advance_cc_recipients');
    const ccList = ccResult.rows.map(r => r.email).filter(Boolean);
    sendAdvanceDecisionToDoer(doer.email, doer.doer_name, req.params.requestId, approved, finalApprovedAmount, req.session.user.email, baseUrl, ccList)
      .catch(err => console.error('Advance decision email failed:', err.message));
  }

  res.json({ ok: true, record: toAdvanceJson(result.rows[0]) });
}));

// Deletes an advance request entirely - matching HRMS's pattern of
// allowing deletion at any stage.
router.delete('/advance-requests/:requestId', requireAccounts, safe(async (req, res) => {
  await pool.query('DELETE FROM advance_requests WHERE request_id = $1', [req.params.requestId]);
  res.json({ ok: true });
}));

function toAdvanceJson(r) {
  return {
    RequestID: r.request_id, DoerCode: r.doer_code, Purpose: r.purpose,
    RequestedAmount: Number(r.requested_amount), ApprovedAmount: r.approved_amount ? Number(r.approved_amount) : null,
    Status: r.status, CreatedAt: r.created_at, DecidedAt: r.decided_at
  };
}

/** ---------- TRIPS (Accounts reviews whole trips) ---------- */

router.get('/trips', safe(async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, d.doer_name, COALESCE(v.total, 0) AS voucher_total
    FROM trips t
    JOIN doers d ON d.doer_code = t.doer_code
    LEFT JOIN (SELECT trip_code, SUM(amount) AS total FROM vouchers GROUP BY trip_code) v ON v.trip_code = t.trip_code
    ORDER BY t.id DESC
  `);
  res.json({ ok: true, trips: result.rows.map(r => ({ ...toTripJson(r), DoerName: r.doer_name, VoucherTotal: Number(r.voucher_total) })) });
}));

// Per-Doer money picture for the Dashboard. Uses the SAME available-balance
// calculation the Doer sees in their own portal, so the two never disagree.
router.get('/overview/doer-balances', safe(async (req, res) => {
  const doers = (await pool.query("SELECT doer_code, doer_name, active FROM doers ORDER BY doer_name")).rows;
  const tripRows = (await pool.query(`
    SELECT t.doer_code, t.trip_status, t.advance_received, t.advance_returned, COALESCE(SUM(v.amount), 0) AS voucher_total
    FROM trips t LEFT JOIN vouchers v ON v.trip_code = t.trip_code
    GROUP BY t.trip_code, t.doer_code, t.trip_status, t.advance_received, t.advance_returned
  `)).rows;

  const balances = [];
  for (const d of doers) {
    const mine = tripRows.filter(t => t.doer_code === d.doer_code);
    const available = await getAvailableBalance(d.doer_code);
    // Advance tied up on trips still being worked on
    const onActiveTrips = mine.filter(t => t.trip_status === 'Ongoing' || t.trip_status === 'Rejected')
      .reduce((s, t) => s + Number(t.advance_received || 0), 0);
    // Unspent advance on PASSED trips that Accounts marked "Not returned" -
    // i.e. money Accounts still needs to collect back.
    const toCollect = mine.filter(t => t.trip_status === 'Passed' && t.advance_returned === 'N')
      .reduce((s, t) => s + Math.max(0, Number(t.advance_received || 0) - Number(t.voucher_total)), 0);
    const openTrips = mine.filter(t => t.trip_status !== 'Passed').length;
    balances.push({
      DoerCode: d.doer_code, DoerName: d.doer_name, Active: d.active,
      Available: available, OnActiveTrips: onActiveTrips, WithDoer: available + onActiveTrips,
      ToCollect: toCollect, OpenTrips: openTrips
    });
  }
  res.json({ ok: true, balances });
}));

router.get('/trips/:tripCode', safe(async (req, res) => {
  const tripResult = await pool.query(`
    SELECT t.*, d.doer_name FROM trips t JOIN doers d ON d.doer_code = t.doer_code WHERE t.trip_code = $1
  `, [req.params.tripCode]);
  const trip = tripResult.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });
  const vouchersResult = await pool.query('SELECT * FROM vouchers WHERE trip_code = $1 ORDER BY id', [req.params.tripCode]);
  res.json({ ok: true, trip: { ...toTripJson(trip), DoerName: trip.doer_name }, vouchers: vouchersResult.rows.map(toVoucherJson) });
}));

// Downloads the Petty Cash Voucher PDF, matching Elkay's paper format -
// available at any trip status, matching the original design ("Accounts
// can download a PDF at any point").
router.get('/trips/:tripCode/pdf', safe(async (req, res) => {
  const tripResult = await pool.query(`
    SELECT t.*, d.doer_name, d.email FROM trips t JOIN doers d ON d.doer_code = t.doer_code WHERE t.trip_code = $1
  `, [req.params.tripCode]);
  const trip = tripResult.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });

  const pdfBuffer = await buildTripPdfBuffer(trip, trip.doer_name, trip.email);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Petty Cash Voucher - ${trip.trip_code}.pdf"`);
  res.send(pdfBuffer);
}));

router.post('/trips/:tripCode/pass', requireAccounts, safe(async (req, res) => {
  const existing = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
  const trip = existing.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });
  if (trip.trip_status !== 'Submitted') return res.status(400).json({ ok: false, error: 'Only submitted trips can be passed.' });

  // If there's unspent advance on this trip, Accounts must say whether
  // the Doer physically returned it before we can finalize - this
  // directly decides whether that amount stays usable for their next
  // trip (see getAvailableBalance() in publicRoutes.js).
  const voucherTotalResult = await pool.query('SELECT COALESCE(SUM(amount), 0) as total FROM vouchers WHERE trip_code = $1', [req.params.tripCode]);
  const voucherTotal = Number(voucherTotalResult.rows[0].total);
  const advance = Number(trip.advance_received || 0);
  const remainingBalance = advance - voucherTotal;

  let advanceReturned = null;
  if (remainingBalance > 0) {
    if (req.body.advanceReturned === undefined || req.body.advanceReturned === null) {
      return res.status(400).json({
        ok: false, error: 'ADVANCE_RETURNED_REQUIRED',
        remainingBalance, message: `Did the Doer return the remaining Rs. ${remainingBalance.toLocaleString('en-IN')}?`
      });
    }
    advanceReturned = req.body.advanceReturned ? 'Y' : 'N';
  }

  const now = formatDate(new Date());
  const passedBy = req.session.user.name || req.session.user.email;
  let result = await pool.query(
    "UPDATE trips SET trip_status = 'Passed', passed_by = $1, passed_date = $2, advance_returned = $3 WHERE trip_code = $4 RETURNING *",
    [passedBy, now, advanceReturned, req.params.tripCode]
  );

  const doerResult = await pool.query('SELECT doer_name, email FROM doers WHERE doer_code = $1', [trip.doer_code]);
  const doer = doerResult.rows[0];
  if (doer) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    sendTripDecisionToDoer(doer.email, doer.doer_name, req.params.tripCode, true, null, req.session.user.email, baseUrl)
      .catch(err => console.error('Trip pass email failed:', err.message));
  }

  // Generate the official Petty Cash Voucher PDF now that the trip is
  // finalized, and save it to Drive - this becomes the permanent,
  // saved copy visible from the dashboard, separate from the
  // "Download PDF" button which regenerates on demand at any time.
  try {
    const passedTrip = result.rows[0];
    const pdfBuffer = await buildTripPdfBuffer(passedTrip, doer ? doer.doer_name : trip.doer_code, doer ? doer.email : null);
    const driveLink = await uploadVoucherPdfToDrive(pdfBuffer, req.params.tripCode);
    if (driveLink) {
      result = await pool.query(
        'UPDATE trips SET voucher_pdf_drive_link = $1 WHERE trip_code = $2 RETURNING *',
        [driveLink, req.params.tripCode]
      );
    }
  } catch (err) {
    // Don't fail the whole Pass action if Drive saving hiccups - the
    // trip is still correctly Passed, Accounts can use Download PDF
    // as a fallback and we log this for follow-up.
    console.error('Could not save voucher PDF to Drive:', err.message);
  }

  res.json({ ok: true, record: toTripJson(result.rows[0]) });
}));

router.post('/trips/:tripCode/reject', requireAccounts, safe(async (req, res) => {
  const { remark } = req.body;
  if (!remark) return res.status(400).json({ ok: false, error: 'A remark is required when rejecting a trip.' });

  const existing = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
  const trip = existing.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });
  if (trip.trip_status !== 'Submitted') return res.status(400).json({ ok: false, error: 'Only submitted trips can be rejected.' });

  const result = await pool.query(
    "UPDATE trips SET trip_status = 'Rejected', rejection_remark = $1 WHERE trip_code = $2 RETURNING *",
    [remark, req.params.tripCode]
  );

  const doerResult = await pool.query('SELECT doer_name, email FROM doers WHERE doer_code = $1', [trip.doer_code]);
  const doer = doerResult.rows[0];
  if (doer) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    sendTripDecisionToDoer(doer.email, doer.doer_name, req.params.tripCode, false, remark, req.session.user.email, baseUrl)
      .catch(err => console.error('Trip reject email failed:', err.message));
  }

  res.json({ ok: true, record: toTripJson(result.rows[0]) });
}));

/** Reopens a Rejected trip so the Doer can fix and resubmit it. */
router.post('/trips/:tripCode/reopen', requireAccounts, safe(async (req, res) => {
  const existing = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
  const trip = existing.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });
  if (trip.trip_status !== 'Rejected') return res.status(400).json({ ok: false, error: 'Only rejected trips can be reopened.' });

  const result = await pool.query("UPDATE trips SET trip_status = 'Ongoing' WHERE trip_code = $1 RETURNING *", [req.params.tripCode]);
  res.json({ ok: true, record: toTripJson(result.rows[0]) });
}));

// Deletes a trip and its vouchers entirely - available at any status,
// matching HRMS's "delete available at any stage" pattern. This is a
// real, permanent removal (not a status change), so the frontend
// confirms with the user before calling this.
router.delete('/trips/:tripCode', requireAccounts, safe(async (req, res) => {
  await pool.query('DELETE FROM vouchers WHERE trip_code = $1', [req.params.tripCode]);
  await pool.query('DELETE FROM trips WHERE trip_code = $1', [req.params.tripCode]);
  res.json({ ok: true });
}));

function toTripJson(t) {
  return {
    TripCode: t.trip_code, InitiatedBy: t.initiated_by, DoerCode: t.doer_code, Vertical: t.vertical,
    LocationVisited: t.location_visited, StartDate: t.start_date, PurposeOfVisit: t.purpose_of_visit,
    AdvanceReceived: Number(t.advance_received || 0), EndDate: t.end_date, TripStatus: t.trip_status,
    ReceiptNotReceivedFor: t.receipt_not_received_for, RejectionRemark: t.rejection_remark, ClosingRemarks: t.closing_remarks,
    VoucherPdfDriveLink: t.voucher_pdf_drive_link, AdvanceReturned: t.advance_returned,
    PassedBy: t.passed_by, PassedDate: t.passed_date, CreatedAt: t.created_at
  };
}

function toVoucherJson(v) {
  return {
    VoucherID: v.voucher_id, TripCode: v.trip_code, DateTime: v.date_time, ExpenseType: v.expense_type,
    Description: v.description, Amount: Number(v.amount), ReceiptAvailable: v.receipt_available,
    ReceiptPhotoURL: v.receipt_photo_url, NoReceiptReason: v.no_receipt_reason, CreatedAt: v.created_at
  };
}

/** ---------- REPORTS ---------- */

// Generates the weekly person-wise summary report and saves it to Drive
// - Accounts uses this to hand a clean summary to their boss. Returns
// the computed numbers directly too, so the dashboard can show them
// immediately without a separate fetch.
router.post('/reports/weekly', requireAccounts, safe(async (req, res) => {
  const { start, end } = req.body;
  if (!start || !end) return res.status(400).json({ ok: false, error: 'Start and end dates are required.' });

  const { buffer, doerRows, totals, tripCount } = await buildWeeklyReportBuffer(start, end);
  const filename = `Weekly Report ${start} to ${end}.xlsx`;

  let driveLink = null;
  try {
    driveLink = await uploadReportToDrive(buffer, filename);
  } catch (err) {
    console.error('Could not save weekly report to Drive:', err.message);
  }

  res.json({ ok: true, driveLink, doerRows, totals, tripCount });
}));

/** ---------- ADVANCE EMAIL CC LIST (Admin-managed, like HRMS's "Always Notify") ---------- */

router.get('/advance-cc-recipients', requireAdmin, safe(async (req, res) => {
  const result = await pool.query('SELECT * FROM advance_cc_recipients ORDER BY id');
  res.json({ ok: true, recipients: result.rows.map(r => ({ Id: r.id, Name: r.name, Email: r.email })) });
}));

router.post('/advance-cc-recipients', requireAdmin, safe(async (req, res) => {
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'Email is required' });
  const now = formatDate(new Date());
  const result = await pool.query(
    'INSERT INTO advance_cc_recipients (name, email, added_at) VALUES ($1, $2, $3) RETURNING *',
    [name || '', email, now]
  );
  res.json({ ok: true, recipient: { Id: result.rows[0].id, Name: result.rows[0].name, Email: result.rows[0].email } });
}));

router.delete('/advance-cc-recipients/:id', requireAdmin, safe(async (req, res) => {
  await pool.query('DELETE FROM advance_cc_recipients WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/** ---------- SETTINGS (ACCOUNTS_EMAIL / ACCOUNTS_NAME / Accounts login) ---------- */
/** Admin-only - Accounts should never see or change these, even via a direct API call. */

router.get('/settings', requireAdmin, safe(async (req, res) => {
  const result = await pool.query('SELECT * FROM settings');
  const settings = {};
  result.rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ ok: true, settings });
}));

router.put('/settings', requireAdmin, safe(async (req, res) => {
  const { ACCOUNTS_NAME, ACCOUNTS_EMAIL, accountsPassword } = req.body;

  if (ACCOUNTS_NAME !== undefined) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['ACCOUNTS_NAME', ACCOUNTS_NAME]);
  }
  if (ACCOUNTS_EMAIL !== undefined) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['ACCOUNTS_EMAIL', ACCOUNTS_EMAIL]);
  }

  // The Accounts login itself (email + password) is managed right here
  // by Admin - Accounts never sets their own credentials.
  if (ACCOUNTS_EMAIL) {
    await upsertAccountsUser(ACCOUNTS_EMAIL, accountsPassword || null);
  }

  res.json({ ok: true });
}));

module.exports = router;
