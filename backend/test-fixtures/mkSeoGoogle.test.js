// AI Marketing > SEO assistant, phase 2: Google Search Console and Analytics 4 with a service account (googleAuth.js, seoGoogle.js).
//   node backend/test-fixtures/mkSeoGoogle.test.js     (throw-away copy of prisma/sandbox.db; GOOGLE IS A STAND-IN: the stand-in checks the signed sign-in statement with the public key; nothing real is called, nothing is sent)
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-seo-google-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.INTEGRATION_SECRET_KEY = 'test-secret-for-the-google-seo-card-0123456789'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const GA = require(`${M}googleAuth`); const Google = require(`${M}seoGoogle`); const Sites = require(`${M}seoSites`); const Kw = require(`${M}seoKeywords`); const Dash = require(`${M}seoDashboard`); const Sched = require(`${M}seoSchedule`); const Ev = require(`${M}seoEvents`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const restricted = { id: 'u-restricted', name: 'Recruiter', role: 'RECRUITER', atsRole: 'RECRUITER', department: 'Recruitment' };
const DAY = 86400000;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const EMAIL = 'seo-reader@teamlink-test.iam.gserviceaccount.com';
const KEY = JSON.stringify({ type: 'service_account', project_id: 'teamlink-test', private_key_id: 'abc', private_key: privateKey, client_email: EMAIL, token_uri: 'https://evil.example/token' });

// ---- Google, as a stand-in --------------------------------------------------------------------------------------------------------------------------------------
const g = { tokenCalls: 0, calls: [], assertions: [], mode: {} };
const json = (status, body) => ({ status, json: async () => body });
const gfetch = async (url, init = {}) => {
  const body = init.body ? (String(init.body).startsWith('{') ? JSON.parse(init.body) : String(init.body)) : null; g.calls.push({ url, method: init.method || 'GET', body, auth: init.headers && init.headers.authorization });
  if (url === GA.TOKEN_URL) {
    g.tokenCalls += 1; if (g.mode.net) throw new Error('offline'); if (g.mode.tokenStatus) return json(g.mode.tokenStatus, g.mode.tokenBody || {});
    const p = new URLSearchParams(body); assert.equal(p.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer'); const [h, c, sig] = p.get('assertion').split('.'); g.assertions.push({ head: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')), valid: crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')) });
    return json(200, { access_token: `tok-${g.tokenCalls}`, expires_in: 3600, token_type: 'Bearer' });
  }
  if (!/^Bearer tok-\d+$/.test(g.calls[g.calls.length - 1].auth || '')) return json(401, { error: { message: 'no token' } });
  if (g.mode.http) return json(g.mode.http, g.mode.httpBody || { error: { message: 'x' } });
  let m;
  if (url === 'https://www.googleapis.com/webmasters/v3/sites') return json(200, { siteEntry: [{ siteUrl: 'https://www.sri.test/', permissionLevel: 'siteFullUser' }, { siteUrl: 'sc-domain:sri.test', permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'https://other.test/', permissionLevel: 'siteUnverifiedUser' }] });
  if ((m = /\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url))) {
    if (decodeURIComponent(m[1]) === 'sc-domain:nobody.test') return json(403, { error: { message: 'User does not have sufficient permission for site' } });
    if (decodeURIComponent(m[1]) === 'sc-domain:gone.test') return json(404, { error: { message: 'not found' } });
    const dims = body.dimensions || []; const before = body.startDate < g.mode.splitDate; const drop = g.mode.drop;
    if (!dims.length) return json(200, { rows: [{ clicks: before ? 100 : (drop ? 40 : 160), impressions: before ? 3000 : 4000, ctr: before ? 0.0333 : 0.04, position: before ? 14.26 : 12.04 }] });
    if (dims[0] === 'date') return json(200, { rows: [{ keys: ['2026-11-03'], clicks: 5, impressions: 120 }, { keys: ['2026-11-01'], clicks: 3, impressions: 100 }, { keys: ['2026-11-02'], clicks: 9, impressions: 150 }] });
    return json(200, { rows: [{ keys: ['dental implants in hyderabad'], clicks: 12, impressions: 300, ctr: 0.04, position: 6.43 }, { keys: ['root canal cost hyderabad'], clicks: 3, impressions: 150, ctr: 0.02, position: 12.12 }, { keys: ['sri care clinic'], clicks: 40, impressions: 200, ctr: 0.2, position: 1.2 }] });
  }
  if ((m = /analyticsdata\.googleapis\.com\/v1beta\/properties\/([^:]+):runReport$/.exec(url))) {
    if (m[1] === '999999') return json(403, { error: { message: 'User does not have sufficient permissions for this property' } });
    if (m[1] === '111111') return json(404, { error: { message: 'not found' } });
    if (g.mode.ga4off) return json(403, { error: { status: 'PERMISSION_DENIED', message: 'Google Analytics Data API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } });
    const mh = (body.metrics || []).map((x) => ({ name: x.name })); const dim = body.dimensions && body.dimensions[0] && body.dimensions[0].name;
    if (!dim) return json(200, { metricHeaders: mh, rows: [{ dimensionValues: [{ value: 'now' }], metricValues: [{ value: '900' }, { value: '700' }, { value: '2500' }, { value: '600' }] }, { dimensionValues: [{ value: 'before' }], metricValues: [{ value: '800' }, { value: '640' }, { value: '2000' }, { value: '500' }] }] });
    if (dim === 'sessionDefaultChannelGroup') return json(200, { metricHeaders: mh, rows: [{ dimensionValues: [{ value: 'Organic Search' }, { value: 'now' }], metricValues: [{ value: '400' }, { value: '300' }] }, { dimensionValues: [{ value: 'Direct' }, { value: 'now' }], metricValues: [{ value: '300' }, { value: '250' }] }, { dimensionValues: [{ value: 'Organic Search' }, { value: 'before' }], metricValues: [{ value: '320' }, { value: '240' }] }] });
    return json(200, { metricHeaders: mh, rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '700' }] }, { dimensionValues: [{ value: '/services' }], metricValues: [{ value: '300' }] }] });
  }
  return json(404, { error: { message: `unexpected ${url}` } });
};
const web = {}; const webFetch = async (url) => { const hit = web[url]; return { status: hit === undefined ? 404 : 200, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => (typeof hit === 'string' ? hit : '') }; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const NOW = Date.parse('2026-11-25T08:00:00Z'); g.mode.splitDate = Google.periods('gsc', NOW).now.start;

  // 1. the key file
  assert.ok(GA.parseKey('not json').error && GA.parseKey('{}').error && GA.parseKey(JSON.stringify({ type: 'authorized_user' })).error && GA.parseKey(JSON.stringify({ type: 'service_account', client_email: 'a@b.c', private_key: 'x' })).error, 'a key that is not a service account key is refused in words');
  assert.equal(GA.parseKey(KEY).key.client_email, EMAIL); const st = await GA.status({ key: KEY }); assert.deepEqual([st.configured, st.email, st.project], [true, EMAIL, 'teamlink-test']); assert.ok(!JSON.stringify(st).includes('PRIVATE KEY') && !JSON.stringify(st).includes('evil'), 'the status never shows the key');
  assert.deepEqual([(await GA.status()).configured, (await GA.status()).problem], [false, ''], 'no card saved yet: not configured, no complaint');
  console.log('PASS the key file: only a service account key is accepted, refusals are in words, the status shows the email and never the key');

  // 2. the sign-in
  let t = await GA.accessToken({ key: KEY, fetchFn: gfetch, now: NOW }); assert.deepEqual([t.token, t.email], ['tok-1', EMAIL]); const a = g.assertions[0];
  assert.deepEqual(a.head, { alg: 'RS256', typ: 'JWT' }); assert.equal(a.valid, true, 'the statement is signed with the key and verifies with its public half');
  assert.deepEqual([a.claims.iss, a.claims.aud, a.claims.exp - a.claims.iat, a.claims.iat], [EMAIL, 'https://oauth2.googleapis.com/token', 3600, Math.floor(NOW / 1000)]); assert.ok(a.claims.scope.split(' ').every((x) => /\.readonly$/.test(x)) && a.claims.scope.split(' ').length === 2, 'read-only access only'); assert.equal(g.calls[0].url, 'https://oauth2.googleapis.com/token', 'a key file cannot point the sign-in elsewhere');
  t = await GA.accessToken({ key: KEY, fetchFn: gfetch, now: NOW + 3000000 }); assert.equal(g.tokenCalls, 1, 'the token is kept for the hour'); t = await GA.accessToken({ key: KEY, fetchFn: gfetch, now: NOW + 3500000 }); assert.deepEqual([t.token, g.tokenCalls], ['tok-2', 2], 'a new one near the end of its hour');
  g.mode = { ...g.mode, tokenStatus: 400, tokenBody: { error: 'invalid_grant' } }; GA.forget(); assert.ok(/Google refused the key: it may have been deleted/.test((await GA.accessToken({ key: KEY, fetchFn: gfetch })).error)); g.mode = { splitDate: g.mode.splitDate, net: true }; assert.ok(/could not be reached/.test((await GA.accessToken({ key: KEY, fetchFn: gfetch })).error));
  g.mode = { splitDate: g.mode.splitDate, tokenStatus: 503, tokenBody: {} }; assert.ok(/Google had a problem signing in/.test((await GA.accessToken({ key: KEY, fetchFn: gfetch })).error)); g.mode = { splitDate: g.mode.splitDate };
  assert.ok(/could not be used to sign in/.test((await GA.accessToken({ key: JSON.stringify({ type: 'service_account', client_email: 'a@b.c', private_key: '-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n' }), fetchFn: gfetch })).error), 'a broken private key is said in words');
  const before = g.calls.length; const sb = await GA.accessToken({ key: KEY }); assert.deepEqual([sb.code, sb.error, g.calls.length], ['sandbox', 'Google is not called in the test sandbox.', before], 'in the sandbox Google is never called unless a test brings a stand-in');
  console.log('PASS the sign-in: a JWT signed RS256 that verifies with the public key, read-only scopes, Google\'s own token address whatever the key file says, kept for the hour and renewed near its end, refused key / no network / Google down / broken key in words, never called from the sandbox');

  // 3. the saved card: the key is encrypted at rest
  const IS = require('../src/utils/integrationStore'); const prisma = require('../src/db'); const written = await IS.writeValues('google-seo', { [GA.LABEL]: KEY }); assert.equal(written.filled, 1);
  await prisma.integration.upsert({ where: { id: 'google-seo' }, create: { id: 'google-seo', values: JSON.stringify(written.values), enabled: true, connected: true }, update: { values: JSON.stringify(written.values), enabled: true, connected: true } });
  const rawRow = await prisma.integration.findUnique({ where: { id: 'google-seo' } }); assert.ok(!rawRow.values.includes('PRIVATE KEY') && !rawRow.values.includes(EMAIL) && /enc:v1:/.test(rawRow.values), 'stored encrypted');
  assert.ok(IS.isSecretField('google-seo', GA.LABEL), 'the field is a secret one'); const pub = await IS.publicValuesFor(require('../src/utils/adminCatalog').integrationById('google-seo'), rawRow); assert.ok(!JSON.stringify(pub).includes('PRIVATE KEY'), 'the screen never gets the key back');
  const st2 = await GA.status(); assert.deepEqual([st2.configured, st2.email], [true, EMAIL]); assert.ok(require('../src/utils/adminCatalog').LIVE_CHANNELS.includes('google-seo')); assert.ok(/channel\.id === 'google-seo'/.test(fs.readFileSync(path.join(BACK, 'src', 'routes', 'admin.js'), 'utf8')), 'the card has a Test connection');
  console.log('PASS the card: the JSON key is stored encrypted, never returned to the screen, read back by the server, the card is live and has Test connection');

  // 4. Search Console properties
  const props = await Google.properties({ fetchFn: gfetch }); assert.deepEqual(props.items.map((x) => x.property), ['https://www.sri.test/', 'sc-domain:sri.test'], 'unverified properties are left out'); assert.equal(Google.suggestProperty('https://sri.test/', props.items), 'sc-domain:sri.test');
  assert.equal(Google.suggestProperty('https://www.sri.test/x', props.items.filter((x) => x.property.startsWith('https'))), 'https://www.sri.test/'); assert.equal(Google.suggestProperty('https://nobody.test/', props.items), null);
  const many = [...props.items, { property: 'sc-domain:other-client.test', level: 'siteRestrictedUser' }]; assert.deepEqual((await Google.visibleProperties(admin, many, '')).length, 3, 'an Admin sees every client\'s property'); assert.deepEqual((await Google.visibleProperties(restricted, many, 'sri.test')).map((x) => x.property), ['https://www.sri.test/', 'sc-domain:sri.test'], 'anyone else sees only the properties of websites they may see or typed'); assert.deepEqual(await Google.visibleProperties(restricted, many, ''), [], 'and none for a website not named'); assert.equal(Google.suggestProperty('www.sri.test', props.items), 'sc-domain:sri.test', 'an address typed without https still finds its property');
  g.mode = { ...g.mode, http: 403, httpBody: { error: { message: 'Google Search Console API has not been used in project 1 before or it is disabled.' } } }; assert.ok(/not switched on in the Google Cloud project[\s\S]*Enable/.test((await Google.properties({ fetchFn: gfetch })).error)); g.mode = { splitDate: g.mode.splitDate };
  let tc = await Google.testConnection({ fetchFn: gfetch }); assert.ok(tc.ok && tc.text.includes(EMAIL) && /2 Search Console properties/.test(tc.text) && !/PRIVATE KEY/.test(tc.text), tc.text); assert.ok(!(await Google.testConnection({ key: JSON.stringify({}), fetchFn: gfetch })).ok);
  console.log('PASS Search Console properties: the verified ones only, the best fit for a website, the API-not-switched-on case in words, the card\'s Test connection shows the email');

  // 5. a site names its properties
  web['https://sri.test/'] = '<html><body><h1>Sri</h1></body></html>'; web['https://sri.test/robots.txt'] = 'User-agent: *\nAllow: /'; web['https://sri.test/sitemap.xml'] = '<urlset></urlset>';
  const site = (await Sites.save(admin, { clientName: 'Sri Care Clinic', url: 'sri.test', industry: 'clinic', pages: 1, schedule: 'weekly', facts: { name: 'Sri Care Clinic', city: 'Hyderabad', services: 'Dental implants' } })).site; assert.deepEqual([site.gscProperty, site.ga4Property], ['', '']);
  assert.ok((await Sites.save(admin, { id: site.id, gscProperty: 'sri.test' })).error && (await Sites.save(admin, { id: site.id, gscProperty: 'https://x.test' })).error && (await Sites.save(admin, { id: site.id, ga4Property: 'abc' })).error && (await Sites.save(admin, { id: site.id, ga4Property: '123' })).error, 'a wrong property is refused in words');
  let sv = (await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:sri.test', ga4Property: 'properties/123456789' })).site; assert.deepEqual([sv.gscProperty, sv.ga4Property], ['sc-domain:sri.test', '123456789']); sv = (await Sites.save(admin, { id: site.id, facts: { name: 'Sri Care Clinic' } })).site; assert.deepEqual([sv.gscProperty, sv.ga4Property], ['sc-domain:sri.test', '123456789'], 'not sent = kept'); sv = (await Sites.save(admin, { id: site.id, ga4Property: '' })).site; assert.equal(sv.ga4Property, ''); await Sites.save(admin, { id: site.id, ga4Property: '123456789' });
  console.log('PASS site properties: a Search Console property and a GA4 number are saved, a wrong one is refused in words, "not sent" keeps it and an empty box clears it');

  // 6. reading Search Console
  let raw = await Sites.raw(site.id); g.calls.length = 0; let r = await Google.syncGsc(admin, raw, { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(!r.error, JSON.stringify(r)); const x = r.gsc;
  assert.deepEqual([x.totals.clicks, x.totals.impressions, x.totals.ctr, x.totals.position], [160, 4000, 4, 12], 'the property\'s own totals; click-through rate in percent'); assert.deepEqual([x.beforeTotals.clicks, x.change.clicks, x.change.impressions], [100, 60, 33.3]); assert.deepEqual(x.series.map((d) => d.date), ['2026-11-01', '2026-11-02', '2026-11-03'], 'the daily line, oldest first'); assert.equal(x.queries, 3);
  const qcall = g.calls.find((c) => c.body && c.body.dimensions && c.body.dimensions[0] === 'query'); assert.deepEqual([qcall.body.rowLimit, qcall.body.dataState, qcall.url.includes(encodeURIComponent('sc-domain:sri.test'))], [1000, 'final', true]); assert.equal(qcall.body.endDate, '2026-11-22', 'the period ends 3 days ago: the newest days are not final'); assert.equal((Date.parse(qcall.body.endDate) - Date.parse(qcall.body.startDate)) / DAY, 27, '28 days');
  let ss = await Kw.sets(site.id); assert.equal(ss.length, 1); assert.deepEqual([ss[0].source, ss[0].label, ss[0].periodEnd, ss[0].clicks, ss[0].impressions, ss[0].rows], ['Google Search Console API', 'Search Console API: 2025-10-26 to 2026-11-22'.replace('2025-10-26', x.period.start), '2026-11-22', 160, 4000, 3], 'a snapshot in the same tables as the pasted export, with the property\'s totals');
  await Kw.save(admin, site.id, { phrases: ['dental implants in hyderabad', 'root canal cost hyderabad', 'sri care clinic'], tracked: true }); let kl = await Kw.list(admin, site.id); assert.deepEqual(kl.items.map((k) => k.position).sort((p, q) => p - q), [1.2, 6.4, 12.1], 'positions from the API, rounded to a tenth');
  r = await Google.syncGsc(admin, raw, { key: KEY, fetchFn: gfetch, now: NOW }); assert.equal((await Kw.sets(site.id)).length, 1, 'reading the same period again replaces the snapshot'); r = await Google.syncGsc(admin, raw, { key: KEY, fetchFn: gfetch, now: NOW + 7 * DAY }); ss = await Kw.sets(site.id); assert.deepEqual([ss.length, ss[0].periodEnd], [2, '2026-11-29'], 'a later period is a new snapshot, newest first');
  kl = await Kw.list(admin, site.id); assert.ok(kl.items.every((k) => k.previous != null && k.change === 0), 'two snapshots: a change can be told'); const stored = await Google.stored(site.id); assert.equal(stored.gsc.totals.clicks, 160); assert.ok(stored.gscAt);
  const none = (await Sites.save(admin, { clientName: 'No Prop Co', url: 'np.test' })).site; assert.equal((await Google.syncGsc(admin, await Sites.raw(none.id), { key: KEY, fetchFn: gfetch })).code, 'no_property');
  for (const [prop, re] of [['sc-domain:nobody.test', /may not read that Search Console property[\s\S]*Users and permissions[\s\S]*seo-reader@teamlink-test/], ['sc-domain:gone.test', /does not know that Search Console property/]]) { await Sites.save(admin, { id: site.id, gscProperty: prop }); const e = await Google.syncGsc(admin, await Sites.raw(site.id), { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(re.test(e.error), `${prop}: ${e.error}`); }
  await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:sri.test' }); for (const [status, re] of [[429, /free quota is used up/], [503, /Google had a problem/], [401, /refused the access/]]) { g.mode = { splitDate: g.mode.splitDate, http: status }; assert.ok(re.test((await Google.syncGsc(admin, await Sites.raw(site.id), { key: KEY, fetchFn: gfetch, now: NOW })).error)); } g.mode = { splitDate: g.mode.splitDate };
  console.log('PASS Search Console: the property\'s totals and the 28 days before (percent change), the daily line, the queries kept as a snapshot (same period replaced, a later one added), positions and changes in the keyword list, no access / not found / quota / Google down in words with the email to add');

  // 7. reading Analytics 4
  raw = await Sites.raw(site.id); g.calls.length = 0; r = await Google.syncGa4(raw, { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(!r.error, JSON.stringify(r)); const y = r.ga4;
  assert.deepEqual(y.totals.now, { sessions: 900, users: 700, pageViews: 2500, engagedSessions: 600 }); assert.deepEqual(y.organic, { now: { sessions: 400, users: 300 }, before: { sessions: 320, users: 240 } }, 'only the Organic Search channel'); assert.deepEqual(y.change, { sessions: 12.5, users: 9.4, pageViews: 25, organicSessions: 25 }); assert.deepEqual(y.topPages, [{ path: '/', views: 700 }, { path: '/services', views: 300 }]);
  const gc = g.calls.filter((c) => /analyticsdata/.test(c.url)); assert.equal(gc.length, 3); assert.ok(gc.every((c) => c.url.includes('/properties/123456789:runReport') && c.method === 'POST')); assert.deepEqual(gc[0].body.dateRanges.map((d) => d.name), ['now', 'before']); assert.equal(gc[0].body.dateRanges[0].endDate, '2026-11-24', 'Analytics ends yesterday'); assert.deepEqual(gc[0].body.metrics.map((m) => m.name), ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions']);
  assert.equal((await Google.syncGa4({ ga4Property: null }, { key: KEY, fetchFn: gfetch })).code, 'no_property');
  for (const [id, re] of [['999999', /may not read that Analytics property[\s\S]*Property access management[\s\S]*Viewer/], ['111111', /does not know that Analytics property number/]]) { const e = await Google.syncGa4({ id: 'x', ga4Property: id }, { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(re.test(e.error), `${id}: ${e.error}`); }
  g.mode = { splitDate: g.mode.splitDate, ga4off: true }; assert.ok(/"Google Analytics Data API" is not switched on/.test((await Google.syncGa4(raw, { key: KEY, fetchFn: gfetch, now: NOW })).error)); g.mode = { splitDate: g.mode.splitDate };
  assert.equal(Google.pct(5, 0), null, 'no percent from nothing'); assert.equal(Google.pct(null, 5), null);
  console.log('PASS Analytics 4: sessions, users, page views and engaged sessions for 28 days and the 28 before, only Organic Search for the search part, the top pages, the period ends yesterday, no access / unknown property / API off in words, no percent from zero');

  // 8. the calls of the screen
  const salesSite = (await Sites.save(admin, { clientName: 'Sales Google Co', url: 'sales.test', department: 'Sales', gscProperty: 'sc-domain:sri.test' })).site; const callsBefore = g.calls.length; assert.equal((await Google.manualSync(restricted, salesSite.id, 'both', { key: KEY, fetchFn: gfetch })).status, 404, 'another department\'s site'); assert.equal(g.calls.length, callsBefore, 'and Google is not even asked');
  await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:sri.test', ga4Property: '123456789' }); let ms = await Google.manualSync(admin, site.id, 'both', { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(ms.gsc && ms.ga4 && ms.google.gsc.totals.clicks === 160 && ms.google.ga4.totals.now.sessions === 900, JSON.stringify(Object.keys(ms)));
  g.calls.length = 0; ms = await Google.manualSync(admin, site.id, 'gsc', { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(ms.gsc && !ms.ga4 && !g.calls.some((c) => /analyticsdata/.test(c.url)), 'only the part asked for is read');
  await Sites.save(admin, { id: site.id, ga4Property: '999999' }); ms = await Google.manualSync(admin, site.id, 'both', { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(ms.gsc && !ms.ga4 && ms.errors.length === 1 && ms.errors[0].api === 'ga4' && /Viewer/.test(ms.errors[0].error), 'a problem with one part never hides the other'); assert.ok(/Viewer/.test((await Google.stored(site.id)).ga4Error), 'and is kept for the screen');
  await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:nobody.test', ga4Property: '999999' }); ms = await Google.manualSync(admin, site.id, 'both', { key: KEY, fetchFn: gfetch, now: NOW }); assert.ok(ms.error && ms.status === 502 && ms.errors.length === 2, 'both parts failing is an error');
  await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:sri.test', ga4Property: '123456789' }); const hold = await prisma.integration.findUnique({ where: { id: 'google-seo' } }); await prisma.integration.update({ where: { id: 'google-seo' }, data: { values: '{}' } }); const nk = await Google.manualSync(admin, site.id, 'both', { fetchFn: gfetch }); assert.ok(nk.error && nk.status === 400 && /service account/i.test(nk.error), 'no key saved: the way to make one'); await prisma.integration.update({ where: { id: 'google-seo' }, data: { values: hold.values } });
  console.log('PASS the Sync now call: another department\'s site is not found, one or both parts, a problem with one part never hides the other and is kept for the screen, both failing is an error, no key saved says how to make one');

  // 9. the dashboard
  await Sites.save(admin, { id: site.id, gscProperty: 'sc-domain:sri.test', ga4Property: '123456789' }); await Google.manualSync(admin, site.id, 'both', { key: KEY, fetchFn: gfetch, now: NOW }); const d = (await Dash.overview(admin, { siteId: site.id })).site.google;
  assert.deepEqual([d.configured, d.email, d.gscProperty, d.ga4Property, d.gsc.totals.clicks, d.ga4.totals.now.sessions, d.gscError, d.ga4Error], [true, EMAIL, 'sc-domain:sri.test', '123456789', 160, 900, '', ''], JSON.stringify(d).slice(0, 300)); assert.ok(!JSON.stringify(d).includes('PRIVATE KEY') && d.gscAt && d.ga4At);
  console.log('PASS dashboard: the email, the properties, what Google answered last and when, and the last problem; never the key');

  // 10. automatic reading and the bell
  const bells = []; const notify = async (to, m) => { bells.push({ to, ...m }); }; const recipients = async () => ['u-bell']; g.mode = { splitDate: g.mode.splitDate, drop: true };
  const sched = (await Sites.save(admin, { clientName: 'Sched Google Co', url: 'sri.test', industry: 'clinic', pages: 1, schedule: 'weekly', gscProperty: 'sc-domain:sri.test', ga4Property: '123456789' })).site; assert.ok(sched);
  g.mode.splitDate = Google.periods('gsc', Date.now() + 5000).now.start; const sw = await Sched.sweep({ force: true, now: Date.now() + 5000, notify, recipients, fetchFn: webFetch, googleFetch: gfetch, googleKey: KEY, limit: 10 });
  assert.ok(sw.audited >= 1 && sw.google >= 1, JSON.stringify(sw)); const cb = bells.filter((b) => /Search clicks dropped: Sched Google Co/.test(b.title)); assert.equal(cb.length, 1, 'one bell for a fall in search clicks'); assert.ok(/40 clicks[\s\S]*against 100[\s\S]*60% fewer[\s\S]*not a cause/.test(cb[0].message), cb[0].message); assert.ok((await Ev.recent(sched.id, 20)).some((e) => e.kind === 'clicks' && e.level === 'warn'), 'and a line in the progress feed');
  assert.ok((await Google.stored(sched.id)).gsc.totals.clicks === 40, 'the schedule kept what Google said');
  assert.deepEqual(Google.alertsOf('X', { totals: { clicks: 60 }, beforeTotals: { clicks: 100 }, period: { start: 'a', end: 'b' } }).map((a) => a.kind), ['clicks']); assert.deepEqual(Google.alertsOf('X', { totals: { clicks: 75 }, beforeTotals: { clicks: 100 }, period: {} }), [], '25% fewer is not enough'); assert.deepEqual(Google.alertsOf('X', { totals: { clicks: 10 }, beforeTotals: { clicks: 40 }, period: {} }), [], 'too few clicks before to say anything'); assert.deepEqual(Google.alertsOf('X', null), []);
  await Sites.save(admin, { id: sched.id, gscProperty: 'sc-domain:nobody.test' }); g.mode = { splitDate: g.mode.splitDate }; bells.length = 0; const sw2 = await Sched.sweep({ force: true, now: Date.now() + 8 * DAY, notify, recipients, fetchFn: webFetch, googleFetch: gfetch, googleKey: KEY, limit: 10 }); assert.ok(sw2.audited >= 1, 'a problem with Google never stops the audit'); const evs = await Ev.recent(sched.id, 20); assert.ok(evs.some((e) => e.kind === 'google' && /Search Console could not be read/.test(e.title) && /Users and permissions/.test(e.message)) && evs.some((e) => e.kind === 'audit'), 'it is told in the feed');
  console.log('PASS automatic reading: a site with a property is read by the Google module after each scheduled audit, a fall in search clicks (30% or more, at least 50 before) rings once and is in the feed, a smaller fall or too few clicks rings nothing, a Google problem never stops the audit and is told in the feed');

  console.log('SEO assistant phase 2 (Google) tests: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
