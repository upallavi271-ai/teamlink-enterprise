// ---------------------------------------------------------------------------
// REPORTS — section 17 of the ATS change list (2026-10-03).
//
// "Reports should answer: how fast do we fill jobs, where do good people come
// from, who is productive, how much money."
//
// This file adds to routes/atsReports.js (which hands in its own building
// blocks, so a number here is a Cell like every other report's number and
// opens its own list, exports the same way and is scoped the same way):
//
//   timetofill  Time to fill — days from the job being added to the person
//               joining, by department and by client: median + average,
//               fastest / slowest line.
//   quality     Source quality — per source: applied -> selected -> joined,
//               with conversion %, best / worst line.
//   targets     Results vs target — per recruiter: sent to client,
//               interviews, selected, joined in the period, each against the
//               HRMS Monthly Targets ("12 of 20").
//   revenue     Client revenue — invoiced, received, late. Super Admin /
//               Admin / Accounts ONLY, refused on the server for everyone
//               else (mayRevenue).
//   compare     ?compare=month | quarter on any report: this month (so far)
//               vs the same days of last month — every number gets the
//               previous value beside it.
//   facets      the report filters' options with counts, cascading
//               (Department -> Team -> TL -> Recruiter, Client …), zero
//               options left out — utils/atsFacets.js module 'reports'.
//   catalog     which report cards this login may open.
//
// ONE NUMBER, ONE MEANING — the definitions are the dashboard's
// (utils/atsHome.js / utils/roleDashboard.js):
//   Joined on    the joining date, else joinedAt (atsHome joinedSince);
//                the first recorded move into Joined only where neither
//                exists.
//   Sent to client  an application ENTERING the client chain in the period
//                (roleDashboard submissionIds).
//   Interviews   interview date in the period, not cancelled / no-show.
//   Money        Invoiced = invoices dated in the period, before GST, not
//                cancelled; Received = receipts dated in the period; Late =
//                outstanding on invoices past their due date, now
//                (atsHome moneyPanel).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const dateRange = require('./dateRange');
const A = require('./accounts');
const { scopeOf, invoiceWhere, scopeLabel } = require('./scope');
// "Received": one rule with the dashboard (payment rows, else a Paid invoice's own amount).
const MF = require('./moneyFacts');
// B2 — credit / debit notes (withNotes) for the Client revenue figures.
const TAXN = require('./invoiceTax');

const DAY = 86400000;
const MIN = 3; // fewer joins than this is not a fair fastest / slowest
const CLIENT_CHAIN = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const SELECTED_ON = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const JOINED = ['JOINED', 'HIRED'];
const DEAD_INTERVIEW = ['CANCELLED', 'NO_SHOW'];

