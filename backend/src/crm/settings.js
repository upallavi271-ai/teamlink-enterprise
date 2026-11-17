// ---------------------------------------------------------------------------
// CRM SETTINGS (2026-11-02, the full CRM): the pick lists and numbers the BDE TL / Admin may change - lead sources, lost
// reasons, the probability of each stage, after how many days without a call / meeting a deal counts as "going cold", and
// the proposal defaults. Kept as one JSON row in AppSetting (key crm.settings); read with a 15 s cache.
// The stages themselves stay fixed (every report and the board are built on them).
// THE SALES TEAM (founder 2026-11-02: "oka sales team kosam design chesinattu design cheyyu" - a CRM for the sales team, not
// for one job title): salesTeam = [{ userId, name, role: 'rep' | 'manager' }]. The BDEs and the BDE TLs are on the team
// without being listed; an Admin / Sales manager adds anybody else here (a sales executive, a key-account manager ...).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'crm.settings';
const STAGES = ['Prospecting', 'Contacted', 'Meeting', 'Requirement discussed', 'Proposal sent', 'Negotiation', 'Won', 'Lost'];
const DEFAULTS = {
  sources: ['LinkedIn', 'Referral', 'Cold call', 'Website', 'Job post signal', 'Email campaign', 'WhatsApp', 'Event', 'Existing client', 'Other'],
  lostReasons: ['Price / fee too high', 'Chose another vendor', 'Hiring on hold', 'No response', 'Hiring in-house', 'Not a fit', 'Other'],
  stageProbability: { Prospecting: 10, Contacted: 20, Meeting: 40, 'Requirement discussed': 50, 'Proposal sent': 60, Negotiation: 80, Won: 100, Lost: 0 },
  staleDays: 14,
  proposalValidityDays: 30,
  // A deal discount above this % needs a Sales manager's approval before the deal can be won (founder 2026-11-13).
  discountApprovalLimit: 10,
  salesTeam: [],
  // the company's own details for CRM invoices (crm/invoices.js)
  invoiceFrom: { name: 'TeamLink Consultants', address: '', gstin: '', state: '', email: '', phone: '', bank: '', terms: 'Payment within 15 days of the invoice date.' },
  invoiceTaxPercent: 18,
  invoiceDueDays: 15,
  // GST on CRM invoices (2026-11-17, crm/money.js): the SAC printed on each line (998314 = IT design and development services - to be
  // confirmed with the CA), and the invoice number format: '' keeps INV-0001; e.g. 'INV/{FY}/{0000}' numbers per Indian financial year
  invoiceSac: '998314',
  invoiceNumberFormat: '',
  overdueInvoiceAlert: true, // an invoice past its due date with money still owed: a bell to the owner and the Sales managers at 10:00, every 3 days
  lostRecheck: true, // a deal marked Lost gets a follow-up for its owner 90 days later, "Re-check <account>: lost because <reason>"
  // the meeting link a lead books a call on (crm/booking.js), and the hours a slot may be booked in
  meetingLink: '',
  bookingHours: { from: '10:00', to: '18:00', minutes: 30 },
  // the stages of a LEAD (crm/sales.js); a deal keeps its own stages, above. Won and Lost always stay, last.
  leadStages: [{ name: 'New', color: '#64748b' }, { name: 'Contacted', color: '#2563eb' }, { name: 'Qualified', color: '#7c3aed' }, { name: 'Proposal', color: '#d97706' }, { name: 'Negotiation', color: '#ea580c' }, { name: 'Won', color: '#16a34a' }, { name: 'Lost', color: '#dc2626' }],
  defaultRemindBefore: 15,
  overdueAlertManagers: true, // a follow-up a day late is told to the Sales managers once (crm/sales.js escalateOverdue)
  autoFirstFollowUp: true, // a new lead with an owner gets "First call" as a follow-up two hours on (crm/sales.js firstFollowUp)
  autoAssignManual: false, // a "+ Lead" a Sales manager / Admin saves with the owner left empty goes to the next salesperson in turn (crm/sales.js takeTurn)
};

