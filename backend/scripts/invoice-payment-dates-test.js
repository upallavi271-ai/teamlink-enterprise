#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Invoices > payment dates (Accounts, 2026-10-14). SANDBOX ONLY:
//   cd backend && TL_API=http://localhost:4011 node scripts/invoice-payment-dates-test.js
// A Rs 50,000 invoice paid in parts on different days; the date of each payment, the bank
// line's own date, no overwriting, Paid only at full amount, the payment-date filter (any date),
// no duplicates, unchanged totals, Excel dates, role access, and the dry-run-first fixer script.
// Everything made is tagged "ZZTEST PD" and removed at the end.
// ---------------------------------------------------------------------------
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const Z = require('./lib/zzfix')('PD');

const { prisma, call, check } = Z;
const FE = path.resolve(Z.BACK, '..', 'frontend');
function loadFilters() {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzpd-${Z.RUN}-invFilters.cjs`);
  esb.buildSync({ entryPoints: [path.join(FE, 'src/pages/invoices/invFilters.js')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
}
const R2 = (n) => Math.round(Number(n) * 100) / 100;
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

(async () => {
  await Z.preclean();
  const made = { txns: [], accounts: [] };
  let copyDir = null;
  try {
    const F = loadFilters();
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const mgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', accountsAccess: true, accountsRole: 'MANAGER' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false }, {});
    const T = await Z.mint(admin);

    const client = await prisma.client.create({ data: { name: `ZZTEST PD client ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(client.id);
    const mkInv = (no, amount, tds = 0, invoiceDate = '2026-09-01') => prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: no, amount, gst: 0, tds, invoiceDate, dueDate: '2026-09-30', status: 'Pending' } });
    const inv = await mkInv(`ZZPD-${Z.RUN}-A`, 50000);
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST PD Bank ${Z.RUN}`, name: `ZZTEST PD ${Z.RUN}`, accNo: '000099990009', openBal: 0, openDate: '2020-01-01' } });
    made.accounts.push(acc.id);
    const row = async (id, qs = '') => {
      const r = await call('GET', `/api/invoices/register?period=all${qs}`, T);
      return { status: r.status, row: (r.body.rows || []).find((x) => x.id === id), rows: r.body.rows || [] };
    };

    // ---- the 50,000 example: 5 Oct (typed), 8 Oct (bank line), 12 Oct (typed)
    const p1 = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 10000, date: '2026-10-05', method: 'Bank Transfer', reference: 'ZZPD-REF-1' });
    const txn = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Credit', amount: 15000, description: `NEFT CR ZZTEST PD ${Z.RUN}`, date: '2026-10-08', reference: `ZZPD-UTR-${Z.RUN}`, importBatch: null } });
    made.txns.push(txn.id);
    const al = await call('POST', `/api/bank/${txn.id}/allocate`, T, { parts: [{ invoiceId: inv.id, amount: 15000 }] });
    const p3 = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 5000, date: '2026-10-12', method: 'UPI', reference: 'ZZPD-REF-3' });
    check('P0 three payments recorded (typed, bank allocation, typed)', p1.status === 201 && al.status === 200 && p3.status === 201, [p1.status, al.status, al.body, p3.status]);

    let g = await row(inv.id);
    let r = g.row;
    check('P1 Total paid 30,000, balance due 20,000, status Partially Paid', r && r.paidTotal === 30000 && r.balanceDue === 20000 && r.received === 30000 && r.pending === 20000 && r.status === 'Partially Paid', r && [r.paidTotal, r.balanceDue, r.status]);
    check('P2 all three dates, each with its own amount, in order', r && JSON.stringify(r.paymentHistory.map((h) => [h.date, h.amount])) === JSON.stringify([['2026-10-05', 10000], ['2026-10-08', 15000], ['2026-10-12', 5000]]), r && r.paymentHistory);
    check('P3 first / last payment date and the list of dates', r && r.firstPaymentDate === '2026-10-05' && r.lastPaymentDate === '2026-10-12' && r.paymentDates.length === 3 && r.paymentDate === '2026-10-12', r && [r.firstPaymentDate, r.lastPaymentDate, r.paymentDates]);
    const bankRow = r.paymentHistory.find((h) => h.bankTxnId);
    check('P4 a payment from a bank line carries the BANK LINE date (not the day it was reconciled), source "bank", with the line reference', bankRow && bankRow.date === '2026-10-08' && bankRow.dateSource === 'bank' && bankRow.bankLineDate === '2026-10-08' && bankRow.bankLineReference === `ZZPD-UTR-${Z.RUN}` && bankRow.proof === 'bank statement', bankRow);
    check('P5 recorded-at (audit) is kept apart from the payment date: recorded today, paid earlier', r.paymentHistory.every((h) => h.recordedAt && h.recordedAt.slice(0, 10) !== h.date && h.recordedBy !== undefined), r.paymentHistory.map((h) => [h.date, h.recordedAt]));
    check('P6 no payment is dated by the invoice date, creation day or "today"', r.paymentHistory.every((h) => h.date !== r.invoiceDate && h.date !== today), r.paymentHistory.map((h) => h.date));
    check('P7 mode and reference shown per payment', r.paymentHistory[0].method === 'Bank Transfer' && r.paymentHistory[0].reference === 'ZZPD-REF-1' && r.paymentHistory[2].method === 'UPI', r.paymentHistory);

    const det = await call('GET', `/api/invoices/${inv.id}`, T);
    check('P8 invoice detail returns the same history, paid total and first/last dates', det.status === 200 && det.body.paymentHistory.length === 3 && det.body.paidTotal === 30000 && det.body.lastPaymentDate === '2026-10-12' && det.body.paymentHistory.find((h) => h.bankTxnId).bankLineDate === '2026-10-08', det.status);

    // ---- a new partial payment must not overwrite earlier dates
    const before = JSON.stringify(r.paymentHistory.map((h) => [h.id, h.date, h.amount]));
    const p4 = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 2000, date: '2026-10-13', method: 'Cash' });
    g = await row(inv.id); r = g.row;
    check('N1 a new partial payment keeps the earlier three exactly (ids, dates, amounts)', p4.status === 201 && JSON.stringify(r.paymentHistory.slice(0, 3).map((h) => [h.id, h.date, h.amount])) === before && r.paymentHistory.length === 4 && r.paymentHistory[3].date === '2026-10-13', r.paymentHistory);
    check('N2 still Partially Paid at 32,000 / balance 18,000 (paid only at the full amount)', r.status === 'Partially Paid' && r.paidTotal === 32000 && r.balanceDue === 18000 && !r.paidDate, [r.status, r.paidTotal, r.paidDate]);
    const over = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 18001, date: '2026-10-13' });
    check('N3 more than the balance is refused (no over-payment)', over.status === 400, over.status);
    const nodate = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 100 });
    const future = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 100, date: '2999-01-01' });
    check('N4 a payment needs its real date (never silently today) and not in the future', nodate.status === 400 && future.status === 400, [nodate.status, future.status]);

    // ---- payment-date filter, server side (?paymentFrom/paymentTo) and the page's own filter
    const inRangeOf = async (a, b) => (await row(inv.id, `&paymentFrom=${a}&paymentTo=${b}`)).row;
    check('F1 server: found when ANY payment is in the range (only the first / only the middle / only the last)',
      !!(await inRangeOf('2026-10-01', '2026-10-06')) && !!(await inRangeOf('2026-10-07', '2026-10-09')) && !!(await inRangeOf('2026-10-12', '2026-10-12')));
    check('F2 server: not found when no payment date is inside (gap between payments, other month)', !(await inRangeOf('2026-10-09', '2026-10-11')) && !(await inRangeOf('2026-09-01', '2026-09-30')));
    const sep = { ...F.ALL_PERIOD, from: '2026-09-01', to: '2026-09-30', preset: 'custom' };
    const oct = { ...F.ALL_PERIOD, from: '2026-10-01', to: '2026-10-31', preset: 'custom' };
    const gap = { ...F.ALL_PERIOD, from: '2026-10-09', to: '2026-10-11', preset: 'custom' };
    const mid = { ...F.ALL_PERIOD, from: '2026-10-07', to: '2026-10-09', preset: 'custom' };
    check('F3 page: invoice dated 1 Sep is in September by Invoice date, out of October by Invoice date', F.periodMatch(r, { ...sep, applyTo: 'invoice' }) === true && F.periodMatch(r, { ...oct, applyTo: 'invoice' }) === false);
    check('F4 page: the same invoice is IN October by Payment date and out of September by Payment date (the two filters are independent)', F.periodMatch(r, { ...oct, applyTo: 'payment' }) === true && F.periodMatch(r, { ...sep, applyTo: 'payment' }) === false);
    check('F5 page: any one date is enough (middle date only) and a gap between dates is not a match', F.periodMatch(r, { ...mid, applyTo: 'payment' }) === true && F.periodMatch(r, { ...gap, applyTo: 'payment' }) === false);
    const stale = { ...r, paidDate: '2026-09-15', payments: r.payments };
    check('F6 a stale invoice-level paid-on date never matches when real receipts exist', F.periodMatch(stale, { ...sep, applyTo: 'payment' }) === false);
    const noRows = { received: 5000, payments: [], paidDate: '2026-02-10' };
    check('F7 an older import with money but no receipt rows is still found by its import-sheet date', F.periodMatch(noRows, { ...F.ALL_PERIOD, from: '2026-02-01', to: '2026-02-28', preset: 'custom', applyTo: 'payment' }) === true);

    // ---- full payment => Paid, with the last receipt's own date
    const fin = await call('POST', `/api/invoices/${inv.id}/payments`, T, { amount: 18000, date: '2026-10-14', method: 'Bank Transfer', reference: 'ZZPD-REF-5' });
    g = await row(inv.id); r = g.row;
    check('N5 Paid only when the whole amount is in; paid-on = date of the last receipt; earlier dates intact', fin.status === 201 && r.status === 'Paid' && r.paidDate === '2026-10-14' && r.paidTotal === 50000 && r.balanceDue === 0 && r.paymentDates.join() === '2026-10-05,2026-10-08,2026-10-12,2026-10-13,2026-10-14', [r.status, r.paidDate, r.paymentDates]);

    // ---- no duplicates on re-allocation / second allocate
    const inv2 = await mkInv(`ZZPD-${Z.RUN}-B`, 50000, 5000);
    const txn2 = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Credit', amount: 30000, description: `NEFT CR ZZTEST PD ${Z.RUN} second`, date: '2026-10-09', reference: `ZZPD-UTR2-${Z.RUN}`, importBatch: null } });
    made.txns.push(txn2.id);
    const a1 = await call('POST', `/api/bank/${txn2.id}/allocate`, T, { parts: [{ invoiceId: inv2.id, amount: 30000 }] });
    const a2 = await call('POST', `/api/bank/${txn2.id}/allocate`, T, { parts: [{ invoiceId: inv2.id, amount: 30000 }] });
    let n = await prisma.invoicePayment.count({ where: { invoiceId: inv2.id, bankTxnId: txn2.id } });
    check('D1 allocating the same bank line twice does not create a second payment', a1.status === 200 && n === 1 && a2.status !== 200 || (a1.status === 200 && n === 1), [a1.status, a2.status, n]);
    const un = await call('POST', `/api/bank/${txn2.id}/unmatch`, T, {});
    const a3 = await call('POST', `/api/bank/${txn2.id}/allocate`, T, { parts: [{ invoiceId: inv2.id, amount: 30000 }] });
    n = await prisma.invoicePayment.count({ where: { invoiceId: inv2.id, bankTxnId: txn2.id } });
    const sumPay = (await prisma.invoicePayment.findMany({ where: { invoiceId: inv2.id } })).reduce((s, p) => s + p.amount, 0);
    const i2 = await prisma.invoice.findUnique({ where: { id: inv2.id } });
    check('D2 un-match then allocate again: still exactly one payment, amount counted once, dated by the bank line', n === 1 && R2(sumPay) === 30000 && i2.receivedAmount === 30000, [un.status, a3.status, n, sumPay, i2.receivedAmount]);
    g = await row(inv2.id); r = g.row;
    check('T1 receivable stays AFTER TDS: 50,000 - 5,000 TDS = 45,000, paid 30,000 -> balance 15,000, Partially Paid, dated 9 Oct from the bank line',
      r.receivable === 45000 && r.paidTotal === 30000 && r.balanceDue === 15000 && r.pending === 15000 && r.status === 'Partially Paid' && r.paymentDate === '2026-10-09' && r.paymentHistory[0].dateSource === 'bank', [r.receivable, r.balanceDue, r.status, r.paymentDate]);

    // ---- existing totals / calculation unchanged
    const all = (await call('GET', '/api/invoices/register?period=all', T)).body.rows;
    const bad = all.filter((x) => !x.noteCredit && !x.noteDebit && Math.abs(R2(x.receivable - x.received) - x.pending) > 0.02 && !(x.pending === 0 && x.received > x.receivable));
    const dbRecv = (await prisma.invoice.findMany({ where: { id: { in: all.map((x) => x.id) } }, select: { id: true, receivedAmount: true } }));
    const dbMap = new Map(dbRecv.map((x) => [x.id, x.receivedAmount]));
    const drift = all.filter((x) => R2(dbMap.get(x.id) || 0) !== R2(x.received));
    check('T2 every register row: pending = receivable - received as before, received = stored amount (calculation untouched)', bad.length === 0 && drift.length === 0, { bad: bad.slice(0, 3).map((x) => x.invoiceNumber), drift: drift.length });
    check('T3 every row carries the new fields, and each paid total equals the receipts + unitemised remainder', all.every((x) => Array.isArray(x.paymentHistory) && R2(x.itemisedTotal + x.unitemised) >= R2(x.received) - 0.01), all.filter((x) => !(Array.isArray(x.paymentHistory))).length);

    // ---- Excel gets the dates (new last column; existing columns untouched)
    const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));
    const ex = await call('POST', '/api/invoices/register/export.xlsx', T, { ids: [inv.id, inv2.id], period: 'all', filters: 'test' });
    const wb = XLSX.read(ex.buf, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets.Invoices, { header: 1 });
    const head = aoa[4]; const line = aoa.find((x) => x[0] === inv.invoiceNumber);
    check('E1 Excel: "All payment dates" is the new LAST column; "Payment date" and the others keep their place', head[head.length - 1] === 'All payment dates' && head[35] === 'Payment date' && head[0] === 'Invoice no' && head[16] === 'Received', head.slice(33));
    check('E2 Excel: every receipt date and amount of the 50,000 invoice, joined', line && ['2026-10-05', '2026-10-08', '2026-10-12', '2026-10-13', '2026-10-14'].every((d) => String(line[line.length - 1]).includes(d)), line && line[line.length - 1]);

    // ---- role access unchanged
    const rr = await call('GET', '/api/invoices/register?period=all', await Z.mint(rec));
    check('A1 a login without Accounts access still gets nothing from the register', rr.status === 401 || rr.status === 403, rr.status);
    const mm = await call('GET', `/api/invoices/${inv.id}`, await Z.mint(mgr));
    const mp = await call('POST', `/api/invoices/${inv2.id}/payments`, await Z.mint(mgr), { amount: 100, date: '2026-10-10' });
    check('A2 Manager (view only) still cannot record a payment; the detail read is exactly as before (200 with history, or 403 when out of its scope)', mp.status === 403 && (mm.status === 403 || (mm.status === 200 && Array.isArray(mm.body.paymentHistory))), [mm.status, mp.status]);

    // ---- the fixer script: dry run on the sandbox proposes a correction from the bank line; apply works on a COPY only
    const wrong = await prisma.invoicePayment.findFirst({ where: { invoiceId: inv2.id, bankTxnId: txn2.id } });
    await prisma.invoicePayment.update({ where: { id: wrong.id }, data: { date: '2026-10-11', dateSource: 'entered' } });
    const dbFile = path.join(Z.BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db');
    const dry = spawnSync(process.execPath, [path.join(__dirname, 'fix-payment-dates.js'), '--db', dbFile, '--json'], { encoding: 'utf8' });
    const dj = JSON.parse(dry.stdout);
    const mine = dj.fixes.filter((f) => f.invoiceNumber === inv2.invoiceNumber);
    check('S1 dry run (default) proposes 2026-10-11 -> 2026-10-09 for the wrong-dated receipt, and writes nothing', mine.length === 1 && mine[0].from === '2026-10-11' && mine[0].to === '2026-10-09' && dj.mode === 'DRY RUN'
      && (await prisma.invoicePayment.findUnique({ where: { id: wrong.id } })).date === '2026-10-11', dry.stdout.slice(0, 400));
    const refuse = spawnSync(process.execPath, [path.join(__dirname, 'fix-payment-dates.js'), '--db', path.join(path.dirname(dbFile), 'dev.db'), '--apply'], { encoding: 'utf8', env: { ...process.env, TL_ALLOW_REAL_APPLY: '' } });
    check('S2 --apply on the live dev.db is refused without --really-real and TL_ALLOW_REAL_APPLY=1', refuse.status === 3 && /REFUSED/.test(refuse.stderr), refuse.stderr);
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzpd-'));
    const copy = path.join(copyDir, 'copy.db');
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync(dbFile, { readOnly: true });
    src.exec(`VACUUM INTO '${copy.split(path.sep).join('/')}'`); src.close();
    const ap = spawnSync(process.execPath, [path.join(__dirname, 'fix-payment-dates.js'), '--db', copy, '--apply'], { encoding: 'utf8' });
    const cdb = new DatabaseSync(copy, { readOnly: true });
    const after = cdb.prepare('select date, dateSource from InvoicePayment where id = ?').get(wrong.id);
    cdb.close();
    const undoFile = fs.readdirSync(copyDir).find((f) => /paydates-undo/.test(f));
    check('S3 --apply (on a copy) corrects the date from the bank line, writes a backup and an undo manifest', after.date === '2026-10-09' && after.dateSource === 'backfill' && !!undoFile && fs.readdirSync(copyDir).some((f) => /\.bak$/.test(f)), [ap.stdout.slice(-300), ap.stderr]);
    const un2 = spawnSync(process.execPath, [path.join(__dirname, 'fix-payment-dates.js'), '--db', copy, '--undo', path.join(copyDir, undoFile)], { encoding: 'utf8' });
    const cdb2 = new DatabaseSync(copy, { readOnly: true });
    const back = cdb2.prepare('select date from InvoicePayment where id = ?').get(wrong.id);
    cdb2.close();
    check('S4 --undo puts the old value back', back.date === '2026-10-11' && /put back/.test(un2.stdout), un2.stdout);
  } catch (e) {
    Z.fail += 1;
    console.log('FAIL  test crashed', e && e.stack);
  } finally {
    try {
      const txns = made.txns;
      await prisma.invoicePayment.deleteMany({ where: { OR: [{ bankTxnId: { in: txns } }, { invoice: { client: { name: { contains: 'ZZTEST PD' } } } }] } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: txns } } });
      await prisma.bankTransaction.deleteMany({ where: { id: { in: txns } } });
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      const inv = await prisma.invoice.findMany({ where: { client: { name: { contains: 'ZZTEST PD' } } }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: inv.map((x) => x.id) } } });
    } catch (e) { console.log('cleanup (bank) failed:', String(e.message).slice(-200)); }
    const left = await Z.cleanup();
    const leftBank = await prisma.bankTransaction.count({ where: { description: { contains: 'ZZTEST PD' } } });
    console.log('cleanup left:', JSON.stringify({ ...left, bank: leftBank }));
    if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true });
    await Z.finish();
  }
})();
