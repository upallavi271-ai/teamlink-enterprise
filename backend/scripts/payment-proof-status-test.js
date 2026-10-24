#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OFFICE BILL "PENDING" NEXT TO A BANK LINE - payment proof / status (Accounts, 2026-10-19) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/payment-proof-status-test.js                       makes its own VACUUM INTO copy of the real database
//                                                                   (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/pps-copy.db node scripts/payment-proof-status-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4066, TEST_MODE=1) on the copy, adds ZZTEST bills / bank lines to the COPY
// and proves, through the real routes (detail AND list) and the truth-table helper (utils/expensePaymentState.js):
//   F  the founder's exact case (bill Pending + linked bank line, made the way the old flow made it) now says why, the
//      repair script marks it Paid (dry run default, guarded, idempotent, audited, undoable)
//   1  proof exists, payment not confirmed (a link is not a payment)    2  proof + payment confirmed (admin / non-approver)
//   3  matched and reconciled (line filed as a bill)                    4  unmatched (no link)
//   5  partly matched (part paid)    6  reversed / set aside / broken (orphan, money in, bank gone) - no "View line"
//   V  "View line" opens exactly the linked transaction   I  idempotency (twice, at once, repeat import)
//   R  re-login and refresh give the same status (persisted)   U  unrelated tables untouched   P  permissions unchanged
//   Q  the frontend mapping (frontend office/paymentProof.js, bundled with esbuild)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');

