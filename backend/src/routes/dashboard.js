const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { STAGE_CODES, stageLabel } = require('../utils/atsVocab');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, txnState,
  dashRange, inRange, currentFy, monthLabel, daysOverdue, invoiceAge,
  periodOptions, PAY_STATUS, statusMatch,
} = require('../utils/accounts');

const router = express.Router();
router.use(requireAuth);

// The Accountant's own view: receivables, what needs chasing and what is still
// sitting unreconciled on the bank statement.
router.get('/accounts', async (req, res) => {
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

router.get('/', async (req, res) => {
  // A client only ever sees their own pipeline (prototype atsDashboard, line 6252).
  const appScope = req.user.role === 'CLIENT' ? { requirement: { clientId: req.user.clientId } } : {};
  const reqScope = req.user.role === 'CLIENT' ? { clientId: req.user.clientId } : {};
  const count = (where) => prisma.application.count({ where: { ...appScope, ...where } });

  const [
    openRequirements, recruiterReview, withBde, clientReview, interviewsUpcoming, hiringOutcomes, auditLog,
    activeEmployees, pendingLeave, invoicesPending, invoicesOverdue,
    stageGroups, recruiters,
  ] = await Promise.all([
    prisma.requirement.count({ where: { ...reqScope, status: 'OPEN' } }),
    count({ stage: 'RECRUITER_REVIEW' }),
    count({ stage: 'WITH_BDE' }),
    count({ stage: { in: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] } }),
    // "Interviews upcoming" counts scheduled interviews, not the stage.
    count({ interviewStatus: 'SCHEDULED' }),
    count({ stage: { in: ['JOINED', 'HIRED'] } }),
    prisma.auditLog.findMany({ take: 8, orderBy: { createdAt: 'desc' }, include: { user: true } }),
    prisma.employee.count({ where: { employmentStatus: 'Active' } }),
    prisma.leaveRequest.count({ where: { status: 'Pending' } }),
    prisma.invoice.count({ where: { status: 'Pending' } }),
    prisma.invoice.count({ where: { status: 'Overdue' } }),
    prisma.application.groupBy({ by: ['stage'], where: appScope, _count: { stage: true } }),
    prisma.user.findMany({ where: { role: 'RECRUITER' }, select: { id: true, name: true } }),
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
