#!/usr/bin/env node
/**
 * WHO RECEIVES THE RESPONSES (founder 2026-11-20): the department TL ticks the recruiters who receive a job's responses and posts it.
 * Post refused without recipients; a TL ticks only their own team (Education Team A / B apart); an Admin any recruiter; the
 * assigned recruiters are the default; 5 applications over 2 recipients in turn with bells; change with a reason + history; a
 * recipient leaving -> their unworked responses move; older jobs unchanged; a Recruiter / BDE cannot change them (403).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4512 node scripts/resp-recipients-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-resprcpt-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4512;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'resp-rcpt-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
// the sandbox's Education seats: EDU TL (Team A) D.Leela Usha Sri with EDU-1 Sneha, EDU-2 D Sony, EDU-3 N Vennela; Team B: EDU-7 Uma S
const ID = {
  tlA: 'cmudx9z15001u25ry8ib01xiu', sneha: 'cmudx9yc2001925rygfytrgza', sony: 'cmvkrfwtm00t21003yozy4f5v', vennela: 'cmvkriyej00ty1003ewqludkm', uma: 'cmudx9zq1002f25ryh4atawpm',
};
const CLIENT = 'cmucmvef200spb6d2qsw8kcxf';

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.updateMany({ where: { id: { in: [adminRow.id, ...Object.values(ID)] } }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const BDE = await prisma.user.create({ data: { name: `Rr bde ${P}`, email: `rr.bde.${P}@rr-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsAccess: true, atsScopeClients: CLIENT, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await wait(500);
  }
  await wait(1500);
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {
    admin: await tok(adminRow.id), tl: await tok(ID.tlA), sneha: await tok(ID.sneha), sony: await tok(ID.sony), vennela: await tok(ID.vennela), bde: await tok(BDE.id),
  };
  // a NEW job (made after the server started, so after the feature went live) and an OLDER one
  const base = {
    clientId: CLIENT, department: 'Education', tlId: ID.tlA, tl: 'D.Leela Usha Sri', recruiterId: ID.sneha, recruiterIds: ID.sony, status: 'RECRUITER_ASSIGNED',
    portalPublished: true, portalPublishedAt: new Date(), postingSources: 'TeamLink Job Portal, TeamLink Website, Google Jobs', location: 'Hyderabad', openings: 2,
    description: 'Teach maths to intermediate students.', jobDescription: 'Teach maths to intermediate students.', experience: '2-5 yrs', skills: 'Maths, Teaching',
  };
  const J = await prisma.requirement.create({ data: { ...base, title: `Rr Maths Lecturer ${P}`, reqCode: `RR-${P}` } });
  const O = await prisma.requirement.create({ data: { ...base, title: `Rr Old Physics Lecturer ${P}`, reqCode: `RRO-${P}`, recruiterIds: null, createdAt: new Date('2026-01-05T10:00:00Z') } });
  const R = `/requirements/${J.id}/response-recipients`;

  // ---- defaults and options
  let g = await call('GET', `${R}?options=1`, null, T.tl);
  const opt = (g.body && g.body.options ? g.body.options : []).flatMap((x) => x.people);
  check('TL: not set yet, required for this new job, may change', g.status === 200 && g.body.set === false && g.body.required === true && g.body.canChange === true, g.body);
  check('TL: the list is their own team, the assigned recruiters marked (default ticks)', opt.some((p) => p.id === ID.sneha && p.assigned) && opt.some((p) => p.id === ID.sony && p.assigned) && opt.some((p) => p.id === ID.vennela && !p.assigned), opt.map((p) => [p.name, p.assigned]));
  check('TL: Education Team B is not offered to a Team A TL', !opt.some((p) => p.id === ID.uma), opt.map((p) => p.name));

  // ---- posting refused without recipients
  const pe = await call('POST', `/job-broadcast/jobs/${J.id}/post-everywhere`, { places: ['google'] }, T.tl);
  check('Post refused without recipients (post-everywhere 409, clear message)', pe.status === 409 && pe.body.code === 'RESPONSE_RECIPIENTS_NEEDED' && /Who receives the responses/.test(pe.body.error), pe);
  const rt = await call('POST', `/requirements/${J.id}/posting-sites/jobportal/retry`, null, T.tl);
  check('Post refused without recipients (our own Job Portal 409)', rt.status === 409 && rt.body.code === 'RESPONSE_RECIPIENTS_NEEDED', rt);
  const nf = await call('POST', `/job-flow/jobs/${J.id}/naukri/start`, {}, T.tl);
  check('Post refused without recipients (Naukri by hand 409)', nf.status === 409, nf);
  const dry = await call('POST', `/job-broadcast/jobs/${J.id}/post-everywhere`, { places: ['google'], dryRun: true }, T.tl);
  check('a check only (dry run) is not refused', dry.status !== 409, dry);

  // ---- who may change, and whom
  check('nobody ticked: refused (400)', (await call('PUT', R, { userIds: [] }, T.tl)).status === 400);
  const other = await call('PUT', R, { userIds: [ID.sneha, ID.uma] }, T.tl);
  check('TL cannot tick the other Education team (403, says so)', other.status === 403 && /other Education team/.test(other.body.error), other);
  check('a Recruiter cannot change recipients (403)', (await call('PUT', R, { userIds: [ID.sneha] }, T.sneha)).status === 403);
  check('a BDE cannot change recipients (403)', (await call('PUT', R, { userIds: [ID.sneha] }, T.bde)).status === 403);
  const rg = await call('GET', R, null, T.sneha);
  check('a Recruiter reads them but may not change', rg.status === 200 && rg.body.canChange === false, rg.body);

  const set = await call('PUT', R, { userIds: [ID.sneha, ID.vennela] }, T.tl);
  check('TL ticks two of their team: saved', set.status === 200 && set.body.ids.length === 2 && /Responses go to/.test(set.body.ok), set.body);
  check('history: one "set" row by the TL', set.body.history && set.body.history.length === 1 && set.body.history[0].kind === 'set' && /Leela/.test(set.body.history[0].by), set.body.history);
  const bellAdd = await prisma.notification.findFirst({ where: { userId: ID.vennela, title: { startsWith: 'You receive the responses' } } });
  check('the recipient added gets a bell', !!bellAdd);
  const rt2 = await call('POST', `/requirements/${J.id}/posting-sites/jobportal/retry`, null, T.tl);
  check('with recipients the job posts (Job Portal retry not refused)', rt2.status === 200, rt2);

  // ---- routing: 5 inbound applications over 2 recipients
  const owners = [];
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ap = await call('POST', `/public/jobs/${J.id}/apply`, { name: `Rr Applicant ${i} ${P}`, email: `rr.app${i}.${P}@rr-test.in`, phone: `9${String(P).padStart(5, '0').slice(-5)}${String(i).padStart(4, '0')}`, currentSalary: '3 LPA', expectedSalary: '4 LPA', src: 'Naukri' });
    // eslint-disable-next-line no-await-in-loop
    const a = ap.body && ap.body.applicationId ? await prisma.application.findUnique({ where: { id: ap.body.applicationId } }) : null;
    owners.push(a ? a.ownerRecruiterId : `ERR ${ap.status} ${JSON.stringify(ap.body)}`);
  }
  const nV = owners.filter((o) => o === ID.vennela).length; const nS = owners.filter((o) => o === ID.sneha).length;
  check('5 applications over 2 recipients: 3 and 2, in turn (ties by name: N Vennela first)', nV === 3 && nS === 2 && owners[0] === ID.vennela && owners[1] === ID.sneha && owners[2] === ID.vennela, owners);
  check('the assigned-only recruiter (D Sony) got none', !owners.includes(ID.sony), owners);
  await wait(1200);
  const bells = await prisma.notification.groupBy({ by: ['userId'], where: { title: { startsWith: 'New response' }, message: { contains: `${P}` } }, _count: { _all: true } });
  const bellN = new Map(bells.map((b) => [b.userId, b._count._all]));
  check('each recipient gets a bell per response (3 and 2)', bellN.get(ID.vennela) === 3 && bellN.get(ID.sneha) === 2, Object.fromEntries(bellN));

  const vp = await call('GET', '/job-portal/applications', null, T.vennela);
  const vMine = (vp.body.applications || []).filter((a) => a.requirementId === J.id);
  check('a recipient who is not assigned sees the job\'s responses given to her (3), not the others\'', vp.status === 200 && vMine.length === 3 && vMine.every((a) => a.receivedBy && a.receivedBy.id === ID.vennela), { s: vp.status, n: vMine.length });
  check('...and sees the job itself', (await call('GET', `/requirements/${J.id}`, null, T.vennela)).status === 200);
  const sp = await call('GET', '/job-portal/applications', null, T.sony);
  check('an assigned-only recruiter still opens the job as before, and does not see the recipients\' responses', (await call('GET', `/requirements/${J.id}`, null, T.sony)).status === 200 && !(sp.body.applications || []).some((a) => a.requirementId === J.id && a.receivedBy && a.receivedBy.id !== ID.sony), sp.status);
  const ap = await call('GET', '/job-portal/applications', null, T.admin);
  const aMine = (ap.body.applications || []).filter((a) => a.requirementId === J.id);
  check('"New from job portal" says who received each one', aMine.length === 5 && aMine.every((a) => a.receivedBy && a.receivedBy.recipient === true && a.receivedBy.name), aMine.map((a) => a.receivedBy));

  // ---- change with a reason
  check('a change without a reason is refused (400)', (await call('PUT', R, { userIds: [ID.sneha, ID.sony] }, T.tl)).status === 400);
  const ch = await call('PUT', R, { userIds: [ID.sneha, ID.sony], reason: 'Vennela moves to the board exams job' }, T.tl);
  const after = await prisma.application.findMany({ where: { requirementId: J.id }, select: { ownerRecruiterId: true } });
  check('change saved: Vennela off, her 3 unworked responses moved to the others', ch.status === 200 && ch.body.moved === 3 && !after.some((a) => a.ownerRecruiterId === ID.vennela) && after.length === 5, { s: ch.status, b: ch.body && ch.body.ok, owners: after.map((a) => a.ownerRecruiterId) });
  check('history: the change with its reason', ch.body.history && ch.body.history[0].kind === 'change' && /board exams/.test(ch.body.history[0].reason) && ch.body.history.length === 2, ch.body.history);
  const act = await call('GET', `/requirements/${J.id}/activity`, null, T.tl);
  check('requirement history (activity) shows "Response recipients changed" with the reason', act.status === 200 && act.body.some((x) => x.action === 'Response recipients changed' && /board exams/.test(x.reason || '')), act.status);
  const ho = await prisma.auditLog.count({ where: { entity: 'Application', action: { startsWith: 'Candidate handed over' }, toValue: { in: ['D Sony', 'Sneha Bharghavi Bapanapalli'] }, createdAt: { gte: new Date(Date.now() - 120000) } } });
  check('each move is a recorded handover', ho >= 3, ho);

  // ---- Admin sets any
  const ad = await call('PUT', R, { userIds: [ID.sneha, ID.sony, ID.uma], reason: 'Admin adds Team B for the rush' }, T.admin);
  check('Admin / Super Admin can set any recruiter (Team B too)', ad.status === 200 && ad.body.ids.includes(ID.uma), ad.body);

  // ---- a recipient leaves
  const sonyEmp = await prisma.employee.findFirst({ where: { userId: ID.sony } });
  const sonyHad = await prisma.application.count({ where: { requirementId: J.id, ownerRecruiterId: ID.sony } });
  await prisma.employee.update({ where: { id: sonyEmp.id }, data: { employmentStatus: 'Exited' } });
  const lv = await call('GET', R, null, T.admin);
  const left = await prisma.application.count({ where: { requirementId: J.id, ownerRecruiterId: ID.sony } });
  check('a recipient who left is taken off the list (history "left")', lv.status === 200 && !lv.body.ids.includes(ID.sony) && lv.body.history[0].kind === 'left', lv.body && { ids: lv.body.ids, h: lv.body.history && lv.body.history[0] });
  check('...and their unworked new responses moved to the remaining recipients', sonyHad > 0 && left === 0, { sonyHad, left });
  await prisma.employee.update({ where: { id: sonyEmp.id }, data: { employmentStatus: sonyEmp.employmentStatus } });

  // ---- older jobs unchanged
  const og = await call('GET', `/requirements/${O.id}/response-recipients`, null, T.tl);
  check('an older job: recipients not required', og.status === 200 && og.body.required === false && og.body.set === false, og.body);
  const ort = await call('POST', `/requirements/${O.id}/posting-sites/jobportal/retry`, null, T.tl);
  check('an older job still posts without recipients', ort.status === 200, ort);
  const oa = await call('POST', `/public/jobs/${O.id}/apply`, { name: `Rr Old Applicant ${P}`, email: `rr.old.${P}@rr-test.in`, phone: `8${String(P).padStart(9, '7').slice(-9)}`, currentSalary: '3 LPA', expectedSalary: '4 LPA' });
  const oApp = oa.body && oa.body.applicationId ? await prisma.application.findUnique({ where: { id: oa.body.applicationId } }) : null;
  check('an older job\'s response goes to its own recruiter as today', oApp && oApp.ownerRecruiterId === ID.sneha, { s: oa.status, b: oa.body, owner: oApp && oApp.ownerRecruiterId });

  // ---- a manual add is not a response
  const man = await call('POST', '/applications', { candidateId: (await prisma.candidate.create({ data: { name: `Rr Manual ${P}`, phone: `7${String(P).padStart(9, '3').slice(-9)}` } })).id, requirementId: J.id, overrideReason: 'test setup reason' }, T.sony);
  const manApp = man.body && (man.body.id || (man.body.application && man.body.application.id));
  const mRow = manApp ? await prisma.application.findUnique({ where: { id: manApp } }) : null;
  check('a recruiter adding someone keeps them (not routed)', mRow && mRow.ownerRecruiterId === ID.sony, { s: man.status, b: man.body && man.body.error, owner: mRow && mRow.ownerRecruiterId });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
