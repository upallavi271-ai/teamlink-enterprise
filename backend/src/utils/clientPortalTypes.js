// ---------------------------------------------------------------------------
// CLIENT PORTAL RIGHTS — TICK BOXES (user, 2026-10-09; before that, spec B1's
// three fixed types). A client login carries a list of ticks on
// User.portalPerms (comma list); the old User.portalType stays readable and is
// now a LABEL derived from the ticks: REVIEWER / VIEWER / BILLING when the ticks
// equal that preset exactly, CUSTOM otherwise.
//
//   VIEW       See our jobs and candidates (+ interviews, who joined, company
//              reports, downloading the shared resume)
//   REQUEST    Ask for a new job (POST /portal/client/requirement-requests)
//   DECIDE     Shortlist, hold or reject candidates (the decision route)
//   INTERVIEW  Ask for an interview with a candidate (the decision route,
//              REQUEST_INTERVIEW)
//   FEEDBACK   Give feedback after an interview (POST /ats/interviews/:id/client-feedback)
//   OFFERS     Release the offer letter and the joining letter, confirm the candidate's acceptance and
//              the joining (2026-10-13). OFF unless a login is given it: an older login with no ticks
//              does NOT get it (routes/portal.js offersTick). Needs VIEW.
//   AGREEMENT  See our agreement (and sign it by its secure link)
//   INVOICES   See invoices and payments
//
// DECIDE / INTERVIEW / FEEDBACK need VIEW (you cannot decide on what you cannot
// see): normalise() adds it. REQUEST and INVOICES stand alone — a login with
// only "Ask for a new job" is allowed.
//
// ENFORCED SERVER-SIDE inside can() (utils/permissions.js 2c) so every
// /api/portal/*, /api/job-portal/client* and client-feedback route obeys it, and
// the matrix the browser draws buttons from does too. Routes with a finer split
// than one can() action (the decision route) re-check with hasCap().
//
// A login with neither portalPerms nor a portalType (created before types
// existed) keeps exactly the access it had.
//
// Only ever NARROWS: this runs after the role matrix has said yes.
// ---------------------------------------------------------------------------
const CAPS = [
  { key: 'VIEW', group: 'Look', label: 'See our requirements and candidates', hint: 'View only. Also shows interviews, who joined and company reports.' },
  { key: 'AGREEMENT', group: 'Look', label: 'See our agreement', hint: 'Open the agreement with TeamLink and sign it when it is waiting.' },
  { key: 'INVOICES', group: 'Look', label: 'See invoices and payments', hint: 'Bills from TeamLink, due dates and whether they are paid.' },
  { key: 'REQUEST', group: 'Do', label: 'Ask for a new requirement', hint: 'Send TeamLink a request for a new hire.' },
  { key: 'DECIDE', group: 'Do', label: 'Shortlist, hold or reject candidates', hint: 'Give a yes, a wait or a no on the people we send.' },
  { key: 'INTERVIEW', group: 'Do', label: 'Ask for an interview', hint: 'Tell us you want to meet a candidate and suggest days and times.' },
  { key: 'FEEDBACK', group: 'Do', label: 'Give feedback after an interview', hint: 'Tell us how the interview went: selected, hold or rejected.' },
  { key: 'OFFERS', group: 'Do', label: 'Send offer and joining letters', hint: 'Upload your offer letter and joining letter for a selected candidate, and confirm when they accept or join.' },
];
const CAP_KEYS = CAPS.map((c) => c.key);
const NEEDS_VIEW = ['DECIDE', 'INTERVIEW', 'FEEDBACK', 'OFFERS'];

// The three old types, now only quick starting points.
const PORTAL_TYPES = ['REVIEWER', 'VIEWER', 'BILLING'];
const PRESET_CAPS = {
  REVIEWER: ['VIEW', 'AGREEMENT', 'REQUEST', 'DECIDE', 'INTERVIEW', 'FEEDBACK'],
  VIEWER: ['VIEW', 'AGREEMENT'],
  BILLING: ['INVOICES'],
};
const PORTAL_TYPE_LABELS = {
  REVIEWER: 'Reviewer — shortlist / reject / feedback, ask for interviews, ask for requirements',
  VIEWER: 'Viewer — view only',
  BILLING: 'Billing — invoices only',
};
const READ_ACTIONS = ['view', 'export'];

const isClientLogin = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT');

