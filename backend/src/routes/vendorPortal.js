// ---------------------------------------------------------------------------
// THE VENDOR PORTAL API — /api/vendor-portal/* (P3 2026-10-05, v2 2026-10-06).
// The ONLY API a vendor session can reach (utils/vendorAuth.js
// vendorSessionGuard refuses every other path with 403). ONE prefix, kept:
// /api/vendor-portal (there is no /api/vendor/*).
//
// Every route after /login:
//   1. validates the token AND its server-side session (requireVendor);
//   2. the caller is a VendorUser (a separate table — not a staff role);
//   3. vendorUserId / vendorId come from the session row;
//   4. any vendorId / vendorUserId in the body, query or URL is ignored;
//   5. assets are read only through vendorAssetWhere() (own vendor AND
//      assigned to this login, not archived);
//   6. every /assets/:id operation re-checks that ownership first;
//   7. a bill / document is reached only through an asset that passes 6.
// Out of reach and does-not-exist give the SAME 403, so ids cannot be probed.
// FEATURE FLAG: VENDOR_PORTAL_ENABLED (utils/vendorConfig.js) — OFF = every
// route here answers 404, nothing else in the app changes.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const attachments = require('../utils/attachments');
const { rateLimit, ipOf } = require('../utils/publicRateLimit');
const { logAudit } = require('../utils/audit');
const VA = require('../utils/vendorAuth');
const VP = require('../utils/vendorPortal');
const VC = require('../utils/vendorConfig');

const router = express.Router();
const { str, ROUND } = VP;
const NOT_YOURS = { error: 'Forbidden. This asset is not assigned to you.' };
const NOT_YOUR_BILL = { error: 'Forbidden. This bill is not yours.' };
const INVALID = 'Invalid credentials.';
// PDF / JPG / PNG only (v2 §10) — WebP, which the shared store accepts, is not.
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const SUPPORTING_MAX = 5;
const FILE_MESSAGE = {
  NO_FILE: 'Choose the file to upload.',
  TOO_LARGE: `That file is bigger than ${Math.round(VC.CFG.uploadMaxBytes / 1048576)} MB. Please upload a smaller PDF or photo.`,
  BAD_TYPE: 'Only a PDF, JPG or PNG file can be uploaded.',
  CONTENT_MISMATCH: "That file doesn't look like a real PDF or photo. Please choose the original file.",
  NOT_MULTIPART: 'Could not read the upload. Please try again.',
};
const fileError = (err) => FILE_MESSAGE[err && err.code] || 'Could not save the file. Please try again.';
const DOC_TYPES = ['Warranty card', 'AMC contract', 'Service report', 'Invoice copy', 'Photo', 'Other'];
const today = () => new Date().toISOString().slice(0, 10);
const num2 = (v) => { const r = String(v ?? '').replace(/[,\s₹]/g, ''); if (r === '') return 0; const n = Number(r); return Number.isFinite(n) ? ROUND(n) : NaN; };

// Feature flag first: OFF = the portal does not exist.
router.use((req, res, next) => (VC.portalEnabled() ? next() : res.status(404).json({ error: 'Not found.' })));
// A general limit on top of the login limit (v2 §14): per network, 5 minutes.
router.use(rateLimit({ bucket: 'vendor-api', max: Number(process.env.VENDOR_API_MAX_PER_5MIN || 600), windowMs: 5 * 60000 }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// A vendor event not tied to an asset (sign-in, sign-out, password …) — the
// same append-only table, assetId null, with IP + user agent.
const event = (req, row) => VP.auditReq(req, { role: 'Vendor', ...row });

router.get('/status', (req, res) => res.json({ enabled: true, idleMinutes: VC.CFG.idleMinutes, maxHours: VC.CFG.maxHours }));

// ---- sign in ----------------------------------------------------------------
// Limits: per network (30 / 15 min) AND per network+account (10 / 15 min).
// Lock: VENDOR_MAX_FAILED_LOGINS (5) wrong passwords lock for VENDOR_LOCK_MINUTES
// (30), then it unlocks by itself; Admin can unlock earlier. The counter
// resets on success. EVERY refusal reads "Invalid credentials." — unknown
// email, wrong password, locked, switched off, vendor switched off, expired
// temporary password — so nothing about the account leaks before sign-in.
const ipLimit = rateLimit({ bucket: 'vendor-login-ip', max: Number(process.env.VENDOR_LOGIN_IP_MAX || 30), windowMs: 15 * 60000 });
const perEmail = new Map();
function emailLimit(req, res, next) {
  const key = `${ipOf(req)}|${VP.normEmail(req.body && req.body.email)}`;
  const now = Date.now();
  const list = (perEmail.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (list.length >= Number(process.env.VENDOR_LOGIN_EMAIL_MAX || 10)) {
    res.set('Retry-After', '900');
    return res.status(429).json({ error: 'Too many sign-in tries. Please wait 15 minutes and try again.' });
  }
  list.push(now);
  perEmail.set(key, list);
  if (perEmail.size > 5000) perEmail.clear();
  return next();
}
const DUMMY_HASH = bcrypt.hashSync(`x${Math.random()}`, 10);
const isLocked = (vu) => !!(vu.lockedUntil && new Date(vu.lockedUntil) > new Date());

router.post('/login', ipLimit, emailLimit, async (req, res) => {
  const email = VP.normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const vu = await prisma.vendorUser.findUnique({ where: { email }, include: { vendor: true } });
  const refuse = async (why) => {
    if (vu) await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login failed', status: why });
    return res.status(401).json({ error: INVALID });
  };
  if (!vu) { await bcrypt.compare(password, DUMMY_HASH); return res.status(401).json({ error: INVALID }); }
  if (isLocked(vu)) return refuse('locked');
  const ok = await bcrypt.compare(password, vu.passwordHash);
  if (!ok) {
    const failed = (vu.failedLoginAttempts || 0) + 1;
    const lock = failed >= VC.CFG.maxFailed;
    await prisma.vendorUser.update({
      where: { id: vu.id },
      data: lock ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + VC.CFG.lockMinutes * 60000) } : { failedLoginAttempts: failed },
    });
    if (lock) {
      await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login locked', status: `${VC.CFG.maxFailed} wrong passwords · ${VC.CFG.lockMinutes} min` });
      await logAudit({ action: `Vendor login locked after ${VC.CFG.maxFailed} wrong passwords`, entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: `Locked ${VC.CFG.lockMinutes} min` });
      return refuse('locked now');
    }
    return refuse('wrong password');
  }
  if (vu.status !== 'Active' || vu.deletedAt) return refuse('switched off');
  if (!vu.vendor || vu.vendor.isActive === false) return refuse('vendor switched off');
  if (vu.mustChangePassword && vu.tempPasswordExpiresAt && new Date(vu.tempPasswordExpiresAt) < new Date()) return refuse('temporary password expired');
  const meta = VC.requestMeta(req);
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { lastLoginAt: new Date(), lastLoginIp: meta.ip, failedLoginAttempts: 0, lockedUntil: null } });
  const { token } = await VA.createSession(vu, req);
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login success', status: vu.mustChangePassword ? 'must change password' : 'ok' });
  await logAudit({ action: 'Vendor signed in', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: vu.vendor.name });
  return res.json({ token, idleMinutes: VC.CFG.idleMinutes, vendor: meOf({ ...vu, vendorName: vu.vendor.name }) });
});

