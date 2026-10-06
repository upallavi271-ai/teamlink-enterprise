// ---------------------------------------------------------------------------
// ADMINISTRATION → COMPANY SETUP → VENDOR LOGINS (P3 2026-10-05, v2 2026-10-06).
// /api/vendor-logins — staff only (requireAuth; a vendor token never gets
// here: the global guard answers 403 first, and requireAuth cannot verify it).
//
// WHO (v2 §3 / §19): administration · Vendor Logins (edit) — Super Admin and
// Admin by default — or a login that ALREADY manages users (administration ·
// Users · edit). The audit viewer needs administration · Vendor Audit (view).
// An Accountant gets in only if Role Catalog gave them one of those.
//
// Passwords: typed by the admin (vendor policy) or generated (crypto). A
// generated one is returned ONCE so the admin can hand it over (optionally
// emailed when the "Vendor emails" switch is on); never stored or logged in
// clear. Every new / reset password: must change at next sign-in, and
// expires unused after VENDOR_TEMP_PASSWORD_DAYS (7). Reset is only here.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const VA = require('../utils/vendorAuth');
const VP = require('../utils/vendorPortal');
const VC = require('../utils/vendorConfig');

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
async function mayAudit(user) {
  if (!user) return false;
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return true;
  return !!(await can(user, null, 'administration', 'Vendor Audit', 'view').catch(() => false)) || mayManage(user);
}
router.use(async (req, res, next) => {
  if (req.path.startsWith('/audit') ? await mayAudit(req.user) : await mayManage(req.user)) return next();
  return res.status(403).json({ error: 'Only Admin (or a login that manages users) can manage vendor logins.' });
});

const { str } = VP;
const actorOf = (req) => req.user.name || req.user.email || 'Admin';
const roleOf = (req) => (['SUPER_ADMIN', 'ADMIN'].includes(req.user.role) ? 'Admin' : 'Accounts');
// Staff events on vendor logins, with IP + user agent (v2 §13).
const adminEvent = (req, row) => VP.auditReq(req, { changedById: req.user.id, actorName: actorOf(req), role: roleOf(req), ...row });
const tempExpiry = () => new Date(Date.now() + VC.CFG.tempPasswordDays * 86400000);

// Cryptographically random: 14 characters, always a capital, a small letter,
// a number and a symbol (meets the vendor policy).
function generatePassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; const L = 'abcdefghijkmnpqrstuvwxyz'; const D = '23456789'; const S = '!#$%&*+=?@';
  const all = U + L + D + S;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(U), pick(L), pick(D), pick(S), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

async function assignedCount(vu) {
  return prisma.asset.count({ where: await VA.vendorAssetWhere({ userId: vu.id, vendorId: vu.vendorId }) });
}
const lockedNow = (vu) => !!(vu.lockedUntil && new Date(vu.lockedUntil) > new Date());
const tempExpired = (vu) => !!(vu.mustChangePassword && vu.tempPasswordExpiresAt && new Date(vu.tempPasswordExpiresAt) < new Date());

async function rowOf(vu) {
  const locked = lockedNow(vu);
  const vendorOff = vu.vendor && vu.vendor.isActive === false;
  return {
    id: vu.id,
    vendorId: vu.vendorId,
    vendorName: vu.vendor ? vu.vendor.name : '',
    vendorActive: !vendorOff,
    name: vu.name,
    email: vu.email,
    status: vu.status,
    statusText: vu.status !== 'Active' ? 'Switched off' : (vendorOff ? 'Vendor switched off' : (locked ? 'Locked' : 'Active')),
    locked,
    lockedUntil: locked ? vu.lockedUntil : null,
    lastLoginAt: vu.lastLoginAt,
    lastLoginIp: vu.lastLoginIp || null,
    mustChangePassword: vu.mustChangePassword,
    tempPasswordExpiresAt: vu.mustChangePassword ? vu.tempPasswordExpiresAt : null,
    tempPasswordExpired: tempExpired(vu),
    canEdit: vu.canEdit,
    canViewCost: vu.canViewCost,
    assetIds: (vu.access || []).map((a) => a.assetId).filter(Boolean),
    categories: (vu.access || []).map((a) => a.category).filter(Boolean),
    assignedAssets: await assignedCount(vu),
    createdAt: vu.createdAt,
  };
}

