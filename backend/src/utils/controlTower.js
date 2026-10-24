// ---------------------------------------------------------------------------
// THE 360° CONTROL TOWER (founder, 2026-10-23) - the Super Admin / Admin home: company health, what needs action now, hiring pipeline, cash,
// system and data health, recent critical activity - on ONE call (GET /api/dashboard/control-tower).
//
// RULES THIS FILE KEEPS (from the founder's research note):
//   * every figure carries its SCOPE word: "Now" (a snapshot), "All time", "Last 30 days", "Last 6 months" - nothing is silently date-filtered;
//   * every figure carries a one-line DEFINITION, so two screens cannot quietly mean two things;
//   * "Employees" counts the people who work here now (Active), never the former ones; Relieved / Exited are shown apart;
//   * client money owed to us (receivables) and vendor bills we owe (payables) are separate figures, each with its own overdue;
//   * the data-health line is a list of real checks (each with its count and a link), not an invented percentage;
//   * nothing is estimated: no sparkline, trend or "92%" is drawn without data behind it.
// It REUSES the app's own definitions: REQUIREMENT_LIVE_STATUSES (atsVocab), the invoice maths (utils/accounts + creditNotes), the integration
// catalogue (adminCatalog), the pending-action stages of the ATS queues (routes/dashboard.js PENDING_QUEUES), withoutSystemAccounts.
// Read only. The caller (routes/dashboard.js) lets only Super Admin / Admin with Administration -> Users view in.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');
const A = require('./accounts');
const CNU = require('./creditNotes');
const { withoutSystemAccounts } = require('./systemAccounts');
const { INTEGRATION_CATALOG } = require('./adminCatalog');
const PV = require('./pipelineView');

const DAY = 86400000;
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const TERMINAL = ['REJECTED', 'HOLD', 'JOINED', 'HIRED'];
// the stages somebody has to act on (routes/dashboard.js PENDING_QUEUES, one list for the dashboard and the bell)
const PENDING_STAGES = ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'];

const AREA_OF = [
  [/vendor/i, 'Vendor'], [/^(user|role|login|session)/i, 'User'], [/employee|attendance|leave|payroll|helpdesk/i, 'HRMS'],
  [/candidate|requirement|application|interview|client|agreement/i, 'ATS'], [/invoice|bank|expense|office|payment|journal/i, 'Accounts'],
  [/integration|synclog|email|whatsapp|sms/i, 'Integrations'],
];
const areaOf = (entity, action) => { const s = `${entity || ''} ${action || ''}`; const hit = AREA_OF.find(([re]) => re.test(entity || '')) || AREA_OF.find(([re]) => re.test(s)); return hit ? hit[1] : (entity || 'System'); };
const CRITICAL = /role|permission|access|delete|remov|merge|import|password|status|approv|reject|login|user|scope|seat|position|lock|vendor|integration|agreement|backup|restore/i;

let memo = { at: 0, data: null };
const TTL_MS = 45000;

