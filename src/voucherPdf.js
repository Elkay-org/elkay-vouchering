const PDFDocument = require('pdfkit');

const MARGIN = 36;
const PAGE_WIDTH = 595.28; // A4 in points
const LOGO_GUTTER = 95; // reserved space on the right for the logo, alongside the top field grid
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2 - LOGO_GUTTER;
const FULL_WIDTH = PAGE_WIDTH - MARGIN * 2; // used below the grid, where the logo no longer applies

const TEXT_COLOR = '#000000';    // the reference uses plain black throughout - no maroon/blue
const BORDER_COLOR = '#000000';
const GREY_TITLE = '#b7b7b7';      // "PETTY CASH VOUCHER" bar
const GREY_LIGHT = '#f3f3f3';      // top spacer + "Travel & Expense Reimbursement" bar
const GREY_SECTION = '#cccccc';    // "Receipt Submitted for the Value" bar
const GREY_TABLEHEAD = '#d9d9d9';  // Date / Description / Amount header row

function box(doc, x, y, w, h, fill) {
  if (fill) doc.rect(x, y, w, h).fillAndStroke(fill, BORDER_COLOR);
  else doc.rect(x, y, w, h).stroke(BORDER_COLOR);
}

/** A single bordered row split into label/value pairs across N columns - both centered, matching the reference. */
function fieldRow(doc, y, height, columns, width) {
  width = width || CONTENT_WIDTH;
  const colWidth = width / columns.length;
  columns.forEach((col, i) => {
    const x = MARGIN + i * colWidth;
    box(doc, x, y, colWidth, height);
    const labelWidth = col.labelWidth || colWidth * 0.4;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT_COLOR)
      .text(col.label, x + 2, y + height / 2 - 5, { width: labelWidth - 4, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(TEXT_COLOR)
      .text(col.value || '', x + labelWidth, y + height / 2 - 5, { width: colWidth - labelWidth - 4, align: 'center', lineBreak: false });
  });
  doc.fillColor(TEXT_COLOR);
  return y + height;
}

function centeredBar(doc, y, height, text, subtext, width, fill) {
  width = width || CONTENT_WIDTH;
  box(doc, MARGIN, y, width, height, fill);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(TEXT_COLOR)
    .text(text, MARGIN, y + (subtext ? 5 : height / 2 - 6), { width, align: 'center' });
  if (subtext) {
    doc.font('Helvetica').fontSize(9)
      .text(subtext, MARGIN, y + 20, { width, align: 'center' });
  }
  return y + height;
}

/**
 * Builds the Petty Cash Voucher PDF for one finalized trip, matching
 * Elkay's existing paper format exactly, followed by every attached
 * receipt photo (multiple per page, compact). Vouchers with no photo
 * (marked "No receipt") are skipped here - that's already covered by
 * the "Receipt not received for / Note" field on the summary page.
 *
 * receiptImages: array of { voucherId, buffer } - the caller fetches
 * these from Drive ahead of time (in parallel) and passes them in;
 * this function never touches the network itself.
 */
function buildVoucherPdf({ trip, doer, vouchers, passedBy, accountsName, receiptImages }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const totalVouchers = vouchers.reduce((sum, v) => sum + Number(v.Amount), 0);
    const finalDue = totalVouchers - Number(trip.AdvanceReceived); // per the reference: vouchers minus advance

    let y = MARGIN;
    // Light grey spacer band across the full width, with the company
    // name (bold, capitals) centered across the whole row, one line.
    box(doc, MARGIN, y, FULL_WIDTH, 26, GREY_LIGHT);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT_COLOR)
      .text('ELKAY CORPORATION', MARGIN, y + 7, { width: FULL_WIDTH, align: 'center' });
    y += 26;

    y = centeredBar(doc, y, 20, 'PETTY CASH VOUCHER', null, FULL_WIDTH, GREY_TITLE);
    y = centeredBar(doc, y, 16, 'Travel & Expense Reimbursement', null, FULL_WIDTH, GREY_LIGHT);

    y = fieldRow(doc, y, 20, [
      { label: 'Initiated By', value: trip.InitiatedBy || '—' },
      { label: 'Vertical', value: trip.Vertical || '—' }
    ], FULL_WIDTH);
    y = fieldRow(doc, y, 20, [
      { label: 'Voucher No.', value: trip.TripCode },
      { label: 'Trip Start Date', value: trip.StartDate }
    ], FULL_WIDTH);
    y = fieldRow(doc, y, 20, [
      { label: 'Employee', value: doer.DoerName },
      { label: 'Trip End Date', value: trip.EndDate || '—' }
    ], FULL_WIDTH);
    y = fieldRow(doc, y, 20, [
      { label: 'Email', value: doer.Email || '—' },
      { label: 'Purpose of Visit', value: trip.PurposeOfVisit }
    ], FULL_WIDTH);
    y = fieldRow(doc, y, 20, [
      { label: 'State / City', value: trip.LocationVisited },
      { label: 'Status', value: trip.TripStatus }
    ], FULL_WIDTH);

    // Advance Received - its own row, two equal halves, both centered
    // (not a label/value pair like the rows above it).
    const halfWidth = FULL_WIDTH / 2;
    box(doc, MARGIN, y, halfWidth, 18);
    box(doc, MARGIN + halfWidth, y, halfWidth, 18);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT_COLOR)
      .text('Advance Received', MARGIN, y + 5, { width: halfWidth, align: 'center' });
    doc.font('Helvetica').fontSize(9)
      .text(Number(trip.AdvanceReceived).toLocaleString('en-IN'), MARGIN + halfWidth, y + 5, { width: halfWidth, align: 'center' });
    y += 18;

    y = centeredBar(doc, y, 16, 'Receipt Submitted for the Value', null, FULL_WIDTH, GREY_SECTION);

    // Voucher table
    const colWidths = { date: 75, desc: FULL_WIDTH - 75 - 100, amount: 100 };
    const rowH = 16;
    box(doc, MARGIN, y, FULL_WIDTH, rowH, GREY_TABLEHEAD);
    doc.moveTo(MARGIN + colWidths.date, y).lineTo(MARGIN + colWidths.date, y + rowH).stroke();
    doc.moveTo(MARGIN + colWidths.date + colWidths.desc, y).lineTo(MARGIN + colWidths.date + colWidths.desc, y + rowH).stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT_COLOR);
    doc.text('Date', MARGIN, y + 4, { width: colWidths.date, align: 'center' });
    doc.text('Description', MARGIN + colWidths.date, y + 4, { width: colWidths.desc, align: 'center' });
    doc.text('Amount (Rs.)', MARGIN + colWidths.date + colWidths.desc, y + 4, { width: colWidths.amount, align: 'center' });
    y += rowH;

    doc.font('Helvetica').fontSize(8.5);
    vouchers.forEach(v => {
      box(doc, MARGIN, y, FULL_WIDTH, rowH);
      doc.moveTo(MARGIN + colWidths.date, y).lineTo(MARGIN + colWidths.date, y + rowH).stroke();
      doc.moveTo(MARGIN + colWidths.date + colWidths.desc, y).lineTo(MARGIN + colWidths.date + colWidths.desc, y + rowH).stroke();
      doc.fillColor(TEXT_COLOR);
      doc.text(v.DateTime || '—', MARGIN, y + 4, { width: colWidths.date, align: 'center' });
      doc.text(v.Description || v.ExpenseType || '—', MARGIN + colWidths.date, y + 4, { width: colWidths.desc, align: 'center' });
      doc.text(Number(v.Amount).toLocaleString('en-IN'), MARGIN + colWidths.date + colWidths.desc, y + 4, { width: colWidths.amount, align: 'center' });
      y += rowH;
    });

    // Note / Final amount - two stacked rows reusing the same 3-column
    // widths as the table above, matching the reference exactly.
    const noteRowH = 24;
    box(doc, MARGIN, y, colWidths.date + colWidths.desc, noteRowH);
    box(doc, MARGIN + colWidths.date + colWidths.desc, y, colWidths.amount, noteRowH);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT_COLOR)
      .text('Receipt not received for / Note:', MARGIN, y + 4, { width: colWidths.date + colWidths.desc, align: 'center' });
    doc.font('Helvetica').fontSize(8).text(trip.ReceiptNotReceivedFor || '', MARGIN, y + 15, { width: colWidths.date + colWidths.desc - 10, align: 'center' });
    y += noteRowH;

    const finalRowH = 20;
    box(doc, MARGIN, y, colWidths.date, finalRowH);
    box(doc, MARGIN + colWidths.date, y, colWidths.desc, finalRowH);
    box(doc, MARGIN + colWidths.date + colWidths.desc, y, colWidths.amount, finalRowH);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT_COLOR)
      .text('Final Amount Due to Pay', MARGIN + colWidths.date, y + 5, { width: colWidths.desc - 6, align: 'right' });
    const dueByWhom = finalDue === 0 ? 'Fully settled' : (finalDue < 0 ? `Due from ${doer.DoerName}` : `Due to ${doer.DoerName}`);
    doc.font('Helvetica-Bold').fontSize(9.5)
      .text(Math.abs(finalDue).toLocaleString('en-IN'), MARGIN + colWidths.date + colWidths.desc, y + 3, { width: colWidths.amount, align: 'center' });
    doc.font('Helvetica-Oblique').fontSize(6.5)
      .text(dueByWhom, MARGIN + colWidths.date + colWidths.desc, y + 14, { width: colWidths.amount, align: 'center' });
    y += finalRowH;

    // Blank spacer row, matching the empty row the reference has above the signature labels
    box(doc, MARGIN, y, FULL_WIDTH, 12);
    y += 12;

    // Signature row
    const sigColWidth = FULL_WIDTH / 3;
    const sigRowH = 32;
    const sigLabels = [
      { label: 'Passed By', name: passedBy || '' },
      { label: 'Approved By', name: '' },
      { label: "Recd. By", name: '' }
    ];
    sigLabels.forEach((s, i) => {
      const x = MARGIN + i * sigColWidth;
      box(doc, x, y, sigColWidth, sigRowH);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT_COLOR).text(s.label, x, y + 5, { width: sigColWidth, align: 'center' });
      if (s.name) doc.font('Helvetica-Oblique').fontSize(9).text('(' + s.name + ')', x, y + 18, { width: sigColWidth, align: 'center' });
    });
    y += sigRowH;

    // Footer notes
    doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT_COLOR).text('Important Note:-', MARGIN, y + 6);
    y += 18;
    const notes = [
      'All Vouchers will be cleared on every Friday Only.',
      'Advance Amount will be transferred by Paytm Only.',
      'Kindly attach all the original Bills to the Petty Cash voucher, as it is mandatory for immediate Payment.'
    ];
    doc.font('Helvetica-Bold').fontSize(8);
    notes.forEach((n, i) => {
      doc.text(`${i + 1}. ${n}`, MARGIN, y, { width: FULL_WIDTH });
      y += 12;
    });
    doc.fillColor(TEXT_COLOR);

    // Receipt photo pages - multiple per page, compact grid.
    if (receiptImages && receiptImages.length) {
      addReceiptPages(doc, receiptImages, vouchers);
    }

    doc.end();
  });
}

