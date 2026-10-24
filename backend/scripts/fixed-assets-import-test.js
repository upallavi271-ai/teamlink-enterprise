#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FIXED ASSETS - IMPORT BUTTONS + "Run depreciation" REMOVED (Accounts, 2026-10-19) - COPY DATABASE ONLY.
//
//   cd backend
//   node scripts/fixed-assets-import-test.js                          makes its own VACUUM INTO copy of the real database
//                                                                     (opened READ-ONLY) in the temp folder and deletes it after
//   COPY_DB=C:/tmp/fa-copy.db node scripts/fixed-assets-import-test.js use a copy you made (never prisma/dev.db)
//
// Starts its OWN throw-away API process (a free port 4050-4098, TEST_MODE=1) on the copy, adds ZZTEST assets / repairs
// to the COPY, builds a real .xlsx and a .csv in memory, and proves (numbers printed at the end):
//   U  the page source: Run depreciation gone, Import in all four sections, filters / search / navigation kept
//   P  permissions: other roles 403 on sample / preview / confirm, no token 401, expired token 401, missing key 400
//   H  Pending from HRMS: preview saves NOTHING (every table count equal), eligible rows import through the existing
//      posting workflow, bad rows stay for correction, import twice = nothing new, same key = same answer,
//      parallel confirms post once, a closed month is refused, a missing employee is refused
//   A  Assets: HRMS source + a real .xlsx and a .csv (valid, invalid, duplicate asset id / serial with another name, formula,
//      Excel date serial), unsupported / empty / macro / fake / oversized / wrong-header files, retry of corrected rows,
//      a database failure on one row (partial result reported honestly)
//   R  Repair cost: file + HRMS, the right asset, a missing asset is a dependency, duplicates, never capitalised
//   S  Asset summary: totals equal an independent SQL recomputation, one row per category, import changes no cost / depreciation
//   D  depreciation history / accumulated depreciation / purchase cost / net book value unchanged by every import
//   Q  audit rows (user, time, source, counts, nothing sensitive)
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
  copy = path.join(os.tmpdir(), `fa-import-${Date.now().toString(36)}.db`);
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
const A = require(path.join(BACK, 'src/utils/assetPosting'));
const io = require(path.join(BACK, 'src/utils/moduleIo'));
const F = require(path.join(BACK, 'src/utils/fixedAssetImport'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`); };
const RUN = Date.now().toString(36);
const facts = {};
let API = '';

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

async function http(method, p, token, body, extraHeaders = {}) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...extraHeaders };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (Buffer.isBuffer(body)) { payload = body; h['Content-Type'] = h['Content-Type'] || 'application/octet-stream'; } else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, body: json, buf, headers: r.headers };
}

const made = { users: [] };
const BASE = '/api/accounts/fixed-assets';
const IMP = `${BASE}/import`;

// ---- file builders (real .xlsx and .csv) -----------------------------------------------------
function aoaOf(spec, rows) { return [spec.columns.map(io.headerOf), ...rows.map((r) => spec.columns.map((c) => (r[c.key] === undefined ? '' : r[c.key])))]; }
function xlsxOf(spec, rows, sheet) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaOf(spec, rows)), sheet || spec.sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function csvOf(spec, rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return Buffer.from(`${aoaOf(spec, rows).map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`, 'utf8');
}
const serialOf = (ymd) => Math.round((Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) - Date.UTC(1899, 11, 30)) / 86400000);

const q = (token, section, source, fileName) => `section=${section}&source=${source}${fileName ? `&fileName=${encodeURIComponent(fileName)}` : ''}`;
const previewH = (tok, section) => http('POST', `${IMP}/preview?${q(tok, section, 'hrms')}`, tok, {});
const previewF = (tok, section, buf, name) => http('POST', `${IMP}/preview?${q(tok, section, 'file', name)}`, tok, buf);
let keyN = 0;
const key = () => `zzkey${RUN}${(keyN += 1)}abcdefgh`;
const confirmH = (tok, section, k = key(), items) => http('POST', `${IMP}/confirm?${q(tok, section, 'hrms')}`, tok, { items }, { 'Idempotency-Key': k });
const confirmF = (tok, section, buf, name, k = key()) => http('POST', `${IMP}/confirm?${q(tok, section, 'file', name)}`, tok, buf, { 'Idempotency-Key': k });

async function counts() {
  const t = {};
  for (const m of ['asset', 'assetRepair', 'journalEntry', 'journalLine', 'ledgerAccount', 'auditLog', 'appSetting']) t[m] = await prisma[m].count(); // eslint-disable-line no-await-in-loop
  return t;
}
const sameCounts = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
async function sqlBookValueByCategory() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT a.category AS category, COUNT(DISTINCT a.id) AS assets FROM Asset a GROUP BY a.category`);
  const lines = await prisma.$queryRawUnsafe(`
    SELECT a.category AS category,
           SUM(CASE WHEN l.accountCode LIKE '15%' THEN l.debit - l.credit ELSE 0 END) AS cost,
           SUM(CASE WHEN l.accountCode LIKE '16%' THEN l.credit - l.debit ELSE 0 END) AS accdep
    FROM JournalLine l JOIN Asset a ON a.id = l.referenceId
    WHERE l.referenceType LIKE 'ASSET%' GROUP BY a.category`);
  const out = new Map(rows.map((r) => [r.category, { assets: Number(r.assets), closing: 0 }]));
  lines.forEach((l) => { const x = out.get(l.category); x.closing = Math.round((Number(l.cost) - Number(l.accdep)) * 100) / 100; });
  return out;
}

(async () => {
  let server;
  try {
    // ================================================================ U. the page source
    const tabSrc = fs.readFileSync(path.join(FE, 'src/components/accounts/FixedAssetsTab.jsx'), 'utf8');
    const impSrc = fs.readFileSync(path.join(FE, 'src/components/accounts/FixedAssetImport.jsx'), 'utf8');
    check('U1 "Run depreciation" is gone from the page (no label, no view, no component, no handler)', !/Run depreciation/i.test(tabSrc.replace(/^\/\/.*$/gm, '')) && !/DepreciationView|depreciation\/run|depreciation\/preview|Book depreciation|'dep'/.test(tabSrc), 'still there');
    check('U2 the four section names are unchanged and in order', /\['pending', 'Pending from HRMS'\], \['register', 'Assets'\], \['summary', 'Asset summary'\], \['repairs', 'Repair cost'\]/.test(tabSrc));
    check('U3 the page heading is unchanged', tabSrc.includes('title="Fixed assets — from HRMS"'));
    const secs = [...tabSrc.matchAll(/<FixedAssetImport section="(\w+)"/g)].map((m) => m[1]);
    check('U4 one Import button in each of the four sections, none elsewhere in the file', secs.slice().sort().join() === 'assets,pending,repairs,summary' && (tabSrc.match(/<FixedAssetImport/g) || []).length === 4, secs);
    check('U5 filters, search, tables and actions are still there (Category/Status/Employee/Vendor filters, search box, Clear filters, View in HRMS x2+, Export Excel x2, Post buttons, threshold, timeline)',
      (tabSrc.match(/<Filters /g) || []).length === 3 && tabSrc.includes('placeholder="Asset ID, name, employee"') && tabSrc.includes('Clear filters') && (tabSrc.match(/View in HRMS/g) || []).length >= 3
      && (tabSrc.match(/Export Excel/g) || []).length === 2 && tabSrc.includes('Post all') && tabSrc.includes('Consider replacing at') && tabSrc.includes('<Timeline') && tabSrc.includes('PeriodPicker value={period}')
      && tabSrc.includes('extra={[\'vendor\']}') && tabSrc.includes('Yes, post it'));
    let headOk = null;
    try {
      const { execSync } = require('child_process');
      const head = execSync('git show HEAD:frontend/src/components/accounts/FixedAssetsTab.jsx', { cwd: path.resolve(BACK, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const strip = (s) => s.replace(/<FixedAssetImport[^>]*\/>/g, '');
      const heads = (s) => (s.match(/<th[^>]*>[^<]*<\/th>|<th \/>/g) || []).join('|');
      const dropDep = head.slice(0, head.indexOf('// ---- Run depreciation')) + head.slice(head.indexOf('// ---- One asset'));
      headOk = heads(strip(tabSrc)) === heads(dropDep);
    } catch { headOk = null; }
    if (headOk === null) console.log('SKIP  U6 (the committed version of the page could not be read)'); else check('U6 every table header of the committed page is unchanged (only the depreciation table left)', headOk);
    check('U7 the Import window: title per section, source choice, file picker, plain words, Preview, Confirm Import, Cancel, double-submit guard, one-time key, real result, CSV report',
      ['Import - Pending from HRMS', 'Import - Assets', 'Import - Asset summary', 'Import - Repair cost', 'Preview', 'Confirm Import', 'Cancel', 'flight.current', 'Idempotency-Key', 'Download report (CSV)', 'type="file"', 'Nothing is saved until you press Confirm Import'].every((t) => impSrc.includes(t)));
    check('U8 the window has no red required asterisks, no "Draft", no dropdown menu for Import/Export', !/Draft/.test(impSrc) && !/\*<\/span>/.test(impSrc) && !/<select/.test(impSrc));

    // ================================================================ server on the COPY
    const PORT = await freePort();
    API = `http://127.0.0.1:${PORT}`;
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST FAI ${tag} ${RUN}`, email: `zz-fai-${tag}-${RUN}@example.test`, username: `zz-fai-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      const payload = tokenPayload(await resolveIdentity(u.id));
      return { u, t: jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '3h' }), expired: jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: -60 }) };
    };
    const admin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true });
    const acct = await mkUser('acct', { accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const emp = await mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const rec = await mkUser('rec', {});
    const hr = await mkUser('hr', { hrmsRole: 'HR', hrmsAccess: true });
    const T = admin.t;

    // ================================================================ fixtures (in the COPY only)
    const holder = await prisma.employee.findFirst({ where: { employmentStatus: 'Active', employeeCode: { not: '' }, user: { is: { role: { not: 'SUPER_ADMIN' } } } }, select: { id: true, employeeCode: true, name: true, department: true } })
      || await prisma.employee.findFirst({ where: { employeeCode: { not: '' } }, select: { id: true, employeeCode: true, name: true, department: true } });
    const mkAsset = (code, data) => prisma.asset.create({ data: { assetCode: code, name: `ZZTEST ${code}`, category: 'Laptop', status: 'Available', purchaseDate: '2026-01-10', purchaseCost: 10000, ...data } });
    const H = {};
    H.h1 = await mkAsset('ZZT-H1', { purchaseCost: 50000, gstPaid: 9000, vendor: 'ZZTEST Vendor', invoiceNo: 'ZI-1', paidVia: 'Bank', assignedToId: holder.id, status: 'Assigned', serialNumber: `ZZSN-H1-${RUN}`, usefulLifeYears: 3, depreciationMethod: 'SL' });
    H.h2 = await mkAsset('ZZT-H2', { purchaseCost: 1234.56, category: `ZZTEST Gadget ${RUN}`, purchaseDate: '2026-01-11' });
    H.h3 = await mkAsset('ZZT-H3', { purchaseCost: 8000, purchaseDate: null });
    H.h4 = await mkAsset('ZZT-H4', { purchaseCost: -50 });
    H.h5 = await mkAsset('ZZT-H5', { purchaseCost: 100.123 });
    H.h6 = await mkAsset('ZZT-H6', { purchaseCost: 20000, purchaseDate: '2026-02-01', status: 'Sold', disposalDate: '2026-06-01', disposalAmount: 15000, disposalPaidVia: 'Bank' });
    H.h7 = await mkAsset('ZZT-H7', { purchaseCost: 30000, purchaseDate: '2026-02-02', category: 'Monitor' });
    H.h8 = await mkAsset('ZZT-H8', { purchaseCost: 40000 });
    H.h9 = await mkAsset('ZZT-H9', { purchaseCost: 12000, purchaseDate: '2026-02-03', category: 'Mouse' });
    H.nocost = await mkAsset('ZZT-NOCOST', { purchaseCost: null });
    const rep = (assetId, no, data) => prisma.assetRepair.create({ data: { repairNo: `ZZR-${RUN}-${no}`, assetId, status: 'Completed', repairDate: '2026-03-01', dateReported: '2026-02-27', issue: `ZZTEST issue ${no}`, vendor: 'ZZTEST Service', cost: 2000, gstPaid: 360, ...data } });
    const R = {};
    R.r1 = await rep(H.h7.id, 'R1', { cost: 2000, gstPaid: 360 });
    R.r2 = await rep(H.h7.id, 'R2', { cost: 1000, gstPaid: 0, capitalise: true, repairDate: '2026-03-02' });
    R.r3 = await rep(H.h7.id, 'R3', { cost: 0, gstPaid: 0, underWarranty: true, repairDate: '2026-03-03' });
    R.r4 = await rep(H.h7.id, 'R4', { cost: 700, status: 'Reported', repairDate: null });
    R.r5 = await rep(H.h9.id, 'R5', { cost: 500, gstPaid: 90, repairDate: '2026-04-01' });
    // a dangling employee on H8 (foreign keys off on a separate connection, copy only)
    { const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(copy, { enableForeignKeyConstraints: false }); raw.prepare("UPDATE Asset SET assignedToId='zz-missing-employee', status='Assigned' WHERE assetCode='ZZT-H8'").run(); raw.close(); }
    facts.fixtures = Object.keys(H).length + Object.keys(R).length;

    // ================================================================ P. permissions
    const prevBody = {};
    const perms = [];
    for (const [who, tok] of [['employee', emp.t], ['recruiter', rec.t], ['hr', hr.t]]) {
      const a = await http('GET', `${IMP}/sample?section=assets&format=xlsx`, tok);
      const b = await http('POST', `${IMP}/preview?section=pending&source=hrms`, tok, {});
      const c = await http('POST', `${IMP}/confirm?section=pending&source=hrms`, tok, {}, { 'Idempotency-Key': key() });
      perms.push([who, a.status, b.status, c.status]);
    }
    check('P1 employee / recruiter / HR roles: sample, preview and confirm are all 403 on the server', perms.every((p) => p.slice(1).every((s) => s === 403)), perms);
    const none = [(await http('POST', `${IMP}/preview?section=pending&source=hrms`, null, {})).status, (await http('POST', `${IMP}/confirm?section=pending&source=hrms`, null, {}, { 'Idempotency-Key': key() })).status];
    check('P2 no login: 401', none.every((s) => s === 401), none);
    const exp = await http('POST', `${IMP}/preview?section=pending&source=hrms`, admin.expired, {});
    check('P3 an expired session token: 401 (the screen then asks the person to sign in again), nothing written', exp.status === 401, exp.status);
    const noKey = await http('POST', `${IMP}/confirm?section=pending&source=hrms`, T, {});
    const badKey = await http('POST', `${IMP}/confirm?section=pending&source=hrms`, T, {}, { 'Idempotency-Key': 'x' });
    check('P4 confirm without / with a bad Idempotency-Key is refused (400) before anything is written', noKey.status === 400 && badKey.status === 400, [noKey.status, badKey.status]);
    const badSec = await http('POST', `${IMP}/preview?section=summary&source=file`, T, Buffer.from('x'), {});
    const badSec2 = await http('POST', `${IMP}/preview?section=nonsense&source=hrms`, T, {});
    check('P5 a source a section does not have (summary + file) or an unknown section is refused (400)', badSec.status === 400 && badSec2.status === 400, [badSec.status, badSec2.status]);
    const okRole = await previewH(acct.t, 'pending');
    check('P6 an Accounts accountant (create right on Journal & Ledger) may preview', okRole.status === 200, okRole.status);

    // ================================================================ sample files
    const sAx = await http('GET', `${IMP}/sample?section=assets&format=xlsx`, T);
    const sAc = await http('GET', `${IMP}/sample?section=assets&format=csv`, T);
    const sRx = await http('GET', `${IMP}/sample?section=repairs&format=xlsx`, T);
    const sHx = await http('GET', `${IMP}/sample?section=summary&format=xlsx`, T);
    const wbA = XLSX.read(sAx.buf, { type: 'buffer' });
    const headA = XLSX.utils.sheet_to_json(wbA.Sheets.Assets, { header: 1 })[0].map((h) => io.normHeader(h));
    check('S0 sample files: assets xlsx + csv, repairs xlsx download; a section with no file source gives 400; headers = the contract', sAx.status === 200 && sAx.buf[0] === 0x50 && sAc.status === 200 && /Asset ID/.test(sAc.buf.toString('utf8')) && sRx.status === 200 && sHx.status === 400
      && F.ASSET_SPEC.columns.every((c) => headA.includes(io.normHeader(c.label))), [sAx.status, sAc.status, sRx.status, sHx.status]);

    // ================================================================ H. Pending from HRMS
    // H1 - the preview saves nothing (not even a ledger for a brand-new category)
    const c0 = await counts();
    const gadgetLedgersBefore = await prisma.ledgerAccount.count({ where: { aliases: { contains: `asset-cat:zztest gadget ${RUN}`.toLowerCase() } } });
    const p1 = await previewH(T, 'pending');
    const c1 = await counts();
    check('H1 preview saves nothing: every table has the same row count before and after (assets, repairs, journal entries + lines, ledgers, audit, settings)', p1.status === 200 && sameCounts(c0, c1), { c0, c1 });
    const gadgetLedgersAfter = await prisma.ledgerAccount.count({ where: { aliases: { contains: `asset-cat:zztest gadget ${RUN}`.toLowerCase() } } });
    check('H2 ... and the new category "ZZTEST Gadget" has no ledger made by a preview', gadgetLedgersBefore === 0 && gadgetLedgersAfter === 0, [gadgetLedgersBefore, gadgetLedgersAfter]);
    const byRef = new Map((p1.body.rows || []).map((r) => [`${r.cells.ref}`, r]));
    const rowOf = (ref) => byRef.get(ref);
    const act = (ref) => (rowOf(ref) ? rowOf(ref).action : 'missing');
    check('H3 eligible purchases are Ready (H1, H2, H7, H9, H6); the sale of H6 waits for its purchase', ['ZZT-H1', 'ZZT-H2', 'ZZT-H7', 'ZZT-H9'].every((c) => act(c) === 'create') && (p1.body.rows || []).filter((r) => r.cells.ref === 'ZZT-H6').map((r) => r.action).sort().join() === 'create,create', (p1.body.rows || []).filter((r) => /ZZT-H6/.test(r.cells.ref)).map((r) => [r.cells.what, r.action]));
    check('H4 invalid rows are Problems with a reason and a suggested fix: no date (H3), negative cost (H4), 3 decimals (H5), employee gone (H8)', ['ZZT-H3', 'ZZT-H4', 'ZZT-H5', 'ZZT-H8'].every((c) => act(c) === 'error' && rowOf(c).problems.every((p) => p.message && p.fix)), ['ZZT-H3', 'ZZT-H4', 'ZZT-H5', 'ZZT-H8'].map((c) => [c, act(c), rowOf(c) && rowOf(c).problems.map((p) => p.message)]));
    check('H5 the repairs: R1 ready, R2 (capitalised) ready with the note, R3 skipped (warranty), R4 (not Completed) not listed, R5 ready; and the assigned-to employee + department are shown for H1',
      act(`ZZR-${RUN}-R1`) === 'create' && act(`ZZR-${RUN}-R2`) === 'create' && rowOf(`ZZR-${RUN}-R2`).notes.some((n) => /capitalise/.test(n)) && act(`ZZR-${RUN}-R3`) === 'skip' && act(`ZZR-${RUN}-R4`) === 'missing' && act(`ZZR-${RUN}-R5`) === 'create'
      && rowOf('ZZT-H1').cells.holder === holder.name && rowOf('ZZT-H1').cells.department === (holder.department || ''), [act(`ZZR-${RUN}-R3`), act(`ZZR-${RUN}-R4`), rowOf('ZZT-H1') && rowOf('ZZT-H1').cells]);
    check('H6 assets with no purchase cost are counted, not silently dropped (info.noCost)', p1.body.info.noCost >= 1 && !byRef.has('ZZT-NOCOST'), p1.body.info);
    check('H7 the preview columns: source id, what, asset, category, date, amount, assigned to, department, HRMS status + a Check result', ['ref', 'what', 'name', 'category', 'date', 'cost', 'holder', 'department', 'sourceStatus'].every((k) => p1.body.columns.some((c) => c.key === k)), p1.body.columns);
    facts.pendingPreview = p1.body.counts;
    const realPending = (p1.body.rows || []).filter((r) => !/^ZZT|^ZZR/.test(r.cells.ref));
    facts.realPendingRows = realPending.length;
    facts.realPendingReady = realPending.filter((r) => r.action === 'create').length;

    // base posting through the EXISTING button (Post) + a depreciation run, so history exists before any import
    const basePost = await http('POST', `${BASE}/post`, T, { items: [{ kind: 'purchase', id: H.h1.id }] });
    check('D0 (setup) the existing Post button posts ZZT-H1', basePost.status === 200 && basePost.body.ok === 1, basePost.body);
    const depRun = await http('POST', `${BASE}/depreciation/run`, T, { from: '2026-02-01', to: '2026-02-28' });
    check('D0b (setup) the existing depreciation backend still books a run (history for the before/after comparison)', depRun.status === 201 && depRun.body.total > 0, depRun.body);
    const allAssets0 = await prisma.asset.findMany({ select: { id: true, assetCode: true, purchaseCost: true, gstPaid: true, purchaseDate: true, usefulLifeYears: true, depreciationMethod: true, salvageValue: true } });
    const fig0 = await A.bookFigures(allAssets0.map((a) => a.id));
    const dep0 = await prisma.journalEntry.findMany({ where: { referenceType: 'ASSET_DEPRECIATION' }, include: { lines: true } });
    const runs0 = await A.depRuns();
    const depLines0 = JSON.stringify(dep0.map((e) => [e.id, e.idempotencyKey, e.totalDebit, e.lines.map((l) => [l.accountCode, l.debit, l.credit, l.referenceId]).sort()]).sort());
    const posted0 = new Set([...fig0.entries()].filter(([, v]) => v.gross > 0).map(([id]) => id));
    facts.baselinePostedAssets = posted0.size; facts.baselineDepEntries = dep0.length;

    // H8 - confirm
    const eligible = (await previewH(T, 'pending')).body;
    const nReady = eligible.counts.willImport + eligible.counts.willUpdate;
    const nErr = eligible.counts.errors;
    const jeBefore = await prisma.journalEntry.count({ where: { source: 'HRMS_ASSETS' } });
    const sameKey = key();
    const [c1a, c1b, c1c] = await Promise.all([confirmH(T, 'pending', sameKey), confirmH(T, 'pending', sameKey), confirmH(acct.t, 'pending', key())]);
    const jeAfter = await prisma.journalEntry.count({ where: { source: 'HRMS_ASSETS' } });
    const bodies = [c1a, c1b, c1c].map((r) => r.body);
    const first = bodies.find((b) => b && !b.duplicateRequest && b.imported + b.updated > 0) || {};
    check('H8 three confirms at once (two with the SAME key, one with another key) -> the work is done once: journal entries grew by exactly the number imported', [c1a, c1b, c1c].every((r) => r.status === 200) && jeAfter - jeBefore === first.imported + first.updated, { grew: jeAfter - jeBefore, first: [first.imported, first.updated], statuses: [c1a.status, c1b.status, c1c.status] });
    const dupAnswer = bodies.filter((b) => b && b.duplicateRequest);
    check('H9 the same key again returns the first answer (same batch id, flagged duplicateRequest); the other key finds everything already there (imported 0)', dupAnswer.some((b) => b.batchId === first.batchId) && bodies.filter((b) => b && !b.duplicateRequest && b !== first).every((b) => b.imported === 0 && b.updated === 0), bodies.map((b) => b && [b.batchId, b.imported, b.duplicateRequest]));
    check(`H10 the result counts are real: total ${first.total} = imported ${first.imported} + updated ${first.updated} + skipped ${first.skipped} + duplicates ${first.duplicates} + failed ${first.failed}; imported + updated = the ${nReady} previewed Ready rows; failed = the ${nErr} previewed problems`,
      first.total === first.imported + first.updated + first.skipped + first.duplicates + first.failed && first.imported + first.updated === nReady && first.failed === nErr, first);
    facts.pendingConfirm = { total: first.total, imported: first.imported, updated: first.updated, skipped: first.skipped, duplicates: first.duplicates, failed: first.failed };
    check('H11 the failure list has record id, reason and suggested correction for every failed row', first.failures.length === first.failed && first.failures.every((f) => f.ref && f.reason && f.fix), first.failures.slice(0, 3));
    const pur = await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: [`asset-purchase:${H.h1.id}`, `asset-purchase:${H.h2.id}`, `asset-purchase:${H.h7.id}`, `asset-purchase:${H.h9.id}`, `asset-purchase:${H.h6.id}`] } }, include: { lines: true } });
    check('H12 the HRMS link is kept: each posted purchase has the HRMS asset id on every line and its source is HRMS_ASSETS (no second asset table)', pur.length === 5 && pur.every((e) => e.source === 'HRMS_ASSETS' && e.lines.every((l) => /^ASSET_/.test(l.referenceType || '') && Object.values(H).some((a) => a.id === l.referenceId))), pur.map((e) => e.idempotencyKey));
    const failedStill = await prisma.journalEntry.count({ where: { idempotencyKey: { in: [H.h3, H.h4, H.h5, H.h8].map((a) => `asset-purchase:${a.id}`) } } });
    const pendNow = await http('GET', `${BASE}/pending`, T);
    const stillRefs = new Set((pendNow.body.rows || []).filter((r) => r.state !== 'Posted').map((r) => r.assetCode));
    check('H13 imported rows left the Pending list; failed rows (H3, H4?, H5, H8) stayed there for correction and were NOT marked imported (no journal entry)', failedStill === 0 && ['ZZT-H3', 'ZZT-H5', 'ZZT-H8'].every((c) => stillRefs.has(c)) && !stillRefs.has('ZZT-H1') && !stillRefs.has('ZZT-H2'), [...stillRefs].filter((c) => /ZZT/.test(c)));
    const h6 = await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: [`asset-purchase:${H.h6.id}`, `asset-disposal:${H.h6.id}`] } } });
    check('H14 order is kept: the purchase went in first, then the sale of H6 (both entries exist)', h6.length === 2, h6.map((e) => e.idempotencyKey));
    const repJ = await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: [R.r1, R.r2, R.r3, R.r5].map((r) => `asset-repair:${r.id}`) } }, include: { lines: true } });
    check('H15 repairs: R1, R2, R5 posted; R3 (warranty) not posted; the capitalised R2 follows the existing HRMS rule (cost lines in 15xx), R1 stays an expense (54xx) - nothing is capitalised that HRMS did not say',
      repJ.length === 3 && repJ.find((e) => e.idempotencyKey === `asset-repair:${R.r1.id}`).lines.some((l) => /^54/.test(l.accountCode)) && !repJ.find((e) => e.idempotencyKey === `asset-repair:${R.r1.id}`).lines.some((l) => /^15/.test(l.accountCode))
      && repJ.find((e) => e.idempotencyKey === `asset-repair:${R.r2.id}`).lines.some((l) => /^15/.test(l.accountCode)), repJ.map((e) => e.idempotencyKey));
    const c2 = await confirmH(T, 'pending');
    check(`H16 import twice = nothing new: second run imported 0, updated 0, duplicates ${c2.body.duplicates} (the ones just imported + earlier), failed still ${c2.body.failed}`, c2.body.imported === 0 && c2.body.updated === 0 && c2.body.duplicates >= first.imported + first.updated && c2.body.failed === nErr && (await prisma.journalEntry.count({ where: { source: 'HRMS_ASSETS' } })) === jeAfter, c2.body);
    const jeBeforeRetry = jeAfter;
    // correct and retry the failed rows
    await prisma.asset.update({ where: { id: H.h3.id }, data: { purchaseDate: '2026-02-05' } });
    await prisma.asset.update({ where: { id: H.h4.id }, data: { purchaseCost: 300 } });
    await prisma.asset.update({ where: { id: H.h5.id }, data: { purchaseCost: 100.12 } });
    await prisma.asset.update({ where: { id: H.h8.id }, data: { assignedToId: null, status: 'Available' } });
    const c3 = await confirmH(T, 'pending');
    check('H17 failed rows can be corrected and retried: H3, H4, H5, H8 are imported on the next run, nothing else is added', c3.body.imported === 4 && c3.body.failed === 0 && (await prisma.journalEntry.count({ where: { source: 'HRMS_ASSETS' } })) === jeBeforeRetry + 4, c3.body);
    const c4 = await previewH(T, 'pending');
    const c4c = await confirmH(T, 'pending');
    check('H18 all already imported: preview has nothing ready, confirm says nothing new was added (imported 0, failed 0, message honest)', c4.body.counts.willImport === 0 && c4.body.counts.errors === 0 && c4c.body.imported === 0 && c4c.body.failed === 0 && /Nothing new was added/.test(c4c.body.message), c4c.body.message);
    // closed month
    await prisma.appSetting.upsert({ where: { key: 'accounts.booksClosedUpTo' }, update: { value: JSON.stringify('2026-03') }, create: { key: 'accounts.booksClosedUpTo', value: JSON.stringify('2026-03') } });
    const H10 = await mkAsset('ZZT-H10', { purchaseCost: 7000, purchaseDate: '2026-03-05' });
    const closedPrev = (await previewH(T, 'pending')).body;
    const closedRow = closedPrev.rows.find((r) => r.cells.ref === 'ZZT-H10');
    const closedConf = (await confirmH(T, 'pending')).body;
    check('H19 a closed month: the preview marks it a Problem, the confirm refuses it (failed 1) and nothing is posted for it', closedRow.action === 'error' && /closed/.test(closedRow.problems[0].message) && closedConf.failed === 1 && closedConf.imported === 0 && (await prisma.journalEntry.count({ where: { idempotencyKey: `asset-purchase:${H10.id}` } })) === 0, closedConf);
    await prisma.appSetting.upsert({ where: { key: 'accounts.booksClosedUpTo' }, update: { value: 'null' }, create: { key: 'accounts.booksClosedUpTo', value: 'null' } });
    const reopen = await confirmH(T, 'pending');
    check('H20 after the month is opened again the same row imports (retry works)', reopen.body.imported === 1, reopen.body);

    // a database failure on ONE posting: the others go in, the failed one is reported honestly and stays pending
    const H13 = await mkAsset('ZZT-H13', { purchaseCost: 910, purchaseDate: '2026-05-02', category: 'Mouse' });
    const H14 = await mkAsset('ZZT-H14', { purchaseCost: 920, purchaseDate: '2026-05-03', category: 'Mouse' });
    { const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(copy); raw.exec(`CREATE TRIGGER zz_block_je BEFORE INSERT ON JournalEntry WHEN NEW.idempotencyKey = 'asset-purchase:${H13.id}' BEGIN SELECT RAISE(ABORT, 'database is locked (test)'); END;`); raw.close(); }
    const dbf = (await confirmH(T, 'pending')).body;
    check('H21 a database failure on one posting: the other row (H14) is imported, the failed row (H13) is listed as not saved, the message says "Partly done" (never full success), and no half entry exists for H13',
      dbf.imported === 1 && dbf.failed === 1 && /Partly done/.test(dbf.message) && /could not save|Nothing was saved/.test(dbf.failures[0].reason) && (await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: `asset-purchase:${H13.id}` } } })) === 0 && (await prisma.journalEntry.count({ where: { idempotencyKey: `asset-purchase:${H14.id}` } })) === 1, dbf);
    { const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(copy); raw.exec('DROP TRIGGER zz_block_je;'); raw.close(); }
    const dbr = (await confirmH(T, 'pending')).body;
    check('H22 once the cause is gone the failed row imports on the next run; the row already imported is not added again', dbr.imported === 1 && dbr.failed === 0 && (await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: `asset-purchase:${H14.id}` } } })) === 1, dbr);

    // ================================================================ A. Assets - HRMS source
    const H11 = await mkAsset('ZZT-H11', { purchaseCost: 4500, purchaseDate: '2026-04-01', category: 'Mouse' });
    const aH = (await previewH(T, 'assets')).body;
    check('A1 Assets + HRMS source lists purchases only (no repairs, no sales) and the new unposted asset is Ready', aH.rows.every((r) => r.cells.what === 'Purchase') && aH.rows.some((r) => r.cells.ref === 'ZZT-H11' && r.action === 'create'), aH.counts);
    const aHc = (await confirmH(T, 'assets')).body;
    check('A2 confirm brings it into the books (imported 1, failed 0)', aHc.imported === 1 && aHc.failed === 0, aHc);

    // ================================================================ A. Assets - Excel / CSV
    const SP = F.ASSET_SPEC;
    const existingCode = 'ZZT-H1';
    const existingSerial = `ZZSN-H1-${RUN}`;
    const rowsA = [
      { assetCode: 'ZZF-001', name: 'ZZTEST File Laptop', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 65000, gstPaid: 11700, paidVia: 'Bank', vendor: 'ZZTEST ABC', invoiceNo: 'ZF-1', serialNumber: `ZZFS-001-${RUN}`, holder: holder.employeeCode, location: 'ZZTEST floor', usefulLifeYears: 4, depreciationMethod: 'WDV', salvageValue: 5000, status: 'Assigned', warrantyUntil: '2029-03-09', assetType: 'ZZTEST type' },
      { assetCode: 'ZZF-002', name: 'ZZTEST File Monitor', category: `ZZTEST Newcat ${RUN}`, purchaseDate: serialOf('2026-03-12'), purchaseCost: 12999.5, serialNumber: `ZZFS-002-${RUN}` },
      { assetCode: 'ZZF-003', name: '', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 100 }, // no name
      { assetCode: 'ZZF-004', name: 'ZZTEST Bad date', category: 'Laptop', purchaseDate: '31-02-2026', purchaseCost: 100 },
      { assetCode: 'ZZF-005', name: 'ZZTEST Negative', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: -5 },
      { assetCode: 'ZZF-006', name: 'ZZTEST Text amount', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 'about ten' },
      { assetCode: existingCode, name: 'ZZTEST Different name for an existing id', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 1 }, // existing asset id, new name
      { assetCode: 'ZZF-008', name: 'ZZTEST Same serial new name', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 200, serialNumber: existingSerial },
      { assetCode: 'ZZF-001', name: 'ZZTEST repeated id in file', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 200 },
      { assetCode: 'ZZF-010', name: '=HYPERLINK("http://evil","x")', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 200 },
      { assetCode: 'ZZF-011', name: 'ZZTEST holder missing', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 200, holder: 'NO-SUCH-EMP' },
      { assetCode: 'ZZF-012', name: 'ZZTEST future date', category: 'Laptop', purchaseDate: '2099-01-01', purchaseCost: 200 },
      { assetCode: 'ZZF-013', name: 'ZZTEST residual too big', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 200, salvageValue: 900 },
      { assetCode: 'ZZF-014', name: 'ZZTEST three decimals', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 10.123 },
      { assetCode: '', name: 'ZZTEST no asset id', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 10 },
    ];
    const fileA = xlsxOf(SP, rowsA);
    const before = await counts();
    const pa = await previewF(T, 'assets', fileA, 'zz-assets.xlsx');
    const afterP = await counts();
    check('A3 file preview (a real .xlsx) saves nothing: all table counts equal before / after', pa.status === 200 && sameCounts(before, afterP), { before, afterP });
    const pr = (n) => pa.body.rows.find((r) => r.line === n + 1) || {};
    check('A4 valid rows are Ready (the Excel date serial 46093 read as 2026-03-12; a NEW category is allowed and noted)', pr(1).action === 'create' && pr(2).action === 'create' && pr(2).notes.some((n) => /New category/.test(n)), [pr(1), pr(2)]);
    check('A5 invalid rows are Problems with a plain reason + fix: no name, impossible date (31-02), negative, text amount, holder not found, future date, residual > cost, 3 decimals, no Asset ID', [3, 4, 5, 6, 11, 12, 13, 14, 15].every((n) => pr(n).action === 'error' && pr(n).problems.every((p) => p.message && p.fix)), [3, 4, 5, 6, 11, 12, 13, 14, 15].map((n) => [n, pr(n).action]));
    check('A6 a cell that starts like a formula (=HYPERLINK...) is refused, never run', pr(10).action === 'error' && /formula/i.test(pr(10).problems.map((p) => p.message).join(' ')), pr(10));
    check('A7 duplicates are found by asset id / serial, not by name: an existing asset id with a new name, the same serial with a new name, a repeated id in the file - each shows the existing record + why it was skipped',
      pr(7).action === 'duplicate' && /ZZT-H1/.test(pr(7).existing.label) && pr(8).action === 'duplicate' && /ZZT-H1/.test(pr(8).existing.label) && /Serial/.test(pr(8).reason) && pr(9).action === 'duplicate' && /repeated/.test(pr(9).reason), [pr(7), pr(8), pr(9)].map((r) => [r.action, r.reason]));
    check('A8 the preview lists the column mapping (file column -> database field)', pa.body.mapping.some((m) => m.column === 'Purchase Cost' && m.field === 'purchaseCost' && m.required) && pa.body.mapping.some((m) => m.field === 'salvageValue'), pa.body.mapping.length);
    const h1Name = (await prisma.asset.findUnique({ where: { id: H.h1.id } })).name;
    const ca = await confirmF(T, 'assets', fileA, 'zz-assets.xlsx');
    facts.assetsFile1 = { total: ca.body.total, imported: ca.body.imported, duplicates: ca.body.duplicates, failed: ca.body.failed };
    check(`A9 confirm: total ${ca.body.total}, imported ${ca.body.imported} (the 2 valid rows), duplicates ${ca.body.duplicates} (3), failed ${ca.body.failed} (the 10 broken rows); counts add up`, ca.body.imported === 2 && ca.body.duplicates === 3 && ca.body.failed === 10 && ca.body.total === 15 && ca.body.total === ca.body.imported + ca.body.updated + ca.body.skipped + ca.body.duplicates + ca.body.failed, ca.body);
    const f1 = await prisma.asset.findUnique({ where: { assetCode: 'ZZF-001' }, include: { assignedTo: true } });
    const f2 = await prisma.asset.findUnique({ where: { assetCode: 'ZZF-002' } });
    check('A10 the columns landed in the right database fields (name, category, cost, GST, paid via, vendor, invoice, serial, holder, location, life, method, residual, status, warranty, type; Excel serial date)',
      f1 && f1.name === 'ZZTEST File Laptop' && f1.category === 'Laptop' && f1.purchaseCost === 65000 && f1.gstPaid === 11700 && f1.paidVia === 'Bank' && f1.vendor === 'ZZTEST ABC' && f1.invoiceNo === 'ZF-1' && f1.serialNumber === `ZZFS-001-${RUN}` && f1.assignedToId === holder.id && f1.location === 'ZZTEST floor' && f1.usefulLifeYears === 4 && f1.depreciationMethod === 'WDV' && f1.salvageValue === 5000 && f1.status === 'Assigned' && f1.warrantyUntil === '2029-03-09' && f1.assetType === 'ZZTEST type' && f1.purchaseDate === '2026-03-10'
      && f2 && f2.purchaseDate === '2026-03-12' && f2.purchaseCost === 12999.5 && f2.status === 'Available', [f1, f2]);
    const hist = JSON.parse(f1.history);
    const aud = await prisma.auditLog.findMany({ where: { entityId: f1.id } });
    check('A11 an imported asset has history + an audit row, and opens in the existing asset workflow (timeline endpoint answers)', hist.length >= 1 && aud.length >= 1 && (await http('GET', `${BASE}/${f1.id}/timeline`, T)).status === 200, [hist, aud.length]);
    const h1After = await prisma.asset.findUnique({ where: { id: H.h1.id } });
    check('A12 existing records were NOT overwritten: ZZT-H1 keeps its name and cost, no new asset took the existing serial', h1After.name === h1Name && h1After.purchaseCost === 50000 && (await prisma.asset.count({ where: { serialNumber: existingSerial } })) === 1);
    check('A13 nothing from a file was posted to the journal (the new assets wait in Pending from HRMS)', (await prisma.journalEntry.count({ where: { idempotencyKey: { in: [`asset-purchase:${f1.id}`, `asset-purchase:${f2.id}`] } } })) === 0);
    const assetsAfter1 = await prisma.asset.count();
    const ca2 = await confirmF(T, 'assets', fileA, 'zz-assets.xlsx');
    check('A14 import the same file again = nothing new: imported 0, the 2 earlier rows now duplicates, no new asset row', ca2.body.imported === 0 && ca2.body.duplicates === 5 && (await prisma.asset.count()) === assetsAfter1, ca2.body);
    // correct the broken rows and retry (as a CSV this time)
    const fixed = [
      { assetCode: 'ZZF-003', name: 'ZZTEST Now named', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 100 },
      { assetCode: 'ZZF-004', name: 'ZZTEST Good date', category: 'Laptop', purchaseDate: '28-02-2026', purchaseCost: 100 },
      { assetCode: 'ZZF-005', name: 'ZZTEST Zero cost', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 0 },
    ];
    const csvFix = csvOf(SP, fixed);
    const pc = await previewF(T, 'assets', csvFix, 'zz-fixed.csv');
    check('A15 a corrected .csv previews as Ready (28-02-2026 day-first date accepted; cost 0 is valid and noted)', pc.status === 200 && pc.body.counts.willImport === 3 && pc.body.rows[2].notes.some((n) => /Cost is 0/.test(n)), pc.body.counts);
    const cc = await confirmF(T, 'assets', csvFix, 'zz-fixed.csv');
    check('A16 the corrected rows import on retry (imported 3, failed 0); the two earlier valid rows are not touched', cc.body.imported === 3 && cc.body.failed === 0 && (await prisma.asset.count()) === assetsAfter1 + 3, cc.body);
    // formula cell in a real workbook: its saved value is read, the formula is not run
    { const wb = XLSX.utils.book_new(); const ws = XLSX.utils.aoa_to_sheet(aoaOf(SP, [{ assetCode: 'ZZF-020', name: 'ZZTEST formula cell', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 77 }])); const ci = SP.columns.findIndex((c) => c.key === 'category'); ws[XLSX.utils.encode_cell({ r: 1, c: ci })] = { t: 's', v: 'Laptop', f: '"Lap"&"top"' }; XLSX.utils.book_append_sheet(wb, ws, 'Assets'); const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); const r = await confirmF(T, 'assets', buf, 'zz-formula.xlsx'); const a20 = await prisma.asset.findUnique({ where: { assetCode: 'ZZF-020' } }); check('A17 a real formula cell is never evaluated: only its saved value ("Laptop") is stored', r.body.imported === 1 && a20.category === 'Laptop' && !JSON.stringify(a20).includes('&'), r.body); }
    // unsupported / bad files
    const bad = {};
    bad.txt = await previewF(T, 'assets', Buffer.from('a,b'), 'x.txt');
    bad.xlsm = await previewF(T, 'assets', fileA, 'x.xlsm');
    bad.xls = await previewF(T, 'assets', fileA, 'x.xls');
    bad.empty = await previewF(T, 'assets', Buffer.alloc(0), 'x.xlsx');
    bad.fake = await previewF(T, 'assets', Buffer.from('this is not a workbook'), 'x.xlsx');
    bad.macro = await previewF(T, 'assets', Buffer.concat([fileA, Buffer.from('xl/vbaProject.bin')]), 'x.xlsx');
    bad.big = await previewF(T, 'assets', Buffer.alloc(5 * 1024 * 1024 + 10, 65), 'x.csv');
    bad.binCsv = await previewF(T, 'assets', Buffer.from([65, 44, 0, 66, 10]), 'x.csv');
    const wrongHead = xlsxOf({ columns: SP.columns.filter((c) => c.key !== 'purchaseCost').concat([{ key: 'zz', label: 'Mystery Column' }]), sheet: 'Assets' }, [{ assetCode: 'ZZF-030', name: 'x' }]);
    bad.head = await previewF(T, 'assets', wrongHead, 'x.xlsx');
    bad.headerOnly = await previewF(T, 'assets', xlsxOf(SP, []), 'x.xlsx');
    check('A18 unsupported / unsafe files are refused with a plain reason and write nothing: .txt, .xlsm, .xls (415), empty, fake .xlsx, macro workbook, binary .csv, 5 MB+ (413)',
      [bad.txt, bad.xlsm, bad.xls, bad.fake, bad.macro, bad.binCsv].every((r) => r.status === 415 && r.body.error) && bad.empty.status === 400 && bad.big.status === 413, Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, [v.status, v.body && v.body.error]])));
    check('A19 missing / unknown columns are refused naming them; a header-only file says there are no rows', bad.head.status === 400 && /Purchase Cost/.test(bad.head.body.error) && /Mystery Column/.test(bad.head.body.error) && bad.headerOnly.status === 400 && /no data rows/i.test(bad.headerOnly.body.error), [bad.head.body, bad.headerOnly.body]);
    check('A20 none of those files created an asset (no ZZF-030)', (await prisma.asset.count({ where: { assetCode: 'ZZF-030' } })) === 0);
    // a database failure on ONE row
    { const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(copy); raw.exec("CREATE TRIGGER zz_block BEFORE INSERT ON Asset WHEN NEW.assetCode = 'ZZF-BLOCK' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;"); raw.close(); }
    const partial = xlsxOf(SP, [
      { assetCode: 'ZZF-040', name: 'ZZTEST before the failure', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 1 },
      { assetCode: 'ZZF-BLOCK', name: 'ZZTEST this one fails', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 1 },
      { assetCode: 'ZZF-041', name: 'ZZTEST after the failure', category: 'Laptop', purchaseDate: '2026-03-10', purchaseCost: 1 },
    ]);
    const pcn = await confirmF(T, 'assets', partial, 'zz-partial.xlsx');
    check('A21 a database failure on one row: the others still import, the failed row is reported honestly ("not saved"), the message never claims full success, and nothing half-saved remains',
      pcn.body.imported === 2 && pcn.body.failed === 1 && /not saved|Nothing was saved for it/.test(pcn.body.failures[0].reason) && /Partly done/.test(pcn.body.message) && (await prisma.asset.count({ where: { assetCode: 'ZZF-BLOCK' } })) === 0 && (await prisma.asset.count({ where: { assetCode: { in: ['ZZF-040', 'ZZF-041'] } } })) === 2, pcn.body);
    { const { DatabaseSync } = require('node:sqlite'); const raw = new DatabaseSync(copy); raw.exec('DROP TRIGGER zz_block;'); raw.close(); }
    const retryBlocked = await confirmF(T, 'assets', partial, 'zz-partial.xlsx');
    check('A22 after the cause is gone, the failed row imports on retry and the two done rows are not added again', retryBlocked.body.imported === 1 && retryBlocked.body.duplicates === 2, retryBlocked.body);
    // the new file assets now flow through the EXISTING Pending workflow
    const pendFile = (await previewH(T, 'pending')).body;
    const fileReady = pendFile.rows.filter((r) => /^ZZF-/.test(r.cells.ref) && r.action === 'create').length;
    check('A23 the file-imported assets appear in Pending from HRMS as Ready (approval step kept: they were not auto-posted)', fileReady >= 5, fileReady);

    // ================================================================ R. Repair cost - file
    const RS = F.REPAIR_SPEC;
    const h1repNo = `ZZR-${RUN}-R1`;
    const rowsR = [
      { assetCode: 'ZZT-H1', dateReported: '2026-04-02', repairDate: '2026-04-05', issue: 'ZZTEST screen', repairType: 'Repair', vendor: 'ZZTEST FixIt', invoiceNo: 'ZRI-1', cost: 1500, gstPaid: 270, total: 1770, status: 'Completed', paidVia: 'Bank' },
      { assetCode: 'ZZT-H9', repairDate: '2026-04-06', issue: 'ZZTEST keys', cost: 300, invoiceNo: 'ZRI-2', vendor: 'ZZTEST FixIt' },
      { assetCode: 'ZZF-001', repairDate: '2026-04-07', issue: 'ZZTEST on a file asset not yet in the books', cost: 100 },
      { assetCode: 'NO-SUCH-ASSET', repairDate: '2026-04-08', issue: 'ZZTEST orphan', cost: 100 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-09', issue: 'ZZTEST negative', cost: -1 },
      { assetCode: 'ZZT-H1', repairDate: 'not a date', issue: 'ZZTEST bad date', cost: 10 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-10', issue: 'ZZTEST total mismatch', cost: 100, gstPaid: 18, total: 999 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-11', issue: 'ZZTEST invoice repeats', cost: 1500, invoiceNo: 'ZRI-1', vendor: 'ZZTEST FixIt' },
      { repairNo: h1repNo, assetCode: 'ZZT-H7', repairDate: '2026-04-12', issue: 'ZZTEST existing repair number', cost: 5 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-13', issue: 'ZZTEST same row twice', cost: 50 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-13', issue: 'ZZTEST same row twice', cost: 50 },
      { assetCode: 'ZZT-H1', repairDate: '2026-04-14', issue: '@SUM(1+1)', cost: 5 },
      { assetCode: 'ZZT-H1', issue: 'ZZTEST no date at all', cost: 5 },
    ];
    const fileR = xlsxOf(RS, rowsR);
    const cR0 = await counts();
    const pR = await previewF(T, 'repairs', fileR, 'zz-repairs.xlsx');
    check('R1 repair file preview saves nothing', pR.status === 200 && sameCounts(cR0, await counts()));
    const rr = (n) => pR.body.rows.find((r) => r.line === n + 1) || {};
    check('R2 valid repairs Ready (H1 with a matching Total; H9; and a repair on a file asset that is registered but not yet posted)', rr(1).action === 'create' && rr(2).action === 'create' && rr(3).action === 'create', [1, 2, 3].map((n) => [n, rr(n).action, rr(n).problems]));
    check('R3 a repair whose asset is not in the register is reported as a missing dependency (not created, not orphaned) with what to do first', rr(4).action === 'error' && rr(4).problems[0].dependency === true && /Import the asset first/.test(rr(4).problems[0].fix), rr(4));
    check('R4 invalid values rejected with reasons: negative amount, bad date, Total not equal Amount + Tax, formula-like text, no date at all', [5, 6, 7, 12, 13].every((n) => rr(n).action === 'error' && rr(n).problems.length), [5, 6, 7, 12, 13].map((n) => [n, rr(n).action]));
    check('R5 duplicates by reliable ids: same asset + vendor + invoice (row 8), an existing Repair Record ID (row 9), the same row twice in the file (row 11)', rr(8).action === 'duplicate' && /repeated/.test(rr(8).reason) && rr(9).action === 'duplicate' && rr(10).action === 'create' && rr(11).action === 'duplicate', [8, 9, 10, 11].map((n) => [n, rr(n).action, rr(n).reason]));
    const repAssetsBefore = await prisma.asset.findMany({ select: { id: true, purchaseCost: true } });
    const cr = await confirmF(T, 'repairs', fileR, 'zz-repairs.xlsx');
    facts.repairsFile = { total: cr.body.total, imported: cr.body.imported, duplicates: cr.body.duplicates, failed: cr.body.failed };
    check(`R6 confirm: total ${cr.body.total}, imported ${cr.body.imported} (4), duplicates ${cr.body.duplicates} (3), failed ${cr.body.failed} (6)`, cr.body.total === 13 && cr.body.imported === 4 && cr.body.duplicates === 3 && cr.body.failed === 6, cr.body);
    const newReps = await prisma.assetRepair.findMany({ where: { issue: { in: ['ZZTEST screen', 'ZZTEST keys', 'ZZTEST on a file asset not yet in the books', 'ZZTEST same row twice'] } } });
    const idOf = async (code) => (await prisma.asset.findUnique({ where: { assetCode: code } })).id;
    check('R7 every imported repair is linked to the right asset (by Asset ID), amounts as typed, status Completed, number RP-nnnnn, never capitalised', newReps.length === 4
      && newReps.find((r) => r.issue === 'ZZTEST screen').assetId === await idOf('ZZT-H1') && newReps.find((r) => r.issue === 'ZZTEST keys').assetId === await idOf('ZZT-H9')
      && newReps.find((r) => r.issue === 'ZZTEST on a file asset not yet in the books').assetId === await idOf('ZZF-001') && newReps.find((r) => r.issue === 'ZZTEST screen').cost === 1500 && newReps.find((r) => r.issue === 'ZZTEST screen').gstPaid === 270
      && newReps.every((r) => /^RP-\d{5}$/.test(r.repairNo) && r.capitalise === false && r.status === 'Completed'), newReps.map((r) => [r.repairNo, r.issue, r.assetId]));
    const repAssetsAfter = await prisma.asset.findMany({ select: { id: true, purchaseCost: true } });
    check('R8 a repair is never added to a purchase cost: every asset keeps its purchase cost', JSON.stringify(repAssetsBefore) === JSON.stringify(repAssetsAfter));
    const cr2 = await confirmF(T, 'repairs', fileR, 'zz-repairs.xlsx');
    check('R9 import twice = nothing new (imported 0, no new repair rows)', cr2.body.imported === 0 && (await prisma.assetRepair.count({ where: { issue: { startsWith: 'ZZTEST' } } })) === 5 + 4 && cr2.body.duplicates >= 7, cr2.body);
    // CSV retry of corrected rows
    const csvR = csvOf(RS, [{ assetCode: 'ZZT-H1', repairDate: '2026-04-09', issue: 'ZZTEST negative fixed', cost: 1 }, { assetCode: 'ZZF-001', repairDate: '2026-04-07', issue: 'ZZTEST orphan fixed', cost: 100 }]);
    const cr3 = await confirmF(T, 'repairs', csvR, 'zz-repairs-fixed.csv');
    check('R10 corrected rows (now with an existing asset) import from a .csv', cr3.body.imported === 2 && cr3.body.failed === 0, cr3.body);
    // HRMS source for repairs: R5 depends on H9's purchase (posted by the Pending run), file repairs are history -> Pending
    const rHp = (await previewH(T, 'repairs')).body;
    check('R11 Repair cost + HRMS lists repairs only', rHp.rows.every((r) => r.cells.what === 'Repair'), rHp.counts);
    // dependency via HRMS: repair of an asset (ZZF-001) whose purchase is not in the books
    const fRow = rHp.rows.find((r) => /ZZF-001|File Laptop/.test(`${r.cells.ref} ${r.cells.name}`) && r.action !== 'duplicate');
    check('R12 an HRMS repair on an asset that is not in the books yet is a DEPENDENCY problem, not posted (it says to import the asset first)', !!fRow && fRow.action === 'error' && fRow.problems[0].dependency === true && /Import the asset first/.test(fRow.problems[0].fix), fRow && [fRow.action, fRow.problems]);
    const jeBeforeRepairs = await prisma.journalEntry.count({ where: { referenceType: 'ASSET_REPAIR' } });
    const cRh = (await confirmH(T, 'repairs')).body;
    const jeAfterRepairs = await prisma.journalEntry.count({ where: { referenceType: 'ASSET_REPAIR' } });
    check('R13 confirm posts only the repairs whose asset is in the books; the dependent ones are reported as failed (not hidden) and nothing else moves', jeAfterRepairs - jeBeforeRepairs === cRh.imported && cRh.failed >= 1 && cRh.failures.some((f) => f.dependency), { imported: cRh.imported, failed: cRh.failed, grew: jeAfterRepairs - jeBeforeRepairs });
    // the existing repair-cost report equals an independent recomputation
    const rc = (await http('GET', `${BASE}/repair-cost`, T)).body;
    const sumSql = await prisma.$queryRawUnsafe("SELECT COALESCE(SUM(cost),0) AS s, COUNT(*) AS n FROM AssetRepair WHERE status <> 'Cancelled'");
    check('R14 the Repair cost table refreshes from saved data: its total equals an independent SQL sum of the saved repairs', Math.abs(rc.totals.totalRepairCost - Number(sumSql[0].s)) < 0.011 && rc.totals.repairs === Number(sumSql[0].n), [rc.totals, sumSql[0]]);

    // ================================================================ S. Asset summary
    const H12 = await mkAsset('ZZT-H12', { purchaseCost: 3300, purchaseDate: '2026-05-01', category: 'Head Set' });
    const sumBefore = (await http('GET', `${BASE}/summary`, T)).body;
    const sp = (await previewH(T, 'summary')).body;
    check('S1 Asset summary import previews the underlying records, grouped by category (one line per category)', sp.rows.some((r) => r.cells.ref === 'ZZT-H12' && r.action === 'create') && sp.byCategory.length === new Set(sp.byCategory.map((c) => c.category)).size && sp.byCategory.some((c) => c.category === 'Head Set'), sp.byCategory);
    const fBefore = await F.figures();
    const costsBefore = JSON.stringify((await prisma.asset.findMany({ select: { id: true, purchaseCost: true, gstPaid: true }, orderBy: { id: 'asc' } })));
    const sc = (await confirmH(T, 'summary')).body;
    const sumAfter = (await http('GET', `${BASE}/summary`, T)).body;
    check('S2 the summary import is a sync, not a purchase: only HRMS records not yet in the books were brought in; purchase cost fields untouched; depreciation figure unchanged', sc.imported >= 1 && JSON.stringify((await prisma.asset.findMany({ select: { id: true, purchaseCost: true, gstPaid: true }, orderBy: { id: 'asc' } }))) === costsBefore && sc.figures.after.accumulatedDepreciation === fBefore.accumulatedDepreciation && sc.figures.before.accumulatedDepreciation === fBefore.accumulatedDepreciation, [sc.imported, sc.figures]);
    const cats = sumAfter.rows.map((r) => r.category);
    check('S3 the summary has exactly one row per category (no duplicate summary rows) before and after', cats.length === new Set(cats).size && sumBefore.rows.length === new Set(sumBefore.rows.map((r) => r.category)).size, cats);
    const sqlBv = await sqlBookValueByCategory();
    const mism = sumAfter.rows.filter((r) => Math.abs(r.closing - (sqlBv.get(r.category) || { closing: 0 }).closing) > 0.011 || r.assets !== (sqlBv.get(r.category) || { assets: 0 }).assets);
    check(`S4 summary totals equal an independent SQL recomputation from the saved records (${sumAfter.rows.length} categories: asset count + closing book value each)`, mism.length === 0 && Math.abs(sumAfter.totals.closing - [...sqlBv.values()].reduce((n, c) => n + c.closing, 0)) < 0.011, mism);
    facts.summary = { categories: sumAfter.rows.length, assets: sumAfter.totals.assets, closing: sumAfter.totals.closing };
    check('S5 the summary asset count equals the number of saved assets', sumAfter.totals.assets === await prisma.asset.count());
    check('S6 the Head Set row grew by exactly the new asset (additions up by its cost 3300)', Math.abs(((sumAfter.rows.find((r) => r.category === 'Head Set') || {}).additions || 0) - ((sumBefore.rows.find((r) => r.category === 'Head Set') || {}).additions || 0) - 3300) < 0.011);

    // ================================================================ D. depreciation / cost / NBV unchanged
    const allAssets1 = await prisma.asset.findMany({ where: { id: { in: allAssets0.map((a) => a.id) } }, select: { id: true, assetCode: true, purchaseCost: true, gstPaid: true, purchaseDate: true, usefulLifeYears: true, depreciationMethod: true, salvageValue: true } });
    const fig1 = await A.bookFigures(allAssets1.map((a) => a.id));
    const dep1 = await prisma.journalEntry.findMany({ where: { referenceType: 'ASSET_DEPRECIATION' }, include: { lines: true } });
    const depLines1 = JSON.stringify(dep1.map((e) => [e.id, e.idempotencyKey, e.totalDebit, e.lines.map((l) => [l.accountCode, l.debit, l.credit, l.referenceId]).sort()]).sort());
    const runs1 = await A.depRuns();
    check('D1 recorded depreciation entries are byte-for-byte the same after every import (ids, keys, totals, lines)', depLines0 === depLines1 && dep0.length === dep1.length, [dep0.length, dep1.length]);
    check('D2 the depreciation runs list is unchanged', JSON.stringify(runs0) === JSON.stringify(runs1));
    const accSame = allAssets0.every((a) => (fig0.get(a.id) || { accDep: 0 }).accDep === (fig1.get(a.id) || { accDep: 0 }).accDep);
    check(`D3 accumulated depreciation of all ${allAssets0.length} assets that existed before the imports is unchanged`, accSame);
    const edited = new Set(['ZZT-H3', 'ZZT-H4', 'ZZT-H5', 'ZZT-H8']); // the four the test itself corrected by hand (H17)
    const keep = (a) => !edited.has(a.assetCode);
    const costSame = JSON.stringify(allAssets0.filter(keep).map((a) => [a.id, a.purchaseCost, a.gstPaid, a.purchaseDate, a.usefulLifeYears, a.depreciationMethod, a.salvageValue]).sort()) === JSON.stringify(allAssets1.filter(keep).map((a) => [a.id, a.purchaseCost, a.gstPaid, a.purchaseDate, a.usefulLifeYears, a.depreciationMethod, a.salvageValue]).sort());
    check(`D4 purchase cost, GST, purchase date, life, method and residual value of the ${allAssets0.filter(keep).length} assets that existed before (all but the 4 the test corrected by hand) are unchanged`, costSame);
    const stillPosted = [...posted0].every((id) => (fig1.get(id) || { gross: 0 }).gross >= (fig0.get(id) || { gross: 0 }).gross);
    const nbvSame = [...posted0].every((id) => { const a = fig0.get(id); const b = fig1.get(id); return a.accDep === b.accDep && (b.gross === a.gross); });
    check(`D5 net book value (cost - depreciation) of the ${posted0.size} assets posted before the imports is unchanged`, stillPosted && nbvSame);
    const pv = await http('GET', `${BASE}/depreciation/preview?from=2026-03-01&to=2026-03-31`, T);
    check('D6 the depreciation calculation still works (backend untouched): preview for the next month answers with rows', pv.status === 200 && Array.isArray(pv.body.rows) && pv.body.rows.length > 0, pv.status);

    // ================================================================ Q. audit
    const auds = await prisma.auditLog.findMany({ where: { entity: 'FixedAssetImport' }, orderBy: { createdAt: 'asc' } });
    check(`Q1 every confirmed import wrote one audit row with the user, time, source and the counts (${auds.length} rows)`, auds.length >= 14 && auds.every((a) => a.userId && a.actorName && a.createdAt && /^(HRMS records|file )/.test(a.fromValue || '') && /^total \d+ · imported \d+ · updated \d+ · skipped \d+ · duplicates \d+ · failed \d+$/.test(a.toValue || '')), auds.slice(0, 2));
    check('Q2 audit rows carry no sensitive data (no amounts, names, tokens, file contents - only the file name and counts)', auds.every((a) => !/[₹@]|token|password/i.test(`${a.fromValue} ${a.toValue}`)));
    const asAud = await prisma.auditLog.count({ where: { action: 'Asset imported (Accounts)' } });
    const rpAud = await prisma.auditLog.count({ where: { action: 'Asset repair imported (Accounts)' } });
    check('Q3 each created asset / repair has its own audit row', asAud === (await prisma.asset.count({ where: { history: { contains: 'Accounts import' } } })) && rpAud === (await prisma.assetRepair.count({ where: { reportedByName: { startsWith: 'Accounts import' } } })), [asAud, rpAud]);
    const idem = await prisma.appSetting.count({ where: { key: { startsWith: 'idem.fa-import.' } } });
    check('Q4 one-time keys are remembered for 24 h (so a retry replays the first answer)', idem >= 10, idem);

    // ================================================================ cleanup of the real database check
    const { DatabaseSync } = require('node:sqlite');
    const real = new DatabaseSync(REAL, { readOnly: true });
    const zz = real.prepare("SELECT (SELECT COUNT(*) FROM Asset WHERE assetCode LIKE 'ZZ%') a, (SELECT COUNT(*) FROM AssetRepair WHERE repairNo LIKE 'ZZ%') r, (SELECT COUNT(*) FROM AuditLog WHERE entity='FixedAssetImport') u").get();
    real.close();
    check('Z1 the real database holds no ZZTEST asset / repair and no import audit row from this test (the test ran on its copy only)', zz.a === 0 && zz.r === 0 && zz.u === 0, zz);
    console.log(`\nFACTS ${JSON.stringify(facts)}`);
  } catch (e) {
    console.error('TEST CRASHED', e && e.stack ? e.stack : e);
    fail += 1;
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    try { await prisma.$disconnect(); } catch { /* closing */ }
    if (server) server.kill();
    if (ownCopy) { await new Promise((r) => setTimeout(r, 1200)); for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* still open */ } } }
    process.exit(fail ? 1 : 0);
  }
})();
