// Omni-Channel: a recruiter sees Dashboard, Channels and Campaign Center only; a TL and an Admin keep theirs (pages + server routes).
//   node backend/test-fixtures/omniRecruiterScope.test.js
const assert = require('node:assert/strict');
const A = require('../src/outreach/access');
const R = require('../src/outreach/recruiterScope');

delete process.env.OMNI_RECRUITER_SCOPE;
const recruiter = { id: 'r1', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical' };
const tl = { id: 't1', role: 'EMPLOYEE', atsRole: 'TL', atsDepartment: 'Medical' };
const admin = { id: 'a1', role: 'SUPER_ADMIN', atsRole: 'ADMIN' };

assert.equal(A.kind(recruiter), 'recruiter');
assert.equal(A.kind(tl), 'tl');
assert.equal(A.kind(admin), 'admin');

// ---- pages (the sidebar and the address redirect follow these)
const rp = A.pagesFor(recruiter).sort();
assert.deepEqual(rp, [...R.RECRUITER_PAGES].filter((p) => rp.includes(p)).sort(), 'recruiter pages are inside the allowed set');
for (const must of ['overview', 'inbox', 'connections', 'campaigns']) assert.ok(rp.includes(must), `recruiter has ${must}`);
for (const never of ['templates', 'customers', 'segments', 'automation', 'analytics', 'settings', 'billing', 'team', 'audit', 'superadmin', 'social', 'mkhome', 'console', 'botbuilder', 'forms']) assert.ok(!rp.includes(never), `recruiter has no ${never}`);
const tp = A.pagesFor(tl);
for (const p of ['overview', 'inbox', 'campaigns', 'templates', 'customers', 'team', 'audit']) assert.ok(tp.includes(p), `TL has ${p}`);
const ap = A.pagesFor(admin);
for (const p of ['overview', 'campaigns', 'settings', 'superadmin', 'team', 'billing', 'templates']) assert.ok(ap.includes(p), `Admin has ${p}`);

// ---- server routes
const ok = (area, m, p) => assert.ok(R.mayCall(area, m, p), `${m} ${area}${p} allowed`);
const no = (area, m, p) => assert.ok(!R.mayCall(area, m, p), `${m} ${area}${p} refused`);
ok('outreach', 'GET', '/me'); ok('outreach', 'GET', '/campaigns'); ok('outreach', 'POST', '/campaigns'); ok('outreach', 'GET', '/gs/campaigns/list'); ok('outreach', 'POST', '/gs/campaigns/create');
ok('outreach', 'GET', '/gs/inbox/list'); ok('outreach', 'GET', '/gs/overview'); ok('outreach', 'GET', '/segments'); ok('outreach', 'GET', '/templates'); ok('outreach', 'GET', '/insights/credit-use');
ok('omni', 'GET', '/connections'); ok('omni', 'GET', '/replies/review'); ok('omni', 'POST', '/app-campaigns'); ok('omniwa', 'GET', '/conversations'); ok('omniwa', 'POST', '/conversations/x/send');
for (const p of ['/gs/templates/x', '/gs/studio/list', '/gs/crm/customers', '/gs/automation/x', '/gs/bots/x', '/gs/admin/team/members', '/gs/analytics/comm', '/gs/external/x', '/gs/library/x', '/gs/marketing/x', '/gs/console/send']) no('outreach', 'GET', p);
no('outreach', 'POST', '/contacts'); no('outreach', 'DELETE', '/contacts/1'); no('outreach', 'POST', '/segments'); no('outreach', 'PUT', '/settings'); no('outreach', 'POST', '/templates'); no('outreach', 'POST', '/import/save');
no('outreach', 'GET', '/consent-log'); no('outreach', 'GET', '/roles'); no('outreach', 'GET', '/scheduled'); no('outreach', 'GET', '/automations'); no('outreach', 'PUT', '/credits/settings'); no('outreach', 'GET', '/config/permissions'); no('outreach', 'POST', '/communication/send');
no('omni', 'PUT', '/library/settings'); no('omni', 'PUT', '/library/templates/x/scopes');
no('omniwa', 'GET', '/settings'); no('omniwa', 'PUT', '/settings'); no('omniwa', 'POST', '/knowledge'); no('omniwa', 'GET', '/profiles'); no('omniwa', 'POST', '/unblock');
no('outreach', 'GET', '/unknown-new-route');

// ---- the guard itself: recruiter refused (403), TL and Admin pass untouched
function run(user, area, method, path) {
  let status = 200; let passed = false;
  R.guard(area)({ user, method, path }, { status(c) { status = c; return this; }, json() { return this; } }, () => { passed = true; });
  return passed ? 200 : status;
}
assert.equal(run(recruiter, 'outreach', 'GET', '/campaigns'), 200);
assert.equal(run(recruiter, 'outreach', 'GET', '/gs/analytics/comm'), 403);
assert.equal(run(recruiter, 'omniwa', 'PUT', '/settings'), 403);
assert.equal(run(tl, 'outreach', 'GET', '/gs/analytics/comm'), 200);
assert.equal(run(admin, 'omniwa', 'PUT', '/settings'), 200);
// switch off
process.env.OMNI_RECRUITER_SCOPE = '0';
assert.equal(run(recruiter, 'outreach', 'GET', '/gs/analytics/comm'), 200);
assert.ok(A.pagesFor(recruiter).includes('templates'), 'switched off = the old pages');
console.log('omniRecruiterScope: all passed');
process.exit(0);
