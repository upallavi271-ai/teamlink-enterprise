// ---------------------------------------------------------------------------
// RESUME TEXT EXTRACTION + FREE PARSER (resume_).
//
//   extractText(buffer, kind)      PDF (pdf-parse) · DOCX (mammoth) · DOC
//                                  (word-extractor) -> { text, error }
//   parseResumeText(text, opts)    skills (vocabulary: the skills every
//                                  requirement asks for + candidate
//                                  specialisations + a built-in list), total
//                                  experience in years, education, current
//                                  location, emails, phones, a probable name
//   extractAndParse(buffer, kind)  both, plus the OPTIONAL Claude pass
//
// The free parser is the default and always runs. Claude extraction is behind
// RESUME_AI_EXTRACT=1 (default OFF — the Anthropic account may be low on
// credits); when on, its answer only FILLS GAPS the free parser left, and any
// failure silently falls back to the free result.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { citiesOf, CITY_ALIASES } = require('./locationMatch');

const MAX_TEXT = 200000;

// pdf-parse v2 (modern pdf.js). v1.1.1's bundled pdf.js fails on this
// server ("bad XRef entry") once pdfkit is loaded, so v2 is used.
async function pdfText(buffer) {
  // eslint-disable-next-line global-require
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const r = await parser.getText();
    return String(r.text || '').replace(/^[ \t]*-- \d+ of \d+ --[ \t]*$/gm, '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractText(input, kind) {
  try {
    // A fresh, un-pooled copy: a multipart slice (or a small Buffer.concat)
    // shares a larger ArrayBuffer at a non-zero offset, and pdf.js inside
    // pdf-parse reads the underlying ArrayBuffer — "bad XRef entry".
    const buffer = Buffer.alloc(input.length);
    input.copy(buffer);
    let text = '';
    if (kind === 'pdf') {
      text = await pdfText(buffer);
    } else if (kind === 'docx') {
      // eslint-disable-next-line global-require
      const mammoth = require('mammoth');
      const out = await mammoth.extractRawText({ buffer });
      text = out.value || '';
    } else if (kind === 'doc') {
      // eslint-disable-next-line global-require
      const WordExtractor = require('word-extractor');
      const doc = await new WordExtractor().extract(buffer);
      text = doc.getBody() || '';
    }
    text = String(text).replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, MAX_TEXT), error: null };
  } catch (err) {
    return { text: '', error: `Text could not be extracted (${String(err && err.message || err).slice(0, 120)})` };
  }
}

// --- vocabulary ------------------------------------------------------------
const BUILTIN_SKILLS = [
  'java', 'javascript', 'typescript', 'python', 'c', 'c++', 'c#', '.net', 'asp.net', 'php', 'ruby', 'go', 'golang',
  'kotlin', 'swift', 'scala', 'r', 'sql', 'mysql', 'postgresql', 'oracle', 'mongodb', 'redis', 'sql server',
  'html', 'css', 'react', 'react.js', 'angular', 'vue', 'node.js', 'nodejs', 'express', 'spring', 'spring boot',
  'django', 'flask', 'laravel', 'hibernate', 'microservices', 'rest api', 'graphql', 'aws', 'azure', 'gcp',
  'docker', 'kubernetes', 'jenkins', 'git', 'linux', 'devops', 'terraform', 'ansible', 'selenium', 'manual testing',
  'automation testing', 'jira', 'agile', 'scrum', 'power bi', 'tableau', 'excel', 'machine learning',
  'deep learning', 'data analysis', 'data science', 'sap', 'salesforce', 'android', 'ios', 'flutter',
  'react native', 'figma', 'photoshop', 'autocad', 'solidworks', 'catia', 'plc', 'scada', 'six sigma', 'lean',
  'quality control', 'quality assurance', 'gmp', 'cnc', 'production', 'maintenance', 'tally', 'gst', 'accounting',
  'payroll', 'recruitment', 'sales', 'marketing', 'digital marketing', 'seo', 'customer service', 'communication',
  'nursing', 'icu', 'patient care', 'pharmacovigilance', 'clinical research', 'medical coding', 'phlebotomy',
  'teaching', 'lesson planning',
];

