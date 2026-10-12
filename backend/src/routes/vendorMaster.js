// ---------------------------------------------------------------------------
// ADMINISTRATION → VENDOR LOGINS → VENDORS (Vendor Management), 2026-10-09.
// /api/vendor-master — staff only (a vendor token never gets here: the global
// guard answers 403 first). Same door as /api/vendor-logins: Super Admin, Admin,
// or a login that already manages users / holds the Vendor Logins grant.
//
// It works on the SAME vendor master (OfficeVendor) as Office & Accounts → Add
// Vendor; every rule (duplicate GSTIN / PAN / email / name, warnings, soft
// delete) lives in utils/vendorMaster.js, so the two screens cannot disagree.
//
//   GET    /                       list + search + filters (cascading counts)
//   GET    /categories             the categories already used
//   GET    /:id                    one vendor: details, logins, invoices + payment status, documents
//   POST   /                       add a vendor
//   PATCH  /:id                    edit a vendor
//   POST   /:id/deactivate|activate   switch off / on (never deleted)
//   GET    /:id/unlinked-bills     old bills whose free-text vendor name equals this vendor
//   POST   /:id/link-bills         tie those bills to the vendor (Admin's decision, one vendor at a time)
//   POST   /:id/documents          share a document with this vendor (multipart)
//   GET    /:id/documents/:docId/file   open it
//   DELETE /:id/documents/:docId   stop sharing (the row is kept)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const VM = require('../utils/vendorMaster');
const VP = require('../utils/vendorPortal');
const VF = require('../utils/vendorFiles');
const INV = require('../utils/vendorInvoices');
const attachments = require('../utils/attachments');

const router = express.Router();
router.use(requireAuth);

async function mayManage(user) {
  if (!user) return false;
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return true;
  const [a, b] = await Promise.all([
    can(user, null, 'administration', 'Vendor Logins', 'edit').catch(() => false),
    can(user, null, 'administration', 'Users', 'edit').catch(() => false),
  ]);
  return !!(a || b);
}
router.use(async (req, res, next) => {
  if (await mayManage(req.user)) return next();
  return res.status(403).json({ error: 'Only Admin (or a login that manages users) can manage vendors.' });
});

const { str } = VP;
const actorOf = (req) => req.user.name || req.user.email || 'Admin';
const actor = (req) => ({ id: req.user.id, name: actorOf(req) });
const audit = (req, row) => VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: 'Admin', ...row });
const DOC_TYPES = ['Agreement', 'Purchase order', 'Payment advice', 'TDS certificate', 'Statement', 'Other'];

const rowOf = (v, extra = {}) => ({
  id: v.id,
  vendorCode: v.vendorCode || null,
  name: v.name,
  companyName: v.companyName || null,
  contactPerson: v.contactPerson || null,
  email: v.email || null,
  phone: v.phone || null,
  address: v.address || null,
  gstin: v.gstin || null,
  pan: v.pan || null,
  category: v.category || null,
  paymentTerms: v.paymentTerms || null,
  notes: v.notes || null,
  isActive: v.isActive !== false,
  statusText: v.isActive === false ? 'Switched off' : 'Active',
  deactivatedAt: v.deactivatedAt || null,
  deactivationReason: v.deactivationReason || null,
  source: v.source || null,
  createdAt: v.createdAt,
  ...extra,
});

