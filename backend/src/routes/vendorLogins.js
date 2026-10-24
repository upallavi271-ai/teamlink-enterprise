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
// LOGIN EMAILS (2026-10-19, utils/vendorMail.js): pressing Create login saves the login and then EMAILS the vendor a welcome
// email with a secure, single-use, expiring link to set their OWN password (login ID, Vendor Portal address, expiry and support
// contact inside). No password is ever made, shown, emailed or stored in clear. Every email attempt is recorded (accepted by the
// mail server vs delivered, kept apart); a failed one keeps the login and can be retried safely (one email per attempt).
// Resend invitation = only for a login that has not activated; Send password reset = only for an active one; changing the email
// of a waiting login re-sends the invitation to the new address, of an active login asks the vendor to confirm the new address.
// The link is shown to Admin ONLY as a one-time backup when email itself is not set up (never logged, never stored).
//
// Passwords: the older Admin-typed temporary password (reset-password with a password) still works for an Admin who hands it over
// in person; it is never emailed. Every new / reset password: must change at next sign-in, and
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
const INV = require('../utils/vendorInvite');
const VM = require('../utils/vendorModules');
const DB = require('../utils/vmDb');
const MODCFG = require('../config/vendorModules');
const { createLoginAtomic } = require('../utils/vendorLoginCreate');
const MAIL = require('../utils/vendorMail');
const DBX = require('../utils/vmDb');

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
// "Assets this vendor can see" (HRMS assets chosen for one vendor) - routes/vendorAssetGrants.js, same guard as above.
router.use('/asset-grants', require('./vendorAssetGrants'));

// The mail tables are self-provisioned (utils/vendorMailSchema.js): make sure they exist before any handler below runs.
router.use(async (req, res, next) => { try { await MAIL.ensure(); next(); } catch (e) { next(e); } });

const { str } = VP;
// One Create at a time (see the POST handler): a promise chain, so a failed one never blocks the next.
let createChain = Promise.resolve();
function serial(fn) {
  const run = createChain.then(fn, fn);
  createChain = run.then(() => undefined, () => undefined);
  return run;
}
// An Idempotency-Key header (8-80 letters / digits / - _) makes a retried request the SAME attempt: '' = none sent, null = not acceptable.
const idemKeyOf = (req) => {
  const raw = String(req.get('idempotency-key') || '').trim();
  if (!raw) return '';
  return /^[A-Za-z0-9_-]{8,80}$/.test(raw) ? raw : null;
};
const BAD_IDEM = { error: 'This form cannot be sent safely. Close it, open it again and save.' };
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
  // An ASSET vendor sees the HRMS assets that are linked to it, bought from / repaired by it, or chosen by Admin (utils/assetHrmsScope.js);
  // every other vendor keeps the older rule.
  if ((await require('../utils/vendorKind').kindOfRow({ ...vu, vendorId: vu.vendorId })) === 'assets') return require('../utils/assetHrmsScope').countFor({ vendorId: vu.vendorId }); // eslint-disable-line global-require
  return prisma.asset.count({ where: await VA.vendorAssetWhere({ userId: vu.id, vendorId: vu.vendorId }) });
}
const lockedNow = (vu) => !!(vu.lockedUntil && new Date(vu.lockedUntil) > new Date());
const tempExpired = (vu) => !!(vu.mustChangePassword && vu.tempPasswordExpiresAt && new Date(vu.tempPasswordExpiresAt) < new Date());

// The modules a login sees (and their ticks), for the admin screen. A login saved before modules existed shows what it
// sees today (Assets + Invoices) with modulesConfigured:false.
function modulesOfRows(vu, rows) {
  const have = (rows || []).filter((r) => MODCFG.MODULES[r.moduleKey]);
  if (!have.length) {
    return { configured: false, keys: [...MODCFG.LEGACY_MODULES], perms: { assets: { canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost }, invoices: { ...MODCFG.defaultPermissions('invoices'), raise: false } } };
  }
  const perms = {};
  have.forEach((r) => {
    perms[r.moduleKey] = r.moduleKey === 'assets'
      ? { ...VM.parseJson(r.permissionsJson), canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost }
      : { ...MODCFG.defaultPermissions(r.moduleKey), ...VM.parseJson(r.permissionsJson) };
  });
  return { configured: true, keys: have.map((r) => r.moduleKey), perms };
}
async function allModuleRows() {
  if (!(await DB.ready())) return new Map();
  const rows = await DB.q('SELECT "vendorUserId", "moduleKey", "permissionsJson" FROM "VendorLoginModule"');
  const m = new Map();
  rows.forEach((r) => { if (!m.has(r.vendorUserId)) m.set(r.vendorUserId, []); m.get(r.vendorUserId).push(r); });
  return m;
}

const ACCOUNT_TEXT = { waiting: 'Waiting for activation', active: 'Active', locked: 'Locked', switched_off: 'Switched off', vendor_off: 'Vendor switched off' };
function accountOf(vu, mail) {
  const vendorOff = vu.vendor && vu.vendor.isActive === false;
  if (vu.status !== 'Active') return 'switched_off';
  if (vendorOff) return 'vendor_off';
  if (lockedNow(vu)) return 'locked';
  return mail && mail.activated ? 'active' : 'waiting';
}

