// ---------------------------------------------------------------------------
// B7 — PARTNERS, the staff side: /api/partners (2026-10-06).
//   * the partner master + partner logins (Administration → Company Setup →
//     Partners): Super Admin / Admin, or an Accounts approver
//   * "Share with partners" on a job (Super Admin / Admin / STL / TL, job in scope)
//   * the partner's submissions as the ATS sees them (scoped like the job)
//   * ATS Reports → Partners (per partner: submitted / duplicates / interviews /
//     selected / joined / dropped / payout total / cost per joining)
// A partner token never gets here: the global guard answers 403 first and
// requireAuth cannot verify it.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePerm, requireInternal, roleForProduct } = require('../utils/permissions');
const { requirementWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const PA = require('../utils/partnerAuth');
const PC = require('../utils/partnerConfig');
const P = require('../utils/partners');

const router = express.Router();
router.use(requireAuth);
router.use(requireInternal);
router.use((req, res, next) => (P.ready() ? next() : res.status(503).json(P.NOT_READY)));
const office = () => require('./office'); // eslint-disable-line global-require
const { str, R } = P;
const actorOf = (req) => req.user.name || req.user.email || 'Admin';
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
async function mayManage(user) {
  if (!user || user.viewAs) return false;
  if (isAdmin(user)) return true;
  try { return !!(await office().isApprover(user)); } catch { return false; }
}
const manageOnly = async (req, res, next) => ((await mayManage(req.user)) ? next() : res.status(403).json({ error: 'Only Admin or an Accounts approver can manage partners.' }));
const SHARE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STL', 'TL'];
const maySharer = (u) => !u.viewAs && SHARE_ROLES.includes(roleForProduct(u, 'ats') || u.role);

function generatePassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const D = '23456789';
  const S = '!#$%&*@';
  const all = A + D + S;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(A.slice(0, 24)), pick(A.slice(24)), pick(D), pick(S), ...Array.from({ length: 8 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
const tempExpiry = () => new Date(Date.now() + PC.CFG.tempPasswordDays * 86400000);

// ---- options ------------------------------------------------------------------
router.get('/options', async (req, res) => {
  const depts = await prisma.department.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } });
  res.json({
    departments: depts.map((d) => d.name),
    types: P.TYPES, feeTypes: P.FEE_TYPES, tdsSections: P.TDS_SECTIONS, tdsDefaults: P.TDS_DEFAULT, gstPercent: P.GST_PERCENT,
    canManage: await mayManage(req.user), canShare: maySharer(req.user), isAdmin: isAdmin(req.user),
  });
});

// ---- the master ------------------------------------------------------------------
function partnerView(p, extra = {}) {
  return {
    id: p.id, code: p.code, type: p.type, name: p.name, contactName: p.contactName, email: p.email, phone: p.phone, gstin: p.gstin, pan: p.pan,
    gstRegistered: !!p.gstRegistered, tdsSection: p.tdsSection, tdsPercent: p.tdsPercent, feeType: p.feeType, feePercent: p.feePercent, feeFixed: p.feeFixed,
    feeText: p.feeType === 'FIXED' ? `₹${Number(p.feeFixed || 0).toLocaleString('en-IN')} per joining` : `${p.feePercent == null ? '—' : p.feePercent}% of CTC`,
    paymentTermsDays: p.paymentTermsDays, guaranteeDays: p.guaranteeDays, ownershipDays: p.ownershipDays,
    departments: P.csv(p.departments), specialisations: P.csv(p.specialisations), showClientName: !!p.showClientName,
    agreement: p.agreementFile ? { name: p.agreementName, size: p.agreementSize, from: p.agreementFrom, to: p.agreementTo } : (p.agreementFrom || p.agreementTo ? { name: null, from: p.agreementFrom, to: p.agreementTo } : null),
    agreementExpired: !!(p.agreementTo && p.agreementTo < P.todayIst()),
    status: p.status, notes: p.notes, createdAt: p.createdAt, updatedAt: p.updatedAt, ...extra,
  };
}
async function statsFor(ids) {
  const out = new Map(ids.map((id) => [id, { logins: 0, shares: 0, submitted: 0, joined: 0, payout: 0 }]));
  if (!ids.length) return out;
  const [logins, shares, subs, joined, pays] = await Promise.all([
    prisma.partnerUser.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
    prisma.partnerJobShare.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids }, revokedAt: null }, _count: { _all: true } }),
    prisma.partnerSubmission.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids } }, _count: { _all: true } }),
    prisma.partnerSubmission.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids }, status: 'Joined' }, _count: { _all: true } }),
    prisma.partnerPayout.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids }, status: { in: ['Approved', 'Paid'] } }, _sum: { net: true } }),
  ]);
  logins.forEach((r) => { out.get(r.partnerId).logins = r._count._all; });
  shares.forEach((r) => { out.get(r.partnerId).shares = r._count._all; });
  subs.forEach((r) => { out.get(r.partnerId).submitted = r._count._all; });
  joined.forEach((r) => { out.get(r.partnerId).joined = r._count._all; });
  pays.forEach((r) => { out.get(r.partnerId).payout = R(r._sum.net || 0); });
  return out;
}
router.get('/', manageOnly, async (req, res) => {
  const list = await prisma.partner.findMany({ orderBy: [{ status: 'asc' }, { name: 'asc' }] });
  const st = await statsFor(list.map((p) => p.id));
  res.json({ rows: list.map((p) => partnerView(p, st.get(p.id))), settings: await PC.loadSettings() });
});

