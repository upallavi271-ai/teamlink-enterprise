// The bulk button hands the ticked people to TeamLink (Kavya). No network: a stub plays TeamLink's portal door.
//   node --test job-portal-app/embed/test/kavya-campaign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeCampaign } from '../kavya-campaign.mjs';

const ROWS = [
  { id: 'c1', name: 'A', phone: '9030048228', email: 'a@x.test', do_not_contact: false },
  { id: 'c2', name: 'B', phone: '', email: 'b@x.test', do_not_contact: false },
  { id: 'c3', name: 'C', phone: '9000000001', email: 'c@x.test', do_not_contact: true },
  { id: 'c4', name: 'D', phone: '9000000002', email: 'd@x.test', do_not_contact: false },
];
const mk = (over = {}) => ({
  resolveSession: async (t) => (t === 'tok' ? { userId: 'u1', role: 'recruiter' } : null),
  withUser: async (_s, fn) => fn({ query: async (sql) => (/from users/.test(sql) ? { rows: [{ email: 'rec@x.test' }] } : { rows: ROWS }) }),
  api: 'http://tl.test', secret: 'sec', ...over,
});
const req = (b, cookie = 'tl_session=tok') => ({ body: b, headers: { cookie } });

test('not signed in -> 401, nothing sent', async () => {
  let called = false;
  const r = await placeCampaign(req({ jobId: 'tl_1', candidateIds: ['c1'] }, ''), mk({ fetchFn: async () => { called = true; } }));
  assert.equal(r.status, 401); assert.equal(called, false);
});
test('local skips (no phone / DND / unknown) + TeamLink answer are merged truthfully', async () => {
  let seen;
  const fetchFn = async (url, o) => { seen = { url, o }; return { ok: true, status: 200, json: async () => ({ campaign: { id: 'run1' }, queued: [{ candidateId: 'c1' }], skipped: [{ candidateId: 'c4', reason: 'Not in TeamLink yet' }] }) }; };
  const r = await placeCampaign(req({ jobId: 'tl_1', candidateIds: ['c1', 'c2', 'c3', 'c4', 'zz'] }), mk({ fetchFn }));
  assert.equal(r.status, 201);
  assert.equal(r.body.campaign.queued, 1); assert.equal(r.body.campaign.skipped, 4);
  assert.deepEqual(r.body.skipped.map((s) => s.candidateId).sort(), ['c2', 'c3', 'c4', 'zz']);
  assert.equal(seen.url, 'http://tl.test/api/ai-calling/portal/kavya-campaign');
  assert.equal(seen.o.headers['x-job-portal-secret'], 'sec'); assert.equal(seen.o.headers['x-portal-user-email'], 'rec@x.test');
  assert.deepEqual(JSON.parse(seen.o.body).candidates.map((c) => c.id), ['c1', 'c4']);
});
test('TeamLink refuses -> real reason, queued 0, no fallback', async () => {
  const fetchFn = async () => ({ ok: false, status: 422, json: async () => ({ error: 'AI calling is Off', code: 'off', skipped: [] }) });
  const r = await placeCampaign(req({ jobId: 'tl_1', candidateIds: ['c1'] }), mk({ fetchFn }));
  assert.equal(r.status, 422); assert.match(r.body.error, /AI calling is Off/); assert.equal(r.body.campaign.queued, 0);
});
test('TeamLink down -> 502 and it says no calls were placed', async () => {
  const r = await placeCampaign(req({ jobId: 'tl_1', candidateIds: ['c1'] }), mk({ fetchFn: async () => { throw new Error('ECONNREFUSED'); } }));
  assert.equal(r.status, 502); assert.match(r.body.error, /No calls were placed/);
});
