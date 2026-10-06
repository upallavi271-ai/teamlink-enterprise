const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { invoiceWhere, matches, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus, dueDateFor,
  receiptProblem, invoiceAfterReceipt,
  dashRange, inRange, ageBucket, daysOverdue, AGE_BUCKETS,
  periodOptions, PAY_STATUS, billingLabel, clientGstinText, gstStance,
  monthLabel, toIsoDate, termDays, stateOf, placeOfSupply, wordsINR,
} = require('../utils/accounts');
const XLSX = require('xlsx');
const attachments = require('../utils/attachments');
const { stateName: gstStateName } = require('../utils/gstin');
const { raiseJoiningInvoice, isInternalHire } = require('../utils/joining');
const {
  REQ_ATTR_SELECT, loadHierarchy, attributeApplication, hierarchyPayload, attributionData,
} = require('../utils/invoiceHierarchy');
// P4 — GST & TDS: the one calculation (utils/invoiceTax.js).
const TAX = require('../utils/invoiceTax');

const router = express.Router();
router.use(requireAuth);
// Accounts product + Invoices view. A client login reaches its own invoices
// (scoped by utils/scope.js); a recruiter reaches none.
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Invoices', 'view'));
// B2 — credit / debit notes + placement margin (routes/creditNotes.js), before '/:id'.
router.use(require('./creditNotes'));
const CNU = require('../utils/creditNotes');


// Everything an invoice row needs on screen, computed the same way everywhere:
// total = amount + GST - TDS, outstanding = total - received.
function decorate(invoice) {
  const status = deriveInvoiceStatus(invoice);
  return {
    ...invoice,
    status,
    total: invoiceTotal(invoice),
    outstanding: invoiceOutstanding(invoice),
  };
}

// Statuses are derived from receipts and the due date, so they are refreshed
// on read rather than left to drift. Only writes the row when it actually moved.
async function syncStatus(invoice) {
  const status = deriveInvoiceStatus(invoice);
  if (status !== invoice.status) {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status } });
    return { ...invoice, status };
  }
  return invoice;
}

// THE SERIES IN USE. The next number carries on from the most recent
// invoice's own series — "TY26-073" is followed by "TY26-074", and a split
// such as "TY26-073-1" counts as 073 — so the "next number in the series" the
// register promises is the one the books expect. Only with no numbered invoice
// on file does it fall back to INV-<year>-0001.
const SERIES_RE = /^(.*?[^\d])?(\d{2,})(?:-(\d{1,2}))?$/;
function parseSeries(no) {
  const m = SERIES_RE.exec(String(no || '').trim());
  return m ? { prefix: m[1] || '', seq: Number(m[2]), width: m[2].length } : null;
}

async function nextInvoiceNumber() {
  const numbered = await prisma.invoice.findMany({
    where: { invoiceNumber: { not: null } },
    select: { invoiceNumber: true, invoiceDate: true, createdAt: true },
  });
  const latest = numbered.slice()
    .sort((a, b) => String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || ''))
      || (new Date(b.createdAt) - new Date(a.createdAt)))
    .find((i) => parseSeries(i.invoiceNumber));
  if (latest) {
    const { prefix: pre, width } = parseSeries(latest.invoiceNumber);
    let max = 0;
    numbered.forEach((i) => {
      const p = parseSeries(i.invoiceNumber);
      if (p && p.prefix === pre) max = Math.max(max, p.seq);
    });
    const taken = new Set(numbered.map((i) => i.invoiceNumber));
    let n = max + 1;
    let next = pre + String(n).padStart(width, '0');
    while (taken.has(next)) { n += 1; next = pre + String(n).padStart(width, '0'); }
    return next;
  }
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });
  const seq = last ? Number(String(last.invoiceNumber).slice(prefix.length)) + 1 : 1;
  return prefix + String(seq).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Joinings Accounts has never billed. The ATS marks a candidate JOINED; until
// somebody raises an invoice the fee is earned but carries no invoice number,
// so it cannot appear in the invoice table. This is the plan for raising them:
// one invoice per client per joining month, exactly as the tracker does it.
// ---------------------------------------------------------------------------
// The role a requirement hires for, without the specialisation the title
// often carries after an em dash ("Assistant Professor — Physiology").
const roleOf = (title) => (title ? String(title).split(/\s+[—–]\s+/)[0].trim() || null : null);

// Waiting = the ATS says JOINED (or HIRED), billing is not marked Invoiced, it
// is a client placement (an internal hire is never billed), and no invoice
// exists for that candidate + requirement. An older invoice that carries no
// requirement is matched on candidate + client instead.
async function pendingJoinGroups(hier) {
  const joined = await prisma.application.findMany({
    where: {
      stage: { in: ['JOINED', 'HIRED'] },
      OR: [{ billingStatus: null }, { billingStatus: { not: 'Invoiced' } }],
    },
    include: {
      candidate: true,
      requirement: { include: { client: true, recruiter: true } },
    },
  });
  const invs = await prisma.invoice.findMany({ select: { candidateId: true, requirementId: true, clientId: true } });
  const billedPair = new Set(invs.filter((i) => i.candidateId && i.requirementId).map((i) => `${i.candidateId}|${i.requirementId}`));
  const billedLoose = new Set(invs.filter((i) => i.candidateId && !i.requirementId).map((i) => `${i.candidateId}|${i.clientId}`));
  const waiting = joined.filter((a) => !isInternalHire(a, a.requirement)
    && !billedPair.has(`${a.candidateId}|${a.requirementId}`)
    && !billedLoose.has(`${a.candidateId}|${a.requirement?.clientId}`));
  // Who worked each one (utils/workers.js attribute()) — only read when the
  // caller passes the hierarchy, so the card can follow the filters.
  const workedBy = hier ? await attributionData(waiting.map((a) => a.id)) : null;

  const map = new Map();
  waiting.forEach((a) => {
    const cli = a.requirement?.client;
    const mk = String(a.joiningDate || '').slice(0, 7);
    const key = `${cli?.id || '—'}|${mk}`;
    // The fee is the client's agreed percentage of the offered CTC — nothing is
    // hardcoded, and a joining with no CTC on it simply cannot be invoiced yet.
    const feePct = cli?.agreementFeePercent;
    const billing = (a.offeredCtc != null && feePct != null) ? ROUND(Number(a.offeredCtc) * Number(feePct) / 100) : null;
    const gstPct = cli?.gstPercent ?? 0;
    const tdsPct = cli?.tdsPercent ?? 0;
    const who = hier ? attributeApplication({ ...a, ...(workedBy.get(a.id) || {}) }, hier, cli?.ownerDepartment) : null;
    const cur = map.get(key) || {
      clientId: cli?.id || null,
      client: cli?.name || '—',
      month: mk,
      monthLabel: mk ? monthLabel(mk) : '—',
      billing: 0,
      gst: 0,
      invoiceValue: 0,
      tds: 0,
      rows: [],
    };
    cur.rows.push({
      applicationId: a.id,
      candidateId: a.candidateId,
      name: a.candidate?.name || '—',
      client: cli?.name || '—',
      clientId: cli?.id || null,
      role: roleOf(a.requirement?.title),
      requirement: a.requirement?.title || null,
      joiningDate: a.joiningDate || null,
      recruiter: a.requirement?.recruiter?.name || null,
      offeredCtc: a.offeredCtc ?? null,
      feePercent: feePct ?? null,
      gstPercent: gstPct,
      tdsPercent: tdsPct,
      billing,
      billable: billing != null && billing > 0,
      ...(who ? {
        recruiter: who.recruiterName || a.requirement?.recruiter?.name || null,
        recruiterKey: who.recruiterKey,
        tl: who.tlName,
        tlKey: who.tlKey,
        seat: who.seat,
        department: who.department,
        sectionKey: who.sectionKey,
      } : {}),
    });
    if (billing != null) {
      cur.billing = ROUND(cur.billing + billing);
      cur.gst = ROUND(cur.gst + billing * gstPct / 100);
      cur.tds = ROUND(cur.tds + billing * tdsPct / 100);
      cur.invoiceValue = ROUND(cur.billing + cur.gst);
    }
    map.set(key, cur);
  });
  const groups = [...map.values()];
  // Most recent joinings first; a date more than 90 days ahead is a typing
  // slip in the source sheet and goes to the end rather than the top.
  const horizon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const plausible = (d) => (d && String(d) <= horizon ? 1 : 0);
  const all = groups.flatMap((g) => g.rows)
    .sort((x, y) => (plausible(y.joiningDate) - plausible(x.joiningDate))
      || String(y.joiningDate || '').localeCompare(String(x.joiningDate || '')));
  return {
    all,
    // The most recent few, for the notice card's list of names.
    recent: all.slice(0, 12),
    waiting: all.length,
    billing: ROUND(groups.reduce((s, g) => s + g.billing, 0)),
    invoiceValue: ROUND(groups.reduce((s, g) => s + g.invoiceValue, 0)),
    nextNumber: await nextInvoiceNumber(),
    groups: groups.filter((g) => g.rows.some((r) => r.billable)),
    notBillable: all.filter((r) => !r.billable),
  };
}

