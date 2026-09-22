const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const {
  requirementWhere, applicationWhere, clientWhere, scopeOf,
} = require('../utils/scope');
const {
  STAGE_CODES, stageLabel, applicationDueDate, applicationIsOverdue,
  REQUIREMENT_LIVE_STATUSES,
} = require('../utils/atsVocab');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, txnState,
  dashRange, inRange, currentFy, monthLabel, daysOverdue, invoiceAge,
  periodOptions, PAY_STATUS, statusMatch,
} = require('../utils/accounts');
// followup_: the real follow-up record, replacing the stage-SLA stand-in that
// "Follow-ups Due" used to be computed from.
const { currentFollowUpsByApplication, escalateOverdue } = require('../utils/followups');

const router = express.Router();
router.use(requireAuth);

// A Client and a Candidate are outside this company. Anything company-wide —
// the audit trail below, internal vocabulary, other people's activity — stops
// here for them.
const EXTERNAL_ROLES = ['CLIENT', 'CANDIDATE'];
const externalLogin = (user) => EXTERNAL_ROLES.includes(user?.role) || EXTERNAL_ROLES.includes(user?.atsRole);

// The Accountant's own view: receivables, what needs chasing and what is still
// sitting unreconciled on the bank statement.
//
// GUARDED, because it was not. /invoices refuses a recruiter, an employee and
// a candidate — and this route served the same money (every invoice, every
// bank line, every office expense) to all three with a 200. Same two guards
// routes/invoices.js uses, so one answer cannot contradict the other.
router.get(
  '/accounts',
  requireProduct('accounts'),
  requirePerm('accounts', 'accounts', 'Accounts Dashboard', 'view'),
  async (req, res) => {
  const [invoices, transactions, expenses] = await Promise.all([
    prisma.invoice.findMany({ include: { client: true, candidate: true, requirement: { include: { recruiter: true } } } }),
    prisma.bankTransaction.findMany({ orderBy: { date: 'desc' } }),
    prisma.officeExpense.findMany(),
  ]);

  // The period the whole page is for. The financial year runs April to March
  // and rolls over on its own; every money column below respects it.
  const range = dashRange(req.query.period);
  const q = String(req.query.q || '').trim().toLowerCase();
  const scoped = invoices
    .filter((i) => range.all || inRange(i.invoiceDate, range))
    .filter((i) => !req.query.client || req.query.client === 'All' || i.client?.name === req.query.client)
    .filter((i) => !req.query.department || req.query.department === 'All' || i.client?.ownerDepartment === req.query.department)
    // "Received and Paid mean the same thing — the whole invoice is in."
    .filter((i) => statusMatch(deriveInvoiceStatus(i), req.query.status))
    .filter((i) => !q || [i.invoiceNumber, i.client?.name, i.client?.gst].join(' ').toLowerCase().includes(q));
  const scopedExpenses = expenses.filter((e) => range.all || inRange(e.expenseDate, range));
  const live = scoped.filter((i) => deriveInvoiceStatus(i) !== 'Cancelled');

  const sum = (list, f) => ROUND(list.reduce((s, x) => s + f(x), 0));
  const billing = sum(live, (i) => Number(i.amount || 0));
  const gst = sum(live, (i) => Number(i.gst || 0));
  const tds = sum(live, (i) => Number(i.tds || 0));
  const invoiceValue = ROUND(billing + gst);
  const receivable = sum(live, invoiceTotal);
  const received = sum(live, (i) => Number(i.receivedAmount || 0));
  const pending = ROUND(receivable - received);
  const expenseNet = sum(scopedExpenses, (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
  const expensePending = sum(scopedExpenses.filter((e) => e.paidStatus === 'Unpaid'), (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
  const expensePaid = ROUND(expenseNet - expensePending);
  const gstInput = sum(scopedExpenses, (e) => Number(e.gstAmount || 0));
  const gstReceived = sum(live, (i) => {
    const total = invoiceTotal(i);
    const share = total > 0 ? Number(i.receivedAmount || 0) / total : 0;
    return Number(i.gst || 0) * Math.min(1, share);
  });
  const overdueInvoices = live.filter((i) => invoiceOutstanding(i) > 0.5 && i.dueDate && daysOverdue(i.dueDate) > 0);

  // Every receipt against the invoices in this period, newest first — the
  // month's cash column, each client's last payment and its instalment count
  // are all read off this one list.
  const payments = await prisma.invoicePayment.findMany({
    where: { invoiceId: { in: live.map((i) => i.id) } },
    orderBy: { date: 'desc' },
  });
  const paysByInvoice = new Map();
  payments.forEach((p) => {
    if (!paysByInvoice.has(p.invoiceId)) paysByInvoice.set(p.invoiceId, []);
    paysByInvoice.get(p.invoiceId).push(p);
  });

  // Month-by-month, and client-by-client, inside the period.
  const monthKeys =[...new Set(live.map((i) => String(i.invoiceDate || '').slice(0, 7)).filter(Boolean))].sort();
  const byMonth = monthKeys.map((mk) => {
    const list = live.filter((i) => String(i.invoiceDate || '').slice(0, 7) === mk);
    const exp = scopedExpenses.filter((e) => String(e.expenseDate || '').slice(0, 7) === mk);
    const b = sum(list, (i) => Number(i.amount || 0));
    const sp = sum(exp, (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
    const gstM = sum(list, (i) => Number(i.gst || 0));
    const tdsM = sum(list, (i) => Number(i.tds || 0));
    // "Received" is grouped by invoice month; "Cash collected" is grouped by
    // the actual payment date — same as the workbook.
    const cash = ROUND(payments.filter((p) => String(p.date || '').slice(0, 7) === mk)
      .reduce((s, p) => s + Number(p.amount || 0), 0));
    return {
      month: mk,
      label: monthLabel(mk),
      invoices: list.length,
      joins: list.length,
      drops: 0,
      billing: b,
      gst: gstM,
      invoiceValue: ROUND(b + gstM),
      tds: tdsM,
      receivable: sum(list, invoiceTotal),
      received: sum(list, (i) => Number(i.receivedAmount || 0)),
      pending: ROUND(sum(list, invoiceTotal) - sum(list, (i) => Number(i.receivedAmount || 0))),
      netProfit: ROUND(b - tdsM),
      cash,
      spend: sp,
      profit: ROUND(b - sp),
    };
  });

  // "Pending & received, client by client" — before GST, after GST, receivable,
  // received, pending, what share is collected, and when they last paid.
  const clientMap = new Map();
  live.forEach((i) => {
    const k = i.client?.name || '—';
    const cur = clientMap.get(k) || {
      client: k, department: i.client?.ownerDepartment || '—', invoices: 0,
      billing: 0, gst: 0, invoiceValue: 0, tds: 0, receivable: 0, received: 0, pending: 0,
      parts: 0, noProof: 0, lastPayment: null,
    };
    cur.invoices += 1;
    cur.billing = ROUND(cur.billing + Number(i.amount || 0));
    cur.gst = ROUND(cur.gst + Number(i.gst || 0));
    cur.invoiceValue = ROUND(cur.billing + cur.gst);
    cur.tds = ROUND(cur.tds + Number(i.tds || 0));
    cur.receivable = ROUND(cur.receivable + invoiceTotal(i));
    cur.received = ROUND(cur.received + Number(i.receivedAmount || 0));
    cur.pending = ROUND(cur.receivable - cur.received);
    (paysByInvoice.get(i.id) || []).forEach((p) => {
      cur.parts += 1;
      if (!p.reference) cur.noProof += 1;
      if (!cur.lastPayment || String(p.date) > cur.lastPayment) cur.lastPayment = p.date;
    });
    clientMap.set(k, cur);
  });
  const byClient = [...clientMap.values()].map((c) => ({
    ...c,
    collectedPct: c.receivable > 0 ? Math.round((c.received / c.receivable) * 100) : 0,
    settled: c.pending <= 0.5,
  }));

  // "Client × month pending" — the pending matrix, month columns being the
  // invoice months. Only what is still owed appears.
  const owing = live.filter((i) => invoiceOutstanding(i) > 0.5);
  const matrixMonths = [...new Set(owing.map((i) => String(i.invoiceDate || '').slice(0, 7)).filter(Boolean))].sort();
  const matrixMap = new Map();
  owing.forEach((i) => {
    const k = i.client?.name || '—';
    const cur = matrixMap.get(k) || {
      client: k, department: i.client?.ownerDepartment || '—', recruiters: {},
      billing: 0, gst: 0, invoiceValue: 0, tds: 0, receivable: 0, paid: 0, parts: 0, total: 0, cells: {}, oldest: 0,
    };
    const mk = String(i.invoiceDate || '').slice(0, 7);
    const out = invoiceOutstanding(i);
    cur.billing = ROUND(cur.billing + Number(i.amount || 0));
    cur.gst = ROUND(cur.gst + Number(i.gst || 0));
    cur.invoiceValue = ROUND(cur.billing + cur.gst);
    cur.tds = ROUND(cur.tds + Number(i.tds || 0));
    cur.receivable = ROUND(cur.receivable + invoiceTotal(i));
    cur.paid = ROUND(cur.paid + Number(i.receivedAmount || 0));
    cur.parts += (paysByInvoice.get(i.id) || []).length;
    cur.cells[mk] = ROUND((cur.cells[mk] || 0) + out);
    cur.total = ROUND(cur.total + out);
    const age = daysOverdue(i.dueDate);
    if (age != null && age > cur.oldest) cur.oldest = age;
    matrixMap.set(k, cur);
  });
  const pendingMatrix = [...matrixMap.values()].sort((a, b) => b.total - a.total);
  const pendingRows = owing
    .map((i) => {
      const ps = paysByInvoice.get(i.id) || [];
      const last = ps[0] || null;
      return {
        id: i.id,
        candidate: i.candidate?.name || i.notes || '—',
        client: i.client?.name || '—',
        recruiter: i.requirement?.recruiter?.name || null,
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate,
        age: invoiceAge(i.invoiceDate),
        billing: ROUND(Number(i.amount || 0)),
        gst: ROUND(Number(i.gst || 0)),
        invoiceValue: ROUND(Number(i.amount || 0) + Number(i.gst || 0)),
        tds: ROUND(Number(i.tds || 0)),
        receivable: invoiceTotal(i),
        received: ROUND(Number(i.receivedAmount || 0)),
        pending: invoiceOutstanding(i),
        status: deriveInvoiceStatus(i),
        lastPaid: last ? { date: last.date, amount: last.amount, parts: ps.length, proof: !!last.reference } : null,
      };
    })
    .sort((a, b) => (b.age || 0) - (a.age || 0));

  const catMap = new Map();
  scopedExpenses.forEach((e) => {
    const k = e.category || '—';
    const net = ROUND(Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
    const cur = catMap.get(k) || { category: k, count: 0, net: 0 };
    cur.count += 1; cur.net = ROUND(cur.net + net);
    catMap.set(k, cur);
  });

  const fyNow = currentFy();
  const rows = invoices.map((i) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    client: i.client?.name || '—',
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    status: deriveInvoiceStatus(i),
    total: invoiceTotal(i),
    outstanding: invoiceOutstanding(i),
  }));
  const needsAttention = rows
    .filter((i) => ['Overdue', 'Partially Paid', 'Pending'].includes(i.status))
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')))
    .slice(0, 8);
  const unreconciled = transactions.filter((t) => ['Unmatched', 'Matched'].includes(txnState(t)));

  res.json({
    period: { sel: req.query.period || `FY:${fyNow}`, ...range, options: periodOptions() },
    filterOptions: {
      clients: [...new Set(invoices.map((i) => i.client?.name).filter(Boolean))].sort(),
      clientsEver: new Set(invoices.map((i) => i.client?.name).filter(Boolean)).size,
      departments: [...new Set(invoices.map((i) => i.client?.ownerDepartment).filter(Boolean))].sort(),
      statuses: PAY_STATUS,
    },
    showing: { invoices: live.length, of: invoices.length },
    // The prototype's dashboard KPI strip, in its own words and its own order.
    money: {
      candidates: live.filter((i) => i.candidateId).length,
      invoiceCount: live.length,
      billing,
      invoiceValue,
      gst,
      tds,
      // Net profit is billing − TDS. GST collected is payable to Government,
      // so it is never counted as profit.
      profit: ROUND(billing - tds),
      receivable,
      received,
      pending,
      collectedPct: receivable > 0 ? Math.round((received / receivable) * 100) : 0,
      openRows: live.filter((i) => invoiceOutstanding(i) > 0.5).length,
      overdueInvoices: overdueInvoices.length,
      overdueValue: sum(overdueInvoices, invoiceOutstanding),
      expenseNet,
      expensePaid,
      expensePending,
      expenseCount: scopedExpenses.length,
      // The "Office expenses" tile is cash already out, and profit after
      // expenses nets off that same figure — money not yet paid is not spent.
      profitAfterExpenses: ROUND(billing - tds - expensePaid),
    },
    gstPosition: {
      charged: gst,
      collected: ROUND(gstReceived),
      stillToCome: ROUND(gst - gstReceived),
      paid: gstInput,
      payable: ROUND(gst - gstInput),
      collectedPct: gst > 0 ? Math.round((gstReceived / gst) * 100) : 0,
      unclaimableCount: scopedExpenses.filter((e) => Number(e.gstAmount || 0) > 0.5 && String(e.vendorGstin || '').trim().length < 10).length,
      unclaimableValue: sum(scopedExpenses.filter((e) => Number(e.gstAmount || 0) > 0.5 && String(e.vendorGstin || '').trim().length < 10), (e) => Number(e.gstAmount || 0)),
    },
    byMonth,
    byClient: byClient.sort((a, b) => b.pending - a.pending || b.received - a.received),
    // Client × month pending, and every open row oldest first. (The flat
    // `pending` count further down is the older Accountant home tile.)
    pendingMatrix: {
      months: matrixMonths,
      monthLabels: matrixMonths.map(monthLabel),
      clients: pendingMatrix,
      rows: pendingRows,
      total: ROUND(pendingMatrix.reduce((s, c) => s + c.total, 0)),
      openRows: pendingRows.length,
      oldest: pendingRows.length ? Math.max(0, ...pendingRows.map((r) => r.age || 0)) : null,
      largest: pendingMatrix[0] ? { client: pendingMatrix[0].client, total: pendingMatrix[0].total } : null,
    },
    spendByCategory: [...catMap.values()].sort((a, b) => b.net - a.net),
    invoices: rows.length,
    pending: rows.filter((i) => i.status === 'Pending').length,
    partiallyPaid: rows.filter((i) => i.status === 'Partially Paid').length,
    overdue: rows.filter((i) => i.status === 'Overdue').length,
    paid: rows.filter((i) => i.status === 'Paid').length,
    unreconciled: unreconciled.length,
    outstanding: ROUND(rows.filter((i) => i.status !== 'Cancelled').reduce((s, i) => s + i.outstanding, 0)),
    received: ROUND(invoices.reduce((s, i) => s + Number(i.receivedAmount || 0), 0)),
    needsAttention,
    unreconciledTransactions: unreconciled.slice(0, 8).map((t) => ({
      id: t.id, date: t.date, description: t.description, type: t.type, amount: t.amount, state: txnState(t),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/ats — the working ATS home.
//
// Deliberately NOT a KPI wall. Three things, in the order the work happens:
//   1. My Pending Actions — the queues actually waiting on THIS person
//   2. the action queue   — one row per item, every row carrying a next action
//   3. My Work            — flat counts for the viewer's ATS role
//
// Every number comes out of utils/scope.js, the same `where` fragments the
// lists behind them use, so a recruiter counts a recruiter's rows and a client
// only their own company's. There is no second scoping path here.
// ---------------------------------------------------------------------------

// The six queues. `owners` is the ATS role the next move belongs to (the
// owner column of utils/atsVocab STAGE_OWNER_ACTION); `to` is the list this
// queue opens, already filtered to exactly the stages counted here.
const PENDING_QUEUES = [
  {
    id: 'candidate-review',
    label: 'Candidate Review',
    stages: ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW'],
    owners: ['RECRUITER'],
    action: 'Review Candidate',
    to: '/candidates?stage=NEW,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW',
  },
  {
    id: 'tl-review',
    label: 'TL Review',
    stages: ['TL_REVIEW'],
    owners: ['TL'],
    action: 'Review Candidate',
    to: '/candidates?stage=TL_REVIEW',
  },
  {
    id: 'bde-review',
    label: 'BDE Review',
    stages: ['WITH_BDE', 'BDE_APPROVED'],
    owners: ['BDE'],
    action: 'Review for Client',
    to: '/candidates?stage=WITH_BDE,BDE_APPROVED',
  },
  {
    id: 'client-decision',
    label: 'Client Decision',
    stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'],
    owners: ['CLIENT', 'BDE'],
    action: 'Review Candidates',
    to: '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW',
  },
  {
    id: 'interview-feedback',
    label: 'Interview Feedback',
    stages: ['INTERVIEW_COMPLETED'],
    owners: ['CLIENT', 'RECRUITER', 'BDE'],
    action: 'Record Feedback',
    to: '/ats/calendar',
  },
  {
    id: 'joining-confirmation',
    label: 'Joining Confirmation',
    stages: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'],
    owners: ['RECRUITER', 'BDE'],
    action: 'Confirm Joining',
    to: '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED',
  },
];

// Roles that oversee other people's queues rather than owning one of their
// own — they see every queue inside their own scope.
const OVERSIGHT_ATS_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL'];

const OPEN_REQUIREMENT_STATUSES = ['OPEN', 'Open'];
const CLOSED_STAGES = ['JOINED', 'HIRED', 'REJECTED'];

function today() { return new Date().toISOString().slice(0, 10); }
function sameDay(value) { return value ? String(new Date(value).toISOString().slice(0, 10)) === today() : false; }

router.get(
  '/ats',
  requireProduct('ats'),
  requirePerm(null, 'dashboard', 'Pending Approvals', 'view'),
  async (req, res) => {
    const s = scopeOf(req.user);
    const appScope = applicationWhere(req.user);
    const reqScope = requirementWhere(req.user);

    const [applications, requirements, clients] = await Promise.all([
      prisma.application.findMany({
        where: appScope,
        include: {
          candidate: true,
          requirement: { include: { client: true, recruiter: true, bde: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.requirement.findMany({ where: reqScope, include: { client: true } }),
      prisma.client.findMany({ where: clientWhere(req.user) }),
    ]);

    // Which queues belong to this person. An oversight role sees them all —
    // inside its own scope, which the `where` above has already applied.
    const oversight = OVERSIGHT_ATS_ROLES.includes(s.atsRole);
    const queues = PENDING_QUEUES.filter((q) => oversight || q.owners.includes(s.atsRole));

    const rowsFor = (q) => applications.filter((a) => q.stages.includes(a.stage));

    const pendingActions = queues.map((q) => ({
      id: q.id, label: q.label, to: q.to, action: q.action, count: rowsFor(q).length,
    }));
    const pendingTotal = pendingActions.reduce((n, q) => n + q.count, 0);

    // The action queue: one row per waiting item, each carrying the one move
    // that advances it and the date its stage SLA runs out.
    const queueRows = queues
      .flatMap((q) => rowsFor(q).map((a) => ({
        id: a.id,
        candidateId: a.candidateId,
        candidate: a.candidate ? a.candidate.name : '—',
        requirement: a.requirement ? a.requirement.title : '—',
        requirementId: a.requirementId,
        client: a.requirement && a.requirement.client ? a.requirement.client.name : null,
        stage: a.stage,
        stageLabel: stageLabel(a.stage),
        queue: q.label,
        nextAction: q.action,
        to: q.id === 'interview-feedback' ? '/ats/calendar' : `/candidates/${a.candidateId}`,
        due: applicationDueDate(a),
        overdue: applicationIsOverdue(a),
      })))
      .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')))
      .slice(0, 12);

    // --- the raw counts every role's "My Work" block is assembled from -----
    const active = applications.filter((a) => !CLOSED_STAGES.includes(a.stage));
    const distinct = (list) => new Set(list.map((a) => a.candidateId)).size;
    const openRequirements = requirements.filter((r) => OPEN_REQUIREMENT_STATUSES.includes(r.status));
    const draftRequirements = requirements.filter((r) => !OPEN_REQUIREMENT_STATUSES.includes(r.status) && r.status !== 'Closed');
    const interviewsToday = applications.filter((a) => sameDay(a.interviewAt)
      && !['CANCELLED', 'NO_SHOW'].includes(a.interviewStatus || ''));
    const interviewsUpcoming = applications.filter((a) => a.interviewAt
      && new Date(a.interviewAt) >= new Date(today())
      && !['CANCELLED', 'NO_SHOW'].includes(a.interviewStatus || ''));
    const overdue = active.filter(applicationIsOverdue);

    // --- followup_: REAL follow-ups -----------------------------------------
    // "Follow-ups Due" used to be `overdue.length` — the STAGE SLA, because no
    // follow-up record existed. It now counts actual follow-ups somebody
    // committed to: Due Today + Overdue. The stage SLA is still what
    // `overdue` / Pending Actions measures; the two are different questions
    // and are no longer answered with the same number.
    //
    // Escalation is evaluated here as well as on the follow-up list, because
    // this app has no scheduler — see utils/followups.js for the full
    // consequence of that.
    let followUpsDueToday = 0;
    let followUpsOverdue = 0;
    let followUpsUnset = 0;
    try {
      await escalateOverdue();
      const currentFollowUps = await currentFollowUpsByApplication(active.map((a) => a.id));
      active.forEach((a) => {
        const f = currentFollowUps.get(a.id);
        if (!f) { followUpsUnset += 1; return; }
        if (f.status === 'Due Today') followUpsDueToday += 1;
        else if (f.status === 'Overdue') followUpsOverdue += 1;
      });
    } catch (err) {
      // A dashboard must render even when the follow-up read fails.
      // eslint-disable-next-line no-console
      console.error('Could not read follow-ups for the dashboard:', err.message);
    }
    const followUpsDue = followUpsDueToday + followUpsOverdue;
    const FOLLOWUPS_DUE_LINK = '/candidates?followUp=Due%20Today,Overdue';
    const FOLLOWUPS_OVERDUE_LINK = '/candidates?followUp=Overdue';
    const shared = applications.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED',
      'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED']
      .includes(a.stage));
    const selected = applications.filter((a) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage));
    const joined = applications.filter((a) => ['JOINED', 'HIRED'].includes(a.stage));
    const queueCount = (id) => (pendingActions.find((q) => q.id === id) || {}).count || 0;

    const row = (label, value, to) => ({ label, value, to });
    const CANDIDATES_ALL = '/candidates';
    const REQUIREMENTS_ALL = '/requirements';

    let myWork;
    let myWorkTitle;
    switch (s.atsRole) {
      case 'RECRUITER':
        myWorkTitle = 'My Work';
        myWork = [
          row('My Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('My Candidates', distinct(active), CANDIDATES_ALL),
          row('Interviews Today', interviewsToday.length, '/ats/calendar'),
          row('Follow-ups Due', followUpsDue, FOLLOWUPS_DUE_LINK),
          row('Overdue Follow-ups', followUpsOverdue, FOLLOWUPS_OVERDUE_LINK),
          row('Pending Actions', pendingTotal, CANDIDATES_ALL),
        ];
        break;
      case 'BDE':
        myWorkTitle = 'My Work';
        myWork = [
          row('My Clients', clients.length, '/clients'),
          row('My Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('Client Pending Decisions', queueCount('client-decision'), '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW'),
          row('Client Interviews', interviewsUpcoming.length, '/ats/calendar'),
          row('Selected / Joining', selected.length + joined.length, '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED,JOINED'),
        ];
        break;
      case 'TL':
        myWorkTitle = 'My Team';
        myWork = [
          row('My Team Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('My Team Candidates', distinct(active), CANDIDATES_ALL),
          // A TL is the first escalation rung, so the overdue count is theirs
          // to see, not only the recruiter's.
          row('Overdue Follow-ups', followUpsOverdue, FOLLOWUPS_OVERDUE_LINK),
          row('Recruiter Pending Actions', queueCount('candidate-review'), '/candidates?stage=NEW,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW'),
          row('Approvals', draftRequirements.length, REQUIREMENTS_ALL),
          row('Interviews', interviewsUpcoming.length, '/ats/calendar'),
          row('Joinings', joined.length, '/candidates?stage=JOINED,HIRED'),
        ];
        break;
      case 'STL':
        myWorkTitle = `${s.departments.join(', ') || 'Department'} Activity`;
        myWork = [
          row('Department Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('Department Candidates', distinct(active), CANDIDATES_ALL),
          row('Pending Actions', pendingTotal, CANDIDATES_ALL),
          row('Interviews', interviewsUpcoming.length, '/ats/calendar'),
          row('Selected / Joining', selected.length + joined.length, '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED,JOINED'),
        ];
        break;
      case 'CLIENT':
        myWorkTitle = 'My Company';
        myWork = [
          row('My Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('Shared Candidates', distinct(shared), CANDIDATES_ALL),
          row('Interviews', interviewsUpcoming.length, '/ats/calendar'),
          row('Decisions', queueCount('client-decision') + queueCount('interview-feedback'), '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW'),
          row('Agreements', clients.filter((c) => c.agreementStatus === 'ACTIVE').length, '/clients'),
          row('Joinings', joined.length, '/candidates?stage=JOINED,HIRED'),
        ];
        break;
      default:
        // Super Admin / Admin / Manager — overall ATS activity, still as rows.
        myWorkTitle = 'ATS Activity';
        myWork = [
          row('Open Requirements', openRequirements.length, REQUIREMENTS_ALL),
          row('Active Candidates', distinct(active), CANDIDATES_ALL),
          row('Clients', clients.length, '/clients'),
          row('Pending Actions', pendingTotal, CANDIDATES_ALL),
          row('Interviews Upcoming', interviewsUpcoming.length, '/ats/calendar'),
          row('Past SLA', overdue.length, CANDIDATES_ALL),
        ];
    }

    res.json({
      role: s.atsRole,
      scope: {
        departments: s.departments,
        global: s.global,
        client: s.clientId ? (clients[0] ? clients[0].name : null) : null,
      },
      pendingTotal,
      pendingActions,
      queue: queueRows,
      myWorkTitle,
      myWork,
    });
  }
);

router.get('/', async (req, res) => {
  // Every dashboard number is scoped the way the lists behind it are: a client
  // sees their own pipeline, a recruiter their own, a TL their department's.
  const appScope = applicationWhere(req.user);
  const reqScope = requirementWhere(req.user);
  const count = (where) => prisma.application.count({ where: { ...appScope, ...where } });

  const [
    openRequirements, recruiterReview, withBde, clientReview, interviewsUpcoming, hiringOutcomes, auditLog,
    activeEmployees, pendingLeave, invoicesPending, invoicesOverdue,
    stageGroups, recruiters,
  ] = await Promise.all([
    prisma.requirement.count({ where: { ...reqScope, status: { in: REQUIREMENT_LIVE_STATUSES } } }),
    count({ stage: 'RECRUITER_REVIEW' }),
    count({ stage: 'WITH_BDE' }),
    count({ stage: { in: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] } }),
    // "Interviews upcoming" counts scheduled interviews, not the stage.
    count({ interviewStatus: 'SCHEDULED' }),
    count({ stage: { in: ['JOINED', 'HIRED'] } }),
    // "Recent activity" is the COMPANY'S audit trail, and it was being handed
    // to every signed-in login — including a Client and a Candidate, who are
    // outside this company. It showed them staff bulk imports, internal-hire
    // rows worded in internal vocabulary ("HRMS employee created from ATS"),
    // and who did what. An outsider gets none of it.
    externalLogin(req.user)
      ? Promise.resolve([])
      : prisma.auditLog.findMany({ take: 8, orderBy: { createdAt: 'desc' }, include: { user: true } }),
    prisma.employee.count({ where: { employmentStatus: 'Active' } }),
    prisma.leaveRequest.count({ where: { status: 'Pending' } }),
    prisma.invoice.count({ where: { status: 'Pending' } }),
    prisma.invoice.count({ where: { status: 'Overdue' } }),
    prisma.application.groupBy({ by: ['stage'], where: appScope, _count: { stage: true } }),
    // Recruiter workload is scoped too: a Medical recruiter must not be shown
    // the IT team's numbers.
    prisma.user.findMany({
      where: {
        role: 'RECRUITER',
        ...(scopeOf(req.user).global ? {} : scopeOf(req.user).departments.length
          ? { OR: [{ atsDepartment: { in: scopeOf(req.user).departments } }, { id: req.user.id }] }
          : { id: req.user.id }),
      },
      select: { id: true, name: true },
    }),
  ]);

  // "Pipeline by stage": the prototype lists the 18 pipeline stages in order,
  // then Hold and Rejected, showing only the stages that have candidates.
  const byStage = Object.fromEntries(stageGroups.map((g) => [g.stage, g._count.stage]));
  const pipelineByStage = [...STAGE_CODES, 'HOLD', 'REJECTED']
    .filter((s) => (byStage[s] || 0) > 0)
    .map((s) => ({ stage: s, label: stageLabel(s), count: byStage[s] }));

  // "Recruiter workload": requirements per recruiter.
  const recruiterWorkload = await Promise.all(
    recruiters.map(async (u) => ({
      name: u.name,
      requirements: await prisma.requirement.count({ where: { recruiterId: u.id } }),
    }))
  );

  res.json({
    openRequirements,
    recruiterReview,
    withBde,
    clientReview,
    interviewsUpcoming,
    hiringOutcomes,
    pipelineByStage,
    recruiterWorkload,
    activeEmployees,
    pendingLeave,
    invoicesPending,
    invoicesOverdue,
    recentActivity: auditLog.map((a) => ({
      date: a.createdAt,
      user: a.user ? a.user.name : 'System',
      action: a.action,
      entity: a.entity,
    })),
  });
});

module.exports = router;
