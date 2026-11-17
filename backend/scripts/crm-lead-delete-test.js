#!/usr/bin/env node
/**
 * DELETE A LEAD FROM ITS RECORD (founder 2026-11-17): the lead goes with its own activities and follow-ups; a converted lead's
 * account and deal (and what was carried over to them) stay. SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4078.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-lead-delete-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-leaddel-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4078;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'leaddel-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const n = async (sql, ...a) => Number((await prisma.$queryRawUnsafe(sql, ...a))[0].n);
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

  const L = await call('POST', '/crm/leads', { company: `ZZTEST Del One ${P}`, contactName: 'A Person', phone: `95${String(Date.now()).slice(-8)}` }, tA);
  const id = L.body.lead.id;
  await call('POST', '/crm/activities', { kind: 'call', subject: 'First call', leadId: id, followUp: { title: 'Call again', dueDate: today } }, tA);
  const before = [await n('SELECT COUNT(*) n FROM "CrmActivity" WHERE "leadId" = ?', id), await n('SELECT COUNT(*) n FROM "CrmTask" WHERE "leadId" = ?', id)];
  const del = await call('DELETE', `/crm/lead/${id}`, null, tA);
  const after = [await n('SELECT COUNT(*) n FROM "CrmLead" WHERE "id" = ?', id), await n('SELECT COUNT(*) n FROM "CrmActivity" WHERE "leadId" = ?', id), await n('SELECT COUNT(*) n FROM "CrmTask" WHERE "leadId" = ?', id)];
  check('1 a lead with a call and follow-ups is deleted with them', del.status === 200 && before[0] >= 1 && before[1] >= 1 && after.every((x) => x === 0), { before, after, del: del.body });
  check('2 it is gone from the list and cannot be opened', (await call('GET', `/crm/leads/${id}`, null, tA)).status === 404);
  check('3 the deletion is in the audit log', (await n('SELECT COUNT(*) n FROM "AuditLog" WHERE "entityId" = ? AND "action" = ?', id, 'CRM lead deleted')) === 1);

  const L2 = await call('POST', '/crm/leads', { company: `ZZTEST Del Two ${P}`, contactName: 'B Person', phone: `94${String(Date.now()).slice(-8)}` }, tA);
  const id2 = L2.body.lead.id;
  await call('POST', '/crm/activities', { kind: 'call', subject: 'Call before converting', leadId: id2 }, tA);
  const cv = await call('POST', `/crm/leads/${id2}/convert`, { value: 10000, expectedClose: today }, tA);
  const del2 = await call('DELETE', `/crm/lead/${id2}`, null, tA);
  const acc = await call('GET', `/crm/accounts/${cv.body.account.id}`, null, tA);
  check('4 a converted lead: the lead goes, the account, the deal and the carried-over call stay', del2.status === 200 && acc.status === 200 && acc.body.deals.length === 1 && acc.body.activities.some((a) => a.subject === 'Call before converting'), { del2: del2.status, acc: acc.status, acts: acc.body && acc.body.activities && acc.body.activities.map((a) => a.subject) });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