async function build() {
  if (memo.data && Date.now() - memo.at < TTL_MS) return memo.data;
  const now = new Date();
  const today = istDay(now);
  const since30 = new Date(now.getTime() - 30 * DAY);
  const sixMonthsAgo = (() => { const d = new Date(now.getTime() + 5.5 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 5); return d.toISOString().slice(0, 10); })();
  const todayStart = new Date(`${today}T00:00:00+05:30`);

  const [empActive, empGroups, signedToday, usersByStatus, reqLive, reqAll, activeAgg, stageGroups, candidatesAll, leavePending, invoiceRows, payRows, bankGroups,
    integrations, syncFailed, portalFailed, audit, vendorBills, noContact, empNoMail] = await Promise.all([
    prisma.employee.count({ where: withoutSystemAccounts({ employmentStatus: 'Active' }) }),
    prisma.employee.groupBy({ by: ['employmentStatus'], _count: { _all: true } }),
    prisma.user.count({ where: { lastLoginAt: { gte: todayStart }, internalAccount: false } }),
    prisma.user.groupBy({ by: ['status'], where: { internalAccount: false }, _count: { _all: true } }),
    prisma.requirement.count({ where: { status: { in: REQUIREMENT_LIVE_STATUSES } } }),
    prisma.requirement.count(),
    prisma.$queryRawUnsafe(`SELECT COUNT(*) AS apps, COUNT(DISTINCT candidateId) AS cands FROM Application WHERE stage NOT IN (${TERMINAL.map((s) => `'${s}'`).join(',')})`),
    prisma.application.groupBy({ by: ['stage'], _count: { _all: true } }),
    prisma.candidate.count(),
    prisma.leaveRequest.count({ where: { status: 'Pending' } }),
    prisma.invoice.findMany({ include: { client: { select: { name: true } } } }),
    prisma.invoicePayment.findMany({ where: { date: { gte: sixMonthsAgo } }, select: { date: true, amount: true } }),
    prisma.bankTransaction.groupBy({ by: ['reconStatus'], _count: { _all: true } }),
    prisma.integration.findMany({ select: { id: true, enabled: true, connected: true, state: true, recordsFailed: true, error: true, lastSync: true, lastTestResult: true } }),
    prisma.syncLog.count({ where: { status: 'Failed', createdAt: { gte: since30 } } }),
    prisma.requirement.count({ where: { portalSyncStatus: 'Failed' } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, action: true, entity: true, toValue: true, actorName: true, createdAt: true, user: { select: { name: true } } } }),
    prisma.officeExpense.findMany({ where: { entryKind: { not: 'hand' }, paidStatus: 'Unpaid', NOT: { approvalStatus: 'REJECTED' } }, select: { dueDate: true, monthlyAmount: true, tdsAmount: true } }),
    prisma.candidate.count({ where: { AND: [{ OR: [{ email: null }, { email: '' }] }, { OR: [{ phone: null }, { phone: '' }] }] } }),
    prisma.employee.count({ where: withoutSystemAccounts({ employmentStatus: 'Active', OR: [{ email: null }, { email: '' }] }) }),
  ]);

  // ---- people ----
  const empBy = Object.fromEntries(empGroups.map((g) => [g.employmentStatus, g._count._all]));
  const employeesTotal = empGroups.reduce((s, g) => s + g._count._all, 0);
  const notice = num(empBy['Notice Period']);
  const former = num(empBy.Relieved) + num(empBy.Exited);
  const usersActive = num((usersByStatus.find((g) => g.status === 'Active') || { _count: { _all: 0 } })._count._all);
  const usersTotal = usersByStatus.reduce((s, g) => s + g._count._all, 0);

  // ---- ATS ----
  const act = (activeAgg && activeAgg[0]) || { apps: 0, cands: 0 };
  const byStage = Object.fromEntries(stageGroups.map((g) => [g.stage, g._count._all]));
  const pendingAts = PENDING_STAGES.reduce((s, st) => s + num(byStage[st]), 0);
  const groupCount = (ids) => PV.STAGE_GROUPS.filter((g) => ids.includes(g.id)).reduce((s, g) => s + g.stages.reduce((t, st) => t + num(byStage[st]), 0), 0);
  const chain = [
    { key: 'screening', label: 'Being checked', count: groupCount(['new', 'ai_interview', 'recruiter_review', 'tl_review', 'bde_review']), to: '/candidates?view=pipeline&sub=active' },
    { key: 'client', label: 'With client', count: groupCount(['client_review']), to: '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW,CLIENT_SHORTLISTED' },
    { key: 'interview', label: 'Interview', count: groupCount(['interview']), to: '/candidates?stage=INTERVIEW_SCHEDULED,INTERVIEW_COMPLETED' },
    { key: 'selected', label: 'Selected / offer', count: groupCount(['selected', 'offer', 'joining']), to: '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED' },
    { key: 'joined', label: 'Joined', count: groupCount(['joined']), to: '/candidates?view=pipeline&sub=joined' },
  ];
  const chainTotal = chain.reduce((s, x) => s + x.count, 0);
  chain.forEach((x) => { x.set = 'pipeline'; x.stage = x.key; x.pct = chainTotal ? Math.round((x.count / chainTotal) * 1000) / 10 : 0; });

  // ---- money: client receivables (what clients owe us) ----
  await CNU.decorateNet(invoiceRows).catch(() => null);
  const live = invoiceRows.filter((i) => i.status !== 'Cancelled');
  const outstanding = ROUND(live.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
  const overdueInv = live.filter((i) => A.invoiceOutstanding(i) > 0.5 && i.dueDate && A.daysOverdue(i.dueDate) > 0);
  const overdueAmt = ROUND(overdueInv.reduce((s, i) => s + A.invoiceOutstanding(i), 0));
  const receivedAll = ROUND(invoiceRows.reduce((s, i) => s + num(i.receivedAmount), 0));
  // vendor payables (what we owe vendors) - bills still unpaid, past their due date
  const payDue = vendorBills.filter((b) => b.dueDate && String(b.dueDate) < today);
  const payDueAmt = ROUND(payDue.reduce((s, b) => s + (num(b.monthlyAmount) - num(b.tdsAmount)), 0));
  const payOpenAmt = ROUND(vendorBills.reduce((s, b) => s + (num(b.monthlyAmount) - num(b.tdsAmount)), 0));
  // cash received by month (the actual payment date), last 6 months
  const monthKeys = [];
  for (let i = 5; i >= 0; i -= 1) { const d = new Date(now.getTime() + 5.5 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); monthKeys.push(d.toISOString().slice(0, 7)); }
  const cashBy = new Map(monthKeys.map((k) => [k, 0]));
  payRows.forEach((p) => { const k = String(p.date || '').slice(0, 7); if (cashBy.has(k)) cashBy.set(k, cashBy.get(k) + num(p.amount)); });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = monthKeys.map((k) => ({ key: k, label: MON[Number(k.slice(5, 7)) - 1], amount: ROUND(cashBy.get(k)) }));

  // ---- bank ----
  const bank = Object.fromEntries(bankGroups.map((g) => [g.reconStatus, g._count._all]));
  const unmatched = num(bank.Unmatched);

  // ---- integrations ----
  const rowOf = new Map(integrations.map((r) => [r.id, r]));
  const chans = INTEGRATION_CATALOG.map((c) => {
    const r = rowOf.get(c.id);
    const state = r ? r.state : 'Not Connected';
    const errored = !!r && (num(r.recordsFailed) > 0 || /reconnect|expired/i.test(state) || !!r.error);
    return { id: c.id, name: c.name, state, errored, connected: state === 'Connected', note: errored ? String((r && (r.error || r.lastTestResult)) || 'Needs attention').replace(/\s+/g, ' ').slice(0, 90) : (c.desc ? String(c.desc).slice(0, 70) : '') };
  });
  const intErrors = chans.filter((c) => c.errored);
  const intConnected = chans.filter((c) => c.connected && !c.errored);
  const intNot = chans.filter((c) => !c.connected && !c.errored);
  const top = [...intErrors, ...intNot].slice(0, 4).map((c) => ({ set: 'integrations', id: c.id, name: c.name, state: c.errored ? 'Needs attention' : 'Not connected', note: c.note }));

  // ---- the attention queue ----
  const rows = [
    { key: 'sync', title: 'ATS data sync failures', sub: 'Job-portal and requirement sync failures', count: syncFailed, unit: 'failed / 30 days', scope: 'Last 30 days', to: '/admin/integrations?tab=jobportal', action: 'Review failures', owner: 'Admin', tone: 'red' },
    { key: 'portal', title: 'Requirements that failed to post', sub: 'Live requirements the job portal did not accept', count: portalFailed, unit: 'requirements', scope: 'Now', to: '/admin/integrations?tab=jobportal', action: 'Review', owner: 'Admin', tone: 'red' },
    { key: 'feedback', title: 'Interview feedback pending', sub: 'Interviews done, feedback not yet recorded', count: num(byStage.INTERVIEW_COMPLETED), unit: 'pending', scope: 'Now', to: '/candidates?stage=INTERVIEW_COMPLETED', action: 'Open queue', owner: 'Recruiters / Client managers', tone: 'amber' },
    { key: 'leave', title: 'Leave requests awaiting decision', sub: 'Employee / TL leave requests', count: leavePending, unit: 'pending', scope: 'Now', to: '/leave', action: 'Review requests', owner: 'HR / Team leads', tone: 'amber' },
    { key: 'bank', title: 'Unmatched bank transactions', sub: 'Bank statement lines not yet matched to an invoice or bill', count: unmatched, unit: 'lines', scope: 'Now', to: '/bank', action: 'Reconcile', owner: 'Accounts', tone: 'amber' },
    { key: 'overdue-inv', title: 'Overdue client invoices', sub: 'Money clients owe us, past the due date', count: overdueInv.length, unit: 'invoices', money: overdueAmt, scope: 'Now', to: '/invoices?status=Overdue', action: 'Open invoices', owner: 'Accounts', tone: 'red' },
    { key: 'overdue-bills', title: 'Overdue vendor bills', sub: 'Money we owe vendors, past the due date', count: payDue.length, unit: 'bills', money: payDueAmt, scope: 'Now', to: '/office', action: 'Open bills', owner: 'Accounts', tone: 'red' },
  ];

  // ---- data health: real checks ----
  const checks = [
    { key: 'sync', set: 'sync', label: 'Job-portal sync without failures (30 days)', ok: syncFailed === 0, detail: `${syncFailed} failed`, to: '/admin/integrations?tab=jobportal' },
    { key: 'integrations', set: 'integrations', filter: 'Needs attention', label: 'Integrations without errors', ok: intErrors.length === 0, detail: `${intErrors.length} with errors`, to: '/admin/integrations' },
    { key: 'portal', set: 'portal', label: 'Live requirements accepted by the job portal', ok: portalFailed === 0, detail: `${portalFailed} failed to post`, to: '/admin/integrations?tab=jobportal' },
    { key: 'bank', set: 'bank', label: 'Bank lines matched', ok: unmatched === 0, detail: `${unmatched} unmatched`, to: '/bank' },
    { key: 'inv', set: 'overdue-inv', label: 'No overdue client invoices', ok: overdueInv.length === 0, detail: `${overdueInv.length} overdue`, to: '/invoices?status=Overdue' },
    { key: 'cand', set: 'nocontact', label: 'Every candidate has a phone or an email', ok: noContact === 0, detail: `${noContact} with neither`, to: '/candidates?view=master' },
    { key: 'emp', set: 'noemail', label: 'Every active employee has an official email', ok: empNoMail === 0, detail: `${empNoMail} without`, to: '/employees' },
  ];
  const passing = checks.filter((c) => c.ok).length;

  // ---- recent critical activity ----
  const crit = audit.filter((a) => CRITICAL.test(`${a.action} ${a.entity}`));
  const activity = (crit.length >= 6 ? crit : audit).slice(0, 8).map((a) => ({
    id: a.id, at: a.createdAt, area: areaOf(a.entity, a.action), event: `${a.action}${a.toValue ? ` · ${String(a.toValue).slice(0, 70)}` : ''}`, owner: a.actorName || (a.user && a.user.name) || 'System',
  }));

  const needing = rows.filter((r) => r.count > 0).length;
  const data = {
    generatedAt: now.toISOString(),
    today,
    needsAttention: needing,
    kpis: [
      {
        key: 'employees', set: 'employees', label: 'Employees (active)', value: empActive, scope: 'Now', to: '/employees?employmentStatus=Active',
        sub: `${notice} on notice · ${former.toLocaleString('en-IN')} former`,
        definition: 'People who work here now (status Active; the Super Admin login is not counted). Former employees (Relieved, Exited) are not included.',
        extra: { total: employeesTotal, notice, former, signedToday, usersActive, usersTotal },
      },
      {
        key: 'requirements', set: 'requirements', label: 'Open requirements', value: reqLive, scope: 'Now', to: '/requirements?status=LIVE',
        sub: `of ${reqAll.toLocaleString('en-IN')} in all`,
        definition: 'Requirements still being worked on (not Closed and not On hold). The total counts every requirement ever created.',
      },
      {
        key: 'candidates', set: 'candidates', label: 'Active candidates', value: num(act.cands), scope: 'Now', to: '/candidates?view=pipeline&sub=active',
        sub: `${num(act.apps).toLocaleString('en-IN')} active applications · ${candidatesAll.toLocaleString('en-IN')} in the master`,
        definition: 'Different people with at least one application that is not Rejected, On hold or Joined. One person on two requirements counts once.',
      },
      {
        key: 'pending', set: 'pending', label: 'Pending actions', value: pendingAts + leavePending, scope: 'Now', to: '/candidates?view=pipeline&sub=active&quick=my_pending',
        sub: `${pendingAts.toLocaleString('en-IN')} in ATS · ${leavePending.toLocaleString('en-IN')} leave requests`,
        definition: 'ATS applications waiting for someone to act (review, client decision, interview feedback, joining confirmation) plus leave requests waiting for a decision.',
      },
      {
        key: 'receivables', set: 'receivables', label: 'Outstanding receivables', value: outstanding, money: true, scope: 'Now', to: '/accounts/dashboard',
        sub: overdueInv.length ? `${overdueInv.length} overdue · ₹${Math.round(overdueAmt).toLocaleString('en-IN')}` : '0 overdue',
        definition: 'Money clients still owe us on invoices (after credit notes, and net of any invoice a client has overpaid). It is separate from vendor bills we owe (see Needs attention).',
        extra: { overdueCount: overdueInv.length, overdueAmount: overdueAmt, payablesOpen: payOpenAmt, payablesOverdue: payDue.length, payablesOverdueAmount: payDueAmt },
      },
    ],
    attention: rows.map((r) => ({ ...r, set: r.key })),
    integrations: { set: 'integrations', connected: intConnected.length, errors: intErrors.length, notConnected: intNot.length, total: chans.length, top, to: '/admin/integrations', definition: 'Per integration: Connected, Error (failed records or an expired link) or Not connected. Open the Integrations page for the last sync and the fix.' },
    pipeline: { total: chainTotal, stages: chain, outside: { rejected: num(byStage.REJECTED), hold: num(byStage.HOLD) }, scope: 'Now', definition: 'Where applications are today (a snapshot), not how many reached each step. Rejected and On hold are outside the chain and shown apart.' },
    cash: { set: 'cash', receivedAllTime: receivedAll, months, scope: 'Last 6 months by payment date', definition: 'Money received from clients, by the date it was paid. The big figure is all time.', to: '/accounts/dashboard' },
    dataHealth: { passing, total: checks.length, checks },
    activity,
  };
  memo = { at: Date.now(), data };
  return data;
}

module.exports = { build };
