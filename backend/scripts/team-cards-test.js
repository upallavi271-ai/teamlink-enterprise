#!/usr/bin/env node
/**
 * ONE JOININGS CARD PER TEAM (founder 2026-11-20): a department whose seats are split into teams (Education Team A / Team B) shows
 * "Team A joinings" and "Team B joinings" on the My Team dashboard of BOTH team leads (and the STL); the single "My team's joinings"
 * card stays for a department with one team. utils/teamJoinCards.js on utils/recruiterJoinings.js creditedJoinings.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port TEST_PORT (default 4271).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4271 node scripts/team-cards-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-teamcards-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4271;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'teamcards-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const JD = require('../src/joindrop/core');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token, raw = false) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
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
const lastMonthDay = (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10); })();
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

(async () => {
  const past = new Date(Date.now() - 3600e3);
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const DEP = `Tc Section ${P}`; // two teams
  const DEP1 = `Tc Single ${P}`; // one team
  const mkUser = (tag, atsRole, role, dept) => prisma.user.create({
    data: {
      name: `Tcd ${tag} ${P}`, email: `tcd.${tag.toLowerCase()}.${P}@tcd-test.in`, passwordHash: 'x', status: 'Active', role, atsRole, atsDepartment: dept, atsAccess: true, passwordChangedAt: past,
      ...(['TL', 'STL'].includes(atsRole) ? { atsScopeDepartments: dept } : {}),
    },
  });
  const mkEmp = (u, code, dept) => prisma.employee.create({ data: { employeeCode: `TCD-${code}-${P}`, name: u.name, userId: u.id, department: dept, employmentStatus: 'Active', dateOfJoining: new Date('2020-01-01T00:00:00Z') } });
  const U = {
    STL: await mkUser('Stl', 'STL', 'EMPLOYEE', DEP),
    TL1: await mkUser('TlOne', 'TL', 'TL', DEP), TL2: await mkUser('TlTwo', 'TL', 'TL', DEP),
    R1a: await mkUser('RecA1', 'RECRUITER', 'EMPLOYEE', DEP), R1b: await mkUser('RecA2', 'RECRUITER', 'EMPLOYEE', DEP),
    R2a: await mkUser('RecB1', 'RECRUITER', 'EMPLOYEE', DEP), R2b: await mkUser('RecB2', 'RECRUITER', 'EMPLOYEE', DEP),
    TL3: await mkUser('TlSolo', 'TL', 'TL', DEP1), R3: await mkUser('RecSolo', 'RECRUITER', 'EMPLOYEE', DEP1),
    BDE: await mkUser('Bde', 'BDE', 'EMPLOYEE', 'BDE'),
  };
  const E = {};
  for (const [k, dept] of [['STL', DEP], ['TL1', DEP], ['TL2', DEP], ['R1a', DEP], ['R1b', DEP], ['R2a', DEP], ['R2b', DEP], ['TL3', DEP1], ['R3', DEP1]]) {
    // eslint-disable-next-line no-await-in-loop
    E[k] = await mkEmp(U[k], k, dept);
  }
  const seat = (code, kind, dept, team, reportsToId) => prisma.position.create({ data: { code: `TCD-${code}-${P}`, kind, department: dept, team, reportsToId: reportsToId || null } });
  const S = {};
  S.STL = await seat('STL', 'STL', DEP, null);
  S.TL1 = await seat('TL1', 'TL', DEP, 'Team A', S.STL.id); S.TL2 = await seat('TL2', 'TL', DEP, 'Team B', S.STL.id);
  S.R1a = await seat('R1a', 'RECRUITER', DEP, 'Team A', S.TL1.id); S.R1b = await seat('R1b', 'RECRUITER', DEP, 'Team A', S.TL1.id);
  S.R2a = await seat('R2a', 'RECRUITER', DEP, 'Team B', S.TL2.id); S.R2b = await seat('R2b', 'RECRUITER', DEP, 'Team B', S.TL2.id);
  S.TL3 = await seat('TL3', 'TL', DEP1, 'Team', null); S.R3 = await seat('R3', 'RECRUITER', DEP1, 'Team', S.TL3.id);
  for (const k of Object.keys(S)) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.create({ data: { positionId: S[k].id, employeeId: E[k].id, fromDate: '2025-01-01' } });
  }
  const client = await prisma.client.findFirst({ where: { NOT: { name: { contains: 'zztest' } } }, select: { id: true, name: true } });
  const client2 = await prisma.client.findFirst({ where: { NOT: { OR: [{ name: { contains: 'zztest' } }, { id: client.id }] } }, select: { id: true } });
  const mkReq = (rec, tl, dept, tag, clientId) => prisma.requirement.create({ data: { title: `Tcd job ${tag} ${P}`, clientId: clientId || client.id, status: 'OPEN', department: dept, recruiterId: U[rec].id, tlId: U[tl].id } });
  const J = {
    R1a: await mkReq('R1a', 'TL1', DEP, 'a1'), R1b: await mkReq('R1b', 'TL1', DEP, 'a2'), R2a: await mkReq('R2a', 'TL2', DEP, 'b1'), R2b: await mkReq('R2b', 'TL2', DEP, 'b2', client2 && client2.id), R3: await mkReq('R3', 'TL3', DEP1, 's1'),
  };
  let n = 0;
  const people = {}; // application id -> { name, phone, email }
  const mkJoin = async (rec, day) => {
    n += 1;
    const phone = `6${String(P * 10 + n).padStart(9, '7').slice(-9)}`;
    const email = `tcd.person.${n}.${P}@tcd-test.in`;
    const c = await prisma.candidate.create({ data: { name: `Tcd Person ${n} ${P}`, phone, email } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: J[rec].id, stage: 'JOINED', joiningDate: day, joinedAt: new Date(), offeredCtc: 345678 } });
    await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: c.id, ownerUserId: U[rec].id, ownerName: U[rec].name, ownerRole: 'Recruiter', nextAction: 'Joining formalities', dueDate: today } });
    people[a.id] = { name: c.name, phone, email };
    return a.id;
  };
  // this month: Team A 3 (R1a 2, R1b 1), Team B 2 still working (R2a 1, R2b 1) + one joined and LEFT (R2a); last month: A 1, B 2
  const A = { now: [await mkJoin('R1a', today), await mkJoin('R1a', today), await mkJoin('R1b', today)], before: [await mkJoin('R1a', lastMonthDay)] };
  const B = { now: [await mkJoin('R2a', today), await mkJoin('R2b', today)], before: [await mkJoin('R2a', lastMonthDay), await mkJoin('R2b', lastMonthDay)] };
  const leaver = await mkJoin('R2a', today);
  const solo = await mkJoin('R3', today);
  await JD.ready();
  for (const id of [...A.now, ...A.before, ...B.now, ...B.before, leaver, solo]) {
    // eslint-disable-next-line no-await-in-loop
    await JD.recordJoined({ applicationId: id, backfill: true, quiet: true });
  }

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const k of Object.keys(U)) {
    // eslint-disable-next-line no-await-in-loop
    T[k] = await tok(U[k].id);
  }
  const TA = await tok(adminRow.id);

  // the person who joined this month in Team B and then left
  const rec = await JD.byApplication(leaver);
  const meta = await call('GET', '/join-drop/meta', null, TA);
  const reason = meta.body && meta.body.reasons && meta.body.reasons[0];
  const dr = await call('POST', `/join-drop/${rec.id}/drop`, { droppedOn: today, reason, reasonDetail: 'team cards test' }, TA);
  check('setup: a Team B person who joined this month then left (drop recorded)', dr.status === 200 && dr.body && dr.body.ok, dr);

  const home = (who, q = '', token = T[who]) => call('GET', `/dashboard/ats/home?fresh=1${q}`, null, token);
  const cardsOf = (h) => ((h.body && h.body.top) || []).filter((t) => t.teamJoin);
  const valOf = (cards, label) => { const c = cards.find((x) => x.label === label); return c ? c.value : null; };
  const listOf = async (who, id, q = '', token = T[who]) => call('GET', `/dashboard/ats/home/list?set=${id}&d_size=200${q}`, null, token);
  const SAFE = ['id', 'candidate', 'requirement', 'reqCode', 'client', 'recruiter', 'joiningDate'];

  // ---- TL1 (Team A), TL2 (Team B), STL: both cards
  const h1 = await home('TL1'); const c1 = cardsOf(h1);
  const h2 = await home('TL2'); const c2 = cardsOf(h2);
  const hS = await home('STL'); const cS = cardsOf(hS);
  check('1 TL1: two cards, "Team A joinings" and "Team B joinings"', h1.status === 200 && c1.length === 2 && c1.some((c) => c.label === 'Team A joinings') && c1.some((c) => c.label === 'Team B joinings'), { st: h1.status, c1: c1.map((c) => c.label), top: ((h1.body && h1.body.top) || []).map((t) => t.id), err: h1.body && h1.body.error });
  check('2 TL1: Team A = 3, Team B = 2 (the person who left is not counted)', valOf(c1, 'Team A joinings') === 3 && valOf(c1, 'Team B joinings') === 2, c1.map((c) => [c.label, c.value]));
  check('3 TL2: the same numbers, A = 3 and B = 2', valOf(c2, 'Team A joinings') === 3 && valOf(c2, 'Team B joinings') === 2, c2.map((c) => [c.label, c.value]));
  check('4 STL: the same two cards and numbers', cS.length === 2 && valOf(cS, 'Team A joinings') === 3 && valOf(cS, 'Team B joinings') === 2, cS.map((c) => [c.label, c.value]));
  check('5 the old single "My team\'s joinings" card is gone for the two-team department', !((h1.body.top || []).some((t) => t.id === 'my-joins')) && !((h2.body.top || []).some((t) => t.id === 'my-joins')));
  check('6 the own team is first and marked: TL1 sees Team A first "your team", TL2 sees Team B first; the STL has no own team', c1[0].label === 'Team A joinings' && c1[0].mine === true && c1[1].mine === false && c2[0].label === 'Team B joinings' && c2[0].mine === true && cS.every((c) => !c.mine) && cS[0].label === 'Team A joinings', { c1: c1.map((c) => [c.label, c.mine]), c2: c2.map((c) => [c.label, c.mine]) });
  // A + B = the department's joinings (the month board, the one count)
  const RJ = require('../src/utils/recruiterJoinings'); // eslint-disable-line global-require
  const board = await RJ.monthBoard(month, { fresh: true });
  const deptTotal = board.rows.filter((r) => r.department === DEP).reduce((s, r) => s + r.joinings, 0);
  check('7 Team A + Team B = the department\'s joinings this month (month board)', deptTotal === 5 && valOf(c1, 'Team A joinings') + valOf(c1, 'Team B joinings') === deptTotal, { deptTotal });
  const dx = (c1.find((c) => c.label === 'Team A joinings') || {}).delta; const dy = (c1.find((c) => c.label === 'Team B joinings') || {}).delta;
  check('8 each card carries the comparison with last month (A: 1 before, B: 2 before)', dx && dx.prev === 1 && dx.dir === 'up' && dy && dy.prev === 2 && dy.dir === 'same', { dx, dy });
  const cardB = c1.find((c) => c.label === 'Team B joinings');
  check('9 Team B says "Still working: 2 · left after joining: 1"; Team A has no such line', cardB.stillWorking === 2 && cardB.left && cardB.left.n === 1 && !c1.find((c) => c.label === 'Team A joinings').left, { b: cardB });

  // ---- the lists
  const idA = c1.find((c) => c.label === 'Team A joinings').drill; const idB = cardB.drill;
  const lA = await listOf('TL1', idA); const lB = await listOf('TL1', idB);
  check('10 the Team A list holds exactly the 3 Team A people', lA.status === 200 && lA.body.total === 3 && same(lA.body.rows.map((r) => r.id), A.now), { st: lA.status, rows: lA.body && lA.body.rows && lA.body.rows.map((r) => r.id), want: A.now });
  check('11 the Team B list holds exactly the 2 Team B people who are still working', lB.status === 200 && lB.body.total === 2 && same(lB.body.rows.map((r) => r.id), B.now) && !lB.body.rows.some((r) => r.id === leaver), lB.body && lB.body.rows && lB.body.rows.map((r) => r.id));
  check('11b the list ids are the same in every lead login (team-joins-team-a / -b)', idA === 'team-joins-team-a' && idB === 'team-joins-team-b' && c2.find((c) => c.label === 'Team B joinings').drill === idB, { idA, idB });
  const lB2 = await listOf('TL2', idB); const lA2 = await listOf('TL2', idA);
  check('12 both TLs read both teams\' lists (TL1 opened Team B, TL2 opened Team A)', lB2.status === 200 && same(lB2.body.rows.map((r) => r.id), B.now) && lA2.status === 200 && same(lA2.body.rows.map((r) => r.id), A.now), { lB2: lB2.status, lA2: lA2.status });
  const keys = new Set([...lA.body.rows, ...lB.body.rows].flatMap((r) => Object.keys(r)));
  check('13 the lists carry only the safe columns (candidate, requirement, client, recruiter, joining date)', [...keys].every((k) => SAFE.includes(k)) && lA.body.rows.every((r) => r.candidate && r.requirement && r.client && r.recruiter && r.joiningDate), { keys: [...keys] });
  const blob = JSON.stringify([lA.body, lB.body]);
  const leaks = Object.values(people).filter((p) => blob.includes(p.phone) || blob.includes(p.email) || blob.includes('345678'));
  check('14 no phone, email or pay appears anywhere in the lists', leaks.length === 0 && !/resume|ctc|salary|phone|email/i.test(Object.keys(lA.body.rows[0] || {}).join(',')), { leaks: leaks.length });
  check('15 the recruiter column names the team\'s recruiter', lA.body.rows.every((r) => [U.R1a.name, U.R1b.name].includes(r.recruiter)) && lB.body.rows.every((r) => [U.R2a.name, U.R2b.name].includes(r.recruiter)), lA.body.rows.map((r) => r.recruiter));
  check('16 the Team B list carries the "still working / left after joining" line and opens the person who left', lB.body.left && lB.body.left.n === 1 && lB.body.stillWorking === 2, lB.body && { l: lB.body.left, s: lB.body.stillWorking });
  const lLeft = await listOf('TL2', cardB.left.drill);
  check('17 ...the left list holds only the person who left, same safe columns', lLeft.status === 200 && lLeft.body.total === 1 && lLeft.body.rows[0].id === leaver && Object.keys(lLeft.body.rows[0]).every((k) => SAFE.includes(k)), lLeft.body);
  const exp = await call('GET', `/dashboard/ats/home/list?set=${idA}&format=csv&asUser=${U.TL1.id}`, null, TA, true);
  const head = String(exp.text || '').split(/\r?\n/).find((l) => /Candidate/.test(l)) || '';
  const expTl = await call('GET', `/dashboard/ats/home/list?set=${idA}&format=csv`, null, T.TL1, true);
  check('18 Excel / CSV export where the role may export: only the safe columns', (exp.status === 200 ? head.replace(/"/g, '') === 'Candidate,Requirement,Requirement code,Client,Recruiter,Joining date' : [403].includes(exp.status)) && [200, 403].includes(expTl.status), { st: exp.status, head, tl: expTl.status });
  if (expTl.status === 200) check('18b the export carries no phone / email', !Object.values(people).some((p) => expTl.text.includes(p.phone) || expTl.text.includes(p.email)));

  // ---- the date range changes the numbers (last month: A 1, B 2)
  const hl = await home('TL1', '&range=last_month'); const cl = cardsOf(hl);
  check('19 date range "last month": Team A = 1 and Team B = 2, lists follow', valOf(cl, 'Team A joinings') === 1 && valOf(cl, 'Team B joinings') === 2, cl.map((c) => [c.label, c.value]));
  const lastA = await listOf('TL1', cl.find((c) => c.label === 'Team A joinings').drill, '&range=last_month');
  check('20 ...and the Team A list for last month holds the last-month person', lastA.status === 200 && same(lastA.body.rows.map((r) => r.id), A.before), lastA.body && lastA.body.rows);
  // the client filter: Team B's second job is on another client
  if (client2) {
    const hc = await home('TL1', `&clientId=${client.id}`); const cc = cardsOf(hc);
    check('21 the client filter is followed: with one client, Team B = 1 (its other joining is on another client)', valOf(cc, 'Team B joinings') === 1 && valOf(cc, 'Team A joinings') === 3, cc.map((c) => [c.label, c.value]));
  }

  // ---- Admin "Dashboard of TL1"
  const ha = await home('x', `&asUser=${U.TL1.id}`, TA); const ca = cardsOf(ha);
  check('22 Admin viewing "Dashboard of TL1" sees the same two cards, own team first', ha.status === 200 && ca.length === 2 && ca[0].label === 'Team A joinings' && ca[0].mine && valOf(ca, 'Team A joinings') === 3 && valOf(ca, 'Team B joinings') === 2, { st: ha.status, ca: ca.map((c) => [c.label, c.value, c.mine]), err: ha.body && ha.body.error });

  // ---- not for everybody else
  const hr = await home('R1a'); const hb = await home('BDE'); const hAdmin = await home('x', '', TA);
  check('23 a recruiter gets no team cards and no team list', hr.status === 200 && cardsOf(hr).length === 0 && (await listOf('R1a', idA)).status === 404, { st: hr.status });
  check('24 a BDE gets no team cards and no team list', hb.status === 200 && cardsOf(hb).length === 0 && (await listOf('BDE', idA)).status === 404, { st: hb.status });
  check('25 an Admin on their own dashboard is unchanged (no team cards)', hAdmin.status === 200 && cardsOf(hAdmin).length === 0);

  // ---- a one-team department keeps the single card
  const h3 = await home('TL3'); const my = ((h3.body && h3.body.top) || []).find((t) => t.id === 'my-joins');
  check('26 a TL of a one-team department keeps the single "My team\'s joinings this month" card (= 1) and no team cards', h3.status === 200 && cardsOf(h3).length === 0 && my && my.value === 1 && /My team/.test(my.label), { top: ((h3.body && h3.body.top) || []).map((t) => [t.id, t.value]) });
  const l3 = await listOf('TL3', 'my-joins');
  check('27 ...and its list is the old one (the one person)', l3.status === 200 && same(l3.body.rows.map((r) => r.id), [solo]), l3.body && l3.body.rows);

  // ---- a team with no joinings shows 0; a third team wraps (cards for every team); "Other" only when > 0
  const sTeamC = await seat('R3c', 'RECRUITER', DEP, 'Team C', S.TL2.id);
  await prisma.positionAssignment.create({ data: { positionId: sTeamC.id, employeeId: (await mkEmp(await mkUser('RecC1', 'RECRUITER', 'EMPLOYEE', DEP), 'RC', DEP)).id, fromDate: '2025-01-01' } });
  require('../src/utils/teamJoinCards').reset(); // eslint-disable-line global-require
  await new Promise((r) => { setTimeout(r, 200); });
  // the server caches the seat list for a minute: ask it through a fresh server-side call by waiting is slow, so check in-process too
  const TJ = require('../src/utils/teamJoinCards'); // eslint-disable-line global-require
  const idTL1 = await resolveIdentity(U.TL1.id);
  const ctx = { user: idTL1, period: { from: `${month}-01`, to: today, key: 'this_month' }, prev: { from: lastMonthDay, to: lastMonthDay, key: 'prev' }, noPrev: false, f: {} };
  const three = await TJ.cardsFor(ctx);
  check('28 a department with 3 teams gets 3 cards, and a team with no joinings shows 0', three && three.map((c) => c.label).join(',') === 'Team A,Team B,Team C' && three.find((c) => c.label === 'Team C').count === 0 && three[0].mine, three && three.map((c) => [c.label, c.count]));
  check('29 no "Other" card while no joining sits on a seat without a team', !three.some((c) => c.other));
  // a seat with NO team, joinings on it: an "Other" card, and the sum still equals the department
  const sNone = await seat('R0', 'RECRUITER', DEP, null, S.TL1.id);
  const uNone = await mkUser('RecNone', 'RECRUITER', 'EMPLOYEE', DEP);
  const eNone = await mkEmp(uNone, 'RN', DEP);
  await prisma.positionAssignment.create({ data: { positionId: sNone.id, employeeId: eNone.id, fromDate: '2025-01-01' } });
  U.R0 = uNone; J.R0 = await mkReq('R0', 'TL1', DEP, 'n1');
  const oneId = await mkJoin('R0', today);
  TJ.reset(); RJ.invalidate();
  const four = await TJ.cardsFor(ctx);
  const oth = four && four.find((c) => c.other);
  const sum = four ? four.reduce((s, c) => s + c.count, 0) : -1;
  const board2 = await RJ.monthBoard(month, { fresh: true });
  const dept2 = board2.rows.filter((r) => r.department === DEP).reduce((s, r) => s + r.joinings, 0);
  check('30 a seat with no team: an "Other" card with its joining, and all the cards still add up to the department', oth && oth.count === 1 && oth.rows[0].id === oneId && sum === dept2 && sum === 6, { oth: oth && oth.count, sum, dept2 });
  check('31 the one-team department gives no team cards in-process either', (await TJ.cardsFor({ ...ctx, user: await resolveIdentity(U.TL3.id) })) === null);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);

})().catch(async (e) => { console.error(e); await stop(1); });