function meOf(vu) {
  return {
    name: vu.name, email: vu.email, vendorName: vu.vendorName || (vu.vendor && vu.vendor.name) || '',
    canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost, mustChangePassword: !!vu.mustChangePassword,
    lastLoginAt: vu.lastLoginAt || null,
  };
}

const anyVendor = VA.requireVendor({ allowPasswordChange: true });
const vendorOnly = VA.requireVendor();

router.get('/me', anyVendor, (req, res) => res.json({ ...meOf({ ...req.vendor.row, vendorName: req.vendor.vendorName }), idleMinutes: VC.CFG.idleMinutes }));

router.post('/logout', anyVendor, async (req, res) => {
  await prisma.vendorSession.update({ where: { id: req.vendor.sessionId }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
  await event(req, { vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: req.vendor.name, action: 'Logout' });
  res.json({ ok: true, message: 'Signed out.' });
});

// Password change (first sign-in, after an Admin reset, or any time): the
// current password, then the vendor policy (10+ chars, upper / lower / number
// / symbol, not the email), not the current one, not one of the last 3.
// Every other session of this login is signed out.
router.post('/change-password', anyVendor, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const vu = await prisma.vendorUser.findUnique({ where: { id: req.vendor.userId } });
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Enter your current password and a new one.' });
  if (confirmPassword !== undefined && confirmPassword !== newPassword) return res.status(400).json({ field: 'confirmPassword', error: 'The two new passwords do not match.' });
  if (!(await bcrypt.compare(String(currentPassword), vu.passwordHash))) {
    const failed = (vu.failedLoginAttempts || 0) + 1;
    const lock = failed >= VC.CFG.maxFailed;
    await prisma.vendorUser.update({
      where: { id: vu.id },
      data: lock ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + VC.CFG.lockMinutes * 60000) } : { failedLoginAttempts: failed },
    });
    if (lock) await VA.revokeSessions(vu.id, 'locked');
    await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Password change failed', status: 'wrong current password' });
    return res.status(400).json({ field: 'currentPassword', error: 'Your current password is not correct.' });
  }
  const weak = VC.vendorPasswordProblem(newPassword, { email: vu.email, name: vu.name });
  if (weak) return res.status(400).json({ field: 'newPassword', error: weak });
  if (await bcrypt.compare(String(newPassword), vu.passwordHash)) return res.status(400).json({ field: 'newPassword', error: 'Choose a password different from the current one.' });
  for (const h of VC.parseHistory(vu.passwordHistory)) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(String(newPassword), h)) return res.status(400).json({ field: 'newPassword', error: 'You used that password before. Choose a new one.' });
  }
  await prisma.vendorUser.update({
    where: { id: vu.id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), 10), passwordHistory: VC.pushHistory(vu.passwordHistory, vu.passwordHash),
      mustChangePassword: false, tempPasswordExpiresAt: null, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null,
    },
  });
  await VA.revokeSessions(vu.id, 'password changed', req.vendor.sessionId);
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Password changed' });
  await logAudit({ action: 'Vendor password changed', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: 'Changed' });
  res.json({ ok: true, message: 'Password changed.' });
});

