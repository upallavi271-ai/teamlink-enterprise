#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "PENDING, BUT THERE IS PROOF" - every kind (Accounts, 2026-10-21) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/pending-with-proof-test.js                       makes its own VACUUM INTO copy of the real database (opened READ-ONLY), deletes it after
//   COPY_DB=C:/tmp/x.db node scripts/pending-with-proof-test.js   use a copy you made (never prisma/dev.db)
//   SNAPSHOT_DB=<a .db file> ...                                  ALSO run the scan + repair on a COPY of that database (e.g. an older backup that holds the founder's EXP-0070 case)
//
// Starts its OWN throw-away API process (port 4067, TEST_MODE=1) on the copy, adds ZZTEST fixtures to the COPY and proves, through
// the real routes and scripts, per kind:
//   O  office bills: proof + a matched full payment -> status moves (approver); not an approver -> link + "matched, mark Paid" (no silent Pending);
//      proof only (link not matched / part / reversed / bill file) -> stays Pending with the exact reason; no duplicate on repeat; persists across a new login
//   B  every way a line gets filed against a bill (Match bills, hand match in Auto-Reconcile) resolves the bill by the ONE helper
//   D  a bill + a bank-line bill for the same payment are LISTED, never deleted
//   I  client invoices: a bare proof never moves the status, says "Proof attached - payment not recorded yet"; part payment -> Partially Paid;
//      matched-not-posted bank credit says so; receipts recorded but total not updated is found and repaired
//   S  the repair script: dry run writes nothing; --apply moves only the WRONG ones; second run changes nothing; undo restores; refused on the real db
//   U  unrelated tables untouched    P  permissions    Q  the screens print the server's answer (source checks)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const sq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;

