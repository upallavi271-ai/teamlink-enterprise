#!/usr/bin/env node
/**
 * Who moves a candidate to whom (founder 2026-11-06, utils/permissions.js STAGE_OWNERS, BDE_TL_STAGES, lateForRole): Recruiter to the TL, TL to the BDE, BDE to the BDE TL, BDE TL to the client and after.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4040.
 *   node scripts/stage-chain-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-stage-chain-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4040;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'stage-chain', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const P = require('../src/utils/permissions');
const S = require('../src/utils/scope');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 340)}` : ''}`); } };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const FORWARD = ['TL_REVIEW', 'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'JOINED'];

(async () => {
  const pool = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true, clientId: null, candidateId: null }, take: 900, include: { employee: { select: { employmentStatus: true } } } });
  const ok = pool.filter((u) => !['Exited', 'Relieved', 'Terminated'].includes(u.employee && u.employee.employmentStatus));
  const pick = async (test) => { for (const u of ok) { const i = await resolveIdentity(u.id); if (i && test(i)) return i; } return null; }; // eslint-disable-line no-await-in-loop
  const tl = await pick((i) => P.stageRoleOf(i) === 'TL' && !S.isBdeTl(i) && !!i.atsDepartment);
  const rec = (await pick((i) => P.stageRoleOf(i) === 'RECRUITER' && i.atsDepartment === tl.atsDepartment)) || (await pick((i) => P.stageRoleOf(i) === 'RECRUITER'));
  const bde = await pick((i) => P.stageRoleOf(i) === 'BDE' && !S.isBdeTl(i));
  const bdetl = await pick((i) => S.isBdeTl(i));
  const hr = await pick((i) => P.stageRoleOf(i) === 'HR');
  console.log('logins:', [rec, tl, bde, bdetl, hr].map((x) => x && x.name).join(' | '));

  console.log('What each role may move a candidate to');
  const list = async (u) => { const a = await P.allowedStagesFor(u); return FORWARD.filter((s) => a.includes(s)); };
  const r = await list(rec); const t = await list(tl); const b = await list(bde); const d = await list(bdetl);
  check('Recruiter: only up to the TL', r.join() === 'TL_REVIEW', r);
  check('TL: only to the BDE (and the TL step)', t.join() === 'TL_REVIEW,WITH_BDE', t);
  check('BDE: to the BDE TL, and the interview', b.join() === 'BDE_APPROVED,INTERVIEW_SCHEDULED,INTERVIEW_COMPLETED', b);
  check('BDE TL: any step (2026-11-11)', d.join() === FORWARD.join(), d);
  if (hr) { const h = await P.allowedStagesFor(hr); check('HR keeps internal hiring', ['SELECTED', 'OFFER', 'JOINED', 'INTERVIEW_SCHEDULED'].every((s) => h.includes(s)), h); }

  console.log('On a real client job');
  const job = await prisma.requirement.findFirst({ where: { internal: false, status: { in: ['OPEN', 'RECRUITER_ASSIGNED', 'IN_PROGRESS', 'ACTIVE', 'SOURCING'] } } });
  await prisma.requirement.update({ where: { id: job.id }, data: { recruiterId: rec.id, tlId: tl.id, bdeId: bde.id, status: 'OPEN', department: tl.atsDepartment } });
  const cand = await prisma.candidate.findFirst({ where: { applications: { none: { requirementId: job.id } } } });
  await prisma.candidate.update({ where: { id: cand.id }, data: { currentSalary: '30000', expectedSalary: '35000' } }); // (the copy) the send-on rule asks for the salary first
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage: 'RECRUITER_REVIEW', hiringType: 'Client Placement', ownerRecruiterId: rec.id } });
  await prisma.user.updateMany({ where: { id: { in: [rec.id, tl.id, bde.id, bdetl.id] } }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    if (await fetch(`${API}/health`).then((x) => x.ok).catch(() => false)) break; // eslint-disable-line no-await-in-loop
    await new Promise((x) => { setTimeout(x, 500); }); // eslint-disable-line no-await-in-loop
  }
  await new Promise((x) => { setTimeout(x, 1100); });
  const tokens = {};
  for (const [k, u] of Object.entries({ rec, tl, bde, bdetl })) tokens[k] = jwt.sign({ ...tokenPayload(u), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const at = (stage) => prisma.application.update({ where: { id: app.id }, data: { stage } });
  const move = async (who, stage, extra = {}) => {
    const res = await fetch(`${API}/applications/${app.id}/stage`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify({ stage, ...extra }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const stageNow = async () => (await prisma.application.findUnique({ where: { id: app.id } })).stage;
  const REASON = { reasonCategory: 'Other', reasonDetail: 'Test', rejectionReason: 'Test', rejectKind: 'not_suitable', rejectedBy: 'Client', comment: 'Test' };

  const a1 = await move('rec', 'TL_REVIEW');
  check('the recruiter sends to the TL', a1.status === 200 && (await stageNow()) === 'TL_REVIEW', a1.body);
  check('the recruiter cannot go past the TL', (await move('rec', 'WITH_BDE')).status === 403);
  await at('TL_REVIEW');
  const a2 = await move('tl', 'WITH_BDE');
  check('the TL sends to the BDE', a2.status === 200 && (await stageNow()) === 'WITH_BDE', a2.body);
  check('the TL cannot send to the BDE TL', (await move('tl', 'BDE_APPROVED')).status === 403);
  await at('WITH_BDE');
  const a3 = await move('bde', 'BDE_APPROVED');
  check('the BDE sends to the BDE TL', a3.status === 200 && (await stageNow()) === 'BDE_APPROVED', a3.body);
  check('the BDE cannot send to the client', (await move('bde', 'SHARED_WITH_CLIENT')).status === 403);
  await at('BDE_APPROVED');
  const a4 = await move('bdetl', 'SHARED_WITH_CLIENT');
  check('the BDE TL sends to the client', a4.status === 200 && (await stageNow()) === 'SHARED_WITH_CLIENT', a4.body);

  console.log('Past the client');
  await at('SHARED_WITH_CLIENT');
  for (const who of ['rec', 'tl', 'bde']) {
    const no = await move(who, 'REJECTED', REASON); // eslint-disable-line no-await-in-loop
    check(`${who}: Reject is refused now, and says who has it`, no.status === 403 && /BDE TL/.test(no.body.error), no.body);
    const h = await move(who, 'HOLD', REASON); // eslint-disable-line no-await-in-loop
    check(`${who}: Hold is refused too`, h.status === 403, h.body);
  }
  check('the BDE cannot say the client said yes', (await move('bde', 'CLIENT_SHORTLISTED')).status === 403);
  const yes = await move('bdetl', 'CLIENT_SHORTLISTED');
  check('the BDE TL records the client\'s yes', yes.status === 200, yes.body);
  check('the recruiter cannot mark Selected', (await move('rec', 'SELECTED')).status === 403);
  check('the BDE cannot mark Selected', (await move('bde', 'SELECTED')).status === 403);
  await at('INTERVIEW_COMPLETED');
  const sel = await move('bdetl', 'SELECTED');
  check('the BDE TL marks Selected', sel.status === 200 && (await stageNow()) === 'SELECTED', sel.body);
  const joinAs = async (who) => { const res = await fetch(`${API}/ats/joining/${app.id}/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify({ joiningDate: '2026-11-06', offeredCtc: 500000, confirmCtc: true }) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  check('the recruiter cannot start the joining', (await joinAs('rec')).status === 403);
  check('the TL cannot start the joining', (await joinAs('tl')).status === 403);
  const j = await joinAs('bdetl');
  check('the BDE TL can', j.status === 200, j.body);
  await at('SHARED_WITH_CLIENT');
  const rj = await move('bdetl', 'REJECTED', REASON);
  check('the BDE TL can reject after the client', rj.status === 200, rj.body);

  console.log('Before the client, the team still screens');
  await at('RECRUITER_REVIEW');
  const e1 = await move('rec', 'HOLD', REASON);
  check('the recruiter can still hold their own candidate', e1.status === 200, e1.body);
  await at('WITH_BDE');
  const e2 = await move('bde', 'REJECTED', REASON);
  check('the BDE can still reject before the client', e2.status === 200, e2.body);
  await at('BDE_APPROVED');
  const e3 = await move('bdetl', 'WITH_BDE', { comment: 'Please fix' });
  check('the BDE TL can send a profile back to the BDE', e3.status === 200, e3.body);

  console.log('The BDE TL moves any step, any time (founder 2026-11-11: clients have no logins)');
  await at('WITH_BDE');
  const f1 = await move('bdetl', 'SELECTED');
  check('the BDE TL jumps from BDE review straight to Selected', f1.status === 200 && (await stageNow()) === 'SELECTED', f1.body);
  await at('BDE_APPROVED');
  const f2 = await move('bdetl', 'INTERVIEW_COMPLETED');
  check('the BDE TL skips to Interview done', f2.status === 200 && (await stageNow()) === 'INTERVIEW_COMPLETED', f2.body);
  await at('SELECTED');
  const f3 = await move('bdetl', 'RECRUITER_REVIEW', { comment: 'Back to the start' });
  check('the BDE TL moves a person back to any earlier step', f3.status === 200 && (await stageNow()) === 'RECRUITER_REVIEW', f3.body);
  await at('SELECTED');
  const f4 = await move('bdetl', 'JOINED', { joiningDate: '2026-11-10', offeredCtc: 480000, confirmCtc: true, feePercent: 8.33 });
  check('the BDE TL marks Joined straight from Selected', f4.status === 200 && (await stageNow()) === 'JOINED', f4.body);
  await at('RECRUITER_REVIEW');
  check('the recruiter still cannot skip ahead', (await move('rec', 'SELECTED')).status === 403);
  check('the BDE still cannot skip to Selected', (await move('bde', 'SELECTED')).status === 403);

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
