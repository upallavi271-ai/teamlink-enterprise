// ---------------------------------------------------------------------------
// B7 — PARTNER PAYOUTS, the Accounts side: /api/partner-payouts (2026-10-06).
// Invoices → "Partner payouts" tab. Same door as Invoices (Accounts product,
// Invoices view, an Accounts-desk role).
//
//   Draft     made by the system when a partner-sourced candidate JOINS and
//             the client invoice exists (utils/partners.js onJoined); the
//             person who marked the joining is the "maker"
//   Approved  an Accounts approver who is NOT the maker (maker-checker) —
//             booked at once as an Office & Expenses bill (category "Partner
//             payout", status Approved = "to be paid"), so the Accounts
//             Dashboard and the Office ledger count it as a COST
//   Paid      date, reference, mode (+ the bank line, optional); the bill
//             turns Paid too. Refused while "on hold until <guarantee end>"
//             unless a Super Admin / Admin overrides with a reason
//   Cancelled with a reason (the bill is rejected)
//   CLAWBACK  a negative payout drafted when a PAID placement leaves inside
//             the guarantee (automatic) or by hand
// ---------------------------------------------------------------------------
const express = require('express');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  requirePerm, requireInternal, requireProduct, roleForProduct, SET, can,
} = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const CN = require('../utils/creditNotes');
const P = require('../utils/partners');

const router = express.Router();
router.use(requireAuth);
router.use(requireInternal);
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Invoices', 'view'));
router.use((req, res, next) => {
  const role = roleForProduct(req.user, 'accounts');
  if (role && SET.ACCOUNTS.includes(role)) return next();
  return res.status(403).json({ error: 'Partner payouts are open to Super Admin, Admin and Accounts only' });
});
router.use((req, res, next) => (P.ready() ? next() : res.status(503).json(P.NOT_READY)));
const { str, R } = P;
const actorOf = (req) => req.user.name || req.user.email || 'Accounts';
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(u, 'accounts'));
const APPROVER_ONLY = 'Only an Accounts approver (Super Admin, Admin, or an Accountant with approve on Invoices) can do this.';

async function access(user) {
  const [approve, edit, create] = await Promise.all([
    CN.isNoteApprover(user).catch(() => false),
    can(user, 'accounts', 'accounts', 'Invoices', 'edit').catch(() => false),
    can(user, 'accounts', 'accounts', 'Invoices', 'create').catch(() => false),
  ]);
  return { canApprove: !!approve, canEdit: !!edit, canCreate: !!create, isAdmin: isAdmin(user) };
}

