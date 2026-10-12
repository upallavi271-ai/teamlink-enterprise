// ---------------------------------------------------------------------------
// TEAM-WISE AND PERSON-WISE REPORTS, WITH EXPORTS (user, 2026-10-10, handwritten
// note item 5: "Team wise cash & every report individual ga & team report, daily,
// monthly etc ilaaga TL export chesukuney laaga undali").
//
// ATS Reports -> "Team & person" tab (routes/atsReportPack.js). Every report here
// is available as
//     TEAM      one line per team (a team lead's team), and
//     PERSON    one line per person, with a click-through to their own day-by-day
// for Today / Yesterday / This week / This month / Last month / a custom range, as
// totals or as day-by-day / week-by-week / month-by-month columns, with the cascading
// Department -> Team -> Person filters (counts shown). Each one downloads as Excel or
// PDF, exactly as it is on the screen, and a team lead can take ALL of a period's
// reports in one workbook, or one sheet per person ("individual packs").
//
// NOTHING IS COUNTED A NEW WAY.
//   Calls / mails / follow-ups / sent to client / interviews / offers / joined / new
//     profiles .. utils/dailyReport.js (the Daily report): same events, same "whose
//                  work is this" rule (utils/workers.js attribute()), same people.
//   Progress / Source / Client-wise .. the rows ATS Reports counts (routes/atsReports.js
//                  loadContext: same scope, same stage groups, same source list).
//   Cash        .. utils/recruiterRevenue.js (invoices net of credit notes, payments as
//                  received, attributed to the recruiter of the placement).
//
// TEAM = the recruiter's team lead: the TL above the recruiter's seat, else the TL on the
// employee record, else the TL most of their work names (utils/dailyReport.js). A team lead's
// own work counts in their own team. BDE work is the "BDE desk", HR is "Internal hiring".
//
// ROLES (server-enforced, never the screen):
//   Recruiter / HR        their own numbers only, whatever the URL says (can export their own)
//   TL                    their own team only (the people under them + themselves)
//   STL / Manager / Asst  the people inside their ATS scope (utils/scope.js)
//   Admin / Super Admin   everyone
//   BDE / BDE TL          client-wise numbers only (+ the cash of their own clients); never a
//                         recruiter / TL / team breakdown, never candidate contact or pay
//   Accounts              the cash report only, read-only
//   Client / Candidate    nothing
// Cash is money: TL / STL / Manager see the cash of the people they may see, Admin and
// Accounts see all of it, a BDE sees their own clients' totals, a Recruiter sees none.
// No export carries a candidate's phone, e-mail, salary, an internal note or an AI score.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DR = require('./dailyReport');
const W = require('./workers');
const dateRange = require('./dateRange');
const { atsScopeOf, atsViewRole } = require('./scope');
const { can } = require('./permissions');
const EX = require('./reportPackExport');
const { logAudit } = require('./audit');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom']];
const GROUPS = [['total', 'Total'], ['day', 'Day by day'], ['week', 'Week by week'], ['month', 'Month by month']];
const MAX_DAYS = 400;
const MAX_BUCKETS = { day: 93, week: 60, month: 36 };
const MAX_PEOPLE_SHEETS = 150;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const rupees = (v) => Math.round(Number(v) || 0);

// The daily numbers, in the Daily report's own order (plain words).
const METRICS = [
  ['added', 'New profiles'], ['calls', 'Calls'], ['mails', 'Mails'], ['whatsapp', 'WhatsApp'], ['followUps', 'Follow-ups done'],
  ['missed', 'Follow-ups missed'], ['reviewed', 'Resumes checked'], ['sentTl', 'Sent to team lead'], ['sentClient', 'Sent to client'],
  ['interviews', 'Interviews fixed'], ['attended', 'Interviews done'], ['feedback', 'Feedback saved'], ['offers', 'Offers'], ['joined', 'Joined'],
];
const METRIC_LABEL = Object.fromEntries(METRICS);
const METRIC_REPORTS = ['calls', 'mails', 'followUps', 'sentTl', 'sentClient', 'interviews', 'attended', 'offers', 'joined', 'added'];

const REPORTS = [
  { id: 'summary', label: 'All numbers', family: 'activity', help: 'Every daily number side by side.' },
  { id: 'daily', label: 'Day by day', family: 'activity', help: 'One line for each day, week or month.' },
  ...METRIC_REPORTS.map((k) => ({ id: k, label: METRIC_LABEL[k], family: 'activity', metric: k, help: `${METRIC_LABEL[k]} for each team or person.` })),
  { id: 'pipeline', label: 'Progress', family: 'apps', help: 'Where each team or person\'s candidates are now.' },
  { id: 'source', label: 'Where candidates come from', family: 'apps', help: 'Candidates by source, for each team or person.' },
  { id: 'clients', label: 'Client-wise', family: 'apps', clientWise: true, help: 'Jobs, sent, interviews and joined, client by client.' },
  { id: 'cash', label: 'Cash', family: 'money', help: 'Billed, collected and still to come.' },
];
const REPORT_BY_ID = Object.fromEntries(REPORTS.map((r) => [r.id, r]));
const PIPE_SKIP = new Set([]);

// ---------------------------------------------------------------------------
// WHO MAY OPEN WHAT
// ---------------------------------------------------------------------------
const ACTIVITY_IDS = REPORTS.filter((r) => r.family === 'activity').map((r) => r.id);
const STAFF_IDS = REPORTS.map((r) => r.id);

async function accessOf(user) {
  const flags = require('./clientRedact').privacyFlagsFor(user); // eslint-disable-line global-require
  const bde = !!(flags && flags.bde);
  const view = atsViewRole(user);
  const s = atsScopeOf(user);
  const moneyAll = !!(s.adminGlobal || s.accountsRole === 'ACCOUNTANT');
  const [atsView, atsExport, myView, accView, accExport] = await Promise.all([
    can(user, null, 'reports', 'ATS Reports', 'view'),
    can(user, null, 'reports', 'ATS Reports', 'export'),
    can(user, null, 'reports', 'My Results', 'view'),
    can(user, null, 'reports', 'Accounts Reports', 'view'),
    can(user, null, 'reports', 'Accounts Reports', 'export'),
  ]);
  const deny = { ok: false, view, reports: [], error: 'Team and person reports are not part of your role.' };
  if (bde) {
    if (!atsView) return deny;
    return {
      ok: true, view: 'bde', bde: true, selfOnly: false, teamOnly: false, reports: ['clients', 'cash'], cash: 'clients', canExport: !!atsExport, who: 'BDE',
    };
  }
  if (['admin', 'mgmt', 'stl', 'tl'].includes(view)) {
    if (!atsView) return deny;
    return {
      ok: true, view, bde: false, selfOnly: false, teamOnly: view === 'tl', reports: STAFF_IDS, cash: view === 'admin' ? 'all' : 'scoped', canExport: !!atsExport, who: view,
    };
  }
  if (view === 'recruiter' || view === 'hr') {
    if (!(atsView || myView)) return deny;
    return {
      ok: true, view, bde: false, selfOnly: true, teamOnly: false, reports: STAFF_IDS.filter((id) => id !== 'cash'), cash: 'none', canExport: true, who: view,
    };
  }
  if (view === 'accounts') {
    if (!(accView || moneyAll)) return deny;
    return {
      ok: true, view, bde: false, selfOnly: false, teamOnly: false, reports: ['cash'], cash: 'all', canExport: !!(accExport || moneyAll), who: 'accounts',
    };
  }
  return deny;
}

