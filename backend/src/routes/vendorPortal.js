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
const INVITE = require('../utils/vendorInvite');
const INVOICES = require('../utils/vendorInvoices');
const SIGNED = require('../utils/vendorSigned');
const VM = require('../utils/vendorModules');
const MAIL = require('../utils/vendorMail');
const MODCFG = require('../config/vendorModules');
const DBX = require('../utils/vmDb');
const AVP = require('../utils/assetVendorPortal');
const KIND = require('../utils/vendorKind');
const SIGN = require('../utils/vendorSignin');

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

// THE FOUR MODULES (2026-10-19, config/vendorModules.js PORTAL_NAV): a vendor session reaches Dashboard, Invoices, Payments and Purchase Orders
// (the /records API), plus the account utilities (me, logout, change password) and its own signed file downloads. Every other path of
// this API - assets, bills, documents, profile, ID cards, SIM, office, expenses, payments of the old module - answers 403 "not available",
// whatever the login's old module ticks say. The sign-in, activation, forgot-password and email-confirmation routes stay public.
// VENDOR_PORTAL_ALL_MODULES=1 lifts this wall (a test / roll-back switch, never needed in normal use).
// ASSETS VENDOR PORTAL (2026-10-19): the wall is TYPE-AWARE. An ASSET vendor (utils/assetVendorPortal.js kindOf) reaches the /asset-portal/*
// API and the account utilities, and NOT the finance API (/records, /module-bills); every other vendor reaches exactly what it reached before
// and NOT /asset-portal/*. A request without a (valid) vendor token cannot be classified, so the public paths pass as before and the routes'
// own sign-in check answers 401.
const NOT_AVAILABLE = { error: 'This page is not available in the Vendor Portal.', notAvailable: true };
router.use(async (req, res, next) => {
  try {
    if (['1', 'true', 'yes', 'on'].includes(String(process.env.VENDOR_PORTAL_ALL_MODULES || '').toLowerCase())) return next();
    const owner = MODCFG.kindOwningPath(req.path);
    if (!owner && !MODCFG.portalPathAllowed(req.path)) return res.status(403).json(NOT_AVAILABLE);
    if (!owner) return next(); // account utilities, public sign-in paths, downloads: every kind
    const kind = await KIND.kindOfToken(VA.bearerOf(req));
    if (!kind) return next();
    return MODCFG.portalPathAllowedFor(kind, req.path) ? next() : res.status(403).json(NOT_AVAILABLE);
  } catch (err) { return next(err); }
});

router.get('/status', (req, res) => res.json({ enabled: true, idleMinutes: VC.CFG.idleMinutes, maxHours: VC.CFG.maxHours }));