const INCLUDE = { partner: { select: { name: true, type: true, gstin: true, paymentTermsDays: true, gstRegistered: true, tdsSection: true, tdsPercent: true, feeType: true, feePercent: true, feeFixed: true, guaranteeDays: true } } };
const onHold = (p) => !!(p.holdUntil && p.holdUntil > P.todayIst() && ['Draft', 'Approved'].includes(p.status));
function view(p, extra = {}) {
  return {
    id: p.id, number: p.number, kind: p.kind, parentPayoutId: p.parentPayoutId, partnerId: p.partnerId, partner: p.partner ? p.partner.name : '', partnerType: p.partner ? p.partner.type : '',
    submissionId: p.submissionId, applicationId: p.applicationId, invoiceId: p.invoiceId, invoiceNumber: extra.invoiceNumber || null,
    candidateName: p.candidateName, requirementTitle: p.requirementTitle, clientName: p.clientName, joinedOn: p.joinedOn, month: p.joinedOn ? String(p.joinedOn).slice(0, 7) : null,
    ctc: p.ctc, feeType: p.feeType, feePercent: p.feePercent, feeFixed: p.feeFixed, fee: p.fee, gstPercent: p.gstPercent, gst: p.gst, tdsSection: p.tdsSection, tdsPercent: p.tdsPercent, tds: p.tds, net: p.net,
    holdUntil: p.holdUntil, onHold: onHold(p), status: p.status,
    statusText: p.status === 'Cancelled' ? 'Cancelled' : (onHold(p) ? `${p.status} · on hold until ${p.holdUntil}` : (p.status === 'Approved' ? 'Approved · to be paid' : p.status)),
    preparedByName: p.preparedByName, approvedByName: p.approvedByName, approvedAt: p.approvedAt, paidOn: p.paidOn, paidRef: p.paidRef, paidMode: p.paidMode, paidByName: p.paidByName, bankTxnId: p.bankTxnId,
    expenseId: p.expenseId, expenseCode: extra.expenseCode || null, cancelReason: p.cancelReason, cancelledByName: p.cancelledByName, notes: p.notes,
    partnerInvoice: p.partnerInvoiceFile ? { name: p.partnerInvoiceName, number: p.partnerInvoiceNumber, date: p.partnerInvoiceDate, size: p.partnerInvoiceSize } : null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}
async function decorate(rows) {
  const invIds = [...new Set(rows.map((r) => r.invoiceId).filter(Boolean))];
  const expIds = [...new Set(rows.map((r) => r.expenseId).filter(Boolean))];
  const [invs, exps] = await Promise.all([
    invIds.length ? prisma.invoice.findMany({ where: { id: { in: invIds } }, select: { id: true, invoiceNumber: true } }) : [],
    expIds.length ? prisma.officeExpense.findMany({ where: { id: { in: expIds } }, select: { id: true, expenseCode: true } }) : [],
  ]);
  const im = new Map(invs.map((i) => [i.id, i.invoiceNumber || i.id.slice(-6)]));
  const em = new Map(exps.map((e) => [e.id, e.expenseCode]));
  return rows.map((r) => view(r, { invoiceNumber: im.get(r.invoiceId), expenseCode: em.get(r.expenseId) }));
}
const sum = (rows, k) => R(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
function totalsOf(rows) {
  const live = rows.filter((r) => r.status !== 'Cancelled');
  return {
    count: rows.length,
    drafts: live.filter((r) => r.status === 'Draft').length,
    onHold: live.filter((r) => r.onHold).length,
    toPay: sum(live.filter((r) => r.status === 'Approved'), 'net'),
    paid: sum(live.filter((r) => r.status === 'Paid'), 'net'),
    fee: sum(live, 'fee'), gst: sum(live, 'gst'), tds: sum(live, 'tds'), net: sum(live, 'net'),
  };
}

// Joined partner placements without a live payout (the invoice may be missing).
async function missing() {
  const apps = await prisma.application.findMany({
    where: { partnerId: { not: null }, stage: { in: ['JOINED', 'HIRED'] } },
    select: { id: true, candidateId: true, requirementId: true, partnerId: true, joiningDate: true, joinedAt: true, candidate: { select: { name: true } }, requirement: { select: { title: true, client: { select: { name: true } } } } },
  });
  if (!apps.length) return [];
  const have = new Set((await prisma.partnerPayout.findMany({ where: { applicationId: { in: apps.map((a) => a.id) }, kind: 'PAYOUT', NOT: { status: 'Cancelled' } }, select: { applicationId: true } })).map((p) => p.applicationId));
  const rest = apps.filter((a) => !have.has(a.id));
  if (!rest.length) return [];
  const invs = await prisma.invoice.findMany({ where: { OR: rest.map((a) => ({ candidateId: a.candidateId, requirementId: a.requirementId })), NOT: { status: 'Cancelled' } }, select: { candidateId: true, requirementId: true, invoiceNumber: true } });
  const ik = new Set(invs.map((i) => `${i.candidateId}|${i.requirementId}`));
  const partners = await prisma.partner.findMany({ where: { id: { in: [...new Set(rest.map((a) => a.partnerId))] } }, select: { id: true, name: true } });
  const pm = new Map(partners.map((p) => [p.id, p.name]));
  return rest.map((a) => ({
    applicationId: a.id, partner: pm.get(a.partnerId) || '—', candidateName: a.candidate ? a.candidate.name : '', requirementTitle: a.requirement ? a.requirement.title : '',
    clientName: a.requirement && a.requirement.client ? a.requirement.client.name : '', joinedOn: a.joiningDate || (a.joinedAt ? new Date(a.joinedAt).toISOString().slice(0, 10) : null),
    hasInvoice: ik.has(`${a.candidateId}|${a.requirementId}`),
  }));
}

router.get('/', async (req, res) => {
  const q = req.query || {};
  const all = await decorate(await prisma.partnerPayout.findMany({ include: INCLUDE, orderBy: { createdAt: 'desc' } }));
  const s = str(q.q).toLowerCase();
  const pass = (r, skip) => (skip === 'partnerId' || !str(q.partnerId) || r.partnerId === str(q.partnerId))
    && (skip === 'status' || !str(q.status) || r.status === str(q.status))
    && (skip === 'client' || !str(q.client) || r.clientName === str(q.client))
    && (skip === 'month' || !str(q.month) || r.month === str(q.month))
    && (!s || [r.number, r.candidateName, r.partner, r.clientName, r.requirementTitle, r.invoiceNumber, r.paidRef].some((v) => String(v || '').toLowerCase().includes(s)));
  const rows = all.filter((r) => pass(r));
  const facet = (key, label, skip) => {
    const m = new Map();
    all.filter((r) => pass(r, skip)).forEach((r) => { const k = key(r); if (!k) return; const o = m.get(k) || { value: k, label: label(r), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  res.json({
    rows,
    totals: totalsOf(rows),
    facets: {
      partnerId: facet((r) => r.partnerId, (r) => r.partner, 'partnerId'),
      status: facet((r) => r.status, (r) => r.status, 'status'),
      client: facet((r) => r.clientName, (r) => r.clientName, 'client'),
      month: facet((r) => r.month, (r) => r.month, 'month'),
    },
    missing: await missing(),
    access: await access(req.user),
    payModes: P.PAY_MODES,
    rule: 'Payout = fee (% of CTC or fixed) + GST 18% if the partner is GST-registered − TDS at the partner section % (on the fee before GST) = net payable. On hold until the guarantee ends. Approve: a second person (never the one who marked the joining). Approved payouts are booked as an Office & Expenses bill "Partner payout" and count as a cost on the Accounts Dashboard.',
  });
});

async function load(id) { return prisma.partnerPayout.findUnique({ where: { id: String(id || '') }, include: INCLUDE }); }
async function respond(res, id, message) {
  const [row] = await decorate([await load(id)]);
  return res.json({ payout: row, message });
}

// A joined partner placement without a payout: make the draft now (needs the client invoice).
router.post('/create-for/:applicationId', requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const app = await prisma.application.findUnique({ where: { id: String(req.params.applicationId || '') }, select: { id: true, partnerId: true, stage: true, candidateId: true, requirementId: true } });
  if (!app || !app.partnerId) return res.status(404).json({ error: 'That placement is not from a partner.' });
  if (!['JOINED', 'HIRED'].includes(app.stage)) return res.status(409).json({ error: 'The candidate has not joined yet.' });
  const existing = await prisma.partnerPayout.findFirst({ where: { applicationId: app.id, kind: 'PAYOUT', NOT: { status: 'Cancelled' } } });
  if (existing) return res.status(409).json({ error: `A payout already exists (${existing.number}).` });
  const inv = await prisma.invoice.findFirst({ where: { candidateId: app.candidateId, requirementId: app.requirementId, NOT: { status: 'Cancelled' } } });
  if (!inv) return res.status(409).json({ error: 'Raise the client invoice first (Invoices → Joined, not invoiced). The payout follows the invoice.' });
  const p = await P.onJoined({ applicationId: app.id, invoice: inv, userId: req.user.id });
  if (!p) return res.status(500).json({ error: 'Could not make the payout. Check the partner master (fee terms).' });
  return respond(res, p.id, `${p.number} drafted.`);
});

// Draft edits: the fee (override), notes, the hold date (Admin). Re-computed on the server.
router.patch('/:id', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  if (p.status !== 'Draft') return res.status(409).json({ error: `Only a Draft can be edited — this one is ${p.status}.` });
  const b = req.body || {};
  const data = {}; const changes = [];
  if (b.fee !== undefined && b.fee !== '' && b.fee !== null) {
    const fee = Number(String(b.fee).replace(/[,\s₹]/g, ''));
    if (!Number.isFinite(fee) || (p.kind === 'PAYOUT' && fee < 0) || Math.abs(fee) > 1e8) return res.status(400).json({ error: 'Enter the fee before GST as a number, like 45000.', field: 'fee' });
    const m = P.payoutMoney(p.partner, p.ctc, { fee: p.kind === 'CLAWBACK' ? -Math.abs(fee) : fee });
    if (R(m.fee) !== R(p.fee)) { Object.assign(data, { fee: m.fee, gst: m.gst, tds: m.tds, net: m.net, gstPercent: m.gstPercent, tdsPercent: m.tdsPercent }); changes.push(`fee ₹${p.fee} → ₹${m.fee} (net ₹${m.net})`); }
  }
  if (b.notes !== undefined && (str(b.notes).slice(0, 1000) || null) !== (p.notes || null)) { data.notes = str(b.notes).slice(0, 1000) || null; changes.push('notes'); }
  if (b.holdUntil !== undefined) {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only Super Admin / Admin can change the guarantee hold date.' });
    const h = str(b.holdUntil) || null;
    if (h && !P.isRealDay(h)) return res.status(400).json({ error: 'Pick a proper date.', field: 'holdUntil' });
    if (h !== (p.holdUntil || null)) { data.holdUntil = h; changes.push(`hold ${p.holdUntil || '—'} → ${h || 'none'}`); }
  }
  if (!changes.length) return respond(res, p.id, 'Nothing changed.');
  await prisma.partnerPayout.update({ where: { id: p.id }, data: { ...data, preparedById: req.user.id, preparedByName: actorOf(req) } });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner payout edited', entity: 'PartnerPayout', entityId: p.id, toValue: `${p.number} · ${changes.join(' · ')}`.slice(0, 900) });
  return respond(res, p.id, 'Saved. You are now the maker of this payout — another approver must approve it.');
});

// Approve — maker-checker.
router.post('/:id/approve', async (req, res) => {
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  if (p.status !== 'Draft') return res.status(409).json({ error: `This payout is ${p.status} already.` });
  if (p.preparedById && p.preparedById === req.user.id) {
    return res.status(403).json({ error: `Maker-checker: ${p.preparedByName || 'you'} prepared this payout, so a different approver must approve it.`, makerChecker: true });
  }
  if (!(Math.abs(p.net) > 0)) return res.status(409).json({ error: 'The payout is ₹0 — set the fee first (edit the draft) or cancel it.' });
  const partner = await prisma.partner.findUnique({ where: { id: p.partnerId } });
  const terms = Number(partner.paymentTermsDays || 0);
  const byTerms = P.addDays(P.todayIst(), terms);
  const dueDate = p.holdUntil && p.holdUntil > byTerms ? p.holdUntil : byTerms;
  const n = await prisma.partnerPayout.updateMany({ where: { id: p.id, status: 'Draft' }, data: { status: 'Approved', approvedById: req.user.id, approvedByName: actorOf(req), approvedAt: new Date() } });
  if (!n.count) return res.status(409).json({ error: 'Someone else changed this payout. Open it again.' });
  let expense = null;
  if (p.kind === 'PAYOUT') {
    try {
      expense = await P.bookExpense(p, partner, req.user, { dueDate });
      await prisma.partnerPayout.update({ where: { id: p.id }, data: { expenseId: expense.id } });
    } catch (err) {
      await prisma.partnerPayout.update({ where: { id: p.id }, data: { status: 'Draft', approvedById: null, approvedByName: null, approvedAt: null } });
      return res.status(err.status || 500).json({ error: err.message || 'Could not book the expense.' });
    }
  }
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: p.kind === 'CLAWBACK' ? 'Partner clawback approved' : 'Partner payout approved', entity: 'PartnerPayout', entityId: p.id, fromValue: 'Draft',
    toValue: `${p.number} · ${partner.name} · ₹${p.net}${expense ? ` · booked as ${expense.expenseCode || expense.id} (due ${dueDate})` : ''}${p.holdUntil ? ` · hold until ${p.holdUntil}` : ''}`, approvalStatus: 'Approved', approvedByName: actorOf(req), approvedAt: new Date(),
  });
  await P.noticePartner(p.partnerId, { title: `${p.candidateName}: ${p.kind === 'CLAWBACK' ? 'recovery approved' : 'payout approved'}`, message: `${p.number} — ₹${Math.abs(p.net).toLocaleString('en-IN')}${p.holdUntil && p.holdUntil > P.todayIst() ? `, paid after ${p.holdUntil}` : ''}.`, email: true });
  return respond(res, p.id, expense ? `Approved. Booked as ${expense.expenseCode || 'an expense'} (to be paid${p.holdUntil && p.holdUntil > P.todayIst() ? `, on hold until ${p.holdUntil}` : ''}).` : 'Approved.');
});

// Mark paid — date, reference, mode, optional bank line. Not while on hold (Admin override with a reason).
router.post('/:id/pay', async (req, res) => {
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  if (p.status !== 'Approved') return res.status(409).json({ error: p.status === 'Draft' ? 'Approve the payout first.' : `This payout is ${p.status} already.` });
  const b = req.body || {};
  const paidOn = str(b.paidOn) || P.todayIst();
  if (!P.isRealDay(paidOn)) return res.status(400).json({ error: 'Pick the payment date.', field: 'paidOn' });
  if (paidOn > P.addDays(P.todayIst(), 1)) return res.status(400).json({ error: 'The payment date cannot be in the future.', field: 'paidOn' });
  const paidRef = str(b.paidRef).slice(0, 120);
  if (!paidRef) return res.status(400).json({ error: 'Enter the payment reference (UTR / cheque no.).', field: 'paidRef' });
  const paidMode = P.PAY_MODES.includes(b.paidMode) ? b.paidMode : 'Bank Transfer';
  let override = null;
  if (p.holdUntil && p.holdUntil > P.todayIst()) {
    const reason = str(b.overrideReason);
    if (!(b.overrideHold === true && isAdmin(req.user) && reason.length >= 5)) {
      return res.status(409).json({ error: `On hold until ${p.holdUntil} (guarantee period). It can be paid after that date${isAdmin(req.user) ? ', or now with a written reason (Admin override)' : ''}.`, onHold: true, holdUntil: p.holdUntil });
    }
    override = reason;
  }
  const bankTxnId = str(b.bankTxnId) || null;
  if (bankTxnId) {
    const t = await prisma.bankTransaction.findUnique({ where: { id: bankTxnId } }).catch(() => null);
    if (!t) return res.status(400).json({ error: 'That bank line was not found.', field: 'bankTxnId' });
  }
  const n = await prisma.partnerPayout.updateMany({ where: { id: p.id, status: 'Approved' }, data: { status: 'Paid', paidOn, paidRef, paidMode, paidById: req.user.id, paidByName: actorOf(req), paidAt: new Date(), bankTxnId, ...(override ? { notes: `${p.notes ? `${p.notes}\n` : ''}Paid before the guarantee end (${p.holdUntil}) — ${override}` } : {}) } });
  if (!n.count) return res.status(409).json({ error: 'Someone else changed this payout. Open it again.' });
  await P.expensePaid(p.expenseId, { paidOn, paidRef, paidMode, bankTxnId, user: req.user });
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: p.kind === 'CLAWBACK' ? 'Partner clawback recovered' : 'Partner payout paid', entity: 'PartnerPayout', entityId: p.id, fromValue: 'Approved',
    toValue: `${p.number} · ₹${p.net} · ${paidOn} · ${paidMode} · ${paidRef}${bankTxnId ? ' · bank line linked' : ''}`, reason: override || undefined,
  });
  await P.noticePartner(p.partnerId, { title: `${p.candidateName}: ${p.kind === 'CLAWBACK' ? 'recovery received' : 'payout paid'}`, message: `${p.number} — ₹${Math.abs(p.net).toLocaleString('en-IN')} on ${paidOn} (${paidMode}, ref ${paidRef}).`, email: true });
  return respond(res, p.id, `Marked paid on ${paidOn}.`);
});

