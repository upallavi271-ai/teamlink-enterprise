// ---------------------------------------------------------------------------
// ATS — EXPORT AND IMPORT ON EVERY MODULE (hrms-25).
//
// "ATS lo prathi module lo, export & import buttons vundali."
//
//   GET  /api/ats-io/access                      what this login may export / import
//   GET  /api/ats-io/export/:module?format=…     the screen's rows as a file
//   POST /api/ats-io/export/:module?format=…     same, with the screen's state
//                                                 { params, view, tab, former, ids }
//   GET  /api/ats-io/import/:kind/template       the sample workbook for one kind
//   POST /api/ats-io/import/:kind/check          upload -> map -> preview (WRITES NOTHING)
//   POST /api/ats-io/import/:kind/commit         upload -> the same run, for real
//
// EXPORT IS THE SCREEN'S OWN QUERY. Each module is exported by calling the
// very list endpoint its screen calls (GET /requirements, /candidates,
// /ats/offers …) as the signed-in user — same scope, same client-field
// redaction, same computed columns — and nothing else. The screen's filters
// come along as `params` (the ones its list endpoint applies itself) and, for
// the filters a screen applies in the browser, as `ids`: the rows it is
// showing. `ids` can only NARROW the server's answer — an id the scoped
// endpoint did not return is simply not in the file. The `export` permission
// is checked here, and utils/exportKit.js writes the file and the audit row.
//
// IMPORT IS THE DATA IMPORTER, ONE SHEET AT A TIME. The file (any .xlsx /
// .xls / .csv) is read, its columns are matched to the kind's spec
// (utils/importSpec.js ATS_IMPORT_SHEETS) by header and by alias — the user
// can re-map any of them — and then the rows go through routes/dataImport.js's
// OWN row reader and per-sheet handlers, dry first. What this file adds on
// top is what a screen import needs and a Super Admin master import does not:
//   * the module's create / edit / assign PERMISSION (Manager and Assistant
//     Manager are view-only, so can() refuses them: 403);
//   * DATA SCOPE on every row — a TL cannot import into another team's
//     requirements, a recruiter only onto their own;
//   * NEVER A DUPLICATE: a row whose record is already on file is SKIPPED
//     (create kinds) and a repeated row in the same file is skipped too;
//   * one audit row per commit with the counts.
// Nothing is sent: no email, SMS or WhatsApp; follow-ups raise the in-app
// notice the Follow-up dialog raises, nothing more.
// ---------------------------------------------------------------------------

const express = require('express');
const http = require('http');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { canMoveToStage } = require('../utils/permissions');
const {
  atsScopeOf: scopeOf, scopeLabel, requirementWhere, clientWhere, applicationInScope, isAssignedTo, matches, candidateWhere,
} = require('../utils/scope');
const { formatOf, sendTable } = require('../utils/exportKit');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const { ATS_IMPORT_SHEETS, LISTS } = require('../utils/importSpec');
const { buildSheetTemplate } = require('../utils/importTemplate');
const { internals } = require('./dataImport');
const {
  requirementIsLive, requirementStatusLabel, agreementIsActive, agreementStatusLabel, stageLabel,
} = require('../utils/atsVocab');
const { hiringTypeOf, INTERNAL_HIRE } = require('../utils/joining');
// Spec 2026-10-03 §B — role rules, batches + undo, big exports, filter counts,
// bulk resume upload.
const { ioAccessFor, mayApproveImport, roleOf } = require('../utils/ioAccess');
const batches = require('../utils/importBatch');
const exportJobs = require('../utils/exportJobs');
const { facetsFor } = require('../utils/atsFacets');
const ioStore = require('../utils/atsIoStore');
// The app's resume parser (utils/resumeParse.js — the resume_ work):
// text out of PDF / DOCX / DOC, then the fields the resume states.
const resumeParser = require('../utils/resumeParse');

function resumeKind(buf, name = '') {
  if (buf.length > 4 && buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'docx';
  if (buf.length > 8 && buf.toString('hex', 0, 8) === 'd0cf11e0a1b11ae1') return 'doc';
  return /\.txt$/i.test(name) ? 'txt' : null;
}
// -> { fields: { name, email, phone, location, experienceYears, skills }, kind } | { error }
async function parseResume(buf, name) {
  const kind = resumeKind(buf, name);
  if (!kind) return { error: 'Not a PDF, DOCX or DOC file.' };
  let out;
  if (kind === 'txt') out = { text: buf.toString('utf8'), parsed: await resumeParser.parseResumeText(buf.toString('utf8')) };
  else out = await resumeParser.extractAndParse(buf, kind);
  if (!out || !out.parsed) return { error: (out && out.error) || 'No readable text was found in this file.', kind };
  const p = out.parsed;
  const fields = {};
  if (p.name) fields.name = p.name;
  if (Array.isArray(p.emails) && p.emails[0]) fields.email = p.emails[0];
  if (Array.isArray(p.phones) && p.phones[0]) fields.phone = String(p.phones[0]).replace(/[^\d+]/g, '');
  if (p.location) fields.location = p.location;
  if (typeof p.totalExperienceYears === 'number') fields.experienceYears = p.totalExperienceYears;
  if (Array.isArray(p.skills) && p.skills.length) fields.skills = p.skills.slice(0, 25).join(', ');
  return { fields, kind };
}
const { pushNotification } = require('../utils/notify');

const {
  readSheet, buildIndex, HANDLERS, isDry, findCandidate,
} = internals;

const router = express.Router();
router.use(requireAuth);
// Outside logins (Client / Candidate) never use this internal surface —
// review #3 access audit; their screens are /api/portal/*.
router.use(require('../utils/permissions').requireInternal);

class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const guarded = (fn) => (req, res, next) => fn(req, res).catch((err) => {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  return next(err);
});
const DENIED = (what) => new HttpError(403, { error: `${what} isn't included in your role's permissions.` });

// ---------------------------------------------------------------------------
// THE SCREEN'S OWN ENDPOINT, called as the signed-in user.
// Over the loopback interface, with the caller's own bearer token, so the
// answer is byte-for-byte what the screen received: requireAuth, the route's
// permission guard, utils/scope.js and the client-field redaction all run as
// they do for the screen. No timeout: the biggest lists take a while.
// ---------------------------------------------------------------------------
function loopback(req, method, path, { query = {}, body = null } = {}) {
  const qs = new URLSearchParams(Object.entries(query || {})
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)])).toString();
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: req.socket.localPort,
      method,
      path: `/api${path}${qs ? `?${qs}` : ''}`,
      headers: {
        authorization: req.headers.authorization || '',
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        if (res.statusCode >= 400) {
          reject(new HttpError(res.statusCode, { error: (json && json.error) || `The screen's list answered ${res.statusCode}.` }));
          return;
        }
        resolve(json);
      });
    });
    r.on('error', reject);
    r.setTimeout(0);
    if (payload) r.write(payload);
    r.end();
  });
}
const screen = (req, path, query) => loopback(req, 'GET', path, { query });

// ---------------------------------------------------------------------------
// EXPORTS — one per screen. `perm` is [module, feature] of the `export`
// action; `load` returns the rows exactly as the screen holds them; `columns`
// is [header, value(row), { pdf: false }?]. A column marked pdf:false is left
// off the PDF (a 25-column PDF is unreadable) but is in Excel and CSV.
// ---------------------------------------------------------------------------
const ymd = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};
// A moment in India time — an interview slot is read as the wall clock.
const when = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const nm = (o) => (o && typeof o === 'object' ? o.name || '' : o || '');
const list = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v || '');
const fb = (f) => (f && typeof f === 'object'
  ? [f.recommendation, f.overall || f.comments].filter(Boolean).join(' — ')
  : f || '');
const clientOfReq = (r) => (r && r.internal ? 'TeamLink Internal' : nm(r && r.client));
const NO_PDF = { pdf: false };
// PAN / Aadhaar / bank: HR, Admin, Super Admin only. Revenue / fee: Admin only.
const SENSITIVE = { pdf: false, sensitive: true };
const REVENUE = { pdf: false, revenue: true };

const reqTitle = (r) => (r.requirement && (r.requirement.title || r.requirement.name)) || '';
// The shared columns of the four Interviews & Joining workspaces.
const WS_HEAD = [
  ['Candidate', (r) => nm(r.candidate)],
  ['Candidate Email', (r) => (r.candidate && r.candidate.email) || '', NO_PDF],
  ['Requirement', reqTitle],
  ['Client', (r) => clientOfReq(r.requirement)],
  ['Department', (r) => (r.requirement && r.requirement.department) || ''],
  ['Worked By', (r) => nm(r.requirement && r.requirement.recruiter), NO_PDF],
  ['TL', (r) => (r.requirement && r.requirement.tl) || '', NO_PDF],
  ['BDE', (r) => nm(r.requirement && r.requirement.bde), NO_PDF],
  ['Hiring Type', (r) => r.hiringType || ''],
  ['Stage', (r) => r.stageLabel || stageLabel(r.stage) || ''],
];

const workspace = (path) => async (req) => ((await screen(req, path)) || {}).rows || [];

