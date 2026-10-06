// ---------------------------------------------------------------------------
// CLIENT PORTAL LOGINS (spec B1, 2026-10-03) — mounted by routes/portal.js at
// /api/portal/logins. The Client 360 "Portal access" tab and the quarterly
// review list read and write only through here.
//
//   GET  /client/:clientId                         the tab: logins, requests, limit, rights
//   POST /client/:clientId/users                   Add user {name,email,portalType,reason}
//                                                    BDE -> a request; SA/Admin/Manager -> created
//   POST /requests/:id/approve | /reject           SA / Admin / Manager (their departments)
//   POST /client/:clientId/users/:userId/disable   BDE -> a request; approver -> switched off
//   POST /client/:clientId/users/:userId/enable | /resend | /type | /keep   approver only
//   GET  /review                                   quarterly review list + waiting requests
//   PUT  /settings                                 { maxClientLogins } — Super Admin / Admin
//   POST /candidate-requests/:id/close             Admin queue (delete-my-data etc.)
//   POST /archive-idle                             12-month idle candidate logins -> Archived
//
// WHO (utils/permissions.js 'Client Portal Logins'): view = SA, Admin,
// Manager, BDE · create (request) = SA, Admin, BDE · approve = SA, Admin,
// Manager — a Manager only for clients of their own departments. TL,
// Recruiter, HR: refused (403). Passwords are never shown, sent or logged:
// the client gets a 48-hour single-use link and chooses their own.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { clientWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { sendMail } = require('../utils/mailer');
const { issueSetPasswordToken, unguessablePasswordHash, appBaseUrl, SET_PASSWORD_TTL_HOURS } = require('../utils/employeeInvite');
const { departmentOk, pauseApproverIds } = require('../utils/clientLifecycle');
const { PORTAL_TYPES, PORTAL_TYPE_LABELS } = require('../utils/clientPortalTypes');
const { portalSettings, savePortalSettings } = require('../utils/portalSettings');
const L = require('../utils/portalLogins');

const router = express.Router();
const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
router.use(requireAuth);

const FEATURE = 'Client Portal Logins';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (e) => String(e || '').trim().toLowerCase();
const SHORT_TYPE = { REVIEWER: 'Reviewer', VIEWER: 'Viewer', BILLING: 'Billing' };
const typeWords = (t) => (t ? SHORT_TYPE[t] || t : 'Full access (older login)');
const held = (u) => [u.role, u.atsRole, u.hrmsRole, u.accountsRole, ...(Object.values(u.scopeRoles || {}))].filter(Boolean);
const isAdmin = (u) => held(u).some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));

async function baseRights(u) {
  const [view, request, approve] = await Promise.all([
    can(u, null, 'clients', FEATURE, 'view'),
    can(u, null, 'clients', FEATURE, 'create'),
    can(u, null, 'clients', FEATURE, 'approve'),
  ]);
  return { view, request, approve };
}

// The client, inside this login's scope, with what they may do on it.
async function loadClient(req, res, clientId) {
  const u = req.user;
  const base = await baseRights(u);
  if (!base.view && !base.approve) { res.status(403).json({ error: 'Client logins are handled by the client manager (BDE) and the Admin.' }); return null; }
  const client = await prisma.client.findFirst({
    where: { AND: [{ id: clientId }, clientWhere(u)] },
    select: {
      id: true, name: true, clientType: true, ownerDepartment: true, bdeOwner: true, status: true,
      agreementStatus: true, agreementEnd: true, contactName: true, contactEmail: true,
    },
  });
  if (!client) { res.status(404).json({ error: 'Client not found, or not in your area.' }); return null; }
  if (client.clientType === 'Internal') { res.status(400).json({ error: 'TeamLink\'s own internal client has no portal.' }); return null; }
  const approve = base.approve && departmentOk(u, client);
  return { client, rights: { view: base.view || approve, request: base.request && !approve, approve } };
}

