// ---------------------------------------------------------------------------
// CANDIDATE FINGERPRINTS — the keys two profiles are compared on (pure functions, no database).
//
//   PHONE         the last ten digits of every number in the cell (+91 / 0 / spaces / dashes ignored; junk numbers
//                 such as 9999999999 or 1234567890 are never a key)                         -> CERTAIN
//   EMAIL         lower-case; gmail: dots in the name part and "+tag" are ignored,
//                 other domains: "+tag" ignored; googlemail.com = gmail.com                 -> CERTAIN
//   NAME_DOB      the name (words sorted, so "Rahul Kumar" = "Kumar Rahul") + date of birth -> LIKELY
//   RESUME_HASH   SHA-256 of the resume file's bytes                                         -> LIKELY
//   RESUME_BAND   LSH bands of a MinHash signature of the first 2,000 characters of resume text. A band hit is only
//                 a candidate: it is confirmed by comparing the two signatures (estimated Jaccard of the word sets)
//                 and is LIKELY only together with the same name, otherwise POSSIBLE.
//   NAME_CITY / NAME_COLLEGE / NAME_COMPANY   same name + the same city / college / current company -> POSSIBLE
//
// Everything here is deterministic so a profile gets the same keys every time (the backfill relies on it).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { phoneKeys, emailKey, nameKey, nameIsHintable } = require('./candidateDedupe');

const KINDS = ['PHONE', 'EMAIL', 'NAME_DOB', 'RESUME_HASH', 'RESUME_BAND', 'NAME_COMPANY', 'NAME_CITY', 'NAME_COLLEGE'];
// A key shared by more profiles than this is a placeholder / shared number (an agency's switchboard), not a person.
const MAX_SHARERS = { PHONE: 8, EMAIL: 8, NAME_DOB: 8, RESUME_HASH: 8, RESUME_BAND: 12, NAME_COMPANY: 6, NAME_CITY: 6, NAME_COLLEGE: 6 };

// --- phone / email ----------------------------------------------------------------
function normPhones(raw) { return phoneKeys(raw); }

function normEmail(raw) {
  const e = emailKey(raw);
  if (!e) return '';
  let [local, domain] = e.split('@');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.replace(/\+.*$/, '');
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return '';
  return `${local}@${domain}`;
}

// --- name / date of birth ----------------------------------------------------------
function normName(raw) { return nameKey(raw); }

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const pad = (n) => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  const thisYear = new Date().getFullYear();
  if (y < 1940 || y > thisYear - 14 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}
// "1995-03-12", "12/03/1995", "12-3-95", "12.03.1995", "12 Mar 1995", "March 12, 1995" -> "1995-03-12" ('' when unreadable).
function normDob(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2}|\d{4})$/);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += y > 30 ? 1900 : 2000;
    return validYmd(y, +m[2], +m[1]); // day first (India)
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})[\s,.-]+(\d{4})$/);
  if (m && MONTHS[m[2]]) return validYmd(+m[3], MONTHS[m[2]], +m[1]);
  m = s.match(/^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1]]) return validYmd(+m[3], MONTHS[m[1]], +m[2]);
  return '';
}

const slug = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// "Hyderabad, Telangana" -> "hyderabad"
function normCity(raw) { return slug(String(raw || '').split(/[,;/(]/)[0]); }
function normPlace(raw) { return slug(raw); }

// --- resume ---------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const TOKEN_LIMIT_CHARS = 2000;
function resumeTokens(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, TOKEN_LIMIT_CHARS);
  return [...new Set(t.match(/[a-z0-9]{2,}/g) || [])];
}
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  a.forEach((x) => { if (sb.has(x)) inter += 1; });
  return inter / (a.length + b.length - inter);
}

// MinHash: 32 hash functions of the form (a*h + b) mod 2^32 with fixed constants.
const SIG_LEN = 32;
const BANDS = 8; // 8 bands x 4 rows
const ROWS = SIG_LEN / BANDS;
const A = []; const B = [];
(() => { let x = 0x9e3779b9; const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; for (let i = 0; i < SIG_LEN; i += 1) { A.push((next() | 1) >>> 0); B.push(next()); } })();
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const mix = (a, h, b) => ((Math.imul(a, h) >>> 0) + b) >>> 0;