let copy = process.env.COPY_DB;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `pwp-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO ${sq(copy)}`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4067);
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
const IPS = require(path.join(BACK, 'src/utils/invoicePaymentState'));
const PW = require(path.join(BACK, 'src/utils/pendingWithProof'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const RUN = Date.now().toString(36);
const TAG = `ZZTEST PWP ${RUN}`;

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
function script(args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(BACK, 'scripts', 'pending-with-proof-repair.js'), ...args], { cwd: BACK, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 240000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const made = { users: [], banks: [], txns: [], bills: [], clients: [], invoices: [], audits: [] };
let server;

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwp-run-'));
  const CSV = path.join(tmpDir, 'review.csv');
  try {
    const noApprove = { view: true, create: true, edit: true, delete: false, approve: false, export: true, assign: false };
    const allFeatures = Object.fromEntries(['Expenses & Bills', 'Vendors', 'Expense Categories', 'Business Profile & Tax Portals', 'GST Reconciliation', 'Due Dates & Reminders'].map((f) => [f, noApprove]));
    await prisma.roleAccess.upsert({
      where: { role_product_moduleId: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office' } },
      create: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office', moduleEnabled: true, features: JSON.stringify(allFeatures) },
      update: { moduleEnabled: true, features: JSON.stringify(allFeatures) },
    });

    // ------------------------------------------------ the REAL data as it is (before any fixture): the scan, read-only
    const baseline = await PW.scanAll(prisma);
    const baseWrong = baseline.wrong.length;
    console.log(`INFO  scan of the database copy before any fixture: ${baseline.rows.length} listed, ${baseWrong} wrong, ${baseline.dupes.length} possible duplicates; office bills ${baseline.summary.officeBills}, invoices ${baseline.summary.invoices}`);
    check('S0 the scan runs on every kind and reports a count per kind (no table error)', baseline.summary.others.every((o) => !o.error) && baseline.summary.others.length >= 6, baseline.summary.others.filter((o) => o.error));

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const PWD = `Zz-${RUN}-${crypto.randomBytes(6).toString('hex')}`;
    const mkUser = async (tag, extra) => {
      const email = `zz-pwp-${tag}-${RUN}@example.test`;
      const u = await prisma.user.create({ data: { passwordHash: await bcrypt.hash(PWD, 4), name: `ZZTEST PWP ${tag} ${RUN}`, email, username: email, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, email, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const rec = await mkUser('rec', {});

    // ------------------------------------------------ fixtures (in the COPY)
    const bankA = await prisma.bankAccount.create({ data: { bank: `ZZTEST PWP Bank ${RUN}`, name: 'ZZTEST A', accNo: '777766665555', active: true } });
    made.banks.push(bankA.id);
    const line = async (o) => {
      const t = await prisma.bankTransaction.create({ data: { bankAccountId: bankA.id, reconStatus: 'Unmatched', type: 'Debit', date: '2026-10-05', description: `ZZTEST PWP line ${RUN}`, balance: null, ...o } });
      made.txns.push(t.id); return t;
    };
    let seq = 0;
    const bill = async (o = {}) => {
      seq += 1;
      const b = await prisma.officeExpense.create({
        data: {
          category: 'ZZTEST PWP Category', vendor: `${TAG} Vendor ${seq}`, expenseDate: '2026-10-05', monthlyAmount: 10000, gstAmount: 0, tdsAmount: 0, paidStatus: 'Unpaid', approvalStatus: 'PENDING', entryKind: 'expense', recurring: false, paymentMode: 'Bank Transfer', description: `${TAG} bill ${seq}`, createdById: admin.u.id, ...o,
        },
      });
      made.bills.push(b.id); return b;
    };
    const billNow = (id) => prisma.officeExpense.findUnique({ where: { id } });
    const ledgerRow = async (id, tok = admin.t) => {
      const b = await billNow(id);
      const r = await http('GET', `/api/office-expenses/ledger?pageSize=100&q=${encodeURIComponent(b.vendor)}`, tok);
      return ((r.body && r.body.rows) || []).find((x) => x.id === id) || null;
    };
    const filedAgainst = (txn, b, net = 10000) => prisma.bankTransaction.update({ where: { id: txn.id }, data: { category: b.category, categoryKind: 'expense', billLinks: JSON.stringify([{ id: b.id, approvalStatus: 'PENDING', paidStatus: 'Unpaid', paidAt: null, paidById: null, paymentDate: null, net }]) } });
    const auditCount = (id, action) => prisma.auditLog.count({ where: { entity: 'OfficeExpense', entityId: id, action } });

    const sdb = new DatabaseSync(copy, { readOnly: true });
    const UNRELATED = ['Candidate', 'Application', 'Employee', 'LeaveRequest', 'Attendance', 'PayrollRun', 'OfficeVendor', 'Asset', 'ExpenseCategory', 'HandLoan', 'HandLoanLink', 'PartnerPayout'];
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
    const notifBefore = await prisma.notification.count();

    // =============================================================== O. office bills
    // O-F  the founder's exact case, made the way the old flow made it: linked + the line says it is filed against the bill + still Pending
    const Lf = await line({ amount: 10000, reference: `ZZPWF${RUN}`, date: '2026-09-07' });
    const Bf = await bill({ bankTxnId: Lf.id, paymentDate: '2026-09-07' });
    await filedAgainst(Lf, Bf);
    // O-1 link only (line not filed against the bill)
    const L1 = await line({ amount: 10000, reference: `ZZPW1${RUN}` });
    const B1 = await bill({ bankTxnId: L1.id });
    // O-2 part: line covers only 4,000 of 10,000
    const L2 = await line({ amount: 4000, reference: `ZZPW2${RUN}` });
    const B2 = await bill({ bankTxnId: L2.id });
    await filedAgainst(L2, B2);
    // O-3 reversed: a later credit line reverses the line
    const L3 = await line({ amount: 10000, reference: `ZZPW3${RUN}` });
    const B3 = await bill({ bankTxnId: L3.id });
    await filedAgainst(L3, B3);
    const L3r = await line({ amount: 10000, type: 'Credit', reference: `ZZPW3R${RUN}`, reversalOfId: L3.id });
    // O-4 bill file only (the vendor's bill itself)
    const B4 = await bill({ proofName: 'vendor-bill.pdf', proofMime: 'application/pdf' });
    // O-5 set aside line
    const L5 = await line({ amount: 10000, reference: `ZZPW5${RUN}`, reconStatus: 'Ignored', excluded: true });
    const B5 = await bill({ bankTxnId: L5.id });
    await filedAgainst(L5, B5);
    // D  a bill + a bank-line bill for the same payment
    const Ld = await line({ amount: 12345, reference: `ZZPWD${RUN}`, date: '2026-10-06' });
    const Bd1 = await bill({ monthlyAmount: 12345, vendor: `${TAG} Dup Vendor`, expenseDate: '2026-10-04' });
    const Bd2 = await bill({ monthlyAmount: 12345, vendor: `${TAG} Dup Vendor`, expenseDate: '2026-10-06', approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: Ld.id, paymentDate: '2026-10-06', paidAt: new Date() });
    await prisma.bankTransaction.update({ where: { id: Ld.id }, data: { category: 'ZZTEST PWP Category', categoryKind: 'expense', createdBillId: Bd2.id } });

    const pF = (await ledgerRow(Bf.id));
    check('OF1 the founder case: bill is Pending with a bank line, and the table now SAYS why (matched, mark Paid) - not a bare Pending', pF && pF.status === 'PENDING' && pF.payment && pF.payment.state === 'confirmed' && pF.payment.needsApprover && /matched, mark Paid/.test(pF.payment.proof.text) && /7 Sep/.test(pF.payment.proof.text) && /10,000/.test(pF.payment.proof.text), pF && pF.payment);
    const p1 = await ledgerRow(B1.id); const p2 = await ledgerRow(B2.id); const p3 = await ledgerRow(B3.id); const p5 = await ledgerRow(B5.id);
    check('OP1 the Proof column text is explicit for every line state: linked-not-matched (different amount says so), part, reversed, set aside', /not matched yet/.test(p1.payment.proof.text) && /part \(₹4,000\.00 of ₹10,000\.00\)/.test(p2.payment.proof.text) && /reversed/.test(p3.payment.proof.text) && /set aside/.test(p5.payment.proof.text), [p1, p2, p3, p5].map((x) => x.payment.proof.text));

    // ---- the scan sorts them
    const sc = await PW.scanOfficeBills(prisma);
    const rowOf = (code) => sc.rows.find((r) => r.ref === code);
    check('OS1 scan: the founder case is WRONG (matched full payment, status never followed) and has a fix', rowOf(Bf.id) && rowOf(Bf.id).verdict === 'WRONG' && rowOf(Bf.id).fix && rowOf(Bf.id).proposedStatus === 'PAID', rowOf(Bf.id));
    check('OS2 scan: link-only, part, reversed, set-aside and a bill FILE are CORRECT pending with a reason, never WRONG', [B1, B2, B3, B4, B5].every((b) => rowOf(b.id) && rowOf(b.id).verdict === 'CORRECT' && rowOf(b.id).whyStillPending), [B1, B2, B3, B4, B5].map((b) => rowOf(b.id) && rowOf(b.id).verdict));
    check('OS3 a bare bill FILE on a Pending bill never makes it Paid (its reason says the file is the bill itself)', /vendor bill/.test(rowOf(B4.id).whyStillPending) && (await billNow(B4.id)).approvalStatus === 'PENDING');
    const dupPair = sc.dupes.find((d) => d.pending.id === Bd1.id && d.paidFromLine.id === Bd2.id);
    check('D1 the same payment entered twice (a Pending bill + the bill filed from the bank line, same amount and vendor) is LISTED for a person', !!dupPair);
    check('D2 nothing was deleted or changed by listing it', !!(await billNow(Bd1.id)) && !!(await billNow(Bd2.id)) && (await billNow(Bd1.id)).approvalStatus === 'PENDING');

    // ---- B. the ways a line is filed against a bill
    // Match bills, approver
    const La = await line({ amount: 10000, reference: `ZZPWA${RUN}` });
    const Ba = await bill();
    const ma = await http('POST', `/api/bank/${La.id}/match-bills`, admin.t, { billIds: [Ba.id] });
    const ra = await ledgerRow(Ba.id);
    check('B1 Match bills by an APPROVER: the covered bill becomes Paid at once, proof text says matched, one audit line', ma.status === 200 && ra.status === 'PAID' && /matched$/.test(ra.payment.proof.text) && (await auditCount(Ba.id, 'Office expense status: Paid')) === 1, [ma.status, ra && ra.status, ra && ra.payment && ra.payment.proof.text]);
    const ma2 = await http('POST', `/api/bank/${La.id}/match-bills`, admin.t, { billIds: [Ba.id] });
    check('B2 repeating the same match changes nothing: refused, still one audit line, one link', ma2.status >= 400 && (await auditCount(Ba.id, 'Office expense status: Paid')) === 1 && (await prisma.officeExpense.count({ where: { bankTxnId: La.id } })) === 1, ma2.status);
    // Match bills, non-approver
    const Lb = await line({ amount: 10000, reference: `ZZPWB${RUN}` });
    const Bb = await bill();
    const mb = await http('POST', `/api/bank/${Lb.id}/match-bills`, acct.t, { billIds: [Bb.id] });
    const rb = await ledgerRow(Bb.id);
    check('B3 Match bills by a NON-approver: linked, stays Pending and says "matched, mark Paid" (never a silent Pending)', mb.status === 200 && rb.status === 'PENDING' && rb.payment.needsApprover && /mark Paid/.test(rb.payment.proof.text), [mb.status, rb && rb.status]);
    const mk = await http('PATCH', `/api/office-expenses/${Bb.id}/status`, admin.t, { action: 'mark_paid' });
    const mkr = await http('PATCH', `/api/office-expenses/${Bb.id}/status`, acct.t, { action: 'mark_paid' });
    check('B4 only an approver can finish it: the accountant without "approve" gets 403, the admin marks it Paid', mkr.status === 403 && mk.status === 200 && (await billNow(Bb.id)).approvalStatus === 'PAID', [mkr.status, mk.status]);
    // Auto-Reconcile hand match on a PENDING bill (used to refuse: "Approve the bill first")
    const Lc = await line({ amount: 10000, reference: `ZZPWC${RUN}` });
    const Bc = await bill();
    const open = await http('GET', `/api/bank/auto/open-bills?q=${encodeURIComponent(Bc.vendor)}`, admin.t);
    const mc = await http('POST', `/api/bank/auto/txn/${Lc.id}/manual`, admin.t, { billId: Bc.id });
    check('B5 Auto-Reconcile hand match of a Pending bill by an approver: the list offers it (canLink), and the bill becomes Paid by the same helper', open.status === 200 && (open.body.rows || []).some((r) => r.id === Bc.id && r.canLink) && mc.status === 200 && (await billNow(Bc.id)).approvalStatus === 'PAID', [open.status, mc.status, mc.text.slice(0, 200)]);
    const Ld2 = await line({ amount: 10000, reference: `ZZPWE${RUN}` });
    const Be = await bill();
    const me = await http('POST', `/api/bank/auto/txn/${Ld2.id}/manual`, acct.t, { billId: Be.id });
    const re = await ledgerRow(Be.id);
    check('B6 the same hand match by a NON-approver links it and leaves it Pending with the reason (no payment by a link alone)', me.status === 200 && re.status === 'PENDING' && re.payment.needsApprover, [me.status, re && re.status]);
    // rejected bill cannot be paid by a line
    const Lg = await line({ amount: 10000, reference: `ZZPWG${RUN}` });
    const Bg = await bill({ approvalStatus: 'REJECTED' });
    const mg = await http('POST', `/api/bank/auto/txn/${Lg.id}/manual`, admin.t, { billId: Bg.id });
    check('B7 a REJECTED bill is never paid by a bank line', mg.status >= 400 && (await billNow(Bg.id)).approvalStatus === 'REJECTED', mg.status);
    // persisted across a fresh login
    const login = await http('POST', '/api/auth/login', null, { email: admin.email, password: PWD });
    const tok2 = login.body && (login.body.token || login.body.accessToken);
    const ra2 = tok2 ? await ledgerRow(Ba.id, tok2) : null;
    check('R1 the status survives a refresh and a brand-new login (stored, not computed on the page)', !!tok2 && ra2 && ra2.status === 'PAID' && ra2.payment.proof.text === ra.payment.proof.text, [!!tok2, ra2 && ra2.status]);

    // =============================================================== S. the repair script on the copy
    const fpMid = fingerprint();
    const dry = script(['--db', copy, '--csv', CSV, '--out', path.join(tmpDir, 'o1')]);
    const csvText = fs.existsSync(CSV) ? fs.readFileSync(CSV, 'utf8') : '';
    check('S1 dry run (the default) writes only the review file: bills are unchanged, the file lists the WRONG one and the CORRECT ones with reasons', dry.code === 0 && /DRY RUN/.test(dry.out) && (await billNow(Bf.id)).approvalStatus === 'PENDING' && csvText.includes('WRONG status') && csvText.includes('CORRECT pending') && /Possible duplicate/.test(csvText) && csvText.split('\n')[0].replace('\ufeff', '') === PW.COLUMNS.join(','), dry.out.slice(-400));
    const refused = script(['--apply'], { TL_ALLOW_REAL_APPLY: '' });
    check('S2 --apply on the REAL database is refused without --really-real and TL_ALLOW_REAL_APPLY=1', refused.code === 2 && /REFUSED/.test(refused.out));
    const appl = script(['--db', copy, '--apply', '--csv', CSV, '--out', path.join(tmpDir, 'o2'), '--backup-dir', path.join(tmpDir, 'bk')]);
    const BfN = await billNow(Bf.id);
    const left = [B1, B2, B3, B4, B5, Bd1].map((b) => b.id);
    const leftNow = await prisma.officeExpense.findMany({ where: { id: { in: left } } });
    check('S3 --apply moves the founder case to Paid (date = the bank line\'s own date, one audit line) and touches NONE of the CORRECT ones', appl.code === 0 && BfN.approvalStatus === 'PAID' && BfN.paidStatus === 'Paid' && BfN.paymentDate === '2026-09-07' && (await auditCount(Bf.id, 'Office expense status: Paid')) === 1 && leftNow.every((b) => b.approvalStatus === 'PENDING'), [appl.code, BfN.approvalStatus, appl.out.slice(-300)]);
    check('S4 a backup file and an undo manifest were written first', fs.existsSync(path.join(tmpDir, 'bk', 'dev.db')) && fs.existsSync(path.join(tmpDir, 'o2', 'undo-manifest.json')));
    const manifestPath = path.join(tmpDir, 'o2', 'undo-manifest.json');
    const appl2 = script(['--db', copy, '--apply', '--csv', CSV, '--out', path.join(tmpDir, 'o3'), '--backup-dir', path.join(tmpDir, 'bk3')]);
    check('S5 running it a second time changes nothing (idempotent): no new audit line, "NOTHING TO DO"', appl2.code === 0 && /NOTHING TO DO/.test(appl2.out) && (await auditCount(Bf.id, 'Office expense status: Paid')) === 1, appl2.out.slice(-200));
    check('S6 no notification was created by the script', (await prisma.notification.count()) === notifBefore);
    const und = script(['--db', copy, '--undo', manifestPath, '--out', path.join(tmpDir, 'o4'), '--backup-dir', path.join(tmpDir, 'bk4')]);
    const BfU = await billNow(Bf.id);
    check('S7 undo puts the bill back exactly as it was (Pending, no payment mark) and removes the audit line', und.code === 0 && BfU.approvalStatus === 'PENDING' && BfU.paidStatus === 'Unpaid' && (await auditCount(Bf.id, 'Office expense status: Paid')) === 0, [und.code, BfU.approvalStatus, und.out.slice(-200)]);
    const appl3 = script(['--db', copy, '--apply', '--csv', CSV, '--out', path.join(tmpDir, 'o5'), '--backup-dir', path.join(tmpDir, 'bk5')]);
    check('S8 applying again after an undo works again (one transaction, one audit line)', appl3.code === 0 && (await billNow(Bf.id)).approvalStatus === 'PAID' && (await auditCount(Bf.id, 'Office expense status: Paid')) === 1);
    const rF = await ledgerRow(Bf.id);
    check('S9 after the repair the table shows Paid with "matched" (no chip left to explain)', rF.status === 'PAID' && /matched$/.test(rF.payment.proof.text) && rF.payment.needsApprover === false, rF && rF.payment);

    // =============================================================== I. client invoices
    const client = await prisma.client.create({ data: { name: `ZZTEST PWP client ${RUN}`, ownerDepartment: 'Medical', gstPercent: 0, tdsPercent: 0 } });
    made.clients.push(client.id);
    const mkInv = async (no, amount) => { const i = await prisma.invoice.create({ data: { clientId: client.id, invoiceNumber: no, amount, gst: 0, tds: 0, invoiceDate: '2026-09-01', dueDate: '2099-09-30', status: 'Pending' } }); made.invoices.push(i.id); return i; };
    const invRow = async (id, tok = admin.t) => ((await http('GET', '/api/invoices/register?period=all', tok)).body.rows || []).find((x) => x.id === id);
    const invNow = (id) => prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
    const I1 = await mkInv(`ZZPW-${RUN}-1`, 50000);
    const proofUrl = `/api/dashboard/accounts/control/proof/invoice/${I1.id}`;
    const up1 = await http('POST', proofUrl, admin.t, { reference: `UTR${RUN}` });
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'ZZPW-proof.pdf');
    fd.append('reference', `UTR${RUN}`);
    const up2 = await http('POST', proofUrl, admin.t, fd);
    const up3 = await http('POST', proofUrl, admin.t, { reference: `UTR${RUN}` });
    const r1 = await invRow(I1.id); const i1 = await invNow(I1.id);
    check('I1 a proof (UTR + file) attached to an invoice with NO receipt: status stays Pending, received 0, no payment row created (a bare proof never moves money)', up1.status === 200 && up3.status === 200 && i1.status === 'Pending' && i1.receivedAmount === 0 && i1.payments.length === 0, [up1.status, up2.status, i1.status, i1.receivedAmount]);
    check('I2 the invoice says exactly why: "Proof attached - payment not recorded yet", with the one-click Record payment prefilled (balance + the proof\'s UTR)', r1.payState && r1.payState.state === 'proof_only' && r1.payState.short === 'Proof attached - payment not recorded yet' && r1.payState.action && r1.payState.action.amount === 50000 && r1.payState.action.reference === `UTR${RUN}` && r1.status === 'Pending' && r1.pending === 50000, r1.payState);
    const d1 = await http('GET', `/api/invoices/${I1.id}`, admin.t);
    check('I3 the invoice DETAILS carry the same answer as the list', d1.status === 200 && d1.body.payState && d1.body.payState.state === 'proof_only' && d1.body.payState.reason === r1.payState.reason, d1.body && d1.body.payState);
    const sci = await PW.scanInvoices(prisma);
    check('I4 scan: it is listed CORRECT pending (proof only), never WRONG', sci.rows.some((r) => r.ref === I1.id && r.verdict === 'CORRECT' && /Proof is attached/.test(r.whyStillPending)) && !sci.rows.some((r) => r.ref === I1.id && r.verdict === 'WRONG'));
    // part payment
    const pay1 = await http('POST', `/api/invoices/${I1.id}/payments`, admin.t, { amount: 20000, date: '2026-09-20', method: 'Bank Transfer', reference: `UTR${RUN}` });
    const r1b = await invRow(I1.id);
    check('I5 a recorded part payment -> Partially Paid with the right balance (30,000), shown as "Part paid"', pay1.status < 300 && r1b.status === 'Partially Paid' && r1b.pending === 30000 && r1b.payState.state === 'part', [pay1.status, r1b.status, r1b.pending]);
    const pay2 = await http('POST', `/api/invoices/${I1.id}/payments`, admin.t, { amount: 30000, date: '2026-09-25', method: 'Bank Transfer', reference: `UTR2${RUN}` });
    const r1c = await invRow(I1.id);
    check('I6 the rest recorded -> Paid, balance 0, payState Paid; two receipts only (no duplicates)', pay2.status < 300 && r1c.status === 'Paid' && r1c.pending === 0 && r1c.payState.state === 'paid' && (await invNow(I1.id)).payments.length === 2, [pay2.status, r1c.status]);
    const over = await http('POST', `/api/invoices/${I1.id}/payments`, admin.t, { amount: 100, date: '2026-09-26' });
    check('I7 nothing more can be recorded on a settled invoice (no double payment)', over.status >= 400 && (await invNow(I1.id)).payments.length === 2, over.status);
    // matched but not posted
    const I2 = await mkInv(`ZZPW-${RUN}-2`, 30000);
    const Lcr = await line({ type: 'Credit', amount: 30000, reference: `ZZPWCR${RUN}`, description: `ZZTEST PWP NEFT CR ${RUN}` });
    const mt = await http('POST', `/api/bank/${Lcr.id}/match`, admin.t, { invoiceId: I2.id });
    const r2 = await invRow(I2.id);
    check('I8 a bank credit that is MATCHED to the invoice but not posted: invoice stays Pending and says "Bank credit matched - receipt not posted yet"', mt.status === 200 && r2.status === 'Pending' && r2.payState.state === 'matched' && /Reconcile/.test(r2.payState.reason), [mt.status, r2.status, r2.payState]);
    const rc = await http('POST', `/api/bank/${Lcr.id}/reconcile`, admin.t, {});
    const r2b = await invRow(I2.id);
    check('I9 reconciling (the receipt is posted) moves the invoice to Paid and the note disappears', rc.status === 200 && r2b.status === 'Paid' && r2b.payState.state === 'paid', [rc.status, r2b.status, rc.text.slice(0, 160)]);
    // receipts recorded but total not updated (the wrong state the repair fixes)
    const I3 = await mkInv(`ZZPW-${RUN}-3`, 40000);
    await prisma.invoicePayment.create({ data: { invoiceId: I3.id, date: '2026-09-15', amount: 40000, method: 'Bank Transfer', reference: `ZZRC${RUN}` } });
    const r3 = await invRow(I3.id);
    check('I10 receipts recorded but the invoice total not updated: found as "Receipts recorded - total not updated" (not a bare Pending)', r3.status === 'Pending' && r3.payState.state === 'unrecorded', r3.payState);
    const sci3 = await PW.scanInvoices(prisma);
    check('I11 scan: that invoice is WRONG (fixable), and proof-only / part ones are not', sci3.rows.filter((r) => r.verdict === 'WRONG').map((r) => r.ref).includes(I3.id) && !sci3.rows.filter((r) => r.verdict === 'WRONG').map((r) => r.ref).includes(I1.id));
    const ap4 = script(['--db', copy, '--apply', '--csv', CSV, '--out', path.join(tmpDir, 'o6'), '--backup-dir', path.join(tmpDir, 'bk6')]);
    const i3n = await invNow(I3.id);
    check('I12 repair: receivedAmount = the receipts (40,000), status re-derived to Paid, paid date = the last receipt, one audit line', ap4.code === 0 && i3n.receivedAmount === 40000 && i3n.status === 'Paid' && i3n.paidDate === '2026-09-15' && (await prisma.auditLog.count({ where: { entity: 'Invoice', entityId: I3.id, action: 'Invoice received total repaired' } })) === 1, [ap4.code, i3n.receivedAmount, i3n.status, ap4.out.slice(-300)]);
    const ap5 = script(['--db', copy, '--apply', '--csv', CSV, '--out', path.join(tmpDir, 'o7'), '--backup-dir', path.join(tmpDir, 'bk7')]);
    check('I13 second run: nothing to do', /NOTHING TO DO/.test(ap5.out) && (await invNow(I3.id)).receivedAmount === 40000);
    const und2 = script(['--db', copy, '--undo', path.join(tmpDir, 'o6', 'undo-manifest.json'), '--out', path.join(tmpDir, 'o8'), '--backup-dir', path.join(tmpDir, 'bk8')]);
    const i3u = await invNow(I3.id);
    check('I14 undo of the invoice repair restores the old received total and status', und2.code === 0 && i3u.receivedAmount === 0 && i3u.status === 'Pending', [und2.code, i3u.receivedAmount, i3u.status]);
    // the proof-only and part invoices were untouched by every script run
    check('I15 the invoices that carry only proof / part payment were not touched by any script run', (await invNow(I1.id)).receivedAmount === 50000 && (await invNow(I1.id)).payments.length === 2);

    // =============================================================== U / P / Q
    const fpAfter = fingerprint();
    check('U1 unrelated tables are byte-for-byte unchanged by everything above (row counts + checksums)', UNRELATED.every((t) => fpMid[t] === fpAfter[t] && unrelatedBefore[t] === fpAfter[t]), UNRELATED.filter((t) => unrelatedBefore[t] !== fpAfter[t]));
    const recDet = await http('GET', '/api/invoices/register?period=all', rec.t); const recMatch = await http('POST', `/api/bank/${La.id}/match-bills`, rec.t, { billIds: [Bb.id] });
    const recProof = await http('POST', proofUrl, rec.t, { reference: 'x' }); const anon = await http('GET', '/api/invoices/register?period=all', null);
    const acctProof = await http('POST', `/api/dashboard/accounts/control/proof/invoice/${I3.id}`, acct.t, { reference: `A${RUN}` });
    check('P1 permissions unchanged: a recruiter is refused (403) on the invoices, Match bills and Attach proof; no login is refused (401); an accountant may attach proof but still cannot mark a bill Paid (B4)', recDet.status === 403 && recMatch.status === 403 && recProof.status === 403 && anon.status === 401 && acctProof.status === 200, [recDet.status, recMatch.status, recProof.status, anon.status, acctProof.status]);
    const read = (p) => fs.readFileSync(path.join(FE, 'src', p), 'utf8');
    check('Q1 the ledger prints the server\'s proof text (date, amount, matched or not) - no bare "bank line"', /payment\.proof\.text/.test(read('pages/office/ExpenseLedger.jsx')) && !/>bank line<\/span>/.test(read('pages/office/ExpenseLedger.jsx')));
    check('Q2 the invoice list prints the server\'s note beside the status; the details have a Record payment button prefilled from the proof; the payment window carries the UTR over', /g\.payNote/.test(read('pages/invoices/ClientInvoiceRows.jsx')) && /payState\.needsRecord/.test(read('pages/InvoiceDetail.jsx')) && /proofRef/.test(read('pages/invoices/PaymentModal.jsx')));
    check('Q3 plain words: no "Draft", no red asterisk in what people read', !/draft/i.test(JSON.stringify([pF.payment, r1.payState, r2.payState, r3.payState])) && !/\*/.test(JSON.stringify([pF.payment.reason, r1.payState.reason])));

    // =============================================================== X. an older database that holds the founder's own case (optional)
    if (process.env.SNAPSHOT_DB && fs.existsSync(process.env.SNAPSHOT_DB)) {
      const snap = path.join(tmpDir, 'snapshot.db');
      const s0 = new DatabaseSync(process.env.SNAPSHOT_DB, { readOnly: true }); s0.exec(`VACUUM INTO ${sq(snap)}`); s0.close();
      const dryS = script(['--db', snap, '--csv', path.join(tmpDir, 'snap.csv'), '--out', path.join(tmpDir, 's1')]);
      const dryCsv = fs.readFileSync(path.join(tmpDir, 'snap.csv'), 'utf8');
      const applS = script(['--db', snap, '--apply', '--csv', path.join(tmpDir, 'snap.csv'), '--out', path.join(tmpDir, 's2'), '--backup-dir', path.join(tmpDir, 'sb')]);
      const chk = new DatabaseSync(snap, { readOnly: true });
      const ex = chk.prepare("SELECT approvalStatus, paymentDate FROM OfficeExpense WHERE expenseCode='EXP-0070'").get();
      const again = script(['--db', snap, '--apply', '--csv', path.join(tmpDir, 'snap.csv'), '--out', path.join(tmpDir, 's3'), '--backup-dir', path.join(tmpDir, 'sb3')]);
      chk.close();
      check('X1 on the older database copy: EXP-0070 (matched bank line, shown Pending) is listed WRONG, --apply makes it Paid on 2026-09-07, a second run has nothing to do', dryS.code === 0 && /EXP-0070.*WRONG status/.test(dryCsv) && applS.code === 0 && ex && ex.approvalStatus === 'PAID' && ex.paymentDate === '2026-09-07' && /NOTHING TO DO/.test(again.out), [dryS.out.slice(-300), applS.out.slice(-300), ex]);
    }
  } catch (e) {
    fail += 1; console.log(`FAIL  the test stopped: ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...made.bills, ...made.invoices] } }, { entityId: { in: made.txns } }] } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { action: { in: ['Proof reference added', 'Invoice received total repaired'] }, createdAt: { gte: new Date(Date.now() - 3 * 3600 * 1000) } } }).catch(() => {});
      await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: made.invoices } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.officeExpense.deleteMany({ where: { OR: [{ id: { in: made.bills } }, { vendor: { startsWith: TAG } }] } }).catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { OR: [{ id: { in: made.txns } }, { description: { contains: 'ZZTEST PWP' } }] } }).catch(() => {});
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      await prisma.roleAccess.deleteMany({ where: { role: 'ACCOUNTANT', product: 'accounts', moduleId: 'accounts_office' } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (ownCopy) { await new Promise((r) => setTimeout(r, 800)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