async function rowOf(vu, modMap, mailInfo) {
  const locked = lockedNow(vu);
  const mail = mailInfo || await MAIL.stateOf(vu);
  const account = accountOf(vu, mail);
  let modRows = [];
  if (modMap) modRows = modMap.get(vu.id) || [];
  else if (await DB.ready()) modRows = await DB.q('SELECT "moduleKey", "permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [vu.id]);
  const mods = modulesOfRows(vu, modRows);
  const openLink = await prisma.vendorLoginToken.findFirst({
    where: { vendorUserId: vu.id, purpose: { not: 'preview' }, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
  });
  const vendorOff = vu.vendor && vu.vendor.isActive === false;
  return {
    id: vu.id,
    vendorId: vu.vendorId,
    vendorName: vu.vendor ? vu.vendor.name : '',
    vendorContactEmail: vu.vendor ? vu.vendor.email || '' : '', // the vendor RECORD's contact email: not the login email, never used for the invitation
    vendorActive: !vendorOff,
    name: vu.name,
    email: vu.email,
    status: vu.status,
    statusText: vu.status !== 'Active' ? 'Switched off' : (vendorOff ? 'Vendor switched off' : (locked ? 'Locked' : 'Active')),
    locked,
    lockedUntil: locked ? vu.lockedUntil : null,
    lastLoginAt: vu.lastLoginAt,
    passwordChangedAt: vu.passwordChangedAt || null,
    lastLoginIp: vu.lastLoginIp || null,
    mustChangePassword: vu.mustChangePassword,
    linkOpen: !!openLink,
    linkExpiresAt: openLink ? openLink.expiresAt : null,
    linkPurpose: openLink ? openLink.purpose : null,
    tempPasswordExpiresAt: vu.mustChangePassword ? vu.tempPasswordExpiresAt : null,
    tempPasswordExpired: tempExpired(vu),
    canEdit: vu.canEdit,
    canViewCost: vu.canViewCost,
    modules: mods.keys,
    modulePermissions: mods.perms,
    modulesConfigured: mods.configured,
    assetIds: (vu.access || []).map((a) => a.assetId).filter(Boolean),
    categories: (vu.access || []).map((a) => a.category).filter(Boolean),
    assignedAssets: await assignedCount(vu),
    createdAt: vu.createdAt,
    // LOGIN EMAILS (2026-10-19): the account state and the state of the invitation / latest email, in plain words.
    activated: mail.activated,
    accountStatus: account,
    accountText: ACCOUNT_TEXT[account],
    invitation: mail.invitation,
    lastMail: mail.lastMail,
    pendingEmail: mail.pendingEmail,
    emailConfirmed: mail.activated,
    emailStatus: mail.emailStatus,
    emailStatusText: ({ verified: 'Verified', not_verified: 'Not verified yet', change_waiting: 'New address waiting to be confirmed' })[mail.emailStatus],
    lastAttempt: mail.lastAttempt,
    newestInvitation: mail.newestInvitation || null,
    lastDelivery: mail.lastDelivery,
    emailAttempts: mail.attempts,
    canResend: mail.canResend,
    canRetry: mail.canRetry,
    canSendReset: mail.canSendReset,
  };
}

// The list, with search + filters (vendor, status, locked) and cascading
// counts computed here.
router.get('/', async (req, res) => {
  const q = req.query || {};
  const all = await prisma.vendorUser.findMany({ where: { deletedAt: null }, include: { vendor: true, access: true }, orderBy: [{ createdAt: 'desc' }] });
  const modMap = await allModuleRows();
  const mailMap = await MAIL.statesFor(all);
  const rows = await Promise.all(all.map((x) => rowOf(x, modMap, mailMap.get(x.id))));
  const s = str(q.q).toLowerCase();
  const pass = (r, skip) => (skip === 'vendor' || !str(q.vendorId) || r.vendorId === str(q.vendorId))
    && (skip === 'status' || !str(q.status) || (str(q.status) === 'Active' ? r.status === 'Active' : r.status !== 'Active'))
    && (skip === 'locked' || !str(q.locked) || (str(q.locked) === 'yes') === r.locked)
    && (skip === 'account' || !str(q.account) || r.accountStatus === str(q.account))
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
      account: count(rows.filter((r) => pass(r, 'account')), (r) => r.accountStatus, (r) => r.accountText),
    },
    portalEnabled: VC.portalEnabled(),
    mail: await MAIL.readiness(),
  });
});