const GENERIC_SPECS = new Set(['cse', 'ece', 'eee', 'eie', 'ece', 'mech', 'mechanical', 'civil', 'it', 'cs', 'software', 'engineering',
  'computerscience', 'computerscienceengineering', 'electronics', 'electrical', 'science', 'arts', 'commerce', 'general', 'other',
  'others', 'na', 'nil', 'none', 'any', 'mpc', 'bipc', 'mec', 'cec']);
let vocabCache = null; // { at, list }
const VOCAB_TTL_MS = 10 * 60 * 1000;
const splitList = (v) => String(v || '').split(/[,;|/\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s && s.length <= 40);

// The skills worth looking for: everything any requirement asks for, the
// candidate specialisations already on file, and the built-in list.
async function skillVocabulary() {
  if (vocabCache && Date.now() - vocabCache.at < VOCAB_TTL_MS) return vocabCache.list;
  const set = new Set(BUILTIN_SKILLS);
  try {
    const reqs = await prisma.requirement.findMany({ select: { skills: true, goodToHaveSkills: true } });
    reqs.forEach((r) => { splitList(r.skills).forEach((s) => set.add(s)); splitList(r.goodToHaveSkills).forEach((s) => set.add(s)); });
    const specs = await prisma.candidate.groupBy({ by: ['specialization'], _count: { _all: true } });
    // A specialisation is a skill only when it is not a degree name or a
    // generic branch word ("B.Tech", "CSE", "Software").
    specs.forEach((g) => {
      const s = String(g.specialization || '').trim().toLowerCase();
      if (s && s.length >= 3 && s.length <= 40 && !GENERIC_SPECS.has(s.replace(/[^a-z]/g, ''))
        && !DEGREES.some(([, , re]) => re.test(s))) set.add(s);
    });
  } catch { /* the built-in list still works */ }
  const list = [...set].filter((s) => s.length >= 1);
  vocabCache = { at: Date.now(), list };
  return list;
}

// Whole-word(ish) test that copes with "c++", ".net", "node.js".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termCache = new Map();
function termRegex(term) {
  const t = String(term || '').trim().toLowerCase();
  if (termCache.has(t)) return termCache.get(t);
  const re = new RegExp(`(^|[^a-z0-9+#])${escapeRe(t).replace(/\\ /g, '[\\s-]*').replace(/ /g, '[\\s-]*')}(?![a-z0-9+#])`, 'i');
  if (termCache.size > 5000) termCache.clear();
  termCache.set(t, re);
  return re;
}
function textHasTerm(lowerText, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t || !lowerText) return false;
  // single letters ("c", "r") only count when written as a listed skill
  if (t.length === 1) return new RegExp(`(^|[,|•:;\\n]\\s*)${escapeRe(t)}\\s*([,|•;\\n]|$)`, 'im').test(lowerText);
  return termRegex(t).test(lowerText);
}

// --- field parsers ---------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,6}/g;

