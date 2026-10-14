const { pool } = require('./db');
const { buildVoucherPdf } = require('./voucherPdf');

function toVoucherJson(v) {
  return {
    VoucherID: v.voucher_id, TripCode: v.trip_code, DateTime: v.date_time, ExpenseType: v.expense_type,
    Description: v.description, Amount: Number(v.amount), ReceiptAvailable: v.receipt_available,
    ReceiptPhotoURL: v.receipt_photo_url, NoReceiptReason: v.no_receipt_reason, CreatedAt: v.created_at
  };
}

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

/**
 * Builds the voucher PDF buffer for a trip - shared by Accounts' own
 * download button, the Doer portal's download button, and the
 * auto-save-to-Drive step that runs when Accounts passes a trip.
 * This function only ever builds and returns the PDF bytes - it never
 * saves anything to Drive itself, so a plain download never creates a
 * stray Drive file.
 */
async function buildTripPdfBuffer(trip, doerName, doerEmail) {
  const vouchersResult = await pool.query('SELECT * FROM vouchers WHERE trip_code = $1 ORDER BY id', [trip.trip_code]);
  const vouchers = vouchersResult.rows.map(toVoucherJson);

  const pdfBuffer = await buildVoucherPdf({
    trip: toTripJson(trip),
    doer: { DoerName: doerName, Email: doerEmail },
    vouchers,
    passedBy: trip.passed_by
  });
  return pdfBuffer;
}

module.exports = { buildTripPdfBuffer, toVoucherJson, toTripJson };
