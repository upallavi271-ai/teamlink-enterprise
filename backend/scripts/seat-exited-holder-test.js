#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A SEAT HELD BY SOMEBODY WHO HAS LEFT IS FREE FOR THE NEW EMPLOYEE (founder, 2026-10-22). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/seat-exited-holder-test.js
//   S1 add employee on a seat whose holder is Exited / Relieved -> 201, the leaver's tenure is ended (history kept), the newcomer holds it
//   S2 the same seat taken by an ACTIVE holder -> still refused (409) in plain words
//   S3 a holder on notice -> the REPLACEMENT is added now (2026-10-23), S4 a second newcomer is refused, S8 the leaver's tenure ends alone
// ---------------------------------------------------------------------------
const path = require('path');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const made = { users: [], emps: [], pos: [], asg: [] };
  try {
    const sa = await prisma.user.create({ data: { passwordHash: 'x', hrmsRole: 'SUPER_ADMIN', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: true, status: 'Active', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', name: `ZZTEST SE Admin ${RUN}`, email: `zz-se-admin-${RUN}@example.test`, username: `zz-se-admin-${RUN}@example.test` } });
    made.users.push(sa.id);
    const tok = jwt.sign(tokenPayload(await resolveIdentity(sa.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const mkEmp = async (tag, status) => { const e = await prisma.employee.create({ data: { employeeCode: `ZZSE-${tag}-${RUN}`.slice(0, 30), name: `ZZTEST SE ${tag} ${RUN}`, designation: 'Recruiter', department: 'Education', employmentStatus: status } }); made.emps.push(e.id); return e; };
    const mkSeat = async (tag, emp) => { const p = await prisma.position.create({ data: { code: `ZZSE-${tag}-${RUN}`.slice(0, 30), department: 'Education', kind: 'RECRUITER' } }); made.pos.push(p.id); const a = await prisma.positionAssignment.create({ data: { positionId: p.id, employeeId: emp.id, fromDate: '2026-01-01' } }); made.asg.push(a.id); return p; };
    const left = await mkEmp('left', 'Active'); const seatLeft = await mkSeat('L', left);
    // the leaver leaves WITHOUT the seat being ended (the old backlog / an import): write the status straight to the row
    await prisma.$executeRawUnsafe('UPDATE "Employee" SET "employmentStatus" = ? WHERE id = ?', 'Exited', left.id);
    const active = await mkEmp('act', 'Active'); const seatAct = await mkSeat('A', active);
    const notice = await mkEmp('not', 'Active'); const seatNot = await mkSeat('N', notice);
    await prisma.$executeRawUnsafe('UPDATE "Employee" SET "employmentStatus" = ? WHERE id = ?', 'Notice Period', notice.id);

    const body = (tag, seat) => ({ name: `ZZTEST SE New ${tag} ${RUN}`, email: `zz-se-new-${tag}-${RUN}@example.test`, department: 'Education', designation: 'Employee', position: seat.code, phone: '', password: 'Zz-test-pass1' });
    let r = await call('POST', '/api/employees/management', tok, body('a', seatLeft));
    if (r.body && r.body.id) made.emps.push(r.body.id);
    check('S1 a new employee can take a seat whose holder has Exited (201)', r.status === 201, [r.status, r.body && r.body.error]);
    const open = await prisma.positionAssignment.findMany({ where: { positionId: seatLeft.id }, orderBy: { createdAt: 'asc' } });
    check('S1b the leaver\'s tenure is ENDED (history kept) and the newcomer holds the seat now', open.length === 2 && open[0].toDate && !open[1].toDate && open[1].employeeId === (r.body && r.body.id), open.map((o) => [o.employeeId === left.id ? 'leaver' : 'new', o.fromDate, o.toDate]));
    r = await call('POST', '/api/employees/management', tok, body('b', seatAct));
    check('S2 a seat held by somebody still working is refused (409) in plain words', r.status === 409 && /currently held by/.test((r.body && r.body.error) || ''), [r.status, r.body]);
    // 2026-10-23 (founder): a seat whose holder is ON NOTICE takes the REPLACEMENT now (a handover); a second newcomer is still refused.
    const opts = await call('GET', '/api/employees/management/options', tok);
    const seatOpt = ((opts.body && opts.body.positions) || []).find((p) => p.code === seatNot.code);
    check('S3a before the replacement: the picker lists the seat as "holder on notice" with its last day (assignable)', seatOpt && seatOpt.onNotice === true && seatOpt.holder === notice.name, seatOpt);
    r = await call('POST', '/api/employees/management', tok, { ...body('c', seatNot), biometricPin: `ZZ${RUN}`.slice(0, 20) });
    if (r.body && r.body.id) made.emps.push(r.body.id);
    check('S3 a seat held by somebody on notice takes the REPLACEMENT now (201)', r.status === 201, [r.status, r.body && r.body.error]);
    const both = await prisma.positionAssignment.findMany({ where: { positionId: seatNot.id, toDate: null } });
    check('S3b both are in the seat now (a handover): the leaver and the newcomer, each with an open tenure', both.length === 2 && both.some((x) => x.employeeId === notice.id) && both.some((x) => x.employeeId === (r.body && r.body.id) && /Replacement for/.test(x.note || '')), both.map((x) => [x.employeeId === notice.id ? 'leaver' : 'newcomer', x.note]));
    const opts2 = await call('GET', '/api/employees/management/options', tok);
    const seatOpt2 = ((opts2.body && opts2.body.positions) || []).find((p) => p.code === seatNot.code);
    check('S3c now the picker shows the NEWCOMER as the holder and the seat is no longer offered as replaceable', seatOpt2 && !seatOpt2.onNotice && seatOpt2.holder && /ZZTEST SE New c/.test(seatOpt2.holder), seatOpt2);
    r = await call('POST', '/api/employees/management', tok, body('d', seatNot));
    check('S4 a SECOND newcomer on the same seat is refused (409): somebody active already holds it', r.status === 409 && /currently held by/.test((r.body && r.body.error) || ''), [r.status, r.body]);
    r = await call('POST', '/api/employees/management', tok, { ...body('e', seatAct), position: '', biometricPin: `ZZ${RUN}`.slice(0, 20) });
    check('S5 the same Biometric ID cannot be used by a second employee (409, names who has it)', r.status === 409 && /Biometric ID/.test((r.body && r.body.error) || ''), [r.status, r.body]);
    r = await call('POST', '/api/employees/management', tok, { ...body('f', seatAct), position: '', biometricPin: 'bad id!' });
    check('S6 a Biometric ID with odd characters is refused (400)', r.status === 400, [r.status, r.body]);
    const saved = await prisma.employee.findFirst({ where: { name: { contains: `ZZTEST SE New c ${RUN}` } }, select: { biometricPin: true } });
    check('S7 the Biometric ID typed on Add Employee is saved on the employee', saved && saved.biometricPin === `ZZ${RUN}`.slice(0, 20), saved);
    // the leaver's last day arrives: only the leaver's tenure ends, the newcomer keeps the seat
    await prisma.$executeRawUnsafe('UPDATE "Employee" SET "employmentStatus" = ? WHERE id = ?', 'Relieved', notice.id);
    await require(path.join(BACK, 'src/utils/seatRelease')).releaseSeatsOf(notice.id, {});
    const after = await prisma.positionAssignment.findMany({ where: { positionId: seatNot.id }, orderBy: { createdAt: 'asc' } });
    check('S8 when the leaver is relieved only the LEAVER\'s tenure ends; the newcomer still holds the seat', after.filter((x) => !x.toDate).length === 1 && after.find((x) => x.employeeId === notice.id).toDate, after.map((x) => [x.employeeId === notice.id ? 'leaver' : 'newcomer', x.toDate]));
  } finally {
    try {
      const newEmps = await prisma.employee.findMany({ where: { name: { contains: `ZZTEST SE New` } }, select: { id: true, userId: true } });
      const ids = [...made.emps, ...newEmps.map((e) => e.id)];
      await prisma.positionAssignment.deleteMany({ where: { OR: [{ employeeId: { in: ids } }, { positionId: { in: made.pos } }] } }).catch(() => {});
      await prisma.position.deleteMany({ where: { id: { in: made.pos } } }).catch(() => {});
      const uids = newEmps.map((e) => e.userId).filter(Boolean);
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.pos] } }, { action: { contains: 'ZZ' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { OR: [{ id: { in: [...made.users, ...uids] } }, { email: { contains: 'zz-se-' } }] } }).catch(() => {});
    } catch (e) { console.log('cleanup problem:', e.message); }
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
