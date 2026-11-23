#!/usr/bin/env node
/**
 * The Job Portal uses TeamLink's Integrations by itself (utils/portalIntegrations.js + the bridge's doors).
 *   Part 1 (only with --portal): the portal's doors, against a SANDBOX portal (never the live one):
 *     node scripts/portal-integrations-test.js --portal http://127.0.0.1:4324 [--token testtoken]
 *   Part 2: the TeamLink side, with the portal replaced by a recorder (nothing is ever sent anywhere). Since 2026-11-23 the portal ASKS for the
 *     values (GET /api/public/job-portal/integrations, tested by scripts/integrations-bridge-test.js); TeamLink only nudges it, and no value is
 *     ever in a nudge.
 */
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PORTAL = arg('portal', '');
const TOKEN = arg('token', 'testtoken');
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const call = async (path, body, method = 'POST') => {
  const res = await fetch(`${PORTAL}/api/integrations/teamlink${path}`, { method, headers: { 'content-type': 'application/json', 'x-teamlink-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
};

(async () => {
  // ---- part 1: the portal's door ----------------------------------------------------------------------------------------------
  let r;
  if (PORTAL) {
  r = await call('/whatsapp/primary', undefined, 'GET');
  check('the portal says whether it has a WhatsApp number (and never the token)', r.status === 200 && typeof r.json.configured === 'boolean' && !/token|key/i.test(Object.keys(r.json).join(',')), r);
  r = await call('/whatsapp/primary', { accessToken: '', phoneNumberId: '123456789' });
  check('a number without a token is refused', r.status === 422, r);
  r = await call('/whatsapp/primary', { accessToken: 'EAAZZTESTTOKEN', phoneNumberId: 'abc' });
  check('a phone number ID that is not numeric is refused', r.status === 422, r);
  r = await call('/whatsapp/primary', { accessToken: 'EAAZZTESTTOKEN0000', phoneNumberId: '109876543210', businessId: '2001' });
  check('a good number is accepted', r.status === 200 && r.json.configured === true && r.json.phoneNumberId === '…3210', r);
  check('and the answer never contains the token', !/EAAZZTESTTOKEN/.test(r.text), r.text);
  r = await call('/whatsapp/primary', undefined, 'GET');
  check('it reads back as configured, last 4 only', r.json.configured === true && r.json.phoneNumberId === '…3210' && !/EAAZZ/.test(r.text), r);
  const noTok = await fetch(`${PORTAL}/api/integrations/teamlink/whatsapp/primary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('the door needs the TeamLink token', noTok.status === 401, noTok.status);

  // ---- part 1b: email and SMS on the sandbox portal -------------------------------------------------------------------------
  const http = require('http');
  const handed = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { handed.push({ url: req.url, secret: req.headers['x-job-portal-secret'], body: JSON.parse(body || '{}') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, providerRef: 'mock-1' })); });
  });
  await new Promise((ok) => { mock.listen(4019, '127.0.0.1', ok); });
  r = await call('/email/config', undefined, 'GET');
  check('the portal says whether it has an email account (no password)', r.status === 200 && typeof r.json.configured === 'boolean' && !/pass/i.test(Object.keys(r.json).join(',')), r);
  r = await call('/email/config', { host: '', port: 465, fromAddress: 'a@b.test' });
  check('an email account without a host is refused', r.status === 422, r);
  r = await call('/email/config', { host: '127.0.0.1', port: 1, secure: false, encryption: 'None', user: 'u', pass: 'ZZPASSWORD', fromAddress: 'hr@zztest.example', fromName: 'ZZ HR' });
  check('a good email account is accepted and reads back without the password', r.status === 200 && r.json.configured === true && r.json.host === '127.0.0.1' && r.json.from === 'hr@zztest.example' && !/ZZPASSWORD/.test(r.text), r);
  r = await call('/sms/relay', { on: 'yes' });
  check('the SMS relay switch refuses a non-boolean', r.status === 422, r);
  r = await call('/sms/relay', { on: true });
  check('the SMS relay can be turned on', r.status === 200 && r.json.relay === true, r);
  const sm = `93${Date.now().toString().slice(-8)}`;
  r = await call('/candidates/invite', { people: [{ ref: 'zzs', name: `ZZTEST Sms ${sm}`, email: `zztest.sms.${sm}@example.invalid`, phone: sm }], dryRun: false });
  const sent1 = r.json && r.json.results && r.json.results[0];
  check('the portal SMS really goes to TeamLink, with the bridge secret', handed.some((h) => h.url === '/api/public/job-portal/sms' && h.secret === 'testsecret' && h.body.to === sm && String(h.body.text || '').length > 10), handed);
  check('and the candidate delivery says SMS was sent', sent1 && sent1.delivery && sent1.delivery.sms === 'sent', sent1);
  check('the email now uses the account TeamLink gave (it tried the server: failed, not "not configured")', sent1 && sent1.delivery && sent1.delivery.email && sent1.delivery.email !== 'not_configured', sent1);
  mock.close();

  } else console.log('(part 1 skipped: no --portal sandbox given)');

  // ---- part 2: TeamLink's side ------------------------------------------------------------------------------------------------
  process.env.NODE_ENV = 'development';
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const nudges = [];
  let portalPid = 111;
  let state = { inUse: { email: true, sms: true, whatsapp: true, ai: true }, own: { email: false, sms: false, whatsapp: false } };
  stub('../src/utils/sandbox', { isSandbox: () => false });
  stub('../src/utils/jobPortalBridge', {
    portalFetch: async (p, o = {}) => {
      if (/integrations\/refresh/.test(p)) {
        if (o.method === 'POST') nudges.push(o.body);
        return { pid: portalPid, registered: true, ...state, error: null };
      }
      if (/email\/config/.test(p)) return { configured: true, host: 'mail.zz.test', from: 'hr@zz.test', pid: portalPid };
      if (/sms\/relay/.test(p)) return { relay: true, inUse: true, pid: portalPid };
      return { configured: true, phoneNumberId: '…0111', pid: portalPid };
    },
  });
  let cfg = { configured: true, token: 'SECRET-TOKEN-1', phoneId: '555000111', wabaId: 'W1', display: '+91 90000 00000', language: 'en', templates: { bulk: 'zz_bulk', otp: '', link: 'zz_link' }, problems: [] };
  stub('../src/utils/waNumbers', { hasNumbers: async () => true, defaultConfig: async () => cfg, listRows: async () => [{ label: 'Company', displayNumber: '+91 90000 00000', isDefault: true, active: true, removedAt: null }] });
  stub('../src/utils/whatsappCloud', { legacyConfig: async () => ({ configured: false, reason: 'not set' }) });
  stub('../src/utils/socialAccounts', { PLATFORMS: ['facebook', 'instagram'], list: async () => ({ facebook: [{ name: 'Page A', username: null, status: 'Connected', isDefault: true, tokenEnc: 'SHOULD-NOT-LEAK' }], instagram: [] }) });
  stub('../src/calling/settings', { status: async () => ({ state: 'Connected', detail: 'ok' }) });
  const emailCfg = { configured: true, host: 'mail.zz.test', port: 465, secure: true, user: 'hr@zz.test', pass: 'EMAIL-SECRET-1', fromAddress: 'hr@zz.test', fromName: 'ZZ HR' };
  stub('../src/utils/mailer', { emailConfig: async () => emailCfg });
  stub('../src/utils/smsGateway', { smsConfig: async () => ({ configured: true, provider: 'SMSGW' }) });
  stub('../src/utils/aiAgent', { agentConfig: async () => ({ configured: true, apiKey: 'SECRET-AI-1' }) });
  const P = require('../src/utils/portalIntegrations');

  const v = await P.valuesForPortal();
  check('the values for the portal: TeamLink SMTP, its default WhatsApp number with the bulk template, SMS by TeamLink, the AI key', v.email.pass === 'EMAIL-SECRET-1' && v.email.encryption === 'SSL' && v.whatsapp.accessToken === 'SECRET-TOKEN-1' && v.whatsapp.phoneNumberId === '555000111' && v.whatsapp.templateBulk === 'zz_bulk' && !('templateAgreement' in v.whatsapp) && v.sms.relay === true && v.ai.apiKey === 'SECRET-AI-1', v);
  let out = await P.pushAll();
  check('the portal is nudged to ask, and the nudge carries no value', out.whatsapp.pushed === true && out.email.inUse === true && nudges.length === 1 && JSON.stringify(nudges[0]) === '{}', { out, nudges });
  out = await P.pushAll();
  check('nothing changed: no second nudge', out.whatsapp.unchanged === true && nudges.length === 1, { out, n: nudges.length });
  portalPid = 222;
  out = await P.pushAll();
  check('the portal started again (new process): nudged again by itself', out.email.pushed === true && nudges.length === 2, { out, n: nudges.length });
  cfg = { ...cfg, token: 'SECRET-TOKEN-2' };
  out = await P.pushAll();
  check('the token changed in Integrations: nudged again', out.whatsapp.pushed === true && nudges.length === 3, { out, n: nudges.length });
  emailCfg.pass = 'EMAIL-SECRET-2';
  out = await P.pushAll();
  check('the SMTP password changed: nudged again', out.email.pushed === true && nudges.length === 4, { out, n: nudges.length });
  state = { inUse: { email: false, sms: true, whatsapp: true, ai: true }, own: { email: true, sms: false, whatsapp: false } };
  out = await P.pushAll({ force: true });
  check('a portal that connected its own Email says so: email is the portal own, not TeamLink', out.email.own === true && out.email.inUse === false && out.whatsapp.inUse === true, out);
  cfg = { configured: false, reason: 'no token', problems: ['no token'] };
  const v2 = await P.valuesForPortal();
  check('with no working number in TeamLink no WhatsApp is handed over (and nothing is invented)', !v2.whatsapp && !!v2.email, v2);

  const snap = await P.snapshot();
  const text = JSON.stringify(snap);
  check('the screen data lists the WhatsApp numbers, the social accounts and the AI calling state', snap.whatsapp.numbers.length === 1 && snap.social[0].accounts[0].name === 'Page A' && snap.aiCalling.state === 'Connected', snap);
  check('no token, no secret and no encrypted value is in what a screen gets', !/SECRET-TOKEN|SHOULD-NOT-LEAK|tokenEnc|EMAIL-SECRET|SECRET-AI/.test(text), text);
  check('the screen data also has the email and SMS state, and which portal channels use TeamLink', snap.email && snap.email.teamlink && snap.email.teamlink.host === 'mail.zz.test' && snap.sms && snap.sms.teamlink.provider === 'SMSGW' && snap.bridge && snap.bridge.inUse && snap.bridge.inUse.whatsapp === true, snap);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
