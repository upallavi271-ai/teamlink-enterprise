const express = require('express');
const prisma = require('../db');
const joinDayShared = require('../utils/joinDayShared');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  // atsScopeOf: a Manager / Asst Manager is held to their departments in ATS
  // (per-role spec 2026-10-03), so `global` here is Super Admin / Admin only.
  clientWhere, clientPickerWhere, requirementWhere, applicationWhere, atsScopeOf: scopeOf, OUT_OF_SCOPE, clientViewRole, teamRequirementWhere, isBdeTl,
} = require('../utils/scope');
// "Name · Position" for the client's BDE (user, 2026-10-09) — utils/bdeSeats.js.
const { bdeDirectory, bdeDepartmentProblem } = require('../utils/bdeSeats');
const { canonicalDepartment, parseBdeSeat } = require('../utils/bdeDesk');
const { logAudit, logFieldChanges } = require('../utils/audit');
const { redactClientFor, clientLevelFor } = require('../utils/clientRedact');
const clientSearch = require('../utils/clientSearch');
const { notifyUsers } = require('../utils/notify');
const {
  buildAgreementDocument, nextAgreementId, withAgreementId, newEsignToken, consultantParty, keyTermsOf, madeOnPatch,
} = require('../utils/agreement');
const vendorAgreement = require('../utils/vendorAgreement');
const agreementLifecycle = require('../utils/agreementLifecycle');
const agreementSigning = require('../utils/agreementSigning');
const agreementAttachments = require('../utils/attachments');
const {
  normalizeAgreementStatus, agreementIsSigned, agreementIsActive, requirementIsLive,
  applicationIsOverdue, applicationDueDate, STAGE_OWNER_ACTION,
  JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE,
} = require('../utils/atsVocab');
const { invoiceWhere } = require('../utils/scope');
const { invoiceOutstanding, invoiceTotal } = require('../utils/accounts');
// B9.9: "invoiced" net of issued credit / debit notes (utils/creditNotes.js decorateNet).
const CNU = require('../utils/creditNotes');
// B9.2: the client's own SLA ("Feedback within N days", "Send first profiles within N days").
const CS = require('../utils/clientSla');
const { findClientDuplicates, describeMatches, displayCode } = require('../utils/clientDuplicates');
// One company, many locations (2026-10-22): the friendly "already exists - add another location?" question and the Name - Location labels.
const CLOC = require('../utils/clientLocations');
// Client Pause / Archive / Delete (spec 2026-10-03 §A) — utils/clientLifecycle.js.
const clientLifecycle = require('../utils/clientLifecycle');
// ATS layout v3 — the job status chain shown to people (display only).
const reqDisplay = require('../utils/requirementDisplayStatus');
// Spec section 6 — the agreement template defaults (Admin settings).
const agreementSettingsStore = require('../utils/agreementSettings');
// Add client in 9 sections (2026-10-05): new fields, rules, documents.
const clientProfile = require('../utils/clientProfile');
// Agreement preparation workflow (2026-10-13): Draft > With Purna Sir > With BDE TL > Sent > Signed > Active.
const AWF = require('../utils/agreementWorkflow');

const router = express.Router();
router.use(requireAuth);
// GET /clients/aliases — the OLD names of the clients THIS login may see by name: { rows: [{ name, aliases: [..] }] }.
// For the browser's type-to-search only (utils/clientSearch.js; frontend components/clientAliases.js): typing an old name in ANY
// client box finds the client, which is still listed under its official `name`. Same client scope as the Client picker
// (names only, never a record); a client login and a login with no client scope get an empty list. Mounted ahead of the
// Client List permission on purpose: a recruiter / TL / accountant reads client NAMES on their own screens, so they may type old ones.
router.get('/aliases', async (req, res, next) => {
  try {
    if (roleOf(req.user) === 'client') return res.json({ rows: [] });
    const map = await clientSearch.aliasMap();
    const ids = [...map.keys()];
    // 2026-10-22: the clients (of this login's scope) that share their name with another client -> "Name - Location" for every box.
    const places = await CLOC.placeRows({ AND: [clientPickerWhere(req.user), { OR: [{ status: null }, { status: { not: 'Archived' } }] }] }).catch(() => []);
    if (!ids.length) return res.json({ rows: [], places });
    const found = await prisma.client.findMany({
      where: { AND: [clientPickerWhere(req.user), { id: { in: ids } }, { OR: [{ status: null }, { status: { not: 'Archived' } }] }] },
      select: { id: true, name: true },
    });
    const rows = found
      .map((c) => ({ name: c.name, aliases: (map.get(c.id) || []).filter((a) => a.toLowerCase() !== String(c.name).toLowerCase()) }))
      .filter((r) => r.aliases.length);
    return res.json({ rows, places });
  } catch (err) { return next(err); }
});
// THE HR DESK works internal hiring only: no client, client detail or agreement (utils/hrDesk.js).
router.use(require('../utils/hrDesk').blockHrDesk);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
// (P10) the plain Accounts desk reads clients too: requirePerm below decides.
router.use((req, res, next) => (require('../utils/permissions').accountsClientReader(req.user) ? next() : requireProduct('ats')(req, res, next))); // eslint-disable-line global-require
router.use(requirePerm('ats', 'clients', 'Client List', 'view'));

// ---------------------------------------------------------------------------
// VIEW != EDIT. Per-record permissions are resolved here, server-side, and
// shipped on the payload so the screen renders exactly the buttons the API
// would honour. The six the brief names map onto the engine's action set:
//
//   VIEW    -> clients/Client Detail/view          (+ data scope)
//   EDIT    -> clients/Client Detail/edit
//   APPROVE -> clients/Agreement Lifecycle/approve (the client e-signs)
//   ASSIGN  -> clients/Client Detail/assign        (account manager / BDE)
//   SHARE   -> clients/Agreement Lifecycle/create  (send the agreement out)
//   EXPORT  -> clients/Client List/export
//
// There is no second permission path: every line below is a can() call.
// ---------------------------------------------------------------------------
async function clientPermissions(user) {
  const [view, edit, approve, assign, share, exportable, terms, lifecycle, del] = await Promise.all([
    can(user, 'ats', 'clients', 'Client Detail', 'view'),
    can(user, 'ats', 'clients', 'Client Detail', 'edit'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'approve'),
    can(user, 'ats', 'clients', 'Client Detail', 'assign'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'create'),
    can(user, 'ats', 'clients', 'Client List', 'export'),
    can(user, 'ats', 'clients', 'Commercial Terms', 'edit'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'),
    can(user, 'ats', 'clients', 'Client Detail', 'delete'),
  ]);
  return { view, edit, approve, assign, share, export: exportable, commercialTerms: terms, lifecycle, delete: del };
}

// A client login sees its OWN company and its own related data — and never a
// fee, a salary internal, a recruiter note or an AI evaluation.
const isClient = (user) => scopeOf(user).role === 'CLIENT';

// Every /:id endpoint below — read and write — is scope-checked in one place
// against the SAME clientWhere() the list query uses, so a client login can
// never reach another client's record by URL and a recruiter can never reach
// a client they hold no requirement for.
router.param('id', async (req, res, next, id) => {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const inScope = await prisma.client.findFirst({
    where: { AND: [{ id }, clientWhere(req.user)] },
    select: { id: true },
  });
  if (!inScope) return res.status(403).json(OUT_OF_SCOPE);
  // A recruiting TL sees client names only (2026-10-29): no client page, nothing on it. Not the BDE TL (a BDE reader).
  if (scopeOf(req.user).atsRole === 'TL' && !(await can(req.user, 'ats', 'clients', 'Client Detail', 'view'))) {
    return res.status(403).json({ error: 'Client details are for the BDE team. Your requirements show the client name.', code: 'names_only' });
  }
  req.client = client;
  return next();
});

// Normalise the stored status on the way out so a row written before this
// round (CONFIRMED / CANCELLED) renders in the current vocabulary.
// NEVER SENT: the tokenised signing link's token and the OTP hash. Anyone
// holding the token can open the client's signing page, and the list went to
// every client-desk login. The signing link is handed back only to those who
// may run the agreement lifecycle (signingPath on GET /:id).
const CLIENT_SECRETS = ['esignToken', 'agreementOtpHash', 'agreementOtpExpiresAt', 'agreementOtpAttempts'];
// Not needed by a LIST row: the full agreement text and the uploaded seal /
// signature images. GET /:id still carries them.
const CLIENT_HEAVY = [
  'agreementDocument', 'agreementCompanyStampFile', 'agreementCompanySignFile',
  'agreementClientStampFile', 'agreementClientSignFile',
];
// BDE business workspace (2026-10-10): what a BDE does NOT get of a colleague's client.
const COLLEAGUE_HIDDEN = [
  'gst', 'pan', 'tan', 'tdsPercent', 'gstPercent', 'paymentTerms', 'paymentDue', 'guaranteePeriod', 'invoiceTrigger', 'commercialNotes',
  'agreementFeePercent', 'agreementDocument', 'agreementTemplate', 'feeType', 'feeAmount', 'replacementTerms', 'specialTerms',
  'billingContactName', 'billingContactDesignation', 'billingContactEmail', 'billingContactPhone', 'billingEmail', 'invoiceEmail', 'billingAddress',
  'paymentMethod', 'paymentBankName', 'paymentUpi', 'paymentReferenceNote', 'bankAccountHolder', 'bankAccountNoEnc', 'bankAccountLast4', 'bankAccountMasked', 'bankIfsc',
  'internalNotes', 'internalRemarks', 'riskNotes',
];
// The BDE desk never reads Tax & billing / Payment / Notes (Purna Sir's sections): not even in the activity lines.
const HR_ACTIVITY_LABEL = /^(Legal Name|GSTIN|PAN|TAN|Billing |Invoice Email|Accounts |Payment Method|Bank|UPI|Payment Reference|Account Holder|IFSC|Client Notes|Special Instructions|Recruitment Instructions|Internal Remarks|Tax & billing step)/;
function scrubHrActivity(user, a) {
  if (!AWF.hidesHrFor(user)) return a;
  const keep = (v) => (v == null ? v : (String(v).split('; ').filter((p) => !HR_ACTIVITY_LABEL.test(p.trim())).join('; ') || 'Tax & billing details updated'));
  const labelled = a.fieldLabel || a.field || '';
  if (HR_ACTIVITY_LABEL.test(String(labelled))) return { ...a, field: null, fieldLabel: null, fromValue: null, toValue: 'Tax & billing details updated', reason: null };
  return { ...a, toValue: keep(a.toValue), fromValue: a.fromValue && /→/.test(String(a.fromValue)) ? keep(a.fromValue) : a.fromValue };
}
function shapeClient(client, permissions, { list = false, user = null } = {}) {
  if (!client) return client;
  const out = {
    ...client,
    agreementStatus: normalizeAgreementStatus(client.agreementStatus),
    permissions,
    // Client ID (spec §8): the stored clientCode, else a display code derived
    // from the record id — deterministic, never stored.
    displayCode: displayCode(client),
    // Active | Paused | Archived (| legacy Inactive) — utils/clientLifecycle.js.
    lifecycle: clientLifecycle.lifecycleOf(client.status),
  };
  CLIENT_SECRETS.forEach((k) => { delete out[k]; });
  // A desk BDE reads a colleague's client (same desk) but not its money, statutory ids or agreement text.
  if (user && clientLifecycle.isDeskBde(user) && !clientLifecycle.ownsClient(user, client)) {
    COLLEAGUE_HIDDEN.forEach((k) => { delete out[k]; });
    out.colleagueView = true;
  }
  clientProfile.shapeProfile(out);
  out.missingRequired = clientProfile.missingRequired(out).map((m) => m.label);
  if (list) {
    out.hasAgreementDocument = !!client.agreementDocument;
    CLIENT_HEAVY.forEach((k) => { delete out[k]; });
  }
  // CLIENTS ROLE SPEC §5 / §6 — every client payload this router answers is
  // cut to the caller's field level (utils/clientRedact.js): a TL gets the
  // overview + contact NAMES, Accounts everything but the non-billing
  // contacts. /api/clients is not behind the index.js response guard, so the
  // cut happens here, once, for every route that shapes a client.
  // Sections 6-9 (Tax & billing, Payment details, Notes) are filled by Purna Sir (HR) and Admin: the BDE desk never reads them.
  if (user) AWF.redactFor(user, out);
  return user ? redactClientFor(user, out) : out;
}
// shapeClient() with this caller's permissions and field level.
async function shapeFor(req, client, opts = {}) {
  const perms = await clientPermissions(req.user);
  // The client's own BDE / the BDE TL may make and send the agreement link
  // (user, 2026-10-09) without holding the Admin's agreement rights.
  perms.sendLink = !!perms.share || (!opts.list && !!client && await agreementLifecycle.bdeMayLink(req.user, client).catch(() => false));
  return shapeClient(client, perms, { ...opts, user: req.user });
}

// ---------------------------------------------------------------------------
// CLIENTS ROLE SPEC (2026-09-29) — one role answer for the whole router.
//   admin · mgmt · bde · tl · accounts (· client — a client login on its own
//   company; · anyone else is refused at the door by Client List view)
// ---------------------------------------------------------------------------
// PER-ROLE SPEC (2026-10-03): an Assistant Manager ('am') reads clients VIEW
// only — name, owner, open jobs, agreement status, no revenue — and an STL
// ('stl') names / basics, so both get their own answer here; a Manager stays
// 'mgmt' (their departments, full read, notes).
const roleOf = (user) => {
  const v = clientViewRole(user);
  if (v === 'mgmt' && scopeOf(user).atsRole === 'ASSISTANT_MANAGER') return 'am';
  return v;
};
// P4 (user, 2026-10-09): a BDE changes only THEIR OWN clients (assigned, Owner
// or second BDE) and the desk's clients that still have no BDE: seeing the
// whole desk is not editing it. Admin and anyone else the matrix lets edit are
// unaffected. Returns the refusal text, or null.
function bdeEditRefusal(user, client) {
  const s = scopeOf(user);
  if (s.global || roleOf(user) !== 'bde' || isBdeTl(user)) return null;
  if (clientLifecycle.ownsClient(user, client)) return null;
  const owner = String(client.bdeOwner || '').trim();
  return owner
    ? `This client is looked after by ${owner}. Only ${owner} (or the BDE team lead / an Admin) can change it.`
    : 'This client is not yours yet. Ask your BDE team lead or an Admin.';
}

// Invoices on a client (§6): amounts for Admin / Management / Accounts, the
// STATUS only for a BDE (Paid / Pending / Overdue — no amounts), none for a TL.
function invoiceModeOf(role) {
  if (['admin', 'mgmt', 'accounts'].includes(role)) return 'amounts';
  if (role === 'bde') return 'status';
  return 'none';
}
// The Client 360 tabs each role may open (§5). A hidden tab's rows are not
// sent at all — GET /:id/overview drops the section, it does not blank it.
const ALL_TABS = ['overview', 'contacts', 'requirements', 'candidates', 'interviews', 'selected',
  'replacements', 'agreement', 'invoices', 'payments', 'activity'];
const PIPELINE_TABS = ['candidates', 'interviews', 'selected', 'replacements'];
function tabsFor(role) {
  switch (role) {
    case 'admin': case 'mgmt': case 'bde': return ALL_TABS;
    // TL: the client's NAME where needed (2026-10-03) — no Contacts tab.
    case 'tl': return ALL_TABS.filter((t) => !['agreement', 'invoices', 'payments', 'contacts'].includes(t));
    // Spec 6 (2026-10-03): an Assistant Manager VIEWS the agreement too.
    case 'am': return ['overview', 'requirements', 'agreement'];
    case 'stl': return ['overview', 'requirements'];
    case 'accounts': return ALL_TABS.filter((t) => !PIPELINE_TABS.includes(t));
    case 'client': return ALL_TABS.filter((t) => !['contacts', 'replacements', 'payments'].includes(t));
    default: return [];
  }
}
// §1 — the list's default view per role.
const DEFAULT_VIEW = {
  admin: 'active', mgmt: 'active', bde: 'mine', tl: 'team', accounts: 'billing', client: 'all',
};
// §4 — the list columns per role: `columns` is what the Columns chooser may
// offer, `defaults` what a first visit shows. `name` is always drawn.
const LIST_COLUMNS = {
  // Spec 6 (2026-10-03): client · owner BDE · department · open jobs ·
  // people sent · selected · joined · agreement step · status.
  // ATS layout v3 (2026-10-03): Client · Department · BDE · Open jobs ·
  // Joined · Agreement (Signed / Unsigned) by default; the rest one tick away.
  bde: {
    defaults: ['department', 'bde', 'activeReqs', 'joined', 'agreement'],
    extra: ['submitted', 'selected', 'status', 'code', 'industry', 'contact', 'location', 'candidates', 'interviews', 'lastActivity', 'health', 'fee', 'terms', 'guarantee', 'invoiceStatus', 'next'],
  },
  tl: {
    defaults: ['department', 'bde', 'activeReqs', 'joined', 'status'],
    extra: ['submitted', 'interviews', 'selected', 'code', 'industry', 'location', 'candidates', 'lastActivity', 'health', 'next'],
  },
  accounts: {
    defaults: ['fee', 'terms', 'joined', 'invoiced', 'received', 'outstanding', 'overdueDays'],
    extra: ['code', 'industry', 'location', 'bde', 'status', 'agreement', 'lastActivity', 'health'],
  },
  admin: {
    defaults: ['department', 'bde', 'activeReqs', 'joined', 'agreement'],
    extra: ['submitted', 'selected', 'status', 'code', 'industry', 'revenue', 'health', 'legal', 'location', 'tax', 'contact', 'terms', 'fee', 'candidates', 'interviews', 'pending',
      'invoiced', 'received', 'outstanding', 'overdueDays', 'guarantee', 'lastActivity', 'owner', 'next'],
  },
};
LIST_COLUMNS.mgmt = LIST_COLUMNS.admin;
LIST_COLUMNS.am = { defaults: ['bde', 'department', 'activeReqs', 'agreement', 'status'], extra: ['code', 'industry', 'location'] };
LIST_COLUMNS.stl = LIST_COLUMNS.tl;
LIST_COLUMNS.client = { defaults: ['activeReqs', 'agreement', 'status'], extra: [] };
// §4 — the filters per role.
const LIST_FILTERS = {
  // Spec 6 — a BDE gets the same filters, within their own clients.
  bde: ['industry', 'status', 'owner', 'department', 'location', 'agreement', 'expiring', 'hasOpen'],
  tl: ['industry', 'status'],
  accounts: ['outstanding', 'overdue'],
  admin: ['owner', 'expiring', 'unassigned', 'industry', 'status', 'department', 'location', 'agreement', 'hasOpen'],
  client: [],
};
LIST_FILTERS.mgmt = LIST_FILTERS.admin;
LIST_FILTERS.am = ['industry', 'status', 'owner', 'department', 'location', 'agreement', 'hasOpen'];
LIST_FILTERS.stl = LIST_FILTERS.tl;

// §8.1 — CLIENT HEALTH, from the last activity on the client in the
// caller's scope (stage events on its candidates, audit rows on the client
// and on its requirements — the same Last Activity the list shows):
//   active   something happened in the last 30 days            (green)
//   quiet    nothing for 31–90 days — "No activity 30 days"    (yellow)
//   dormant  nothing for more than 90 days, or nothing on record — or no
//            live requirement and nothing for 60+ days          (red)
const DAY_MS = 86400000;
function healthOf(lastAt, liveReqs, now = Date.now()) {
  if (!lastAt) return { health: 'dormant', healthLabel: 'Dormant', healthDays: null };
  const days = Math.max(0, Math.floor((now - lastAt.getTime()) / DAY_MS));
  if (days > 90 || (!liveReqs && days > 60)) return { health: 'dormant', healthLabel: 'Dormant', healthDays: days };
  if (days > 30) return { health: 'quiet', healthLabel: 'No activity 30 days', healthDays: days };
  return { health: 'active', healthLabel: 'Active', healthDays: days };
}

// The relationship numbers a role may receive (§4 / §5 / §6). Accounts works
// the billing side only — no submissions / interviews / pipeline status; a TL
// never sees commercial terms (the guarantee period is one).
const PIPELINE_WORK_FIELDS = [
  'workStatus', 'nextAction', 'nextActionKind', 'candidatesPending', 'nextActionOwner', 'nextActionDue',
  'nextActionOverdue', 'awaitingDecision', 'candidatesSubmitted', 'candidatesTotal', 'clientInterviews',
  'selectedCount', 'pendingDecisions', 'awaitingFeedback', 'recruiterName',
];
const COMMERCIAL_WORK_FIELDS = ['guaranteeDays', 'inGuarantee', 'guaranteeEnds'];
function workFor(role, row) {
  if (!row) return row;
  const out = { ...row };
  if (role === 'accounts') PIPELINE_WORK_FIELDS.forEach((k) => { delete out[k]; });
  if (['tl', 'stl', 'am'].includes(role)) COMMERCIAL_WORK_FIELDS.forEach((k) => { delete out[k]; });
  if (invoiceModeOf(role) === 'none') { delete out.invoiceSummary; delete out.revenue; }
  return out;
}


// ---------------------------------------------------------------------------
// §12 — WHAT IS OWED ON THIS CLIENT, AND BY WHOM.
//
// The Clients table was administrative — code, industry, GST, agreement,
// expiry — which tells you who they are and nothing about what to do. These
// four fields make the screen operational: status, next action, owner, due.
//
// The answer is read off the client's OWN WORK in priority order, so the most
// blocking thing wins: a missing agreement stops everything, then candidates
// waiting on a decision, then feedback, then joining. A client with nothing
// outstanding says so rather than inventing a task.
//
// Every count here comes from the applications this caller may already see —
// the same applicationWhere() the pipeline uses — so this cannot become a way
// to learn about work outside a scope.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// §9 (review #2) — THE BUSINESS RELATIONSHIP, beside the worklist.
//
//   Active Requirements · Candidates Submitted · Client Interviews · Selected
//   · Joined · Pending Decisions · Invoices · Replacement / Guarantee
//   · Last Activity · Account Owner / BDE
//
// All of it is computed HERE in a fixed number of queries whatever the number
// of clients (no per-client query): one requirement list, one slim list of
// the in-flight applications, two groupBy counts, one invoice list (only for
// logins that may see Accounts) and one aggregate SQL for the last activity.
// Every application / requirement query carries the SAME applicationWhere() /
// requirementWhere() the pipeline uses, so no number here can describe work
// outside the caller's scope.
// ---------------------------------------------------------------------------
// Past the BDE: the candidate has been put in front of the client.
const SUBMITTED_STAGES = [
  'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED',
  'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED',
];
const EVER_SELECTED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const JOINED_SET = ['JOINED', 'HIRED'];
// Interviews TeamLink runs itself are not client interviews (§16).
const INTERNAL_INTERVIEW_TYPES = ['Internal Panel', 'AI Interview', 'Recruiter Interview', 'TL Interview'];
// The stages that carry an SLA (STAGE_OWNER_ACTION days > 0) — the only rows
// the overdue / due-date / guarantee arithmetic needs to see individually.
const SLA_STAGES = Object.keys(STAGE_OWNER_ACTION).filter((s) => STAGE_OWNER_ACTION[s].days > 0);

// "1 Month" / "30 Days" / "3 Months" / "1 Year" / "No replacement" -> days.
function guaranteeDays(g) {
  const s = String(g || '').toLowerCase().trim();
  if (!s) return null;
  if (/no\s*replacement|^none$|^nil$/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(day|week|month|year|yr|m\b)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2] || 'month';
  if (u.startsWith('day')) return n;
  if (u.startsWith('week')) return n * 7;
  if (u.startsWith('y')) return n * 365;
  return n * 30;
}
const toDate = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === 'bigint' ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Latest activity per (client, requirement): stage events on the client's
// applications, audit rows on the client, audit rows on its requirements.
// SQLite returns the bare columns of the MAX(at) row of each group.
async function lastActivityRows(ids) {
  const filter = ids ? ids.map(() => '?').join(',') : null;
  const sql = `SELECT cid, rid, MAX(at) AS at, who, what FROM (
      SELECT r.clientId AS cid, r.id AS rid, e.createdAt AS at, e.actorName AS who, e.action AS what
        FROM ApplicationStageEvent e JOIN Application a ON a.id = e.applicationId JOIN Requirement r ON r.id = a.requirementId
        ${filter ? `WHERE r.clientId IN (${filter})` : ''}
      UNION ALL
      SELECT l.entityId, NULL, l.createdAt, COALESCE(l.actorName, u.name), l.action
        FROM AuditLog l LEFT JOIN User u ON u.id = l.userId
        WHERE l.entity = 'Client' AND l.entityId IS NOT NULL ${filter ? `AND l.entityId IN (${filter})` : ''}
      UNION ALL
      SELECT r.clientId, r.id, l.createdAt, COALESCE(l.actorName, u.name), l.action
        FROM AuditLog l JOIN Requirement r ON r.id = l.entityId LEFT JOIN User u ON u.id = l.userId
        WHERE l.entity = 'Requirement' ${filter ? `AND r.clientId IN (${filter})` : ''}
    ) GROUP BY cid, rid`;
  const params = ids ? [...ids, ...ids, ...ids] : [];
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    // A missing number must never take the client list down.
    // eslint-disable-next-line no-console
    console.error('[clients] last activity query failed:', err && err.message);
    return [];
  }
}

