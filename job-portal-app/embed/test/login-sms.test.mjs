// The candidate login SMS with a setup link goes to TeamLink only when it is ready; otherwise the usual SMS stays. No network (stub TeamLink).
//   node --test job-portal-app/embed/test/login-sms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoginSms, makeSetupLink, sendLoginSetupSms } from '../login-sms.mjs';

const args = { to: '9030048228', vars: { login_email: 'ravi@x.test', temporary_password: 'Tmp#1234', candidate_name: 'Ravi' }, text: 'x' };

test('only a message carrying a NEW login is a login SMS', () => {
  assert.equal(isLoginSms(args), true);
  assert.equal(isLoginSms({ to: '9030048228', vars: { x: 1 }, text: 'hello' }), false);
  assert.equal(isLoginSms({ to: '', vars: args.vars }), false);
});

test('the setup link is the candidate own reset token (a number login uses the stand-in address)', async () => {
  const seen = [];
  const deps = {
    newSessionToken: () => ({ token: 'tok123', hash: 'h' }),
    withUser: async (_s, fn) => fn({ query: async (sql, p) => { seen.push(p); return { rows: [{ user_id: 'u1' }] }; } }),
    origin: 'https://teamlink.teamlinks.in/jobs/',
  };
  assert.equal(await makeSetupLink('ravi@x.test', deps), 'https://teamlink.teamlinks.in/jobs/reset-password?token=tok123');
  assert.equal(seen[0][0], 'ravi@x.test');
  await makeSetupLink('9030048228', deps);
  assert.equal(seen[1][0], '9030048228@phone.invalid');
  assert.ok(seen[0][2] - Date.now() > 6 * 86400000); // valid for days, not minutes
  const none = { ...deps, withUser: async (_s, fn) => fn({ query: async () => ({ rows: [] }) }) };
  assert.equal(await makeSetupLink('nobody@x.test', none), null);
});

const dep = (answer) => {
  const calls = [];
  return { calls, deps: { api: 'http://tl.test', secret: 's', makeLink: async () => 'https://x/reset-password?token=t', fetchImpl: async (u, o) => { calls.push({ u, o }); return { json: async () => answer }; } } };
};

test('sent / duplicate: handled, with login ID and link, no password in what goes to TeamLink', async () => {
  const { calls, deps } = dep({ ok: true, status: 'sent', providerRef: 'ACK1' });
  const r = await sendLoginSetupSms(args, deps);
  assert.equal(r.handled, true);
  assert.equal(r.result.status, 'sent');
  const body = JSON.parse(calls[0].o.body);
  assert.deepEqual(Object.keys(body).sort(), ['loginId', 'to', 'url']);
  assert.equal(body.loginId, 'ravi@x.test');
  assert.equal(calls[0].o.headers['x-job-portal-secret'], 's');
  assert.equal((await sendLoginSetupSms(args, dep({ ok: true, status: 'duplicate' }).deps)).handled, true);
});

test('off / failed / unreachable: not handled, so the usual SMS goes', async () => {
  assert.equal((await sendLoginSetupSms(args, dep({ ok: false, status: 'off', reason: 'template not saved' }).deps)).handled, false);
  assert.equal((await sendLoginSetupSms(args, dep({ ok: false, status: 'failed' }).deps)).handled, false);
  const down = { api: 'http://tl.test', secret: 's', makeLink: async () => 'https://x/y', fetchImpl: async () => { throw new Error('down'); } };
  assert.equal((await sendLoginSetupSms(args, down)).handled, false);
  assert.equal((await sendLoginSetupSms(args, { ...down, makeLink: async () => null })).handled, false);
});
