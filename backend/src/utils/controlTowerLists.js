// ---------------------------------------------------------------------------
// THE CONTROL TOWER'S DETAIL LISTS (founder, 2026-10-23): "whatever is clicked opens its details ON THE DASHBOARD - no other page, no route change".
// One endpoint (GET /api/dashboard/control-tower/list?set=<name>&q=&filter=&sort=&dir=&page=&pageSize=) feeds the side drawer for every figure,
// pipeline step, chart month, attention row, integration, data-health check and activity row. Real records only, read-only, server-side search /
// sorting / paging, one row = { id, c: { <column key>: value }, d: [[label, value], ...] } where `d` is what the row shows when it is expanded.
// Company-wide, so the route only lets Super Admin / Admin in (routes/dashboard.js). The sets use the SAME definitions as the figures
// (utils/controlTower.js): live requirement statuses, active = not Rejected / On hold / Joined, the ATS pending stages, the invoice maths.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { REQUIREMENT_LIVE_STATUSES, stageLabel, stepShown } = require('./atsVocab');
const A = require('./accounts');
const CNU = require('./creditNotes');
const { withoutSystemAccounts } = require('./systemAccounts');
const { INTEGRATION_CATALOG } = require('./adminCatalog');
const PV = require('./pipelineView');
const MP = require('./multiParam');
const DR = require('./dateRange');

const DAY = 86400000;
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const TERMINAL = ['REJECTED', 'HOLD', 'JOINED', 'HIRED'];
const PENDING_STAGES = ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const PENDING_TYPES = {
  review: ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED'],
  client: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'],
  feedback: ['INTERVIEW_COMPLETED'],
  joining: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'],
};
const CHAIN = {
  screening: ['new', 'ai_interview', 'recruiter_review', 'tl_review', 'bde_review'], client: ['client_review'], interview: ['interview'],
  selected: ['selected', 'offer', 'joining'], joined: ['joined'],
};
const stagesOfChain = (key) => PV.STAGE_GROUPS.filter((g) => (CHAIN[key] || []).includes(g.id)).flatMap((g) => g.stages);

// ---- THE DRAWER'S OWN FILTERS (founder 2026-11-20: "every list must have filters"): next to the search and the Show preset, each list
// offers checkbox dropdowns (f_<key>=a,b: several values, OR inside one filter, AND across) and a From / To day over its own date
// (dFrom / dTo, IST days, both ends included; a bad or reversed day is a 400 from utils/dateParamGuard.js before the route runs).
// Each option carries its count over the rows matching every OTHER filter; a ticked value stays offered even at 0.
const NONE = '__none__';
function params(q) {
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const page = Math.max(1, Number(q.page) || 1);
  const multi = {};
  Object.keys(q || {}).forEach((k) => { if (/^f_[a-z]{2,20}$/.test(k)) { const v = MP.parseMulti(q[k]); if (v.length) multi[k.slice(2)] = v; } });
  const dFrom = DR.validIso(str(q.dFrom)) ? str(q.dFrom) : '';
  const dTo = DR.validIso(str(q.dTo)) ? str(q.dTo) : '';
  return {
    text: str(q.q), filter: str(q.filter), sort: str(q.sort), dir: str(q.dir) === 'asc' ? 'asc' : 'desc', page, pageSize, month: str(q.month), stage: str(q.stage), open: str(q.open), id: str(q.id), multi, dFrom, dTo,
  };
}
const col = (key, label, type = 'text', sort = null) => ({ key, label, type, sort: sort || null });
const field = (label, value) => [label, value === undefined || value === null || value === '' ? null : value];

