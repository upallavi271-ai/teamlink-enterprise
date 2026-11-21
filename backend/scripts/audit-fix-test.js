#!/usr/bin/env node
/**
 * AUDIT FIXES (360 audit 2026-11-20, round of fixes 2026-11-21): the checks behind each fix and each founder rule the audit met.
 *   1  a BDE never picks recruiters (a different pick is refused); the client's own BDE takes (Accepts) the client's request
 *      (founder 2026-10-23), a BDE of another desk cannot
 *   2  an extra team lead of the job's department sees the job and its people; a TL of another department named on it does not
 *      (founder 2026-10-29: a department TL sees their department's jobs only)
 *   3  a job merge with a person on both jobs moves the rows of tables that have no id column (AppSubStatus,
 *      InterviewHourlyReminder) and Undo puts them back; AiCallJobSetting stays with each job
 *   4  TL / STL / Recruiter: no agreement key or word in GET /clients, /requirements (also on the memo hit), the job page
 *   5  the follow-ups of a shared person reach the BDEs of that job's desk (founder 2026-10-29), not another desk
 *   6  the BDE's pipeline board carries no salary figure, also on the memo hit
 *   9  GET /candidates?limit=&offset= pages the plain list (X-Total-Count), the same rows as the full list
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<sandbox copy> TEST_PORT=<4300-4799> node scripts/audit-fix-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const PORT = Number(process.env.TEST_PORT) || (4300 + Math.floor(Math.random() * 500));
if (PORT === 4010) { console.error('Refusing: never the real server port.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `zz-auditfix-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const API = `http://localhost:${PORT}/api`;
const UPLOADS = path.join(os.tmpdir(), `zz-auditfix-up-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'auditfix-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* none */ }
  return { status: r.status, body: j, text, total: r.headers.get('x-total-count') };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}
