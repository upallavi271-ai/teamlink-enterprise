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
// A BDE NEVER RECEIVES THE INSIDE OF THE RECRUITMENT (per-role spec
// 2026-10-03, hardened by the user's answers 2026-10-09):
//   * internal scores            match / resume / AI interview score
//   * internal notes             every candidate note (recruiter, TL ...)
//   * internal interview record  the panel's feedback, the panel itself, the
//                                AI interview tab: the CLIENT's feedback and
//                                the outcome stay
//   * candidate contact + pay    email, phone, current / expected salary
// Same response-filter approach as the client fields above, so every ATS payload
// is covered in one place.
//
// "Candidate contact and salary" is ALSO a Role Catalog switch (candidates /
// Candidate Contact & Salary / view): any role without it gets the contact and
// salary fields cut from every payload, whatever the role is. A BDE does not
// hold it by default. (req.user.caps.candidateContact, middleware/auth.js.)
// ---------------------------------------------------------------------------
const INTERNAL_SCORE_FIELDS = ['matchScore', 'resumeScore', 'aiInterviewScore', 'aiInterviewFeedback', 'aiScore', 'aiRecommendation',
  // B8: the Fit's version / explanation and the override reason are internal too.
  'matchVersion', 'matchDetail', 'overrideReason', 'overrideByName', 'overrideById'];
// The internal panel's own record + the AI interview: never a BDE's.
const BDE_INTERNAL_INTERVIEW_FIELDS = ['internalFeedback', 'panel', 'ai', 'aiCode', 'aiInterviewStatus', 'aiInterviewDeadline',
  'interviewScore', 'interviewFeedback', 'internalInterviewFeedback'];
// The offer's pay and its notes (the notes carry the salary in words): a BDE never reads them
// (security review 2026-10-09). The write side is untouched: a BDE can still type a joining CTC.
const BDE_OFFER_FIELDS = ['offerNotes', 'offeredCtc'];
const BDE_HIDDEN_FIELDS = new Set([...INTERNAL_SCORE_FIELDS, ...BDE_INTERNAL_INTERVIEW_FIELDS, ...BDE_OFFER_FIELDS]);
// Candidate profile details a BDE never receives (security review 2026-10-09): where the person lives,
// birth date, employer, education and the resume file name. Only on an object that IS a candidate.
const BDE_CANDIDATE_PRIVATE_FIELDS = new Set(['location', 'dob', 'currentCompany', 'education', 'specialization', 'institute', 'passingYear', 'resumeName']);
// Candidate contact + pay. FLAT = wherever they appear; CONTACT = only on an
// object that is a candidate (a key of that name on a user / client is not).
const CANDIDATE_FLAT_FIELDS = new Set(['candidateEmail', 'candidatePhone', 'candidateMobile', 'currentSalary', 'expectedSalary',
  'currentCtc', 'expectedCtc', 'currentCTC', 'expectedCTC', 'altPhone', 'alternatePhone', 'candidateWhatsapp',
  // salaryFit (utils/salaryFit.js): the hike % between current and expected pay is salary too.
  'salaryHikePct', 'candidateCurrentSalary', 'candidateExpectedSalary']);
const CANDIDATE_CONTACT_FIELDS = new Set(['email', 'phone', 'mobile', 'whatsapp', 'whatsApp', 'whatsappNumber', 'contactNumber']);
const CANDIDATE_CONTAINER_KEYS = new Set(['candidate', 'candidates', 'cand', 'applicant', 'applicants', 'duplicates', 'matches']);
const CANDIDATE_SHAPE_KEYS = ['experienceYears', 'noticePeriod', 'currentCompany', 'currentDesignation', 'resumeName', 'profileStatus', 'technicalSkills', 'candidateId',
  'currentStage', 'lifeStatus', 'applications', 'skills'];
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const looksLikeCandidate = (o) => hasKey(o, 'name') && CANDIDATE_SHAPE_KEYS.some((k) => hasKey(o, k));
const isNoteRow = (o) => hasKey(o, 'authorRole') && hasKey(o, 'body') && hasKey(o, 'candidateId');
// An InterviewFeedback row of the INTERNAL panel (the client's own is kind 'Client').
const isInternalFeedbackRow = (o) => o.kind === 'Internal' && hasKey(o, 'recommendation') && hasKey(o, 'overall');

// flags: { bde: cut the internal record for a BDE, contact: cut candidate contact + pay }
function sanitizeAts(value, flags, depth = 0, inCandidate = false) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(flags.bde && v && typeof v === 'object' && !Array.isArray(v) && (isNoteRow(v) || isInternalFeedbackRow(v))))
      .map((v) => sanitizeAts(v, flags, depth + 1, inCandidate));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const cand = inCandidate || looksLikeCandidate(value);
  const out = {};
  Object.keys(value).forEach((k) => {
    if (flags.bde && BDE_HIDDEN_FIELDS.has(k)) return;
    if (flags.bde && cand && BDE_CANDIDATE_PRIVATE_FIELDS.has(k)) return;
    if (flags.contact && (CANDIDATE_FLAT_FIELDS.has(k) || (cand && CANDIDATE_CONTACT_FIELDS.has(k)))) return;
    out[k] = sanitizeAts(value[k], flags, depth + 1, CANDIDATE_CONTAINER_KEYS.has(k));
  });
  return out;
}

// Back-compat name: the BDE cut (internal record + contact + pay).
function stripInternalForBde(value) {
  return sanitizeAts(value, { bde: true, contact: true });
}

// What this login must not receive. null = nothing to cut.
//   bde      the BDE team (BDE and the BDE TL): no internal record
//   contact  no candidate contact / pay: a BDE always, any other role when
//            the Role Catalog switch is off for it
function privacyFlagsFor(user) {
  if (!user) return null;
  // eslint-disable-next-line global-require
  const { clientViewRole } = require('./scope');
  // eslint-disable-next-line global-require
  const { isExternalLogin } = require('./permissions');
  if (isExternalLogin(user)) return null;
  const bde = clientViewRole(user) === 'bde';
  const contact = bde || !!(user.caps && user.caps.candidateContact === false);
  return bde || contact ? { bde, contact } : null;
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
    const flags = privacyFlagsFor(user);
    const cut = flags ? sanitizeAts(body, flags) : body;
    if (level === 'full' && isClientLogin(user)) return json(redactClients(cut, 0, 'client'));
    if (level === 'full') return json(cut);
    return json(redactClients(cut, 0, level));
  };
  next();
}

// For the ATS routers that are NOT under clientFieldGuard (clients, rejections ...):
// the same BDE / candidate-contact cut, without touching Client fields.
function atsPrivacyGuard(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    const flags = req.user ? privacyFlagsFor(req.user) : null;
    return json(flags ? sanitizeAts(body, flags) : body);
  };
  next();
}

module.exports = {
  clientFieldGuard,
  atsPrivacyGuard,
  sanitizeAts,
  privacyFlagsFor,
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
