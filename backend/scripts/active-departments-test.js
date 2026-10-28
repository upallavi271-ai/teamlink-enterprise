// Plain-node test: department option lists keep ONLY the switched-on
// Department & Team names (founder 2026-10-28, "Recruitment is not a
// department"). Pure functions only — no database is opened.
//   node scripts/active-departments-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { filterActiveDepartments } = require('../src/utils/masters');

const live = new Set(['administration', 'bde', 'education', 'hr', 'medical', 'r&d']);

// Backend: plain names.
assert.deepStrictEqual(
  filterActiveDepartments(['Education', 'Recruitment', 'IT', 'Medical', 'R&D'], live),
  ['Education', 'Medical', 'R&D'],
);
// The value already chosen stays (a saved filter keeps working).
assert.deepStrictEqual(filterActiveDepartments(['Recruitment', 'HR'], live, (x) => x, 'Recruitment'), ['Recruitment', 'HR']);
// Facet objects, the "nobody's department" buckets stay, case does not matter.
assert.deepStrictEqual(
  filterActiveDepartments([{ value: 'Not recorded' }, { value: '__none__' }, { value: 'recruitment' }, { value: 'MEDICAL' }, { value: '' }], live, (o) => o.value)
    .map((o) => o.value),
  ['Not recorded', '__none__', 'MEDICAL', ''],
);

// Frontend helper (utils/activeDepartments.js): load its pure functions
// without React / axios by stripping the imports.
const src = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/activeDepartments.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export (const|function)/gm, '$1');
const fe = new Function('MASTERS_CHANGED', 'api', 'useEffect', 'useState', `${src}; return { deptBase, isActiveDepartment, keepActive };`)('x', null, () => {}, () => []);

assert.strictEqual(fe.deptBase('Medical (12)'), 'medical');
assert.strictEqual(fe.deptBase('Medical · 3 people'), 'medical');
assert.strictEqual(fe.deptBase('Education (4 people)'), 'education');
assert.strictEqual(fe.deptBase('R&D'), 'r&d');
assert.ok(fe.isActiveDepartment(live, 'Medical', 'Medical (12)'));
assert.ok(fe.isActiveDepartment(live, 'cuid123', 'Education · 7'));
assert.ok(!fe.isActiveDepartment(live, 'Recruitment', 'Recruitment (33)'));
assert.ok(!fe.isActiveDepartment(live, 'IT', 'IT (2)'));
assert.ok(fe.isActiveDepartment(live, '__none__', 'No department'));
assert.ok(fe.isActiveDepartment(live, '__nodept__', 'No department on file (3)'));
assert.ok(fe.isActiveDepartment(null, 'Recruitment', 'Recruitment')); // master not loaded yet: hide nothing
assert.deepStrictEqual(fe.keepActive(live, ['HR', 'Recruitment', 'IT'], (x) => x, ['IT']), ['HR', 'IT']);
assert.deepStrictEqual(fe.keepActive(live, [['Recruitment', 3], ['Medical', 2]], ([d]) => d, ''), [['Medical', 2]]);

console.log('active-departments-test: all passed');
process.exit(0);
