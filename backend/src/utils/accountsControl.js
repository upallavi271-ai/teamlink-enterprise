// ---------------------------------------------------------------------------
// THE ACCOUNTS DASHBOARD — financial control centre (Accounts spec S8).
//
// One payload for the one scrollable page: filters (with server counts), the
// proof reminder, the main financial summary, office spends, the GST position
// and pending & received client by client. Every number is read off the SAME
// builders the other Accounts screens use — never a second formula:
//
//   invoices  routes/invoices.js buildRegister()  (the Invoices page's rows:
//             before GST, GST, after GST, TDS, receivable, status, due, the
//             department / section / role / employee attribution)
//   received  utils/moneyFacts.js receivedFor() / receiptsOf() / receivedOn()
//   expenses  routes/office.js officeScope() (the Office page's decorated
//             bills: hand loans and rejected bills out) with the Office
//             page's paid / pending rule (PAID_LIKE / PENDING_LIKE on the bill
//             total after GST — ledgerTotals)
//   GST       collected = GST × share of the invoice received (the rule
//             routes/office.js gstBothWays and the old dashboard use); input
//             credit needs a valid vendor GSTIN (decorate().gstinOnFile)
//
// RECONCILIATION (S8): total = invoices; received = receipts; pending =
// receivable − received; overdue = past due with a balance; office expenses =
// the Office page; GST collected is never profit. `checks` reports each tie-out.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const MF = require('./moneyFacts');
const { ROUND } = require('./accounts');
const { invoiceWhere } = require('./scope');

const IST = 330 * 60000;
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const sum = (list, f) => ROUND(list.reduce((s, x) => s + (Number(f(x)) || 0), 0));
const daysBetween = (fromIso, toIso) => Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const TEST_MARK = /zztest|example\.test/i;

// The route modules are required lazily: they are Express routers that also
// hand out their builders (router.buildRegister, router.officeScope …).
const invoicesRoute = () => require('../routes/invoices'); // eslint-disable-line global-require
const officeRoute = () => require('../routes/office'); // eslint-disable-line global-require

// The register is the heaviest read (attribution of every invoice). The
// filters are all applied here, after it, so it is kept for 30 s per login:
// changing a filter is instant; ?fresh=1 (sent after a payment / proof is
// recorded from this page) reads it again.
const REG_TTL = 30000;
const regCache = new Map();
async function registerFor(user, fresh) {
  const hitC = regCache.get(user.id);
  if (!fresh && hitC && Date.now() - hitC.at < REG_TTL) return hitC.p;
  const p = invoicesRoute().buildRegister(user, { period: 'all' });
  regCache.set(user.id, { at: Date.now(), p });
  p.catch(() => regCache.delete(user.id));
  if (regCache.size > 50) regCache.delete(regCache.keys().next().value);
  return p;
}

// ---- the period -----------------------------------------------------------
// The shared PeriodPicker sends { from, to } (both empty = All time).
function rangeOf(q) {
  const from = ISO_DAY.test(String(q.from || '')) ? String(q.from) : null;
  const to = ISO_DAY.test(String(q.to || '')) ? String(q.to) : null;
  if (!from || !to || from > to) return { all: true, from: null, to: null };
  return { all: false, from, to };
}
const inRange = (d, r) => r.all || (!!d && String(d).slice(0, 10) >= r.from && String(d).slice(0, 10) <= r.to);

