// Offline check of calling/kavya/portalCampaign.js (stubs for prisma, the bridge and Kavya's createRuns): node scripts/portal-kavya-campaign-test.js
const path = require('path');
const assert = require('assert');
const src = path.join(__dirname, '..', 'src');
const stub = (rel, exp) => { const f = require.resolve(path.join(src, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const apps = { 'k1|r1': 'app1', 'k2|r1': 'app2' };
const made = { cand: [], app: [], req: [] };
stub('utils/atsVocab.js', { PORTAL_APPLICATION_SOURCE: 'TeamLink Job Portal' });
stub('db.js', { client: { findFirst: async () => ({ id: 'cl1' }) }, candidate: { create: async ({ data }) => { made.cand.push(data); return { id: 'knew' }; } }, requirement: { findUnique: async ({ where }) => (where.id === 'r1' ? { id: 'r1' } : where.reqCode === 'PORTAL-job_9' && made.req.length ? { id: 'rp', reqCode: where.reqCode } : null), create: async ({ data }) => { made.req.push(data); return { id: 'rp' }; } }, application: { findUnique: async ({ where }) => { const id = apps[`${where.candidateId_requirementId.candidateId}|${where.candidateId_requirementId.requirementId}`]; return id ? { id } : null; }, create: async ({ data }) => { made.app.push(data); return { id: `new-${data.candidateId}` }; } } });
stub('utils/jobPortalBridge.js', { findCandidateByContact: async ({ phone }) => ({ 9030048228: { id: 'k1' }, 9111111111: { id: 'k2' }, 9222222222: { id: 'k3' } })[String(phone)] || null });
let got;
stub('calling/kavya/service.js', { createRuns: async (_u, b) => { got = b; return { ok: true, id: 'run1', skipped: [{ applicationId: 'app2', name: 'B', reason: 'Candidate opted out (DND).' }], note: '' }; } });
const { placeCampaign } = require(path.join(src, 'calling/kavya/portalCampaign.js'));
(async () => {
  const r = await placeCampaign({ id: 'u' }, { jobId: 'tl_r1', candidates: [{ id: 'p1', phone: '9030048228' }, { id: 'p2', phone: '9111111111' }, { id: 'p3', phone: '9222222222' }, { id: 'p4', phone: '9333333333' }] });
  assert.equal(r.ok, true);
  assert.equal(got.applicationIds.length, 4); // p3 and p4 were not in TeamLink: candidate + application made for them
  assert.equal(made.cand.length, 1); // 9222222222 matched k3, only 9333333333 is new
  assert.deepEqual(r.queued.map((q) => q.candidateId).sort(), ['p1', 'p3', 'p4']);
  assert.deepEqual(r.skipped.map((s) => s.candidateId), ['p2']);
  assert.equal(r.skipped.find((s) => s.candidateId === 'p2').reason, 'Candidate opted out (DND).');
  assert.equal(r.campaign.queued, 3); assert.equal(r.campaign.skipped, 1);
  const bad = await placeCampaign({}, { jobId: 'job_9', candidates: [{ id: 'p1' }] });
  assert.equal(bad.ok, false); assert.equal(bad.skipped.length, 1); // no job title -> truthful refusal, nothing made
  const own = await placeCampaign({ id: 'u' }, { jobId: 'job_9', job: { title: 'Nurse', location: 'Hyderabad' }, candidates: [{ id: 'p1', phone: '9030048228' }] });
  assert.equal(own.ok, true); assert.equal(made.req.length, 1); assert.equal(made.req[0].reqCode, 'PORTAL-job_9'); assert.equal(made.req[0].status, 'OPEN');
  console.log('portal-kavya-campaign: OK');
})().catch((e) => { console.error(e); process.exit(1); });
