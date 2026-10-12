// ---------------------------------------------------------------------------
// WHERE DID THIS CANDIDATE COME FROM? — ONE clean list, and ONE function that
// turns whatever was ever typed into it (user, 2026-10-10: "Source column and
// filter options").
//
// The database holds free text in Candidate.source / Application.source /
// firstSource: 49 different spellings in the real data, 45% of people say
// "Profile screening" (an import leftover), some "sources" are whole sentences
// from a follow-up note, and the portal / apply links stamp board tags
// (?src=Naukri). Nothing in the database is rewritten by this file. The screens
// read the stored words THROUGH canonicalSource(), so every list, filter,
// export and report is clean immediately, and the raw word stays visible
// ("Recorded as: …") on hover and in the candidate page.
//
//   canonicalSource(raw)        -> one of SOURCES (never blank)
//   sourceOfApplication(app,c)  -> { key, raw }  the application's own source
//   sourceOfPerson(c, latest)   -> { key, raw }  the person's source
//   normaliseIncoming(raw)      -> { source, raw, changed }  for new entries
//   parseSourceFilter('a,b')    -> Set of canonical names | null
//
// The same list is offered by every picker (GET /candidates/source-options)
// and is copied word for word in frontend/src/utils/candidateSource.js (a test
// keeps the two equal).
// ---------------------------------------------------------------------------

const JOB_PORTAL = 'Job Portal';
const WEBSITE = 'Website';
const NAUKRI = 'Naukri';
const SHINE = 'Shine';
const INDEED = 'Indeed';
const LINKEDIN = 'LinkedIn';
const REFERRAL = 'Referral';
const CAMPUS = 'Campus';
const WALK_IN = 'Walk-in';
const AGENCY = 'Agency / partner';
const SOCIAL = 'Social media';
const OWN_SEARCH = "Recruiter's own search";
const IMPORTED = 'Imported sheet (unknown origin)';
const OTHER = 'Other';

// The one list, in the order every picker and filter shows it.
const SOURCES = [
  JOB_PORTAL, WEBSITE, NAUKRI, SHINE, INDEED, LINKEDIN, REFERRAL, CAMPUS, WALK_IN,
  AGENCY, SOCIAL, OWN_SEARCH, IMPORTED, OTHER,
];
// What a person can CHOOSE when adding someone: everything except the
// "unknown origin" bucket (that is only ever what an old import left behind).
const PICKER_SOURCES = SOURCES.filter((s) => s !== IMPORTED);

const SOURCE_SET = new Map(SOURCES.map((s) => [s.toLowerCase(), s]));

const squash = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// Words that mean "a spreadsheet we imported", not a place a person came from.
const SHEET_WORDS = /(^|[^a-z])(sheet|tracker|profiles?|joinings?|desk|screening|invoice|import(ed)?|excel|csv|spreadsheet|migrat[a-z]*|bulk|master|database|dump|legacy|backlog|bde)([^a-z]|$)/i;
// Names an old sheet import left in the column: a client's name, the sheet owner's name, a form-response sheet.
const IMPORT_LEFTOVERS = /^nish\s*tech|^a\.?\s*kavya$|form\s*resp/i;
// A follow-up remark typed into the Source column ("Selected For offline Demo", "Reschedule").
const NOTE_WORDS = /\b(selected|selcted|rejected|reschedul\w*|said|looking for|will|not (answer|interested|reachable)|health|demo|expect\w*|joined|joining|interview(ed)?)\b/i;
// "Education sourcing — Sheet5", "Edu 6-10 shared profiles", "IT tracker" …
const DATEISH = /\b(\d{1,2}[-/ ](\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ]\d{2,4})\b|\b(19|20)\d{2}\b/i;