// Raise the invoice for one client/joining-month group, or for all of them.
// Nothing about the billing changes — the fee, GST and TDS come from the
// client record; only the number and the dates are written.
router.post('/register/raise', requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const plan = await pendingJoinGroups();
  // `groups` = the client / joining-month groups the screen is showing under
  // its filters, so "Raise all" never raises a group the user cannot see.
  const picked = Array.isArray(req.body.groups)
    ? new Set(req.body.groups.map((g) => `${g && g.clientId}|${String((g && g.month) || '')}`))
    : null;
  const wanted = picked
    ? plan.groups.filter((g) => picked.has(`${g.clientId}|${String(g.month || '')}`))
    : req.body.all
      ? plan.groups
      : plan.groups.filter((g) => g.clientId === req.body.clientId && String(g.month || '') === String(req.body.month || ''));
  if (!wanted.length) return res.status(400).json({ error: 'Those joinings are not waiting for an invoice any more' });

  const today = new Date().toISOString().slice(0, 10);
  const raised = [];
  for (const g of wanted) {
    const client = await prisma.client.findUnique({ where: { id: g.clientId } });
    const rows = g.rows.filter((r) => r.billable);
    if (!rows.length) continue;
    const amount = ROUND(rows.reduce((s, r) => s + r.billing, 0));
    // P4: the client's rates and GST / TDS Applicable flags, the GST type from
    // the two states, worked out by the one calculation (utils/invoiceTax.js).
    // eslint-disable-next-line no-await-in-loop
    const def = TAX.defaultsFor(client, (await prisma.company.findFirst()) || {}, { gst: 0, tds: 0 });
    const tax = TAX.calcTax({ base: amount, ...def });
    const terms = client?.paymentTerms || 'Net 30';
    const d = new Date(today);
    d.setDate(d.getDate() + termDays(terms));
    // eslint-disable-next-line no-await-in-loop
    const invoice = await prisma.invoice.create({
      data: {
        clientId: g.clientId,
        candidateId: rows[0].candidateId,
        ...TAX.writeData(tax, {}),
        invoiceDate: today,
        dueDate: toIsoDate(d),
        paymentTerms: terms,
        status: 'Pending',
        // eslint-disable-next-line no-await-in-loop
        invoiceNumber: await nextInvoiceNumber(),
        notes: `Raised for ${rows.length} joining(s) in ${g.monthLabel}`,
      },
    });
    raised.push(invoice.invoiceNumber);
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: req.user.id, action: 'Invoice raised', entity: 'Invoice', entityId: invoice.id,
      toValue: `${invoice.invoiceNumber} · ${g.client} · ${rows.length} candidate(s)`,
    });
  }
  res.json({ raised, count: raised.length });
});

router.get('/', async (req, res) => {
  const where = { ...invoiceWhere(req.user) };
  if (req.query.clientId) where.clientId = req.query.clientId;
  const invoices = await prisma.invoice.findMany({
    where,
    include: { client: true, candidate: true, requirement: true },
    orderBy: { invoiceDate: 'desc' },
  });
  const synced = await Promise.all(invoices.map(syncStatus));
  let rows = synced.map(decorate);
  // Filter on the derived status so "Overdue" means what it says.
  if (req.query.status) rows = rows.filter((i) => i.status === req.query.status);
  res.json(rows);
});

// Receivables summary for the accountant dashboard and reports.
router.get('/summary', async (req, res) => {
  const where = invoiceWhere(req.user);
  const invoices = await prisma.invoice.findMany({ where });
  const rows = invoices.map(decorate);
  const bucket = (status) => {
    const list = rows.filter((i) => i.status === status);
    return {
      status,
      count: list.length,
      total: ROUND(list.reduce((s, i) => s + i.total, 0)),
      outstanding: ROUND(list.reduce((s, i) => s + i.outstanding, 0)),
    };
  };
  res.json({
    byStatus: ['Pending', 'Partially Paid', 'Overdue', 'Paid', 'Cancelled'].map(bucket),
    invoiced: ROUND(rows.reduce((s, i) => s + i.total, 0)),
    received: ROUND(rows.reduce((s, i) => s + Number(i.receivedAmount || 0), 0)),
    outstanding: ROUND(rows.filter((i) => i.status !== 'Cancelled').reduce((s, i) => s + i.outstanding, 0)),
    gstCharged: ROUND(rows.reduce((s, i) => s + Number(i.gst || 0), 0)),
    tdsDeducted: ROUND(rows.reduce((s, i) => s + Number(i.tds || 0), 0)),
  });
});

// ---------------------------------------------------------------------------
// The invoice register. One row per invoice with every column the prototype's
// invoice lens can show, the ageing chip counts, and the KPI strip — computed
// once on the server so the table, the chips and the totals never disagree.
// ---------------------------------------------------------------------------
// What an invoice was billed for, read off the ATS: the application behind it
// (the exact candidate + requirement where the invoice names the requirement,
// otherwise the candidate's joining at the same client), so role, section,
// recruiter, joining date and CTC are the placement's own.
async function placementFacts(invoices, hier) {
  const candIds = [...new Set(invoices.map((i) => i.candidateId).filter(Boolean))];
  const apps = candIds.length ? await prisma.application.findMany({
    where: { candidateId: { in: candIds } },
    select: {
      id: true,
      candidateId: true,
      requirementId: true,
      stage: true,
      joiningDate: true,
      joiningStatus: true,
      offeredCtc: true,
      requirement: {
        select: {
          ...(hier ? REQ_ATTR_SELECT : {}),
          id: true, title: true, department: true, specialisation: true, clientId: true, recruiter: { select: { name: true } },
        },
      },
    },
  }) : [];
  // Who worked each — the follow-ups / stage moves utils/workers.js attribute() reads.
  if (hier) {
    const ad = await attributionData(apps.map((a) => a.id));
    apps.forEach((a) => Object.assign(a, ad.get(a.id) || {}));
  }
  const byCand = new Map();
  apps.forEach((a) => byCand.set(a.candidateId, [...(byCand.get(a.candidateId) || []), a]));
  return (inv) => {
    const list = byCand.get(inv.candidateId) || [];
    const exact = inv.requirementId ? list.find((a) => a.requirementId === inv.requirementId) : null;
    const sameClient = list.filter((a) => a.requirement?.clientId === inv.clientId);
    const app = exact || sameClient.find((a) => a.stage === 'JOINED' || a.stage === 'HIRED') || sameClient[0] || null;
    const req = inv.requirement || app?.requirement || null;
    // Why an invoice has no recruiter, in words the report can count.
    let unattributed = null;
    if (!inv.candidateId) unattributed = 'The invoice names no candidate';
    else if (!list.length) unattributed = 'The candidate has no application in the ATS';
    else if (!app) unattributed = "The candidate's applications are all at other client records";
    // With no seat, the department is the requirement's; else the one
    // department every application of this candidate sits in; else the
    // client's owner department. Never a recruiter guessed from these.
    const candDepts = [...new Set(list.map((a) => a.requirement?.department).filter(Boolean))];
    const fallback = req?.department ? { department: req.department, from: 'requirement' }
      : candDepts.length === 1 ? { department: candDepts[0], from: 'candidate' }
        : { department: inv.client?.ownerDepartment || null, from: 'client' };
    const who = hier ? attributeApplication(app, hier, fallback) : null;
    if (who && app && !who.recruiterKey && !unattributed) unattributed = 'The application carries no recruiter';
    return {
      app,
      match: exact ? 'candidate + requirement' : (app ? 'candidate + client' : null),
      who,
      unattributed,
      role: roleOf(req?.title) || inv.candidate?.currentDesignation || null,
      section: req?.specialisation || req?.department || null,
      recruiter: inv.requirement?.recruiter?.name || app?.requirement?.recruiter?.name || null,
      joiningDate: inv.joiningDate || app?.joiningDate || null,
      offeredCtc: inv.offeredCtc ?? app?.offeredCtc ?? null,
      // The ATS's own joining status ("Joined", "Dropped" …) — the Invoice
      // page counts drop-outs from it; nothing is billed from it.
      joiningStatus: app?.joiningStatus || null,
    };
  };
}

