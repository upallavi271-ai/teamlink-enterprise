// ---------------------------------------------------------------------------
// THE AGREEMENT AS A PDF (pdfkit, already a dependency).
//
//   pages 1…n   the agreement text exactly as stored on the client record —
//               the text that was sent, read and signed (it cannot be
//               regenerated once signed; voiding clears the signatures)
//   last page   "Execution details": place, date of execution, the optional
//               stamp-paper / e-stamp number and "This agreement consists of
//               N pages"
//   execution   both parties' signatures and stamps, names, dates
//   certificate the audit trail of the signing: sent (channels), opened,
//               OK-Proceed, signature method, OTP sent (channel, masked
//               destination), OTP verified, countersigned, activated
//
// EVERY PAGE CARRIES (2026-10-10, the user's note 5 + 6 — Indian contract
// practice: initial each page, sign and stamp the last, say how many pages):
//   header   the TeamLink logo (left) · "Agreement No. AGRnnnn" (right)
//   footer   "Agreement No. AGRnnnn · Page X of Y", the client name,
//            TeamLink's stamp + initials in the bottom-left corner and the
//            CLIENT's stamp + initials in the bottom-right corner (light empty
//            "Initial here" boxes until that side has signed), the text
//            fingerprint (SHA-256) of a signed copy, and the e-stamp number
//            when Agreement settings hold one.
//   a DRAFT (the client has not signed) has a light grey diagonal DRAFT
//   watermark, so it can never be mistaken for an executed copy.
//
// The body keeps a bottom margin of 104 pt and a top margin of 80 pt on every
// page, so neither the header nor the footer can touch the text.
//
// Rendered on request from the stored record and images, so there is no
// second copy that could disagree with the record. Access is checked by the
// route (utils/agreementSigning.js agreementAccess).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const attachments = require('./attachments');

const NAVY = '#1f2a44';
const MUTED = '#5b6474';
const LOGO = path.resolve(__dirname, '../../../frontend/src/assets/teamlink-full-logo.png');

