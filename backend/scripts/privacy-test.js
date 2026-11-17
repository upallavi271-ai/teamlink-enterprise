#!/usr/bin/env node
/**
 * CANDIDATE PRIVACY (utils/candidatePrivacy.js, routes/privacy.js) - DPDP: export, legal hold, erasure, consent review.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4072.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/privacy-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-privacy-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4072;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'privacy-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch { j = txt; } return { status: r.status, body: j };
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
  const REC = await prisma.user.create({ data: { name: 'ZZ priv rec', email: `zz.priv.${process.pid}@zz-priv-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const C = await prisma.candidate.create({ data: { name: 'ZZ Privacy Person', email: `zz.person.${process.pid}@zz-priv-test.in`, phone: `9${String(process.pid).padStart(9, '7').slice(-9)}`, dob: '1995-01-01', currentSalary: '6 LPA', consentStatus: 'GIVEN', consentAt: new Date(Date.now() - 900 * 86400000) } });
  await prisma.candidateNote.create({ data: { candidateId: C.id, body: 'private note' } }).catch(() => null);
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id);

  check('a recruiter cannot use the privacy tools', (await call('GET', `/privacy/candidates/${C.id}/export`, null, tR)).status === 403);
  const ex = await call('GET', `/privacy/candidates/${C.id}/export`, null, tA);
  check('the admin downloads everything held about the person', ex.status === 200 && ex.body.profile && ex.body.profile.email === C.email && Array.isArray(ex.body.applications) && Array.isArray(ex.body.auditTrail), typeof ex.body === 'object' ? Object.keys(ex.body) : ex.body);
  check('the download is audited', !!(await prisma.auditLog.findFirst({ where: { entityId: C.id, action: 'Candidate data exported (DPDP access request)' } })));
  check('a hold needs a reason', (await call('POST', `/privacy/candidates/${C.id}/hold`, { reason: '' }, tA)).status === 400);
  check('legal hold placed', (await call('POST', `/privacy/candidates/${C.id}/hold`, { reason: 'Client dispute ZZ' }, tA)).status === 200);
  const blocked = await call('POST', `/privacy/candidates/${C.id}/erase`, { reason: 'asked', confirm: 'ERASE' }, tA);
  check('erasure is refused while held, with the reason', blocked.status === 409 && /legal hold/.test(blocked.body.error), blocked.body);
  const del = await call('DELETE', `/candidates/${C.id}`, { reason: 'Wrong entry', confirmName: C.name }, tA);
  check('delete is refused while held', del.status === 409 && /legal hold/.test(del.body.error || ''), del.body);
  check('hold released', (await call('DELETE', `/privacy/candidates/${C.id}/hold`, {}, tA)).status === 200);
  check('erasure needs the word ERASE', (await call('POST', `/privacy/candidates/${C.id}/erase`, { reason: 'asked' }, tA)).status === 400);
  const er = await call('POST', `/privacy/candidates/${C.id}/erase`, { reason: 'Asked to be removed, email 17 Nov', confirm: 'ERASE' }, tA);
  const after = await prisma.candidate.findUnique({ where: { id: C.id } });
  check('erased: name replaced, phone / email / birth date / salary gone, never contacted again', er.status === 200 && /^Erased candidate/.test(after.name) && !after.email && !after.phone && !after.dob && !after.currentSalary && after.doNotContact, { er: er.body, after: { name: after.name, email: after.email } });
  check('the erasure is audited with the reason', !!(await prisma.auditLog.findFirst({ where: { entityId: C.id, action: 'Candidate data erased (DPDP)', reason: { contains: 'Asked to be removed' } } })));
  // a joined, not invoiced placement cannot be erased
  const joined = await prisma.application.findFirst({ where: { stage: { in: ['JOINED', 'HIRED'] } }, select: { candidateId: true, requirementId: true } });
  if (joined) {
    await prisma.invoice.deleteMany({ where: { candidateId: joined.candidateId, requirementId: joined.requirementId } }).catch(() => {});
    const j = await call('POST', `/privacy/candidates/${joined.candidateId}/erase`, { reason: 'x', confirm: 'ERASE' }, tA);
    check('a joined placement not invoiced yet cannot be erased (money owed)', j.status === 409 && /not invoiced/.test(j.body.error), j.body);
  }
  const cr = await call('GET', '/privacy/consent', null, tA);
  check('consent review lists consent older than the period and counts never-recorded / withdrawn', cr.status === 200 && cr.body.months === 24 && typeof cr.body.neverRecorded === 'number' && typeof cr.body.withdrawn === 'number', cr.body && { ...cr.body, expired: (cr.body.expired || []).length });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
