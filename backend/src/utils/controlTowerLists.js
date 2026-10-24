// ---------------------------------------------------------------------------
// THE CONTROL TOWER'S DETAIL LISTS (founder, 2026-10-23): "whatever is clicked opens its details ON THE DASHBOARD - no other page, no route change".
// One endpoint (GET /api/dashboard/control-tower/list?set=<name>&q=&filter=&sort=&dir=&page=&pageSize=) feeds the side drawer for every figure,
// pipeline step, chart month, attention row, integration, data-health check and activity row. Real records only, read-only, server-side search /
// sorting / paging, one row = { id, c: { <column key>: value }, d: [[label, value], ...] } where `d` is what the row shows when it is expanded.
// Company-wide, so the route only lets Super Admin / Admin in (routes/dashboard.js). The sets use the SAME definitions as the figures
// (utils/controlTower.js): live requirement statuses, active = not Rejected / On hold / Joined, the ATS pending stages, the invoice maths.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { REQUIREMENT_LIVE_STATUSES, stageLabel } = require('./atsVocab');
const A = require('./accounts');
const CNU = require('./creditNotes');
const { withoutSystemAccounts } = require('./systemAccounts');
const { INTEGRATION_CATALOG } = require('./adminCatalog');
const PV = require('./pipelineView');

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

function params(q) {
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const page = Math.max(1, Number(q.page) || 1);
  return { text: str(q.q), filter: str(q.filter), sort: str(q.sort), dir: str(q.dir) === 'asc' ? 'asc' : 'desc', page, pageSize, month: str(q.month), stage: str(q.stage), open: str(q.open), id: str(q.id) };
}
const col = (key, label, type = 'text', sort = null) => ({ key, label, type, sort: sort || null });
const field = (label, value) => [label, value === undefined || value === null || value === '' ? null : value];

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
    c: { candidate: c.name || '-', stage: stageLabel(a.stage) || a.stage, requirement: r.title || '-', client: (r.client && r.client.name) || '-', added: a.createdAt, updated: a.updatedAt },
    d: [field('Requirement code', r.reqCode), field('Department', r.department), field('Source', a.source || c.source), field('Location', c.location), field('Email', c.email), field('Phone', c.phone),
      field('Interview', a.interviewAt ? new Date(a.interviewAt).toISOString().slice(0, 16).replace('T', ' ') : null)],
  };
}
const APP_COLS = [col('candidate', 'Candidate', 'text', 'candidate'), col('stage', 'Step', 'status', 'stage'), col('requirement', 'Requirement', 'text', 'requirement'), col('client', 'Client'), col('added', 'Added', 'date', 'added')];
async function apps(p, stages, { notIn } = {}) {
  const and = [stages ? { stage: { in: stages } } : { stage: { notIn: notIn || TERMINAL } }];
  if (p.text) and.push({ OR: [{ candidate: { is: { name: { contains: p.text } } } }, { candidate: { is: { email: { contains: p.text } } } }, { candidate: { is: { phone: { contains: p.text } } } }, { requirement: { is: { title: { contains: p.text } } } }, { requirement: { is: { reqCode: { contains: p.text } } } }, { requirement: { is: { client: { is: { name: { contains: p.text } } } } } }] });
  const where = { AND: and };
  const order = orderOf(p, {
    candidate: (d) => ({ candidate: { name: d } }), stage: (d) => ({ stage: d }), requirement: (d) => ({ requirement: { title: d } }), added: (d) => ({ createdAt: d }), updated: (d) => ({ updatedAt: d }),
  }, 'added');
  const res = await dbPage(p, {
    count: () => prisma.application.count({ where }),
    findMany: ({ skip, take }) => prisma.application.findMany({ where, orderBy: order, skip, take, include: { candidate: { select: { name: true, email: true, phone: true, source: true, location: true } }, requirement: { select: { title: true, reqCode: true, department: true, client: { select: { name: true } } } } } }),
  });
  return { ...res, rows: res.rows.map(appRow), columns: APP_COLS };
}