const RUN = Date.now().toString(36);
let seq = 0;
const mkUser = async (t, data, emp) => {
  // plain names: some pickers never offer a "zztest" / example.test login
  const u = await prisma.user.create({
    data: {
      name: `Af ${t} ${RUN}`, email: `af.${t}.${RUN}@af-test.in`, username: `af.${t}.${RUN}@af-test.in`, passwordHash: 'x', status: 'Active',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
    },
  });
  if (emp) await prisma.employee.create({ data: { employeeCode: `AF-${t}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: data.atsDepartment || null, email: u.email, ...emp } });
  return u;
};
const phone = () => { seq += 1; return `6${String(Date.now() + seq * 7919).slice(-9)}`; };
const AGREEMENT_WORD = /agreement|unsigned|\be-?sign/i;
const agreementSpots = (v, p = '$', out = []) => {
  if (typeof v === 'string') { if (AGREEMENT_WORD.test(v)) out.push(`${p}=${v.slice(0, 60)}`); return out; }
  if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (AGREEMENT_WORD.test(k)) out.push(`${p}.${k}`); agreementSpots(x, `${p}.${k}`, out); });
  return out;
};

(async () => {
  // ---------------- people ----------------
  const sa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'TL' });
  const tl2 = await mkUser('tl2', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'TL' });
  const tl3 = await mkUser('tl3', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'TL' });
  const tlMed = await mkUser('tlmed', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL' });
  const stl = await mkUser('stl', { role: 'STL', atsRole: 'STL', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { designation: 'STL' });
  const rec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const rec2 = await mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const bdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
  const bde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,IT' }, { tl: bdeTl.name });
  const bdeMed = await mkUser('bdemed', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: bdeTl.name });
  const client = await prisma.client.create({ data: { name: `Af Client ${RUN}`, agreementStatus: 'ACTIVE', ownerDepartment: 'IT', industry: 'IT', bdeOwner: bde.name, clientType: 'Client' } });
  const clientMed = await prisma.client.create({ data: { name: `Af Med Client ${RUN}`, agreementStatus: 'ACTIVE', ownerDepartment: 'Medical', industry: 'Healthcare', bdeOwner: bdeMed.name, clientType: 'Client' } });
  const clientHeld = await prisma.client.create({ data: { name: `Af Held Client ${RUN}`, agreementStatus: 'SENT', ownerDepartment: 'IT', bdeOwner: bde.name, clientType: 'Client', agreementId: `AGRAF${RUN}`.slice(0, 20), agreementDocument: 'Af agreement text' } });
  const mkReq = (data) => { seq += 1; return prisma.requirement.create({ data: { title: `Af Job ${data.tag} ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', openings: 1, reqCode: `ZZAF-${RUN}-${seq}`.slice(0, 40), ...data, tag: undefined } }); };
  const job = await mkReq({ tag: 'main', tlId: tl.id, recruiterId: rec.id, bdeId: bde.id });
  const draft = await mkReq({ tag: 'request', status: 'DRAFT', bdeId: bde.id });
  const draftMed = await mkReq({ tag: 'request med', status: 'DRAFT', clientId: clientMed.id, department: 'Medical', bdeId: bdeMed.id });
  const held = await mkReq({ tag: 'held', status: 'AGREEMENT_CHECK', clientId: clientHeld.id, tlId: tl.id, recruiterId: rec.id, bdeId: bde.id, unsignedApprovedBy: 'Af Someone' });
  const mkCand = (t, extra = {}) => prisma.candidate.create({ data: { name: `Af Person ${t} ${RUN}`, phone: phone(), email: `af.p.${t}.${RUN}@af-test.in`, skills: 'Java', currentSalary: '777000', expectedSalary: '555000', ...extra } });
  const c1 = await mkCand('one');
  const app1 = await prisma.application.create({ data: { candidateId: c1.id, requirementId: job.id, stage: 'SHARED_WITH_CLIENT', ownerRecruiterId: rec.id } });
  await prisma.applicationFollowUp.create({ data: { applicationId: app1.id, candidateId: c1.id, requirementId: job.id, ownerUserId: bde.id, ownerName: bde.name, ownerRole: 'BDE', nextAction: 'Af client decision', dueDate: '2030-01-01' } });
  const RA = require('../src/utils/requestAccept');
  await RA.markRequested(draft.id, 'portal');
  await RA.markRequested(draftMed.id, 'portal');

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1500); });
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const [k, u] of Object.entries({ sa, tl, tl2, tl3, tlMed, stl, rec, rec2, bdeTl, bde, bdeMed })) T[k] = await tok(u); // eslint-disable-line no-await-in-loop

  // ---------------- 1. BDE and the request / the recruiters ----------------
  const bPick = await call('POST', `/requirements/${job.id}/assign`, T.bde, { recruiterId: rec2.id });
  check('1 a BDE picking a different recruiter is refused (403)', bPick.status === 403, [bPick.status, bPick.body]);
  check('1 ... and the job still has its recruiter', (await prisma.requirement.findUnique({ where: { id: job.id } })).recruiterId === rec.id);
  const bCo = await call('POST', `/requirements/${job.id}/assign`, T.bde, { recruiterIds: [rec2.id] });
  check('1 a BDE adding a co-recruiter is refused (403)', bCo.status === 403, bCo.status);
  const bSame = await call('POST', `/requirements/${job.id}/assign`, T.bde, { recruiterId: rec.id, bdeId: bde.id });
  check('1 a BDE saving the team without changing the recruiter changes no recruiter', bSame.status === 200 && (await prisma.requirement.findUnique({ where: { id: job.id } })).recruiterId === rec.id, bSame.status);
  const otherAcc = await call('POST', `/requirements/${draftMed.id}/accept-request`, T.bde, {});
  check('1 a BDE of another desk cannot accept a request of a client that is not theirs', [403, 404].includes(otherAcc.status), [otherAcc.status, otherAcc.body]);
  const recAcc = await call('POST', `/requirements/${draft.id}/accept-request`, T.rec, {});
  check('1 a recruiter cannot accept a request', [403, 404].includes(recAcc.status), recAcc.status);
  const ownAcc = await call('POST', `/requirements/${draft.id}/accept-request`, T.bde, {});
  check('1 founder rule 2026-10-23: the client\'s own BDE takes (Accepts) the client\'s request', ownAcc.status === 200 && ownAcc.body.requestState === 'accepted', [ownAcc.status, ownAcc.body]);
  const tlPick = await call('POST', `/requirements/${job.id}/assign`, T.tl, { recruiterId: rec2.id });
  check('1 the job\'s TL gives it to another recruiter (200)', tlPick.status === 200 && (await prisma.requirement.findUnique({ where: { id: job.id } })).recruiterId === rec2.id, [tlPick.status, tlPick.body && tlPick.body.error]);
  await call('POST', `/requirements/${job.id}/assign`, T.tl, { recruiterId: rec.id });

  // ---------------- 2. several team leads ----------------
  const asg = await call('POST', `/requirements/${job.id}/assign`, T.sa, { tlIds: [tl.id, tl2.id] });
  check('2 setup: the job has a main TL and an extra TL of the same department', asg.status === 200 && (asg.body.tlIds || []).length === 2, [asg.status, asg.body && (asg.body.tlIds || asg.body.error)]);
  const d2 = await call('GET', `/requirements/${job.id}`, T.tl2);
  const d3 = await call('GET', `/requirements/${job.id}`, T.tl3);
  check('2 the extra TL opens the job; a TL not on it does not', d2.status === 200 && [403, 404].includes(d3.status), [d2.status, d3.status]);
  const appsOf = async (t) => { const r = await call('GET', `/applications?requirementId=${job.id}`, t); const rows = Array.isArray(r.body) ? r.body : ((r.body && (r.body.rows || r.body.data)) || []); return rows.map((a) => a.id); };
  check('2 the extra TL sees the job\'s people like the main TL', (await appsOf(T.tl)).includes(app1.id) && (await appsOf(T.tl2)).includes(app1.id) && !(await appsOf(T.tl3)).includes(app1.id));
  check('2 the extra TL opens the person', (await call('GET', `/candidates/${c1.id}`, T.tl2)).status === 200);
  await call('POST', `/requirements/${job.id}/assign`, T.sa, { tlIds: [tl.id, tlMed.id] });
  const dMed = await call('GET', `/requirements/${job.id}`, T.tlMed);
  check('2 founder rule 2026-10-29: a Medical TL named on an IT job does not see it (department TLs see their department\'s jobs)', [403, 404].includes(dMed.status), dMed.status);
  await call('POST', `/requirements/${job.id}/assign`, T.sa, { tlIds: [tl.id] });

  // ---------------- 3. job merge with tables that have no id ----------------
  const K = await mkReq({ tag: 'merge', title: `Af Merge Role ${RUN}`, status: 'OPEN', location: 'Hyderabad', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id });
  const E = await mkReq({ tag: 'merge', title: `Af Merge Role ${RUN}`, status: 'OPEN', location: 'Hyderabad', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id });
  await prisma.requirement.update({ where: { id: K.id }, data: { createdAt: new Date(Date.now() - 5 * 86400000) } });
  const cm = await mkCand('merge');
  const aK = await prisma.application.create({ data: { candidateId: cm.id, requirementId: K.id, stage: 'SHARED_WITH_CLIENT', ownerRecruiterId: rec.id } });
  const aE = await prisma.application.create({ data: { candidateId: cm.id, requirementId: E.id, stage: 'NEW', ownerRecruiterId: rec.id } });
  const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
  const x = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);
  const has = async (t) => (await q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", t)).length > 0;
  if (!(await has('AppSubStatus'))) await x('CREATE TABLE IF NOT EXISTS "AppSubStatus" ("applicationId" TEXT PRIMARY KEY, "subStatusId" TEXT NOT NULL, "stage" TEXT NOT NULL, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)');
  if (!(await has('InterviewHourlyReminder'))) await x('CREATE TABLE IF NOT EXISTS "InterviewHourlyReminder" ("key" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await x('INSERT INTO "AppSubStatus" (applicationId, subStatusId, stage, at) VALUES (?, ?, ?, ?)', aE.id, 'af-sub', 'NEW', new Date().toISOString());
  await x('INSERT INTO "InterviewHourlyReminder" (key, applicationId) VALUES (?, ?)', `af-${RUN}`, aE.id);
  const aiSetting = await has('AiCallJobSetting');
  if (aiSetting) {
    for (const j of [K, E]) await x('INSERT OR REPLACE INTO "AiCallJobSetting" (requirementId, enabled, updatedAt) VALUES (?, 1, ?)', j.id, new Date().toISOString()); // eslint-disable-line no-await-in-loop
  }
  // the AppSetting / scheduler tables are re-read by the server: make sure it sees the new rows
  const mg = await call('POST', '/job-duplicates/merge', T.sa, { keptId: K.id, extraIds: [E.id] });
  const logId = mg.body && mg.body.merged && mg.body.merged[0] && mg.body.merged[0].logId;
  check('3 a merge with the same person on both jobs (sub-status + hourly reminder rows, AI-call settings on both) works', mg.status === 200 && !!logId, [mg.status, mg.body]);
  const sub = await q('SELECT applicationId FROM "AppSubStatus" WHERE subStatusId = ?', 'af-sub');
  const rem = await q('SELECT applicationId FROM "InterviewHourlyReminder" WHERE key = ?', `af-${RUN}`);
  check('3 the rows without an id column moved to the kept person', sub.length === 1 && sub[0].applicationId === aK.id && rem.length === 1 && rem[0].applicationId === aK.id, [sub, rem]);
  if (aiSetting) check('3 each job keeps its own AI-call setting row', (await q('SELECT requirementId FROM "AiCallJobSetting" WHERE requirementId IN (?, ?)', K.id, E.id)).length === 2);
  const un = await call('POST', `/job-duplicates/merges/${logId}/undo`, T.sa);
  const sub2 = await q('SELECT applicationId FROM "AppSubStatus" WHERE subStatusId = ?', 'af-sub');
  const rem2 = await q('SELECT applicationId FROM "InterviewHourlyReminder" WHERE key = ?', `af-${RUN}`);
  check('3 Undo brings them back to the extra job\'s person', un.status === 200 && sub2.length === 1 && sub2[0].applicationId === aE.id && rem2[0].applicationId === aE.id, [un.status, un.body, sub2, rem2]);
  // a kept person who already has a sub-status keeps theirs; the other one is not lost
  await x('INSERT INTO "AppSubStatus" (applicationId, subStatusId, stage, at) VALUES (?, ?, ?, ?)', aK.id, 'af-sub-kept', 'SHARED_WITH_CLIENT', new Date().toISOString());
  const mg2 = await call('POST', '/job-duplicates/merge', T.sa, { keptId: K.id, extraIds: [E.id] });
  const kept = await q('SELECT subStatusId FROM "AppSubStatus" WHERE applicationId = ?', aK.id);
  check('3 merging again when the kept person has their own sub-status: 200, theirs stays', mg2.status === 200 && kept.length === 1 && kept[0].subStatusId === 'af-sub-kept', [mg2.status, mg2.body && mg2.body.error, kept]);
  const log2 = mg2.body && mg2.body.merged && mg2.body.merged[0] && mg2.body.merged[0].logId;
  if (log2) {
    const un2 = await call('POST', `/job-duplicates/merges/${log2}/undo`, T.sa);
    const back = await q('SELECT applicationId FROM "AppSubStatus" WHERE subStatusId = ?', 'af-sub');
    check('3 ... and Undo still finds the other one with its own person', un2.status === 200 && back.length === 1 && back[0].applicationId === aE.id, [un2.status, back]);
  }

  // ---------------- 4. agreement words ----------------
  for (const who of ['tl', 'stl', 'rec']) {
    for (const [label, url] of [['clients list', '/clients'], ['jobs list', '/requirements'], ['held job', `/requirements/${held.id}`], ['request', `/requirements/${draft.id}`]]) {
      const r1 = await call('GET', url, T[who]); // eslint-disable-line no-await-in-loop
      const r2 = await call('GET', url, T[who]); // eslint-disable-line no-await-in-loop  (the 10-second memo answers this one)
      const spots = [...agreementSpots(r1.body), ...agreementSpots(r2.body)];
      check(`4 ${who}: ${label} carries no agreement key or word (first answer and the memo's)`, ![500].includes(r1.status) && spots.length === 0, [r1.status, r2.status, spots.slice(0, 6)]);
    }
  }
  const tlHeld = await call('GET', `/requirements/${held.id}`, T.tl);
  check('4 tl: the held job is Draft with the one hold sentence', tlHeld.status === 200 && tlHeld.body.status === 'DRAFT' && tlHeld.body.gate && tlHeld.body.gate.onHold === true, [tlHeld.status, tlHeld.body && tlHeld.body.status]);
  const bdeTlReq = await call('GET', `/requirements/${draft.id}`, T.bdeTl);
  check('4 the BDE TL (who decides) still gets the reject reasons', bdeTlReq.status === 200 && Array.isArray(bdeTlReq.body.requestRejectReasons) && bdeTlReq.body.requestRejectReasons.length > 0, bdeTlReq.status);
  const saClients = await call('GET', '/clients', T.sa);
  check('4 Super Admin still sees the agreement status on the clients list', saClients.status === 200 && JSON.stringify(saClients.body).includes('agreementStatus'));

  // ---------------- 5. follow-ups of a shared person ----------------
  const fBde = await call('GET', `/followups/application/${app1.id}`, T.bde);
  const fMed = await call('GET', `/followups/application/${app1.id}`, T.bdeMed);
  check('5 founder rule 2026-10-29: the IT desk BDE reads the follow-ups of the person shared on the IT job', fBde.status === 200, fBde.status);
  check('5 a BDE of another desk (Medical) is refused', [403, 404].includes(fMed.status), fMed.status);

  // ---------------- 6. salary on the BDE board ----------------
  const SAL = /777000|555000|7\.77|5\.55/;
  for (const who of ['bde', 'bdeTl']) {
    const b1 = await call('GET', `/candidates/board?requirementId=${job.id}`, T[who]); // eslint-disable-line no-await-in-loop
    const b2 = await call('GET', `/candidates/board?requirementId=${job.id}`, T[who]); // eslint-disable-line no-await-in-loop
    check(`6 ${who}: the board has the person and no salary figure (first answer and the memo's)`, b1.status === 200 && b1.text.includes(c1.id) && !SAL.test(b1.text) && !SAL.test(b2.text), [b1.status, b1.text.includes(c1.id), SAL.test(b1.text), SAL.test(b2.text)]);
  }
  const bSa = await call('GET', `/candidates/board?requirementId=${job.id}`, T.sa);
  check('6 Super Admin\'s board still shows the salary', bSa.status === 200 && SAL.test(bSa.text), bSa.status);

  // ---------------- 9. the plain candidate list pages ----------------
  const full = await call('GET', '/candidates', T.sa);
  const p1 = await call('GET', '/candidates?limit=50', T.sa);
  const p2 = await call('GET', '/candidates?limit=50&offset=50', T.sa);
  check('9 ?limit=50 is the first 50 rows of the full list, ?offset=50 the next 50', Array.isArray(full.body) && JSON.stringify(p1.body) === JSON.stringify(full.body.slice(0, 50)) && JSON.stringify(p2.body) === JSON.stringify(full.body.slice(50, 100)), [full.body && full.body.length, p1.body && p1.body.length]);
  check('9 X-Total-Count is the whole list', Number(p1.total) === full.body.length && Number(full.total) === full.body.length, [p1.total, full.total, full.body.length]);
  const rFull = await call('GET', '/candidates?view=rejected', T.sa);
  const rPage = await call('GET', '/candidates?view=rejected&limit=10', T.sa);
  check('9 with a view the filtered rows are paged', JSON.stringify(rPage.body) === JSON.stringify(rFull.body.slice(0, 10)) && Number(rPage.total) === rFull.body.length, [rPage.total, rFull.body.length]);
  const recList = await call('GET', '/candidates?limit=500', T.rec);
  check('9 a recruiter\'s page still holds only their own people (their person is there)', recList.status === 200 && recList.body.some((c) => c.id === c1.id), recList.status);
  const recX = await call('GET', '/candidates?limit=500', T.tlMed);
  check('9 a TL of another department does not get the person', recX.status === 200 && !recX.body.some((c) => c.id === c1.id), recX.status);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); failed += 1; await stop(1); });
