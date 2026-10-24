#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HAND LOANS - EDIT and REMOVE (Accounts, 2026-10-19) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/hand-loan-edit-remove-test.js                  makes its own VACUUM INTO copy of the real database
//                                                               (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/hl-copy.db node scripts/hand-loan-edit-remove-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4067, TEST_MODE=1) on the copy, adds ZZTEST hand entries / bank lines / users
// to the COPY and proves, over real HTTP:
//   V  validation is done by the SERVER (empty / invalid / negative / non-numeric amount, a bad or future date, no person)
//   E  edit changes the chosen row only, in place (no second row), persists, audits old -> new, and the totals equal an
//      independent recomputation from the tables before and after
//   G  the guards: the statement wins over a typed amount, stale saves are refused, duplicates are refused, closed books
//   R  remove: a reason is needed, only the chosen entry goes (to HandLoanRemoved, whole, with who / when / why), totals follow,
//      a second press is harmless (also two at once), an entry with statement lines linked is refused until they are unlinked
//   M  a person with several entries: picking one touches that one only
//   P  permissions: the roles that can manage hand loans can; view-only and other logins get 403, nothing changes
//   U  the statement lines, invoices, payments, banks and the books are byte-for-byte what they were
//   W  the "+ What was taken" flow still works (entry added once, the person leaves "no entry yet", the line is linked)
//   F  frontend: the pure helpers (esbuild bundle) and the screen's source (buttons beside the heading, dialogs, in-flight lock)
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
  copy = path.join(os.tmpdir(), `hl-edit-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  ownCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4067);
if ([4010, 4045].includes(PORT)) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const HLC = require(path.join(BACK, 'src/utils/handLoanChanges'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);

function bundle(rel, name) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzhl-${RUN}-${name}.cjs`);
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
const j = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const made = { users: [], banks: [], txns: [], loans: [], clients: [] };

