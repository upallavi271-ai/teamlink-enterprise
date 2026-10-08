// ---------------------------------------------------------------------------
// WHO SEES HOW MUCH OF A CLIENT RECORD.
//
// "recruiters ki, TLs ki, ATS lo only client names & requirement matrame
// visible avvali; BDE team ki, inka higher authorities complete info visible
// avvali." — refined by the CLIENTS ROLE SPEC (2026-09-29) §5 / §6:
//
//   level     who                          what of a Client row
//   full      Admin, Management, BDE,      everything (secrets are never sent
//             a CLIENT on its own company  by any route anyway)
//   billing   Accounts                     everything EXCEPT the non-billing
//                                          contacts: the billing contact only
//   names     TL                           overview (industry, address, owner
//                                          BDE, status …) + contact NAMES —
//                                          no phone, no e-mail, no GSTIN / PAN,
//                                          no fee %, guarantee or terms
//   min       Recruiter, STL, HR, anyone   the client's NAME (+ id / owning
//             else                         department / agreement status /
//                                          type / status the screens gate on)
//
// PER-ROLE SPEC (2026-10-03) — newest wins:
//   full      Super Admin, Admin, a Manager (their departments), BDE, Client
//   status    Assistant Manager: name, owner, open jobs, agreement STATUS —
//             no contacts, no commercial terms, no revenue
//   basics    STL: name + basics (overview) — no contacts, no agreement
//             terms, no revenue
//   min       TL ("client NAME only where needed"), Recruiter (the user:
//             "only the client name and the requirement" — no contact of any
//             kind), HR, everyone else
// The old 'names' level (TL contact names) is no longer handed out.
//
// "Client phone / email never shown to a Recruiter" and "fee %, guarantee
// period, payment terms only for BDE, Accounts, Admin, Mgmt" are exactly the
// min / names levels above.
//
// The LEVEL is decided from the ATS scope role (utils/scope.js atsViewRole)
// — one answer shared with routes/clients.js, which shapes its own payloads
// with redactClientFor() below.
//
// Applied as a response filter on the ATS APIs (index.js), so every payload
// that embeds a client — `include: { client: true }` on requirements,
// applications, interviews, follow-ups, the dashboard, search — is covered in
// one place rather than by forty per-route edits that the next route forgets.
// A Client row is recognised by columns only a Client carries, whatever key it
// sits under.
// ---------------------------------------------------------------------------