const EXPORTS = {
  requirements: {
    perm: ['requirements', 'Requirement List'],
    entity: 'Requirement',
    what: (b) => `Requirements${b.view && b.view !== 'all' ? ` (${b.view})` : ''}`,
    async load(req, b) {
      const rows = await screen(req, '/requirements', b.params);
      if (b.view === 'open') return rows.filter((r) => requirementIsLive(r.status));
      if (b.view === 'closed') return rows.filter((r) => !requirementIsLive(r.status));
      return rows;
    },
    columns: [
      ['Req Code', (r) => r.reqCode || ''],
      ['Job Title', (r) => r.title],
      ['Client', (r) => clientOfReq(r)],
      ['Department', (r) => r.department || ''],
      ['Specialisation', (r) => r.specialisation || '', NO_PDF],
      ['Worked By', (r) => r.workedBy || ''],
      ['Position', (r) => r.workedByPosition || ''],
      ['TL', (r) => r.tlName || ''],
      ['Co-recruiters', (r) => list(r.coRecruiterNames), NO_PDF],
      ['STL', (r) => r.stlName || '', NO_PDF],
      ['BDE', (r) => nm(r.bde), NO_PDF],
      ['Status', (r) => requirementStatusLabel(r.status) || r.status || ''],
      ['Priority', (r) => r.priority || '', NO_PDF],
      ['Openings', (r) => r.openings ?? ''],
      ['Filled', (r) => r.filled ?? '', NO_PDF],
      ['Remaining', (r) => r.remaining ?? '', NO_PDF],
      ['Applications', (r) => (r._count ? r._count.applications : ''), NO_PDF],
      ['Location', (r) => r.location || '', NO_PDF],
      ['Experience', (r) => r.experience || '', NO_PDF],
      ['Created', (r) => ymd(r.createdAt)],
      ['Closing Date', (r) => ymd(r.closingDate), NO_PDF],
      ['Target Date', (r) => ymd(r.targetDate), NO_PDF],
      ['Next Action', (r) => r.nextAction || '', NO_PDF],
    ],
  },

  clients: {
    perm: ['clients', 'Client List'],
    entity: 'Client',
    what: () => 'Clients',
    async load(req, b, access) {
      const [clients, reqs] = await Promise.all([screen(req, '/clients', b.params), screen(req, '/requirements').catch(() => [])]);
      const open = new Map();
      reqs.forEach((r) => { if (requirementIsLive(r.status)) open.set(r.clientId, (open.get(r.clientId) || 0) + 1); });
      // Sensitive / revenue columns are read from the table itself, and only
      // for a login allowed to see them (the screen's list may redact them).
      let extra = new Map();
      if (access && (access.sensitive || access.revenue) && clients.length) {
        const ids = clients.map((c) => c.id);
        const [rows, paid] = await Promise.all([
          access.sensitive ? prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, pan: true, tan: true } }) : [],
          access.revenue ? prisma.invoice.groupBy({ by: ['clientId'], where: { clientId: { in: ids }, status: { not: 'Cancelled' } }, _sum: { amount: true } }) : [],
        ]);
        extra = new Map(ids.map((id) => [id, {}]));
        rows.forEach((r) => Object.assign(extra.get(r.id), { pan: r.pan, tan: r.tan }));
        paid.forEach((p) => Object.assign(extra.get(p.clientId) || {}, { revenue: p._sum.amount || 0 }));
      }
      return clients.map((c) => ({ ...c, ...(extra.get(c.id) || {}), openRequirements: open.get(c.id) || 0 }));
    },
    columns: [
      ['Client Name', (c) => c.name],
      ['Client Code', (c) => c.clientCode || ''],
      ['Legal Name', (c) => c.legalName || '', NO_PDF],
      ['Industry', (c) => c.industry || ''],
      ['Client Type', (c) => c.clientType || '', NO_PDF],
      ['Status', (c) => c.status || ''],
      ['Priority', (c) => c.priority || '', NO_PDF],
      ['Owning Department', (c) => c.ownerDepartment || ''],
      ['City', (c) => c.location || '', NO_PDF],
      ['State', (c) => c.state || '', NO_PDF],
      ['Primary Contact', (c) => c.contactName || ''],
      ['Contact Phone', (c) => c.contactPhone || ''],
      ['Contact Email', (c) => c.contactEmail || '', NO_PDF],
      ['Secondary Contact', (c) => c.secondaryContactName || '', NO_PDF],
      ['Secondary Phone', (c) => c.secondaryContactPhone || '', NO_PDF],
      ['GST Number', (c) => c.gst || '', NO_PDF],
      ['PAN', (c) => c.pan || '', SENSITIVE],
      ['TAN', (c) => c.tan || '', SENSITIVE],
      ['Agreement Status', (c) => agreementStatusLabel(c.agreementStatus) || c.agreementStatus || ''],
      ['Agreement Expiry', (c) => c.agreementEnd || '', NO_PDF],
      ['Fee %', (c) => c.agreementFeePercent ?? '', REVENUE],
      ['Revenue invoiced (₹)', (c) => c.revenue ?? '', REVENUE],
      ['BDE Owner', (c) => c.bdeOwner || '', NO_PDF],
      ['Account Manager', (c) => c.accountManager || '', NO_PDF],
      ['Open Requirements', (c) => c.openRequirements],
      ['Added', (c) => ymd(c.createdAt), NO_PDF],
    ],
  },

  agreements: {
    perm: ['clients', 'Client List'],
    entity: 'Client',
    what: () => 'Agreement register',
    async load(req) {
      const [clients, reqs] = await Promise.all([screen(req, '/clients'), screen(req, '/requirements').catch(() => [])]);
      const live = new Map(); const held = new Map();
      reqs.forEach((r) => {
        if (requirementIsLive(r.status)) live.set(r.clientId, (live.get(r.clientId) || 0) + 1);
        else if (!r.internal) held.set(r.clientId, (held.get(r.clientId) || 0) + 1);
      });
      return clients.map((c) => ({
        ...c,
        live: live.get(c.id) || 0,
        held: agreementIsActive(c.agreementStatus) ? 0 : held.get(c.id) || 0,
      }));
    },
    columns: [
      ['Client', (c) => c.name],
      ['Client Code', (c) => c.clientCode || ''],
      ['Agreement ID', (c) => c.agreementId || ''],
      ['Status', (c) => agreementStatusLabel(c.agreementStatus) || c.agreementStatus || ''],
      ['Source', (c) => c.agreementSource || ''],
      ['Fee %', (c) => c.agreementFeePercent ?? '', REVENUE],
      ['Agreement Date', (c) => c.agreementStart || ymd(c.agreementActivatedAt)],
      ['Expiry', (c) => c.agreementEnd || ''],
      ['Signed By', (c) => c.agreementSignedBy || '', NO_PDF],
      ['Invoice Trigger', (c) => c.invoiceTrigger || '', NO_PDF],
      ['Payment Terms', (c) => c.paymentTerms || '', NO_PDF],
      ['Live Reqs', (c) => c.live],
      ['Held at Gate', (c) => c.held],
    ],
  },

  candidates: {
    perm: ['candidates', 'Candidate List'],
    entity: 'Candidate',
    what: (b) => `Candidates${b.view && b.view !== 'all' ? ` (${b.view})` : ''}`,
    // b5_: a person whose consent is WITHDRAWN (do not contact) is exported
    // without phone / email, and every row says what consent is on file.
    async load(req, b) {
      const rows = (await screen(req, '/candidates', b.params)) || [];
      // eslint-disable-next-line global-require
      const CR = require('../utils/candidateRecord');
      if (!CR.supported() || !Array.isArray(rows) || !rows.length) return rows;
      const flagged = await prisma.candidate.findMany({
        where: { OR: [{ doNotContact: true }, { consentStatus: { not: null } }] },
        select: { id: true, doNotContact: true, consentStatus: true },
      });
      const by = new Map(flagged.map((c) => [c.id, c]));
      return rows.map((r) => {
        const c = by.get(r.id);
        if (!c) return { ...r, consentLabel: 'Not recorded' };
        const out = { ...r, consentLabel: CR.CONSENT_LABEL[c.consentStatus] || 'Not recorded' };
        if (CR.isDoNotContact(c)) Object.assign(out, { email: '', phone: '', consentLabel: 'Withdrawn — do not contact' });
        return out;
      });
    },
    columns: [
      ['Candidate', (c) => c.name],
      ['Email', (c) => c.email || ''],
      ['Phone', (c) => c.phone || ''],
      ['Consent', (c) => c.consentLabel || '', NO_PDF],
      ['Location', (c) => c.location || '', NO_PDF],
      ['Source', (c) => c.source || '', NO_PDF],
      ['Skills', (c) => c.skills || '', NO_PDF],
      ['Requirement', (c) => c.requirementTitle || ''],
      ['Client', (c) => c.clientName || ''],
      ['Stage', (c) => c.currentStageLabel || stageLabel(c.currentStage) || ''],
      ['Pipeline Stage', (c) => c.stageGroupLabel || '', NO_PDF],
      ['Worked By', (c) => c.recruiterName || ''],
      ['Position', (c) => c.positionCode || ''],
      ['TL', (c) => c.tlName || ''],
      ['Owner', (c) => nm(c.owner) || '', NO_PDF],
      ['Next Action', (c) => (typeof c.nextAction === 'object' ? nm(c.nextAction) || c.nextAction?.label : c.nextAction) || '', NO_PDF],
      ['Due', (c) => ymd(c.dueDate), NO_PDF],
      ['Follow-up', (c) => (c.followUp ? c.followUp.status : 'Not set'), NO_PDF],
      ['Status', (c) => c.lifeStatus || '', NO_PDF],
      ['Rejection', (c) => (c.rejection ? [c.rejection.side, c.rejection.category, c.rejection.detail].filter(Boolean).join(' · ') : ''), NO_PDF],
      ['Applications', (c) => (c.applications || []).length, NO_PDF],
      ['Added', (c) => ymd(c.createdAt)],
    ],
  },

  team: {
    perm: ['recruiterbde', 'Team View'],
    entity: 'User',
    what: (b) => `Recruiter & BDE — ${b.tab || 'recruiters'}${b.former ? ' (with former)' : ''}`,
    idOf: (r) => r.id || r.label || r.code,
    async load(req, b, access) {
      const tab = b.tab || 'recruiters';
      if (['recruiters', 'bdes', 'workload'].includes(tab)) {
        let rows = await screen(req, '/ats/team', { includeLeft: 1 });
        if (b.former) {
          // Former people from HRMS (utils/formerPeople.js) — the screen's
          // Active / Former filter; a login that has left is listed once.
          const former = (((await screen(req, '/ats/team', { view: 'former' })) || {}).rows || []);
          const leftIds = new Set(former.map((r) => r.userId).filter(Boolean));
          rows = [...rows.filter((r) => !leftIds.has(r.id)), ...former];
        }
        // PAN / bank of the people: HR, Admin, Super Admin only.
        if (access && access.sensitive && rows.length) {
          const emps = await prisma.employee.findMany({
            where: { userId: { in: rows.map((r) => r.id).filter(Boolean) } },
            select: { userId: true, panNumber: true, bankName: true, bankAccountNumber: true, ifscCode: true },
          });
          const byUser = new Map(emps.map((e) => [e.userId, e]));
          rows = rows.map((r) => ({ ...r, sensitive: byUser.get(r.id) || null }));
        }
        return rows;
      }
      if (tab === 'pending') return ((await screen(req, '/dashboard/ats')) || {}).queue || [];
      if (tab === 'mywork') return ((await screen(req, '/dashboard/ats')) || {}).myWork || [];
      if (tab === 'assignments') return screen(req, '/requirements');
      if (tab === 'seats') {
        const data = await screen(req, '/positions/history', b.params);
        return (data.seats || []).flatMap((s) => (s.tenures || []).map((t, i) => ({
          id: `${s.id}:${i}`, seat: s.code, seatName: s.name, department: s.department, ...t,
        })));
      }
      throw new HttpError(400, { error: 'Unknown tab.' });
    },
    columns: (b) => {
      const tab = b.tab || 'recruiters';
      if (tab === 'pending') {
        return [
          ['Candidate', (r) => r.candidate], ['Requirement', (r) => r.requirement], ['Client', (r) => r.client || ''],
          ['Department', (r) => r.department || ''], ['Current Stage', (r) => r.stageLabel || ''],
          ['Next Action', (r) => r.nextAction || ''], ['Due', (r) => r.due || ''], ['Overdue', (r) => (r.overdue ? 'Yes' : '')],
        ];
      }
      if (tab === 'mywork') return [['Item', (r) => r.label], ['Count', (r) => r.value]];
      if (tab === 'assignments') {
        return [
          ['Req Code', (r) => r.reqCode || ''], ['Requirement', (r) => r.title], ['Client', (r) => clientOfReq(r)],
          ['Department', (r) => r.department || ''], ['Recruiter', (r) => nm(r.recruiter) || r.workedBy || ''],
          ['Position', (r) => r.workedByPosition || ''], ['TL', (r) => r.tlName || ''], ['BDE', (r) => nm(r.bde)],
          ['Status', (r) => requirementStatusLabel(r.status) || r.status],
        ];
      }
      if (tab === 'seats') {
        return [
          ['Seat', (r) => r.seat], ['Seat Name', (r) => r.seatName || ''], ['Department', (r) => r.department || ''],
          ['Held By', (r) => r.name], ['Employee Code', (r) => r.employeeCode || ''], ['From', (r) => ymd(r.from)],
          ['To', (r) => (r.current ? 'today' : ymd(r.to))], ['Days', (r) => r.days ?? ''],
          ['Applications', (r) => r.applications ?? ''], ['Joined', (r) => r.joined ?? ''],
        ];
      }
      return [
        ['Name', (r) => r.name], ['Employee Code', (r) => r.employeeCode || ''], ['Role', (r) => r.roleLabel || r.role],
        ['Department', (r) => r.department || list(r.departments)], ['Seat', (r) => r.seat || list((r.seats || []).map((s) => s.code))],
        ['TL', (r) => r.tl || ''], ['Status', (r) => r.status || 'Active'],
        ['Open Requirements', (r) => r.openRequirements ?? ''], ['Active Pipeline', (r) => r.activePipeline ?? ''],
        ['Former?', (r) => (r.former ? 'Yes' : ''), NO_PDF], ['Left On', (r) => ymd(r.leftOn), NO_PDF],
        ['Replaced By', (r) => nm(r.replacedBy), NO_PDF],
        ['Requirements Worked', (r) => r.requirementsWorked ?? '', NO_PDF], ['Candidates Worked', (r) => r.candidatesWorked ?? '', NO_PDF],
        ['Joined', (r) => r.joined ?? '', NO_PDF],
        ['PAN', (r) => (r.sensitive && r.sensitive.panNumber) || '', SENSITIVE],
        ['Bank', (r) => (r.sensitive && r.sensitive.bankName) || '', SENSITIVE],
        ['Bank Account', (r) => (r.sensitive && r.sensitive.bankAccountNumber) || '', SENSITIVE],
        ['IFSC', (r) => (r.sensitive && r.sensitive.ifscCode) || '', SENSITIVE],
      ];
    },
  },

  interviews: {
    perm: ['interviews', 'Calendar View'],
    entity: 'Application',
    what: (b) => (b.tab === 'ai' ? 'AI interviews' : 'Interview calendar'),
    async load(req, b) {
      const data = await screen(req, '/ats/calendar', b.params);
      return (b.tab === 'ai' ? data.ai : data.recruitment) || [];
    },
    columns: (b) => (b.tab === 'ai'
      ? [
        ['AI Code', (r) => r.aiCode || ''], ['Candidate', (r) => nm(r.candidate)], ['Requirement', reqTitle],
        ['Status', (r) => r.status || ''], ['Deadline', (r) => ymd(r.deadline)], ['Score', (r) => r.score ?? ''],
        ['Feedback', (r) => r.feedback || '', NO_PDF],
      ]
      : [
        ['Interview Code', (r) => r.interviewCode || ''], ['Candidate', (r) => nm(r.candidate)], ['Requirement', reqTitle],
        ['Client', (r) => clientOfReq(r.requirement)], ['Department', (r) => (r.requirement && r.requirement.department) || ''],
        ['Worked By', (r) => nm(r.requirement && r.requirement.recruiter), NO_PDF], ['TL', (r) => (r.requirement && r.requirement.tl) || '', NO_PDF],
        ['Round', (r) => r.round ?? ''], ['Type', (r) => r.type || ''], ['Mode', (r) => r.mode || '', NO_PDF],
        ['Interviewer', (r) => r.interviewer || '', NO_PDF], ['Date & Time', (r) => when(r.interviewAt)],
        ['Status', (r) => r.statusLabel || r.status || ''], ['Result', (r) => (r.result === '—' ? '' : r.result || '')],
        ['Score', (r) => r.score ?? '', NO_PDF],
        // Schedule + feedback (spec 2026-10-03 §B). Internal and client
        // feedback stay in their own columns — never mixed with the AI score.
        ['Internal Feedback', (r) => fb(r.internalFeedback), NO_PDF],
        ['Client Feedback', (r) => fb(r.clientFeedback), NO_PDF],
      ]),
  },

  feedback: {
    perm: ['interviews', 'Interview Feedback'],
    entity: 'Application',
    what: () => 'Interview feedback',
    load: workspace('/ats/feedback'),
    columns: [
      ...WS_HEAD,
      ['Interview Date', (r) => when(r.interviewAt)], ['Interviewer', (r) => r.interviewer || '', NO_PDF],
      ['Interview Status', (r) => r.statusLabel || ''], ['Result', (r) => (r.result === '—' ? '' : r.result || '')],
      ['Internal Feedback', (r) => fb(r.internalFeedback), NO_PDF], ['Client Feedback', (r) => fb(r.clientFeedback), NO_PDF],
      ['Score', (r) => r.score ?? '', NO_PDF],
    ],
  },

  offers: {
    perm: ['interviews', 'Offers'],
    entity: 'Application',
    what: () => 'Offers',
    load: workspace('/ats/offers'),
    columns: [
      ...WS_HEAD,
      ['Offer Status', (r) => r.offerStatus || ''], ['Offer Date', (r) => r.offerDate || ''],
      ['Offered CTC', (r) => r.offeredCtc ?? ''], ['Documents', (r) => r.documentsStatus || ''],
      ['Owner', (r) => (r.owner === '—' ? '' : r.owner || ''), NO_PDF],
    ],
  },

  joining: {
    perm: ['interviews', 'Joining'],
    entity: 'Application',
    what: () => 'Joining',
    load: workspace('/ats/joining'),
    columns: [
      ...WS_HEAD,
      ['Offer Status', (r) => r.offerStatus || '', NO_PDF], ['Offered CTC', (r) => r.offeredCtc ?? ''],
      ['Joining Date', (r) => r.joiningDate || ''], ['Joining Status', (r) => r.joiningStatus || ''],
      ['Documents', (r) => r.documentsStatus || '', NO_PDF], ['Billing', (r) => r.billingStatus || '', NO_PDF],
      ['Owner', (r) => (r.owner === '—' ? '' : r.owner || ''), NO_PDF],
    ],
  },

  'internal-hiring': {
    perm: ['interviews', 'Internal Hiring'],
    entity: 'Application',
    what: () => 'Internal hiring',
    load: workspace('/ats/internal-hiring'),
    columns: [
      ...WS_HEAD,
      ['Offer Status', (r) => r.offerStatus || ''], ['Offered CTC', (r) => r.offeredCtc ?? ''],
      ['Joining Date', (r) => r.joiningDate || ''], ['Joining Status', (r) => r.joiningStatus || ''],
      ['HRMS Employee', (r) => (r.hrmsEmployeeId ? 'Created' : ''), NO_PDF],
    ],
  },

  followups: {
    perm: ['candidates', 'Applications'],
    entity: 'Application',
    what: () => 'Follow-ups',
    idOf: (r) => r.applicationId,
    load: (req, b) => screen(req, '/followups', b.params),
    columns: [
      ['Candidate', (r) => r.candidateName || ''], ['Req Code', (r) => r.requirementCode || '', NO_PDF],
      ['Requirement', (r) => r.requirementTitle || ''], ['Client', (r) => r.clientName || ''],
      ['Stage', (r) => r.stageLabel || ''], ['Owner', (r) => r.owner || ''], ['Owner Role', (r) => r.ownerRole || '', NO_PDF],
      ['TL', (r) => r.tl || '', NO_PDF], ['BDE', (r) => r.bde || '', NO_PDF],
      ['Next Action', (r) => r.nextAction || ''], ['Due Date', (r) => r.dueDate || ''], ['Due Time', (r) => r.dueTime || '', NO_PDF],
      ['Status', (r) => r.status || ''], ['Days Overdue', (r) => r.daysOverdue || '', NO_PDF],
      ['Contact Mode', (r) => r.contactMode || '', NO_PDF], ['Last Contacted', (r) => ymd(r.lastContactedAt), NO_PDF],
      ['Next Follow-up', (r) => r.nextFollowUpAt || '', NO_PDF], ['Escalation Level', (r) => r.escalationLevel || '', NO_PDF],
      ['Notes', (r) => r.notes || '', NO_PDF],
    ],
  },

  portal: {
    perm: ['requirements', 'Job Portal Workspace'],
    entity: 'Requirement',
    what: (b) => (b.view === 'applications' ? 'Job Portal applications' : 'Job Portal jobs'),
    async load(req, b) {
      if (b.view === 'applications') return ((await screen(req, '/job-portal/applications')) || {}).applications || [];
      return ((await screen(req, '/job-portal/workspace')) || {}).jobs || [];
    },
    columns: (b) => (b.view === 'applications'
      ? [
        ['Candidate', (a) => a.candidate], ['Email', (a) => a.email || ''], ['Phone', (a) => a.phone || '', NO_PDF],
        ['Req Code', (a) => a.reqCode || ''], ['Job', (a) => a.job || ''], ['Client', (a) => a.client || ''],
        ['Department', (a) => a.department || ''], ['Source', (a) => a.source || '', NO_PDF],
        ['Stage', (a) => a.stageLabel || ''], ['Applied', (a) => ymd(a.appliedAt)],
        ['Imported to ATS', (a) => (a.imported ? ymd(a.importedAt) || 'Yes' : 'No')],
      ]
      : [
        ['Req Code', (j) => j.reqCode || ''], ['Job Title', (j) => j.title], ['Client', (j) => j.client || ''],
        ['Department', (j) => j.department || ''], ['Location', (j) => j.location || '', NO_PDF],
        ['Openings', (j) => j.openings ?? ''], ['Status', (j) => j.statusLabel || j.status || ''],
        ['Published', (j) => (j.published ? 'Yes' : 'No')], ['Published On', (j) => ymd(j.publishedAt), NO_PDF],
        ['Portal Sync', (j) => j.portalSyncStatus || '', NO_PDF], ['Applications', (j) => j.applications ?? ''],
      ]),
  },

  'client-portal': {
    perm: ['requirements', 'Client Job Portal'],
    entity: 'Requirement',
    what: (b) => (b.view === 'candidates' ? 'Shared candidates' : 'My requirements'),
    idOf: (r) => r.applicationId || r.id,
    async load(req, b) {
      const data = (await screen(req, '/job-portal/client')) || {};
      if (b.view === 'candidates') {
        const title = new Map((data.requirements || []).map((r) => [r.id, r.title]));
        return (data.candidates || []).map((c) => ({ ...c, requirementTitle: title.get(c.requirementId) || '' }));
      }
      return data.requirements || [];
    },
    columns: (b) => (b.view === 'candidates'
      ? [
        ['Candidate', (c) => c.name], ['Requirement', (c) => c.requirementTitle], ['Experience (yrs)', (c) => c.experienceYears ?? ''],
        ['Location', (c) => c.location || ''], ['Skills', (c) => c.skills || '', NO_PDF], ['Stage', (c) => c.stageLabel || ''],
        ['Interview', (c) => when(c.interviewAt)], ['Shared On', (c) => ymd(c.sharedAt)],
      ]
      : [
        ['Req Code', (r) => r.reqCode || ''], ['Job Title', (r) => r.title], ['Department', (r) => r.department || ''],
        ['Location', (r) => r.location || ''], ['Openings', (r) => r.openings ?? ''], ['Live', (r) => (r.live ? 'Yes' : 'No')],
        ['Published', (r) => (r.published ? 'Yes' : 'No')], ['Shared Candidates', (r) => r.sharedCandidates ?? ''],
        ['Raised On', (r) => ymd(r.raisedAt)],
      ]),
  },

  // The ATS home: its tiles and its action queue for the chosen date range.
  // Nothing to import here — a dashboard is computed, not entered.
  dashboard: {
    perm: ['dashboard', 'KPI Overview'],
    entity: 'Dashboard',
    what: () => 'ATS dashboard',
    idOf: (r) => r.key,
    async load(req, b) {
      const d = (await screen(req, '/dashboard/ats', b.params)) || {};
      req.atsIoPeriod = d.period && d.period.from ? { from: d.period.from, to: d.period.to } : null;
      const out = [];
      (d.myWork || []).forEach((r) => out.push({ key: `w:${r.label}`, section: d.myWorkTitle || 'My Work', item: r.label, value: r.value }));
      (d.activity || []).forEach((r) => out.push({ key: `a:${r.label}`, section: 'In the selected period', item: r.label, value: r.value }));
      (d.pendingActions || []).forEach((r) => out.push({ key: `p:${r.id}`, section: d.pendingTitle || 'Pending actions', item: r.label, value: r.count }));
      ((d.pastSla && d.pastSla.parts) || []).forEach((r) => out.push({ key: `s:${r.id}`, section: 'Past SLA (now)', item: r.label, value: r.count }));
      (d.queue || []).forEach((q) => out.push({
        key: `q:${q.id}:${q.nextAction}`, section: 'Action queue', item: q.nextAction, value: '',
        candidate: q.candidate, requirement: q.requirement, client: q.client, stage: q.stageLabel, due: q.due, overdue: q.overdue,
      }));
      return out;
    },
    columns: [
      ['Section', (r) => r.section], ['Item', (r) => r.item], ['Count', (r) => r.value],
      ['Candidate', (r) => r.candidate || ''], ['Requirement', (r) => r.requirement || ''], ['Client', (r) => r.client || '', NO_PDF],
      ['Stage', (r) => r.stage || ''], ['Due', (r) => r.due || ''], ['Overdue', (r) => (r.overdue ? 'Yes' : ''), NO_PDF],
    ],
  },
};