function readPartnerBody(b, cur = {}) {
  const errs = (msg, field) => ({ error: msg, field });
  const type = P.TYPES.includes(b.type) ? b.type : (cur.type || 'Agency');
  const name = str(b.name !== undefined ? b.name : cur.name).replace(/\s+/g, ' ').slice(0, 160);
  if (!name) return errs('Enter the partner name.', 'name');
  const email = b.email !== undefined ? P.normEmail(b.email).slice(0, 160) : (cur.email || null);
  if (email && !P.EMAIL_RE.test(email)) return errs('Enter a proper email address.', 'email');
  const gstin = b.gstin !== undefined ? str(b.gstin).toUpperCase().slice(0, 15) : (cur.gstin || null);
  if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) return errs('A GSTIN has 15 characters, like 36ABCDE1234F1Z5.', 'gstin');
  const pan = b.pan !== undefined ? str(b.pan).toUpperCase().slice(0, 10) : (cur.pan || null);
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return errs('A PAN has 10 characters, like ABCDE1234F.', 'pan');
  const feeType = P.FEE_TYPES.includes(b.feeType) ? b.feeType : (cur.feeType || 'PERCENT');
  const n = (v, d) => (v === undefined ? d : (v === '' || v === null ? null : Number(v)));
  const feePercent = n(b.feePercent, cur.feePercent == null ? null : cur.feePercent);
  const feeFixed = n(b.feeFixed, cur.feeFixed == null ? null : cur.feeFixed);
  if (feeType === 'PERCENT' && !(feePercent > 0 && feePercent <= 100)) return errs('Enter the fee as % of CTC (like 8.33).', 'feePercent');
  if (feeType === 'FIXED' && !(feeFixed > 0)) return errs('Enter the fixed fee per joining, like 25000.', 'feeFixed');
  const tdsSection = b.tdsSection !== undefined ? (P.TDS_SECTIONS.includes(b.tdsSection) ? b.tdsSection : null) : (cur.tdsSection || P.TDS_DEFAULT[type].section);
  let tdsPercent = n(b.tdsPercent, cur.tdsPercent == null ? P.TDS_DEFAULT[type].percent : cur.tdsPercent);
  if (tdsSection === 'None' || !tdsSection) tdsPercent = 0;
  if (!(tdsPercent >= 0 && tdsPercent <= 30)) return errs('TDS % must be between 0 and 30.', 'tdsPercent');
  const ints = {};
  for (const [k, d, max] of [['paymentTermsDays', 30, 365], ['guaranteeDays', 90, 365], ['ownershipDays', 365, 1095]]) {
    const v = b[k] === undefined ? (cur[k] == null ? d : cur[k]) : Number(b[k]);
    if (!Number.isInteger(v) || v < 0 || v > max) return errs(`${k === 'paymentTermsDays' ? 'Payment terms' : k === 'guaranteeDays' ? 'Guarantee' : 'Candidate ownership'} must be whole days (0–${max}).`, k);
    ints[k] = v;
  }
  const list = (v, curV) => (v === undefined ? (curV || null) : ([...new Set((Array.isArray(v) ? v : String(v).split(',')).map((x) => str(x)).filter(Boolean))].join(', ') || null));
  const dates = {};
  for (const k of ['agreementFrom', 'agreementTo']) {
    const v = b[k] === undefined ? (cur[k] || null) : (str(b[k]) || null);
    if (v && !P.isRealDay(v)) return errs('Pick a proper date.', k);
    dates[k] = v;
  }
  if (dates.agreementFrom && dates.agreementTo && dates.agreementTo < dates.agreementFrom) return errs('The agreement end date is before its start.', 'agreementTo');
  return {
    data: {
      type, name, email,
      contactName: b.contactName !== undefined ? (str(b.contactName).slice(0, 120) || null) : (cur.contactName || null),
      phone: b.phone !== undefined ? (str(b.phone).slice(0, 40) || null) : (cur.phone || null),
      gstin, pan, gstRegistered: b.gstRegistered !== undefined ? b.gstRegistered === true : (!!cur.gstRegistered || !!(gstin && !cur.id)),
      tdsSection, tdsPercent, feeType, feePercent: feeType === 'PERCENT' ? feePercent : feePercent, feeFixed,
      ...ints,
      departments: list(b.departments, cur.departments), specialisations: list(b.specialisations, cur.specialisations),
      showClientName: b.showClientName !== undefined ? b.showClientName === true : !!cur.showClientName,
      ...dates,
      notes: b.notes !== undefined ? (str(b.notes).slice(0, 2000) || null) : (cur.notes || null),
    },
  };
}
const summary = (d) => `${d.type} · ${d.name} · fee ${d.feeType === 'FIXED' ? `₹${d.feeFixed} fixed` : `${d.feePercent}% of CTC`} · GST ${d.gstRegistered ? 'yes' : 'no'} · TDS ${d.tdsSection || 'None'} ${d.tdsPercent}% · pay in ${d.paymentTermsDays} days · guarantee ${d.guaranteeDays} days · owns ${d.ownershipDays} days · depts ${d.departments || 'any'} · client name ${d.showClientName ? 'shown' : 'hidden'}`;