async function buildRegister(user, query) {
  const where = invoiceWhere(user);
  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      client: true,
      candidate: true,
      requirement: { include: { recruiter: true, bde: true } },
      payments: { orderBy: { date: 'asc' } },
    },
    orderBy: { invoiceDate: 'desc' },
  });

  const range = dashRange(query.period);
  const inPeriod = invoices.filter((i) => range.all || inRange(i.invoiceDate, range));
  // The org hierarchy the filters cascade over, and each invoice's place in it.
  const hier = await loadHierarchy();
  const factsOf = await placementFacts(invoices, hier);
  const facts = new Map(invoices.map((i) => [i.id, factsOf(i)]));
  // Our state (Company GSTIN) for each invoice's CGST + SGST / IGST reading.
  const company = (await prisma.company.findFirst()) || {};
  // B2 — issued credit / debit notes per invoice (utils/invoiceTax.js withNotes).
  const notesOf = await CNU.notesByInvoice(null, { issuedOnly: true });

  const row = (i) => {
    const status = deriveInvoiceStatus(i);
    const fx = facts.get(i.id) || {};
    // P4: GST / TDS detail, read off the STORED amounts (never rewritten).
    const tx = TAX.taxView(i, { company });
    // B2 — with an issued note the money figures are AFTER the notes (the
    // stored invoice figures stay in asBilled); without one they are the
    // stored figures exactly as before.
    const wn = TAX.withNotes(i, notesOf.get(i.id) || []);
    const billing = wn.hasNotes ? wn.billing : ROUND(Number(i.amount || 0));
    const gst = wn.hasNotes ? wn.gst : ROUND(Number(i.gst || 0));
    const tds = wn.hasNotes ? wn.tds : ROUND(Number(i.tds || 0));
    const receivable = wn.hasNotes ? wn.receivable : invoiceTotal(i);
    const received = ROUND(Number(i.receivedAmount || 0));
    const who = fx.who || {};
    const sec = who.sectionKey ? hier.sectionByKey.get(who.sectionKey) : null;
    return {
      id: i.id,
      invoiceNumber: i.invoiceNumber || i.id.slice(-6),
      invoiceDate: i.invoiceDate,
      client: i.client?.name || '—',
      clientId: i.clientId,
      invoiceMonth: String(i.invoiceDate || '').slice(0, 7),
      invoiceMonthLabel: monthLabel(String(i.invoiceDate || '').slice(0, 7)),
      // "Billing type" is how the fee was arrived at, as the client agreement states it.
      billingType: billingLabel(i.client, i),
      clientGstin: i.client?.gst || '',
      // The GSTIN cell's own words when we do not hold the number itself.
      clientGstinText: clientGstinText(i.client).text,
      clientGstinKind: clientGstinText(i.client).kind,
      // THE HIERARCHY (utils/invoiceHierarchy.js): the department and section
      // of the seat the placement was worked from; with no seat, the
      // requirement's department, else the client's owner department.
      department: who.department || i.client?.ownerDepartment || '—',
      departmentFrom: who.departmentFrom || 'client',
      clientDepartment: i.client?.ownerDepartment || null,
      sectionKey: who.sectionKey || null,
      section: sec ? sec.label : null,
      // The placement's specialisation (what "Section" showed before).
      specialisation: fx.section || null,
      // Recruiter / TL by EMPLOYEE key — the filter matches on these, never on names.
      recruiter: who.recruiterName || null,
      recruiterKey: who.recruiterKey || null,
      tl: who.tlName || null,
      tlKey: who.tlKey || null,
      seat: who.seat || null,
      employeeRole: who.recruiterKey ? 'Recruiter' : (who.tlKey ? 'TL' : null),
      attribution: fx.unattributed || null,
      attributionMatch: fx.match || null,
      role: fx.role || null,
      joiningDate: fx.joiningDate || null,
      offeredCtc: fx.offeredCtc ?? null,
      feePercent: i.feePercent ?? i.client?.agreementFeePercent ?? null,
      notes: i.notes || null,
      bde: i.requirement?.bde?.name || null,
      candidates: i.candidateId ? 1 : 0,
      candidateName: i.candidate?.name || null,
      // Read only by the Invoice page's search box ("Search anything") and the
      // Payment-date period filter — no figure is worked out from them.
      candidatePhone: i.candidate?.phone || null,
      joiningStatus: fx.joiningStatus || null,
      paidDate: i.paidDate || null,
      clientPayingGst: gst > 0.5,
      // Money, in the prototype's own column order: before GST, GST, after GST,
      // TDS, receivable. Receivable is amount + GST − TDS.
      billing,
      gst,
      invoiceValue: ROUND(billing + gst),
      tds,
      receivable,
      received,
      // B2: pending = receivable − received + refund due (a credit beyond the balance is owed back, never a negative balance).
      pending: wn.hasNotes ? wn.pending : ROUND(receivable - received),
      asBilled: wn.asBilled,
      noteCredit: wn.hasNotes ? { count: wn.credit.count, base: wn.credit.base, gst: wn.credit.gst, tds: wn.credit.tds, net: wn.credit.net, applied: wn.credit.applied, numbers: wn.credit.numbers } : null,
      noteDebit: wn.debit.count ? { count: wn.debit.count, base: wn.debit.base, gst: wn.debit.gst, tds: wn.debit.tds, net: wn.debit.net, numbers: wn.debit.numbers } : null,
      refundDue: wn.refundDue,
      refundOpen: wn.refundOpen,
      applicationId: fx.app ? fx.app.id : null,
      paymentCount: i.payments.length,
      paymentMethods: [...new Set(i.payments.map((p) => p.method || '—'))],
      proof: i.payments.length ? (i.payments.some((p) => !p.reference) ? `${i.payments.filter((p) => !p.reference).length} pending` : 'attached') : null,
      tdsCert: tds > 0.5 ? (i.tdsCertReceived ? 'in hand' : 'to collect') : null,
      tdsCertRef: i.tdsCertRef,
      tdsCertDate: i.tdsCertDate,
      // Proof = the bank statement lines behind the receipts (InvoicePayment
      // .bankTxnId — auto-linked or confirmed on Bank & Reconciliation).
      proofCount: new Set(i.payments.map((p) => p.bankTxnId).filter(Boolean)).size,
      tdsCertReceived: !!i.tdsCertReceived,
      tdsCertHasFile: !!i.tdsCertFile,
      status,
      dueDate: i.dueDate,
      age: ageBucket(i),
      daysOverdue: daysOverdue(i.dueDate),
      sentVia: i.sentVia,
      sentDate: i.sentDate,
      // P4 — the rates as charged on THIS invoice (0 = not applicable), the
      // GST split and the TDS detail. billing / gst / invoiceValue / tds /
      // receivable / received / pending above stay the stored figures, so the
      // Accounts Dashboard (utils/accountsControl.js) ties to this page.
      gstPercent: tx.gstPercent,
      tdsPercent: tx.tdsPercent,
      gstApplicable: tx.gstApplicable,
      gstType: tx.gstType,
      gstTypeLabel: tx.gstTypeLabel,
      gstTypeFrom: tx.gstTypeFrom,
      cgst: tx.cgst,
      sgst: tx.sgst,
      igst: tx.igst,
      tdsApplicable: tx.tdsApplicable,
      tdsBase: tx.tdsBase,
      tdsSection: tx.tdsSection,
      tdsDeductedOn: tx.tdsDeductedOn,
      tdsStatus: status === 'Cancelled' ? 'Not Applicable' : tx.tdsStatus,
      taxCheck: tx.check.level === 'ok' ? null : { level: tx.check.level, issues: tx.check.issues.filter((x) => x.level !== 'info').map((x) => x.text) },
      payments: i.payments.map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method, reference: p.reference, recordedBy: p.recordedBy })),
    };
  };

  const rows = inPeriod.map(row).filter((r) => r.status !== 'Cancelled' || String(query.includeCancelled) === '1');
  const live = rows.filter((r) => r.status !== 'Cancelled');
  const sum = (k) => ROUND(live.reduce((s, r) => s + r[k], 0));
  const overdue = live.filter((r) => r.pending > 0.5 && r.daysOverdue != null && r.daysOverdue > 0);

  const ageing = [...AGE_BUCKETS, 'Settled'].map((bucket) => {
    const list = rows.filter((r) => r.age === bucket);
    return { bucket, count: list.length, outstanding: ROUND(list.reduce((s, r) => s + r.pending, 0)) };
  }).filter((b) => b.bucket !== 'Settled' || b.count > 0);

  const tdsToCollect = live.filter((r) => r.tds > 0.5 && !r.tdsCert?.startsWith('in hand'));
  const tdsInHand = live.filter((r) => r.tds > 0.5 && r.tdsCert === 'in hand');

  // "N joining(s) have no invoice number yet" — candidates the ATS has marked
  // joined that Accounts has never billed. One invoice per client per joining
  // month, the way the tracker has always done it.
  const { all: waitingAll, ...noInvoice } = await pendingJoinGroups(hier);
  noInvoice.recruiters = [...new Set(waitingAll.map((r) => r.recruiter).filter(Boolean))].sort();
  // Every waiting joining with its client and place in the hierarchy, so the
  // card follows the same Client / Department / Section / Employee filters.
  // Only what the card shows and filters on — there can be hundreds.
  noInvoice.rows = waitingAll.map((r) => ({
    applicationId: r.applicationId,
    name: r.name,
    client: r.client,
    clientId: r.clientId,
    joiningDate: r.joiningDate,
    billing: r.billing,
    billable: r.billable,
    gstPercent: r.gstPercent,
    recruiterKey: r.recruiterKey || null,
    tlKey: r.tlKey || null,
    department: r.department || null,
    sectionKey: r.sectionKey || null,
  }));
  // The card reads only the count and the first few names.
  noInvoice.notBillable = noInvoice.notBillable.map((r) => ({ applicationId: r.applicationId, name: r.name }));

  // Department -> Section -> TL + recruiters, loaded once with the register;
  // the screen computes every dropdown from it without another request.
  const hierarchy = hierarchyPayload(hier, [
    ...[...facts.values()].map((x) => x.who).filter(Boolean).map((w) => ({ ...w, invoice: true })),
    ...waitingAll.filter((r) => r.recruiterKey || r.tlKey).map((r) => ({
      recruiterKey: r.recruiterKey, recruiterName: r.recruiter, tlKey: r.tlKey, tlName: r.tl, seat: r.seat, department: r.department,
    })),
  ]);
  const allRows = invoices.map(row);
  const why = {};
  allRows.forEach((r) => { if (!r.recruiterKey) why[r.attribution || 'No recruiter on the application'] = (why[r.attribution || 'No recruiter on the application'] || 0) + 1; });
  const attribution = {
    invoices: allRows.length,
    withRecruiter: allRows.filter((r) => r.recruiterKey).length,
    withTl: allRows.filter((r) => r.tlKey).length,
    withSection: allRows.filter((r) => r.sectionKey).length,
    departmentFrom: allRows.reduce((m, r) => ({ ...m, [r.departmentFrom]: (m[r.departmentFrom] || 0) + 1 }), {}),
    byMatch: allRows.reduce((m, r) => ({ ...m, [r.attributionMatch || 'none']: (m[r.attributionMatch || 'none'] || 0) + 1 }), {}),
    unattributed: why,
    joinings: {
      waiting: waitingAll.length,
      withRecruiter: waitingAll.filter((r) => r.recruiterKey).length,
      withSection: waitingAll.filter((r) => r.sectionKey).length,
      // People named on waiting joinings who hold no seat in the structure.
      peopleOutsideStructure: hierarchy.outsideStructure,
    },
  };

  return {
    period: { sel: query.period || `FY:${new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1}`, ...range, options: periodOptions() },
    payStatuses: PAY_STATUS,
    // "By the client's whole history" — never / always / both ways.
    gstStance: gstStance(invoices),
    noInvoice,
    rows,
    kpis: {
      candidates: live.reduce((s, r) => s + r.candidates, 0),
      clients: new Set(live.map((r) => r.client)).size,
      invoices: live.length,
      billing: sum('billing'),
      gst: sum('gst'),
      invoiceValue: sum('invoiceValue'),
      tds: sum('tds'),
      receivable: sum('receivable'),
      received: sum('received'),
      pending: sum('pending'),
      overdueCount: overdue.length,
      overdueValue: ROUND(overdue.reduce((s, r) => s + r.pending, 0)),
      // B2 — issued notes inside the figures above, and refunds still owed back.
      creditNotes: ROUND(live.reduce((s, r) => s + (r.noteCredit ? r.noteCredit.net : 0), 0)),
      creditNotesBase: ROUND(live.reduce((s, r) => s + (r.noteCredit ? r.noteCredit.base : 0), 0)),
      debitNotes: ROUND(live.reduce((s, r) => s + (r.noteDebit ? r.noteDebit.net : 0), 0)),
      refundDue: sum('refundDue'),
      refundOpen: sum('refundOpen'),
      withNotes: live.filter((r) => r.noteCredit || r.noteDebit).length,
    },
    ageing,
    tdsCertificates: {
      toCollect: tdsToCollect.length,
      toCollectValue: ROUND(tdsToCollect.reduce((s, r) => s + r.tds, 0)),
      inHand: tdsInHand.length,
      inHandValue: ROUND(tdsInHand.reduce((s, r) => s + r.tds, 0)),
    },
    hierarchy,
    attribution,
    // P4 — older invoices whose stored GST / TDS do not match their own %s
    // (reported, never changed), and the words the edit form offers.
    taxChecks: allRows.filter((r) => r.taxCheck && r.taxCheck.level === 'mismatch')
      .map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber, client: r.client, issues: r.taxCheck.issues })),
    taxOptions: {
      gstTypes: TAX.GST_TYPES.map((v) => ({ value: v, label: TAX.GST_TYPE_LABEL[v] })),
      tdsBases: TAX.TDS_BASES.map((v) => ({ value: v, label: TAX.TDS_BASE_LABEL[v] })),
      tdsStatuses: TAX.TDS_STATUSES,
      tdsSections: TAX.TDS_SECTIONS,
    },
    departments: [...new Set([...hierarchy.departments.map((x) => x.name), ...allRows.map((r) => r.department)].filter((x) => x && x !== '—'))].sort(),
    recruiters: [...new Set(allRows.map((r) => r.recruiter).filter(Boolean))].sort(),
    sections: [...new Set(allRows.map((r) => r.section).filter(Boolean))].sort(),
    roles: [...new Set([...facts.values()].map((x) => x.role).filter(Boolean))].sort(),
    clients: [...new Set(invoices.map((i) => i.client?.name).filter(Boolean))].sort(),
  };
}

