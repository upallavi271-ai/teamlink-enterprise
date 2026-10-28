#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "OPEN IN BANK & RECONCILIATION" FROM AN INVOICE (Accounts, 2026-10-27). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/bank-line-deeplink-test.js
// The invoice's Proof of payment links to /bank?line=<txnId>&invoice=<invoiceId>; the Bank screen opens that line
// with GET /api/bank/:txnId/detail and moves to the line's own account. Proves:
//   L1 the invoice gives the line's id (the link is built from it)
//   L2 the detail says which bank account the line is on (bankAccountId) - the screen opens that account, not the first
//   L3 the statement it came from (file, import date, by, row), dates, narration, credit, UTR, balance, status
//   L4 one line that paid two invoices: both allocations with their amounts, allocated / unallocated right
//   L5 a line that is not on file: a plain 404, never another line
//   L6 a login without Bank & Reconciliation cannot open it
//   L7 opening it changes nothing (no write, no money moved)
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('BDL');

(async () => {
  const { prisma } = Z;
  const made = { txns: [], accounts: [], imports: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false, accountsRole: 'NONE' }, {});
    const T = await Z.mint(admin);
    const TR = await Z.mint(rec);
    const client = await prisma.client.create({ data: { name: `ZZTEST BDL client ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(client.id);
    const mkInv = (no, amount) => prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: no, amount, gst: 0, tds: 0, invoiceDate: '2026-09-01', dueDate: '2026-09-30', status: 'Pending' } });
    // two accounts: the line sits on the SECOND, so "open the first account" would be wrong
    const accFirst = await prisma.bankAccount.create({ data: { bank: `ZZTEST BDL Bank1 ${Z.RUN}`, name: `ZZTEST BDL1 ${Z.RUN}`, accNo: '000011112222', openBal: 0, openDate: '2020-01-01' } });
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST BDL Bank2 ${Z.RUN}`, name: `ZZTEST BDL2 ${Z.RUN}`, accNo: '000033334444', openBal: 0, openDate: '2020-01-01' } });
    made.accounts.push(accFirst.id, acc.id);
    const imp = await prisma.bankImport.create({ data: { bankAccountId: acc.id, date: '2026-10-20', file: `ZZTEST-BDL-${Z.RUN}.xlsx`, recordedBy: 'ZZTEST BDL importer', lines: 1, credits: 100000 } });
    made.imports.push(imp.id);
    const t = await prisma.bankTransaction.create({
      data: {
        bankAccountId: acc.id, type: 'Credit', amount: 100000, description: `NEFT CR ZZTEST BDL ${Z.RUN} THREE CANDIDATES`, date: '2026-10-18', valueDate: '2026-10-19',
        reference: `ZZBDL-UTR-${Z.RUN}`, balance: 512345.67, importBatch: imp.id, sourceLine: 7,
      },
    });
    made.txns.push(t.id);
    const invA = await mkInv(`ZZBDL-${Z.RUN}-A`, 41300);
    const invB = await mkInv(`ZZBDL-${Z.RUN}-B`, 41300);
    const al = await Z.call('POST', `/api/bank/${t.id}/allocate`, T, { parts: [{ invoiceId: invA.id, amount: 41300 }, { invoiceId: invB.id, amount: 41300 }] });
    if (al.status !== 200) throw new Error(`allocate ${al.status} ${JSON.stringify(al.body).slice(0, 200)}`);

    const inv = (await Z.call('GET', `/api/invoices/${invA.id}`, T)).body;
    const pl = (inv.proofLines || []).find((l) => l.txnId === t.id);
    Z.check('L1 the invoice gives the bank line id behind its payment (the link /bank?line=<id> is built from it)', !!pl && (inv.payments || []).some((p) => p.bankTxnId === t.id), inv.proofLines);

    const before = { pays: await prisma.invoicePayment.count({ where: { bankTxnId: t.id } }), txn: JSON.stringify(await prisma.bankTransaction.findUnique({ where: { id: t.id } })) };
    const r = await Z.call('GET', `/api/bank/${t.id}/detail`, T);
    const d = r.body || {};
    Z.check('L2 the detail names the line\'s own bank account (the second one, not the first)', r.status === 200 && d.id === t.id && d.bankAccountId === acc.id, [r.status, d.id, d.bankAccountId, acc.id]);
    Z.check(
      'L3 statement (file, import date, by, row), dates, narration, credit, UTR, balance and status are all there',
      d.import && d.import.file === `ZZTEST-BDL-${Z.RUN}.xlsx` && d.import.importedOn === '2026-10-20' && d.import.by === 'ZZTEST BDL importer' && d.sourceLine === 7
        && d.transactionDate === '2026-10-18' && d.valueDate === '2026-10-19' && d.narration.includes('THREE CANDIDATES') && Number(d.credit) === 100000 && d.debit == null
        && d.reference === `ZZBDL-UTR-${Z.RUN}` && Number(d.balance) === 512345.67 && !!d.state && /xxxx4444/.test(d.bank || ''),
      d,
    );
    const byInv = Object.fromEntries((d.allocations || []).map((a) => [a.invoiceId, a.amount]));
    Z.check('L4 one line, two invoices: both allocations with their amounts; 82,600 allocated, 17,400 unallocated', byInv[invA.id] === 41300 && byInv[invB.id] === 41300 && Number(d.allocated) === 82600 && Number(d.unallocated) === 17400, [byInv, d.allocated, d.unallocated]);

    const gone = await Z.call('GET', `/api/bank/zz-no-such-line-${Z.RUN}/detail`, T);
    Z.check('L5 a line that is not on file: 404 with a message, no line given', gone.status === 404 && !!(gone.body && gone.body.error) && !(gone.body && gone.body.id), [gone.status, gone.body]);

    const no = await Z.call('GET', `/api/bank/${t.id}/detail`, TR);
    Z.check('L6 a recruiter (no Bank & Reconciliation) cannot open the line', no.status === 403 || no.status === 401, [no.status, no.body && no.body.id]);

    const after = { pays: await prisma.invoicePayment.count({ where: { bankTxnId: t.id } }), txn: JSON.stringify(await prisma.bankTransaction.findUnique({ where: { id: t.id } })) };
    Z.check('L7 opening the line wrote nothing (same payments, same line)', before.pays === after.pays && before.txn === after.txn, [before.pays, after.pays]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.invoicePayment.deleteMany({ where: { OR: [{ bankTxnId: { in: made.txns } }, { invoice: { client: { name: { contains: 'ZZTEST BDL' } } } }] } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: made.txns } } });
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } });
      await prisma.bankImport.deleteMany({ where: { id: { in: made.imports } } });
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      const inv = await prisma.invoice.findMany({ where: { client: { name: { contains: 'ZZTEST BDL' } } }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: inv.map((x) => x.id) } } });
    } catch (e) { console.log('cleanup (bank) failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