// ---- proof ---------------------------------------------------------------
// ONE proof concept (main, 2026-10-05): a receipt has its proof when the
// payment row carries a bank line (InvoicePayment.bankTxnId — what the bank
// auto-proof attaches) or its bank reference, or the invoice itself carries a
// document (Invoice.proof* / Invoice.bankTxnId).
// A typed reference (InvoicePayment.reference / Invoice.proofRef — a UTR) on
// its own is NOT a document (main, 2026-10-05): it shows as "Reference only —
// document missing" (amber) and stays on the reminder list. Proof Attached =
// a bank line (bankTxnId) OR a stored file (Invoice.proofFile).
function invoiceDoc(raw) {
  return !!(raw.proofFile || raw.bankTxnId);
}
function receiptProof(raw) {
  const receipts = MF.receiptsOf(raw);
  if (!receipts.length) return null;
  const received = ROUND(receipts.reduce((s, x) => s + x.amount, 0));
  const pays = raw.payments || [];
  const doc = invoiceDoc(raw);
  const without = pays.filter((p) => !p.bankTxnId);
  const missingAmount = doc ? 0 : (pays.length ? sum(without, (p) => p.amount) : received);
  const refOnly = missingAmount > 0.5 && (!!String(raw.proofRef || '').trim()
    || (without.length > 0 && without.every((p) => String(p.reference || '').trim())));
  return {
    received,
    missingAmount: ROUND(missingAmount),
    missing: missingAmount > 0.5,
    refOnly,
    refs: [raw.proofRef, ...without.map((p) => p.reference)].filter((x) => String(x || '').trim()),
    parts: pays.length,
    lastDate: MF.receivedOn(raw),
    doc: doc ? {
      name: raw.proofName || null,
      ref: raw.proofRef || null,
      file: !!raw.proofFile,
      bankLine: !!raw.bankTxnId,
      at: raw.proofAt || null,
      by: raw.proofBy || null,
    } : null,
    bankLines: new Set(pays.map((p) => p.bankTxnId).filter(Boolean)).size,
  };
}
// A paid office bill: the bill / vendor invoice is its proof; a bill paid off
// the bank statement is proved by that line, except that input GST still
// needs the vendor's own tax invoice (routes/office.js decorate()).
// A bill whose proof is only a typed file name (no stored file, no bank line)
// is "Reference only — document missing", like a receipt's typed UTR.
function expenseProof(r, paidLike) {
  if (!paidLike) return null;
  if (!r.proofFile && !r.bankTxnId) {
    return { missing: true, refOnly: !!r.proofName, type: 'Expense bill / vendor invoice' };
  }
  if (r.gst > 0.5 && !r.proofFile && r.bankTxnId) return { missing: true, refOnly: !!r.proofName, type: 'GST invoice from the vendor' };
  return { missing: false, type: null };
}