// The modal's choices: ACTIVE vendors only, asset categories, and the assets
// (with the vendor each is linked to, and its old free-text vendor).
router.get('/options', async (req, res) => {
  const [vendors, assets] = await Promise.all([
    prisma.officeVendor.findMany({ where: { isActive: true }, select: { id: true, name: true, contactPerson: true, email: true, category: true, vendorCode: true }, orderBy: { name: 'asc' } }),
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
    vendors: vendors.map((v) => ({ ...v, categoryKey: MODCFG.resolveCategory(v.category) })),
    registry: MODCFG.publicRegistry(),
    categories: [...cats.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
    assets: assets.map((a) => ({ ...a, vendorText: a.vendor || null, vendor: undefined, linkedVendorName: a.vendorId ? vName.get(a.vendorId) || null : null })),
  });
});

// THE VENDOR DROPDOWN of the Add vendor login drawer (fetched when the drawer opens).
// WHY IT WAS EMPTY (2026-10-14): the list is the ACTIVE vendors of the Vendor Master (OfficeVendor, isActive true).
// On the real database that table has 0 rows, so there was truly nothing to pick. Nothing was wrongly filtered:
// there is no ownership or soft-delete filter on this list. It now also says which vendors already have a login
// (shown greyed, "Login exists"), carries each vendor's category (it drives the portal's modules) and the contact
// details to pre-fill, and the screen shows a proper empty state with "+ Add Vendor".
router.get('/vendor-picker', async (req, res) => {
  const [vendors, logins, total] = await Promise.all([
    prisma.officeVendor.findMany({ where: { isActive: true }, select: { id: true, name: true, vendorCode: true, category: true, contactPerson: true, email: true, phone: true }, orderBy: { name: 'asc' } }),
    prisma.vendorUser.groupBy({ by: ['vendorId'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.officeVendor.count(),
  ]);
  const has = new Map(logins.map((l) => [l.vendorId, l._count._all]));
  const rows = vendors.map((v) => ({ ...v, categoryKey: MODCFG.resolveCategory(v.category), hasLogin: (has.get(v.id) || 0) > 0 }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
  res.json({ vendors: rows, totalVendors: total, registry: MODCFG.publicRegistry(), modulesReady: await DB.ready() });
});

// What a category text means for the portal: used by the Add vendor form to show "this vendor will get ...".
router.get('/category-preview', (req, res) => {
  const key = MODCFG.resolveCategory(req.query.category);
  const c = MODCFG.CATEGORIES[key];
  res.json({ key, label: c.label, modules: c.modules.map((k) => MODCFG.MODULES[k].label), known: key !== MODCFG.DEFAULT_CATEGORY || MODCFG.norm(req.query.category) === 'other' });
});
router.get('/registry', (req, res) => res.json(MODCFG.publicRegistry()));

// ---- settings (the "Vendor emails" switch, the feature flag) ---------------
router.get('/settings', async (req, res) => {
  res.json({
    ...(await VC.loadSettings()),
    mail: await MAIL.readiness(),
    emails: Object.entries(MAIL.PURPOSE).map(([kind, purpose]) => ({ kind, purpose, label: MAIL.KIND_WORD[kind] })),
    portalEnabled: VC.portalEnabled(),
    policy: { idleMinutes: VC.CFG.idleMinutes, maxHours: VC.CFG.maxHours, lockMinutes: VC.CFG.lockMinutes, maxFailed: VC.CFG.maxFailed, tempPasswordDays: VC.CFG.tempPasswordDays, uploadMaxMb: Math.round(VC.CFG.uploadMaxBytes / 1048576), passwordMin: VC.PW_MIN },
    canEdit: ['SUPER_ADMIN', 'ADMIN'].includes(req.user.role),
  });
});
router.put('/settings', async (req, res) => {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) return res.status(403).json({ error: 'Only Super Admin or Admin can change this.' });
  const before = await VC.loadSettings();
  const body = req.body || {};
  if (body.supportEmail !== undefined && String(body.supportEmail).trim() && !VP.EMAIL_RE.test(String(body.supportEmail).trim())) return res.status(400).json({ error: 'Enter a proper support email address.', field: 'supportEmail' });
  const s = await VC.saveSettings(body, req.user);
  for (const [k, label] of [['supportEmail', 'Vendor support email'], ['supportPhone', 'Vendor support phone'], ['brandName', 'Vendor email brand name']]) {
    // eslint-disable-next-line no-await-in-loop
    if ((before[k] || '') !== (s[k] || '')) await logAudit({ userId: req.user.id, actorName: actorOf(req), action: `${label} changed`, entity: 'AppSetting', entityId: 'vendorPortal.settings', fromValue: before[k] || '', toValue: s[k] || '' });
  }
  if (before.emailsEnabled !== s.emailsEnabled) {
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: `Vendor emails switched ${s.emailsEnabled ? 'on' : 'off'}`, entity: 'AppSetting', entityId: 'vendorPortal.settings', fromValue: before.emailsEnabled ? 'On' : 'Off', toValue: s.emailsEnabled ? 'On' : 'Off' });
  }
  res.json({ ...s, mail: await MAIL.readiness(), portalEnabled: VC.portalEnabled(), canEdit: true, message: before.emailsEnabled !== s.emailsEnabled ? (s.emailsEnabled ? 'Vendor emails are ON.' : 'Vendor emails are OFF. The app sends no email to vendors or reviewers.') : 'Saved.' });
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
  // The SAME email may also be a staff login (founder, 2026-10-21): the vendor system is separate (VendorUser) and never touches the staff
  // account. Only another VENDOR login on the email is refused.
  const vu = await prisma.vendorUser.findUnique({ where: { email } });
  if (vu && vu.id !== exceptId) return 'Another vendor login already uses this email.';
  return null;
}

// ---------------------------------------------------------------------------
// LOGIN EMAILS - shared helpers (2026-10-19).
// ---------------------------------------------------------------------------
const loginFull = (id) => prisma.vendorUser.findUnique({ where: { id }, include: { vendor: true, access: true } });
const SENT_OK = ['sent', 'delivered', 'used'];

// What Admin sees about one mail attempt, in a sentence (no link, no token, no password).
function mailSentence(kindWord, to, out, backup) {
  if (out.ok === true && out.testMode) return `Test mode: no real email was sent to ${to}. (${kindWord} was made and recorded as a test.)`;
  if (out.ok === true) return `${kindWord} sent to ${to}. The mail server accepted it; delivery is not confirmed by the provider.`;
  if (out.status === 'sending') return `${kindWord} is still being sent. Check the Invitation column in a moment.`;
  return `${kindWord} not sent. ${out.reason || ''}${backup ? ' As a backup you can copy the one-time link shown below.' : ''}`.trim();
}
// The audit lines for one attempt: staff events + the central audit log. Never the link, the token or a password.
async function mailAudit(req, vu, vendorId, kindWord, to, out) {
  const action = out.ok === true ? `${kindWord} accepted by the mail server` : (out.status === 'sending' ? `${kindWord} still sending` : `${kindWord} failed`);
  const detail = out.ok === true ? (out.testMode ? 'test mode: not really sent' : 'accepted by the mail server') : (out.reason || out.status);
  await adminEvent(req, { vendorId, vendorUserId: vu.id, action, newValue: to, status: String(detail).slice(0, 240) });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action, entity: 'VendorUser', entityId: vu.id, toValue: `${to} · ${detail}`.slice(0, 500) });
}
// The answer to a send / resend / retry / reset request. The raw link appears ONLY when email itself is not set up (one time, never stored or logged).
async function mailReply(req, vu, out, link, kindWord, to, extra = {}) {
  const manual = out.ok === false && out.manualLinkAllowed && link;
  if (manual) await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Backup link shown to Admin (email is not set up)', status: 'shown once, not stored' });
  const full = await loginFull(vu.id);
  return {
    login: await rowOf(full),
    emailed: out.ok === true,
    testMode: !!out.testMode,
    message: mailSentence(kindWord, to, out, !!manual),
    ...(manual ? { inviteLink: link.link, inviteExpiresAt: link.expiresAt, backupLinkNote: 'Email is not set up, so here is the link to pass on yourself. It works once and is shown only now.' } : {}),
    ...extra,
  };
}
// Someone pressed the same thing twice (or an API retry): the answer is the state that already exists. Nothing is sent.
async function sameAgain(req, vu, why) {
  const full = await loginFull(vu.id);
  const row = await rowOf(full);
  return { login: row, duplicate: true, emailed: SENT_OK.includes(row.invitation.status), message: `${why} Nothing was sent again.` };
}

// RESEND / RETRY the welcome email of a login that has NOT activated yet. mode: 'resend' | 'retry'.
async function issueInvitation(req, res, mode) {
  const idem = idemKeyOf(req);
  if (idem === null) return res.status(400).json(BAD_IDEM);
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  const st = await MAIL.stateOf(vu);
  if (st.activated) return res.status(409).json({ error: 'This vendor has already activated the login, so the invitation cannot be sent again. Use "Send password reset" if they forgot the password.', code: 'ALREADY_ACTIVE' });
  if (vu.status !== 'Active') return res.status(400).json({ error: 'This login is switched off. Switch it on first.' });
  if (vu.vendor && vu.vendor.isActive === false) return res.status(400).json({ error: `${vu.vendor.name} is switched off in the vendor list.` });
  // FOUNDER RULE: every deliberate click is a NEW attempt and a NEW email (Resend and Retry alike). Only the SAME request again (same
  // Idempotency-Key, or a second request in the very same moment) gets the existing state back.
  if (idem && await MAIL.findByKey(vu.id, 'invite', idem)) return res.json(await sameAgain(req, vu, 'This request was already handled.'));
  if (MAIL.inSameMoment(await MAIL.latest(vu.id, 'invite'))) return res.json(await sameAgain(req, vu, 'An invitation is being sent at this very moment.'));
  const rate = await MAIL.rateCheck(vu.id, 'invite');
  if (rate.limited) return res.status(429).json({ error: MAIL.rateMessage(rate), code: 'TOO_MANY_INVITATIONS', retryAfterMinutes: rate.minutes });
  const claim = await MAIL.claimAttempt({ vu, kind: 'invite', toEmail: vu.email, actor: req.user, via: 'admin', idemKey: idem }, null);
  if (claim.duplicate) return res.json(await sameAgain(req, vu, 'This request was already handled.'));
  // The attempt is ours: now (and only now) make the new link. It cancels every older unused link of this login.
  const link = await INV.createLink(vu.id, 'invite', req.user);
  // A NEW temporary password replaces the old one (the old password stops working at once); only its hash is kept.
  const tempPassword = MAIL.generateTempPassword({ email: vu.email, name: vu.name });
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { passwordHash: await bcrypt.hash(tempPassword, 10), mustChangePassword: true, tempPasswordExpiresAt: link.expiresAt, failedLoginAttempts: 0, lockedUntil: null } });
  await MAIL.patchRow(claim.row.id, { tokenId: link.id, linkExpiresAt: link.expiresAt.toISOString(), credMark: MAIL.credMark(vu.id, tempPassword) });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Invitation requested', status: `attempt ${claim.row.attemptNo} (${mode})` });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: mode === 'retry' ? 'Invitation retried' : 'Invitation resent', status: `attempt ${claim.row.attemptNo} · expires ${link.expiresAt.toISOString()}` });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: mode === 'retry' ? 'Vendor invitation retried' : 'Vendor invitation resent', entity: 'VendorUser', entityId: vu.id, toValue: `${vu.email} · attempt ${claim.row.attemptNo}` });
  await require('../utils/outsideLoginAlert').alertLoginLink({ kind: 'Vendor', who: vu.name, orgName: vu.vendor ? vu.vendor.name : '', purpose: 'invite', by: req.user }); // eslint-disable-line global-require
  const out = await MAIL.deliverWithin(claim.row, { vu, vendor: vu.vendor, link: link.link, expiresAt: link.expiresAt, hours: INV.hours('invite'), tempPassword });
  await mailAudit(req, vu, vu.vendorId, 'Invitation email', vu.email, out);
  return res.json(await mailReply(req, vu, out, link, 'Invitation email', vu.email, { purpose: 'invite' }));
}

