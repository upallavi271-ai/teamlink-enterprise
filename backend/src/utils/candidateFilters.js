// ---------------------------------------------------------------------------
// CANDIDATE FILTERS FOR RECRUITERS (founder 2026-11-18: "recruiters hold many candidates, every list needs filters:
// salary, location, specialization ...").
//
// One definition used by BOTH candidate lists (the pipeline, one row per application, and the People list, one row per
// person) and by the option counts (utils/atsFacets.js):
//
//   attrsOf(candidate, idx)  the person's filterable facts, worked out ONCE when the row is built (row.fx, never sent out)
//   matches(row, q)          do the row's facts pass the query's new filters
//   guard(user, q)           drops the parameters this login may not use (CTC for roles that cannot see pay; location,
//                            education and resume for a BDE; every discriminatory name for everybody)
//   facetDefs(user)          the options with counts, each counted over the rows the login may see with every OTHER filter on
//   scopedTags(rows)         tag counts over the people in scope (they used to be over the whole database)
//
// Parameters (all optional, all comma lists where it says csv):
//   ctcCurMin ctcCurMax ctcCurBucket(csv)   current CTC in lakh per year; buckets 0-3 3-6 6-10 10-15 15-25 25+ none
//   ctcExpMin ctcExpMax ctcExpBucket(csv)   expected CTC, the same
//   expMin expMax                           experience in years (both ends included)
//   locCur(csv) locPref(csv) locNative(csv) current / preferred / native-hometown location (city, first word group)
//   jobTitle(csv)                           the standardised job title of the Career tab
//   skillSet(csv) skillMode=any|all         skills; Any (default) or All
//   noticeBand(csv)                         imm d15 d30 d60 d90 gt90 serving none
//   workMode(csv) empType(csv)              preferred work mode / employment type
//   tag (csv, any of)                       tags of the Career tab
//   addedFrom/To updatedFrom/To contactedFrom/To sharedFrom/To   IST days, both ends included
//   resume=yes|no  scoreMin scoreMax scoreBucket(csv)            resume on file; profile completeness 0-100
//   dup=yes|no                                                    a duplicate flag is open
// NEVER filters: gender, age, date of birth, religion, caste, marital status (see FORBIDDEN).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const FORBIDDEN = /^(gender|sex|age|ageMin|ageMax|dob|birth|religion|caste|marital|married)/i;
const csvOf = (v) => String(v === undefined || v === null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean);
const lc = (s) => String(s || '').trim().toLowerCase();
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const IST_MS = 5.5 * 3600 * 1000;
const istDay = (v) => {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : null;
};

// ---- which parameters belong to which right -------------------------------------------------------------------------
const CTC_KEYS = ['ctcCurMin', 'ctcCurMax', 'ctcCurBucket', 'ctcExpMin', 'ctcExpMax', 'ctcExpBucket', 'maxSalary', 'salaryFit', 'salaryMissing'];
// a BDE's record view hides where the person lives, the education / specialization text, the resume and the scores
const PRIVATE_KEYS = ['locCur', 'locPref', 'locNative', 'resume', 'scoreMin', 'scoreMax', 'scoreBucket', 'minMatch'];
// TeamLink-only facts (a client or candidate login never filters on them)
const INTERNAL_KEYS = ['tag', 'addedFrom', 'addedTo', 'updatedFrom', 'updatedTo', 'contactedFrom', 'contactedTo', 'sharedFrom', 'sharedTo', 'dup', 'workMode', 'empType', 'jobTitle'];

