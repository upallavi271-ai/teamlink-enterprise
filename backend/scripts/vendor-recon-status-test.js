#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BANK RECONCILIATION -> THE VENDOR'S INVOICE STATUS (founder 28 Oct 2026: "Bank Reconciliation separate ga unchi, bank statement
// transactions ni existing vendor payments tho match cheyyi. Match ayithe related invoice payment status and outstanding balance
// automatically update avvali"). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/vendor-recon-status-test.js
// Proves, with the staff Bank & Reconciliation route (POST /api/bank/:id/match-bills) and the vendor's own Invoices & Payments list
// (utils/assetVendorPortal.js listInvoices, the same function the portal page calls):
//   R1 before: the vendor's bill is not paid, outstanding = its total
//   R2 the bank debit is matched to the bill in Bank & Reconciliation
//   R3 the vendor's invoice now reads Paid from the bank, paid amount = the line, outstanding 0, its Payments list has that line
//   R4 the totals on the page (paid to you / still to be paid) moved by exactly that amount
//   R5 undoing the match puts the invoice back to not paid with the full outstanding - nothing is left behind
//   R6 no extra bill, payment or bank line was created
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('VRS');

(async () => {
  const { prisma } = Z;
  const made = { vendors: [], bills: [], txns: [], accounts: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const T = await Z.mint(admin);
    const v = await prisma.officeVendor.create({ data: { name: `ZZTEST VRS Vendor ${Z.RUN}`, category: 'IT / Hardware / AMC / Service', source: 'Office' } });
    made.vendors.push(v.id);
    const bill = await prisma.officeExpense.create({
      data: {
        expenseCode: `ZZVRS-${Z.RUN}`, category: 'Repairs & Maintenance', vendor: v.name, vendorId: v.id, monthlyAmount: 11800, tdsAmount: 0, gstAmount: 1800,
        expenseDate: '2026-10-10', billNumber: `ZZVRS-INV-${Z.RUN}`, approvalStatus: 'APPROVED', paidStatus: 'Unpaid', frequency: 'One-time',
      },
    }).catch(async (e) => { throw new Error(`bill create: ${e.message.slice(-300)}`); });
    made.bills.push(bill.id);
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST VRS Bank ${Z.RUN}`, name: `ZZTEST VRS ${Z.RUN}`, accNo: '000022221111', openBal: 0, openDate: '2020-01-01', active: true } });
    made.accounts.push(acc.id);
    const line = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Debit', amount: 11800, date: '2026-10-12', description: `NEFT DR ZZTEST VRS ${Z.RUN} REPAIR`, reference: `ZZVRSUTR${Z.RUN}`, reconStatus: 'Unmatched' } });
    made.txns.push(line.id);

    const AVP = require('../src/utils/assetVendorPortal'); // eslint-disable-line global-require
    const ctx = { vendorId: v.id, vendorName: v.name, canEdit: true, showAmounts: true };
    const rowOf = (inv) => (inv.rows || []).find((r) => r.billCode === bill.expenseCode || r.invoiceNo === bill.billNumber);
    const counts = async () => ({ bills: await prisma.officeExpense.count(), pays: await prisma.invoicePayment.count(), lines: await prisma.bankTransaction.count() });
    const c0 = await counts();

    const before = await AVP.listInvoices(ctx, { page: 1 });
    const b = rowOf(before);
    Z.check('R1 before the match: the vendor sees the bill, not paid, outstanding 11,800', !!b && b.payment.status !== 'Paid' && Number(b.payment.balance) === 11800, b && b.payment);

    const m = await Z.call('POST', `/api/bank/${line.id}/match-bills`, T, { billIds: [bill.id] });
    Z.check('R2 Bank & Reconciliation matches the debit to the vendor bill', m.status === 200, [m.status, m.body && m.body.error]);

    const after = await AVP.listInvoices(ctx, { page: 1 });
    const a = rowOf(after);
    Z.check('R3 the vendor\'s invoice now reads Paid from the bank statement: paid 11,800, outstanding 0, the payment line listed', !!a && a.payment.status === 'Paid' && Number(a.payment.paidAmount) === 11800 && Number(a.payment.balance) === 0 && (a.payment.payments || []).some((p) => Number(p.amount) === 11800 && String(p.date).slice(0, 10) === '2026-10-12'), a && a.payment);
    Z.check('R4 the page totals moved by exactly 11,800 (paid to you up, still to be paid down)', Math.round((after.summary.paidTotal - before.summary.paidTotal) * 100) === 1180000 && Math.round((before.summary.outstanding - after.summary.outstanding) * 100) === 1180000, [before.summary, after.summary]);

    const u = await Z.call('POST', `/api/bank/${line.id}/uncategorise`, T, {});
    const undo = u.status === 200 ? u : await Z.call('POST', `/api/bank/${line.id}/unmatch`, T, {});
    const back = rowOf(await AVP.listInvoices(ctx, { page: 1 }));
    Z.check('R5 undoing the match puts the invoice back: not paid, outstanding 11,800', undo.status === 200 && !!back && back.payment.status !== 'Paid' && Number(back.payment.balance) === 11800, [u.status, undo.status, undo.body && undo.body.error, back && back.payment]);
    const c1 = await counts();
    Z.check('R6 no extra bill, payment record or bank line was created', c1.bills === c0.bills && c1.pays === c0.pays && c1.lines === c0.lines, [c0, c1]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...made.txns, ...made.bills, ...made.vendors] } } });
      for (const t of ['ReconProposal', 'ReconEvent']) if (made.txns.length) await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "txnId" IN (${made.txns.map(() => '?').join(',')})`, ...made.txns).catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } });
      await prisma.officeExpense.deleteMany({ where: { id: { in: made.bills } } });
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } });
    } catch (e) { console.log('cleanup failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