// ---- sign in ----------------------------------------------------------------
// Limits: per network (30 / 15 min) AND per network+account (10 / 15 min).
// Lock: VENDOR_MAX_FAILED_LOGINS (5) wrong passwords lock for VENDOR_LOCK_MINUTES
// (30), then it unlocks by itself; Admin can unlock earlier. The counter
// resets on success. An unknown login ID and a wrong password read the same
// ("Invalid credentials."), so nothing about the account leaks to a stranger.
// A reason is named ONLY to somebody who proves they hold a real credential
// (the right password: switched off / expired; an OLD temporary password:
// "replaced by a newer email") - utils/vendorSignin.js. A lock reads the same
// for a real and an unknown login ID, whatever password was typed.
// 2026-10-19: the login ID and password are read tolerantly (VC.loginIdOf /
// VC.passwordCandidates): case, spaces, line breaks, zero-width characters.
const ipLimit = rateLimit({ bucket: 'vendor-login-ip', max: Number(process.env.VENDOR_LOGIN_IP_MAX || 30), windowMs: 15 * 60000 });
const perEmail = new Map();
function emailLimit(req, res, next) {
  const key = `${ipOf(req)}|${VC.loginIdOf(req.body && req.body.email)}`;
  const now = Date.now();
  const list = (perEmail.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (list.length >= Number(process.env.VENDOR_LOGIN_EMAIL_MAX || 10)) {
    res.set('Retry-After', '900');
    return res.status(429).json({ error: 'Too many sign-in tries from this device. Please wait 15 minutes and try again.', code: 'TOO_MANY' });
  }
  list.push(now);
  perEmail.set(key, list);
  if (perEmail.size > 5000) perEmail.clear();
  return next();
}
const DUMMY_HASH = bcrypt.hashSync(`x${Math.random()}`, 10);
const isLocked = (vu) => !!(vu.lockedUntil && new Date(vu.lockedUntil) > new Date());

router.post('/login', ipLimit, emailLimit, async (req, res) => {
  // The login ID is read tolerantly (spaces, capitals, a pasted "<...>" or hidden characters never matter). The password is tried EXACTLY as
  // typed first, then tidied of the invisible extras a copy-paste brings (see VC.passwordCandidates); a chosen password is saved as typed.
  const email = VC.loginIdOf(req.body && req.body.email);
  const rawPassword = String((req.body && req.body.password) || '');
  if (!email || !rawPassword.trim()) return res.status(400).json({ error: 'Enter your login ID (email) and password.' });
  const vu = await prisma.vendorUser.findUnique({ where: { email }, include: { vendor: true } });
  const deny = async (why, status, body) => {
    if (vu) await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login failed', status: why });
    return res.status(status).json(body);
  };
  // 1. Locked? Said the same way for a real login and for an unknown ID, whatever password was typed (so a lock tells a guesser nothing).
  const lockedFor = vu ? (isLocked(vu) ? SIGN.minutesLeft(vu.lockedUntil) : 0) : SIGN.ghostMinutes(email);
  if (lockedFor) return deny('locked', 401, SIGN.lockedBody(lockedFor));
  // 2. The password. The same number of password checks happen whether or not the login exists (nothing to learn from the time).
  const tries = VC.passwordCandidates(rawPassword, { temp: !vu || !!vu.mustChangePassword });
  let ok = false;
  let checks = 0;
  if (vu) {
    for (const p of tries) {
      checks += 1;
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(p, vu.passwordHash)) { ok = true; break; }
    }
  }
  if (!ok) {
    while (checks < 3) { checks += 1; await bcrypt.compare(rawPassword, DUMMY_HASH); } // eslint-disable-line no-await-in-loop
    // A password that really was issued by an email, but is not the current one: say so (only a holder of it can see this). Not a wrong try.
    const known = await SIGN.recognise({ loginId: email, vu, rawPassword });
    if (known) return deny(known.why, 401, known.body);
    if (!vu) {
      const nowLocked = SIGN.ghostFail(email);
      return res.status(401).json(nowLocked ? SIGN.lockedBody(nowLocked) : SIGN.invalidBody());
    }
    // A STAFF login on the same email (allowed since 2026-10-21): the one login page asks the staff sign-in first and then this one, and a wrong
    // try cannot be told from a staff person's typo, so it is NOT counted toward the vendor lock (this route's rate limits still apply).
    const staffOnEmail = await require('../utils/loginAccounts').accountsByEmail(email).then((l) => l.length > 0).catch(() => false); // eslint-disable-line global-require
    if (staffOnEmail) return deny('wrong password', 401, SIGN.invalidBody());
    const failed = (vu.failedLoginAttempts || 0) + 1;
    const lock = failed >= VC.CFG.maxFailed;
    await prisma.vendorUser.update({
      where: { id: vu.id },
      data: lock ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + VC.CFG.lockMinutes * 60000) } : { failedLoginAttempts: failed },
    });
    if (lock) {
      await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login locked', status: `${VC.CFG.maxFailed} wrong passwords · ${VC.CFG.lockMinutes} min` });
      await logAudit({ action: `Vendor login locked after ${VC.CFG.maxFailed} wrong passwords`, entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: `Locked ${VC.CFG.lockMinutes} min` });
      return deny('locked now', 401, SIGN.lockedBody(VC.CFG.lockMinutes));
    }
    return deny('wrong password', 401, SIGN.invalidBody());
  }
  // 3. The ID and the password are RIGHT. From here on the real reason is told (it gives nothing away to anybody else).
  if (vu.deletedAt) return deny('deleted', 401, SIGN.invalidBody());
  if (vu.status !== 'Active') return deny('switched off', 401, SIGN.reasonBody.switchedOff());
  if (!vu.vendor || vu.vendor.isActive === false) return deny('vendor switched off', 401, SIGN.reasonBody.vendorOff());
  if (vu.mustChangePassword && vu.tempPasswordExpiresAt && new Date(vu.tempPasswordExpiresAt) < new Date()) return deny('temporary password expired', 401, SIGN.reasonBody.tempExpired());
  const meta = VC.requestMeta(req);
  await prisma.vendorUser.update({ where: { id: vu.id }, data: { lastLoginAt: new Date(), lastLoginIp: meta.ip, failedLoginAttempts: 0, lockedUntil: null } });
  const { token } = await VA.createSession(vu, req);
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Login success', status: vu.mustChangePassword ? 'must change password' : 'ok' });
  await logAudit({ action: 'Vendor signed in', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: vu.vendor.name });
  const landing = await landingOf({ userId: vu.id, vendorId: vu.vendorId });
  return res.json({ token, idleMinutes: VC.CFG.idleMinutes, landing, vendor: meOf({ ...vu, vendorName: vu.vendor.name }) });
});