router.get('/', async (req, res) => {
  const q = req.query || {};
  const [all, logins, bills] = await Promise.all([
    prisma.officeVendor.findMany({ orderBy: { name: 'asc' } }),
    prisma.vendorUser.groupBy({ by: ['vendorId'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.officeExpense.groupBy({ by: ['vendorId'], where: { vendorId: { not: null }, paidStatus: 'Unpaid', NOT: { approvalStatus: 'REJECTED' } }, _count: { _all: true }, _sum: { monthlyAmount: true } }),
  ]);
  const loginN = new Map(logins.map((l) => [l.vendorId, l._count._all]));
  const unpaid = new Map(bills.map((b) => [b.vendorId, { n: b._count._all, sum: b._sum.monthlyAmount || 0 }]));
  const rows = all.map((v) => rowOf(v, { logins: loginN.get(v.id) || 0, unpaidBills: (unpaid.get(v.id) || { n: 0 }).n }));
  const s = str(q.q).toLowerCase();
  const pass = (r, skip) => (skip === 'status' || !str(q.status) || (str(q.status) === 'Active') === r.isActive)
    && (skip === 'category' || !str(q.category) || r.category === str(q.category))
    && (skip === 'login' || !str(q.login) || (str(q.login) === 'yes') === (r.logins > 0))
    && (!s || [r.name, r.companyName, r.vendorCode, r.contactPerson, r.email, r.phone, r.gstin, r.pan].some((x) => String(x || '').toLowerCase().includes(s)));
  const count = (list, key, label) => {
    const m = new Map();
    list.forEach((r) => { const k = key(r); if (k == null || k === '') return; const o = m.get(k) || { value: k, label: label(r), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  };
  res.json({
    rows: rows.filter((r) => pass(r)),
    total: rows.length,
    facets: {
      status: count(rows.filter((r) => pass(r, 'status')), (r) => (r.isActive ? 'Active' : 'Inactive'), (r) => (r.isActive ? 'Active' : 'Switched off')),
      category: count(rows.filter((r) => pass(r, 'category')), (r) => r.category, (r) => r.category),
      login: count(rows.filter((r) => pass(r, 'login')), (r) => (r.logins > 0 ? 'yes' : 'no'), (r) => (r.logins > 0 ? 'Has a login' : 'No login yet')),
    },
  });
});

router.get('/categories', async (req, res) => {
  const rows = await prisma.officeVendor.groupBy({ by: ['category'], where: { category: { not: null } }, _count: { _all: true } });
  res.json(rows.map((r) => ({ name: r.category, count: r._count._all })).sort((a, b) => a.name.localeCompare(b.name)));
});

const unlinkedFor = async (v) => {
  const key = VM.nameKey(v.name);
  const rows = await prisma.officeExpense.findMany({
    where: { vendorId: null, vendor: { not: null } },
    select: { id: true, expenseCode: true, vendor: true, expenseDate: true, monthlyAmount: true, billNumber: true },
    orderBy: { expenseDate: 'desc' },
  });
  return rows.filter((e) => VM.nameKey(e.vendor) === key);
};

router.get('/:id', async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: String(req.params.id) } });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  const [logins, docs, inv, unlinked] = await Promise.all([
    prisma.vendorUser.findMany({ where: { vendorId: v.id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    prisma.vendorSharedDocument.findMany({ where: { vendorId: v.id, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    INV.listVendorInvoices(v.id),
    unlinkedFor(v),
  ]);
  res.json({
    vendor: rowOf(v),
    logins: logins.map((l) => ({
      id: l.id, name: l.name, email: l.email, status: l.status, locked: !!(l.lockedUntil && new Date(l.lockedUntil) > new Date()),
      mustChangePassword: l.mustChangePassword, lastLoginAt: l.lastLoginAt,
    })),
    documents: docs.map((d) => ({ id: d.id, title: d.title, docType: d.docType, name: d.name, size: d.size, note: d.note, sharedByName: d.sharedByName, createdAt: d.createdAt })),
    invoices: inv.rows,
    invoiceSummary: inv.summary,
    unlinkedBills: { count: unlinked.length, sample: unlinked.slice(0, 5).map((e) => ({ id: e.id, expenseCode: e.expenseCode, date: e.expenseDate, amount: e.monthlyAmount })) },
    docTypes: DOC_TYPES,
  });
});

router.post('/', async (req, res) => {
  const out = await VM.createVendor(req.body || {}, { actor: actor(req), source: 'Admin' });
  if (!out.row) return res.status(out.status).json(out.body);
  const row = out.row;
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: 'Vendor added', entity: 'OfficeVendor', entityId: row.id, fromValue: '— (new)',
    toValue: [row.vendorCode, row.name, row.gstin && `GSTIN ${row.gstin}`, row.pan && `PAN ${row.pan}`, row.email, row.phone].filter(Boolean).join(' · ').slice(0, 500),
  });
  await audit(req, { vendorId: row.id, action: 'Vendor added', newValue: `${row.vendorCode} · ${row.name}` });
  return res.status(201).json({ vendor: rowOf(row), message: `Vendor ${row.name} added (${row.vendorCode}).` });
});

router.patch('/:id', async (req, res) => {
  const out = await VM.updateVendor(req.params.id, req.body || {}, { actor: actor(req) });
  if (!out.row) return res.status(out.status).json(out.body);
  for (const c of out.changes) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, { vendorId: out.row.id, action: 'Vendor edited', field: c.field, oldValue: c.from, newValue: c.to });
  }
  if (out.changes.length) {
    await logAudit({
      userId: req.user.id, actorName: actorOf(req), action: 'Vendor edited', entity: 'OfficeVendor', entityId: out.row.id,
      fromValue: out.changes.map((c) => `${c.label}: ${c.from || '—'}`).join(' · ').slice(0, 500),
      toValue: out.changes.map((c) => `${c.label}: ${c.to || '—'}`).join(' · ').slice(0, 500),
    });
  }
  return res.json({ vendor: rowOf(out.row), changed: out.changes.map((c) => c.field), message: out.unchanged ? 'Nothing changed.' : 'Saved.' });
});

async function switchTo(req, res, on) {
  const cur = await prisma.officeVendor.findUnique({ where: { id: String(req.params.id) } });
  if (!cur) return res.status(404).json({ error: 'Vendor not found.' });
  const reason = VP.cleanText((req.body || {}).reason, 300);
  if (!on && reason.length < 3) return res.status(400).json({ error: 'Write why this vendor is being switched off.', field: 'reason' });
  const row = await VM.setVendorActive(cur.id, on, { actor: actor(req), reason });
  if ((cur.isActive !== false) !== on) {
    await audit(req, { vendorId: cur.id, action: on ? 'Vendor switched on' : 'Vendor switched off', field: 'isActive', oldValue: String(cur.isActive !== false), newValue: String(on), status: reason || null });
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: on ? 'Vendor switched on' : 'Vendor switched off', entity: 'OfficeVendor', entityId: cur.id, toValue: cur.name, reason: reason || null });
  }
  return res.json({ vendor: rowOf(row), message: on ? `${cur.name} is on again.` : `${cur.name} is switched off. Its logins are signed out. Nothing was deleted.` });
}
router.post('/:id/deactivate', (req, res) => switchTo(req, res, false));
router.post('/:id/activate', (req, res) => switchTo(req, res, true));

router.get('/:id/unlinked-bills', async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: String(req.params.id) } });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  res.json({ rows: await unlinkedFor(v) });
});

