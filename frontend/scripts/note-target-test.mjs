// WHERE A NOTIFICATION LEADS - checks of src/utils/noteTarget.js (no browser, no server).   npm run test:notes
import assert from 'node:assert/strict';
import { noteTarget, noteText, noteLink, ago } from '../src/utils/noteTarget.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };
const n = (title, message = '') => ({ title, message, createdAt: '2026-11-18T05:00:00Z' });

console.log('Notification targets');
t('an "Open: /path" last line leads there and is hidden from the words', () => {
  const x = n('New application from the job portal', 'Asha -> Nurse\nOpen: /candidates/c1');
  assert.deepEqual(noteTarget(x), { to: '/candidates/c1', label: 'Open the candidate', exact: true });
  assert.equal(noteText(x.message), 'Asha -> Nurse');
});
t('an Open line with no words, and one at the end of a sentence, are read too', () => {
  assert.equal(noteLink(n('X', 'Open: /requirements/r9')), '/requirements/r9');
  assert.equal(noteLink(n('X', 'Reply came in. Open: /crm/leads?open=lead:5')), '/crm/leads?open=lead:5');
  assert.equal(noteText('Reply came in. Open: /crm/leads?open=lead:5'), 'Reply came in.');
});
t('never a link to another site', () => {
  assert.equal(noteLink(n('Other', 'x\nOpen: //evil.example/a')), null);
  assert.equal(noteLink(n('Other', 'x\nOpen: https://evil.example')), null);
});
t('an announcement opens that announcement', () => {
  const x = noteTarget(n('Announcement: Diwali holiday'));
  assert.ok(x.to.startsWith('/employee-services?tab=announcements&open=Diwali%20holiday'));
});
t('an employee WhatsApp reply opens the chat door, a candidate\'s opens the profile', () => {
  assert.equal(noteTarget(n('New WhatsApp reply from Sagiri', 'ok\nOpen: /open/chat/employee/e1')).label, 'Open the chat');
  assert.equal(noteTarget(n('New WhatsApp reply from Asha', 'ok\nOpen: /candidates/c2?tab=conversation')).to, '/candidates/c2?tab=conversation');
});
t('older lines without a destination open the screen their title is about', () => {
  const to = (title) => (noteTarget(n(title)) || {}).to;
  assert.equal(to('Missing check-in — 12-NOV-2026'), '/attendance');
  assert.equal(to('Early logout — 17-NOV-2026'), '/attendance');
  assert.equal(to('Task overdue: Prepare weekly status report (was due 10 Nov)'), '/timesheet');
  assert.equal(to('Task due today: Interview schedules'), '/timesheet');
  assert.equal(to('⏰ 3 of your tasks are late'), '/timesheet');
  assert.equal(to('2 tasks you gave are late'), '/timesheet');
  assert.equal(to('Overdue follow-up escalated to you — Asha'), '/ats/followups');
  assert.equal(to('Requirement REQ-1234 assigned to you'), '/requirements');
  assert.equal(to('New application from the job portal'), '/candidates');
  assert.equal(to('Leave request from Ravi'), '/leave');
  assert.equal(to('Interview tomorrow at 11'), '/ats/calendar');
});
t('a title the list does not know leads nowhere (the panel then opens the full list)', () => {
  assert.equal(noteTarget(n('Vendor sign-in link made')), null);
  assert.equal(noteTarget(n('Something entirely new')), null);
  assert.equal(noteTarget(null), null);
});
t('the exact destination always wins over the title', () => {
  assert.equal(noteTarget(n('Task overdue: X', 'late\nOpen: /timesheet?task=7')).to, '/timesheet?task=7');
  assert.equal(noteTarget(n('Leave policy changed', 'x\nOpen: /employee-services?tab=announcements')).to, '/employee-services?tab=announcements');
});
t('ago() words', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(ago('2026-11-18T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-11-18T11:55:00Z', now), '5 min ago');
  assert.equal(ago('2026-11-18T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-11-17T09:00:00Z', now), 'Yesterday');
  assert.equal(ago('not a date', now), '');
});
console.log(`\n${passed} checks passed${process.exitCode ? ' - SOME FAILED' : ''}`);
