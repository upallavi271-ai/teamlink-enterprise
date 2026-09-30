/* eslint-disable no-console, no-await-in-loop, no-continue */
// ---------------------------------------------------------------------------
// EDUCATION / BDE-EDU FIXES — stage 2 of the Sep-2026 file audit.
//
//   node scripts/import-edu-fixes.js                    dry run (default)
//   node scripts/import-edu-fixes.js --commit           write (backs up first)
//   options   --steps=1,3,5      run only these steps
//             --out=<file.json>  also write the full report (every list)
//             --dir=<folder>     where the source .xlsx files are
//                                (default C:/Users/user/Downloads/)
//
// Approved by the user, and nothing else:
//
//   1  REQUIREMENT STATUSES. (a) the Edu-1 / Edu-2 / BDE Educational
//      Requirement registers' status column: No Requirement / Stop(ped) ->
//      CLOSED, On Hold -> ON_HOLD, Running -> OPEN. (b) CLOSE the history-
//      created Education requirements (not register rows) that are OPEN and
//      have NO application activity dated 2026-01-01 or later. Candidates and
//      history stay.
//   2  JOININGS from BDE-Edu "ProfileScreening" column S ("Status - 1"):
//      Joined -> JOINED (joiningStatus Joined, joinedAt from the dated
//      "<date> Joined" note when the row has one), Will Join -> OFFER_ACCEPTED.
//      Candidates found by batch 3's externalRef. One stage event per change.
//   3  SEATS EDU-1…EDU-10 rebuilt as one clean chain per seat, in the order
//      the user gave, with the dates the Excel files give (roster "Original
//      Data Count -26", "Education Team Joinings.xlsx" summary, the Team A /
//      Team B joinings sheets and the Edu 6-10 tracker). One-day 23-Sep stubs
//      removed. New people created (no login). "Not Working" people Relieved
//      and their login disabled. ONLY PositionAssignment rows are written —
//      never Position fields.
//   4  NEW PROFILES from "Sheet5" and "mamatha mam Profiles" (deduped by
//      phone; applications only where a college is named). "WS" skipped.
//   5  OLD RECRUITERS on the 2022–2025 Daily Interviews applications: one
//      completed follow-up per application carrying the recruiter / TL name;
//      user links only for a name that maps to exactly one employee with an
//      active login.
//   6  EDUCATION CLIENTS: (a) Client.location from the registers' Location
//      column / the college-name suffix; (b) agreement terms from Edu-1 / Edu-2
//      for clients NOT already ACTIVE (the signed-agreements import wins).
//   7  CATCH-UPS: Daily Interviews missing applications (candidate exists)
//      and stage changes; Profile Screening (Edu file) new people /
//      applications / stages; BDE "Index Interview Sheet" stage advances.
//   8  "Edu 6-7 shared Profiles.xlsx" (Team B tracker EDU-6…10): candidates,
//      applications, one stage event + one completed follow-up per row.
//   9  "edu 1-5 joinings.xlsx" Sheet2 (Team A joinings EDU-1…5), imported the
//      same way the Team B joinings sheet was.
//
// Stage rule everywhere: a sheet only moves a stage FORWARD, or to an explicit
// final state (Joined; a candidate's decline after selection). A later DB
// stage is never overwritten by an older sheet status — those are LISTED.
//
// RUN ORDER 3, 6, 4, 9, 8, 2, 7, 5, 1 — people and clients first, the
// requirement closing last so it sees every application the other steps add.
// The database is read once; the dry run updates the in-memory model too, so
// its counts are the counts --commit writes. Writes go straight through
// Prisma (no routes): no email, no notification.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.chdir(path.join(__dirname, '..'));
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { nkey, tidyName, mapStatus, firstPhone, phoneKey } = require('../src/utils/importNormalise');

const ARGS = process.argv.slice(2);
const COMMIT = ARGS.includes('--commit');
const argVal = (k) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const STEPS = new Set((argVal('steps') || '1,2,3,4,5,6,7,8,9').split(',').map(Number));
const OUT = argVal('out');
const DIR = argVal('dir') || 'C:/Users/user/Downloads/';
const FILES = {
  interview: 'Education Interview Sheet-2022-2026 (1).xlsx',
  edu1: 'Edu - 1 Requirement Sheet  (2).xlsx',
  edu2: 'Edu - 2 Requirement Sheet  (2).xlsx',
  bde: 'BDE PROFILES (1).xlsx',
  bdePS: 'BDE-Edu-Profile Screening -Sheet (1).xlsx',
  tracker: 'Edu 6-7 shared Profiles.xlsx',
  teamA: 'edu 1-5 joinings.xlsx',
  teamB: 'Education Team B 6 -10 Recrutiers Joining Status.xlsx',
  summary: 'Education Team Joinings.xlsx',
};
const TAG = 'Imported — Education fixes Sep-2026';
const T2 = 'Imported — BDE Edu profile screening';
const T5 = 'Imported — Education interview sheet (recruiter)';
const T7 = 'Imported — Education sheets catch-up';
const T8 = 'Imported — Edu 6-10 shared profiles';
const T9 = 'Imported — Education Team A joinings';
const TB = 'Imported — Education Team B joinings';
const TODAY = '2026-09-25';

