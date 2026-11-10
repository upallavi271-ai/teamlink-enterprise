// Forgot password for a candidate with no login yet (teamlink-integration.mjs forgotWithoutLogin). No database: a fake withUser.
//   node --test job-portal-app/embed/test/forgot-without-login.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { forgotWithoutLogin, FORGOT_ANSWER } = await import(pathToFileURL(join(import.meta.dirname, '..', 'teamlink-integration.mjs')).href);

function world({ users = [], candidates = [], invite = { invited: true, accountCreated: true } } = {}) {
  const queries = [];
  const invited = [];
  const withUser = async (_who, fn) => fn({
    async query(sql, params) {
      queries.push(sql);
      if (/from users/.test(sql)) return { rows: users.filter((u) => u.email.toLowerCase() === params[0]).map(() => ({ '?column?': 1 })) };
      if (/from candidates/.test(sql)) return { rows: candidates.filter((c) => (c.email || '').toLowerCase() === params[0]).slice(0, 1) };
      throw new Error(`unexpected sql ${sql}`);
    },
  });
  const loadInvite = async () => ({ inviteCandidate: async (cand, opts) => { invited.push({ cand, opts }); return invite; } });
  return { withUser, loadInvite, seen: new Map(), queries, invited };
}

test('an address with an account goes to the portal\'s own reset, nothing is invited', async () => {
  const w = world({ users: [{ email: 'Ravi@Example.com' }], candidates: [{ id: 'c1', name: 'Ravi', email: 'ravi@example.com' }] });
  const out = await forgotWithoutLogin('  ravi@example.COM ', w);
  assert.equal(out.handled, false);
  assert.equal(w.invited.length, 0);
});

test('a candidate without a login is invited: account made and the login mailed', async () => {
  const w = world({ candidates: [{ id: 'c2', name: 'Sita', email: 'Sita@Example.com', phone: '9876543210', user_id: null, do_not_contact: false }] });
  const out = await forgotWithoutLogin('sita@example.com', w);
  assert.deepEqual(out, { handled: true, result: 'invited', reason: null, delivery: null });
  assert.equal(w.invited.length, 1);
  assert.deepEqual(w.invited[0].cand, { id: 'c2', name: 'Sita', email: 'sita@example.com', phone: '9876543210' });
  assert.equal(w.invited[0].opts.invitedBy, 'Forgot password');
});

test('pressed again within 15 minutes: no second invite, same answer', async () => {
  const w = world({ candidates: [{ id: 'c3', name: 'Anu', email: 'anu@example.com', user_id: null, do_not_contact: false }] });
  const t0 = Date.parse('2026-11-10T10:00:00Z');
  await forgotWithoutLogin('anu@example.com', { ...w, now: t0 });
  const again = await forgotWithoutLogin('anu@example.com', { ...w, now: t0 + 5 * 60 * 1000 });
  assert.deepEqual(again, { handled: true, result: 'recent' });
  const later = await forgotWithoutLogin('anu@example.com', { ...w, now: t0 + 16 * 60 * 1000 });
  assert.equal(later.result, 'invited');
  assert.equal(w.invited.length, 2);
});

test('do-not-contact is never written to, but the screen answer is the same', async () => {
  const w = world({ candidates: [{ id: 'c4', name: 'X', email: 'dnc@example.com', user_id: null, do_not_contact: true }] });
  const out = await forgotWithoutLogin('dnc@example.com', w);
  assert.deepEqual(out, { handled: true, result: 'do-not-contact' });
  assert.equal(w.invited.length, 0);
});

test('unknown addresses, bad input and a login under another address fall through to the portal', async () => {
  const w = world({ candidates: [{ id: 'c5', name: 'Y', email: 'other@example.com', user_id: 'u9', do_not_contact: false }] });
  assert.equal((await forgotWithoutLogin('nobody@example.com', w)).handled, false);
  assert.equal((await forgotWithoutLogin('not-an-email', w)).handled, false);
  assert.equal((await forgotWithoutLogin(undefined, w)).handled, false);
  assert.equal((await forgotWithoutLogin('other@example.com', w)).handled, false);
  assert.equal(w.invited.length, 0);
});

test('a candidate with no name still gets a name from the address; a portal refusal is reported, not thrown', async () => {
  const w = world({ candidates: [{ id: 'c6', name: '', email: 'kiran.k@example.com', user_id: null, do_not_contact: false }], invite: { invited: false, reason: 'already invited' } });
  const out = await forgotWithoutLogin('kiran.k@example.com', w);
  assert.deepEqual(out, { handled: true, result: 'already', reason: 'already invited', delivery: null });
  assert.equal(w.invited[0].cand.name, 'kiran.k');
});

test('the screen answer is the portal\'s own wording', () => {
  assert.equal(FORGOT_ANSWER.message, "If an account exists for this email, we've sent a password reset link.");
});

test('the log hides most of the address and never stores more than the domain and two letters', async () => {
  const { maskEmail } = await import(pathToFileURL(join(import.meta.dirname, '..', 'teamlink-integration.mjs')).href);
  assert.equal(maskEmail(' Ravikumar@Gmail.com '), 'ra***@gmail.com');
  assert.equal(maskEmail('nonsense'), '(not an email)');
  assert.equal(maskEmail(undefined), '(not an email)');
});

test('an account is reported with its role and status; an invite passes its delivery back', async () => {
  const w = world({ users: [{ email: 'a@example.com' }] });
  const acc = await forgotWithoutLogin('a@example.com', w);
  assert.equal(acc.why, 'has an account');
  assert.ok(acc.account && 'status' in acc.account && 'role' in acc.account);
  const w2 = world({ candidates: [{ id: 'c7', name: 'B', email: 'b@example.com', user_id: null, do_not_contact: false }], invite: { invited: true, delivery: { email: 'sent' } } });
  const inv = await forgotWithoutLogin('b@example.com', w2);
  assert.deepEqual(inv.delivery, { email: 'sent' });
});