router.post('/:id/link-bills', async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: String(req.params.id) } });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  if (v.isActive === false) return res.status(400).json({ error: 'Switch the vendor on before linking bills to it.' });
  const list = await unlinkedFor(v);
  const b = req.body || {};
  const ids = b.all === true ? list.map((e) => e.id) : (Array.isArray(b.expenseIds) ? b.expenseIds.map(String) : []);
  const ok = list.filter((e) => ids.includes(e.id)).map((e) => e.id);
  if (!ok.length) return res.status(400).json({ error: 'No matching bills to link.' });
  const snap = VM.vendorSnapshot(v);
  const r = await prisma.officeExpense.updateMany({
    where: { id: { in: ok }, vendorId: null },
    data: { vendorId: snap.vendorId, vendorPan: snap.vendorPan, vendorAddress: snap.vendorAddress },
  });
  // The bill's own GSTIN (if it had one) stays; bills without one take the master's.
  if (snap.vendorGstin) await prisma.officeExpense.updateMany({ where: { id: { in: ok }, vendorGstin: null }, data: { vendorGstin: snap.vendorGstin } });
  await audit(req, { vendorId: v.id, action: 'Old bills linked to vendor', newValue: `${r.count} bill(s)` });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Old bills linked to vendor', entity: 'OfficeVendor', entityId: v.id, toValue: `${v.name}: ${r.count} bill(s)` });
  return res.json({ linked: r.count, message: `${r.count} bill(s) are now linked to ${v.name}.` });
});

