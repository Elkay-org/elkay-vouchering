const express = require('express');
const { pool } = require('./db');
const { formatDate, nextSequentialCode } = require('./idHelper');
const { requireLogin, requireAccounts } = require('./auth');
const { sendAdvanceDecisionToDoer, sendTripDecisionToDoer } = require('./mailer');
const { buildVoucherPdf } = require('./voucherPdf');
const { downloadReceiptFromDrive } = require('./drive');
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
    sendAdvanceDecisionToDoer(doer.email, doer.doer_name, req.params.requestId, approved, finalApprovedAmount, req.session.user.email)
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
    SELECT t.*, d.doer_name FROM trips t
    JOIN doers d ON d.doer_code = t.doer_code
    ORDER BY t.id DESC
  `);
  res.json({ ok: true, trips: result.rows.map(r => ({ ...toTripJson(r), DoerName: r.doer_name })) });
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
  const vouchersResult = await pool.query('SELECT * FROM vouchers WHERE trip_code = $1 ORDER BY id', [req.params.tripCode]);
  const vouchers = vouchersResult.rows.map(toVoucherJson);

  // Fetch every receipt photo in parallel (not one at a time) so this
  // stays fast even with several vouchers - one failed/missing photo
  // just gets skipped rather than breaking the whole PDF.
  const withPhotos = vouchers.filter(v => v.ReceiptPhotoURL);
  const fetched = await Promise.all(
    withPhotos.map(v => downloadReceiptFromDrive(v.ReceiptPhotoURL).then(buffer => ({ voucherId: v.VoucherID, buffer })))
  );
  const receiptImages = fetched.filter(r => r.buffer); // drop any that failed to download

  const pdfBuffer = await buildVoucherPdf({
    trip: toTripJson(trip),
    doer: { DoerName: trip.doer_name, Email: trip.email },
    vouchers,
    passedBy: trip.passed_by,
    receiptImages
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Petty Cash Voucher - ${trip.trip_code}.pdf"`);
  res.send(pdfBuffer);
}));

router.post('/trips/:tripCode/pass', requireAccounts, safe(async (req, res) => {
  const existing = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
  const trip = existing.rows[0];
  if (!trip) return res.status(404).json({ ok: false, error: 'Trip not found.' });
  if (trip.trip_status !== 'Submitted') return res.status(400).json({ ok: false, error: 'Only submitted trips can be passed.' });

  const now = formatDate(new Date());
  const result = await pool.query(
    "UPDATE trips SET trip_status = 'Passed', passed_by = $1, passed_date = $2 WHERE trip_code = $3 RETURNING *",
    [req.session.user.name || req.session.user.email, now, req.params.tripCode]
  );

  const doerResult = await pool.query('SELECT doer_name, email FROM doers WHERE doer_code = $1', [trip.doer_code]);
  const doer = doerResult.rows[0];
  if (doer) {
    sendTripDecisionToDoer(doer.email, doer.doer_name, req.params.tripCode, true, null, req.session.user.email)
      .catch(err => console.error('Trip pass email failed:', err.message));
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
    sendTripDecisionToDoer(doer.email, doer.doer_name, req.params.tripCode, false, remark, req.session.user.email)
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

/** ---------- SETTINGS (ACCOUNTS_EMAIL / ACCOUNTS_NAME) ---------- */

router.get('/settings', safe(async (req, res) => {
  const result = await pool.query('SELECT * FROM settings');
  const settings = {};
  result.rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ ok: true, settings });
}));

router.put('/settings', safe(async (req, res) => {
  const updates = req.body; // { KEY: 'value', ... }
  for (const [key, value] of Object.entries(updates)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
  }
  res.json({ ok: true });
}));

module.exports = router;
