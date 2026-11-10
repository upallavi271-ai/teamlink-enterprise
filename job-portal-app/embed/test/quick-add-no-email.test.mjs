// Add Candidate with a phone and no email (teamlink-integration.mjs isPhoneOnlyAdd / standInEmail / withoutStandIn).
//   node --test job-portal-app/embed/test/quick-add-no-email.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { isPhoneOnlyAdd, standInEmail, withoutStandIn } = await import(pathToFileURL(join(import.meta.dirname, '..', 'teamlink-integration.mjs')).href);

test('only a phone and no email is a phone-only add', () => {
  assert.equal(isPhoneOnlyAdd({ phone: '+91 9030048228', email: '' }), true);
  assert.equal(isPhoneOnlyAdd({ phone: '+91 9030048228' }), true);
  assert.equal(isPhoneOnlyAdd({ phone: '+91 9030048228', email: 'a@b.com' }), false);
  assert.equal(isPhoneOnlyAdd({ phone: '', email: '' }), false);
  assert.equal(isPhoneOnlyAdd(null), false);
  assert.equal(isPhoneOnlyAdd([]), false);
});

test('the stand-in is one-off and never left in an answer', () => {
  const a = standInEmail();
  assert.match(a, /^nomail-[0-9a-f]{16}@phone\.invalid$/);
  assert.notEqual(a, standInEmail());
  assert.deepEqual(withoutStandIn({ error: { message: `duplicate of ${a}`, details: { email: a } } }, a), { error: { message: 'duplicate of ', details: { email: '' } } });
});