// the date condition: 'dt' = a DateTime column (IST day bounds), 'day' = a YYYY-MM-DD text column
function dayCond(p, column, kind = 'dt') {
  if (!p.dFrom && !p.dTo) return null;
  if (kind === 'day') return { [column]: { ...(p.dFrom ? { gte: p.dFrom } : {}), ...(p.dTo ? { lt: DR.addDays(p.dTo, 1) } : {}) } };
  return { [column]: { ...(p.dFrom ? { gte: DR.istStart(p.dFrom) } : {}), ...(p.dTo ? { lt: DR.istStart(DR.addDays(p.dTo, 1)) } : {}) } };
}
const dayIn = (p, v) => {
  if (!p.dFrom && !p.dTo) return true;
  if (!v) return false;
  const day = /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !(v instanceof Date) ? String(v).slice(0, 10) : DR.istDayOf(v);
  return !!day && (!p.dFrom || day >= p.dFrom) && (!p.dTo || day <= p.dTo);
};
// a scalar column picked by several values; NONE = empty
function inCond(column, vals) {
  const real = vals.filter((v) => v !== NONE);
  const or = [];
  if (real.length) or.push({ [column]: { in: real } });
  if (vals.includes(NONE)) or.push({ [column]: null }, { [column]: '' });
  return or.length === 1 ? or[0] : { OR: or };
}
// facet definitions for a DB list: { key, label, cond: (vals) => where, group: async (where) => [{ value, label, count }] }
const byColumn = (model, column, noneLabel = 'Not given', labelOf = (v) => v) => ({
  cond: (vals) => inCond(column, vals),
  group: async (where) => {
    const g = await prisma[model].groupBy({ by: [column], where, _count: { _all: true } });
    return g.map((x) => ({ value: x[column] === null || x[column] === '' ? NONE : String(x[column]), count: x._count._all }))
      .reduce((acc, o) => { const e = acc.find((y) => y.value === o.value); if (e) e.count += o.count; else acc.push(o); return acc; }, [])
      .map((o) => ({ ...o, label: o.value === NONE ? noneLabel : labelOf(o.value) }));
  },
});
// applications grouped by a fact of their requirement (department / client)
const byRequirement = (what) => ({
  cond: (vals) => {
    const real = vals.filter((v) => v !== NONE);
    const column = what === 'client' ? 'clientId' : 'department';
    const or = [];
    if (real.length) or.push({ requirement: { is: { [column]: { in: real } } } });
    if (vals.includes(NONE) && what === 'dept') or.push({ requirement: { is: { OR: [{ department: null }, { department: '' }] } } });
    return or.length === 1 ? or[0] : { OR: or };
  },
  group: async (where) => {
    const g = await prisma.application.groupBy({ by: ['requirementId'], where, _count: { _all: true } });
    const reqs = await prisma.requirement.findMany({ where: { id: { in: g.map((x) => x.requirementId).slice(0, 5000) } }, select: { id: true, department: true, clientId: true, client: { select: { name: true } } } });
    const by = new Map(reqs.map((r) => [r.id, r]));
    const m = new Map();
    g.forEach((x) => {
      const r = by.get(x.requirementId) || {};
      const value = what === 'client' ? (r.clientId || NONE) : (r.department || NONE);
      const label = what === 'client' ? ((r.client && r.client.name) || 'No client') : (r.department || 'No department');
      const e = m.get(value) || { value, label, count: 0 };
      e.count += x._count._all;
      m.set(value, e);
    });
    return [...m.values()];
  },
});
const sortOpts = (opts) => opts.sort((x, y) => (x.value === NONE) - (y.value === NONE) || y.count - x.count || String(x.label).localeCompare(String(y.label))).slice(0, 300);
// the where of the list (base AND every picked facet) and each facet's options (its own pick left out)
async function dbFilters(p, baseAnd, defs) {
  const used = defs.filter((d) => p.multi[d.key]);
  const and = [...baseAnd, ...used.map((d) => d.cond(p.multi[d.key]))];
  const facets = [];
  for (const d of defs) {
    const w = { AND: [...baseAnd, ...used.filter((u) => u.key !== d.key).map((u) => u.cond(p.multi[u.key]))] };
    // eslint-disable-next-line no-await-in-loop
    let opts = await d.group(w).catch(() => []);
    (p.multi[d.key] || []).forEach((v) => { if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: v === NONE ? 'Not given' : v, count: 0 }); });
    opts = sortOpts(opts);
    if (opts.length) facets.push({ key: d.key, label: d.label, options: opts });
  }
  return { where: { AND: and }, facets };
}
// the same for a list held in memory: defs = [{ key, label, val: (row) => value, lab: (row) => label }]
function memFilters(p, rows, defs) {
  const picked = defs.filter((d) => p.multi[d.key]);
  const ok = (r, skip) => picked.every((d) => d.key === skip || p.multi[d.key].includes(String(d.val(r) || NONE)));
  const facets = [];
  defs.forEach((d) => {
    const m = new Map();
    rows.forEach((r) => { if (!ok(r, d.key)) return; const v = String(d.val(r) || NONE); const e = m.get(v) || { value: v, label: v === NONE ? 'Not given' : d.lab(r), count: 0 }; e.count += 1; m.set(v, e); });
    (p.multi[d.key] || []).forEach((v) => { if (!m.has(v)) m.set(v, { value: v, label: v, count: 0 }); });
    const opts = sortOpts([...m.values()]);
    if (opts.length) facets.push({ key: d.key, label: d.label, options: opts });
  });
  return { rows: rows.filter((r) => ok(r, null)), facets };
}
const and1 = (...xs) => xs.filter(Boolean);

// in-memory paging for the sets that need the invoice maths
function memPage(rows, p, cmp) {
  const sorted = cmp ? [...rows].sort(cmp) : rows;
  const pages = Math.max(1, Math.ceil(sorted.length / p.pageSize));
  const page = Math.min(pages, p.page);
  return { rows: sorted.slice((page - 1) * p.pageSize, page * p.pageSize), total: sorted.length, page, pages };
}
async function dbPage(p, { findMany, count }) {
  const total = await count();
  const pages = Math.max(1, Math.ceil(total / p.pageSize));
  const page = Math.min(pages, p.page);
  const rows = await findMany({ skip: (page - 1) * p.pageSize, take: p.pageSize });
  return { rows, total, page, pages };
}
const orderOf = (p, map, dflt) => { const k = map[p.sort] ? p.sort : dflt; return map[k](p.dir); };

