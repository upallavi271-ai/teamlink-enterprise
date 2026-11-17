#!/usr/bin/env node
/**
 * THE BDE SEAT DECIDES THE BDE (utils/bdeSeatHandover.js) - founder 2026-11-17: Rajeshwari took BDE-MED after Vasavi and her ATS
 * showed all zeros. A BDE desk seat holder left on the Recruiter role becomes an ATS BDE; a BDE who left hands their clients,
 * live jobs and open follow-ups to whoever sits in their seat now. Closed jobs and done follow-ups stay with the leaver.
 * SANDBOX ONLY: works on a COPY of the sandbox database; no server.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/bde-seat-handover-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-bde-seat-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', JWT_SECRET: 'bde-seat-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` });
const prisma = require('../src/db');
const H = require('../src/utils/bdeSeatHandover');
const { resolveIdentity } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const P = process.pid;
async function person(tag, { status = 'Active', role = 'EMPLOYEE', atsRole = null, userStatus = 'Active' } = {}) {
  const user = await prisma.user.create({ data: { name: `ZZ ${tag} ${P}`, email: `zz.bdeseat.${tag}.${P}@zz-bdeseat-test.in`, passwordHash: 'x', status: userStatus, role, atsRole, atsAccess: true, atsDepartment: 'BDE' } });
  const emp = await prisma.employee.create({ data: { name: user.name, employeeCode: `ZZB${tag}${P}`.slice(0, 20), department: 'BDE', employmentStatus: status, userId: user.id } });
  return { user, emp };
}
async function done(code) {
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 300);
}

(async () => {
  check('BDE-MED / BDE-MFG-2 / BDE-EDU-1 are desk seats, BDE-TL is not', H.isBdeDeskSeat('BDE-MED') && H.isBdeDeskSeat('BDE-MFG-2') && H.isBdeDeskSeat('BDE-EDU-1') && !H.isBdeDeskSeat('BDE-TL') && !H.isBdeDeskSeat('MED-1'));
  const seat = await prisma.position.create({ data: { code: `BDE-ZZMED${P}`, department: 'BDE' } });
  const lone = await prisma.position.create({ data: { code: `BDE-ZZLONE${P}`, department: 'BDE' } });
  const tlSeat = await prisma.position.create({ data: { code: `BDE-ZZTLX${P}`, department: 'BDE' } });
  const oneDay = await prisma.position.create({ data: { code: `BDE-ZZ2${P}`, department: 'BDE' } }); // vasavi's one-day BDE-2, same start date

  const L = await person('leaver', { status: 'Exited', atsRole: 'BDE' }); // Vasavi
  const N = await person('newbde', { role: 'RECRUITER', atsRole: 'RECRUITER' }); // Rajeshwari
  const L2 = await person('lonely', { status: 'Exited', atsRole: 'BDE' }); // a leaver whose seat is empty
  const T = await person('tlhold', { role: 'TL', atsRole: 'TL' }); // a TL put on a BDE seat on purpose
  await prisma.positionAssignment.createMany({
    data: [
      { positionId: oneDay.id, employeeId: L.emp.id, fromDate: '2026-09-23', toDate: '2026-09-23' },
      { positionId: seat.id, employeeId: L.emp.id, fromDate: '2026-09-23', toDate: '2026-11-17' },
      { positionId: seat.id, employeeId: N.emp.id, fromDate: '2026-11-16' },
      { positionId: lone.id, employeeId: L2.emp.id, fromDate: '2026-09-23', toDate: '2026-11-10' },
      { positionId: tlSeat.id, employeeId: T.emp.id, fromDate: '2026-11-01' },
    ],
  });
  const c1 = await prisma.client.create({ data: { name: `ZZ Hospital A ${P}`, bdeOwner: ` ${L.user.name.toUpperCase()} ` } });
  const c2 = await prisma.client.create({ data: { name: `ZZ Hospital B ${P}`, bdeOwner: 'Someone Else', secondaryBde: L.user.name } });
  const c3 = await prisma.client.create({ data: { name: `ZZ Hospital C ${P}`, bdeOwner: 'Someone Else' } });
  const c4 = await prisma.client.create({ data: { name: `ZZ Hospital D ${P}`, bdeOwner: L2.user.name } });
  const r1 = await prisma.requirement.create({ data: { title: `ZZ Radiologist ${P}`, clientId: c1.id, status: 'OPEN', bdeId: L.user.id } });
  const r2 = await prisma.requirement.create({ data: { title: `ZZ Old job ${P}`, clientId: c1.id, status: 'CLOSED', bdeId: L.user.id } });
  const fus = await prisma.applicationFollowUp.findMany({ take: 2, select: { id: true } });
  const [fOpen, fDone] = fus;
  if (fOpen) await prisma.applicationFollowUp.update({ where: { id: fOpen.id }, data: { ownerUserId: L.user.id, ownerName: L.user.name, completedAt: null, bdeUserId: L.user.id } });
  if (fDone) await prisma.applicationFollowUp.update({ where: { id: fDone.id }, data: { ownerUserId: L.user.id, ownerName: L.user.name, completedAt: new Date() } });

  const before = await resolveIdentity(N.user.id);
  check('before: the new seat holder is an ATS Recruiter (the reported zeros)', before && before.atsRole === 'RECRUITER', before && before.atsRole);

  const r = await H.run();
  const n = await prisma.user.findUnique({ where: { id: N.user.id } });
  check('the BDE-seat holder on the Recruiter role is made an ATS BDE', n.atsRole === 'BDE' && n.role === 'BDE', { atsRole: n.atsRole, role: n.role });
  check('the role change is audited', !!(await prisma.auditLog.findFirst({ where: { entityId: N.user.id, action: { startsWith: 'ATS role set to BDE' } } })));
  const t = await prisma.user.findUnique({ where: { id: T.user.id } });
  check('a TL put on a BDE seat keeps the TL role', t.atsRole === 'TL' && t.role === 'TL', { atsRole: t.atsRole });

  const [a1, a2, a3, a4] = await Promise.all([c1, c2, c3, c4].map((c) => prisma.client.findUnique({ where: { id: c.id } })));
  check('the leaver\'s client (Owner BDE, any case / spaces) now names the new holder', a1.bdeOwner === N.user.name, a1.bdeOwner);
  check('second-BDE on a client moves too; the owner stays', a2.secondaryBde === N.user.name && a2.bdeOwner === 'Someone Else', a2);
  check('somebody else\'s client is untouched', a3.bdeOwner === 'Someone Else');
  check('a leaver whose seat is empty keeps their clients (nobody to give them to)', a4.bdeOwner === L2.user.name);
  const [q1, q2] = await Promise.all([r1, r2].map((x) => prisma.requirement.findUnique({ where: { id: x.id } })));
  check('a live job naming the leaver as BDE moves', q1.bdeId === N.user.id);
  check('a closed job keeps the leaver (their work)', q2.bdeId === L.user.id);
  if (fOpen) {
    const fo = await prisma.applicationFollowUp.findUnique({ where: { id: fOpen.id } });
    check('an open follow-up moves (owner and BDE)', fo.ownerUserId === N.user.id && fo.bdeUserId === N.user.id && fo.ownerName === N.user.name, fo);
  }
  if (fDone) {
    const fd = await prisma.applicationFollowUp.findUnique({ where: { id: fDone.id } });
    check('a done follow-up keeps the leaver', fd.ownerUserId === L.user.id);
  }
  const mv = (r.moved || []).find((m) => m.to === N.user.name);
  check('the run reports the handover with counts', !!mv && mv.clients === 2 && mv.requirements === 1, r.moved);
  check('each client move is audited', (await prisma.auditLog.count({ where: { action: 'Client handed over (the BDE left)', entityId: { in: [c1.id, c2.id] } } })) === 2);
  check('the new holder gets a bell note', (await prisma.notification.count({ where: { userId: N.user.id } }).catch(() => 0)) >= 1);

  const after = await resolveIdentity(N.user.id);
  check('after: her login is an ATS BDE and owns the handed-over clients', after.atsRole === 'BDE' && (after.atsOwnedClientIds || []).includes(c1.id) && (after.atsOwnedClientIds || []).includes(c2.id), { atsRole: after.atsRole, owned: (after.atsOwnedClientIds || []).length });
  const S = require('../src/utils/scope');
  const reqs = await prisma.requirement.findMany({ where: { AND: [S.requirementWhere(after), { id: { in: [r1.id, r2.id] } }] }, select: { id: true } });
  check('her Requirements list now includes the leaver\'s clients\' jobs', reqs.some((x) => x.id === r1.id), reqs);

  const again = await H.run();
  check('a second run changes nothing', !again.fixed.length && !again.moved.length, again);

  console.log(`\n${total - failed}/${total} passed`);
  await done(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await done(1); });
