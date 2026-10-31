// ---------------------------------------------------------------------------
// JOB DISTRIBUTION: acceptance test (Posting Kit, tracked links, Posted tracker, Telegram + Facebook adapters).
// SANDBOX ONLY (API 4011, prisma/sandbox.db). NOTHING real is ever called: Telegram and Facebook are tested against a LOCAL
// fake HTTP server (TL_TELEGRAM_API_BASE / TL_FACEBOOK_GRAPH_BASE) and TL_API_STRICT_LOCAL=1 makes the adapters refuse a real host.
//   TL_API=http://localhost:4011 node scripts/job-distribution-test.js
// Tag "ZZTEST DX". Applies the migration SQL to the SANDBOX copy when the tables are missing (never touches dev.db).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const fs = require('fs');
const http = require('http');
const path = require('path');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('DX');
const { BACK, prisma } = Z;

process.env.TL_API_STRICT_LOCAL = '1';
const D = require(path.join(BACK, 'src/jobPublish/db'));
const Q = require(path.join(BACK, 'src/jobPublish/queue'));
const S = require(path.join(BACK, 'src/jobPublish/settings'));
const Cred = require(path.join(BACK, 'src/jobPublish/credentials'));
const P = require(path.join(BACK, 'src/jobPublish/portalPosting'));
const runner = require(path.join(BACK, 'src/jobPublish/runner'));
const svc = require(path.join(BACK, 'src/jobPublish/service'));
const Plat = require(path.join(BACK, 'src/jobDist/platforms'));
const Track = require(path.join(BACK, 'src/jobDist/tracker'));
const T = require(path.join(BACK, 'src/jobDist/text'));
const Attr = require(path.join(BACK, 'src/jobDist/attribution'));
const bridge = require(path.join(BACK, 'src/utils/jobPortalBridge'));
const J = '/api/job-publish';
const DX = '/api/job-dist';
const day = 86400000;

// ---- the fake Telegram / Facebook ------------------------------------------------------------------------------
const TG_TOKEN = '123456789:AAHzzdxFAKEtokenFAKEtokenFAKEtoken12345';
const FB_TOKEN = 'EAAzzdxFAKEpageTOKENfakefakefakefakefake1234567890';
const FB_PAGE = '104820934501234';
const fake = { log: [], tg: 'ok', fb: 'ok', nextId: 500 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    let m = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
    if (m) {
      const [, token, method] = m;
      const json = body ? JSON.parse(body) : {};
      fake.log.push({ kind: 'tg', method, token, body: json });
      if (token !== TG_TOKEN || fake.tg === 'badtoken') return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      if (method === 'getMe') return send(200, { ok: true, result: { id: 777, is_bot: true, username: 'zzdx_bot' } });
      if (method === 'getChat') return fake.tg === 'nochat' ? send(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }) : send(200, { ok: true, result: { id: -1001, title: 'ZZ DX Jobs', type: 'channel' } });
      if (method === 'getChatMember') return send(200, { ok: true, result: { status: fake.tg === 'notadmin' ? 'member' : 'administrator', can_post_messages: true } });
      if (method === 'sendMessage') {
        if (fake.tg === 'rate') return send(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } });
        if (fake.tg === 'notadmin') return send(403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' });
        if (fake.tg === 'nochat') return send(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        fake.nextId += 1;
        return send(200, { ok: true, result: { message_id: fake.nextId, chat: { id: -1001 }, text: json.text } });
      }
      if (method === 'editMessageText') return send(200, { ok: true, result: { message_id: json.message_id, text: json.text } });
      return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    }
    m = /^\/v19\.0\/([^/]+)(\/feed)?$/.exec(u.pathname);
    if (m) {
      const params = req.method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(body));
      fake.log.push({ kind: 'fb', method: req.method, path: u.pathname, token: params.access_token, body: params });
      if (params.access_token !== FB_TOKEN || fake.fb === 'badtoken') return send(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
      if (fake.fb === 'nopage') return send(400, { error: { message: "Unsupported get request. Object with ID '1' does not exist", type: 'GraphMethodException', code: 100 } });
      if (fake.fb === 'perm') return send(403, { error: { message: '(#200) Requires pages_manage_posts permission to manage the object', type: 'OAuthException', code: 200 } });
      if (fake.fb === 'rate') return send(400, { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } });
      if (req.method === 'GET') return send(200, { id: m[1], name: 'ZZ DX Jobs Page' });
      if (m[2]) { fake.nextId += 1; return send(200, { id: `${m[1]}_${fake.nextId}` }); }
      return send(200, { success: true });
    }
    return send(404, { error: 'unknown' });
  });
});

async function ensureSchema() {
  if (await Plat.ready()) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')));
  db.exec('PRAGMA busy_timeout=8000');
  db.exec(fs.readFileSync(path.join(BACK, 'prisma/migrations/20261014300000_job_distribution/migration.sql'), 'utf8'));
  db.close();
  Plat.forgetReady();
  console.log('(applied the job_distribution migration SQL to the SANDBOX copy)');
}

const ZZ_SETTING_KEYS = ['jobdist.settings', 'jobdist.googleIndexing', 'jobdist.googleIndexing.key', 'jobpublish.limits', 'jobpublish.portal.telegram.kill', 'jobpublish.portal.facebook.kill'];
async function cleanRows(reqIds, userIds) {
  const inl = (a) => (a.length ? a.map(() => '?').join(',') : "'__none__'");
  if (reqIds.length) {
    await D.ex(`DELETE FROM "DistPosting" WHERE "requirementId" IN (${inl(reqIds)})`, ...reqIds).catch(() => {});
    await D.ex(`DELETE FROM "PostingLog" WHERE "requirementId" IN (${inl(reqIds)})`, ...reqIds).catch(() => {});
    await D.ex(`DELETE FROM "PostingQueue" WHERE "requirementId" IN (${inl(reqIds)})`, ...reqIds).catch(() => {});
    await D.ex(`DELETE FROM "PortalPosting" WHERE "requirementId" IN (${inl(reqIds)})`, ...reqIds).catch(() => {});
    await prisma.appSetting.deleteMany({ where: { OR: reqIds.map((id) => ({ key: { in: [`jobdist.text.${id}`, `jobposts.saved.${id}`] } })) } }).catch(() => {});
  }
  await D.ex('DELETE FROM "PostingLog" WHERE "queueId" IS NULL AND "portal" IN (\'telegram\',\'facebook\')').catch(() => {});
  await D.ex('DELETE FROM "PortalCredential" WHERE "portal" IN (\'telegram\',\'facebook\')').catch(() => {});
  await prisma.appSetting.deleteMany({ where: { key: { in: [...ZZ_SETTING_KEYS, 'jobpublish.portal.telegram.lastTest', 'jobpublish.portal.facebook.lastTest'] } } }).catch(() => {});
  if (userIds.length) await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: userIds } }, { assignedById: { in: userIds } }] } }).catch(() => {});
}

