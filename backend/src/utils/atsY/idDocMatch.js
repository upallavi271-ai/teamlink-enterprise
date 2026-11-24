// ---------------------------------------------------------------------------
// ID DOCUMENT MATCH (ATS wave 2 Y, benchmark 15.14 "the applicant is who they claim to be"): the text of an uploaded ID document
// (PAN card, Aadhaar, passport, voter ID, driving licence) is read and compared with the candidate record:
//   name           every part of the profile's name on the document (initials count as a part)      -> match / partial / no match
//   date of birth  a date (or "Year of Birth") on the document vs the profile's date of birth           -> match / year only / no match
//   ID number      a PAN on the document vs the PAN saved in "IDs & consent" (encrypted store);
//                  an Aadhaar number (or its masked "XXXX XXXX 1234" form) vs the last 4 digits kept there -> match / no match / nothing saved
// The text comes from the document's own text layer, else OCR (utils/resumeOcr.js: the tesseract program on the server, the same as
// scanned resumes), else the words the recruiter types off the card. NOTHING of the document text is kept: only the result, and every
// number in it is MASKED (PAN AB•••••34F, Aadhaar XXXX XXXX 1234, passport •••••567, date of birth shown as the year only).
// Who: the internal ATS team that may see IDs (never the BDE team, never a client / candidate login); a Manager sees, does not run.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, lower } = C;
const PAN_RE = /\b([A-Z]{5}\d{4}[A-Z])\b/g;
const AADHAAR_RE = /\b([2-9]\d{3})\s?(\d{4})\s?(\d{4})\b/g;
const AADHAAR_MASKED_RE = /\b(?:X{4}|\*{4})\s?(?:X{4}|\*{4})\s?(\d{4})\b/gi;
const PASSPORT_RE = /\b([A-Z][1-9]\d{6})\b/g;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function kindOf(t) {
  const u = String(t || '').toUpperCase();
  if (/INCOME\s*TAX|PERMANENT\s*ACCOUNT\s*NUMBER/.test(u) || (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(u) && !/AADHAAR|UIDAI/.test(u))) return 'PAN card';
  if (/AADHAAR|UIDAI|UNIQUE\s*IDENTIFICATION|\bVID\b/.test(u)) return 'Aadhaar';
  if (/PASSPORT|REPUBLIC\s*OF\s*INDIA/.test(u) && /[A-Z][1-9]\d{6}/.test(u)) return 'Passport';
  if (/ELECTION\s*COMMISSION|ELECTOR/.test(u)) return 'Voter ID';
  if (/DRIVING\s*LICEN[CS]E|TRANSPORT/.test(u)) return 'Driving licence';
  return 'ID document';
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function datesIn(t) {
  const s = String(t || '');
  const out = [];
  let m;
  const a = /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)\d{2})\b/g; while ((m = a.exec(s))) if (Number(m[2]) <= 12 && Number(m[1]) <= 31) out.push(iso(m[3], m[2], m[1]));
  const b = /\b((?:19|20)\d{2})[/.-](\d{1,2})[/.-](\d{1,2})\b/g; while ((m = b.exec(s))) if (Number(m[2]) <= 12) out.push(iso(m[1], m[2], m[3]));
  const c = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/gi; while ((m = c.exec(s))) out.push(iso(m[3], MON[m[2].toLowerCase()], m[1]));
  const years = []; const y = /(?:year\s*of\s*birth|\byob\b)\s*[:\-]?\s*((?:19|20)\d{2})/gi; while ((m = y.exec(s))) years.push(m[1]);
  return { dates: [...new Set(out)], years: [...new Set(years)] };
}
function dobIso(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return iso(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); if (m) return iso(m[3], m[2], m[1]);
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function nameCheck(name, text) {
  const parts = C.normName(name);
  if (!parts.length) return { verdict: 'not on the profile', score: 0 };
  const words = new Set(lower(text).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean));
  const initials = new Set(String(text || '').match(/\b[A-Za-z]\b/g) || []);
  const hit = parts.filter((p) => words.has(p) || initials.has(p[0].toUpperCase()) || initials.has(p[0]));
  const full = parts.filter((p) => words.has(p)).length;
  if (full === parts.length) return { verdict: 'match', score: 100, found: `${full} of ${parts.length} name parts` };
  if (hit.length === parts.length && full >= 1) return { verdict: 'match (with initials)', score: 85, found: `${full} in full, the rest as initials` };
  if (full >= Math.ceil(parts.length / 2)) return { verdict: 'partial', score: 50, found: `${full} of ${parts.length} name parts` };
  return { verdict: 'no match', score: 0, found: `${full} of ${parts.length} name parts` };
}
function dobCheck(dob, text) {
  const want = dobIso(dob);
  const { dates, years } = datesIn(text);
  if (!want) return { verdict: 'not on the profile', score: null, document: dates.length ? `****-**-** (year ${dates[0].slice(0, 4)})` : (years[0] ? `year ${years[0]}` : 'none found') };
  if (dates.includes(want)) return { verdict: 'match', score: 100, document: `year ${want.slice(0, 4)}` };
  if (years.includes(want.slice(0, 4)) && !dates.length) return { verdict: 'year matches (the document gives only the year)', score: 70, document: `year ${want.slice(0, 4)}` };
  if (!dates.length && !years.length) return { verdict: 'no date found on the document', score: null, document: 'none found' };
  return { verdict: 'no match', score: 0, document: dates[0] ? `year ${dates[0].slice(0, 4)}` : `year ${years[0]}` };
}
async function savedIds(candidateId) {
  const S = require('../atsPlus/store'); // eslint-disable-line global-require
  const rows = await S.items.list('id-number', { refId: candidateId }).catch(() => []);
  const pan = rows.find((r) => r.status === 'PAN'); const aad = rows.find((r) => r.status === 'AADHAAR');
  let panFull = null;
  if (pan && pan.secret) { try { panFull = require('../secrets').decryptSecret(pan.secret); } catch { panFull = null; } } // eslint-disable-line global-require
  return { pan: pan ? { full: panFull, last4: pan.last4, masked: pan.masked } : null, aadhaar: aad ? { last4: aad.last4, masked: aad.masked } : null };
}
function idCheck(text, saved) {
  const u = String(text || '').toUpperCase();
  const out = [];
  const pans = [...new Set([...u.matchAll(PAN_RE)].map((m) => m[1]))];
  pans.forEach((p) => {
    let verdict = 'nothing saved to compare (add the PAN in IDs & consent)'; let score = null;
    if (saved.pan) { const same = saved.pan.full ? saved.pan.full === p : saved.pan.last4 === p.slice(-4); verdict = same ? 'match' : 'no match'; score = same ? 100 : 0; }
    out.push({ kind: 'PAN', document: C.maskPan(p), saved: saved.pan ? saved.pan.masked : null, verdict, score });
  });
  const aad = [...new Set([...[...u.matchAll(AADHAAR_RE)].map((m) => `${m[1]}${m[2]}${m[3]}`), ...[...u.matchAll(AADHAAR_MASKED_RE)].map((m) => `XXXXXXXX${m[1]}`)])];
  aad.slice(0, 2).forEach((a) => {
    let verdict = 'nothing saved to compare (add the Aadhaar last 4 in IDs & consent)'; let score = null;
    if (saved.aadhaar) { const same = saved.aadhaar.last4 === a.slice(-4); verdict = same ? 'match (last 4 digits)' : 'no match'; score = same ? 100 : 0; }
    out.push({ kind: 'Aadhaar', document: C.maskAadhaar(a), saved: saved.aadhaar ? saved.aadhaar.masked : null, verdict, score });
  });
  [...new Set([...u.matchAll(PASSPORT_RE)].map((m) => m[1]))].slice(0, 1).forEach((p) => out.push({ kind: 'Passport number', document: `•••••${p.slice(-3)}`, saved: null, verdict: 'found (no passport number is kept on the profile to compare)', score: null }));
  return out;
}