// Where this login lands after sign-in: Assets when at least one asset is
// assigned to it (VendorAssetAccess + the vendor's own, not archived), else
// Invoices. Always server-computed, never taken from the request.
async function landingOf(who) {
  // Every vendor lands on the Dashboard of ITS portal after sign-in: the finance Dashboard, or the Assets portal's Dashboard for an asset
  // vendor. Server-computed, never taken from the request.
  if (!who || !who.userId) return MODCFG.PORTAL_HOME;
  const vu = await prisma.vendorUser.findUnique({ where: { id: who.userId }, include: { vendor: true } });
  const kind = vu ? await KIND.kindOfRow(vu) : 'finance';
  return { assets: MODCFG.ASSET_PORTAL_HOME, idcards: MODCFG.IDCARD_PORTAL_HOME, telecom: MODCFG.TELECOM_PORTAL_HOME }[kind] || MODCFG.PORTAL_HOME;
}

function meOf(vu) {
  return {
    name: vu.name, email: vu.email, vendorName: vu.vendorName || (vu.vendor && vu.vendor.name) || '',
    canEdit: !!vu.canEdit, canViewCost: !!vu.canViewCost, mustChangePassword: !!vu.mustChangePassword,
    lastLoginAt: vu.lastLoginAt || null,
  };
}

const anyVendor = VA.requireVendor({ allowPasswordChange: true });
const vendorOnly = VA.requireVendor();

// /me is what the portal builds itself from: the modules this login has (registry order), each with its dashboard
// summary, and the nav. Read fresh on every load, so an admin's change shows on the vendor's next page load.
router.get('/me', anyVendor, async (req, res) => res.json({
  ...meOf({ ...req.vendor.row, vendorName: req.vendor.vendorName }), idleMinutes: VC.CFG.idleMinutes, landing: await landingOf(req.vendor), preview: req.vendor.preview || null,
  ...(req.vendor.preview ? { mustChangePassword: false } : {}),
  ...(req.vendor.mustChangePassword && !req.vendor.preview ? {} : await VM.portalFor(req)),
}));

// THE CENTRAL MODULE CHECK for the older routes: a module the login does not have is not served (403).
router.use('/assets', VM.guardPrefix(vendorOnly, 'assets'));
router.use('/bills', VM.guardPrefix(vendorOnly, 'assets'));
router.use('/dashboard', VM.guardPrefix(vendorOnly, 'assets'));
router.use('/invoices', VM.guardPrefix(vendorOnly, 'invoices'));

// ---- DASHBOARD: live counts from the vendor's OWN authorised assets ----------
// Same access rule as the list (own vendor AND ticked: specific assets or whole
// categories). Status mapping (Asset.status has no "Returned"):
//   Total assigned   = every authorised asset that is not archived
//   Active           = status Available or Assigned
//   Under repair     = status "In Repair", or an open repair entry (Reported / In Repair)
//   Repair completed = assets with at least one repair entry "Completed"
//   Returned/retired = authorised assets the company archived (Retired, Sold, Written off)
//   Other            = anything else (status outside the above)
router.get('/dashboard', vendorOnly, async (req, res) => {
  const access = await prisma.vendorAssetAccess.findMany({ where: { vendorUserId: req.vendor.userId } });
  const ids = access.map((a) => a.assetId).filter(Boolean);
  const cats = access.map((a) => a.category).filter(Boolean);
  const or = [];
  if (ids.length) or.push({ id: { in: ids } });
  if (cats.length) or.push({ category: { in: cats } });
  if (!or.length) return res.json({ total: 0, active: 0, underRepair: 0, repairCompleted: 0, returned: 0, other: 0, hasAssets: false });
  const mine = { AND: [{ vendorId: req.vendor.vendorId }, { OR: or }] };
  const live = { AND: [mine, { NOT: { status: { in: VA.ARCHIVED } } }] };
  const [total, active, underRepairStatus, returned, openRepair, completed] = await Promise.all([
    prisma.asset.count({ where: live }),
    prisma.asset.count({ where: { AND: [mine, { status: { in: ['Available', 'Assigned'] } }] } }),
    prisma.asset.count({ where: { AND: [mine, { status: 'In Repair' }] } }),
    prisma.asset.count({ where: { AND: [mine, { status: { in: VA.ARCHIVED } }] } }),
    prisma.asset.count({ where: { AND: [live, { status: { not: 'In Repair' } }, { repairs: { some: { status: { in: ['Reported', 'In Repair'] } } } }] } }),
    prisma.asset.count({ where: { AND: [live, { repairs: { some: { status: 'Completed' } } }] } }),
  ]);
  res.json({
    total, active, underRepair: underRepairStatus + openRepair, repairCompleted: completed, returned,
    other: Math.max(0, total - active - underRepairStatus), hasAssets: total + returned > 0,
  });
});