// SEND A PASSWORD RESET to a login that HAS activated. forceChange = the older "Reset password" button: sign them out and ask for a
// new password at the next sign-in. The new "Send password reset" does neither: the old password keeps working until the link is used.
async function issueReset(req, res, { forceChange = false } = {}) {
  const idem = idemKeyOf(req);
  if (idem === null) return res.status(400).json(BAD_IDEM);
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) }, include: { vendor: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  const st = await MAIL.stateOf(vu);
  if (!st.activated) return res.status(409).json({ error: 'This vendor has not activated the login yet, so there is no password to reset. Use "Resend invitation".', code: 'NOT_ACTIVE_YET' });
  if (vu.status !== 'Active') return res.status(400).json({ error: 'This login is switched off. Switch it on first.' });
  if (vu.vendor && vu.vendor.isActive === false) return res.status(400).json({ error: `${vu.vendor.name} is switched off in the vendor list.` });
  if (idem && await MAIL.findByKey(vu.id, 'reset', idem)) return res.json(await sameAgain(req, vu, 'This request was already handled.'));
  if (MAIL.inSameMoment(await MAIL.latest(vu.id, 'reset'))) return res.json(await sameAgain(req, vu, 'A reset email is being sent at this very moment.'));
  const rate = await MAIL.rateCheck(vu.id, 'reset');
  if (rate.limited) return res.status(429).json({ error: MAIL.rateMessage(rate), code: 'TOO_MANY_INVITATIONS', retryAfterMinutes: rate.minutes });
  const claim = await MAIL.claimAttempt({ vu, kind: 'reset', toEmail: vu.email, actor: req.user, via: 'admin', idemKey: idem }, null);
  if (claim.duplicate) return res.json(await sameAgain(req, vu, 'This request was already handled.'));
  const link = await INV.createLink(vu.id, 'reset', req.user);
  if (forceChange) {
    await prisma.vendorUser.update({ where: { id: vu.id }, data: { mustChangePassword: true, tempPasswordExpiresAt: link.expiresAt, failedLoginAttempts: 0, lockedUntil: null } });
    await VA.revokeSessions(vu.id, 'reset link made');
  } else {
    await prisma.vendorUser.update({ where: { id: vu.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  }
  await MAIL.patchRow(claim.row.id, { tokenId: link.id, linkExpiresAt: link.expiresAt.toISOString() });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Reset link created', status: `attempt ${claim.row.attemptNo} · expires ${link.expiresAt.toISOString()}` });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor reset link created', entity: 'VendorUser', entityId: vu.id, toValue: `Expires ${link.expiresAt.toISOString()}` });
  await require('../utils/outsideLoginAlert').alertLoginLink({ kind: 'Vendor', who: vu.name, orgName: vu.vendor ? vu.vendor.name : '', purpose: 'reset', by: req.user }); // eslint-disable-line global-require
  const out = await MAIL.deliverWithin(claim.row, { vu, vendor: vu.vendor, link: link.link, expiresAt: link.expiresAt, hours: INV.hours('reset') });
  await mailAudit(req, vu, vu.vendorId, 'Password reset email', vu.email, out);
  return res.json(await mailReply(req, vu, out, link, 'Password reset email', vu.email, { purpose: 'reset' }));
}

// CHANGE THE EMAIL of a login (called from Edit). Never makes a second account.
//   waiting (not activated): the SAME login gets the new address; every older link dies; a new invitation goes to the new address.
//   active: the new address gets a confirmation email; the change counts only after the vendor opens it; the OLD email keeps working until then.
async function changeEmail(req, vu, newEmail) {
  const st = await MAIL.stateOf(vu);
  const idem = idemKeyOf(req) || '';
  if (!st.activated) {
    const live = vu.status === 'Active' && !(vu.vendor && vu.vendor.isActive === false);
    if (live) {
      const rate = await MAIL.rateCheck(vu.id, 'invite');
      if (rate.limited) return { error: MAIL.rateMessage(rate), status: 429 };
    }
    let made;
    const tempPassword = live ? MAIL.generateTempPassword({ email: newEmail, name: vu.name }) : null;
    const tempHash = tempPassword ? await bcrypt.hash(tempPassword, 10) : null;
    const deadHash = tempPassword ? null : await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    try {
      made = await prisma.$transaction(async (tx) => {
        await tx.vendorUser.update({ where: { id: vu.id }, data: { email: newEmail } });
        if (!live) {
          // nothing is sent, and the temporary password that went to the old address stops working
          await tx.vendorUser.update({ where: { id: vu.id }, data: { passwordHash: deadHash } });
          await tx.vendorLoginToken.updateMany({ where: { vendorUserId: vu.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
          return { link: null, claim: null };
        }
        const link = await INV.createLink(vu.id, 'invite', req.user, tx);
        // the old temporary password dies with the old address: a NEW one goes to the new address
        // (a new address starts clean: the wrong tries made against the old address do not follow it)
        await tx.vendorUser.update({ where: { id: vu.id }, data: { passwordHash: tempHash, mustChangePassword: true, tempPasswordExpiresAt: link.expiresAt, failedLoginAttempts: 0, lockedUntil: null } });
        const claim = await MAIL.claimAttempt({ vu: { ...vu, email: newEmail }, kind: 'invite', toEmail: newEmail, tokenId: link.id, linkExpiresAt: link.expiresAt, actor: req.user, via: 'admin', idemKey: idem, credMark: MAIL.credMark(vu.id, tempPassword) }, tx);
        return { link, claim };
      }, { timeout: 20000 });
    } catch (err) {
      if (err && err.code === 'P2002') return { error: 'Another vendor login already uses this email.', status: 400 };
      throw err;
    }
    await VA.revokeSessions(vu.id, 'email changed');
    await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Vendor login edited', field: 'email', oldValue: vu.email, newValue: newEmail, status: 'not activated yet: same login, older links cancelled' });
    if (!made.claim) return { message: `Email changed to ${newEmail}. No email was sent because the login is switched off. Switch it on, then press Resend invitation.`, kind: 'waiting' };
    if (made.claim.duplicate) return { message: `Email changed to ${newEmail}.`, kind: 'waiting' };
    const out = await MAIL.deliverWithin(made.claim.row, { vu: { ...vu, email: newEmail }, vendor: vu.vendor, link: made.link.link, expiresAt: made.link.expiresAt, hours: INV.hours('invite'), tempPassword });
    await mailAudit(req, { ...vu, email: newEmail }, vu.vendorId, 'Invitation email', newEmail, out);
    const manual = out.ok === false && out.manualLinkAllowed;
    return {
      kind: 'waiting', out, message: `Email changed to ${newEmail}. The old link no longer works. ${mailSentence('Invitation email', newEmail, out, manual)}`,
      ...(manual ? { inviteLink: made.link.link, inviteExpiresAt: made.link.expiresAt } : {}),
    };
  }
  // ---- an ACTIVE vendor: ask the new address to confirm first ----
  if (vu.status !== 'Active') return { error: 'This login is switched off. Switch it on first.', status: 400 };
  const token = MAIL.newVerifyToken();
  const expiresAt = new Date(Date.now() + MAIL.VERIFY_HOURS() * 3600000);
  const changeId = `vec${crypto.randomBytes(12).toString('hex')}`;
  const nowIso = new Date().toISOString();
  const made = await prisma.$transaction(async (tx) => {
    await DBX.run('UPDATE "VendorEmailChange" SET "status" = \'replaced\', "closedAt" = ? WHERE "vendorUserId" = ? AND "status" = \'pending\'', [nowIso, vu.id], tx);
    await DBX.run(
      'INSERT INTO "VendorEmailChange" ("id","vendorUserId","oldEmail","newEmail","tokenHash","expiresAt","status","requestedById","requestedByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
      [changeId, vu.id, vu.email, newEmail, MAIL.sha(token), expiresAt.toISOString(), 'pending', req.user.id, actorOf(req), nowIso], tx,
    );
    const claim = await MAIL.claimAttempt({ vu, kind: 'verify', toEmail: newEmail, changeId, linkExpiresAt: expiresAt, actor: req.user, via: 'admin', idemKey: idem }, tx);
    return { claim };
  }, { timeout: 20000 });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Email change requested (waiting for the vendor to confirm)', field: 'email', oldValue: vu.email, newValue: newEmail, status: `confirm by ${expiresAt.toISOString()}` });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor email change requested', entity: 'VendorUser', entityId: vu.id, fromValue: vu.email, toValue: `${newEmail} · waiting for the vendor to confirm` });
  if (made.claim.duplicate) return { message: `A confirmation email for ${newEmail} was already requested.`, kind: 'active' };
  const out = await MAIL.deliverWithin(made.claim.row, { vu, vendor: vu.vendor, link: MAIL.verifyLink(token), expiresAt, hours: MAIL.VERIFY_HOURS(), newEmail });
  await mailAudit(req, vu, vu.vendorId, 'New email confirmation', newEmail, out);
  return {
    kind: 'active', out,
    message: out.ok === true
      ? `We asked ${newEmail} to confirm. The email changes only after the vendor opens that email. Until then ${vu.email} keeps working.`
      : `${mailSentence('Confirmation email', newEmail, out, false)} The old email ${vu.email} keeps working. Press Edit and save again to retry.`,
  };
}

// Which modules + ticks did the admin send? null = an older caller that sends none (the login then behaves as before).
async function choiceOf(b) {
  if (b.modules === undefined) return { choice: null };
  if (!Array.isArray(b.modules)) return { error: 'Tick the modules this vendor will see.' };
  if (!(await DB.ready())) return { error: 'The vendor modules are not set up on this server yet (the database update is pending). Ask the company to finish the setup.', status: 503 };
  const choice = VM.cleanChoice(b.modules, b.permissions);
  if (!choice.keys.length) return { error: 'Tick at least one module for this vendor.', field: 'modules' };
  return { choice };
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const idem = idemKeyOf(req);
  if (idem === null) return res.status(400).json(BAD_IDEM);
  const vendor = b.vendorId ? await prisma.officeVendor.findUnique({ where: { id: String(b.vendorId) } }) : null;
  if (!vendor) return res.status(400).json({ error: 'Pick the vendor from the Vendor list.', field: 'vendorId' });
  if (vendor.isActive === false) return res.status(400).json({ error: `${vendor.name} is switched off in the vendor list. Switch the vendor on first.`, field: 'vendorId' });
  const name = VP.cleanText(b.name, 120).replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Enter the contact name.', field: 'name' });
  const email = VP.normEmail(b.email);
  if (!VP.EMAIL_RE.test(email) || email.length > 160) return res.status(400).json({ error: 'Enter a proper email address.', field: 'email' });
  // Creates are taken ONE AT A TIME (serial() above): six presses at the same moment otherwise fight over SQLite's single writer
  // and some of them time out. The first creates the login; the others then find it and get it back. The database's unique email stays the backstop.
  const gate = await serial(async () => {
    // THE SAME LOGIN AGAIN (a double click, an API retry, an answer that got lost): the second Create returns the login that already exists.
    // Never a second account, never a second email. (The database also refuses a second login with the same email.)
    const already = await prisma.vendorUser.findUnique({ where: { email }, include: { vendor: true } });
    if (already && !already.deletedAt && already.vendorId === vendor.id) {
      const again = await sameAgain(req, already, `${vendor.name} already has a login for ${email}.`);
      return { reply: [200, { ...again, created: false, message: `${again.message} If the first email failed, press Retry sending on that login.` }] };
    }
    const ep = await emailProblem(email);
    if (ep) return { reply: [400, { error: ep, field: 'email' }] };
    // SECURITY (2026-10-13): the app never makes or shows a password. The login gets a random value nobody sees;
    // the vendor chooses their own through the single-use secure link in the welcome email.
    const status = b.status === 'Inactive' ? 'Inactive' : 'Active';
    const ch = await choiceOf(b);
    if (ch.error) return { reply: [ch.status || 400, { error: ch.error, field: ch.field || 'modules' }] };
    const hasAssets = !ch.choice || ch.choice.keys.includes('assets');
    // Assets not ticked: no asset scope and no asset permissions are saved.
    const acc = hasAssets ? await checkAccess(b, vendor.id) : { assetIds: [], categories: [], toLink: [] };
    if (acc.error) return { reply: [400, { error: acc.error, field: 'assets', needLink: acc.needLink }] };
    const assetPerms = ch.choice && ch.choice.perms.assets ? ch.choice.perms.assets : { canEdit: b.canEdit === true, canViewCost: b.canViewCost === true };
    try {
      const made = await createLoginAtomic({
        vendor, name, email, status, user: req.user, actorName: actorOf(req), idemKey: idem,
        canEdit: hasAssets && assetPerms.canEdit === true, canViewCost: hasAssets && assetPerms.canViewCost === true,
        assetIds: acc.assetIds, categories: acc.categories, toLink: acc.toLink, modules: ch.choice,
      });
      return { made, ch, acc, hasAssets, status };
    } catch (err) {
      if (err && err.code === 'P2002') {
        // (Another server process won the same race.) Answer with ITS login (same vendor), send nothing.
        const winner = await prisma.vendorUser.findUnique({ where: { email }, include: { vendor: true } });
        if (winner && !winner.deletedAt && winner.vendorId === vendor.id) {
          const again = await sameAgain(req, winner, `${vendor.name} already has a login for ${email}.`);
          return { reply: [200, { ...again, created: false }] };
        }
        return { reply: [400, { error: 'Another vendor login already uses this email.', field: 'email' }] };
      }
      throw err;
    }
  });
  if (gate.reply) return res.status(gate.reply[0]).json(gate.reply[1]);
  const { made, ch, acc, hasAssets, status } = gate;
  const { vu, link, attempt, tempPassword } = made;
  for (const id of made.linked) {
    // eslint-disable-next-line no-await-in-loop
    await adminEvent(req, { assetId: id, vendorId: vendor.id, action: 'Linked to vendor', field: 'vendorId', oldValue: '', newValue: vendor.name });
  }
  const modText = ch.choice ? ` · modules: ${ch.choice.keys.map((k) => MODCFG.MODULES[k].label).join(', ')}` : '';
  const assetText = hasAssets ? ` · edit ${vu.canEdit ? 'ON' : 'OFF'} · purchase value ${vu.canViewCost ? 'ON' : 'OFF'} · ${accessText(acc.assetIds, acc.categories)}` : '';
  await logAudit({
    userId: req.user.id, actorName: actorOf(req), action: 'Vendor login created', entity: 'VendorUser', entityId: vu.id,
    fromValue: '— (new)',
    toValue: `${vendor.name} · ${name} · ${email} · ${status}${assetText}${modText}`.slice(0, 900),
  });
  await require('../utils/outsideLoginAlert').alertLoginLink({ kind: 'Vendor', who: name, orgName: vendor.name, purpose: 'invite', by: req.user }); // eslint-disable-line global-require
  await adminEvent(req, { vendorId: vendor.id, vendorUserId: vu.id, action: 'Vendor login created', newValue: `${email}${assetText}${modText}`.slice(0, 480) });
  if (ch.choice) await adminEvent(req, { vendorId: vendor.id, vendorUserId: vu.id, action: 'Modules set', field: 'modules', newValue: JSON.stringify(ch.choice.perms).slice(0, 480) });
  await adminEvent(req, { vendorId: vendor.id, vendorUserId: vu.id, action: 'Invitation requested', status: `attempt 1 · expires ${link.expiresAt.toISOString()}` });
  // THE WELCOME EMAIL: only now that the login is saved. A login that is switched off at creation gets no email (the link would not work).
  let out;
  if (status === 'Active') {
    out = await MAIL.deliverWithin(attempt, { vu, vendor, link: link.link, expiresAt: link.expiresAt, hours: INV.hours('invite'), tempPassword });
    await mailAudit(req, vu, vendor.id, 'Welcome email', email, out);
  } else {
    out = { ok: false, status: 'failed', failCode: 'SWITCHED_OFF', reason: 'The login was created switched off, so no email was sent. Switch it on, then press Resend invitation.', manualLinkAllowed: false };
    await MAIL.patchRow(attempt.id, { status: 'failed', failCode: 'SWITCHED_OFF', failReason: out.reason, failedAt: new Date().toISOString() });
  }
  const reply = await mailReply(req, vu, out, link, 'Welcome email', email, { created: true });
  return res.status(201).json({ ...reply, message: `Vendor login created. ${reply.message}` });
});

// THE LOGIN AN EDIT MEANS (founder, 2026-10-23: "Vendor login not found" when changing the email of a vendor who had not activated yet).
// The screen sends the login's id; the id can be STALE (the login was removed and made again, the page is old, a second admin changed it). Then the
// login is found by what does not change: its vendor + its name, and only when that is exactly ONE live login of that vendor. Otherwise the answer says
// which of the causes it is (no such vendor / the vendor has no login / more than one) instead of one flat "not found".
async function loginForEdit(idParam, hint = {}) {
  const byId = await prisma.vendorUser.findUnique({ where: { id: String(idParam) }, include: { vendor: true } }).catch(() => null);
  if (byId && !byId.deletedAt) return { vu: byId };
  const vendorId = String(hint.vendorId || (byId && byId.vendorId) || '');
  if (!vendorId) return { status: 404, code: 'LOGIN_NOT_FOUND', error: 'This login is not on this server any more. Refresh the page; if it still shows, create the login again from the vendor.' };
  const vendor = await prisma.officeVendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true } }).catch(() => null);
  if (!vendor) return { status: 404, code: 'VENDOR_NOT_FOUND', error: 'The vendor of this login is not in the vendor list any more.' };
  const name = hint.loginName ? String(hint.loginName) : (byId ? byId.name : null);
  const live = await prisma.vendorUser.findMany({ where: { vendorId, deletedAt: null, ...(name ? { name } : {}) }, include: { vendor: true } });
  if (live.length === 1) return { vu: live[0], recovered: true };
  if (live.length > 1) return { status: 409, code: 'MORE_THAN_ONE_LOGIN', error: `${vendor.name} has more than one login with this name. Refresh the page and edit the one you mean from the list.` };
  return { status: 404, code: 'NO_LOGIN_FOR_VENDOR', error: `${vendor.name} has no login on this server. Create the login first (Add login), then it can be invited.` };
}

