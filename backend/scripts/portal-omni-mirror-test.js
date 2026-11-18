// Offline check of utils/portalOmniMirror.js (stubs for prisma, identity, the hub and campaigns): node scripts/portal-omni-mirror-test.js
const path = require('path'); const assert = require('assert');
const src = path.join(__dirname, '..', 'src');
const stub = (rel, exp) => { const f = require.resolve(path.join(src, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('db.js', { user: { findMany: async ({ where }) => (where.email.in.includes('rec@x.test') ? [{ id: 'u1' }] : []) } });
stub('utils/identity.js', { resolveIdentity: async (id) => ({ id, role: 'RECRUITER' }) });
stub('outreach/hub.js', { list: async (u, o) => { assert.equal(o.channel, 'WhatsApp'); return { items: [
  { key: 'outreach:1', source: 'outreach', name: 'Doctors', channel: 'WhatsApp', body: 'Hi', where: ['Omni-Channel'], department: 'Medical', wa: { status: 'Approved', name: 'doctors_v1' }, updatedAt: 'x', byName: 'Ravi' },
  { key: 'job:2', source: 'job', name: 'A job', channel: 'WhatsApp', where: ['Job Portal'] }] }; } });
stub('outreach/campaigns.js', { list: async () => ({ campaigns: [
  { id: 'c1', name: 'Blast', channel: 'whatsapp', status: 'running', templateName: 'Doctors', counts: { total: 10, sent: 4, delivered: 3, read: 1, failed: 0, waiting: 6 }, createdByName: 'Ravi', createdAt: 'y' },
  { id: 'c2', name: 'Mail', channel: 'email', status: 'done' }] }) });
const M = require(path.join(src, 'utils/portalOmniMirror.js'));
(async () => {
  const t = await M.omniTemplates('rec@x.test');
  assert.equal(t.ok, true); assert.equal(t.templates.length, 1);
  assert.equal(t.templates[0].id, 'omni:outreach:1'); assert.equal(t.templates[0].approval, 'approved'); assert.equal(t.templates[0].canEdit, false); assert.equal(t.templates[0].department, 'Medical');
  const c = await M.omniCampaigns('rec@x.test');
  assert.equal(c.campaigns.length, 1); assert.equal(c.campaigns[0].status, 'running'); assert.equal(c.campaigns[0].pending, 6);
  assert.equal((await M.omniTemplates('nobody@x.test')).ok, false);
  const ok = M.portalShape({ id: 'omni_1', name: 'Doctors', body: 'Hi {{name}}, {{job_title}} at {{company}}: {{apply_link}}', waName: 'doctors_v1', language: 'te' });
  assert.equal(ok.row.body, 'Hi {{candidate_name}}, {{job_title}} at {{company_name}}: {{job_link}}');
  assert.deepEqual(ok.row.params, ['candidate_name', 'job_title', 'company_name', 'job_link']);
  assert.equal(ok.row.language, 'te');
  assert.ok(M.portalShape({ id: 'x', name: 'Unsub', body: 'Hi {{name}} {{unsubscribe}}', waName: 'u', language: 'en' }).skip);
  console.log('portal-omni-mirror: OK');
})().catch((e) => { console.error(e); process.exit(1); });