// ---- ADMIN PREVIEW handoff: redeem a single-use, short-lived token -----------
// Minted by a staff member who may manage vendor logins (routes/vendorLogins.js
// POST /:id/open-portal), stored only as a hash, valid about a minute, usable
// once. The session it opens is VIEW-ONLY and marked "Admin preview". Every
// refusal reads the same.
router.post('/preview/redeem', ipLimit, async (req, res) => {
  const BAD = { error: 'This link is not valid or has expired. Open the portal again from Vendor logins.' };
  const token = String((req.body && req.body.token) || '');
  if (token.length < 20) return res.status(404).json(BAD);
  const row = await prisma.vendorLoginToken.findUnique({ where: { tokenHash: INVITE.hashOf(token) }, include: { vendorUser: { include: { vendor: true } } } });
  const vu = row && row.vendorUser;
  if (!row || row.purpose !== 'preview' || row.usedAt || row.revokedAt || new Date(row.expiresAt) < new Date()) return res.status(404).json(BAD);
  if (!vu || vu.status !== 'Active' || vu.deletedAt || !vu.vendor || vu.vendor.isActive === false) return res.status(404).json(BAD);
  const used = await prisma.vendorLoginToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date(), usedIp: VC.requestMeta(req).ip } });
  if (used.count !== 1) return res.status(404).json(BAD);
  const by = row.createdByName || 'Admin';
  const { token: vt } = await VA.createSession(vu, req, { previewBy: by });
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: `${by} (Admin preview)`, action: 'Admin preview opened', status: 'single-use handoff used' });
  await logAudit({ userId: row.createdById || undefined, action: 'Vendor portal opened as Admin preview', entity: 'VendorUser', entityId: vu.id, actorName: by, toValue: `${vu.vendor.name} · ${vu.email}` });
  const landing = await landingOf({ userId: vu.id, vendorId: vu.vendorId });
  return res.json({ token: vt, landing, preview: by, vendor: meOf({ ...vu, vendorName: vu.vendor.name, mustChangePassword: false }) });
});

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
  let currentOk = false;
  for (const p of VC.passwordCandidates(String(currentPassword), { temp: !!vu.mustChangePassword })) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(p, vu.passwordHash)) { currentOk = true; break; }
  }
  if (!currentOk) {
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
  // The login is activated now: the unused invitation link (and any older reset link) must not be able to set a password afterwards.
  await prisma.vendorLoginToken.updateMany({ where: { vendorUserId: vu.id, usedAt: null, revokedAt: null, purpose: { in: ['invite', 'reset'] } }, data: { revokedAt: new Date() } });
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: vu.mustChangePassword ? 'Account activated (temporary password replaced)' : 'Password changed' });
  await logAudit({ action: 'Vendor password changed', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: 'Changed' });
  res.json({ ok: true, message: 'Password changed.' });
});

// ---- invite / reset link (public: no sign-in yet) ----------------------------
// The link is single use and expiring (utils/vendorInvite.js). Every refusal
// reads the same, so nothing leaks about which part was wrong.
const BAD_LINK = 'This link is not valid or has expired. Ask your contact for a new one.';
const acceptLimit = rateLimit({ bucket: 'vendor-invite', max: Number(process.env.VENDOR_INVITE_IP_MAX || 20), windowMs: 15 * 60000 });

router.get('/invite/:token', acceptLimit, async (req, res) => {
  const row = await INVITE.findUsable(req.params.token);
  if (!row) return res.status(404).json({ error: BAD_LINK });
  const vu = row.vendorUser;
  return res.json({ valid: true, purpose: row.purpose, name: vu.name, email: vu.email, loginId: vu.email, vendorName: vu.vendor.name, expiresAt: row.expiresAt });
});

router.post('/invite/accept', ipLimit, acceptLimit, async (req, res) => {
  const b = req.body || {};
  const row = await INVITE.findUsable(b.token);
  if (!row) return res.status(400).json({ error: BAD_LINK, linkProblem: true });
  const vu = row.vendorUser;
  const newPassword = String(b.newPassword || '');
  if (!newPassword) return res.status(400).json({ field: 'newPassword', error: 'Choose a password.' });
  if (b.confirmPassword !== undefined && b.confirmPassword !== newPassword) return res.status(400).json({ field: 'confirmPassword', error: 'The two passwords do not match.' });
  const weak = VC.vendorPasswordProblem(newPassword, { email: vu.email, name: vu.name });
  if (weak) return res.status(400).json({ field: 'newPassword', error: weak });
  for (const h of [vu.passwordHash, ...VC.parseHistory(vu.passwordHistory)]) {
    // eslint-disable-next-line no-await-in-loop
    if (h && await bcrypt.compare(newPassword, h)) return res.status(400).json({ field: 'newPassword', error: 'You used that password before. Choose a new one.' });
  }
  // The password is checked BEFORE the link is burned, so a typo does not cost the link;
  // burning is atomic, so only one request can ever win.
  const meta = VC.requestMeta(req);
  if (!(await INVITE.consume(row, meta.ip))) return res.status(400).json({ error: BAD_LINK, linkProblem: true });
  await prisma.vendorUser.update({
    where: { id: vu.id },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 10), passwordHistory: VC.pushHistory(vu.passwordHistory, vu.passwordHash),
      mustChangePassword: false, tempPasswordExpiresAt: null, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null,
      lastLoginAt: new Date(), lastLoginIp: meta.ip,
    },
  });
  await VA.revokeSessions(vu.id, row.purpose === 'reset' ? 'password reset by link' : 'invite accepted');
  const { token } = await VA.createSession(vu, req);
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: row.purpose === 'reset' ? 'Password reset by link' : 'Invite accepted', status: 'password chosen by the vendor' });
  await logAudit({ action: row.purpose === 'reset' ? 'Vendor password reset by link' : 'Vendor accepted invite', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: vu.vendor.name });
  const fresh = await prisma.vendorUser.findUnique({ where: { id: vu.id } });
  return res.json({ token, idleMinutes: VC.CFG.idleMinutes, vendor: meOf({ ...fresh, vendorName: vu.vendor.name }), message: 'Your password is set. Welcome.' });
});

