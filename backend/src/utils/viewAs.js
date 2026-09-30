// ---------------------------------------------------------------------------
// SUPER ADMIN "VIEW AS" — READ-ONLY IMPERSONATION.
//
// A Super Admin may open the app AS another login (Recruiter, TL, BDE, HR,
// Accountant, Manager, a client or candidate portal login …) to check exactly
// what that person sees. It is strictly READ-ONLY and never involves the
// person's password or their own session:
//
//   * POST /api/admin/view-as/:userId (routes/viewAs.js) issues a 60-minute
//     token for the TARGET carrying an extra claim
//       viewAs: { byUserId, byName, readOnly: true, sid }
//     signed with the same secret as every login token.
//   * middleware/auth.js requireAuth resolves req.user as the TARGET, so every
//     permission and scope rule applies exactly as it does for that person,
//     and sets req.viewAs.
//   * viewAsGuard (below, mounted on /api ahead of every router) refuses every
//     request that is not GET / HEAD / OPTIONS with a 403 — except the short
//     READ_ONLY_POSTS allow-list of POSTs that only read.
//   * GETs that write as a side effect (auto-created rows, "viewed" stamps,
//     progress touches, export audit rows …) are neutralised GENERICALLY: the
//     request runs inside an AsyncLocalStorage context and the Prisma
//     middleware below turns every write issued inside it into a no-op that
//     returns a plausible result. No route has to remember to check.
//   * utils/ai.js refuses to call the model while viewing as (no cost).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const jwt = require('jsonwebtoken');
const express = require('express');
const prisma = require('../db');

const VIEW_AS_MINUTES = 60;
const als = new AsyncLocalStorage();

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// POSTs a screen needs in order to RENDER, each verified to only read
// (paths are relative to /api). Anything not listed here is refused.
const READ_ONLY_POSTS = [
  { re: /^\/admin\/view-as\/exit\/?$/, why: 'End View as' },
  { re: /^\/audience\/preview\/?$/, why: 'Send-to picker: audience count + sample names (resolveAudience only)' },
  { re: /^\/clients\/check-duplicate\/?$/, why: 'Client form duplicate check (findClientDuplicates only)' },
  { re: /^\/employees\/management\/tl-wise\/?$/, why: 'Employee Management TL-wise view (tlWiseFor only)' },
  { re: /^\/employees\/management\/tl-wise\.xlsx\/?$/, why: 'TL-wise export (read; its audit row is neutralised)' },
  { re: /^\/employees\/export\.xlsx\/?$/, why: 'Employee list export (read; audit neutralised)' },
  { re: /^\/employees\/export\/global\/?$/, why: 'Employee global export (read; audit neutralised)' },
  { re: /^\/invoices\/register\/export\.xlsx\/?$/, why: 'Invoice register export (read; audit neutralised)' },
  { re: /^\/ats-io\/export\/[A-Za-z0-9_-]+\/?$/, why: 'ATS module export (read; audit neutralised)' },
  { re: /^\/lms\/materials\/[^/]+\/view-token\/?$/, why: 'LMS material viewer signed URL (progress touch neutralised)' },
];

function isAllowedWrite(method, path) {
  if (method !== 'POST') return false;
  return READ_ONLY_POSTS.some((r) => r.re.test(path));
}

// ---- per-session bookkeeping (in memory; the audit rows are the record) ----
const blockedCount = new Map(); // sid -> number of refused write attempts
const endedSids = new Set();
const liveSids = new Set();

function bumpBlocked(sid) {
  if (!sid) return;
  blockedCount.set(sid, (blockedCount.get(sid) || 0) + 1);
}
function takeBlocked(sid) {
  const n = blockedCount.get(sid) || 0;
  blockedCount.delete(sid);
  return n;
}
const sessionReason = (sid) => `View-as session ${sid}`;

// Has this View-as session been exited? Remembered in memory, and checked once
// per process against the "View as ended" audit row so an exited token stays
// dead across a server restart.
async function isEnded(sid) {
  if (!sid) return true;
  if (endedSids.has(sid)) return true;
  if (liveSids.has(sid)) return false;
  const row = await prisma.auditLog.findFirst({
    where: { action: 'View as ended', reason: sessionReason(sid) }, select: { id: true },
  }).catch(() => null);
  if (row) { endedSids.add(sid); return true; }
  liveSids.add(sid);
  return false;
}
function markEnded(sid) { endedSids.add(sid); liveSids.delete(sid); }
function markLive(sid) { liveSids.add(sid); endedSids.delete(sid); }

function newSid() { return crypto.randomUUID(); }

