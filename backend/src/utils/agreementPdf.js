// ---------------------------------------------------------------------------
// THE SIGNED AGREEMENT AS A PDF (pdfkit, already a dependency).
//
//   pages 1…n   the agreement text exactly as stored on the client record —
//               the text that was sent, read and signed (it cannot be
//               regenerated once signed; voiding clears the signatures)
//   execution   both parties' signatures and stamps, names, dates
//   certificate the audit trail of the signing: sent (channels), opened,
//               OK-Proceed, signature method, OTP sent (channel, masked
//               destination), OTP verified, countersigned, activated
//
// Rendered on request from the stored record and images, so there is no
// second copy that could disagree with the record. Access is checked by the
// route (utils/agreementSigning.js agreementAccess).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const attachments = require('./attachments');

const NAVY = '#1f2a44';
const MUTED = '#5b6474';
const LOGO = path.resolve(__dirname, '../../../frontend/src/assets/teamlink-full-logo.png');

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  }) + ' IST';
}

// A stored image as a PNG/JPEG buffer pdfkit can draw (webp is converted).
async function imageBuffer(stored) {
  if (!stored) return null;
  const file = attachments.resolveStored(stored);
  if (!file || !fs.existsSync(file)) return null;
  if (/\.(png|jpe?g)$/i.test(file)) return fs.readFileSync(file);
  if (/\.webp$/i.test(file)) {
    try {
      // eslint-disable-next-line global-require
      const sharp = require('sharp');
      return await sharp(file).png().toBuffer();
    } catch { return null; }
  }
  return null;
}

// pdfkit's built-in fonts are WinAnsi: map the few characters outside it
// rather than print garbage.
function pdfText(v) {
  return String(v == null ? '' : v)
    .replace(/→/g, '->').replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x00-\xFF•—–…€]/g, '');
}

const HEADING =/^(\d+\.\s+[A-Z][A-Z &/,'-]+|RECITALS|SCHEDULE A|PERMANENT STAFFING.*AGREEMENT|NOW THEREFORE.*)$/;

// `trail` = [{ at, event, detail }]
async function renderAgreementPdf(client, { trail = [], consultantName }, out) {
  const [cSign, cStamp, kSign, kStamp] = await Promise.all([
    imageBuffer(client.agreementClientSignFile), imageBuffer(client.agreementClientStampFile),
    imageBuffer(client.agreementCompanySignFile), imageBuffer(client.agreementCompanyStampFile),
  ]);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 62, right: 62 },
    bufferPages: true,
    info: {
      Title: `Service Agreement ${client.agreementId || ''} — ${client.name}`.trim(),
      Author: consultantName || 'TeamLink Consultants',
      Subject: 'Recruitment / Staffing Services Agreement',
    },
  });
  doc.pipe(out);
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  if (fs.existsSync(LOGO)) {
    try { doc.image(LOGO, doc.page.margins.left, 30, { height: 26 }); } catch { /* optional */ }
  }

  // --- The agreement text ---------------------------------------------------
  doc.moveDown(0.5);
  pdfText(client.agreementDocument).split('\n').forEach((line) => {
    const t = line.replace(/\s+$/, '');
    if (!t) { doc.moveDown(0.45); return; }
    if (HEADING.test(t.trim())) {
      doc.moveDown(0.2).font('Helvetica-Bold').fontSize(t.startsWith('PERMANENT') ? 12.5 : 10.5).fillColor(NAVY).text(t.trim(), { width, align: t.startsWith('PERMANENT') ? 'center' : 'left' });
      doc.moveDown(0.15);
      return;
    }
    // The table in Schedule A is space-aligned; keep it monospaced.
    const mono = /^ {4,}\S/.test(line);
    doc.font(mono ? 'Courier' : 'Times-Roman').fontSize(mono ? 9 : 10.5).fillColor('#111').text(mono ? line : t, { width, align: mono ? 'left' : 'justify', lineGap: 1.5 });
  });

  // --- Execution --------------------------------------------------------------
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Execution', { width });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`Agreement ${client.agreementId || '—'} between ${client.legalName || client.name} (Client) and ${consultantName || 'TeamLink Consultants'} (Consultant).`, { width });
  doc.moveDown(1);

  const colW = (width - 24) / 2;
  const top = doc.y;
  const column = (x, title, { sign, stamp, name, title2, at, method }) => {
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(title, x, top, { width: colW });
    let y = top + 20;
    doc.rect(x, y, colW, 86).strokeColor('#d5dbe5').lineWidth(0.8).stroke();
    if (sign) { try { doc.image(sign, x + 8, y + 8, { fit: [colW - 16, 70], align: 'center', valign: 'center' }); } catch { /* unreadable image */ } } else {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text('Not signed', x + 8, y + 36, { width: colW - 16, align: 'center' });
    }
    y += 94;
    if (stamp) {
      try { doc.image(stamp, x, y, { fit: [90, 70] }); } catch { /* unreadable image */ }
      y += 76;
    }
    doc.font('Helvetica').fontSize(9.5).fillColor('#111');
    [['Name', name], ['Designation', title2], ['Signed', at ? fmt(at) : '—'], ['Signature', method]].forEach(([k, v]) => {
      doc.font('Helvetica-Bold').text(`${k}: `, x, y, { continued: true, width: colW }).font('Helvetica').text(pdfText(v || '—'), { width: colW });
      y = doc.y + 2;
    });
    return y;
  };
  const y1 = column(doc.page.margins.left, `For ${consultantName || 'TeamLink Consultants'}`, {
    sign: kSign, stamp: kStamp, name: client.agreementCompanySignedBy, title2: 'Authorised Signatory',
    at: client.agreementCompanySealedAt, method: client.agreementCompanySignName,
  });
  const y2 = column(doc.page.margins.left + colW + 24, `For ${client.legalName || client.name}`, {
    sign: cSign, stamp: cStamp, name: client.agreementSignedBy, title2: client.agreementSignedByTitle,
    at: client.agreementSignedAt, method: client.agreementClientSignName,
  });
  doc.x = doc.page.margins.left;
  doc.y = Math.max(y1, y2) + 18;

  // --- Certificate --------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Certificate of electronic execution', doc.page.margins.left, doc.y, { width });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    client.agreementVerifiedAt
      ? pdfText(`The Client's signatory confirmed this signature with a one-time code sent by ${client.agreementVerifyMobile || 'the registered contact'} and entered on ${fmt(client.agreementVerifiedAt)}.`)
      : 'The Client\'s signature has not been confirmed with a one-time code.',
    { width },
  );
  doc.moveDown(0.6);
  trail.forEach((row) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const yy = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(fmt(row.at), doc.page.margins.left, yy, { width: 120 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111').text(pdfText(row.event), doc.page.margins.left + 124, yy, { width: width - 124 });
    if (row.detail) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(row.detail), doc.page.margins.left + 124, doc.y, { width: width - 124 });
    doc.moveDown(0.35);
  });

  // --- Footer on every page -------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 40;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`${client.agreementId || ''} · ${client.name} · Private & Confidential`, doc.page.margins.left, bottom, { width: width / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.margins.left + width / 2, bottom, { width: width / 2, align: 'right', lineBreak: false });
  }
  doc.end();
}

module.exports = { renderAgreementPdf };
