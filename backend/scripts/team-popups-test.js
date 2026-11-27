#!/usr/bin/env node
/**
 * TEAM POP-UPS (utils/teamPopups.js, founder 2026-11-27): every ATS change pops up for everyone concerned - new candidate on a job, step move,
 * interview, joined, rejected, a bulk move as ONE pop-up, new requirement, new client; the person who made it is not told; no mail by default;
 * nothing when the step did not really change. On a COPY of a database; the server answers GET /api/ats-updates/popups for the recruiter.
 *   TEST_SOURCE_DB=<a .db file> [TEST_PORT=4680] node scripts/team-popups-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-team-popups-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4680;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', TEAM_POPUPS: 'on', TEAM_POPUPS_WAIT_MS: '60000', PORT: String(PORT), JWT_SECRET: 'team-popups-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'team-popups-key' };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const TP = require('../src/utils/teamPopups');
const U = require('../src/utils/atsUpdates');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 460)}` : ''}`); } };
const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const eventsOf = async (type) => q('SELECT * FROM "AtsUpdateEvent" WHERE "type" = ? ORDER BY "createdAt" DESC', type);
const told = async (eventId) => (await q('SELECT "userId", "roles", "popup", "mail" FROM "AtsUpdateRecipient" WHERE "eventId" = ?', eventId));

(async () => {
  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  // a live requirement with a recruiter, a TL and a client BDE, and three candidates not on it yet
  // a job with a TL; an active recruiter of its department is put on it (this is a copy)
  const reqs = await prisma.requirement.findMany({ where: { tlId: { not: null }, client: { bdeOwner: { not: null } } }, include: { client: true }, take: 80, orderBy: { createdAt: 'desc' } });
  let req = null; let recruiter = null;
  for (const r of reqs) {
    const tl = await prisma.user.findFirst({ where: { id: r.tlId, status: 'Active' } }); // eslint-disable-line no-await-in-loop
    if (!tl || tl.id === admin.id) continue; // eslint-disable-line no-continue
    const u = await prisma.user.findFirst({ where: { status: 'Active', atsRole: 'RECRUITER', ...(r.department ? { atsDepartment: r.department } : {}) } }); // eslint-disable-line no-await-in-loop
    if (u) { req = await prisma.requirement.update({ where: { id: r.id }, data: { recruiterId: u.id, recruiterIds: u.id, status: 'OPEN' }, include: { client: true } }); recruiter = u; break; } // eslint-disable-line no-await-in-loop
  }
  if (!req) throw new Error('no requirement with an active TL and a recruiter of its department on the copy');
  const cands = await prisma.candidate.findMany({ where: { applications: { none: { requirementId: req.id } } }, take: 5, select: { id: true, name: true } });
  await prisma.user.update({ where: { id: recruiter.id }, data: { passwordChangedAt: new Date(), passwordResetRequired: false } }).catch(() => {});
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop

  TP.enter(admin); // the Super Admin makes the changes
  console.log('1. A new candidate on the job');
  const a1 = await prisma.application.create({ data: { candidateId: cands[0].id, requirementId: req.id } });
  await TP.flushAll();
  const e1 = (await eventsOf('team_candidate'))[0];
  const r1 = e1 ? await told(e1.id) : [];
  check('one pop-up "New candidate: <name>" on the job', e1 && e1.title === `New candidate: ${cands[0].name}` && e1.summary.includes(req.title), e1);
  check('the job\'s recruiter and TL are told', r1.some((r) => r.userId === recruiter.id) && r1.some((r) => r.userId === req.tlId), r1.map((r) => r.roles));
  check('the client\'s BDE is told (when in their area)', r1.some((r) => /Client BDE/.test(r.roles)) || !(await prisma.user.findFirst({ where: { id: req.client.bdeOwner, status: 'Active' } })), r1.map((r) => r.roles));
  check('the Super Admin who made it is NOT told', !r1.some((r) => r.userId === admin.id));
  check('pop-up on, no mail by default', r1.length > 0 && r1.every((r) => r.popup === 1 || r.popup === 1n) && r1.every((r) => r.mail === 'off'), r1.slice(0, 3));
  check('the bell has it too', (await prisma.notification.count({ where: { recipient: `cu|${e1.id}` } })) === r1.length);

  console.log('2. Step moves');
  await prisma.application.update({ where: { id: a1.id }, data: { stage: 'SHARED_WITH_CLIENT' } });
  await TP.flushAll();
  const m1 = (await eventsOf('team_move'))[0];
  check('"<name> → Sent to client"', m1 && m1.title === `${cands[0].name} → Sent to client`, m1 && m1.title);
  await prisma.application.update({ where: { id: a1.id }, data: { stage: 'SHARED_WITH_CLIENT' } });
  const n0 = (await eventsOf('team_move')).length;
  await TP.flushAll();
  check('the same step again tells nobody', (await eventsOf('team_move')).length === n0);
  await prisma.application.update({ where: { id: a1.id }, data: { stage: 'INTERVIEW_SCHEDULED', interviewAt: new Date(Date.now() + 86400000), interviewMode: 'Online' } });
  await TP.flushAll();
  const iv = await eventsOf('team_interview');
  check('interview booked: ONE pop-up with the time', iv.length === 1 && iv[0].title === `Interview: ${cands[0].name}` && /Online/.test(iv[0].summary), iv.map((e) => [e.title, e.summary]));
  await prisma.application.update({ where: { id: a1.id }, data: { stage: 'JOINED', joiningStatus: 'Joined', joinedAt: new Date() } });
  await TP.flushAll();
  const jn = await eventsOf('team_joined');
  check('joined: ONE pop-up (step and joining status together)', jn.length === 1 && jn[0].title.startsWith(`Joined: ${cands[0].name}`), jn.map((e) => e.title));
  const a2 = await prisma.application.create({ data: { candidateId: cands[1].id, requirementId: req.id } });
  await TP.flushAll();
  await prisma.application.update({ where: { id: a2.id }, data: { stage: 'REJECTED' } });
  await TP.flushAll();
  check('rejected', (await eventsOf('team_rejected'))[0].title === `Rejected: ${cands[1].name}`);

  console.log('3. A burst is one pop-up');
  const more = [];
  for (const c of cands.slice(2, 5)) more.push(await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id } })); // eslint-disable-line no-await-in-loop
  await TP.flushAll();
  const burst = (await eventsOf('team_candidate'))[0];
  check('3 new candidates at once: ONE pop-up "3 new candidates on <job>"', burst && burst.title === `3 new candidates on ${req.reqCode || req.title}`, burst && burst.title);
  await prisma.application.updateMany({ where: { id: { in: more.map((m) => m.id) } }, data: { stage: 'HOLD' } });
  await TP.flushAll();
  check('a bulk move of 3: ONE pop-up "3 people → Hold"', (await eventsOf('team_move'))[0].title === '3 people → Hold', (await eventsOf('team_move'))[0].title);

  console.log('4. New requirement, new client');
  const nr = await prisma.requirement.create({ data: { title: `ZZ Popup Job ${process.pid}`, clientId: req.clientId, tlId: req.tlId, recruiterId: recruiter.id, department: req.department } });
  await TP.flushAll();
  const re = (await eventsOf('team_requirement'))[0];
  check('new requirement: told to its recruiter', re && re.title.includes(`ZZ Popup Job ${process.pid}`) && (await told(re.id)).some((r) => r.userId === recruiter.id), re && re.title);
  const nc = await prisma.client.create({ data: { name: `ZZ Popup Client ${process.pid}` } });
  await TP.flushAll();
  const ce = (await eventsOf('team_client'))[0];
  const cr = ce ? await told(ce.id) : [];
  check('new client: told to the Admins / BDE TLs, not to a recruiter', ce && ce.title === `New client: ZZ Popup Client ${process.pid}` && cr.length > 0 && !cr.some((r) => r.userId === recruiter.id), cr.map((r) => r.roles));
  const mk = await prisma.client.create({ data: { name: `ZZ Marketing Only ${process.pid}`, marketingOnly: true } });
  await TP.flushAll();
  check('a marketing-only company is not a new ATS client', !(await eventsOf('team_client')).some((e) => e.clientId === mk.id));
  void nr; void nc;

  console.log('5. On the recruiter\'s screen');
  const tok = jwt.sign({ ...tokenPayload(await resolveIdentity(recruiter.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const pop = await fetch(`${API}/ats-updates/popups`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
  const kinds = new Set((Array.isArray(pop) ? pop : []).map((p) => p.type));
  check('the recruiter\'s pop-ups have the joining, the rejection, the interview and the new candidates', ['team_joined', 'team_rejected', 'team_interview', 'team_candidate'].every((k) => kinds.has(k)), [...kinds]);
  const jp = pop.find((p) => p.type === 'team_joined');
  check('each says what kind it is and opens the candidate', jp && jp.typeLabel === 'Candidate joined' && jp.open === `/candidates/${cands[0].id}` && /By /.test(`By ${jp.by}`) && jp.by === admin.name, jp);
  const st = await U.settings();
  check('Administration > Client updates lists the 7 team kinds, pop-up on and mail off', ['team_candidate', 'team_requirement', 'team_client', 'team_interview', 'team_joined', 'team_rejected', 'team_move'].every((k) => st.types[k] && st.types[k].popup && !st.types[k].mail));
  check('the client kinds keep their mail on', st.types.client_feedback.mail === true);
  process.env.TEAM_POPUPS = 'off';
  check('switched off (tests): nothing is watched', TP.watches({ model: 'Application', action: 'create', args: {} }) === false);
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log(`FAIL  crashed: ${e.stack || e.message}`); await stop(1); });
