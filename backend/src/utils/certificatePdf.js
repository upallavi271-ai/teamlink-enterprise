// ---------------------------------------------------------------------------
// Course completion certificate — the downloadable PDF.
//
// The on-screen certificate (frontend Lms.jsx CertificateView) and this file
// print the SAME fields from the SAME endpoint payload (routes/lms.js
// certificatePayload), so the page a learner views and the file they download
// can never disagree about a name, a date or an ID.
//
// Drawn with pdfkit's built-in Helvetica / Times faces, so no font file has to
// ship with the server. The TeamLink logo is the one the frontend already
// bundles; if the checkout has no frontend beside it, the organisation name is
// printed on its own and nothing fails.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO = path.resolve(__dirname, '../../../frontend/src/assets/teamlink-full-logo.png');

const NAVY = '#1f2a44';
const TEAL = '#0f766e';
const MUTED = '#5b6474';

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Writes the PDF for one certificate to `out` (an HTTP response).
function renderCertificate(cert, out) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    info: {
      Title: `Certificate ${cert.certificateId}`,
      Author: cert.organisation,
      Subject: `Completion of ${cert.courseTitle}`,
    },
  });
  doc.pipe(out);

  const W = doc.page.width;
  const H = doc.page.height;

  // Double frame.
  doc.lineWidth(3).strokeColor(NAVY).rect(24, 24, W - 48, H - 48).stroke();
  doc.lineWidth(1).strokeColor(TEAL).rect(34, 34, W - 68, H - 68).stroke();

  let y = 62;
  if (fs.existsSync(LOGO)) {
    try {
      doc.image(LOGO, (W - 170) / 2, y, { width: 170 });
      y += 56;
    } catch { /* an unreadable logo is not worth failing a certificate over */ }
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY)
    .text(cert.organisation.toUpperCase(), 0, y, { width: W, align: 'center', characterSpacing: 2 });
  y += 38;

  doc.font('Times-Bold').fontSize(34).fillColor(NAVY)
    .text('Certificate of Completion', 0, y, { width: W, align: 'center' });
  y += 58;

  doc.font('Helvetica').fontSize(13).fillColor(MUTED)
    .text('This is to certify that', 0, y, { width: W, align: 'center' });
  y += 26;

  doc.font('Times-BoldItalic').fontSize(30).fillColor(TEAL)
    .text(cert.employeeName, 60, y, { width: W - 120, align: 'center' });
  y += 44;
  if (cert.employeeCode || cert.department) {
    doc.font('Helvetica').fontSize(10.5).fillColor(MUTED)
      .text([cert.employeeCode, cert.department].filter(Boolean).join(' · '), 0, y, { width: W, align: 'center' });
    y += 22;
  }

  doc.font('Helvetica').fontSize(13).fillColor(MUTED)
    .text('has successfully completed the course', 0, y, { width: W, align: 'center' });
  y += 24;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY)
    .text(cert.courseTitle, 60, y, { width: W - 120, align: 'center' });
  y += 34;

  const detail = [
    cert.category,
    cert.duration,
    cert.score != null ? `Assessment score ${cert.score}% (pass mark ${cert.passMark}%)` : null,
  ].filter(Boolean).join('   ·   ');
  if (detail) {
    doc.font('Helvetica').fontSize(10.5).fillColor(MUTED).text(detail, 0, y, { width: W, align: 'center' });
  }

  // Footer: completion date on the left, certificate ID on the right.
  const fy = H - 118;
  doc.lineWidth(0.8).strokeColor(MUTED)
    .moveTo(90, fy).lineTo(300, fy).stroke()
    .moveTo(W - 300, fy).lineTo(W - 90, fy).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY)
    .text(fmtDate(cert.completedAt), 90, fy - 20, { width: 210, align: 'center' })
    .text(cert.certificateId, W - 300, fy - 20, { width: 210, align: 'center' });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
    .text('Date of completion', 90, fy + 6, { width: 210, align: 'center' })
    .text('Certificate ID', W - 300, fy + 6, { width: 210, align: 'center' });

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(
      `Issued ${fmtDate(cert.issuedAt)} by ${cert.organisation}. Verify this certificate by its ID with the HR team.`,
      0, H - 62, { width: W, align: 'center' },
    );

  doc.end();
}

module.exports = { renderCertificate };
