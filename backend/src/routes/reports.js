const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, txnState,
} = require('../utils/accounts');
const { requirementIsLive, stageLabel } = require('../utils/atsVocab');
const { applicationWhere, scopeLabel } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

// A REPORT IS DATA, SO IT IS GUARDED LIKE DATA.  (§20)
//
// These three endpoints sat behind requireAuth and nothing else, which meant
// any signed-in login — an HRMS-only employee, the HR desk (§6), a client —
// could read the whole client pipeline and the whole ledger by typing the URL,
// however carefully the sidebar hid the screen. The `reports` matrix already
// said who may read each one (utils/permissions.js: the ATS and Job Portal
// reports to the ATS roles, the Accounts reports to the accounts roles); it
// was simply never asked. It is asked now, through the same
// (module, feature, action) guard every other route uses.
// ---------------------------------------------------------------------------
// ATS REPORTS (§18).
//
// "specialization wise data kaavali antey yelaaga? team wise report,
//  individual report kaavali."
//
// ONE endpoint, and the question it answers is chosen by `groupBy`. Every
// grouping is the SAME scoped set of applications counted a different way, so
// a department total and the sum of its recruiters can never disagree:
//
//   department  specialization-wise — Medical, IT, Manufacturing, …
//   team        team-wise
//   recruiter   individual-wise, and likewise tl / stl / bde
//   client      client-wise (what this endpoint used to be, and only that)
//   source      where the candidate came from
//   stage       the pipeline, counted
//
// FILTERS stack on top of any grouping: from / to, department, team, location,
// clientId, requirementId, recruiterId, tlId, stlId, bdeId, source, stage,
// status. So "Medical department, this month, by recruiter" is one request.
//
// SCOPED, which it was not. This read every client in the database regardless
// of who asked, so a Medical TL opening ATS Reports saw every client's
// pipeline — the numbers the lists beside it correctly refused them. It now
// counts over utils/scope.js applicationWhere(), the same rule the pipeline
// uses, so a report can never be a way around a scope.
// ---------------------------------------------------------------------------
const GROUPINGS = {
  department: { label: 'Department / Specialization', of: (a) => a.requirement?.department || '—' },
  team: { label: 'Team', of: (a) => a.requirement?.team || a.recruiterTeam || '—' },
  recruiter: { label: 'Recruiter', of: (a) => a.requirement?.recruiter?.name || '—' },
  tl: { label: 'TL', of: (a) => a.requirement?.tlName || a.requirement?.tl || '—' },
  stl: { label: 'STL', of: (a) => a.requirement?.stlName || a.requirement?.stl || '—' },
  bde: { label: 'BDE', of: (a) => a.requirement?.bde?.name || '—' },
  client: {
    label: 'Client',
    of: (a) => (a.requirement?.internal ? 'TeamLink Internal' : a.requirement?.client?.name || '—'),
  },
  source: { label: 'Source', of: (a) => a.source || a.candidate?.source || '—' },
  location: { label: 'Location', of: (a) => a.requirement?.location || '—' },
  stage: { label: 'Stage', of: (a) => stageLabel(a.stage) },
};

const IN_PIPELINE_OUT = ['JOINED', 'HIRED', 'REJECTED'];

