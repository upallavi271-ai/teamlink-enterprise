// ---------------------------------------------------------------------------
// CLIENT + CANDIDATE PORTAL ISOLATION (security review, Batch 1, 2026-10-09).
//
// A client login (role / atsRole CLIENT) and a candidate login (CANDIDATE) are
// ordinary User rows whose token is signed with the STAFF secret, so before
// this guard such a token could read ~76 staff GET routes (announcements,
// documents, departments, io modules, leave types, helpdesk meta …). Vendor
// and partner sessions were already walled off (utils/vendorAuth.js,
// utils/partnerAuth.js: own secret + a global deny-by-default guard). This is
// the same wall for the two portals that share the staff secret:
//
//   * DENY BY DEFAULT. A token of kind CLIENT or CANDIDATE may call ONLY the
//     paths in ALLOW below, with the listed methods — every other /api path
//     answers 403, for every method (also POST / PUT / PATCH / DELETE).
//   * The allow-list is exactly what the two portals' screens call (read from
//     pages/portal/ClientPortal.jsx, pages/CandidateHome.jsx, the Shell's
//     notification bell, agreement view/PDF, Profile, sign-in) plus the public,
//     token-keyed pages a logged-in browser may also open (agreement signing,
//     offer link, careers) because the frontend's axios attaches the stored
//     token to every call.
//   * Two layers, one rule (isAllowed):
//       1. externalSessionGuard — global, in index.js ahead of every router.
//          Reads the (unverified) claims: a forged "CLIENT" claim can only ever
//          make a request MORE restricted, never less.
//       2. requireAuth (middleware/auth.js) re-checks with the identity read
//          from the database, so a token minted before somebody's role changed
//          cannot keep staff reach.
//   * Super Admin "View as" a client/candidate carries the same claims and gets
//     the same wall (+ the one POST that ends the View-as session).
//
// Nothing here changes login or session logic.
// ---------------------------------------------------------------------------
const jwt = require('jsonwebtoken');

const EXTERNAL = ['CLIENT', 'CANDIDATE'];

// 'CLIENT' | 'CANDIDATE' | null from claims or a resolved identity.
function kindOf(who) {
  if (!who || typeof who !== 'object') return null;
  if (who.role === 'CLIENT' || who.atsRole === 'CLIENT') return 'CLIENT';
  if (who.role === 'CANDIDATE' || who.atsRole === 'CANDIDATE') return 'CANDIDATE';
  return null;
}

const ANY = '*';
const id = '[^/]+';

// [methods, regex over the path WITHOUT query string and trailing slash]
// Paths are matched case-sensitively on purpose: the real screens always use
// the exact spelling, and a different spelling is only ever an attack.
const COMMON = [
  // Own sign-in, profile, password (routes/auth.js — every route there is the caller's own).
  [ANY, /^\/api\/auth(\/.*)?$/],
  // Public, token-keyed pages (no staff data): careers, set-password, agreement/offer signing links.
  [ANY, /^\/api\/public(\/.*)?$/],
  [ANY, /^\/api\/portal\/public(\/.*)?$/],
  [ANY, /^\/api\/offer-link(\/.*)?$/],
  [ANY, new RegExp(`^/api/agreement/token/${id}(/.*)?$`)],
  [['POST'], new RegExp(`^/api/agreement/emudhra/return/${id}/${id}$`)],
  [['GET'], /^\/api\/health$/],
  // The bell + the Notifications page: each login's OWN rows (routes/admin.js filters by req.user.id).
  [['GET'], /^\/api\/admin\/notifications(\/popups)?$/],
  [['PATCH'], new RegExp(`^/api/admin/notifications/${id}/read$`)],
  [['POST'], /^\/api\/admin\/notifications\/read-all$/],
  // Ends a Super Admin "View as" session (called with the View-as token).
  [['POST'], /^\/api\/admin\/view-as\/exit$/],
];

const ALLOW = {
  CLIENT: [
    ...COMMON,
    // Everything the client portal shows and does (routes/portal.js).
    [ANY, /^\/api\/portal\/client(\/.*)?$/],
    // Decide on a candidate (pages/ats/ClientJobPortal.jsx + portal/ClientPortal.jsx).
    [['GET'], /^\/api\/job-portal\/client$/],
    [['POST'], new RegExp(`^/api/job-portal/client/applications/${id}/decision$`)],
    // The client records feedback on ONE of its own interviews (route checks the
    // interview belongs to the client's company). Added at the client-portal
    // ticks task's request; this single POST only.
    [['POST'], new RegExp(`^/api/ats/interviews/${id}/client-feedback$`)],
    // "View my agreement": read + download the PDF/files (AgreementPanel.jsx). Read-only.
    [['GET'], new RegExp(`^/api/agreement/(?!list$|settings$|token$|emudhra$)${id}(/(pdf|versions|executed))?$`)],
    [['GET'], new RegExp(`^/api/agreement/(?!list$|settings$|token$|emudhra$)${id}/file/${id}$`)],
  ],
  CANDIDATE: [
    ...COMMON,
    // Everything the candidate portal shows and does (routes/portal.js).
    [ANY, /^\/api\/portal\/candidate(\/.*)?$/],
  ],
};

const apiPathOf = (urlLike) => {
  let p = String(urlLike || '').split('?')[0].split('#')[0];
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
};
const isApiPath = (p) => /^\/api(\/|$)/i.test(p);

// The one rule. kind: 'CLIENT' | 'CANDIDATE'. Non-/api paths are not this
// guard's business (static files, the /jobs proxy, the device endpoint).
function isAllowed(kind, method, urlLike) {
  const p = apiPathOf(urlLike);
  if (!isApiPath(p)) return true;
  const rules = ALLOW[kind];
  if (!rules) return true; // not an external kind: not restricted here
  const m = String(method || 'GET').toUpperCase();
  const mm = m === 'HEAD' ? 'GET' : m;
  return rules.some(([methods, re]) => (methods === ANY || methods.includes(mm) || (m === 'OPTIONS')) && re.test(p));
}

const DENY = { error: 'Forbidden. This login can open only its own portal.', externalPortal: true };

function bearerOf(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function logDenied(kind, req) {
  if (process.env.TL_EXTERNAL_GUARD_LOG === '1') console.warn(`[external-guard] ${kind} ${req.method} ${req.originalUrl} -> 403`);
}

// Layer 1: global, ahead of every router.
function externalSessionGuard(req, res, next) {
  const token = bearerOf(req);
  if (!token) return next();
  const p = apiPathOf(req.originalUrl || req.url);
  if (!isApiPath(p)) return next();
  let kind = null;
  try { kind = kindOf(jwt.decode(token)); } catch { kind = null; }
  if (!kind) return next();
  if (isAllowed(kind, req.method, p)) return next();
  logDenied(kind, req);
  return res.status(403).json(DENY);
}

// Layer 2: inside requireAuth, with the identity from the database.
function identityAllowed(identity, req) {
  const kind = kindOf(identity);
  if (!kind) return true;
  return isAllowed(kind, req.method, req.originalUrl || req.url);
}
function denyIdentity(req, res, identity) {
  logDenied(kindOf(identity), req);
  return res.status(403).json(DENY);
}

module.exports = { EXTERNAL, ALLOW, kindOf, isAllowed, externalSessionGuard, identityAllowed, denyIdentity, apiPathOf };
