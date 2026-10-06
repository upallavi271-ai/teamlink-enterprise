// ---------------------------------------------------------------------------
// ACCOUNTS → OFFICE & ACCOUNTS → "BILLS FROM VENDORS" (P3 2026-10-05, v2 2026-10-06).
// /api/vendor-bills — the Accounts review of bills vendors sent through the
// Vendor Portal. Same door as Office & Expenses: Accounts product, the
// Office & Expenses view grant and an Accounts-desk role (the EXISTING Bills
// permission — spec v2 §19: no new grant for Accounts roles).
//
// WHY A SEPARATE LAYER (not new OfficeExpense statuses): an OfficeExpense
// row is live accounting — a PENDING one already counts in "Pending to pay",
// GST paid and the P&L, and the expense workflow is deliberately only
// Pending -> Paid. A vendor's bill is a CLAIM until Accounts checks it, so it
// waits here as PENDING_REVIEW (optionally VERIFIED) and touches no total.
// DECISION (v2 §21): the Accounts bill is created at APPROVAL, not at
// verification — "Verified" only says a human looked at it. APPROVE books
// ONE ordinary OfficeExpense (Pending to pay, tagged "Vendor Portal"), which
// then follows the existing Pending -> Paid flow; the vendor sees "Paid" once
// that expense is paid. REJECT keeps the reason; the vendor sees it. Nothing
// is booked twice: the bill holds the expense id (unique).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const { roleForProduct, SET } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const VP = require('../utils/vendorPortal');
const VC = require('../utils/vendorConfig');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Office & Expenses', 'view'));
router.use((req, res, next) => {
  const role = roleForProduct(req.user, 'accounts');
  if (role && SET.ACCOUNTS.includes(role)) return next();
  return res.status(403).json({ error: 'Bills from vendors are open to Super Admin, Admin and Accounts only' });
});
const office = () => require('./office'); // eslint-disable-line global-require
const { str, ROUND } = VP;
const actorOf = (req) => req.user.name || req.user.email || 'Accounts';
const roleOf = (req) => (['SUPER_ADMIN', 'ADMIN'].includes(roleForProduct(req.user, 'accounts')) ? 'Admin' : 'Accounts');
const MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];
const audit = (req, row) => VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: roleOf(req), ...row });

async function viewOf(b, extra = {}) {
  const shown = VP.shownStatus(b, extra.expense);
  let original = null;
  try { original = b.originalValues ? JSON.parse(b.originalValues) : null; } catch { original = null; }
  return {
    id: b.id,
    billCode: b.billCode,
    billNumber: b.billNumber,
    vendorId: b.vendorId,
    vendorName: b.vendor ? b.vendor.name : (extra.vendorName || ''),
    assetId: b.assetId,
    assetCode: b.assetCode,
    assetName: b.assetName,
    billDate: b.billDate,
    amount: b.amount,
    gst: b.gst,
    tds: b.tds,
    afterGst: ROUND(Number(b.amount || 0) + Number(b.gst || 0)),
    total: b.total,
    payable: b.total,
    remarks: b.remarks,
    document: b.documentFile ? { name: b.documentName, mime: b.documentMime, size: b.documentSize } : null,
    supporting: VP.parseDocs(b.supportingDocs).map((d, i) => ({ index: i, name: d.name, size: d.size })),
    submittedBy: b.vendorUser ? `${b.vendorUser.name} (${b.vendorUser.email})` : b.submittedByName,
    submittedAt: b.submittedAt,
    source: b.source || 'Vendor Portal',
    version: b.version || 1,
    parentSubmissionId: b.parentSubmissionId || null,
    status: shown,
    storedStatus: b.status,
    statusText: VP.BILL_STATUS_LABEL[shown] || shown,
    rejectionReason: b.rejectionReason,
    reviewRemarks: b.reviewRemarks,
    reviewedByName: b.reviewedByName,
    reviewedAt: b.reviewedAt,
    verifiedAt: b.verifiedAt,
    withdrawnAt: b.withdrawnAt || null,
    expenseId: b.expenseId,
    accountsBillId: b.expenseId,
    expenseCode: extra.expense ? extra.expense.expenseCode : (extra.expenseCode || null),
    expenseStatus: extra.expense ? extra.expense.approvalStatus : null,
    originalValues: original,
  };
}
const INCLUDE = { vendor: { select: { name: true } }, vendorUser: { select: { name: true, email: true } } };