// ---- applications (candidates / pipeline / feedback / pending) ----
function appRow(a) {
  const c = a.candidate || {}; const r = a.requirement || {};
  return {
    id: a.id,
    c: { candidate: c.name || '-', stage: stepShown(a, stageLabel(a.stage) || a.stage), requirement: r.title || '-', client: (r.client && r.client.name) || '-', added: a.createdAt, updated: a.updatedAt },
    d: [field('Requirement code', r.reqCode), field('Department', r.department), field('Source', a.source || c.source), field('Location', c.location), field('Email', c.email), field('Phone', c.phone),
      field('Interview', a.interviewAt ? new Date(a.interviewAt).toISOString().slice(0, 16).replace('T', ' ') : null)],
  };
}
const APP_COLS = [col('candidate', 'Candidate', 'text', 'candidate'), col('stage', 'Step', 'status', 'stage'), col('requirement', 'Requirement', 'text', 'requirement'), col('client', 'Client'), col('added', 'Added', 'date', 'added')];
const APP_FACETS = [
  { key: 'dept', label: 'Department', ...byRequirement('dept') },
  { key: 'client', label: 'Client', ...byRequirement('client') },
  { key: 'stage', label: 'Step', ...byColumn('application', 'stage', 'No step', (v) => stageLabel(v) || v) },
];
async function apps(p, stages, { notIn, extra } = {}) {
  const and = [stages ? { stage: { in: stages } } : { stage: { notIn: notIn || TERMINAL } }];
  if (extra) and.push(extra);
  if (p.text) and.push({ OR: [{ candidate: { is: { name: { contains: p.text } } } }, { candidate: { is: { email: { contains: p.text } } } }, { candidate: { is: { phone: { contains: p.text } } } }, { requirement: { is: { title: { contains: p.text } } } }, { requirement: { is: { reqCode: { contains: p.text } } } }, { requirement: { is: { client: { is: { name: { contains: p.text } } } } } }] });
  const dc = dayCond(p, 'createdAt');
  if (dc) and.push(dc);
  const { where, facets } = await dbFilters(p, and, APP_FACETS);
  const order = orderOf(p, {
    candidate: (d) => ({ candidate: { name: d } }), stage: (d) => ({ stage: d }), requirement: (d) => ({ requirement: { title: d } }), added: (d) => ({ createdAt: d }), updated: (d) => ({ updatedAt: d }),
  }, 'added');
  const res = await dbPage(p, {
    count: () => prisma.application.count({ where }),
    findMany: ({ skip, take }) => prisma.application.findMany({ where, orderBy: order, skip, take, include: { candidate: { select: { name: true, email: true, phone: true, source: true, location: true } }, requirement: { select: { title: true, reqCode: true, department: true, client: { select: { name: true } } } } } }),
  });
  return { ...res, rows: res.rows.map(appRow), columns: APP_COLS, facets, dateField: 'Added' };
}

