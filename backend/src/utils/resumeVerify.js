// ---------------------------------------------------------------------------
// VERIFY QUEUE (founder audit 2026-11-18, parsing quality): what the resume says is checked before anybody relies on it.
//
//   checkProfile(values, parsed)   -> flags. `values` = what is (to be) saved, `parsed` = what the resume parser read
//   plausibility(values)           the sanity rules alone (age, experience vs age, CTC range, expected vs current, dates, education)
//   educationChecks(values)        year of passing vs age, degree level vs experience start, impossible degree combinations
//   titleSimilarity(a, b)          0..1 for two job titles ("Sr. Java Dev" ~ "Senior Java Developer")
//   recordFlags / listQueue / resolve / flagsOf / openCountOf       the queue itself (table ResumeFlag, raw SQL)
//
// A flag is { field, kind, message, resumeSays, saved, evidence, evidences }.
//   kind  low_confidence | implausible | conflict | inconsistent | education
// A flagged candidate can still be saved: the flag only marks the profile "needs verification" until a person checks it.
// Who may decide: a recruiter can correct a value or mark it checked (it then waits for the TL); a TL / STL / Manager / Admin approves it.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const SAL = require('./salaryFit');
const RF = require('./resumeFields');

const LABELS = {
  name: 'Name', email: 'Email', phone: 'Phone', dob: 'Date of birth', experienceYears: 'Total experience', currentSalary: 'Current salary', expectedSalary: 'Expected salary',
  noticePeriod: 'Notice period', location: 'Current location', education: 'Qualification', passingYear: 'Passing year', employment: 'Job history', educationEntries: 'Education list',
  currentDesignation: 'Current designation', currentCompany: 'Current company',
};
// fields whose "low" confidence is worth a person's time (skills / languages are never queued for being "low")
const WATCH = ['name', 'email', 'phone', 'dob', 'experience', 'currentSalary', 'expectedSalary', 'noticePeriod', 'location', 'education', 'employment', 'educationEntries'];
const FIELD_OF = { experience: 'experienceYears' };
const fieldKey = (k) => FIELD_OF[k] || k;

const now = () => new Date();
const ageOn = (dobIso, at = now()) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dobIso || ''));
  if (!m) return null;
  let a = at.getFullYear() - Number(m[1]);
  if (at.getMonth() + 1 < Number(m[2]) || (at.getMonth() + 1 === Number(m[2]) && at.getDate() < Number(m[3]))) a -= 1;
  return a;
};
const lpaOf = (v) => { const p = SAL.parseAmount(v); return p && p.ok && !p.fresher ? p.lpa : null; };
const flag = (field, kind, message, extra = {}) => ({
  field, label: LABELS[field] || field, kind, message, resumeSays: extra.resumeSays == null ? null : String(extra.resumeSays), saved: extra.saved == null ? null : String(extra.saved),
  evidence: extra.evidence || null, evidences: extra.evidences || null, values: extra.values || null,
});

