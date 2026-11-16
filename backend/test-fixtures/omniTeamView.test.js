// Omni-Channel > Campaigns > My team: a Team Lead sees only the recruiters of their OWN department; Admin sees all; a recruiter and other kinds get nothing.
//   node backend/test-fixtures/omniTeamView.test.js
// Pure: the user list, the campaign rows and the counts are replaced by recorders (no database is read or written).
const assert = require('node:assert/strict');
const prisma = require('../src/db');
const S = require('../src/outreach/store');
const Camp = require('../src/outreach/campaigns');
const T = require('../src/outreach/teamView');

const users = [
  { id: 'r-med1', name: 'Med One', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical' },
  { id: 'r-med2', name: 'Med Two', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical' },
  { id: 'r-edu1', name: 'Edu One', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education' },
  { id: 'tl-med', name: 'Med TL', role: 'EMPLOYEE', atsRole: 'TL', atsDepartment: 'Medical' },
  { id: 'tl-edu', name: 'Edu TL', role: 'EMPLOYEE', atsRole: 'TL', atsDepartment: 'Education' },
];
const camps = [
  { id: 'c1', name: 'Nurses', type: 'candidate_lead', createdById: 'r-med1', createdAt: Date.now(), status: 'done', kind: 'job' },
  { id: 'c2', name: 'Doctors', type: 'candidate_lead', createdById: 'r-med2', createdAt: Date.now(), status: 'running', kind: 'job' },
  { id: 'c3', name: 'Teachers', type: 'candidate_lead', createdById: 'r-edu1', createdAt: Date.now(), status: 'done', kind: 'job' },
  { id: 'c4', name: 'Staff notice', type: 'internal', createdById: 'r-med1', createdAt: Date.now(), status: 'done' },
];
prisma.user.findMany = async () => users.map((u) => ({ ...u, status: 'Active' }));
S.campaignsReady = async () => true;
S.q = async (sql, ...ps) => {
  if (/FROM "OutreachCampaign" WHERE id = \?/.test(sql)) return camps.filter((c) => c.id === ps[0]);
  if (/FROM "OutreachCampaign"/.test(sql)) return camps.filter((c) => c.type !== 'internal' && ps.includes(c.createdById));
  if (/COUNT\(\*\) n FROM "OutreachMessage"/.test(sql)) return [{ n: 2 }];
  if (/FROM "OutreachMessage" m/.test(sql)) return [{ status: 'delivered', channel: 'whatsapp', sentAt: Date.now(), deliveredAt: Date.now(), readAt: null, repliedAt: Date.now(), name: 'Asha' }, { status: 'sent', channel: 'whatsapp', sentAt: Date.now(), name: 'Ravi' }];
  return [];
};
Camp.ensureKind = async () => {};
Camp.countsFor = async (ids) => Object.fromEntries(ids.map((id) => [id, { total: 10, sent: 10, delivered: 8, read: 5, replied: 3, failed: 1 }]));

(async () => {
  const medTl = { ...users[3] }; const eduTl = { ...users[4] }; const rec = { ...users[0] }; const admin = { id: 'a1', role: 'SUPER_ADMIN', atsRole: 'ADMIN' };

  const m = await T.team(medTl);
  assert.deepEqual(m.recruiters.map((r) => r.id).sort(), ['r-med1', 'r-med2'], 'Medical TL sees the two Medical recruiters only');
  assert.deepEqual(m.campaigns.map((c) => c.id).sort(), ['c1', 'c2'], 'only their campaigns (no Education, no internal)');
  assert.equal(m.totals.sent, 20); assert.equal(m.totals.replied, 6); assert.equal(m.totals.delivered, 16);
  assert.match(m.scopeWords, /Medical/);
  const e = await T.team(eduTl);
  assert.deepEqual(e.campaigns.map((c) => c.id), ['c3'], 'Education TL sees Education only');
  assert.ok(!JSON.stringify(e).includes('Med One'), 'nothing of Medical reaches the Education TL');

  // the people of a campaign: own team yes, another department 404
  const p = await T.campaignPeople(medTl, 'c1');
  assert.equal(p.people.length, 2); assert.equal(p.people[0].replied, true);
  assert.ok(!JSON.stringify(p).match(/phone|email|\d{10}/i), 'no phone or email in the answer');
  assert.equal((await T.campaignPeople(eduTl, 'c1')).status, 404, 'Education TL cannot open a Medical campaign');
  assert.equal((await T.campaignPeople(medTl, 'c3')).status, 404);
  assert.equal((await T.campaignPeople(medTl, 'c4')).status, 404, 'internal staff messages never');

  // Admin: everything, may pick a department
  const a = await T.team(admin);
  assert.equal(a.campaigns.length, 3); assert.equal(a.all, true); assert.ok(a.departments.includes('Education'));
  assert.deepEqual((await T.team(admin, { department: 'Education' })).campaigns.map((c) => c.id), ['c3']);
  // a recruiter gets nothing
  assert.equal((await T.team(rec)).status, 403);
  assert.equal((await T.campaignPeople(rec, 'c1')).status, 403);
  console.log('omniTeamView: all passed');
  process.exit(0);
})().catch((x) => { console.error(x); process.exit(1); });