// Page geometry (A4 = 595.28 x 841.89 pt).
const TOP_MARGIN = 80;
const BOTTOM_MARGIN = 104;
const HEADER_RULE_Y = 57;
const FOOT_ZONE = 98; // the footer starts this far above the page bottom
const PLACE_DEFAULT = 'Hyderabad';

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  }) + ' IST';
}
// dd-mm-yyyy in India time, like the agreement is dated.
function ddmmyyyyIst(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const ist = new Date(x.getTime() + 330 * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}`;
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

// THE LOGO, read once and cached (a 520 px wide PNG: sharp at 24 pt tall on
// paper, light in the file). Falls back to the original file, then to nothing.
let logoPromise = null;
function logoBuffer() {
  if (!logoPromise) {
    logoPromise = (async () => {
      if (!fs.existsSync(LOGO)) return null;
      try {
        // eslint-disable-next-line global-require
        return await require('sharp')(LOGO).resize({ width: 520, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
      } catch {
        try { return fs.readFileSync(LOGO); } catch { return null; }
      }
    })();
  }
  return logoPromise;
}

// pdfkit's built-in fonts are WinAnsi: map the few characters outside it
// rather than print garbage.
function pdfText(v) {
  return String(v == null ? '' : v)
    .replace(/→/g, '->').replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x00-\xFF•—–…€]/g, '');
}

// The fingerprint of the agreement TEXT (SHA-256 of the stored text). It is
// printed on every page of a signed copy and in full on the certificate page:
// any change to the text changes it (compare with the signed-copy audit row).
function textHash(client) {
  return crypto.createHash('sha256').update(String(client.agreementDocument || '').replace(/\r\n/g, '\n').trim()).digest('hex');
}

const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0].toUpperCase()).join('');

// Shorten a string to a width with an ellipsis.
function fitText(doc, text, width) {
  let t = pdfText(text);
  if (doc.widthOfString(t) <= width) return t;
  while (t.length > 3 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const HEADING =/^(\d+\.\s+[A-Z][A-Z &/,'-]+|RECITALS|SCHEDULE A|PERMANENT STAFFING.*AGREEMENT|NOW THEREFORE.*)$/;

// A light grey diagonal DRAFT mark over the page (very light, so the text under
// it stays fully readable). Drawn with the header and footer on every page.
function drawWatermark(doc) {
  const { x, y } = doc;
  const w = doc.page.width;
  const h = doc.page.height;
  doc.save();
  doc.rotate(-45, { origin: [w / 2, h / 2] });
  doc.fillColor('#8c96a8').opacity(0.2).font('Helvetica-Bold').fontSize(128);
  const tw = doc.widthOfString('NOT SIGNED');
  doc.text('NOT SIGNED', (w - tw) / 2, h / 2 - 62, { lineBreak: false });
  doc.restore();
  doc.x = x; doc.y = y;
}

// A lightly dashed empty box with a tiny label ("Initial here").
function emptyBox(doc, x, y, w, h, label) {
  doc.save();
  doc.lineWidth(0.5).strokeColor('#b8c0cd').dash(2, { space: 2 }).rect(x, y, w, h).stroke().undash();
  doc.font('Helvetica').fontSize(6).fillColor('#9aa3b2').text(label, x, y + h / 2 - 3, { width: w, align: 'center', lineBreak: false });
  doc.restore();
}
function imageBox(doc, img, x, y, w, h) {
  doc.save();
  doc.lineWidth(0.4).strokeColor('#d5dbe5').rect(x, y, w, h).stroke();
  try { doc.image(img, x + 2, y + 2, { fit: [w - 4, h - 4], align: 'center', valign: 'center' }); } catch { /* unreadable image */ }
  doc.restore();
}

// Header band + footer + initials/stamp boxes on every buffered page.
function drawPageChrome(doc, ctx) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const width = R - L;
  for (let i = range.start; i < range.start + total; i += 1) {
    doc.switchToPage(i);
    // The footer lives below the body's bottom margin: no automatic page break.
    doc.page.margins.bottom = 0;
    const H = doc.page.height;

    if (ctx.draft) drawWatermark(doc);

    // ---- header ----
    if (ctx.logo) { try { doc.image(ctx.logo, L, 24, { height: 24 }); } catch { /* optional */ } }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY)
      .text(`Agreement No. ${ctx.agreementId}`, L + 130, 26, { width: width - 130, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(ctx.draft ? '#9a6700' : MUTED)
      .text(ctx.draft ? 'NOT SIGNED' : (ctx.awaitingClient ? 'SIGNED BY TEAMLINK - AWAITING THE CLIENT' : fitText(doc, ctx.clientName, width - 130)), L + 130, 38, { width: width - 130, align: 'right', lineBreak: false });
    doc.moveTo(L, HEADER_RULE_Y).lineTo(R, HEADER_RULE_Y).lineWidth(0.6).strokeColor('#c9d0dc').stroke();

    // ---- footer ----
    const fy = H - FOOT_ZONE;
    doc.moveTo(L, fy).lineTo(R, fy).lineWidth(0.6).strokeColor('#c9d0dc').stroke();
    const STAMP = 46; const INIT_W = 68; const INIT_H = 30;
    const left = (img, text, label) => {
      // TeamLink: stamp, then initials
      if (img.stamp) imageBox(doc, img.stamp, L, fy + 8, STAMP, STAMP); else emptyBox(doc, L, fy + 8, STAMP, STAMP, 'Stamp');
      const ix = L + STAMP + 6;
      if (img.sign) imageBox(doc, img.sign, ix, fy + 16, INIT_W, INIT_H);
      else if (text) {
        doc.font('Times-Italic').fontSize(15).fillColor('#111').text(text, ix, fy + 24, { width: INIT_W, align: 'center', lineBreak: false });
      } else emptyBox(doc, ix, fy + 16, INIT_W, INIT_H, 'Initial here');
      doc.font('Helvetica').fontSize(6).fillColor(MUTED).text(label, ix, fy + 50, { width: INIT_W, align: 'center', lineBreak: false });
    };
    const right = (img, text, label) => {
      // Client: initials, then stamp (the mirror image)
      const sx = R - STAMP;
      const ix = sx - 6 - INIT_W;
      if (img.stamp) imageBox(doc, img.stamp, sx, fy + 8, STAMP, STAMP); else emptyBox(doc, sx, fy + 8, STAMP, STAMP, 'Stamp');
      if (img.sign) imageBox(doc, img.sign, ix, fy + 16, INIT_W, INIT_H);
      else if (text) {
        doc.font('Times-Italic').fontSize(15).fillColor('#111').text(text, ix, fy + 24, { width: INIT_W, align: 'center', lineBreak: false });
      } else emptyBox(doc, ix, fy + 16, INIT_W, INIT_H, 'Initial here');
      doc.font('Helvetica').fontSize(6).fillColor(MUTED).text(label, ix, fy + 50, { width: INIT_W, align: 'center', lineBreak: false });
    };
    left({ sign: ctx.kSign, stamp: ctx.kStamp }, ctx.kInitials, 'Initialled by TeamLink');
    right({ sign: ctx.cSign, stamp: ctx.cStamp }, ctx.cInitials, 'Initialled by Client');

    const group = STAMP + 6 + INIT_W;
    const cx = L + group + 10;
    const cw = width - 2 * (group + 10);
    const lines = [
      { t: `Agreement No. ${ctx.agreementId} · Page ${i - range.start + 1} of ${total}`, f: 'Helvetica-Bold', s: 7.6, c: NAVY },
      { t: `${ctx.clientName} · Private & Confidential`, f: 'Helvetica', s: 6.8, c: MUTED },
    ];
    if (ctx.draft) lines.push({ t: 'NOT SIGNED - not an executed copy', f: 'Helvetica-Bold', s: 6.8, c: '#9a6700' });
    else if (ctx.awaitingClient) lines.push({ t: "Signed by TeamLink - awaiting the Client's signature", f: 'Helvetica-Bold', s: 6.8, c: '#9a6700' });
    else lines.push({ t: `Text fingerprint (SHA-256): ${ctx.hash.slice(0, 16)}…`, f: 'Helvetica', s: 6.4, c: MUTED });
    if (ctx.stampNo) lines.push({ t: `Stamp paper / e-stamp no. ${ctx.stampNo}`, f: 'Helvetica', s: 6.4, c: MUTED });
    let ty = fy + 12;
    lines.forEach((ln) => {
      doc.font(ln.f).fontSize(ln.s).fillColor(ln.c);
      doc.text(fitText(doc, ln.t, cw), cx, ty, { width: cw, align: 'center', lineBreak: false });
      ty += ln.s + 3.6;
    });
  }
}

// One full drawing of the document into memory. Returns { buf, pages }.
// `totalPages` is only used for the sentence "This agreement consists of N
// pages" on the execution-details block (the page count of the same document,
// known from a first pass).
function drawDocument(a, totalPages) {
  const {
    client, trail, consultantName, agreementOnly, vendorDoc, us, logo, images, place, stampNo, draft, awaitingClient,
  } = a;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      // The Vendor Services Agreement keeps the Word document's 1-inch side margins.
      margins: vendorDoc ? { top: TOP_MARGIN, bottom: BOTTOM_MARGIN, left: 72, right: 72 } : { top: TOP_MARGIN, bottom: BOTTOM_MARGIN, left: 62, right: 62 },
      bufferPages: true,
      info: {
        Title: `Service Agreement ${client.agreementId || ''} — ${client.name}`.trim(),
        Author: consultantName || 'TeamLink Consultants',
        Subject: 'Recruitment / Staffing Services Agreement',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buf: Buffer.concat(chunks), pages: pageCount }));
    doc.on('error', reject);
    let pageCount = 1;

    // Each image embedded ONCE: an opened image object is reused on every page
    // it is drawn on (the signature block, the footers and the Execution page).
    const once = (b) => { try { return b ? doc.openImage(b) : null; } catch { return null; } };
    const [cSign, cStamp, kSign, kStamp] = [once(images.cSign), once(images.cStamp), once(images.kSign), once(images.kStamp)];
    const logoImg = once(logo);
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const signedClient = !!client.agreementSignedAt;
    const fullyExecuted = signedClient && !!client.agreementCompanySignFile && !!client.agreementCompanySealedAt;
    const hash = textHash(client);
    // The execution page and the certificate exist once the client has signed.
    const withExec = !agreementOnly && !draft;

    // --- The agreement text ---------------------------------------------------
    // The Vendor Services Agreement: drawn like the Word document, signature
    // block filled from the record (utils/vendorAgreementPdf.js).
    if (vendorDoc) {
      // eslint-disable-next-line global-require
      require('./vendorAgreementPdf').renderVendorText(doc, client, { cSign, kSign, cStamp, kStamp, pdfText, teamlinkName: us.signatoryName, teamlinkTitle: us.signatoryTitle, clean: !!agreementOnly });
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

    // --- Execution details (the formalities the last page of a contract carries) -
    {
      const L = doc.page.margins.left;
      const rows = [];
      const when = fullyExecuted
        ? ddmmyyyyIst(new Date(Math.max(new Date(client.agreementSignedAt).getTime(), new Date(client.agreementCompanySealedAt).getTime())))
        : '';
      rows.push([`Place of execution: ${place}`, `Date of execution: ${when || '—'}`]);
      if (stampNo) rows.push([`Stamp paper / e-stamp certificate no.: ${stampNo}`, '']);
      // WHO SIGNS FOR EACH SIDE, printed on every copy (founder 2026-10-30): a digital signature (Aadhaar eSign / DSC) carries
      // the signer's own name, so the reader matches it to this line - also when the signature box sits in a corner.
      const usName = client.agreementCompanySignedBy || us.signatoryName || '';
      rows.push([`For ${consultantName || 'TeamLink Consultants'}: ${usName || '________________'}, ${us.signatoryTitle || 'Authorised Signatory'}`, '']);
      rows.push([`For ${client.legalName || client.name}: ${client.agreementSignedBy || '________________'}${client.agreementSignedByTitle ? `, ${client.agreementSignedByTitle}` : ', Authorised Signatory'}`, '']);
      const count = totalPages
        ? `This agreement consists of ${totalPages} pages${!withExec ? '.' : ', including the execution page and the certificate of electronic execution.'}`
        : '';
      // COUNTERPARTS (founder 2026-10-30): each side may digitally sign its own copy (DigiLocker keeps one signature per PDF);
      // the copies together are the one agreement.
      const counterparts = 'This Agreement may be executed in counterparts, including by electronic signature (Aadhaar eSign or a digital signature certificate). Each signed counterpart is an original, and together they form one and the same agreement.';
      const need = 34 + rows.length * 15 + (count ? 24 : 0) + 30;
      if (doc.y + need > bottomLimit()) doc.addPage();
      else doc.moveDown(0.8);
      const y0 = doc.y;
      doc.moveTo(L, y0).lineTo(L + width, y0).lineWidth(0.6).strokeColor('#c9d0dc').stroke();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text('Execution details', L, y0 + 6, { width });
      let y = doc.y + 3;
      rows.forEach(([l, r]) => {
        doc.font('Helvetica').fontSize(9.5).fillColor('#111').text(pdfText(l), L, y, { width: r ? width * 0.55 : width, lineBreak: false });
        if (r) doc.text(pdfText(r), L + width * 0.55, y, { width: width * 0.45, lineBreak: false });
        y += 15;
      });
      if (count) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(count, L, y + 2, { width });
        y = doc.y + 2;
      }
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(counterparts, L, y + 2, { width, align: 'justify' });
      doc.x = L;
    }

    if (withExec) {
      // --- Execution --------------------------------------------------------------
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text('Execution', doc.page.margins.left, doc.page.margins.top, { width });
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
        sign: kSign, stamp: kStamp, name: client.agreementCompanySignedBy || us.signatoryName, title2: us.signatoryTitle || 'Authorised Signatory',
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
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Fingerprint of the agreement text (SHA-256): ${hash}. Any change to the text of the agreement changes this value.`, { width });
      doc.moveDown(0.6);
      trail.forEach((row) => {
        if (doc.y > bottomLimit() - 30) doc.addPage();
        const yy = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(fmt(row.at), doc.page.margins.left, yy, { width: 120 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111').text(pdfText(row.event), doc.page.margins.left + 124, yy, { width: width - 124 });
        if (row.detail) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(row.detail), doc.page.margins.left + 124, doc.y, { width: width - 124 });
        doc.moveDown(0.35);
      });
    }

    // --- SPACE FOR THE DIGITAL SIGNATURE (founder 2026-10-30) -------------------------
    // DigiLocker's Aadhaar eSign (and eMudhra's "Bottom-Right") draws its box low on the LAST page, about 113-162 pt above the
    // page bottom - inside the body area. That band is kept empty on the last page so the box never covers text or stamps.
    {
      const H = doc.page.height;
      const L = doc.page.margins.left;
      const capY = H - BOTTOM_MARGIN - 72;
      if (doc.y > capY - 6) doc.addPage();
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
        .text('Space kept for the digital signatures (Aadhaar eSign / DSC). The name of each signer is shown in the signature panel of this PDF.', L, capY, { width });
      doc.x = L;
    }

    // --- Header + footer + stamps and initials on EVERY page -----------------------
    drawPageChrome(doc, {
      logo: logoImg,
      agreementId: client.agreementId || '—',
      clientName: client.legalName || client.name || '',
      draft,
      awaitingClient,
      hash,
      stampNo,
      kSign, kStamp, cSign, cStamp,
      // No image: the typed signer's initials stand in on a signed copy.
      kInitials: !kSign && client.agreementCompanySignedBy ? initialsOf(client.agreementCompanySignedBy) : '',
      cInitials: !cSign && signedClient && client.agreementSignedBy ? initialsOf(client.agreementSignedBy) : '',
    });
    pageCount = doc.bufferedPageRange().count;
    doc.end();
  });
}