router.post('/:id/cancel', async (req, res) => {
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  if (!['Draft', 'Approved'].includes(p.status)) return res.status(409).json({ error: `A ${p.status} payout cannot be cancelled${p.status === 'Paid' ? ' — record a clawback instead' : ''}.` });
  const reason = str(req.body && req.body.reason);
  if (reason.length < 3) return res.status(400).json({ error: 'Say why the payout is cancelled.', field: 'reason' });
  await prisma.partnerPayout.update({ where: { id: p.id }, data: { status: 'Cancelled', cancelledAt: new Date(), cancelledByName: actorOf(req), cancelReason: reason.slice(0, 500) } });
  await P.expenseCancelled(p.expenseId, reason, req.user);
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner payout cancelled', entity: 'PartnerPayout', entityId: p.id, fromValue: p.status, toValue: `${p.number} · Cancelled`, reason });
  await P.noticePartner(p.partnerId, { title: `${p.candidateName}: payout cancelled`, message: reason, email: true });
  return respond(res, p.id, 'Cancelled.');
});

// A clawback by hand (a paid placement that left inside the guarantee and was not recorded through Joining).
router.post('/:id/clawback', async (req, res) => {
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  if (p.kind !== 'PAYOUT' || p.status !== 'Paid') return res.status(409).json({ error: 'A clawback is recorded against a PAID payout only.' });
  const reason = str(req.body && req.body.reason);
  if (reason.length < 3) return res.status(400).json({ error: 'Say why the money is being recovered.', field: 'reason' });
  const already = await prisma.partnerPayout.findFirst({ where: { parentPayoutId: p.id, kind: 'CLAWBACK', NOT: { status: 'Cancelled' } } });
  if (already) return res.status(409).json({ error: `A clawback already exists (${already.number}).` });
  const list = await P.onLeft({ applicationId: p.applicationId, inside: true, reason, user: req.user });
  const cb = (list || []).find((x) => x.kind === 'CLAWBACK');
  if (!cb) return res.status(500).json({ error: 'Could not record the clawback.' });
  return respond(res, cb.id, `${cb.number} drafted — approve it, then mark it recovered when the money comes back.`);
});