async function clientWorkload(user, clients, { allClients = false } = {}) {
  const ids = clients.map((c) => c.id);
  if (!ids.length) return { rows: new Map(), canSeeInvoices: false };
  // A global login listing every client needs no IN (…) list at all.
  const clientIn = allClients ? undefined : { in: ids };
  const appClient = clientIn ? { requirement: { is: { clientId: clientIn } } } : {};
  // THE BDE TL sees every client (user, 2026-10-09), so the numbers beside each
  // client count ALL its jobs and people — a TL's team scope would show 0.
  const bdeTl = isBdeTl(user);
  const appScope = bdeTl ? {} : applicationWhere(user);
  const global = !!scopeOf(user).global;
  const bdeDir = await bdeDirectory();

  // §6 — invoice numbers by role: amounts (Admin / Management / Accounts),
  // status only (BDE), none (TL). The client scope above is the guard: only
  // invoices of clients this caller may already open are read, and Accounts
  // keeps its own ledger scope (invoiceWhere) on top.
  const role = roleOf(user);
  const invoiceMode = invoiceModeOf(role);
  const canSeeInvoices = invoiceMode !== 'none';

  const [reqRows, liveApps, submittedRows, interviewRows, selectedRows, invoices, activityRows, allAppRows, jobsEverRows] = await Promise.all([
    prisma.requirement.findMany({
      // AND, not a spread: requirementWhere() may itself carry clientId.
      where: { AND: [bdeTl ? {} : teamRequirementWhere(user), clientIn ? { clientId: clientIn } : {}] },
      select: {
        id: true, clientId: true, status: true, recruiterId: true,
        bde: { select: { name: true } }, recruiter: { select: { name: true } },
      },
    }),
    // SELECT, NOT INCLUDE: the in-flight rows only (stages with an SLA), and
    // only the five columns the arithmetic below reads.
    prisma.application.findMany({
      where: { AND: [appScope, appClient, { stage: { in: SLA_STAGES } }] },
      select: { stage: true, createdAt: true, updatedAt: true, requirementId: true, joiningDate: true },
    }),
    // Candidates Submitted — ever put in front of the client: at / past
    // "Shared with Client" now, or the stage history says so, or the client
    // interviewed them (a later rejection does not un-submit a candidate).
    prisma.application.groupBy({
      by: ['requirementId'],
      where: {
        AND: [appScope, appClient, {
          OR: [
            { stage: { in: SUBMITTED_STAGES } },
            { interviewAt: { not: null } },
            { stageEvents: { some: { toStage: { in: SUBMITTED_STAGES } } } },
          ],
        }],
      },
      _count: { _all: true },
    }),
    // Client Interviews — applications with a client interview on record.
    prisma.application.groupBy({
      by: ['requirementId'],
      where: {
        AND: [appScope, appClient,
          { OR: [{ interviewAt: { not: null } }, { interviewStatus: { not: null } }] },
          { OR: [{ interviewType: null }, { interviewType: { notIn: INTERNAL_INTERVIEW_TYPES } }] },
        ],
      },
      _count: { _all: true },
    }),
    // Selected / Joined — current stage at or past Selected (HIRED has no
    // SLA, so these come from a grouped count, not the slim list).
    prisma.application.groupBy({
      by: ['requirementId', 'stage'],
      where: { AND: [appScope, appClient, { stage: { in: EVER_SELECTED } }] },
      _count: { _all: true },
    }),
    canSeeInvoices
      ? prisma.invoice.findMany({
        where: { AND: [role === 'accounts' ? invoiceWhere(user) : {}, clientIn ? { clientId: clientIn } : {}] },
        select: { id: true, clientId: true, amount: true, gst: true, tds: true, receivedAmount: true, status: true, dueDate: true },
      })
      : null,
    lastActivityRows(allClients ? null : ids),
    // Review #3 §5 — "Candidates": every candidate on the client's
    // requirements this caller may see (incl. rejected / hold).
    prisma.application.groupBy({
      by: ['requirementId'],
      where: { AND: [appScope, appClient] },
      _count: { _all: true },
    }),
    // "Does this client have ANY job?" — whatever the caller's scope (a TL / BDE only see their own
    // jobs above, so a client with jobs elsewhere would look job-less and be counted as a Prospect).
    prisma.requirement.groupBy({ by: ['clientId'], where: clientIn ? { clientId: clientIn } : {}, _count: { _all: true } }),
  ]);

  // Requirement -> client, and only the requirements this caller may see.
  const reqClient = new Map(reqRows.map((r) => [r.id, r.clientId]));
  const bucket = () => new Map(ids.map((id) => [id, []]));
  const reqsByClient = bucket();
  reqRows.forEach((r) => { if (reqsByClient.has(r.clientId)) reqsByClient.get(r.clientId).push(r); });
  const appsByClient = bucket();
  liveApps.forEach((a) => {
    const cid = reqClient.get(a.requirementId);
    if (cid && appsByClient.has(cid)) appsByClient.get(cid).push(a);
  });
  const sumBy = (rows) => {
    const m = new Map();
    rows.forEach((g) => {
      const cid = reqClient.get(g.requirementId);
      if (cid) m.set(cid, (m.get(cid) || 0) + g._count._all);
    });
    return m;
  };
  const submitted = sumBy(submittedRows);
  const interviewsBy = sumBy(interviewRows);
  const selectedBy = sumBy(selectedRows);
  const joinedBy = sumBy(selectedRows.filter((g) => JOINED_SET.includes(g.stage)));
  const candidatesBy = sumBy(allAppRows);
  const jobsEverBy = new Map((jobsEverRows || []).map((g) => [g.clientId, g._count._all]));

  // Invoices: count · invoiced · received · outstanding · overdue (count and
  // the oldest overdue in days) · paid / pending (Cancelled excluded).
  const invBy = new Map();
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
  const r2 = (n) => Math.round(n * 100) / 100;
  await CNU.decorateNet(invoices || []); // B9.9: invoiced = after issued notes
  (invoices || []).forEach((i) => {
    if (i.status === 'Cancelled') return;
    if (!invBy.has(i.clientId)) {
      invBy.set(i.clientId, {
        count: 0, outstanding: 0, overdue: 0, invoiced: 0, received: 0, overdueDays: 0, paid: 0, pending: 0,
      });
    }
    const x = invBy.get(i.clientId);
    const owed = Math.max(0, invoiceOutstanding(i));
    x.count += 1;
    x.invoiced = r2(x.invoiced + CNU.receivableOf(i)); // B9.9: net of issued notes
    x.received = r2(x.received + Number(i.receivedAmount || 0));
    x.outstanding = r2(x.outstanding + owed);
    if (owed > 0.5) x.pending += 1; else x.paid += 1;
    if (owed > 0.5 && (i.status === 'Overdue' || (i.dueDate && String(i.dueDate) < todayIso))) {
      x.overdue += 1;
      const due = i.dueDate ? new Date(`${String(i.dueDate).slice(0, 10)}T00:00:00Z`).getTime() : NaN;
      if (Number.isFinite(due)) x.overdueDays = Math.max(x.overdueDays, Math.floor((todayMs - due) / DAY_MS));
    }
  });
  // What a role receives of it (§6): a BDE the STATUS only — never a rupee.
  const invoiceSummaryFor = (x) => {
    const s = x || { count: 0, outstanding: 0, overdue: 0, invoiced: 0, received: 0, overdueDays: 0, paid: 0, pending: 0 };
    if (invoiceMode === 'status') {
      return {
        count: s.count,
        paid: s.paid,
        pending: s.pending,
        overdue: s.overdue,
        status: !s.count ? null : s.overdue ? 'Overdue' : s.pending ? 'Pending' : 'Paid',
      };
    }
    return {
      count: s.count, invoiced: s.invoiced, received: s.received, outstanding: s.outstanding,
      overdue: s.overdue, overdueDays: s.overdueDays, paid: s.paid, pending: s.pending,
    };
  };

  // Last activity: the newest row per client among the requirements this
  // caller may see (plus the client's own audit rows).
  const lastBy = new Map();
  const idSet = new Set(ids);
  activityRows.forEach((row) => {
    if (!row.cid || !idSet.has(row.cid)) return;
    if (row.rid && !global && !reqClient.has(row.rid)) return;
    const at = toDate(row.at);
    if (!at) return;
    const cur = lastBy.get(row.cid);
    if (!cur || cur.at < at) lastBy.set(row.cid, { at, who: row.who || null, what: row.what || null });
  });

  const today = new Date(`${todayIso}T00:00:00Z`);
  const out = new Map();
  clients.forEach((c) => {
    const mine = appsByClient.get(c.id) || [];
    const allReqs = reqsByClient.get(c.id) || [];
    // "Open work" is LIVE work — past the agreement gate, neither parked nor
    // closed. It counted every requirement ever raised, closed ones included.
    const reqs = allReqs.filter((r) => requirementIsLive(r.status));
    const gated = allReqs.filter((r) => ['DRAFT', 'AGREEMENT_CHECK'].includes(r.status));

    // Account Owner / BDE: the client's own fields first, then whoever holds
    // most of its (live, else any) requirements.
    const mostCommon = (list, pick) => {
      const n = new Map();
      list.forEach((r) => { const v = pick(r); if (v) n.set(v, (n.get(v) || 0) + 1); });
      return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    };
    const bdeName = c.bdeOwner || mostCommon(reqs, (r) => r.bde?.name) || mostCommon(allReqs, (r) => r.bde?.name);
    const recruiterName = mostCommon(reqs, (r) => r.recruiter?.name) || mostCommon(allReqs, (r) => r.recruiter?.name);
    // Whoever the work actually sits with — the BDE, falling back to the
    // recruiter. A person, never a status (§5).
    const owner = bdeName || recruiterName || c.accountManager || null;

    const awaitingDecision = mine.filter((a) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(a.stage));
    const awaitingFeedback = mine.filter((a) => a.stage === 'INTERVIEW_COMPLETED');
    // Candidates waiting on the client desk itself — approved internally and
    // not yet shared with the client (§9 "Candidates pending").
    const candidatesPending = mine.filter((a) => ['WITH_BDE', 'BDE_APPROVED'].includes(a.stage));
    const joining = mine.filter((a) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage));
    const joined = mine.filter((a) => JOINED_SET.includes(a.stage));
    const unstaffed = reqs.filter((r) => !r.recruiterId);
    const overdue = mine.filter(applicationIsOverdue);

    let nextAction = null;
    let status = 'Active';
    // §9 — the Next Action is a button; this is which one.
    let nextActionKind = 'view-requirements';
    if (normalizeAgreementStatus(c.agreementStatus) !== 'ACTIVE') {
      status = 'Agreement pending';
      nextAction = 'Complete the agreement before sharing candidates';
      nextActionKind = 'agreement';
    } else if (awaitingDecision.length || awaitingFeedback.length) {
      status = awaitingDecision.length ? 'Awaiting client decision' : 'Awaiting interview feedback';
      nextAction = awaitingDecision.length
        ? `Client decision pending — ${awaitingDecision.length} candidate(s)`
        : `Interview feedback pending — ${awaitingFeedback.length}`;
      nextActionKind = 'feedback';
    } else if (candidatesPending.length) {
      status = 'Candidates pending';
      nextAction = `Share with the client — ${candidatesPending.length} candidate(s)`;
      nextActionKind = 'candidates';
    } else if (joining.length) {
      status = 'Joining in progress';
      nextAction = `Confirm joining — ${joining.length} candidate(s)`;
      nextActionKind = 'joining';
    } else if (unstaffed.length) {
      status = 'Requirement unstaffed';
      nextAction = `Assign a recruiter — ${unstaffed.length} requirement(s)`;
      nextActionKind = 'assign';
    } else if (reqs.length) {
      status = 'Sourcing';
      nextAction = 'Source and share candidates';
    } else {
      status = 'No open work';
    }

    // The soonest SLA among the things that are actually waiting.
    const dates = [...awaitingDecision, ...awaitingFeedback, ...joining]
      .map((a) => applicationDueDate(a)).filter(Boolean).sort();

    // Replacement / Guarantee: joinings still inside the client's period.
    const gDays = guaranteeDays(c.guaranteePeriod);
    let inGuarantee = 0;
    let guaranteeEnds = null;
    if (gDays) {
      joined.forEach((a) => {
        const j = toDate(a.joiningDate);
        if (!j || j > today) return;
        const end = new Date(j.getTime() + gDays * 86400000);
        if (end >= today) {
          inGuarantee += 1;
          const e = end.toISOString().slice(0, 10);
          if (!guaranteeEnds || e < guaranteeEnds) guaranteeEnds = e;
        }
      });
    }

    const last = lastBy.get(c.id) || null;
    const row = {
      workStatus: status,
      nextAction,
      nextActionKind,
      candidatesPending: candidatesPending.length,
      gatedRequirements: gated.length,
      totalRequirements: allReqs.length,
      jobsEver: jobsEverBy.get(c.id) || 0,
      nextActionOwner: nextAction ? owner : null,
      nextActionDue: dates[0] || null,
      nextActionOverdue: overdue.length > 0,
      openRequirements: reqs.length,
      awaitingDecision: awaitingDecision.length,
      // --- §9 relationship numbers -------------------------------------
      activeRequirements: reqs.length,
      candidatesSubmitted: submitted.get(c.id) || 0,
      candidatesTotal: candidatesBy.get(c.id) || 0,
      clientInterviews: interviewsBy.get(c.id) || 0,
      selectedCount: selectedBy.get(c.id) || 0,
      joinedCount: joinedBy.get(c.id) || 0,
      pendingDecisions: awaitingDecision.length + awaitingFeedback.length,
      awaitingFeedback: awaitingFeedback.length,
      guaranteeDays: gDays,
      inGuarantee,
      guaranteeEnds,
      lastActivityAt: last ? last.at.toISOString() : null,
      lastActivityBy: last ? last.who : null,
      lastActivityWhat: last ? last.what : null,
      bdeName: bdeName || null,
      // "Name · Position" (Vasavi V · BDE MED). Only the client's OWN BDE
      // (Client.bdeOwner) carries a position; a name taken from its jobs is
      // looked up the same way.
      bdePosition: bdeName ? bdeDir.positionFor(bdeName) : null,
      bdeLabel: bdeName ? bdeDir.labelFor(bdeName) : null,
      recruiterName: recruiterName || null,
      accountOwner: c.accountManager || bdeName || null,
      // §8.1 — Client Health badge.
      ...healthOf(last ? last.at : null, reqs.length),
    };
    if (canSeeInvoices) {
      row.invoiceSummary = invoiceSummaryFor(invBy.get(c.id));
      // Revenue (Admin / Management column): what has been billed to them.
      if (invoiceMode === 'amounts') row.revenue = row.invoiceSummary.invoiced;
    }
    out.set(c.id, workFor(role, row));
  });
  return { rows: out, canSeeInvoices };
}

