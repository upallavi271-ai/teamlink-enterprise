// ---------------------------------------------------------------------------
// ROLE-WISE RECRUITMENT PERFORMANCE — the QUERY step (user spec 2026-10-13).
// Reads the picture built by utils/rolePerformanceData.js (read-only) and answers:
//   options()  the cascading Department / Role / Employee lists, with counts
//   report()   cards + month-wise rows for the chosen filters
//   drill()    the candidate records behind one number (same filter => same rows)
//   sheets()   the Excel workbook (same rows, same labels as the screen)
//
// WHO SEES WHAT (server-enforced; the screen only hides)
//   all     Super Admin / Admin / Manager       every role and employee
//   dept    Assistant Manager                    employees seated in their departments,
//                                                and only records inside their ATS scope
//   team    TL / STL / BDE TL                    employees in their seats (current AND former
//                                                holders), records inside their ATS scope
//   self    Recruiter / BDE / any other employee only their own row
//   counts  HR                                   every employee, COUNTS ONLY (no candidate list)
//   nobody  Accounts, Client, Candidate, ...     refused
// Candidate contact, salary and AI score are never part of any payload here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./rolePerformanceData');
const SCOPE = require('./scope');
const { stageLabel } = require('./atsVocab');

const METRICS = ['generated', 'submitted', 'selected', 'joined'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => { const [y, n] = String(m).split('-').map(Number); return `${MONTHS[n - 1]} ${y}`; };
const NONE = '__none__';
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

const FORMULAS = {
  generated: 'Candidates Generated = candidates created / sourced by the employee, counted on the day they were generated. Each candidate once.',
  submitted: 'Submitted = candidates first sent to the client (the move to "Shared with client" or later), counted on that day. Each candidate once. Only moves that were really recorded are counted.',
  selected: 'Selected = candidates the client selected (the move to "Selected" or later), counted on the day of that move. Shortlisted, interview and offer do not count. Each candidate once.',
  joined: 'Actual Joinings = candidates at Joined / Hired with an actual joining date, counted on that date (not the day they were selected). Expected, offered and selected-but-not-joined do not count. Each candidate once.',
  conversion: 'Joinings per 100 generated = Actual Joinings / Candidates Generated x 100, for the same employee and month (shows N/A when nothing was generated).',
  average: 'Average monthly joinings = total Actual Joinings / number of months that have data in the period you picked. Months with a verified 0 count; months with no data do not.',
  credit: null, // filled from the live setting
  role: 'Department and Role in each row are the seat the employee held on the day of the record (the seat written on the record, else their recorded seat tenure). Where neither exists it says "History not available" - the current seat is never used for the past.',
  missing: 'A record that qualifies but has no usable date is shown separately as "date missing" and is not put in any month. "Data not available" means nothing was recorded; a 0 means it was recorded and the answer is none.',
  timezone: 'Days and calendar months use Asia/Kolkata (IST).',
};

// --- who is asking ------------------------------------------------------------------
function viewerOf(user) {
  const sc = SCOPE.scopeOf(user);
  const held = [sc.role, sc.atsRole, sc.hrmsRole].filter(Boolean);
  const has = (r) => held.includes(r);
  let level = null;
  if (sc.adminGlobal || has('SUPER_ADMIN') || has('ADMIN') || has('MANAGER')) level = 'all';
  else if (has('ASSISTANT_MANAGER')) level = 'dept';
  else if (['TL', 'STL'].includes(sc.atsRole) || SCOPE.isBdeTl(user)) level = 'team';
  else if (sc.atsRole === 'HR' || sc.hrmsRole === 'HR' || sc.role === 'HR') level = 'counts';
  else if (['RECRUITER', 'BDE'].includes(sc.atsRole) || user.employeeId) level = 'self';
  return {
    level, sc, userId: user.id, employeeId: user.employeeId || null,
    names: level !== 'counts', setting: !!(sc.adminGlobal || sc.role === 'SUPER_ADMIN' || sc.hrmsRole === 'SUPER_ADMIN'),
  };
}

function makeAccess(ds, v, user) {
  const sc = v.sc;
  const mePk = v.employeeId && ds.emps.has(`e:${v.employeeId}`) ? `e:${v.employeeId}` : null;
  const codes = sc.positions ? new Set((sc.positions.positionCodes || []).map(D.normSeat)) : null;
  const holders = sc.positions ? new Set([...(sc.positions.holderUserIds || []), user.id]) : null;
  const team = sc.teamUserIds ? new Set([...sc.teamUserIds, user.id]) : null;
  const depts = new Set((sc.departments || []).map(D.compact));
  const seatDept = (info) => [...info.pairs].map((id) => ds.posById.get(id)).filter(Boolean).map((p) => D.compact(p.department));
  function canSee(info) {
    switch (v.level) {
      case 'all': case 'counts': return true;
      case 'self': return info.pk === mePk || (!!info.userId && info.userId === user.id);
      case 'dept': return seatDept(info).some((d) => depts.has(d)) || depts.has(D.compact(info.department));
      case 'team': {
        if (info.pk === mePk || info.userId === user.id) return true;
        if (codes && [...info.pairs].some((id) => codes.has(D.normSeat((ds.posById.get(id) || {}).code)))) return true;
        if (holders && info.userId && holders.has(info.userId)) return true;
        if (team && info.userId && team.has(info.userId)) return true;
        if (!codes && !team) return seatDept(info).some((d) => depts.has(d)) || depts.has(D.compact(info.department));
        return false;
      }
      default: return false;
    }
  }
  return { canSee, mePk };
}

// The applications this viewer's ATS scope allows (dept / team levels only).
async function allowedApps(user, v) {
  if (!['dept', 'team'].includes(v.level)) return null;
  const rows = await prisma.application.findMany({ where: SCOPE.applicationWhere(user), select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

// --- filters ---------------------------------------------------------------------------
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const monthsBetween = (fromM, toM) => {
  const out = [];
  let [y, m] = fromM.split('-').map(Number);
  const [ey, em] = toM.split('-').map(Number);
  for (let g = 0; g < 600 && (y < ey || (y === ey && m <= em)); g += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
};
const monthEnd = (m) => { const [y, n] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, n, 0)).getUTCDate()).padStart(2, '0')}`; };

function filtersOf(q, ds) {
  const f = {
    department: String(q.department || ''), role: String(q.role || ''), employee: String(q.employee || ''),
  };
  const today = ds.today;
  const thisM = today.slice(0, 7);
  let from; let to; let label; let kind;
  const covMonths = [...ds.coverage].sort();
  if (q.period === 'all') {
    from = `${(covMonths[0] || thisM)}-01`; to = today; kind = 'all'; label = 'All available periods';
  } else if (isIso(q.from) && isIso(q.to) && q.from <= q.to) {
    from = q.from; to = q.to < today ? q.to : today; kind = 'custom'; label = `${q.from} to ${q.to}`;
  } else if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) {
    from = `${q.month}-01`; to = monthEnd(q.month) < today ? monthEnd(q.month) : today; kind = 'month'; label = monthLabel(q.month);
  } else {
    const y = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : thisM.slice(0, 4);
    from = `${y}-01-01`; to = `${y}-12-31` < today ? `${y}-12-31` : today; kind = 'year'; label = y;
  }
  if (to < from) to = from;
  f.from = from; f.to = to; f.kind = kind; f.label = label;
  f.months = monthsBetween(from.slice(0, 7), to.slice(0, 7));
  return f;
}

const roleIdsOf = (info) => (info.pairs.size ? [...info.pairs] : [NONE]);
function deptIdsOf(ds, info) {
  return [...info.pairs].map((id) => ds.posById.get(id)).filter((p) => p && p.dept).map((p) => p.dept.id);
}
function empMatches(ds, info, f) {
  if (f.employee && info.pk !== f.employee) return false;
  if (f.role && !roleIdsOf(info).includes(f.role)) return false;
  if (f.department && !deptIdsOf(ds, info).includes(f.department)) return false;
  return true;
}

function eventPasses(ds, e, f, vis, apps) {
  if (!e.pk) return false;
  if (!vis.has(e.pk)) return false;
  if (apps && e.appId && !apps.has(e.appId)) return false;
  if (f.employee && e.pk !== f.employee) return false;
  const pos = e.posId ? ds.posById.get(e.posId) : null;
  if (e.day) {
    if (f.role) { if (f.role === NONE) { if (e.posId) return false; } else if (e.posId !== f.role) return false; }
    if (f.department && !(pos && pos.dept && pos.dept.id === f.department)) return false;
  } else if (!empMatches(ds, ds.emps.get(e.pk), f)) return false;
  return true;
}

async function context(user, q, { fresh = false } = {}) {
  const v = viewerOf(user);
  if (!v.level) { const e = new Error('This report is for recruiters, team leads, managers and admins.'); e.status = 403; throw e; }
  const ds = await D.load({ fresh });
  const access = makeAccess(ds, v, user);
  const apps = await allowedApps(user, v);
  const vis = new Set();
  ds.emps.forEach((info, pk) => { if (access.canSee(info)) vis.add(pk); });
  return { v, ds, vis, apps, f: filtersOf(q || {}, ds) };
}

// --- options: cascading with counts ------------------------------------------------------
function statusTag(info) { return info.statusGroup === 'Active' ? 'Active' : 'Former'; }
function rangeText(t) {
  const ym = (d) => { const [y, m] = d.split('-'); return `${MONTHS[+m - 1].slice(0, 3)} ${y}`; };
  return `${ym(t.from)}${t.to ? ` to ${ym(t.to)}` : ' to now'}`;
}
function employeeOption(ds, info, f) {
  const cur = info.tenures.filter((t) => !t.to || t.to >= ds.today);
  const curRoles = [...new Set(cur.map((t) => t.code))];
  const curDepts = [...new Set(cur.map((t) => (ds.posById.get(t.posId) || {}).department).filter(Boolean))];
  const o = {
    value: info.pk, name: info.name, code: info.code || null, status: statusTag(info), statusDetail: info.statusDetail,
    currentRole: curRoles.join(', ') || null, currentDepartment: curDepts.join(', ') || info.department || null,
    linked: info.linked, historicalRole: null,
  };
  if (f.role && f.role !== NONE) {
    const mine = info.tenures.filter((t) => t.posId === f.role);
    const pos = ds.posById.get(f.role);
    if (mine.length && !mine.some((t) => !t.to || t.to >= ds.today)) o.historicalRole = `Was ${pos ? pos.code : 'this role'}: ${mine.map(rangeText).join(', ')}`;
    else if (!mine.length) o.historicalRole = `Seen on ${pos ? pos.code : 'this role'} records (tenure dates not recorded)`;
  } else if (f.role === NONE) o.historicalRole = 'No seat on record';
  o.label = `${info.name}${info.code ? ` (${info.code})` : ''} - ${o.status}${o.currentRole ? ` - ${o.currentRole}` : ''}${o.historicalRole ? ` - ${o.historicalRole}` : ''}`;
  return o;
}

async function options(user, q) {
  const { v, ds, vis, f } = await context(user, q);
  // Only people who have a seat history OR any credited record are worth listing.
  const pool = [...vis].map((pk) => ds.emps.get(pk)).filter((i) => i && (i.pairs.size || ds.activePk.has(i.pk)));
  const count = (list, keyFn) => {
    const m = new Map();
    list.forEach((i) => keyFn(i).forEach((k) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(i.pk); }));
    return m;
  };
  const byEmp = (i) => (!f.employee || i.pk === f.employee);
  const byRole = (i) => (!f.role || roleIdsOf(i).includes(f.role));
  const byDept = (i) => (!f.department || deptIdsOf(ds, i).includes(f.department));

  const deptOfRole = f.role && f.role !== NONE ? ((ds.posById.get(f.role) || {}).dept || {}).id : null;
  const deptCounts = count(pool.filter((i) => byRole(i) && byEmp(i)), (i) => (deptOfRole ? [deptOfRole] : deptIdsOf(ds, i)));
  const depts = [...ds.deptByKey.values()].filter((d) => deptCounts.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, active: d.active, count: deptCounts.get(d.id).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inDept = (id) => !f.department || id === NONE || ((ds.posById.get(id) || {}).dept || {}).id === f.department;
  const roleCounts = count(pool.filter((i) => byDept(i) && byEmp(i)), (i) => roleIdsOf(i).filter(inDept));
  const roles = ds.positions.filter((p) => roleCounts.has(p.id)).map((p) => ({
    id: p.id, code: p.code, name: p.name || null, department: p.department || null, departmentId: p.dept ? p.dept.id : null,
    active: p.active, count: roleCounts.get(p.id).size,
    label: `${p.code}${p.name ? ` - ${p.name}` : ''}${p.active ? '' : ' (inactive)'}`,
  })).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  if (roleCounts.has(NONE)) roles.push({ id: NONE, code: 'No seat on record', name: null, department: null, active: true, count: roleCounts.get(NONE).size, label: 'No seat on record' });
  const employees = pool.filter((i) => byDept(i) && byRole(i)).map((i) => employeeOption(ds, i, f))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'Active' ? -1 : 1));
  const years = [...new Set([...ds.coverage].map((m) => m.slice(0, 4)).concat(ds.today.slice(0, 4)))].sort().reverse();
  return {
    departments: depts, roles, employees, years, today: ds.today, firstMonth: [...ds.coverage].sort()[0] || null,
    attribution: { mode: ds.mode, text: D.MODE_TEXT[ds.mode], modes: D.MODES.map((m) => ({ id: m, text: D.MODE_TEXT[m] })), canChange: v.setting },
    viewer: { level: v.level, names: v.names },
  };
}

// --- the report -------------------------------------------------------------------------
const pct = (j, g) => (g === null || j === null ? null : g > 0 ? Math.round((j / g) * 1000) / 10 : 'N/A');

function seatText(ds, posId) {
  const p = posId ? ds.posById.get(posId) : null;
  return {
    role: p ? p.code : 'History not available', roleId: p ? p.id : null, roleActive: p ? p.active : null,
    department: p && p.department ? p.department : (p ? '-' : 'History not available'), departmentId: p && p.dept ? p.dept.id : null,
  };
}

function compute(ctx) {
  const { ds, vis, apps, f } = ctx;
  const inRange = (d) => d && d >= f.from && d <= f.to;
  const rows = new Map();
  const mk = (month, pk, posId) => {
    const key = `${month}|${pk}|${posId || '-'}`;
    if (!rows.has(key)) rows.set(key, { key, month, pk, posId: posId || null, c: { generated: 0, submitted: 0, selected: 0, joined: 0 }, any: 0, tenure: false });
    return rows.get(key);
  };
  const missing = { generated: 0, submitted: 0, selected: 0, joined: 0 };
  const unattr = { generated: 0, submitted: 0, selected: 0, joined: 0, missing: 0 };
  const showUnattr = !f.employee && !f.role && !f.department && ['all', 'counts', 'dept'].includes(ctx.v.level) && !apps;
  ds.events.forEach((e) => {
    if (!e.pk) {
      if (showUnattr) { if (!e.day) unattr.missing += 1; else if (inRange(e.day)) unattr[e.metric] += 1; }
      return;
    }
    if (!eventPasses(ds, e, f, vis, apps)) return;
    if (!e.day) { missing[e.metric] += 1; return; }
    if (!inRange(e.day)) return;
    const r = mk(e.day.slice(0, 7), e.pk, e.posId);
    r.c[e.metric] += 1; r.any += 1;
  });
  // Verified-zero rows: every month an employee held a seat (recorded tenure), even with no activity.
  const single = !!f.employee;
  vis.forEach((pk) => {
    const info = ds.emps.get(pk);
    if (!info || !empMatches(ds, info, f)) return;
    f.months.forEach((m) => {
      const ms = `${m}-01`; const me = monthEnd(m);
      const held = info.tenures.filter((t) => t.from <= me && (!t.to || t.to >= ms)
        && (!f.role || f.role === t.posId) && (!f.department || ((ds.posById.get(t.posId) || {}).dept || {}).id === f.department));
      if (held.length) {
        if (ds.coverage.has(m) || single) held.forEach((t) => { const r = mk(m, pk, t.posId); r.tenure = true; });
      } else if (single && !f.role && !f.department && !rows.has(`${m}|${pk}|-`)
        && ![...rows.keys()].some((k) => k.startsWith(`${m}|${pk}|`))) {
        mk(m, pk, null); // single-employee view: the month is shown, "No assignment in this period"
      }
    });
  });
  const out = [];
  rows.forEach((r) => {
    const info = ds.emps.get(r.pk);
    const st = seatText(ds, r.posId);
    const noAssign = !r.posId && r.any === 0;
    const cov = ds.coverage.has(r.month);
    const cell = (k) => (noAssign ? null : r.c[k] > 0 ? r.c[k] : (cov ? 0 : null));
    const row = {
      key: r.key, month: r.month, monthLabel: monthLabel(r.month), employeeKey: r.pk, employeeId: info.employeeId, employee: info.name,
      employeeCode: info.code, status: statusTag(info), statusDetail: info.statusDetail, linked: info.linked,
      ...st, roleId: st.roleId, noAssignment: noAssign,
      generated: cell('generated'), submitted: cell('submitted'), selected: cell('selected'), joined: cell('joined'),
    };
    row.conversion = pct(row.joined, row.generated);
    out.push(row);
  });
  out.sort((a, b) => a.month.localeCompare(b.month) || a.employee.localeCompare(b.employee) || String(a.role).localeCompare(String(b.role)));
  return { rows: out, missing, unattr, showUnattr };
}

function summarise(ctx, rows, missing, unattr) {
  const sum = (k) => { const vals = rows.filter((r) => !r.noAssignment && r[k] !== null).map((r) => r[k]); return vals.length ? vals.reduce((a, b) => a + b, 0) : null; };
  const totals = {}; METRICS.forEach((k) => { totals[k] = sum(k); });
  const empSet = new Set(rows.filter((r) => !r.noAssignment).map((r) => r.employeeKey));
  const monthsWith = new Set(rows.filter((r) => !r.noAssignment && r.joined !== null).map((r) => r.month));
  const monthly = [...new Set(rows.map((r) => r.month))].sort().map((m) => {
    const rs = rows.filter((r) => r.month === m && !r.noAssignment);
    const t = { month: m, monthLabel: monthLabel(m), employees: new Set(rs.map((r) => r.employeeKey)).size };
    METRICS.forEach((k) => { const vs = rs.filter((r) => r[k] !== null).map((r) => r[k]); t[k] = vs.length ? vs.reduce((a, b) => a + b, 0) : null; });
    t.conversion = pct(t.joined, t.generated);
    return t;
  });
  return {
    employees: empSet.size, ...totals, conversion: pct(totals.joined, totals.generated),
    monthsWithData: monthsWith.size,
    averageMonthlyJoinings: totals.joined === null || !monthsWith.size ? null : Math.round((totals.joined / monthsWith.size) * 10) / 10,
    period: ctx.f.label, missing, unattributed: unattr, monthly,
  };
}

function messageFor(ctx, rows, n) {
  const { f } = ctx;
  if (rows.length) return null;
  if ((f.role || f.department) && !n.inRole) return 'No employees for this role';
  if (f.employee && !n.employeeCount) return 'No results for these filters';
  if (f.employee || f.role || f.department) return 'No assignment in this period';
  return 'No results for these filters';
}

async function report(user, q) {
  const ctx = await context(user, q, { fresh: q.fresh === '1' });
  const { ds, vis, f } = ctx;
  const { rows, missing, unattr, showUnattr } = compute(ctx);
  const cards = summarise(ctx, rows, missing, unattr);
  const listed = (pk) => ds.emps.get(pk).pairs.size || ds.activePk.has(pk);
  const employeeCount = [...vis].filter((pk) => empMatches(ds, ds.emps.get(pk), f) && listed(pk)).length;
  const inRole = [...vis].filter((pk) => empMatches(ds, ds.emps.get(pk), { ...f, employee: '' }) && listed(pk)).length;
  const formulas = { ...FORMULAS, credit: `Credit: ${D.MODE_TEXT[ds.mode]}. Generated is always the person who generated the candidate.` };
  return {
    filters: { department: f.department, role: f.role, employee: f.employee, from: f.from, to: f.to, kind: f.kind, label: f.label },
    months: f.months.map((m) => ({ month: m, label: monthLabel(m), hasData: ds.coverage.has(m) })),
    cards, rows, message: messageFor(ctx, rows, { employeeCount, inRole }), employeeCount,
    showUnattributed: showUnattr, formulas, attribution: { mode: ds.mode, text: D.MODE_TEXT[ds.mode] },
    viewer: { level: ctx.v.level, drill: ctx.v.level !== 'counts', names: ctx.v.names },
    builtAt: ds.builtAt,
  };
}

// --- drill-down: the records behind a number ------------------------------------------------
function appFor(ds, e) {
  if (e.appId) return ds.appFacts.get(e.appId);
  const list = ds.appsByCand.get(e.cid) || [];
  return [...list].sort((a, b) => b.reach - a.reach)[0] || null;
}
async function drill(user, q) {
  const ctx = await context(user, q);
  if (ctx.v.level === 'counts') { const e = new Error('Your view shows numbers only. The candidate list is in ATS.'); e.status = 403; throw e; }
  const { ds, vis, apps, f } = ctx;
  const metric = String(q.metric || '');
  if (!METRICS.includes(metric)) { const e = new Error('Pick generated, submitted, selected or joined.'); e.status = 400; throw e; }
  const wantMonth = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : '';
  const undated = q.missing === '1';
  const unattrib = q.unattributed === '1';
  const posQ = q.seat ? String(q.seat) : '';
  const list = ds.events.filter((e) => {
    if (e.metric !== metric) return false;
    if (unattrib) {
      if (ctx.v.level === 'self' || ctx.v.level === 'team') return false;
      return !e.pk && (undated ? !e.day : !!e.day && e.day >= f.from && e.day <= f.to);
    }
    if (undated) return !e.day && eventPasses(ds, e, f, vis, apps);
    if (!e.day || !eventPasses(ds, e, f, vis, apps)) return false;
    if (wantMonth ? e.day.slice(0, 7) !== wantMonth : (e.day < f.from || e.day > f.to)) return false;
    if (posQ) return (posQ === NONE ? !e.posId : e.posId === posQ);
    return true;
  });
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(10, Number(q.size) || 100));
  const rows = list.sort((a, b) => String(a.day || '').localeCompare(String(b.day || ''))).slice((page - 1) * size, page * size).map((e) => {
    const fa = appFor(ds, e);
    const cand = ds.candById.get(e.cid) || {};
    const info = e.pk ? ds.emps.get(e.pk) : null;
    const st = seatText(ds, e.posId);
    const g = ds.gen.get(e.cid);
    const allApps = ds.byCanon.get(ds.canon(e.cid)) || [];
    const minDay = (key) => allApps.map((x) => x[key]).filter(Boolean).sort()[0] || null;
    const req = fa ? fa.req : {};
    return {
      candidateId: e.cid, candidate: cand.name || '-',
      client: req.internal ? 'TeamLink Internal' : (ds.clientName.get(req.clientId) || '-'),
      job: req.title ? `${req.title}${req.reqCode ? ` (${req.reqCode})` : ''}` : '-',
      employee: info ? info.name : 'Not credited to anyone', employeeCode: info ? info.code : null, employeeStatus: info ? statusTag(info) : null,
      generationDate: g ? g.day : null, step: fa ? stageLabel(fa.app.stage) : '-',
      selectionDate: minDay('selectedDay'), joiningDate: minDay('joinDay'), submittedDate: minDay('sharedDay'),
      metricDate: e.day, role: st.role, department: st.department, seatBasis: e.seatBasis, creditBasis: e.credit,
    };
  });
  return { metric, total: list.length, page, size, rows, month: wantMonth || null, undated, label: f.label };
}

// --- Excel ----------------------------------------------------------------------------------------
async function sheets(user, q) {
  const r = await report(user, q);
  const fmt = (n, k) => (n === null ? 'Data not available' : n);
  const conv = (c) => (c === null ? 'Data not available' : c === 'N/A' ? 'N/A' : `${c}`);
  const rows = r.rows.map((x) => [
    x.monthLabel, x.employee, x.employeeCode || '-', x.status, x.department, x.noAssignment ? 'No assignment in this period' : x.role,
    fmt(x.generated), fmt(x.submitted), fmt(x.selected), fmt(x.joined), conv(x.conversion),
  ]);
  const c = r.cards;
  const card = (n) => (n === null ? 'Data not available' : n);
  const summary = [
    ['Period', c.period], ['Employees in role / period', c.employees], ['Candidates Generated', card(c.generated)],
    ['Submitted / Processed', card(c.submitted)], ['Selected', card(c.selected)], ['Actual Joinings', card(c.joined)],
    ['Joinings per 100 generated', conv(c.conversion)], ['Average monthly joinings', c.averageMonthlyJoinings === null ? 'Data not available' : c.averageMonthlyJoinings],
    ['Months with data', c.monthsWithData],
    ['Generated, date missing', c.missing.generated], ['Submitted, date missing', c.missing.submitted],
    ['Selected, date missing', c.missing.selected], ['Joined, date missing', c.missing.joined],
  ];
  const how = Object.entries(r.formulas).map(([k, t]) => [k, t]);
  return {
    sheets: [
      { name: 'Role performance', headers: ['Month-Year', 'Employee', 'Employee ID', 'Status', 'Department', 'Role', 'Generated', 'Submitted / Processed', 'Selected', 'Actual Joinings', 'Joinings per 100 generated'], rows },
      { name: 'Summary', headers: ['Item', 'Value'], rows: summary },
      { name: 'How counted', headers: ['Topic', 'Rule'], rows: how },
    ],
    count: rows.length,
  };
}

module.exports = {
  viewerOf, options, report, drill, sheets, FORMULAS, METRICS, NONE,
};
