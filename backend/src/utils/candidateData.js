// ---------------------------------------------------------------------------
// CANDIDATE DATA (founder audit 2026-11-18, round 3): the parts of a candidate profile that were missing.
//
//   settings()              AppSetting "candidate-data": autoCreateStaffUploads (default OFF), staleDays (default 180)
//   extraOf / saveExtra     address, native place, marital status, languages known, father's name, preferred locations (a list)
//   addEvent / eventsOf     one timeline of data events: a salary / experience change WITH its reason, a reapply, "confirmed current"
//   CHANGE_REASONS          the short pick list behind "why is the salary / experience changing"
//   staleOf / confirmCurrent  profiles whose CTC / phone / resume are older than N days; "confirmed current" resets the clock
//   applicationHistory      every earlier application with its rejection reason + previous joinings (the rejoin / reapply timeline)
//   idDocRule               who may open an ID document (Aadhaar / PAN / Passport)
//
// Tables are created on first use (raw SQL, no migration): CandidateExtra, CandidateEvent.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "CandidateExtra" ("candidateId" TEXT PRIMARY KEY, "address" TEXT, "nativePlace" TEXT, "maritalStatus" TEXT, "languages" TEXT,
    "fatherName" TEXT, "preferredLocations" TEXT, "confirmedCurrentAt" TEXT, "confirmedCurrentBy" TEXT, "updatedAt" TEXT, "updatedByName" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CandidateEvent" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "applicationId" TEXT, "kind" TEXT NOT NULL, "title" TEXT NOT NULL,
    "detail" TEXT, "reason" TEXT, "at" TEXT NOT NULL, "byId" TEXT, "byName" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CandidateEvent_cand" ON "CandidateEvent" ("candidateId","at")',
];
function ensure() {
  if (!READY) {
    READY = (async () => { for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); })().catch((e) => { READY = null; throw e; }); // eslint-disable-line no-await-in-loop
  }
  return READY;
}
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const clean = (v, max = 200) => {
  const s = String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// --- settings -------------------------------------------------------------------------------------------------
const KEY = 'candidate-data';
const DEFAULTS = { autoCreateStaffUploads: false, staleDays: 180 };
let SET = { at: 0, v: null };
async function settings() {
  if (SET.v && Date.now() - SET.at < 5000) return SET.v;
  let v = {};
  try {
    const r = await prisma.appSetting.findUnique({ where: { key: KEY } });
    v = r ? json(r.value, {}) : {};
  } catch { v = {}; }
  SET = { at: Date.now(), v: { autoCreateStaffUploads: v.autoCreateStaffUploads === true, staleDays: Math.min(1500, Math.max(7, Number(v.staleDays) || DEFAULTS.staleDays)) } };
  return SET.v;
}
async function saveSettings(patch, user) {
  const cur = await settings();
  const next = { ...cur };
  if (patch.autoCreateStaffUploads !== undefined) next.autoCreateStaffUploads = patch.autoCreateStaffUploads === true || patch.autoCreateStaffUploads === 'true';
  if (patch.staleDays !== undefined) {
    const d = Number(patch.staleDays);
    if (!Number.isFinite(d) || d < 7 || d > 1500) return { error: 'Stale after must be between 7 and 1500 days.' };
    next.staleDays = Math.round(d);
  }
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: KEY }, update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null }, create: { key: KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  SET = { at: 0, v: null };
  return { settings: next, old: cur };
}

