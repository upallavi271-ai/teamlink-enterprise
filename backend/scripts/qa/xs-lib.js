const TLT = require('./tl-target'); // TL_API=http://localhost:4011 -> sandbox
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
require(path.join(BACK, 'src/utils/seatRelease')); // installs the Employee-write middleware in THIS process too (direct writes in tests)
const crypto = require('crypto');

const API = TLT.API;
const tag = Date.now().toString(36);
const made = { users: [], employees: [], positions: [], clients: [], requirements: [], records: [] };
let pass = 0; let fail = 0;
const ok = (c, m, extra) => { if (c) { pass += 1; console.log('  ok  ', m); } else { fail += 1; console.log('  FAIL', m, extra === undefined ? '' : JSON.stringify(extra)); } };

async function mkUser(label, data) {
  const u = await prisma.user.create({ data: {
    name: `ZZTEST ${label}`, email: `zztest.${label.toLowerCase().replace(/\W+/g, '')}.${tag}${Math.random().toString(36).slice(2, 5)}@example.test`,
    passwordHash: crypto.randomBytes(24).toString('hex'), status: 'Active', atsAccess: false, hrmsAccess: true, accountsAccess: false, ...data,
  } });
  made.users.push(u.id);
  return u;
}
let n = 0;
const today0 = new Date().toISOString().slice(0, 10);
async function mkEmp(label, data = {}, userData = null) {
  n += 1;
  let userId = null;
  if (userData) { const u = await mkUser(label, userData); userId = u.id; }
  const e = await prisma.employee.create({ data: {
    employeeCode: `ZZT${tag}${n}`.toUpperCase().slice(0, 14), name: `ZZTEST ${label}`, email: `zztest.${label.toLowerCase().replace(/\W+/g, '')}.${tag}${n}@example.test`,
    department: 'Education', employmentStatus: 'Active', userId, ...data,
  } });
  made.employees.push(e.id);
  // EXIT APPROVAL RULE (2026-10-13): nobody becomes Relieved / Exited without an approved exit. These tests are about the SEAT, not the approval,
  // so each person gets a closed (already Relieved) resignation record - what a history file load leaves - which the guard accepts (code ALREADY).
  await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: e.id, title: 'ZZTEST exit (seat test)', status: 'Relieved', date: today0 } }).catch(() => null);
  return e;
}
async function mkSeat(code, data = {}) {
  const p = await prisma.position.create({ data: { code: `ZZTEST-${code}-${tag}`.toUpperCase(), department: 'Education', ...data } });
  made.positions.push(p.id);
  return p;
}
async function seatIn(positionId, employeeId, fromDate = '2026-10-01') {
  return prisma.positionAssignment.create({ data: { positionId, employeeId, fromDate } });
}
const token = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(u, method, p, data) {
  let r;
  for (let i = 0; i < 160; i += 1) {
    try { r = await rawFetch(u, method, p, data); break; } catch (e) { if (i === 159) throw e; await new Promise((res) => setTimeout(res, 1500)); }
  }
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function callOld(u, method, p, data) {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token(u)}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(data || {}) });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const get = (u, p) => call(u, 'GET', p);
function rawFetch(u, method, p, data) {
  return fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token(u)}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(data || {}) });
}

async function cleanup() {
  const eids = made.employees; const uids = made.users; const pids = made.positions;
  const out = {};
  out.assign = (await prisma.positionAssignment.deleteMany({ where: { OR: [{ employeeId: { in: eids } }, { positionId: { in: pids } }] } })).count;
  out.fnf = (await prisma.fnfRequest.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.rd = (await prisma.resignationDetail.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.rec = (await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.reqs = (await prisma.requirement.deleteMany({ where: { id: { in: made.requirements } } })).count;
  out.clients = (await prisma.client.deleteMany({ where: { id: { in: made.clients } } })).count;
  out.stat = (await prisma.stationeryIssue.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.att = (await prisma.attendance.deleteMany({ where: { employeeId: { in: eids } } })).count;
  const allIds = [...eids, ...uids, ...pids, ...made.clients, ...made.requirements, ...made.records];
  out.audit = (await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: uids } }, { entityId: { in: allIds } }, { actorName: { contains: 'ZZTEST' } }] } })).count;
  out.notes = (await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: uids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } })).count;
  out.emps = (await prisma.employee.deleteMany({ where: { id: { in: eids } } })).count;
  out.pos = (await prisma.position.deleteMany({ where: { id: { in: pids } } })).count;
  out.users = (await prisma.user.deleteMany({ where: { id: { in: uids } } })).count;
  return out;
}
const summary = () => { console.log(`\nRESULT: ${pass} passed, ${fail} failed`); return fail; };
module.exports = { prisma, tag, made, mkUser, mkEmp, mkSeat, closedExit, seatIn, call, get, token, cleanup, ok, summary, API, TLT };
// (exit approval rule, 2026-10-13) a closed resignation record so the exit guard accepts a direct status change in these seat tests
async function closedExit(employeeId) {
  return prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId, title: 'ZZTEST exit (seat test)', status: 'Relieved', date: today0 } }).catch(() => null);
}
module.exports.closedExit = closedExit;
