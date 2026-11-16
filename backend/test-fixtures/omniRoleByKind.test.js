// Omni-Channel: which Green Start role a TeamLink login gets (utils/omniDeptLogins.js staffRoleFor).
//   node backend/test-fixtures/omniRoleByKind.test.js
const assert = require('node:assert/strict');
const D = require('../src/utils/omniDeptLogins');

delete process.env.OMNI_ROLE_BY_KIND;
for (const k of ['recruiter', 'tl', 'bde', 'view', 'hr', 'none']) assert.equal(D.staffRoleFor(k), 'team_leader', `${k}: switch off = Team Leader as before`);
process.env.OMNI_ROLE_BY_KIND = '1';
assert.equal(D.staffRoleFor('recruiter'), 'recruiter');
for (const k of ['tl', 'bdetl', 'bde', 'view', 'hr', 'marketing']) assert.equal(D.staffRoleFor(k), 'team_leader', `${k} stays Team Leader`);
console.log('omniRoleByKind: all passed');
process.exit(0);