// The list, with search + filters (vendor, status, locked) and cascading
// counts computed here.
router.get('/', async (req, res) => {
  const q = req.query || {};
  const all = await prisma.vendorUser.findMany({ where: { deletedAt: null }, include: { vendor: true, access: true }, orderBy: [{ createdAt: 'desc' }] });
  const rows = await Promise.all(all.map(rowOf));
  const s = str(q.q).toLowerCase();
  const pass = (r, skip) => (skip === 'vendor' || !str(q.vendorId) || r.vendorId === str(q.vendorId))
    && (skip === 'status' || !str(q.status) || (str(q.status) === 'Active' ? r.status === 'Active' : r.status !== 'Active'))
    && (skip === 'locked' || !str(q.locked) || (str(q.locked) === 'yes') === r.locked)
    && (!s || [r.vendorName, r.name, r.email].some((v) => String(v || '').toLowerCase().includes(s)));
  const count = (list, key, label) => {
    const m = new Map();
    list.forEach((r) => { const k = key(r); if (k == null || k === '') return; const o = m.get(k) || { value: k, label: label(r), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  };
  res.json({
    rows: rows.filter((r) => pass(r)),
    total: rows.length,
    facets: {
      vendor: count(rows.filter((r) => pass(r, 'vendor')), (r) => r.vendorId, (r) => r.vendorName),
      status: count(rows.filter((r) => pass(r, 'status')), (r) => (r.status === 'Active' ? 'Active' : 'Inactive'), (r) => (r.status === 'Active' ? 'Active' : 'Switched off')),
      locked: count(rows.filter((r) => pass(r, 'locked')), (r) => (r.locked ? 'yes' : 'no'), (r) => (r.locked ? 'Locked' : 'Not locked')),
    },
    portalEnabled: VC.portalEnabled(),
  });
});

// The modal's choices: ACTIVE vendors only, asset categories, and the assets
// (with the vendor each is linked to, and its old free-text vendor).
router.get('/options', async (req, res) => {
  const [vendors, assets] = await Promise.all([
    prisma.officeVendor.findMany({ where: { isActive: true }, select: { id: true, name: true, contactPerson: true, email: true }, orderBy: { name: 'asc' } }),
    prisma.asset.findMany({
      where: { NOT: { status: { in: VA.ARCHIVED } } },
      select: { id: true, assetCode: true, name: true, category: true, status: true, vendor: true, vendorId: true },
      orderBy: { assetCode: 'asc' },
    }),
  ]);
  const vName = new Map(vendors.map((v) => [v.id, v.name]));
  const cats = new Map();
  assets.forEach((a) => { if (a.category) cats.set(a.category, (cats.get(a.category) || 0) + 1); });
  res.json({
    vendors,
    categories: [...cats.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
    assets: assets.map((a) => ({ ...a, vendorText: a.vendor || null, vendor: undefined, linkedVendorName: a.vendorId ? vName.get(a.vendorId) || null : null })),
  });
});

// ---- settings (the "Vendor emails" switch, the feature flag) ---------------
router.get('/settings', async (req, res) => {
  res.json({
    ...(await VC.loadSettings()),
    portalEnabled: VC.portalEnabled(),
    policy: { idleMinutes: VC.CFG.idleMinutes, maxHours: VC.CFG.maxHours, lockMinutes: VC.CFG.lockMinutes, maxFailed: VC.CFG.maxFailed, tempPasswordDays: VC.CFG.tempPasswordDays, uploadMaxMb: Math.round(VC.CFG.uploadMaxBytes / 1048576), passwordMin: VC.PW_MIN },
    canEdit: ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role),
  });
});
router.put('/settings', async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Only Super Admin or Admin can change this.' });
  const before = await VC.loadSettings();
  const s = await VC.saveSettings(req.body || {}, req.user);
  if (before.emailsEnabled !== s.emailsEnabled) {
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: `Vendor emails switched ${s.emailsEnabled ? 'on' : 'off'}`, entity: 'AppSetting', entityId: 'vendorPortal.settings', fromValue: before.emailsEnabled ? 'On' : 'Off', toValue: s.emailsEnabled ? 'On' : 'Off' });
  }
  res.json({ ...s, portalEnabled: VC.portalEnabled(), canEdit: true, message: s.emailsEnabled ? 'Vendor emails are ON.' : 'Vendor emails are OFF. The app sends no email to vendors or reviewers.' });
});

