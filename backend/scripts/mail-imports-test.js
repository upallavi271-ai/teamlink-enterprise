// utils/mailImports.js - how a Naukri / Shine mail title finds its ATS requirement (no database, no portal).
//   node scripts/mail-imports-test.js
const M = require('../src/utils/mailImports');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const R = (id, title, status = 'OPEN', extra = {}) => ({ id, title, status, department: 'Medical', recruiterId: null, recruiterIds: '', createdAt: new Date('2026-10-01'), ...extra, norm: M.normTitle(title) });
const index = [
  R('pack', 'Packaging Artwork Executive', 'OPEN', { department: 'Manufacturing' }),
  R('nurse', 'Nurse — Staff Nurses'),
  R('emer', 'Consultant / Doctor — Emergency Physician'),
  R('genmed', 'Consultant / Doctor — General Medicine(Consultant Physician)'),
  R('fac', 'Faculty', 'OPEN', { department: 'Education' }),
  R('prof', 'Professor', 'CLOSED', { department: 'Education' }),
  R('ap1', 'Assistant Professor — Pharm D', 'OPEN', { department: 'Education' }),
  R('ap2', 'Assistant Professor — Pharmacology', 'OPEN', { department: 'Education' }),
  R('am', 'Assistant Manager', 'CLOSED', { department: 'Manufacturing' }),
  R('rad1', 'Assistant Professor — Radiologist', 'OPEN', { department: 'Education', recruiterId: 'u-edu' }),
  R('rad2', 'Consultant / Doctor — Radiologist', 'OPEN', { recruiterId: 'u-med' }),
  R('derm', 'Consultant Dermatologist', 'CLOSED'),
];
const m = (t, ctx = {}) => { const r = M.match(index, t, ctx); return r ? r.id : null; };

ok('board noise removed: "Email Response-Urgent | Hiring For X" reads as X', M.normTitle('Email Response-Urgent | Hiring For Packaging Artwork Executive') === 'packaging artwork executive');
ok('"Urgent | PACKAGING ARTWORK EXECUTIVE" -> Packaging Artwork Executive', m('Urgent | PACKAGING ARTWORK EXECUTIVE') === 'pack');
ok('"Staff Nurse" -> Nurse — Staff Nurses', m('Staff Nurse') === 'nurse');
ok('"Urgent | Hiring for Emergency Physician" -> Emergency Physician', m('Urgent | Hiring for Emergency Physician') === 'emer');
ok('word for word wins even on a closed requirement ("Consultant Dermatologist")', m('Consultant Dermatologist') === 'derm');
ok('a one-word requirement never takes a longer title ("Ophthalmology Faculty" is not "Faculty")', m('Urgent | Hiring Ophthalmology Faculty!') === null);
ok('a partial match never goes to a CLOSED requirement ("Assistant Manager-Mep")', m('Urgent | Hiring For Assistant Manager-Mep') === null);
ok('several requirements fit ("Professor and Assistant Professor"): not guessed, it waits', m('Urgent | Hiring for Professor and Assistant Professor') === null);
ok('several fit ("Consultant Physician" - Emergency / General Medicine): it waits', m('Consultant Physician') === null);
ok('several fit, but only one is the mailbox recruiter\'s own -> that one', m('Radiologist', { userId: 'u-med' }) === 'rad2' && m('Radiologist', { userId: 'u-edu' }) === 'rad1');
ok('several fit, the recruiter\'s seat department decides', m('Radiologist', { department: 'Education' }) === 'rad1');
ok('nothing like it -> waits', m('Human Resource Recruiter') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
