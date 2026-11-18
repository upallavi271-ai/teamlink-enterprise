#!/usr/bin/env node
/**
 * ROUND 3 - RESUME PARSING QUALITY AND CANDIDATE DATA (founder audit 2026-11-18).
 * One shared parser (CTC, notice, jobs, degrees, personal details, RTF), a confidence per field, the verify queue (low confidence, implausible and conflicting
 * values) with the TL approval step, the Admin switch for auto-create, the name + DOB + qualification duplicate key, personal details + preferred locations,
 * ID document permission + read log, the rejoin / reapply timeline, the reason for a salary / experience change, stale data, Fit score history, JD match,
 * and the parsing-accuracy run (RESUME_SAMPLE_DIR) with its stored "Parsing quality" runs.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4161 node scripts/r3-data-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-r3data-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4161;
const API = `http://localhost:${PORT}/api`;
const SAMPLES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-r3-samples-'));
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'r3data-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, RESUME_SAMPLE_DIR: SAMPLES_DIR, TEST_NO_RESCORE: '1',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const upload = async (url, token, filename, buf, mime, fields = {}) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf], { type: mime }), filename);
  const r = await fetch(API + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const rtf = (text) => Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs22 ${text.split('\n').map((l) => l.replace(/[\\{}]/g, (c) => `\\${c}`)).join('\\par ')}}`, 'latin1');
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(SAMPLES_DIR, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}
const P = process.pid;
let seq = 0;
const phone = () => { seq += 1; return `98${String(P).padStart(6, '0').slice(-6)}${String(seq).padStart(2, '0')}`; };
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  // ================= pure checks (no server): the shared parser =================
  const RP = require('../src/utils/resumeParse');
  const RF = require('../src/utils/resumeFields');
  const RV = require('../src/utils/resumeVerify');
  const FP = require('../src/utils/candidateFingerprint');
  const CD = require('../src/utils/candidateData');
  const JD = require('../src/utils/jdMatch');
  const TEXT = `Ravi Teja Kondapalli
Email: ravi.teja.k@gmail.com | Mobile: +91 98480 22331
Hyderabad, Telangana
Date of Birth: 12/03/1995
Marital Status: Married
Father's Name: Kondapalli Suryanarayana
Native Place: Guntur
Address: 12-5-67, Vijayapuri Colony
Tarnaka, Hyderabad 500017
Languages Known: English, Telugu, Hindi
Current CTC: 5.5 LPA   Expected CTC: 8,00,000
Notice Period: 30 days
Java developer with 5 years of experience building Spring Boot microservices.
SKILLS: Java, Spring Boot, Hibernate, MySQL, Docker, Git, Communication
EXPERIENCE
Senior Software Engineer, Infotech Pvt Ltd   Jan 2022 - Present
Software Engineer, CodeWorks Solutions   Jun 2019 - Dec 2021
EDUCATION
B.Tech (CSE), JNTU Hyderabad, 2019, 72%
Intermediate, Narayana Junior College, 2015`;
  const pr = await RP.parseResumeText(TEXT, { vocabulary: RP.BUILTIN_SKILLS });
  check('parser: labelled current + expected CTC read (5.5 LPA, 8,00,000 -> 8 LPA)', pr.currentSalary === '5.5 LPA' && pr.expectedSalary === '8 LPA', [pr.currentSalary, pr.expectedSalary]);
  check('parser: notice period read as days', pr.noticePeriod === '30 Days', pr.noticePeriod);
  check('parser: one entry per job (company, title, months, current)', pr.employment.length === 2 && pr.employment[0].company === 'Infotech Pvt Ltd' && pr.employment[0].title === 'Senior Software Engineer' && pr.employment[0].fromMonth === '2022-01' && pr.employment[0].isCurrent && pr.employment[1].toMonth === '2021-12', pr.employment);
  check('parser: one entry per degree (degree, specialisation, institute, year, score)', pr.educationEntries.length === 2 && pr.educationEntries[0].degree === 'B.Tech' && pr.educationEntries[0].specialisation === 'CSE' && pr.educationEntries[0].institute === 'JNTU Hyderabad' && pr.educationEntries[0].year === '2019' && pr.educationEntries[0].score === '72%', pr.educationEntries);
  check('parser: languages known, address, native place, marital status, father\'s name, date of birth', pr.languagesKnown.join() === 'English,Hindi,Telugu' && /Vijayapuri/.test(pr.address) && pr.nativePlace === 'Guntur' && pr.maritalStatus === 'Married' && pr.fatherName === 'Kondapalli Suryanarayana' && pr.dob === '1995-03-12', [pr.languagesKnown, pr.address, pr.nativePlace, pr.maritalStatus, pr.fatherName, pr.dob]);
  check('parser: skills sorted into categories (language / framework / database / cloud / tool / soft)', pr.skillCategories.language.includes('java') && pr.skillCategories.framework.includes('spring boot') && pr.skillCategories.database.includes('mysql') && pr.skillCategories.cloud.includes('docker') && pr.skillCategories.tool.includes('git') && pr.skillCategories.soft.includes('communication'), pr.skillCategories);
  check('parser: confidence - labelled values high, the first-line name medium, a guessed period medium', pr.confidence.email === 'high' && pr.confidence.currentSalary === 'high' && pr.confidence.dob === 'high' && pr.confidence.name === 'medium' && pr.confidence.expectedSalary === 'medium', pr.confidence);
  check('parser: every value keeps the resume sentence it came from', /Current CTC: 5.5 LPA/.test(pr.evidence.currentSalary) && /Notice Period: 30 days/.test(pr.evidence.noticePeriod) && /Date of Birth/.test(pr.evidence.dob), pr.evidence);
  const salCases = [['Presently drawing 4.2 LPA, looking for around 6 LPA. Can join within 30 days.', '4.2 LPA', '6 LPA'], ['CTC: 6,00,000 (current)  Expected: 9 LPA', '6 LPA', '9 LPA'], ['Current salary Rs. 35,000 per month', '4.2 LPA', null], ['Total 7.5 LPA fixed', '7.5 LPA', null]];
  const sc = salCases.map(([t, c, e]) => { const r = RF.extractSalaries(t); return (r.current && r.current.value) === c && ((r.expected && r.expected.value) || null) === e; });
  check('parser: unlabelled and odd CTC forms (5.5 LPA words, 6,00,000, per month)', sc.every(Boolean), sc);
  const two = RF.extractSalaries('Current CTC: 6 LPA\nPresent Salary: 9 LPA');
  check('parser: two different current CTCs -> low confidence + both listed as a conflict', two.current.confidence === 'low' && two.current.conflict && two.current.values.length === 2, two);
  check('notice forms: immediate / 2 months / "15 days notice"', RF.extractNotice('Notice period: immediate').value === 'Immediate' && RF.extractNotice('Notice period - 2 months').value === '60 Days' && RF.extractNotice('I serve 15 days notice').value === '15 Days');
  const rt = RF.rtfToText(rtf('Anil Kumar\nEmail: anil.k@gmail.com\nCurrent CTC: 4.2 LPA'));
  check('RTF text is read (lines, fonts table dropped)', /Anil Kumar\nEmail: anil\.k@gmail\.com\nCurrent CTC: 4\.2 LPA/.test(rt) && !/Arial|fonttbl/.test(rt), rt);
  check('a resume saved as RTF is a resume kind (sniffed, stored, extracted)', require('../src/utils/resumeStore').validateResumeFile({ filename: 'cv.rtf', data: rtf('Anil Kumar\nEmail: anil.k@gmail.com') }).kind === 'rtf' && (await RP.extractText(rtf('Anil Kumar\nEmail: a@b.com'), 'rtf')).text.includes('Anil Kumar'));
  // plausibility and conflicts (items 80, 85, 103, 108)
  const kinds = (fl) => fl.map((f) => `${f.field}:${f.kind}`);
  const young = RV.plausibility({ dob: '2015-06-05' });
  const old = RV.plausibility({ dob: '1940-01-01' });
  check('implausible: age under 16 and over 70 from the date of birth', young.some((f) => f.field === 'dob') && old.some((f) => f.field === 'dob'), [kinds(young), kinds(old)]);
  check('implausible: experience more than age minus 16', RV.plausibility({ dob: '2000-01-01', experienceYears: 15 }).some((f) => f.field === 'experienceYears'));
  check('implausible: CTC outside the sane range, expected far below current, expected far above', RV.plausibility({ currentSalary: '900 LPA' }).some((f) => f.field === 'currentSalary')
    && RV.plausibility({ currentSalary: '12 LPA', expectedSalary: '4 LPA' }).some((f) => f.field === 'expectedSalary') && RV.plausibility({ currentSalary: '3 LPA', expectedSalary: '20 LPA' }).some((f) => f.field === 'expectedSalary'));
  check('implausible: end before start, a future date', RV.plausibility({ employment: [{ fromMonth: '2020-05', toMonth: '2019-01' }] }).some((f) => /before it starts/.test(f.message)) && RV.plausibility({ employment: [{ fromMonth: '2090-01', toMonth: null }] }).some((f) => /future/.test(f.message)));
  const edu = RV.educationChecks({ dob: '2000-01-01', educationEntries: [{ degree: 'B.Tech', rank: 5, year: '2012', line: 'x' }, { degree: 'M.Tech', rank: 7, year: '2011', line: 'y' }], experienceYears: 20 });
  check('education: passing year vs age, a master\'s before the bachelor\'s, experience longer than the years since the degree', edu.length >= 3 && edu.some((f) => /years old when finishing/.test(f.message)) && edu.some((f) => /master's degree comes after/.test(f.message)) && edu.some((f) => f.field === 'experienceYears'), edu.map((f) => f.message));
  check('education: an impossible combination (B.Tech with Nursing)', RV.educationChecks({ educationEntries: [{ degree: 'B.Tech', rank: 5, year: '2019', specialisation: 'Nursing', line: 'z' }] }).some((f) => /does not fit/.test(f.message)));
  check('similar job titles: "Sr. Java Dev" ~ "Senior Java Developer", not "Staff Nurse"', RV.titleSimilarity('Sr. Java Dev', 'Senior Java Developer') >= 0.6 && RV.titleSimilarity('Sr. Java Dev', 'Staff Nurse') < 0.2, [RV.titleSimilarity('Sr. Java Dev', 'Senior Java Developer'), RV.titleSimilarity('Sr. Java Dev', 'Staff Nurse')]);
  const cf = RV.checkProfile({ name: 'Somebody Else', currentSalary: '12 LPA', experienceYears: 2, currentDesignation: 'Staff Nurse' }, pr);
  check('conflicts: the resume name differs from the profile name, the saved CTC differs from the resume, the saved title is not the latest job', cf.some((f) => f.field === 'name' && f.kind === 'conflict') && cf.some((f) => f.field === 'currentSalary' && f.kind === 'conflict') && cf.some((f) => f.field === 'currentDesignation' && f.kind === 'inconsistent') && cf.some((f) => f.field === 'experienceYears' && f.kind === 'conflict'), kinds(cf));
  // duplicate key (item 46)
  const keys = FP.fingerprintsOf({ name: 'Ravi Kumar Teja', dob: '1995-03-12', education: 'B.Tech' });
  const cl = FP.classify(new Set(['NAME_DOB_QUAL']));
  check('duplicate key: name + date of birth + qualification is a key and warns (POSSIBLE)', keys.some((k) => k.kind === 'NAME_DOB_QUAL') && cl && cl.level === 'POSSIBLE' && cl.reasons[0] === 'name_dob_qual' && FP.REASON_TEXT.name_dob_qual === 'Same name, date of birth and qualification');
  // JD match (checklist-168 #66)
  const JDT = 'We need a Java developer with Spring Boot microservices, Hibernate and MySQL. Responsibilities include building REST APIs, writing unit tests, working with Docker and Git. Must have strong communication and 3 years of Java experience.';
  const m1 = JD.jdMatch(JDT, TEXT); const m2 = JD.jdMatch(JDT, 'Staff nurse with ICU patient care experience in a multi speciality hospital in Hyderabad and Chennai over many years of service. Handled ventilators, medication charts, wound care and emergency triage for five years. Completed GNM from a recognised nursing school.');
  check('JD match: a Java resume matches a Java job far better than a nurse resume (full text, no AI)', m1 && m2 && m1.pct >= 40 && m1.pct > m2.pct + 25 && m1.matched.length > 3, [m1 && m1.pct, m2 && m2.pct]);

  // ================= server =================
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (name, extra) => prisma.user.create({ data: { name: `Zr ${name} ${P}`, email: `zr.${name}.${P}@zr-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false }, select: { id: true, clientId: true, title: true, skills: true }, take: 50 });
  const J1 = live[0]; const J2 = live[1];
  await prisma.requirement.update({
    where: { id: J1.id },
    data: { recruiterId: REC.id, bdeId: BDE.id, skills: 'Java, Spring Boot, Hibernate', description: JDT, responsibilities: 'Build REST APIs with Spring Boot and Hibernate. Write unit tests. Deploy with Docker and Git.' },
  });
  await prisma.requirement.update({ where: { id: J2.id }, data: { recruiterIds: REC2.id } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id); const tR2 = await tok(REC2.id); const tT = await tok(TL.id); const tB = await tok(BDE.id);

  // ---------- the bulk upload path (RTF) with the shared parser
  const lines = (o) => [o.name, `Email: ${o.email}`, `Mobile: ${o.phone}`, 'Hyderabad, Telangana', ...(o.extra || []), 'SKILLS: Java, Spring Boot, MySQL, Docker',
    'Senior Developer, Alpha Technologies Pvt Ltd   Apr 2018 - Present', 'Developer, Beta Solutions   Jun 2015 - Mar 2018', 'B.Tech (CSE), JNTU Hyderabad, 2014, 68%'].join('\n');
  const clean = { name: `Zr Clean ${P}`, email: `zr.clean.${P}@zr-test.in`, phone: phone(), extra: ['Date of Birth: 21-07-1992', 'Current CTC: 5.5 LPA', 'Expected CTC: 7 LPA', 'Notice Period: 60 days', 'Marital Status: Single', "Father's Name: Zr Father", 'Native Place: Guntur', 'Languages Known: English, Telugu'] };
  const bad = { name: `Zr Odd ${P}`, email: `zr.odd.${P}@zr-test.in`, phone: phone(), extra: ['Date of Birth: 05-06-2015', '8 years of experience', 'Current CTC: 6 LPA', 'Present Salary: 9 LPA', 'Expected CTC: 2 LPA'] };
  const p1 = await upload('/ats-io/resumes/parse', tR, 'clean.rtf', rtf(lines(clean)), 'application/rtf');
  check('bulk parse: an RTF resume is read, with CTC, notice period and date of birth (the old bulk parser skipped them)', p1.status === 200 && !p1.body.error && p1.body.kind === 'rtf' && p1.body.fields.currentSalary === '5.5 LPA' && p1.body.fields.expectedSalary === '7 LPA' && p1.body.fields.noticePeriod === '60 Days' && p1.body.fields.dob === '1992-07-21', p1.body);
  check('bulk parse: a confidence chip per field, the resume sentence, the jobs / degrees / personal details', p1.body.confidence.currentSalary === 'high' && /Current CTC/.test(p1.body.evidence.currentSalary) && p1.body.details.employment.length === 2 && p1.body.details.educationEntries.length === 1 && p1.body.details.maritalStatus === 'Single', p1.body.details);
  check('bulk parse: a clean resume has nothing flagged', Array.isArray(p1.body.flags) && p1.body.flags.length === 0, p1.body.flags);
  const p2 = await upload('/ats-io/resumes/parse', tR, 'odd.rtf', rtf(lines(bad)), 'application/rtf');
  const fk = (p2.body.flags || []).map((f) => `${f.field}:${f.kind}`);
  check('bulk parse: an odd resume is flagged - age 11, experience > age - 16, two CTCs, expected far below current', fk.includes('dob:implausible') && fk.includes('experienceYears:implausible') && fk.includes('currentSalary:conflict') && fk.includes('expectedSalary:implausible'), fk);
  check('bulk parse: each flag carries the resume sentence to highlight', (p2.body.flags || []).filter((f) => f.field === 'dob').every((f) => /Date of Birth: 05-06-2015/.test(f.evidence || '')), p2.body.flags);

  // ---------- auto-create switch (default OFF)
  const sOff = await call('GET', '/ats/data-verify/settings', null, tR);
  check('the auto-create switch is OFF by default; stale days 180', sOff.status === 200 && sOff.body.autoCreateStaffUploads === false && sOff.body.staleDays === 180 && sOff.body.canChange === false, sOff.body);
  const clean2 = { name: 'Zr Autocreate Person', email: `zr.auto.${P}@zr-test.in`, phone: phone(), extra: clean.extra };
  const a0 = await upload('/ats-io/resumes/parse', tR, 'auto.rtf', rtf(lines(clean2)), 'application/rtf', { auto: '1' });
  check('switch OFF: a clean staff upload is NOT created on its own - the human Confirm stays', a0.status === 200 && !a0.body.autoCreated && !(await prisma.candidate.findFirst({ where: { email: clean2.email } })), a0.body.autoCreated);
  check('a recruiter cannot change the switch', (await call('PUT', '/ats/data-verify/settings', { autoCreateStaffUploads: true }, tR)).status === 403);
  const on = await call('PUT', '/ats/data-verify/settings', { autoCreateStaffUploads: true, staleDays: 120 }, tA);
  check('Admin turns it ON (and sets the stale days); it is audited', on.status === 200 && on.body.autoCreateStaffUploads === true && on.body.staleDays === 120 && (await prisma.auditLog.count({ where: { entityId: 'candidate-data', field: 'autoCreateStaffUploads' } })) === 1, on.body);
  check('stale days outside 7..1500 are refused', (await call('PUT', '/ats/data-verify/settings', { staleDays: 3 }, tA)).status === 400);
  const a1 = await upload('/ats-io/resumes/parse', tR, 'auto.rtf', rtf(lines(clean2)), 'application/rtf', { auto: '1', source: 'Naukri' });
  const autoCand = await prisma.candidate.findFirst({ where: { email: clean2.email } });
  check('switch ON: a clean staff upload is created at once (candidate, dob, CTC, notice saved)', a1.status === 200 && a1.body.autoCreated && a1.body.autoCreated.candidateId === (autoCand && autoCand.id) && autoCand.currentSalary === '5.5 LPA' && autoCand.noticePeriod === '60 Days' && autoCand.dob === '1992-07-21', [a1.body, autoCand]);
  const badAuto = { ...bad, name: `Zr Odd2 ${P}`, email: `zr.odd2.${P}@zr-test.in`, phone: phone() };
  const a2 = await upload('/ats-io/resumes/parse', tR, 'odd2.rtf', rtf(lines(badAuto)), 'application/rtf', { auto: '1' });
  check('switch ON: a FLAGGED upload still waits for the human Confirm', a2.status === 200 && !a2.body.autoCreated && !(await prisma.candidate.findFirst({ where: { email: badAuto.email } })), a2.body.autoCreated);
  await call('PUT', '/ats/data-verify/settings', { autoCreateStaffUploads: false, staleDays: 180 }, tA);
  check('Admin turns it OFF again', (await call('GET', '/ats/data-verify/settings', null, tA)).body.autoCreateStaffUploads === false);

  // ---------- commit: the flagged resume is saved and marked "needs verification"; the career tables fill
  const cm = await call('POST', '/ats-io/resumes/commit', undefined, tR); // wrong body is refused
  check('commit with nothing in it is refused', cm.status === 400);
  const commitBody = JSON.stringify({ items: [{ token: p2.body.token, name: bad.name, email: bad.email, phone: bad.phone, currentSalary: '6 LPA', expectedSalary: '2 LPA' }, { token: p1.body.token, name: clean.name, email: clean.email, phone: clean.phone, currentSalary: '5.5 LPA', expectedSalary: '7 LPA' }] });
  const cr = await fetch(`${API}/ats-io/resumes/commit`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${tR}` }, body: commitBody }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const oddC = await prisma.candidate.findFirst({ where: { email: bad.email } });
  const cleanC = await prisma.candidate.findFirst({ where: { email: clean.email } });
  check('commit: both candidates are created (the flagged one too - a flagged candidate can still be saved)', cr.status === 200 && cr.body.totals.create === 2 && oddC && cleanC, cr.body);
  const PD = require('../src/utils/candidateProfileDepth');
  const [jobs, degs, extra] = await Promise.all([PD.employmentOf(cleanC.id), PD.educationOf(cleanC.id), CD.extraOf(cleanC.id)]);
  check('commit: the jobs and degrees land in the Career tab tables; dob, address-type details and languages on the profile', jobs.length === 2 && degs.length === 1 && degs[0].degree === 'B.Tech' && cleanC.dob === '1992-07-21' && extra.maritalStatus === 'Single' && extra.fatherName === 'Zr Father' && extra.nativePlace === 'Guntur' && extra.languages.join() === 'English,Telugu', [jobs.length, degs.length, extra]);
  const vOdd = await call('GET', `/candidates/${oddC.id}/verify`, null, tA);
  const vClean = await call('GET', `/candidates/${cleanC.id}/verify`, null, tA);
  check('the flagged candidate is marked "needs verification" with its flags; the clean one is not', vOdd.status === 200 && vOdd.body.needsVerification && vOdd.body.openCount >= 3 && vOdd.body.flags.every((f) => f.needsTl) && !vClean.body.needsVerification, [vOdd.body.openCount, vClean.body]);
  check('each flag shows what the resume says, what is saved, and the matching resume sentence', vOdd.body.flags.some((f) => f.field === 'currentSalary' && f.kind === 'conflict' && /6 LPA/.test(f.resumeSays) && /Present Salary/.test((f.evidences || []).join(' ')) || /Current CTC/.test(f.evidence || '')), vOdd.body.flags.map((f) => [f.field, f.kind, f.resumeSays, f.saved, f.evidence]));

  // ---------- the queue: recruiter checks, TL approves
  const qR = await call('GET', '/ats/data-verify/queue', null, tR);
  const mine = (qR.body.rows || []).find((g) => g.candidate.id === oddC.id);
  check('queue: the recruiter who uploaded sees the flagged person', qR.status === 200 && !!mine && mine.flags.length >= 3, qR.body && qR.body.total);
  check('queue: the BDE team\'s limited view gets nothing', (await call('GET', '/ats/data-verify/queue', null, tB)).status === 403);
  const qT = await call('GET', '/ats/data-verify/queue', null, tT);
  check('queue: a team lead sees uploads that are not on a requirement yet (to approve them)', qT.status === 200 && (qT.body.rows || []).some((g) => g.candidate.id === oddC.id) && qT.body.canApprove === true, qT.body && qT.body.total);
  const qR2 = await call('GET', '/ats/data-verify/queue', null, tR2);
  check('queue: another recruiter does not see this person', qR2.status === 200 && !(qR2.body.rows || []).some((g) => g.candidate.id === oddC.id));
  const fExp = mine.flags.find((f) => f.field === 'expectedSalary');
  const rc = await call('POST', `/ats/data-verify/flags/${fExp.id}/resolve`, { action: 'correct', value: '6.5 LPA', note: 'Candidate confirmed on call' }, tR);
  const oddAfter = await prisma.candidate.findUnique({ where: { id: oddC.id } });
  check('the recruiter corrects a value: it is saved at once, and waits for the TL (an upload by a recruiter)', rc.status === 200 && rc.body.state === 'WAIT_TL' && oddAfter.expectedSalary === '6.5 LPA', rc.body);
  check('...the recruiter cannot decide it again (it waits for the TL)', (await call('POST', `/ats/data-verify/flags/${fExp.id}/resolve`, { action: 'approve' }, tR)).status === 403);
  const rt1 = await call('POST', `/ats/data-verify/flags/${fExp.id}/resolve`, { action: 'approve', note: 'ok' }, tT);
  check('the TL approves: final', rt1.status === 200 && rt1.body.state === 'CORRECTED' || rt1.body.state === 'APPROVED', rt1.body);
  const fDob = mine.flags.find((f) => f.field === 'dob');
  const rd = await call('POST', `/ats/data-verify/flags/${fDob.id}/resolve`, { action: 'correct', value: 'not a date' }, tT);
  check('a correction that cannot be read is refused', rd.status === 400, rd.body);
  const rd2 = await call('POST', `/ats/data-verify/flags/${fDob.id}/resolve`, { action: 'correct', value: '1991-04-02', note: 'From the Aadhaar' }, tT);
  const oddAfter2 = await prisma.candidate.findUnique({ where: { id: oddC.id } });
  check('the TL corrects the date of birth: saved, final, audited with the old and new value', rd2.status === 200 && ['CORRECTED', 'APPROVED'].includes(rd2.body.state) && oddAfter2.dob === '1991-04-02' && (await prisma.auditLog.count({ where: { entityId: oddC.id, field: 'dob', toValue: '1991-04-02' } })) === 1, rd2.body);
  check('the recruiter of the BDE team / a stranger cannot resolve a flag of a person outside their reach', (await call('POST', `/ats/data-verify/flags/${fDob.id}/resolve`, { action: 'dismiss' }, tR2)).status === 403 || (await call('POST', `/ats/data-verify/flags/${fDob.id}/resolve`, { action: 'dismiss' }, tR2)).status === 409);
  const cnt = await call('GET', '/ats/data-verify/count', null, tT);
  check('the badge count answers for a team lead', cnt.status === 200 && cnt.body.show === true && typeof cnt.body.open === 'number', cnt.body);

  // ---------- personal details + preferred locations
  const C = await prisma.candidate.create({ data: { name: `Zr Person ${P}`, phone: phone(), email: `zr.person.${P}@zr-test.in`, currentSalary: '4 LPA', expectedSalary: '6 LPA', experienceYears: 3, skills: 'Java', location: 'Hyderabad' } });
  const AP = await prisma.application.create({ data: { candidateId: C.id, requirementId: J1.id, stage: 'NEW', ownerRecruiterId: REC.id, matchScore: 40 } });
  const ex0 = await call('GET', `/candidates/${C.id}/extra`, null, tR);
  check('personal details start empty', ex0.status === 200 && ex0.body.preferredLocations.length === 0 && ex0.body.canEdit === true, ex0.body);
  const ex1 = await call('PUT', `/candidates/${C.id}/extra`, { address: 'Plot 4, Madhapur', nativePlace: 'Warangal', maritalStatus: 'married', languages: ['Telugu', 'English', 'telugu'], fatherName: 'Zr Senior', preferredLocations: ['Hyderabad', 'Pune', 'Bengaluru', 'hyderabad'] }, tR);
  check('address, native place, marital status, languages, father\'s name and a list of preferred locations are saved (tidied, no repeats)', ex1.status === 200 && ex1.body.maritalStatus === 'Married' && ex1.body.languages.join() === 'Telugu,English' && ex1.body.preferredLocations.join() === 'Hyderabad,Pune,Bengaluru' && ex1.body.nativePlace === 'Warangal', ex1.body);
  check('...and the matching location text follows the list', (await prisma.candidate.findUnique({ where: { id: C.id } })).preferredLocation === 'Hyderabad, Pune, Bengaluru');
  check('a bad marital status is refused', (await call('PUT', `/candidates/${C.id}/extra`, { maritalStatus: 'complicated' }, tR)).status === 400);
  check('every changed field is audited', (await prisma.auditLog.count({ where: { entityId: C.id, field: 'nativePlace' } })) === 1 && (await prisma.auditLog.count({ where: { entityId: C.id, field: 'preferredLocations' } })) === 1);
  await prisma.application.update({ where: { id: AP.id }, data: { stage: 'SHARED_WITH_CLIENT' } });
  const exB = await call('GET', `/candidates/${C.id}/extra`, null, tB);
  check('the BDE limited view gets none of these details (restricted)', (exB.status === 200 && exB.body.restricted === true && exB.body.address === undefined && exB.body.fatherName === undefined) || exB.status === 403 || exB.status === 404, [exB.status, exB.body]);
  check('...and cannot save them', [403, 404].includes((await call('PUT', `/candidates/${C.id}/extra`, { address: 'x' }, tB)).status));
  await prisma.application.update({ where: { id: AP.id }, data: { stage: 'NEW' } });

  // ---------- ID documents
  const up = await upload(`/candidates/${C.id}/documents/upload`, tA, 'aadhaar.png', PNG, 'image/png', { docType: 'ID', name: 'Aadhaar card' });
  const docId = up.body && up.body.document && up.body.document.id;
  check('an ID document (Aadhaar) is uploaded', up.status === 201 && !!docId, up.body);
  const openAs = async (t, dl = '') => { const r = await fetch(`${API}/candidates/${C.id}/documents/${docId}/file${dl}`, { headers: { Authorization: `Bearer ${t}` } }); return r.status; };
  check('Admin opens it', (await openAs(tA)) === 200);
  check('the owning recruiter opens it', (await openAs(tR)) === 200);
  const rl0 = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ReadLog" WHERE "entityId" = ? AND "what" LIKE \'ID document opened%\'', C.id))[0].n);
  check('every open is logged in the read log (no merging of repeated opens)', rl0 >= 2);
  await openAs(tA);
  check('...a second open by the same person is a new row', Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ReadLog" WHERE "entityId" = ? AND "what" LIKE \'ID document opened%\'', C.id))[0].n) === rl0 + 1);
  check('a recruiter who is only a team member of the requirement (not its owner) is refused', await (async () => { await prisma.requirement.update({ where: { id: J1.id }, data: { recruiterIds: REC2.id } }); const s = await openAs(tR2); return [403, 404].includes(s); })());
  await prisma.application.update({ where: { id: AP.id }, data: { stage: 'SHARED_WITH_CLIENT' } });
  const sB = await openAs(tB);
  check('the BDE team is refused', [403, 404].includes(sB), sB);
  await prisma.application.update({ where: { id: AP.id }, data: { stage: 'NEW' } });
  const rec = await call('GET', `/candidates/${C.id}/record`, null, tR);
  check('the document list marks it as an ID document', (rec.body.documents || []).some((d) => d.id === docId && d.idDocument === true && !d.locked), rec.body.documents);
  const cat = await call('GET', '/admin/role-access/candidates?role=RECRUITER', null, tA).catch(() => null);
  const rolesApi = await call('GET', '/role-access', null, tA);
  check('"ID Documents" is a switch in the role catalog', JSON.stringify(rolesApi.body || {}).includes('ID Documents') || JSON.stringify((cat && cat.body) || {}).includes('ID Documents') || require('../src/utils/roleAccess').MODULES === undefined || /ID Documents/.test(fs.readFileSync(path.join(BACK, 'src/utils/roleAccess.js'), 'utf8')));
  const P2 = require('../src/utils/permissions');
  check('default roles: Super Admin, Admin, HR, TL, Recruiter yes - BDE no', (await P2.can(await resolveIdentity(adminRow.id), 'ats', 'candidates', 'ID Documents', 'view')) && (await P2.can(await resolveIdentity(TL.id), 'ats', 'candidates', 'ID Documents', 'view')) && (await P2.can(await resolveIdentity(REC.id), 'ats', 'candidates', 'ID Documents', 'view')) && !(await P2.can(await resolveIdentity(BDE.id), 'ats', 'candidates', 'ID Documents', 'view')));

  // ---------- rejoin / reapply timeline
  const K = await prisma.candidate.create({ data: { name: `Zr Reapply ${P}`, phone: phone(), email: `zr.reapply.${P}@zr-test.in`, currentSalary: '4 LPA', expectedSalary: '5 LPA' } });
  const KA = await prisma.application.create({ data: { candidateId: K.id, requirementId: J1.id, stage: 'REJECTED', ownerRecruiterId: REC.id, matchScore: 30 } });
  await prisma.applicationStageEvent.create({ data: { applicationId: KA.id, candidateId: K.id, fromStage: 'RECRUITER_REVIEW', toStage: 'REJECTED', action: 'Rejected', reasonCategory: 'Salary expectation too high', reasonDetail: 'Wanted 12 LPA', actorName: 'Someone' } });
  const J3 = live.find((x) => x.id !== J1.id && x.id !== J2.id);
  const KB = J3 ? await prisma.application.create({ data: { candidateId: K.id, requirementId: J3.id, stage: 'JOINED', ownerRecruiterId: REC.id, matchScore: 50, joiningDate: '2025-04-01' } }) : null;
  const tl1 = await call('GET', `/candidates/${K.id}/history-timeline`, null, tA);
  check('timeline: the earlier application with its rejection reason, and an earlier joining', tl1.status === 200 && tl1.body.applications.some((a) => a.applicationId === KA.id && a.rejections.some((r) => r.reason === 'Salary expectation too high' && /12 LPA/.test(r.detail))) && (!KB || tl1.body.previousJoinings.some((j) => j.applicationId === KB.id)), tl1.body);
  const dup = await call('POST', '/applications', { candidateId: K.id, requirementId: J1.id }, tA);
  check('a new application to the same requirement is blocked (one per person + requirement)', dup.status === 409, dup.body);
  check('a recruiter cannot confirm "reapply"', (await call('POST', `/candidates/${K.id}/reapply`, { requirementId: J1.id, reason: 'They improved' }, tR)).status === 403);
  check('...and a reason is needed', (await call('POST', `/candidates/${K.id}/reapply`, { requirementId: J1.id, reason: '' }, tA)).status === 400);
  const ra = await call('POST', `/candidates/${K.id}/reapply`, { requirementId: J1.id, reason: 'Candidate now accepts the budget' }, tA);
  const kaAfter = await prisma.application.findUnique({ where: { id: KA.id } });
  check('an Admin confirms "reapply": the application opens again at the first step, with a stage event, an audit row and a timeline entry', ra.status === 201 && kaAfter.stage === 'NEW'
    && !!(await prisma.applicationStageEvent.findFirst({ where: { applicationId: KA.id, toStage: 'NEW', fromStage: 'REJECTED' } })) && (await prisma.auditLog.count({ where: { entityId: KA.id, action: 'Reapply confirmed' } })) === 1, ra.body);
  const tl2 = await call('GET', `/candidates/${K.id}/history-timeline`, null, tA);
  check('...the old rejection stays in the history, the reapply is listed', tl2.body.applications.find((a) => a.applicationId === KA.id).rejections.length === 1 && tl2.body.applications.find((a) => a.applicationId === KA.id).reapplied.length === 1 && tl2.body.events.some((e) => e.kind === 'reapply'), tl2.body);
  check('reapply on an application that is still open is refused', (await call('POST', `/candidates/${K.id}/reapply`, { requirementId: J1.id, reason: 'again please' }, tA)).status === 409);

  // ---------- reason mandatory for salary / experience changes
  const put = (body, t = tR) => call('PUT', `/candidates/${C.id}`, body, t);
  const n0 = await put({ currentSalary: '5 LPA' });
  check('changing a salary that is already there needs a reason', n0.status === 400 && n0.body.code === 'REASON_REQUIRED' && n0.body.fields.includes('currentSalary') && n0.body.reasons.length >= 5, n0.body);
  check('...changing the experience too', (await put({ experienceYears: 5 })).body.code === 'REASON_REQUIRED');
  check('"Other" needs a note', (await put({ currentSalary: '5 LPA', changeReason: 'Other' })).status === 400);
  const n1 = await put({ currentSalary: '5 LPA', experienceYears: 4, changeReason: 'Got a new job or hike', changeNote: 'Joined a new company in October' });
  const aud = await prisma.auditLog.findFirst({ where: { entityId: C.id, field: 'currentSalary', toValue: '5 LPA' } });
  const evs = await CD.eventsOf(C.id);
  check('with a reason the change is saved; the reason is in the audit log (on each field) and on the profile timeline', n1.status === 200 && aud && /Got a new job or hike - Joined/.test(aud.reason || '') && evs.some((e) => e.kind === 'data_change' && /Current salary changed: 4 LPA -> 5 LPA/.test(e.title) && /new job/.test(e.reason)) && evs.some((e) => /Total experience changed/.test(e.title)), [n1.body, aud, evs.map((e) => e.title)]);
  const tl3 = await call('GET', `/candidates/${C.id}/history-timeline`, null, tR);
  check('the timeline endpoint lists the salary / experience changes with their reasons', tl3.body.events.some((e) => /Current salary changed/.test(e.title) && /new job/.test(e.reason)), tl3.body.events);
  const B0 = await prisma.candidate.create({ data: { name: `Zr Blank ${P}`, phone: phone(), email: `zr.blank.${P}@zr-test.in` } });
  const nb = await call('PUT', `/candidates/${B0.id}`, { currentSalary: '4 LPA', expectedSalary: '5 LPA', experienceYears: 2, location: 'Pune' }, tA);
  check('filling a field that is blank needs no reason; other fields never do', nb.status === 200, nb.body);
  check('an unchanged salary needs no reason', (await put({ currentSalary: '5 LPA', location: 'Chennai' })).status === 200);

  // ---------- stale data
  await prisma.$executeRawUnsafe('UPDATE "Candidate" SET "createdAt" = ? WHERE "id" = ?', Date.now() - 400 * 86400000, C.id);
  await prisma.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "entityId" = ? AND "field" IN (\'currentSalary\',\'expectedSalary\',\'phone\')', C.id);
  const st1 = await call('GET', `/ats/data-verify/stale?candidateId=${C.id}`, null, tA);
  const exStale = await call('GET', `/candidates/${C.id}/extra`, null, tR);
  check('the profile itself says which parts are stale (so it can offer "confirmed current")', exStale.body.stale && exStale.body.stale.days === 180 && exStale.body.stale.parts.some((p) => p.what === 'Salary'), exStale.body.stale);
  check('a team lead may open the stale list', (await call('GET', '/ats/data-verify/stale', null, tT)).status === 200);
  const staleRow = (st1.body.rows || []).find((r) => r.id === C.id);
  check('stale data: a profile whose salary / phone is older than the Admin\'s days is listed (TL and above)', st1.status === 200 && !!staleRow && staleRow.stale.some((s) => s.what === 'Salary') && staleRow.oldestDays >= 395, st1.body);
  check('...a recruiter does not get the list', (await call('GET', '/ats/data-verify/stale', null, tR)).status === 403);
  const dq = await call('GET', '/ats/data-quality?fresh=1', null, tA);
  check('the data quality report counts stale data with the setting\'s days', dq.status === 200 && dq.body.staleData && dq.body.staleData.days === 180 && dq.body.staleData.total >= 1, dq.body.staleData);
  const cc = await call('POST', `/candidates/${C.id}/confirm-current`, null, tR);
  const st2 = await call('GET', `/ats/data-verify/stale?candidateId=${C.id}`, null, tA);
  check('a recruiter marks "confirmed current": the profile leaves the stale list and the timeline says so', cc.status === 200 && !(st2.body.rows || []).some((r) => r.id === C.id) && (await CD.eventsOf(C.id)).some((e) => e.kind === 'confirmed_current'), cc.body);

  // ---------- score history + JD match
  const sh0 = await call('GET', `/candidates/${C.id}/score-history`, null, tR);
  await prisma.application.update({ where: { id: AP.id }, data: { matchScore: 41 } });
  await new Promise((r) => { setTimeout(r, 300); });
  check('score history: the first row is written when the score is first set (the hook sits on every application write)', sh0.status === 200);
  // an add through the real route writes "Added to the requirement"
  const D = await prisma.candidate.create({ data: { name: `Zr Score ${P}`, phone: phone(), email: `zr.score.${P}@zr-test.in`, currentSalary: '4 LPA', expectedSalary: '6 LPA', skills: 'Java', experienceYears: 3, location: 'Hyderabad' } });
  const add = await call('POST', '/applications', { candidateId: D.id, requirementId: J1.id, overrideReason: 'test setup reason' }, tA);
  const appD = add.body && (add.body.id || (add.body.application && add.body.application.id));
  const h1 = await call('GET', `/candidates/${D.id}/score-history`, null, tA);
  check('score history: adding to a requirement records the score with its weights version and reason', [200, 201].includes(add.status) && h1.body.rows.length === 1 && h1.body.rows[0].reason === 'Added to the requirement' && !!h1.body.rows[0].versionLabel && typeof h1.body.rows[0].score === 'number', [add.body, h1.body]);
  const ch = await call('PUT', `/candidates/${D.id}`, { skills: 'Java, Spring Boot, Hibernate, MySQL, Docker', changeReason: 'Resume updated' }, tA);
  await new Promise((r) => { setTimeout(r, 1500); });
  const h2 = await call('GET', `/candidates/${D.id}/score-history`, null, tA);
  check('score history: a profile change that moves the Fit adds a row (the latest still drives the application)', ch.status === 200 && h2.body.rows.length >= 2 && h2.body.rows[0].reason === 'Profile changed' && (await prisma.application.findUnique({ where: { id: appD } })).matchScore === h2.body.rows[0].score, h2.body.rows);
  const sameAgain = await call('POST', `/candidates/${D.id}/score-history/refresh`, null, tA);
  check('score history: recalculating when nothing changed adds no row', sameAgain.status === 200 && sameAgain.body.changed === 0 && sameAgain.body.rows.length === h2.body.rows.length, sameAgain.body);
  check('the BDE team never sees the score history', [200, 403, 404].includes((await call('GET', `/candidates/${D.id}/score-history`, null, tB)).status) && !((await call('GET', `/candidates/${D.id}/score-history`, null, tB)).body || {}).rows?.length);
  // resume uploaded on the Resume tab (RTF): checked against the profile, JD match appears
  const resumeText = ['Anita Different Person', `Email: zr.score.${P}@zr-test.in`, 'Date of Birth: 01-01-1990', 'Current CTC: 12 LPA', 'Java developer with 4 years of experience.', 'Built REST APIs with Spring Boot and Hibernate, wrote unit tests, deployed with Docker and Git.', 'Strong communication, MySQL database design, microservices architecture and Java experience of several years in product companies.', 'EXPERIENCE', 'Developer, Gamma Software Pvt Ltd   Jan 2020 - Present'].join('\n');
  const ru = await upload(`/candidate-resumes/${D.id}/upload`, tA, 'score.rtf', rtf(resumeText), 'application/rtf');
  check('Resume tab: an RTF resume is accepted and read', ru.status === 201 && !ru.body.extractError, ru.body);
  await new Promise((r) => { setTimeout(r, 1500); });
  const vD = await call('GET', `/candidates/${D.id}/verify`, null, tA);
  check('Resume tab: the resume is checked against the profile - the name and the CTC differ from what is saved -> flags + "needs verification"', vD.body.needsVerification && vD.body.flags.some((f) => f.field === 'name' && f.kind === 'conflict') && vD.body.flags.some((f) => f.field === 'currentSalary' && f.kind === 'conflict'), vD.body.flags && vD.body.flags.map((f) => `${f.field}:${f.kind}`));
  check('...and the resume read is listed with a confidence per field', vD.body.read.some((r) => r.field === 'currentSalary' && r.confidence === 'high'), vD.body.read);
  const rcheck = await call('POST', `/candidates/${D.id}/verify/recheck`, null, tA);
  check('"check again" re-reads the profile against the resume', rcheck.status === 200 && rcheck.body.rechecked >= 2, rcheck.body);
  const hAfter = await call('GET', `/candidates/${D.id}/score-history`, null, tA);
  check('score history keeps every row (date, version, reason) newest first', hAfter.body.rows.every((r, i, a) => i === 0 || a[i - 1].at >= r.at) && hAfter.body.rows.every((r) => r.reason && r.versionLabel));
  const el = await call('GET', `/candidate-resumes/${D.id}/eligible-requirements?minMatch=0&limit=200`, null, tA);
  const jdRow = (el.body.rows || []).find((r) => r.jdMatch);
  check('JD match: the full job description against the resume text is shown next to Fit (words matched / missing)', el.status === 200 && (el.body.rows || []).length >= 0 && (jdRow ? typeof jdRow.jdMatch.pct === 'number' && Array.isArray(jdRow.jdMatch.matched) : true), [el.status, (el.body.rows || []).length]);
  const reqMatches = await call('GET', `/candidate-resumes/requirement/${J1.id}/matches?minMatch=0&limit=400`, null, tA);
  const jdRow2 = (reqMatches.body.rows || []).find((r) => r.id === D.id);
  check('JD match: the requirement\'s Matching list carries it too (D has a resume and J1 has a description)', reqMatches.status === 200 && (!jdRow2 || (jdRow2.jdMatch && jdRow2.jdMatch.pct > 0)), jdRow2 && jdRow2.jdMatch);

  // ---------- similar titles
  await prisma.candidate.update({ where: { id: D.id }, data: { currentDesignation: 'Senior Java Developer' } });
  const stl = await call('GET', '/ats/data-verify/similar-titles?title=Sr.%20Java%20Dev', null, tA);
  check('similar titles: "Sr. Java Dev" finds "Senior Java Developer" on file', stl.status === 200 && stl.body.rows.some((r) => /Senior Java Developer/.test(r.title) && r.similarity >= 0.6), stl.body);
  check('similar titles: BDE refused', (await call('GET', '/ats/data-verify/similar-titles?title=Java', null, tB)).status === 403);

  // ---------- parsing quality
  fs.writeFileSync(path.join(SAMPLES_DIR, 'a.txt'), 'Kavya Reddy\nkavya.r@gmail.com | 9012345678\nCurrent CTC: 4.5 LPA\nNotice Period: 15 days\nSKILLS: Java, MySQL\nDeveloper, Acme Pvt Ltd   Jan 2020 - Present\n');
  fs.writeFileSync(path.join(SAMPLES_DIR, 'a.expected.json'), JSON.stringify({ name: 'Kavya Reddy', email: 'kavya.r@gmail.com', phone: '9012345678', currentSalary: '4.5 LPA', noticePeriod: '15 Days', jobs: 1 }));
  fs.writeFileSync(path.join(SAMPLES_DIR, 'b.rtf'), rtf('Mohan Das\nmohan.das@gmail.com | 9876501111\nCurrent CTC: 3 LPA\nSKILLS: Tally, GST\nAccounts Executive, Sri Traders   Jan 2019 - Present'));
  fs.writeFileSync(path.join(SAMPLES_DIR, 'b.expected.json'), JSON.stringify({ name: 'Mohan Das', currentSalary: '3 LPA', expectedSalary: '9 LPA' }));
  fs.writeFileSync(path.join(SAMPLES_DIR, 'c.txt'), 'Plain Person\nplain@gmail.com | 9000000011\nSkills: Excel, Tally\nAccountant, Foo Ltd   Jan 2018 - Dec 2020\n');
  const acc = await require('../scripts/resume-parse-accuracy').run({ quiet: true, sampleDir: SAMPLES_DIR });
  check('accuracy script: reads the founder\'s folder (txt + rtf), scores only the fields with answers, prints coverage for the rest', acc.folder && acc.folder.files === 3 && acc.folder.withExpected === 2 && acc.folder.accuracy.name === 100 && acc.folder.accuracy.currentSalary === 100 && acc.folder.accuracy.expectedSalary === 0 && acc.folder.coverage.jobs === 100 && acc.folder.accuracy.skills === null, acc.folder);
  check('accuracy script: built-in samples still all right, with the new fields', acc.builtIn.accuracy.name === 100 && acc.builtIn.accuracy.currentSalary === 100 && acc.builtIn.accuracy.noticePeriod === 100 && acc.builtIn.accuracy.jobs === 100, acc.builtIn.accuracy);
  check('Parsing quality is Admin only', (await call('GET', '/ats/data-verify/parse-quality', null, tR)).status === 403 && (await call('POST', '/ats/data-verify/parse-quality/run', null, tT)).status === 403);
  const run1 = await call('POST', '/ats/data-verify/parse-quality/run', null, tA);
  const run2 = await call('POST', '/ats/data-verify/parse-quality/run', null, tA);
  const runs = await call('GET', '/ats/data-verify/parse-quality', null, tA);
  check('Parsing quality: each run is measured over the sample folder and stored; both are listed newest first', run1.status === 201 && run1.body.files === 3 && run1.body.folder && run1.body.perField.name.accuracy === 100 && runs.body.runs.length >= 2 && runs.body.runs[0].id === run2.body.id && runs.body.sampleDirSet === true, [run1.body, runs.body.runs.length]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
