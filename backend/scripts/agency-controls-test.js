#!/usr/bin/env node
/**
 * AGENCY CONTROLS (ATS audit 741, 743/748, 752 - founder 2026-11-17):
 *   no consent -> the profile cannot go to a client; same client, another live job -> the add needs a reason; invoice hold.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4074.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/agency-controls-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-agency-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4074;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'agency-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  // a client with two live jobs
  const live = await prisma.requirement.findMany({ where: { status: { not: 'CLOSED' }, internal: false }, select: { id: true, clientId: true } });
  const byClient = new Map(); live.filter((r) => r.clientId).forEach((r) => byClient.set(r.clientId, [...(byClient.get(r.clientId) || []), r]));
  const jobs = [...byClient.values()].find((l) => l.length > 1).slice(0, 2);
  const C = await prisma.candidate.create({ data: { name: 'ZZ Agency Person', phone: `8${String(process.pid).padStart(9, '3').slice(-9)}`, email: `zz.agency.${process.pid}@zz-agency-test.in` } });
  // jobs live + no override rules interfering: wipe the jobs' must-haves on the copy
  await prisma.requirement.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { status: 'OPEN' } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });

  // first job: added (with a reason if the job's own rules ask for one)
  let a1 = await call('POST', '/applications', { candidateId: C.id, requirementId: jobs[0].id }, tA);
  if (a1.status === 409 && a1.body.code === 'NEEDS_OVERRIDE') a1 = await call('POST', '/applications', { candidateId: C.id, requirementId: jobs[0].id, overrideReason: 'Test: rules not relevant here' }, tA);
  check('the person is added to the first job of the client', [200, 201].includes(a1.status), a1.body);
  const a2 = await call('POST', '/applications', { candidateId: C.id, requirementId: jobs[1].id }, tA);
  check('a second job of the SAME client asks why, naming the earlier submission', a2.status === 409 && a2.body.code === 'NEEDS_OVERRIDE' && (a2.body.why || []).some((w) => /already with/.test(w)), a2.body);
  const a2b = await call('POST', '/applications', { candidateId: C.id, requirementId: jobs[1].id, overrideReason: 'Client asked to see them for both roles' }, tA);
  check('with a reason it goes in (recorded as an override)', [200, 201].includes(a2b.status), a2b.body);

  // consent
  const appId = (a1.body && (a1.body.id || (a1.body.application && a1.body.application.id))) || (await prisma.application.findFirst({ where: { candidateId: C.id, requirementId: jobs[0].id } })).id;
  await prisma.candidate.update({ where: { id: C.id }, data: { consentStatus: 'WITHDRAWN', doNotContact: true } });
  const mv = await call('PATCH', `/applications/${appId}/stage`, { stage: 'SHARED_WITH_CLIENT' }, tA);
  const mv2 = mv.status === 404 ? await call('PATCH', `/applications/${appId}/stage`, { stage: 'SHARED_WITH_CLIENT' }, tA) : mv;
  check('a person who withdrew consent cannot be sent to a client', mv2.status === 409 && mv2.body.code === 'NO_CONSENT', { status: mv2.status, body: mv2.body });

  // invoice hold
  const inv = await prisma.invoice.findFirst({ where: { status: { notIn: ['Paid', 'Cancelled'] } } });
  if (inv) {
    check('a hold needs the dispute in words', (await call('PATCH', `/invoices/${inv.id}/hold`, { reason: 'x' }, tA)).status === 400);
    const h = await call('PATCH', `/invoices/${inv.id}/hold`, { reason: 'Client says the candidate left in 10 days' }, tA);
    check('the invoice is put on hold', h.status === 200 && h.body.hold && /left in 10 days/.test(h.body.hold.reason), h.body);
    const d = await call('GET', `/invoices/${inv.id}`, null, tA);
    check('the invoice shows the hold and keeps its status', d.status === 200 && d.body.hold && d.body.status !== 'On Hold', { hold: d.body.hold, status: d.body.status });
    const list = await call('GET', '/invoices', null, tA);
    check('the register rows carry the hold', Array.isArray(list.body) && list.body.some((r) => r.id === inv.id && r.hold));
    check('released', (await call('PATCH', `/invoices/${inv.id}/release`, {}, tA)).status === 200 && !(await call('GET', `/invoices/${inv.id}`, null, tA)).body.hold);
    check('hold and release are audited', (await prisma.auditLog.count({ where: { entityId: inv.id, action: { in: ['Invoice put on hold (billing dispute)', 'Invoice hold released'] } } })) === 2);
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