const CLIENT_SAFE_FIELDS = ['id', 'name', 'ownerDepartment', 'agreementStatus', 'clientType', 'status'];
// The Overview a TL may read (§5 Overview 👁: industry, address, owner BDE).
const CLIENT_OVERVIEW_FIELDS = [
  ...CLIENT_SAFE_FIELDS, 'legalName', 'clientCode', 'displayCode', 'industry', 'location', 'priority', 'website',
  'houseNumber', 'street', 'landmark', 'area', 'pincode', 'country', 'state', 'accountManager', 'bdeOwner',
  'createdAt', 'activeDate', 'yearEstablished', 'permissions',
];
// Contact NAMES (TL: "names only").
const CLIENT_CONTACT_NAME_FIELDS = [
  'contactName', 'contactDesignation', 'secondaryContactName', 'secondaryContactDesignation',
  'recruitmentContactName', 'recruitmentContactDesignation',
];
// Direct contact details of the client's people — never a Recruiter's or a
// TL's; Accounts keeps only the billing contact.
const CLIENT_CONTACT_DETAIL_FIELDS = [
  'contactPhone', 'contactEmail', 'contactWhatsApp', 'secondaryContactPhone', 'secondaryContactEmail',
  'recruitmentContactEmail', 'recruitmentContactPhone', 'landline', 'commPrimary', 'commSecondary', 'commChannels',
];
// Commercial terms and statutory ids (§6: BDE, Accounts, Admin, Mgmt only).
const CLIENT_COMMERCIAL_FIELDS = [
  'gst', 'pan', 'tan', 'businessType', 'tdsPercent', 'gstPercent', 'paymentTerms', 'guaranteePeriod', 'invoiceTrigger',
  'paymentDue', 'commercialNotes', 'agreementFeePercent', 'agreementDocument', 'agreementTemplate', 'agreementId',
  'agreementStart', 'agreementEnd', 'agreementActivatedAt', 'agreementSignedBy', 'agreementSignedByTitle',
  'riskFlag', 'riskNotes',
];
// SPEC 6 (2026-10-03) — the agreement as an Assistant Manager VIEWS it: the
// step, dates, the document and its terms (fee %, guarantee, payment terms).
// No contacts, no GSTIN / PAN, no revenue (revenue is never a client column).
const CLIENT_AGREEMENT_VIEW_FIELDS = [
  'agreementId', 'agreementStatus', 'agreementStart', 'agreementEnd', 'agreementActivatedAt', 'agreementTemplate',
  'agreementDocument', 'agreementSource', 'agreementSentAt', 'agreementViewedAt', 'agreementSignedAt',
  'agreementSignedBy', 'agreementSignedByTitle', 'agreementSignedCopyName', 'agreementRejectedAt',
  'agreementRejectedReason', 'agreementFeePercent', 'guaranteePeriod', 'paymentTerms', 'paymentDue', 'invoiceTrigger',
];
// Columns that exist on Client and nowhere else in the schema.
const CLIENT_MARKERS = ['agreementFeePercent', 'esignToken', 'agreementDocument', 'guaranteePeriod', 'invoiceTrigger', 'contactName', 'gst'];