// ---------------------------------------------------------------------------
// PERIODS AND COLUMNS
// ---------------------------------------------------------------------------
function parseQuery(q = {}, today = DR.todayIst()) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const report = REPORT_BY_ID[s(q.report)] ? s(q.report) : 'summary';
  const view = s(q.view) === 'individual' ? 'individual' : 'team';
  const rangeKey = PERIODS.some(([k]) => k === s(q.range)) ? s(q.range) : 'this_month';
  let P;
  try { P = dateRange.resolve({ range: rangeKey, from: s(q.from), to: s(q.to) }, today); } catch (err) { throw new HttpError(400, err.message); }
  if (P.days > MAX_DAYS) throw new HttpError(400, 'Pick up to 13 months at a time.');
  const group = GROUPS.some(([k]) => k === s(q.group)) ? s(q.group) : 'total';
  const f = {
    department: s(q.department),
    team: s(q.team),
    person: s(q.person).replace(/^id:/, 'u:').replace(/^name:/, 'n:'),
    people: ['active', 'former'].includes(s(q.people)) ? s(q.people) : '',
  };
  return { report, view, P, group, f };
}

const dayDate = (d) => new Date(`${d}T00:00:00Z`);
const two = (n) => String(n).padStart(2, '0');
const dm = (d) => `${two(dayDate(d).getUTCDate())} ${MON[dayDate(d).getUTCMonth()]}`;

