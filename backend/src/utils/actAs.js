// ---------------------------------------------------------------------------
// SUPER ADMIN "ACT AS" — the EDIT twin of View as (utils/viewAs.js).
//
// View as is read-only. Act as lets a SUPER ADMIN use the app AS another login
// with that login's REAL rights, to test and use a role end to end. It is built
// ON View as, not beside it:
//
//   * same start point (routes/viewAs.js), same 60-minute lifetime, same secret,
//     same per-tab sessionStorage token, same session list (utils/viewAs.js
//     isEnded / markEnded) and the same "View-as session <sid>" key in the
//     audit log. The token carries an `actAs` claim instead of `viewAs`:
//       actAs: { byUserId, byName, mode: 'act', sid }
//   * middleware/auth.js requireAuth resolves req.user as the TARGET (so every
//     can() / scope rule is exactly what that person gets when they log in —
//     the Super Admin's own extra rights are NOT carried over) and sets
//     req.actingAs. req.viewAs is NOT set: nothing in the app treats an Act-as
//     request as read-only.
//   * viewAsGuard (mounted on /api ahead of every router) hands act tokens to
//     guard() below, which
//       1. refuses the HARD-BLOCKED list even though the real user is a Super
//          Admin (passwords, users / roles / Role Catalog / role access,
//          integrations, security settings, backups and DB tools, deleting
//          employees, seats, clock-in as someone else, agreements / company
//          stamp, starting another View as / Act as),
//       2. asks for a confirmation before anything that REALLY goes to a person
//          (409 ACT_CONFIRM_SEND; the browser asks, then repeats the call with
//          header X-Act-Confirm: send),
//       3. refuses an approval step on a record the same human made or
//          requested (maker-checker: act as the BDE to ask, act as the TL to
//          approve = one person approving his own request),
//       4. writes the audit trail (below).
//   * Notification rows are never changed while acting (read marks, deletes):
//     the target's unread list stays exactly as it was.
//
// AUDIT. Every write request while acting leaves a row
//     action 'Acted as: change' (or 'Acted as: refused' when it failed)
//     userId   = the REAL Super Admin           (actor)
//     actorName= '<SA> (acting as <target>)'
//     toValue  = 'on behalf of <target>'        (onBehalfOf)   entityId = target
//     field    = 'POST /api/clients/<id>/pause' (route)   fromValue = IP
//     reason   = 'View-as session <sid> · on behalf of <target> (<id>) · IP x'
//   and each record CREATED is listed as 'Acted as: created' (entity + id: used
//   by the same-human approval check). Rows the app itself writes through
//   logAudit() keep their functional userId (the pause request is read back by
//   it) but carry actorName '<target> · done by <SA> (Acting as)'. The start /
//   end rows are 'Act as started' / 'Act as ended'. The "Acted as" list on
//   Administration -> Users is built from these rows (routes/viewAs.js).
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { ipOf } = require('./clientIp');
const { isSystemAccount } = require('./systemAccounts');

const ACT_AS_MINUTES = 60;
const als = new AsyncLocalStorage();
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const lazyVa = () => require('./viewAs'); // eslint-disable-line global-require

// ---- who may be acted as ----------------------------------------------------
const EXITED_EMPLOYMENT = new Set(['Relieved', 'Exited', 'Exit Process', 'Terminated', 'Absconded']);
const hasAdminRole = (i) => [i.role, i.hrmsRole, i.atsRole, i.accountsRole].some((r) => r === 'SUPER_ADMIN' || r === 'ADMIN');

// Why this login cannot be acted as, or null. `identity` = resolveIdentity().
function refusalFor(identity, userRow) {
  if (!identity || !userRow) return { status: 404, error: 'That login does not exist.' };
  if (isSystemAccount(userRow) || isSystemAccount(identity) || hasAdminRole(identity)) {
    return { status: 403, error: 'You cannot act as a Super Admin or Admin login.' };
  }
  if ((userRow.status || 'Active') !== 'Active') {
    return { status: 403, error: `That login is ${String(userRow.status).toLowerCase()} — you can only act as an active login.` };
  }
  if (identity.employmentStatus && EXITED_EMPLOYMENT.has(identity.employmentStatus)) {
    return { status: 403, error: `${identity.name} has left the company (${identity.employmentStatus}) — you cannot act as them.` };
  }
  if (['CLIENT', 'CANDIDATE', 'VENDOR', 'PARTNER'].includes(identity.role)) {
    return { status: 403, error: 'Client, candidate, vendor and partner logins can only be viewed, not acted as.' };
  }
  return null;
}

