// Interview tell-them / reminders test lib (SANDBOX ONLY).
const TLT = require('./tl-target');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const crypto = require('crypto');
const API = TLT.API;
if (!TLT.sandbox) throw new Error('sandbox only');
const stamp = Date.now().toString(36);
const OK = 'zziv-sandbox.in';
const made = { users: [], employees: [], candidates: [], clients: [], requirements: [], applications: [] };
async function mkUser(label, data, emp) {
  const u = await prisma.user.create({ data: {
    name: `ZZTEST IV ${label}`, email: `zziv.${label.toLowerCase().replace(/\W+/g, '')}.${stamp}@${OK}`, username: `zziv.${label.toLowerCase().replace(/\W+/g, '')}.${stamp}@${OK}`,
    passwordHash: crypto.randomBytes(24).toString('hex'), status: 'Active', atsAccess: true, hrmsAccess: true, accountsAccess: false, hrmsRole: 'EMPLOYEE', ...data } });
  made.users.push(u.id);
  if (emp !== null) {
    const e = await prisma.employee.create({ data: { name: u.name, email: u.email, userId: u.id, employeeCode: `ZZIV${stamp}${made.users.length}`, department: data.atsDepartment || 'Education', employmentStatus: 'Active', phone: `90000001${String(made.users.length).padStart(2, '0')}`, ...(emp || {}) } }).catch((err) => { console.log('employee create failed:', err.message.split('\n').pop()); return null; });
    if (e) made.employees.push(e.id);
  }
  return u;
}
const token = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(u, method, p, data, raw) {
  let r;
  for (let i = 0; i < 240; i += 1) {
    try { r = await fetch(`${API}${p}`, { method, headers: { ...(u ? { Authorization: `Bearer ${token(u)}` } : {}), 'Content-Type': 'application/json', 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: data === undefined ? undefined : JSON.stringify(data) }); break; } catch (e) { const code = JSON.stringify(e && e.cause && (e.cause.code || (e.cause.errors || []).map((x) => x.code))); const refused = code.includes('ECONNREFUSED'); const reset = /ECONNRESET|UND_ERR|socket/i.test(code + String(e && e.cause && e.cause.message)); if (reset && method === 'POST') { for (let k = 0; k < 200; k += 1) { try { const h = await fetch(`${API}/health`); if (h.ok) break; } catch { /* still down */ } await new Promise((x) => setTimeout(x, 1500)); } return { status: 599, body: { error: 'connection reset (server restarted)' }, text: '' }; } if (i === 239 || !(refused || reset)) throw e; await new Promise((x) => setTimeout(x, 1500)); }
  }
  if (raw) return r;
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
}
const get = (u, p) => call(u, 'GET', p);
const flaky = (r) => r.status === 599 || (r.status === 500 && r.body && r.body.error === 'Something went wrong');
async function retrying(u, method, p, d) {
  let r = await call(u, method, p, d || {});
  const bm = /\/ats\/interviews\/([^/]+)\/(book|reschedule|cancel)$/.exec(p);
  for (let i = 0; bm && i < 4 && flaky(r); i += 1) {
    // the server restarted under the request: did it get through? (book: a slot exists; others: just try once more)
    const a = await prisma.application.findUnique({ where: { id: bm[1] }, select: { interviewStatus: true } });
    if (bm[2] === 'book' && a && a.interviewStatus) return { status: 200, body: { ok: true, kind: 'scheduled', recovered: true }, text: '' };
    await new Promise((x) => setTimeout(x, 3000)); r = await call(u, method, p, d || {});
  }
  for (let i = 0; i < 4 && flaky(r) && !/[/](book|reschedule|cancel)$/.test(p); i += 1) { await new Promise((x) => setTimeout(x, 4000)); r = await call(u, method, p, d || {}); }
  return r;
}
const post = (u, p, d) => retrying(u, 'POST', p, d);
const put = (u, p, d) => retrying(u, 'PUT', p, d);
const patch = (u, p, d) => call(u, 'PATCH', p, d || {});
const del = (u, p) => call(u, 'DELETE', p);
let pass = 0; let fail = 0;
function check(name, ok, extra) { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  :: ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { prisma, mkUser, token, get, post, put, patch, del, call, made, check, sleep, API, stamp, OK, results: () => ({ pass, fail }), BACK };