router.get('/register', async (req, res) => {
  res.json(await buildRegister(req.user, req.query));
});

// ⭳ Excel — exactly the invoices the screen is showing. The filters live in
// the browser, so the screen sends the ids it shows (in its own order) and a
// line describing the filters; every figure is re-read from the register here.
router.post('/register/export.xlsx', requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const reg = await buildRegister(req.user, { period: req.body?.period, includeCancelled: req.body?.includeCancelled });
  const byId = new Map(reg.rows.map((r) => [r.id, r]));
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  const list = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : reg.rows;
  const periodLabel = (reg.period.options.find((o) => o.value === reg.period.sel) || {}).label || reg.period.sel || 'All';
  const head = ['Invoice no', 'Invoice date', 'Client', 'Client GSTIN', 'Billing type', 'Candidate', 'Role', 'Section',
    'Department', 'Recruiter', 'GST charged', 'Before GST', 'GST', 'After GST', 'TDS', 'Receivable', 'Received',
    'Pending', 'Status', 'Due date', 'Age', 'Sent to client', 'TDS certificate',
    'GST type', 'GST %', 'CGST', 'SGST', 'IGST', 'TDS %', 'TDS on', 'TDS status',
    // B2 — money columns above are after issued notes; these say by how much.
    'Credit notes (net)', 'Debit notes (net)', 'Refund due', 'Note numbers'];
  const aoa = [
    ['Invoices'],
    [`Period: ${periodLabel}`],
    [`Filters: ${String(req.body?.filters || '').slice(0, 400) || 'none'}`],
    [],
    head,
  ];
  list.forEach((r) => {
    aoa.push([r.invoiceNumber, r.invoiceDate || '', r.client, r.clientGstin || '', r.billingType, r.candidateName || '',
      r.role || '', r.section || '', r.department || '', r.recruiter || '', r.clientPayingGst ? 'Yes' : 'No',
      r.billing, r.gst, r.invoiceValue, r.tds, r.receivable, r.received, r.pending, r.status, r.dueDate || '', r.age,
      r.sentVia ? `${r.sentVia} · ${r.sentDate || ''}` : 'Not sent', r.tdsCert || 'no TDS',
      r.gstTypeLabel || '', r.gstPercent || 0, r.cgst || 0, r.sgst || 0, r.igst || 0, r.tdsPercent || 0,
      r.tdsApplicable ? (r.tdsBase === 'gross' ? 'After GST' : 'Before GST') : '', r.tdsStatus || '',
      r.noteCredit ? r.noteCredit.net : 0, r.noteDebit ? r.noteDebit.net : 0, r.refundDue || 0,
      [...(r.noteCredit ? r.noteCredit.numbers : []), ...(r.noteDebit ? r.noteDebit.numbers : [])].join(', ')]);
  });
  if (!list.length) aoa.push(['No invoice matches these filters']);
  const sumOf = (k) => ROUND(list.reduce((a, r) => a + Number(r[k] || 0), 0));
  aoa.push(['TOTAL', '', `${list.length} invoice(s)`, '', '', '', '', '', '', '', '',
    sumOf('billing'), sumOf('gst'), sumOf('invoiceValue'), sumOf('tds'), sumOf('receivable'), sumOf('received'), sumOf('pending')]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 5; i < aoa.length; i += 1) {
    for (const c of [11, 12, 13, 14, 15, 16, 17, 25, 26, 27, 31, 32, 33]) {
      const ref = XLSX.utils.encode_cell({ r: i, c });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    }
  }
  ws['!cols'] = [14, 12, 34, 18, 22, 24, 22, 24, 14, 18, 8, 13, 12, 13, 12, 13, 13, 13, 14, 12, 12, 18, 14, 12, 7, 12, 12, 12, 7, 11, 18, 13, 13, 12, 22].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A5:AI${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await logAudit({
    userId: req.user.id, action: 'Invoices exported', entity: 'Invoice', toValue: `${list.length} invoice(s) · ${periodLabel}`,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  return res.send(buf);
});

// The Invoice page's two other downloads — "Invoice accounts" and
// "Instalments" — over exactly the invoices the screen shows (the same ids +
// filters line as ⭳ Excel). Read-only: every figure is the register's own.
async function pickedRegister(req) {
  const reg = await buildRegister(req.user, { period: req.body?.period, includeCancelled: req.body?.includeCancelled });
  const byId = new Map(reg.rows.map((r) => [r.id, r]));
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  const list = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : reg.rows;
  return { reg, list, filtersLine: String(req.body?.filters || '').slice(0, 400) || 'none' };
}
function sendBook(res, wb, name) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  return res.send(buf);
}
function moneyCols(ws, fromRow, toRow, cols) {
  for (let i = fromRow; i < toRow; i += 1) {
    cols.forEach((c) => {
      const ref = XLSX.utils.encode_cell({ r: i, c });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    });
  }
}
// What was received on an invoice beyond its receipt rows (older imports
// carry the received figure only) — the client ledger's own rule.
const unrecordedOf = (r) => ROUND(Number(r.received || 0) - (r.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0));

// Invoice accounts: one line per client (billed / received / pending) and the
// ledger behind it — invoice raised (debit = receivable), receipts (credit),
// running balance per client — as GET /client-account/:clientId builds it.
router.post('/register/accounts.xlsx', requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const { list, filtersLine } = await pickedRegister(req);
  const live = list.filter((r) => r.status !== 'Cancelled');
  const byClient = new Map();
  live.forEach((r) => { if (!byClient.has(r.client)) byClient.set(r.client, []); byClient.get(r.client).push(r); });
  const clients = [...byClient.keys()].sort((a, b) => a.localeCompare(b));
  const s = (rs, k) => ROUND(rs.reduce((a, r) => a + Number(r[k] || 0), 0));
  const sumHead = ['Client', 'Invoices', 'Before GST', 'GST', 'After GST', 'TDS', 'Receivable', 'Received', 'Pending', 'Overdue invoices', 'Oldest open due date'];
  const sumAoa = [['Invoice accounts — by client'], [`Filters: ${filtersLine}`], [], sumHead];
  clients.forEach((c) => {
    const rs = byClient.get(c);
    const open = rs.filter((r) => r.pending > 0.5);
    sumAoa.push([c, rs.length, s(rs, 'billing'), s(rs, 'gst'), s(rs, 'invoiceValue'), s(rs, 'tds'), s(rs, 'receivable'), s(rs, 'received'), s(rs, 'pending'),
      open.filter((r) => r.daysOverdue != null && r.daysOverdue > 0).length,
      open.map((r) => r.dueDate).filter(Boolean).sort()[0] || '']);
  });
  if (!clients.length) sumAoa.push(['No invoice matches these filters']);
  sumAoa.push(['TOTAL', live.length, s(live, 'billing'), s(live, 'gst'), s(live, 'invoiceValue'), s(live, 'tds'), s(live, 'receivable'), s(live, 'received'), s(live, 'pending')]);
  const ws1 = XLSX.utils.aoa_to_sheet(sumAoa);
  moneyCols(ws1, 4, sumAoa.length, [2, 3, 4, 5, 6, 7, 8]);
  ws1['!cols'] = [34, 9, 14, 13, 14, 12, 14, 14, 14, 10, 14].map((wch) => ({ wch }));

  const ledHead = ['Client', 'Date', 'Invoice no', 'Particulars', 'Debit', 'Credit', 'Balance'];
  const ledAoa = [['Invoice accounts — ledger'], [`Filters: ${filtersLine}`], [], ledHead];
  clients.forEach((c) => {
    const lines = [];
    byClient.get(c).forEach((r) => {
      lines.push({ date: r.invoiceDate, inv: true, no: r.invoiceNumber, text: `Invoice ${r.invoiceNumber}${r.candidateName ? ` · ${r.candidateName}` : ''}`, debit: r.receivable, credit: 0 });
      (r.payments || []).forEach((p) => lines.push({
        date: p.date, no: r.invoiceNumber, text: `Received · ${p.method || '—'}${p.reference ? ` · ${p.reference}` : ''}`, debit: 0, credit: ROUND(Number(p.amount || 0)),
      }));
      const extra = unrecordedOf(r);
      if (extra > 0.5) lines.push({ date: r.paidDate || r.invoiceDate, no: r.invoiceNumber, text: 'Received (imported total, no receipt detail)', debit: 0, credit: extra });
    });
    lines.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.inv ? -1 : 1));
    let bal = 0;
    lines.forEach((l) => { bal = ROUND(bal + l.debit - l.credit); ledAoa.push([c, l.date || '', l.no, l.text, l.debit || '', l.credit || '', bal]); });
  });
  const ws2 = XLSX.utils.aoa_to_sheet(ledAoa);
  moneyCols(ws2, 4, ledAoa.length, [4, 5, 6]);
  ws2['!cols'] = [34, 12, 14, 48, 14, 14, 14].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'By client');
  XLSX.utils.book_append_sheet(wb, ws2, 'Ledger');
  await logAudit({ userId: req.user.id, action: 'Invoice accounts exported', entity: 'Invoice', toValue: `${live.length} invoice(s) · ${clients.length} client(s)` });
  return sendBook(res, wb, 'invoice-accounts');
});

