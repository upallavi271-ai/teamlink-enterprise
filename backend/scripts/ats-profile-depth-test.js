#!/usr/bin/env node
/**
 * ATS PROFILE DEPTH (founder audit 2026-11-17): education list, employment history, gaps, career progression, title standardisation,
 * profile summary (AI refused in the sandbox -> rule-based), tags + the Candidates list's Tag filter, Admin custom fields, the resume
 * parse check, Telugu / Hindi resume text and the parser accuracy script.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4081.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-profile-depth-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-profdepth-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4081;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'profdepth-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
delete env.TEST_ALLOW_AI; // the summary must fall back to the rule-based one
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;

(async () => {
  // ---- pure rules first (no server needed)
  const PD = require('../src/utils/candidateProfileDepth');
  check('title rules: "Sr. Java Dev" and "Senior Java Developer" are the same standard title', PD.normaliseTitle('Sr. Java Dev') === 'Senior Java Developer' && PD.normaliseTitle('Senior Java Developer') === 'Senior Java Developer', [PD.normaliseTitle('Sr. Java Dev')]);
  check('title rules: "Jr. S/W Engg" -> Junior Software Engineer, "TL" -> Team Lead, "Asst. Mgr HR" -> Assistant Manager HR',
    PD.normaliseTitle('Jr. S/W Engg') === 'Junior Software Engineer' && PD.normaliseTitle('TL') === 'Team Lead' && PD.normaliseTitle('Asst. Mgr HR') === 'Assistant Manager HR');
  const R = require('../src/utils/resumeParse');
  const te = await R.parseResumeText('పేరు: రమేష్ కుమార్\nఫోన్: ౯౮౪౯౦౧౨౩౪౫\nఈమెయిల్: ramesh.k@gmail.com\nనాకు 5 years experience ఉంది', { vocabulary: ['java'] });
  check('a Telugu resume: Telugu detected, phone (Telugu digits), e-mail and the Telugu name are read', te.languages.includes('Telugu') && te.otherLanguage && te.phones.includes('9849012345') && te.emails[0] === 'ramesh.k@gmail.com' && te.name === 'రమేష్ కుమార్', te);
  const hi = await R.parseResumeText('नाम: सुनीता शर्मा\nमोबाइल: +91 ९८७६५४३२१०\nईमेल: sunita@yahoo.in', { vocabulary: [] });
  check('a Hindi resume: Hindi detected, phone (Devanagari digits) and name read', hi.languages.includes('Hindi') && hi.phones.some((p) => p.endsWith('9876543210')) && hi.name === 'सुनीता शर्मा', hi);
  const en = await R.parseResumeText('Ravi Teja\nravi@x.in 9848022331\nJava developer, 4 years experience', { vocabulary: ['java'] });
  check('an English resume is still English only', en.languages.length === 1 && en.languages[0] === 'English' && !en.otherLanguage, en.languages);
  const acc = await require('./resume-parse-accuracy').run({ quiet: true });
  check('the parse accuracy script measures every field over its samples (overall >= 80 %)', acc.samples >= 8 && ['name', 'email', 'phone', 'skills', 'experience'].every((f) => typeof acc.accuracy[f] === 'number') && acc.overall >= 80, acc.accuracy);

  // ---- server
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const REC = await prisma.user.create({ data: { name: `Pd recruiter ${P}`, email: `pd.rec.${P}@pd-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const NAME = `Pd Person ${P}`;
  const C = await prisma.candidate.create({ data: { name: NAME, phone: `9${String(P).padStart(9, '3').slice(-9)}`, email: `pd.person.${P}@pd-test.in`, currentDesignation: 'Sr. Java Dev', experienceYears: 6, skills: 'Java, Spring Boot, SQL', location: 'Hyderabad' } });
  // a resume the parser read earlier: the phone it read differs from the profile's (the recruiter corrected it), the e-mail matches
  await prisma.candidateResume.create({ data: { candidateId: C.id, kind: 'ORIGINAL', fileName: 'resume.pdf', parser: 'free', parsed: JSON.stringify({ name: NAME, emails: [C.email], phones: ['9000000001'], skills: ['java', 'sql'], totalExperienceYears: 6, languages: ['English'] }) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id);
  const base = `/candidates/${C.id}`;

  let d = await call('GET', `${base}/profile-depth`, null, tA);
  check('the Career data opens for the admin (empty lists, standard title of the current designation)', d.status === 200 && d.body.education.length === 0 && d.body.employment.length === 0 && d.body.currentTitle.standard === 'Senior Java Developer', d.body);
  check('a recruiter with no link to this person is refused (same scope as the profile)', (await call('GET', `${base}/profile-depth`, null, tR)).status === 403);
  check('...and cannot add a tag to them', (await call('POST', `${base}/tags`, { tag: 'x' }, tR)).status === 403);

  // ---- education
  check('education: a bad year is refused', (await call('POST', `${base}/education`, { degree: 'B.Tech', year: '19' }, tA)).status === 400);
  const e1 = await call('POST', `${base}/education`, { degree: 'B.Tech', specialisation: 'CSE', institute: 'JNTU Hyderabad', year: '2015', score: '72%' }, tA);
  const e2 = await call('POST', `${base}/education`, { degree: 'M.Tech', specialisation: 'Software Engineering', institute: 'Osmania University', year: '2017', score: '8.1 CGPA' }, tA);
  check('education: two entries added', e1.status === 201 && e2.status === 201, [e1.body, e2.body]);

  // ---- employment
  check('employment: "To" before "From" is refused', (await call('POST', `${base}/employment`, { company: 'X', title: 'Dev', fromMonth: '2020-05', toMonth: '2019-01' }, tA)).status === 400);
  const j1 = await call('POST', `${base}/employment`, { company: 'Alpha Soft', title: 'Java Developer', fromMonth: '2018-01', toMonth: '2020-06', ctc: '4 LPA' }, tA);
  const j2 = await call('POST', `${base}/employment`, { company: 'Beta Tech', title: 'Sr. Java Dev', fromMonth: '2021-01', toMonth: '2023-03' }, tA);
  const j3 = await call('POST', `${base}/employment`, { company: 'Gamma Labs', title: 'Team Leader', fromMonth: '2023-04', isCurrent: true, notes: 'Leads 6 people' }, tA);
  check('employment: three jobs added; the typed title keeps a standard title next to it', j1.status === 201 && j2.status === 201 && j3.status === 201 && j2.body.normalisedTitle === 'Senior Java Developer' && j3.body.normalisedTitle === 'Team Lead', [j2.body, j3.body]);

  d = await call('GET', `${base}/profile-depth`, null, tA);
  const b = d.body;
  const between = b.gaps.find((g) => g.kind === 'Between jobs');
  const afterEdu = b.gaps.find((g) => g.kind === 'After education');
  check('gaps: 6 months between Alpha Soft and Beta Tech is found', between && between.months === 6 && /Alpha Soft/.test(between.text), b.gaps);
  check('gaps: 6 months after education (M.Tech 2017 -> Jan 2018) is found; no gap from Beta to Gamma (1 month)', afterEdu && afterEdu.months === 6 && b.gaps.length === 2, b.gaps);
  check('career progression: "3 jobs in N years, Developer -> Senior -> Team Lead, avg tenure", going up', b.progression.jobs === 3 && b.progression.trend === 'up' && /^3 jobs in \d+ years, Developer → Senior → Team Lead, avg tenure \d+\.\d y/.test(b.progression.line), b.progression);
  check('education is a list with degree, specialisation, institute, year, score', b.education.length === 2 && b.education.some((e) => e.degree === 'M.Tech' && e.score === '8.1 CGPA' && e.institute === 'Osmania University'));
  check('the employment list carries company, title, from, to, current, CTC, notes', b.employment.length === 3 && b.employment.some((j) => j.isCurrent && j.company === 'Gamma Labs' && j.notes === 'Leads 6 people' && !j.toMonth) && b.employment.some((j) => j.ctc === '4 LPA'));

  // edit + remove
  const ed = await call('PUT', `${base}/employment/${j1.body.id}`, { company: 'Alpha Soft', title: 'Java Developer', fromMonth: '2018-01', toMonth: '2020-12' }, tA);
  d = await call('GET', `${base}/profile-depth`, null, tA);
  check('editing a job (left Dec 2020) clears the between-jobs gap', ed.status === 200 && !d.body.gaps.some((g) => g.kind === 'Between jobs'), d.body.gaps);
  const del = await call('DELETE', `${base}/education/${e1.body.id}`, null, tA);
  d = await call('GET', `${base}/profile-depth`, null, tA);
  check('an education entry is removed', del.status === 200 && d.body.education.length === 1);

  // ---- tags
  const t1 = await call('POST', `${base}/tags`, { tag: 'Night Shift OK' }, tA);
  const t2 = await call('POST', `${base}/tags`, { tag: 'night shift ok' }, tA);
  const t3 = await call('POST', `${base}/tags`, { tag: `Hot${P}` }, tA);
  check('tags: added; the same tag in other letters is not added twice', t1.status === 201 && t2.status === 200 && t2.body.added === false && t3.status === 201 && t3.body.tags.length === 2, [t1.body, t2.body, t3.body]);
  const tl = await call('GET', '/candidates/profile-tags', null, tA);
  check('the tag list has the tag with a count', tl.status === 200 && tl.body.tags.some((x) => x.value === `Hot${P}` && x.count === 1), tl.body);
  const listQ = (tag) => `/candidates?paged=1&view=master&sub=all&pageSize=50&search=${encodeURIComponent(NAME)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`;
  let ls = await call('GET', listQ(`hot${P}`), null, tA);
  check('the Candidates list filters by tag: the person is there', ls.status === 200 && ls.body.rows.some((r) => r.id === C.id), { status: ls.status, total: ls.body && ls.body.total });
  ls = await call('GET', listQ(`NoSuchTag${P}`), null, tA);
  check('...and not under a tag they do not have', ls.status === 200 && !ls.body.rows.some((r) => r.id === C.id));
  await call('POST', `${base}/tags/remove`, { tag: `HOT${P}` }, tA);
  ls = await call('GET', listQ(`hot${P}`), null, tA);
  check('a removed tag no longer lists the person', ls.status === 200 && !ls.body.rows.some((r) => r.id === C.id));

  // ---- custom fields
  check('a recruiter cannot define a custom field', (await call('POST', '/candidates/profile-fields', { label: 'X', type: 'text' }, tR)).status === 403);
  check('a pick list needs options', (await call('POST', '/candidates/profile-fields', { label: `Shift ${P}`, type: 'select', options: [] }, tA)).status === 400);
  const f1 = await call('POST', '/candidates/profile-fields', { label: `Shift ${P}`, type: 'select', options: ['Day', 'Night', 'Rotational'], required: true }, tA);
  const f2 = await call('POST', '/candidates/profile-fields', { label: `Typing speed ${P}`, type: 'number' }, tA);
  const f3 = await call('POST', '/candidates/profile-fields', { label: `Passport expiry ${P}`, type: 'date' }, tA);
  check('Admin defines select / number / date fields', f1.status === 201 && f2.status === 201 && f3.status === 201 && f1.body.required === true, [f1.body, f2.body, f3.body]);
  check('the same label twice is refused', (await call('POST', '/candidates/profile-fields', { label: `shift ${P}`, type: 'text' }, tA)).status === 409);
  const cf = (values) => call('PUT', `${base}/custom-fields`, { values }, tA);
  check('a value not in the pick list is refused', (await cf({ [f1.body.id]: 'Evening' })).status === 400);
  check('a number field refuses words', (await cf({ [f2.body.id]: 'fast' })).status === 400);
  check('a date field refuses a bad date', (await cf({ [f3.body.id]: '31-12-2030' })).status === 400);
  check('a required field cannot be saved blank', (await cf({ [f1.body.id]: '' })).status === 400);
  const ok = await cf({ [f1.body.id]: 'night', [f2.body.id]: '45', [f3.body.id]: '2030-12-31' });
  d = await call('GET', `${base}/profile-depth`, null, tA);
  const fv = (id) => (d.body.customFields.find((x) => x.id === id) || {}).value;
  check('good values are saved and shown on the profile (pick list spelled as defined)', ok.status === 200 && ok.body.changed === 3 && fv(f1.body.id) === 'Night' && fv(f2.body.id) === '45' && fv(f3.body.id) === '2030-12-31', d.body.customFields);
  const off = await call('PUT', `/candidates/profile-fields/${f3.body.id}`, { active: false }, tA);
  d = await call('GET', `${base}/profile-depth`, null, tA);
  check('a switched-off field leaves the profile (Admin still sees it with ?all=1)', off.status === 200 && !d.body.customFields.some((x) => x.id === f3.body.id)
    && (await call('GET', '/candidates/profile-fields?all=1', null, tA)).body.fields.some((x) => x.id === f3.body.id && !x.active));

  // ---- summary
  const sm = await call('POST', `${base}/profile-summary`, { useAi: true }, tA);
  check('profile summary: AI is refused in the sandbox, so a rule-based summary is written from the fields', sm.status === 200 && sm.body.source === 'rules' && !!sm.body.aiNote && sm.body.summary.includes(NAME) && /Career: 3 jobs/.test(sm.body.summary) && /M\.Tech/.test(sm.body.summary) && /Java/.test(sm.body.summary), sm.body);
  d = await call('GET', `${base}/profile-depth`, null, tA);
  check('...and it is kept on the profile', d.body.summary && d.body.summary.source === 'rules' && d.body.summary.summary === sm.body.summary);

  // ---- parse check
  const pc = d.body.parseCheck;
  const row = (f) => (pc && pc.rows.find((r) => r.field === f)) || {};
  check('parse check: the phone the parser read was corrected by the recruiter; the e-mail and name were kept', pc && row('Phone').status === 'Corrected by recruiter' && row('Email').status === 'Kept' && row('Name').status === 'Kept' && typeof pc.accuracyPct === 'number', pc);

  // ---- audit
  const audits = await prisma.auditLog.findMany({ where: { entityId: C.id }, select: { action: true } });
  const acts = new Set(audits.map((a) => a.action));
  check('every change is in the audit log', ['Education entry added', 'Education entry removed', 'Employment entry added', 'Employment entry changed', 'Tag added', 'Tag removed', 'Custom field changed', 'Profile summary written (from the fields)'].every((a) => acts.has(a)), [...acts]);
  check('defining a custom field is audited', (await prisma.auditLog.count({ where: { entityId: f1.body.id, action: 'Candidate custom field added' } })) === 1);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
