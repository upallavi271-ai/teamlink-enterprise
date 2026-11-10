// The candidate login also goes by RCS (embed/rcs-login.mjs + teamlink-integration.mjs installLoginText). No network: a local stub
// plays TeamLink's POST /api/public/job-portal/rcs-login.
//   node --test job-portal-app/embed/test/rcs-login.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GOT = [];
let ANSWER = { ok: true, status: 'sent', msgId: 'ZZMSG1' };
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    GOT.push({ url: req.url, secret: req.headers['x-job-portal-secret'], body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ANSWER));
  });
});
let api = '';
before(async () => {
  await new Promise((r) => { stub.listen(0, '127.0.0.1', r); });
  api = `http://127.0.0.1:${stub.address().port}`;
  process.env.TEAMLINK_API_URL = api;
  process.env.JOB_PORTAL_PUSH_SECRET = 'zz-bridge-secret';
});
after(() => stub.close());

const vars = { to_name: 'Ravi Kumar', candidate_name: 'Ravi Kumar', company_name: 'TeamLink Consultants',
  portal_link: 'https://teamlink.teamlinks.in/jobs/#/login/candidate', login_email: '9876543210', temporary_password: 'Tmp-4821' };

const { isLoginMessage, withRcsLogin } = await import(pathToFileURL(join(import.meta.dirname, '..', 'rcs-login.mjs')).href);
const { installLoginText } = await import(pathToFileURL(join(import.meta.dirname, '..', 'teamlink-integration.mjs')).href);

test('only a message with a new password to a number is a login message', () => {
  assert.equal(isLoginMessage({ to: '9876543210', vars }), true);
  assert.equal(isLoginMessage({ vars }), false);
  assert.equal(isLoginMessage({ to: '9876543210', vars: { ...vars, temporary_password: '' } }), false);
  assert.equal(isLoginMessage({ to: '9876543210', vars: ['a', 'b'] }), false);
});

test('the login goes to TeamLink with the bridge secret; the SMS answer stands when the SMS left', async () => {
  GOT.length = 0;
  const sms = { status: 'sent', provider: 'teamlink-sms' };
  const out = await withRcsLogin({ to: '9876543210', vars, text: 'x' }, sms, { api, secret: 'zz-bridge-secret' });
  assert.equal(out, sms);
  assert.equal(GOT.length, 1);
  assert.equal(GOT[0].url, '/api/public/job-portal/rcs-login');
  assert.equal(GOT[0].secret, 'zz-bridge-secret');
  assert.deepEqual(GOT[0].body, { to: '9876543210', vars: { candidate_name: 'Ravi Kumar', login_email: '9876543210', temporary_password: 'Tmp-4821', portal_link: vars.portal_link } });
});

test('SMS failed but RCS accepted: the portal is told "sent" by teamlink-rcs (so a resend keeps the new password)', async () => {
  ANSWER = { ok: true, status: 'sent', msgId: 'ZZMSG2' };
  const out = await withRcsLogin({ to: '9876543210', vars }, { status: 'not_configured', provider: 'teamlink-sms' }, { api, secret: 's' });
  assert.deepEqual(out, { status: 'sent', provider: 'teamlink-rcs', ref: 'ZZMSG2' });
});

test('SMS failed and RCS failed / skipped / unreachable: the SMS answer is passed on unchanged', async () => {
  const sms = { status: 'failed', provider: 'teamlink-sms', error: 'zz' };
  ANSWER = { ok: false, status: 'failed', reason: 'rcssms.in refused it' };
  assert.equal(await withRcsLogin({ to: '9876543210', vars }, sms, { api, secret: 's' }), sms);
  ANSWER = { ok: false, status: 'skipped', reason: 'template waiting' };
  assert.equal(await withRcsLogin({ to: '9876543210', vars }, sms, { api, secret: 's' }), sms);
  assert.equal(await withRcsLogin({ to: '9876543210', vars }, sms, { api: 'http://127.0.0.1:1', secret: 's', timeoutMs: 2000 }), sms);
});

test('a message without a login never calls TeamLink', async () => {
  GOT.length = 0;
  const sms = { status: 'sent' };
  assert.equal(await withRcsLogin({ to: '9876543210', vars: { ...vars, temporary_password: '' } }, sms, { api, secret: 's' }), sms);
  assert.equal(GOT.length, 0);
});

test('installLoginText: the SMS sends the login text, then the RCS; a replaced send (the SMS relay) is wrapped again', async () => {
  ANSWER = { ok: true, status: 'sent', msgId: 'ZZMSG3' };
  GOT.length = 0;
  const texts = [];
  const providers = {
    sms: { send: async (x) => { texts.push(x.text); return { status: 'failed', provider: 'zz-sms', error: 'down' }; } },
    whatsapp: { send: async () => ({ status: 'sent' }) },
  };
  assert.equal(installLoginText(providers), true);
  assert.equal(installLoginText(providers), false); // nothing new to wrap
  const r1 = await providers.sms.send({ to: '9876543210', vars, text: 'old' });
  assert.match(texts[0], /Password: Tmp-4821/);
  assert.deepEqual(r1, { status: 'sent', provider: 'teamlink-rcs', ref: 'ZZMSG3' });
  assert.equal(GOT.length, 1);
  // the relay puts a new send in place: installing again wraps that one (and only that one)
  providers.sms.send = async () => { throw new Error('zz relay down'); };
  assert.equal(installLoginText(providers), true);
  const r2 = await providers.sms.send({ to: '9876543210', vars, text: 'old' });
  assert.equal(r2.provider, 'teamlink-rcs');
  assert.equal(GOT.length, 2);
  await providers.whatsapp.send({ to: '9876543210', vars, text: 'Login Email: 9876543210' });
  assert.equal(GOT.length, 2); // WhatsApp never sends a second RCS
});
