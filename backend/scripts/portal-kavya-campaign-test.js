// Offline check of calling/kavya/portalCampaign.js (stubs for prisma, the bridge and Kavya's createRuns): node scripts/portal-kavya-campaign-test.js
const path = require('path');
const assert = require('assert');
const src = path.join(__dirname, '..', 'src');
const stub = (rel, exp) => { const f = require.resolve(path.join(src, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const apps = { 'k1|r1': 'app1', 'k2|r1': 'app2' };
stub('db.js', { requirement: { findUnique: async ({ where }) => (where.id === 'r1' ? { id: 'r1' } : null) }, application: { findUnique: async ({ where }) => { const id = apps[`${where.candidateId_requirementId.candidateId}|${where.candidateId_requirementId.requirementId}`]; return id ? { id } : null; } } });
stub('utils/jobPortalBridge.js', { findCandidateByContact: async ({ phone }) => ({ 9030048228: { id: 'k1' }, 9111111111: { id: 'k2' }, 9222222222: { id: 'k3' } })[String(phone)] || null });
let got;
stub('calling/kavya/service.js', { createRuns: async (_u, b) => { got = b; return { ok: true, id: 'run1', skipped: [{ applicationId: 'app2', name: 'B', reason: 'Candidate opted out (DND).' }], note: '' }; } });
const { placeCampaign } = require(path.join(src, 'calling/kavya/portalCampaign.js'));
(async () => {
  const r = await placeCampaign({ id: 'u' }, { jobId: 'tl_r1', candidates: [{ id: 'p1', phone: '9030048228' }, { id: 'p2', phone: '9111111111' }, { id: 'p3', phone: '9222222222' }, { id: 'p4', phone: '9333333333' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(got, { applicationIds: ['app1', 'app2'], source: 'portal', start: true });
  assert.deepEqual(r.queued.map((q) => q.candidateId), ['p1']);
  assert.deepEqual(r.skipped.map((s) => s.candidateId).sort(), ['p2', 'p3', 'p4']);
  assert.equal(r.skipped.find((s) => s.candidateId === 'p2').reason, 'Candidate opted out (DND).');
  assert.equal(r.campaign.queued, 1); assert.equal(r.campaign.skipped, 3);
  const bad = await placeCampaign({}, { jobId: 'job_9', candidates: [{ id: 'p1' }] });
  assert.equal(bad.ok, false); assert.equal(bad.skipped.length, 1);
  console.log('portal-kavya-campaign: OK');
})().catch((e) => { console.error(e); process.exit(1); });