// ============================================================================
// helpers
// ============================================================================
const t = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const lc = (v) => t(v).toLowerCase();
const letters = (v) => lc(v).replace(/[^a-z]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const titleCase = (s) => t(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const years = (v) => { const m = lc(v).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const pk = (c, r) => `${c}|${r}`;
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const at = (iso, hh = '09') => new Date(`${iso}T${hh}:00:00Z`);
const isoOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const maxIso = (...xs) => xs.filter(Boolean).sort().pop() || null;
const minIso = (...xs) => xs.filter(Boolean).sort()[0] || null;

function phonesAll(v) {
  const s = String(v == null ? '' : v);
  const out = [];
  s.split(/[/,;\n]|\s{2,}/).forEach((p) => { const d = p.replace(/\D/g, ''); if (d.length >= 10 && d.length <= 13) out.push(d.slice(-10)); });
  const whole = s.replace(/\D/g, '');
  if (!out.length && whole.length >= 20) { for (let i = 0; i + 10 <= whole.length; i += 10) out.push(whole.slice(i, i + 10)); }
  if (!out.length && whole.length >= 10) out.push(whole.slice(-10));
  return [...new Set(out)];
}

// ---- dates (the audit's reader: every date inside a cell) -------------------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function ymd(y, m, d) {
  let Y = Number(y); if (Y < 100) Y += 2000;
  const M = Number(m); const D = Number(d);
  if (Y < 2019 || Y > 2027 || M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y}-${pad(M)}-${pad(D)}`;
}
function serial(n) { if (typeof n !== 'number' || n < 40000 || n > 50000) return null; const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000); return d.toISOString().slice(0, 10); }
function datesIn(v) {
  if (v == null || v === '') return [];
  if (v instanceof Date) return [v.toISOString().slice(0, 10)];
  if (typeof v === 'number') { const s = serial(v); return s ? [s] : []; }
  const s = String(v).toLowerCase();
  const out = [];
  const re = /(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([a-z]{3,})[\s\-/.,]*(\d{4}|\d{2})(?!\d)|(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)|(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = re.exec(s))) {
    let d = null;
    if (m[1] && MON[m[2].slice(0, 3)]) d = ymd(m[3], MON[m[2].slice(0, 3)], m[1]);
    else if (m[4]) d = ymd(m[6], m[5], m[4]);
    else if (m[7]) d = ymd(m[7], m[8], m[9]);
    if (d) out.push(d);
  }
  return out;
}
const firstDate = (v) => datesIn(v)[0] || null;

// ---- workbooks --------------------------------------------------------------
const wbCache = new Map();
function wb(file) { if (!wbCache.has(file)) wbCache.set(file, XLSX.readFile(DIR + file, { cellDates: false, sheetRows: 20000 })); return wbCache.get(file); }
function grid(file, sheet, raw = true) {
  const ws = wb(file).Sheets[sheet];
  if (!ws) throw new Error(`${file}: no sheet "${sheet}"`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw, blankrows: true });
}

// ---- stages -----------------------------------------------------------------
const STAGE_ACTION = {
  JOINED: 'Joined', REJECTED: 'Rejected', HOLD: 'Put on hold', SELECTED: 'Selected', OFFER: 'Offer',
  OFFER_ACCEPTED: 'Offer accepted', INTERVIEW_COMPLETED: 'Interview completed', INTERVIEW_SCHEDULED: 'Interview scheduled',
  CLIENT_SHORTLISTED: 'Client shortlisted', SHARED_WITH_CLIENT: 'Shared with client', RECRUITER_REVIEW: 'Recruiter review', NEW: 'Added',
};
const ADV = { NEW: 0, RECRUITER_REVIEW: 1, SHARED_WITH_CLIENT: 2, CLIENT_SHORTLISTED: 3, INTERVIEW_SCHEDULED: 4, INTERVIEW_COMPLETED: 5, HOLD: 5, SELECTED: 7, OFFER: 8, OFFER_ACCEPTED: 9, JOINED: 10, REJECTED: 6 };
const adv = (s) => (ADV[s] === undefined ? 0 : ADV[s]);
const OFFERISH = new Set(['SELECTED', 'OFFER', 'OFFER_ACCEPTED']);
const DECLINE = /won'?t ?join|wont ?join|not ?join|drop|declin|not interested|not willing|high (package|expect|salary)|expect/;
// Should the sheet's stage be applied over the DB's?
//   apply | same | behind (DB further on) | conflict (DB final / contradicts)
function decide(db, sheet, text = '') {
  if (!sheet) return 'none';
  if (db === sheet) return 'same';
  if (sheet === 'JOINED') return 'apply';
  if (db === 'JOINED') return 'conflict';
  if (sheet === 'REJECTED') {
    if (OFFERISH.has(db)) return DECLINE.test(lc(text)) ? 'apply' : 'conflict';
    return 'apply';
  }
  if (db === 'REJECTED') return 'conflict';
  return adv(sheet) > adv(db) ? 'apply' : 'behind';
}
const CANDIDATE_SIDE = [
  [/did ?n.?t join|not join|wont join|won.?t join|not joining|drop/, 'Did Not Join'],
  [/not ok with (the )?package|less salary|expect|high package|salary/, 'Salary Expectation'],
  [/location|far|relocat|accomodation|accommodation|non local/, 'Location / Relocation'],
  [/got (a job )?in other|another|other offer/, 'Accepted Another Offer'],
  [/not interested|not wil+ing|bond/, 'Not Interested'],
  [/not attend|did not attend|no show/, 'Did Not Attend Interview'],
  [/not answer|not respond|not reachable|switch(ed)? off/, 'Not Reachable'],
];
const CLIENT_SIDE = [
  [/communication/, 'Communication'],
  [/fresher|experience|not upto|subject|knowledge|performance|poor/, 'Insufficient Experience'],
  [/not shortlisted|profile (is )?rejected/, 'Not Shortlisted'],
  [/not eligible|ratif/, 'Not Eligible'],
  [/no requirement|position closed|vacancy/, 'Position Closed'],
];
function rejectMeta(text) {
  const s = lc(text);
  const c = CANDIDATE_SIDE.find(([re]) => re.test(s));
  if (c) return { side: 'Candidate', category: c[1] };
  const k = CLIENT_SIDE.find(([re]) => re.test(s));
  return { side: 'Client', category: k ? k[1] : 'Not Selected' };
}

// ---- people: the audit's name matcher, unchanged -----------------------------
const skel = (w) => w.replace(/h/g, '').replace(/ee/g, 'i').replace(/(.)\1+/g, '$1').replace(/y/g, 'i');
function nameParts(s) {
  const toks = String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  return { main: toks.filter((x) => x.length >= 3), init: toks.filter((x) => x.length < 3).map((x) => x[0]) };
}
let AUDIT_EMP = [];
function matchPerson(raw) {
  const { main, init } = nameParts(raw);
  if (!main.length) return { status: 'blank', hits: [] };
  const hits = AUDIT_EMP.filter((e) => {
    const et = nameParts(e.name);
    const all = [...et.main, ...et.init];
    const ok = main.every((w) => et.main.some((x) => x === w || skel(x) === skel(w) || (w.length >= 5 && x.startsWith(w))));
    if (!ok) return false;
    return init.every((i) => all.some((x) => x[0] === i));
  });
  const edu = hits.filter((e) => /(education|bde)/i.test(e.department || ''));
  const status = hits.length === 0 ? 'UNMAPPED' : (hits.length === 1 ? 'unique' : (edu.length === 1 ? 'unique-in-Edu/BDE' : 'AMBIGUOUS'));
  return { status, hits };
}
const personCache = new Map();
const personOf = (raw) => { const k = t(raw); if (!personCache.has(k)) personCache.set(k, matchPerson(k)); return personCache.get(k); };

// ============================================================================
// state — everything read once
// ============================================================================
const S = { dryId: 0 };
const report = { mode: COMMIT ? 'COMMIT' : 'DRY RUN', steps: {}, questions: [] };
const newId = () => { S.dryId += 1; return `dry-${S.dryId}`; };

async function load() {
  const [clients, reqs, cands, apps, emps, positions, invs, users, evMax, fuMax, userEv] = await Promise.all([
    prisma.client.findMany(),
    prisma.requirement.findMany({ select: { id: true, clientId: true, title: true, department: true, reqCode: true, status: true, specialisation: true, createdAt: true } }),
    prisma.candidate.findMany({ select: { id: true, name: true, phone: true, email: true, externalRef: true, source: true, education: true, specialization: true, experienceYears: true, currentSalary: true, expectedSalary: true, location: true, preferredLocation: true, noticePeriod: true } }),
    prisma.application.findMany({ select: { id: true, candidateId: true, requirementId: true, stage: true, interviewAt: true, joinedAt: true, joiningDate: true, joiningStatus: true, createdAt: true, source: true } }),
    prisma.employee.findMany({ include: { user: { select: { id: true, status: true } } } }),
    prisma.position.findMany({ select: { id: true, code: true, department: true } }),
    prisma.invoice.findMany({ select: { id: true, candidateId: true } }),
    prisma.user.findMany({ select: { id: true, status: true } }),
    prisma.applicationStageEvent.groupBy({ by: ['applicationId'], where: { NOT: { actorName: 'Imported from spreadsheet' } }, _max: { createdAt: true } }),
    prisma.applicationFollowUp.groupBy({ by: ['applicationId'], _max: { lastContactedAt: true } }),
    prisma.applicationStageEvent.findMany({ where: { actorUserId: { not: null } }, select: { applicationId: true, createdAt: true } }),
  ]);
  Object.assign(S, { clients, reqs, cands, apps, emps, positions });
  S.clientById = new Map(clients.map((c) => [c.id, c]));
  S.reqById = new Map(reqs.map((r) => [r.id, r]));
  S.reqsByClient = new Map(); reqs.forEach((r) => push(S.reqsByClient, r.clientId, r));
  S.candById = new Map(cands.map((c) => [c.id, c]));
  S.byPhone = new Map(); cands.forEach((c) => phonesAll(c.phone).forEach((p) => push(S.byPhone, p, c)));
  S.byEmail = new Map(); cands.forEach((c) => { if (c.email && c.email.includes('@')) S.byEmail.set(lc(c.email), c); });
  S.byRef = new Map(); cands.forEach((c) => { if (c.externalRef) push(S.byRef, c.externalRef, c); });
  S.appById = new Map(); S.appByPair = new Map(); S.appsByCand = new Map(); S.appsByReq = new Map();
  apps.forEach(idxAdd);
  S.posByCode = new Map(positions.map((p) => [p.code, p]));
  S.invCand = new Set(invs.map((i) => i.candidateId).filter(Boolean));
  S.empByCode = new Map(emps.map((e) => [e.employeeCode, e]));
  S.empById = new Map(emps.map((e) => [e.id, e]));
  S.userById = new Map(users.map((u) => [u.id, u]));
  S.evMax = new Map(evMax.map((x) => [x.applicationId, x._max.createdAt]));
  S.fuMax = new Map(fuMax.map((x) => [x.applicationId, x._max.lastContactedAt]));
  S.userEvent = new Map(); userEv.forEach((e) => { const p = S.userEvent.get(e.applicationId); if (!p || e.createdAt > p) S.userEvent.set(e.applicationId, e.createdAt); });
  S.sheetDate = new Map(); // applicationId -> latest dated sheet row seen for it
  S.touched = new Set();
  S.finalDate = new Map(); // applications this run wrote an event/follow-up for (dated)
  let seq = 0; reqs.forEach((r) => { const m = /^REQ-(\d+)$/.exec(r.reqCode || ''); if (m) seq = Math.max(seq, Number(m[1])); });
  S.reqSeq = seq;
  AUDIT_EMP = emps.map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department, employmentStatus: e.employmentStatus }));
  buildClientIndex();
}
function idxAdd(a) {
  S.appById.set(a.id, a); S.appByPair.set(pk(a.candidateId, a.requirementId), a);
  push(S.appsByCand, a.candidateId, a); push(S.appsByReq, a.requirementId, a);
}
// the latest dated sheet row that put an application in a final state
const noteFinal = (app, stage, iso) => { if (app && iso && iso <= TODAY && (stage === 'REJECTED' || stage === 'JOINED')) { const p = S.finalDate.get(app.id); if (!p || iso > p) S.finalDate.set(app.id, iso); } };
const noteSheetDate = (app, iso) => { if (app && iso && iso <= TODAY) { const p = S.sheetDate.get(app.id); if (!p || iso > p) S.sheetDate.set(app.id, iso); } };
const gone = (e) => ['Relieved', 'Exited', 'Exit Process'].includes(e.employmentStatus);
const activeLogin = (e) => (e && e.userId && S.userById.get(e.userId) && S.userById.get(e.userId).status === 'Active' && !gone(e) ? e.userId : null);

// ---- clients (Education colleges) ---------------------------------------------
const cmp = (s) => lc(s).replace(/ibbrahim/g, 'ibrahim').replace(/\bholly\b/g, 'holy').replace(/[^a-z0-9]/g, '');
const STOPW = /\b(college|of|engineering|engg|engineeri|and|institute|institutions?|technology|tech|science|sciences|the|for|women|womens|clg|university|group|pvt|ltd|school)\b/g;
const core = (s) => lc(s).replace(/&/g, ' ').replace(/[^a-z ]+/g, ' ').replace(STOPW, ' ').replace(/\s+/g, ' ').trim();
function buildClientIndex() {
  const reqN = (c) => (S.reqsByClient.get(c.id) || []).length;
  const weight = (c) => (c.ownerDepartment === 'Education' ? 100000 : 0) + reqN(c);
  S.cByKey = new Map();
  S.clients.forEach((c) => { const k = nkey(c.name); if (!k) return; const cur = S.cByKey.get(k); if (!cur || weight(c) > weight(cur)) S.cByKey.set(k, c); });
  S.cWeight = weight;
}
// Exact (letters+digits), then a prefix either way, then the same core words.
const NOT_A_COLLEGE = new Set(['online', 'offline', 'hyd', 'hyderabad', 'maharashtra', 'maharastra', 'maharstra', 'maharshtra', 'bangalore', 'pune', 'chennai', 'telangana', 'andhrapradesh', 'ap', 'ts']);
// allowJunk: an existing client literally named "online" / "hyd" (made by
// batch 2 from Daily Interviews cells) still matches, so those applications
// are found; nothing NEW is ever filed under such a name.
function matchCollege(name, allowJunk = false) {
  const k = nkey(name); if (!k) return { how: 'blank' };
  if (NOT_A_COLLEGE.has(k)) return allowJunk && S.cByKey.has(k) ? { how: 'exact', c: S.cByKey.get(k), junk: true } : { how: 'blank', notACollege: true };
  if (S.cByKey.has(k)) return { how: 'exact', c: S.cByKey.get(k) };
  const ck = cmp(name);
  const eduFirst = (a, b) => S.cWeight(b) - S.cWeight(a);
  let pool = S.clients.filter((c) => { const x = cmp(c.name); return x.length >= 4 && ck.length >= 4 && (x === ck || x.startsWith(ck) || ck.startsWith(x)); });
  if (pool.length) return { how: 'prefix', c: pool.sort(eduFirst)[0], n: pool.length };
  const cw = core(name).split(' ').filter((w) => w.length >= 3);
  if (cw.length) {
    pool = S.clients.filter((c) => { const x = core(c.name).split(' ').filter((w) => w.length >= 3); return x.length && cw.every((w) => x.includes(w)); });
    if (pool.length) return { how: 'core-words', c: pool.sort(eduFirst)[0], n: pool.length };
  }
  // a typo of an existing name ("ST.PERTERS", "Sri Anamacharya")
  if (ck.length >= 8) {
    pool = S.clients.filter((c) => { const x = cmp(c.name); return x.length >= 8 && Math.abs(x.length - ck.length) <= 2 && lev(x, ck) <= 2; });
    if (pool.length) return { how: 'spelling', c: pool.sort(eduFirst)[0], n: pool.length };
  }
  return { how: 'none' };
}
async function ensureClient(name, R) {
  const m = matchCollege(name);
  if (m.c) return m.c;
  if (m.how === 'blank') return null;
  const data = { name: t(name), ownerDepartment: 'Education', industry: 'Education', status: 'Active', clientType: 'Direct' };
  const made = COMMIT ? await prisma.client.create({ data }) : { id: newId(), ...data, agreementStatus: 'DRAFT' };
  S.clients.push(made); S.clientById.set(made.id, made); buildClientIndex();
  (R.clientsCreated = R.clientsCreated || []).push(t(name));
  return made;
}
// Requirement at a college for a branch: the existing "Faculty — <branch>",
// else one whose title names the branch, else a new CLOSED history one.
async function ensureReq(client, branch, source, when, R, seat = null) {
  const title = branch ? `Faculty — ${t(branch).length <= 12 ? t(branch).toUpperCase() : titleCase(branch)}` : 'Faculty';
  const list = (S.reqsByClient.get(client.id) || []).filter((q) => q.department === 'Education');
  const hit = list.find((q) => nkey(q.title) === nkey(title))
    || (branch ? list.find((q) => nkey(q.title).includes(nkey(branch)) && /faculty|professor|regular/i.test(q.title)) : null)
    || (!branch ? list.find((q) => nkey(q.title) === 'faculty') : null);
  if (hit) return hit;
  S.reqSeq += 1;
  const data = { title, clientId: client.id, department: 'Education', specialisation: branch ? t(branch) : null, status: 'CLOSED', priority: 'Medium', openings: 1, reqCode: `REQ-${String(S.reqSeq).padStart(4, '0')}`, description: `${title}. Created from ${source}.`, positionCode: seat, createdAt: at(when || '2026-01-01') };
  const made = COMMIT ? await prisma.requirement.create({ data }) : { id: newId(), ...data };
  S.reqs.push(made); S.reqById.set(made.id, made); push(S.reqsByClient, client.id, made);
  R.requirementsCreated = (R.requirementsCreated || 0) + 1;
  return made;
}
// A candidate by phone whose name is plausibly the row's (a phone typed
// against the wrong person is not a match): a shared word, a word one letter
// apart ("Prakash"/"Prakesh"), or the same first letters ("vijay raj" /
// "Vijayaraju", "Tej Kiran" / "Tejakiran").
const nameWords = (s) => lc(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function lev(a, b) {
  if (a === b) return 0; const m = a.length; const n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) { const cur = [i]; for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function samePerson(a, b) {
  const A = nameWords(a); const B = nameWords(b);
  if (A.some((w) => B.some((x) => x === w || skel(x) === skel(w) || (Math.min(x.length, w.length) >= 5 && lev(x, w) <= 1)))) return true;
  const ka = letters(a).replace(/^(dr|mr|mrs|ms)/, ''); const kb = letters(b).replace(/^(dr|mr|mrs|ms)/, '');
  return ka.length >= 4 && kb.length >= 4 && (ka.slice(0, 4) === kb.slice(0, 4) || skel(ka).slice(0, 4) === skel(kb).slice(0, 4));
}
// Every candidate carrying one of the phones and plausibly this name.
function candsByPhone(phones, name) {
  const all = [...new Set(phones.flatMap((p) => S.byPhone.get(p) || []))];
  const list = all.filter((c) => samePerson(c.name, name));
  return { list, phoneOf: !list.length && all.length ? all[0].name : null };
}
function candByPhone(phones, name) {
  const { list, phoneOf } = candsByPhone(phones, name);
  return list.length ? { cand: list[0], list, how: 'phone' } : { cand: null, list: [], phoneOf };
}
// An application of any of these candidate records at this college: the same
// client first, then a client spelled as a prefix of it (or it of them) —
// batch 2 kept "St.Peters" and "St. Peter's Engineering College" apart.
function appAt(list, client) {
  const apps = list.flatMap((c) => S.appsByCand.get(c.id) || []);
  const exact = apps.find((a) => { const q = S.reqById.get(a.requirementId); return q && q.clientId === client.id; });
  if (exact) return exact;
  const ck = cmp(client.name); if (ck.length < 5) return null;
  return apps.find((a) => { const q = S.reqById.get(a.requirementId); const c = q && S.clientById.get(q.clientId); if (!c || q.department !== 'Education') return false; const x = cmp(c.name); return x.length >= 5 && (x.startsWith(ck) || ck.startsWith(x)); }) || null;
}
async function createCandidate(data, R) {
  const made = COMMIT ? await prisma.candidate.create({ data }) : { id: newId(), ...data };
  S.cands.push(made); S.candById.set(made.id, made);
  phonesAll(made.phone).forEach((p) => push(S.byPhone, p, made));
  if (made.email) S.byEmail.set(lc(made.email), made);
  R.candidatesCreated = (R.candidatesCreated || 0) + 1;
  return made;
}
async function fillBlanks(cand, fill, R) {
  const data = {};
  Object.entries(fill).forEach(([k, v]) => { if (v != null && v !== '' && blank(cand[k])) data[k] = v; });
  if (!Object.keys(data).length) return;
  if (COMMIT) await prisma.candidate.update({ where: { id: cand.id }, data });
  Object.assign(cand, data);
  R.candidatesFilled = (R.candidatesFilled || 0) + 1;
}
async function createApp(cand, req, stage, extra, R) {
  const data = { candidateId: cand.id, requirementId: req.id, stage, interviewStatus: stage === 'INTERVIEW_COMPLETED' ? 'COMPLETED' : stage === 'INTERVIEW_SCHEDULED' ? 'SCHEDULED' : null, ...extra };
  const app = COMMIT ? await prisma.application.create({ data }) : { id: newId(), ...data };
  idxAdd(app); S.apps.push(app);
  R.applicationsCreated = (R.applicationsCreated || 0) + 1;
  return app;
}
function stageData(stage, { joinedAt, joiningDate, decline } = {}) {
  const d = { stage };
  if (stage === 'INTERVIEW_COMPLETED') d.interviewStatus = 'COMPLETED';
  if (stage === 'INTERVIEW_SCHEDULED') d.interviewStatus = 'SCHEDULED';
  if (stage === 'OFFER_ACCEPTED') d.offerStatus = 'Offer Accepted';
  if (stage === 'JOINED') { d.joiningStatus = 'Joined'; d.offerStatus = 'Offer Accepted'; if (joinedAt) d.joinedAt = at(joinedAt); if (joiningDate) d.joiningDate = joiningDate; }
  if (stage === 'REJECTED' && decline) d.offerStatus = 'Offer Declined';
  return d;
}
async function setStage(app, to, ev, extra = {}) {
  const from = app.stage;
  const data = { ...stageData(to, extra), ...(extra.appData || {}) };
  if (COMMIT) await prisma.application.update({ where: { id: app.id }, data });
  Object.assign(app, data);
  await stageEvent(app, from, to, ev);
}
async function stageEvent(app, from, to, ev) {
  const req = S.reqById.get(app.requirementId); const cl = req ? S.clientById.get(req.clientId) : null;
  if (!COMMIT) return;
  await prisma.applicationStageEvent.create({ data: {
    applicationId: app.id, candidateId: app.candidateId, fromStage: from, toStage: to, action: ev.action || STAGE_ACTION[to] || to,
    comment: ev.comment ? String(ev.comment).slice(0, 1500) : null, actorName: ev.tag, actorRole: ev.role || null,
    actorSide: to === 'REJECTED' ? (ev.side || 'Client') : 'Internal', reasonCategory: to === 'REJECTED' ? (ev.category || null) : (ev.category || null), reasonDetail: ev.detail ? String(ev.detail).slice(0, 500) : null,
    actorPositionId: ev.seat && S.posByCode.get(ev.seat) ? S.posByCode.get(ev.seat).id : null, actorPositionCode: ev.seat || null,
    requirementId: req ? req.id : null, requirementTitle: req ? req.title : null, clientId: cl ? cl.id : null, clientName: cl ? cl.name : null,
    createdAt: ev.date ? at(ev.date, '12') : new Date(),
  } });
}
function followUpData(app, f) {
  const req = S.reqById.get(app.requirementId);
  return {
    applicationId: app.id, candidateId: app.candidateId, requirementId: req ? req.id : null,
    ownerUserId: f.ownerUserId || null, ownerName: f.ownerName || null, ownerRole: f.ownerRole || 'Recruiter',
    tlUserId: f.tlUserId || null, tlName: f.tlName || null,
    ownerPositionId: f.seat && S.posByCode.get(f.seat) ? S.posByCode.get(f.seat).id : null, ownerPositionCode: f.seat || null,
    lastContactedAt: f.date ? at(f.date) : null, contactMode: f.mode || 'Call', purpose: f.purpose || null,
    notes: f.notes ? String(f.notes).slice(0, 3000) : null, outcome: f.outcome || null,
    completedAt: f.date ? at(f.date, '18') : new Date(), completedNote: f.completedNote || null,
    createdByName: f.tag, createdAt: f.date ? at(f.date) : new Date(),
  };
}

// ============================================================================
// THE PEOPLE AND SEATS (step 3) — the user's order, the Excel files' dates
// ============================================================================
const TEAM_A = 'Team-A'; const TEAM_B = 'Team-B';
const SEAT_TEAM = (code) => (Number(code.split('-')[1]) <= 5 ? TEAM_A : TEAM_B);
// People with no record yet: created WITHOUT a login.
const NEW_PEOPLE = {
  GIRIJA: { name: 'Girija', team: TEAM_A, status: 'Relieved', doj: null, tl: 'D.Leela Usha Sri', why: 'EDU-4 before T.Sowmya ("Girija" in Education Team Joinings.xlsx, "Girijarani" on Daily Interviews); Not Working' },
  DSIRISHA: { name: 'D.Sirisha', team: TEAM_A, status: 'Relieved', doj: '2026-08-27', tl: 'D.Leela Usha Sri', why: 'EDU-4 from 27-Aug-2026 (roster); resigned (user)' },
  TRIVENI: { name: 'Triveni', team: TEAM_A, status: 'Active', doj: '2026-09-25', tl: 'D.Leela Usha Sri', why: 'EDU-4 current holder, joined 25-Sep-2026 (user)' },
  TEJASWINI: { name: 'P.Tejaswini', team: TEAM_A, status: 'Relieved', doj: '2026-08-27', tl: 'D.Leela Usha Sri', why: 'EDU-5 from 27-Aug-2026 (roster); seat ended, EDU-5 vacant now (user)' },
  GAYATHRI: { name: 'V.Gayathri', team: TEAM_A, status: 'Active', doj: null, tl: 'D.Leela Usha Sri', why: 'EDU-2 new holder per the user; start date not in any file, so NOT seated (question)' },
  GOUTHAMI: { name: 'G.Gouthami', team: TEAM_B, status: 'Relieved', doj: '2026-08-27', tl: 'Masabattula Sai Sirisha', why: 'EDU-6 after Renuka K, joined 27-Aug-2026 (roster); replaced by A.Dhathri (user)' },
  DHATHRI: { name: 'A.Dhathri', team: TEAM_B, status: 'Active', doj: null, tl: 'Masabattula Sai Sirisha', why: 'EDU-6 current holder (user)' },
};
// Aliases are the sheets' own spellings, letters only, lower case.
const CHAINS = {
  'EDU-1': [
    { code: 'TL371', aliases: ['swathi', 'vswathi'] },
    { code: 'TL471', aliases: ['bsneha', 'sneha'], start: ['2026-02-12', 'Education Team Joinings.xlsx: joining date 12-Feb-2026'] },
  ],
  'EDU-2': [
    { code: 'TL442', aliases: ['pranayini', 'pranayani'] },
    { code: 'TL507', aliases: ['gnavitha', 'navitha', 'geedinavitha'], start: ['2026-07-20', 'roster + Education Team Joinings.xlsx: 20-Jul-2026'] },
  ],
  'EDU-3': [
    { code: 'TL448', aliases: ['msaisirisha', 'saisirisha'], start: ['2025-11-25', 'Education Team Joinings.xlsx: joining date 25-Nov-2025'], end: ['2026-06-16', 'became Team B TL (EDU-TL) on 17-Jun-2026'] },
    { code: 'TL501', aliases: ['psirisha', 'psireesha', 'shirishap', 'pshirisha'], end: ['2026-08-29', 'roster: last working date 29-Aug-2026'] },
    { code: 'TL513', aliases: ['krajeswari'], start: ['2026-08-21', 'roster: K.Rajeswari 21-Aug-2026'] },
  ],
  'EDU-4': [
    { key: 'GIRIJA', aliases: ['girija', 'girijarani'] },
    { code: 'TL504', aliases: ['tsowmya', 'tsoumya'], end: ['2026-08-11', 'roster: last working date 11-Aug-2026'] },
    { key: 'DSIRISHA', aliases: ['dsirisha'], start: ['2026-08-27', 'roster: replacement date 27-Aug-2026'] },
    { key: 'TRIVENI', aliases: ['triveni'], start: ['2026-09-25', 'user: joined today 25-Sep-2026'] },
  ],
  'EDU-5': [
    { code: 'TL441', aliases: ['sukeerthi'] },
    { code: 'TL483', aliases: ['mnavya', 'navya'], end: ['2026-08-03', 'roster: last working date 3-Aug-2026'] },
    { key: 'TEJASWINI', aliases: ['ptejaswini', 'tejaswini'], start: ['2026-08-27', 'roster: joining date 27-Aug-2026'], vacantAfter: true },
  ],
  'EDU-6': [
    { code: 'TL458', aliases: ['divya'] },
    { code: 'TL487', aliases: ['krenuka', 'renuka'], end: ['2026-08-31', 'roster + user: last working date 31-Aug-2026'] },
    { key: 'GOUTHAMI', aliases: ['ggouthami', 'ggowthami', 'gouthami', 'gowthami'], start: ['2026-08-27', 'roster: joining date 27-Aug-2026'] },
    { key: 'DHATHRI', aliases: ['adhathri', 'dhathri'] },
  ],
  'EDU-7': [
    { code: 'TL463', aliases: ['tejasri'] },
    { code: 'TL488', aliases: ['archana'] },
    { code: 'TL505', aliases: ['suma', 'uma'], start: ['2026-07-13', 'roster + Education Team Joinings.xlsx: 13-Jul-2026'] },
  ],
  'EDU-8': [
    { code: 'TL457', aliases: ['manideep'] },
    { code: 'TL480', aliases: ['psupriya', 'supriya'], start: ['2026-03-12', 'roster + Education Team Joinings.xlsx: 12-Mar-2026'] },
  ],
  'EDU-9': [
    { code: 'TL470', aliases: ['knaveena', 'naveena'], start: ['2026-02-02', 'roster + Education Team Joinings.xlsx: 2-Feb-2026'] },
  ],
  'EDU-10': [
    { code: 'TL465', aliases: ['niharika'] },
    { code: 'TL425', aliases: ['lakshmi'] },
    { code: 'TL499', aliases: ['kjhanavi', 'jhanavi', 'kjahnavi', 'jahnavi', 'kjahnavai'], start: ['2026-06-12', 'roster: joining date 12-Jun-2026'], end: ['2026-08-03', 'roster: last working date 3-Aug-2026'] },
    { code: 'TL512', aliases: ['ganitha', 'anitha'], start: ['2026-08-04', 'roster: work allotted 3-Aug-2026, the day K.Jhanavi left (3-Aug)'], end: ['2026-09-02', 'roster: last working date 2-Sep-2026'] },
    { code: 'TL516', aliases: ['ruthvija'] },
  ],
};
// "Not Working" in Education Team Joinings.xlsx -> Relieved + login disabled.
const NOT_WORKING = ['TL371', 'TL442', 'TL501', 'GIRIJA', 'TL504', 'TL483', 'TL487', 'TL463', 'TL457', 'TL465', 'TL425'];
const SUMMARY_COUNTS = { TL371: 5, TL471: 11, TL442: 2, TL507: 4, TL448: 11, TL501: 3, GIRIJA: 1, TL504: 1, TL483: 5, TL487: 4, TL463: 8, TL505: 3, TL457: 2, TL480: 10, TL470: 12, TL465: 7, TL425: 6 };
const CHAT_COUNTS = { TL371: 5, TL471: 10, TL442: 2, TL507: 4, TL448: 11, TL501: 3, GIRIJA: 1, TL504: 1, TL441: 0, TL483: 6, TEJASWINI: 0, TL458: 0, TL487: 5, GOUTHAMI: 0, TL463: 8, TL488: 0, TL505: 4, TL457: 2, TL480: 10, TL470: 17, TL465: 7, TL425: 6, TL499: 0, TL512: 1 };
const FLOOR = '2025-10-01'; // the current seat structure starts in the data here
const GAP_DAYS = 30; // longer than this with no activity = the seat was vacant
S.who = new Map(); // chain key -> employee (existing or created)

// Sheet rows that say who worked which seat when.
function seatActivity() {
  const A = []; // { key(alias letters), seat|null, date, src }
  const add = (name, seat, date, src) => { const k = letters(name); if (k && date && date >= FLOOR && date <= TODAY) A.push({ k, seat, date, src }); };
  const seatOf = (v) => { const m = lc(v).match(/edu\W*(\d{1,2})/); return m ? `EDU-${Number(m[1])}` : null; };
  // Team A joinings (edu 1-5 joinings.xlsx, Sheet2)
  grid(FILES.teamA, 'Sheet2').slice(1).forEach((r) => { if (!t(r[0])) return; const s = seatOf(r[12]) || (letters(r[9]) === 'saisirisha' ? 'EDU-3' : null); add(r[9], s, firstDate(r[6]), 'Team A joinings'); add(r[9], s, firstDate(r[7]), 'Team A joinings'); });
  // Team B joinings (data sits one column left of the headers)
  grid(FILES.teamB, 'Sheet1').slice(1).forEach((r) => { if (!t(r[0])) return; const s = seatOf(r[12]); add(r[9], s, firstDate(r[6]), 'Team B joinings'); add(r[9], s, firstDate(r[7]), 'Team B joinings'); });
  // Team B tracker
  grid(FILES.tracker, 'Sheet1').slice(1).forEach((r) => { if (!t(r[1])) return; const s = seatOf(r[20]); add(r[18], s, firstDate(r[0]), 'Edu 6-10 tracker'); });
  // person-level (no seat): Daily Interviews, Profile Screening, Pending, Sheet5
  grid(FILES.interview, 'Daily Interviews ').slice(1).forEach((r) => { if (t(r[0])) add(r[18], null, firstDate(r[16]), 'Daily Interviews'); });
  grid(FILES.interview, 'Profile Screening ').slice(1).forEach((r) => { if (t(r[1])) add(r[23], null, firstDate(r[0]) || firstDate(r[19]), 'Profile Screening'); });
  grid(FILES.interview, 'Pending Interviews ').slice(1).forEach((r) => { if (t(r[1])) add(r[22], null, firstDate(r[0]), 'Pending Interviews'); });
  grid(FILES.interview, 'Sheet5').slice(1).forEach((r) => { if (t(r[0])) add(r[22], null, firstDate(r[15]) || firstDate(r[20]), 'Sheet5'); });
  return A;
}
// Drop an isolated first / last date (a typo like "05-01-2025" among 2026 rows).
function trimmed(dates) {
  const d = [...new Set(dates)].sort();
  while (d.length > 2 && dayDiff(d[0], d[1]) > 60) d.shift();
  while (d.length > 2 && dayDiff(d[d.length - 2], d[d.length - 1]) > 60) d.pop();
  return d;
}

async function step3() {
  const R = { employeesCreated: [], employeesUpdated: [], statusChanges: [], loginsDisabled: [], seats: {}, removed: [], chains: {}, notes: [], gaps: [], leftButActive: [] };
  report.steps['3_seats_people'] = R;
  const doj = (e) => (e && e.dateOfJoining ? isoOf(e.dateOfJoining) : null);

  // ---- people: existing by code, new by name (created once) ----
  let count = await prisma.employee.count();
  const nextCode = async () => {
    for (;;) {
      count += 1;
      const code = `EMP-${String(count).padStart(4, '0')}`;
      if (!S.empByCode.has(code) && !(await prisma.employee.findUnique({ where: { employeeCode: code } }))) return code;
    }
  };
  const tlEmp = { 'D.Leela Usha Sri': S.empByCode.get('TL484'), 'Masabattula Sai Sirisha': S.empByCode.get('TL448') };
  for (const [key, p] of Object.entries(NEW_PEOPLE)) {
    let e = S.emps.find((x) => x.name === p.name && x.department === 'Education');
    if (!e) {
      const code = await nextCode();
      const tl = tlEmp[p.tl];
      const data = { employeeCode: code, name: p.name, department: 'Education', team: p.team, designation: 'Recruiter', employmentStatus: p.status, dateOfJoining: p.doj ? at(p.doj, '00') : null, tl: p.tl, reportingManagerId: p.status === 'Active' && tl ? tl.id : null };
      e = COMMIT ? await prisma.employee.create({ data }) : { id: newId(), ...data, userId: null };
      if (COMMIT) await prisma.auditLog.create({ data: { action: 'Employee created (Education seat history, no login)', entity: 'Employee', entityId: e.id, toValue: `${code} ${p.name} · Education · ${p.team} · ${p.status}${p.doj ? ` · DOJ ${p.doj}` : ''} — ${p.why}`, actorName: TAG } });
      S.emps.push(e); S.empByCode.set(code, e); S.empById.set(e.id, e);
      R.employeesCreated.push(`${code} ${p.name} — Education, ${p.team}, Recruiter, ${p.status}${p.doj ? `, DOJ ${p.doj}` : ', DOJ not in the files'}, no login (${p.why})`);
    }
    S.who.set(key, e);
  }
  Object.values(CHAINS).flat().forEach((x) => { if (x.code) { const e = S.empByCode.get(x.code); if (!e) throw new Error(`employee ${x.code} not found`); S.who.set(x.code, e); } });
  const personOfLink = (x) => S.who.get(x.code || x.key);

  // ---- employee records: department / team / status / login ----
  const setEmp = async (e, data, why) => {
    const diff = {}; Object.entries(data).forEach(([k, v]) => { if (e[k] !== v) diff[k] = v; });
    if (!Object.keys(diff).length) return;
    const before = Object.fromEntries(Object.keys(diff).map((k) => [k, e[k]]));
    if (COMMIT) {
      await prisma.employee.update({ where: { id: e.id }, data: diff });
      await prisma.auditLog.create({ data: { action: 'Employee updated (Education seat history)', entity: 'Employee', entityId: e.id, fromValue: JSON.stringify(before), toValue: JSON.stringify(diff), reason: why, actorName: TAG } });
    }
    Object.assign(e, diff);
    R.employeesUpdated.push(`${e.employeeCode} ${e.name}: ${Object.entries(diff).map(([k, v]) => `${k} ${JSON.stringify(before[k])} -> ${JSON.stringify(v)}`).join(', ')} (${why})`);
  };
  for (const [seat, chain] of Object.entries(CHAINS)) {
    for (const x of chain) {
      const e = personOfLink(x);
      if (x.code === 'TL448') continue; // today's Team B TL — her record stays as it is
      const data = { department: 'Education', team: SEAT_TEAM(seat) };
      await setEmp(e, data, `holds / held ${seat}`);
    }
  }
  // "Not Working" per Education Team Joinings.xlsx -> Relieved, login off.
  const chainEnd = new Map(); // filled after the chains are built
  const relieve = async () => {
    for (const key of NOT_WORKING) {
      const e = S.who.get(key);
      const lwd = chainEnd.get(key) || null;
      if (e.employmentStatus !== 'Relieved') {
        const before = e.employmentStatus;
        if (COMMIT) {
          await prisma.employee.update({ where: { id: e.id }, data: { employmentStatus: 'Relieved' } });
          await prisma.auditLog.create({ data: { action: 'Employment status set to Relieved (Education Team Joinings.xlsx: Not Working)', entity: 'Employee', entityId: e.id, field: 'employmentStatus', fromValue: before, toValue: 'Relieved', reason: `Last working day ${lwd || 'not recorded'} (seat end). Reversible: set back to ${before}.`, actorName: TAG } });
        }
        e.employmentStatus = 'Relieved';
        R.statusChanges.push(`${e.employeeCode} ${e.name}: ${before} -> Relieved, last working day ${lwd || '(not recorded)'}`);
      }
      const u = e.userId ? S.userById.get(e.userId) : null;
      if (u && u.status === 'Active') {
        if (COMMIT) {
          await prisma.user.update({ where: { id: u.id }, data: { status: 'Inactive' } });
          await prisma.auditLog.create({ data: { action: 'Login disabled (Education Team Joinings.xlsx: Not Working)', entity: 'User', entityId: u.id, field: 'status', fromValue: 'Active', toValue: 'Inactive', reason: `${e.employeeCode} ${e.name} left the seat (last working day ${lwd || 'not recorded'}). Reversible: set status back to Active.`, actorName: TAG } });
        }
        u.status = 'Inactive';
        R.loginsDisabled.push(`${e.employeeCode} ${e.name}: login Active -> Inactive`);
      }
    }
  };

  // ---- activity per person per seat ----
  const act = seatActivity();
  const allAliases = new Map(); Object.entries(CHAINS).forEach(([seat, chain]) => chain.forEach((x) => x.aliases.forEach((a) => push(allAliases, a, seat))));
  const datesFor = (x, seat) => {
    const own = act.filter((a) => x.aliases.includes(a.k) && (a.seat === seat || (!a.seat && (allAliases.get(a.k) || []).every((s) => s === seat))));
    // joinings-sheet dates are firm; tracker / person-level dates lose an isolated outlier
    const firm = own.filter((a) => /joinings/.test(a.src)).map((a) => a.date);
    const soft = trimmed(own.filter((a) => !/joinings/.test(a.src)).map((a) => a.date));
    return { dates: [...new Set([...firm, ...soft])].sort(), srcs: [...new Set(own.map((a) => a.src))] };
  };

  // ---- build each chain ----
  const history = {};
  for (const [seat, chain] of Object.entries(CHAINS)) {
    const runs = chain.map((x) => {
      const e = personOfLink(x);
      const { dates, srcs } = datesFor(x, seat);
      const d0 = doj(e) && doj(e) >= FLOOR ? doj(e) : null;
      const first = minIso(dates[0], d0); const last = dates[dates.length - 1] || null;
      return { x, e, first, last, srcs, n: dates.length, doj: d0, hardStart: x.start ? x.start[0] : null, hardEnd: x.end ? x.end[0] : null, why: [] };
    });
    runs.forEach((run, i) => {
      const prev = runs[i - 1];
      if (i === 0) {
        run.from = run.hardStart || run.first;
        run.why.push(run.hardStart ? `from ${run.x.start[1]}` : `from the first recorded activity on or after ${FLOOR} (${run.srcs.join(', ') || 'none'})`);
      } else {
        const prevEnd = prev.hardEnd || prev.last;
        if (run.hardStart) {
          run.from = run.hardStart; run.why.push(`from ${run.x.start[1]}`);
          if (prev.hardEnd && run.from <= prev.hardEnd) {
            run.from = addDays(prev.hardEnd, 1);
            run.why.push(`seat starts ${run.from}, the day after ${prev.e.name}'s last working day (${prev.hardEnd}); ${run.hardStart} → ${prev.hardEnd} was a handover`);
            R.notes.push(`${seat}: ${prev.e.name} worked to ${prev.hardEnd} and ${run.e.name} joined ${run.hardStart} — the seat changes hands on ${run.from} (handover ${run.hardStart} to ${prev.hardEnd})`);
          }
        } else if (run.first) {
          run.from = maxIso(run.first, prevEnd ? addDays(prevEnd, 1) : null);
          run.why.push(run.from === run.first ? (run.doj && run.doj === run.first ? `from the date of joining ${run.doj}${run.srcs.length ? ` (first activity: ${run.srcs.join(', ')})` : ' (no other dated activity in the files)'}` : `from the first recorded activity (${run.srcs.join(', ')})`) : `from the day after ${prev.e.name}'s last recorded activity (${prevEnd}); earlier rows under ${run.e.name}'s name for this seat were while ${prev.e.name} held it`);
        } else {
          run.from = prevEnd ? addDays(prevEnd, 1) : null;
          run.why.push(`INFERRED: no dated activity in the files — from the day after ${prev.e.name}'s last recorded activity (${prevEnd})`);
          R.notes.push(`${seat}: ${run.e.name}'s start ${run.from} is inferred (day after ${prev.e.name}'s last recorded activity ${prevEnd}); no file gives it`);
        }
        // the previous holder's end
        if (prev.hardEnd) { prev.until = prev.hardEnd; } else {
          const dayBefore = addDays(run.from, -1);
          if (prev.last && dayDiff(prev.last, run.from) > GAP_DAYS + 1) {
            prev.until = prev.last;
            prev.why.push(`until the last recorded activity (${prev.last}); seat vacant ${addDays(prev.last, 1)} → ${dayBefore}`);
            R.gaps.push(`${seat}: vacant ${addDays(prev.last, 1)} → ${dayBefore} (no activity by ${prev.e.name} after ${prev.last}; ${run.e.name} starts ${run.from})`);
          } else { prev.until = dayBefore; prev.why.push(`until the day before ${run.e.name} (${dayBefore})`); }
        }
        if (prev.until && run.from > addDays(prev.until, 1) && prev.hardEnd) R.gaps.push(`${seat}: vacant ${addDays(prev.until, 1)} → ${addDays(run.from, -1)} (${prev.e.name}'s last working day ${prev.until}; ${run.e.name} starts ${run.from})`);
      }
    });
    const lastRun = runs[runs.length - 1];
    if (lastRun.hardEnd) lastRun.until = lastRun.hardEnd;
    else if (lastRun.x.vacantAfter) { lastRun.until = lastRun.last; lastRun.why.push(`until the last recorded activity (${lastRun.last}); seat vacant since (user)`); R.gaps.push(`${seat}: vacant since ${addDays(lastRun.last, 1)} (user: no employee now)`); } else lastRun.until = null;
    if (lastRun.hardEnd) R.gaps.push(`${seat}: vacant since ${addDays(lastRun.hardEnd, 1)}`);
    runs.forEach((run) => {
      if (!run.from) throw new Error(`${seat}: no start date for ${run.e.name}`);
      if (run.until && run.until < run.from) throw new Error(`${seat}: ${run.e.name} ends ${run.until} before starting ${run.from}`);
      chainEnd.set(run.x.code || run.x.key, run.until);
    });
    history[seat] = runs;
    R.chains[seat] = runs.map((r) => `${r.e.name} (${r.from} → ${r.until || 'today'})`).join('  →  ');
    R.seats[seat] = runs.map((r) => ({ who: `${r.e.employeeCode} ${r.e.name}`, from: r.from, to: r.until, basis: r.why.join('; '), activityRows: r.n }));
  }
  await relieve();

  // ---- write the seat rows: EDU-1…10 replaced; stubs removed ----
  const seats = Object.keys(CHAINS);
  const current = await prisma.positionAssignment.findMany({ where: { position: { code: { in: [...seats, 'EDU-11', 'EDU-12', 'EDU-13', 'MFG-8'] } } }, include: { position: { select: { code: true } }, employee: { select: { name: true, employeeCode: true } } } });
  R.before = current.filter((a) => seats.includes(a.position.code)).map((a) => `${a.position.code}: ${a.employee.employeeCode} ${a.employee.name} ${a.fromDate} → ${a.toDate || 'now'}`);
  const stubs = current.filter((a) => ['EDU-11', 'EDU-13'].includes(a.position.code) && a.fromDate === a.toDate);
  const ruthMfg = current.filter((a) => a.position.code === 'MFG-8' && a.employee.employeeCode === 'TL516');
  for (const seat of seats) {
    const pos = S.posByCode.get(seat);
    if (!pos) throw new Error(`seat ${seat} not found`);
    if (COMMIT) {
      await prisma.$transaction(async (txc) => {
        await txc.positionAssignment.deleteMany({ where: { positionId: pos.id } });
        for (const run of history[seat]) {
          await txc.positionAssignment.create({ data: { positionId: pos.id, employeeId: run.e.id, fromDate: run.from, toDate: run.until, note: `Education seat history (${TAG}): ${run.why.join('; ')}`.slice(0, 900) } });
        }
      });
    }
  }
  for (const a of [...stubs, ...ruthMfg]) {
    R.removed.push(`${a.position.code}: ${a.employee.employeeCode} ${a.employee.name} ${a.fromDate} → ${a.toDate || 'now'}${a.position.code === 'MFG-8' ? ' (Ruthvija P moved to EDU-10 — user decision; this 23-Sep entry would overlap her EDU-10 seat from her joining date)' : ' (one-day 23-Sep stub)'}`);
    if (COMMIT) {
      await prisma.positionAssignment.delete({ where: { id: a.id } });
      await prisma.auditLog.create({ data: { action: 'Seat assignment removed (Education seat history)', entity: 'PositionAssignment', entityId: a.id, fromValue: JSON.stringify({ position: a.position.code, employee: a.employee.employeeCode, fromDate: a.fromDate, toDate: a.toDate, note: a.note }), toValue: 'deleted', actorName: TAG } });
    }
  }
  if (COMMIT) await prisma.auditLog.create({ data: { action: 'Education seat history rebuilt (EDU-1…EDU-10)', entity: 'Position', entityId: 'EDU-1…EDU-10', fromValue: JSON.stringify(R.before).slice(0, 4000), toValue: JSON.stringify(R.chains).slice(0, 4000), actorName: TAG } });
  R.segments = seats.reduce((s, k) => s + history[k].length, 0);

  // People the summary calls Not Working who are Active elsewhere: none left.
  R.questions = [
    'EDU-2: the user says V.Gayathri now holds EDU-2, but Education Team Joinings.xlsx shows Geedi Navitha "Working" and no file gives Gayathri\'s start date — Navitha is left as the current EDU-2 holder and V.Gayathri is created but NOT seated. When did Gayathri take EDU-2?',
    `EDU-6: A.Dhathri's start (${history['EDU-6'][3].from}) is inferred — the day after G.Gouthami's last recorded activity; please confirm.`,
    `EDU-10: Ruthvija P is seated from her date of joining (${history['EDU-10'][4].from}); her employee record says "Exited" although she is today's EDU-10 holder — left unchanged; should she be Active?`,
  ];
  report.questions.push(...R.questions);
  S.history = history;
}

