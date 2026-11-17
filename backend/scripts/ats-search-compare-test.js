#!/usr/bin/env node
/**
 * ATS founder-audit items (2026-11-17, Mandatory): boolean candidate search, compare candidates for one job, shared saved filters,
 * interview clashes by team availability, work reassigned during leave (and given back), requirement ageing in the client portal.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4082.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-search-compare-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-searchcmp-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4082;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'searchcmp-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const MARK = `zqx${String(P).replace(/\d/g, (d) => 'abcdefghij'[d])}`; // a word only our test people carry (letters only: digits would also hit phone numbers)
const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const TEAM = `Sx Team ${P}`;
  const mk = (tag, extra) => prisma.user.create({ data: { name: `Sx ${tag} ${P}`, email: `sx.${tag}.${P}@sx-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const R1 = await mk('rec1', { role: 'RECRUITER', atsRole: 'RECRUITER', atsDepartment: 'IT', team: TEAM });
  const R2 = await mk('rec2', { role: 'RECRUITER', atsRole: 'RECRUITER', atsDepartment: 'Zz Other', team: `Sx Other ${P}` });
  const T1 = await mk('tl1', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', team: TEAM });
  const B1 = await mk('backup1', { role: 'RECRUITER', atsRole: 'RECRUITER', atsDepartment: 'IT', team: TEAM });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false }, select: { id: true, clientId: true, title: true }, take: 50 });
  const j1 = live[0];
  const j2 = live.find((x) => x.id !== j1.id);
  await prisma.requirement.update({ where: { id: j1.id }, data: { recruiterId: R1.id, tlId: T1.id, skills: 'Java, Spring Boot' } });
  const person = (tag, data) => prisma.candidate.create({ data: { name: `Sx ${tag} ${MARK}`, phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '3')}`, email: `sx.${tag}.${P}@sx-test.in`, ...data } });
  const C1 = await person('Javaone', { skills: 'Java, Spring Boot', currentCompany: 'Acme Corp', currentDesignation: 'Developer', experienceYears: 4, currentSalary: '6 LPA', expectedSalary: '8 LPA', noticePeriod: '30 Days', location: 'Kakinada' });
  const C2 = await person('Kotlintwo', { skills: 'Kotlin, Spring Boot', currentDesignation: 'Intern', experienceYears: 0.5, location: 'Pune' });
  const C3 = await person('Pythonthree', { skills: 'Python', currentDesignation: 'Analyst', experienceYears: 2, location: 'Ongole' });
  const C4 = await person('Javafour', { skills: 'Java', currentDesignation: 'Developer', experienceYears: 6, location: 'Bengaluru' });
  await prisma.candidateResume.create({ data: { candidateId: C3.id, kind: 'ORIGINAL', text: 'Worked on Kubernetes clusters and Python ETL.', fileName: 'r.pdf' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR1 = await tok(R1.id); const tR2 = await tok(R2.id); const tT1 = await tok(T1.id); const tB1 = await tok(B1.id);

  const apps = {};
  for (const [k, c] of [['a1', C1], ['a2', C2], ['a3', C3], ['a4', C4]]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call('POST', '/applications', { candidateId: c.id, requirementId: j1.id, overrideReason: 'test setup reason' }, tA);
    apps[k] = r.body && (r.body.id || (r.body.application && r.body.application.id));
  }
  check('setup: the four people are on job 1', Object.values(apps).every(Boolean), apps);

  // ======================= 1. BOOLEAN SEARCH =======================
  const names = (body) => (body && body.rows ? body.rows.map((r) => r.name).filter((n) => n.includes(MARK)).map((n) => n.split(' ')[1]).sort() : null);
  const people = async (search, token = tA) => call('GET', `/candidates?paged=1&view=master&sub=all&pageSize=100&search=${encodeURIComponent(search)}`, null, token);
  const pipe = async (search, token = tA) => call('GET', `/candidates?paged=1&view=pipeline&sub=all&pageSize=100&search=${encodeURIComponent(search)}`, null, token);

  let r = await people(`${MARK} AND (java OR kotlin) AND "spring boot" NOT intern`);
  check('boolean: (java OR kotlin) AND "spring boot" NOT intern finds only the Java + Spring Boot developer (the Kotlin intern is left out)', r.status === 200 && JSON.stringify(names(r.body)) === JSON.stringify(['Javaone']) && r.body.searchMode === 'boolean', { s: r.status, n: names(r.body), m: r.body && r.body.searchMode });
  r = await pipe(`${MARK} AND (java OR kotlin) AND "spring boot" NOT intern`);
  check('...the same on the pipeline view (one row per application)', r.status === 200 && JSON.stringify(names(r.body)) === JSON.stringify(['Javaone']), names(r.body));
  r = await people(`${MARK} (java OR kotlin)`);
  check('two words side by side mean AND; OR inside brackets', JSON.stringify(names(r.body)) === JSON.stringify(['Javafour', 'Javaone', 'Kotlintwo']), names(r.body));
  r = await people(`${MARK} -intern`);
  check('-word means NOT', JSON.stringify(names(r.body)) === JSON.stringify(['Javafour', 'Javaone', 'Pythonthree']), names(r.body));
  r = await people(`${MARK} "acme corp"`);
  check('a quoted phrase matches the current company', JSON.stringify(names(r.body)) === JSON.stringify(['Javaone']), names(r.body));
  r = await people(`${MARK} AND (kakinada OR ongole)`);
  check('location is searched', JSON.stringify(names(r.body)) === JSON.stringify(['Javaone', 'Pythonthree']), names(r.body));
  r = await people(`${MARK} AND kubernetes`);
  check('stored resume text is searched (Kubernetes is only in the resume)', JSON.stringify(names(r.body)) === JSON.stringify(['Pythonthree']), names(r.body));
  r = await people(`(${MARK} AND (java OR kotlin`);
  check('edge: brackets never closed are closed at the end', r.status === 200 && JSON.stringify(names(r.body)) === JSON.stringify(['Javafour', 'Javaone', 'Kotlintwo']), { s: r.status, n: names(r.body) });
  r = await people(`${MARK} OR`);
  check('edge: a trailing OR is ignored', r.status === 200 && names(r.body).length === 4, names(r.body));
  r = await people(`${MARK}) OR NOT`);
  check('edge: a stray ")" and a NOT with nothing after it do not break the search', r.status === 200 && names(r.body).length === 4, { s: r.status, n: names(r.body) });
  r = await people('AND OR NOT');
  check('edge: only operators -> a plain message, no error page', r.status === 200 && typeof r.body.searchError === 'string', { s: r.status, e: r.body && r.body.searchError });
  r = await people(`${MARK} and java`);
  check('plain words keep today\'s behaviour (lower-case "and" is a word, not an operator)', r.status === 200 && r.body.searchMode === 'plain' && names(r.body).length === 0, { m: r.body && r.body.searchMode, n: names(r.body) });
  r = await people(MARK);
  check('a plain search still finds by name', r.status === 200 && r.body.searchMode === 'plain' && names(r.body).length === 4, names(r.body));
  r = await people(`${MARK} java`);
  check('plain two words stay one text (as before: no person has the text "<mark> java")', names(r.body).length === 0, names(r.body));
  const before = await prisma.candidate.count();
  r = await people(`${MARK}' OR 1=1 --`);
  const r2 = await people(`"); DROP TABLE "Candidate"; -- ${MARK}`);
  const r3 = await people(`${MARK} AND "' OR '1'='1"`);
  const r4 = await people(`${MARK} AND kube%`);
  const after = await prisma.candidate.count();
  check('injection: quotes / OR 1=1 / DROP TABLE / % are only search text - 200, nothing extra found, the table is untouched',
    [r, r2, r3, r4].every((x) => x.status === 200) && names(r.body).length === 0 && names(r2.body).length === 0 && names(r3.body).length === 0 && names(r4.body).length === 0 && before === after && after > 0,
    { s: [r.status, r2.status, r3.status, r4.status], n: [names(r.body), names(r2.body), names(r3.body), names(r4.body)], before, after });
  r = await people(`${MARK} OR java OR kubernetes`, tR2);
  const ourIds = new Set([C1.id, C2.id, C3.id, C4.id]);
  check('scope: a recruiter outside the job sees none of these people with a boolean search (resume words included)', r.status === 200 && !(r.body.rows || []).some((x) => ourIds.has(x.id)), { s: r.status, n: (r.body.rows || []).length });
  r = await people(`${MARK} AND (java OR kotlin)`, tR1);
  check('scope: the job\'s own recruiter does find them', r.status === 200 && names(r.body).length === 3, names(r.body));
  const bigQ = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' OR ');
  r = await people(bigQ);
  check('edge: more than 30 terms is refused politely (no crash)', r.status === 200 && /at most/i.test(r.body.searchError || ''), { s: r.status, e: r.body && r.body.searchError });
  r = await call('GET', `/ats-io/facets/candidates?view=pipeline&sub=all&search=${encodeURIComponent(`${MARK} AND (java OR kotlin)`)}`, null, tA);
  check('the filter counts use the same boolean search (3 rows counted)', r.status === 200 && r.body.total === 3, { s: r.status, t: r.body && r.body.total });

  // ======================= 2. COMPARE =======================
  await prisma.interviewFeedback.create({ data: { applicationId: apps.a1, kind: 'Internal', technical: 4, communication: 3, experience: 4, roleFit: 5, overall: 'Good', recommendation: 'Selected', submittedBy: 'Test' } });
  r = await call('GET', `/ats/team-tools/compare?ids=${apps.a1},${apps.a3}`, null, tA);
  const row1 = r.body && r.body.rows && r.body.rows[0];
  const row3 = r.body && r.body.rows && r.body.rows[1];
  check('compare: two people side by side, in the order picked', r.status === 200 && r.body.rows.length === 2 && row1.candidateId === C1.id && row3.candidateId === C3.id, r.body);
  check('compare: experience, CTC, notice, location', row1 && row1.experienceYears === 4 && row1.currentSalary === '6 LPA' && row1.expectedSalary === '8 LPA' && row1.noticePeriod === '30 Days' && row1.location === 'Kakinada', row1);
  check('compare: skills against the requirement (2 of 2 vs 0 of 2, with the missing ones named)', row1 && row1.skillsMatch.pct === 100 && row3.skillsMatch.pct === 0 && row3.skillsMatch.missing.includes('spring boot'), [row1 && row1.skillsMatch, row3 && row3.skillsMatch]);
  check('compare: stage and the last feedback rating (4 / 5, Selected)', row1 && row1.stageLabel && row1.lastFeedback && row1.lastFeedback.rating === 4 && row1.lastFeedback.recommendation === 'Selected' && row3.lastFeedback === null, row1 && row1.lastFeedback);
  check('compare: fit score is there', row1 && 'matchScore' in row1, row1);
  check('compare: 1 person is refused', (await call('GET', `/ats/team-tools/compare?ids=${apps.a1}`, null, tA)).status === 400);
  check('compare: 5 people are refused', (await call('GET', `/ats/team-tools/compare?ids=${apps.a1},${apps.a2},${apps.a3},${apps.a4},x${P}`, null, tA)).status === 400);
  const other = await call('POST', '/applications', { candidateId: C1.id, requirementId: j2.id, overrideReason: 'test setup reason' }, tA);
  const aOther = other.body && (other.body.id || (other.body.application && other.body.application.id));
  check('compare: two different jobs are refused', (await call('GET', `/ats/team-tools/compare?ids=${apps.a1},${aOther}`, null, tA)).status === 400);
  check('compare: a recruiter outside the job cannot compare these people', (await call('GET', `/ats/team-tools/compare?ids=${apps.a1},${apps.a2}`, null, tR2)).status === 403);
  check('compare: the job\'s recruiter can', (await call('GET', `/ats/team-tools/compare?ids=${apps.a1},${apps.a2},${apps.a4}`, null, tR1)).status === 200);

  // ======================= 3. SHARED SAVED FILTERS =======================
  r = await call('POST', '/ats/team-tools/shared-views', { page: 'cand', name: `Java people ${P}`, filters: { search: 'java', view: 'master' }, share: 'team' }, tR1);
  check('share a saved filter with my team', r.status === 201 && r.body.view && r.body.view.share === 'team', r.body);
  const sid = r.body && r.body.view && r.body.view.id;
  const seen = async (t) => ((await call('GET', '/ats/team-tools/shared-views?page=cand', null, t)).body.shared || []).some((v) => v.id === sid);
  check('the TL of the same team sees it under "Shared with me"', await seen(tT1));
  check('a recruiter of another team does not', !(await seen(tR2)));
  check('the owner sees it under their own shared ones', ((await call('GET', '/ats/team-tools/shared-views?page=cand', null, tR1)).body.mine || []).some((v) => v.id === sid));
  r = await call('POST', '/ats/team-tools/shared-views', { page: 'cand', name: `Java people ${P}`, filters: { search: 'java OR kotlin' }, share: 'everyone' }, tR1);
  check('share it with everyone (same name updates it): now the other team sees it, with the new filters', r.status === 201 && await seen(tR2)
    && ((await call('GET', '/ats/team-tools/shared-views?page=cand', null, tR2)).body.shared.find((v) => v.id === sid) || {}).filters.search === 'java OR kotlin');
  check('someone else cannot stop the share', (await call('DELETE', `/ats/team-tools/shared-views/${sid}`, null, tR2)).status === 403);
  check('bad page name / no filters / no share choice are refused', (await call('POST', '/ats/team-tools/shared-views', { page: "c'; DROP", name: 'x', filters: { a: 1 }, share: 'team' }, tR1)).status === 400
    && (await call('POST', '/ats/team-tools/shared-views', { page: 'cand', name: 'x', share: 'team' }, tR1)).status === 400
    && (await call('POST', '/ats/team-tools/shared-views', { page: 'cand', name: 'x', filters: { a: 1 } }, tR1)).status === 400);
  r = await call('POST', '/ats/team-tools/shared-views', { page: 'cand', name: `it's "quoted" ${P}`, filters: { search: "o'brien" }, share: 'team' }, tR1);
  check('a name with quotes is stored as text', r.status === 201 && r.body.view.name.includes('"quoted"'), r.body);
  check('the owner stops sharing', (await call('DELETE', `/ats/team-tools/shared-views/${sid}`, null, tR1)).status === 200 && !(await seen(tT1)));
  const clientUser = await prisma.user.findFirst({ where: { status: 'Active', role: 'CLIENT', clientId: { not: null } } });
  const tC = clientUser ? await tok(clientUser.id) : null;
  if (tC) check('a client login gets nothing from the team tools', (await call('GET', '/ats/team-tools/shared-views?page=cand', null, tC)).status === 403);

  // ======================= 4. INTERVIEW CLASHES =======================
  const day = istDay(2);
  await prisma.application.update({ where: { id: apps.a1 }, data: { interviewAt: new Date(`${day}T11:00:00+05:30`), interviewStatus: 'SCHEDULED', interviewer: `Zz Panel ${P}`, interviewRound: 1, stage: 'INTERVIEW_SCHEDULED' } });
  r = await call('POST', '/ats/team-tools/slot-check', { applicationId: apps.a2, date: day, time: '11:30', panel: [{ name: `Zz Panel ${P}` }] }, tA);
  check('clash: the interviewer already has an interview at 11:00 when 11:30 is picked', r.status === 200 && r.body.clashes.some((c) => c.kind === 'interviewer' && c.time === '11:00') && /Clash/.test(r.body.warning || ''), r.body);
  check('the interviewer\'s booked slots that day are listed', r.body && r.body.booked.length === 1 && r.body.booked[0].time === '11:00' && r.body.booked[0].candidate && r.body.booked[0].candidate.includes(MARK), r.body && r.body.booked);
  check('free times skip the busy hour and offer the afternoon', r.body && !r.body.freeTimes.includes('11:00') && !r.body.freeTimes.includes('11:30') && r.body.freeTimes.includes('14:00'), r.body && r.body.freeTimes);
  r = await call('POST', '/ats/team-tools/slot-check', { applicationId: apps.a2, date: day, time: '15:00', panel: [{ name: `Zz Panel ${P}` }] }, tA);
  check('no clash at 15:00', r.status === 200 && r.body.clashes.length === 0 && !r.body.warning, r.body);
  r = await call('POST', '/ats/team-tools/slot-check', { applicationId: aOther, date: day, time: '11:15', panel: [{ name: `Someone Else ${P}` }] }, tA);
  check('clash: the same CANDIDATE already has an interview at 11:00 (on another job)', r.status === 200 && r.body.clashes.some((c) => c.kind === 'candidate'), r.body);
  await prisma.application.update({ where: { id: apps.a2 }, data: { stage: 'CLIENT_SHORTLISTED' } });
  r = await call('POST', `/ats/interviews/${apps.a2}/book`, { date: day, time: '11:30', mode: 'In Person', location: 'Office', panel: [{ name: `Zz Panel ${P}` }], round: 1 }, tA);
  check('booking at a clashing time still books, and the reply warns about the clash', r.status === 200 && r.body.ok && (r.body.clashes || []).length > 0 && /Clash/.test(r.body.message || ''), { s: r.status, b: r.body && { e: r.body.error, c: r.body.clashes, m: r.body.message } });
  r = await call('POST', '/ats/team-tools/slot-check', { applicationId: apps.a3, date: day, time: '11:00', panel: [{ name: `Zz Panel ${P}` }] }, tR2);
  check('slot check on a person outside the login\'s list is refused', r.status === 404, r.status);

  // A BDE (who is never sent where a person works or lives, nor the resume) cannot find people by those words either.
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  await prisma.requirement.update({ where: { id: j1.id }, data: { bdeId: BDE.id } });
  const tBDE = await tok(BDE.id);
  const bj = await pipe(`${MARK} AND java`, tBDE);
  const bc = await pipe(`${MARK} AND ("acme corp" OR kakinada)`, tBDE);
  check('BDE: a skill finds the person (control), the employer / city words do not', bj.status === 200 && names(bj.body).includes('Javaone') && bc.status === 200 && names(bc.body).length === 0, { j: names(bj.body), c: names(bc.body) });

  // ======================= 5. LEAVE COVER =======================
  const eT = await prisma.employee.create({ data: { employeeCode: `SXT${P}`, name: T1.name, userId: T1.id } });
  const eR = await prisma.employee.create({ data: { employeeCode: `SXR${P}`, name: R1.name, userId: R1.id, reportingManagerId: eT.id } });
  const today = istDay(0);
  const leaveTo = istDay(1);
  await prisma.leaveRequest.create({ data: { employeeId: eR.id, type: 'Casual', fromDate: today, toDate: leaveTo, days: 2, status: 'Approved', reason: 'test' } });
  const fuDue = await prisma.applicationFollowUp.create({ data: { applicationId: apps.a3, candidateId: C3.id, requirementId: j1.id, ownerUserId: R1.id, ownerName: R1.name, ownerRole: 'Recruiter', tlUserId: T1.id, tlName: T1.name, dueDate: today, nextAction: 'Call back' } });
  const fuLater = await prisma.applicationFollowUp.create({ data: { applicationId: apps.a4, candidateId: C4.id, requirementId: j1.id, ownerUserId: R1.id, ownerName: R1.name, ownerRole: 'Recruiter', tlUserId: T1.id, tlName: T1.name, dueDate: istDay(10), nextAction: 'Later' } });
  const task = await prisma.task.create({ data: { name: `Sx task ${P}`, assigneeId: R1.id, assignedById: T1.id, assigneeName: R1.name, assignedByName: T1.name, endDate: today, status: 'Not Started' } });
  check('a recruiter cannot set a backup for a colleague', (await call('PUT', '/ats/team-tools/leave-cover/backup', { userId: B1.id, backupUserId: R1.id }, tR2)).status === 403);
  r = await call('PUT', '/ats/team-tools/leave-cover/backup', { userId: R1.id, backupUserId: B1.id }, tT1);
  check('the TL sets a backup for their recruiter', r.status === 200 && r.body.backup && r.body.backup.id === B1.id, r.body);
  check('...and cannot make a person their own backup', (await call('PUT', '/ats/team-tools/leave-cover/backup', { userId: R1.id, backupUserId: R1.id }, tT1)).status === 400);
  r = await call('GET', '/ats/team-tools/leave-cover', null, tT1);
  check('the TL sees the recruiter on leave today, with the backup', r.status === 200 && (r.body.team.find((m) => m.id === R1.id) || {}).onLeave && (r.body.team.find((m) => m.id === R1.id) || {}).backup.id === B1.id, r.body && r.body.team && r.body.team.find((m) => m.id === R1.id));
  check('only an Admin runs the leave-cover pass by hand', (await call('POST', '/ats/team-tools/leave-cover/run', {}, tR1)).status === 403);
  r = await call('POST', '/ats/team-tools/leave-cover/run', {}, tA);
  let f1 = await prisma.applicationFollowUp.findUnique({ where: { id: fuDue.id } });
  let f2 = await prisma.applicationFollowUp.findUnique({ where: { id: fuLater.id } });
  let t1 = await prisma.task.findUnique({ where: { id: task.id } });
  check('on leave: the follow-up due today goes to the backup, with a note', r.status === 200 && r.body.moved >= 2 && f1.ownerUserId === B1.id && /\[Leave cover\]/.test(f1.notes || ''), { run: r.body, owner: f1.ownerUserId, notes: f1.notes });
  check('...the follow-up due after the leave stays with the recruiter', f2.ownerUserId === R1.id, f2.ownerUserId);
  check('...the task ending today goes to the backup, with a comment', t1.assigneeId === B1.id && !!(await prisma.taskComment.findFirst({ where: { taskId: task.id, text: { contains: '[Leave cover]' } } })), t1.assigneeId);
  r = await call('POST', '/ats/team-tools/leave-cover/run', {}, tA);
  check('idempotent: a second run moves nothing', r.status === 200 && r.body.moved === 0 && r.body.returned === 0, r.body);
  r = await call('GET', '/ats/team-tools/leave-cover', null, tB1);
  check('the backup sees what they cover', r.status === 200 && r.body.covering.length === 2 && r.body.covering.every((i) => i.from.id === R1.id), r.body && r.body.covering);
  r = await call('GET', '/ats/team-tools/leave-cover', null, tR1);
  check('the recruiter sees what of theirs is with the backup', r.status === 200 && r.body.coveredForMe.length === 2, r.body && r.body.coveredForMe);
  check('the bell tells the backup', !!(await prisma.notification.findFirst({ where: { userId: B1.id, title: { contains: 'Covering' } } })));
  const backDay = istDay(2);
  r = await call('POST', '/ats/team-tools/leave-cover/run', { today: backDay }, tA);
  f1 = await prisma.applicationFollowUp.findUnique({ where: { id: fuDue.id } });
  t1 = await prisma.task.findUnique({ where: { id: task.id } });
  check('after the leave: the follow-up and the task go back to the recruiter, with a note', r.status === 200 && r.body.returned === 2 && f1.ownerUserId === R1.id && /back from leave/.test(f1.notes || '') && t1.assigneeId === R1.id, { run: r.body, owner: f1.ownerUserId, task: t1.assigneeId });
  r = await call('POST', '/ats/team-tools/leave-cover/run', { today: backDay }, tA);
  check('idempotent: nothing is given back twice', r.status === 200 && r.body.returned === 0 && r.body.moved === 0, r.body);
  await call('PUT', '/ats/team-tools/leave-cover/backup', { userId: R1.id, backupUserId: null }, tT1);
  r = await call('POST', '/ats/team-tools/leave-cover/run', { today }, tA);
  f1 = await prisma.applicationFollowUp.findUnique({ where: { id: fuDue.id } });
  t1 = await prisma.task.findUnique({ where: { id: task.id } });
  check('with no backup set, the TL covers (the follow-up\'s TL; the task\'s reporting manager)', f1.ownerUserId === T1.id && t1.assigneeId === T1.id, { owner: f1.ownerUserId, task: t1.assigneeId, run: r.body });
  await prisma.applicationFollowUp.update({ where: { id: fuDue.id }, data: { completedAt: new Date() } });
  r = await call('POST', '/ats/team-tools/leave-cover/run', { today: backDay }, tA);
  f1 = await prisma.applicationFollowUp.findUnique({ where: { id: fuDue.id } });
  t1 = await prisma.task.findUnique({ where: { id: task.id } });
  check('a follow-up done while covering stays done with the cover; the open task goes back', f1.ownerUserId === T1.id && t1.assigneeId === R1.id && r.body.returned === 1, { owner: f1.ownerUserId, task: t1.assigneeId, run: r.body });

  // ======================= 6. REQUIREMENT AGEING IN THE CLIENT PORTAL =======================
  const CL = await prisma.user.create({ data: { name: `Sx client ${P}`, email: `sx.client.${P}@sx-test.in`, passwordHash: 'x', status: 'Active', role: 'CLIENT', atsRole: 'CLIENT', atsAccess: true, clientId: j1.clientId, portalType: 'VIEWER', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const tCL = await tok(CL.id);
  const pr = await call('GET', '/portal/client', null, tCL);
  const reqs = (pr.body && pr.body.requirements) || [];
  const liveOnes = reqs.filter((x) => x.live);
  check('client portal: every live requirement says "open for N days" (days since raised); closed ones none', pr.status === 200 && liveOnes.length > 0
    && liveOnes.every((x) => Number.isInteger(x.openDays) && x.openDays >= 0 && x.openDays === Math.floor((Date.now() - new Date(x.raisedAt).getTime()) / 86400000))
    && reqs.filter((x) => !x.live).every((x) => x.openDays === null), { s: pr.status, e: pr.body && pr.body.error, r: liveOnes.slice(0, 2) });
  check('client portal: job 1 is listed with its age', reqs.some((x) => x.id === j1.id && Number.isInteger(x.openDays)), reqs.length);
  const jp = await call('GET', '/job-portal/client', null, tCL);
  check('client job portal: the same "open for N days" on its requirement list', jp.status === 200 && (jp.body.requirements || []).filter((x) => x.live).length > 0 && (jp.body.requirements || []).filter((x) => x.live).every((x) => Number.isInteger(x.openDays)), { s: jp.status, e: jp.body && jp.body.error });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