const PDF_ROW_CAP = 5000;

// The screen's state: GET carries it in the query string, POST as a JSON
// body (sent as text/plain so a long `ids` list is not refused by the
// app-wide 100 kB JSON limit).
function exportState(req) {
  if (req.method === 'GET') {
    const { format, view, tab, former, ...params } = req.query || {};
    return { params, view, tab, former: former === '1' || former === 'true' };
  }
  let b = req.body;
  if (typeof b === 'string') {
    try { b = b.trim() ? JSON.parse(b) : {}; } catch { throw new HttpError(400, { error: 'The export request could not be read.' }); }
  }
  b = b && typeof b === 'object' ? b : {};
  const params = b.params && typeof b.params === 'object' ? b.params : {};
  // "Everything I can access" (scope: 'all'): the screen's filters, chip and
  // selected rows are dropped — only the role's own scope (applied by the
  // screen's endpoint, server-side) remains.
  const all = b.scope === 'all';
  return {
    params: all ? {} : params,
    view: all ? '' : (b.view || ''),
    tab: b.tab || '',
    former: !!b.former,
    ids: !all && Array.isArray(b.ids) ? b.ids.map(String) : null,
    scope: all ? 'all' : 'view',
    // Lets a test (or a deliberate user) send a smaller export to the
    // background; it can only LOWER the threshold, never raise it.
    threshold: Number(b.backgroundThreshold) > 0 ? Number(b.backgroundThreshold) : null,
  };
}

// The roles whose export right the spec's table gives (utils/ioAccess.js);
// any other role also needs the Role Catalog's `export` on the feature.
const SPEC_EXPORT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'HR'];

async function runExport(req, res) {
  const moduleId = req.params.module;
  const def = EXPORTS[moduleId];
  if (!def) throw new HttpError(404, { error: 'Unknown export' });
  const format = formatOf(req.query);
  if (!format) throw new HttpError(400, { error: 'format must be xlsx, csv or pdf' });
  const access = await ioAccessFor(req.user, moduleId);
  const permitted = await can(req.user, 'ats', def.perm[0], def.perm[1], 'export');
  if (!access.export || (!permitted && !SPEC_EXPORT_ROLES.includes(access.role))) throw DENIED('Export on this screen');

  const state = exportState(req);
  let rows = await def.load(req, state, access);
  if (!Array.isArray(rows)) rows = [];
  // The screen's own browser-side filters: keep what it shows, in its order.
  if (state.ids) {
    const idOf = def.idOf || ((r) => r.id);
    const byId = new Map(rows.map((r) => [String(idOf(r)), r]));
    rows = state.ids.map((id) => byId.get(id)).filter(Boolean);
  }
  let columns = typeof def.columns === 'function' ? def.columns(state) : def.columns;
  // PAN / Aadhaar / bank only for HR / Admin / Super Admin; revenue only Admin.
  columns = columns.filter((c) => !(c[2] && c[2].sensitive && !access.sensitive) && !(c[2] && c[2].revenue && !access.revenue));
  if (format === 'pdf') {
    if (rows.length > PDF_ROW_CAP) {
      throw new HttpError(400, { error: `${rows.length} rows is too many for a readable PDF (the limit is ${PDF_ROW_CAP}). Use Excel or CSV, or narrow the filters.` });
    }
    columns = columns.filter((c) => !(c[2] && c[2].pdf === false));
  }
  const what = def.what(state);
  const p = state.params || {};
  const period = req.atsIoPeriod || (p.from || p.to ? { from: p.from || '…', to: p.to || '…' } : null);
  const table = {
    format,
    name: `ats-${moduleId}${state.tab ? `-${state.tab}` : ''}${state.view && state.view !== 'all' ? `-${state.view}` : ''}${state.scope === 'all' ? '-everything' : ''}`,
    title: what,
    headers: columns.map((c) => c[0]),
    rows: rows.map((r) => columns.map((c) => {
      const v = c[1](r);
      return v === undefined ? '' : v;
    })),
    sheet: what.slice(0, 31),
    entity: def.entity,
    what: `ATS ${what}${state.scope === 'all' ? ' (everything I can access)' : ' (current view)'}`,
    scope: scopeLabel(req.user, 'ats'),
    period,
    module: moduleId,
  };
  // BIG EXPORTS: answered at once, written in the background.
  const limit = Math.min(exportJobs.threshold(), state.threshold || Infinity);
  if (table.rows.length > limit) {
    const job = exportJobs.startBackgroundExport(req.user, table);
    return res.status(202).json({
      background: true,
      id: job.id,
      rows: job.rows,
      filename: job.filename,
      message: `${job.rows.toLocaleString('en-IN')} rows is a big export — it is being prepared in the background. You will get a notification (and an email) when it is ready; it will be under the History button on this screen.`,
    });
  }
  return sendTable(req, res, table);
}

router.get('/export/:module', guarded(runExport));
router.post('/export/:module', express.text({ type: () => true, limit: '30mb' }), guarded(runExport));

// ===========================================================================
// IMPORT
// ===========================================================================