// `trail` = [{ at, event, detail }]
// agreementOnly: just the agreement pages (sent to eMudhra to sign) — no
// Execution / certificate page, which is kept as our separate appendix.
// The document is built in memory (twice at most: the first pass counts the
// pages for "This agreement consists of N pages"), then written to `out`.
async function renderAgreementPdf(client, { trail = [], consultantName, agreementOnly = false }, out) {
  const [cSign, cStamp, kSign, kStamp] = await Promise.all([
    imageBuffer(client.agreementClientSignFile), imageBuffer(client.agreementClientStampFile),
    imageBuffer(client.agreementCompanySignFile), imageBuffer(client.agreementCompanyStampFile),
  ]);
  // eslint-disable-next-line global-require
  const vendorDoc = require('./vendorAgreement').isVendorDocument(client.agreementDocument);
  // TeamLink's signer (Agreement settings): name / designation where the record has none.
  // eslint-disable-next-line global-require
  const us = await require('./agreement').consultantParty();
  // eslint-disable-next-line global-require
  const settings = await require('./agreementSettings').agreementSettings().catch(() => ({}));
  const a = {
    client, trail, consultantName, agreementOnly, vendorDoc, us,
    logo: await logoBuffer(),
    images: { cSign, cStamp, kSign, kStamp },
    place: pdfText(String(settings.executionPlace || '').trim() || PLACE_DEFAULT),
    stampNo: pdfText(String(settings.stampPaperNo || '').trim()),
    // A draft = the client has not signed: it carries the DRAFT watermark.
    // (The copy sent to eMudhra is the document to be signed: no watermark.)
    // A copy TeamLink has already signed and stamped (sign first, then send - founder 2026-10-30) is NOT a draft: no
    // watermark, the Execution page with TeamLink's side filled, and "awaiting the Client" in the header and footer.
    draft: !client.agreementSignedAt && !agreementOnly && !(client.agreementCompanySignFile && client.agreementCompanySealedAt),
    awaitingClient: !client.agreementSignedAt && !agreementOnly && !!(client.agreementCompanySignFile && client.agreementCompanySealedAt),
  };
  let guess = (await drawDocument(a, 99)).pages;
  let result = await drawDocument(a, guess);
  for (let i = 0; i < 2 && result.pages !== guess; i += 1) {
    guess = result.pages;
    // eslint-disable-next-line no-await-in-loop
    result = await drawDocument(a, guess);
  }
  if (typeof out.setHeader === 'function' && !out.headersSent) out.setHeader('Content-Length', result.buf.length);
  out.end(result.buf);
  return result.pages;
}

// imageBuffer / pdfText / fmt are reused by utils/offerPdf.js (B3 offer letters).
module.exports = { renderAgreementPdf, imageBuffer, pdfText, fmt, LOGO, textHash, TOP_MARGIN, BOTTOM_MARGIN, FOOT_ZONE };
