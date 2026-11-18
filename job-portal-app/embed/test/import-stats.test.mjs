// Who imported what: the Source detail of an imported candidate names the recruiter; the summary has one row per recruiter. No database (stubs).
//   node --test job-portal-app/embed/test/import-stats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagImportedBy, importSummary } from '../import-stats.mjs';

const run = (withUser, body) => new Promise((resolve) => {
  const res = { json: (b) => { resolve(b); return res; } };
  tagImportedBy(withUser, {})({}, res, () => {});
  res.json(body);
});
test('imported candidates get "by <recruiter>" on their source detail; others are untouched', async () => {
  const withUser = async (_s, fn) => fn({ query: async () => ({ rows: [{ id: 'c1', name: 'Ravi' }] }) });
  const sent = await run(withUser, { candidates: [{ id: 'c1', sourceDetails: 'Import Resumes' }, { id: 'c2', sourceDetails: '' }] });
  assert.equal(sent.candidates[0].sourceDetails, 'Import Resumes · by Ravi');
  assert.equal(sent.candidates[0].importedBy, 'Ravi');
  assert.equal(sent.candidates[1].sourceDetails, '');
});
test('a database problem sends the list unchanged', async () => {
  const sent = await run(async () => { throw new Error('db'); }, { candidates: [{ id: 'c1', sourceDetails: 'x' }] });
  assert.equal(sent.candidates[0].sourceDetails, 'x');
});
test('the summary maps one row per recruiter', async () => {
  let n = 0;
  const withUser = async (_s, fn) => fn({ query: async () => (++n === 1
    ? { rows: [{ id: 'r1', name: 'Ravi', department: 'Medical', candidates: 12, files: 2, rows_read: 20, created: 10, merged: 2, skipped: 8, last_import: '2026-11-19', by_source: { 'Bulk Import': 12 } }] }
    : { rows: [{ n: 3 }] }) });
  const out = await importSummary(withUser, {});
  assert.equal(out.recruiters.length, 1); assert.equal(out.recruiters[0].candidates, 12); assert.equal(out.recruiters[0].bySource['Bulk Import'], 12); assert.equal(out.withoutOwner, 3);
});