// --- education validation (item 103) ------------------------------------------------------------------------------------
const MASTERS = /^(M\.|MBA|MCA|MA$|MD$|MS$|Ph\.D)/;
const BACHELORS = /^(B\.|BCA|BBA|BA$|MBBS|BDS|BAMS|BHMS|Pharm\.D|CA$)/;
const MEDICAL = /^(MBBS|BDS|BAMS|BHMS|MD$|Pharm\.D|B\.Pharm|M\.Pharm|B\.Sc Nursing|GNM|ANM)/;
const TECH_SPEC = /\b(cse|computer|electronics|mechanical|civil|eee|ece|information technology|software|automobile|chemical engineering)\b/i;
const MEDICAL_SPEC = /\b(nursing|pharmacy|medicine|surgery|dental|ayurved|homeo|physiotherap)\b/i;
const yearOf = (v) => { const m = String(v == null ? '' : v).match(/\d{4}/); return m ? Number(m[0]) : null; };
function educationChecks({
  dob = null, experienceYears = null, educationEntries = [], passingYear = null, employment = [],
} = {}, nowD = now()) {
  const out = [];
  const born = yearOf(String(dob || '').slice(0, 4));
  const thisYear = nowD.getFullYear();
  const entries = (educationEntries || []).map((e) => ({ ...e, y: yearOf(e.year) }));
  if (passingYear && !entries.some((e) => e.y)) { const y = yearOf(passingYear); if (y) entries.push({ degree: 'Qualification', rank: 3, y }); }
  entries.forEach((e) => {
    if (!e.y) return;
    if (e.y > thisYear + 1) out.push(flag('educationEntries', 'education', `${e.degree} is shown as passed in ${e.y}, which is in the future.`, { resumeSays: `${e.degree} ${e.y}`, evidence: e.line }));
    if (born && e.y - born < (e.rank >= 5 ? 17 : 14)) out.push(flag('educationEntries', 'education', `${e.degree} passed in ${e.y} would make the person only ${e.y - born} years old when finishing.`, { resumeSays: `${e.degree} ${e.y}`, saved: `born ${born}`, evidence: e.line }));
  });
  const years = entries.filter((e) => e.y);
  const master = years.find((e) => MASTERS.test(e.degree));
  const bach = years.find((e) => BACHELORS.test(e.degree));
  if (master && bach && master.y <= bach.y && master.degree !== bach.degree && !/^(MBBS|MD)$/.test(master.degree)) {
    out.push(flag('educationEntries', 'education', `${master.degree} (${master.y}) is not later than ${bach.degree} (${bach.y}). A master's degree comes after the bachelor's.`, { resumeSays: `${master.degree} ${master.y}, ${bach.degree} ${bach.y}`, evidence: master.line }));
  }
  const inter = years.find((e) => e.degree === 'Intermediate');
  if (inter && bach && inter.y > bach.y) out.push(flag('educationEntries', 'education', `Intermediate (${inter.y}) is after ${bach.degree} (${bach.y}).`, { resumeSays: `Intermediate ${inter.y}, ${bach.degree} ${bach.y}`, evidence: inter.line }));
  entries.forEach((e) => {
    if (!e.specialisation) return;
    if (/^(B\.Tech|B\.E|M\.Tech|M\.E)$/.test(e.degree) && MEDICAL_SPEC.test(e.specialisation)) out.push(flag('educationEntries', 'education', `${e.degree} with ${e.specialisation} does not fit together.`, { resumeSays: `${e.degree} (${e.specialisation})`, evidence: e.line }));
    if (MEDICAL.test(e.degree) && TECH_SPEC.test(e.specialisation)) out.push(flag('educationEntries', 'education', `${e.degree} with ${e.specialisation} does not fit together.`, { resumeSays: `${e.degree} (${e.specialisation})`, evidence: e.line }));
  });
  // degree level vs experience start: more years of experience than the years since the first degree + 2.5, or a job that started years before the degree
  const degreeYear = years.filter((e) => e.rank >= 3).map((e) => e.y).sort((a, b) => a - b)[0];
  if (degreeYear && experienceYears != null && experienceYears !== '' && Number(experienceYears) > thisYear - degreeYear + 2.5 && Number(experienceYears) > 3) {
    out.push(flag('experienceYears', 'education', `${experienceYears} years of experience is more than the years since the first qualification (${degreeYear}).`, { resumeSays: `${experienceYears} years`, saved: `qualification ${degreeYear}` }));
  }
  const firstJob = (employment || []).map((j) => j.fromMonth).filter(Boolean).sort()[0];
  const lowest = years.filter((e) => e.rank >= 5).map((e) => e.y).sort((a, b) => a - b)[0];
  if (firstJob && lowest && Number(firstJob.slice(0, 4)) < lowest - 4) {
    out.push(flag('employment', 'education', `A job starts in ${firstJob.slice(0, 4)}, long before the degree was finished (${lowest}).`, { resumeSays: `job from ${firstJob}`, saved: `degree ${lowest}`, evidence: (employment.find((j) => j.fromMonth === firstJob) || {}).line }));
  }
  return out;
}

