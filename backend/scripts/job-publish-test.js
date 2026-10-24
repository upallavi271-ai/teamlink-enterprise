// ---------------------------------------------------------------------------
// JOB PUBLISHING ENGINE: acceptance test. SANDBOX ONLY (API 4011, prisma/sandbox.db) + a LOCAL MOCK portal.
//   TL_API=http://localhost:4011 node scripts/job-publish-test.js [--no-browser]
// Real Playwright + the machine's Chrome (headless) drive the mock; without Chrome the browser part is skipped and said so.
// No request ever leaves this machine: the browser is in strict-local mode and the test asserts it.
// Applies the migration SQL to the sandbox copy when the tables are missing (it never touches dev.db).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('JP');
const { BACK, prisma } = Z;
const NO_BROWSER = process.argv.includes('--no-browser');

// ---- private temp folders for sessions / shots / logs; strict-local browser; no pacing
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-jp-'));
Object.assign(process.env, {
  TL_PORTAL_PROFILE_DIR: path.join(TMP, 'profiles'), TL_PORTAL_SCREENSHOT_DIR: path.join(TMP, 'shots'), TL_PORTAL_LOG_DIR: path.join(TMP, 'logs'),
  TL_POSTING_STRICT_LOCAL: '1', TL_PORTAL_NO_PACING: '1', TL_POSTING_BACKOFF_BASE_MS: '1000', TL_POSTING_NO_INLINE: '0',
});
const MOCK = require(path.join(BACK, 'test-fixtures/mock-portal/server.js'));
const D = require(path.join(BACK, 'src/jobPublish/db'));
const Q = require(path.join(BACK, 'src/jobPublish/queue'));
const S = require(path.join(BACK, 'src/jobPublish/settings'));
const Cred = require(path.join(BACK, 'src/jobPublish/credentials'));
const P = require(path.join(BACK, 'src/jobPublish/portalPosting'));
const runner = require(path.join(BACK, 'src/jobPublish/runner'));
const registry = require(path.join(BACK, 'src/portals/registry'));
const browserLib = require(path.join(BACK, 'src/playwright/browser'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = '/api/job-publish';

async function ensureSchema() {
  if (await D.supported()) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')));
  db.exec('PRAGMA busy_timeout=8000');
  db.exec(fs.readFileSync(path.join(BACK, 'prisma/migrations/20261013120000_job_publish_queue/migration.sql'), 'utf8'));
  db.close();
  D.forgetSupport();
  console.log('(applied the migration SQL to the SANDBOX copy)');
}

const cleanSettings = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: 'jobpublish.' } } });
const nowQ = (id) => D.ex('UPDATE "PostingQueue" SET "nextRunAt" = ? WHERE "id" = ?', Date.now() - 1000, id);