function bucketsOf(from, to, group) {
  const out = [];
  if (group === 'day') {
    for (let d = from; d <= to; d = DR.addDays(d, 1)) {
      out.push({ key: d, label: `${DOW[dayDate(d).getUTCDay()]} ${dm(d)}`, short: two(dayDate(d).getUTCDate()), from: d, to: d });
    }
  } else if (group === 'week') {
    let s = from;
    while (s <= to) {
      const monOff = (dayDate(s).getUTCDay() + 6) % 7;
      const wkEnd = DR.addDays(s, 6 - monOff);
      const e = wkEnd < to ? wkEnd : to;
      out.push({ key: s, label: s === e ? dm(s) : `${dm(s)} - ${dm(e)}`, short: dm(s), from: s, to: e });
      s = DR.addDays(e, 1);
    }
  } else if (group === 'month') {
    let s = from;
    while (s <= to) {
      const [y, m] = s.split('-').map(Number);
      const last = `${y}-${two(m)}-${two(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
      const e = last < to ? last : to;
      out.push({ key: s, label: `${MON[m - 1]} ${y}`, short: `${MON[m - 1]} ${String(y).slice(2)}`, from: s, to: e });
      s = DR.addDays(e, 1);
    }
  }
  if (out.length > (MAX_BUCKETS[group] || 1000)) {
    throw new HttpError(400, group === 'day'
      ? `Day-by-day columns are limited to ${MAX_BUCKETS.day} days - pick Week by week or Month by month.`
      : `That is too many ${group}s for one table (limit ${MAX_BUCKETS[group]}) - pick a shorter period.`);
  }
  return out;
}
function bucketIndex(buckets) {
  const m = new Map();
  buckets.forEach((b, i) => { for (let d = b.from; d <= b.to; d = DR.addDays(d, 1)) m.set(d, i); });
  return m;
}

// ---------------------------------------------------------------------------
// THE TEAM DIRECTORY — which team lead a person belongs to
// ---------------------------------------------------------------------------
let TD_CACHE = null;
async function teamDirectory() {
  if (TD_CACHE && Date.now() - TD_CACHE.at < 45000) return TD_CACHE.value;
  const [dir, positions, assigns, former] = await Promise.all([
    W.loadDirectory(),
    prisma.position.findMany({ select: { id: true, kind: true, reportsToId: true } }),
    prisma.positionAssignment.findMany({ where: { toDate: null }, select: { positionId: true, employee: { select: { userId: true } } } }),
    require('./formerPeople').formerKeys().catch(() => new Set()), // eslint-disable-line global-require
  ]);
  const empTl = new Map((await prisma.employee.findMany({ select: { userId: true, tl: true } })).filter((e) => e.userId).map((e) => [e.userId, e.tl]));
  const posById = new Map(positions.map((p) => [p.id, p]));
  const holderOfPos = new Map();
  const seatsOfUser = new Map();
  assigns.forEach((a) => {
    const uid = a.employee && a.employee.userId;
    if (!uid) return;
    holderOfPos.set(a.positionId, uid);
    if (!seatsOfUser.has(uid)) seatsOfUser.set(uid, []);
    if (posById.has(a.positionId)) seatsOfUser.get(uid).push(posById.get(a.positionId));
  });
  const tlOfUser = new Map();
  dir.users.forEach((u) => {
    if (['TL', 'STL', 'BDE', 'HR'].includes(u.atsRole)) return;
    const seat = (seatsOfUser.get(u.id) || []).find((p) => p.kind === 'RECRUITER');
    let tl = seat && seat.reportsToId ? holderOfPos.get(seat.reportsToId) : null;
    if (!tl && empTl.get(u.id)) { const p = dir.person(null, empTl.get(u.id)); tl = p && p.userId; }
    if (tl && tl !== u.id) tlOfUser.set(u.id, tl);
  });
  const value = {
    dir, userById: dir.person.userById, tlOfUser, former,
  };
  TD_CACHE = { at: Date.now(), value };
  return value;
}

const ROLE_WORD = {
  RECRUITER: 'Recruiter', TL: 'Team lead', STL: 'Senior team lead', BDE: 'Client manager (BDE)', HR: 'Internal hiring (HR)',
};
const TEAM_NONE = 'team:none';
const TEAM_BDE = 'team:bde';
const TEAM_HR = 'team:hr';

// One person's facts: label, role, team, department, whether they have left.
function makeInfo(td, world) {
  const memo = new Map();
  const teamLabelOf = (tk) => {
    if (tk === TEAM_BDE) return 'BDE desk (client managers)';
    if (tk === TEAM_HR) return 'Internal hiring (HR)';
    if (tk === TEAM_NONE) return 'No team found';
    const u = td.userById.get(tk.slice(2));
    return u ? `${u.name}'s team` : 'A team';
  };
  return function infoOf(pk, tlKey = null, deptHint = '') {
    const mk = `${pk}|${tlKey || ''}|${deptHint}`;
    if (memo.has(mk)) return memo.get(mk);
    const uid = pk.startsWith('u:') ? pk.slice(2) : null;
    const u = uid ? td.userById.get(uid) : null;
    let label = pk === '—' ? 'Unassigned' : pk.replace(/^n:/, '');
    let teamKey = null;
    let role = null;
    if (u) {
      label = u.name;
      role = u.atsRole;
      if (role === 'BDE') teamKey = TEAM_BDE;
      else if (role === 'HR') teamKey = TEAM_HR;
      else if (role === 'TL' || role === 'STL') teamKey = pk;
      else if (td.tlOfUser.get(uid)) teamKey = `u:${td.tlOfUser.get(uid)}`;
    } else if (world && world.people.get(pk)) label = world.people.get(pk).label;
    if (!teamKey) teamKey = tlKey || (world && world.personTl.get(pk)) || null;
    if (teamKey && teamKey.startsWith('u:') && !td.userById.get(teamKey.slice(2))) teamKey = null;
    if (!teamKey) teamKey = TEAM_NONE;
    const dept = (world && world.personDept.get(pk)) || (u && (u.atsDepartment || ((td.dir.empByUser.get(uid) || {}).department))) || deptHint || '';
    const former = td.former.has(pk);
    const out = {
      key: pk, label, role, roleWord: role ? (ROLE_WORD[role] || role) : (pk === '—' ? '' : 'Recruiter (left)'), teamKey, teamLabel: teamLabelOf(teamKey), dept, former,
    };
    memo.set(mk, out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// FILTERS (cascading, with counts)
// ---------------------------------------------------------------------------
function passes(info, f, omit = null) {
  if (omit !== 'department' && f.department && info.dept !== f.department) return false;
  if (omit !== 'team' && f.team && info.teamKey !== f.team) return false;
  if (omit !== 'person' && f.person && info.key !== f.person) return false;
  if (omit !== 'people' && f.people && (info.former ? 'former' : 'active') !== f.people) return false;
  return true;
}
// facts: [{ info }]. Each option is counted over the facts every OTHER filter lets through; an
// option with nothing behind it is not offered (the chosen one always stays so it can be removed).
function facetsOf(facts, f) {
  const count = (omit, keyOf, labelOf) => {
    const m = new Map();
    facts.forEach((x) => {
      if (!passes(x.info, f, omit)) return;
      const k = keyOf(x.info);
      if (!k) return;
      const e = m.get(k) || { value: k, label: labelOf(x.info), count: 0 };
      e.count += 1;
      m.set(k, e);
    });
    return m;
  };
  const finish = (m, chosen, labelOfChosen) => {
    const list = [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (chosen && !list.some((o) => o.value === chosen)) list.unshift({ value: chosen, label: labelOfChosen(chosen), count: 0 });
    return list;
  };
  return {
    departments: finish(count('department', (i) => i.dept, (i) => i.dept), f.department, (v) => v),
    teams: finish(count('team', (i) => (i.teamKey === TEAM_NONE ? null : i.teamKey), (i) => i.teamLabel), f.team, (v) => v),
    people: finish(count('person', (i) => i.key, (i) => (i.former ? `${i.label} - Former` : i.label)), f.person, (v) => v),
    status: finish(count('people', (i) => (i.former ? 'former' : 'active'), (i) => (i.former ? 'Former (have left)' : 'Still working here')), f.people, (v) => v),
  };
}

// ---------------------------------------------------------------------------
// ONE REQUEST'S WORLD — loaded lazily, once
// ---------------------------------------------------------------------------
class Run {
  constructor(user, access, td) {
    this.user = user; this.access = access; this.td = td; this.self = `u:${user.id}`;
    this.memo = {};
  }

  async world() {
    if (!this.memo.world) this.memo.world = DR.worldFor(this.user);
    return this.memo.world;
  }

  async infoOf() {
    if (!this.memo.info) this.memo.info = makeInfo(this.td, this.access.view === 'accounts' || this.access.bde ? null : await this.world());
    return this.memo.info;
  }

  // The people this login may read, as person keys (null = nobody is held back).
  async allowed() {
    if (this.memo.allowed) return this.memo.allowed;
    const a = this.access;
    let set = null;
    if (a.selfOnly) set = new Set([this.self]);
    else if (a.teamOnly) {
      const w = await this.world();
      const s = atsScopeOf(this.user);
      const ids = new Set([this.user.id, ...(s.teamUserIds || []), ...((s.positions && s.positions.holderUserIds) || [])]);
      const info = await this.infoOf();
      set = new Set([...w.people.keys()].filter((k) => (k.startsWith('u:') && ids.has(k.slice(2))) || info(k).teamKey === this.self));
      set.add(this.self);
    } else if (a.view === 'mgmt' || a.view === 'stl' || a.view === 'admin') {
      set = new Set((await this.world()).people.keys());
    }
    this.memo.allowed = set;
    return set;
  }

  async activity(P) {
    const mk = `act|${P.from}|${P.to}`;
    if (this.memo[mk]) return this.memo[mk];
    const world = await this.world();
    const info = await this.infoOf();
    const allowed = await this.allowed();
    const today = DR.todayIst();
    const lastDay = P.to < today ? P.to : today;
    const events = P.from > today ? [] : await DR.eventsIn(this.user, world, P.from, lastDay);
    const facts = events.filter((e) => allowed.has(e.person.key)).map((e) => ({
      pk: e.person.key, day: e.day, metric: e.metric, info: info(e.person.key),
    }));
    // Quiet people: a team lead must see who did nothing, too (current logins on the team only).
    const quiet = [...allowed].filter((k) => {
      const i = info(k);
      return k.startsWith('u:') && !i.former && ['RECRUITER', 'TL', 'STL'].includes(i.role);
    });
    const out = { facts, quiet: quiet.map((k) => info(k)) };
    this.memo[mk] = out;
    return out;
  }

  async apps(P) {
    const mk = `apps|${P.from}|${P.to}`;
    if (this.memo[mk]) return this.memo[mk];
    const ar = require('../routes/atsReports'); // eslint-disable-line global-require
    const ctx = await ar.packContext(this.user, { range: 'custom', from: P.from, to: P.to }, 'createdAt');
    const info = await this.infoOf();
    const allowed = this.access.bde ? null : await this.allowed();
    const facts = [];
    ctx.apps.forEach((x) => {
      const pk = x.recruiter && x.recruiter.key ? x.recruiter.key : '—';
      if (allowed && pk !== '—' && !allowed.has(pk)) return;
      if (this.access.selfOnly && pk !== this.self) return;
      facts.push({
        pk, x, info: info(pk, x.tl && x.tl.key, x.req.department || ''),
      });
    });
    const out = { ctx, facts, PIPE: ar.PIPE, channelOf: ar.channelOf };
    this.memo[mk] = out;
    return out;
  }

  async money(P) {
    const mk = `money|${P.from}|${P.to}`;
    if (this.memo[mk]) return this.memo[mk];
    const RR = require('./recruiterRevenue'); // eslint-disable-line global-require
    const a = this.access;
    const q = { range: 'custom', from: P.from, to: P.to };
    let b;
    if (a.cash === 'all') b = await RR.build(this.user, q);
    else if (a.cash === 'scoped') b = await RR.build(this.user, q, { rawScope: {} });
    else if (a.cash === 'clients') {
      const s = atsScopeOf(this.user);
      const ids = (s.bdeOwnClientIds || s.clientIds || []);
      b = await RR.build(this.user, q, { rawScope: ids.length ? { clientId: { in: ids } } : { id: '__none__' } });
    } else throw new HttpError(403, 'Cash is not part of your role.');
    this.memo[mk] = b;
    return b;
  }
}

// ---------------------------------------------------------------------------
// TABLE HELPERS
// ---------------------------------------------------------------------------
const sortRows = (rows, totalOf) => rows.sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0) || totalOf(b) - totalOf(a) || String(a.label).localeCompare(String(b.label)));
const sumCols = (rows, n, from = 0) => Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + (Number(r.c[from + j]) || 0), 0));

function numCol(key, label, extra = {}) { return { key, label, type: 'num', ...extra }; }

// ACTIVITY (summary / day by day / one number by columns) -------------------------------------------------
async function activityTable(run, rep, { view, group, f, P }) {
  const A = await run.activity(P);
  const facets = facetsOf(A.facts, f);
  const facts = A.facts.filter((x) => passes(x.info, f));
  const mkLabel = (i) => (i.former ? `${i.label} - Former` : i.label);
  const unitOf = (i) => (view === 'team' ? { key: i.teamKey, label: i.teamLabel, last: i.teamKey === TEAM_NONE } : { key: i.key, label: mkLabel(i) });
  const metricKeys = METRICS.map(([k]) => k);

  // The day-by-day report: rows are the days (weeks, months) of the period, columns the numbers.
  if (rep.id === 'daily') {
    const g = group === 'total' ? 'day' : group;
    const buckets = bucketsOf(P.from, P.to, g);
    const idx = bucketIndex(buckets);
    const rows = buckets.map((b) => ({ key: b.key, label: b.label, c: [b.label, ...metricKeys.map(() => 0)] }));
    facts.forEach((x) => { const i = idx.get(x.day); const j = metricKeys.indexOf(x.metric); if (i !== undefined && j >= 0) rows[i].c[1 + j] += 1; });
    const today = DR.todayIst();
    rows.forEach((r, i) => { if (buckets[i].from > today) r.c = [r.c[0], ...metricKeys.map(() => null)]; });
    const total = ['Total', ...sumCols(rows, metricKeys.length, 1)];
    return {
      columns: [{ key: 'when', label: g === 'day' ? 'Day' : g === 'week' ? 'Week' : 'Month', type: 'text' }, ...METRICS.map(([k, l]) => numCol(k, l))],
      rows, total, facets, groupLabel: GROUPS.find(([k]) => k === g)[1], effectiveGroup: g, rowsAre: 'buckets',
      notes: ['Future days are left blank. Pending work is known for today only, so it is not in this table.'],
    };
  }

  // Rows: one per team / person.
  const rowsMap = new Map();
  const ensure = (info) => {
    const u = unitOf(info);
    if (!rowsMap.has(u.key)) rowsMap.set(u.key, { key: u.key, label: u.label, last: u.last, people: new Set(), team: info.teamLabel, role: info.roleWord, counts: Object.fromEntries(metricKeys.map((k) => [k, 0])), by: new Map() });
    return rowsMap.get(u.key);
  };
  A.quiet.forEach((i) => { if (passes(i, f)) ensure(i).people.add(i.key); });
  const metric = rep.metric || null;
  const buckets = metric && group !== 'total' ? bucketsOf(P.from, P.to, group) : [];
  const idx = buckets.length ? bucketIndex(buckets) : null;
  facts.forEach((x) => {
    const r = ensure(x.info);
    r.people.add(x.pk);
    r.counts[x.metric] += 1;
    if (metric && idx && x.metric === metric) { const i = idx.get(x.day); if (i !== undefined) r.by.set(i, (r.by.get(i) || 0) + 1); }
  });
  const list = [...rowsMap.values()];
  const lead = view === 'team'
    ? [{ key: 'name', label: 'Team', type: 'text' }, numCol('people', 'People')]
    : [{ key: 'name', label: 'Person', type: 'text' }, { key: 'team', label: 'Team', type: 'text' }, { key: 'role', label: 'Role', type: 'text' }];
  const leadCells = (r) => (view === 'team' ? [r.label, r.people.size] : [r.label, r.team, r.role]);
  const nLead = lead.length;

  if (rep.id === 'summary') {
    const rows = sortRows(list.map((r) => ({
      key: r.key, label: r.label, last: r.last, c: [...leadCells(r), ...metricKeys.map((k) => r.counts[k])],
    })), (r) => r.c.slice(nLead).reduce((s, v) => s + v, 0));
    const total = ['Total', ...Array(nLead - 1).fill(null), ...sumCols(rows, metricKeys.length, nLead)];
    if (view === 'team') total[1] = rows.reduce((s, r) => s + r.c[1], 0);
    return {
      columns: [...lead, ...METRICS.map(([k, l]) => numCol(k, l))], rows, total, facets, groupLabel: '', effectiveGroup: 'total', rowsAre: 'units',
      notes: ['Pending work is known for today only, so it is not here. New profiles counts profiles created in the app, not imported sheets.'],
    };
  }
  // One number, by columns.
  const cols = [...lead, ...buckets.map((b) => numCol(`b${b.key}`, b.label, { short: b.short })), numCol('total', group === 'total' ? METRIC_LABEL[metric] : 'Total')];
  const rows = sortRows(list.map((r) => ({
    key: r.key, label: r.label, last: r.last, c: [...leadCells(r), ...buckets.map((b, i) => r.by.get(i) || 0), r.counts[metric]],
  })), (r) => r.c[r.c.length - 1]);
  const total = ['Total', ...Array(nLead - 1).fill(null), ...sumCols(rows, buckets.length + 1, nLead)];
  if (view === 'team') total[1] = rows.reduce((s, r) => s + r.c[1], 0);
  return {
    columns: cols, rows, total, facets, groupLabel: group === 'total' ? '' : GROUPS.find(([k]) => k === group)[1], effectiveGroup: group, rowsAre: 'units', notes: [],
  };
}

// APPLICATIONS (Progress / Source / Client-wise) -----------------------------------------------------------
async function appsTable(run, rep, { view, f, P }) {
  const A = await run.apps(P);
  const bde = run.access.bde;
  const facts0 = A.facts;
  const facets = bde ? { departments: [], teams: [], people: [], status: [] } : facetsOf(facts0, f);
  const facts = bde ? facts0 : facts0.filter((x) => passes(x.info, f));

  if (rep.id === 'clients') {
    const rows = new Map();
    facts.forEach(({ x }) => {
      const k = x.req.clientKey;
      if (!rows.has(k)) rows.set(k, { key: k, label: x.req.clientName, reqs: new Set(), apps: 0, sent: 0, interviews: 0, selected: 0, joined: 0 });
      const r = rows.get(k);
      r.reqs.add(x.req.id); r.apps += 1;
      if (x.joined || x.reached('shared')) r.sent += 1;
      if (x.joined || x.reached('interview')) r.interviews += 1;
      if (x.joined || x.reached('selected')) r.selected += 1;
      if (x.joined) r.joined += 1;
    });
    const out = sortRows([...rows.values()].map((r) => ({ key: r.key, label: r.label, c: [r.label, r.reqs.size, r.apps, r.sent, r.interviews, r.selected, r.joined, pct(r.joined, r.apps)] })), (r) => r.c[2]);
    const total = ['Total', null, ...[2, 3, 4, 5, 6].map((j) => out.reduce((s, r) => s + r.c[j], 0)), null];
    total[7] = pct(total[6], total[2]);
    const jobs = new Set(); facts.forEach(({ x }) => jobs.add(x.req.id)); total[1] = jobs.size;
    return {
      columns: [{ key: 'client', label: 'Client', type: 'text' }, numCol('jobs', 'Jobs worked on'), numCol('applications', 'Candidates'), numCol('sent', 'Sent to client'), numCol('interviews', 'Interviews'), numCol('selected', 'Selected'), numCol('joined', 'Joined'), { key: 'conv', label: 'Joined %', type: 'pct' }],
      rows: out, total, facets, groupLabel: '', effectiveGroup: 'total', rowsAre: 'units',
      notes: ['Candidates added to the client\'s jobs in this period. Sent, Interviews and Selected count everyone who got that far (also those who went further).'],
    };
  }

  const isSource = rep.id === 'source';
  const CHANNELS = ['Naukri', 'Indeed', 'Shine', 'LinkedIn', 'Referral', 'Recruiter', 'BDE', 'Job Portal', 'Other'];
  const groups = A.PIPE;
  const unitOf = (i) => (view === 'team' ? { key: i.teamKey, label: i.teamLabel, last: i.teamKey === TEAM_NONE } : { key: i.key, label: i.former ? `${i.label} - Former` : i.label });
  const rows = new Map();
  facts.forEach((fa) => {
    const u = unitOf(fa.info);
    if (!rows.has(u.key)) rows.set(u.key, { key: u.key, label: u.label, last: u.last, team: fa.info.teamLabel, role: fa.info.roleWord, people: new Set(), n: 0, joined: 0, inPipe: 0, by: {} });
    const r = rows.get(u.key);
    r.people.add(fa.pk); r.n += 1;
    if (fa.x.joined) r.joined += 1;
    if (fa.x.inPipeline) r.inPipe += 1;
    const col = isSource ? A.channelOf(fa.x.source) : fa.x.pipe.id;
    r.by[col] = (r.by[col] || 0) + 1;
  });
  const lead = view === 'team'
    ? [{ key: 'name', label: 'Team', type: 'text' }, numCol('people', 'People')]
    : [{ key: 'name', label: 'Person', type: 'text' }, { key: 'team', label: 'Team', type: 'text' }, { key: 'role', label: 'Role', type: 'text' }];
  const leadCells = (r) => (view === 'team' ? [r.label, r.people.size] : [r.label, r.team, r.role]);
  const nLead = lead.length;
  const dims = isSource ? CHANNELS.map((c) => ({ id: c, label: c })) : groups.map((g) => ({ id: g.id, label: g.label }));
  const columns = [...lead, numCol('applications', 'Candidates'), ...(isSource ? [] : [numCol('inPipeline', 'In process')]), ...dims.map((d) => numCol(`d_${d.id}`, d.label)), ...(isSource ? [numCol('joinedAll', 'Joined')] : []), { key: 'conv', label: 'Joined %', type: 'pct' }];
  const out = sortRows([...rows.values()].map((r) => ({
    key: r.key, label: r.label, last: r.last,
    c: [...leadCells(r), r.n, ...(isSource ? [] : [r.inPipe]), ...dims.map((d) => r.by[d.id] || 0), ...(isSource ? [r.joined] : []), pct(r.joined, r.n)],
  })), (r) => r.c[nLead]);
  const sums = sumCols(out, columns.length - nLead - 1, nLead);
  const joinedTotal = out.reduce((s, r) => s + (isSource ? r.c[r.c.length - 2] : r.c[nLead + 2 + dims.findIndex((d) => d.id === 'joined')]), 0);
  const total = ['Total', ...Array(nLead - 1).fill(null), ...sums, pct(joinedTotal, sums[0])];
  if (view === 'team') total[1] = out.reduce((s, r) => s + r.c[1], 0);
  return {
    columns, rows: out, total, facets, groupLabel: '', effectiveGroup: 'total', rowsAre: 'units',
    notes: [isSource
      ? 'Candidates added to jobs in this period, by where they came from. Joined % is Joined / Candidates.'
      : 'Candidates added to jobs in this period, by the step each one is at NOW (the same steps as Candidates & Progress). Joined % is Joined / Candidates.'],
  };
}

// CASH ----------------------------------------------------------------------------------------------------
async function cashTable(run, rep, { view, group, f, P }) {
  const b = await run.money(P);
  const a = run.access;
  const A = require('./accounts'); // eslint-disable-line global-require
  const info = a.cash === 'clients' ? null : (a.cash === 'all' ? makeInfo(run.td, null) : await run.infoOf());
  const allowed = a.cash === 'scoped' ? await run.allowed() : null;
  const MF = require('./moneyFacts'); // eslint-disable-line global-require
  void MF;
  const invs = b.options.invs;
  const unattributed = (i) => i.rec.key === '—';
  // Per-invoice facts: where it counts (team / person / client).
  const infoOfInv = (i) => (info ? info(i.rec.key, null, (i.client && i.client.ownerDepartment) || '') : null);
  const inScope = (i) => (a.cash !== 'scoped' || (!unattributed(i) && allowed.has(i.rec.key)));
  const live = b.live.filter(inScope);
  const billedList = b.inRange.filter(inScope);
  const paysAll = b.pays.filter((p) => { const i = b.invById.get(p.invoiceId); return i && inScope(i); });
  const owing = live.filter((i) => b.outstandingOf(i) > 0.5);
  const factsAll = [...new Set([...billedList, ...paysAll.map((p) => b.invById.get(p.invoiceId)), ...owing])].map((i) => ({ pk: i.rec.key, inv: i, info: infoOfInv(i) }));
  const facets = a.cash === 'clients' ? { departments: [], teams: [], people: [], status: [] } : facetsOf(factsAll, f);
  const ok = (i) => a.cash === 'clients' || passes(infoOfInv(i), f);
  const buckets = group !== 'total' ? bucketsOf(P.from, P.to, group) : [];
  const idx = buckets.length ? bucketIndex(buckets) : null;

  const unitOf = (i) => {
    if (a.cash === 'clients') return { key: i.clientId, label: (i.client && i.client.name) || '—' };
    const inf = infoOfInv(i);
    if (view === 'team') return { key: inf.teamKey, label: inf.teamLabel, last: inf.teamKey === TEAM_NONE };
    return { key: i.rec.key, label: i.rec.key === '—' ? 'No recruiter on the placement' : (inf.former ? `${inf.label} - Former` : inf.label), last: i.rec.key === '—' };
  };
  const rows = new Map();
  const row = (i) => {
    const u = unitOf(i);
    if (!rows.has(u.key)) {
      const inf = infoOfInv(i);
      rows.set(u.key, {
        key: u.key, label: u.label, last: u.last, team: inf ? inf.teamLabel : '', people: new Set(), n: 0, billed: 0, collected: 0, pending: 0, by: new Map(),
      });
    }
    return rows.get(u.key);
  };
  billedList.filter(ok).forEach((i) => {
    const r = row(i); r.n += 1; r.billed += i.netAmount; r.people.add(i.rec.key);
    if (idx) { const bi = idx.get(String(i.invoiceDate || '').slice(0, 10)); if (bi !== undefined) r.by.set(bi, (r.by.get(bi) || 0) + i.netAmount); }
  });
  paysAll.forEach((p) => { const i = b.invById.get(p.invoiceId); if (i && ok(i)) { const r = row(i); r.collected += Number(p.amount || 0); r.people.add(i.rec.key); } });
  owing.filter(ok).forEach((i) => { const r = row(i); r.pending += b.outstandingOf(i); r.people.add(i.rec.key); });

  const unit = a.cash === 'clients' ? 'Client' : view === 'team' ? 'Team' : 'Person';
  const lead = a.cash === 'clients' ? [{ key: 'name', label: 'Client', type: 'text' }]
    : view === 'team' ? [{ key: 'name', label: 'Team', type: 'text' }, numCol('people', 'People billed')]
      : [{ key: 'name', label: 'Person', type: 'text' }, { key: 'team', label: 'Team', type: 'text' }];
  const leadCells = (r) => (a.cash === 'clients' ? [r.label] : view === 'team' ? [r.label, r.people.size] : [r.label, r.team]);
  const nLead = lead.length;
  const money = (key, label, extra = {}) => ({ key, label, type: 'money', ...extra });
  const columns = [...lead, numCol('invoices', 'Placements billed'), ...buckets.map((bk) => money(`b${bk.key}`, `Billed ${bk.label}`, { short: bk.short })), money('billed', 'Billed (before GST) Rs'), money('collected', 'Collected Rs'), money('pending', 'Still to come Rs')];
  const out = sortRows([...rows.values()].map((r) => ({
    key: r.key, label: r.label, last: r.last,
    c: [...leadCells(r), r.n, ...buckets.map((bk, i) => rupees(r.by.get(i) || 0)), rupees(r.billed), rupees(r.collected), rupees(r.pending)],
  })), (r) => r.c[nLead + 1 + buckets.length]);
  const sums = sumCols(out, columns.length - nLead, nLead);
  // The totals are worked out from the exact amounts and rounded once (as Recruiter revenue does).
  const exact = [...rows.values()];
  const tBilled = rupees(exact.reduce((s, r) => s + r.billed, 0));
  const tColl = rupees(exact.reduce((s, r) => s + r.collected, 0));
  const tPend = rupees(exact.reduce((s, r) => s + r.pending, 0));
  sums[sums.length - 3] = tBilled; sums[sums.length - 2] = tColl; sums[sums.length - 1] = tPend;
  const total = ['Total', ...Array(nLead - 1).fill(null), ...sums];
  if (a.cash !== 'clients' && view === 'team') total[1] = new Set(exact.flatMap((r) => [...r.people])).size;
  const notes = [];
  if (!invs.length) notes.push('No money data yet. There are no invoices in your area for these filters.');
  else if (!out.length) notes.push('No invoices or payments in this period for these filters.');
  notes.push('Billed is the invoice amount before GST, after credit notes, by invoice date. Collected is money received in the period, by payment date. Still to come is what is unpaid on open invoices as of today (not limited to the period).');
  const hidden = a.cash === 'scoped' ? b.inRange.filter((i) => !inScope(i)).length : 0;
  if (hidden) notes.push(`${hidden} invoice(s) of people outside your area are not counted.`);
  void A; void unit;
  return {
    columns, rows: out, total, facets, groupLabel: group === 'total' ? '' : `Billed ${GROUPS.find(([k]) => k === group)[1].toLowerCase()}`, effectiveGroup: group, rowsAre: 'units', notes,
    clientRows: a.cash === 'clients',
  };
}

// ---------------------------------------------------------------------------
// THE REPORT (what the screen draws and the files carry)
// ---------------------------------------------------------------------------
function describeFilters(t, f, facets) {
  const parts = [];
  const lab = (list, v) => ((list || []).find((o) => o.value === v) || {}).label || v;
  if (f.department) parts.push(`Department: ${f.department}`);
  if (f.team) parts.push(`Team: ${lab(facets.teams, f.team)}`);
  if (f.person) parts.push(`Person: ${lab(facets.people, f.person)}`);
  if (f.people) parts.push(f.people === 'former' ? 'Only people who have left' : 'Only people still working here');
  return parts.length ? parts.join(' - ') : 'No filters (everything in your area)';
}

function scopeText(access, user) {
  if (access.selfOnly) return 'Your own numbers';
  if (access.bde) return 'Your clients (client-wise numbers only)';
  if (access.view === 'accounts') return 'Accounts: all money';
  if (access.view === 'tl') return 'Your team';
  const label = require('./scope').scopeLabel(user, 'ats'); // eslint-disable-line global-require
  return label || 'Your area';
}

async function runOf(user) {
  const access = await accessOf(user);
  if (!access.ok) throw new HttpError(403, access.error);
  return new Run(user, access, await teamDirectory());
}

async function buildTable(run, query) {
  const { access, user } = run;
  const parsed = typeof query.P === 'object' && query.report ? query : parseQuery(query);
  const { report, P, group, f } = parsed;
  let { view } = parsed;
  const rep = REPORT_BY_ID[report];
  if (!access.reports.includes(report)) {
    throw new HttpError(403, access.bde
      ? 'This report is not part of the BDE view. Your reports are client-wise: Client-wise and Cash (your clients).'
      : 'This report is not part of your role.');
  }
  // A recruiter / HR login has one line: themselves. The Team view has nothing to roll up.
  if (access.selfOnly) view = 'individual';
  // People filters are the lead's; a login that sees only itself or only clients ignores them.
  const ff = access.selfOnly || access.bde ? { department: '', team: '', person: '', people: '' } : f;
  const args = { view, group, f: ff, P };
  let base;
  if (rep.family === 'activity') base = await activityTable(run, rep, args);
  else if (rep.family === 'money') base = await cashTable(run, rep, args);
  else base = await appsTable(run, rep, args);
  const clientWise = rep.clientWise || base.clientRows;
  const viewWord = clientWise ? 'Client' : view === 'team' ? 'Team' : 'Individual';
  const facets = base.facets;
  const reportLabel = rep.id === 'clients' ? 'Client-wise' : rep.label;
  return {
    report, reportLabel, family: rep.family, view, viewWord,
    viewLabel: clientWise ? 'Client-wise (one line per client)' : view === 'team' ? 'Team-wise (one line per team lead\'s team)' : 'Individual (one line per person)',
    title: clientWise ? `Client-wise report - ${rep.id === 'cash' ? 'Cash' : 'Jobs and joinings'}` : `${view === 'team' ? 'Team' : 'Individual'} report - ${reportLabel}`,
    sheetName: reportLabel,
    period: { key: P.key, label: P.label, from: P.from, to: P.to },
    group: base.effectiveGroup, groupLabel: base.groupLabel,
    filters: ff, filterText: describeFilters(null, ff, facets),
    scope: scopeText(access, user),
    columns: base.columns, rows: base.rows, total: base.total, notes: base.notes || [],
    options: facets, rowsAre: base.rowsAre,
    canDrill: base.rowsAre === 'units' && !clientWise && rep.family !== 'money',
  };
}

// The JSON the screen draws.
async function screenReport(user, query) {
  const run = await runOf(user);
  const t = await buildTable(run, query);
  const access = run.access;
  let emailConnected = false;
  try { emailConnected = !!(await require('./mailer').emailConfig()).configured; } catch { /* not connected */ } // eslint-disable-line global-require
  return {
    ...t,
    generatedAt: EX.istStamp(),
    generatedBy: user.name,
    caps: {
      canExport: access.canExport,
      canExportAll: access.canExport && !access.bde && access.view !== 'accounts',
      canExportPeople: access.canExport && !access.bde && !access.selfOnly && access.view !== 'accounts',
      emailConnected,
      selfOnly: access.selfOnly,
      bde: access.bde,
      cash: access.cash,
    },
  };
}

function metaOf(user) {
  return { by: user.name || 'a TeamLink user', at: EX.istStamp() };
}

async function auditExport(user, { format, what, id, filterText, rows, sheets, scope, period }) {
  await logAudit({
    userId: user.id,
    actorName: user.name,
    action: `ATS report exported (${String(format).toUpperCase()})`,
    entity: 'AtsReportPack',
    entityId: id || null,
    fromValue: String(`${what} - ${filterText}`).slice(0, 480),
    toValue: `${rows} row(s)${sheets > 1 ? ` in ${sheets} sheets` : ''} - scope: ${scope} - ${period.from} to ${period.to}`,
  });
}

function assertCanExport(run) {
  if (!run.access.canExport) throw new HttpError(403, 'Your role can look at these reports but not download them.');
}

// ONE REPORT, as a file.
async function exportReport(user, query, format) {
  const run = await runOf(user);
  assertCanExport(run);
  const t = await buildTable(run, query);
  const meta = metaOf(user);
  const base = EX.fileBase(t);
  await auditExport(user, {
    format, what: t.title, id: t.report, filterText: `${t.period.label}${t.groupLabel ? `, ${t.groupLabel}` : ''}, ${t.filterText}`, rows: t.rows.length, sheets: 1, scope: t.scope, period: t.period,
  });
  if (format === 'pdf') return { table: t, meta, name: `${base}.pdf`, type: 'application/pdf', pdf: true, rows: t.rows.length };
  if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: EX.toCsv(t, meta), rows: t.rows.length };
  return {
    name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: EX.toWorkbook([{ name: t.sheetName, table: t }], meta), rows: t.rows.length,
  };
}