router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const found = await loginForEdit(req.params.id, b);
  if (found.error) return res.status(found.status || 404).json({ error: found.error, code: found.code });
  const vu = found.vu;
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
  // THE EMAIL is not swapped in place any more (2026-10-19): a waiting login moves to the new address with a fresh invitation, an active
  // one keeps its old email until the vendor confirms the new one (changeEmail above). Done after the other edits are saved.
  let newEmail = null;
  if (b.email !== undefined) {
    const email = VP.normEmail(b.email);
    if (email !== vu.email) {
      const ep = await emailProblem(email, vu.id);
      if (ep) return res.status(400).json({ error: ep, field: 'email' });
      const st0 = await MAIL.stateOf(vu);
      if (st0.activated && vu.status !== 'Active' && b.status === undefined) return res.status(400).json({ error: 'This login is switched off. Switch it on first, then change the email.', field: 'email' });
      newEmail = email;
    }
  }
  if (b.status !== undefined) {
    const s = b.status === 'Inactive' ? 'Inactive' : 'Active';
    if (s !== vu.status) { data.status = s; changes.push(['status', vu.status, s]); }
  }
  for (const [k, label] of [['canEdit', 'Allow editing'], ['canViewCost', 'Show purchase value']]) {
    if (b[k] !== undefined && (b[k] === true) !== vu[k]) { data[k] = b[k] === true; changes.push([label, vu[k] ? 'ON' : 'OFF', b[k] === true ? 'ON' : 'OFF']); }
  }
  // MODULES (2026-10-14): the admin may change a login's modules / ticks later; the portal reflects it on the vendor's next call.
  const ch = await choiceOf(b);
  if (ch.error) return res.status(ch.status || 400).json({ error: ch.error, field: ch.field || 'modules' });
  if (ch.choice) {
    const beforeRows = await DB.q('SELECT "moduleKey","permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [vu.id]);
    const beforeMods = beforeRows.map((r) => r.moduleKey);
    if (!ch.choice.keys.includes('assets')) {
      // Assets switched off: its permissions go off too (least privilege). The picked assets stay on file but are not served.
      if (vu.canEdit) { data.canEdit = false; changes.push(['Allow editing', 'ON', 'OFF']); }
      if (vu.canViewCost) { data.canViewCost = false; changes.push(['Show purchase value', 'ON', 'OFF']); }
    } else {
      const ap = ch.choice.perms.assets || {};
      for (const [k, label] of [['canEdit', 'Allow editing'], ['canViewCost', 'Show purchase value']]) {
        if ((ap[k] === true) !== vu[k]) { data[k] = ap[k] === true; changes.push([label, vu[k] ? 'ON' : 'OFF', ap[k] === true ? 'ON' : 'OFF']); }
      }
    }
    const was = beforeMods.length ? beforeMods : MODCFG.LEGACY_MODULES;
    const lab = (arr) => arr.map((k) => (MODCFG.MODULES[k] || {}).label || k).join(', ') || '-';
    if ([...was].sort().join(',') !== [...ch.choice.keys].sort().join(',')) {
      changes.push(['Modules', lab(was), lab(ch.choice.keys)]);
    } else if (beforeMods.length) {
      const oldP = Object.fromEntries(beforeRows.map((r) => [r.moduleKey, JSON.stringify({ ...MODCFG.defaultPermissions(r.moduleKey), ...VM.parseJson(r.permissionsJson) })]));
      const changed = ch.choice.keys.filter((k) => k !== 'assets' && oldP[k] !== JSON.stringify(ch.choice.perms[k]));
      if (changed.length) changes.push(['Module permissions', changed.map((k) => MODCFG.MODULES[k].label).join(', '), 'changed']);
    } else changes.push(['Modules', 'as before (assets, invoices)', 'saved']);
  }
  let acc = null;
  if ((b.assetIds !== undefined || b.categories !== undefined) && (!ch.choice || ch.choice.keys.includes('assets'))) {
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
  if (Object.keys(data).length || ch.choice) {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.vendorUser.update({ where: { id: vu.id }, data });
      if (ch.choice) await VM.saveModules(vu.id, ch.choice.keys, ch.choice.perms, tx);
    }, { timeout: 20000 });
  }
  if (acc) { await linkAssets(req, acc.toLink, vu.vendor); await writeAccess(vu.id, acc.assetIds, acc.categories); }
  if (data.status === 'Inactive') await VA.revokeSessions(vu.id, 'deactivated');
  for (const [field, from, to] of changes) {
    // eslint-disable-next-line no-await-in-loop
    await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: ['Allow editing', 'Show purchase value', 'Asset access', 'Modules', 'Module permissions'].includes(field) ? 'Permission changed' : 'Vendor login edited', field, oldValue: from, newValue: to });
  }
  if (changes.length) {
    await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor login edited', entity: 'VendorUser', entityId: vu.id, toValue: changes.map(([f, a, c]) => `${f} ${a} → ${c}`).join(' · ').slice(0, 900) });
  }
  let emailResult = null;
  if (newEmail) {
    const fresh = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true } });
    emailResult = await changeEmail(req, fresh, newEmail);
    if (emailResult.error) return res.status(emailResult.status || 400).json({ error: emailResult.error, field: 'email' });
  }
  const full = await prisma.vendorUser.findUnique({ where: { id: vu.id }, include: { vendor: true, access: true } });
  const saved = changes.length ? 'Saved.' : (emailResult ? '' : 'Nothing changed.');
  return res.json({
    login: await rowOf(full),
    message: [saved, emailResult && emailResult.message].filter(Boolean).join(' '),
    ...(emailResult ? { emailChange: emailResult.kind, emailed: !!(emailResult.out && emailResult.out.ok === true) } : {}),
    ...(emailResult && emailResult.inviteLink ? { inviteLink: emailResult.inviteLink, inviteExpiresAt: emailResult.inviteExpiresAt } : {}),
  });
});

