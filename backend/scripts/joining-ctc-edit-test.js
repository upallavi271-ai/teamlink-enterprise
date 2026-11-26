// JOINING CTC EDIT (routes/joiningCtc.js, founder 2026-11-26): on a COPY of a database, with its own server.
//   TEST_SOURCE_DB=<a .db file> node scripts/joining-ctc-edit-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `ctc-edit-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
const DB_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.DATABASE_URL = DB_URL;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.DATABASE_URL = DB_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'ctc-edit-test-only-secret';
const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const API = `http://localhost:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

(async () => {
  const { PrismaClient } = require(path.join(__dirname, '..', 'node_modules/@prisma/client'));
  const p = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`${API}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(1000); }
    if (!up) throw new Error(`server did not start\n${log.slice(-600)}`);
    const jwt = require('jsonwebtoken');
    const sa = await p.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    const admin = await p.user.findFirst({ where: { role: 'ADMIN', status: 'Active' } });
    for (const u of [sa, admin].filter(Boolean)) await p.user.update({ where: { id: u.id }, data: { passwordChangedAt: new Date() } });
    const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (u, method, url, body) => { const r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

    // two joined applications with a percentage invoice each: one unpaid, one paid
    const apps = await p.application.findMany({ where: { stage: { in: ['JOINED', 'HIRED'] }, requirement: { clientId: { not: undefined } } }, take: 50, select: { id: true, candidateId: true, requirementId: true, requirement: { select: { clientId: true } } } });
    const pick = [];
    for (const a of apps) {
      if (pick.length >= 2) break;
      const has = await p.invoice.findFirst({ where: { candidateId: a.candidateId, requirementId: a.requirementId } });
      if (!has && a.requirement && a.requirement.clientId) pick.push(a);
    }
    if (pick.length < 2) throw new Error('the copy needs 2 joined applications without an invoice');
    const mk = (a, n) => p.invoice.create({ data: { invoiceNumber: `ZZCTC-${Date.now()}-${n}`, clientId: a.requirement.clientId, candidateId: a.candidateId, requirementId: a.requirementId, amount: 42000, gst: 7560, tds: 4200, gstPercent: 18, tdsPercent: 10, gstType: 'CGST_SGST', offeredCtc: 420000, feePercent: 10, invoiceDate: '2026-11-01', status: 'Pending' } });
    const [unpaid, paid] = [await mk(pick[0], 1), await mk(pick[1], 2)];
    await p.application.update({ where: { id: pick[0].id }, data: { offeredCtc: 420000 } });
    await p.application.update({ where: { id: pick[1].id }, data: { offeredCtc: 420000 } });
    await p.invoice.update({ where: { id: paid.id }, data: { receivedAmount: 45360, status: 'Paid' } });

    const g = await call(sa, 'GET', `/ats/joining-ctc/${pick[0].id}`);
    check('Super Admin sees Change on an invoiced, unpaid joining', g.s === 200 && g.j.canEdit === true && g.j.invoiced && g.j.invoiceWillChange && g.j.feePercent === 10, g.j);
    const noReason = await call(sa, 'POST', `/ats/joining-ctc/${pick[0].id}`, { offeredCtc: 480000, confirmCtc: true });
    check('an invoiced joining needs a reason', noReason.s === 400 && noReason.j.needsReason, noReason);
    const ok = await call(sa, 'POST', `/ats/joining-ctc/${pick[0].id}`, { offeredCtc: 480000, confirmCtc: true, reason: 'typed 4.2 L instead of 4.8 L' });
    const inv = await p.invoice.findUnique({ where: { id: unpaid.id } });
    const app = await p.application.findUnique({ where: { id: pick[0].id } });
    check('saved: the application CTC is 4,80,000', ok.s === 200 && app.offeredCtc === 480000, ok);
    check('the invoice follows: 10% of 4,80,000 = 48,000 before GST', inv.amount === 48000 && inv.offeredCtc === 480000, inv);
    check('GST and TDS worked out again at the invoice\'s own rates (18% / 10%)', Math.abs(inv.gst - 8640) < 1 && Math.abs(inv.tds - 4800) < 1, [inv.gst, inv.tds]);
    check('the answer says what changed', /42,000/.test(ok.j.message || '') && /48,000/.test(ok.j.message || ''), ok.j.message);
    const audit = await p.auditLog.findFirst({ where: { entity: 'Invoice', entityId: unpaid.id, action: 'Invoice corrected: joining CTC changed' } });
    check('the correction is in the audit log with the reason', !!audit && /typed 4.2 L/.test(audit.reason || ''), audit);

    const g2 = await call(sa, 'GET', `/ats/joining-ctc/${pick[1].id}`);
    check('a paid invoice: no Change, and it says why', g2.j.canEdit === false && /received/i.test(g2.j.why || ''), g2.j);
    const p2 = await call(sa, 'POST', `/ats/joining-ctc/${pick[1].id}`, { offeredCtc: 500000, confirmCtc: true, reason: 'x' });
    const inv2 = await p.invoice.findUnique({ where: { id: paid.id } });
    check('a paid invoice is refused and stays as it was', p2.s === 409 && inv2.amount === 42000, [p2.s, inv2.amount]);

    if (admin) {
      const g3 = await call(admin, 'GET', `/ats/joining-ctc/${pick[0].id}`);
      const p3 = await call(admin, 'POST', `/ats/joining-ctc/${pick[0].id}`, { offeredCtc: 490000, confirmCtc: true, reason: 'x' });
      check('an Admin (not Super Admin) cannot change it', g3.j.canEdit === false && p3.s === 403, [g3.j, p3.s]);
    }
    const same = await call(sa, 'POST', `/ats/joining-ctc/${pick[0].id}`, { offeredCtc: 480000, confirmCtc: true, reason: 'again' });
    check('the same CTC again changes nothing', same.s === 200 && same.j.unchanged);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.stack || e.message}`);
  } finally {
    await p.$disconnect();
    server.kill(); await sleep(500);
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