async function access(user) {
  const [approver, edit] = await Promise.all([
    office().isApprover(user).catch(() => false),
    can(user, 'accounts', 'accounts', 'Office & Expenses', 'edit').catch(() => false),
  ]);
  const admin = ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
  return { canReview: !!approver, canEdit: !!edit, canManageLogins: admin || !!(await can(user, null, 'administration', 'Vendor Logins', 'edit').catch(() => false)) };
}
async function expensesOf(rows) {
  const ids = rows.map((b) => b.expenseId).filter(Boolean);
  const list = ids.length ? await prisma.officeExpense.findMany({ where: { id: { in: ids } }, select: { id: true, expenseCode: true, approvalStatus: true } }) : [];
  return new Map(list.map((e) => [e.id, e]));
}

// The count badge for authorised users (bills waiting for a check).
router.get('/pending-count', async (req, res) => {
  const n = await prisma.vendorBillSubmission.count({ where: { status: { in: ['PENDING_REVIEW', 'VERIFIED'] } } });
  res.json({ pending: n });
});

// The list. Filters cascade: each filter's choices are counted over the rows
// the other filters leave. The status filter works on the SHOWN status
// (Paid = approved and paid in Accounts).
router.get('/', async (req, res) => {
  const q = req.query || {};
  const all = await prisma.vendorBillSubmission.findMany({ include: INCLUDE, orderBy: { submittedAt: 'desc' } });
  const em = await expensesOf(all);
  const shownOf = (b) => VP.shownStatus(b, em.get(b.expenseId));
  const s = str(q.q).toLowerCase();
  const pass = (b, skip) => (skip === 'status' || !str(q.status) || shownOf(b) === str(q.status))
    && (skip === 'vendor' || !str(q.vendorId) || b.vendorId === str(q.vendorId))
    && (!s || [b.billCode, b.billNumber, b.assetCode, b.assetName, b.vendor && b.vendor.name].some((v) => String(v || '').toLowerCase().includes(s)));
  const rows = all.filter((b) => pass(b));
  const count = (list, key, label) => {
    const m = new Map();
    list.forEach((b) => { const k = key(b); if (!k) return; const o = m.get(k) || { value: k, label: label(b), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()];
  };
  const counts = {};
  all.forEach((b) => { const k = shownOf(b); counts[k] = (counts[k] || 0) + 1; });
  res.json({
    rows: await Promise.all(rows.map((b) => viewOf(b, { expense: em.get(b.expenseId) }))),
    counts,
    pending: all.filter((b) => ['PENDING_REVIEW', 'VERIFIED'].includes(b.status)).length,
    facets: {
      status: count(all.filter((b) => pass(b, 'status')), shownOf, (b) => VP.BILL_STATUS_LABEL[shownOf(b)]),
      vendor: count(all.filter((b) => pass(b, 'vendor')), (b) => b.vendorId, (b) => (b.vendor ? b.vendor.name : '')),
    },
    access: await access(req.user),
  });
});

async function load(id) {
  return prisma.vendorBillSubmission.findUnique({ where: { id: String(id || '') }, include: INCLUDE });
}

function sendStored(res, file, mime, name) {
  const full = attachments.resolveStored(file);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  res.setHeader('Content-Type', attachments.ALLOWED[mime] ? mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(name)}"`);
  return res.sendFile(full);
}
router.get('/:id/document', async (req, res) => {
  const b = await load(req.params.id);
  if (!b || !b.documentFile) return res.status(404).json({ error: 'No bill document.' });
  await audit(req, { assetId: b.assetId, vendorId: b.vendorId, action: 'Bill document downloaded', billId: b.id, documentName: b.documentName });
  return sendStored(res, b.documentFile, b.documentMime, b.documentName);
});
router.get('/:id/supporting/:idx', async (req, res) => {
  const b = await load(req.params.id);
  const d = b && VP.parseDocs(b.supportingDocs)[Number(req.params.idx)];
  if (!d) return res.status(404).json({ error: 'No such file.' });
  await audit(req, { assetId: b.assetId, vendorId: b.vendorId, action: 'Bill document downloaded', billId: b.id, documentName: d.name });
  return sendStored(res, d.file, d.mime, d.name);
});

const OPEN = ['PENDING_REVIEW', 'VERIFIED'];
function money(v, label) {
  if (v === undefined) return { skip: true };
  const n = Number(String(v ?? '').replace(/[,\s₹]/g, '') || 0);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be 0 or more.` };
  return { n: ROUND(n) };
}
const ORIGINAL_KEYS = ['billNumber', 'billDate', 'amount', 'gst', 'tds', 'total'];

// Edit the accounting fields while the bill is still open (edit grant). The
// vendor's ORIGINAL values are kept on the row the first time Accounts
// changes anything; every change is audited old -> new.
router.patch('/:id', async (req, res) => {
  if (!(await can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit'))) return res.status(403).json({ error: 'You can view these bills but not change them.' });
  const b = await load(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bill not found.' });
  if (!OPEN.includes(b.status)) return res.status(409).json({ error: 'This bill is already decided and cannot be changed here.' });
  const body = req.body || {};
  const data = {};
  for (const [k, label] of [['amount', 'Amount before GST'], ['gst', 'GST'], ['tds', 'TDS']]) {
    const m = money(body[k], label);
    if (m.error) return res.status(400).json({ error: m.error, field: k });
    if (!m.skip) data[k] = m.n;
  }
  if (body.billNumber !== undefined) { const v = VP.cleanText(body.billNumber, 60); if (!v) return res.status(400).json({ error: 'Enter the bill number.' }); data.billNumber = v; data.billNumberKey = VP.billKey(v); }
  if (body.billDate !== undefined) { if (!VP.isRealDay(body.billDate)) return res.status(400).json({ error: 'Pick a proper bill date.' }); data.billDate = str(body.billDate); }
  if (body.reviewRemarks !== undefined) data.reviewRemarks = VP.cleanText(body.reviewRemarks, 1000) || null;
  const amount = data.amount ?? b.amount;
  const gst = data.gst ?? b.gst;
  const tds = data.tds ?? b.tds;
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount before GST must be more than 0.' });
  if (tds > amount) return res.status(400).json({ error: 'TDS cannot be more than the amount before GST.' });
  data.total = VP.billTotal(amount, gst, tds);
  const changed = Object.keys(data).filter((k) => k !== 'billNumberKey' && String(data[k] ?? '') !== String(b[k] ?? ''));
  if (!changed.length) return res.json({ bill: await viewOf(b), message: 'Nothing changed.' });
  if (!b.originalValues && changed.some((k) => ORIGINAL_KEYS.includes(k))) {
    data.originalValues = JSON.stringify(Object.fromEntries(ORIGINAL_KEYS.map((k) => [k, b[k]])));
  }
  const up = await prisma.vendorBillSubmission.update({ where: { id: b.id }, data, include: INCLUDE });
  for (const k of changed) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, { assetId: b.assetId, vendorId: b.vendorId, action: 'Bill edited by Accounts', billId: b.id, field: k, oldValue: b[k] ?? '', newValue: data[k] ?? '', status: b.status });
  }
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor bill edited by Accounts', entity: 'VendorBillSubmission', entityId: b.id, toValue: changed.map((k) => `${k} ${b[k] ?? '—'} → ${data[k] ?? '—'}`).join(' · ').slice(0, 900) });
  return res.json({ bill: await viewOf(up), message: 'Saved.' });
});

// The vendor is told by email when a bill is approved / rejected (only when
// the "Vendor emails" switch is on). A vendor login has no in-app inbox; the
// status and the reason are always on their portal.
async function tellVendor(b, to, reason, expenseCode) {
  try {
    const vu = await prisma.vendorUser.findUnique({ where: { id: b.vendorUserId }, select: { email: true, name: true } });
    if (!vu || !vu.email) return;
    const subject = to === 'APPROVED' ? `TeamLink: your bill ${b.billNumber} is approved` : `TeamLink: your bill ${b.billNumber} was rejected`;
    const text = to === 'APPROVED'
      ? `Hello ${vu.name},\n\nYour bill ${b.billNumber} (${b.billCode}) for ${b.assetCode || 'the asset'} is approved${expenseCode ? ` and booked as ${expenseCode}` : ''}. Payment follows the company's usual process.\n\nTeamLink`
      : `Hello ${vu.name},\n\nYour bill ${b.billNumber} (${b.billCode}) for ${b.assetCode || 'the asset'} was rejected.\nReason: ${reason}\n\nYou can send a corrected bill from the Vendor Portal.\n\nTeamLink`;
    await VC.sendVendorEmail({ to: vu.email, subject, text });
  } catch (err) { console.error('[vendor-bill tell vendor]', err && err.message); } // eslint-disable-line no-console
}

async function decide(req, res, to) {
  if (!(await office().isApprover(req.user))) return res.status(403).json({ error: office().APPROVER_ONLY || 'Only an Accounts approver can do this.' });
  const b = await load(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bill not found.' });
  const body = req.body || {};
  const now = new Date();
  const actor = actorOf(req);
  const remarks = body.remarks !== undefined ? (VP.cleanText(body.remarks, 1000) || null) : b.reviewRemarks;
  let expense = null;
  if (to === 'VERIFIED') {
    if (b.status !== 'PENDING_REVIEW') return res.status(409).json({ error: `This bill is ${VP.BILL_STATUS_LABEL[b.status]} already.` });
    const n = await prisma.vendorBillSubmission.updateMany({
      where: { id: b.id, status: 'PENDING_REVIEW' }, data: { status: 'VERIFIED', verifiedById: req.user.id, verifiedAt: now, reviewRemarks: remarks },
    });
    if (!n.count) return res.status(409).json({ error: 'Someone else changed this bill. Open it again.' });
  } else if (to === 'REJECTED') {
    const reason = VP.cleanText(body.reason, 500);
    if (reason.length < 3) return res.status(400).json({ error: 'Write why the bill is rejected (the vendor will see it).', field: 'reason' });
    if (!OPEN.includes(b.status)) return res.status(409).json({ error: `This bill is ${VP.BILL_STATUS_LABEL[b.status]} already.` });
    const n = await prisma.vendorBillSubmission.updateMany({
      where: { id: b.id, status: { in: OPEN } },
      data: { status: 'REJECTED', rejectionReason: reason, reviewRemarks: remarks, reviewedById: req.user.id, reviewedByName: actor, reviewedAt: now },
    });
    if (!n.count) return res.status(409).json({ error: 'Someone else changed this bill. Open it again.' });
    await tellVendor(b, 'REJECTED', reason);
  } else if (to === 'APPROVED') {
    if (!OPEN.includes(b.status)) return res.status(409).json({ error: `This bill is ${VP.BILL_STATUS_LABEL[b.status]} already.` });
    const cat = await office().resolveCategory(req.user, body.category);
    if (cat.error) return res.status(cat.status || 400).json({ error: cat.error, field: 'category' });
    const mode = MODES.includes(body.paymentMode) ? body.paymentMode : 'Bank Transfer';
    const dueDate = body.dueDate ? str(body.dueDate) : null;
    if (dueDate && !VP.isRealDay(dueDate)) return res.status(400).json({ error: 'Pick a proper due date.', field: 'dueDate' });
    // Claim the bill first, so two approvers cannot book it twice.
    const n = await prisma.vendorBillSubmission.updateMany({
      where: { id: b.id, status: { in: OPEN }, expenseId: null },
      data: { status: 'APPROVED', reviewRemarks: remarks, reviewedById: req.user.id, reviewedByName: actor, reviewedAt: now },
    });
    if (!n.count) return res.status(409).json({ error: 'Someone else changed this bill. Open it again.' });
    try {
      const vendor = await prisma.officeVendor.findUnique({ where: { id: b.vendorId } });
      const rate = (x) => (b.amount > 0 && x > 0 ? ROUND((x / b.amount) * 100) : null);
      expense = await office().createWithCode({
        category: cat.name,
        monthlyAmount: ROUND(b.amount + b.gst),
        gstAmount: ROUND(b.gst),
        tdsAmount: ROUND(b.tds),
        gstRatePct: rate(b.gst),
        tdsRatePct: rate(b.tds),
        vendor: vendor ? vendor.name : null,
        vendorGstin: vendor && vendor.gstin ? vendor.gstin : null,
        expenseDate: b.billDate,
        dueDate,
        billNumber: b.billNumber,
        description: `Vendor bill ${b.billNumber} — ${b.assetCode || ''} ${b.assetName || ''}`.replace(/\s+/g, ' ').trim().slice(0, 500),
        notes: `From the Vendor Portal (${b.billCode}), asset ${b.assetCode || b.assetId}.`,
        remarks,
        reportingTags: 'Vendor Portal',
        paymentMode: mode,
        recurring: false,
        frequency: 'One-Time',
        entryKind: 'expense',
        approvalStatus: 'PENDING',
        paidStatus: 'Unpaid',
        createdById: req.user.id,
        updatedById: req.user.id,
      });
    } catch (err) {
      await prisma.vendorBillSubmission.update({ where: { id: b.id }, data: { status: b.status, reviewedById: null, reviewedByName: null, reviewedAt: null } });
      throw err;
    }
    await prisma.vendorBillSubmission.update({ where: { id: b.id }, data: { expenseId: expense.id } });
    await logAudit({
      userId: req.user.id,
      actorName: actor,
      action: 'Expense Created',
      entity: 'OfficeExpense',
      entityId: expense.id,
      fromValue: '— (new)',
      toValue: `${expense.expenseCode || expense.id} · ${b.billDate} · ${cat.name} · ${String(expense.description || '').slice(0, 80)} · ${expense.vendor || '—'} · ${mode} · amount ₹${ROUND(b.amount)} + GST ₹${ROUND(b.gst)} = ₹${ROUND(b.amount + b.gst)}${b.tds > 0 ? ` · TDS ₹${ROUND(b.tds)}` : ''} · Pending · from Vendor Portal ${b.billCode}`,
      approvalStatus: 'PENDING',
    });
    await tellVendor(b, 'APPROVED', null, expense.expenseCode);
  }
  await audit(req, {
    assetId: b.assetId, vendorId: b.vendorId,
    action: to === 'APPROVED' ? 'Bill approved' : (to === 'REJECTED' ? 'Bill rejected' : 'Bill verified'),
    billId: b.id, documentName: b.documentName, status: to, oldValue: b.status, newValue: to === 'REJECTED' ? VP.cleanText(body.reason, 300) : to,
  });
  await logAudit({
    userId: req.user.id, actorName: actor, action: `Vendor bill ${VP.BILL_STATUS_LABEL[to].toLowerCase()}`, entity: 'VendorBillSubmission', entityId: b.id,
    fromValue: VP.BILL_STATUS_LABEL[b.status], toValue: `${b.billCode} · ${b.billNumber} · ${VP.BILL_STATUS_LABEL[to]}${to === 'REJECTED' ? ` · ${VP.cleanText(body.reason, 200)}` : ''}`,
    reason: to === 'REJECTED' ? VP.cleanText(body.reason, 500) : null,
  });
  const fresh = await load(b.id);
  const exp = fresh.expenseId ? await prisma.officeExpense.findUnique({ where: { id: fresh.expenseId }, select: { id: true, expenseCode: true, approvalStatus: true } }) : null;
  return res.json({
    bill: await viewOf(fresh, { expense: exp }),
    message: to === 'APPROVED' ? `Approved. Booked as ${exp && exp.expenseCode ? exp.expenseCode : 'an expense'} (Pending to pay).`
      : to === 'REJECTED' ? 'Rejected. The vendor will see the reason.' : 'Marked as verified.',
  });
}
router.post('/:id/verify', (req, res) => decide(req, res, 'VERIFIED'));
router.post('/:id/approve', (req, res) => decide(req, res, 'APPROVED'));
router.post('/:id/reject', (req, res) => decide(req, res, 'REJECTED'));

module.exports = router;
