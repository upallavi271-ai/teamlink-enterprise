#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYMENT <-> BANK STATEMENT, BOTH WAYS + VIEW STATEMENT (Accounts prompt 2026-10-27). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/payment-statement-link-test.js
//   (set UPLOAD_DIR to the sandbox API's UPLOAD_DIR so the kept statement files are cleaned up too)
// Statements are imported for real (CSV through /api/accounts-import/commit), so the matcher, the kept original file and
// the duplicate check all run. Proves:
//   S1 a payment recorded BEFORE the import is linked when the statement arrives - by its reference (rung 1) and by the
//      invoice number in the narration (rung 1b) - and no second receipt is written
//   S2 paid + matched: View Statement opens THAT statement - the original file with the line's row highlighted, and the
//      imported records with only that line highlighted and the other entries still there
//   S3 the same statement imported again adds nothing (no line, no receipt, links unchanged)
//   S4 two payments of one invoice in two statements: each opens its own statement and its own line
//   S5 a payment recorded AFTER the import is linked to the line carrying its reference
//   S6 two lines fit -> "Multiple Possible Matches - Verification Required", nothing linked, invoice Under Review
//   S7 the amount alone never links ("Possible Match - Verification Required")
//   S8 a line added by hand -> "Bank Statement Not Available"; an unknown line -> 404, never another statement
//   S9 a recruiter cannot open a statement; proof stays separate (no proof file, nothing about it in the statement)
//   S10 Paid with no payment row -> "Paid - Bank Statement Not Matched"
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Z = require('./lib/zzfix')('PSL');

const pad = (n, w) => String(n).padStart(w, '0');