router.post('/', manageOnly, async (req, res) => {
  const got = readPartnerBody(req.body || {});
  if (got.error) return res.status(400).json(got);
  const p = await P.createWithCode('partner', 'code', P.nextPartnerCode, { ...got.data, status: 'Active', createdById: req.user.id, createdByName: actorOf(req) });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner created', entity: 'Partner', entityId: p.id, fromValue: '— (new)', toValue: summary(p).slice(0, 900) });
  return res.status(201).json({ partner: partnerView(p, { logins: 0, shares: 0, submitted: 0, joined: 0, payout: 0 }), message: `${p.name} added (${p.code}). Now add a login for them.` });
});

router.patch('/:id', manageOnly, async (req, res) => {
  const p = await prisma.partner.findUnique({ where: { id: String(req.params.id) } });
  if (!p) return res.status(404).json({ error: 'Partner not found.' });
  const got = readPartnerBody(req.body || {}, p);
  if (got.error) return res.status(400).json(got);
  const updated = await prisma.partner.update({ where: { id: p.id }, data: got.data });
  const before = summary(p); const after = summary(updated);
  if (before !== after) await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner edited', entity: 'Partner', entityId: p.id, fromValue: before.slice(0, 900), toValue: after.slice(0, 900) });
  const st = await statsFor([p.id]);
  return res.json({ partner: partnerView(updated, st.get(p.id)), message: before !== after ? 'Saved.' : 'Nothing changed.' });
});

async function setStatus(req, res, status) {
  const p = await prisma.partner.findUnique({ where: { id: String(req.params.id) } });
  if (!p) return res.status(404).json({ error: 'Partner not found.' });
  const updated = await prisma.partner.update({ where: { id: p.id }, data: { status } });
  if (status === 'Paused') await PA.revokePartnerSessions(p.id, 'partner paused');
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: status === 'Paused' ? 'Partner paused' : 'Partner activated', entity: 'Partner', entityId: p.id, fromValue: p.status, toValue: status });
  const st = await statsFor([p.id]);
  return res.json({ partner: partnerView(updated, st.get(p.id)), message: status === 'Paused' ? 'Paused. Their logins are signed out and see nothing until you activate them again.' : 'Active again.' });
}
router.post('/:id/pause', manageOnly, (req, res) => setStatus(req, res, 'Paused'));
router.post('/:id/activate', manageOnly, (req, res) => setStatus(req, res, 'Active'));