// Each kind: its label, the permission it needs, and `mode` — `create` kinds
// add records and SKIP one already on file; `update` kinds change records that
// must already exist. `examples` are the two clearly fake template rows.
const KINDS = {
  clients: {
    label: 'Clients', mode: 'create', perm: ['clients', 'Bulk Import', 'create'], // clients role spec §3: Import = Admin only
    examples: [
      { 'Client Name': 'Sample Client Pvt Ltd', Industry: 'Healthcare', 'Client Type': 'Direct', Status: 'Active', 'Owning Department': 'Medical', 'Primary Contact Name': 'Sample HR', 'Primary Contact Phone': '9000000001', 'Primary Contact Email': 'hr@sample-client.example.com', 'City / State': 'Telangana', City: 'Hyderabad', 'Fee %': 8.33, 'Agreement Status': 'DRAFT' },
      { 'Client Name': 'Example Industries Pvt Ltd', Industry: 'Manufacturing', 'Client Type': 'Direct', Status: 'Active', 'Owning Department': 'Manufacturing', 'Primary Contact Name': 'Example Recruiter', 'Primary Contact Phone': '9000000002', 'Primary Contact Email': 'jobs@example-industries.example.com', 'City / State': 'Karnataka', City: 'Bengaluru' },
    ],
  },
  agreements: {
    label: 'Agreement updates', mode: 'update', perm: ['clients', 'Bulk Import', 'create'],
    examples: [
      { 'Client Name': 'Sample Client Pvt Ltd', 'Agreement Status': 'ACTIVE', 'Agreement Start': '01-04-2026', 'Agreement End': '31-03-2027', 'Fee %': 8.33, 'Invoice Trigger': 'Candidate Joining' },
      { 'Client Name': 'Example Industries Pvt Ltd', 'Agreement Status': 'SENT', 'Fee %': 10 },
    ],
  },
  requirements: {
    label: 'Requirements', mode: 'create', perm: ['requirements', 'Bulk Import', 'create'], // requirements role spec §3: Admin + BDE
    examples: [
      { 'Requirement Code': 'SAMPLE-0001', 'Job Title': 'Sample Staff Nurse', 'Client Name': 'Sample Client Pvt Ltd', Department: 'Medical', Status: 'OPEN', Priority: 'High', Openings: 2, 'Mandatory Skills': 'GNM, ICU', Location: 'Hyderabad', 'Closing Date': '31-12-2026' },
      { 'Requirement Code': 'SAMPLE-0002', 'Job Title': 'Example Lecturer', 'Client Name': 'Example Industries Pvt Ltd', Department: 'Education', Status: 'DRAFT', Openings: 1 },
    ],
  },
  candidates: {
    label: 'Candidates', mode: 'create', perm: ['candidates', 'Add Candidate', 'create'],
    examples: [
      { 'Full Name': 'Sample Candidate One', Email: 'sample.one@example.com', Phone: '9000000001', 'Current Location': 'Hyderabad', 'Total Experience (years)': 2, Source: 'Naukri', 'Mandatory Skills': 'ICU, Patient care', 'Requirement Code': 'SAMPLE-0001', Stage: 'NEW' },
      { 'Full Name': 'Sample Candidate Two', Email: 'sample.two@example.com', Phone: '9000000002', 'Current Location': 'Vijayawada', Source: 'Referral' },
    ],
  },
  applications: {
    label: 'Applications (pipeline)', mode: 'create', perm: ['candidates', 'Applications', 'create'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', Stage: 'NEW', Source: 'Naukri' },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', Stage: 'RECRUITER_REVIEW' },
    ],
  },
  'requirement-assignments': {
    label: 'Requirement → recruiter assignments', mode: 'update', perm: ['recruiterbde', 'Team View', 'assign'],
    examples: [
      { 'Requirement Code': 'SAMPLE-0001', 'Recruiter (Employee Code or Email)': 'SAMPLE01', 'Assign As': 'Primary' },
      { 'Requirement Code': 'SAMPLE-0002', 'Recruiter (Employee Code or Email)': 'sample.recruiter@example.com', 'Assign As': 'Co-recruiter' },
    ],
  },
  interviews: {
    label: 'Interview schedules', mode: 'update', perm: ['interviews', 'Schedule Interview', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', 'Interview Round': 1, 'Interview Type': 'Client Interview', 'Interview Date': '26-10-2026', 'Interview Time': '11:00', 'Interview Mode': 'Online', Interviewer: 'Sample Panel', 'Interview Status': 'SCHEDULED' },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', 'Interview Round': 1, 'Interview Date': '27-10-2026', 'Interview Time': '15:30', 'Interview Mode': 'In Person' },
    ],
  },
  'interview-feedback': {
    label: 'Interview outcomes & feedback', mode: 'update', perm: ['interviews', 'Interview Feedback', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', 'Interview Round': 1, 'Interview Status': 'COMPLETED', 'Interview Result': 'Recommended', 'Feedback By': 'Internal', 'Technical (1-5)': 4, 'Communication (1-5)': 4, 'Feedback Comments': 'Sample feedback' },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', 'Interview Status': 'COMPLETED', 'Interview Result': 'Hold' },
    ],
  },
  offers: {
    label: 'Offers', mode: 'update', perm: ['interviews', 'Offers', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', 'Offer Status': 'Offer Released', 'Offer Date': '01-11-2026', 'Offered CTC (annual ₹)': 300000 },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', 'Offer Status': 'Offer Accepted', 'Documents Status': 'Submitted' },
    ],
  },
  joining: {
    label: 'Joining dates & statuses', mode: 'update', perm: ['interviews', 'Joining', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', 'Joining Date': '15-11-2026', 'Joining Status': 'Joining Scheduled' },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', 'Joining Date': '10-11-2026', 'Joining Status': 'Joined', 'Documents Status': 'Verified' },
    ],
  },
  'internal-hiring': {
    label: 'Internal hires', mode: 'update', perm: ['interviews', 'Internal Hiring', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0003', 'Offer Status': 'Offer Released', 'Offer Date': '01-11-2026', 'Offered CTC (annual ₹)': 240000 },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0003', 'Joining Date': '15-11-2026', 'Joining Status': 'Joining Scheduled' },
    ],
  },
  followups: {
    label: 'Follow-ups', mode: 'update', perm: ['candidates', 'Applications', 'edit'],
    examples: [
      { 'Candidate Email or Phone': 'sample.one@example.com', 'Requirement Code': 'SAMPLE-0001', 'Next Action': 'Confirm interview slot', 'Due Date': '30-10-2026', 'Contact Mode': 'Call', Notes: 'Sample note' },
      { 'Candidate Email or Phone': '9000000002', 'Requirement Code': 'SAMPLE-0002', 'Next Action': 'Collect documents', 'Due Date': '02-11-2026', 'Contact Mode': 'WhatsApp' },
    ],
  },
};

// Which kinds each screen offers (the frontend reads this; the server checks
// each kind's own permission regardless).
const MODULE_KINDS = {
  requirements: ['requirements'],
  clients: ['clients'],
  agreements: ['agreements'],
  candidates: ['candidates', 'applications'],
  team: ['requirement-assignments'],
  interviews: ['interviews'],
  feedback: ['interview-feedback'],
  offers: ['offers'],
  joining: ['joining'],
  'internal-hiring': ['internal-hiring'],
  followups: ['followups'],
  portal: [],
  'client-portal': [],
  dashboard: [],
};

async function mayImportPerm(user, kindId) {
  const k = KINDS[kindId];
  return !!k && can(user, 'ats', k.perm[0], k.perm[1], k.perm[2]);
}

// The screen each import kind belongs to (for utils/ioAccess.js).
const MODULE_OF_KIND = {
  clients: 'clients', agreements: 'clients', requirements: 'requirements', candidates: 'candidates', applications: 'candidates',
  resumes: 'candidates', 'requirement-assignments': 'team', interviews: 'interviews', 'interview-feedback': 'interviews',
  offers: 'offers', joining: 'joining', 'internal-hiring': 'internal-hiring', followups: 'followups',
};

// HOW this login may import a kind (spec 2026-10-03 "Who may import"):
//   'direct'  — imports at once (needs the kind's own permission too, so the
//               Manager / Assistant Manager view-only rule in can() stands)
//   'request' — BDE: the file becomes a REQUEST an Admin / Manager approves
//   null      — no import
async function importModeOf(user, kindId) {
  if (!KINDS[kindId] && kindId !== 'resumes') return null;
  const access = await ioAccessFor(user, MODULE_OF_KIND[kindId] || kindId, kindId);
  if (access.importMode === 'request') return 'request';
  if (access.importMode === 'direct') {
    const perm = kindId === 'resumes' ? await can(user, 'ats', 'candidates', 'Add Candidate', 'create') : await mayImportPerm(user, kindId);
    return perm ? 'direct' : null;
  }
  return null;
}
async function mayImport(user, kindId) { return !!(await importModeOf(user, kindId)); }

// --- reading any spreadsheet -------------------------------------------------
const MAX_BYTES = 15 * 1024 * 1024;
const hkey = (s) => String(s || '').toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]/g, '');
const hkeyBare = (s) => hkey(String(s || '').replace(/\([^)]*\)/g, ''));
// What people actually call these columns on their own sheets.
const ALIASES = {
  'Client Name': ['client', 'company', 'companyname', 'clientcompany', 'organisation', 'organization', 'hospital', 'college'],
  'Requirement Code': ['reqcode', 'reqid', 'requirementid', 'jobcode', 'jobid', 'req', 'requirementno', 'reqno'],
  'Candidate Email or Phone': ['email', 'emailid', 'phone', 'mobile', 'mobileno', 'mobilenumber', 'phonenumber', 'candidateemail', 'candidatephone', 'candidatemobile', 'contact', 'contactnumber'],
  'Full Name': ['name', 'candidatename', 'candidate', 'fullname'],
  'Job Title': ['title', 'jobrole', 'position', 'designation', 'role', 'jobtitle', 'post'],
  Email: ['emailid', 'mail', 'emailaddress', 'candidateemail'],
  Phone: ['mobile', 'mobileno', 'mobilenumber', 'phonenumber', 'contactnumber', 'contactno', 'candidatephone'],
  Stage: ['pipelinestage', 'currentstage'],
  Department: ['dept'],
  Openings: ['positions', 'noofpositions', 'vacancies', 'headcount', 'noofopenings'],
  'Assigned Recruiter': ['recruiter', 'recruitername', 'workedby'],
  'Assigned TL': ['tl', 'teamlead', 'teamleader', 'tlname'],
  'Assigned BDE': ['bde', 'bdename'],
  'Recruiter (Employee Code or Email)': ['recruiter', 'employeecode', 'empcode', 'recruiteremail', 'recruitercode', 'recruiterid'],
  'Interview Date': ['date', 'interviewon', 'interviewdate'],
  'Interview Time': ['time', 'slot'],
  'Joining Date': ['doj', 'dateofjoining', 'joinedon'],
  'Offered CTC (annual ₹)': ['ctc', 'offeredctc', 'offerctc', 'package', 'annualctc'],
  'Offer Date': ['offeredon'],
  'Current Location': ['location', 'city'],
  'Total Experience (years)': ['experience', 'exp', 'totalexperience', 'totalexp', 'experienceyears'],
  'Mandatory Skills': ['skills', 'keyskills', 'skillset'],
  'Agreement Status': ['agreement', 'status'],
  'Fee %': ['fee', 'feepercent', 'fees', 'placementfee', 'feepct'],
  'Due Date': ['due', 'followupdate', 'duedate'],
  'Next Action': ['action', 'nextstep', 'followup'],
  Notes: ['remarks', 'comments', 'note'],
  'Feedback Comments': ['comments', 'feedback', 'remarks'],
  'Interview Result': ['result', 'outcome', 'decision'],
  'Joining Status': ['status'],
  'Offer Status': ['status'],
  'Interview Status': ['status'],
  'Primary Contact Phone': ['contactphone', 'phone', 'mobile'],
  'Primary Contact Email': ['contactemail', 'email'],
  'Primary Contact Name': ['contactperson', 'contactname', 'hrname'],
};

function workbookGrids(file) {
  const buf = file.data;
  const head = buf.slice(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) throw new HttpError(400, { error: 'That is a PDF. Upload an Excel (.xlsx / .xls) or CSV file — download the template if you need one.' });
  const zip = head.startsWith('PK');
  const ole = buf.slice(0, 4).toString('hex') === 'd0cf11e0';
  let wb;
  try {
    wb = zip || ole
      ? XLSX.read(buf, { type: 'buffer', cellDates: false })
      : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true });
  } catch {
    throw new HttpError(400, { error: 'That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.' });
  }
  return wb;
}

// The sheet to read: the one named after the kind, else the first that is
// not a guide.
const GUIDE_SHEETS = ['instructions', 'lists', 'readme', 'fieldguide'];
function pickSheet(wb, spec, asked) {
  const names = wb.SheetNames || [];
  if (asked && names.includes(asked)) return asked;
  const named = names.find((n) => hkey(n) === hkey(spec.name));
  if (named) return named;
  return names.find((n) => !GUIDE_SHEETS.includes(hkey(n))) || names[0];
}

function autoMap(headerCells, spec, override) {
  const used = new Set();
  const map = new Map(); // spec header -> column index
  const cells = headerCells.map((h) => ({ raw: String(h ?? '').trim(), k: hkey(h), kb: hkeyBare(h) }));
  const claim = (col, i) => { map.set(col.h, i); used.add(i); };
  // 1. what the user chose
  if (override && typeof override === 'object') {
    spec.columns.forEach((col) => {
      if (!(col.h in override)) return;
      const i = override[col.h];
      if (i === null || i === -1 || i === '' || i === undefined) { map.set(col.h, null); return; }
      const n = Number(i);
      if (Number.isInteger(n) && n >= 0 && n < cells.length && !used.has(n)) claim(col, n);
    });
  }
  const open = (col) => !map.has(col.h);
  // 2. the header itself, 3. without its (…) part, 4. an alias
  spec.columns.forEach((col) => {
    if (!open(col)) return;
    const i = cells.findIndex((c, idx) => !used.has(idx) && c.k && c.k === hkey(col.h));
    if (i >= 0) claim(col, i);
  });
  spec.columns.forEach((col) => {
    if (!open(col)) return;
    const i = cells.findIndex((c, idx) => !used.has(idx) && c.kb && c.kb === hkeyBare(col.h));
    if (i >= 0) claim(col, i);
  });
  spec.columns.forEach((col) => {
    if (!open(col)) return;
    const aliases = ALIASES[col.h] || [];
    const i = cells.findIndex((c, idx) => !used.has(idx) && c.k && aliases.includes(c.k));
    if (i >= 0) claim(col, i);
  });
  return map;
}

