// ---------------------------------------------------------------------------
// RESUME TEXT EXTRACTION + FREE PARSER (resume_).
//
//   extractText(buffer, kind)      PDF (pdf-parse) · DOCX (mammoth) · DOC
//                                  (word-extractor) -> { text, error }
//                                  (a scanned PDF / a JPG / PNG photo: OCR in
//                                  extractAndParse, utils/resumeOcr.js)
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

// RTF -> plain text: the header groups (fonts, colours, styles, document info, "\*" destinations) are skipped with their nested
// braces, \par / \line become new lines, \'hh and \uN become characters, every other control word is dropped.
function rtfToText(src) {
  const s = String(src || '');
  let out = '';
  const skipDepth = [];
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '{') {
      depth += 1;
      const ahead = s.slice(i + 1, i + 14);
      if (/^\\(\*|fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|rsidtbl|xmlnstbl|generator)/.test(ahead)) skipDepth.push(depth);
      continue; // eslint-disable-line no-continue
    }
    if (c === '}') { if (skipDepth.length && skipDepth[skipDepth.length - 1] === depth) skipDepth.pop(); depth -= 1; continue; } // eslint-disable-line no-continue
    if (skipDepth.length) continue; // eslint-disable-line no-continue
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { out += nx; i += 1; continue; } // eslint-disable-line no-continue
      if (nx === "'") { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16) || 32); i += 3; continue; } // eslint-disable-line no-continue
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i, i + 40));
      if (m) {
        const word = m[1];
        if (word === 'par' || word === 'line' || word === 'row') out += '\n';
        else if (word === 'tab' || word === 'cell') out += ' ';
        else if (word === 'u' && m[2]) { let n = Number(m[2]); if (n < 0) n += 65536; out += String.fromCharCode(n); if (s[i + m[0].length] === '?') i += 1; }
        i += m[0].length - 1;
        continue; // eslint-disable-line no-continue
      }
      i += 1; // a control symbol such as \~ or \-
      continue; // eslint-disable-line no-continue
    }
    if (c !== '\r' && c !== '\n') out += c;
  }
  return out;
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
    } else if (kind === 'jpg' || kind === 'png') {
      // a photo of a resume has no text layer: extractAndParse reads it with OCR (utils/resumeOcr.js)
      text = '';
    } else if (kind === 'doc') {
      // eslint-disable-next-line global-require
      const WordExtractor = require('word-extractor');
      const doc = await new WordExtractor().extract(buffer);
      text = doc.getBody() || '';
    } else if (kind === 'rtf') {
      // RTF resumes (ATS audit 2026-11-18, Q71): the control words are dropped and the text kept
      text = rtfToText(buffer.toString('latin1'));
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

// --- other languages (Telugu / Hindi) ---------------------------------------
// The free parser reads English words. A resume written (partly) in Telugu or Hindi script still gives its e-mail, phone and name:
// Telugu / Devanagari digits are read as 0-9, and a name line in either script (or after "పేరు:" / "नाम:") is taken. Skills,
// education and experience words stay English-only here; the AI pass (RESUME_AI_EXTRACT=1) translates the whole resume.
const SCRIPTS = [['Telugu', /[ఀ-౿]/g], ['Hindi', /[ऀ-ॿ]/g]];
function detectLanguages(text) {
  const t = String(text || '');
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const found = [];
  SCRIPTS.forEach(([lang, re]) => { const n = (t.match(re) || []).length; if (n >= 8) found.push({ lang, chars: n }); });
  const other = found.reduce((a, b) => a + b.chars, 0);
  const langs = found.sort((a, b) => b.chars - a.chars).map((x) => x.lang);
  if (latin >= 20 || !langs.length) { if (latin >= other) langs.unshift('English'); else langs.push('English'); }
  return [...new Set(langs)];
}
// Telugu (U+0C66-0C6F) and Devanagari (U+0966-096F) digits -> 0-9, so phones and years are found.
function asciiDigits(text) {
  return String(text || '').replace(/[౦-౯]/g, (d) => String(d.charCodeAt(0) - 0x0C66)).replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}
const NAME_LABEL = /^(name|full\s*name|candidate\s*name|resume|curriculum vitae|cv|పేరు|పూర్తి\s*పేరు|नाम|पूरा\s*नाम)\s*[:\-–]?\s*/i;
const INDIC_NAME = /^[ఀ-౿ऀ-ॿ][ఀ-౿ऀ-ॿ.' ]{1,50}$/;
const INDIC_HEADINGS = /రెజ్యూమ్|బయోడేటా|వివరాలు|परिचय|बायोडाटा|विवरण|रिज्यूमे/;

function parseName(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
  for (const line of lines) {
    const clean = line.replace(NAME_LABEL, '').trim();
    if (/^[A-Za-z][A-Za-z.' ]{2,50}$/.test(clean) && clean.split(/\s+/).length >= 2 && clean.split(/\s+/).length <= 5
      && !/resume|curriculum|vitae|profile|objective|summary/i.test(clean)) return clean.replace(/\s+/g, ' ');
  }
  // A Telugu / Hindi resume: the name written in that script (a labelled line first, else a short line at the top).
  for (const line of lines) {
    const labelled = NAME_LABEL.test(line);
    const clean = line.replace(NAME_LABEL, '').trim();
    const words = clean.split(/\s+/).length;
    if (INDIC_NAME.test(clean) && words >= (labelled ? 1 : 2) && words <= 5 && !INDIC_HEADINGS.test(clean)) return clean.replace(/\s+/g, ' ');
  }
  return null;
}

// --- CURRENT CTC, EXPECTED CTC, NOTICE PERIOD (ATS audit 2026-11-18, Q77/Q78) ----------------------------------------------------
// Read the way the "Fill from file" form reads them (utils/docFill.js labelled / salaryRange / noticeOf), plus a monthly salary
// ("35,000 per month" = 4.2 LPA) and the phrase inside a sentence ("my current CTC is 6 LPA"). Stored as "4.5 LPA" / "30 Days".
const lakhWord = (v) => (v == null ? null : `${Math.round(v * 100) / 100} LPA`);
function salaryValue(raw) {
  if (!raw) return null;
  const DF = require('./docFill'); // eslint-disable-line global-require
  const monthly = /per\s*month|\/\s*month|\bp\.?\s*m\b\.?|monthly|\/\s*mo\b|\bpm\b/i.test(raw);
  let [v] = DF.salaryRange(raw);
  if (v == null) {
    const n = /(\d{1,3}(?:,\d{2,3})+|\d{4,8})/.exec(String(raw).replace(/₹|rs\.?|inr/gi, ' '));
    if (n) { const rupees = Number(n[1].replace(/,/g, '')); v = monthly ? (rupees * 12) / 100000 : (rupees >= 10000 ? rupees / 100000 : null); }
  } else if (monthly && v < 5) v *= 12; // "35,000 per month" came back as 0.35 lakh a year
  return v != null && v > 0 && v <= 500 ? lakhWord(v) : null;
}
function noticeValue(raw) {
  if (!raw) return null;
  const DF = require('./docFill'); // eslint-disable-line global-require
  const n = DF.noticeOf(raw);
  return n === '7 Days' ? '15 Days' : n;
}
function parseCompensation(text) {
  const DF = require('./docFill'); // eslint-disable-line global-require
  const find = (labels, inline) => {
    const v = DF.labelled(text, labels, { maxLen: 120 });
    if (v) return { raw: v, how: 'labelled' };
    const m = inline.exec(text);
    return m ? { raw: m[0], how: 'sentence' } : null;
  };
  const cur = find(['current ctc', 'current salary', 'present ctc', 'present salary', 'current package', 'current compensation', 'annual ctc', 'ctc', 'salary', 'cctc'],
    /(?:current|present|existing)\s*(?:ctc|salary|package|compensation)[^\n]{0,50}/i);
  const exp = find(['expected ctc', 'expected salary', 'expected package', 'expected compensation', 'salary expectation', 'ectc'],
    /expect(?:ed|ing|ation)\s*(?:ctc|salary|package|compensation)?[^\n]{0,50}/i);
  const np = find(['notice period', 'notice', 'np', 'joining time', 'availability to join'],
    /(?:notice\s*period[^.\n]{0,40}|serving\s*notice[^.\n]{0,40}|immediate(?:ly)?\s*(?:joiner|available|joining)[^.\n]{0,20})/i);
  return {
    currentCtc: cur ? salaryValue(cur.raw) : null,
    expectedCtc: exp ? salaryValue(exp.raw) : null,
    noticePeriod: np ? noticeValue(np.raw) : null,
    how: { currentCtc: cur && cur.how, expectedCtc: exp && exp.how, noticePeriod: np && np.how },
  };
}

// --- CONFIDENCE + MISSING INFORMATION (ATS audit 2026-11-18, Q79/Q93/Q95/Q96) --------------------------------------------------
// high = read from a labelled line or an exact pattern (e-mail, phone), medium = worked out (dates, a sentence, a guess at the name),
// low = thin evidence, AI = filled by the AI pass. `review` lists what a person should check before saving; `missing` what the resume
// does not say at all.
const KEY_FIELDS = ['name', 'email', 'phone', 'totalExperienceYears', 'highestEducation', 'location', 'skills', 'currentCtc', 'expectedCtc', 'noticePeriod'];
function confidenceOf(p, text, comp) {
  const c = {};
  const labelledName = /^\s*(name|full\s*name|candidate\s*name)\s*[:\-–]/im.test(text);
  c.name = p.name ? (labelledName ? 'high' : 'medium') : null;
  c.email = p.emails && p.emails.length ? 'high' : null;
  c.phone = p.phones && p.phones.length ? 'high' : null;
  c.totalExperienceYears = p.totalExperienceYears != null ? (p.experienceSource === 'stated' ? 'high' : 'medium') : null;
  c.highestEducation = p.highestEducation ? 'medium' : null;
  c.location = p.location ? 'medium' : null;
  c.skills = p.skills && p.skills.length ? (p.skills.length >= 3 ? 'high' : 'low') : null;
  ['currentCtc', 'expectedCtc', 'noticePeriod'].forEach((k) => { c[k] = p[k] ? (comp.how[k] === 'labelled' ? 'high' : 'medium') : null; });
  return c;
}
function reviewLists(c) {
  return {
    missing: KEY_FIELDS.filter((k) => !c[k]),
    review: KEY_FIELDS.filter((k) => c[k] === 'low' || c[k] === 'medium' || c[k] === 'AI'),
  };
}

// --- SKILL CLASSIFICATION (ATS audit 2026-11-18, Q97) -----------------------------------------------------------------------------
// Each skill found goes into one group: soft skills, a DOMAIN (Medical, Education, Manufacturing, Finance, Sales & HR) or technical (the rest).
const SOFT = /communicat|leadership|team ?work|team player|problem solv|negotiat|time management|presentation|interpersonal|customer service|adaptab|critical thinking|creativ|multitask|decision making|stakeholder|people management|mentor|conflict/i;
const DOMAINS = [
  ['Medical', /\bicu\b|clinical|patient|nurs|cardio|radiolog|patholog|pharma|\bgcp\b|regulatory|trial|surgery|surgical|anaesth|anesth|gynae|paediat|pediat|ortho|dental|physio|medical|hospital|emergency|ot\b|opd|ipd|phlebotomy|lab tech|ecg|dialysis/i],
  ['Education', /teach|curriculum|counsell|lesson|classroom|pedagog|academic|lectur|tutor|syllabus|admission|exam|b\.?ed|student/i],
  ['Manufacturing', /\bcnc\b|quality control|quality assurance|\bqc\b|\bqa\b|lean|six sigma|kaizen|5s\b|welding|production|assembly|machin|lathe|plc|scada|autocad|solidworks|maintenance|tool room|casting|forging|injection mould|sheet metal|iso 9001|tpm\b/i],
  ['Finance', /account|tally|\bgst\b|taxation|\btds\b|audit|payroll|financ|book ?keeping|\bsap fico\b|reconcil|ledger|invoice|budget/i],
  ['Sales & HR', /business development|lead generation|\bsales\b|marketing|recruit|sourcing|talent acquisition|onboarding|\bhr\b|human resource|crm|cold call|client acquisition|account management/i],
];
function classifySkills(skills) {
  const out = { technical: [], soft: [], domain: {} };
  (skills || []).forEach((s) => {
    const k = String(s || '').trim();
    if (!k) return;
    if (SOFT.test(k)) { out.soft.push(k); return; }
    const d = DOMAINS.find(([, re]) => re.test(k));
    if (d) { (out.domain[d[0]] = out.domain[d[0]] || []).push(k); return; }
    out.technical.push(k);
  });
  return out;
}

async function parseResumeText(text, { vocabulary } = {}) {
  const languages = detectLanguages(text);
  const t = asciiDigits(text);
  const lower = t.toLowerCase();
  const vocab = vocabulary || await skillVocabulary();
  const skills = vocab.filter((s) => textHasTerm(lower, s));
  const exp = parseExperienceYears(t);
  const edu = parseEducation(t);
  let comp = { currentCtc: null, expectedCtc: null, noticePeriod: null, how: {} };
  try { comp = parseCompensation(t); } catch { /* the other fields stand */ }
  const out = {
    name: parseName(t),
    emails: [...new Set((t.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].slice(0, 5),
    phones: parsePhones(t),
    skills: [...new Set(skills)].slice(0, 80),
    totalExperienceYears: exp.years,
    experienceSource: exp.how,
    education: edu.list,
    highestEducation: edu.highest,
    location: parseLocation(t),
    currentCtc: comp.currentCtc,
    expectedCtc: comp.expectedCtc,
    noticePeriod: comp.noticePeriod,
    // ['English'] for most; ['Telugu', 'English'] etc. when another script is in the text (the AI pass translates it)
    languages,
    otherLanguage: languages.some((l) => l !== 'English'),
  };
  out.confidence = confidenceOf(out, t, comp);
  Object.assign(out, reviewLists(out.confidence));
  return out;
}

// --- the AI pass -------------------------------------------------------------------------------------------------------------
// RESUME_AI_EXTRACT=1 = always (the app's own AI, as before). 2026-11-18 (ATS audit Q74/Q91): when it is NOT set to 0 and a FREE fast
// AI key is saved (Administration > Integrations > Fast AI, utils/fastAi.js), the AI pass runs on that free model too. It only FILLS
// GAPS the free parser left; any failure keeps the free result. RESUME_AI_EXTRACT=0 switches every AI pass off.
const aiSetting = () => String(process.env.RESUME_AI_EXTRACT || '').trim().toLowerCase();
const aiEnabled = () => /^(1|true|yes|on)$/.test(aiSetting());
const aiOff = () => /^(0|false|no|off)$/.test(aiSetting());
async function fastAiReady() {
  if (aiOff()) return false;
  try { return await require('./fastAi').hasKey(); } catch { return false; } // eslint-disable-line global-require
}

const AI_SYSTEM = 'You extract fields from a resume. Return JSON with keys: name (string|null), emails (string[]), '
  + 'phones (string[]), skills (string[] of short skill names, lowercase), totalExperienceYears (number|null), '
  + 'highestEducation (string|null), education (string[]), location (current city, string|null), '
  + 'currentCtc (current yearly salary as written, e.g. "4.5 LPA" or "35000 per month", string|null), '
  + 'expectedCtc (expected yearly salary as written, string|null), noticePeriod (e.g. "30 days", "2 months", "Immediate", string|null). '
  + 'Use null when the resume does not say it - never guess a salary or notice period. '
  + 'The resume may be in Telugu, Hindi or another language: translate every value to English (names in English letters).';
async function parseWithAi(text, { fast = false } = {}) {
  const ai = require('./ai'); // eslint-disable-line global-require
  if (fast) {
    const r = await require('./fastAi').chat(AI_SYSTEM, [{ role: 'user', content: String(text).slice(0, 15000) }], { json: true, maxTokens: 900, timeoutMs: 20000, fallbackToApp: false }); // eslint-disable-line global-require
    const out = ai.parseJsonLoose(r.text);
    return out && typeof out === 'object' && !Array.isArray(out) ? out : null;
  }
  const out = await ai.chatJson(AI_SYSTEM, [{ role: 'user', content: String(text).slice(0, 15000) }]);
  return out && typeof out === 'object' ? out : null;
}

// SCANNED RESUMES (OCR, 2026-11-17): a PDF whose text layer is empty or nearly empty (fewer than 80 letters), or a photo
// (JPG / PNG), is read by utils/resumeOcr.js (the free `tesseract` program, one at a time, low priority, 60 s at most). When
// OCR is not installed the resume is still saved, marked "Scanned resume - text could not be read (OCR not installed on the
// server)" so the recruiter sees why nothing was read. -> { text, ocr: { used, pages, languages, error, notInstalled } | null }
async function withOcr(buffer, kind, text, error) {
  if (!['pdf', 'jpg', 'png'].includes(kind)) return { text, error, ocr: null };
  const OCR = require('./resumeOcr'); // eslint-disable-line global-require
  if (OCR.letterCount(text) >= OCR.MIN_LETTERS) return { text, error, ocr: null };
  const r = await OCR.ocrBuffer(buffer, kind);
  const ocr = {
    used: !!(r.text && OCR.letterCount(r.text) > OCR.letterCount(text)), pages: r.pages || 0, languages: r.languages || null,
    error: r.error || null, notInstalled: !!r.notInstalled,
  };
  if (ocr.used) {
    // the little text the PDF had (a header line, a page number) stays in front of what was read off the pages
    const joined = [text, r.text].filter(Boolean).join('\n\n').slice(0, MAX_TEXT);
    return { text: joined, error: null, ocr };
  }
  return { text, error: r.error || error, ocr };
}

async function extractAndParse(buffer, kind) {
  const first = await extractText(buffer, kind);
  const { text, error, ocr } = await withOcr(buffer, kind, first.text, first.error);
  if (!text) {
    return {
      text: '', parsed: null, parser: 'none', ocr,
      error: error || (kind === 'jpg' || kind === 'png' ? 'No text was found in this picture.' : 'No text found in this file (a scanned image needs OCR, which is not available).'),
    };
  }
  const parsed = await parseResumeText(text);
  if (ocr) parsed.ocr = { used: ocr.used, pages: ocr.pages, languages: ocr.languages };
  let parser = ocr && ocr.used ? 'free+ocr' : 'free';
  const useFast = !aiEnabled() && await fastAiReady();
  if (aiEnabled() || useFast) {
    try {
      const a = await parseWithAi(text, { fast: useFast });
      if (a && !a.clarify) {
        parser = useFast ? 'free+fast-ai' : 'free+claude';
        const conf = parsed.confidence || {};
        ['name', 'totalExperienceYears', 'highestEducation', 'location'].forEach((k) => { if (parsed[k] == null && a[k] != null) { parsed[k] = a[k]; conf[k] = 'AI'; } });
        // salary and notice from the AI are normalised the same way as the free parser's ("4.5 LPA", "30 Days")
        if (!parsed.currentCtc && a.currentCtc) { const v = salaryValue(String(a.currentCtc)); if (v) { parsed.currentCtc = v; conf.currentCtc = 'AI'; } }
        if (!parsed.expectedCtc && a.expectedCtc) { const v = salaryValue(String(a.expectedCtc)); if (v) { parsed.expectedCtc = v; conf.expectedCtc = 'AI'; } }
        if (!parsed.noticePeriod && a.noticePeriod) { const v = noticeValue(String(a.noticePeriod)); if (v) { parsed.noticePeriod = v; conf.noticePeriod = 'AI'; } }
        ['emails', 'phones', 'skills', 'education'].forEach((k) => {
          if (Array.isArray(a[k])) parsed[k] = [...new Set([...(parsed[k] || []), ...a[k].map((v) => (k === 'skills' || k === 'emails' ? String(v).toLowerCase() : String(v)).trim()).filter(Boolean)])];
        });
        if (!conf.email && parsed.emails && parsed.emails.length) conf.email = 'AI';
        if (!conf.phone && parsed.phones && parsed.phones.length) conf.phone = 'AI';
        if (!conf.skills && parsed.skills && parsed.skills.length) conf.skills = 'AI';
        parsed.confidence = conf;
        Object.assign(parsed, reviewLists(conf));
      }
    } catch { /* free result stands */ }
  }
  // a nearly empty scan that OCR could not read: the little text is kept and parsed, and the reason is shown
  return { text, parsed, parser, ocr, error: ocr && !ocr.used && ocr.error ? ocr.error : null };
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
  extractText, parseResumeText, extractAndParse, skillVocabulary, textHasTerm, parsePhones, aiEnabled, resumeOwnerCheck, rtfToText, parseCompensation, salaryValue, noticeValue,
  detectLanguages, asciiDigits, parseName, parseExperienceYears, BUILTIN_SKILLS,
};