// ---- assets -----------------------------------------------------------------
async function myAsset(req, id) {
  const where = await VA.vendorAssetWhere(req.vendor);
  return prisma.asset.findFirst({ where: { AND: [{ id: String(id || '') }, where] } });
}

const DATE_FIELDS = { purchase: 'purchaseDate', warranty: 'warrantyUntil', amc: 'amcUntil' };
// Sort keys the vendor may use. Purchase value / invoice no. only with Show
// Purchase Value ON; otherwise the request is refused (v2 §7 / §12).
const SORTS = { assetCode: 'assetCode', name: 'name', category: 'category', purchaseDate: 'purchaseDate', warrantyUntil: 'warrantyUntil', amcUntil: 'amcUntil', status: 'status', updatedAt: 'updatedAt', location: 'location', serialNumber: 'serialNumber' };
const COST_SORTS = { purchaseCost: 'purchaseCost', invoiceNo: 'invoiceNo' };
function listWhere(base, q, vendor, skip) {
  const and = [base];
  if (skip !== 'category' && str(q.category)) and.push({ category: str(q.category) });
  if (skip !== 'status' && str(q.status)) and.push({ status: str(q.status) });
  const from = VP.YMD.test(str(q.from)) ? str(q.from) : null;
  const to = VP.YMD.test(str(q.to)) ? str(q.to) : null;
  if (from || to) {
    if (str(q.dateField) === 'updated') {
      const r = {};
      if (from) r.gte = new Date(`${from}T00:00:00`);
      if (to) r.lt = new Date(new Date(`${to}T00:00:00`).getTime() + 86400000);
      and.push({ updatedAt: r });
    } else {
      const col = DATE_FIELDS[str(q.dateField)] || 'purchaseDate';
      const r = {};
      if (from) r.gte = from;
      if (to) r.lte = to;
      and.push({ [col]: r });
    }
  }
  if (str(q.q)) {
    const s = VP.cleanText(q.q, 80);
    const or = [{ assetCode: { contains: s } }, { name: { contains: s } }, { serialNumber: { contains: s } }, { category: { contains: s } }, { location: { contains: s } }];
    if (vendor.canViewCost) or.push({ invoiceNo: { contains: s } });
    and.push({ OR: or });
  }
  return { AND: and };
}