// File -> an ExcelJS sheet in the importer's own shape (row 1 = the spec's
// headers, one row per file row), so routes/dataImport.js readSheet() reads it
// exactly as it reads the master workbook. Row numbers are kept: `rowOf`
// turns a sheet row back into the row of the uploaded file.
function prepare(file, spec, { mapping, sheet: askedSheet, onlyRows = null } = {}) {
  const wb = workbookGrids(file);
  const sheetName = pickSheet(wb, spec, askedSheet);
  const xs = wb.Sheets[sheetName];
  if (!xs || !xs['!ref']) throw new HttpError(400, { error: 'That sheet is empty.' });
  const range = XLSX.utils.decode_range(xs['!ref']);
  const grid = XLSX.utils.sheet_to_json(xs, { header: 1, raw: true, defval: '', blankrows: true });
  const firstRow = range.s.r + 1; // 1-based row of grid[0]

  // The header row: of the first 15, the one that names most spec columns.
  let best = { idx: -1, score: 0 };
  for (let i = 0; i < Math.min(15, grid.length); i += 1) {
    const score = autoMap(grid[i] || [], spec, null).size;
    if (score > best.score) best = { idx: i, score };
  }
  if (best.idx < 0) {
    throw new HttpError(400, { error: `No column on "${sheetName}" matches this import. The first row should hold the column names — download the template to see them.` });
  }
  const headerCells = (grid[best.idx] || []).map((h) => String(h ?? '').trim());
  const map = autoMap(headerCells, spec, mapping);
  const exampleAt = headerCells.findIndex((h) => ['example', 'example?'].includes(String(h).trim().toLowerCase()));

  const ws = new ExcelJS.Workbook().addWorksheet('data');
  const mapped = spec.columns.filter((col) => Number.isInteger(map.get(col.h)));
  const header = mapped.map((col) => col.h);
  if (exampleAt >= 0) header.unshift('Example?');
  // Cell by cell: ExcelJS reads an array whose first element is empty as a
  // SPARSE array and would shift every value one column right.
  const put = (rowNo, values) => values.forEach((v, j) => { if (v !== null && v !== undefined && v !== '') ws.getCell(rowNo, j + 1).value = v; });
  put(1, header);
  let examples = 0;
  const data = grid.slice(best.idx + 1);
  const headerAt = firstRow + best.idx;
  data.forEach((cells, i) => {
    // An approved import REQUEST writes only the rows that passed when it
    // was sent (file row numbers).
    if (onlyRows && !onlyRows.has(headerAt + i + 1)) return;
    const values = mapped.map((col) => {
      const v = cells[map.get(col.h)];
      return v === undefined ? null : v;
    });
    if (exampleAt >= 0) {
      const marker = cells[exampleAt];
      if (/^\s*example/i.test(String(marker || ''))) examples += 1;
      values.unshift(marker === undefined ? null : marker);
    }
    // Only non-empty rows are written; the index keeps the file's numbering.
    if (values.some((v) => v !== null && v !== '')) put(i + 2, values);
  });
  const headerFileRow = firstRow + best.idx;
  return {
    ws,
    sheet: sheetName,
    sheets: wb.SheetNames,
    headerRow: headerFileRow,
    rowOf: (wsRow) => headerFileRow + (wsRow - 1),
    // The original cells of a file row — for the "rows with errors" download.
    cellsOf: (fileRow) => grid[fileRow - firstRow] || [],
    fileColumns: headerCells,
    exampleRows: examples,
    mapping: spec.columns.map((col) => {
      const i = map.get(col.h);
      return {
        header: col.h,
        required: !!col.req,
        type: col.t === 'list' ? 'list' : col.t,
        allowed: col.t === 'list' ? LISTS[col.list] || [] : undefined,
        column: Number.isInteger(i) ? i : null,
        columnName: Number.isInteger(i) ? headerCells[i] : null,
      };
    }),
    unmapped: headerCells
      .map((h, i) => ({ h, i }))
      .filter(({ h, i }) => h && i !== exampleAt && ![...map.values()].includes(i))
      .map(({ h }) => h),
  };
}

// --- per-kind rules ------------------------------------------------------------
const norm = (s) => String(s || '').trim().toLowerCase();
const csvIds = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = 'is outside your scope';

async function requirementByCode(ctx, code) {
  const id = ctx.ix.requirement.get(norm(code));
  if (!id) throw new Error(`requirement "${code}" is not on file`);
  if (isDry(id)) return { id, dry: true };
  if (!ctx.reqCache.has(id)) ctx.reqCache.set(id, await prisma.requirement.findUnique({ where: { id } }));
  return ctx.reqCache.get(id);
}

function assertRequirementInScope(ctx, req, code) {
  if (ctx.global || req.dry) return;
  if (!matches(req, requirementWhere(ctx.user))) {
    throw new Error(`requirement ${code} ${OUT} — it belongs to another team`);
  }
}

// The application a row names, in scope, with its requirement.
async function applicationFor(ctx, data) {
  const candidateId = findCandidate(ctx.ix, data._candidate);
  if (!candidateId) throw new Error(`no candidate with email / phone "${data._candidate}" is on file`);
  const requirementId = ctx.ix.requirement.get(norm(data._requirement));
  if (!requirementId) throw new Error(`requirement "${data._requirement}" is not on file`);
  const app = await prisma.application.findFirst({
    where: { candidateId, requirementId },
    include: { requirement: true, candidate: { select: { name: true } } },
  });
  if (!app) throw new Error(`${data._candidate} has no application on ${data._requirement} — add them to that pipeline first`);
  if (!ctx.global && !applicationInScope(ctx.user, app)) {
    throw new Error(`${data._candidate} on ${data._requirement} ${OUT} — that requirement belongs to another team`);
  }
  return app;
}

// A stage a non-admin may put a NEW application at: the entry stages, or one
// their role owns on the pipeline (the same rule the stage buttons follow).
const ENTRY_STAGES = ['NEW', 'RECRUITER_REVIEW'];
async function assertStageAllowed(ctx, stage) {
  if (ctx.global || !stage || ENTRY_STAGES.includes(stage)) return;
  const refusal = await canMoveToStage(ctx.user, stage);
  if (refusal) throw new Error(`Stage ${stage}: ${refusal.body.error}`);
}

