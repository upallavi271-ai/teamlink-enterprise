#!/usr/bin/env node
/**
 * ATS GAPS round 2 (founder 2026-11-17 "build what is not built"): move a candidate to another requirement; a live requirement's key
 * change waits for the BDE TL (approve / undo); recycle bin restore; offer On hold; interview feedback history.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4076.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-gaps2-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-gaps2-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4076;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'gaps2-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
const P = process.pid;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const BDE = await prisma.user.create({ data: { name: `Gx bde ${P}`, email: `gx.bde.${P}@gx-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const BDETL = await prisma.user.create({ data: { name: `Gx bdetl ${P}`, email: `gx.bdetl.${P}@gx-test.in`, passwordHash: 'x', status: 'Active', role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false }, select: { id: true, clientId: true, title: true } , take: 50 });
  const [j1, j2] = [live[0], live.find((x) => x.clientId !== live[0].clientId) || live[1]];
  await prisma.requirement.update({ where: { id: j1.id }, data: { bdeId: BDE.id } });
  const C = await prisma.candidate.create({ data: { name: `Gx Person ${P}`, phone: `7${String(P).padStart(9, '4').slice(-9)}`, email: `gx.person.${P}@gx-test.in` } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tB = await tok(BDE.id); const tT = await tok(BDETL.id);

  // ---- move
  let a1 = await call('POST', '/applications', { candidateId: C.id, requirementId: j1.id, overrideReason: 'test setup reason' }, tA);
  const app1 = a1.body && (a1.body.id || (a1.body.application && a1.body.application.id));
  check('setup: the person is on job 1', [200, 201].includes(a1.status) && !!app1, a1.body);
  check('move needs a reason', (await call('POST', `/applications/${app1}/move`, { requirementId: j2.id, reason: '' }, tA)).status === 400);
  const mv = await call('POST', `/applications/${app1}/move`, { requirementId: j2.id, reason: 'Fits the other opening better' }, tA);
  check('move: added to job 2, old one closed as Moved', mv.status === 201 && !!mv.body.to, mv.body);
  const old = await prisma.application.findUnique({ where: { id: app1 } });
  const ev = await prisma.applicationStageEvent.findFirst({ where: { applicationId: app1, toStage: 'REJECTED' }, orderBy: { createdAt: 'desc' } });
  check('the old application is closed with "Moved to another requirement" and the reason', old.stage === 'REJECTED' && ev && ev.reasonCategory === 'Moved to another requirement' && /Fits the other opening/.test(ev.reasonDetail || ''), { stage: old.stage, ev: ev && { c: ev.reasonCategory, d: ev.reasonDetail } });
  check('moving to a job they are already on is refused', (await call('POST', `/applications/${mv.body.to}/move`, { requirementId: j2.id, reason: 'again same job' }, tA)).status >= 400);

  // ---- requirement re-approval
  const before = await prisma.requirement.findUnique({ where: { id: j1.id } });
  const ed = await call('PUT', `/requirements/${j1.id}`, { title: `${before.title} (edited ${P})` }, tB);
  const rv = await call('GET', `/requirements/${j1.id}/review`, null, tB);
  check('a BDE edits a live job\'s title: the change waits for the BDE TL (job still live)', [200].includes(ed.status) && rv.body.review && rv.body.review.changes.some((c) => c.field === 'title') && rv.body.canDecide === false, { ed: ed.status, err: ed.body && ed.body.error, rv: rv.body });
  check('the BDE cannot approve it', (await call('POST', `/requirements/${j1.id}/review/approve`, null, tB)).status === 403);
  const un = await call('POST', `/requirements/${j1.id}/review/undo`, null, tT);
  const after = await prisma.requirement.findUnique({ where: { id: j1.id } });
  check('the BDE TL undoes it: the old title is back, nothing waiting', un.status === 200 && after.title === before.title && !(await call('GET', `/requirements/${j1.id}/review`, null, tT)).body.review, { un: un.body, title: after.title });
  await call('PUT', `/requirements/${j1.id}`, { title: `${before.title} (edited2 ${P})` }, tB);
  check('...or approves a change: it stays, nothing waiting', (await call('POST', `/requirements/${j1.id}/review/approve`, null, tT)).status === 200 && (await prisma.requirement.findUnique({ where: { id: j1.id } })).title.includes('edited2'));
  await call('PUT', `/requirements/${j1.id}`, { title: `${before.title} (admin ${P})` }, tA);
  check('an Admin\'s own edit does not wait for approval', !(await call('GET', `/requirements/${j1.id}/review`, null, tA)).body.review);

  // ---- recycle bin
  const D = await prisma.candidate.create({ data: { name: `Gx Dup ${P}`, phone: `6${String(P).padStart(9, '2').slice(-9)}` } });
  const del = await call('DELETE', `/candidates/${D.id}`, { reason: 'Duplicate', confirmName: D.name }, tA);
  check('a duplicate is deleted', del.status === 200 && !(await prisma.candidate.findUnique({ where: { id: D.id } })), del.body);
  const bin = await call('GET', '/admin/recycle-bin', null, tA);
  const item = (bin.body.items || []).find((x) => x.entityId === D.id);
  check('it is in the recycle bin', !!item, bin.body);
  const rs = await call('POST', `/admin/recycle-bin/${item && item.id}/restore`, null, tA);
  check('restore brings it back with the same id', rs.status === 200 && !!(await prisma.candidate.findUnique({ where: { id: D.id } })), rs.body);
  check('a second restore is refused', (await call('POST', `/admin/recycle-bin/${item && item.id}/restore`, null, tA)).status === 409);

  // ---- offer hold
  const offerApp = await prisma.application.findFirst({ where: { offerStatus: { not: null }, stage: { in: ['OFFER', 'SELECTED'] } }, select: { id: true } });
  if (offerApp) {
    const h = await call('POST', `/ats/offers/${offerApp.id}/hold`, { reason: 'Candidate asked for 2 weeks' }, tA);
    check('an offer is put on hold with the reason', h.status === 200 && h.body.offerHold && /2 weeks/.test(h.body.offerHold.reason), h.body);
    check('...and released', (await call('POST', `/ats/offers/${offerApp.id}/release-hold`, null, tA)).status === 200);
  }
  // ---- feedback history
  const fb = await prisma.application.findFirst({ where: { interviewStatus: { not: null }, stage: { in: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'] } }, select: { id: true } });
  if (fb) {
    const FH = require('../src/utils/feedbackHistory');
    await FH.record(fb.id, 'Internal', 1, { overall: 'round one', recommendation: 'Selected' }, { id: adminRow.id, name: 'Admin' });
    await FH.record(fb.id, 'Internal', 2, { overall: 'round two', recommendation: 'Hold' }, { id: adminRow.id, name: 'Admin' });
    const fh = await call('GET', `/ats/interviews/${fb.id}/feedback-history`, null, tA);
    check('feedback of every round is kept and listed', fh.status === 200 && fh.body.rows.length >= 2 && fh.body.rows.some((r) => r.round === 1) && fh.body.rows.some((r) => r.round === 2), fh.body);
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