// ============================================================================
// STEP 6 — Education clients: location + agreement terms
// ============================================================================
const PLACES = new Set(('hyderabad secunderabad ibrahimpatnam gandipet medchal ghatkesar kompally dundigal maisammaguda dulapally dullapally kandlakoya moinabad shamshabad hayathnagar nagole uppal lb nagar lbnagar dilsukhnagar abids narayanguda gachibowli madhapur kukatpally bachupally chevella shadnagar vikarabad sangareddy patancheru narsapur keesara bibinagar bhongir yadagirigutta nalgonda suryapet kodad miryalaguda khammam sathupalli kothagudem warangal hanamkonda hanmakonda karimnagar jagtial nizamabad kamareddy adilabad mahabubnagar jadcherla siddipet medak mancherial peddapalli vijayawada guntur tenali narasaraopet ongole nellore kavali tirupati chittoor kadapa rajampet anantapur hindupur kurnool nandyal rajahmundry kakinada amalapuram bhimavaram tadepalligudem eluru machilipatnam gudivada visakhapatnam vizag vizianagaram srikakulam tuni chirala bapatla markapur puttur madanapalle srikalahasti gudur proddatur bengaluru bangalore chennai mumbai pune delhi noida nashik kopargaon ahmednagar coimbatore madurai trichy salem erode mysore mysuru mangalore belgaum hubli dharwad kolkata bhopal indore nagpur aurangabad gujarat vadodara anand jaipur chandigarh kerala kochi trivandrum odisha bhubaneswar cuttack rajam narsampet jangaon mulugu bodhan armoor tandur zaheerabad sadasivpet gajwel wanaparthy nagarkurnool gadwal kollapur achampet devarakonda huzurnagar nakrekal thorrur mahabubabad yellandu bhadrachalam palvancha manuguru kagaznagar bellampalli ramagundam godavarikhani sircilla vemulawada metpally korutla nirmal bhainsa khanapur utnoor boath asifabad chennur luxettipet').split(' '));
function cleanLocation(raw) {
  const lines = String(raw || '').split(/\n|\s\/\s|\r/).map((x) => t(x.replace(/\b\d{6}\b|\b\d{3}\s\d{3}\b/g, ' ').replace(/[,\s-]+$/, ''))).filter(Boolean);
  const keep = [];
  for (const l of lines) {
    if (/@|https?:|www\.|\d{7,}|\b(sir|mam|madam|details|floor|room|block|beside|contact|principal|hod|h\.? ?no)\b/i.test(l)) { if (keep.length) break; continue; }
    if (!/[a-z]/i.test(l)) continue;
    keep.push(l.replace(/[,\s]+$/, ''));
    if (keep.length >= 3) break;
  }
  const out = keep.join(', ').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
  return out && out.length <= 100 ? out : (out ? out.slice(0, 100).replace(/,[^,]*$/, '') : null);
}
function suffixPlace(name) {
  const n = t(name);
  const m = n.match(/(?:\s-\s?|-|,|\()\s*([A-Za-z][A-Za-z .]{2,30}?)\s*\)?\s*$/);
  if (!m) return null;
  const s = t(m[1]).replace(/\.$/, '');
  const words = lc(s).split(/[\s.]+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  if (s === s.toUpperCase() && s.replace(/[^A-Z]/g, '').length <= 7 && !PLACES.has(lc(s).replace(/\s/g, ''))) return null; // an acronym "(CMRCET)"
  if (!words.some((w) => PLACES.has(w) || PLACES.has(words.join('')))) return null;
  return titleCase(s);
}
function feeOf(text) {
  const s = lc(text); if (!s) return {};
  const noGst = s.replace(/(\+|and)?\s*(gst)?\s*18\s*"?\s*%?\s*(gst)/g, ' ').replace(/gst\s*[-(]?\s*18\s*%/g, ' gst ');
  let pcts = [...new Set([...noGst.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1])).filter((x) => x > 0))];
  if (pcts.length > 1 && pcts.includes(18)) pcts = pcts.filter((x) => x !== 18);
  if (/month(ly)?\s*(salary|ctc|fixed)|salary of|% ?salary|% ?of (the )?salary/.test(s)) return { text: true };
  if (pcts.length === 1 && pcts[0] <= 15) return { fee: pcts[0] };
  return pcts.length ? { text: true } : {};
}
function guaranteeOf(text) {
  const s = lc(text);
  const m = s.match(/(\d+|one|two|three|six)\s*-?\s*(months?|days)\s*(of\s*)?(free\s*)?replac/) || s.match(/replacement\s*[:-]?\s*(\d+|one|two|three|six)\s*-?\s*(months?|days)/);
  if (!m) return null;
  const n = { one: 1, two: 2, three: 3, six: 6 }[m[1]] || Number(m[1]);
  return m[2].startsWith('day') ? `${n} Days` : `${n} Month${n > 1 ? 's' : ''}`;
}
function setNoteLine(notes, prefix, line) {
  const lines = String(notes || '').split('\n').filter(Boolean);
  const i = lines.findIndex((x) => x.startsWith(prefix));
  if (i >= 0) lines[i] = line; else lines.push(line);
  return lines.join('\n');
}
function registerRows() {
  if (S.registers) return S.registers;
  const out = [];
  const read = (label, file, sheet, spec) => {
    const g = grid(file, sheet, false);
    let last = '';
    for (let i = 1; i < g.length; i += 1) {
      const r = g[i]; if (!r.some((c) => t(c))) continue;
      const college = t(r[spec.college]); const cont = !college; if (college) last = college;
      out.push({ label, line: i + 1, college: college || last, cont, requirement: t(r[spec.req]), status: t(r[spec.status]), location: spec.loc != null ? String(r[spec.loc] || '') : '', agreement: spec.agr != null ? String(r[spec.agr] || '') : '' });
    }
  };
  read('Edu-1', FILES.edu1, 'Sheet1', { college: 0, req: 6, status: 15, loc: 3, agr: 9 });
  read('Edu-2', FILES.edu2, 'Sheet1', { college: 0, req: 5, status: 13, loc: 3, agr: 8 });
  read('BDE', FILES.bde, 'Educational Requirement Sheet', { college: 0, req: 1, status: 5, loc: 3 });
  S.registers = out;
  return out;
}
async function step6() {
  const R = { location: { filled: 0, fromSheet: 0, fromNameSuffix: 0, alreadySet: 0, noUsableText: [], samples: [] }, agreement: { rows: 0, skippedActiveSignedSheet: 0, activated: [], draftTermsStored: 0, feeSet: 0, guaranteeSet: 0, samples: [] } };
  report.steps['6_clients'] = R;
  const plan = new Map(); // clientId -> { data, c }
  const P = (c) => { if (!plan.has(c.id)) plan.set(c.id, { c, data: {} }); return plan.get(c.id); };
  // (a) location
  for (const r of registerRows()) {
    if (r.cont) continue;
    const m = matchCollege(r.college); if (!m.c || m.c.ownerDepartment !== 'Education') continue;
    const c = m.c; if (!blank(c.location) || P(c).data.location) continue;
    const loc = cleanLocation(r.location);
    if (loc) { P(c).data.location = loc; R.location.fromSheet += 1; if (R.location.samples.length < 8) R.location.samples.push(`${c.name} <- "${loc}" (${r.label} line ${r.line})`); } else if (t(r.location)) R.location.noUsableText.push(`${c.name}: "${t(r.location).slice(0, 50)}" (${r.label} line ${r.line})`);
  }
  S.clients.filter((c) => c.ownerDepartment === 'Education').forEach((c) => {
    if (!blank(c.location) || (plan.get(c.id) && plan.get(c.id).data.location)) { if (!blank(c.location)) R.location.alreadySet += 1; return; }
    const fromStreet = !blank(c.street) ? cleanLocation(c.street) : null; // batch 2 kept the register's Location in street
    const suf = suffixPlace(c.name);
    const loc = fromStreet || suf;
    if (!loc) return;
    P(c).data.location = loc;
    if (fromStreet) R.location.fromSheet += 1; else { R.location.fromNameSuffix += 1; if ((R.location.suffixSamples || []).length < 15) (R.location.suffixSamples = R.location.suffixSamples || []).push(`${c.name} -> ${loc}`); }
  });
  // (b) agreement terms (Edu-1 col J, Edu-2 col I) — never over the signed sheet
  for (const r of registerRows().filter((x) => ['Edu-1', 'Edu-2'].includes(x.label) && t(x.agreement))) {
    R.agreement.rows += 1;
    const m = matchCollege(r.college); if (!m.c) continue;
    const c = m.c;
    if (c.agreementStatus === 'ACTIVE') { R.agreement.skippedActiveSignedSheet += 1; continue; }
    const text = t(r.agreement);
    const p = P(c);
    const cur = p.data.commercialNotes !== undefined ? p.data.commercialNotes : c.commercialNotes;
    if (!String(cur || '').includes(text.slice(0, 60))) p.data.commercialNotes = setNoteLine(cur, `Agreement (${r.label} sheet, line ${r.line}):`, `Agreement (${r.label} sheet, line ${r.line}): ${text.slice(0, 400)}`);
    const f = feeOf(text);
    if (f.fee != null && c.agreementFeePercent !== f.fee) { p.data.agreementFeePercent = f.fee; R.agreement.feeSet += 1; }
    const g = guaranteeOf(text); if (g && c.guaranteePeriod !== g) { p.data.guaranteePeriod = g; R.agreement.guaranteeSet += 1; }
    const signed = /\bsigned\b|agreement (is )?done|done agreement|agreement completed/.test(lc(text)) && !/not signed|under pipe|pipeline|pending|no agreement/.test(lc(text));
    if (signed) {
      const d = datesIn(text).filter((x) => x <= TODAY).sort().pop();
      p.data.agreementStatus = 'ACTIVE';
      if (d) { p.data.agreementStart = d; p.data.agreementSignedAt = at(d, '00'); p.data.agreementActivatedAt = at(d, '00'); }
      R.agreement.activated.push(`${c.name}: "${text.slice(0, 70)}"${d ? ` -> signed ${d}` : ' (no date readable)'} [${r.label} line ${r.line}]`);
    } else R.agreement.draftTermsStored += 1;
    if (R.agreement.samples.length < 6) R.agreement.samples.push(`${c.name}: ${signed ? 'ACTIVE' : 'DRAFT'} fee ${f.fee != null ? `${f.fee}%` : '(text)'}${g ? `, replacement ${g}` : ''} — "${text.slice(0, 60)}"`);
  }
  for (const { c, data } of plan.values()) {
    const diff = {}; Object.entries(data).forEach(([k, v]) => { const cur = c[k]; const same = v instanceof Date ? (cur instanceof Date && cur.getTime() === v.getTime()) : cur === v; if (!same) diff[k] = v; });
    if (!Object.keys(diff).length) continue;
    if (diff.location) R.location.filled += 1;
    if (COMMIT) {
      await prisma.client.update({ where: { id: c.id }, data: diff });
      await prisma.auditLog.create({ data: { action: 'Education client location / terms from sheets', entity: 'Client', entityId: c.id, fromValue: JSON.stringify(Object.fromEntries(Object.keys(diff).map((k) => [k, c[k]]))).slice(0, 1500), toValue: JSON.stringify(diff).slice(0, 1500), actorName: TAG } });
    }
    Object.assign(c, diff);
  }
  R.agreement.activatedCount = R.agreement.activated.length;
  R.educationClients = S.clients.filter((c) => c.ownerDepartment === 'Education').length;
  R.educationClientsWithLocationAfter = S.clients.filter((c) => c.ownerDepartment === 'Education' && !blank(c.location)).length;
}