// ---- context ---------------------------------------------------------------
function viewAsContext() { return als.getStore() || null; }
function isViewingAs() { const c = als.getStore(); return !!(c && c.viewAs && !c.allowWrites); }
// Run fn with writes permitted (the "View as ended" audit row).
function withWrites(fn) {
  const c = als.getStore();
  if (!c) return fn();
  return als.run({ ...c, allowWrites: true }, fn);
}
// Enter the context for the rest of this request (requireAuth, as a backstop
// for middleware that parses a body on stream events and loses the context).
function enterContext(viewAs) {
  const c = als.getStore();
  if (c && c.viewAs) return;
  als.enterWith({ viewAs, skipped: 0 });
}

// requireAuth's per-request check of a View-as token, after the TARGET has
// been resolved: the Super Admin behind it must still be an active Super
// Admin, the session must not have been exited, and the target must not have
// become a Super Admin. Returns null when fine, else { status, body }.
async function checkSession(claims, identity) {
  const v = claims.viewAs || {};
  const ended = (why) => ({ status: 401, body: { error: why, viewAsEnded: true } });
  if (!v.byUserId || !v.sid || v.readOnly !== true) return ended('This View as session is not valid.');
  const viewer = await prisma.user.findUnique({
    where: { id: v.byUserId }, select: { id: true, role: true, status: true },
  }).catch(() => null);
  if (!viewer || viewer.role !== 'SUPER_ADMIN' || (viewer.status || 'Active') !== 'Active') {
    return ended('View as has ended — the Super Admin login behind it is no longer active.');
  }
  if (await isEnded(v.sid)) return ended('View as has ended.');
  if (identity.role === 'SUPER_ADMIN' || identity.hrmsRole === 'SUPER_ADMIN') {
    return ended('A Super Admin login cannot be viewed as.');
  }
  return null;
}

function readOnlyMessage(name) {
  return `Read-only: you are viewing as ${name || 'another user'}. Exit View as to make changes.`;
}

// ---- the /api guard --------------------------------------------------------
// Signature-checked, so only a genuine View-as token is treated as one. A bad
// token passes straight through: requireAuth answers 401 as it always has.
const preParse = express.text({ type: () => true, limit: '30mb' });
function viewAsGuard(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  let claims;
  try { claims = jwt.verify(header.slice(7), process.env.JWT_SECRET); } catch { return next(); }
  if (!claims || !claims.viewAs) return next();
  const ctx = { viewAs: claims.viewAs, skipped: 0 };
  if (!READ_METHODS.has(req.method)) {
    if (!isAllowedWrite(req.method, req.path)) {
      bumpBlocked(claims.viewAs.sid);
      return res.status(403).json({ error: readOnlyMessage(claims.name), viewAsReadOnly: true });
    }
    // An allow-listed POST: read its body NOW, outside the context, so the
    // route's own body parser finds it done and the handler keeps the context
    // (a parser that reads the stream would resume on a socket event).
    if (!req._body) return preParse(req, res, (err) => (err ? next(err) : als.run(ctx, next)));
  }
  return als.run(ctx, next);
}

// ---- the Prisma write guard ----------------------------------------------
const WRITE_ACTIONS = new Set([
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
  'executeRaw', 'executeRawUnsafe',
]);
function pickShape(args) {
  const out = {};
  if (args && args.select) out.select = args.select;
  if (args && args.include) out.include = args.include;
  return out;
}
function fakeRow(data) {
  const now = new Date();
  return { id: `viewas-${crypto.randomUUID()}`, createdAt: now, updatedAt: now, ...(data || {}) };
}
prisma.$use(async (params, next) => {
  const c = als.getStore();
  if (!c || !c.viewAs || c.allowWrites || !WRITE_ACTIONS.has(params.action)) return next(params);
  c.skipped = (c.skipped || 0) + 1;
  const args = params.args || {};
  switch (params.action) {
    case 'createMany': case 'updateMany': case 'deleteMany': return { count: 0 };
    case 'createManyAndReturn': return [];
    case 'executeRaw': case 'executeRawUnsafe': return 0;
    case 'create': return fakeRow(args.data);
    case 'update': case 'delete': {
      if (!params.model || !args.where) return null;
      return next({ ...params, action: 'findUnique', args: { where: args.where, ...pickShape(args) } });
    }
    case 'upsert': {
      if (!params.model || !args.where) return fakeRow(args.create);
      const existing = await next({ ...params, action: 'findUnique', args: { where: args.where, ...pickShape(args) } });
      return existing || fakeRow(args.create);
    }
    default: return next(params);
  }
});

module.exports = {
  VIEW_AS_MINUTES, READ_ONLY_POSTS, viewAsGuard, checkSession, viewAsContext, isViewingAs, withWrites, enterContext,
  readOnlyMessage, bumpBlocked, takeBlocked, isEnded, markEnded, markLive, newSid, sessionReason,
};