// ---- FORGOT PASSWORD (public, 2026-10-19) -------------------------------------------------------------
// "Forgot your password?" on the Vendor Portal sign-in. NO ACCOUNT ENUMERATION: the answer is the same, and just as quick, whether the
// email belongs to a login or not - the work happens after the answer has gone. Only an ACTIVATED, switched-on login gets a link
// (single use, 1 hour, replaces older links). Limits: per network (10 / 15 min, 429), and per login (3 emails an hour; the rest are
// quietly skipped). A vendor who never activated is not sent a reset: they need the invitation (Admin resends it).
const FORGOT_SAME = {
  ok: true,
  message: 'If this email belongs to an active Vendor Portal login, we have emailed a link to choose a new password. Check your inbox and spam folder; the link works once for 1 hour. If you never set up your login, ask TeamLink to send your invitation again.',
};
const forgotLimit = rateLimit({ bucket: 'vendor-forgot', max: Number(process.env.VENDOR_FORGOT_IP_MAX || 10), windowMs: 15 * 60000 });

async function processForgot(req, email) {
  await MAIL.ensure();
  const vu = await prisma.vendorUser.findUnique({ where: { email }, include: { vendor: true } });
  if (!vu || vu.deletedAt || vu.status !== 'Active' || !vu.vendor || vu.vendor.isActive === false) return;
  if (!MAIL.isActivated(vu)) return;
  if (await MAIL.forgotCountLastHour(vu.id) >= MAIL.FORGOT_MAX_PER_HOUR()) {
    await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Password reset request limited', status: 'too many requests this hour: no email sent' });
    return;
  }
  const claim = await MAIL.claimAttempt({ vu, kind: 'reset', toEmail: vu.email, actor: null, via: 'vendor' }, null);
  if (claim.duplicate) return;
  const hours = MAIL.FORGOT_HOURS();
  const link = await INVITE.createLink(vu.id, 'reset', null, prisma, { hours });
  await MAIL.patchRow(claim.row.id, { tokenId: link.id, linkExpiresAt: link.expiresAt.toISOString() });
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Password reset requested', status: 'forgot password' });
  await logAudit({ action: 'Vendor asked for a password reset', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, toValue: vu.vendor.name });
  const out = await MAIL.deliver(claim.row, { vu, vendor: vu.vendor, link: link.link, expiresAt: link.expiresAt, hours });
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: out.ok ? 'Password reset email accepted by the mail server' : 'Password reset email failed', status: out.ok ? (out.testMode ? 'test mode: not really sent' : 'accepted') : String(out.reason || out.status).slice(0, 240) });
}

router.post('/forgot-password', forgotLimit, (req, res) => {
  const email = VP.normEmail(req.body && req.body.email);
  res.json(FORGOT_SAME);
  if (!VP.EMAIL_RE.test(email) || email.length > 160) return;
  setImmediate(() => { processForgot(req, email).catch((e) => console.error('[vendor-portal] forgot-password:', e && e.message)); });
});

