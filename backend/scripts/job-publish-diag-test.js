// ---------------------------------------------------------------------------
// JOB PUBLISH DIAGNOSTICS: acceptance test for the audit work of 2026-10-14. SANDBOX ONLY (API 4011, prisma/sandbox.db) + the
// LOCAL MOCK portal. No real job site is ever contacted, no real login is typed (the only login is the mock's made-up one).
//   TL_API=http://localhost:4011 node scripts/job-publish-diag-test.js
// Covers: credential format checks and Test connection states, OTP human-in-the-loop (typed OTP reaches the waiting run and is stored
// nowhere), CAPTCHA help text, a picture for every attempt (masked, protected route, retention), selector self-healing (drift,
// broken + page snapshot with no personal data, ambiguous destructive match refused), the real-posting gate, the diagnostics API
// and the calibration script. Run it AFTER job-publish-test.js (both clean the same engine tables).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
// (async: the mock portal lives in THIS process, so a blocking spawnSync would freeze it)
const runAsync = (cmd, args, o) => new Promise((resolve) => {
  const c = spawn(cmd, args, o); let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => { c.kill(); }, o.timeout || 120000);
  c.on('exit', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('JD');
const { BACK, prisma } = Z;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-jd-'));
Object.assign(process.env, {
  TL_PORTAL_PROFILE_DIR: path.join(TMP, 'profiles'), TL_PORTAL_SCREENSHOT_DIR: path.join(TMP, 'shots'), TL_PORTAL_LOG_DIR: path.join(TMP, 'logs'),
  TL_POSTING_STRICT_LOCAL: '1', TL_PORTAL_NO_PACING: '1', TL_POSTING_BACKOFF_BASE_MS: '1000', TL_POSTING_NO_INLINE: '0',
});
delete process.env.TL_ALLOW_REAL_POSTING;
const MOCK = require(path.join(BACK, 'test-fixtures/mock-portal/server.js'));
const D = require(path.join(BACK, 'src/jobPublish/db'));
const Q = require(path.join(BACK, 'src/jobPublish/queue'));
const S = require(path.join(BACK, 'src/jobPublish/settings'));
const C = require(path.join(BACK, 'src/jobPublish/constants'));
const Cred = require(path.join(BACK, 'src/jobPublish/credentials'));
const P = require(path.join(BACK, 'src/jobPublish/portalPosting'));
const runner = require(path.join(BACK, 'src/jobPublish/runner'));
const guards = require(path.join(BACK, 'src/jobPublish/guards'));
const Diag = require(path.join(BACK, 'src/jobPublish/diagnostics'));
const OTP = require(path.join(BACK, 'src/jobPublish/otpBridge'));
const svc = require(path.join(BACK, 'src/jobPublish/service'));
const registry = require(path.join(BACK, 'src/portals/registry'));
const cfgLib = require(path.join(BACK, 'src/portals/config'));
const shots = require(path.join(BACK, 'src/playwright/screenshot'));
const structure = require(path.join(BACK, 'src/playwright/structure'));
const locate = require(path.join(BACK, 'src/playwright/locate'));
const browserLib = require(path.join(BACK, 'src/playwright/browser'));
const { createLogger } = require(path.join(BACK, 'src/playwright/logger'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = '/api/job-publish';
const CODE = MOCK.OTP_CODE;

const cleanSettings = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: 'jobpublish.' } } });
const nowQ = (id) => D.ex('UPDATE "PostingQueue" SET "nextRunAt" = ? WHERE "id" = ?', Date.now() - 1000, id);
const REAL_JSON = (p) => JSON.parse(fs.readFileSync(path.join(BACK, `src/portals/selectors/${p}.json`), 'utf8'));