// ============================================================================
// STEP 4 — new profiles: Sheet5 + mamatha mam Profiles
// ============================================================================
async function step4() {
  const R = { sheet5: { rows: 0, existingByPhone: 0, created: 0, applications: 0, appsExisting: 0 }, mamatha: { rows: 0, existingByPhone: 0, created: 0 }, wsSkipped: 'WS repeats Sheet5 (36 of 38 phones) — not imported', noPhone: [] };
  report.steps['4_new_profiles'] = R;
  const run = async (sheet, C, source, out, withApps) => {
    const g = grid(FILES.interview, sheet);
    for (let i = 1; i < g.length; i += 1) {
      const r = g[i]; const name = tidyName(t(r[C.name])); if (!name) continue;
      out.rows += 1;
      const phones = phonesAll(r[C.phone]);
      const email = C.mail != null && /@/.test(t(r[C.mail])) ? lc(r[C.mail]).replace(/\s+/g, '') : null;
      const all = [...new Set(phones.flatMap((p) => S.byPhone.get(p) || []))];
      let cand = all[0] || (email ? S.byEmail.get(email) : null);
      const fill = { education: t(r[C.qual]) || null, specialization: t(r[C.branch]) || null, experienceYears: years(r[C.exp]), currentSalary: t(r[C.cur]) || null, expectedSalary: t(r[C.exp2]) || null, location: t(r[C.loc]) || null, preferredLocation: t(r[C.pref]) || null, noticePeriod: t(r[C.notice]) || null };
      if (cand) out.existingByPhone += 1;
      else {
        if (!phones.length && !email) {
          // no contact: only when nobody of exactly this name exists already
          const same = S.cands.find((c) => nkey(c.name) === nkey(name));
          if (same) { R.noPhone.push(`${sheet} line ${i + 1} "${name}" — no phone; a candidate of exactly this name exists, not duplicated`); continue; }
          R.noPhone.push(`${sheet} line ${i + 1} "${name}" — no phone/email; created without one`);
        }
        cand = await createCandidate({ name, phone: phones[0] || null, email, ...fill, source, firstSource: source }, R); out.created += 1;
      }
      if (!withApps) continue;
      const college = t(r[C.college]); if (!college) continue;
      const client = await ensureClient(college, R);
      if (!client) { bump(out, 'collegeCellNotACollege'); continue; }
      const date = firstDate(r[C.date]) || firstDate(r[C.date2]) || '2026-07-01';
      const statusText = t(r[C.status]);
      const st = (mapStatus(statusText) || { stage: 'RECRUITER_REVIEW' }).stage;
      const hasApp = appAt(all.length ? all : [cand], client);
      if (hasApp) { out.appsExisting += 1; noteSheetDate(hasApp, date); continue; }
      const req = await ensureReq(client, t(r[C.branch]), `${source} (${FILES.interview})`, date, R);
      const app = await createApp(cand, req, st, { source, firstSource: source, createdAt: at(date) }, R);
      out.applications += 1; noteSheetDate(app, date);
      const rec = personOf(r[C.rec]); const e = rec.status === 'unique' ? S.empById.get(rec.hits[0].id) : null;
      await stageEvent(app, null, st, { tag: T7, date, comment: `${sheet}: ${[t(r[C.s1]), statusText].filter(Boolean).join(' — ')}`.slice(0, 500) });
      if (COMMIT) await prisma.applicationFollowUp.create({ data: followUpData(app, { tag: T7, date, ownerName: e ? e.name : t(r[C.rec]) || null, ownerUserId: activeLogin(e), purpose: `Education sourcing — ${sheet}`, outcome: STAGE_ACTION[st], notes: [t(r[C.s1]) && `Status-1: ${t(r[C.s1])}`, statusText && `Status-2: ${statusText}`, `College as written: ${college}`].filter(Boolean).join('\n'), completedNote: sheet }) });
    }
  };
  await run('Sheet5', { name: 0, phone: 1, qual: 2, branch: 3, exp: 6, cur: 8, exp2: 9, loc: 10, pref: 11, notice: 12, s1: 15, status: 16, college: 19, date: 15, date2: 20, rec: 22 }, 'Education sourcing — Sheet5', R.sheet5, true);
  await run('mamatha mam Profiles', { name: 1, phone: 2, mail: 3, qual: 4, branch: 5, exp: 9, cur: 10, exp2: 11, loc: 12, pref: 13, notice: 14, s1: 16, status: 17 }, 'Education sourcing — mamatha mam Profiles', R.mamatha, false);
}