// The group for a pack's day-by-day sheets: days when they fit, otherwise weeks / months.
const autoGroup = (P) => (P.days <= 31 ? 'day' : P.days <= 120 ? 'week' : 'month');

// ALL OF THE PERIOD'S REPORTS in one workbook (the lead's "Export all my team's reports").
async function exportAll(user, query) {
  const run = await runOf(user);
  assertCanExport(run);
  if (run.access.bde || run.access.view === 'accounts') throw new HttpError(403, 'The all-reports workbook is for recruiting teams. Use Download Excel on your report.');
  const parsed = parseQuery(query);
  const { P, f } = parsed;
  const group = parsed.group === 'total' ? autoGroup(P) : parsed.group;
  const meta = metaOf(user);
  const make = (report, view, g = 'total') => buildTable(run, { report, view, P, group: g, f });
  const sheets = [];
  const add = async (name, report, view, g) => {
    if (!run.access.reports.includes(report)) return;
    const t = await make(report, view, g);
    sheets.push({ name, table: t });
  };
  const self = run.access.selfOnly;
  if (!self) await add('Team - all numbers', 'summary', 'team');
  await add(self ? 'My numbers' : 'People - all numbers', 'summary', 'individual');
  await add('Day by day', 'daily', 'individual', group);
  for (const [id, nm] of [['calls', 'Calls'], ['followUps', 'Follow-ups'], ['sentClient', 'Sent to client'], ['interviews', 'Interviews'], ['joined', 'Joined']]) {
    // eslint-disable-next-line no-await-in-loop
    await add(`${nm} ${group === 'day' ? 'by day' : group === 'week' ? 'by week' : 'by month'}`, id, 'individual', group);
  }
  if (!self) await add('Team - progress', 'pipeline', 'team');
  await add(self ? 'My progress' : 'People - progress', 'pipeline', 'individual');
  if (!self) await add('Team - sources', 'source', 'team');
  await add(self ? 'My sources' : 'People - sources', 'source', 'individual');
  await add('Client-wise', 'clients', 'team');
  if (run.access.reports.includes('cash')) {
    if (!self) await add('Team - cash', 'cash', 'team', group);
    await add('People - cash', 'cash', 'individual', group);
  }
  const rows = sheets.reduce((n, s) => n + s.table.rows.length, 0);
  const period = sheets[0].table.period;
  const about = [
    ['TeamLink - all reports for the period'], [`Period: ${period.label} (${period.from} to ${period.to})`], [`Filters: ${sheets[0].table.filterText}`],
    [`Your area: ${sheets[0].table.scope}`], [`Generated by ${meta.by} on ${meta.at}`], [],
    ['Sheet', 'What it shows'], ...sheets.map((s) => [s.name, s.table.title]),
  ];
  const label = { from: period.from, to: period.to };
  await auditExport(user, {
    format: 'xlsx', what: 'All reports workbook', id: 'all', filterText: `${period.label}, ${sheets[0].table.filterText}`, rows, sheets: sheets.length, scope: sheets[0].table.scope, period: label,
  });
  return {
    name: `TeamLink-All-Reports-${period.from}_to_${period.to}.xlsx`,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: EX.toWorkbook(sheets, meta, about),
    rows, sheets: sheets.length,
  };
}

