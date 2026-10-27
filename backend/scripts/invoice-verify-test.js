#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VERIFIED BY THE BANK, OR ONLY RECORDED? (Accounts prompt 2026-10-27). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/invoice-verify-test.js
// Proves (utils/invoiceVerify.js on the list and the details):
//   - 50,000 paid in four bank credits 10k / 15k / 10k / 15k: four separate rows, cumulative 10k/25k/35k/50k, Partially paid
//     (verified) after three, Verified paid after the fourth; each row its own bank line (same day + same amount told apart by id)
//   - a typed receipt with no bank line: "Manual payment - verification required", never "Verified paid"
//   - received on the invoice with no receipt rows (an old import / Paid mark): "Payment evidence missing", nothing invented
//   - an unpaid invoice: "Unpaid"; the bank-line view answers only for the line asked, and only on its own invoice
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('IVF');

(async () => {
  const { prisma } = Z;
  const made = { txns: [], accounts: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const T = await Z.mint(admin);
    const client = await prisma.client.create({ data: { name: `ZZTEST IVF client ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(client.id);
    const mkInv = (no, amount, extra = {}) => prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: no, amount, gst: 0, tds: 0, invoiceDate: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', ...extra } });
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST IVF Bank ${Z.RUN}`, name: `ZZTEST IVF ${Z.RUN}`, accNo: '000099990077', openBal: 0, openDate: '2020-01-01' } });
    made.accounts.push(acc.id);
    const credit = async (amount, date, ref) => {
      const t = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Credit', amount, description: `NEFT CR ZZTEST IVF ${Z.RUN} ${ref}`, date, reference: ref, importBatch: null } });
      made.txns.push(t.id);
      return t;
    };
    const detail = async (id) => (await Z.call('GET', `/api/invoices/${id}`, T)).body;

    // ---- four instalments, each from its own bank credit (two share a day and an amount)
    const inv = await mkInv(`ZZIVF-${Z.RUN}-A`, 50000);
    const plan = [[10000, '2026-10-05', `ZZIVF-U1-${Z.RUN}`], [15000, '2026-10-12', `ZZIVF-U2-${Z.RUN}`], [10000, '2026-10-12', `ZZIVF-U3-${Z.RUN}`]];
    const lines = [];
    for (const [amt, d, ref] of plan) {
      const t = await credit(amt, d, ref);
      lines.push(t);
      const al = await Z.call('POST', `/api/bank/${t.id}/allocate`, T, { parts: [{ invoiceId: inv.id, amount: amt }] });
      if (al.status !== 200) throw new Error(`allocate ${al.status} ${JSON.stringify(al.body).slice(0, 200)}`);
    }
    let d = await detail(inv.id);
    Z.check('V1 three bank credits: three separate payments, Partially paid (verified), 35,000 verified, 15,000 outstanding', d.verify && d.verify.state === 'partial' && d.verify.verifiedAmount === 35000 && d.verify.outstanding === 15000 && d.verify.installments === 3 && d.verify.verifiedInstallments === 3, d.verify);
    Z.check('V2 every row says where it came from and that it is verified', d.paymentHistory.length === 3 && d.paymentHistory.every((h) => h.source === 'Bank statement' && h.verified === true), d.paymentHistory.map((h) => [h.source, h.verified]));
    const sameDay = d.paymentHistory.filter((h) => h.date === '2026-10-12');
    Z.check('V3 two payments on the same day stay two rows, each with its own bank line', sameDay.length === 2 && new Set(sameDay.map((h) => h.bankTxnId)).size === 2, sameDay.map((h) => [h.amount, h.bankTxnId]));
    const t4 = await credit(15000, '2026-10-25', `ZZIVF-U4-${Z.RUN}`);
    await Z.call('POST', `/api/bank/${t4.id}/allocate`, T, { parts: [{ invoiceId: inv.id, amount: 15000 }] });
    d = await detail(inv.id);
    const cum = []; d.paymentHistory.reduce((s, h) => { cum.push(s + h.amount); return s + h.amount; }, 0);
    Z.check('V4 the fourth credit: Verified paid, 50,000 verified, 0 outstanding, all four rows kept (10k/25k/35k/50k)', d.verify.state === 'verified' && d.verify.verifiedAmount === 50000 && d.verify.outstanding === 0 && JSON.stringify(cum) === JSON.stringify([10000, 25000, 35000, 50000]) && d.verify.lastPaymentDate === '2026-10-25', [d.verify.state, cum, d.verify.lastPaymentDate]);
    // the proof of payment 2 is payment 2's line - not 1 or 3
    const p2 = d.paymentHistory.find((h) => h.amount === 15000 && h.date === '2026-10-12');
    const bl = await Z.call('GET', `/api/invoices/${inv.id}/bank-line/${p2.bankTxnId}`, T);
    Z.check('V5 View proof of payment 2 opens payment 2\'s own bank line (15,000, its own UTR)', bl.status === 200 && Number(bl.body.credit) === 15000 && bl.body.reference === `ZZIVF-U2-${Z.RUN}`, [bl.status, bl.body && bl.body.credit, bl.body && bl.body.reference]);

    // ---- a typed receipt: manual, never verified
    const invM = await mkInv(`ZZIVF-${Z.RUN}-M`, 20000);
    const rp = await Z.call('POST', `/api/invoices/${invM.id}/payments`, T, { amount: 20000, date: '2026-10-10', method: 'UPI', reference: 'ZZIVF-TYPED-1' });
    const dm = await detail(invM.id);
    Z.check('V6 a receipt typed by hand: "Manual payment - verification required", not verified', rp.status === 201 && dm.verify.state === 'manual' && dm.verify.pendingVerification === 20000 && dm.verify.verifiedAmount === 0 && dm.paymentHistory[0].verified === false && dm.paymentHistory[0].source === 'Recorded by hand', [rp.status, dm.verify && dm.verify.state, dm.paymentHistory[0]]);
    const other = await Z.call('GET', `/api/invoices/${invM.id}/bank-line/${p2.bankTxnId}`, T);
    Z.check('V7 another invoice cannot open that bank line as its proof', other.status !== 200 || !other.body || Number(other.body.appliedHere || 0) === 0, [other.status, other.body && other.body.appliedHere]);

    // ---- received with no receipt row at all (old import / Paid flag)
    const invX = await mkInv(`ZZIVF-${Z.RUN}-X`, 30000, { receivedAmount: 30000, status: 'Paid', paidDate: '2026-08-15' });
    const dx = await detail(invX.id);
    Z.check('V8 Paid with no payment record: "Payment evidence missing", 30,000 without evidence, no invented rows', dx.verify.state === 'missing' && dx.verify.missingEvidence === 30000 && dx.paymentHistory.length === 0 && dx.verify.installments === 0, dx.verify);

    // ---- unpaid, and the list carries the same answer
    const invU = await mkInv(`ZZIVF-${Z.RUN}-U`, 12000);
    const reg = await Z.call('GET', '/api/invoices/register?period=all', T);
    const rowOf = (id) => (reg.body.rows || []).find((x) => x.id === id);
    Z.check('V9 the invoice list shows the same verification for each', reg.status === 200 && rowOf(invU.id).verify.state === 'unpaid' && rowOf(invX.id).verify.state === 'missing' && rowOf(invM.id).verify.state === 'manual' && rowOf(inv.id).verify.state === 'verified', ['U', 'X', 'M', 'A'].map((k, i) => [k, (rowOf([invU, invX, invM, inv][i].id) || {}).verify]));
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      await prisma.invoicePayment.deleteMany({ where: { OR: [{ bankTxnId: { in: made.txns } }, { invoice: { client: { name: { contains: 'ZZTEST IVF' } } } }] } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: made.txns } } });
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } });
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      const inv = await prisma.invoice.findMany({ where: { client: { name: { contains: 'ZZTEST IVF' } } }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: inv.map((x) => x.id) } } });
    } catch (e) { console.log('cleanup (bank) failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
