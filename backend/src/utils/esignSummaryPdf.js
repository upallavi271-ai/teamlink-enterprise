// ---------------------------------------------------------------------------
// SIGNATURE SUMMARY OF THE TWO DIGILOCKER COPIES (founder 2026-10-31: "digilocker tho ne rendu signs pakka pakkana raavali")
//
// DigiLocker keeps one signature per PDF, so TeamLink and the client each eSign their own copy. This one page shows the two
// signatures SIDE BY SIDE - TeamLink on the left, the client on the right - as they were checked again when the page was
// made: the signer's Aadhaar name, the time, the certificate, valid or not, and the fingerprint (SHA-256) of each signed copy.
// It says plainly that it is TeamLink's summary: the legal signatures are inside the two signed copies it names.
// ---------------------------------------------------------------------------
const fs = require('fs');
const PDFDocument = require('pdfkit');

const NAVY = '#1f2a44';
const MUTED = '#5b6474';
const GREEN = '#15803d';
const RED = '#b42318';
const whenOf = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
};
const txt = (v) => String(v == null ? '' : v).replace(/[^\x20-\x7E -ÿ–—‘’“”•]/g, '');

// sides: [{ side, title, copy: null | { signer, signedAt, issuer, valid, sha256, fileName, uploadedAt } }]
function renderEsignSummary({ client, agreementId, consultantName, sides, logoPath }, out) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: `Signature summary ${agreementId || ''} — ${client.name}`.trim(), Author: consultantName || 'TeamLink Consultants' } });
  doc.pipe(out);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  try { if (logoPath && fs.existsSync(logoPath)) doc.image(logoPath, L, 40, { height: 26 }); } catch { /* optional */ }
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(`Agreement No. ${txt(agreementId || '—')}`, L, 44, { width: W, align: 'right' });
  doc.moveTo(L, 76).lineTo(L + W, 76).lineWidth(0.6).strokeColor('#c9d0dc').stroke();

  doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('Signature summary', L, 92, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(`Vendor Services Agreement between ${txt(consultantName || 'TeamLink Consultants')} and ${txt(client.legalName || client.name)}`, { width: W, align: 'center' });
  doc.moveDown(0.3).fontSize(9).text('Each side signed its own copy with Aadhaar eSign through DigiLocker (signed in counterparts).', { width: W, align: 'center' });

  const top = doc.y + 18;
  const gap = 18;
  const colW = (W - gap) / 2;
  let bottom = top;
  sides.forEach((s, i) => {
    const x = L + i * (colW + gap);
    const c = s.copy;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(txt(s.title), x, top, { width: colW });
    // the signature box, drawn like the one DigiLocker puts on the signed copy
    const by = top + 22;
    const ok = !!(c && c.valid);
    doc.roundedRect(x, by, colW, 86, 4).lineWidth(1).strokeColor(c ? (ok ? GREEN : RED) : '#c9d0dc').stroke();
    if (c) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(ok ? GREEN : RED).text(ok ? 'VALID  Aadhaar eSign' : 'NOT VALID', x + 12, by + 10, { width: colW - 24 });
      doc.font('Helvetica').fontSize(9.5).fillColor('#111').text('Digitally signed by:', x + 12, by + 30, { width: colW - 24 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(txt(c.signer || '—'), x + 12, by + 43, { width: colW - 24 });
      doc.font('Helvetica').fontSize(9.5).fillColor('#111').text(`Date: ${whenOf(c.signedAt)}`, x + 12, by + 61, { width: colW - 24 });
    } else {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTED).text('Not signed yet', x + 12, by + 36, { width: colW - 24, align: 'center' });
    }
    let y = by + 96;
    const row = (k, v) => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(k, x, y, { width: colW });
      doc.font('Helvetica').fontSize(8.5).fillColor('#111').text(txt(v || '—'), x, doc.y, { width: colW });
      y = doc.y + 5;
    };
    if (c) {
      row('Certificate issued by', c.issuer);
      // THE SIGNED COPY ITSELF, inside this PDF: click the file name to open it (founder 2026-10-31: "files meedha click chesthe,
      // akkade files open ayyelaaga"). It is attached byte for byte, so its own signature stays valid.
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(c.url ? 'Signed copy (click to open)' : 'Signed copy (file)', x, y, { width: colW });
      const ly = y;
      const fy = doc.y;
      const label = `${txt(c.fileName || 'signed-copy.pdf')}`;
      // the FILE NAME opens the signed copy in any browser / phone when there is a web link (founder 2026-10-31: "click chesthe pdf
      // open avvali"); the copy is also attached byte for byte - the paperclip next to the heading (Adobe Acrobat Reader)
      doc.font('Helvetica').fontSize(8.5).fillColor('#1d4ed8').text(label, x, fy, { width: colW, underline: !!(c.url || c.buf), ...(c.url ? { link: c.url } : {}) });
      if (c.buf) {
        const h = Math.max(11, doc.y - fy);
        try {
          const ax = c.url ? x + colW - 12 : x; const ay = c.url ? ly - 1 : fy; const aw = c.url ? 12 : colW; const ah = c.url ? 12 : h;
          doc.fileAnnotation(ax, ay, aw, ah, {
            src: c.buf, name: c.fileName || `${s.side}-signed-copy.pdf`, type: 'application/pdf', hidden: false,
            description: `${s.title}: signed copy (Aadhaar eSign by ${c.signer || 'the signer'})`,
          }, { Name: 'Paperclip' });
        } catch { /* attaching is a convenience; the summary stands without it */ }
      }
      // ...and a web link that opens the same copy in ANY browser or phone (Chrome, Edge), not only Adobe
      if (c.url) {
        doc.moveDown(0.25);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#1d4ed8').text('Open this signed copy (any browser)', x, doc.y, { width: colW, link: c.url, underline: true });
      }
      y = doc.y + 5;
      row('Fingerprint of the signed copy (SHA-256)', c.sha256);
      row('Checked', ok ? 'The signature verifies with the signer\'s certificate and the file was not changed after signing.' : 'The signature did not verify. Ask for a fresh copy from DigiLocker.');
    }
    bottom = Math.max(bottom, y);
  });

  doc.y = bottom + 14;
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).strokeColor('#c9d0dc').stroke();
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
    `This page is a summary made by TeamLink on ${whenOf(new Date().toISOString())}. It carries no signature itself: the legal signatures are inside the two signed copies named above, which are attached to this PDF exactly as signed. "Open this signed copy" opens each one in any browser or phone; in Adobe Acrobat Reader you can also click a file name (or the Attachments panel) and check the signature. Both copies together form the agreement.`,
    L, doc.y, { width: W },
  );
  doc.end();
}

module.exports = { renderEsignSummary };