// requireAuth's per-request check of an Act-as token (target already resolved).
async function checkSession(claims, identity) {
  const a = claims.actAs || {};
  const va = lazyVa();
  const ended = (why) => ({ status: 401, body: { error: why, viewAsEnded: true } });
  if (!a.byUserId || !a.sid || a.mode !== 'act') return ended('This Act as session is not valid.');
  const viewer = await prisma.user.findUnique({ where: { id: a.byUserId }, select: { id: true, role: true, status: true } }).catch(() => null);
  if (!viewer || viewer.role !== 'SUPER_ADMIN' || (viewer.status || 'Active') !== 'Active') {
    return ended('Act as has ended — the Super Admin login behind it is no longer active.');
  }
  if (await va.isEnded(a.sid)) return ended('Act as has ended.');
  if (isSystemAccount(identity) || hasAdminRole(identity)) return ended('Act as has ended — that login is now a Super Admin or Admin.');
  if (identity.employmentStatus && EXITED_EMPLOYMENT.has(identity.employmentStatus)) return ended('Act as has ended — that person has left the company.');
  return null;
}

// ---- the hard-blocked list --------------------------------------------------
// Paths are relative to /api. Anything here is refused for every write, even
// though the real person is a Super Admin.
const BLOCKED = [
  { re: /^\/admin\/notifications(\/|$)/, allow: true },
  { re: /^\/admin\/view-as\/(act-exit|back-to-read-only)\/?$/, allow: true },
  // Making, stopping and emailing the agreement LINK is the BDE's daily work (not signing or stamping): allowed,
  // and the email goes through the "really send?" question below (OUTBOUND).
  { re: /^\/agreement\/[^/]+\/link(\/revoke|\/email)?\/?$/, allow: true },
  { re: /^\/auth\/(change-password|forgot-password|reset-password)/, why: 'Passwords cannot be changed while acting as someone else.' },
  { re: /(^|\/)(password|set-password|reset-password|send-password-reset|reset-link|send-credentials|create-login|toggle-login)(\/|$)/, why: 'Passwords and sign-in links cannot be changed while acting as someone else.' },
  { re: /^\/admin(\/|$)/, why: 'Administration changes — users, roles, the Role Catalog, role access, integrations, API keys, company and security settings — are not available while acting as someone else.' },
  { re: /^\/employees\/(management\/)?[^/]+\/roles\/?$/, why: 'Roles and role access cannot be changed while acting as someone else.' },
  { re: /^\/(vendor-logins|partners\/logins|portal\/logins|portal\/invite)(\/|$)/, why: 'Creating or changing logins is not available while acting as someone else.' },
  { re: /^\/employees\/bulk-import(\/|$)/, why: 'Creating logins in bulk is not available while acting as someone else.' },
  { re: /^\/positions(\/|$)/, why: 'Seats (positions) decide a person\'s role, so they cannot be changed while acting as someone else.' },
  { re: /^\/resignations\/exit\/(settings|employee\/[^/]+\/finalize-override)\/?$/, why: 'Changing the exit approval settings, or finishing an exit without approval, is not available while acting as someone else.' },
  { method: 'DELETE', re: /^\/employees(\/|$)/, why: 'Deleting employees is not available while acting as someone else.' },
  { method: 'POST', re: /^\/employees\/?$/, why: 'Creating an employee (and their login) is not available while acting as someone else.' },
  { re: /^\/employees\/me\/verify/, why: 'Verifying this person\'s own e-mail or phone is not available while acting as them.' },
  { re: /^\/(system|data-import|integration-health)(\/|$)/, why: 'Backups, restore and database tools are not available while acting as someone else.' },
  { re: /^\/attendance\/(punches|checkin|face|geofence)/, why: 'Clocking in or out for another person is not allowed.' },
  { re: /^\/agreement\/(?!token\/)/, why: 'Signing or stamping an agreement as another person is not allowed.' },
];

function blockedFor(method, path) {
  for (const b of BLOCKED) {
    if (b.method && b.method !== method) continue;
    if (!b.re.test(path)) continue;
    return b.allow ? null : b;
  }
  return null;
}

// ---- things that REALLY reach a person -------------------------------------
const OUTBOUND = [
  /^\/messaging\/(send|call|reach\/send|reach\/call-queue)\/?$/,
  /^\/messaging\/bulk(\/[^/]+\/retry-failed)?\/?$/,
  /^\/conversations\/(send|request-contact)\/?$/,
  /^\/job-broadcast\/(jobs\/[^/]+\/post-everywhere|campaigns\/[^/]+\/(start|resume)|campaigns\/[^/]+\/replies\/[^/]+\/reply)\/?$/,
  /^\/candidates\/(bulk-contact|[^/]+\/contact)\/?$/,
  /^\/clients\/[^/]+\/agreement\/(send|resend)\/?$/,
  /^\/agreement\/[^/]+\/link\/email\/?$/,
  /^\/ats\/interviews\/[^/]+\/(tell\/send-all|prep\/send)\/?$/,
  /^\/ats\/offers\/[^/]+\/(approve|release|link\/email)\/?$/,
  /^\/auto-messages\/scheduled\/[^/]+\/(send-now|approve)\/?$/,
  /^\/pending-work\/(remind|eod\/send)\/?$/,
  /^\/dashboard\/accounts\/control\/(remind|whatsapp)\/?$/,
  /^\/ats-report-pack\/email\/?$/,
  /^\/ats\/joining\/[^/]+\/call\/?$/,
  /^\/ats\/ai-interviews\/[^/]+\/resend\/?$/,
];
const isOutbound = (path) => OUTBOUND.some((re) => re.test(path));

