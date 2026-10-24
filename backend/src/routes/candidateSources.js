// ---------------------------------------------------------------------------
// WHERE DO OUR CANDIDATES COME FROM, AND WHEN DID THEY COME? (user, 2026-10-13)
// "Candidates Ye Source nunchi entha mandi vacharu, eppudu vacharu, clear ga visible avvali."
//
// The Sources tab of Candidates & Pipeline (and the "Where candidates come from"
// view of ATS Reports). Mounted by routes/candidates.js at /api/candidates/sources.
//
//   GET  /api/candidates/sources            the numbers: tiles, ranked table, "when they came", source over time,
//                                           data-quality notes, cascading filter options
//   GET  /api/candidates/sources/export     ?table=sources|overtime&format=xlsx|pdf (audited)
//   GET  /api/candidates/sources/cleanup    Admin: stored words the clean list would write differently
//   POST /api/candidates/sources/cleanup/preview | /apply | /undo     Admin (confirm + undo file)
//
// THE NUMBERS ARE THE LIST'S NUMBERS. This file counts the very rows the People list ("All people") shows for the same
// filters (routes/candidates.js peopleFor(): the same decorated rows, the same scope, the same matcher), by the same
// clean source word (utils/candidateSource.js) and the same "came on" date (utils/cameOn.js). So a tile and the list it
// opens can never disagree.
//
// WHO SEES WHAT (enforced here, not in the browser):
//   Recruiter            only their own candidates (utils/ownOnly.js: the recruiter filter is forced to them; no team filters)
//   TL / STL / Manager   the people the list already gives them (their team / section / departments / all)
//   BDE and BDE TL       counts of the people who reached the client step, nothing else (the list scope), no names here at all
//   HR                   internal hiring people only (the list scope)
//   Client / Candidate   refused
// No phone, e-mail, salary or name of a candidate is ever in these answers.
// ---------------------------------------------------------------------------
const express = require('express');
const { requirePerm } = require('../middleware/auth');
const CS = require('../utils/candidateSource');
const CAME = require('../utils/cameOn');
const { istDay } = require('../utils/nextAction');
const { stageIndex } = require('../utils/pipelineView');
const { toXlsxBook, toPdf } = require('../utils/tabularExport');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const C = () => require('./candidates'); // eslint-disable-line global-require
const own = () => require('../utils/ownOnly'); // eslint-disable-line global-require

