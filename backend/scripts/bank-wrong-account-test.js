#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A STATEMENT OF ONE BANK IS NOT IMPORTED INTO ANOTHER BANK'S ACCOUNT (founder 2026-10-29) - COPY DATABASE ONLY.
//   cd backend
//   node scripts/bank-wrong-account-test.js     makes its own VACUUM INTO copy of the real database (opened READ-ONLY) in the
//                                               temp folder, starts its OWN throw-away API on it and deletes the copy after
// Needs one HDFC and one ICICI account in the database (the copy's real ones are used; nothing reaches the real database).
//   U  utils/bankFormat: ICICI / HDFC / unknown column sets, the verdict and its message
//   P  preview of an ICICI file into HDFC: the warning names the ICICI account; into ICICI: no warning
//   B  the batch door: refused (409, nothing saved) until the account is right or the person says yes
//   C  the one-step /commit door: the same rule; a file whose bank cannot be told is never refused
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const copy = path.join(os.tmpdir(), `bank-wrong-acct-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const BF = require(path.join(BACK, 'src/utils/bankFormat'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const RUN = Date.now().toString(36);
let API = '';

async function freePort() {
  for (let i = 0; i < 60; i += 1) {
    const p = 4050 + Math.floor(Math.random() * 49);
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error('no free port');
}
async function http(method, p, token, body) {
  const h = { Authorization: `Bearer ${token}` };
  let payload;
  if (body instanceof FormData) payload = body; else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

const ICICI_HEAD = ['Tran. Id', 'Value Date', 'Transaction Date', 'Transaction Posted Date', 'Cheque. No./Ref. No.', 'Transaction Remarks', 'Withdrawal Amt (INR)', 'Deposit Amt (INR)', 'Balance (INR)'];
const HDFC_HEAD = ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'];
const PLAIN_HEAD = ['Date', 'Narration', 'Withdrawal', 'Deposit', 'Balance'];
const rowsFor = (tag) => [1, 2, 3].map((i) => ({ d: `2026-10-0${i}`, n: `ZZTEST WRONGBANK ${tag} ${RUN} line ${i}`, cr: i === 2 ? null : 1000 + i + tag.charCodeAt(0), dr: i === 2 ? 250 + tag.charCodeAt(0) : null, b: 50000 + i * 10 + tag.charCodeAt(0) * 7 }));
const xlsx = (head, rows) => {
  const cell = (h, x, i) => {
    if (/tran\. id/i.test(h)) return `S${RUN}${i}`;
    if (/date|^value dt$/i.test(h)) return x.d;
    if (/remarks|narration/i.test(h)) return x.n;
    if (/ref/i.test(h)) return '';
    if (/withdraw/i.test(h)) return x.dr == null ? '' : x.dr;
    if (/deposit/i.test(h)) return x.cr == null ? '' : x.cr;
    if (/balance/i.test(h)) return x.b;
    return '';
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows.map((x, i) => head.map((h) => cell(h, x, i)))]), 'Statement');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const form = (buf, name, fields = {}) => {
  const fd = new FormData();
  fd.append('kind', 'bank');
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  fd.append('file', new Blob([buf]), name);
  return fd;
};

(async () => {
  let server; const users = [];
  try {
    // U - pure
    check('U1 ICICI columns -> ICICI', BF.bankOfColumns(ICICI_HEAD) === 'ICICI');
    check('U2 HDFC columns -> HDFC', BF.bankOfColumns(HDFC_HEAD) === 'HDFC');
    check('U3 plain columns -> not told (null)', BF.bankOfColumns(PLAIN_HEAD) === null);
    const accs = [{ id: 'h', bank: 'HDFC Bank', accNo: '' }, { id: 'i', bank: 'ICICI Bank', accNo: '180605003333' }];
    const v = BF.checkAccount('ICICI', accs[0], accs);
    check('U4 ICICI file into HDFC: not ok, suggests the ICICI account, plain message', !v.ok && v.suggest && v.suggest.id === 'i' && /an ICICI statement.*HDFC Bank.*ICICI Bank \*\*\*\*3333/.test(v.message), v);
    check('U5 ICICI file into ICICI: ok; unknown bank: ok', BF.checkAccount('ICICI', accs[1], accs).ok && BF.checkAccount(null, accs[0], accs).ok);

    const port = await freePort();
    API = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const all = await prisma.bankAccount.findMany();
    const HD = all.find((a) => /hdfc/i.test(a.bank)); const IC = all.find((a) => /icici/i.test(a.bank));
    if (!HD || !IC) { console.error('Needs one HDFC and one ICICI account.'); process.exit(3); }
    const u = await prisma.user.create({ data: { passwordHash: 'x', name: 'ZZTEST WB admin', email: `zz-wb-${RUN}@example.test`, username: `zz-wb-${RUN}@example.test`, role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'NONE', accountsRole: 'ADMIN', hrmsAccess: false, accountsAccess: true, atsAccess: true, status: 'Active' } });
    users.push(u.id);
    const T = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const lines = (tag) => prisma.bankTransaction.count({ where: { description: { contains: `WRONGBANK ${tag} ${RUN}` } } });

    // P + B - preview, then the batch door
    const ic = xlsx(ICICI_HEAD, rowsFor('B'));
    const pv = await http('POST', '/api/accounts-import/preview', T, form(ic, 'ICICI_Jan2027_statement.xlsx', { bankAccountId: HD.id }));
    const bc = pv.body && pv.body.summary && pv.body.summary.bankCheck;
    const batchId = pv.body && pv.body.summary && pv.body.summary.stmt && pv.body.summary.stmt.batchId;
    check('P1 ICICI file previewed into HDFC: warning, names the ICICI account', pv.status === 200 && bc && bc.ok === false && bc.fileBank === 'ICICI' && bc.suggest && bc.suggest.id === IC.id, pv.body && pv.body.summary);
    check('P2 ... and the warning is in the problems list', (pv.body.problems || []).some((p) => / statement, but it is being imported into /.test(p)), pv.body.problems);
    const r1 = await http('POST', `/api/accounts-import/bank-batch/${batchId}/import`, T, { bankAccountId: HD.id });
    check('B1 Import into HDFC without a yes: refused 409 BANK_MISMATCH, nothing saved', r1.status === 409 && r1.body.code === 'BANK_MISMATCH' && (await lines('B')) === 0, r1.body);
    const ck = await http('POST', `/api/accounts-import/bank-batch/${batchId}/check`, T, { bankAccountId: IC.id });
    check('B2 switching to the ICICI account: the check says ok', ck.status === 200 && ck.body.bankCheck && ck.body.bankCheck.ok === true, ck.body);
    const r2 = await http('POST', `/api/accounts-import/bank-batch/${batchId}/import`, T, { bankAccountId: IC.id });
    const onIC = await prisma.bankTransaction.count({ where: { bankAccountId: IC.id, description: { contains: `WRONGBANK B ${RUN}` } } });
    check('B3 Import into ICICI: saved, all 3 lines on the ICICI account', r2.status === 201 && onIC === 3, r2.body && (r2.body.error || r2.body.stmt));

    const hd = xlsx(HDFC_HEAD, rowsFor('Y'));
    const pv2 = await http('POST', '/api/accounts-import/preview', T, form(hd, 'Acct_Statement_Jan2027.xls.xlsx', { bankAccountId: IC.id }));
    const b2 = pv2.body.summary.stmt.batchId;
    check('B4 HDFC file previewed into ICICI: warning', pv2.body.summary.bankCheck && pv2.body.summary.bankCheck.ok === false && pv2.body.summary.bankCheck.fileBank === 'HDFC', pv2.body.summary.bankCheck);
    const r3 = await http('POST', `/api/accounts-import/bank-batch/${b2}/import`, T, { bankAccountId: IC.id, confirmOtherBank: true });
    check('B5 ... the person said "it really belongs here": imported', r3.status === 201 && (await lines('Y')) === 3, r3.body && (r3.body.error || r3.body.stmt));

    // C - the one-step door
    const c1 = await http('POST', '/api/accounts-import/commit', T, form(xlsx(ICICI_HEAD, rowsFor('C')), 'icici-c.xlsx', { bankAccountId: HD.id }));
    check('C1 /commit of an ICICI file into HDFC: refused 409, nothing saved', c1.status === 409 && c1.body.code === 'BANK_MISMATCH' && (await lines('C')) === 0, c1.body);
    const c2 = await http('POST', '/api/accounts-import/commit', T, form(xlsx(PLAIN_HEAD, rowsFor('N')), 'plain.xlsx', { bankAccountId: HD.id }));
    check('C2 a file whose bank cannot be told is not refused', c2.status !== 409, c2.body);
  } catch (e) {
    check('no crash', false, e.stack || e.message);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (server) server.kill();
    await new Promise((r) => setTimeout(r, 800));
    for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