// ---- CONFIRM A NEW EMAIL ADDRESS (public, 2026-10-19) -----------------------------------------------------------
// Admin changed the email of an ACTIVE vendor: the NEW address got a link. Only when the vendor opens it does the login ID change;
// until then the old email keeps working. Single use, 24 hours, only the sha256 is stored, every refusal reads the same.
const BAD_VERIFY = 'This link is not valid or has expired. Ask your contact at the company to send a new one.';
const verifyLimit = rateLimit({ bucket: 'vendor-verify', max: Number(process.env.VENDOR_VERIFY_IP_MAX || 20), windowMs: 15 * 60000 });
async function findChange(token) {
  const t = String(token || '');
  if (t.length < 20 || t.length > 200) return null;
  await MAIL.ensure();
  const h = MAIL.sha(t);
  const row = await DBX.one('SELECT * FROM "VendorEmailChange" WHERE "tokenHash" = ?', [h]);
  if (!row || !INVITE.safeEqual(h, row.tokenHash) || row.status !== 'pending' || new Date(row.expiresAt).getTime() <= Date.now()) return null;
  const vu = await prisma.vendorUser.findUnique({ where: { id: row.vendorUserId }, include: { vendor: true } });
  if (!vu || vu.status !== 'Active' || vu.deletedAt || !vu.vendor || vu.vendor.isActive === false || vu.email !== row.oldEmail) return null;
  return { row, vu };
}
router.get('/email/verify/:token', verifyLimit, async (req, res) => {
  const f = await findChange(req.params.token);
  if (!f) return res.status(404).json({ error: BAD_VERIFY });
  return res.json({ valid: true, name: f.vu.name, vendorName: f.vu.vendor.name, currentEmail: MAIL.maskEmail(f.row.oldEmail), newEmail: f.row.newEmail, expiresAt: f.row.expiresAt });
});
router.post('/email/verify/confirm', ipLimit, verifyLimit, async (req, res) => {
  const f = await findChange(req.body && req.body.token);
  if (!f) return res.status(400).json({ error: BAD_VERIFY, linkProblem: true });
  const { row, vu } = f;
  // (A staff login on the same email is fine: only another VENDOR login blocks it.)
  const other = await prisma.vendorUser.findUnique({ where: { email: row.newEmail } });
  if (other && other.id !== vu.id) {
    await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Email confirmation failed', field: 'email', newValue: row.newEmail, status: 'the address is now used by another login' });
    await DBX.run('UPDATE "VendorEmailChange" SET "status" = \'cancelled\', "closedAt" = ? WHERE "id" = ?', [new Date().toISOString(), row.id]);
    return res.status(409).json({ error: 'This email is now used by another login, so it cannot be used. Ask your contact at the company for help.' });
  }
  const meta = VC.requestMeta(req);
  // Burn the link first: only ONE request can win.
  const won = await DBX.run('UPDATE "VendorEmailChange" SET "status" = \'confirmed\', "confirmedAt" = ?, "confirmedIp" = ?, "closedAt" = ? WHERE "id" = ? AND "status" = \'pending\' AND "expiresAt" > ?',
    [new Date().toISOString(), meta.ip, new Date().toISOString(), row.id, new Date().toISOString()]);
  if (Number(won) !== 1) return res.status(400).json({ error: BAD_VERIFY, linkProblem: true });
  try {
    await prisma.vendorUser.update({ where: { id: vu.id }, data: { email: row.newEmail } });
  } catch (err) {
    if (err && err.code === 'P2002') return res.status(409).json({ error: 'This email is now used by another login, so it cannot be used. Ask your contact at the company for help.' });
    throw err;
  }
  await VA.revokeSessions(vu.id, 'email changed');
  await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: 'Email change confirmed by the vendor', field: 'email', oldValue: row.oldEmail, newValue: row.newEmail });
  await logAudit({ action: 'Vendor confirmed a new email', entity: 'VendorUser', entityId: vu.id, actorName: `Vendor: ${vu.name}`, fromValue: row.oldEmail, toValue: row.newEmail });
  // The PREVIOUS address is told (a security notice, no link): if the change was not expected, someone can react. Recorded like every email.
  setImmediate(async () => {
    try {
      const claim = await MAIL.claimAttempt({ vu: { ...vu, email: row.oldEmail }, kind: 'notice', toEmail: row.oldEmail, actor: null, via: 'system' }, null);
      if (claim.duplicate) return;
      const out = await MAIL.deliver(claim.row, { vu: { ...vu, email: row.oldEmail }, vendor: vu.vendor, link: null, expiresAt: new Date(), hours: 0, newEmail: row.newEmail });
      await event(req, { vendorId: vu.vendorId, vendorUserId: vu.id, actorName: vu.name, action: out.ok ? 'Email change notice accepted by the mail server' : 'Email change notice failed', newValue: row.oldEmail, status: out.ok ? (out.testMode ? 'test mode: not really sent' : 'accepted') : String(out.reason || '').slice(0, 240) });
    } catch (e) { console.error('[vendor-portal] email change notice:', e && e.message); }
  });
  return res.json({ ok: true, email: row.newEmail, message: `Done. Your login ID is now ${row.newEmail}. Sign in with it and your usual password.` });
});