// ---- journal posting switch (Admin) ------------------------------------------
// Default OFF. ON = bills linked to a vendor are posted to the journal when they
// are approved and again when they are paid (utils/vendorPosting.js).
const POST = require('../utils/vendorPosting');
router.get('/journal-posting/status', async (req, res) => {
  res.json({ ...(await POST.settings()), accounts: POST.ACCOUNTS.map((a) => ({ code: a.code, name: a.name })) });
});
router.put('/journal-posting/status', async (req, res) => {
  const on = (req.body || {}).enabled === true;
  const before = await POST.settings();
  const now = await POST.setEnabled(on, req.user);
  if (before.enabled !== now.enabled) {
    await audit(req, { action: on ? 'Vendor journal posting switched on' : 'Vendor journal posting switched off', field: 'vendor.journalPosting', oldValue: String(before.enabled), newValue: String(now.enabled) });
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: on ? 'Vendor journal posting switched on' : 'Vendor journal posting switched off', entity: 'AppSetting', entityId: POST.KEY });
  }
  res.json({ ...now, message: on ? 'Vendor bills will now be posted to the journal.' : 'Vendor bills are no longer posted to the journal.' });
});
router.post('/journal-posting/sync', async (req, res) => {
  const r = await POST.syncAll(actor(req));
  if (!r.enabled) return res.status(400).json({ error: 'Vendor journal posting is switched off.', ...r });
  await audit(req, { action: 'Vendor journal posting run', newValue: `checked ${r.checked}, posted ${r.posted}, problems ${r.problems.length}` });
  res.json({ ...r, message: `Checked ${r.checked} bill(s): ${r.posted} posted, ${r.inSync} already posted, ${r.problems.length} to look at.` });
});

// ---- shared documents --------------------------------------------------------
router.post('/:id/documents', async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: String(req.params.id) } });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  let form;
  try { form = await VF.readUpload(req); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  let st;
  try { st = VF.storeFile(form.file); } catch (err) { return res.status(400).json({ error: VF.fileError(err) }); }
  const title = VP.cleanText((form.fields || {}).title, 120) || st.billName;
  const docType = DOC_TYPES.includes(str((form.fields || {}).docType)) ? str(form.fields.docType) : 'Other';
  const note = VP.cleanText((form.fields || {}).note, 300) || null;
  let doc;
  try {
    doc = await prisma.vendorSharedDocument.create({
      data: { vendorId: v.id, title, docType, name: st.billName, mime: st.billMime, size: st.billSize, file: st.billFile, note, sharedById: req.user.id, sharedByName: actorOf(req) },
    });
  } catch (err) { attachments.remove(st.billFile); throw err; }
  await audit(req, { vendorId: v.id, action: 'Document shared with vendor', documentName: st.billName, newValue: `${docType} · ${title}` });
  return res.status(201).json({ document: { id: doc.id, title, docType, name: doc.name, size: doc.size, note, createdAt: doc.createdAt }, message: 'Shared. The vendor can see it in their portal.' });
});

router.get('/:id/documents/:docId/file', async (req, res) => {
  const d = await prisma.vendorSharedDocument.findFirst({ where: { id: String(req.params.docId), vendorId: String(req.params.id) } });
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  await audit(req, { vendorId: d.vendorId, action: 'Shared document opened by staff', documentName: d.name });
  return VF.sendStored(res, d.file, d.mime, d.name);
});

router.delete('/:id/documents/:docId', async (req, res) => {
  const d = await prisma.vendorSharedDocument.findFirst({ where: { id: String(req.params.docId), vendorId: String(req.params.id), revokedAt: null } });
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  await prisma.vendorSharedDocument.update({ where: { id: d.id }, data: { revokedAt: new Date(), revokedById: req.user.id } });
  await audit(req, { vendorId: d.vendorId, action: 'Document no longer shared', documentName: d.name });
  return res.json({ ok: true, message: 'Not shared any more. The file is kept.' });
});

module.exports = router;