// Checks the asset / category choice for vendor `vendorId`. An asset linked to
// ANOTHER vendor is refused; one not linked yet is linked to this vendor only
// when the admin ticked it knowingly (linkUnlinked: true, the modal says so).
async function checkAccess(body, vendorId) {
  const assetIds = [...new Set((Array.isArray(body.assetIds) ? body.assetIds : []).map(String))].slice(0, 2000);
  const categories = [...new Set((Array.isArray(body.categories) ? body.categories : []).map((c) => str(c)).filter(Boolean))].slice(0, 100);
  const assets = assetIds.length ? await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, assetCode: true, vendorId: true } }) : [];
  if (assets.length !== assetIds.length) return { error: 'One of the picked assets no longer exists. Open the list again.' };
  const other = assets.filter((a) => a.vendorId && a.vendorId !== vendorId);
  if (other.length) return { error: `These assets belong to another vendor: ${other.map((a) => a.assetCode).join(', ')}. Untick them.` };
  const toLink = assets.filter((a) => !a.vendorId);
  if (toLink.length && !body.linkUnlinked) {
    return { error: `These assets are not linked to any vendor yet: ${toLink.map((a) => a.assetCode).join(', ')}. Tick "Link them to this vendor" or untick them.`, needLink: toLink.map((a) => a.id) };
  }
  return { assetIds, categories, toLink };
}

async function linkAssets(req, list, vendor) {
  for (const a of list) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await prisma.asset.findUnique({ where: { id: a.id } });
    if (!cur || cur.vendorId) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.asset.update({
      where: { id: a.id },
      data: { vendorId: vendor.id, history: VP.pushAssetHistory(cur.history, actorOf(req), `Linked to vendor ${vendor.name} (vendor master)`) },
    });
    // eslint-disable-next-line no-await-in-loop
    await adminEvent(req, { assetId: a.id, vendorId: vendor.id, action: 'Linked to vendor', field: 'vendorId', oldValue: '', newValue: vendor.name });
  }
}

async function writeAccess(vendorUserId, assetIds, categories) {
  await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId } });
  const rows = [
    ...assetIds.map((assetId) => ({ vendorUserId, assetId })),
    ...categories.map((category) => ({ vendorUserId, category })),
  ];
  for (const r of rows) await prisma.vendorAssetAccess.create({ data: r }); // eslint-disable-line no-await-in-loop
}
const accessText = (assetIds, categories) => `${assetIds.length} asset(s) picked, ${categories.length} categor(ies)${categories.length ? ` (${categories.join(', ')})` : ''}`;

async function emailProblem(email, exceptId) {
  if (!VP.EMAIL_RE.test(email) || email.length > 160) return 'Enter a proper email address.';
  const [vu, staff] = await Promise.all([
    prisma.vendorUser.findUnique({ where: { email } }),
    prisma.user.findFirst({ where: { email } }),
  ]);
  if (vu && vu.id !== exceptId) return 'Another vendor login already uses this email.';
  if (staff) return 'This email is a staff login. A vendor needs its own email.';
  return null;
}

