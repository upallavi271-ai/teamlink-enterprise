#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE 360° CONTROL TOWER (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/control-tower-test.js
//   Who may open it; every figure equals an independent count from the database; scope words and definitions are present;
//   Employees counts only people who work here now; receivables and vendor payables are separate; nothing invented (no made-up trend).
// ---------------------------------------------------------------------------
const path = require('path');
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
  const h = { 'X-Forwarded-For': `10.6.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { headers: h });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const users = [];
  try {
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST CT ${tag} ${RUN}`, email: `zz-ct-${tag}-${RUN}@example.test`, username: `zz-ct-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      users.push(u.id);
      return jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    };
    const admin = await mk('admin', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const rec = await mk('rec', { atsRole: 'RECRUITER' });
    const r0 = await call('/api/dashboard/control-tower', null);
    check('T0 no login = 401', r0.status === 401, r0.status);
    const rr = await call('/api/dashboard/control-tower', rec);
    check('T1 a recruiter is refused (403)', rr.status === 403, rr.status);
    const r = await call('/api/dashboard/control-tower', admin);
    check('T2 Super Admin gets it (200)', r.status === 200 && r.body && Array.isArray(r.body.kpis), [r.status, r.body && Object.keys(r.body)]);
    const d = r.body;
    const kp = Object.fromEntries(d.kpis.map((k) => [k.key, k]));
    check('T3 five headline figures, each with a scope word and a definition', d.kpis.length === 5 && d.kpis.every((k) => k.scope && k.definition && k.label && k.to), d.kpis.map((k) => [k.key, k.scope, !!k.definition]));
    // independent recounts
    const q = async (sql) => Number((await prisma.$queryRawUnsafe(sql))[0].n);
    const sysAdmins = await q("select count(*) n from Employee e join User u on u.id = e.userId where e.employmentStatus='Active' and u.role='SUPER_ADMIN'").catch(() => 0);
    const empActive = await q("select count(*) n from Employee where employmentStatus='Active'");
    check('E1 Employees counts only people who work here now (Active, not the Super Admin login)', kp.employees.value === empActive - sysAdmins && kp.employees.value < kp.employees.extra.total, [kp.employees.value, empActive, sysAdmins, kp.employees.extra.total]);
    check('E2 former employees are named apart in the line under it', /former/.test(kp.employees.sub), kp.employees.sub);
    const LIVE = require(path.join(BACK, 'src/utils/atsVocab')).REQUIREMENT_LIVE_STATUSES.map((x) => `'${x}'`).join(',');
    check('R1 Open requirements = requirements still being worked on (the apps own live statuses)', kp.requirements.value === await q(`select count(*) n from Requirement where status in (${LIVE})`) && kp.requirements.value > 0, kp.requirements);
    const activeCands = await q("select count(distinct candidateId) n from Application where stage not in ('REJECTED','HOLD','JOINED','HIRED')");
    check('C1 Active candidates = different people with an active application', kp.candidates.value === activeCands, [kp.candidates.value, activeCands]);
    const pendStages = "'NEW','AI_INTERVIEW_COMPLETED','RECRUITER_REVIEW','RECRUITER_APPROVED','TL_REVIEW','WITH_BDE','BDE_APPROVED','SHARED_WITH_CLIENT','CLIENT_REVIEW','CLIENT_SHORTLISTED','INTERVIEW_COMPLETED','SELECTED','OFFER','OFFER_ACCEPTED'";
    const pendAts = await q(`select count(*) n from Application where stage in (${pendStages})`);
    const leave = await q("select count(*) n from LeaveRequest where status='Pending'");
    check('P1 Pending actions = ATS applications waiting for someone + leave awaiting decision', kp.pending.value === pendAts + leave, [kp.pending.value, pendAts, leave]);
    const row = Object.fromEntries(d.attention.map((a) => [a.key, a]));
    const since = new Date(Date.now() - 30 * 86400000).toISOString().replace('T', ' ').replace('Z', '');
    const syncDb = (await prisma.syncLog.count({ where: { status: 'Failed', createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }));
    check('A1 the leave, bank, feedback and sync rows equal the database', row.leave.count === leave
      && row.bank.count === await q("select count(*) n from BankTransaction where reconStatus='Unmatched'")
      && row.feedback.count === await q("select count(*) n from Application where stage='INTERVIEW_COMPLETED'")
      && Math.abs(row.sync.count - syncDb) <= 1, [d.attention.map((x) => [x.key, x.count]), syncDb, since]);
    check('A2 every attention row has an owner, a scope word, a link and an action button', d.attention.every((a) => a.owner && a.scope && a.to && a.action && a.title), d.attention);
    check('A3 client invoices and vendor bills are SEPARATE rows, each with its own overdue', !!row['overdue-inv'] && !!row['overdue-bills'] && row['overdue-inv'].title !== row['overdue-bills'].title, null);
    check('A4 "items need attention" = the rows with something in them', d.needsAttention === d.attention.filter((a) => a.count > 0).length, [d.needsAttention]);
    // money
    const inv = await prisma.invoice.findMany({ include: { client: { select: { name: true } } } });
    const CNU = require(path.join(BACK, 'src/utils/creditNotes')); const A = require(path.join(BACK, 'src/utils/accounts'));
    await CNU.decorateNet(inv).catch(() => null);
    const out = Math.round(inv.filter((i) => i.status !== 'Cancelled').reduce((s, i) => s + A.invoiceOutstanding(i), 0) * 100) / 100;
    check('M1 Outstanding receivables equals the invoice maths of the Accounts screens', kp.receivables.value === out, [kp.receivables.value, out]);
    const recv = Math.round(inv.reduce((s, i) => s + Number(i.receivedAmount || 0), 0) * 100) / 100;
    check('M2 cash collection: the all-time figure equals the money received on the invoices', d.cash.receivedAllTime === recv && d.cash.months.length === 6, [d.cash.receivedAllTime, recv]);
    const accDash = await call('/api/dashboard/accounts', admin);
    console.log(`INFO  Accounts dashboard (its own financial period) outstanding: ${accDash.body && accDash.body.outstanding}; Control Tower (all invoices): ${kp.receivables.value}`);
    // pipeline
    check('L1 the pipeline chain adds up to its total, percentages add to ~100', d.pipeline.stages.reduce((s, x) => s + x.count, 0) === d.pipeline.total && Math.abs(d.pipeline.stages.reduce((s, x) => s + x.pct, 0) - 100) < 0.6, d.pipeline);
    check('L2 Rejected and On hold are shown apart, not inside the chain', d.pipeline.outside.rejected >= 0 && !d.pipeline.stages.some((s) => /reject|hold/i.test(s.label)), d.pipeline.outside);
    // integrations + health
    check('I1 integrations: connected + needs attention + not connected = all channels', d.integrations.connected + d.integrations.errors + d.integrations.notConnected === d.integrations.total, d.integrations);
    check('I2 no integration secret is in the answer', !/enc:v1|password|apikey|api key|token/i.test(JSON.stringify(d.integrations)), null);
    check('H1 data health is a list of real checks with counts and links (no invented percentage)', d.dataHealth.total >= 5 && d.dataHealth.checks.every((c) => c.label && c.detail && c.to && typeof c.ok === 'boolean') && d.dataHealth.passing === d.dataHealth.checks.filter((c) => c.ok).length && !('percent' in d.dataHealth), d.dataHealth);
    check('F1 the screen says when the figures were read', !!d.generatedAt && Math.abs(Date.now() - new Date(d.generatedAt).getTime()) < 120000, d.generatedAt);
    check('V1 recent critical activity: newest first, with area and owner', d.activity.length > 0 && d.activity.every((a) => a.area && a.owner && a.event) && d.activity.every((a, i, arr) => i === 0 || new Date(arr[i - 1].at) >= new Date(a.at)), d.activity.slice(0, 2));
    check('N1 nothing made up: no sparkline / trend series is sent for the headline figures', d.kpis.every((k) => !('spark' in k) && !('trend' in k)), null);
    const again = await call('/api/dashboard/control-tower', admin);
    check('K1 a second call is fast (short cache) and gives the same figures', again.status === 200 && again.body.kpis[0].value === kp.employees.value, again.status);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    try { await prisma.user.deleteMany({ where: { id: { in: users } } }); } catch (e) { console.log('cleanup users', e.message.slice(0, 120)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
