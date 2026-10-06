// ---------------------------------------------------------------------------
// EDITED RESUME -> "TeamLink format" PDF (pdfkit) and DOCX (resume_).
//
// The edited resume is held as structured sections:
//   { headline, summary, skills, experience, education, other }
// Every output made from it — the PDF, the DOCX and the text a CLIENT is
// served — passes through stripContact() first, so phone numbers, e-mail
// addresses, street addresses and profile links never leave TeamLink in a
// shared resume (the default the user asked for).
//
// DOCX is written by hand (WordprocessingML zipped with `archiver`, already a
// dependency) — no docx library is installed in this backend.
// ---------------------------------------------------------------------------
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { PassThrough } = require('stream');

const SECTION_KEYS = ['headline', 'summary', 'skills', 'experience', 'education', 'other'];
const SECTION_TITLES = {
  headline: 'Headline', summary: 'Professional Summary', skills: 'Key Skills', experience: 'Work Experience', education: 'Education', other: 'Additional Information',
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,6}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin|github|facebook|instagram|twitter)\.com\/\S*/gi;
const CONTACT_LINE = /^\s*(?:address|addr|permanent address|present address|current address|residential address|correspondence address|phone|ph|mobile|mob|cell|tel|telephone|contact(?:\s*(?:no|number|details))?|e-?mail|email id|mail|whatsapp|pin(?:\s*code)?|linkedin)\b\s*[.:\-–#]/i;

// Removes e-mail, phone numbers, address lines and profile links.
function stripContact(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !CONTACT_LINE.test(line))
    .map((line) => line
      .replace(EMAIL_RE, '')
      .replace(URL_RE, '')
      .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 10 ? '' : m))
      .replace(/\s*[|,•·]\s*([|,•·]\s*)+/g, ' | ')
      .replace(/^[\s|,•·:-]+|[\s|,•·:-]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEADINGS = [
  ['summary', /^(professional\s+summary|summary|career\s+objective|objective|profile(\s+summary)?|about\s+me|career\s+summary)\s*:?$/i],
  ['skills', /^((key|technical|core|professional)\s+skills|skills(\s*(&|and)\s*\w+)?|technical\s+expertise|competencies|core\s+competencies|it\s+skills|skill\s+set)\s*:?$/i],
  ['experience', /^((work|professional|employment)\s+(experience|history)|experience|work\s+history|career\s+history|employment|projects?)\s*:?$/i],
  ['education', /^(education(al)?(\s+(qualifications?|details|background))?|academic\s+(qualifications?|details|profile)|qualifications?)\s*:?$/i],
];

// Best-effort split of extracted text into the editor's sections.
function sectionsFromText(text, parsed = {}) {
  const out = { headline: '', summary: '', skills: '', experience: '', education: '', other: '' };
  let current = 'other';
  String(text || '').split('\n').forEach((raw) => {
    const line = raw.trim();
    const hit = line.length <= 48 ? HEADINGS.find(([, re]) => re.test(line)) : null;
    if (hit) { current = hit[0]; return; }
    out[current] += `${raw}\n`;
  });
  SECTION_KEYS.forEach((k) => { out[k] = out[k].replace(/\n{3,}/g, '\n\n').trim(); });
  if (!out.skills && parsed && Array.isArray(parsed.skills) && parsed.skills.length) out.skills = parsed.skills.join(', ');
  if (!out.education && parsed && Array.isArray(parsed.education) && parsed.education.length) out.education = parsed.education.join(', ');
  return out;
}

function cleanSections(input) {
  const out = {};
  SECTION_KEYS.forEach((k) => { out[k] = String((input && input[k]) || '').replace(/\r\n?/g, '\n').slice(0, 40000).trim(); });
  return out;
}

// Plain text of an edited version (what a client reads on screen).
function renderPlainText(sections, { name } = {}) {
  const s = cleanSections(sections);
  const parts = [];
  if (name) parts.push(name);
  if (s.headline) parts.push(s.headline);
  ['summary', 'skills', 'experience', 'education', 'other'].forEach((k) => {
    if (s[k]) parts.push(`${SECTION_TITLES[k].toUpperCase()}\n${s[k]}`);
  });
  return stripContact(parts.join('\n\n'));
}

// pdfkit's built-in fonts are WinAnsi.
const pdfText = (v) => String(v == null ? '' : v)
  .replace(/→/g, '->').replace(/₹/g, 'Rs.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[^\x00-\xFF•—–…€]/g, '');

const BLUE = '#1d4ed8';

function buildPdf({ name, sections, versionLabel, preparedBy = 'TeamLink' }) {
  const s = cleanSections(sections);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: `${name || 'Candidate'} — Resume`, Author: preparedBy } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 112;
    doc.rect(0, 0, doc.page.width, 6).fill(BLUE);
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9).text('TEAMLINK  ·  CANDIDATE PROFILE', 56, 24, { width, characterSpacing: 1 });
    doc.moveDown(0.6);
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(20).text(pdfText(name || 'Candidate'), { width });
    const headline = stripContact(s.headline);
    if (headline) doc.font('Helvetica').fontSize(11).fillColor('#334155').text(pdfText(headline), { width });
    doc.moveDown(0.4);
    doc.moveTo(56, doc.y).lineTo(56 + width, doc.y).lineWidth(0.6).strokeColor('#cbd5e1').stroke();
    doc.moveDown(0.6);
    ['summary', 'skills', 'experience', 'education', 'other'].forEach((k) => {
      const body = stripContact(s[k]);
      if (!body) return;
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(11).text(SECTION_TITLES[k].toUpperCase(), { width, characterSpacing: 0.5 });
      doc.moveDown(0.25);
      doc.fillColor('#111827').font('Helvetica').fontSize(10);
      if (k === 'skills') {
        doc.text(pdfText(body.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join('  •  ')), { width, lineGap: 2 });
      } else {
        body.split('\n').forEach((line) => {
          const l = line.trim();
          if (!l) { doc.moveDown(0.3); return; }
          if (/^[-•*·]\s*/.test(l)) doc.text(`•  ${pdfText(l.replace(/^[-•*·]\s*/, ''))}`, { width, indent: 8, lineGap: 1.5 });
          else doc.text(pdfText(l), { width, lineGap: 1.5 });
        });
      }
      doc.moveDown(0.8);
    });
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
      .text(pdfText(`Prepared by ${preparedBy}${versionLabel ? ` · ${versionLabel}` : ''} · contact details withheld`), 56, doc.page.height - 44, { width, align: 'center', lineBreak: false });
    doc.end();
  });
}