// INDIVIDUAL PACKS: one sheet for each person of the period, so a lead can hand each their own report.
async function exportPeople(user, query) {
  const run = await runOf(user);
  assertCanExport(run);
  const a = run.access;
  if (a.bde || a.view === 'accounts' || a.selfOnly) throw new HttpError(403, 'Individual packs are for team leads and managers.');
  const parsed = parseQuery(query);
  const { P, f } = parsed;
  const group = parsed.group === 'total' ? (P.days <= 62 ? 'day' : P.days <= 200 ? 'week' : 'month') : parsed.group;
  const meta = metaOf(user);
  const summary = await buildTable(run, { report: 'summary', view: 'individual', P, group: 'total', f });
  const people = summary.rows.filter((r) => r.key && !String(r.key).startsWith('team:'));
  if (people.length > MAX_PEOPLE_SHEETS) throw new HttpError(400, `That is ${people.length} people - pick a department or a team first (limit ${MAX_PEOPLE_SHEETS} per file).`);
  const A = await run.activity(P);
  const buckets = bucketsOf(P.from, P.to, group);
  const idx = bucketIndex(buckets);
  const today = DR.todayIst();
  const metricKeys = METRICS.map(([k]) => k);
  let pipe = null; let cash = null;
  if (a.reports.includes('pipeline')) pipe = await buildTable(run, { report: 'pipeline', view: 'individual', P, group: 'total', f });
  if (a.reports.includes('cash')) { try { cash = await buildTable(run, { report: 'cash', view: 'individual', P, group: 'total', f }); } catch { cash = null; } }
  const head = [
    [`TeamLink - Individual pack`], [`Period: ${P.label} (${P.from} to ${P.to})`], [`Filters: ${summary.filterText}`], [`Your area: ${summary.scope}`], [`Generated by ${meta.by} on ${meta.at}`], [],
  ];
  const sheets = [{ name: 'Team summary', table: summary }];
  let rowCount = summary.rows.length;
  for (const p of people) {
    const mine = A.facts.filter((x) => x.pk === p.key);
    const rows = buckets.map((b) => [b.label, ...metricKeys.map(() => (b.from > today ? null : 0))]);
    mine.forEach((x) => { const i = idx.get(x.day); const j = metricKeys.indexOf(x.metric); if (i !== undefined && j >= 0 && rows[i][1 + j] !== null) rows[i][1 + j] += 1; });
    const tot = metricKeys.map((_, j) => rows.reduce((s, r) => s + (r[1 + j] || 0), 0));
    const lines = [
      [`TeamLink - ${p.c[0]}`], ...head.slice(1),
      [`Day by day (${GROUPS.find(([k]) => k === group)[1].toLowerCase()})`],
      [group === 'day' ? 'Day' : group === 'week' ? 'Week' : 'Month', ...METRICS.map(([, l]) => l)],
      ...rows.map((r) => r.map((v) => (v === null ? '' : v))),
      ['Total', ...tot],
    ];
    const pr = pipe && pipe.rows.find((r) => r.key === p.key);
    if (pr) { lines.push([], ['Where this person\'s candidates are now (added in the period)'], pipe.columns.slice(3).map((c) => c.label), pr.c.slice(3).map((v) => (v === null ? '' : v))); }
    const cr = cash && cash.rows.find((r) => r.key === p.key);
    if (cr) { lines.push([], ['Cash'], cash.columns.slice(2).map((c) => c.label), cr.c.slice(2)); }
    sheets.push({ name: p.c[0], lines, widths: [26, ...METRICS.map(() => 13)] });
    rowCount += rows.length;
  }
  const about = [
    ['TeamLink - individual packs'], [`Period: ${P.label} (${P.from} to ${P.to})`], [`Filters: ${summary.filterText}`], [`Your area: ${summary.scope}`],
    [`Generated by ${meta.by} on ${meta.at}`], [], [`One sheet for each of ${people.length} people, plus the team summary.`],
  ];
  await auditExport(user, {
    format: 'xlsx', what: 'Individual packs', id: 'people', filterText: `${P.label}, ${summary.filterText}`, rows: rowCount, sheets: sheets.length, scope: summary.scope, period: P,
  });
  return {
    name: `TeamLink-Individual-Packs-${P.from}_to_${P.to}.xlsx`,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: EX.toWorkbook(sheets, meta, about),
    rows: rowCount, sheets: sheets.length,
  };
}

