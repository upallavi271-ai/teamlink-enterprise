// ---------------------------------------------------------------------------
// JOB POST WRITER — the helpers around the generator in utils/jobText.js
// ("Write the job posts", user 2026-10-10).
//
// PURE helpers (no database):
//   publishable(text)        keeps what may go on a public job post and drops the
//                            internal tracker notes imported jobs carry ("Follow-up
//                            history", "Remarks", "client asking to negotiate" ...)
//   extractFromText(text)    simple keyword extraction of experience / salary /
//                            education / location / skills from the description.
//                            Every item carries the exact phrase it came from and is
//                            shown to the poster as "check this" — never auto-saved.
//   formatSalary(raw, type)  the stored salary as annual LPA text
//   checklistFor(...)        the 5 "check before posting" points from the real gaps
//   lineDiff(a, b)           what changed between two texts (AI polish)
//   stripBlanks(text)        a text without its "[ ]" lines (public feeds)
//
// STORE (AppSetting, one row per job: key jobposts.saved.<requirementId>):
//   { texts: {key: text}, gen: {key: hash of the generated text when saved},
//     savedAt, byId, byName }
// The poster's edits are kept per job; "Reset to generated" removes a key.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const PREFIX = 'jobposts.saved.';
// Every text a job has. title / tags are the small fields next to a board's text.
const TEXT_KEYS = ['master', 'naukri', 'naukriTitle', 'naukriTags', 'shine', 'indeed', 'indeedTitle', 'linkedin', 'linkedinPost'];
const MAX_TEXT = 30000;
const BLANK = '[ ]';

const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const hashText = (t) => crypto.createHash('sha1').update(String(t == null ? '' : t)).digest('hex').slice(0, 12);

