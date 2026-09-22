const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, txnState,
} = require('../utils/accounts');
const { requirementIsLive } = require('../utils/atsVocab');

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
router.get('/ats', requirePerm(null, 'reports', 'ATS Reports', 'view'), async (req, res) => {
  const clients = await prisma.client.findMany({ include: { requirements: { include: { applications: true } } } });
  const rows = clients.map((c) => {
    const apps = c.requirements.flatMap((r) => r.applications);
    return {
      client: c.name,
      open: c.requirements.filter((r) => requirementIsLive(r.status)).length,
      inPipeline: apps.filter((a) => !['JOINED', 'HIRED', 'REJECTED'].includes(a.stage)).length,
      selected: apps.filter((a) => a.stage === 'SELECTED').length,
      joined: apps.filter((a) => ['JOINED', 'HIRED'].includes(a.stage)).length,
      rejected: apps.filter((a) => a.stage === 'REJECTED').length,
    };
  });
  res.json(rows);
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