// ============================================================================
// STEP 9 / 8 — Team A joinings, Team B tracker
// ============================================================================
const TEAM_A_REC = { swathi: 'TL371', bsneha: 'TL471', pranayini: 'TL442', gnavitha: 'TL507', saisirisha: 'TL448', psireesha: 'TL501', girija: 'GIRIJA', tsowmya: 'TL504', mnavya: 'TL483' };
const TEAM_A_TL = { anjali: 'TL433', dusha: 'TL484', usha: 'TL484' };
const TRACKER_REC = { divya: 'TL458', krenuka: 'TL487', tejasri: 'TL463', archana: 'TL488', suma: 'TL505', manideep: 'TL457', psupriya: 'TL480', knaveena: 'TL470', niharika: 'TL465', lakshmi: 'TL425', kjhanavi: 'TL499', ganitha: 'TL512' };
const empOf = (key) => S.who.get(key) || S.empByCode.get(key);
const seatOfCell = (v) => { const m = lc(v).match(/edu\W*(\d{1,2})/); return m ? `EDU-${Number(m[1])}` : null; };
function joinStatus(v, joinIso) {
  const s = lc(v);
  if (!s) return { joined: true, note: 'Joined — current status not recorded' };
  if (/^drop/.test(s)) return { joined: false, note: 'Dropped — did not join' };
  if (/^contin/.test(s)) return { joined: true, note: 'Joined — still continuing' };
  const d = typeof v === 'number' ? serial(v) : firstDate(v);
  if (d) return { joined: true, note: `Joined — left on ${d}` };
  if (MON[s.slice(0, 3)]) return { joined: true, note: `Joined — left in ${titleCase(v)}` };
  return { joined: true, note: `Joined — status "${t(v)}"` };
}
async function step9() {
  const R = { rows: 0, joinings: 0, drops: 0, perRecruiter: {}, candidates: { matched: 0 }, applications: { existing: 0 }, stageChanged: 0, alreadyJoined: 0, conflicts: [], dateFixes: [], invoicesNotLinked: 'invoice numbers kept in the follow-up notes only (invoices are not touched)' };
  report.steps['9_teamA_joinings'] = R;
  const g = grid(FILES.teamA, 'Sheet2');
  const touched = new Set();
  for (let i = 1; i < g.length; i += 1) {
    const r = g[i]; const name = t(r[0]); if (!name) continue;
    R.rows += 1;
    const recKey = TEAM_A_REC[letters(r[9])]; const tlKey = TEAM_A_TL[letters(r[10])];
    if (!recKey || !tlKey) throw new Error(`Team A joinings line ${i + 1}: recruiter "${t(r[9])}" / TL "${t(r[10])}" not mapped`);
    const rec = empOf(recKey); const tl = empOf(tlKey);
    const seat = seatOfCell(r[12]) || (recKey === 'TL448' ? 'EDU-3' : null);
    const iv = firstDate(r[6]); let jd = firstDate(r[7]);
    if (jd && iv && jd < iv && jd.slice(4) === iv.slice(4)) { R.dateFixes.push(`line ${i + 1}: joined date ${jd} is before the interview ${iv} — year typo, read as ${iv.slice(0, 4)}${jd.slice(4)}`); jd = `${iv.slice(0, 4)}${jd.slice(4)}`; }
    const st = joinStatus(r[11], jd || iv);
    if (st.joined) { R.joinings += 1; bump(R.perRecruiter, `${seat} ${rec.name}`); } else R.drops += 1;
    // candidate
    const phones = phonesAll(r[1]);
    let { cand, list, phoneOf } = candByPhone(phones, name);
    const fill = { education: t(r[2]) || null, specialization: t(r[3]) || null };
    // application at the college
    const client = await ensureClient(r[5], R);
    if (!client) throw new Error(`Team A joinings line ${i + 1}: college "${t(r[5])}" not readable`);
    let app = cand ? appAt(list, client) : null;
    if (app) cand = S.candById.get(app.candidateId);
    if (cand) { R.candidates.matched += 1; await fillBlanks(cand, fill, R); } else cand = await createCandidate({ name: tidyName(name), phone: phoneOf ? null : phones[0] || null, ...fill, source: 'Education Team A joinings sheet', firstSource: 'Education Team A joinings sheet' }, R.candidates);
    if (!app) {
      const req = await ensureReq(client, t(r[3]), 'the Education Team A joinings sheet', iv || jd, R, seat);
      app = await createApp(cand, req, 'INTERVIEW_COMPLETED', { source: 'Education Team A joinings sheet', firstSource: 'Education Team A joinings sheet', interviewAt: iv ? at(iv, '10') : null, createdAt: at(iv || jd || '2026-01-01') }, R.applications);
    } else R.applications.existing += 1;
    noteSheetDate(app, jd || iv);
    const want = st.joined ? 'JOINED' : 'REJECTED';
    const dec = decide(app.stage, want, st.joined ? '' : 'drop');
    if (COMMIT && !touched.has(app.id)) {
      touched.add(app.id);
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: app.id, actorName: T9 } });
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: app.id, createdByName: T9 } });
    }
    const salary = Number(String(r[8]).replace(/[^\d.]/g, '')) || null;
    if (dec === 'apply') {
      const from = app.stage;
      await setStage(app, want, { tag: T9, date: jd || iv, action: st.joined ? 'Joined' : 'Did not join', comment: st.note, side: 'Candidate', category: st.joined ? null : 'Did Not Join', detail: st.joined ? null : 'Dropped (Team A joinings sheet)', seat, role: 'Recruiter' }, { joinedAt: st.joined ? jd : null, joiningDate: jd, decline: !st.joined, appData: { joiningStatus: st.joined ? 'Joined' : 'Dropped', ...(salary ? { offeredCtc: salary * 12 } : {}) } });
      R.stageChanged += 1; bump(R, `from_${from}`);
    } else if (dec === 'same') {
      R.alreadyJoined += st.joined ? 1 : 0;
      const data = st.joined ? { joiningStatus: 'Joined', ...(jd && !app.joinedAt ? { joinedAt: at(jd), joiningDate: jd } : {}) } : { joiningStatus: 'Dropped' };
      if (COMMIT) await prisma.application.update({ where: { id: app.id }, data }); Object.assign(app, data);
    } else R.conflicts.push(`line ${i + 1} ${name} @ ${client.name}: sheet ${st.joined ? 'Joined' : 'Drop'}, DB ${app.stage} — left as it is`);
    if (COMMIT) {
      const notes = [`College: ${t(r[5])}`, `Qualification: ${t(r[2])} ${t(r[3])}`.trim(), iv && `Interview date: ${iv}`, jd && `Joined date: ${jd}`, salary && `Salary: ₹${salary.toLocaleString('en-IN')} per month`, t(r[4]) && `Invoice no: ${t(r[4])}`, `Status: ${st.note}`, phoneOf && `The sheet's phone belongs to ${phoneOf} — not copied.`].filter(Boolean).join('\n');
      await prisma.applicationFollowUp.create({ data: followUpData(app, { tag: T9, date: jd || iv, ownerName: rec.name, ownerUserId: activeLogin(rec), tlName: tl.name, tlUserId: activeLogin(tl), seat, purpose: 'Education Team A joining', notes, outcome: st.joined ? 'Joined' : 'Did not join', completedNote: 'Education Team A joinings sheet' }) });
    }
  }
}

