/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// req-form-post-test.js : the Save & Post rules of the split Add job window (2026-10-13). LIGHT, run once, SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/req-form-post-test.js
// Checks:
//   * a person who may post (BDE) can read the login STATUS of a site, save the FIRST login, and test it; never see a secret
//   * the same person can NOT replace, delete, switch on, or list the logins; a Recruiter can do nothing
//   * an Admin can view the status, replace, delete; no answer ever holds the password
//   * the job preview (template) is open to the BDE and the Manager, closed to the Recruiter
//   * "Posted on": the list has a postedOn filter and a postedCounts answer
//   * Post step: post-everywhere with dryRun queues a dry-run entry (no login = by-hand task; login + switch on = queue entry
//     with dryRun=1); the job text sent is the one saved with the job
// It creates ZZTEST RF rows in the sandbox DB only and removes them at the end. It never contacts a job portal.
// ---------------------------------------------------------------------------
const path = require('path');
const DB = process.env.TL_DB || path.join(__dirname, '../prisma', process.env.TL_TEST_DB || 'sandbox.db'); // TL_DB: a private copy of the sandbox database
const API = process.env.TL_API ? `${process.env.TL_API.replace(/\/+$/, '')}/api` : 'http://localhost:4011/api';
if (/:4010\b/.test(API)) { console.error('Refusing to run on the real server (4010). Use the sandbox (4011).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.replace(/\\/g, '/')}`;
require('dotenv').config({ path: path.join(__dirname, '../.env') });
process.env.DATABASE_URL = `file:${DB.replace(/\\/g, '/')}`;
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const TAG = 'ZZTEST RF';
const made = { users: [], employees: [], clients: [], reqs: [] };
let pass = 0; let fail = 0;
const ok = (c, msg) => { if (c) { pass += 1; console.log(`  ok   ${msg}`); } else { fail += 1; console.log(`  FAIL ${msg}`); } };

async function mk(key, spec) {
  const u = await prisma.user.create({
    data: {
      name: `${TAG} T ${spec.label}`, email: `zztest-rf-t-${key}-${Date.now().toString(36)}@example.test`, passwordHash: '!disabled-zztest!', role: spec.role, atsRole: spec.atsRole === undefined ? spec.role : spec.atsRole,
      hrmsAccess: false, atsAccess: true, accountsAccess: false, atsScopeClients: spec.clients || null, atsDepartment: spec.dept || null, status: 'Active',
    },
  });
  made.users.push(u.id);
  const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `ZZRFT-${key}-${Date.now().toString(36)}`, name: u.name, email: u.email, department: spec.dept || null } });
  made.employees.push(e.id);
  return { u, t: jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}