// Any input (array / comma string) -> clean, ordered, de-duplicated key list,
// with VIEW added where a tick needs it. Unknown keys are dropped.
function normalise(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const set = new Set(raw.map((x) => String(x || '').trim().toUpperCase()).filter((x) => CAP_KEYS.includes(x)));
  if (NEEDS_VIEW.some((k) => set.has(k))) set.add('VIEW');
  return CAP_KEYS.filter((k) => set.has(k));
}
const serialise = (caps) => normalise(caps).join(',');

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// REVIEWER / VIEWER / BILLING when the ticks equal that preset, else CUSTOM.
function typeFor(caps) {
  const c = normalise(caps);
  return PORTAL_TYPES.find((t) => sameSet(c, normalise(PRESET_CAPS[t]))) || 'CUSTOM';
}

// What a login may do: an array of keys, or null for an older full-access login.
function capsOf(user) {
  if (!user) return null;
  const stored = typeof user.portalPerms === 'string' ? normalise(user.portalPerms) : [];
  if (stored.length) return stored;
  const t = user.portalType;
  if (t && PRESET_CAPS[t]) return normalise(PRESET_CAPS[t]);
  return null;
}

// Does this login hold the tick? (null caps = an older login = yes, apart from
// invoices, which that login's role matrix alone decides.)
function hasCap(user, key) {
  if (!isClientLogin(user)) return true;
  const caps = capsOf(user);
  if (!caps) return true;
  return caps.includes(key);
}

// Short words for the list / mail: "See jobs · Ask for a job · …"
const CHIP_WORDS = {
  VIEW: 'See requirements and candidates', AGREEMENT: 'See agreement', INVOICES: 'See invoices',
  REQUEST: 'Ask for a requirement', DECIDE: 'Shortlist / reject', INTERVIEW: 'Ask for interviews', FEEDBACK: 'Give feedback', OFFERS: 'Send offer / joining letters',
};
const chipsOf = (caps) => normalise(caps).map((k) => CHIP_WORDS[k]);
const TYPE_WORDS = { REVIEWER: 'Reviewer', VIEWER: 'Viewer', BILLING: 'Billing', CUSTOM: 'Custom' };
function labelFor(user) {
  const caps = capsOf(user);
  if (!caps) return 'Full access (older login)';
  return TYPE_WORDS[typeFor(caps)];
}

function portalTypeAllows(user, moduleId, feature, action) {
  if (!isClientLogin(user)) return true;
  const caps = capsOf(user);
  if (!caps) return true; // older login: unchanged
  const has = (k) => caps.includes(k);
  const read = READ_ACTIONS.includes(action);
  // 'Invoices' is the legacy accounts feature; can() resolves it to the split
  // module accounts_invoices (utils/roleAccess.js LEGACY_INDEX), so both names
  // count. TDS certificates / client agreements are not "invoices".
  const invoices = feature === 'Invoices'
    || (moduleId === 'accounts_invoices' && ['Invoice Register', 'Joining Invoices'].includes(feature));
  if (invoices) return has('INVOICES') && read;
  switch (feature) {
    case 'Client Job Portal':
      if (read) return has('VIEW');
      if (action === 'edit') return has('DECIDE') || has('INTERVIEW');
      return false;
    case 'Client Reports':
      return read && has('VIEW');
    case 'Requirement Request':
      if (action === 'create') return has('REQUEST');
      return action === 'view' && (has('REQUEST') || has('VIEW'));
    case 'Client Feedback':
      return ['create', 'edit'].includes(action) && has('FEEDBACK');
    case 'Agreement Lifecycle':
      // signing / returning from inside the app: the older Reviewer right.
      return action === 'approve' && has('AGREEMENT') && has('DECIDE');
    default:
      break;
  }
  // Anything else the CLIENT role holds (the dashboard tile set …).
  const nonInvoice = caps.some((k) => k !== 'INVOICES');
  if (moduleId === 'dashboard') return nonInvoice ? (read || has('DECIDE')) : action === 'view';
  if (!nonInvoice) return false;
  if (read) return true;
  return has('DECIDE');
}

module.exports = {
  CAPS, CAP_KEYS, PORTAL_TYPES, PRESET_CAPS, PORTAL_TYPE_LABELS,
  normalise, serialise, typeFor, capsOf, hasCap, chipsOf, labelFor,
  portalTypeAllows, isClientLogin,
};
