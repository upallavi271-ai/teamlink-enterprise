#!/usr/bin/env node
/**
 * JOININGS: CARD = LIST = REPORT (audit Checklist-120 #106, Practical P10.8, Extra 820; 2026-11-17).
 * A recruiter's "My joinings this month" card, the list it opens, My results / the Team & person report ("Joined") and the HRMS
 * "3 of 4" figure must be the same number, also for joinings credited BY NAME (an imported follow-up that names the recruiter but
 * has no login on it) on a job outside the recruiter's own seat, and for a TL over both recruiters ("My team's joinings").
 * They all read utils/recruiterJoinings.js creditedJoinings().
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port TEST_PORT (default 4142).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/joinings-count-match-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-joincount-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4142;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'joincount-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { applicationWhere } = require('../src/utils/scope');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
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
const IST = 330 * 60000;
const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const lastDay = (() => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; })();
const prevMonthDay = (() => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 10)); return d.toISOString().slice(0, 10); })();
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

(async () => {
  const past = new Date(Date.now() - 3600e3);
  const mkUser = (tag, atsRole, role) => prisma.user.create({
    data: {
      name: `Jcm ${tag} ${P}`, email: `jcm.${tag.toLowerCase()}.${P}@jcm-test.in`, passwordHash: 'x', status: 'Active', role, atsRole, atsDepartment: 'IT', atsAccess: true, passwordChangedAt: past,
      ...(atsRole === 'TL' ? { atsScopeDepartments: 'IT' } : {}),
    },
  });
  const R1 = await mkUser('Alpha', 'RECRUITER', 'EMPLOYEE');
  const R2 = await mkUser('Beta', 'RECRUITER', 'EMPLOYEE');
  const TL = await mkUser('Lead', 'TL', 'TL');
  const mkEmp = (u, code) => prisma.employee.create({ data: { employeeCode: `JCM-${code}-${P}`, name: u.name, userId: u.id, department: 'IT', employmentStatus: 'Active', dateOfJoining: new Date('2020-01-01T00:00:00Z') } });
  const [E1, E2, ET] = [await mkEmp(R1, 'R1'), await mkEmp(R2, 'R2'), await mkEmp(TL, 'TL')];
  const tlSeat = await prisma.position.create({ data: { code: `JCM-TL-${P}`, kind: 'TL', department: 'IT', team: `Jcm team ${P}` } });
  const s1 = await prisma.position.create({ data: { code: `JCM-R1-${P}`, kind: 'RECRUITER', department: 'IT', team: `Jcm team ${P}`, reportsToId: tlSeat.id } });
  const s2 = await prisma.position.create({ data: { code: `JCM-R2-${P}`, kind: 'RECRUITER', department: 'IT', team: `Jcm team ${P}`, reportsToId: tlSeat.id } });
  for (const [pos, e] of [[tlSeat, ET], [s1, E1], [s2, E2]]) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.create({ data: { positionId: pos.id, employeeId: e.id, fromDate: '2025-01-01' } });
  }
  const client = await prisma.client.findFirst({ where: { NOT: { name: { contains: 'zztest' } } }, select: { id: true } });
  const mkReq = (tag, data) => prisma.requirement.create({ data: { title: `Jcm job ${tag} ${P}`, clientId: client.id, status: 'OPEN', department: 'IT', ...data } });
  const J1 = await mkReq('one', { recruiterId: R1.id, tlId: TL.id });
  const J2 = await mkReq('two', { recruiterId: R2.id, tlId: TL.id });
  const J3 = await mkReq('three (imported, no recruiter)', {});
  const J4 = await mkReq('four (imported, no recruiter)', {});
  let n = 0;
  const mkApp = async (req, stage, joiningDate, fu) => {
    n += 1;
    const c = await prisma.candidate.create({ data: { name: `Jcm Person ${n} ${P}`, phone: `6${String(P * 10 + n).padStart(9, '3').slice(-9)}` } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, joiningDate } });
    if (fu) await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: c.id, ownerRole: 'Recruiter', nextAction: 'Joining formalities', dueDate: today, ...fu } });
    return a;
  };
  // R1: one on their own job, one credited BY NAME (an imported follow-up with the name in capitals, no login) on a job with no recruiter
  const A1 = await mkApp(J1, 'JOINED', today, null);
  const A2 = await mkApp(J3, 'JOINED', today, { ownerName: R1.name.toUpperCase() });
  // R2: one on their own job, one credited by name on another unassigned job, and one on R1's JOB that R2 worked (their follow-up)
  const A3 = await mkApp(J2, 'JOINED', today, null);
  const A4 = await mkApp(J4, 'JOINED', `${today}T10:00:00`, { ownerName: `  ${R2.name.toLowerCase()} ` });
  const A5 = await mkApp(J1, 'JOINED', today, { ownerUserId: R2.id, ownerName: R2.name });
  // never counted this month: joined last month; selected (not joined) with a joining date today
  await mkApp(J2, 'JOINED', prevMonthDay, null);
  await mkApp(J1, 'SELECTED', today, null);
  // R1 brought and owns this one; the TEAM LEAD marked it Selected and Joined for the client (and owns the joining task
  // afterwards): it is still R1's joining, never the lead's
  const A6 = await mkApp(J1, 'JOINED', today, { ownerUserId: R1.id, ownerName: R1.name, createdAt: new Date(Date.now() - 3 * 3600e3) });
  const c6 = (await prisma.application.findUnique({ where: { id: A6.id } })).candidateId;
  await prisma.applicationStageEvent.create({ data: { applicationId: A6.id, candidateId: c6, fromStage: 'NEW', toStage: 'RECRUITER_REVIEW', action: 'Moved', actorUserId: R1.id, actorName: R1.name, actorRole: 'RECRUITER', createdAt: new Date(Date.now() - 3 * 3600e3) } });
  await prisma.applicationStageEvent.create({ data: { applicationId: A6.id, candidateId: c6, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED', action: 'Moved to Selected', actorUserId: TL.id, actorName: TL.name, actorRole: 'TL', createdAt: new Date(Date.now() - 2 * 3600e3) } });
  await prisma.applicationFollowUp.create({ data: { applicationId: A6.id, candidateId: c6, ownerUserId: TL.id, ownerName: TL.name, ownerRole: 'TL', nextAction: 'Joining formalities', dueDate: today, createdAt: new Date(Date.now() - 2 * 3600e3) } });
  await prisma.applicationStageEvent.create({ data: { applicationId: A6.id, candidateId: c6, fromStage: 'SELECTED', toStage: 'JOINED', action: 'Joined', actorUserId: TL.id, actorName: TL.name, actorRole: 'TL', createdAt: new Date(Date.now() - 3600e3) } });
  const want = { R1: [A1.id, A2.id, A6.id], R2: [A3.id, A4.id, A5.id] };
  want.TL = [...want.R1, ...want.R2];

  // the case that broke: the name-credited joining is outside the recruiter's own scope
  const ident1 = await resolveIdentity(R1.id);
  const inScope = await prisma.application.count({ where: { AND: [{ id: { in: [A2.id] } }, applicationWhere(ident1)] } });
  check('setup: R1\'s name-credited joining sits outside R1\'s own scope', inScope === 0, { inScope });

  // in-process: the one function
  const RJ = require('../src/utils/recruiterJoinings'); // eslint-disable-line global-require
  const cj = {};
  for (const [k, u] of [['R1', R1], ['R2', R2], ['TL', TL]]) {
    // eslint-disable-next-line no-await-in-loop
    cj[k] = await RJ.creditedJoinings(await resolveIdentity(u.id), { month, fresh: true });
  }
  check('creditedJoinings: R1 = own job + name-credited + the one the TL marked Selected / Joined', same(cj.R1.appIds, want.R1) && cj.R1.level === 'self', { got: cj.R1.appIds, want: want.R1 });
  check('creditedJoinings: R2 = own job + name-credited + R1\'s job that R2 worked', same(cj.R2.appIds, want.R2), { got: cj.R2.appIds, want: want.R2 });
  check('creditedJoinings: the TL = both recruiters', same(cj.TL.appIds, want.TL) && cj.TL.level === 'team', { got: cj.TL.appIds, level: cj.TL.level });
  check('a TL who marks Selected / Joined for the client does not take the joining of the recruiter', !cj.TL.list.some((x) => x.id === A6.id && x.creditedTo.userId === TL.id) && cj.R1.list.some((x) => x.id === A6.id && x.creditedTo.userId === R1.id));
  // a TEST login (the automated tests) reads its own test joinings; a real login never sees them (the reports' rule)
  const RZ = await prisma.user.create({ data: { name: `ZZTEST Jcm rec ${P}`, email: `zz-jcm-rec-${P}@example.test`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsAccess: true, passwordChangedAt: past } });
  await prisma.employee.create({ data: { employeeCode: `JCM-RZ-${P}`, name: RZ.name, userId: RZ.id, department: 'IT', employmentStatus: 'Active', dateOfJoining: new Date('2020-01-01T00:00:00Z') } });
  const JZ = await mkReq('zz', { recruiterId: RZ.id });
  const AZ = await mkApp(JZ, 'JOINED', today, null);
  const cz = await RJ.creditedJoinings(await resolveIdentity(RZ.id), { month, fresh: true });
  check('a test recruiter login sees its own test joining', same(cz.appIds, [AZ.id]), cz.appIds);
  const realBoard = await RJ.monthBoard(month, { fresh: true });
  check('...and the real HRMS board never lists the test recruiter', !realBoard.rows.some((r) => r.userId === RZ.id));
  const r1Range = await RJ.creditedJoinings(await resolveIdentity(R1.id), { from: today, to: today });
  check('creditedJoinings: a one-day range gives the same R1 rows', same(r1Range.appIds, want.R1), r1Range.appIds);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = { R1: await tok(R1.id), R2: await tok(R2.id), TL: await tok(TL.id) };

  for (const who of ['R1', 'R2', 'TL']) {
    const t = T[who];
    const expect = want[who].length;
    // eslint-disable-next-line no-await-in-loop
    const home = await call('GET', '/dashboard/ats/home?fresh=1', null, t);
    const card = who === 'TL'
      ? (home.body && (home.body.top || []).find((x) => x.id === 'my-joins'))
      : (home.body && (home.body.widgets || []).find((x) => x.id === 'target'));
    const cardValue = card ? card.value : null;
    check(`${who}: the dashboard card shows ${expect}`, home.status === 200 && cardValue === expect, { status: home.status, layout: home.body && home.body.layout, card, err: home.body && home.body.error });
    // eslint-disable-next-line no-await-in-loop
    const list = await call('GET', '/dashboard/ats/home/list?set=my-joins&d_size=200', null, t);
    const listIds = list.body && list.body.rows ? list.body.rows.map((r) => r.id) : [];
    check(`${who}: the list the card opens has the same ${expect} people`, list.status === 200 && list.body.total === cardValue && same(listIds, want[who]), { status: list.status, total: list.body && list.body.total, listIds, want: want[who], err: list.body && list.body.error });
    // eslint-disable-next-line no-await-in-loop
    const rep = await call('GET', '/ats-report-pack/report?report=summary&range=this_month', null, t);
    const col = rep.body && rep.body.columns ? rep.body.columns.findIndex((c) => c.key === 'joined') : -1;
    const repValue = col >= 0 && rep.body.total ? rep.body.total[col] : null;
    check(`${who}: My results / Team & person report "Joined" = ${expect}`, rep.status === 200 && repValue === cardValue, { status: rep.status, repValue, err: rep.body && rep.body.error, view: rep.body && rep.body.view });
    // eslint-disable-next-line no-await-in-loop
    const daily = await call('GET', `/ats-report-pack/report?report=joined&range=custom&from=${month}-01&to=${lastDay}`, null, t);
    const dcol = daily.body && daily.body.columns ? daily.body.columns.length - 1 : -1;
    const dValue = dcol >= 0 && daily.body.total ? daily.body.total[dcol] : null;
    check(`${who}: the "Joined" report for this month's dates = ${expect}`, daily.status === 200 && dValue === cardValue, { status: daily.status, dValue, err: daily.body && daily.body.error });
    // eslint-disable-next-line no-await-in-loop
    const my = await call('GET', `/ats-reports/my-results?from=${month}-01&to=${lastDay}`, null, t);
    if (my.status === 200) {
      const j = (my.body.cards || []).find((c) => c.key === 'joined');
      check(`${who}: GET /ats-reports/my-results "Joined" = ${expect}`, j && j.value === cardValue, my.body);
    } else check(`${who}: /ats-reports/my-results answers (or is not part of the role)`, my.status === 403, my);
    if (who !== 'TL') {
      // eslint-disable-next-line no-await-in-loop
      const mine = await call('GET', '/recruiter-joinings/mine', null, t);
      check(`${who}: the HRMS "3 of 4" figure = ${expect}`, mine.status === 200 && mine.body.achieved === cardValue, mine.body);
    }
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
