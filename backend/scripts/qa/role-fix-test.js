const TLT = require('./tl-target'); // TL_API=http://localhost:4011 -> TEST SANDBOX API + sandbox.db (agent-rules.md)
require('dotenv').config({ path: 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/.env' });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const API = TLT.API;
let pass = 0; let fail = 0;
const ok = (c, m, x = '') => { if (c) pass += 1; else fail += 1; console.log(c ? 'PASS' : 'FAIL', m, x); };
const tok = (u) => ({ Authorization: `Bearer ${jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '10m' })}`, 'Content-Type': 'application/json' });
const created = { users: [], emps: [] };

async function persona(tag, { role = 'EMPLOYEE', atsRole, hrmsRole, dept, team, designation = 'Employee' }) {
  const u = await prisma.user.create({ data: {
    name: `ZZTEST ROLEFIX ${tag}`, email: `zztest-rolefix-${tag.toLowerCase()}@example.test`,
    passwordHash: `!disabled-${crypto.randomBytes(6).toString('hex')}`, role, atsRole, hrmsRole,
    hrmsAccess: true, atsAccess: true, accountsAccess: false, atsDepartment: dept,
  } });
  created.users.push(u.id);
  const e = await prisma.employee.create({ data: {
    employeeCode: `ZZTEST-RF-${tag}`, name: u.name, userId: u.id, department: dept, team: team || null, designation, employmentStatus: 'Active',
  } });
  created.emps.push(e.id);
  return u;
}
async function get(u, path) { const r = await fetch(API + path, { headers: tok(u) }); let j = null; try { j = await r.json(); } catch { /* */ } return { s: r.status, j }; }
const n = (j) => (Array.isArray(j) ? j.length : (j && (j.total ?? (j.rows || j.data || j.requirements || j.items || []).length)));

(async () => {
  try {
    // F1 — TL without a seat, Education Team-A.
    const tl = await persona('TL', { atsRole: 'TL', hrmsRole: 'TL', dept: 'Education', team: 'Team-A', designation: 'Team Lead' });
    const tlReq = await get(tl, '/requirements?limit=5');
    const eduTotal = await prisma.requirement.count({ where: { department: 'Education' } });
    ok(tlReq.s === 200 && n(tlReq.j) < eduTotal, 'TL without seat no longer gets the whole department', `TL sees ${n(tlReq.j)} of ${eduTotal} Education requirements`);

    // F2 — TL opening a senior / other-team employee record.
    const am = await prisma.employee.findFirst({ where: { designation: { contains: 'Assistant Manager' } }, select: { id: true, name: true } });
    if (am) { const r = await get(tl, `/employees/${am.id}`); ok(r.s === 403, 'TL cannot open a senior employee record', `${am.name}: ${r.s}`); }
    const teamB = await prisma.employee.findFirst({ where: { department: 'Education', team: { in: ['Team-B', 'Team B'] } }, select: { id: true, name: true } });
    if (teamB) { const r = await get(tl, `/employees/${teamB.id}`); ok(r.s === 403, 'TL cannot open a peer-team employee record', `${teamB.name}: ${r.s}`); }

    // F7 — R&D employee and plain employee: no ATS.
    const rnd = await persona('RND', { atsRole: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', dept: 'R&D' });
    const me = await get(rnd, '/auth/me');
    ok(me.s === 200 && me.j.products && me.j.products.ats === false && me.j.products.hrms === true, 'R&D employee: HRMS yes, ATS no', JSON.stringify(me.j.products));
    const rndReq = await get(rnd, '/requirements');
    ok(rndReq.s === 403, 'R&D employee: ATS API refused', String(rndReq.s));
    const rndTl = await persona('RNDTL', { atsRole: 'TL', hrmsRole: 'TL', dept: 'R&D', designation: 'Team Lead' });
    const me2 = await get(rndTl, '/auth/me');
    ok(me2.j.products.ats === false, 'R&D TL: no ATS either', JSON.stringify(me2.j.products));
    const plain = await persona('EMP', { atsRole: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', dept: 'IT' });
    const me3 = await get(plain, '/auth/me');
    ok(me3.j.products.ats === false, 'plain Employee (no recruiting role): no ATS', JSON.stringify(me3.j.products));

    // F8 — HR: Internal Hiring yes, Recruiter & BDE no.
    const hr = await persona('HR', { atsRole: 'HR', hrmsRole: 'HR', dept: 'HR', designation: 'HR Executive' });
    const hrMe = await get(hr, '/auth/me');
    const ih = hrMe.j.access && hrMe.j.access.interviews && hrMe.j.access.interviews.features['Internal Hiring'];
    ok(ih && ih.view && ih.approve && ih.create, 'HR can view + act on Internal Hiring', JSON.stringify(ih));
    const rb = hrMe.j.access && hrMe.j.access.recruiterbde;
    ok(!rb || !rb.moduleEnabled, 'HR has no Recruiter & BDE module', JSON.stringify(rb && rb.moduleEnabled));
    const hrIh = await get(hr, '/ats/internal-hiring');
    ok(hrIh.s === 200, 'HR internal-hiring list opens', String(hrIh.s));
    const hrReq = await get(hr, '/requirements');
    const reqRows = Array.isArray(hrReq.j) ? hrReq.j : (hrReq.j.rows || hrReq.j.requirements || []);
    ok(hrReq.s === 200 && reqRows.every((r) => r.internal), 'HR requirements = internal only', `${reqRows.length} row(s)`);

    // F3 + F5 — recruiter without a seat: no department seat history, no company numbers.
    const rec = await persona('REC', { atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', dept: 'Medical', designation: 'Recruiter' });
    const hist = await get(rec, '/positions/history');
    const seats = hist.j && (hist.j.positions || hist.j.seats || hist.j.rows || (Array.isArray(hist.j) ? hist.j : []));
    ok(hist.s === 403 || (Array.isArray(seats) && seats.length === 0), 'recruiter without a seat sees no seat history', `${hist.s} ${Array.isArray(seats) ? seats.length : ''}`);
    const dash = await get(rec, '/dashboard');
    ok(dash.s === 200 && (dash.j.auditLog || []).length === 0 && dash.j.invoicesPending == null, 'recruiter dashboard: no audit trail, no invoice numbers', JSON.stringify({ audit: (dash.j.auditLog || []).length, inv: dash.j.invoicesPending, head: dash.j.activeEmployees }));

    // F6 — adding a candidate to a requirement outside scope.
    const req = await prisma.requirement.findFirst({ where: { department: 'Education' }, select: { id: true } });
    const cand = await prisma.candidate.findFirst({ select: { id: true } });
    const r6 = await fetch(`${API}/applications`, { method: 'POST', headers: tok(rec), body: JSON.stringify({ candidateId: cand.id, requirementId: req.id }) });
    ok(r6.status === 403 || r6.status === 409, 'recruiter cannot add to an out-of-scope requirement', String(r6.status));
  } finally {
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: created.emps } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.notification.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: created.emps } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    console.log(`cleanup: ${created.users.length} users, ${created.emps.length} employees removed; ${pass}/${pass + fail} passed`);
    await prisma.$disconnect();
  }
})();
