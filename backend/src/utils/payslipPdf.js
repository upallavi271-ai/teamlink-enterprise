// ---------------------------------------------------------------------------
// PAYSLIP PDF — A4 portrait, one bordered table, serif (Georgia).
//
// Drawn from the SAME payload the on-screen payslip reads (routes/payroll.js
// payslipPayload), so the page and the file can never disagree about a figure.
// Layout follows the user's sample payslip:
//
//   [ logo            | Company / address                     ]
//   [ Employee Code | … | PAN Number     | … ]   8 rows, bold labels
//   [ EARNINGS                 | DEDUCTIONS                    ]
//   [ Basic … | amt            | PF … | amt                    ]
//   [ GROSS SALARY | amt       | TOTAL DEDUCTIONS | amt        ]
//   [                          | NET SALARY (Bank Transfer) | ₹ ]
//   This is a computer generated payslip, needs no signature   (blue)
//
// Georgia carries the ₹ glyph. It is read from the OS fonts folder; where it
// is missing the built-in Times faces are used and amounts print as "Rs.".
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO = path.resolve(__dirname, '../../../frontend/src/assets/teamlink-full-logo.png');

const FONT_CANDIDATES = [
  ['C:/Windows/Fonts/georgia.ttf', 'C:/Windows/Fonts/georgiab.ttf'],
  ['/usr/share/fonts/truetype/msttcorefonts/Georgia.ttf', '/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf'],
  ['C:/Windows/Fonts/times.ttf', 'C:/Windows/Fonts/timesbd.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'],
];

const INK = '#111111';
const LINE = '#222222';
const BLUE = '#1f4fa0';

function pickFonts(doc) {
  const pair = FONT_CANDIDATES.find(([r, b]) => fs.existsSync(r) && fs.existsSync(b));
  if (pair) {
    try {
      doc.registerFont('PS', pair[0]);
      doc.registerFont('PS-Bold', pair[1]);
      return { regular: 'PS', bold: 'PS-Bold', rupee: '₹' };
    } catch { /* fall through to the built-in faces */ }
  }
  return { regular: 'Times-Roman', bold: 'Times-Bold', rupee: 'Rs.' };
}

const DASH = '—';
function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function show(v) {
  return v === null || v === undefined || v === '' ? DASH : String(v);
}

