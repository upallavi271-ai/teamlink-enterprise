#!/usr/bin/env node
/**
 * THE JOINING CTC (routes/joiningCtc.js) - founder 2026-11-17: a joined candidate's yearly CTC, entered on the profile by the requirement's BDE, a BDE team lead
 * or an Admin. Not before joining, not after the joining is invoiced; the usual CTC sanity check; audited with old and new values.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4066.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/joining-ctc-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-joining-ctc-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = Number(process.env.TEST_PORT) || 4066;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'joining-ctc-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag}`, email: `zz.jctc.${tag}.${process.pid}@zz-jctc-test.in`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const BDE = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE' });
  const REC = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
  // a joined client placement with no invoice, its requirement owned by our BDE
  const invoicedPairs = new Set((await prisma.invoice.findMany({ select: { candidateId: true, requirementId: true } })).map((i) => `${i.candidateId}|${i.requirementId}`));
  const joined = (await prisma.application.findMany({ where: { stage: { in: ['JOINED', 'HIRED'] } }, select: { id: true, candidateId: true, requirementId: true }, take: 200 })).find((a) => !invoicedPairs.has(`${a.candidateId}|${a.requirementId}`));
  await prisma.requirement.update({ where: { id: joined.requirementId }, data: { bdeId: BDE.id } });
  await prisma.application.update({ where: { id: joined.id }, data: { offeredCtc: null } });
  const open = await prisma.application.findFirst({ where: { stage: { notIn: ['JOINED', 'HIRED', 'REJECTED'] } }, select: { id: true } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = await tokenOf(adminRow.id); const tB = await tokenOf(BDE.id); const tR = await tokenOf(REC.id);

  const g0 = await call('GET', `/ats/joining-ctc/${joined.id}`, null, tB);
  check('the requirement\'s BDE sees "not entered yet" and may add it', g0.status === 200 && g0.body.ctc === null && g0.body.canEdit === true, g0.body);
  const gR = await call('GET', `/ats/joining-ctc/${joined.id}`, null, tR);
  check('a recruiter sees it but may not edit, and is told who can', gR.status === 200 && gR.body.canEdit === false && /BDE/.test(gR.body.why || ''), gR.body);
  check('the recruiter\'s save is refused', (await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: 450000 }, tR)).status === 403);
  const odd = await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: 12000 }, tB);
  check('an odd figure (12,000 a year) asks "is this the yearly CTC?" first', odd.status === 409 && odd.body.needsConfirm === true, odd.body);
  const s1 = await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: '450000' }, tB);
  check('the BDE saves 4,50,000', s1.status === 200 && s1.body.ctc === 450000, s1.body);
  check('it is on the application', (await prisma.application.findUnique({ where: { id: joined.id } })).offeredCtc === 450000);
  const aud = await prisma.auditLog.findFirst({ where: { entity: 'Application', entityId: joined.id, action: 'Joining CTC entered' }, orderBy: { createdAt: 'desc' } });
  check('the audit says from blank to 450000, by the BDE', aud && aud.fromValue === '(blank)' && aud.toValue === '450000' && aud.userId === BDE.id, aud);
  const s2 = await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: 520000 }, tA);
  check('an Admin changes it to 5,20,000', s2.status === 200 && s2.body.ctc === 520000);
  const g1 = await call('GET', `/ats/joining-ctc/${joined.id}`, null, tB);
  check('the profile now shows 5,20,000', g1.body.ctc === 520000, g1.body);
  check('before joining it cannot be entered', (await call('POST', `/ats/joining-ctc/${open.id}`, { offeredCtc: 450000 }, tA)).status === 409);
  check('a blank figure is refused', (await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: '' }, tA)).status === 400);
  // once invoiced, it belongs to the invoice
  const anyInv = await prisma.invoice.findFirst({ select: { id: true } });
  if (anyInv) {
    await prisma.invoice.update({ where: { id: anyInv.id }, data: { candidateId: joined.candidateId, requirementId: joined.requirementId } });
    const g2 = await call('GET', `/ats/joining-ctc/${joined.id}`, null, tA);
    check('once invoiced: shown as invoiced, no longer editable here', g2.body.invoiced === true && g2.body.canEdit === false, g2.body);
    check('and a save is refused, pointing to Accounts', (await call('POST', `/ats/joining-ctc/${joined.id}`, { offeredCtc: 600000 }, tA)).status === 409);
  } else check('(no invoice in this copy: the invoiced case is skipped)', true);
  check('an application that is not there is a 404', (await call('GET', '/ats/joining-ctc/nope', null, tA)).status === 404);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