(async () => {
  const { prisma } = Z;
  const made = { accounts: [], txns: [], imports: [] };
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false, accountsRole: 'NONE' }, {});
    const T = await Z.mint(admin);
    const TR = await Z.mint(rec);
    const client = await prisma.client.create({ data: { name: `ZZTEST PSL client ${Z.RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    Z.made.clients.push(client.id);
    const R = Z.RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const no = (k) => `ZZPSL${R}${k}`;
    const mkInv = (k, amount, extra = {}) => prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: no(k), amount, gst: 0, tds: 0, invoiceDate: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', ...extra } });
    const acc = await prisma.bankAccount.create({ data: { bank: `ZZTEST PSL Bank ${Z.RUN}`, name: `ZZTEST PSL ${Z.RUN}`, accNo: '000077776666', openBal: 0, openDate: '2020-01-01', active: true } });
    const acc2 = await prisma.bankAccount.create({ data: { bank: `ZZTEST PSL Bank2 ${Z.RUN}`, name: `ZZTEST PSL2 ${Z.RUN}`, accNo: '000077775555', openBal: 0, openDate: '2020-01-01', active: true } });
    made.accounts.push(acc.id, acc2.id);
    const seed = Number(String(Date.now()).slice(-7));
    const utr = (k) => `HDFCN5${pad(seed, 7)}${pad(k, 5)}`; // 16 characters, a NEFT UTR shape
    const detail = async (id) => (await Z.call('GET', `/api/invoices/${id}`, T)).body;
    const stmt = async (txnId, tok = T) => Z.call('GET', `/api/bank/statement-of/${encodeURIComponent(txnId)}`, tok);
    const pay = (id, body) => Z.call('POST', `/api/invoices/${id}/payments`, T, body);
    const HEAD = 'Transaction Date,Value Date,Transaction Remarks,Cheque. No./Ref. No.,Withdrawal Amt (INR),Deposit Amt (INR),Balance (INR)';
    const csv = (rows) => `${HEAD}\n${rows.map((r) => r.join(',')).join('\n')}\n`;
    const importCsv = async (name, text) => {
      const fd = new FormData();
      fd.append('kind', 'bank'); fd.append('bankAccountId', acc.id); fd.append('file', new Blob([Buffer.from(text)], { type: 'text/csv' }), name);
      const r = await fetch(`${Z.API}/api/accounts-import/commit`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.1` }, body: fd });
      let body = null; try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    };
    const lineOf = async (needle) => prisma.bankTransaction.findFirst({ where: { bankAccountId: acc.id, description: { contains: needle } } });

    // ---- receipts typed BEFORE the statement exists
    const invB = await mkInv('B', 30000);
    const invC = await mkInv('C', 25000);
    const invA = await mkInv('A', 41000);
    const invD = await mkInv('D', 50000);
    const pB = await pay(invB.id, { amount: 30000, date: '2026-10-05', method: 'Bank Transfer', reference: utr(1) });
    const pC = await pay(invC.id, { amount: 25000, date: '2026-10-06', method: 'Bank Transfer' });
    Z.check('S0 receipts typed before any statement: saved, nothing to link yet', pB.status === 201 && pC.status === 201 && pB.body.bankLink && pB.body.bankLink.linked === null, [pB.status, pC.status, pB.body && pB.body.bankLink]);

    // ---- statement 1 (row 1 = header, so these are rows 2..6 of the file)
    const csv1 = csv([
      ['05/Oct/2026', '05/Oct/2026', `NEFT-${utr(1)}-ZZTEST PSL PAYER ${R}`, utr(1), '', '30000.00', '130000.00'],
      ['06/Oct/2026', '06/Oct/2026', `NEFT-ZZTEST PSL PAYER ${R} INV ${no('C')}`, '', '', '25000.00', '155000.00'],
      ['07/Oct/2026', '07/Oct/2026', `ZZTEST PSL BANK CHARGES ${R}`, '', '1200.00', '', '153800.00'],
      ['08/Oct/2026', '08/Oct/2026', `NEFT-ZZTEST PSL PAYER ${R} INV ${no('A')}`, '', '', '41000.00', '194800.00'],
      ['09/Oct/2026', '09/Oct/2026', `NEFT-ZZTEST PSL PAYER ${R} PART ${no('D')}`, '', '', '20000.00', '214800.00'],
    ]);
    const i1 = await importCsv(`ZZTEST-PSL-${Z.RUN}-oct-a.csv`, csv1);
    if (i1.status !== 201) throw new Error(`import 1: ${i1.status} ${JSON.stringify(i1.body).slice(0, 300)}`);
    const L1 = await lineOf(`NEFT-${utr(1)}`);
    const L2 = await lineOf(`INV ${no('C')}`);
    const L4 = await lineOf(`INV ${no('A')}`);
    const L5 = await lineOf(`PART ${no('D')}`);
    [L1, L2, L4, L5].filter(Boolean).forEach((t) => made.txns.push(t.id));
    made.imports.push(L1 && L1.importBatch);
    const payB = await prisma.invoicePayment.findMany({ where: { invoiceId: invB.id } });
    const payC = await prisma.invoicePayment.findMany({ where: { invoiceId: invC.id } });
    Z.check('S1a receipt typed with its UTR is linked to the imported line carrying it (one receipt, no second one)', payB.length === 1 && L1 && payB[0].bankTxnId === L1.id, [payB.length, payB.map((p) => p.bankTxnId), L1 && L1.id, i1.body && i1.body.summary]);
    Z.check('S1b receipt typed without a reference is linked to the line naming its invoice number (rung 1b), no second receipt', payC.length === 1 && L2 && payC[0].bankTxnId === L2.id && (await prisma.invoice.findUnique({ where: { id: invC.id } })).receivedAmount === 25000, [payC.length, payC.map((p) => [p.amount, p.bankTxnId]), L2 && L2.id]);

    // ---- paid + matched: View Statement
    const dA = await detail(invA.id);
    const rA = (dA.paymentRecon || [])[0];
    Z.check('S2a invoice paid by the statement: Paid · Matched, its payment opens line L4', dA.reconSummary && dA.reconSummary.paymentStatus === 'Paid' && dA.reconSummary.reconStatus === 'Matched' && rA && rA.recon.state === 'matched' && rA.statementTxnId === L4.id, [dA.reconSummary, rA]);
    const sA = await stmt(L4.id);
    const hl = (sA.body && sA.body.imported ? sA.body.imported.rows : []).filter((r) => r.highlight);
    Z.check('S2b View Statement: that statement (its import), all 5 entries, ONLY this line highlighted, bank columns kept', sA.status === 200 && sA.body.available && sA.body.statement.importId === L4.importBatch && sA.body.imported.rows.length === 5 && hl.length === 1 && hl[0].txnId === L4.id && sA.body.imported.columns.includes('Transaction Remarks'), [sA.status, sA.body && sA.body.statement, hl.map((r) => r.txnId)]);
    const ov = sA.body && sA.body.original;
    Z.check('S2c the ORIGINAL uploaded file is shown (kept on the server), the line\'s own file row (row 5) highlighted, other rows there', ov && ov.onServer && ov.view && ov.view.highlightRow === 5 && ov.view.rows.length === 6 && ov.view.rows[4].cells.some((c) => c.includes(no('A'))), [ov && ov.onServer, ov && ov.view && ov.view.highlightRow, ov && ov.view && ov.view.rows.length]);
    if (ov && ov.download) {
      const dl = await fetch(`${Z.API}/api${ov.download}`, { headers: { Authorization: `Bearer ${T}` } });
      const text = await dl.text();
      Z.check('S2d Download original file gives the exact uploaded statement', dl.status === 200 && text === csv1, [dl.status, text.length, csv1.length]);
    } else Z.check('S2d Download original file gives the exact uploaded statement', false, ov);

    // ---- the same statement again
    const before = { lines: await prisma.bankTransaction.count({ where: { bankAccountId: acc.id } }), pays: await prisma.invoicePayment.count({ where: { invoice: { clientId: client.id } } }) };
    const i1b = await importCsv(`ZZTEST-PSL-${Z.RUN}-oct-a-again.csv`, csv1);
    const after = { lines: await prisma.bankTransaction.count({ where: { bankAccountId: acc.id } }), pays: await prisma.invoicePayment.count({ where: { invoice: { clientId: client.id } } }) };
    Z.check('S3 importing the same statement again adds no line and no receipt; links unchanged', [200, 201].includes(i1b.status) && before.lines === after.lines && before.pays === after.pays && (await prisma.invoicePayment.findFirst({ where: { invoiceId: invB.id } })).bankTxnId === L1.id, [i1b.status, before, after, i1b.body && i1b.body.error]);

    // ---- statement 2: the rest of D, and a credit with only a UTR (its receipt is typed later)
    const csv2 = csv([
      ['15/Oct/2026', '15/Oct/2026', `NEFT-ZZTEST PSL PAYER ${R} BAL ${no('D')}`, '', '', '30000.00', '244800.00'],
      ['16/Oct/2026', '16/Oct/2026', `NEFT-${utr(2)}-ZZTEST PSL OTHER ${R}`, utr(2), '', '15000.00', '259800.00'],
    ]);
    const i2 = await importCsv(`ZZTEST-PSL-${Z.RUN}-oct-b.csv`, csv2);
    if (i2.status !== 201) throw new Error(`import 2: ${i2.status} ${JSON.stringify(i2.body).slice(0, 300)}`);
    const M1 = await lineOf(`BAL ${no('D')}`);
    const M2 = await lineOf(`NEFT-${utr(2)}`);
    [M1, M2].filter(Boolean).forEach((t) => made.txns.push(t.id));
    made.imports.push(M1 && M1.importBatch);
    const dD = await detail(invD.id);
    const rD = dD.paymentRecon || [];
    const s1 = rD[0] ? await stmt(rD[0].statementTxnId) : null;
    const s2 = rD[1] ? await stmt(rD[1].statementTxnId) : null;
    const own = (s, id) => s && s.status === 200 && s.body.imported.rows.filter((r) => r.highlight).map((r) => r.txnId).join() === id;
    Z.check('S4 two payments in two statements: each opens its own statement and highlights its own line', rD.length === 2 && rD[0].statementTxnId === L5.id && rD[1].statementTxnId === M1.id && own(s1, L5.id) && own(s2, M1.id) && s1.body.statement.importId !== s2.body.statement.importId && dD.reconSummary.label === 'Paid · Matched', [rD.map((r) => r.statementTxnId), L5 && L5.id, M1 && M1.id, dD.reconSummary]);

    // ---- receipt typed AFTER its statement
    const invE = await mkInv('E', 15000);
    const pE = await pay(invE.id, { amount: 15000, date: '2026-10-16', method: 'Bank Transfer', reference: utr(2) });
    const tE = await prisma.bankTransaction.findUnique({ where: { id: M2.id } });
    Z.check('S5 a receipt typed after the import is linked at once to the line with its UTR (no money moved twice)', pE.status === 201 && pE.body.bankLink.linked === M2.id && tE.reconStatus === 'Reconciled' && (await prisma.invoicePayment.count({ where: { bankTxnId: M2.id } })) === 1, [pE.body && pE.body.bankLink, tE && tE.reconStatus]);

    // ---- two lines fit (made directly - no matcher has seen them)
    const invF = await mkInv('F', 18000);
    for (const d of ['2026-10-17', '2026-10-18']) {
      const t = await prisma.bankTransaction.create({ data: { bankAccountId: acc2.id, type: 'Credit', amount: 18000, date: d, description: `NEFT ZZTEST PSL ${R} FOR ${no('F')} ${d}`, reconStatus: 'Unmatched' } });
      made.txns.push(t.id);
    }
    const pF = await pay(invF.id, { amount: 18000, date: '2026-10-18', method: 'Bank Transfer' });
    const dF = await detail(invF.id);
    Z.check('S6 two lines name the invoice with the same amount: nothing linked, "Multiple Possible Matches - Verification Required", invoice Under Review', pF.status === 201 && pF.body.bankLink.linked === null && pF.body.bankLink.review === 'Multiple Possible Matches - Verification Required' && dF.paymentRecon[0].recon.label === 'Multiple Possible Matches - Verification Required' && dF.reconSummary.reconStatus === 'Under Review' && (dF.paymentRecon[0].recon.candidates || []).length === 2, [pF.body && pF.body.bankLink, dF.paymentRecon && dF.paymentRecon[0], dF.reconSummary]);

    // ---- the amount alone
    const invG = await mkInv('G', 17000);
    const tG = await prisma.bankTransaction.create({ data: { bankAccountId: acc2.id, type: 'Credit', amount: 17000, date: '2026-10-19', description: `NEFT ZZTEST PSL SOMEONE ${R}`, reconStatus: 'Unmatched' } });
    made.txns.push(tG.id);
    const pG = await pay(invG.id, { amount: 17000, date: '2026-10-19', method: 'Bank Transfer', reference: 'ZZNOTONLINE77' });
    const dG = await detail(invG.id);
    Z.check('S7 only the amount matches: never linked, "Possible Match - Verification Required"', pG.body.bankLink.linked === null && !(await prisma.invoicePayment.findFirst({ where: { invoiceId: invG.id } })).bankTxnId && dG.paymentRecon[0].recon.label === 'Possible Match - Verification Required', [pG.body && pG.body.bankLink, dG.paymentRecon && dG.paymentRecon[0]]);

    // ---- no statement
    const sH = await stmt(tG.id);
    const sX = await stmt(`zz-no-such-line-${Z.RUN}`);
    Z.check('S8 a line added by hand: "Bank Statement Not Available" (no other statement); an unknown line: 404', sH.status === 200 && sH.body.available === false && /Bank Statement Not Available/.test(sH.body.reason) && !sH.body.imported && sX.status === 404 && /Bank Statement Not Available/.test(sX.body.error), [sH.status, sH.body, sX.status, sX.body]);

    // ---- permissions + proof kept apart
    const sR = await stmt(L4.id, TR);
    Z.check('S9a a recruiter (no Bank & Reconciliation) cannot open a statement', sR.status === 403 || sR.status === 401, [sR.status]);
    Z.check('S9b proof stays separate: no proof file on the invoice, and the statement carries nothing about proof', dA.proofHasFile === false && !JSON.stringify(sA.body).toLowerCase().includes('proof'), [dA.proofHasFile]);

    // ---- Paid with no payment row
    const invH = await mkInv('H', 9000, { receivedAmount: 9000, status: 'Paid', paidDate: '2026-08-15' });
    const dH = await detail(invH.id);
    Z.check('S10 Paid with no payment row: "Paid - Bank Statement Not Matched"', dH.reconSummary && dH.reconSummary.paymentStatus === 'Paid' && dH.reconSummary.reconStatus === 'Unmatched' && dH.reconSummary.label === 'Paid - Bank Statement Not Matched', dH.reconSummary);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const allTx = await prisma.bankTransaction.findMany({ where: { bankAccountId: { in: made.accounts } }, select: { id: true, importBatch: true } });
      const txIds = [...new Set([...made.txns, ...allTx.map((t) => t.id)])];
      const impIds = [...new Set([...made.imports, ...allTx.map((t) => t.importBatch)].filter(Boolean))];
      await prisma.invoicePayment.deleteMany({ where: { OR: [{ bankTxnId: { in: txIds } }, { invoice: { client: { name: { contains: 'ZZTEST PSL' } } } }] } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...txIds, ...impIds] } } });
      for (const sql of ['DELETE FROM "ReconProposal" WHERE "txnId" IN', 'DELETE FROM "ReconEvent" WHERE "txnId" IN']) {
        if (txIds.length) await prisma.$executeRawUnsafe(`${sql} (${txIds.map(() => '?').join(',')})`, ...txIds).catch(() => {});
      }
      // the kept original files (only those of this test's imports)
      const dir = process.env.UPLOAD_DIR ? path.join(process.env.UPLOAD_DIR, 'bank-statements') : null;
      if (impIds.length) {
        const orig = await prisma.$queryRawUnsafe(`SELECT "originalFile" FROM "BankImport" WHERE "id" IN (${impIds.map(() => '?').join(',')})`, ...impIds).catch(() => []);
        orig.forEach((o) => { if (dir && o.originalFile && /^[a-f0-9]{32}\.\w+$/.test(o.originalFile)) { try { fs.unlinkSync(path.join(dir, o.originalFile)); } catch { /* not here */ } } });
      }
      await prisma.bankTransaction.deleteMany({ where: { id: { in: txIds } } });
      await prisma.bankImport.deleteMany({ where: { OR: [{ id: { in: impIds } }, { bankAccountId: { in: made.accounts } }] } });
      for (const sql of ['DELETE FROM "BankStmtRow" WHERE "batchId" IN (SELECT "id" FROM "BankStmtBatch" WHERE "bankAccountId" IN', 'DELETE FROM "BankStmtBatch" WHERE ("bankAccountId" IN']) {
        await prisma.$executeRawUnsafe(`${sql} (${made.accounts.map(() => '?').join(',')}))`, ...made.accounts).catch(() => {});
      }
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.accounts } } });
      const inv = await prisma.invoice.findMany({ where: { client: { name: { contains: 'ZZTEST PSL' } } }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: inv.map((x) => x.id) } } });
    } catch (e) { console.log('cleanup (bank) failed:', String(e.message).slice(-300)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
