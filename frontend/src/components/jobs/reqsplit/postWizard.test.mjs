// Run: node frontend/src/components/jobs/reqsplit/postWizard.test.mjs   (pure helpers only, no server)
import assert from 'node:assert/strict';
import { tableStatus, jdFileText, copyFields, cardOf, HAND_BOARDS, fillTemplate, unresolved, buildLayout, parseJd, bulletsOf, cardState, DEFAULT_TEMPLATE, CARDS } from './postWizard.js';

const job = { title: 'Staff Nurse', location: 'Hyderabad', expMin: 2, expMax: 5, employmentType: 'Full Time', jobDescription: 'Care for patients.', responsibilities: 'Give medicine\nKeep records', skills: 'ICU, BLS' };
assert.equal(CARDS.map((c) => c.id).join(), 'naukri,linkedin,shine,indeed,jobportal,website');
const filled = fillTemplate(DEFAULT_TEMPLATE, job);
assert.ok(filled.includes('Job Title: Staff Nurse') && filled.includes('Experience: 2-5 yrs'));
assert.deepEqual(unresolved(filled), []); // {{applyLink}} is the server's
assert.deepEqual(unresolved('Hi {{Salary Band}}'), ['Salary Band']);
const layout = buildLayout({ title: 'X' });
assert.ok(!layout.includes('Key Responsibilities')); // an empty part is left out
const jd = parseJd(buildLayout(job), job);
assert.equal(jd.title, 'Staff Nurse');
assert.equal(jd.location, 'Hyderabad');
assert.equal(jd.description, 'Care for patients.');
assert.deepEqual(bulletsOf(jd.responsibilities), ['Give medicine', 'Keep records']);
assert.deepEqual(bulletsOf(jd.skills), ['ICU', 'BLS']);
// honesty: Posted only from a confirmed row
assert.equal(cardState('jobportal', { site: { status: 'Pending' } }).key, 'queued');
assert.equal(cardState('jobportal', { site: { status: 'Posted' } }).key, 'posted');
assert.equal(cardState('naukri', { res: { state: 'queued', words: 'Queued' } }).key, 'queued');
assert.equal(cardState('indeed', { res: { state: 'feed', words: 'In feed' } }).key, 'feed');
assert.equal(cardState('naukri', { site: { status: 'Posted (by hand)' } }).key, 'hand');
assert.equal(cardState('naukri', {}).key, 'idle');
// Postings tab: one honest word per portal
assert.equal(tableStatus(cardState('naukri', {})).word, 'Not Posted');
assert.equal(tableStatus(cardState('naukri', { flow: { rows: [{ platform: 'naukri', status: 'Awaiting Naukri Completion' }] } })).word, 'Pending');
assert.equal(tableStatus(cardState('naukri', { flow: { rows: [{ platform: 'naukri', status: 'Ready to Open Naukri' }] } })).word, 'Pending');
const failedFlow = tableStatus(cardState('shine', { flow: { rows: [{ platform: 'shine', status: 'Action Required', lastError: 'Your browser blocked the new tab.' }] } }));
assert.equal(failedFlow.word, 'Failed'); assert.equal(failedFlow.action, 'retry'); assert.match(failedFlow.reason, /blocked/);
assert.equal(tableStatus(cardState('naukri', { site: { status: 'Posted (by hand)' } })).word, 'Posted (by hand)');
assert.equal(tableStatus(cardState('indeed', { site: { status: 'Submitted to feed' } })).word, 'Pending', 'in our feed is not posted');
assert.equal(tableStatus(cardState('naukri', { chip: { state: 'posted', words: 'Live' } })).word, 'Posted');
assert.equal(tableStatus(cardState('naukri', { chip: { state: 'failed', error: 'Sign-in failed', queueId: 'q1' } })).word, 'Failed');
// opening a portal is never Posted: a confirmed Naukri step with no by-hand record yet reads Not Posted, not Posted
assert.equal(tableStatus(cardState('naukri', { flow: { rows: [{ platform: 'naukri', status: 'Naukri Completion Confirmed' }] } })).word, 'Not Posted');
assert.ok(cardOf('linkedin') && HAND_BOARDS.includes('linkedin'));
// copy-ready parts + Download JD text
const rowsJd = copyFields(job, { applyLink: 'https://x/apply' });
assert.ok(rowsJd.some((r) => r.label === 'Job title' && r.value === 'Staff Nurse') && rowsJd.some((r) => r.label === 'How to apply'));
assert.ok(!rowsJd.some((r) => r.label === 'Salary range'), 'a part with no value is not listed');
assert.ok(jdFileText(rowsJd, '').startsWith('Job title:\nStaff Nurse'));
assert.equal(jdFileText(rowsJd, 'READY TEXT'), 'READY TEXT');
console.log('postWizard: all checks passed');
