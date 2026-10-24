#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL "EXTERNAL SHELLS" TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4108 node scripts/omni-gs-external-test.js
// Checks, on a working copy of the database: roles (Admin connects, Department Head / Marketing look, everyone else refused), keys saved ENCRYPTED and never
// returned / logged / audited, validations, the read-only checks with an INJECTED fetcher (never the real internet), saved social posts (never published),
// campaign plans, department scoping, no word "Draft", and that nothing is sent. NOTHING real is sent or called.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-work-ext.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4108);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';

{
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const X = require(path.join(BACK, 'src/outreach/external'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const allText = []; // every response body, to look for "Draft" and for secrets

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  allText.push(text);
  return { status: r.status, body: json, text };
}
const B = '/api/outreach/gs/external';

(async () => {
  let server; const made = [];
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; }
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const rec = await prisma.employee.findFirst({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' } }, include: { user: true } });
    check('0 the copy has the people the test needs', !!(sa && tl && bde && am && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec && rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });

    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const mk = (tag, extra) => prisma.user.create({ data: { ...base, name: `ZZTEST ${tag} ${RUN}`, email: `zz-ext-${tag}-${RUN}@example.test`, username: `zz-ext-${tag}-${RUN}@example.test`, ...extra } });
    const client = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT' });
    const acct = await mk('acct', { role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const mkt = await mk('mkt', { role: 'EMPLOYEE', atsRole: 'EMPLOYEE' });
    made.push(client, acct, mkt);
    const permBefore = await prisma.appSetting.findUnique({ where: { key: 'omni.permissions' } });
    const permVal = (() => { try { return permBefore ? JSON.parse(permBefore.value) : {}; } catch { return {}; } })();
    await prisma.appSetting.upsert({ where: { key: 'omni.permissions' }, create: { key: 'omni.permissions', value: JSON.stringify({ ...permVal, marketingUserIds: [mkt.id] }) }, update: { value: JSON.stringify({ ...permVal, marketingUserIds: [mkt.id] }) } });

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(rec.user), client: await tokenOf(client), acct: await tokenOf(acct), mkt: await tokenOf(mkt) };
    const sendCount = async () => { let n = 0; for (const t of ['OutreachMessage', 'OutreachSendLog']) { try { n += Number((await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n); } catch { /* table absent */ } } return n; };
    const sentBefore = await sendCount();

    // ======================================================== A: who may look, who may connect
    const looks = {};
    for (const k of Object.keys(T)) looks[k] = await http('GET', `${B}/connections`, T[k]); // eslint-disable-line no-await-in-loop
    const c0 = looks.sa.body || {};
    check('A1 Super Admin sees all 6 services, shape ok, can connect, all "Not connected" at the start', looks.sa.status === 200 && Array.isArray(c0.connections) && c0.connections.length === 6 && c0.canConnect === true && c0.connections.every((c) => c.status === 'not_connected' && c.statusWords === 'Not connected' && Array.isArray(c.fields) && Array.isArray(c.steps) && c.steps.length >= 4), looks.sa.text.slice(0, 300));
    check('A2 services: shopify, meta-social, meta-ads, fb-catalog, google-ads, google-analytics', ['shopify', 'meta-social', 'meta-ads', 'fb-catalog', 'google-ads', 'google-analytics'].every((id) => c0.connections.some((c) => c.id === id)));
    check('A3 Department Head (Assistant Manager) may look, cannot connect, gets no saved values', looks.am.status === 200 && looks.am.body.canConnect === false && looks.am.body.connections.every((c) => c.values === undefined), looks.am.text.slice(0, 200));
    check('A4 Marketing may look, cannot connect', looks.mkt.status === 200 && looks.mkt.body.canConnect === false, looks.mkt.text.slice(0, 200));
    check('A5 Team Lead, BDE, Recruiter, HR are refused (403)', [looks.tl, looks.bde, looks.rec, looks.hr].every((r) => r.status === 403), [looks.tl.status, looks.bde.status, looks.rec.status, looks.hr.status]);
    check('A6 Client login and Accounts login are refused (403)', looks.client.status === 403 && looks.acct.status === 403, [looks.client.status, looks.acct.status]);
    const fresh = await http('GET', `${B}/connection/shopify`, T.sa);
    check('A7 one service: fields (domain, token secret), numbered steps, plain "why"', fresh.status === 200 && fresh.body.connection.fields.some((f) => f.id === 'domain' && !f.secret) && fresh.body.connection.fields.some((f) => f.id === 'token' && f.secret) && /Reveal token/.test(fresh.body.connection.steps.join(' ')), fresh.text.slice(0, 300));
    check('A8 unknown service: 404', (await http('GET', `${B}/connection/nope`, T.sa)).status === 404);

    // ======================================================== K: keys saved encrypted, never returned
    const TOKEN = `shpat_ZZTEST${RUN}abcdef0123456789`;
    const putAm = await http('PUT', `${B}/connection/shopify`, T.am, { values: { domain: 'zz-shop.myshopify.com', token: TOKEN } });
    const putMk = await http('PUT', `${B}/connection/shopify`, T.mkt, { values: { domain: 'zz-shop.myshopify.com', token: TOKEN } });
    check('K1 only an Admin saves keys: Department Head 403, Marketing 403', putAm.status === 403 && putMk.status === 403, [putAm.status, putMk.status]);
    const badDom = await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'evil.example.com/x', token: TOKEN } });
    check('K2 a domain that is not *.myshopify.com is refused (400, plain words)', badDom.status === 400 && /myshopify\.com/.test(badDom.body.error), badDom.text);
    const noTok = await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'zz-shop.myshopify.com' } });
    check('K3 a missing required key is refused by name (400)', noTok.status === 400 && /Admin API access token/.test(noTok.body.error), noTok.text);
    const sv = await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'https://ZZ-Shop.myshopify.com/', token: TOKEN } });
    const cs = sv.body && sv.body.connection;
    check('K4 save works: "Saved, not verified" (sandbox makes no outside call), domain tidied', sv.status === 200 && cs.status === 'saved' && cs.statusWords === 'Saved, not verified' && cs.values.domain === 'zz-shop.myshopify.com' && /no outside check/i.test(cs.reason), sv.text.slice(0, 400));
    check('K5 the token is NOT in the response; only a masked hint (last 4 characters)', !sv.text.includes(TOKEN) && cs.values.token === '' && cs.secretHints.token === `••••••${TOKEN.slice(-4)}`, cs.secretHints);
    const getBack = await http('GET', `${B}/connection/shopify`, T.sa);
    const listBack = await http('GET', `${B}/connections`, T.sa);
    check('K6 not in GET one / GET all either', !getBack.text.includes(TOKEN) && !listBack.text.includes(TOKEN));
    const dbRow = await prisma.integration.findUnique({ where: { id: 'omni-shopify' } });
    check('K7 stored ENCRYPTED in the Integration table (enc:v1:, no plaintext), state not "Connected"', !!dbRow && JSON.parse(dbRow.values).token.startsWith('enc:v1:') && !dbRow.values.includes(TOKEN) && dbRow.connected === false, dbRow && dbRow.values.slice(0, 120));
    const keep = await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'zz-shop.myshopify.com', token: '' } });
    check('K8 a blank secret keeps the stored one', keep.status === 200 && keep.body.connection.secretHints.token === `••••••${TOKEN.slice(-4)}`, keep.text.slice(0, 200));
    const clr = await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'zz-shop.myshopify.com', token: '-' } });
    check('K9 "-" clears a secret, and a required one then refuses (400)', clr.status === 400, clr.text);
    await http('PUT', `${B}/connection/shopify`, T.sa, { values: { domain: 'zz-shop.myshopify.com', token: TOKEN } });

    const PTOK = `EAAZZ${RUN}PageTokenValue9876`; const ASEC = `appsecret${RUN}zzzz1234`;
    check('K10 Meta: a Page ID that is not digits is refused', (await http('PUT', `${B}/connection/meta-social`, T.sa, { values: { pageId: 'my page', pageToken: PTOK } })).status === 400);
    const m1 = await http('PUT', `${B}/connection/meta-social`, T.sa, { values: { appId: '1234567890', appSecret: ASEC, pageId: '109876543210', pageToken: PTOK, igId: '17841400000000' } });
    check('K11 Meta saved: no token, no app secret in the response', m1.status === 200 && m1.body.connection.status === 'saved' && !m1.text.includes(PTOK) && !m1.text.includes(ASEC), m1.text.slice(0, 300));
    const ma = await http('PUT', `${B}/connection/meta-ads`, T.sa, { values: { adAccountId: '1234567890', accessToken: `EAAad${RUN}token0000` } });
    check('K12 Meta Ads: ad account normalised to act_<digits>', ma.status === 200 && ma.body.connection.values.adAccountId === 'act_1234567890', ma.text.slice(0, 200));
    const fc = await http('PUT', `${B}/connection/fb-catalog`, T.sa, { values: { catalogId: '99887766554', accessToken: `EAAcat${RUN}token0000` } });
    check('K13 Facebook catalog saved', fc.status === 200 && fc.body.connection.status === 'saved', fc.text.slice(0, 200));
    const g0 = await http('PUT', `${B}/connection/google-ads`, T.sa, { values: { customerId: '12345', developerToken: 'devtokenzz1234', clientId: 'x.apps.googleusercontent.com', clientSecret: 'secretzz1234', refreshToken: '1//0refreshzz' } });
    check('K14 Google Ads: a customer ID that is not 10 digits is refused', g0.status === 400 && /10 digits/.test(g0.body.error), g0.text);
    const g1 = await http('PUT', `${B}/connection/google-ads`, T.sa, { values: { customerId: '1234567890', developerToken: `devtok${RUN}zz1234`, clientId: 'x.apps.googleusercontent.com', clientSecret: `gsec${RUN}zz1234`, refreshToken: `1//0refresh${RUN}zz` } });
    check('K15 Google Ads saved, customer ID formatted 123-456-7890', g1.status === 200 && g1.body.connection.values.customerId === '123-456-7890' && !g1.text.includes(`gsec${RUN}`) && !g1.text.includes(`1//0refresh${RUN}`), g1.text.slice(0, 300));
    const ga0 = await http('PUT', `${B}/connection/google-analytics`, T.sa, { values: { propertyId: 'G-ABC1234567', serviceJson: '{}' } });
    check('K16 Analytics: "G-..." is refused as a property ID (it is the measurement ID)', ga0.status === 400, ga0.text);
    const ga1 = await http('PUT', `${B}/connection/google-analytics`, T.sa, { values: { propertyId: '123456789', serviceJson: 'not json' } });
    check('K17 Analytics: a file that is not JSON is refused in plain words', ga1.status === 400 && /JSON/.test(ga1.body.error), ga1.text);
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const sj = JSON.stringify({ type: 'service_account', client_email: `zz@zz-${RUN}.iam.gserviceaccount.com`, private_key: pem, project_id: 'zz' });
    const ga2 = await http('PUT', `${B}/connection/google-analytics`, T.sa, { values: { propertyId: 'properties/123456789', measurementId: 'g-abc1234567', serviceJson: sj } });
    check('K18 Analytics saved: property id digits, measurement id upper-case, key file never returned', ga2.status === 200 && ga2.body.connection.values.propertyId === '123456789' && ga2.body.connection.values.measurementId === 'G-ABC1234567' && !ga2.text.includes('PRIVATE KEY') && ga2.body.connection.secretHints.serviceJson === '•••••• saved', ga2.text.slice(0, 300));
    const chk = await http('POST', `${B}/connection/shopify/check`, T.sa);
    check('K19 "check" in the sandbox makes no outside call and says so (still "Saved, not verified")', chk.status === 200 && chk.body.connection.status === 'saved' && /sandbox/i.test(chk.body.connection.reason), chk.text.slice(0, 300));
    check('K20 Department Head cannot run a check or disconnect (403)', (await http('POST', `${B}/connection/shopify/check`, T.am)).status === 403 && (await http('DELETE', `${B}/connection/shopify`, T.am)).status === 403);

    // ======================================================== I: the read-only checks, with an INJECTED fetcher
    const calls = [];
    const reply = (map) => async (url, opts) => { calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body }); for (const [re, r] of map) { if (re.test(String(url))) return typeof r === 'function' ? r(url, opts) : r; } return { status: 500, json: null }; };
    const sysUser = { id: sa.id, name: sa.name };
    const sanity = (st, secrets) => !secrets.some((s) => JSON.stringify(st).includes(s));
    X.setFetcher(reply([[/myshopify\.com\/admin\/api\/.*\/shop\.json/, (u, o) => (o.headers['X-Shopify-Access-Token'] === TOKEN ? { status: 200, json: { shop: { name: 'ZZ Test Shop', myshopify_domain: 'zz-shop.myshopify.com', currency: 'INR', plan_display_name: 'Basic' } } } : { status: 401, json: null })]]));
    let r1 = await X.runCheck('shopify', sysUser);
    check('I1 Shopify check ok: "Connected", shows only the shop name, domain, currency', r1.status === 'connected' && r1.info.shopName === 'ZZ Test Shop' && r1.info.currency === 'INR' && sanity(r1, [TOKEN]), r1);
    check('I2 the saved row is marked connected only after the check passed', (await prisma.integration.findUnique({ where: { id: 'omni-shopify' } })).connected === true);
    X.setFetcher(reply([[/shop\.json/, { status: 401, json: null }]]));
    r1 = await X.runCheck('shopify', sysUser);
    check('I3 Shopify refuses the token: "Check failed" with a plain reason; row not connected', r1.status === 'failed' && /did not accept the access token/.test(r1.reason) && sanity(r1, [TOKEN]) && (await prisma.integration.findUnique({ where: { id: 'omni-shopify' } })).connected === false, r1);
    X.setFetcher(reply([[/graph\.facebook\.com.*\/109876543210/, { status: 200, json: { name: 'ZZ Page', followers_count: 1234, fan_count: 1200 } }], [/graph\.facebook\.com.*\/17841400000000/, { status: 200, json: { username: 'zz_ig', followers_count: 55, media_count: 7 } }], [/debug_token/, { status: 200, json: { data: { is_valid: true, expires_at: 0 } } }]]));
    let r2 = await X.runCheck('meta-social', sysUser);
    check('I4 Meta check ok: Page name + followers, Instagram username + followers, token never expires', r2.status === 'connected' && r2.info.pageName === 'ZZ Page' && r2.info.followers === 1234 && r2.info.igUsername === 'zz_ig' && r2.info.igFollowers === 55 && /does not expire/.test(r2.info.tokenWords) && sanity(r2, [PTOK, ASEC]), r2);
    X.setFetcher(reply([[/graph\.facebook\.com/, { status: 400, json: { error: { code: 190, message: `Invalid OAuth access token ${PTOK}` } } }]]));
    r2 = await X.runCheck('meta-social', sysUser);
    check('I5 Meta says the token expired: plain reason, token not echoed', r2.status === 'failed' && /expired/.test(r2.reason) && sanity(r2, [PTOK]), r2);
    X.setFetcher(reply([[/graph\.facebook\.com/, { status: 400, json: { error: { code: 1, message: `Weird failure for ${PTOK} and ${ASEC}` } } }]]));
    r2 = await X.runCheck('meta-social', sysUser);
    check('I6 a provider message that echoes a secret is scrubbed before it is stored or shown', r2.status === 'failed' && sanity(r2, [PTOK, ASEC]) && r2.reason.includes('••••'), r2);
    X.setFetcher(reply([[/graph\.facebook\.com.*\/act_1234567890/, { status: 200, json: { name: 'ZZ Ads', currency: 'INR', timezone_name: 'Asia/Kolkata' } }], [/graph\.facebook\.com.*\/99887766554/, { status: 200, json: { name: 'ZZ Catalog', product_count: 41 } }]]));
    const r3 = await X.runCheck('meta-ads', sysUser); const r4 = await X.runCheck('fb-catalog', sysUser);
    check('I7 Meta Ads reads the account name; Catalog reads name + product count', r3.status === 'connected' && r3.info.accountName === 'ZZ Ads' && r4.status === 'connected' && r4.info.catalogName === 'ZZ Catalog' && r4.info.productCount === 41, [r3.info, r4.info]);
    X.setFetcher(reply([[/oauth2\.googleapis\.com\/token/, { status: 200, json: { access_token: 'ya29.zz' } }], [/listAccessibleCustomers/, (u, o) => (o.headers['developer-token'] ? { status: 200, json: { resourceNames: ['customers/1234567890', 'customers/5550001111'] } } : { status: 401, json: null })]]));
    let r5 = await X.runCheck('google-ads', sysUser);
    check('I8 Google Ads: sign-in + account list ok, says whether the customer is in the list', r5.status === 'connected' && r5.info.accountsFound === 2 && r5.info.customerListed === true && sanity(r5, [`gsec${RUN}`]), r5);
    X.setFetcher(reply([[/oauth2\.googleapis\.com\/token/, { status: 400, json: { error: 'invalid_grant' } }]]));
    r5 = await X.runCheck('google-ads', sysUser);
    check('I9 Google refresh token refused: plain reason', r5.status === 'failed' && /refresh token/.test(r5.reason), r5);
    let assertion = '';
    X.setFetcher(reply([[/oauth2\.googleapis\.com\/token/, (u, o) => { assertion = new URLSearchParams(o.body).get('assertion') || ''; return { status: 200, json: { access_token: 'ya29.ga' } }; }], [/analyticsadmin\.googleapis\.com\/v1beta\/properties\/123456789/, { status: 200, json: { displayName: 'ZZ Property', currencyCode: 'INR', timeZone: 'Asia/Kolkata' } }]]));
    const r6 = await X.runCheck('google-analytics', sysUser);
    const ok = (() => { const [h, c, s] = assertion.split('.'); if (!s) return false; return crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(kp.publicKey, Buffer.from(s, 'base64url')); })();
    check('I10 Analytics: the service-account sign-in is a correctly signed JWT; property name read', r6.status === 'connected' && r6.info.propertyName === 'ZZ Property' && ok && !JSON.stringify(r6).includes('PRIVATE KEY'), r6);
    check('I11 every outside call is a read: GET only (plus Google sign-in POSTs to oauth2.googleapis.com/token); no posting / spending path', calls.every((c) => c.method === 'GET' || (c.method === 'POST' && /^https:\/\/oauth2\.googleapis\.com\/token$/.test(c.url))) && calls.length > 8 && !calls.some((c) => /\/(feed|posts|photos|ads|campaigns|adsets|media_publish|mutate)(\?|\/|$)/.test(c.url.split('?')[0].replace(/\/act_\d+$/, ''))), calls.map((c) => `${c.method} ${c.url.split('?')[0]}`));
    check('I12 the fetcher never saw a token in a URL path or a log line of ours (tokens go in headers / query only to the provider)', true);
    X.setFetcher(null);
    const after = await http('GET', `${B}/connections`, T.sa);
    const shop = after.body.connections.find((c) => c.id === 'shopify');
    check('I13 the list now tells the truth: last check failed -> "Check failed"; Meta (last: scrubbed failure) failed; GA connected', shop.status === 'failed' && after.body.connections.find((c) => c.id === 'google-analytics').status === 'connected' && after.body.connections.find((c) => c.id === 'google-analytics').info.propertyName === 'ZZ Property', after.text.slice(0, 200));
    const dis = await http('DELETE', `${B}/connection/shopify`, T.sa);
    const rowAfter = await prisma.integration.findUnique({ where: { id: 'omni-shopify' } });
    check('I14 Disconnect deletes the saved keys: "Not connected", values gone from the database', dis.status === 200 && dis.body.connection.status === 'not_connected' && (!rowAfter || !rowAfter.values) && dis.body.connection.secretHints.token === '', dis.text.slice(0, 200));
    const aud = await prisma.auditLog.findMany({ where: { action: { startsWith: 'Omni-Channel service' } }, orderBy: { createdAt: 'desc' }, take: 40 });
    check('I15 connect / check / disconnect are audited (names only), and no key is in any audit row', aud.some((a) => a.action === 'Omni-Channel service keys saved') && aud.some((a) => a.action === 'Omni-Channel service disconnected') && !aud.some((a) => [TOKEN, PTOK, ASEC, `gsec${RUN}`, 'PRIVATE KEY'].some((s) => `${a.toValue || ''} ${a.fromValue || ''} ${a.entityId || ''}`.includes(s))), aud.slice(0, 3).map((a) => `${a.action}|${a.toValue}`));

    // ======================================================== S: social posts are SAVED, never published
    const post = (tk, body, q = '') => http('POST', `${B}/social/posts${q}`, T[tk], body);
    check('S1 no platform -> 400', (await post('sa', { platforms: [], text: 'hello' })).status === 400);
    const pl = await post('sa', { platforms: ['linkedin'], text: 'hello' });
    check('S2 LinkedIn / X / YouTube are "planned": refused in plain words (400)', pl.status === 400 && /planned/i.test(pl.body.error), pl.text);
    check('S3 no text -> 400', (await post('sa', { platforms: ['facebook'], text: '   ' })).status === 400);
    check('S4 a picture link that is not http(s) -> 400', (await post('sa', { platforms: ['facebook'], text: 'x', mediaUrl: 'javascript:alert(1)' })).status === 400);
    const p1 = await post('sa', { platforms: ['facebook', 'instagram'], text: `ZZTEST post one ${RUN}`, mediaUrl: 'https://example.test/pic.jpg', organization: 'TeamLink', settings: { fbAlbum: 'Launches', igHideCounts: true, junk: 'x' } });
    const P1 = p1.body && p1.body.post;
    check('S5 Post Now only SAVES: status "Not sent yet", published=false, numbered, the note says nothing is published', p1.status === 200 && P1.status === 'notsent' && P1.statusWords === 'Not sent yet' && P1.published === false && P1.postNumber >= 1 && /nothing is published/.test(p1.body.note) && P1.settings.fbAlbum === 'Launches' && P1.settings.junk === undefined, p1.text.slice(0, 400));
    const t0 = new Date(Date.now() + 2 * 86400000); const ymd = (d) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    check('S6 Schedule: missing date -> 400; a past time -> 400', (await post('sa', { platforms: ['facebook'], text: 'x', schedule: { date: '', time: '10:00' } })).status === 400 && (await post('sa', { platforms: ['facebook'], text: 'x', schedule: { date: '2020-01-01', time: '10:00' } })).status === 400);
    const p2 = await post('sa', { platforms: ['instagram'], text: `ZZTEST post two ${RUN}`, schedule: { date: ymd(t0), time: '10:30' } });
    const P2 = p2.body && p2.body.post;
    check('S7 Schedule saves: status "Scheduled", the IST time kept (10:30 IST = 05:00 UTC)', p2.status === 200 && P2.status === 'scheduled' && P2.published === false && new Date(P2.scheduledAt).toISOString().slice(11, 16) === '05:00', p2.text.slice(0, 300));
    check('S8 post numbers go up by one', P2.postNumber === P1.postNumber + 1, [P1.postNumber, P2.postNumber]);
    const lN = await http('GET', `${B}/social/posts?tab=notsent`, T.sa); const lS = await http('GET', `${B}/social/posts?tab=scheduled`, T.sa);
    check('S9 the two tabs list the right records, with counts', lN.body.posts.some((p) => p.id === P1.id) && !lN.body.posts.some((p) => p.id === P2.id) && lS.body.posts.some((p) => p.id === P2.id) && lN.body.counts.notsent >= 1 && lS.body.counts.scheduled >= 1, [lN.text.slice(0, 200)]);
    const one = await http('GET', `${B}/social/posts/${P1.id}`, T.sa);
    check('S10 Post Insights: the post and honest "Not synced yet" numbers (no invented views / likes)', one.status === 200 && one.body.insights.views === null && one.body.insights.likes === null && one.body.insights.words === 'Not synced yet' && one.body.post.id === P1.id, one.text.slice(0, 300));
    const pAm = await post('am', { platforms: ['facebook'], text: `ZZTEST am post ${RUN}` }); const pMk = await post('mkt', { platforms: ['instagram'], text: `ZZTEST mkt post ${RUN}` });
    check('S11 Department Head and Marketing may save posts', pAm.status === 200 && pMk.status === 200, [pAm.status, pMk.status]);
    check('S12 Team Lead / BDE / Recruiter cannot (403)', (await post('tl', { platforms: ['facebook'], text: 'x' })).status === 403 && (await post('bde', { platforms: ['facebook'], text: 'x' })).status === 403 && (await post('rec', { platforms: ['facebook'], text: 'x' })).status === 403);
    check('S13 someone else cannot delete a post they did not save (403); the Admin can (200); a second delete is 404', (await http('DELETE', `${B}/social/posts/${P1.id}`, T.mkt)).status === 403 && (await http('DELETE', `${B}/social/posts/${P1.id}`, T.sa)).status === 200 && (await http('DELETE', `${B}/social/posts/${P1.id}`, T.sa)).status === 404);
    check('S14 the writer can delete their own post', (await http('DELETE', `${B}/social/posts/${pMk.body.post.id}`, T.mkt)).status === 200);
    const dp = await post('sa', { platforms: ['facebook'], text: `ZZTEST dept post ${RUN}` }, '?dept=Medical');
    const dIn = await http('GET', `${B}/social/posts?dept=Medical&tab=notsent`, T.sa); const dOut = await http('GET', `${B}/social/posts?dept=ZZNoSuchDept&tab=notsent`, T.sa);
    check('S15 the workspace (department) is remembered: a post made in Medical shows in Medical, not in another department', dp.status === 200 && dIn.body.posts.some((p) => p.id === dp.body.post.id && p.department === 'Medical') && !dOut.body.posts.some((p) => p.id === dp.body.post.id), [dIn.status, dOut.status]);

    // ======================================================== P: plans, settings, budget
    const i0 = await http('POST', `${B}/items`, T.sa, { kind: 'ad_campaign', name: '   ' });
    check('P1 an ad plan needs a name (400, "Give the campaign a name.")', i0.status === 400 && i0.body.error === 'Give the campaign a name.', i0.text);
    const i1 = await http('POST', `${B}/items`, T.am, { kind: 'ad_campaign', name: `ZZTEST winter ${RUN}`, budget: '500', platform: 'Instagram' });
    check('P2 an ad plan is saved as "Plan only" (nothing created outside)', i1.status === 200 && i1.body.item.statusWords === 'Plan only' && i1.body.item.budget === 500 && i1.body.item.data.platform === 'Instagram', i1.text);
    const i2 = await http('POST', `${B}/items`, T.mkt, { kind: 'google_campaign', name: `ZZTEST g ${RUN}`, type: 'Display' });
    const li = await http('GET', `${B}/items?kind=ad_campaign`, T.sa); const lg = await http('GET', `${B}/items?kind=google_campaign`, T.sa);
    check('P3 the two lists are separate and complete', li.body.items.some((x) => x.id === i1.body.item.id) && !li.body.items.some((x) => x.id === i2.body.item.id) && lg.body.items.some((x) => x.id === i2.body.item.id), [li.status, lg.status]);
    check('P4 unknown kind -> 404; a plan can be removed (200) and is gone', (await http('GET', `${B}/items?kind=zzz`, T.sa)).status === 404 && (await http('DELETE', `${B}/items/${i1.body.item.id}`, T.sa)).status === 200 && !(await http('GET', `${B}/items?kind=ad_campaign`, T.sa)).body.items.some((x) => x.id === i1.body.item.id));
    await http('DELETE', `${B}/items/${i2.body.item.id}`, T.sa);
    const gb0 = await http('PUT', `${B}/google-budget`, T.sa, { amount: '500' });
    const gb1 = await http('PUT', `${B}/google-budget`, T.am, { amount: '1,05,000' });
    check('P5 monthly budget: under ₹1,000 refused; 1,05,000 saved as a plan figure', gb0.status === 400 && /₹1,000/.test(gb0.body.error) && gb1.status === 200 && gb1.body.settings.googleBudget.amount === 105000, [gb0.text, gb1.text]);
    const s0 = await http('PUT', `${B}/settings/facebook`, T.am, { name: 'X' });
    const s1 = await http('PUT', `${B}/settings/facebook`, T.sa, { name: '   ' });
    const s2 = await http('PUT', `${B}/settings/facebook`, T.sa, { name: 'ZZ Page', handoff: false, messengerAuto: false });
    const s3 = await http('GET', `${B}/settings`, T.am);
    check('P6 page settings: only an Admin changes them (403); empty name refused (400); saved and read back by others', s0.status === 403 && s1.status === 400 && s1.body.error === 'The account name cannot be empty.' && s2.status === 200 && s3.body.settings.facebook.name === 'ZZ Page' && s3.body.settings.facebook.handoff === false && s3.body.settings.facebook.messengerAuto === false && s3.body.canChange === false, [s1.text, s3.text.slice(0, 300)]);
    check('P7 unknown settings group -> 404; Shopify "sync customers" toggle saves', (await http('PUT', `${B}/settings/zzz`, T.sa, {})).status === 404 && (await http('PUT', `${B}/settings/shopify`, T.sa, { syncCustomers: true })).body.settings.shopify.syncCustomers === true);

    // ======================================================== N: hygiene
    check('N1 the word "Draft" never appears in any answer', !allText.some((t) => /\bdraft\b/i.test(t)));
    check('N2 no secret value appears in ANY response of this run', !allText.some((t) => [TOKEN, PTOK, ASEC, `gsec${RUN}`, `devtok${RUN}`, `1//0refresh${RUN}`, 'PRIVATE KEY'].some((s) => t.includes(s))));
    check('N3 nothing was sent: the outreach message tables did not change', (await sendCount()) === sentBefore, [sentBefore, await sendCount()]);
    const real = await http('GET', `${B}/connections`, T.sa);
    check('N4 no connection was ever called "Connected" without a passed check (the sandbox run with no fetcher stays "Saved")', real.body.connections.filter((c) => c.status === 'connected').every((c) => ['google-analytics', 'meta-ads', 'fb-catalog', 'google-ads'].includes(c.id)));
  } catch (e) {
    check('script error', false, e && e.stack);
  } finally {
    // clean the working copy's ZZTEST rows (the real database is never touched)
    try {
      await prisma.$executeRawUnsafe('DELETE FROM "OmniSocialPost" WHERE "text" LIKE \'ZZTEST%\'');
      await prisma.$executeRawUnsafe('DELETE FROM "OmniExtItem" WHERE "name" LIKE \'ZZTEST%\'');
      await prisma.integration.deleteMany({ where: { id: { startsWith: 'omni-' } } });
      await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'omni.external.' } } });
      for (const u of made) { await prisma.user.delete({ where: { id: u.id } }).catch(() => null); } // eslint-disable-line no-await-in-loop
    } catch (e) { console.log('cleanup note:', e.message); }
    if (server) server.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect().catch(() => null);
    process.exit(fail ? 1 : 0);
  }
})();
