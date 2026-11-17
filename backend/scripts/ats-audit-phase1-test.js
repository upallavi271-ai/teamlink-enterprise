#!/usr/bin/env node
/**
 * ATS AUDIT PHASE 1 (2026-11-17): the gaps found by the checklist audit that this phase closes.
 *   Q458/459/462  a candidate edit writes one audit row per changed field with the old and the new value (salary included)
 *   Q470          the audit trail downloads as CSV with the same filters as the screen (and the download is itself audited)
 *   Q129/418      open requirements closing within 3 days, or past their closing date, are told to their recruiters / TL / BDEs once per milestone
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4064.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-audit-phase1-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-audit-p1-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4064;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'audit-p1-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; let text = null; try { text = await r.text(); j = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, body: j, text };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const ymd = (d) => new Date(Date.now() + 5.5 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };

  console.log('1. A candidate edit records what changed, field by field');
  const cand = await prisma.candidate.findFirst({ where: { currentSalary: { not: null }, expectedSalary: { not: null }, profileStatus: { notIn: ['Archived', 'Do Not Use'] } }, select: { id: true, location: true, currentSalary: true, expectedSalary: true } });
  const newLoc = `Zz Town ${process.pid}`;
  const up = await call('PUT', `/candidates/${cand.id}`, { location: newLoc, expectedSalary: '9.5 LPA' });
  check('the edit is saved', up.status === 200 && up.body.location === newLoc, [up.status, up.body && up.body.error]);
  const rows = await prisma.auditLog.findMany({ where: { entity: 'Candidate', entityId: cand.id, action: 'Candidate field changed' }, orderBy: { createdAt: 'desc' }, take: 10 });
  const loc = rows.find((r) => r.field === 'location');
  const sal = rows.find((r) => r.field === 'expectedSalary');
  check('the location change has its old and new value', loc && loc.fromValue === (cand.location || '(blank)') && loc.toValue === newLoc, loc);
  check('the salary change has its old and new value (Q462)', sal && sal.fromValue === String(cand.expectedSalary) && /9\.5/.test(sal.toValue), sal);
  check('each row says who changed it', loc && loc.userId === adminRow.id && !!loc.actorName);
  const sum = await prisma.auditLog.findFirst({ where: { entity: 'Candidate', entityId: cand.id, action: 'Candidate updated' }, orderBy: { createdAt: 'desc' } });
  check('the summary row names the fields that changed', sum && /location/.test(sum.toValue || '') && /expectedSalary/.test(sum.toValue || ''), sum && sum.toValue);
  const before = await prisma.auditLog.count({ where: { entity: 'Candidate', entityId: cand.id, action: 'Candidate field changed' } });
  await call('PUT', `/candidates/${cand.id}`, { location: newLoc });
  check('saving the same value again writes no field row', (await prisma.auditLog.count({ where: { entity: 'Candidate', entityId: cand.id, action: 'Candidate field changed' } })) === before);

  console.log('2. The audit trail downloads as CSV');
  const csv = await call('GET', `/admin/audit/export?entity=Candidate&entityId=${cand.id}`);
  check('the CSV has the headings and the old and new values of this candidate', csv.status === 200 && /Old value/.test(csv.text) && csv.text.includes(newLoc) && /Candidate field changed/.test(csv.text), csv.text && csv.text.slice(0, 200));
  check('only this candidate\'s rows (the filters apply)', csv.text.split('\r\n').slice(1).every((l) => l.includes(cand.id)));
  check('the download itself is in the audit trail', (await prisma.auditLog.count({ where: { action: 'Audit trail downloaded', userId: adminRow.id } })) >= 1);
  check('without a login it is refused', (await fetch(`${API}/admin/audit/export`)).status === 401);

  console.log('3. Requirement expiry alerts');
  const EXP = require('../src/utils/requirementExpiry');
  const req = await prisma.requirement.findFirst({ where: { status: 'OPEN' }, select: { id: true, title: true } });
  await prisma.requirement.updateMany({ where: { status: 'OPEN', id: { not: req.id } }, data: { closingDate: null, targetDate: null } }); // only our requirement has a date
  await prisma.requirement.update({ where: { id: req.id }, data: { closingDate: ymd(2), targetDate: null, recruiterId: adminRow.id } });
  const sent = []; const capture = async (ids, msg) => { sent.push({ ids, ...msg }); };
  const s1 = await EXP.sweep({ force: true, notify: capture });
  check('closing in 2 days: the recruiter is told, once', s1.told.length === 1 && sent.length === 1 && sent[0].ids.includes(adminRow.id) && /Closes in 2 days/.test(sent[0].title), sent);
  await EXP.sweep({ force: true, notify: capture });
  check('the next run does not tell again', sent.length === 1, sent.length);
  check('the daily guard: an unforced run on the same day does nothing', (await EXP.sweep({ notify: capture })).skipped === true && sent.length === 1);
  await prisma.requirement.update({ where: { id: req.id }, data: { closingDate: ymd(-1) } });
  await EXP.sweep({ force: true, notify: capture });
  check('once the date has passed: "Closing date passed", told once more', sent.length === 2 && /Closing date passed/.test(sent[1].title) && /Extend the date/.test(sent[1].message), sent[1]);
  await prisma.requirement.update({ where: { id: req.id }, data: { closingDate: ymd(20) } });
  const far = await EXP.sweep({ force: true, notify: capture });
  check('a date far away tells nobody', far.told.length === 0 && sent.length === 2);
  await prisma.requirement.update({ where: { id: req.id }, data: { closingDate: ymd(1) } });
  await EXP.sweep({ force: true, notify: capture });
  check('a new date that comes near tells again (the date changed)', sent.length === 3 && /Closes in 1 day/.test(sent[2].title), sent[2]);
  await prisma.requirement.update({ where: { id: req.id }, data: { status: 'CLOSED' } });
  await prisma.requirement.update({ where: { id: req.id }, data: { closingDate: ymd(0) } });
  await EXP.sweep({ force: true, notify: capture });
  check('a closed requirement is never told', sent.length === 3);
  check('the date reader accepts 2026-11-20, 20-11-2026 and 20/11/2026', EXP.ymd('2026-11-20') === '2026-11-20' && EXP.ymd('20-11-2026') === '2026-11-20' && EXP.ymd('20/11/2026') === '2026-11-20' && EXP.ymd('soon') === null);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