// ---- the sets ----
const SETS = {
  async employees(p) {
    const f = p.filter || 'Active';
    const status = f === 'former' ? { in: ['Relieved', 'Exited'] } : f === 'all' ? undefined : f;
    const base = status === undefined ? {} : { employmentStatus: status };
    const where0 = withoutSystemAccounts(base);
    const and = and1(where0, dayCond(p, 'dateOfJoining'));
    if (p.text) and.push({ OR: [{ name: { contains: p.text } }, { employeeCode: { contains: p.text } }, { department: { contains: p.text } }, { designation: { contains: p.text } }, { email: { contains: p.text } }] });
    // department, designation and employee type only (never salary, location, gender, age or other personal facts)
    const { where, facets } = await dbFilters(p, and, [
      { key: 'dept', label: 'Department', ...byColumn('employee', 'department', 'No department') },
      { key: 'desig', label: 'Designation', ...byColumn('employee', 'designation', 'No designation') },
      { key: 'type', label: 'Employee type', ...byColumn('employee', 'employeeType', 'Not given') },
    ]);
    const order = orderOf(p, { name: (d) => ({ name: d }), code: (d) => ({ employeeCode: d }), department: (d) => ({ department: d }), designation: (d) => ({ designation: d }) }, 'name');
    const res = await dbPage(p, { count: () => prisma.employee.count({ where }), findMany: ({ skip, take }) => prisma.employee.findMany({ where, orderBy: order, skip, take }) });
    return {
      title: 'Employees', sub: 'People who work here now. Pick Notice period or Former to see the others.', ...res, facets, dateField: 'Joined on',
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['Active', 'Active'], ['Notice Period', 'On notice period'], ['former', 'Former (relieved / exited)'], ['all', 'Everyone']] }],
      columns: [col('code', 'Code', 'text', 'code'), col('name', 'Name', 'text', 'name'), col('department', 'Department', 'text', 'department'), col('designation', 'Designation', 'text', 'designation'), col('status', 'Status', 'status')],
      rows: res.rows.map((e) => ({ id: e.id, c: { code: e.employeeCode, name: e.name, department: e.department || '-', designation: e.designation || '-', status: e.employmentStatus }, d: [field('Official email', e.email), field('Phone', e.phone), field('Team', e.team), field('Team lead', e.tl), field('Reporting manager', e.reportingManager), field('Branch', e.branch)] })),
    };
  },
  async requirements(p) {
    const f = p.filter || 'live';
    const status = f === 'live' ? { in: REQUIREMENT_LIVE_STATUSES } : f === 'hold' ? 'ON_HOLD' : f === 'closed' ? 'CLOSED' : undefined;
    const and = and1(status === undefined ? {} : { status }, dayCond(p, 'createdAt'));
    if (p.text) and.push({ OR: [{ title: { contains: p.text } }, { reqCode: { contains: p.text } }, { department: { contains: p.text } }, { client: { is: { name: { contains: p.text } } } }] });
    const clientNames = async (opts) => {
      const cs = await prisma.client.findMany({ where: { id: { in: opts.map((o) => o.value).filter((v) => v !== NONE) } }, select: { id: true, name: true } });
      const n = new Map(cs.map((c) => [c.id, c.name]));
      return opts.map((o) => ({ ...o, label: o.value === NONE ? 'No client' : (n.get(o.value) || o.value) }));
    };
    const cl = byColumn('requirement', 'clientId', 'No client');
    const { where, facets } = await dbFilters(p, and, [
      { key: 'dept', label: 'Department', ...byColumn('requirement', 'department', 'No department') },
      { key: 'client', label: 'Client', cond: cl.cond, group: async (w) => clientNames(await cl.group(w)) },
      { key: 'status', label: 'Status', ...byColumn('requirement', 'status', 'No status') },
    ]);
    const order = orderOf(p, { created: (d) => ({ createdAt: d }), title: (d) => ({ title: d }), code: (d) => ({ reqCode: d }), department: (d) => ({ department: d }), status: (d) => ({ status: d }) }, 'created');
    const res = await dbPage(p, { count: () => prisma.requirement.count({ where }), findMany: ({ skip, take }) => prisma.requirement.findMany({ where, orderBy: order, skip, take, include: { client: { select: { name: true } }, recruiter: { select: { name: true } } } }) });
    return {
      title: 'Requirements', sub: 'Open = still being worked on (not Closed, not On hold).', ...res, facets, dateField: 'Posted',
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['live', 'Open'], ['hold', 'On hold'], ['closed', 'Closed'], ['all', 'All']] }],
      columns: [col('code', 'Code', 'text', 'code'), col('title', 'Requirement', 'text', 'title'), col('client', 'Client'), col('department', 'Department', 'text', 'department'), col('status', 'Status', 'status', 'status'), col('created', 'Posted', 'date', 'created')],
      rows: res.rows.map((r) => ({ id: r.id, c: { code: r.reqCode || '-', title: r.title, client: (r.client && r.client.name) || '-', department: r.department || '-', status: r.status, created: r.createdAt }, d: [field('Openings', r.openings), field('Priority', r.priority), field('Location', r.location), field('Recruiter', r.recruiter && r.recruiter.name), field('Closing date', r.closingDate), field('Target date', r.targetDate)] })),
    };
  },
  async candidates(p) {
    const r = await apps(p, p.stage && CHAIN[p.stage] && p.stage !== 'joined' ? stagesOfChain(p.stage) : null);
    return { title: p.stage ? 'Applications at this step' : 'Active candidates', sub: 'One row per application (a person on two requirements shows twice). Rejected, On hold and Joined are not active.', ...r };
  },
  async pipeline(p) {
    const stages = stagesOfChain(p.stage);
    if (!stages.length) return { title: 'Hiring pipeline', sub: 'Unknown step.', rows: [], columns: APP_COLS, total: 0, page: 1, pages: 1 };
    const r = await apps(p, stages);
    const label = { screening: 'Being checked', client: 'With client', interview: 'Interview', selected: 'Selected / offer', joined: 'Joined' }[p.stage];
    return { title: `Hiring pipeline: ${label}`, sub: 'Where applications are today (a snapshot).', ...r };
  },
  async feedback(p) {
    // the same rows the attention card counts (utils/controlTower.js, 2026-10-26): interviews of the last 30 days
    const cut = new Date(Date.now() - 30 * DAY);
    const r = await apps(p, PENDING_TYPES.feedback, { extra: { OR: [{ interviewAt: { gte: cut } }, { interviewAt: null, updatedAt: { gte: cut } }] } });
    return { title: 'Interview feedback pending', sub: 'Interviews of the last 30 days, feedback not yet recorded.', ...r };
  },
  async pending(p) {
    const f = p.filter || 'all';
    if (f === 'leave') return { ...(await SETS.leave(p)), filters: pendingFilter(f) };
    const stages = PENDING_TYPES[f] || PENDING_STAGES;
    const r = await apps(p, stages);
    return { title: 'Pending actions', sub: 'ATS applications waiting for someone to act, plus leave requests (pick Leave requests).', ...r, filters: pendingFilter(f) };
  },
  async leave(p) {
    const and = and1({ status: 'Pending' }, dayCond(p, 'fromDate', 'day'));
    if (p.text) and.push({ OR: [{ employee: { is: { name: { contains: p.text } } } }, { employee: { is: { department: { contains: p.text } } } }, { type: { contains: p.text } }, { reason: { contains: p.text } }] });
    const { where, facets } = await dbFilters(p, and, [
      { key: 'type', label: 'Leave type', ...byColumn('leaveRequest', 'type', 'No type') },
      {
        key: 'dept',
        label: 'Department',
        cond: (vals) => ({ employee: { is: inCond('department', vals) } }),
        group: async (w) => {
          const g = await prisma.leaveRequest.groupBy({ by: ['employeeId'], where: w, _count: { _all: true } });
          const es = await prisma.employee.findMany({ where: { id: { in: g.map((x) => x.employeeId) } }, select: { id: true, department: true } });
          const d = new Map(es.map((e) => [e.id, e.department || NONE]));
          const m = new Map();
          g.forEach((x) => { const v = d.get(x.employeeId) || NONE; const e = m.get(v) || { value: v, label: v === NONE ? 'No department' : v, count: 0 }; e.count += x._count._all; m.set(v, e); });
          return [...m.values()];
        },
      },
    ]);
    const order = orderOf(p, { created: (d) => ({ createdAt: d }), from: (d) => ({ fromDate: d }), employee: (d) => ({ employee: { name: d } }) }, 'created');
    const res = await dbPage(p, { count: () => prisma.leaveRequest.count({ where }), findMany: ({ skip, take }) => prisma.leaveRequest.findMany({ where, orderBy: order, skip, take, include: { employee: { select: { name: true, department: true, employeeCode: true } } } }) });
    return {
      title: 'Leave requests awaiting decision', sub: 'Employee and team-lead leave requests still pending.', ...res, facets, dateField: 'Leave from',
      columns: [col('employee', 'Employee', 'text', 'employee'), col('department', 'Department'), col('type', 'Type'), col('from', 'From', 'date', 'from'), col('to', 'To', 'date'), col('days', 'Days', 'num'), col('applied', 'Applied', 'date', 'created')],
      rows: res.rows.map((l) => ({ id: l.id, c: { employee: (l.employee && l.employee.name) || '-', department: (l.employee && l.employee.department) || '-', type: l.type, from: l.fromDate, to: l.toDate, days: l.days, applied: l.createdAt }, d: [field('Employee code', l.employee && l.employee.employeeCode), field('Reason', l.reason)] })),
    };
  },
  async receivables(p) {
    const inv = await prisma.invoice.findMany({ include: { client: { select: { name: true } } } });
    await CNU.decorateNet(inv).catch(() => null);
    // every invoice behind the figure: what is owed, and (negative) what a client has overpaid, so the list adds up to the figure exactly
    let rows = inv.filter((i) => i.status !== 'Cancelled' && Math.abs(A.invoiceOutstanding(i)) > 0.004);
    const f = p.filter || 'all';
    if (f === 'overdue') rows = rows.filter((i) => i.dueDate && A.daysOverdue(i.dueDate) > 0);
    if (p.text) { const t = p.text.toLowerCase(); rows = rows.filter((i) => `${i.invoiceNumber || ''} ${(i.client && i.client.name) || ''}`.toLowerCase().includes(t)); }
    rows = rows.filter((i) => dayIn(p, i.invoiceDate));
    const mf = memFilters(p, rows, [
      { key: 'client', label: 'Client', val: (i) => i.clientId, lab: (i) => (i.client && i.client.name) || 'Client' },
      { key: 'status', label: 'Status', val: (i) => A.deriveInvoiceStatus(i), lab: (i) => A.deriveInvoiceStatus(i) },
    ]);
    rows = mf.rows;
    const key = { due: (i) => String(i.dueDate || '9999'), invoice: (i) => String(i.invoiceNumber || ''), client: (i) => String((i.client && i.client.name) || ''), outstanding: (i) => A.invoiceOutstanding(i), date: (i) => String(i.invoiceDate || '') };
    const k = key[p.sort] ? p.sort : 'due';
    const dir = p.sort ? (p.dir === 'asc' ? 1 : -1) : 1;
    const res = memPage(rows, p, (a, b) => { const x = key[k](a); const y = key[k](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const sum = ROUND(rows.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
    const over = rows.filter((i) => A.invoiceOutstanding(i) < -0.5);
    const overSum = ROUND(over.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
    return {
      title: 'Outstanding receivables', sub: `Money clients still owe us (after credit notes): ${rows.length} invoices, net ₹${Math.round(sum).toLocaleString('en-IN')}${over.length ? `, after ${over.length} overpaid invoice${over.length === 1 ? '' : 's'} (₹${Math.abs(Math.round(overSum)).toLocaleString('en-IN')} to give back)` : ''}. Vendor bills we owe are separate.`, ...res, facets: mf.facets, dateField: 'Invoice date',
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['all', 'All outstanding'], ['overdue', 'Overdue only']] }],
      columns: [col('invoice', 'Invoice', 'text', 'invoice'), col('client', 'Client', 'text', 'client'), col('date', 'Invoice date', 'date', 'date'), col('due', 'Due', 'date', 'due'), col('outstanding', 'Outstanding', 'money', 'outstanding'), col('status', 'Status', 'status')],
      rows: res.rows.map((i) => ({ id: i.id, c: { invoice: i.invoiceNumber || '-', client: (i.client && i.client.name) || '-', date: i.invoiceDate, due: i.dueDate, outstanding: A.invoiceOutstanding(i), status: A.deriveInvoiceStatus(i) }, d: [field('Billed (after notes)', `₹${Math.round(CNU.receivableOf(i)).toLocaleString('en-IN')}`), field('Received so far', `₹${Math.round(Number(i.receivedAmount || 0)).toLocaleString('en-IN')}`), field('Days late', i.dueDate && A.daysOverdue(i.dueDate) > 0 ? A.daysOverdue(i.dueDate) : null)] })),
    };
  },
  async 'overdue-inv'(p) { const r = await SETS.receivables({ ...p, filter: 'overdue' }); return { ...r, title: 'Overdue client invoices', filters: [] }; },
  async 'overdue-bills'(p) {
    const today = istDay();
    const bills = await prisma.officeExpense.findMany({ where: { entryKind: { not: 'hand' }, paidStatus: 'Unpaid', NOT: { approvalStatus: 'REJECTED' }, dueDate: { lt: today } }, orderBy: { dueDate: 'asc' } });
    let rows = bills;
    if (p.text) { const t = p.text.toLowerCase(); rows = rows.filter((b) => `${b.vendor || ''} ${b.billNumber || ''} ${b.expenseCode || ''} ${b.category || ''}`.toLowerCase().includes(t)); }
    rows = rows.filter((b) => dayIn(p, b.dueDate));
    const mf = memFilters(p, rows, [
      { key: 'vendor', label: 'Vendor', val: (b) => b.vendor, lab: (b) => b.vendor },
      { key: 'category', label: 'Category', val: (b) => b.category, lab: (b) => b.category },
    ]);
    rows = mf.rows;
    const key = { due: (b) => String(b.dueDate || ''), vendor: (b) => String(b.vendor || ''), amount: (b) => Number(b.monthlyAmount) || 0 };
    const k = key[p.sort] ? p.sort : 'due'; const dir = p.sort ? (p.dir === 'asc' ? 1 : -1) : 1;
    const res = memPage(rows, p, (a, b) => { const x = key[k](a); const y = key[k](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return {
      title: 'Overdue vendor bills', sub: 'Money we owe vendors, unpaid and past the due date.', ...res, facets: mf.facets, dateField: 'Due',
      columns: [col('code', 'Ref'), col('vendor', 'Vendor', 'text', 'vendor'), col('bill', 'Bill no.'), col('category', 'Category'), col('due', 'Due', 'date', 'due'), col('late', 'Days late', 'num'), col('amount', 'Amount (after TDS)', 'money', 'amount')],
      rows: res.rows.map((b) => ({ id: b.id, c: { code: b.expenseCode || '-', vendor: b.vendor || '-', bill: b.billNumber || '-', category: b.category, due: b.dueDate, late: Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${b.dueDate}T00:00:00Z`)) / DAY)), amount: ROUND(Number(b.monthlyAmount) - Number(b.tdsAmount || 0)) }, d: [field('Description', b.description), field('GST', b.gstAmount ? `₹${Math.round(b.gstAmount).toLocaleString('en-IN')}` : null), field('Vendor linked by id', b.vendorId ? 'Yes' : 'No')] })),
    };
  },
  async bank(p) {
    const and = and1({ reconStatus: 'Unmatched' }, dayCond(p, 'date', 'day'));
    if (p.text) and.push({ OR: [{ description: { contains: p.text } }, { reference: { contains: p.text } }] });
    const { where, facets } = await dbFilters(p, and, [{ key: 'type', label: 'Type', ...byColumn('bankTransaction', 'type', 'Not given') }]);
    const order = orderOf(p, { date: (d) => ({ date: d }), amount: (d) => ({ amount: d }), description: (d) => ({ description: d }) }, 'date');
    const res = await dbPage(p, { count: () => prisma.bankTransaction.count({ where }), findMany: ({ skip, take }) => prisma.bankTransaction.findMany({ where, orderBy: order, skip, take }) });
    return {
      title: 'Unmatched bank transactions', sub: 'Bank statement lines not yet matched to an invoice or a bill.', ...res, facets, dateField: 'Date',
      columns: [col('date', 'Date', 'date', 'date'), col('description', 'Description', 'text', 'description'), col('type', 'Type'), col('amount', 'Amount', 'money', 'amount'), col('reference', 'Reference')],
      rows: res.rows.map((t) => ({ id: t.id, c: { date: t.date, description: t.description, type: t.type, amount: t.amount, reference: t.reference || '-' }, d: [field('Balance', t.balance != null ? `₹${Math.round(t.balance).toLocaleString('en-IN')}` : null), field('Import batch', t.importBatch)] })),
    };
  },
  async sync(p) {
    // the same rows the attention card counts (2026-10-26): failures since the last good sync, within 30 days
    const since30 = new Date(Date.now() - 30 * DAY);
    const lastOk = await prisma.syncLog.findFirst({ where: { status: { not: 'Failed' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null);
    const since = lastOk && lastOk.createdAt > since30 ? lastOk.createdAt : since30;
    const and = and1({ status: 'Failed' }, { createdAt: { gt: since } }, dayCond(p, 'createdAt'));
    if (p.text) and.push({ OR: [{ reason: { contains: p.text } }, { recordRef: { contains: p.text } }, { entity: { contains: p.text } }] });
    const { where, facets } = await dbFilters(p, and, [{ key: 'entity', label: 'What', ...byColumn('syncLog', 'entity', 'Not given') }]);
    const order = orderOf(p, { time: (d) => ({ createdAt: d }), entity: (d) => ({ entity: d }) }, 'time');
    const res = await dbPage(p, { count: () => prisma.syncLog.count({ where }), findMany: ({ skip, take }) => prisma.syncLog.findMany({ where, orderBy: order, skip, take }) });
    return {
      title: 'ATS data sync failures', sub: 'Job-portal and requirement sync failures since the last good sync.', ...res, facets, dateField: 'When',
      columns: [col('time', 'When', 'datetime', 'time'), col('entity', 'What', 'text', 'entity'), col('ref', 'Record'), col('reason', 'Reason')],
      rows: res.rows.map((l) => ({ id: l.id, c: { time: l.createdAt, entity: l.entity, ref: l.recordRef || '-', reason: String(l.reason || '-').replace(/\s+/g, ' ').slice(0, 160) }, d: [field('Full reason', l.reason)] })),
    };
  },
  async portal(p) {
    const and = and1({ portalSyncStatus: 'Failed' }, dayCond(p, 'createdAt'));
    if (p.text) and.push({ OR: [{ title: { contains: p.text } }, { reqCode: { contains: p.text } }] });
    const { where, facets } = await dbFilters(p, and, [{ key: 'dept', label: 'Department', ...byColumn('requirement', 'department', 'No department') }]);
    const res = await dbPage(p, { count: () => prisma.requirement.count({ where }), findMany: ({ skip, take }) => prisma.requirement.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { client: { select: { name: true } } } }) });
    return { title: 'Requirements that failed to post', sub: 'Posted to the job portal but not accepted.', ...res, facets, dateField: 'Posted', columns: [col('code', 'Code'), col('title', 'Requirement'), col('client', 'Client'), col('status', 'Status', 'status'), col('created', 'Posted', 'date')], rows: res.rows.map((r) => ({ id: r.id, c: { code: r.reqCode || '-', title: r.title, client: (r.client && r.client.name) || '-', status: r.status, created: r.createdAt }, d: [] })) };
  },
  async integrations(p) {
    const rows = await prisma.integration.findMany({ select: { id: true, enabled: true, connected: true, state: true, recordsFailed: true, recordsSynced: true, error: true, lastSync: true, lastTest: true, lastTestResult: true } });
    const by = new Map(rows.map((r) => [r.id, r]));
    let list = INTEGRATION_CATALOG.map((c) => {
      const r = by.get(c.id);
      const state = r ? r.state : 'Not Connected';
      const errored = !!r && (Number(r.recordsFailed) > 0 || /reconnect|expired/i.test(state) || !!r.error);
      return { id: c.id, name: c.name, group: c.group, state, status: errored ? 'Needs attention' : (state === 'Connected' ? 'Connected' : 'Not connected'), lastSync: r && r.lastSync, failed: r ? Number(r.recordsFailed) || 0 : 0, synced: r ? Number(r.recordsSynced) || 0 : 0, note: errored ? String((r && (r.error || r.lastTestResult)) || '').replace(/\s+/g, ' ').slice(0, 200) : '', lastTest: r && r.lastTest, lastTestResult: r && r.lastTestResult };
    });
    const f = p.filter || 'all';
    if (f !== 'all') list = list.filter((i) => i.status === f);
    if (p.text) { const t = p.text.toLowerCase(); list = list.filter((i) => `${i.name} ${i.group} ${i.note}`.toLowerCase().includes(t)); }
    list = list.filter((i) => dayIn(p, i.lastSync));
    const mf = memFilters(p, list, [
      { key: 'group', label: 'Group', val: (i) => i.group, lab: (i) => i.group },
      { key: 'status', label: 'Status', val: (i) => i.status, lab: (i) => i.status },
    ]);
    list = mf.rows;
    const rank = { 'Needs attention': 0, Connected: 1, 'Not connected': 2 };
    const res = memPage(list, p, (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
    return {
      title: 'Integrations', sub: 'Connection status, errors and last sync of every integration.', ...res, facets: mf.facets, dateField: 'Last sync',
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['all', 'All'], ['Needs attention', 'Needs attention'], ['Connected', 'Connected'], ['Not connected', 'Not connected']] }],
      columns: [col('name', 'Integration'), col('group', 'Group'), col('status', 'Status', 'status'), col('lastSync', 'Last sync', 'datetime'), col('failed', 'Failed records', 'num'), col('note', 'Problem')],
      rows: res.rows.map((i) => ({ id: i.id, c: { name: i.name, group: i.group || '-', status: i.status, lastSync: i.lastSync, failed: i.failed, note: i.note || '-' }, d: [field('Connection state', i.state), field('Records synced', i.synced), field('Last test', i.lastTest ? new Date(i.lastTest).toISOString().slice(0, 16).replace('T', ' ') : null), field('Last test result', i.lastTestResult ? String(i.lastTestResult).slice(0, 300) : null)] })),
    };
  },
  async cash(p) {
    const and = and1(dayCond(p, 'date', 'day'));
    if (/^\d{4}-\d{2}$/.test(p.month)) and.push({ date: { startsWith: p.month } });
    if (p.text) and.push({ OR: [{ reference: { contains: p.text } }, { method: { contains: p.text } }, { invoice: { is: { invoiceNumber: { contains: p.text } } } }, { invoice: { is: { client: { is: { name: { contains: p.text } } } } } }] });
    const { where, facets } = await dbFilters(p, and, [{ key: 'method', label: 'Method', ...byColumn('invoicePayment', 'method', 'Not given') }]);
    const order = orderOf(p, { date: (d) => ({ date: d }), amount: (d) => ({ amount: d }) }, 'date');
    const [res, agg] = await Promise.all([
      dbPage(p, { count: () => prisma.invoicePayment.count({ where }), findMany: ({ skip, take }) => prisma.invoicePayment.findMany({ where, orderBy: order, skip, take, include: { invoice: { select: { invoiceNumber: true, client: { select: { name: true } } } } } }) }),
      prisma.invoicePayment.aggregate({ where, _sum: { amount: true } }),
    ]);
    return {
      title: /^\d{4}-\d{2}$/.test(p.month) ? `Cash received in ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p.month.slice(5, 7)) - 1]} ${p.month.slice(0, 4)}` : 'Cash received', sub: `Money received from clients, by payment date. Total of this list: ₹${Math.round(Number(agg._sum.amount) || 0).toLocaleString('en-IN')}.`, ...res, facets, dateField: 'Paid on',
      columns: [col('date', 'Paid on', 'date', 'date'), col('invoice', 'Invoice'), col('client', 'Client'), col('amount', 'Amount', 'money', 'amount'), col('method', 'Method'), col('reference', 'Reference')],
      rows: res.rows.map((x) => ({ id: x.id, c: { date: x.date, invoice: (x.invoice && x.invoice.invoiceNumber) || '-', client: (x.invoice && x.invoice.client && x.invoice.client.name) || '-', amount: x.amount, method: x.method, reference: x.reference || '-' }, d: [field('Notes', x.notes), field('Recorded by', x.recordedBy)] })),
    };
  },
  async audit(p) {
    const and = and1(dayCond(p, 'createdAt'));
    if (p.text) and.push({ OR: [{ action: { contains: p.text } }, { entity: { contains: p.text } }, { actorName: { contains: p.text } }, { toValue: { contains: p.text } }] });
    const { where, facets } = await dbFilters(p, and, [{ key: 'entity', label: 'What', ...byColumn('auditLog', 'entity', 'Not given') }]);
    const res = await dbPage(p, { count: () => prisma.auditLog.count({ where }), findMany: ({ skip, take }) => prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { user: { select: { name: true } } } }) });
    // the row that was clicked on the dashboard is always in the list, even if it is older than the first page
    if (p.open && p.page === 1 && !res.rows.some((a) => a.id === p.open)) {
      const one = await prisma.auditLog.findUnique({ where: { id: p.open }, include: { user: { select: { name: true } } } }).catch(() => null);
      if (one) res.rows.unshift(one);
    }
    return {
      title: 'Recent activity', sub: 'The audit trail, newest first. Click a row for the full detail.', ...res, open: p.open || null, facets, dateField: 'Time',
      columns: [col('time', 'Time', 'datetime'), col('entity', 'What'), col('action', 'Event'), col('owner', 'By')],
      rows: res.rows.map((a) => ({ id: a.id, c: { time: a.createdAt, entity: a.entity, action: a.action, owner: a.actorName || (a.user && a.user.name) || 'System' }, d: [field('Record', a.entityId), field('Before', a.fromValue), field('After', a.toValue), field('Field', a.fieldLabel || a.field), field('Reason', a.reason), field('Approval', a.approvalStatus)] })),
    };
  },
  async nocontact(p) {
    const and = and1({ AND: [{ OR: [{ email: null }, { email: '' }] }, { OR: [{ phone: null }, { phone: '' }] }] }, dayCond(p, 'createdAt'));
    if (p.text) and.push({ name: { contains: p.text } });
    const { where, facets } = await dbFilters(p, and, [{ key: 'source', label: 'Source', ...byColumn('candidate', 'source', 'No source') }]);
    const res = await dbPage(p, { count: () => prisma.candidate.count({ where }), findMany: ({ skip, take }) => prisma.candidate.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }) });
    return { title: 'Candidates with no phone and no email', sub: 'They cannot be contacted until a phone or an email is added.', ...res, facets, dateField: 'Added', columns: [col('name', 'Candidate'), col('source', 'Source'), col('location', 'Location'), col('added', 'Added', 'date')], rows: res.rows.map((c) => ({ id: c.id, c: { name: c.name, source: c.source || '-', location: c.location || '-', added: c.createdAt }, d: [] })) };
  },
  async noemail(p) {
    const and = and1(withoutSystemAccounts({ employmentStatus: 'Active', OR: [{ email: null }, { email: '' }] }), dayCond(p, 'dateOfJoining'));
    if (p.text) and.push({ name: { contains: p.text } });
    const { where, facets } = await dbFilters(p, and, [{ key: 'dept', label: 'Department', ...byColumn('employee', 'department', 'No department') }]);
    const res = await dbPage(p, { count: () => prisma.employee.count({ where }), findMany: ({ skip, take }) => prisma.employee.findMany({ where, orderBy: { name: 'asc' }, skip, take }) });
    return { title: 'Active employees without an official email', sub: '', ...res, facets, dateField: 'Joined on', columns: [col('code', 'Code'), col('name', 'Name'), col('department', 'Department')], rows: res.rows.map((e) => ({ id: e.id, c: { code: e.employeeCode, name: e.name, department: e.department || '-' }, d: [] })) };
  },
};
function pendingFilter(f) {
  return [{ key: 'filter', label: 'Show', value: f, options: [['all', 'All ATS actions'], ['review', 'Being checked'], ['client', 'With client'], ['feedback', 'Interview feedback'], ['joining', 'Joining confirmation'], ['leave', 'Leave requests']] }];
}

const NAMES = Object.keys(SETS);
async function list(query) {
  const set = str(query.set);
  if (!SETS[set]) { const e = new Error('Unknown list'); e.status = 404; throw e; }
  const p = params(query);
  const out = await SETS[set](p);
  return {
    set, q: p.text, filter: p.filter, sort: p.sort || null, dir: p.dir, pageSize: p.pageSize, filters: [], facets: [], dateField: null, picked: p.multi, dFrom: p.dFrom || null, dTo: p.dTo || null, ...out,
  };
}
module.exports = { list, NAMES };
