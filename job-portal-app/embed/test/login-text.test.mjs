// The login reaches a candidate who has only a phone number (teamlink-integration.mjs loginMessage / installLoginText).
//   node --test job-portal-app/embed/test/login-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { loginMessage, installLoginText } = await import(pathToFileURL(join(import.meta.dirname, '..', 'teamlink-integration.mjs')).href);

const vars = { to_name: 'Ravi Kumar', candidate_name: 'Ravi Kumar', company_name: 'TeamLink Consultants',
  portal_link: 'https://teamlink.teamlinks.in/jobs/#/login/candidate', login_email: '9876543210', temporary_password: 'Tmp-4821' };

test('SMS to a phone-only candidate carries the login, the password and the TeamLink link', () => {
  const out = loginMessage('sms', { to: '9876543210', vars, text: 'TeamLink: You have been added ... https://x' });
  assert.match(out.text, /Login \(your mobile number\): 9876543210/);
  assert.match(out.text, /Password: Tmp-4821/);
  assert.match(out.text, /https:\/\/teamlink\.teamlinks\.in\/jobs\/#\/login\/candidate/);
  assert.match(out.text, /^TeamLink: Hi Ravi,/);
  assert.ok(out.text.length <= 320);
});

test('SMS with an email login says Login, not mobile number', () => {
  const out = loginMessage('sms', { vars: { ...vars, login_email: 'ravi@example.com' }, text: 'x' });
  assert.match(out.text, /Login: ravi@example\.com Password: Tmp-4821/);
});

test('WhatsApp calls a number login "Login (mobile number)"', () => {
  const out = loginMessage('whatsapp', { vars, text: '*TeamLink*\n\nLogin Email: 9876543210\nTemporary Password: Tmp-4821\n\nhttps://x' });
  assert.match(out.text, /Login \(mobile number\): 9876543210/);
  assert.doesNotMatch(out.text, /Login Email/);
  assert.match(out.text, /Temporary Password: Tmp-4821/);
});

test('messages without a new password pass unchanged', () => {
  const a = { vars: { ...vars, temporary_password: '' }, text: 'TeamLink: an interview reminder' };
  assert.equal(loginMessage('sms', a), a);
  const b = { vars: ['agreement', 'vars'], text: 'x' };
  assert.equal(loginMessage('sms', b), b);
  const c = { vars, text: 'email body' };
  assert.equal(loginMessage('email', c), c);
});

test('installLoginText wraps sms + whatsapp once and leaves email alone', async () => {
  const seen = [];
  const providers = {
    sms: { send: async (x) => { seen.push(['sms', x.text]); return { status: 'sent' }; } },
    whatsapp: { send: async (x) => { seen.push(['whatsapp', x.text]); return { status: 'sent' }; } },
    email: { send: async (x) => { seen.push(['email', x.text]); return { status: 'sent' }; } },
  };
  assert.equal(installLoginText(providers), true);
  assert.equal(installLoginText(providers), false);
  await providers.sms.send({ vars, text: 'old' });
  await providers.email.send({ vars, text: 'mail' });
  assert.match(seen[0][1], /Password: Tmp-4821/);
  assert.deepEqual(seen[1], ['email', 'mail']);
});
