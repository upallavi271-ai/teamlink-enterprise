#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ORGANIZATION CHART — checks of the tree builder (src/utils/orgChart.js). No database and no server: plain objects in,
// the tree out.   npm run org-chart-test
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const assert = require('assert');
const { build, levelOf, levelOfDesignation } = require('../src/utils/orgChart');

let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const emp = (id, name, o = {}) => ({
  id, employeeCode: `E${id}`, name, designation: 'Employee', department: 'Medical', team: null, tl: null, stl: null, reportingManagerId: null, hrStatus: 'Active', user: null, ...o,
});
const find = (n, id) => { if (n.id === id) return n; for (const c of n.children || []) { const f = find(c, id); if (f) return f; } return null; };
const flat = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => flat(c, out)); return out; };
const people = (n) => flat(n).filter((x) => x.type === 'person');
const kids = (n) => (n.children || []).map((c) => c.name);

console.log('Organization chart builder');

t('levels come from the HRMS role, the login role or the designation, whichever is most senior', () => {
  assert.strictEqual(levelOf(emp(1, 'A', { user: { role: 'TL', hrmsRole: 'TL' }, designation: 'Super Admin' })), 'SUPER_ADMIN');
  assert.strictEqual(levelOf(emp(2, 'B', { user: { role: 'RECRUITER', hrmsRole: 'EMPLOYEE' }, designation: 'Recruiter' })), 'EMPLOYEE');
  assert.strictEqual(levelOf(emp(3, 'C', { user: { role: 'EMPLOYEE', hrmsRole: 'STL' } })), 'STL');
  assert.strictEqual(levelOf(emp(4, 'D', { designation: 'Assistant Manager' })), 'ASSISTANT_MANAGER');
  assert.strictEqual(levelOf(emp(5, 'E', { designation: 'TL' })), 'TL');
});
t('a job title that merely contains "Manager" is not the Manager role', () => {
  assert.strictEqual(levelOfDesignation('Project Manager'), 'EMPLOYEE');
  assert.strictEqual(levelOfDesignation('Account Manager'), 'EMPLOYEE');
  assert.strictEqual(levelOfDesignation('Manager'), 'MANAGER');
  assert.strictEqual(levelOfDesignation(' super  admin '), 'SUPER_ADMIN');
});

t('Super Admin on top, departments below, TL by name, employees under the TL', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha Founder', { designation: 'Super Admin', department: 'Administration' }),
      emp('tl1', 'Ravi TL', { designation: 'TL', department: 'Medical', team: 'Team A' }),
      emp('e1', 'Kiran', { tl: 'ravi tl' }),
      emp('e2', 'Mani', { tl: 'Ravi  TL' }),
    ],
  });
  assert.strictEqual(out.root.name, 'Asha Founder');
  assert.strictEqual(out.root.level, 'SUPER_ADMIN');
  const med = out.root.children.find((c) => c.type === 'dept' && c.name === 'Medical');
  assert.ok(med, 'a Medical box');
  assert.deepStrictEqual(kids(med), ['Ravi TL']);
  assert.deepStrictEqual(kids(find(out.root, 'tl1')), ['Kiran', 'Mani']);
  assert.strictEqual(find(out.root, 'tl1').size, 2);
  assert.strictEqual(med.size, 3);
  assert.strictEqual(out.root.size, 4 - 1);
  assert.strictEqual(find(out.root, 'e1').reportsTo, 'Ravi TL');
});

t('the explicit reporting manager is used; a line that ends at the Super Admin means "reports to the top" (shown in the department)', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin', department: 'Administration' }),
      emp('m', 'Mohan', { designation: 'Manager', department: 'Operations' }),
      emp('tl', 'Tara', { designation: 'TL', department: 'Medical', reportingManagerId: 'm' }),
      emp('e', 'Eli', { department: 'Medical', reportingManagerId: 'sa' }),
    ],
  });
  assert.ok(find(find(out.root, 'm'), 'tl'), 'Tara is under Mohan');
  const med = out.root.children.find((c) => c.name === 'Medical');
  assert.ok(med && find(med, 'e'), 'Eli (reports to the Super Admin) sits in Medical');
  assert.strictEqual(out.root.children.some((c) => c.id === 'e'), false);
});

t('Managers and Assistant Managers sit directly under the Super Admin', () => {
  const out = build({ employees: [emp('sa', 'Asha', { designation: 'Super Admin' }), emp('am', 'Amar', { designation: 'Assistant Manager', department: 'IT' })] });
  assert.deepStrictEqual(kids(out.root), ['Amar']);
  assert.strictEqual(out.stats.managers, 1);
});

t('a TL named on records who is not on the chart keeps the team together under a grey box', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin' }),
      emp('e1', 'Kiran', { tl: 'Gone Person' }),
      emp('e2', 'Mani', { tl: 'gone person' }),
    ],
  });
  const ghost = flat(out.root).find((n) => n.type === 'ghost');
  assert.ok(ghost, 'a grey box');
  assert.strictEqual(ghost.name, 'Gone Person');
  assert.deepStrictEqual(kids(ghost), ['Kiran', 'Mani']);
  assert.strictEqual(ghost.messageable, false);
  assert.strictEqual(out.tidy.teamsOfMissingTl, 1);
});

