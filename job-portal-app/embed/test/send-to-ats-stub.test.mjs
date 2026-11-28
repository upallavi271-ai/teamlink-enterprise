// Send to ATS for an unpublished requirement goes to the ATS; everything else stays the portal's own. No network, no database.
//   node --test job-portal-app/embed/test/send-to-ats-stub.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToAtsForStubs } from '../send-to-ats-stub.mjs';

const JOBS = {
  tl_stub: { id: 'tl_stub', title: 'Lecturer', status: 'closed', description: '[tl-status:OPEN]' },
  tl_live: { id: 'tl_live', title: 'Nurse', status: 'open', description: 'About the job' },
  tl_shut: { id: 'tl_shut', title: 'Old', status: 'closed', description: '[tl-status:CLOSED]' },
};
const mk = (over = {}) => {
  const calls = [];
  const deps = {
    withUser: async (_s, fn) => fn({ query: async (sql, p) => {
      if (/from jobs/.test(sql)) return { rows: JOBS[p[0]] ? [JOBS[p[0]]] : [] };
      if (/from users/.test(sql)) return { rows: [{ email: 'rec@x.test' }] };
      return { rows: [{ id: 'c1', name: 'Asha', email: 'a@x.test', phone: '9000000001' }] };
    } }),
    guard: [(req, _res, next) => { req.session = { userId: 'u1', role: 'recruiter' }; next(); }],
    api: 'http://tl.test', secret: 's',
    fetchImpl: async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, json: async () => ({ results: [{ candidateId: 'c1', name: 'Asha', outcome: 'added', applicationId: 'A1' }] }) }; },
    ...over,
  };
  return { deps, calls };
};
const run = async (deps, body) => {
  let sent; let status = 200; let passed = false; let failed = null;
  const res = { json: (b) => { sent = b; return res; }, status: (n) => { status = n; return res; } };
  await sendToAtsForStubs(deps)({ body, headers: {} }, res, (e) => { if (e) failed = e; else passed = true; });
  return { sent, status, passed, failed };
};

test('an unpublished open requirement: the candidates go to the ATS and the answer has the portal shape', async () => {
  const { deps, calls } = mk();
  const r = await run(deps, { jobId: 'tl_stub', candidateIds: ['c1', 'zz'] });
  assert.equal(r.sent.added, 1);
  assert.equal(r.sent.refused, 1); // zz is not visible
  assert.equal(r.sent.job.title, 'Lecturer');
  assert.equal(calls[0].u, 'http://tl.test/api/public/job-portal/send-to-ats');
  assert.equal(calls[0].o.headers['x-portal-user-email'], 'rec@x.test');
  assert.equal(JSON.parse(calls[0].o.body).requirementId, 'stub');
});

test('published, closed-in-ATS and unknown jobs are left to the portal', async () => {
  for (const jobId of ['tl_live', 'tl_shut', 'tl_none', 'job_1']) {
    const { deps, calls } = mk();
    const r = await run(deps, { jobId, candidateIds: ['c1'] });
    assert.equal(r.passed, true, jobId);
    assert.equal(calls.length, 0);
  }
});

test('a guard refusal (sign-in / CSRF) stops it; nothing is sent', async () => {
  const { deps, calls } = mk({ guard: [(_q, _s, next) => next(new Error('CSRF'))] });
  const r = await run(deps, { jobId: 'tl_stub', candidateIds: ['c1'] });
  assert.match(r.failed.message, /CSRF/);
  assert.equal(calls.length, 0);
});

test('the ATS refusing is said as it is', async () => {
  const { deps } = mk({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'That requirement is closed in the ATS.' }) }) });
  const r = await run(deps, { jobId: 'tl_stub', candidateIds: ['c1'] });
  assert.equal(r.status, 409);
  assert.match(r.sent.error.message, /closed in the ATS/);
});