router.get('/', async (req, res) => {
  // Scoped by utils/scope.js: a client sees their own company, a BDE and a
  // recruiter their assigned clients, a TL / Manager the directory.
  // ARCHIVED clients are hidden from every default list (and every picker
  // that reads this one); ?archived=1 (the Clients screen's Status = Archived
  // filter) includes them.
  const withArchived = ['1', 'true', 'yes'].includes(String(req.query.archived || '').toLowerCase())
    || String(req.query.status || '').toLowerCase() === 'archived';
  const scopeW = clientWhere(req.user);
  const where = withArchived ? scopeW : { AND: [scopeW, { OR: [{ status: null }, { status: { not: 'Archived' } }] }] };
  const [clients, permissions, lifecycleBase] = await Promise.all([
    prisma.client.findMany({ where, orderBy: { name: 'asc' } }),
    clientPermissions(req.user),
    clientLifecycle.baseRights(req.user),
  ]);
  // §12 — what is owed on each client, beside who they are; §9 — the
  // business relationship numbers.
  const { rows: work, canSeeInvoices } = await clientWorkload(req.user, clients, {
    allClients: withArchived && Object.keys(scopeW).length === 0,
  });
  res.set('X-Can-See-Invoices', canSeeInvoices ? '1' : '0');
  // Each row cut to the caller's field level (§5 / §6), THEN its
  // relationship numbers (already shaped per role by clientWorkload).
  let rowsOut = clients.map((c) => ({
    ...shapeClient(c, permissions, { list: true, user: req.user }),
    ...(work.get(c.id) || {}),
    // The row's ⋯ menu: Pause / Reactivate / Request pause / Archive / Delete.
    lifecycleActions: clientLifecycle.rightsFor(req.user, c, lifecycleBase),
  }));
  // The OLD names of each client (ClientAlias) — for the screen's own search box only; the row still shows `name`.
  if (roleOf(req.user) !== 'client') await clientSearch.attachAliases(rowsOut);
  // The places of each client's REQUIREMENTS (founder, 2026-10-22): one company, requirements in many places (Vcare: Uppal, Banjara Hills, Kochi ...). They feed the
  // Location filter of the Clients screen, so it is not limited to the one place written on the client record. Places only: no amounts, no people.
  if (roleOf(req.user) !== 'client' && rowsOut.length) {
    try {
      const byClient = new Map();
      const ids = rowsOut.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        // eslint-disable-next-line no-await-in-loop
        const got = await prisma.requirement.groupBy({ by: ['clientId', 'location'], where: { clientId: { in: ids.slice(i, i + 500) }, location: { not: null } } });
        got.forEach((g) => {
          const place = String(g.location || '').replace(/s*,s*/g, ', ').replace(/s+/g, ' ').trim();
          if (!place) return;
          const m = byClient.get(g.clientId) || new Map();
          if (!m.has(place.toLowerCase())) m.set(place.toLowerCase(), place);
          byClient.set(g.clientId, m);
        });
      }
      rowsOut.forEach((r) => {
        const m = byClient.get(r.id) || new Map();
        const own = String(r.location || '').replace(/s+/g, ' ').trim();
        if (own && !m.has(own.toLowerCase())) m.set(own.toLowerCase(), own);
        r.locations = [...m.values()].sort((x, y) => x.localeCompare(y));
      });
    } catch (e) { /* the list works without the places */ }
  }
  // Same name, other location: "Name - Location" on the row (a unique name has no placeLabel).
  { const labels = await scopeLabelMap(req.user); rowsOut.forEach((r) => { const l = labels.get(r.id); if (l) r.placeLabel = l; }); }
  // The step each agreement is at (a chip) and "Waiting for me" (?waiting=1). A TL / Recruiter / HR login gets neither.
  if (!require('../utils/agreementPrivacy').blindTo(req.user)) {
    await AWF.decorate(req.user, rowsOut);
    if (['1', 'true', 'yes'].includes(String(req.query.waiting || '').toLowerCase())) rowsOut = rowsOut.filter((r) => r.agreementWaiting);
  }
  res.json(rowsOut);
});

// GET /clients/picker — the LIGHT pick list: { rows: [{ id, name }], total }.
// Exactly the rows GET / would return (same router guards above: a login that
// is refused there is refused here; same scope; Archived hidden unless
// ?archived=1), without the workload numbers, so a "choose a client" box does
// not download 1.7 MB.   ?q= name search · ?limit= (30, max 1000) · ?ids=a,b the
// named clients, so a chosen one can be labelled even when it is past the limit.
// "Name - Location" for the clients (of the caller's scope) that share their name with another client (2026-10-22).
async function scopeLabelMap(user) {
  if (roleOf(user) === 'client') return new Map();
  return CLOC.labelMap();
}

router.get('/picker', async (req, res, next) => {
  try {
    const withArchived = ['1', 'true', 'yes'].includes(String(req.query.archived || '').toLowerCase())
      || String(req.query.status || '').toLowerCase() === 'archived';
    const scopeW = clientWhere(req.user);
    const and = [scopeW];
    if (!withArchived) and.push({ OR: [{ status: null }, { status: { not: 'Archived' } }] });
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 1000);
    if (req.query.ids !== undefined) and.push({ id: { in: ids.length ? ids : ['__none__'] } });
    const s = String(req.query.q || '').trim();
    // The official name OR an old name (ClientAlias, utils/clientSearch.js): typing 'vcare' finds 'Prabs VCare Health Clinic'.
    // Legal name / client code only for a login that may read them (the same level that sees them in the list).
    if (s) {
      const deep = ['full', 'billing', 'basics', 'status'].includes(clientLevelFor(req.user));
      and.push(await clientSearch.clientTermWhere(s, { legalName: deep, clientCode: deep }));
    }
    const where = { AND: and };
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 30));
    const [rows, total] = await Promise.all([
      prisma.client.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: req.query.ids !== undefined ? Math.max(limit, ids.length) : limit }),
      prisma.client.count({ where }),
    ]);
    // The old names ride along (matching only; the box shows `name`) so a list the browser filters itself finds them too.
    if (roleOf(req.user) !== 'client') await clientSearch.attachAliases(rows);
    // Two clients with one name (two locations): the box shows "Name - Location"; a unique name is untouched.
    const labels = await scopeLabelMap(req.user);
    rows.forEach((r) => { const l = labels.get(r.id); if (l) r.placeLabel = l; });
    res.json({ rows, total });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /clients/meta — what the Clients screens draw for THIS login (clients
// role spec §1–§4, §7, §8): the role, the default view, the list columns and
// filters it may use, the top / row buttons, and the agreement-expiry alert.
// Every flag is a can() result or the same role rule the data routes apply,
// so a button is drawn exactly when the API would honour it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// WHICH DEPARTMENT A NEW CLIENT BELONGS TO (user, 2026-10-09).
// A desk BDE (seat BDE-MED …) adds clients of THEIR desk only: the department
// is the seat's, whatever the form sent. The BDE TL, Admin and the rest pick
// from the full list. `locked` is the department's name exactly as the
// Department master spells it ('Medical'), or null when the login may pick.
// ---------------------------------------------------------------------------
async function newClientDepartment(user) {
  if (roleOf(user) !== 'bde' || scopeOf(user).global || isBdeTl(user)) return { locked: null, desk: null };
  const dir = await bdeDirectory();
  const info = dir.infoFor(user.name);
  const sc = scopeOf(user);
  const desk = (info && info.desk)
    || (sc.bdeDeskDepartments || []).map((d) => canonicalDepartment(d)).find((d) => d && d !== 'BDE')
    || (sc.departments || []).map((d) => canonicalDepartment(d)).find((d) => d && d !== 'BDE')
    || null;
  if (!desk) return { locked: null, desk: null };
  const names = (await prisma.department.findMany({ select: { name: true } }).catch(() => [])).map((d) => d.name);
  const stored = (sc.bdeDeskDepartments || [])[0];
  return { locked: names.find((n) => canonicalDepartment(n) === desk) || stored || desk, desk };
}

// The plain-words line for "whose clients am I looking at" (Clients header).
async function areaLabelFor(user) {
  if (scopeOf(user).atsRole === 'MANAGER' && !scopeOf(user).global) return 'All departments';
  if (roleOf(user) !== 'bde') return null;
  if (scopeOf(user).global) return null;
  if (isBdeTl(user)) return 'All clients (BDE team lead)';
  const nd = await newClientDepartment(user);
  return nd.locked ? `${nd.locked} clients` : 'Your clients';
}

router.get('/meta', async (req, res) => {
  const user = req.user;
  const role = roleOf(user);
  const [
    add, bulkImport, exportable, edit, del, lifecycleView, commercialView, createReq, invoiceCreate,
  ] = await Promise.all([
    can(user, 'ats', 'clients', 'Add Client', 'create'),
    can(user, 'ats', 'clients', 'Bulk Import', 'create'),
    can(user, 'ats', 'clients', 'Client List', 'export'),
    can(user, 'ats', 'clients', 'Client Detail', 'edit'),
    can(user, 'ats', 'clients', 'Client Detail', 'delete'),
    can(user, 'ats', 'clients', 'Agreement Lifecycle', 'view'),
    can(user, 'ats', 'clients', 'Commercial Terms', 'view'),
    // "+ New job" on a client: the BDE team and above (a request for a BDE / Manager, the form for an Admin); never a TL / Recruiter (2026-10-13)
    Promise.resolve(require('../utils/jobCreateRule').canCreateJob(user, {}).allowed), // eslint-disable-line global-require
    can(user, 'accounts', 'accounts', 'Invoices', 'create'),
  ]);
  const global = !!scopeOf(user).global;
  const level = clientLevelFor(user);
  const noteCreate = await can(user, 'ats', 'clients', 'Client Notes', 'create');
  const cols = LIST_COLUMNS[role] || { defaults: [], extra: [] };
  const lifecycleBase = await clientLifecycle.baseRights(user);

  // §8.3 — "N clients' agreements expire in 30 days" (Admin, BDE), counted
  // in the caller's own client scope.
  let expiring = null;
  if (role === 'admin' || role === 'bde') {
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * DAY_MS).toISOString().slice(0, 10);
    const rows = await prisma.client.findMany({
      where: { AND: [clientWhere(user), { agreementEnd: { gte: today, lte: in30 } }] },
      select: { id: true },
    });
    // Spec 6 — renewal alert: also an ACTIVE agreement whose 12-month term
    // renews within 30 days (no end date on file — derived from its start).
    const renewing = await prisma.client.findMany({
      where: { AND: [clientWhere(user), { agreementStatus: { in: ['ACTIVE', 'SIGNED', 'CONFIRMED'] } }, { OR: [{ agreementEnd: null }, { agreementEnd: '' }] }, { agreementStart: { not: null } }] },
      select: { id: true, agreementStart: true, agreementEnd: true },
    });
    const todayD = new Date(`${today}T00:00:00Z`);
    const ids = new Set(rows.map((r) => r.id));
    renewing.forEach((c) => {
      const e = agreementLifecycle.endOf(c, todayD);
      if (e && e.end >= today && e.end <= in30) ids.add(c.id);
    });
    expiring = { days: 30, count: ids.size, ids: [...ids] };
  }

  res.json({
    role,
    level,
    defaultView: DEFAULT_VIEW[role] || 'all',
    columns: [...cols.defaults, ...cols.extra],
    defaultColumns: cols.defaults,
    filters: LIST_FILTERS[role] || [],
    tabs: tabsFor(role),
    invoiceMode: invoiceModeOf(role),
    expiring,
    actions: {
      add,
      import: bulkImport,
      export: exportable,
      // Merge Duplicates — routes/clientMerge.js: Super Admin / Admin only.
      merge: role === 'admin' || !!lifecycleBase.mergeRequest,
      edit,
      // Permanent delete — Super Admin only, empty clients only (spec §A).
      delete: lifecycleBase.delete,
      legacyDelete: del,
      // Owner BDE reassignment is global-only (PUT refuses anyone else).
      reassign: edit && (global || isBdeTl(user) || !!lifecycleBase.ownerRequest),
      // Deactivate is replaced by Pause / Reactivate (with a reason).
      deactivate: false,
      pause: lifecycleBase.pauseEdit,
      requestPause: lifecycleBase.pauseRequest,
      archive: lifecycleBase.archive,
      // The Pause requests panel (approvers decide, a BDE sees their own).
      pauseRequests: lifecycleBase.pauseEdit || lifecycleBase.pauseRequest,
      // BDE business workspace (2026-10-10): the unified My requests panel (what I asked / what I may decide).
      requestsPanel: !!(lifecycleBase.pauseEdit || lifecycleBase.pauseRequest || lifecycleBase.deleteRequest || lifecycleBase.ownerRequest || lifecycleBase.approvalSubmit || lifecycleBase.mergeRequest || lifecycleBase.deactivateRequest || global || role === 'mgmt'),
      requestOwner: !!lifecycleBase.ownerRequest,
      businessActivities: role === 'bde' || global || role === 'mgmt',
      agreements: lifecycleView,
      commercial: commercialView,
      newRequirement: createReq,
      generateInvoice: invoiceCreate && role === 'accounts',
      // §8.5 Call — only a login that is sent the client's phone at all.
      call: level === 'full' && role !== 'client',
      // §5 Notes / Activity: Admin ✅ · BDE ✅ · Accounts ✅ (own); Management
      // and TL read only.
      // Client Notes / create (2026-10-03): Admin, Manager, BDE, Accounts.
      note: noteCreate,
    },
    // BDE creating a client: Owner BDE is always themselves (§9, enforced on POST).
    ownerLocked: role === 'bde' && !isBdeTl(user) ? (user.name || null) : null,
    // The department a new client gets: the BDE's own desk, or null = pick.
    lockedDepartment: (await newClientDepartment(user)).locked,
    ownerLockedLabel: role === 'bde' && !isBdeTl(user) ? (await bdeDirectory()).labelFor(user.name) : null,
    areaLabel: await areaLabelFor(user),
    // A BDE sits in the BDE department, which is not a client department: the
    // BDE TL (and a BDE with no desk) pick from the real departments.
    clientDepartments: role === 'bde' && !scopeOf(user).global
      ? (await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } }).catch(() => []))
        .map((d) => d.name).filter((n) => canonicalDepartment(n) !== 'BDE' && !/^(accounts|administration|hr|human resources)$/i.test(n))
      : null,
  });
});