(async () => {
  await ensureSchema();
  const left0 = await Z.preclean();
  console.log('preclean', JSON.stringify(left0));
  await cleanSettings();
  await D.ex('DELETE FROM "PortalCredential"'); // (the sandbox holds no real login; a crashed earlier run may have left a test one)
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // ===================================================== fixtures
  const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
  const admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const tlMed = await mk('tlmed', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, tlMed, bde, rec })) tok[k] = await Z.mint(u);
  const client = await prisma.client.create({ data: { name: 'ZZTEST JP Client Acme Ltd', status: 'Active' } });
  Z.made.clients.push(client.id);
  const mkJob = async (title, extra = {}) => {
    const r = await prisma.requirement.create({
      data: {
        title, clientId: client.id, department: 'Education', status: 'OPEN', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id, location: 'Hyderabad', experience: '2-6', skills: 'Physics, Teaching, Research',
        salary: '8-12 LPA', education: 'MSc', openings: 2, jobDescription: 'We are hiring a lecturer to teach physics to degree students in Hyderabad. Strong subject knowledge and a love of teaching are needed. '.repeat(2),
        ...extra,
      },
    });
    Z.made.reqs.push(r.id);
    return r;
  };
  const jobA = await mkJob('ZZTEST JP Physics Lecturer');
  const jobB = await mkJob('ZZTEST JP Chemistry Lecturer');
  const jobC = await mkJob('ZZTEST JP Maths Lecturer');
  const jobMed = await mkJob('ZZTEST JP Nurse', { department: 'Medical', tlId: tlMed.id, bdeId: null, recruiterId: null });
  const jobClosed = await mkJob('ZZTEST JP Closed Job', { status: 'CLOSED' });
  const jobNamesClient = await mkJob('ZZTEST JP Lecturer for ZZTEST JP Client Acme Ltd');

  const mock = await MOCK.start();
  process.env.TL_MOCK_PORTAL_ORIGIN = mock.origin;
  for (const p of ['naukri', 'foundit', 'shine']) process.env[`TL_PORTAL_SELECTORS_${p.toUpperCase()}`] = path.join(BACK, `test-fixtures/mock-portal/selectors/mock-${p}.json`);

  // ===================================================== 1. QUEUE (fake portals zz1..zz9: no browser)
  console.log('\n-- queue');
  await S.setLimits(null, { globalConcurrency: 1, minGapSeconds: 0, maxGapSeconds: 0, perHour: 0, perDay: 0, maxAttempts: 3 });
  const e1 = await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'PUBLISH', payloadHash: 'h1', requestedBy: admin.id });
  const e1b = await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'PUBLISH', payloadHash: 'h1', requestedBy: admin.id });
  Z.check('enqueue: the same request twice is ONE entry (idempotent)', e1.created && !e1b.created && e1b.entry.id === e1.entry.id, [e1b.duplicate]);
  const k1 = await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'REPUBLISH', idempotencyKey: 'abc' });
  const k2 = await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'REPUBLISH', idempotencyKey: 'abc', payloadHash: 'other' });
  Z.check('enqueue: a caller Idempotency-Key returns the stored entry', !k2.created && k2.entry.id === k1.entry.id);
  const [r1, r2] = await Promise.all([Q.enqueue({ requirementId: jobB.id, portal: 'zz1', action: 'PUBLISH', payloadHash: 'race' }), Q.enqueue({ requirementId: jobB.id, portal: 'zz1', action: 'PUBLISH', payloadHash: 'race' })]);
  Z.check('enqueue: two racing requests still give one entry', r1.entry.id === r2.entry.id);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // atomic claim across separate PROCESSES: 6 entries on 6 portals, 4 claimers
  await S.setLimits(null, { globalConcurrency: 10 });
  const ids = [];
  for (let i = 1; i <= 6; i += 1) ids.push((await Q.enqueue({ requirementId: jobA.id, portal: `zz${i}`, action: 'PUBLISH', payloadHash: `c${i}` })).entry.id);
  const claimer = `
    process.env.DATABASE_URL=${JSON.stringify(process.env.DATABASE_URL)};process.env.TEST_MODE='1';
    require(${JSON.stringify(path.join(BACK, 'node_modules/dotenv'))}).config({path:${JSON.stringify(path.join(BACK, '.env'))}});
    const Q=require(${JSON.stringify(path.join(BACK, 'src/jobPublish/queue'))});
    (async()=>{const mine=[];for(;;){const {entry}=await Q.claim({workerId:'proc-'+process.pid});if(!entry)break;mine.push(entry.id);}console.log(JSON.stringify(mine));process.exit(0);})();`;
  const runClaimer = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', claimer], { cwd: BACK, env: process.env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve(null); } });
  });
  const got = await Promise.all([runClaimer(), runClaimer(), runClaimer(), runClaimer()]);
  const all = got.flat();
  Z.check('claim: 4 separate processes claim 6 entries: every entry once, none twice', got.every(Boolean) && all.length === 6 && new Set(all).size === 6 && ids.every((i) => all.includes(i)), got);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // concurrency: 1 per portal, and the global cap
  await S.setLimits(null, { globalConcurrency: 10 });
  const same = [];
  for (let i = 0; i < 3; i += 1) same.push((await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'PUBLISH', payloadHash: `s${i}` })).entry.id);
  const c1 = await Q.claim({ workerId: 'w1' }); const c2 = await Q.claim({ workerId: 'w2' });
  Z.check('concurrency 1 per portal: a second entry on the same portal waits', !!c1.entry && c2.entry === null);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');
  await S.setLimits(null, { globalConcurrency: 1 });
  await Q.enqueue({ requirementId: jobA.id, portal: 'zz1', action: 'PUBLISH', payloadHash: 'g1' }); await Q.enqueue({ requirementId: jobA.id, portal: 'zz2', action: 'PUBLISH', payloadHash: 'g2' });
  const g1 = await Q.claim({ workerId: 'w1' }); const g2 = await Q.claim({ workerId: 'w2' });
  Z.check('global cap 1: two portals do not run at once', !!g1.entry && g2.entry === null);
  await Q.succeed(g1.entry.id, 'w1', {});
  const g3 = await Q.claim({ workerId: 'w2' });
  Z.check('global cap: the next one starts when the first is done', !!g3.entry);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');
  await S.setLimits(null, { globalConcurrency: 10 });

  // retry / backoff / dead letter
  const rt = (await Q.enqueue({ requirementId: jobA.id, portal: 'zz3', action: 'PUBLISH', payloadHash: 'rt' })).entry.id;
  let st = [];
  for (let i = 1; i <= 3; i += 1) {
    const c = await Q.claim({ workerId: 'wr' });
    const t0 = Date.now();
    st.push(await Q.fail(rt, 'wr', { code: 'TIMEOUT', message: 'slow', retryable: true }));
    if (i === 1) { const row = await Q.byId(rt); Z.check('retry: backoff sets a later nextRunAt (attempt 1 about 1 s here, jittered)', row.nextRunAt > t0 && row.status === 'QUEUED' && row.attempts === 1, [row.nextRunAt - t0]); }
    await nowQ(rt);
    if (!c.entry) break;
  }
  const rtRow = await Q.byId(rt);
  Z.check('retry x3 -> DEAD (dead letter)', st.join() === 'QUEUED,QUEUED,DEAD' && rtRow.status === 'DEAD' && rtRow.attempts === 3, [st, rtRow.status]);
  const dl = await Q.list({ status: 'DEAD', portal: 'zz3' });
  Z.check('dead letters list shows it', dl.rows.some((r) => r.id === rt));
  const rr = await Q.retryEntry(rt, admin);
  Z.check('dead letter: Retry puts it back with fresh tries', rr.entry && rr.entry.status === 'QUEUED' && rr.entry.attempts === 0);
  await Q.claim({ workerId: 'wd' }); await Q.fail(rt, 'wd', { code: 'WRONG_PASSWORD', message: 'x', retryable: false });
  Z.check('a non-retryable failure is FAILED at once (not retried)', (await Q.byId(rt)).status === 'FAILED');
  const ds = await Q.discardEntry(rt, admin);
  Z.check('dead letter: Discard closes it for good', ds.entry && ds.entry.status === 'CANCELLED' && ds.entry.errorCode === 'DISCARDED');
  Z.check('cancel refuses a finished entry', (await Q.cancelEntry(rt, admin)).status === 409);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // stale locks
  const sl = (await Q.enqueue({ requirementId: jobA.id, portal: 'zz4', action: 'PUBLISH', payloadHash: 'sl' })).entry.id;
  await Q.claim({ workerId: 'dead-worker' });
  await D.ex('UPDATE "PostingQueue" SET "lockedAt" = ? WHERE "id" = ?', Date.now() - 3600000, sl);
  const rec1 = await Q.recoverStale();
  const slRow = await Q.byId(sl);
  Z.check('stale lock (worker died before Submit): the entry goes back to the queue', rec1.some((x) => x.id === sl && x.to === 'QUEUED') && slRow.status === 'QUEUED' && !slRow.lockedBy);
  await Q.claim({ workerId: 'dead-worker2' }); await Q.markSubmitStarted(sl, 'dead-worker2');
  await D.ex('UPDATE "PostingQueue" SET "lockedAt" = ? WHERE "id" = ?', Date.now() - 3600000, sl);
  await Q.recoverStale();
  const sl2 = await Q.byId(sl);
  Z.check('stale lock AFTER Submit: NEEDS_HUMAN, never put back (it may be live)', sl2.status === 'NEEDS_HUMAN' && sl2.errorCode === 'UNVERIFIED', [sl2.status]);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // rate limits
  await S.setLimits(null, { minGapSeconds: 3, maxGapSeconds: 3 });
  const ra = (await Q.enqueue({ requirementId: jobA.id, portal: 'zz5', action: 'PUBLISH', payloadHash: 'ra' })).entry.id;
  await Q.claim({ workerId: 'wa' }); await Q.succeed(ra, 'wa', {});
  await Q.enqueue({ requirementId: jobB.id, portal: 'zz5', action: 'PUBLISH', payloadHash: 'rb' });
  const rb = await Q.claim({ workerId: 'wa' });
  Z.check('rate limit: the minimum gap between two posts holds the next one back', rb.entry === null && rb.blocked.some((b) => b.kind === 'rate'), rb.blocked);
  await sleep(3300);
  const rb2 = await Q.claim({ workerId: 'wa' });
  Z.check('rate limit: it starts once the gap has passed', !!rb2.entry);
  await Q.succeed(rb2.entry.id, 'wa', {});
  await S.setLimits(null, { minGapSeconds: 0, maxGapSeconds: 0, perHour: 2 });
  await Q.enqueue({ requirementId: jobC.id, portal: 'zz5', action: 'PUBLISH', payloadHash: 'rc' });
  const rc = await Q.claim({ workerId: 'wa' });
  Z.check('rate limit: the per-hour cap (2) holds the third post back', rc.entry === null && rc.blocked.some((b) => /per hour/.test(b.reason)), rc.blocked);
  await S.setLimits(null, { perHour: 0 });
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');

  // kill switches, pause, human hold, schedule
  await Q.enqueue({ requirementId: jobA.id, portal: 'zz6', action: 'PUBLISH', payloadHash: 'k1' });
  await S.setKill(null, true, 'test', admin);
  const kk = await Q.claim({ workerId: 'wk' });
  Z.check('kill switch (all): nothing starts', kk.entry === null && kk.blocked.some((b) => b.kind === 'kill'));
  await S.setKill(null, false, '', admin); await S.setKill('zz6', true, 'test', admin);
  Z.check('kill switch (one portal): that portal does not start', (await Q.claim({ workerId: 'wk' })).entry === null);
  await S.setKill('zz6', false, '', admin); await S.setPause(true, admin);
  const pz = await Q.claim({ workerId: 'wk' });
  Z.check('pause all: quiet, nothing starts', pz.entry === null && pz.blocked.some((b) => b.kind === 'pause'));
  await S.setPause(false, admin); await S.setHumanHold('zz6', { reason: 'captcha' });
  Z.check('human hold: a portal that needs a person does not start', (await Q.claim({ workerId: 'wk' })).entry === null);
  await S.clearHumanHold('zz6');
  const kc = await Q.claim({ workerId: 'wk' });
  Z.check('switches off: it starts', !!kc.entry);
  await Q.succeed(kc.entry.id, 'wk', {});
  const when = Date.now() + 3600000;
  const sc = (await Q.enqueue({ requirementId: jobA.id, portal: 'zz7', action: 'PUBLISH', payloadHash: 'sch', scheduledFor: when })).entry;
  Z.check('scheduled publish: not claimable before its time', sc.scheduledFor && (await Q.claim({ workerId: 'wk' })).entry === null);
  await nowQ(sc.id);
  Z.check('scheduled publish: claimable when due', !!(await Q.claim({ workerId: 'wk' })).entry);
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\'');
  await cleanSettings();

  // ===================================================== 2. CREDENTIALS
  console.log('\n-- credentials');
  const u0 = await Cred.save('naukri', { username: MOCK.VALID_USER, password: MOCK.VALID_PASS }, admin);
  const dbRow = await D.q1('SELECT * FROM "PortalCredential" WHERE "portal" = \'naukri\'');
  Z.check('credentials: saved ENCRYPTED (the database value is not plaintext)', !!dbRow && dbRow.usernameEnc.startsWith('enc:v1:') && dbRow.passwordEnc.startsWith('enc:v1:') && !JSON.stringify(dbRow).includes(MOCK.VALID_PASS) && !JSON.stringify(dbRow).includes(MOCK.VALID_USER), u0.error);
  Z.check('credentials: the switch is OFF by default and the status is "not checked"', dbRow.enabled === 0 && dbRow.status === 'UNVERIFIED');
  const apiList = await Z.call('GET', `${J}/credentials`, tok.admin);
  const apiText = JSON.stringify(apiList.body);
  Z.check('credentials API: never returns the password or the username (masked only)', apiList.status === 200 && !apiText.includes(MOCK.VALID_PASS) && !apiText.includes(MOCK.VALID_USER) && /usernameMasked/.test(apiText), apiList.status);
  const put = await Z.call('PUT', `${J}/credentials/naukri`, tok.admin, { username: 'ab-new@mock.test', password: 'Another#Pass9' });
  Z.check('credentials API: save answers without a secret', put.status === 200 && !JSON.stringify(put.body).includes('Another#Pass9') && !JSON.stringify(put.body).includes('ab-new@mock.test'), put.body);
  await Cred.save('naukri', { username: MOCK.VALID_USER, password: MOCK.VALID_PASS }, admin);
  const aud = await prisma.auditLog.findMany({ where: { entity: 'PortalCredential' } });
  Z.check('audit: "Portal credential updated" rows exist and hold no secret', aud.some((a) => a.action === 'Portal credential updated') && !JSON.stringify(aud).includes(MOCK.VALID_PASS) && !JSON.stringify(aud).includes('Another#Pass9'));
  const L1 = await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "PostingLog" WHERE "message" LIKE ?', `%${MOCK.VALID_PASS}%`);
  Z.check('logs: no password in any log row', Number(L1[0].n) === 0);
  for (const [who, expect] of [['tl', 403], ['bde', 403], ['rec', 403], ['mgr', 403], ['admin', 200]]) {
    const r = await Z.call('GET', `${J}/credentials`, tok[who]);
    Z.check(`credentials are Admin only: ${who} -> ${expect}`, r.status === expect, r.status);
  }
  const lk = await Cred.save('linkedin', { username: 'x', password: 'y' }, admin);
  Z.check('LinkedIn: no login can be saved (manual only)', !!lk.error && /by hand/.test(lk.error));
  Z.check('LinkedIn is shown as manual only', (await Cred.one('linkedin')).manualOnly === true && (await Cred.one('linkedin')).statusWords === 'Manual only');
  const sw = await Z.call('POST', `${J}/credentials/naukri/switch`, tok.admin, { enabled: true });
  Z.check('credentials: the per-portal switch can be turned ON', sw.status === 200 && sw.body.credential.enabled === true, sw.body);
  await Cred.setEnabled('naukri', false, admin);

  // ===================================================== 3. API: roles, scope, by-hand, bulk, career
  console.log('\n-- API / roles / scope');
  const health = await Z.call('GET', `${J}/health`, tok.admin);
  Z.check('health answers (migrated)', health.status === 200 && health.body.migrated === true, health.body);
  const post = (who, id, body) => Z.call('POST', `${J}/jobs/${id}/publish`, tok[who], body);
  Z.check('Recruiter cannot publish (403)', (await post('rec', jobA.id, { portals: ['naukri'] })).status === 403);
  Z.check('Manager is view-only (403)', (await post('mgr', jobA.id, { portals: ['naukri'] })).status === 403);
  Z.check('a TL of ANOTHER department cannot publish this job (403)', (await post('tlMed', jobA.id, { portals: ['naukri'] })).status === 403);
  const off = await post('tl', jobA.id, { portals: ['naukri', 'linkedin'] });
  const byHand = off.body && off.body.results;
  Z.check('Naukri with the switch OFF: no queue entry, a by-hand task instead', off.status === 200 && byHand && byHand[0].mode === 'by_hand' && !byHand[0].queued, off.body);
  const rp = await prisma.requirementPosting.findMany({ where: { requirementId: jobA.id } });
  Z.check('the existing by-hand task row exists for Naukri and LinkedIn', ['naukri', 'linkedin'].every((s) => rp.some((x) => x.source === s && x.status === 'Integration Required')), rp.map((x) => [x.source, x.status]));
  Z.check('LinkedIn always by hand (never queued)', byHand[1].mode === 'by_hand' && byHand[1].portal === 'linkedin');
  Z.check('a closed job cannot be published', (await post('tl', jobClosed.id, { portals: ['naukri'] })).body.results[0].mode === 'refused');
  const built = await require(path.join(BACK, 'src/jobPublish/jobPayload')).build(jobNamesClient.id, 'career');
  const leakText = JSON.stringify([built.payload.title, built.payload.description]).toLowerCase();
  Z.check('the client name is masked in the title and text a portal receives', built.payload && !leakText.includes('acme') && /our client|confidential/i.test(leakText), built.payload && built.payload.title);
  Z.check('the company shown on a public board is TeamLink Consultants, never the client', built.payload.companyName === 'TeamLink Consultants');
  Z.check('a job with missing fields is refused with the list', (await (async () => {
    const j = await mkJob('ZZTEST JP No Location', { location: null, experience: null });
    await Cred.setEnabled('naukri', true, admin);
    const r = await post('tl', j.id, { portals: ['naukri'] });
    await Cred.setEnabled('naukri', false, admin);
    return r.body.results[0].mode === 'refused' && /Job location/.test(r.body.results[0].reason);
  })()));
  const noPortal = await post('tl', jobA.id, { portals: [] });
  Z.check('no site chosen -> 400', noPortal.status === 400);
  const stRec = await Z.call('GET', `${J}/jobs/${jobA.id}/status`, tok.rec);
  Z.check('Recruiter may see the status of an assigned job, but no logs', stRec.status === 200 && stRec.body.portals.length === 7 && stRec.body.canViewLogs === false && stRec.body.portals.every((p) => p.logs === undefined), stRec.status);
  Z.check('Recruiter cannot read logs / queue', (await Z.call('GET', `${J}/logs`, tok.rec)).status === 403 && (await Z.call('GET', `${J}/queue`, tok.rec)).status === 403);
  Z.check('Manager can read logs and queue (view all)', (await Z.call('GET', `${J}/logs`, tok.mgr)).status === 200 && (await Z.call('GET', `${J}/queue`, tok.mgr)).status === 200);
  Z.check('TL of another department cannot see this job status (403)', (await Z.call('GET', `${J}/jobs/${jobA.id}/status`, tok.tlMed)).status === 403);
  const dashTl = await Z.call('GET', `${J}/dashboard`, tok.tl);
  Z.check('dashboard: shape (totals, portal-wise, 7-day trend)', dashTl.status === 200 && dashTl.body.totals && Array.isArray(dashTl.body.portals) && dashTl.body.trend.length === 7, dashTl.body);
  Z.check('dashboard is scoped: a TL counts fewer jobs than an Admin', (await Z.call('GET', `${J}/dashboard`, tok.admin)).body.totals.totalJobs > dashTl.body.totals.totalJobs);

  // career page (own page, no browser): published inline, then taken down
  // (the sandbox API restarts whenever another agent edits src/: a request cut off in the middle is retried by the helper and finds its own queue entry)
  const car = await post('tl', jobB.id, { portals: ['career'] });
  if (car.body.results[0].entry && car.body.results[0].entry.status === 'QUEUED') await require(path.join(BACK, 'src/jobPublish/service')).runInline(car.body.results[0].entry.id);
  const cr = car.body.results && car.body.results[0];
  if (cr && cr.entry) cr.entry = Q.shape(await Q.byId(cr.entry.id));
  const careerPosting = await P.get(jobB.id, 'career');
  Z.check('career page: published at once (no browser), Published only after the page lists it', cr && (cr.mode === 'already' || (cr.entry && cr.entry.status === 'SUCCEEDED')) && careerPosting && careerPosting.status === 'PUBLISHED' && !!careerPosting.verifiedAt, [cr && cr.reason, cr && cr.entry && cr.entry.errorMessage, careerPosting && careerPosting.status]);
  await P.set(jobB.id, 'career', { status: 'PUBLISHED' });
  const un = await Z.call('POST', `${J}/jobs/${jobB.id}/unpublish`, tok.tl, { portals: ['career'] });
  Z.check('career page: unpublish', ['queued', 'nothing'].includes(un.body.results[0].mode) && (await P.get(jobB.id, 'career')).status === 'UNPUBLISHED', un.body);

  // ===================================================== 4. BROWSER (mock portal)
  await D.ex('UPDATE "PostingQueue" SET "lockedAt" = 0 WHERE "status" = \'RUNNING\''); await Q.recoverStale(); // (an inline run cut off by a restart)
  const chrome = browserLib.findBrowser();
  if (NO_BROWSER || !chrome) {
    console.log(`\n-- browser tests SKIPPED (${NO_BROWSER ? '--no-browser' : 'no Chrome or Edge found'}): only the fake-page checks above ran`);
  } else {
    console.log(`\n-- browser (headless ${chrome.label}) against the local mock portal ${mock.origin}`);
    await S.setLimits(null, { globalConcurrency: 1, minGapSeconds: 0, maxGapSeconds: 0, perHour: 0, perDay: 0, runDeadlineMs: 90000 });
    const prime = async (portal, user = MOCK.VALID_USER, pass = MOCK.VALID_PASS) => { await Cred.save(portal, { username: user, password: pass }, admin); await Cred.setEnabled(portal, true, admin); };
    // run one entry like the worker does
    const work = async (jobId, portal, action, o = {}) => {
      const e = await Q.enqueue({ requirementId: jobId, portal, action, payloadHash: String(Date.now()) + Math.random(), requestedBy: admin.id, requestedByName: admin.name, dryRun: !!o.dryRun, maxAttempts: o.maxAttempts });
      const id = e.entry.id; let out = null;
      // like a real worker: claim and run until THIS entry is finished (an older entry of the portal may go first; a retry skips its wait)
      for (let n = 0; n < 10; n += 1) {
        if ((await Q.byId(id)).status !== 'QUEUED') break;
        if (n > 0) await nowQ(id);
        const claimed = await Q.claim({ workerId: 'test-worker', onlyPortals: [portal] });
        if (!claimed.entry) { await sleep(1000); continue; }
        const r = await runner.processEntry(claimed.entry, { workerId: 'test-worker' });
        if (claimed.entry.id === id) out = r;
      }
      return { out, entry: Q.shape(await Q.byId(id)), posting: await P.get(jobId, portal) };
    };

    // 4a. each adapter publishes, captures the id, verifies, and unpublishes
    for (const portal of ['naukri', 'foundit', 'shine']) {
      await prime(portal);
      const job = await mkJob(`ZZTEST JP ${portal} Physics Lecturer`);
      const pub = await work(job.id, portal, 'PUBLISH');
      const prefix = { naukri: 'NK', foundit: 'FD', shine: 'SH' }[portal];
      Z.check(`${portal}: publish -> PUBLISHED with the portal job id and link, verified`, pub.posting && pub.posting.status === 'PUBLISHED' && new RegExp(`^${prefix}-\\d+`).test(pub.posting.portalJobId) && !!pub.posting.portalUrl && !!pub.posting.verifiedAt && pub.entry.status === 'SUCCEEDED', [pub.out, pub.posting, pub.entry.errorMessage]);
      const mj = mock.state.jobs.get(pub.posting && pub.posting.portalJobId);
      Z.check(`${portal}: the mock site really holds the job (title, description, mapped fields)`, !!mj && mj.status === 'live' && /Physics Lecturer/.test(mj.title) && JSON.stringify(mj.fields).includes('Hyderabad'), mj && mj.fields);
      const legacy = await prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId: job.id, source: portal } } }).catch(() => null);
      if (portal !== 'foundit') Z.check(`${portal}: the old job page row is kept in step ('Posted by hand' by automation, never 'Posted')`, legacy && legacy.status === 'Posted by hand' && legacy.externalJobId === pub.posting.portalJobId, legacy);
      if (portal === 'naukri') {
        const up = await work(job.id, portal, 'UPDATE');
        Z.check('naukri: update edits the live job (same id)', up.posting.status === 'PUBLISHED' && up.posting.portalJobId === pub.posting.portalJobId && (mock.state.jobs.get(pub.posting.portalJobId).edits || 0) === 1, [up.out, up.entry.errorMessage]);
        const rp2 = await work(job.id, portal, 'REPUBLISH');
        Z.check('naukri: republish of a live job refreshes it', rp2.posting.status === 'PUBLISHED' && rp2.entry.status === 'SUCCEEDED', rp2.entry.errorMessage);
      }
      const dry = await work(job.id, portal, 'PUBLISH', { dryRun: true });
      const postsBefore = mock.state.posts;
      Z.check(`${portal}: DRY RUN fills the form and photographs it, submits nothing`, dry.entry.status === 'SUCCEEDED' && dry.entry.result && dry.entry.result.dryRun && mock.state.posts === postsBefore, dry.entry);
      const down = await work(job.id, portal, 'UNPUBLISH');
      Z.check(`${portal}: unpublish closes the job on the site`, down.posting.status === 'UNPUBLISHED' && mock.state.jobs.get(pub.posting.portalJobId).status === 'closed', [down.out, down.entry.errorMessage]);
    }
    const logins = mock.state.logins;
    Z.check('session reuse: several runs signed in only a few times (cookies reused)', logins <= 6, logins);

    // 4b. never fake "Posted"
    await prime('naukri');
    const noid = await work((await mkJob('ZZTEST JP NOID Lecturer')).id, 'naukri', 'PUBLISH');
    Z.check('no job id on the confirmation -> NEEDS_CHECK, never PUBLISHED; queue NEEDS_HUMAN; not retried', noid.posting.status === 'NEEDS_CHECK' && noid.entry.status === 'NEEDS_HUMAN' && noid.entry.errorCode === 'NO_JOB_ID' && noid.entry.attempts === 1, [noid.posting, noid.entry.errorCode]);
    const ghost = await work((await mkJob('ZZTEST JP GHOST Lecturer')).id, 'naukri', 'PUBLISH');
    Z.check('accepted but the listing does not show it -> NEEDS_CHECK (id kept for the person)', ghost.posting.status === 'NEEDS_CHECK' && !ghost.posting.verifiedAt && !!ghost.posting.portalJobId && ghost.entry.status === 'NEEDS_HUMAN', [ghost.posting, ghost.entry.errorCode]);
    const rej = await work((await mkJob('ZZTEST JP REJECT Lecturer')).id, 'naukri', 'PUBLISH', { loops: 2 });
    Z.check('the portal rejects the form -> FAILED, not retried', rej.entry.status === 'FAILED' && rej.entry.attempts === 1 && rej.posting.status === 'FAILED', [rej.entry.status, rej.entry.errorMessage]);

    // 4c. CAPTCHA / OTP / 2-step / unusual / blocked -> NEEDS_HUMAN, never retried, the task is kept, the portal is put on hold
    await S.setLimits(null, { otpWaitMs: 1500 }); // nobody types the OTP here: the run waits 1.5 s, then stops as "needs a person" (the typed-OTP flow is tested in job-publish-diag-test.js)
    for (const [user, code] of [['captcha-user', 'CAPTCHA'], ['otp-user', 'OTP'], ['twofactor-user', 'TWO_FACTOR'], ['unusual-user', 'UNUSUAL_ACTIVITY'], ['blocked-user', 'BLOCKED']]) {
      await Cred.save('naukri', { username: user, password: 'whatever1' }, admin); await Cred.setEnabled('naukri', true, admin); await S.clearHumanHold('naukri');
      const job = await mkJob(`ZZTEST JP ${code} Lecturer`);
      const r = await work(job.id, 'naukri', 'PUBLISH', { loops: 3 });
      const hold = await S.humanHold('naukri');
      const l = await prisma.$queryRawUnsafe('SELECT "screenshotPath" s FROM "PostingLog" WHERE "queueId" = ? AND "screenshotPath" IS NOT NULL', r.entry.id);
      Z.check(`${code}: NEEDS_HUMAN, attempts stays 1 (never retried), screenshot kept, portal on hold`, r.entry.status === 'NEEDS_HUMAN' && r.entry.errorCode === code && r.entry.attempts === 1 && !!hold && l.length >= 1, [r.entry.status, r.entry.errorCode, r.entry.attempts, !!hold, l.length]);
      if (code === 'CAPTCHA') {
        const hand = await prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId: job.id, source: 'naukri' } } });
        Z.check('CAPTCHA: the by-hand task is kept so the job is never lost', hand && hand.status === 'Integration Required', hand);
        await Q.enqueue({ requirementId: job.id, portal: 'naukri', action: 'REPUBLISH', payloadHash: 'afterhold' });
        const wait = await Q.claim({ workerId: 'tw' });
        Z.check('CAPTCHA: the next entry for that portal waits (no more attempts on a flagged account)', wait.entry === null && wait.blocked.some((b) => b.kind === 'human'));
        await D.ex('DELETE FROM "PostingQueue" WHERE "requirementId" = ? AND "status" = \'QUEUED\'', job.id);
        const cs = await Cred.one('naukri');
        Z.check('CAPTCHA: the credential shows "needs a person"', cs.status === 'NEEDS_HUMAN');
      }
    }
    await S.clearHumanHold('naukri');

    // 4d. wrong password -> FAILED non-retryable, credential FAILED, posting stops
    await Cred.save('naukri', { username: MOCK.VALID_USER, password: 'wrong-password-1' }, admin); await Cred.setEnabled('naukri', true, admin);
    const wp = await work((await mkJob('ZZTEST JP Wrongpass Lecturer')).id, 'naukri', 'PUBLISH', { loops: 3 });
    Z.check('wrong password -> FAILED, attempts 1, never retried', wp.entry.status === 'FAILED' && wp.entry.errorCode === 'WRONG_PASSWORD' && wp.entry.attempts === 1, [wp.entry.status, wp.entry.errorCode, wp.entry.attempts]);
    Z.check('wrong password: the login is marked FAILED', (await Cred.one('naukri')).status === 'FAILED');
    const blockedNow = await Z.call('POST', `${J}/jobs/${jobA.id}/publish`, tok.tl, { portals: ['naukri'] });
    Z.check('after a failed login the portal gets no automatic posting (by-hand task instead)', blockedNow.body.results[0].mode === 'by_hand' && /failed/i.test(blockedNow.body.results[0].reason), blockedNow.body);

    // 4e. timeout before Submit -> retried, then DEAD
    await Cred.save('naukri', { username: 'slow-user', password: 'whatever1' }, admin); await Cred.setEnabled('naukri', true, admin);
    const slow = await work((await mkJob('ZZTEST JP Slow Lecturer')).id, 'naukri', 'PUBLISH', { loops: 3 });
    Z.check('timeout before Submit: retried 3 times then DEAD (dead letter)', slow.entry.status === 'DEAD' && slow.entry.attempts === 3 && slow.posting.status === 'FAILED', [slow.entry.status, slow.entry.attempts, slow.entry.errorCode]);
    // 4f. a failure AFTER Submit is never retried
    await prime('naukri');
    const sp = await work((await mkJob('ZZTEST JP SLOWPOST Lecturer')).id, 'naukri', 'PUBLISH', { loops: 3 });
    Z.check('SLOW answer after Submit: never retried (it could post twice) -> NEEDS_HUMAN', sp.entry.status === 'NEEDS_HUMAN' && sp.entry.attempts === 1 && sp.posting.status === 'NEEDS_CHECK', [sp.entry.status, sp.entry.attempts, sp.entry.errorCode]);

    // 4g. kill switch stops a run in progress
    await S.setKill('naukri', true, 'test', admin);
    const killed = await Q.enqueue({ requirementId: jobA.id, portal: 'naukri', action: 'PUBLISH', payloadHash: 'killed' });
    const kc2 = await Q.claim({ workerId: 'tw' });
    Z.check('kill switch: a queued entry is not claimed', kc2.entry === null);
    await S.setKill('naukri', false, '', admin);
    await Q.cancelEntry(killed.entry.id, admin);

    // 4h. the network guard: a page cannot leave localhost in strict mode
    const ext = path.join(TMP, 'external-naukri.json');
    const base = JSON.parse(fs.readFileSync(process.env.TL_PORTAL_SELECTORS_NAUKRI, 'utf8'));
    base.urls.login = 'https://www.naukri.com/recruit/login'; base.urls.dashboard = 'https://www.naukri.com/recruit/dashboard';
    fs.writeFileSync(ext, JSON.stringify(base));
    const keep = process.env.TL_PORTAL_SELECTORS_NAUKRI; process.env.TL_PORTAL_SELECTORS_NAUKRI = ext;
    await prime('naukri');
    const guard = await work((await mkJob('ZZTEST JP Guard Lecturer')).id, 'naukri', 'PUBLISH');
    process.env.TL_PORTAL_SELECTORS_NAUKRI = keep;
    Z.check('no real portal can be reached: an outside address is blocked before it leaves the machine', guard.entry.status !== 'SUCCEEDED' && /not allowed|blocked/i.test(`${guard.entry.errorMessage} ${guard.entry.errorCode}`), [guard.entry.status, guard.entry.errorCode, guard.entry.errorMessage]);
    const hosts = [...new Set(mock.state.requests.map((r) => String(r.host).split(':')[0]))];
    Z.check('every request the mock saw was local', hosts.length === 1 && hosts[0] === '127.0.0.1', hosts);

    // 4i. the real worker process: --drain does a publish through the API
    await prime('shine');
    const wj = await mkJob('ZZTEST JP Worker Process Lecturer');
    const viaApi = await Z.call('POST', `${J}/jobs/${wj.id}/publish`, tok.tl, { portals: ['shine'] });
    const qid = viaApi.body.results && viaApi.body.results[0].queueId;
    Z.check('API publish queues and answers at once (the worker does the posting)', viaApi.status === 202 && !!qid && viaApi.body.results[0].entry.status === 'QUEUED', viaApi.body);
    // (async: the mock portal lives in THIS process, so it must keep answering while the worker runs)
    const wr = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(BACK, 'src/workers/postingWorker.js'), '--drain'], { cwd: BACK, env: { ...process.env, PORT: '4011' } });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      const kill = setTimeout(() => c.kill(), 240000);
      c.on('close', (code) => { clearTimeout(kill); resolve({ status: code, stdout, stderr }); });
    });
    const after = await Z.call('GET', `${J}/jobs/${wj.id}/status`, tok.tl);
    const shineRow = after.body.portals.find((p) => p.portal === 'shine');
    Z.check('worker process --drain: published, status via the API, logs for a TL', wr.status === 0 && shineRow.status === 'PUBLISHED' && /^SH-/.test(shineRow.portalJobId) && Array.isArray(shineRow.logs) && shineRow.logs.length > 0, [wr.status, (wr.stdout || '').slice(-300), (wr.stderr || '').slice(-300)]);
    const lg = await Z.call('GET', `${J}/logs?job=${wj.id}`, tok.tl);
    Z.check('logs API: scoped, no secret', lg.status === 200 && lg.body.rows.length > 3 && !JSON.stringify(lg.body).includes(MOCK.VALID_PASS));
    const hb = await Z.call('GET', `${J}/health`, tok.admin);
    Z.check('health shows the worker heartbeat', hb.body.worker && hb.body.worker.lastSeenAt, hb.body.worker);
  }

  // ===================================================== 5. WORKER GUARD + EXISTING FLOWS
  console.log('\n-- worker guard / existing flows');
  const realRun = spawnSync(process.execPath, [path.join(BACK, 'src/workers/postingWorker.js'), '--once'], { cwd: BACK, env: { ...process.env, DATABASE_URL: 'file:./dev.db', TL_ALLOW_REAL_POSTING: '' }, encoding: 'utf8', timeout: 60000 });
  Z.check('the worker REFUSES the real dev.db without TL_ALLOW_REAL_POSTING', realRun.status === 2 && /REFUSING/.test(realRun.stderr), [realRun.status, realRun.stderr.slice(0, 200)]);
  const sd = await Z.call('GET', `/api/requirements/${jobA.id}/posting-sites`, tok.tl);
  Z.check('existing: GET posting-sites still works (six sites)', sd.status === 200 && Array.isArray(sd.body.sites) && sd.body.sites.length >= 6, sd.status);
  const xml = await Z.call('GET', '/api/public/feeds/indeed.xml');
  Z.check('existing: the Indeed XML feed still answers', xml.status === 200 && /<source>/.test(xml.text), xml.status);
  const cp = await Z.call('GET', '/api/public/careers/jobs');
  Z.check('existing: the careers page list still answers', [200, 304].includes(cp.status), cp.status);
  Z.check('existing: a Recruiter still cannot Save & Post (old endpoint)', (await Z.call('PUT', `/api/requirements/${jobA.id}/posting-sites`, tok.rec, { sites: ['website'] })).status === 403);

  // ===================================================== cleanup
  await mock.close();
  await Q.cancelEntry; // (no-op reference)
  await D.ex('DELETE FROM "PostingQueue" WHERE "requirementId" IN (SELECT "id" FROM "Requirement" WHERE "title" LIKE \'ZZTEST JP%\')');
  await D.ex('DELETE FROM "PortalPosting" WHERE "requirementId" IN (SELECT "id" FROM "Requirement" WHERE "title" LIKE \'ZZTEST JP%\')');
  await D.ex('DELETE FROM "PostingLog" WHERE "requirementId" IN (SELECT "id" FROM "Requirement" WHERE "title" LIKE \'ZZTEST JP%\')');
  await D.ex('DELETE FROM "PostingLog" WHERE "portal" LIKE \'zz%\' OR "queueId" IS NULL');
  await D.ex('DELETE FROM "PostingQueue" WHERE "portal" LIKE \'zz%\' OR "requirementId" IS NULL');
  await D.ex('DELETE FROM "PortalCredential"');
  await cleanSettings();
  await prisma.auditLog.deleteMany({ where: { OR: [{ entity: 'PortalCredential' }, { entity: 'PortalMapping' }, { entity: 'JobPublish' }, { action: { in: ['Posted by automation', 'Taken down by automation'] } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'the requirement is live' } }, { title: { contains: 'a person is needed' } }, { title: { contains: 'did not go through' } }] } }).catch(() => {});
  const left = await Z.cleanup();
  const lq = await D.q('SELECT (SELECT COUNT(*) FROM "PostingQueue") q, (SELECT COUNT(*) FROM "PortalPosting") p, (SELECT COUNT(*) FROM "PostingLog") l, (SELECT COUNT(*) FROM "PortalCredential") c');
  Z.check('cleanup: no ZZTEST row and no engine row left', Object.values(left).every((n) => n === 0) && Object.values(lq[0]).every((n) => n === 0), [left, lq[0]]);
  fs.rmSync(TMP, { recursive: true, force: true });
  await Z.finish();
})().catch(async (e) => { console.error('TEST CRASHED', e); try { await Z.cleanup(); await D.ex('DELETE FROM "PortalCredential"'); await cleanSettings(); } catch { /* */ } process.exit(1); });
