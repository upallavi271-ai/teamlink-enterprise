// Names of the vacant seats in the Vacancies table (founder 2026-11-16): node frontend/scripts/vacancy-seats-test.mjs   (no database, no server)
import { deptCode, teamCode, seatCodes, vacantByDepartment, showsSeatNames } from '../src/components/dashboard/vacancySeats.js';

let pass = 0; let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`}`); };

// the departments of the live table
eq('Education', deptCode('Education'), 'Edu');
eq('Medical', deptCode('Medical'), 'Med');
eq('Manufacturing', deptCode('Manufacturing'), 'Man');
eq('Medical + Manufacturing', deptCode('Medical + Manufacturing'), 'Med+Man');
eq('BDE stays BDE', deptCode('BDE'), 'BDE');
eq('R&D stays R&D', deptCode('R&D'), 'R&D');
eq('HR stays HR', deptCode('HR'), 'HR');
eq('two words = initials (Non IT Medical)', deptCode('Non IT Medical'), 'NIM');
eq('two words = initials (Product Development)', deptCode('Product Development'), 'PD');
eq('Recruitment', deptCode('Recruitment'), 'Rec');
eq('empty / missing name gives an empty code', [deptCode(''), deptCode(null), deptCode(undefined)], ['', '', '']);

// teams
eq('Team A', teamCode('Team A'), 'A');
eq('Team 2', teamCode('Team 2'), '2');
eq('Night shift', teamCode('Night shift'), 'N');
eq('no team name', teamCode(''), '');

// seats: the working people take 1..filled, the vacant ones are the numbers after them
eq('Manufacturing Employee: should have 5, 1 vacant -> Man-5', seatCodes('Man', { planned: 5, vacant: 1 }), ['Man-5']);
eq('Medical + Manufacturing STL: should have 1, 1 vacant -> Med+Man-1', seatCodes('Med+Man', { planned: 1, vacant: 1 }), ['Med+Man-1']);
eq('Education TL: should have 3, 2 vacant -> Edu-2, Edu-3', seatCodes('Edu', { planned: 3, vacant: 2 }), ['Edu-2', 'Edu-3']);
eq('a team: Edu-A-1', seatCodes(`${deptCode('Education')}-${teamCode('Team A')}`, { planned: 2, vacant: 2 }), ['Edu-A-1', 'Edu-A-2']);
eq('nothing vacant -> no seats', seatCodes('Med', { planned: 5, vacant: 0 }), []);
eq('more people than planned (vacant 0) -> no seats', seatCodes('BDE', { planned: 5, vacant: 0 }), []);
eq('odd input never throws or goes below 1', [seatCodes('X', null), seatCodes('X', { planned: 0, vacant: 2 }), seatCodes('X', { planned: '3', vacant: '1' })], [[], ['X-1', 'X-2'], ['X-3']]);

// the dashboard card: one line per department / team with the roles that have a vacancy, and the seat names
const row = (role, planned, vacant) => ({ role, planned, vacant, filled: planned - vacant, people: [] });
const sample = { groups: [
  { name: 'Medical', rows: [row('STL', 1, 0), row('TL', 3, 1), row('Employee', 8, 2)] },
  { name: 'Medical + Manufacturing', rows: [row('STL', 1, 1)] },
  { name: 'Education', rows: [row('STL', 1, 0), row('TL', 4, 2), row('Employee', 10, 3)], teams: [
    { name: 'Team A', rows: [row('TL', 2, 1), row('Employee', 5, 2)] },
    { name: 'Team B', rows: [row('TL', 2, 1), row('Employee', 5, 1)] },
  ] },
  { name: 'BDE', rows: [row('TL', 2, 0)] },
] };
const lines = vacantByDepartment(sample);
eq('card: labels (a full department, a team, none for a department with nothing vacant)', lines.map((l) => l.label), ['Medical', 'Medical + Manufacturing', 'Education · Team A', 'Education · Team B']);
// founder 2026-11-16 (asked, "Employee rows only"): only the Employee positions have seat names; STL and TL show just their number
eq('card: Medical TL 1 has no seat name, Employee 2 -> Med-7, Med-8', lines[0].parts, [{ role: 'TL', n: 1, seats: [] }, { role: 'Employee', n: 2, seats: ['Med-7', 'Med-8'] }]);
eq('card: Medical + Manufacturing STL 1 has no seat name', lines[1].parts, [{ role: 'STL', n: 1, seats: [] }]);
eq('card: a team uses the team letter for its Employee seats only (Edu-A-4, Edu-A-5, Edu-B-5)', [lines[2].parts[0].seats, lines[2].parts[1].seats, lines[3].parts[0].seats, lines[3].parts[1].seats], [[], ['Edu-A-4', 'Edu-A-5'], [], ['Edu-B-5']]);
eq('only Employee has seat names', [showsSeatNames('STL'), showsSeatNames('TL'), showsSeatNames('Employee')], [false, false, true]);
eq('card: nothing / missing data gives no lines', [vacantByDepartment(null), vacantByDepartment({}), vacantByDepartment({ groups: [] })], [[], [], []]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