// ---- profile (read only: Admin keeps the vendor record) ----------------------
router.get('/profile', vendorOnly, async (req, res) => {
  const v = await prisma.officeVendor.findUnique({ where: { id: req.vendor.vendorId } });
  if (!v) return res.status(403).json({ error: 'Forbidden.' });
  return res.json({
    vendor: {
      vendorCode: v.vendorCode || null, name: v.name, companyName: v.companyName || null, contactPerson: v.contactPerson || null, email: v.email || null,
      phone: v.phone || null, address: v.address || null, gstin: v.gstin || null, pan: v.pan || null, category: v.category || null, paymentTerms: v.paymentTerms || null,
    },
    login: { name: req.vendor.name, email: req.vendor.email, lastLoginAt: req.vendor.row.lastLoginAt || null },
    note: 'To change these details, ask your contact at the company.',
  });
});

// ---- invoices + payments (own vendor only; vendorId comes from the session) -----
router.get('/invoices', vendorOnly, async (req, res) => {
  const out = await INVOICES.listVendorInvoices(req.vendor.vendorId, { forVendor: true });
  const f = str((req.query || {}).status);
  const s = str((req.query || {}).q).toLowerCase();
  let rows = out.rows;
  if (f === 'paid') rows = rows.filter((r) => r.paid);
  else if (f === 'unpaid') rows = rows.filter((r) => !r.paid && !['REJECTED', 'WITHDRAWN'].includes(r.status));
  if (s) rows = rows.filter((r) => [r.billNumber, r.billCode, r.description, r.assetCode, r.statusText].some((x) => String(x || '').toLowerCase().includes(s)));
  return res.json({ rows, summary: out.summary, total: out.rows.length });
});

// ---- documents shared with this vendor ---------------------------------------
// ---- what the company paid this vendor, from the bank statement (founder 2026-10-28; every kind of vendor) ----
router.get('/bank-payments', vendorOnly, async (req, res) => {
  const r = await require('../utils/vendorBankPayments').view(req.vendor.vendorId, req.query || {}); // eslint-disable-line global-require
  // the bank line's own id never leaves the server: the screen gets a row number
  res.json({ ...r, rows: r.rows.map(({ id, ...x }, i) => ({ key: i + 1, ...x })) });
});