// Instalments: one line per payment received against the invoices shown, plus
// any received total an older import carried without receipt detail.
router.post('/register/instalments.xlsx', requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const { list, filtersLine } = await pickedRegister(req);
  const head = ['Invoice no', 'Invoice date', 'Client', 'Candidate', 'Instalment', 'Payment date', 'Amount', 'Method', 'Reference', 'Recorded by', 'Invoice receivable', 'Invoice pending'];
  const aoa = [['Instalments'], [`Filters: ${filtersLine}`], [], head];
  let total = 0;
  let lines = 0;
  list.forEach((r) => {
    (r.payments || []).forEach((p, ix) => {
      const amt = ROUND(Number(p.amount || 0));
      total = ROUND(total + amt); lines += 1;
      aoa.push([r.invoiceNumber, r.invoiceDate || '', r.client, r.candidateName || '', ix + 1, p.date || '', amt, p.method || '', p.reference || '', p.recordedBy || '', r.receivable, r.pending]);
    });
    const extra = unrecordedOf(r);
    if (extra > 0.5) {
      total = ROUND(total + extra); lines += 1;
      aoa.push([r.invoiceNumber, r.invoiceDate || '', r.client, r.candidateName || '', '—', r.paidDate || '', extra, 'Imported total (no receipt detail)', '', '', r.receivable, r.pending]);
    }
  });
  if (!lines) aoa.push(['No payment has been received on these invoices yet']);
  aoa.push(['TOTAL', '', `${list.length} invoice(s)`, '', `${lines} line(s)`, '', total]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  moneyCols(ws, 4, aoa.length, [6, 10, 11]);
  ws['!cols'] = [14, 12, 34, 24, 10, 12, 14, 26, 22, 18, 14, 14].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Instalments');
  await logAudit({ userId: req.user.id, action: 'Instalments exported', entity: 'Invoice', toValue: `${lines} line(s) · ${list.length} invoice(s)` });
  return sendBook(res, wb, 'instalments');
});

// ＋ New join — every joining still waiting for its invoice, with what the
// invoice would be raised for.
router.get('/joinings', async (req, res) => {
  const plan = await pendingJoinGroups();
  // P4 — what each joining's invoice starts with: the client's GST / TDS
  // (Applicable flags, rates) and CGST + SGST vs IGST from the two states.
  const company = (await prisma.company.findFirst()) || {};
  const ids = [...new Set(plan.all.map((r) => r.clientId).filter(Boolean))];
  const clients = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const rows = plan.all.map((r) => {
    const d = TAX.defaultsFor(byId.get(r.clientId) || {}, company, { gst: 18, tds: 10 });
    return {
      ...r,
      taxDefaults: {
        gstType: d.gstType, gstTypeFrom: d.gstTypeFrom, gstPercent: d.gstPercent, tdsPercent: d.tdsPercent, tdsBase: d.tdsBase, supplyWhy: d.supply.why,
      },
    };
  });
  res.json({
    rows,
    nextNumber: plan.nextNumber,
    taxOptions: {
      gstTypes: TAX.GST_TYPES.map((v) => ({ value: v, label: TAX.GST_TYPE_LABEL[v] })),
      tdsBases: TAX.TDS_BASES.map((v) => ({ value: v, label: TAX.TDS_BASE_LABEL[v] })),
      tdsSections: TAX.TDS_SECTIONS,
    },
  });
});

// Raise the invoice for ONE joined candidate through the ATS's own
// joining -> invoice path (utils/joining.js raiseJoiningInvoice — the same
// function the pipeline's JOINED move calls, keyed on candidate + requirement),
// then give it the next number in the series and mark the application
// Invoiced. The CTC (and, optionally, the joining date and a fee % for this
// deal) are written back to the application first so the ATS and the invoice
// agree.
router.post('/joinings/:applicationId/raise', requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const app = await prisma.application.findUnique({
    where: { id: req.params.applicationId },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!app) return res.status(404).json({ error: 'That joining was not found' });
  if (!['JOINED', 'HIRED'].includes(app.stage)) return res.status(400).json({ error: 'Only a candidate the ATS shows as joined can be invoiced' });
  if (isInternalHire(app, app.requirement)) return res.status(400).json({ error: 'An internal TeamLink hire is never invoiced to a client' });
  if (!app.requirement?.client) return res.status(400).json({ error: 'This joining has no client on its requirement' });
  const already = await prisma.invoice.findFirst({ where: { candidateId: app.candidateId, requirementId: app.requirementId } });
  if (already) return res.status(409).json({ error: `Already invoiced as ${already.invoiceNumber || already.id.slice(-6)}` });

  const body = req.body || {};
  const ctc = body.offeredCtc !== undefined && body.offeredCtc !== '' && body.offeredCtc !== null
    ? Number(body.offeredCtc) : Number(app.offeredCtc);
  if (!(ctc > 0)) return res.status(400).json({ error: "Enter the candidate's annual CTC — the fee is a percentage of it" });
  const joiningDate = String(body.joiningDate || app.joiningDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) return res.status(400).json({ error: 'The joining date is not a date' });
  const fee = body.feePercent !== undefined && body.feePercent !== '' && body.feePercent !== null ? Number(body.feePercent) : null;
  if (fee != null && !(fee > 0 && fee <= 100)) return res.status(400).json({ error: 'The fee % must be more than 0 and at most 100' });

  // P4 — the GST / TDS the screen chose (client defaults otherwise), checked
  // BEFORE anything is written. The amount before GST is the fee on the CTC.
  const cli = app.requirement.client;
  const taxDef = TAX.defaultsFor(cli, (await prisma.company.findFirst()) || {}, { gst: 18, tds: 10 });
  const feeUsed = fee != null ? fee : (cli.agreementFeePercent != null ? cli.agreementFeePercent : 8.33);
  const taxBody = {
    gstApplicable: body.gstApplicable, gstType: body.gstType, gstPercent: body.gstPercent, gst: body.gst,
    tdsApplicable: body.tdsApplicable, tdsPercent: body.tdsPercent, tdsBase: body.tdsBase, tds: body.tds, tdsSection: body.tdsSection,
  };
  const taxIn = TAX.readTaxInput({ ...taxBody, amount: Math.round((ctc * feeUsed) / 100) }, {}, taxDef);
  if (taxIn.error) return res.status(400).json({ error: taxIn.error });

  await prisma.application.update({ where: { id: app.id }, data: { offeredCtc: ctc, joiningDate } });
  const raised = await raiseJoiningInvoice({
    application: { ...app, offeredCtc: ctc, joiningDate },
    existing: app,
    userId: req.user.id,
  });
  if (!raised) return res.status(400).json({ error: 'This joining cannot be invoiced' });
  // B7: a partner-sourced joining invoiced later still gets its payout draft.
  try { await require('../utils/partners').onJoined({ applicationId: app.id, invoice: raised, userId: req.user.id }); } catch { /* optional */ } // eslint-disable-line global-require

  const data = {};
  if (fee != null && fee !== raised.feePercent) data.feePercent = fee;
  // The base the invoice was raised for (the fee on the CTC), taxed exactly as chosen.
  const finalBase = data.feePercent != null ? Math.round((ctc * fee) / 100) : Number(raised.amount);
  const finalTax = TAX.readTaxInput({ ...taxBody, gst: undefined, tds: undefined, amount: finalBase }, {}, taxDef);
  if (!finalTax.error) {
    const want = finalTax.data;
    const moved = Object.keys(want).some((k) => want[k] !== undefined && want[k] !== raised[k]);
    if (moved) Object.assign(data, want);
  }
  if (!raised.invoiceNumber) data.invoiceNumber = await nextInvoiceNumber();
  const invoice = Object.keys(data).length
    ? await prisma.invoice.update({ where: { id: raised.id }, data })
    : raised;
  await prisma.application.update({
    where: { id: app.id },
    data: { billingStatus: 'Invoiced', joiningStatus: app.joiningStatus || 'Joined' },
  });
  await logAudit({
    userId: req.user.id,
    action: 'Invoice raised for joining',
    entity: 'Invoice',
    entityId: invoice.id,
    toValue: `${invoice.invoiceNumber} · ${app.requirement.client.name} · ${app.candidate?.name || '—'}`,
  });
  return res.status(201).json(decorate(invoice));
});