async function call(who, method, url, body) {
  const r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${who.t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { s: r.status, j: json, text };
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health) { console.error('The sandbox API is not running on', API); process.exit(2); }
  const client = await prisma.client.create({ data: { name: `${TAG} T Client`, ownerDepartment: 'ZZTEST-RF-Edu', clientCode: `ZZRFT-${Date.now().toString(36)}`, contactEmail: 'zz-rf-t@example.test', agreementStatus: 'ACTIVE' } });
  made.clients.push(client.id);
  const admin = await mk('admin', { label: 'Admin', role: 'ADMIN' });
  const bde = await mk('bde', { label: 'BDE', role: 'EMPLOYEE', atsRole: 'BDE', dept: 'BDE', clients: client.id });
  const rec = await mk('rec', { label: 'Recruiter', role: 'EMPLOYEE', atsRole: 'RECRUITER', dept: 'ZZTEST-RF-Edu' });
  const mgr = await mk('mgr', { label: 'Manager', role: 'MANAGER', dept: 'ZZTEST-RF-Edu' });

  console.log('1. login status, first login, test');
  // start clean: an Admin removes any login left from an earlier run
  await call(admin, 'DELETE', '/job-publish/credentials/shine');
  let r = await call(bde, 'GET', '/job-publish/credentials/shine/status');
  ok(r.s === 200 && r.j.credential.hasLogin === false, 'BDE reads the Shine login status (no login yet)');
  ok(!('usernameMasked' in r.j.credential), 'the poster view has no username, not even masked');
  r = await call(rec, 'GET', '/job-publish/credentials/shine/status');
  ok(r.s === 403, 'a Recruiter can not read the login status');
  r = await call(rec, 'PUT', '/job-publish/credentials/shine', { username: 'zz@example.test', password: 'zz-test-pass-1' });
  ok(r.s === 403, 'a Recruiter can not save a login');
  r = await call(bde, 'PUT', '/job-publish/credentials/shine', { username: 'zztest-rf@example.test', password: 'zz-test-pass-1', enabled: true, dailyLimit: 999 });
  ok(r.s === 200 && r.j.ok, `BDE saves the FIRST login (${r.s} ${r.j && r.j.error ? r.j.error : ''})`);
  ok(r.s !== 200 || (r.j.credential.hasLogin === true && r.j.credential.enabled === false), 'the switch stays OFF even though the BDE sent enabled:true');
  ok(!/zz-test-pass-1|zztest-rf@example\.test/.test(r.text), 'no username or password in the answer');
  r = await call(bde, 'PUT', '/job-publish/credentials/shine', { username: 'other@example.test', password: 'zz-test-pass-2' });
  ok(r.s === 403 && r.j.code === 'LOGIN_EXISTS', 'BDE can NOT replace an existing login');
  r = await call(bde, 'POST', '/job-publish/credentials/shine/verify');
  ok(r.s === 202 || r.s === 200, `BDE can test the connection (${r.s})`);
  r = await call(bde, 'DELETE', '/job-publish/credentials/shine');
  ok(r.s === 403, 'BDE can not delete the login');
  r = await call(bde, 'POST', '/job-publish/credentials/shine/switch', { enabled: true });
  ok(r.s === 403, 'BDE can not switch posting on');
  r = await call(bde, 'GET', '/job-publish/credentials');
  ok(r.s === 403, 'BDE can not list the logins');
  r = await call(bde, 'GET', '/job-publish/portals');
  const sh = r.j && r.j.portals && r.j.portals.find((p) => p.portal === 'shine');
  ok(r.s === 200 && sh && sh.credential.hasLogin === true && !('usernameMasked' in sh.credential), 'BDE sees hasLogin in the sites list but never the username');

  console.log('2. Admin');
  r = await call(admin, 'GET', '/job-publish/credentials');
  ok(r.s === 200 && !/zz-test-pass-1/.test(r.text), 'Admin lists the logins; the password is nowhere in the answer');
  r = await call(admin, 'PUT', '/job-publish/credentials/shine', { username: 'zztest-rf-2@example.test', password: 'zz-test-pass-3' });
  ok(r.s === 200, 'Admin replaces the login');
  r = await call(admin, 'POST', '/job-publish/credentials/shine/switch', { enabled: true });
  ok(r.s === 200 && r.j.credential.enabled === true, 'Admin switches Shine posting on');

  console.log('3. job preview (template)');
  const fields = { title: `${TAG} T Preview Nurse`, clientId: client.id, location: 'Hyderabad', experience: '2-5 yrs', skills: 'ICU, BLS', employmentType: 'Full Time', jobDescription: 'Care for patients.', joiningTimeline: 'Within 15 Days' };
  r = await call(bde, 'POST', '/job-broadcast/ready-template/preview', { fields });
  ok(r.s === 200 && r.j.texts && r.j.texts.jobPost && r.j.texts.sms, 'BDE gets the preview texts');
  ok(r.s === 200 && !r.text.includes(`${TAG} T Client`), 'the client name is not in the preview text');
  r = await call(mgr, 'POST', '/job-broadcast/ready-template/preview', { fields });
  ok(r.s === 200, 'Manager (request path) gets the preview');
  r = await call(rec, 'POST', '/job-broadcast/ready-template/preview', { fields });
  ok(r.s === 403, 'Recruiter does not get the preview');

  console.log('4. a job, its text and the Post step (dry run)');
  r = await call(admin, 'POST', '/requirements', {
    title: `${TAG} T Nurse`, clientId: client.id, department: 'ZZTEST-RF-Edu', openings: 1, priority: 'Medium', status: 'OPEN', jobDescription: 'Care for patients on the ward.', description: 'Care for patients on the ward.',
    skills: 'ICU, BLS', employmentType: 'Full Time', workMode: 'Work From Office', location: 'Hyderabad', experience: '2-5 yrs', salary: '₹3L - ₹5L', joiningTimeline: 'Within 15 Days', postingSources: 'None', internal: false,
  });
  ok(r.s === 201 || r.s === 200, `Admin creates a job (${r.s} ${r.j && r.j.error ? r.j.error : ''})`);
  const job = r.j;
  if (job && job.id) made.reqs.push(job.id);
  if (job && job.id) {
    const text = 'ZZTEST RF edited job post: we need a staff nurse for the ward. Apply with your CV.';
    r = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/ready-template`, { texts: { jobPost: text, whatsapp: 'Hi {{firstName}}, nurse job. {{applyLink}}', sms: 'Nurse job {{applyLink}} STOP', emailSubject: 'Nurse job', emailBody: 'Apply.' }, note: 'test edit' });
    ok(r.s === 200, `the edited text is saved with the job (${r.s} ${r.j && r.j.error ? r.j.error : ''})`);
    if (r.s === 200) { const u = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/ready-template/use`, { version: r.j.version }); ok(u.s === 200, 'and marked "in use"'); }
    r = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/post-everywhere`, { places: ['foundit'], dryRun: true });
    const f = r.j && r.j.results && r.j.results[0];
    ok(r.s === 200 && f && f.state === 'failed' && /login/i.test(`${f.words} ${f.detail}`), `no login: a dry run on Foundit is refused in plain words, never "queued" (${f && f.state}: ${f && f.detail})`);
    r = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/post-everywhere`, { places: ['foundit'] });
    const f2 = r.j && r.j.results && r.j.results[0];
    ok(r.s === 200 && f2 && f2.state === 'not_connected', `no login, real post: Foundit becomes a by-hand task (${f2 && f2.state})`);
    r = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/post-everywhere`, { places: ['shine'], dryRun: true });
    const sres = r.j && r.j.results && r.j.results[0];
    ok(r.s === 200 && sres && sres.state === 'queued', `login saved + switch on: Shine dry run is queued (${sres && sres.state}: ${sres && (sres.detail || sres.words)})`);
    const q = await prisma.$queryRawUnsafe('SELECT "dryRun","action","status" FROM "PostingQueue" WHERE "requirementId" = ? AND "portal" = ?', job.id, 'shine');
    ok(q.length === 1 && Number(q[0].dryRun) === 1 && q[0].action === 'PUBLISH', 'the queue entry carries dryRun=1');
    const pay = await require('../src/jobPublish/jobPayload').build(job.id, 'shine');
    ok(pay && pay.ok && pay.payload && /ZZTEST RF edited job post/.test(pay.payload.description), 'the post body is the text saved with the job');
    r = await call(admin, 'POST', `/job-broadcast/jobs/${job.id}/post-everywhere`, { places: ['google'], dryRun: true });
    ok(r.s === 200 && r.j.results[0].state === 'not_available', 'a dry run does not touch the feeds');

    console.log('5. Posted on (list)');
    r = await call(admin, 'GET', '/requirements?page=1&pageSize=5&postedOn=none');
    ok(r.s === 200 && Array.isArray(r.j.rows) && r.j.postedCounts && typeof r.j.postedCounts.naukri === 'number', 'the list answers postedCounts and the postedOn filter');
    ok(r.s === 200 && r.j.rows.every((x) => Array.isArray(x.postedOn)), 'every row has postedOn (list)');
  }
}

async function cleanup() {
  const rids = made.reqs;
  const ph = (a) => (a.length ? a.map(() => '?').join(',') : "''");
  for (const [t, col] of [['PostingLog', 'requirementId'], ['PostingQueue', 'requirementId'], ['PortalPosting', 'requirementId']]) {
    try { await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "${col}" IN (${ph(rids)})`, ...rids); } catch { /* table absent */ }
  }
  try { await prisma.$executeRawUnsafe(`DELETE FROM "PostingQueue" WHERE "requestedBy" IN (${ph(made.users)})`, ...made.users); } catch { /* none */ }
  try { await prisma.$executeRawUnsafe('DELETE FROM "PortalCredential" WHERE "portal" = \'shine\' AND ("createdBy" IN (' + ph(made.users) + ') OR "updatedBy" IN (' + ph(made.users) + '))', ...made.users, ...made.users); } catch { /* none */ }
  for (const id of rids) {
    try { await prisma.$executeRawUnsafe('DELETE FROM "AppSetting" WHERE "key" IN (?, ?)', `jobtpl.ready.${id}`, `jobposts.saved.${id}`); } catch { /* none */ }
  }
  await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: rids } } }).catch(() => null);
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...rids, ...made.clients, ...made.users] } }, { toValue: { contains: TAG } }] } }).catch(() => null);
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: 'ZZTEST' } }] } }).catch(() => null);
  await prisma.requirement.deleteMany({ where: { id: { in: rids } } }).catch(() => null);
  await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => null);
  await prisma.employee.deleteMany({ where: { id: { in: made.employees } } }).catch(() => null);
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => null);
}

main().catch((e) => { fail += 1; console.error('ERROR', e); }).finally(async () => {
  await cleanup().catch((e) => console.error('cleanup', e.message));
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