const IST = 330 * 60000;
const istDay = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t + IST).toISOString().slice(0, 10);
};
// A typed date outside 2015–2100 ("2203-05-12" in an imported sheet) is not a date —
// the same limits as the Specialization report's days to fill.
const isoDay = (s) => { const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(s || '')); return m && +m[1] >= 2015 && +m[1] <= 2100 ? String(s).slice(0, 10) : null; };
const MAX_FILL_DAYS = 730; // over two years is a data slip, not a fill time
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const inP = (day, p) => !!day && day >= p.from && day <= p.to;
const median = (vals) => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const average = (vals) => (vals.length ? Math.round((vals.reduce((n, v) => n + v, 0) / vals.length) * 10) / 10 : null);
const n0 = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${n0(n)} ${n === 1 ? one : many}`;
const rupees = (v) => Math.round(Number(v) || 0);

// The day a joined application joined (see the header).
function joinDayOf(x) {
  if (!x.joined) return null;
  const d = isoDay(x.a.joiningDate) || istDay(x.a.joinedAt);
  if (d) return d;
  if (x.crossedAt && x.crossedAt.joined) return istDay(x.crossedAt.joined);
  const ev = [...(x.evs || [])].reverse().find((e) => JOINED.includes(e.toStage));
  return ev ? istDay(ev.createdAt) : null;
}

// --- Compare periods ----------------------------------------------------------
// This month so far vs the SAME DAYS of last month (1–3 Oct vs 1–3 Sep), so an
// early-month figure is not set against a whole month. Quarter the same way.
function compareKind(q) {
  const c = String((q && q.compare) || '');
  return c === 'month' || c === 'quarter' ? c : '';
}
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function shift(from, to, months) {
  const [fy, fm] = from.split('-').map(Number);
  const offset = dayDiff(from, to);
  const start = new Date(Date.UTC(fy, fm - 1 - months, 1));
  const sy = start.getUTCFullYear();
  const sm = start.getUTCMonth();
  // The previous span ends at most at the end of the previous whole period.
  const endOfPrev = new Date(Date.UTC(sy, sm + months, 0)).toISOString().slice(0, 10);
  const end = new Date(start.getTime() + offset * DAY).toISOString().slice(0, 10);
  return { from: start.toISOString().slice(0, 10), to: end < endOfPrev ? end : endOfPrev, lastDay: lastDayOfMonth(sy, sm) };
}
function compareRanges(kind) {
  const cur = dateRange.resolve({ range: kind === 'quarter' ? 'this_quarter' : 'this_month' });
  const prev = shift(cur.from, cur.to, kind === 'quarter' ? 3 : 1);
  return { cur, prev };
}
const fmtDay = (d) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return `${dt.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]}`;
};
const spanLabel = (from, to) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);

// --- Positions (seat code -> its team) -------------------------------------------
let POS = { at: 0, rows: null };
async function positions() {
  if (POS.rows && Date.now() - POS.at < 60000) return POS.rows;
  const rows = await prisma.position.findMany({ select: { code: true, department: true, team: true } });
  POS = { at: Date.now(), rows };
  return rows;
}
const teamKey = (p) => (p && p.team ? `${p.department || ''}|${p.team}` : null);

// The query a report is really built with: a compare replaces the date range
// with the current period; a Team becomes its seat codes (the report already
// filters by seat — utils/workers.js seatCodes).
async function expandQuery(q0) {
  const q = { ...(q0 || {}) };
  const kind = compareKind(q);
  if (kind) {
    if (q.comparePrev === '1') {
      const { prev } = compareRanges(kind);
      Object.assign(q, { range: 'custom', from: prev.from, to: prev.to });
    } else {
      Object.assign(q, { range: kind === 'quarter' ? 'this_quarter' : 'this_month', from: '', to: '' });
    }
  }
  const team = typeof q.team === 'string' ? q.team.trim() : '';
  if (team) {
    const codes = (await positions()).filter((p) => teamKey(p) === team).map((p) => p.code);
    const already = typeof q.positionCode === 'string' && q.positionCode ? q.positionCode.split(',').map((s) => s.trim()) : null;
    const set = already ? codes.filter((c) => already.includes(c)) : codes;
    q.positionCode = set.length ? set.join(',') : '__no_seat__';
  }
  delete q.team;
  return q;
}

// Every number of `cur` gets its value in `prev` beside it: tiles by key,
// table cells by row key + column.
function mergeCompare(cur, prev, kind, ranges) {
  const tileOf = new Map(prev.tiles.map((t) => [t.key, t.value]));
  cur.tiles.forEach((t) => { t.prev = tileOf.has(t.key) ? tileOf.get(t.key) : null; });
  cur.sections.forEach((s) => {
    const ps = prev.sections.find((x) => x.id === s.id);
    if (!ps) return;
    const rows = new Map(ps.rows.map((r) => [r.key, r.c]));
    const idx = s.columns.map((c) => ps.columns.findIndex((x) => x.key === c.key));
    const pick = (arr) => idx.map((j, i) => (j >= 0 && ['num', 'pct', 'money'].includes(s.columns[i].type) && arr ? arr[j] ?? null : null));
    s.rows.forEach((r) => { r.p = pick(rows.get(r.key) || null); if (!rows.has(r.key)) r.p = idx.map((j, i) => (['num', 'money'].includes(s.columns[i].type) && s.columns[i].drill ? 0 : null)); });
    if (s.total && ps.total) s.pt = pick(ps.total);
  });
  cur.compare = {
    kind,
    label: kind === 'quarter' ? 'This quarter vs last quarter' : 'This month vs last month',
    cur: { from: ranges.cur.from, to: ranges.cur.to, label: spanLabel(ranges.cur.from, ranges.cur.to) },
    prev: { from: ranges.prev.from, to: ranges.prev.to, label: spanLabel(ranges.prev.from, ranges.prev.to) },
  };
  return cur;
}

// --- Who may see money ------------------------------------------------------------
function mayRevenue(user) {
  const s = scopeOf(user);
  return !!(s.adminGlobal || s.accountsRole === 'ACCOUNTANT');
}

module.exports = function reportsPlus(H) {
  const {
    Cell, section, addTotal, tileSet, pct, channelOf, CHANNELS,
  } = H;

  // =========================================================================
  // TIME TO FILL
  // =========================================================================
  function buildTimeToFill(ctx) {
    const P = ctx.f.period;
    const t = tileSet();
    const measured = t.add('filled', 'People joined', 'app', P ? 'joined in this period, with dates' : 'with a joining date');
    const undated = new Cell('app');
    const odd = new Cell('app');
    const cols = (first) => [
      first,
      { key: 'joined', label: 'People joined', drill: 'app' },
      { key: 'median', label: 'Usual days (median)', type: 'num' },
      { key: 'avg', label: 'Average days', type: 'num' },
      { key: 'fastest', label: 'Fastest', type: 'num' },
      { key: 'slowest', label: 'Slowest', type: 'num' },
    ];
    const derive = (c) => {
      const v = c.joined.vals ? [...c.joined.vals.values()] : [];
      Object.assign(c, { median: median(v), avg: average(v), fastest: v.length ? Math.min(...v) : null, slowest: v.length ? Math.max(...v) : null });
    };
    const sub = 'Days from job added to person joined. "Usual days" is the middle value.';
    const byDept = section('ttfDept', 'By department', cols({ key: 'department', label: 'Department' }), { sub });
    const byClient = section('ttfClient', 'By client', cols({ key: 'client', label: 'Client', ref: 'client' }), { sub, paged: true });
    // ATS layout v3 §5 — time to hire month by month (the line chart), the
    // same people and days as the tables above, by the month they joined.
    const byMonth = section('ttfMonth', 'By month joined', cols({ key: 'month', label: 'Month' }), { sub });
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    ctx.apps.forEach((x) => {
      if (!x.joined) return;
      const jd = joinDayOf(x);
      if (!jd) { if (!P) undated.add(x.id); return; }
      if (P && !inP(jd, P)) return;
      const d = dayDiff(istDay(x.req.createdAt), jd);
      if (d < 0 || d > MAX_FILL_DAYS) { odd.add(x.id); return; }
      measured.add(x.id, d);
      const dept = x.req.department || '—';
      const dc = byDept.row(dept).cells;
      dc.department = dept;
      dc.joined.add(x.id, d);
      const cr = byClient.row(x.req.clientKey || '—', { refs: x.req.internal ? {} : { client: x.req.clientId } });
      cr.cells.client = x.req.clientName;
      cr.cells.joined.add(x.id, d);
      const mk = String(jd).slice(0, 7);
      const mr = byMonth.row(mk).cells;
      mr.month = `${MONTHS[Number(mk.slice(5, 7)) - 1] || mk.slice(5, 7)} ${mk.slice(0, 4)}`;
      mr.joined.add(x.id, d);
    });
    [byDept, byClient].forEach((s) => {
      s.rows.forEach((r) => derive(r.cells));
      s.sort = (a, b) => b.cells.joined.n - a.cells.joined.n;
      addTotal(s, derive);
    });
    byMonth.rows.forEach((r) => derive(r.cells));
    byMonth.sort = (a, b) => String(a.key).localeCompare(String(b.key));
    addTotal(byMonth, derive);
    const all = [...(measured.vals ? measured.vals.values() : [])];
    t.value('median', 'Usual days to fill', median(all), 'median — half were faster');
    t.value('avg', 'Average days to fill', average(all));
    if (undated.n) t.push('undated', 'Joined, no joining date', undated, 'not measured — add the joining date');
    if (odd.n) t.push('odd', 'Dates do not add up', odd, 'not measured — check the joining date');

    const notes = [];
    const fair = (s) => [...s.rows.values()].filter((r) => r.cells.joined.n >= MIN && r.cells.median !== null && r.key !== '—');
    const line = (s, noun) => {
      const rows = fair(s).sort((a, b) => a.cells.median - b.cells.median);
      if (rows.length < 2) return;
      const f = rows[0];
      const w = rows[rows.length - 1];
      const name = (r) => r.cells[s.columns[0].key];
      notes.push(`Fastest ${noun}: ${name(f)} — usually ${f.cells.median} days. Slowest: ${name(w)} — usually ${w.cells.median} days.`);
    };
    line(byDept, 'department');
    line(byClient, 'client');
    if (!all.length) notes.push(P ? 'Nobody with a joining date joined in this period.' : 'No joined person has a joining date yet.');
    return { tiles: t.tiles, sections: [byDept, byClient, byMonth], notes, plain: true };
  }

  // =========================================================================
  // SOURCE QUALITY
  // =========================================================================
  const QCOLS = [
    { key: 'applied', label: 'Applied', drill: 'app' },
    { key: 'selected', label: 'Selected (incl. joined later)', drill: 'app' },
    { key: 'joined', label: 'Joined', drill: 'app' },
    { key: 'toSel', label: 'Applied → Selected', type: 'pct' },
    { key: 'toJoin', label: 'Applied → Joined', type: 'pct' },
    { key: 'selJoin', label: 'Selected → Joined', type: 'pct' },
  ];
  const qDerive = (c) => {
    c.toSel = pct(c.selected.n, c.applied.n);
    c.toJoin = pct(c.joined.n, c.applied.n);
    c.selJoin = pct(c.joined.n, c.selected.n);
  };
  function buildSourceQuality(ctx) {
    const sub = 'Selected includes people who joined later. Judge a source by joins, not by how many it sends.';
    // The source written on each application (else on the candidate) leads:
    // most rows here came from named sheets and desks, which the fixed channel
    // list cannot tell apart. The channel grouping follows below it.
    const files = section('quality', 'Which source gives people who join', [{ key: 'source', label: 'Source' }, ...QCOLS], { sub, paged: true });
    const ch = section('qualityGroup', 'By source group', [{ key: 'channel', label: 'Group' }, ...QCOLS], { sub: 'Naukri, Indeed, Shine, LinkedIn, Referral, Recruiter, BDE, Job Portal — everything else is Other.' });
    const count = (c, x) => {
      c.applied.add(x.id);
      if (x.joined || x.reached('selected')) c.selected.add(x.id);
      if (x.joined) c.joined.add(x.id);
    };
    const labelOf = new Map();
    ctx.apps.forEach((x) => {
      const group = channelOf(x.source);
      const r = ch.row(group);
      r.cells.channel = group === 'Other' ? 'Other sources' : group;
      count(r.cells, x);
      const k = x.source.toLowerCase();
      if (!labelOf.has(k)) labelOf.set(k, x.source);
      const fr = files.row(k);
      fr.cells.source = labelOf.get(k);
      count(fr.cells, x);
    });
    [files, ch].forEach((s) => {
      s.rows.forEach((r) => qDerive(r.cells));
      s.sort = (a, b) => b.cells.joined.n - a.cells.joined.n || b.cells.applied.n - a.cells.applied.n;
      addTotal(s, qDerive);
    });
    const tot = files.total.cells;
    const t = tileSet();
    t.push('applied', 'Applied', tot.applied);
    t.push('selected', 'Selected (incl. joined later)', tot.selected);
    t.push('joined', 'Joined', tot.joined);
    t.value('toJoin', 'Applied → Joined', tot.toJoin, 'of every 100 who apply', 'pct');

    const notes = [];
    const FAIR = 20; // a source with fewer applications is too small to judge
    const fair = [...files.rows.values()].filter((r) => r.cells.applied.n >= FAIR && r.key !== 'not recorded');
    const best = [...fair].sort((a, b) => (b.cells.toJoin || 0) - (a.cells.toJoin || 0))[0];
    if (best && best.cells.joined.n) {
      t.value('best', 'Best source', best.cells.source, `${best.cells.toJoin}% of its people joined`, 'text');
      notes.push(`Best source: ${best.cells.source} — ${best.cells.toJoin}% of its people joined (${n0(best.cells.joined.n)} of ${n0(best.cells.applied.n)}).`);
      const many = [...fair].sort((a, b) => b.cells.applied.n - a.cells.applied.n)[0];
      if (many && many !== best && (many.cells.toJoin || 0) < (best.cells.toJoin || 0) / 2) {
        notes.push(`${many.cells.source} sends the most people (${n0(many.cells.applied.n)}), but only ${many.cells.toJoin || 0}% join.`);
      }
    }
    return { tiles: t.tiles, sections: [files, ch], notes, plain: true };
  }

  // =========================================================================
  // RESULTS VS TARGET (Monthly Targets, EmployeeRecord type TARGET)
  // =========================================================================
  const TARGET_RULES = [
    { key: 'joined', re: /join|placement|hire|closure/i },
    { key: 'selected', re: /select/i },
    { key: 'interviews', re: /interview/i },
    { key: 'submitted', re: /submi|sent to client|shar|cv|profile/i },
  ];
  const periodOf = (ctx) => ctx.f.period || dateRange.resolve({ range: 'this_month' });
  const monthsOf = (p) => {
    const out = [];
    let [y, m] = p.from.slice(0, 7).split('-').map(Number);
    const end = p.to.slice(0, 7);
    for (let i = 0; i < 40; i += 1) {
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      out.push(mk);
      if (mk >= end) break;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  };
  async function prepareTargets(ctx) {
    const P = periodOf(ctx);
    const key = `${P.from}|${P.to}`;
    ctx.targetPrep = ctx.targetPrep || {};
    if (ctx.targetPrep[key]) return;
    const ids = new Set();
    ctx.apps.forEach((x) => { if (x.recruiter && x.recruiter.key.startsWith('u:')) ids.add(x.recruiter.key.slice(2)); });
    ctx.reqs.forEach((r) => { if (r.recruiter && r.recruiter.key.startsWith('u:')) ids.add(r.recruiter.key.slice(2)); });
    const emps = ids.size ? await prisma.employee.findMany({ where: { userId: { in: [...ids] } }, select: { id: true, userId: true } }) : [];
    const userOf = new Map(emps.map((e) => [e.id, e.userId]));
    const months = monthsOf(P);
    const rows = emps.length ? await prisma.employeeRecord.findMany({
      where: { type: 'TARGET', employeeId: { in: emps.map((e) => e.id) }, OR: months.map((mk) => ({ date: { startsWith: mk } })) },
      select: { employeeId: true, title: true, unit: true, amount: true },
    }) : [];
    const out = new Map();
    rows.forEach((r) => {
      const rule = TARGET_RULES.find((x) => x.re.test(`${r.unit || ''} ${r.title || ''}`));
      if (!rule || !(Number(r.amount) > 0)) return;
      const k = `u:${userOf.get(r.employeeId)}`;
      if (!out.has(k)) out.set(k, {});
      out.get(k)[rule.key] = (out.get(k)[rule.key] || 0) + Number(r.amount);
    });
    ctx.targetPrep[key] = { targets: out, months };
  }
  const METRICS = [
    ['submitted', 'Sent to client'],
    ['interviews', 'Interviews'],
    ['selected', 'Selected'],
    ['joined', 'Joined'],
  ];
  function buildTargets(ctx) {
    const P = periodOf(ctx);
    const prep = (ctx.targetPrep || {})[`${P.from}|${P.to}`] || { targets: new Map(), months: [] };
    const from = new Date(`${P.from}T00:00:00+05:30`).getTime();
    const to = new Date(`${P.to}T00:00:00+05:30`).getTime() + DAY;
    const within = (d) => { const t2 = d ? new Date(d).getTime() : NaN; return t2 >= from && t2 < to; };
    const columns = [{ key: 'recruiter', label: 'Recruiter' }];
    METRICS.forEach(([k, l]) => {
      columns.push({ key: k, label: l, drill: 'app', of: `t_${k}` });
      columns.push({ key: `t_${k}`, label: `${l} target`, type: 'num', hidden: true });
    });
    columns.push({ key: 'tl', label: 'TL' });
    const sec = section('targets', 'Each recruiter against their target', columns, {
      sub: `Work done ${spanLabel(P.from, P.to)}, against each person's Monthly Target. Sent to client = entered the client steps then.`,
    });
    ctx.apps.forEach((x) => {
      if (!x.recruiter || x.recruiter.key === '—') return;
      const hits = {
        submitted: (x.evs || []).some((e) => CLIENT_CHAIN.includes(e.toStage) && (!e.fromStage || !CLIENT_CHAIN.includes(e.fromStage)) && within(e.createdAt)),
        interviews: !!x.a.interviewAt && within(x.a.interviewAt) && !DEAD_INTERVIEW.includes(x.a.interviewStatus),
        selected: (x.evs || []).some((e) => SELECTED_ON.includes(e.toStage) && (!e.fromStage || !SELECTED_ON.includes(e.fromStage)) && within(e.createdAt)),
        joined: inP(joinDayOf(x), P),
      };
      if (!Object.values(hits).some(Boolean)) return;
      const r = sec.row(x.recruiter.key);
      r.cells.recruiter = x.recruiter.label;
      if (x.tl && x.tl.label) r.cells.tl = r.cells.tl && r.cells.tl !== x.tl.label && !String(r.cells.tl).includes(x.tl.label) ? `${r.cells.tl}, ${x.tl.label}` : x.tl.label;
      METRICS.forEach(([k]) => { if (hits[k]) r.cells[k].add(x.id); });
    });
    // Everyone with a target is listed, even with nothing done yet.
    prep.targets.forEach((tg, k) => {
      const r = sec.row(k);
      if (!r.cells.recruiter) {
        const u = ctx.userById.get(k.slice(2));
        r.cells.recruiter = u ? u.name : k.slice(2);
      }
    });
    sec.rows.forEach((r) => {
      const tg = prep.targets.get(r.key) || {};
      METRICS.forEach(([k]) => { r.cells[`t_${k}`] = tg[k] || null; });
      if (!r.cells.tl) r.cells.tl = '—';
    });
    sec.sort = (a, b) => b.cells.joined.n - a.cells.joined.n || b.cells.submitted.n - a.cells.submitted.n;
    // The total row has no "of" bar: a target belongs to a person, and the
    // total also counts people with no target. The tiles compare like with
    // like — what the people WITH a target did, against their targets.
    addTotal(sec, (c) => {
      METRICS.forEach(([k]) => { c[`t_${k}`] = null; });
      c.tl = null;
    });
    const t = tileSet();
    const tot = sec.total.cells;
    METRICS.forEach(([k, l]) => {
      let tg = 0; let done = 0;
      sec.rows.forEach((r) => { if (r.cells[`t_${k}`]) { tg += r.cells[`t_${k}`]; done += r.cells[k].n; } });
      t.push(k, l, tot[k], tg ? `with a target: ${n0(done)} of ${n0(tg)} (${pct(done, tg)}%)` : 'no target set');
      t.tiles[t.tiles.length - 1].target = tg || null;
    });
    const notes = [];
    if (!prep.targets.size) notes.push('No Monthly Targets are set for this period. Set them in HRMS → Performance → Monthly Targets (goal "Submissions", "Interviews", "Selections" or "Joinings").');
    else {
      const ahead = [...sec.rows.values()].filter((r) => r.cells.t_joined && r.cells.joined.n >= r.cells.t_joined).map((r) => r.cells.recruiter);
      if (ahead.length) notes.push(`Reached the joining target: ${ahead.slice(0, 5).join(', ')}${ahead.length > 5 ? ` and ${ahead.length - 5} more` : ''}.`);
    }
    return {
      tiles: t.tiles, sections: [sec], notes, plain: true,
      // No date range = this month: the payload says so, not "All time".
      period: { key: P.key, label: ctx.f.period ? P.label : 'This month', from: P.from, to: P.to },
    };
  }

  // =========================================================================
  // CLIENT REVENUE — own load (invoices), own drill and export routes.
  // =========================================================================
  async function revenueBuild(user, q) {
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const range = s(q.range) || 'all';
    const P = range === 'all' ? null : dateRange.resolve({ range, from: s(q.from), to: s(q.to) });
    const and = [invoiceWhere(user)];
    if (s(q.clientId)) and.push({ clientId: s(q.clientId) });
    if (s(q.department)) and.push({ client: { is: { ownerDepartment: s(q.department) } } });
    const where = { AND: and };
    const invs = await prisma.invoice.findMany({
      where,
      select: {
        ...MF.INVOICE_SELECT,
        invoiceNumber: true, amount: true, gst: true, tds: true, dueDate: true, clientId: true,
        ...(TAXN.hasCol('creditedAmount') ? { creditedAmount: true, debitedAmount: true } : {}),
        client: { select: { name: true, ownerDepartment: true } },
        candidate: { select: { name: true } },
        payments: { select: { id: true, date: true, amount: true, method: true, reference: true } },
      },
    });
    // B2 — "Invoiced" is the fee before GST AFTER issued credit / debit notes
    // (utils/invoiceTax.js withNotes); an invoice without a note is unchanged.
    const notesOf = await require('./creditNotes').notesByInvoice(invs.map((i) => i.id), { issuedOnly: true }); // eslint-disable-line global-require
    invs.forEach((i) => { const wn = TAXN.withNotes(i, notesOf.get(i.id) || []); i.netAmount = wn.hasNotes ? wn.billing : Number(i.amount || 0); });
    const invById = new Map(invs.map((i) => [i.id, i]));
    // Received in the period: every receipt (utils/moneyFacts.js) dated in it.
    const payInfo = new Map();
    invs.forEach((i) => (i.payments || []).forEach((p) => payInfo.set(p.id, p)));
    const pays = invs.flatMap((i) => MF.receiptsOf(i)).filter((x) => !P || inP(x.date, P))
      .map((x) => ({ ...x, method: (payInfo.get(x.id) || {}).method, reference: (payInfo.get(x.id) || {}).reference }));
    const paidNoReceipt = new Set(pays.filter((x) => x.from === 'invoice').map((x) => x.invoiceId)).size;
    const live = invs.filter((i) => A.deriveInvoiceStatus(i) !== 'Cancelled');
    const inRange = live.filter((i) => !P || inP(String(i.invoiceDate || '').slice(0, 10), P));
    const late = live.filter((i) => A.invoiceOutstanding(i) > 0.5 && i.dueDate && A.daysOverdue(i.dueDate) > 0);

    // A money figure opens the invoices (or receipts) it adds up.
    const cells = new Map();
    const cell = (key, kind) => { const c = new Cell(kind); cells.set(key, c); return c; };
    const tiles = [];
    const tile = (key, label, value, c, sub, type = 'money') => tiles.push({ key, label, value, cell: c, sub, type });
    const tInv = cell('t:invoiced', 'inv');
    const tRec = cell('t:received', 'pay');
    const tLate = cell('t:late', 'inv');
    const tOut = cell('t:outstanding', 'inv');
    inRange.forEach((i) => tInv.add(i.id));
    pays.forEach((p) => tRec.add(p.id));
    late.forEach((i) => tLate.add(i.id, A.daysOverdue(i.dueDate)));
    live.filter((i) => A.invoiceOutstanding(i) > 0.5).forEach((i) => tOut.add(i.id));
    const sumAmt = (list) => rupees(list.reduce((n, i) => n + Number(i.netAmount || 0), 0));
    tile('invoiced', 'Invoiced', sumAmt(inRange), tInv, inRange.length ? `${plural(inRange.length, 'invoice', 'invoices')} · before GST` : 'no invoices in this period');
    tile('received', 'Received', rupees(pays.reduce((n, p) => n + Number(p.amount || 0), 0)), tRec, pays.length ? plural(pays.length, 'payment', 'payments') : 'no payments in this period');
    tile('outstanding', 'Still to come', rupees(live.reduce((n, i) => n + Math.max(0, A.invoiceOutstanding(i)), 0)), tOut, 'all open invoices, now');
    tile('late', 'Late', rupees(late.reduce((n, i) => n + A.invoiceOutstanding(i), 0)), tLate, late.length ? `${plural(late.length, 'invoice', 'invoices')} past due date, now` : 'nothing past due today');

    const columns = [
      { key: 'client', label: 'Client', type: 'text', ref: 'client' },
      { key: 'invoices', label: 'Invoices', type: 'num', drill: true },
      { key: 'invoiced', label: 'Invoiced ₹', type: 'money', drill: true },
      { key: 'received', label: 'Received ₹', type: 'money', drill: true },
      { key: 'outstanding', label: 'Still to come ₹', type: 'money', drill: true, now: true },
      { key: 'lateCount', label: 'Late invoices', type: 'num', drill: true, now: true },
      { key: 'late', label: 'Late ₹', type: 'money', drill: true, now: true },
      { key: 'oldest', label: 'Most days late', type: 'num', now: true },
    ];
    const rows = new Map();
    const rowOf = (cid, name) => {
      if (!rows.has(cid)) {
        rows.set(cid, {
          key: cid, refs: { client: cid },
          v: { client: name || '—', invoices: 0, invoiced: 0, received: 0, outstanding: 0, lateCount: 0, late: 0, oldest: null },
          cells: { invoices: cell(`${cid}:inv`, 'inv'), received: cell(`${cid}:rec`, 'pay'), outstanding: cell(`${cid}:out`, 'inv'), late: cell(`${cid}:late`, 'inv') },
        });
      }
      return rows.get(cid);
    };
    inRange.forEach((i) => {
      const r = rowOf(i.clientId, i.client && i.client.name);
      r.v.invoices += 1; r.v.invoiced += Number(i.netAmount || 0); r.cells.invoices.add(i.id);
    });
    pays.forEach((p) => {
      const i = invById.get(p.invoiceId);
      if (!i) return;
      const r = rowOf(i.clientId, i.client && i.client.name);
      r.v.received += Number(p.amount || 0); r.cells.received.add(p.id);
    });
    live.forEach((i) => {
      const o = A.invoiceOutstanding(i);
      if (o <= 0.5) return;
      const r = rowOf(i.clientId, i.client && i.client.name);
      r.v.outstanding += o; r.cells.outstanding.add(i.id);
    });
    late.forEach((i) => {
      const r = rowOf(i.clientId, i.client && i.client.name);
      const d = A.daysOverdue(i.dueDate);
      r.v.lateCount += 1; r.v.late += A.invoiceOutstanding(i); r.cells.late.add(i.id, d);
      r.v.oldest = Math.max(r.v.oldest || 0, d);
    });
    const list = [...rows.values()].sort((a, b) => b.v.invoiced - a.v.invoiced || b.v.late - a.v.late);
    const cellFor = (r, col) => ({ invoices: r.cells.invoices, invoiced: r.cells.invoices, received: r.cells.received, outstanding: r.cells.outstanding, lateCount: r.cells.late, late: r.cells.late })[col];
    const total = { client: 'Total', invoices: 0, invoiced: 0, received: 0, outstanding: 0, lateCount: 0, late: 0, oldest: null };
    list.forEach((r) => {
      ['invoiced', 'received', 'outstanding', 'late'].forEach((k) => { r.v[k] = rupees(r.v[k]); total[k] += r.v[k]; });
      total.invoices += r.v.invoices; total.lateCount += r.v.lateCount;
      if (r.v.oldest !== null) total.oldest = Math.max(total.oldest || 0, r.v.oldest);
    });
    const totalCells = { invoices: tInv, invoiced: tInv, received: tRec, outstanding: tOut, lateCount: tLate, late: tLate };
    // ATS layout v3 §5 — money month by month (the line chart): the SAME
    // invoices and receipts as the tiles, Invoiced by the invoice date and
    // Received by the payment date. A row without a date is kept ('No date')
    // so the months always add up to the tiles.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthRows = new Map();
    const monthOf = (v) => {
      const mk = /^\d{4}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 7) : '—';
      if (!monthRows.has(mk)) {
        monthRows.set(mk, {
          key: mk,
          v: { month: mk === '—' ? 'No date' : `${MONTHS[Number(mk.slice(5, 7)) - 1] || mk.slice(5, 7)} ${mk.slice(0, 4)}`, invoices: 0, invoiced: 0, received: 0 },
          cells: { invoices: cell(`m:${mk}:inv`, 'inv'), received: cell(`m:${mk}:rec`, 'pay') },
        });
      }
      return monthRows.get(mk);
    };
    inRange.forEach((i) => { const r = monthOf(i.invoiceDate); r.v.invoices += 1; r.v.invoiced += Number(i.netAmount || 0); r.cells.invoices.add(i.id); });
    pays.forEach((p) => { const r = monthOf(p.date); r.v.received += Number(p.amount || 0); r.cells.received.add(p.id); });
    const months = [...monthRows.values()].sort((a, b) => (a.key === '—') - (b.key === '—') || a.key.localeCompare(b.key));
    const monthTotal = { month: 'Total', invoices: 0, invoiced: 0, received: 0 };
    months.forEach((r) => { r.v.invoiced = rupees(r.v.invoiced); r.v.received = rupees(r.v.received); monthTotal.invoices += r.v.invoices; monthTotal.invoiced += r.v.invoiced; monthTotal.received += r.v.received; });
    const monthColumns = [
      { key: 'month', label: 'Month', type: 'text' },
      { key: 'invoices', label: 'Invoices', type: 'num', drill: true },
      { key: 'invoiced', label: 'Invoiced ₹', type: 'money', drill: true },
      { key: 'received', label: 'Received ₹', type: 'money', drill: true },
    ];
    const monthCellFor = (r, col) => ({ invoices: r.cells.invoices, invoiced: r.cells.invoices, received: r.cells.received })[col];
    const notes = [];
    const worst = [...list].filter((r) => r.v.late > 0).sort((a, b) => b.v.late - a.v.late)[0];
    if (worst) notes.push(`Most money late: ${worst.v.client} — ₹${n0(worst.v.late)} on ${plural(worst.v.lateCount, 'invoice', 'invoices')}, oldest ${worst.v.oldest} days late.`);
    if (!invs.length) notes.push('No invoices in your area for these filters.');
    if (paidNoReceipt) notes.push(`Received includes ${plural(paidNoReceipt, 'invoice', 'invoices')} marked paid without a payment entry.`);
    return {
      P, tiles, cells, list, columns, total, totalCells, cellFor, invById, pays, notes,
      months, monthColumns, monthTotal, monthCellFor,
      options: { invs },
    };
  }
  function revenuePayload(user, b) {
    return {
      report: 'revenue',
      title: 'Client revenue',
      scope: scopeLabel(user, 'accounts'),
      period: b.P ? { key: b.P.key, label: b.P.label, from: b.P.from, to: b.P.to } : { key: 'all', label: 'All time' },
      dateBasis: 'Date range: Invoiced by the invoice date, Received by the payment date. Still to come and Late are as of today.',
      tiles: b.tiles.map((t) => ({ key: t.key, label: t.label, sub: t.sub, type: t.type, value: t.value, drill: !!(t.cell && t.cell.n), now: ['outstanding', 'late'].includes(t.key) })),
      sections: [{
        id: 'revenue', title: 'Money per client', sub: 'Invoiced is before GST. Click any amount for the invoices behind it.', paged: true,
        groupBy: null, groupings: null,
        columns: b.columns.map((c) => ({ ...c, drill: !!c.drill, ref: c.ref || null })),
        rows: b.list.map((r) => ({ key: r.key, refs: r.refs, c: b.columns.map((c) => r.v[c.key]) })),
        total: b.columns.map((c) => b.total[c.key]),
      }, {
        id: 'revenueMonths', title: 'Money per month', sub: 'Invoiced by the invoice date (before GST), Received by the payment date. Click any amount for the invoices behind it.', paged: false,
        groupBy: null, groupings: null,
        columns: b.monthColumns.map((c) => ({ ...c, drill: !!c.drill, ref: null })),
        rows: b.months.map((r) => ({ key: r.key, refs: {}, c: b.monthColumns.map((c) => r.v[c.key]) })),
        total: b.monthColumns.map((c) => b.monthTotal[c.key]),
      }],
      notes: b.notes,
      counts: { applications: b.options.invs.length, requirements: b.options.invs.length },
      plain: true,
    };
  }
  async function revenueDrill(b, q) {
    const sec = String(q.section || '');
    const col = String(q.col || '');
    let c = null;
    let title = '';
    if (sec === 'tiles') {
      const t = b.tiles.find((x) => x.key === col);
      if (t) { c = t.cell; title = t.label; }
    } else if (sec === 'revenue') {
      const row = String(q.row || '');
      if (row === '__total__') { c = b.totalCells[col]; title = `Total · ${(b.columns.find((x) => x.key === col) || {}).label || ''}`; } else {
        const r = b.list.find((x) => x.key === row);
        if (r) { c = b.cellFor(r, col); title = `${r.v.client} · ${(b.columns.find((x) => x.key === col) || {}).label || ''}`; }
      }
    } else if (sec === 'revenueMonths') {
      const row = String(q.row || '');
      const label = (b.monthColumns.find((x) => x.key === col) || {}).label || '';
      if (row === '__total__') { c = b.totalCells[col]; title = `Total · ${label}`; } else {
        const r = b.months.find((x) => x.key === row);
        if (r) { c = b.monthCellFor(r, col); title = `${r.v.month} · ${label}`; }
      }
    }
    if (!c) return null;
    if (c.kind === 'pay') {
      const pays = b.pays.filter((p) => c.ids.has(p.id)).sort((x, y) => String(y.date).localeCompare(String(x.date)));
      return {
        title, kind: 'pay', total: pays.length,
        columns: [{ key: 'date', label: 'Paid on' }, { key: 'number', label: 'Invoice', ref: 'inv' }, { key: 'client', label: 'Client' }, { key: 'amount', label: 'Amount ₹', type: 'num' }, { key: 'method', label: 'How' }, { key: 'reference', label: 'Reference' }, { key: 'note', label: 'Note' }],
        rows: pays.map((p) => {
          const i = b.invById.get(p.invoiceId) || {};
          return { refs: { inv: p.invoiceId }, cells: { date: p.date, number: i.invoiceNumber || '—', client: (i.client && i.client.name) || '—', amount: rupees(p.amount), method: p.method || '—', reference: p.reference || '—', note: p.from === 'invoice' ? 'Marked paid on the invoice' : '' } };
        }),
      };
    }
    const invs = [...c.ids].map((id) => b.invById.get(id)).filter(Boolean)
      .sort((x, y) => (A.daysOverdue(y.dueDate) || -1e9) - (A.daysOverdue(x.dueDate) || -1e9) || String(y.invoiceDate).localeCompare(String(x.invoiceDate)));
    return {
      title, kind: 'inv', total: invs.length,
      columns: [{ key: 'number', label: 'Invoice', ref: 'inv' }, { key: 'client', label: 'Client' }, { key: 'candidate', label: 'For' }, { key: 'date', label: 'Invoice date' }, { key: 'due', label: 'Due' }, { key: 'amount', label: 'Amount ₹ (before GST)', type: 'num' }, { key: 'outstanding', label: 'Still to come ₹', type: 'num' }, { key: 'status', label: 'Status' }, { key: 'late', label: 'Days late', type: 'num' }],
      rows: invs.map((i) => {
        const d = A.daysOverdue(i.dueDate);
        const status = A.deriveInvoiceStatus(i);
        return {
          refs: { inv: i.id },
          cells: {
            number: i.invoiceNumber || '—', client: (i.client && i.client.name) || '—', candidate: (i.candidate && i.candidate.name) || '—',
            date: i.invoiceDate || '—', due: i.dueDate || '—', amount: rupees(i.netAmount != null ? i.netAmount : i.amount), outstanding: rupees(Math.max(0, A.invoiceOutstanding(i))),
            status: status === 'Overdue' ? 'Late' : status, late: d > 0 && A.invoiceOutstanding(i) > 0.5 ? d : null,
          },
        };
      }),
    };
  }
  function revenueFacets(b, q) {
    const pickWithout = (key) => b.options.invs.filter((i) => {
      if (key !== 'clientId' && q.clientId && i.clientId !== q.clientId) return false;
      if (key !== 'department' && q.department && (i.client && i.client.ownerDepartment) !== q.department) return false;
      return true;
    });
    const count = (list, get, label) => {
      const m = new Map();
      list.forEach((i) => { const v = get(i); if (!v) return; const e = m.get(v) || { value: v, label: label(i), count: 0 }; e.count += 1; m.set(v, e); });
      return [...m.values()].sort((a, b2) => b2.count - a.count || a.label.localeCompare(b2.label));
    };
    return {
      department: count(pickWithout('department'), (i) => i.client && i.client.ownerDepartment, (i) => i.client.ownerDepartment),
      clientId: count(pickWithout('clientId'), (i) => i.clientId, (i) => (i.client && i.client.name) || '—'),
    };
  }

  // =========================================================================
  // FACETS — the report filters, counted over the report's own rows.
  // =========================================================================
  const FACET_KEYS = ['department', 'team', 'tl', 'recruiter', 'clientId', 'requirementId', 'bde', 'stl', 'source', 'location'];
  function facetCounts(ctx, q, pos) {
    const seatTeam = new Map(pos.map((p) => [p.code, p]));
    const val = {
      department: (x) => x.req.department || null,
      team: (x) => teamKey(seatTeam.get(x.seat)),
      tl: (x) => (x.tl ? x.tl.key : null),
      recruiter: (x) => (x.recruiter && x.recruiter.key !== '—' ? x.recruiter.key : null),
      clientId: (x) => x.req.clientKey || null,
      requirementId: (x) => x.req.id,
      bde: (x) => (x.bde ? x.bde.key : null),
      stl: (x) => (x.stl ? x.stl.key : null),
      source: (x) => x.source.toLowerCase(),
      location: (x) => (x.req.location && String(x.req.location).trim()) || null,
    };
    const label = {
      department: (x) => x.req.department,
      team: (x) => { const p = seatTeam.get(x.seat); return `${p.team}${p.department ? ` (${p.department})` : ''}`; },
      tl: (x) => x.tl.label,
      recruiter: (x) => x.recruiter.label,
      clientId: (x) => x.req.clientName,
      requirementId: (x) => `${x.req.reqCode ? `${x.req.reqCode} · ` : ''}${x.req.title}`,
      bde: (x) => x.bde.label,
      stl: (x) => x.stl.label,
      source: (x) => x.source,
      location: (x) => String(x.req.location).trim(),
    };
    // The chosen values, in the same shape val() returns.
    const want = {};
    FACET_KEYS.forEach((k) => {
      let v = typeof q[k] === 'string' ? q[k].trim() : '';
      if (!v) return;
      if (['tl', 'recruiter', 'bde', 'stl'].includes(k)) v = v.replace(/^id:/, 'u:').replace(/^name:/, 'n:');
      if (k === 'source') v = v.toLowerCase();
      want[k] = v;
    });
    const matchName = (k, x, v) => {
      const got = val[k](x);
      if (got === v) return true;
      // a "n:<name>" choice matches the login of that name and vice versa
      if (['tl', 'recruiter', 'bde', 'stl'].includes(k) && got && v.startsWith('n:')) {
        const p = k === 'recruiter' ? x.recruiter : x[k];
        return !!p && String(p.label || '').toLowerCase() === v.slice(2);
      }
      return false;
    };
    const facets = {};
    FACET_KEYS.forEach((k) => {
      const others = Object.keys(want).filter((o) => o !== k);
      const m = new Map();
      ctx.apps.forEach((x) => {
        if (!others.every((o) => matchName(o, x, want[o]))) return;
        const v = val[k](x);
        if (!v) return;
        const e = m.get(v) || { value: v, label: label[k](x) || v, count: 0 };
        e.count += 1;
        m.set(v, e);
      });
      const list = [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
      if (want[k] && !list.some((o) => o.value === want[k])) list.unshift({ value: q[k], label: q[k].replace(/^(u|n|id|name):/, ''), count: 0 });
      facets[k] = list;
    });
    const total = ctx.apps.filter((x) => Object.keys(want).every((o) => matchName(o, x, want[o]))).length;
    return { facets, total };
  }

  return {
    buildTimeToFill, buildSourceQuality, buildTargets, prepareTargets,
    revenueBuild, revenuePayload, revenueDrill, revenueFacets, facetCounts, FACET_KEYS,
  };
};