const DAY_MS = 86400000;
const NOT_RECORDED = 'Not recorded';
const labelOf = (key) => (key === CS.IMPORTED ? NOT_RECORDED : key);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- days (all IST day strings 'YYYY-MM-DD'; arithmetic in UTC on the string, like the rest of the app) ----------
const toMs = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, n) => new Date(toMs(day) + n * DAY_MS).toISOString().slice(0, 10);
const dow = (day) => (new Date(toMs(day)).getUTCDay() + 6) % 7; // Monday = 0
const weekStart = (day) => addDays(day, -dow(day));
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const addMonths = (day, n) => { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => DAY_RE.test(String(d || '')) && new Date(toMs(d)).toISOString().slice(0, 10) === d;
const fmtDay = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const fmtShort = (d) => { const [, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]}`; };

const PERIODS = {
  all: 'All time', today: 'Today', yesterday: 'Yesterday', week: 'This week', month: 'This month',
  lastmonth: 'Last month', last3: 'Last 3 months', year: 'This year', custom: 'Custom',
};

// The period as { key, from, to (inclusive days), label }. `minDay` = the first day anybody came (for "All time").
function periodOf(q, today, minDay) {
  const key = PERIODS[q.period] ? q.period : 'all';
  let from;
  let to = today;
  if (key === 'today') from = today;
  else if (key === 'yesterday') { from = addDays(today, -1); to = from; } else if (key === 'week') from = weekStart(today);
  else if (key === 'month') from = monthStart(today);
  else if (key === 'lastmonth') { from = addMonths(monthStart(today), -1); to = addDays(monthStart(today), -1); } else if (key === 'last3') from = addMonths(monthStart(today), -2);
  else if (key === 'year') from = `${today.slice(0, 4)}-01-01`;
  else if (key === 'custom') {
    from = validDay(q.from) ? q.from : today;
    to = validDay(q.to) ? q.to : today;
    if (to < from) [from, to] = [to, from];
    if (daysBetween(from, to) > 366 * 5) from = addDays(to, -366 * 5);
  } else { from = minDay && minDay <= today ? minDay : today; }
  const label = key === 'all' ? `All time (${fmtDay(from)} to ${fmtDay(to)})` : (from === to ? `${PERIODS[key] === 'Custom' ? '' : `${PERIODS[key]}, `}${fmtDay(from)}` : `${PERIODS[key]}: ${fmtDay(from)} to ${fmtDay(to)}`);
  return { key, from, to, label };
}

// Day by day / Week by week / Month by month; "auto" picks what fits. Too many columns -> one step coarser, and it says so.
function groupOf(requested, from, to) {
  const span = daysBetween(from, to) + 1;
  const order = ['day', 'week', 'month'];
  let g = order.includes(requested) ? requested : (span <= 45 ? 'day' : span <= 200 ? 'week' : 'month');
  const cols = (x) => (x === 'day' ? span : x === 'week' ? Math.ceil(span / 7) + 1 : Math.ceil(span / 28) + 1);
  let note = null;
  const max = { day: 62, week: 78, month: 120 };
  while (g !== 'month' && cols(g) > max[g]) {
    const next = order[order.indexOf(g) + 1];
    note = `Showing ${next} by ${next} (${next === 'week' ? 'week by week' : 'month by month'}) because ${g} by ${g} would be ${cols(g)} columns.`;
    g = next;
  }
  return { group: g, note };
}
const bucketOf = (day, g) => (g === 'day' ? day : g === 'week' ? weekStart(day) : monthStart(day));
function bucketLabel(key, g) {
  if (g === 'day') return fmtShort(key);
  if (g === 'week') return `${fmtShort(key)} – ${fmtShort(addDays(key, 6))}`;
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function bucketsBetween(from, to, g) {
  const out = [];
  let k = bucketOf(from, g);
  const last = bucketOf(to, g);
  let guard = 0;
  while (k <= last && guard < 400) {
    out.push(k);
    k = g === 'day' ? addDays(k, 1) : g === 'week' ? addDays(k, 7) : addMonths(k, 1);
    guard += 1;
  }
  return out;
}

// ---- who may see / do what -------------------------------------------------
const isAdmin = (user) => {
  const { roleForProduct } = require('../utils/permissions'); // eslint-disable-line global-require
  return !!user && (['SUPER_ADMIN', 'ADMIN'].includes(user.role) || ['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(user, 'ats')));
};
const viewRole = (user) => { try { return require('../utils/scope').atsViewRole(user); } catch { return null; } }; // eslint-disable-line global-require

function guard(req, res, next) {
  if (C().viewerKind(req.user) !== 'internal') return res.status(403).json({ error: 'The Sources view is for the TeamLink team.' });
  return next();
}
router.use(guard);

// ---- the filters the screen may send (one place) ----------------------------
const FILTER_KEYS = ['department', 'clientId', 'requirementId', 'recruiter', 'tl', 'bde', 'positionCode'];
function filtersOf(user, query) {
  const q = { ...query };
  // A recruiter's request is forced to themselves, whatever the address says (utils/ownOnly.js).
  if (own().isOwnOnly(user)) own().ownQuery(user, q);
  const f = {};
  FILTER_KEYS.forEach((k) => { if (q[k] !== undefined && String(q[k]).trim() !== '') f[k] = String(q[k]).slice(0, 200); });
  // The BDE team never filters by a recruiter / TL / BDE person (it is a counts-only view).
  const role = viewRole(user);
  if (role === 'bde') ['recruiter', 'tl', 'bde', 'positionCode'].forEach((k) => delete f[k]);
  return { filters: f, q };
}

// ---- the work ---------------------------------------------------------------
const memo = new Map();
const MEMO_MAX = 40;
const MEMO_TTL = 10 * 60 * 1000;

function furthestOf(row, reached) {
  let best = -1;
  (row.applications || []).forEach((a) => {
    const s = Math.max(stageIndex(a.stage), reached.get(a.id) ?? -1);
    if (s > best) best = s;
  });
  return best;
}

async function facetsFor(user, filters, role) {
  const C0 = C();
  const cache = new Map();
  const dims = [
    { key: 'department', skip: ['department'], get: (r) => [...new Set((r.applications || []).map((a) => a.requirement && a.requirement.department).filter(Boolean))] },
    { key: 'clientId', skip: ['clientId'], label: true, get: (r) => [...new Set((r.applications || []).map((a) => a.requirement && !a.requirement.internal && a.requirement.clientId).filter(Boolean))] },
    { key: 'requirementId', skip: ['requirementId'], label: true, get: (r) => [...new Set((r.applications || []).map((a) => a.requirementId).filter(Boolean))] },
  ];
  if (role !== 'bde' && role !== 'recruiter') {
    dims.push({ key: 'recruiter', skip: ['recruiter', 'positionCode'], get: (r) => (r.recruiterName ? [`name:${r.recruiterName}`] : []) });
    dims.push({ key: 'tl', skip: ['tl'], get: (r) => (r.tlName ? [`name:${r.tlName}`] : []) });
  }
  const names = new Map();
  const facets = {};
  for (const d of dims) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await C0.peopleFor(user, filters, d.skip, cache);
    const counts = new Map();
    rows.forEach((r) => {
      d.get(r).forEach((v) => {
        counts.set(v, (counts.get(v) || 0) + 1);
        if (d.label && !names.has(`${d.key}:${v}`)) {
          const a = (r.applications || []).find((x) => (d.key === 'clientId' ? x.requirement && x.requirement.clientId === v : x.requirementId === v));
          if (a && a.requirement) {
            names.set(`${d.key}:${v}`, d.key === 'clientId' ? (a.requirement.client && a.requirement.client.name) || 'Client' : [a.requirement.title, a.requirement.client && !a.requirement.internal ? a.requirement.client.name : 'TeamLink internal'].filter(Boolean).join(' · '));
          }
        }
      });
    });
    let list = [...counts.entries()].map(([value, count]) => ({
      value, count, label: d.key === 'recruiter' || d.key === 'tl' ? String(value).replace(/^name:/, '') : (names.get(`${d.key}:${value}`) || value),
    }));
    const chosen = filters[d.key];
    list = list.filter((o) => o.count > 0 || o.value === chosen);
    list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    // 4,000+ jobs would be a wall: the job list is offered once a department or client is chosen, and capped.
    if (d.key === 'requirementId' && !filters.department && !filters.clientId && !chosen) list = [];
    facets[d.key] = list.slice(0, 300);
  }
  return facets;
}

// The option lists do not depend on the period / grouping: kept per filters (same freshness rules as the numbers).
const FACET_MEMO = new Map();
async function cachedFacets(user, filters, role, key) {
  const hit = FACET_MEMO.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL) return hit.v;
  const v = await facetsFor(user, filters, role);
  FACET_MEMO.set(key, { at: Date.now(), v });
  while (FACET_MEMO.size > MEMO_MAX) FACET_MEMO.delete(FACET_MEMO.keys().next().value);
  return v;
}

async function build(req) {
  const user = req.user;
  const { getListState } = require('../utils/candidateListCache'); // eslint-disable-line global-require
  const st = await getListState();
  const { filters, q } = filtersOf(user, req.query);
  const today = istDay(new Date());
  const onlyReal = String(q.onlyReal || '') === '1';
  const focus = String(q.focus || '').split(',').map((x) => x.trim()).filter(Boolean);
  const s = require('../utils/scope').atsScopeOf(user); // eslint-disable-line global-require
  const key = [user.id, st.version, today, C().scopeSig(s), JSON.stringify([filters, q.period, q.from, q.to, q.group, onlyReal, focus])].join('|');
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL) { memo.delete(key); memo.set(key, hit); return hit.out; }

  const t0 = Date.now();
  const C0 = C();
  const { rows: filtered } = await C0.peopleFor(user, filters);
  const reached = await C0.reachedMap(st.version);
  const role = viewRole(user);

  // The rows we count: with / without the people loaded by an import (their date is the import day).
  const pool = onlyReal ? filtered.filter((r) => r.cameOnKind !== 'imported') : filtered;
  const days = pool.map((r) => r.cameOnDay).filter(Boolean);
  const minDay = days.reduce((m, d) => (m === null || d < m ? d : m), null);
  const per = periodOf(q, today, minDay);
  const inPeriod = pool.filter((r) => r.cameOnDay && r.cameOnDay >= per.from && r.cameOnDay <= per.to);

  // ---- per source ----
  const wk = weekStart(today);
  const mo = monthStart(today);
  const by = new Map();
  const bucket = (k) => {
    if (!by.has(k)) {
      by.set(k, {
        source: k, label: labelOf(k), people: 0, first: null, last: null, importedPeople: 0, today: 0, week: 0, month: 0, sent: 0, interview: 0, joined: 0,
      });
    }
    return by.get(k);
  };
  const sentIx = stageIndex('SHARED_WITH_CLIENT');
  const ivIx = stageIndex('INTERVIEW_SCHEDULED');
  const joinIx = stageIndex('JOINED');
  inPeriod.forEach((r) => {
    const b = bucket(r.sourceKey || CS.IMPORTED);
    b.people += 1;
    if (!b.first || r.cameOnDay < b.first) b.first = r.cameOnDay;
    if (!b.last || r.cameOnDay > b.last) b.last = r.cameOnDay;
    if (r.cameOnKind === 'imported') b.importedPeople += 1;
    const f = furthestOf(r, reached);
    if (f >= sentIx) b.sent += 1;
    if (f >= ivIx) b.interview += 1;
    if (f >= joinIx) b.joined += 1;
  });
  // Today / This week / This month: always "now", with the same filters (not the chosen period).
  pool.forEach((r) => {
    const d = r.cameOnDay;
    if (!d || d > today || (d < wk && d < mo)) return;
    const row = bucket(r.sourceKey || CS.IMPORTED); // a source whose people came only today / this week still gets its row
    if (d === today) row.today += 1;
    if (d >= wk) row.week += 1;
    if (d >= mo) row.month += 1;
  });
  const total = inPeriod.length;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const rows = [...by.values()].filter((b) => b.people > 0 || b.today || b.week || b.month)
    .map((b) => ({
      ...b,
      share: pct(b.people, total),
      imported: b.people > 0 && b.importedPeople === b.people,
      sentPct: pct(b.sent, b.people),
      interviewPct: pct(b.interview, b.people),
      joinedPct: pct(b.joined, b.people),
    }))
    .sort((a, b) => b.people - a.people || a.label.localeCompare(b.label));
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const totalRow = {
    source: '*', label: 'Total', people: total, share: total ? 100 : 0,
    first: rows.reduce((m, r) => (r.first && (!m || r.first < m) ? r.first : m), null),
    last: rows.reduce((m, r) => (r.last && (!m || r.last > m) ? r.last : m), null),
    today: sum('today'), week: sum('week'), month: sum('month'), sent: sum('sent'), interview: sum('interview'), joined: sum('joined'), importedPeople: sum('importedPeople'),
    sentPct: pct(sum('sent'), total), interviewPct: pct(sum('interview'), total), joinedPct: pct(sum('joined'), total),
  };

  // ---- tiles ----
  const recorded = rows.filter((r) => r.source !== CS.IMPORTED && r.people > 0);
  const best = recorded[0] || null;
  const arrivedToday = pool.filter((r) => r.cameOnDay === today);
  const tiles = {
    total,
    sources: recorded.length,
    best: best ? { source: best.source, people: best.people } : null,
    today: arrivedToday.length,
    todayImported: arrivedToday.filter((r) => r.cameOnKind === 'imported').length,
  };

  // ---- When they came + source over time ----
  const g = groupOf(String(q.group || ''), per.from, per.to);
  const keys = bucketsBetween(per.from, per.to, g.group);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const seriesTotal = keys.map(() => 0);
  const seriesImported = keys.map(() => 0);
  const bySource = new Map();
  const focusSet = focus.length ? new Set(focus) : null;
  inPeriod.forEach((r) => {
    const i = idx.get(bucketOf(r.cameOnDay, g.group));
    if (i === undefined) return;
    const sk = r.sourceKey || CS.IMPORTED;
    if (!bySource.has(sk)) bySource.set(sk, keys.map(() => 0));
    bySource.get(sk)[i] += 1;
    if (!focusSet || focusSet.has(sk)) {
      seriesTotal[i] += 1;
      if (r.cameOnKind === 'imported') seriesImported[i] += 1;
    }
  });
  const overRows = [...bySource.entries()].map(([sk, values]) => ({ source: sk, label: labelOf(sk), values, total: values.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const overTime = {
    group: g.group,
    columns: keys.map((k) => ({ key: k, label: bucketLabel(k, g.group), from: k, to: g.group === 'day' ? k : g.group === 'week' ? addDays(k, 6) : addDays(addMonths(k, 1), -1) })),
    rows: overRows,
    totals: keys.map((_, i) => overRows.reduce((n, r) => n + r.values[i], 0)),
    total: overRows.reduce((n, r) => n + r.total, 0),
  };
  const series = keys.map((k, i) => ({
    key: k, label: bucketLabel(k, g.group), people: seriesTotal[i], imported: seriesImported[i], from: overTime.columns[i].from, to: overTime.columns[i].to,
  }));

  // ---- what is inside "Not recorded" (the old sheet names) ----
  const inside = new Map();
  inPeriod.forEach((r) => {
    if ((r.sourceKey || CS.IMPORTED) !== CS.IMPORTED) return;
    const raw = r.sourceRaw && String(r.sourceRaw).trim() ? String(r.sourceRaw).trim() : null;
    let word = raw || 'Nothing written';
    if (raw && /note \/ number/.test(CS.explain(raw).rule)) word = 'Other notes typed in the source box';
    inside.set(word, (inside.get(word) || 0) + 1);
  });
  const insideList = [...inside.entries()].map(([word, people]) => ({ word, people })).sort((a, b) => b.people - a.people);
  const insideTop = insideList.slice(0, 12);
  if (insideList.length > 12) insideTop.push({ word: `${insideList.length - 12} more words`, people: insideList.slice(12).reduce((n, x) => n + x.people, 0) });

  // ---- data quality: the whole filtered list (not the period), honest ----
  const all = filtered.length;
  const noSource = filtered.filter((r) => (r.sourceKey || CS.IMPORTED) === CS.IMPORTED).length;
  const importedDate = filtered.filter((r) => r.cameOnKind === 'imported').length;
  const kinds = { sheet: 0, imported: 0, applied: 0, entered: 0 };
  filtered.forEach((r) => { if (kinds[r.cameOnKind] !== undefined) kinds[r.cameOnKind] += 1; });
  const quality = {
    people: all,
    noSource,
    noSourcePct: pct(noSource, all),
    importedDate,
    importedDatePct: pct(importedDate, all),
    realDate: all - importedDate,
    realDatePct: pct(all - importedDate, all),
    kinds,
    meaning: {
      sheet: 'The date written in the old sheet (kept on the person\'s requirement application).',
      imported: 'The day the profile was loaded into TeamLink with a big import. It is not the day the person really arrived.',
      applied: 'The day the person applied on the job portal or a careers link.',
      entered: 'The day the profile was added to TeamLink.',
    },
    noSourceDrill: { source: CS.IMPORTED },
    importedDrill: { cameKind: 'imported' },
  };

  // ---- drill-down: the list filters that reproduce a tile exactly ----
  const drill = { ...filters };
  if (onlyReal) drill.cameKind = 'sheet,applied,entered';
  const out = {
    ok: true,
    asOf: new Date().toISOString(),
    today,
    ranges: { today: { from: today, to: today }, week: { from: wk, to: today }, month: { from: mo, to: today } },
    period: { ...per, options: Object.entries(PERIODS).map(([k, label]) => ({ key: k, label })) },
    group: g.group,
    groupNote: g.note,
    onlyReal,
    focus,
    tiles,
    rows,
    total: totalRow,
    series,
    overTime,
    inside: insideTop,
    quality,
    facets: await cachedFacets(user, filters, role, [user.id, st.version, today, C().scopeSig(s), JSON.stringify(filters)].join("|")),
    drill,
    filters,
    scope: scopeNote(user, role),
    can: { cleanup: isAdmin(user), export: await canExport(user) },
    ms: Date.now() - t0,
  };
  memo.set(key, { at: Date.now(), out });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return out;
}

function scopeNote(user, role) {
  if (own().isOwnOnly(user)) return 'You see only your own candidates.';
  if (role === 'bde') return 'You see how many people reached the client step. Names and contact details are not shown here.';
  if (role === 'tl') return 'You see your team\'s candidates.';
  if (role === 'hr') return 'You see the people of TeamLink\'s own hiring.';
  return null;
}
async function canExport(user) {
  try { return !!(await require('../middleware/auth').can(user, null, 'candidates', 'Candidate List', 'export')); } catch { return false; } // eslint-disable-line global-require
}

router.get('/', async (req, res, next) => {
  try { return res.json(await build(req)); } catch (e) { return next(e); }
});

// ---- exports (separate Excel and PDF buttons; audited) -----------------------
const cellDay = (d) => (d ? fmtDay(d) : '');
router.get('/export', requirePerm('ats', 'candidates', 'Candidate List', 'export'), async (req, res, next) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
    const table = req.query.table === 'overtime' ? 'overtime' : 'sources';
    const d = await build(req);
    const by = req.user.name || 'user';
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
    const f = d.filters || {};
    const names = [];
    const fac = (k, v) => ((d.facets[k] || []).find((o) => o.value === v) || {}).label || v;
    if (f.department) names.push(`Department: ${f.department}`);
    if (f.clientId) names.push(`Client: ${fac('clientId', f.clientId)}`);
    if (f.requirementId) names.push(`Requirement: ${fac('requirementId', f.requirementId)}`);
    if (f.recruiter) names.push(`Recruiter: ${String(f.recruiter).replace(/^(name|id):/, '')}`);
    if (f.tl) names.push(`Team lead: ${String(f.tl).replace(/^name:/, '')}`);
    if (d.onlyReal) names.push('Without people loaded by an import');
    const filterText = names.length ? names.join(' · ') : 'No filters';
    const title = table === 'sources' ? 'Where candidates come from' : 'Where candidates come from, over time';
    let headers;
    let rows;
    if (table === 'sources') {
      headers = ['Source', 'People', 'Share %', 'First came', 'Last came', 'Today', 'This week', 'This month', 'Sent to client', '% sent to client', 'Interview', '% interview', 'Joined', '% joined'];
      const line = (r) => [r.label, r.people, r.share, cellDay(r.first), cellDay(r.last), r.today, r.week, r.month, r.sent, r.sentPct, r.interview, r.interviewPct, r.joined, r.joinedPct];
      rows = [...d.rows.map(line), line(d.total)];
    } else {
      const cols = d.overTime.columns.map((c) => c.label);
      // A PDF page is narrow: a wide table is turned on its side (one line per day / week / month).
      if (format === 'pdf' && cols.length > 9) {
        const top = d.overTime.rows.slice(0, 8);
        const restOf = (i) => d.overTime.rows.slice(8).reduce((n, r) => n + r.values[i], 0);
        headers = [d.group === 'day' ? 'Day' : d.group === 'week' ? 'Week' : 'Month', ...top.map((r) => r.label), ...(d.overTime.rows.length > 8 ? ['Everything else'] : []), 'Total'];
        rows = cols.map((label, i) => [label, ...top.map((r) => r.values[i]), ...(d.overTime.rows.length > 8 ? [restOf(i)] : []), d.overTime.totals[i]]);
        rows.push(['Total', ...top.map((r) => r.total), ...(d.overTime.rows.length > 8 ? [d.overTime.rows.slice(8).reduce((n, r) => n + r.total, 0)] : []), d.overTime.total]);
      } else {
        headers = ['Source', ...cols, 'Total'];
        rows = [...d.overTime.rows.map((r) => [r.label, ...r.values, r.total]), ['Total', ...d.overTime.totals, d.overTime.total]];
      }
    }
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: `Sources ${table === 'sources' ? 'table' : 'over-time table'} exported (${format.toUpperCase()})`, entity: 'Candidate', entityId: 'sources',
      toValue: `${rows.length} row(s) · ${d.period.label} · ${filterText}`,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `candidate-sources-${table}-${stamp}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Rows', String(rows.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows');
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(toPdf(headers, rows, { title: `${title} - ${d.period.label}`.slice(0, 110), subtitle: `${filterText} · by ${by} · ${when}`.slice(0, 160) }));
    }
    const about = [
      ['Report', title], ['Period', d.period.label], ['Filters', filterText],
      ['Grouping', table === 'overtime' ? `${d.group} by ${d.group}` : '-'], ['Generated by', by], ['Generated at', when],
      ['What "came on" means', 'The date the profile came to TeamLink: the date in the old sheet when the sheet date was kept, the day they applied on the job portal, otherwise the day the profile was added. People loaded by a big import show the import day (not their real arrival day).'],
      ['Not recorded', 'People whose source was never written down (old imports).'],
    ];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsxBook([{ name: 'About', headers: ['Item', 'Value'], rows: about }, { name: table === 'sources' ? 'Sources' : 'Over time', headers, rows }]));
  } catch (e) { return next(e); }
});