// THE CRM IS ITS OWN MODULE (founder 2026-11-11: "crm completely separate, dhenitho combine cheyyoddhu"): who may open it and what they
// may do comes from this list only - not from ATS roles. A member is a Sales manager (everything, and gives records to others), a
// Salesperson (their own records; may be allowed to see everyone's) or a Viewer (reads everything, changes nothing). Each member's
// rights can be changed one by one. Super Admin / Admin always have everything.
const ROLES = ['manager', 'rep', 'viewer'];
const RIGHTS = ['create', 'edit', 'delete', 'import', 'export', 'reports'];
const ROLE_RIGHTS = {
  manager: { create: true, edit: true, delete: true, import: true, export: true, reports: true },
  rep: { create: true, edit: true, delete: false, import: false, export: false, reports: false },
  viewer: { create: false, edit: false, delete: false, import: false, export: true, reports: true },
};
function cleanMember(m) {
  const role = ROLES.includes(m && m.role) ? m.role : 'rep';
  const given = (m && m.rights) || {};
  const rights = {};
  RIGHTS.forEach((k) => { rights[k] = role === 'manager' ? true : (typeof given[k] === 'boolean' ? given[k] : ROLE_RIGHTS[role][k]); });
  if (role === 'viewer') { rights.create = false; rights.edit = false; rights.delete = false; rights.import = false; }
  return { userId: String((m && m.userId) || '').slice(0, 60), name: String((m && m.name) || '').slice(0, 120), role, seeAll: role !== 'rep' || (m && m.seeAll === true), rights };
}