(async () => {
  await ensureSchema();
  console.log('preclean', JSON.stringify(await Z.preclean()));
  await D.ex('DELETE FROM "DistPosting" WHERE "requirementId" IN (SELECT "id" FROM "Requirement" WHERE "title" LIKE \'ZZTEST DX%\')').catch(() => {});
  await cleanRows([], []);

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.TL_TELEGRAM_API_BASE = origin;
  process.env.TL_FACEBOOK_GRAPH_BASE = `${origin}/v19.0`;
  process.env.APP_BASE_URL = 'https://jobs.zzdx.example.test';

  // ===================================================== fixtures
  const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
  const admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const mgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const hr = await mk('hr', { role: 'HR', atsRole: 'HR' }, { designation: 'HR' });
  const tok = {};
  for (const [k, u] of Object.entries({ admin, mgr, tl, bde, rec, hr })) tok[k] = await Z.mint(u);
  const id = {};
  for (const [k, u] of Object.entries({ admin, tl, bde, rec })) id[k] = await Z.identity(u);
  const client = await prisma.client.create({ data: { name: 'ZZTEST DX Client Acme Ltd', status: 'Active' } });
  Z.made.clients.push(client.id);
  const mkJob = async (title, extra = {}) => {
    const r = await prisma.requirement.create({
      data: {
        title, clientId: client.id, department: 'Education', status: 'OPEN', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id, location: 'Hyderabad', experience: '2-6', skills: 'Physics, Teaching, Research',
        salary: '8-12 LPA', education: 'MSc', openings: 2, employmentType: 'Full Time', portalPublished: true, portalPublishedAt: new Date(),
        jobDescription: 'ZZTEST DX Client Acme Ltd needs a lecturer to teach physics to degree students in Hyderabad. Strong subject knowledge and a love of teaching are needed.\nOur service fee is 8.33% commission on the annual CTC.\nThe agreement is signed and the invoice goes monthly.',
        ...extra,
      },
    });
    Z.made.reqs.push(r.id);
    return r;
  };
  const jobA = await mkJob('ZZTEST DX Physics Lecturer', { reqCode: 'ZZDX-90001' });
  const jobB = await mkJob('ZZTEST DX Chemistry Lecturer', { reqCode: 'ZZDX-90002' });
  const jobC = await mkJob('ZZTEST DX Maths Lecturer', { reqCode: 'ZZDX-90003' });
  const jobD = await mkJob('ZZTEST DX Biology Lecturer', { reqCode: 'ZZDX-90004' });
  const jobE = await mkJob('ZZTEST DX Closing Lecturer', { reqCode: 'ZZDX-90005' });
  const jobInternal = await mkJob('ZZTEST DX Internal Recruiter', { reqCode: 'ZZDX-90006', internal: true, tlId: null, bdeId: null, recruiterId: null });
  const g = (p, t) => Z.call('GET', p, tok[t]);
  const send = (m, p, t, b) => Z.call(m, p, tok[t], m === 'GET' ? undefined : (b === undefined ? {} : b));
  await Z.call('POST', '/api/public/careers/_test/reset-limits', null);

  // ===================================================== 1. the platform list
  console.log('\n-- platform list');
  let r = await g(`${DX}/platforms`, 'tl');
  const keys = (r.body.platforms || []).map((p) => p.key);
  const want = ['career', 'google', 'feed', 'linkedin', 'indeed', 'naukri', 'shine', 'foundit', 'apna', 'workindia', 'freshersworld', 'quikr', 'olx', 'ncs', 'whatsapp', 'college', 'referral', 'telegram', 'facebook'];
  Z.check('seeded: every default place is in the list (19)', want.every((k) => keys.includes(k)) && keys.length >= 19, keys);
  const by = (k) => (r.body.platforms || []).find((p) => p.key === k);
  Z.check('seeded: Naukri is semi-automatic (browser bot OFF by default), Telegram automatic, college by hand', by('naukri').kind === 'semi' && by('telegram').kind === 'auto' && by('college').kind === 'manual', [by('naukri').kind, by('telegram').kind]);
  Z.check('seeded: each job site has a post link and a text limit', ['linkedin', 'indeed', 'naukri', 'apna', 'whatsapp'].every((k) => by(k).postUrl || k === 'x') && by('whatsapp').maxChars === 1000, by('whatsapp'));
  r = await send('PUT', `${DX}/platforms/apna`, 'rec', { maxChars: 900 });
  Z.check('list edit: a Recruiter cannot change the list (403)', r.status === 403, r.status);
  r = await send('PUT', `${DX}/platforms/apna`, 'tl', { maxChars: 900 });
  Z.check('list edit: a TL cannot change the list (403)', r.status === 403, r.status);
  r = await send('PUT', `${DX}/platforms/apna`, 'admin', { maxChars: 900, formatHint: 'Test hint', postUrl: 'https://employer.apna.co/jobs/new' });
  Z.check('list edit: an Admin can (limit, hint, link)', r.status === 200 && r.body.platform.maxChars === 900 && r.body.platform.postUrl === 'https://employer.apna.co/jobs/new', r.body);
  r = await send('PUT', `${DX}/platforms/apna`, 'admin', { postUrl: 'javascript:alert(1)' });
  Z.check('list edit: a javascript: link is refused', r.status === 400, r.body);
  r = await send('POST', `${DX}/platforms`, 'admin', { name: 'ZZTEST DX Local Board', kind: 'semi', medium: 'job_board', postUrl: 'https://example.test/post', maxChars: 500 });
  Z.check('list edit: an Admin can add a new place', r.status === 201 && r.body.platform.key === 'zztestdxlocalboard', r.body);
  const customKey = r.body.platform && r.body.platform.key;
  r = await send('PUT', `${DX}/platforms/telegram`, 'admin', { kind: 'manual' });
  Z.check('list edit: Telegram cannot be turned into a by-hand place', r.status === 400, r.body);

  // ===================================================== 2. the Posting Kit
  console.log('\n-- ready text + tracked links');
  r = await g(`${DX}/jobs/${jobA.id}`, 'tl');
  Z.check('distribute: a TL opens the job tab (200) and may post', r.status === 200 && r.body.can.post === true, [r.status, r.body && r.body.can]);
  const cards = r.body.cards || [];
  Z.check('distribute: every place is a card', want.every((k) => cards.some((c) => c.key === k)) && cards.some((c) => c.key === customKey), cards.map((c) => c.key));
  const kitCards = cards.filter((c) => c.kit);
  Z.check('kit: every non-automatic place has ready text, plus Telegram and Facebook', kitCards.length >= 15, kitCards.length);
  const bad = [];
  kitCards.forEach((c) => {
    const t = c.kit.text;
    if (/ZZTEST DX Client|Acme/i.test(t) || /ZZTEST DX Client|Acme/i.test(c.kit.title)) bad.push(`${c.key}: client name`);
    if (/commission|8\.33|agreement|invoice|service fee|e-?sign/i.test(t)) bad.push(`${c.key}: fee / agreement words`);
    if (c.maxChars && t.length > c.maxChars) bad.push(`${c.key}: ${t.length} > ${c.maxChars}`);
    if (!t.includes(c.kit.link)) bad.push(`${c.key}: tracked link missing`);
  });
  Z.check('kit: NO client name, fee or agreement words in any text; every text is inside its limit', bad.length === 0, bad);
  const lk = cards.find((c) => c.key === 'linkedin').kit;
  const u = new URL(lk.link);
  Z.check('tracked link: <site>/careers/<slug>?src=linkedin&utm_source=linkedin&utm_medium=job_board&utm_campaign=job-<code>', /^\/careers\/.+zzdx-90001$/i.test(u.pathname) && u.searchParams.get('src') === 'linkedin' && u.searchParams.get('utm_source') === 'linkedin' && u.searchParams.get('utm_medium') === 'job_board' && u.searchParams.get('utm_campaign') === 'job-zzdx-90001', lk.link);
  const links = new Set(kitCards.map((c) => c.kit.link));
  Z.check('tracked link: each place has its OWN link', links.size === kitCards.length, [links.size, kitCards.length]);
  Z.check('tracked link: Telegram uses ?src=telegram, Facebook ?src=facebook', cards.find((c) => c.key === 'telegram').kit.link.includes('src=telegram&utm_source=telegram') && cards.find((c) => c.key === 'facebook').kit.link.includes('src=facebook&utm_source=facebook'));
  const naukriKit = cards.find((c) => c.key === 'naukri').kit;
  Z.check('kit: Naukri text keeps the salary (allowed), has no old ?src=Naukri link', /LPA|8/.test(naukriKit.text) && !/src=Naukri/.test(naukriKit.text), naukriKit.text.slice(0, 300));
  const wa = cards.find((c) => c.key === 'whatsapp').kit;
  Z.check('kit: WhatsApp is a short message (under 1000 characters) with the apply link', wa.text.length <= 1000 && wa.text.includes('Apply:'), wa.chars);
  await send('PUT', `${DX}/platforms/whatsapp`, 'admin', { includeSalary: false });
  r = await g(`${DX}/jobs/${jobA.id}/platforms/whatsapp/text`, 'tl');
  Z.check('kit: salary is left out when the place does not want it', r.status === 200 && !/salary|LPA/i.test(r.body.kit.text), r.body.kit && r.body.kit.text);
  await send('PUT', `${DX}/platforms/whatsapp`, 'admin', { includeSalary: true });
  await send('PUT', `${DX}/platforms/apna`, 'admin', { maxChars: 300 });
  r = await g(`${DX}/jobs/${jobA.id}/platforms/apna/text`, 'tl');
  Z.check('kit: a small limit shortens the text and says so', r.body.kit.text.length <= 300 && r.body.kit.trimmed === true && r.body.kit.text.includes('Apply:') && r.body.kit.notes.length > 0, [r.body.kit.chars, r.body.kit.notes]);
  await send('PUT', `${DX}/platforms/apna`, 'admin', { maxChars: 1500 });
  // edit + reset
  r = await send('PUT', `${DX}/jobs/${jobA.id}/platforms/naukri/text`, 'rec', { text: 'x' });
  Z.check('edit text: a Recruiter cannot (403)', r.status === 403, r.status);
  r = await send('PUT', `${DX}/jobs/${jobA.id}/platforms/naukri/text`, 'tl', { text: `My own Naukri text.\nApply: ${naukriKit.link}`, title: 'My title' });
  Z.check('edit text: a TL can; it is kept (overridden)', r.status === 200 && r.body.kit.overridden === true && r.body.kit.text.startsWith('My own Naukri text'), r.body);
  r = await g(`${DX}/jobs/${jobA.id}/platforms/naukri/text`, 'rec');
  Z.check('edit text: a Recruiter reads the edited text', r.status === 200 && r.body.kit.overridden === true);
  r = await Z.call('DELETE', `${DX}/jobs/${jobA.id}/platforms/naukri/text`, tok.tl);
  Z.check('edit text: Reset to auto brings the written text back', r.status === 200 && r.body.kit.overridden === false && !r.body.kit.text.startsWith('My own'), r.body);

  // ===================================================== 3. tracked links -> candidate source
  console.log('\n-- attribution');
  const mkApp = async (n, source, attribution) => {
    const out = await bridge.ingestApplication({
      requirementId: jobA.id, application: { id: `zzdx-app-${Z.RUN}-${n}`, jobId: `tl_${jobA.id}`, source }, candidate: { name: `ZZTEST DX Cand ${n}`, email: `zz-dx-cand${n}-${Z.RUN}@example.test`, phone: `98${String(70000000 + Number(n) * 1111 + (parseInt(Z.RUN, 36) % 1000))}`.slice(0, 10) }, attribution,
    });
    if (out.body.applicationId) Z.made.apps.push(out.body.applicationId);
    if (out.body.candidateId) Z.made.cands.push(out.body.candidateId);
    return out;
  };
  const a1 = await mkApp(1, 'linkedin', { src: 'linkedin', utm_source: 'linkedin', utm_medium: 'job_board', utm_campaign: 'job-zzdx-90001' });
  const a2 = await mkApp(2, 'apna', { src: 'apna', utm_source: 'apna', utm_medium: 'job_board', utm_campaign: 'job-zzdx-90001' });
  const a3 = await mkApp(3, '', { utm_source: 'whatsapp', utm_medium: 'messaging' });
  const a4 = await mkApp(4, 'naukri', { src: 'naukri', utm_source: 'naukri', utm_medium: 'job_board' });
  const a5 = await mkApp(5, '', {});
  const row = (o) => prisma.application.findUnique({ where: { id: o.body.applicationId } });
  const rows = [await row(a1), await row(a2), await row(a3), await row(a4), await row(a5)];
  Z.check('source: ?src=linkedin shows "LinkedIn" (Application.firstSource), utm_source kept', rows[0].firstSource === 'LinkedIn' && rows[0].utmSource === 'linkedin' && rows[0].utmMedium === 'job_board', [rows[0].firstSource, rows[0].utmSource]);
  Z.check('source: ?src=apna shows "Apna"', rows[1].firstSource === 'Apna' && rows[1].utmSource === 'apna', [rows[1].firstSource]);
  Z.check('source: utm_source=whatsapp alone (no src) shows "WhatsApp"', rows[2].firstSource === 'WhatsApp', [rows[2].firstSource]);
  Z.check('source: ?src=naukri still shows "Naukri"', rows[3].firstSource === 'Naukri', [rows[3].firstSource]);
  Z.check('source: no tag at all stays the portal itself', rows[4].firstSource !== 'LinkedIn' && !rows[4].utmSource, [rows[4].firstSource]);
  const cand1 = await prisma.candidate.findUnique({ where: { id: a1.body.candidateId } });
  Z.check('source: the candidate\'s first source reads "LinkedIn" too', cand1.firstSource === 'LinkedIn', cand1.firstSource);
  Z.check('source: labelFor / keyFor read slugs, names and admin names', Attr.labelFor('LINKEDIN') === 'LinkedIn' && Attr.keyFor('Apna') === 'apna' && Attr.labelFor('nonsense-xyz') === null && Attr.labelFor('quikr') === 'Quikr Jobs');
  r = await g(`${DX}/jobs/${jobA.id}/sources`, 'tl');
  const src = Object.fromEntries((r.body.sources || []).map((s) => [s.key, s.applicants]));
  Z.check('source report: applicants per place from the tracked links (counts only)', r.status === 200 && src.linkedin === 1 && src.apna === 1 && src.whatsapp === 1 && src.naukri === 1, r.body);
  r = await g(`${DX}/jobs/${jobA.id}`, 'tl');
  Z.check('source report: the card shows its applicant count', r.body.cards.find((c) => c.key === 'linkedin').applicants === 1);

  // ===================================================== 4. mark as posted, states, role gates
  console.log('\n-- mark as posted');
  const post = (t, job, key, body) => send('POST', `${DX}/jobs/${job.id}/platforms/${key}/posted`, t, body);
  r = await post('rec', jobA, 'linkedin', { postUrl: 'https://www.linkedin.com/jobs/view/1' });
  Z.check('gate: a Recruiter cannot mark posted (403, read only)', r.status === 403, [r.status, r.body]);
  r = await post('mgr', jobA, 'linkedin', { postUrl: 'https://www.linkedin.com/jobs/view/1' });
  Z.check('gate: a Manager cannot mark posted (view only)', r.status === 403, r.status);
  r = await post('hr', jobA, 'linkedin', {});
  Z.check('gate: HR cannot mark a client job posted', r.status === 403, r.status);
  r = await post('tl', jobA, 'telegram', {});
  Z.check('gate: Telegram is posted by TeamLink, nothing to mark by hand (400)', r.status === 400, r.body);
  r = await post('tl', jobA, 'linkedin', { postUrl: 'not a link' });
  Z.check('validate: a bad link is refused in plain words', r.status === 400 && /web address|http/i.test(r.body.error), r.body);
  r = await post('tl', jobA, 'linkedin', { postedAt: new Date(Date.now() + 10 * day).toISOString() });
  Z.check('validate: a posting date in the future is refused', r.status === 400, r.body);
  r = await post('tl', jobA, 'linkedin', { expiresAt: new Date(Date.now() - 5 * day).toISOString() });
  Z.check('validate: an expiry before the posting date is refused', r.status === 400, r.body);
  r = await post('tl', jobA, 'linkedin', { postUrl: 'https://www.linkedin.com/jobs/view/1', postedBy: 'Priya (colleague)', notes: 'posted at 10am' });
  const lp = r.body.posting;
  Z.check('mark: a TL marks LinkedIn posted: link, who, notes kept', r.status === 200 && lp.postUrl.includes('linkedin.com/jobs/view/1') && lp.postedByName === 'Priya (colleague)' && lp.notes === 'posted at 10am', r.body);
  Z.check('mark: honest words "Posted by <name> (not checked by the system)"', /^Posted by Priya \(colleague\) \(not checked by the system\)$/.test(lp.state.label), lp.state.label);
  const days = (Date.parse(lp.expiresAt) - Date.parse(lp.postedAt)) / day;
  Z.check('mark: expiry defaults to +30 days (the place\'s own setting)', Math.round(days) === 30, days);
  // a BDE only sends the requirement to the team leads; posting (by hand too) is the team lead's (founder 2026-10-31)
  r = await post('bde', jobA, 'apna', { postUrl: 'https://apna.co/job/9', noExpiry: true });
  Z.check('mark: a BDE cannot (the team lead posts)', r.status === 403, [r.status, r.body]);
  r = await post('tl', jobA, 'apna', { postUrl: 'https://apna.co/job/9', noExpiry: true });
  Z.check('mark: a TL can; "no expiry" is honoured', r.status === 200 && r.body.posting.expiresAt === null && r.body.posting.state.key === 'POSTED', r.body);
  r = await post('admin', jobA, customKey, {});
  Z.check('mark: a place added by an Admin works the same (default expiry 30 days)', r.status === 200 && r.body.posting.expiresAt, r.body);
  r = await post('tl', jobA, 'whatsapp', { keepText: true });
  Z.check('mark: WhatsApp needs no link; the text posted is kept for the record', r.status === 200 && r.body.posting.postUrl === null, r.body);
  r = await g(`${DX}/jobs/${jobA.id}`, 'rec');
  Z.check('read only: a Recruiter sees the states but cannot post (can.post false)', r.status === 200 && r.body.can.post === false && r.body.cards.find((c) => c.key === 'linkedin').state.key === 'POSTED', r.body && r.body.can);
  Z.check('summary: counts of posted / pending', r.body.summary.posted >= 4 && r.body.summary.pending > 0, r.body.summary);
  r = await post('admin', jobInternal, 'linkedin', {});
  Z.check('internal job: never on a public job site (400)', r.status === 400, r.body);
  r = await g(`${DX}/jobs/${jobInternal.id}`, 'admin');
  Z.check('internal job: only the careers page and our own team are offered', r.status === 200 && r.body.cards.map((c) => c.key).sort().join() === 'career,referral', r.body.cards && r.body.cards.map((c) => c.key));
  r = await g(`${DX}/jobs/${jobB.id}`, 'rec');
  Z.check('scope: a job outside the viewer\'s area is refused', r.status === 200 || r.status === 403);

  // ===================================================== 5. the Jobs list: Posted on, filter, counts
  console.log('\n-- Jobs list');
  r = await g('/api/requirements?page=1&pageSize=100', 'admin');
  const listRows = r.body.rows || [];
  const mine = listRows.find((x) => x.id === jobA.id);
  Z.check('jobs list: the by-hand places are chips on the row (linkedin, apna, whatsapp)', !!mine && ['linkedin', 'apna', 'whatsapp'].every((k) => (mine.postedOn || []).some((c) => c.portal === k && c.state === 'posted' && c.byHand)), mine && mine.postedOn);
  Z.check('jobs list: Posted on counts include by-hand places', r.body.postedCounts && r.body.postedCounts.linkedin >= 1 && r.body.postedCounts.apna >= 1 && r.body.postedCounts.whatsapp >= 1, r.body.postedCounts);
  r = await g('/api/requirements?page=1&pageSize=100&postedOn=linkedin', 'admin');
  Z.check('jobs list: filter Posted on = LinkedIn finds the job', (r.body.rows || []).some((x) => x.id === jobA.id) && !(r.body.rows || []).some((x) => x.id === jobB.id), (r.body.rows || []).map((x) => x.id));
  r = await g('/api/requirements?page=1&pageSize=100&postedOn=none', 'admin');
  Z.check('jobs list: "Not posted yet" leaves the posted job out and keeps an unposted one', !(r.body.rows || []).some((x) => x.id === jobA.id) && (r.body.rows || []).some((x) => x.id === jobB.id), (r.body.rows || []).length);
  r = await g('/api/requirements?page=1&pageSize=100&postedOn=any', 'admin');
  Z.check('jobs list: "Any" finds posted jobs', (r.body.rows || []).some((x) => x.id === jobA.id));

  // ===================================================== 6. expiry reminders, expired, tracker
  console.log('\n-- expiry, reminders, tracker');
  await prisma.notification.deleteMany({ where: { userId: { in: [bde.id, tl.id] } } });
  await D.ex('UPDATE "DistPosting" SET "expiresAt" = ? WHERE "requirementId" = ? AND "platform" = \'linkedin\'', Date.now() + 2 * day, jobA.id);
  await D.ex('UPDATE "DistPosting" SET "expiresAt" = ? WHERE "requirementId" = ? AND "platform" = ?', Date.now() - day, jobA.id, customKey);
  await D.ex('UPDATE "DistPosting" SET "expiresAt" = ? WHERE "requirementId" = ? AND "platform" = \'whatsapp\'', Date.now() + 20 * day, jobA.id);
  const s1 = await Track.sweep();
  Z.check('sweep: reminders go out for the post that expires in 2 days and the one that expired', s1.reminded === 2, s1);
  const bell = await prisma.notification.findMany({ where: { userId: { in: [bde.id, tl.id] } } });
  Z.check('reminder: the poster and the TL get a bell', bell.some((n) => n.userId === tl.id && /expires in 2 days/.test(n.title)) && bell.some((n) => n.userId === tl.id && /has expired/.test(n.title)), bell.map((n) => `${n.userId === tl.id ? 'tl' : 'other'}:${n.title}`));
  const tasks = await prisma.task.findMany({ where: { assigneeId: tl.id } });
  Z.check('reminder: a My task "Renew or take down" is made for the poster', tasks.some((t) => /Renew or take down: ZZTEST DX Physics Lecturer on LinkedIn/.test(t.name) && /linkedin\.com\/jobs\/view\/1/.test(t.description)), tasks.map((t) => t.name));
  const s2 = await Track.sweep();
  const tasks2 = await prisma.task.count({ where: { assigneeId: tl.id } });
  Z.check('reminder: a second sweep sends nothing again (once per post)', s2.reminded === 0 && tasks2 === tasks.length, [s2, tasks2, tasks.length]);
  r = await g(`${DX}/jobs/${jobA.id}`, 'tl');
  const st = (k) => r.body.cards.find((c) => c.key === k).state;
  Z.check('states: Expiring soon / Expired / Posted read right', st('linkedin').key === 'EXPIRING' && st(customKey).key === 'EXPIRED' && st('whatsapp').key === 'POSTED' && st('indeed').key === 'NOT_POSTED', [st('linkedin').key, st(customKey).key, st('whatsapp').key]);
  r = await g(`${DX}/tracker`, 'admin');
  const bp = Object.fromEntries((r.body.byPlatform || []).map((x) => [x.key, x]));
  Z.check('tracker: counts per place: posted / expiring / expired / pending / applicants', bp.linkedin.expiring >= 1 && bp[customKey].expired >= 1 && bp.apna.posted >= 1 && bp.indeed.pending >= 5 && bp.linkedin.applicants >= 1, bp);
  Z.check('tracker: totals', r.body.counts.expiring >= 1 && r.body.counts.expired >= 1 && r.body.counts.posted >= 2 && r.body.counts.pending > 0, r.body.counts);
  r = await g(`${DX}/tracker?status=expired`, 'admin');
  Z.check('tracker: the expired list names job and place', (r.body.rows || []).some((x) => x.requirementId === jobA.id && x.platform === customKey && x.status === 'expired'), r.body.rows);
  r = await g(`${DX}/tracker?status=pending&platform=indeed&q=ZZTEST%20DX`, 'admin');
  Z.check('tracker: the pending list says which open jobs are not on Indeed yet', (r.body.rows || []).some((x) => x.requirementId === jobB.id && x.platform === 'indeed') && !(r.body.rows || []).some((x) => x.requirementId === jobInternal.id), [r.status, r.text.slice(0, 300)]);
  r = await g(`${DX}/tracker`, 'rec');
  Z.check('tracker: a Recruiter may read it (own area)', r.status === 200);
  r = await g(`${DX}/tracker`, 'tl');
  Z.check('tracker: a TL sees the team\'s jobs', r.status === 200 && r.body.counts.posted >= 1, r.body.counts);
  r = await g('/api/requirements?page=1&pageSize=100&postedOn=expired', 'admin');
  Z.check('jobs list: filter "Expired" finds the job with an expired post', (r.body.rows || []).some((x) => x.id === jobA.id));
  const mine2 = ((await g('/api/requirements?page=1&pageSize=100', 'admin')).body.rows || []).find((x) => x.id === jobA.id);
  Z.check('jobs list: an expiring / expired post is shown as such on the chips', (mine2.postedOn || []).some((c) => c.state === 'expiring') && (mine2.postedOn || []).some((c) => c.state === 'expired'), mine2.postedOn);
  r = await send('PUT', `${DX}/settings`, 'tl', { reminderDays: 5 });
  Z.check('settings: a TL cannot change the reminder days (403)', r.status === 403);
  r = await send('PUT', `${DX}/settings`, 'admin', { reminderDays: 5 });
  Z.check('settings: an Admin can (reminder days)', r.status === 200 && r.body.settings.reminderDays === 5, r.body);
  await send('PUT', `${DX}/settings`, 'admin', { reminderDays: 3 });

  // ===================================================== 7. closing a job: the take-down checklist
  console.log('\n-- close a job');
  await post('tl', jobE, 'indeed', { postUrl: 'https://employers.indeed.com/j/1' });
  await post('tl', jobE, 'apna', { postUrl: 'https://apna.co/job/77' });
  await prisma.requirement.update({ where: { id: jobE.id }, data: { status: 'CLOSED' } });
  const c1 = await Track.onJobClosed(jobE.id, id.tl);
  Z.check('close: one take-down task per place where it was posted', c1.tasks === 2, c1);
  const tk = await prisma.task.findMany({ where: { name: { startsWith: 'Take it down: ZZTEST DX Closing Lecturer' } } });
  Z.check('close: the tasks carry the platform links (your post + the site to open)', tk.length === 2 && tk.every((t) => /Your post: https:/.test(t.description)) && tk.some((t) => /employers\.indeed\.com/.test(t.description)), tk.map((t) => t.description));
  Z.check('close: the task belongs to the person who posted', tk.every((t) => t.assigneeId === tl.id), tk.map((t) => t.assigneeId));
  const c2 = await Track.onJobClosed(jobE.id, id.tl); const s3 = await Track.sweep();
  Z.check('close: asking again (or a sweep) never makes a second checklist', c2.tasks === 0 && s3.takedown === 0 && (await prisma.task.count({ where: { name: { startsWith: 'Take it down: ZZTEST DX Closing' } } })) === 2, [c2, s3]);
  r = await g(`${DX}/jobs/${jobE.id}`, 'tl');
  Z.check('close: the Distribute tab lists "Take it down from these places"', r.body.closedChecklist.length === 2 && r.body.closedChecklist.every((x) => x.name && x.postUrl), r.body.closedChecklist);
  r = await send('POST', `${DX}/jobs/${jobE.id}/platforms/indeed/taken-down`, 'rec');
  Z.check('close: a Recruiter cannot tick it (403)', r.status === 403);
  r = await send('POST', `${DX}/jobs/${jobE.id}/platforms/indeed/taken-down`, 'tl');
  Z.check('close: "I took it down" by hand: state Taken down, task completed', r.status === 200 && r.body.posting.state.key === 'TAKEN_DOWN' && (await prisma.task.count({ where: { name: 'Take it down: ZZTEST DX Closing Lecturer on Indeed', status: 'Completed' } })) === 1, r.body);
  r = await g(`${DX}/jobs/${jobE.id}`, 'tl');
  Z.check('close: only the place not yet taken down stays on the checklist', r.body.closedChecklist.length === 1 && r.body.closedChecklist[0].key === 'apna', r.body.closedChecklist);
  const tkn = await g(`${DX}/tracker?status=taken_down`, 'admin');
  Z.check('tracker: taken down is its own state', (tkn.body.rows || []).some((x) => x.requirementId === jobE.id && x.platform === 'indeed'), tkn.body.rows);
  // a posted mark made by mistake
  r = await Z.call('DELETE', `${DX}/jobs/${jobB.id}/platforms/olx/posted`, tok.tl);
  Z.check('undo: removing a mark that was never made is fine', r.status === 200);
  await post('tl', jobB, 'olx', { postUrl: 'https://www.olx.in/item/1' });
  r = await Z.call('DELETE', `${DX}/jobs/${jobB.id}/platforms/olx/posted`, tok.tl);
  Z.check('undo: "I marked the wrong place" puts it back to Not posted', r.status === 200 && (await g(`${DX}/jobs/${jobB.id}`, 'tl')).body.cards.find((c) => c.key === 'olx').state.key === 'NOT_POSTED');

  // ===================================================== 8. JSON-LD and site map
  console.log('\n-- Google for Jobs');
  r = await Z.call('GET', `/api/public/jobs/${jobC.id}/jsonld`, null);
  Z.check('JSON-LD: a live job page carries JobPosting markup (no "Google Jobs" tick needed)', r.status === 200 && r.body && r.body['@type'] === 'JobPosting' && r.body.title === jobC.title && r.body.hiringOrganization.name !== client.name && !JSON.stringify(r.body).includes('Acme'), [r.status, r.text.slice(0, 200)]);
  r = await Z.call('GET', `/api/public/jobs/${jobInternal.id}/jsonld`, null);
  Z.check('JSON-LD: an internal job has none (404)', r.status === 404);
  const slug = require(path.join(BACK, 'src/utils/jobSlug')).slugOf(jobC);
  r = await Z.call('GET', '/sitemap.xml', null);
  Z.check('site map: lists the job\'s /careers/<slug> page', r.status === 200 && r.text.includes(`/careers/${slug}`) && !r.text.includes(jobInternal.id), r.text.slice(0, 200));
  r = await Z.call('GET', `/api/public/job-portal/go/${slug}?src=linkedin&utm_source=linkedin&utm_medium=job_board&utm_campaign=job-zzdx-90003`, null, undefined, { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
  Z.check('crawler: Googlebot following the tracked link gets a page with the JobPosting markup', r.status === 200 && /application\/ld\+json/.test(r.text) && /"@type":"JobPosting"/.test(r.text) && !r.text.includes('Acme'), [r.status, r.text.slice(0, 200)]);
  r = await Z.call('GET', `/api/public/job-portal/go/${slug}?src=linkedin&utm_source=linkedin&utm_medium=job_board&utm_campaign=job-zzdx-90003`, null);
  const loc = r.headers.get('location') || '';
  Z.check('person: a normal browser is redirected to the portal job with src + utm_* kept', r.status === 302 && /src=linkedin/.test(loc) && /utm_source=linkedin/.test(loc) && /utm_medium=job_board/.test(loc) && loc.includes(`#/job/tl_${jobC.id}`), loc);
  r = await send('GET', `${DX}/google-indexing`, 'tl');
  Z.check('Google Indexing API: a TL cannot see its settings (403)', r.status === 403);
  r = await send('GET', `${DX}/google-indexing`, 'admin');
  Z.check('Google Indexing API: OFF and not configured by default, with the plain warning', r.status === 200 && r.body.enabled === false && r.body.configured === false && /limits the Indexing API/.test(r.body.note), r.body);
  r = await send('PUT', `${DX}/google-indexing`, 'admin', { enabled: true });
  Z.check('Google Indexing API: cannot be switched on without a service account key', r.status === 400, r.body);
  r = await send('POST', `${DX}/jobs/${jobC.id}/google-indexing`, 'tl', {});
  Z.check('Google Indexing API: "Tell Google" is refused and calls nothing while OFF', r.status === 409 && /OFF|No Google/.test(r.body.error), r.body);
  r = await send('PUT', `${DX}/google-indexing`, 'admin', { key: '{"type":"nope"}' });
  Z.check('Google Indexing API: a wrong key file is refused in plain words', r.status === 400, r.body);

  // ===================================================== 9. Telegram + Facebook through the engine (fake servers only)
  console.log('\n-- Telegram / Facebook: credentials');
  await S.setLimits(null, { globalConcurrency: 10, minGapSeconds: 0, maxGapSeconds: 0, perHour: 0, perDay: 0, maxAttempts: 3 });
  r = await send('PUT', `${J}/credentials/telegram`, 'admin', { username: 'not a channel', password: 'bad' });
  Z.check('save: a malformed channel / token is refused in plain words', r.status === 400 && /channel|token/i.test(r.body.error), r.body);
  r = await send('PUT', `${J}/credentials/telegram`, 'tl', { username: '@zzdxchannel', password: TG_TOKEN });
  Z.check('save: a TL may save the FIRST Telegram details (like the other portals)', r.status === 200, r.body);
  const dump1 = JSON.stringify(r.body);
  Z.check('save: the answer never holds the token or the channel name', !dump1.includes(TG_TOKEN) && !dump1.includes('zzdxchannel'), dump1.slice(0, 300));
  r = await send('PUT', `${J}/credentials/telegram`, 'tl', { username: '@otherchannel', password: TG_TOKEN });
  Z.check('save: a TL cannot REPLACE it (403 LOGIN_EXISTS)', r.status === 403 && r.body.code === 'LOGIN_EXISTS', r.body);
  r = await Z.call('DELETE', `${J}/credentials/telegram`, tok.tl);
  Z.check('save: a TL cannot delete it (403)', r.status === 403);
  r = await send('PUT', `${J}/credentials/telegram`, 'rec', { username: '@x12345', password: TG_TOKEN });
  Z.check('save: a Recruiter cannot save anything (403)', r.status === 403);
  r = await send('PUT', `${J}/credentials/telegram`, 'admin', { username: '@zzdxchannel', password: TG_TOKEN });
  Z.check('save: an Admin can replace it', r.status === 200 && r.body.credential.hasLogin === true && r.body.credential.fields.password === 'Bot token', r.body.credential);
  const all = [(await g(`${J}/credentials`, 'admin')).text, (await g(`${J}/credentials/telegram/status`, 'tl')).text, (await g(`${J}/portals`, 'admin')).text, (await g(`${J}/portals`, 'tl')).text, (await g(`${J}/diagnostics`, 'admin')).text, (await g(`${DX}/jobs/${jobA.id}`, 'admin')).text];
  Z.check('NO API answer (credentials, status, portals, health, Distribute) ever contains the token', all.every((t) => !t.includes(TG_TOKEN) && !t.includes('AAHzzdx')), all.map((t) => t.length));
  const credRow = await D.q1('SELECT * FROM "PortalCredential" WHERE "portal" = \'telegram\'');
  Z.check('storage: the token and channel are encrypted at rest', credRow.passwordEnc && credRow.passwordEnc.startsWith('enc:v1:') && !credRow.passwordEnc.includes('AAH') && credRow.usernameEnc.startsWith('enc:v1:'), credRow.passwordEnc && credRow.passwordEnc.slice(0, 12));
  r = await g(`${J}/credentials/telegram/status`, 'tl');
  Z.check('status: a poster sees only "saved", no channel and no token', r.body.credential.hasLogin === true && r.body.credential.usernameMasked === undefined && r.body.credential.enabled === false, r.body.credential);
  r = await send('POST', `${J}/credentials/telegram/switch`, 'tl', { enabled: true });
  Z.check('switch: a TL cannot switch Telegram on (403)', r.status === 403);

  console.log('\n-- Telegram: test connection (sends nothing)');
  fake.log.length = 0;
  let v = await Cred.requestVerify('telegram', id.admin);
  Z.check('test connection: getMe + channel + admin check pass', v.ok && v.result.ok && v.result.state === 'CONNECTED' && /zzdx_bot/.test(v.result.summary), v);
  Z.check('test connection: it called getMe, getChat, getChatMember and NEVER sendMessage', ['getMe', 'getChat', 'getChatMember'].every((m) => fake.log.some((x) => x.method === m)) && !fake.log.some((x) => x.method === 'sendMessage'), fake.log.map((x) => x.method));
  fake.tg = 'badtoken'; v = await Cred.requestVerify('telegram', id.admin);
  Z.check('test connection: a wrong token says so and marks the login Failed', v.ok && !v.result.ok && v.result.code === 'BAD_TOKEN' && (await Cred.one('telegram')).status === 'FAILED', v.result);
  fake.tg = 'nochat'; await Cred.save('telegram', { username: '@zzdxchannel', password: TG_TOKEN }, id.admin);
  v = await Cred.requestVerify('telegram', id.admin);
  Z.check('test connection: channel not found is named', !v.result.ok && v.result.code === 'CHANNEL_NOT_FOUND', v.result);
  fake.tg = 'notadmin'; v = await Cred.requestVerify('telegram', id.admin);
  Z.check('test connection: a bot that is not an administrator is named', !v.result.ok && v.result.code === 'NOT_ADMIN' && /administrator/.test(v.result.summary), v.result);
  fake.tg = 'ok'; v = await Cred.requestVerify('telegram', id.admin);
  Z.check('test connection: fixed, it reads Connected again', v.result.ok, v.result);

  console.log('\n-- Telegram: posting');
  const runNext = async (portal) => { const { entry } = await Q.claim({ workerId: 'dx-test', onlyPortals: [portal] }); return entry ? runner.processEntry(entry, { workerId: 'dx-test' }) : null; };
  const lastEntry = async (job, portal) => Q.shape((await D.q('SELECT * FROM "PostingQueue" WHERE "requirementId" = ? AND "portal" = ? ORDER BY "createdAt" DESC', job.id, portal))[0]);
  fake.log.length = 0;
  let out = await svc.publish(id.admin, jobA.id, ['telegram'], {});
  Z.check('switch OFF: Telegram refuses to queue (plain words), nothing is sent', out.results[0].mode === 'refused' && /switched off/.test(out.results[0].reason) && fake.log.length === 0, out.results[0]);
  out = await svc.publish(id.tl, jobA.id, ['telegram'], { dryRun: true });
  Z.check('dry run: allowed even while OFF; it is queued', out.results[0].queued === true, out.results[0]);
  let res = await runNext('telegram');
  const dryEntry = await lastEntry(jobA, 'telegram');
  Z.check('dry run: the run finished, NOTHING was sent (no request at all)', res && res.state === 'SUCCEEDED' && res.dryRun === true && fake.log.length === 0, [res, fake.log.length]);
  Z.check('dry run: the message was built and recorded (title + tracked link, no client name)', dryEntry.result && /Physics Lecturer/.test(dryEntry.result.note || '') && /src=telegram&utm_source=telegram/.test(dryEntry.result.note) && !/Acme|commission/i.test(dryEntry.result.note), dryEntry.result);
  Z.check('dry run: the job is NOT marked posted', !(await P.get(jobA.id, 'telegram')));
  r = await send('POST', `${J}/credentials/telegram/test-post`, 'admin');
  Z.check('test post: refused while the channel is OFF (409), nothing sent', r.status === 409 && fake.log.length === 0, r.body);
  r = await send('POST', `${J}/credentials/telegram/switch`, 'admin', { enabled: true });
  Z.check('switch: an Admin switches Telegram ON', r.status === 200 && r.body.credential.enabled === true, r.body);
  r = await Cred.sendTestPost('telegram', id.tl);
  Z.check('test post: a SEPARATE explicit action sends exactly one test message (and says so)', r.ok && r.sent && fake.log.filter((x) => x.method === 'sendMessage').length === 1 && /Test message from TeamLink/.test(fake.log.find((x) => x.method === 'sendMessage').body.text), r);
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, ['telegram'], {});
  Z.check('publish: queued', out.results[0].queued === true, out.results[0]);
  res = await runNext('telegram');
  const sent = fake.log.filter((x) => x.method === 'sendMessage');
  Z.check('publish: exactly ONE sendMessage, to the saved channel', res && res.state === 'SUCCEEDED' && sent.length === 1 && sent[0].body.chat_id === '@zzdxchannel', [res, sent.length]);
  const msg = sent[0].body.text;
  Z.check('publish: message holds the title and ITS OWN tracked link (?src=telegram)', /Physics Lecturer/.test(msg) && msg.includes(`src=telegram&utm_source=telegram&utm_medium=social&utm_campaign=job-zzdx-90001`), msg);
  Z.check('publish: message has no client name, fee or agreement words, and is inside 4096', !/Acme|commission|8\.33|agreement|invoice/i.test(msg) && msg.length <= 4096, msg);
  let pp = await P.get(jobA.id, 'telegram');
  Z.check('publish: PortalPosting is Posted with the message number and a t.me link', pp.status === 'PUBLISHED' && /^\d+$/.test(pp.portalJobId) && pp.portalUrl === `https://t.me/zzdxchannel/${pp.portalJobId}`, pp);
  const firstId = pp.portalJobId;
  const e1 = await lastEntry(jobA, 'telegram');
  Z.check('publish: the API response status is stored on the queue entry', e1.result && e1.result.apiStatus === '200', e1.result);
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, ['telegram'], {});
  Z.check('idempotent: posting the same job again sends nothing ("Already posted")', out.results[0].mode === 'already' && fake.log.length === 0, out.results[0]);
  out = await svc.republish(id.tl, jobA.id, ['telegram'], {});
  Z.check('idempotent: Republish is the same (one post per job per channel)', out.results[0].mode === 'already' && fake.log.length === 0, out.results[0]);
  // even a queue entry that slipped through (a race) sends nothing
  const slip = await Q.enqueue({ requirementId: jobA.id, portal: 'telegram', action: 'PUBLISH', payloadHash: 'slip', requestedBy: tl.id, requestedByName: tl.name });
  res = await runNext('telegram');
  Z.check('idempotent: a PUBLISH that slipped past the screen is stopped inside the adapter (no request)', res.state === 'SUCCEEDED' && !fake.log.some((x) => x.method === 'sendMessage') && slip.created, [res, fake.log.length]);
  // a change goes out only through "Post update"
  await send('PUT', `${DX}/jobs/${jobA.id}/platforms/telegram/text`, 'tl', { text: `Updated text for the channel.\nApply: ${T.trackedLink(jobA, { key: 'telegram', medium: 'social' }, 'https://jobs.zzdx.example.test')}` });
  await prisma.requirement.update({ where: { id: jobA.id }, data: { title: 'ZZTEST DX Physics Lecturer (updated)' } });
  Z.check('update: editing the job alone sends nothing', fake.log.length === 0);
  out = await svc.update(id.tl, jobA.id, ['telegram'], {});
  res = await runNext('telegram');
  const edits = fake.log.filter((x) => x.method === 'editMessageText');
  Z.check('update: "Post update" EDITS the message that is already there (never a second message)', out.results[0].queued && res.state === 'SUCCEEDED' && edits.length === 1 && String(edits[0].body.message_id) === firstId && !fake.log.some((x) => x.method === 'sendMessage') && /Updated text for the channel/.test(edits[0].body.text), [out.results[0], edits.length]);
  await prisma.requirement.update({ where: { id: jobA.id }, data: { title: 'ZZTEST DX Physics Lecturer' } });

  console.log('\n-- Telegram: failures');
  fake.tg = 'rate'; fake.log.length = 0;
  out = await svc.publish(id.tl, jobB.id, ['telegram'], {});
  const before = Date.now();
  res = await runNext('telegram');
  let qe = await lastEntry(jobB, 'telegram');
  Z.check('429: the run waits (back in the queue), error RATE_LIMITED', res.state === 'QUEUED' && qe.errorCode === 'RATE_LIMITED', [res, qe.errorCode]);
  const nextAt = (await D.q1('SELECT "nextRunAt" n FROM "PostingQueue" WHERE "id" = ?', qe.id)).n;
  Z.check('429: not asked again before the retry_after the site gave (7 s)', nextAt >= before + 6500, nextAt - before);
  fake.tg = 'ok';
  await D.ex('UPDATE "PostingQueue" SET "nextRunAt" = ? WHERE "id" = ?', Date.now() - 1000, qe.id);
  res = await runNext('telegram');
  Z.check('429: after the wait it goes through (Posted)', res.state === 'SUCCEEDED' && (await P.get(jobB.id, 'telegram')).status === 'PUBLISHED' && fake.log.filter((x) => x.method === 'sendMessage').length === 2);
  fake.tg = 'nochat';
  out = await svc.publish(id.tl, jobC.id, ['telegram'], {});
  res = await runNext('telegram'); qe = await lastEntry(jobC, 'telegram');
  Z.check('channel not found: Failed, NOT retried, plain words', res.state === 'FAILED' && qe.errorCode === 'CHANNEL_NOT_FOUND' && /channel or page was not found/i.test(qe.errorMessage), [res, qe.errorMessage]);
  fake.tg = 'badtoken';
  out = await svc.publish(id.tl, jobD.id, ['telegram'], {});
  res = await runNext('telegram'); qe = await lastEntry(jobD, 'telegram');
  Z.check('wrong token: Failed, the login is marked Failed, posting stops', res.state === 'FAILED' && qe.errorCode === 'BAD_TOKEN' && (await Cred.one('telegram')).status === 'FAILED', [res, qe.errorCode]);
  out = await svc.publish(id.tl, jobC.id, ['telegram'], {});
  Z.check('wrong token: the next post is refused up front (nothing is sent)', out.results[0].mode === 'refused' && /token failed/.test(out.results[0].reason), out.results[0]);
  fake.tg = 'ok';
  await Cred.save('telegram', { username: '@zzdxchannel', password: TG_TOKEN }, id.admin);
  await Cred.requestVerify('telegram', id.admin);
  Z.check('wrong token: an Admin saves it again and the check passes', (await Cred.one('telegram')).status === 'CONNECTED');
  fake.tg = 'notadmin'; fake.log.length = 0;
  out = await svc.publish(id.tl, jobC.id, ['telegram'], {});
  res = await runNext('telegram'); qe = await lastEntry(jobC, 'telegram');
  Z.check('bot not admin: Failed with the right words', res.state === 'FAILED' && qe.errorCode === 'NOT_ADMIN', [res, qe.errorCode]);
  fake.tg = 'ok';
  // the real Telegram can never be reached from a test
  process.env.TL_TELEGRAM_API_BASE = 'https://api.telegram.org';
  out = await svc.publish(id.tl, jobC.id, ['telegram'], {});
  res = await runNext('telegram'); qe = await lastEntry(jobC, 'telegram');
  Z.check('safety: while TL_API_STRICT_LOCAL=1 the real api.telegram.org is refused (HOST_BLOCKED), no request made', res.state === 'FAILED' && qe.errorCode === 'HOST_BLOCKED', [res, qe.errorCode]);
  process.env.TL_TELEGRAM_API_BASE = origin;

  console.log('\n-- Telegram: closing a job');
  fake.log.length = 0;
  await prisma.requirement.update({ where: { id: jobA.id }, data: { status: 'CLOSED' } });
  const cl1 = await Track.onJobClosed(jobA.id, id.tl);
  Z.check('close job: sends NOTHING to Telegram by default (closing note OFF)', cl1.notes === 0 && fake.log.length === 0, [cl1, fake.log.length]);
  await send('PUT', `${DX}/settings`, 'admin', { closingNote: { telegram: true } });
  const cl2 = await Track.onJobClosed(jobA.id, id.tl);
  res = await runNext('telegram');
  const notes = fake.log.filter((x) => x.method === 'sendMessage');
  Z.check('close job: with "post a closing note" ON one closing message is sent, as a reply to the first post', cl2.notes === 1 && res.state === 'SUCCEEDED' && notes.length === 1 && /This job is now closed/.test(notes[0].body.text) && String(notes[0].body.reply_parameters.message_id) === firstId, [cl2, notes]);
  Z.check('close job: the first post is NOT shown as "Taken down" (it is still in the channel)', (await P.get(jobA.id, 'telegram')).status === 'PUBLISHED');
  await send('PUT', `${DX}/settings`, 'admin', { closingNote: { telegram: false } });
  await prisma.requirement.update({ where: { id: jobA.id }, data: { status: 'OPEN' } });

  console.log('\n-- Facebook');
  r = await send('PUT', `${J}/credentials/facebook`, 'tl', { username: FB_PAGE, password: FB_TOKEN });
  Z.check('save: a TL may save the first Facebook details', r.status === 200 && !JSON.stringify(r.body).includes(FB_TOKEN), r.body);
  r = await send('PUT', `${J}/credentials/facebook`, 'tl', { username: '12', password: FB_TOKEN });
  Z.check('save: a TL cannot replace it', r.status === 403);
  fake.log.length = 0;
  v = await Cred.requestVerify('facebook', id.admin);
  Z.check('test connection: reads the page name (GET), posts nothing', v.result.ok && /ZZ DX Jobs Page/.test(v.result.summary) && fake.log.every((x) => x.method === 'GET'), [v.result, fake.log.map((x) => x.method)]);
  fake.fb = 'badtoken'; v = await Cred.requestVerify('facebook', id.admin);
  Z.check('test connection: a token Facebook refuses (190) is named', !v.result.ok && v.result.code === 'BAD_TOKEN', v.result);
  fake.fb = 'nopage'; await Cred.save('facebook', { username: FB_PAGE, password: FB_TOKEN }, id.admin); v = await Cred.requestVerify('facebook', id.admin);
  Z.check('test connection: a page that does not exist is named', v.result.code === 'CHANNEL_NOT_FOUND', v.result);
  fake.fb = 'ok'; await Cred.save('facebook', { username: FB_PAGE, password: FB_TOKEN }, id.admin);
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, ['facebook'], {});
  Z.check('switch OFF: Facebook refuses, nothing sent', out.results[0].mode === 'refused' && fake.log.length === 0, out.results[0]);
  out = await svc.publish(id.tl, jobA.id, ['facebook'], { dryRun: true });
  res = await runNext('facebook'); const fdry = await lastEntry(jobA, 'facebook');
  Z.check('dry run: Facebook builds the post, sends nothing', res.state === 'SUCCEEDED' && fake.log.length === 0 && /src=facebook&utm_source=facebook/.test(fdry.result.note || ''), [res, fdry.result]);
  await Cred.setEnabled('facebook', true, id.admin);
  out = await svc.publish(id.tl, jobA.id, ['facebook'], {});
  res = await runNext('facebook');
  const fp = fake.log.filter((x) => x.method === 'POST' && /\/feed$/.test(x.path));
  Z.check('publish: ONE post to /{page}/feed with the message and ?src=facebook', res.state === 'SUCCEEDED' && fp.length === 1 && fp[0].path === `/v19.0/${FB_PAGE}/feed` && /src=facebook&utm_source=facebook&utm_medium=social/.test(fp[0].body.message) && !/Acme|commission/i.test(fp[0].body.message), [res, fp.length]);
  pp = await P.get(jobA.id, 'facebook');
  Z.check('publish: Posted with the Facebook post id and link', pp.status === 'PUBLISHED' && pp.portalJobId.startsWith(`${FB_PAGE}_`) && /facebook\.com/.test(pp.portalUrl), pp);
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, ['facebook'], {});
  Z.check('idempotent: a second Facebook post is refused ("Already posted")', out.results[0].mode === 'already' && fake.log.length === 0);
  out = await svc.update(id.tl, jobA.id, ['facebook'], {});
  res = await runNext('facebook');
  Z.check('update: "Post update" edits the post (POST /{post-id}), no second post', res.state === 'SUCCEEDED' && fake.log.filter((x) => x.path === `/v19.0/${pp.portalJobId}`).length === 1 && !fake.log.some((x) => /\/feed$/.test(x.path)), fake.log.map((x) => x.path));
  fake.fb = 'perm'; out = await svc.publish(id.tl, jobB.id, ['facebook'], {}); res = await runNext('facebook'); qe = await lastEntry(jobB, 'facebook');
  Z.check('permission: "pages_manage_posts" missing is named', res.state === 'FAILED' && qe.errorCode === 'NOT_ADMIN', [res, qe.errorCode, qe.errorMessage]);
  fake.fb = 'rate'; out = await svc.publish(id.tl, jobC.id, ['facebook'], {}); res = await runNext('facebook'); qe = await lastEntry(jobC, 'facebook');
  Z.check('rate limit: Facebook asks to slow down: back in the queue, RATE_LIMITED', res.state === 'QUEUED' && qe.errorCode === 'RATE_LIMITED', [res, qe.errorCode]);
  fake.fb = 'ok';
  Z.check('safety: real graph.facebook.com is refused while TL_API_STRICT_LOCAL=1', await (async () => {
    process.env.TL_FACEBOOK_GRAPH_BASE = 'https://graph.facebook.com/v19.0';
    out = await svc.publish(id.tl, jobD.id, ['facebook'], {}); res = await runNext('facebook'); qe = await lastEntry(jobD, 'facebook');
    process.env.TL_FACEBOOK_GRAPH_BASE = `${origin}/v19.0`;
    return res.state === 'FAILED' && qe.errorCode === 'HOST_BLOCKED';
  })());

  console.log('\n-- credentials never leak, delete is Admin only');
  const leaks = [];
  const scan = async (label, sql) => { const rowsL = await D.q(sql); const text = JSON.stringify(rowsL); if (text.includes(TG_TOKEN) || text.includes('AAHzzdx') || text.includes(FB_TOKEN) || text.includes('EAAzzdx')) leaks.push(label); };
  await scan('PostingLog', 'SELECT "message" FROM "PostingLog"');
  await scan('PostingQueue', 'SELECT "errorMessage","resultJson","payloadHash","idempotencyKey" FROM "PostingQueue"');
  await scan('AuditLog', 'SELECT "action","fromValue","toValue","reason" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT 3000');
  await scan('Notification', 'SELECT "title","message" FROM "Notification" ORDER BY "createdAt" DESC LIMIT 3000');
  await scan('PortalPosting', 'SELECT "lastError","portalUrl","portalJobId" FROM "PortalPosting"');
  await scan('AppSetting', 'SELECT "key","value" FROM "AppSetting" WHERE "key" LIKE \'jobpublish.%\' OR "key" LIKE \'jobdist.%\'');
  Z.check('no token or channel secret in logs, queue, audit, bell, postings or settings', leaks.length === 0, leaks);
  r = await send('POST', `${J}/credentials/telegram/switch`, 'admin', { enabled: false });
  Z.check('switch: an Admin switches Telegram OFF again', r.status === 200 && r.body.credential.enabled === false);
  r = await Z.call('DELETE', `${J}/credentials/telegram`, tok.admin);
  Z.check('delete: an Admin can delete the saved Telegram details (token gone, switch OFF)', r.status === 200 && r.body.credential.hasLogin === false && (await D.q1('SELECT "passwordEnc" p FROM "PortalCredential" WHERE "portal" = \'telegram\'')).p === null, r.body);
  r = await g(`${J}/diagnostics`, 'admin');
  const dg = (r.body.portals || []).find((p) => p.portal === 'telegram');
  Z.check('diagnostics: Telegram and Facebook appear with their own health', !!dg && dg.kind === 'api' && dg.health && !!(r.body.portals || []).find((p) => p.portal === 'facebook'), dg && dg.health);

  // ===================================================== 10. regression of what already existed
  console.log('\n-- regression');
  r = await g(`${J}/portals`, 'admin');
  Z.check('portals list still has Naukri, Foundit, Shine, LinkedIn, Career page (+ Telegram, Facebook)', ['naukri', 'foundit', 'shine', 'linkedin', 'career', 'telegram', 'facebook'].every((k) => (r.body.portals || []).some((p) => p.portal === k)));
  r = await g(`${J}/jobs/${jobA.id}/status`, 'tl');
  Z.check('job status still lists every site and Telegram/Facebook read honestly', r.status === 200 && r.body.portals.find((p) => p.portal === 'telegram').status === 'PUBLISHED' && r.body.portals.find((p) => p.portal === 'naukri').status === 'DRAFT', r.body.portals && r.body.portals.map((p) => `${p.portal}:${p.status}`));
  r = await send('POST', `${J}/jobs/${jobA.id}/publish`, 'rec', { portals: ['telegram'] });
  Z.check('gate: a Recruiter cannot post to Telegram (403)', r.status === 403);
  r = await send('POST', `${J}/jobs/${jobA.id}/publish`, 'mgr', { portals: ['facebook'] });
  Z.check('gate: a Manager cannot post to Facebook (403)', r.status === 403);

  // ===================================================== cleanup
  console.log('\n-- cleanup');
  await cleanRows(Z.made.reqs, Z.made.users);
  await D.ex('DELETE FROM "DistPlatform" WHERE "key" = ?', customKey).catch(() => {});
  await prisma.task.deleteMany({ where: { name: { contains: 'ZZTEST DX' } } }).catch(() => {});
  await prisma.syncLog.deleteMany({ where: { OR: [{ reason: { contains: 'ZZTEST DX' } }, { recordRef: { in: Z.made.apps } }] } }).catch(() => {});
  await prisma.candidateConsent && prisma.candidateConsent.deleteMany({ where: { candidateId: { in: Z.made.cands } } }).catch(() => {});
  await S.setLimits(null, { globalConcurrency: null, minGapSeconds: null, maxGapSeconds: null, perHour: null, perDay: null, maxAttempts: null }).catch(() => {});
  await prisma.appSetting.deleteMany({ where: { key: { in: ZZ_SETTING_KEYS } } }).catch(() => {});
  const left = await Z.cleanup();
  server.close();
  console.log('cleanup left', JSON.stringify(left));
  Z.check('cleanup: no ZZTEST DX rows left', Object.values(left).every((n) => n === 0), left);
  await Z.finish();
})().catch(async (e) => {
  console.error('TEST CRASHED', e);
  try { await cleanRows(Z.made.reqs, Z.made.users); await D.ex('DELETE FROM "DistPlatform" WHERE "key" = \'zztestdxlocalboard\''); await Z.cleanup(); } catch { /* */ }
  process.exit(1);
});
