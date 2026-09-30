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

const router = express.Router();
router.use(requireAuth);
// Accounts product + Invoices view. A client login reaches its own invoices
// (scoped by utils/scope.js); a recruiter reaches none.
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Invoices', 'view'));


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
    const gstPct = client?.gstPercent ?? 0;
    const tdsPct = client?.tdsPercent ?? 0;
    const terms = client?.paymentTerms || 'Net 30';
    const d = new Date(today);
    d.setDate(d.getDate() + termDays(terms));
    // eslint-disable-next-line no-await-in-loop
    const invoice = await prisma.invoice.create({
      data: {
        clientId: g.clientId,
        candidateId: rows[0].candidateId,
        amount,
        gst: ROUND(amount * gstPct / 100),
        tds: ROUND(amount * tdsPct / 100),
        gstPercent: gstPct,
        tdsPercent: tdsPct,
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

  const row = (i) => {
    const status = deriveInvoiceStatus(i);
    const fx = facts.get(i.id) || {};
    const billing = ROUND(Number(i.amount || 0));
    const gst = ROUND(Number(i.gst || 0));
    const tds = ROUND(Number(i.tds || 0));
    const receivable = invoiceTotal(i);
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
      clientPayingGst: gst > 0.5,
      // Money, in the prototype's own column order: before GST, GST, after GST,
      // TDS, receivable. Receivable is amount + GST − TDS.
      billing,
      gst,
      invoiceValue: ROUND(billing + gst),
      tds,
      receivable,
      received,
      pending: ROUND(receivable - received),
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
      gstPercent: i.gstPercent ?? i.client?.gstPercent ?? null,
      tdsPercent: i.tdsPercent ?? i.client?.tdsPercent ?? null,
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
    'Pending', 'Status', 'Due date', 'Age', 'Sent to client', 'TDS certificate'];
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
      r.sentVia ? `${r.sentVia} · ${r.sentDate || ''}` : 'Not sent', r.tdsCert || 'no TDS']);
  });
  if (!list.length) aoa.push(['No invoice matches these filters']);
  const sumOf = (k) => ROUND(list.reduce((a, r) => a + Number(r[k] || 0), 0));
  aoa.push(['TOTAL', '', `${list.length} invoice(s)`, '', '', '', '', '', '', '', '',
    sumOf('billing'), sumOf('gst'), sumOf('invoiceValue'), sumOf('tds'), sumOf('receivable'), sumOf('received'), sumOf('pending')]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 5; i < aoa.length; i += 1) {
    for (let c = 11; c <= 17; c += 1) {
      const ref = XLSX.utils.encode_cell({ r: i, c });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    }
  }
  ws['!cols'] = [14, 12, 34, 18, 22, 24, 22, 24, 14, 18, 8, 13, 12, 13, 12, 13, 13, 13, 14, 12, 12, 18, 14].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A5:W${aoa.length}` };
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

// ＋ New join — every joining still waiting for its invoice, with what the
// invoice would be raised for.
router.get('/joinings', async (req, res) => {
  const plan = await pendingJoinGroups();
  res.json({ rows: plan.all, nextNumber: plan.nextNumber });
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

  await prisma.application.update({ where: { id: app.id }, data: { offeredCtc: ctc, joiningDate } });
  const raised = await raiseJoiningInvoice({
    application: { ...app, offeredCtc: ctc, joiningDate },
    existing: app,
    userId: req.user.id,
  });
  if (!raised) return res.status(400).json({ error: 'This joining cannot be invoiced' });

  const data = {};
  if (fee != null && fee !== raised.feePercent) {
    const amount = Math.round((ctc * fee) / 100);
    Object.assign(data, {
      feePercent: fee,
      amount,
      gst: Math.round(amount * (Number(raised.gstPercent || 0) / 100)),
      tds: Math.round(amount * (Number(raised.tdsPercent || 0) / 100)),
    });
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
  const balance = ROUND((tds > 0 ? receivable : invoiceValue) - paid);

  const gstPct = invoice.gstPercent ?? cli.gstPercent ?? 0;
  const tdsPct = invoice.tdsPercent ?? cli.tdsPercent ?? 0;

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
  const inter = !!(cs && hs && cs.code !== hs.code);
  const fx = (await placementFacts([invoice]))(invoice);
  const half = ROUND(gst / 2);

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
      name: cli.name || '—',
      addressLines: clientAddress ? clientAddress.split(',').map((s) => s.trim()).filter(Boolean) : [],
      gstin: cli.gst || '',
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
      subTotal: billing, gst, cgst: half, sgst: ROUND(gst - half), invoiceValue, tds, receivable, paid, balance: balance > 0 ? balance : 0,
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
  res.json({ ...rest, tdsCertHasFile: !!tdsCertFile, proofLines });
});

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
  // GST and TDS ride on the client's own agreed rates — never a hardcoded
  // figure — unless this deal overrides them explicitly.
  const gstPct = req.body.gstPercent != null ? Number(req.body.gstPercent) : (client.gstPercent ?? 0);
  const tdsPct = req.body.tdsPercent != null ? Number(req.body.tdsPercent) : (client.tdsPercent ?? 0);
  const base = Number(amount);
  const invoice = await prisma.invoice.create({
    data: {
      clientId,
      candidateId: candidateId || null,
      requirementId: requirementId || null,
      amount: base,
      gst: gst != null ? Number(gst) || 0 : ROUND(base * gstPct / 100),
      tds: tds != null ? Number(tds) || 0 : ROUND(base * tdsPct / 100),
      gstPercent: gstPct,
      tdsPercent: tdsPct,
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
    data: { receivedAmount: invoiceTotal(invoice), status: 'Paid', paidDate: date },
  });
  await logAudit({ userId: req.user.id, action: 'Invoice paid', entity: 'Invoice', entityId: invoice.id, fromValue: invoice.status, toValue: 'Paid' });
  res.json(decorate(updated));
});

router.patch('/:id/cancel', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'Cancelled') return res.status(400).json({ error: 'Already cancelled' });
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
module.exports = router;