const FILE_MAX = 10 * 1024 * 1024;
router.post('/:id/agreement', manageOnly, async (req, res) => {
  const p = await prisma.partner.findUnique({ where: { id: String(req.params.id) } });
  if (!p) return res.status(404).json({ error: 'Partner not found.' });
  let form;
  try { form = await attachments.parseMultipart(req, { maxBytes: FILE_MAX }); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' }); }
  if (!form.file) return res.status(400).json({ error: 'Choose the agreement file (PDF or photo).' });
  let st;
  try { st = attachments.store(form.file, { maxBytes: FILE_MAX }); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Only a PDF or a photo can be uploaded.' }); }
  const from = str(form.fields.agreementFrom); const to = str(form.fields.agreementTo);
  if (p.agreementFile) attachments.remove(p.agreementFile);
  const updated = await prisma.partner.update({
    where: { id: p.id },
    data: { agreementFile: st.billFile, agreementName: st.billName, agreementMime: st.billMime, agreementSize: st.billSize, ...(P.isRealDay(from) ? { agreementFrom: from } : {}), ...(P.isRealDay(to) ? { agreementTo: to } : {}) },
  });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner agreement uploaded', entity: 'Partner', entityId: p.id, toValue: `${st.billName}${updated.agreementFrom ? ` · ${updated.agreementFrom} → ${updated.agreementTo || 'open'}` : ''}` });
  const stt = await statsFor([p.id]);
  return res.status(201).json({ partner: partnerView(updated, stt.get(p.id)), message: 'Agreement saved.' });
});
router.get('/:id/agreement/file', manageOnly, async (req, res) => {
  const p = await prisma.partner.findUnique({ where: { id: String(req.params.id) } });
  if (!p || !p.agreementFile) return res.status(404).json({ error: 'No agreement file.' });
  const full = attachments.resolveStored(p.agreementFile);
  if (!full) return res.status(404).json({ error: 'The file is no longer on the server.' });
  res.setHeader('Content-Type', attachments.ALLOWED[p.agreementMime] ? p.agreementMime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(p.agreementName)}"`);
  return res.sendFile(full);
});

// ---- logins -------------------------------------------------------------------------
function loginView(pu) {
  const locked = !!(pu.lockedUntil && new Date(pu.lockedUntil) > new Date());
  const tempExpired = !!(pu.mustChangePassword && pu.tempPasswordExpiresAt && new Date(pu.tempPasswordExpiresAt) < new Date());
  return {
    id: pu.id, partnerId: pu.partnerId, partnerName: pu.partner ? pu.partner.name : '', name: pu.name, email: pu.email, status: pu.status,
    statusText: pu.status !== 'Active' ? 'Switched off' : (locked ? 'Locked' : (tempExpired ? 'Temporary password expired' : 'Active')),
    locked, lastLoginAt: pu.lastLoginAt, lastLoginIp: pu.lastLoginIp, mustChangePassword: pu.mustChangePassword, createdAt: pu.createdAt,
  };
}
router.get('/logins', manageOnly, async (req, res) => {
  const list = await prisma.partnerUser.findMany({ where: { deletedAt: null }, include: { partner: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }] });
  res.json(list.map(loginView));
});
async function emailProblem(email, exceptId) {
  if (!P.EMAIL_RE.test(email) || email.length > 160) return 'Enter a proper email address.';
  const [pu, staff] = await Promise.all([prisma.partnerUser.findUnique({ where: { email } }), prisma.user.findFirst({ where: { email } })]);
  if (pu && pu.id !== exceptId) return 'Another partner login already uses this email.';
  if (staff) return 'This email is a staff login. A partner needs its own email.';
  return null;
}
router.post('/logins', manageOnly, async (req, res) => {
  const b = req.body || {};
  const partner = b.partnerId ? await prisma.partner.findUnique({ where: { id: String(b.partnerId) } }) : null;
  if (!partner) return res.status(400).json({ error: 'Pick the partner.', field: 'partnerId' });
  const name = str(b.name).replace(/\s+/g, ' ');
  if (!name || name.length > 120) return res.status(400).json({ error: 'Enter the contact name.', field: 'name' });
  const email = P.normEmail(b.email);
  const ep = await emailProblem(email);
  if (ep) return res.status(400).json({ error: ep, field: 'email' });
  const auto = !!b.autoPassword || !b.password;
  const password = auto ? generatePassword() : String(b.password || '');
  if (!auto) { const weak = PC.partnerPasswordProblem(password, { email, name }); if (weak) return res.status(400).json({ error: weak, field: 'password' }); }
  const pu = await prisma.partnerUser.create({
    data: { partnerId: partner.id, name, email, passwordHash: await bcrypt.hash(password, 10), status: 'Active', mustChangePassword: true, tempPasswordExpiresAt: tempExpiry(), createdById: req.user.id },
    include: { partner: { select: { name: true } } },
  });
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner login created', entity: 'PartnerUser', entityId: pu.id, fromValue: '— (new)', toValue: `${partner.name} · ${name} · ${email}` });
  return res.status(201).json({ login: loginView(pu), ...(auto ? { tempPassword: password } : {}), message: 'Partner login created. They must set a new password the first time they sign in at /partner-login.' });
});
router.patch('/logins/:id', manageOnly, async (req, res) => {
  const b = req.body || {};
  const pu = await prisma.partnerUser.findUnique({ where: { id: String(req.params.id) }, include: { partner: { select: { name: true } } } });
  if (!pu || pu.deletedAt) return res.status(404).json({ error: 'Partner login not found.' });
  const data = {}; const changes = [];
  if (b.name !== undefined) { const name = str(b.name).replace(/\s+/g, ' '); if (!name || name.length > 120) return res.status(400).json({ error: 'Enter the contact name.', field: 'name' }); if (name !== pu.name) { data.name = name; changes.push(`name ${pu.name} → ${name}`); } }
  if (b.email !== undefined) { const email = P.normEmail(b.email); if (email !== pu.email) { const ep = await emailProblem(email, pu.id); if (ep) return res.status(400).json({ error: ep, field: 'email' }); data.email = email; changes.push(`email ${pu.email} → ${email}`); } }
  if (b.status !== undefined) { const s = b.status === 'Inactive' ? 'Inactive' : 'Active'; if (s !== pu.status) { data.status = s; changes.push(`status ${pu.status} → ${s}`); } }
  if (Object.keys(data).length) await prisma.partnerUser.update({ where: { id: pu.id }, data });
  if (data.status === 'Inactive' || data.email) await PA.revokeSessions(pu.id, data.status === 'Inactive' ? 'deactivated' : 'email changed');
  if (changes.length) await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner login edited', entity: 'PartnerUser', entityId: pu.id, toValue: changes.join(' · ').slice(0, 900) });
  const fresh = await prisma.partnerUser.findUnique({ where: { id: pu.id }, include: { partner: { select: { name: true } } } });
  return res.json({ login: loginView(fresh), message: changes.length ? 'Saved.' : 'Nothing changed.' });
});
async function setLoginStatus(req, res, status) {
  const pu = await prisma.partnerUser.findUnique({ where: { id: String(req.params.id) }, include: { partner: { select: { name: true } } } });
  if (!pu || pu.deletedAt) return res.status(404).json({ error: 'Partner login not found.' });
  const fresh = await prisma.partnerUser.update({ where: { id: pu.id }, data: { status }, include: { partner: { select: { name: true } } } });
  if (status === 'Inactive') await PA.revokeSessions(pu.id, 'deactivated');
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: status === 'Inactive' ? 'Partner login switched off' : 'Partner login switched on', entity: 'PartnerUser', entityId: pu.id, fromValue: pu.status, toValue: status });
  return res.json({ login: loginView(fresh), message: status === 'Inactive' ? 'Switched off. They are signed out and cannot sign in.' : 'Switched on.' });
}
router.post('/logins/:id/deactivate', manageOnly, (req, res) => setLoginStatus(req, res, 'Inactive'));
router.post('/logins/:id/activate', manageOnly, (req, res) => setLoginStatus(req, res, 'Active'));
// Reset — the ONLY way a partner gets back in after forgetting the password (Admin / approver only).
router.post('/logins/:id/reset-password', manageOnly, async (req, res) => {
  const pu = await prisma.partnerUser.findUnique({ where: { id: String(req.params.id) } });
  if (!pu || pu.deletedAt) return res.status(404).json({ error: 'Partner login not found.' });
  const password = generatePassword();
  await prisma.partnerUser.update({
    where: { id: pu.id },
    data: { passwordHash: await bcrypt.hash(password, 10), passwordHistory: PC.pushHistory(pu.passwordHistory, pu.passwordHash), mustChangePassword: true, tempPasswordExpiresAt: tempExpiry(), failedLoginAttempts: 0, lockedUntil: null },
  });
  await PA.revokeSessions(pu.id, 'password reset');
  await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner password reset', entity: 'PartnerUser', entityId: pu.id, toValue: 'Reset (change required at next sign-in)' });
  return res.json({ tempPassword: password, message: 'Password reset. They must set a new one when they sign in.' });
});

