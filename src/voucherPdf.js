const PDFDocument = require('pdfkit');
const path = require('path');

const LOGO_IMG = path.join(__dirname, 'assets', 'elkay-logo.png');

const MARGIN = 36;
const PAGE_WIDTH = 595.28; // A4 in points
const LOGO_GUTTER = 95; // reserved space on the right for the logo, alongside the top field grid
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2 - LOGO_GUTTER;
const FULL_WIDTH = PAGE_WIDTH - MARGIN * 2; // used below the grid, where the logo no longer applies

const LABEL_COLOR = '#8a1f1f';   // dark red/maroon, matching the reference's field labels
const VALUE_COLOR = '#1a3f7a';   // blue, matching the reference's field values
const BORDER_COLOR = '#000000';
const NOTE_COLOR = '#b5460a';    // orange/red, matching the "Important Note" footer

function box(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke(BORDER_COLOR);
}

/** A single bordered row split into label/value pairs across N columns. */
function fieldRow(doc, y, height, columns, width) {
  width = width || CONTENT_WIDTH;
  const colWidth = width / columns.length;
  columns.forEach((col, i) => {
    const x = MARGIN + i * colWidth;
    box(doc, x, y, colWidth, height);
    const labelWidth = col.labelWidth || colWidth * 0.4;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(LABEL_COLOR)
      .text(col.label, x + 6, y + height / 2 - 5, { width: labelWidth - 10, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(VALUE_COLOR)
      .text(col.value || '', x + labelWidth, y + height / 2 - 5, { width: colWidth - labelWidth - 8, lineBreak: false });
  });
  doc.fillColor('#000000');
  return y + height;
}

function centeredBar(doc, y, height, text, subtext, width) {
  width = width || CONTENT_WIDTH;
  box(doc, MARGIN, y, width, height);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#000000')
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

    // Logo, sized to fit its reserved gutter without overlapping the grid
    try { doc.image(LOGO_IMG, PAGE_WIDTH - MARGIN - LOGO_GUTTER + 5, MARGIN, { width: LOGO_GUTTER - 10 }); } catch (e) { /* logo optional */ }

    let y = MARGIN;
    y = centeredBar(doc, y, 22, 'PETTY CASH VOUCHER');
    y = centeredBar(doc, y, 18, 'Travel & Expense Reimbursement');

    y = fieldRow(doc, y, 20, [
      { label: 'Initiated By', value: trip.InitiatedBy || '—' },
      { label: 'Vertical', value: trip.Vertical || '—' }
    ]);
    y = fieldRow(doc, y, 20, [
      { label: 'Voucher No.', value: trip.TripCode },
      { label: 'Trip Start Date', value: trip.StartDate }
    ]);
    y = fieldRow(doc, y, 20, [
      { label: 'Employee', value: doer.DoerName },
      { label: 'Trip End Date', value: trip.EndDate || '—' }
    ]);
    y = fieldRow(doc, y, 20, [
      { label: 'Email', value: doer.Email || '—' },
      { label: 'Purpose of Visit', value: trip.PurposeOfVisit }
    ]);
    y = fieldRow(doc, y, 20, [
      { label: 'State / City', value: trip.LocationVisited },
      { label: 'Status', value: trip.TripStatus }
    ]);

    y += 4;
    y = centeredBar(doc, y, 18, 'Advance Received: Rs. ' + Number(trip.AdvanceReceived).toLocaleString('en-IN'), null, FULL_WIDTH);

    y += 4;
    y = centeredBar(doc, y, 18, 'Receipt Submitted for the Value', null, FULL_WIDTH);

    // Voucher table
    const colWidths = { date: 75, desc: FULL_WIDTH - 75 - 100, amount: 100 };
    const rowH = 16;
    box(doc, MARGIN, y, FULL_WIDTH, rowH);
    doc.moveTo(MARGIN + colWidths.date, y).lineTo(MARGIN + colWidths.date, y + rowH).stroke();
    doc.moveTo(MARGIN + colWidths.date + colWidths.desc, y).lineTo(MARGIN + colWidths.date + colWidths.desc, y + rowH).stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000');
    doc.text('Date', MARGIN + 4, y + 4, { width: colWidths.date - 8 });
    doc.text('Description', MARGIN + colWidths.date + 4, y + 4, { width: colWidths.desc - 8 });
    doc.text('Amount (Rs.)', MARGIN + colWidths.date + colWidths.desc + 4, y + 4, { width: colWidths.amount - 8, align: 'right' });
    y += rowH;

    doc.font('Helvetica').fontSize(8.5);
    vouchers.forEach(v => {
      box(doc, MARGIN, y, FULL_WIDTH, rowH);
      doc.moveTo(MARGIN + colWidths.date, y).lineTo(MARGIN + colWidths.date, y + rowH).stroke();
      doc.moveTo(MARGIN + colWidths.date + colWidths.desc, y).lineTo(MARGIN + colWidths.date + colWidths.desc, y + rowH).stroke();
      doc.fillColor(VALUE_COLOR);
      doc.text(v.DateTime || '—', MARGIN + 4, y + 4, { width: colWidths.date - 8 });
      doc.text(v.Description || v.ExpenseType || '—', MARGIN + colWidths.date + 4, y + 4, { width: colWidths.desc - 8 });
      doc.text(Number(v.Amount).toLocaleString('en-IN'), MARGIN + colWidths.date + colWidths.desc + 4, y + 4, { width: colWidths.amount - 8, align: 'right' });
      doc.fillColor('#000000');
      y += rowH;
    });

    // Note / Final amount row
    const noteWidth = FULL_WIDTH * 0.62;
    const finalWidth = FULL_WIDTH - noteWidth;
    const noteRowH = 26;
    box(doc, MARGIN, y, noteWidth, noteRowH);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(LABEL_COLOR).text('Receipt not received for / Note:', MARGIN + 5, y + 4, { width: noteWidth - 10 });
    doc.font('Helvetica').fontSize(8.5).fillColor(VALUE_COLOR).text(trip.ReceiptNotReceivedFor || '', MARGIN + 5, y + 14, { width: noteWidth - 10 });

    box(doc, MARGIN + noteWidth, y, finalWidth, noteRowH);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(LABEL_COLOR).text('Final Amount Due to Pay', MARGIN + noteWidth + 5, y + 4, { width: finalWidth - 10 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(finalDue < 0 ? '#b02a2a' : '#1a3f7a')
      .text('Rs. ' + finalDue.toLocaleString('en-IN'), MARGIN + noteWidth + 5, y + 14, { width: finalWidth - 10 });
    doc.fillColor('#000000');
    y += noteRowH;

    // Signature row
    const sigColWidth = FULL_WIDTH / 3;
    const sigRowH = 40;
    const sigLabels = [
      { label: 'Passed By', name: passedBy || '' },
      { label: 'Approved By', name: '' },
      { label: "Recd. By", name: '' }
    ];
    sigLabels.forEach((s, i) => {
      const x = MARGIN + i * sigColWidth;
      box(doc, x, y, sigColWidth, sigRowH);
      doc.font('Helvetica').fontSize(9).fillColor('#000000').text(s.label, x + 6, y + 6);
      if (s.name) doc.font('Helvetica-Oblique').fontSize(9).text('(' + s.name + ')', x + 6, y + 20);
    });
    y += sigRowH + 10;

    // Footer notes
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NOTE_COLOR).text('Important Note:-', MARGIN, y);
    y += 13;
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
    doc.fillColor('#000000');

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
