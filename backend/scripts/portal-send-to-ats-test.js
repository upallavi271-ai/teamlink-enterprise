// Offline check of utils/portalSendToAts.js (stubs for prisma, identity and the bridge): node scripts/portal-send-to-ats-test.js
const path = require('path'); const assert = require('assert');
const src = path.join(__dirname, '..', 'src');
const stub = (rel, exp) => { const f = require.resolve(path.join(src, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
stub('db.js', { requirement: { findUnique: async ({ where }) => ({ r1: { id: 'r1', status: 'OPEN' }, r2: { id: 'r2', status: 'CLOSED' } })[where.id] || null } });
stub('utils/jobPortalBridge.js', { ingestApplication: async () => ({}) });
stub('utils/portalOmniMirror.js', { identityFor: async () => null });
const { sendToAts } = require(path.join(src, 'utils/portalSendToAts.js'));
(async () => {
  const who = async (e) => (e === 'rec@x.test' ? { id: 'u9', products: { ats: true } } : null);
  const got = [];
  const ingest = async (p) => { got.push(p); return p.candidate.id === 'c2' ? { status: 200, body: { duplicate: true, applicationId: 'A0' } } : { status: 201, body: { applicationId: 'A1', stage: 'NEW' } }; };
  const deps = { identityFor: who, ingest };
  const r = await sendToAts('rec@x.test', { requirementId: 'r1', candidates: [{ id: 'c1', name: 'Asha', email: 'a@x.test' }, { id: 'c2', name: 'Bala', phone: '9000000002' }, { id: 'c3', name: 'No Contact' }] }, deps);
  assert.deepEqual(r.results.map((x) => x.outcome), ['added', 'already', 'refused']);
  assert.equal(got[0].requirementId, 'r1');
  assert.equal(got[0].ownerUserId, 'u9'); // the sending recruiter owns the application, so it is in their list
  assert.equal(got[0].application.id, 'ats_c1_r1');
  assert.equal((await sendToAts('rec@x.test', { requirementId: 'r2', candidates: [{ id: 'c1', name: 'A', email: 'a@x' }] }, deps)).status, 409);
  assert.equal((await sendToAts('nobody@x.test', { requirementId: 'r1', candidates: [] }, deps)).status, 403);
  console.log('portal-send-to-ats: OK');
})().catch((e) => { console.error(e); process.exit(1); });
