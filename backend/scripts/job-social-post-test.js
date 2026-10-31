// ---------------------------------------------------------------------------
// JOB POSTS TO SOCIAL MEDIA: acceptance test (2026-10-31). "Post job" also goes to Instagram, Threads and LinkedIn (Facebook already did).
// SANDBOX ONLY. NOTHING real is ever called: Facebook / Instagram / Threads / LinkedIn are ONE local fake HTTP server on port 4598.
//   1. start a sandbox API with the fake's addresses (TL_FACEBOOK_GRAPH_BASE, TL_THREADS_GRAPH_BASE, TL_LINKEDIN_AUTH_BASE, TL_LINKEDIN_API_BASE
//      all = http://127.0.0.1:4598 ..., TEST_MOCK_PORTS=4598, TL_API_STRICT_LOCAL=1, TEST_MODE=1) on a sandbox port, for example 4012
//   2. TL_API=http://localhost:4012 node scripts/job-social-post-test.js      (same env for this script)
// Tag "ZZTEST SP". The social account list and the LinkedIn app details of the sandbox copy are put back as they were.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const http = require('http');
const path = require('path');
if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4012';
const Z = require('./lib/zzfix')('SP');
const { BACK, prisma } = Z;

const FAKE = 'http://127.0.0.1:4598';
process.env.TL_API_STRICT_LOCAL = '1';
process.env.TL_FACEBOOK_GRAPH_BASE = `${FAKE}/v19.0`;
process.env.TL_THREADS_GRAPH_BASE = `${FAKE}/threads/v1.0`;
process.env.TL_LINKEDIN_AUTH_BASE = FAKE;
process.env.TL_LINKEDIN_API_BASE = FAKE;
process.env.APP_BASE_URL = 'https://jobs.zzsp.example.test';
const D = require(path.join(BACK, 'src/jobPublish/db'));
const Q = require(path.join(BACK, 'src/jobPublish/queue'));
const S = require(path.join(BACK, 'src/jobPublish/settings'));
const Cred = require(path.join(BACK, 'src/jobPublish/credentials'));
const P = require(path.join(BACK, 'src/jobPublish/portalPosting'));
const runner = require(path.join(BACK, 'src/jobPublish/runner'));
const svc = require(path.join(BACK, 'src/jobPublish/service'));
const Plat = require(path.join(BACK, 'src/jobDist/platforms'));
const SA = require(path.join(BACK, 'src/utils/socialAccounts'));
const Post = require(path.join(BACK, 'src/utils/socialPosting'));
const Card = require(path.join(BACK, 'src/utils/jobCard'));
const LI = require(path.join(BACK, 'src/portals/linkedinpost/LinkedInPostAdapter'));
const J = '/api/job-publish';
const A = '/api/admin/social-accounts';

