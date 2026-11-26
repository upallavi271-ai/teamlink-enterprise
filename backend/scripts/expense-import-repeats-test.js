// OFFICE EXPENSE IMPORT reads "Repeatedly" / "Uniquely" (founder 2026-11-26): on a COPY of a database, with its own server.
//   TEST_SOURCE_DB=<a .db file> node scripts/expense-import-repeats-test.js
// Checks: a Frequency column makes "Repeatedly" / "Monthly" a monthly recurring bill and "Uniquely" / blank a one-time one, a sheet
// headed "Source" fills the category, a sheet with no such column stays one-time (as before), a repeat upload adds nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACK = path.join(__dirname, '..');
const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `exp-import-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
const DB_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.DATABASE_URL = DB_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'expense-import-test-only-secret';
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = DB_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'expense-import-test-only-secret';
const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const API = `http://localhost:${PORT}/api`;
const jwt = require('jsonwebtoken');
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  const p = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`${API}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(1000); }
    if (!up) throw new Error(`server did not start\n${log.slice(-800)}`);
    const sa = await p.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } }) || await p.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    // the copy's Super Admin may still hold a starting password: mark it changed IN THE COPY so the API lets it import
    await p.user.update({ where: { id: sa.id }, data: { passwordChangedAt: new Date() } });
    const tok = jwt.sign({ id: sa.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const TAG = `ZZREP${Date.now() % 100000}`;
    const send = async (csv, name) => {
      const fd = new FormData();
      fd.append('kind', 'expenses');
      fd.append('file', new Blob([csv], { type: 'text/csv' }), name);
      const r = await fetch(`${API}/accounts-import/commit`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const NL = String.fromCharCode(10);
    const csv1 = ['Date,Category,Amount,Frequency,Notes',
      `2020-03-01,${TAG} Rent,1000,Repeatedly,a`,
      `2020-03-02,${TAG} Webmail,200,Uniquely,b`,
      `2020-03-03,${TAG} Portals,300,repeatedly,c`,
      `2020-03-04,${TAG} ID cards,400,,d`,
      `2020-03-05,${TAG} Insurance,500,Yearly,e`, ''].join(NL);
    const r1 = await send(csv1, `${TAG}-a.csv`);
    check('the sheet imports: 5 bills', r1.status === 201 && r1.body.imported === 5, [r1.status, r1.body]);
    const got = await p.officeExpense.findMany({ where: { category: { startsWith: TAG } }, select: { category: true, recurring: true, frequency: true } });
    const of = (c) => got.find((g) => g.category === `${TAG} ${c}`) || {};
    check('"Repeatedly" -> monthly recurring', of('Rent').recurring === true && of('Rent').frequency === 'Monthly', of('Rent'));
    check('"repeatedly" (small letters) -> monthly recurring', of('Portals').recurring === true && of('Portals').frequency === 'Monthly', of('Portals'));
    check('"Uniquely" -> one-time', of('Webmail').recurring === false && of('Webmail').frequency === 'One-Time', of('Webmail'));
    check('blank -> one-time', of('ID cards').recurring === false && of('ID cards').frequency === 'One-Time', of('ID cards'));
    check('"Yearly" -> yearly recurring', of('Insurance').recurring === true && of('Insurance').frequency === 'Yearly', of('Insurance'));
    const r2 = await send(csv1, `${TAG}-a-again.csv`);
    check('the same rows again: nothing new (already on file)', r2.status === 201 && r2.body.imported === 0 && r2.body.duplicates === 5, r2.body);
    // the founder's own headings: "Dates", "Paid Amount", "Source", "Remark", and no frequency column -> one-time as before
    const csv3 = ['Dates ,Paid Amount ,Source ,Remark', `2020-04-01,700,${TAG} Floor exp,x`, ''].join(NL);
    const r3 = await send(csv3, `${TAG}-b.csv`);
    const fl = await p.officeExpense.findFirst({ where: { category: `${TAG} Floor exp` } });
    check('a sheet headed "Source" fills the category', r3.status === 201 && r3.body.imported === 1 && !!fl, [r3.status, r3.body]);
    check('no frequency column -> one-time, as before', fl && fl.recurring === false && fl.frequency === 'One-Time', fl);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.message}`);
  } finally {
    await p.$disconnect();
    server.kill();
    await sleep(500);
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
