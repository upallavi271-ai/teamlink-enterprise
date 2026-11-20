// Offline check of utils/loginSms.js + smsGateway.loginText (stubs for prisma and the SMS config): node scripts/login-sms-test.js
const path = require('path'); const assert = require('assert');
const src = path.join(__dirname, '..', 'src');
const stub = (rel, exp) => { const f = require.resolve(path.join(src, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const store = {};
stub('db.js', { integration: { findUnique: async ({ where }) => store[where.id] || null, upsert: async ({ where, create, update }) => { store[where.id] = store[where.id] ? { ...store[where.id], ...update } : create; } } });
let CFG = { configured: true, provider: 'SMSGW', templates: { login: '1677100000000397970' }, loginText: 'Your TeamLink login ID is {login_id}. Set your password: {url} - TeamLink' };
const real = require(path.join(src, 'utils/smsGateway.js'));
const gw = { ...real, smsConfig: async () => CFG };
stub('utils/smsGateway.js', gw);
const L = require(path.join(src, 'utils/loginSms.js'));
(async () => {
  assert.equal(real.loginText({ templates: { login: '1' }, loginText: 'ID {login_id} link {url}' }, 'a@b.c', 'https://u/x'), 'ID a@b.c link https://u/x');
  assert.equal(real.loginText({ templates: { login: '' }, loginText: 'ID {login_id} link {url}' }, 'a', 'u'), null); // no template id
  assert.equal(real.loginText({ templates: { login: '1' }, loginText: 'ID {login_id} only' }, 'a', 'u'), null); // a place missing
  const sent = [];
  const send = async (o) => { sent.push(o); return { ok: true, providerRef: 'ACK9', provider: 'SMSGW' }; };
  const a = await L.sendOne({ to: '9030048228', loginId: 'ravi@x.test', url: 'https://t/reset-password?token=abc', send });
  assert.equal(a.status, 'sent'); assert.equal(a.providerRef, 'ACK9');
  assert.equal(sent[0].templateId, '1677100000000397970');
  assert.equal(sent[0].text, 'Your TeamLink login ID is ravi@x.test. Set your password: https://t/reset-password?token=abc - TeamLink'); // the approved text, word for word
  assert.equal(sent[0].kind, 'login');
  const b = await L.sendOne({ to: '+91 90300 48228', loginId: 'RAVI@x.test', url: 'https://t/reset-password?token=zzz', send });
  assert.equal(b.status, 'duplicate'); assert.equal(sent.length, 1); // same number + login ID: nothing leaves
  const c = await L.sendOne({ to: '9030048228', loginId: 'other@x.test', url: 'https://t/y', send });
  assert.equal(c.status, 'sent'); assert.equal(sent.length, 2);
  CFG = { ...CFG, loginText: '' };
  assert.equal((await L.sendOne({ to: '9111111111', loginId: 'q@x.test', url: 'https://t/y', send })).status, 'off'); // text not saved: nothing sent
  CFG = { ...CFG, loginText: 'ID {login_id} {url}' };
  const fail = await L.sendOne({ to: '9222222222', loginId: 'f@x.test', url: 'https://t/y', send: async () => ({ ok: false, error: 'refused', transient: false }) });
  assert.equal(fail.status, 'failed');
  const retry = await L.sendOne({ to: '9222222222', loginId: 'f@x.test', url: 'https://t/y', send });
  assert.equal(retry.status, 'sent'); // a failed one is not remembered as sent
  console.log('login-sms: OK');
})().catch((e) => { console.error(e); process.exit(1); });
