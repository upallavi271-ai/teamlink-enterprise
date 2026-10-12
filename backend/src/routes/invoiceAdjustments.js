// ---------------------------------------------------------------------------
// INVOICE ADJUSTMENTS (Accounts reconciliation spec 6: "approved adjustments").
//
// A small gap that is NOT a payment and NOT a credit note: the client short-paid,
// the TDS it deducted differs from the invoice, the bank took a charge out of the
// receipt, a few rupees are written off. Maker-checker:
//
//   POST /invoices/:id/adjustments            ask for one          (Payments: create)
//   GET  /invoices/:id/adjustments            its adjustments
//   GET  /invoices/adjustments                the approval queue   (?status=Pending)
//   POST /invoices/adjustments/:aid/approve   approver, never the maker
//   POST /invoices/adjustments/:aid/reject    approver, with a reason
//   POST /invoices/adjustments/:aid/reverse   approver, with a reason (keeps the row)
//
// An APPROVED adjustment adds to Invoice.adjustedAmount, which invoiceOutstanding()
// subtracts: Outstanding = total - received - credit notes - approved adjustments.
// TDS: the invoice's own TDS is already inside "total" (amount + GST - TDS); only
// a DIFFERENCE from it is ever adjusted here, so TDS is never taken off twice.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requirePerm, requireInternal } = require('../utils/permissions');
const { invoiceWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { ROUND, invoiceOutstanding, deriveInvoiceStatus } = require('../utils/accounts');
const CN = require('../utils/creditNotes');

const router = express.Router();
const KINDS = {
  short_payment: 'Short payment',
  tds_difference: 'TDS difference',
  bank_charge: 'Bank charge on the receipt',
  write_off: 'Small write-off',
};
const P = (n) => Math.round((Number(n) || 0) * 100);
const money = (n) => `₹${ROUND(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (req) => req.user.name || req.user.email || 'Accounts';

async function scopedInvoice(user, id) {
  return prisma.invoice.findFirst({ where: { AND: [invoiceWhere(user), { id: String(id || '') }] }, include: { client: true } });
}
const shape = (a) => ({
  id: a.id, invoiceId: a.invoiceId, kind: a.kind, kindLabel: KINDS[a.kind] || a.kind, amount: a.amount, reason: a.reason, bankTxnId: a.bankTxnId,
  status: a.status, requestedBy: a.requestedBy, requestedAt: a.requestedAt, decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote,
});

router.get('/adjustments', requireInternal, async (req, res) => {
  const status = String(req.query.status || '');
  const rows = await prisma.invoiceAdjustment.findMany({
    where: status ? { status } : {}, orderBy: { requestedAt: 'desc' }, take: 300, include: { invoice: { include: { client: { select: { name: true } } } } },
  });
  const approver = await CN.isNoteApprover(req.user);
  res.json({
    canApprove: approver,
    rows: rows.map((a) => ({
      ...shape(a), invoiceNumber: a.invoice ? a.invoice.invoiceNumber : null, client: a.invoice && a.invoice.client ? a.invoice.client.name : null, outstanding: a.invoice ? invoiceOutstanding(a.invoice) : null,
    })),
  });
});

router.get('/:id/adjustments', requireInternal, async (req, res) => {
  const inv = await scopedInvoice(req.user, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const rows = await prisma.invoiceAdjustment.findMany({ where: { invoiceId: inv.id }, orderBy: { requestedAt: 'asc' } });
  res.json({ canApprove: await CN.isNoteApprover(req.user), outstanding: invoiceOutstanding(inv), adjusted: ROUND(inv.adjustedAmount), kinds: KINDS, rows: rows.map(shape) });
});

router.post('/:id/adjustments', requireInternal, requirePerm('accounts', 'accounts', 'Payments', 'create'), async (req, res) => {
  const inv = await scopedInvoice(req.user, req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled.' });
  const b = req.body || {};
  if (!KINDS[b.kind]) return res.status(400).json({ error: 'Choose the kind of adjustment.' });
  const amountP = P(b.amount);
  if (!(amountP > 0)) return res.status(400).json({ error: 'Enter the amount to adjust.' });
  const reason = String(b.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Say why (at least a few words) - an approver will read it.' });
  const pendingP = (await prisma.invoiceAdjustment.findMany({ where: { invoiceId: inv.id, status: 'Pending' } })).reduce((s, a) => s + P(a.amount), 0);
  if (amountP + pendingP > P(invoiceOutstanding(inv))) {
    return res.status(400).json({ error: `Only ${money(invoiceOutstanding(inv))} is outstanding on this invoice${pendingP ? ` (${money(pendingP / 100)} is already waiting for approval)` : ''}.` });
  }
  if (b.bankTxnId) {
    const link = await prisma.invoicePayment.findFirst({ where: { invoiceId: inv.id, bankTxnId: String(b.bankTxnId) } });
    if (!link) return res.status(400).json({ error: 'That bank line has not been allocated to this invoice.' });
  }
  const row = await prisma.invoiceAdjustment.create({
    data: {
      invoiceId: inv.id, kind: b.kind, amount: amountP / 100, reason: reason.slice(0, 500), bankTxnId: b.bankTxnId ? String(b.bankTxnId) : null, requestedById: req.user.id, requestedBy: who(req),
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Invoice adjustment requested', entity: 'Invoice', entityId: inv.id,
    fromValue: `outstanding ${money(invoiceOutstanding(inv))}`, toValue: `${KINDS[b.kind]} ${money(row.amount)} - waiting for approval`, reason: row.reason,
  });
  res.status(201).json(shape(row));
});

async function decide(req, res, to) {
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: 'Only an Accounts approver (Super Admin, Admin, or an Accountant with approve on Invoices) can do this.' });
  const note = String((req.body && (req.body.note || req.body.reason)) || '').trim();
  const adj = await prisma.invoiceAdjustment.findUnique({ where: { id: req.params.aid } });
  if (!adj) return res.status(404).json({ error: 'Adjustment not found' });
  const inv = await scopedInvoice(req.user, adj.invoiceId);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (to === 'Approved') {
    if (adj.status !== 'Pending') return res.status(409).json({ error: `This adjustment is already ${adj.status}.` });
    if (adj.requestedById && adj.requestedById === req.user.id) return res.status(403).json({ error: 'You asked for this adjustment, so another approver must approve it (maker-checker).' });
    if (P(adj.amount) > P(invoiceOutstanding(inv))) return res.status(400).json({ error: `Only ${money(invoiceOutstanding(inv))} is outstanding now - this adjustment is too big.` });
  } else if (to === 'Rejected') {
    if (adj.status !== 'Pending') return res.status(409).json({ error: `This adjustment is already ${adj.status}.` });
    if (note.length < 3) return res.status(400).json({ error: 'Say why it is rejected.' });
  } else if (to === 'Reversed') {
    if (adj.status !== 'Approved') return res.status(409).json({ error: 'Only an approved adjustment can be reversed.' });
    if (note.length < 3) return res.status(400).json({ error: 'Say why it is reversed.' });
  }
  const out = await prisma.$transaction(async (tx) => {
    const fresh = await tx.invoice.findUnique({ where: { id: inv.id } });
    const cur = await tx.invoiceAdjustment.findUnique({ where: { id: adj.id } });
    if ((to === 'Approved' || to === 'Rejected') && cur.status !== 'Pending') throw Object.assign(new Error(`Already ${cur.status}.`), { http: 409 });
    if (to === 'Reversed' && cur.status !== 'Approved') throw Object.assign(new Error('Not approved.'), { http: 409 });
    let adjusted = P(fresh.adjustedAmount);
    if (to === 'Approved') adjusted += P(adj.amount);
    if (to === 'Reversed') adjusted -= P(adj.amount);
    const next = { ...fresh, adjustedAmount: adjusted / 100 };
    const status = deriveInvoiceStatus(next);
    let lastDate = fresh.paidDate;
    if (status === 'Paid' && !lastDate) {
      const last = await tx.invoicePayment.findFirst({ where: { invoiceId: inv.id }, orderBy: { date: 'desc' }, select: { date: true } });
      lastDate = last ? last.date : null; // an adjustment is not a payment: never dated "today"
    }
    const updatedInv = to === 'Rejected' ? fresh : await tx.invoice.update({
      where: { id: inv.id },
      data: { adjustedAmount: adjusted / 100, status, paidDate: status === 'Paid' ? lastDate : (fresh.status === 'Paid' ? null : fresh.paidDate) },
    });
    const updated = await tx.invoiceAdjustment.update({
      where: { id: adj.id }, data: { status: to, decidedById: req.user.id, decidedBy: who(req), decidedAt: new Date(), decisionNote: note || null },
    });
    return { updated, inv: updatedInv, before: fresh };
  }).catch((e) => ({ error: e }));
  if (out.error) return res.status(out.error.http || 500).json({ error: out.error.http ? out.error.message : 'That did not work. Nothing was changed.' });
  await logAudit({
    userId: req.user.id, action: `Invoice adjustment ${to.toLowerCase()}`, entity: 'Invoice', entityId: inv.id,
    fromValue: `${KINDS[adj.kind]} ${money(adj.amount)} - was ${adj.status}; outstanding ${money(invoiceOutstanding(out.before))}`, toValue: `${to}; outstanding ${money(invoiceOutstanding(out.inv))}; status ${out.inv.status}`, reason: note || adj.reason,
  });
  return res.json({ ...shape(out.updated), invoice: { id: out.inv.id, status: out.inv.status, adjusted: ROUND(out.inv.adjustedAmount), outstanding: invoiceOutstanding(out.inv) } });
}
router.post('/adjustments/:aid/approve', requireInternal, (req, res) => decide(req, res, 'Approved'));
router.post('/adjustments/:aid/reject', requireInternal, (req, res) => decide(req, res, 'Rejected'));
router.post('/adjustments/:aid/reverse', requireInternal, (req, res) => decide(req, res, 'Reversed'));

module.exports = router;
