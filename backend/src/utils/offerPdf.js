// ---------------------------------------------------------------------------
// THE SIGNED OFFER LETTER AS A PDF (B3, 2026-10-06) — pdfkit, the same helpers
// as the agreement PDF (utils/agreementPdf.js imageBuffer / pdfText / fmt).
//
//   page 1…n   the letter text of THIS version, exactly as sent
//   acceptance the candidate's signature (image, or the typed name), name,
//              date, the decision
//   certificate time, IP, browser, where the code went and when it was
//              entered, the version, the expiry, and the version's audit trail
// ---------------------------------------------------------------------------
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { imageBuffer, pdfText, fmt, LOGO } = require('./agreementPdf');

const NAVY = '#1f2a44';
const MUTED = '#5b6474';

// v = OfferVersion, info = { candidateName, job, company }, trail = [{ at, event, detail }]
async function renderOfferPdf(v, info, { trail = [] } = {}, out) {
  let sign = await imageBuffer(v.signFile);
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 64, bottom: 64, left: 62, right: 62 }, bufferPages: true,
    info: { Title: `Offer letter v${v.version} — ${info.candidateName || ''}`.trim(), Author: 'TeamLink Consultants', Subject: `Offer — ${info.job || ''}` },
  });
  doc.pipe(out);
  try { sign = sign ? doc.openImage(sign) : null; } catch { sign = null; }
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  if (fs.existsSync(LOGO)) { try { doc.image(LOGO, doc.page.margins.left, 30, { height: 26 }); } catch { /* optional */ } }

  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(pdfText(`Offer letter — ${info.job || ''}${info.company ? ` at ${info.company}` : ''}`), { width });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(`Version ${v.version} · sent ${fmt(v.createdAt)}${v.expiresAt ? ` · valid until ${fmt(v.expiresAt)}` : ''}`), { width });
  doc.moveDown(0.8);
  pdfText(v.letterText).split('\n').forEach((line) => {
    const t = line.replace(/\s+$/, '');
    if (!t) { doc.moveDown(0.45); return; }
    doc.font('Times-Roman').fontSize(11).fillColor('#111').text(t, { width, lineGap: 1.5 });
  });

  // --- Acceptance -----------------------------------------------------------
  doc.moveDown(1.2);
  if (doc.y > doc.page.height - 260) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Acceptance', doc.page.margins.left, doc.y, { width });
  doc.moveDown(0.4);
  const boxY = doc.y;
  const boxW = Math.min(300, width);
  doc.rect(doc.page.margins.left, boxY, boxW, 86).strokeColor('#d5dbe5').lineWidth(0.8).stroke();
  if (sign) {
    try { doc.image(sign, doc.page.margins.left + 8, boxY + 8, { fit: [boxW - 16, 70], align: 'center', valign: 'center' }); } catch { /* unreadable */ }
  } else if (v.signedName) {
    doc.font('Times-Italic').fontSize(20).fillColor('#111').text(pdfText(v.signedName), doc.page.margins.left + 8, boxY + 26, { width: boxW - 16, align: 'center' });
  }
  doc.y = boxY + 96;
  doc.x = doc.page.margins.left;
  [
    ['Decision', v.status === 'Accepted' ? 'Accepted' : v.status],
    ['Name', v.signedName],
    ['Signed', v.signedAt ? fmt(v.signedAt) : '—'],
    ['Signature', v.esignProvider === 'eMudhra' ? 'Aadhaar eSign (eMudhra)' : v.signMethod],
  ].forEach(([k, val]) => {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(`${k}: `, { continued: true, width }).font('Helvetica').text(pdfText(val || '—'), { width });
  });

  // --- Certificate ------------------------------------------------------------
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text('Certificate of electronic acceptance', { width });
  const cert = v.esignProvider === 'eMudhra'
    ? `Signed with Aadhaar eSign at eMudhra (transaction ${v.esignTxnId || '—'}). The eMudhra-signed copy is kept separately.`
    : (v.otpVerifiedAt
      ? `The candidate confirmed this signature with a one-time code sent by ${v.otpSentTo || 'email'} and entered on ${fmt(v.otpVerifiedAt)}.`
      : 'No one-time code was entered for this acceptance.');
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(pdfText(`${cert} Signed from IP ${v.signedIp || '—'}${v.signedUserAgent ? ` · ${v.signedUserAgent}` : ''}.`), { width });
  doc.moveDown(0.6);
  trail.forEach((row) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const yy = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(fmt(row.at), doc.page.margins.left, yy, { width: 120 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111').text(pdfText(row.event), doc.page.margins.left + 124, yy, { width: width - 124 });
    if (row.detail) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(row.detail), doc.page.margins.left + 124, doc.y, { width: width - 124 });
    doc.moveDown(0.35);
  });

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 40;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(pdfText(`Offer v${v.version} · ${info.candidateName || ''} · Private & Confidential`), doc.page.margins.left, bottom, { width: width / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.margins.left + width / 2, bottom, { width: width / 2, align: 'right', lineBreak: false });
  }
  doc.end();
}

// The version's own audit trail, oldest first.
async function trailOf(prisma, v) {
  const rows = await prisma.auditLog.findMany({ where: { entity: 'OfferVersion', entityId: v.id }, orderBy: { createdAt: 'asc' }, take: 200 });
  return rows.map((r) => ({ at: r.createdAt, event: r.action, detail: [r.toValue, r.reason].filter(Boolean).join(' · ') || null }));
}

// Renders and STORES the signed PDF; returns { file, sha256 } or null.
async function keepOfferPdf(prisma, v, info) {
  try {
    // eslint-disable-next-line global-require
    const attachments = require('./attachments');
    // eslint-disable-next-line global-require
    const { PassThrough } = require('stream');
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
    await renderOfferPdf(v, info, { trail: await trailOf(prisma, v) }, sink);
    await done;
    const buf = Buffer.concat(chunks);
    const stored = attachments.store({ data: buf, contentType: 'application/pdf', filename: `offer-v${v.version}-signed.pdf` }, { maxBytes: 20 * 1024 * 1024 });
    // eslint-disable-next-line global-require
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    return { file: stored.billFile, sha256: sha, size: buf.length };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[offer] could not keep the signed PDF:', err.message);
    return null;
  }
}

module.exports = { renderOfferPdf, keepOfferPdf, trailOf };
