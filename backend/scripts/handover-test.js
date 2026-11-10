#!/usr/bin/env node
/**
 * Recruiter handover & ownership (utils/handover.js, utils/workers.js joinCredit / sourcedBy, routes/handover.js, the candidate page,
 * the dashboard, Recruiter Joinings), founder 2026-11-10: Kiran sources a candidate and takes them to Selected, hands over to Divya,
 * Divya does the joining -> the joining counts for Kiran; the candidate is with Divya; Kiran's name stays on his work.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4037. Nothing real is called.
 *   node scripts/handover-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-handover-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4037;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'handover-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const W = require('../src/utils/workers');
const H = require('../src/utils/handover');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const DAY = 86400000;
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const recs = (await prisma.user.findMany({ where: { status: 'Active', atsRole: 'RECRUITER', NOT: { employee: { employmentStatus: { in: require('../src/utils/leftLogin').LEFT } } } }, take: 10 })).filter((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const [kiran, divya, third] = recs;
  const req = await prisma.requirement.findFirst({ where: { internal: false, reqCode: { not: null } }, select: { id: true, reqCode: true, recruiterId: true, recruiterIds: true, title: true } });
  // the copy: nobody is stopped by a starting password, and Kiran is on the requirement
  await prisma.user.updateMany({ where: { id: { in: [admin.id, kiran.id, divya.id, third.id] } }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - DAY) } });
  await prisma.requirement.update({ where: { id: req.id }, data: { recruiterId: kiran.id, recruiterIds: [kiran.id, divya.id].join(',') } });

  // Kiran adds the candidate 10 days ago, sends them to the client, gets them Selected 6 days ago
  const t0 = Date.now() - 10 * DAY;
  const cand = await prisma.candidate.create({ data: { name: 'Handover Test Candidate', email: `ho-${process.pid}@candidate.test`, phone: `98${String(process.pid).padStart(8, '0').slice(-8)}` } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'SELECTED', ownerRecruiterId: kiran.id, createdAt: new Date(t0) } });
  const ev = (from, to, at, who) => prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, fromStage: from, toStage: to, action: `Moved to ${to}`, actorUserId: who.id, actorName: who.name, actorRole: 'Recruiter', createdAt: new Date(at) } });
  await ev(null, 'NEW', t0, kiran);
  await ev('NEW', 'SHARED_WITH_CLIENT', t0 + DAY, kiran);
  await ev('INTERVIEW_COMPLETED', 'SELECTED', t0 + 4 * DAY, kiran);
  const fu = await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: kiran.id, ownerName: kiran.name, ownerRole: 'Recruiter', nextAction: 'Confirm the joining date', createdAt: new Date(t0 + 4 * DAY) } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  const hr = await tokenOf(admin.id);

  console.log('The handover screen');
  const asRec = await call('GET', '/ats/handover/recruiters', null, await tokenOf(third.id));
  check('a recruiter cannot open the handover screen', asRec.status === 403, { status: asRec.status, layout: require('../src/utils/atsHome').layoutOf(await resolveIdentity(third.id)), atsRole: third.atsRole, role: third.role });
  const rl = await call('GET', '/ats/handover/recruiters', null, hr);
  check('the recruiters list shows Kiran with his candidates', rl.status === 200 && (rl.body.rows.find((r) => r.id === kiran.id) || {}).candidates >= 1, rl.body && rl.body.rows && rl.body.rows.slice(0, 3));
  const cl = await call('GET', `/ats/handover/candidates?from=${kiran.id}`, null, hr);
  check('Kiran\'s candidates list has this one', cl.status === 200 && cl.body.rows.some((r) => r.id === app.id), cl.body && cl.body.rows && cl.body.rows.length);
  check('a handover with no reason is refused', (await call('POST', '/ats/handover', { from: kiran.id, to: divya.id, applicationIds: [app.id] }, hr)).status === 400);
  check('a handover to an admin (not a recruiter) is refused', (await call('POST', '/ats/handover', { from: kiran.id, to: admin.id, applicationIds: [app.id], reason: 'resigned' }, hr)).status === 400);
  const ho = await call('POST', '/ats/handover', { from: kiran.id, to: divya.id, applicationIds: [app.id], reason: 'Kiran resigned' }, hr);
  check('handed over to Divya', ho.status === 200 && ho.body.moved === 1, ho.body);
  const a2 = await prisma.application.findUnique({ where: { id: app.id } });
  check('the candidate is with Divya now', a2.ownerRecruiterId === divya.id);
  check('the open follow-up task moved to Divya', (await prisma.applicationFollowUp.findUnique({ where: { id: fu.id } })).ownerUserId === divya.id);
  check('the step and the history are unchanged', a2.stage === 'SELECTED' && (await prisma.applicationStageEvent.count({ where: { applicationId: app.id } })) === 3);
  const hos = (await H.handoversFor([app.id])).get(app.id) || [];
  check('the handover is recorded: from Kiran to Divya, by hand, with the reason', hos.length === 1 && hos[0].from === kiran.name && hos[0].to === divya.name && hos[0].kind === 'handed over by hand' && hos[0].reason === 'Kiran resigned', hos);

  // Divya does the joining today
  await prisma.application.update({ where: { id: app.id }, data: { stage: 'JOINED', joiningDate: istToday(), joiningStatus: 'Joined' } });
  await ev('OFFER_ACCEPTED', 'JOINED', Date.now() - 60000, divya);

  console.log('The credit');
  const dir = await W.loadDirectory();
  const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } });
  const fus = await prisma.applicationFollowUp.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } });
  const attrReq = { recruiterId: kiran.id };
  const jc = W.joinCredit(attrReq, fus, evs, dir.person, `${istToday()}T23:59:59+05:30`, hos);
  check('the joining counts for Kiran, who got them Selected', jc && jc.userId === kiran.id, jc);
  const without = W.creditAt(attrReq, fus, evs, dir.person, new Date(t0 + 4 * DAY + 1000).toISOString());
  check('(without the handover record the moved task would have given it to Divya - the bug this fixes)', without && without.userId === divya.id, without);
  check('sourced by Kiran', (W.sourcedBy(attrReq, fus, evs, dir.person, hos) || {}).userId === kiran.id);

  console.log('Every screen agrees');
  const page = await call('GET', `/candidates/${cand.id}`, null, hr);
  const own = page.body && (page.body.applications || []).find((x) => x.id === app.id);
  const o = own && own.ownership;
  check('the candidate page: sourced by Kiran, with Divya now, selected by Kiran, joining credit Kiran, one handover', !!o && o.sourcedBy === kiran.name && o.currentlyWith && o.currentlyWith.startsWith(divya.name) && o.selectedBy === kiran.name && o.joiningCredit === kiran.name && o.handovers.length === 1, o || page.status);
  const RJ = require('../src/utils/recruiterJoinings');
  const month = await RJ.monthApplications(istToday().slice(0, 7), { fresh: true });
  const row = month.apps.find((x) => x.id === app.id);
  check('Recruiter Joinings (incentives): the joining is Kiran\'s', row && row.recruiterUserId === kiran.id, row && { r: row.recruiterName });
  const home = await require('../src/utils/atsHome').buildHome({ ...admin }, { query: { range: 'this_month', fresh: '1' }, headers: {} });
  const x = home.world.byId.get(app.id);
  check('the dashboard: the Joined row is under Kiran', x && x.who.recruiter && x.who.recruiter.userId === kiran.id, x && x.who.recruiter);

  console.log('Joined candidates are never handed over');
  check('a handover by hand skips a Joined candidate', (await H.moveOwner({ apps: [{ ...a2, stage: 'JOINED' }], to: { id: third.id, name: third.name } })).length === 0);
  const cand2 = await prisma.candidate.create({ data: { name: 'Handover Test Second', email: `ho2-${process.pid}@candidate.test`, phone: `97${String(process.pid).padStart(8, '0').slice(-8)}` } });
  const app2 = await prisma.application.create({ data: { candidateId: cand2.id, requirementId: req.id, stage: 'NEW', ownerRecruiterId: third.id } });
  await prisma.application.update({ where: { id: app.id }, data: { ownerRecruiterId: third.id } }); // a Joined candidate of a recruiter who is not on the job
  const n = await H.toDefaultOwner(await prisma.requirement.findUnique({ where: { id: req.id } }), { id: admin.id, name: admin.name });
  check('a recruiter taken off the requirement: the live candidate goes to the main recruiter, recorded', n >= 1 && (await prisma.application.findUnique({ where: { id: app2.id } })).ownerRecruiterId === kiran.id && ((await H.handoversFor([app2.id])).get(app2.id) || [])[0].kind === 'taken off the requirement');
  check('... and the Joined one stays where it was', (await prisma.application.findUnique({ where: { id: app.id } })).ownerRecruiterId === third.id);

  const hist = await call('GET', '/ats/handover/history', null, hr);
  check('the history lists both handovers, the way each happened', hist.status === 200 && hist.body.rows.some((r) => r.how === 'By hand' && r.from === kiran.name && r.to === divya.name && r.count >= 1) && hist.body.rows.some((r) => r.how === 'Taken off the requirement'), hist.body && hist.body.rows && hist.body.rows.slice(0, 3));

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await stop(1); });