// --- extra personal details ---------------------------------------------------------------------------------------
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed', 'Separated'];
async function extraOf(candidateId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateExtra" WHERE "candidateId" = ?', candidateId);
  if (!r) return { address: null, nativePlace: null, maritalStatus: null, languages: [], fatherName: null, preferredLocations: [], confirmedCurrentAt: null };
  return {
    address: r.address, nativePlace: r.nativePlace, maritalStatus: r.maritalStatus, languages: json(r.languages, []), fatherName: r.fatherName,
    preferredLocations: json(r.preferredLocations, []), confirmedCurrentAt: r.confirmedCurrentAt, confirmedCurrentBy: r.confirmedCurrentBy, updatedAt: r.updatedAt, updatedByName: r.updatedByName,
  };
}
function listOf(v, { max = 20, len = 60 } = {}) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/);
  const out = [];
  arr.forEach((x) => { const c = clean(x, len); if (c && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c); });
  return out.slice(0, max);
}
// body: any of address, nativePlace, maritalStatus, languages (list), fatherName, preferredLocations (list). Absent = untouched.
function extraInput(b) {
  const out = {};
  if (b.address !== undefined) out.address = clean(b.address, 300);
  if (b.nativePlace !== undefined) out.nativePlace = clean(b.nativePlace, 80);
  if (b.maritalStatus !== undefined) {
    const m = clean(b.maritalStatus, 20);
    if (m && !MARITAL.some((x) => x.toLowerCase() === m.toLowerCase())) return { error: `Marital status must be one of: ${MARITAL.join(', ')}.` };
    out.maritalStatus = m ? MARITAL.find((x) => x.toLowerCase() === m.toLowerCase()) : null;
  }
  if (b.fatherName !== undefined) out.fatherName = clean(b.fatherName, 80);
  if (b.languages !== undefined) out.languages = listOf(b.languages, { max: 12, len: 30 });
  if (b.preferredLocations !== undefined) out.preferredLocations = listOf(b.preferredLocations, { max: 15, len: 60 });
  return { values: out };
}
async function saveExtra(candidateId, values, user) {
  await ensure();
  const cur = await extraOf(candidateId);
  const next = { ...cur, ...values };
  await prisma.$executeRawUnsafe(`INSERT INTO "CandidateExtra" ("candidateId","address","nativePlace","maritalStatus","languages","fatherName","preferredLocations","confirmedCurrentAt","confirmedCurrentBy","updatedAt","updatedByName")
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("candidateId") DO UPDATE SET "address"=excluded."address","nativePlace"=excluded."nativePlace","maritalStatus"=excluded."maritalStatus",
    "languages"=excluded."languages","fatherName"=excluded."fatherName","preferredLocations"=excluded."preferredLocations","updatedAt"=excluded."updatedAt","updatedByName"=excluded."updatedByName"`,
  candidateId, next.address || null, next.nativePlace || null, next.maritalStatus || null, JSON.stringify(next.languages || []), next.fatherName || null,
  JSON.stringify(next.preferredLocations || []), cur.confirmedCurrentAt || null, cur.confirmedCurrentBy || null, now(), user ? user.name : null);
  // the single "Preferred location" text the matching reads follows the list (first city first)
  if (values.preferredLocations !== undefined) {
    await prisma.candidate.update({ where: { id: candidateId }, data: { preferredLocation: next.preferredLocations.length ? next.preferredLocations.join(', ') : null } }).catch(() => null);
  }
  return { before: cur, after: await extraOf(candidateId) };
}

