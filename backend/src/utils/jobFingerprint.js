// ---------------------------------------------------------------------------
// JOB FINGERPRINT — the normaliser behind "is this job already on file?" (utils/jobDupes.js).
// Pure functions, no database. The same idea as utils/candidateFingerprint.js, for jobs (requirements).
//
//   titleTokens(title)    'MED-2180 Staff Nurse' / 'REQ-4284 - Staff Nurse' / 'URGENT opening for Staff Nurses'
//                         -> ['nurse','staff']   (lower case, punctuation, codes, stop words, 'urgent', trailing
//                         '-2' / '(3 nos)' counts dropped; Asst = Assistant, Sr = Senior, Prof = Professor, plural -> single)
//   specTokens(spec)      the specialisation / department of study (Pathology, cse, OT Nurses ...)
//   cityTokens(location)  the cities named in a location ('Bachupally, Hyderabad' -> bachupally, hyderabad)
//   expBand('3-5 yrs')    experience band; salaryBand('₹14L - ₹20L') salary band (lakh per year)
//   textTokens / jaccard  description similarity
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const STOP = new Set([
  'a', 'an', 'the', 'for', 'of', 'in', 'at', 'and', 'or', 'to', 'with', 'on', 'all', 'req', 'requirement', 'requirements', 'required',
  'urgent', 'urgently', 'immediate', 'immediately', 'opening', 'openings', 'vacancy', 'vacancies', 'hiring', 'hire', 'wanted',
  'needed', 'need', 'job', 'jobs', 'position', 'positions', 'post', 'posts', 'asap', 'hurry', 'nos', 'no', 'role', 'roles', 'new',
]);
// short forms -> the full word (applied to a token after punctuation is gone)
const SYN = {
  asst: 'assistant', assit: 'assistant', assistent: 'assistant', asstt: 'assistant',
  assoc: 'associate', asso: 'associate',
  prof: 'professor', proff: 'professor', professer: 'professor',
  sr: 'senior', snr: 'senior', jr: 'junior', jnr: 'junior',
  exec: 'executive', execs: 'executive', mgr: 'manager', mngr: 'manager', manger: 'manager',
  engg: 'engineer', engr: 'engineer', eng: 'engineer',
  dev: 'developer', devloper: 'developer', developper: 'developer',
  lect: 'lecturer', lecturar: 'lecturer', lecturers: 'lecturer',
  dr: 'doctor', doc: 'doctor', physician: 'doctor',
  sn: 'nurse', nursing: 'nurse', nurses: 'nurse',
  tech: 'technician', techn: 'technician', technicians: 'technician',
  cardiology: 'cardiology', cardiologist: 'cardiology',
  radiologist: 'radiology', radiographer: 'radiographer',
  banglore: 'bangalore', bengaluru: 'bangalore', bangaluru: 'bangalore', hyd: 'hyderabad', secunderabad: 'secunderabad',
  teacher: 'teacher', teachers: 'teacher', faculties: 'faculty',
  hr: 'hr', ctc: 'ctc',
};
// a token that is only a job code: MED-2180 / REQ-4284 / EDU2711 / MFG-1186
const CODE_RE = /^(?:[a-z]{2,5}-?\d{2,6})$/;