// --- plausibility (items 80, 85, 108) ---------------------------------------------------------------------------------------
function plausibility(values = {}, nowD = now()) {
  const out = [];
  const ev = values.evidence || {};
  const age = ageOn(values.dob, nowD);
  if (values.dob && age != null && (age < 16 || age > 70)) out.push(flag('dob', 'implausible', `The date of birth makes the person ${age} years old.`, { resumeSays: values.dob, evidence: ev.dob }));
  const exp = values.experienceYears == null || values.experienceYears === '' ? null : Number(values.experienceYears);
  if (exp != null && Number.isFinite(exp)) {
    if (exp < 0 || exp > 45) out.push(flag('experienceYears', 'implausible', `${exp} years of experience is not believable.`, { resumeSays: exp, evidence: ev.experience }));
    else if (age != null && exp > age - 16) out.push(flag('experienceYears', 'implausible', `${exp} years of experience is more than the person's age (${age}) minus 16.`, { resumeSays: `${exp} years`, saved: `age ${age}`, evidence: ev.experience }));
  }
  const cur = lpaOf(values.currentSalary); const exs = lpaOf(values.expectedSalary);
  const R = SAL.PLAUSIBLE_LPA;
  [['currentSalary', cur, values.currentSalary], ['expectedSalary', exs, values.expectedSalary]].forEach(([f, v, raw]) => {
    if (raw && v != null && (v < R.min || v > R.max)) out.push(flag(f, 'implausible', `${raw} is outside the usual range (${R.min} to ${R.max} LPA).`, { resumeSays: raw, evidence: ev[f] }));
  });
  if (cur != null && exs != null && cur > 0) {
    if (exs < cur * 0.5) out.push(flag('expectedSalary', 'implausible', `Expected salary (${values.expectedSalary}) is less than half of the current salary (${values.currentSalary}).`, { resumeSays: values.expectedSalary, saved: values.currentSalary, evidence: ev.expectedSalary }));
    else if (exs > cur * 4 && exs - cur > 5) out.push(flag('expectedSalary', 'implausible', `Expected salary (${values.expectedSalary}) is more than four times the current salary (${values.currentSalary}).`, { resumeSays: values.expectedSalary, saved: values.currentSalary, evidence: ev.expectedSalary }));
  }
  // dates: end before start, in the future
  const ym = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
  (values.employment || []).forEach((j) => {
    if (j.fromMonth && j.toMonth && j.toMonth < j.fromMonth) out.push(flag('employment', 'implausible', `A job ends (${j.toMonth}) before it starts (${j.fromMonth}).`, { resumeSays: `${j.fromMonth} to ${j.toMonth}`, evidence: j.line }));
    if (j.fromMonth && j.fromMonth > ym) out.push(flag('employment', 'implausible', `A job starts in the future (${j.fromMonth}).`, { resumeSays: j.fromMonth, evidence: j.line }));
    else if (j.toMonth && j.toMonth > ym) out.push(flag('employment', 'implausible', `A job ends in the future (${j.toMonth}).`, { resumeSays: j.toMonth, evidence: j.line }));
  });
  if (age != null) {
    const born = Number(String(values.dob).slice(0, 4));
    (values.employment || []).forEach((j) => {
      if (j.fromMonth && Number(j.fromMonth.slice(0, 4)) - born < 14) out.push(flag('employment', 'implausible', `A job starts in ${j.fromMonth.slice(0, 4)}, when the person was only ${Number(j.fromMonth.slice(0, 4)) - born}.`, { resumeSays: j.fromMonth, saved: `born ${born}`, evidence: j.line }));
    });
  }
  out.push(...educationChecks(values, nowD));
  return out;
}