// EVERYDAY WORDS (spec section 2) on report labels, titles and notes — the
// older report builders still say Requirement / Stage / Pipeline / Overdue.
const WORDS = [
  [/\bIn pipeline\b/g, 'People in process'], [/\bin pipeline\b/g, 'in process'],
  [/\bReq ID\b/g, 'Job ID'],
  [/\bRequirements\b/g, 'Jobs'], [/\brequirements\b/g, 'jobs'],
  [/\bRequirement\b/g, 'Job'], [/\brequirement\b/g, 'job'],
  [/\bStages\b/g, 'Steps'], [/\bstages\b/g, 'steps'], [/\bStage\b/g, 'Step'], [/\bstage\b/g, 'step'],
  [/\bPipeline\b/g, 'Progress'], [/\bpipeline\b/g, 'progress'],
  [/\bOverdue\b/g, 'Late'], [/\boverdue\b/g, 'late'],
  [/\bMatch score\b/g, 'Fit'],
];
function plainWords(text) {
  if (typeof text !== 'string' || !text) return text;
  return WORDS.reduce((s, [re, to]) => s.replace(re, to), text);
}

Object.assign(module.exports, {
  plainWords,
  compareKind, compareRanges, expandQuery, mergeCompare, mayRevenue, positions, joinDayOf, median,
});