function inviteMail({ name, company, link, expiresAt, type }) {
  const when = expiresAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const what = type === 'BILLING'
    ? 'see your invoices'
    : `see your jobs, the candidates we send you${type === 'VIEWER' ? '' : ' (and shortlist or reject them)'}, interviews and feedback`;
  return [
    `Hello ${name || 'there'},`,
    '',
    `${company} has opened a client portal login for you. There you can ${what}.`,
    '',
    `Choose your own password with this link. It works once and expires on ${when} (India time):`,
    '',
    link,
    '',
    'First time? After you sign in you will see "Your jobs" and "Candidates for review" — open a candidate to see the resume and give your decision.',
    '',
    'We never send passwords by email, WhatsApp or chat. If you did not expect this, ignore this message.',
    '',
    `— ${company}`,
  ].join('\n');
}

async function companyName() {
  const c = await prisma.company.findFirst({ select: { name: true } }).catch(() => null);
  return (c && c.name) || 'TeamLink';
}

// Issues (or re-issues) the single-use link and mails it to the login's own
// address. The link comes back to the approver ONLY if the mail did not go.
async function sendInvite(user, req) {
  const { token, expiresAt } = await issueSetPasswordToken(user.id);
  const link = `${appBaseUrl(req)}/set-password/${token}`;
  const company = await companyName();
  const r = await sendMail({
    to: user.email,
    subject: `${company} — your client portal login`,
    text: inviteMail({ name: user.name, company, link, expiresAt, type: user.portalType }),
    useEmployeeFrom: false,
    fromName: '',
  }).catch((e) => ({ ok: false, error: e.message }));
  const sent = !!(r && r.ok);
  return {
    sent,
    expiresAt,
    message: sent ? `Invite sent to ${user.email}. The link works for ${SET_PASSWORD_TTL_HOURS} hours.` : `The email could not be sent (${(r && r.error) || 'mail is not set up'}). Give the client this link yourself — by email only, never WhatsApp or chat.`,
    link: sent ? null : link,
  };
}

// Every rule a NEW client login must pass. Returns an error string or null.
async function whyNot({ client, email, portalType, forRequest }) {
  const gate = L.agreementGate(client);
  if (!gate.active) return `Client logins open only when the agreement is Active. This client's agreement: ${gate.words}.`;
  if (!PORTAL_TYPES.includes(portalType)) return 'Choose the type: Reviewer, Viewer or Billing.';
  if (!EMAIL_RE.test(email)) return 'Enter a valid email address.';
  const [taken] = await prisma.$queryRaw`SELECT id FROM User WHERE lower(trim(email)) = ${email} LIMIT 1`;
  if (taken) return 'This email already has a TeamLink login. Each person needs their own email.';
  const dupe = await prisma.portalRequest.findFirst({ where: { kind: 'CLIENT_LOGIN', status: 'Pending', email } });
  if (dupe && forRequest) return 'A request for this email is already waiting for approval.';
  const { maxClientLogins } = await portalSettings();
  const seats = await L.seatsUsed(client.id);
  const used = seats.logins + (forRequest ? seats.pending : 0);
  if (used >= maxClientLogins) return `This company already has ${used} login${used === 1 ? '' : 's'}${forRequest && seats.pending ? ' (incl. waiting requests)' : ''} — the most allowed is ${maxClientLogins}. Switch one off first.`;
  return null;
}

async function createLogin({ client, name, email, portalType, req }) {
  const user = await prisma.user.create({
    data: {
      name: String(name || email).trim().slice(0, 120),
      email,
      username: email,
      passwordHash: await unguessablePasswordHash(),
      role: 'CLIENT',
      atsRole: 'CLIENT',
      hrmsRole: 'NONE',
      // Billing reads invoices (accounts / Invoices / view is the CLIENT
      // role's); the other two types never reach Accounts.
      accountsRole: portalType === 'BILLING' ? 'CLIENT' : 'NONE',
      atsAccess: true,
      hrmsAccess: false,
      accountsAccess: portalType === 'BILLING',
      clientId: client.id,
      portalType,
      portalReviewedAt: new Date(),
      status: 'Active',
    },
  });
  const invite = await sendInvite(user, req);
  return { user, invite };
}