// What the screen needs before the first report: the catalogue, the periods, what this login may do.
async function meta(user) {
  const access = await accessOf(user);
  if (!access.ok) throw new HttpError(403, access.error);
  return {
    reports: REPORTS.filter((r) => access.reports.includes(r.id)).map((r) => ({
      id: r.id, label: r.label, family: r.family, help: r.help, clientWise: !!r.clientWise,
      grouped: r.family === 'activity' ? (r.id !== 'summary') : r.id === 'cash',
    })),
    periods: PERIODS.map(([id, label]) => ({ id, label })),
    groups: GROUPS.map(([id, label]) => ({ id, label })),
    views: access.selfOnly || access.bde ? [['individual', 'Me']] : [['team', 'Team'], ['individual', 'Person']],
    selfOnly: access.selfOnly, bde: access.bde, cash: access.cash, canExport: access.canExport,
    canExportAll: access.canExport && !access.bde && access.view !== 'accounts',
    canExportPeople: access.canExport && !access.bde && !access.selfOnly && access.view !== 'accounts',
    role: access.view,
  };
}

module.exports = {
  HttpError, REPORTS, METRICS, PERIODS, GROUPS, accessOf, parseQuery, bucketsOf, screenReport, exportReport, exportAll, exportPeople, meta, runOf, buildTable, teamDirectory,
  forget: () => { TD_CACHE = null; },
  PIPE_SKIP,
};
