const ExcelJS = require('exceljs');
const { pool } = require('./db');

function parseDDMMYYYY(str) {
  if (!str) return null;
  const parts = str.split('-').map(Number);
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (!dd || !mm || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd);
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6653D8' } }; // matches the app's violet theme
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const CURRENCY_FMT = '#,##0';

/**
 * Builds the weekly summary report: which trips Accounts Passed within
 * the given date range, aggregated person-wise (what the boss sees),
 * plus a trip-level detail sheet underneath (Accounts' own backup).
 * Dates are matched against each trip's Passed Date, since that's when
 * the numbers are final and the "week's business" is genuinely settled.
 */
async function buildWeeklyReportBuffer(startDateStr, endDateStr) {
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  endDate.setHours(23, 59, 59, 999); // include the whole end day

  const tripsResult = await pool.query(`
    SELECT t.*, d.doer_name FROM trips t JOIN doers d ON d.doer_code = t.doer_code WHERE t.trip_status = 'Passed'
  `);
  const relevantTrips = tripsResult.rows.filter(t => {
    const passedDate = parseDDMMYYYY(t.passed_date);
    return passedDate && passedDate >= startDate && passedDate <= endDate;
  });

  const tripCodes = relevantTrips.map(t => t.trip_code);
  const vouchersByTrip = {};
  if (tripCodes.length) {
    const vRes = await pool.query('SELECT * FROM vouchers WHERE trip_code = ANY($1)', [tripCodes]);
    vRes.rows.forEach(v => {
      if (!vouchersByTrip[v.trip_code]) vouchersByTrip[v.trip_code] = [];
      vouchersByTrip[v.trip_code].push(v);
    });
  }

  // Person-wise aggregation - the numbers the boss actually wants to see.
  const byDoer = {};
  const tripDetails = [];
  relevantTrips.forEach(t => {
    const voucherTotal = (vouchersByTrip[t.trip_code] || []).reduce((s, v) => s + Number(v.amount), 0);
    const advance = Number(t.advance_received || 0);
    const settlement = voucherTotal - advance; // positive = company owes Doer, negative = Doer owes company
    const reimbursementPaid = settlement > 0 ? settlement : 0;
    const unspentAmount = settlement < 0 ? -settlement : 0;
    // Only count as "confirmed returned" if Accounts actually said so
    // at Pass time - a bare calculated figure isn't the same as money
    // Accounts has genuinely collected back.
    const confirmedReturned = unspentAmount > 0 && t.advance_returned === 'Y' ? unspentAmount : 0;
    const stillOutstanding = unspentAmount > 0 && t.advance_returned !== 'Y' ? unspentAmount : 0;

    if (!byDoer[t.doer_code]) {
      byDoer[t.doer_code] = {
        doerName: t.doer_name, doerCode: t.doer_code, trips: 0,
        advanceDisbursed: 0, totalExpenses: 0, reimbursementPaid: 0, confirmedReturned: 0, stillOutstanding: 0
      };
    }
    const d = byDoer[t.doer_code];
    d.trips += 1;
    d.advanceDisbursed += advance;
    d.totalExpenses += voucherTotal;
    d.reimbursementPaid += reimbursementPaid;
    d.confirmedReturned += confirmedReturned;
    d.stillOutstanding += stillOutstanding;

    let returnStatus = 'N/A - nothing left over';
    if (unspentAmount > 0) {
      returnStatus = t.advance_returned === 'Y' ? 'Confirmed Returned' : 'Not Yet Returned';
    }
    tripDetails.push({
      tripCode: t.trip_code, doerName: t.doer_name, location: t.location_visited,
      passedDate: t.passed_date, advance, vouchers: voucherTotal,
      settlement: settlement === 0 ? 'Fully settled'
        : (settlement < 0 ? `${t.doer_name} owes Rs. ${Math.abs(settlement).toLocaleString('en-IN')}` : `Company owes Rs. ${settlement.toLocaleString('en-IN')}`),
      returnStatus
    });
  });

  const doerRows = Object.values(byDoer).sort((a, b) => a.doerName.localeCompare(b.doerName));
  const totals = doerRows.reduce((acc, d) => ({
    trips: acc.trips + d.trips,
    advanceDisbursed: acc.advanceDisbursed + d.advanceDisbursed,
    totalExpenses: acc.totalExpenses + d.totalExpenses,
    reimbursementPaid: acc.reimbursementPaid + d.reimbursementPaid,
    confirmedReturned: acc.confirmedReturned + d.confirmedReturned,
    stillOutstanding: acc.stillOutstanding + d.stillOutstanding
  }), { trips: 0, advanceDisbursed: 0, totalExpenses: 0, reimbursementPaid: 0, confirmedReturned: 0, stillOutstanding: 0 });

  // ---------- Build the Excel workbook ----------
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Elkay Vouchering';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Doer', key: 'doerName', width: 22 },
    { header: 'Doer Code', key: 'doerCode', width: 12 },
    { header: 'Trips Passed', key: 'trips', width: 14 },
    { header: 'Advance Disbursed (Rs.)', key: 'advanceDisbursed', width: 22 },
    { header: 'Total Expenses (Rs.)', key: 'totalExpenses', width: 20 },
    { header: 'Reimbursement Paid (Rs.)', key: 'reimbursementPaid', width: 24 },
    { header: 'Advance Returned - Confirmed (Rs.)', key: 'confirmedReturned', width: 30 },
    { header: 'Advance Outstanding - Not Returned (Rs.)', key: 'stillOutstanding', width: 34 }
  ];
  summarySheet.getRow(1).font = HEADER_FONT;
  summarySheet.getRow(1).fill = HEADER_FILL;
  doerRows.forEach(d => summarySheet.addRow(d));
  const totalsRow = summarySheet.addRow({ doerName: 'TOTAL', doerCode: '', ...totals });
  totalsRow.font = { bold: true };
  ['advanceDisbursed', 'totalExpenses', 'reimbursementPaid', 'confirmedReturned', 'stillOutstanding'].forEach(key => {
    summarySheet.getColumn(key).numFmt = CURRENCY_FMT;
  });
  // Flag rows with real outstanding money in amber, so it visually jumps out
  doerRows.forEach((d, i) => {
    if (d.stillOutstanding > 0) {
      summarySheet.getRow(i + 2).getCell('stillOutstanding').font = { bold: true, color: { argb: 'FFB5460A' } };
    }
  });

  const detailSheet = workbook.addWorksheet('Trip Detail');
  detailSheet.columns = [
    { header: 'Trip Code', key: 'tripCode', width: 14 },
    { header: 'Doer', key: 'doerName', width: 20 },
    { header: 'Location', key: 'location', width: 18 },
    { header: 'Passed Date', key: 'passedDate', width: 14 },
    { header: 'Advance (Rs.)', key: 'advance', width: 14 },
    { header: 'Vouchers Total (Rs.)', key: 'vouchers', width: 18 },
    { header: 'Settlement', key: 'settlement', width: 28 },
    { header: 'Advance Return Status', key: 'returnStatus', width: 22 }
  ];
  detailSheet.getRow(1).font = HEADER_FONT;
  detailSheet.getRow(1).fill = HEADER_FILL;
  tripDetails.forEach(t => detailSheet.addRow(t));
  ['advance', 'vouchers'].forEach(key => { detailSheet.getColumn(key).numFmt = CURRENCY_FMT; });
  // Same amber flag on the detail rows that are still outstanding
  tripDetails.forEach((t, i) => {
    if (t.returnStatus === 'Not Yet Returned') {
      detailSheet.getRow(i + 2).getCell('returnStatus').font = { bold: true, color: { argb: 'FFB5460A' } };
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, doerRows, totals, tripCount: relevantTrips.length };
}

module.exports = { buildWeeklyReportBuffer };