let cached = null; let cachedAt = 0;
// WHO MAY OPEN THE CRM, ONE MORE TIME (founder 2026-11-14: "bde ki crm kanipinchakudadhu - only Super Admin (Vasu), HR Purna and the developer
// logins, evariki kanipinchakudadhu"). The list the seeding below filled with every BDE, BDE TL, manager and record owner is emptied ONCE. Who
// keeps the CRM: Super Admin / Admin logins (by their role - they never need a place on the list), and the HR approver(s) of the agreement
// workflow (Purna Sir, employee TL309 - read from that setting, so it follows if the approver is changed), who join as Sales manager. After
// this the list is the Admin's alone to edit in CRM settings; nothing puts anybody back.
async function hrApproverMembers() {
  let codes = ['TL309'];
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'agreementWorkflow' } });
    const o = row ? JSON.parse(row.value) : {};
    if (Array.isArray(o.approvers) && o.approvers.length) codes = o.approvers.map((c) => String(c || '').trim()).filter(Boolean);
  } catch { /* the default approver */ }
  const wanted = [...new Set(codes.flatMap((c) => [c, c.toUpperCase()]))];
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: wanted } }, select: { userId: true } }).catch(() => []);
  const ids = emps.map((e) => e.userId).filter(Boolean);
  if (!ids.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, clientId: true, candidateId: true } }).catch(() => []);
  return users
    .filter((u) => !u.clientId && !u.candidateId && !/inactive|disabled|deleted|left|relieved|exit|suspended/i.test(String(u.status || '')))
    .map((u) => cleanMember({ userId: u.id, name: u.name, role: 'manager' }));
}
// ONCE, when the CRM stops reading ATS roles: everybody who could open it before is put on the list as they were (a BDE a
// Salesperson, a BDE TL a Sales manager, an ATS Manager / Assistant Manager a Viewer, anyone who owns CRM records a Salesperson),
// so nobody loses the CRM on the day of the change. After that only this list counts.
async function seedTeam(raw) {
  const team = Array.isArray(raw.salesTeam) ? raw.salesTeam.map(cleanMember) : [];
  const have = new Set(team.map((m) => m.userId));
  const users = await prisma.user.findMany({ select: { id: true, name: true, role: true, atsRole: true, atsDepartment: true, status: true, clientId: true, candidateId: true } }).catch(() => []);
  const owners = new Set();
  try {
    const DB = require('./schema'); // eslint-disable-line global-require
    await DB.ensure();
    for (const t of ['CrmLead', 'CrmDeal', 'CrmAccount']) (await DB.all(`SELECT DISTINCT "ownerId" FROM "${t}" WHERE "ownerId" IS NOT NULL`)).forEach((x) => owners.add(x.ownerId)); // eslint-disable-line no-await-in-loop
  } catch { /* no CRM tables yet */ }
  users.forEach((u) => {
    if (have.has(u.id) || u.clientId || u.candidateId || ['SUPER_ADMIN', 'ADMIN'].includes(u.role)) return;
    if (/inactive|disabled|deleted|left|relieved|exit|suspended/i.test(String(u.status || ''))) return;
    let role = null;
    if (u.atsRole === 'TL' && String(u.atsDepartment || '').toUpperCase() === 'BDE') role = 'manager';
    else if (u.atsRole === 'BDE' || u.role === 'BDE' || owners.has(u.id)) role = 'rep';
    else if (['MANAGER', 'ASSISTANT_MANAGER'].includes(u.role) || ['MANAGER', 'ASSISTANT_MANAGER'].includes(u.atsRole)) role = 'viewer';
    if (role) { team.push(cleanMember({ userId: u.id, name: u.name, role })); have.add(u.id); }
  });
  return team;
}
// An invoice number format (crm/money.js formatInvoiceCode): letters, digits and / - _ . # spaces, with exactly one running number {0000}
// (1 to 8 zeros = its width) and, if wanted, {FY} (2026-27) or {FY2} (26-27); the number starts again at 1 each financial year when {FY} / {FY2} is in it.
function validInvoiceFormat(fmt) {
  const s = String(fmt || '');
  if (s.length < 3 || s.length > 40 || !/^[A-Za-z0-9/\-_.# {}]+$/.test(s)) return false;
  const tokens = s.match(/\{[^}]*\}/g) || [];
  if (tokens.some((t) => !/^\{(0{1,8}|FY|FY2)\}$/.test(t))) return false;
  if (tokens.filter((t) => /^\{0+\}$/.test(t)).length !== 1) return false;
  return !/[{}]/.test(s.replace(/\{(0{1,8}|FY|FY2)\}/g, ''));
}
const cleanList = (v, fallback) => {
  const out = [...new Set((Array.isArray(v) ? v : String(v || '').split(/\n|,/)).map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
  return out.length ? out : fallback;
};
function cleanStages(v) {
  const fixed = DEFAULTS.leadStages.filter((x) => ['Won', 'Lost'].includes(x.name));
  const seen = new Set(['won', 'lost']);
  const given = Array.isArray(v) ? v : [];
  const open = given.map((x) => ({ name: String((x && x.name) || '').trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(String(x && x.color)) ? x.color : '#64748b' }))
    .filter((x) => x.name && !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase())).slice(0, 12);
  const ends = fixed.map((f) => ({ ...f, color: ((given.find((x) => x && x.name === f.name) || {}).color && /^#[0-9a-f]{6}$/i.test(given.find((x) => x && x.name === f.name).color)) ? given.find((x) => x && x.name === f.name).color : f.color }));
  return [...(open.length ? open : DEFAULTS.leadStages.filter((x) => !['Won', 'Lost'].includes(x.name))), ...ends];
}
function normalize(raw = {}) {
  const prob = {};
  STAGES.forEach((s) => {
    const n = Math.round(Number((raw.stageProbability || {})[s]));
    prob[s] = s === 'Won' ? 100 : s === 'Lost' ? 0 : (Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULTS.stageProbability[s]);
  });
  const sources = cleanList(raw.sources, DEFAULTS.sources);
  if (!sources.includes('Other')) sources.push('Other');
  if (!sources.includes('Website')) sources.push('Website'); // the website form's leads
  const lostReasons = cleanList(raw.lostReasons, DEFAULTS.lostReasons);
  if (!lostReasons.includes('Other')) lostReasons.push('Other');
  const stale = Math.round(Number(raw.staleDays));
  const valid = Math.round(Number(raw.proposalValidityDays));
  const discLimit = Number(raw.discountApprovalLimit);
  const seen = new Set();
  const salesTeam = (Array.isArray(raw.salesTeam) ? raw.salesTeam : []).map(cleanMember)
    .filter((m) => m.userId && !seen.has(m.userId) && seen.add(m.userId)).slice(0, 300);
  const f = raw.invoiceFrom || {};
  const s60 = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
  const invoiceFrom = { name: s60(f.name, 120) || DEFAULTS.invoiceFrom.name, address: s60(f.address, 400), gstin: s60(f.gstin, 20).toUpperCase(), state: s60(f.state, 60), email: s60(f.email, 120), phone: s60(f.phone, 30), bank: s60(f.bank, 400), terms: s60(f.terms, 600) || DEFAULTS.invoiceFrom.terms };
  const sac = String(raw.invoiceSac == null ? DEFAULTS.invoiceSac : raw.invoiceSac).trim();
  const fmt = String(raw.invoiceNumberFormat == null ? '' : raw.invoiceNumberFormat).trim();
  const flag = (v, d) => (v === undefined ? d : v !== false && v !== 0 && v !== 'false');
  const tax = Number(raw.invoiceTaxPercent); const due = Math.round(Number(raw.invoiceDueDays));
  const bh = raw.bookingHours || {}; const HM = /^\d{2}:\d{2}$/;
  const bookingHours = { from: HM.test(bh.from) ? bh.from : DEFAULTS.bookingHours.from, to: HM.test(bh.to) ? bh.to : DEFAULTS.bookingHours.to, minutes: [15, 30, 45, 60].includes(Number(bh.minutes)) ? Number(bh.minutes) : 30 };
  return {
    sources, lostReasons, stageProbability: prob, salesTeam, leadStages: cleanStages(raw.leadStages), teamSeeded: raw.teamSeeded === true, accessSet: raw.accessSet === true,
    invoiceFrom, invoiceTaxPercent: Number.isFinite(tax) && tax >= 0 && tax <= 50 ? tax : DEFAULTS.invoiceTaxPercent, invoiceDueDays: Number.isFinite(due) && due >= 0 && due <= 180 ? due : DEFAULTS.invoiceDueDays,
    invoiceSac: /^\d{4,8}$/.test(sac) ? sac : DEFAULTS.invoiceSac,
    invoiceNumberFormat: !fmt || validInvoiceFormat(fmt) ? fmt : '',
    overdueInvoiceAlert: flag(raw.overdueInvoiceAlert, true),
    lostRecheck: flag(raw.lostRecheck, true),
    meetingLink: /^https?:\/\//i.test(String(raw.meetingLink || '').trim()) ? String(raw.meetingLink).trim().slice(0, 300) : '', bookingHours,
    defaultRemindBefore: [0, 15, 60, 1440].includes(Number(raw.defaultRemindBefore)) ? Number(raw.defaultRemindBefore) : DEFAULTS.defaultRemindBefore,
    staleDays: Number.isFinite(stale) && stale >= 1 && stale <= 365 ? stale : DEFAULTS.staleDays,
    overdueAlertManagers: raw.overdueAlertManagers !== false && raw.overdueAlertManagers !== 0 && raw.overdueAlertManagers !== 'false',
    autoFirstFollowUp: raw.autoFirstFollowUp !== false && raw.autoFirstFollowUp !== 0 && raw.autoFirstFollowUp !== 'false',
    autoAssignManual: raw.autoAssignManual === true || raw.autoAssignManual === 'true',
    proposalValidityDays: Number.isFinite(valid) && valid >= 1 && valid <= 365 ? valid : DEFAULTS.proposalValidityDays,
    discountApprovalLimit: Number.isFinite(discLimit) && discLimit >= 0 && discLimit <= 100 ? discLimit : DEFAULTS.discountApprovalLimit,
  };
}

async function load({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 15000) return cached;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let raw = {};
  try { raw = row ? JSON.parse(row.value) : {}; } catch { raw = {}; }
  if (raw.teamSeeded !== true) {
    raw.salesTeam = await seedTeam(raw);
    raw.teamSeeded = true;
    const norm = normalize(raw);
    await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(norm) }, update: { value: JSON.stringify(norm) } }).catch(() => {});
  }
  // the one-time narrowing of who may open the CRM (see hrApproverMembers): done at the first read after this change, never again
  if (raw.accessSet !== true) {
    raw.salesTeam = await hrApproverMembers();
    raw.accessSet = true;
    const norm = normalize(raw);
    await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(norm) }, update: { value: JSON.stringify(norm) } }).catch(() => {});
  }
  cached = normalize(raw); cachedAt = Date.now();
  return cached;
}

async function save(body) {
  const next = normalize({ ...(await load({ fresh: true })), ...(body || {}), teamSeeded: true });
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  cached = next; cachedAt = Date.now();
  return next;
}

// The team role of a login from the last read settings (sync, for the access checks; the CRM routes read the settings
// first, so this is never older than 15 s there): 'manager' | 'rep' | null.
function teamRole(userId) {
  const m = cached && cached.salesTeam.find((x) => x.userId === userId);
  return m ? m.role : null;
}
const member = (userId) => (cached && cached.salesTeam.find((x) => x.userId === userId)) || null;
// the last read settings, for a sync reader (crm/service.js invoiceOut works the GST split out while it shapes a row); the defaults before the first read
const current = () => cached || normalize({});

module.exports = { load, save, teamRole, member, current, cleanMember, validInvoiceFormat, STAGES, DEFAULTS, ROLES, RIGHTS, ROLE_RIGHTS };
