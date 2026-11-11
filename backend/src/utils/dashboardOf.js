// ---------------------------------------------------------------------------
// SUPER ADMIN "DASHBOARD OF" (2026-11-10): the role picker on the ATS
// dashboard. ?asUser=<userId> draws THAT login's own dashboard (its layout, its
// scope, its panels and charts) inside the Super Admin's session, so the Super
// Admin can go through every role's dashboard without leaving their own login.
//
// Used by routes/dashboard.js (/ats/home, /ats/home/list, /ats/home/export) and
// by the two dashboard boxes that load their own rows:
// routes/pendingWork.js /my-missed ("My missed items") and
// routes/clientRequests.js /clients/my-business (the BDE workspace).
//
// The same rules as View as (routes/viewAs.js), because it shows the same thing:
//   * Super Admin only: not an HR-super login, not while viewing / acting as;
//   * the target is an active login, not a Super Admin, holds the ATS and has
//     not left;
//   * READ-ONLY: fn runs inside the View-as context (utils/viewAs.js
//     readOnly), so a write a GET makes on the side is a no-op.
// Without ?asUser nothing changes for anybody.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const viewAs = require('./viewAs');
const { resolveIdentity } = require('./identity');
const { isStrictSystemAccount } = require('./systemAccounts');

function boardRefusal(status, message) {
  const e = new Error(message);
  e.status = status;
  e.boardRefusal = true;
  return e;
}

async function boardSubject(req) {
  const id = req.query && req.query.asUser ? String(req.query.asUser) : '';
  if (!id || id === String(req.user.id)) return req.user;
  if (req.viewAs || req.actingAs || req.user.role !== 'SUPER_ADMIN' || req.user.hrSuper) {
    throw boardRefusal(403, 'Only a Super Admin can open another login’s dashboard.');
  }
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw boardRefusal(404, 'That login does not exist.');
  if (isStrictSystemAccount(target)) throw boardRefusal(403, 'That is a Super Admin login. Your own dashboard already shows the whole company.');
  if ((target.status || 'Active') !== 'Active') {
    throw boardRefusal(403, `That login is ${String(target.status).toLowerCase()}. Only an active login's dashboard can be opened.`);
  }
  const identity = await resolveIdentity(target.id, target);
  if (!identity || !identity.products || !identity.products.ats) throw boardRefusal(400, `${target.name} has no ATS dashboard.`);
  // A person who has left cannot sign in any more (middleware/auth.js), so they have no dashboard to look at.
  if (require('./leftLogin').hasLeft(identity)) throw boardRefusal(400, `${target.name} has left, so their login is closed and has no dashboard.`); // eslint-disable-line global-require
  return identity;
}

// fn(subject) runs as the login whose dashboard is drawn: the Super Admin
// themself, or (with ?asUser) the picked login, read-only.
async function asBoardSubject(req, fn) {
  const subject = await boardSubject(req);
  if (subject === req.user) return fn(subject);
  return viewAs.readOnly(
    { byUserId: req.user.id, byName: req.user.name, readOnly: true, sid: null, dashboardOf: true },
    () => fn(subject),
  );
}

module.exports = { boardRefusal, boardSubject, asBoardSubject };
