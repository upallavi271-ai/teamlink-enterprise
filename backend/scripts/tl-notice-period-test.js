#!/usr/bin/env node
/**
 * A TEAM LEAD STILL WORKING IS NOT "(left)" (founder 2026-11-20): the TL seat's end date passed but the last holder is on Notice Period / Active
 * -> the seat still names them (no "(left)") and they still get the notices; Exited / Relieved / Terminated keeps the "(left)".
 * SANDBOX ONLY: a COPY of the sandbox database, no server.   TEST_SOURCE_DB=<sandbox.db> node scripts/tl-notice-period-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-tlnotice-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` });
const prisma = require('../src/db');
const { leadsOfPosition } = require('../src/utils/positionScope');
const TL_CHANGE = require('../src/utils/teamLeadChange');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ''}`); } };
const RUN = Date.now().toString(36);

(async () => {
  const mkUser = (tag) => prisma.user.create({ data: { name: `Np ${tag} ${RUN}`, email: `np.${tag}.${RUN}@np-test.in`, username: `np.${tag}.${RUN}@np-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', role: 'TL', atsRole: 'TL' } });
  const mkEmp = (u, status) => prisma.employee.create({ data: { employeeCode: `NP-${u.id.slice(-6)}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'TL', employmentStatus: status, department: 'Education', email: u.email } });
  const seatsFor = async (status, tag) => {
    const u = await mkUser(tag); const e = await mkEmp(u, status);
    const tlSeat = await prisma.position.create({ data: { code: `NPTL-${tag}-${RUN}`, name: 'TL', department: 'Education', team: 'Team B', kind: 'TL', active: true } });
    const recSeat = await prisma.position.create({ data: { code: `NPR-${tag}-${RUN}`, name: 'R', department: 'Education', team: 'Team B', kind: 'RECRUITER', reportsToId: tlSeat.id, active: true } });
    await prisma.positionAssignment.create({ data: { positionId: tlSeat.id, employeeId: e.id, fromDate: '2026-06-17', toDate: '2026-11-15' } }); // the seat's end date has passed
    return { u, recSeat };
  };
  const a = await seatsFor('Notice Period', 'notice');
  const la = await leadsOfPosition({ positionCode: a.recSeat.code });
  check('Notice Period: the TL is still the team lead (user id given, no "(left)")', la.tlUserId === a.u.id && la.tlName === a.u.name && !la.tlFormerName, la);
  const b = await seatsFor('Active', 'active');
  const lb = await leadsOfPosition({ positionCode: b.recSeat.code });
  check('Active: the same', lb.tlUserId === b.u.id && !lb.tlFormerName, lb);
  const c = await seatsFor('Relieved', 'relieved');
  const lc = await leadsOfPosition({ positionCode: c.recSeat.code });
  check('Relieved: still "(left)" - the old holder is named, nobody to notify', !lc.tlUserId && lc.tlFormerName === c.u.name, lc);
  const d = await seatsFor('Exited', 'exited');
  const ld = await leadsOfPosition({ positionCode: d.recSeat.code });
  check('Exited: still "(left)"', !ld.tlUserId && ld.tlFormerName === d.u.name, ld);
  const cand = await prisma.candidate.create({ data: { name: `Np Person ${RUN}`, phone: `7${String(Date.now()).slice(-9)}`, email: `np.${RUN}@np-test.in` } });
  const cl = await prisma.client.create({ data: { name: `Np Client ${RUN}`, ownerDepartment: 'Education', agreementStatus: 'ACTIVE' } });
  const rq = await prisma.requirement.create({ data: { title: `Np Req ${RUN}`, clientId: cl.id, department: 'Education', status: 'RECRUITER_ASSIGNED', openings: 1 } });
  const ap = await prisma.application.create({ data: { candidateId: cand.id, requirementId: rq.id, stage: 'NEW' }, include: { requirement: true } });
  const t = await TL_CHANGE.teamLeadOfApplication(ap, { positionCode: a.recSeat.code });
  check('the candidate page\'s team lead (teamLeadOfApplication) names the notice-period TL plainly', t.tlName === a.u.name && !/left/.test(t.tlName) && t.source === 'seat', t);
  const t2 = await TL_CHANGE.teamLeadOfApplication(ap, { positionCode: c.recSeat.code });
  check('...and a relieved TL still reads "(left)"', /\(left\)$/.test(t2.tlName || '') && t2.source === 'seat-former', t2);
  console.log(`\n${total - failed}/${total} passed`);
  await prisma.$disconnect();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  crashed:', e && e.stack); process.exit(1); });
