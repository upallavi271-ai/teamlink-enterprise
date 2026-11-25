// ---------------------------------------------------------------------------
// THE LOOK OF A TEAMLINK LETTER (founder's formatting brief, 2026-11-25), shared by the offer letter, the relieving letter and the
// service certificate so they carry one identity:
//   Page A4 · header: the official TeamLink logo (left), the company name and "Connect. Hire. Grow." (right), a cyan line ·
//   primary colours: navy blue and cyan (taken from the logo file itself) · font: Arial (Helvetica in the PDF - the same metrics) ·
//   headings: navy blue, bold · footer on every page: company address, phone, email and website · signature: HR / Authorised Signatory.
// ---------------------------------------------------------------------------
const NAVY = '#002060'; // the logo's navy
const CYAN = '#0096FF'; // the logo's cyan-blue
const TEXT = '#000000';
const MUTED = '#555555';
const SIGNATORY_FALLBACK = 'Authorised Signatory';

// The header at the top of the first page. -> the y where the letter's body starts
function drawHeader(doc, { L, W, logo, company, t = (v) => v }) {
  const y0 = doc.y;
  if (logo) {
    try { doc.image(logo, L, y0, { height: 40 }); } catch { /* the name below stands in */ }
  } else {
    doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text(t(company.name), L, y0, { width: W / 2 });
  }
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(t(company.name), L + W / 2, y0 + 5, { width: W / 2, align: 'right' });
  if (company.tagline) doc.font('Helvetica-BoldOblique').fontSize(9).fillColor(CYAN).text(t(company.tagline), L + W / 2, doc.y + 1, { width: W / 2, align: 'right' });
  const ruleY = Math.max(doc.y, y0 + 44) + 6;
  doc.moveTo(L, ruleY).lineTo(L + W, ruleY).lineWidth(1.5).strokeColor(CYAN).stroke();
  doc.y = ruleY + 14;
  doc.x = L;
  return doc.y;
}

// The footer on every page (written below the bottom margin on purpose), with "Page x of y" when the letter has more than one page
// and an optional line of small print above it.
function drawFooters(doc, { L, W, company, smallPrint = '', t = (v) => v }) {
  const range = doc.bufferedPageRange();
  const contact = [company.address, company.phone, company.email, company.website].filter(Boolean).join('   |   ');
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 44;
    doc.moveTo(L, fy - 8).lineTo(L + W, fy - 8).lineWidth(0.8).strokeColor(CYAN).stroke();
    if (smallPrint) doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(t(smallPrint), L, fy - 20, { width: W, align: 'center', lineBreak: false });
    if (contact) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t(contact), L, fy, { width: W, align: 'center', lineBreak: false });
    if (range.count > 1) doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Page ${i - range.start + 1} of ${range.count}`, L, fy + 13, { width: W, align: 'right', lineBreak: false });
  }
}

module.exports = { NAVY, CYAN, TEXT, MUTED, SIGNATORY_FALLBACK, drawHeader, drawFooters };