// ---- settings (the "Partner emails" switch) ------------------------------------------
router.get('/settings', manageOnly, async (req, res) => res.json(await PC.loadSettings()));
router.put('/settings', manageOnly, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only Super Admin / Admin can change this switch.' });
  const before = await PC.loadSettings();
  const next = await PC.saveSettings(req.body || {}, req.user);
  if (before.emailsEnabled !== next.emailsEnabled) await logAudit({ userId: req.user.id, actorName: actorOf(req), action: 'Partner emails switch changed', entity: 'AppSetting', entityId: PC.SETTINGS_KEY, fromValue: before.emailsEnabled ? 'ON' : 'OFF', toValue: next.emailsEnabled ? 'ON' : 'OFF' });
  res.json({ ...next, message: next.emailsEnabled ? 'Partner emails ON — partners now get an email on each status change.' : 'Partner emails OFF — partners see notices only inside their portal.' });
});

// ---- share a job with partners --------------------------------------------------------
async function jobInScope(req, res) {
  const r = await prisma.requirement.findFirst({ where: { AND: [{ id: String(req.params.requirementId || '') }, requirementWhere(req.user)] }, include: { client: { select: { name: true } } } });
  if (!r) { res.status(403).json({ error: 'This job is not in your area.' }); return null; }
  return r;
}
router.get('/shares/job/:requirementId', async (req, res) => {
  const r = await jobInScope(req, res);
  if (!r) return undefined;
  const [partners, shares, subs] = await Promise.all([
    prisma.partner.findMany({ orderBy: { name: 'asc' } }),
    prisma.partnerJobShare.findMany({ where: { requirementId: r.id } }),
    prisma.partnerSubmission.groupBy({ by: ['partnerId'], where: { requirementId: r.id }, _count: { _all: true } }),
  ]);
  const sm = new Map(shares.map((s) => [s.partnerId, s]));
  const cm = new Map(subs.map((s) => [s.partnerId, s._count._all]));
  return res.json({
    canEdit: maySharer(req.user),
    jobDepartment: r.department || null,
    partners: partners.map((p) => {
      const s = sm.get(p.id);
      return {
        id: p.id, code: p.code, name: p.name, type: p.type, status: p.status, departments: P.csv(p.departments),
        eligible: p.status === 'Active' && P.partnerMayDepartment(p, r.department),
        shared: !!(s && !s.revokedAt), showClientName: s ? !!s.showClientName : !!p.showClientName, sharedAt: s && !s.revokedAt ? s.sharedAt : null, sharedByName: s && !s.revokedAt ? s.sharedByName : null,
        submissions: cm.get(p.id) || 0,
      };
    }),
  });
});
router.put('/shares/job/:requirementId', async (req, res) => {
  if (!maySharer(req.user)) return res.status(403).json({ error: 'Only Admin or a TL can share a job with partners.' });
  const r = await jobInScope(req, res);
  if (!r) return undefined;
  const want = Array.isArray(req.body && req.body.shares) ? req.body.shares : [];
  const ids = [...new Set(want.map((w) => String(w && w.partnerId || '')).filter(Boolean))];
  const partners = ids.length ? await prisma.partner.findMany({ where: { id: { in: ids } } }) : [];
  if (partners.length !== ids.length) return res.status(400).json({ error: 'One of the partners no longer exists. Open the list again.' });
  const bad = partners.filter((p) => p.status !== 'Active' || !P.partnerMayDepartment(p, r.department));
  if (bad.length) return res.status(400).json({ error: `These partners cannot take this job (paused, or not covering ${r.department || 'this department'}): ${bad.map((p) => p.name).join(', ')}.` });
  const current = await prisma.partnerJobShare.findMany({ where: { requirementId: r.id } });
  const cm = new Map(current.map((s) => [s.partnerId, s]));
  const added = []; const removed = []; const now = new Date();
  for (const w of want) {
    const pid = String(w.partnerId);
    const show = w.showClientName === true;
    const cur = cm.get(pid);
    if (!cur) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.partnerJobShare.create({ data: { partnerId: pid, requirementId: r.id, sharedById: req.user.id, sharedByName: actorOf(req), showClientName: show } });
      added.push(pid);
    } else if (cur.revokedAt || cur.showClientName !== show) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.partnerJobShare.update({ where: { id: cur.id }, data: { revokedAt: null, revokedByName: null, sharedById: req.user.id, sharedByName: actorOf(req), sharedAt: cur.revokedAt ? now : cur.sharedAt, showClientName: show } });
      if (cur.revokedAt) added.push(pid);
    }
  }
  for (const s of current) {
    if (!s.revokedAt && !ids.includes(s.partnerId)) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.partnerJobShare.update({ where: { id: s.id }, data: { revokedAt: now, revokedByName: actorOf(req) } });
      removed.push(s.partnerId);
    }
  }
  const nameOf = (id) => (partners.find((p) => p.id === id) || current.find((c) => c.partnerId === id) || {}).name || id;
  const pn = await prisma.partner.findMany({ where: { id: { in: [...added, ...removed] } }, select: { id: true, name: true } });
  const nm = new Map(pn.map((p) => [p.id, p.name]));
  if (added.length || removed.length) {
    await logAudit({
      userId: req.user.id, actorName: actorOf(req), action: 'Job shared with partners', entity: 'Requirement', entityId: r.id,
      fromValue: removed.length ? `removed: ${removed.map((id) => nm.get(id) || nameOf(id)).join(', ')}` : null,
      toValue: `${r.reqCode || ''} ${r.title} · now shared with ${ids.length} partner(s)${added.length ? ` · added: ${added.map((id) => nm.get(id) || nameOf(id)).join(', ')}` : ''}`,
    });
    for (const id of added) await P.noticePartner(id, { title: `New job shared with you: ${r.title}`, message: `${r.department || ''} ${r.location ? `· ${r.location}` : ''}. Open the Partner Portal to send candidates.`.trim(), email: true }); // eslint-disable-line no-await-in-loop
    for (const id of removed) await P.noticePartner(id, { title: `Job no longer open to you: ${r.title}`, message: 'Your earlier submissions keep their status.', email: false }); // eslint-disable-line no-await-in-loop
  }
  return res.json({ ok: true, shared: ids.length, added: added.length, removed: removed.length, message: added.length || removed.length ? `Saved. Shared with ${ids.length} partner(s).` : 'Nothing changed.' });
});