const same = (a, b) => {
  const f = (v) => (v === null || v === undefined || v === '' ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  return f(a) === f(b);
};
// Nothing in the row would change the application: skip, never "update".
function unchanged(app, data) {
  const fields = Object.entries(data).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined);
  return fields.length > 0 && fields.every(([k, v]) => same(app[k], v));
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const RULES = {
  clients: {
    keyOf: (d, ix) => ix.ckey(d.name),
    // DUPLICATE = same name (case / punctuation ignored) or same GST number.
    // Never overwritten silently: only with "Update existing" ticked, and
    // only a client inside the caller's scope.
    async guard(ctx, d, note) {
      let id = ctx.ix.client.get(ctx.ix.ckey(d.name));
      let by = 'name';
      if ((!id || isDry(id)) && d.gst) {
        const g = await prisma.client.findFirst({ where: { gst: String(d.gst).trim() }, select: { id: true, name: true } });
        if (g) { id = g.id; by = 'gst'; d._gstName = g.name; }
      }
      if (!id || isDry(id)) return null;
      // Client lifecycle (2026-10-03): an import never changes a client's
      // status — Pause / Reactivate / Archive are actions with a reason.
      if (d.status) { note(`Status "${d.status}" ignored — change a client's status with Pause / Reactivate / Archive on the client`); delete d.status; }
      const what = by === 'gst' ? `the same GST number ("${d._gstName}")` : 'the same name';
      if (!ctx.updateExisting) return { skip: `a client with ${what} is already on file — skipped, nothing overwritten`, duplicate: true };
      if (!ctx.global && !(await prisma.client.count({ where: { AND: [{ id }, clientWhere(ctx.user)] } }))) {
        throw new Error(`client "${by === 'gst' ? d._gstName : d.name}" ${OUT} — not updated`);
      }
      if (by === 'gst') { note(`matches "${d._gstName}" by GST number — that client is updated (not renamed)`); d.name = d._gstName; } else note('already on file — will be updated; blank cells keep what it has');
      return null;
    },
  },

  agreements: {
    keyOf: (d, ix) => ix.ckey(d.name),
    async guard(ctx, d) {
      const id = ctx.ix.client.get(ctx.ix.ckey(d.name));
      if (!id || isDry(id)) throw new Error(`no client called "${d.name}" is on file — add the client first (Clients → Import)`);
      if (!ctx.global && !(await prisma.client.count({ where: { AND: [{ id }, clientWhere(ctx.user)] } }))) {
        throw new Error(`client "${d.name}" ${OUT}`);
      }
      const cur = await prisma.client.findUnique({ where: { id } });
      if (unchanged(cur, d)) return { skip: 'already up to date — nothing to change' };
      return null;
    },
  },

  requirements: {
    keyOf: (d, ix) => ix.norm(d.reqCode),
    // DUPLICATE = same requirement code, or the same job title for the same
    // client. Updated only with "Update existing" ticked, in scope.
    async guard(ctx, d, note) {
      const { ix, user } = ctx;
      let id = ix.requirement.get(ix.norm(d.reqCode));
      let dupBy = id && !isDry(id) ? 'code' : null;
      const clientId = ix.client.get(ix.ckey(d._client));
      if (!dupBy && clientId && !isDry(clientId) && d.title) {
        const same = await prisma.requirement.findFirst({ where: { clientId, title: String(d.title).trim() }, select: { id: true, reqCode: true } });
        if (same) { id = same.id; dupBy = 'title'; d._sameCode = same.reqCode; }
      }
      if (dupBy) {
        const what = dupBy === 'code' ? `requirement ${d.reqCode}` : `"${d.title}" for ${d._client}${d._sameCode ? ` (${d._sameCode})` : ''}`;
        if (!ctx.updateExisting) return { skip: `${what} is already on file — skipped, nothing overwritten`, duplicate: true };
        const cur = await prisma.requirement.findUnique({ where: { id } });
        if (!ctx.global && !matches(cur, requirementWhere(user))) throw new Error(`${what} ${OUT} — not updated`);
        if (dupBy === 'title') {
          if (!d._sameCode) return { skip: `${what} is already on file but has no requirement code, so it cannot be updated from a file`, duplicate: true };
          note(`same title + client as ${d._sameCode} — that requirement is updated`);
          d.reqCode = d._sameCode;
        } else note('already on file — will be updated; blank cells keep what it has');
        // An update changes only what the file says; the status gate and the
        // assignment defaults below are for NEW requirements.
        if (!d.status) delete d.status;
        return null;
      }
      if (!clientId) throw new Error(`client "${d._client}" is not on file`);
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementStatus: true, clientType: true } });
      // The assignment chain as ids, so scope can be judged before the write.
      const uid = (name) => { const u = name ? ix.user.get(ix.norm(name)) : null; return u && !isDry(u) ? u : null; };
      if (d.tl) { const t = uid(d.tl); if (t) d.tlId = t; else note(`TL "${d.tl}" has no login — kept as a name`); }
      if (d.stl) { const t = uid(d.stl); if (t) d.stlId = t; }
      const recruiterId = uid(d._recruiter);
      if (!ctx.global && ctx.s.atsRole === 'TL' && !d.tlId) {
        d.tlId = user.id; d.tl = user.name;
        note('TL set to you');
      }
      // THE AGREEMENT GATE, as Add Requirement applies it: a client
      // requirement is not live until the client's agreement is Active.
      const internal = client && client.clientType === 'Internal';
      let status = d.status || 'OPEN';
      // Spec 6: ANY live status (Open, Sourcing …) waits for an Active agreement.
      if (requirementIsLive(status) && !internal && !agreementIsActive(client && client.agreementStatus)) {
        status = 'AGREEMENT_CHECK';
        note('saved at Agreement Check — the client agreement is not Active yet');
      } else if (status === 'OPEN' && recruiterId) status = 'RECRUITER_ASSIGNED';
      d.status = status;
      if (internal) d.internal = true;
      if (!ctx.global) {
        const seat = d._seat ? ix.position.get(ix.norm(d._seat)) : null;
        const would = {
          id: '__new__', clientId, department: d.department, internal: !!internal,
          tlId: d.tlId || null, stlId: d.stlId || null, recruiterId, recruiterIds: '', bdeId: uid(d._bde),
          positionCode: seat ? seat.code : null,
        };
        if (!matches(would, requirementWhere(user))) {
          throw new Error(`this requirement would be outside your scope — name yourself or one of your team as its TL / recruiter`);
        }
      }
      return null;
    },
  },

  candidates: {
    keyOf: (d, ix) => ix.norm(d.email || d.phone || `ref:${d.externalRef}`),
    async guard(ctx, d, note) {
      const { ix } = ctx;
      const hit = [d.email, d.phone, d.externalRef && `ref:${d.externalRef}`].filter(Boolean)
        .map((v) => ix.candidate.get(ix.norm(v))).find(Boolean);
      const existing = hit && !isDry(hit) ? hit : null;
      let requirement = null;
      if (d._requirement) {
        if (!ctx.mayApply) throw new Error('adding to a pipeline needs the Applications permission — leave Requirement Code blank');
        requirement = await requirementByCode(ctx, d._requirement);
        assertRequirementInScope(ctx, requirement, d._requirement);
        await assertStageAllowed(ctx, d._stage);
        if (existing && !requirement.dry
          && await prisma.application.count({ where: { candidateId: existing, requirementId: requirement.id } })) {
          return { skip: `already on file and already on ${d._requirement} — skipped` };
        }
      }
      // DUPLICATE = same phone (last ten digits) or email. Updated only with
      // "Update existing" ticked, and only a candidate in the caller's scope.
      if (existing && ctx.updateExisting) {
        if (!ctx.global && !(await prisma.candidate.count({ where: { AND: [{ id: existing }, candidateWhere(ctx.user)] } }))) {
          throw new Error(`a candidate with this email / phone is on file but ${OUT} — not updated`);
        }
        d._update = true;
        note('already on file — will be updated; blank cells keep what they have');
      }
      if (existing && !requirement && !d._update) return { skip: 'a candidate with this email / phone is already on file — skipped, nothing overwritten', duplicate: true };
      if (existing && requirement) note(`already on file — added to ${d._requirement}`);
      d._existing = existing;
      return null;
    },
    async handle(ctx, d, note, row) {
      let action = 'skipped';
      if (!d._existing || d._update) {
        const { _existing, _update, ...rest } = d;
        action = await HANDLERS.candidate({ data: rest, ix: ctx.ix, dry: ctx.dry, row, note });
      }
      if (d._requirement) {
        const key = d.email || d.phone || `ref:${d.externalRef}`;
        await HANDLERS.application({
          data: { _candidate: key, _requirement: d._requirement, stage: d._stage || 'NEW', source: d.source || null },
          ix: ctx.ix, dry: ctx.dry, row, note,
        });
        if (action === 'skipped') action = 'created';
        if (!d._existing) note(`added to ${d._requirement} at ${d._stage || 'NEW'}`);
      }
      return action;
    },
  },

  applications: {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}`,
    async guard(ctx, d) {
      const candidateId = findCandidate(ctx.ix, d._candidate);
      if (!candidateId) throw new Error(`no candidate with email / phone "${d._candidate}" is on file — import them as Candidates first`);
      const requirement = await requirementByCode(ctx, d._requirement);
      assertRequirementInScope(ctx, requirement, d._requirement);
      if (await prisma.application.count({ where: { candidateId, requirementId: requirement.id } })) {
        return { skip: `already on ${d._requirement} — skipped, the stage is not changed by an import` };
      }
      await assertStageAllowed(ctx, d.stage);
      return null;
    },
  },

  interviews: {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}|${d.interviewRound || 1}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      const round = d.interviewRound === null || d.interviewRound === undefined ? 1 : d.interviewRound;
      if ((app.interviewRound || 1) === round && app.interviewAt) {
        const at = new Date(app.interviewAt);
        const sameSlot = localDay(at) === d._date && (!d._time || localTime(at) === d._time)
          && (!d.interviewStatus || d.interviewStatus === app.interviewStatus)
          && ['interviewType', 'interviewMode', 'interviewer', 'interviewLocation', 'interviewMeetingLink', 'interviewResult']
            .every((k) => d[k] === null || d[k] === undefined || same(app[k], d[k]))
          && !d._feedbackBy;
        if (sameSlot) return { skip: 'this interview is already on the calendar as given — skipped' };
      }
      return null;
    },
  },

  'interview-feedback': {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}|${d.interviewRound || 0}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      if (d.interviewRound === null || d.interviewRound === undefined) d.interviewRound = app.interviewRound || 1;
      if (!d._date) {
        if (!app.interviewAt) throw new Error('no interview is scheduled on this application — give the Interview Date');
        const at = new Date(app.interviewAt);
        d._date = localDay(at);
        d._time = localTime(at);
      }
      // Already recorded exactly so: skip rather than "update" to itself.
      const prior = d._feedbackBy
        ? await prisma.interviewFeedback.findUnique({ where: { applicationId_kind: { applicationId: app.id, kind: d._feedbackBy } } })
        : null;
      const scoresSame = [['_technical', 'technical'], ['_communication', 'communication'], ['_experience', 'experience'], ['_roleFit', 'roleFit']]
        .every(([k, f]) => d[k] === null || d[k] === undefined || (prior && prior[f] === d[k]));
      const appSame = ['interviewStatus', 'interviewResult'].every((k) => d[k] === null || d[k] === undefined || same(app[k], d[k]));
      if (appSame && (!d._feedbackBy || (prior && scoresSame && (!d._comments || prior.overall === d._comments)))) {
        return { skip: 'already recorded as given — nothing to change' };
      }
      return null;
    },
  },

  offers: {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      if (['Offer Released', 'Offer Accepted'].includes(d.offerStatus) && d.offeredCtc == null && app.offeredCtc == null) {
        throw new Error('an offer needs the Offered CTC — this application has none yet');
      }
      if (unchanged(app, d)) return { skip: 'already up to date — nothing to change' };
      return null;
    },
  },

  joining: {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      if (hiringTypeOf(app, app.requirement) === INTERNAL_HIRE) {
        throw new Error('this is a TeamLink internal hire — import it on Internal Hiring');
      }
      if (unchanged(app, d)) return { skip: 'already up to date — nothing to change' };
      return null;
    },
  },

  'internal-hiring': {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      if (hiringTypeOf(app, app.requirement) !== INTERNAL_HIRE) {
        throw new Error(`${d._requirement} is a client requirement, not a TeamLink internal opening — use Offers / Joining`);
      }
      if (['Offer Released', 'Offer Accepted'].includes(d.offerStatus) && d.offeredCtc == null && app.offeredCtc == null) {
        throw new Error('an offer needs the Offered CTC — this application has none yet');
      }
      if (unchanged(app, d)) return { skip: 'already up to date — nothing to change' };
      return null;
    },
  },

  'requirement-assignments': {
    keyOf: (d, ix) => `${ix.norm(d._requirement)}|${ix.norm(d._recruiter)}`,
    async guard(ctx, d) {
      const { ix, s } = ctx;
      const requirement = await requirementByCode(ctx, d._requirement);
      assertRequirementInScope(ctx, requirement, d._requirement);
      // POST /requirements/:id/assign's own rule: a lead re-assigns what they
      // are on, or an unclaimed requirement in their scope.
      const unclaimed = !requirement.tlId && !requirement.recruiterId && !requirement.recruiterIds;
      if (!ctx.global && !unclaimed && !isAssignedTo(ctx.user, requirement)) {
        throw new Error(`${d._requirement} is assigned to someone else — only its TL (or an admin) re-assigns it`);
      }
      const who = String(d._recruiter).trim();
      const emp = ix.employeeByCode.get(ix.norm(who));
      const userId = (emp && emp.userId) || ix.userByEmail.get(ix.norm(who)) || null;
      if (!userId) throw new Error(`"${who}" is not an Employee Code or login email on file`);
      const person = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, status: true, atsRole: true, atsDepartment: true } });
      if (!person || (person.status || 'Active') !== 'Active') throw new Error(`${who} has no active login`);
      if (!['RECRUITER', 'TL', 'STL'].includes(person.atsRole)) throw new Error(`${person.name} is not a recruiter in ATS`);
      if (!ctx.global) {
        const team = s.positions ? s.positions.holderUserIds || []
          : s.teamUserIds || null;
        const inTeam = team ? team.includes(person.id) || person.id === s.userId
          : (s.departments || []).includes(person.atsDepartment);
        if (!inTeam) throw new Error(`${person.name} is not in your team`);
      }
      const as = d._as || 'Primary';
      const co = csvIds(requirement.recruiterIds);
      if (as === 'Primary' && requirement.recruiterId === person.id) return { skip: `${person.name} is already the recruiter on ${d._requirement}` };
      if (as !== 'Primary' && (co.includes(person.id) || requirement.recruiterId === person.id)) {
        return { skip: `${person.name} is already on ${d._requirement}` };
      }
      d._person = person; d._req = requirement; d._asRole = as;
      return null;
    },
    async handle(ctx, d, note) {
      const r = d._req; const p = d._person;
      if (ctx.dry) { note(`${d._asRole === 'Primary' ? 'recruiter' : 'co-recruiter'} → ${p.name}`); return 'updated'; }
      const data = {};
      if (d._asRole === 'Primary') data.recruiterId = p.id;
      else data.recruiterIds = [...csvIds(r.recruiterIds), p.id].join(',');
      if (r.status === 'OPEN') data.status = 'RECRUITER_ASSIGNED';
      const updated = await prisma.requirement.update({ where: { id: r.id }, data });
      ctx.reqCache.set(r.id, updated);
      await logAudit({
        userId: ctx.user.id, actorName: ctx.user.name, action: 'Requirement assignment changed (import)', entity: 'Requirement', entityId: r.id,
        fromValue: [r.tlId, r.recruiterId, r.recruiterIds].filter(Boolean).join(' / ') || 'unassigned',
        toValue: [updated.tlId, updated.recruiterId, updated.recruiterIds].filter(Boolean).join(' / '),
      });
      note(`${d._asRole === 'Primary' ? 'recruiter' : 'co-recruiter'} → ${p.name}`);
      return 'updated';
    },
  },

  followups: {
    keyOf: (d, ix) => `${ix.norm(d._candidate)}|${ix.norm(d._requirement)}|${ix.norm(d.nextAction)}|${d.dueDate || ''}`,
    async guard(ctx, d) {
      const app = await applicationFor(ctx, d);
      // routes/followups.js mayRecord(): the owner's chain records it.
      if (!ctx.global && !isAssignedTo(ctx.user, app.requirement)) {
        throw new Error('a follow-up is recorded by its owner — you are not on this requirement\'s assignment chain');
      }
      const open = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
      if (open && (!d.nextAction || norm(open.nextAction) === norm(d.nextAction)) && (!d.dueDate || open.dueDate === d.dueDate)) {
        return { skip: 'this follow-up is already open on the application — skipped' };
      }
      d._app = app;
      return null;
    },
    async handle(ctx, d) {
      if (ctx.dry) return 'created';
      // The Follow-up dialog's own endpoint, as the importer: its validation,
      // its "close the open one first", its audit row and in-app notice.
      const made = await loopback(ctx.req, 'POST', '/followups', {
        body: {
          applicationId: d._app.id,
          nextAction: d.nextAction || undefined,
          dueDate: d.dueDate || undefined,
          nextFollowUpAt: d.nextFollowUpAt || undefined,
          contactMode: d.contactMode || undefined,
          lastContactedAt: d.lastContactedAt || undefined,
          notes: d.notes || undefined,
        },
      });
      // Written by another request, so the batch is told by hand (Undo import).
      const fuId = made && (made.id || (made.followUp && made.followUp.id));
      if (fuId) batches.recordCreate('ApplicationFollowUp', fuId);
      return 'created';
    },
  },
};

async function runImport(req, kindId, prepared, { dry, updateExisting = false }) {
  const spec = ATS_IMPORT_SHEETS[kindId];
  const rule = RULES[kindId];
  const ix = await buildIndex();
  const s = scopeOf(req.user);
  const ctx = {
    req, user: req.user, s, global: s.global, dry, ix, reqCache: new Map(),
    mayApply: await can(req.user, 'ats', 'candidates', 'Applications', 'create'),
    // "Update existing records" ticked: a row matching a record on file
    // updates it (blank cells keep its values) instead of being skipped.
    updateExisting: !!updateExisting,
  };
  const { rows, problems } = readSheet(prepared.ws, spec);
  const results = [];
  problems.forEach((p) => results.push({
    row: p.row === 1 ? prepared.headerRow : prepared.rowOf(p.row), action: 'error', column: p.column, message: p.message,
  }));
  const seen = new Set();
  for (const { row, data } of rows) {
    // A column the file does not have reads as BLANK, exactly as an empty
    // cell on the full template does — the handlers test for null.
    spec.columns.forEach((col) => { if (data[col.f] === undefined) data[col.f] = null; });
    const fileRow = prepared.rowOf(row);
    const notes = [];
    const note = (m) => notes.push(m);
    let key = '';
    try {
      key = rule.keyOf(data, ix);
      if (key && seen.has(key)) {
        results.push({ row: fileRow, action: 'duplicate', message: 'the same record is on an earlier row of this file — skipped' });
        continue;
      }
      if (key) seen.add(key);
      // eslint-disable-next-line no-await-in-loop
      const verdict = await rule.guard(ctx, data, note);
      if (verdict && verdict.skip) {
        results.push({ row: fileRow, action: verdict.duplicate ? 'duplicate' : 'skip', message: verdict.skip });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const action = rule.handle
        ? await rule.handle(ctx, data, note, row)
        : await HANDLERS[spec.model]({
          data, ix, dry, row, actor: req.user, note, notStored: () => {},
        });
      results.push({
        row: fileRow,
        action: action === 'created' ? 'create' : action === 'updated' ? 'update' : 'skip',
        message: notes.join(' · '),
      });
    } catch (e) {
      results.push({ row: fileRow, action: 'error', message: e.message });
    }
  }
  results.sort((a, b) => a.row - b.row);
  const count = (a) => results.filter((r) => r.action === a).length;
  // The preview's three numbers (spec §B): VALID (will be written), ERRORS,
  // DUPLICATES (already on file / repeated in the file — never overwritten
  // unless "Update existing" is ticked). `skip` = nothing to change.
  const totals = {
    rows: rows.length + new Set(problems.filter((p) => p.row !== 1).map((p) => p.row)).size,
    create: count('create'), update: count('update'), skip: count('skip'), error: count('error'),
    duplicate: count('duplicate'),
    valid: count('create') + count('update'),
    examples: prepared.exampleRows,
  };
  // A row with errors is counted once however many cells are wrong.
  totals.errorRows = new Set(results.filter((r) => r.action === 'error').map((r) => r.row)).size;
  return { totals, results, ok: totals.error === 0 };
}

// The rows that were not imported, as the user's own columns + "Why" —
// fix them and import that file again.
function errorRowsFile(prepared, run) {
  const why = new Map();
  run.results.filter((r) => r.action === 'error' && r.row !== prepared.headerRow).forEach((r) => {
    why.set(r.row, [...(why.get(r.row) || []), `${r.column ? `${r.column}: ` : ''}${r.message}`]);
  });
  const header = [...prepared.fileColumns, 'Why it was not imported'];
  const rows = [...why.keys()].sort((a, b) => a - b).map((n) => {
    const cells = prepared.cellsOf(n);
    const out = prepared.fileColumns.map((_, i) => (cells[i] === undefined ? '' : cells[i]));
    return [...out, why.get(n).join(' | ')];
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Rows with errors');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}

function reportOf(kindId, prepared, run, filename) {
  const spec = ATS_IMPORT_SHEETS[kindId];
  return {
    kind: kindId,
    label: KINDS[kindId].label,
    mode: KINDS[kindId].mode,
    filename,
    sheet: prepared.sheet,
    sheets: prepared.sheets,
    headerRow: prepared.headerRow,
    fileColumns: prepared.fileColumns,
    mapping: prepared.mapping,
    unmapped: prepared.unmapped,
    missingRequired: prepared.mapping.filter((m) => m.required && m.column === null).map((m) => m.header),
    note: spec.note,
    ...run,
    results: run.results.slice(0, 2000),
    truncated: run.results.length > 2000,
  };
}

async function importRequest(req, kindId, { want = null } = {}) {
  if (!KINDS[kindId]) throw new HttpError(404, { error: 'Unknown import' });
  const mode = await importModeOf(req.user, kindId);
  if (!mode) throw DENIED(`Importing ${KINDS[kindId].label.toLowerCase()}`);
  if (want === 'direct' && mode !== 'direct') {
    throw new HttpError(403, { error: 'Your role sends imports for approval — use "Send for approval"; an Admin or Manager approves it.', requestInstead: true });
  }
  if (want === 'request' && mode !== 'request') throw new HttpError(400, { error: 'You can import this directly — no approval is needed.' });
  let upload;
  try {
    upload = await attachments.parseMultipart(req, { maxBytes: MAX_BYTES });
  } catch (err) {
    if (err.code === 'NOT_MULTIPART') throw new HttpError(400, { error: 'Send the file as a form upload.' });
    if (err.code === 'TOO_LARGE') throw new HttpError(413, { error: 'That file is over 15 MB. Split it and import in two passes.' });
    throw err;
  }
  const { file, fields = {} } = upload;
  if (!file || !file.data || !file.data.length) throw new HttpError(400, { error: 'Attach the file to import.' });
  let mapping = null;
  if (fields.mapping) {
    try { mapping = JSON.parse(fields.mapping); } catch { mapping = null; }
  }
  const prepared = prepare(file, ATS_IMPORT_SHEETS[kindId], { mapping, sheet: fields.sheet });
  return {
    prepared, filename: file.filename, fields, file, mapping, mode,
    updateExisting: String(fields.updateExisting || '') === 'true',
  };
}

router.post('/import/:kind/check', guarded(async (req, res) => {
  const kindId = req.params.kind;
  const { prepared, filename, mode, updateExisting } = await importRequest(req, kindId);
  const run = await runImport(req, kindId, prepared, { dry: true, updateExisting });
  return res.json({ ...reportOf(kindId, prepared, run, filename), importMode: mode, updateExisting });
}));

// The rows with errors as a file (step 3 of the import: "error rows
// downloadable"). Same upload as /check; writes nothing.
router.post('/import/:kind/errors', guarded(async (req, res) => {
  const kindId = req.params.kind;
  const { prepared, updateExisting } = await importRequest(req, kindId);
  const run = await runImport(req, kindId, prepared, { dry: true, updateExisting });
  const out = errorRowsFile(prepared, run);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="teamlink-${kindId}-rows-with-errors.xlsx"`);
  res.setHeader('X-Error-Rows', String(out.count));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Error-Rows');
  return res.send(out.buffer);
}));