// Hands the temporary password to the vendor by email (only when the switch
// is on and the admin asked). Never logs the password.
async function mailTempPassword(vu, vendorName, password, wanted) {
  if (!wanted) return { sent: false, reason: 'not asked' };
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return VC.sendVendorEmail({
    to: vu.email,
    subject: 'Your TeamLink Vendor Portal login',
    text: `Hello ${vu.name},\n\nA Vendor Portal login was made for ${vendorName}.\n\nSign in: ${base}/vendor-login\nEmail: ${vu.email}\nTemporary password: ${password}\n\nIt works for ${VC.CFG.tempPasswordDays} days. You will be asked to set your own password the first time you sign in.\n\nTeamLink`,
  });
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (!vendor) return res.status(400).json({ error: 'Pick the vendor from the Vendor list.', field: 'vendorId' });
  if (vendor.isActive === false) return res.status(400).json({ error: `${vendor.name} is switched off in the vendor list. Switch the vendor on first.`, field: 'vendorId' });
  const name = VP.cleanText(b.name, 120).replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Enter the contact name.', field: 'name' });
  const email = VP.normEmail(b.email);
  const ep = await emailProblem(email);
  if (ep) return res.status(400).json({ error: ep, field: 'email' });
  const auto = !!b.autoPassword;
  const password = auto ? generatePassword() : String(b.password || '');
  if (!auto) {
    const weak = VC.vendorPasswordProblem(password, { email, name });
    if (weak) return res.status(400).json({ error: weak, field: 'password' });
  }
  const status = b.status === 'Inactive' ? 'Inactive' : 'Active';
  const acc = await checkAccess(b, vendor.id);
  if (acc.error) return res.status(400).json({ error: acc.error, field: 'assets', needLink: acc.needLink });
  const vu = await prisma.vendorUser.create({
    data: {
      vendorId: vendor.id, name, email, passwordHash: await bcrypt.hash(password, 10), status,
      canEdit: b.canEdit === true, canViewCost: b.canViewCost === true, mustChangePassword: true, tempPasswordExpiresAt: tempExpiry(), createdById: req.user.id,
    },
  });
  await linkAssets(req, acc.toLink, vendor);
  await writeAccess(vu.id, acc.assetIds, acc.categories);
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: 'Vendor login created', entity: 'VendorUser', entityId: vu.id,
    fromValue: '— (new)',
    toValue: `${vendor.name} · ${name} · ${email} · ${status} · edit ${vu.canEdit ? 'ON' : 'OFF'} · purchase value ${vu.canViewCost ? 'ON' : 'OFF'} · ${accessText(acc.assetIds, acc.categories)}`,
  });
  await adminEvent(req, { vendorId: vendor.id, vendorUserId: vu.id, action: 'Vendor login created', newValue: `${email} · edit ${vu.canEdit ? 'ON' : 'OFF'} · purchase value ${vu.canViewCost ? 'ON' : 'OFF'} · ${accessText(acc.assetIds, acc.categories)}` });
  const mail = auto ? await mailTempPassword(vu, vendor.name, password, b.emailPassword === true) : { sent: false };
  const full = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true, access: true } });
  return res.status(201).json({
    login: await rowOf(full),
    ...(auto ? { tempPassword: password } : {}),
    emailed: !!mail.sent,
    message: `Vendor login created. They must set a new password the first time they sign in${auto ? `; the temporary password works for ${VC.CFG.tempPasswordDays} days` : ''}.${b.emailPassword && !mail.sent ? ` Not emailed (${mail.reason}).` : ''}`,
  });
});