function isClientRow(o) {
  return CLIENT_MARKERS.some((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function pick(o, fields) {
  const out = {};
  fields.forEach((k) => { if (o[k] !== undefined) out[k] = o[k]; });
  return out;
}

function slimClient(o) {
  return pick(o, CLIENT_SAFE_FIELDS);
}

// The level for a login. `user.caps.clientDetail` (middleware/auth.js) is the
// matrix's Commercial Terms view — Admin, Management, BDE, Accounts.
function clientLevelFor(user) {
  if (!user) return 'min';
  // eslint-disable-next-line global-require
  const { clientViewRole } = require('./scope');
  const role = clientViewRole(user);
  if (role === 'mgmt') {
    // eslint-disable-next-line global-require
    const { atsScopeOf } = require('./scope');
    return atsScopeOf(user).atsRole === 'ASSISTANT_MANAGER' ? 'status' : 'full';
  }
  if (role === 'admin' || role === 'bde' || role === 'client') return 'full';
  if (role === 'accounts') return 'billing';
  if (role === 'stl') return 'basics';
  // A login with no ATS role that is nevertheless the billing desk (an
  // Accountant without ATS reaching a shared endpoint) keeps the billing view.
  if (user.caps && user.caps.clientDetail) return 'billing';
  return 'min';
}

// 2026-10-05 — a CLIENT login never receives TeamLink's internal notes about
// it (Add client section 9) nor the bank-account fields; nobody receives the
// encrypted account number. ('client' is a cut of 'full'.)
const CLIENT_INTERNAL_FIELDS = ['internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks',
  'bankAccountHolder', 'bankAccountNoEnc', 'bankAccountLast4', 'bankAccountMasked', 'bankIfsc'];
const isClientLogin = (user) => {
  // eslint-disable-next-line global-require
  try { return require('./scope').atsViewRole(user) === 'client'; } catch { return false; }
};

// One Client row, cut to a level.
function redactClientRow(o, level) {
  if (!o || typeof o !== 'object') return o;
  if (level === 'client') {
    const out = { ...o };
    CLIENT_INTERNAL_FIELDS.forEach((k) => { delete out[k]; });
    return out;
  }
  if (level === 'full') return o;
  if (level === 'billing') {
    const out = { ...o };
    [...CLIENT_CONTACT_DETAIL_FIELDS, ...CLIENT_CONTACT_NAME_FIELDS].forEach((k) => { delete out[k]; });
    return out;
  }
  if (level === 'names') return pick(o, [...CLIENT_OVERVIEW_FIELDS, ...CLIENT_CONTACT_NAME_FIELDS]);
  if (level === 'basics') return pick(o, CLIENT_OVERVIEW_FIELDS);
  if (level === 'status') return pick(o, [...CLIENT_SAFE_FIELDS, 'bdeOwner', 'accountManager', 'permissions', 'displayCode', 'clientCode', ...CLIENT_AGREEMENT_VIEW_FIELDS]);
  return slimClient(o);
}

// ---------------------------------------------------------------------------
// A BDE NEVER RECEIVES RECRUITER NOTES OR INTERNAL SCORES (per-role spec
// 2026-10-03: "Hidden: other BDEs' clients, recruiter notes, internal
// scores"). Same response-filter approach as the client fields above, so
// every ATS payload is covered in one place.
// ---------------------------------------------------------------------------
const INTERNAL_SCORE_FIELDS = ['matchScore', 'resumeScore', 'aiInterviewScore', 'aiInterviewFeedback', 'aiScore', 'aiRecommendation',
  // B8: the Fit's version / explanation and the override reason are internal too.
  'matchVersion', 'matchDetail', 'overrideReason', 'overrideByName', 'overrideById'];
const RECRUITER_NOTE_ROLES = ['RECRUITER', 'EMPLOYEE'];
const isNoteRow = (o) => Object.prototype.hasOwnProperty.call(o, 'authorRole') && Object.prototype.hasOwnProperty.call(o, 'body') && Object.prototype.hasOwnProperty.call(o, 'candidateId');
function stripInternalForBde(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === 'object' && !Array.isArray(v) && isNoteRow(v) && RECRUITER_NOTE_ROLES.includes(String(v.authorRole || '').toUpperCase())))
      .map((v) => stripInternalForBde(v, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  Object.keys(value).forEach((k) => {
    if (INTERNAL_SCORE_FIELDS.includes(k)) return;
    out[k] = stripInternalForBde(value[k], depth + 1);
  });
  return out;
}

function redactClients(value, depth = 0, level = 'min') {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactClients(v, depth + 1, level));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // Date, Buffer, …
  if (isClientRow(value)) return redactClientRow(value, level);
  const out = {};
  Object.keys(value).forEach((k) => { out[k] = redactClients(value[k], depth + 1, level); });
  return out;
}

// For routes/clients.js: one client record (or a list of them) as this login
// may see it.
function redactClientFor(user, client) {
  const level = isClientLogin(user) ? 'client' : clientLevelFor(user);
  if (Array.isArray(client)) return client.map((c) => redactClientRow(c, level));
  return redactClientRow(client, level);
}

// Express middleware: wraps res.json. The decision is taken when the route
// answers, by which time the route's own requireAuth has resolved req.user.
function clientFieldGuard(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    const user = req.user;
    if (!user) return json(body);
    const level = clientLevelFor(user);
    // eslint-disable-next-line global-require
    const bde = require('./scope').clientViewRole(user) === 'bde';
    const cut = bde ? stripInternalForBde(body) : body;
    if (level === 'full' && isClientLogin(user)) return json(redactClients(cut, 0, 'client'));
    if (level === 'full') return json(cut);
    return json(redactClients(cut, 0, level));
  };
  next();
}

module.exports = {
  clientFieldGuard,
  redactClients,
  redactClientFor,
  redactClientRow,
  clientLevelFor,
  stripInternalForBde,
  CLIENT_SAFE_FIELDS,
  CLIENT_OVERVIEW_FIELDS,
  CLIENT_CONTACT_NAME_FIELDS,
  CLIENT_CONTACT_DETAIL_FIELDS,
  CLIENT_COMMERCIAL_FIELDS,
  CLIENT_AGREEMENT_VIEW_FIELDS,
  CLIENT_INTERNAL_FIELDS,
};
