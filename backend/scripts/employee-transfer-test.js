// ---------------------------------------------------------------------------
// Employee Management -> Transfer, with a ROLE (routes/employees.js POST /:id/transfer, utils/employeeTransfer.js).
// Runs the real router on a COPY of the database (VACUUM INTO a temp file - the real one is only read), as a Super Admin and as
// the HR desk, and checks that a confirmed transfer keeps the department, role, login, seat, reporting line, team and history in
// step, that unsafe combinations are refused before anything is written, and that a failed save leaves nothing half-done.
//   node scripts/employee-transfer-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { PrismaClient } = require('@prisma/client');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
const lc = (v) => String(v || '').trim().toLowerCase();

(async () => {
  // 1. a copy of the database
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-transfer-'));
  const copy = path.join(tmp, 'copy.db').replace(/\\/g, '/');
  const real = new PrismaClient();
  await real.$executeRawUnsafe(`VACUUM INTO '${copy}'`);
  await real.$disconnect();
  process.env.DATABASE_URL = `file:${copy}`;
  process.env.TEST_MODE = '1';
  const prisma = require('../src/db');

  // 2. who is signed in: the real Super Admin / HR logins of the copy, switchable
  const userOf = async (where) => prisma.user.findFirst({ where: { status: 'Active', ...where } });
  const superAdmin = await userOf({ role: 'SUPER_ADMIN' });
  const hrUser = await userOf({ OR: [{ hrmsRole: 'HR' }, { role: 'HR' }] });
  if (!superAdmin) { console.log('the copy has no Super Admin'); process.exit(1); }
  let actor = superAdmin;
  stub('../src/middleware/auth', {
    ...require('../src/middleware/auth'),
    requireAuth: (req, _res, next) => { req.user = { ...actor, caps: {} }; next(); },
    requirePerm: () => (_req, _res, next) => next(),
  });
  const app = express(); app.use(express.json());
  app.use('/api/employees', require('../src/routes/employees'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/employees`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json || text };
  };
  const transfer = (id, body) => call('POST', `/${id}/transfer`, body);
  const preview = (id, body) => call('POST', `/${id}/transfer`, { ...body, preview: true });
  const emp = (id) => prisma.employee.findUnique({ where: { id }, include: { user: true } });
  const openSeat = (id) => prisma.positionAssignment.findFirst({ where: { employeeId: id, toDate: null }, include: { position: true } });
  const identity = require('../src/utils/identity');
  const working = { notIn: ['Relieved', 'Exited', 'Exit Process', 'Terminated', 'Resigned', 'Absconded', 'Inactive', 'Suspended'] };

  try {
    // ---- the copy as the day's sweep leaves it, plus two fixtures ----
    // (a) the real data has exactly as many active recruiter seats as people, so open one vacancy in Medical and one in Education Team A,
    //     as if somebody had left; (b) the copy's second Education TL is on notice and the sweep has freed her seat - bring her back so
    //     a team has a TL to be handed to.
    await require('../src/utils/seatRelease').ensureFresh();
    const tlSeats0 = await prisma.position.findMany({ where: { kind: 'TL', active: true } });
    for (const s of tlSeats0.filter((x) => lc(x.department) === 'education')) {
      const open = await prisma.positionAssignment.findFirst({ where: { positionId: s.id, toDate: null } });
      if (open) continue;
      const last = await prisma.positionAssignment.findFirst({ where: { positionId: s.id }, orderBy: { toDate: 'desc' }, include: { employee: true } });
      if (last && last.employee) {
        await prisma.employee.update({ where: { id: last.employeeId }, data: { employmentStatus: 'Active' } });
        if (last.employee.userId) await prisma.user.update({ where: { id: last.employee.userId }, data: { status: 'Active' } });
        await prisma.positionAssignment.update({ where: { id: last.id }, data: { toDate: null, note: null } });
      }
    }
    const medTlSeat = tlSeats0.find((x) => lc(x.department) === 'medical');
    const eduTlSeatA = tlSeats0.find((x) => lc(x.department) === 'education' && /team a/i.test(x.team || ''));
    const spare = async (dept) => prisma.position.findFirst({ where: { department: dept, kind: 'RECRUITER', active: false }, orderBy: { code: 'asc' } });
    const medSpare = await spare('Medical'); const eduSpare = await spare('Education');
    if (medSpare && medTlSeat) await prisma.position.update({ where: { id: medSpare.id }, data: { active: true, reportsToId: medTlSeat.id } });
    if (eduSpare && eduTlSeatA) await prisma.position.update({ where: { id: eduSpare.id }, data: { active: true, team: 'Team A', reportsToId: eduTlSeatA.id } });

    // ---- the people to test with (read from the copy, nobody is named here) ----
    const tlSeats = await prisma.position.findMany({ where: { kind: 'TL', active: true } });
    const seatHolder = async (positionId) => prisma.positionAssignment.findFirst({ where: { positionId, toDate: null }, include: { employee: { include: { user: true } } } });
    // an Education TL whose team has recruiters on the TL's seat tree and who has a TL colleague to hand the team to
    let teamA = null; let teamB = null;
    for (const s of tlSeats.filter((x) => lc(x.department) === 'education')) {
      const h = await seatHolder(s.id);
      if (h && h.employee && h.employee.user) { if (!teamA) teamA = { seat: s, tl: h.employee }; else if (!teamB) teamB = { seat: s, tl: h.employee }; }
    }
    // a one-TL department (Medical) with recruiters, for "leave the team" and a promotion into the vacated TL seat
    const medSeat = tlSeats.find((s) => lc(s.department) === 'medical');
    const medTl = medSeat ? (await seatHolder(medSeat.id)).employee : null;
    const medRecruiters = await prisma.employee.findMany({
      where: { department: 'Medical', designation: 'Employee', employmentStatus: working, userId: { not: null } }, include: { user: true },
    });
    const recruiterToPromote = medRecruiters.find((e) => e.user && e.user.atsRole === 'RECRUITER');
    const plainBde = await prisma.employee.findFirst({ where: { department: 'BDE', designation: 'Employee', employmentStatus: working, userId: { not: null } }, include: { user: true } });
    if (!teamA || !teamB || !medTl || !recruiterToPromote || !plainBde) {
      console.log('the copy does not have the people this test needs (two Education TL seats, a Medical TL + recruiter, a BDE employee)', !!teamA, !!teamB, !!medTl, !!recruiterToPromote, !!plainBde);
      process.exit(1);
    }

    // ================= THE FORM: the role list and the safety of who may give what =================
    let r = await preview(recruiterToPromote.id, { department: 'Medical' });
    const keys = (r.body.options?.roles || []).map((o) => o.key);
    ok('Role list: the card is offered Recruiter, BDE, Employee, TL ... from the masters; the person\'s current role is selected', r.status === 200
      && ['r:RECRUITER', 'r:BDE', 'd:TL', 'd:Employee'].every((k) => keys.includes(k)) && r.body.options.currentRoleKey === 'r:RECRUITER', keys.join(' '));
    ok('Role list: a transfer never offers Super Admin / Admin', !(r.body.options.roles || []).some((o) => /super admin|^admin$/i.test(o.designation || o.label)), '');
    ok('Preview of "nothing changed" says so and saves nothing', r.body.noChange === true && r.body.ok === true);
    r = await transfer(recruiterToPromote.id, { department: 'Medical' });
    ok('Confirming a transfer where nothing changes is refused with a plain message', r.status === 400 && /Nothing would change/.test(r.body.error), r.body.error);

    if (hrUser) {
      actor = hrUser;
      r = await preview(recruiterToPromote.id, { department: 'Medical' });
      const hrKeys = (r.body.options?.roles || []).map((o) => o.key);
      ok('HR desk: privileged roles (Manager, Assistant Manager, HR) are not offered', !hrKeys.some((k) => /manager|^d:hr$/i.test(k)) && hrKeys.includes('d:TL'), hrKeys.join(' '));
      r = await transfer(recruiterToPromote.id, { department: 'Medical', roleKey: 'd:Manager' });
      ok('HR desk: asking for the Manager role anyway is refused, nothing changes', r.status === 400 && /not one you can give/.test(r.body.error)
        && (await emp(recruiterToPromote.id)).designation === 'Employee', r.body.error);
      r = await preview(recruiterToPromote.id, { department: 'Medical', roleKey: 'd:TL' });
      ok('HR desk: may still hand out the TL role (the same rule as Assign Roles), so the login is not made higher than allowed', r.body.ok === true && (r.body.lines || []).some((l) => l.label === 'Role'), (r.body.blockers || [])[0]);
      actor = superAdmin;
    }
    // nobody changes their own role
    {
      const self = { ...superAdmin };
      const selfEmp = await prisma.employee.findFirst({ where: { userId: superAdmin.id } });
      if (selfEmp) {
        r = await preview(selfEmp.id, { department: selfEmp.department, roleKey: 'd:TL' });
        ok('Own role: a person cannot change their own role through a transfer', r.body.ok === false && /own role|Admin|Super Admin/i.test((r.body.blockers || []).join(' ')), (r.body.blockers || [])[0]);
      } else { ok('Own role: (no employee record for the Super Admin login to try)', true); }
      actor = self;
    }
    // an Admin / Manager login cannot be re-roled by the HR desk
    if (hrUser) {
      const mgr = await prisma.employee.findFirst({ where: { user: { is: { OR: [{ role: 'MANAGER' }, { role: 'ADMIN' }, { role: 'ASSISTANT_MANAGER' }] } }, employmentStatus: working }, include: { user: true } });
      if (mgr) {
        actor = hrUser;
        r = await preview(mgr.id, { department: mgr.department, roleKey: 'd:Employee' });
        ok('HR desk: the role of a Manager / Admin login is refused to change', r.body.ok === false && (r.body.blockers || []).length > 0, (r.body.blockers || [])[0]);
        actor = superAdmin;
      }
    }

    // ================= A TL MOVES OUT: the team is handed over (Education Team A -> Team B's TL) =================
    const aCode = teamA.seat.code;
    const aSeatKids = await prisma.position.findMany({ where: { reportsToId: teamA.seat.id } });
    const aKidHolders = await prisma.positionAssignment.findMany({ where: { positionId: { in: aSeatKids.map((k) => k.id) }, toDate: null }, select: { employeeId: true } });
    const aTeamNames = await prisma.employee.findMany({
      where: { employmentStatus: working, id: { not: teamA.tl.id }, OR: [{ reportingManagerId: teamA.tl.id }, { tl: teamA.tl.name }, { id: { in: aKidHolders.map((h) => h.employeeId) } }] }, select: { id: true, name: true, tl: true, reportingManagerId: true },
    });
    r = await preview(teamA.tl.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto' });
    ok('TL out: moving a TL who leads people is refused until the card says what happens to them', r.body.ok === false && /Choose who takes over/.test((r.body.blockers || []).join(' '))
      && r.body.options.team.needed === true && r.body.options.team.count === aTeamNames.length, `${aTeamNames.length} people; ${(r.body.blockers || [])[0] || ''}`.slice(0, 160));
    ok('TL out: the card offers the other TL as the person to take over', (r.body.options.team.candidates || []).some((c) => c.id === teamB.tl.id));
    r = await transfer(teamA.tl.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto' });
    ok('TL out: confirming without a decision is refused and changes nothing', r.status === 400 && (await emp(teamA.tl.id)).department === 'Education' && (await openSeat(teamA.tl.id)).position.code === aCode);
    r = await preview(teamA.tl.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto', teamTo: teamB.tl.id });
    ok('TL out: with the hand-over chosen the preview is allowed and lists what changes (department, role, login, seat, team, team seats)',
      r.body.ok === true && ['Department', 'Role', 'Login access', 'Seat', 'Their team', 'Team seats'].every((l) => (r.body.lines || []).some((x) => x.label === l)), (r.body.lines || []).map((x) => x.label).join(', '));
    const before = await emp(teamA.tl.id);
    r = await transfer(teamA.tl.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto', teamTo: teamB.tl.id, reason: 'test move' });
    ok('TL out: the transfer is saved', r.status === 200 && r.body.department === 'Medical', r.body.error);
    const aft = await emp(teamA.tl.id);
    ok('TL out: department and role are the new ones', aft.department === 'Medical' && aft.designation === 'Employee');
    ok('TL out: the LOGIN follows - Recruiter in ATS, plain Employee in HRMS, Medical desk', aft.user.atsRole === 'RECRUITER' && aft.user.hrmsRole === 'EMPLOYEE' && aft.user.atsDepartment === 'Medical'
      && aft.user.atsAccess === true, `${aft.user.role}/${aft.user.hrmsRole}/${aft.user.atsRole}/${aft.user.atsDepartment}`);
    const idn = await identity.resolveIdentity(aft.userId);
    ok('TL out: signing in as them now resolves a Recruiter in Medical (no TL reach)', idn && idn.atsRole === 'RECRUITER' && !/TL|STL/.test(String(idn.hrmsRole)), idn && `${idn.hrmsRole}/${idn.atsRole}`);
    const newSeat = await openSeat(teamA.tl.id);
    const oldTenure = await prisma.positionAssignment.findFirst({ where: { employeeId: teamA.tl.id, positionId: teamA.seat.id }, orderBy: { createdAt: 'desc' } });
    ok('TL out: the TL seat tenure is CLOSED (kept as history) and a Recruiter seat in Medical is open', oldTenure && oldTenure.toDate && newSeat && newSeat.position.department === 'Medical' && newSeat.position.kind !== 'TL', newSeat && newSeat.position.code);
    ok('TL out: the TL seat is vacant now', !(await seatHolder(teamA.seat.id)));
    const left = await prisma.employee.findMany({ where: { id: { in: aTeamNames.map((x) => x.id) } } });
    ok(`TL out: all ${aTeamNames.length} people of the team (named on a line or sitting in the TL's seats) now report to the other TL; nobody still names the old TL`,
      left.length > 0 && left.every((e) => e.reportingManagerId !== teamA.tl.id && lc(e.tl) !== lc(teamA.tl.name) && (e.reportingManagerId === teamB.tl.id || lc(e.tl) === lc(teamB.tl.name))),
      left.slice(0, 3).map((e) => `${e.tl}/${e.reportingManagerId === teamB.tl.id ? 'rm ok' : `rm ${e.reportingManagerId}`}`).join('|'));
    const kids = await prisma.position.findMany({ where: { id: { in: aSeatKids.map((k) => k.id) } } });
    ok('TL out: the recruiter seats of the team now sit under the other TL seat (so that TL\'s ATS scope reaches them)', kids.length > 0 && kids.every((k) => k.reportsToId === teamB.seat.id), `${kids.length} seats`);
    const hist = await call('GET', `/management/${teamA.tl.id}`);
    const kindsSeen = (hist.body.transferHistory || []).map((h) => h.kind);
    ok('TL out: Employee -> History shows the Department, Role and Position moves with the old values', ['Department', 'Role', 'Position'].every((k) => kindsSeen.includes(k))
      && (hist.body.transferHistory || []).some((h) => h.kind === 'Role' && /TL/.test(h.from || '') && /Recruiter/.test(h.to || '')), kindsSeen.join(','));
    const roleAudit = await prisma.auditLog.count({ where: { entityId: teamA.tl.userId, action: { startsWith: 'Role change' } } });
    ok('TL out: the role change is in the audit trail (who, whom, old -> new)', roleAudit >= 1, `${roleAudit}`);
    ok('Team of the moved person is untouched elsewhere: the other TL\'s own record did not change', (await emp(teamB.tl.id)).department === 'Education' && (await emp(teamB.tl.id)).designation === teamB.tl.designation);
    void before;

    // ================= A ONE-TL DEPARTMENT: the TL leaves, the team stays in the TL seat, then a recruiter is promoted into it =================
    const medKids = await prisma.employee.findMany({ where: { id: { not: medTl.id }, employmentStatus: working, OR: [{ reportingManagerId: medTl.id }, { tl: medTl.name }] }, select: { id: true, name: true } });
    r = await preview(medTl.id, { department: 'Education', roleKey: 'r:RECRUITER', team: 'Team-A', seat: 'auto' });
    if (medKids.length) {
      ok('One TL: with nobody else to hand the team to, the card still refuses until "leave them without a lead for now" is chosen', r.body.ok === false && (r.body.options.team.candidates || []).length === 0, `${medKids.length} people`);
      r = await transfer(medTl.id, { department: 'Education', roleKey: 'r:RECRUITER', team: 'Team-A', seat: 'auto', teamMode: 'leave' });
      ok('One TL: leaving the team without a lead is accepted, with a warning', r.status === 200 && (r.body.transfer.warnings || []).some((w) => /no TL|no lead|no reporting/i.test(w)), (r.body.transfer && r.body.transfer.warnings || [])[0]);
      const orphaned = await prisma.employee.findMany({ where: { id: { in: medKids.map((x) => x.id) } } });
      ok('One TL: the people who named the TL no longer point at somebody who works in another department', orphaned.every((e) => !e.reportingManagerId && lc(e.tl) !== lc(medTl.name)));
    } else {
      r = await transfer(medTl.id, { department: 'Education', roleKey: 'r:RECRUITER', team: 'Team-A', seat: 'auto' });
      ok('One TL: transferred (no people reported to them)', r.status === 200, r.body.error);
    }
    const medTlNow = await openSeat(medTl.id);
    ok('One TL: the Medical TL seat is vacant, the person now sits in an Education seat of Team A', !(await seatHolder(medSeat.id)) && !!medTlNow && medTlNow.position.department === 'Education', medTlNow && medTlNow.position.code);
    ok('One TL: their team became the Education team of the seat they took', lc((await emp(medTl.id)).team).replace(/[^a-z]/g, '') === 'teama');

    // promote a Medical recruiter into the vacated TL seat
    const promoSeatBefore = await openSeat(recruiterToPromote.id);
    r = await preview(recruiterToPromote.id, { department: 'Medical', roleKey: 'd:TL', seat: medSeat.code });
    ok('Promotion: Recruiter -> TL in the same department into the vacated TL seat is allowed and shows the people they will lead', r.body.ok === true
      && (r.body.lines || []).some((l) => l.label === 'Their new team' || medKids.length === 0) && (r.body.lines || []).some((l) => l.label === 'Role'), (r.body.blockers || [])[0] || (r.body.lines || []).map((l) => l.label).join(','));
    r = await transfer(recruiterToPromote.id, { department: 'Medical', roleKey: 'd:TL', seat: medSeat.code });
    ok('Promotion: saved', r.status === 200, r.body.error);
    const promo = await emp(recruiterToPromote.id);
    ok('Promotion: designation TL and the login is a TL in HRMS and ATS (not a Recruiter any more)', promo.designation === 'TL' && promo.user.atsRole === 'TL' && promo.user.hrmsRole === 'TL' && promo.user.role === 'TL', `${promo.user.role}/${promo.user.hrmsRole}/${promo.user.atsRole}`);
    const promoId = await identity.resolveIdentity(promo.userId);
    ok('Promotion: signing in resolves a TL with the ATS workspace', promoId && promoId.atsRole === 'TL' && promoId.ats !== false, promoId && `${promoId.hrmsRole}/${promoId.atsRole}`);
    const nowSeat = await openSeat(promo.id);
    ok('Promotion: they hold the TL seat, and their old recruiter seat is vacant for a replacement', nowSeat && nowSeat.position.id === medSeat.id && (!promoSeatBefore || !(await seatHolder(promoSeatBefore.positionId))), nowSeat && nowSeat.position.code);
    const adopted = medKids.length ? await prisma.employee.findMany({ where: { id: { in: medKids.map((x) => x.id).filter((i) => i !== promo.id) }, employmentStatus: working } }) : [];
    ok('Promotion: the people left without a TL in that team now report to the new TL', adopted.length === 0 || adopted.every((e) => e.reportingManagerId === promo.id && lc(e.tl) === lc(promo.name)), `${adopted.length} people`);
    const vac = await require('../src/utils/vacancies').view();
    ok('Promotion: Vacancies counts them as a TL now (read from the designation, no manual fix)', JSON.stringify(vac).includes(promo.name), '');

    // ================= A PLAIN DEPARTMENT MOVE (what the older screen sends) still works =================
    // (the app's own BDE-seat job turns a BDE-desk recruiter into an ATS BDE a little after a seat is given: let it finish, so the role is read as it is)
    await require('../src/utils/bdeSeatHandover').run().catch(() => {});
    const bdeBefore = await openSeat(plainBde.id);
    const bdeLoginBefore = (await emp(plainBde.id)).user;
    r = await transfer(plainBde.id, { department: 'Education', reason: 'Moved in Recruiter & BDE > Departments & teams' });
    ok('Plain move: {department, reason} only still works', r.status === 200 && r.body.department === 'Education', r.body.error);
    const pb = await emp(plainBde.id);
    ok('Plain move: role unchanged (still the same designation and ATS role), login follows the department', pb.designation === plainBde.designation && pb.user.atsRole === bdeLoginBefore.atsRole && pb.user.atsDepartment === 'Education' && pb.user.atsScopeDepartments === 'Education', `${pb.user.atsRole}/${pb.user.atsDepartment}`);
    ok('Plain move: the BDE seat is closed (it belongs to BDE), no seat is invented, the person is told', (!bdeBefore || (await prisma.positionAssignment.findFirst({ where: { id: bdeBefore.id } })).toDate) && !(await openSeat(pb.id)) && (r.body.transfer.warnings || []).some((w) => /seat/i.test(w)), (r.body.transfer.warnings || []).join(' | ').slice(0, 140));
    ok('Plain move: a reporting line that points at a BDE lead is not left behind', !pb.tl || lc(pb.tl) !== lc(plainBde.tl) || lc(plainBde.tl) === '');

    // ================= THE FOUNDER'S CARD: a BDE-desk person moved to Medical as a Recruiter =================
    r = await preview(plainBde.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto' });
    ok('Card: role BDE/Employee -> Recruiter in a new department shows department, role, login access and the reporting line before saving',
      r.body.ok === true && ['Department', 'Role', 'Login access', 'Reports to'].every((l) => (r.body.lines || []).some((x) => x.label === l)), (r.body.lines || []).map((x) => `${x.label}: ${x.to}`).join(' | ').slice(0, 220));
    r = await transfer(plainBde.id, { department: 'Medical', roleKey: 'r:RECRUITER', seat: 'auto' });
    ok('Card: saved', r.status === 200, r.body.error);
    const pr = await emp(plainBde.id);
    ok('Card: the login is a Recruiter in ATS and an Employee in HRMS on the Medical desk, with its scope following', pr.user.atsRole === 'RECRUITER' && pr.user.hrmsRole === 'EMPLOYEE' && pr.user.atsDepartment === 'Medical' && pr.user.atsScopeDepartments === 'Medical' && pr.user.atsAccess === true, `${pr.user.role}/${pr.user.hrmsRole}/${pr.user.atsRole}/${pr.user.atsDepartment}`);
    ok('Card: the TL of the new department became their TL (one TL there, so no choice needed)', lc(pr.tl) === lc(promo.name) && pr.reportingManagerId === promo.id, `${pr.tl}`);
    // a Recruiter made a plain Employee leaves the recruiter seat, and has no ATS work any more
    const demoTarget = await prisma.employee.findFirst({ where: { department: 'Education', designation: 'Employee', employmentStatus: working, userId: { not: null }, user: { is: { atsRole: 'RECRUITER' } }, id: { not: plainBde.id } }, orderBy: { name: 'desc' }, include: { user: true } });
    const seatBeforeDemote = await openSeat(demoTarget.id);
    r = await transfer(demoTarget.id, { department: 'Education', roleKey: 'd:Employee' });
    const dem = await emp(demoTarget.id);
    ok('Demotion: Recruiter -> plain Employee (HRMS only): the ATS role goes, the recruiter seat is closed, and the card said so', r.status === 200 && dem.user.atsRole === 'EMPLOYEE' && dem.user.hrmsRole === 'EMPLOYEE'
      && (!seatBeforeDemote || !(await openSeat(dem.id))) && (r.body.transfer.warnings || []).some((w) => /seat/i.test(w)), `${dem.user.atsRole}`);
    const demId = await identity.resolveIdentity(dem.userId);
    ok('Demotion: signing in shows no ATS work for them', demId && demId.atsRole !== 'RECRUITER', demId && `${demId.hrmsRole}/${demId.atsRole}`);

    // ================= SEAT RULES =================
    const someRecruiter = await prisma.employee.findFirst({ where: { department: 'Education', designation: 'Employee', employmentStatus: working, userId: { not: null }, id: { notIn: [plainBde.id, demoTarget.id] } }, orderBy: { name: 'asc' }, include: { user: true } });
    const heldSeat = await prisma.positionAssignment.findFirst({ where: { toDate: null, position: { department: 'Education', kind: 'RECRUITER' }, employeeId: { not: someRecruiter.id } }, include: { position: true, employee: true } });
    r = await preview(someRecruiter.id, { department: 'Education', seat: heldSeat.position.code });
    ok('Seat rules: a seat held by somebody else is refused, naming who holds it', r.body.ok === false && (r.body.blockers || []).join(' ').includes(heldSeat.employee.name), (r.body.blockers || [])[0]);
    r = await preview(someRecruiter.id, { department: 'Education', seat: medSeat.code });
    ok('Seat rules: a seat of another department is refused', r.body.ok === false && /belongs to|not Education/.test((r.body.blockers || []).join(' ')), (r.body.blockers || [])[0]);
    const vacantTl = tlSeats.find((s) => lc(s.department) === 'education' && s.id === teamA.seat.id); // vacated above
    r = await preview(someRecruiter.id, { department: 'Education', seat: vacantTl.code });
    ok('Seat rules: a TL seat for a Recruiter is refused as the wrong kind of seat', r.body.ok === false && /seat, but the role/.test((r.body.blockers || []).join(' ')), (r.body.blockers || [])[0]);
    r = await preview(someRecruiter.id, { department: 'Education', seat: 'NO-SUCH-SEAT' });
    ok('Seat rules: a seat that does not exist is refused in plain words', r.body.ok === false && /no seat/i.test((r.body.blockers || []).join(' ')), (r.body.blockers || [])[0]);

    // ================= ONE TRANSACTION: a seat taken while the card was open leaves nothing half-done =================
    {
      const t = await prisma.employee.findFirst({ where: { department: 'Education', designation: 'Employee', employmentStatus: working, userId: { not: null }, id: { notIn: [someRecruiter.id, plainBde.id, demoTarget.id] } }, include: { user: true } });
      const { planTransfer, applyTransfer } = require('../src/utils/employeeTransfer');
      const { designationRows } = require('../src/utils/employeeAdmin');
      const rows = await designationRows();
      // one more vacancy to race for (the earlier steps used the others)
      const another = await prisma.position.findFirst({ where: { department: 'Medical', kind: 'RECRUITER', active: false }, orderBy: { code: 'asc' } });
      if (another) await prisma.position.update({ where: { id: another.id }, data: { active: true } });
      const medSeats = await prisma.position.findMany({ where: { department: 'Medical', kind: 'RECRUITER', active: true } });
      let target = null;
      for (const s of medSeats) { if (!(await seatHolder(s.id))) { target = s; break; } }
      if (target) {
        const plan = await planTransfer({ actor: superAdmin, employeeId: t.id, body: { department: 'Medical', seat: target.code, roleKey: 'r:RECRUITER' }, allowedRows: rows });
        const snap = JSON.stringify([(await emp(t.id)).department, (await emp(t.id)).user.atsDepartment, ((await openSeat(t.id)) || { position: { code: null } }).position.code]);
        // somebody else sits in the seat before the card is confirmed
        await prisma.positionAssignment.create({ data: { positionId: target.id, employeeId: someRecruiter.id, fromDate: new Date().toISOString().slice(0, 10) } });
        let threw = null;
        try { await applyTransfer({ actor: superAdmin, plan }); } catch (e) { threw = e; }
        const snap2 = JSON.stringify([(await emp(t.id)).department, (await emp(t.id)).user.atsDepartment, ((await openSeat(t.id)) || { position: { code: null } }).position.code]);
        ok('One transaction: the seat was taken meanwhile -> a plain refusal, and department, login and seat are exactly as before', plan.ok && threw && threw.status === 409 && snap === snap2, threw && threw.message);
      } else { ok('One transaction: (no vacant Medical recruiter seat in the copy to race for)', true); }
    }
  } catch (err) {
    fail += 1; console.log('FAIL  test run crashed:', err && err.stack || err);
  } finally {
    server.close();
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
