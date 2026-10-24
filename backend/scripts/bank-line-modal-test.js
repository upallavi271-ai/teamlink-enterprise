#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BANK STATEMENT LINE WINDOW (Accounts, 2026-10-17) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/bank-line-modal-test.js                       makes its own VACUUM INTO copy of the real database
//                                                              (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/bankline-copy.db node scripts/bank-line-modal-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4099, TEST_MODE=1) on the copy, adds ZZTEST bank lines to the COPY
// (a debit, a credit, salary, a vendor payment, an expense, an invoice receipt - part allocated, a hand loan both ways,
// a refund, a transfer, a returned receipt, a set-aside line, an unfiled credit and an unfiled debit, a line with every
// optional value missing) and proves:
//   D  the detail endpoint GET /api/banks/:bankId/transactions/:txnId gives the right date / account (masked like the table) /
//      narration / money out or in / balance / filed-as / amount filed per line, and null where a value is missing
//   P  permission and scope: the list's roles only, a line is only reachable through its own bank, nothing is written
//   R  every real line of every bank: the detail agrees with the table row
//   M  the window's sentence by kind (frontend bank/bankLineMessage.js, bundled with esbuild): one per kind, tone, em dashes,
//      loading / failed, plain words
//   S  the table's source: whole row clickable, Enter / Space, own controls keep their action, the window traps focus
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');

