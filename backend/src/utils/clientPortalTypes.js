// ---------------------------------------------------------------------------
// CLIENT PORTAL LOGIN TYPES (spec B1, 2026-10-03). A client login carries one
// of three types on User.portalType, enforced SERVER-SIDE inside can()
// (utils/permissions.js), so every /api/portal/* and /api/job-portal/client*
// route — and the matrix the browser draws buttons from — obeys it:
//
//   REVIEWER  hiring manager: shortlist / hold / reject / request interview,
//             interview feedback, confirm interviews, request a new job.
//             No invoices.
//   VIEWER    read only — sees jobs, shared candidates, interviews, feedback.
//             No decisions, no invoices.
//   BILLING   invoices only (and the company card the portal shows them).
//
// A client login created before types existed (Administration -> Users,
// portalType null) keeps exactly the access it had — "existing client logins
// keep working".
//
// Only ever NARROWS: this runs after the role matrix has said yes.
// ---------------------------------------------------------------------------
const PORTAL_TYPES = ['REVIEWER', 'VIEWER', 'BILLING'];
const PORTAL_TYPE_LABELS = {
  REVIEWER: 'Reviewer — shortlist / reject / feedback, confirm interviews',
  VIEWER: 'Viewer — view only',
  BILLING: 'Billing — invoices only',
};
const READ_ACTIONS = ['view', 'export'];

const isClientLogin = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT');

function portalTypeAllows(user, moduleId, feature, action) {
  if (!isClientLogin(user)) return true;
  const t = user.portalType;
  if (!t || !PORTAL_TYPES.includes(t)) return true; // legacy login: unchanged
  // 'Invoices' is the legacy accounts feature; can() resolves it to the split
  // module accounts_invoices (utils/roleAccess.js LEGACY_INDEX), so both names
  // count. TDS certificates / client agreements are not "invoices".
  const invoices = feature === 'Invoices'
    || (moduleId === 'accounts_invoices' && ['Invoice Register', 'Joining Invoices'].includes(feature));
  if (t === 'BILLING') {
    if (invoices) return READ_ACTIONS.includes(action);
    // The dashboard tile set every login sees (no data of its own).
    return moduleId === 'dashboard' && action === 'view';
  }
  if (invoices) return false;
  if (t === 'VIEWER') return READ_ACTIONS.includes(action);
  return true; // REVIEWER
}

module.exports = { PORTAL_TYPES, PORTAL_TYPE_LABELS, portalTypeAllows, isClientLogin };
