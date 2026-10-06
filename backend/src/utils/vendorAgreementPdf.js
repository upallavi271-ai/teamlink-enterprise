// ---------------------------------------------------------------------------
// The "Vendor Services Agreement" drawn like the user's Word document
// (2026-10-05): the centred bold title, numbered bold section headings, a) b)
// clauses, the section 8 table with borders, and the two-column signature
// block — filled from the record when it is signed (the client's signer from
// the e-sign, TeamLink's from the countersign or the Agreement-settings
// signatory). Body in Helvetica 11 pt (the document uses Calibri 11, which
// pdfkit does not ship; Helvetica is the closest built-in sans), 1-inch
// margins as in the document. The document's footer is empty.
// ---------------------------------------------------------------------------
const INK = '#111111';

function ddmmyyyy(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  // Shown in India time, the way the agreement is dated.
  const ist = new Date(x.getTime() + 330 * 60000);
  return `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}`;
}

function drawTable(doc, rows, x, width) {
  const colW = [width * 0.42, width * 0.58];
  const pad = 6;
  rows.forEach((cells, r) => {
    doc.font(r === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(11);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: colW[i] - pad * 2 }))) + pad * 2;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    let cx = x;
    cells.forEach((c, i) => {
      doc.rect(cx, y, colW[i], h).lineWidth(0.8).strokeColor('#000').stroke();
      doc.fillColor(INK).text(c, cx + pad, y + pad, { width: colW[i] - pad * 2, align: 'center' });
      cx += colW[i];
    });
    doc.x = x;
    doc.y = y + h;
  });
  doc.moveDown(0.6);
}

function drawSignatures(doc, rows, x, width, { client, cSign, kSign, cStamp, kStamp, pdfText, teamlinkName, teamlinkTitle }) {
  const colW = (width - 24) / 2;
  const right = x + colW + 24;
  const signedName = client.agreementSignedBy || '';
  const typed = !cSign && client.agreementClientSealedAt && client.agreementVerifiedAt ? signedName : '';
  rows.forEach((cells, r) => {
    const [l, rt] = [cells[0] || '', cells[1] || ''];
    const y = doc.y;
    if (r === 0) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(l, x, y, { width: colW });
      const h1 = doc.y - y;
      doc.text(rt, right, y, { width: colW });
      doc.x = x; doc.y = y + Math.max(h1, doc.y - y) + 6;
      return;
    }
    const label = (s) => (s.match(/^(Name|Designation|Sign|Date):/) || [])[1];
    const lk = label(l);
    const rk = label(rt);
    // Left (TeamLink): the document's value, else the countersign.
    let lv = l.replace(/^[^:]+:\s*/, '');
    // A document made before the signer was set has blank lines: the signer
    // from Agreement settings fills them (2026-10-05).
    if (lk === 'Name' && !lv) lv = client.agreementCompanySignedBy || teamlinkName || '';
    if (lk === 'Designation' && !lv) lv = teamlinkTitle || '';
    if (lk === 'Date' && !lv) lv = client.agreementCompanySignFile ? ddmmyyyy(client.agreementCompanySealedAt) : '';
    // Right (client): filled by the e-sign.
    let rv = rt.replace(/^[^:]+:\s*/, '');
    if (rk === 'Name' && !rv) rv = signedName;
    if (rk === 'Designation' && !rv) rv = client.agreementSignedByTitle || '';
    if (rk === 'Date' && !rv) rv = ddmmyyyy(client.agreementSignedAt);
    let h = 18;
    const cell = (cx, key, value, img, typedName) => {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(`${key}:`, cx, y, { width: 80, lineBreak: false });
      if (img) {
        try { doc.image(img, cx + 82, y - 6, { fit: [colW - 90, 40] }); h = Math.max(h, 42); } catch { /* unreadable image */ }
      } else if (typedName) {
        doc.font('Times-Italic').fontSize(16).text(pdfText(typedName), cx + 82, y - 3, { width: colW - 90, lineBreak: false });
        h = Math.max(h, 22);
      } else if (key === 'Sign' && cx !== x && client.agreementEsignProvider === 'eMudhra') {
        // The client signs with Aadhaar eSign at eMudhra: the digital signature
        // is in the PDF itself (see the signature panel).
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(INK).text('Digitally signed with Aadhaar eSign (eMudhra)', cx + 82, y + 1, { width: colW - 90 });
      } else if (key === 'Sign') {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#9a6700').text(cx === x ? 'Waiting for TeamLink signature' : 'Waiting for client signature', cx + 82, y + 1, { width: colW - 90 });
        doc.fillColor(INK);
      } else {
        doc.font('Helvetica').fontSize(11).text(pdfText(value || ''), cx + 82, y, { width: colW - 90 });
      }
    };
    if (lk) cell(x, lk, lv, lk === 'Sign' ? kSign : null, null);
    if (rk) cell(right, rk, rv, rk === 'Sign' ? cSign : null, rk === 'Sign' ? typed : null);
    doc.x = x;
    doc.y = y + h + 6;
  });
  // Each side's company stamp under its column (2026-10-05) — always shown,
  // "Waiting for … stamp" while one is missing.
  {
    const y = doc.y + 2;
    const label = (cx) => doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Stamp:', cx, y, { width: 80, lineBreak: false });
    [[x, kStamp], [right, cStamp]].forEach(([cx, img]) => {
      label(cx);
      if (img) { try { doc.image(img, cx + 82, y - 4, { fit: [110, 80] }); } catch { /* unreadable image */ } } else {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#9a6700').text(cx === x ? 'Waiting for TeamLink stamp' : 'Waiting for client stamp', cx + 82, y + 1, { width: colW - 90 });
        doc.fillColor(INK);
      }
    });
    doc.x = x;
    doc.y = y + 86;
  }
}

