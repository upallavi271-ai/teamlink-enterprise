// ---------------------------------------------------------------------------
// IMPORT FROM ATS (Customers > "Import from ATS"): an EXPLICIT, audited copy of ATS candidates into Omni-Channel contacts. Admin and Team Lead only (access.js mayImportAts).
//   * Which candidates: the applications this login may already see (utils/scope applicationWhere), narrowed by Job, Stage and Department. A Team Lead therefore copies
//     only their own team's candidates.
//   * What is copied: name, phone, email, city (the candidate's location), skills, experience. NEVER salary (current / expected), never a note, never a document: those
//     columns are not even read.
//   * Each new contact: type candidate_lead, source 'ATS', linkedApplicantId = the candidate id, department = the job's department, owned by the person who copied;
//     every channel starts "Not asked" (unknown). Sending stays blocked until consent is recorded, OR an Admin has switched on policy.consentRules()
//     .atsAppliedMeansJobAllowed (default OFF; the campaigns engine reads it). An opt-out / do-not-contact entry always wins (the contact lands opted out).
//   * Idempotent: a candidate who is already a contact (same candidate id, or the same phone / email) is skipped, so pressing it twice adds nobody twice.
//   * One batch row in the Imports list (so it can be taken back for 7 days like a file import).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const K = require('./contacts');
const scope = require('../utils/scope');
const vocab = require('../utils/atsVocab');
const { logAudit } = require('../utils/audit');