router.get('/ats', requirePerm(null, 'reports', 'ATS Reports', 'view'), async (req, res) => {
  const q = req.query || {};
  const groupBy = GROUPINGS[q.groupBy] ? q.groupBy : 'client';

  // SCOPED, then filtered. The scope is not negotiable; the filters only ever
  // narrow what is already allowed.
  const where = { ...applicationWhere(req.user) };
  const reqWhere = {};
  if (q.department) reqWhere.department = q.department;
  if (q.location) reqWhere.location = q.location;
  if (q.clientId) reqWhere.clientId = q.clientId;
  if (q.recruiterId) reqWhere.recruiterId = q.recruiterId;
  if (q.bdeId) reqWhere.bdeId = q.bdeId;
  if (q.tlId) reqWhere.tlId = q.tlId;
  if (q.stlId) reqWhere.stlId = q.stlId;
  if (q.requirementId) where.requirementId = q.requirementId;
  if (Object.keys(reqWhere).length) where.requirement = { is: reqWhere };
  if (q.stage) where.stage = q.stage;
  if (q.source) where.source = q.source;
  if (q.from || q.to) {
    where.createdAt = {};
    if (q.from) where.createdAt.gte = new Date(q.from);
    // `to` is inclusive of that whole day, which is what a person means by it.
    if (q.to) where.createdAt.lte = new Date(`${q.to}T23:59:59.999Z`);
  }

  const applications = await prisma.application.findMany({
    where,
    include: {
      candidate: { select: { id: true, source: true } },
      requirement: {
        include: { client: true, recruiter: true, bde: true },
      },
    },
  });

  // tlId / stlId are plain scalars, so the names are resolved in one query
  // rather than joined — the same reason utils/followups.js does it.
  const ids = new Set();
  applications.forEach((a) => {
    if (a.requirement?.tlId) ids.add(a.requirement.tlId);
    if (a.requirement?.stlId) ids.add(a.requirement.stlId);
  });
  const names = ids.size
    ? new Map((await prisma.user.findMany({
      where: { id: { in: [...ids] } }, select: { id: true, name: true, team: true },
    })).map((u) => [u.id, u]))
    : new Map();
  applications.forEach((a) => {
    if (!a.requirement) return;
    const tl = names.get(a.requirement.tlId);
    const stl = names.get(a.requirement.stlId);
    a.requirement.tlName = tl ? tl.name : a.requirement.tl;
    a.requirement.stlName = stl ? stl.name : a.requirement.stl;
    a.recruiterTeam = a.requirement.recruiter ? a.requirement.recruiter.team : null;
  });

  const of = GROUPINGS[groupBy].of;
  const buckets = new Map();
  applications.forEach((a) => {
    const key = of(a) || '—';
    if (!buckets.has(key)) {
      buckets.set(key, {
        group: key, applications: 0, inPipeline: 0, recruiterReview: 0, tlReview: 0,
        bdeReview: 0, clientReview: 0, interview: 0, selected: 0, offer: 0,
        joined: 0, rejected: 0, hold: 0,
      });
    }
    const b = buckets.get(key);
    b.applications += 1;
    if (!IN_PIPELINE_OUT.includes(a.stage)) b.inPipeline += 1;
    if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(a.stage)) b.recruiterReview += 1;
    if (a.stage === 'TL_REVIEW') b.tlReview += 1;
    if (['WITH_BDE', 'BDE_APPROVED'].includes(a.stage)) b.bdeReview += 1;
    if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'].includes(a.stage)) b.clientReview += 1;
    if (['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(a.stage)) b.interview += 1;
    if (a.stage === 'SELECTED') b.selected += 1;
    if (['OFFER', 'OFFER_ACCEPTED'].includes(a.stage)) b.offer += 1;
    if (['JOINED', 'HIRED'].includes(a.stage)) b.joined += 1;
    if (a.stage === 'REJECTED') b.rejected += 1;
    if (a.stage === 'HOLD') b.hold += 1;
  });

  const rows = [...buckets.values()]
    .map((b) => ({
      ...b,
      // The number every one of these reports is actually read for.
      conversionPct: b.applications ? Math.round((b.joined / b.applications) * 100) : 0,
    }))
    .sort((x, y) => y.applications - x.applications);

  const totals = rows.reduce((t, r) => {
    Object.keys(r).forEach((k) => {
      if (typeof r[k] === 'number' && k !== 'conversionPct') t[k] = (t[k] || 0) + r[k];
    });
    return t;
  }, {});
  totals.conversionPct = totals.applications
    ? Math.round((totals.joined / totals.applications) * 100) : 0;

  // What this login may filter BY — the same scoped sets, so the dropdowns
  // cannot offer a department or a person the report would then refuse.
  const seen = (fn) => [...new Set(applications.map(fn).filter((v) => v && v !== '—'))].sort();

  res.json({
    groupBy,
    groupLabel: GROUPINGS[groupBy].label,
    scope: scopeLabel(req.user),
    groupings: Object.entries(GROUPINGS).map(([id, g]) => ({ id, label: g.label })),
    filterOptions: {
      departments: seen((a) => a.requirement?.department),
      locations: seen((a) => a.requirement?.location),
      teams: seen((a) => a.requirement?.team || a.recruiterTeam),
      clients: [...new Map(applications
        .filter((a) => a.requirement?.client)
        .map((a) => [a.requirement.client.id, { id: a.requirement.client.id, name: a.requirement.client.name }]))
        .values()],
      recruiters: [...new Map(applications
        .filter((a) => a.requirement?.recruiter)
        .map((a) => [a.requirement.recruiterId, { id: a.requirement.recruiterId, name: a.requirement.recruiter.name }]))
        .values()],
      bdes: [...new Map(applications
        .filter((a) => a.requirement?.bde)
        .map((a) => [a.requirement.bdeId, { id: a.requirement.bdeId, name: a.requirement.bde.name }]))
        .values()],
      sources: seen((a) => a.source || a.candidate?.source),
      stages: [...new Set(applications.map((a) => a.stage))].map((s) => ({ id: s, label: stageLabel(s) })),
    },
    rows,
    totals,
  });
});

// The prototype's Job Portal Reports: four synced-from-the-integration counts
// above the source table. "Synced" means the record reached us through the
// connected Job Portal rather than being keyed in here.
router.get('/job-portal', requirePerm(null, 'reports', 'Job Portal Reports', 'view'), async (req, res) => {
  const [candidates, applications] = await Promise.all([
    prisma.candidate.findMany({ select: { id: true, source: true } }),
    prisma.application.findMany({ select: { candidateId: true } }),
  ]);
  const sources = ['Job Portal', 'Naukri', 'Indeed', 'LinkedIn', 'TeamLink Website'];
  const linked = new Set(candidates.filter((c) => c.source === 'Job Portal').map((c) => c.id));
  res.json({
    registrationsSynced: linked.size,
    applicationsSynced: applications.filter((a) => linked.has(a.candidateId)).length,
    fromNaukri: candidates.filter((c) => c.source === 'Naukri').length,
    fromLinkedIn: candidates.filter((c) => c.source === 'LinkedIn').length,
    rows: sources.map((s) => ({ source: s, candidates: candidates.filter((c) => c.source === s).length })),
  });
});

router.get('/accounts', requirePerm(null, 'reports', 'Accounts Reports', 'view'), async (req, res) => {
  const [invoices, expenses, transactions] = await Promise.all([
    prisma.invoice.findMany({ include: { client: true } }),
    prisma.officeExpense.findMany(),
    prisma.bankTransaction.findMany(),
  ]);
  const rows = invoices.map((i) => ({
    ...i,
    derived: deriveInvoiceStatus(i),
    total: invoiceTotal(i),
    outstanding: invoiceOutstanding(i),
  }));

  // Totals use amount + GST - TDS, so they match what the client actually pays.
  const byStatus = ['Pending', 'Partially Paid', 'Overdue', 'Paid', 'Cancelled'].map((status) => {
    const list = rows.filter((i) => i.derived === status);
    return {
      status,
      count: list.length,
      amount: ROUND(list.reduce((sum, i) => sum + i.total, 0)),
      outstanding: ROUND(list.reduce((sum, i) => sum + i.outstanding, 0)),
    };
  });

  // Receivables ageing on the open invoices, by days past the due date.
  const today = new Date();
  const days = (d) => Math.floor((today - new Date(d)) / 86400000);
  const open = rows.filter((i) => i.derived !== 'Paid' && i.derived !== 'Cancelled');
  const buckets = [
    { bucket: 'Not yet due', test: (i) => !i.dueDate || days(i.dueDate) < 0 },
    { bucket: '0–30 days', test: (i) => i.dueDate && days(i.dueDate) >= 0 && days(i.dueDate) <= 30 },
    { bucket: '31–60 days', test: (i) => i.dueDate && days(i.dueDate) > 30 && days(i.dueDate) <= 60 },
    { bucket: '60+ days', test: (i) => i.dueDate && days(i.dueDate) > 60 },
  ].map(({ bucket, test }) => {
    const list = open.filter(test);
    return { bucket, count: list.length, outstanding: ROUND(list.reduce((s, i) => s + i.outstanding, 0)) };
  });

  const byClientMap = new Map();
  open.forEach((i) => {
    const k = i.client?.name || '—';
    const cur = byClientMap.get(k) || { client: k, count: 0, outstanding: 0 };
    cur.count += 1;
    cur.outstanding = ROUND(cur.outstanding + i.outstanding);
    byClientMap.set(k, cur);
  });

  const gstCharged = ROUND(rows.filter((i) => i.derived !== 'Cancelled').reduce((s, i) => s + Number(i.gst || 0), 0));
  const gstPaid = ROUND(expenses.reduce((s, e) => s + Number(e.gstAmount || 0), 0));
  const incomeNet = ROUND(rows.filter((i) => i.derived !== 'Cancelled').reduce((s, i) => s + Number(i.amount || 0), 0));
  const spendNet = ROUND(expenses.reduce((s, e) => s + (Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0)), 0));

  // The prototype's own Accounts Reports table: one row per client that has
  // been invoiced, with Invoiced / Paid / Pending. The prototype totals the
  // bare `amount` and counts a whole invoice as paid the moment its status
  // says Paid; here Invoiced is amount + GST − TDS and Paid is the money
  // actually received, so a part-paid invoice reads correctly.
  const receivableMap = new Map();
  rows.filter((i) => i.derived !== 'Cancelled').forEach((i) => {
    const k = i.client?.name || '—';
    const cur = receivableMap.get(k) || { client: k, invoiced: 0, paid: 0, pending: 0 };
    cur.invoiced = ROUND(cur.invoiced + i.total);
    cur.paid = ROUND(cur.paid + Number(i.receivedAmount || 0));
    cur.pending = ROUND(cur.invoiced - cur.paid);
    receivableMap.set(k, cur);
  });

  res.json({
    receivables: [...receivableMap.values()].sort((a, b) => b.pending - a.pending),
    byStatus,
    ageing: buckets,
    byClient: [...byClientMap.values()].sort((a, b) => b.outstanding - a.outstanding),
    gstPosition: { charged: gstCharged, paid: gstPaid, payable: ROUND(gstCharged - gstPaid) },
    tdsDeducted: ROUND(rows.filter((i) => i.derived !== 'Cancelled').reduce((s, i) => s + Number(i.tds || 0), 0)),
    profitAndLoss: { incomeNet, spendNet, profit: ROUND(incomeNet - spendNet) },
    reconciliation: {
      total: transactions.length,
      unmatched: transactions.filter((t) => txnState(t) === 'Unmatched').length,
      matched: transactions.filter((t) => txnState(t) === 'Matched').length,
      reconciled: transactions.filter((t) => txnState(t) === 'Reconciled').length,
      ignored: transactions.filter((t) => txnState(t) === 'Ignored').length,
    },
  });
});

module.exports = router;