// Writes the PDF for one payslip payload to `out` (an HTTP response or a file stream).
function renderPayslip(p, out) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Payslip — ${p.employee.name} — ${p.period}`,
      Author: p.company.name,
      Subject: `Payslip for ${p.period}`,
    },
  });
  doc.pipe(out);
  const F = pickFonts(doc);
  const R = F.rupee === '₹' ? '₹' : 'Rs.';

  const X = 36;
  const W = doc.page.width - 2 * X; // 523.28
  let y = 40;

  const hline = (x1, x2, yy, w = 0.8) => doc.lineWidth(w).strokeColor(LINE).moveTo(x1, yy).lineTo(x2, yy).stroke();
  const vline = (xx, y1, y2, w = 0.8) => doc.lineWidth(w).strokeColor(LINE).moveTo(xx, y1).lineTo(xx, y2).stroke();
  // One line of text, vertically centred in a cell.
  const cell = (text, x, yy, w, h, { bold = false, size = 10, align = 'left', color = INK } = {}) => {
    // Shrink, never wrap: a long value (a big amount, a long designation)
    // steps the font down until it fits its cell.
    let fsz = size;
    doc.font(bold ? F.bold : F.regular).fontSize(fsz);
    while (fsz > 6.5 && doc.widthOfString(String(text)) > w - 14) { fsz -= 0.5; doc.fontSize(fsz); }
    doc.fillColor(color);
    const th = doc.currentLineHeight();
    doc.text(text, x + 7, yy + (h - th) / 2 + 0.5, { width: w - 14, align, lineBreak: false, ellipsis: true });
  };

  const top = y;

  // --- Header: logo | Company + address ------------------------------------
  const logoW = 0.326 * W;
  const rightX = X + logoW;
  const rightW = W - logoW;
  doc.font(F.bold).fontSize(12.5);
  const companyTitle = 'Company';
  doc.font(F.regular).fontSize(10);
  const addr = p.company.address || DASH;
  const addrH = doc.heightOfString(addr, { width: rightW - 14, lineGap: 2 });
  const headH = Math.max(58, 12 + 17 + addrH + 12);
  if (fs.existsSync(LOGO)) {
    try {
      // 1600 x 335 source, embedded at full resolution and drawn at ~135pt:
      // downscaled, never upscaled, so it stays sharp at any zoom.
      const lw = Math.min(135, logoW - 30);
      const lh = lw * (335 / 1600);
      doc.image(LOGO, X + (logoW - lw) / 2, y + Math.max(8, (headH - lh) / 2 - 6), { width: lw });
    } catch { /* an unreadable logo is not worth failing a payslip over */ }
  } else {
    cell(p.company.name, X, y, logoW, headH, { bold: true, size: 13, align: 'center' });
  }
  doc.font(F.bold).fontSize(12.5).fillColor(INK).text(companyTitle, rightX + 7, y + 11, { width: rightW - 14 });
  doc.font(F.regular).fontSize(10).fillColor(INK).text(addr, rightX + 7, y + 11 + 19, { width: rightW - 14, lineGap: 2 });
  vline(rightX, y, y + headH);
  y += headH;
  hline(X, X + W, y, 1.4);

  // --- Employee grid: 8 rows x 4 columns ----------------------------------
  const cw = [0.22 * W, 0.201 * W, 0.22 * W];
  cw.push(W - cw[0] - cw[1] - cw[2]);
  const cx = [X, X + cw[0], X + cw[0] + cw[1], X + cw[0] + cw[1] + cw[2]];
  const e = p.employee;
  const grid = [
    ['Employee Code', e.employeeCode, 'PAN Number', e.panNumber],
    ['Employee Name', e.name, 'UAN Number', e.uanNumber],
    ['ESI Number', e.esiNumber, 'PF Number', e.pfNumber],
    ['Days Worked', p.daysWorked, 'LOP Days', p.lopDays],
    ['DOJ', e.dateOfJoining, 'Month', p.period],
    ['Department', e.department, 'Designation', e.designation],
    ['Location', e.location, 'Bank A/C Number', e.bankAccountNumber],
    ['Monthly Gross', `${R}${money(p.monthlyGross)}`, 'Bank Name', e.bankName],
  ];
  const rowH = 20;
  const gridTop = y;
  // A value too long for its cell (a full name, a long designation) WRAPS and
  // the row grows, as the sample's address does — it is never shrunk.
  const wrapCell = (text, x, yy, w, h, bold) => {
    doc.font(bold ? F.bold : F.regular).fontSize(10).fillColor(INK);
    const th = doc.heightOfString(text, { width: w - 14, lineGap: 1 });
    doc.text(text, x + 7, yy + (h - th) / 2 + 0.5, { width: w - 14, lineGap: 1 });
  };
  const needH = (text, w, bold) => {
    doc.font(bold ? F.bold : F.regular).fontSize(10);
    return doc.heightOfString(text, { width: w - 14, lineGap: 1 }) + 9;
  };
  grid.forEach((r, i) => {
    const cells = [[r[0], true], [show(r[1]), false], [r[2], true], [show(r[3]), false]];
    const h = Math.max(rowH, ...cells.map(([t, b], k) => needH(t, cw[k], b)));
    cells.forEach(([t, b], k) => wrapCell(t, cx[k], y, cw[k], h, b));
    y += h;
    if (i < grid.length - 1) hline(X, X + W, y);
  });
  [cx[1], cx[2], cx[3]].forEach((xx) => vline(xx, gridTop, y));
  hline(X, X + W, y, 1.4);

  // --- Earnings | Deductions ------------------------------------------------
  const half = 0.44 * W; // left half (earnings) is narrower, as in the sample
  const midX = X + half;
  const eLabelW = 0.27 * W;
  const dLabelW = 0.38 * W;
  const eAmtX = X + eLabelW;
  const dAmtX = midX + dLabelW;
  const secTop = y;
  cell('EARNINGS', X, y, half, rowH, { bold: true, align: 'center' });
  cell('DEDUCTIONS', midX, y, W - half, rowH, { bold: true, align: 'center' });
  y += rowH;
  hline(X, X + W, y);

  const n = Math.max(p.earnings.length, p.deductions.length);
  const itemsTop = y;
  if (n === 0) {
    y += 9; // the sample's empty spacer row
  } else {
    for (let i = 0; i < n; i += 1) {
      const er = p.earnings[i];
      const dr = p.deductions[i];
      if (er) { cell(er.label, X, y, eLabelW, rowH); cell(money(er.amount), eAmtX, y, half - eLabelW, rowH); }
      if (dr) { cell(dr.label, midX, y, dLabelW, rowH); cell(money(dr.amount), dAmtX, y, W - half - dLabelW, rowH); }
      y += rowH;
      if (i < n - 1) hline(X, X + W, y, 0.4);
    }
  }
  vline(eAmtX, itemsTop, y);
  vline(dAmtX, itemsTop, y);
  hline(X, X + W, y);

  // Totals
  const totH = 24;
  cell('GROSS SALARY', X, y, eLabelW, totH, { bold: true, size: 10.5 });
  cell(money(p.gross), eAmtX, y, half - eLabelW, totH, { bold: true, size: 10.5 });
  cell('TOTAL DEDUCTIONS', midX, y, dLabelW, totH, { bold: true, size: 10.5 });
  cell(money(p.totalDeductions), dAmtX, y, W - half - dLabelW, totH, { bold: true, size: 10.5 });
  vline(eAmtX, y, y + totH);
  vline(dAmtX, y, y + totH);
  y += totH;
  hline(X, X + W, y, 1.1);

  // Net salary — right half only
  const netH = 32;
  doc.font(F.bold).fontSize(10.5).fillColor(INK).text('NET SALARY', midX + 7, y + 6, { width: dLabelW - 14, lineBreak: false });
  doc.font(F.regular).fontSize(8.5).fillColor(INK).text('(Bank Transfer)', midX + 7, y + 19, { width: dLabelW - 14, lineBreak: false });
  doc.font(F.bold).fontSize(10.5).fillColor(INK).text(`${R} ${money(p.netPay)}`, dAmtX + 7, y + 6, { width: W - half - dLabelW - 14, lineBreak: false });
  vline(dAmtX, y, y + netH);
  y += netH;

  vline(midX, secTop, y);
  // Outer frame
  doc.lineWidth(1.4).strokeColor(LINE).rect(X, top, W, y - top).stroke();

  // Footer
  doc.font(F.regular).fontSize(10.5).fillColor(BLUE)
    .text('This is a computer generated payslip, needs no signature', X, y + 14, { width: W, align: 'center' });

  doc.end();
  return doc;
}

module.exports = { renderPayslip };