function shapeLogin(u, gate) {
  const st = L.loginState(u);
  const flags = [];
  if (!L.isOff(u) && !gate.active) flags.push({ key: 'agreement', label: `Agreement ${gate.words.toLowerCase()} — switch off?`, tone: 'red' });
  if (L.reviewDue(u)) flags.push({ key: 'review', label: 'Quarterly check due', tone: 'orange' });
  return {
    id: u.id, name: u.name, email: u.email, type: u.portalType || null, typeWords: typeWords(u.portalType),
    state: st, off: L.isOff(u), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, reviewedAt: u.portalReviewedAt, flags,
  };
}
const shapeRequest = (r) => ({
  id: r.id, kind: r.kind, status: r.status, name: r.name, email: r.email, type: r.portalType, typeWords: r.portalType ? typeWords(r.portalType) : null,
  userId: r.userId, reason: r.reason, requestedBy: r.requestedByName, createdAt: r.createdAt,
  decidedBy: r.decidedByName, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
});

// ---- the tab ---------------------------------------------------------------
router.get('/client/:clientId', wrap(async (req, res) => {
  const got = await loadClient(req, res, req.params.clientId);
  if (!got) return undefined;
  const { client, rights } = got;
  const gate = L.agreementGate(client);
  const [logins, requests, settings] = await Promise.all([
    L.clientLogins(client.id),
    prisma.portalRequest.findMany({ where: { clientId: client.id, kind: { in: ['CLIENT_LOGIN', 'CLIENT_DISABLE'] } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    portalSettings(),
  ]);
  const pending = requests.filter((r) => r.status === 'Pending');
  const used = logins.filter((u) => !L.isOff(u)).length;
  const waitingAdd = pending.filter((r) => r.kind === 'CLIENT_LOGIN').length;
  return res.json({
    client: { id: client.id, name: client.name, suggestedName: client.contactName || '', suggestedEmail: client.contactEmail || '' },
    agreement: gate,
    max: settings.maxClientLogins,
    used,
    waiting: waitingAdd,
    seatsLeft: Math.max(0, settings.maxClientLogins - used - waitingAdd),
    logins: logins.map((u) => ({ ...shapeLogin(u, gate), pendingDisable: pending.some((r) => r.kind === 'CLIENT_DISABLE' && r.userId === u.id) })),
    requests: pending.map(shapeRequest),
    history: requests.filter((r) => r.status !== 'Pending').slice(0, 10).map(shapeRequest),
    types: PORTAL_TYPES.map((t) => ({ value: t, label: SHORT_TYPE[t], hint: PORTAL_TYPE_LABELS[t].split('— ')[1] || '' })),
    rights,
  });
}));

// ---- Add user: request (BDE) or create (approver) --------------------------
router.post('/client/:clientId/users', wrap(async (req, res) => {
  const got = await loadClient(req, res, req.params.clientId);
  if (!got) return undefined;
  const { client, rights } = got;
  if (!rights.request && !rights.approve) return res.status(403).json({ error: 'Only the client manager (BDE) or the Admin can add a client login.' });
  const b = req.body || {};
  const email = norm(b.email);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const portalType = String(b.portalType || '').toUpperCase();
  const reason = String(b.reason || '').trim().slice(0, 500) || null;
  if (!name) return res.status(400).json({ error: 'Enter the person\'s name.' });
  const no = await whyNot({ client, email, portalType, forRequest: true });
  if (no) return res.status(409).json({ error: no });
  const u = req.user;

  if (rights.approve) {
    const out = await createLogin({ client, name, email, portalType, req });
    await prisma.portalRequest.create({
      data: {
        kind: 'CLIENT_LOGIN', status: 'Approved', clientId: client.id, userId: out.user.id, name, email, portalType, reason,
        requestedById: u.id, requestedByName: u.name, decidedById: u.id, decidedByName: u.name, decidedAt: new Date(), decisionNote: 'Added directly',
      },
    });
    await logAudit({ userId: u.id, actorName: u.name, action: `Client portal login created (${typeWords(portalType)})`, entity: 'Client', entityId: client.id, toValue: `${email} · ${out.invite.sent ? 'invite mailed' : 'invite not mailed'}` });
    return res.status(201).json({ created: true, message: `Login added for ${name}. ${out.invite.message}`, link: out.invite.link, expiresAt: out.invite.expiresAt });
  }

  const r = await prisma.portalRequest.create({
    data: { kind: 'CLIENT_LOGIN', status: 'Pending', clientId: client.id, name, email, portalType, reason, requestedById: u.id, requestedByName: u.name },
  });
  await logAudit({ userId: u.id, actorName: u.name, action: `Client portal login requested (${typeWords(portalType)})`, entity: 'Client', entityId: client.id, toValue: email });
  const approvers = (await pauseApproverIds(client)).filter((id) => id !== u.id);
  await notifyUsers(approvers, { title: 'Client login waiting for your approval', message: `${u.name} asks for a ${typeWords(portalType)} login for ${name} (${client.name}).` });
  return res.status(201).json({ requested: true, id: r.id, message: `Request sent. The Admin will approve it, then ${name} gets an invite email.` });
}));

async function loadRequest(req, res) {
  const r = await prisma.portalRequest.findUnique({ where: { id: req.params.id } });
  if (!r || !['CLIENT_LOGIN', 'CLIENT_DISABLE'].includes(r.kind)) { res.status(404).json({ error: 'Request not found.' }); return null; }
  const got = await loadClient(req, res, r.clientId);
  if (!got) return null;
  if (!got.rights.approve) { res.status(403).json({ error: 'Only the Admin (or the department Manager) can decide this.' }); return null; }
  if (r.status !== 'Pending') { res.status(409).json({ error: `This request is already ${r.status.toLowerCase()}.` }); return null; }
  return { r, ...got };
}

router.post('/requests/:id/approve', wrap(async (req, res) => {
  const got = await loadRequest(req, res);
  if (!got) return undefined;
  const { r, client } = got;
  const u = req.user;
  const decided = { decidedById: u.id, decidedByName: u.name, decidedAt: new Date() };
  if (r.kind === 'CLIENT_DISABLE') {
    const target = await prisma.user.findFirst({ where: { id: r.userId, clientId: client.id } });
    if (target) await prisma.user.update({ where: { id: target.id }, data: { status: 'Inactive', setPasswordTokenHash: null, setPasswordExpiresAt: null } });
    await prisma.portalRequest.update({ where: { id: r.id }, data: { status: 'Approved', ...decided } });
    await logAudit({ userId: u.id, actorName: u.name, action: 'Client portal login switched off (request approved)', entity: 'Client', entityId: client.id, toValue: target ? target.email : r.userId });
    await notifyUsers([r.requestedById], { title: 'Client login switched off', message: `${target ? target.name : 'The login'} (${client.name}) is switched off, as you asked.`, exceptUserId: u.id });
    return res.json({ ok: true, message: `${target ? target.name : 'The login'} is switched off.` });
  }
  const no = await whyNot({ client, email: norm(r.email), portalType: r.portalType, forRequest: false });
  if (no) return res.status(409).json({ error: no });
  const out = await createLogin({ client, name: r.name, email: norm(r.email), portalType: r.portalType, req });
  await prisma.portalRequest.update({ where: { id: r.id }, data: { status: 'Approved', userId: out.user.id, ...decided } });
  await logAudit({ userId: u.id, actorName: u.name, action: `Client portal login approved + created (${typeWords(r.portalType)})`, entity: 'Client', entityId: client.id, toValue: `${r.email} · requested by ${r.requestedByName}` });
  await notifyUsers([r.requestedById], { title: 'Client login approved', message: `${r.name} (${client.name}) now has a ${typeWords(r.portalType)} login. An invite email has gone to them.`, exceptUserId: u.id });
  return res.json({ ok: true, message: `Approved. ${out.invite.message}`, link: out.invite.link });
}));

router.post('/requests/:id/reject', wrap(async (req, res) => {
  const got = await loadRequest(req, res);
  if (!got) return undefined;
  const { r, client } = got;
  const u = req.user;
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  if (!note) return res.status(400).json({ error: 'Say why, so the BDE knows.' });
  await prisma.portalRequest.update({ where: { id: r.id }, data: { status: 'Rejected', decidedById: u.id, decidedByName: u.name, decidedAt: new Date(), decisionNote: note } });
  await logAudit({ userId: u.id, actorName: u.name, action: `Client portal request declined (${r.kind === 'CLIENT_DISABLE' ? 'switch off' : 'new login'})`, entity: 'Client', entityId: client.id, toValue: note });
  await notifyUsers([r.requestedById], { title: 'Client login request declined', message: `${client.name}: ${note}`, exceptUserId: u.id });
  return res.json({ ok: true, message: 'Declined. The BDE has been told why.' });
}));

// ---- one login -------------------------------------------------------------
async function loadLogin(req, res) {
  const got = await loadClient(req, res, req.params.clientId);
  if (!got) return null;
  const target = await prisma.user.findFirst({ where: { id: req.params.userId, clientId: got.client.id, OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] } });
  if (!target) { res.status(404).json({ error: 'Login not found for this client.' }); return null; }
  return { ...got, target };
}
const approverOnly = (got, res) => {
  if (got.rights.approve) return true;
  res.status(403).json({ error: 'Only the Admin (or the department Manager) can do this.' });
  return false;
};

router.post('/client/:clientId/users/:userId/disable', wrap(async (req, res) => {
  const got = await loadLogin(req, res);
  if (!got) return undefined;
  const { client, rights, target } = got;
  const u = req.user;
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (L.isOff(target)) return res.status(409).json({ error: 'This login is already switched off.' });
  if (rights.approve) {
    await prisma.user.update({ where: { id: target.id }, data: { status: 'Inactive', setPasswordTokenHash: null, setPasswordExpiresAt: null } });
    await prisma.portalRequest.updateMany({ where: { kind: 'CLIENT_DISABLE', status: 'Pending', userId: target.id }, data: { status: 'Approved', decidedById: u.id, decidedByName: u.name, decidedAt: new Date() } });
    await logAudit({ userId: u.id, actorName: u.name, action: 'Client portal login switched off', entity: 'Client', entityId: client.id, toValue: target.email, reason: reason || null });
    return res.json({ ok: true, message: `${target.name} is switched off. They cannot sign in any more.` });
  }
  if (!rights.request) return res.status(403).json({ error: 'Only the client manager (BDE) or the Admin can switch a login off.' });
  if (!reason) return res.status(400).json({ error: 'Say why (for example: left the company).' });
  const dupe = await prisma.portalRequest.findFirst({ where: { kind: 'CLIENT_DISABLE', status: 'Pending', userId: target.id } });
  if (dupe) return res.status(409).json({ error: 'A switch-off request for this login is already waiting.' });
  await prisma.portalRequest.create({ data: { kind: 'CLIENT_DISABLE', status: 'Pending', clientId: client.id, userId: target.id, name: target.name, email: target.email, reason, requestedById: u.id, requestedByName: u.name } });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Client portal login switch-off requested', entity: 'Client', entityId: client.id, toValue: target.email, reason });
  const approvers = (await pauseApproverIds(client)).filter((id) => id !== u.id);
  await notifyUsers(approvers, { title: 'Switch off a client login?', message: `${u.name} asks to switch off ${target.name} (${client.name}): ${reason}` });
  return res.status(201).json({ requested: true, message: 'Request sent. The Admin will switch it off.' });
}));

router.post('/client/:clientId/users/:userId/enable', wrap(async (req, res) => {
  const got = await loadLogin(req, res);
  if (!got || !approverOnly(got, res)) return undefined;
  const { client, target } = got;
  if (!L.isOff(target)) return res.status(409).json({ error: 'This login is already on.' });
  const gate = L.agreementGate(client);
  if (!gate.active) return res.status(409).json({ error: `Client logins open only when the agreement is Active. Now: ${gate.words}.` });
  const { maxClientLogins } = await portalSettings();
  const seats = await L.seatsUsed(client.id);
  if (seats.logins >= maxClientLogins) return res.status(409).json({ error: `This company already has ${seats.logins} logins — the most allowed is ${maxClientLogins}.` });
  await prisma.user.update({ where: { id: target.id }, data: { status: 'Active', portalReviewedAt: new Date() } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Client portal login switched on again', entity: 'Client', entityId: client.id, toValue: target.email });
  return res.json({ ok: true, message: `${target.name} can sign in again.` });
}));

router.post('/client/:clientId/users/:userId/resend', wrap(async (req, res) => {
  const got = await loadLogin(req, res);
  if (!got || !approverOnly(got, res)) return undefined;
  const { client, target } = got;
  if (L.isOff(target)) return res.status(409).json({ error: 'Switch this login on first.' });
  const gate = L.agreementGate(client);
  if (!gate.active) return res.status(409).json({ error: `The agreement is ${gate.words.toLowerCase()} — no new invite links.` });
  const invite = await sendInvite(target, req);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Client portal invite link re-sent', entity: 'Client', entityId: client.id, toValue: `${target.email} · ${invite.sent ? 'mailed' : 'not mailed'}` });
  return res.json({ ok: true, message: invite.message, link: invite.link });
}));

router.post('/client/:clientId/users/:userId/type', wrap(async (req, res) => {
  const got = await loadLogin(req, res);
  if (!got || !approverOnly(got, res)) return undefined;
  const { client, target } = got;
  const t = String((req.body && req.body.portalType) || '').toUpperCase();
  if (!PORTAL_TYPES.includes(t)) return res.status(400).json({ error: 'Choose Reviewer, Viewer or Billing.' });
  await prisma.user.update({ where: { id: target.id }, data: { portalType: t, accountsRole: t === 'BILLING' ? 'CLIENT' : 'NONE', accountsAccess: t === 'BILLING' } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Client portal login type changed', entity: 'Client', entityId: client.id, fromValue: typeWords(target.portalType), toValue: `${target.email} → ${typeWords(t)}` });
  return res.json({ ok: true, message: `${target.name} is now ${typeWords(t)}.` });
}));

router.post('/client/:clientId/users/:userId/keep', wrap(async (req, res) => {
  const got = await loadLogin(req, res);
  if (!got || !approverOnly(got, res)) return undefined;
  const { client, target } = got;
  await prisma.user.update({ where: { id: target.id }, data: { portalReviewedAt: new Date() } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Client portal login checked — still needed', entity: 'Client', entityId: client.id, toValue: target.email });
  return res.json({ ok: true, message: `Checked. ${target.name} stays on — next check in ${L.REVIEW_EVERY_DAYS} days.` });
}));

// ---- the quarterly review list ---------------------------------------------
router.get('/review', wrap(async (req, res) => {
  const u = req.user;
  const base = await baseRights(u);
  const adminQueue = isAdmin(u) && await can(u, 'ats', 'candidates', 'Candidate Portal Invite', 'approve');
  if (!base.approve && !adminQueue) return res.status(403).json({ error: 'The client login review is for the Admin and Managers.' });
  const clients = base.approve ? (await prisma.client.findMany({
    where: { AND: [clientWhere(u), { users: { some: { OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] } } }] },
    select: { id: true, name: true, clientType: true, ownerDepartment: true, agreementStatus: true, agreementEnd: true },
  })).filter((c) => c.clientType !== 'Internal' && departmentOk(u, c)) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const users = clients.length ? await prisma.user.findMany({
    where: { clientId: { in: [...byId.keys()] }, OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }], status: { notIn: L.OFF_STATUSES } },
    select: {
      id: true, name: true, email: true, status: true, portalType: true, portalReviewedAt: true, lastLoginAt: true,
      createdAt: true, setPasswordTokenHash: true, setPasswordExpiresAt: true, passwordChangedAt: true, clientId: true,
    },
    orderBy: { createdAt: 'asc' },
  }) : [];
  const rows = users.map((x) => {
    const c = byId.get(x.clientId);
    return { ...shapeLogin(x, L.agreementGate(c)), client: { id: c.id, name: c.name } };
  });
  const requests = clients.length ? await prisma.portalRequest.findMany({
    where: { clientId: { in: [...byId.keys()] }, status: 'Pending', kind: { in: ['CLIENT_LOGIN', 'CLIENT_DISABLE'] } }, orderBy: { createdAt: 'asc' },
  }) : [];
  // Requests for clients that have no login yet (a first BDE request).
  const firstRequests = base.approve ? (await prisma.portalRequest.findMany({
    where: { status: 'Pending', kind: 'CLIENT_LOGIN', clientId: { notIn: [...byId.keys()] } },
    orderBy: { createdAt: 'asc' },
  })) : [];
  let extra = [];
  if (firstRequests.length) {
    const cs = await prisma.client.findMany({ where: { AND: [{ id: { in: firstRequests.map((r) => r.clientId) } }, clientWhere(u)] }, select: { id: true, name: true, ownerDepartment: true } });
    const okIds = new Map(cs.filter((c) => departmentOk(u, c)).map((c) => [c.id, c]));
    extra = firstRequests.filter((r) => okIds.has(r.clientId)).map((r) => ({ ...shapeRequest(r), client: { id: r.clientId, name: okIds.get(r.clientId).name } }));
  }
  const candidateRequests = adminQueue ? await prisma.portalRequest.findMany({
    where: { kind: { startsWith: 'CANDIDATE_' }, status: 'Pending' }, orderBy: { createdAt: 'asc' }, take: 200,
  }) : [];
  const settings = await portalSettings();
  return res.json({
    logins: rows,
    requests: [...requests.map((r) => ({ ...shapeRequest(r), client: { id: r.clientId, name: byId.get(r.clientId).name } })), ...extra],
    candidateRequests: candidateRequests.map(shapeRequest).map((r, i) => ({ ...r, candidateId: candidateRequests[i].candidateId })),
    settings,
    rights: { approve: base.approve, adminQueue, settings: isAdmin(u) },
    reviewEveryDays: L.REVIEW_EVERY_DAYS,
  });
}));

router.put('/settings', wrap(async (req, res) => {
  const u = req.user;
  if (!isAdmin(u) || !(await can(u, null, 'clients', FEATURE, 'approve'))) return res.status(403).json({ error: 'Only the Super Admin or Admin can change this.' });
  const out = await savePortalSettings({ maxClientLogins: req.body && req.body.maxClientLogins });
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Client logins per company changed', entity: 'Integration', entityId: 'portal-logins', fromValue: String(out.before.maxClientLogins), toValue: String(out.settings.maxClientLogins) });
  return res.json({ ok: true, settings: out.settings, message: `Saved. Up to ${out.settings.maxClientLogins} logins per company.` });
}));

// ---- Admin queue: candidate privacy / delete-my-data requests -------------
router.post('/candidate-requests/:id/close', wrap(async (req, res) => {
  const u = req.user;
  if (!isAdmin(u) || !(await can(u, 'ats', 'candidates', 'Candidate Portal Invite', 'approve'))) return res.status(403).json({ error: 'Only the Admin handles these requests.' });
  const r = await prisma.portalRequest.findUnique({ where: { id: req.params.id } });
  if (!r || !String(r.kind).startsWith('CANDIDATE_')) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'Pending') return res.status(409).json({ error: `Already ${r.status.toLowerCase()}.` });
  const outcome = (req.body && req.body.outcome) === 'Declined' ? 'Declined' : 'Done';
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  if (!note) return res.status(400).json({ error: 'Write what was done (or why not).' });
  await prisma.portalRequest.update({ where: { id: r.id }, data: { status: outcome, decidedById: u.id, decidedByName: u.name, decidedAt: new Date(), decisionNote: note } });
  await logAudit({ userId: u.id, actorName: u.name, action: `Candidate privacy request ${outcome === 'Done' ? 'handled' : 'declined'}`, entity: 'Candidate', entityId: r.candidateId, toValue: note });
  return res.json({ ok: true, message: outcome === 'Done' ? 'Marked done.' : 'Declined.' });
}));

router.post('/archive-idle', wrap(async (req, res) => {
  const u = req.user;
  if (!isAdmin(u) || !(await can(u, 'ats', 'candidates', 'Candidate Portal Invite', 'approve'))) return res.status(403).json({ error: 'Only the Admin can do this.' });
  const out = await L.archiveIdleCandidateLogins({ userId: u.id });
  return res.json({ ...out, message: out.archived ? `${out.archived} candidate login${out.archived === 1 ? '' : 's'} archived (no sign-in for 12 months).` : 'No candidate login has been idle for 12 months.' });
}));

module.exports = router;
