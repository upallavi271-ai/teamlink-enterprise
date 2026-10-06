// ---------------------------------------------------------------------------
// CREDIT NOTE / DEBIT NOTE PDF (B2) — A4 portrait, laid out like the printable
// tax invoice: letterhead, "Issued to", the note's own number and date, the
// original invoice it is against, the line with its CGST + SGST or IGST split,
// totals, the TDS effect, the effect on the invoice balance, amount in words.
// Drawn from the SAME payload the screen reads (routes/creditNotes.js
// noteDocument), so the paper never disagrees with the register.
// A Draft prints a "DRAFT — not issued" band.
// ---------------------------------------------------------------------------
const fs = require('fs');
const PDFDocument = require('pdfkit');

const FONT_CANDIDATES = [
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  ['C:/Windows/Fonts/georgia.ttf', 'C:/Windows/Fonts/georgiab.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
];
function pickFonts(doc) {
  const pair = FONT_CANDIDATES.find(([r, b]) => fs.existsSync(r) && fs.existsSync(b));
  if (pair) {
    try {
      doc.registerFont('CN', pair[0]);
      doc.registerFont('CN-Bold', pair[1]);
      return { regular: 'CN', bold: 'CN-Bold', rupee: '₹' };
    } catch { /* built-in faces below */ }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', rupee: 'Rs.' };
}
const n2 = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)}` : (s || '—'));

function renderNote(d, out) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: { Title: `${d.title} ${d.number}`, Author: d.company.legalName, Subject: `${d.title} against invoice ${d.invoice.number}` },
  });
  doc.pipe(out);
  const F = pickFonts(doc);
  const Rs = F.rupee;
  const X = 40;
  const W = doc.page.width - 2 * X;
  let y = 40;
  const text = (t, x, yy, opt = {}) => {
    doc.font(opt.bold ? F.bold : F.regular).fontSize(opt.size || 9.5).fillColor(opt.color || '#111');
    doc.text(String(t == null ? '' : t), x, yy, { width: opt.width, align: opt.align || 'left', lineBreak: opt.lineBreak !== false });
  };
  const hline = (yy, w = 0.7) => doc.lineWidth(w).strokeColor('#222').moveTo(X, yy).lineTo(X + W, yy).stroke();

  if (d.draft) {
    doc.rect(X, y - 18, W, 16).fill('#fde8e8');
    text('DRAFT — not issued yet. Not valid as a credit / debit note until an approver issues it.', X + 6, y - 15, { size: 8.5, bold: true, color: '#b42318', width: W - 12 });
  }

  // Letterhead + title
  const co = d.company;
  text(co.legalName, X, y, { size: 14, bold: true, width: W * 0.62 });
  let cy = doc.y + 2;
  co.addressLines.forEach((a) => { text(a, X, cy, { size: 8.5, width: W * 0.62 }); cy = doc.y; });
  text(`GSTIN ${co.gstin || '—'}${co.pan ? `  ·  PAN ${co.pan}` : ''}`, X, cy + 1, { size: 8.5, width: W * 0.62 });
  cy = doc.y;
  if (co.email || co.phone) { text([co.email, co.phone].filter(Boolean).join('  ·  '), X, cy, { size: 8.5, width: W * 0.62 }); cy = doc.y; }
  text(d.title, X + W * 0.6, y, { size: 16, bold: true, width: W * 0.4, align: 'right' });
  text('Original for recipient', X + W * 0.6, y + 22, { size: 8, width: W * 0.4, align: 'right', color: '#555' });
  y = Math.max(cy, y + 40) + 8;
  hline(y, 1.2);
  y += 8;

  // Issued to + meta
  const top = y;
  text('Issued to', X, y, { size: 8, color: '#555' });
  text(d.client.name, X, y + 11, { bold: true, size: 10.5, width: W * 0.5 });
  let by = doc.y;
  d.client.addressLines.forEach((a) => { text(a, X, by, { size: 8.5, width: W * 0.5 }); by = doc.y; });
  text(`GSTIN: ${d.client.gstin || 'Not registered'}`, X, by + 1, { size: 8.5, width: W * 0.5 });
  by = doc.y;
  text(`State: ${d.clientState || '—'}`, X, by, { size: 8.5, width: W * 0.5 });
  by = doc.y;

  const meta = [
    [`${d.short} no.`, d.number],
    [`${d.short} date`, dmy(d.noteDate)],
    ['Against invoice', d.invoice.number],
    ['Invoice date', dmy(d.invoice.date)],
    ['Place of supply', d.placeOfSupply || '—'],
    ['Supply type', d.supplyType],
    ['Reason', d.reasonLabel],
  ];
  let my = top;
  meta.forEach(([k, v]) => {
    text(k, X + W * 0.55, my, { size: 8.5, color: '#444', width: W * 0.17 });
    text(v, X + W * 0.72, my, { size: 8.5, bold: true, width: W * 0.28 });
    my = Math.max(doc.y, my + 12);
  });
  y = Math.max(by, my) + 10;

  // The line table
  const inter = d.gstType === 'IGST';
  const gstOn = d.gstType !== 'NONE';
  const cols = gstOn
    ? (inter
      ? [['#', 0.05], ['Description', 0.43], ['SAC', 0.1], ['Taxable value', 0.14], [`IGST ${d.gstPercent}%`, 0.13], ['Amount', 0.15]]
      : [['#', 0.05], ['Description', 0.35], ['SAC', 0.09], ['Taxable value', 0.13], [`CGST ${d.halfPct}%`, 0.12], [`SGST ${d.halfPct}%`, 0.12], ['Amount', 0.14]])
    : [['#', 0.05], ['Description', 0.56], ['SAC', 0.11], ['Taxable value', 0.14], ['Amount', 0.14]];
  const xs = [];
  let cx = X;
  cols.forEach(([, f]) => { xs.push(cx); cx += f * W; });
  doc.rect(X, y, W, 18).fill('#e8e8e8');
  cols.forEach(([h, f], i) => text(h, xs[i] + 4, y + 5, { size: 8.5, bold: true, width: f * W - 8, align: i >= 3 ? 'right' : 'left' }));
  y += 18;
  const l = d.line;
  const cells = gstOn
    ? (inter
      ? ['1', null, l.sac, n2(l.base), n2(l.igst), n2(l.base + l.gst)]
      : ['1', null, l.sac, n2(l.base), n2(l.cgst), n2(l.sgst), n2(l.base + l.gst)])
    : ['1', null, l.sac, n2(l.base), n2(l.base)];
  const rowTop = y;
  text(l.title, xs[1] + 4, y + 5, { size: 9, bold: true, width: cols[1][1] * W - 8 });
  text(l.detail, xs[1] + 4, doc.y + 1, { size: 8, width: cols[1][1] * W - 8, color: '#333' });
  const rowH = Math.max(28, doc.y - rowTop + 6);
  cells.forEach((c, i) => { if (c != null) text(c, xs[i] + 4, rowTop + 5, { size: 9, width: cols[i][1] * W - 8, align: i >= 3 ? 'right' : 'left' }); });
  doc.lineWidth(0.6).strokeColor('#222').rect(X, rowTop - 18, W, rowH + 18).stroke();
  y = rowTop + rowH + 12;

  // Totals (right) + words / effect (left)
  const tx = X + W * 0.55;
  const tw = W * 0.45;
  const tot = [
    ['Taxable value', `${Rs} ${n2(d.totals.base)}`],
    ...(gstOn ? (inter ? [[`IGST @ ${d.gstPercent}%`, `${Rs} ${n2(d.totals.igst)}`]] : [[`CGST @ ${d.halfPct}%`, `${Rs} ${n2(d.totals.cgst)}`], [`SGST @ ${d.halfPct}%`, `${Rs} ${n2(d.totals.sgst)}`]]) : []),
    [`${d.short} total`, `${Rs} ${n2(d.totals.gross)}`, true],
    ...(d.totals.tds > 0.005 ? [[`Less: TDS effect @ ${d.tdsPercent}%`, `− ${Rs} ${n2(d.totals.tds)}`]] : []),
    [d.kind === 'debit' ? 'Added to the net receivable' : 'Net receivable reduced by', `${Rs} ${n2(d.totals.net)}`, true],
  ];
  let ty = y;
  tot.forEach(([k, v, b]) => {
    text(k, tx, ty, { size: 9, bold: !!b, width: tw * 0.62 });
    text(v, tx + tw * 0.6, ty, { size: 9, bold: !!b, width: tw * 0.4, align: 'right' });
    ty += 15;
  });
  let ly = y;
  text(`${d.short} total in words`, X, ly, { size: 8, color: '#555' });
  text(d.words, X, ly + 10, { size: 9, bold: true, width: W * 0.5 });
  ly = doc.y + 8;
  text('Effect on the invoice', X, ly, { size: 8, color: '#555' });
  ly += 11;
  d.effect.forEach(([k, v]) => {
    text(k, X, ly, { size: 8.5, width: W * 0.32 });
    text(`${Rs} ${n2(v)}`, X + W * 0.32, ly, { size: 8.5, width: W * 0.18, align: 'right' });
    ly += 12;
  });
  if (d.refundDue > 0.005) {
    text(`Refund due to the client: ${Rs} ${n2(d.refundDue)}${d.refundPaidOn ? ` — paid ${dmy(d.refundPaidOn)}` : ''}`, X, ly + 2, { size: 9, bold: true, width: W * 0.5, color: '#b42318' });
    ly = doc.y + 4;
  }
  if (d.reasonText) {
    text(`Note: ${d.reasonText}`, X, ly + 2, { size: 8.5, width: W * 0.5 });
    ly = doc.y;
  }
  y = Math.max(ty, ly) + 26;

  // Signatory
  text(`For ${co.legalName}`, X + W * 0.6, y, { size: 9, width: W * 0.4, align: 'right' });
  doc.lineWidth(0.5).strokeColor('#222').moveTo(X + W * 0.68, y + 40).lineTo(X + W, y + 40).stroke();
  text('Authorised Signatory', X + W * 0.6, y + 44, { size: 9, bold: true, width: W * 0.4, align: 'right' });
  if (d.approvedBy) text(`Issued by ${d.approvedBy}${d.issuedOn ? ` on ${dmy(d.issuedOn)}` : ''}`, X, y + 44, { size: 8, color: '#555', width: W * 0.55 });
  text(`This is a computer-generated ${d.title.toLowerCase()} from TeamLink Accounts. SAC ${l.sac}: permanent placement services.`, X, y + 70, { size: 7.5, color: '#666', width: W, align: 'center' });
  doc.end();
}

module.exports = { renderNote };