router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  if (b.vendorId !== undefined && String(b.vendorId) !== vu.vendorId) {
    return res.status(400).json({ error: 'A login stays with its vendor. Create a new login for another vendor.' });
  }
  const data = {};
  const changes = [];
  if (b.name !== undefined) {
    const name = VP.cleanText(b.name, 120).replace(/\s+/g, ' ');
    if (!name) return res.status(400).json({ error: 'Enter the contact name.', field: 'name' });
    if (name !== vu.name) { data.name = name; changes.push(['name', vu.name, name]); }
  }
  if (b.email !== undefined) {
    const email = VP.normEmail(b.email);
    if (email !== vu.email) {
      const ep = await emailProblem(email, vu.id);
      if (ep) return res.status(400).json({ error: ep, field: 'email' });
      data.email = email; changes.push(['email', vu.email, email]);
    }
  }
  if (b.status !== undefined) {
    const s = b.status === 'Inactive' ? 'Inactive' : 'Active';
    if (s !== vu.status) { data.status = s; changes.push(['status', vu.status, s]); }
  }
  for (const [k, label] of [['canEdit', 'Allow editing'], ['canViewCost', 'Show purchase value']]) {
    if (b[k] !== undefined && (b[k] === true) !== vu[k]) { data[k] = b[k] === true; changes.push([label, vu[k] ? 'ON' : 'OFF', b[k] === true ? 'ON' : 'OFF']); }
  }
  let acc = null;
  if (b.assetIds !== undefined || b.categories !== undefined) {
    const current = await prisma.vendorAssetAccess.findMany({ where: { vendorUserId: vu.id } });
    acc = await checkAccess({
      assetIds: b.assetIds !== undefined ? b.assetIds : current.map((c) => c.assetId).filter(Boolean),
      categories: b.categories !== undefined ? b.categories : current.map((c) => c.category).filter(Boolean),
      linkUnlinked: b.linkUnlinked,
    }, vu.vendorId);
    if (acc.error) return res.status(400).json({ error: acc.error, field: 'assets', needLink: acc.needLink });
    const before = accessText(current.map((c) => c.assetId).filter(Boolean), current.map((c) => c.category).filter(Boolean));
    const after = accessText(acc.assetIds, acc.categories);
    if (before !== after) changes.push(['Asset access', before, after]);
  }
  if (Object.keys(data).length) await prisma.vendorUser.update({ where: { id: vu.id }, data });
  if (acc) { await linkAssets(req, acc.toLink, vu.vendor); await writeAccess(vu.id, acc.assetIds, acc.categories); }
  if (data.status === 'Inactive' || data.email) await VA.revokeSessions(vu.id, data.status === 'Inactive' ? 'deactivated' : 'email changed');
  for (const [field, from, to] of changes) {
    // eslint-disable-next-line no-await-in-loop
    await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: ['Allow editing', 'Show purchase value', 'Asset access'].includes(field) ? 'Permission changed' : 'Vendor login edited', field, oldValue: from, newValue: to });
  }
  if (changes.length) {
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor login edited', entity: 'VendorUser', entityId: vu.id, toValue: changes.map(([f, a, c]) => `${f} ${a} → ${c}`).join(' · ').slice(0, 900) });
  }
  const full = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true, access: true } });
  return res.json({ login: await rowOf(full), message: changes.length ? 'Saved.' : 'Nothing changed.' });
});

async function setStatus(req, res, status) {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true, access: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { status } });
  if (status === 'Inactive') await VA.revokeSessions(vu.id, 'deactivated');
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: status === 'Inactive' ? 'Vendor login switched off' : 'Vendor login switched on', field: 'status', oldValue: vu.status, newValue: status });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: status === 'Inactive' ? 'Vendor login switched off' : 'Vendor login switched on', entity: 'VendorUser', entityId: vu.id, fromValue: vu.status, toValue: status });
  const full = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true, access: true } });
  return res.json({ login: await rowOf(full), message: status === 'Inactive' ? 'Switched off. They are signed out and cannot sign in.' : 'Switched on.' });
}
router.post('/:id/deactivate', (req, res) => setStatus(req, res, 'Inactive'));
router.post('/:id/activate', (req, res) => setStatus(req, res, 'Active'));