// ---- clean-up suggestions (Admin / Super Admin) ------------------------------
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can tidy the source words.' });
  return next();
}
router.get('/cleanup', adminOnly, async (req, res, next) => {
  try {
    const groups = await require('../utils/sourceTidy').suggestions(); // eslint-disable-line global-require
    return res.json({
      groups,
      people: groups.reduce((n, g) => n + g.people, 0),
      note: 'Nothing is changed until you press Apply and confirm. The old word is kept, and an undo file is saved.',
    });
  } catch (e) { return next(e); }
});
router.post('/cleanup/preview', adminOnly, express.json(), async (req, res, next) => {
  try {
    const b = req.body || {};
    return res.json(await require('../utils/sourceTidy').preview(String(b.target || ''), b.words)); // eslint-disable-line global-require
  } catch (e) { return next(e); }
});
router.post('/cleanup/apply', adminOnly, express.json(), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.confirm !== true) return res.status(400).json({ error: 'Please confirm first. Nothing was changed.' });
    const target = String(b.target || '');
    if (!CS.SOURCES.includes(target)) return res.status(400).json({ error: 'That is not one of the standard sources. Nothing was changed.' });
    const r = await require('../utils/sourceTidy').apply(req.user, target, b.words); // eslint-disable-line global-require
    memo.clear();
    return res.json(r);
  } catch (e) { return next(e); }
});
router.post('/cleanup/undo', adminOnly, express.json(), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.confirm !== true) return res.status(400).json({ error: 'Please confirm first. Nothing was changed.' });
    const r = await require('../utils/sourceTidy').undo(req.user, b.undoId); // eslint-disable-line global-require
    memo.clear(); FACET_MEMO.clear();
    return res.json(r);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    return next(e);
  }
});

module.exports = router;
module.exports.periodOf = periodOf;
module.exports.groupOf = groupOf;
module.exports.build = build; // scripts (timing on a copy of the real data)
