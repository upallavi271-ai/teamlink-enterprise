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
  // Small (<= 600 px) whatever was uploaded, so the PDF stays light (2026-10-05).
  // eslint-disable-next-line global-require
  const { shrinkBuffer } = require('./imageShrink');
  if (/\.(png|jpe?g)$/i.test(file)) return shrinkBuffer(fs.readFileSync(file));
  if (/\.webp$/i.test(file)) {
    try {
      // eslint-disable-next-line global-require
      const sharp = require('sharp');
      return await shrinkBuffer(await sharp(file).png().toBuffer());
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
// agreementOnly: just the agreement pages (sent to eMudhra to sign) — no
// Execution / certificate page, which is kept as our separate appendix.
async function renderAgreementPdf(client, { trail = [], consultantName, agreementOnly = false }, out) {
  let [cSign, cStamp, kSign, kStamp] = await Promise.all([
    imageBuffer(client.agreementClientSignFile), imageBuffer(client.agreementClientStampFile),
    imageBuffer(client.agreementCompanySignFile), imageBuffer(client.agreementCompanyStampFile),
  ]);
  // eslint-disable-next-line global-require
  const vendorDoc = require('./vendorAgreement').isVendorDocument(client.agreementDocument);
  // TeamLink's signer (Agreement settings): name / designation where the record has none.
  // eslint-disable-next-line global-require
  const us = await require('./agreement').consultantParty();
  const doc = new PDFDocument({
    size: 'A4',
    // The Vendor Services Agreement keeps the Word document's 1-inch margins.
    margins: vendorDoc ? { top: 72, bottom: 72, left: 72, right: 72 } : { top: 64, bottom: 64, left: 62, right: 62 },
    bufferPages: true,
    info: {
      Title: `Service Agreement ${client.agreementId || ''} — ${client.name}`.trim(),
      Author: consultantName || 'TeamLink Consultants',
      Subject: 'Recruitment / Staffing Services Agreement',
    },
  });
  doc.pipe(out);
  // Each image embedded ONCE: an opened image object is reused on every page
  // it is drawn on (the signature block and the Execution page).
  const once = (b) => { try { return b ? doc.openImage(b) : null; } catch { return null; } };
  [cSign, cStamp, kSign, kStamp] = [once(cSign), once(cStamp), once(kSign), once(kStamp)];
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  if (!vendorDoc && fs.existsSync(LOGO)) {
    try { doc.image(LOGO, doc.page.margins.left, 30, { height: 26 }); } catch { /* optional */ }
  }

  // --- The agreement text ---------------------------------------------------
  // The Vendor Services Agreement: drawn like the Word document, signature
  // block filled from the record (utils/vendorAgreementPdf.js).
  // eslint-disable-next-line global-require
  if (vendorDoc) {
    // eslint-disable-next-line global-require
    require('./vendorAgreementPdf').renderVendorText(doc, client, { cSign, kSign, cStamp, kStamp, pdfText, teamlinkName: us.signatoryName, teamlinkTitle: us.signatoryTitle });
  }
  doc.moveDown(0.5);
  (vendorDoc ? '' : pdfText(client.agreementDocument)).split('\n').forEach((line) => {
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

  if (!agreementOnly) {
  // --- Execution --------------------------------------------------------------
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Execution', { width });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`Agreement ${client.agreementId || '—'} between ${client.legalName || client.name} (Client) and ${consultantName || 'TeamLink Consultants'} (Consultant).`, { width });
  doc.moveDown(1);

  const colW = (width - 24) / 2;
  const top = doc.y;
  const column = (x, title, { sign, stamp, name, title2, at, method, typed }) => {
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(title, x, top, { width: colW });
    let y = top + 20;
    doc.rect(x, y, colW, 86).strokeColor('#d5dbe5').lineWidth(0.8).stroke();
    if (sign) { try { doc.image(sign, x + 8, y + 8, { fit: [colW - 16, 70], align: 'center', valign: 'center' }); } catch { /* unreadable image */ } } else if (typed) {
      // "I agree and sign" on the agreement link: the typed name is the signature.
      doc.font('Times-Italic').fontSize(20).fillColor('#111').text(pdfText(typed), x + 8, y + 22, { width: colW - 16, align: 'center' });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('Signed electronically, confirmed by email code', x + 8, y + 60, { width: colW - 16, align: 'center' });
    } else {
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
    sign: kSign, stamp: kStamp, name: client.agreementCompanySignedBy, title2: us.signatoryTitle || 'Authorised Signatory',
    at: client.agreementCompanySealedAt, method: client.agreementCompanySignName,
  });
  const y2 = column(doc.page.margins.left + colW + 24, `For ${client.legalName || client.name}`, {
    sign: cSign, stamp: cStamp, name: client.agreementSignedBy, title2: client.agreementSignedByTitle,
    typed: !cSign && client.agreementClientSealedAt && client.agreementVerifiedAt ? client.agreementSignedBy : null,
    at: client.agreementSignedAt, method: client.agreementClientSignName,
  });
  doc.x = doc.page.margins.left;
  doc.y = Math.max(y1, y2) + 18;

  // --- Certificate --------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Certificate of electronic execution', doc.page.margins.left, doc.y, { width });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    client.agreementVerifiedAt
      ? pdfText(`The Client's signatory confirmed this signature with a one-time code sent by ${client.agreementVerifyMobile || 'the registered contact'} and entered on ${fmt(client.agreementVerifiedAt)}.${client.agreementVerifyNote ? ` ${client.agreementVerifyNote}.` : ''}`)
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

  }
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

// imageBuffer / pdfText / fmt are reused by utils/offerPdf.js (B3 offer letters).
module.exports = { renderAgreementPdf, imageBuffer, pdfText, fmt, LOGO };