// The list: search / filter / sort / pages ALL on the server, inside the
// vendor scope; page size capped at 100; cascading filter counts.
router.get('/assets', vendorOnly, async (req, res) => {
  const base = await VA.vendorAssetWhere(req.vendor);
  const q = req.query || {};
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const page = Math.max(1, Number(q.page) || 1);
  const sortKey = str(q.sort) || 'assetCode';
  if (COST_SORTS[sortKey] && !req.vendor.canViewCost) return res.status(400).json({ error: 'You cannot sort by that.' });
  const col = SORTS[sortKey] || (COST_SORTS[sortKey] || null);
  if (str(q.sort) && !col) return res.status(400).json({ error: 'You cannot sort by that.' });
  const dir = str(q.dir) === 'desc' ? 'desc' : 'asc';
  if (q.minCost !== undefined || q.maxCost !== undefined) {
    if (!req.vendor.canViewCost) return res.status(400).json({ error: 'You cannot filter by purchase value.' });
  }
  const where = listWhere(base, q, req.vendor);
  if (req.vendor.canViewCost && (q.minCost !== undefined || q.maxCost !== undefined)) {
    const r = {};
    if (Number.isFinite(Number(q.minCost))) r.gte = Number(q.minCost);
    if (Number.isFinite(Number(q.maxCost))) r.lte = Number(q.maxCost);
    where.AND.push({ purchaseCost: r });
  }
  const [total, rows, catRows, statRows, all] = await Promise.all([
    prisma.asset.count({ where }),
    prisma.asset.findMany({ where, orderBy: [{ [col || 'assetCode']: dir }, { assetCode: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.asset.groupBy({ by: ['category'], where: listWhere(base, q, req.vendor, 'category'), _count: { _all: true } }),
    prisma.asset.groupBy({ by: ['status'], where: listWhere(base, q, req.vendor, 'status'), _count: { _all: true } }),
    prisma.asset.count({ where: base }),
  ]);
  const facet = (list, k) => list.filter((r) => r[k]).map((r) => ({ value: r[k], count: r._count._all }))
    .sort((a, b) => String(a.value).localeCompare(String(b.value)));
  res.json({
    rows: rows.map((a) => VP.vendorAssetView(a, req.vendor)),
    total, page, pageSize, assignedTotal: all, sort: col ? sortKey : 'assetCode', dir,
    facets: { category: facet(catRows, 'category'), status: facet(statRows, 'status') },
    canEdit: req.vendor.canEdit, canViewCost: req.vendor.canViewCost,
    sortable: [...Object.keys(SORTS), ...(req.vendor.canViewCost ? Object.keys(COST_SORTS) : [])],
  });
});

// One asset: details, documents, service history, this vendor's bills.
router.get('/assets/:id', vendorOnly, async (req, res) => {
  const a = await myAsset(req, req.params.id);
  if (!a) return res.status(403).json(NOT_YOURS);
  const [docs, repairs, bills, remarkRow] = await Promise.all([
    // DOCUMENTS: only ones flagged visible to vendors, or uploaded by THIS vendor.
    prisma.assetDocument.findMany({ where: { assetId: a.id, OR: [{ visibleToVendor: true }, { vendorId: req.vendor.vendorId }] }, orderBy: { createdAt: 'desc' } }),
    prisma.assetRepair.findMany({ where: { assetId: a.id }, orderBy: [{ createdAt: 'desc' }] }),
    prisma.vendorBillSubmission.findMany({ where: { assetId: a.id, vendorId: req.vendor.vendorId }, orderBy: { submittedAt: 'desc' } }),
    prisma.assetAuditLog.findFirst({ where: { assetId: a.id, field: 'serviceRemarks', role: 'Vendor' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const expIds = bills.map((b) => b.expenseId).filter(Boolean);
  const exps = expIds.length ? await prisma.officeExpense.findMany({ where: { id: { in: expIds } }, select: { id: true, approvalStatus: true } }) : [];
  const em = new Map(exps.map((e) => [e.id, e]));
  const mine = VP.normEmail(req.vendor.vendorName);
  // SERVICE HISTORY: only entries this vendor is part of (its name on the
  // entry) or entries with no service centre named. Another centre's work,
  // every cost, invoice, payment and internal note stay out.
  const relevant = repairs.filter((r) => !str(r.vendor) || VP.normEmail(r.vendor) === mine);
  res.json({
    asset: VP.vendorAssetView(a, req.vendor),
    serviceRemarksBy: remarkRow ? { by: remarkRow.actorName, at: remarkRow.createdAt } : null,
    documents: docs.map((d) => ({
      id: d.id, docType: d.docType, name: d.name, mime: d.mime, size: d.size, createdAt: d.createdAt, uploadedByName: d.uploadedByName, byYou: d.vendorId === req.vendor.vendorId,
    })),
    serviceHistory: relevant.map((r) => ({
      id: r.id, repairNo: r.repairNo, dateReported: r.dateReported, repairDate: r.repairDate, repairType: r.repairType,
      issue: r.issue, status: r.status, underWarranty: !!r.underWarranty, byYou: !!str(r.vendor),
    })),
    bills: bills.map((b) => VP.vendorBillView(b, em.get(b.expenseId))),
    canEdit: req.vendor.canEdit, canViewCost: req.vendor.canViewCost,
    editable: req.vendor.canEdit ? Object.keys(VP.VENDOR_EDITABLE) : [],
  });
});

function needEdit(req, res) {
  if (req.vendor.canEdit) return false;
  res.status(403).json({ error: 'Your login is view-only. Ask the company to allow editing.' });
  return true;
}

// Allow Editing = ON: serial number, warranty date, AMC date, service
// remarks — an explicit allow-list; any other key refuses the whole request.
// OPTIMISTIC LOCK: the body carries `updatedAt` as the screen loaded it; a
// different value on the row → 409. Only changed fields are written, one
// audit row each. SERIAL NUMBERS (decision): the Assets module had no serial
// field before P3, so there is no existing rule; here a serial already on
// another asset of the SAME vendor is refused (409) — never checked across
// vendors, so nothing leaks.
router.patch('/assets/:id', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const a = await myAsset(req, req.params.id);
  if (!a) return res.status(403).json(NOT_YOURS);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const expected = body.updatedAt;
  const bad = Object.keys(body).filter((k) => !VP.VENDOR_EDITABLE[k] && k !== 'updatedAt');
  if (bad.length) return res.status(403).json({ error: `You can change only: ${Object.values(VP.VENDOR_EDITABLE).join(', ')}.`, refusedFields: bad });
  if (!expected) return res.status(400).json({ error: 'Open the asset again and try once more.', field: 'updatedAt' });
  if (new Date(expected).getTime() !== new Date(a.updatedAt).getTime()) {
    return res.status(409).json({ error: 'This asset was changed by someone else just now. Refresh and try again.', stale: true, updatedAt: a.updatedAt });
  }
  const want = {};
  for (const k of Object.keys(body)) {
    if (k === 'updatedAt') continue; // eslint-disable-line no-continue
    if (VP.hasHtml(body[k])) return res.status(400).json({ error: 'Plain text only — no < or > characters.', field: k });
    const v = VP.cleanText(body[k], k === 'serviceRemarks' ? 1000 : 120);
    if ((k === 'warrantyUntil' || k === 'amcUntil') && v) {
      if (!VP.isRealDay(v)) return res.status(400).json({ error: 'Pick a proper date.', field: k });
      if (a.purchaseDate && VP.YMD.test(a.purchaseDate) && v < a.purchaseDate) return res.status(400).json({ error: 'That date is before the purchase date.', field: k });
    }
    if (k === 'serialNumber' && String(body[k] ?? '').trim().length > 120) return res.status(400).json({ error: 'Keep the serial number under 120 characters.', field: k });
    if (k === 'serviceRemarks' && String(body[k] ?? '').trim().length > 1000) return res.status(400).json({ error: 'Keep the remarks under 1000 characters.', field: k });
    want[k] = v || null;
  }
  const changes = Object.keys(want).filter((k) => (want[k] ?? null) !== (a[k] ?? null));
  if (!changes.length) return res.json({ asset: VP.vendorAssetView(a, req.vendor), changed: [], message: 'Nothing changed.' });
  if (want.serialNumber && changes.includes('serialNumber')) {
    const clash = await prisma.asset.findFirst({ where: { vendorId: req.vendor.vendorId, serialNumber: want.serialNumber, NOT: { id: a.id } }, select: { assetCode: true } });
    if (clash) return res.status(409).json({ error: `Serial number ${want.serialNumber} is already on ${clash.assetCode}.`, field: 'serialNumber' });
  }
  const by = `${req.vendor.name} (vendor ${req.vendor.vendorName})`;
  let history = a.history;
  changes.forEach((k) => {
    history = VP.pushAssetHistory(history, by, `Edited by vendor ${req.vendor.name}: ${VP.VENDOR_EDITABLE[k].toLowerCase()} ${a[k] || '—'} → ${want[k] || '—'}`);
  });
  const data = Object.fromEntries(changes.map((k) => [k, want[k]]));
  // The lock is enforced on the write too: a concurrent save loses.
  const n = await prisma.asset.updateMany({ where: { id: a.id, updatedAt: a.updatedAt }, data: { ...data, history } });
  if (!n.count) return res.status(409).json({ error: 'This asset was changed by someone else just now. Refresh and try again.', stale: true });
  const updated = await prisma.asset.findUnique({ where: { id: a.id } });
  for (const k of changes) {
    // eslint-disable-next-line no-await-in-loop
    await VP.auditReq(req, {
      assetId: a.id, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: by, role: 'Vendor',
      action: 'Asset edited', field: k, oldValue: a[k] ?? '', newValue: want[k] ?? '',
    });
  }
  return res.json({ asset: VP.vendorAssetView(updated, req.vendor), changed: changes, message: 'Saved.' });
});

// ---- files ------------------------------------------------------------------
async function readUpload(req) {
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('NOT_MULTIPART'), { code: 'NOT_MULTIPART' });
  }
  return attachments.parseMultipart(req, { maxBytes: VC.CFG.uploadMaxBytes });
}
// Type by allow-list, size, magic bytes (attachments.store), random stored
// name, private folder (UPLOAD_DIR), served only through the authenticated
// routes below. The app has no virus-scan step today, so none is called.
function storeFile(file) {
  if (!file || !file.data || !file.data.length) throw Object.assign(new Error('NO_FILE'), { code: 'NO_FILE' });
  if (!FILE_TYPES[file.contentType]) throw Object.assign(new Error('BAD_TYPE'), { code: 'BAD_TYPE' });
  if (!/\.(pdf|jpe?g|png)$/i.test(String(file.filename || ''))) throw Object.assign(new Error('BAD_TYPE'), { code: 'BAD_TYPE' });
  return attachments.store(file, { maxBytes: VC.CFG.uploadMaxBytes });
}
function sendStored(res, file, mime, name) {
  const full = attachments.resolveStored(file);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  res.setHeader('Content-Type', attachments.ALLOWED[mime] ? mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(name)}"`);
  return res.sendFile(full);
}

router.post('/assets/:id/documents', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const a = await myAsset(req, req.params.id);
  if (!a) return res.status(403).json(NOT_YOURS);
  let form;
  try { form = await readUpload(req); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  let st;
  try { st = storeFile(form.file); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  const docType = DOC_TYPES.includes(str(form.fields.docType)) ? str(form.fields.docType) : 'Other';
  const by = `${req.vendor.name} (vendor ${req.vendor.vendorName})`;
  let doc;
  try {
    doc = await prisma.assetDocument.create({
      data: {
        assetId: a.id, docType, name: st.billName, mime: st.billMime, size: st.billSize, file: st.billFile,
        vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, uploadedByName: by, visibleToVendor: true,
      },
    });
  } catch (err) { attachments.remove(st.billFile); throw err; }
  await prisma.asset.update({ where: { id: a.id }, data: { history: VP.pushAssetHistory(a.history, by, `Document added by vendor: ${docType} (${st.billName})`) } });
  await VP.auditReq(req, { assetId: a.id, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: by, role: 'Vendor', action: 'Document uploaded', documentName: st.billName, newValue: docType });
  return res.status(201).json({ id: doc.id, docType, name: doc.name, size: doc.size, createdAt: doc.createdAt, message: 'Document uploaded.' });
});

router.get('/assets/:id/documents/:docId/file', vendorOnly, async (req, res) => {
  const a = await myAsset(req, req.params.id);
  if (!a) return res.status(403).json(NOT_YOURS);
  const d = await prisma.assetDocument.findFirst({ where: { id: String(req.params.docId), assetId: a.id, OR: [{ visibleToVendor: true }, { vendorId: req.vendor.vendorId }] } });
  if (!d) return res.status(403).json({ error: 'Forbidden. This document is not yours.' });
  await VP.auditReq(req, { assetId: a.id, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: req.vendor.name, role: 'Vendor', action: 'Document downloaded', documentName: d.name });
  return sendStored(res, d.file, d.mime, d.name);
});

// ---- bills ------------------------------------------------------------------
// Reads and checks the bill fields of a multipart (new bill / resubmit) or a
// JSON body (edit). Money is parsed on the server; the browser's total is
// ignored. Dates: not in the future, not before the asset's purchase date.
function billFields(f, a, partial) {
  const out = {};
  const has = (k) => f[k] !== undefined;
  if (!partial || has('billNumber')) {
    if (VP.hasHtml(f.billNumber)) return { error: 'Plain text only in the bill number.', field: 'billNumber' };
    out.billNumber = VP.cleanText(f.billNumber, 60);
    if (!out.billNumber) return { error: 'Enter the bill / invoice number.', field: 'billNumber' };
  }
  if (!partial || has('billDate')) {
    out.billDate = str(f.billDate);
    if (!VP.isRealDay(out.billDate)) return { error: 'Pick the bill date.', field: 'billDate' };
    if (out.billDate > today()) return { error: 'The bill date cannot be in the future.', field: 'billDate' };
    if (a.purchaseDate && VP.YMD.test(a.purchaseDate) && out.billDate < a.purchaseDate) return { error: "The bill date is before this asset's purchase date.", field: 'billDate' };
  }
  for (const [k, label] of [['amount', 'Amount before GST'], ['gst', 'GST'], ['tds', 'TDS']]) {
    if (partial && !has(k)) continue; // eslint-disable-line no-continue
    const n = num2(f[k]);
    if (Number.isNaN(n) || n < 0) return { error: `${label} must be a number of 0 or more.`, field: k };
    out[k] = n;
  }
  if (has('remarks') || !partial) {
    if (VP.hasHtml(f.remarks)) return { error: 'Plain text only in the remarks.', field: 'remarks' };
    out.remarks = VP.cleanText(f.remarks, 1000) || null;
  }
  return { data: out };
}
function moneyProblem(amount, gst, tds) {
  if (!(amount > 0)) return { error: 'Enter the bill amount before GST, like 12000.', field: 'amount' };
  if (tds > amount) return { error: 'TDS cannot be more than the amount before GST.', field: 'tds' };
  return null;
}
async function duplicateBill(vendorId, billNumber, exceptId) {
  return prisma.vendorBillSubmission.findFirst({
    where: { vendorId, billNumberKey: VP.billKey(billNumber), status: { notIn: ['REJECTED', 'WITHDRAWN'] }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, billCode: true, billNumber: true },
  });
}
async function similarBill(vendorId, billDate, amount, exceptId) {
  return prisma.vendorBillSubmission.findFirst({
    where: { vendorId, billDate, amount, status: { notIn: ['REJECTED', 'WITHDRAWN'] }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { billCode: true, billNumber: true },
  });
}
const IDEM_RE = /^[A-Za-z0-9_-]{8,80}$/;
const byLine = (req) => `${req.vendor.name} (vendor ${req.vendor.vendorName})`;

// Creates one submission (new, or a resubmission of `parent`). IDEMPOTENT:
// the same Idempotency-Key from the same login returns the bill already made.
async function createBill(req, res, a, parent) {
  const idem = str(req.get('idempotency-key'));
  if (idem && !IDEM_RE.test(idem)) return res.status(400).json({ error: 'This form cannot be sent safely. Close it, open it again and send.' });
  if (idem) {
    const prev = await prisma.vendorBillSubmission.findFirst({ where: { vendorUserId: req.vendor.userId, idempotencyKey: idem } });
    if (prev) { res.set('Idempotent-Replay', 'true'); return res.status(201).json({ bill: VP.vendorBillView(prev), duplicateRequest: true, message: 'Bill already sent.' }); }
  }
  let form;
  try { form = await readUpload(req); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  const f = form.fields || {};
  const chk = billFields(f, a, false);
  if (chk.error) return res.status(400).json({ error: chk.error, field: chk.field });
  const d = chk.data;
  const mp = moneyProblem(d.amount, d.gst, d.tds);
  if (mp) return res.status(400).json(mp);
  if (!form.file) return res.status(400).json({ error: 'Attach the bill (PDF, JPG or PNG).', field: 'file' });
  const dup = await duplicateBill(req.vendor.vendorId, d.billNumber);
  if (dup) return res.status(409).json({ error: `You already sent bill number ${dup.billNumber} (${dup.billCode}). Use the bill number of this new bill.`, field: 'billNumber' });
  const similar = await similarBill(req.vendor.vendorId, d.billDate, d.amount);
  let st;
  try { st = storeFile(form.file); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  const by = byLine(req);
  let bill = null;
  for (let i = 0; i < 5 && !bill; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      bill = await prisma.vendorBillSubmission.create({
        data: {
          billCode: await VP.nextBillCode(), // eslint-disable-line no-await-in-loop
          vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, assetId: a.id, assetCode: a.assetCode, assetName: a.name,
          billNumber: d.billNumber, billNumberKey: VP.billKey(d.billNumber), billDate: d.billDate,
          amount: d.amount, gst: d.gst, tds: d.tds, total: VP.billTotal(d.amount, d.gst, d.tds),
          remarks: d.remarks,
          documentFile: st.billFile, documentName: st.billName, documentMime: st.billMime, documentSize: st.billSize,
          status: 'PENDING_REVIEW', submittedByName: by, source: 'Vendor Portal',
          idempotencyKey: idem || null,
          parentSubmissionId: parent ? parent.id : null, version: parent ? (parent.version || 1) + 1 : 1,
        },
      });
    } catch (err) {
      if (err && err.code === 'P2002' && idem && /idempotencyKey/.test(String(err.meta && err.meta.target))) {
        attachments.remove(st.billFile);
        const prev = await prisma.vendorBillSubmission.findFirst({ where: { vendorUserId: req.vendor.userId, idempotencyKey: idem } }); // eslint-disable-line no-await-in-loop
        res.set('Idempotent-Replay', 'true');
        return res.status(201).json({ bill: VP.vendorBillView(prev), duplicateRequest: true, message: 'Bill already sent.' });
      }
      if (!(err && err.code === 'P2002') || i === 4) { attachments.remove(st.billFile); throw err; }
    }
  }
  await prisma.asset.update({ where: { id: a.id }, data: { history: VP.pushAssetHistory(a.history, by, `Bill ${d.billNumber} sent by vendor (${bill.billCode}${parent ? `, version ${bill.version}` : ''}) — waiting for Accounts`) } });
  await VP.auditReq(req, {
    assetId: a.id, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: by, role: 'Vendor',
    action: parent ? 'Bill resubmitted' : 'Bill uploaded', billId: bill.id, documentName: st.billName, status: 'PENDING_REVIEW',
    oldValue: parent ? parent.billCode : null, newValue: `${bill.billCode} · ${d.billNumber} · ₹${bill.total}`,
  });
  await notifyReviewers(bill, req.vendor, parent);
  return res.status(201).json({
    bill: VP.vendorBillView(bill),
    warning: similar ? `A bill with the same date and amount was already sent (${similar.billCode}, no. ${similar.billNumber}). If this is a different bill, nothing more to do.` : null,
    message: parent ? 'Corrected bill sent. Accounts will check it.' : 'Bill sent. Accounts will check it.',
  });
}

// Accounts reviewers (utils/vendorConfig.js billReviewers: Super Admin +
// Accountant role, resolved now): an in-app notice each, plus an email when
// the "Vendor emails" switch is on. Never throws.
async function notifyReviewers(bill, vendor, parent) {
  try {
    const list = await VC.billReviewers();
    const title = `Vendor bill ${bill.billCode} waiting for your check`;
    const message = `${vendor.vendorName} sent bill ${bill.billNumber} for ${bill.assetCode || 'an asset'} (₹${bill.total})${parent ? ' — a corrected bill' : ''}. Open Office & Accounts → Bills from vendors.`;
    await require('../utils/notify').notifyUsers(list.map((u) => u.id), { title, message });
    for (const u of list) {
      // eslint-disable-next-line no-await-in-loop
      if (u.email) await VC.sendVendorEmail({ to: u.email, subject: `TeamLink: ${title}`, text: `${message}\n\nThis is an automatic message from TeamLink.`, userId: u.id });
    }
  } catch (err) { console.error('[vendor-bill notify]', err && err.message); } // eslint-disable-line no-console
}

router.post('/assets/:id/bills', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const a = await myAsset(req, req.params.id);
  if (!a) return res.status(403).json(NOT_YOURS);
  return createBill(req, res, a, null);
});

async function myBill(req, billId) {
  const b = await prisma.vendorBillSubmission.findFirst({ where: { id: String(billId || ''), vendorId: req.vendor.vendorId } });
  if (!b) return null;
  const a = await myAsset(req, b.assetId);
  return a ? { bill: b, asset: a } : null;
}
const LOCKED = (b) => ({ error: `This bill is ${VP.BILL_STATUS_LABEL[b.status] || b.status} and cannot be changed any more.` });

// Edit while Pending Review (fields only; the file is replaced below).
router.patch('/bills/:billId', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  const b = m.bill;
  if (b.status !== 'PENDING_REVIEW') return res.status(409).json(LOCKED(b));
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const allowed = ['billNumber', 'billDate', 'amount', 'gst', 'tds', 'remarks'];
  const bad = Object.keys(body).filter((k) => !allowed.includes(k));
  if (bad.length) return res.status(400).json({ error: `You can change only: bill number, date, amount, GST, TDS, remarks.`, refusedFields: bad });
  const chk = billFields(body, m.asset, true);
  if (chk.error) return res.status(400).json({ error: chk.error, field: chk.field });
  const d = chk.data;
  const amount = d.amount ?? b.amount; const gst = d.gst ?? b.gst; const tds = d.tds ?? b.tds;
  const mp = moneyProblem(amount, gst, tds);
  if (mp) return res.status(400).json(mp);
  if (d.billNumber && VP.billKey(d.billNumber) !== b.billNumberKey) {
    const dup = await duplicateBill(req.vendor.vendorId, d.billNumber, b.id);
    if (dup) return res.status(409).json({ error: `You already sent bill number ${dup.billNumber} (${dup.billCode}).`, field: 'billNumber' });
    d.billNumberKey = VP.billKey(d.billNumber);
  }
  d.total = VP.billTotal(amount, gst, tds);
  const changed = Object.keys(d).filter((k) => k !== 'billNumberKey' && String(d[k] ?? '') !== String(b[k] ?? ''));
  if (!changed.length) return res.json({ bill: VP.vendorBillView(b), message: 'Nothing changed.' });
  const up = await prisma.vendorBillSubmission.update({ where: { id: b.id }, data: d });
  for (const k of changed.filter((x) => x !== 'total')) {
    // eslint-disable-next-line no-await-in-loop
    await VP.auditReq(req, { assetId: b.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: byLine(req), role: 'Vendor', action: 'Bill edited', billId: b.id, field: k, oldValue: b[k] ?? '', newValue: d[k] ?? '', status: b.status });
  }
  return res.json({ bill: VP.vendorBillView(up), message: 'Saved.' });
});

// Replace the bill file while Pending Review.
router.post('/bills/:billId/document', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  const b = m.bill;
  if (b.status !== 'PENDING_REVIEW') return res.status(409).json(LOCKED(b));
  let form;
  try { form = await readUpload(req); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  let st;
  try { st = storeFile(form.file); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  const old = b.documentFile;
  const up = await prisma.vendorBillSubmission.update({ where: { id: b.id }, data: { documentFile: st.billFile, documentName: st.billName, documentMime: st.billMime, documentSize: st.billSize } });
  if (old) attachments.remove(old);
  await VP.auditReq(req, { assetId: b.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: byLine(req), role: 'Vendor', action: 'Bill document replaced', billId: b.id, documentName: st.billName, oldValue: b.documentName, status: b.status });
  return res.json({ bill: VP.vendorBillView(up), message: 'Bill file replaced.' });
});

// Withdraw while Pending Review — a soft status, never a delete.
router.post('/bills/:billId/withdraw', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  const b = m.bill;
  if (b.status !== 'PENDING_REVIEW') return res.status(409).json(LOCKED(b));
  const n = await prisma.vendorBillSubmission.updateMany({ where: { id: b.id, status: 'PENDING_REVIEW' }, data: { status: 'WITHDRAWN', withdrawnAt: new Date() } });
  if (!n.count) return res.status(409).json(LOCKED(b));
  await VP.auditReq(req, { assetId: b.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: byLine(req), role: 'Vendor', action: 'Bill withdrawn', billId: b.id, status: 'WITHDRAWN', oldValue: 'PENDING_REVIEW', newValue: 'WITHDRAWN' });
  const fresh = await prisma.vendorBillSubmission.findUnique({ where: { id: b.id } });
  return res.json({ bill: VP.vendorBillView(fresh), message: 'Bill withdrawn.' });
});

// Resubmit after a rejection: a NEW submission (version + 1) linked to the
// rejected one, which stays in the history.
router.post('/bills/:billId/resubmit', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  if (m.bill.status !== 'REJECTED') return res.status(409).json({ error: 'Only a rejected bill can be sent again.' });
  const already = await prisma.vendorBillSubmission.findFirst({ where: { parentSubmissionId: m.bill.id, status: { not: 'WITHDRAWN' } }, select: { billCode: true } });
  if (already) return res.status(409).json({ error: `A corrected bill was already sent (${already.billCode}).` });
  return createBill(req, res, m.asset, m.bill);
});

// A supporting document on a bill still waiting for review.
router.post('/bills/:billId/supporting', vendorOnly, async (req, res) => {
  if (needEdit(req, res)) return undefined;
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  const b = m.bill;
  if (b.status !== 'PENDING_REVIEW') return res.status(409).json({ error: 'Accounts has already looked at this bill, so no more files can be added.' });
  const docs = VP.parseDocs(b.supportingDocs);
  if (docs.length >= SUPPORTING_MAX) return res.status(400).json({ error: `A bill can carry at most ${SUPPORTING_MAX} supporting files.` });
  let form;
  try { form = await readUpload(req); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  let st;
  try { st = storeFile(form.file); } catch (err) { return res.status(400).json({ error: fileError(err) }); }
  docs.push({ file: st.billFile, name: st.billName, mime: st.billMime, size: st.billSize, at: new Date().toISOString() });
  const updated = await prisma.vendorBillSubmission.update({ where: { id: b.id }, data: { supportingDocs: JSON.stringify(docs) } });
  await VP.auditReq(req, { assetId: b.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: req.vendor.name, role: 'Vendor', action: 'Bill supporting document uploaded', billId: b.id, documentName: st.billName, status: b.status });
  return res.status(201).json({ bill: VP.vendorBillView(updated), message: 'File added to the bill.' });
});

router.get('/bills/:billId/document', vendorOnly, async (req, res) => {
  const m = await myBill(req, req.params.billId);
  if (!m || !m.bill.documentFile) return res.status(403).json(NOT_YOUR_BILL);
  await VP.auditReq(req, { assetId: m.bill.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: req.vendor.name, role: 'Vendor', action: 'Bill document downloaded', billId: m.bill.id, documentName: m.bill.documentName });
  return sendStored(res, m.bill.documentFile, m.bill.documentMime, m.bill.documentName);
});

router.get('/bills/:billId/supporting/:idx', vendorOnly, async (req, res) => {
  const m = await myBill(req, req.params.billId);
  if (!m) return res.status(403).json(NOT_YOUR_BILL);
  const d = VP.parseDocs(m.bill.supportingDocs)[Number(req.params.idx)];
  if (!d) return res.status(404).json({ error: 'No such file on this bill.' });
  await VP.auditReq(req, { assetId: m.bill.assetId, vendorId: req.vendor.vendorId, vendorUserId: req.vendor.userId, actorName: req.vendor.name, role: 'Vendor', action: 'Bill document downloaded', billId: m.bill.id, documentName: d.name });
  return sendStored(res, d.file, d.mime, d.name);
});

// Anything else under /api/vendor-portal is not part of the portal.
router.use((req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