// ---------------------------------------------------------------------------
// The printable tax invoice, as one payload. Everything the document prints —
// letterhead, Bill To, the line table with its CGST/SGST or IGST split, the
// totals, the amount in words and the bank notes — is worked out here so the
// client copy and the internal copy can never disagree with the register.
// ---------------------------------------------------------------------------
router.get('/:id/document', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      client: true,
      candidate: true,
      requirement: { include: { recruiter: true } },
      payments: { orderBy: { date: 'asc' } },
    },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!matches(invoice, invoiceWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const co = (await prisma.company.findFirst()) || {};
  const cli = invoice.client || {};

  const billing = ROUND(Number(invoice.amount || 0));
  const gst = ROUND(Number(invoice.gst || 0));
  const tds = ROUND(Number(invoice.tds || 0));
  const invoiceValue = ROUND(billing + gst);
  const receivable = ROUND(invoiceValue - tds);
  const paid = ROUND(Number(invoice.receivedAmount || 0));
  // TDS never reaches us — the client withholds it and pays it to Government on
  // our behalf, so what is owed is the invoice less TDS, less what has come in.
  // B2 — issued credit notes set against it / debit notes added (0 without one).
  const noteCredited = ROUND(Number(invoice.creditedAmount || 0));
  const noteDebited = ROUND(Number(invoice.debitedAmount || 0));
  const balance = ROUND((tds > 0 ? receivable : invoiceValue) - paid - noteCredited + noteDebited);

  // P4 — the invoice's own GST / TDS reading (utils/invoiceTax.js): the rate
  // as charged (0 when no GST / TDS), the GST type saved on it or read from
  // the two states, and the CGST / SGST / IGST split of the STORED GST.
  const tx = TAX.taxView(invoice, { company: co });
  const gstPct = tx.gstPercent;
  const tdsPct = tx.tdsPercent;

  // CGST + SGST within the state, IGST across states. Our state comes from
  // the Company GSTIN's first two digits (else the state on the Company row);
  // the client's from its GSTIN (else its address). Unknown on either side is
  // treated as intra-state — never a silent IGST.
  const clientAddress = [cli.houseNumber, cli.street, cli.area, cli.landmark, cli.location, cli.state, cli.pincode]
    .filter(Boolean).join(', ');
  const gstinState = (g) => {
    const c = String(g || '').trim().toUpperCase();
    return /^\d{2}[A-Z0-9]{13}$/.test(c) && gstStateName(c.slice(0, 2)) ? { code: c.slice(0, 2), name: gstStateName(c.slice(0, 2)) } : null;
  };
  const cs = gstinState(cli.gst) || stateOf(`${clientAddress} ${cli.state || ''}`);
  const hs = gstinState(co.gstin) || stateOf(co.state || co.address || '');
  const inter = tx.gstType === 'IGST';
  const fx = (await placementFacts([invoice]))(invoice);
  const half = tx.cgst;

  const coAddr = [co.address, [co.city, co.state].filter(Boolean).join(', '), co.pin, 'India']
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  res.json({
    title: gst > 0 ? 'TAX INVOICE' : 'INVOICE',
    company: {
      legalName: co.legalName || co.name || 'Teamlink Consultants',
      tagline: co.tagline || '',
      addressLines: coAddr,
      gstin: co.gstin || '',
      pan: co.pan || (co.gstin && String(co.gstin).length >= 12 ? String(co.gstin).slice(2, 12) : ''),
      email: co.email || '',
      phone: co.phone || '',
      logoUrl: co.logoUrl || '',
      sac: co.sac || '998512',
      state: co.state || '',
      bank: {
        accountName: co.accountName || co.legalName || co.name || '',
        bankName: co.bankName || '',
        accountNumber: co.accountNumber || '',
        ifsc: co.ifsc || '',
        branch: co.branch || '',
        accountType: co.accountType || '',
        upi: co.upi || '',
      },
    },
    client: {
      // Add client section 6 (2026-10-05): the legal name and the billing
      // address when the client record has them.
      name: cli.legalName || cli.name || '—',
      addressLines: (!cli.billingSameAsAddress && String(cli.billingAddress || '').trim())
        ? String(cli.billingAddress).split(/,|\n/).map((s) => s.trim()).filter(Boolean)
        : (clientAddress ? clientAddress.split(',').map((s) => s.trim()).filter(Boolean) : []),
      gstin: cli.gst || '',
      email: cli.invoiceEmail || cli.billingEmail || cli.billingContactEmail || '',
    },
    invoiceNumber: invoice.invoiceNumber || invoice.id.slice(-6),
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate || invoice.invoiceDate,
    terms: co.invoiceTerms || invoice.paymentTerms || 'Due on Receipt',
    billingType: billingLabel(cli, invoice),
    placeOfSupply: cs ? `${cs.name} (${cs.code})` : placeOfSupply(`${clientAddress} ${cli.state || ''}`, co.state || ''),
    supplyType: inter ? 'Inter-state' : 'Intra-state',
    ourState: hs ? `${hs.name} (${hs.code})` : null,
    clientState: cs ? `${cs.name} (${cs.code})` : null,
    inter,
    gstPct,
    halfPct: ROUND(gstPct / 2),
    tdsPct,
    gstType: tx.gstType,
    gstTypeLabel: tx.gstTypeLabel,
    tdsBase: tx.tdsBase,
    tdsBaseLabel: tx.tdsBaseLabel,
    tdsSection: tx.tdsSection || '194J',
    lines: [{
      n: 1,
      candidate: invoice.candidate?.name || null,
      role: fx.role,
      joiningDate: fx.joiningDate,
      offeredCtc: fx.offeredCtc,
      feePercent: invoice.feePercent ?? cli.agreementFeePercent ?? null,
      description: invoice.candidate?.name || invoice.notes || 'Recruitment services',
      department: cli.ownerDepartment || '',
      recruiter: invoice.requirement?.recruiter?.name || '',
      salary: invoice.offeredCtc != null ? Math.round(Number(invoice.offeredCtc) / 12) : null,
      sac: co.sac || '998512',
      qty: 1,
      rate: billing,
      gst,
      cgst: half,
      sgst: ROUND(gst - half),
      amount: billing,
    }],
    totals: {
      subTotal: billing, gst, cgst: half, sgst: ROUND(gst - half), invoiceValue, tds, receivable, paid, credited: noteCredited, debited: noteDebited, balance: balance > 0 ? balance : 0,
    },
    words: {
      total: wordsINR(invoiceValue),
      netAfterTds: tds > 0 ? wordsINR(receivable) : null,
    },
  });
});