// GET /clients/owner-options — the BDE names Owner BDE may be set to (Add
// Client / Reassign Owner). Names only; any login that may add or edit.
router.get('/owner-options', async (req, res) => {
  if (!(await mayCheckDuplicates(req.user))) return res.status(403).json({ error: 'Only a login that can add or edit clients can pick an owner.' });
  const users = await prisma.user.findMany({
    where: {
      status: { not: 'Inactive' },
      OR: [{ atsRole: 'BDE' }, { role: 'BDE' }, { atsRole: 'TL', OR: [{ atsDepartment: 'BDE' }, { atsScopeDepartments: { contains: 'BDE' } }] }],
      // Never offer a test login as an owner (SQLite LIKE is case-insensitive).
      NOT: [{ name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }],
    },
    select: { id: true, name: true, atsDepartment: true, atsScopeDepartments: true },
    orderBy: { name: 'asc' },
  });
  // 2026-10-05 — cascade: the chosen department's BDEs first, with how many
  // clients each already owns.
  const dept = String(req.query.department || '').trim().toLowerCase();
  const counts = await prisma.client.groupBy({ by: ['bdeOwner'], where: { bdeOwner: { in: users.map((u) => u.name).filter(Boolean) } }, _count: { _all: true } }).catch(() => []);
  const countOf = new Map(counts.map((c) => [c.bdeOwner, c._count._all]));
  // 2026-10-09 — a BDE's desk comes from their SEAT (BDE-EDU-1 -> Education),
  // shown as "Name · BDE EDU 1"; the chosen department's BDEs come first.
  const dir = await bdeDirectory();
  const wantDesk = canonicalDepartment(dept);
  // Someone who has left (their seat's holder is Exited / Relieved) is not offered.
  const out = users.filter((u) => u.name && !((dir.infoFor(u.name) || {}).active === false)).map((u) => {
    const depts = [u.atsDepartment, ...String(u.atsScopeDepartments || '').split(',')].map((d) => String(d || '').trim()).filter(Boolean);
    const info = dir.infoFor(u.name);
    const desk = (info && info.desk) || depts.map((d) => canonicalDepartment(d)).find((d) => d && d !== 'BDE') || null;
    const isTl = !!(info && info.isTl);
    return {
      id: u.id, name: u.name, department: isTl ? null : (desk || depts[0] || null), position: info ? info.position : null,
      // The BDE TL covers every department.
      isTl,
      label: isTl ? `${u.name} · BDE TL · all departments` : (info ? info.label : u.name),
      inDepartment: !!dept && !isTl && ((!!desk && desk === wantDesk) || depts.some((d) => d.toLowerCase() === dept)),
      clients: countOf.get(u.name) || 0,
    };
  });
  // CASCADE (user, 2026-10-09): with a department chosen, ONLY that department's
  // BDEs are offered — plus the BDE TL, who covers all. No department yet: all of
  // them, grouped by department.
  const shown = dept ? out.filter((o) => o.inDepartment || o.isTl) : out;
  shown.sort((a, b) => (Number(b.inDepartment) - Number(a.inDepartment))
    || (Number(a.isTl) - Number(b.isTl))
    || String(a.department || '~').localeCompare(String(b.department || '~'))
    || a.name.localeCompare(b.name));
  res.json(shown);
});

// ---------------------------------------------------------------------------
// §8 — DUPLICATE PROTECTION. "Before creating a client: Possible duplicate
// found … [View Existing] [Create Anyway]."
//
// Searched across EVERY client, not the caller's scope: a duplicate outside
// your desk is still a duplicate. That is why only a login that may create or
// edit clients (Super Admin / Admin) may ask.
// ---------------------------------------------------------------------------
async function mayCheckDuplicates(user) {
  const [create, edit] = await Promise.all([
    can(user, 'ats', 'clients', 'Add Client', 'create'),
    can(user, 'ats', 'clients', 'Client Detail', 'edit'),
  ]);
  return create || edit;
}

router.post('/check-duplicate', async (req, res) => {
  if (!(await mayCheckDuplicates(req.user))) {
    return res.status(403).json({ error: 'Only a login that can add or edit clients can run the duplicate check.' });
  }
  const result = await findClientDuplicates(req.body || {}, { excludeId: req.body?.excludeId || null });
  // 2026-10-22: the same friendly question the save would ask (null = nothing to ask), so the form can show it before saving.
  const question = await CLOC.buildQuestion(result, req.body || {}).catch(() => null);
  return res.json({ ...result, question });
});

// Live "Agreement Template Preview" pane in the Add Client modal (the
// prototype's refreshAgreementPreview, line 7428). Nothing is stored — this
// renders the same template the real document is built from, so the two can
// never drift. It is also the workflow's own Preview step.
router.get('/agreement-preview', async (req, res) => {
  // The template carries the standard fee and terms — not for a TL (spec 6).
  if (!(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'view'))) {
    return res.status(403).json({ error: 'Agreements are seen by the BDE, Accounts, Managers and Admin only.' });
  }
  const fee = Number(req.query.feePercent);
  const consultant = await consultantParty();
  const defaults = await agreementSettingsStore.agreementSettings();
  return res.json({
    document: buildAgreementDocument({
      name: (req.query.name || '').trim() || '(company name)',
      location: req.query.location || null,
      agreementFeePercent: Number.isFinite(fee) && fee > 0 ? fee : defaults.feePercent,
      gst: req.query.gst || null,
      tdsPercent: req.query.tdsPercent != null ? Number(req.query.tdsPercent) : undefined,
      paymentTerms: req.query.paymentTerms || agreementSettingsStore.paymentTermsText(defaults.paymentDays),
      guaranteePeriod: req.query.guaranteePeriod || agreementSettingsStore.guaranteeText(defaults.guaranteeDays),
    }, consultant, { preview: true }),
  });
});

// THE LIVE PREVIEW BESIDE "ADD CLIENT" (2026-10-05). The body is the form as
// it stands; the answer is the document POST /clients would save right now —
// same draftClientData(), same buildAgreementDocument() — plus the key terms
// and a hash the save sends back, so the server can confirm the saved draft
// is the text the user saw. Nothing is stored.
router.post('/agreement-preview', async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Add Client', 'create'))
    || !(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'view'))) {
    return res.status(403).json({ error: 'Only a login that adds clients can preview a new agreement.' });
  }
  // The preview never needs (or encrypts) a bank account.
  if (req.body) { delete req.body.bankAccountNo; }
  // EDIT (clientId): the stored client with the form's changes on top — a
  // login without Commercial Terms edit cannot change those terms, so the
  // stored ones show (never the defaults).
  let data;
  let autoDate = true; // the date printed is today's, filled in for the user
  if (req.body && req.body.clientId) {
    const stored = await prisma.client.findFirst({ where: { AND: [{ id: String(req.body.clientId) }, clientWhere(req.user)] } });
    if (!stored) return res.status(404).json({ error: 'Client not found' });
    const overlay = { ...pickClient(req.body), ...clientProfile.pickProfile(req.body).data };
    if (!(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit'))) {
      [...AGREEMENT_AUDIT_FIELDS, ...clientProfile.NEW_COMMERCIAL_FIELDS].forEach((k) => { delete overlay[k]; });
    }
    if (overlay.billingSameAsAddress) overlay.billingAddress = null;
    data = { ...stored, ...overlay };
    // "How a new draft would look": Make a new draft prints today's date.
    data.agreementStart = vendorAgreement.regenerateYmd(data);
  } else {
    // Not saved yet: the date typed on the form, else TODAY (India time).
    data = previewRow(await draftClientData(req));
    autoDate = !/^\d{4}-\d{2}-\d{2}$/.test(String(data.agreementStart || '').trim());
    data.agreementStart = vendorAgreement.effectiveYmd(data);
  }
  const consultant = await consultantParty();
  const document = buildAgreementDocument(data, consultant, { preview: true });
  return res.json({ document, keyTerms: { ...keyTermsOf({ ...data, agreementDocument: null }, consultant), startDateIsAuto: autoDate }, hash: docHash(document) });
});

// ---------------------------------------------------------------------------
// SPEC 6 — AGREEMENT SETTINGS: the template and the default fee %, guarantee
// period and payment days every new client's draft starts with, plus the
// renewal alert (in-app always; e-mail only when switched on — OFF by
// default). Read: anyone who may see agreements (the Add Client form shows
// the defaults). Change: Super Admin / Admin only (Agreement Lifecycle edit).
// ---------------------------------------------------------------------------
router.get('/agreement-settings', async (req, res) => {
  const [view, edit] = await Promise.all([
    can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'view'),
    can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'),
  ]);
  if (!view) return res.status(403).json({ error: 'Agreements are seen by the BDE, Accounts, Managers and Admin only.' });
  const s = await agreementSettingsStore.agreementSettings({ fresh: true });
  // eslint-disable-next-line global-require
  const { TEMPLATES } = require('../utils/vendorAgreement');
  return res.json({ ...s, canEdit: edit, placeholder: s.templateNote === agreementSettingsStore.PLACEHOLDER, templates: TEMPLATES });
});

router.put('/agreement-settings', async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'))) {
    return res.status(403).json({ error: 'Only a Super Admin or Admin can change the agreement settings.' });
  }
  const out = await agreementSettingsStore.saveAgreementSettings(req.body || {}, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  const changed = Object.keys(out.settings).filter((k) => !['updatedAt', 'updatedByName'].includes(k)
    && JSON.stringify(out.settings[k]) !== JSON.stringify(out.before[k]));
  if (changed.length) {
    await logAudit({
      userId: req.user.id, action: 'Agreement settings changed', entity: 'AppSetting', entityId: agreementSettingsStore.KEY,
      fromValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, out.before[k]]))).slice(0, 1000),
      toValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, out.settings[k]]))).slice(0, 1000),
    });
  }
  return res.json({ ...out.settings, canEdit: true, placeholder: out.settings.templateNote === agreementSettingsStore.PLACEHOLDER, changed });
});

// Pause / Reactivate / pause requests / Archive / permanent Delete — mounted
// HERE, before GET /:id, so /pause-requests is not read as a client id.
require('./clientLifecycleRoutes')(router, { shapeFor, executionFiles, dropExecutionFiles });
// Client documents (Add client section 8, 2026-10-05).
require('./clientDocumentRoutes')(router);
// Agreement Drive links - many clients' signed agreements in one go (2026-10-12).
require('./agreementDriveLinkRoutes')(router);
// Client work: all activity of one client + the client work waiting on it (2026-10-10).
require('./clientWorkRoutes')(router);
// BDE business workspace: requests a Manager / Admin decides, follow-ups, meetings, feedback, onboarding (2026-10-10).
require('./clientRequests')(router, { shapeFor });

// ---------------------------------------------------------------------------
// B9.2 PER-CLIENT SLA — "Feedback within N days" / "Send first profiles
// within N days" (utils/clientSla.js). Read by anyone who may open the
// client; changed by whoever may edit its Commercial Terms. Blank = the
// Step-timing default. Used by the Late calculation (utils/nextAction.js)
// and the SLA & Aging report's "Client promises" table.
// ---------------------------------------------------------------------------
router.get('/:id/sla', async (req, res) => {
  res.json(await CS.slaOf(req.client.id));
});
router.put('/:id/sla', requirePerm('ats', 'clients', 'Commercial Terms', 'edit'), async (req, res) => {
  const r = await CS.save(req.client.id, req.body || {}, req.user);
  if (r.error) return res.status(400).json({ error: r.error });
  const words = (o) => `feedback ${o.feedbackDays ?? 'default'} d · first profiles ${o.firstProfilesDays ?? 'default'} d`;
  await logAudit({
    userId: req.user.id, action: 'Client SLA changed', entity: 'Client', entityId: req.client.id,
    fromValue: words(r.before || {}), toValue: words(r.sla), reason: req.body.reason || null,
  });
  return res.json(r.sla);
});

