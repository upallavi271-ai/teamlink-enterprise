#!/usr/bin/env node
/**
 * NISH SHARED POOL (founder 2026-11-26, NISH only): "evaru ey profiles add chesina, recruiters ki tls ki andhariki kanipinchali ... okey candidate ni
 * multiple recruiters, multiple requirements ki followup cheskovachu ... dont touch teamlink".
 * Two teams (TL1 + recruiter A, TL2 + recruiter B), one client "Infosys" with two jobs (R1 = A's, R2 = B's), a profile X uploaded with no job,
 * and a profile Y on R1 owned by A. The same database copy is served twice:
 *   ATS_PROFILE=it-staffing (NISH): B and TL2 see X and Y and R1; B adds Y to R2 with no "same client" reason; Y's two rows name A (R1) and B (R2);
 *                                   B's dashboard stays B's own work.
 *   no ATS_PROFILE (TeamLink):      B sees neither X nor Y nor R1 - exactly as before.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4241 node scripts/nish-shared-pool-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-nish-pool-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-nish-pool-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4241);
const API = `http://localhost:${PORT}/api`;
const baseEnv = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'nish-pool-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
delete baseEnv.ATS_PROFILE;
Object.assign(process.env, baseEnv);
delete process.env.ATS_PROFILE;
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, baseEnv.JWT_SECRET, { expiresIn: '2h' });
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.69.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text };
};
const RUN = Date.now().toString(36);
let server = null;
async function startServer(profile) {
  const env = { ...baseEnv };
  if (profile) env.ATS_PROFILE = profile;
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { await new Promise((r) => { setTimeout(r, 1100); }); return true; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  return false;
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  await new Promise((r) => { s.once('exit', r); s.kill(); setTimeout(r, 4000); });
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await fetch(`${API}/health`).then((r) => r.ok).catch(() => false))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 250); });
  }
}
async function finish(code) {
  await stopServer();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}
const mkUser = async (tag, data, emp) => {
  const u = await prisma.user.create({
    data: {
      name: `Np ${tag} ${RUN}`, email: `np.${tag}.${RUN}@np-test.in`, username: `np.${tag}.${RUN}@np-test.in`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) await prisma.employee.create({ data: { employeeCode: `NP-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } });
  return u;
};
const rowsOf = (r) => (r.body && (r.body.rows || r.body.items || (Array.isArray(r.body) ? r.body : null))) || [];

(async () => {
  const DEPT = 'IT';
  const T1 = `Np Team One ${RUN}`; const T2 = `Np Team Two ${RUN}`;
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl1 = await mkUser('tlone', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: T1 }, { designation: 'TL', team: T1 });
  const tl2 = await mkUser('tltwo', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT, atsScopeTeams: T2 }, { designation: 'TL', team: T2 });
  const recA = await mkUser('reca', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl1.name, team: T1 });
  const recB = await mkUser('recb', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl2.name, team: T2 });
  const client = await prisma.client.create({ data: { name: `Np Infosys ${RUN}`, industry: 'Information Technology', ownerDepartment: DEPT, agreementStatus: 'ACTIVE', status: 'Active' } });
  const mkReq = (title, code, rec, tl) => prisma.requirement.create({
    data: { title, clientId: client.id, department: DEPT, openings: 2, status: 'RECRUITER_ASSIGNED', skills: 'Java', reqCode: code, tlId: tl.id, tl: tl.name, recruiterId: rec.id, employmentType: 'Contract', location: 'Hyderabad' },
  });
  const R1 = await mkReq(`Np Java Developer ${RUN}`, `NP1${RUN}`.toUpperCase(), recA, tl1);
  const R2 = await mkReq(`Np Java Lead ${RUN}`, `NP2${RUN}`.toUpperCase(), recB, tl2);
  const ph = (i) => `9${String(Date.now()).slice(-7)}${i}`.slice(0, 10);
  // X: bulk-uploaded / imported, on no requirement, added by nobody the recruiters are (what an Excel import or a bulk resume upload leaves)
  const X = await prisma.candidate.create({ data: { name: `Npx Bulk ${RUN}`, phone: ph(1), email: `npx.${RUN}@np-test.in`, skills: 'Java', location: 'Hyderabad', experienceYears: 4, currentSalary: '600000', expectedSalary: '800000', source: 'Naukri' } });
  // Y: on R1, recruiter A's
  const Y = await prisma.candidate.create({ data: { name: `Npy Shared ${RUN}`, phone: ph(2), email: `npy.${RUN}@np-test.in`, skills: 'Java', location: 'Hyderabad', experienceYears: 4, currentSalary: '600000', expectedSalary: '800000', noticePeriod: '15 Days', source: 'Naukri' } });
  const appA = await prisma.application.create({ data: { candidateId: Y.id, requirementId: R1.id, stage: 'RECRUITER_REVIEW', ownerRecruiterId: recA.id } });
  await require('../src/utils/candidateAddedBy').record(X.id, recA, 'bulk'); // A uploaded X (bulk resumes), on no requirement
  // Z: imported with NO location, on no requirement - the founder's "tag cheyyakapoina" case
  const Z = await prisma.candidate.create({ data: { name: `Npz Nocity ${RUN}`, phone: ph(3), email: `npz.${RUN}@np-test.in`, skills: 'Java, Spring', experienceYears: 4, currentSalary: '600000', expectedSalary: '800000', source: 'Naukri' } });
  // W: imported with no skills and no resume - nothing to score
  const W = await prisma.candidate.create({ data: { name: `Npw Noskills ${RUN}`, phone: ph(4), email: `npw.${RUN}@np-test.in`, experienceYears: 2, source: 'Other' } });

  // ------------------------------------------------------------------ TeamLink (no ATS_PROFILE): exactly as before
  if (!(await startServer(null))) { console.log('FAIL  the server did not start (TeamLink mode)'); await finish(1); return; }
  console.log('TeamLink (no ATS_PROFILE)');
  let TB = await tokenOf(recB.id);
  const tX = await call('GET', `/candidates/${X.id}`, TB);
  check('TeamLink: recruiter B cannot open the uploaded profile X (as before)', tX.status === 403 || tX.status === 404, tX.status);
  const tY = await call('GET', `/candidates/${Y.id}`, TB);
  check('TeamLink: recruiter B cannot open recruiter A\'s candidate Y (as before)', tY.status === 403 || tY.status === 404, tY.status);
  const tReqs = await call('GET', `/requirements?page=1&pageSize=100&view=all&clientId=${client.id}`, TB);
  check('TeamLink: recruiter B sees only their own job R2, not A\'s R1 (as before)', tReqs.status === 200 && tReqs.text.includes(R2.title) && !tReqs.text.includes(R1.title), [tReqs.status, rowsOf(tReqs).map((r) => r.title)]);
  const tList = await call('GET', `/candidates?paged=1&pageSize=100&view=master&search=${encodeURIComponent(RUN)}`, TB);
  check('TeamLink: recruiter B\'s people list has neither X nor Y (as before)', tList.status === 200 && !tList.text.includes(X.name) && !tList.text.includes(Y.name), tList.status);
  check('TeamLink: the recruiter\'s requirement chips are as before (My Requirements · Open)', tReqs.body && JSON.stringify((tReqs.body.views || []).map((v) => v.key)) === JSON.stringify(['mine', 'open']), tReqs.body && tReqs.body.views);
  const tTA = await tokenOf(recA.id);
  const tDup = await call('POST', '/applications', tTA, { candidateId: Y.id, requirementId: R1.id });
  check('TeamLink: adding Y to R1 again says "already on" as before (no "This profile is with")', tDup.status === 409 && tDup.body && /already on/.test(tDup.body.error || '') && !/This profile is with/.test(tDup.body.error || ''), [tDup.status, tDup.body && tDup.body.error]);
  // the People number on the pipeline screen (where a TL lands): a TL's own reach on TeamLink, smaller than the Super Admin's
  const peopleOf = async (tok) => { const r = await call('GET', '/candidates?paged=1&pageSize=5&view=pipeline', tok); return r.body && r.body.counts && r.body.counts.views ? Number(r.body.counts.views.master) : null; };
  const tTT2 = await tokenOf(tl2.id); const tTS = await tokenOf(sa.id);
  const tPeople = [await peopleOf(tTT2), await peopleOf(tTS)];
  const tZ = await call('GET', `/candidates/${Z.id}/location-requirements`, tTS);
  check('TeamLink: a person with no location gets no requirement list and no scores there (as before)', tZ.status === 200 && !tZ.body.allOpen && !tZ.body.own && (tZ.body.rows || []).length === 0, [tZ.status, tZ.body]);
  check('TeamLink: a TL\'s People count is their own reach, below the Super Admin\'s (as before)', tPeople[0] !== null && tPeople[1] !== null && tPeople[0] < tPeople[1], tPeople);
  await stopServer();

  // ------------------------------------------------------------------ NISH (ATS_PROFILE=it-staffing): the shared pool
  if (!(await startServer('it-staffing'))) { console.log('FAIL  the server did not start (NISH mode)'); await finish(1); return; }
  console.log('NISH (ATS_PROFILE=it-staffing)');
  TB = await tokenOf(recB.id);
  const TA = await tokenOf(recA.id);
  const TT2 = await tokenOf(tl2.id);
  const TS = await tokenOf(sa.id);
  for (const [who, tok] of [['recruiter B', TB], ['TL2 (the other team)', TT2], ['recruiter A', TA]]) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const x = await call('GET', `/candidates/${X.id}`, tok);
    check(`NISH: ${who} opens the bulk-uploaded profile X (on no requirement)`, x.status === 200, [x.status, x.text.slice(0, 160)]);
    // eslint-disable-next-line no-await-in-loop
    const l = await call('GET', `/candidates?paged=1&pageSize=100&view=master&search=${encodeURIComponent(RUN)}`, tok);
    check(`NISH: ${who}'s people list has X and Y`, l.status === 200 && l.text.includes(X.name) && l.text.includes(Y.name), [l.status, l.text.slice(0, 200)]);
  }
  const nY = await call('GET', `/candidates/${Y.id}`, TB);
  check('NISH: recruiter B opens recruiter A\'s candidate Y, with the R1 application', nY.status === 200 && nY.text.includes(R1.title), [nY.status, nY.text.slice(0, 200)]);
  // the People number on the pipeline screen and the People list itself: the same as the Super Admin's (founder: "super admin ki 138 ... verey vaalaki 20")
  const nPeople = async (tok) => { const r = await call('GET', '/candidates?paged=1&pageSize=5&view=pipeline', tok); return r.body && r.body.counts && r.body.counts.views ? Number(r.body.counts.views.master) : null; };
  const nList = async (tok) => { const r = await call('GET', '/candidates?paged=1&pageSize=5&view=master', tok); return r.body ? Number(r.body.total) : null; };
  const counts = { tl2Pipe: await nPeople(TT2), saPipe: await nPeople(TS), tl2List: await nList(TT2), saList: await nList(TS), bList: await nList(TB) };
  // scores without a tag: Z (no location, on no requirement)
  const zFit = await call('GET', `/candidates/${Z.id}/location-requirements`, TT2);
  const zRows = (zFit.body && zFit.body.rows) || [];
  const zR1 = zRows.find((r) => r.id === R1.id);
  check('NISH: Z (no location, on no job) is scored against the open jobs - R1 and R2 listed with a Fit %', zFit.status === 200 && zFit.body.allOpen === true && !!zR1 && typeof zR1.match === 'number' && zRows.some((r) => r.id === R2.id), [zFit.status, zFit.body && { allOpen: zFit.body.allOpen, n: zRows.length }]);
  check('NISH: Z\'s own scores come with it (profile complete %, resume on file)', zFit.body && zFit.body.own && typeof zFit.body.own.completeness === 'number' && typeof zFit.body.own.resumeOnFile === 'boolean', zFit.body && zFit.body.own);
  check('NISH: Z (has skills) is scoreable - no "can\'t score" note', zFit.body && zFit.body.own && !zFit.body.own.cantScore, zFit.body && zFit.body.own);
  const wFit = await call('GET', `/candidates/${W.id}/location-requirements`, TT2);
  check('NISH: W (no skills, no resume) says honestly it cannot be scored', wFit.status === 200 && wFit.body.own && /no skills/i.test(wFit.body.own.cantScore || ''), [wFit.status, wFit.body && wFit.body.own]);
  check('NISH: each match shows its parts (resume / location / salary)', !!zR1 && zR1.resumePct !== undefined && zR1.locPct !== undefined, zR1);
  const zList = await call('GET', `/candidates?paged=1&pageSize=100&view=master&search=${encodeURIComponent(Z.name)}`, TT2);
  const zRow = rowsOf(zList).find((r) => r.id === Z.id);
  check('NISH: in the People list Z shows a Fit % (the best open job) and which job it is', !!zRow && typeof zRow.fitOpenPct === 'number' && !!zRow.fitBest && !!zRow.fitBest.id, zRow && { fitOpenPct: zRow.fitOpenPct, fitBest: zRow.fitBest });
  check('NISH: TL2\'s People count on the pipeline screen equals the Super Admin\'s', counts.tl2Pipe !== null && counts.tl2Pipe === counts.saPipe, counts);
  check('NISH: the People list total is the same for TL2, recruiter B and the Super Admin', counts.tl2List !== null && counts.tl2List === counts.saList && counts.bList === counts.saList, counts);
  const nReqs = await call('GET', `/requirements?page=1&pageSize=100&view=all&clientId=${client.id}`, TB);
  check('NISH: recruiter B sees both jobs of the client (one department)', nReqs.status === 200 && nReqs.text.includes(R1.title) && nReqs.text.includes(R2.title), [nReqs.status, rowsOf(nReqs).map((r) => r.title)]);
  // B picks Y up for B's own job R2 (same client): no "same client" reason asked
  let add = await call('POST', '/applications', TB, { candidateId: Y.id, requirementId: R2.id });
  if (add.status === 409 && add.body && add.body.code === 'NEEDS_OVERRIDE') {
    const why = (add.body.why || []).join(' | ');
    check('NISH: adding Y to a second job of the same client asks no "same client" reason', !/client/i.test(why), why);
    add = await call('POST', '/applications', TB, { candidateId: Y.id, requirementId: R2.id, overrideReason: 'test: profile rules only' });
  } else {
    check('NISH: adding Y to a second job of the same client asks no "same client" reason', add.status < 300, [add.status, add.text.slice(0, 200)]);
  }
  check('NISH: recruiter B adds A\'s candidate Y to R2', add.status >= 200 && add.status < 300, [add.status, add.text.slice(0, 240)]);
  const apps = await prisma.application.findMany({ where: { candidateId: Y.id }, select: { requirementId: true, ownerRecruiterId: true } });
  const own = Object.fromEntries(apps.map((a) => [a.requirementId, a.ownerRecruiterId]));
  check('NISH: each application keeps its own recruiter: R1 = A, R2 = B (A is not taken over)', own[R1.id] === recA.id && own[R2.id] === recB.id, own);
  // "This profile is with <recruiter>": A tries to add Y to R2, where B has them
  const dup = await call('POST', '/applications', TA, { candidateId: Y.id, requirementId: R2.id });
  check('NISH: adding Y to R2 again says "This profile is with" recruiter B', dup.status === 409 && dup.body && (dup.body.error || '').startsWith(`This profile is with ${recB.name}`) && dup.body.withRecruiter === recB.name, [dup.status, dup.body && dup.body.error]);
  const chk = await call('GET', `/applications/pair-check?candidateId=${Y.id}&requirementId=${R1.id}`, TB);
  check('NISH: the duplicate check before adding names recruiter A on R1', chk.status === 200 && chk.body && chk.body.exists === true && (chk.body.message || '').startsWith(`This profile is with ${recA.name}`), [chk.status, chk.body && chk.body.message]);
  // My requirements | All requirements
  const mineReqs = await call('GET', `/requirements?page=1&pageSize=100&clientId=${client.id}`, TB);
  check('NISH: the requirement tabs are My requirements | All requirements, My first', mineReqs.body && JSON.stringify((mineReqs.body.views || []).map((v) => [v.key, v.label])) === JSON.stringify([['mine', 'My requirements'], ['all', 'All requirements']]) && mineReqs.body.defaultView === 'mine', mineReqs.body && [mineReqs.body.views, mineReqs.body.defaultView]);
  check('NISH: My requirements (the default) holds B\'s R2, not A\'s R1', mineReqs.status === 200 && mineReqs.text.includes(R2.title) && !mineReqs.text.includes(R1.title), rowsOf(mineReqs).map((r) => r.title));
  const allReqs = await call('GET', `/requirements?page=1&pageSize=100&view=all&clientId=${client.id}`, TB);
  check('NISH: All requirements holds both', allReqs.status === 200 && allReqs.text.includes(R1.title) && allReqs.text.includes(R2.title), rowsOf(allReqs).map((r) => r.title));
  // My candidates | All candidates
  const pm = (tok, view) => call('GET', `/candidates?paged=1&pageSize=100&view=${view}&pool=mine&search=${encodeURIComponent(RUN)}`, tok);
  const aMine = await pm(TA, 'master');
  check('NISH: A\'s My candidates has X (A uploaded them) and Y (A\'s R1)', aMine.status === 200 && aMine.text.includes(X.name) && aMine.text.includes(Y.name), [aMine.status, aMine.text.slice(0, 200)]);
  const bMine = await pm(TB, 'master');
  check('NISH: B\'s My candidates has Y (B\'s R2) but not X (A uploaded X)', bMine.status === 200 && bMine.text.includes(Y.name) && !bMine.text.includes(X.name), [bMine.status, bMine.text.slice(0, 200)]);
  const bMinePipe = await pm(TB, 'pipeline');
  const bRows = rowsOf(bMinePipe).filter((r) => r.requirementId === R1.id || r.requirementId === R2.id);
  check('NISH: B\'s My candidates in the pipeline is B\'s R2 row only, not A\'s R1 row', bMinePipe.status === 200 && bRows.length === 1 && bRows[0].requirementId === R2.id, bRows.map((r) => [r.requirementTitle, r.recruiterName]));
  const bAll = await call('GET', `/candidates?paged=1&pageSize=100&view=master&search=${encodeURIComponent(RUN)}`, TB);
  check('NISH: B\'s All candidates has X and Y', bAll.status === 200 && bAll.text.includes(X.name) && bAll.text.includes(Y.name), bAll.status);
  const pipe = await call('GET', `/candidates?paged=1&pageSize=100&view=pipeline&search=${encodeURIComponent(Y.name)}`, TS);
  const yRows = rowsOf(pipe).filter((r) => r.requirementId === R1.id || r.requirementId === R2.id);
  const nameOn = (rid) => (yRows.find((r) => r.requirementId === rid) || {}).recruiterName;
  check('NISH: the pipeline names A on Y\'s R1 row and B on Y\'s R2 row', nameOn(R1.id) === recA.name && nameOn(R2.id) === recB.name, yRows.map((r) => [r.requirementTitle, r.recruiterName]));
  const aStill = await call('GET', `/candidates/${Y.id}`, TA);
  check('NISH: recruiter A still opens Y and sees both jobs', aStill.status === 200 && aStill.text.includes(R1.title) && aStill.text.includes(R2.title), aStill.status);
  const dash = await call('GET', '/dashboard/ats/home', TB);
  check('NISH: recruiter B\'s dashboard answers (it stays B\'s own work)', dash.status === 200, [dash.status, dash.text.slice(0, 160)]);
  await stopServer();

  // the shared pool is a NISH rule only: back on TeamLink, B is limited again (B now owns Y's R2 application, so B reaches Y through it, but not X or R1)
  if (!(await startServer(null))) { console.log('FAIL  the server did not restart (TeamLink mode)'); await finish(1); return; }
  console.log('TeamLink again');
  TB = await tokenOf(recB.id);
  const bX = await call('GET', `/candidates/${X.id}`, TB);
  check('TeamLink again: recruiter B still cannot open X', bX.status === 403 || bX.status === 404, bX.status);
  const bReqs = await call('GET', `/requirements?page=1&pageSize=100&view=all&clientId=${client.id}`, TB);
  const zl = await call('GET', `/candidates?paged=1&pageSize=100&view=master&search=${encodeURIComponent(Z.name)}`, await tokenOf(sa.id));
  const zr = rowsOf(zl).find((r) => r.id === Z.id);
  check('TeamLink again: Z shows no Fit % in the People list (no job, as before)', !!zr && zr.fitOpenPct === undefined && !zr.fitBest, zr && { fitOpenPct: zr.fitOpenPct, fitBest: zr.fitBest });
  check('TeamLink again: recruiter B still does not see A\'s R1', bReqs.status === 200 && !bReqs.text.includes(R1.title), rowsOf(bReqs).map((r) => r.title));

  console.log(`\n${total - failed}/${total} passed`);
  await finish(failed ? 1 : 0);
})().catch(async (e) => { console.error('CRASH', e.stack); await finish(1); });