function parsePhones(text) {
  const out = new Set();
  (String(text).match(PHONE_RE) || []).forEach((raw) => {
    const d = raw.replace(/\D/g, '');
    if (d.length < 10 || d.length > 13) return;
    const last10 = d.slice(-10);
    if (/^[6-9]\d{9}$/.test(last10) || d.length >= 11) out.add(d.length === 12 && d.startsWith('91') ? `+91 ${last10}` : (d.length === 10 ? last10 : `+${d}`));
  });
  return [...out].slice(0, 5);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function parseExperienceYears(text) {
  const t = String(text);
  // 1. A stated total: "5 years of experience", "Total Experience: 6.5 yrs",
  //    "8+ years", "4 Years 6 Months".
  let best = null;
  const stated = /(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)(?:\s*(?:and\s*)?(\d{1,2})\s*(?:months?|mos?))?[^.\n]{0,40}?(?:experience|exp\b)/gi;
  let m;
  while ((m = stated.exec(t))) {
    const v = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
    if (v > 0 && v <= 45 && (best == null || v > best)) best = v;
  }
  const labelled = /(?:total\s+)?experience\s*[:\-–]\s*(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)?(?:\s*(\d{1,2})\s*(?:months?|mos?))?/gi;
  while ((m = labelled.exec(t))) {
    const v = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
    if (v > 0 && v <= 45 && (best == null || v > best)) best = v;
  }
  if (best != null) return { years: Math.round(best * 10) / 10, how: 'stated' };

  // 2. Employment date ranges ("Jan 2019 – Present", "03/2016 - 08/2020").
  //    Only ranges with a MONTH or "present" count, so education year spans
  //    ("2012 - 2016") are not mistaken for jobs. Overlaps are merged.
  const now = new Date();
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
  const datePart = `(?:${mon}\\s*[',]?\\s*(\\d{4})|(\\d{1,2})[/.-](\\d{4}))`;
  const range = new RegExp(`${datePart}\\s*(?:-|–|—|to|till)\\s*(?:${datePart}|(present|current|till\\s*date|now|date))`, 'gi');
  const spans = [];
  while ((m = range.exec(t))) {
    const startMonth = m[1] ? MONTHS[m[1].toLowerCase().slice(0, 3)] : Number(m[3]) - 1;
    const startYear = Number(m[2] || m[4]);
    let endMonth; let endYear;
    if (m[9]) { endMonth = now.getMonth(); endYear = now.getFullYear(); } else {
      endMonth = m[5] ? MONTHS[m[5].toLowerCase().slice(0, 3)] : Number(m[7]) - 1;
      endYear = Number(m[6] || m[8]);
    }
    if (!(startYear > 1960 && endYear >= startYear && endYear <= now.getFullYear() + 1)) continue;
    const s = startYear * 12 + (startMonth || 0);
    const e = endYear * 12 + (endMonth || 0);
    if (e > s) spans.push([s, e]);
  }
  if (!spans.length) return { years: null, how: null };
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0; let [cs, ce] = spans[0];
  spans.slice(1).forEach(([s, e]) => { if (s <= ce) ce = Math.max(ce, e); else { total += ce - cs; cs = s; ce = e; } });
  total += ce - cs;
  const years = Math.round((total / 12) * 10) / 10;
  return years > 0 && years <= 45 ? { years, how: 'dates' } : { years: null, how: null };
}

// [label, rank, pattern]
const DEGREES = [
  ['Ph.D', 9, /\bph\.?\s?d\b|\bdoctorate\b/i],
  ['MD', 8, /\bm\.?d\.?\s*\(|\bdoctor of medicine\b|\bm\.d\b/i],
  ['MS', 8, /\bm\.s\.?\s*\((?:ortho|gen|surgery)/i],
  ['M.Tech', 7, /\bm\.?\s?tech\b/i],
  ['M.E', 7, /\bm\.e\.?\b(?!\w)/],
  ['MCA', 7, /\bm\.?c\.?a\b/i],
  ['MBA', 7, /\bm\.?b\.?a\b|\bpgdm\b/i],
  ['M.Pharm', 7, /\bm\.?\s?pharm/i],
  ['M.Sc', 7, /\bm\.?\s?sc\b/i],
  ['M.Com', 7, /\bm\.?\s?com\b/i],
  ['M.Ed', 7, /\bm\.?\s?ed\b/i],
  ['MA', 6, /\bm\.a\.?\b|\bmaster of arts\b/i],
  ['MBBS', 6, /\bm\.?b\.?b\.?s\b/i],
  ['BDS', 6, /\bb\.?d\.?s\b/i],
  ['BAMS', 6, /\bb\.?a\.?m\.?s\b/i],
  ['BHMS', 6, /\bb\.?h\.?m\.?s\b/i],
  ['Pharm.D', 6, /\bpharm\.?\s?d\b/i],
  ['B.Tech', 5, /\bb\.?\s?tech\b/i],
  ['B.E', 5, /\bb\.e\.?\b(?!\w)|\bbachelor of engineering\b/i],
  ['B.Arch', 5, /\bb\.?\s?arch\b/i],
  ['B.Pharm', 5, /\bb\.?\s?pharm/i],
  ['B.Sc Nursing', 5, /\bb\.?\s?sc\.?\s*\(?nursing/i],
  ['BCA', 5, /\bb\.?c\.?a\b/i],
  ['BBA', 5, /\bb\.?b\.?a\b|\bbbm\b/i],
  ['B.Sc', 5, /\bb\.?\s?sc\b/i],
  ['B.Com', 5, /\bb\.?\s?com\b/i],
  ['B.Ed', 5, /\bb\.?\s?ed\b/i],
  ['BA', 4, /\bb\.a\.?\b|\bbachelor of arts\b/i],
  ['CA', 6, /\bchartered accountant\b/i],
  ['GNM', 3, /\bg\.?n\.?m\b/i],
  ['ANM', 3, /\ba\.?n\.?m\b/i],
  ['Diploma', 3, /\bdiploma\b|\bpolytechnic\b/i],
  ['ITI', 2, /\bi\.?t\.?i\b/i],
  ['Intermediate', 1, /\bintermediate\b|\b12th\b|\bhsc\b|\b10\s?\+\s?2\b/i],
  ['SSC', 0, /\bs\.?s\.?c\b|\b10th\b|\bmatriculation\b/i],
];

function parseEducation(text) {
  const found = DEGREES.filter(([, , re]) => re.test(text)).map(([label, rank]) => ({ label, rank }));
  found.sort((a, b) => b.rank - a.rank);
  return { list: found.map((f) => f.label), highest: found.length ? found[0].label : null };
}

const KNOWN_CITY_KEYS = new Set(Object.keys(CITY_ALIASES).map((c) => c.toLowerCase().replace(/[^a-z]/g, '')));
function parseLocation(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  // A labelled value first: "Current Location: Hyderabad", "Address: …, Pune".
  for (const line of lines.slice(0, 120)) {
    const m = /^(?:current\s+location|present\s+location|location|city|address|residence|current\s+address|present\s+address)\s*[:\-–]\s*(.+)$/i.exec(line);
    if (m) {
      const known = citiesOf(m[1]).find((c) => KNOWN_CITY_KEYS.has(c.key));
      if (known) return known.label;
    }
  }
  // Otherwise the first known city named in the header area.
  for (const line of lines.slice(0, 25)) {
    const known = citiesOf(line).find((c) => KNOWN_CITY_KEYS.has(c.key));
    if (known) return known.label;
  }
  return null;
}

function parseName(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    const clean = line.replace(/^(name|resume|curriculum vitae|cv)\s*[:\-–]?\s*/i, '').trim();
    if (/^[A-Za-z][A-Za-z.' ]{2,50}$/.test(clean) && clean.split(/\s+/).length >= 2 && clean.split(/\s+/).length <= 5
      && !/resume|curriculum|vitae|profile|objective|summary/i.test(clean)) return clean.replace(/\s+/g, ' ');
  }
  return null;
}

async function parseResumeText(text, { vocabulary } = {}) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const vocab = vocabulary || await skillVocabulary();
  const skills = vocab.filter((s) => textHasTerm(lower, s));
  const exp = parseExperienceYears(t);
  const edu = parseEducation(t);
  return {
    name: parseName(t),
    emails: [...new Set((t.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].slice(0, 5),
    phones: parsePhones(t),
    skills: [...new Set(skills)].slice(0, 80),
    totalExperienceYears: exp.years,
    experienceSource: exp.how,
    education: edu.list,
    highestEducation: edu.highest,
    location: parseLocation(t),
  };
}

// --- optional Claude pass (RESUME_AI_EXTRACT=1) -----------------------------
const aiEnabled = () => /^(1|true|yes|on)$/i.test(String(process.env.RESUME_AI_EXTRACT || ''));

async function parseWithAi(text) {
  // eslint-disable-next-line global-require
  const ai = require('./ai');
  const system = 'You extract fields from a resume. Return JSON with keys: name (string|null), emails (string[]), '
    + 'phones (string[]), skills (string[] of short skill names, lowercase), totalExperienceYears (number|null), '
    + 'highestEducation (string|null), education (string[]), location (current city, string|null). Use null when unknown.';
  const out = await ai.chatJson(system, [{ role: 'user', content: String(text).slice(0, 15000) }]);
  return out && typeof out === 'object' ? out : null;
}

async function extractAndParse(buffer, kind) {
  const { text, error } = await extractText(buffer, kind);
  if (!text) return { text: '', parsed: null, parser: 'none', error: error || 'No text found in this file (a scanned image needs OCR, which is not available).' };
  const parsed = await parseResumeText(text);
  let parser = 'free';
  if (aiEnabled()) {
    try {
      const a = await parseWithAi(text);
      if (a && !a.clarify) {
        parser = 'free+claude';
        ['name', 'totalExperienceYears', 'highestEducation', 'location'].forEach((k) => { if (parsed[k] == null && a[k] != null) parsed[k] = a[k]; });
        ['emails', 'phones', 'skills', 'education'].forEach((k) => {
          if (Array.isArray(a[k])) parsed[k] = [...new Set([...(parsed[k] || []), ...a[k].map((v) => (k === 'skills' || k === 'emails' ? String(v).toLowerCase() : String(v)).trim()).filter(Boolean)])];
        });
      }
    } catch { /* free result stands */ }
  }
  return { text, parsed, parser, error: null };
}

// --- "is this resume really this person's?" ---------------------------------
// (user, 2026-10-03: a resume of someone else was uploaded on a profile and
// nothing said so.) Same rule as the Resume tab's resumeOwnerCheck():
//   phone or e-mail on the resume = the profile's  -> same person
//   the resume has contact details, none match, and its name shares no word
//   with the profile's name                         -> probably someone else
// Returns { ok, soft, identity: { name, phone, email } } (identity = what the
// resume says).
const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const nameWords = (v) => String(v || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function resumeOwnerCheck(parsed, person) {
  const identity = parsed ? {
    name: parsed.name || null,
    phone: (parsed.phones || [])[0] || null,
    email: (parsed.emails || [])[0] || null,
  } : null;
  if (!parsed || !person) return { ok: true, identity };
  const rPhones = (parsed.phones || []).map(digits10).filter((x) => x.length === 10);
  const rEmails = (parsed.emails || []).map((e) => String(e).toLowerCase().trim());
  const pPhones = [person.phone, person.alternatePhone].map(digits10).filter((x) => x.length === 10);
  const pEmail = String(person.email || '').toLowerCase().trim();
  if (pPhones.some((p) => rPhones.includes(p)) || (pEmail && rEmails.includes(pEmail))) return { ok: true, identity };
  const rWords = nameWords(parsed.name);
  const pWords = nameWords(person.name);
  // One common word ("Kumar", "Shaik") is not enough: two words must agree,
  // or the whole of a one-word name ("Baksi").
  const shared = rWords.filter((w) => pWords.includes(w)).length;
  const nameShared = shared > 0 && shared >= Math.min(2, rWords.length, pWords.length);
  const resumeHasContact = rPhones.length > 0 || rEmails.length > 0;
  if (!resumeHasContact) return { ok: true, identity };
  if (nameShared) return { ok: true, soft: true, identity };
  return { ok: false, identity };
}

module.exports = {
  extractText, parseResumeText, extractAndParse, skillVocabulary, textHasTerm, parsePhones, aiEnabled, resumeOwnerCheck,
};