// --- similar job titles (item 99) ----------------------------------------------------------------------------------------
const TITLE_SYNONYMS = [
  ['developer', 'engineer', 'programmer', 'dev', 'coder'], ['executive', 'officer', 'associate'], ['manager', 'mgr', 'head', 'lead'],
  ['hr', 'human resources', 'recruiter', 'talent acquisition'], ['sr', 'senior'], ['jr', 'junior'], ['qa', 'tester', 'quality assurance', 'testing'],
  ['accountant', 'accounts'], ['bde', 'business development', 'sales'], ['nurse', 'staff nurse'],
];
const STOP = new Set(['and', 'of', 'the', 'a', 'in', 'at', 'for', 'ii', 'iii', 'i']);
function titleTokens(t) {
  let s = ` ${String(t || '').toLowerCase().replace(/[^a-z0-9.#+ ]/g, ' ').replace(/\.(?=\s|$)/g, '').replace(/\s+/g, ' ')} `;
  TITLE_SYNONYMS.forEach((group) => {
    const head = group.length === 2 ? group[1] : group[0];
    group.forEach((w) => { if (w !== head) s = s.replace(new RegExp(` ${w.replace(/\./g, '\\.')} `, 'g'), ` ${head} `); });
  });
  return [...new Set(s.trim().split(' ').filter((w) => w && !STOP.has(w)))];
}
function titleSimilarity(a, b) {
  const x = titleTokens(a); const y = titleTokens(b);
  if (!x.length || !y.length) return 0;
  const sy = new Set(y);
  const inter = x.filter((w) => sy.has(w)).length;
  return Math.round((inter / (x.length + y.length - inter)) * 100) / 100;
}