(async () => {
  let server;
  try {
    // ------------------------------------------------------------ F0. the pure helpers (frontend, bundled)
    const H = bundle('src/pages/bank/handLoanActions.js', 'act');

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST HL ${tag} ${RUN}`, email: `zz-hl-${tag}-${RUN}@example.test`, username: `zz-hl-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, t: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const rec = await mkUser('rec', {});

    // ------------------------------------------------------------ fixtures (in the COPY)
    const bank = await prisma.bankAccount.create({ data: { bank: `ZZTEST HL Bank ${RUN}`, name: 'ZZTEST HL', accNo: '555544443333', active: true } });
    made.banks.push(bank.id);
    const mkTxn = async (data) => { const t = await prisma.bankTransaction.create({ data: { bankAccountId: bank.id, reconStatus: 'Unmatched', ...data } }); made.txns.push(t.id); return t; };
    const mkLoan = async (data) => { const l = await prisma.handLoan.create({ data: { createdById: admin.u.id, ...data } }); made.loans.push(l.id); return l; };

    const A1 = await mkLoan({ name: `ZZTEST Ravi ${RUN}`, lender: `ZZTEST Ravi Kumar ${RUN}`, amount: 50000, dateTaken: '2026-09-01', notes: 'first loan' });
    const A2 = await mkLoan({ name: `ZZTEST Ravi ${RUN}`, lender: `ZZTEST Ravi Kumar ${RUN}`, amount: 30000, dateTaken: '2026-09-10', notes: 'second loan' });
    const B = await mkLoan({ name: `ZZTEST Sita ${RUN}`, lender: `ZZTEST Sita Devi ${RUN}`, amount: 20000, dateTaken: '2026-08-05', notes: 'with statement lines' });
    const C = await mkLoan({ name: `ZZTEST Gopi ${RUN}`, lender: null, amount: 10000, dateTaken: '2026-08-20', notes: 'plain, no lines' });
    const D = await mkLoan({ name: `ZZTEST Mohan ${RUN}`, lender: null, amount: 1000.5, dateTaken: '2026-07-01', notes: null });
    const lineIn = await mkTxn({ date: '2026-08-05', description: `NEFT CR QQ${RUN} CREDIT`, type: 'Credit', amount: 20000, balance: 120000, reference: 'ZZHL-IN', categoryKind: 'hand', counterparty: B.name });
    const lineOut = await mkTxn({ date: '2026-08-25', description: `NEFT DR QQ${RUN} REPAY`, type: 'Debit', amount: 5000, balance: 115000, reference: 'ZZHL-OUT', categoryKind: 'hand', counterparty: B.name });
    const linkIn = await prisma.handLoanLink.create({ data: { loanId: B.id, bankTxnId: lineIn.id, kind: 'taken', date: lineIn.date, amount: 20000, reference: 'ZZHL-IN', description: lineIn.description, linkedBy: 'ZZTEST' } });
    const linkOut = await prisma.handLoanLink.create({ data: { loanId: B.id, bankTxnId: lineOut.id, kind: 'repayment', date: lineOut.date, amount: 5000, reference: 'ZZHL-OUT', description: lineOut.description, linkedBy: 'ZZTEST' } });
    // an unrelated, unfiled line and a "person with money out but no entry yet"
    const lineWho = await mkTxn({ date: '2026-10-01', description: 'UPI/ZZTEST WHATTAKEN ' + RUN, type: 'Debit', amount: 2500, balance: 100000, reference: 'ZZHL-WHO', categoryKind: 'hand', counterparty: `ZZTEST Newperson ${RUN}` });

    // ------------------------------------------------------------ helpers over the COPY's own tables
    const loansNow = () => prisma.handLoan.findMany({ include: { links: true }, orderBy: { id: 'asc' } });
    const independent = async () => {
      const ls = await loansNow();
      const taken = ROUND(ls.reduce((s, l) => s + l.amount, 0));
      const repaid = ROUND(ls.reduce((s, l) => s + l.links.filter((x) => x.kind === 'repayment').reduce((a, x) => a + x.amount, 0), 0));
      const pending = ROUND(ls.reduce((s, l) => s + Math.max(0, l.amount - l.links.filter((x) => x.kind === 'repayment').reduce((a, x) => a + x.amount, 0)), 0));
      return { loans: ls.length, taken, repaid, pending };
    };
    const get = (tok = admin.t) => http('GET', '/api/bank/hand-loans', tok);
    const summaryOf = (r) => ({ loans: r.body.summary.loans, taken: r.body.summary.taken, repaid: r.body.summary.repaid, pending: r.body.summary.pending });
    const rowOf = async (id) => prisma.handLoan.findUnique({ where: { id }, include: { links: true } });
    const sum = async (id) => j(await rowOf(id));
    const stmtSig = async () => j((await prisma.bankTransaction.findMany({ orderBy: { id: 'asc' }, select: { id: true, bankAccountId: true, date: true, description: true, type: true, amount: true, balance: true, reference: true, reconStatus: true } })));
    const tableSig = async (t) => j(await prisma.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY "id"`));
    const OTHER = ['Invoice', 'InvoicePayment', 'BankAccount', 'OfficeExpense', 'LedgerAccount', 'JournalEntry', 'JournalLine', 'BankRule', 'BankMark', 'BankImport'];
    const otherSig = async () => { const o = {}; for (const t of OTHER) o[t] = await tableSig(t); return o; };
    const auditCount = (action, entityId) => prisma.auditLog.count({ where: { action, entityId } });

    const sigStmt0 = await stmtSig();
    const sigOther0 = await otherSig();
    const rowsOther0 = {}; for (const t of OTHER) rowsOther0[t] = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) c FROM "${t}"`))[0].c;

    // ------------------------------------------------------------ baseline
    const g0 = await get();
    const ind0 = await independent();
    check('B1 the list opens for the manager role and shows our 5 fixtures; summary equals an independent recomputation from the tables',
      g0.status === 200 && ['loans', 'taken', 'repaid', 'pending'].every((k) => summaryOf(g0)[k] === ind0[k]) && ind0.loans === 5 && ind0.repaid === 5000, [summaryOf(g0), ind0]);
    check('B2 every entry carries updatedAt and linkCount; the removed list exists and is empty', g0.body.loans.every((l) => l.updatedAt && typeof l.linkCount === 'number') && Array.isArray(g0.body.removed) && g0.body.removed.length === 0 && g0.body.loans.find((l) => l.id === B.id).linkCount === 2);
    check('B3 nothing is created by just looking: the removed-entries table does not exist before the first removal', (await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='HandLoanRemoved'")).length === 0);

    // ------------------------------------------------------------ V. validation, by the server
    const url = (id) => `/api/bank/hand-loans/${id}`;
    const before = await sum(A1.id); const count0 = await prisma.handLoan.count(); const aud0 = await prisma.auditLog.count({ where: { entity: 'HandLoan' } });
    const ok = { name: A1.name, lender: A1.lender, amount: 50000, dateTaken: '2026-09-01', notes: 'first loan' };
    const future = iso(new Date(Date.now() + 2 * 86400000));
    const bads = [
      ['empty name', { name: '' }], ['spaces for a name', { name: '   ' }], ['no name at all (null)', { name: null }], ['name of 200 letters', { name: 'x'.repeat(200) }],
      ['empty amount', { amount: '' }], ['null amount', { amount: null }], ['text amount', { amount: 'abc' }], ['amount 12abc', { amount: '12abc' }], ['zero amount', { amount: 0 }],
      ['negative amount', { amount: -5 }], ['negative amount text', { amount: '-100' }], ['Infinity text', { amount: 'Infinity' }], ['exponent text 1e9', { amount: '1e9' }], ['boolean amount', { amount: true }],
      ['array amount', { amount: [5] }], ['object amount', { amount: { a: 1 } }], ['huge amount', { amount: 1e12 }], ['three decimals', { amount: 10.005 }],
      ['empty date', { dateTaken: '' }], ['null date', { dateTaken: null }], ['month 13', { dateTaken: '2026-13-45' }], ['30 February', { dateTaken: '2026-02-30' }],
      ['words for a date', { dateTaken: 'tomorrow' }], ['dd-mm-yyyy', { dateTaken: '01-09-2026' }], ['future date', { dateTaken: future }], ['year 1850', { dateTaken: '1850-01-01' }],
    ];
    let allBad = true; const leaked = [];
    for (const [label, patch] of bads) {
      const r = await http('PUT', url(A1.id), admin.t, { ...ok, ...patch });
      if (r.status !== 400 || !r.body || !r.body.error || !r.body.fields) { allBad = false; leaked.push([label, r.status, r.text.slice(0, 120)]); }
    }
    check(`V1 ${bads.length} bad edits (empty / spaces / null name, text / zero / negative / Infinity / 1e9 / boolean / array / huge / 3-decimal amount, empty / null / month 13 / 30 Feb / words / dd-mm-yyyy / future / 1850 date) are all refused with 400 and the fields named`, allBad, leaked);
    check('V2 and not one of them changed the row, added a row or wrote an audit line', (await sum(A1.id)) === before && (await prisma.handLoan.count()) === count0 && (await prisma.auditLog.count({ where: { entity: 'HandLoan' } })) === aud0);
    const pb = await http('POST', '/api/bank/hand-loans', admin.t, { name: 'ZZTEST bad', amount: 'abc', dateTaken: future });
    const pb2 = await http('POST', '/api/bank/hand-loans', admin.t, { name: '', amount: 100, dateTaken: '2026-09-01' });
    const pb3 = await http('POST', '/api/bank/hand-loans', admin.t, { name: 'ZZTEST bad', amount: '1e9', dateTaken: '2026-09-01' });
    check('V3 adding an entry is checked the same way (bad amount + future date, no name, 1e9) and adds nothing', pb.status === 400 && pb2.status === 400 && pb3.status === 400 && (await prisma.handLoan.count()) === count0, [pb.status, pb2.status, pb3.status]);
    const miss = await http('PUT', url('does-not-exist'), admin.t, ok);
    check('V4 editing an entry that does not exist is a clear 404, not a crash', miss.status === 404 && miss.body.error, miss.text);

    // ------------------------------------------------------------ E. edit
    const dupRows0 = await prisma.handLoan.count();
    const otherSums0 = { A2: await sum(A2.id), B: await sum(B.id), C: await sum(C.id), D: await sum(D.id) };
    const t0 = (await rowOf(A1.id)).updatedAt;
    const ind1 = await independent();
    const e1 = await http('PUT', url(A1.id), admin.t, { name: A1.name, lender: A1.lender, amount: 55000.5, dateTaken: '2026-09-02', notes: 'edited note', expectedUpdatedAt: t0.toISOString() });
    const a1 = await rowOf(A1.id);
    check('E1 edit answers 200 with the same id and the new values', e1.status === 200 && e1.body.id === A1.id && e1.body.amount === 55000.5 && e1.body.dateTaken === '2026-09-02' && e1.body.notes === 'edited note', e1.text.slice(0, 300));
    check('E2 persisted in the table: amount, date and note changed; name and lender kept; updatedAt moved', a1.amount === 55000.5 && a1.dateTaken === '2026-09-02' && a1.notes === 'edited note' && a1.name === A1.name && a1.lender === A1.lender && a1.updatedAt > t0);
    check('E3 no duplicate: still exactly the same number of rows, and the same id', (await prisma.handLoan.count()) === dupRows0 && (await prisma.handLoan.count({ where: { name: A1.name } })) === 2);
    check('E4 the other entries (second Ravi entry, Sita, Gopi, Mohan) are byte-for-byte unchanged', (await sum(A2.id)) === otherSums0.A2 && (await sum(B.id)) === otherSums0.B && (await sum(C.id)) === otherSums0.C && (await sum(D.id)) === otherSums0.D);
    const ind2 = await independent(); const g2 = await get();
    check('E5 totals after the edit: taken +5000.50 and pending +5000.50 against the independent recomputation, repaid unchanged; the screen\'s summary equals it',
      ROUND(ind2.taken - ind1.taken) === 5000.5 && ROUND(ind2.pending - ind1.pending) === 5000.5 && ind2.repaid === ind1.repaid && ['loans', 'taken', 'repaid', 'pending'].every((k) => summaryOf(g2)[k] === ind2[k]), [ind1, ind2, summaryOf(g2)]);
    const rowA1 = g2.body.loans.find((l) => l.id === A1.id);
    check('E6 the entry card figures: amount 55000.50, pending 55000.50, nothing repaid, the new updatedAt is sent back', rowA1.amount === 55000.5 && rowA1.pending === 55000.5 && rowA1.repaid === 0 && new Date(rowA1.updatedAt).getTime() === a1.updatedAt.getTime());
    const au = await prisma.auditLog.findFirst({ where: { action: 'Hand loan updated', entityId: A1.id }, orderBy: { createdAt: 'desc' } });
    check('E7 the audit line records who and old -> new for each changed field (amount, date taken, notes), not the unchanged ones', au && au.userId === admin.u.id && /amount ₹50,000\.00/.test(au.fromValue) && /amount ₹55,000\.50/.test(au.toValue) && /date taken 2026-09-01/.test(au.fromValue) && /date taken 2026-09-02/.test(au.toValue) && /notes first loan/.test(au.fromValue) && !/name/.test(au.toValue), au);

    // no change at all: harmless
    const auditsBefore = await auditCount('Hand loan updated', A1.id); const tBefore = (await rowOf(A1.id)).updatedAt;
    const e0 = await http('PUT', url(A1.id), admin.t, { name: A1.name, lender: A1.lender, amount: 55000.5, dateTaken: '2026-09-02', notes: 'edited note' });
    check('E8 saving without changing anything answers 200 "unchanged", writes no audit line and does not touch updatedAt', e0.status === 200 && e0.body.unchanged === true && (await auditCount('Hand loan updated', A1.id)) === auditsBefore && (await rowOf(A1.id)).updatedAt.getTime() === tBefore.getTime(), e0.text.slice(0, 200));

    // a partial body (only the note) keeps every other field
    const e9 = await http('PUT', url(D.id), admin.t, { notes: 'only the note' });
    const d1 = await rowOf(D.id);
    check('E9 a body with only the note changes only the note (name, amount 1000.50, date and the rest stay)', e9.status === 200 && d1.notes === 'only the note' && d1.amount === 1000.5 && d1.name === D.name && d1.dateTaken === '2026-07-01');
    await prisma.handLoan.update({ where: { id: D.id }, data: { notes: null } });

    // rename an entry that has statement lines: the lines carry the new label; the statement facts do not move
    const e10 = await http('PUT', url(B.id), admin.t, { name: `ZZTEST Sita Renamed ${RUN}` });
    const lnIn = await prisma.bankTransaction.findUnique({ where: { id: lineIn.id } }); const lnOut = await prisma.bankTransaction.findUnique({ where: { id: lineOut.id } });
    check('E10 renaming an entry with statement lines: its two lines show the new name as counterparty, and only that label', e10.status === 200 && lnIn.counterparty === `ZZTEST Sita Renamed ${RUN}` && lnOut.counterparty === `ZZTEST Sita Renamed ${RUN}` && lnIn.amount === 20000 && lnIn.date === '2026-08-05' && lnIn.description === lineIn.description);
    const stmtAfterEdits = await stmtSig();
    check('E11 every bank statement line (date, narration, type, amount, balance, reference, bank, status) is byte-for-byte what it was before all the edits', stmtAfterEdits === sigStmt0);

    // ------------------------------------------------------------ G. guards
    const gA = await http('PUT', url(B.id), admin.t, { amount: 15000 });
    check('G1 the statement shows 20000 coming in: an amount of 15000 is refused, in plain words, naming the statement and what to do', gA.status === 400 && /statement shows ₹20,000\.00/.test(gA.body.error) && /Unlink/.test(gA.body.error) && gA.body.fields.amount, gA.text);
    const gB = await http('PUT', url(B.id), admin.t, { amount: 4000 });
    check('G2 an amount below what is already paid back (5000) is refused', gB.status === 400 && /already paid back/.test(gB.body.error), gB.text);
    const gC = await http('PUT', url(B.id), admin.t, { dateTaken: '2026-09-15' });
    check('G3 a date taken after a repayment (2026-08-25) is refused', gC.status === 400 && /repayment is dated 2026-08-25/.test(gC.body.error), gC.text);
    const gD = await http('PUT', url(B.id), admin.t, { amount: 20010 });
    check('G4 an amount within the statement\'s ₹20 slack is accepted (the same slack the matching uses)', gD.status === 200 && (await rowOf(B.id)).amount === 20010, gD.text);
    await prisma.handLoan.update({ where: { id: B.id }, data: { amount: 20000 } });
    const gE = await http('PUT', url(A2.id), admin.t, { name: A1.name, amount: 55000.5, dateTaken: '2026-09-02' });
    check('G5 turning one entry into a copy of another (same name, amount, date) is refused as a duplicate and changes nothing', gE.status === 400 && /duplicate/i.test(gE.body.error) && (await sum(A2.id)) === otherSums0.A2, gE.text);
    const stale = await http('PUT', url(A2.id), admin.t, { notes: 'stale try', expectedUpdatedAt: new Date(Date.now() - 86400000).toISOString() });
    check('G6 a save made on an old copy of the entry (someone else changed it) is refused with 409 and writes nothing', stale.status === 409 && /Someone else/.test(stale.body.error) && (await sum(A2.id)) === otherSums0.A2, stale.text);
    const fresh = await http('PUT', url(A2.id), admin.t, { notes: 'fresh try', expectedUpdatedAt: (await rowOf(A2.id)).updatedAt.toISOString() });
    check('G7 a save made on the current copy goes through', fresh.status === 200 && (await rowOf(A2.id)).notes === 'fresh try', fresh.text);
    await prisma.handLoan.update({ where: { id: A2.id }, data: { notes: 'second loan' } });
    // closed books
    await prisma.appSetting.upsert({ where: { key: 'accounts.booksClosedUpTo' }, create: { key: 'accounts.booksClosedUpTo', value: '"2026-09"' }, update: { value: '"2026-09"' } });
    const cl1 = await http('PUT', url(A2.id), admin.t, { amount: 31000 });
    const cl2 = await http('PUT', url(A2.id), admin.t, { notes: 'note inside a closed month is fine' });
    const cl3 = await http('DELETE', url(A2.id), admin.t, { reason: 'closed month try' });
    check('G8 books closed up to 2026-09: changing the amount or removing an entry taken in that month is refused; a note can still be fixed', cl1.status === 400 && /books are closed/.test(cl1.body.error) && cl3.status === 400 && /books are closed/.test(cl3.body.error) && cl2.status === 200 && (await rowOf(A2.id)).amount === 30000, [cl1.status, cl2.status, cl3.status]);
    await prisma.appSetting.update({ where: { key: 'accounts.booksClosedUpTo' }, data: { value: 'null' } });
    await prisma.handLoan.update({ where: { id: A2.id }, data: { notes: 'second loan' } });

    // ------------------------------------------------------------ M. a person with several entries
    const m0 = { A1: await sum(A1.id) };
    const pick = await http('PUT', url(A2.id), admin.t, { amount: 33000, notes: 'picked the second one', expectedUpdatedAt: (await rowOf(A2.id)).updatedAt.toISOString() });
    const gm = await get();
    const ravi = gm.body.loans.filter((l) => l.name === A1.name);
    check('M1 two entries for one person: both are listed; editing the second one changes the second one only', pick.status === 200 && ravi.length === 2 && ravi.find((l) => l.id === A2.id).amount === 33000 && (await sum(A1.id)) === m0.A1, ravi.map((l) => [l.id === A1.id ? 'A1' : 'A2', l.amount]));
    const ind3 = await independent();
    check('M2 the person\'s total moves by exactly the difference (+3000) in the independent recomputation and in the screen', ROUND(ind3.taken - ind2.taken) === 3000 && summaryOf(gm).taken === ind3.taken && summaryOf(gm).pending === ind3.pending, [ind2, ind3, summaryOf(gm)]);
    const pk = H.pickerRows(gm.body.loans, 'ravi');
    check('M3 the picker (pure helper) lists both of that person\'s entries newest first, each with date, amount and note, and says there are 2', pk.length === 2 && pk[0].id === A2.id && pk[1].id === A1.id && H.entriesOfPerson(gm.body.loans, pk[0]) === 2);

    // ------------------------------------------------------------ R. remove
    const r1 = await http('DELETE', url(C.id), admin.t);
    const r2 = await http('DELETE', url(C.id), admin.t, { reason: '  ' });
    const r3 = await http('DELETE', url(C.id), admin.t, { reason: 'ab' });
    check('R1 removing needs a reason (none / blank / 2 letters all refused with 400); nothing moves', [r1, r2, r3].every((r) => r.status === 400 && r.body.fields && r.body.fields.reason) && !!(await rowOf(C.id)));
    const indR0 = await independent(); const sA = await sum(A1.id); const sA2 = await sum(A2.id); const sB = await sum(B.id); const sD = await sum(D.id);
    const linksBefore = await prisma.handLoanLink.count();
    const rm = await http('DELETE', url(C.id), admin.t, { reason: 'Entered by mistake' });
    check('R2 remove with a reason answers 200 { removed, already: false }', rm.status === 200 && rm.body.removed === C.id && rm.body.already === false, rm.text);
    const gone = await rowOf(C.id);
    const arch = await prisma.$queryRawUnsafe('SELECT * FROM "HandLoanRemoved" WHERE "loanId" = ?', C.id);
    check('R3 the entry has left HandLoan and sits whole in HandLoanRemoved: name, amount, date, note, reason, who, when and a full snapshot', !gone && arch.length === 1 && arch[0].name === C.name && arch[0].amount === 10000 && arch[0].dateTaken === '2026-08-20' && arch[0].reason === 'Entered by mistake' && arch[0].removedById === admin.u.id && /ZZTEST HL admin/.test(arch[0].removedByName) && Number(arch[0].removedAt) > Date.now() - 60000 && JSON.parse(arch[0].snapshot).id === C.id, arch);
    const indR1 = await independent(); const gr = await get();
    check('R4 totals: taken and pending fall by exactly 10000 (independent recomputation), repaid unchanged, and the screen\'s summary equals it', ROUND(indR0.taken - indR1.taken) === 10000 && ROUND(indR0.pending - indR1.pending) === 10000 && indR0.repaid === indR1.repaid && indR1.loans === indR0.loans - 1 && ['loans', 'taken', 'repaid', 'pending'].every((k) => summaryOf(gr)[k] === indR1[k]), [indR0, indR1, summaryOf(gr)]);
    check('R5 history kept: the list no longer shows it, the removed list does (reason, by, when); the audit log has the reason', !gr.body.loans.some((l) => l.id === C.id) && gr.body.removed.length === 1 && gr.body.removed[0].loanId === C.id && gr.body.removed[0].reason === 'Entered by mistake' && /ZZTEST HL admin/.test(gr.body.removed[0].removedByName) && (await prisma.auditLog.count({ where: { action: 'Hand loan removed', entityId: C.id, reason: 'Entered by mistake' } })) === 1);
    check('R6 only the chosen entry went: every other entry and every link is byte-for-byte unchanged', (await sum(A1.id)) === sA && (await sum(A2.id)) === sA2 && (await sum(B.id)) === sB && (await sum(D.id)) === sD && (await prisma.handLoanLink.count()) === linksBefore);
    const again = await http('DELETE', url(C.id), admin.t, { reason: 'second press' });
    check('R7 a second press is harmless: 200 { already: true }, no second archive row, no second audit line', again.status === 200 && again.body.already === true && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "HandLoanRemoved" WHERE "loanId" = ?', C.id))[0].c) === 1 && (await prisma.auditLog.count({ where: { action: 'Hand loan removed', entityId: C.id } })) === 1, again.text);
    const D2 = await mkLoan({ name: `ZZTEST Twice ${RUN}`, lender: null, amount: 700, dateTaken: '2026-07-15', notes: 'double press' });
    const [t1, t2, t3] = await Promise.all([1, 2, 3].map(() => http('DELETE', url(D2.id), admin.t, { reason: 'pressed three times at once' })));
    check('R8 three presses at the same moment: all answer 200, exactly one archive row and one audit line', [t1, t2, t3].every((r) => r.status === 200) && [t1, t2, t3].filter((r) => r.body.already === false).length === 1 && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "HandLoanRemoved" WHERE "loanId" = ?', D2.id))[0].c) === 1 && (await prisma.auditLog.count({ where: { action: 'Hand loan removed', entityId: D2.id } })) === 1, [t1.text, t2.text, t3.text]);
    const edGone = await http('PUT', url(C.id), admin.t, { notes: 'edit a removed one' });
    check('R9 editing a removed entry is refused with 410 and a plain sentence', edGone.status === 410 && /removed/.test(edGone.body.error), edGone.text);
    const nope = await http('DELETE', url('never-existed'), admin.t, { reason: 'does not exist' });
    check('R10 removing something that never existed is a 404', nope.status === 404, nope.text);

    // blocked by linked lines
    const stmtBeforeBlock = await stmtSig(); const bSig = await sum(B.id);
    const blk = await http('DELETE', url(B.id), admin.t, { reason: 'try to remove with lines' });
    check('R11 an entry with the taking line and a repayment linked cannot be removed: 409, a plain message naming both, nothing moved, links intact, statement untouched',
      blk.status === 409 && blk.body.blocked === true && /Unlink them first/.test(blk.body.error) && /repayment line/.test(blk.body.error) && /taken on/.test(blk.body.error) && (await sum(B.id)) === bSig && (await prisma.handLoanLink.count({ where: { loanId: B.id } })) === 2 && (await stmtSig()) === stmtBeforeBlock, blk.text);
    const ulOut = await http('DELETE', `/api/bank/hand-loans/links/${linkOut.id}`, admin.t);
    const stillBlocked = await http('DELETE', url(B.id), admin.t, { reason: 'one line left' });
    const ulIn = await http('DELETE', `/api/bank/hand-loans/links/${linkIn.id}`, admin.t);
    const rmB = await http('DELETE', url(B.id), admin.t, { reason: 'Loan was cancelled' });
    check('R12 after the existing "Remove" on each movement unlinks the lines, the entry can be removed; with one line still linked it stays blocked', ulOut.status === 200 && stillBlocked.status === 409 && ulIn.status === 200 && rmB.status === 200 && !(await rowOf(B.id)) && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "HandLoanRemoved" WHERE "loanId" = ?', B.id))[0].c) === 1, [ulOut.status, stillBlocked.status, ulIn.status, rmB.status]);
    check('R13 the two statement lines still exist with the same date / narration / amount / balance; only the "filed as hand loan" label went when they were unlinked', (await stmtSig()) === stmtBeforeBlock && (await prisma.bankTransaction.findUnique({ where: { id: lineIn.id } })).categoryKind === null);
    const arr = await get();
    check('R14 the removed list now shows 3 entries (Gopi, Twice, Sita) with their own reasons', arr.body.removed.length === 3 && new Set(arr.body.removed.map((x) => x.reason)).size === 3, arr.body.removed.map((x) => [x.name, x.reason]));

    // ------------------------------------------------------------ P. permissions
    const snapP = { A1: await sum(A1.id), A2: await sum(A2.id), D: await sum(D.id) }; const cntP = await prisma.handLoan.count(); const archP = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "HandLoanRemoved"'))[0].c);
    const body = { name: 'ZZTEST nope', amount: 100, dateTaken: '2026-09-01', notes: 'blocked' };
    const refuse = async (who, label) => {
      const rs = [await http('PUT', url(A1.id), who.t, { notes: 'sneaky' }), await http('DELETE', url(D.id), who.t, { reason: 'sneaky remove' }), await http('POST', '/api/bank/hand-loans', who.t, body), await http('POST', `/api/bank/hand-loans/${D.id}/link`, who.t, { bankTxnId: lineWho.id }), await http('DELETE', `/api/bank/hand-loans/links/${linkIn.id}`, who.t)];
      check(`P ${label}: edit, remove, add, link and unlink are all refused (${rs.map((r) => r.status).join('/')})`, rs.every((r) => r.status === 403 || r.status === 401), rs.map((r) => r.text.slice(0, 80)));
      return rs;
    };
    // every role the app knows: the API must answer exactly what the permission engine (the same one the screen uses to draw the
    // buttons) says about Bank & Reconciliation view / edit. Roles that may edit can; every other role gets 403 and nothing moves.
    const { can } = require(path.join(BACK, 'src/utils/permissions'));
    const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR', 'RECRUITER', 'BDE', 'CLIENT', 'ACCOUNTANT', 'EMPLOYEE'];
    const PROBE = await mkLoan({ name: `ZZTEST Probe ${RUN}`, lender: null, amount: 100, dateTaken: '2026-07-02', notes: 'p0' });
    const matrix = []; let matrixOk = true; const wrong = []; let viewOnlyRole = null;
    for (const role of ROLES) {
      const who = await mkUser(`r-${role}`, { role: ['SUPER_ADMIN', 'ADMIN'].includes(role) ? role : 'EMPLOYEE', accountsRole: role, accountsAccess: true });
      const ident = await resolveIdentity(who.u.id);
      const v = await can(ident, 'accounts', 'accounts', 'Bank & Reconciliation', 'view');
      const e = await can(ident, 'accounts', 'accounts', 'Bank & Reconciliation', 'edit');
      const rg = await get(who.t);
      const rp = await http('PUT', url(PROBE.id), who.t, { notes: `by ${role}` });
      const rd = await http('DELETE', url('probe-never-existed'), who.t, { reason: 'probe only' });
      const exp = { get: v ? 200 : 403, put: e ? 200 : 403, del: e ? 404 : 403 };
      const got = { get: rg.status, put: rp.status, del: rd.status };
      matrix.push(`${role}: view ${v ? 'yes' : 'no'}, edit ${e ? 'yes' : 'no'} -> GET ${got.get}, PUT ${got.put}, DELETE ${got.del}`);
      if (got.get !== exp.get || got.put !== exp.put || got.del !== exp.del) { matrixOk = false; wrong.push([role, exp, got]); }
      if (v && !e && !viewOnlyRole) viewOnlyRole = who;
    }
    console.log('      ' + matrix.join('\n      '));
    check(`P1 all ${ROLES.length} roles: the API answers exactly what the permission engine says (view -> can read the list; edit -> can edit and remove; no edit -> 403 on both)`, matrixOk, wrong);
    check('P1b a role that may edit changed the probe entry; the others did not (the note on it is from the last editing role, never from a refused one)', !/^by (EMPLOYEE|RECRUITER|CLIENT|BDE)$/.test((await rowOf(PROBE.id)).notes));
    if (viewOnlyRole) {
      const viewerGet = await get(viewOnlyRole.t);
      await refuse(viewOnlyRole, 'P2 a view-only login');
      check('P2b the view-only login can still read the list (nothing taken away) and sees the same totals', viewerGet.status === 200 && summaryOf(viewerGet).taken === summaryOf(await get()).taken, viewerGet.status);
    } else {
      check('P2 no role today holds Bank & Reconciliation view without edit, so there is no view-only login to try (the matrix above covers all 12)', true);
    }
    await refuse(rec, 'P3 a Recruiter with Accounts set to None');
    const noTok = [await http('PUT', url(A1.id), null, { notes: 'x' }), await http('DELETE', url(D.id), null, { reason: 'xxx' })];
    check('P4 no login at all: 401 on both', noTok.every((r) => r.status === 401), noTok.map((r) => r.status));
    check('P5 after all those refused calls nothing changed: same entries, same removed list, same links', (await sum(A1.id)) === snapP.A1 && (await sum(A2.id)) === snapP.A2 && (await sum(D.id)) === snapP.D && (await prisma.handLoan.count()) === cntP + 1 && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "HandLoanRemoved"'))[0].c) === archP);
    const acc = await http('PUT', url(D.id), acct.t, { notes: 'accountant edit' });
    const accRm = await http('DELETE', url(D.id), acct.t, { reason: 'Duplicate entry' });
    check('P6 the Accountant (who can manage Bank & Reconciliation today) can edit and remove, exactly as before', acc.status === 200 && accRm.status === 200 && !(await rowOf(D.id)), [acc.status, accRm.status]);
    const audRm = await prisma.auditLog.findFirst({ where: { action: 'Hand loan removed', entityId: D.id } });
    check('P7 the audit line names the Accountant (userId) and the reason', audRm && audRm.userId === acct.u.id && audRm.reason === 'Duplicate entry', audRm);

    // ------------------------------------------------------------ W. "+ What was taken" still works
    const g5 = await get();
    const un = g5.body.unentered.find((u) => u.name === `ZZTEST Newperson ${RUN}`);
    check('W1 a person paid out with no entry yet is listed under "no entry" (the + What was taken button\'s source)', !!un && un.out === 2500, g5.body.unentered.map((u) => u.name));
    const cnt = await prisma.handLoan.count();
    const add = await http('POST', '/api/bank/hand-loans', admin.t, { name: `ZZTEST Newperson ${RUN}`, lender: `ZZTEST Newperson ${RUN}`, amount: 12000, dateTaken: '2026-09-30', notes: 'what was taken' });
    check('W2 + What was taken: 201, exactly one new row, with the typed values', add.status === 201 && (await prisma.handLoan.count()) === cnt + 1 && add.body.amount === 12000 && add.body.dateTaken === '2026-09-30', add.text.slice(0, 200));
    made.loans.push(add.body.id);
    const g6 = await get();
    check('W3 the person is no longer under "no entry"; the totals include the new entry and still equal the independent recomputation', !g6.body.unentered.some((u) => u.name === `ZZTEST Newperson ${RUN}`) && summaryOf(g6).taken === (await independent()).taken && summaryOf(g6).pending === (await independent()).pending);
    const addNone = await http('POST', '/api/bank/hand-loans', admin.t, { name: `ZZTEST Plain ${RUN}`, amount: '1,500.25', dateTaken: iso(new Date()) });
    check('W4 an amount typed with a comma ("1,500.25") and today as the date are accepted', addNone.status === 201 && addNone.body.amount === 1500.25, addNone.text.slice(0, 200));
    if (addNone.body && addNone.body.id) made.loans.push(addNone.body.id);
    const rmNew = await http('DELETE', url(add.body.id), admin.t, { reason: 'test cleanup of the new one' });
    check('W5 the new entry can be edited and removed from the same endpoints', (await http('PUT', url(addNone.body.id), admin.t, { notes: 'x' })).status === 200 && rmNew.status === 200);

    // ------------------------------------------------------------ U. nothing else moved
    const stmtEnd = await stmtSig();
    const diffStmt = j(JSON.parse(stmtEnd).filter((r) => !made.txns.includes(r.id))) === j(JSON.parse(sigStmt0).filter((r) => !made.txns.includes(r.id)));
    check('U1 every REAL bank statement line (all columns above) is byte-for-byte unchanged by everything this test did', diffStmt);
    check('U2 our own ZZTEST statement lines kept date / narration / amount / balance / reference / status too', stmtEnd === sigStmt0);
    const otherEnd = await otherSig(); const diffTables = OTHER.filter((t) => otherEnd[t] !== sigOther0[t]);
    check(`U3 invoices, payments, banks, office expenses, the books (ledger accounts, journal), bank rules and marks are byte-for-byte unchanged (${OTHER.map((t) => `${t} ${rowsOther0[t]}`).join(', ')} rows)`, diffTables.length === 0, diffTables);
    const real = new (require('node:sqlite').DatabaseSync)(REAL, { readOnly: true });
    check('U4 the real database was not written: it has no HandLoanRemoved table and no ZZTEST hand loan', real.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='HandLoanRemoved'").get().c === 0 && real.prepare("SELECT COUNT(*) c FROM HandLoan WHERE name LIKE 'ZZTEST%'").get().c === 0);
    real.close();

    // ------------------------------------------------------------ unit: planEdit / validation
    const U = HLC;
    check('K1 unit: isRealDate / parseAmount', U.isRealDate('2026-02-28') && !U.isRealDate('2026-02-29') && U.isRealDate('2028-02-29') && U.parseAmount('1,23,456.78') === 123456.78 && U.parseAmount('12x') === null && U.parseAmount(true) === null && U.parseAmount([1]) === null && U.parseAmount(NaN) === null && U.parseAmount('') === null);
    const pe = U.planEdit({ loan: { id: 'x', name: 'N', lender: null, amount: 100, dateTaken: '2026-01-01', notes: null }, figures: { taken: null, repayments: [], repaid: 0 }, body: { dateTaken: '2026-01-02' }, today: '2026-01-02' });
    const pf = U.planEdit({ loan: { id: 'x', name: 'N', lender: null, amount: 100, dateTaken: '2026-01-01', notes: null }, figures: { taken: null, repayments: [], repaid: 0 }, body: { dateTaken: '2026-01-03' }, today: '2026-01-02' });
    check('K2 unit: today is allowed as the date taken, tomorrow is not; an old future-dated entry may still have its note fixed', pe.changes && pe.changes.join() === 'dateTaken' && pf.status === 400 && U.planEdit({ loan: { id: 'x', name: 'N', lender: null, amount: 100, dateTaken: '2030-01-01', notes: null }, figures: { taken: null, repayments: [], repaid: 0 }, body: { notes: 'fix' }, today: '2026-01-02' }).changes.join() === 'notes');

    // ------------------------------------------------------------ F. frontend
    const tt = '2026-10-19';
    check('F1 form rules (pure): empty name / text, zero, negative and 3-decimal amounts / bad, future dates are refused with words; a good entry has no problem',
      H.entryProblems({ name: '', amount: 'abc', dateTaken: '2026-13-01' }, tt).name && H.entryProblems({ name: 'a', amount: 0, dateTaken: tt }, tt).amount && H.entryProblems({ name: 'a', amount: '-3', dateTaken: tt }, tt).amount && H.entryProblems({ name: 'a', amount: '1.005', dateTaken: tt }, tt).amount
      && H.entryProblems({ name: 'a', amount: 5, dateTaken: '2026-10-20' }, tt).dateTaken && H.entryProblems({ name: 'a', amount: 5, dateTaken: '2026-02-30' }, tt).dateTaken && Object.keys(H.entryProblems({ name: 'Ravi', amount: '1,00,000.50', dateTaken: tt }, tt)).length === 0);
    check('F2 the browser and the server agree on every bad case that V1 sent (same verdict)', bads.every(([, patch]) => {
      const f = { ...ok, ...patch };
      const server = Object.keys(U.loanProblems(f, { today: iso(new Date()) })).length > 0;
      const client = Object.keys(H.entryProblems(f, iso(new Date()))).length > 0;
      return server === client && client === true;
    }), bads.filter(([, patch]) => Object.keys(H.entryProblems({ ...ok, ...patch }, iso(new Date()))).length === 0).map((b) => b[0]));
    check('F3 reason rule (pure): blank / 2 letters refused, 3 letters fine; the quick reasons are all long enough', !!H.reasonProblem('') && !!H.reasonProblem(' ab ') && !H.reasonProblem('dup') && H.REASON_CHIPS.every((c) => !H.reasonProblem(c)));
    check('F4 remove block (pure): linked lines give a plain sentence naming them; none gives null', /3 bank statement lines are still linked/.test(H.removeBlock({ linkCount: 3, taken: { x: 1 }, repayments: [{}, {}] }) || '') && /2 repayment lines/.test(H.removeBlock({ linkCount: 3, taken: { x: 1 }, repayments: [{}, {}] })) && H.removeBlock({ linkCount: 0 }) === null);
    check('F5 picker search (pure): by name, amount, date or note; nothing typed lists all; unknown text lists none', H.pickerRows(gm.body.loans, '').length === gm.body.loans.length && H.pickerRows(gm.body.loans, '33000').length === 1 && H.pickerRows(gm.body.loans, 'picked the second').length === 1 && H.pickerRows(gm.body.loans, 'zzzzqqq').length === 0 && H.pickerRows(gm.body.loans, '2026-09-02').length === 1);

    const jsx = fs.readFileSync(path.join(FE, 'src/pages/bank/HandLoans.jsx'), 'utf8');
    const css = fs.readFileSync(path.join(FE, 'src/pages/bank/handLoanActions.css'), 'utf8');
    const head = (/<div className="hla-title-row">([\s\S]*?)<\/div>\s*\)\}\s*<\/div>/.exec(jsx) || [])[1] || '';
    check('F6 source: Edit and Remove sit in the SAME row as the heading (hla-title-row > h3 + hla-acts), only when the person may manage (canManage), with a pencil and a trash icon', /<h3>Hand loans/.test(head) && /canManage && \(/.test(jsx.slice(jsx.indexOf('hla-title-row') - 50, jsx.indexOf('hla-title-row') + 400)) && /hla-btn edit/.test(head) && /hla-btn remove/.test(head) && /PencilIcon/.test(head) && /TrashIcon/.test(head) && />\s*<PencilIcon \/>Edit/.test(head) && />\s*<TrashIcon \/>Remove/.test(head), head.slice(0, 300));
    check('F7 look: Edit is blue-outlined, Remove red-outlined, both small (30px) and in one row; on a phone they wrap under the heading and grow to 34px', /\.hla-btn\.edit \{ border: 1\.5px solid #2358a3; color: #2358a3/.test(css) && /\.hla-btn\.remove \{ border: 1\.5px solid var\(--s6-red\)/.test(css) && /height: 30px/.test(css) && /flex-wrap: wrap/.test(css) && /@media \(max-width: 720px\)/.test(css));
    check('F8 the buttons are real: both are disabled while a request runs or there is nothing to pick; one entry goes straight to its window, several open the "which entry?" list', /disabled=\{!data \|\| !data\.loans\.length \|\| busy\}/.test(jsx) && /loans\.length === 1/.test(jsx) && /setPick\(mode\)/.test(jsx) && /<EntryPicker/.test(jsx));
    check('F9 Remove: a window (not the browser\'s confirm box) with the entry\'s name, amount, date, paid back, still to clear and note, a reason, Cancel and Confirm Remove; locked while the request runs', !/window\.confirm/.test(jsx) && /Confirm Remove/.test(jsx) && /if \(busy\) return;/.test(jsx) && /disabled=\{busy \|\| !!blocked\}/.test(jsx) && /Paid back so far/.test(jsx) && /Why are you removing it\?/.test(jsx) && /api\.delete\(`\/bank\/hand-loans\/\$\{loan\.id\}`, \{ data: \{ reason/.test(jsx));
    check('F10 Edit: the old form is reused, prefilled, sends expectedUpdatedAt, locks Save while saving, shows success on the page and errors in the form', /loan\?\.amount|loan \? String\(loan\.amount\)/.test(jsx) && /expectedUpdatedAt = loan\.updatedAt/.test(jsx) && /disabled=\{busy\} onClick=\{save\}/.test(jsx) && /Entry updated/.test(jsx) && /setFail\(err\.response\?\.data\?\.error/.test(jsx));
    check('F11 the existing screen is all still there: "+ Hand entry", "+ What was taken", Match statement lines, Unlink, per-movement Remove, View line, search / filter / sort, Possible matches',
      ['+ Hand entry', '+ What was taken', 'Match statement lines', 'Unlink', 'View line', 'ListFilterBar', 'LOAN_SORTS', 'Possible matches', 'Month by month', 'Every movement', 'Each hand entry', 'Person by person'].every((s) => jsx.includes(s)));
    check('F12 plain words: nothing the founder reads says "Draft"; no red required stars in the new code', !/draft/i.test(fs.readFileSync(path.join(FE, 'src/pages/bank/handLoanActions.js'), 'utf8') + css) && !/draft/i.test(jsx.slice(jsx.indexOf('const PencilIcon'), jsx.indexOf('// Search · Status'))) && !/\*<\/|required/.test(jsx.slice(jsx.indexOf('const PencilIcon'), jsx.indexOf('// Search · Status'))));
    const backend = fs.readFileSync(path.join(BACK, 'src/routes/bank.js'), 'utf8');
    check('F13 the API: edit and remove go through the shared write guard (Bank & Reconciliation: edit) and the removal never deletes without the snapshot (utils/handLoanChanges.js)', /requireBankWrite/.test(backend) && /HLC\.removeLoan/.test(backend) && !/prisma\.handLoan\.delete\(/.test(backend) && /INSERT INTO "HandLoanRemoved"/.test(fs.readFileSync(path.join(BACK, 'src/utils/handLoanChanges.js'), 'utf8')));
  } catch (e) {
    console.error('TEST CRASHED', e);
    fail += 1;
  } finally {
    // ---------------------------------------------------------- clean every ZZTEST row from the COPY
    try {
      const ids = made.loans;
      await prisma.handLoanLink.deleteMany({ where: { OR: [{ loanId: { in: ids } }, { bankTxnId: { in: made.txns } }] } }).catch(() => {});
      await prisma.handLoan.deleteMany({ where: { OR: [{ id: { in: ids } }, { name: { startsWith: 'ZZTEST' } }] } }).catch(() => {});
      await prisma.$executeRawUnsafe('DELETE FROM "HandLoanRemoved" WHERE "name" LIKE \'ZZTEST%\'').catch(() => {});
      await prisma.bankTransaction.deleteMany({ where: { id: { in: made.txns } } }).catch(() => {});
      await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
      const left = await prisma.handLoan.count({ where: { name: { startsWith: 'ZZTEST' } } }).catch(() => -1);
      check('Z1 every ZZTEST fixture is cleaned out of the copy', left === 0 && (await prisma.bankTransaction.count({ where: { id: { in: made.txns } } })) === 0 && (await prisma.user.count({ where: { id: { in: made.users } } })) === 0, left);
    } catch (err) { console.error('cleanup problem', err.message); fail += 1; }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    if (ownCopy) for (const x of ['', '-wal', '-shm']) { try { fs.unlinkSync(copy + x); } catch { /* gone */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
