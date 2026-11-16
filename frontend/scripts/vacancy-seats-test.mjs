// Names of the vacant seats in the Vacancies table (founder 2026-11-16): node frontend/scripts/vacancy-seats-test.mjs   (no database, no server)
import { deptCode, teamCode, seatCodes } from '../src/components/dashboard/vacancySeats.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