function trackerStage(r) {
  const parts = [t(r[17]), t(r[16]), t(r[15])].filter(Boolean); // 2nd round, 1st round, status
  const text = parts[0] || '';
  const all = lc(parts.join(' | ') + ' | ' + t(r[19]));
  const s = lc(text);
  if (!s) return null;
  if (/won'?t ?join|wont ?join|not ?join/.test(s)) return { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Join', detail: text, decline: true };
  if (/\bjoined\b/.test(s)) return { stage: 'JOINED' };
  if (/reject|not selected|not eligible|rejetced/.test(s)) { const m = rejectMeta(all); return { stage: 'REJECTED', side: m.side, category: m.side === 'Candidate' ? m.category : (/not eligible/.test(s) ? 'Not Eligible' : m.category), detail: [text, t(r[19])].filter(Boolean).join(' — ') }; }
  const ms = mapStatus(text);
  if (/sele?c?t?ed|slected|selcted|seleced/.test(s) && !/offline demo|demo|2nd|second|physical|round|labs|offline/.test(s)) return { stage: 'SELECTED' };
  if (ms && ms.stage) return { stage: ms.stage };
  if (/select|slect|selcted|seleced/.test(s)) return { stage: 'INTERVIEW_COMPLETED', detail: text };
  if (/waiting|feed ?back|completed/.test(s)) return { stage: 'INTERVIEW_COMPLETED' };
  if (/resch|schedul/.test(s)) return { stage: 'INTERVIEW_SCHEDULED' };
  if (/hold/.test(s)) return { stage: 'HOLD' };
  return null;
}
async function step8() {
  const R = { rows: 0, perSeatRecruiter: {}, candidates: { byPhone: 0, createdNoPhone: 0 }, applications: { existing: 0 }, coveredByTeamBJoinings: 0, noCollege: 0, stages: {}, stageChanged: 0, notAhead: {}, conflicts: [], unmapped: {}, events: 0, followUps: 0, clientMatches: {} };
  report.steps['8_teamB_tracker'] = R;
  const g = grid(FILES.tracker, 'Sheet1');
  const tb = new Set((await prisma.applicationFollowUp.findMany({ where: { createdByName: TB }, select: { applicationId: true } })).map((x) => x.applicationId));
  if (COMMIT) { await prisma.applicationStageEvent.deleteMany({ where: { actorName: T8 } }); await prisma.applicationFollowUp.deleteMany({ where: { createdByName: T8 } }); }
  const anjali = S.empByCode.get('TL433'); const sai = S.empByCode.get('TL448');
  for (let i = 1; i < g.length; i += 1) {
    const r = g[i]; const name = tidyName(t(r[1])); if (!name) continue;
    R.rows += 1;
    const recKey = TRACKER_REC[letters(r[18]).replace(/\s/g, '')];
    if (!recKey) throw new Error(`tracker line ${i + 1}: recruiter "${t(r[18])}" not mapped`);
    const rec = empOf(recKey);
    const seat = seatOfCell(r[20]);
    const date = firstDate(r[0]) || firstDate(r[14]);
    const iv = firstDate(r[14]) || date;
    bump(R.perSeatRecruiter, `${seat} ${rec.name}`);
    const tl = date && date >= '2026-06-17' ? sai : anjali;
    // candidate by phone (the phone must belong to this name)
    const phones = phonesAll(r[2]);
    let { cand, list, phoneOf } = candByPhone(phones, name);
    const fill = { education: t(r[3]) || null, specialization: t(r[4]) || null, experienceYears: years(r[5]), currentSalary: t(r[6]) || null, expectedSalary: t(r[7]) || null, location: t(r[8]) || null, noticePeriod: t(r[9]) || null };
    const college = t(r[11]);
    const m = college ? matchCollege(college) : { how: 'blank' };
    if (college && !R.clientMatches[college]) R.clientMatches[college] = m.c ? `${m.c.name} [${m.how}]` : (m.notACollege ? 'not a college — no application' : 'NEW');
    const client = college ? await ensureClient(college, R) : null;
    let app = cand && client ? appAt(list, client) : null;
    if (app) cand = S.candById.get(app.candidateId);
    if (cand) { R.candidates.byPhone += 1; await fillBlanks(cand, fill, R); } else {
      cand = await createCandidate({ name, phone: phoneOf ? null : (phones[0] || null), ...fill, source: 'Edu 6-10 shared profiles', firstSource: 'Edu 6-10 shared profiles' }, R.candidates);
      if (phoneOf || !phones.length) R.candidates.createdNoPhone += 1;
      if (phoneOf) (R.phoneOfSomeoneElse = R.phoneOfSomeoneElse || []).push(`line ${i + 1} "${name}": the phone is ${phoneOf}'s — new record without a phone`);
    }
    if (!client) { R.noCollege += 1; continue; }
    const s = trackerStage(r);
    if (s && app) noteFinal(app, s.stage, date);
    if (!s) bump(R.unmapped, t(r[15]) || '(blank)');
    if (app && tb.has(app.id)) { R.coveredByTeamBJoinings += 1; noteSheetDate(app, date); continue; }
    let from = null;
    if (!app) {
      const req = await ensureReq(client, t(r[4]), 'the Edu 6-10 shared profiles tracker', iv, R, seat);
      const st0 = s ? s.stage : 'INTERVIEW_SCHEDULED';
      app = await createApp(cand, req, st0, { source: 'Edu 6-10 shared profiles', firstSource: 'Edu 6-10 shared profiles', interviewAt: iv ? at(iv, '10') : null, interviewMode: t(r[12]) ? titleCase(r[12]) : null, createdAt: at(date || iv || '2026-01-01') }, R.applications);
      if (st0 === 'JOINED' || st0 === 'REJECTED') { const d = stageData(st0, { joinedAt: null, decline: s && s.decline }); delete d.stage; if (COMMIT) await prisma.application.update({ where: { id: app.id }, data: d }); Object.assign(app, d); }
      bump(R.stages, st0);
      await stageEvent(app, null, st0, { tag: T8, date, comment: `Edu 6-10 tracker line ${i + 1}: ${[t(r[15]), t(r[16]), t(r[17])].filter(Boolean).join(' / ')}`, side: s && s.side, category: s && s.category, detail: s && s.detail, seat, role: 'Recruiter' });
      R.events += 1;
    } else {
      R.applications.existing += 1;
      const dec = s ? decide(app.stage, s.stage, `${s.detail || ''} ${s.decline ? 'wont join' : ''}`) : 'none';
      if (dec === 'apply') {
        from = app.stage;
        await setStage(app, s.stage, { tag: T8, date, comment: `Edu 6-10 tracker line ${i + 1}: ${[t(r[15]), t(r[16]), t(r[17])].filter(Boolean).join(' / ')}`, side: s.side, category: s.category, detail: s.detail, seat, role: 'Recruiter' }, { decline: s.decline });
        R.stageChanged += 1; bump(R.stages, `${from} -> ${s.stage}`); R.events += 1;
      } else if (dec === 'conflict') R.conflicts.push(`line ${i + 1} ${name} @ ${client.name}: sheet ${s.stage} ("${t(r[17]) || t(r[16]) || t(r[15])}"), DB ${app.stage} — left`);
      else if (dec !== 'same' && dec !== 'none') bump(R.notAhead, `${s.stage} (sheet) vs ${app.stage} (DB)`);
    }
    noteSheetDate(app, date);
    if (COMMIT) {
      const notes = [`Position: ${t(r[20])}`, `College as written: ${college}`, t(r[15]) && `Interview status: ${t(r[15])}`, t(r[16]) && `1st round: ${t(r[16])}`, t(r[17]) && `2nd round: ${t(r[17])}`, t(r[19]) && `Status 2: ${t(r[19])}`, t(r[13]) && `Offered salary: ${t(r[13])}`, iv && `Interview date: ${iv}`, t(r[12]) && `Mode: ${t(r[12])}`].filter(Boolean).join('\n');
      await prisma.applicationFollowUp.create({ data: followUpData(app, { tag: T8, date, ownerName: rec.name, ownerUserId: activeLogin(rec), tlName: tl.name, tlUserId: activeLogin(tl), seat, purpose: 'Education Team B interview', notes, outcome: s ? STAGE_ACTION[s.stage] : t(r[15]) || null, completedNote: 'Edu 6-10 shared profiles' }) });
    }
    R.followUps += 1;
  }
}