// One committed import: dry run first, then the real run as a BATCH.
async function commitImport(req, kindId, prepared, filename, { updateExisting, partial, requestId = null, requestedBy = null }) {
  // CHECK FIRST, ALWAYS — the same rule as Data Import: a file with errors
  // writes nothing unless the user chose "import the valid rows, skip the rest".
  const dryRun = await runImport(req, kindId, prepared, { dry: true, updateExisting });
  if (!dryRun.ok && !partial) {
    throw new HttpError(400, {
      error: `${dryRun.totals.errorRows || dryRun.totals.error} row${(dryRun.totals.errorRows || dryRun.totals.error) === 1 ? '' : 's'} need fixing before anything is imported.`,
      report: reportOf(kindId, prepared, dryRun, filename),
    });
  }
  let run;
  const { batch } = await batches.runInBatch({
    kind: kindId, label: KINDS[kindId].label, module: MODULE_OF_KIND[kindId], file: filename, user: req.user, requestId,
    get counts() { return run ? run.totals : null; },
  }, async () => { run = await runImport(req, kindId, prepared, { dry: false, updateExisting }); return run; });
  const t = run.totals;
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name,
    action: `ATS import — ${KINDS[kindId].label}: ${t.create} created, ${t.update} updated, ${t.duplicate} duplicate(s), ${t.skip} skipped, ${t.error} error(s)${requestedBy ? ` (request by ${requestedBy})` : ''}`,
    entity: 'AtsImport',
    entityId: kindId,
    toValue: JSON.stringify({ file: filename, sheet: prepared.sheet, ...t, batchId: batch ? batch.id : null, scope: scopeLabel(req.user, 'ats') }),
  });
  return { run, batch };
}

router.post('/import/:kind/commit', guarded(async (req, res) => {
  const kindId = req.params.kind;
  const { prepared, filename, fields, updateExisting } = await importRequest(req, kindId, { want: 'direct' });
  const partial = String(fields.partial || req.query.partial || '') === 'true';
  const { run, batch } = await commitImport(req, kindId, prepared, filename, { updateExisting, partial });
  return res.json({ ...reportOf(kindId, prepared, run, filename), committed: true, batch });
}));

// ---- IMPORT REQUESTS (BDE: "client / job requests") ---------------------------
// The file is checked under the REQUESTER's scope and kept (private folder);
// an AuditLog row (entity 'AtsImportRequest', Pending) is the request. An
// Admin / Super Admin / Manager approves it: only the rows that passed for
// the requester are imported, as one batch (undoable), and the requester is
// told. Nothing is written before that.
const REQUEST_ENTITY = 'AtsImportRequest';
const TEST_RE = /zztest|example\.test/i;
const isTestUser = (u) => !!u && TEST_RE.test(`${u.name || ''} ${u.email || ''}`);

async function approversFor(actor) {
  const rows = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } }] },
    select: { id: true, name: true, email: true },
  });
  // A test requester is only ever routed to test approvers; a real one never to them.
  return rows.filter((u) => u.id !== actor.id && isTestUser(u) === isTestUser(actor));
}

function requestRowView(row) {
  let p = {};
  try { p = JSON.parse(row.toValue || '{}'); } catch { p = {}; }
  return {
    id: row.id,
    kind: row.entityId,
    label: p.label || row.entityId,
    file: row.fromValue,
    status: row.approvalStatus,
    requestedBy: row.actorName,
    requestedById: row.userId,
    requestedAt: row.createdAt,
    decidedBy: row.approvedByName,
    decidedAt: row.approvedAt,
    note: row.reason,
    totals: p.totals || null,
    updateExisting: !!p.updateExisting,
    batchId: p.batchId || null,
  };
}

router.post('/import/:kind/request', guarded(async (req, res) => {
  const kindId = req.params.kind;
  const {
    prepared, filename, file, mapping, fields, updateExisting,
  } = await importRequest(req, kindId, { want: 'request' });
  const run = await runImport(req, kindId, prepared, { dry: true, updateExisting });
  const okRows = run.results.filter((r) => ['create', 'update'].includes(r.action)).map((r) => r.row);
  if (!okRows.length) {
    return res.status(422).json({ error: 'Nothing in this file would be added or changed — no request was sent.', report: reportOf(kindId, prepared, run, filename) });
  }
  const fileId = ioStore.newId('r-');
  ioStore.writeBin('requests', `${fileId}.bin`, file.data);
  const row = await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      actorName: req.user.name || req.user.email,
      action: `Import request — ${KINDS[kindId].label}`,
      entity: REQUEST_ENTITY,
      entityId: kindId,
      fromValue: filename,
      toValue: JSON.stringify({
        label: KINDS[kindId].label, fileId, fileName: filename, mapping, sheet: prepared.sheet, okRows, updateExisting, totals: run.totals,
      }),
      approvalStatus: 'Pending',
      reason: fields.note ? String(fields.note).slice(0, 500) : null,
    },
  });
  const approvers = await approversFor(req.user);
  await Promise.all(approvers.map((u) => pushNotification({
    userId: u.id,
    title: `Import request waiting — ${KINDS[kindId].label}`,
    message: `${req.user.name || 'A BDE'} asked to import ${okRows.length} row(s) of ${KINDS[kindId].label.toLowerCase()} (${filename}). Open the screen → History (Approvals & history) to approve or reject.`,
  }).catch(() => null)));
  return res.status(201).json({
    request: requestRowView(row),
    report: reportOf(kindId, prepared, run, filename),
    message: 'Sent for approval. Nothing is imported until an Admin or Manager approves it.',
  });
}));

router.get('/import/requests', guarded(async (req, res) => {
  const approver = mayApproveImport(req.user);
  const where = { entity: REQUEST_ENTITY };
  if (!approver) where.userId = req.user.id;
  else if (isTestUser(req.user)) where.actorName = { contains: 'ZZTEST' };
  if (req.query.status) where.approvalStatus = String(req.query.status);
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ approver, requests: rows.map(requestRowView) });
}));

router.post('/import/requests/:id/approve', express.json(), guarded(async (req, res) => {
  if (!mayApproveImport(req.user)) throw new HttpError(403, { error: 'Only an Admin, Super Admin or Manager approves an import request.' });
  const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
  if (!row || row.entity !== REQUEST_ENTITY) throw new HttpError(404, { error: 'Import request not found.' });
  if (row.userId === req.user.id) throw new HttpError(403, { error: 'You cannot approve your own import request.' });
  if (row.approvalStatus !== 'Pending') throw new HttpError(409, { error: `This request is already ${String(row.approvalStatus).toLowerCase()}.` });
  const kindId = row.entityId;
  if (!KINDS[kindId]) throw new HttpError(400, { error: 'That import no longer exists.' });
  let p = {};
  try { p = JSON.parse(row.toValue || '{}'); } catch { p = {}; }
  const buf = ioStore.readBin('requests', `${p.fileId}.bin`);
  if (!buf) throw new HttpError(410, { error: 'The file of this request is no longer on the server — ask for it to be sent again.' });
  // Claim it first, so two approvers pressing at once import it once.
  const claimed = await prisma.auditLog.updateMany({ where: { id: row.id, approvalStatus: 'Pending' }, data: { approvalStatus: 'Approving' } });
  if (!claimed.count) throw new HttpError(409, { error: 'Somebody else is deciding this request.' });
  try {
    const prepared = prepare({ data: buf, filename: p.fileName }, ATS_IMPORT_SHEETS[kindId], {
      mapping: p.mapping || null, sheet: p.sheet, onlyRows: new Set(p.okRows || []),
    });
    const { run, batch } = await commitImport(req, kindId, prepared, p.fileName, {
      updateExisting: !!p.updateExisting, partial: true, requestId: row.id, requestedBy: row.actorName,
    });
    await prisma.auditLog.update({
      where: { id: row.id },
      data: {
        approvalStatus: 'Approved', approvedByName: req.user.name || req.user.email, approvedAt: new Date(),
        toValue: JSON.stringify({ ...p, result: run.totals, batchId: batch ? batch.id : null }),
        reason: req.body && req.body.note ? String(req.body.note).slice(0, 500) : row.reason,
      },
    });
    ioStore.remove('requests', `${p.fileId}.bin`);
    if (row.userId) {
      await pushNotification({
        userId: row.userId,
        title: `Import approved — ${KINDS[kindId].label}`,
        message: `${req.user.name || 'An approver'} approved your import (${p.fileName}): ${run.totals.create} created, ${run.totals.update} updated${run.totals.error ? `, ${run.totals.errorRows || run.totals.error} row(s) not imported` : ''}.`,
      });
    }
    return res.json({ request: requestRowView(await prisma.auditLog.findUnique({ where: { id: row.id } })), totals: run.totals, batch });
  } catch (err) {
    await prisma.auditLog.update({ where: { id: row.id }, data: { approvalStatus: 'Pending' } }).catch(() => {});
    throw err;
  }
}));