const PAGE_TOKEN = 'EAAzzspFAKEpageTOKENfakefakefakefakefake1234567890';
const TH_TOKEN = 'THAAzzspFAKEthreadsTOKENfakefakefake1234567890abc';
const LI_TOKEN = 'AQXzzspFAKElinkedinTOKENfakefakefake-1234567890_abc';
const PAGE = '104820934501234';
const IG = '17841400000000001';
const TH = '99887766554433';
const fake = { log: [], ig: 'ok', li: 'ok', nextId: 700 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(obj === null ? '' : JSON.stringify(obj)); };
    const params = req.method === 'GET' ? Object.fromEntries(u.searchParams) : (/json/.test(req.headers['content-type'] || '') ? (body ? JSON.parse(body) : {}) : Object.fromEntries(new URLSearchParams(body)));
    // ---- LinkedIn
    if (u.pathname === '/oauth/v2/accessToken') { fake.log.push({ kind: 'li-token', body: params }); return params.code === 'bad' ? send(400, { error: 'invalid_request', error_description: 'The provided authorization grant is invalid' }) : send(200, { access_token: LI_TOKEN, expires_in: 5184000, scope: 'openid,profile,w_member_social' }); }
    if (u.pathname === '/v2/userinfo') { fake.log.push({ kind: 'li-userinfo', auth: req.headers.authorization }); return req.headers.authorization === `Bearer ${LI_TOKEN}` && fake.li !== 'badtoken' ? send(200, { sub: 'ZZsub123', name: 'ZZ Poster' }) : send(401, { message: 'Invalid access token', status: 401 }); }
    if (u.pathname === '/rest/posts' && req.method === 'POST') {
      fake.log.push({ kind: 'li-post', body: params, headers: req.headers });
      if (req.headers.authorization !== `Bearer ${LI_TOKEN}` || fake.li === 'badtoken') return send(401, { message: 'Invalid access token', status: 401 });
      if (fake.li === 'forbidden') return send(403, { message: 'Not enough permissions to access: partnerApiPostsExternal.CREATE.NO_VERSION', status: 403 });
      if (fake.li === 'rate') return send(429, { message: 'Too many requests', status: 429 }, { 'Retry-After': '9' });
      fake.nextId += 1;
      return send(201, null, { 'x-restli-id': `urn:li:share:${fake.nextId}` });
    }
    let m = /^\/rest\/posts\/(.+)$/.exec(u.pathname);
    if (m && req.method === 'POST') { fake.log.push({ kind: 'li-patch', urn: decodeURIComponent(m[1]), body: params, headers: req.headers }); return send(204, null); }
    // ---- Threads
    m = /^\/threads\/v1\.0\/([^/]+)(?:\/(threads|threads_publish))?$/.exec(u.pathname);
    if (m) {
      fake.log.push({ kind: 'th', method: req.method, path: u.pathname, body: params });
      if (params.access_token !== TH_TOKEN) return send(400, { error: { message: 'Invalid OAuth access token.', code: 190 } });
      if (m[1] === 'me') return send(200, { id: TH, username: 'zz_threads' });
      if (!m[2]) return send(200, { id: m[1], username: 'zz_threads', permalink: 'https://www.threads.net/@zz_threads/post/ABC' });
      fake.nextId += 1;
      return send(200, { id: m[2] === 'threads' ? `TC${fake.nextId}` : `TP${fake.nextId}` });
    }
    // ---- Facebook / Instagram
    m = /^\/v19\.0\/([^/]+)(?:\/(feed|media|media_publish))?$/.exec(u.pathname);
    if (m) {
      fake.log.push({ kind: 'fb', method: req.method, path: u.pathname, body: params });
      if (params.access_token !== PAGE_TOKEN) return send(400, { error: { message: 'Invalid OAuth access token.', code: 190 } });
      if (/instagram_business_account/.test(params.fields || '')) return send(200, { instagram_business_account: { id: IG, username: 'zz_ig', name: 'ZZ Instagram' }, id: m[1] });
      if (m[1] === IG && !m[2]) return send(200, { id: IG, username: 'zz_ig' });
      if (m[2] === 'media') {
        if (fake.ig === 'noimage') return send(400, { error: { message: 'Only photo or video can be accepted as media type. (Media download has failed: the image_url could not be fetched)', code: 9004 } });
        if (fake.ig === 'perm') return send(403, { error: { message: '(#10) Application does not have permission for this action', code: 10 } });
        fake.nextId += 1; return send(200, { id: `IC${fake.nextId}` });
      }
      if (m[2] === 'media_publish') { fake.nextId += 1; return send(200, { id: `IM${fake.nextId}` }); }
      if (/^IC/.test(m[1])) return send(200, { status_code: 'FINISHED', id: m[1] });
      if (/^IM/.test(m[1])) return send(200, { permalink: `https://www.instagram.com/p/${m[1]}/`, id: m[1] });
      if (m[1] === PAGE) return send(200, { id: PAGE, name: 'ZZ SP Page' });
      return send(200, { id: m[1] });
    }
    return send(404, { error: 'unknown' });
  });
});

const runNext = async (portal) => { const { entry } = await Q.claim({ workerId: 'sp-test', onlyPortals: [portal] }); return entry ? runner.processEntry(entry, { workerId: 'sp-test' }) : null; };
const lastEntry = async (job, portal) => Q.shape((await D.q('SELECT * FROM "PostingQueue" WHERE "requirementId" = ? AND "portal" = ? ORDER BY "createdAt" DESC', job.id, portal))[0]);
const SOCIAL = ['instagram', 'threads', 'linkedinpost'];
const keep = {};
let wipeAndRestore = async () => {};