// Unlock before the auto-unlock time runs out.
router.post('/:id/unlock', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true, access: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  if (!lockedNow(vu)) return res.json({ login: await rowOf(vu), message: 'This login is not locked.' });
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { lockedUntil: null, failedLoginAttempts: 0 } });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Vendor login unlocked' });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor login unlocked', entity: 'VendorUser', entityId: vu.id });
  const full = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true, access: true } });
  return res.json({ login: await rowOf(full), message: 'Unlocked. They can sign in again.' });
});

// Reset password — the ONLY way a vendor gets back in after forgetting it.
router.post('/:id/reset-password', async (req, res) => {
  const b = req.body || {};
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  const auto = b.autoPassword !== false && !b.password;
  const password = auto ? generatePassword() : String(b.password || '');
  if (!auto) {
    const weak = VC.vendorPasswordProblem(password, { email: vu.email, name: vu.name });
    if (weak) return res.status(400).json({ error: weak, field: 'password' });
  }
  await prisma.vendorUser.update({
    where: { id: vu.id },
    data: { passwordHash: await bcrypt.hash(password, 10), passwordHistory: VC.pushHistory(vu.passwordHistory, vu.passwordHash), mustChangePassword: true, tempPasswordExpiresAt: tempExpiry(), failedLoginAttempts: 0, lockedUntil: null },
  });
  await VA.revokeSessions(vu.id, 'password reset');
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Vendor password reset by Admin', status: 'change required at next sign-in' });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor password reset', entity: 'VendorUser', entityId: vu.id, toValue: 'Reset (change required at next sign-in)' });
  const mail = auto ? await mailTempPassword(vu, vu.vendor ? vu.vendor.name : '', password, b.emailPassword === true) : { sent: false };
  return res.json({ ...(auto ? { tempPassword: password } : {}), emailed: !!mail.sent, message: `Password reset. They must set a new one when they sign in (within ${VC.CFG.tempPasswordDays} days).${b.emailPassword && !mail.sent ? ` Not emailed (${mail.reason}).` : ''}` });
});

// Soft delete: the row stays (history), the login is gone for good.
router.delete('/:id', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { deletedAt: new Date(), status: 'Inactive' } });
  await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: vu.id } });
  await VA.revokeSessions(vu.id, 'deleted');
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Vendor login removed' });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor login removed', entity: 'VendorUser', entityId: vu.id, fromValue: vu.email });
  return res.json({ ok: true, message: 'Removed. The login cannot sign in; its history is kept.' });
});

// The VENDOR MASTER switch: off = every login of that vendor is signed out
// and refused (spec v2 §15).
router.post('/vendor-master/:vendorId/switch', async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: String(req.params.vendorId) } });
  if (!v) return res.status(404).json({ error: 'Vendor not found.' });
  const on = (req.body || {}).isActive !== false;
  if ((v.isActive !== false) === on) return res.json({ ok: true, isActive: on, message: 'Nothing changed.' });
  await prisma.officeVendor.update({ where: { id: v.id }, data: { isActive: on } });
  if (!on) await VA.revokeVendorSessions(v.id, 'vendor switched off');
  await adminEvent(req, { vendorId: v.id, action: on ? 'Vendor switched on' : 'Vendor switched off', field: 'isActive', oldValue: String(v.isActive !== false), newValue: String(on) });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: on ? 'Vendor switched on' : 'Vendor switched off', entity: 'OfficeVendor', entityId: v.id, toValue: v.name });
  return res.json({ ok: true, isActive: on, message: on ? `${v.name} is on again.` : `${v.name} is switched off. All its vendor logins are signed out.` });
});