// The partner's invoice file (optional) — Accounts can attach it too.
const FILE_MAX = 10 * 1024 * 1024;
router.post('/:id/partner-invoice', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const p = await load(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payout not found.' });
  let form;
  try { form = await attachments.parseMultipart(req, { maxBytes: FILE_MAX }); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' }); }
  if (!form.file) return res.status(400).json({ error: 'Choose the invoice file (PDF or photo).' });
  let st;
  try { st = attachments.store(form.file, { maxBytes: FILE_MAX }); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Only a PDF or a photo can be uploaded.' }); }
  if (p.partnerInvoiceFile) attachments.remove(p.partnerInvoiceFile);
  const number = str(form.fields.invoiceNumber).slice(0, 60) || null;
  const date = str(form.fields.invoiceDate);
  await prisma.partnerPayout.update({ where: { id: p.id }, data: { partnerInvoiceFile: st.billFile, partnerInvoiceName: st.billName, partnerInvoiceMime: st.billMime, partnerInvoiceSize: st.billSize, partnerInvoiceNumber: number, partnerInvoiceDate: P.isRealDay(date) ? date : null } });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner invoice attached', entity: 'PartnerPayout', entityId: p.id, toValue: `${p.number} · ${st.billName}` });
  return respond(res, p.id, 'Invoice attached.');
});
router.get('/:id/partner-invoice/file', async (req, res) => {
  const p = await load(req.params.id);
  if (!p || !p.partnerInvoiceFile) return res.status(404).json({ error: 'No invoice file on this payout.' });
  const full = attachments.resolveStored(p.partnerInvoiceFile);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  res.setHeader('Content-Type', attachments.ALLOWED[p.partnerInvoiceMime] ? p.partnerInvoiceMime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(p.partnerInvoiceName)}"`);
  return res.sendFile(full);
});

// ---- Excel + per-partner statement --------------------------------------------------------
function book(rows, title, sub) {
  const head = ['Payout no', 'Type', 'Status', 'Partner', 'Candidate', 'Job', 'Client', 'Joined on', 'Client invoice', 'CTC', 'Fee basis', 'Fee (before GST)', 'GST %', 'GST', 'TDS section', 'TDS %', 'TDS', 'Net payable', 'On hold until', 'Approved by', 'Paid on', 'Paid ref', 'Mode', 'Expense', 'Partner invoice', 'Notes'];
  const aoa = [[title], [sub || ''], [], head];
  rows.forEach((r) => aoa.push([r.number, r.kind === 'CLAWBACK' ? 'Clawback' : 'Payout', r.status, r.partner, r.candidateName || '', r.requirementTitle || '', r.clientName || '', r.joinedOn || '', r.invoiceNumber || '', r.ctc || '',
    r.feeType === 'FIXED' ? 'Fixed' : `${r.feePercent || ''}% of CTC`, r.fee, r.gstPercent, r.gst, r.tdsSection || '', r.tdsPercent, r.tds, r.net, r.holdUntil || '', r.approvedByName || '', r.paidOn || '', r.paidRef || '', r.paidMode || '', r.expenseCode || '', r.partnerInvoice ? (r.partnerInvoice.number || r.partnerInvoice.name) : '', r.notes || '']));
  const t = totalsOf(rows);
  aoa.push(['TOTAL', '', '', `${rows.length} row(s)`, '', '', '', '', '', '', '', t.fee, '', t.gst, '', '', t.tds, t.net]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 4; r <= range.e.r; r += 1) [9, 11, 13, 16, 17].forEach((c) => { const ref = XLSX.utils.encode_cell({ r, c }); if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00'; });
  ws['!cols'] = [14, 9, 10, 24, 22, 24, 22, 11, 14, 11, 12, 14, 6, 11, 10, 6, 11, 14, 12, 18, 11, 16, 12, 10, 18, 30].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payouts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function sendBook(res, buf, name) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${P.todayIst()}.xlsx"`);
  return res.send(buf);
}
router.post('/export.xlsx', requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const all = await decorate(await prisma.partnerPayout.findMany({ include: INCLUDE, orderBy: { createdAt: 'desc' } }));
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  const byId = new Map(all.map((r) => [r.id, r]));
  const list = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : all;
  await logAudit({ userId: req.user.id, action: 'Partner payouts exported', entity: 'PartnerPayout', toValue: `${list.length} payout(s)` });
  return sendBook(res, book(list, 'Partner payouts', `Filters: ${String((req.body && req.body.filters) || '').slice(0, 300) || 'none'}`), 'partner-payouts');
});
async function statementOf(partnerId) {
  const partner = await prisma.partner.findUnique({ where: { id: String(partnerId || '') } });
  if (!partner) return null;
  const rows = await decorate(await prisma.partnerPayout.findMany({ where: { partnerId: partner.id }, include: INCLUDE, orderBy: [{ joinedOn: 'asc' }, { createdAt: 'asc' }] }));
  return { partner: { id: partner.id, code: partner.code, name: partner.name, type: partner.type, gstin: partner.gstin, pan: partner.pan, tdsSection: partner.tdsSection, tdsPercent: partner.tdsPercent, paymentTermsDays: partner.paymentTermsDays }, rows, totals: totalsOf(rows) };
}
router.get('/statement/:partnerId', async (req, res) => {
  const s = await statementOf(req.params.partnerId);
  if (!s) return res.status(404).json({ error: 'Partner not found.' });
  return res.json(s);
});
router.post('/statement/:partnerId/export.xlsx', requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const s = await statementOf(req.params.partnerId);
  if (!s) return res.status(404).json({ error: 'Partner not found.' });
  await logAudit({ userId: req.user.id, action: 'Partner statement exported', entity: 'Partner', entityId: s.partner.id, toValue: `${s.rows.length} payout(s)` });
  return sendBook(res, book(s.rows, `Statement — ${s.partner.name} (${s.partner.code || ''})`, `${s.partner.type} · PAN ${s.partner.pan || '—'} · GSTIN ${s.partner.gstin || '—'} · TDS ${s.partner.tdsSection || 'None'} ${s.partner.tdsPercent}% · pay within ${s.partner.paymentTermsDays} days`), `partner-statement-${String(s.partner.name).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}`);
});

module.exports = router;