(async () => {
  console.log('preclean', JSON.stringify(await Z.preclean()));
  await new Promise((r) => server.listen(4598, '127.0.0.1', r));
  for (const k of ['social.accounts', 'social.linkedin.app']) { const row = await prisma.appSetting.findUnique({ where: { key: k } }); keep[k] = row ? row.value : null; }
  const wipe = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: ['social.accounts', 'social.linkedin.app'] } } });
    for (const p of SOCIAL) { await D.ex('DELETE FROM "PortalCredential" WHERE "portal" = ?', p).catch(() => {}); await prisma.appSetting.deleteMany({ where: { key: { in: [`jobpublish.portal.${p}.lastTest`, `jobpublish.portal.${p}.kill`] } } }); }
  };
  await wipe();
  // making a Threads profile the default writes the Social Media card (what Omni-Channel reads): put that back too
  const integ = await prisma.integration.findUnique({ where: { id: 'social' } });
  wipeAndRestore = async () => {
    await wipe();
    for (const [k, v] of Object.entries(keep)) if (v !== null) await prisma.appSetting.create({ data: { key: k, value: v } });
    if (integ) await prisma.integration.update({ where: { id: 'social' }, data: { values: integ.values, state: integ.state, connected: integ.connected } });
    else await prisma.integration.deleteMany({ where: { id: 'social' } });
  };

  const admin = await Z.mkUser('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', hrmsAccess: true });
  const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
  const tok = { admin: await Z.mint(admin), tl: await Z.mint(tl), rec: await Z.mint(rec) };
  const id = { admin: await Z.identity(admin), tl: await Z.identity(tl) };
  const client = await prisma.client.create({ data: { name: 'ZZTEST SP Client Acme Ltd', status: 'Active' } });
  Z.made.clients.push(client.id);
  const mkJob = async (title, extra = {}) => {
    const r = await prisma.requirement.create({
      data: {
        title, clientId: client.id, department: 'Education', status: 'OPEN', tlId: tl.id, bdeId: bde.id, recruiterId: rec.id, location: 'Hyderabad', experience: '2-6', skills: 'Physics, Teaching, Research',
        salary: '8-12 LPA', education: 'MSc', openings: 2, employmentType: 'Full Time', portalPublished: true, portalPublishedAt: new Date(),
        jobDescription: 'ZZTEST SP Client Acme Ltd needs a lecturer to teach physics to degree students in Hyderabad.\nOur service fee is 8.33% commission on the annual CTC.\nThe agreement is signed and the invoice goes monthly.',
        ...extra,
      },
    });
    Z.made.reqs.push(r.id);
    return r;
  };
  const jobA = await mkJob('ZZTEST SP Physics Lecturer', { reqCode: 'ZZSP-90001' });
  const jobB = await mkJob('ZZTEST SP Chemistry Lecturer', { reqCode: 'ZZSP-90002' });
  const jobC = await mkJob('ZZTEST SP Maths Lecturer', { reqCode: 'ZZSP-90003' });
  const jobClosed = await mkJob('ZZTEST SP Closed Lecturer', { reqCode: 'ZZSP-90004', status: 'CLOSED' });
  const jobInternal = await mkJob('ZZTEST SP Internal Recruiter', { reqCode: 'ZZSP-90005', internal: true, tlId: null, bdeId: null, recruiterId: null });
  const g = (p, t) => Z.call('GET', p, tok[t]);
  const send = (m, p, t, b) => Z.call(m, p, tok[t], m === 'GET' ? undefined : (b === undefined ? {} : b));
  await S.setLimits(null, { globalConcurrency: 10, minGapSeconds: 0, maxGapSeconds: 0, perHour: 0, perDay: 0, maxAttempts: 3 });

  // ===================================================== 1. the places exist
  console.log('\n-- the places');
  let r = await g('/api/job-dist/platforms', 'tl');
  const pl = (k) => (r.body.platforms || []).find((p) => p.key === k);
  Z.check('job-dist list has Instagram, Threads and LinkedIn post: automatic, social, short message', ['instagram', 'threads', 'linkedinpost'].every((k) => pl(k) && pl(k).kind === 'auto' && pl(k).medium === 'social' && pl(k).format === 'short' && pl(k).engine === k), (r.body.platforms || []).map((p) => p.key));
  Z.check('limits: Instagram 2200, Threads 500, LinkedIn 3000 characters', pl('instagram').maxChars === 2200 && pl('threads').maxChars === 500 && pl('linkedinpost').maxChars === 3000);
  r = await g(`${J}/portals`, 'admin');
  Z.check('job-publish portals list has the three, as token (api) places', SOCIAL.every((k) => (r.body.portals || []).some((p) => p.portal === k && p.kind === 'api')), (r.body.portals || []).map((p) => `${p.portal}:${p.kind}`));
  r = await send('PUT', `${J}/credentials/instagram`, 'admin', { username: 'abc', password: 'x' });
  Z.check('format check: a malformed Instagram number / token is refused in plain words', r.status === 400 && /number|token/i.test(r.body.error), r.body);

  // ===================================================== 2. Facebook Pages -> Instagram; Threads -> default -> job-posting connections
  console.log('\n-- Instagram and Threads from the Social Media list');
  const fb = await SA.addFacebookPages(admin, [{ id: PAGE, name: 'ZZ SP Page', token: PAGE_TOKEN }]);
  Z.check('the Page brings its Instagram account (default)', fb.instagram.length === 1 && fb.instagram[0].externalId === IG && fb.instagram[0].isDefault, fb);
  let m = await Post.mirror(id.admin);
  let ig = await Cred.one('instagram');
  Z.check('mirror: Instagram connection saved from the default account and checked (Connected)', m.some((x) => x.portal === 'instagram' && x.change === 'saved' && x.ok) && ig.hasLogin && ig.status === 'CONNECTED' && ig.enabled === false, [m, ig.status]);
  Z.check('mirror: the posting switch is NOT turned on by it', ig.enabled === false);
  const th = await SA.addThreads(admin, TH_TOKEN);
  Z.check('Threads token accepted by Threads (me)', th.ok && th.account.externalId === TH, th);
  await SA.setDefault(admin, th.account.id, {});
  m = await Post.mirror(id.admin);
  const thc = await Cred.one('threads');
  Z.check('mirror: Threads connection saved and checked', thc.hasLogin && thc.status === 'CONNECTED' && thc.enabled === false, [m, thc.status]);
  m = await Post.mirror(id.admin);
  Z.check('mirror: nothing changed -> nothing re-saved', m.length === 0, m);
  const everything = [(await g(`${J}/credentials`, 'admin')).text, (await g(`${J}/portals`, 'tl')).text, (await g(`${J}/portals`, 'admin')).text, (await g(`${A}`, 'admin')).text];
  Z.check('NO answer holds a token', everything.every((t) => ![PAGE_TOKEN, TH_TOKEN, 'zzspFAKE'].some((x) => t.includes(x))));

  // ===================================================== 3. LinkedIn: app details -> Connect -> callback
  console.log('\n-- LinkedIn connect');
  r = await send('POST', `${A}/linkedin/start`, 'admin', {});
  Z.check('start without the app details: told to type them', r.status === 400 && /Client ID/i.test(r.body.error), r.body);
  r = await send('PUT', `${A}/linkedin/app`, 'admin', { clientId: 'zzspclient1', clientSecret: 'zzsp-secret-value-123' });
  Z.check('app details saved; the answer shows the redirect address and never the secret', r.status === 200 && r.body.hasApp && /\/api\/public\/linkedin-connect\/callback$/.test(r.body.redirectUri) && !JSON.stringify(r.body).includes('zzsp-secret'), r.body);
  r = await send('GET', `${A}/linkedin/app`, 'tl');
  Z.check('a TL cannot read or change the LinkedIn app (403)', r.status === 403, r.status);
  r = await send('POST', `${A}/linkedin/start`, 'admin', { pageId: 'abc' });
  Z.check('a Company Page number must be digits', r.status === 400, r.body);
  r = await send('POST', `${A}/linkedin/start`, 'admin', {});
  const url1 = r.body.url && new URL(r.body.url);
  Z.check('start: LinkedIn login address with client id, redirect, state and ONLY profile scopes', r.status === 200 && url1.searchParams.get('client_id') === 'zzspclient1' && url1.searchParams.get('scope') === 'openid profile w_member_social' && url1.searchParams.get('state'), r.body);
  const state1 = url1.searchParams.get('state');
  let cb = await Z.call('GET', '/api/public/linkedin-connect/callback?code=x&state=garbage', null);
  Z.check('a callback with a bad state is refused (400)', cb.status === 400, cb.status);
  cb = await Z.call('GET', `/api/public/linkedin-connect/callback?error=user_cancelled_authorize&state=${encodeURIComponent(state1)}`, null);
  Z.check('LinkedIn sign-in cancelled -> back with linkedin=denied', cb.status === 302 && /linkedin=denied/.test(cb.headers.get('location')), cb.headers.get('location'));
  cb = await Z.call('GET', `/api/public/linkedin-connect/callback?code=bad&state=${encodeURIComponent(state1)}`, null);
  Z.check('LinkedIn refuses the code -> linkedin=failed with its words', cb.status === 302 && /linkedin=failed/.test(cb.headers.get('location')) && /grant%20is%20invalid/i.test(cb.headers.get('location')), cb.headers.get('location'));
  cb = await Z.call('GET', `/api/public/linkedin-connect/callback?code=ok&state=${encodeURIComponent(state1)}`, null);
  const back = cb.headers.get('location') || '';
  Z.check('good sign-in -> back to Social Media > LinkedIn (linkedin=connected), no token in the address', cb.status === 302 && /sub=linkedin&linkedin=connected/.test(back) && !back.includes(LI_TOKEN), back);
  r = await g(A, 'admin');
  const li1 = r.body.accounts.linkedin;
  Z.check('the profile is in the list, default, with the 60-day expiry', li1.length === 1 && li1[0].externalId === 'urn:li:person:ZZsub123' && li1[0].isDefault && li1[0].status === 'Connected' && Date.parse(li1[0].expiresAt) > Date.now() + 50 * 86400000, li1);
  await new Promise((ok) => { setTimeout(ok, 1500); });
  const lic = await Cred.one('linkedinpost');
  Z.check('the job-posting connection for LinkedIn was saved and checked by itself', lic.hasLogin && lic.status === 'CONNECTED' && lic.enabled === false, lic);
  r = await send('POST', `${A}/linkedin/start`, 'admin', { pageId: '12345678' });
  const url2 = new URL(r.body.url);
  Z.check('with a Company Page number the scope adds w_organization_social', url2.searchParams.get('scope') === 'openid profile w_member_social w_organization_social', url2.searchParams.get('scope'));
  cb = await Z.call('GET', `/api/public/linkedin-connect/callback?code=ok&state=${encodeURIComponent(url2.searchParams.get('state'))}`, null);
  r = await g(A, 'admin');
  const li2 = r.body.accounts.linkedin;
  Z.check('the Company Page is listed too (kept with its profile); the default did not move', li2.length === 2 && li2.some((a) => a.externalId === 'urn:li:organization:12345678' && a.parentId === 'urn:li:person:ZZsub123') && li2.find((a) => a.isDefault).externalId === 'urn:li:person:ZZsub123', li2);
  const orgAcc = li2.find((a) => a.kind === 'page');
  r = await send('POST', `${A}/${orgAcc.id}/default`, 'admin');
  await new Promise((ok) => { setTimeout(ok, 1500); });
  const lic2 = await Cred.read('linkedinpost');
  Z.check('making the Page the default moves the LinkedIn job-posting connection to it', r.status === 200 && lic2.ok && lic2.username === 'urn:li:organization:12345678', [r.status, lic2.username]);
  r = await send('POST', `${A}/${li1[0].id}/default`, 'admin');
  await new Promise((ok) => { setTimeout(ok, 1500); });
  Z.check('and back to the profile', r.status === 200 && (await Cred.read('linkedinpost')).username === 'urn:li:person:ZZsub123');

  // ===================================================== 4. posting: gate, dry run, real, idempotent
  console.log('\n-- posting');
  let out = await svc.publish(id.tl, jobA.id, SOCIAL, {});
  Z.check('switch OFF: all three refuse, nothing sent', out.results.every((x) => x.mode === 'refused') && !fake.log.some((x) => ['li-post'].includes(x.kind) || /media_publish|threads_publish/.test(x.path || '')), out.results.map((x) => `${x.portal}:${x.mode}`));
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, SOCIAL, { dryRun: true });
  for (const p of SOCIAL) await runNext(p);
  const dry = await lastEntry(jobA, 'instagram');
  Z.check('dry run: the messages are built, NOTHING was sent', fake.log.length === 0 && /src=instagram&utm_source=instagram/.test((dry.result && dry.result.note) || ''), [fake.log.length, dry.result]);
  for (const p of SOCIAL) await Cred.setEnabled(p, true, id.admin);
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, SOCIAL, {});
  const rs = {};
  for (const p of SOCIAL) rs[p] = await runNext(p);
  Z.check('publish: all three queued and SUCCEEDED', SOCIAL.every((p) => rs[p] && rs[p].state === 'SUCCEEDED'), rs);
  const mediaCall = fake.log.find((x) => /\/media$/.test(x.path || ''));
  Z.check('Instagram: media created with the job-card picture of THIS job and the caption', mediaCall && mediaCall.body.image_url === `https://jobs.zzsp.example.test/api/public/job-card/${jobA.id}.jpg` && /src=instagram&utm_source=instagram&utm_medium=social/.test(mediaCall.body.caption), mediaCall);
  Z.check('Instagram: the picture was PUBLISHED after it was created (media_publish with the creation id)', fake.log.some((x) => /\/media_publish$/.test(x.path || '') && /^IC/.test(x.body.creation_id)));
  const caption = mediaCall ? mediaCall.body.caption : '';
  Z.check('Instagram caption never names the client, the fee or the agreement', !/Acme|commission|agreement|invoice|8\.33/i.test(caption), caption);
  const thPosts = fake.log.filter((x) => x.kind === 'th' && /\/threads$/.test(x.path));
  Z.check('Threads: ONE text post (media_type TEXT), then published, within 500 characters, link tagged src=threads', thPosts.length === 1 && thPosts[0].body.media_type === 'TEXT' && thPosts[0].body.text.length <= 500 && /src=threads&utm_source=threads/.test(thPosts[0].body.text) && fake.log.some((x) => /threads_publish$/.test(x.path || '')), thPosts);
  const liPost = fake.log.find((x) => x.kind === 'li-post');
  Z.check('LinkedIn: ONE post with author, PUBLIC, PUBLISHED, Bearer token and the LinkedIn-Version header', liPost && liPost.body.author === 'urn:li:person:ZZsub123' && liPost.body.visibility === 'PUBLIC' && liPost.body.lifecycleState === 'PUBLISHED' && liPost.headers.authorization === `Bearer ${LI_TOKEN}` && /^\d{6}$/.test(liPost.headers['linkedin-version']) && liPost.headers['x-restli-protocol-version'] === '2.0.0', liPost && { b: liPost.body, h: liPost.headers['linkedin-version'] });
  Z.check('LinkedIn: the tracked web address is left intact and the text has no client / fee', liPost && liPost.body.commentary.includes('?src=linkedinpost&utm_source=linkedinpost&utm_medium=social') && !/Acme|commission|agreement/i.test(liPost.body.commentary), liPost && liPost.body.commentary);
  for (const p of SOCIAL) {
    const pp = await P.get(jobA.id, p);
    Z.check(`${p}: Posted with the post id and a link`, pp && pp.status === 'PUBLISHED' && pp.portalJobId && /^https:\/\//.test(pp.portalUrl || ''), pp);
  }
  fake.log.length = 0;
  out = await svc.publish(id.tl, jobA.id, SOCIAL, {});
  Z.check('idempotent: a second post of the same job is refused ("Already posted"), nothing sent', out.results.every((x) => x.mode === 'already') && fake.log.length === 0, out.results.map((x) => `${x.portal}:${x.mode}`));
  out = await svc.update(id.tl, jobA.id, ['instagram', 'threads'], {});
  Z.check('update: Instagram and Threads say plainly that a post cannot be changed', out.results.every((x) => x.mode === 'refused' && /does not let a program change/.test(x.reason)), out.results);
  out = await svc.update(id.tl, jobA.id, ['linkedinpost'], {});
  const upd = await runNext('linkedinpost');
  const patch = fake.log.find((x) => x.kind === 'li-patch');
  Z.check('update: LinkedIn changes the existing post (PARTIAL_UPDATE, $set commentary)', upd && upd.state === 'SUCCEEDED' && patch && patch.headers['x-restli-method'] === 'PARTIAL_UPDATE' && patch.body.patch && patch.body.patch.$set.commentary && /^urn:li:share:/.test(patch.urn), [upd, patch]);
  Z.check('LinkedIn text escaping: reserved characters become plain text, web addresses and # stay', LI.escapeLittleText('A_B (x) #Hiring https://a.example/p_q?x=1~2') === 'A\\_B \\(x\\) #Hiring https://a.example/p_q?x=1~2', LI.escapeLittleText('A_B (x) #Hiring https://a.example/p_q?x=1~2'));

  // ===================================================== 5. honest failures
  console.log('\n-- failures are said in words');
  fake.ig = 'noimage'; out = await svc.publish(id.tl, jobB.id, ['instagram'], {}); let res = await runNext('instagram'); let qe = await lastEntry(jobB, 'instagram');
  Z.check('Instagram cannot fetch the picture: failed, says the website address must be public, NOT marked Posted', res.state !== 'SUCCEEDED' && /public/i.test(JSON.stringify(qe)) && !(await P.get(jobB.id, 'instagram') || {}).portalJobId, [res, qe.error]);
  fake.ig = 'perm'; out = await svc.publish(id.tl, jobC.id, ['instagram'], {}); res = await runNext('instagram'); qe = await lastEntry(jobC, 'instagram');
  Z.check('Instagram permission missing is named (not allowed to post)', res.state !== 'SUCCEEDED' && /not allowed to post|permission/i.test(JSON.stringify(qe)), qe);
  fake.ig = 'ok'; fake.li = 'badtoken'; out = await svc.publish(id.tl, jobB.id, ['linkedinpost'], {}); res = await runNext('linkedinpost'); qe = await lastEntry(jobB, 'linkedinpost');
  Z.check('LinkedIn token expired: says it lasts 60 days and to connect again; the connection is marked Failed', res.state !== 'SUCCEEDED' && /60 days|Connect LinkedIn again/i.test(JSON.stringify(qe)) && (await Cred.one('linkedinpost')).status === 'FAILED', [res, qe]);
  fake.li = 'ok';
  const postsBefore = fake.log.filter((x) => x.kind === 'li-post').length;
  const v = await Cred.requestVerify('linkedinpost', id.admin);
  Z.check('Test connection reads who the token belongs to and posts nothing', v.result.ok && /ZZ Poster/.test(v.result.summary) && fake.log.filter((x) => x.kind === 'li-post').length === postsBefore, v.result);
  fake.li = 'forbidden'; await Cred.setEnabled('linkedinpost', true, id.admin).catch(() => {});
  out = await svc.publish(id.tl, jobC.id, ['linkedinpost'], {}); res = await runNext('linkedinpost'); qe = await lastEntry(jobC, 'linkedinpost');
  Z.check('LinkedIn 403 is named (not allowed), never "Posted"', res.state !== 'SUCCEEDED' && /not allow/i.test(JSON.stringify(qe)) && !(await P.get(jobC.id, 'linkedinpost') || {}).portalJobId, qe);
  fake.li = 'ok';

  // ===================================================== 6. the job picture
  console.log('\n-- the job picture');
  r = await Z.call('GET', `/api/public/job-card/${jobA.id}.jpg`, null);
  const sharp = require(path.join(BACK, 'node_modules/sharp'));
  const meta = r.status === 200 ? await sharp(r.buf).metadata() : null;
  Z.check('GET job-card: a 1080x1080 JPEG, public (no login)', r.status === 200 && /image\/jpeg/.test(r.headers.get('content-type')) && meta && meta.width === 1080 && meta.height === 1080 && meta.format === 'jpeg', [r.status, meta]);
  r = await Z.call('GET', `/api/public/job-card/${jobClosed.id}.jpg`, null);
  Z.check('a closed job has no public picture (404)', r.status === 404, r.status);
  r = await Z.call('GET', `/api/public/job-card/${jobInternal.id}.jpg`, null);
  Z.check('an internal job has no public picture (404)', r.status === 404, r.status);
  r = await Z.call('GET', '/api/public/job-card/doesnotexist.jpg', null);
  Z.check('an unknown job has no picture (404)', r.status === 404, r.status);
  const svg = Card.svgOf({ title: 'ZZTEST SP Physics Lecturer', location: 'Hyderabad', experience: '2-6 years', salary: '8-12 LPA', skills: ['Physics'] }, { company: 'TeamLink Consultants', apply: 'jobs.example.test/careers', salary: false });
  Z.check('the picture text carries the title and place, hides the pay unless asked, and has no client / fee', /Physics/.test(svg) && /Lecturer/.test(svg) && /Hyderabad/.test(svg) && !/LPA/.test(svg) && !/Acme|commission/i.test(svg));
  const bad = Card.svgOf({ title: 'A <b>&"quote"</b>' }, {});
  Z.check('markup in a title cannot break the picture (escaped)', !/<b>/.test(bad) && /&lt;b&gt;/.test(bad));

  // ===================================================== 7. disconnect
  console.log('\n-- disconnect');
  r = await g(A, 'admin');
  const igAcc = r.body.accounts.instagram[0];
  r = await send('POST', `${A}/${igAcc.id}/remove`, 'admin');
  await new Promise((ok) => { setTimeout(ok, 1500); });
  Z.check('removing the default Instagram account removes the Instagram job-posting connection (posting stops)', r.status === 200 && (await Cred.one('instagram')).hasLogin === false, [r.status, (await Cred.one('instagram')).hasLogin]);
  out = await svc.publish(id.tl, jobB.id, ['instagram'], {});
  Z.check('and a new Instagram post is refused in words', out.results[0].mode === 'refused', out.results[0]);
  r = await send('POST', `${J}/jobs/${jobA.id}/publish`, 'rec', { portals: ['instagram'] });
  Z.check('gate: a Recruiter cannot post to Instagram (403)', r.status === 403, r.status);

  // ===================================================== cleanup
  console.log('\n-- cleanup');
  for (const t of Z.made.reqs) { await D.ex('DELETE FROM "PostingLog" WHERE "requirementId" = ?', t).catch(() => {}); await D.ex('DELETE FROM "PostingQueue" WHERE "requirementId" = ?', t).catch(() => {}); await D.ex('DELETE FROM "PortalPosting" WHERE "requirementId" = ?', t).catch(() => {}); await D.ex('DELETE FROM "DistPosting" WHERE "requirementId" = ?', t).catch(() => {}); await prisma.appSetting.deleteMany({ where: { key: `jobdist.text.${t}` } }).catch(() => {}); }
  await D.ex('DELETE FROM "PostingLog" WHERE "queueId" IS NULL AND "portal" IN (\'instagram\',\'threads\',\'linkedinpost\')').catch(() => {});
  await wipeAndRestore();
  await S.setLimits(null, { globalConcurrency: null, minGapSeconds: null, maxGapSeconds: null, perHour: null, perDay: null, maxAttempts: null }).catch(() => {});
  const left = await Z.cleanup();
  server.close();
  Z.check('cleanup: no ZZTEST SP rows left', Object.values(left).every((n) => n === 0), left);
  await Z.finish();
})().catch(async (e) => {
  console.error('TEST CRASHED', e);
  try { await wipeAndRestore(); await Z.cleanup(); } catch { /* */ }
  process.exit(1);
});