// ---- Asset ↔ vendor master link ---------------------------------------------
// DRY RUN: which assets' free-text vendor names match a vendor master name.
// Reports only — nothing is written. "exact" = the same name ignoring case,
// spaces and punctuation; "maybe" = one name contains the other.
const keyOf = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');
async function suggestions() {
  const [vendors, assets] = await Promise.all([
    prisma.officeVendor.findMany({ select: { id: true, name: true } }),
    prisma.asset.findMany({ where: { vendorId: null, vendor: { not: null } }, select: { id: true, assetCode: true, name: true, category: true, vendor: true } }),
  ]);
  const vk = vendors.map((v) => ({ ...v, key: keyOf(v.name) })).filter((v) => v.key.length >= 3);
  const out = [];
  assets.forEach((a) => {
    const k = keyOf(a.vendor);
    if (!k) return;
    const exact = vk.filter((v) => v.key === k);
    const maybe = exact.length ? [] : vk.filter((v) => (k.length >= 4 && v.key.includes(k)) || (v.key.length >= 4 && k.includes(v.key)));
    const pick = exact.length === 1 ? exact[0] : null;
    out.push({
      assetId: a.id, assetCode: a.assetCode, assetName: a.name, category: a.category, vendorText: a.vendor,
      match: pick ? 'exact' : (exact.length > 1 || maybe.length ? 'maybe' : 'none'),
      suggested: pick ? { id: pick.id, name: pick.name } : null,
      candidates: (exact.length > 1 ? exact : maybe).slice(0, 5).map((v) => ({ id: v.id, name: v.name })),
    });
  });
  const order = { exact: 0, maybe: 1, none: 2 };
  out.sort((x, y) => order[x.match] - order[y.match] || String(x.assetCode).localeCompare(String(y.assetCode)));
  return out;
}
router.get('/link-suggestions', async (req, res) => {
  const list = await suggestions();
  const [linked, withoutText] = await Promise.all([
    prisma.asset.count({ where: { vendorId: { not: null } } }),
    prisma.asset.count({ where: { vendorId: null, vendor: null } }),
  ]);
  res.json({
    dryRun: true,
    summary: {
      exact: list.filter((r) => r.match === 'exact').length,
      maybe: list.filter((r) => r.match === 'maybe').length,
      none: list.filter((r) => r.match === 'none').length,
      alreadyLinked: linked,
      noVendorText: withoutText,
    },
    rows: list,
  });
});

// Link (or unlink) ONE asset to a vendor master row — an admin's explicit click.
router.post('/link-asset', async (req, res) => {
  const b = req.body || {};
  const asset = await prisma.asset.findUnique({ where: { id: String(b.assetId || '') } });
  if (!asset) return res.status(404).json({ error: 'Asset not found.' });
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (b.vendorId && !vendor) return res.status(400).json({ error: 'Pick a vendor from the Vendor list.' });
  if ((asset.vendorId || null) === (vendor ? vendor.id : null)) return res.json({ ok: true, message: 'Nothing changed.' });
  const old = asset.vendorId ? await prisma.officeVendor.findUnique({ where: { id: asset.vendorId } }) : null;
  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      vendorId: vendor ? vendor.id : null,
      history: VP.pushAssetHistory(asset.history, actorOf(req), vendor ? `Linked to vendor ${vendor.name} (vendor master)` : `Unlinked from vendor ${old ? old.name : ''}`),
    },
  });
  // Unlinked from a vendor: that vendor's logins lose the asset at once.
  if (old && (!vendor || vendor.id !== old.id)) {
    const logins = await prisma.vendorUser.findMany({ where: { vendorId: old.id }, select: { id: true } });
    await prisma.vendorAssetAccess.deleteMany({ where: { assetId: asset.id, vendorUserId: { in: logins.map((l) => l.id) } } });
  }
  await adminEvent(req, { assetId: asset.id, vendorId: vendor ? vendor.id : (old && old.id), action: vendor ? 'Linked to vendor' : 'Unlinked from vendor', field: 'vendorId', oldValue: old ? old.name : '', newValue: vendor ? vendor.name : '' });
  return res.json({ ok: true, message: vendor ? `Linked to ${vendor.name}.` : 'Unlinked.' });
});