// ---- internal notes -----------------------------------------------------------
// Imported jobs (the tracker sheets) keep the team's own notes in the description.
// They must never reach a public post.
const NOTE_LABEL = /^\s*(?:[-*•]\s*)?(?:(?:remarks?|follow[- ]?up(?: history)?|agreement|specialization column note|specialisation column note|status note|requirement as recorded|package\s*\/\s*experience|bed capacity|location link|internal note|note to team|recruiter|bde|tl)\s*[:\-–—]|(?:created from|named on the source sheet|imported from)\b)/i;
const NOTE_WORDS = /\b(follow[- ]?up|no response|not answered|not picked|call not|whats?\s?app|what's app|negotiat\w*|on ?hold|no requirement|no need|no agreement|source sheet|tracker|the sheet|re-?import|no login yet|interview history|messaged|told to)\b/i;
const NOTE_DATE = /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
const NOTE_HONORIFIC = /\b(sir|madam|ma'?am)\b/i;

function isInternalLine(line) {
  const s = String(line || '');
  return NOTE_LABEL.test(s) || NOTE_WORDS.test(s) || NOTE_DATE.test(s) || NOTE_HONORIFIC.test(s);
}

// -> { text, dropped: [line...] }
function publishable(text) {
  const src = clean(text);
  if (!src) return { text: '', dropped: [] };
  const keep = [];
  const dropped = [];
  let inNote = false;
  src.split('\n').forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { inNote = false; keep.push(''); return; }
    const labelled = NOTE_LABEL.test(line);
    const indented = /^\s{2,}|^\s*[•*-]\s/.test(line);
    if (labelled || (inNote && indented)) { inNote = true; dropped.push(line.trim()); return; }
    inNote = false;
    // A real sentence can still hold a stray note: keep only the clean sentences.
    const parts = line.split(/(?<=[.!?])\s+/);
    const good = parts.filter((p) => { const bad = isInternalLine(p); if (bad) dropped.push(p.trim()); return !bad; });
    if (good.length) keep.push(good.join(' '));
  });
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

// ---- extraction ("Fill from the job description") -----------------------------------
const STOP_AFTER = /\s+(?:candidates?|languages?|language|local|experience|exp|location|rotational|negotiable|and decided|incentives?|only|preferably|must|should|shift|bed|package|requirement|remarks?|agreement|follow)\b/i;
const EDU = [
  ['MBBS', /\bMBBS\b/], ['MD', /\bM\.?D\b(?!\w)/], ['MS', /\bM\.?S\b(?![\w.])/], ['DNB', /\bDNB\b/],
  ['B.Sc', /\bB\.?\s?Sc\b/i], ['M.Sc', /\bM\.?\s?Sc\b/i], ['B.Tech', /\bB\.?\s?Tech\b/i], ['M.Tech', /\bM\.?\s?Tech\b/i],
  ['B.E', /\bB\.E\b/], ['MBA', /\bMBA\b/], ['Ph.D', /\bPh\.?\s?D\b/i], ['Diploma', /\bdiploma\b/i], ['GNM', /\bGNM\b/], ['ANM', /\bANM\b/],
  ['B.Pharm', /\bB\.?\s?Pharm\b/i], ['M.Pharm', /\bM\.?\s?Pharm\b/i], ['Post graduate', /\bpost[- ]?graduate\b/i], ['Graduate', /\bgraduate\b/i],
];
const A_ONE = '(?:₹|rs\\.?\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:lpa|lpm|lakhs?|lacs?|crores?|cr|k|l)?(?:\\s*(?:per\\s+(?:month|year|annum)|\\/\\s*(?:month|year|annum|mo|yr)|a\\s+month|pm|pa))?';
const AMOUNT = new RegExp(`^${A_ONE}(?:\\s*(?:to|-|–|—)\\s*${A_ONE})?\\+?`, 'i');
// Only the uppercase forms count for the two-letter ones (MD / MS are common words in lower case).
const UPPER_ONLY = new Set(['MD', 'MS']);

function extractFromText(text) {
  const t = clean(text).replace(/[ \t]+/g, ' ');
  const out = {};
  if (!t) return out;

  // Experience: "Experience-2 -3 Years", "Exp: 0 To 5 years", "5+ years of experience"
  let m = /\b(?:work |professional |relevant )?(?:experience|expereince|expereience|expereiece|exp)\b[\s:\-–—]*(\d{1,2})(?:\s*(?:-|–|—|to)\s*(\d{1,2}))?\s*(\+)?\s*(?:years?|yrs?)?/i.exec(t);
  if (!m) m = /(\d{1,2})(?:\s*(?:-|–|—|to)\s*(\d{1,2}))?\s*(\+)?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+)?experience/i.exec(t);
  if (m) {
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : null;
    if (lo <= 40 && (hi === null || (hi >= lo && hi <= 45))) {
      out.experience = { value: hi !== null ? `${lo}-${hi}` : `${lo}${m[3] ? '+' : ''}`, phrase: m[0].trim() };
    }
  }

  // Salary: "Salary-3LPM to 5LPM", "CTC: 4-6 LPA", "Budget 18K to 25K"
  // (every label is tried in turn: "Package / experience:" is a heading, not a pay)
  const salRe = /\b(?:salary range|salary|ctc|pay|package|budget|compensation)\b\s*[:\-–—]?\s*/gi;
  for (m = salRe.exec(t); m && !out.salary; m = salRe.exec(t)) {
    const rest = t.slice(salRe.lastIndex).split('\n')[0].slice(0, 70);
    if (rest.length < 2) continue; // eslint-disable-line no-continue
    let v = rest.replace(/^[\s:\-–—]+/, '');
    const stop = STOP_AFTER.exec(v);
    if (stop) v = v.slice(0, stop.index);
    v = v.replace(/[\s,;.(]+$/, '').trim();
    const amt = AMOUNT.exec(v); // only the amount itself ("18K To 25K"), never the words after it
    if (amt) out.salary = { value: amt[0].trim(), phrase: `${m[0]}${amt[0]}`.trim().slice(0, 80) };
  }

  // Education
  const found = [];
  EDU.forEach(([name, re]) => {
    const hit = re.exec(t);
    if (hit && (!UPPER_ONLY.has(name) || hit[0] === hit[0].toUpperCase())) found.push(name);
  });
  // "Graduate" is dropped when "Post graduate" is there.
  const edu = found.filter((x) => !(x === 'Graduate' && found.includes('Post graduate')));
  if (edu.length) out.education = { value: edu.slice(0, 4).join(', '), phrase: edu.slice(0, 4).join(', ') };

  // Location only when the text says so: "Location: Hyderabad", "Work location - Pune"
  m = /\b(?:work\s+)?location\b(?!\s*link)[\s:\-–—]+([A-Za-z][A-Za-z .,&/-]{2,40})/i.exec(t);
  if (m) {
    const v = m[1].split(/\s{2,}|\n/)[0].replace(STOP_AFTER, '').replace(/[\s,.;-]+$/, '').trim();
    if (v && v.length >= 3) out.location = { value: v, phrase: m[0].trim().slice(0, 60) };
  }

  // Skills: "Key skills: a, b, c" / "Skills - a, b"
  m = /\b(?:key |must[- ]have |required |technical )?skills\b\s*[:\-–—]\s*([^\n]{3,200})/i.exec(t);
  if (m) {
    const list = m[1].split(/[,;|]/).map((s) => s.trim().replace(/[.]+$/, '')).filter((s) => s && s.length <= 40);
    if (list.length) out.skills = { value: list.slice(0, 15).join(', '), phrase: m[0].trim().slice(0, 100) };
  }
  return out;
}

// ---- salary ---------------------------------------------------------------------------
// The job form stores a band like "₹14L - ₹20L" (lakh a year). Shown as "₹14 - ₹20 LPA".
// Anything else typed by hand is left exactly as typed (never guessed).
const NUM = '(\\d+(?:\\.\\d+)?)';
function formatSalary(raw, type) {
  const s = clean(raw);
  if (!s || s === '—' || s === '-') return '';
  if (/best in industry|as per industry|negotiable|not disclosed/i.test(s)) return s;
  const annual = !type || /annual|ctc|year/i.test(String(type));
  let m = new RegExp(`^₹?\\s*${NUM}\\s*L\\s*[-–]\\s*₹?\\s*${NUM}\\s*L$`, 'i').exec(s);
  if (m) return `₹${m[1]} - ₹${m[2]} LPA`;
  m = new RegExp(`^₹?\\s*${NUM}\\s*L\\s*\\+$`, 'i').exec(s);
  if (m) return `₹${m[1]} LPA and above`;
  m = new RegExp(`^up to\\s*₹?\\s*${NUM}\\s*L$`, 'i').exec(s);
  if (m) return `Up to ₹${m[1]} LPA`;
  m = new RegExp(`^₹?\\s*${NUM}\\s*L$`, 'i').exec(s);
  if (m) return `₹${m[1]} LPA`;
  // A plain rupee amount a year: 600000 -> ₹6 LPA (only for an annual job; a monthly one is left alone)
  m = /^₹?\s*(\d{1,3}(?:,\d{2,3})+|\d{5,9})$/.exec(s);
  if (m && annual) {
    const lakh = Number(m[1].replace(/,/g, '')) / 100000;
    if (lakh >= 0.5) return `₹${Number.isInteger(lakh) ? lakh : lakh.toFixed(2).replace(/0+$/, '')} LPA`;
  }
  return s;
}

// ---- the 5 checks before posting ----------------------------------------------------------
// status: 'ok' (nothing to do) | 'check' (read it) | 'fix' (something is missing or wrong)
function checklistFor({ facts, missing, warnings, leak, publicLink }) {
  const has = (k) => !(missing || []).some((m) => m.key === k);
  const item = (key, label, status, detail) => ({ key, label, status, detail });
  const out = [];

  if (!has('salary')) out.push(item('salary', 'Salary', 'fix', 'The requirement has no salary, so the posts show [ ]. Type it, or write "Best in industry" if that is the plan.'));
  else if (/best in industry/i.test(facts.salary)) out.push(item('salary', 'Salary', 'check', 'It says "Best in industry". Check that the client agreed to hide the pay.'));
  else out.push(item('salary', 'Salary', 'check', `Posts show: ${facts.salary}. Check it is the pay the client agreed, and per year (LPA) or per month.`));

  if (!has('location')) out.push(item('location', 'Location and work mode', 'fix', 'The requirement has no location, so the posts show [ ]. Type the city.'));
  else out.push(item('location', 'Location and work mode', 'check', `Posts show: ${facts.location}${facts.workMode ? ` (${facts.workMode})` : ''}. Check the city and onsite / hybrid / remote.`));

  const contactMissing = !has('contactEmail');
  if (contactMissing) out.push(item('contact', 'Contact details', 'fix', 'No contact email or name is set. Add one here, or in Company Setup.'));
  else if (!publicLink) out.push(item('contact', 'Contact details', 'check', `Contact: ${[facts.contactName, facts.contactEmail].filter(Boolean).join(', ') || 'apply link only'}. The apply link only opens on this computer until the public address is set (ask your admin).`));
  else out.push(item('contact', 'Contact details', 'check', `Contact: ${[facts.contactName, facts.contactEmail].filter(Boolean).join(', ') || 'apply link only'}. Open the apply link once to see that it works.`));

  const gaps = [!has('experience') && 'experience', !has('skills') && 'must-have skills', !has('education') && 'education', !has('responsibilities') && 'responsibilities'].filter(Boolean);
  if (gaps.length) out.push(item('experience', 'Experience, skills and duties', 'fix', `Missing: ${gaps.join(', ')}. The posts show [ ] for them. Naukri and Shine need skills to show the requirement to the right people.`));
  else out.push(item('experience', 'Experience, skills and duties', 'check', `Experience ${facts.experience}; ${facts.skills.length} must-have skill${facts.skills.length === 1 ? '' : 's'}. Check they match what the client wants.`));

  const w = warnings || [];
  const bad = (leak || []);
  if (w.length || bad.length) {
    out.push(item('wording', 'Fair wording and client name hidden', 'fix', [
      w.length ? `${w.length} warning${w.length === 1 ? '' : 's'} above (age, gender, marital status, religion, looks or the client name).` : '',
      bad.length ? 'The client name is still in a text. Remove it.' : '',
    ].filter(Boolean).join(' ')));
  } else {
    out.push(item('wording', 'Fair wording and client name hidden', 'ok', facts.internal
      ? 'No age, gender, marital status, religion or looks wording found.'
      : 'No age, gender, marital status, religion or looks wording found, and the client name is not in any text.'));
  }
  return out;
}

// ---- diff (AI polish: "check what changed") ------------------------------------------------
// Line by line, LCS. -> [{ op: 'same'|'add'|'del', text }]
function lineDiff(before, after) {
  const a = clean(before).split('\n');
  const b = clean(after).split('\n');
  const n = a.length; const m = b.length;
  if (n * m > 160000) return [...a.map((text) => ({ op: 'del', text })), ...b.map((text) => ({ op: 'add', text }))];
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i += 1; } else { out.push({ op: 'add', text: b[j] }); j += 1; }
  }
  while (i < n) { out.push({ op: 'del', text: a[i] }); i += 1; }
  while (j < m) { out.push({ op: 'add', text: b[j] }); j += 1; }
  return out;
}

