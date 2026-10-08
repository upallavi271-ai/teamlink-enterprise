const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct, can } = require('../middleware/auth');
const {
  // atsScopeOf: a Manager / Asst Manager is held to their departments in ATS
  // (per-role spec 2026-10-03), so `global` here is Super Admin / Admin only.
  clientWhere, requirementWhere, applicationWhere, atsScopeOf: scopeOf, OUT_OF_SCOPE, clientViewRole, teamRequirementWhere,
} = require('../utils/scope');
const { logAudit, logFieldChanges } = require('../utils/audit');
const { redactClientFor, clientLevelFor } = require('../utils/clientRedact');
const { notifyUsers } = require('../utils/notify');
const {
  buildAgreementDocument, nextAgreementId, newEsignToken, consultantParty, keyTermsOf,
} = require('../utils/agreement');
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
// Client Pause / Archive / Delete (spec 2026-10-03 §A) — utils/clientLifecycle.js.
const clientLifecycle = require('../utils/clientLifecycle');
// ATS layout v3 — the job status chain shown to people (display only).
const reqDisplay = require('../utils/requirementDisplayStatus');
// Spec section 6 — the agreement template defaults (Admin settings).
const agreementSettingsStore = require('../utils/agreementSettings');
// Add client in 9 sections (2026-10-05): new fields, rules, documents.
const clientProfile = require('../utils/clientProfile');

const router = express.Router();
router.use(requireAuth);
// The whole router belongs to ATS: a login without ATS access, or without
// view permission on this module, is refused at the door rather than handed
// an empty list.
router.use(requireProduct('ats'));
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
  return user ? redactClientFor(user, out) : out;
}
// shapeClient() with this caller's permissions and field level.
async function shapeFor(req, client, opts = {}) {
  return shapeClient(client, await clientPermissions(req.user), { ...opts, user: req.user });
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
  const appScope = applicationWhere(user);
  const global = !!scopeOf(user).global;

  // §6 — invoice numbers by role: amounts (Admin / Management / Accounts),
  // status only (BDE), none (TL). The client scope above is the guard: only
  // invoices of clients this caller may already open are read, and Accounts
  // keeps its own ledger scope (invoiceWhere) on top.
  const role = roleOf(user);
  const invoiceMode = invoiceModeOf(role);
  const canSeeInvoices = invoiceMode !== 'none';

  const [reqRows, liveApps, submittedRows, interviewRows, selectedRows, invoices, activityRows, allAppRows] = await Promise.all([
    prisma.requirement.findMany({
      // AND, not a spread: requirementWhere() may itself carry clientId.
      where: { AND: [teamRequirementWhere(user), clientIn ? { clientId: clientIn } : {}] },
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
  res.json(clients.map((c) => ({
    ...shapeClient(c, permissions, { list: true, user: req.user }),
    ...(work.get(c.id) || {}),
    // The row's ⋯ menu: Pause / Reactivate / Request pause / Archive / Delete.
    lifecycleActions: clientLifecycle.rightsFor(req.user, c, lifecycleBase),
  })));
});

// ---------------------------------------------------------------------------
// GET /clients/meta — what the Clients screens draw for THIS login (clients
// role spec §1–§4, §7, §8): the role, the default view, the list columns and
// filters it may use, the top / row buttons, and the agreement-expiry alert.
// Every flag is a can() result or the same role rule the data routes apply,
// so a button is drawn exactly when the API would honour it.
// ---------------------------------------------------------------------------
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
    can(user, 'ats', 'requirements', 'Create Requirement', 'create'),
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
      merge: role === 'admin',
      edit,
      // Permanent delete — Super Admin only, empty clients only (spec §A).
      delete: lifecycleBase.delete,
      legacyDelete: del,
      // Owner BDE reassignment is global-only (PUT refuses anyone else).
      reassign: edit && global,
      // Deactivate is replaced by Pause / Reactivate (with a reason).
      deactivate: false,
      pause: lifecycleBase.pauseEdit,
      requestPause: lifecycleBase.pauseRequest,
      archive: lifecycleBase.archive,
      // The Pause requests panel (approvers decide, a BDE sees their own).
      pauseRequests: lifecycleBase.pauseEdit || lifecycleBase.pauseRequest,
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
    ownerLocked: role === 'bde' ? (user.name || null) : null,
  });
});

