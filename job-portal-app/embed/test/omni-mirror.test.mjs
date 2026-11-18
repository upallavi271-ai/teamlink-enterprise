// The portal's Templates & Campaigns list gets the Omni-Channel WhatsApp rows added; no network (stub TeamLink).
//   node --test job-portal-app/embed/test/omni-mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { omniMirror } from '../omni-mirror.mjs';

const OMNI = [{ id: 'omni:outreach:1', name: 'Doctors hiring', channel: 'whatsapp', department: 'Medical', approval: 'approved', body: 'Hi {{1}}' }];
const deps = (over = {}) => ({
  resolveSession: async (t) => (t === 'tok' ? { userId: 'u1' } : null), emailOf: async () => 'rec@x.test', api: 'http://tl.test', secret: 's',
  fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, templates: OMNI }) }), ...over,
});
const run = async (d, req) => {
  let out; let nexted = false;
  const res = { json: (b) => { out = b; return b; } };
  await omniMirror('templates', d)({ query: {}, headers: { cookie: 'tl_session=tok' }, ...req }, res, () => { nexted = true; });
  if (nexted) res.json({ templates: [{ id: 'p1', name: 'Portal one' }], departments: ['HR'] });
  return out;
};
test('Omni rows are added in front of the portal rows, departments merged', async () => {
  const out = await run(deps(), {});
  assert.deepEqual(out.templates.map((t) => t.id), ['omni:outreach:1', 'p1']);
  assert.deepEqual(out.departments, ['HR', 'Medical']);
});
test('another channel / archived / no session / TeamLink down: the portal list is unchanged', async () => {
  for (const [d, req] of [[deps(), { query: { channel: 'sms' } }], [deps(), { query: { archived: 'true' } }], [deps(), { headers: { cookie: '' } }],
    [deps({ fetchFn: async () => { throw new Error('down'); } }), {}]]) {
    const out = await run(d, req);
    assert.deepEqual(out.templates.map((t) => t.id), ['p1']);
  }
});
