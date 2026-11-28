// The import wizards' job list shows every department near the top and names the department. node --test job-portal-app/embed/test/import-jobs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reshapeImportJobs, importJobsMiddleware } from '../import-jobs.mjs';

const med = Array.from({ length: 100 }, (_, i) => ({ id: `tl_m${i}`, title: `Doctor ${i} - Hosp (M-${i})`, status: 'closed', department: 'Medical' }));
const edu = [{ id: 'tl_e1', title: 'Lecturer - College (E-1)', status: 'closed', department: 'Education' }, { id: 'tl_e2', title: 'Teacher - School (E-2)', status: 'open', department: 'Education' }];
const man = [{ id: 'tl_f1', title: 'Fitter - Plant (F-1)', status: 'closed', department: 'Manufacturing' }];

test('every department is within the first rows, open roles first, and the department is in the label', () => {
  const out = reshapeImportJobs([...med, ...edu, ...man]);
  assert.equal(out.length, 103);
  const first = out.slice(0, 6);
  assert.deepEqual(new Set(first.map((j) => j.department)), new Set(['Medical', 'Education', 'Manufacturing']));
  assert.equal(out.find((j) => j.id === 'tl_e2').title, '[Education] Teacher - School (E-2)');
  assert.ok(out.findIndex((j) => j.id === 'tl_e2') < out.findIndex((j) => j.id === 'tl_e1')); // open before closed inside the department
  assert.ok(out.slice(0, 80).some((j) => j.id === 'tl_f1'));
  assert.deepEqual(new Set(out.map((j) => j.id)).size, 103); // nothing removed or doubled
});

test('a role with no department and an already labelled one are left alone', () => {
  const out = reshapeImportJobs([{ id: 'tl_x', title: 'Plain', status: 'open' }, { id: 'tl_y', title: '[Medical] Already', status: 'open', department: 'Medical' }]);
  assert.equal(out.find((j) => j.id === 'tl_x').title, 'Plain');
  assert.equal(out.find((j) => j.id === 'tl_y').title, '[Medical] Already');
  assert.deepEqual(reshapeImportJobs(null), []);
});

test('the middleware changes the jobs of the answer and nothing else', () => {
  let sent;
  const res = { json: (b) => { sent = b; return res; } };
  importJobsMiddleware()({}, res, () => {});
  res.json({ jobs: [...edu, ...man], other: 1 });
  assert.equal(sent.other, 1);
  assert.equal(sent.jobs.length, 3);
  assert.match(sent.jobs[0].title, /^\[/);
  res.json({ error: 'x' });
  assert.deepEqual(sent, { error: 'x' });
});

import { allowedKeys, deptKey, importJobsForDepartment } from '../import-jobs.mjs';

test('which departments a desk sees', () => {
  assert.deepEqual(allowedKeys('Education'), ['educ']);
  assert.deepEqual(allowedKeys('Educational'), ['educ']);
  assert.deepEqual(allowedKeys('Manufacturing').sort(), ['manu', 'medi', 'noni']);
  assert.deepEqual(allowedKeys('Medical').sort(), ['medi', 'noni']);
  assert.deepEqual(allowedKeys('Non IT').sort(), ['medi', 'noni']);
  assert.deepEqual(allowedKeys('Non IT Medical').sort(), ['medi', 'noni']);
  assert.deepEqual(allowedKeys('IT'), ['it']);
  assert.deepEqual(allowedKeys(''), []);
  assert.equal(deptKey('Non IT Medical'), 'noni');
});

const JOBS = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: `tl_m${i}`, title: `Doctor ${i}`, status: 'closed', department: 'Medical' })),
  { id: 'tl_n1', title: 'Radiographer', status: 'open', department: 'Non IT Medical' },
  { id: 'tl_e1', title: 'Lecturer', status: 'closed', department: 'Education', description: '[tl-status:CLOSED]' },
  { id: 'tl_e2', title: 'Teacher', status: 'closed', department: 'Education', description: '[tl-status:RECRUITER_ASSIGNED]' }, // a stub of a requirement still being worked
  { id: 'tl_f1', title: 'Fitter', status: 'closed', department: 'Manufacturing' },
];
const run2 = async ({ role = 'recruiter', dept = 'Education', q = '', cookie = 'tl_session=t' } = {}) => {
  let sent; let passed = false;
  const res = { json: (b) => { sent = b; return res; } };
  const deps = {
    cookieOf: (h, n) => (String(h || '').match(new RegExp(`${n}=([^;]+)`)) || [])[1] || '', cookieName: 'tl_session',
    resolveSession: async (t) => (t === 't' ? { role, profileId: role === 'admin' ? null : 'r1' } : null),
    withUser: async (_s, fn) => fn({ query: async (sql) => (/from recruiters/.test(sql) ? { rows: [{ department: dept }] } : { rows: JOBS }) }),
  };
  await importJobsForDepartment(deps)({ headers: { cookie }, query: { q } }, res, () => { passed = true; });
  return { sent, passed };
};
test('an Education recruiter gets every Education role, open and closed, and nobody else\'s', async () => {
  const { sent } = await run2({ dept: 'Education' });
  assert.deepEqual(sent.jobs.map((j) => j.id).sort(), ['tl_e1', 'tl_e2']);
  assert.equal(sent.jobs.find((j) => j.id === 'tl_e2').status, 'open'); // open and closed both there, each said truthfully
  assert.equal(sent.jobs.find((j) => j.id === 'tl_e1').status, 'closed');
  assert.ok(sent.jobs.every((j) => j.description === undefined));
});
test('a Non IT / Medical desk gets Medical and Non IT Medical roles', async () => {
  for (const dept of ['Non IT', 'Medical']) {
    const { sent } = await run2({ dept });
    assert.deepEqual(sent.jobs.map((j) => j.id).sort(), ['tl_m0', 'tl_m1', 'tl_m2', 'tl_n1']);
  }
});
test('a typed word narrows it; admin / signed-out / no department are left to the portal', async () => {
  assert.deepEqual((await run2({ dept: 'Education', q: 'teach' })).sent.jobs.map((j) => j.id), ['tl_e2']);
  assert.equal((await run2({ role: 'admin' })).passed, true);
  assert.equal((await run2({ cookie: '' })).passed, true);
  assert.equal((await run2({ dept: '' })).passed, true);
});

test("a Manufacturing recruiter gets the Manufacturing and the Medical roles, not Education", async () => {
  const { sent } = await run2({ dept: "Manufacturing" });
  assert.deepEqual(sent.jobs.map((j) => j.id).sort(), ["tl_f1", "tl_m0", "tl_m1", "tl_m2", "tl_n1"]);
});

test('all=1 (Send to ATS): every department for a recruiter and for admin, open ones said open', async () => {
  for (const role of ['recruiter', 'admin']) {
    let sent;
    const res = { json: (b) => { sent = b; return res; } };
    const deps = {
      cookieOf: () => 't', cookieName: 'tl_session', resolveSession: async () => ({ role, profileId: role === 'admin' ? null : 'r1' }),
      withUser: async (_s, fn) => fn({ query: async () => ({ rows: JOBS.map((j) => ({ ...j })) }) }),
    };
    await importJobsForDepartment(deps)({ headers: {}, query: { all: '1' } }, res, () => assert.fail('left to the portal'));
    assert.equal(sent.jobs.length, JOBS.length, role);
    assert.equal(sent.jobs.find((j) => j.id === 'tl_e2').status, 'open');
  }
});