router.get('/documents', vendorOnly, async (req, res) => {
  const docs = await prisma.vendorSharedDocument.findMany({ where: { vendorId: req.vendor.vendorId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  return res.json({ rows: docs.map((d) => ({ id: d.id, title: d.title, docType: d.docType, name: d.name, size: d.size, note: d.note, createdAt: d.createdAt })) });
});

// ---- signed, expiring downloads ----------------------------------------------
// kind: shared (a document shared with the vendor) | bill (their bill file) |
// supporting (a supporting file of their bill, with index) | asset-doc.
async function resolveOwnedFile(vendor, kind, id, idx) {
  if (kind === 'shared') {
    const d = await prisma.vendorSharedDocument.findFirst({ where: { id: String(id || ''), vendorId: vendor.vendorId, revokedAt: null } });
    return d ? { file: d.file, mime: d.mime, name: d.name, doc: d } : null;
  }
  if (kind === 'bill' || kind === 'supporting') {
    const b = await prisma.vendorBillSubmission.findFirst({ where: { id: String(id || ''), vendorId: vendor.vendorId } });
    if (!b) return null;
    if (kind === 'bill') return b.documentFile ? { file: b.documentFile, mime: b.documentMime, name: b.documentName, assetId: b.assetId, billId: b.id } : null;
    const sup = VP.parseDocs(b.supportingDocs)[Number(idx)];
    return sup ? { file: sup.file, mime: sup.mime, name: sup.name, assetId: b.assetId, billId: b.id } : null;
  }
  if (kind === 'module-bill') {
    // a bill / invoice the vendor sent from the portal (VendorModuleBill) - looked up only inside this vendor's own rows
    const b = await DBX.one('SELECT "documentFile","documentMime","documentName","id" FROM "VendorModuleBill" WHERE "id" = ? AND "vendorId" = ?', [String(id || ''), vendor.vendorId]);
    return b && b.documentFile ? { file: b.documentFile, mime: b.documentMime, name: b.documentName } : null;
  }
  if (kind === 'repair-invoice') {
    // the invoice file of a repair in this vendor's own set (Assets Vendor Portal)
    return AVP.ownedRepairInvoice(vendor, id);
  }
  if (kind === 'repair-proof') {
    // a proof / earlier invoice file of a repair in this (Assets) vendor's own set - utils/assetRepairWork.js (Stage C)
    return require('../utils/assetRepairWork').ownedProofFile(vendor.vendorId, await AVP.visibleRepairIds(vendor), id); // eslint-disable-line global-require
  }
  if (kind === 'bill-upload') {
    // a file of a repair bill this (Assets) vendor uploaded: id = "<uploadId>:<fileId>" - utils/billUploads.js, the vendor's own uploads only
    return require('../utils/billUploads').ownedFile(vendor, id); // eslint-disable-line global-require
  }
  if (kind === 'po-challan') {
    // the delivery challan of an order placed with this vendor
    const o = await DBX.one('SELECT "challanFile","challanMime","challanName" FROM "IdCardOrder" WHERE "id" = ? AND "vendorId" = ?', [String(id || ''), vendor.vendorId]);
    return o && o.challanFile ? { file: o.challanFile, mime: o.challanMime, name: o.challanName } : null;
  }
  if (kind === 'airtel-bill') {
    // the bill copy of an Airtel bill in this (Airtel Bills) vendor's own set - utils/airtelBillsPortal.js
    return require('../utils/airtelBillsPortal').ownedBillFile(vendor, id); // eslint-disable-line global-require
  }
  if (kind === 'asset-doc') {
    const d = await prisma.assetDocument.findUnique({ where: { id: String(id || '') } });
    if (!d) return null;
    const where = await VA.vendorAssetWhere(vendor);
    const a = await prisma.asset.findFirst({ where: { AND: [{ id: d.assetId }, where] }, select: { id: true } });
    if (!a || !(d.visibleToVendor || d.vendorId === vendor.vendorId)) return null;
    return { file: d.file, mime: d.mime, name: d.name, assetId: d.assetId };
  }
  return null;
}

router.post('/download-link', vendorOnly, async (req, res) => {
  const b = req.body || {};
  const kind = str(b.kind);
  // An asset vendor's files are the repair invoices and the order documents; the finance portal's bill files are not its business.
  const myKind = await KIND.kindOfRow({ ...req.vendor.row, vendorId: req.vendor.vendorId });
  const KINDS_OF = { assets: ['repair-invoice', 'repair-proof', 'bill-upload', 'po-challan', 'shared'], idcards: ['po-challan'], telecom: ['airtel-bill'] };
  if (KINDS_OF[myKind] ? !KINDS_OF[myKind].includes(kind) : (kind === 'repair-invoice' || kind === 'airtel-bill' || kind === 'bill-upload')) {
    return res.status(403).json({ error: 'Forbidden. This file is not yours.' });
  }
  const f = await resolveOwnedFile(req.vendor, kind, b.id, b.index);
  if (!f) return res.status(403).json({ error: 'Forbidden. This file is not yours.' });
  const { token, expiresAt } = SIGNED.sign({ k: kind, id: String(b.id), i: kind === 'supporting' ? Number(b.index) : undefined, vid: req.vendor.vendorId, vuid: req.vendor.userId, sid: req.vendor.sessionId });
  return res.json({ url: `/api/vendor-portal/files/${token}`, expiresAt, expiresInSeconds: SIGNED.TTL_SECONDS, name: f.name });
});

// No Authorization header here (a browser tab opening the link cannot send one),
// so EVERY check is repeated: signature + expiry, the session is still alive,
// the login and vendor are still active, and the file still belongs to that vendor.
router.get('/files/:token', ipLimit, async (req, res) => {
  const c = SIGNED.verify(req.params.token);
  const gone = () => res.status(403).json({ error: 'This download link has expired or is not valid. Open the list again and press the file once more.' });
  if (!c) return gone();
  const vendor = await VA.vendorForSession(c.sid, c.vuid);
  if (!vendor || vendor.vendorId !== c.vid) return gone();
  const f = await resolveOwnedFile(vendor, c.k, c.id, c.i);
  if (!f) return gone();
  await VP.auditReq(req, {
    assetId: f.assetId || null, vendorId: vendor.vendorId, vendorUserId: vendor.userId, actorName: vendor.name, role: 'Vendor',
    action: 'Document downloaded', documentName: f.name, billId: f.billId || null, status: `signed link (${c.k})`,
  });
  return sendStored(res, f.file, f.mime, f.name);
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
  const master = await prisma.officeVendor.findUnique({ where: { id: req.vendor.vendorId } });
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
          vendorNameSnap: master ? master.name : null, vendorGstinSnap: master ? master.gstin : null, vendorAddressSnap: master ? master.address : null,
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

// Accounts reviewers (utils/vendorConfig.js billReviewers: the Admin's table of who gets each reminder; default:
// Accountant role, resolved now): an in-app notice each, plus an email when
// the "Vendor emails" switch is on. Never throws.
async function notifyReviewers(bill, vendor, parent) {
  try {
    const list = await VC.billReviewers('vendorBill');
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

// The module screens (ID card orders, SIM, monthly bills, invoices, office, expenses, payments).
router.use(require('./assetBillUploads')); // upload a repair bill (AI reading): before assetVendorPortal, whose last line refuses every other /asset-portal path
router.use(require('./assetVendorPortal'));
router.use(require('./idCardVendorPortal'));
router.use(require('./airtelBillsPortal'));
router.use(require('./vendorPortalRecords'));
router.use(require('./vendorModulePortal'));
router.use(require('./vendorIo')); // Export + Import for every kind of vendor (2026-10-19)

// Anything else under /api/vendor-portal is not part of the portal.
router.use((req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