const MAX_PER_RUN = 2000; // one press adds at most this many (press again for the rest)
const MAX_SCAN = 8000;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// the jobs, stages and departments to pick from (only what this login may see)
async function options(user) {
  const jobs = await prisma.requirement.findMany({ where: scope.requirementWhere(user), select: { id: true, title: true, department: true, status: true, client: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 400 }).catch(() => []);
  const depts = [...new Set(jobs.map((j) => (j.department || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    jobs: jobs.map((j) => ({ id: j.id, title: j.title, department: j.department || '', client: j.client ? j.client.name : '', open: j.status === 'OPEN' })),
    stages: (vocab.ALL_STAGE_CODES || []).map((c) => ({ id: c, label: vocab.STAGE_LABELS[c] || c })),
    departments: depts,
  };
}

function whereOf(user, f) {
  const and = [scope.applicationWhere(user)];
  const jobIds = (Array.isArray(f.jobIds) ? f.jobIds : []).map(String).filter(Boolean).slice(0, 100);
  const stages = (Array.isArray(f.stages) ? f.stages : []).map(String).filter((s) => (vocab.ALL_STAGE_CODES || []).includes(s));
  const depts = (Array.isArray(f.departments) ? f.departments : []).map((d) => String(d).trim()).filter(Boolean).slice(0, 30);
  if (jobIds.length) and.push({ requirementId: { in: jobIds } });
  if (stages.length) and.push({ stage: { in: stages } });
  if (depts.length) and.push({ requirement: { department: { in: depts } } });
  return { AND: and };
}

// the distinct candidates behind the applications (newest first); only the boxes we may copy are read
async function candidatesOf(user, f) {
  const apps = await prisma.application.findMany({
    where: whereOf(user, f), orderBy: { createdAt: 'desc' }, take: MAX_SCAN,
    select: { candidateId: true, stage: true, requirement: { select: { title: true, department: true } }, candidate: { select: { id: true, name: true, phone: true, email: true, location: true, skills: true, experienceYears: true, doNotContact: true, consentStatus: true } } },
  });
  const seen = new Map();
  for (const a of apps) if (a.candidate && !seen.has(a.candidateId)) seen.set(a.candidateId, { c: a.candidate, job: a.requirement ? a.requirement.title : '', dept: a.requirement ? (a.requirement.department || '') : '', stage: a.stage });
  return { list: [...seen.values()], scanned: apps.length, capped: apps.length >= MAX_SCAN };
}

// who is already a contact: by candidate id, by phone, by email
async function known(list) {
  const ids = new Set(); const phones = new Set(); const emails = new Set();
  const cand = list.map((x) => x.c.id);
  const pk = []; const ek = [];
  list.forEach((x) => { const p = K.phoneOf(x.c.phone); const e = K.emailOf(x.c.email); if (p.ok) pk.push(p.key); if (e.ok) ek.push(e.key); });
  const ph = (n) => new Array(n).fill('?').join(',');
  for (const part of chunk(cand, 400)) (await S.q(`SELECT linkedApplicantId v FROM "OutreachContact" WHERE status = 'active' AND linkedApplicantId IN (${ph(part.length)})`, ...part)).forEach((r) => ids.add(r.v)); // eslint-disable-line no-await-in-loop
  for (const part of chunk([...new Set(pk)], 400)) (await S.q(`SELECT phoneKey v FROM "OutreachContact" WHERE status = 'active' AND phoneKey IN (${ph(part.length)})`, ...part)).forEach((r) => phones.add(r.v)); // eslint-disable-line no-await-in-loop
  for (const part of chunk([...new Set(ek)], 400)) (await S.q(`SELECT emailKey v FROM "OutreachContact" WHERE status = 'active' AND emailKey IN (${ph(part.length)})`, ...part)).forEach((r) => emails.add(r.v)); // eslint-disable-line no-await-in-loop
  return { ids, phones, emails };
}

function classify(list, kn) {
  const t = { found: list.length, already: 0, noContact: 0, doNotContact: 0, toAdd: [] };
  for (const x of list) {
    const p = K.phoneOf(x.c.phone); const e = K.emailOf(x.c.email);
    if (x.c.doNotContact === true || String(x.c.consentStatus || '').toUpperCase() === 'WITHDRAWN') { t.doNotContact += 1; continue; } // eslint-disable-line no-continue
    if (!p.ok && !e.ok) { t.noContact += 1; continue; } // eslint-disable-line no-continue
    if (kn.ids.has(x.c.id) || (p.ok && kn.phones.has(p.key)) || (e.ok && kn.emails.has(e.key))) { t.already += 1; continue; } // eslint-disable-line no-continue
    t.toAdd.push({ ...x, phone: p.ok ? p : null, email: e.ok ? e : null });
  }
  return t;
}

// the counts, nothing saved
async function preview(user, f = {}) {
  if (!A.has('mayImportAts')(user)) return { error: 'Only an Admin or a Team Lead can copy candidates from the ATS.', status: 403 };
  const got = await candidatesOf(user, f);
  const t = classify(got.list, await known(got.list));
  return {
    found: t.found, alreadyInContacts: t.already, noPhoneOrEmail: t.noContact, doNotContact: t.doNotContact, willAdd: t.toAdd.length, capped: got.capped,
    willAddNow: Math.min(t.toAdd.length, MAX_PER_RUN), perRun: MAX_PER_RUN,
    sample: t.toAdd.slice(0, 10).map((x) => ({ name: x.c.name || '', job: x.job, stage: vocab.STAGE_LABELS[x.stage] || x.stage })), // names only: never a phone or an email
  };
}

// the copy
async function run(user, f = {}) {
  if (!A.has('mayImportAts')(user)) return { error: 'Only an Admin or a Team Lead can copy candidates from the ATS.', status: 403 };
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const got = await candidatesOf(user, f);
  const t = classify(got.list, await known(got.list));
  const todo = t.toAdd.slice(0, MAX_PER_RUN);
  if (!todo.length) return { ok: 'Nobody new to add: everyone found is already in Customers, or has no phone or email.', created: 0, alreadyInContacts: t.already, noPhoneOrEmail: t.noContact, doNotContact: t.doNotContact, left: 0 };
  const batchId = S.newId('oi'); const now = Date.now();
  const basis = 'Copied from our own ATS candidates. Permission is not recorded yet: every way of contact starts as "Not asked".';
  await S.run('INSERT INTO "OutreachImport" (id, fileName, sha256, mapping, contactType, dupMode, basis, basisConfirmedById, basisConfirmedAt, source, industries, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    batchId, 'ATS import', null, null, 'candidate_lead', 'skip', basis, user.id, now, 'ATS', '[]', user.id, user.name, now);
  const undo = { created: [], updated: [] };
  let created = 0; let optedOut = 0; let raced = 0;
  for (const x of todo) {
    try {
      const row = await K.insert(user, { type: 'candidate_lead', name: x.c.name, phone: x.phone, email: x.email, city: x.c.location, skills: x.c.skills, experience: x.c.experienceYears != null ? String(x.c.experienceYears) : '', source: 'ATS', importId: batchId, department: x.dept || null, industries: [] }, { declared: false }); // eslint-disable-line no-await-in-loop
      await S.run('UPDATE "OutreachContact" SET linkedApplicantId = ? WHERE id = ?', x.c.id, row.id); // eslint-disable-line no-await-in-loop
      undo.created.push(row.id); created += 1;
      if ((await S.q('SELECT 1 x FROM "OutreachContactChannel" WHERE contactId = ? AND optIn = \'opted_out\' LIMIT 1', row.id)).length) optedOut += 1; // eslint-disable-line no-await-in-loop
    } catch (e) { if (/UNIQUE/i.test(String(e.message))) raced += 1; else throw e; }
  }
  await S.run('UPDATE "OutreachImport" SET total = ?, created = ?, updated = 0, duplicates = ?, invalid = ?, optedOut = ?, undoLog = ? WHERE id = ?', got.list.length, created, t.already + raced, t.noContact, optedOut, JSON.stringify(undo), batchId);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Contacts copied from the ATS', entity: 'OutreachImport', entityId: batchId, toValue: `${created} added · ${t.already + raced} already there · ${t.noContact} no phone or email · ${t.doNotContact} do not contact` });
  const left = Math.max(0, t.toAdd.length - todo.length);
  return { ok: `${created} people added from the ATS. Every way of contact is "Not asked" until permission is recorded. Nothing was sent.${left ? ` ${left} more are left: press the button again.` : ''}`, created, alreadyInContacts: t.already + raced, noPhoneOrEmail: t.noContact, doNotContact: t.doNotContact, optedOut, left, importId: batchId };
}

module.exports = { options, preview, run, MAX_PER_RUN };