// --- all checks of one profile against what the resume said --------------------------------------------------------------------
const wordsOf = (v) => String(v || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function checkProfile(values = {}, parsed = null) {
  const out = [];
  const ev = (parsed && parsed.evidence) || {};
  const conf = (parsed && parsed.confidence) || {};
  const v = { ...values, evidence: { ...ev } };
  // use the resume's own jobs / degrees / date of birth when the profile has none to look at
  if (parsed) {
    if (!v.employment && parsed.employment) v.employment = parsed.employment;
    if (!v.educationEntries && parsed.educationEntries) v.educationEntries = parsed.educationEntries;
    if (!v.dob && parsed.dob) v.dob = parsed.dob;
    if ((v.experienceYears == null || v.experienceYears === '') && parsed.totalExperienceYears != null) v.experienceYears = parsed.totalExperienceYears;
  }
  out.push(...plausibility(v));
  if (parsed) {
    WATCH.forEach((k) => {
      if (conf[k] !== 'low') return;
      const f = fieldKey(k);
      let read;
      if (k === 'employment') read = `${(parsed.employment || []).length} job(s)`;
      else if (k === 'educationEntries') read = `${(parsed.educationEntries || []).length} degree(s)`;
      else if (k === 'experience') read = parsed.totalExperienceYears;
      else if (k === 'email') read = (parsed.emails || [])[0];
      else if (k === 'phone') read = (parsed.phones || [])[0];
      else read = parsed[k];
      if (read == null || read === '') return;
      out.push(flag(f, 'low_confidence', `The parser was not sure about this ${(LABELS[f] || f).toLowerCase()}. Check it against the resume.`, { resumeSays: read, saved: values[f], evidence: ev[k] }));
    });
    // two different values in the resume itself
    (parsed.conflicts || []).forEach((c) => {
      if (!['currentSalary', 'expectedSalary', 'dob'].includes(c.field)) return;
      out.push(flag(c.field, 'conflict', `The resume gives two different values for ${LABELS[c.field].toLowerCase()}: ${(c.values || []).join(' and ')}.`, {
        resumeSays: (c.values || []).join(' / '), saved: values[c.field], evidence: (c.evidences || [])[0], evidences: c.evidences, values: c.values,
      }));
    });
    // the resume says one thing, the profile another
    if (values.name && parsed.name) {
      const a = wordsOf(values.name); const b = wordsOf(parsed.name);
      if (a.length && b.length && !a.some((w) => b.includes(w))) out.push(flag('name', 'conflict', `The name on the resume (${parsed.name}) is different from the profile name (${values.name}).`, { resumeSays: parsed.name, saved: values.name, evidence: ev.name }));
    }
    ['currentSalary', 'expectedSalary'].forEach((f) => {
      const r = lpaOf(parsed[f]); const s = lpaOf(values[f]);
      if (r != null && s != null && r > 0 && Math.abs(r - s) / Math.max(r, s) > 0.2) out.push(flag(f, 'conflict', `The resume says ${parsed[f]} but ${values[f]} is saved.`, { resumeSays: parsed[f], saved: values[f], evidence: ev[f] }));
    });
    if (values.experienceYears != null && values.experienceYears !== '' && parsed.totalExperienceYears != null && Math.abs(Number(values.experienceYears) - parsed.totalExperienceYears) > 1) {
      out.push(flag('experienceYears', 'conflict', `The resume says ${parsed.totalExperienceYears} years but ${values.experienceYears} is saved.`, { resumeSays: `${parsed.totalExperienceYears} years`, saved: `${values.experienceYears} years`, evidence: ev.experience }));
    }
    if (values.dob && parsed.dob && String(values.dob).slice(0, 10) !== parsed.dob) out.push(flag('dob', 'conflict', `The resume says ${parsed.dob} but ${String(values.dob).slice(0, 10)} is saved.`, { resumeSays: parsed.dob, saved: String(values.dob).slice(0, 10), evidence: ev.dob }));
    // inconsistent: the title / company on the profile is not the latest job of the resume
    const latest = (parsed.employment || []).find((j) => j.isCurrent) || (parsed.employment || [])[0];
    if (latest && values.currentDesignation && latest.title && titleSimilarity(values.currentDesignation, latest.title) < 0.25) {
      out.push(flag('currentDesignation', 'inconsistent', `The latest job on the resume is "${latest.title}" but the profile says "${values.currentDesignation}".`, { resumeSays: latest.title, saved: values.currentDesignation, evidence: latest.line }));
    }
    if (latest && values.currentCompany && latest.company && !wordsOf(values.currentCompany).some((w) => wordsOf(latest.company).includes(w))) {
      out.push(flag('currentCompany', 'inconsistent', `The latest job on the resume is at "${latest.company}" but the profile says "${values.currentCompany}".`, { resumeSays: latest.company, saved: values.currentCompany, evidence: latest.line }));
    }
  }
  const seen = new Set();
  return out.filter((f) => { const k = `${f.field}|${f.kind}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// --- the queue ---------------------------------------------------------------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ResumeFlag" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "field" TEXT NOT NULL, "kind" TEXT NOT NULL,
        "message" TEXT NOT NULL, "resumeSays" TEXT, "saved" TEXT, "evidence" TEXT, "evidences" TEXT, "status" TEXT NOT NULL DEFAULT 'OPEN', "source" TEXT, "resumeId" TEXT,
        "needsTl" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL, "createdByName" TEXT, "resolvedAt" TEXT, "resolvedById" TEXT, "resolvedByName" TEXT, "resolution" TEXT, "newValue" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ResumeFlag_cand" ON "ResumeFlag" ("candidateId","status")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ResumeFlag_status" ON "ResumeFlag" ("status","createdAt")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const OPEN_STATES = ['OPEN', 'WAIT_TL'];
const FINAL_STATES = ['APPROVED', 'CORRECTED', 'DISMISSED'];
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// Replaces the OPEN flags of the same source with the fresh ones (a re-upload does not pile up duplicates).
async function recordFlags(candidateId, flags, {
  source = 'resume', resumeId = null, user = null, needsTl = false,
} = {}) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "ResumeFlag" WHERE "candidateId" = ? AND "status" = \'OPEN\' AND "source" = ?', candidateId, source);
  for (const f of flags || []) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(`INSERT INTO "ResumeFlag" ("id","candidateId","field","kind","message","resumeSays","saved","evidence","evidences","status","source","resumeId","needsTl","createdAt","createdByName")
      VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)`, newId(), candidateId, f.field, f.kind, String(f.message).slice(0, 500), f.resumeSays, f.saved, f.evidence, f.evidences ? JSON.stringify(f.evidences) : null,
    source, resumeId, needsTl ? 1 : 0, nowIso(), user ? user.name : null);
  }
  return (flags || []).length;
}
const shape = (r) => ({
  id: r.id,
  candidateId: r.candidateId,
  field: r.field,
  label: LABELS[r.field] || r.field,
  kind: r.kind,
  message: r.message,
  resumeSays: r.resumeSays,
  saved: r.saved,
  evidence: r.evidence,
  evidences: (() => { try { return r.evidences ? JSON.parse(r.evidences) : null; } catch { return null; } })(),
  status: r.status,
  source: r.source,
  needsTl: !!r.needsTl,
  createdAt: r.createdAt,
  createdByName: r.createdByName,
  resolvedAt: r.resolvedAt,
  resolvedByName: r.resolvedByName,
  resolution: r.resolution,
  newValue: r.newValue,
});
async function flagsOf(candidateId, { openOnly = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "ResumeFlag" WHERE "candidateId" = ? ${openOnly ? 'AND "status" IN (\'OPEN\',\'WAIT_TL\')' : ''} ORDER BY "createdAt" DESC LIMIT 200`, candidateId);
  return rows.map(shape);
}
async function openCountOf(candidateIds) {
  await ensure();
  const out = new Map();
  for (let i = 0; i < candidateIds.length; i += 400) {
    const part = candidateIds.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT "candidateId", COUNT(*) AS n FROM "ResumeFlag" WHERE "status" IN ('OPEN','WAIT_TL') AND "candidateId" IN (${part.map(() => '?').join(',')}) GROUP BY "candidateId"`, ...part);
    rows.forEach((r) => out.set(r.candidateId, Number(r.n)));
  }
  return out;
}
// The queue: flags grouped by candidate, newest first. `candidateIdIn` (a Set) = the viewer's scope.
async function listQueue({ status = 'open', candidateIdIn = null, limit = 300 } = {}) {
  await ensure();
  const states = status === 'wait_tl' ? ['WAIT_TL'] : status === 'all' ? [...OPEN_STATES, ...FINAL_STATES] : OPEN_STATES;
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "ResumeFlag" WHERE "status" IN (${states.map(() => '?').join(',')}) ORDER BY "createdAt" DESC LIMIT 3000`, ...states);
  const ids = [...new Set(rows.map((r) => r.candidateId))].filter((id) => !candidateIdIn || candidateIdIn.has(id));
  const cands = ids.length ? await prisma.candidate.findMany({
    where: { id: { in: ids.slice(0, 2000) } },
    select: {
      id: true, name: true, phone: true, email: true, currentSalary: true, expectedSalary: true, experienceYears: true, dob: true, noticePeriod: true, location: true, education: true, currentDesignation: true, currentCompany: true,
    },
  }) : [];
  const byId = new Map(cands.map((c) => [c.id, c]));
  const groups = new Map();
  rows.forEach((r) => {
    if (!byId.has(r.candidateId)) return;
    if (!groups.has(r.candidateId)) groups.set(r.candidateId, { candidate: byId.get(r.candidateId), flags: [] });
    groups.get(r.candidateId).flags.push(shape(r));
  });
  const list = [...groups.values()].slice(0, limit);
  return { total: groups.size, flagCount: rows.filter((r) => byId.has(r.candidateId)).length, rows: list };
}

const COLUMN = {
  name: 'name', email: 'email', phone: 'phone', dob: 'dob', currentSalary: 'currentSalary', expectedSalary: 'expectedSalary', experienceYears: 'experienceYears', noticePeriod: 'noticePeriod', location: 'location', education: 'education', currentDesignation: 'currentDesignation', currentCompany: 'currentCompany',
};
function coerce(field, value) {
  if (field === 'experienceYears') { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 60) return { error: 'Experience must be a number of years.' }; return { value: n }; }
  if (field === 'currentSalary' || field === 'expectedSalary') {
    const p = SAL.parseAmount(value);
    if (!p || !p.ok) return { error: 'The salary could not be read. Write it like 4.5 LPA.' };
    return { value: SAL.normaliseLoose(value) || `${p.lpa} LPA` };
  }
  if (field === 'dob') { const d = RF.readDate(value); if (!d) return { error: 'Write the date of birth like 1995-03-12.' }; return { value: d }; }
  const s = String(value == null ? '' : value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'The corrected value cannot be empty.' };
  return { value: s.slice(0, 200) };
}
async function loadFlag(id) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "ResumeFlag" WHERE "id" = ?', id);
  return r || null;
}
// action: approve (the saved value stays) | correct (value) | dismiss (not a real problem).
// A flag that needs the TL (an upload by a recruiter) goes to WAIT_TL when a recruiter decides; a TL / Admin decision is final.
async function resolve(id, { action, value = null, note = null }, user, { isApprover = false } = {}) {
  const r = await loadFlag(id);
  if (!r) return { status: 404, error: 'Flag not found.' };
  if (!OPEN_STATES.includes(r.status)) return { status: 409, error: 'This flag is already decided.' };
  if (r.status === 'WAIT_TL' && !isApprover) return { status: 403, error: 'This one waits for the team lead to approve.' };
  let newValue = null;
  if (action === 'correct') {
    if (!COLUMN[r.field]) return { status: 400, error: `${LABELS[r.field] || r.field} is corrected on the profile itself.` };
    const c = coerce(r.field, value);
    if (c.error) return { status: 400, error: c.error };
    await prisma.candidate.update({ where: { id: r.candidateId }, data: { [COLUMN[r.field]]: c.value } });
    newValue = String(c.value);
    try { require('./candidateListCache').markCandidateDirty(r.candidateId); } catch { /* the list catches up */ } // eslint-disable-line global-require
  } else if (!['approve', 'dismiss'].includes(action)) return { status: 400, error: 'Say what to do: approve, correct or dismiss.' };
  const final = isApprover || !r.needsTl;
  let state = 'APPROVED';
  if (!final) state = 'WAIT_TL';
  else if (action === 'correct') state = 'CORRECTED';
  else if (action === 'dismiss') state = 'DISMISSED';
  await prisma.$executeRawUnsafe('UPDATE "ResumeFlag" SET "status"=?, "resolvedAt"=?, "resolvedById"=?, "resolvedByName"=?, "resolution"=?, "newValue"=? WHERE "id"=?',
    state, nowIso(), user ? user.id : null, user ? user.name : null, `${action}${note ? `: ${String(note).slice(0, 300)}` : ''}`, newValue, id);
  return {
    ok: true, state, field: r.field, candidateId: r.candidateId, newValue, before: r.saved, label: LABELS[r.field] || r.field, waitingForTl: state === 'WAIT_TL',
  };
}

module.exports = {
  checkProfile, plausibility, educationChecks, titleSimilarity, titleTokens, ageOn, recordFlags, flagsOf, openCountOf, listQueue, resolve, ensure, LABELS, OPEN_STATES, FINAL_STATES, lpaOf, COLUMN,
};