// Take back an email change that is still waiting for the vendor (active logins).
router.post('/:id/email-change/cancel', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  const pend = await DBX.one('SELECT * FROM "VendorEmailChange" WHERE "vendorUserId" = ? AND "status" = \'pending\'', [vu.id]);
  if (!pend) return res.json({ login: await rowOf(await loginFull(vu.id)), message: 'There is no email change waiting.' });
  await DBX.run('UPDATE "VendorEmailChange" SET "status" = \'cancelled\', "closedAt" = ? WHERE "id" = ? AND "status" = \'pending\'', [new Date().toISOString(), pend.id]);
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Email change cancelled', field: 'email', oldValue: pend.newEmail, newValue: vu.email });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor email change cancelled', entity: 'VendorUser', entityId: vu.id, fromValue: pend.newEmail, toValue: vu.email });
  return res.json({ login: await rowOf(await loginFull(vu.id)), message: `The change to ${pend.newEmail} was cancelled. ${vu.email} stays.` });
});

// The emails sent to this login, newest first (status only - never a link or a body).
router.get('/:id/emails', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  return res.json({ rows: await MAIL.historyOf(vu.id), state: await MAIL.stateOf(vu) });
});

// RESEND INVITATION / RETRY: only for a login that has not activated. Every deliberate click = a new attempt = a new email (new temporary
// password + new link; the older ones die). The same request again (same Idempotency-Key) = the existing state, nothing sent.
router.post('/:id/resend-invitation', (req, res) => issueInvitation(req, res, 'resend'));
router.post('/:id/invitation/retry', (req, res) => issueInvitation(req, res, 'retry'));
// SEND PASSWORD RESET: only for a login that has activated.
router.post('/:id/send-reset', (req, res) => issueReset(req, res, { forceChange: false }));

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
// OPEN PORTAL (Admin preview). Mints ONE single-use token that lasts 60 seconds
// (stored as a hash; never the vendor password, never a vendor id as authority).
// The browser trades it at /api/vendor-portal/preview/redeem for a view-only
// vendor session in its own tab. The staff session is not touched. Audited
// here and again when the token is used.
router.post('/:id/open-portal', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: req.params.id }, include: { vendor: true } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Login not found.' });
  if (vu.status !== 'Active' || !vu.vendor || vu.vendor.isActive === false) return res.status(400).json({ error: 'This vendor login is switched off. Activate it first to open its portal.' });
  await prisma.vendorLoginToken.updateMany({ where: { vendorUserId: vu.id, purpose: 'preview', usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.vendorLoginToken.create({
    data: { vendorUserId: vu.id, purpose: 'preview', tokenHash: INV.hashOf(token), expiresAt: new Date(Date.now() + 60 * 1000), createdById: req.user.id, createdByName: actorOf(req) },
  });
  await adminEvent(req, { vendorId: vu.vendorId, vendorUserId: vu.id, action: 'Open portal requested (Admin preview)', status: 'single-use, 60 seconds' });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Vendor portal preview link made', entity: 'VendorUser', entityId: vu.id, toValue: `${vu.vendor.name} · ${vu.email}` });
  return res.json({ token, expiresInSeconds: 60 });
});

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
  // SECURITY (2026-10-13): no password is made or shown; the default is a one-time reset link, now EMAILED (2026-10-19) and
  // recorded like every login email. This older button also signs the vendor out and asks for a new password at the next sign-in.
  if (!b.password) return MAIL.isActivated(vu) ? issueReset(req, res, { forceChange: true }) : issueInvitation(req, res, 'resend'); // not activated yet: there is no password to reset, so it is the invitation again
  const password = String(b.password || '');
  {
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
  return res.json({ emailed: false, message: `Password reset. They must set a new one when they sign in (within ${VC.CFG.tempPasswordDays} days). Passwords are never emailed - prefer "Send secure link".` });
});

// SECURE LINK (invite for a login that never signed in, reset for one that did):
// the vendor chooses their own password. Old unused links stop working, open
// sessions end, and the old password stops working once the link is used.
router.post('/:id/invite', async (req, res) => {
  // The older single button ("Send invite link" / "Send reset link"): now one of the two proper actions, chosen by the login's state.
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  if (MAIL.isActivated(vu)) return issueReset(req, res, { forceChange: true });
  return issueInvitation(req, res, 'resend');
});

// Soft delete: the row stays (history), the login is gone for good.
router.delete('/:id', async (req, res) => {
  const vu = await prisma.vendorUser.findUnique({ where: { id: String(req.params.id) } });
  if (!vu || vu.deletedAt) return res.status(404).json({ error: 'Vendor login not found.' });
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { deletedAt: new Date(), status: 'Inactive' } });
  await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: vu.id } });
  await VA.revokeSessions(vu.id, 'deleted');
  await prisma.vendorLoginToken.updateMany({ where: { vendorUserId: vu.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  await DBX.run('UPDATE "VendorEmailChange" SET "status" = \'cancelled\', "closedAt" = ? WHERE "vendorUserId" = ? AND "status" = \'pending\'', [new Date().toISOString(), vu.id]);
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