router.post('/import/requests/:id/reject', express.json(), guarded(async (req, res) => {
  if (!mayApproveImport(req.user)) throw new HttpError(403, { error: 'Only an Admin, Super Admin or Manager rejects an import request.' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) throw new HttpError(400, { error: 'Say why it is rejected — the requester is told.' });
  const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
  if (!row || row.entity !== REQUEST_ENTITY) throw new HttpError(404, { error: 'Import request not found.' });
  if (row.approvalStatus !== 'Pending') throw new HttpError(409, { error: `This request is already ${String(row.approvalStatus).toLowerCase()}.` });
  await prisma.auditLog.update({ where: { id: row.id }, data: { approvalStatus: 'Rejected', approvedByName: req.user.name || req.user.email, approvedAt: new Date(), reason } });
  let p = {};
  try { p = JSON.parse(row.toValue || '{}'); } catch { p = {}; }
  if (p.fileId) ioStore.remove('requests', `${p.fileId}.bin`);
  if (row.userId) {
    await pushNotification({ userId: row.userId, title: `Import rejected — ${(KINDS[row.entityId] || {}).label || row.entityId}`, message: `${req.user.name || 'An approver'} rejected your import (${row.fromValue}): ${reason}` });
  }
  return res.json({ request: requestRowView(await prisma.auditLog.findUnique({ where: { id: row.id } })) });
}));

// ---- BATCHES: list + Undo import (24 h) -----------------------------------------
router.get('/import/batches', guarded(async (req, res) => {
  res.json({ batches: await batches.listBatches(req.user), undoHours: batches.UNDO_WINDOW_MS / 3600000 });
}));

router.post('/import/batches/:id/undo', guarded(async (req, res) => {
  const out = await batches.undoBatch(req.params.id, req.user);
  if (out.status !== 200) return res.status(out.status).json({ error: out.error, changed: out.changed || undefined });
  return res.json({ ...out, message: `Import undone — ${out.removed} record(s) removed, ${out.restored} restored to how they were.` });
}));

// ---- BACKGROUND EXPORT FILES ------------------------------------------------------
router.get('/export-files', guarded(async (req, res) => {
  res.json({ exports: exportJobs.listExports(req.user, { all: roleOf(req.user) === 'SUPER_ADMIN' && req.query.all === '1' }) });
}));

router.get('/export-files/:id', guarded(async (req, res) => {
  const out = exportJobs.exportFile(req.user, req.params.id, { all: roleOf(req.user) === 'SUPER_ADMIN' });
  if (out.status !== 200) return res.status(out.status).json({ error: out.error });
  const types = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' };
  res.setHeader('Content-Type', types[out.meta.format] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${out.meta.filename}"`);
  res.setHeader('X-Export-Rows', String(out.meta.rows));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows');
  return res.send(out.buf);
}));

// ---- FILTER OPTIONS WITH COUNTS ------------------------------------------------------
router.get('/facets/:module', guarded(async (req, res) => {
  const out = await facetsFor(req.params.module, req.user, req.query || {});
  if (!out) throw new HttpError(404, { error: 'No server-side filter counts for this screen.' });
  // A recruiter never sees more of a client than its name — which is all an option carries.
  return res.json(out);
}));

// ---- BULK RESUME UPLOAD (Candidates → Upload resumes button) ----------------------
// 1. /resumes/parse — one file per call (the screen sends them one by one and
//    shows progress): it is kept in the private folder under a token, read,
//    and checked for a duplicate (same phone / email as a candidate on file).
// 2. /resumes/commit — the tokens the user confirms (with any corrections to
//    name / email / phone); creates the candidates as ONE batch (Undo import),
//    optionally on one requirement's pipeline. PDFs are attached as the
//    candidate's resume document.
const RESUME_MAX = 8 * 1024 * 1024;
async function resumeGate(req) {
  const mode = await importModeOf(req.user, 'resumes');
  if (mode !== 'direct') throw DENIED('Uploading resumes');
}
function resumeDup(ix, f) {
  return [f.email, f.phone].filter(Boolean).map((v) => findCandidate(ix, v)).find((id) => id && !isDry(id)) || null;
}

router.post('/resumes/parse', guarded(async (req, res) => {
  await resumeGate(req);
  ioStore.sweep('resumes', 24 * 3600 * 1000);
  let upload;
  try { upload = await attachments.parseMultipart(req, { maxBytes: RESUME_MAX }); } catch (err) {
    if (err.code === 'TOO_LARGE') throw new HttpError(413, { error: 'That resume is over 8 MB.' });
    throw new HttpError(400, { error: 'Send the resume as a form upload.' });
  }
  const { file } = upload;
  if (!file || !file.data || !file.data.length) throw new HttpError(400, { error: 'Attach a resume.' });
  const token = ioStore.newId('cv-');
  ioStore.writeBin('resumes', `${token}.bin`, file.data);
  ioStore.writeJson('resumes', token, { userId: req.user.id, fileName: file.filename, contentType: file.contentType, at: new Date().toISOString() });
  const parsed = await parseResume(file.data, file.filename);
  let duplicate = null;
  if (!parsed.error) {
    const ix = await buildIndex();
    const dupId = resumeDup(ix, parsed.fields);
    if (dupId) {
      const c = await prisma.candidate.findUnique({ where: { id: dupId }, select: { id: true, name: true } });
      duplicate = c ? { id: c.id, name: c.name } : null;
    }
  }
  const f = parsed.fields || {};
  const missing = !parsed.error && !f.email && !f.phone ? 'No email or phone found in the resume — add one below, or the row is skipped.' : null;
  return res.json({
    token, fileName: file.filename, kind: parsed.kind || null, fields: f, error: parsed.error || null, duplicate, warning: missing,
  });
}));

router.post('/resumes/commit', express.text({ type: () => true, limit: '2mb' }), guarded(async (req, res) => {
  await resumeGate(req);
  let b = {};
  try { b = JSON.parse(req.body || '{}'); } catch { throw new HttpError(400, { error: 'The request could not be read.' }); }
  const items = Array.isArray(b.items) ? b.items.slice(0, 500) : [];
  if (!items.length) throw new HttpError(400, { error: 'Nothing to import.' });
  const reqCode = String(b.requirementCode || '').trim();
  const ix = await buildIndex();
  const s = scopeOf(req.user);
  const ctx = { user: req.user, ix, global: s.global, reqCache: new Map(), dry: false };
  let requirement = null;
  if (reqCode) {
    if (!(await can(req.user, 'ats', 'candidates', 'Applications', 'create'))) throw new HttpError(403, { error: 'Adding to a pipeline needs the Applications permission — leave the requirement blank.' });
    try { requirement = await requirementByCode(ctx, reqCode); assertRequirementInScope(ctx, requirement, reqCode); } catch (e) { throw new HttpError(400, { error: e.message }); }
  }
  const results = [];
  const storedFiles = [];
  const { batch } = await batches.runInBatch({
    kind: 'resumes', label: 'Resumes', module: 'candidates', file: `${items.length} resume file(s)`, user: req.user,
  }, async () => {
    const seen = new Set();
    for (const it of items) {
      const meta = ioStore.readJson('resumes', String(it.token || ''));
      if (!meta || meta.userId !== req.user.id) { results.push({ token: it.token, action: 'error', message: 'That upload is gone — upload the resume again.' }); continue; }
      if (it.skip) { results.push({ token: it.token, fileName: meta.fileName, action: 'skip', message: 'left out' }); continue; }
      const buf = ioStore.readBin('resumes', `${it.token}.bin`);
      // eslint-disable-next-line no-await-in-loop
      const parsed = buf ? await parseResume(buf, meta.fileName) : { error: 'file missing' };
      const f = { ...(parsed.fields || {}) };
      ['name', 'email', 'phone'].forEach((k) => { if (typeof it[k] === 'string' && it[k].trim()) f[k] = it[k].trim(); });
      if (f.phone) f.phone = String(f.phone).replace(/[^\d+]/g, '');
      if (!f.name) { results.push({ token: it.token, fileName: meta.fileName, action: 'error', message: 'No name — type the candidate\'s name.' }); continue; }
      if (!f.email && !f.phone) { results.push({ token: it.token, fileName: meta.fileName, action: 'error', message: 'No email or phone — one is needed to tell candidates apart.' }); continue; }
      const key = (f.email || f.phone).toLowerCase();
      if (seen.has(key)) { results.push({ token: it.token, fileName: meta.fileName, action: 'duplicate', message: 'the same person is in an earlier file of this upload' }); continue; }
      seen.add(key);
      const dupId = resumeDup(ix, f);
      if (dupId && !b.updateExisting) { results.push({ token: it.token, fileName: meta.fileName, action: 'duplicate', message: 'a candidate with this phone / email is already on file — skipped, nothing overwritten' }); continue; }
      const notes = [];
      const note = (m) => notes.push(m);
      try {
        if (dupId && !s.global && !(await prisma.candidate.count({ where: { AND: [{ id: dupId }, candidateWhere(req.user)] } }))) {
          throw new Error('a candidate with this phone / email is on file but outside your scope — not updated');
        }
        const data = {
          name: f.name, email: f.email || null, phone: f.phone || null, location: f.location || null,
          experienceYears: typeof f.experienceYears === 'number' ? f.experienceYears : null,
          noticePeriod: f.noticePeriod || null, currentSalary: f.currentSalary || null, expectedSalary: f.expectedSalary || null,
          skills: f.skills || null, source: dupId ? null : 'Resume upload', resumeName: meta.fileName,
        };
        // eslint-disable-next-line no-await-in-loop
        const action = await HANDLERS.candidate({ data, ix, dry: false, row: 0, note });
        const candidateId = findCandidate(ix, f.email || f.phone);
        if (requirement && candidateId && !(await prisma.application.count({ where: { candidateId, requirementId: requirement.id } }))) {
          // eslint-disable-next-line no-await-in-loop
          await HANDLERS.application({ data: { _candidate: f.email || f.phone, _requirement: reqCode, stage: 'NEW', source: 'Resume upload' }, ix, dry: false, row: 0, note });
          note(`added to ${reqCode}`);
        }
        // A PDF resume is kept as the candidate's resume document (as the
        // candidate portal keeps one). Other formats keep their file name.
        if (candidateId && parsed.kind === 'pdf') {
          try {
            const stored = attachments.store({ filename: meta.fileName, contentType: 'application/pdf', data: buf });
            storedFiles.push(stored.billFile);
            // eslint-disable-next-line no-await-in-loop
            await prisma.candidateDocument.create({
              data: {
                candidateId, docType: 'Resume', name: stored.billName, note: `file:${stored.billFile}`, internalOnly: false,
                uploadedByUserId: req.user.id, uploadedByName: req.user.name,
              },
            });
          } catch { note('resume file not attached'); }
        }
        results.push({ token: it.token, fileName: meta.fileName, action: action === 'updated' ? 'update' : 'create', candidateId, message: notes.join(' · ') });
      } catch (e) {
        results.push({ token: it.token, fileName: meta.fileName, action: 'error', message: e.message });
      }
    }
  });
  if (batch && storedFiles.length) storedFiles.forEach((f) => batches.addFileToBatch(batch.id, f));
  items.forEach((it) => { ioStore.remove('resumes', `${it.token}.bin`); ioStore.remove('resumes', `${it.token}.json`); });
  const count = (a) => results.filter((r) => r.action === a).length;
  const totals = {
    rows: results.length, create: count('create'), update: count('update'), duplicate: count('duplicate'), error: count('error'), skip: count('skip'),
  };
  await logAudit({
    userId: req.user.id, actorName: req.user.name,
    action: `ATS import — Resumes: ${totals.create} created, ${totals.update} updated, ${totals.duplicate} duplicate(s), ${totals.error} error(s)`,
    entity: 'AtsImport', entityId: 'resumes',
    toValue: JSON.stringify({ ...totals, batchId: batch ? batch.id : null, requirement: reqCode || null }),
  });
  return res.json({ totals, results, batch });
}));

router.get('/import/:kind/template', guarded(async (req, res) => {
  const kindId = req.params.kind;
  if (!KINDS[kindId]) throw new HttpError(404, { error: 'Unknown import' });
  if (!(await mayImport(req.user, kindId))) throw DENIED(`Importing ${KINDS[kindId].label.toLowerCase()}`);
  const spec = ATS_IMPORT_SHEETS[kindId];
  // Values on file for the free-text columns that must match a record.
  const known = {};
  if (spec.columns.some((c) => c.h === 'Department')) {
    known.Department = (await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map((d) => d.name);
  }
  if (spec.columns.some((c) => c.h === 'Owning Department')) {
    known['Owning Department'] = known.Department
      || (await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map((d) => d.name);
  }
  if (spec.columns.some((c) => c.h === 'Source')) {
    const { CANDIDATE_SOURCES } = require('../utils/atsVocab');
    if (Array.isArray(CANDIDATE_SOURCES)) known.Source = CANDIDATE_SOURCES;
  }
  const buffer = await buildSheetTemplate(spec, { examples: KINDS[kindId].examples, known });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="teamlink-${kindId}-import-template.xlsx"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  return res.send(Buffer.from(buffer));
}));

// What this login may do, for the screens' buttons (the routes above check
// again, always).
// A login with no ATS product (plain Employee, Accounts) is refused like
// every other ATS endpoint (review #3 §2 access audit).
router.get('/access', require('../middleware/auth').requireProduct('ats'), guarded(async (req, res) => {
  const exportsOut = {};
  const exportInfo = {};
  await Promise.all(Object.entries(EXPORTS).map(async ([id, def]) => {
    const access = await ioAccessFor(req.user, id);
    const permitted = await can(req.user, 'ats', def.perm[0], def.perm[1], 'export');
    exportsOut[id] = !!access.export && (permitted || SPEC_EXPORT_ROLES.includes(access.role));
    exportInfo[id] = { sensitive: !!access.sensitive, revenue: !!access.revenue, scope: access.exportScope };
  }));
  const importsOut = {};
  const importModes = {};
  await Promise.all([...Object.keys(KINDS), 'resumes'].map(async (id) => {
    importModes[id] = await importModeOf(req.user, id);
    importsOut[id] = !!importModes[id];
  }));
  const role = roleOf(req.user);
  const kinds = {};
  Object.entries(KINDS).forEach(([id, k]) => {
    const spec = ATS_IMPORT_SHEETS[id];
    kinds[id] = {
      label: k.label,
      mode: k.mode,
      note: spec.note,
      columns: spec.columns.filter((c) => !c.legacy).map((c) => ({ header: c.h, required: !!c.req })),
    };
  });
  kinds.resumes = { label: 'Resumes (PDF / DOCX)', mode: 'create', note: 'Several resume files at once; each becomes a candidate. Duplicates (same phone / email) are skipped unless you choose to update them.', columns: [] };
  return res.json({
    exports: exportsOut,
    exportInfo,
    imports: importsOut,
    importModes,
    kinds,
    modules: { ...MODULE_KINDS, candidates: [...(MODULE_KINDS.candidates || []), 'resumes'] },
    viewer: { role, admin: ['SUPER_ADMIN', 'ADMIN'].includes(role), approver: mayApproveImport(req.user) },
    undoHours: batches.UNDO_WINDOW_MS / 3600000,
    backgroundRows: exportJobs.threshold(),
  });
}));

module.exports = router;
module.exports.EXPORTS = EXPORTS;
module.exports.KINDS = KINDS;
