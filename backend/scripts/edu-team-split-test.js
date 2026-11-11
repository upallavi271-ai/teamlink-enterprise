#!/usr/bin/env node
/**
 * Education Team A and Team B never see each other's profiles (founder 2026-11-11, utils/eduTeams.js + utils/scope.js eduSplit).
 * SANDBOX ONLY: works on a COPY of the sandbox database; the API part runs a private server on port 4072.
 *   node scripts/edu-team-split-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-edu-split-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4072;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', AI_VOICE_GATEWAY: '0', PORT: String(PORT), JWT_SECRET: 'edu-split', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const S = require('../src/utils/scope');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // who sits where now
  const seats = await prisma.positionAssignment.findMany({
    where: { toDate: null, position: { department: 'Education', team: { not: null } } },
    include: { position: true, employee: { include: { user: true } } },
  });
  const holder = (pred) => seats.find((x) => pred(x.position) && x.employee.user && x.employee.user.status !== 'Inactive');
  const tlA = holder((p) => p.team === 'Team A' && /TL/i.test(p.code));
  const tlB = holder((p) => p.team === 'Team B' && /TL/i.test(p.code));
  const recA = holder((p) => p.team === 'Team A' && /^EDU-\d+$/.test(p.code));
  const recB = holder((p) => p.team === 'Team B' && /^EDU-\d+$/.test(p.code));
  console.log('seats:', [tlA, tlB, recA, recB].map((x) => x && `${x.position.code} ${x.employee.name}`).join(' | '));
  if (!recA || !recB) throw new Error('need a Team A and a Team B recruiter on the copy');
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
  const ident = async (u) => resolveIdentity(u.id);

  // one Education job worked by both teams, with one candidate each
  const job = await prisma.requirement.findFirst({ where: { department: 'Education', internal: false } });
  await prisma.requirement.update({ where: { id: job.id }, data: { recruiterId: recA.employee.user.id, recruiterIds: `${recA.employee.user.id},${recB.employee.user.id}`, tlId: tlA ? tlA.employee.user.id : null, status: 'OPEN', positionCode: null } });
  const mk = async (name, owner) => {
    const c = await prisma.candidate.create({ data: { name, phone: `9${String(Date.now()).slice(-9)}` } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: job.id, stage: 'RECRUITER_REVIEW', hiringType: 'Client Placement', ownerRecruiterId: owner } });
    return { c, a };
  };
  const A = await mk('Zz Team A Person', recA.employee.user.id);
  await new Promise((r) => { setTimeout(r, 5); });
  const B = await mk('Zz Team B Person', recB.employee.user.id);
  require('../src/utils/eduTeams').reset(); // eslint-disable-line global-require

  const sees = async (u, x) => (await prisma.application.count({ where: { AND: [{ id: x.a.id }, S.applicationWhere(u)] } })) === 1;
  const one = async (u, x) => S.applicationInScope(u, await prisma.application.findUnique({ where: { id: x.a.id }, include: { requirement: true } }));
  console.log('Who sees which (list rule and single-record rule)');
  for (const [label, row, mineX, otherX] of [['Team A recruiter', recA, A, B], ['Team B recruiter', recB, B, A], ['Team A TL', tlA, A, B], ['Team B TL', tlB, B, A]]) {
    if (!row) { console.log(`  (no ${label} on the copy)`); continue; } // eslint-disable-line no-continue
    const u = await ident(row.employee.user);
    check(`${label}: knows their team`, u.atsEduTeam && (label.includes('A') ? u.atsEduTeam.team === 'Team A' : u.atsEduTeam.team === 'Team B'), u.atsEduTeam && u.atsEduTeam.team);
    check(`${label}: sees their own team's candidate`, (await sees(u, mineX)) && (await one(u, mineX)));
    check(`${label}: does NOT see the other team's (list)`, !(await sees(u, otherX)));
    check(`${label}: does NOT see the other team's (opening it)`, !(await one(u, otherX)));
  }
  const sa = await ident(admin);
  check('Super Admin sees both', (await sees(sa, A)) && (await sees(sa, B)));

  console.log('A job with no owner on the application: the job\'s seat decides');
  const C = await mk('Zz Unowned Person', null);
  const seatB = recB.position.code;
  await prisma.requirement.update({ where: { id: job.id }, data: { positionCode: seatB, recruiterId: recB.employee.user.id } });
  await prisma.$executeRawUnsafe('UPDATE "Application" SET "ownerRecruiterId" = NULL WHERE "id" = ?', C.a.id); // (made owner-less: old imported work)
  const uA = await ident(recA.employee.user);
  const uB = await ident(recB.employee.user);
  check('an unowned application on a Team B seat job is hidden from Team A', !(await sees(uA, C)) && !(await one(uA, C)));
  check('... and Team B sees it', (await sees(uB, C)) && (await one(uB, C)));

  console.log('The Candidates list (API)');
  await prisma.user.updateMany({ where: { id: { in: [recA.employee.user.id, recB.employee.user.id, admin.id] } }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${API}/health`).then((x) => x.ok).catch(() => false)) break; // eslint-disable-line no-await-in-loop
    await new Promise((x) => { setTimeout(x, 500); }); // eslint-disable-line no-await-in-loop
  }
  const tok = (u) => jwt.sign({ ...tokenPayload(u), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const list = async (u, extra = '') => {
    const res = await fetch(`${API}/candidates?paged=1&pageSize=200&search=Zz%20Team${extra}`, { headers: { Authorization: `Bearer ${tok(u)}` } });
    const body = await res.json().catch(() => null);
    const rows = (body && (body.rows || body.items || body.data)) || (Array.isArray(body) ? body : []);
    return { status: res.status, names: rows.map((r) => r.name) };
  };
  const la = await list(uA);
  check('Team A recruiter: list has A, not B', la.names.includes('Zz Team A Person') && !la.names.includes('Zz Team B Person'), la);
  const lb = await list(uB);
  check('Team B recruiter: list has B, not A', lb.names.includes('Zz Team B Person') && !lb.names.includes('Zz Team A Person'), lb);
  const ls = await list(sa);
  check('Super Admin: list has both', ls.names.includes('Zz Team A Person') && ls.names.includes('Zz Team B Person'), ls);
  const res = await fetch(`${API}/candidates/${B.c.id}`, { headers: { Authorization: `Bearer ${tok(uA)}` } });
  check('Team A recruiter cannot open the Team B profile', [403, 404].includes(res.status), res.status);

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