router.get('/:id', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { client: true, candidate: true, requirement: true, payments: { orderBy: { date: 'asc' } } },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!matches(invoice, invoiceWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const synced = await syncStatus(invoice);
  // The bank statement lines behind this invoice's receipts — the proof of
  // payment. One line can pay several invoices (oldest first), so the amount
  // applied here is shown beside the line's own amount.
  const txnIds = [...new Set((invoice.payments || []).map((p) => p.bankTxnId).filter(Boolean))];
  const txns = txnIds.length ? await prisma.bankTransaction.findMany({ where: { id: { in: txnIds } } }) : [];
  const accs = txns.length ? await prisma.bankAccount.findMany({ select: { id: true, bank: true, accNo: true } }) : [];
  const accOf = (id) => accs.find((a) => a.id === id) || accs[0] || null;
  const proofLines = txns.map((t) => {
    const acc = accOf(t.bankAccountId);
    const applied = ROUND((invoice.payments || []).filter((p) => p.bankTxnId === t.id).reduce((s, p) => s + Number(p.amount || 0), 0));
    return {
      txnId: t.id,
      date: t.date,
      reference: t.reference || null,
      description: t.description,
      amount: ROUND(t.amount),
      applied,
      linkedOnly: (invoice.payments || []).some((p) => p.bankTxnId === t.id && p.bankLinked),
      bank: acc ? `${acc.bank}${acc.accNo ? ` · xxxx${String(acc.accNo).slice(-4)}` : ''}` : null,
    };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const { tdsCertFile, ...rest } = decorate(synced);
  // P4 — the GST / TDS summary and what the Edit form offers.
  const company = (await prisma.company.findFirst()) || {};
  // B2 — this invoice's credit / debit notes and its figures after them.
  const notes = CNU.ready() ? ((await CNU.notesByInvoice([invoice.id])).get(invoice.id) || []) : [];
  const wn = TAX.withNotes(synced, notes);
  res.json({
    ...rest, tdsCertHasFile: !!tdsCertFile, proofLines, ...taxPayload(synced, company),
    notesReady: CNU.ready(),
    creditNotes: notes.map((n) => CNU.shapeNote(n, invoice)),
    afterNotes: wn.hasNotes ? {
      billing: wn.billing, gst: wn.gst, tds: wn.tds, receivable: wn.receivable, pending: wn.pending, refundDue: wn.refundDue, refundOpen: wn.refundOpen, credit: wn.credit, debit: wn.debit,
    } : null,
    canApproveNotes: CNU.ready() ? await CNU.isNoteApprover(req.user) : false,
    margin: await invoiceMargin(synced, wn),
  });
});

// B2 — the placement margin of this one invoice, by the same rule as the
// Placement margin report (utils/creditNotes.js marginRows).
async function invoiceMargin(invoice, wn) {
  const fx = (await placementFacts([invoice]))(invoice);
  const appId = fx.app ? fx.app.id : null;
  const { costs } = await CNU.directCosts();
  const c = (appId && costs.get(appId)) || { incentive: 0, payout: 0, incentiveStatus: 'Incentive not decided', decided: false };
  const fee = wn.asBilled.billing;
  const net = ROUND(fee - wn.credit.base + wn.debit.base);
  const margin = ROUND(net - c.incentive - c.payout);
  return {
    fee, credit: wn.credit.base, debit: wn.debit.base, net, incentive: ROUND(c.incentive), incentiveStatus: c.incentiveStatus, payout: ROUND(c.payout), margin,
    marginPct: fee > 0 ? Math.round((margin / fee) * 1000) / 10 : null, applicationId: appId,
  };
}

// The invoice's GST / TDS reading (stored figures), plus the Edit form's options.
function taxPayload(invoice, company) {
  const def = TAX.defaultsFor(invoice.client || {}, company, { gst: 0, tds: 0 });
  return {
    tax: TAX.taxView(invoice, { company }),
    taxDefaults: { gstType: def.gstType, gstPercent: def.gstPercent, tdsPercent: def.tdsPercent, supplyWhy: def.supply.why },
    taxOptions: {
      gstTypes: TAX.GST_TYPES.map((v) => ({ value: v, label: TAX.GST_TYPE_LABEL[v] })),
      tdsBases: TAX.TDS_BASES.map((v) => ({ value: v, label: TAX.TDS_BASE_LABEL[v] })),
      tdsSections: TAX.TDS_SECTIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// The client's account — every invoice raised to one client and every receipt
// against them, as a running ledger (debit = invoice receivable after TDS,
// credit = money received). Opened from the "Account" action on the register.
// Scoped exactly like the register (utils/scope.js invoiceWhere).
// ---------------------------------------------------------------------------
router.get('/client-account/:clientId', async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.clientId },
    select: { id: true, name: true, gst: true, paymentTerms: true },
  });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const invoices = await prisma.invoice.findMany({
    where: { AND: [invoiceWhere(req.user), { clientId: client.id }] },
    include: { payments: { orderBy: { date: 'asc' } }, candidate: { select: { name: true } } },
    orderBy: { invoiceDate: 'asc' },
  });
  const lines = [];
  const accNotes = await CNU.notesByInvoice(invoices.map((i) => i.id), { issuedOnly: true });
  invoices.forEach((i) => {
    const status = deriveInvoiceStatus(i);
    if (status === 'Cancelled') return;
    const no = i.invoiceNumber || i.id.slice(-6);
    lines.push({
      date: i.invoiceDate, kind: 'invoice', invoiceId: i.id, invoiceNumber: no,
      particulars: `Invoice ${no}${i.candidate?.name ? ` · ${i.candidate.name}` : ''}`,
      debit: invoiceTotal(i), credit: 0,
    });
    const recorded = ROUND(i.payments.reduce((s, p) => s + Number(p.amount || 0), 0));
    i.payments.forEach((p) => lines.push({
      date: p.date, kind: 'receipt', invoiceId: i.id, invoiceNumber: no,
      particulars: `Received · ${p.method || '—'}${p.reference ? ` · ${p.reference}` : ''} · against ${no}`,
      debit: 0, credit: ROUND(p.amount), fromBank: !!p.bankTxnId,
    }));
    // B2 — issued notes: a credit note is a credit, a debit note a debit, and
    // a refund paid back to the client a debit (a credit beyond the balance
    // shows as money owed to the client until then).
    (accNotes.get(i.id) || []).forEach((n) => {
      lines.push({
        date: n.noteDate, kind: n.kind === 'debit' ? 'debit-note' : 'credit-note', invoiceId: i.id, invoiceNumber: no,
        particulars: `${n.kind === 'debit' ? 'Debit' : 'Credit'} note ${n.number} · ${TAX.reasonLabel(n.kind, n.reason)} · against ${no}`,
        debit: n.kind === 'debit' ? ROUND(n.net) : 0, credit: n.kind === 'debit' ? 0 : ROUND(n.net),
      });
      if (n.kind !== 'debit' && n.refundPaidOn && Number(n.refundDue || 0) > 0.005) {
        lines.push({
          date: n.refundPaidOn, kind: 'refund', invoiceId: i.id, invoiceNumber: no,
          particulars: `Refund paid to the client · ${n.number}${n.refundRef ? ` · ${n.refundRef}` : ''}`,
          debit: ROUND(n.refundDue), credit: 0,
        });
      }
    });
    // Money on the invoice with no receipt row behind it (older imports carry
    // the received figure only) still belongs in the account.
    const unrecorded = ROUND(Number(i.receivedAmount || 0) - recorded);
    if (unrecorded > 0.5) {
      lines.push({
        date: i.paidDate || i.invoiceDate, kind: 'receipt', invoiceId: i.id, invoiceNumber: no,
        particulars: `Received (imported total, no receipt detail) · against ${no}`,
        debit: 0, credit: unrecorded,
      });
    }
  });
  lines.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.kind === 'invoice' ? -1 : 1));
  let bal = 0;
  lines.forEach((l) => { bal = ROUND(bal + l.debit - l.credit); l.balance = bal; });
  const live = invoices.filter((i) => deriveInvoiceStatus(i) !== 'Cancelled');
  res.json({
    client,
    lines,
    invoices: live.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber || i.id.slice(-6),
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      receivable: invoiceTotal(i),
      received: ROUND(Number(i.receivedAmount || 0)),
      pending: invoiceOutstanding(i),
      status: deriveInvoiceStatus(i),
    })),
    totals: {
      invoices: live.length,
      billed: ROUND(live.reduce((s, i) => s + invoiceTotal(i), 0)),
      received: ROUND(live.reduce((s, i) => s + Number(i.receivedAmount || 0), 0)),
      pending: ROUND(live.reduce((s, i) => s + invoiceOutstanding(i), 0)),
    },
  });
});

// The Form 16A file against an invoice — upload (PNG / JPEG / WebP / PDF, the
// shared utils/attachments.js rules), view, remove. Uploading also marks the
// certificate received, since the paper is in hand.
router.post('/:id/tds-certificate/file', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (Number(invoice.tds || 0) <= 0.5) return res.status(400).json({ error: 'No TDS was deducted on this invoice' });
  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
  }
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
  }
  if (invoice.tdsCertFile) attachments.remove(invoice.tdsCertFile);
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      tdsCertFile: stored.billFile,
      tdsCertName: stored.billName,
      tdsCertMime: stored.billMime,
      tdsCertReceived: true,
      tdsCertDate: invoice.tdsCertDate || new Date().toISOString().slice(0, 10),
      tdsCertRef: invoice.tdsCertRef || (parsed.fields.reference ? String(parsed.fields.reference).slice(0, 80) : null),
    },
  });
  await logAudit({ userId: req.user.id, action: 'TDS certificate uploaded', entity: 'Invoice', entityId: invoice.id, toValue: stored.billName });
  const { tdsCertFile, ...rest } = decorate(updated);
  return res.json({ ...rest, tdsCertHasFile: !!tdsCertFile });
});

router.get('/:id/tds-certificate/file', async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!matches(invoice, invoiceWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  const full = invoice.tdsCertFile ? attachments.resolveStored(invoice.tdsCertFile) : null;
  if (!full) return res.status(404).json({ error: 'No TDS certificate file is on file for this invoice' });
  res.setHeader('Content-Type', invoice.tdsCertMime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${attachments.safeDisplayName(invoice.tdsCertName)}"`);
  return res.sendFile(full);
});

router.delete('/:id/tds-certificate/file', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!invoice.tdsCertFile) return res.status(400).json({ error: 'No file to remove' });
  attachments.remove(invoice.tdsCertFile);
  await prisma.invoice.update({ where: { id: invoice.id }, data: { tdsCertFile: null, tdsCertName: null, tdsCertMime: null } });
  await logAudit({ userId: req.user.id, action: 'TDS certificate file removed', entity: 'Invoice', entityId: invoice.id, fromValue: invoice.tdsCertName || '' });
  return res.json({ removed: true });
});