// ---- the audit trail (spec 13) — read only, filters, CSV ----------------------
async function auditRows(q) {
  const where = {};
  if (str(q.vendorUserId)) where.vendorUserId = str(q.vendorUserId);
  if (str(q.vendorId)) where.vendorId = str(q.vendorId);
  if (str(q.assetId)) where.assetId = str(q.assetId);
  if (str(q.action)) where.action = str(q.action);
  if (str(q.kind) === 'bills') where.billId = { not: null };
  if (str(q.kind) === 'edits') where.action = 'Asset edited';
  if (str(q.kind) === 'logins') where.action = { in: ['Login success', 'Login failed', 'Login locked', 'Logout', 'Password changed', 'Password change failed', 'Vendor password reset by Admin', 'Vendor login unlocked'] };
  const from = VP.YMD.test(str(q.from)) ? new Date(`${str(q.from)}T00:00:00`) : null;
  const to = VP.YMD.test(str(q.to)) ? new Date(new Date(`${str(q.to)}T00:00:00`).getTime() + 86400000) : null;
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  const take = Math.min(5000, Math.max(50, Number(q.limit) || 300));
  const rows = await prisma.assetAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take });
  const assetIds = [...new Set(rows.map((r) => r.assetId).filter(Boolean))];
  const userIds = [...new Set(rows.map((r) => r.vendorUserId).filter(Boolean))];
  const billIds = [...new Set(rows.map((r) => r.billId).filter(Boolean))];
  const [assets, vus, vendors, bills] = await Promise.all([
    prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, assetCode: true, name: true } }),
    prisma.vendorUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    prisma.officeVendor.findMany({ select: { id: true, name: true } }),
    billIds.length ? prisma.vendorBillSubmission.findMany({ where: { id: { in: billIds } }, select: { id: true, billCode: true } }) : [],
  ]);
  const am = new Map(assets.map((a) => [a.id, a]));
  const um = new Map(vus.map((u) => [u.id, u]));
  const vm = new Map(vendors.map((v) => [v.id, v.name]));
  const bm = new Map(bills.map((b) => [b.id, b.billCode]));
  const actions = await prisma.assetAuditLog.groupBy({ by: ['action'], _count: { _all: true } });
  return {
    rows: rows.map((r) => ({
      ...r,
      assetCode: am.get(r.assetId) ? am.get(r.assetId).assetCode : null,
      assetName: am.get(r.assetId) ? am.get(r.assetId).name : null,
      vendorUserName: um.get(r.vendorUserId) ? um.get(r.vendorUserId).name : null,
      vendorName: vm.get(r.vendorId) || null,
      billCode: r.billId ? bm.get(r.billId) || null : null,
    })),
    actions: actions.map((a) => ({ value: a.action, count: a._count._all })).sort((a, b) => a.value.localeCompare(b.value)),
  };
}
router.get('/audit', async (req, res) => {
  const out = await auditRows(req.query || {});
  // The old shape (an array) is kept for callers that expect it.
  if (req.query && req.query.shape === 'list') return res.json(out.rows);
  return res.json(out);
});
router.get('/audit.csv', async (req, res) => {
  const { rows } = await auditRows({ ...(req.query || {}), limit: 5000 });
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['When', 'Who', 'Role', 'Vendor', 'Vendor login', 'Action', 'Asset', 'Asset name', 'Field', 'Old', 'New', 'Bill', 'Document', 'Status', 'IP', 'Browser'];
  const lines = rows.map((r) => [new Date(r.createdAt).toISOString(), r.actorName || r.vendorUserName || '', r.role, r.vendorName || '', r.vendorUserName || '', r.action, r.assetCode || '', r.assetName || '', r.field || '', r.oldValue || '', r.newValue || '', r.billCode || '', r.documentName || '', r.status || '', r.ip || '', r.userAgent || ''].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vendor-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${[head.join(','), ...lines].join('\r\n')}`);
});

module.exports = router;
