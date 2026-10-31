#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "CHANGE STATUS" WITH OPTIONAL PROOF - OFFICE EXPENSES + INVOICES (founder 2026-10-31). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/status-change-proof-test.js
// The two screens' windows (frontend ExpenseStatusModal / InvoiceStatusModal) call exactly these:
//   E1 an expense marked Paid WITHOUT proof: allowed, Paid, no attachment (proof missing is shown, not blocked)
//   E2 proof attached first, then Paid: Paid with the file on it
//   E3 Paid -> back to Pending with a reason: Pending / Unpaid, paid date cleared, audited with the reason
//   E4 back to Pending without a reason: refused (400), unchanged
//   E5 back to Pending while a bank statement line pays it: refused (409), unchanged
//   E6 a login that is not an Accounts approver cannot change the status (403)
//   I1 invoice: proof attached, then Paid (settle in full): Paid, proof on file
//   I2 invoice: part payment WITHOUT proof: Partially Paid, no proof file - allowed
//   I3 invoice: Cancelled refused once money is received; a fresh invoice can be cancelled
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('SCP');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const { prisma } = Z;
  const made = { exps: [], txns: [], accounts: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false, accountsRole: 'NONE' }, {});
    const T = await Z.mint(admin); const TR = await Z.mint(rec);
    const upload = async (url, fields = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([PNG], { type: 'image/png' }), 'zz-proof.png');
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      const r = await fetch(`${Z.API}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'X-Forwarded-For': `10.6.${Math.floor(Math.random() * 250)}.1` }, body: fd });
      let body = null; try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    };
    const mkExp = async (k) => {
      const e = await prisma.officeExpense.create({ data: { expenseCode: `ZZSCP-${k}-${Z.RUN}`, category: 'Stationery', vendor: `ZZTEST SCP vendor ${Z.RUN}`, monthlyAmount: 1180, gstAmount: 180, tdsAmount: 0, expenseDate: '2026-10-20', approvalStatus: 'PENDING', paidStatus: 'Unpaid', frequency: 'One-time', entryKind: 'expense' } });
      made.exps.push(e.id); return e;
    };
    const status = (id, body, tok = T) => Z.call('PATCH', `/api/office-expenses/${id}/status`, tok, body);
    const fresh = (id) => prisma.officeExpense.findUnique({ where: { id } });

    // ---- office expenses
    const e1 = await mkExp('A');
    const r1 = await status(e1.id, { action: 'mark_paid', paymentDate: '2026-10-25', paymentMode: 'UPI' });
    const f1 = await fresh(e1.id);
    Z.check('E1 marked Paid WITHOUT proof: allowed, Paid, payment date + mode saved, no attachment', r1.status === 200 && f1.approvalStatus === 'PAID' && f1.paidStatus === 'Paid' && f1.paymentDate === '2026-10-25' && f1.paymentMode === 'UPI' && !f1.proofFile && !r1.body.attachment, [r1.status, r1.body && r1.body.error, f1.approvalStatus]);
    const e2 = await mkExp('B');
    const p2 = await upload(`/api/office-expenses/${e2.id}/proof`);
    const r2 = await status(e2.id, { action: 'mark_paid', paymentDate: '2026-10-26', paymentMode: 'Bank Transfer' });
    Z.check('E2 proof attached first, then Paid: Paid with the file on it', [200, 201].includes(p2.status) && r2.status === 200 && r2.body.status === 'PAID' && r2.body.attachment && r2.body.attachment.onServer === true, [p2.status, p2.body && p2.body.error, r2.status, r2.body && r2.body.attachment]);
    const r3 = await status(e1.id, { action: 'mark_pending', reason: 'marked paid by mistake' });
    const f3 = await fresh(e1.id);
    const audit3 = await prisma.auditLog.findFirst({ where: { entityId: e1.id, action: { contains: 'back from Paid' } } });
    Z.check('E3 Paid -> back to Pending with a reason: Pending / Unpaid, paid date cleared, audited with the reason', r3.status === 200 && f3.approvalStatus === 'PENDING' && f3.paidStatus === 'Unpaid' && !f3.paymentDate && !f3.paidAt && !!audit3 && audit3.reason === 'marked paid by mistake', [r3.status, r3.body && r3.body.error, f3.approvalStatus, !!audit3]);
    const r4 = await status(e2.id, { action: 'mark_pending', reason: '' });
    Z.check('E4 back to Pending without a reason: refused (400), still Paid', r4.status === 400 && (await fresh(e2.id)).approvalStatus === 'PAID', [r4.status]);
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST SCP Bank ${Z.RUN}`, name: `ZZTEST SCP ${Z.RUN}`, accNo: '000099998888', openBal: 0, openDate: '2020-01-01', active: true } });
    made.accounts.push(acc.id);
    const line = await prisma.bankTransaction.create({ data: { bankAccountId: acc.id, type: 'Debit', amount: 1180, date: '2026-10-26', description: `ZZTEST SCP ${Z.RUN}`, reconStatus: 'Reconciled' } });
    made.txns.push(line.id);
    await prisma.officeExpense.update({ where: { id: e2.id }, data: { bankTxnId: line.id } });
    const r5 = await status(e2.id, { action: 'mark_pending', reason: 'test with a bank line' });
    Z.check('E5 back to Pending while a bank statement line pays it: refused (409, says to unmatch first), still Paid', r5.status === 409 && /Unmatch/i.test(r5.body.error) && (await fresh(e2.id)).approvalStatus === 'PAID', [r5.status, r5.body && r5.body.error]);
    const r6 = await status(e1.id, { action: 'mark_paid' }, TR);
    Z.check('E6 a login that is not an Accounts approver cannot change the status (403), unchanged', r6.status === 403 && (await fresh(e1.id)).approvalStatus === 'PENDING', [r6.status]);

    // ---- invoices
    const client = await prisma.client.create({ data: { name: `ZZTEST SCP client ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(client.id);
    const mkInv = (k, amount) => prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: `ZZSCP-${k}-${Z.RUN}`, amount, gst: 0, tds: 0, invoiceDate: '2026-10-01', dueDate: '2026-10-31', status: 'Pending' } });
    const i1 = await mkInv('I1', 20000);
    const pi1 = await upload(`/api/dashboard/accounts/control/proof/invoice/${i1.id}`, { reference: `ZZSCPUTR${Z.RUN}` });
    const ri1 = await Z.call('PATCH', `/api/invoices/${i1.id}/pay`, T, { date: '2026-10-28', method: 'UPI' });
    const di1 = (await Z.call('GET', `/api/invoices/${i1.id}`, T)).body;
    Z.check('I1 invoice: proof attached, then Paid (settle in full): Paid, proof + UTR on file, one receipt for the full amount', [200, 201].includes(pi1.status) && ri1.status === 200 && di1.status === 'Paid' && di1.proofHasFile === true && di1.proofRef === `ZZSCPUTR${Z.RUN}` && (di1.payments || []).length === 1 && di1.payments[0].amount === 20000, [pi1.status, pi1.body && pi1.body.error, ri1.status, di1.status, di1.proofHasFile]);
    const i2 = await mkInv('I2', 30000);
    const ri2 = await Z.call('POST', `/api/invoices/${i2.id}/payments`, T, { amount: 10000, date: '2026-10-28', method: 'Bank Transfer' });
    const di2 = (await Z.call('GET', `/api/invoices/${i2.id}`, T)).body;
    Z.check('I2 invoice: part payment WITHOUT proof: Partially Paid, no proof file - allowed', ri2.status === 201 && /partial/i.test(di2.status) && di2.proofHasFile === false, [ri2.status, di2.status, di2.proofHasFile]);
    const ci2 = await Z.call('PATCH', `/api/invoices/${i2.id}/cancel`, T, {});
    const i3 = await mkInv('I3', 5000);
    const ci3 = await Z.call('PATCH', `/api/invoices/${i3.id}/cancel`, T, {});
    Z.check('I3 Cancelled is refused once money is received (400); a fresh invoice is cancelled', ci2.status === 400 && ci3.status === 200 && (await prisma.invoice.findUnique({ where: { id: i3.id } })).status === 'Cancelled', [ci2.status, ci3.status]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const inv = await prisma.invoice.findMany({ where: { client: { name: { contains: 'ZZTEST SCP' } } }, select: { id: true, proofFile: true } });
      const att = require('../src/utils/attachments'); // eslint-disable-line global-require
      inv.forEach((i) => { if (i.proofFile) { try { att.remove(i.proofFile); } catch { /* gone */ } } });
      const exps = await prisma.officeExpense.findMany({ where: { id: { in: made.exps } }, select: { proofFile: true } });
      exps.forEach((e) => { if (e.proofFile) { try { att.remove(e.proofFile); } catch { /* gone */ } } });
      await prisma.invoicePayment.deleteMany({ where: { invoice: { client: { name: { contains: 'ZZTEST SCP' } } } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...made.exps, ...made.txns, ...inv.map((i) => i.id)] } } });
      await prisma.officeExpense.deleteMany({ where: { id: { in: made.exps } } });
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } });
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
    } catch (e) { console.log('cleanup failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
