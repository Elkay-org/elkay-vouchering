const express = require('express');
const { pool } = require('./db');
const { formatDate, nextSequentialCode } = require('./idHelper');
const { uploadReceiptToDrive, isDriveConfigured } = require('./drive');

const router = express.Router();

/** List of active Doers, for the "who are you" dropdown on the shared link. */
router.get('/doers', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT doer_code, doer_name FROM doers WHERE active = 'Y' ORDER BY doer_name"
    );
    res.json({ ok: true, doers: result.rows.map(d => ({ DoerCode: d.doer_code, DoerName: d.doer_name })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Confirms this Doer exists/is active. Called right after picking a
 * name from the dropdown, before showing them anything - same
 * "confirm identity, no login" pattern as HRMS's Leave Request form.
 */
async function getActiveDoer(doerCode) {
  const result = await pool.query("SELECT * FROM doers WHERE doer_code = $1 AND active = 'Y'", [doerCode]);
  return result.rows[0] || null;
}

/** Available advance balance = approved advances minus advance actually drawn on trips. */
async function getAvailableBalance(doerCode) {
  const approvedResult = await pool.query(
    "SELECT COALESCE(SUM(approved_amount), 0) as total FROM advance_requests WHERE doer_code = $1 AND status = 'Approved'",
    [doerCode]
  );
  const drawnResult = await pool.query(
    "SELECT COALESCE(SUM(advance_received), 0) as total FROM trips WHERE doer_code = $1",
    [doerCode]
  );
  return Number(approvedResult.rows[0].total) - Number(drawnResult.rows[0].total);
}

router.get('/doer/:doerCode/context', async (req, res) => {
  try {
    const doer = await getActiveDoer(req.params.doerCode);
    if (!doer) return res.status(404).json({ ok: false, error: 'Doer not found or inactive. Contact Accounts.' });
    const availableBalance = await getAvailableBalance(doer.doer_code);
    res.json({ ok: true, doerName: doer.doer_name, availableBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** ---------- ADVANCE REQUESTS ---------- */

router.get('/doer/:doerCode/advance-requests', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM advance_requests WHERE doer_code = $1 ORDER BY id DESC',
      [req.params.doerCode]
    );
    res.json({ ok: true, requests: result.rows.map(toAdvanceJson) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/doer/:doerCode/advance-request', async (req, res) => {
  try {
    const doer = await getActiveDoer(req.params.doerCode);
    if (!doer) return res.status(404).json({ ok: false, error: 'Doer not found or inactive.' });

    const { purpose, requestedAmount } = req.body;
    if (!requestedAmount || Number(requestedAmount) <= 0) {
      return res.status(400).json({ ok: false, error: 'A valid requested amount is required.' });
    }

    const requestId = await nextSequentialCode(pool, 'advance_requests', 'request_id', 'ADV-');
    const now = formatDate(new Date());
    const result = await pool.query(
      `INSERT INTO advance_requests (request_id, doer_code, purpose, requested_amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'Pending', $5) RETURNING *`,
      [requestId, doer.doer_code, purpose || '', requestedAmount, now]
    );
    res.json({ ok: true, record: toAdvanceJson(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function toAdvanceJson(r) {
  return {
    RequestID: r.request_id, DoerCode: r.doer_code, Purpose: r.purpose,
    RequestedAmount: Number(r.requested_amount), ApprovedAmount: r.approved_amount ? Number(r.approved_amount) : null,
    Status: r.status, CreatedAt: r.created_at, DecidedAt: r.decided_at
  };
}

/** ---------- TRIPS ---------- */

router.get('/doer/:doerCode/trips', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trips WHERE doer_code = $1 ORDER BY id DESC',
      [req.params.doerCode]
    );
    res.json({ ok: true, trips: result.rows.map(toTripJson) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/doer/:doerCode/start-trip', async (req, res) => {
  try {
    const doer = await getActiveDoer(req.params.doerCode);
    if (!doer) return res.status(404).json({ ok: false, error: 'Doer not found or inactive.' });

    const { initiatedBy, vertical, locationVisited, startDate, purposeOfVisit, useAdvance } = req.body;
    if (!locationVisited || !startDate || !purposeOfVisit) {
      return res.status(400).json({ ok: false, error: 'Location, start date, and purpose of visit are all required.' });
    }

    let advanceReceived = 0;
    if (useAdvance) {
      advanceReceived = await getAvailableBalance(doer.doer_code);
      if (advanceReceived < 0) advanceReceived = 0;
    }

    const tripCode = await nextSequentialCode(pool, 'trips', 'trip_code', 'TRIP-');
    const now = formatDate(new Date());
    const result = await pool.query(
      `INSERT INTO trips (trip_code, initiated_by, doer_code, vertical, location_visited, start_date,
        purpose_of_visit, advance_received, trip_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Ongoing', $9) RETURNING *`,
      [tripCode, initiatedBy || '', doer.doer_code, vertical || '', locationVisited,
        formatDate(startDate), purposeOfVisit, advanceReceived, now]
    );
    res.json({ ok: true, record: toTripJson(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Trip detail + its vouchers. Ownership is checked here - a Doer can only ever see a trip that's actually theirs. */
router.get('/doer/:doerCode/trip/:tripCode', async (req, res) => {
  try {
    const tripResult = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
    const trip = tripResult.rows[0];
    if (!trip || trip.doer_code !== req.params.doerCode) {
      return res.status(404).json({ ok: false, error: 'Trip not found.' });
    }
    const vouchersResult = await pool.query('SELECT * FROM vouchers WHERE trip_code = $1 ORDER BY id', [req.params.tripCode]);
    res.json({ ok: true, trip: toTripJson(trip), vouchers: vouchersResult.rows.map(toVoucherJson) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Vouchers are only addable/editable while the trip is still 'Ongoing'. */
router.post('/doer/:doerCode/trip/:tripCode/vouchers', async (req, res) => {
  try {
    const tripResult = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
    const trip = tripResult.rows[0];
    if (!trip || trip.doer_code !== req.params.doerCode) {
      return res.status(404).json({ ok: false, error: 'Trip not found.' });
    }
    if (trip.trip_status !== 'Ongoing') {
      return res.status(400).json({ ok: false, error: 'This trip is locked and can no longer be edited.' });
    }

    const { dateTime, expenseType, description, amount, receiptAvailable, receiptPhotoBase64, receiptPhotoMimeType, noReceiptReason } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'A valid amount is required.' });
    }
    const hasReceipt = receiptAvailable !== false && receiptAvailable !== 'N';
    if (!hasReceipt && !noReceiptReason) {
      return res.status(400).json({ ok: false, error: 'A reason is required when no receipt is available.' });
    }

    let receiptPhotoUrl = null;
    if (hasReceipt) {
      if (!receiptPhotoBase64) {
        return res.status(400).json({ ok: false, error: 'A receipt photo is required (or mark "No receipt" with a reason).' });
      }
      if (isDriveConfigured()) {
        const buffer = Buffer.from(receiptPhotoBase64, 'base64');
        const filename = `receipt_${Date.now()}.jpg`;
        receiptPhotoUrl = await uploadReceiptToDrive(buffer, filename, receiptPhotoMimeType || 'image/jpeg', req.params.tripCode);
      }
    }

    const voucherId = await nextSequentialCode(pool, 'vouchers', 'voucher_id', 'V-');
    const now = formatDate(new Date());
    const result = await pool.query(
      `INSERT INTO vouchers (voucher_id, trip_code, date_time, expense_type, description, amount,
        receipt_available, receipt_photo_url, no_receipt_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [voucherId, req.params.tripCode, dateTime || now, expenseType || '', description || '', amount,
        hasReceipt ? 'Y' : 'N', receiptPhotoUrl, hasReceipt ? null : noReceiptReason, now]
    );

    // Keep the trip's running note of which vouchers are missing a
    // receipt and why - this becomes the "Receipt_Not_Received_For"
    // field Accounts sees when reviewing the whole trip.
    if (!hasReceipt) {
      const note = `${voucherId} (${expenseType || 'expense'}): ${noReceiptReason}`;
      const updatedNote = trip.receipt_not_received_for ? trip.receipt_not_received_for + '; ' + note : note;
      await pool.query('UPDATE trips SET receipt_not_received_for = $1 WHERE trip_code = $2', [updatedNote, req.params.tripCode]);
    }

    res.json({ ok: true, record: toVoucherJson(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/doer/:doerCode/trip/:tripCode/vouchers/:voucherId', async (req, res) => {
  try {
    const tripResult = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
    const trip = tripResult.rows[0];
    if (!trip || trip.doer_code !== req.params.doerCode) {
      return res.status(404).json({ ok: false, error: 'Trip not found.' });
    }
    if (trip.trip_status !== 'Ongoing') {
      return res.status(400).json({ ok: false, error: 'This trip is locked and can no longer be edited.' });
    }
    await pool.query('DELETE FROM vouchers WHERE voucher_id = $1 AND trip_code = $2', [req.params.voucherId, req.params.tripCode]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Submitting locks the trip (and its vouchers) until Accounts decides. */
router.post('/doer/:doerCode/trip/:tripCode/submit', async (req, res) => {
  try {
    const tripResult = await pool.query('SELECT * FROM trips WHERE trip_code = $1', [req.params.tripCode]);
    const trip = tripResult.rows[0];
    if (!trip || trip.doer_code !== req.params.doerCode) {
      return res.status(404).json({ ok: false, error: 'Trip not found.' });
    }
    if (trip.trip_status !== 'Ongoing') {
      return res.status(400).json({ ok: false, error: 'This trip has already been submitted.' });
    }
    const voucherCountResult = await pool.query('SELECT COUNT(*) FROM vouchers WHERE trip_code = $1', [req.params.tripCode]);
    if (Number(voucherCountResult.rows[0].count) === 0) {
      return res.status(400).json({ ok: false, error: 'Add at least one voucher before submitting.' });
    }

    const { endDate, closingRemarks } = req.body;
    if (!endDate) return res.status(400).json({ ok: false, error: 'End date is required.' });

    const result = await pool.query(
      `UPDATE trips SET end_date = $1, trip_status = 'Submitted', rejection_remark = COALESCE(rejection_remark, '') || $2
       WHERE trip_code = $3 RETURNING *`,
      [formatDate(endDate), closingRemarks ? (' | Closing remarks: ' + closingRemarks) : '', req.params.tripCode]
    );
    res.json({ ok: true, record: toTripJson(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function toTripJson(t) {
  return {
    TripCode: t.trip_code, InitiatedBy: t.initiated_by, DoerCode: t.doer_code, Vertical: t.vertical,
    LocationVisited: t.location_visited, StartDate: t.start_date, PurposeOfVisit: t.purpose_of_visit,
    AdvanceReceived: Number(t.advance_received || 0), EndDate: t.end_date, TripStatus: t.trip_status,
    ReceiptNotReceivedFor: t.receipt_not_received_for, RejectionRemark: t.rejection_remark,
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

module.exports = { router };
