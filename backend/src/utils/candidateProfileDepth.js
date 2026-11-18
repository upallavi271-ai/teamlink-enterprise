// ---------------------------------------------------------------------------
// CANDIDATE PROFILE DEPTH (founder audit 2026-11-17, all Mandatory): the parts of a candidate profile the ATS did not have.
//
//   Education list        many rows: degree, specialisation, institute, year, score
//   Employment history    many rows: company, title, from, to, current?, CTC (optional), notes
//   Gaps                  more than 3 months between jobs, after education, or since the last job (worked out, never typed)
//   Career progression    "3 jobs in 6 years, Executive -> Senior -> Team Lead, avg tenure 2.0 y" + up / flat / down
//   Title standardisation a normalised title next to the typed one ("Sr. Java Dev" -> "Senior Java Developer"), a rules table
//   Profile summary       AI (utils/ai.js) when it is on, else a rule-based summary from the fields; the last one is kept
//   Tags                  free labels per person; the Candidates list filters by one (?tag=)
//   Custom fields         Admin defines them (text / number / date / select, required?); shown and edited on the profile
//   Parse check           which fields the resume parser read and whether the recruiter later changed them
//
// Tables are created on first use (raw SQL, no migration), like utils/recycleBin.js:
//   CandidateEducation, CandidateEmployment, CandidateTag, CandidateCustomField, CandidateCustomValue, CandidateProfileSummary
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "CandidateEducation" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "degree" TEXT, "specialisation" TEXT,
    "institute" TEXT, "year" TEXT, "score" TEXT, "createdAt" TEXT NOT NULL, "createdByName" TEXT, "updatedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CandidateEducation_candidateId" ON "CandidateEducation" ("candidateId")',
  `CREATE TABLE IF NOT EXISTS "CandidateEmployment" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "company" TEXT, "title" TEXT,
    "fromMonth" TEXT, "toMonth" TEXT, "isCurrent" INTEGER NOT NULL DEFAULT 0, "ctc" TEXT, "notes" TEXT, "createdAt" TEXT NOT NULL, "createdByName" TEXT, "updatedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CandidateEmployment_candidateId" ON "CandidateEmployment" ("candidateId")',
  `CREATE TABLE IF NOT EXISTS "CandidateTag" ("candidateId" TEXT NOT NULL, "tagKey" TEXT NOT NULL, "tag" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
    "createdByName" TEXT, PRIMARY KEY ("candidateId", "tagKey"))`,
  'CREATE INDEX IF NOT EXISTS "CandidateTag_tagKey" ON "CandidateTag" ("tagKey")',
  `CREATE TABLE IF NOT EXISTS "CandidateCustomField" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "type" TEXT NOT NULL, "options" TEXT,
    "required" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "sortOrder" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL, "createdByName" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CandidateCustomValue" ("candidateId" TEXT NOT NULL, "fieldId" TEXT NOT NULL, "value" TEXT, "updatedAt" TEXT NOT NULL,
    "updatedByName" TEXT, PRIMARY KEY ("candidateId", "fieldId"))`,
  `CREATE TABLE IF NOT EXISTS "CandidateProfileSummary" ("candidateId" TEXT PRIMARY KEY, "summary" TEXT NOT NULL, "source" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL, "createdByName" TEXT)`,
];
// Columns added after the first version: ALTER TABLE, a "duplicate column" means it is already there.
const LATER_COLUMNS = [
  ['CandidateEmployment', 'normalisedTitle', 'TEXT'],
];
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      for (const [t, c, type] of LATER_COLUMNS) {
        try { await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ADD COLUMN "${c}" ${type}`); } // eslint-disable-line no-await-in-loop
        catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
      }
      await warmTags();
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const clean = (v, max = 200) => {
  const s = String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

// --- months ----------------------------------------------------------------
// A month is 'YYYY-MM'. "2019", "03/2019", "Mar 2019", "2019-03-15" are all read.
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function toMonth(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (m) return fmt(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return fmt(Number(m[2]), Number(m[1]));
  m = /^([a-z]{3})[a-z]*\.?\s*[',]?\s*(\d{4})$/.exec(s);
  if (m && MON[m[1]]) return fmt(Number(m[2]), MON[m[1]]);
  m = /^(\d{4})$/.exec(s);
  if (m) return fmt(Number(m[1]), 1);
  return null;
}
function fmt(y, mo) {
  if (!(y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12)) return null;
  return `${y}-${String(mo).padStart(2, '0')}`;
}
const monthIndex = (ym) => { const [y, m] = String(ym).split('-').map(Number); return y * 12 + (m - 1); };
const thisMonth = () => { const d = new Date(); return fmt(d.getFullYear(), d.getMonth() + 1); };
const monthLabel = (ym) => { if (!ym) return ''; const [y, m] = ym.split('-').map(Number); return `${Object.keys(MON)[m - 1].replace(/^./, (c) => c.toUpperCase())} ${y}`; };
const yearsText = (months) => { const y = months / 12; return `${Math.round(y * 10) / 10} y`; };

// --- job title standardisation ------------------------------------------------------------------------------------
// One word (or a short phrase) -> the standard word. Lower-case keys; dots are dropped before the lookup.
const TITLE_WORDS = {
  sr: 'Senior', snr: 'Senior', senior: 'Senior', jr: 'Junior', jnr: 'Junior', junior: 'Junior',
  dev: 'Developer', devloper: 'Developer', developer: 'Developer', programmer: 'Developer', coder: 'Developer',
  engg: 'Engineer', engr: 'Engineer', eng: 'Engineer', engineer: 'Engineer',
  mgr: 'Manager', manger: 'Manager', manager: 'Manager', asst: 'Assistant', assistant: 'Assistant', assoc: 'Associate', associate: 'Associate',
  exec: 'Executive', executive: 'Executive', exe: 'Executive', admin: 'Administrator', administrator: 'Administrator',
  tl: 'Team Lead', lead: 'Lead', ld: 'Lead', supervisor: 'Supervisor', spvr: 'Supervisor', head: 'Head', hod: 'Head of Department',
  sw: 'Software', 's/w': 'Software', software: 'Software', swe: 'Software Engineer', se: 'Software Engineer', sse: 'Senior Software Engineer',
  qa: 'QA', hr: 'HR', it: 'IT', ui: 'UI', ux: 'UX', sap: 'SAP', ios: 'iOS', net: '.NET', '.net': '.NET', aws: 'AWS', sql: 'SQL', php: 'PHP', icu: 'ICU', ot: 'OT',
  bde: 'Business Development Executive', bdm: 'Business Development Manager', bd: 'Business Development',
  js: 'JavaScript', javascript: 'JavaScript', reactjs: 'React', 'react.js': 'React', nodejs: 'Node.js', 'node.js': 'Node.js',
  fullstack: 'Full Stack', 'full-stack': 'Full Stack', devops: 'DevOps', mts: 'Member of Technical Staff',
  vp: 'Vice President', avp: 'Assistant Vice President', gm: 'General Manager', agm: 'Assistant General Manager', dgm: 'Deputy General Manager',
  ceo: 'CEO', cto: 'CTO', cfo: 'CFO', coo: 'COO', trainee: 'Trainee', intern: 'Intern', fresher: 'Trainee',
  analyst: 'Analyst', consultant: 'Consultant', officer: 'Officer', staff: 'Staff', nurse: 'Nurse', tech: 'Technician', technician: 'Technician',
};
// Phrases first (whole-title rewrites before the word table).
const TITLE_PHRASES = [
  [/\bteam\s*leader\b/gi, 'team lead'], [/\bt\.?\s*l\.?\b(?=\s|$)/gi, 'tl'], [/\bs\/w\b/gi, 'software'], [/\bdev\s*ops\b/gi, 'devops'],
  [/\bfull[\s-]*stack\b/gi, 'fullstack'], [/\bsoftware\s+dev\b/gi, 'software developer'],
];
// Level of a standard title: [pattern, rank, label]. The first that matches wins, so the longer ones come first.
const LEVELS = [
  [/\b(ceo|cto|cfo|coo|chief|president|founder|director)\b/i, 9, 'Director'],
  [/\bvice president\b/i, 8, 'Vice President'],
  [/\b(general manager|head of department|head)\b/i, 7, 'Head'],
  [/\bsenior manager\b/i, 6, 'Senior Manager'],
  [/\bassistant manager\b/i, 4.5, 'Assistant Manager'],
  [/\bmanager\b/i, 5, 'Manager'],
  [/\b(team lead|lead|supervisor|principal|architect)\b/i, 4, 'Team Lead'],
  [/\bsenior\b/i, 3, 'Senior'],
  [/\b(junior|associate|assistant)\b/i, 1, 'Junior'],
  [/\b(trainee|intern|apprentice)\b/i, 0, 'Trainee'],
];
const BASE_RANK = 2;
function normaliseTitle(raw) {
  let s = clean(raw, 120);
  if (!s) return null;
  TITLE_PHRASES.forEach(([re, to]) => { s = s.replace(re, to); });
  const words = s.split(/[\s,]+/).filter(Boolean);
  const out = [];
  words.forEach((w) => {
    const key = w.toLowerCase().replace(/\.$/, '').replace(/^\.(?!net)/, '');
    const k2 = key.replace(/\./g, '');
    const std = TITLE_WORDS[key] || TITLE_WORDS[k2];
    if (std) out.push(std);
    else if (/^[A-Z0-9&+#/.-]{2,5}$/.test(w)) out.push(w); // an acronym as typed (CNC, B2B)
    else out.push(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  });
  // "Senior Senior ...", "Lead Lead" -> once
  const dedup = out.filter((w, i) => i === 0 || w !== out[i - 1]).join(' ').replace(/\bLead Team Lead\b/, 'Team Lead').replace(/\bTeam Lead Lead\b/, 'Team Lead');
  return dedup;
}
function levelOf(title) {
  const t = normaliseTitle(title) || '';
  const hit = LEVELS.find(([re]) => re.test(t));
  if (hit) return { rank: hit[1], label: hit[2] };
  const last = t.split(' ').pop();
  return { rank: BASE_RANK, label: last || 'Staff' };
}
// The rules as a table (for the profile's "how titles are tidied" note and the test).
const TITLE_RULES = Object.entries(TITLE_WORDS).map(([from, to]) => ({ from, to }));

// --- gaps and progression -------------------------------------------------------------------------------------------
const GAP_MONTHS = 3; // a gap is MORE than this many months
function eduEndMonth(edu) {
  const years = (edu || []).map((e) => Number(String(e.year || '').match(/\d{4}/) && String(e.year).match(/\d{4}/)[0])).filter((y) => y > 1950);
  if (!years.length) return null;
  return fmt(Math.max(...years), 6); // a course is taken as finished in June of its year
}
function jobsOf(employment) {
  const tm = thisMonth();
  return (employment || [])
    .map((j) => ({ ...j, from: toMonth(j.fromMonth), to: j.isCurrent ? tm : toMonth(j.toMonth) }))
    .filter((j) => j.from)
    .map((j) => ({ ...j, to: j.to && monthIndex(j.to) >= monthIndex(j.from) ? j.to : j.from }))
    .sort((a, b) => monthIndex(a.from) - monthIndex(b.from));
}
function findGaps(education, employment) {
  const jobs = jobsOf(employment);
  const gaps = [];
  const eduEnd = eduEndMonth(education);
  if (jobs.length && eduEnd) {
    const g = monthIndex(jobs[0].from) - monthIndex(eduEnd) - 1;
    if (g > GAP_MONTHS) gaps.push({ kind: 'After education', from: eduEnd, to: jobs[0].from, months: g, text: `${g} months between finishing education (${eduEnd.slice(0, 4)}) and the first job (${monthLabel(jobs[0].from)})` });
  }
  let coveredTo = null; let lastJob = null;
  jobs.forEach((j) => {
    if (coveredTo) {
      const g = monthIndex(j.from) - monthIndex(coveredTo) - 1;
      if (g > GAP_MONTHS) gaps.push({ kind: 'Between jobs', from: coveredTo, to: j.from, months: g, text: `${g} months between ${lastJob.company || 'a job'} (left ${monthLabel(coveredTo)}) and ${j.company || 'the next job'} (joined ${monthLabel(j.from)})` });
    }
    if (!coveredTo || monthIndex(j.to) > monthIndex(coveredTo)) { coveredTo = j.to; lastJob = j; }
  });
  if (jobs.length && !jobs.some((j) => j.isCurrent) && coveredTo) {
    const g = monthIndex(thisMonth()) - monthIndex(coveredTo) - 1;
    if (g > GAP_MONTHS) gaps.push({ kind: 'Since last job', from: coveredTo, to: null, months: g, text: `${g} months since leaving ${lastJob.company || 'the last job'} (${monthLabel(coveredTo)}), no current job` });
  }
  return gaps;
}
function progression(employment) {
  const jobs = jobsOf(employment);
  if (!jobs.length) return { jobs: 0, line: 'No employment history yet.', trend: null, path: [], avgTenureYears: null, spanYears: null };
  const first = jobs[0].from;
  const last = jobs.reduce((m, j) => (monthIndex(j.to) > monthIndex(m) ? j.to : m), jobs[0].to);
  const spanMonths = monthIndex(last) - monthIndex(first) + 1;
  const tenures = jobs.map((j) => monthIndex(j.to) - monthIndex(j.from) + 1);
  const avg = tenures.reduce((a, b) => a + b, 0) / tenures.length;
  const levels = jobs.map((j) => ({ ...levelOf(j.title), title: normaliseTitle(j.title) }));
  const path = [];
  levels.forEach((l) => { if (!path.length || path[path.length - 1] !== l.label) path.push(l.label); });
  const ranks = levels.map((l) => l.rank);
  let up = 0; let down = 0;
  for (let i = 1; i < ranks.length; i += 1) { if (ranks[i] > ranks[i - 1]) up += 1; else if (ranks[i] < ranks[i - 1]) down += 1; }
  let trend = 'flat';
  if (up && !down) trend = 'up'; else if (down && !up) trend = 'down'; else if (up && down) trend = ranks[ranks.length - 1] > ranks[0] ? 'up' : (ranks[ranks.length - 1] < ranks[0] ? 'down' : 'mixed');
  const TREND = { up: 'going up', flat: 'flat (same level)', down: 'going down', mixed: 'up and down' };
  const spanY = Math.max(1, Math.round(spanMonths / 12));
  const line = `${jobs.length} job${jobs.length === 1 ? '' : 's'} in ${spanY} year${spanY === 1 ? '' : 's'}, ${path.join(' → ')}, avg tenure ${(avg / 12).toFixed(1)} y${jobs.length > 1 ? ` — ${TREND[trend]}` : ''}`;
  const shortStints = tenures.filter((t) => t < 12).length;
  return { jobs: jobs.length, line, trend, trendLabel: TREND[trend], path, avgTenureYears: Math.round((avg / 12) * 10) / 10, spanYears: Math.round((spanMonths / 12) * 10) / 10, shortStints };
}

// --- reads ---------------------------------------------------------------------------------------------------------
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
async function educationOf(candidateId) {
  await ensure();
  return prisma.$queryRawUnsafe('SELECT * FROM "CandidateEducation" WHERE "candidateId" = ? ORDER BY "year" DESC, "createdAt" ASC', candidateId);
}
async function employmentOf(candidateId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateEmployment" WHERE "candidateId" = ? ORDER BY "isCurrent" DESC, "fromMonth" DESC', candidateId);
  return rows.map((r) => ({ ...r, isCurrent: !!num(r.isCurrent), normalisedTitle: normaliseTitle(r.title) }));
}
async function tagsOf(candidateId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "tag", "createdByName", "createdAt" FROM "CandidateTag" WHERE "candidateId" = ? ORDER BY "tag"', candidateId);
  return rows;
}
async function fieldDefs({ all = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CandidateCustomField" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "sortOrder", "createdAt"`);
  return rows.map((r) => ({ ...r, required: !!num(r.required), active: !!num(r.active), sortOrder: num(r.sortOrder), options: safeJson(r.options) || [] }));
}
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
async function customValuesOf(candidateId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateCustomValue" WHERE "candidateId" = ?', candidateId);
  return new Map(rows.map((r) => [r.fieldId, r]));
}
async function summaryOf(candidateId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateProfileSummary" WHERE "candidateId" = ?', candidateId);
  return r || null;
}

// --- writes --------------------------------------------------------------------------------------------------------
function educationInput(b) {
  const row = { degree: clean(b.degree, 80), specialisation: clean(b.specialisation || b.specialization, 80), institute: clean(b.institute, 120), year: clean(b.year, 10), score: clean(b.score, 20) };
  if (!row.degree && !row.institute) return { error: 'Give at least the degree or the institute.' };
  if (row.year && !/^\d{4}$/.test(row.year)) return { error: 'Year must be like 2019.' };
  return { row };
}
async function addEducation(candidateId, b, user) {
  await ensure();
  const { row, error } = educationInput(b);
  if (error) return { error };
  const id = newId();
  await prisma.$executeRawUnsafe('INSERT INTO "CandidateEducation" ("id","candidateId","degree","specialisation","institute","year","score","createdAt","createdByName") VALUES (?,?,?,?,?,?,?,?,?)',
    id, candidateId, row.degree, row.specialisation, row.institute, row.year, row.score, now(), user && user.name);
  return { id, ...row };
}
async function updateEducation(candidateId, id, b) {
  await ensure();
  const { row, error } = educationInput(b);
  if (error) return { error };
  const n = await prisma.$executeRawUnsafe('UPDATE "CandidateEducation" SET "degree"=?,"specialisation"=?,"institute"=?,"year"=?,"score"=?,"updatedAt"=? WHERE "id"=? AND "candidateId"=?',
    row.degree, row.specialisation, row.institute, row.year, row.score, now(), id, candidateId);
  return n ? { id, ...row } : { error: 'Not found', status: 404 };
}
function employmentInput(b) {
  const isCurrent = !!(b.isCurrent === true || b.isCurrent === 1 || b.isCurrent === '1' || b.isCurrent === 'true');
  const row = {
    company: clean(b.company, 120), title: clean(b.title, 120), fromMonth: toMonth(b.fromMonth || b.from), toMonth: isCurrent ? null : toMonth(b.toMonth || b.to),
    isCurrent, ctc: clean(b.ctc, 40), notes: clean(b.notes, 500),
  };
  if (!row.company && !row.title) return { error: 'Give at least the company or the job title.' };
  if ((b.fromMonth || b.from) && !row.fromMonth) return { error: 'From must be a month like 2019-03.' };
  if (!isCurrent && (b.toMonth || b.to) && !row.toMonth) return { error: 'To must be a month like 2021-08.' };
  if (row.fromMonth && row.toMonth && monthIndex(row.toMonth) < monthIndex(row.fromMonth)) return { error: '"To" is before "From".' };
  row.normalisedTitle = normaliseTitle(row.title);
  return { row };
}
async function addEmployment(candidateId, b, user) {
  await ensure();
  const { row, error } = employmentInput(b);
  if (error) return { error };
  const id = newId();
  await prisma.$executeRawUnsafe('INSERT INTO "CandidateEmployment" ("id","candidateId","company","title","fromMonth","toMonth","isCurrent","ctc","notes","normalisedTitle","createdAt","createdByName") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, candidateId, row.company, row.title, row.fromMonth, row.toMonth, row.isCurrent ? 1 : 0, row.ctc, row.notes, row.normalisedTitle, now(), user && user.name);
  return { id, ...row };
}
async function updateEmployment(candidateId, id, b) {
  await ensure();
  const { row, error } = employmentInput(b);
  if (error) return { error };
  const n = await prisma.$executeRawUnsafe('UPDATE "CandidateEmployment" SET "company"=?,"title"=?,"fromMonth"=?,"toMonth"=?,"isCurrent"=?,"ctc"=?,"notes"=?,"normalisedTitle"=?,"updatedAt"=? WHERE "id"=? AND "candidateId"=?',
    row.company, row.title, row.fromMonth, row.toMonth, row.isCurrent ? 1 : 0, row.ctc, row.notes, row.normalisedTitle, now(), id, candidateId);
  return n ? { id, ...row } : { error: 'Not found', status: 404 };
}
async function removeRow(table, candidateId, id) {
  await ensure();
  if (!['CandidateEducation', 'CandidateEmployment'].includes(table)) throw new Error('bad table');
  const [old] = await prisma.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "id"=? AND "candidateId"=?`, id, candidateId);
  if (!old) return null;
  await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id"=? AND "candidateId"=?`, id, candidateId);
  return old;
}

// --- tags (with an in-memory index so the Candidates list filters without a query per row) ---------------------------------
let TAG_INDEX = null; // Map tagKey -> Set(candidateId)
let TAG_LABEL = new Map(); // tagKey -> how it is written
const tagKeyOf = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
const tagClean = (t) => clean(t, 40) && clean(t, 40).replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
async function warmTags() {
  const rows = await prisma.$queryRawUnsafe('SELECT "candidateId", "tagKey", "tag" FROM "CandidateTag"');
  const idx = new Map(); const lab = new Map();
  rows.forEach((r) => { if (!idx.has(r.tagKey)) idx.set(r.tagKey, new Set()); idx.get(r.tagKey).add(r.candidateId); if (!lab.has(r.tagKey)) lab.set(r.tagKey, r.tag); });
  TAG_INDEX = idx; TAG_LABEL = lab;
}
/** true when the person carries the tag. Sync: the index is loaded by ensure() (the list awaits ready() first). */
function hasTagSync(candidateId, tag) {
  if (!tag) return true;
  const set = TAG_INDEX && TAG_INDEX.get(tagKeyOf(tag));
  return !!(set && set.has(candidateId));
}
async function addTag(candidateId, tag, user) {
  await ensure();
  const t = tagClean(tag);
  if (!t) return { error: 'Type a tag.' };
  const key = tagKeyOf(t);
  const label = TAG_LABEL.get(key) || t; // one spelling per tag: the first one used
  const n = await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "CandidateTag" ("candidateId","tagKey","tag","createdAt","createdByName") VALUES (?,?,?,?,?)', candidateId, key, label, now(), user && user.name);
  if (!TAG_INDEX.has(key)) TAG_INDEX.set(key, new Set());
  TAG_INDEX.get(key).add(candidateId);
  if (!TAG_LABEL.has(key)) TAG_LABEL.set(key, label);
  return { tag: label, added: !!n };
}
async function removeTag(candidateId, tag) {
  await ensure();
  const key = tagKeyOf(tag);
  const n = await prisma.$executeRawUnsafe('DELETE FROM "CandidateTag" WHERE "candidateId"=? AND "tagKey"=?', candidateId, key);
  if (TAG_INDEX.has(key)) { TAG_INDEX.get(key).delete(candidateId); if (!TAG_INDEX.get(key).size) { TAG_INDEX.delete(key); TAG_LABEL.delete(key); } }
  return { removed: !!n };
}
/** The tag index as [{ label, ids:Set }] (utils/candidateFilters.js counts it over the people in scope). */
function tagSnapshot() {
  return TAG_INDEX ? [...TAG_INDEX.entries()].map(([key, set]) => ({ label: TAG_LABEL.get(key) || key, ids: set })) : [];
}
/** Every tag with how many people carry it (counts over the whole database; the list route now counts over the login's scope instead). */
async function allTags() {
  await ensure();
  return [...TAG_INDEX.entries()].map(([key, set]) => ({ value: TAG_LABEL.get(key) || key, label: TAG_LABEL.get(key) || key, count: set.size }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// --- custom fields ---------------------------------------------------------------------------------------------------
const FIELD_TYPES = ['text', 'number', 'date', 'select'];
function fieldInput(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.label !== undefined) { out.label = clean(b.label, 60); if (!out.label) return { error: 'A field needs a label.' }; }
  if (!partial || b.type !== undefined) { out.type = String(b.type || '').toLowerCase(); if (!FIELD_TYPES.includes(out.type)) return { error: `Type must be one of: ${FIELD_TYPES.join(', ')}.` }; }
  if (!partial || b.options !== undefined) {
    const list = Array.isArray(b.options) ? b.options : String(b.options || '').split(/[,\n]/);
    out.options = [...new Set(list.map((o) => clean(o, 60)).filter(Boolean))].slice(0, 50);
  }
  if (!partial || b.required !== undefined) out.required = !!b.required;
  if (b.active !== undefined) out.active = !!b.active;
  return { row: out };
}
async function createField(b, user) {
  await ensure();
  const { row, error } = fieldInput(b);
  if (error) return { error };
  if (row.type === 'select' && !row.options.length) return { error: 'A select field needs at least one option.' };
  const dup = (await fieldDefs({ all: true })).find((f) => f.active && f.label.toLowerCase() === row.label.toLowerCase());
  if (dup) return { error: `A field called "${dup.label}" already exists.`, status: 409 };
  const id = newId();
  const [{ n } = { n: 0 }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CandidateCustomField"');
  await prisma.$executeRawUnsafe('INSERT INTO "CandidateCustomField" ("id","label","type","options","required","active","sortOrder","createdAt","createdByName") VALUES (?,?,?,?,?,1,?,?,?)',
    id, row.label, row.type, JSON.stringify(row.type === 'select' ? row.options : []), row.required ? 1 : 0, Number(num(n)) + 1, now(), user && user.name);
  return { id, ...row, active: true };
}
async function updateField(id, b) {
  await ensure();
  const [old] = (await fieldDefs({ all: true })).filter((f) => f.id === id);
  if (!old) return { error: 'Field not found', status: 404 };
  const { row, error } = fieldInput(b, { partial: true });
  if (error) return { error };
  const next = { ...old, ...row };
  if (next.type === 'select' && !(next.options || []).length) return { error: 'A select field needs at least one option.' };
  await prisma.$executeRawUnsafe('UPDATE "CandidateCustomField" SET "label"=?,"type"=?,"options"=?,"required"=?,"active"=? WHERE "id"=?',
    next.label, next.type, JSON.stringify(next.type === 'select' ? next.options : []), next.required ? 1 : 0, next.active ? 1 : 0, id);
  return { old, field: next };
}
function checkValue(def, raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return def.required ? { error: `${def.label} is required.` } : { value: null };
  if (def.type === 'number') { const n = Number(v.replace(/,/g, '')); return Number.isFinite(n) ? { value: String(n) } : { error: `${def.label} must be a number.` }; }
  if (def.type === 'date') { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? { value: v } : { error: `${def.label} must be a date (YYYY-MM-DD).` }; }
  if (def.type === 'select') { const hit = (def.options || []).find((o) => o.toLowerCase() === v.toLowerCase()); return hit ? { value: hit } : { error: `${def.label} must be one of: ${(def.options || []).join(', ')}.` }; }
  return { value: v.replace(/<[^>]*>/g, '').slice(0, 500) };
}
/** values: { fieldId: value }. Returns { changes: [{ def, from, to }] } or { error }. Nothing is saved when one value is wrong. */
async function saveCustomValues(candidateId, values, user) {
  await ensure();
  const defs = new Map((await fieldDefs()).map((d) => [d.id, d]));
  const current = await customValuesOf(candidateId);
  const writes = [];
  for (const [fid, raw] of Object.entries(values || {})) {
    const def = defs.get(fid);
    if (!def) return { error: 'That field does not exist (or was switched off).' };
    const r = checkValue(def, raw);
    if (r.error) return { error: r.error };
    const from = current.has(fid) ? current.get(fid).value : null;
    if ((from || null) !== (r.value || null)) writes.push({ def, from, to: r.value });
  }
  for (const w of writes) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(`INSERT INTO "CandidateCustomValue" ("candidateId","fieldId","value","updatedAt","updatedByName") VALUES (?,?,?,?,?)
      ON CONFLICT("candidateId","fieldId") DO UPDATE SET "value"=excluded."value","updatedAt"=excluded."updatedAt","updatedByName"=excluded."updatedByName"`,
    candidateId, w.def.id, w.to, now(), user && user.name);
  }
  return { changes: writes };
}

// --- summary -----------------------------------------------------------------------------------------------------
const splitSkills = (...vals) => [...new Set(vals.flatMap((v) => String(v || '').split(/[,;|]/)).map((s) => s.trim()).filter(Boolean))];
function ruleSummary(c, education, employment, tags, analysis) {
  const bits = [];
  const exp = c.experienceYears != null ? `${c.experienceYears} years of experience` : null;
  const cur = employment.find((j) => j.isCurrent) || null;
  const nowTitle = (cur && (cur.normalisedTitle || cur.title)) || normaliseTitle(c.currentDesignation);
  const nowCo = (cur && cur.company) || c.currentCompany;
  let first = c.name || 'This candidate';
  if (nowTitle || nowCo) first += ` is ${nowTitle ? `a ${nowTitle}` : 'working'}${nowCo ? ` at ${nowCo}` : ''}`;
  else first += ' has no current job on file';
  if (exp) first += `, with ${exp}`;
  if (c.location) first += `, based in ${c.location}`;
  bits.push(`${first}.`);
  if (analysis.progression.jobs) bits.push(`Career: ${analysis.progression.line}.`);
  if (analysis.gaps.length) bits.push(`Gaps: ${analysis.gaps.map((g) => `${g.months} months ${g.kind.toLowerCase()}`).join('; ')}.`);
  else if (analysis.progression.jobs) bits.push('No gaps of more than 3 months.');
  const edu = education.length ? education.map((e) => [e.degree, e.specialisation].filter(Boolean).join(' ') + (e.institute ? ` (${e.institute}${e.year ? `, ${e.year}` : ''})` : (e.year ? ` (${e.year})` : ''))).slice(0, 3)
    : [[c.education, c.specialization].filter(Boolean).join(' ') + (c.institute ? ` (${c.institute}${c.passingYear ? `, ${c.passingYear}` : ''})` : '')].filter((s) => s.trim());
  if (edu.length) bits.push(`Education: ${edu.join('; ')}.`);
  const skills = splitSkills(c.skills, c.technicalSkills, c.goodToHaveSkills).slice(0, 10);
  if (skills.length) bits.push(`Skills: ${skills.join(', ')}.`);
  const terms = [c.currentSalary && `current CTC ${c.currentSalary}`, c.expectedSalary && `expects ${c.expectedSalary}`, c.noticePeriod && `notice ${c.noticePeriod}`].filter(Boolean);
  if (terms.length) bits.push(`${terms.join(', ').replace(/^./, (x) => x.toUpperCase())}.`);
  if (tags.length) bits.push(`Tags: ${tags.map((t) => t.tag).join(', ')}.`);
  return bits.join(' ');
}
function aiFacts(c, education, employment, analysis) {
  return JSON.stringify({
    name: c.name, location: c.location, experienceYears: c.experienceYears, currentDesignation: c.currentDesignation, currentCompany: c.currentCompany,
    skills: splitSkills(c.skills, c.technicalSkills, c.goodToHaveSkills).slice(0, 25), noticePeriod: c.noticePeriod, currentSalary: c.currentSalary, expectedSalary: c.expectedSalary,
    education: education.map((e) => ({ degree: e.degree, specialisation: e.specialisation, institute: e.institute, year: e.year, score: e.score })),
    employment: employment.map((j) => ({ company: j.company, title: j.normalisedTitle || j.title, from: j.fromMonth, to: j.isCurrent ? 'present' : j.toMonth })),
    gaps: analysis.gaps.map((g) => g.text), progression: analysis.progression.line,
  });
}
async function writeSummary(c, education, employment, tags, analysis, { useAi = true, user } = {}) {
  await ensure();
  let summary = null; let source = 'rules'; let aiNote = null;
  if (useAi) {
    try {
      const ai = require('./ai'); // eslint-disable-line global-require
      const text = await ai.chat('You write a short recruiter-facing candidate summary (4-6 plain sentences, no headings, no bullet points, no guesses). Use ONLY the facts given. Mention current role, total experience, career progression, gaps if any, education and key skills.',
        [{ role: 'user', content: aiFacts(c, education, employment, analysis) }]);
      const t = String(text || '').trim();
      if (t && t.length > 20) { summary = t.slice(0, 2000); source = 'ai'; }
    } catch (e) { aiNote = `AI is not available (${String((e && e.message) || e).slice(0, 140)}), so this summary was built from the profile fields.`; }
  }
  if (!summary) summary = ruleSummary(c, education, employment, tags, analysis);
  await prisma.$executeRawUnsafe(`INSERT INTO "CandidateProfileSummary" ("candidateId","summary","source","createdAt","createdByName") VALUES (?,?,?,?,?)
    ON CONFLICT("candidateId") DO UPDATE SET "summary"=excluded."summary","source"=excluded."source","createdAt"=excluded."createdAt","createdByName"=excluded."createdByName"`,
  c.id, summary, source, now(), user && user.name);
  return { summary, source, aiNote, createdAt: now(), createdByName: user && user.name };
}

// --- parse check: what the resume parser read vs what the profile says now ----------------------------------------
const d10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
function parseCheck(parsed, c) {
  if (!parsed) return null;
  const rows = [];
  const add = (field, read, nowV, same) => {
    if (read == null || read === '' || (Array.isArray(read) && !read.length)) { rows.push({ field, read: null, now: nowV || null, status: 'Not read' }); return; }
    rows.push({ field, read: Array.isArray(read) ? read.join(', ') : String(read), now: nowV || null, status: same ? 'Kept' : 'Corrected by recruiter' });
  };
  add('Name', parsed.name, c.name, parsed.name && String(parsed.name).toLowerCase().replace(/\s+/g, ' ') === String(c.name || '').toLowerCase().replace(/\s+/g, ' '));
  add('Email', (parsed.emails || [])[0], c.email, (parsed.emails || []).map((e) => e.toLowerCase()).includes(String(c.email || '').toLowerCase()));
  add('Phone', (parsed.phones || [])[0], c.phone, (parsed.phones || []).map(d10).includes(d10(c.phone)));
  add('Experience', parsed.totalExperienceYears, c.experienceYears != null ? `${c.experienceYears}` : null, parsed.totalExperienceYears != null && c.experienceYears != null && Math.abs(Number(parsed.totalExperienceYears) - Number(c.experienceYears)) < 0.6);
  const have = splitSkills(c.skills, c.technicalSkills, c.goodToHaveSkills).map((s) => s.toLowerCase());
  const read = (parsed.skills || []).map((s) => String(s).toLowerCase());
  const kept = read.filter((s) => have.includes(s)).length;
  add('Skills', read.length ? `${read.length} found` : null, have.length ? `${have.length} on profile` : null, read.length > 0 && kept / read.length >= 0.5);
  const scored = rows.filter((r) => r.status !== 'Not read');
  const keptN = scored.filter((r) => r.status === 'Kept').length;
  return { rows, accuracyPct: scored.length ? Math.round((keptN / scored.length) * 100) : null, languages: parsed.languages || null };
}

async function analyse(candidateId) {
  const [education, employment] = await Promise.all([educationOf(candidateId), employmentOf(candidateId)]);
  return { education, employment, gaps: findGaps(education, employment), progression: progression(employment) };
}
const ready = () => ensure();

module.exports = {
  ensure, ready, toMonth, normaliseTitle, levelOf, TITLE_RULES, findGaps, progression, GAP_MONTHS,
  educationOf, employmentOf, tagsOf, fieldDefs, customValuesOf, summaryOf, analyse,
  addEducation, updateEducation, addEmployment, updateEmployment, removeRow,
  addTag, removeTag, allTags, tagSnapshot, hasTagSync, tagKeyOf,
  FIELD_TYPES, createField, updateField, checkValue, saveCustomValues,
  ruleSummary, writeSummary, parseCheck,
};
