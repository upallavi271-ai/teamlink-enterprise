#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INTERESTED ONLY GET A LOGIN (founder 2026-11-04: "import chesina data lo interested ani unte ney login credentials pampali, not interested
// ani cheppite pettodhu, malli sheets pedithe aa sheets lo already unna candidate interested ani cheppite interested ani ravali, kani malli
// duplicates create cheyyodhu"). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/candidate-interest-import-test.js
// Proves: the Interested column is read (typos, yes / no); Not Interested and blank rows are never offered a login; a second sheet that marks
// someone already on file Interested changes that candidate (no second candidate) and queues the login once; a candidate typed by hand
// (nothing recorded) is offered a login as before.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CINT');
const path = require('path');
const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));

(async () => {
  try {
    const { prisma } = Z;
    const L = require(path.join(Z.BACK, 'src/utils/candidateLogins'));
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true });
    const tok = await Z.mint(admin);
    const sheet = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Candidates'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
    const upload = async (step, buf) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'recruiter-sheet.xlsx');
      const r = await fetch(`${Z.API}/api/ats-io/import/candidates/${step}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: fd });
      const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
      return { status: r.status, body, text };
    };
    const N = (s) => `ZZTEST CINT ${s} ${Z.RUN}`;
    const e = (s) => `zz-cint-${s}-${Z.RUN}@example.test`;
    const base = { 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 };
    const mine = async () => prisma.candidate.findMany({ where: { AND: [{ name: { contains: 'ZZTEST CINT' } }, { name: { contains: Z.RUN } }] }, select: { id: true, name: true, email: true, interestStatus: true } });
    const track = async () => { (await mine()).forEach((c) => { if (!Z.made.cands.includes(c.id)) Z.made.cands.push(c.id); }); };
    const by = async (s) => (await mine()).filter((c) => c.email === e(s));
    const offered = async (ids) => prisma.candidate.count({ where: { AND: [L.reachable(), { id: { in: ids } }] } });

    // ---- sheet 1: the recruiter's call list ----
    const rows1 = [
      { 'Full Name': N('Anu'), Email: e('anu'), Status: 'Interested', ...base },
      { 'Full Name': N('Bala'), Email: e('bala'), Status: 'intrested', ...base },
      { 'Full Name': N('Chitra'), Email: e('chitra'), Status: 'Not Interested', ...base },
      { 'Full Name': N('Deepa'), Email: e('deepa'), Status: 'Call back', ...base },
      { 'Full Name': N('Esha'), Email: e('esha'), Status: '', ...base },
    ];
    const chk = await upload('check', sheet(rows1));
    Z.check('A1 the check reads the sheet; the "Status" column is taken as Interested', chk.status === 200 && chk.body && chk.body.totals && chk.body.totals.create === 5, [chk.status, chk.text.slice(0, 300)]);
    const c1 = await upload('commit', sheet(rows1));
    await track();
    Z.check('A2 committed', c1.status === 200 && c1.body && c1.body.committed === true, [c1.status, c1.text.slice(0, 300)]);
    const st = Object.fromEntries((await mine()).map((c) => [c.email, c.interestStatus]));
    Z.check('A3 Interested / intrested -> INTERESTED; Not Interested -> NOT_INTERESTED; "Call back" and blank -> NOT_ASKED',
      st[e('anu')] === 'INTERESTED' && st[e('bala')] === 'INTERESTED' && st[e('chitra')] === 'NOT_INTERESTED' && st[e('deepa')] === 'NOT_ASKED' && st[e('esha')] === 'NOT_ASKED', st);
    const ids = Object.fromEntries((await mine()).map((c) => [c.email, c.id]));
    Z.check('A4 only the two Interested ones are offered a login (the sweep\'s own filter)', (await offered(Object.values(ids))) === 2);

    // ---- sheet 2: the same people again, Chitra and Deepa now Interested ----
    const before = (await mine()).length;
    const rows2 = [
      { 'Full Name': N('Anu'), Email: e('anu'), Status: 'Interested', ...base },
      { 'Full Name': N('Chitra'), Email: ` ${e('chitra').toUpperCase()} `, Status: 'Interested', ...base },
      { 'Full Name': N('Deepa'), Email: e('deepa'), Status: 'yes', ...base },
      { 'Full Name': N('Esha'), Email: e('esha'), Status: 'NI', ...base },
    ];
    const c2 = await upload('commit', sheet(rows2));
    await track();
    Z.check('B1 second sheet committed', c2.status === 200 && c2.body && c2.body.committed === true, [c2.status, c2.text.slice(0, 300)]);
    Z.check('B2 no candidate was made twice', (await mine()).length === before && (await by('chitra')).length === 1, (await mine()).length);
    const st2 = Object.fromEntries((await mine()).map((c) => [c.email, c.interestStatus]));
    Z.check('B3 Chitra and Deepa are Interested now; Esha Not Interested; Anu stays Interested',
      st2[e('chitra')] === 'INTERESTED' && st2[e('deepa')] === 'INTERESTED' && st2[e('esha')] === 'NOT_INTERESTED' && st2[e('anu')] === 'INTERESTED', st2);
    const s = await L.settings();
    const queued = s.retry.map((r) => r.id);
    Z.check('B4 the two newly Interested are queued for their login (once each), Anu (already Interested) is not queued again',
      queued.includes(ids[e('chitra')]) && queued.includes(ids[e('deepa')]) && !queued.includes(ids[e('anu')]) && queued.filter((x) => x === ids[e('chitra')]).length === 1, queued.length);
    Z.check('B5 now four are offered a login, Esha is not', (await offered(Object.values(ids))) === 4);

    // ---- the same sheet once more: nothing changes ----
    const c3 = await upload('commit', sheet(rows2));
    Z.check('C1 the same sheet again changes nothing and makes nobody twice', c3.status === 200 && (await mine()).length === before && (await L.settings()).retry.filter((r) => r.id === ids[e('chitra')]).length === 1);

    // ---- a candidate typed by hand: nothing recorded = offered as before ----
    const typed = await prisma.candidate.create({ data: { name: N('Typed'), email: e('typed') } });
    Z.made.cands.push(typed.id);
    Z.check('D1 a candidate typed by hand (no answer recorded) is still offered a login', (await offered([typed.id])) === 1);
  } catch (err) {
    Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err);
  } finally {
    // the queued ids of this run leave the waiting list too
    try {
      const L = require(path.join(Z.BACK, 'src/utils/candidateLogins'));
      const s = await L.settings();
      const gone = new Set(Z.made.cands);
      const row = await Z.prisma.integration.findUnique({ where: { id: L.STORE_ID } });
      if (row) await Z.prisma.integration.update({ where: { id: L.STORE_ID }, data: { values: JSON.stringify({ ...JSON.parse(row.values || '{}'), retry: s.retry.filter((r) => !gone.has(r.id)) }) } });
    } catch { /* the waiting list only holds ids */ }
    await Z.cleanup().catch((err) => console.log('cleanup problem', String(err.message).slice(0, 160)));
    console.log(`
${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