/** What this login may filter on. */
function rightsOf(user) {
  // eslint-disable-next-line global-require
  const cand = require('../routes/candidates');
  const kind = cand.viewerKind(user);
  if (kind !== 'internal') return { kind, ctc: false, priv: false, internal: false };
  // eslint-disable-next-line global-require
  const flags = require('./clientRedact').privacyFlagsFor(user);
  return { kind, ctc: !(flags && flags.contact), priv: !(flags && flags.bde), internal: true };
}
/** The query with every parameter this login may not use removed (a copy). */
function guard(user, q) {
  const out = {};
  const r = rightsOf(user);
  Object.keys(q || {}).forEach((k) => {
    if (FORBIDDEN.test(k)) return;
    if (!r.ctc && CTC_KEYS.includes(k)) return;
    if (!r.priv && PRIVATE_KEYS.includes(k)) return;
    if (!r.internal && INTERNAL_KEYS.includes(k)) return;
    out[k] = q[k];
  });
  return out;
}
/** Express middleware: the candidate routes see only the allowed filter parameters. */
function queryGuard(req, res, next) {
  try { if (req.user && req.query) req.query = guard(req.user, req.query); } catch { /* the route's own scope rules still apply */ }
  next();
}

// ---- value readers -----------------------------------------------------------------------------------------------
// "₹6.5L", "6 LPA", "650000", "6,50,000", "50k" -> lakh per year; null = not a number.
function lakhs(v) {
  const s = String(v || '').toLowerCase().replace(/[,₹\s]/g, '');
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 4);
  if (/l|lakh|lpa/.test(after)) return n;
  if (/k/.test(after.slice(0, 2))) return (n * 1000 * 12) / 100000;
  return n >= 1000 ? n / 100000 : n;
}
const CTC_BUCKETS = [['0-3', 0, 3], ['3-6', 3, 6], ['6-10', 6, 10], ['10-15', 10, 15], ['15-25', 15, 25], ['25+', 25, Infinity]];
const ctcBucketOf = (n) => {
  if (n === null || n === undefined) return 'none';
  const b = CTC_BUCKETS.find(([, lo, hi]) => n >= lo && n < hi);
  return b ? b[0] : 'none';
};
const SCORE_BUCKETS = [['0-39', 0, 39], ['40-59', 40, 59], ['60-79', 60, 79], ['80-100', 80, 100]];
const scoreBucketOf = (n) => (SCORE_BUCKETS.find(([, lo, hi]) => n >= lo && n <= hi) || [])[0] || 'none';

