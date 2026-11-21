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