// --- timeline of data events ------------------------------------------------------------------------------------
async function addEvent(candidateId, { kind, title, detail = null, reason = null, applicationId = null }, user) {
  await ensure();
  const id = newId();
  await prisma.$executeRawUnsafe('INSERT INTO "CandidateEvent" ("id","candidateId","applicationId","kind","title","detail","reason","at","byId","byName") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, candidateId, applicationId, kind, clean(title, 200), clean(detail, 600), clean(reason, 500), now(), user ? user.id : null, user ? user.name : null);
  return id;
}
async function eventsOf(candidateId, { kinds = null, limit = 200 } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateEvent" WHERE "candidateId" = ? ORDER BY "at" DESC LIMIT ?', candidateId, limit);
  return rows.filter((r) => !kinds || kinds.includes(r.kind));
}

// --- why is a salary / experience changing -------------------------------------------------------------------------
const CHANGE_REASONS = [
  'Candidate told us a new figure',
  'Got a new job or hike',
  'Resume updated',
  'Typing mistake corrected',
  'Wrong value from the resume parser',
  'Negotiation with the candidate',
  'Verified with documents (payslip / offer letter)',
  'Other',
];
const CHANGE_FIELDS = { currentSalary: 'Current salary', expectedSalary: 'Expected salary', experienceYears: 'Total experience' };
const shown = (v) => (v == null || v === '' ? '' : String(v).trim());
// -> { required: [field...] } the fields whose NEW value replaces an existing one (a blank field can be filled without a reason)
function changesNeedingReason(before, body) {
  const out = [];
  Object.keys(CHANGE_FIELDS).forEach((k) => {
    if (body[k] === undefined) return;
    const was = shown(before[k]);
    if (!was) return; // nothing there yet: filling it in needs no reason
    let now2 = shown(body[k]);
    if (k === 'experienceYears') {
      if (now2 === '') { out.push(k); return; }
      if (Math.abs(Number(now2) - Number(was)) < 0.05) return;
      out.push(k); return;
    }
    if (now2 === was) return;
    now2 = now2.toLowerCase().replace(/\s+/g, '');
    if (now2 === was.toLowerCase().replace(/\s+/g, '')) return;
    out.push(k);
  });
  return out;
}
function reasonFrom(body) {
  const code = clean(body.changeReason, 120);
  const note = clean(body.changeNote, 400);
  if (!code) return null;
  if (code === 'Other' && !note) return { error: 'Add a short note for "Other".' };
  return { code, note, text: note ? `${code} - ${note}` : code };
}

// --- stale profile data ----------------------------------------------------------------------------------------------
// A profile is stale when its salary was last changed, its phone was last confirmed or its resume was last uploaded more than N days ago AND
// nobody pressed "confirmed current" since. The salary / phone age = the last audit row that changed it, else the profile's creation day.
const staleMemo = new Map(); // `${days}` -> { at, out } (the whole-company scan is memoised for 5 minutes)
async function staleOf({ days = null, limit = 200, candidateWhere = {} } = {}) {
  await ensure();
  const d = days || (await settings()).staleDays;
  const whole = !Object.keys(candidateWhere).length;
  if (whole) { const hit = staleMemo.get(d); if (hit && Date.now() - hit.at < 300000) return { days: d, total: hit.out.length, rows: hit.out.slice(0, limit) }; }
  const cutoff = new Date(Date.now() - d * 86400000);
  const rows = await prisma.candidate.findMany({
    where: { ...candidateWhere, createdAt: { lt: cutoff }, profileStatus: { notIn: ['Archived', 'Do Not Use'] } },
    select: { id: true, name: true, phone: true, currentSalary: true, expectedSalary: true, resumeName: true, createdAt: true },
    orderBy: { createdAt: 'asc' }, take: 20000,
  });
  if (!rows.length) return { days: d, total: 0, rows: [] };
  const ids = rows.map((r) => r.id);
  const confirmed = new Map();
  const extras = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    extras.push(...await prisma.$queryRawUnsafe(`SELECT "candidateId","confirmedCurrentAt" FROM "CandidateExtra" WHERE "candidateId" IN (${part.map(() => '?').join(',')})`, ...part));
  }
  extras.forEach((e) => { if (e.confirmedCurrentAt) confirmed.set(e.candidateId, new Date(e.confirmedCurrentAt)); });
  const lastChange = new Map(); // `${id}|salary|phone`
  const resumeAt = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'Candidate', entityId: { in: part }, field: { in: ['currentSalary', 'expectedSalary', 'phone'] } }, select: { entityId: true, field: true, createdAt: true }, orderBy: { createdAt: 'desc' },
    });
    audits.forEach((a) => { const k = `${a.entityId}|${a.field === 'phone' ? 'phone' : 'salary'}`; if (!lastChange.has(k)) lastChange.set(k, a.createdAt); });
    // eslint-disable-next-line no-await-in-loop
    const rs = await prisma.candidateResume.findMany({ where: { candidateId: { in: part }, kind: 'ORIGINAL' }, select: { candidateId: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    rs.forEach((r) => { if (!resumeAt.has(r.candidateId)) resumeAt.set(r.candidateId, r.createdAt); });
  }
  const out = [];
  rows.forEach((c) => {
    const conf = confirmed.get(c.id);
    const base = (v) => { const t = v ? new Date(v) : c.createdAt; return conf && conf > t ? conf : t; };
    const parts = [];
    if (c.currentSalary || c.expectedSalary) { const t = base(lastChange.get(`${c.id}|salary`)); if (t < cutoff) parts.push({ what: 'Salary', since: t }); }
    if (c.phone) { const t = base(lastChange.get(`${c.id}|phone`)); if (t < cutoff) parts.push({ what: 'Phone', since: t }); }
    if (c.resumeName) { const t = base(resumeAt.get(c.id)); if (t < cutoff) parts.push({ what: 'Resume', since: t }); }
    if (parts.length) {
      const oldest = parts.reduce((a, b) => (a.since < b.since ? a : b));
      out.push({
        id: c.id, name: c.name, stale: parts.map((p) => ({ what: p.what, since: p.since.toISOString(), days: Math.floor((Date.now() - p.since.getTime()) / 86400000) })),
        oldestDays: Math.floor((Date.now() - oldest.since.getTime()) / 86400000), confirmedCurrentAt: conf ? conf.toISOString() : null,
      });
    }
  });
  out.sort((a, b) => b.oldestDays - a.oldestDays);
  if (whole) staleMemo.set(d, { at: Date.now(), out });
  return { days: d, total: out.length, rows: out.slice(0, limit) };
}
async function confirmCurrent(candidateId, user) {
  await ensure();
  const at = now();
  await prisma.$executeRawUnsafe(`INSERT INTO "CandidateExtra" ("candidateId","confirmedCurrentAt","confirmedCurrentBy","updatedAt","updatedByName") VALUES (?,?,?,?,?)
    ON CONFLICT("candidateId") DO UPDATE SET "confirmedCurrentAt"=excluded."confirmedCurrentAt","confirmedCurrentBy"=excluded."confirmedCurrentBy"`, candidateId, at, user ? user.name : null, at, user ? user.name : null);
  await addEvent(candidateId, { kind: 'confirmed_current', title: 'Salary, phone and resume confirmed current', detail: null }, user);
  staleMemo.clear();
  return at;
}

// --- rejoin / reapply history ----------------------------------------------------------------------------------------
// Every application this person ever had (the rows are never deleted), each with its closing reason, and any joining: the same client
// (or another) they joined before. Newest first. `scopeAppIds` (optional) limits which applications the viewer may see.
async function applicationHistory(candidateId, { scopeAppIds = null } = {}) {
  const apps = await prisma.application.findMany({
    where: { candidateId, ...(scopeAppIds ? { id: { in: scopeAppIds } } : {}) },
    select: {
      id: true, stage: true, createdAt: true, updatedAt: true, joiningDate: true,
      requirement: { select: { id: true, reqCode: true, title: true, status: true, internal: true, client: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!apps.length) return { rows: [], joined: [] };
  const events = await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: apps.map((a) => a.id) }, toStage: { in: ['REJECTED', 'NEW', 'JOINED', 'HIRED'] } },
    orderBy: { createdAt: 'asc' },
    select: { applicationId: true, toStage: true, fromStage: true, action: true, reasonCategory: true, reasonDetail: true, comment: true, actorName: true, createdAt: true },
  });
  const byApp = new Map();
  events.forEach((e) => { if (!byApp.has(e.applicationId)) byApp.set(e.applicationId, []); byApp.get(e.applicationId).push(e); });
  const rows = apps.map((a) => {
    const evs = byApp.get(a.id) || [];
    const rejections = evs.filter((e) => e.toStage === 'REJECTED').map((e) => ({ at: e.createdAt, reason: e.reasonCategory || null, detail: e.reasonDetail || e.comment || null, by: e.actorName || null }));
    const reapplied = evs.filter((e) => e.toStage === 'NEW' && e.fromStage === 'REJECTED').map((e) => ({ at: e.createdAt, by: e.actorName || null, note: e.comment || null }));
    return {
      applicationId: a.id,
      requirementId: a.requirement ? a.requirement.id : null,
      reqCode: a.requirement ? a.requirement.reqCode : null,
      title: a.requirement ? a.requirement.title : null,
      client: a.requirement ? (a.requirement.internal ? 'TeamLink Internal' : (a.requirement.client && a.requirement.client.name) || null) : null,
      clientId: a.requirement && a.requirement.client ? a.requirement.client.id : null,
      requirementStatus: a.requirement ? a.requirement.status : null,
      appliedAt: a.createdAt, stage: a.stage, rejections, reapplied, joined: ['JOINED', 'HIRED'].includes(a.stage) ? { at: a.joiningDate || a.updatedAt } : null,
    };
  });
  const joined = rows.filter((r) => r.joined);
  return { rows, joined };
}

// --- who may open an ID document ----------------------------------------------------------------------------------------
const ID_DOC_RE = /aadhaar|aadhar|\bpan\b|passport/i;
const isIdDocument = (doc) => !!doc && (doc.docType === 'ID' || ID_DOC_RE.test(String(doc.name || '')));

module.exports = {
  ensure, settings, saveSettings, DEFAULTS, extraOf, extraInput, saveExtra, MARITAL, listOf,
  addEvent, eventsOf, CHANGE_REASONS, CHANGE_FIELDS, changesNeedingReason, reasonFrom,
  staleOf, confirmCurrent, applicationHistory, isIdDocument, clean, json,
};

// --- ID documents: who may open one ----------------------------------------------------------------------------------------
// The switch "ID Documents / view" (Role Catalog; default Super Admin, Admin, HR, TL, Recruiter) decides first. A RECRUITER must also be the
// owning recruiter: the owner of one of the person's applications, the main recruiter of one of their requirements (a team member listed on it is not enough), the login that added the
// person, or the one who uploaded the document. TL / HR / Admin are limited only by the record scope the route already checked.
async function mayOpenIdDocs(user, candidate, doc = null) {
  const { can } = require('../middleware/auth'); // eslint-disable-line global-require
  if (!user || !(await can(user, 'ats', 'candidates', 'ID Documents', 'view'))) return false;
  if (require('./fitBreakdown').isRestricted(user)) return false; // the BDE team's limited view never reaches personal documents // eslint-disable-line global-require
  const roles = [user.role, user.atsRole].filter(Boolean);
  if (roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR'].includes(r))) return true;
  if (user.atsRole === 'RECRUITER' || roles.includes('RECRUITER')) {
    if (doc && doc.uploadedByUserId === user.id) return true;
    const apps = (candidate && candidate.applications) || [];
    if (apps.some((a) => a.ownerRecruiterId === user.id || (a.requirement && a.requirement.recruiterId === user.id))) return true;
    try { if (await require('./candidateAddedBy').addedBy(user.id, candidate.id)) return true; } catch { /* not recorded: the other tests decide */ } // eslint-disable-line global-require
    return false;
  }
  return true; // a custom role the Admin switched this on for
}
module.exports.mayOpenIdDocs = mayOpenIdDocs;
