// ---------------------------------------------------------------------------
// utils/mailboxSeats.js - a mailbox follows its HRMS position. Runs against a STAND-IN portal (no real mailbox is touched); the
// mapping is written to this database's AppSetting and put back exactly as it was at the end.
//   node scripts/mailbox-seats-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const prisma = require('../src/db');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

// the stand-in portal: two connections, three portal logins; reassign is recorded
const portal = {
  connections: [
    { id: 'c1', source: 'shine', sourceLabel: 'Shine', address: 'shine-mfg@example.invalid', recruiterId: 'r_old', recruiterName: 'Old Person', status: 'connected', credential: 'sealed-1' },
    { id: 'c2', source: 'naukri', sourceLabel: 'Naukri', address: 'naukri@example.invalid', recruiterId: 'r_n', recruiterName: 'Naukri Person', status: 'connected', credential: 'sealed-2' },
  ],
  recruiters: [{ id: 'r_old', name: 'Old Person', email: 'old@x.invalid' }, { id: 'r_new', name: 'New Person', email: 'new@x.invalid' }, { id: 'r_n', name: 'Naukri Person', email: 'n@x.invalid' }],
  reassigns: [],
};
const bridge = require.resolve('../src/utils/jobPortalBridge');
require.cache[bridge] = { id: bridge, filename: bridge, loaded: true, exports: {
  portalFetch: async (p, o = {}) => {
    if (p.endsWith('/recruiters')) return { recruiters: portal.recruiters };
    const m = /source-connections\/([^/]+)\/reassign$/.exec(p);
    if (m) { const c = portal.connections.find((x) => x.id === decodeURIComponent(m[1])); portal.reassigns.push([c.id, o.body.recruiterId]); c.recruiterId = o.body.recruiterId; c.recruiterName = portal.recruiters.find((r) => r.id === o.body.recruiterId).name; return { connection: c }; }
    if (p.endsWith('/source-connections')) return { connections: portal.connections };
    throw new Error(`unexpected ${p}`);
  },
} };
// HRMS seats as the test needs them
let holder = { name: 'Old Person', email: 'old@x.invalid' };
const recs = require.resolve('../src/utils/jobPortalRecruiters');
require.cache[recs] = { id: recs, filename: recs, loaded: true, exports: {
  seatList: async () => [{ code: 'MFG-9', kind: 'RECRUITER', department: 'Manufacturing', team: null, holder }],
} };
const S = require(path.join('..', 'src', 'utils', 'mailboxSeats'));

(async () => {
  const before = await prisma.appSetting.findUnique({ where: { key: S.KEY } });
  try {
    await S.saveMap({});
    ok('nothing mapped: nothing moves', (await S.reconcile({ apply: true })).length === 0 && portal.reassigns.length === 0);
    await S.setSeat('c1', 'MFG-9', { name: 'test' });
    let r = await S.reconcile({ apply: true });
    ok('mapped, same holder: stays', r.length === 1 && r[0].result === 'ok' && portal.reassigns.length === 0, JSON.stringify(r));
    holder = { name: 'New Person', email: 'new@x.invalid' }; // HRMS: someone else takes MFG-9
    r = await S.reconcile({ apply: false });
    ok('dry run says it would move, moves nothing', r[0].result === 'would-move' && r[0].toName === 'New Person' && portal.reassigns.length === 0);
    r = await S.reconcile({ apply: true });
    ok('new holder: the SAME connection moves to them', r[0].result === 'moved' && portal.reassigns.length === 1 && portal.reassigns[0][0] === 'c1' && portal.reassigns[0][1] === 'r_new');
    ok('connection kept: same id, same saved password, no second connection', portal.connections.length === 2 && portal.connections[0].id === 'c1' && portal.connections[0].credential === 'sealed-1');
    ok('the Naukri mailbox (not mapped) is untouched', portal.connections[1].recruiterId === 'r_n');
    r = await S.reconcile({ apply: true });
    ok('again: nothing more to do', r[0].result === 'ok' && portal.reassigns.length === 1);
    holder = null; // seat empty
    r = await S.reconcile({ apply: true });
    ok('seat empty: the mailbox stays with the last holder', r[0].result === 'seat-empty' && portal.connections[0].recruiterId === 'r_new' && portal.reassigns.length === 1);
    holder = { name: 'Someone Without Login', email: 'nologin@x.invalid' };
    r = await S.reconcile({ apply: true });
    ok('holder without a portal login yet: waits, nothing breaks', r[0].result === 'seat-empty' && portal.reassigns.length === 1);
    portal.connections[0].status = 'disconnected'; holder = { name: 'Old Person', email: 'old@x.invalid' };
    r = await S.reconcile({ apply: true });
    ok('a disconnected mailbox is left alone', r.length === 0 && portal.reassigns.length === 1);
  } finally {
    if (before) await prisma.appSetting.update({ where: { key: S.KEY }, data: { value: before.value } });
    else await prisma.appSetting.delete({ where: { key: S.KEY } }).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
