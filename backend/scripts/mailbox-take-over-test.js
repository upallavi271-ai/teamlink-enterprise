// ---------------------------------------------------------------------------
// routes/portalMailboxes.js POST / - a Naukri / Shine mailbox that is ALREADY connected is moved, not refused (founder 2026-10-29:
// "mail already unna kudaa ... vere person kii add chestey tisukovaliii"). Runs the real route against a STAND-IN portal (no real
// mailbox, no login); the position map in AppSetting is put back exactly as it was.
//   node scripts/mailbox-take-over-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const prisma = require('../src/db');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };

const calls = [];
const portal = {
  connections: [{ id: 'mbx1', source: 'shine', sourceLabel: 'Shine', address: 'shine-box@example.invalid', recruiterId: 'r_old', recruiterName: 'Niveditha.M', status: 'connected', password: 'old-pw' },
    { id: 'mbx2', source: 'shine', sourceLabel: 'Shine', address: 'off-box@example.invalid', recruiterId: 'r_old', recruiterName: 'Niveditha.M', status: 'disconnected', password: null }],
  recruiters: [{ id: 'r_old', name: 'Niveditha.M', email: 'old@x.invalid' }, { id: 'r_new', name: 'New Holder', email: 'new@x.invalid' }],
  good: 'right-pw',
};
const find = (id) => portal.connections.find((c) => c.id === id);
stub('../src/utils/jobPortalBridge', {
  portalFetch: async (p, o = {}) => {
    calls.push([p, o.method || 'GET']);
    if (p.endsWith('/recruiters')) return { recruiters: portal.recruiters };
    let m = /source-connections\/([^/]+)\/reassign$/.exec(p);
    if (m) { const c = find(m[1]); c.recruiterId = o.body.recruiterId; c.recruiterName = portal.recruiters.find((r) => r.id === c.recruiterId).name; return { connection: { ...c } }; }
    m = /source-connections\/([^/]+)\/reconnect$/.exec(p);
    if (m) {
      if (o.body.appPassword !== portal.good) throw Object.assign(new Error('job portal answered 400'), { status: 400, portalError: { code: 'MAILBOX_LOGIN_FAILED', message: 'The mail server refused the login.' } });
      const c = find(m[1]); c.password = o.body.appPassword; c.status = 'connected'; return { connection: { ...c } };
    }
    if (p.endsWith('/source-connections') && o.method === 'POST') { const c = { id: `mbx${portal.connections.length + 1}`, ...o.body, recruiterName: 'New Holder', status: 'connected' }; portal.connections.push(c); return { connection: c }; }
    if (p.endsWith('/source-connections')) return { connections: portal.connections.map((c) => ({ ...c })) };
    throw new Error(`unexpected ${p}`);
  },
});
const seat = { code: 'MFG-9', kind: 'RECRUITER', department: 'Manufacturing', team: null, holder: { name: 'New Holder', email: 'new@x.invalid' } };
stub('../src/utils/jobPortalRecruiters', {
  ensureQuietly: async () => null, seatList: async () => [seat], seatData: async () => [],
  people: async () => [{ name: 'New Holder', email: 'new@x.invalid', department: 'Manufacturing', seats: ['MFG-9'] }], successorOf: async () => null,
});
stub('../src/middleware/auth', { requireAuth: (req, _res, next) => { req.user = { id: 'test-admin', name: 'Test Admin' }; next(); } });
stub('../src/utils/permissions', { requirePerm: () => (_req, _res, next) => next() });
stub('../src/utils/audit', { logAudit: async () => null });
const S = require('../src/utils/mailboxSeats');
const app = express(); app.use(express.json()); app.use('/m', require('../src/routes/portalMailboxes'));

(async () => {
  const before = await prisma.appSetting.findUnique({ where: { key: S.KEY } });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/m`;
  const post = async (body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    await S.saveMap({ mbx1: { seat: 'OLD-1' } });
    const n = portal.connections.length;
    let r = await post({ source: 'shine', seat: 'MFG-9', address: 'Shine-Box@example.invalid', provider: 'gmail' });
    ok('already connected + no password: taken, not refused', r.status === 200 && r.body.moved === true, `${r.status} ${r.body.message || JSON.stringify(r.body.error)}`);
    ok('the SAME connection moved to the new position holder', find('mbx1').recruiterId === 'r_new' && portal.connections.length === n);
    ok('the saved app password was kept', find('mbx1').password === 'old-pw' && !calls.some(([p]) => /mbx1\/reconnect/.test(p)));
    ok('plain note: "This mailbox was with X - it is now with Y"', /was with Niveditha\.M \(OLD-1\) - it is now with New Holder \(MFG-9\)/.test(r.body.message || ''), r.body.message);
    ok('the old position is unlinked, the new one linked', (await S.loadMap()).mbx1.seat === 'MFG-9');
    find('mbx1').recruiterId = 'r_old';
    r = await post({ source: 'shine', seat: 'MFG-9', address: 'shine-box@example.invalid', provider: 'gmail', appPassword: 'wrong-pw' });
    ok('a wrong new password: refused, nothing moved', r.status === 400 && find('mbx1').recruiterId === 'r_old' && find('mbx1').password === 'old-pw', String(r.status));
    r = await post({ source: 'shine', seat: 'MFG-9', address: 'shine-box@example.invalid', provider: 'gmail', appPassword: 'right-pw' });
    ok('a right new password: saved on the same connection, then moved', r.status === 200 && find('mbx1').password === 'right-pw' && find('mbx1').recruiterId === 'r_new' && portal.connections.length === n);
    r = await post({ source: 'shine', seat: 'MFG-9', address: 'off-box@example.invalid', provider: 'gmail' });
    ok('a disconnected one without a password: asks for it (its saved one was erased)', r.status === 422 && find('mbx2').recruiterId === 'r_old');
    r = await post({ source: 'shine', seat: 'MFG-9', address: 'brand-new@example.invalid', provider: 'gmail', appPassword: 'x' });
    ok('a new address is a normal new connection', r.status === 201 && portal.connections.length === n + 1);
    r = await post({ source: 'naukri', seat: 'MFG-9', address: 'shine-box@example.invalid', provider: 'gmail', appPassword: 'x' });
    ok('the same address for the other board goes to the portal as before (its own check)', calls.filter(([p, m]) => p.endsWith('/source-connections') && m === 'POST').length === 2);
  } finally {
    server.close();
    if (before) await prisma.appSetting.update({ where: { key: S.KEY }, data: { value: before.value } });
    else await prisma.appSetting.delete({ where: { key: S.KEY } }).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