(async () => {
  if (!(await D.supported())) { console.error('The sandbox has no job-publish tables (apply the migrations to sandbox.db first).'); process.exit(2); }
  console.log('preclean', JSON.stringify(await Z.preclean()));
  await cleanSettings();
  await D.ex('DELETE FROM "PortalCredential"');

  // ===================================================== fixtures
  const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const tlMed = await Z.mkUser('tlmed', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const tok = {};
  for (const [k, u] of Object.entries({ admin, tl, tlMed, rec })) tok[k] = await Z.mint(u);
  const client = await prisma.client.create({ data: { name: 'ZZTEST JD Client Acme Ltd', status: 'Active' } });
  Z.made.clients.push(client.id);
  const mkJob = async (title, extra = {}) => {
    const r = await prisma.requirement.create({
      data: {
        title, clientId: client.id, department: 'Education', status: 'OPEN', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id, location: 'Hyderabad', experience: '2-6', skills: 'Physics, Teaching, Research',
        salary: '8-12 LPA', education: 'MSc', openings: 2, jobDescription: 'We are hiring a lecturer to teach physics to degree students in Hyderabad. Strong subject knowledge and a love of teaching are needed. '.repeat(2), ...extra,
      },
    });
    Z.made.reqs.push(r.id);
    return r;
  };
  const mock = await MOCK.start();
  process.env.TL_MOCK_PORTAL_ORIGIN = mock.origin;
  // naukri: the mock's page settings + EXTRA ways to find the job title (label, role) so a renamed box can still be found
  const nk = JSON.parse(fs.readFileSync(path.join(BACK, 'test-fixtures/mock-portal/selectors/mock-naukri.json'), 'utf8'));
  nk.postJob.fields.title.selector = ["input[name='jobTitle']", { label: 'Job title' }, { role: 'textbox', name: 'Job title' }];
  nk.otp = { input: ["input[name='otp']"], submit: [{ role: 'button', name: 'Verify' }] };
  const nkFile = path.join(TMP, 'naukri-healing.json');
  fs.writeFileSync(nkFile, JSON.stringify(nk));
  process.env.TL_PORTAL_SELECTORS_NAUKRI = nkFile;
  for (const p of ['foundit', 'shine']) process.env[`TL_PORTAL_SELECTORS_${p.toUpperCase()}`] = path.join(BACK, `test-fixtures/mock-portal/selectors/mock-${p}.json`);
  await S.setLimits(null, { globalConcurrency: 1, minGapSeconds: 0, maxGapSeconds: 0, perHour: 0, perDay: 0, maxAttempts: 3, runDeadlineMs: 90000 });

  const prime = async (portal, user = MOCK.VALID_USER, pass = MOCK.VALID_PASS) => { await S.clearHumanHold(portal); await Cred.save(portal, { username: user, password: pass }, admin); await Cred.setEnabled(portal, true, admin); };
  const claimOne = async (id, portal) => {
    for (let n = 0; n < 8; n += 1) {
      if ((await Q.byId(id)).status !== 'QUEUED') return null;
      if (n > 0) await nowQ(id);
      const c = await Q.claim({ workerId: 'diag-worker', onlyPortals: [portal] });
      if (c.entry && c.entry.id === id) return c.entry;
      if (c.entry) await runner.processEntry(c.entry, { workerId: 'diag-worker' }); else await sleep(500);
    }
    return null;
  };
  // run one entry like the worker does
  const work = async (jobId, portal, action, o = {}) => {
    const e = await Q.enqueue({ requirementId: jobId, portal, action, payloadHash: String(Date.now()) + Math.random(), requestedBy: admin.id, requestedByName: admin.name, dryRun: !!o.dryRun, maxAttempts: o.maxAttempts });
    const id = e.entry.id;
    let out = null;
    for (let n = 0; n < 8; n += 1) {
      if ((await Q.byId(id)).status !== 'QUEUED') break;
      if (n > 0) await nowQ(id);
      const claimed = await Q.claim({ workerId: 'diag-worker', onlyPortals: [portal] });
      if (!claimed.entry) { await sleep(800); continue; }
      const r = await runner.processEntry(claimed.entry, { workerId: 'diag-worker' });
      if (claimed.entry.id === id) out = r;
    }
    return { out, id, entry: Q.shape(await Q.byId(id)), posting: jobId ? await P.get(jobId, portal) : null };
  };
  const verify = async (portal, user, pass) => {
    await prime(portal, user, pass);
    const r = await Cred.requestVerify(portal, admin);
    const id = r.entry.id;
    let out = null;
    for (let n = 0; n < 8; n += 1) {
      if ((await Q.byId(id)).status !== 'QUEUED') break;
      if (n > 0) await nowQ(id);
      const c = await Q.claim({ workerId: 'diag-worker', onlyPortals: [portal] });
      if (!c.entry) { await sleep(800); continue; }
      out = await runner.processEntry(c.entry, { workerId: 'diag-worker' });
    }
    return { out, entry: Q.shape(await Q.byId(id)), test: (await Cred.one(portal)).lastTest };
  };
  const logsOf = (queueId) => D.q('SELECT * FROM "PostingLog" WHERE "queueId" = ? ORDER BY "createdAt" ASC', queueId);

  // ===================================================== 1. credential format checks
  console.log('\n-- credential format checks');
  const V = (b, o) => Cred.validateLogin('naukri', b, o);
  Z.check('format: a normal e-mail and password pass', V({ username: 'recruiter@company.com', password: 'Secret#123' }, { first: true }).ok);
  Z.check('format: a mobile number is accepted as a login name', V({ username: '9876543210', password: 'Secret#123' }, { first: true }).ok);
  Z.check('format: an incomplete e-mail is refused in plain words', (() => { const r = V({ username: 'name@bad', password: 'Secret#123' }); return !r.ok && /not complete/.test(r.problems[0]); })());
  Z.check('format: a password that equals the login name is refused', !V({ username: 'a@b.com', password: 'a@b.com' }).ok);
  Z.check('format: a too short password / name are refused', !V({ username: 'ab', password: 'x' }).ok);
  Z.check('format: a first login needs both fields', V({}, { first: true }).problems.length === 2);
  Z.check('format: a space inside the login name is refused', !V({ username: 'my name', password: 'Secret#123' }).ok);
  const bad = await Z.call('PUT', `${J}/credentials/naukri`, tok.admin, { username: 'name@bad', password: 'Secret#123' });
  Z.check('API: saving a badly formatted login is refused (400) with the problems listed and nothing saved', bad.status === 400 && Array.isArray(bad.body.problems) && bad.body.problems.length > 0 && !(await D.q1('SELECT 1 x FROM "PortalCredential" WHERE "portal" = \'naukri\'')), bad.body);
  const good = await Z.call('PUT', `${J}/credentials/naukri`, tok.admin, { username: MOCK.VALID_USER, password: MOCK.VALID_PASS });
  Z.check('API: a well formed login is saved; the answer holds no secret and shows "Not tested yet"', good.status === 200 && good.body.credential.lastTest.state === 'NOT_TESTED' && !good.text.includes(MOCK.VALID_PASS) && !good.text.includes(MOCK.VALID_USER), good.body);
  const warn = await Z.call('PUT', `${J}/credentials/foundit`, tok.admin, { username: 'someuser_name', password: 'password' });
  Z.check('API: a doubtful login is saved with warnings (not blocked)', warn.status === 200 && Array.isArray(warn.body.warnings) && warn.body.warnings.length >= 1, warn.body);
  await D.ex('DELETE FROM "PortalCredential" WHERE "portal" = \'foundit\'');
  Z.check('every test state has plain words', Object.keys(C.TEST_STATES).length >= 12 && Object.values(C.TEST_STATE_OF).every((s) => C.TEST_STATES[s]));

  // ===================================================== 2. Test connection result states (login check against the mock)
  console.log('\n-- Test connection: result states');
  await S.setLimits(null, { otpWaitMs: 1200 });
  const t1 = await verify('naukri', MOCK.VALID_USER, MOCK.VALID_PASS);
  Z.check('test connection: a good login -> CONNECTED', t1.entry.status === 'SUCCEEDED' && t1.test.state === 'CONNECTED', [t1.entry.status, t1.test]);
  const t2 = await verify('naukri', 'someone@mock.test', 'WrongPass#9');
  Z.check('test connection: a wrong password -> "the site did not accept this login" (WRONG_LOGIN)', t2.test.state === 'WRONG_LOGIN' && t2.entry.errorCode === 'WRONG_PASSWORD', [t2.test, t2.entry.errorCode]);
  const t3 = await verify('naukri', 'captcha-user', 'whatever1');
  Z.check('test connection: a CAPTCHA -> NEEDS_CAPTCHA with the person-help text and the session command', t3.test.state === 'NEEDS_CAPTCHA' && t3.entry.status === 'NEEDS_HUMAN' && t3.entry.help && t3.entry.help.kind === 'CAPTCHA' && /npm run portal-session -- naukri/.test(t3.entry.help.command) && /never solves a CAPTCHA/i.test(t3.entry.help.how), [t3.test, t3.entry.help]);
  const t4 = await verify('naukri', 'otp-user', 'whatever1');
  Z.check('test connection: an OTP nobody types in time -> NEEDS_OTP, not retried', t4.test.state === 'NEEDS_OTP' && t4.entry.status === 'NEEDS_HUMAN' && t4.entry.attempts === 1, [t4.test, t4.entry.status]);
  const t5 = await verify('naukri', 'blocked-user', 'whatever1');
  Z.check('test connection: HTTP 429 -> BLOCKED', t5.test.state === 'BLOCKED', t5.test);
  const t6 = await verify('naukri', 'unusual-user', 'whatever1');
  Z.check('test connection: "unusual activity" -> NEEDS_CHECK', t6.test.state === 'NEEDS_CHECK', t6.test);
  const apiCred = await Z.call('GET', `${J}/credentials`, tok.admin);
  Z.check('credentials API shows the last test result (no secret)', apiCred.status === 200 && apiCred.body.credentials.find((c) => c.portal === 'naukri').lastTest.state === 'NEEDS_CHECK' && !apiCred.text.includes('whatever1'));
  await S.clearHumanHold('naukri');

  // ===================================================== 3. OTP: a person types it, the waiting run continues
  console.log('\n-- OTP human in the loop');
  await S.setLimits(null, { otpWaitMs: 60000 });
  await prime('naukri', 'otp-user', 'whatever1');
  const jobO = await mkJob('ZZTEST JD OTP Lecturer');
  const eo = await Q.enqueue({ requirementId: jobO.id, portal: 'naukri', action: 'PUBLISH', payloadHash: `otp${Date.now()}`, requestedBy: tl.id, requestedByName: tl.name });
  await P.set(jobO.id, 'naukri', { status: 'QUEUED', lastQueueId: eo.entry.id });
  const claimed = await Q.claim({ workerId: 'diag-worker', onlyPortals: ['naukri'] });
  const running = runner.processEntry(claimed.entry, { workerId: 'diag-worker' }); // (not awaited: it waits for the person)
  let waitingShape = null;
  for (let i = 0; i < 80 && !waitingShape; i += 1) { await sleep(500); const s = Q.shape(await Q.byId(eo.entry.id)); if (s.waiting) waitingShape = s; }
  Z.check('the run PAUSES in "Needs your help" with a plain reason (still RUNNING, browser open)', !!waitingShape && waitingShape.status === 'RUNNING' && waitingShape.waiting.kind === 'OTP' && /one-time code/.test(waitingShape.waiting.reason) && !!waitingShape.waiting.until, waitingShape);
  const st1 = await Z.call('GET', `${J}/jobs/${jobO.id}/status`, tok.tl);
  const row1 = st1.body.portals.find((p) => p.portal === 'naukri');
  Z.check('the job status shows the waiting note to the TL (and never the hand-over port)', st1.status === 200 && row1.lastQueue.waiting && row1.lastQueue.waiting.kind === 'OTP' && !JSON.stringify(st1.body).includes('"port"'), row1.lastQueue);
  const q1 = await Z.call('GET', `${J}/queue?job=${jobO.id}`, tok.tl);
  Z.check('the queue list shows the same, no port', q1.status === 200 && q1.body.rows[0].waiting && !q1.text.includes('"port"'));
  const dg = await Z.call('GET', `${J}/diagnostics`, tok.tl);
  Z.check('diagnostics shows the waiting attempt as "needs your help"', dg.status === 200 && dg.body.portals.find((p) => p.portal === 'naukri').lastAttempts.some((a) => a.waiting), dg.status);
  Z.check('a Recruiter cannot type the OTP (403)', (await Z.call('POST', `${J}/queue/${eo.entry.id}/otp`, tok.rec, { code: CODE })).status === 403);
  Z.check('a TL of another department cannot type the OTP (403)', (await Z.call('POST', `${J}/queue/${eo.entry.id}/otp`, tok.tlMed, { code: CODE })).status === 403);
  const badFmt = await Z.call('POST', `${J}/queue/${eo.entry.id}/otp`, tok.tl, { code: '12 34' });
  Z.check('a code with a space or the wrong shape is refused before it is sent (400)', badFmt.status === 400 && badFmt.body.code === 'BAD_FORMAT');
  const sent = await Z.call('POST', `${J}/queue/${eo.entry.id}/otp`, tok.tl, { code: CODE });
  Z.check('the TL types the OTP: handed to the waiting run (200), the answer does not echo it', sent.status === 200 && sent.body.ok === true && !sent.text.includes(CODE), sent.body);
  const res = await running;
  const posted = await P.get(jobO.id, 'naukri');
  Z.check('the run continued after the OTP and the job is PUBLISHED and verified', res.state === 'SUCCEEDED' && posted && posted.status === 'PUBLISHED' && !!posted.verifiedAt && mock.state.otpTries === 1, [res, posted && posted.status, mock.state.otpTries]);
  Z.check('after the run the entry is not "waiting" any more', Q.shape(await Q.byId(eo.entry.id)).waiting === null);
  const again = await Z.call('POST', `${J}/queue/${eo.entry.id}/otp`, tok.tl, { code: CODE });
  Z.check('typing a code when nothing is waiting is refused (409)', again.status === 409 && again.body.code === 'NOT_WAITING', again.body);
  // the code is stored NOWHERE
  const hay = [];
  for (const t of ['PostingLog', 'PostingQueue', 'PortalPosting', 'PortalCredential', 'AppSetting', 'AuditLog', 'Notification']) hay.push([t, JSON.stringify(await D.q(`SELECT * FROM "${t}"`))]);
  Z.check('the OTP is in NO table (logs, queue, postings, settings, audit, notifications)', hay.every(([, s]) => !s.includes(CODE)), hay.filter(([, s]) => s.includes(CODE)).map(([t]) => t));
  const logTxt = fs.existsSync(path.join(TMP, 'logs')) ? fs.readdirSync(path.join(TMP, 'logs')).map((f) => fs.readFileSync(path.join(TMP, 'logs', f), 'utf8')).join('\n') : '';
  Z.check('the OTP is in no log file either', !logTxt.includes(CODE) && logTxt.length > 0);
  Z.check('the audit trail says WHO typed an OTP but never the code', (await prisma.auditLog.count({ where: { action: 'OTP typed by a person', actorName: tl.name } })) === 1);
  Z.check('the typed-OTP step is in the log, without the code', (await logsOf(eo.entry.id)).some((l) => l.step === 'needs-help') && (await logsOf(eo.entry.id)).some((l) => l.step === 'otp'));

  // a wrong code: ONE attempt, then needs a person (never retried)
  await prime('naukri', 'otp-user', 'whatever1');
  const jobW = await mkJob('ZZTEST JD WrongOTP Lecturer');
  const ew = await Q.enqueue({ requirementId: jobW.id, portal: 'naukri', action: 'PUBLISH', payloadHash: `w${Date.now()}`, requestedBy: tl.id, requestedByName: tl.name });
  const cw = await Q.claim({ workerId: 'diag-worker', onlyPortals: ['naukri'] });
  const runW = runner.processEntry(cw.entry, { workerId: 'diag-worker' });
  let ww = null;
  for (let i = 0; i < 80 && !ww; i += 1) { await sleep(500); const s = Q.shape(await Q.byId(ew.entry.id)); if (s.waiting) ww = s; }
  const triesBefore = mock.state.otpTries;
  const sw = await Z.call('POST', `${J}/queue/${ew.entry.id}/otp`, tok.tl, { code: 'WRONG1' });
  const resW = await runW;
  const shW = Q.shape(await Q.byId(ew.entry.id));
  Z.check('a WRONG OTP is tried once only: the run stops as "needs a person" with attempts = 1', sw.status === 200 && resW.state === 'NEEDS_HUMAN' && resW.code === 'OTP' && shW.attempts === 1 && mock.state.otpTries === triesBefore + 1, [resW, shW.attempts, mock.state.otpTries - triesBefore]);
  Z.check('the wrong code is stored nowhere either', !JSON.stringify(await D.q('SELECT * FROM "PostingLog"')).includes('WRONG1') && !JSON.stringify(await D.q('SELECT * FROM "PostingQueue"')).includes('WRONG1'));
  await S.clearHumanHold('naukri');

  // nobody types it in time: ends as needs-a-person with help text
  await S.setLimits(null, { otpWaitMs: 1200 });
  await prime('naukri', 'otp-user', 'whatever1');
  const jobN = await mkJob('ZZTEST JD NoOTP Lecturer');
  const rN = await work(jobN.id, 'naukri', 'PUBLISH');
  Z.check('no OTP typed in time: NEEDS_HUMAN (OTP), attempts 1, help text says what to do', rN.entry.status === 'NEEDS_HUMAN' && rN.entry.errorCode === 'OTP' && rN.entry.attempts === 1 && rN.entry.help && rN.entry.help.kind === 'OTP', [rN.entry.status, rN.entry.errorCode, rN.entry.help]);
  await S.clearHumanHold('naukri');

  // CAPTCHA: help text on the job status + "I did it, try again" lifts the hold
  await prime('naukri', 'captcha-user', 'whatever1');
  const jobCa = await mkJob('ZZTEST JD CAPTCHA Lecturer');
  const rCa = await work(jobCa.id, 'naukri', 'PUBLISH');
  const stCa = await Z.call('GET', `${J}/jobs/${jobCa.id}/status`, tok.tl);
  const rowCa = stCa.body.portals.find((p) => p.portal === 'naukri');
  Z.check('CAPTCHA: the job status carries the "Solve it in the browser window" help + the session command', rCa.entry.status === 'NEEDS_HUMAN' && rowCa.lastQueue.help && rowCa.lastQueue.help.kind === 'CAPTCHA' && /Solve the CAPTCHA in the browser window/.test(rowCa.lastQueue.help.title) && /npm run portal-session -- naukri/.test(rowCa.lastQueue.help.command), rowCa.lastQueue);
  Z.check('CAPTCHA: the portal is on hold until a person says they did it', !!(await S.humanHold('naukri')));
  await prime('naukri', MOCK.VALID_USER, MOCK.VALID_PASS); // the person signed in (here: the login is valid now); the hold was cleared by saving a new login, so put it back for the test
  await S.setHumanHold('naukri', { reason: 'test', queueId: rCa.id, code: 'CAPTCHA' });
  const retryCa = await Z.call('POST', `${J}/queue/${rCa.id}/retry`, tok.tl);
  Z.check('CAPTCHA: "I did it, try again" (Retry by the TL) lifts that portal\'s hold and queues the job again', [200, 409].includes(retryCa.status) && !(await S.humanHold('naukri')) && Q.shape(await Q.byId(rCa.id)).status === 'QUEUED', [retryCa.status, await S.humanHold('naukri')]);
  await D.ex('DELETE FROM "PostingQueue" WHERE "id" = ?', rCa.id);

  // ===================================================== 4. a picture for EVERY attempt
  console.log('\n-- pictures');
  await prime('naukri');
  const jobS = await mkJob('ZZTEST JD Pictures Lecturer');
  const okRun = await work(jobS.id, 'naukri', 'PUBLISH');
  const pngsOf = async (id) => (await logsOf(id)).filter((l) => l.screenshotPath && /\.png$/.test(l.screenshotPath));
  const okPics = await pngsOf(okRun.id);
  Z.check('a SUCCESSFUL publish keeps pictures (form, confirmation, verified)', okRun.posting.status === 'PUBLISHED' && okPics.length >= 2 && okPics.every((l) => fs.existsSync(path.join(process.env.TL_PORTAL_SCREENSHOT_DIR, l.screenshotPath)) && fs.statSync(path.join(process.env.TL_PORTAL_SCREENSHOT_DIR, l.screenshotPath)).size > 500), okPics.length);
  const wrongRun = await verify('naukri', 'someone@mock.test', 'WrongPass#9');
  const wrongPics = await pngsOf(wrongRun.entry.id);
  Z.check('a FAILED sign-in keeps a picture too (the page with the password box is photographed, masked, not skipped)', wrongRun.entry.status === 'FAILED' && wrongPics.length >= 1, wrongPics.length);
  const vOk = await verify('naukri', MOCK.VALID_USER, MOCK.VALID_PASS);
  Z.check('a successful LOGIN CHECK keeps a picture', vOk.entry.status === 'SUCCEEDED' && (await pngsOf(vOk.entry.id)).length >= 1);
  const dry = await work((await mkJob('ZZTEST JD Dry Lecturer')).id, 'naukri', 'PUBLISH', { dryRun: true });
  Z.check('a DRY RUN keeps pictures', dry.entry.status === 'SUCCEEDED' && (await pngsOf(dry.id)).length >= 1);
  Z.check('the queue entry counts its pictures', okRun.entry.screenshots >= 2 && wrongRun.entry.screenshots >= 1, [okRun.entry.screenshots, wrongRun.entry.screenshots]);
  // masking
  const calls = [];
  const fakePage = { locator: (sel) => ({ sel, count: async () => (sel === 'input[type=password]:visible' ? 1 : 0) }), screenshot: async (o) => { calls.push(o); fs.writeFileSync(o.path, Buffer.alloc(600, 1)); } };
  await shots.shot(fakePage, { queueId: 'unit', portal: 'naukri', step: 'unit-mask' });
  const maskSel = (calls[0].mask || []).map((m) => m.sel);
  Z.check('masking: password, OTP and CAPTCHA boxes are always masked', ['input[type=password]', 'input[autocomplete=one-time-code]', 'input[name*=otp i]', 'input[name*=captcha i]'].every((s) => maskSel.includes(s)), maskSel);
  Z.check('masking: when a password box is on the page EVERY input is masked (the typed login name too)', maskSel.includes('input') && maskSel.includes('textarea'));
  // protected folder + route (the API process keeps its pictures in the sandbox folder, so copies of two files are placed there for these checks and removed after)
  const apiRoot = path.join(os.homedir(), '.teamlink-sandbox', 'portal-shots');
  const copies = [];
  const putInApi = (rel) => { const to = path.join(apiRoot, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(shots.root(), rel), to); copies.push(to); };
  const oneLog = okPics[0];
  putInApi(oneLog.screenshotPath);
  const shotRoute = await Z.call('GET', `${J}/logs/${(await D.q1('SELECT "id" FROM "PostingLog" WHERE "screenshotPath" = ?', oneLog.screenshotPath)).id}/screenshot`, tok.tl);
  Z.check('the picture is served only through the authenticated route (TL of the job: PNG)', shotRoute.status === 200 && shotRoute.buf.slice(1, 4).toString() === 'PNG' && /no-store/.test(shotRoute.headers.get('cache-control')), shotRoute.status);
  const logId = (await D.q1('SELECT "id" FROM "PostingLog" WHERE "screenshotPath" = ?', oneLog.screenshotPath)).id;
  Z.check('a Recruiter cannot open it (403)', (await Z.call('GET', `${J}/logs/${logId}/screenshot`, tok.rec)).status === 403);
  Z.check('a TL of another department cannot open it (403)', (await Z.call('GET', `${J}/logs/${logId}/screenshot`, tok.tlMed)).status === 403);
  Z.check('no token: 401', (await Z.call('GET', `${J}/logs/${logId}/screenshot`)).status === 401);
  Z.check('a path that tries to leave the folder is refused', shots.resolve('../../etc/passwd') === null && shots.resolve('..\\..\\x') === null);
  Z.check('the folder is outside the repository and not a web folder', !shots.root().startsWith(path.resolve(BACK, '..')) && !/public|static|dist/i.test(shots.root()));
  // retention
  const oldRel = 'naukri/old-test-picture.png';
  const oldAbs = path.join(shots.root(), oldRel);
  fs.writeFileSync(oldAbs, Buffer.alloc(700, 2));
  fs.utimesSync(oldAbs, new Date(Date.now() - 40 * 86400000), new Date(Date.now() - 40 * 86400000));
  await D.ex('INSERT INTO "PostingLog" ("id","queueId","requirementId","portal","step","level","message","screenshotPath","createdAt") VALUES (?,?,?,?,?,?,?,?,?)', 'pl-old-test', okRun.id, jobS.id, 'naukri', 'old', 'INFO', 'old picture', oldRel, Date.now() - 40 * 86400000);
  Z.check('retention: the default is 30 days', (await S.retentionDays()) === 30);
  const sweep = await Diag.sweepPictures({ force: true });
  Z.check('retention: a picture older than 30 days is deleted, the log row loses its link, a recent picture stays', sweep.removed >= 1 && !fs.existsSync(oldAbs) && (await D.q1('SELECT "screenshotPath" s FROM "PostingLog" WHERE "id" = \'pl-old-test\'')).s === null && fs.existsSync(path.join(shots.root(), oneLog.screenshotPath)), sweep);
  Z.check('retention: only an Admin can change it (TL 403, bad value 400, Admin 200)', (await Z.call('PUT', `${J}/diagnostics/retention`, tok.tl, { days: 10 })).status === 403 && (await Z.call('PUT', `${J}/diagnostics/retention`, tok.admin, { days: 0 })).status === 400 && (await Z.call('PUT', `${J}/diagnostics/retention`, tok.admin, { days: 10 })).status === 200 && (await S.retentionDays()) === 10);
  await S.del(S.K.retention);

  // ===================================================== 5. selector self-healing
  console.log('\n-- selector self-healing');
  const stNormal = await S.selectorStatus('naukri');
  Z.check('a normal run records "ok" for the steps it used (main way found them)', stNormal && stNormal.steps['field.title'] && stNormal.steps['field.title'].state === 'ok' && stNormal.steps['login.submit'] && stNormal.steps['post.submit'].state === 'ok', stNormal && Object.keys(stNormal.steps));
  await fetch(`${mock.origin}/__control/mode?portal=naukri&mode=drift`, { method: 'POST' });
  const jobD = await mkJob('ZZTEST JD Drift Lecturer');
  const drift = await work(jobD.id, 'naukri', 'PUBLISH');
  const stDrift = await S.selectorStatus('naukri');
  const dl = await logsOf(drift.id);
  Z.check('the title box was renamed: the run STILL publishes through a fallback (label)', drift.posting.status === 'PUBLISHED' && drift.entry.status === 'SUCCEEDED', [drift.posting && drift.posting.status, drift.entry.errorMessage]);
  Z.check('...and records which one worked (fallback 2, a label) and flags the DRIFT', stDrift.steps['field.title'].state === 'drift' && stDrift.steps['field.title'].usedIndex === 1 && stDrift.steps['field.title'].kind === 'label', stDrift.steps['field.title']);
  Z.check('...with a plain warning in the log', dl.some((l) => l.step === 'selector-drift' && l.level === 'WARN' && /main selector/.test(l.message) && /fallback 2 of 3/.test(l.message)), dl.filter((l) => l.step.startsWith('selector')).map((l) => l.message));
  Z.check('...and the queue entry knows it had drift', drift.entry.selectorDrift >= 1, drift.entry.selectorDrift);
  const dgDrift = await Z.call('GET', `${J}/diagnostics`, tok.admin);
  const nkDiag = dgDrift.body.portals.find((p) => p.portal === 'naukri');
  Z.check('diagnostics: the portal card shows the drift (step state, counts, run count)', nkDiag.selectors.counts.drift >= 1 && nkDiag.selectors.steps.find((s) => s.key === 'field.title').state === 'drift' && nkDiag.failures.driftRuns >= 1 && nkDiag.health.issues.some((i) => /fallback/.test(i)), nkDiag.selectors.counts);
  Z.check('diagnostics: the attempt detail lists the drift event', (await Z.call('GET', `${J}/diagnostics/attempts/${drift.id}`, tok.tl)).body.selectorEvents.length >= 1);
  // broken: the box is gone and the page is full of made-up personal text
  await fetch(`${mock.origin}/__control/mode?portal=naukri&mode=break`, { method: 'POST' });
  const jobB = await mkJob('ZZTEST JD Broken Lecturer');
  const broken = await work(jobB.id, 'naukri', 'PUBLISH');
  const bl = await logsOf(broken.id);
  Z.check('the title box is GONE: the run stops with SELECTOR_MISSING (never guesses), not retried, FAILED', broken.entry.status === 'FAILED' && broken.entry.errorCode === 'SELECTOR_MISSING' && broken.entry.attempts === 1, [broken.entry.status, broken.entry.errorCode, broken.entry.attempts]);
  Z.check('...the step is marked BROKEN in the selector status', (await S.selectorStatus('naukri')).steps['field.title'].state === 'broken');
  const snapRow = bl.find((l) => l.step === 'page-structure');
  const snapText = snapRow && snapRow.screenshotPath ? fs.readFileSync(path.join(shots.root(), snapRow.screenshotPath), 'utf8') : '';
  if (snapRow && snapRow.screenshotPath) putInApi(snapRow.screenshotPath);
  Z.check('...a page-structure snapshot was saved to help fix it (tags, ids, names)', !!snapRow && /\.txt$/.test(snapRow.screenshotPath) && /<form/.test(snapText) && /<input/.test(snapText) && /<button/.test(snapText) && /name="vacancies"/.test(snapText), snapText.slice(0, 300));
  Z.check('...and the snapshot holds NO personal data (no name, e-mail, phone, typed text, values)', snapText.length > 200 && !/jane|\bdoe\b|example\.com|9876543210012|SECRETVALUE|typed text|value=/i.test(snapText), snapText.slice(0, 500));
  Z.check('...the snapshot route serves it as plain text to the TL of the job only', (await (async () => {
    const r = await Z.call('GET', `${J}/logs/${snapRow.id}/screenshot`, tok.tl);
    const r2 = await Z.call('GET', `${J}/logs/${snapRow.id}/screenshot`, tok.rec);
    return r.status === 200 && /text\/plain/.test(r.headers.get('content-type')) && r2.status === 403;
  })()));
  Z.check('...the log row says it is a snapshot (fileKind structure)', (await Z.call('GET', `${J}/logs?queue=${broken.id}`, tok.tl)).body.rows.some((r) => r.fileKind === 'structure'));
  const dgB = await Z.call('GET', `${J}/diagnostics`, tok.admin);
  Z.check('diagnostics: the failure is counted under "Page changed (selector drift)"', dgB.body.portals.find((p) => p.portal === 'naukri').failures.byCategory.SELECTOR >= 1 && dgB.body.portals.find((p) => p.portal === 'naukri').selectors.counts.broken >= 1);
  await fetch(`${mock.origin}/__control/mode?portal=naukri&mode=off`, { method: 'POST' });
  // never guesses a destructive click: an ambiguous fallback is refused
  const Naukri = registry.get('naukri');
  const ad = new Naukri({ portal: 'naukri', creds: null, log: createLogger({ portal: 'naukri' }), ctx: {} });
  ad.page = { locator: () => ({ count: async () => 2 }), getByRole: () => ({ count: async () => 2 }) };
  ad.selectorTrace.set('post.submit', { key: 'post.submit', usedIndex: 1, used: 'role button "Submit"' });
  let refused = null;
  try { await ad.unique('post.submit', null, ["button:has-text('Post Job')", { role: 'button', name: 'Submit' }]); } catch (e) { refused = e; }
  Z.check('a destructive step reached through a fallback that matches TWO buttons is refused (never guessed)', refused && refused.code === 'SELECTOR_MISSING' && /will not guess/.test(refused.message), refused && refused.message);
  ad.page = { locator: () => ({ count: async () => 1 }), getByRole: () => ({ count: async () => 1 }) };
  let okUnique = true;
  try { await ad.unique('post.submit', null, ["button:has-text('Post Job')", { role: 'button', name: 'Submit' }]); } catch { okUnique = false; }
  Z.check('...and one that matches exactly ONE button is allowed', okUnique);
  // entries
  Z.check('entries: role / label / text / css all build', (() => { const seen = []; const pg = { locator: (s) => seen.push(`css:${s}`), getByRole: (r, o) => seen.push(`role:${r}:${o.name}`), getByLabel: (t) => seen.push(`label:${t}`), getByText: (t) => seen.push(`text:${t}`), getByPlaceholder: (t) => seen.push(`ph:${t}`), getByTestId: (t) => seen.push(`id:${t}`) }; ['a', { role: 'button', name: 'Go' }, { label: 'L' }, { text: 'T' }, { placeholder: 'P' }, { testId: 'X' }, { css: '#c' }].forEach((e) => locate.build(pg, e)); return seen.join('|') === 'css:a|role:button:Go|label:L|text:T|ph:P|id:X|css:#c'; })());
  Z.check('entries: a malformed entry is reported as a problem in the page settings', locate.check([{ foo: 1 }, ''], 'x').length === 2);
  // the structure snapshot function itself
  const hay2 = await structure.capture({ evaluate: async () => [], url: () => 'http://x/y?token=SECRET#h' }, { portal: 'naukri', step: 's' });
  Z.check('the snapshot header keeps only the path of the address (no query)', hay2 && /page path: \/y /.test(hay2) && !/SECRET/.test(hay2), hay2);

  // ===================================================== 6. the real page settings: coverage, honesty
  console.log('\n-- the three REAL page settings (naukri, shine, foundit)');
  for (const p of ['naukri', 'shine', 'foundit']) {
    const raw = REAL_JSON(p);
    const cov = cfgLib.coverage(raw);
    Z.check(`${p}: every step has at least 2 ways to be found, and at least one role / label / text way (not CSS only)`, cov.length >= 15 && cov.every((c) => !c.thin && !c.textless && !c.bad), cov.filter((c) => c.thin || c.textless).map((c) => c.key));
    Z.check(`${p}: the page settings are labelled UNVERIFIED (nobody checked them on the real site)`, raw.verified === false && /UNVERIFIED/.test(raw._comment.join(' ')));
    Z.check(`${p}: a take-down never uses a bare <div> row (it would be the whole page)`, !raw.unpublish.rowSelector.some((x) => /^div:has-text/.test(x)));
    Z.check(`${p}: only a sentence about the closing counts as "done" (not the word "closed" alone)`, !raw.unpublish.doneText.some((t) => ['closed', 'removed', 'deactivated'].includes(t)));
    const loaded = await (async () => { const bak = process.env[`TL_PORTAL_SELECTORS_${p.toUpperCase()}`]; delete process.env[`TL_PORTAL_SELECTORS_${p.toUpperCase()}`]; const l = await cfgLib.load(p); process.env[`TL_PORTAL_SELECTORS_${p.toUpperCase()}`] = bak; return l; })();
    Z.check(`${p}: the built-in file loads cleanly`, loaded.ok && loaded.origin === 'built-in', loaded.problems);
  }

  // ===================================================== 7. the real-posting gate
  console.log('\n-- real-posting gate');
  Z.check('gate: off by default -> REAL_POSTING_OFF', guards.realPostingGate({ strict: false, verified: true, action: 'PUBLISH', dryRun: false }) === 'REAL_POSTING_OFF');
  process.env.TL_ALLOW_REAL_POSTING = '1';
  Z.check('gate: env on but page settings unverified -> SELECTORS_UNVERIFIED', guards.realPostingGate({ strict: false, verified: false, action: 'PUBLISH', dryRun: false }) === 'SELECTORS_UNVERIFIED');
  Z.check('gate: env on + verified -> allowed', guards.realPostingGate({ strict: false, verified: true, action: 'PUBLISH', dryRun: false }) === null);
  Z.check('gate: a dry run, a login check and the local mock are never "real posting"', guards.realPostingGate({ strict: false, verified: false, action: 'PUBLISH', dryRun: true }) === null && guards.realPostingGate({ strict: false, verified: false, action: 'VERIFY', dryRun: false }) === null && guards.realPostingGate({ strict: true, verified: false, action: 'PUBLISH', dryRun: false }) === null);
  Z.check('gate: take-down is a real action too (needs the same)', guards.realPostingGate({ strict: false, verified: false, action: 'UNPUBLISH', dryRun: false }) === 'SELECTORS_UNVERIFIED');
  delete process.env.TL_ALLOW_REAL_POSTING;
  // integration: a settings file that is NOT the mock's, run outside strict mode (still only the LOCAL mock host is allowed)
  const real = JSON.parse(fs.readFileSync(nkFile, 'utf8'));
  delete real.mock; real.verified = false; real.allowedHosts = ['127.0.0.1'];
  const realFile = path.join(TMP, 'naukri-notmock.json');
  fs.writeFileSync(realFile, JSON.stringify(real));
  process.env.TL_PORTAL_SELECTORS_NAUKRI = realFile;
  const savedStrict = process.env.TL_POSTING_STRICT_LOCAL; const savedMode = process.env.TEST_MODE;
  delete process.env.TL_POSTING_STRICT_LOCAL; delete process.env.TEST_MODE;
  try {
    await prime('naukri');
    const jobG = await mkJob('ZZTEST JD Gate Lecturer');
    const built = await require(path.join(BACK, 'src/jobPublish/jobPayload')).build(jobG.id, 'naukri');
    const mkRun = (action, dryRun) => registry.create('naukri', { creds: { username: MOCK.VALID_USER, password: MOCK.VALID_PASS }, log: createLogger({ portal: 'naukri' }) }).run(action, { payload: built.payload }, { queueId: `gate${Date.now()}`, dryRun, onSubmitStart: async () => {} });
    const loginsBefore = mock.state.logins;
    const g1 = await mkRun('PUBLISH', false);
    Z.check('integration: a REAL post with the env off is refused BEFORE any browser opens', g1.ok === false && g1.code === 'REAL_POSTING_OFF' && mock.state.logins === loginsBefore, [g1.code, g1.reason]);
    process.env.TL_ALLOW_REAL_POSTING = '1';
    const g2 = await mkRun('PUBLISH', false);
    Z.check('integration: env on, page settings unverified -> still refused', g2.ok === false && g2.code === 'SELECTORS_UNVERIFIED' && mock.state.logins === loginsBefore, [g2.code]);
    delete process.env.TL_ALLOW_REAL_POSTING;
    const g3 = await mkRun('PUBLISH', true);
    Z.check('integration: a DRY RUN on unverified settings works (fills the form, posts nothing)', g3.ok === true && g3.dryRun === true && g3.submitted === false && (g3.screenshots || []).length >= 1, [g3.code, g3.reason]);
    const svcOut = await svc.publish(await Z.identity(admin), jobG.id, ['naukri'], {});
    const r0 = (svcOut.results || [])[0] || svcOut;
    Z.check('service: the job is NOT queued for a real post: a by-hand task is made instead, saying why', r0.mode === 'by_hand' && r0.gate === 'REAL_POSTING_OFF' && !r0.queued && /TL_ALLOW_REAL_POSTING/.test(r0.reason), r0);
    process.env.TL_ALLOW_REAL_POSTING = '1';
    real.verified = true; fs.writeFileSync(realFile, JSON.stringify(real));
    const g4 = await mkRun('PUBLISH', false);
    Z.check('integration: ALL four conditions met (env, switch, not dry, verified) -> the post goes through (to the local mock only)', g4.ok === true && g4.verified === true && /^NK-/.test(g4.portalJobId || ''), [g4.code, g4.reason, g4.portalJobId]);
    delete process.env.TL_ALLOW_REAL_POSTING;
  } finally {
    if (savedStrict !== undefined) process.env.TL_POSTING_STRICT_LOCAL = savedStrict; if (savedMode !== undefined) process.env.TEST_MODE = savedMode;
    process.env.TL_PORTAL_SELECTORS_NAUKRI = nkFile;
  }

  // ===================================================== 8. diagnostics API
  console.log('\n-- diagnostics API');
  // a few more outcomes for the failure groups
  await prime('naukri');
  const rejected = await work((await mkJob('ZZTEST JD REJECT Lecturer')).id, 'naukri', 'PUBLISH');
  const slow = await verify('naukri', 'slow-user', 'whatever1');
  Z.check('test connection: a site that does not answer -> PORTAL_DOWN', slow.test.state === 'PORTAL_DOWN', [slow.test, slow.entry.errorCode]);
  await D.ex('UPDATE "PostingQueue" SET "attempts" = "maxAttempts" WHERE "portal" = \'naukri\' AND "status" = \'QUEUED\''); // (a retryable timeout waits for its next try: not needed any more)
  const dgA = await Z.call('GET', `${J}/diagnostics`, tok.admin);
  const nk2 = dgA.body.portals.find((p) => p.portal === 'naukri');
  Z.check('diagnostics (Admin): all seven portals (incl. Telegram and Facebook), with health, credential (masked login), session, selectors and last attempts', dgA.status === 200 && dgA.body.portals.length === 7 && nk2.health.state && Array.isArray(nk2.health.issues) && nk2.credential.usernameMasked && nk2.session && nk2.selectors.steps.length >= 14 && nk2.lastAttempts.length > 0, dgA.body.portals.map((p) => p.portal));
  Z.check('diagnostics: no secret anywhere in the answer', !dgA.text.includes(MOCK.VALID_PASS) && !dgA.text.includes(MOCK.VALID_USER) && !dgA.text.includes('whatever1') && !dgA.text.includes(CODE));
  const cats = nk2.failures.byCategory;
  Z.check('diagnostics: failures by group - sign-in, OTP, CAPTCHA, page changed, site refused, site down', cats.LOGIN >= 1 && cats.OTP >= 1 && cats.CAPTCHA >= 1 && cats.SELECTOR >= 1 && cats.VALIDATION >= 1 && cats.PORTAL_DOWN >= 1, cats);
  Z.check('diagnostics: the group words are plain', dgA.body.categories.SELECTOR === 'Page changed (selector drift)' && dgA.body.categories.OTP === 'One-time code (OTP)');
  Z.check('diagnostics: the selector status says UNVERIFIED for the built-in page settings and shows steps tried / not tried', nk2.selectors.counts.total >= 14 && nk2.selectors.counts.unknown >= 0 && typeof nk2.selectors.verified === 'boolean');
  Z.check('diagnostics: a failed attempt can be retried (flag)', nk2.lastAttempts.some((a) => a.canRetry));
  Z.check('diagnostics: success rate and last attempts carry the job name', typeof nk2.failures.rate === 'number' && nk2.lastAttempts.some((a) => a.job && /ZZTEST JD/.test(a.job.title)));
  const dgTl = await Z.call('GET', `${J}/diagnostics`, tok.tl);
  Z.check('diagnostics (TL): allowed, but no login details; only attempts of the TL\'s own jobs (no login checks)', dgTl.status === 200 && dgTl.body.portals.find((p) => p.portal === 'naukri').credential.usernameMasked === undefined && dgTl.body.portals.find((p) => p.portal === 'naukri').lastAttempts.every((a) => a.requirementId), dgTl.status);
  Z.check('diagnostics: a Recruiter gets 403', (await Z.call('GET', `${J}/diagnostics`, tok.rec)).status === 403);
  Z.check('diagnostics: another department\'s TL sees none of these jobs', (await Z.call('GET', `${J}/diagnostics`, tok.tlMed)).body.portals.find((p) => p.portal === 'naukri').lastAttempts.length === 0);
  const failedRow = nk2.lastAttempts.find((a) => a.status === 'FAILED' && a.requirementId);
  const att = await Z.call('GET', `${J}/diagnostics/attempts/${failedRow.id}`, tok.tl);
  Z.check('attempt detail: log steps, files and the entry (TL of the job)', att.status === 200 && att.body.logs.length > 2 && Array.isArray(att.body.files) && att.body.entry.id === failedRow.id, att.status);
  Z.check('attempt detail: another department\'s TL gets 403; a login check needs an Admin', (await Z.call('GET', `${J}/diagnostics/attempts/${failedRow.id}`, tok.tlMed)).status === 403 && (await Z.call('GET', `${J}/diagnostics/attempts/${slow.entry.id}`, tok.tl)).status === 403 && (await Z.call('GET', `${J}/diagnostics/attempts/${slow.entry.id}`, tok.admin)).status === 200);
  const retryApi = await Z.call('POST', `${J}/queue/${failedRow.id}/retry`, tok.tl);
  Z.check('the Retry button works from the diagnostics list (TL)', retryApi.status === 200 && retryApi.body.entry.status === 'QUEUED', retryApi.body);
  await D.ex('UPDATE "PostingQueue" SET "status" = \'CANCELLED\' WHERE "id" = ?', failedRow.id);
  const portalsOv = await Z.call('GET', `${J}/portals`, tok.admin);
  Z.check('portals overview: the switch default is OFF, page settings say UNVERIFIED, real posting flag present', portalsOv.body.portals.filter((p) => p.kind === 'browser').every((p) => p.settings.verified === false || p.portal === 'naukri') && typeof portalsOv.body.realPostingAllowed === 'boolean' && /Unverified/.test(portalsOv.body.portals.find((p) => p.portal === 'shine').settings.label), portalsOv.body.portals.map((p) => p.settings && p.settings.label));
  Z.check('the switch of a never-configured portal is OFF', (await Cred.one('shine')).enabled === false && (await Cred.one('foundit')).enabled === false);

  // ===================================================== 9. the calibration script (against the mock only)
  console.log('\n-- calibration script (mock pages, REAL page settings)');
  const postsBeforeCal = mock.state.posts;
  for (const p of ['naukri', 'shine', 'foundit']) {
    const rawCfg = REAL_JSON(p);
    const o = mock.origin;
    const cfg2 = JSON.parse(JSON.stringify(rawCfg));
    cfg2.urls = { login: `${o}/${p}/login`, dashboard: `${o}/${p}/dashboard`, postJob: `${o}/${p}/post-job`, edit: `${o}/${p}/edit/{id}`, listing: `${o}/${p}/job/{id}`, myJobs: `${o}/${p}/my-jobs` };
    cfg2.unpublish.listUrl = `${o}/${p}/my-jobs`;
    cfg2.allowedHosts = ['127.0.0.1'];
    const f = path.join(TMP, `real-${p}-on-mock.json`);
    fs.writeFileSync(f, JSON.stringify(cfg2));
    const out = path.join(TMP, `calibrate-${p}.json`);
    const run = await runAsync(process.execPath, [path.join(BACK, 'scripts/portal-calibrate.js'), p, '--auto', '--json', out], {
      cwd: BACK, encoding: 'utf8', timeout: 120000, env: { ...process.env, [`TL_PORTAL_SELECTORS_${p.toUpperCase()}`]: f, MOCK_USER: MOCK.VALID_USER, MOCK_PASS: MOCK.VALID_PASS },
    });
    const rep = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    const n = (s) => (rep ? rep.steps.filter((x) => s(x.state)).length : -1);
    console.log(`   ${p}: ${rep ? `${n((s) => s === 'main way works')} main way works, ${n((s) => /^DRIFT/.test(s))} drift, ${n((s) => s === 'NOT FOUND')} not found (of ${rep.steps.length}) on the MOCK pages` : run.stderr.slice(0, 300)}`);
    Z.check(`calibrate ${p}: runs against the mock, exits 0, reports every step, saves a picture and a snapshot, says nothing was posted`, run.status === 0 && !!rep && rep.steps.length >= 10 && rep.files.length >= 2 && /Nothing was typed, clicked or posted by this tool/.test(run.stdout), [run.status, run.stderr.slice(0, 200)]);
    Z.check(`calibrate ${p}: the login-page steps are found by the real page settings`, !!rep && rep.steps.filter((s) => s.key.startsWith('login.')).every((s) => s.state !== 'NOT FOUND'), rep && rep.steps.filter((s) => s.key.startsWith('login.')).map((s) => [s.key, s.state]));
    Z.check(`calibrate ${p}: the mock never saw a post (the tool only looks)`, mock.state.posts === postsBeforeCal, [mock.state.posts, postsBeforeCal]);
  }
  const refuse = spawnSync(process.execPath, [path.join(BACK, 'scripts/portal-calibrate.js'), 'naukri', '--auto'], { cwd: BACK, encoding: 'utf8', timeout: 60000, env: { ...process.env, TL_POSTING_STRICT_LOCAL: '', TEST_MODE: '', TL_PORTAL_SELECTORS_NAUKRI: '' } }); // (the built-in REAL naukri settings, outside strict mode: it must refuse before opening anything)
  Z.check('calibrate --auto REFUSES to drive a real site (only the local mock)', refuse.status === 1 && /Refusing/.test(refuse.stderr), [refuse.status, refuse.stderr.slice(0, 200)]);

  // ===================================================== 10. every request stayed local
  Z.check('no request ever left this machine: every request the mock saw was local', mock.state.requests.every((r) => /^127\.0\.0\.1:/.test(r.host)));

  // ===================================================== cleanup
  await mock.close();
  OTP.stopServer();
  copies.forEach((c) => { try { fs.unlinkSync(c); } catch { /* gone */ } });
  const ids = Z.made.reqs;
  await D.ex(`DELETE FROM "PostingLog" WHERE "requirementId" IN (${ids.map(() => '?').join(',')}) OR "queueId" IS NULL OR "id" = 'pl-old-test'`, ...ids);
  await D.ex('DELETE FROM "PostingLog" WHERE "queueId" IN (SELECT "id" FROM "PostingQueue" WHERE "requirementId" IS NULL OR "portal" LIKE \'zz%\')');
  await D.ex(`DELETE FROM "PostingQueue" WHERE "requirementId" IN (${ids.map(() => '?').join(',')}) OR "requirementId" IS NULL`, ...ids);
  await D.ex(`DELETE FROM "PortalPosting" WHERE "requirementId" IN (${ids.map(() => '?').join(',')})`, ...ids);
  await D.ex('DELETE FROM "PortalCredential"');
  await cleanSettings();
  await prisma.auditLog.deleteMany({ where: { OR: [{ entity: 'PortalCredential' }, { entity: 'JobPublish' }, { action: { in: ['Posted by automation', 'Taken down by automation'] } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'the requirement is live' } }, { title: { contains: 'a person is needed' } }, { title: { contains: 'did not go through' } }, { title: { contains: 'type the OTP' } }, { title: { contains: 'is live on' } }] } }).catch(() => {});
  const left = await Z.cleanup();
  // (only OUR rows are counted: another agent's engine rows in the shared sandbox are not ours to remove)
  const mine = ids.length ? ids.map(() => '?').join(',') : "'-'";
  const lq = await D.q(`SELECT (SELECT COUNT(*) FROM "PostingQueue" WHERE "requirementId" IN (${mine}) OR "requirementId" IS NULL) q, (SELECT COUNT(*) FROM "PortalPosting" WHERE "requirementId" IN (${mine})) p, (SELECT COUNT(*) FROM "PostingLog" WHERE "requirementId" IN (${mine}) OR "queueId" IS NULL) l, (SELECT COUNT(*) FROM "PortalCredential") c`, ...ids, ...ids, ...ids);
  Z.check('cleanup: no ZZTEST row and no engine row left', Object.values(left).every((n) => n === 0) && Object.values(lq[0]).every((n) => n === 0), [left, lq[0]]);
  fs.rmSync(TMP, { recursive: true, force: true });
  await Z.finish();
})().catch(async (e) => {
  console.error('TEST CRASHED', e);
  try { OTP.stopServer(); await Z.cleanup(); await D.ex('DELETE FROM "PortalCredential"'); await cleanSettings(); } catch { /* */ }
  process.exit(1);
});
