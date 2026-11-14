#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ACTIVE EMPLOYEES FIRST (founder 2026-11-14): the Active / Exited / Relieved grouping that every list of people uses.
//
//   cd backend && node scripts/employee-status-groups-test.js
//
// Pure checks, no database and no server. The frontend (frontend/src/hrStatus.js) and the backend (src/utils/hrStatus.js) carry the
// same rule on purpose; this keeps them in step: Active = everybody who has not left (Active, On Probation, Notice Period, Exit Process,
// Inactive, Suspended), Exited and Relieved are their own groups, and the finer HR statuses still answer as before.
// ---------------------------------------------------------------------------
const path = require('path');
const { pathToFileURL } = require('url');

const BE = require('../src/utils/hrStatus');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
};

(async () => {
  const FE = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/src/hrStatus.js')).href);
  const people = [
    ['Active', 'Active', 'Active'], ['On Probation', 'Active', 'Active'], ['Notice Period', 'Active', 'Active'], ['Exit Process', 'Active', 'Active'],
    ['Rejoined', 'Active', 'Active'], ['Inactive', 'Active', 'Active'], ['Suspended', 'Active', 'Active'],
    ['Exited', 'Exited', 'Active'], ['Relieved', 'Relieved', 'Active'], [undefined, 'Active', 'Active'], [null, 'Active', 'Active'],
  ];
  people.forEach(([employment, group]) => {
    check(`group of ${employment}`, FE.statusGroupOf(employment) === group && BE.statusGroupOf(employment) === group, `${FE.statusGroupOf(employment)} / ${BE.statusGroupOf(employment)}`);
  });

  // The Employee status choices.
  const cases = [
    // choice, employmentStatus, loginStatus, expected
    ['', 'Relieved', 'Active', true],
    ['Active', 'Notice Period', 'Active', true],
    ['Active', 'Exit Process', 'Active', true],
    ['Active', 'Exited', 'Active', false],
    ['Active', 'Relieved', 'Inactive', false],
    ['Exited', 'Exited', 'Active', true],
    ['Exited', 'Relieved', 'Active', false],
    ['Relieved', 'Relieved', 'Inactive', true],
    ['Relieved', 'Active', 'Active', false],
    ['Notice Period', 'Notice Period', 'Active', true],
    ['Notice Period', 'Active', 'Active', false],
    ['Inactive', 'Active', 'Inactive', true],
    ['Suspended', 'Active', 'Suspended', true],
    ['Exit', 'Exited', 'Active', true], // the old merged choice still answers
    ['Exit', 'Active', 'Active', false],
  ];
  cases.forEach(([choice, emp, login, want]) => {
    const f = FE.employeeStatusMatches(choice, emp, login);
    const b = BE.employeeStatusMatches(choice, emp, login);
    check(`choice "${choice || 'All'}" for ${emp}/${login}`, f === want && b === want, `frontend ${f}, backend ${b}, wanted ${want}`);
  });

  check('three groups, same order', JSON.stringify(FE.STATUS_GROUPS) === JSON.stringify(BE.STATUS_GROUPS) && FE.STATUS_GROUPS.join() === 'Active,Exited,Relieved', `${FE.STATUS_GROUPS} / ${BE.STATUS_GROUPS}`);
  check('the five HR statuses are unchanged', FE.HR_STATUSES.join() === 'Active,Inactive,Notice Period,Suspended,Exit' && BE.HR_STATUSES.join() === FE.HR_STATUSES.join(), `${FE.HR_STATUSES} / ${BE.HR_STATUSES}`);
  check('the choices offered start with the three groups', FE.EMPLOYEE_STATUS_CHOICES.slice(0, 3).join() === 'Active,Exited,Relieved', String(FE.EMPLOYEE_STATUS_CHOICES));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