// ---- who the accountant is -------------------------------------------------
async function accountsDesk() {
  const users = await prisma.user.findMany({
    where: { status: 'Active', accountsRole: { in: ['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true, name: true, email: true, accountsRole: true },
  });
  const real = users.filter((u) => !TEST_MARK.test(`${u.name} ${u.email}`));
  const accountants = real.filter((u) => u.accountsRole === 'ACCOUNTANT');
  const desk = accountants.length ? accountants : real.filter((u) => ['ADMIN', 'SUPER_ADMIN'].includes(u.accountsRole));
  const emps = await prisma.employee.findMany({
    where: { userId: { in: real.map((u) => u.id) } },
    select: { userId: true, phone: true },
  });
  const phone = new Map(emps.filter((e) => e.phone).map((e) => [e.userId, e.phone]));
  return {
    byId: new Map(real.map((u) => [u.id, { ...u, phone: phone.get(u.id) || null }])),
    byName: new Map(real.map((u) => [lc(u.name).trim(), u.id])),
    desk: desk.map((u) => ({ ...u, phone: phone.get(u.id) || null })),
    label: accountants.length ? 'Accountant' : 'Accounts desk (Admin)',
  };
}
function assignee(desk, ids = [], names = []) {
  const id = ids.find((x) => x && desk.byId.has(x)) || names.map((n) => desk.byName.get(lc(n).trim())).find(Boolean);
  if (id) {
    const u = desk.byId.get(id);
    return { ids: [u.id], name: u.name, phone: u.phone || null, own: true };
  }
  const list = desk.desk;
  return {
    ids: list.map((u) => u.id),
    name: list.length === 1 ? list[0].name : (list.length ? `${desk.label} · ${list[0].name}${list.length > 1 ? ` +${list.length - 1}` : ''}` : 'No accountant set'),
    phone: list.length === 1 ? (list[0].phone || null) : null,
    own: false,
  };
}

const REMIND_PREFIX = 'proof-reminder|';
const WA_ACTION = 'Proof reminder — WhatsApp opened';
const ATTACH_ACTION = 'Proof attached';
const reminderText = (r) => [
  'Payment is marked as paid, but the required proof is missing. Please attach the proof/document.',
  `${r.kind === 'invoice' ? 'Client' : 'Vendor'}: ${r.party || '—'}`,
  `${r.kind === 'invoice' ? 'Invoice no' : 'Bill / expense no'}: ${r.ref || '—'}`,
  `Amount: ₹${Number(r.amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
  `Payment date: ${r.paidOn || '—'}`,
  `Missing proof: ${r.proofType}`,
].join('\n');

// ---------------------------------------------------------------------------
// THE PAYLOAD
// ---------------------------------------------------------------------------
async function buildControl(user, q = {}) {
  const range = rangeOf(q);
  const today = todayIst();
  const want = {
    client: String(q.client || '').trim(),
    dept: String(q.dept || '').trim(),
    section: String(q.section || '').trim(),
    role: String(q.role || '').trim(),
    emp: String(q.emp || '').trim(),
  };
  const term = lc(q.q).trim();
  const terms = term ? term.split(/\s+/).filter(Boolean) : [];
  const hit = (hay) => !terms.length || terms.every((t) => hay.includes(t));

  const office = officeRoute();
  const [reg, raws, scope, desk, company, reminders, waLogs, attachLogs] = await Promise.all([
    registerFor(user, /^(1|true)$/.test(String(q.fresh || ''))),
    prisma.invoice.findMany({
      where: invoiceWhere(user),
      include: {
        payments: { orderBy: { date: 'asc' } },
        candidate: { select: { phone: true } },
        client: { select: { bdeOwner: true } },
      },
    }),
    office.officeScope({ period: range.all ? 'all' : `C:${range.from}:${range.to}` }),
    accountsDesk(),
    prisma.company.findFirst(),
    prisma.notification.findMany({
      where: { recipient: { startsWith: REMIND_PREFIX } },
      select: { userId: true, recipient: true, createdAt: true, read: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.findMany({ where: { action: WA_ACTION }, select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    prisma.auditLog.findMany({
      where: { action: { in: [ATTACH_ACTION, 'Bill Uploaded', 'Bill Updated'] }, createdAt: { gte: new Date(Date.now() - 90 * 86400000) } },
      select: { entity: true, entityId: true, createdAt: true, actorName: true, toValue: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const rawById = new Map(raws.map((i) => [i.id, i]));
  const hier = reg.hierarchy || { departments: [], people: [] };
  const deptLabel = new Map(hier.departments.map((d) => [d.name, d.label || d.name]));
  const secLabel = new Map(hier.departments.flatMap((d) => d.sections.map((s) => [s.key, `${d.label || d.name} · ${s.label}`])));
  const personName = new Map(hier.people.map((p) => [p.key, p.name]));

  // ---- invoice rows: the register's own, + moneyFacts received + proof ----
  let recvMismatch = 0;
  const all = reg.rows.filter((r) => r.status !== 'Cancelled').map((r) => {
    const raw = rawById.get(r.id) || { payments: [] };
    const received = MF.receivedFor(raw);
    if (Math.abs(received - r.received) > 0.5) recvMismatch += 1;
    // B2 — the register's receivable is after credit / debit notes; a credit beyond the balance is a refund due (r.refundDue), never a negative pending.
    const pending = ROUND(r.receivable - received + (r.refundDue || 0));
    const proof = receiptProof(raw);
    const emp = [r.recruiterKey, r.tlKey].filter(Boolean);
    const hay = lc([
      r.invoiceNumber, r.client, r.candidateName, raw.candidate?.phone, r.role, r.recruiter, r.tl, r.bde,
      r.clientGstin, r.department, r.section, r.specialisation, r.notes, raw.proofRef,
      ...(raw.payments || []).map((p) => p.reference),
    ].filter(Boolean).join(' '));
    return {
      ...r,
      received,
      pending,
      employees: emp,
      accountManager: raw.client?.bdeOwner || r.bde || null,
      assigned: r.bde || r.recruiter || r.tl || null,
      overdue: pending > 0.5 && r.daysOverdue != null && r.daysOverdue > 0,
      lastPayment: MF.receivedOn(raw),
      receipts: MF.receiptsOf(raw),
      proofInfo: proof,
      hay,
    };
  });
  const inPeriod = all.filter((r) => inRange(r.invoiceDate, range) && hit(r.hay));
  const pass = (r, skip) => (skip === 'client' || !want.client || r.client === want.client)
    && (skip === 'dept' || !want.dept || r.department === want.dept)
    && (skip === 'section' || !want.section || r.sectionKey === want.section)
    && (skip === 'role' || !want.role || r.role === want.role)
    && (skip === 'emp' || !want.emp || r.employees.includes(want.emp));
  const facet = (skip, keysOf, labelOf) => {
    const m = new Map();
    inPeriod.filter((r) => pass(r, skip)).forEach((r) => {
      [...new Set(keysOf(r).filter((k) => k && k !== '—'))].forEach((k) => m.set(k, (m.get(k) || 0) + 1));
    });
    return [...m.entries()].map(([value, count]) => ({ value, label: labelOf(value), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const facets = {
    client: facet('client', (r) => [r.client], (v) => v),
    dept: facet('dept', (r) => [r.department], (v) => deptLabel.get(v) || v),
    section: facet('section', (r) => [r.sectionKey], (v) => secLabel.get(v) || v),
    role: facet('role', (r) => [r.role], (v) => v),
    emp: facet('emp', (r) => r.employees, (v) => personName.get(v) || v),
  };
  const inv = inPeriod.filter((r) => pass(r));
  const peopleFilter = !!(want.client || want.dept || want.section || want.role || want.emp);

  // ---- expenses: the Office page's bills, in the period, + search -----------
  const { PAID_LIKE, PENDING_LIKE, vendorLabel } = office;
  const userIds = [...new Set(scope.inPeriod.flatMap((r) => [r.paidById, r.approvedById, r.createdById]).filter(Boolean))];
  const people = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(people.map((u) => [u.id, u.name]));
  const exp = scope.inPeriod.map((r) => {
    const paidLike = PAID_LIKE.includes(r.approvalStatus);
    const pendLike = PENDING_LIKE.includes(r.approvalStatus);
    const daysOver = pendLike && r.dueOn ? daysBetween(String(r.dueOn).slice(0, 10), today) : null;
    const proof = expenseProof(r, paidLike);
    return {
      id: r.id,
      code: r.expenseCode || null,
      category: r.category || '—',
      vendor: vendorLabel(r) || null,
      billNumber: r.billNumber || null,
      date: r.expenseDate || null,
      dueDate: r.dueOn || null,
      department: null, // a bill carries no department
      employee: nameOf.get(r.paidById) || nameOf.get(r.createdById) || r.approvedBy || null,
      employeeIds: [r.paidById, r.approvedById, r.createdById].filter(Boolean),
      base: r.base,
      gst: r.gst,
      tds: r.tds,
      afterGst: r.afterGst,
      net: r.net, // before GST + GST − TDS: what is paid to the vendor (Office ledger "Total amount")
      paid: paidLike ? r.net : 0,
      pending: pendLike ? r.net : 0,
      overdue: pendLike && daysOver != null && daysOver > 0,
      daysOverdue: daysOver != null && daysOver > 0 ? daysOver : null,
      approvalStatus: r.approvalStatus,
      payStatus: paidLike ? (r.approvalStatus === 'REIMBURSED' ? 'Reimbursed' : 'Paid') : (r.approvalStatus === 'APPROVED' ? 'Approved — to pay' : 'Waiting for approval'),
      proofStatus: proof ? (proof.missing ? (proof.refOnly ? 'Reference only — document missing' : 'Proof missing') : 'Proof attached') : 'Not paid yet',
      proofMissing: !!(proof && proof.missing),
      proofRefOnly: !!(proof && proof.refOnly),
      proofType: proof ? proof.type : null,
      gstin: r.effGstin || null,
      gstinOnFile: !!r.gstinOnFile,
      taxInvoiceOnFile: !!r.proofFile,
      paidOn: r.paidAt ? new Date(new Date(r.paidAt).getTime() + IST).toISOString().slice(0, 10) : (paidLike ? r.expenseDate : null),
      hay: lc([r.vendor, r.billNumber, r.expenseCode, r.description, r.category, r.effGstin, r.remarks, r.paymentMode].filter(Boolean).join(' ')),
    };
  }).filter((e) => hit(e.hay));

  // ---- 4. MAIN FINANCIAL SUMMARY -------------------------------------------
  const billing = sum(inv, (r) => r.billing);
  const gst = sum(inv, (r) => r.gst);
  const tds = sum(inv, (r) => r.tds);
  const receivable = sum(inv, (r) => r.receivable);
  const received = sum(inv, (r) => r.received);
  const pendingRows = inv.filter((r) => r.pending > 0.5);
  const refundDue = sum(inv, (r) => r.refundDue || 0);
  const pending = ROUND(receivable - received + refundDue);
  const overdue = inv.filter((r) => r.overdue);
  const bucketOf = (d) => (d <= 7 ? '1–7 days' : d <= 30 ? '8–30 days' : d <= 60 ? '31–60 days' : '60+ days');
  const overdueBuckets = ['1–7 days', '8–30 days', '31–60 days', '60+ days'].map((b) => {
    const l = overdue.filter((r) => bucketOf(r.daysOverdue) === b);
    return { bucket: b, count: l.length, amount: sum(l, (r) => r.pending) };
  });
  const owesMap = new Map();
  pendingRows.forEach((r) => owesMap.set(r.client, ROUND((owesMap.get(r.client) || 0) + r.pending)));
  const nextDue = pendingRows.map((r) => r.dueDate).filter(Boolean).sort()[0] || null;

  const expPaid = exp.filter((e) => PAID_LIKE.includes(e.approvalStatus));
  const expPend = exp.filter((e) => PENDING_LIKE.includes(e.approvalStatus));
  const expOver = exp.filter((e) => e.overdue);
  const expMissing = exp.filter((e) => e.proofMissing);
  const expTotal = sum(exp, (e) => e.net);
  const expBase = sum(exp, (e) => e.base);
  // Profit after expenses: income before GST − TDS − office costs before GST.
  // GST is never income and never a cost (collected / paid for Government).
  const profit = ROUND(billing - tds - expBase);

  // ---- 6. GST POSITION -----------------------------------------------------
  const collectedOf = (r) => (r.receivable > 0 ? r.gst * Math.min(1, r.received / r.receivable) : 0);
  const gstCollected = sum(inv, collectedOf);
  const gstPendingRows = inv.filter((r) => r.gst - collectedOf(r) > 0.5).map((r) => ({
    id: r.id, invoiceNumber: r.invoiceNumber, client: r.client, dueDate: r.dueDate, gst: r.gst, pending: ROUND(r.gst - collectedOf(r)), daysOverdue: r.overdue ? r.daysOverdue : null,
  })).sort((a, b) => b.pending - a.pending);
  const gstPendingByClient = [...gstPendingRows.reduce((m, r) => m.set(r.client, ROUND((m.get(r.client) || 0) + r.pending)), new Map()).entries()]
    .map(([client, amount]) => ({ client, amount, invoices: gstPendingRows.filter((r) => r.client === client).length })).sort((a, b) => b.amount - a.amount);
  const withGst = exp.filter((e) => e.gst > 0.5);
  const notClaimable = withGst.filter((e) => !e.gstinOnFile);
  const missingProofItc = withGst.filter((e) => e.gstinOnFile && !e.taxInvoiceOnFile);
  const eligible = withGst.filter((e) => e.gstinOnFile && e.taxInvoiceOnFile);
  const eligibleGst = sum(eligible, (e) => e.gst);
  const eligibleUnpaid = sum(eligible.filter((e) => PENDING_LIKE.includes(e.approvalStatus)), (e) => e.gst);
  let claimed = null;
  if (!range.all) {
    const pb = await prisma.portalBalance.findFirst({ where: { portalKey: 'gst', periodStart: range.from, periodEnd: range.to } }).catch(() => null);
    if (pb) claimed = ROUND(pb.enteredAmount);
  }

  // ---- 3. PROOF REMINDER ---------------------------------------------------
  const remindBy = new Map();
  reminders.forEach((n) => {
    const key = n.recipient.slice(REMIND_PREFIX.length);
    // One reminder = one send, however many accountants it went to.
    const cur = remindBy.get(key) || { count: 0, last: null, users: new Set(), sends: new Set() };
    const stamp = Math.floor(new Date(n.createdAt).getTime() / 5000);
    if (!cur.sends.has(stamp)) { cur.sends.add(stamp); cur.count += 1; }
    if (!cur.last || n.createdAt > cur.last) cur.last = n.createdAt;
    cur.users.add(n.userId);
    remindBy.set(key, cur);
  });
  const waBy = new Map();
  waLogs.forEach((a) => { if (!waBy.has(a.entityId)) waBy.set(a.entityId, a.createdAt); });
  const proofRecords = [];
  inv.forEach((r) => {
    const p = r.proofInfo;
    if (!p || !p.missing) return;
    const raw = rawById.get(r.id) || {};
    const who = assignee(desk, [], (raw.payments || []).map((x) => x.recordedBy));
    proofRecords.push({
      key: `invoice:${r.id}`, kind: 'invoice', id: r.id, party: r.client, ref: r.invoiceNumber, amount: p.missingAmount, paidOn: p.lastDate, proofType: 'Payment receipt / bank proof', refOnly: p.refOnly, refs: p.refs, who,
    });
  });
  exp.forEach((e) => {
    if (!e.proofMissing) return;
    const who = assignee(desk, e.employeeIds, []);
    proofRecords.push({
      key: `expense:${e.id}`, kind: 'expense', id: e.id, party: e.vendor || e.category, ref: e.billNumber || e.code, amount: e.paid, paidOn: e.paidOn, proofType: e.proofType, refOnly: e.proofRefOnly, refs: [], who,
    });
  });
  proofRecords.forEach((r) => {
    const rem = remindBy.get(r.key);
    const wa = waBy.get(r.key);
    r.reminders = rem ? rem.count : 0;
    r.lastReminder = rem ? rem.last : null;
    r.whatsappAt = wa || null;
    r.status = rem ? 'Reminder Sent' : (wa ? 'Reminder Pending' : 'Proof Missing');
    r.message = reminderText(r);
    r.accountant = r.who.name;
    r.whatsappTo = r.who.phone ? String(r.who.phone).replace(/\D/g, '').replace(/^0+/, '').replace(/^(\d{10})$/, '91$1') : null;
    delete r.who.phone;
  });
  proofRecords.sort((a, b) => (b.amount - a.amount));
  // Resolved: reminded / WhatsApp'd / attached here, and now on file.
  const missingKeys = new Set(proofRecords.map((r) => r.key));
  const seen = new Set();
  const resolved = [];
  attachLogs.forEach((a) => {
    const key = `${a.entity === 'Invoice' ? 'invoice' : 'expense'}:${a.entityId}`;
    if (seen.has(key) || missingKeys.has(key)) return;
    seen.add(key);
    resolved.push({ key, kind: a.entity === 'Invoice' ? 'invoice' : 'expense', id: a.entityId, what: a.toValue, by: a.actorName, at: a.createdAt, status: 'Resolved' });
  });
  [...remindBy.keys(), ...waBy.keys()].forEach((key) => {
    if (seen.has(key) || missingKeys.has(key)) return;
    seen.add(key);
    const [kind, id] = key.split(':');
    const raw = kind === 'invoice' ? rawById.get(id) : null;
    resolved.push({ key, kind, id, what: raw ? `${raw.invoiceNumber || ''}` : null, by: raw?.proofBy || null, at: raw?.proofAt || null, status: 'Resolved' });
  });

  // ---- 7. PENDING & RECEIVED — CLIENT BY CLIENT ----------------------------
  const clientMap = new Map();
  inv.forEach((r) => {
    const c = clientMap.get(r.client) || {
      client: r.client, clientId: r.clientId, departments: new Set(), managers: new Set(), invoices: [],
    };
    c.departments.add(deptLabel.get(r.department) || r.department);
    if (r.accountManager) c.managers.add(r.accountManager);
    c.invoices.push(r);
    clientMap.set(r.client, c);
  });
  const slim = (r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    dueDate: r.dueDate,
    client: r.client,
    clientId: r.clientId,
    candidateName: r.candidateName,
    role: r.role,
    employee: r.recruiter || r.tl || null,
    accountManager: r.accountManager,
    department: deptLabel.get(r.department) || r.department,
    billing: r.billing,
    gst: r.gst,
    invoiceValue: r.invoiceValue,
    tds: r.tds,
    tdsCert: r.tdsCert,
    receivable: r.receivable,
    received: r.received,
    pending: r.pending,
    status: r.status,
    overdue: r.overdue,
    daysOverdue: r.overdue ? r.daysOverdue : null,
    lastPayment: r.lastPayment,
    receipts: r.receipts.map((x) => ({ date: x.date, amount: x.amount, from: x.from })),
    payments: r.payments,
    proof: r.proofInfo ? (r.proofInfo.missing ? (r.proofInfo.refOnly ? 'Reference only — document missing' : 'Proof missing') : 'Proof attached') : null,
    proofDoc: r.proofInfo?.doc || null,
    assigned: r.assigned,
  });
  const clients = [...clientMap.values()].map((c) => {
    const l = c.invoices;
    const rcv = sum(l, (r) => r.receivable);
    const got = sum(l, (r) => r.received);
    const pend = ROUND(rcv - got + sum(l, (r) => r.refundDue || 0));
    const over = l.filter((r) => r.overdue);
    const proofMissing = l.filter((r) => r.proofInfo && r.proofInfo.missing).length;
    const proofNeeded = l.filter((r) => r.proofInfo).length;
    let status;
    if (pend <= 0.5) status = proofMissing ? 'Paid' : 'Settled';
    else if (over.length) status = 'Overdue';
    else if (got > 0.5) status = 'Partially Paid';
    else status = 'Pending';
    return {
      client: c.client,
      clientId: c.clientId,
      department: [...c.departments].filter((d) => d && d !== '—').join(', ') || '—',
      manager: [...c.managers].join(', ') || null,
      invoiceCount: l.length,
      billing: sum(l, (r) => r.billing),
      invoiceValue: sum(l, (r) => r.invoiceValue),
      receivable: rcv,
      received: got,
      pending: pend,
      overdue: sum(over, (r) => r.pending),
      collectedPct: rcv > 0 ? Math.round((got / rcv) * 100) : 0,
      lastPayment: l.map((r) => r.lastPayment).filter(Boolean).sort().pop() || null,
      nextDue: l.filter((r) => r.pending > 0.5).map((r) => r.dueDate).filter(Boolean).sort()[0] || null,
      daysOverdue: over.length ? Math.max(...over.map((r) => r.daysOverdue)) : null,
      proofStatus: proofNeeded ? (proofMissing ? `${proofMissing} missing` : 'All attached') : 'Nothing received',
      proofMissing,
      status,
      invoices: l.slice().sort((a, b) => String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || ''))).map(slim),
    };
  }).sort((a, b) => b.pending - a.pending || b.received - a.received);

  // ---- RECONCILIATION ------------------------------------------------------
  const cSum = (k) => sum(clients, (c) => c[k]);
  const checks = [
    { what: 'Received (moneyFacts) = the Invoices page received on every invoice', ok: recvMismatch === 0, detail: recvMismatch ? `${recvMismatch} invoice(s) differ` : 'all equal' },
    { what: 'Total after GST = sum of the client table', ok: Math.abs(cSum('invoiceValue') - ROUND(billing + gst)) < 1, detail: `${ROUND(billing + gst)} vs ${cSum('invoiceValue')}` },
    { what: 'Received = sum of the client table', ok: Math.abs(cSum('received') - received) < 1, detail: `${received} vs ${cSum('received')}` },
    { what: 'Pending = receivable − received (+ refunds due on credit notes)', ok: Math.abs(cSum('pending') - pending) < 1, detail: `${receivable} − ${received}${refundDue ? ` + ${refundDue}` : ''} = ${pending}` },
    { what: 'Overdue = past due with a balance', ok: Math.abs(cSum('overdue') - sum(overdue, (r) => r.pending)) < 1, detail: `${sum(overdue, (r) => r.pending)}` },
    { what: 'Office expenses = paid + to be paid', ok: Math.abs(expTotal - (sum(expPaid, (e) => e.net) + sum(expPend, (e) => e.net))) < 1, detail: `${expTotal}` },
    { what: 'GST to vendors = eligible + missing proof + not claimable', ok: Math.abs(sum(withGst, (e) => e.gst) - (eligibleGst + sum(missingProofItc, (e) => e.gst) + sum(notClaimable, (e) => e.gst))) < 1, detail: `${sum(withGst, (e) => e.gst)}` },
  ];

  const gstinCo = String(company?.gstin || '').trim().toUpperCase() || null;
  return {
    period: range,
    today,
    filters: { ...want, q: term },
    peopleFilter,
    facets,
    counts: { invoicesInPeriod: inPeriod.length, invoicesShown: inv.length, invoicesEver: all.length, expensesShown: exp.length },
    summary: {
      total: {
        billing, gst, invoiceValue: ROUND(billing + gst), tds, receivable, invoices: inv.length,
        // B2 — already inside the figures above (the register is after issued notes).
        creditNotes: sum(inv, (r) => (r.noteCredit ? r.noteCredit.net : 0)), debitNotes: sum(inv, (r) => (r.noteDebit ? r.noteDebit.net : 0)), refundDue, refundOpen: sum(inv, (r) => r.refundOpen || 0),
      },
      received: { amount: received, receipts: inv.reduce((n, r) => n + r.receipts.length, 0), invoices: inv.filter((r) => r.received > 0.5).length, collectedPct: receivable > 0 ? Math.round((received / receivable) * 100) : 0 },
      pending: {
        amount: pending,
        count: pendingRows.length,
        clients: owesMap.size,
        whoOwes: [...owesMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([client, amount]) => ({ client, amount })),
        nextDue,
        oldestDays: pendingRows.length ? Math.max(...pendingRows.map((r) => (r.invoiceDate ? daysBetween(String(r.invoiceDate).slice(0, 10), today) : 0))) : null,
      },
      overdue: {
        count: overdue.length,
        amount: sum(overdue, (r) => r.pending),
        buckets: overdueBuckets,
        rows: overdue.slice().sort((a, b) => b.daysOverdue - a.daysOverdue).map((r) => ({
          id: r.id, client: r.client, invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate, dueDate: r.dueDate, amount: r.receivable, received: r.received, pending: r.pending, daysOverdue: r.daysOverdue, bucket: bucketOf(r.daysOverdue), assigned: r.assigned, lastPayment: r.lastPayment,
        })),
      },
      expenses: {
        total: expTotal,
        paid: sum(expPaid, (e) => e.net),
        pending: sum(expPend, (e) => e.net),
        overdue: sum(expOver, (e) => e.net),
        missingProof: expMissing.length,
        count: exp.length,
      },
      profit: { income: billing, tds, expensesBeforeGst: expBase, amount: profit },
    },
    office: {
      before: expBase,
      gst: sum(exp, (e) => e.gst),
      tds: sum(exp, (e) => e.tds),
      after: sum(exp, (e) => e.afterGst),
      total: expTotal,
      counts: { records: exp.length, paid: expPaid.length, pending: expPend.length, overdue: expOver.length, missingProof: expMissing.length },
      toPay: expPend.slice().sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0) || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))),
      rows: exp.map(({ hay, employeeIds, ...e }) => e),
    },
    gst: {
      ourGstin: gstinCo,
      charged: gst,
      collected: gstCollected,
      pendingFromClients: ROUND(gst - gstCollected),
      pendingByClient: gstPendingByClient,
      pendingRows: gstPendingRows,
      paidToVendors: sum(withGst, (e) => e.gst),
      itc: {
        eligible: eligibleGst,
        eligibleBills: eligible.length,
        claimed,
        available: claimed != null ? ROUND(Math.max(0, eligibleGst - claimed)) : eligibleGst,
        pendingVendorPayment: eligibleUnpaid,
        missingProof: sum(missingProofItc, (e) => e.gst),
        missingProofBills: missingProofItc.length,
        notClaimable: sum(notClaimable, (e) => e.gst),
        notClaimableBills: notClaimable.length,
      },
      payable: ROUND(gst - eligibleGst),
      payableIfProofsAttached: ROUND(gst - eligibleGst - sum(missingProofItc, (e) => e.gst)),
    },
    proof: {
      records: proofRecords,
      counts: {
        missing: proofRecords.length,
        amount: sum(proofRecords, (r) => r.amount),
        remindersSent: proofRecords.reduce((n, r) => n + r.reminders, 0),
        lastReminder: proofRecords.map((r) => r.lastReminder).filter(Boolean).sort((a, b) => b - a)[0] || null,
        byStatus: ['Proof Missing', 'Reminder Pending', 'Reminder Sent'].reduce((m, s) => ({ ...m, [s]: proofRecords.filter((r) => r.status === s).length }), {}),
        resolved: resolved.length,
      },
      accountants: desk.desk.map((u) => u.name),
      resolved,
      channels: { inApp: true, whatsapp: 'wa.me link (no WhatsApp account connected)', sms: 'needs an SMS account', email: false },
    },
    clients,
    checks,
  };
}

// ---------------------------------------------------------------------------
// REMIND — one in-app reminder per record per accountant; never a duplicate
// while an earlier one is unread or less than a day old.
// ---------------------------------------------------------------------------
async function remind(user, keys, q = {}) {
  const data = await buildControl(user, q);
  const byKey = new Map(data.proof.records.map((r) => [r.key, r]));
  const want = (Array.isArray(keys) && keys.length ? keys : data.proof.records.map((r) => r.key)).map(String);
  const out = { sent: 0, skipped: 0, notMissing: 0, noAccountant: 0 };
  const dayAgo = new Date(Date.now() - 86400000);
  for (const key of want) {
    const r = byKey.get(key);
    if (!r) { out.notMissing += 1; continue; } // eslint-disable-line no-continue
    if (!r.who.ids.length) { out.noAccountant += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const prior = await prisma.notification.findMany({
      where: { recipient: `${REMIND_PREFIX}${key}`, userId: { in: r.who.ids } },
      select: { userId: true, read: true, createdAt: true },
    });
    const blocked = new Set(prior.filter((p) => !p.read || p.createdAt > dayAgo).map((p) => p.userId));
    const to = r.who.ids.filter((id) => !blocked.has(id));
    if (!to.length) { out.skipped += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.createMany({
      data: to.map((userId) => ({
        userId,
        title: `Proof missing — ${r.kind === 'invoice' ? 'invoice' : 'bill'} ${r.ref || ''}`.trim(),
        message: `${r.message}\nOpen: /accounts/dashboard#proof`,
        channel: 'In-App',
        recipient: `${REMIND_PREFIX}${key}`,
        status: 'Sent',
      })),
    });
    out.sent += 1;
  }
  return out;
}

module.exports = {
  buildControl, remind, rangeOf, REMIND_PREFIX, WA_ACTION, ATTACH_ACTION, reminderText,
};