// A text for a public feed: no "[ ]" lines, no empty headings.
function stripBlanks(text) {
  const lines = String(text || '').split('\n').filter((l) => !/\[ \]/.test(l));
  // A heading left with nothing under it goes too.
  const keep = [];
  lines.forEach((l, i) => {
    const isHead = /^[A-Z][A-Za-z ]{2,30}:?$/.test(l.trim()) && l.trim().split(' ').length <= 4;
    const next = lines.slice(i + 1).find((x) => x.trim() !== '');
    if (isHead && (!next || (/^[A-Z][A-Za-z ]{2,30}:?$/.test(next.trim()) && next.trim().split(' ').length <= 4))) return;
    keep.push(l);
  });
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- store ------------------------------------------------------------------------------------
const prisma = () => require('../db'); // eslint-disable-line global-require
const keyOf = (id) => `${PREFIX}${id}`;

async function loadSaved(id) {
  const row = await prisma().appSetting.findUnique({ where: { key: keyOf(id) } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    if (!v || typeof v !== 'object') return null;
    return {
      texts: v.texts && typeof v.texts === 'object' ? v.texts : {},
      gen: v.gen && typeof v.gen === 'object' ? v.gen : {},
      savedAt: v.savedAt || row.updatedAt,
      byId: v.byId || row.updatedById || null,
      byName: v.byName || row.updatedByName || null,
      keys: v.keys && typeof v.keys === 'object' ? v.keys : {},
    };
  } catch { return null; }
}

// edits: { key: text } — a key set to null (or '') is reset to the generated text.
// generated: { key: text } what the generator wrote right now (to tell later if the job moved on).
async function saveTexts(id, edits, generated, user) {
  const cur = (await loadSaved(id)) || { texts: {}, gen: {}, keys: {} };
  const texts = { ...cur.texts };
  const gen = { ...cur.gen };
  const keys = { ...cur.keys }; // who/when per text
  const changed = [];
  const reset = [];
  const now = new Date().toISOString();
  Object.keys(edits || {}).forEach((k) => {
    if (!TEXT_KEYS.includes(k)) return;
    const v = edits[k];
    if (v === null || v === undefined || clean(v) === '') {
      if (k in texts) { delete texts[k]; delete gen[k]; delete keys[k]; reset.push(k); }
      return;
    }
    const t = String(v).replace(/\r/g, '').slice(0, MAX_TEXT);
    // Same as what the generator writes now: nothing to keep.
    if (generated && clean(generated[k]) === clean(t)) {
      if (k in texts) { delete texts[k]; delete gen[k]; delete keys[k]; reset.push(k); }
      return;
    }
    if (texts[k] !== t) { texts[k] = t; gen[k] = hashText(generated ? generated[k] : ''); keys[k] = { at: now, byId: user.id, byName: user.name }; changed.push(k); }
  });
  const key = keyOf(id);
  if (!Object.keys(texts).length) {
    await prisma().appSetting.delete({ where: { key } }).catch(() => {});
    return { changed, reset, saved: null };
  }
  const value = JSON.stringify({ texts, gen, keys, savedAt: now, byId: user.id, byName: user.name });
  await prisma().appSetting.upsert({
    where: { key },
    create: { key, value, updatedById: user.id, updatedByName: user.name },
    update: { value, updatedById: user.id, updatedByName: user.name },
  });
  return { changed, reset, saved: { texts, gen, keys, savedAt: now, byId: user.id, byName: user.name } };
}

// The text a board should use for one job when the poster saved their own: a
// saved text wins over the generated one. board: naukri | shine | indeed | linkedin.
async function savedBoardText(id, board) {
  const s = await loadSaved(id);
  if (!s) return null;
  const t = s.texts;
  const pick = (k) => (t[k] && clean(t[k]) ? t[k] : null);
  if (board === 'naukri') return { text: pick('naukri'), title: pick('naukriTitle'), tags: pick('naukriTags') };
  if (board === 'indeed') return { text: pick('indeed'), title: pick('indeedTitle') };
  if (board === 'linkedin') return { text: pick('linkedin'), post: pick('linkedinPost') };
  if (board === 'shine') return { text: pick('shine') };
  return null;
}

// Many jobs at once (the Indeed feed): { requirementId: { indeed, indeedTitle } }
async function savedIndeedTexts() {
  const rows = await prisma().appSetting.findMany({ where: { key: { startsWith: PREFIX } } }).catch(() => []);
  const out = {};
  rows.forEach((r) => {
    try {
      const v = JSON.parse(r.value);
      const t = v && v.texts;
      if (t && clean(t.indeed)) out[r.key.slice(PREFIX.length)] = { text: t.indeed, title: clean(t.indeedTitle) ? t.indeedTitle : null };
    } catch { /* a bad row is ignored */ }
  });
  return out;
}

module.exports = {
  PREFIX, TEXT_KEYS, BLANK, MAX_TEXT,
  publishable, isInternalLine, extractFromText, formatSalary, checklistFor, lineDiff, stripBlanks, hashText,
  loadSaved, saveTexts, savedBoardText, savedIndeedTexts,
};