router.get('/:id', async (req, res) => {
  const permissions = await clientPermissions(req.user);
  // The client's own BDE / the BDE TL make and send the agreement link (2026-10-09).
  permissions.sendLink = !!permissions.share || !!(await agreementLifecycle.bdeMayLink(req.user, req.client).catch(() => false));
  // §5 / §6 — cut to the caller's field level (TL: overview + contact names;
  // Accounts: billing contact, no other contact details).
  const out = shapeClient(req.client, permissions, { user: req.user });
  out.tabs = tabsFor(roleOf(req.user));
  // "Name · Position" of the client's BDE and of the second BDE.
  if (clientLevelFor(req.user) !== 'min') {
    const dir = await bdeDirectory();
    if (req.client.bdeOwner) { out.bdePosition = dir.positionFor(req.client.bdeOwner); out.bdeLabel = dir.labelFor(req.client.bdeOwner); }
    if (req.client.secondaryBde) out.secondaryBdeLabel = dir.labelFor(req.client.secondaryBde);
  }
  out.lifecycleActions = await clientLifecycle.lifecycleRights(req.user, req.client);
  if (!require('../utils/agreementPrivacy').blindTo(req.user)) await AWF.decorate(req.user, [out]);
  // B9.2: the client's SLA (own numbers or the Step-timing defaults).
  out.sla = await CS.slaOf(req.client.id);
  // TeamLink's signer (Agreement settings) for the agreement's signature block.
  if (out.agreementDocument) { const us = await consultantParty(); out.teamlinkSigner = { name: us.signatoryName, title: us.signatoryTitle }; }
  // The signing link survives a reload for whoever may send / resend it.
  if ((permissions.lifecycle || permissions.sendLink) && req.client.esignToken
    && ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'].includes(normalizeAgreementStatus(req.client.agreementStatus))) {
    out.signingPath = agreementSigning.pathFor(req.client);
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// GET /clients/:id/overview — everything the Client Detail tabs show, in one
// scoped, redacted payload: Requirements, Candidates, Interviews, Selections,
// Joinings, Invoices and Activity.
//
// It is assembled HERE rather than by the browser stitching /applications and
// /invoices together, because a client login must never be handed the rows it
// is then asked not to render. Fee, salary, AI evaluation, recruiter notes and
// pipeline sourcing detail are stripped from the payload itself.
// ---------------------------------------------------------------------------
const SELECTED_STAGES = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const JOINED_STAGES = ['JOINED', 'HIRED'];
const CLIENT_VISIBLE_STAGES = [
  'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED',
];

function shapeApplication(a, forClient) {
  const base = {
    id: a.id,
    stage: a.stage,
    createdAt: a.createdAt,
    requirementId: a.requirementId,
    requirementTitle: a.requirement ? a.requirement.title : null,
    requirementCode: a.requirement ? a.requirement.reqCode : null,
    candidateId: a.candidateId,
    candidateName: a.candidate ? a.candidate.name : null,
    candidateLocation: a.candidate ? a.candidate.location : null,
    candidateExperience: a.candidate ? a.candidate.experienceYears : null,
    candidateSkills: a.candidate ? a.candidate.skills : null,
    candidateDesignation: a.candidate ? a.candidate.currentDesignation : null,
    interviewCode: a.interviewCode,
    interviewAt: a.interviewAt,
    interviewStatus: a.interviewStatus,
    interviewRound: a.interviewRound,
    interviewType: a.interviewType,
    interviewMode: a.interviewMode,
    interviewer: a.interviewer,
    interviewResult: a.interviewResult,
    joiningDate: a.joiningDate,
    // the day a JOINED person joined (one rule for every list: utils/joinDayShared.js); null = not recorded
    joinedDay: ['JOINED', 'HIRED'].includes(a.stage) ? joinDayShared.joinDay(a, null) : null,
  };
  if (forClient) return base;
  // Internal-only: the evaluation trail, the sourcing trail and the money.
  return {
    ...base,
    candidateEmail: a.candidate ? a.candidate.email : null,
    candidatePhone: a.candidate ? a.candidate.phone : null,
    candidateCurrentSalary: a.candidate ? a.candidate.currentSalary : null,
    candidateExpectedSalary: a.candidate ? a.candidate.expectedSalary : null,
    matchScore: a.matchScore,
    resumeScore: a.resumeScore,
    aiInterviewStatus: a.aiInterviewStatus,
    aiInterviewScore: a.aiInterviewScore,
    aiInterviewFeedback: a.aiInterviewFeedback,
    interviewFeedback: a.interviewFeedback,
    interviewScore: a.interviewScore,
    source: a.source,
    firstSource: a.firstSource,
    sourceCampaign: a.sourceCampaign,
    offeredCtc: a.offeredCtc,
  };
}

// The requirement columns the Client 360 Requirements tab draws — not the
// whole row (a requirement carries salary bands and internal notes the tab
// never shows).
const REQ_TAB_FIELDS = [
  'id', 'reqCode', 'title', 'department', 'location', 'openings', 'priority', 'status', 'targetDate',
  'closingDate', 'createdAt', 'internal', 'clientId', 'experience',
];
// Replacement / guarantee cases on Application.joiningStatus (utils/atsVocab.js).
const REPLACEMENT_STATUSES = [JOINING_REPLACEMENT_DUE, JOINING_REPLACED, JOINING_LEFT_AFTER_GUARANTEE];

router.get('/:id/overview', async (req, res) => {
  const forClient = isClient(req.user);
  const role = roleOf(req.user);
  // BDE business workspace (2026-10-10): a BDE's INVOICE view is limited and read-only - number, due date, status
  // (and the amount when the Role Catalog tick "See invoice amount" is on) - for their OWN clients only, behind the
  // Role Catalog switch "See invoice status" (on by default). On a colleague's client: no agreement text, no invoices.
  const colleague = !forClient && clientLifecycle.isDeskBde(req.user) && !clientLifecycle.ownsClient(req.user, req.client);
  const tabs = tabsFor(role).filter((t) => !(colleague && ['agreement', 'invoices', 'payments'].includes(t)));
  const show = (t) => tabs.includes(t);
  let invoiceMode = forClient ? 'client' : invoiceModeOf(role);
  let bdeAmount = false;
  if (!forClient && role === 'bde') {
    const mayStatus = !colleague && await can(req.user, 'ats', 'clients', 'Client Invoice Status', 'view');
    invoiceMode = mayStatus ? 'status' : 'none';
    bdeAmount = mayStatus && await can(req.user, 'ats', 'clients', 'Client Invoice Amount', 'view');
  }
  const level = clientLevelFor(req.user);
  const commercial = level === 'full' || level === 'billing';
  const id = req.client.id;

  // Requirements are scoped by the SAME helpers the requirements router
  // uses; a TL sees their TEAM's requirements for this client (§5 "👁 team"),
  // Accounts the ones it bills.
  // The BDE TL reads every client, so its jobs and people too (user, 2026-10-09).
  const bdeTl = isBdeTl(req.user);
  const reqScope = bdeTl ? {} : (role === 'tl' ? teamRequirementWhere(req.user) : requirementWhere(req.user));
  const requirements = show('requirements') || show('candidates')
    ? await prisma.requirement.findMany({
      where: { AND: [{ clientId: id }, reqScope] },
      include: { recruiter: { select: { name: true } }, bde: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    : [];
  const reqIds = requirements.map((r) => r.id);
  const pipelineVisible = PIPELINE_TABS.some(show);
  const invoicesVisible = show('invoices') && invoiceMode !== 'none';

  const [applications, invoices] = await Promise.all([
    // Candidates / Interviews / Selected / Replacements — never Accounts (§5).
    pipelineVisible && reqIds.length
      ? prisma.application.findMany({
        where: {
          AND: [
            { requirementId: { in: reqIds } },
            forClient ? { stage: { in: CLIENT_VISIBLE_STAGES } } : (bdeTl ? {} : applicationWhere(req.user)),
          ],
        },
        include: { candidate: true, requirement: true },
        orderBy: { updatedAt: 'desc' },
      })
      : [],
    // §6 — Invoices: amounts for Admin / Management / Accounts, the status
    // only for a BDE, nothing for a TL. A client login keeps its own view.
    (forClient || invoicesVisible)
      ? prisma.invoice.findMany({
        where: { AND: [{ clientId: id }, role === 'accounts' ? invoiceWhere(req.user) : {}] },
        include: { payments: { orderBy: { date: 'desc' } } },
        orderBy: { invoiceDate: 'desc' },
      })
      : null,
  ]);
  const canSeeInvoices = invoices !== null;

  const shaped = applications.map((a) => shapeApplication(a, forClient));

  // Replacements (§5): joinings inside the client's guarantee period, and
  // the replacement cases recorded on the joining (Replacement Due / Replaced
  // / Left after Guarantee). The guarantee END date is a commercial term —
  // sent only to a login that may see the guarantee period.
  const gDays = guaranteeDays(req.client.guaranteePeriod);
  const todayMs = Date.now();
  const replacements = show('replacements') ? applications.filter((a) => JOINED_STAGES.includes(a.stage)).map((a) => {
    const from = toDate(a.joiningDate) || toDate(a.joinedAt);
    const end = gDays && from ? new Date(from.getTime() + gDays * DAY_MS) : null;
    let caseStatus = null;
    if (REPLACEMENT_STATUSES.includes(a.joiningStatus)) caseStatus = a.joiningStatus;
    else if (end && end.getTime() >= todayMs && from.getTime() <= todayMs) caseStatus = 'Guarantee running';
    if (!caseStatus) return null;
    return {
      id: a.id,
      candidateId: a.candidateId,
      candidateName: a.candidate ? a.candidate.name : null,
      requirementId: a.requirementId,
      requirementCode: a.requirement ? a.requirement.reqCode : null,
      requirementTitle: a.requirement ? a.requirement.title : null,
      joiningDate: a.joiningDate || (a.joinedAt ? toDate(a.joinedAt).toISOString().slice(0, 10) : null),
      stage: a.stage,
      caseStatus,
      guaranteeEnds: commercial && end ? end.toISOString().slice(0, 10) : undefined,
    };
  }).filter(Boolean) : undefined;

  // REPLACEMENTS card (founder, 2026-10-22): every placement that LEFT (inside or after the guarantee) with the date it left, whose place it was, and
  // who came in his / her place and when. Left dates come from the joining & drop record (JoiningRecord); an older "Replacement due / Replaced"
  // mark with no drop record is listed too (left date blank). Same viewers as the guarantee list above.
  let replacementCases;
  if (show('replacements')) {
    const byApp = new Map(applications.map((a) => [a.id, a]));
    const ids = [...byApp.keys()];
    const recs = [];
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      // eslint-disable-next-line no-await-in-loop
      const got = await prisma.$queryRawUnsafe(
        `SELECT applicationId, joinedOn, droppedOn, dropReason, dropWithinGuarantee, guaranteeEndsOn, replacementStatus, replacementApplicationId, replacementLinkedAt FROM JoiningRecord WHERE applicationId IN (${part.map(() => '?').join(',')}) AND droppedOn IS NOT NULL`,
        ...part,
      ).catch(() => []);
      recs.push(...got);
    }
    const recOf = new Map(recs.map((r) => [r.applicationId, r]));
    const subIds = [...new Set(recs.map((r) => r.replacementApplicationId).filter(Boolean))];
    const subs = subIds.length ? await prisma.application.findMany({ where: { id: { in: subIds } }, select: { id: true, stage: true, joiningDate: true, joinedAt: true, candidateId: true, candidate: { select: { name: true } } } }) : [];
    const subOf = new Map(subs.map((s) => [s.id, s]));
    const dayOf = (v) => { const d = toDate(v); return d ? d.toISOString().slice(0, 10) : null; };
    replacementCases = applications
      .filter((a) => recOf.has(a.id) || REPLACEMENT_STATUSES.includes(a.joiningStatus))
      .map((a) => {
        const rec = recOf.get(a.id) || {};
        const sub = rec.replacementApplicationId ? subOf.get(rec.replacementApplicationId) : null;
        const subJoined = sub && JOINED_STAGES.includes(sub.stage);
        let caseStatus = 'Left';
        if (a.joiningStatus === JOINING_REPLACED) caseStatus = 'Replaced';
        else if (a.joiningStatus === JOINING_REPLACEMENT_DUE) caseStatus = sub ? 'Replacement coming' : 'Replacement due';
        else if (a.joiningStatus === JOINING_LEFT_AFTER_GUARANTEE) caseStatus = 'Left after guarantee (no replacement owed)';
        return {
          id: a.id,
          candidateId: a.candidateId,
          candidateName: a.candidate ? a.candidate.name : null, // the one who left
          requirementId: a.requirementId,
          requirementCode: a.requirement ? a.requirement.reqCode : null,
          requirementTitle: a.requirement ? a.requirement.title : null,
          joinedOn: rec.joinedOn || dayOf(a.joiningDate) || dayOf(a.joinedAt),
          leftOn: rec.droppedOn || null,
          reason: rec.dropReason || null,
          caseStatus,
          replacementId: sub ? sub.candidateId : null,
          replacementName: sub && sub.candidate ? sub.candidate.name : null, // who came in his / her place
          replacementJoinedOn: subJoined ? (dayOf(sub.joiningDate) || dayOf(sub.joinedAt)) : null,
          replacementStage: sub ? sub.stage : null,
          guaranteeEnds: commercial && rec.guaranteeEndsOn ? rec.guaranteeEndsOn : undefined,
        };
      })
      .sort((x, y) => String(y.leftOn || '').localeCompare(String(x.leftOn || '')));
  }

  // Invoices + Payments shaped per mode.
  let invoiceRows;
  let paymentRows;
  if (invoices) {
    await CNU.decorateNet(invoices); // B9.9: total / billed after issued notes
    if (forClient) {
      // A client never sees the money side of an invoice beyond what it owes.
      invoiceRows = invoices.map((i) => ({
        id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate,
        amount: i.amount, gst: i.gst, tds: i.tds, status: i.status,
      }));
    } else if (invoiceMode === 'status') {
      // BDE: status only (Paid / Pending / Overdue) — no amount of any kind.
      invoiceRows = invoices.map((i) => ({
        id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate, status: i.status,
        ...(bdeAmount ? { amount: i.amount } : {}),
      }));
      paymentRows = [];
      invoices.forEach((i) => {
        if (i.payments.length) {
          i.payments.forEach((p) => paymentRows.push({ id: p.id, invoiceId: i.id, invoiceNumber: i.invoiceNumber, date: p.date, status: 'Received' }));
        } else if (Number(i.receivedAmount || 0) > 0) {
          paymentRows.push({ id: `inv-${i.id}`, invoiceId: i.id, invoiceNumber: i.invoiceNumber, date: i.paidDate || null, status: 'Received' });
        }
      });
    } else {
      invoiceRows = invoices.map(({ payments, ...i }) => ({
        ...i,
        total: CNU.receivableOf(i), // B9.9: net of issued notes (stored figure when none)
        billed: CNU.billedOf(i),
        asBilledTotal: invoiceTotal(i),
        outstanding: Math.max(0, invoiceOutstanding(i)),
      }));
      paymentRows = [];
      invoices.forEach((i) => {
        if (i.payments.length) {
          i.payments.forEach((p) => paymentRows.push({
            id: p.id, invoiceId: i.id, invoiceNumber: i.invoiceNumber, date: p.date, amount: p.amount,
            method: p.method, reference: p.reference, recordedBy: p.recordedBy,
          }));
        } else if (Number(i.receivedAmount || 0) > 0) {
          // An imported / hand-marked receipt with no payment line.
          paymentRows.push({
            id: `inv-${i.id}`, invoiceId: i.id, invoiceNumber: i.invoiceNumber, date: i.paidDate || null,
            amount: i.receivedAmount, method: null, reference: null, recordedBy: null, fromInvoice: true,
          });
        }
      });
      paymentRows.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
    }
  }

  // Activity: the audit trail for this client and its requirements (in
  // scope) and the key pipeline events. A client login sees only the
  // agreement milestones on its own record; Accounts sees its OWN entries
  // (§5 "✅ own"); a TL sees what happened, never the commercial values an
  // edit carried.
  const reqIdList = reqIds.length ? reqIds : ['__none__'];
  let auditWhere;
  if (forClient) auditWhere = { entity: 'Client', entityId: id };
  else if (role === 'accounts') {
    auditWhere = { userId: req.user.id, OR: [{ entity: 'Client', entityId: id }, { entity: 'Requirement', entityId: { in: reqIdList } }] };
  } else auditWhere = { OR: [{ entity: 'Client', entityId: id }, { entity: 'Requirement', entityId: { in: reqIdList } }] };
  const [activity, stageEvents, relationship] = await Promise.all([
    prisma.auditLog.findMany({
      where: auditWhere,
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    (!forClient && pipelineVisible && reqIds.length)
      ? prisma.applicationStageEvent.findMany({
        where: { application: { AND: [{ requirementId: { in: reqIds } }, bdeTl ? {} : applicationWhere(req.user)] } },
        select: {
          id: true, fromStage: true, toStage: true, action: true, comment: true, actorName: true, actorRole: true, createdAt: true,
          candidate: { select: { name: true } },
          application: { select: { requirement: { select: { reqCode: true, title: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 150,
      })
      : [],
    forClient ? null : clientWorkload(req.user, [req.client]),
  ]);
  const reqLabel = new Map(requirements.map((r) => [r.id, r.reqCode || r.title]));
  // ATS layout v3 — Client page "Requirements" (filled, assigned recruiters,
  // the status chain) and "Performance" (rejection reasons). Job-level facts
  // (people on it / joined) are counted over the WHOLE job, the same rule the
  // Jobs list uses (utils/requirementDisplayStatus.js). Rejection reasons are
  // internal reasoning — never sent to a client login.
  const [jobApps, jobJoined, rejectEvents] = await Promise.all([
    !forClient && reqIds.length ? prisma.application.groupBy({ by: ['requirementId'], where: { requirementId: { in: reqIds } }, _count: { _all: true } }) : [],
    !forClient && reqIds.length ? prisma.application.groupBy({ by: ['requirementId'], where: { requirementId: { in: reqIds }, stage: { in: JOINED_STAGES } }, _count: { _all: true } }) : [],
    !forClient && pipelineVisible && reqIds.length
      ? prisma.applicationStageEvent.findMany({
        where: { toStage: 'REJECTED', application: { AND: [{ requirementId: { in: reqIds } }, { stage: 'REJECTED' }, bdeTl ? {} : applicationWhere(req.user)] } },
        select: { applicationId: true, reasonCategory: true, reasonDetail: true, comment: true, actorSide: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
      : [],
  ]);
  const appsOfJob = new Map(jobApps.map((g) => [g.requirementId, g._count._all]));
  const joinedOfJob = new Map(jobJoined.map((g) => [g.requirementId, g._count._all]));
  const coIds = [...new Set(requirements.flatMap((r) => String(r.recruiterIds || '').split(',').map((s) => s.trim()).filter(Boolean)))];
  const coNames = (!forClient && coIds.length)
    ? new Map((await prisma.user.findMany({ where: { id: { in: coIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map();
  // The latest rejection record per application (reason + which side).
  const seenRej = new Set();
  const rejectionTally = { reasons: new Map(), sides: new Map() };
  rejectEvents.forEach((e) => {
    if (seenRej.has(e.applicationId)) return;
    seenRej.add(e.applicationId);
    const detail = e.reasonDetail && e.reasonDetail !== 'Rejected' ? e.reasonDetail : null;
    const reason = String(e.reasonCategory || detail || e.comment || 'Reason not recorded').trim().slice(0, 60);
    const side = e.actorSide || 'Not recorded';
    rejectionTally.reasons.set(reason, (rejectionTally.reasons.get(reason) || 0) + 1);
    rejectionTally.sides.set(side, (rejectionTally.sides.get(side) || 0) + 1);
  });
  const tally = (m) => [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  // Review #3 §5 — Assigned TL on the Client 360 comes from its requirements.
  const tlIds = [...new Set(requirements.map((r) => r.tlId).filter(Boolean))];
  const tlNames = (!forClient && tlIds.length)
    ? new Map((await prisma.user.findMany({ where: { id: { in: tlIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    : new Map();
  const valuesHidden = (a) => ['tl', 'stl', 'am'].includes(role) && a.entity === 'Client' && a.action !== 'Client note';

  const out = {
    tabs,
    invoiceMode,
    canSeeInvoices,
    redacted: forClient,
    // Always: the Overview "Assigned TL / on its requirements" cards read
    // these names, and the counts header.
    requirementCount: requirements.length,
    activity: [
      ...activity.map((a0) => { const a = scrubHrActivity(req.user, a0); return ({
        id: a.id,
        kind: a.action === 'Client note' ? 'note' : 'audit',
        action: a.action,
        entity: a.entity,
        subject: a.entity === 'Requirement' ? (reqLabel.get(a.entityId) || 'Requirement') : 'Client',
        field: valuesHidden(a) ? null : (a.fieldLabel || a.field || null),
        fromValue: valuesHidden(a) ? null : a.fromValue,
        toValue: valuesHidden(a) ? null : a.toValue,
        reason: forClient || valuesHidden(a) ? null : (a.reason || null),
        createdAt: a.createdAt,
        by: forClient ? null : (a.actorName || (a.user ? a.user.name : 'System')),
      }); }),
      ...stageEvents.map((e) => ({
        id: `se-${e.id}`,
        kind: 'stage',
        action: e.action,
        entity: 'Candidate',
        subject: [e.candidate?.name, e.application?.requirement?.reqCode || e.application?.requirement?.title].filter(Boolean).join(' · '),
        fromValue: e.fromStage,
        toValue: e.toStage,
        reason: e.comment || null,
        createdAt: e.createdAt,
        by: e.actorName || 'System',
        byRole: e.actorRole || null,
      })),
    ].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, 200),
    // §9 — the relationship numbers for the header (internal logins only),
    // already cut to the role by clientWorkload.
    summary: relationship ? (relationship.rows.get(id) || null) : null,
  };
  if (show('requirements')) {
    out.requirements = requirements.map((r) => {
      const row = {};
      REQ_TAB_FIELDS.forEach((k) => { row[k] = r[k]; });
      return {
        ...row,
        recruiterName: r.recruiter ? r.recruiter.name : null,
        bdeName: r.bde ? r.bde.name : null,
        tlName: forClient ? null : ((r.tlId && tlNames.get(r.tlId)) || r.tl || null),
        live: requirementIsLive(r.status),
        ...(forClient ? {} : {
          filled: joinedOfJob.get(r.id) || 0,
          // Recruiter + co-recruiters, names only.
          recruiters: [r.recruiter ? r.recruiter.name : null,
            ...String(r.recruiterIds || '').split(',').map((s) => coNames.get(s.trim())).filter(Boolean)]
            .filter((n, i, a) => n && a.indexOf(n) === i),
          displayStatus: reqDisplay.displayStatusOf(r, appsOfJob.get(r.id) || 0, joinedOfJob.get(r.id) || 0),
        }),
      };
    });
  }
  if (!forClient && pipelineVisible) {
    out.rejections = { total: seenRej.size, reasons: tally(rejectionTally.reasons), sides: tally(rejectionTally.sides) };
  }
  // joined people with no joining date and no joined-at time are dated by their move into Joined (the ATS reports' rule)
  {
    const need = shaped.filter((a) => ['JOINED', 'HIRED'].includes(a.stage) && !a.joinedDay).map((a) => a.id);
    for (let i = 0; i < need.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: { in: need.slice(i, i + 500) }, toStage: { in: ['JOINED', 'HIRED'] } }, orderBy: { createdAt: 'asc' }, select: { applicationId: true, createdAt: true } });
      const last = new Map(); evs.forEach((e) => last.set(e.applicationId, e.createdAt));
      shaped.forEach((a) => { if (!a.joinedDay && last.has(a.id)) a.joinedDay = joinDayShared.istDay(last.get(a.id)); });
    }
  }
  if (show('candidates')) out.candidates = shaped;
  if (show('interviews')) out.interviews = shaped.filter((a) => a.interviewAt || a.interviewStatus || a.interviewCode);
  if (show('selected')) {
    out.selections = shaped.filter((a) => SELECTED_STAGES.includes(a.stage));
    out.joinings = shaped.filter((a) => JOINED_STAGES.includes(a.stage));
  }
  if (replacements) out.replacements = replacements;
  if (replacementCases) {
    out.replacementCases = replacementCases;
    // the header card: how many placements left (the number comes with the list, so it never shows to a login that cannot open the list)
    if (out.summary && replacementCases.length) out.summary = { ...out.summary, replacementCount: replacementCases.length };
  }
  if (invoiceRows && (show('invoices') || forClient)) out.invoices = invoiceRows;
  if (paymentRows && show('payments')) out.payments = paymentRows;
  res.json(out);
});

// §8.5 — ADD NOTE, from the list row or the Activity tab. Clients have no
// notes table of their own and a new one would be a schema change, so a
// note is an AuditLog row (entity 'Client', action 'Client note', the text in
// `reason`) — it lands in the client's Activity timeline and refreshes its
// Last Activity / Health like any other activity. Admin, BDE (own clients —
// the scope check above) and Accounts (§5 Notes: ✅ / ✅ / ✅ own).
router.post('/:id/notes', async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Client Notes', 'create'))) {
    return res.status(403).json({ error: 'Notes on a client are added by Admin, a Manager or the BDE.' });
  }
  { const refusal = bdeEditRefusal(req.user, req.client); if (refusal) return res.status(403).json({ error: refusal }); }
  const text = String((req.body && req.body.note) || '').trim();
  if (!text) return res.status(400).json({ error: 'Write the note first.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Keep the note under 2,000 characters.' });
  // "Meeting / call note" (2026-10-10): the same note, with its kind in front so the history says what it was.
  const noteKind = { call: 'Call', meeting: 'Meeting' }[String((req.body && req.body.kind) || '').toLowerCase()] || null;
  await logAudit({
    userId: req.user.id, actorName: req.user.name || null, action: 'Client note', entity: 'Client', entityId: req.client.id, reason: noteKind ? `[${noteKind}] ${text}` : text,
  });
  return res.status(201).json({ ok: true });
});

// Every field the prototype's saveNewClient() (line 7437) records, grouped by
// the tab it sits on in the Add Client modal, plus the clireq profile depth.
const CLIENT_FIELDS = {
  text: [
    // Basic Info
    'name', 'clientCode', 'legalName', 'website', 'industry', 'ownerDepartment', 'yearEstablished', 'landline',
    'status', 'activeDate', 'clientType', 'priority',
    'contactName', 'contactDesignation', 'contactPhone', 'contactEmail', 'contactWhatsApp',
    'secondaryContactName', 'secondaryContactDesignation', 'secondaryContactPhone', 'secondaryContactEmail',
    'commPrimary', 'commSecondary', 'commChannels',
    'houseNumber', 'street', 'landmark', 'area', 'pincode', 'country', 'state', 'location',
    // Billing & recruitment contacts (clireq)
    'billingContactName', 'billingContactDesignation', 'billingContactEmail', 'billingContactPhone',
    'recruitmentContactName', 'recruitmentContactDesignation', 'recruitmentContactEmail', 'recruitmentContactPhone',
    // Legal & Finance
    'gst', 'pan', 'tan', 'businessType', 'paymentTerms', 'guaranteePeriod', 'invoiceTrigger',
    'paymentDue', 'commercialNotes', 'accountManager', 'bdeOwner',
    // Agreement
    'agreementRequired', 'agreementTemplate', 'agreementStart', 'agreementEnd',
    // Risk Monitoring
    'riskFlag', 'riskNotes',
  ],
  numeric: ['agreementFeePercent', 'tdsPercent', 'gstPercent'],
};

function pickClient(body) {
  const data = {};
  for (const key of CLIENT_FIELDS.text) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  for (const key of CLIENT_FIELDS.numeric) {
    if (body[key] !== undefined && body[key] !== '') data[key] = Number(body[key]);
  }
  // typed Industry / Company type (2026-10-14): no HTML, spaces collapsed, at most 80 characters
  ['industry', 'companyType'].forEach((k) => { if (typeof data[k] === 'string') data[k] = require('../utils/openVocab').clean(data[k]); }); // eslint-disable-line global-require
  return data;
}
// the same Industry spelling as other clients use (case-insensitive)
async function canonIndustry(data) {
  if (data && data.industry) data.industry = await require('../utils/openVocab').canonicalColumn('client', 'industry', data.industry); // eslint-disable-line global-require
}

// Human-readable client code (CLI0001 …), assigned at creation if the form
// did not supply one. It is what the Client Detail header shows.
// Automatic and race-safe (utils/autoNumber.js): one counter, never reused.
async function nextClientCode() {
  return require('../utils/autoNumber').nextClientNumber(); // eslint-disable-line global-require
}

// THE NEW CLIENT'S DATA — exactly what POST /clients will store, built in ONE
// place so the Add-client live preview (POST /clients/agreement-preview) and
// the saved draft come from the same values and the same template.
async function draftClientData(req) {
  const data = pickClient(req.body || {});
  await canonIndustry(data);
  // Sections 1–9 (2026-10-05): the new columns this database has.
  const profile = clientProfile.pickProfile(req.body || {});
  Object.assign(data, profile.data);
  req.pendingProfileFields = profile.pending;
  if (data.billingSameAsAddress) data.billingAddress = null;
  ['gst', 'pan', 'tan'].forEach((k) => { if (typeof data[k] === 'string') data[k] = data[k].trim().toUpperCase() || null; });
  // Client ID: automatic when blank; only Super Admin / Admin may type one.
  if (!scopeOf(req.user).global) delete data.clientCode;
  // §9 — a BDE adding a client is its Owner BDE; they cannot name another
  // (Owner BDE assignment is global-only — Admin). Client.bdeOwner holds the
  // owner's full name, which is also what puts it in the BDE's own scope.
  // The BDE TL (user, 2026-10-09) adds a client for ANY department and PICKS its
  // BDE: what they choose stays (checked against the department further down).
  if (!scopeOf(req.user).global && !isBdeTl(req.user)) {
    if (roleOf(req.user) === 'bde') data.bdeOwner = req.user.name || null;
    else delete data.bdeOwner;
  }
  // 2026-10-09 — a desk BDE's new client belongs to THEIR desk (seat BDE-MED ->
  // Medical), whatever department the form sent.
  {
    const nd = await newClientDepartment(req.user);
    if (nd.locked) data.ownerDepartment = nd.locked;
  }

  // e2e gap 11: a client added by a BDE without an owner department gets the
  // BDE's own department, so that department's TL can raise its jobs (the
  // TL's client picker is by owner department, utils/scope.js).
  if (!String(data.ownerDepartment || '').trim() && roleOf(req.user) === 'bde') {
    const sc = scopeOf(req.user);
    const dept = (sc && Array.isArray(sc.departments) && sc.departments[0]) || req.user.atsDepartment || null;
    if (dept) data.ownerDepartment = dept;
  }
  // SPEC 6 — THE AGREEMENT DRAFT STARTS FROM THE ADMIN DEFAULTS. Only a login
  // that may edit commercial terms (Super Admin / Admin) may set this
  // client's own fee / guarantee / payment terms here; for anyone else (a
  // BDE) the sent values are ignored. Whatever is not set comes from
  // Agreement settings (utils/agreementSettings.js).
  const agreementDefaults = await agreementSettingsStore.agreementSettings({ fresh: true });
  if (!(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit'))) {
    AGREEMENT_AUDIT_FIELDS.forEach((k) => { delete data[k]; });
    clientProfile.NEW_COMMERCIAL_FIELDS.forEach((k) => { delete data[k]; });
  }
  // A % fee keeps no amount; a fixed fee keeps its amount.
  if (data.feeType === 'PERCENT_CTC') data.feeAmount = null;
  const draftTerms = agreementSettingsStore.draftTermsFrom(agreementDefaults);
  Object.entries(draftTerms).forEach(([k, v]) => {
    if (data[k] === undefined || data[k] === null || data[k] === '' || (typeof data[k] === 'number' && !Number.isFinite(data[k]))) data[k] = v;
  });
  return data;
}
// The Prisma column defaults the template reads, so a preview built before
// the row exists prints what the created row will print.
const previewRow = (data) => ({ country: 'India', gstPercent: 18, ...data });
const docHash = (text) => require('crypto').createHash('sha256').update(String(text || '')).digest('hex'); // eslint-disable-line global-require

router.post('/', requirePerm('ats', 'clients', 'Add Client', 'create'), async (req, res) => {
  let data;
  try { data = await draftClientData(req); } catch (err) {
    if (err.code === 'NO_SECRET_KEY') return res.status(500).json({ error: 'The bank account cannot be saved until the server has its secret key set. Remove it and save again.' });
    throw err;
  }
  // Prototype saveNewClient(): the full save requires company name, location
  // and the three primary-contact fields. Saving as a draft skips the checks.
  // 2026-10-05 — mode 'draft' (Save Draft: the company name only, no
  // agreement) or 'create' (Save & Create Agreement: the 10 required fields
  // + the draft agreement exactly as previewed). No mode = the older form.
  const mode = ['draft', 'create'].includes(req.body.mode) ? req.body.mode : null;
  const asDraft = Boolean(req.body.asDraft) || mode === 'draft';
  if (!String(data.name || '').trim()) return res.status(400).json({ error: 'Write the company name.', errors: [{ field: 'name', error: 'Write the company name.' }] });
  // The client's BDE (and second BDE) must work for the client's department
  // (user, 2026-10-09; the BDE TL covers all) — checked by the seat code.
  {
    const dir = await bdeDirectory();
    const ownerBad = bdeDepartmentProblem(dir, data.bdeOwner, data.ownerDepartment, 'The client manager');
    const secondBad = bdeDepartmentProblem(dir, data.secondaryBde, data.ownerDepartment, 'The second BDE');
    const bad = ownerBad || secondBad;
    if (bad) return res.status(400).json({ error: bad, errors: [{ field: ownerBad ? 'bdeOwner' : 'secondaryBde', error: bad }] });
  }
  const formatErrs = clientProfile.formatErrors(req.body || {});
  if (formatErrs.length) return res.status(400).json({ error: formatErrs[0].error, errors: formatErrs });
  if (mode === 'create') {
    const missing = clientProfile.missingRequired(data);
    if (missing.length) {
      return res.status(400).json({
        error: `Fill these first: ${missing.map((m) => m.label).join(', ')}.`,
        errors: missing.map((m) => ({ field: m.field, error: `${m.label} is needed.` })),
      });
    }
  }
  if (!asDraft && !mode) {
    if (!data.state) return res.status(400).json({ error: 'Select the client location (State/District/City).' });
    if (!data.contactName || !data.contactEmail || !data.contactPhone) {
      return res.status(400).json({ error: 'Enter the primary contact name, phone and email.' });
    }
  }
  // §8 DUPLICATE GUARD. A same-GSTIN / same-PAN / same-name / merged-alias
  // match is refused unless the request carries an explicit override (the
  // "Create Anyway" click) — and an override is audit-logged with the reason.
  // Weaker signals (phone, email, near-typo, address) never block the API;
  // the form shows them before it saves.
  // 2026-10-22 ONE COMPANY, MANY LOCATIONS: a same-name client is usually another branch. The save never says "error": it
  // answers with a QUESTION (409 + question: the matching clients, why, and what to press). Confirmed (confirmSeparate, or the
  // older allowDuplicate) it is added as its own client - its own agreement, renewal and requirements. Same name needs a
  // Location; the same name AND the same location needs one line of reason. Nothing is merged, no alias is made.
  const dup = await findClientDuplicates({ ...req.body, location: data.location, state: data.state });
  const override = CLOC.isConfirmed(req.body);
  const question = await CLOC.buildQuestion(dup, { ...req.body, location: data.location });
  if (question && !override) return res.status(409).json(CLOC.questionResponse(question, dup));
  if (question) {
    const problem = CLOC.confirmProblem(question, req.body, data.location);
    if (problem) return res.status(problem.status).json(problem.body);
  }
  // Sections 6-9 are filled by Purna Sir (HR) / Admin after the BDE sends the client on - never typed on the Add form by a BDE.
  {
    const wfRoles = await AWF.rolesOf(req.user);
    const hrSent = wfRoles.admin ? [] : AWF.HR_KEYS.filter((k) => k !== 'billingSameAsAddress' && data[k] !== undefined && data[k] !== null && String(data[k]).trim() !== '');
    if (hrSent.length) {
      return res.status(403).json({ error: `Tax & billing, Payment details, Documents and Notes are filled by ${wfRoles.cfg.hrLabel} after you send the client to ${wfRoles.cfg.hrLabel}.`, fields: hrSent });
    }
  }
  if (!data.clientCode) data.clientCode = await nextClientCode();

  const client = await prisma.client.create({ data: { ...data, agreementStatus: 'DRAFT' } });
  CLOC.forgetLabels();
  // the same name at another location is added without a question (utils/clientLocations.js buildQuestion): the audit log
  // still says which client it is another location of
  const otherPlaces = !question ? (dup.matches || []).filter((m) => m.blocking && m.sameName) : [];
  if (otherPlaces.length) {
    const main = otherPlaces[0];
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name || null,
      action: `Added as another location of ${main.displayCode || main.name}`,
      entity: 'Client',
      entityId: client.id,
      fromValue: main.id,
      toValue: `${main.name}${main.location ? ` (${main.location})` : ''} - /clients/${main.id}${otherPlaces.length > 1 ? `; also: ${otherPlaces.slice(1).map((m) => `/clients/${m.id}`).join(', ')}` : ''}`.slice(0, 1000),
      reason: `New location: ${data.location || ''}`,
    });
  }
  if (override && question && question.level !== 'sameId') {
    // Another location of a client we already have: say which one, who added it, when (the audit row has both) and why.
    const mates = question.matches.filter((m) => m.sameName);
    const main = mates[0];
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name || null,
      action: `Added as another location of ${main.displayCode}`,
      entity: 'Client',
      entityId: client.id,
      fromValue: main.id,
      toValue: `${main.name}${main.location ? ` (${main.location})` : ''} ${main.displayCode} - /clients/${main.id}${mates.length > 1 ? `; also: ${mates.slice(1).map((m) => `${m.displayCode} /clients/${m.id}`).join(', ')}` : ''}`.slice(0, 1000),
      reason: CLOC.reasonOf(req.body) || (question.level === 'likelySame' ? 'Added as a separate client' : `New location: ${data.location || ''}`),
    });
  } else if (override && dup.total > 0 && !otherPlaces.length) {
    const note = String(req.body.duplicateNote || req.body.separateReason || '').trim().slice(0, 500);
    await logAudit({
      userId: req.user.id,
      action: 'Client created despite possible duplicate',
      entity: 'Client',
      entityId: client.id,
      toValue: describeMatches(dup.matches).slice(0, 1000),
      reason: note || 'Create Anyway confirmed without a note',
    });
  }
  // SPEC 6 — the agreement DRAFT is created automatically from the ready
  // template with the terms above (createAgreement: false only when the form
  // uploads the client's own agreement right after). It starts as a Draft.
  // THE "MADE ON" DATE (user, 2026-10-10) is saved WITH the draft: the agreement
  // date typed on the form, else today (India time). It lives in agreementStart,
  // so the saved text, the signing page, the PDF and the Agreements tab agree.
  const madeOn = vendorAgreement.effectiveYmd(client);
  const withDoc = req.body.createAgreement !== false && mode !== 'draft'
    ? await prisma.client.update({
      where: { id: client.id },
      data: {
        agreementStart: madeOn,
        agreementDocument: buildAgreementDocument({ ...client, agreementStart: madeOn }, await consultantParty()),
        agreementSource: 'Generated',
        agreementId: client.agreementId || (await nextAgreementId()),
      },
    })
    : client;
  await logAudit({ userId: req.user.id, action: 'Client created', entity: 'Client', entityId: client.id, toValue: 'Saved for later' });
  // Same text as the live preview the user was looking at? (previewHash is
  // the sha256 the preview returned; absent = no preview was shown.)
  const matchesPreview = withDoc.agreementDocument && req.body.previewHash
    ? docHash(withDoc.agreementDocument) === String(req.body.previewHash) : null;
  if (withDoc.agreementDocument) {
    await logAudit({
      userId: req.user.id, action: 'Agreement created from template', entity: 'Client', entityId: client.id,
      toValue: 'DRAFT',
      reason: `${withDoc.agreementTemplate || 'Standard template'} · fee ${withDoc.agreementFeePercent}% · guarantee ${withDoc.guaranteePeriod} · ${withDoc.paymentDue || withDoc.paymentTerms}${matchesPreview === true ? ' · same as the preview shown' : (matchesPreview === false ? ' · DIFFERENT from the preview shown' : '')}`.slice(0, 1000),
    });
  }
  res.status(201).json({
    ...(await shapeFor(req, withDoc)),
    agreementMatchesPreview: matchesPreview,
    missing: clientProfile.missingRequired(withDoc).map((m) => m.label),
    pendingFields: req.pendingProfileFields || [],
  });
});

// The Client Master fields an edit is reported by, in the Activity trail.
const FIELD_LABELS = {
  name: 'Display Name', legalName: 'Legal Name', clientCode: 'Client ID', gst: 'GSTIN', pan: 'PAN', industry: 'Industry',
  location: 'City', state: 'State', contactName: 'Primary Contact', contactPhone: 'Primary Phone', contactEmail: 'Primary Email',
  paymentTerms: 'Payment Terms', guaranteePeriod: 'Guarantee Period', agreementFeePercent: 'Fee %', accountManager: 'Account Manager',
  bdeOwner: 'BDE', ownerDepartment: 'Owner Department', status: 'Status', agreementStart: 'Agreement Start', agreementEnd: 'Agreement End',
};
Object.assign(FIELD_LABELS, {
  companyType: 'Company Type', companyEmail: 'Company Email', landline: 'Company Phone', website: 'Website', pincode: 'Pincode',
  street: 'Address', area: 'Area', country: 'Country', contactDesignation: 'Contact Designation', contactAltPhone: 'Alternate Phone',
  contactWhatsApp: 'WhatsApp', commPrimary: 'Preferred Communication', secondaryBde: 'Secondary BDE', clientSource: 'Source',
  feeType: 'Fee Type', feeAmount: 'Fee Amount', gstApplicable: 'GST Applicable', tdsApplicable: 'TDS Applicable',
  replacementTerms: 'Replacement Terms', specialTerms: 'Special Terms', billingAddress: 'Billing Address',
  billingSameAsAddress: 'Billing = Company Address', billingEmail: 'Billing Email', invoiceEmail: 'Invoice Email', tan: 'TAN',
  billingContactName: 'Accounts Contact', billingContactPhone: 'Accounts Phone', billingContactEmail: 'Accounts Email',
  paymentMethod: 'Payment Method', paymentBankName: 'Bank Name', paymentUpi: 'UPI', paymentReferenceNote: 'Payment Reference',
  bankAccountHolder: 'Account Holder', bankAccountNoEnc: 'Bank Account', bankAccountLast4: 'Bank Account (last 4)', bankIfsc: 'IFSC',
  internalNotes: 'Client Notes', specialInstructions: 'Special Instructions', recruitmentInstructions: 'Recruitment Instructions',
  internalRemarks: 'Internal Remarks',
});
Object.assign(FIELD_LABELS, {
  invoiceTrigger: 'Invoice Trigger', agreementTemplate: 'Agreement Template', agreementRequired: 'Agreement Required',
  agreementStatus: 'Agreement Status', paymentDue: 'Payment Due', tdsPercent: 'TDS %', gstPercent: 'GST %',
});
// The agreement's own terms — every change to one is written to the audit
// log field by field, old → new (clients role spec §6).
const AGREEMENT_AUDIT_FIELDS = [
  'agreementFeePercent', 'guaranteePeriod', 'paymentTerms', 'paymentDue', 'invoiceTrigger', 'agreementTemplate',
  'agreementRequired', 'agreementStart', 'agreementEnd', 'tdsPercent', 'gstPercent',
];
// Changing one of these re-runs the duplicate check against the NEW value.
const IDENTITY_FIELDS = ['name', 'legalName', 'gst', 'pan', 'contactPhone', 'contactEmail'];

router.put('/:id', requirePerm('ats', 'clients', 'Client Detail', 'edit'), async (req, res) => {
  { const refusal = bdeEditRefusal(req.user, req.client); if (refusal) return res.status(403).json({ error: refusal }); }
  const data = pickClient(req.body);
  await canonIndustry(data);
  const before = req.client;
  // Sections 1–9 (2026-10-05).
  const formatErrs = clientProfile.formatErrors(req.body || {});
  if (formatErrs.length) return res.status(400).json({ error: formatErrs[0].error, errors: formatErrs });
  let profile;
  try { profile = clientProfile.pickProfile(req.body || {}); } catch (err) {
    return res.status(500).json({ error: err.code === 'NO_SECRET_KEY' ? 'The bank account cannot be saved until the server has its secret key set.' : 'Could not save the bank account.' });
  }
  Object.assign(data, profile.data);
  if (data.billingSameAsAddress) data.billingAddress = null;
  if (data.feeType === 'PERCENT_CTC') data.feeAmount = null;
  ['gst', 'pan', 'tan'].forEach((k) => { if (typeof data[k] === 'string') data[k] = data[k].trim().toUpperCase() || null; });
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  const changed = Object.keys(data).filter((k) => !same(data[k], before[k]));
  if (data.name !== undefined && !String(data.name).trim()) {
    return res.status(400).json({ error: 'The client name cannot be blank.' });
  }
  // "Add contacts / edit contact details" is its own Role Catalog tick (2026-10-10).
  const CONTACT_KEYS = ['contactName', 'contactDesignation', 'contactPhone', 'contactEmail', 'contactWhatsApp', 'secondaryContactName', 'secondaryContactDesignation',
    'secondaryContactPhone', 'secondaryContactEmail', 'recruitmentContactName', 'recruitmentContactDesignation', 'recruitmentContactEmail', 'recruitmentContactPhone',
    'commPrimary', 'commSecondary', 'commChannels', 'landline'];
  if (changed.some((k) => CONTACT_KEYS.includes(k)) && !(await can(req.user, 'ats', 'clients', 'Client Contacts', 'create'))) {
    return res.status(403).json({ error: 'Adding or changing the client\'s contact people is not ticked for your role. Ask an Admin.' });
  }
  // THE AGREEMENT WORKFLOW (2026-10-13). Sections 6-9 are written by the HR step / Admin only; sections 1-5 are locked
  // while the client is with Purna Sir or the BDE TL (Admin can still edit = unlock).
  {
    const wfRow = await AWF.loadRow(before.id);
    const rights = await AWF.rightsFor(req.user, before, wfRow);
    const hrNow = (k) => (k === 'billingSameAsAddress' ? (data[k] !== false) !== (before[k] !== false) : AWF.HR_KEYS.includes(k));
    const hrChanged = changed.filter(hrNow);
    if (hrChanged.length && !rights.editHr) {
      return res.status(403).json({ error: `Tax & billing, Payment details, Documents and Notes are filled by ${(await AWF.settings()).hrLabel} or an Admin.`, fields: hrChanged });
    }
    const rest = changed.filter((k) => !AWF.HR_KEYS.includes(k));
    if (rest.length && rights.lockedCommercial && (rights.roles.bdeDesk || rights.roles.bdeTl)) {
      const who = rights.stage === 'WITH_HR' ? (await AWF.settings()).hrLabel : 'the BDE team lead';
      return res.status(403).json({ error: `It is with ${who} now, so you cannot change it. Ask ${who} to send it back, or ask an Admin.` });
    }
  }
  // STATUS moves only through Pause / Reactivate / Archive (reason + audit).
  if (changed.includes('status')) {
    return res.status(400).json({ error: 'Client status changes through Pause / Reactivate / Archive (each needs a reason) — not the edit form.', field: 'status' });
  }
  // §7 / contract — re-assigning the OWNER BDE is Admin only. A BDE editing
  // their own client may change everything else, never who owns it.
  if (changed.includes('bdeOwner') && !scopeOf(req.user).global && !isBdeTl(req.user)
    && !(clientLifecycle.ownsClient(req.user, before) && await can(req.user, 'ats', 'clients', 'Client Ownership Request', 'create'))) {
    return res.status(403).json({ error: 'Only an Admin or the BDE team lead can reassign the Owner BDE of a client.' });
  }
  // The BDE must fit the department, whichever of the two changed.
  if (changed.some((k) => ['bdeOwner', 'secondaryBde', 'ownerDepartment'].includes(k))) {
    const dir = await bdeDirectory();
    const dept = data.ownerDepartment !== undefined ? data.ownerDepartment : before.ownerDepartment;
    const ownerName = data.bdeOwner !== undefined ? data.bdeOwner : before.bdeOwner;
    const secondName = data.secondaryBde !== undefined ? data.secondaryBde : before.secondaryBde;
    const ownerBad = bdeDepartmentProblem(dir, ownerName, dept, 'The client manager');
    const secondBad = bdeDepartmentProblem(dir, secondName, dept, 'The second BDE');
    const bad = ownerBad || secondBad;
    if (bad) return res.status(400).json({ error: bad, errors: [{ field: ownerBad ? 'bdeOwner' : 'secondaryBde', error: bad }] });
  }
  // A desk BDE keeps the client in THEIR desk: moving it to another department
  // is for the BDE TL or an Admin (user, 2026-10-09).
  if (changed.includes('ownerDepartment')) {
    const nd = await newClientDepartment(req.user);
    if (nd.locked && String(data.ownerDepartment || '').trim() !== nd.locked) {
      return res.status(403).json({ error: 'A client stays in your own department. Ask the BDE team lead or an Admin to move it.', field: 'ownerDepartment' });
    }
  }
  // Commercial terms (fee %, guarantee, payment terms …) need Commercial
  // Terms edit — the same can() the edit form is drawn from.
  const commercialChanged = changed.filter((k) => AGREEMENT_AUDIT_FIELDS.includes(k) || clientProfile.NEW_COMMERCIAL_FIELDS.includes(k) || ['gst', 'pan', 'tan', 'tdsPercent', 'gstPercent', 'businessType', 'commercialNotes'].includes(k));
  if (commercialChanged.length && !(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit'))) {
    return res.status(403).json({ error: 'Changing the commercial terms needs Commercial Terms edit permission.' });
  }
  // Client ID is unique: an empty value clears it (the display code shows),
  // a taken one is refused rather than failing on the unique index.
  if (changed.includes('clientCode')) {
    const code = String(data.clientCode || '').trim();
    // Empty = made for you: a client never goes without a Client ID.
    data.clientCode = code || before.clientCode || await nextClientCode();
    if (code) {
      const clash = await prisma.client.findFirst({ where: { clientCode: code, NOT: { id: before.id } }, select: { name: true } });
      if (clash) return res.status(400).json({ error: `Client ID ${code} is already used by ${clash.name}.` });
    }
  }

  // §8 — an edit that gives this client another client's GSTIN / PAN / name
  // is refused the same way a create is, unless explicitly overridden. Only
  // the CHANGED identity values are checked, so a long-standing look-alike
  // does not block an unrelated edit.
  const identity = changed.filter((k) => IDENTITY_FIELDS.includes(k));
  let dup = { matches: [], total: 0, blocking: false };
  let question = null;
  if (identity.length) {
    const probe = {};
    identity.forEach((k) => { probe[k] = data[k]; });
    const place = { location: data.location !== undefined ? data.location : before.location, state: data.state !== undefined ? data.state : before.state };
    dup = await findClientDuplicates({ ...probe, ...place }, { excludeId: before.id });
    // 2026-10-22: another location of the same company is expected - a same-name client at a DIFFERENT place never stops this save.
    const nameNow = data.name !== undefined ? data.name : before.name;
    dup = CLOC.withoutOtherLocations(dup, before, await CLOC.siblingsOf({ ...before, name: nameNow }), place);
    question = await CLOC.buildQuestion(dup, { ...probe, ...place });
  }
  const override = CLOC.isConfirmed(req.body);
  if (question && !override) return res.status(409).json(CLOC.questionResponse(question, dup));
  if (question) {
    const problem = CLOC.confirmProblem(question, req.body, data.location !== undefined ? data.location : before.location);
    if (problem) return res.status(problem.status).json(problem.body);
  }

  const client = await prisma.client.update({ where: { id: req.params.id }, data });
  CLOC.forgetLabels();
  const summary = changed
    .map((k) => (k === 'bankAccountNoEnc' ? 'Bank account changed' : `${FIELD_LABELS[k] || k}: ${String(before[k] ?? '').trim() || '—'} → ${String(data[k] ?? '').trim() || '—'}`))
    .join('; ');
  await logAudit({
    userId: req.user.id,
    action: 'Client updated',
    entity: 'Client',
    entityId: client.id,
    toValue: summary ? summary.slice(0, 1000) : 'No field changed',
  });
  // §6 — AGREEMENT EDITS in the audit log: one row per changed agreement
  // field with who (userId / actorName), when (createdAt) and old → new.
  const agreementChanges = changed.filter((k) => AGREEMENT_AUDIT_FIELDS.includes(k)).map((k) => ({
    field: k,
    label: FIELD_LABELS[k] || k,
    from: before[k] == null ? '' : String(before[k]),
    to: data[k] == null ? '' : String(data[k]),
  }));
  if (agreementChanges.length) {
    await logFieldChanges({
      userId: req.user.id,
      actorName: req.user.name || null,
      entity: 'Client',
      entityId: client.id,
      action: 'Agreement edited',
      changes: agreementChanges,
      approvalStatus: null,
    });
  }
  if (override && dup.total > 0) {
    await logAudit({
      userId: req.user.id,
      action: 'Client saved despite possible duplicate',
      entity: 'Client',
      entityId: client.id,
      toValue: describeMatches(dup.matches).slice(0, 1000),
      reason: CLOC.reasonOf(req.body) || 'Save Anyway confirmed without a note',
    });
  }
  res.json({ ...(await shapeFor(req, client)), pendingFields: profile.pending });
});

// §6 / spec 2026-10-03 §A — CLIENT DELETE now lives in routes/clientLifecycleRoutes.js
// (Super Admin only, empty clients only, typed-name confirmation, audit snapshot).

// ---- Service agreement lifecycle -------------------------------------------
//
//   Add Client -> GST / TDS / Payment Terms -> Agreement -> Preview
//     -> Upload / Generate -> Send to Client -> Client View
//     -> Client Confirmation / Signed Copy -> Agreement Active
//
// Statuses: DRAFT · SENT · VIEWED · CLIENT_CONFIRMATION_PENDING · SIGNED ·
//           ACTIVE · EXPIRED · REJECTED
//
// SIGNED and ACTIVE stay deliberately distinct: the client signing the
// document signs it, and TeamLink then activates it. Only an ACTIVE agreement
// lets a requirement for that client go live (see routes/requirements.js).
//
// CONFIRMED / CANCELLED are the pre-clireq spellings; normalizeAgreementStatus
// folds them into SIGNED / REJECTED on read, so an existing database keeps
// working and nothing writes them again.

// The states from which a document may still be (re)generated or uploaded.
const OPEN_FOR_AUTHORING = ['DRAFT', 'SENT', 'VIEWED', 'REJECTED', 'EXPIRED'];
// The states a client may still be asked to sign from.
const OUT_FOR_SIGNATURE = ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'];

function statusOf(client) {
  return normalizeAgreementStatus(client.agreementStatus);
}

async function agreementTransition(req, res, { id, from, data, action, to, reason }) {
  const client = await prisma.client.findUnique({ where: { id } });
  const current = statusOf(client);
  if (from && !from.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be ${action}.` });
  }
  // A new or replaced document always carries an Agreement No. (automatic).
  const updated = await prisma.client.update({ where: { id }, data: await withAgreementId(client, data) });
  await logAudit({
    userId: req.user.id, action, entity: 'Client', entityId: id, fromValue: current, toValue: to || current,
    ...(reason ? { reason: String(reason).slice(0, 500) } : {}),
  });
  return res.json((await shapeFor(req, updated)));
}

// Every stored signature / stamp image of an agreement — removed from disk
// when the document they were applied to is replaced.
function executionFiles(client) {
  return ['agreementCompanyStampFile', 'agreementCompanySignFile', 'agreementClientStampFile', 'agreementClientSignFile']
    .map((k) => client[k]).filter(Boolean);
}
function dropExecutionFiles(files) {
  files.forEach((f) => { try { agreementAttachments.remove(f); } catch { /* gone */ } });
}

// Generate the document from the client's own commercial terms.
// REGENERATING CLEARS THE EXECUTION: both parties' signatures, stamps, any
// OTP and the signing link belong to the old text.
router.post('/:id/agreement/generate', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed — it cannot be regenerated. A Super Admin / Admin can void it first.' });
  }
  const files = executionFiles(client);
  const consultant = await consultantParty();
  // THE "MADE ON" DATE (user, 2026-10-10): a new draft is made TODAY (India time).
  // body.keepDate = true keeps the agreement date already on the client instead.
  const madeOn = vendorAgreement.regenerateYmd(client, { keepDate: !!(req.body && req.body.keepDate === true) });
  const wasPrinted = vendorAgreement.madeOnOf(client.agreementDocument);
  const out = await agreementTransition(req, res, {
    id: client.id,
    from: OPEN_FOR_AUTHORING,
    action: 'Agreement document generated',
    to: 'DRAFT',
    reason: `made on ${vendorAgreement.ddmmyyyy(madeOn)}${wasPrinted ? ` (the earlier text said ${wasPrinted})` : ''}`,
    data: {
      ...agreementSigning.RESET_EXECUTION,
      agreementStart: madeOn,
      // An end date before the new start would be nonsense: it renews again.
      ...(client.agreementEnd && String(client.agreementEnd) < madeOn ? { agreementEnd: null } : {}),
      agreementDocument: buildAgreementDocument({ ...client, agreementStart: madeOn }, consultant),
      agreementStatus: 'DRAFT',
      agreementSource: 'Generated',
      agreementRejectedAt: null,
      agreementRejectedReason: null,
    },
  });
  if (res.statusCode < 400) dropExecutionFiles(files);
  return out;
});

// Upload a countersigned / negotiated document instead of generating one.
// The text arrives in the body — there is no file store in this app, and a
// base64 blob in SQLite would be a worse lie than storing the text.
router.post('/:id/agreement/upload', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const { document, fileName } = req.body;
  if (!String(document || '').trim()) {
    return res.status(400).json({ error: 'Paste or upload the agreement text to store it.' });
  }
  if (agreementIsSigned(req.client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed — upload a signed copy instead' });
  }
  const files = executionFiles(req.client);
  const out = await agreementTransition(req, res, {
    id: req.client.id,
    from: OPEN_FOR_AUTHORING,
    action: 'Agreement document uploaded',
    to: 'DRAFT',
    data: {
      ...agreementSigning.RESET_EXECUTION,
      agreementDocument: String(document),
      agreementStatus: 'DRAFT',
      agreementSource: 'Uploaded',
      agreementSignedCopyName: fileName || null,
    },
  });
  if (res.statusCode < 400) dropExecutionFiles(files);
  return out;
});

// The client's own agreement as a FILE (PDF / Word / picture, up to 10 MB): routes/agreementOwnFile.js.
require('./agreementOwnFile').mountUpload(router, { requirePerm, agreementTransition, executionFiles, dropExecutionFiles, OPEN_FOR_AUTHORING, agreementIsSigned, statusOf });

router.post('/:id/agreement/send', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  // Only the BDE TL (after the checks) or an Admin sends the link (user, 2026-10-13).
  { const refusal = await AWF.sendGate(req.user, client, req.body); if (refusal) return res.status(403).json({ error: refusal }); }
  if (!client.agreementDocument) return res.status(400).json({ error: 'Generate or upload the agreement document first' });
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed' });
  }
  const current = statusOf(client);
  if (!OPEN_FOR_AUTHORING.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be sent.` });
  }
  // TEAMLINK SIGNS FIRST (founder 2026-10-31: "TeamLink vallu eSign cheyyali kadha first"): the client gets the agreement only
  // once TeamLink's own Aadhaar eSigned copy (DigiLocker) is uploaded and checked valid - and that copy goes in the email too.
  {
    const SF = require('./agreementSignedFiles'); // eslint-disable-line global-require
    const mine = (await SF.filesOf(client.id).catch(() => [])).find((f) => f.kind === 'TeamLink eSigned copy (DigiLocker)' && f.esign && f.esign.valid);
    if (!mine) {
      return res.status(409).json({ error: 'TeamLink signs first. Open View agreement, press "Download agreement PDF to eSign", eSign it in DigiLocker (TeamLink director\'s Aadhaar) and upload it on the left (TeamLink eSigned PDF). Then press Send to client.' });
    }
  }

  // A NEW LINK EVERY SEND: any earlier link stops working, and whatever was
  // half-done on it (a signature without its code) is cleared.
  const staleClientFiles = [client.agreementClientSignFile, client.agreementClientStampFile].filter(Boolean);
  // A draft made before 2026-10-10 may still print "**-**-****": date it as it goes out.
  const dating = current === 'DRAFT' ? madeOnPatch(client) : null;
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      ...(dating ? dating.data : {}),
      agreementStatus: 'SENT',
      agreementSentAt: new Date(),
      agreementViewedAt: null,
      agreementId: client.agreementId || (await nextAgreementId()),
      // A new link: token stored hashed, valid for the Admin's link days.
      ...agreementSigning.newLinkData(client.id, { days: (await agreementSettingsStore.agreementSettings()).linkDays }).data,
      ...clearClientSide(),
    },
  });
  dropExecutionFiles(staleClientFiles);
  await AWF.afterSend(req.user, client).catch(() => {});
  await logAudit({
    userId: req.user.id, action: 'Agreement sent to client', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SENT',
    ...(dating ? { reason: `The text had no date: dated ${vendorAgreement.ddmmyyyy(dating.ymd)} as it was sent` } : {}),
  });

  // The client's own users get an in-app prompt.
  const clientUsers = await prisma.user.findMany({ where: { clientId: client.id, role: 'CLIENT' } });
  await notifyUsers(clientUsers.map((u) => u.id), {
    title: 'Service agreement ready to sign',
    message: `${client.name}: please review and e-sign agreement ${updated.agreementId}.`,
    exceptUserId: req.user.id,
  });

  // AND THE LINK GOES OUT on Email, SMS and WhatsApp — each channel only if it
  // is configured — with one honest result per channel (Sent / Not configured
  // / Skipped / Failed + reason), so the screen never implies a message that
  // was not sent.
  const delivery = await sendLinkEverywhere(req, updated);
  res.json({
    ...(await shapeFor(req, updated)),
    signingPath: agreementSigning.pathFor(updated),
    delivery,
    linkExpiresAt: agreementSigning.linkExpiresAt(updated),
    email: legacyEmailShape(delivery),
  });
});

// The client-side half of an execution, cleared when a new link is issued.
function clearClientSide() {
  return {
    agreementClientSignFile: null, agreementClientSignName: null,
    agreementClientStampFile: null, agreementClientStampName: null,
    agreementClientSealedAt: null, agreementVerifiedAt: null, agreementVerifyMobile: null,
    agreementVerifyMethod: null, agreementVerifyNote: null,
    ...agreementSigning.RESET_OTP,
  };
}

async function sendLinkEverywhere(req, client) {
  const delivery = await agreementLifecycle.dispatchSigningLink({
    client, url: agreementLifecycle.signingUrl(req, agreementSigning.tokenFor(client)), days: agreementSigning.linkMeta(client).days,
  });
  await logAudit({
    userId: req.user.id, action: agreementSigning.ACTION.sent, entity: 'Client', entityId: client.id,
    toValue: agreementLifecycle.describeDispatch(delivery),
    reason: agreementLifecycle.dispatchReasons(delivery),
  });
  return delivery;
}
// The pre-existing { emailed, to, reason } shape, for any screen still reading it.
function legacyEmailShape(delivery) {
  const e = (delivery && delivery.Email) || {};
  return { emailed: e.outcome === 'Sent', to: e.to || null, reason: e.outcome === 'Sent' ? null : (e.error || e.outcome || null) };
}

// Client View — the client opened the document. Recorded from inside the app
// by the client's own login; routes/public.js does the same for the tokenised
// link. SENT -> VIEWED, and never backwards.
router.post('/:id/agreement/view', async (req, res) => {
  const client = req.client;
  if (statusOf(client) !== 'SENT') return res.json((await shapeFor(req, client)));
  return agreementTransition(req, res, {
    id: client.id,
    from: ['SENT'],
    action: 'Agreement viewed by client',
    to: 'VIEWED',
    data: { agreementStatus: 'VIEWED', agreementViewedAt: client.agreementViewedAt || new Date() },
  });
});

// Ask the client to confirm — the explicit "Client Confirmation Pending" step
// between the client having read it and the client having signed it.
router.post('/:id/agreement/request-confirmation', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const clientUsers = await prisma.user.findMany({ where: { clientId: req.client.id, role: 'CLIENT' } });
  await notifyUsers(clientUsers.map((u) => u.id), {
    title: 'Please confirm your service agreement',
    message: `${req.client.name}: ${req.client.agreementId || 'the agreement'} is awaiting your confirmation.`,
    exceptUserId: req.user.id,
  });
  return agreementTransition(req, res, {
    id: req.client.id,
    from: ['SENT', 'VIEWED'],
    action: 'Client confirmation requested',
    to: 'CLIENT_CONFIRMATION_PENDING',
    data: { agreementStatus: 'CLIENT_CONFIRMATION_PENDING', agreementConfirmationRequestedAt: new Date() },
  });
});

// Signed from inside the app by the client's own login (the public link route
// in routes/public.js is the no-login equivalent).
router.post('/:id/agreement/confirm', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'approve'), async (req, res) => {
  const client = req.client;
  const current = statusOf(client);
  if (!OUT_FOR_SIGNATURE.includes(current)) {
    return res.status(400).json({ error: 'No pending agreement to sign' });
  }

  const { signedByName, signedByTitle, signedCopyName } = req.body;
  if (isClient(req.user)) {
    return res.status(409).json({
      error: 'Sign on the secure agreement page — it confirms your signature with a code sent to your registered mobile.',
      signingPath: agreementSigning.linkState(client).ok ? agreementSigning.pathFor(client) : null,
    });
  }
  if (!String(signedCopyName || client.agreementSignedCopyName || '').trim()) {
    return res.status(400).json({ error: 'Recording a signature here needs the signed copy received from the client (its file name). Otherwise send the agreement for e-signing.' });
  }
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementStatus: 'SIGNED',
      agreementSignedAt: new Date(),
      agreementSignedBy: signedByName || req.user.name,
      agreementSignedByTitle: signedByTitle || null,
      agreementSignedCopyName: signedCopyName || client.agreementSignedCopyName || null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Agreement signed by client', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SIGNED',
  });

  // Let the account team know the agreement came back signed.
  const owners = await prisma.requirement.findMany({
    where: { clientId: client.id },
    select: { recruiterId: true, bdeId: true, tlId: true },
  });
  // (the agreement is the BDE team's business: the job's recruiter / TL are not told - user, 2026-10-12)
  await notifyUsers(await require('../utils/clientBdes').withClientBdes(owners.flatMap((r) => [r.bdeId]), { clientId: client.id, client }), { // eslint-disable-line global-require
    title: `${client.name} signed the service agreement`,
    message: `${updated.agreementId || 'Agreement'} signed by ${updated.agreementSignedBy}.`,
    exceptUserId: req.user.id,
  });

  // Executed already (both seals + verified signature)? Then it goes ACTIVE now.
  const activated = await agreementLifecycle.maybeAutoActivate(client.id, { actorUserId: req.user.id, via: 'signed in-app' });
  res.json({ ...(await shapeFor(req, activated || updated)), autoActivated: !!activated });
});

// The client declines. Terminal until the document is regenerated.
router.post('/:id/agreement/reject', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'approve'), async (req, res) => (
  agreementTransition(req, res, {
    id: req.client.id,
    from: OUT_FOR_SIGNATURE,
    action: 'Agreement rejected by client',
    to: 'REJECTED',
    data: {
      agreementStatus: 'REJECTED',
      agreementRejectedAt: new Date(),
      agreementRejectedReason: req.body.reason || null,
    },
  })
));

// Attach the countersigned copy the client returned out of band.
router.post('/:id/agreement/signed-copy', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const { fileName, note } = req.body;
  if (!String(fileName || '').trim()) return res.status(400).json({ error: 'Name the signed copy you are attaching.' });
  return agreementTransition(req, res, {
    id: req.client.id,
    from: [...OUT_FOR_SIGNATURE, 'SIGNED', 'ACTIVE'],
    action: 'Signed copy attached',
    data: { agreementSignedCopyName: fileName, agreementSignedCopyNote: note || null },
  });
});

// Resend an agreement already out for signature — the prototype's
// resendAgreement() (line 7981). The status does not move.
router.post('/:id/agreement/resend', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const current = statusOf(req.client);
  if (!OUT_FOR_SIGNATURE.includes(current)) {
    return res.status(400).json({ error: 'No agreement is currently out for signature' });
  }
  const staleClientFiles = [req.client.agreementClientSignFile, req.client.agreementClientStampFile].filter(Boolean);
  const updated = await prisma.client.update({
    where: { id: req.client.id },
    data: { ...agreementSigning.newLinkData(req.client.id, { days: (await agreementSettingsStore.agreementSettings()).linkDays }).data, ...clearClientSide() },
  });
  dropExecutionFiles(staleClientFiles);
  await logAudit({
    userId: req.user.id, action: 'Agreement resent to client (new link — the previous link no longer works)', entity: 'Client',
    entityId: req.client.id, fromValue: current, toValue: current,
  });
  const delivery = await sendLinkEverywhere(req, updated);
  res.json({
    ...(await shapeFor(req, updated)),
    signingPath: agreementSigning.pathFor(updated),
    delivery,
    linkExpiresAt: agreementSigning.linkExpiresAt(updated),
    email: legacyEmailShape(delivery),
  });
});

// OPEN / CLOSE AN AGREEMENT (user, 2026-10-16): Super Admin / Admin and the whole BDE team (desk BDE, BDE TL) - for the clients
// of their own area only. TL / STL / Recruiter / HR never reach an agreement (agreementPrivacy.blindTo). Every press is audited.
async function requireOpenClose(req, res, next) {
  try {
    if (require('../utils/agreementPrivacy').blindTo(req.user)) return res.status(403).json({ error: 'This is not available for your role.' }); // eslint-disable-line global-require
    const lc = require('../utils/clientLifecycle'); // eslint-disable-line global-require
    const team = lc.isBdeTeam(req.user);
    if (team) {
      if (!lc.ownsClient(req.user, req.client)) return res.status(403).json({ error: 'This client is not in your area.' });
      return next();
    }
    if (await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'create')) return next();
    return res.status(403).json({ error: 'You do not have access to this action.' });
  } catch (err) { return next(err); }
}

// The final step: TeamLink activates the signed agreement, which is what
// unblocks requirements for this client. Signing alone is not enough.
router.post('/:id/agreement/activate', requireOpenClose, async (req, res) => {
  const client = req.client;
  if (agreementIsActive(client.agreementStatus)) return res.status(400).json({ error: 'This agreement is already Active' });
  if (statusOf(client) !== 'SIGNED') {
    return res.status(400).json({ error: 'Only a Signed agreement can be activated' });
  }
  // 2026-10-05 (user): an agreement signed on the link becomes Active only with
  // BOTH sides' signature AND company stamp. (A paper copy marked as signed —
  // no code — keeps the manual Activate.)
  if (client.agreementVerifiedAt) {
    const m = agreementLifecycle.missingSeals(client);
    if (m.teamlink.length || m.client.length) {
      const say = (who, list) => (list.length ? `${who}: ${list.filter((x) => x !== 'code').join(' & ') || 'code'}` : null);
      return res.status(409).json({ error: `Not yet: waiting for ${[say('TeamLink', m.teamlink), say('the client', m.client)].filter(Boolean).join(' · ')}.`, missing: m });
    }
  }
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: { agreementStatus: 'ACTIVE', agreementActivatedAt: new Date() },
  });
  await logAudit({
    userId: req.user.id, action: 'Agreement activated', entity: 'Client',
    entityId: client.id, fromValue: 'SIGNED', toValue: 'ACTIVE',
  });

  // The jobs parked at Agreement Check go live now, with an audit row, and
  // each job's TL (or the Managers / Admins) is told (e2e gap 7). Drafts stay.
  // eslint-disable-next-line global-require
  const opened = await require('../utils/openParkedJobs').openParkedJobs(client.id, { actorUserId: req.user.id, actorName: req.user.name });
  const waiting = await prisma.requirement.count({
    where: { clientId: client.id, status: { in: ['DRAFT', 'AGREEMENT_CHECK'] } },
  });
  res.json({ ...(await shapeFor(req, updated)), requirementsWaiting: waiting, jobsOpened: opened.opened });
});

// Expire an agreement past its end date. Client requirements stop going live.
router.post('/:id/agreement/expire', requireOpenClose, async (req, res) => (
  agreementTransition(req, res, {
    id: req.client.id,
    from: ['ACTIVE', 'SIGNED'],
    action: 'Agreement expired',
    to: 'EXPIRED',
    data: { agreementStatus: 'EXPIRED' },
    reason: String((req.body && req.body.reason) || 'Closed by the user').slice(0, 500),
  })
));

// Open an ended agreement again (only one that was signed before - a never-signed one is made new instead).
router.post('/:id/agreement/reopen', requireOpenClose, async (req, res) => {
  const client = req.client;
  if (statusOf(client) !== 'EXPIRED') return res.status(400).json({ error: 'Only an ended agreement can be opened again.' });
  if (!client.agreementSignedAt && !client.agreementActivatedAt) {
    return res.status(409).json({ error: 'This agreement was never signed, so it cannot be opened again. Make a new agreement instead.' });
  }
  return agreementTransition(req, res, {
    id: client.id,
    from: ['EXPIRED'],
    action: 'Agreement reopened',
    to: 'ACTIVE',
    data: { agreementStatus: 'ACTIVE', agreementActivatedAt: new Date() },
    reason: String((req.body && req.body.reason) || 'Opened again by the user').slice(0, 500),
  });
});

module.exports = router;