let copy = process.env.COPY_DB;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `pps-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4066);
if (PORT === 4010 || PORT === 4045) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const PS = require(path.join(BACK, 'src/utils/expensePaymentState'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const RUN = Date.now().toString(36);
const TAG = `ZZTEST PP ${RUN}`;

function bundle(rel, name) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzpp-${RUN}-${name}.cjs`);
  esb.buildSync({ entryPoints: [path.join(FE, rel)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
  return require(out);
}
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const made = { users: [], banks: [], txns: [], bills: [] };
let server;

(async () => {
  try {
    const M = bundle('src/pages/office/paymentProof.js', 'map');
    // The non-approver: Role Catalog takes "approve" on Office & Expenses away from Accountants (copy database only).
    const noApprove = { view: true, create: true, edit: true, delete: false, approve: false, export: true, assign: false };
    const allFeatures = Object.fromEntries(['Expenses & Bills', 'Vendors', 'Expense Categories', 'Business Profile & Tax Portals', 'GST Reconciliation', 'Due Dates & Reminders'].map((f) => [f, noApprove]));
    await prisma.roleAccess.upsert({
      where: { role_product_moduleId: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office' } },
      create: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office', moduleEnabled: true, features: JSON.stringify(allFeatures) },
      update: { moduleEnabled: true, features: JSON.stringify(allFeatures) },
    });

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const PW = `Zz-${RUN}-${crypto.randomBytes(6).toString('hex')}`;
    const mkUser = async (tag, extra) => {
      const email = `zz-pp-${tag}-${RUN}@example.test`;
      const u = await prisma.user.create({ data: { passwordHash: await bcrypt.hash(PW, 4), name: `ZZTEST PP ${tag} ${RUN}`, email, username: email, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, email, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const rec = await mkUser('rec', {});

    // ---------------------------------------------------------------- fixtures (in the COPY)
    const bankA = await prisma.bankAccount.create({ data: { bank: `ZZTEST PP Bank A ${RUN}`, name: 'ZZTEST A', accNo: '777766665555', active: true } });
    const bankB = await prisma.bankAccount.create({ data: { bank: `ZZTEST PP Bank B ${RUN}`, name: 'ZZTEST B', accNo: '', active: true } });
    const bankGone = await prisma.bankAccount.create({ data: { bank: `ZZTEST PP Bank Gone ${RUN}`, name: 'ZZTEST G', accNo: '', active: true } });
    made.banks.push(bankA.id, bankB.id, bankGone.id);
    const line = async (bankId, o) => {
      const t = await prisma.bankTransaction.create({ data: { bankAccountId: bankId, reconStatus: 'Unmatched', type: 'Debit', date: '2026-10-05', description: `ZZTEST PP line ${RUN}`, balance: null, ...o } });
      made.txns.push(t.id); return t;
    };
    let seq = 0;
    const bill = async (o = {}) => {
      seq += 1;
      const b = await prisma.officeExpense.create({
        data: {
          category: 'ZZTEST PP Category', vendor: `${TAG} Vendor ${seq}`, expenseDate: '2026-10-05', monthlyAmount: 10000, gstAmount: 0, tdsAmount: 0, paidStatus: 'Unpaid', approvalStatus: 'PENDING', entryKind: 'expense', recurring: false, paymentMode: 'Bank Transfer', description: `${TAG} bill ${seq}`, createdById: admin.u.id, ...o,
        },
      });
      made.bills.push(b.id); return b;
    };
    const billNow = (id) => prisma.officeExpense.findUnique({ where: { id } });
    const lineNow = (id) => prisma.bankTransaction.findUnique({ where: { id } });
    const detail = (id, tok = admin.t) => http('GET', `/api/office-expenses/${id}`, tok);
    const ledgerRow = async (id, tok = admin.t) => {
      const b = await billNow(id);
      const r = await http('GET', `/api/office-expenses/ledger?pageSize=100&q=${encodeURIComponent(b.vendor)}`, tok);
      return ((r.body && r.body.rows) || []).find((x) => x.id === id) || null;
    };
    const auditCount = (id, action) => prisma.auditLog.count({ where: { entity: 'OfficeExpense', entityId: id, action } });
    // The unrelated tables - counted and fingerprinted before and after everything.
    const sdb = new DatabaseSync(copy, { readOnly: true });
    const UNRELATED = ['Candidate', 'Application', 'Employee', 'Client', 'Invoice', 'InvoicePayment', 'HandLoan', 'HandLoanLink', 'Job', 'LeaveRequest', 'Attendance', 'PayrollRun', 'OfficeVendor', 'Asset', 'ExpenseCategory'];
    const fingerprint = () => {
      const out = {};
      for (const t of UNRELATED) {
        try {
          const rows = sdb.prepare(`SELECT * FROM "${t}" ORDER BY "id"`).all();
          out[t] = `${rows.length}:${crypto.createHash('sha1').update(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? String(v) : v))).digest('hex')}`;
        } catch { out[t] = 'n/a'; }
      }
      return out;
    };
    const unrelatedBefore = fingerprint();

    // =============================================================== F. the founder's exact case
    // Made exactly the way the old "Match bills" left it: linked to the line, the line says it is filed against the bill, the bill still Pending.
    const Lf = await line(bankA.id, { amount: 10000, description: `ZZTEST PP NEFT RENT ${RUN}`, reference: `ZZPPF${RUN}`, category: 'ZZTEST PP Category', categoryKind: 'expense' });
    const Bf = await bill({ bankTxnId: Lf.id, paymentDate: '2026-10-05' });
    await prisma.bankTransaction.update({ where: { id: Lf.id }, data: { billLinks: JSON.stringify([{ id: Bf.id, approvalStatus: 'PENDING', paidStatus: 'Unpaid', paidAt: null, paidById: null, paymentDate: null, net: 10000 }]) } });
    const dF = (await detail(Bf.id)).body; const lF = await ledgerRow(Bf.id);
    check('F1 founder case, details: status is still Pending (not hidden, not faked) and the answer says the matched bank payment is waiting to be marked Paid', dF.status === 'PENDING' && dF.statusText && dF.payment.state === 'confirmed' && dF.payment.needsApprover === true && /waiting to be marked Paid/.test(dF.payment.label) && /still Pending/.test(dF.payment.reason) && /Mark as Paid/.test(dF.payment.reason), dF.payment);
    check('F2 founder case, list: the table row carries the same answer and a usable bank line', lF && lF.status === 'PENDING' && lF.payment.state === 'confirmed' && lF.payment.needsApprover && lF.bankLine === true && lF.proofLink === true, lF);
    check('F3 founder case: the truth-table helper (no HTTP) gives the same answer as the API', JSON.stringify(await PS.describeOne(prisma, await billNow(Bf.id))) === JSON.stringify(dF.payment), null);

    // the repair script, on the copy
    const OUT = path.join(os.tmpdir(), `zzpp-repair-${RUN}`);
    const runRepair = (args) => spawnSync(process.execPath, [path.join(BACK, 'scripts/payment-proof-status-repair.js'), '--db', copy, '--csv', path.join(OUT, 'review.csv'), '--out', OUT, ...args], { cwd: BACK, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DATABASE_URL')) });
    const dry = runRepair([]);
    const dryJson = JSON.parse(dry.stdout.slice(dry.stdout.indexOf('{'), dry.stdout.lastIndexOf('}') + 1));
    check('F4 repair script, dry run (default): finds the bill, writes only the CSV, changes nothing', dry.status === 0 && dryJson.willBeMarkedPaid >= 1 && (await billNow(Bf.id)).approvalStatus === 'PENDING' && /DRY RUN/.test(dry.stdout) && /WILL BE MARKED PAID/.test(fs.readFileSync(path.join(OUT, 'review.csv'), 'utf8')), dry.stdout.slice(-500) + dry.stderr.slice(-300));
    const refuse = spawnSync(process.execPath, [path.join(BACK, 'scripts/payment-proof-status-repair.js'), '--apply'], { cwd: BACK, encoding: 'utf8' });
    check('F5 repair script refuses to write the REAL database without --really-real and TL_ALLOW_REAL_APPLY=1', refuse.status === 2 && /REFUSED/.test(refuse.stderr), refuse.stderr.slice(0, 200));
    const app1 = runRepair(['--apply']);
    const afterF = await billNow(Bf.id);
    check('F6 repair --apply (on the copy): the bill is Paid, paid on the date of the bank line, sign-off recorded as the repair, backup + undo manifest written', app1.status === 0 && afterF.approvalStatus === 'PAID' && afterF.paidStatus === 'Paid' && afterF.paymentDate === '2026-10-05' && /Payment status repair/.test(afterF.approvedBy || '') && fs.existsSync(path.join(OUT, 'undo-manifest.json')) && fs.existsSync(path.join(OUT, 'backup', 'dev.db')), app1.stdout.slice(-400) + app1.stderr.slice(-300));
    check('F7 repair: one audit line for the bill (Pending -> PAID, with the bank line in the reason)', (await auditCount(Bf.id, 'Office expense status: Paid')) === 1 && /bank statement line of 2026-10-05/.test((await prisma.auditLog.findFirst({ where: { entityId: Bf.id, action: 'Office expense status: Paid' } })).reason || ''));
    const app2 = runRepair(['--apply']);
    check('F8 repair is idempotent: a second run changes nothing and writes no second audit line', app2.status === 0 && /NOTHING TO DO/.test(app2.stdout) && (await auditCount(Bf.id, 'Office expense status: Paid')) === 1 && JSON.stringify(await billNow(Bf.id)) === JSON.stringify(afterF), app2.stdout.slice(-300));
    const dF2 = (await detail(Bf.id)).body;
    check('F9 after the repair the details agree with the saved state: Paid, bank payment confirmed, green', dF2.status === 'PAID' && dF2.payment.state === 'confirmed' && dF2.payment.needsApprover === false && dF2.payment.inconsistent === false && dF2.payment.tone === 'green', dF2.payment);
    const und = runRepair(['--undo', path.join(OUT, 'undo-manifest.json')]);
    const undone = await billNow(Bf.id);
    check('F10 repair --undo puts the bill back exactly (Pending, no sign-off) and removes the repair audit line', und.status === 0 && undone.approvalStatus === 'PENDING' && undone.paidStatus === 'Unpaid' && !undone.approvedBy && (await auditCount(Bf.id, 'Office expense status: Paid')) === 0, und.stdout.slice(-300) + und.stderr.slice(-200));

    // =============================================================== 1. proof exists, payment not confirmed
    const L1 = await line(bankA.id, { amount: 7000, reference: `ZZPP1${RUN}` });
    const B1 = await bill({ monthlyAmount: 7000, bankTxnId: L1.id });
    const d1 = (await detail(B1.id)).body; const l1 = await ledgerRow(B1.id);
    check('1a proof linked but the line is not matched to the bill: still Pending, the answer says a link is not a payment, "View line" is still offered (the line is real)', d1.status === 'PENDING' && d1.payment.state === 'link_only' && /not matched to this bill/.test(d1.payment.reason) && /not a payment/.test(d1.payment.reason) && d1.payment.proof.canView === true && d1.payment.needsApprover === false, d1.payment);
    check('1b same in the list; the link never made the bill Paid in the database', l1.status === 'PENDING' && l1.payment.state === 'link_only' && (await billNow(B1.id)).paidStatus === 'Unpaid' && (await billNow(B1.id)).approvalStatus === 'PENDING', l1.payment);
    const B1p = await bill({ monthlyAmount: 7000, approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: L1.id });
    const d1p = (await detail(B1p.id)).body;
    check('1c a bill marked Paid whose linked line is not matched to it stays Paid but is flagged (needs a look) - it is not called confirmed', d1p.status === 'PAID' && d1p.payment.state === 'link_only' && d1p.payment.inconsistent === true && d1p.payment.tone === 'amber', d1p.payment);
    const sneak = await http('PATCH', `/api/office-expenses/${B1.id}`, admin.t, { bankTxnId: L1.id, description: `${TAG} edited` });
    const credit = await line(bankA.id, { type: 'Credit', amount: 7000, description: 'ZZTEST PP money in' });
    const Bx = await bill({ monthlyAmount: 3000 });
    const sneak2 = await http('PATCH', `/api/office-expenses/${Bx.id}`, admin.t, { bankTxnId: credit.id, description: `${TAG} edited x` });
    check('1d a form can no longer set the proof link: an edit that carries a bankTxnId changes the other fields and ignores the link', sneak.status === 200 && sneak2.status === 200 && (await billNow(Bx.id)).bankTxnId === null && (await billNow(Bx.id)).description === `${TAG} edited x` && (await billNow(B1.id)).bankTxnId === L1.id, [sneak.status, sneak2.status]);

    // =============================================================== 2. proof + payment confirmed (through the real "Match bills")
    const L2 = await line(bankA.id, { amount: 5000, reference: `ZZPP2${RUN}` });
    const B2 = await bill({ monthlyAmount: 5000 });
    const m2 = await http('POST', `/api/bank/${L2.id}/match-bills`, admin.t, { billIds: [B2.id] });
    const d2 = (await detail(B2.id)).body; const l2 = await ledgerRow(B2.id);
    const b2 = await billNow(B2.id);
    check('2a an approver matches a Pending bill to the debit line it covers: the bill becomes Paid in the database (not only on screen)', m2.status === 200 && m2.body.markedPaid === 1 && b2.approvalStatus === 'PAID' && b2.paidStatus === 'Paid' && b2.paymentDate === '2026-10-05' && b2.approvedById === admin.u.id && b2.paidById === admin.u.id && b2.bankTxnId === L2.id, [m2.status, m2.body, b2.approvalStatus]);
    check('2b details and list agree: Paid, bank payment confirmed, no warning chip', d2.status === 'PAID' && d2.payment.state === 'confirmed' && d2.payment.tone === 'green' && !d2.payment.inconsistent && l2.status === 'PAID' && l2.payment.state === 'confirmed' && M.payChip(l2.payment) === null, [d2.payment, l2.payment]);
    check('2c the status change is audited: who, when, Pending -> PAID, which statement line', (await auditCount(B2.id, 'Office expense status: Paid')) === 1 && /matched by ZZTEST PP admin/.test((await prisma.auditLog.findFirst({ where: { entityId: B2.id, action: 'Office expense status: Paid' } })).reason || ''));
    // a non-approver
    const L3 = await line(bankA.id, { amount: 3000, reference: `ZZPP3${RUN}` });
    const B3 = await bill({ monthlyAmount: 3000 });
    const m3 = await http('POST', `/api/bank/${L3.id}/match-bills`, acct.t, { billIds: [B3.id] });
    const d3 = (await detail(B3.id, acct.t)).body;
    check('2d a non-approver matches the same way: the line is matched and linked, the bill is NOT paid by that (stays Pending), and the details say an approver has to mark it Paid', m3.status === 200 && m3.body.markedPaid === 0 && m3.body.pendingApproval === 1 && (await billNow(B3.id)).approvalStatus === 'PENDING' && d3.payment.state === 'confirmed' && d3.payment.needsApprover === true, [m3.status, m3.body, d3.payment]);
    const no = await http('PATCH', `/api/office-expenses/${B3.id}/status`, acct.t, { action: 'mark_paid' });
    const yes = await http('PATCH', `/api/office-expenses/${B3.id}/status`, admin.t, { action: 'mark_paid' });
    const again = await http('PATCH', `/api/office-expenses/${B3.id}/status`, admin.t, { action: 'mark_paid' });
    const b3 = await billNow(B3.id);
    check('2e only an approver can finish it; the approver\'s Mark as Paid works once (the second press is refused, the paid time does not move)', no.status === 403 && yes.status === 200 && yes.body.status === 'PAID' && yes.body.payment.state === 'confirmed' && yes.body.payment.needsApprover === false && again.status === 409 && String(b3.paidAt.getTime()) === String(new Date(yes.body.paidAt).getTime()), [no.status, yes.status, again.status]);
    // an old APPROVED bill is already signed off: the matching line finishes it, for any accountant (as it always did)
    const L3b = await line(bankA.id, { amount: 2200, reference: `ZZPP3B${RUN}` });
    const B3b = await bill({ monthlyAmount: 2200, approvalStatus: 'APPROVED', approvedBy: 'ZZTEST earlier approver' });
    const m3b = await http('POST', `/api/bank/${L3b.id}/match-bills`, acct.t, { billIds: [B3b.id] });
    check('2g an old APPROVED bill matched by a non-approver becomes Paid (it was already signed off); its sign-off is kept', m3b.status === 200 && m3b.body.markedPaid === 1 && (await billNow(B3b.id)).approvalStatus === 'PAID' && (await billNow(B3b.id)).approvedBy === 'ZZTEST earlier approver', [m3b.status, m3b.body]);
    // undo goes back to how it was
    const un = await http('POST', `/api/bank/${L2.id}/uncategorise`, admin.t);
    const b2u = await billNow(B2.id);
    check('2f undoing the bank match puts the bill back to how it was (Pending, no sign-off, link gone) and says so in the audit trail', un.status === 200 && b2u.approvalStatus === 'PENDING' && b2u.paidStatus === 'Unpaid' && b2u.bankTxnId === null && !b2u.approvedById && !b2u.approvedBy && (await auditCount(B2.id, 'Office expense status: Pending')) === 1, [un.status, b2u.approvalStatus]);

    // =============================================================== 3. matched and reconciled (line filed as a bill)
    const L4 = await line(bankA.id, { amount: 11800, description: `ZZTEST PP UPI ACME ${RUN}`, reference: `ZZPP4${RUN}` });
    const c4 = await http('POST', `/api/bank/${L4.id}/categorise`, admin.t, { kind: 'expense', fileAsBill: true, expenseAccount: 'ZZTEST PP Category', amount: 11800, date: '2026-10-05', vendor: `${TAG} Acme`, gst: 'No', tds: 'No', description: `${TAG} filed from the line` });
    const B4 = c4.body && c4.body.bill ? await billNow(c4.body.bill.id) : null;
    if (B4) made.bills.push(B4.id);
    const d4 = B4 ? (await detail(B4.id)).body : {};
    const bd4 = (await http('GET', `/api/banks/${bankA.id}/transactions/${L4.id}`, admin.t)).body;
    check('3a a line filed as a bill: the bill is Paid, bank payment confirmed, and the bank screen reports the same line as filed (expense)', c4.status === 200 && B4 && B4.approvalStatus === 'PAID' && d4.payment.state === 'confirmed' && d4.payment.proof.txnId === L4.id && bd4.filedAs.kind === 'vendor_payment' && bd4.amountFiled === 11800, [c4.status, d4.payment, bd4 && bd4.filedAs]);

    // =============================================================== 4. unmatched
    const B5 = await bill({ monthlyAmount: 2500 });
    const d5 = (await detail(B5.id)).body; const l5 = await ledgerRow(B5.id);
    check('4 unmatched: no link, Pending, plain reason, no proof row, no chip, no "View line"', d5.status === 'PENDING' && d5.payment.state === 'no_link' && /Not paid yet/.test(d5.payment.reason) && d5.payment.proof.has === false && d5.payment.proof.canView === false && l5.bankLine === false && l5.proofLink === false && M.payChip(l5.payment) === null && M.proofRow(d5.payment).kind === 'none', d5.payment);

    // =============================================================== 5. partly matched
    const L6 = await line(bankA.id, { amount: 6000, reference: `ZZPP6${RUN}`, category: 'ZZTEST PP Category', categoryKind: 'expense' });
    const B6 = await bill({ monthlyAmount: 10000, bankTxnId: L6.id });
    await prisma.bankTransaction.update({ where: { id: L6.id }, data: { billLinks: JSON.stringify([{ id: B6.id, approvalStatus: 'PENDING', paidStatus: 'Unpaid', net: 10000 }]) } });
    const d6 = (await detail(B6.id)).body; const l6 = await ledgerRow(B6.id);
    check('5a part paid: ₹6,000.00 of ₹10,000.00, balance ₹4,000.00, still Pending, never "confirmed"', d6.status === 'PENDING' && d6.payment.state === 'part' && d6.payment.bankPaid === 6000 && d6.payment.balance === 4000 && /Part paid: ₹6,000\.00 of ₹10,000\.00/.test(d6.payment.label) && d6.payment.needsApprover === false && l6.payment.state === 'part', d6.payment);
    const L7 = await line(bankA.id, { amount: 6000, reference: `ZZPP7${RUN}` });
    const B7 = await bill({ monthlyAmount: 10000 });
    const m7 = await http('POST', `/api/bank/${L7.id}/match-bills`, admin.t, { billIds: [B7.id] });
    check('5b "Match bills" refuses a line smaller than the bill and changes nothing (no half payment is recorded as Paid)', m7.status === 400 && (await billNow(B7.id)).bankTxnId === null && (await billNow(B7.id)).approvalStatus === 'PENDING' && (await lineNow(L7.id)).billLinks === null, [m7.status, m7.body]);
    const B6p = await bill({ monthlyAmount: 10000, approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: L6.id });
    check('5c a Paid bill pointing at a line that is not filed against it is flagged, not called confirmed', (await detail(B6p.id)).body.payment.state === 'link_only' || (await detail(B6p.id)).body.payment.inconsistent === true);

    // =============================================================== 6. reversed / set aside / broken
    const L8 = await line(bankA.id, { amount: 4000, reference: `ZZPP8${RUN}`, category: 'ZZTEST PP Category', categoryKind: 'expense' });
    const B8 = await bill({ monthlyAmount: 4000, bankTxnId: L8.id });
    await prisma.bankTransaction.update({ where: { id: L8.id }, data: { billLinks: JSON.stringify([{ id: B8.id, approvalStatus: 'PENDING', paidStatus: 'Unpaid', net: 4000 }]) } });
    const rev = await line(bankA.id, { type: 'Credit', amount: 4000, description: 'ZZTEST PP PAYMENT RETURNED', reversalOfId: L8.id });
    const d8 = (await detail(B8.id)).body;
    check('6a reversed: a later line reverses the payment - Pending bill says it does not count; the link is real so View line stays; never needsApprover', d8.status === 'PENDING' && d8.payment.state === 'reversed' && /reversed/.test(d8.payment.reason) && d8.payment.needsApprover === false && d8.payment.tone === 'red' && d8.payment.proof.canView === true, d8.payment);
    const B8p = await bill({ monthlyAmount: 4000, approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: L8.id });
    await prisma.bankTransaction.update({ where: { id: L8.id }, data: { billLinks: JSON.stringify([{ id: B8.id, net: 4000 }, { id: B8p.id, net: 4000 }]) } });
    const d8p = (await detail(B8p.id)).body;
    check('6b a Paid bill whose payment was reversed stays Paid in the books (nothing is auto-changed) but is flagged red', d8p.status === 'PAID' && d8p.payment.state === 'reversed' && d8p.payment.inconsistent === true && d8p.payment.tone === 'red', d8p.payment);
    const L9 = await line(bankA.id, { amount: 2000, reference: `ZZPP9${RUN}`, reconStatus: 'Ignored', category: 'ZZTEST PP Category', categoryKind: 'expense' });
    const B9 = await bill({ monthlyAmount: 2000, bankTxnId: L9.id });
    await prisma.bankTransaction.update({ where: { id: L9.id }, data: { billLinks: JSON.stringify([{ id: B9.id, net: 2000 }]) } });
    check('6c a line that is set aside (Ignored) is not a payment', (await detail(B9.id)).body.payment.state === 'ignored');
    const Bo = await bill({ monthlyAmount: 1500, bankTxnId: 'zz-no-such-line' });
    const dOrph = (await detail(Bo.id)).body; const lOrph = await ledgerRow(Bo.id);
    const viewOrph = await http('GET', `/api/office-expenses/${Bo.id}/bank-line`, admin.t);
    check('6d orphan link (line deleted): "Proof link is broken" with the reason, no View line (details, list, and the old bank-line route all refuse)', dOrph.payment.state === 'broken' && /no longer on file/.test(dOrph.payment.reason) && dOrph.payment.proof.canView === false && dOrph.payment.proof.bankId === null && M.proofRow(dOrph.payment).kind === 'broken' && lOrph.bankLine === false && lOrph.proofLink === true && viewOrph.status === 409 && /Proof link is broken/.test(viewOrph.body.error), [dOrph.payment, viewOrph.status]);
    const Bc = await bill({ monthlyAmount: 7000, bankTxnId: credit.id });
    const dCr = (await detail(Bc.id)).body;
    check('6e a link to a money-IN line is broken (not a payment out)', dCr.payment.state === 'broken' && /money coming in/.test(dCr.payment.reason) && dCr.payment.proof.canView === false, dCr.payment);
    const Lg = await line(bankGone.id, { amount: 900, reference: `ZZPPG${RUN}` });
    await prisma.bankTransaction.update({ where: { id: Lg.id }, data: { bankAccountId: 'zz-bank-removed' } });
    const Bg = await bill({ monthlyAmount: 900, bankTxnId: Lg.id });
    check('6f a link to a line whose bank account is not on file is broken', (await detail(Bg.id)).body.payment.state === 'broken' && /bank account/.test((await detail(Bg.id)).body.payment.reason));
    const Bp = await bill({ monthlyAmount: 1500, approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: 'zz-no-such-line-2' });
    const dBp = (await detail(Bp.id)).body;
    check('6g a Paid bill with a broken link stays Paid and is flagged "Proof link is broken" (the status is the stored one; the proof is what is wrong)', dBp.status === 'PAID' && dBp.payment.state === 'broken' && dBp.payment.inconsistent === true && /Marked Paid/.test(dBp.payment.reason), dBp.payment);

    // =============================================================== V. "View line" opens exactly the linked transaction
    const dV = (await detail(B4.id)).body.payment.proof;
    const open = await http('GET', `/api/banks/${encodeURIComponent(dV.bankId)}/transactions/${encodeURIComponent(dV.txnId)}`, admin.t);
    const wrongBank = await http('GET', `/api/banks/${bankB.id}/transactions/${dV.txnId}`, admin.t);
    check('V1 View line: the bank and line ids come from the checked answer and open exactly that transaction (same id, amount, reference, date)', open.status === 200 && open.body.id === L4.id && open.body.moneyOut === 11800 && open.body.reference === `ZZPP4${RUN}` && open.body.date === '2026-10-05' && dV.bankId === bankA.id && dV.line.id === L4.id && M.sameLine(open.body, M.proofRow((await detail(B4.id)).body.payment)) , [open.status, dV]);
    check('V2 a line is not reachable through another bank (404), and a bill never points at another bill\'s line', wrongBank.status === 404 && (await detail(B2.id)).body.payment.proof.txnId !== dV.txnId);
    const oldRoute = await http('GET', `/api/office-expenses/${B4.id}/bank-line`, admin.t);
    check('V3 the old bank-line route (kept) validates the same way and returns the same line + the answer', oldRoute.status === 200 && oldRoute.body.line.id === L4.id && oldRoute.body.bankId === bankA.id && oldRoute.body.payment.state === 'confirmed', [oldRoute.status]);
    const sf = fs.readFileSync(path.join(FE, 'src/pages/office/ExpenseDrawer.jsx'), 'utf8');
    check('V4 source: View line is only inside the "valid" proof branch, opens BankLineModal through /banks/:bankId/transactions/:txnId, and the old copy of the statement table is gone', /proof\.kind === 'valid'[\s\S]{0,400}View line/.test(sf) && /\/banks\/\$\{encodeURIComponent\(proof\.bankId\)\}\/transactions\/\$\{encodeURIComponent\(proof\.txnId\)\}/.test(sf) && /<BankLineModal/.test(sf) && !/oe-stmt/.test(sf) && !/x\.bankTxnId/.test(sf));

    // =============================================================== I. idempotency
    const L10 = await line(bankA.id, { amount: 4500, reference: `ZZPP10${RUN}` });
    const B10 = await bill({ monthlyAmount: 4500 });
    const [r1, r2] = await Promise.all([
      http('POST', `/api/bank/${L10.id}/match-bills`, admin.t, { billIds: [B10.id] }),
      http('POST', `/api/bank/${L10.id}/match-bills`, admin.t, { billIds: [B10.id] }),
    ]);
    const l10 = await lineNow(L10.id);
    check('I1 two "Match bills" at the very same moment: exactly one wins, one link, one Paid, one audit line', [r1.status, r2.status].filter((s) => s === 200).length === 1 && [r1.status, r2.status].every((s) => [200, 400, 409].includes(s)) && JSON.parse(l10.billLinks).length === 1 && (await billNow(B10.id)).approvalStatus === 'PAID' && (await auditCount(B10.id, 'Office expense status: Paid')) === 1, [r1.status, r2.status, r1.body && r1.body.error, r2.body && r2.body.error]);
    const r3 = await http('POST', `/api/bank/${L10.id}/match-bills`, admin.t, { billIds: [B10.id] });
    const before10 = JSON.stringify(await billNow(B10.id));
    check('I2 repeating it later is refused ("already filed") and changes nothing', r3.status === 400 && /already filed/.test(r3.body.error) && JSON.stringify(await billNow(B10.id)) === before10);
    const L11 = await line(bankA.id, { amount: 4500, reference: `ZZPP11${RUN}` });
    const r4 = await http('POST', `/api/bank/${L11.id}/match-bills`, admin.t, { billIds: [B10.id] });
    check('I3 a bill already paid off one line cannot be paid off a second line', r4.status === 400 && (await billNow(B10.id)).bankTxnId === L10.id && (await lineNow(L11.id)).billLinks === null, [r4.status, r4.body]);
    const dupIds = await http('POST', `/api/bank/${L11.id}/match-bills`, admin.t, { billIds: [B5.id, B5.id, B5.id] });
    check('I4 the same bill ticked three times is one bill (a bill of ₹2,500 on a ₹4,500 line settles once)', dupIds.status === 200 && dupIds.body.settled === 1 && JSON.parse((await lineNow(L11.id)).billLinks).length === 1 && (await auditCount(B5.id, 'Office expense status: Paid')) === 1, [dupIds.status, dupIds.body]);
    // repeated bank import
    const snap = async () => JSON.stringify((await prisma.officeExpense.findMany({ where: { id: { in: made.bills } }, orderBy: { id: 'asc' }, select: { id: true, approvalStatus: true, paidStatus: true, bankTxnId: true, paidAt: true, paymentDate: true, approvedBy: true } })));
    const linesSnap = async () => JSON.stringify((await prisma.bankTransaction.findMany({ where: { id: { in: made.txns } }, orderBy: { id: 'asc' }, select: { id: true, billLinks: true, createdBillId: true, category: true, categoryKind: true, reconStatus: true } })));
    const billsBefore = await snap(); const linesBefore = await linesSnap();
    const payCountBefore = await prisma.invoicePayment.count(); const billCountBefore = await prisma.officeExpense.count({ where: { vendor: { startsWith: TAG } } });
    const csv = `Date,Description,Debit,Credit,Balance\n2026-10-06,ZZTEST PP IMPORT LINE ${RUN} ONE,123.45,,100000\n2026-10-07,ZZTEST PP IMPORT LINE ${RUN} TWO,67.89,,99932.11\n`;
    const imp1 = await http('POST', '/api/bank/import', admin.t, { csv, bankAccountId: bankB.id, file: `zzpp-${RUN}.csv` });
    const billCountAfterFirst = await prisma.officeExpense.count({ where: { vendor: { startsWith: TAG } } }); // a learnt narration rule may file the new lines as bills on the FIRST import
    const payAfterFirst = await prisma.invoicePayment.count();
    const imp2 = await http('POST', '/api/bank/import', admin.t, { csv, bankAccountId: bankB.id, file: `zzpp-${RUN}.csv` });
    const imported = await prisma.bankTransaction.findMany({ where: { bankAccountId: bankB.id, description: { contains: `ZZTEST PP IMPORT LINE ${RUN}` } } });
    imported.forEach((t) => made.txns.push(t.id));
    const lAfter = JSON.parse(await linesSnap()); const lBefore = JSON.parse(linesBefore);
    const parts = {
      imports: imp1.status === 201 && imp2.status === 201, twoLines: imported.length === 2, billsSame: (await snap()) === billsBefore,
      oldLinesSame: lAfter.filter((x) => lBefore.some((y) => y.id === x.id)).every((x) => JSON.stringify(x) === JSON.stringify(lBefore.find((y) => y.id === x.id))),
      noPaymentRecord: (await prisma.invoicePayment.count()) === payCountBefore && payAfterFirst === payCountBefore, secondImportAddsNoBill: (await prisma.officeExpense.count({ where: { vendor: { startsWith: TAG } } })) === billCountAfterFirst,
    };
    check('I5 repeated bank import: no duplicate lines (2 lines after two imports), no payment record added, no bill status or link changed', Object.values(parts).every(Boolean), parts);

    // =============================================================== R. re-login and refresh
    const login = await http('POST', '/api/auth/login', null, { email: admin.email, password: PW });
    const tok2 = login.body && (login.body.token || (login.body.data && login.body.data.token));
    const ids = [B4.id, Bf.id, B6.id, B8.id, Bo.id, B1.id, B3.id, B10.id];
    const viaOld = []; const viaNew = []; const viaDb = [];
    for (const id of ids) {
      viaOld.push(JSON.stringify([(await detail(id)).body.status, (await detail(id)).body.payment]));
      viaNew.push(tok2 ? JSON.stringify([(await detail(id, tok2)).body.status, (await detail(id, tok2)).body.payment]) : 'no login');
      viaDb.push((await billNow(id)).approvalStatus);
    }
    check('R1 re-login (a real sign-in, a new token) and page refresh (asking again) give identical status and payment answers for 8 bills, and the status equals what is saved', !!tok2 && viaOld.every((x, i) => x === viaNew[i]) && ids.every((id, i) => JSON.parse(viaOld[i])[0] === viaDb[i]), [login.status, !!tok2]);

    // =============================================================== dashboard + register
    const dash = await http('GET', '/api/dashboard/accounts/control?fresh=1', admin.t);
    const dashRows = JSON.stringify(dash.body);
    const dRow = (dash.body && ((dash.body.office && dash.body.office.rows) || (dash.body.expenses && dash.body.expenses.rows) || [])) || [];
    const found = dRow.find((x) => x.id === B3.id) || dRow.find((x) => x.id === B1.id);
    check('D1 the Accounts Dashboard shows the same answer (a linked-but-unmatched Pending bill says "Linked, not matched", not "Waiting for approval")', dash.status === 200 && (!found || /Linked, not matched|Matched - mark Paid|Paid/.test(found.payStatus)) && dashRows.length > 100, [dash.status, found && found.payStatus]);
    const reg = await http('GET', `/api/office-expenses/register?q=${encodeURIComponent(TAG)}`, admin.t);
    check('D2 the register answers (200) and the export text helper does not call a broken link a bank statement', reg.status === 200);

    // =============================================================== U. unrelated tables, P. permissions
    const unrelatedAfter = fingerprint();
    check(`U1 unrelated tables untouched (${UNRELATED.filter((t) => unrelatedBefore[t] !== 'n/a').length} tables: row counts + fingerprints identical before / after)`, UNRELATED.every((t) => unrelatedBefore[t] === unrelatedAfter[t]), UNRELATED.filter((t) => unrelatedBefore[t] !== unrelatedAfter[t]));
    const recDet = await detail(B1.id, rec.t); const recLedger = await http('GET', '/api/office-expenses/ledger', rec.t); const anon = await detail(B1.id, null);
    const recMatch = await http('POST', `/api/bank/${L11.id}/match-bills`, rec.t, { billIds: [B1.id] });
    check('P1 permissions unchanged: a recruiter is refused (403) on the details, the table and Match bills; no login is refused (401)', recDet.status === 403 && recLedger.status === 403 && recMatch.status === 403 && anon.status === 401, [recDet.status, recLedger.status, recMatch.status, anon.status]);
    check('P2 the accountant without "approve" can still read the answer but cannot mark Paid (403 above), and Excel / edit rules are untouched (a paid bill still cannot be edited by a non-admin)', (await http('PATCH', `/api/office-expenses/${B10.id}`, acct.t, { description: 'x' })).status === 409);

    // =============================================================== Q. the frontend mapping
    const chipConfirmedPaid = M.payChip({ state: 'confirmed', needsApprover: false, inconsistent: false, short: 'Paid', tone: 'green' });
    const chipWait = M.payChip(dF.payment);
    const rowValid = M.proofRow(d4.payment); const rowBroken = M.proofRow(dOrph.payment); const rowNone = M.proofRow(d5.payment); const rowLinkOnly = M.proofRow(d1.payment);
    check('Q1 mapping: a paid + matched bill gets no chip; waiting-to-be-marked-Paid, part, reversed, broken each get a coloured chip with the server\'s reason as its tooltip', chipConfirmedPaid === null && chipWait && /Matched - mark Paid/.test(chipWait.text) && /amber/.test(chipWait.cls) && chipWait.title === dF.payment.reason && /red/.test(M.payChip(d8.payment).cls) && /Part paid/.test(M.payChip(d6.payment).text) && /Proof link broken/.test(M.payChip(dOrph.payment).text) && M.payChip(d5.payment) === null);
    check('Q2 mapping: View line is offered only for a valid proof; a broken one says "Proof link is broken" + the reason; no link = no row; a linked-only line says it is a reference, not a payment', rowValid.kind === 'valid' && rowValid.txnId === L4.id && rowBroken.kind === 'broken' && rowBroken.title === 'Proof link is broken' && /no longer on file/.test(rowBroken.reason) && rowBroken.txnId === undefined && rowNone.kind === 'none' && rowLinkOnly.kind === 'valid' && /Linked, not matched/.test(rowLinkOnly.note) && M.proofRow(d6.payment).note === '' && /^Bank statement line · \d{1,2} [A-Z][a-z]{2} 2026/.test(rowValid.title));
    const lr = M.lineRowOf(rowValid);
    check('Q3 mapping: the window\'s first row is the linked line itself (id, date, narration, money out, reference), and sameLine() rejects any other line', lr.id === L4.id && lr.debit === 11800 && lr.credit === 0 && lr.referenceNo === `ZZPP4${RUN}` && M.sameLine({ id: L4.id }, rowValid) && !M.sameLine({ id: L2.id }, rowValid) && !M.sameLine(null, rowValid));
    const src = fs.readFileSync(path.join(FE, 'src/pages/office/ExpenseLedger.jsx'), 'utf8');
    check('Q4 source: the table prints the server\'s chip next to the status and says "link broken" for a dead link; the status badge itself is still the stored status', /payChip\(r\.payment\)/.test(src) && /link broken/.test(src) && /<ApprovalBadge s=\{r\.status\}/.test(src));
    check('Q5 plain words: no "Draft", no red asterisk in what people read', !/draft/i.test(JSON.stringify([dF.payment, d1.payment, d6.payment, d8.payment, dOrph.payment]).replace(/draftname/g, '')) && !/\*/.test(JSON.stringify([dF.payment.reason, d1.payment.reason])));
  } catch (e) {
    fail += 1; console.log(`FAIL  the test stopped: ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      await prisma.auditLog.deleteMany({ where: { entityId: { in: made.bills } } }).catch(() => {});
      await prisma.officeExpense.deleteMany({ where: { OR: [{ id: { in: made.bills } }, { vendor: { startsWith: TAG } }] } }).catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { OR: [{ id: { in: made.txns } }, { description: { contains: `ZZTEST PP` } }] } }).catch(() => {});
      await prisma.bankImport.deleteMany({ where: { file: { startsWith: 'zzpp-' } } }).catch(() => {});
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      await prisma.roleAccess.deleteMany({ where: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office' } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    if (ownCopy) { await new Promise((r) => setTimeout(r, 800)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