let copy = process.env.COPY_DB;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `bankline-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4099);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const BF = require(path.join(BACK, 'src/utils/bankLineFiling'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);

function bundle(rel, name) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzbl-${RUN}-${name}.cjs`);
  esb.buildSync({ entryPoints: [path.join(FE, rel)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
}
async function http(method, p, token) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const made = { users: [], banks: [], txns: [], invoices: [], clients: [], loans: [], payments: [] };

(async () => {
  let server;
  try {
    const M = bundle('src/pages/bank/bankLineMessage.js', 'msg');

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST BLM ${tag} ${RUN}`, email: `zz-blm-${tag}-${RUN}@example.test`, username: `zz-blm-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const rec = await mkUser('rec', {});

    // ---------------------------------------------------------------- fixtures (in the COPY)
    const bankA = await prisma.bankAccount.create({ data: { bank: `ZZTEST Bank A ${RUN}`, name: 'ZZTEST A', accNo: '999988887777', active: true } });
    const bankB = await prisma.bankAccount.create({ data: { bank: `ZZTEST Bank B ${RUN}`, name: 'ZZTEST B', accNo: '', active: true } });
    made.banks.push(bankA.id, bankB.id);
    const client = await prisma.client.create({ data: { name: `ZZTEST BLM Client ${RUN}`, location: 'ZZ', ownerDepartment: 'Education', clientType: 'Client' } });
    made.clients.push(client.id);
    const mk = async (bankId, data) => {
      const t = await prisma.bankTransaction.create({ data: { bankAccountId: bankId, reconStatus: 'Unmatched', ...data } });
      made.txns.push(t.id); return t;
    };
    const L = {};
    L.salary = await mk(bankA.id, { date: '2026-10-01', description: 'NEFT SALARY OCT 2026', type: 'Debit', amount: 250000, balance: 750000, reference: 'NEFT1', category: 'Salary', categoryKind: 'expense' });
    L.vendor = await mk(bankA.id, { date: '2026-10-02', description: 'NEFT TO ACME SOFTWARE', type: 'Debit', amount: 11800, balance: 738200, reference: 'NEFT2', category: 'Software', categoryKind: 'expense', vendor: 'ZZTEST Acme Software' });
    L.expense = await mk(bankA.id, { date: '2026-10-03', description: 'OFFICE RENT OCT', type: 'Debit', amount: 85000, balance: 653200, reference: 'NEFT3', category: 'Office Rent', categoryKind: 'expense' });
    const inv = await prisma.invoice.create({ data: { clientId: client.id, amount: 10000, gst: 0, tds: 0, invoiceDate: '2026-09-01', dueDate: '2026-09-30', invoiceNumber: `ZZBLM-${RUN}`, receivedAmount: 6000, status: 'Partially Paid' } });
    made.invoices.push(inv.id);
    L.receipt = await mk(bankA.id, { date: '2026-10-04', description: 'NEFT CR ZZTEST CLIENT', type: 'Credit', amount: 10000, balance: 663200, reference: 'UTR1', reconStatus: 'Reconciled' });
    const pay = await prisma.invoicePayment.create({ data: { invoiceId: inv.id, date: '2026-10-04', amount: 6000, method: 'Bank Transfer', bankTxnId: L.receipt.id, dateSource: 'bank' } });
    made.payments.push(pay.id);
    L.fullReceipt = await mk(bankA.id, { date: '2026-10-05', description: 'NEFT CR ZZTEST CLIENT FULL', type: 'Credit', amount: 4000, balance: 667200, reference: 'UTR2', reconStatus: 'Reconciled' });
    const pay2 = await prisma.invoicePayment.create({ data: { invoiceId: inv.id, date: '2026-10-05', amount: 4000, method: 'Bank Transfer', bankTxnId: L.fullReceipt.id, dateSource: 'bank' } });
    made.payments.push(pay2.id);
    L.unallocated = await mk(bankA.id, { date: '2026-10-06', description: 'IMPS CR UNKNOWN PAYER', type: 'Credit', amount: 5000, balance: 672200, reference: 'UTR3' });
    L.unmatched = await mk(bankA.id, { date: '2026-10-07', description: 'UPI/UNKNOWN SHOP', type: 'Debit', amount: 450, balance: 671750, reference: null });
    const loan = await prisma.handLoan.create({ data: { name: `ZZTEST Loan ${RUN}`, lender: 'ZZTEST Lender', amount: 100000, dateTaken: '2026-10-08' } });
    made.loans.push(loan.id);
    L.loanIn = await mk(bankA.id, { date: '2026-10-08', description: 'NEFT CR LOAN FROM LENDER', type: 'Credit', amount: 100000, balance: 771750, reference: 'UTR4' });
    await prisma.handLoanLink.create({ data: { loanId: loan.id, bankTxnId: L.loanIn.id, kind: 'taken', date: '2026-10-08', amount: 100000 } });
    L.loanOut = await mk(bankA.id, { date: '2026-10-09', description: 'NEFT TO LENDER REPAY', type: 'Debit', amount: 20000, balance: 751750, reference: 'NEFT4', categoryKind: 'hand', counterparty: 'ZZTEST Lender' });
    L.refund = await mk(bankA.id, { date: '2026-10-10', description: 'NEFT REFUND TO CLIENT', type: 'Debit', amount: 3000, balance: 748750, reference: 'NEFT5', categoryKind: 'refund', counterparty: 'ZZTEST Refund Client' });
    L.transfer = await mk(bankA.id, { date: '2026-10-11', description: 'TRF TO OWN CURRENT A/C', type: 'Debit', amount: 50000, balance: 698750, reference: 'TRF1', categoryKind: 'transfer' });
    L.reversed = await mk(bankA.id, { date: '2026-10-12', description: 'CHQ DEP RETURNED', type: 'Credit', amount: 7000, balance: 705750, reference: 'CHQ1', reconStatus: 'Reversed' });
    L.ignored = await mk(bankA.id, { date: '2026-10-13', description: 'BANK CHARGES', type: 'Debit', amount: 59, balance: 705691, reference: null, reconStatus: 'Ignored' });
    // every optional value missing, on a bank with no account number
    L.bare = await mk(bankB.id, { date: '2026-10-14', description: '', type: 'Credit', amount: 1200, balance: null, reference: null });
    L.bareDebit = await mk(bankB.id, { date: '2026-10-15', description: 'ZZTEST DEBIT B', type: 'Debit', amount: 99.5, balance: null, reference: null });
    const before = await prisma.bankTransaction.count();
    const detail = (bank, line, tok = admin.t) => http('GET', `/api/banks/${bank.id}/transactions/${line.id}`, tok);
    const D = {};
    for (const [k, line] of Object.entries(L)) D[k] = (await detail(line.bankAccountId === bankB.id ? bankB : bankA, line)).body || {};

    // ---------------------------------------------------------------- D. the facts per line
    const has = (d, o) => Object.entries(o).every(([k, v]) => JSON.stringify(d[k]) === JSON.stringify(v));
    const a = `ZZTEST Bank A ${RUN}`;
    check('D1 debit / salary: date, bank, account masked to the last four, narration, money out, balance, filed as Salary, amount filed',
      has(D.salary, { date: '2026-10-01', narration: 'NEFT SALARY OCT 2026', direction: 'out', moneyOut: 250000, moneyIn: null, balanceAfter: 750000, amountFiled: 250000 })
      && D.salary.bank.name === a && D.salary.bank.account === 'xxxx7777' && D.salary.filedAs.kind === 'salary' && D.salary.filedAs.label === 'Salary', D.salary);
    check('D2 vendor payment: filed as the vendor and the heading; amount filed = the line', D.vendor.filedAs.kind === 'vendor_payment' && D.vendor.filedAs.label === 'Vendor payment · ZZTEST Acme Software · Software' && D.vendor.amountFiled === 11800 && D.vendor.moneyOut === 11800, D.vendor);
    check('D3 expense: filed as the expense heading', D.expense.filedAs.kind === 'expense' && D.expense.filedAs.label === 'Expense · Office Rent' && D.expense.amountFiled === 85000 && D.expense.moneyIn === null, D.expense);
    check('D4 invoice receipt (part of the line): money in 10000, filed 6000 against the invoice, 4000 not filed yet', D.receipt.direction === 'in' && D.receipt.moneyIn === 10000 && D.receipt.moneyOut === null && D.receipt.filedAs.kind === 'invoice_receipt' && D.receipt.filedAs.label.includes(`ZZBLM-${RUN}`) && D.receipt.filedAs.label.includes('ZZTEST BLM Client') && D.receipt.amountFiled === 6000 && D.receipt.unallocated === 4000 && D.receipt.invoices.length === 1, D.receipt);
    check('D5 invoice receipt (whole line): amount filed = money in, nothing left', D.fullReceipt.filedAs.kind === 'invoice_receipt' && D.fullReceipt.amountFiled === 4000 && D.fullReceipt.unallocated === 0, D.fullReceipt);
    check('D6 credit with nothing filed: unallocated, no amount filed, the whole line still to file', D.unallocated.filedAs.kind === 'unallocated' && D.unallocated.amountFiled === null && D.unallocated.unallocated === 5000 && D.unallocated.moneyIn === 5000, D.unallocated);
    check('D7 debit with nothing filed: unmatched, no amount filed; the missing reference is null (the screen prints an em dash)', D.unmatched.filedAs.kind === 'unmatched' && D.unmatched.amountFiled === null && D.unmatched.reference === null && D.unmatched.moneyOut === 450, D.unmatched);
    check('D8 hand loan taken (a link) and repaid (filed by hand): both are the loan, amount filed = the line', D.loanIn.filedAs.kind === 'loan' && D.loanIn.filedAs.label === `Hand loan · ZZTEST Loan ${RUN}` && D.loanIn.amountFiled === 100000 && D.loanOut.filedAs.kind === 'loan' && D.loanOut.filedAs.label === 'Hand loan · ZZTEST Lender' && D.loanOut.amountFiled === 20000, [D.loanIn.filedAs, D.loanOut.filedAs]);
    check('D9 refund and transfer', D.refund.filedAs.kind === 'refund' && D.refund.filedAs.label === 'Client refund · ZZTEST Refund Client' && D.refund.amountFiled === 3000 && D.transfer.filedAs.kind === 'transfer' && D.transfer.amountFiled === 50000, [D.refund.filedAs, D.transfer.filedAs]);
    check('D10 a returned receipt and a set-aside line are not filed as money: no amount filed', D.reversed.filedAs.kind === 'reversed' && D.reversed.amountFiled === null && D.ignored.filedAs.kind === 'ignored' && D.ignored.amountFiled === null, [D.reversed.filedAs, D.ignored.filedAs]);
    check('D11 every optional value missing: narration, balance, reference and account number come back null (the screen prints an em dash), nothing invented',
      D.bare.narration === null && D.bare.balanceAfter === null && D.bare.reference === null && D.bare.bank.account === null && D.bare.moneyIn === 1200 && D.bare.filedAs.kind === 'unallocated' && D.bare.amountFiled === null, D.bare);
    check('D12 amounts keep their paise (99.50 debit)', D.bareDebit.moneyOut === 99.5 && D.bareDebit.moneyIn === null, D.bareDebit.moneyOut);
    check('D13 the account number is masked exactly like the table (last four only) - the full number never leaves the server', !JSON.stringify(Object.values(D)).includes('999988887777') && D.salary.bank.label.endsWith('·7777'), D.salary.bank);

    // ---------------------------------------------------------------- P. permission and scope
    const r1 = await detail(bankA, L.salary, acct.t);
    const r2 = await detail(bankA, L.salary, rec.t);
    const r3 = await http('GET', `/api/banks/${bankA.id}/transactions/${L.salary.id}`, null);
    const list = (tok) => http('GET', `/api/banks/${bankA.id}/transactions?limit=5`, tok);
    const [l1, l2, l3] = [await list(acct.t), await list(rec.t), await list(null)];
    check('P1 the roles that can see the table can open the line; everyone else is refused exactly as the table refuses them', r1.status === l1.status && r1.status === 200 && r2.status === l2.status && [401, 403].includes(r2.status) && r3.status === l3.status && r3.status === 401, [r1.status, l1.status, r2.status, l2.status, r3.status, l3.status]);
    const cross = await http('GET', `/api/banks/${bankB.id}/transactions/${L.salary.id}`, admin.t);
    check('P2 a line is only reachable through its own bank: another bank\'s button gets a 404', cross.status === 404, cross.status);
    const noBank = await http('GET', `/api/banks/nope/transactions/${L.salary.id}`, admin.t);
    const noLine = await detail(bankA, { id: 'nope' });
    check('P3 an unknown bank or an unknown line is a 404, not a crash', noBank.status === 404 && noLine.status === 404, [noBank.status, noLine.status]);
    check('P4 opening lines wrote nothing: no line was added, changed or removed', (await prisma.bankTransaction.count()) === before && (await prisma.bankTransaction.findUnique({ where: { id: L.unallocated.id } })).reconStatus === 'Unmatched');
    const pureUnit = BF.describeFiling({ txn: { type: 'Debit', amount: 100, category: 'Staff Salary & Wages', categoryKind: 'expense' }, state: 'Unmatched' });
    check('P5 unit: "Staff Salary & Wages" is a salary, "Payroll" is a salary, "Salaried Software" is not', pureUnit.kind === 'salary' && BF.describeFiling({ txn: { type: 'Debit', amount: 1, category: 'Payroll', categoryKind: 'expense' }, state: 'Unmatched' }).kind === 'salary' && BF.describeFiling({ txn: { type: 'Debit', amount: 1, category: 'Software', vendor: 'Salaried Software Ltd', categoryKind: 'expense' }, state: 'Unmatched' }).kind === 'vendor_payment');

    // ---------------------------------------------------------------- R. every real line of every bank
    const banks = (await http('GET', '/api/banks', admin.t)).body || [];
    let rowsSeen = 0; let rowsOk = 0; const bad = [];
    for (const b of banks) {
      const lst = (await http('GET', `/api/banks/${b.id}/transactions?limit=100`, admin.t)).body;
      for (const row of (lst && lst.data) || []) {
        rowsSeen += 1;
        const d = (await http('GET', `/api/banks/${b.id}/transactions/${row.id}`, admin.t)).body;
        const ok = d && d.id === row.id && d.date === row.txnDate && (d.narration || '') === (row.description || '') && (d.moneyOut || 0) === row.debit && (d.moneyIn || 0) === row.credit
          && (d.balanceAfter == null ? row.balance == null : d.balanceAfter === row.balance) && d.filedAs && d.filedAs.label && d.state === row.state;
        if (ok) rowsOk += 1; else bad.push([row.id, d]);
      }
    }
    check(`R1 every line of every bank (${rowsSeen} lines, ${banks.length} banks, real and test): the detail agrees with the table row`, rowsSeen > 15 && rowsOk === rowsSeen, bad.slice(0, 2));
    const real = (await prisma.bankTransaction.findMany({ where: { id: { notIn: made.txns } } }));
    const realRent = real.find((t) => t.category === 'Office Rent');
    if (realRent) {
      const first = banks[0];
      const d = (await http('GET', `/api/banks/${first.id}/transactions/${realRent.id}`, admin.t)).body;
      check('R2 a real line saved before accounts existed (no bank id) opens through the first bank, filed as its expense with the office bill\'s amount', d && d.filedAs.kind === 'expense' && d.amountFiled === 85000, d);
    }

    // ---------------------------------------------------------------- M. the sentence by kind (frontend)
    const KINDS = M.KINDS;
    const msg = (kind, direction = 'out', extra = {}) => M.bankLineMessage({ direction, kind, ...extra });
    const texts = KINDS.map((k) => msg(k, ['invoice_receipt', 'unallocated', 'reversed'].includes(k) ? 'in' : 'out'));
    check('M1 every kind has a title and a sentence, and no two kinds say the same thing', texts.every((t) => t.title && t.text) && new Set(texts.map((t) => t.title)).size === KINDS.length, texts.map((t) => t.title));
    check('M2 proof kinds are green (receipt, salary, vendor, expense, loan, refund, other), "not filed yet" and a returned receipt are amber, transfer / set-aside are blue',
      ['invoice_receipt', 'salary', 'vendor_payment', 'expense', 'loan', 'refund', 'other'].every((k) => msg(k).tone === 'green') && ['unallocated', 'unmatched', 'reversed'].every((k) => msg(k).tone === 'amber') && ['transfer', 'ignored'].every((k) => msg(k).tone === 'blue'));
    check('M3 the receipt says it is the proof of the receipt, salary of the salary payment, vendor names the vendor, loan changes with the direction',
      /proof of the receipt/.test(msg('invoice_receipt', 'in').title) && /proof of the salary payment/.test(msg('salary').title) && /ZZTEST Acme/.test(msg('vendor_payment', 'out', { party: 'ZZTEST Acme' }).text)
      && /took/.test(msg('loan', 'in').title) && /gave or repaid/.test(msg('loan', 'out').title) && msg('loan', 'in').text !== msg('loan', 'out').text);
    check('M4 a part-filed receipt says how much is still not filed; a fully filed one does not; the unfiled credit names its amount',
      /₹4,000\.00 of this line is not filed/.test(msg('invoice_receipt', 'in', { unallocated: 4000 }).text) && !/not filed against/.test(msg('invoice_receipt', 'in', { unallocated: 0 }).text) && /₹5,000\.00 is not matched/.test(msg('unallocated', 'in', { unallocated: 5000 }).text));
    check('M5 unknown kind / no kind still gets a sentence by money in or out; loading and failed are said plainly',
      /came in/.test(msg(null, 'in').title) && /went out/.test(msg('weird', 'out').title) && /Checking/.test(M.bankLineMessage({ loading: true }).title) && /could not be loaded/.test(M.bankLineMessage({ failed: true }).title));
    check('M6 plain words: no "Draft", no jargon like "ledger", "debit note", "reconcil" in what people read (the screen name Bank & Reconciliation is fine)', texts.every((t) => !/draft|ledger|reconcil|debit note/i.test(`${t.title} ${t.text}`.replace(/Bank & Reconciliation/g, ''))), texts.filter((t) => /draft|ledger|reconcil|debit note/i.test(`${t.title} ${t.text}`.replace(/Bank & Reconciliation/g, ''))));

    // the window's facts from a table row alone (before the detail arrives), and with the detail
    const rowCredit = { id: 'x1', txnDate: '2026-10-04', description: 'NEFT CR X', debit: 0, credit: 10000, balance: 663200, referenceNo: null, state: 'Unmatched' };
    const rowDebit = { id: 'x2', txnDate: '2026-10-03', description: 'OFFICE RENT', debit: 85000, credit: 0, balance: null, referenceNo: 'N1', state: 'Unmatched' };
    const bank = { id: 'b', name: 'HDFC Bank ·1234', bank: 'HDFC Bank', last4: '1234' };
    const m1 = M.lineModel({ row: rowCredit, bank, loading: true });
    check('M7 before the detail arrives: date, account, narration, money in and balance are the row\'s; "Money out" is left out of a credit; filed-as waits', m1.moneyIn === 10000 && m1.moneyOut === undefined && m1.balanceAfter === 663200 && m1.account === 'HDFC Bank · xxxx1234' && m1.narration === 'NEFT CR X' && m1.filedAs === null && m1.loading === true && /Bank statement line · …/.test(m1.title), m1);
    const m2 = M.lineModel({ row: rowDebit, bank: { ...bank, last4: '' }, loading: false, failed: true });
    check('M8 a debit leaves "Money in" out; a missing balance and a missing account number are em dashes; a failed load shows an em dash for Filed as, never an invented one',
      m2.moneyOut === 85000 && m2.moneyIn === undefined && m2.balanceAfter === null && m2.subtitle[1] === M.DASH && m2.filedAs === M.DASH && m2.title === `Bank statement line · ${M.DASH}` && /could not be loaded/.test(m2.message.title), m2);
    const m3 = M.lineModel({ row: rowCredit, bank, detail: D.receipt, loading: false });
    check('M9 with the detail: the title carries "Filed as", the subtitle is bank · account · date, amount filed is the server\'s', m3.title === `Bank statement line · ${D.receipt.filedAs.label}` && m3.subtitle[0] === a && m3.subtitle[1] === 'xxxx7777' && m3.subtitle[2] === '2026-10-04' && m3.amountFiled === 6000 && m3.message.tone === 'green' && /not filed against an invoice/.test(m3.message.text), m3);
    const m4 = M.lineModel({ row: { id: 'x', txnDate: '', description: '' }, bank: null, detail: D.bare, loading: false });
    check('M10 a line with everything missing: em dashes for the narration and the balance row, nothing invented', m4.narration === M.DASH && m4.balanceAfter === null && m4.subtitle[1] === M.DASH, m4);

    // ---------------------------------------------------------------- S. the table's source
    const tbl = fs.readFileSync(path.join(FE, 'src/pages/bank/BankStatements.jsx'), 'utf8');
    const mod = fs.readFileSync(path.join(FE, 'src/pages/bank/BankLineModal.jsx'), 'utf8');
    const css = fs.readFileSync(path.join(FE, 'src/pages/bank/bank-s6.css'), 'utf8');
    check('S1 every row opens the line: the whole <tr> is clickable and focusable, Enter / Space open it, a control inside the row keeps its own action', /className="bks-row"/.test(tbl) && /tabIndex=\{0\}/.test(tbl) && /onClick=\{onRowClick\(t\)\}/.test(tbl) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(tbl) && /OWN_ACTION/.test(tbl) && /e\.target !== e\.currentTarget/.test(tbl));
    check('S2 the window: dialog role, aria-modal, labelled; closes with ×, Close, Escape and the dim part; focus trap; focus returns; the page behind does not scroll', /role="dialog"/.test(mod) && /aria-modal="true"/.test(mod) && /aria-label="Close"/.test(mod) && /e\.key === 'Escape'/.test(mod) && /e\.key !== 'Tab'/.test(mod) && /opener\.focus/.test(mod) && /document\.body\.style\.overflow = 'hidden'/.test(mod) && /e\.target === e\.currentTarget\) onClose/.test(mod));
    check('S3 look: pointer cursor + hover on rows, dashed separators in the light panel, white rounded window with a soft shadow, scrolls inside on a small screen', /\.bks-row \{ cursor: pointer/.test(css) && /\.s6-kv\.dashed/.test(css) && /dashed #b9c4d6/.test(css) && /border-radius: 16px/.test(css) && /box-shadow/.test(css) && /\.s6-modal-body \{[^}]*overflow: auto/.test(css) && /max-height: calc\(100vh/.test(css));
    // Only the "View line" window (the ViewLine function) must use the shared component and carry no copy of its own rows. The Remove / Edit
    // windows of Hand loans (added later) have their own entry summary rows, which is fine.
    const hl = fs.readFileSync(path.join(FE, 'src/pages/bank/HandLoans.jsx'), 'utf8');
    const vlStart = hl.indexOf('export function ViewLine');
    const viewLineFn = vlStart < 0 ? '' : hl.slice(vlStart, hl.indexOf('export default function', vlStart));
    check('S4 one window for every place: Hand loans "View line" (ViewLine) uses the same BankLineModal component and has no second copy of its rows', /BankLineModal/.test(hl) && /<BankLineModal/.test(viewLineFn) && !/s6-kv-row/.test(viewLineFn) && viewLineFn.length > 200);
  } catch (e) {
    fail += 1; console.log(`FAIL  the test stopped: ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      await prisma.handLoanLink.deleteMany({ where: { bankTxnId: { in: made.txns } } }).catch(() => {});
      await prisma.invoicePayment.deleteMany({ where: { id: { in: made.payments } } }).catch(() => {});
      await prisma.handLoan.deleteMany({ where: { id: { in: made.loans } } }).catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    if (ownCopy) { await new Promise((r) => setTimeout(r, 800)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