// ============================================================================
// STEP 2 — BDE-Edu ProfileScreening column S: Joined / Will Join
// ============================================================================
function bdeRef(name, qual, branch, exp, loc, client) {
  const spec = t(branch).length > 60 ? '' : t(branch);
  const parts = [tidyName(name), t(qual), spec, t(exp), t(loc), t(client)].map((x) => nkey(x)).join('|');
  return `R${crypto.createHash('sha1').update(parts).digest('hex').slice(0, 14)}`;
}
async function step2() {
  const R = { rows: 0, rowsMatched: 0, joinedRows: 0, willJoinRows: 0, noCandidate: [], noApplication: [], toJoined: 0, toOfferAccepted: 0, already: 0, joinedWithDate: 0, joinedWithoutDate: 0, fromStages: {}, conflicts: [], rejectedToJoined: [], events: 0 };
  report.steps['2_bde_joinings'] = R;
  const g = grid(FILES.bdePS, 'ProfileScreening', false);
  const best = new Map(); // app -> { want, line, date, joined }
  for (let i = 1; i < g.length; i += 1) {
    const r = g[i]; if (!t(r[2]) || !t(r[1])) continue;
    R.rows += 1;
    const cand = (S.byRef.get(bdeRef(r[2], r[4], r[5], r[6], r[9], r[1])) || [])[0];
    const s18 = letters(r[18]);
    const want = s18 === 'joined' ? 'JOINED' : s18 === 'willjoin' ? 'OFFER_ACCEPTED' : null;
    if (want === 'JOINED') R.joinedRows += 1; if (want === 'OFFER_ACCEPTED') R.willJoinRows += 1;
    if (!cand) { if (want) R.noCandidate.push(`line ${i + 1} ${t(r[2])} @ ${t(r[1])} (${t(r[18])})`); continue; }
    R.rowsMatched += 1;
    const apps = S.appsByCand.get(cand.id) || [];
    const app = apps.find((a) => { const q = S.reqById.get(a.requirementId); const c = q && S.clientById.get(q.clientId); return c && nkey(c.name) === nkey(r[1]); }) || (apps.length === 1 ? apps[0] : null);
    const rowDate = firstDate(r[0]) || firstDate(r[3]);
    if (app) { noteSheetDate(app, rowDate); const ms = mapStatus(t(r[19]) || t(r[18])); if (ms) noteFinal(app, ms.stage, rowDate); }
    if (!want) continue;
    if (!app) { R.noApplication.push(`line ${i + 1} ${t(r[2])} @ ${t(r[1])} (${t(r[18])})`); continue; }
    // "04-Jan-2025 Joined" in the note column (R, index 17)
    // "04-Jan-2025 Joined" in the note columns (R, T or the unheaded U)
    const jm = [r[17], r[19], r[20]].map((v) => String(v || '').match(/(\d{1,2}[\s\-/.]*[a-z]{3,}[\s\-/.,]*\d{2,4}|\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2,4})\s*(?:-\s*)?(?:he |she |candidate )?(?:is )?joined/i)).find(Boolean);
    const jd = jm ? firstDate(jm[1]) : null;
    const prev = best.get(app.id);
    if (!prev || adv(want) > adv(prev.want) || (want === prev.want && (rowDate || '') > (prev.date || ''))) best.set(app.id, { app, want, line: i + 1, date: rowDate, jd, name: t(r[2]), college: t(r[1]), s19: t(r[19]), s17: t(r[17]) });
  }
  for (const x of best.values()) {
    const { app, want } = x;
    const dec = decide(app.stage, want, '');
    if (dec === 'same') {
      R.already += 1;
      if (want === 'JOINED' && app.joiningStatus !== 'Joined') { const d = { joiningStatus: 'Joined', ...(x.jd && !app.joinedAt ? { joinedAt: at(x.jd) } : {}) }; if (COMMIT) await prisma.application.update({ where: { id: app.id }, data: d }); Object.assign(app, d); }
      continue;
    }
    if (dec !== 'apply') { R.conflicts.push(`line ${x.line} ${x.name} @ ${x.college}: column S "${want === 'JOINED' ? 'Joined' : 'Will Join'}", DB ${app.stage}${x.s19 ? ` (Status-2 "${x.s19}")` : ''} — left as it is`); continue; }
    const from = app.stage;
    if (from === 'REJECTED') R.rejectedToJoined.push(`line ${x.line} ${x.name} @ ${x.college}: DB REJECTED -> JOINED (column S "Joined"; Status-2 "${x.s19}")`);
    await setStage(app, want, { tag: T2, date: x.jd || x.date, comment: `BDE-Edu ProfileScreening line ${x.line}, column S "Status - 1": ${want === 'JOINED' ? 'Joined' : 'Will Join'}${x.s17 ? ` — ${x.s17.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` }, { joinedAt: want === 'JOINED' ? x.jd : null, joiningDate: want === 'JOINED' ? x.jd : null });
    if (want === 'JOINED') { R.toJoined += 1; if (x.jd) R.joinedWithDate += 1; else R.joinedWithoutDate += 1; } else R.toOfferAccepted += 1;
    bump(R.fromStages, `${from} -> ${want}`); R.events += 1;
  }
  R.applications = best.size;
}

// ============================================================================
// STEP 7 — catch-ups: Daily Interviews, Profile Screening (Edu), Index Interview
// ============================================================================
// Daily Interviews rows -> application (the batch-2 pairing: phone + college).
let DI_CACHE = null;
function diRows() {
  if (DI_CACHE) return DI_CACHE;
  const g = grid(FILES.interview, 'Daily Interviews ');
  const out = [];
  for (let i = 1; i < g.length; i += 1) {
    const r = g[i]; const name = t(r[0]); if (!name) continue;
    const raw = r[1];
    let phones;
    if (typeof raw === 'number') phones = [phoneKey(String(Math.round(raw)))].filter(Boolean);
    else { const b2 = firstPhone(t(raw)); const f = firstPhone(String(raw || '')); phones = [...new Set([b2, f, ...phonesAll(raw)].filter(Boolean))]; }
    out.push({ line: i + 1, name, phones, college: t(r[12]), spec: t(r[3]), qual: t(r[2]), date: firstDate(r[16]), status: t(r[17]), rec: t(r[18]), tl: t(r[19]), follow: t(r[20]), offered: t(r[14]), joining: firstDate(r[15]), mode: t(r[13]) });
  }
  // attach each row to its application
  out.forEach((x) => {
    x.cands = [...new Set(x.phones.flatMap((p) => S.byPhone.get(p) || []))];
    const cm = x.college ? matchCollege(x.college, true) : { how: 'blank' };
    x.client = cm.c || null;
    if (!x.client || !x.cands.length) return;
    const apps = x.cands.flatMap((c) => S.appsByCand.get(c.id) || []).filter((a) => { const q = S.reqById.get(a.requirementId); if (!q) return false; if (q.clientId === x.client.id) return true; const c = S.clientById.get(q.clientId); return c && (cmp(c.name).startsWith(cmp(x.client.name)) || cmp(x.client.name).startsWith(cmp(c.name))); });
    const title = nkey(x.spec ? `Faculty — ${x.spec}` : 'Faculty');
    x.app = apps.find((a) => nkey(S.reqById.get(a.requirementId).title) === title) || (apps.length === 1 ? apps[0] : apps.find((a) => S.reqById.get(a.requirementId).department === 'Education') || null);
  });
  DI_CACHE = out;
  return out;
}
async function step7() {
  const R = { daily: { rows: 0, pairsWithoutApplication: 0, created: 0, createdByYear: {}, candidateNotInDb: [], noCollege: 0, stageChecked: 0, stageApplied: 0, transitions: {}, conflicts: [], behind: 0, unknownStatus: 0 }, profileScreening: { rows: 0, newPeople: 0, newPeopleList: [], applicationsCreated: 0, stageDiffs: 0, stageApplied: 0, transitions: {}, conflicts: [], keptDbNewer: 0 }, indexInterview: { rows: 0, advanced: 0, list: [], behind: [], note: 'these 7 are Manufacturing-client applications on the BDE "Index Interview Sheet" — changed only because the user approved them by name' } };
  report.steps['7_catch_ups'] = R;
  // ---- (a) Daily Interviews
  const rows = diRows();
  const byPair = new Map();
  rows.forEach((x) => {
    R.daily.rows += 1;
    if (!x.college) { R.daily.noCollege += 1; return; }
    if (x.app) { noteSheetDate(x.app, x.date); const ms = mapStatus(x.status); if (ms) noteFinal(x.app, ms.stage, x.date); }
    const key = x.app ? `app:${x.app.id}` : `new:${x.cands.length ? x.cands[0].id : x.phones[0] || nkey(x.name)}|${nkey(x.college)}`;
    const p = byPair.get(key);
    if (!p || (x.date || '') > (p.date || '') || ((x.date || '') === (p.date || '') && x.line > p.line)) byPair.set(key, x);
  });
  for (const [key, x] of byPair) {
    const sheet = mapStatus(x.status);
    if (key.startsWith('new:')) {
      R.daily.pairsWithoutApplication += 1;
      if (!x.cands.length) { R.daily.candidateNotInDb.push(`line ${x.line} ${x.date || '(no date)'} "${x.name}" @ ${x.college}${x.phones.length ? '' : ' (no phone)'}`); continue; }
      const cand = x.cands.find((c) => nameWords(c.name).some((w) => nameWords(x.name).includes(w))) || x.cands[0];
      const client = x.client || await ensureClient(x.college, R.daily);
      if (!client || NOT_A_COLLEGE.has(nkey(client.name))) { bump(R.daily, 'collegeCellNotACollege'); continue; }
      if (x.app || appAt(x.cands, client)) { bump(R.daily, 'linkedToAnApplicationMadeForAnotherRow'); continue; }
      const req = await ensureReq(client, x.spec, 'the education interview history (Daily Interviews)', x.date || '2022-01-01', R.daily);
      const st = sheet ? sheet.stage : 'INTERVIEW_SCHEDULED';
      const app = await createApp(cand, req, st, { source: 'Education interview sheet', firstSource: 'Education interview sheet', interviewAt: x.date ? at(x.date, '10') : null, joiningDate: st === 'JOINED' ? x.joining : null, createdAt: at(x.date || '2022-01-01') }, R.daily);
      x.app = app; noteSheetDate(app, x.date);
      rows.filter((y) => !y.app && y.cands.includes(cand) && y.client && y.client.id === client.id).forEach((y) => { y.app = app; });
      const meta = st === 'REJECTED' ? rejectMeta(`${x.status} ${sheet && sheet.reason}`) : {};
      await stageEvent(app, null, st, { tag: T7, date: x.date, comment: `Daily Interviews line ${x.line}: "${x.status}"`, side: meta.side, category: meta.category, detail: sheet && sheet.reason });
      bump(R.daily.createdByYear, (x.date || 'undated').slice(0, 4));
      continue;
    }
    const app = x.app;
    if (!sheet) { if (x.status) R.daily.unknownStatus += 1; continue; }
    R.daily.stageChecked += 1;
    const dec = decide(app.stage, sheet.stage, `${x.status} ${sheet.reason || ''}`);
    if (dec === 'apply') {
      const from = app.stage; const meta = sheet.stage === 'REJECTED' ? rejectMeta(`${x.status} ${sheet.reason || ''}`) : {};
      await setStage(app, sheet.stage, { tag: T7, date: x.date, comment: `Daily Interviews line ${x.line}: "${x.status}"`, side: meta.side, category: meta.category, detail: sheet.reason }, { joiningDate: x.joining, joinedAt: sheet.stage === 'JOINED' ? x.joining : null, decline: /won/.test(lc(x.status)) });
      R.daily.stageApplied += 1; bump(R.daily.transitions, `${from} -> ${sheet.stage}`);
    } else if (dec === 'conflict') R.daily.conflicts.push(`line ${x.line} ${x.name} @ ${x.college} (${x.date || 'no date'}): sheet "${x.status}", DB ${app.stage} — left`);
    else if (dec === 'behind') R.daily.behind += 1;
  }
  // ---- (b) Profile Screening (Edu file) — the sheet wins when it is newer
  const g = grid(FILES.interview, 'Profile Screening ');
  const psBest = new Map();
  for (let i = 1; i < g.length; i += 1) {
    const r = g[i]; const name = tidyName(t(r[1])); if (!name) continue;
    R.profileScreening.rows += 1;
    const phones = phonesAll(r[2]); const email = /@/.test(t(r[3])) ? lc(r[3]).replace(/\s+/g, '') : null;
    const all = [...new Set([...phones.flatMap((p) => S.byPhone.get(p) || []), ...(email && S.byEmail.get(email) ? [S.byEmail.get(email)] : [])])];
    let cand = all[0] || null;
    const date = firstDate(r[0]) || firstDate(r[19]);
    const college0 = t(r[17]);
    const client0 = college0 ? matchCollege(college0).c : null;
    if (!cand && !phones.length && !email) {
      // no contact: the same person only when a candidate of exactly this name
      // already has an application at this college; a repeat row of a person
      // this run already created is the same person too
      const same = S.cands.filter((c) => nkey(c.name) === nkey(name));
      cand = (client0 && same.find((c) => appAt([c], client0))) || same.find((c) => c.source === 'Profile screening' && S.psMade && S.psMade.has(c.id)) || null;
      if (cand) bump(R.profileScreening, 'noContactMatchedByNameAndCollege');
    }
    if (!cand) {
      S.psMade = S.psMade || new Set();
      cand = await createCandidate({ name, phone: phones[0] || null, email, education: t(r[4]) || null, specialization: t(r[5]) || null, experienceYears: years(r[9]), currentSalary: t(r[10]) || null, expectedSalary: t(r[11]) || null, location: t(r[12]) || null, preferredLocation: t(r[13]) || null, noticePeriod: t(r[14]) || null, source: 'Profile screening', firstSource: 'Profile screening' }, R.profileScreening);
      S.psMade.add(cand.id);
      R.profileScreening.newPeople += 1; R.profileScreening.newPeopleList.push(`line ${i + 1} ${name} (${date})${phones.length || email ? '' : ' — no phone/email on the sheet'}`);
    }
    const college = t(r[17]); if (!college) continue;
    const client = await ensureClient(college, R.profileScreening);
    if (!client) continue;
    let app = appAt(all.length ? all : [cand], client);
    const statusText = t(r[20]) || t(r[25]);
    const sheet = mapStatus(statusText);
    if (!app) {
      const req = await ensureReq(client, t(r[5]), 'the Profile Screening sheet', date, R.profileScreening);
      const st = sheet ? sheet.stage : 'RECRUITER_REVIEW';
      app = await createApp(cand, req, st, { source: 'Profile screening', firstSource: 'Profile screening', interviewAt: firstDate(r[19]) ? at(firstDate(r[19]), '10') : null, createdAt: at(date || '2026-07-14') }, R.profileScreening);
      R.profileScreening.applicationsCreated += 1;
      const rec = personOf(r[23]); const e = rec.status === 'unique' ? S.empById.get(rec.hits[0].id) : null;
      const tlp = personOf(r[24]); const tle = tlp.status === 'unique' ? S.empById.get(tlp.hits[0].id) : null;
      await stageEvent(app, null, st, { tag: T7, date, comment: `Profile Screening line ${i + 1}: "${statusText}"` });
      if (COMMIT) await prisma.applicationFollowUp.create({ data: followUpData(app, { tag: T7, date, ownerName: e ? e.name : t(r[23]) || null, ownerUserId: activeLogin(e), tlName: tle ? tle.name : t(r[24]) || null, tlUserId: activeLogin(tle), purpose: 'Education profile screening', outcome: STAGE_ACTION[st], notes: [`Interview status: ${t(r[20])}`, t(r[21]) && `Status -1: ${t(r[21])}`, t(r[25]) && `Status: ${t(r[25])}`, t(r[26]) && `Remarks: ${t(r[26])}`, `College as written: ${college}`].filter(Boolean).join('\n'), completedNote: 'Profile Screening sheet' }) });
      noteSheetDate(app, date);
      continue;
    }
    noteSheetDate(app, date);
    if (!sheet) continue;
    noteFinal(app, sheet.stage, date);
    const p = psBest.get(app.id);
    if (!p || (date || '') >= (p.date || '')) psBest.set(app.id, { app, sheet, statusText, date, line: i + 1, name, college });
  }
  for (const x of psBest.values()) {
    const { app, sheet } = x;
    if (app.stage === sheet.stage) continue;
    R.profileScreening.stageDiffs += 1;
    const newer = S.userEvent.get(app.id);
    if (newer && x.date && isoOf(newer) > x.date) { R.profileScreening.keptDbNewer += 1; continue; }
    let dec = decide(app.stage, sheet.stage, `${x.statusText} ${sheet.reason || ''}`);
    // The sheet is the newer record for these 2026 rows: an open stage it
    // reports replaces an open DB stage even when it reads "earlier"
    // (Rescheduled after Waiting for Feedback).
    if (dec === 'behind' && !OFFERISH.has(app.stage)) dec = 'apply';
    // A REJECTED the DB holds with no dated evidence newer than this row (the
    // sheet's own older rows, the tracker, Daily Interviews, BDE sheet) is
    // older than the row: the newer sheet wins. JOINED is never undone.
    if (dec === 'conflict' && app.stage === 'REJECTED' && x.date && !(S.finalDate.get(app.id) >= x.date)) { dec = 'apply'; bump(R.profileScreening, 'rejectedReopenedBySheetNewer'); }
    if (dec === 'apply') {
      const from = app.stage; const meta = sheet.stage === 'REJECTED' ? rejectMeta(`${x.statusText} ${sheet.reason || ''}`) : {};
      await setStage(app, sheet.stage, { tag: T7, date: x.date, comment: `Profile Screening line ${x.line}: "${x.statusText}"`, side: meta.side, category: meta.category, detail: sheet.reason }, {});
      R.profileScreening.stageApplied += 1; bump(R.profileScreening.transitions, `${from} -> ${sheet.stage}`);
    } else R.profileScreening.conflicts.push(`line ${x.line} ${x.name} @ ${x.college}: sheet "${x.statusText}" (${sheet.stage}), DB ${app.stage} — left`);
  }
  // ---- (c) BDE Index Interview Sheet — forward only
  const gi = grid(FILES.bde, 'Index Interview Sheet');
  for (let i = 1; i < gi.length; i += 1) {
    const r = gi[i]; const name = t(r[1]); if (!name) continue;
    R.indexInterview.rows += 1;
    const statusText = t(r[12]) || t(r[7]) || t(r[6]) || t(r[5]);
    const sheet = mapStatus(statusText); if (!sheet) continue;
    const cands = [...new Set(phonesAll(r[3]).flatMap((p) => S.byPhone.get(p) || []))];
    const m = matchCollege(r[2]);
    const app = m.c ? cands.flatMap((c) => S.appsByCand.get(c.id) || []).find((a) => { const q = S.reqById.get(a.requirementId); return q && q.clientId === m.c.id; }) : null;
    if (!app) continue;
    const dec = decide(app.stage, sheet.stage, statusText);
    if (dec === 'apply' && adv(sheet.stage) > adv(app.stage)) {
      const from = app.stage; const meta = sheet.stage === 'REJECTED' ? rejectMeta(`${statusText} ${t(r[13])}`) : {};
      const date = firstDate(r[11]) || firstDate(r[5]);
      await setStage(app, sheet.stage, { tag: T7, date, comment: `BDE Index Interview Sheet line ${i + 1}: "${statusText}"${t(r[13]) ? ` — ${t(r[13]).slice(0, 200)}` : ''}`, side: meta.side, category: meta.category, detail: sheet.reason }, {});
      R.indexInterview.advanced += 1; R.indexInterview.list.push(`line ${i + 1} ${name} @ ${t(r[2])}: ${from} -> ${sheet.stage} ("${statusText}")`);
    } else if (dec !== 'same') R.indexInterview.behind.push(`line ${i + 1} ${name} @ ${t(r[2])}: sheet "${statusText}" (${sheet.stage}), DB ${app.stage} — left`);
  }
}

// ============================================================================
// STEP 5 — old recruiters on the 2022–2025 Daily Interviews applications
// ============================================================================
async function step5() {
  const R = { applications: 0, followUps: 0, ownerLinkedToEmployee: 0, ownerTextOnly: 0, tlLinkedToEmployee: 0, tlTextOnly: 0, ownerUserLinks: 0, tlUserLinks: 0, rowsNoApplication: 0, people: {}, removedPrevious: 0 };
  report.steps['5_old_recruiters'] = R;
  const rows = diRows().filter((x) => x.app && (!x.date || x.date <= '2025-12-31'));
  const byApp = new Map();
  diRows().forEach((x) => { if (!x.app && x.college && (!x.date || x.date <= '2025-12-31')) R.rowsNoApplication += 1; });
  rows.forEach((x) => { const l = byApp.get(x.app.id) || []; l.push(x); byApp.set(x.app.id, l); });
  const who = (raw) => { const m = personOf(raw); return m.status === 'unique' ? S.empById.get(m.hits[0].id) : null; };
  const data = [];
  for (const [appId, list] of byApp) {
    const app = S.appById.get(appId);
    const req = S.reqById.get(app.requirementId);
    if (!req || req.department !== 'Education') continue;
    list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.line - b.line);
    const x = list[list.length - 1];
    const rec = x.rec ? who(x.rec) : null; const tl = x.tl ? who(x.tl) : null;
    [['recruiter', x.rec, rec], ['tl', x.tl, tl]].forEach(([role, raw, e]) => { if (!raw) return; const k = `${role}: ${raw}`; if (!R.people[k]) R.people[k] = { applications: 0, mappedTo: e ? `${e.employeeCode} ${e.name}` : `text only (${personOf(raw).status})` }; R.people[k].applications += 1; });
    if (x.rec) { if (rec) R.ownerLinkedToEmployee += 1; else R.ownerTextOnly += 1; }
    if (x.tl) { if (tl) R.tlLinkedToEmployee += 1; else R.tlTextOnly += 1; }
    const ou = activeLogin(rec); const tu = activeLogin(tl); if (ou) R.ownerUserLinks += 1; if (tu) R.tlUserLinks += 1;
    const others = [...new Set(list.map((y) => y.rec).filter(Boolean))];
    const notes = [`Daily Interviews (${list.length} row${list.length > 1 ? 's' : ''}; latest line ${x.line})`, `Recruiter as written: ${x.rec || '-'}`, `TL as written: ${x.tl || '-'}`, x.status && `Interview status: ${x.status}`, others.length > 1 && `Recruiters on this candidate's rows: ${others.join(', ')}`, x.follow && `Last follow-up: ${x.follow.slice(0, 600)}`].filter(Boolean).join('\n');
    data.push(followUpData(app, { tag: T5, date: x.date, ownerName: rec ? rec.name : (x.rec || null), ownerUserId: ou, tlName: tl ? tl.name : (x.tl || null), tlUserId: tu, purpose: 'Education interview (historical)', outcome: x.status || null, notes, completedNote: 'Education Interview Sheet — Daily Interviews' }));
  }
  R.applications = data.length;
  if (COMMIT) {
    R.removedPrevious = (await prisma.applicationFollowUp.deleteMany({ where: { createdByName: T5 } })).count;
    for (let i = 0; i < data.length; i += 500) {
      await prisma.$transaction([prisma.applicationFollowUp.createMany({ data: data.slice(i, i + 500) })]);
      R.followUps += Math.min(500, data.length - i);
    }
  } else R.followUps = data.length;
  R.peopleTop = Object.entries(R.people).sort((a, b) => b[1].applications - a[1].applications).slice(0, 40).map(([k, v]) => `${k} (${v.applications}) -> ${v.mappedTo}`);
  delete R.people;
}

// ============================================================================
// STEP 1 — requirement statuses
// ============================================================================
function registerStatus(s) {
  const k = nkey(s);
  if (/running/.test(k)) return 'OPEN';
  if (/hold/.test(k)) return 'ON_HOLD';
  if (/norequirement|stop|closed/.test(k)) return 'CLOSED';
  return null;
}
async function step1() {
  const R = { a: { registerRows: 0, matched: 0, changes: [], byTransition: {}, disagreements: [], unmatched: [] }, b: { educationOpenBefore: 0, historyOpen: 0, keptActive2026: 0, closed: 0, closedByKind: {}, keptSamples: [] } };
  report.steps['1_requirement_statuses'] = R;
  const regTarget = new Map(); // reqId -> { want, rows }
  const registerReqIds = new Set();
  for (const r of registerRows()) {
    R.a.registerRows += 1;
    const m = matchCollege(r.college); if (!m.c) { R.a.unmatched.push(`${r.label} line ${r.line} ${r.college}`); continue; }
    const title = r.requirement ? `Faculty — ${r.requirement}`.slice(0, 180) : 'Faculty Requirement';
    const cr = (S.reqsByClient.get(m.c.id) || []).filter((q) => q.department === 'Education');
    const exact = cr.find((q) => nkey(q.title) === nkey(title));
    const hit = exact || cr.find((q) => r.requirement && nkey(q.title).includes(nkey(r.requirement).slice(0, 25)));
    if (!hit) { R.a.unmatched.push(`${r.label} line ${r.line} ${r.college.slice(0, 40)} / ${r.requirement.slice(0, 40)}`); continue; }
    R.a.matched += 1; registerReqIds.add(hit.id);
    const want = registerStatus(r.status); if (!want) continue;
    const cur = regTarget.get(hit.id);
    const row = { want, rows: [`${r.label} ${r.line}`], status: r.status, exact: !!exact };
    if (!cur) { regTarget.set(hit.id, row); continue; }
    if (cur.want === want) { cur.rows.push(`${r.label} ${r.line}`); continue; }
    // two register rows on one requirement: the exact-title row decides
    const winner = row.exact && !cur.exact ? row : cur;
    R.a.disagreements.push(`${hit.reqCode}: ${cur.rows.join(', ')} ("${cur.status}"${cur.exact ? '' : ', partial title match'}) vs ${r.label} line ${r.line} ("${r.status}"${row.exact ? '' : ', partial title match'}) — ${winner.want} used`);
    regTarget.set(hit.id, winner);
  }
  // EDU-0111: named by the user ("Stop Requirement" on the BDE sheet).
  const e111 = S.reqs.find((q) => q.reqCode === 'EDU-0111');
  if (e111) regTarget.set(e111.id, { want: 'CLOSED', rows: ['BDE register (user: EDU-0111 "Stop Requirement")'], status: 'Stop Requirement', exact: true });
  for (const [id, x] of regTarget) {
    const q = S.reqById.get(id);
    if (q.status === x.want) continue;
    R.a.changes.push(`${q.reqCode} ${S.clientById.get(q.clientId).name.slice(0, 45)}: ${q.status} -> ${x.want} (${x.rows.join(', ')}: "${x.status}")`);
    bump(R.a.byTransition, `${q.status} -> ${x.want}`);
    if (COMMIT) {
      await prisma.requirement.update({ where: { id }, data: { status: x.want } });
      await prisma.auditLog.create({ data: { action: 'Requirement status from the Education register', entity: 'Requirement', entityId: id, fromValue: q.status, toValue: x.want, reason: `${x.rows.join(', ')}: "${x.status}"`, actorName: TAG } });
    }
    q.status = x.want;
  }
  // (b) close the history-created requirements with no 2026 activity
  const since = '2026-01-01';
  const bulkDay = (d) => d && isoOf(d) >= '2026-09-22'; // the batch imports' own write dates
  const appActive = (a) => {
    const ds = [isoOf(a.interviewAt), isoOf(a.joinedAt), a.joiningDate, S.sheetDate.get(a.id), isoOf(S.fuMax.get(a.id)), isoOf(S.userEvent.get(a.id))];
    const ev = S.evMax.get(a.id); if (ev && !bulkDay(ev)) ds.push(isoOf(ev));
    if (a.createdAt && !bulkDay(a.createdAt)) ds.push(isoOf(a.createdAt));
    return ds.some((d) => d && d >= since && d <= TODAY);
  };
  const edu = S.reqs.filter((q) => q.department === 'Education');
  R.b.educationOpenBefore = edu.filter((q) => q.status === 'OPEN').length;
  const toClose = [];
  for (const q of edu) {
    if (q.status !== 'OPEN' || registerReqIds.has(q.id)) continue;
    R.b.historyOpen += 1;
    const apps = S.appsByReq.get(q.id) || [];
    if (apps.some(appActive)) { R.b.keptActive2026 += 1; if (R.b.keptSamples.length < 6) R.b.keptSamples.push(`${q.reqCode} ${q.title.slice(0, 40)} @ ${S.clientById.get(q.clientId).name.slice(0, 30)} (${apps.length} apps)`); continue; }
    toClose.push(q);
    bump(R.b.closedByKind, /^EDU-2\d{3}/.test(q.reqCode || '') ? 'EDU-2xxx (BDE profile screening)' : /^EDU-1\d{3}/.test(q.reqCode || '') ? 'EDU-1xxx' : /^EDU-0/.test(q.reqCode || '') ? 'EDU-0xxx (batch 2)' : 'other');
    if (!apps.length) bump(R.b, 'closedWithNoApplications');
  }
  if (COMMIT) {
    for (let i = 0; i < toClose.length; i += 400) {
      const ids = toClose.slice(i, i + 400).map((q) => q.id);
      await prisma.requirement.updateMany({ where: { id: { in: ids } }, data: { status: 'CLOSED' } });
    }
    // the full list, 300 codes per audit row, so the change can be reversed
    for (let i = 0; i < toClose.length; i += 300) {
      await prisma.auditLog.create({ data: { action: 'Old Education history requirements closed (no application activity since 2026-01-01)', entity: 'Requirement', entityId: `${toClose.length} requirements (part ${i / 300 + 1})`, fromValue: 'OPEN', toValue: 'CLOSED', reason: JSON.stringify(toClose.slice(i, i + 300).map((q) => q.reqCode)), actorName: TAG } });
    }
  }
  toClose.forEach((q) => { q.status = 'CLOSED'; });
  R.b.closed = toClose.length;
  R.b.educationOpenAfter = edu.filter((q) => q.status === 'OPEN').length;
  R.b.educationOnHoldAfter = edu.filter((q) => q.status === 'ON_HOLD').length;
}

// ============================================================================
// joining counts per person (the user's two numbers vs the DB)
// ============================================================================
async function joiningCounts() {
  const rows = [];
  const keys = [...new Set([...Object.keys(SUMMARY_COUNTS), ...Object.keys(CHAT_COUNTS)])];
  for (const k of keys) {
    const e = S.who.get(k) || S.empByCode.get(k); if (!e) continue;
    let viaSheets = null; let viaTracker = null;
    if (COMMIT) {
      const cnt = async (tags) => { const fus = await prisma.applicationFollowUp.findMany({ where: { ownerName: e.name, createdByName: { in: tags } }, select: { applicationId: true } }); const ids = [...new Set(fus.map((f) => f.applicationId))]; return ids.length ? prisma.application.count({ where: { id: { in: ids }, stage: 'JOINED' } }) : 0; };
      viaSheets = await cnt([T9, TB]); viaTracker = await cnt([T8]);
    }
    rows.push({ person: `${e.employeeCode} ${e.name}`, summaryExcel: SUMMARY_COUNTS[k] ?? '-', chat: CHAT_COUNTS[k] ?? '-', dbJoinedFromJoiningsSheets: viaSheets === null ? '(commit only)' : viaSheets, dbJoinedOnTrackerRows: viaTracker === null ? '(commit only)' : viaTracker });
  }
  report.joiningCounts = rows;
}

// ============================================================================
async function backup() {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(__dirname, '..', 'backups');
  const base = path.join(dir, `dev.db.before-import-edu-${ts}`);
  fs.copyFileSync(path.join(__dirname, '..', 'prisma', 'dev.db'), base);
  ['-wal', '-shm'].forEach((s) => { const f = path.join(__dirname, '..', 'prisma', `dev.db${s}`); if (fs.existsSync(f)) fs.copyFileSync(f, `${base}${s}`); });
  const snap = `${base}.consistent.db`;
  await prisma.$executeRawUnsafe(`VACUUM INTO '${snap.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  report.backup = { file: base, consistentSnapshot: snap };
  console.error(`backup: ${snap}`);
}

(async () => {
  const t0 = Date.now();
  await load();
  if (COMMIT) await backup();
  report.loaded = { clients: S.clients.length, requirements: S.reqs.length, candidates: S.cands.length, applications: S.apps.length, employees: S.emps.length };
  // step 3 always builds the people map the others use; it only WRITES when selected
  if (STEPS.has(3)) await step3(); else { Object.entries(NEW_PEOPLE).forEach(([k, p]) => { const e = S.emps.find((x) => x.name === p.name && x.department === 'Education'); if (e) S.who.set(k, e); }); Object.values(CHAINS).flat().forEach((x) => { if (x.code) S.who.set(x.code, S.empByCode.get(x.code)); }); }
  if (STEPS.has(6)) await step6();
  if (STEPS.has(4)) await step4();
  if (STEPS.has(9)) { if (!S.who.get('GIRIJA') && !COMMIT) S.who.set('GIRIJA', { id: 'dry-girija', name: 'Girija', employeeCode: '(new)' }); await step9(); }
  if (STEPS.has(8)) await step8();
  if (STEPS.has(2)) await step2();
  if (STEPS.has(7)) await step7();
  if (STEPS.has(5)) await step5();
  if (STEPS.has(1)) await step1();
  await joiningCounts();
  if (COMMIT) await prisma.auditLog.create({ data: { action: 'Education fixes applied', entity: 'Import', entityId: 'import-edu-fixes.js', toValue: JSON.stringify(Object.keys(report.steps)), actorName: TAG } });
  report.seconds = Math.round((Date.now() - t0) / 1000);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  const trim = (v) => (Array.isArray(v) ? (v.length > 12 ? [...v.slice(0, 12), `… ${v.length - 12} more (see --out)`] : v) : (v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v));
  console.log(JSON.stringify(trim(report), null, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