function renderVendorText(doc, client, { cSign, kSign, cStamp, kStamp, pdfText, teamlinkName, teamlinkTitle }) {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const lines = pdfText(client.agreementDocument).split('\n');
  let i = 0;
  let signing = false;
  let inSpecial = false;
  while (i < lines.length) {
    const t = lines[i].replace(/\s+$/, '');
    if (i === 0) {
      doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(t, x, doc.page.margins.top, { width, align: 'center' });
      doc.moveDown(0.8);
      i += 1;
      continue;
    }
    if (!t) { doc.moveDown(0.4); i += 1; continue; }
    if (/^\|.*\|$/.test(t)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i += 1;
      }
      drawTable(doc, rows, x, width);
      continue;
    }
    if (t.includes('\t')) {
      const rows = [];
      while (i < lines.length && lines[i].includes('\t')) { rows.push(lines[i].split('\t').map((c) => c.trim())); i += 1; }
      doc.moveDown(0.6);
      drawSignatures(doc, rows, x, width, { client, cSign, kSign, cStamp, kStamp, pdfText, teamlinkName, teamlinkTitle });
      continue;
    }
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const head = t.match(/^(\d+\.\s+[^:]+:)(.*)$/);
    if (head) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(head[1], x, doc.y, { width, continued: !!head[2].trim() });
      if (head[2].trim()) doc.font('Helvetica').text(head[2], { width, align: 'justify' });
      doc.moveDown(0.2);
    } else if (/^[a-z]\.\s/.test(t)) {
      doc.font('Helvetica').fontSize(11).fillColor(INK).text(t, x + 18, doc.y, { width: width - 18, align: 'justify', lineGap: 1.5 });
      doc.moveDown(0.25);
    } else if (t === 'Special terms:') {
      inSpecial = true;
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(t, x + 18, doc.y, { width: width - 18 });
    } else if (inSpecial && !/^This Agreement has been executed/.test(t)) {
      doc.font('Helvetica').fontSize(11).fillColor(INK).text(t, x + 18, doc.y, { width: width - 18, align: 'justify', lineGap: 1.5 });
      doc.moveDown(0.25);
    } else {
      // The closing sentence stays on the page with the signature block.
      if (/^This Agreement has been executed/.test(t)) {
        inSpecial = false;
        if (doc.y + 270 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      }
      signing = signing || /^This Agreement has been executed/.test(t);
      doc.font('Helvetica').fontSize(11).fillColor(INK).text(t, x, doc.y, { width, align: 'justify', lineGap: 1.5 });
      doc.moveDown(0.3);
    }
    i += 1;
  }
  return signing;
}

module.exports = { renderVendorText, ddmmyyyy };