function cleanText(v) {
  return String(v == null ? '' : v)
    // a job code in the title: MED-2180 / REQ-4284 / EDU2711 (hyphenated anywhere, or glued at the start)
    .replace(/\b[A-Za-z]{2,5}-\d{2,6}\b/g, ' ')
    .replace(/^\s*[A-Za-z]{2,5}\d{3,6}\b/, ' ')
    .replace(/[^\x00-\x7f]+/g, (m) => m.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .toLowerCase()
    // a trailing count: "Dialysis Technician-1", "Staff Nurse (3 nos)", "2 openings"
    .replace(/\(\s*\d+\s*(?:nos?\.?|positions?|openings?|vacancies|posts?)?\s*\)/g, ' ')
    .replace(/\b\d+\s*(?:nos?\.?|positions?|openings?|vacancies|posts?)\b/g, ' ')
    .replace(/[-–—]\s*\d{1,2}\s*$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function singular(t) {
  if (t.length > 6 && /ologist$/.test(t)) return `${t.slice(0, -3)}y`; // dermatologist -> dermatology
  if (t === 'anaesthesia' || t === 'anesthesiology' || t === 'anaesthesiology') return 'anesthesia';
  if (t.length > 4 && /ies$/.test(t)) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ses|xes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && /s$/.test(t) && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

function tokensOf(v, { dropCodes = true } = {}) {
  const raw = cleanText(v).split(' ').filter(Boolean);
  const out = [];
  for (const w of raw) {
    if (dropCodes && CODE_RE.test(w) && /\d/.test(w)) continue;
    if (/^\d+$/.test(w)) continue; // a bare number is a count / a code part
    if (STOP.has(w)) continue;
    let t = SYN[w] || w;
    t = SYN[t] || t;
    t = singular(t);
    t = SYN[t] || t;
    if (!t || STOP.has(t) || t.length < 2) continue;
    out.push(t);
  }
  return [...new Set(out)].sort();
}

const memo = (fn) => { const m = new Map(); return (v) => { const k = v == null ? '' : String(v); let r = m.get(k); if (r === undefined) { r = fn(k); if (m.size > 30000) m.clear(); m.set(k, r); } return r; }; };
const titleTokens = memo((title) => tokensOf(title));
const specTokens = memo((spec) => tokensOf(spec));

// The key a title is stored under: the tokens, sorted ('Assistant Professor' = 'Professor, Assistant').
const titleKey = (title) => titleTokens(title).join(' ');

// "Nurse — Hospital management - Banglore": the part after the dash is the specialisation when the field is empty.
function titleParts(title) {
  const m = String(title || '').split(/\s[—–-]\s|\s—\s|—/);
  return m.length > 1 ? { role: m[0], tail: m.slice(1).join(' ') } : { role: String(title || ''), tail: '' };
}

// The words that say WHAT the job is: role words + specialisation words.
// ('Assistant Professor' + 'Pathology') and ('Assistant Professor — Pathology') are the same identity.
function identityTokens(title, spec) {
  return [...new Set([...titleTokens(title), ...specTokens(spec)])].sort();
}

function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}
// how much of the SMALLER set is inside the larger one
function containment(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  return inter / Math.min(A.size, B.size);
}

// --- location --------------------------------------------------------------------------
const PLACE_JUNK = new Set(['telangana', 'andhra', 'pradesh', 'india', 'ap', 'ts', 'tn', 'tamil', 'nadu', 'karnataka', 'kerala', 'district', 'dist', 'near', 'road', 'rd', 'main', 'nagar']);
const cityTokens = memo(cityTokensRaw);
function cityTokensRaw(location) {
  const parts = String(location || '').split(/[,/|;&]|\band\b/i).map((p) => cleanText(p)).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const w = p.split(' ').map((x) => SYN[x] || x).filter((x) => x && !PLACE_JUNK.has(x));
    if (w.length) out.push(w.join(' '));
  }
  return [...new Set(out)];
}
// -> 'same' | 'different' | 'unknown'
function sameLocation(a, b) {
  const A = cityTokens(a); const B = cityTokens(b);
  if (!A.length || !B.length) return 'unknown';
  const sB = new Set(B);
  if (A.some((x) => sB.has(x))) return 'same';
  // one name inside the other ("Hyderabad" vs "Hyderabad Hitec City") counts as the same place
  if (A.some((x) => B.some((y) => (x.length > 3 && y.includes(x)) || (y.length > 3 && x.includes(y))))) return 'same';
  return 'different';
}

// --- experience / salary ---------------------------------------------------------------
function numbersIn(v) {
  return (String(v == null ? '' : v).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}
// '3-5 years' -> '3-5'; '5+' -> '5-'; 'Fresher' -> '0-1'; blank -> ''
function expBand(exp) {
  const s = String(exp || '').toLowerCase();
  if (!s.trim()) return '';
  if (/fresher/.test(s)) return '0-1';
  const n = numbersIn(s);
  if (!n.length) return '';
  const lo = Math.floor(n[0]); const hi = n.length > 1 ? Math.ceil(n[1]) : null;
  return hi == null ? `${lo}-` : `${lo}-${hi}`;
}
// the salary as lakh per year -> a band of 2 lakh ('14-16'); 'Negotiable' / blank -> ''
function salaryBand(sal) {
  const s = String(sal == null ? '' : sal).toLowerCase().replace(/,/g, '');
  const n = numbersIn(s);
  if (!n.length) return '';
  let v = n[0];
  if (/\bk\b|k\b/.test(s) && v > 0 && v < 1000 && !/\bl\b|lakh|lpa/.test(s)) v = (v * 12) / 100; // 40k per month -> lakh a year
  else if (!/lakh|lpa|\bl\b|\d\s*l\b/.test(s) && v >= 1000) v /= 100000; // a rupee figure
  if (!(v > 0)) return '';
  const lo = Math.floor(v / 2) * 2;
  return `${lo}-${lo + 2}`;
}
const employmentKey = (t) => String(t || '').toLowerCase().replace(/[^a-z]/g, '');

// --- description text ------------------------------------------------------------------
const TEXT_STOP = new Set(['the', 'and', 'for', 'with', 'are', 'will', 'you', 'our', 'have', 'has', 'this', 'that', 'from', 'your', 'who', 'must', 'should', 'can', 'all', 'any', 'able', 'etc', 'job', 'description', 'responsibilities', 'requirements', 'qualification', 'qualifications', 'skills', 'experience', 'years', 'year']);
function textTokens(text, max = 300) {
  // light and fast: descriptions are long and there are thousands of jobs
  const words = String(text == null ? '' : text).slice(0, 2000).toLowerCase().split(/[^a-z0-9]+/);
  const out = new Set();
  for (const w of words) {
    if (w.length < 3 || TEXT_STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(singular(w));
    if (out.size >= max) break;
  }
  return out;
}
function skillTokens(skills) {
  return new Set(String(skills || '').toLowerCase().split(/[,;/|\n]/).map((s) => cleanText(s)).filter(Boolean));
}
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

module.exports = {
  titleTokens, specTokens, titleKey, titleParts, identityTokens, jaccard, containment, cityTokens, sameLocation, expBand, salaryBand,
  employmentKey, textTokens, skillTokens, tokensOf, cleanText, sha,
};