t('people with no TL: kept together in a department that has TLs, flat in one that has none', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin' }),
      emp('tl', 'Tara', { designation: 'TL', department: 'Medical' }),
      emp('a', 'Ann', { department: 'Medical' }),
      emp('b', 'Bob', { department: 'IT' }),
    ],
  });
  const med = out.root.children.find((c) => c.name === 'Medical');
  assert.ok(med.children.some((c) => c.type === 'bucket' && c.name === 'No TL assigned yet' && kids(c)[0] === 'Ann'));
  const it = out.root.children.find((c) => c.name === 'IT');
  assert.deepStrictEqual(kids(it), ['Bob']);
  assert.strictEqual(out.tidy.withoutTl, 2);
});

t('a reporting loop is cut: nobody disappears and the builder does not run forever', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin' }),
      emp('a', 'Ann', { designation: 'TL', reportingManagerId: 'b' }),
      emp('b', 'Bob', { designation: 'TL', reportingManagerId: 'a' }),
      emp('c', 'Cy', { designation: 'TL', reportingManagerId: 'c' }),
    ],
  });
  assert.strictEqual(people(out.root).length, 4);
});

t('the same name twice: the one in the same department is the boss', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin' }),
      emp('t1', 'Sam Lee', { designation: 'TL', department: 'IT' }),
      emp('t2', 'Sam Lee', { designation: 'TL', department: 'Medical' }),
      emp('e', 'Eli', { department: 'Medical', tl: 'Sam Lee' }),
    ],
  });
  assert.ok(find(find(out.root, 't2'), 'e'));
});

t('the seat a person holds is used when nothing else names a boss', () => {
  const out = build({
    employees: [
      emp('sa', 'Asha', { designation: 'Super Admin' }),
      emp('tl', 'Tara', { designation: 'TL', department: 'Education' }),
      emp('r', 'Rita', { department: 'Education', seatCode: 'EDU-3', seatReportsToEmployeeId: 'tl' }),
    ],
  });
  assert.strictEqual(find(out.root, 'r').seat, 'EDU-3');
  assert.ok(find(find(out.root, 'tl'), 'r'));
});

t('today: present / late / half / leave / absent / not marked, and the totals add up', () => {
  const emps = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => emp(id, id.toUpperCase()));
  const out = build({
    employees: [emp('sa', 'Asha', { designation: 'Super Admin' }), ...emps],
    attendance: new Map([['a', 'Present'], ['b', 'Late'], ['c', 'Half Day'], ['e', 'Absent']]),
    onLeave: new Set(['d']),
  });
  const s = out.stats;
  assert.deepStrictEqual([s.present, s.half, s.leave, s.absent, s.notMarked], [2, 1, 1, 1, 2]);
  assert.strictEqual(s.present + s.half + s.leave + s.absent + s.notMarked, s.people);
  assert.strictEqual(find(out.root, 'b').presence, 'late');
});

t('more than one Super Admin: a top box holds them side by side', () => {
  const out = build({ employees: [emp('s1', 'Asha', { designation: 'Super Admin' }), emp('s2', 'Zed', { user: { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' } }), emp('e', 'Eli')] });
  assert.strictEqual(out.root.type, 'top');
  assert.deepStrictEqual(kids(out.root).slice(0, 2), ['Asha', 'Zed']);
});

t('no Super Admin employee: the top box names the Super Admin login', () => {
  const out = build({ employees: [emp('e', 'Eli')], superAdminLogins: [{ name: 'Company Admin' }] });
  assert.strictEqual(out.root.type, 'top');
  assert.ok(/Company Admin/.test(out.root.note));
});

t('an empty company does not crash and says nothing is there', () => {
  const out = build({});
  assert.strictEqual(out.stats.people, 0);
  assert.strictEqual(out.root.children.length, 0);
  assert.strictEqual(out.root.size, 0);
});

t('the answer carries no phone, e-mail or raw record fields', () => {
  const out = build({ employees: [emp('sa', 'Asha', { designation: 'Super Admin', phone: '9999999999', email: 'a@b.c', tl: 'X' }), emp('e', 'Eli', { phone: '1', email: 'e@b.c', tl: 'Nobody' })] });
  const text = JSON.stringify(out);
  assert.ok(!/_raw|phone|email|@b\.c|9999999999/.test(text), 'no personal fields');
});

t('who is "you" is marked, so the screen does not offer a message to yourself', () => {
  const out = build({ employees: [emp('sa', 'Asha', { designation: 'Super Admin' }), emp('e', 'Eli')], viewerEmployeeId: 'e' });
  assert.strictEqual(find(out.root, 'e').isViewer, true);
  assert.strictEqual(find(out.root, 'sa').isViewer, false);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