// GET /clients/owner-options — the BDE names Owner BDE may be set to (Add
// Client / Reassign Owner). Names only; any login that may add or edit.
router.get('/owner-options', async (req, res) => {
  if (!(await mayCheckDuplicates(req.user))) return res.status(403).json({ error: 'Only a login that can add or edit clients can pick an owner.' });
  const users = await prisma.user.findMany({
    where: {
      status: { not: 'Inactive' },
      OR: [{ atsRole: 'BDE' }, { role: 'BDE' }],
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
  const out = users.filter((u) => u.name).map((u) => {
    const depts = [u.atsDepartment, ...String(u.atsScopeDepartments || '').split(',')].map((d) => String(d || '').trim()).filter(Boolean);
    return { id: u.id, name: u.name, department: depts[0] || null, inDepartment: !!dept && depts.some((d) => d.toLowerCase() === dept), clients: countOf.get(u.name) || 0 };
  });
  out.sort((a, b) => (Number(b.inDepartment) - Number(a.inDepartment)) || a.name.localeCompare(b.name));
  res.json(out);
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
  return res.json(result);
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
    }, consultant),
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
  if (req.body && req.body.clientId) {
    const stored = await prisma.client.findFirst({ where: { AND: [{ id: String(req.body.clientId) }, clientWhere(req.user)] } });
    if (!stored) return res.status(404).json({ error: 'Client not found' });
    const overlay = { ...pickClient(req.body), ...clientProfile.pickProfile(req.body).data };
    if (!(await can(req.user, 'ats', 'clients', 'Commercial Terms', 'edit'))) {
      [...AGREEMENT_AUDIT_FIELDS, ...clientProfile.NEW_COMMERCIAL_FIELDS].forEach((k) => { delete overlay[k]; });
    }
    if (overlay.billingSameAsAddress) overlay.billingAddress = null;
    data = { ...stored, ...overlay };
  } else {
    data = previewRow(await draftClientData(req));
  }
  const consultant = await consultantParty();
  const document = buildAgreementDocument(data, consultant);
  return res.json({ document, keyTerms: keyTermsOf(data, consultant), hash: docHash(document) });
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
  // §5 / §6 — cut to the caller's field level (TL: overview + contact names;
  // Accounts: billing contact, no other contact details).
  const out = shapeClient(req.client, permissions, { user: req.user });
  out.tabs = tabsFor(roleOf(req.user));
  out.lifecycleActions = await clientLifecycle.lifecycleRights(req.user, req.client);
  // B9.2: the client's SLA (own numbers or the Step-timing defaults).
  out.sla = await CS.slaOf(req.client.id);
  // TeamLink's signer (Agreement settings) for the agreement's signature block.
  if (out.agreementDocument) { const us = await consultantParty(); out.teamlinkSigner = { name: us.signatoryName, title: us.signatoryTitle }; }
  // The signing link survives a reload for whoever may send / resend it.
  if (permissions.lifecycle && req.client.esignToken
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
  const tabs = tabsFor(role);
  const show = (t) => tabs.includes(t);
  const invoiceMode = forClient ? 'client' : invoiceModeOf(role);
  const level = clientLevelFor(req.user);
  const commercial = level === 'full' || level === 'billing';
  const id = req.client.id;

  // Requirements are scoped by the SAME helpers the requirements router
  // uses; a TL sees their TEAM's requirements for this client (§5 "👁 team"),
  // Accounts the ones it bills.
  const reqScope = role === 'tl' ? teamRequirementWhere(req.user) : requirementWhere(req.user);
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
            forClient ? { stage: { in: CLIENT_VISIBLE_STAGES } } : applicationWhere(req.user),
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
        where: { application: { AND: [{ requirementId: { in: reqIds } }, applicationWhere(req.user)] } },
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
        where: { toStage: 'REJECTED', application: { AND: [{ requirementId: { in: reqIds } }, { stage: 'REJECTED' }, applicationWhere(req.user)] } },
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
      ...activity.map((a) => ({
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
      })),
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
  if (show('candidates')) out.candidates = shaped;
  if (show('interviews')) out.interviews = shaped.filter((a) => a.interviewAt || a.interviewStatus || a.interviewCode);
  if (show('selected')) {
    out.selections = shaped.filter((a) => SELECTED_STAGES.includes(a.stage));
    out.joinings = shaped.filter((a) => JOINED_STAGES.includes(a.stage));
  }
  if (replacements) out.replacements = replacements;
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
    return res.status(403).json({ error: 'Notes on a client are added by Admin, a Manager, the BDE or Accounts.' });
  }
  const text = String((req.body && req.body.note) || '').trim();
  if (!text) return res.status(400).json({ error: 'Write the note first.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Keep the note under 2,000 characters.' });
  await logAudit({
    userId: req.user.id, actorName: req.user.name || null, action: 'Client note', entity: 'Client', entityId: req.client.id, reason: text,
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
  return data;
}

// Human-readable client code (CLI0001 …), assigned at creation if the form
// did not supply one. It is what the Client Detail header shows.
async function nextClientCode() {
  const used = await prisma.client.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `CLI${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.client.findFirst({ where: { clientCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `CLI${Date.now()}`;
}

// THE NEW CLIENT'S DATA — exactly what POST /clients will store, built in ONE
// place so the Add-client live preview (POST /clients/agreement-preview) and
// the saved draft come from the same values and the same template.
async function draftClientData(req) {
  const data = pickClient(req.body || {});
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
  if (!scopeOf(req.user).global) {
    if (roleOf(req.user) === 'bde') data.bdeOwner = req.user.name || null;
    else delete data.bdeOwner;
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
  const dup = await findClientDuplicates(req.body);
  const override = req.body.allowDuplicate === true;
  if (dup.blocking && !override) {
    return res.status(409).json({
      error: 'Possible duplicate client found. Open the existing client, or confirm "Create Anyway".',
      code: 'DUPLICATE_CLIENT',
      duplicates: dup.matches,
      blocking: true,
    });
  }
  if (!data.clientCode) data.clientCode = await nextClientCode();

  const client = await prisma.client.create({ data: { ...data, agreementStatus: 'DRAFT' } });
  if (override && dup.total > 0) {
    const note = String(req.body.duplicateNote || '').trim().slice(0, 500);
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
  const withDoc = req.body.createAgreement !== false && mode !== 'draft'
    ? await prisma.client.update({
      where: { id: client.id },
      data: {
        agreementDocument: buildAgreementDocument(client, await consultantParty()),
        agreementSource: 'Generated',
        agreementId: client.agreementId || (await nextAgreementId()),
      },
    })
    : client;
  await logAudit({ userId: req.user.id, action: 'Client created', entity: 'Client', entityId: client.id, toValue: 'Draft' });
  // Same text as the live preview the user was looking at? (previewHash is
  // the sha256 the preview returned; absent = no preview was shown.)
  const matchesPreview = withDoc.agreementDocument && req.body.previewHash
    ? docHash(withDoc.agreementDocument) === String(req.body.previewHash) : null;
  if (withDoc.agreementDocument) {
    await logAudit({
      userId: req.user.id, action: 'Agreement draft created from template', entity: 'Client', entityId: client.id,
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
  const data = pickClient(req.body);
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
  // STATUS moves only through Pause / Reactivate / Archive (reason + audit).
  if (changed.includes('status')) {
    return res.status(400).json({ error: 'Client status changes through Pause / Reactivate / Archive (each needs a reason) — not the edit form.', field: 'status' });
  }
  // §7 / contract — re-assigning the OWNER BDE is Admin only. A BDE editing
  // their own client may change everything else, never who owns it.
  if (changed.includes('bdeOwner') && !scopeOf(req.user).global) {
    return res.status(403).json({ error: 'Only an Admin can reassign the Owner BDE of a client.' });
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
    data.clientCode = code || null;
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
  if (identity.length) {
    const probe = {};
    identity.forEach((k) => { probe[k] = data[k]; });
    dup = await findClientDuplicates(probe, { excludeId: before.id });
  }
  const override = req.body.allowDuplicate === true;
  if (dup.blocking && !override) {
    return res.status(409).json({
      error: 'This change makes the client look like an existing one. Open the existing client, or confirm "Save Anyway".',
      code: 'DUPLICATE_CLIENT',
      duplicates: dup.matches,
      blocking: true,
    });
  }

  const client = await prisma.client.update({ where: { id: req.params.id }, data });
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
      reason: String(req.body.duplicateNote || '').trim().slice(0, 500) || 'Save Anyway confirmed without a note',
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

async function agreementTransition(req, res, { id, from, data, action, to }) {
  const client = await prisma.client.findUnique({ where: { id } });
  const current = statusOf(client);
  if (from && !from.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be ${action}.` });
  }
  const updated = await prisma.client.update({ where: { id }, data });
  await logAudit({
    userId: req.user.id, action, entity: 'Client', entityId: id, fromValue: current, toValue: to || current,
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
  const out = await agreementTransition(req, res, {
    id: client.id,
    from: OPEN_FOR_AUTHORING,
    action: 'Agreement document generated',
    to: 'DRAFT',
    data: {
      ...agreementSigning.RESET_EXECUTION,
      agreementDocument: buildAgreementDocument(client, consultant),
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

router.post('/:id/agreement/send', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
  const client = req.client;
  if (!client.agreementDocument) return res.status(400).json({ error: 'Generate or upload the agreement document first' });
  if (agreementIsSigned(client.agreementStatus)) {
    return res.status(400).json({ error: 'This agreement is already signed' });
  }
  const current = statusOf(client);
  if (!OPEN_FOR_AUTHORING.includes(current)) {
    return res.status(400).json({ error: `An agreement in "${current}" cannot be sent.` });
  }

  // A NEW LINK EVERY SEND: any earlier link stops working, and whatever was
  // half-done on it (a signature without its code) is cleared.
  const staleClientFiles = [client.agreementClientSignFile, client.agreementClientStampFile].filter(Boolean);
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
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
  await logAudit({
    userId: req.user.id, action: 'Agreement sent to client', entity: 'Client',
    entityId: client.id, fromValue: current, toValue: 'SENT',
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
  await notifyUsers(owners.flatMap((r) => [r.recruiterId, r.bdeId, r.tlId]), {
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

// The final step: TeamLink activates the signed agreement, which is what
// unblocks requirements for this client. Signing alone is not enough.
router.post('/:id/agreement/activate', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
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
router.post('/:id/agreement/expire', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => (
  agreementTransition(req, res, {
    id: req.client.id,
    from: ['ACTIVE', 'SIGNED'],
    action: 'Agreement expired',
    to: 'EXPIRED',
    data: { agreementStatus: 'EXPIRED' },
  })
));

module.exports = router;