async function textOf(buf) {
  const RS = require('../candidateDocStore'); // eslint-disable-line global-require
  const kind = (RS.sniffDoc ? RS.sniffDoc(buf) : null) || require('../resumeStore').sniffKind(buf); // eslint-disable-line global-require
  if (!['pdf', 'jpg', 'png', 'docx'].includes(kind)) return { error: 'Upload the ID as a PDF, JPG or PNG.' };
  const RP = require('../resumeParse'); // eslint-disable-line global-require
  const first = await RP.extractText(buf, kind).catch(() => ({ text: '' }));
  let text = String((first && first.text) || '');
  let readBy = 'the document\'s own text';
  const OCR = require('../resumeOcr'); // eslint-disable-line global-require
  if (OCR.letterCount(text) < 15 && ['pdf', 'jpg', 'png'].includes(kind)) {
    const r = await OCR.ocrBuffer(buf, kind);
    if (r.text) { text = r.text; readBy = 'OCR (tesseract on the server)'; } else return { error: r.notInstalled ? 'This is a picture of the ID and OCR (the tesseract program) is not installed on the server yet: type what the card says instead.' : (r.error || 'No text could be read from the document: type what the card says instead.'), needsText: true };
  }
  if (OCR.letterCount(text) < 6) return { error: 'No text was found on the document: type what the card says instead.', needsText: true };
  return { text, readBy };
}

