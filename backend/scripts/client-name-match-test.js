#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "CLIENT NAME MATCH AYINA STATEMENT MATCH AVVALI" (founder 2026-10-28). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/client-name-match-test.js
// Statements imported for real (CSV through /api/accounts-import/commit). With the client named in the narration:
//   C1 the line is exactly the money already marked received on ONE invoice with no payment record -> that invoice gets a
//      receipt row from the line (evidence), its received amount / status do NOT change, the line is Reconciled
//   C2 ... on a COMBINATION of their invoices (one way only) -> one evidence row per invoice
//   C3 the line clears an exact combination of their OPEN invoices -> both settled (money received)
//   C4 two invoices fit the same way -> nothing written, waits for a person
//   C5 nothing fits -> waits, saying what is on file; nothing written
//   C6 the same statement imported again changes nothing
//   C7 Unmatch on an evidence line removes only that row - the money marked received stays
//   C8 the invoice now reads Verified paid / Matched
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CNM');

(async () => {
  const { prisma } = Z;
  const made = { accounts: [], clients: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const T = await Z.mint(admin);
    const R = Z.RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const mkClient = async (word) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST CNM ${word} College ${R}`, ownerDepartment: 'Education', gstPercent: 0, tdsPercent: 0 } });
      Z.made.clients.push(c.id); made.clients.push(c.id);
      return c;
    };
    const mkInv = (c, k, amount, extra = {}) => prisma.invoice.create({ data: { clientId: c.id, invoiceNumber: `${k}${R}`, amount, gst: 0, tds: 0, invoiceDate: '2026-08-01', dueDate: '2026-08-31', status: 'Pending', ...extra } });
    const paidNoRow = (c, k, amount) => mkInv(c, k, amount, { receivedAmount: amount, status: 'Paid', paidDate: '2026-08-20' });
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST CNM Bank ${Z.RUN}`, name: `ZZTEST CNM ${Z.RUN}`, accNo: '000044443333', openBal: 0, openDate: '2020-01-01', active: true } });
    made.accounts.push(acc.id);

    const A = await mkClient('ALPHA'); const B = await mkClient('BRAVO'); const C = await mkClient('CHARLIE'); const D = await mkClient('DELTA'); const E = await mkClient('ECHO');
    const a1 = await paidNoRow(A, 'ZZCA', 20000);
    const b1 = await paidNoRow(B, 'ZZCB1-', 10000); const b2 = await paidNoRow(B, 'ZZCB2-', 15000); await paidNoRow(B, 'ZZCB3-', 40000);
    const c1 = await mkInv(C, 'ZZCC1-', 30000); const c2 = await mkInv(C, 'ZZCC2-', 12000); await mkInv(C, 'ZZCC3-', 50000);
    const d1 = await paidNoRow(D, 'ZZCD1-', 9000); const d2 = await paidNoRow(D, 'ZZCD2-', 9000);
    const e1 = await paidNoRow(E, 'ZZCE1-', 5000);

    const HEAD = 'Transaction Date,Value Date,Transaction Remarks,Cheque. No./Ref. No.,Withdrawal Amt (INR),Deposit Amt (INR),Balance (INR)';
    const row = (d, who, amt, bal) => [`${d}/Oct/2026`, `${d}/Oct/2026`, `NEFT CR-UTIB0000001-${who.name.toUpperCase()}-TEAMLINK CONSULTANTS`, '', '', `${amt}.00`, `${bal}.00`].join(',');
    const csv = `${HEAD}\n${[row('02', A, 20000, 120000), row('03', B, 25000, 145000), row('04', C, 42000, 187000), row('05', D, 9000, 196000), row('06', E, 7777, 203777)].join('\n')}\n`;
    const importCsv = async (name) => {
      const fd = new FormData();
      fd.append('kind', 'bank'); fd.append('bankAccountId', acc.id); fd.append('file', new Blob([Buffer.from(csv)], { type: 'text/csv' }), name);
      const r = await fetch(`${Z.API}/api/accounts-import/commit`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.1` }, body: fd });
      let body = null; try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    };
    const i1 = await importCsv(`ZZTEST-CNM-${Z.RUN}.csv`);
    if (i1.status !== 201) throw new Error(`import: ${i1.status} ${JSON.stringify(i1.body).slice(0, 300)}`);
    const lineOf = (c) => prisma.bankTransaction.findFirst({ where: { bankAccountId: acc.id, description: { contains: c.name.toUpperCase() } } });
    const rowsOf = (inv) => prisma.invoicePayment.findMany({ where: { invoiceId: inv.id } });
    const fresh = (inv) => prisma.invoice.findUnique({ where: { id: inv.id } });

    const lA = await lineOf(A); const rA = await rowsOf(a1); const fA = await fresh(a1);
    Z.check('C1 client named + exactly the money already marked received on one invoice: evidence row from the line, received / status unchanged, line Reconciled', rA.length === 1 && rA[0].bankTxnId === lA.id && rA[0].dateSource === 'bank-evidence' && rA[0].amount === 20000 && rA[0].date === lA.date && fA.receivedAmount === 20000 && fA.status === 'Paid' && lA.reconStatus === 'Reconciled', [rA, fA.receivedAmount, lA.reconStatus, lA.reviewReason]);

    const lB = await lineOf(B); const rB1 = await rowsOf(b1); const rB2 = await rowsOf(b2);
    Z.check('C2 a combination of their invoices (10,000 + 15,000 = 25,000, the only one): one evidence row on each, money unchanged', rB1.length === 1 && rB2.length === 1 && rB1[0].bankTxnId === lB.id && rB2[0].bankTxnId === lB.id && (await fresh(b1)).receivedAmount === 10000 && (await fresh(b2)).receivedAmount === 15000, [rB1, rB2, lB.reviewReason]);

    const lC = await lineOf(C); const fC1 = await fresh(c1); const fC2 = await fresh(c2);
    Z.check('C3 exact combination of their open invoices (30,000 + 12,000): both settled from the line', fC1.receivedAmount === 30000 && fC2.receivedAmount === 12000 && (await rowsOf(c1))[0].bankTxnId === lC.id && lC.reconStatus === 'Reconciled', [fC1.receivedAmount, fC2.receivedAmount, lC.reconStatus, lC.reviewReason]);

    const lD = await lineOf(D);
    Z.check('C4 two invoices of 9,000 fit the same way: nothing written, the line waits', (await rowsOf(d1)).length === 0 && (await rowsOf(d2)).length === 0 && lD.reconStatus !== 'Reconciled', [lD.reconStatus, lD.reviewReason]);

    const lE = await lineOf(E);
    Z.check('C5 nothing fits (7,777 vs 5,000 on file): nothing written, waits, and says what is on file', (await rowsOf(e1)).length === 0 && lE.reconStatus !== 'Reconciled', [lE.reconStatus, lE.reviewReason]);

    const before = await prisma.invoicePayment.count({ where: { invoice: { clientId: { in: made.clients } } } });
    const lines0 = await prisma.bankTransaction.count({ where: { bankAccountId: acc.id } });
    const i2 = await importCsv(`ZZTEST-CNM-${Z.RUN}-again.csv`);
    Z.check('C6 the same statement imported again: no new line, no new receipt row', [200, 201].includes(i2.status) && (await prisma.bankTransaction.count({ where: { bankAccountId: acc.id } })) === lines0 && (await prisma.invoicePayment.count({ where: { invoice: { clientId: { in: made.clients } } } })) === before, [i2.status]);

    const dA = (await Z.call('GET', `/api/invoices/${a1.id}`, T)).body;
    Z.check('C8 the invoice now reads Verified paid · Matched, its payment opens the statement', dA.verify && dA.verify.state === 'verified' && dA.reconSummary && dA.reconSummary.reconStatus === 'Matched' && dA.paymentRecon[0].statementTxnId === lA.id, [dA.verify && dA.verify.state, dA.reconSummary]);

    const um = await Z.call('POST', `/api/bank/${lA.id}/unmatch`, T, {});
    const afterA = await fresh(a1);
    Z.check('C7 Unmatch on the evidence line removes only that row; the 20,000 marked received stays', um.status === 200 && (await rowsOf(a1)).length === 0 && afterA.receivedAmount === 20000 && afterA.status === 'Paid', [um.status, um.body && um.body.error, afterA.receivedAmount]);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const tx = await prisma.bankTransaction.findMany({ where: { bankAccountId: { in: made.accounts } }, select: { id: true, importBatch: true } });
      const ids = tx.map((t) => t.id);
      const imps = [...new Set(tx.map((t) => t.importBatch).filter(Boolean))];
      await prisma.invoicePayment.deleteMany({ where: { OR: [{ bankTxnId: { in: ids } }, { invoice: { clientId: { in: made.clients } } }] } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...imps] } } });
      if (ids.length) {
        for (const t of ['ReconProposal', 'ReconEvent']) await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "txnId" IN (${ids.map(() => '?').join(',')})`, ...ids).catch(() => {});
      }
      if (imps.length) {
        const dir = process.env.UPLOAD_DIR ? require('path').join(process.env.UPLOAD_DIR, 'bank-statements') : null; // eslint-disable-line global-require
        const orig = await prisma.$queryRawUnsafe(`SELECT "originalFile" FROM "BankImport" WHERE "id" IN (${imps.map(() => '?').join(',')})`, ...imps).catch(() => []);
        orig.forEach((o) => { if (dir && o.originalFile && /^[a-f0-9]{32}\.\w+$/.test(o.originalFile)) { try { require('fs').unlinkSync(require('path').join(dir, o.originalFile)); } catch { /* not here */ } } }); // eslint-disable-line global-require
      }
      await prisma.bankTransaction.deleteMany({ where: { id: { in: ids } } });
      await prisma.bankImport.deleteMany({ where: { OR: [{ id: { in: imps } }, { bankAccountId: { in: made.accounts } }] } });
      for (const sql of ['DELETE FROM "BankStmtRow" WHERE "batchId" IN (SELECT "id" FROM "BankStmtBatch" WHERE "bankAccountId" IN', 'DELETE FROM "BankStmtBatch" WHERE ("bankAccountId" IN']) {
        await prisma.$executeRawUnsafe(`${sql} (${made.accounts.map(() => '?').join(',')}))`, ...made.accounts).catch(() => {});
      }
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      const inv = await prisma.invoice.findMany({ where: { clientId: { in: made.clients } }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: inv.map((x) => x.id) } } });
    } catch (e) { console.log('cleanup (bank) failed:', String(e.message).slice(-300)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