// ---- the submissions as the ATS sees them -------------------------------------------------
router.get('/submissions', async (req, res) => {
  const q = req.query || {};
  const where = {};
  if (str(q.requirementId)) where.requirementId = str(q.requirementId);
  if (str(q.partnerId)) where.partnerId = str(q.partnerId);
  if (str(q.status)) where.status = str(q.status);
  const reqIds = (await prisma.requirement.findMany({ where: { AND: [where.requirementId ? { id: where.requirementId } : {}, requirementWhere(req.user)] }, select: { id: true } })).map((r) => r.id);
  where.requirementId = { in: reqIds };
  const rows = await prisma.partnerSubmission.findMany({ where, include: { partner: { select: { name: true, type: true } } }, orderBy: { submittedAt: 'desc' }, take: 500 });
  res.json({
    rows: rows.map((s) => ({
      id: s.id, code: s.code, partnerName: s.partner.name, partnerType: s.partner.type, requirementId: s.requirementId, candidateId: s.candidateId, applicationId: s.applicationId,
      name: s.name, phone: s.phone, email: s.email, currentCtc: s.currentCtc, expectedCtc: s.expectedCtc, noticePeriod: s.noticePeriod, location: s.location, note: s.note,
      status: s.status, duplicateReason: s.duplicateReason, submittedAt: s.submittedAt, statusAt: s.statusAt,
    })),
  });
});

