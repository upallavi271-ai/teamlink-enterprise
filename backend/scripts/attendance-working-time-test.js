#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TOTAL WORKING TIME column of the Attendance Dashboard list (founder 2026-11-24) - no database, nothing is touched.
//
//   cd backend
//   node scripts/attendance-working-time-test.js
//
// utils/workedTime.js: first check-in to last check-out minus every break in between (a check-out followed by the next check-in), whole minutes as
// the times read on screen. The same rule as "Total Time Worked" in the Biometric list.
// ---------------------------------------------------------------------------
const path = require('path');
const W = require(path.join(__dirname, '..', 'src', 'utils', 'workedTime'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d)}` : ''}`); };
const P = (time, direction) => ({ time, direction });

// a plain in -> out day (the first rows of the founder's screenshot: A HarshaVardhan 11:17 AM to 6:04 PM)
let r = W.workedOfDay({ checkIn: '11:17', checkOut: '18:04', punchList: [P('11:17:00', 'In'), P('18:04:00', 'Out')] });
check('1 11:17 AM to 6:04 PM = 6h 47m, no break', r && r.workedMinutes === 407 && r.breakMinutes === 0 && r.spanMinutes === 407 && W.text(r.workedMinutes) === '6h 47m', r);
r = W.workedOfDay({ checkIn: '09:08', checkOut: '18:10', punchList: [] });
check('2 no punch list at all: the span (9:08 to 6:10 = 9h 02m)', r && r.workedMinutes === 542 && W.text(r.workedMinutes) === '9h 02m', r);

// breaks
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('13:00:00', 'Out'), P('13:30:00', 'In'), P('18:00:00', 'Out')] });
check('3 one 30 minute break is taken off (9h span -> 8h 30m)', r && r.spanMinutes === 540 && r.breakMinutes === 30 && r.workedMinutes === 510, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('11:00:00', 'Out'), P('11:15:00', 'In'), P('13:00:00', 'Out'), P('13:45:00', 'In'), P('18:00:00', 'Out')] });
check('4 two breaks (15 + 45) are both taken off', r && r.breakMinutes === 60 && r.workedMinutes === 480, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('18:00:00', 'Out'), P('13:30:00', 'In'), P('09:00:00', 'In'), P('13:00:00', 'Out')] });
check('5 the punches may come in any order', r && r.breakMinutes === 30 && r.workedMinutes === 510, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('12:00:00', 'Out'), P('18:00:00', 'Out')] });
check('6 a check-out followed by another check-out is not a break (no return was recorded)', r && r.breakMinutes === 0 && r.workedMinutes === 540, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('08:30:00', 'Out'), P('08:50:00', 'In'), P('09:00:00', 'In'), P('18:00:00', 'Out'), P('18:20:00', 'In')] });
check('7 punches before the first in / after the last out are ignored', r && r.breakMinutes === 0 && r.workedMinutes === 540, r);

// whole minutes as they read on screen
r = W.workedOfDay({ checkIn: '09:00:50', checkOut: '09:01:10', punchList: [] });
check('8 seconds are dropped like the punch log does (09:00:50 -> 09:01:10 is 1 min, not 0)', r && r.workedMinutes === 1, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('13:30:10', 'Out'), P('13:58:50', 'In'), P('18:00:00', 'Out')] });
check('9 a break 13:30 -> 13:58 is 28 min (never 29)', r && r.breakMinutes === 28, r);

// no total when it cannot be known
check('10 no check-out: no total', W.workedOfDay({ checkIn: '09:00', checkOut: null, punchList: [] }) === null);
check('11 no check-in: no total', W.workedOfDay({ checkIn: null, checkOut: '18:00', punchList: [] }) === null);
check('12 a check-out before the check-in: no total', W.workedOfDay({ checkIn: '18:00', checkOut: '09:00', punchList: [] }) === null);
check('13 nothing at all: no total', W.workedOfDay({}) === null && W.workedOfDay(null) === null);
check('14 the row fields of a day with no total: null, 0, empty text', JSON.stringify(W.fieldsOf({ checkIn: '09:00' })) === JSON.stringify({ workedMinutes: null, breakMinutes: 0, spanMinutes: null, workedText: '' }), W.fieldsOf({ checkIn: '09:00' }));
check('15 the row fields of a normal day carry the text for the Excel / CSV export', W.fieldsOf({ checkIn: '09:00', checkOut: '18:00', punchList: [] }).workedText === '9h 00m', W.fieldsOf({ checkIn: '09:00', checkOut: '18:00', punchList: [] }));

// wording
check('16 wording: 0 min, 35 min, 1h 00m, 6h 47m', W.text(0) === '0 min' && W.text(35) === '35 min' && W.text(60) === '1h 00m' && W.text(407) === '6h 47m' && W.text(null) === '');
check('17 a worked time is never negative (a break longer than the span)', (() => { const x = W.workedOfDay({ checkIn: '09:00', checkOut: '09:10', punchList: [P('09:00:00', 'Out'), P('09:10:00', 'In')] }); return x && x.workedMinutes === 0; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