/** Places up to 4 receipt photos per page, in a 2x2 grid with a caption under each. */
function addReceiptPages(doc, receiptImages, vouchers) {
  const PER_PAGE = 4, COLS = 2, ROWS = 2;
  const GAP = 12;
  const HEADER_H = 26;
  const gridW = FULL_WIDTH;
  const gridH = 760 - HEADER_H; // kept comfortably inside the page - pdfkit auto-paginates if content gets too close to the bottom margin
  const cellW = (gridW - GAP) / COLS;
  const cellH = (gridH - GAP) / ROWS;
  const imgH = cellH - 18; // leaves room for the caption line below each photo

  const voucherById = {};
  vouchers.forEach(v => { voucherById[v.VoucherID] = v; });

  receiptImages.forEach((r, i) => {
    if (i % PER_PAGE === 0) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Attached Receipts', MARGIN, MARGIN);
    }
    const posInPage = i % PER_PAGE;
    const col = posInPage % COLS;
    const row = Math.floor(posInPage / COLS);
    const x = MARGIN + col * (cellW + GAP);
    const y = MARGIN + HEADER_H + row * (cellH + GAP);

    // pdfkit tracks its own "current y" across calls and will silently
    // insert a page break if that tracked position looks close to the
    // bottom margin - which happens constantly in a side-by-side grid,
    // since column 2's y is often "behind" column 1's after drawing.
    // Resetting doc.y right before each positioned call keeps pdfkit's
    // bookkeeping in sync with our own grid math instead of its own.
    doc.y = y;
    doc.x = x;
    try {
      doc.image(r.buffer, x, y, { fit: [cellW, imgH], align: 'center', valign: 'center' });
    } catch (e) {
      doc.rect(x, y, cellW, imgH).stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#888').text('Could not load this photo', x, y + imgH / 2 - 5, { width: cellW, align: 'center' });
    }

    const v = voucherById[r.voucherId] || {};
    const caption = `${r.voucherId} — ${v.Description || v.ExpenseType || ''} — Rs. ${Number(v.Amount || 0).toLocaleString('en-IN')}`;
    doc.y = y + imgH + 3;
    doc.x = x;
    doc.font('Helvetica').fontSize(8).fillColor('#000000').text(caption, x, y + imgH + 3, { width: cellW, align: 'center' });
  });
}

module.exports = { buildVoucherPdf };
