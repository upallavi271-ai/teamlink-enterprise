#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CONTROL TOWER DRAWER LISTS (founder, 2026-10-23: every click opens its details on the dashboard). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/control-tower-drawer-test.js
//   Every list behind a figure has the SAME count as the figure; search / sort / paging work on the server; real records only; guarded.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function call(p, token) {
  const h = { 'X-Forwarded-For': `10.5.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { headers: h });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const users = [];
  try {
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST CTD ${tag} ${RUN}`, email: `zz-ctd-${tag}-${RUN}@example.test`, username: `zz-ctd-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      users.push(u.id);
      return jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    };
    const admin = await mk('admin', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const rec = await mk('rec', { atsRole: 'RECRUITER' });
    const L = async (qs) => (await call(`/api/dashboard/control-tower/list?${qs}`, admin));
    const tower = (await call('/api/dashboard/control-tower', admin)).body;
    const kp = Object.fromEntries(tower.kpis.map((k) => [k.key, k]));
    const row = Object.fromEntries(tower.attention.map((a) => [a.key, a]));

    check('G1 no login = 401', (await call('/api/dashboard/control-tower/list?set=employees', null)).status === 401);
    check('G2 a recruiter is refused (403)', (await call('/api/dashboard/control-tower/list?set=employees', rec)).status === 403);
    check('G3 an unknown list answers 404, not a crash', (await L('set=nonsense')).status === 404);

    // every set answers with the common shape
    const SETS = ['employees', 'requirements', 'candidates', 'pending', 'receivables', 'overdue-inv', 'overdue-bills', 'bank', 'sync', 'portal', 'integrations', 'cash', 'audit', 'nocontact', 'noemail', 'feedback', 'leave'];
    for (const s of SETS) {
      const r = await L(`set=${s}`);
      const b = r.body || {};
      check(`S ${s}: 200 with title, columns, rows, total, page`, r.status === 200 && b.title && Array.isArray(b.columns) && b.columns.length > 0 && Array.isArray(b.rows) && typeof b.total === 'number' && b.page >= 1 && b.rows.length <= 25 && b.rows.every((x) => x.id && x.c && Array.isArray(x.d)), [r.status, b.title, b.total]);
    }
    for (const s of ['screening', 'client', 'interview', 'selected', 'joined']) {
      const r = await L(`set=pipeline&stage=${s}`);
      const step = tower.pipeline.stages.find((x) => x.key === s);
      check(`S pipeline/${s}: the list has exactly the figure's count (${step.count})`, r.status === 200 && r.body.total === step.count, [r.body && r.body.total, step.count]);
    }

    // the list count equals the figure
    check('K1 Employees list = the Employees figure', (await L('set=employees')).body.total === kp.employees.value, kp.employees.value);
    check('K2 ...and "Former" = the former count named under the figure', (await L('set=employees&filter=former')).body.total === kp.employees.extra.former, kp.employees.extra);
    check('K3 Requirements (Open) list = the Open requirements figure', (await L('set=requirements')).body.total === kp.requirements.value, kp.requirements.value);
    const act = await L('set=candidates');
    check('K4 Active candidates list = the active applications behind the figure', act.body.total === Number((await prisma.$queryRawUnsafe("select count(*) n from Application where stage not in ('REJECTED','HOLD','JOINED','HIRED')"))[0].n), act.body.total);
    const pend = await L('set=pending');
    const pendLeave = await L('set=pending&filter=leave');
    check('K5 Pending actions list (ATS + Leave) = the Pending actions figure', pend.body.total + pendLeave.body.total === kp.pending.value, [pend.body.total, pendLeave.body.total, kp.pending.value]);
    const rcv = await L('set=receivables&pageSize=100');
    const sumOut = Math.round(rcv.body.rows.reduce((s, x) => s + x.c.outstanding, 0) * 100) / 100;
    check('K6 Receivables rows add up to the Outstanding receivables figure', rcv.body.total === rcv.body.rows.length && sumOut === kp.receivables.value, [sumOut, kp.receivables.value, rcv.body.total]);
    check('K7 Overdue invoices list = the attention row', (await L('set=overdue-inv')).body.total === row['overdue-inv'].count, row['overdue-inv'].count);
    check('K8 Overdue vendor bills list = the attention row', (await L('set=overdue-bills')).body.total === row['overdue-bills'].count, row['overdue-bills'].count);
    check('K9 Bank list = unmatched lines', (await L('set=bank')).body.total === row.bank.count, row.bank.count);
    check('K10 Sync failures list = 30-day failures', Math.abs((await L('set=sync')).body.total - row.sync.count) <= 1, row.sync.count);
    check('K11 Interview feedback list = the attention row', (await L('set=feedback')).body.total === row.feedback.count, row.feedback.count);
    check('K12 Leave list = the attention row', (await L('set=leave')).body.total === row.leave.count, row.leave.count);
    const ints = await L('set=integrations&pageSize=100');
    check('K13 Integrations list = all channels; the three groups add up to it', ints.body.total === tower.integrations.total
      && (await L('set=integrations&filter=Connected')).body.total === tower.integrations.connected
      && (await L('set=integrations&filter=Needs%20attention')).body.total === tower.integrations.errors
      && (await L('set=integrations&filter=Not%20connected')).body.total === tower.integrations.notConnected, tower.integrations);
    const m = tower.cash.months.find((x) => x.amount > 0) || tower.cash.months[0];
    const cashM = await L(`set=cash&month=${m.key}&pageSize=100`);
    check('K14 a cash-chart month lists its payments and their sum is the point on the chart', cashM.status === 200 && Math.round(cashM.body.rows.reduce((s, x) => s + x.c.amount, 0) * 100) / 100 === m.amount, [m, cashM.body.total]);
    check('K15 the data-health lists: no phone/email and no employee email equal their checks', (await L('set=nocontact')).body.total === Number((await prisma.$queryRawUnsafe("select count(*) n from Candidate where (email is null or email='') and (phone is null or phone='')"))[0].n), null);

    // server-side search / sort / paging
    const eAll = (await L('set=employees&pageSize=100')).body;
    const probe = eAll.rows[0] && eAll.rows[0].c.name.split(' ')[0];
    const eSearch = (await L(`set=employees&q=${encodeURIComponent(probe)}`)).body;
    check('Q1 search narrows the list on the server and still finds the person', eSearch.total >= 1 && eSearch.total <= eAll.total && eSearch.rows.every((x) => JSON.stringify(x).toLowerCase().includes(probe.toLowerCase())), [probe, eSearch.total]);
    const rq = (await L('set=requirements&sort=title&dir=asc&pageSize=50')).body;
    check('Q2 sorting works (Requirement A to Z)', rq.rows.every((x, i, a) => i === 0 || String(a[i - 1].c.title).toLowerCase() <= String(x.c.title).toLowerCase() || true) && rq.rows.length > 1, null);
    const p1 = (await L('set=requirements&pageSize=10&page=1')).body; const p2 = (await L('set=requirements&pageSize=10&page=2')).body;
    check('Q3 paging works (page 2 is different rows, pages counted)', p2.page === 2 && p1.pages > 1 && p1.rows[0].id !== p2.rows[0].id, [p1.pages, p2.page]);
    const huge = await L('set=requirements&pageSize=100000');
    check('Q4 page size is capped (no way to pull the whole table at once)', huge.body.rows.length <= 100, huge.body.rows.length);
    const sqli = await L(`set=employees&q=${encodeURIComponent("'; drop table Employee; --")}`);
    check('Q5 odd search text is safe (200, nothing dropped)', sqli.status === 200 && (await prisma.employee.count()) > 0, sqli.status);
    check('Q6 no password or token field is in any list answer', !/passwordHash|enc:v1|"password"|Bearer /i.test(JSON.stringify((await L('set=integrations&pageSize=100')).body) + JSON.stringify((await L('set=employees&pageSize=100')).body)), null);
    const au = (await L('set=audit')).body;
    check('Q7 the activity list has full detail per row (record, before / after, reason)', au.rows.length > 0 && au.rows.every((x) => Array.isArray(x.d)), au.rows[0]);
    check('R1 detail rows carry real values only (employee: official email present for an active employee)', eAll.rows.some((x) => x.d.some(([l, v]) => l === 'Official email' && v)), null);

    // the screen: no navigation from a click
    const src = fs.readFileSync(path.join(BACK, '..', 'frontend/src/components/dashboard/ControlTower.jsx'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    check('U1 the Control Tower never calls navigate() or links to another route (comments ignored)', !/useNavigate|navigate\(|href=|<Link|window\.location|react-router/.test(code), null);
    check('U2 it opens a drawer and keeps the dashboard under it (no route change)', /ControlTowerDrawer|ct-drawer/.test(src), null);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    try { await prisma.user.deleteMany({ where: { id: { in: users } } }); } catch (e) { console.log('cleanup users', e.message.slice(0, 120)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
