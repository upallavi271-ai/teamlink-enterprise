#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TOTAL WORKING TIME column of the Attendance Dashboard list (founder 2026-11-24) - no database, nothing is touched.
//
//   cd backend
//   node scripts/attendance-working-time-test.js
//
// utils/workedTime.js: first check-in to last check-out as ONE block of time. Check-outs and check-ins in between are not taken off and not
// shown ("dont mention break time ... consider that timing as the total working time"). Whole minutes as the times read on screen.
// ---------------------------------------------------------------------------
const path = require('path');
const W = require(path.join(__dirname, '..', 'src', 'utils', 'workedTime'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d)}` : ''}`); };
const P = (time, direction) => ({ time, direction });

// a plain in -> out day (the first rows of the founder's screenshot: A HarshaVardhan 11:17 AM to 6:04 PM)
let r = W.workedOfDay({ checkIn: '11:17', checkOut: '18:04', punchList: [P('11:17:00', 'In'), P('18:04:00', 'Out')] });
check('1 11:17 AM to 6:04 PM = 6h 47m', r && r.workedMinutes === 407 && W.text(r.workedMinutes) === '6h 47m', r);
r = W.workedOfDay({ checkIn: '09:08', checkOut: '18:10', punchList: [] });
check('2 no punch list at all: first in to last out (9:08 to 6:10 = 9h 02m)', r && r.workedMinutes === 542 && W.text(r.workedMinutes) === '9h 02m', r);

// IN-BETWEEN CHECK-OUTS / CHECK-INS ARE NOT TAKEN OFF (the founder's rule)
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('13:00:00', 'Out'), P('13:30:00', 'In'), P('18:00:00', 'Out')] });
check('3 a 30 minute break in the middle is NOT taken off: 9:00 to 6:00 = 9h 00m', r && r.workedMinutes === 540 && W.text(r.workedMinutes) === '9h 00m', r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('11:00:00', 'Out'), P('11:15:00', 'In'), P('13:00:00', 'Out'), P('13:45:00', 'In'), P('18:00:00', 'Out')] });
check('4 two breaks in the middle (15 + 45): still the whole 9h 00m', r && r.workedMinutes === 540, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('18:00:00', 'Out'), P('13:30:00', 'In'), P('09:00:00', 'In'), P('13:00:00', 'Out')] });
check('5 punches in any order: the same, first in to last out', r && r.workedMinutes === 540, r);
r = W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('12:00:00', 'Out'), P('18:00:00', 'Out')] });
check('6 a check-out in the middle with no return: still first in to last out', r && r.workedMinutes === 540, r);
check('7 the result carries no break figure at all (nothing to show)', !('breakMinutes' in W.workedOfDay({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('13:00:00', 'Out'), P('13:30:00', 'In'), P('18:00:00', 'Out')] })));

// whole minutes as they read on screen
r = W.workedOfDay({ checkIn: '09:00:50', checkOut: '09:01:10', punchList: [] });
check('8 seconds are dropped like the punch log does (09:00:50 -> 09:01:10 is 1 min, not 0)', r && r.workedMinutes === 1, r);
r = W.workedOfDay({ checkIn: '09:00:59', checkOut: '09:01:00', punchList: [] });
check('9 09:00:59 -> 09:01:00 is 1 min on the clock the screen shows', r && r.workedMinutes === 1, r);

// no total when it cannot be known
check('10 no check-out: no total', W.workedOfDay({ checkIn: '09:00', checkOut: null, punchList: [] }) === null);
check('11 no check-in: no total', W.workedOfDay({ checkIn: null, checkOut: '18:00', punchList: [] }) === null);
check('12 a check-out before the check-in: no total', W.workedOfDay({ checkIn: '18:00', checkOut: '09:00', punchList: [] }) === null);
check('13 nothing at all: no total', W.workedOfDay({}) === null && W.workedOfDay(null) === null);
check('14 the row fields of a day with no total: null and empty text, no break key', JSON.stringify(W.fieldsOf({ checkIn: '09:00' })) === JSON.stringify({ workedMinutes: null, workedText: '' }), W.fieldsOf({ checkIn: '09:00' }));
check('15 the row fields of a normal day carry the text for the Excel / CSV export', W.fieldsOf({ checkIn: '09:00', checkOut: '18:00', punchList: [] }).workedText === '9h 00m', W.fieldsOf({ checkIn: '09:00', checkOut: '18:00', punchList: [] }));
check('16 a day with a break in it: the export text is the whole span too', W.fieldsOf({ checkIn: '09:00', checkOut: '18:00', punchList: [P('09:00:00', 'In'), P('13:00:00', 'Out'), P('14:00:00', 'In'), P('18:00:00', 'Out')] }).workedText === '9h 00m');

// wording
check('17 wording: 0 min, 35 min, 1h 00m, 6h 47m', W.text(0) === '0 min' && W.text(35) === '35 min' && W.text(60) === '1h 00m' && W.text(407) === '6h 47m' && W.text(null) === '');
check('18 a same-minute in and out is 0 min, never negative', (() => { const x = W.workedOfDay({ checkIn: '09:00', checkOut: '09:00', punchList: [] }); return x && x.workedMinutes === 0; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