// notice period text -> a band. imm = immediate / 0; d15 = 1-15 days; d30 = 16-30; d60 = 31-60; d90 = 61-90; gt90 = more than 90.
function noticeBandOf(text) {
  const s = lc(text);
  if (!s || /^(na|n\/a|nil\?|not specified|not given|unknown|-+)$/.test(s)) return 'none';
  if (/serv|lwd|last working|resign/.test(s)) return 'serving';
  if (/immediate|no notice|available now|^0\s*(day|days)?$|^nil$|^none$/.test(s)) return 'imm';
  const m = /(\d+(?:\.\d+)?)\s*(month|mon|mo\b|week|wk|day|d\b)?/.exec(s);
  if (!m) return 'none';
  let days = Number(m[1]);
  const unit = m[2] || 'day';
  if (/^(month|mon|mo)/.test(unit)) days *= 30;
  else if (/^(week|wk)/.test(unit)) days *= 7;
  if (days <= 0) return 'imm';
  if (days <= 15) return 'd15';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'gt90';
}
const NOTICE_LABELS = {
  imm: 'Immediate', d15: 'Up to 15 days', d30: '16 to 30 days', d60: '31 to 60 days', d90: '61 to 90 days', gt90: 'More than 90 days', serving: 'Serving notice', none: 'Not specified',
};

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => tidy(s).split(' ').map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
// "Hyderabad, Telangana" -> "Hyderabad"; "hyderabad " -> "Hyderabad"
function cityOf(v) {
  const first = tidy(String(v || '').split(/[,;/|(]/)[0]);
  return first ? titleCase(first).slice(0, 40) : null;
}
function citiesOf(v) {
  const out = [];
  String(v || '').split(/[,;/|]|\band\b|\bor\b/i).forEach((x) => {
    const c = cityOf(x);
    if (c && !/^(any|anywhere|all|india|open|flexible|pan india)$/i.test(c) && !out.includes(c)) out.push(c);
  });
  return out;
}
function skillsOf(c) {
  const out = new Set();
  [c.skills, c.technicalSkills].forEach((t) => String(t || '').split(/[,;|\n]/).forEach((x) => {
    const s = lc(x).replace(/\s+/g, ' ');
    if (s && s.length <= 40) out.add(s);
  }));
  return [...out];
}
const modeText = (v) => { const t = titleCase(v); return t ? t.slice(0, 30) : null; };

// ---- the side indexes (duplicate flags, resumes, shared-with-client day) --------------------------------------------
let IDX = null; // { at, dup:Set, resume:Set, shared:Map(appId->day) }
let IDX_JOB = null;
const IDX_TTL = 60 * 1000;
const q = (sql) => prisma.$queryRawUnsafe(sql).catch(() => []);
async function loadIndex() {
  if (IDX && Date.now() - IDX.at < IDX_TTL) return IDX;
  if (IDX_JOB) return IDX_JOB;
  IDX_JOB = (async () => {
    const [dupRows, resRows, shRows] = await Promise.all([
      q("SELECT DISTINCT candidateId FROM CandidateDupFlag WHERE status IN ('OPEN','MERGE_REQUESTED')"),
      q('SELECT DISTINCT candidateId FROM CandidateResume'),
      q("SELECT applicationId, MIN(createdAt) AS at FROM ApplicationStageEvent WHERE toStage IN ('CLIENT_REVIEW','SHARED_WITH_CLIENT') GROUP BY applicationId"),
    ]);
    const shared = new Map();
    shRows.forEach((r) => { const t = typeof r.at === 'bigint' ? Number(r.at) : r.at; const d = istDay(typeof t === 'number' || t instanceof Date ? new Date(t) : t); if (d) shared.set(r.applicationId, d); });
    IDX = {
      at: 0, dup: new Set(dupRows.map((r) => r.candidateId)), resume: new Set(resRows.map((r) => r.candidateId)), shared,
    };
    IDX.at = Date.now();
    return IDX;
  })().finally(() => { IDX_JOB = null; });
  return IDX_JOB;
}

// ---- the person's facts -------------------------------------------------------------------------------------------------
let DQ = null;
const completenessOf = (c) => { if (!DQ) DQ = require('./dataQuality'); return DQ.completeness(c).score; }; // eslint-disable-line global-require
let PDm = null;
const PDmod = () => { if (!PDm) PDm = require('./candidateProfileDepth'); return PDm; }; // eslint-disable-line global-require
const PERSON = new WeakMap();
function attrsOf(c, idx) {
  let a = PERSON.get(c);
  if (!a) {
    const nat = c.nativeLocation || c.hometown || c.nativePlace || null;
    a = {
      ctcCur: lakhs(c.currentSalary),
      ctcExp: lakhs(c.expectedSalary),
      exp: c.experienceYears === null || c.experienceYears === undefined || Number.isNaN(Number(c.experienceYears)) ? null : Number(c.experienceYears),
      locCur: cityOf(c.location),
      locPref: citiesOf(c.preferredLocation),
      locNative: cityOf(nat),
      title: (() => { try { return PDmod().normaliseTitle(c.currentDesignation) || null; } catch { return null; } })(),
      skills: skillsOf(c),
      notice: noticeBandOf(c.noticePeriod),
      workMode: modeText(c.preferredWorkMode),
      empType: modeText(c.preferredEmploymentType),
      addedDay: c.createdAt ? istDay(c.createdAt) : null,
      score: completenessOf({ ...c, resumeName: c.resumeName }),
      hasResumeName: !!c.resumeName,
    };
    PERSON.set(c, a);
  }
  // the parts that depend on the side indexes change faster than the person: not cached on the person
  return {
    ...a,
    resume: a.hasResumeName || !!(idx && idx.resume.has(c.id)),
    dup: !!(idx && idx.dup.has(c.id)),
  };
}
/** fx for a row: the person's facts + the row's own days. */
function fxOf(c, idx, own = {}) {
  return { ...attrsOf(c, idx), ...own };
}
/** the earliest shared-with-client day among applications (an array of ids), or null */
function sharedDayOf(idx, appIds) {
  if (!idx) return null;
  let best = null;
  (appIds || []).forEach((id) => { const d = idx.shared.get(id); if (d && (!best || d < best)) best = d; });
  return best;
}

// ---- matching ----------------------------------------------------------------------------------------------------------
const numOrNull = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function rangeOk(val, lo, hi) {
  if (lo === null && hi === null) return true;
  if (val === null || val === undefined) return false;
  return (lo === null || val >= lo) && (hi === null || val <= hi);
}
function dayOk(day, from, to) {
  const f = from && DAY_RE.test(String(from)) ? String(from) : '';
  const t = to && DAY_RE.test(String(to)) ? String(to) : '';
  if (!f && !t) return true;
  if (!day) return false;
  return (!f || day >= f) && (!t || day <= t);
}
const bucketOk = (list, key) => !list.length || list.includes(key);

// The filters in GROUPS, each with a bit: a row's failMask says which groups it fails, so the option counts can be worked out in ONE pass
// (a facet counts the rows that fail nothing but its own group) instead of one pass per facet.
const T = (bit, keys, test) => ({ bit, keys, test });
const nn = (v) => numOrNull(v);
const TESTS = [
  T(1 << 0, ['ctcCurMin', 'ctcCurMax'], (x, qy) => rangeOk(x.ctcCur, nn(qy.ctcCurMin), nn(qy.ctcCurMax))),
  T(1 << 1, ['ctcCurBucket'], (x, qy) => bucketOk(csvOf(qy.ctcCurBucket), ctcBucketOf(x.ctcCur))),
  T(1 << 2, ['ctcExpMin', 'ctcExpMax'], (x, qy) => rangeOk(x.ctcExp, nn(qy.ctcExpMin), nn(qy.ctcExpMax))),
  T(1 << 3, ['ctcExpBucket'], (x, qy) => bucketOk(csvOf(qy.ctcExpBucket), ctcBucketOf(x.ctcExp))),
  T(1 << 4, ['expMin', 'expMax'], (x, qy) => rangeOk(x.exp, nn(qy.expMin), nn(qy.expMax))),
  T(1 << 5, ['scoreMin', 'scoreMax'], (x, qy) => rangeOk(x.score, nn(qy.scoreMin), nn(qy.scoreMax))),
  T(1 << 6, ['scoreBucket'], (x, qy) => bucketOk(csvOf(qy.scoreBucket), scoreBucketOf(x.score))),
  T(1 << 7, ['locCur'], (x, qy) => !!x.locCur && csvOf(qy.locCur).map(lc).includes(lc(x.locCur))),
  T(1 << 8, ['locNative'], (x, qy) => !!x.locNative && csvOf(qy.locNative).map(lc).includes(lc(x.locNative))),
  T(1 << 9, ['locPref'], (x, qy) => { const w = csvOf(qy.locPref).map(lc); return x.locPref.some((l) => w.includes(lc(l))); }),
  T(1 << 10, ['jobTitle'], (x, qy) => !!x.title && csvOf(qy.jobTitle).map(lc).includes(lc(x.title))),
  T(1 << 11, ['skillSet', 'skillMode'], (x, qy) => {
    const w = csvOf(qy.skillSet).map(lc);
    if (!w.length) return true;
    return String(qy.skillMode || '').toLowerCase() === 'all' ? w.every((s) => x.skills.includes(s)) : w.some((s) => x.skills.includes(s));
  }),
  T(1 << 12, ['noticeBand'], (x, qy) => bucketOk(csvOf(qy.noticeBand), x.notice)),
  T(1 << 13, ['workMode'], (x, qy) => !!x.workMode && csvOf(qy.workMode).map(lc).includes(lc(x.workMode))),
  T(1 << 14, ['empType'], (x, qy) => !!x.empType && csvOf(qy.empType).map(lc).includes(lc(x.empType))),
  T(1 << 15, ['addedFrom', 'addedTo', 'updatedFrom', 'updatedTo', 'sharedFrom', 'sharedTo', 'contactedFrom', 'contactedTo'], (x, qy, r, ctx) => {
    if (!dayOk(x.addedDay, qy.addedFrom, qy.addedTo)) return false;
    if (!dayOk(x.updatedDay, qy.updatedFrom, qy.updatedTo)) return false;
    if (qy.contactedFrom || qy.contactedTo) {
      const day = x.contactedDay !== undefined ? x.contactedDay : (ctx && ctx.fxContact ? ctx.fxContact.get(r.candidateId || r.id) || null : undefined);
      if (day !== undefined && !dayOk(day, qy.contactedFrom, qy.contactedTo)) return false;
    }
    return dayOk(x.sharedDay, qy.sharedFrom, qy.sharedTo);
  }),
  T(1 << 16, ['resume'], (x, qy) => (qy.resume === 'yes' ? !!x.resume : qy.resume === 'no' ? !x.resume : true)),
  T(1 << 17, ['dup'], (x, qy) => (qy.dup === 'yes' ? !!x.dup : qy.dup === 'no' ? !x.dup : true)),
];
const isOn = (qy, keys) => keys.some((k) => qy[k] !== undefined && qy[k] !== '');
/** the bits of the groups the row FAILS among the filters that are on (0 = passes them all). A row with no facts fails every group that is on. */
function failMask(r, query, ctx) {
  const qy = query || {};
  const x = r.fx;
  let m = 0;
  for (let i = 0; i < TESTS.length; i += 1) {
    const t = TESTS[i];
    if (isOn(qy, t.keys) && (!x || !t.test(x, qy, r, ctx))) m |= t.bit; // eslint-disable-line no-bitwise
  }
  return m;
}
/** true when the row passes every NEW filter that is on. */
function matches(r, query, ctx) {
  const qy = query || {};
  if (!ACTIVE_KEYS.some((k) => qy[k] !== undefined && qy[k] !== '')) return true;
  return failMask(r, qy, ctx) === 0;
}
const BIT_OF_FACET = {
  ctcCurBucket: 1 << 1, ctcExpBucket: 1 << 3, scoreBucket: 1 << 6, locCur: 1 << 7, locNative: 1 << 8, locPref: 1 << 9, jobTitle: 1 << 10, skillSet: 1 << 11,
  noticeBand: 1 << 12, workMode: 1 << 13, empType: 1 << 14, resume: 1 << 16, dup: 1 << 17,
};
const ACTIVE_KEYS = ['ctcCurMin', 'ctcCurMax', 'ctcCurBucket', 'ctcExpMin', 'ctcExpMax', 'ctcExpBucket', 'expMin', 'expMax', 'scoreMin', 'scoreMax', 'scoreBucket',
  'locCur', 'locPref', 'locNative', 'jobTitle', 'skillSet', 'noticeBand', 'workMode', 'empType', 'addedFrom', 'addedTo', 'updatedFrom', 'updatedTo',
  'contactedFrom', 'contactedTo', 'sharedFrom', 'sharedTo', 'resume', 'dup'];
const NEW_KEYS = [...ACTIVE_KEYS, 'skillMode'];

// ---- tags (csv, any of) --------------------------------------------------------------------------------------------
/** tag filter: one tag or several (comma list = any of them). Tag names never contain commas. */
function tagMatches(candidateId, tag) {
  const list = csvOf(tag);
  if (!list.length) return true;
  const PD = PDmod();
  return list.some((t) => PD.hasTagSync(candidateId, t));
}

// ---- facets (options with counts) -------------------------------------------------------------------------------------------
const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
/**
 * Definitions for utils/atsFacets.js: { key, omit, get(row) -> value | [values], label?, labelOf?, perPerson }.
 * Only what this login may use is offered (the others would leak counts of hidden fields).
 */
function facetDefs(user) {
  const r = rightsOf(user);
  const fx = (f) => (row) => (row.fx ? f(row.fx) : null);
  const defs = [];
  if (r.ctc) {
    defs.push(
      { key: 'ctcCurBucket', omit: ['ctcCurBucket'], perPerson: true, get: fx((x) => ctcBucketOf(x.ctcCur)), labelOf: (v) => (v === 'none' ? 'Not given' : `${v} lakh`) },
      { key: 'ctcExpBucket', omit: ['ctcExpBucket'], perPerson: true, get: fx((x) => ctcBucketOf(x.ctcExp)), labelOf: (v) => (v === 'none' ? 'Not given' : `${v} lakh`) },
    );
  }
  defs.push(
    { key: 'noticeBand', omit: ['noticeBand'], perPerson: true, get: fx((x) => x.notice), labelOf: (v) => NOTICE_LABELS[v] || v },
    { key: 'skillSet', omit: ['skillSet'], perPerson: true, get: fx((x) => x.skills), labelOf: (v) => v, cap: 150 },
  );
  if (r.internal) {
    defs.push(
      { key: 'jobTitle', omit: ['jobTitle'], perPerson: true, get: fx((x) => x.title), labelOf: (v) => v, cap: 150 },
      { key: 'workMode', omit: ['workMode'], perPerson: true, get: fx((x) => x.workMode) },
      { key: 'empType', omit: ['empType'], perPerson: true, get: fx((x) => x.empType) },
      { key: 'dup', omit: ['dup'], perPerson: true, get: fx((x) => (x.dup ? 'yes' : 'no')), labelOf: (v) => (v === 'yes' ? 'Duplicate suspected' : 'No duplicate flag') },
    );
  }
  if (r.priv) {
    defs.push(
      { key: 'locCur', omit: ['locCur'], perPerson: true, get: fx((x) => x.locCur), cap: 200 },
      { key: 'locPref', omit: ['locPref'], perPerson: true, get: fx((x) => x.locPref), cap: 200 },
      { key: 'locNative', omit: ['locNative'], perPerson: true, get: fx((x) => x.locNative), cap: 200 },
      { key: 'resume', omit: ['resume'], perPerson: true, get: fx((x) => (x.resume ? 'yes' : 'no')), labelOf: (v) => (v === 'yes' ? 'Resume on file' : 'No resume') },
      { key: 'scoreBucket', omit: ['scoreBucket'], perPerson: true, get: fx((x) => scoreBucketOf(x.score)), labelOf: (v) => `${v}%` },
    );
  }
  return defs;
}
/** keep only the biggest `cap` options of a facet (long lists: skills, cities) */
function capOptions(list, cap) {
  if (!cap || list.length <= cap) return list;
  return list.slice(0, cap);
}

/**
 * Tag counts over the people in scope. `rows` = rows already matching every other filter (one per person is enough: ids are de-duplicated).
 * Returns [{ value, label, count }] with count > 0 only.
 */
function scopedTags(personIds) {
  const PD = PDmod();
  const snap = typeof PD.tagSnapshot === 'function' ? PD.tagSnapshot() : [];
  const out = [];
  snap.forEach(({ label, ids }) => {
    let n = 0;
    ids.forEach((id) => { if (personIds.has(id)) n += 1; });
    if (n > 0) out.push({ value: label, label, count: n });
  });
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

module.exports = {
  FORBIDDEN, NEW_KEYS, CTC_KEYS, PRIVATE_KEYS, INTERNAL_KEYS, NOTICE_LABELS, CTC_BUCKETS, SCORE_BUCKETS,
  rightsOf, guard, queryGuard, loadIndex, attrsOf, fxOf, sharedDayOf, matches, failMask, BIT_OF_FACET, tagMatches, facetDefs, capOptions, scopedTags,
  noticeBandOf, lakhs, ctcBucketOf, cityOf, citiesOf, istDay, csvOf, count,
};