// ---- same-human approvals ---------------------------------------------------
const APPROVAL_PATH = /\/(approve|reject|decision|decisions|bulk-decision|decide|activate|status|toggle-status|verify|release|send-back|confirm|paid|process|review|reopen|post)(\/|$)/;
const ID_LIKE = /^(?=.*\d)[A-Za-z0-9_-]{20,40}$/; // cuid / uuid (a word like "requirement-requests" has no digit)
function idsOf(req) {
  const out = new Set();
  String(req.path || '').split('/').forEach((s) => { if (ID_LIKE.test(s)) out.add(s); });
  const walk = (v, depth) => {
    if (out.size > 300 || depth > 3 || v == null) return;
    if (typeof v === 'string') { if (ID_LIKE.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { v.slice(0, 200).forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') Object.values(v).slice(0, 60).forEach((x) => walk(x, depth + 1));
  };
  walk(req.body, 0);
  return [...out];
}
async function sameHumanRecord(req, saId) {
  if (!APPROVAL_PATH.test(req.path)) return false;
  const ids = idsOf(req);
  if (!ids.length) return false;
  const row = await prisma.auditLog.findFirst({
    where: {
      OR: [
        { userId: saId, action: 'Acted as: created', entityId: { in: ids } },
        { userId: saId, id: { in: ids } },
      ],
    },
    select: { id: true },
  }).catch(() => null);
  return !!row;
}

// ---- audit rows -------------------------------------------------------------
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function entityFromPath(path) {
  const segs = String(path || '').split('/').filter(Boolean);
  return { entity: (segs[0] || 'api').slice(0, 60), entityId: segs.find((s) => ID_LIKE.test(s)) || null };
}
function traceRow(ctx, base) {
  const a = ctx.actAs;
  return {
    userId: a.byUserId,
    actorName: `${a.byName} (acting as ${ctx.targetName})`,
    reason: `${lazyVa().sessionReason(a.sid)} · on behalf of ${ctx.targetName} (${ctx.targetId}) · IP ${ctx.ip}`,
    fromValue: ctx.ip,
    toValue: `on behalf of ${ctx.targetName}`,
    ...base,
  };
}
async function writeRows(rows) {
  if (!rows.length) return;
  try { await prisma.auditLog.createMany({ data: rows }); } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[act-as] could not record %d audit rows: %s', rows.length, err && err.message);
  }
}

// ---- the /api guard (called from viewAsGuard for an act token) ----------------
function guard(req, res, next, claims) {
  const a = claims.actAs;
  const ctx = {
    actAs: a, targetId: claims.id, targetName: claims.name || 'the user', byName: a.byName,
    ip: ipOf(req), pending: [], tracing: false, notifSkipped: 0,
  };
  req._actCtx = ctx;
  if (READ_METHODS.has(req.method)) return als.run(ctx, next);
  const path = req.path;
  const { entity, entityId } = entityFromPath(path);
  const refuse = async (status, body, label) => {
    await writeRows([traceRow(ctx, {
      action: 'Acted as: refused', entity, entityId: entityId || ctx.targetId, field: `${req.method} /api${path}`, fieldLabel: label,
    })]);
    res.status(status).json(body);
  };
  const exitCall = /^\/admin\/view-as\/(act-exit|back-to-read-only)\/?$/.test(path);
  if (exitCall) return als.run(ctx, next);

  const blocked = blockedFor(req.method, path);
  if (blocked) {
    return refuse(403, { error: `${blocked.why} Exit Act as to do this as yourself.`, actAsBlocked: true }, 'Blocked while acting');
  }
  if (isOutbound(path) && String(req.headers['x-act-confirm'] || '') !== 'send') {
    return res.status(409).json({
      code: 'ACT_CONFIRM_SEND',
      error: `This will really send to a real person — a candidate, a client or a colleague — as ${ctx.targetName}. It is not a test. Send it?`,
      actAsConfirm: true,
    });
  }
  return sameHumanRecord(req, a.byUserId).then((same) => {
    if (same) {
      return refuse(403, {
        error: 'You made or asked for this yourself while acting, so you cannot approve it too. Another person has to decide it.',
        actAsBlocked: true,
      }, 'Same person approving own request');
    }
    // Write the trace rows BEFORE the answer leaves, so the very next call sees them.
    const origEnd = res.end;
    let done = false;
    res.end = function end(...args) {
      if (done) return origEnd.apply(this, args);
      done = true;
      const status = res.statusCode;
      const rows = [traceRow(ctx, {
        action: status < 400 ? 'Acted as: change' : 'Acted as: refused',
        entity, entityId: entityId || ctx.targetId, field: `${req.method} /api${path}`, fieldLabel: `HTTP ${status}`,
      })];
      if (status < 400) {
        ctx.pending.forEach((p) => rows.push(traceRow(ctx, {
          action: 'Acted as: created', entity: p.model, entityId: p.id, field: `${req.method} /api${path}`, fieldLabel: 'record created',
        })));
      }
      ctx.tracing = true;
      return writeRows(rows).then(() => origEnd.apply(this, args), () => origEnd.apply(this, args)), this;
    };
    return als.run(ctx, next);
  });
}

// ---- context for the rest of the app ---------------------------------------
function context() { const c = als.getStore(); return c && c.actAs ? c : null; }
function enterContext(req) {
  const c = als.getStore();
  if (c && c.actAs) return;
  if (req && req._actCtx) als.enterWith(req._actCtx);
}

// ---- Prisma: notifications untouched, creates remembered --------------------
const NOTIF_WRITES = new Set(['update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const NO_TRACE_MODELS = new Set(['Notification', 'IntegrationEvent']);
prisma.$use(async (params, next) => {
  const c = als.getStore();
  if (!c || !c.actAs || c.tracing) return next(params);
  if (params.model === 'Notification' && NOTIF_WRITES.has(params.action)) {
    c.notifSkipped += 1;
    if (params.action === 'updateMany' || params.action === 'deleteMany') return { count: 0 };
    const where = params.args && params.args.where;
    if (!where) return null;
    return next({ ...params, action: 'findUnique', args: { where } });
  }
  const result = await next(params);
  if (params.action === 'create' && params.model && result && result.id && !NO_TRACE_MODELS.has(params.model)) {
    const pendingAudit = params.model === 'AuditLog' && result.approvalStatus === 'Pending';
    if (params.model !== 'AuditLog' || pendingAudit) c.pending.push({ model: params.model, id: result.id });
  }
  return result;
});

// ---- token ----------------------------------------------------------------
function signActToken(identity, tokenPayload, byUser, sid) {
  const actAs = { byUserId: byUser.id, byName: byUser.name, mode: 'act', sid };
  const token = jwt.sign({ ...tokenPayload(identity), actAs }, process.env.JWT_SECRET, { expiresIn: `${ACT_AS_MINUTES}m` });
  return { token, exp: jwt.decode(token).exp };
}

// ---- the "Acted as" list -------------------------------------------------------
async function history({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await prisma.auditLog.findMany({
    where: { createdAt: { gte: since }, action: { in: ['Act as started', 'Act as ended', 'Acted as: change', 'Acted as: refused'] } },
    orderBy: { createdAt: 'asc' }, take: 20000,
  });
  const by = new Map();
  const get = (sid) => { if (!by.has(sid)) by.set(sid, { sid, changes: 0, refused: 0 }); return by.get(sid); };
  for (const r of rows) {
    const m = UUID.exec(r.reason || '');
    if (!m) continue;
    const s = get(m[0]);
    if (r.action === 'Act as started') {
      Object.assign(s, {
        byId: r.userId, byName: r.actorName, targetId: r.entityId, targetName: r.fieldLabel || null, startedAt: r.createdAt, ip: r.fromValue || null,
      });
    } else if (r.action === 'Act as ended') {
      s.endedAt = r.createdAt; s.endedNote = r.toValue || null;
    } else if (r.action === 'Acted as: change') { s.changes += 1; s.lastChangeAt = r.createdAt; } else s.refused += 1;
  }
  const now = Date.now();
  return [...by.values()].filter((s) => s.startedAt).map((s) => {
    const expires = new Date(new Date(s.startedAt).getTime() + ACT_AS_MINUTES * 60000);
    const live = !s.endedAt && expires.getTime() > now;
    return { ...s, live, endedAt: s.endedAt || (live ? null : expires), endedHow: s.endedAt ? 'Exited' : (live ? 'Still acting' : 'Expired') };
  }).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

module.exports = {
  ACT_AS_MINUTES, refusalFor, checkSession, guard, context, enterContext, signActToken, history,
  blockedFor, isOutbound, BLOCKED,
};
