#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BANK STATEMENT DUPLICATE DETECTION + SELECTIVE IMPORT (Accounts, 2026-10-19) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/bank-statement-duplicates-test.js                          makes its own VACUUM INTO copy of the real database
//                                                                           (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/stmt-copy.db node scripts/bank-statement-duplicates-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (a free port 4050-4098, TEST_MODE=1) on the copy, creates ZZTEST bank accounts / lines,
// builds real .csv and .xlsx files in memory, uploads them through the real endpoints and proves:
//   F  the founder's example: 30 uploaded, 26 already on file, 4 new -> 30 / 26 / 4 / newly imported 4 / failed 0, the 26 untouched
//   I  a repeat of the same file, and the same rows under another file name: everything Already Imported, import adds nothing
//   R  the rules: same amount + same day + different narration = both new; credit vs debit; other bank account; a different UTR;
//      UTR match with other wording = strong match; text normalisation; missing UTR on one side = Needs Review; same reference on
//      another date = Needs Review; legacy lines without keys are found and then get keys
//   U  the same row twice in one file (Duplicate in Current Upload), "Import this one anyway" for a genuine twin (recorded)
//   S  Needs Review is never imported / skipped by itself; the person's choice (import / leave out) is honoured
//   C  simultaneous confirms (3 at once on one batch, 3 uploads of one file) save each line once; the unique index refuses a raw duplicate
//   X  a failure on one line: that line Failed with its reason, the others imported; Retry failed imports only it, once
//   W  a preview writes no bank line; the stored batch is what is imported (a tampered body changes nothing); a stale preview is re-checked
//   P  permissions (403 / 401), unreadable rows, the old one-step doors (POST /bank/import, /accounts-import/commit)
//   H  history: batch / row / import / audit records; the old lines, other tables and the matching of new lines
//   L  the screen's pure logic (frontend/src/pages/bank/stmtStatus.js, bundled with esbuild)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');

