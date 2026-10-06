const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  requirementWhere, applicationWhere, clientWhere, candidateWhere, atsScopeOf: scopeOf, employeeWhere,
} = require('../utils/scope');
const dateRange = require('../utils/dateRange');
const {
  STAGE_CODES, stageLabel, applicationDueDate, applicationIsOverdue,
  REQUIREMENT_LIVE_STATUSES, nextActionForStage, applicationOwner,
} = require('../utils/atsVocab');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, txnState,
  dashRange, inRange, currentFy, monthLabel, daysOverdue, invoiceAge,
  periodOptions, PAY_STATUS, statusMatch,
} = require('../utils/accounts');
// followup_: the real follow-up record, replacing the stage-SLA stand-in that
// "Follow-ups Due" used to be computed from.
const { currentFollowUpsByApplication, escalateOverdue } = require('../utils/followups');
const { withoutSystemAccounts } = require('../utils/systemAccounts');

const router = express.Router();
// Every SLA / due-date count on the dashboards reads utils/nextAction.js (via
// atsVocab.applicationDueDate) — refresh its snapshot first so the dashboard,
// the bell and Candidates & Pipeline show the same Overdue / Due Today.
const { ensureNextActionContext } = require('../utils/nextAction');
// B9.9: billed / receivable / pending NET of issued credit & debit notes (utils/creditNotes.js decorateNet).
const CNU = require('../utils/creditNotes');
router.use((req, res, next) => { ensureNextActionContext().then(() => next(), () => next()); });
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
  // B9.9: every "billed" figure below is after issued credit / debit notes —
  // the same reading as the Invoices page (utils/invoiceTax.js withNotes).
  await CNU.decorateNet(invoices);

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
  const billing = sum(live, (i) => CNU.billedOf(i));
  const gst = sum(live, (i) => CNU.gstBilledOf(i));
  const tds = sum(live, (i) => CNU.tdsBilledOf(i));
  const invoiceValue = ROUND(billing + gst);
  const receivable = sum(live, CNU.receivableOf);
  const received = sum(live, (i) => Number(i.receivedAmount || 0));
  const pending = sum(live, CNU.pendingOf); // B9.9: after issued notes (refund due stays owed back)
  const expenseNet = sum(scopedExpenses, (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
  const expensePending = sum(scopedExpenses.filter((e) => e.paidStatus === 'Unpaid'), (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
  const expensePaid = ROUND(expenseNet - expensePending);
  const gstInput = sum(scopedExpenses, (e) => Number(e.gstAmount || 0));
  const gstReceived = sum(live, (i) => {
    const total = CNU.receivableOf(i);
    const share = total > 0 ? Number(i.receivedAmount || 0) / total : 0;
    return CNU.gstBilledOf(i) * Math.min(1, share);
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
    const b = sum(list, (i) => CNU.billedOf(i));
    const sp = sum(exp, (e) => Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0) - Number(e.tdsAmount || 0));
    const gstM = sum(list, (i) => CNU.gstBilledOf(i));
    const tdsM = sum(list, (i) => CNU.tdsBilledOf(i));
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
      receivable: sum(list, CNU.receivableOf),
      received: sum(list, (i) => Number(i.receivedAmount || 0)),
      pending: sum(list, CNU.pendingOf),
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
    cur.billing = ROUND(cur.billing + CNU.billedOf(i));
    cur.gst = ROUND(cur.gst + CNU.gstBilledOf(i));
    cur.invoiceValue = ROUND(cur.billing + cur.gst);
    cur.tds = ROUND(cur.tds + CNU.tdsBilledOf(i));
    cur.receivable = ROUND(cur.receivable + CNU.receivableOf(i));
    cur.received = ROUND(cur.received + Number(i.receivedAmount || 0));
    cur.pending = ROUND(cur.pending + CNU.pendingOf(i));
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
    cur.billing = ROUND(cur.billing + CNU.billedOf(i));
    cur.gst = ROUND(cur.gst + CNU.gstBilledOf(i));
    cur.invoiceValue = ROUND(cur.billing + cur.gst);
    cur.tds = ROUND(cur.tds + CNU.tdsBilledOf(i));
    cur.receivable = ROUND(cur.receivable + CNU.receivableOf(i));
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
        billing: ROUND(CNU.billedOf(i)),
        gst: ROUND(CNU.gstBilledOf(i)),
        invoiceValue: ROUND(CNU.billedOf(i) + CNU.gstBilledOf(i)),
        tds: ROUND(CNU.tdsBilledOf(i)),
        receivable: CNU.receivableOf(i),
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
    total: CNU.receivableOf(i),
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
// GET /api/dashboard/ats — the working ATS home (ATS review #2 §3 / §4 / §5 /
// §18, on top of round 1).
//
//   filters          Scope · Date Range · Department · TL · Recruiter
//                    (?scope=mine, ?range/from/to, and the HierarchyFilter's
//                    ?department / ?tl / ?recruiter / ?positionCode)
//   MY ACTIONS       N pending · N overdue · N due today (+ upcoming), and one
//                    quick button per queue ("Review Candidate 12")
//   MY WORK          Requirements · Candidates · Interviews · Joining, every
//                    number with its "· of N total" (§4)
//   PENDING ACTIONS  Candidate | Requirement | Stage | Action | Due | Owner,
//                    narrowed by ?due=overdue|today|upcoming and ?queue=<id>
//   TEAM / COMPANY SUMMARY  TL and above only
//
// Every number comes out of utils/scope.js, the same `where` fragments the
// lists behind them use, narrowed only by the filters the reader chose. There
// is no second scoping path here.
// ---------------------------------------------------------------------------

// The queues. `owners` is the ATS role the next move belongs to (the owner
// column of utils/atsVocab STAGE_OWNER_ACTION); `to` is the list this queue
// opens, already filtered to exactly the stages counted here; `action` is the
// quick button's words (§3) — the per-row button comes from atsVocab
// NEXT_ACTION_BY_STAGE (§5), the one table every screen reads.
const PENDING_QUEUES = [
  {
    id: 'candidate-review',
    // §31 — one vocabulary everywhere: Recruiter Review, TL Review, BDE
    // Review, Client Review, Interview Feedback, Joining Confirmation.
    label: 'Recruiter Review',
    // RECRUITER_APPROVED is still the recruiter's move ("Send to TL") —
    // without it here a Recruiter Approved candidate sat in nobody's queue.
    stages: ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'],
    owners: ['RECRUITER'],
    action: 'Review Candidate',
    to: '/candidates?stage=NEW,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW,RECRUITER_APPROVED',
  },
  {
    id: 'tl-review',
    label: 'TL Review',
    stages: ['TL_REVIEW'],
    owners: ['TL'],
    action: 'Approve / Reject',
    to: '/candidates?stage=TL_REVIEW',
  },
  {
    id: 'bde-review',
    label: 'BDE Review',
    stages: ['WITH_BDE', 'BDE_APPROVED'],
    owners: ['BDE'],
    action: 'Client Decision',
    to: '/candidates?stage=WITH_BDE,BDE_APPROVED',
  },
  {
    id: 'client-decision',
    label: 'Client Review',
    stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'],
    owners: ['CLIENT', 'BDE'],
    action: 'Follow Up',
    to: '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW',
  },
  {
    // A shortlisted candidate is waiting for somebody to book the interview —
    // it was in nobody's queue before review #2.
    id: 'schedule-interview',
    label: 'Interview Scheduling',
    stages: ['CLIENT_SHORTLISTED'],
    owners: ['BDE', 'RECRUITER'],
    action: 'Schedule Interview',
    to: '/candidates?stage=CLIENT_SHORTLISTED',
  },
  {
    id: 'interview-feedback',
    label: 'Interview Feedback',
    stages: ['INTERVIEW_COMPLETED'],
    owners: ['CLIENT', 'RECRUITER', 'BDE'],
    action: 'Record Feedback',
    to: '/candidates?stage=INTERVIEW_COMPLETED',
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
const queuesFor = (atsRole) => PENDING_QUEUES.filter((q) => OVERSIGHT_ATS_ROLES.includes(atsRole) || q.owners.includes(atsRole));
// THE JOB PORTAL COMES FIRST (the actual workflow, 2026-09-29). An application
// still in the Job Portal screening (portal / HR-sourced, not yet Sent to ATS)
// is the recruiter's (HR's) screening work only — it is never in a TL, BDE or
// client queue (utils/atsVocab.js isPreAtsApplication).
const SCREENING_ATS_ROLES = ['RECRUITER', 'HR'];
const queueRowAllowed = (atsRole, a) => SCREENING_ATS_ROLES.includes(atsRole)
  || !require('../utils/atsVocab').isPreAtsApplication(a); // eslint-disable-line global-require

const OPEN_REQUIREMENT_STATUSES = ['OPEN', 'Open'];
const CLOSED_STAGES = ['JOINED', 'HIRED', 'REJECTED'];
// The Candidates page's "Active" view: the candidate's latest application is
// in none of these (routes/candidates.js pipelineStatusOf).
const NOT_ACTIVE_STAGES = ['REJECTED', 'HOLD', 'JOINED', 'HIRED'];
// The stages a Client counts as shared with them (utils/scope.js CLIENT_SHARED_STAGES).
const SHARED_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED',
  'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];

function today() { return new Date().toISOString().slice(0, 10); }
const JOINED_STAGES = ['JOINED', 'HIRED'];

// §5 — the ONE button a pending-action row carries: atsVocab
// NEXT_ACTION_BY_STAGE. A client login decides rather than chases.
const CLIENT_ACTION_LABEL = {
  SHARED_WITH_CLIENT: 'Give Client Decision',
  CLIENT_REVIEW: 'Give Client Decision',
  INTERVIEW_COMPLETED: 'Give Interview Feedback',
};
const actionLabelFor = (stage, atsRole) => (atsRole === 'CLIENT' && CLIENT_ACTION_LABEL[stage])
  || nextActionForStage(stage);

// §18 — which bucket one pending action falls in, by its stage-SLA due date
// (atsVocab applicationDueDate; the same rule as applicationIsOverdue).
// 'none' (2026-09-29): a pending action with NO real due date (imported with
// its stage already set — utils/nextAction.js) is not "upcoming".
const DUE_BUCKETS = ['overdue', 'today', 'upcoming', 'stale', 'none'];
// A Stale row (past due, idle 30+ days — utils/nextAction.js) is its own bucket, never Overdue.
const STALE_BUCKET = (a) => require('../utils/nextAction').nextActionFor(a).dueStatus === 'stale'; // eslint-disable-line global-require
function dueBucket(due, t, a) {
  if (a && due && due < t && STALE_BUCKET(a)) return 'stale';
  if (!due) return 'none';
  if (due < t) return 'overdue';
  if (due === t) return 'today';
  return 'upcoming';
}

// §3 — the heading in the reader's own words, the same on the dashboard and
// in the bell: "My Pending Actions" / "My Team Pending Actions" / "Company
// Pending Actions". ?scope=mine narrows any lead to their own.
const PENDING_TITLES = {
  RECRUITER: 'My Pending Actions',
  BDE: 'My Pending Actions',
  CLIENT: 'My Pending Actions',
  TL: 'My Team Pending Actions',
  STL: 'My Team Pending Actions',
  MANAGER: 'Company Pending Actions',
  ASSISTANT_MANAGER: 'Company Pending Actions',
  ADMIN: 'Company Pending Actions',
  SUPER_ADMIN: 'Company Pending Actions',
};
function pendingTitleFor(s, mine) {
  if (mine) return 'My Pending Actions';
  return PENDING_TITLES[s.atsRole] || (s.global ? 'Company Pending Actions' : 'My Pending Actions');
}
const DUE_LINK = (b) => `/ats/dashboard?due=${b}#pending`;

// The ATS roles that get the dashboard's Team / Company Summary (§3). Never a
// recruiter, a BDE or a client.
const TEAM_ACTIVITY_ROLES = ['TL', 'STL', 'ASSISTANT_MANAGER', 'MANAGER', 'SUPER_ADMIN', 'ADMIN'];

// Review #3 §3 — ONE route, a different page per effective ATS role (the
// scope alias utils/scope.js scopeOf() resolves from the session, so a custom
// role borrows its system role's layout):
//   recruiter  My Work: 5 tiles + Needs Action (a BDE gets the same page with
//              its client-decision wording — layout 'bde')
//   team       TL — My Team: team tiles, Needs Action with Owner, recruiters
//   manager    STL / Manager / Asst Manager — team + department overview
//   company    Super Admin / Admin — company-wide, analytics live in Reports
//   client     a client login's own shared pipeline
function dashboardLayout(s, external) {
  if (external) return 'client';
  if (s.atsRole === 'TL') return 'team';
  if (['STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(s.atsRole)) return 'manager';
  if (['SUPER_ADMIN', 'ADMIN'].includes(s.atsRole)) return 'company';
  if (s.atsRole === 'BDE') return 'bde';
  // Anyone else with company-wide reach (e.g. an HR Super Admin reading ATS)
  // oversees; everyone else sees their own work.
  return s.global ? 'company' : 'recruiter';
}

// Interviews that are scheduled but nobody has confirmed yet (§33).
const UNCONFIRMED_INTERVIEW = ['SCHEDULED', 'RESCHEDULED'];

// --- THE DASHBOARD FILTERS (§3) --------------------------------------------
// Scope (?scope=mine), Department, TL, Recruiter (HierarchyFilter's toParams:
// department, tl, recruiter, positionCode). Each only ever NARROWS the
// caller's own scope. Returns the extra application / requirement `where`
// fragments, and whether anything was narrowed.
async function dashboardFilters(req, s) {
  const q = req.query || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const app = [];
  const reqs = [];
  const department = str(q.department);
  if (department) {
    app.push({ requirement: { is: { department } } });
    reqs.push({ department });
  }
  const mine = str(q.scope) === 'mine' && !!s.userId && !['RECRUITER', 'CLIENT', 'CANDIDATE'].includes(s.atsRole);
  if (mine) {
    const me = s.userId;
    const arm = { OR: [{ recruiterId: me }, { recruiterIds: { contains: me } }, { tlId: me }, { stlId: me }, { bdeId: me }] };
    reqs.push(arm);
    app.push({ requirement: { is: arm } });
  }
  // eslint-disable-next-line global-require
  const { hasPersonQuery, attributedApplications } = require('../utils/workers');
  let person = false;
  if (hasPersonQuery(q)) {
    person = true;
    const scope = app.length ? { AND: [applicationWhere(req.user), ...app] } : applicationWhere(req.user);
    const att = await attributedApplications(req.user, q, { scope });
    app.push({ id: { in: att ? [...att.ids] : [] } });
    // The requirement-level spelling of the same filter (routes/requirements.js
    // tlId / tlName / recruiterId / workedByName / positionCode).
    const split = (v) => (v.startsWith('id:') ? { id: v.slice(3) } : { name: v.replace(/^name:/, '') });
    if (str(q.tl)) {
      const t = split(str(q.tl));
      reqs.push(t.id ? { tlId: t.id } : { tl: t.name });
    }
    if (str(q.recruiter)) {
      const r = split(str(q.recruiter));
      reqs.push(r.id ? { OR: [{ recruiterId: r.id }, { recruiterIds: { contains: r.id } }] } : { recruiter: { is: { name: r.name } } });
    }
    if (str(q.positionCode)) {
      const codes = str(q.positionCode).split(',').map((x) => x.trim()).filter(Boolean);
      reqs.push({ positionCode: { in: codes } });
    }
  }
  return { app, reqs, narrowed: app.length > 0, mine, person, department };
}

// ---------------------------------------------------------------------------
// ACTION ALERTS — what the 🔔 bell and the floating AI button show (§18, §21,
// §26, §33).
//
//   my       the bell's "My Pending Actions": 🔴 overdue · 🟠 due today ·
//            🔵 upcoming — the SAME items as the dashboard's Pending Actions
//            table (same queues, same scope, same SLA dates), each opening the
//            dashboard filtered to that bucket.
//   groups   the bell's action lines: "N candidates need Recruiter Review", …
//   mine     the AI button: only the actions that are this person's OWN to
//            take — the queues whose owner role IS their ATS role, plus the
//            follow-ups they personally owe today. An oversight role (Manager,
//            Super Admin, STL) owns no review queue, so its badge is never the
//            company-wide pile it oversees.
// Counted live on every call. Nothing is cached (§32).
// ---------------------------------------------------------------------------
async function atsAlerts(user) {
  const s = scopeOf(user);
  const appScope = applicationWhere(user);
  const queues = queuesFor(s.atsRole);
  const ownQueues = PENDING_QUEUES.filter((q) => q.owners.includes(s.atsRole));
  const queueStages = [...new Set(queues.flatMap((q) => q.stages))];
  const external = externalLogin(user);
  const startOfToday = new Date(today());

  const [queueRows, toConfirm, openFollowUps] = await Promise.all([
    // One narrow read of the waiting applications: the counts per stage AND
    // their SLA buckets come off the same rows.
    queueStages.length
      ? prisma.application.findMany({
        where: { AND: [appScope, { stage: { in: queueStages } }] },
        select: { stage: true, updatedAt: true, createdAt: true, source: true, portalImportedAt: true },
      }).then((rows) => rows.filter((a) => queueRowAllowed(s.atsRole, a)))
      : [],
    external ? 0 : prisma.application.count({
      where: {
        AND: [appScope, {
          stage: { notIn: CLOSED_STAGES },
          interviewStatus: { in: UNCONFIRMED_INTERVIEW },
          interviewAt: { gte: startOfToday },
        }],
      },
    }),
    // The CURRENT follow-up of each live application is its newest open one
    // (utils/followups.js currentFollowUpsByApplication); a completed one is
    // never late, so only open rows are read.
    external ? [] : prisma.applicationFollowUp.findMany({
      where: { completedAt: null, application: { is: { AND: [appScope, { stage: { notIn: CLOSED_STAGES } }] } } },
      select: { applicationId: true, dueDate: true, ownerUserId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const t = today();
  const stageCount = {};
  const due = { overdue: 0, today: 0, upcoming: 0 };
  queueRows.forEach((a) => {
    stageCount[a.stage] = (stageCount[a.stage] || 0) + 1;
    due[dueBucket(applicationDueDate(a), t, a)] = (due[dueBucket(applicationDueDate(a), t, a)] || 0) + 1;
  });
  const countIn = (stages) => stages.reduce((n, st) => n + (stageCount[st] || 0), 0);

  const current = new Map();
  openFollowUps.forEach((f) => { if (!current.has(f.applicationId)) current.set(f.applicationId, f); });
  let followUpsOverdue = 0;
  let mineOverdue = 0;
  let mineDueToday = 0;
  current.forEach((f) => {
    if (!f.dueDate) return;
    const d = f.dueDate.slice(0, 10);
    if (d < t) followUpsOverdue += 1;
    if (f.ownerUserId && f.ownerUserId === s.userId) {
      if (d < t) mineOverdue += 1;
      else if (d === t) mineDueToday += 1;
    }
  });

  const has = (id) => queues.some((q) => q.id === id);
  const q = (id) => PENDING_QUEUES.find((x) => x.id === id);
  const groups = [];
  ['candidate-review', 'tl-review', 'bde-review'].forEach((id) => {
    if (!has(id)) return;
    groups.push({ id, count: countIn(q(id).stages), text: countIn(q(id).stages) === 1 ? `candidate needs ${q(id).label}` : `candidates need ${q(id).label}`, term: q(id).label, to: q(id).to });
  });
  if (!external) {
    groups.push({ id: 'interview-confirm', count: toConfirm, text: toConfirm === 1 ? 'interview needs confirmation' : 'interviews need confirmation', term: 'Interview', to: '/ats/calendar' });
  }
  if (has('client-decision')) {
    const n = countIn(q('client-decision').stages);
    groups.push({ id: 'client-decision', count: n, text: s.atsRole === 'CLIENT' ? `candidate${n === 1 ? '' : 's'} waiting for your review` : `client feedback${n === 1 ? '' : 's'} pending`, term: 'Client Review', to: q('client-decision').to });
  }
  if (has('schedule-interview')) {
    const n = countIn(q('schedule-interview').stages);
    groups.push({ id: 'schedule-interview', count: n, text: n === 1 ? 'shortlisted candidate needs an interview' : 'shortlisted candidates need an interview', term: 'Interview', to: q('schedule-interview').to });
  }
  if (has('interview-feedback')) {
    const n = countIn(q('interview-feedback').stages);
    groups.push({ id: 'interview-feedback', count: n, text: n === 1 ? 'interview needs feedback' : 'interviews need feedback', term: 'Interview Feedback', to: q('interview-feedback').to });
  }
  if (!external) {
    groups.push({ id: 'followups-overdue', count: followUpsOverdue, text: `follow-up${followUpsOverdue === 1 ? '' : 's'} overdue`, term: 'Follow-up', to: '/candidates?followUp=Overdue' });
  }
  if (has('joining-confirmation')) {
    const n = countIn(q('joining-confirmation').stages);
    groups.push({ id: 'joining-confirmation', count: n, text: `joining confirmation${n === 1 ? '' : 's'} pending`, term: 'Joining Confirmation', to: q('joining-confirmation').to });
  }

  const mineParts = ownQueues
    .map((x) => ({ id: x.id, label: x.label, count: countIn(x.stages), to: x.to }))
    .filter((x) => x.count > 0);
  if (mineOverdue) mineParts.push({ id: 'my-followups-overdue', label: 'My follow-ups overdue', count: mineOverdue, to: '/candidates?followUp=Overdue' });
  if (mineDueToday) mineParts.push({ id: 'my-followups-today', label: 'My follow-ups due today', count: mineDueToday, to: '/candidates?followUp=Due%20Today' });

  return {
    role: s.atsRole,
    scope: s.global ? 'All departments' : (s.clientId ? 'Your company' : ((s.departments || []).join(', ') || 'Your own work')),
    total: groups.reduce((n, g) => n + g.count, 0),
    groups,
    // §18 — the reader's own pending actions by due bucket.
    my: {
      title: pendingTitleFor(s, false),
      total: queueRows.length,
      overdue: due.overdue,
      today: due.today,
      upcoming: due.upcoming,
      to: '/ats/dashboard#pending',
      links: Object.fromEntries(DUE_BUCKETS.map((b) => [b, DUE_LINK(b)])),
    },
    mine: { total: mineParts.reduce((n, p) => n + p.count, 0), parts: mineParts },
    // 🔔 THE BADGE (dashboard review 2026-10-03 §A8): only role-relevant,
    // IMPORTANT items — never the whole scope's queues (that was 7,030).
    important: await importantAlerts(user, s, appScope),
  };
}

// The bell's badge: (1) actions I OWN that are overdue or due today (not
// Stale — utils/nextAction.js), (2) approvals waiting on me, (3) unread
// mentions / assignments addressed to me, (4) system alerts for the people
// allowed to see them (Dashboard / System Alerts). Ordinary notifications
// stay in the bell's Messages list and never inflate the badge.
const OVERSIGHT_OWNERS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER'];
const MENTION_RE = /assigned to you|mentioned you|@\w|assigned you|you were assigned|handed to you/i;
async function importantAlerts(user, s, appScope) {
  const NA = require('../utils/nextAction'); // eslint-disable-line global-require
  const me = user.id;
  const t = NA.todayIst();
  const lines = [];
  const items = [];
  if (!externalLogin(user)) {
    // An oversight role owns only what names them; a working role also owns
    // the unnamed steps of its role inside its (already narrow) scope.
    const mineArm = {
      OR: [
        { requirement: { is: { OR: [{ recruiterId: me }, { recruiterIds: { contains: me } }, { tlId: me }, { stlId: me }, { bdeId: me }] } } },
        { followUps: { some: { completedAt: null, ownerUserId: me } } },
      ],
    };
    const where = { AND: [appScope, { stage: { notIn: CLOSED_STAGES } }, ...(OVERSIGHT_OWNERS.includes(s.atsRole) ? [mineArm] : [])] };
    const apps = await prisma.application.findMany({
      where,
      select: {
        id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true, source: true, portalImportedAt: true,
        hiringType: true, interviewAt: true, joiningDate: true,
        candidate: { select: { name: true } },
        requirement: { select: { title: true, recruiterId: true, recruiterIds: true, tlId: true, bdeId: true, internal: true, hiringType: true, client: { select: { name: true, bdeOwner: true } } } },
      },
    });
    const viewer = { id: me, atsRole: s.atsRole };
    const screening = SCREENING_ATS_ROLES.includes(s.atsRole);
    apps.forEach((a) => {
      if (!screening && require('../utils/atsVocab').isPreAtsApplication(a)) return; // eslint-disable-line global-require
      const na = NA.nextActionFor(a, { today: t });
      if (!['overdue', 'due_today'].includes(na.dueStatus) || !NA.needsActionBy(a, na, viewer)) return;
      items.push({
        id: a.id, candidateId: a.candidateId, candidate: a.candidate ? a.candidate.name : '—', requirementId: a.requirementId,
        requirement: a.requirement ? a.requirement.title : null, action: na.action, due: na.dueAt, overdue: na.dueStatus === 'overdue',
      });
    });
    items.sort((x, y) => (y.overdue - x.overdue) || String(x.due).localeCompare(String(y.due)));
    const over = items.filter((x) => x.overdue).length;
    // "My tasks" — the same number as the dashboard greeting and the login popup.
    lines.push({ id: 'my-actions', label: 'My tasks (late or due today)', count: items.length, late: over, sub: over ? `${over} late` : (items.length ? 'due today' : null), tone: over ? 'red' : 'amber', to: '/ats/dashboard' });
  }
  const { can: canDo } = require('../middleware/auth'); // eslint-disable-line global-require
  // Old messages stop counting after the Admin's "bell keeps messages" days.
  const expireDays = require('../utils/atsAlertSettings').alertSettingsNow().bellExpireDays || 14; // eslint-disable-line global-require
  const [approvals, unread, systemAlerts] = await Promise.all([
    prisma.approvalStep.count({ where: { approverUserId: me, status: 'Pending' } }),
    prisma.notification.findMany({ where: { userId: me, read: false, createdAt: { gte: new Date(Date.now() - expireDays * 86400000) } }, select: { id: true, title: true, message: true, recipient: true } }),
    canDo(user, null, 'dashboard', 'System Alerts', 'view'),
  ]);
  lines.push({ id: 'approvals', label: 'Approvals waiting on me', count: approvals, tone: 'amber', to: '/leave' });
  const mentions = unread.filter((n) => MENTION_RE.test(`${n.title} ${n.message || ''}`));
  lines.push({ id: 'mentions', label: 'Mentions & assignments', count: mentions.length, tone: 'blue', to: '/admin/notifications', ids: mentions.map((n) => n.id) });
  // Late work of my team / area (utils/atsEscalation.js) — one grouped line.
  const escal = unread.filter((n) => /^ats-escalation\|(tl|manager)\|/.test(String(n.recipient || '')));
  if (escal.length) lines.push({ id: 'escalations', label: 'Late work in my team / area', count: escal.length, tone: 'red', to: '/admin/notifications', ids: escal.map((n) => n.id) });
  if (systemAlerts) {
    const since30 = new Date(Date.now() - 30 * 86400000);
    const [ints, syncFailed, portalFailed] = await Promise.all([
      prisma.integration.findMany({ select: { recordsFailed: true, state: true, error: true } }),
      prisma.syncLog.count({ where: { status: 'Failed', createdAt: { gte: since30 } } }),
      prisma.requirement.count({ where: { portalSyncStatus: 'Failed' } }),
    ]);
    const intFailed = ints.filter((i) => i.recordsFailed > 0 || /reconnect|expired/i.test(i.state) || i.error).length;
    // One alert per failing thing, not one per failed record.
    const n = intFailed + (syncFailed ? 1 : 0) + (portalFailed ? 1 : 0);
    lines.push({
      id: 'system', label: 'System alerts', count: n, tone: 'red', to: '/admin/integrations',
      sub: n ? [intFailed && `${intFailed} integration${intFailed === 1 ? '' : 's'} failing`, syncFailed && `${syncFailed} sync failures (30 days)`, portalFailed && `${portalFailed} jobs failed to post`].filter(Boolean).join(' · ') : null,
    });
  }
  const total = lines.reduce((x, l) => x + l.count, 0);
  return { total, badge: total > 99 ? '99+' : String(total), lines, items: items.slice(0, 8), messagesUnread: unread.length - mentions.length - escal.length };
}

// GET /api/dashboard/ats/alerts — the bell and the AI button. Same guard as
// the ATS dashboard it summarises.
router.get(
  '/ats/alerts',
  requireProduct('ats'),
  // Outside logins use /api/portal (review #3 access audit).
  require('../utils/permissions').requireInternal,
  requirePerm(null, 'dashboard', 'Pending Approvals', 'view'),
  async (req, res, next) => {
    try {
      res.json(await atsAlerts(req.user));
    } catch (err) { next(err); }
  }
);

router.get(
  '/ats',
  requireProduct('ats'),
  // Outside logins use /api/portal (review #3 access audit).
  require('../utils/permissions').requireInternal,
  requirePerm(null, 'dashboard', 'Pending Approvals', 'view'),
  async (req, res) => {
    const s = scopeOf(req.user);

    // THE DATE FILTER (?range=…&from&to, utils/dateRange.js). The queues and
    // every "(now)" number are the pipeline as it stands and do not move with
    // it; the Team / Company Summary and the "in period" lines are what
    // happened inside it. No ?range is Today.
    const period = dateRange.fromQuery(req, res);
    if (!period) return;
    const when = dateRange.dateTimeIn(period);
    const days = dateRange.dayStringIn(period);
    // A client sees its own shared pipeline, never the internal traffic behind
    // it — so no new-candidate, application, stage-move or follow-up counts.
    const external = externalLogin(req.user);

    // §3 — Scope / Department / TL / Recruiter narrow the caller's own scope.
    const f = await dashboardFilters(req, s);
    const baseApp = applicationWhere(req.user);
    const baseReq = requirementWhere(req.user);
    const appScope = f.app.length ? { AND: [baseApp, ...f.app] } : baseApp;
    const reqScope = f.reqs.length ? { AND: [baseReq, ...f.reqs] } : baseReq;
    const scoped = (extra) => ({ AND: [appScope, extra] });

    const activityCounts = Promise.all([
      external ? null : (f.narrowed
        ? prisma.application.findMany({ where: scoped({ createdAt: when, candidate: { is: { createdAt: when } } }), select: { candidateId: true }, distinct: ['candidateId'] }).then((r) => r.length)
        : prisma.candidate.count({ where: { AND: [candidateWhere(req.user), { createdAt: when }] } })),
      external ? null : prisma.application.count({ where: scoped({ createdAt: when }) }),
      // A move, not the event that opened the application (fromStage null).
      external ? null : prisma.applicationStageEvent.count({
        where: { createdAt: when, fromStage: { not: null }, application: { is: appScope } },
      }),
      // A joining is dated by its joining date; joinedAt only where none was set.
      prisma.application.count({
        where: scoped({ stage: { in: JOINED_STAGES }, OR: [{ joiningDate: days }, { joiningDate: null, joinedAt: when }] }),
      }),
      prisma.requirement.count({ where: { AND: [reqScope, { createdAt: when }] } }),
    ]);

    // PERFORMANCE (2026-09-26): counts are asked of the database; only the
    // ACTIVE applications are read (narrowly), and full records only for the
    // rows the Pending Actions table shows.
    const liveInterview = { OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['CANCELLED', 'NO_SHOW'] } }] };
    const cWhere = clientWhere(req.user);
    const teamView = TEAM_ACTIVITY_ROLES.includes(s.atsRole) && !external;
    const layout = dashboardLayout(s, external);
    const startOfToday = new Date(today());
    const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
    const todayWindow = { gte: startOfToday, lt: startOfTomorrow };
    const [
      [newCandidates, newApplications, stageMoves, joinedInPeriod, newRequirements],
      stageGroups, active, openRequirementCount, draftRequirementCount, totalRequirementCount,
      interviewsInPeriodCount, interviewsUpcomingCount,
      clientCount, firstClient, activeAgreementCount, sharedCandidates,
      interviewsTodayCount, interviewsTodayRows, interviewsToConfirm,
      latestPerCandidate, candidateTotalUnfiltered,
    ] = await Promise.all([
      activityCounts,
      prisma.application.groupBy({ by: ['stage'], where: appScope, _count: { _all: true } }),
      // Newest movement first, as before — the queue's tie order depends on it.
      prisma.application.findMany({
        where: scoped({ stage: { notIn: CLOSED_STAGES } }),
        select: {
          id: true, candidateId: true, stage: true, updatedAt: true, createdAt: true, requirementId: true,
          source: true, portalImportedAt: true,
          ...(teamView ? { requirement: { select: { recruiterId: true } } } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      }),
      // §4 — "Open Requirements" is the same set the Requirements page's Open
      // tab lists, and its total the same as the All tab.
      prisma.requirement.count({ where: { AND: [reqScope, { status: { in: REQUIREMENT_LIVE_STATUSES } }] } }),
      prisma.requirement.count({ where: { AND: [reqScope, { status: { notIn: [...OPEN_REQUIREMENT_STATUSES, 'Closed'] } }] } }),
      prisma.requirement.count({ where: reqScope }),
      prisma.application.count({ where: { AND: [appScope, { interviewAt: when }, liveInterview] } }),
      prisma.application.count({ where: { AND: [appScope, { interviewAt: { gte: new Date(today()) } }, liveInterview] } }),
      prisma.client.count({ where: cWhere }),
      s.clientId ? prisma.client.findFirst({ where: cWhere, select: { name: true } }) : null,
      s.atsRole === 'CLIENT' ? prisma.client.count({ where: { AND: [cWhere, { agreementStatus: 'ACTIVE' }] } }) : 0,
      s.atsRole === 'CLIENT'
        ? prisma.application.findMany({ where: scoped({ stage: { in: SHARED_STAGES } }), select: { candidateId: true }, distinct: ['candidateId'] })
        : [],
      prisma.application.count({ where: { AND: [appScope, { interviewAt: todayWindow }, liveInterview] } }),
      prisma.application.findMany({
        where: { AND: [appScope, { interviewAt: todayWindow }, liveInterview] },
        select: {
          id: true, candidateId: true, interviewAt: true, interviewStatus: true, stage: true,
          candidate: { select: { name: true } },
          requirement: { select: { title: true, client: { select: { name: true } } } },
        },
        orderBy: { interviewAt: 'asc' },
        take: 6,
      }),
      external ? 0 : prisma.application.count({
        where: { AND: [appScope, { stage: { notIn: CLOSED_STAGES }, interviewStatus: { in: UNCONFIRMED_INTERVIEW }, interviewAt: { gte: startOfToday } }] },
      }),
      // §4 — ACTIVE CANDIDATES THE WAY THE CANDIDATES PAGE COUNTS THEM: one
      // row per candidate, decided by the candidate's LATEST application
      // (routes/candidates.js decorate — the highest id). Narrow rows only.
      external ? [] : prisma.application.findMany({ where: appScope, select: { id: true, candidateId: true, stage: true, requirementId: true } }),
      // …and "of N total" = the Candidates page's All view (unfiltered).
      external || f.narrowed ? null : prisma.candidate.count({ where: candidateWhere(req.user) }),
    ]);
    const stageCount = Object.fromEntries(stageGroups.map((g) => [g.stage, g._count._all]));
    const countIn = (stages) => stages.reduce((n, st) => n + (stageCount[st] || 0), 0);

    const latestOf = new Map();
    latestPerCandidate.forEach((a) => {
      const cur = latestOf.get(a.candidateId);
      if (!cur || String(a.id) > String(cur.id)) latestOf.set(a.candidateId, a);
    });
    let activeCandidateCount = 0;
    latestOf.forEach((a) => { if (!NOT_ACTIVE_STAGES.includes(a.stage)) activeCandidateCount += 1; });
    const candidateTotal = candidateTotalUnfiltered != null ? candidateTotalUnfiltered : latestOf.size;

    const queues = queuesFor(s.atsRole);
    const rowsFor = (q) => active.filter((a) => q.stages.includes(a.stage) && queueRowAllowed(s.atsRole, a));
    const pendingActions = queues.map((q) => ({
      // Counted off the same rows the queue lists (pre-ATS rows are the recruiter's only).
      id: q.id, label: q.label, to: q.to, action: q.action, count: rowsFor(q).length,
    }));
    const pendingTotal = pendingActions.reduce((n, q) => n + q.count, 0);

    // §18 — every waiting item with its SLA date and bucket; §3 — the table
    // is these, narrowed by ?due / ?queue, most urgent first.
    const t = today();
    const allItems = queues.flatMap((q) => rowsFor(q).map((a) => {
      const due = applicationDueDate(a);
      return { a, q, due, bucket: dueBucket(due, t, a) };
    }));
    const dueCounts = { overdue: 0, today: 0, upcoming: 0, stale: 0, none: 0 };
    allItems.forEach((x) => { dueCounts[x.bucket] += 1; });
    const wantDue = DUE_BUCKETS.includes(req.query.due) ? req.query.due : '';
    const wantQueue = queues.some((q) => q.id === req.query.queue) ? req.query.queue : '';
    const listed = allItems
      .filter((x) => (!wantDue || x.bucket === wantDue) && (!wantQueue || x.q.id === wantQueue))
      .sort((x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')));
    const take = [25, 50, 100].includes(Number(req.query.take)) ? Number(req.query.take) : 25;
    const picked = listed.slice(0, take);
    const queueDetails = picked.length
      ? prisma.application.findMany({
        where: { id: { in: picked.map((p) => p.a.id) } },
        select: {
          id: true,
          requirementId: true,
          candidate: { select: { name: true } },
          requirement: {
            select: {
              title: true, department: true, recruiterId: true, bdeId: true, tlId: true, tl: true, internal: true,
              client: { select: { name: true } },
              recruiter: { select: { name: true } },
              bde: { select: { name: true } },
            },
          },
        },
      })
      : Promise.resolve([]);

    const distinct = (list) => new Set(list.map((a) => a.candidateId)).size;
    const overdue = active.filter(applicationIsOverdue);
    const overdueClientDecision = active.filter((a) => applicationIsOverdue(a)
      && ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
    const overdueFeedback = active.filter((a) => applicationIsOverdue(a)
      && a.stage === 'INTERVIEW_COMPLETED');
    const overdueJoining = active.filter((a) => applicationIsOverdue(a)
      && ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage));
    const overdueReview = active.filter((a) => applicationIsOverdue(a)
      && ['NEW', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW', 'WITH_BDE'].includes(a.stage));

    // --- followup_: REAL follow-ups (Due Today + Overdue), not the stage SLA.
    let followUpsDueToday = 0;
    let followUpsOverdue = 0;
    let followUpsUnset = 0;
    let followUpsOpen = 0;
    let followUpsInPeriod = 0;
    const dueFollowUps = [];
    const overdueByOwner = new Map();
    const followUpRead = (async () => {
      try {
        await escalateOverdue();
        const currentFollowUps = await currentFollowUpsByApplication(active.map((a) => a.id), {
          select: { applicationId: true, candidateId: true, ownerUserId: true, ownerName: true, nextAction: true },
        });
        active.forEach((a) => {
          const fu = currentFollowUps.get(a.id);
          if (!fu) { followUpsUnset += 1; return; }
          if (!fu.completedAt) followUpsOpen += 1;
          if (fu.status === 'Due Today') followUpsDueToday += 1;
          else if (fu.status === 'Overdue') followUpsOverdue += 1;
          if (fu.status === 'Due Today' || fu.status === 'Overdue') dueFollowUps.push(fu);
          if (fu.status === 'Overdue' && fu.ownerUserId) overdueByOwner.set(fu.ownerUserId, (overdueByOwner.get(fu.ownerUserId) || 0) + 1);
          if (!fu.completedAt && fu.dueDate && fu.dueDate.slice(0, 10) >= period.from && fu.dueDate.slice(0, 10) <= period.to) followUpsInPeriod += 1;
        });
      } catch (err) {
        // A dashboard must render even when the follow-up read fails.
        // eslint-disable-next-line no-console
        console.error('Could not read follow-ups for the dashboard:', err.message);
      }
    })();
    const movesByActor = teamView
      ? prisma.applicationStageEvent.groupBy({
        by: ['actorUserId'],
        where: { createdAt: when, fromStage: { not: null }, application: { is: appScope } },
        _count: { _all: true },
      }).catch(() => [])
      : Promise.resolve([]);
    const [details, , moveGroups] = await Promise.all([queueDetails, followUpRead, movesByActor]);
    const detailById = new Map(details.map((d) => [d.id, d]));
    // The TL on a requirement is a user id (tlId) with a name fallback (tl).
    const tlIds = [...new Set(details.map((d) => d.requirement && d.requirement.tlId).filter(Boolean))];
    const tlNames = tlIds.length
      ? new Map((await prisma.user.findMany({ where: { id: { in: tlIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
      : new Map();
    const queueRows = picked.map(({ a: slim, q, due, bucket }) => {
      const a = { ...slim, ...(detailById.get(slim.id) || {}) };
      const r = a.requirement || null;
      const ownerReq = r ? { ...r, tl: (r.tlId && tlNames.get(r.tlId)) ? { name: tlNames.get(r.tlId) } : r.tl } : null;
      const label = actionLabelFor(a.stage, s.atsRole);
      return {
        id: a.id,
        candidateId: a.candidateId,
        candidate: a.candidate ? a.candidate.name : '—',
        requirement: r ? r.title : '—',
        requirementId: a.requirementId,
        client: r && r.client ? r.client.name : null,
        department: r ? r.department || null : null,
        recruiterId: r ? r.recruiterId || null : null,
        bdeId: r ? r.bdeId || null : null,
        tlId: r ? r.tlId || null : null,
        stage: a.stage,
        stageLabel: stageLabel(a.stage),
        queue: q.label,
        queueId: q.id,
        // §5 — the stage's next action, the one table every screen reads.
        nextAction: label,
        actionLabel: label,
        // §3 — the Owner column: the named PERSON whose move it is.
        owner: external ? null : applicationOwner(a, ownerReq),
        to: `/candidates/${a.candidateId}`,
        due,
        bucket,
        overdue: applicationIsOverdue(slim),
      };
    });

    const followUpsDue = followUpsDueToday + followUpsOverdue;
    const FOLLOWUPS_DUE_LINK = '/candidates?followUp=Due%20Today,Overdue';
    const FOLLOWUPS_OVERDUE_LINK = '/candidates?followUp=Overdue';
    const selectedCount = countIn(['SELECTED', 'OFFER', 'OFFER_ACCEPTED']);
    const joinedCount = countIn(JOINED_STAGES);
    const queueCount = (id) => (pendingActions.find((q) => q.id === id) || {}).count || 0;

    const row = (label, value, to) => ({ label, value, to });
    const now = (label) => `${label} (now)`;
    const inP = (label) => `${label} — ${period.name}`;
    const CANDIDATES_ALL = '/candidates';
    const REQUIREMENTS_ALL = '/requirements';

    // The older "My Work" rows (the AI panel and the Team page still read
    // them). The dashboard itself draws `work` below.
    let myWork;
    let myWorkTitle;
    const pendingTitle = pendingTitleFor(s, f.mine);
    switch (s.atsRole) {
      case 'RECRUITER':
        myWorkTitle = 'My Work';
        myWork = [
          row(now('My Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('My Candidates'), distinct(active), CANDIDATES_ALL),
          row(inP('Interviews'), interviewsInPeriodCount, '/ats/calendar'),
          row(now('Follow-ups Due'), followUpsDue, FOLLOWUPS_DUE_LINK),
          row(now('Overdue Follow-ups'), followUpsOverdue, FOLLOWUPS_OVERDUE_LINK),
          row(now('Pending Actions'), pendingTotal, CANDIDATES_ALL),
        ];
        break;
      case 'BDE':
        myWorkTitle = 'My Work';
        myWork = [
          row(now('My Clients'), clientCount, '/clients'),
          row(now('My Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('Client Pending Decisions'), queueCount('client-decision'), '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW'),
          row('Client Interviews (upcoming)', interviewsUpcomingCount, '/ats/calendar'),
          row(now('Selected / Joining'), selectedCount + joinedCount, '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED,JOINED'),
        ];
        break;
      case 'TL':
        myWorkTitle = 'My Team';
        myWork = [
          row(now('My Team Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('My Team Candidates'), distinct(active), CANDIDATES_ALL),
          row(now('Overdue Follow-ups'), followUpsOverdue, FOLLOWUPS_OVERDUE_LINK),
          row(now('Recruiter Pending Actions'), queueCount('candidate-review'), '/candidates?stage=NEW,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW,RECRUITER_APPROVED'),
          row(now('Approvals'), draftRequirementCount, REQUIREMENTS_ALL),
          row('Interviews (upcoming)', interviewsUpcomingCount, '/ats/calendar'),
          row(inP('Joinings'), joinedInPeriod, '/candidates?stage=JOINED,HIRED'),
        ];
        break;
      case 'STL':
        myWorkTitle = `${s.departments.join(', ') || 'Department'} Activity`;
        myWork = [
          row(now('Department Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('Department Candidates'), distinct(active), CANDIDATES_ALL),
          row(now('Pending Actions'), pendingTotal, CANDIDATES_ALL),
          row('Interviews (upcoming)', interviewsUpcomingCount, '/ats/calendar'),
          row(now('Selected / Joining'), selectedCount + joinedCount, '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED,JOINED'),
        ];
        break;
      case 'CLIENT':
        myWorkTitle = 'My Company';
        myWork = [
          row(now('My Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('Shared Candidates'), sharedCandidates.length, CANDIDATES_ALL),
          row('Interviews (upcoming)', interviewsUpcomingCount, '/ats/calendar'),
          row(now('Decisions'), queueCount('client-decision') + queueCount('interview-feedback'), '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW'),
          row(now('Agreements'), activeAgreementCount, '/clients'),
          row(inP('Joinings'), joinedInPeriod, '/candidates?stage=JOINED,HIRED'),
        ];
        break;
      default:
        myWorkTitle = 'ATS Activity';
        myWork = [
          row(now('Open Requirements'), openRequirementCount, REQUIREMENTS_ALL),
          row(now('Active Candidates'), distinct(active), CANDIDATES_ALL),
          row(now('Clients'), clientCount, '/clients'),
          row(now('Pending Actions'), pendingTotal, CANDIDATES_ALL),
          row('Interviews Upcoming (from today)', interviewsUpcomingCount, '/ats/calendar'),
          row(now('Past SLA'), overdue.length, CANDIDATES_ALL),
        ];
    }

    // --- §3 / §4 — MY WORK tiles, each "N · of M total" -------------------
    // The links carry the same filters the reader chose, in the list pages'
    // own parameter names, so the page opened shows the same number.
    const hp = new URLSearchParams();
    ['department', 'tl', 'recruiter', 'positionCode'].forEach((k) => { if (typeof req.query[k] === 'string' && req.query[k]) hp.set(k, req.query[k]); });
    const rp = new URLSearchParams();
    if (f.department) rp.set('department', f.department);
    if (f.mine) rp.set('mine', '1');
    const split = (v) => (v.startsWith('id:') ? { id: v.slice(3) } : { name: v.replace(/^name:/, '') });
    if (typeof req.query.tl === 'string' && req.query.tl) { const x = split(req.query.tl); if (x.id) rp.set('tlId', x.id); else rp.set('tlName', x.name); }
    if (typeof req.query.recruiter === 'string' && req.query.recruiter) { const x = split(req.query.recruiter); if (x.id) rp.set('recruiterId', x.id); else rp.set('workedByName', x.name); }
    if (typeof req.query.positionCode === 'string' && req.query.positionCode) rp.set('positionCode', req.query.positionCode);
    const withQ = (path, p, extra = {}) => {
      const u = new URLSearchParams(p);
      Object.entries(extra).forEach(([k, v]) => u.set(k, v));
      const qs = u.toString();
      return qs ? `${path}?${qs}` : path;
    };
    const whoWord = f.mine ? 'My'
      : ({ RECRUITER: 'My', BDE: 'My', CLIENT: 'My', TL: 'Team', STL: 'Department' }[s.atsRole] || '');
    const w = (label) => (whoWord ? `${whoWord} ${label}` : label);
    const work = [
      {
        id: 'requirements', label: w('Requirements'),
        value: openRequirementCount, valueLabel: 'open',
        total: totalRequirementCount, totalLabel: 'total',
        to: withQ('/requirements', rp, { view: 'open' }), totalTo: withQ('/requirements', rp),
        meaning: 'Open = still being worked (Open, Recruiter Assigned, Sourcing, Candidates Available). Total = every requirement in scope — the Requirements page\'s All tab.',
      },
      {
        id: 'candidates', label: w('Candidates'),
        value: external ? sharedCandidates.length || distinct(active) : activeCandidateCount, valueLabel: 'active',
        total: external ? null : candidateTotal, totalLabel: 'total',
        to: withQ('/candidates', hp, { view: 'active' }), totalTo: withQ('/candidates', hp, { view: 'all' }),
        meaning: 'Active = the candidate\'s latest application is in a hiring stage (not Hold, Rejected or Joined). Total includes rejected, hold and historical candidates.',
      },
      {
        id: 'interviews', label: w('Interviews'),
        value: interviewsTodayCount, valueLabel: 'today',
        total: interviewsUpcomingCount, totalLabel: 'upcoming',
        to: '/ats/calendar', totalTo: '/ats/calendar',
        toConfirm: interviewsToConfirm,
        rows: interviewsTodayRows.slice(0, 3).map((r) => ({
          id: r.id, candidateId: r.candidateId, candidate: r.candidate ? r.candidate.name : '—', at: r.interviewAt,
        })),
        meaning: 'Interviews on today\'s date, of all interviews from today on (cancelled and no-show left out).',
      },
      {
        id: 'joining', label: w('Joining'),
        value: selectedCount, valueLabel: 'to confirm',
        total: joinedInPeriod, totalLabel: `joined — ${period.name}`,
        to: withQ('/candidates', hp, { stage: 'SELECTED,OFFER,OFFER_ACCEPTED' }), totalTo: withQ('/candidates', hp, { stage: 'JOINED,HIRED' }),
        meaning: 'Selected or offered, joining not yet confirmed; and joinings dated in the selected period.',
      },
    ];

    // --- §3 / §4 — the older summary strip (the AI panel reads it) --------
    const queueStagesAll = [...new Set(queues.flatMap((q) => q.stages))];
    const whose = s.clientId ? 'your company' : s.global ? 'all departments'
      : ({ RECRUITER: 'assigned to you', TL: 'your team', STL: 'your departments', BDE: 'your clients' }[s.atsRole] || 'your scope');
    const summary = [
      {
        id: 'open-requirements', label: 'Open Requirements', value: openRequirementCount, total: totalRequirementCount, totalLabel: 'total',
        to: withQ('/requirements', rp, { view: 'open' }),
        meaning: `Requirements still being worked (Open, Recruiter Assigned, Sourcing, Candidates Available) — ${whose}`,
      },
      {
        id: 'active-candidates', label: 'Active Candidates', value: activeCandidateCount, total: external ? null : candidateTotal, totalLabel: 'total',
        to: withQ('/candidates', hp, { view: 'active' }),
        meaning: 'Candidates currently in active hiring stages — not on hold, rejected or joined',
      },
      {
        id: 'pending-actions', label: 'Pending Actions', value: pendingTotal, total: active.length, totalLabel: 'active applications',
        to: queueStagesAll.length ? `/candidates?stage=${queueStagesAll.join(',')}` : null,
        meaning: 'Applications waiting for the next step: review, client decision, interview, feedback or joining',
      },
      {
        id: 'interviews-today', label: 'Interviews Today', value: interviewsTodayCount, total: interviewsUpcomingCount, totalLabel: 'upcoming', to: '/ats/calendar',
        meaning: 'Interviews scheduled for today, excluding cancelled and no-show',
      },
      {
        id: 'overdue', label: 'Overdue', value: overdue.length, total: active.length, totalLabel: 'active applications', to: null,
        meaning: 'Applications waiting longer than their stage allows (past SLA)',
      },
      !external && {
        id: 'followups-due', label: 'Follow-ups Due', value: followUpsDue, total: followUpsOpen, totalLabel: 'open follow-ups', to: FOLLOWUPS_DUE_LINK,
        meaning: 'Follow-ups due today or already overdue',
      },
    ].filter(Boolean);

    // --- UPCOMING / DUE TODAY (round 1; the AI panel and Team read it) -----
    dueFollowUps.sort((x, y) => String(x.dueDate || '').localeCompare(String(y.dueDate || '')));
    const dueTop = dueFollowUps.slice(0, 5);
    const dueNames = dueTop.length
      ? await prisma.candidate.findMany({ where: { id: { in: dueTop.map((x) => x.candidateId).filter(Boolean) } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(dueNames.map((c) => [c.id, c.name]));
    const clientReviewPending = countIn(['SHARED_WITH_CLIENT', 'CLIENT_REVIEW']);
    const feedbackPending = countIn(['INTERVIEW_COMPLETED']);
    const upcoming = {
      interviewsToday: {
        count: interviewsTodayCount,
        to: '/ats/calendar',
        rows: interviewsTodayRows.map((r) => ({
          id: r.id,
          candidateId: r.candidateId,
          candidate: r.candidate ? r.candidate.name : '—',
          requirement: r.requirement ? r.requirement.title : '—',
          client: r.requirement && r.requirement.client ? r.requirement.client.name : null,
          at: r.interviewAt,
          status: r.interviewStatus || 'SCHEDULED',
        })),
        toConfirm: interviewsToConfirm,
      },
      followUpsDue: external ? null : {
        count: followUpsDue,
        overdue: followUpsOverdue,
        to: FOLLOWUPS_DUE_LINK,
        rows: dueTop.map((x) => ({
          id: x.applicationId,
          candidateId: x.candidateId,
          candidate: nameOf.get(x.candidateId) || '—',
          due: x.dueDate ? x.dueDate.slice(0, 10) : null,
          overdue: x.status === 'Overdue',
          nextAction: x.nextAction || null,
          owner: x.ownerName || null,
        })),
      },
      clientFeedback: {
        count: clientReviewPending + feedbackPending,
        parts: [
          { id: 'client-review', label: 'Client Review', count: clientReviewPending, to: '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW' },
          { id: 'interview-feedback', label: 'Interview Feedback', count: feedbackPending, to: '/candidates?stage=INTERVIEW_COMPLETED' },
        ],
      },
      joining: {
        count: selectedCount,
        to: '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED',
      },
    };

    // --- §3 — TEAM / COMPANY SUMMARY (TL and above, never a recruiter) ----
    let teamActivity = null;
    if (teamView) {
      const queueStageSet = new Set(queueStagesAll);
      const perPerson = new Map();
      const bump = (id, key, n = 1) => {
        if (!id) return;
        const e = perPerson.get(id) || { userId: id, pending: 0, overdue: 0, followUpsOverdue: 0, moves: 0 };
        e[key] += n;
        perPerson.set(id, e);
      };
      active.forEach((a) => {
        const rid = a.requirement && a.requirement.recruiterId;
        if (!rid) return;
        if (queueStageSet.has(a.stage)) bump(rid, 'pending');
        if (applicationIsOverdue(a)) bump(rid, 'overdue');
      });
      overdueByOwner.forEach((n, id) => bump(id, 'followUpsOverdue', n));
      (moveGroups || []).forEach((g) => bump(g.actorUserId, 'moves', g._count._all));
      const ids = [...perPerson.keys()];
      const people = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, atsRole: true, role: true } })
        : [];
      const personOf = new Map(people.map((u) => [u.id, u]));
      const rows = [...perPerson.values()]
        .filter((e) => personOf.has(e.userId))
        .map((e) => ({ ...e, name: personOf.get(e.userId).name, role: personOf.get(e.userId).atsRole || personOf.get(e.userId).role }))
        .sort((x, y) => (y.pending + y.overdue) - (x.pending + x.overdue) || y.moves - x.moves || x.name.localeCompare(y.name));
      teamActivity = {
        title: s.atsRole === 'TL' ? 'Team Summary' : s.atsRole === 'STL' ? 'Department Summary' : 'Company Summary',
        counts: [
          row('New candidates', newCandidates, CANDIDATES_ALL),
          row('Applications added', newApplications, CANDIDATES_ALL),
          row('Stage movements', stageMoves, null),
          row('Interviews', interviewsInPeriodCount, '/ats/calendar'),
          row('Joinings', joinedInPeriod, '/candidates?stage=JOINED,HIRED'),
          row('Requirements created', newRequirements, null),
        // §23 — Super Admin keeps the full breakdown, zeros included.
        ].filter((r) => r.value > 0 || layout === 'company'),
        people: rows.slice(0, 15),
        peopleTotal: rows.length,
      };
    }

    // --- Review #3 §3 — THE ROLE LAYOUT'S TILES ------------------------------
    // Each tile opens the list it counts, pre-filtered. `to: '#pending'` is the
    // Needs Action table on the same page (its length IS the tile's number).
    const tile = (id, label, value, extra = {}) => ({ id, label, value, ...extra });
    const reqOpenTo = withQ('/requirements', rp, { view: 'open', ...(layout === 'recruiter' || layout === 'bde' ? { mine: '1' } : {}) });
    const reqAllTo = withQ('/requirements', rp);
    const candActiveTo = withQ('/candidates', hp, { view: 'active' });
    const candAllTo = withQ('/candidates', hp, { view: 'all' });
    const interviewsTile = tile('interviews-today', 'Interviews Today', interviewsTodayCount, {
      sub: `${interviewsUpcomingCount.toLocaleString('en-IN')} upcoming`, to: '/ats/calendar?view=today',
      rows: interviewsTodayRows.slice(0, 3).map((r) => ({ id: r.id, candidateId: r.candidateId, candidate: r.candidate ? r.candidate.name : '—', at: r.interviewAt })),
    });
    const selectedTo = withQ('/candidates', hp, { stage: 'SELECTED,OFFER,OFFER_ACCEPTED' });
    const joinedTo = withQ('/candidates', hp, { stage: 'JOINED,HIRED' });
    const clientDecisions = queueCount('bde-review') + queueCount('client-decision');
    let tiles;
    if (layout === 'recruiter' || layout === 'bde') {
      tiles = [
        tile('open-requirements', 'Open Requirements', openRequirementCount, { total: totalRequirementCount, totalLabel: 'total', to: reqOpenTo, totalTo: reqAllTo }),
        tile('active-candidates', 'Active Candidates', activeCandidateCount, { total: candidateTotal, totalLabel: 'total', to: candActiveTo, totalTo: candAllTo }),
        interviewsTile,
        tile('pending-actions', layout === 'bde' ? 'Pending Actions' : 'Pending Actions', pendingTotal, {
          sub: layout === 'bde'
            ? `${clientDecisions.toLocaleString('en-IN')} client decision${clientDecisions === 1 ? '' : 's'}`
            : (dueCounts.overdue ? `${dueCounts.overdue.toLocaleString('en-IN')} overdue` : null),
          tone: dueCounts.overdue ? 'red' : null,
          to: '#pending',
        }),
        tile('followups-due', 'Follow-ups Due', followUpsDue, {
          sub: followUpsOverdue ? `${followUpsOverdue.toLocaleString('en-IN')} overdue` : null,
          tone: followUpsOverdue ? 'red' : null,
          to: FOLLOWUPS_DUE_LINK,
        }),
      ];
    } else if (layout === 'team') {
      tiles = [
        tile('team-requirements', 'Team Requirements', openRequirementCount, { valueLabel: 'open', total: totalRequirementCount, totalLabel: 'total', to: reqOpenTo, totalTo: reqAllTo }),
        tile('team-candidates', 'Team Candidates', activeCandidateCount, { valueLabel: 'active', total: candidateTotal, totalLabel: 'total', to: candActiveTo, totalTo: candAllTo }),
        tile('recruiter-reviews', 'Pending Recruiter Reviews', queueCount('candidate-review'), {
          sub: queueCount('tl-review') ? `${queueCount('tl-review').toLocaleString('en-IN')} waiting for your TL review` : null,
          to: '/candidates?stage=NEW,AI_INTERVIEW_COMPLETED,RECRUITER_REVIEW,RECRUITER_APPROVED',
        }),
        interviewsTile,
        tile('selected', 'Selected', selectedCount, { sub: 'joining not yet confirmed', to: selectedTo }),
        tile('joined', 'Joined', joinedInPeriod, { sub: period.name, to: joinedTo }),
        tile('overdue', 'Overdue Actions', dueCounts.overdue, { tone: dueCounts.overdue ? 'red' : null, to: '#pending', due: 'overdue' }),
      ];
    } else if (layout === 'manager' || layout === 'company') {
      tiles = [
        tile('open-requirements', 'Open Requirements', openRequirementCount, { total: totalRequirementCount, totalLabel: 'total', to: reqOpenTo, totalTo: reqAllTo }),
        tile('active-candidates', 'Active Candidates', activeCandidateCount, { total: candidateTotal, totalLabel: 'total', to: candActiveTo, totalTo: candAllTo }),
        tile('pending-actions', 'Pending Actions', pendingTotal, { to: '#pending' }),
        tile('overdue', 'Overdue Actions', dueCounts.overdue, { tone: dueCounts.overdue ? 'red' : null, to: '#pending', due: 'overdue' }),
        interviewsTile,
        tile('selected', 'Selected', selectedCount, { sub: 'joining not yet confirmed', to: selectedTo }),
        tile('joined', 'Joined', joinedInPeriod, { sub: period.name, to: joinedTo }),
      ];
    } else {
      tiles = null; // a client login keeps the older `work` tiles
    }

    // --- §3 — DEPARTMENT CARDS (Manager / Asst Manager / STL / Super Admin) --
    let departmentCards = null;
    if (layout === 'manager' || layout === 'company') {
      const [deptOfReqRows, openByDept, joinedRows] = await Promise.all([
        // Two narrow columns of every requirement — only to LABEL the
        // in-scope applications counted below; nothing out of scope is counted.
        prisma.requirement.findMany({ select: { id: true, department: true } }),
        prisma.requirement.groupBy({ by: ['department'], where: { AND: [reqScope, { status: { in: REQUIREMENT_LIVE_STATUSES } }] }, _count: { _all: true } }),
        prisma.application.findMany({
          where: scoped({ stage: { in: JOINED_STAGES }, OR: [{ joiningDate: days }, { joiningDate: null, joinedAt: when }] }),
          select: { requirementId: true },
        }),
      ]);
      const deptOfReq = new Map(deptOfReqRows.map((r) => [r.id, r.department || '']));
      const cards = new Map();
      const card = (d) => {
        const k = d || '';
        if (!cards.has(k)) cards.set(k, { department: k || null, openRequirements: 0, activeCandidates: 0, pending: 0, overdue: 0, selected: 0, joined: 0 });
        return cards.get(k);
      };
      openByDept.forEach((g) => { card(g.department).openRequirements += g._count._all; });
      latestOf.forEach((a) => { if (!NOT_ACTIVE_STAGES.includes(a.stage)) card(deptOfReq.get(a.requirementId)).activeCandidates += 1; });
      allItems.forEach((x) => {
        const c = card(deptOfReq.get(x.a.requirementId));
        c.pending += 1;
        if (x.bucket === 'overdue') c.overdue += 1;
      });
      active.forEach((a) => { if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage)) card(deptOfReq.get(a.requirementId)).selected += 1; });
      joinedRows.forEach((a) => { card(deptOfReq.get(a.requirementId)).joined += 1; });
      departmentCards = [...cards.values()]
        .filter((c) => layout === 'company' || c.openRequirements + c.activeCandidates + c.pending + c.selected + c.joined > 0)
        .map((c) => {
          const dq = c.department ? { department: c.department } : {};
          return {
            ...c,
            links: c.department ? {
              openRequirements: withQ('/requirements', new URLSearchParams(dq), { view: 'open' }),
              activeCandidates: withQ('/candidates', new URLSearchParams(dq), { view: 'active' }),
              selected: withQ('/candidates', new URLSearchParams(dq), { stage: 'SELECTED,OFFER,OFFER_ACCEPTED' }),
              joined: withQ('/candidates', new URLSearchParams(dq), { stage: 'JOINED,HIRED' }),
            } : null,
          };
        })
        .sort((x, y) => (!x.department) - (!y.department) || (y.pending + y.overdue) - (x.pending + x.overdue)
          || String(x.department).localeCompare(String(y.department)));
    }

    // --- §3 — PER-RECRUITER MINI TABLE (TL) ------------------------------------
    // The team's waiting items by the requirement's recruiter: the same items
    // as the Needs Action table, so the rows add up to it (less unassigned).
    let recruiterLoad = null;
    if (layout === 'team') {
      const byRec = new Map();
      allItems.forEach((x) => {
        const rid = x.a.requirement && x.a.requirement.recruiterId;
        if (!rid) return;
        const e = byRec.get(rid) || { userId: rid, pending: 0, overdue: 0 };
        e.pending += 1;
        if (x.bucket === 'overdue') e.overdue += 1;
        byRec.set(rid, e);
      });
      const recUsers = byRec.size
        ? await prisma.user.findMany({ where: { id: { in: [...byRec.keys()] } }, select: { id: true, name: true } })
        : [];
      const recName = new Map(recUsers.map((u) => [u.id, u.name]));
      recruiterLoad = [...byRec.values()]
        .filter((e) => recName.has(e.userId))
        .map((e) => ({ ...e, name: recName.get(e.userId), to: '/ats/team' }))
        .sort((x, y) => y.overdue - x.overdue || y.pending - x.pending || x.name.localeCompare(y.name));
    }

    res.json({
      role: s.atsRole,
      layout,
      tiles,
      departmentCards,
      recruiterLoad,
      summary,
      work,
      upcoming,
      teamActivity,
      scope: {
        departments: s.departments,
        global: s.global,
        client: s.clientId ? (firstClient ? firstClient.name : null) : null,
      },
      // §3 — what the filters narrowed, for the page's chips and scope line.
      filters: {
        scope: f.mine ? 'mine' : 'role',
        department: f.department || null,
        narrowed: f.narrowed,
        due: wantDue || null,
        queue: wantQueue || null,
        take,
      },
      pendingTotal,
      pendingTitle,
      // §18 — the same buckets the bell shows (unfiltered by ?due / ?queue).
      dueCounts,
      listedTotal: listed.length,
      pastSla: {
        total: overdue.length,
        parts: [
          { id: 'review', label: 'Reviews past SLA', count: overdueReview.length, to: '/candidates?stage=NEW,RECRUITER_REVIEW,RECRUITER_APPROVED,TL_REVIEW,WITH_BDE' },
          { id: 'client', label: 'Client decisions overdue', count: overdueClientDecision.length, to: '/candidates?stage=SHARED_WITH_CLIENT,CLIENT_REVIEW' },
          { id: 'feedback', label: 'Interview Feedback pending', count: overdueFeedback.length, to: '/ats/calendar' },
          { id: 'joining', label: 'Joining Confirmation overdue', count: overdueJoining.length, to: '/candidates?stage=SELECTED,OFFER,OFFER_ACCEPTED' },
          { id: 'followup', label: 'Follow-ups overdue', count: followUpsOverdue, to: FOLLOWUPS_OVERDUE_LINK },
        ].filter((x) => x.count > 0),
      },
      followUps: external ? null : { due: followUpsDue, overdue: followUpsOverdue, today: followUpsDueToday, open: followUpsOpen, to: FOLLOWUPS_DUE_LINK },
      pendingActions,
      queue: queueRows,
      myWorkTitle,
      myWork,
      period,
      activity: [
        !external && row('New candidates', newCandidates, CANDIDATES_ALL),
        !external && row('Applications added', newApplications, CANDIDATES_ALL),
        !external && row('Stage movements', stageMoves, CANDIDATES_ALL),
        row('Interviews', interviewsInPeriodCount, '/ats/calendar'),
        row('Joinings', joinedInPeriod, '/candidates?stage=JOINED,HIRED'),
        row('Requirements created', newRequirements, REQUIREMENTS_ALL),
        !external && row('Follow-ups due', followUpsInPeriod, '/ats/followups'),
      ].filter(Boolean),
    });
  }
);

// ---------------------------------------------------------------------------
// ROLE DASHBOARDS (user spec 2026-09-29) — utils/roleDashboard.js.
//
//   GET /ats/role?tab=            the reader's board: recruiter | tl | bde |
//                                 management | admin ('overview' = the page
//                                 above). `views` lists the tabs this login
//                                 may open; an unknown tab falls back to the
//                                 first.
//   GET /ats/role/list?tab=&set=  the rows behind one count (same builder).
//   GET /accounts/desk(/list)     the Accountant's desk (Accounts guards).
//   GET /admin-desk(/list)        the Admin board for the home Dashboard.
//   GET /today                    the top bar's "Today's tasks".
// ---------------------------------------------------------------------------
const roleDash = require('../utils/roleDashboard');
const ATS_BOARD_GUARDS = [
  requireProduct('ats'),
  require('../utils/permissions').requireInternal,
  requirePerm(null, 'dashboard', 'Pending Approvals', 'view'),
];
function pickView(req) {
  const views = roleDash.viewsFor(req.user);
  const want = String(req.query.tab || '');
  return { views, view: views.includes(want) ? want : views[0] };
}
router.get('/ats/role', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    const { views, view } = pickView(req);
    if (view === 'overview') return res.json({ view, views });
    const b = await roleDash.buildBoard(req.user, view, req);
    return res.json(roleDash.publicBoard(b, views));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
});
router.get('/ats/role/list', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    const { view } = pickView(req);
    if (view === 'overview') return res.status(400).json({ error: 'Pick a board first' });
    const b = await roleDash.buildBoard(req.user, view, req);
    const out = await roleDash.drillRows(req.user, b, String(req.query.set || ''), { limit: Math.min(500, Number(req.query.limit) || 300) });
    if (!out) return res.status(404).json({ error: 'That list is not on your dashboard' });
    return res.json(out);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
});
// ---------------------------------------------------------------------------
// THE ATS HOME — one view per role (dashboard review 2026-10-03, A–C):
// utils/atsHome.js. GET /ats/home (?department=&range=&from=&to=),
// GET /ats/home/list?set= (the rows behind one number), and POST
// /ats/stale/close (Super Admin / Admin: bulk-close the Stale bucket).
// ---------------------------------------------------------------------------
const atsHome = require('../utils/atsHome');
const HOME_CACHE = new Map();
// The Admin health dot in the top bar (integration / sync / job-posting errors).
router.get('/ats/health', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try { return res.json(await atsHome.healthDot(req.user)); } catch (err) { return next(err); }
});
router.get('/ats/home', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    const b = await atsHome.buildHome(req.user, req);
    HOME_CACHE.set(homeKey(req), { at: Date.now(), b });
    if (HOME_CACHE.size > 50) HOME_CACHE.delete(HOME_CACHE.keys().next().value);
    return res.json(atsHome.publicHome(b));
  } catch (err) {
    if (err.status === 400 || err.name === 'RangeError400') return res.status(400).json({ error: err.message });
    return next(err);
  }
});
// The rows behind one number, with the list's own search / filters (d_*)
// and, with ?format=xlsx|csv, the same rows as a file.
const DRILL_PARAM = (k) => k.startsWith('d_') || ['set', 'limit', 'format', 'fresh'].includes(k);
function homeKey(req) {
  const q = req.query || {};
  const keys = Object.keys(q).filter((k) => !DRILL_PARAM(k)).sort();
  return `${req.user.id}|${req.viewAs ? 'va' : ''}|${JSON.stringify(keys.map((k) => [k, q[k]]))}`;
}
router.get('/ats/home/list', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    // The board the page just drew (same login, same filters) is reused for a
    // little while, so opening a number's list does not rebuild the dashboard.
    const key = homeKey(req);
    const hit = HOME_CACHE.get(key);
    let b = hit && Date.now() - hit.at < 60000 ? hit.b : null;
    if (!b) {
      b = await atsHome.buildHome(req.user, req);
      HOME_CACHE.set(key, { at: Date.now(), b });
      if (HOME_CACHE.size > 50) HOME_CACHE.delete(HOME_CACHE.keys().next().value);
    }
    const list = await atsHome.homeList(req.user, b, String(req.query.set || ''), req.query);
    if (!list) return res.status(404).json({ error: 'That list is not on your dashboard any more — close it and click the number again.' });
    if (req.query.format) {
      const { formatOf, sendTable } = require('../utils/exportKit'); // eslint-disable-line global-require
      const { ioAccessFor } = require('../utils/ioAccess'); // eslint-disable-line global-require
      const format = formatOf(req.query);
      if (!format || format === 'pdf') return res.status(400).json({ error: 'Pick Excel or CSV.' });
      const access = await ioAccessFor(req.user, 'dashboard').catch(() => ({}));
      const mayExport = access.export || await can(req.user, 'ats', 'dashboard', 'KPI Overview', 'export');
      if (!mayExport) return res.status(403).json({ error: 'Your role cannot export this list.' });
      const t = atsHome.exportTable(list);
      // ATS data (like routes/atsIo.js exports): audited, no Super Admin mail.
      const viaAts = Object.create(req, { baseUrl: { value: '/api/ats/dashboard' } });
      return sendTable(viaAts, res, {
        format, name: `dashboard-${list.title}`.slice(0, 60), title: list.title, headers: t.headers, rows: t.rows,
        sheet: 'List', entity: 'Dashboard', what: `Dashboard list "${list.title}"`, scope: require('../utils/scope').scopeLabel(req.user, 'ats'), // eslint-disable-line global-require
        period: null,
      });
    }
    const { _all, ...out } = list; // eslint-disable-line no-unused-vars
    return res.json(out);
  } catch (err) {
    if (err.status === 400 || err.name === 'RangeError400') return res.status(400).json({ error: err.message });
    return next(err);
  }
});

// DUE DATES & ALERTS — the Admin settings (spec §14, utils/atsAlertSettings.js).
// Everyone on the ATS may read them (the due dates they work to); only a
// Super Admin / Admin changes them.
const alertSettings = require('../utils/atsAlertSettings');
const mayEditAlerts = (req) => !req.viewAs && ['SUPER_ADMIN', 'ADMIN'].includes(scopeOf(req.user).atsRole);
// STEP TIMING (one Admin screen for every per-step day, main 2026-10-03):
// "Finish this step within N days" = utils/atsAlertSettings.js dueDays;
// "Contact the candidate every N days" = utils/followupVisibility.js rules
// (Integration 'ats-followup-rules' — each module keeps reading its own).
async function contactColumn() {
  const FV = require('../utils/followupVisibility'); // eslint-disable-line global-require
  const t = await FV.rulesTable();
  const byStage = new Map(t.rows.map((r) => [r.stage, r]));
  return {
    confirmed: t.confirmed, status: t.status, note: t.note, confirmedAt: t.confirmedAt, confirmedBy: t.confirmedBy,
    rows: Object.fromEntries(alertSettings.STEP_GROUPS.map((g) => {
      const rs = g.stages.map((s) => byStage.get(s)).filter(Boolean);
      const modes = [...new Set(rs.map((r) => r.mode))];
      const days = rs.map((r) => r.days);
      return [g.id, { mode: modes.length === 1 ? modes[0] : 'mixed', days: Math.min(...days), max: Math.max(...days), mixed: modes.length > 1 || Math.min(...days) !== Math.max(...days), changed: rs.some((r) => r.changed) }];
    })),
  };
}
router.get('/ats/alert-settings', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    const settings = await alertSettings.loadAlertSettings({ maxAgeMs: 0 });
    return res.json({
      settings,
      steps: alertSettings.STEP_GROUPS.map(({ id, label, days, anchor, hint }) => ({ id, label, defaultDays: days, anchor: anchor || null, hint: hint || null })),
      contact: await contactColumn(),
      canEdit: mayEditAlerts(req),
    });
  } catch (err) { return next(err); }
});
router.put('/ats/alert-settings', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    if (!mayEditAlerts(req)) return res.status(403).json({ error: 'Only a Super Admin or Admin can change the step timing.' });
    const body = req.body || {};
    // The contact column first: a bad value there saves nothing at all.
    const FV = require('../utils/followupVisibility'); // eslint-disable-line global-require
    const cur = await FV.loadRules();
    const rules = {};
    const contact = body.contactDays && typeof body.contactDays === 'object' ? body.contactDays : {};
    for (const [gid, v] of Object.entries(contact)) {
      const g = alertSettings.STEP_GROUPS.find((x) => x.id === gid);
      if (!g) continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 60) return res.status(400).json({ error: `${g.label}: contact days must be a whole number from 0 to 60.` });
      g.stages.forEach((st) => {
        const r = cur.rules[st];
        if (!r) return;
        rules[st] = { mode: r.mode === 'none' ? 'after_contact' : r.mode, days: n };
      });
    }
    const out = await alertSettings.saveAlertSettings({
      dueDays: body.dueDays, staleAfterDays: body.staleAfterDays, bellExpireDays: body.bellExpireDays,
      escalation: body.escalation ? { enabled: body.escalation.enabled, tlAfterDays: body.escalation.tlAfterDays, managerAfterDays: body.escalation.managerAfterDays } : undefined,
    });
    if (out.error) return res.status(400).json({ error: out.error });
    if (Object.keys(rules).length || body.confirmContact === true) {
      const fr = await FV.saveRules(req.user, { rules, ...(body.confirmContact === true ? { confirm: true } : {}) });
      if (fr.error) return res.status(400).json({ error: fr.error });
    }
    const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
    const brief = (s) => JSON.stringify({ dueDays: s.dueDays, staleAfterDays: s.staleAfterDays, bellExpireDays: s.bellExpireDays, escalation: { enabled: s.escalation.enabled, tlAfterDays: s.escalation.tlAfterDays, managerAfterDays: s.escalation.managerAfterDays } });
    if (brief(out.before) !== brief(out.settings)) {
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Changed ATS step timing & alerts', entity: 'Settings', entityId: alertSettings.STORE_ID, fromValue: brief(out.before), toValue: brief(out.settings) }).catch(() => null);
    }
    return res.json({ settings: out.settings, contact: await contactColumn() });
  } catch (err) { return next(err); }
});
// "Who would be told now?" — the escalation plan, writes nothing.
router.get('/ats/escalation/preview', ...ATS_BOARD_GUARDS, async (req, res, next) => {
  try {
    if (!mayEditAlerts(req)) return res.status(403).json({ error: 'Only a Super Admin or Admin can see this.' });
    const out = await require('../utils/atsEscalation').runEscalation({ force: true, dryRun: true }); // eslint-disable-line global-require
    return res.json(out);
  } catch (err) { return next(err); }
});
router.post('/ats/stale/close', ...ATS_BOARD_GUARDS, requirePerm('ats', 'candidates', 'Pipeline Stages', 'edit'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = await atsHome.closeStale(req.user, {
      target: String(body.target || ''), reason: body.reason, stages: Array.isArray(body.stages) ? body.stages.map(String) : [], expected: body.expected,
    });
    const { status, ...rest } = out;
    return res.status(status || 200).json(rest);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// THE ACCOUNTS DASHBOARD — financial control centre (Accounts spec S8),
// utils/accountsControl.js. Money and revenue are for the Accounts desk only:
// on top of the matrix guard, the login's ACCOUNTS role must be Super Admin,
// Admin or Accountant (SET.ACCOUNTS) — a view-only Manager, a TL or a
// recruiter gets a 403 here whatever a saved matrix row says.
// ---------------------------------------------------------------------------
const AC = require('../utils/accountsControl');
const PERMS = require('../utils/permissions');
const MONEY_GUARDS = [
  requireProduct('accounts'),
  requirePerm('accounts', 'accounts', 'Accounts Dashboard', 'view'),
  (req, res, next) => (PERMS.SET.ACCOUNTS.includes(PERMS.roleForProduct(req.user, 'accounts'))
    ? next()
    : res.status(403).json({ error: 'Money figures are open to Accounts, Admin and Super Admin only' })),
];
router.get('/accounts/control', ...MONEY_GUARDS, async (req, res, next) => {
  try { return res.json(await AC.buildControl(req.user, req.query)); } catch (err) { return next(err); }
});
// REMIND ACCOUNTANT — in-app only (no SMS / WhatsApp / email provider is
// connected). keys = the records to remind; none = every missing proof under
// the same filters. Never a duplicate (utils/accountsControl.js remind()).
router.post('/accounts/control/remind', ...MONEY_GUARDS, async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.slice(0, 500) : [];
    const out = await AC.remind(req.user, keys, req.body?.filters || {});
    const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
    if (out.sent) {
      await logAudit({
        userId: req.user.id, actorName: req.user.name || null, action: 'Proof reminder sent (in-app)', entity: 'AccountsDashboard', toValue: `${out.sent} record(s)`,
      });
    }
    return res.json(out);
  } catch (err) { return next(err); }
});
// The wa.me "Open WhatsApp" button: nothing is sent by the server — the
// person sends it from their own WhatsApp. The click is logged.
router.post('/accounts/control/whatsapp', ...MONEY_GUARDS, async (req, res, next) => {
  try {
    const key = String(req.body?.key || '');
    if (!/^(invoice|expense):[\w-]+$/.test(key)) return res.status(400).json({ error: 'Pick a record first' });
    const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
    await logAudit({
      userId: req.user.id, actorName: req.user.name || null, action: AC.WA_ACTION, entity: key.split(':')[0] === 'invoice' ? 'Invoice' : 'OfficeExpense', entityId: key,
    });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});
// ATTACH PROOF to an invoice receipt: a PDF / image (utils/attachments.js) or
// a typed bank reference / UTR (reference only — still "document missing").
// Office bills attach through their own POST /office-expenses/:id/proof.
const INVOICE_EDIT = requirePerm('accounts', 'accounts', 'Invoices', 'edit');
router.post('/accounts/control/proof/invoice/:id', ...MONEY_GUARDS, INVOICE_EDIT, async (req, res, next) => {
  try {
    const attachments = require('../utils/attachments'); // eslint-disable-line global-require
    const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
    const { invoiceWhere } = require('../utils/scope'); // eslint-disable-line global-require
    const inv = await prisma.invoice.findFirst({ where: { AND: [invoiceWhere(req.user), { id: req.params.id }] } });
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const stamp = { proofAt: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), proofBy: req.user.name || req.user.email || null };
    let data;
    let what;
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      let parsed;
      try { parsed = await attachments.parseMultipart(req); } catch (e) { return res.status(400).json({ error: attachments.MESSAGE[e.code] || 'Could not read the upload.' }); }
      let stored;
      try { stored = attachments.store(parsed.file); } catch (e) { return res.status(400).json({ error: attachments.MESSAGE[e.code] || 'Could not store the upload.' }); }
      const ref = String(parsed.fields?.reference || '').trim().slice(0, 120);
      data = {
        proofFile: stored.billFile, proofName: stored.billName, proofMime: stored.billMime, ...(ref ? { proofRef: ref } : {}), ...stamp,
      };
      what = `${stored.billName}${ref ? ` · ref ${ref}` : ''}`;
    } else {
      const ref = String(req.body?.reference || '').trim().slice(0, 120);
      if (!ref) return res.status(400).json({ error: 'Choose a file, or type the bank reference / UTR.' });
      data = { proofRef: ref, ...stamp };
      what = `Reference ${ref} (no document)`;
    }
    if (data.proofFile && inv.proofFile && inv.proofFile !== data.proofFile) attachments.remove(inv.proofFile);
    await prisma.invoice.update({ where: { id: inv.id }, data });
    await logAudit({
      userId: req.user.id, actorName: req.user.name || null, action: data.proofFile ? AC.ATTACH_ACTION : 'Proof reference added', entity: 'Invoice', entityId: inv.id, toValue: `${inv.invoiceNumber || inv.id} · ${what}`,
    });
    // A resolved record's open reminders are done with.
    if (data.proofFile) {
      await prisma.notification.updateMany({ where: { recipient: `${AC.REMIND_PREFIX}invoice:${inv.id}`, read: false }, data: { read: true } });
    }
    return res.json({ ok: true, attached: !!data.proofFile, by: stamp.proofBy, at: stamp.proofAt });
  } catch (err) { return next(err); }
});
router.get('/accounts/control/proof/invoice/:id/file', ...MONEY_GUARDS, async (req, res, next) => {
  try {
    const attachments = require('../utils/attachments'); // eslint-disable-line global-require
    const { invoiceWhere } = require('../utils/scope'); // eslint-disable-line global-require
    const inv = await prisma.invoice.findFirst({ where: { AND: [invoiceWhere(req.user), { id: req.params.id }] } });
    if (!inv || !inv.proofFile) return res.status(404).json({ error: 'No proof file on this invoice' });
    const full = attachments.resolveStored(inv.proofFile);
    if (!full) return res.status(404).json({ error: 'The attached file is no longer on the server' });
    res.setHeader('Content-Type', inv.proofMime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${attachments.safeDisplayName(inv.proofName)}"`);
    return res.sendFile(full);
  } catch (err) { return next(err); }
});

const ACCOUNTS_GUARDS = [requireProduct('accounts'), requirePerm('accounts', 'accounts', 'Accounts Dashboard', 'view')];
router.get('/accounts/desk', ...ACCOUNTS_GUARDS, async (req, res, next) => {
  try {
    return res.json(roleDash.publicBoard(await roleDash.accountsDesk(req.user), ['accounts']));
  } catch (err) { return next(err); }
});
router.get('/accounts/desk/list', ...ACCOUNTS_GUARDS, async (req, res, next) => {
  try {
    const b = await roleDash.accountsDesk(req.user);
    const out = await roleDash.drillRows(req.user, b, String(req.query.set || ''));
    if (!out) return res.status(404).json({ error: 'That list is not on your dashboard' });
    return res.json(out);
  } catch (err) { return next(err); }
});
const ADMIN_GUARDS = [require('../utils/permissions').requireInternal, requirePerm(null, 'administration', 'Users', 'view')];
router.get('/admin-desk', ...ADMIN_GUARDS, async (req, res, next) => {
  try {
    return res.json(roleDash.publicBoard(await roleDash.buildBoard(req.user, 'admin', req), ['admin']));
  } catch (err) { return next(err); }
});
router.get('/admin-desk/list', ...ADMIN_GUARDS, async (req, res, next) => {
  try {
    const b = await roleDash.buildBoard(req.user, 'admin', req);
    const out = await roleDash.drillRows(req.user, b, String(req.query.set || ''));
    if (!out) return res.status(404).json({ error: 'That list is not on your dashboard' });
    return res.json(out);
  } catch (err) { return next(err); }
});
router.get('/today', require('../utils/permissions').requireInternal, async (req, res, next) => {
  try {
    return res.json(await roleDash.todayTasks(req.user));
  } catch (err) { return next(err); }
});

// The ATS/company summary is internal (review #3 access audit): a Client or
// Candidate is refused — their home is the portal.
router.get('/', require('../utils/permissions').requireInternal, async (req, res) => {
  // Every dashboard number is scoped the way the lists behind it are: a client
  // sees their own pipeline, a recruiter their own, a TL their department's.
  const appScope = applicationWhere(req.user);
  const reqScope = requirementWhere(req.user);
  const count = (where) => prisma.application.count({ where: { ...appScope, ...where } });

  // THE DATE FILTER (?range=…&from&to, utils/dateRange.js). Everything above
  // `inPeriod` below is the pipeline as it stands and keeps its old meaning —
  // the ATS home and the Team page read these fields too. `inPeriod` is what
  // happened inside the chosen range, and Recent activity is limited to it.
  const period = dateRange.fromQuery(req, res);
  if (!period) return;
  const when = dateRange.dateTimeIn(period);
  const inScope = (extra) => prisma.application.count({ where: { AND: [appScope, extra] } });
  // Company-wide figures only for those allowed to see them: the audit trail
  // for Audit Logs viewers, invoices for Accounts invoice viewers; headcount
  // and pending leave are held to the viewer's own employee scope.
  const [mayAudit, mayInvoices] = await Promise.all([
    can(req.user, null, 'administration', 'Audit Logs', 'view'),
    can(req.user, 'accounts', 'accounts', 'Invoices', 'view'),
  ]);
  const empScope = employeeWhere(req.user);

  const [
    openRequirements, recruiterReview, withBde, clientReview, interviewsUpcoming, hiringOutcomes, auditLog,
    activeEmployees, pendingLeave, invoicesPending, invoicesOverdue,
    stageGroups, recruiters, joinedInPeriod, interviewsInPeriod,
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
    externalLogin(req.user) || !mayAudit
      ? Promise.resolve([])
      : prisma.auditLog.findMany({ where: { createdAt: when }, take: 8, orderBy: { createdAt: 'desc' }, include: { user: true } }),
    prisma.employee.count({ where: { AND: [withoutSystemAccounts({ employmentStatus: 'Active' }), empScope] } }), // headcount: not Super Admin
    prisma.leaveRequest.count({ where: { status: 'Pending', ...(Object.keys(empScope).length ? { employee: empScope } : {}) } }),
    mayInvoices ? prisma.invoice.count({ where: { status: 'Pending' } }) : Promise.resolve(null),
    mayInvoices ? prisma.invoice.count({ where: { status: 'Overdue' } }) : Promise.resolve(null),
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
    // Dated by the joining date; joinedAt only where none was set.
    inScope({ stage: { in: JOINED_STAGES }, OR: [{ joiningDate: dateRange.dayStringIn(period) }, { joiningDate: null, joinedAt: when }] }),
    // A NULL interviewStatus is a live interview, so it is kept explicitly.
    inScope({ interviewAt: when, OR: [{ interviewStatus: null }, { interviewStatus: { notIn: ['CANCELLED', 'NO_SHOW'] } }] }),
  ]);

  // "Pipeline by stage": the prototype lists the 18 pipeline stages in order,
  // then Hold and Rejected, showing only the stages that have candidates.
  const byStage = Object.fromEntries(stageGroups.map((g) => [g.stage, g._count.stage]));
  const pipelineByStage = [...STAGE_CODES, 'HOLD', 'REJECTED']
    .filter((s) => (byStage[s] || 0) > 0)
    .map((s) => ({ stage: s, label: stageLabel(s), count: byStage[s] }));

  // "Recruiter workload": requirements per recruiter.
  // One grouped count rather than one query per recruiter.
  const workload = recruiters.length
    ? await prisma.requirement.groupBy({
      by: ['recruiterId'], where: { recruiterId: { in: recruiters.map((u) => u.id) } }, _count: { _all: true },
    })
    : [];
  const perRecruiter = new Map(workload.map((g) => [g.recruiterId, g._count._all]));
  const recruiterWorkload = recruiters.map((u) => ({ name: u.name, requirements: perRecruiter.get(u.id) || 0 }));

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
    period,
    inPeriod: { joined: joinedInPeriod, interviews: interviewsInPeriod },
    recentActivity: auditLog.map((a) => ({
      date: a.createdAt,
      user: a.user ? a.user.name : 'System',
      action: a.action,
      entity: a.entity,
    })),
  });
});

module.exports = router;
// The queue definitions, for People & Workload's per-person Pending / Overdue
// (utils/teamWorkload.js) — one definition of "pending", not two.
module.exports.PENDING_QUEUES = PENDING_QUEUES;