// Returns { sig: 256 hex chars, chars } or null when there is too little text to compare.
function resumeSignature(text) {
  const tokens = resumeTokens(text);
  if (tokens.length < 25) return null;
  const hs = tokens.map(fnv);
  const sig = [];
  for (let i = 0; i < SIG_LEN; i += 1) {
    let min = 0xffffffff;
    for (let j = 0; j < hs.length; j += 1) { const v = mix(A[i], hs[j], B[i]); if (v < min) min = v; }
    sig.push(min);
  }
  return { sig: sig.map((v) => v.toString(16).padStart(8, '0')).join(''), tokens: tokens.length };
}
function bandKeys(sigHex) {
  if (!sigHex || sigHex.length !== SIG_LEN * 8) return [];
  const out = [];
  for (let b = 0; b < BANDS; b += 1) out.push(`${b}:${sigHex.slice(b * ROWS * 8, (b + 1) * ROWS * 8)}`);
  return out;
}
// Estimated Jaccard similarity of the two word sets (0..1).
function sigSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < SIG_LEN; i += 1) if (a.slice(i * 8, i * 8 + 8) === b.slice(i * 8, i * 8 + 8)) same += 1;
  return same / SIG_LEN;
}

// --- all keys of one candidate ----------------------------------------------------
// `c` is a Candidate row (name, phone, email, dob, location, institute, currentCompany ...).
// `resume` is { shas: [hex...], sig: hex|null }.
function fingerprintsOf(c, resume = {}) {
  const out = [];
  const add = (kind, value) => { if (value) out.push({ kind, value }); };
  normPhones(c.phone).forEach((v) => add('PHONE', v));
  add('EMAIL', normEmail(c.email));
  const nk = normName(c.name);
  const hint = nameIsHintable(nk) || nk.replace(/ /g, '').length >= 8; // "Pravalika Chitturi" yes, "Ravi" no
  const dob = normDob(c.dob);
  if (nk && dob && nk.replace(/ /g, '').length >= 4) add('NAME_DOB', `${nk}|${dob}`);
  (resume.shas || []).forEach((s) => add('RESUME_HASH', String(s).toLowerCase()));
  bandKeys(resume.sig).forEach((v) => add('RESUME_BAND', v));
  if (hint) {
    const city = normCity(c.location);
    if (city) add('NAME_CITY', `${nk}|${city}`);
    const college = normPlace(c.institute);
    if (college.length >= 4) add('NAME_COLLEGE', `${nk}|${college}`);
    const company = normPlace(c.currentCompany);
    if (company.length >= 3) add('NAME_COMPANY', `${nk}|${company}`);
  }
  const seen = new Set();
  return out.filter((k) => { const id = `${k.kind}\u0001${k.value}`; if (seen.has(id)) return false; seen.add(id); return true; });
}

// --- classify a pair from the kinds that matched ------------------------------------
// kinds: Set of key kinds both share. extra: { nameAgreement: 'same'|'variant'|'different', similarity }
const LEVEL_RANK = { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1 };
function classify(kinds, extra = {}) {
  const reasons = [];
  let level = null;
  const up = (l) => { if (!level || LEVEL_RANK[l] > LEVEL_RANK[level]) level = l; };
  if (kinds.has('PHONE')) { reasons.push('phone'); up('CERTAIN'); }
  if (kinds.has('EMAIL')) { reasons.push('email'); up('CERTAIN'); }
  if (kinds.has('NAME_DOB')) { reasons.push('name_dob'); up('LIKELY'); }
  if (kinds.has('RESUME_HASH')) { reasons.push('resume_same'); up('LIKELY'); }
  if (kinds.has('RESUME_BAND') && (extra.similarity || 0) >= 0.75) {
    reasons.push('resume_like');
    up(extra.nameAgreement === 'same' || extra.nameAgreement === 'variant' ? 'LIKELY' : 'POSSIBLE');
  }
  if (kinds.has('NAME_CITY')) { reasons.push('name_city'); up('POSSIBLE'); }
  if (kinds.has('NAME_COLLEGE')) { reasons.push('name_college'); up('POSSIBLE'); }
  if (kinds.has('NAME_COMPANY')) { reasons.push('name_company'); up('POSSIBLE'); }
  return level ? { level, reasons } : null;
}

// Plain words for the screens.
const REASON_TEXT = {
  phone: 'Same phone number',
  email: 'Same email',
  name_dob: 'Same name and date of birth',
  resume_same: 'Same resume file',
  resume_like: 'Resume looks the same',
  name_city: 'Same name and city',
  name_college: 'Same name and college',
  name_company: 'Same name and company',
};
const REASON_SHORT = {
  phone: 'phone', email: 'email', name_dob: 'name + birth date', resume_same: 'resume file', resume_like: 'resume text',
  name_city: 'name + city', name_college: 'name + college', name_company: 'name + company',
};
const LEVEL_TEXT = { CERTAIN: 'Same person', LIKELY: 'Looks like the same person', POSSIBLE: 'Maybe the same person' };

module.exports = {
  KINDS, MAX_SHARERS, normPhones, normEmail, normName, normDob, normCity, normPlace, sha256,
  resumeTokens, jaccard, resumeSignature, bandKeys, sigSimilarity, fingerprintsOf, classify,
  REASON_TEXT, REASON_SHORT, LEVEL_TEXT, LEVEL_RANK, SIG_LEN,
};
