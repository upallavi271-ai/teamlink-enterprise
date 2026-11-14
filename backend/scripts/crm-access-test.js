#!/usr/bin/env node
/**
 * WHO MAY OPEN THE CRM (founder 2026-11-14: "bde ki crm kanipinchakudadhu - only Super Admin, HR Purna and the developer logins, evariki kanipinchakudadhu").
 * crm/settings.js: the sales-team list the 2026-11-11 seeding filled with BDEs, BDE TLs, managers and record owners is emptied ONCE; the agreement HR
 * approver (Purna, employee TL309 by default) joins as Sales manager; Super Admin / Admin open it by their role; after that nothing puts anyone back.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4050. Nothing real is called.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-access-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-access-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4050;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-access-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');
const leftLogin = require('../src/utils/leftLogin'); // the server turns anyone who has left into a former employee: not a working login for this test

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 320)}` : ''}`); } };
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

const STAFF = ['HR', 'EMPLOYEE', 'RECRUITER', 'TL', 'STL', 'BDE', 'MANAGER', 'ASSISTANT_MANAGER']; // real working logins (the sandbox also holds former employees)
(async () => {
  await DB.ensure();
  const ready = async (u) => { await prisma.user.update({ where: { id: u.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } }); return resolveIdentity(u.id); };
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  // Purna stands in as an ordinary (non-admin) login that is the agreement's HR approver by employee code
  let hr = null;
  for (const e of await prisma.employee.findMany({ where: { userId: { not: null } }, select: { userId: true, employeeCode: true }, take: 400 })) {
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.findUnique({ where: { id: e.userId } });
    if (u && u.status === 'Active' && STAFF.includes(u.role) && !u.clientId && !u.candidateId && !leftLogin.hasLeft(await resolveIdentity(u.id))) { hr = { user: u, code: e.employeeCode }; break; }
  }
  let bde = null;
  for (const u of await prisma.user.findMany({ where: { status: 'Active', role: { in: STAFF }, clientId: null, candidateId: null, id: { not: hr.user.id } }, orderBy: { role: 'asc' }, take: 60 })) {
    // eslint-disable-next-line no-await-in-loop
    if (!leftLogin.hasLeft(await resolveIdentity(u.id))) { bde = u; break; }
  }
  if (process.env.TEST_DEBUG2) console.log('PICKED', JSON.stringify({ hr: hr && { id: hr.user.id, role: hr.user.role, status: hr.user.status, code: hr.code, resolved: (await resolveIdentity(hr.user.id)).role }, bde: bde && { id: bde.id, role: bde.role, resolved: (await resolveIdentity(bde.id)).role } }));
  check('the sandbox has the logins this test needs', !!(adminRow && hr && bde), { admin: !!adminRow, hr: !!hr, bde: !!bde });

  // the state as production is: a team list seeded with BDEs, never narrowed
  await prisma.appSetting.upsert({ where: { key: 'agreementWorkflow' }, create: { key: 'agreementWorkflow', value: JSON.stringify({ approvers: [hr.code], allowHrDesk: false, hrLabel: 'HR' }) }, update: { value: JSON.stringify({ approvers: [hr.code], allowHrDesk: false, hrLabel: 'HR' }) } });
  const seeded = { salesTeam: [{ userId: bde.id, name: bde.name, role: 'rep' }, { userId: 'ghost-tl', name: 'A BDE TL', role: 'manager' }], teamSeeded: true };
  await prisma.appSetting.upsert({ where: { key: 'crm.settings' }, create: { key: 'crm.settings', value: JSON.stringify(seeded) }, update: { value: JSON.stringify(seeded) } });

  console.log('The one-time narrowing');
  const st = await SETTINGS.load({ fresh: true });
  const ids = st.salesTeam.map((m) => m.userId);
  check('the BDE is off the team list', !ids.includes(bde.id), ids);
  check('the BDE TL (and everyone else seeded) is off it too', !ids.includes('ghost-tl'), ids);
  check('the HR approver is on it, as a Sales manager', st.salesTeam.length === 1 && ids[0] === hr.user.id && st.salesTeam[0].role === 'manager', st.salesTeam);
  const raw = JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'crm.settings' } })).value);
  check('it is written down, so it never runs again', raw.accessSet === true && raw.salesTeam.length === 1, raw.accessSet);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (u) => ({ Authorization: `Bearer ${jwt.sign({ ...tokenPayload(await ready(u)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const aAdmin = await tok(adminRow); const aHr = await tok(hr.user); const aBde = await tok(bde);

  console.log('Who gets in');
  const meB = await call('GET', '/auth/me', null, aBde);
  check('the BDE login is told it has no CRM (the menu is built from this)', meB.status === 200 && !meB.body.crmRole, meB.body && meB.body.crmRole);
  const meH = await call('GET', '/auth/me', null, aHr); if (process.env.TEST_DEBUG2) console.log('HR /auth/me:', JSON.stringify({ s: meH.status, crmRole: meH.body && meH.body.crmRole, err: meH.body && meH.body.error, role: meH.body && meH.body.role })); if (process.env.TEST_DEBUG2) console.log('HR /crm/me:', JSON.stringify(await call('GET', '/crm/me', null, aHr)).slice(0, 300));
  check('the HR approver is a CRM Sales manager', meH.status === 200 && meH.body.crmRole === 'tl', meH.body && meH.body.crmRole);
  const meA = await call('GET', '/auth/me', null, aAdmin);
  check('the Super Admin has the CRM', meA.status === 200 && meA.body.crmRole === 'admin', meA.body && meA.body.crmRole);
  check('the BDE cannot open the CRM data (403)', (await call('GET', '/crm/me', null, aBde)).status === 403 && (await call('GET', '/crm/leads', null, aBde)).status === 403 && (await call('GET', '/crm/deals', null, aBde)).status === 403);
  check('the BDE cannot reach invoices, follow-ups or the dashboard either', [(await call('GET', '/crm/invoices', null, aBde)).status, (await call('GET', '/crm/tasks', null, aBde)).status, (await call('GET', '/crm/dashboard', null, aBde)).status].every((s) => s === 403));
  check('the HR approver opens the CRM', (await call('GET', '/crm/me', null, aHr)).status === 200 && (await call('GET', '/crm/leads', null, aHr)).status === 200);
  check('the Super Admin opens the CRM', (await call('GET', '/crm/me', null, aAdmin)).status === 200);

  console.log('After that the list is the Admin\'s to edit');
  const put = await call('PUT', '/crm/settings', { salesTeam: [{ userId: hr.user.id, name: hr.user.name, role: 'manager' }, { userId: bde.id, name: bde.name, role: 'rep' }] }, aAdmin);
  check('the Admin adds a salesperson in CRM settings', put.status === 200 && put.body.settings.salesTeam.some((m) => m.userId === bde.id), put.body && put.body.error);
  check('that person now opens the CRM', (await call('GET', '/crm/me', null, aBde)).status === 200);
  const again = await SETTINGS.load({ fresh: true });
  check('and nothing narrows the list again', again.salesTeam.some((m) => m.userId === bde.id) && again.salesTeam.length === 2, again.salesTeam.map((m) => m.userId));
  const removed = await call('PUT', '/crm/settings', { salesTeam: [{ userId: hr.user.id, name: hr.user.name, role: 'manager' }] }, aAdmin);
  check('the Admin can take them off again, and they are shut out at once', removed.status === 200 && (await call('GET', '/crm/me', null, aBde)).status === 403);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