// ---- ATS Reports → Partners ------------------------------------------------------------------
const reportsOnly = requirePerm('ats', 'reports', 'ATS Reports', 'view');
async function reportRows(user, q) {
  const from = P.isRealDay(str(q.from)) ? new Date(`${str(q.from)}T00:00:00`) : null;
  const to = P.isRealDay(str(q.to)) ? new Date(new Date(`${str(q.to)}T00:00:00`).getTime() + 86400000) : null;
  const reqs = await prisma.requirement.findMany({ where: requirementWhere(user), select: { id: true, department: true, clientId: true, client: { select: { name: true } } } });
  const rm = new Map(reqs.map((r) => [r.id, r]));
  const subs = await prisma.partnerSubmission.findMany({
    where: { requirementId: { in: reqs.map((r) => r.id) }, ...(from || to ? { submittedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
    include: { partner: { select: { id: true, name: true, type: true, status: true } } },
  });
  const pays = await prisma.partnerPayout.findMany({ where: { status: { in: ['Approved', 'Paid'] } }, select: { partnerId: true, submissionId: true, net: true, fee: true } });
  const payBySub = new Map();
  pays.forEach((p) => { if (p.submissionId) payBySub.set(p.submissionId, R((payBySub.get(p.submissionId) || 0) + p.fee)); });
  const dept = (s) => (rm.get(s.requirementId) || {}).department || '—';
  const client = (s) => ((rm.get(s.requirementId) || {}).client || {}).name || '—';
  const pass = (s, skip) => (skip === 'department' || !str(q.department) || dept(s) === str(q.department))
    && (skip === 'partnerId' || !str(q.partnerId) || s.partnerId === str(q.partnerId))
    && (skip === 'clientId' || !str(q.clientId) || (rm.get(s.requirementId) || {}).clientId === str(q.clientId))
    && (skip === 'type' || !str(q.type) || s.partner.type === str(q.type));
  const facet = (key, labelOf, skip) => {
    const m = new Map();
    subs.filter((s) => pass(s, skip)).forEach((s) => { const k = key(s); if (!k || k === '—') return; const o = m.get(k) || { value: k, label: labelOf(s), count: 0 }; o.count += 1; m.set(k, o); });
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const list = subs.filter((s) => pass(s));
  const by = new Map();
  list.forEach((s) => {
    const k = s.partnerId;
    const o = by.get(k) || { partnerId: k, partner: s.partner.name, type: s.partner.type, status: s.partner.status, submitted: 0, duplicates: 0, screening: 0, interviews: 0, selected: 0, joined: 0, rejected: 0, dropped: 0, payout: 0 };
    o.submitted += 1;
    if (s.status === 'Duplicate') o.duplicates += 1;
    if (['Screening', 'Submitted'].includes(s.status)) o.screening += 1;
    if (s.status === 'Interview') o.interviews += 1;
    if (s.status === 'Selected') o.selected += 1;
    if (s.status === 'Joined') o.joined += 1;
    if (s.status === 'Rejected') o.rejected += 1;
    if (s.status === 'Dropped') o.dropped += 1;
    o.payout = R(o.payout + (payBySub.get(s.id) || 0));
    by.set(k, o);
  });
  const rows = [...by.values()].map((o) => ({
    ...o, accepted: o.submitted - o.duplicates, duplicatePct: o.submitted ? Math.round((o.duplicates / o.submitted) * 100) : 0,
    joinPct: o.submitted - o.duplicates ? Math.round((o.joined / (o.submitted - o.duplicates)) * 100) : 0,
    costPerJoining: o.joined ? R(o.payout / o.joined) : null,
  })).sort((a, b) => b.joined - a.joined || b.submitted - a.submitted);
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const totals = { partners: rows.length, submitted: sum('submitted'), duplicates: sum('duplicates'), interviews: sum('interviews'), selected: sum('selected'), joined: sum('joined'), dropped: sum('dropped'), rejected: sum('rejected'), payout: R(sum('payout')) };
  totals.costPerJoining = totals.joined ? R(totals.payout / totals.joined) : null;
  return {
    rows, totals,
    facets: {
      department: facet(dept, dept, 'department'),
      partnerId: facet((s) => s.partnerId, (s) => s.partner.name, 'partnerId'),
      clientId: facet((s) => (rm.get(s.requirementId) || {}).clientId, client, 'clientId'),
      type: facet((s) => s.partner.type, (s) => s.partner.type, 'type'),
    },
    dateBasis: 'Date range: the day the partner sent the candidate. Payout = fee before GST of approved / paid payouts for those submissions.',
  };
}
router.get('/report', reportsOnly, async (req, res) => res.json(await reportRows(req.user, req.query || {})));
router.post('/report/export.xlsx', reportsOnly, requirePerm('ats', 'reports', 'ATS Reports', 'export'), async (req, res) => {
  const d = await reportRows(req.user, req.body || {});
  const head = ['Partner', 'Type', 'Status', 'Submitted', 'Duplicates', 'Accepted', 'Screening', 'Interviews', 'Selected', 'Joined', 'Rejected', 'Dropped', 'Join %', 'Payout (fee before GST)', 'Cost per joining'];
  const aoa = [['Partner performance'], [d.dateBasis], [], head];
  d.rows.forEach((r) => aoa.push([r.partner, r.type, r.status, r.submitted, r.duplicates, r.accepted, r.screening, r.interviews, r.selected, r.joined, r.rejected, r.dropped, r.joinPct, r.payout, r.costPerJoining == null ? '' : r.costPerJoining]));
  aoa.push(['TOTAL', '', `${d.totals.partners} partner(s)`, d.totals.submitted, d.totals.duplicates, d.totals.submitted - d.totals.duplicates, '', d.totals.interviews, d.totals.selected, d.totals.joined, d.totals.rejected, d.totals.dropped, '', d.totals.payout, d.totals.costPerJoining == null ? '' : d.totals.costPerJoining]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [28, 11, 9, 10, 10, 10, 10, 10, 9, 8, 9, 9, 7, 18, 14].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Partners');
  await logAudit({ userId: req.user.id, action: 'Partner report exported', entity: 'Partner', toValue: `${d.rows.length} partner(s)` });
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="partner-performance-${P.todayIst()}.xlsx"`);
  return res.send(buf);
});

// ---- history ------------------------------------------------------------------------------
router.get('/audit', manageOnly, async (req, res) => {
  const q = req.query || {};
  const where = { entity: { in: ['Partner', 'PartnerUser', 'PartnerSubmission', 'PartnerPayout', 'PartnerJobShare'] } };
  if (str(q.partnerId)) {
    const pid = str(q.partnerId);
    const [users, subs, pays] = await Promise.all([
      prisma.partnerUser.findMany({ where: { partnerId: pid }, select: { id: true } }),
      prisma.partnerSubmission.findMany({ where: { partnerId: pid }, select: { id: true } }),
      prisma.partnerPayout.findMany({ where: { partnerId: pid }, select: { id: true } }),
    ]);
    where.entityId = { in: [pid, ...users.map((u) => u.id), ...subs.map((s) => s.id), ...pays.map((p) => p.id)] };
  }
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300, include: { user: { select: { name: true } } } });
  res.json(rows.map((r) => ({ id: r.id, at: r.createdAt, action: r.action, entity: r.entity, entityId: r.entityId, by: r.actorName || (r.user && r.user.name) || 'TeamLink', from: r.fromValue, to: r.toValue, reason: r.reason })));
});

module.exports = router;