// The rules, first match wins. Each is [name, test(lowercase text), canonical].
// Tested on the lower-cased, space-squashed text.
const RULES = [
  ['naukri', (k) => /naukr?a?i|nakri|naukari/.test(k), NAUKRI],
  ['shine', (k) => /(^|[^a-z])shine(\.com)?([^a-z]|$)/.test(k), SHINE],
  ['indeed', (k) => /indeed/.test(k), INDEED],
  ['linkedin', (k) => /linked\s*-?\s*in/.test(k), LINKEDIN],
  ['referral', (k) => /referr?al|referred|\breference\b|\bemp(loyee)?\s*ref\b/.test(k), REFERRAL],
  ['campus', (k) => /campus|college\s*drive|placement\s*drive|job\s*fair|career\s*fair/.test(k), CAMPUS],
  ['walk-in', (k) => /walk\s*-?\s*in|walkin/.test(k), WALK_IN],
  ['agency', (k) => /agency|consultanc|vendor|\bpartner\b|freelanc|staffing|outsourc/.test(k), AGENCY],
  ['social', (k) => /social|facebook|instagram|whats\s*app|telegram|twitter|youtube|\bfb\b|\binsta\b|\bx\.com\b|^x$/.test(k), SOCIAL],
  ['portal', (k) => /job\s*portal|careers?\s*(portal|page|site)|teamlink\s*portal|^portal$/.test(k), JOB_PORTAL],
  ['website', (k) => /web\s*-?\s*site|^teamlink\b|company\s*site|^web$|^site$|google\s*jobs?|^google$/.test(k), WEBSITE],
  ['own-search', (k) => /recruiter'?s?\s*(own|search)|own\s*search|self[\s-]*sourced|hr\s*sourcing|ats\s*match|^direct$|direct\s*(entry|add|upload)|cold\s*call|headhunt|resume\s*search|database\s*search|sourced\s*by|\bhr\s*team\b|manual\s*(entry|add)/.test(k), OWN_SEARCH],
  // A resume uploaded or an AI-agent entry: not a sheet, not a named place.
  ['upload', (k) => /^(resume|cv)\s*upload|^ai\s*agent$/.test(k), OTHER],
];

const MEMO = new Map();
const MEMO_MAX = 5000;

// WHY a stored word maps where it does — the dry-run table prints this.
function explain(raw) {
  const text = squash(raw);
  if (!text) return { key: IMPORTED, rule: 'blank' };
  const k = text.toLowerCase();
  if (SOURCE_SET.has(k)) return { key: SOURCE_SET.get(k), rule: 'already a standard source' };
  // A sentence is not a source: a follow-up note typed into the column.
  if (text.length > 40 || text.split(' ').length > 6) return { key: IMPORTED, rule: 'note / number typed in the source column' };
  for (const [name, test, key] of RULES) {
    if (test(k)) return { key, rule: name };
  }
  if (SHEET_WORDS.test(k)) return { key: IMPORTED, rule: 'sheet / tracker name' };
  if (IMPORT_LEFTOVERS.test(text)) return { key: IMPORTED, rule: 'name left by an old sheet import (client / sheet owner / form)' };
  if (NOTE_WORDS.test(k)) return { key: IMPORTED, rule: 'note / number typed in the source column' };
  // Not a place, not a sheet: a note typed into the Source column, a date, a
  // timestamp-looking id. Nobody can tell where these people came from.
  if (text.length > 40 || DATEISH.test(text) || /^\d+$/.test(text) || /^[a-z]\d{8,}$/i.test(text) || text.split(' ').length > 4) {
    return { key: IMPORTED, rule: 'note / number typed in the source column' };
  }
  return { key: OTHER, rule: 'unrecognised short label' };
}

function canonicalSource(raw) {
  const text = squash(raw);
  if (MEMO.has(text)) return MEMO.get(text);
  const key = explain(text).key;
  if (MEMO.size >= MEMO_MAX) MEMO.clear();
  MEMO.set(text, key);
  return key;
}

const isCanonical = (v) => SOURCE_SET.has(squash(v).toLowerCase());
const canonicalName = (v) => SOURCE_SET.get(squash(v).toLowerCase()) || null;

// Same word apart from case / spacing / a trailing ".com": nothing to keep.
const looseKey = (v) => squash(v).toLowerCase().replace(/\.com$/, '').replace(/[^a-z0-9]/g, '');
const isTrivialVariant = (raw, canonical) => looseKey(raw) === looseKey(canonical);

// The portal stamps the APPLICATION with a fixed marker (it is how the Job
// Portal screening list is told apart: utils/atsVocab.js PRE_ATS_SOURCES); the
// board the person came through is in firstSource.
const PORTAL_MARKERS = new Set(['teamlink job portal', 'job portal']);
const isPortalMarker = (v) => PORTAL_MARKERS.has(squash(v).toLowerCase());
// "ATS Match" says only that the person was matched to a job from our own
// database: the real origin is the person's own source.
const WEAK = new Set(['ats match', 'hr sourcing']);

// The source of one APPLICATION: its own word first, then the person's. A word
// that tells nothing (blank / sheet / note) never hides one that does.
// What one stored word means, worked out once per distinct word (a few dozen exist, the rows are tens of thousands).
const INFO = new Map();
function infoOf(raw) {
  if (raw === null || raw === undefined) return null;
  if (INFO.has(raw)) return INFO.get(raw);
  const t = squash(raw);
  const info = t ? { t, key: canonicalSource(t), weak: WEAK.has(t.toLowerCase()), portal: isPortalMarker(t) } : null;
  if (INFO.size >= MEMO_MAX) INFO.clear();
  INFO.set(raw, info);
  return info;
}

// After a tidy-up the clean word is stored and the old word waits in firstSource: say THAT as "recorded as".
function rawFor(key, t, infos) {
  if (t !== key) return t;
  const other = infos.find((x) => x && x.key === key && x.t !== key);
  return other ? other.t : t;
}

function sourceOfApplication(app, cand) {
  const a = app || {};
  const c = cand || a.candidate || {};
  const as = infoOf(a.source);
  const af = infoOf(a.firstSource);
  const cs = infoOf(c.source);
  const cf = infoOf(c.firstSource);
  const own = as && as.portal && af && !af.portal ? [af, as, cs, cf] : [as, cs, af, cf];
  let weak = null;
  for (let i = 0; i < 4; i += 1) {
    const x = own[i];
    if (!x || x.key === IMPORTED) continue;
    if (x.weak) { if (!weak) weak = { key: x.key, raw: x.t }; continue; }
    return { key: x.key, raw: rawFor(x.key, x.t, own) };
  }
  if (weak) return weak;
  // Nothing informative anywhere: say so, and keep the first word on file.
  const first = own.find((x) => x && x.t !== IMPORTED) || own.find(Boolean);
  return { key: IMPORTED, raw: first ? first.t : null };
}

// The source of one PERSON (the People list): their own source, else the
// latest application's.
function sourceOfPerson(cand, latestApp) {
  const c = cand || {};
  const order = [infoOf(c.source), infoOf(c.firstSource), infoOf(latestApp && latestApp.source), infoOf(latestApp && latestApp.firstSource)];
  for (let i = 0; i < 4; i += 1) {
    const x = order[i];
    if (x && x.key !== IMPORTED) return { key: x.key, raw: rawFor(x.key, x.t, order) };
  }
  const first = order.find((x) => x && x.t !== IMPORTED) || order.find(Boolean);
  return { key: IMPORTED, raw: first ? first.t : null };
}

// NEW ENTRIES (a form, an import column, an apply link): the clean word to
// store, and whether anything was changed (then the raw is kept in a note).
function normaliseIncoming(raw) {
  const text = squash(raw);
  if (!text) return { source: null, raw: null, changed: false };
  const source = canonicalSource(text);
  return { source, raw: text, changed: !isTrivialVariant(text, source) };
}

// Application.source words the Job Portal screening depends on (utils/atsVocab.js PRE_ATS_SOURCES): never
// rewritten, only READ through the list.
const FUNCTIONAL_MARKERS = new Set(['teamlink job portal', 'job portal', 'hr sourcing']);
const isFunctionalMarker = (v) => FUNCTIONAL_MARKERS.has(squash(v).toLowerCase());

// An IMPORT ROW (or any other write of source / firstSource fields): store the clean word; keep the word that
// was typed in firstSource when that was empty (the first source is recorded once, never overwritten), so
// nothing is lost. `application`: leaves the functional portal markers alone.
function tidyFields(fields, { application = false } = {}) {
  if (!fields) return fields;
  const out = { ...fields };
  let keptRaw = false;
  if (out.source !== undefined && out.source !== null && squash(out.source) !== '') {
    if (!(application && isFunctionalMarker(out.source))) {
      const n = normaliseIncoming(out.source);
      out.source = n.source;
      if (n.changed && !squash(out.firstSource)) { out.firstSource = n.raw.slice(0, 190); keptRaw = true; }
    }
  }
  if (!keptRaw && out.firstSource !== undefined && out.firstSource !== null && squash(out.firstSource) !== ''
    && !(application && isFunctionalMarker(out.firstSource))) {
    out.firstSource = normaliseIncoming(out.firstSource).source;
  }
  return out;
}

// The line kept on the person's notes when what was typed is not what is stored
// ("Source typed as “Naukri.com job portal” — saved as Naukri"), or when
// "Other" came with a few words of explanation. null = nothing to keep.
function sourceNote(norm, freeNote) {
  const free = squash(freeNote).slice(0, 300);
  if (!norm || !norm.source) return free ? `Source: ${free}` : null;
  const bits = [];
  if (norm.changed && norm.raw) bits.push(`Source typed as “${norm.raw.slice(0, 200)}” — saved as ${norm.source}`);
  else if (free) bits.push(`Source: ${norm.source}`);
  if (free) bits.push(free);
  return bits.length ? bits.join(' — ') : null;
}

// ?source=Naukri,Shine — canonical names, or any old word (mapped).
function parseSourceFilter(param) {
  const parts = String(param == null ? '' : param).split(',').map(squash).filter(Boolean);
  if (!parts.length) return null;
  return new Set(parts.map((p) => canonicalName(p) || canonicalSource(p)));
}

// A row's source against a filter value (used by every list).
const sourceMatches = (rowKey, wanted) => !wanted || wanted.has(rowKey);

module.exports = {
  SOURCES,
  PICKER_SOURCES,
  JOB_PORTAL,
  WEBSITE,
  NAUKRI,
  SHINE,
  INDEED,
  LINKEDIN,
  REFERRAL,
  CAMPUS,
  WALK_IN,
  AGENCY,
  SOCIAL,
  OWN_SEARCH,
  IMPORTED,
  OTHER,
  canonicalSource,
  canonicalName,
  isCanonical,
  explain,
  isTrivialVariant,
  sourceOfApplication,
  sourceOfPerson,
  normaliseIncoming,
  tidyFields,
  isFunctionalMarker,
  sourceNote,
  parseSourceFilter,
  sourceMatches,
};