async function match(user, candidateId, { buffer = null, documentId = null, typed = '' } = {}) {
  const c = await prisma.candidate.findFirst({ where: { AND: [require('../scope').candidateWhere(user), { id: candidateId }] }, select: { id: true, name: true, dob: true } }); // eslint-disable-line global-require
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  let text = txt(typed, 4000); let readBy = text ? 'typed by the recruiter' : null; let doc = null;
  if (!text) {
    let buf = buffer;
    if (!buf && documentId) {
      doc = await prisma.candidateDocument.findFirst({ where: { id: String(documentId), candidateId: c.id, deletedAt: null } });
      if (!doc || !doc.file) return { status: 404, error: 'That document has no file on TeamLink.' };
      const p = require('../candidateDocStore').resolveDocFile(doc.file); // eslint-disable-line global-require
      if (!p) return { status: 404, error: 'The file is not on the server.' };
      buf = require('fs').readFileSync(p); // eslint-disable-line global-require
    }
    if (!buf) return { status: 400, error: 'Choose the ID document, or type what the card says.' };
    const r = await textOf(buf);
    if (r.error) return { status: 422, error: r.error, needsText: !!r.needsText };
    ({ text, readBy } = r);
  }
  const saved = await savedIds(c.id);
  const name = nameCheck(c.name, text);
  const dob = dobCheck(c.dob, text);
  const ids = idCheck(text, saved);
  const parts = [name.score, dob.score, ...ids.map((i) => i.score)].filter((v) => v != null);
  const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : 0;
  const bad = name.verdict === 'no match' || dob.verdict === 'no match' || ids.some((i) => i.verdict === 'no match');
  const verdict = bad ? 'Does not match - check with the person' : (score >= 85 && ids.some((i) => i.score === 100) ? 'Matches the profile' : (score >= 60 ? 'Mostly matches - check what is missing' : 'Not enough to say'));
  const result = { docKind: kindOf(text), name: { verdict: name.verdict, found: name.found || null }, dob, ids, readBy };
  await C.ensure();
  const id = newId();
  await x('INSERT INTO "AtsYIdMatch" ("id","candidateId","documentId","docKind","result","score","verdict","readBy","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, c.id, doc ? doc.id : null, result.docKind, JSON.stringify(result), score, verdict, readBy, user.id, C.who(user), nowIso());
  await C.logAudit({ userId: user.id, action: `ID document checked against the profile (${result.docKind})`, entity: 'Candidate', entityId: c.id, toValue: `${verdict} (${score})` });
  return { id, score, verdict, ...result, note: 'The document text is not kept. Numbers are shown masked.' };
}
async function history(candidateId) {
  await C.ensure();
  return (await q('SELECT * FROM "AtsYIdMatch" WHERE "candidateId" = ? ORDER BY "at" DESC LIMIT 20', candidateId)).map((r) => ({ id: r.id, documentId: r.documentId, docKind: r.docKind, score: Number(r.score), verdict: r.verdict, readBy: r.readBy, byName: r.byName, at: r.at, result: C.json(r.result, {}) }));
}
async function documents(candidateId) {
  const rows = await prisma.candidateDocument.findMany({ where: { candidateId, deletedAt: null, file: { not: null } }, select: { id: true, docType: true, name: true, fileName: true, mime: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.filter((d) => /id|aadhaar|pan|passport|voter|licen|kyc/i.test(`${d.docType} ${d.name} ${d.fileName}`) || /^(image\/|application\/pdf)/.test(d.mime || '')).map((d) => ({ id: d.id, label: `${d.docType}: ${d.name}`, fileName: d.fileName, at: d.createdAt }));
}

module.exports = { match, history, documents, nameCheck, dobCheck, idCheck, kindOf, datesIn };
