#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EVERYBODY ON THE PAYROLL LIST (founder 2026-11-24) - no database, nothing is touched.
//
//   cd backend
//   node scripts/payroll-missing-test.js
//
// utils/payrollMissing.js reasonOf(): why somebody has no salary record for a month, and whether "Calculate" can make it now.
// The test of "is there pay" is the one calculateMonth uses (a Package = Basic + HRA + Bonus + Special + Conveyance, a Stipend = the stipend).
// ---------------------------------------------------------------------------
// the module needs the database client only for missingFor(); reasonOf() is pure, so the client is never opened here
const path = require('path');
const { reasonOf } = require(path.join(__dirname, '..', 'src', 'utils', 'payrollMissing'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d)}` : ''}`); };

// the Nov 2026 pay period of a 16th-to-15th cycle
const cycle = { to: '2026-11-15', rangeText: '16 Oct – 15 Nov' };
const stipend = { payMode: 'Stipend', stipend: 10000 };
const pkg = { payMode: 'Package', ctc: 600000, basic: 20000, hra: 8000, bonus: 0, specialAllowance: 12000, conveyance: 0 };

let r = reasonOf({ dateOfJoining: new Date('2026-10-21T00:00:00Z') }, cycle, stipend, null);
check('1 joined last month, structure in place: ready, press Calculate', r.code === 'NOT_CALCULATED' && /Press Calculate/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2026-11-03T00:00:00Z') }, cycle, null, null);
check('2 joined last month, no salary structure: needs a structure, nobody is paid a default', r.code === 'NO_STRUCTURE' && /No salary structure yet/.test(r.reason) && /default/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2026-11-20T00:00:00Z') }, cycle, null, null);
check('3 joins AFTER the period: not yet, says the date and the period', r.code === 'NOT_JOINED' && /20 Nov 2026/.test(r.reason) && /16 Oct – 15 Nov/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2026-11-20T00:00:00Z') }, cycle, stipend, null);
check('4 joins after the period even with a structure: still "not yet" (nothing due)', r.code === 'NOT_JOINED', r);
r = reasonOf({ dateOfJoining: new Date('2026-11-15T00:00:00Z') }, cycle, null, null);
check('5 joins ON the last day of the period: inside it (needs a structure, not "not yet")', r.code === 'NO_STRUCTURE', r);
r = reasonOf({ dateOfJoining: new Date('2026-10-18T00:00:00Z') }, cycle, null, '2026-12-01');
check('6 structure starts after the period: says the start date', r.code === 'STRUCTURE_LATER' && /1 Dec 2026/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2026-10-20T00:00:00Z') }, cycle, { payMode: 'Package', ctc: 0, basic: 0, hra: 0 }, null);
check('7 a Package with no components: no CTC set', r.code === 'NO_PAY' && /No CTC/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2026-10-20T00:00:00Z') }, cycle, { payMode: 'Package', ctc: 600000, basic: 0, hra: 0, bonus: 0, specialAllowance: 0, conveyance: 0 }, null);
check('8 a CTC typed but no components stored: no CTC set (the engine pays the components, not the typed CTC)', r.code === 'NO_PAY', r);
r = reasonOf({ dateOfJoining: new Date('2026-10-20T00:00:00Z') }, cycle, { payMode: 'Stipend', stipend: 0 }, null);
check('9 a stipend of 0: says the stipend is 0', r.code === 'NO_PAY' && /stipend/.test(r.reason), r);
r = reasonOf({ dateOfJoining: new Date('2025-04-01T00:00:00Z') }, cycle, pkg, null);
check('10 a package with components: ready', r.code === 'NOT_CALCULATED', r);
r = reasonOf({ dateOfJoining: null }, cycle, null, null);
check('11 no joining date on file: judged on the structure only (needs a structure)', r.code === 'NO_STRUCTURE', r);
r = reasonOf({ dateOfJoining: null }, cycle, pkg, null);
check('12 no joining date but a good structure: ready', r.code === 'NOT_CALCULATED', r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
