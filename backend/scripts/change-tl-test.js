#!/usr/bin/env node
/**
 * CHANGE THE TEAM LEAD of a candidate (founder 2026-11-20): the options, the refusals, the move through the ordinary Change recruiter,
 * the audit and history line, the bells to the old and the new team lead (and the STL above), and that Change recruiter is unchanged.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4201 node scripts/change-tl-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-changetl-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4201;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'changetl-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, TEAM_LEAD_CHANGE_DEPARTMENTS: `Education,Ctl${process.pid}` }; // the rule: Education only (the test's own department is added)
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
const old = new Date(Date.now() - 3600e3);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const DEPT = `Ctl${P}`;
  const mk = async (tag, role, extra = {}) => {
    const dept = extra.dept || DEPT;
    const u = await prisma.user.create({ data: { name: `Ctl ${tag} ${P}`, email: `ctl.${tag}.${P}@ctl-test.in`, passwordHash: 'x', status: 'Active', role: role === 'RECRUITER' ? 'EMPLOYEE' : role, atsRole: role, atsDepartment: dept, atsAccess: true, passwordChangedAt: old } });
    const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `CTL${tag}${P}`, name: u.name, department: dept, employmentStatus: 'Active' } });
    return { u, e };
  };
  const seat = async (code, kind, holder, team, reportsToId) => {
    const p = await prisma.position.create({ data: { code: `${code}-${P}`, name: code, department: DEPT, team, kind, reportsToId: reportsToId || null, active: true } });
    if (holder) await prisma.positionAssignment.create({ data: { positionId: p.id, employeeId: holder.e.id, fromDate: '2026-01-01' } });
    return p;
  };
  const stl = await mk('stl', 'STL');
  const tl1 = await mk('tl1', 'TL');
  const tl2 = await mk('tl2', 'TL');
  const tl3 = await mk('tl3', 'TL'); // a team lead with no recruiter
  const r1 = await mk('r1', 'RECRUITER');
  const r2 = await mk('r2', 'RECRUITER');
  const rx = await mk('rx', 'RECRUITER'); // a recruiter with no seat
  const bde = await mk('bde', 'BDE', { dept: 'BDE' });
  const sSTL = await seat('STL', 'STL', stl, null);
  const sTL1 = await seat('TL1', 'TL', tl1, 'Team A', sSTL.id);
  const sTL2 = await seat('TL2', 'TL', tl2, 'Team B', sSTL.id);
  await seat('TL3', 'TL', tl3, 'Team B', sSTL.id);
  // a team lead of ANOTHER department (founder 2026-11-20: a company-wide login searches any team lead's name)
  const tlM = await mk('tlm', 'TL', { dept: 'Medical' });
  const sTLM = await prisma.position.create({ data: { code: `TLM-${P}`, name: 'TLM', department: 'Medical', team: 'Team M', kind: 'TL', active: true } });
  await prisma.positionAssignment.create({ data: { positionId: sTLM.id, employeeId: tlM.e.id, fromDate: '2026-01-01' } });
  const sR1 = await seat('R1', 'RECRUITER', r1, 'Team A', sTL1.id);
  const sR2 = await seat('R2', 'RECRUITER', r2, 'Team B', sTL2.id);
  const client = await prisma.client.findFirst({});
  const reqRow = await prisma.requirement.create({ data: { title: `Ctl job ${P}`, clientId: client.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl1.u.id, recruiterId: r1.u.id, recruiterIds: r1.u.id, positionCode: sR1.code } });
  const mkApp = async (tag, stage = 'SOURCED') => {
    const c = await prisma.candidate.create({ data: { name: `Ctl Person ${tag} ${P}`, phone: `7${String(P + tag.length).padStart(9, '3').slice(-9)}`, email: `ctl.person.${tag}.${P}@ctl-test.in` } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: reqRow.id, stage, ownerRecruiterId: r1.u.id } });
    return { c, a };
  };
  const { c: cand, a: app } = await mkApp('one');
  const { c: candJ, a: appJ } = await mkApp('joined', 'JOINED');

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('the server did not answer /api/health'); await stop(2); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tT1 = await tok(tl1.u.id); const tR1 = await tok(r1.u.id); const tB = await tok(bde.u.id);

  const TITLES = ['Candidate moved out of your team', 'Candidate joined your team', 'Candidate team lead changed'];
  const bells = async (userId, since) => prisma.notification.findMany({ where: { userId, createdAt: { gte: since }, title: { in: TITLES } } });
  const assign = (token, id, recruiterId, extra = {}) => call('POST', '/applications/bulk', { action: 'assign', correct: true, applicationIds: [id], recruiterId, ...extra }, token);

  // ---- options
  for (const [who, t] of [['TL1', tT1], ['an Admin', tA]]) {
    // eslint-disable-next-line no-await-in-loop
    const o = await call('GET', `/applications/${app.id}/team-lead-options`, null, t);
    const list = (o.body && o.body.options) || [];
    const two = list.find((x) => x.tlUserId === tl2.u.id);
    const three = list.find((x) => x.tlUserId === tl3.u.id);
    check(`options as ${who}: TL2 is offered with their recruiter and seat`, o.status === 200 && !!two && two.recruiters.length === 1 && two.recruiters[0].id === r2.u.id && two.recruiters[0].seatCode === sR2.code && two.section === 'Team B', o.body);
    check(`options as ${who}: the current team lead (TL1) is listed but marked current, the others are not`, list.some((x) => x.tlUserId === tl1.u.id && x.current === true) && list.filter((x) => x.current).length === 1);
    check(`options as ${who}: "now" names TL1 and the recruiter`, o.body && o.body.now && o.body.now.tlUserId === tl1.u.id && o.body.now.recruiterId === r1.u.id, o.body && o.body.now);
    check(`options as ${who}: a team lead with no recruiter is listed with none`, !!three && three.recruiters.length === 0, three);
  }
  {
    // Change team lead is for the Education teams only (founder 2026-11-20): a job of any other department has no such option, from the page or by hand
    const medReq = await prisma.requirement.create({ data: { title: `Ctl medical job ${P}`, clientId: client.id, department: 'Medical', status: 'RECRUITER_ASSIGNED', tlId: tlM.u.id, positionCode: sTLM.code } });
    const medCand = await prisma.candidate.create({ data: { name: `Ctl Person med ${P}`, phone: `6${String(P).padStart(9, '4').slice(-9)}`, email: `ctl.person.med.${P}@ctl-test.in` } });
    const medApp = await prisma.application.create({ data: { candidateId: medCand.id, requirementId: medReq.id, stage: 'SOURCED', ownerRecruiterId: r1.u.id } });
    const om = await call('GET', `/applications/${medApp.id}/team-lead-options`, null, tA);
    check('a job of another department (Medical): the options are refused for an Admin, with the reason', om.status === 403 && /Education/.test((om.body && om.body.error) || ''), om.body);
    const bm = await call('POST', '/applications/bulk', { action: 'assign', correct: true, applicationIds: [medApp.id], recruiterId: r1.u.id, comment: 'test reason', teamLeadChange: { toTlUserId: tl2.u.id } }, tA);
    check('...and a hand-made change request for it is refused too', !(bm.body && bm.body.results && bm.body.results[0] && bm.body.results[0].ok) && /Education/.test(JSON.stringify(bm.body)), bm.body);
    check('...while the Education test job still gets its options', (await call('GET', `/applications/${app.id}/team-lead-options`, null, tA)).status === 200);
  }
  check('a recruiter login cannot read the options (403)', (await call('GET', `/applications/${app.id}/team-lead-options`, null, tR1)).status === 403);
  check('a BDE login cannot read the options (403)', (await call('GET', `/applications/${app.id}/team-lead-options`, null, tB)).status === 403);
  check('an unknown application is 404', (await call('GET', '/applications/nope/team-lead-options', null, tA)).status === 404);

  // ---- refusals
  const body = (extra) => ({ teamLeadChange: { toTlUserId: tl2.u.id }, ...extra });
  const ownerNow = async (id) => (await prisma.application.findUnique({ where: { id } })).ownerRecruiterId;
  const noWhy = await assign(tA, app.id, r2.u.id, body({}));
  check('saving without a reason is refused', noWhy.status === 400 && /why/i.test(noWhy.body.error), noWhy.body);
  const shortWhy = await assign(tA, app.id, r2.u.id, body({ comment: 'x' }));
  check('a one-letter reason is refused', shortWhy.status === 400, shortWhy.body);
  const noRec = await call('POST', '/applications/bulk', { action: 'assign', correct: true, applicationIds: [app.id], comment: 'because', teamLeadChange: { toTlUserId: tl2.u.id } }, tA);
  check('saving without a recruiter is refused', noRec.status === 400, noRec.body);
  const outside = await assign(tA, app.id, r1.u.id, body({ comment: 'wrong team recruiter' }));
  check("a recruiter outside TL2's team is refused", outside.status === 400 && /does not sit/i.test(outside.body.error), outside.body);
  const noSeat = await assign(tA, app.id, rx.u.id, body({ comment: 'no seat recruiter' }));
  check('a recruiter with no seat is refused', noSeat.status === 400, noSeat.body);
  check('nothing moved after the refusals', (await ownerNow(app.id)) === r1.u.id);
  const t0 = new Date(Date.now() - 1000);
  const many = await call('POST', '/applications/bulk', { action: 'assign', correct: true, applicationIds: [app.id, appJ.id], recruiterId: r2.u.id, comment: 'both', teamLeadChange: { toTlUserId: tl2.u.id } }, tA);
  check('two candidates at once is refused', many.status === 400, many.body);
  check('a recruiter login cannot change it (403)', (await assign(tR1, app.id, r2.u.id, body({ comment: 'I want it' }))).status === 403);
  check('a BDE login cannot change it (403)', (await assign(tB, app.id, r2.u.id, body({ comment: 'I want it' }))).status === 403);

  // ---- the change, as TL1
  const why = 'Sourced for Team B, wrongly under Team A';
  const ok = await assign(tT1, app.id, r2.u.id, body({ comment: why }));
  const row = ok.body && ok.body.results && ok.body.results[0];
  check('TL1 changes the team lead: saved, and the UI gets the note', ok.status === 200 && row && row.ok && /Team lead changed from .* to .*Ctl tl2/.test(row.note || ''), ok.body);
  check('the candidate now belongs to the new recruiter', (await ownerNow(app.id)) === r2.u.id);
  const ownerFu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
  check('the open follow-up is with the new recruiter on their seat', ownerFu && ownerFu.ownerUserId === r2.u.id && ownerFu.ownerPositionCode === sR2.code, ownerFu && { o: ownerFu.ownerUserId, p: ownerFu.ownerPositionCode });
  const det = await call('GET', `/candidates/${cand.id}`, null, tA);
  check('the profile shows TL2, Team B and the new recruiter and seat', det.status === 200 && det.body.ownership && det.body.ownership.tl === tl2.u.name && det.body.ownership.section === 'Team B' && det.body.ownership.recruiter === r2.u.name && det.body.ownership.positionCode === sR2.code, det.body.ownership);
  const aud = await prisma.auditLog.findFirst({ where: { entity: 'Application', entityId: app.id, action: 'Candidate team lead changed' } });
  check('the audit row names the old and new team lead and the reason', aud && aud.fromValue === tl1.u.name && aud.toValue === tl2.u.name && aud.reason === why, aud);
  const act = (det.body.activity || []).find((x) => /Team lead changed from/.test(x.what));
  check('the activity history shows "Team lead changed from A to B" with the reason', act && act.what === `Team lead changed from ${tl1.u.name} to ${tl2.u.name}` && act.why === why, act);
  const tlLine = ((det.body.applications || [])[0] || {}).ownership;
  check('the ownership timeline has the team lead line with the reason', tlLine && tlLine.timeline.some((t) => t.text === `Team lead changed from ${tl1.u.name} to ${tl2.u.name} - ${why}`), tlLine && tlLine.timeline);
  const handed = await prisma.auditLog.count({ where: { entity: 'Application', entityId: app.id, action: { startsWith: 'Candidate handed over' } } });
  check('no handover row is written (the earlier recruiter keeps no credit, same as Change recruiter)', handed === 0, handed);
  const [b1, b2, bs, br] = await Promise.all([bells(tl1.u.id, t0), bells(tl2.u.id, t0), bells(stl.u.id, t0), bells(r1.u.id, t0)]);
  check('TL1 did this himself, so he is not told of his own action', b1.length === 0, b1.map((x) => x.message));
  check('the new team lead got exactly one bell ("joined your team") with recruiter, job and reason', b2.length === 1 && b2[0].title === 'Candidate joined your team' && b2[0].message.includes(r2.u.name) && b2[0].message.includes(why) && b2[0].message.includes(`Ctl job ${P}`), b2.map((x) => x.message));
  check('the STL above both got exactly one bell', bs.length === 1 && bs[0].title === 'Candidate team lead changed', bs.map((x) => x.message));
  check('the old recruiter got no team-lead bell', br.length === 0, br);
  const assignBells = await prisma.notification.count({ where: { userId: r2.u.id, createdAt: { gte: t0 }, title: { contains: 'assigned to you' } } });
  check('the new recruiter got the ordinary assigned notice exactly once (not doubled)', assignBells === 1, assignBells);

  // ---- already there / back again as an Admin
  const again = await assign(tA, app.id, r2.u.id, body({ comment: 'same team again' }));
  check('moving to the team lead it is already with is refused', again.body.results && again.body.results[0] && !again.body.results[0].ok && /already in/i.test(again.body.results[0].error), again.body);
  const o2 = await call('GET', `/applications/${app.id}/team-lead-options`, null, tA);
  check('after the move, TL2 is the current one and TL1 is selectable', (o2.body.options || []).some((x) => x.tlUserId === tl2.u.id && x.current) && (o2.body.options || []).some((x) => x.tlUserId === tl1.u.id && !x.current), o2.body);
  const t1 = new Date(Date.now() - 500);
  const back = await assign(tA, app.id, r1.u.id, { teamLeadChange: { toTlUserId: tl1.u.id }, comment: 'moved back by the Admin' });
  check('an Admin moves it back to TL1 with R1', back.status === 200 && back.body.results[0].ok && (await ownerNow(app.id)) === r1.u.id, back.body);
  const d2 = await call('GET', `/candidates/${cand.id}`, null, tA);
  check('the profile shows TL1 again', d2.body.ownership && d2.body.ownership.tl === tl1.u.name && d2.body.ownership.section === 'Team A', d2.body.ownership);
  check('TL1 and TL2 each got exactly one more bell', (await bells(tl1.u.id, t1)).length === 1 && (await bells(tl2.u.id, t1)).length === 1);

  // ---- a joined candidate
  await new Promise((r) => { setTimeout(r, 50); });
  const t2 = new Date();
  const jv = await assign(tA, appJ.id, r2.u.id, body({ comment: 'data correction on a joined profile' }));
  check('a joined candidate can be corrected', jv.status === 200 && jv.body.results[0].ok && (await ownerNow(appJ.id)) === r2.u.id, jv.body);
  const jfu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: appJ.id }, orderBy: { createdAt: 'desc' } });
  check('...with no new task, only the closed note', jfu && jfu.completedAt && /joined/i.test(jfu.completedNote || ''), jfu && jfu.completedNote);
  const dj = await call('GET', `/candidates/${candJ.id}`, null, tA);
  check('...and the joined profile shows TL2', dj.body.ownership && dj.body.ownership.tl === tl2.u.name, dj.body.ownership);
  const [j1, j2] = await Promise.all([bells(tl1.u.id, t2), bells(tl2.u.id, t2)]);
  check('an Admin change: the old team lead got one bell with the reason and the new team lead named, the new one got one', j1.length === 1 && j1[0].title === 'Candidate moved out of your team' && j1[0].message.includes('data correction') && j1[0].message.includes(tl2.u.name) && j2.length === 1 && j2[0].title === 'Candidate joined your team', { j1: j1.map((x) => x.message), j2: j2.map((x) => x.message) });

  // ---- plain Change recruiter still works, writes no team-lead audit
  const { a: aPlain } = await mkApp('plain');
  const nTl = await prisma.auditLog.count({ where: { action: 'Candidate team lead changed' } });
  const plain = await assign(tA, aPlain.id, r2.u.id, { comment: 'ordinary correction' });
  check('Change recruiter (no teamLeadChange) still works unchanged', plain.status === 200 && plain.body.results[0].ok && (await ownerNow(aPlain.id)) === r2.u.id, plain.body);
  check('...and writes no team-lead audit row', (await prisma.auditLog.count({ where: { action: 'Candidate team lead changed' } })) === nTl);
  check('...and a plain correction needs no reason on the server, as before', (await assign(tA, aPlain.id, r1.u.id, {})).status === 200);


  // ---- FOUNDER BUG 2026-11-20: the requirement names TL_A, but the recruiter's seat sits under TL_B
  const reqB = await prisma.requirement.create({ data: { title: `Ctl jobB ${P}`, clientId: client.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl1.u.id, tl: tl1.u.name, recruiterId: r2.u.id, recruiterIds: `${r2.u.id},${rx.u.id}`, positionCode: sR1.code } });
  const tR2 = await tok(r2.u.id);
  const candB = await prisma.candidate.create({ data: { name: `Ctl Person added ${P}`, phone: `6${String(P).padStart(9, '5').slice(-9)}`, email: `ctl.person.added.${P}@ctl-test.in` } });
  const addB = await call('POST', '/applications', { candidateId: candB.id, requirementId: reqB.id }, tR2);
  const appB = addB.body && addB.body.id;
  check("setup: a recruiter of TL2's team adds a candidate to a job whose stored TL is TL1", addB.status === 201 && !!appB, addB.body);
  const dB = await call('GET', `/candidates/${candB.id}`, null, tA);
  check("the page says TL2 (the recruiter's seat), not the requirement's TL1", dB.body.ownership && dB.body.ownership.tl === tl2.u.name && dB.body.ownership.section === 'Team B', dB.body.ownership);
  const oB = await call('GET', `/applications/${appB}/team-lead-options`, null, tA);
  check('the dialog "Now" says TL2 too', oB.body.now && oB.body.now.tlUserId === tl2.u.id && oB.body.now.tlName === tl2.u.name && oB.body.now.source === 'seat', oB.body && oB.body.now);
  const optB = oB.body.options || [];
  check('TL1 is selectable and TL2 is the current, unselectable one', optB.some((x) => x.tlUserId === tl1.u.id && !x.current && x.recruiters.length === 1) && optB.some((x) => x.tlUserId === tl2.u.id && x.current === true), optB.map((x) => [x.tlName, x.current]));
  const FU = require('../src/utils/followups');
  const reqFull = await prisma.requirement.findUnique({ where: { id: reqB.id }, include: { client: true, recruiter: true, bde: true } });
  const namesB = await FU.resolveNames([reqFull]);
  const snapB = FU.chainSnapshot({ ownerRecruiterId: r2.u.id, stage: 'NEW' }, reqFull, namesB);
  check("a new follow-up of that recruiter is stamped with TL2 and the STL, not the requirement's TL1", snapB.tlUserId === tl2.u.id && snapB.tlName === tl2.u.name && snapB.stlUserId === stl.u.id, snapB);
  const snapRx = FU.chainSnapshot({ ownerRecruiterId: rx.u.id, stage: 'NEW' }, reqFull, namesB);
  check("a recruiter with no seat is stamped with the requirement's TL1", snapRx.tlUserId === tl1.u.id, snapRx);
  const tB0 = new Date(Date.now() - 200);
  const toA = await assign(tA, appB, r1.u.id, { teamLeadChange: { toTlUserId: tl1.u.id }, comment: 'Team A should have it' });
  check('change to TL1 works', toA.status === 200 && toA.body.results[0].ok && (await ownerNow(appB)) === r1.u.id, toA.body);
  const fuB = await prisma.applicationFollowUp.findFirst({ where: { applicationId: appB, completedAt: null }, orderBy: { createdAt: 'desc' } });
  check("the follow-up made by the change is stamped with TL1 (the new recruiter's seat)", fuB && fuB.tlUserId === tl1.u.id && fuB.ownerUserId === r1.u.id, fuB && { tl: fuB.tlUserId });
  const [bb1, bb2] = await Promise.all([bells(tl1.u.id, tB0), bells(tl2.u.id, tB0)]);
  check("TL2 (the real old team lead, not the requirement's TL1) is told it moved out, TL1 is told it joined", bb2.length === 1 && bb2[0].title === 'Candidate moved out of your team' && bb1.length === 1 && bb1[0].title === 'Candidate joined your team', { bb1: bb1.map((x) => x.title), bb2: bb2.map((x) => x.title) });
  // a recruiter without a seat: the page falls back to the requirement's TL
  const candN = await prisma.candidate.create({ data: { name: `Ctl Person noseat ${P}`, phone: `5${String(P).padStart(9, '6').slice(-9)}`, email: `ctl.person.noseat.${P}@ctl-test.in` } });
  const appN = await prisma.application.create({ data: { candidateId: candN.id, requirementId: reqB.id, stage: 'SOURCED', ownerRecruiterId: rx.u.id } });
  const dN = await call('GET', `/candidates/${candN.id}`, null, tA);
  check("a recruiter with no seat: the page shows the requirement's TL1", dN.body.ownership && dN.body.ownership.tl === tl1.u.name, dN.body.ownership);
  const oN = await call('GET', `/applications/${appN.id}/team-lead-options`, null, tA);
  check('...and the dialog agrees (Now = TL1, same TL1)', oN.body.now && oN.body.now.tlUserId === tl1.u.id, oN.body.now);
  // the repair
  const TLC = require('../src/utils/teamLeadChange');
  await prisma.applicationFollowUp.updateMany({ where: { applicationId: appB, completedAt: null }, data: { completedAt: new Date() } });
  const wrong = await prisma.applicationFollowUp.create({ data: { applicationId: appB, candidateId: candB.id, requirementId: reqB.id, ownerUserId: r2.u.id, ownerName: r2.u.name, ownerRole: 'Recruiter', tlUserId: tl1.u.id, tlName: tl1.u.name, nextAction: 'x', dueDate: '2026-12-31', notes: 'wrongly stamped' } });
  const dry = await TLC.repairStamps({ dryRun: true });
  check('the repair dry run counts the wrongly stamped open follow-up and changes nothing', dry.wrong >= 1 && (await prisma.applicationFollowUp.findUnique({ where: { id: wrong.id } })).tlUserId === tl1.u.id, dry);
  const done = await TLC.repairStamps({ dryRun: false });
  const fixedRow = await prisma.applicationFollowUp.findUnique({ where: { id: wrong.id } });
  check('the repair re-stamps it with TL2 and the STL and writes an audit row', done.fixed >= 1 && fixedRow.tlUserId === tl2.u.id && fixedRow.stlUserId === stl.u.id && !!(await prisma.auditLog.findFirst({ where: { action: { startsWith: 'Follow-up team lead re-stamped' } } })), { done, tl: fixedRow.tlUserId });
  const again2 = await TLC.repairStamps({ dryRun: true });
  check('running it again finds nothing to change (idempotent)', again2.wrong === 0, again2);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