// --- DOCX ------------------------------------------------------------------
const xmlEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function para(text, { bold = false, size = 20, color = null, spacingAfter = 80, caps = false } = {}) {
  const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${caps ? '<w:caps/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/></w:rPr>`;
  return `<w:p><w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

function buildDocx({ name, sections, versionLabel, preparedBy = 'TeamLink' }) {
  const s = cleanSections(sections);
  const body = [];
  body.push(para('TEAMLINK · CANDIDATE PROFILE', { bold: true, size: 16, color: '1D4ED8' }));
  body.push(para(name || 'Candidate', { bold: true, size: 36, spacingAfter: 40 }));
  const headline = stripContact(s.headline);
  if (headline) body.push(para(headline, { size: 22, color: '334155', spacingAfter: 200 }));
  ['summary', 'skills', 'experience', 'education', 'other'].forEach((k) => {
    const text = stripContact(s[k]);
    if (!text) return;
    body.push(para(SECTION_TITLES[k], { bold: true, size: 22, color: '1D4ED8', caps: true, spacingAfter: 60 }));
    if (k === 'skills') body.push(para(text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join('  •  '), { spacingAfter: 200 }));
    else {
      text.split('\n').forEach((line) => { if (line.trim()) body.push(para(line.trim().replace(/^[-*·]\s*/, '• '))); });
      body.push(para('', { spacingAfter: 120 }));
    }
  });
  body.push(para(`Prepared by ${preparedBy}${versionLabel ? ` · ${versionLabel}` : ''} · contact details withheld`, { size: 14, color: '94A3B8' }));
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`
    + '</w:body></w:document>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', (c) => chunks.push(c));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.pipe(sink);
    archive.append(contentTypes, { name: '[Content_Types].xml' });
    archive.append(rels, { name: '_rels/.rels' });
    archive.append(documentXml, { name: 'word/document.xml' });
    archive.finalize();
  });
}

module.exports = {
  SECTION_KEYS, SECTION_TITLES, stripContact, sectionsFromText, cleanSections, renderPlainText, buildPdf, buildDocx,
};
