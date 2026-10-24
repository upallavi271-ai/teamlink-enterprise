// ---------------------------------------------------------------------------
// bank-recon-test.js - Auto-Reconcile acceptance tests (SANDBOX ONLY).
//
//   cd backend && node scripts/bank-recon-test.js            (API http://localhost:4011, sandbox.db)
//   LARGE=20000 node scripts/bank-recon-test.js              (size of the synthetic timing set)
//
// Covers the 20 acceptance cases of the "Complete Automatic Bank Statement Matching
// & Reconciliation" spec + role access + idempotency/concurrency + resume + audit.
// Every row it creates is tagged "ZZTEST BR" and removed at the end. It refuses to run
// against the real dev.db / port 4010.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
process.env.DATABASE_URL = `file:${BACK.split(path.sep).join('/')}/prisma/sandbox.db`;
const API = 'http://localhost:4011/api';
if (/dev\.db/.test(process.env.DATABASE_URL) || /4010/.test(API)) throw new Error('refusing to run against the real database');
require('dotenv').config({ path: path.join(BACK, '.env') });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));

const p = new PrismaClient();
const tok = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '2h' });
const TAG = 'ZZTEST BR';
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

async function call(uid, method, url, body) {
  for (let i = 0; i < 8; i += 1) {
    try {
      const headers = { Authorization: `Bearer ${tok(uid)}` };
      let payload;
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const r = await fetch(API + url, { method, headers, body: payload });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t; }
      return { status: r.status, body: j };
    } catch (e) {
      if (i === 7) throw e;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = async (sql, ...a) => JSON.parse(JSON.stringify(await p.$queryRawUnsafe(sql, ...a), (k, v) => (typeof v === 'bigint' ? Number(v) : v)));

const S = { users: [], clients: [], invoices: [], accounts: [], bills: [], txns: [] };
let seq = 0;

async function mkUser(label, accountsRole) {
  const u = await p.user.create({
    data: {
      name: `${TAG} ${label}`, email: `zztest.br-${label.toLowerCase().replace(/\W+/g, '')}@example.test`, passwordHash: '!zztest-no-login!', role: accountsRole, hrmsRole: null, atsRole: null, accountsRole,
      hrmsAccess: false, atsAccess: false, accountsAccess: true, status: 'Active',
    },
  });
  S.users.push(u.id);
  return u.id;
}
async function mkClient(name) {
  const c = await p.client.create({ data: { name: `${TAG} ${name} Pvt Ltd`, gst: '36AABCZ1234Z1Z5', ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
  S.clients.push(c.id);
  return c;
}
async function mkInvoice(client, no, amount, date = '2020-03-01') {
  const i = await p.invoice.create({ data: { clientId: client.id, invoiceNumber: no, amount, gst: 0, tds: 0, invoiceDate: date, dueDate: date, status: 'Pending' } });
  S.invoices.push(i.id);
  return i;
}
async function mkBill(data) {
  const b = await p.officeExpense.create({
    data: {
      category: `${TAG} Rent`, expenseDate: '2020-03-05', monthlyAmount: 1000, approvalStatus: 'APPROVED', paidStatus: 'Unpaid', entryKind: 'expense', recurring: false, ...data,
    },
  });
  S.bills.push(b.id);
  return b;
}
async function mkTxn(acc, type, amount, description, date = '2020-03-06', extra = {}) {
  seq += 1;
  const t = await p.bankTransaction.create({ data: { bankAccountId: acc, type, amount, description, date, importBatch: null, ...extra } });
  S.txns.push(t.id);
  return t;
}
const inv = (id) => p.invoice.findUnique({ where: { id } });
const txn = (id) => p.bankTransaction.findUnique({ where: { id } });
const proposalsOf = (id) => q('SELECT * FROM "ReconProposal" WHERE "txnId" = ? ORDER BY "createdAt"', id);
async function waitRun(uid, id, ms = 600000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(uid, 'GET', `/bank/auto/runs/${id}`);
    const run = r.body.run;
    if (['Done', 'Failed', 'Cancelled', 'Paused'].includes(run.status)) return run;
    if (Date.now() - t0 > ms) throw new Error('run timed out');
    await sleep(400);
  }
}
async function setSwitch(sa, on, extra = {}) {
  const r = await call(sa, 'PUT', '/bank/auto/settings', { autoReconcile: on, ...extra });
  if (r.status !== 200) throw new Error(`settings: ${r.status} ${JSON.stringify(r.body)}`);
}

async function main() {
  // ---------------------------------------------------------------- setup
  const sa = await mkUser('SA', 'SUPER_ADMIN');
  const acct = await mkUser('Accountant', 'ACCOUNTANT');
  const mgr = await mkUser('Manager', 'MANAGER');
  const acc1 = (await p.bankAccount.create({ data: { bank: `${TAG} Bank One`, name: `${TAG} current 1`, accNo: '000011110001', openBal: 0, openDate: '2020-01-01' } })).id;
  const acc2 = (await p.bankAccount.create({ data: { bank: `${TAG} Bank Two`, name: `${TAG} current 2`, accNo: '000022220002', openBal: 0, openDate: '2020-01-01' } })).id;
  S.accounts.push(acc1, acc2);
  const quasar = await mkClient('Quasar Robotics');
  const nimbus = await mkClient('Nimbus Cloudworks');
  const prevSettings = await p.appSetting.findUnique({ where: { key: 'bank.autoRecon' } });
  const prevClosed = await p.appSetting.findUnique({ where: { key: 'accounts.booksClosedUpTo' } });

  const roleOk = await call(sa, 'GET', '/bank/auto/settings');
  check('Settings readable; with no saved setting Auto-reconcile is ON by default (sure matches are applied; Admin can switch it OFF)', roleOk.status === 200 && roleOk.body.settings.autoReconcile === true, JSON.stringify(roleOk.body.settings));
  await setSwitch(sa, false); // the next block proves the OFF (suggest-only) mode

  // ------------------------------------------- default OFF: nothing is applied
  const i0 = await mkInvoice(quasar, 'ZZBR-0001', 4321);
  const csv = `Date,Description,Debit,Credit,Balance\n2020-03-02,NEFT CR ZZBR-0001 ${TAG} QUASAR ROBOTICS,,4321,4321\n`;
  const imp = await call(sa, 'POST', '/bank/import', { csv, bankAccountId: acc1, file: 'zzbr-1.csv' });
  const l0 = await p.bankTransaction.findFirst({ where: { bankAccountId: acc1, description: { contains: 'ZZBR-0001' } } });
  if (l0) S.txns.push(l0.id);
  check('Import with the switch OFF applies nothing (invoice untouched) but makes a suggestion',
    imp.status === 201 && (await inv(i0.id)).status === 'Pending' && (await inv(i0.id)).receivedAmount === 0 && l0 && (await proposalsOf(l0.id)).some((x) => x.band === 'high' && x.status === 'Pending'), `import ${imp.status}, suggested=${imp.body && imp.body.autoMatch ? '' : ''}${imp.body && imp.body.autoReconcileOn}`);
  const dash0 = await call(sa, 'GET', `/bank/auto/dashboard?bankAccountId=${acc1}`);
  check('Dashboard counts the waiting suggestion', dash0.status === 200 && dash0.body.counts.suggested === 1, JSON.stringify(dash0.body.counts));

  // T1 / T2 ----------------------------------------------------------------------------------
  const rent = await mkBill({ vendor: `${TAG} Landlord Realty`, monthlyAmount: 85000, expenseDate: '2020-03-05' });
  const t1 = await mkTxn(acc1, 'Debit', 85000, `NEFT DR ${TAG} LANDLORD REALTY RENT MAR`, '2020-03-06');
  const bill2 = await mkBill({ vendor: `${TAG} Vendor Beta`, monthlyAmount: 6500, billNumber: 'ZZBR-VB-77', remarks: 'Paid UTR HDFCN52020041100099', expenseDate: '2020-04-10' });
  const t2 = await mkTxn(acc1, 'Debit', 6500, 'NEFT DR HDFCN52020041100099 SOMEONE', '2020-04-11');
  // dry run first: writes only proposals
  const before = { pay: await p.invoicePayment.count(), bill: await p.officeExpense.findUnique({ where: { id: rent.id } }), txn: await txn(t1.id) };
  let r = await call(sa, 'POST', '/bank/auto/runs', { dryRun: true, bankAccountId: acc1 });
  check('Dry run is accepted (202) and returns a run id', r.status === 202 && r.body.run && r.body.run.id, r.status);
  let run = await waitRun(sa, r.body.run.id);
  const after = { pay: await p.invoicePayment.count(), bill: await p.officeExpense.findUnique({ where: { id: rent.id } }), txn: await txn(t1.id) };
  check('DRY RUN writes only proposals (no payment, bill or line changed)', run.status === 'Done' && before.pay === after.pay && before.bill.approvalStatus === after.bill.approvalStatus && after.txn.category === null && after.txn.reconStatus === 'Unmatched', JSON.stringify(run.counts));
  const pr1 = (await proposalsOf(t1.id)).find((x) => x.status === 'Pending');
  const pr2 = (await proposalsOf(t2.id)).find((x) => x.status === 'Pending');
  check('T1 existing line proposes the existing APPROVED office expense (HIGH, vendor+exact amount+date)', pr1 && pr1.band === 'high' && pr1.kind === 'expense' && pr1.targetLabel, pr1 && `${pr1.band}/${pr1.kind}/${pr1.targetLabel}`);
  check('T2 existing line proposes the existing vendor bill by its UTR (HIGH) - no re-import', pr2 && pr2.band === 'high' && pr2.rule === 1, pr2 && `${pr2.band} rule ${pr2.rule}`);
  // switch ON + real run applies HIGH ones
  await setSwitch(sa, true);
  r = await call(sa, 'POST', '/bank/auto/runs', { dryRun: false, bankAccountId: acc1 });
  run = await waitRun(sa, r.body.run.id);
  const billNow = await p.officeExpense.findUnique({ where: { id: rent.id } });
  const t1n = await txn(t1.id);
  check('T1 applied automatically once the Admin switch is ON: bill PAID, line filed, nothing duplicated', billNow.approvalStatus === 'PAID' && billNow.bankTxnId === t1.id && t1n.categoryKind === 'expense' && (await p.officeExpense.count({ where: { vendor: `${TAG} Landlord Realty` } })) === 1, JSON.stringify({ s: billNow.approvalStatus, c: run.counts.autoMatched }));
  check('T2 applied automatically (vendor bill linked to the existing line)', (await p.officeExpense.findUnique({ where: { id: bill2.id } })).bankTxnId === t2.id, '');
  const l0n = await inv(i0.id);
  check('T3 incoming credit matched the customer invoice (ZZBR-0001 Paid, receipt = bank date)', l0n.status === 'Paid' && l0n.receivedAmount === 4321, JSON.stringify({ s: l0n.status, r: l0n.receivedAmount }));
  const pay0 = await p.invoicePayment.findMany({ where: { invoiceId: i0.id } });
  check('T3b one receipt row, dated by the bank line, linked to it', pay0.length === 1 && pay0[0].bankTxnId === l0.id && pay0[0].date === '2020-03-02', JSON.stringify(pay0.map((x) => [x.date, x.amount])));

  // T4 new import auto-matches (switch ON) ---------------------------------------------------------------
  const i4 = await mkInvoice(quasar, 'ZZBR-0004', 12345);
  const csv4 = `Date,Description,Debit,Credit,Balance\n2020-03-09,NEFT CR ZZBR-0004 ${TAG} QUASAR ROBOTICS,,12345,16666\n`;
  const imp4 = await call(sa, 'POST', '/bank/import', { csv: csv4, bankAccountId: acc1, file: 'zzbr-4.csv' });
  const l4 = await p.bankTransaction.findFirst({ where: { bankAccountId: acc1, description: { contains: 'ZZBR-0004' } } });
  if (l4) S.txns.push(l4.id);
  check('T4 a NEW import auto-matches the same way (switch ON)', imp4.status === 201 && (await inv(i4.id)).status === 'Paid' && imp4.body.autoReconcileOn === true, `autoPosted=${imp4.body.autoPosted}`);

  // T10 repeated import -------------------------------------------------------------------------------------
  const payCount = await p.invoicePayment.count({ where: { invoiceId: { in: [i0.id, i4.id] } } });
  const txnCount = await p.bankTransaction.count({ where: { bankAccountId: acc1 } });
  const propCount = (await q('SELECT COUNT(*) AS n FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" = ?)', acc1))[0].n;
  const rep = await call(sa, 'POST', '/bank/import', { csv: csv4, bankAccountId: acc1, file: 'zzbr-4.csv' });
  const payCount2 = await p.invoicePayment.count({ where: { invoiceId: { in: [i0.id, i4.id] } } });
  const propCount2 = (await q('SELECT COUNT(*) AS n FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" = ?)', acc1))[0].n;
  check('T10 repeated import: no duplicate lines, receipts or proposals', payCount === payCount2 && txnCount === (await p.bankTransaction.count({ where: { bankAccountId: acc1 } })) && propCount === propCount2, `lines ${txnCount}, receipts ${payCount}->${payCount2}, proposals ${propCount}->${propCount2}`);

  // T5 one payment across multiple invoices ------------------------------------------------------------------
  await setSwitch(sa, false);
  const a3 = await mkInvoice(nimbus, 'ZZBR-0053', 5000, '2020-03-01');
  const a4 = await mkInvoice(nimbus, 'ZZBR-0054', 3000, '2020-03-02');
  const t5 = await mkTxn(acc1, 'Credit', 8000, `NEFT CR ${TAG} NIMBUS CLOUDWORKS PVT LTD`, '2020-03-12');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr5 = (await proposalsOf(t5.id)).find((x) => x.status === 'Pending');
  check('T5 one payment for two invoices: MEDIUM suggestion with the oldest-due split, nothing applied yet', pr5 && pr5.band === 'medium' && JSON.parse(pr5.action).parts.length === 2 && (await inv(a3.id)).status === 'Pending', pr5 && `${pr5.band} ${pr5.action}`);
  const ap5 = await call(acct, 'POST', `/bank/auto/proposals/${pr5.id}/approve`, {});
  const pays5 = await p.invoicePayment.findMany({ where: { bankTxnId: t5.id } });
  check('T5 approved: both invoices Paid, one line, two receipts that add up to the bank amount', ap5.status === 200 && (await inv(a3.id)).status === 'Paid' && (await inv(a4.id)).status === 'Paid' && pays5.length === 2 && pays5.reduce((s, x) => s + x.amount, 0) === 8000, `${ap5.status} ${JSON.stringify(ap5.body)}`);

  // T6/T7 many payments settle one invoice + partial ----------------------------------------------------------
  await setSwitch(sa, true);
  const b1 = await mkInvoice(nimbus, 'ZZBR-0061', 7777, '2020-03-03');
  const t6a = await mkTxn(acc1, 'Credit', 4000, `NEFT CR ZZBR-0061 ${TAG} NIMBUS`, '2020-03-15');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const afterA = await inv(b1.id);
  check('T7 part payment: invoice Partially Paid and outstanding falls to 3777', afterA.status === 'Partially Paid' && afterA.receivedAmount === 4000, JSON.stringify([afterA.status, afterA.receivedAmount]));
  const t6b = await mkTxn(acc1, 'Credit', 3777, `NEFT CR ZZBR-0061 ${TAG} NIMBUS second`, '2020-03-20');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const afterB = await inv(b1.id);
  check('T6 many payments settle one invoice: second payment closes it', afterB.status === 'Paid' && afterB.receivedAmount === 7777 && (await p.invoicePayment.count({ where: { invoiceId: b1.id } })) === 2, JSON.stringify([afterB.status, afterB.receivedAmount]));

  // T8 bank fee per config ---------------------------------------------------------------------------------------
  await setSwitch(sa, false);
  const quasar2 = await mkClient('Fee Test Customer');
  const f1 = await mkInvoice(quasar2, 'ZZBR-0081', 5000, '2020-03-04');
  const t8 = await mkTxn(acc1, 'Credit', 4950, `NEFT CR ${TAG} FEE TEST CUSTOMER PVT LTD`, '2020-03-22');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr8 = (await proposalsOf(t8.id)).find((x) => x.status === 'Pending');
  check('T8 payment short by a bank fee (within the configured limit): MEDIUM, difference -50 shown, flagged', pr8 && pr8.band === 'medium' && pr8.difference === -50 && JSON.parse(pr8.flags).includes('bank-fee'), pr8 && `${pr8.band} diff ${pr8.difference}`);
  await setSwitch(sa, false, { bankFeeMaxRupees: 30 });
  const t8b = await mkTxn(acc1, 'Credit', 4950, `NEFT CR ${TAG} FEE TEST CUSTOMER PVT LTD again`, '2020-03-23');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr8b = (await proposalsOf(t8b.id)).find((x) => x.status === 'Pending');
  check('T8b with the fee limit lowered to 30 the same shortfall is NOT suggested as a fee (config, not hard-coded)', !pr8b || !JSON.parse(pr8b.flags).includes('bank-fee'), pr8b && `${pr8b.band} ${pr8b.flags}`);
  await setSwitch(sa, false, { bankFeeMaxRupees: 100 });

  // T9 unexplained difference --------------------------------------------------------------------------------------
  const q9 = await mkInvoice(quasar, 'ZZBR-0091', 10000, '2020-03-05');
  const t9 = await mkTxn(acc1, 'Credit', 12000, `NEFT CR ZZBR-0091 ${TAG} QUASAR ROBOTICS`, '2020-03-25');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr9 = (await proposalsOf(t9.id)).find((x) => x.status === 'Pending');
  check('T9 unexplained excess: MEDIUM + amount-mismatch, difference 2000 shown, invoice untouched', pr9 && pr9.band === 'medium' && pr9.difference === 2000 && JSON.parse(pr9.flags).includes('amount-mismatch') && (await inv(q9.id)).receivedAmount === 0, pr9 && `${pr9.band} diff ${pr9.difference}`);
  await setSwitch(sa, true);
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  check('T9b even with the switch ON a flagged difference is never applied automatically', (await inv(q9.id)).receivedAmount === 0 && (await proposalsOf(t9.id)).every((x) => x.status !== 'Applied'), '');
  // over-allocation blocked
  const over = await call(acct, 'POST', `/bank/auto/proposals/${pr9.id}/approve`, { parts: [{ invoiceId: q9.id, amount: 12000 }] });
  check('Over-allocation beyond the invoice outstanding is refused (409/400) and nothing changes', [400, 409].includes(over.status) && (await inv(q9.id)).receivedAmount === 0, `${over.status} ${over.body && over.body.error}`);

  // T13 ambiguous ----------------------------------------------------------------------------------------------------
  const amb = await mkClient('Ambiguous Traders');
  await mkInvoice(amb, 'ZZBR-0131', 2500, '2020-03-01');
  await mkInvoice(amb, 'ZZBR-0132', 2500, '2020-03-02');
  const t13 = await mkTxn(acc1, 'Credit', 2500, `NEFT CR ${TAG} AMBIGUOUS TRADERS PVT LTD`, '2020-03-26');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr13 = (await proposalsOf(t13.id)).find((x) => x.status === 'Pending');
  check('T13 ambiguous (two invoices of 2500): stays pending, LOW, candidates listed, nothing applied even with the switch ON', pr13 && pr13.band === 'low' && JSON.parse(pr13.candidates).invoiceIds.length === 2 && (await p.invoicePayment.count({ where: { bankTxnId: t13.id } })) === 0, pr13 && pr13.band);

  // T11 internal transfer ------------------------------------------------------------------------------------------------
  await setSwitch(sa, false);
  const payBefore = await p.invoicePayment.count(); const billsBefore = await p.officeExpense.count();
  const t11a = await mkTxn(acc1, 'Debit', 50000, `FUND TRANSFER TO ${TAG} OWN ACC`, '2020-04-01');
  const t11b = await mkTxn(acc2, 'Credit', 50000, `FUND TRANSFER FROM ${TAG}`, '2020-04-02');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pr11 = (await proposalsOf(t11a.id)).find((x) => x.status === 'Pending');
  const ap11 = pr11 ? await call(acct, 'POST', `/bank/auto/proposals/${pr11.id}/approve`, {}) : null;
  const a11 = await txn(t11a.id); const b11 = await txn(t11b.id);
  check('T11 internal transfer: both sides tagged transfer, no invoice receipt, no expense created', pr11 && pr11.kind === 'transfer' && ap11.status === 200 && a11.categoryKind === 'transfer' && b11.categoryKind === 'transfer' && payBefore === (await p.invoicePayment.count()) && billsBefore === (await p.officeExpense.count()), ap11 && `${ap11.status}`);
  const un11 = await call(acct, 'POST', `/bank/auto/txn/${t11a.id}/unreconcile`, { reason: 'ZZTEST transfer tagged wrongly' });
  check('Unreconcile an internal transfer frees both sides', un11.status === 200 && (await txn(t11a.id)).categoryKind === null && (await txn(t11b.id)).categoryKind === null, `${un11.status}`);

  // T12 refund / reversal ---------------------------------------------------------------------------------------------------
  const r12 = await mkInvoice(quasar, 'ZZBR-0121', 9000, '2020-04-05');
  const t12 = await mkTxn(acc1, 'Credit', 9000, `NEFT CR ZZBR-0121 ${TAG} QUASAR ROBOTICS`, '2020-04-06');
  await setSwitch(sa, true);
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const rv = await call(acct, 'POST', `/bank/${t12.id}/reverse`, { reason: 'ZZTEST cheque bounced', date: '2020-04-09' });
  const ri = await inv(r12.id);
  const rpays = await p.invoicePayment.findMany({ where: { invoiceId: r12.id }, orderBy: { amount: 'desc' } });
  check('T12 bounced receipt: invoice back to owing, original receipt kept + a negative reversal entry (history not rewritten)', rv.status === 200 && ri.receivedAmount === 0 && rpays.length === 2 && rpays[0].amount === 9000 && rpays[1].amount === -9000, `${rv.status} ${JSON.stringify(rpays.map((x) => x.amount))}`);
  const un12 = await call(acct, 'POST', `/bank/auto/txn/${t12.id}/unreconcile`, { reason: 'ZZTEST should be refused' });
  check('A reversed line cannot be unreconciled over its history', un12.status === 400, `${un12.status}`);

  // T14 re-running historical does not duplicate / overwrite verified matches ---------------------------------------------------
  const verifiedPays = await p.invoicePayment.findMany({ where: { bankTxnId: { in: [l0.id, t5.id, t6a.id] } }, select: { id: true, amount: true } });
  const nProps1 = (await q('SELECT COUNT(*) AS n FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" IN (?,?))', acc1, acc2))[0].n;
  for (let k = 0; k < 2; k += 1) { const rr = await call(sa, 'POST', '/bank/auto/runs', { dryRun: false, bankAccountId: acc1 }); await waitRun(sa, rr.body.run.id); }
  const verifiedPays2 = await p.invoicePayment.findMany({ where: { bankTxnId: { in: [l0.id, t5.id, t6a.id] } }, select: { id: true, amount: true } });
  const nProps2 = (await q('SELECT COUNT(*) AS n FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" IN (?,?))', acc1, acc2))[0].n;
  check('T14 re-running the historical run twice: verified matches untouched, no duplicate receipts', JSON.stringify(verifiedPays) === JSON.stringify(verifiedPays2), `${verifiedPays.length} receipts same`);
  check('T14b ... and the proposals do not multiply (idempotency keys)', nProps1 === nProps2, `${nProps1} -> ${nProps2}`);

  // Concurrency: 5 simultaneous approvals of ONE suggestion -------------------------------------------------------------------------
  await setSwitch(sa, false);
  const c1 = await mkInvoice(quasar, 'ZZBR-0141', 3333, '2020-04-10');
  const tc = await mkTxn(acc1, 'Credit', 3333, `NEFT CR ZZBR-0141 ${TAG} QUASAR ROBOTICS`, '2020-04-11');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const prc = (await proposalsOf(tc.id)).find((x) => x.status === 'Pending');
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => call(acct, 'POST', `/bank/auto/proposals/${prc.id}/approve`, {})));
  const okN = many.filter((m) => m.status === 200).length;
  check('Concurrency: 5 simultaneous approvals -> exactly one wins, one receipt', okN === 1 && (await p.invoicePayment.count({ where: { bankTxnId: tc.id } })) === 1 && (await inv(c1.id)).receivedAmount === 3333, `wins=${okN} statuses=${many.map((m) => m.status).join(',')}`);

  // Role access ------------------------------------------------------------------------------------------------------------------------
  const d1 = await mkInvoice(quasar, 'ZZBR-0151', 1111, '2020-04-12');
  const td = await mkTxn(acc1, 'Credit', 1111, `NEFT CR ZZBR-0151 ${TAG} QUASAR ROBOTICS`, '2020-04-13');
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const prd = (await proposalsOf(td.id)).find((x) => x.status === 'Pending');
  const m1 = await call(mgr, 'POST', `/bank/auto/proposals/${prd.id}/approve`, {});
  const m2 = await call(mgr, 'POST', `/bank/auto/txn/${tc.id}/unreconcile`, { reason: 'ZZTEST nope' });
  const m3 = await call(mgr, 'POST', '/bank/auto/runs', { dryRun: true });
  const m4 = await call(acct, 'PUT', '/bank/auto/settings', { autoReconcile: true });
  const m5 = await call(mgr, 'GET', `/bank/auto/dashboard?bankAccountId=${acc1}`);
  const m6 = await call(mgr, 'POST', `/bank/auto/proposals/${prd.id}/reject`, { reason: 'x' });
  check('T15 read-only Manager cannot approve / reject / unreconcile / start a run (403)', [m1, m2, m3, m6].every((x) => x.status === 403), [m1, m2, m3, m6].map((x) => x.status).join(','));
  check('T15b an Accountant cannot change the Auto-reconcile rules (403, Admin only)', m4.status === 403, `${m4.status}`);
  check('T15c a role with no Bank access (Manager here) cannot even read the Auto-Reconcile dashboard (403, same guard as the Bank module)', m5.status === 403, `${m5.status}`);
  check('T15d ... and nothing changed for the suggestion they tried to approve', (await inv(d1.id)).receivedAmount === 0, '');

  // closed period -------------------------------------------------------------------------------------------------------------------------
  await p.appSetting.upsert({ where: { key: 'accounts.booksClosedUpTo' }, create: { key: 'accounts.booksClosedUpTo', value: JSON.stringify('2020-04') }, update: { value: JSON.stringify('2020-04') } });
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const prd2 = (await proposalsOf(td.id)).find((x) => x.status === 'Pending');
  const cp1 = await call(acct, 'POST', `/bank/auto/proposals/${prd2.id}/approve`, {});
  check('Closed period: the suggestion is flagged, never HIGH, and an Accountant may not approve it (403)', prd2 && JSON.parse(prd2.flags).includes('closed-period') && prd2.band === 'medium' && cp1.status === 403 && (await inv(d1.id)).receivedAmount === 0, `${cp1.status}`);
  const cp2 = await call(sa, 'POST', `/bank/auto/proposals/${prd2.id}/approve`, {});
  check('... while an Admin may (existing authorisation)', cp2.status === 200 && (await inv(d1.id)).status === 'Paid', `${cp2.status}`);
  if (prevClosed) await p.appSetting.update({ where: { key: 'accounts.booksClosedUpTo' }, data: { value: prevClosed.value } }); else await p.appSetting.delete({ where: { key: 'accounts.booksClosedUpTo' } });

  // unapproved bill is never matched automatically ------------------------------------------------------------------------------------------
  const pend = await mkBill({ vendor: `${TAG} Airtel Telecom`, monthlyAmount: 1180, approvalStatus: 'PENDING', expenseDate: '2020-05-02', category: `${TAG} Telecom` });
  const tp = await mkTxn(acc1, 'Debit', 1180, `NEFT DR ${TAG} AIRTEL TELECOM BILL`, '2020-05-03');
  await setSwitch(sa, true);
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const prp = (await proposalsOf(tp.id)).find((x) => x.status === 'Pending');
  check('A bank match NEVER approves a bill that has not finished its own approval (MEDIUM, flagged, still PENDING)', prp && prp.band === 'medium' && JSON.parse(prp.flags).includes('bill-not-approved') && (await p.officeExpense.findUnique({ where: { id: pend.id } })).approvalStatus === 'PENDING', prp && `${prp.band} ${prp.flags}`);
  const apx = await call(acct, 'POST', `/bank/auto/proposals/${prp.id}/approve`, {});
  // 2026-10-21 (founder: "proof attached but still Pending"): a PERSON accepting the match is allowed. The one helper (utils/expensePaymentState.js dataForMatch) decides:
  // an approver's match is the Mark-as-Paid press (bill Paid); anybody else's links the line and the bill stays Pending ("matched - mark Paid"). Only an AUTOMATIC run never pays.
  const pendAfter = await p.officeExpense.findUnique({ where: { id: pend.id } });
  check('... a person accepting that match is not blocked: a match by an approver marks the bill Paid, a match by anybody else links it and leaves it Pending (never a silent nothing)', apx.status === 200 && pendAfter.bankTxnId === tp.id && (pendAfter.approvalStatus === 'PAID' || pendAfter.approvalStatus === 'PENDING'), `${apx.status} ${apx.body && apx.body.error} ${pendAfter.approvalStatus}`);

  // T16 traceability ----------------------------------------------------------------------------------------------------------------------------
  const applied = await q('SELECT * FROM "ReconProposal" WHERE "status" = \'Applied\' AND "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" IN (?,?))', acc1, acc2);
  let traced = 0;
  for (const a of applied) {
    const evs = await q('SELECT * FROM "ReconEvent" WHERE "proposalId" = ? AND "action" IN (\'Matched automatically\',\'Suggestion approved\')', a.id);
    const aud = await p.auditLog.count({ where: { entity: 'BankTransaction', entityId: a.txnId } });
    if (evs.length === 1 && evs[0].reason && a.previous && aud > 0 && (a.decidedByName || a.appliedMode === 'auto')) traced += 1;
  }
  check('T16 every confirmed match is traceable: proposal + reason + before-snapshot + event + audit row', applied.length >= 6 && traced === applied.length, `${traced}/${applied.length}`);
  const autoApplied = applied.filter((a) => a.appliedMode === 'auto').length;
  check('T16b automatic matches are marked auto (and manual approvals are not)', autoApplied >= 3 && applied.some((a) => a.appliedMode === 'approved'), `auto ${autoApplied}`);

  // Unreconcile restores previous statuses ---------------------------------------------------------------------------------------------------
  const ur = await call(acct, 'POST', `/bank/auto/txn/${tc.id}/unreconcile`, { reason: 'ZZTEST wrong customer' });
  const invUr = await inv(c1.id);
  check('Unreconcile with a reason restores the invoice (Pending, 0 received) and the line (Unmatched)', ur.status === 200 && ['Pending', 'Overdue'].includes(invUr.status) && invUr.receivedAmount === 0 && (await txn(tc.id)).reconStatus === 'Unmatched', `${ur.status}`);
  const urNo = await call(acct, 'POST', `/bank/auto/txn/${tc.id}/unreconcile`, { reason: '' });
  check('Unreconcile without a reason is refused', urNo.status === 400, `${urNo.status}`);
  await setSwitch(sa, true);
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  check('A match a person reversed is NOT re-applied automatically by the next run', (await inv(c1.id)).receivedAmount === 0, '');
  const hand = await call(acct, 'POST', `/bank/auto/txn/${tc.id}/manual`, { parts: [{ invoiceId: c1.id, amount: 3333 }] });
  check('... but the person can match it again by hand (traceable)', hand.status === 200 && (await inv(c1.id)).status === 'Paid', `${hand.status}`);

  // T17 consistency -------------------------------------------------------------------------------------------------------------------------------
  const ids = S.invoices;
  let consistent = true; let detail = '';
  for (const id of ids) {
    const i = await inv(id); const pays = await p.invoicePayment.findMany({ where: { invoiceId: id } });
    const sum = Math.round(pays.reduce((s, x) => s + x.amount, 0) * 100) / 100;
    if (pays.length && Math.abs(sum - i.receivedAmount) > 0.004) { consistent = false; detail += ` ${i.invoiceNumber}:${sum}!=${i.receivedAmount}`; }
    const st = i.receivedAmount >= i.amount - 0.5 ? 'Paid' : (i.receivedAmount > 0 ? 'Partially Paid' : 'Pending');
    if (pays.length && st !== i.status && !(st === 'Pending' && i.status === 'Overdue')) { consistent = false; detail += ` ${i.invoiceNumber}:status ${i.status} vs ${st}`; }
  }
  const credits = await p.bankTransaction.findMany({ where: { bankAccountId: { in: [acc1, acc2] }, type: 'Credit', reconStatus: 'Reconciled' } });
  for (const c of credits) {
    const s = (await p.invoicePayment.aggregate({ where: { bankTxnId: c.id }, _sum: { amount: true } }))._sum.amount || 0;
    if (s > c.amount + 0.004) { consistent = false; detail += ` txn ${c.id} over-allocated`; }
  }
  check('T17 receipts = invoice received amounts, statuses derive from them, no line over-allocated', consistent, detail);
  const dash = await call(sa, 'GET', `/bank/auto/dashboard?bankAccountId=${acc1}`);
  const sumRec = credits.filter((c) => c.bankAccountId === acc1).reduce((s, c) => s + c.amount, 0);
  check('T17b dashboard "reconciled credit" total agrees with the statement lines', dash.status === 200 && dash.body.totals.reconciledCredit >= sumRec - 0.01, `${dash.body.totals.reconciledCredit} vs ${sumRec}`);
  check('Statement is not "fully reconciled" while unresolved lines remain', dash.body.statements.filter((s) => /zzbr/.test(s.file || '')).every((s) => s.complete === (s.openLines === 0 && s.flagged === 0)), '');

  // existing-match checks (flag only) ------------------------------------------------------------------------------------------------------------------
  const bad = await mkTxn(acc1, 'Credit', 100, `${TAG} reconciled but empty`, '2020-06-01', { reconStatus: 'Reconciled', matched: true });
  const rr = await call(sa, 'POST', '/bank/auto/runs', { dryRun: true, bankAccountId: acc1 });
  const rrun = await waitRun(sa, rr.body.run.id);
  const flagged = (await proposalsOf(bad.id)).find((x) => x.kind === 'flag');
  check('A line marked Reconciled with nothing behind it is FLAGGED for review (and left untouched)', flagged && JSON.parse(flagged.flags).includes('reconciled-without-record') && (await txn(bad.id)).reconStatus === 'Reconciled', rrun.counts && `flaggedExisting=${rrun.counts.flaggedExisting}`);

  // T18 interrupted processing resumes -------------------------------------------------------------------------------------------------------------------------
  await setSwitch(sa, false, { batchSize: 20 });
  const bulk = [];
  for (let k = 0; k < 90; k += 1) bulk.push({ bankAccountId: acc2, type: k % 2 ? 'Credit' : 'Debit', amount: 100 + k, description: `${TAG} bulk line ${k}`, date: `2020-07-${String(1 + (k % 28)).padStart(2, '0')}` });
  await p.bankTransaction.createMany({ data: bulk });
  const rs = await call(sa, 'POST', '/bank/auto/runs', { dryRun: true, bankAccountId: acc2 });
  const runId = rs.body.run.id;
  for (let k = 0; k < 200; k += 1) { const x = await call(sa, 'GET', `/bank/auto/runs/${runId}`); if (x.body.run.processed > 0 || x.body.run.status === 'Done') break; await sleep(25); }
  await call(sa, 'POST', `/bank/auto/runs/${runId}/cancel`);
  let mid = await waitRun(sa, runId);
  const interruptedAt = mid.processed;
  // simulate a crash too: mark Running with no live worker
  await p.$executeRawUnsafe('UPDATE "ReconRun" SET "status"=\'Running\' WHERE "id"=?', runId);
  const lst = await call(sa, 'GET', '/bank/auto/runs');
  const shown = lst.body.runs.find((x) => x.id === runId);
  check('T18 a run killed mid-way shows as Paused / interrupted (not silently Running)', shown && (shown.status === 'Paused' || shown.interrupted), shown && shown.status);
  const rsm = await call(sa, 'POST', `/bank/auto/runs/${runId}/resume`);
  const fin = await waitRun(sa, runId);
  const propsBulk = (await q('SELECT COUNT(*) AS n FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "bankAccountId" = ? AND "description" LIKE ?)', acc2, `%${TAG} bulk%`))[0].n;
  check('T18 resume continues from the saved cursor: run completes, one proposal per line (no duplicates)', rsm.status === 200 && fin.status === 'Done' && propsBulk === 90 && interruptedAt <= fin.processed, `interrupted at ${interruptedAt}, done ${fin.processed}/${fin.total}, proposals ${propsBulk}`);

  // T20 existing workflows ---------------------------------------------------------------------------------------------------------------------------------------
  await setSwitch(sa, false, { batchSize: 200 });
  const w1 = await mkInvoice(quasar, 'ZZBR-0201', 800, '2020-08-01');
  const tw = await mkTxn(acc1, 'Credit', 800, `${TAG} plain credit no reference`, '2020-08-02');
  const al = await call(acct, 'POST', `/bank/${tw.id}/allocate`, { parts: [{ invoiceId: w1.id, amount: 800 }] });
  const li = await call(sa, 'GET', '/bank?bankAccountId=' + acc1);
  const dl = await call(acct, 'POST', `/bank/${tw.id}/unmatch`, {});
  const invW = await inv(w1.id);
  check('T20 existing workflows still work: manual allocate, Bank list, unmatch', al.status === 200 && li.status === 200 && dl.status === 200 && ['Pending', 'Overdue'].includes(invW.status) && invW.receivedAmount === 0, `${al.status}/${li.status}/${dl.status}`);
  const old = await call(sa, 'GET', '/invoices'); const oldb = await call(sa, 'GET', '/bank/accounts');
  check('T20b invoices list and bank accounts still respond', old.status === 200 && oldb.status === 200, `${old.status}/${oldb.status}`);

  // Upload path: the original statement is kept for audit, downloadable, and a repeat upload makes no duplicates ----------------------------------------------
  await setSwitch(sa, false);
  const u1 = await mkInvoice(quasar, 'ZZBR-0301', 2468, '2020-09-01');
  const csvUp = ['Date,Narration,Withdrawal,Deposit,Balance', '2020-09-02,NEFT CR ZZBR-0301 ' + TAG + ' QUASAR ROBOTICS,,2468,2468', '2020-09-03,ZZTEST BR MYSTERY LINE,100,,2368', ''].join(String.fromCharCode(10));
  const postUpload = async () => {
    const fd = new FormData();
    fd.append('kind', 'bank'); fd.append('bankAccountId', acc1); fd.append('autoPost', 'true');
    fd.append('file', new Blob([csvUp], { type: 'text/csv' }), 'zzbr-upload.csv');
    const r = await fetch(API + '/accounts-import/commit', { method: 'POST', headers: { Authorization: 'Bearer ' + tok(sa) }, body: fd });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const up1 = await postUpload();
  const imp1 = up1.body && up1.body.batch ? (await q('SELECT "originalFile","originalName" FROM "BankImport" WHERE "id" = ?', up1.body.batch))[0] : null;
  check('Upload (xlsx/csv path): 2 lines imported, nothing applied while the switch is OFF, suggestion waiting', up1.status === 201 && up1.body.imported === 2 && (await inv(u1.id)).receivedAmount === 0 && up1.body.suggested >= 1, JSON.stringify([up1.status, up1.body && up1.body.imported, up1.body && up1.body.suggested]));
  check('The ORIGINAL uploaded statement is kept for audit (stored name + original filename recorded)', imp1 && /^[a-f0-9]{32}.csv$/.test(imp1.originalFile) && imp1.originalName === 'zzbr-upload.csv', JSON.stringify(imp1));
  const dlo = await fetch(API + '/bank/auto/imports/' + up1.body.batch + '/original', { headers: { Authorization: 'Bearer ' + tok(acct) } });
  const dlText = await dlo.text();
  check('... and can be downloaded back byte for byte by an Accounts user', dlo.status === 200 && dlText === csvUp, String(dlo.status));
  const up2 = await postUpload();
  check('The SAME file uploaded again: no new lines, no new receipts, told it is a repeat', up2.status === 201 && up2.body.imported === 0 && up2.body.fileAlreadyImported, JSON.stringify([up2.status, up2.body && up2.body.imported, !!(up2.body && up2.body.fileAlreadyImported)]));

  // ---- learnt rules / default ON / holds ------------------------------------------------------------------------------------------------
  await p.appSetting.deleteMany({ where: { key: 'bank.autoRecon' } }); // back to NO saved setting = default ON
  const defOn = await call(sa, 'GET', '/bank/auto/settings');
  check('Deleting the saved setting returns to the default: ON', defOn.body.settings.autoReconcile === true, '');
  await mkBill({ vendor: TAG + ' Cards Co', category: TAG + ' Cards', monthlyAmount: 111, expenseDate: '2020-01-05', approvalStatus: 'PAID', paidStatus: 'Paid' });
  await p.bankRule.create({ data: { match: TAG + ' ZEPHYR CARDS SETTLE', category: TAG + ' Cards', kind: 'expense', source: 'confirmed', createdByName: TAG } });
  const csvL = ['Date,Description,Debit,Credit,Balance', '2020-10-02,' + TAG + ' ZEPHYR CARDS SETTLE PAYMENT,7321,,1000'].join(String.fromCharCode(10));
  const impL = await call(sa, 'POST', '/bank/import', { csv: csvL, bankAccountId: acc1, file: 'zzbr-rule.csv' });
  const lrule = await p.bankTransaction.findFirst({ where: { bankAccountId: acc1, description: { contains: 'ZEPHYR CARDS' } } });
  if (lrule) S.txns.push(lrule.id);
  check('LEARNT RULE (a narration rule a person confirmed before): the next identical narration is filed automatically on import', impL.status === 201 && lrule && lrule.category === TAG + ' Cards' && lrule.createdBillId, JSON.stringify({ st: impL.status, cat: lrule && lrule.category, filed: impL.body && impL.body.billsFiled }));
  const qL = await call(sa, 'GET', '/bank/auto/queue?bankAccountId=' + acc1 + '&search=ZEPHYR');
  const rowL = qL.body.rows && qL.body.rows[0];
  check('... the table shows it as "Reconciled automatically" with the reason ("Matched automatically because: ...")', rowL && rowL.state === 'Reconciled automatically' && /rule|Cards|ZEPHYR/i.test(rowL.autoReason || ''), rowL && rowL.state + ' / ' + (rowL.autoReason || '').slice(0, 80));
  const unL = await call(acct, 'POST', '/bank/auto/txn/' + lrule.id + '/unreconcile', { reason: 'ZZTEST undo the automatic filing' });
  const afterL = await txn(lrule.id);
  check('... and Undo (with a reason) takes back exactly what it made: the filed bill is gone and the line is open again', unL.status === 200 && afterL.category === null && afterL.createdBillId === null && (await p.officeExpense.count({ where: { bankTxnId: lrule.id } })) === 0, String(unL.status) + ' ' + JSON.stringify(unL.body).slice(0, 100));
  // exact client + invoice number on import with the default ON, and a duplicate-suspect line is held
  const dv = await mkInvoice(quasar, 'ZZBR-0401', 6060, '2020-10-01');
  const tdup = await mkTxn(acc1, 'Credit', 6060, 'NEFT CR ZZBR-0401 ' + TAG + ' QUASAR ROBOTICS', '2020-10-05', { reviewReason: 'Possible duplicate of a line already on file' });
  await call(sa, 'POST', '/bank/reconsider', { bankAccountId: acc1 });
  const pdup = (await proposalsOf(tdup.id)).find((x) => x.status === 'Pending');
  check('A line flagged as a possible duplicate is NEVER matched automatically (suggestion only, flagged)', pdup && pdup.band === 'medium' && JSON.parse(pdup.flags).includes('potential-duplicate') && (await inv(dv.id)).receivedAmount === 0, pdup && pdup.band);
  const csvD = ['Date,Description,Debit,Credit,Balance', '2020-10-06,NEFT CR ' + TAG + ' QUASAR ROBOTICS ZZBR-0402,,3030,3030'].join(String.fromCharCode(10));
  const dv2 = await mkInvoice(quasar, 'ZZBR-0402', 3030, '2020-10-01');
  const impD = await call(sa, 'POST', '/bank/import', { csv: csvD, bankAccountId: acc1, file: 'zzbr-def.csv' });
  const ld = await p.bankTransaction.findFirst({ where: { bankAccountId: acc1, description: { contains: 'ZZBR-0402' } } });
  if (ld) S.txns.push(ld.id);
  check('Invoice number + named client + exact amount on a fresh import is matched automatically with NO setting saved (default ON)', (await inv(dv2.id)).status === 'Paid' && impD.body.autoReconcileOn === true && impD.body.summary.matched >= 1, JSON.stringify(impD.body.summary));
  const loan = await p.handLoan.create({ data: { name: TAG + ' PVINODKUMAR', lender: 'ZZTEST', amount: 10000, dateTaken: '2020-10-01' } });
  const csvH = ['Date,Description,Debit,Credit,Balance', '2020-10-07,UPI ' + TAG + ' PVINODKUMAR loan,,10000,10000'].join(String.fromCharCode(10));
  await call(sa, 'POST', '/bank/import', { csv: csvH, bankAccountId: acc1, file: 'zzbr-loan.csv' });
  const lh = await p.bankTransaction.findFirst({ where: { bankAccountId: acc1, description: { contains: 'PVINODKUMAR' } } });
  if (lh) S.txns.push(lh.id);
  check('HAND LOAN named in the narration with the amount fitting is linked automatically', lh && (await p.handLoanLink.count({ where: { bankTxnId: lh.id } })) === 1, loan.id);

  // T19 large data ------------------------------------------------------------------------------------------------------------------------------------------------------
  const LARGE = Number(process.env.LARGE || 20000);
  const accBig = (await p.bankAccount.create({ data: { bank: `${TAG} Big`, name: `${TAG} big`, accNo: '000033330003', openBal: 0 } })).id;
  S.accounts.push(accBig);
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Omega', 'Sigma', 'Kappa', 'Zeta'];
  for (let off = 0; off < LARGE; off += 2000) {
    const chunk = [];
    for (let k = off; k < Math.min(LARGE, off + 2000); k += 1) {
      chunk.push({
        bankAccountId: accBig, type: k % 3 ? 'Debit' : 'Credit', amount: 500 + (k % 997) * 13 + (k % 7) / 10, date: `2021-${String(1 + (k % 12)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`,
        description: `NEFT ${k % 3 ? 'DR' : 'CR'} ${names[k % 8]} ${TAG} traders ref ${100000 + k}`, reference: k % 5 ? null : `UTRZ${String(900000000 + k)}`,
      });
    }
    await p.bankTransaction.createMany({ data: chunk });
  }
  const t0 = Date.now();
  const pv = await call(sa, 'GET', `/bank/auto/preview?bankAccountId=${accBig}`);
  const tPrev = Date.now() - t0;
  const rb = await call(sa, 'POST', '/bank/auto/runs', { dryRun: true, bankAccountId: accBig });
  const t1b = Date.now();
  const runBig = await waitRun(sa, rb.body.run.id, 1800000);
  const secs = (Date.now() - t1b) / 1000;
  const q0 = Date.now();
  const qq = await call(sa, 'GET', `/bank/auto/queue?bankAccountId=${accBig}&per=50&page=3&sort=date`);
  const qMs = Date.now() - q0;
  const d0 = Date.now();
  const dd = await call(sa, 'GET', `/bank/auto/dashboard?bankAccountId=${accBig}`);
  const dMs = Date.now() - d0;
  check(`T19 large data: ${LARGE} synthetic lines dry-run to Done`, runBig.status === 'Done' && runBig.processed === runBig.total, `preview ${tPrev} ms; run ${secs.toFixed(1)} s (${Math.round(LARGE / secs)} lines/s); queue page ${qMs} ms; dashboard ${dMs} ms; counts ${JSON.stringify(runBig.counts)}`);
  check('T19b queue + dashboard stay responsive on the large set (< 3 s each)', qq.status === 200 && qq.body.total === LARGE && qMs < 3000 && dd.status === 200 && dMs < 3000, `queue ${qMs} ms (total ${qq.body.total}), dashboard ${dMs} ms`);
  // eslint-disable-next-line no-console
  console.log(`TIMINGS preview=${tPrev}ms run=${secs.toFixed(1)}s lines/s=${Math.round(LARGE / secs)} queue=${qMs}ms dashboard=${dMs}ms`);

  // ---------------------------------------------------------------- cleanup
  await setSwitch(sa, false);
  await cleanup(prevSettings);
}

async function cleanup(prevSettings) {
  const out = [];
  const del = async (label, fn) => { try { const r = await fn(); out.push(`${label}:${r && r.count != null ? r.count : 'ok'}`); } catch (e) { out.push(`${label}:ERR ${e.message}`); } };
  // sweep by tag as well, so a crashed or killed earlier run is cleaned too
  (await p.user.findMany({ where: { email: { startsWith: 'zztest.br-' } }, select: { id: true } })).forEach((u) => { if (!S.users.includes(u.id)) S.users.push(u.id); });
  (await p.client.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).forEach((c) => { if (!S.clients.includes(c.id)) S.clients.push(c.id); });
  (await p.invoice.findMany({ where: { invoiceNumber: { startsWith: 'ZZBR-' } }, select: { id: true } })).forEach((i) => { if (!S.invoices.includes(i.id)) S.invoices.push(i.id); });
  (await p.bankAccount.findMany({ where: { OR: [{ bank: { startsWith: TAG } }, { name: { startsWith: TAG } }] }, select: { id: true } })).forEach((b) => { if (!S.accounts.includes(b.id)) S.accounts.push(b.id); });
  const accs = [...S.accounts];
  const tx = await p.bankTransaction.findMany({ where: { OR: [{ bankAccountId: { in: accs } }, { id: { in: S.txns } }, { description: { contains: TAG } }] }, select: { id: true } });
  const txIds = tx.map((t) => t.id);
  await del('events', () => p.$executeRawUnsafe(`DELETE FROM "ReconEvent" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "description" LIKE '%${TAG}%') OR "runId" IN (SELECT "id" FROM "ReconRun" WHERE "startedByName" LIKE '${TAG}%') OR "actorName" LIKE '${TAG}%'`));
  await del('proposals', () => p.$executeRawUnsafe(`DELETE FROM "ReconProposal" WHERE "txnId" IN (SELECT "id" FROM "BankTransaction" WHERE "description" LIKE '%${TAG}%' OR "bankAccountId" IN (${accs.map((a) => `'${a}'`).join(',') || "''"}))`));
  await del('runs', () => p.$executeRawUnsafe(`DELETE FROM "ReconRun" WHERE "startedByName" LIKE '${TAG}%'`));
  const bills = await p.officeExpense.findMany({ where: { OR: [{ id: { in: S.bills } }, { vendor: { contains: TAG } }, { category: { contains: TAG } }] }, select: { id: true } });
  await del('bills', () => p.officeExpense.deleteMany({ where: { id: { in: bills.map((b) => b.id) } } }));
  const invs = await p.invoice.findMany({ where: { OR: [{ id: { in: S.invoices } }, { clientId: { in: S.clients } }] }, select: { id: true } });
  await del('payments', () => p.invoicePayment.deleteMany({ where: { invoiceId: { in: invs.map((i) => i.id) } } }));
  await del('adjustments', () => p.invoiceAdjustment.deleteMany({ where: { invoiceId: { in: invs.map((i) => i.id) } } }));
  await del('loanlinks', () => p.handLoanLink.deleteMany({ where: { bankTxnId: { in: txIds } } }));
  await del('loans', () => p.handLoan.deleteMany({ where: { name: { startsWith: TAG } } }));
  await del('txns', () => p.bankTransaction.deleteMany({ where: { id: { in: txIds } } }));
  await del('imports', () => p.bankImport.deleteMany({ where: { OR: [{ file: { startsWith: 'zzbr-' } }, { bankAccountId: { in: accs } }] } }));
  await del('invoices', () => p.invoice.deleteMany({ where: { id: { in: invs.map((i) => i.id) } } }));
  await del('clients', () => p.client.deleteMany({ where: { id: { in: S.clients } } }));
  await del('rules', () => p.bankRule.deleteMany({ where: { OR: [{ match: { contains: 'ZZTEST' } }, { category: { contains: 'ZZTEST' } }] } }));
  await del('accounts', () => p.bankAccount.deleteMany({ where: { id: { in: accs } } }));
  await del('audit', () => p.auditLog.deleteMany({ where: { OR: [{ userId: { in: S.users } }, { entityId: { in: [...txIds, ...invs.map((i) => i.id)] } }, { toValue: { contains: 'ZZTEST' } }, { fromValue: { contains: 'ZZTEST' } }] } }));
  await del('notifications', () => p.notification.deleteMany({ where: { userId: { in: S.users } } }).catch(() => ({ count: 0 })));
  await del('users', () => p.user.deleteMany({ where: { id: { in: S.users } } }));
  if (prevSettings) await p.appSetting.update({ where: { key: 'bank.autoRecon' }, data: { value: prevSettings.value } }); else await p.appSetting.deleteMany({ where: { key: 'bank.autoRecon' } });
  await p.appSetting.deleteMany({ where: { key: 'bank.dateToleranceDays', updatedByName: { startsWith: TAG } } });
  // eslint-disable-next-line no-console
  console.log(`CLEANUP ${out.join(' ')}`);
}

if (process.env.CLEAN_ONLY) {
  cleanup(null).then(async () => { await p.$disconnect(); process.exit(0); });
} else main().then(async () => {
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failures}/${results.length} checks passed, ${failures} failed`);
  await p.$disconnect();
  process.exit(failures ? 1 : 0);
}).catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('TEST CRASHED', e);
  try { await cleanup(null); } catch (x) { /* ignore */ }
  await p.$disconnect();
  process.exit(2);
});