let copy = process.env.COPY_DB;
let ownCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `stmt-dup-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const RUN = Date.now().toString(36);
let API = '';
const facts = {};

async function freePort() {
  for (let i = 0; i < 60; i += 1) {
    const p = 4050 + Math.floor(Math.random() * 49);
    if (p === 4010 || p === 4045) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error('no free port');
}

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body; else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

// ---- statement files (real .csv and .xlsx) -----------------------------------------------------------
const HEAD = ['Date', 'Narration', 'Reference No', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'];
// row: { d: 'YYYY-MM-DD', n: narration, r: reference, dr, cr, b: balance }
const grid = (rows, { balance = true, ref = true } = {}) => {
  const head = HEAD.filter((h) => (balance || h !== 'Closing Balance') && (ref || h !== 'Reference No'));
  return [head, ...rows.map((x) => head.map((h) => ({
    Date: x.d, Narration: x.n, 'Reference No': x.r || '', 'Withdrawal Amt': x.dr == null ? '' : x.dr, 'Deposit Amt': x.cr == null ? '' : x.cr, 'Closing Balance': x.b == null ? '' : x.b,
  }[h])))];
};
const csvBuf = (rows, o) => {
  const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return Buffer.from(`${grid(rows, o).map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`, 'utf8');
};
const xlsxBuf = (rows, o) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid(rows, o)), 'Statement');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const form = (buf, name, fields = {}) => {
  const fd = new FormData();
  fd.append('kind', 'bank');
  Object.entries(fields).forEach(([k, v]) => fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)));
  fd.append('file', new Blob([buf]), name);
  return fd;
};

// 30 distinct transactions of one statement
const tagNo = (tag) => [...tag].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 9973;
function thirty(tag) {
  const rows = [];
  const k = tagNo(tag);
  let bal = 500000 + k * 13;
  for (let i = 0; i < 30; i += 1) {
    const credit = i % 3 === 0;
    const amt = 1000 + i * 37 + (i % 4) * 0.5 + k * 0.01 * (i + 1);
    const amt2 = Math.round(amt * 100) / 100;
    bal = Math.round((bal + (credit ? amt2 : -amt2)) * 100) / 100;
    rows.push({
      d: `2026-09-${String(1 + ((i + k) % 27)).padStart(2, '0')}`, n: `ZZTEST ${tag} UPI/${400000000000 + k * 1000003 + i * 7919}/PARTY ${tag}${i}`, r: i % 2 ? `UTR${tag}${k}${700000 + i}` : '', dr: credit ? null : amt2, cr: credit ? amt2 : null, b: bal,
    });
  }
  return rows;
}

const made = { users: [], banks: [], clients: [], invoices: [], rules: [] };
let dbx; // a second, raw connection to the COPY (for DB-level proofs and failure injection)

(async () => {
  let server;
  try {
    const port = await freePort();
    API = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    dbx = new DatabaseSync(copy);
    dbx.exec('PRAGMA busy_timeout = 30000');

    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST SD ${tag} `, email: `zz-sd-${tag}-${RUN}@example.test`, username: `zz-sd-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const rec = await mkUser('rec', {});
    const T = admin.t;

    const bankA = await prisma.bankAccount.create({ data: { bank: `ZZTEST Bank A `, name: 'ZZTEST A', accNo: '999988887771', active: true } });
    const bankB = await prisma.bankAccount.create({ data: { bank: `ZZTEST Bank B `, name: 'ZZTEST B', accNo: '999988887772', active: true } });
    made.banks.push(bankA.id, bankB.id);
    const A = bankA.id; const B = bankB.id;
    const count = (acc) => prisma.bankTransaction.count({ where: { bankAccountId: acc } });
    const allCount = () => prisma.bankTransaction.count();
    const q = (sql, ...a) => dbx.prepare(sql).all(...a);

    // ---- helpers over the real endpoints
    const preview = async (buf, name, acc, tok = T) => {
      const r = await http('POST', '/api/accounts-import/preview', tok, form(buf, name, acc ? { bankAccountId: acc } : {}));
      const stmt = r.body && r.body.summary && r.body.summary.stmt;
      return { ...r, batchId: stmt && stmt.batchId, counts: stmt && stmt.counts, summary: r.body && r.body.summary };
    };
    const rowsOf = async (batchId, filter = '', tok = T) => (await http('GET', `/api/accounts-import/bank-batch/${batchId}/rows?limit=200${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`, tok)).body;
    const importNew = (batchId, acc, tok = T, extra = {}) => http('POST', `/api/accounts-import/bank-batch/${batchId}/import`, tok, { bankAccountId: acc, ...extra });
    const retry = (batchId, acc, tok = T) => http('POST', `/api/accounts-import/bank-batch/${batchId}/retry`, tok, { bankAccountId: acc });
    const plan = (batchId, decisions, tok = T) => http('POST', `/api/accounts-import/bank-batch/${batchId}/plan`, tok, { decisions });
    const rowByLine = async (batchId, narrPart) => (await rowsOf(batchId)).rows.find((x) => String(x.description).includes(narrPart));
    const keyCount = (txnId) => q('SELECT COUNT(*) AS n FROM "BankTxnKey" WHERE "txnId" = ?', txnId)[0].n;

    // ================================================================================================
    // F. THE FOUNDER'S EXAMPLE: 30 rows, 26 already there, 4 new
    // ================================================================================================
    const rows30 = thirty('F');
    const first26 = rows30.slice(0, 26);
    const before0 = await allCount();

    const pv26 = await preview(csvBuf(first26), 'statement-first-26.csv', A);
    check('F1 an earlier statement of 26 lines: preview shows 26 uploaded, all Not Imported, nothing else', pv26.status === 200 && pv26.counts.total === 26 && pv26.counts.notImported === 26 && pv26.counts.alreadyImported === 0 && pv26.counts.failed === 0, pv26.counts);
    check('W1 the preview wrote no bank line (row count before = after)', (await allCount()) === before0);
    const im26 = await importNew(pv26.batchId, A);
    check('F2 ... Import New Transactions saves all 26 (newly imported 26, failed 0)', im26.status === 201 && im26.body.stmt.newlyImported === 26 && im26.body.stmt.failed === 0 && (await count(A)) === 26, im26.body && im26.body.stmt);
    const imp26 = im26.body.batch;
    const snap = async () => JSON.stringify((await prisma.bankTransaction.findMany({ where: { bankAccountId: A }, orderBy: { id: 'asc' } })));
    const snap26 = await snap();
    const checksumsBefore = {};
    for (const t of ['Invoice', 'InvoicePayment', 'Client', 'HandLoan', 'HandLoanLink', 'BankRule', 'BankMark', 'OfficeExpense', 'JournalEntry']) {
      checksumsBefore[t] = JSON.stringify(q(`SELECT * FROM "${t}" ORDER BY "id"`));
    }

    // the 30-line statement (an .xlsx, a different file name): 26 of its lines are already on file
    const x30 = xlsxBuf(rows30);
    const total0 = await allCount();
    const pv30 = await preview(x30, 'statement-all-30.xlsx', A);
    check('F3 upload 30 records (26 on file, 4 new): Total Statements 30, Already Imported 26, Not Imported 4, Duplicate in Current Upload 0, Needs Review 0, Newly Imported 0, Failed 0',
      pv30.counts.total === 30 && pv30.counts.alreadyImported === 26 && pv30.counts.notImported === 4 && pv30.counts.duplicateInUpload === 0 && pv30.counts.needsReview === 0 && pv30.counts.newlyImported === 0 && pv30.counts.failed === 0, pv30.counts);
    check('F4 the preview response carries the same numbers for the old summary fields (26 skipped, 4 new)', pv30.summary.duplicates === 26 && pv30.summary.newLines === 4 && pv30.summary.alreadyImported === 26, pv30.summary);
    check('W2 the preview of the 30-line file wrote no bank line', (await allCount()) === total0);
    const al = await rowsOf(pv30.batchId, 'Already Imported');
    const ni = await rowsOf(pv30.batchId, 'Not Imported');
    check('F5 the list: 26 rows say Already Imported (with the file they came from), 4 say Not Imported', al.total === 26 && ni.total === 4 && al.rows.every((x) => x.display === 'Already Imported' && x.match && x.match.file === 'statement-first-26.csv') && ni.rows.every((x) => x.display === 'Not Imported'), [al.total, ni.total, al.rows[0]]);
    const im30 = await importNew(pv30.batchId, A);
    check('F6 Import New Transactions: newly imported 4, failed 0, total transactions +4', im30.status === 201 && im30.body.imported === 4 && im30.body.stmt.newlyImported === 4 && im30.body.stmt.failed === 0 && (await allCount()) === total0 + 4, im30.body && [im30.status, im30.body.imported, im30.body.stmt]);
    check('F7 after the import the counts refresh: Already Imported 26, Not Imported 0, Newly Imported 4, Failed 0 (still 30 in all)', im30.body.stmt.total === 30 && im30.body.stmt.alreadyImported === 26 && im30.body.stmt.notImported === 0 && im30.body.stmt.newlyImported === 4, im30.body.stmt);
    const fresh4 = await rowsOf(pv30.batchId, 'Imported');
    check('F8 the 4 rows now show Imported, each tied to its saved bank line', fresh4.total === 4 && fresh4.rows.every((x) => x.display === 'Imported' && x.txnId), fresh4.rows[0]);
    const after = JSON.stringify((await prisma.bankTransaction.findMany({ where: { importBatch: imp26 }, orderBy: { id: 'asc' } })));
    const only26 = JSON.stringify((await prisma.bankTransaction.findMany({ where: { id: { in: JSON.parse(snap26).map((x) => x.id) } }, orderBy: { id: 'asc' } })));
    check('F9 the 26 lines that were already on file are untouched, field for field', only26 === snap26 && after.length > 0, 'changed');
    check('F10 the summary asked for: total uploaded 30, already imported 26, new eligible 4, imported 4, failed 0, needing review 0',
      im30.body.summary.total === 30 && im30.body.summary.alreadyImported === 26 && im30.body.summary.eligible === 4 && im30.body.summary.newlyImported === 4 && im30.body.summary.failed === 0 && im30.body.summary.rowsToReview === 0, im30.body.summary);

    // ================================================================================================
    // I. SAME FILE AGAIN / SAME ROWS UNDER ANOTHER NAME
    // ================================================================================================
    const total1 = await allCount();
    const impRows1 = await prisma.bankImport.count();
    const again = await preview(x30, 'statement-all-30.xlsx', A);
    check('I1 the same file again: all 30 are Already Imported, none new', again.counts.alreadyImported === 30 && again.counts.notImported === 0 && again.counts.total === 30, again.counts);
    check('I2 ... and it says the exact file was imported before', !!again.summary.fileAlreadyImported && (again.body.problems || []).some((p) => /exact file/.test(p)), again.summary.fileAlreadyImported);
    const againImp = await importNew(again.batchId, A);
    check('I3 Import New on a repeat adds nothing: no bank line, no history row', againImp.status === 201 && againImp.body.imported === 0 && (await allCount()) === total1 && (await prisma.bankImport.count()) === impRows1, [againImp.status, againImp.body && againImp.body.imported]);
    const asCsv = await preview(csvBuf(rows30), 'a-completely-different-name.csv', A);
    check('I4 the same 30 rows as a .csv under another file name: still 30 Already Imported (matched on the transaction, not the file)', asCsv.counts.alreadyImported === 30 && asCsv.counts.notImported === 0, asCsv.counts);
    const noBal = await preview(csvBuf(rows30, { balance: false }), 'no-balance-column.csv', A);
    check('I5 the same rows from a statement WITHOUT the balance column are still Already Imported', noBal.counts.alreadyImported + noBal.counts.needsReview === 30 && noBal.counts.notImported === 0, noBal.counts);

    // ================================================================================================
    // R. THE RULES
    // ================================================================================================
    // R1 same amount, same day, different narration: two real transactions
    const day = '2026-08-12';
    const twoParties = [
      { d: day, n: `ZZTEST R1 NEFT PAYMENT RAMESH TRADERS`, dr: 5000 },
      { d: day, n: `ZZTEST R1 NEFT PAYMENT SURESH STORES`, dr: 5000 },
      { d: day, n: `ZZTEST R1 UPI TEA STALL`, dr: 5000 },
    ];
    const r1 = await preview(csvBuf(twoParties, { balance: false, ref: false }), 'r1.csv', B);
    check('R1 three payments of the same amount on the same day to different parties are all Not Imported (amount + date alone never decide)', r1.counts.notImported === 3 && r1.counts.duplicateInUpload === 0 && r1.counts.needsReview === 0, r1.counts);
    const r1i = await importNew(r1.batchId, B);
    check('R1b ... and all three are saved', r1i.body.imported === 3 && (await count(B)) === 3, r1i.body && r1i.body.stmt);

    // R2 direction matters: a credit of the same amount, day and words is not the debit
    const r2 = await preview(csvBuf([{ d: day, n: `ZZTEST R1 NEFT PAYMENT RAMESH TRADERS`, cr: 5000 }], { balance: false, ref: false }), 'r2.csv', B);
    check('R2 the same words and amount as a CREDIT are not the DEBIT on file: Not Imported', r2.counts.notImported === 1 && r2.counts.alreadyImported === 0, r2.counts);

    // R3 the other bank account never counts
    const r3 = await preview(csvBuf(rows30.slice(0, 5)), 'other-account.csv', B);
    check('R3 identical rows uploaded to a DIFFERENT bank account are new there (5 Not Imported), not duplicates of the first account', r3.counts.notImported === 5 && r3.counts.alreadyImported === 0, r3.counts);
    const r3i = await importNew(r3.batchId, B);
    check('R3b ... and importing them into account B leaves account A exactly as it was', r3i.body.imported === 5 && (await count(A)) === 30 && (await snap()).length > 0, r3i.body && r3i.body.stmt);
    const r3c = await http('POST', `/api/accounts-import/bank-batch/${again.batchId}/check`, T, { bankAccountId: B });
    check('R3c choosing another account on the screen re-checks the same upload against that account (30 rows: 5 Already Imported there, 25 new)', r3c.status === 200 && r3c.body.counts.alreadyImported === 5 && r3c.body.counts.notImported === 25, r3c.body);

    // R4 a bank reference (UTR) is a strong identity, whatever the narration says; a different UTR is a different transaction
    const utrRow = { d: '2026-08-14', n: `ZZTEST R4 NEFT CR ACME`, r: `UTRR4${RUN.toUpperCase()}9`, cr: 25000, b: 125000 };
    const r4a = await preview(csvBuf([utrRow]), 'r4a.csv', B);
    await importNew(r4a.batchId, B);
    const reworded = { ...utrRow, n: `completely different wording: ACME Corp payment` , b: 125000 };
    const r4b = await preview(csvBuf([reworded]), 'r4b.csv', B);
    check('R4 the same UTR, date, amount and direction with different narration wording is Already Imported (strong key)', r4b.counts.alreadyImported === 1, r4b.counts);
    const otherUtr = { ...utrRow, r: `UTRR4OTHER${RUN.toUpperCase()}`, b: 150000 };
    const r4c = await preview(csvBuf([otherUtr]), 'r4c.csv', B);
    check('R4b the same narration, date and amount but a DIFFERENT UTR is a different transaction: Not Imported', r4c.counts.notImported === 1 && r4c.counts.alreadyImported === 0, r4c.counts);
    const sameDiffBal = { ...utrRow, r: '', n: utrRow.n, b: 99999 };
    const r4d = await preview(csvBuf([sameDiffBal]), 'r4d.csv', B);
    check('R4c the same narration, date and amount but a different running balance (no UTR) is a different transaction: Not Imported', r4d.counts.notImported === 1, r4d.counts);

    // R5 punctuation, case, spaces
    const legacyN = 'ZZTEST R5 NEFT-CR/ACME  Traders, Pvt. Ltd.';
    const leg = await prisma.bankTransaction.create({ data: { bankAccountId: B, date: '2026-08-20', description: legacyN, type: 'Credit', amount: 7777.5, reference: null, balance: null } });
    const r5 = await preview(csvBuf([{ d: '2026-08-20', n: `zztest r5 neft cr acme traders pvt ltd`, cr: 7777.5 }], { balance: false, ref: false }), 'r5.csv', B);
    check('R5 case, extra spaces and punctuation are ignored: the old line (created before this feature, no keys) is found, Already Imported', r5.counts.alreadyImported === 1 && r5.counts.notImported === 0, r5.counts);

    // R6 Needs Review: part agrees, part does not (never imported, never skipped by itself)
    const legUtr = await prisma.bankTransaction.create({ data: { bankAccountId: B, date: '2026-08-21', description: `ZZTEST R6 NEFT CR GREENFIELD TRADERS PVT LTD`, type: 'Credit', amount: 12500, reference: `UTRR6${RUN.toUpperCase()}1`, balance: null } });
    const r6 = await preview(csvBuf([
      { d: '2026-08-21', n: `GREENFIELD TRADERS PVT LTD NEFT CREDIT ZZTEST R6`, cr: 12500 }, // UTR missing on one side, similar narration
      { d: '2026-08-25', n: 'ZZTEST R6 anything', r: `UTRR6${RUN.toUpperCase()}1`, cr: 12500 }, // same reference + amount, another date
      { d: '2026-08-21', n: `ZZTEST R6 UPI TOTALLY OTHER SHOP`, cr: 12500 }, // unrelated narration, same date + amount: NOT a duplicate
    ], { balance: false }), 'r6.csv', B);
    const r6rows = (await rowsOf(r6.batchId)).rows;
    check('R6 same date + amount + direction, similar narration, UTR missing on one side -> Needs Review', r6rows[0].status === 'Needs Review' && /missing|similar/.test(r6rows[0].reason), r6rows[0]);
    check('R6b the same UTR and amount on another date -> Needs Review (says so)', r6rows[1].status === 'Needs Review' && /another date|date on file/.test(r6rows[1].reason), r6rows[1]);
    check('R6c an unrelated narration with the same date and amount is simply Not Imported', r6rows[2].status === 'Not Imported', r6rows[2]);
    check('R6d the counts: Needs Review 2, Not Imported 1', r6.counts.needsReview === 2 && r6.counts.notImported === 1, r6.counts);
    const b6 = await count(B);
    const r6i = await importNew(r6.batchId, B);
    check('R6e Import New Transactions imports ONLY the Not Imported row; the Needs Review rows are neither imported nor skipped', r6i.body.imported === 1 && (await count(B)) === b6 + 1 && r6i.body.stmt.needsReview === 2, r6i.body && r6i.body.stmt);
    const pl = await plan(r6.batchId, [{ rowNo: r6rows[0].rowNo, decision: 'import' }, { rowNo: r6rows[1].rowNo, decision: 'skip' }]);
    check('S1 a person chooses per row: the first is imported, the second left out (counts show it before the import)', pl.status === 200 && pl.body.counts.chosenImport === 1, pl.body);
    const r6j = await importNew(r6.batchId, B);
    const r6after = await rowsOf(r6.batchId);
    check('S2 the chosen row is saved (Imported), the other one is Left out; nothing else changed', r6j.body.imported === 1 && r6after.rows[0].display === 'Imported' && r6after.rows[1].display === 'Left out', r6after.rows.map((x) => x.display));
    const noAI = await plan(r1.batchId, [{ rowNo: 1, decision: 'import' }]);
    check('S3 a row that is already finished cannot be given a new choice (refused with a reason)', noAI.body.refused.length === 1, noAI.body);
    const alRow = (await rowsOf(pv30.batchId, 'Already Imported')).rows[0];
    const noAI2 = await plan(pv30.batchId, [{ rowNo: alRow.rowNo, decision: 'import' }]);
    check('S4 an Already Imported row can never be chosen for import', noAI2.body.refused.length === 1 && /never imported again/.test(noAI2.body.refused[0].reason), noAI2.body);

    // R7 legacy lines get keys the first time an import runs (non-destructive); a deleted line can be imported again
    check('R7 legacy lines now own keys (written by the import, nothing else changed on them)', keyCount(leg.id) >= 1 && keyCount(legUtr.id) >= 1, [keyCount(leg.id), keyCount(legUtr.id)]);
    const before7 = await prisma.bankTransaction.findUnique({ where: { id: leg.id } });
    await prisma.bankTransaction.delete({ where: { id: leg.id } });
    check('R7b deleting a bank line removes its keys (trigger), so it can be imported again', keyCount(leg.id) === 0);
    const r7 = await preview(csvBuf([{ d: '2026-08-20', n: legacyN, cr: 7777.5 }], { balance: false, ref: false }), 'r7.csv', B);
    check('R7c ... and the same line is then Not Imported', r7.counts.notImported === 1);
    check('R7d (the legacy line was not changed by the keys: same amount, date, narration)', before7.amount === 7777.5 && before7.description === legacyN);

    // R8 old data that already holds the same line twice (real twins imported before this feature): never merged, never deleted
    const oldTwin = { bankAccountId: B, date: '2026-07-01', description: 'ZZTEST R8 LEGACY TWIN', type: 'Debit', amount: 333, reference: null, balance: null };
    const lt1 = await prisma.bankTransaction.create({ data: oldTwin });
    const lt2 = await prisma.bankTransaction.create({ data: oldTwin });
    const twinRow = { d: '2026-07-01', n: 'ZZTEST R8 LEGACY TWIN', dr: 333 };
    const r8a = await preview(csvBuf([twinRow], { balance: false, ref: false }), 'r8a.csv', B);
    const r8b = await preview(csvBuf([twinRow, twinRow], { balance: false, ref: false }), 'r8b.csv', B);
    const r8c = await preview(csvBuf([twinRow, twinRow, twinRow], { balance: false, ref: false }), 'r8c.csv', B);
    check('R8 two identical old lines on file: a file with one of them is Already Imported; with two, both are; with three, the third is a repeat (Duplicate in Current Upload)', r8a.counts.alreadyImported === 1 && r8b.counts.alreadyImported === 2 && r8c.counts.alreadyImported === 2 && r8c.counts.duplicateInUpload === 1, [r8a.counts, r8b.counts, r8c.counts]);
    const r8n = await preview(csvBuf([{ d: '2026-07-02', n: 'ZZTEST R8 TRIGGER', dr: 1 }], { balance: false, ref: false }), 'r8n.csv', B);
    await importNew(r8n.batchId, B);
    const lk = q('SELECT "txnId","ordinal" FROM "BankTxnKey" WHERE "txnId" IN (?,?) ORDER BY "ordinal"', lt1.id, lt2.id);
    check('R8b the old twins now own keys with ordinal 1 and 2 (no clash, no error), and both old lines are still there unchanged', lk.length === 2 && lk[0].ordinal === 1 && lk[1].ordinal === 2 && (await prisma.bankTransaction.count({ where: { description: 'ZZTEST R8 LEGACY TWIN' } })) === 2, lk);

    // ================================================================================================
    // U. DUPLICATE IN CURRENT UPLOAD + "IMPORT ANYWAY"
    // ================================================================================================
    const twin = { d: '2026-08-30', n: `ZZTEST U1 UPI/777000111222/CHAI`, dr: 120 };
    const u1 = await preview(csvBuf([twin, { d: '2026-08-30', n: `ZZTEST U1 OTHER`, dr: 99 }, twin], { balance: false, ref: false }), 'u1.csv', B);
    const u1rows = (await rowsOf(u1.batchId)).rows;
    check('U1 the same row twice in one file: the first is Not Imported, the repeat is Duplicate in Current Upload (with the row it repeats)', u1rows[0].status === 'Not Imported' && u1rows[2].status === 'Duplicate in Current Upload' && /row 1/.test(u1rows[2].reason), u1rows.map((x) => x.status));
    check('U1b counts: Not Imported 2, Duplicate in Current Upload 1, total 3', u1.counts.notImported === 2 && u1.counts.duplicateInUpload === 1 && u1.counts.total === 3, u1.counts);
    const bU = await count(B);
    const u1i = await importNew(u1.batchId, B);
    check('U2 import: only one of the two identical rows is saved (+2 lines, not +3)', u1i.body.imported === 2 && (await count(B)) === bU + 2 && u1i.body.stmt.duplicateInUpload === 1, u1i.body && u1i.body.stmt);
    const u1b = await preview(csvBuf([twin, twin], { balance: false, ref: false }), 'u1-again.csv', B);
    check('U3 uploading the twin file again: row 1 is Already Imported, the repeat stays Duplicate in Current Upload', u1b.counts.alreadyImported === 1 && u1b.counts.duplicateInUpload === 1, u1b.counts);

    // genuine same-day twin, saved on purpose
    const twin2 = { d: '2026-08-31', n: `ZZTEST U4 UPI/888000111222/PARCEL`, dr: 450 };
    const u4 = await preview(csvBuf([twin2, twin2], { balance: false, ref: false }), 'u4.csv', B);
    const u4rows = (await rowsOf(u4.batchId)).rows;
    await plan(u4.batchId, [{ rowNo: u4rows[1].rowNo, decision: 'import' }]);
    const bU4 = await count(B);
    const u4i = await importNew(u4.batchId, B);
    check('U4 "Import this one anyway" on a genuine same-day twin: BOTH are saved', u4i.body.imported === 2 && (await count(B)) === bU4 + 2, u4i.body && u4i.body.stmt);
    const u4keys = q('SELECT k."ordinal", k."note", k."kind" FROM "BankTxnKey" k JOIN "BankTransaction" t ON t."id" = k."txnId" WHERE t."description" = ? AND k."kind" <> \'F\' ORDER BY k."ordinal"', twin2.n);
    check('U5 ... and it is recorded: the twin has ordinal 2 and a note that a person chose it; the batch row remembers the choice', u4keys.length === 2 && u4keys[1].ordinal === 2 && /imported anyway/.test(u4keys[1].note) && q('SELECT "decision" FROM "BankStmtRow" WHERE "batchId" = ? AND "decision" = \'import\'', u4.batchId).length === 1, u4keys);
    const u4b = await preview(csvBuf([twin2, twin2], { balance: false, ref: false }), 'u4-again.csv', B);
    check('U6 uploading that twin file again: both rows are Already Imported (two on file, two in the file)', u4b.counts.alreadyImported === 2 && u4b.counts.notImported === 0 && u4b.counts.duplicateInUpload === 0, u4b.counts);

    // ================================================================================================
    // C. SIMULTANEOUS CONFIRMS + THE DATABASE REFUSES A RAW DUPLICATE
    // ================================================================================================
    const rowsC = thirty('C').slice(0, 12);
    const pvC = await preview(csvBuf(rowsC), 'concurrent.csv', A);
    const aC = await count(A);
    const three = await Promise.all([importNew(pvC.batchId, A), importNew(pvC.batchId, A), importNew(pvC.batchId, A)]);
    const savedC = three.reduce((s, r) => s + (r.body ? r.body.imported : 0), 0);
    check('C1 three confirms of the SAME batch at the same moment: the 12 lines are saved exactly once', three.every((r) => r.status === 201) && savedC === 12 && (await count(A)) === aC + 12, [three.map((r) => r.status), savedC, (await count(A)) - aC]);
    const pvC2 = [];
    const rowsC2 = thirty('D').slice(0, 10);
    for (let i = 0; i < 3; i += 1) pvC2.push(await preview(csvBuf(rowsC2), `same-file-${i}.csv`, A));
    const aC2 = await count(A);
    const three2 = await Promise.all(pvC2.map((p) => importNew(p.batchId, A)));
    const savedC2 = three2.reduce((s, r) => s + (r.body ? r.body.imported : 0), 0);
    check('C2 the same file previewed three times, then all three confirmed at once: each line saved exactly once (the unique index decides)', three2.every((r) => r.status === 201) && savedC2 === 10 && (await count(A)) === aC2 + 10, [three2.map((r) => [r.status, r.body && r.body.imported]), (await count(A)) - aC2]);
    const dupGroups = q('SELECT "date","type","amount","description", COUNT(*) AS n FROM "BankTransaction" WHERE "bankAccountId" = ? GROUP BY 1,2,3,4 HAVING n > 1', A);
    check('C3 afterwards no two lines of account A are the same (date, direction, amount, narration)', dupGroups.length === 0, dupGroups);
    // DB level: the unique index is the guard
    const sample = q('SELECT "txnId","bankAccountId","kind","key","ordinal" FROM "BankTxnKey" WHERE "bankAccountId" = ? AND "kind" = \'S\' LIMIT 1', A)[0];
    let rawErr = null;
    try { dbx.prepare('INSERT INTO "BankTxnKey" ("txnId","bankAccountId","kind","key","ordinal","createdAt") VALUES (?,?,?,?,?,?)').run('ZZTEST-RAW-1', sample.bankAccountId, sample.kind, sample.key, sample.ordinal, 'x'); } catch (e) { rawErr = e; }
    check('C4 at database level: a raw INSERT of an existing key is refused (UNIQUE constraint on bankAccountId + key + ordinal)', rawErr && /UNIQUE constraint failed/i.test(rawErr.message), rawErr && rawErr.message);
    let rawErr2 = null;
    try { dbx.prepare('INSERT INTO "BankTxnKey" ("txnId","bankAccountId","kind","key","ordinal","createdAt") VALUES (?,?,?,?,?,?)').run('ZZTEST-RAW-2', B, 'S', sample.key, 1, 'x'); dbx.prepare('INSERT INTO "BankTxnKey" ("txnId","bankAccountId","kind","key","ordinal","createdAt") VALUES (?,?,?,?,?,?)').run('ZZTEST-RAW-2', B, 'S', sample.key, 2, 'x'); } catch (e) { rawErr2 = e; }
    check('C5 ... also one line cannot hold the same key twice; the same key on ANOTHER account is fine', rawErr2 && /UNIQUE constraint failed/i.test(rawErr2.message) && q('SELECT COUNT(*) AS n FROM "BankTxnKey" WHERE "bankAccountId" = ? AND "key" = ?', B, sample.key)[0].n === 1, rawErr2 && rawErr2.message);
    dbx.prepare("DELETE FROM \"BankTxnKey\" WHERE \"txnId\" LIKE 'ZZTEST-RAW-%'").run();
    check('C6 the index exists in the database (BankTxnKey_unique, UNIQUE on bankAccountId, key, ordinal)', q("SELECT sql FROM sqlite_master WHERE name = 'BankTxnKey_unique'")[0].sql.includes('UNIQUE INDEX') && /"bankAccountId", "key", "ordinal"/.test(q("SELECT sql FROM sqlite_master WHERE name = 'BankTxnKey_unique'")[0].sql));

    // a stale preview: the lines were imported by another upload after this preview was made
    const rowsS = thirty('S').slice(0, 8);
    const stale = await preview(csvBuf(rowsS), 'stale-1.csv', A);
    const other = await preview(csvBuf(rowsS), 'stale-2.csv', A);
    await importNew(other.batchId, A);
    const aS = await count(A);
    const staleImp = await importNew(stale.batchId, A);
    check('W3 a preview that went stale is checked again just before saving: the 8 lines saved meanwhile are NOT saved again (shown as Already Imported)', staleImp.body.imported === 0 && (await count(A)) === aS && staleImp.body.stmt.alreadyImported === 8, staleImp.body && staleImp.body.stmt);
    // a tampered body changes nothing
    const rowsT = thirty('T').slice(0, 3);
    const pvT = await preview(csvBuf(rowsT), 'tamper.csv', A);
    const aT = await count(A);
    const tamper = await importNew(pvT.batchId, A, T, { transactions: [{ date: '2026-09-01', description: 'ZZTEST FAKE', amount: 1, type: 'Credit' }], rows: [{ x: 1 }], csv: 'junk', decisions: [{ rowNo: 99, decision: 'import' }] });
    check('W4 the import uses the rows stored on the server: a body that carries other rows adds nothing but the 3 previewed lines', tamper.body.imported === 3 && (await count(A)) === aT + 3 && !(await prisma.bankTransaction.findFirst({ where: { description: 'ZZTEST FAKE' } })), tamper.body && tamper.body.stmt);

    // ================================================================================================
    // X. FAILURE ON ONE LINE, RETRY FAILED
    // ================================================================================================
    const rowsX = thirty('X').slice(0, 5).map((r, i) => (i === 2 ? { ...r, n: `ZZTEST X ZZFAILROW` } : r));
    const pvX = await preview(csvBuf(rowsX), 'failure.csv', A);
    dbx.exec("CREATE TRIGGER IF NOT EXISTS zz_fail BEFORE INSERT ON \"BankTransaction\" WHEN NEW.\"description\" LIKE '%ZZFAILROW%' BEGIN SELECT RAISE(ABORT, 'ZZTEST injected failure'); END");
    const aX = await count(A);
    const imX = await importNew(pvX.batchId, A);
    check('X1 one line fails: 4 are imported, 1 Failed, the import is not stopped', imX.status === 201 && imX.body.imported === 4 && imX.body.stmt.newlyImported === 4 && imX.body.stmt.failed === 1 && (await count(A)) === aX + 4, imX.body && imX.body.stmt);
    const failedRows = await rowsOf(pvX.batchId, 'Failed');
    check('X2 the failed row shows its reason and stays retryable (not marked Imported, no bank line)', failedRows.total === 1 && /database refused/.test(failedRows.rows[0].error) && failedRows.rows[0].display === 'Failed' && !failedRows.rows[0].txnId && failedRows.rows[0].description.includes('ZZFAILROW'), failedRows.rows[0]);
    check('X3 the response lists the failure reason for the screen; "retryable" is 1', imX.body.failedRows.length === 1 && /database refused/.test(imX.body.failedRows[0].reason) && imX.body.stmt.retryable === 1, imX.body.failedRows);
    const retry1 = await retry(pvX.batchId, A);
    check('X4 Retry failed while the cause is still there: still 1 Failed, nothing else touched, no duplicate of the 4', retry1.status === 201 && retry1.body.imported === 0 && retry1.body.stmt.failed === 1 && (await count(A)) === aX + 4, retry1.body && retry1.body.stmt);
    dbx.exec('DROP TRIGGER IF EXISTS zz_fail');
    const retry2 = await retry(pvX.batchId, A);
    check('X5 the cause is fixed: Retry failed imports ONLY the failed line, once (+1 line, newly imported 5, failed 0)', retry2.status === 201 && retry2.body.imported === 1 && retry2.body.stmt.newlyImported === 5 && retry2.body.stmt.failed === 0 && (await count(A)) === aX + 5, retry2.body && retry2.body.stmt);
    const retry3 = await retry(pvX.batchId, A);
    check('X6 a second retry adds nothing', retry3.body.imported === 0 && (await count(A)) === aX + 5, retry3.body && retry3.body.stmt);
    const retry4 = await importNew(pvX.batchId, A);
    check('X7 Import New on the finished batch adds nothing either', retry4.body.imported === 0 && (await count(A)) === aX + 5);
    const xRow = q('SELECT "attempts","result","txnId" FROM "BankStmtRow" WHERE "batchId" = ? AND "narration" LIKE \'%ZZFAILROW%\'', pvX.batchId)[0];
    check('X8 the batch row records the attempts and the saved line', xRow.result === 'Imported' && xRow.txnId && xRow.attempts >= 3, xRow);

    // ================================================================================================
    // P. UNREADABLE ROWS, PERMISSIONS, THE OLD ONE-STEP DOORS
    // ================================================================================================
    const badCsv = Buffer.from(['Date,Narration,Reference No,Withdrawal Amt,Deposit Amt,Closing Balance', `2026-09-02,ZZTEST P1 GOOD,,100,,`, `not-a-date,ZZTEST P1 BADDATE,,200,,`, `2026-09-03,ZZTEST P1 GOOD TWO,,300,,`].join('\r\n'), 'utf8');
    const pvP = await preview(badCsv, 'unreadable.csv', B);
    check('P1 an unreadable row is counted as Failed with its reason, the good rows are Not Imported', pvP.counts.total === 3 && pvP.counts.failed === 1 && pvP.counts.notImported === 2 && pvP.counts.unreadable === 1, pvP.counts);
    const pvPi = await importNew(pvP.batchId, B);
    const badRow = (await rowsOf(pvP.batchId, 'Failed')).rows[0];
    check('P2 the good rows import; the unreadable one stays Failed with "No usable date" and cannot be retried', pvPi.body.imported === 2 && /date/i.test(badRow.error) && pvPi.body.stmt.retryable === 0, [pvPi.body.imported, badRow && badRow.error]);

    const noTok = await http('GET', `/api/accounts-import/bank-batch/${pvP.batchId}`, null);
    check('P3 no login -> 401', noTok.status === 401, noTok.status);
    const recPrev = await preview(csvBuf(rowsT), 'rec.csv', A, rec.t);
    const recBatch = await http('GET', `/api/accounts-import/bank-batch/${pvP.batchId}`, rec.t);
    const recRows = await http('GET', `/api/accounts-import/bank-batch/${pvP.batchId}/rows`, rec.t);
    const recImp = await http('POST', `/api/accounts-import/bank-batch/${pvT.batchId}/import`, rec.t, { bankAccountId: A });
    const recRetry = await http('POST', `/api/accounts-import/bank-batch/${pvX.batchId}/retry`, rec.t, {});
    const recPlan = await http('POST', `/api/accounts-import/bank-batch/${pvT.batchId}/plan`, rec.t, { decisions: [] });
    const recCheck = await http('POST', `/api/accounts-import/bank-batch/${pvT.batchId}/check`, rec.t, { bankAccountId: A });
    const recLegacy = await http('POST', '/api/bank/import', rec.t, { csv: csvBuf(rowsT).toString(), bankAccountId: A, file: 'rec.csv' });
    check('P4 a login without Accounts rights gets 403 on preview, the batch, its rows, plan, check, import, retry and the old import door', [recPrev.status, recBatch.status, recRows.status, recImp.status, recRetry.status, recPlan.status, recCheck.status, recLegacy.status].every((s) => s === 403), [recPrev.status, recBatch.status, recRows.status, recImp.status, recRetry.status, recPlan.status, recCheck.status, recLegacy.status]);
    const accOk = await preview(csvBuf(thirty('P').slice(0, 2)), 'acct.csv', A, acct.t);
    check('P5 the Accountant (who may import statements today) can still preview and import', accOk.status === 200 && accOk.counts.notImported === 2 && (await importNew(accOk.batchId, A, acct.t)).body.imported === 2);
    const gone = await http('POST', '/api/accounts-import/bank-batch/does-not-exist/import', T, {});
    check('P6 an unknown or expired batch is a clear 404, nothing happens', gone.status === 404 && /no longer available/.test(gone.body.error), gone.body);

    // old one-step doors use the same rules
    const csvL = csvBuf(thirty('L').slice(0, 4)).toString('utf8');
    const l1 = await http('POST', '/api/bank/import', T, { csv: csvL, bankAccountId: A, file: 'legacy-door.csv' });
    const aL = await count(A);
    const l2 = await http('POST', '/api/bank/import', T, { csv: csvL, bankAccountId: A, file: 'legacy-door-again.csv' });
    check('P7 POST /api/bank/import (pasted CSV): the first call saves 4, the same CSV again saves 0 and reports 4 duplicates', l1.status === 201 && l1.body.imported === 4 && l2.status === 201 && l2.body.imported === 0 && l2.body.duplicates === 4 && (await count(A)) === aL, [l1.status, l1.body && l1.body.imported, l2.body && l2.body.imported, l2.body && l2.body.duplicates]);
    const l3 = await http('POST', '/api/bank/preview', T, { csv: csvL, bankAccountId: A });
    check('P8 POST /api/bank/preview uses the same classifier: 4 lines, 4 already imported, 0 new, nothing written', l3.status === 200 && l3.body.alreadyImported === 4 && l3.body.newLines === 0 && (await count(A)) === aL, l3.body);
    const cm = await http('POST', '/api/accounts-import/commit', T, form(csvBuf(thirty('M').slice(0, 3)), 'one-step.csv', { bankAccountId: A }));
    const cm2 = await http('POST', '/api/accounts-import/commit', T, form(csvBuf(thirty('M').slice(0, 3)), 'one-step.csv', { bankAccountId: A }));
    check('P9 POST /api/accounts-import/commit (one step): saves 3, the same file again saves 0 and says it is a repeat', cm.status === 201 && cm.body.imported === 3 && cm2.status === 201 && cm2.body.imported === 0 && !!cm2.body.fileAlreadyImported && cm2.body.stmt.alreadyImported === 3, [cm.status, cm.body && cm.body.imported, cm2.body && cm2.body.stmt]);
    const cmReview = await http('POST', '/api/accounts-import/commit', T, form(csvBuf([twin, twin], { balance: false, ref: false }), 'repeat-in-file.csv', { bankAccountId: B }));
    check('P10 the one-step door never imports a repeat or a Needs Review row by itself (the twin file adds nothing: row 1 on file, the repeat skipped)', cmReview.status === 201 && cmReview.body.imported === 0 && cmReview.body.stmt.alreadyImported === 1 && cmReview.body.stmt.duplicateInUpload === 1, cmReview.body && cmReview.body.stmt);

    // a big statement: 500 lines, preview + import, then the same again
    const big = thirty('BIG').concat(thirty('BIH'), thirty('BII'), thirty('BIJ'), thirty('BIK'), thirty('BIL'), thirty('BIM'), thirty('BIN'), thirty('BIO'), thirty('BIP'), thirty('BIQ'), thirty('BIR'), thirty('BIS'), thirty('BIT'), thirty('BIU'), thirty('BIV'), thirty('BIW')).slice(0, 500);
    const t0 = Date.now();
    const pvBig = await preview(xlsxBuf(big), 'big-500.xlsx', A);
    const tPrev = Date.now() - t0;
    const t1 = Date.now();
    const imBig = await importNew(pvBig.batchId, A);
    const tImp = Date.now() - t1;
    const pvBig2 = await preview(xlsxBuf(big), 'big-500-again.xlsx', A);
    check(`P11 a 500-line statement: preview ${tPrev} ms, import ${tImp} ms; every line saved once, and the same file again is 500 Already Imported`, pvBig.counts.total === 500 && imBig.body.stmt.newlyImported + imBig.body.stmt.needsReview + imBig.body.stmt.duplicateInUpload === 500 && pvBig2.counts.alreadyImported + pvBig2.counts.needsReview + pvBig2.counts.duplicateInUpload >= 500 - 0 && tImp < 120000, [pvBig.counts, imBig.body.stmt, pvBig2.counts]);
    facts.perf = { previewMs: tPrev, importMs: tImp };

    // ================================================================================================
    // H. HISTORY, AUDIT, OTHER DATA, MATCHING OF NEW LINES
    // ================================================================================================
    const batchRow = q('SELECT * FROM "BankStmtBatch" WHERE "id" = ?', pv30.batchId)[0];
    check('H1 the batch is recorded: id, file name, account, uploader, upload time, status, import id, run count', batchRow && batchRow.file === 'statement-all-30.xlsx' && batchRow.bankAccountId === A && batchRow.uploadedByName && batchRow.createdAt && batchRow.status === 'Done' && /^IMP-/.test(batchRow.importId) && batchRow.runs >= 1 && batchRow.lastRunAt, batchRow);
    const rowRec = q('SELECT * FROM "BankStmtRow" WHERE "batchId" = ? AND "result" = \'Imported\' LIMIT 1', pv30.batchId)[0];
    check('H2 each row is recorded: row number, sheet line, transaction reference, status, result, import time, saved bank line', rowRec && rowRec.rowNo > 0 && rowRec.line > 0 && rowRec.status === 'Not Imported' && rowRec.result === 'Imported' && rowRec.importedAt && rowRec.txnId, rowRec);
    const hist = await prisma.bankImport.findUnique({ where: { id: batchRow.importId } });
    check('H3 the "Statements imported" history row has the file name, who, date, 4 lines and the summary', hist && hist.file === 'statement-all-30.xlsx' && hist.lines === 4 && hist.recordedBy && JSON.parse(hist.summary).alreadyImported === 26, hist && [hist.file, hist.lines, hist.summary]);
    const ups = await http('GET', `/api/bank/imports?bankAccountId=${A}`, T);
    const mine = (ups.body || []).find((i) => i.id === batchRow.importId);
    check('H4 the Bank screen\'s imports list now also carries the duplicate-check counts for that upload', mine && mine.upload && mine.upload.counts.alreadyImported === 26 && mine.upload.counts.newlyImported === 4, mine && mine.upload);
    const aud = await prisma.auditLog.findFirst({ where: { entityId: pv30.batchId, action: 'Bank statement imported' } });
    check('H5 one audit row per import: user, time, file name and the counts - no narration', aud && aud.userId === admin.u.id && /4 imported/.test(aud.toValue) && /26 already imported/.test(aud.toValue) && /statement-all-30\.xlsx/.test(aud.toValue) && !/UPI\//.test(aud.toValue), aud);
    const audRetry = await prisma.auditLog.findFirst({ where: { entityId: pvX.batchId, action: 'Bank statement import retried' } });
    check('H6 a retry is audited too', !!audRetry);
    const list = await http('GET', `/api/accounts-import/bank-batches?bankAccountId=${A}`, T);
    check('H7 the upload history lists the batches with file name, uploader, time and counts', list.status === 200 && list.body.batches.some((b) => b.id === pv30.batchId && b.file === 'statement-all-30.xlsx' && b.counts.newlyImported === 4), list.body && list.body.batches.length);

    // matching still runs on NEW lines, exactly as before
    const cl = await prisma.client.create({ data: { name: `ZZTEST SD Client `, location: 'ZZ', ownerDepartment: 'Education', clientType: 'Client' } });
    made.clients.push(cl.id);
    const invNo = `ZZSD-`;
    const inv = await prisma.invoice.create({ data: { clientId: cl.id, amount: 2000, gst: 0, tds: 0, invoiceDate: '2026-08-01', dueDate: '2026-08-31', invoiceNumber: invNo, receivedAmount: 0, status: 'Pending' } });
    made.invoices.push(inv.id);
    const m1 = await preview(csvBuf([{ d: '2026-09-10', n: `NEFT CR ${invNo} ZZTEST SD CLIENT`, cr: 2000, b: 777000 }]), 'matching.csv', A);
    const m1i = await importNew(m1.batchId, A);
    const invAfter = await prisma.invoice.findUnique({ where: { id: inv.id } });
    check('H8 the matching of new lines runs as before: a credit that names the invoice and its exact amount is posted to that invoice', m1i.body.imported === 1 && invAfter.receivedAmount === 2000 && m1i.body.summary.matched >= 1, [invAfter.receivedAmount, m1i.body.summary]);
    const m2 = await preview(csvBuf([{ d: '2026-09-10', n: `NEFT CR ${invNo} ZZTEST SD CLIENT`, cr: 2000, b: 777000 }]), 'matching-again.csv', A);
    const m2i = await importNew(m2.batchId, A);
    check('H9 uploading that line again changes nothing: Already Imported, the invoice is not paid twice', m2i.body.imported === 0 && (await prisma.invoice.findUnique({ where: { id: inv.id } })).receivedAmount === 2000 && m2i.body.stmt.alreadyImported === 1, m2i.body && m2i.body.stmt);
    const checksAfter = {};
    for (const t of Object.keys(checksumsBefore)) checksAfter[t] = JSON.stringify(q(`SELECT * FROM "${t}" ORDER BY "id"`));
    const changedTables = Object.keys(checksumsBefore).filter((t) => checksumsBefore[t] !== checksAfter[t]);
    check('H10 other tables are untouched by the uploads (only the ZZTEST client / invoice this test added itself, and its one posted receipt, differ)', changedTables.every((t) => ['Client', 'Invoice', 'InvoicePayment'].includes(t)), changedTables);
    check('H11 the 26 original lines are STILL unchanged after all the later uploads', only26 === JSON.stringify((await prisma.bankTransaction.findMany({ where: { id: { in: JSON.parse(snap26).map((x) => x.id) } }, orderBy: { id: 'asc' } }))));
    const realLeft = (await allCount()) - (await count(A)) - (await count(B));
    check('H12 the real (non-test) bank lines on the copy are exactly as before the test (4 lines, none added, none removed)', realLeft === before0, [realLeft, before0]);

    // ================================================================================================
    // L. THE SCREEN'S PURE LOGIC
    // ================================================================================================
    const esb = require(path.join(FE, 'node_modules', 'esbuild'));
    const outFile = path.join(os.tmpdir(), `zz-stmt-status-${RUN}.cjs`);
    esb.buildSync({ entryPoints: [path.join(FE, 'src/pages/bank/stmtStatus.js')], bundle: true, format: 'cjs', platform: 'node', outfile: outFile, logLevel: 'error' });
    const S = require(outFile);
    const cards = S.statusCards({ total: 30, alreadyImported: 26, notImported: 4, newlyImported: 0, failed: 0 });
    check('L1 the strip shows the seven labels in the founder\'s words, with the server\'s numbers', cards.map((c) => c.label).join('|') === 'Total Statements|Already Imported|Not Imported|Duplicate in Current Upload|Needs Review|Newly Imported|Failed' && cards[0].value === 30 && cards[1].value === 26 && cards[2].value === 4, cards.map((c) => [c.label, c.value]));
    const after2 = S.statusCards({ total: 30, alreadyImported: 26, notImported: 0, newlyImported: 4, failed: 0 });
    check('L2 after a successful import the same strip reads Not Imported 0, Newly Imported 4, Failed 0', after2[2].value === 0 && after2[5].value === 4 && after2[6].value === 0);
    const ip = S.importPlan({ total: 30, alreadyImported: 26, notImported: 4, chosenImport: 0 });
    check('L3 the button reads "Import New Transactions (4)" and is enabled', ip.label === 'Import New Transactions (4)' && ip.canImport && ip.count === 4, ip);
    const ip0 = S.importPlan({ total: 30, alreadyImported: 30, notImported: 0 });
    check('L4 when everything is already imported the button is off and says why in plain words', !ip0.canImport && /already imported/i.test(ip0.note), ip0);
    const ip2 = S.importPlan({ total: 10, alreadyImported: 2, notImported: 3, chosenImport: 2, needsReview: 3 });
    check('L5 rows a person chose are counted next to the new ones (3 new + 2 chosen = 5), never the already imported ones', ip2.count === 5 && /3 new and 2 you chose/.test(ip2.note), ip2);
    check('L6 Retry failed shows only when something failed while saving', S.retryPlan({ retryable: 1 }).canRetry && !S.retryPlan({ retryable: 0, failed: 2, unreadable: 2 }).canRetry && S.retryPlan({ retryable: 3 }).label === 'Retry failed (3)');
    check('L7 a row is shown by what happened to it: Imported / Failed / Left out win over the earlier check', S.displayStatus({ status: 'Not Imported', result: 'Imported' }) === 'Imported' && S.displayStatus({ status: 'Needs Review', result: 'Failed' }) === 'Failed' && S.displayStatus({ status: 'Needs Review', result: 'Skipped' }) === 'Left out' && S.displayStatus({ status: 'Duplicate in Current Upload' }) === 'Duplicate in Current Upload');
    check('L8 only Needs Review and repeated rows can be chosen for, and only before they are finished', S.canChoose({ status: 'Needs Review' }) && S.canChoose({ status: 'Duplicate in Current Upload' }) && !S.canChoose({ status: 'Already Imported' }) && !S.canChoose({ status: 'Not Imported' }) && !S.canChoose({ status: 'Needs Review', result: 'Imported' }));
    const sum = S.summaryItems({ total: 30, alreadyImported: 26, eligible: 4, newlyImported: 4, failed: 0, needsReview: 0, duplicateInUpload: 0 });
    check('L9 the final summary lists total uploaded, already imported, new eligible, successfully imported, failed and needing manual review', sum.map((x) => `${x.label}=${x.value}`).join(', ') === 'Total uploaded=30, Already imported=26, New (eligible)=4, Successfully imported=4, Failed=0, Needs manual review=0', sum);
    const realCounts = (await http('GET', `/api/accounts-import/bank-batch/${pv30.batchId}`, T)).body.counts;
    check('L10 the real server counts of the founder\'s batch add up to the total (nothing lost between the buckets)', S.countsAddUp(realCounts) && realCounts.total === 30, realCounts);
    check('L11 the six other batches of this test add up too', (await Promise.all([pvX, pvP, u1, u4, r6].map(async (b) => S.countsAddUp((await http('GET', `/api/accounts-import/bank-batch/${b.batchId}`, T)).body.counts)))).every(Boolean));
    facts.rows = { F: 30, existing: 26 };
  } catch (e) {
    fail += 1; console.log(`FAIL  the test stopped: ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      // ZZTEST cleanup: every row this test created, on the COPY only
      const accIds = made.banks;
      const txns = await prisma.bankTransaction.findMany({ where: { bankAccountId: { in: accIds } }, select: { id: true } });
      const ids = txns.map((t) => t.id);
      await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: made.invoices } } }).catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.bankImport.deleteMany({ where: { bankAccountId: { in: accIds } } }).catch(() => {});
      await prisma.bankAccount.deleteMany({ where: { id: { in: accIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
      if (dbx) {
        dbx.exec('DROP TRIGGER IF EXISTS zz_fail');
        dbx.prepare('DELETE FROM "BankStmtRow" WHERE "batchId" IN (SELECT "id" FROM "BankStmtBatch" WHERE "bankAccountId" IN (?,?))').run(...accIds);
        dbx.prepare('DELETE FROM "BankStmtBatch" WHERE "bankAccountId" IN (?,?)').run(...accIds);
        dbx.prepare('DELETE FROM "BankTxnKey" WHERE "bankAccountId" IN (?,?)').run(...accIds);
        dbx.prepare('DELETE FROM "AuditLog" WHERE "userId" IN (' + made.users.map(() => '?').join(',') + ')').run(...made.users);
        dbx.close();
      }
    } catch (e) { console.log('cleanup note:', e.message); }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    if (ownCopy) { await new Promise((r) => setTimeout(r, 800)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