router.post('/', requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const { clientId, candidateId, requirementId, amount, gst, tds, invoiceDate, dueDate, paymentTerms, notes } = req.body;
  if (!clientId || !amount || !invoiceDate) return res.status(400).json({ error: 'clientId, amount and invoiceDate are required' });
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return res.status(400).json({ error: 'That client does not exist' });
  const terms = paymentTerms || client.paymentTerms || 'Net 30';
  // GST and TDS ride on the client's own agreed rates (and its GST / TDS
  // Applicable flags) — never a hardcoded figure — unless this deal overrides
  // them. P4: the amounts are ALWAYS the percentages' (utils/invoiceTax.js); an
  // amount sent that does not match its % is refused, not stored.
  const company = (await prisma.company.findFirst()) || {};
  const taxIn = TAX.readTaxInput({ ...req.body, gst, tds }, {}, TAX.defaultsFor(client, company, { gst: 0, tds: 0 }));
  if (taxIn.error) return res.status(400).json({ error: taxIn.error });
  const invoice = await prisma.invoice.create({
    data: {
      clientId,
      candidateId: candidateId || null,
      requirementId: requirementId || null,
      ...taxIn.data,
      invoiceDate,
      // A blank due date is derived from the payment terms rather than left empty,
      // otherwise nothing can ever go Overdue.
      dueDate: dueDate || dueDateFor(invoiceDate, terms),
      paymentTerms: terms,
      notes: notes || null,
      invoiceNumber: await nextInvoiceNumber(),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Invoice created', entity: 'Invoice', entityId: invoice.id, toValue: invoice.invoiceNumber });
  res.status(201).json(decorate(invoice));
});

// ---------------------------------------------------------------------------
// P4 — EDIT AN INVOICE'S AMOUNT BEFORE GST, GST and TDS. Every amount is
// recalculated from the percentages here (an amount that disagrees with its %
// is refused); the status follows the receipts as always. Money already
// received can never end up above the new net receivable.
// ---------------------------------------------------------------------------
const taxLine = (x) => `before GST ₹${x.amount} · GST ${x.gstPercent || 0}% ₹${x.gst} · TDS ${x.tdsPercent || 0}% ₹${x.tds} · net ₹${ROUND(Number(x.amount) + Number(x.gst) - Number(x.tds))}`;
router.patch('/:id', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { client: true } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!matches(invoice, invoiceWhere(req.user))) return res.status(403).json(OUT_OF_SCOPE);
  if (invoice.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled — it cannot be edited.' });
  if (CNU.ready() && await prisma.creditNote.count({ where: { invoiceId: invoice.id, status: 'Issued' } })) {
    return res.status(400).json({ error: 'This invoice has an issued credit / debit note worked out on its GST / TDS — cancel the note first, then edit.' });
  }
  const company = (await prisma.company.findFirst()) || {};
  const now = TAX.taxView(invoice, { company });
  // An older invoice keeps what it reads as today unless the form changes it.
  const start = {
    ...invoice, gstType: now.gstType, tdsBase: now.tdsBase, gstPercent: now.gstPercent, tdsPercent: now.tdsPercent,
  };
  const taxIn = TAX.readTaxInput(req.body || {}, start, TAX.defaultsFor(invoice.client, company, { gst: 0, tds: 0 }));
  if (taxIn.error) return res.status(400).json({ error: taxIn.error });
  const received = ROUND(Number(invoice.receivedAmount || 0));
  if (received > taxIn.calc.net + 0.5) {
    return res.status(400).json({ error: `₹${received.toLocaleString('en-IN')} has already been received — more than the new net receivable ₹${taxIn.calc.net.toLocaleString('en-IN')}. Remove a payment first, or check the amounts.` });
  }
  const data = taxIn.data;
  const changed = Object.keys(data).filter((k) => data[k] !== undefined && String(data[k] ?? '') !== String(invoice[k] ?? ''));
  if (!changed.length) {
    return res.json({ ...decorate(invoice), ...taxPayload(invoice, company), unchanged: true });
  }
  const status = deriveInvoiceStatus({ ...invoice, ...data });
  const today = new Date().toISOString().slice(0, 10);
  data.status = status;
  data.paidDate = status === 'Paid' ? (invoice.paidDate || today) : (invoice.status === 'Paid' ? null : invoice.paidDate);
  const updated = await prisma.invoice.update({ where: { id: invoice.id }, data, include: { client: true } });
  await logAudit({
    userId: req.user.id, action: 'Invoice GST / TDS edited', entity: 'Invoice', entityId: invoice.id,
    fromValue: taxLine(invoice), toValue: taxLine(updated),
  });
  return res.json({ ...decorate(updated), ...taxPayload(updated, company), changed });
});

// Record a receipt. Several of these can land on one invoice, which is how an
// invoice reaches "Partially Paid" and then "Paid".
router.post('/:id/payments', requirePerm('accounts', 'accounts', 'Payments', 'create'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // The receipt rules are shared with the data import's Payments sheet
  // (utils/accounts.js receiptProblem / invoiceAfterReceipt).
  const amount = ROUND(req.body.amount);
  const problem = receiptProblem(invoice, amount);
  if (problem) return res.status(400).json({ error: problem });

  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const payment = await prisma.invoicePayment.create({
    data: {
      invoiceId: invoice.id,
      date,
      amount,
      method: req.body.method || 'Bank Transfer',
      reference: req.body.reference || null,
      notes: req.body.notes || null,
      recordedBy: req.user.name || req.user.email || null,
    },
  });
  const after = invoiceAfterReceipt(invoice, amount, date);
  const { status } = after;
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: after,
    include: { payments: { orderBy: { date: 'asc' } } },
  });
  await logAudit({
    userId: req.user.id, action: 'Payment recorded', entity: 'Invoice', entityId: invoice.id,
    fromValue: invoice.status, toValue: `${status} — ₹${amount}`,
  });
  res.status(201).json({ invoice: decorate(updated), payment });
});

router.delete('/:id/payments/:paymentId', requirePerm('accounts', 'accounts', 'Payments', 'delete'), async (req, res) => {
  const payment = await prisma.invoicePayment.findUnique({ where: { id: req.params.paymentId } });
  if (!payment || payment.invoiceId !== req.params.id) return res.status(404).json({ error: 'Payment not found' });
  if (payment.bankTxnId) {
    return res.status(400).json({ error: 'This receipt came from a reconciled bank line — unmatch the transaction instead' });
  }
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (CNU.ready() && await prisma.creditNote.count({ where: { invoiceId: invoice.id, status: 'Issued', refundDue: { gt: 0.005 } } })) {
    return res.status(400).json({ error: 'A credit note on this invoice has a refund worked out from the payments received — cancel that note first, then remove the payment.' });
  }
  await prisma.invoicePayment.delete({ where: { id: payment.id } });
  const received = ROUND(Math.max(0, Number(invoice.receivedAmount || 0) - Number(payment.amount || 0)));
  const status = deriveInvoiceStatus({ ...invoice, receivedAmount: received });
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { receivedAmount: received, status, paidDate: status === 'Paid' ? invoice.paidDate : null },
  });
  await logAudit({ userId: req.user.id, action: 'Payment removed', entity: 'Invoice', entityId: invoice.id, fromValue: invoice.status, toValue: status });
  res.json(decorate(updated));
});

// Kept for the existing UI: settles whatever is still outstanding in one go.
router.patch('/:id/pay', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled' });
  const outstanding = invoiceOutstanding(invoice);
  if (outstanding <= 0.5) return res.status(400).json({ error: 'Already marked paid' });

  const date = req.body?.date || new Date().toISOString().slice(0, 10);
  await prisma.invoicePayment.create({
    data: {
      invoiceId: invoice.id, date, amount: outstanding,
      method: req.body?.method || 'Bank Transfer',
      notes: 'Settled in full', recordedBy: req.user.name || req.user.email || null,
    },
  });
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { receivedAmount: ROUND(Number(invoice.receivedAmount || 0) + outstanding), status: 'Paid', paidDate: date },
  });
  await logAudit({ userId: req.user.id, action: 'Invoice paid', entity: 'Invoice', entityId: invoice.id, fromValue: invoice.status, toValue: 'Paid' });
  res.json(decorate(updated));
});

router.patch('/:id/cancel', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Cancelled') return res.status(400).json({ error: 'Already cancelled' });
  if (CNU.ready() && await prisma.creditNote.count({ where: { invoiceId: invoice.id, status: { not: 'Cancelled' } } })) {
    return res.status(400).json({ error: 'This invoice has a credit / debit note — cancel or remove the note first.' });
  }
  if (Number(invoice.receivedAmount || 0) > 0) {
    return res.status(400).json({ error: 'Money has already been received against this invoice — it cannot be cancelled' });
  }
  const txn = await prisma.bankTransaction.findFirst({ where: { matchedInvoiceId: invoice.id } });
  if (txn) return res.status(400).json({ error: 'A bank transaction is matched to this invoice — unmatch it first' });

  const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'Cancelled' } });
  await logAudit({ userId: req.user.id, action: 'Invoice cancelled', entity: 'Invoice', entityId: invoice.id, fromValue: invoice.status, toValue: 'Cancelled' });
  res.json(decorate(updated));
});

// Form 16A against an invoice the client deducted TDS on. Until it is in hand
// the register keeps the invoice in its "TDS to collect" total.
router.patch('/:id/tds-certificate', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (Number(invoice.tds || 0) <= 0.5) return res.status(400).json({ error: 'No TDS was deducted on this invoice' });
  const received = !!req.body.received;
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      tdsCertReceived: received,
      tdsCertRef: received ? (req.body.reference || null) : null,
      tdsCertDate: received ? (req.body.date || new Date().toISOString().slice(0, 10)) : null,
    },
  });
  await logAudit({
    userId: req.user.id, action: received ? 'TDS certificate received' : 'TDS certificate cleared',
    entity: 'Invoice', entityId: invoice.id, toValue: updated.tdsCertRef || '',
  });
  res.json(decorate(updated));
});

// Record that the invoice went to the client, and how.
router.patch('/:id/sent', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const via = ['Email', 'WhatsApp', 'Post', 'By hand'].includes(req.body.via) ? req.body.via : 'Email';
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { sentVia: via, sentDate: req.body.date || new Date().toISOString().slice(0, 10) },
  });
  await logAudit({ userId: req.user.id, action: 'Invoice sent', entity: 'Invoice', entityId: invoice.id, toValue: via });
  res.json(decorate(updated));
});

router.nextInvoiceNumber = nextInvoiceNumber;
// The Accounts Dashboard (utils/accountsControl.js) reads the SAME register
// rows as this page, so its Total / Received / Pending can never differ.
router.buildRegister = buildRegister;
module.exports = router;