// ---- the sets ----
const SETS = {
  async employees(p) {
    const f = p.filter || 'Active';
    const status = f === 'former' ? { in: ['Relieved', 'Exited'] } : f === 'all' ? undefined : f;
    const base = status === undefined ? {} : { employmentStatus: status };
    const where = withoutSystemAccounts(base);
    const and = [where];
    if (p.text) and.push({ OR: [{ name: { contains: p.text } }, { employeeCode: { contains: p.text } }, { department: { contains: p.text } }, { designation: { contains: p.text } }, { email: { contains: p.text } }] });
    const order = orderOf(p, { name: (d) => ({ name: d }), code: (d) => ({ employeeCode: d }), department: (d) => ({ department: d }), designation: (d) => ({ designation: d }) }, 'name');
    const res = await dbPage(p, { count: () => prisma.employee.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.employee.findMany({ where: { AND: and }, orderBy: order, skip, take }) });
    return {
      title: 'Employees', sub: 'People who work here now. Pick Notice period or Former to see the others.', ...res,
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['Active', 'Active'], ['Notice Period', 'On notice period'], ['former', 'Former (relieved / exited)'], ['all', 'Everyone']] }],
      columns: [col('code', 'Code', 'text', 'code'), col('name', 'Name', 'text', 'name'), col('department', 'Department', 'text', 'department'), col('designation', 'Designation', 'text', 'designation'), col('status', 'Status', 'status')],
      rows: res.rows.map((e) => ({ id: e.id, c: { code: e.employeeCode, name: e.name, department: e.department || '-', designation: e.designation || '-', status: e.employmentStatus }, d: [field('Official email', e.email), field('Phone', e.phone), field('Team', e.team), field('Team lead', e.tl), field('Reporting manager', e.reportingManager), field('Branch', e.branch)] })),
    };
  },
  async requirements(p) {
    const f = p.filter || 'live';
    const status = f === 'live' ? { in: REQUIREMENT_LIVE_STATUSES } : f === 'hold' ? 'ON_HOLD' : f === 'closed' ? 'CLOSED' : undefined;
    const and = [status === undefined ? {} : { status }];
    if (p.text) and.push({ OR: [{ title: { contains: p.text } }, { reqCode: { contains: p.text } }, { department: { contains: p.text } }, { client: { is: { name: { contains: p.text } } } }] });
    const order = orderOf(p, { created: (d) => ({ createdAt: d }), title: (d) => ({ title: d }), code: (d) => ({ reqCode: d }), department: (d) => ({ department: d }), status: (d) => ({ status: d }) }, 'created');
    const res = await dbPage(p, { count: () => prisma.requirement.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.requirement.findMany({ where: { AND: and }, orderBy: order, skip, take, include: { client: { select: { name: true } }, recruiter: { select: { name: true } } } }) });
    return {
      title: 'Requirements', sub: 'Open = still being worked on (not Closed, not On hold).', ...res,
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
    const r = await apps(p, PENDING_TYPES.feedback);
    return { title: 'Interview feedback pending', sub: 'Interviews done, feedback not yet recorded.', ...r };
  },
  async pending(p) {
    const f = p.filter || 'all';
    if (f === 'leave') return { ...(await SETS.leave(p)), filters: pendingFilter(f) };
    const stages = PENDING_TYPES[f] || PENDING_STAGES;
    const r = await apps(p, stages);
    return { title: 'Pending actions', sub: 'ATS applications waiting for someone to act, plus leave requests (pick Leave requests).', ...r, filters: pendingFilter(f) };
  },
  async leave(p) {
    const and = [{ status: 'Pending' }];
    if (p.text) and.push({ OR: [{ employee: { is: { name: { contains: p.text } } } }, { employee: { is: { department: { contains: p.text } } } }, { type: { contains: p.text } }, { reason: { contains: p.text } }] });
    const order = orderOf(p, { created: (d) => ({ createdAt: d }), from: (d) => ({ fromDate: d }), employee: (d) => ({ employee: { name: d } }) }, 'created');
    const res = await dbPage(p, { count: () => prisma.leaveRequest.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.leaveRequest.findMany({ where: { AND: and }, orderBy: order, skip, take, include: { employee: { select: { name: true, department: true, employeeCode: true } } } }) });
    return {
      title: 'Leave requests awaiting decision', sub: 'Employee and team-lead leave requests still pending.', ...res,
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
    const key = { due: (i) => String(i.dueDate || '9999'), invoice: (i) => String(i.invoiceNumber || ''), client: (i) => String((i.client && i.client.name) || ''), outstanding: (i) => A.invoiceOutstanding(i), date: (i) => String(i.invoiceDate || '') };
    const k = key[p.sort] ? p.sort : 'due';
    const dir = p.sort ? (p.dir === 'asc' ? 1 : -1) : 1;
    const res = memPage(rows, p, (a, b) => { const x = key[k](a); const y = key[k](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const sum = ROUND(rows.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
    const over = rows.filter((i) => A.invoiceOutstanding(i) < -0.5);
    const overSum = ROUND(over.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
    return {
      title: 'Outstanding receivables', sub: `Money clients still owe us (after credit notes): ${rows.length} invoices, net ₹${Math.round(sum).toLocaleString('en-IN')}${over.length ? `, after ${over.length} overpaid invoice${over.length === 1 ? '' : 's'} (₹${Math.abs(Math.round(overSum)).toLocaleString('en-IN')} to give back)` : ''}. Vendor bills we owe are separate.`, ...res,
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
    const key = { due: (b) => String(b.dueDate || ''), vendor: (b) => String(b.vendor || ''), amount: (b) => Number(b.monthlyAmount) || 0 };
    const k = key[p.sort] ? p.sort : 'due'; const dir = p.sort ? (p.dir === 'asc' ? 1 : -1) : 1;
    const res = memPage(rows, p, (a, b) => { const x = key[k](a); const y = key[k](b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return {
      title: 'Overdue vendor bills', sub: 'Money we owe vendors, unpaid and past the due date.', ...res,
      columns: [col('code', 'Ref'), col('vendor', 'Vendor', 'text', 'vendor'), col('bill', 'Bill no.'), col('category', 'Category'), col('due', 'Due', 'date', 'due'), col('late', 'Days late', 'num'), col('amount', 'Amount (after TDS)', 'money', 'amount')],
      rows: res.rows.map((b) => ({ id: b.id, c: { code: b.expenseCode || '-', vendor: b.vendor || '-', bill: b.billNumber || '-', category: b.category, due: b.dueDate, late: Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${b.dueDate}T00:00:00Z`)) / DAY)), amount: ROUND(Number(b.monthlyAmount) - Number(b.tdsAmount || 0)) }, d: [field('Description', b.description), field('GST', b.gstAmount ? `₹${Math.round(b.gstAmount).toLocaleString('en-IN')}` : null), field('Vendor linked by id', b.vendorId ? 'Yes' : 'No')] })),
    };
  },
  async bank(p) {
    const and = [{ reconStatus: 'Unmatched' }];
    if (p.text) and.push({ OR: [{ description: { contains: p.text } }, { reference: { contains: p.text } }] });
    const order = orderOf(p, { date: (d) => ({ date: d }), amount: (d) => ({ amount: d }), description: (d) => ({ description: d }) }, 'date');
    const res = await dbPage(p, { count: () => prisma.bankTransaction.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.bankTransaction.findMany({ where: { AND: and }, orderBy: order, skip, take }) });
    return {
      title: 'Unmatched bank transactions', sub: 'Bank statement lines not yet matched to an invoice or a bill.', ...res,
      columns: [col('date', 'Date', 'date', 'date'), col('description', 'Description', 'text', 'description'), col('type', 'Type'), col('amount', 'Amount', 'money', 'amount'), col('reference', 'Reference')],
      rows: res.rows.map((t) => ({ id: t.id, c: { date: t.date, description: t.description, type: t.type, amount: t.amount, reference: t.reference || '-' }, d: [field('Balance', t.balance != null ? `₹${Math.round(t.balance).toLocaleString('en-IN')}` : null), field('Import batch', t.importBatch)] })),
    };
  },
  async sync(p) {
    const since = new Date(Date.now() - 30 * DAY);
    const and = [{ status: 'Failed' }, { createdAt: { gte: since } }];
    if (p.text) and.push({ OR: [{ reason: { contains: p.text } }, { recordRef: { contains: p.text } }, { entity: { contains: p.text } }] });
    const order = orderOf(p, { time: (d) => ({ createdAt: d }), entity: (d) => ({ entity: d }) }, 'time');
    const res = await dbPage(p, { count: () => prisma.syncLog.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.syncLog.findMany({ where: { AND: and }, orderBy: order, skip, take }) });
    return {
      title: 'ATS data sync failures', sub: 'Job-portal and requirement sync failures in the last 30 days.', ...res,
      columns: [col('time', 'When', 'datetime', 'time'), col('entity', 'What', 'text', 'entity'), col('ref', 'Record'), col('reason', 'Reason')],
      rows: res.rows.map((l) => ({ id: l.id, c: { time: l.createdAt, entity: l.entity, ref: l.recordRef || '-', reason: String(l.reason || '-').replace(/\s+/g, ' ').slice(0, 160) }, d: [field('Full reason', l.reason)] })),
    };
  },
  async portal(p) {
    const and = [{ portalSyncStatus: 'Failed' }];
    if (p.text) and.push({ OR: [{ title: { contains: p.text } }, { reqCode: { contains: p.text } }] });
    const res = await dbPage(p, { count: () => prisma.requirement.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.requirement.findMany({ where: { AND: and }, orderBy: { createdAt: 'desc' }, skip, take, include: { client: { select: { name: true } } } }) });
    return { title: 'Requirements that failed to post', sub: 'Posted to the job portal but not accepted.', ...res, columns: [col('code', 'Code'), col('title', 'Requirement'), col('client', 'Client'), col('status', 'Status', 'status'), col('created', 'Posted', 'date')], rows: res.rows.map((r) => ({ id: r.id, c: { code: r.reqCode || '-', title: r.title, client: (r.client && r.client.name) || '-', status: r.status, created: r.createdAt }, d: [] })) };
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
    const rank = { 'Needs attention': 0, Connected: 1, 'Not connected': 2 };
    const res = memPage(list, p, (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
    return {
      title: 'Integrations', sub: 'Connection status, errors and last sync of every integration.', ...res,
      filters: [{ key: 'filter', label: 'Show', value: f, options: [['all', 'All'], ['Needs attention', 'Needs attention'], ['Connected', 'Connected'], ['Not connected', 'Not connected']] }],
      columns: [col('name', 'Integration'), col('group', 'Group'), col('status', 'Status', 'status'), col('lastSync', 'Last sync', 'datetime'), col('failed', 'Failed records', 'num'), col('note', 'Problem')],
      rows: res.rows.map((i) => ({ id: i.id, c: { name: i.name, group: i.group || '-', status: i.status, lastSync: i.lastSync, failed: i.failed, note: i.note || '-' }, d: [field('Connection state', i.state), field('Records synced', i.synced), field('Last test', i.lastTest ? new Date(i.lastTest).toISOString().slice(0, 16).replace('T', ' ') : null), field('Last test result', i.lastTestResult ? String(i.lastTestResult).slice(0, 300) : null)] })),
    };
  },
  async cash(p) {
    const and = [];
    if (/^\d{4}-\d{2}$/.test(p.month)) and.push({ date: { startsWith: p.month } });
    if (p.text) and.push({ OR: [{ reference: { contains: p.text } }, { method: { contains: p.text } }, { invoice: { is: { invoiceNumber: { contains: p.text } } } }, { invoice: { is: { client: { is: { name: { contains: p.text } } } } } }] });
    const where = and.length ? { AND: and } : {};
    const order = orderOf(p, { date: (d) => ({ date: d }), amount: (d) => ({ amount: d }) }, 'date');
    const [res, agg] = await Promise.all([
      dbPage(p, { count: () => prisma.invoicePayment.count({ where }), findMany: ({ skip, take }) => prisma.invoicePayment.findMany({ where, orderBy: order, skip, take, include: { invoice: { select: { invoiceNumber: true, client: { select: { name: true } } } } } }) }),
      prisma.invoicePayment.aggregate({ where, _sum: { amount: true } }),
    ]);
    return {
      title: /^\d{4}-\d{2}$/.test(p.month) ? `Cash received in ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(p.month.slice(5, 7)) - 1]} ${p.month.slice(0, 4)}` : 'Cash received', sub: `Money received from clients, by payment date. Total of this list: ₹${Math.round(Number(agg._sum.amount) || 0).toLocaleString('en-IN')}.`, ...res,
      columns: [col('date', 'Paid on', 'date', 'date'), col('invoice', 'Invoice'), col('client', 'Client'), col('amount', 'Amount', 'money', 'amount'), col('method', 'Method'), col('reference', 'Reference')],
      rows: res.rows.map((x) => ({ id: x.id, c: { date: x.date, invoice: (x.invoice && x.invoice.invoiceNumber) || '-', client: (x.invoice && x.invoice.client && x.invoice.client.name) || '-', amount: x.amount, method: x.method, reference: x.reference || '-' }, d: [field('Notes', x.notes), field('Recorded by', x.recordedBy)] })),
    };
  },
  async audit(p) {
    const and = [];
    if (p.text) and.push({ OR: [{ action: { contains: p.text } }, { entity: { contains: p.text } }, { actorName: { contains: p.text } }, { toValue: { contains: p.text } }] });
    const where = and.length ? { AND: and } : {};
    const res = await dbPage(p, { count: () => prisma.auditLog.count({ where }), findMany: ({ skip, take }) => prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { user: { select: { name: true } } } }) });
    // the row that was clicked on the dashboard is always in the list, even if it is older than the first page
    if (p.open && p.page === 1 && !res.rows.some((a) => a.id === p.open)) {
      const one = await prisma.auditLog.findUnique({ where: { id: p.open }, include: { user: { select: { name: true } } } }).catch(() => null);
      if (one) res.rows.unshift(one);
    }
    return {
      title: 'Recent activity', sub: 'The audit trail, newest first. Click a row for the full detail.', ...res, open: p.open || null,
      columns: [col('time', 'Time', 'datetime'), col('entity', 'What'), col('action', 'Event'), col('owner', 'By')],
      rows: res.rows.map((a) => ({ id: a.id, c: { time: a.createdAt, entity: a.entity, action: a.action, owner: a.actorName || (a.user && a.user.name) || 'System' }, d: [field('Record', a.entityId), field('Before', a.fromValue), field('After', a.toValue), field('Field', a.fieldLabel || a.field), field('Reason', a.reason), field('Approval', a.approvalStatus)] })),
    };
  },
  async nocontact(p) {
    const and = [{ AND: [{ OR: [{ email: null }, { email: '' }] }, { OR: [{ phone: null }, { phone: '' }] }] }];
    if (p.text) and.push({ name: { contains: p.text } });
    const res = await dbPage(p, { count: () => prisma.candidate.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.candidate.findMany({ where: { AND: and }, orderBy: { createdAt: 'desc' }, skip, take }) });
    return { title: 'Candidates with no phone and no email', sub: 'They cannot be contacted until a phone or an email is added.', ...res, columns: [col('name', 'Candidate'), col('source', 'Source'), col('location', 'Location'), col('added', 'Added', 'date')], rows: res.rows.map((c) => ({ id: c.id, c: { name: c.name, source: c.source || '-', location: c.location || '-', added: c.createdAt }, d: [] })) };
  },
  async noemail(p) {
    const and = [withoutSystemAccounts({ employmentStatus: 'Active', OR: [{ email: null }, { email: '' }] })];
    if (p.text) and.push({ name: { contains: p.text } });
    const res = await dbPage(p, { count: () => prisma.employee.count({ where: { AND: and } }), findMany: ({ skip, take }) => prisma.employee.findMany({ where: { AND: and }, orderBy: { name: 'asc' }, skip, take }) });
    return { title: 'Active employees without an official email', sub: '', ...res, columns: [col('code', 'Code'), col('name', 'Name'), col('department', 'Department')], rows: res.rows.map((e) => ({ id: e.id, c: { code: e.employeeCode, name: e.name, department: e.department || '-' }, d: [] })) };
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
  return { set, q: p.text, filter: p.filter, sort: p.sort || null, dir: p.dir, pageSize: p.pageSize, filters: [], ...out };
}
module.exports = { list, NAMES };
