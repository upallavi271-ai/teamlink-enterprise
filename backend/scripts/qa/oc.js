// Omnichannel test lib (sandbox only).
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
const OK = 'zzoc-sandbox.in';
const made = { users: [], employees: [], candidates: [], clients: [], requirements: [], applications: [] };
async function mkUser(label, data, emp) {
  const u = await prisma.user.create({ data: {
    name: `ZZTEST OC ${label}`, email: `zzoc.${label.toLowerCase().replace(/\W+/g, '')}.${stamp}@${OK}`, username: `zzoc.${label.toLowerCase().replace(/\W+/g, '')}.${stamp}@${OK}`,
    passwordHash: crypto.randomBytes(24).toString('hex'), status: 'Active', atsAccess: true, hrmsAccess: true, accountsAccess: false, hrmsRole: 'EMPLOYEE', ...data } });
  made.users.push(u.id);
  if (emp !== null) {
    const e = await prisma.employee.create({ data: { name: u.name, email: u.email, userId: u.id, employeeCode: `ZZOC${stamp}${made.users.length}`, department: data.atsDepartment || 'Education', employmentStatus: 'Active', phone: `90000000${String(made.users.length).padStart(2, '0')}`, ...(emp || {}) } }).catch((err) => { console.log('employee create failed:', err.message.split('\n').pop()); return null; });
    if (e) made.employees.push(e.id);
  }
  return u;
}
const token = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(u, method, p, data, raw) {
  let r;
  for (let i = 0; i < 40; i += 1) {
    try { r = await fetch(`${API}${p}`, { method, headers: { ...(u ? { Authorization: `Bearer ${token(u)}` } : {}), 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: data === undefined ? undefined : JSON.stringify(data) }); break; } catch (e) { if (i === 39) throw e; await new Promise((x) => setTimeout(x, 1000)); }
  }
  if (raw) return r;
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
}
const get = (u, p) => call(u, 'GET', p);
const post = (u, p, d) => call(u, 'POST', p, d || {});
const put = (u, p, d) => call(u, 'PUT', p, d || {});
const patch = (u, p, d) => call(u, 'PATCH', p, d || {});
const del = (u, p) => call(u, 'DELETE', p);
let pass = 0; let fail = 0;
function check(name, ok, extra) { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  :: ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500) : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { prisma, mkUser, token, get, post, put, patch, del, call, made, check, sleep, API, stamp, OK, results: () => ({ pass, fail }), BACK };
