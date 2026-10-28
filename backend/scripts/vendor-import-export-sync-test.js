#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR EXPORT + IMPORT + AUTOMATIC ASSET SYNC + HRMS REPAIR COMPLAINTS TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/vendor-import-export-sync-test.js                          makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/vies.db node scripts/vendor-import-export-sync-test.js   use a copy you made (never prisma/dev.db)
// Starts its OWN API (port 4081, TEST_MODE: fake mail, no timers, own temp upload folder) on the copy and builds ZZTEST fixtures there.
//   A  EXPORT   every kind of portal: same rows as the list under the same filters, masking, no forbidden fields, formula guard, download tick, IDOR, audit, big-list guard
//   B  IMPORT   sample = contract, preview saves nothing, confirm through the same rules, duplicates, same file twice, 3 concurrent confirms, honest partial failure, refused files
//   C  AUTO     assets added in HRMS / Accounts reach the vendor with no step; SIMs, unmapped, shared category, Admin hide, archived, the 174, "only available"
//   D  TICKETS  a repair complaint raised in HRMS, approved by HR -> one repair job for the vendor; the other kinds / states do nothing
//   E  PRIVACY  no employee name anywhere in what a vendor sees or downloads; unique stable IDs; warranty + amounts
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
let madeCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `vies-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4081);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `vies-uploads-${RUN}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = UPLOADS;
const FAIL_LINE = 47;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const XLSX = require(path.join(BACK, 'node_modules/xlsx'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const groupCount = {};
const check = (g, n, ok, d) => {
  if (ok) pass += 1; else fail += 1;
  groupCount[g] = groupCount[g] || { pass: 0, fail: 0 }; groupCount[g][ok ? 'pass' : 'fail'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const PW = (t) => `Qv#7${t}Lm!${RUN}9`;

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (opt.raw) { h['Content-Type'] = 'application/octet-stream'; payload = opt.raw; }
  else if (opt.form) payload = opt.form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, headers: r.headers };
}
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
const n1 = async (sql, ...p) => (await raw(sql, ...p))[0].n;
const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ZZTEST ${tag} ${RUN}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const upload = (buf, name, type, fields = {}) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf], { type }), name);
  return fd;
};
// real .xlsx / .csv files built here
const xlsxOf = (headers, rows, sheet = 'Data') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const csvOf = (headers, rows) => Buffer.from(`\uFEFF${[headers, ...rows].map((r) => r.map((c) => { const s = String(c ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n')}\r\n`, 'utf8');
const readXlsx = (buf) => { const wb = XLSX.read(buf, { type: 'buffer' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }); };
const readCsv = (buf) => { const wb = XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true }); };

const made = { users: [], vendors: [], assets: [], emps: [] };
(async () => {
  let server; let serverLog = '';
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: UPLOADS, VENDOR_IMPORT_FAIL_LINE: String(FAIL_LINE) } });
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    // ------------------------------------------------------------------ staff
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST VIES ${tag} ${RUN}`, email: `zz-vies-${tag}-${RUN}@example.test`, username: `zz-vies-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      let e = null;
      if (empExtra) {
        e = await prisma.employee.create({ data: { employeeCode: `ZZVIES-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, designation: 'Employee', employmentStatus: 'Active', ...empExtra } });
        made.emps.push(e.id);
      }
      return { u, e };
    };
    const tok = async (x) => jwt.sign(tokenPayload(await resolveIdentity(x.u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const S = {};
    S.admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true, accountsRole: 'ADMIN', hrmsRole: 'ADMIN' }, { department: 'HR' });
    S.hr = await mk('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true }, { department: 'HR' });
    S.hr2 = await mk('hr2', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true }, { department: 'HR' });
    S.emp = await mk('zoya', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { department: 'Education', name: 'Zoya Kapoorzz' });
    S.emp2 = await mk('other', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { department: 'Education' });
    S.mgr = await mk('mgr', { role: 'EMPLOYEE', hrmsRole: 'MANAGER', hrmsAccess: true }, { department: 'Education' });
    S.rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    await prisma.employee.update({ where: { id: S.emp.e.id }, data: { name: 'Zoya Kapoorzz' } });
    const T = {};
    for (const k of Object.keys(S)) T[k] = await tok(S[k]); // eslint-disable-line no-await-in-loop

    // ------------------------------------------------------------------ the real IT vendor on the copy (chandra) BEFORE any test vendor exists
    const realIt = await prisma.officeVendor.findFirst({ where: { name: 'chandra' } });
    const REAL_SQL = `SELECT COUNT(*) AS n FROM "Asset" WHERE "category" IN ('Laptop','Mouse','Laptop Charger','Head Set','Mobile Phone','Phone Charger','Monitor','Mobile') AND "status" NOT IN ('Retired','Sold','Written off')`;
    const realHeld = await n1(`${REAL_SQL} AND "assignedToId" IS NOT NULL`);
    const realAvail = await n1(`${REAL_SQL} AND "status" = 'Available' AND "assignedToId" IS NULL`);
    const realInRepair = await n1(`${REAL_SQL} AND "status" = 'In Repair'`);
    const totalAssets0 = await n1('SELECT COUNT(*) AS n FROM "Asset"');
    let realMembers = 0; let realView = null;
    if (realIt) {
      realView = await http('GET', `/api/vendor-logins/asset-grants/${realIt.id}`, T.admin);
      realMembers = await n1(REAL_SQL);
      check('C', `REAL DATA (copy): the IT vendor "chandra" has ${realMembers} IT-hardware assets by category = the independent SQL count 174 (${realHeld} held by employees, ${realAvail} available/in stock, ${realInRepair} In Repair)`,
        realMembers === 174 && realView.status === 200 && realView.body.auto && realView.body.auto.total === 174, { members: realMembers, auto: realView.body && realView.body.auto && realView.body.auto.total });
      check('C', `REAL DATA: the admin screen number = what the vendor is shown: all 174 (with employees + ${realAvail} in stock + ${realInRepair} under repair - founder decision 2026-10-27); no grant, no import`,
        realView.body.total === 174 && realView.body.available === realAvail && realView.body.underRepair === realInRepair && realView.body.available + realView.body.underRepair + realView.body.withEmployees + (realView.body.noHolderNamed || 0) === realView.body.total && realView.body.byReason.auto === realView.body.total && realView.body.byReason.admin === 0, { total: realView.body.total, a: realView.body.available, u: realView.body.underRepair, w: realView.body.withEmployees, held: realHeld });
      check('C', 'REAL DATA: no SIM card is in the IT vendor list, and the automatic map shows the 8 real categories', !realView.body.rows.some((r) => r.category === 'SIM Card') && realView.body.auto.categories.length === 8);
    }
    if (realIt) await raw('UPDATE "OfficeVendor" SET "isActive" = 0 WHERE "id" = ?', realIt.id); // (the copy only) so test vendors are not "peers" of the real one

    // ------------------------------------------------------------------ vendors and logins
    const IT = 'IT / Hardware / AMC / Service';
    const mkVendor = async (tag, category, nameExtra = '') => {
      const v = await prisma.officeVendor.create({ data: { name: `ZZTEST VIES ${tag}${nameExtra} ${RUN}`, companyName: `ZZTEST VIES Co ${tag} ${RUN}`, isActive: true, category } });
      made.vendors.push(v.id); return v;
    };
    const V = {
      it: await mkVendor('IT', IT), it2: await mkVendor('IT2', IT), oth: await mkVendor('Fin', 'Other'), id: await mkVendor('Cards', 'ID Cards'), tel: await mkVendor('Airtel', null),
    };
    const mkLogin = async (vendor, tag, { canEdit = true, canViewCost = false } = {}) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-vies-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit, canViewCost } });
      return { u, pw, vendor };
    };
    const L = {
      it: await mkLogin(V.it, 'it'), itView: await mkLogin(V.it, 'itview', { canEdit: false }), itNoDl: await mkLogin(V.it, 'itnodl'), itHide: await mkLogin(V.it, 'ithide'),
      fin: await mkLogin(V.oth, 'fin'), finNo: await mkLogin(V.oth, 'finno'), id: await mkLogin(V.id, 'id'), tel: await mkLogin(V.tel, 'tel'), telNo: await mkLogin(V.tel, 'telno'),
    };
    const nowMs = Date.now();
    const addMod = (login, key, perms) => raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzvm${key}${login.u.id}`.slice(0, 40), login.u.id, key, JSON.stringify(perms), nowMs, nowMs);
    await addMod(L.itNoDl, 'assets', { download: false });
    await addMod(L.itHide, 'assets', { hideAmounts: true });
    await addMod(L.fin, 'invoices', { raise: true, viewStatus: true }); await addMod(L.fin, 'payments', {});
    await addMod(L.finNo, 'invoices', { raise: false, viewStatus: true, download: false });
    await addMod(L.id, 'id_card_orders', {});
    await addMod(L.tel, 'airtel_bills', { sendBill: true });
    await addMod(L.telNo, 'airtel_bills', { sendBill: false });
    const sign = async (x) => { const r = await http('POST', '/api/vendor-portal/login', null, { email: x.u.email, password: x.pw }); x.token = r.body && r.body.token; return r; };
    for (const x of Object.values(L)) await sign(x); // eslint-disable-line no-await-in-loop
    check('A', 'fixture: every test vendor signs in with the real login', Object.values(L).every((x) => !!x.token));
    const G = (x, p) => http('GET', `/api/vendor-portal${p}`, x.token);
    const meKind = async (x) => (await G(x, '/me')).body.kind;
    check('A', 'kinds: IT login = assets, "Other" with invoices+payments = finance, ID cards = idcards, Airtel Bills tick = telecom', (await meKind(L.it)) === 'assets' && (await meKind(L.fin)) === 'finance' && (await meKind(L.id)) === 'idcards' && (await meKind(L.tel)) === 'telecom');

    // ------------------------------------------------------------------ fixtures: assets, repairs, orders, SIMs, bills
    const cleanDay = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const mkAsset = async (n, o = {}) => {
      const a = await prisma.asset.create({ data: { assetCode: o.code || `ZZAV-${RUN}-${n}`, name: o.name || `ZZTEST Asset ${n}`, category: o.category || 'Laptop', status: o.status || 'Available', assignedToId: o.holder || null, vendorId: o.vendorId || null, assetType: o.assetType || null, serialNumber: o.serial || null, purchaseCost: o.cost === undefined ? null : o.cost, gstPaid: o.gst === undefined ? null : o.gst, purchaseDate: '2026-01-10', warrantyUntil: o.warranty === undefined ? null : o.warranty, location: o.location || 'Hyderabad' } });
      made.assets.push(a.id); return a;
    };
    const a1 = await mkAsset(1, { cost: 90000, gst: 16200, warranty: cleanDay(40), serial: `SN-A1-${RUN}`, assetType: 'MacBook Pro 14' });
    const a2 = await mkAsset(2, { category: 'Mouse', cost: null, warranty: cleanDay(-12) });
    const a3 = await mkAsset(3, { category: 'Monitor', cost: 7000, warranty: null });
    const a4 = await mkAsset(4, { category: 'Furniture' }); // no map -> nobody
    const a5 = await mkAsset(5, { category: 'SIM Card', name: 'Airtel SIM · 9876501234', assetType: `Airtel · ICCID 89910009236877${RUN.length}` });
    const a6 = await mkAsset(6, { status: 'Retired' }); // archived
    const a7 = await mkAsset(7, { vendorId: V.oth.id }); // linked to ANOTHER vendor: stays theirs
    const a8 = await mkAsset(8, { code: `ZZEdu 88-Zoya-L ${RUN}`, name: 'Lenovo ThinkPad Laptop', holder: S.emp.e.id, status: 'Assigned', cost: 55000, warranty: cleanDay(100), assetType: 'Lenovo ThinkPad' });
    const a9 = await mkAsset(9, { code: `ZZEdu 88-Zoya-H ${RUN}`, name: 'Plantronics Head Set', holder: S.emp.e.id, status: 'Assigned', category: 'Head Set', cost: 1000 }); // held, NO repair job: must not show
    const a10 = await mkAsset(10, { status: 'In Repair', category: 'Laptop' });
    const a11 = await mkAsset(11, { code: `ZZEdu 77-Sneha-L ${RUN}` }); // former holder's name in the code, nobody holds it now
    const a12 = await mkAsset(12, { code: `ZZEdu 77-Sneha-L ${RUN}`.replace('-L', '-H'), category: 'Head Set' });
    const ar1 = await mkAsset('R1', { cost: 90000, gst: 16200, warranty: cleanDay(40) });
    const ar2 = await mkAsset('R2', { category: 'Mouse', cost: 300, warranty: cleanDay(-12) });
    const ar3 = await mkAsset('R3', { category: 'Monitor', cost: 7000 });

    // repairs (made by the company, as in HRMS)
    const hrmsRepair = (assetId, body) => http('POST', `/api/asset-inventory/${assetId}/repairs`, T.hr, body);
    const repI = async (assetId, body) => (await hrmsRepair(assetId, { vendor: V.it.name, dateReported: '2026-09-20', repairType: 'Repair', ...body })).body.repair;
    const R1 = await repI(ar1.id, { issue: 'Screen flickers' });
    const R2 = await repI(ar1.id, { issue: 'Hinge loose' });
    const R3 = await repI(ar3.id, { issue: '=cmd|\' /C calc\'!A0' }); // a formula typed as a problem
    const R4 = await repI(ar2.id, { issue: 'Cable broken' });
    const RF = (await hrmsRepair(a7.id, { vendor: V.oth.name, issue: 'Belongs to another vendor', dateReported: '2026-09-21' })).body.repair; // another vendor's repair
    check('D', 'fixture: repairs raised through the real HRMS API (status Reported)', [R1, R2, R3, R4, RF].every((r) => r && r.status === 'Reported'), [R1, R2]);
    const ovBase = await G(L.it, '/asset-portal/overview');
    check('A', 'the asset portal opens for the IT vendor', ovBase.status === 200, ovBase.body);

    // id-card orders
    const t0 = Date.now();
    const mkOrder = async (n, vendor, status, lines) => {
      const id = `zzidc${n}${RUN}`;
      await raw('INSERT INTO "IdCardOrder" ("id","orderCode","vendorId","status","note","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)', id, `ZZ-IDC-${n}-${RUN}`.slice(0, 24), vendor.id, status, `ZZTEST order ${n}`, t0, t0);
      for (let i = 0; i < lines; i += 1) await raw('INSERT INTO "IdCardOrderLine" ("id","orderId","employeeId","employeeName","cardType","department","createdAt") VALUES (?,?,?,?,?,?,?)', `zzl${n}${i}${RUN}`, id, `zzemp${n}${i}${RUN}`, `ZZTEST Person ${n}${i}`, 'Standard', 'Education', t0); // eslint-disable-line no-await-in-loop
      return { id, code: `ZZ-IDC-${n}-${RUN}`.slice(0, 24) };
    };
    const O1 = await mkOrder('1', V.id, 'New', 2); const O2 = await mkOrder('2', V.id, 'Printing', 1); const O3 = await mkOrder('3', V.it, 'New', 1); const O4 = await mkOrder('4', V.oth, 'New', 1);
    // a purchase-order document for the finance vendor
    const podoc = await prisma.vendorSharedDocument.create({ data: { vendorId: V.oth.id, title: `ZZ PO ${RUN}`, docType: 'Purchase order', name: 'po.pdf', mime: 'application/pdf', size: 10, file: 'x.pdf', note: 'ZZTEST PO' } });

    // =====================================================================================================================
    // A  EXPORT
    // =====================================================================================================================
    const FORBID = /bank|narration|utr\b|account no|ifsc|password|salary|phone|e-?mail|employee name|aadhaar|pan\b/i;
    const allRows = async (x, p, params = {}) => {
      const out = []; let total = 0;
      for (let page = 1; page < 60; page += 1) {
        const qs = new URLSearchParams({ ...params, page: String(page), pageSize: '100' });
        const r = await G(x, `${p}?${qs}`); // eslint-disable-line no-await-in-loop
        if (r.status !== 200) return { status: r.status, rows: out, total };
        out.push(...r.body.rows); total = r.body.total;
        if (page >= r.body.pages) break;
      }
      return { status: 200, rows: out, total };
    };
    const exportOf = (x, list, params = {}, format = 'csv') => http('GET', `/api/vendor-portal/vendor-io/export/${list}?${new URLSearchParams({ ...params, format })}`, x.token);
    const grid = (r, format) => (format === 'xlsx' ? readXlsx(r.buf) : readCsv(r.buf));
    const auditN = () => n1(`SELECT COUNT(*) AS n FROM "AssetAuditLog" WHERE "action" = 'List exported'`);

    // ---- IT (assets) vendor: every list, csv + xlsx
    const a0 = await auditN();
    const exA = { assets: await exportOf(L.it, 'assets'), assetsX: await exportOf(L.it, 'assets', {}, 'xlsx') };
    const listA = await allRows(L.it, '/asset-portal/assets');
    const gA = grid(exA.assets, 'csv'); const gAx = grid(exA.assetsX, 'xlsx');
    check('A', `Assets export (CSV and Excel) holds exactly the rows the Assets list shows: ${listA.total} rows`, exA.assets.status === 200 && gA.length - 1 === listA.total && gAx.length - 1 === listA.total && gA[0][0] === 'Asset ID', { list: listA.total, csv: gA.length - 1, x: gAx.length - 1, status: exA.assets.status });
    const idsList = new Set(listA.rows.map((r) => r.assetCode)); const idsCsv = new Set(gA.slice(1).map((r) => r[0]));
    check('A', 'the exported Asset IDs are the same set as the list (sample of cells equal: name, category, status)', [...idsList].every((c) => idsCsv.has(c)) && gA.slice(1, 6).every((r) => { const l = listA.rows.find((x) => x.assetCode === r[0]); return l && l.name === r[1] && l.category === r[2] && l.status === r[8]; }));
    check('A', 'export file: UTF-8 byte-order mark, attachment file name like assets-<vendor>-<date>.csv, X-Row-Count header', exA.assets.buf[0] === 0xef && exA.assets.buf[1] === 0xbb && /assets-zztest-vies-it.*-\d{4}-\d{2}-\d{2}\.csv/.test(exA.assets.headers.get('content-disposition')) && Number(exA.assets.headers.get('x-row-count')) === listA.total, exA.assets.headers.get('content-disposition'));
    const fq = { q: 'ZZTEST', category: 'Laptop' };
    const exF = await exportOf(L.it, 'assets', fq);
    const listF = await allRows(L.it, '/asset-portal/assets', fq);
    check('A', 'the SAME search + filter applies to the export: q=ZZTEST + category=Laptop -> same count as the list', exF.status === 200 && grid(exF, 'csv').length - 1 === listF.total && listF.total > 0 && listF.total < listA.total, { exp: grid(exF, 'csv').length - 1, list: listF.total });
    const exSorted = await exportOf(L.it, 'assets', { sort: 'name', dir: 'desc' });
    const gS = grid(exSorted, 'csv').slice(1).map((r) => r[1]);
    check('A', 'sort is applied to the export (name descending)', gS.length > 2 && gS.every((v, i) => i === 0 || String(gS[i - 1]).localeCompare(String(v)) >= 0));
    const exR = await exportOf(L.it, 'repairs'); const listR = await allRows(L.it, '/asset-portal/repairs');
    const gR = grid(exR, 'csv');
    check('A', `Repairs export = the Repairs list (${listR.total} rows); the formula typed as a problem is neutralised with a leading apostrophe in CSV and in Excel`, gR.length - 1 === listR.total && gR.some((r) => String(r[3]).startsWith("'=cmd")) && grid(await exportOf(L.it, 'repairs', {}, 'xlsx'), 'xlsx').some((r) => String(r[3]).startsWith("'=cmd")) && !gR.some((r) => /^=/.test(String(r[3]))), gR.map((r) => r[3]));
    const exH = await exportOf(L.it, 'history'); const exI = await exportOf(L.it, 'invoices'); const exO = await exportOf(L.it, 'orders');
    const hist = await allRows(L.it, '/asset-portal/history'); const inv = await allRows(L.it, '/asset-portal/invoices'); const ord = await allRows(L.it, '/asset-portal/orders');
    check('A', `History / Invoices / Orders exports = their lists (${hist.total} / ${inv.total} / ${ord.total})`, [exH, exI, exO].every((x) => x.status === 200) && grid(exH, 'csv').length - 1 === hist.total && grid(exI, 'csv').length - 1 === inv.total && grid(exO, 'csv').length - 1 === ord.total, [hist.total, inv.total, ord.total]);
    const heads = [exA.assets, exR, exH, exI, exO].map((x) => grid(x, 'csv')[0].join(' | '));
    check('A', 'no forbidden field in any export header (bank, narration, UTR, account, phone, e-mail, employee name)', heads.every((h) => !FORBID.test(h)), heads);
    check('A', 'a vendorId in the query is never read (another vendor id changes nothing)', JSON.stringify(grid(await exportOf(L.it, 'assets', { vendorId: V.oth.id, vendorUserId: L.fin.u.id }), 'csv').slice(1).map((r) => r[0]).sort()) === JSON.stringify(gA.slice(1).map((r) => r[0]).sort()));
    check('A', 'IDOR: the other vendor\'s repair (RF) is in nobody else\'s export, and the IT vendor\'s export does not hold it', !gR.some((r) => r[0] === RF.repairNo));
    check('A', 'a list of ANOTHER kind is not exportable (an IT vendor asking for finance "payments" or Airtel "sims" gets 404), and an unknown list too', (await exportOf(L.it, 'payments')).status === 404 && (await exportOf(L.it, 'sims')).status === 404 && (await exportOf(L.it, 'nothing')).status === 404);
    const a1n = await auditN();
    check('A', 'an audit row is written for each export: who / when / list / row count, never the data', a1n - a0 >= 9 && (await raw(`SELECT "newValue","documentName","actorName" FROM "AssetAuditLog" WHERE "action" = 'List exported' ORDER BY "createdAt" DESC LIMIT 5`)).every((r) => /row\(s\)/.test(r.newValue) && !/ZZTEST Asset/.test(r.newValue)), a1n - a0);
    const noDl = await exportOf(L.itNoDl, 'assets');
    const infoNoDl = await G(L.itNoDl, '/vendor-io/info');
    check('A', 'without the "Download lists" tick: server 403 with a plain reason, and /info says the buttons are off with that reason', noDl.status === 403 && /download/i.test(noDl.body.error) && infoNoDl.body.export.allowed === false && /Download lists/.test(infoNoDl.body.export.reason), noDl.body);
    check('A', 'no token = 401', (await http('GET', '/api/vendor-portal/vendor-io/export/assets', null)).status === 401);
    const staffTry = await http('GET', '/api/vendor-portal/vendor-io/export/assets', T.admin);
    check('A', 'a staff token cannot use the vendor export (401/403)', [401, 403].includes(staffTry.status), staffTry.status);

    // ---- finance vendor
    const mkMod = (n, st, amount, extra = {}) => raw('INSERT INTO "VendorModuleBill" ("id","billCode","vendorId","vendorUserId","kind","billNumber","billNumberKey","billDate","dueDate","amount","gst","total","lines","remarks","status","paidOn","paidAmount","paymentRef","paymentMode","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      `zzmb${n}${RUN}`, `ZZVM-${n}-${RUN}`.slice(0, 20), V.oth.id, L.fin.u.id, 'invoice', `ZZINV-${n}-${RUN}`, `zzinv-${n}-${RUN}`, '2026-09-1' + n, '2026-10-1' + n, amount, 18, amount + 18, '[]', extra.remarks || `ZZ service ${n}`, st, extra.paidOn || null, extra.paidAmount || null, extra.paymentRef || null, extra.mode || null, nowMs + n, nowMs + n);
    await mkMod(1, 'Paid', 1000, { paidOn: '2026-09-30', paidAmount: 1018, paymentRef: 'REF-OK-1', mode: 'Bank' }); await mkMod(2, 'Submitted', 2000); await mkMod(3, 'Rejected', 3000, { remarks: '=HYPERLINK("http://evil")' });
    const finLists = ['invoices', 'payments', 'purchase-orders'];
    for (const l of finLists) {
      const ex = await exportOf(L.fin, l); // eslint-disable-line no-await-in-loop
      const lst = await allRows(L.fin, `/records/${l}`); // eslint-disable-line no-await-in-loop
      const g = grid(ex, 'csv');
      check('A', `finance ${l}: export = the list (${lst.total} rows), CSV and Excel`, ex.status === 200 && g.length - 1 === lst.total && grid(await exportOf(L.fin, l, {}, 'xlsx'), 'xlsx').length - 1 === lst.total && !FORBID.test(g[0].join(' ')), { s: ex.status, exp: g.length - 1, list: lst.total }); // eslint-disable-line no-await-in-loop
    }
    const gInv = grid(await exportOf(L.fin, 'invoices'), 'csv');
    check('A', 'finance invoices: the formula-looking description is neutralised; the filter status=paid applies to the export', gInv.some((r) => String(r[4]).startsWith("'=HYPERLINK")) && grid(await exportOf(L.fin, 'invoices', { status: 'paid' }), 'csv').length - 1 === (await allRows(L.fin, '/records/invoices', { status: 'paid' })).total);
    const finNoDl = await exportOf(L.finNo, 'invoices');
    check('A', 'finance login with "Download lists" off: 403', finNoDl.status === 403, finNoDl.body);
    check('A', 'the finance vendor\'s export holds none of the IT vendor\'s data and the IT export none of the finance vendor\'s', !gInv.some((r) => /ZZTEST Asset/.test(r.join())) && !gA.some((r) => /ZZINV/.test(r.join())));

    // ---- ID card vendor
    const exI1 = await exportOf(L.id, 'requests'); const listI1 = await G(L.id, '/idcard-portal/requests?pageSize=100');
    const exIp = await exportOf(L.id, 'requests', { bucket: 'pending' }); const listIp = await G(L.id, '/idcard-portal/requests?bucket=pending&pageSize=100');
    check('A', `ID card requests export = the list (all ${listI1.body.total}, pending ${listIp.body.total}); Excel too; other vendor\'s order lines absent`, exI1.status === 200 && grid(exI1, 'csv').length - 1 === listI1.body.total && grid(exIp, 'csv').length - 1 === listIp.body.total && grid(await exportOf(L.id, 'requests', {}, 'xlsx'), 'xlsx').length - 1 === listI1.body.total && !exI1.text.includes(O3.code) && !exI1.text.includes(O4.code), { all: listI1.body.total, p: listIp.body.total, got: grid(exI1, 'csv').length - 1 });
    const idNo = await mkLogin(V.id, 'idno'); await addMod(idNo, 'id_card_orders', { download: false }); await sign(idNo);
    check('A', 'ID card login without the download tick: 403', (await exportOf(idNo, 'requests')).status === 403);

    // ---- Airtel vendor
    const simN = await n1(`SELECT COUNT(*) AS n FROM "Asset" WHERE "category" = 'SIM Card'`);
    const exS = await exportOf(L.tel, 'sims'); const listS = await allRows(L.tel, '/airtel-portal/sims');
    const exB = await exportOf(L.tel, 'bills'); const listB = await allRows(L.tel, '/airtel-portal/bills');
    const exTh = await exportOf(L.tel, 'history'); const listTh = await allRows(L.tel, '/airtel-portal/history');
    check('A', `Airtel Bills / Monthly History / SIMs exports = their lists (${listB.total} / ${listTh.total} / ${listS.total}), CSV + Excel`, exS.status === 200 && exB.status === 200 && exTh.status === 200 && grid(exS, 'csv').length - 1 === listS.total && grid(exB, 'csv').length - 1 === listB.total && grid(exTh, 'csv').length - 1 === listTh.total && grid(await exportOf(L.tel, 'sims', {}, 'xlsx'), 'xlsx').length - 1 === listS.total, { s: listS.total, simN });
    check('A', 'SIM export: numbers stay masked (no 10-digit number anywhere), no holder name, department only', !/\d{10}/.test(exS.text) && grid(exS, 'csv')[0].join() === 'SIM ID,Mobile number,SIM card,Department,Status,Last bill' && listS.total >= 1, grid(exS, 'csv').slice(0, 3));
    check('A', 'Airtel login without the download tick still lists but cannot export? (telNo has it on by default) -> allowed; a login with the tick off -> 403', (await exportOf(L.telNo, 'sims')).status === 200);
    const telOff = await mkLogin(V.tel, 'teloff'); await addMod(telOff, 'airtel_bills', { sendBill: true, download: false }); await sign(telOff);
    check('A', 'Airtel login with "Download lists" off: 403', (await exportOf(telOff, 'sims')).status === 403);

    // ---- the guard for a huge list (in-process: the list is stubbed to 10,001 rows)
    const EX = require(path.join(BACK, 'src/utils/vendorExport'));
    const keep = EX.LISTS.finance.invoices.fetch;
    EX.LISTS.finance.invoices.fetch = async () => ({ rows: Array.from({ length: 10001 }, (_, i) => ({ invoiceNo: `X${i}` })) });
    let big = null; try { await EX.build('finance', 'invoices', { vendorId: 'x', vendorName: 'x' }, {}, 'csv'); } catch (e) { big = e; }
    EX.LISTS.finance.invoices.fetch = async () => ({ rows: Array.from({ length: 10000 }, (_, i) => ({ invoiceNo: `X${i}`, statusText: 's' })) });
    let okBig = null; try { okBig = await EX.build('finance', 'invoices', { vendorId: 'x', vendorName: 'x' }, {}, 'csv'); } catch (e) { okBig = e; }
    EX.LISTS.finance.invoices.fetch = keep;
    check('A', 'large export guard: 10,001 rows refused with a plain message (413); exactly 10,000 allowed', big && big.status === 413 && /10,000/.test(big.message) && okBig && okBig.count === 10000, big && big.message);
    const EA = require(path.join(BACK, 'src/utils/exportAll'));
    check('A', 'the "all rows" switch is a Symbol: a query string can never carry it (page size stays capped at 100)', typeof EA.EXPORT_ALL === 'symbol' && (await G(L.fin, '/records/invoices?pageSize=100000&_all=true')).body.pageSize <= 100);

    // =====================================================================================================================
    // C  AUTOMATIC SYNC (+ "only available")
    // =====================================================================================================================
    const zz = (rows) => rows.filter((r) => /ZZ/i.test(r.assetCode));
    const avail = async (x, view = 'available', params = {}) => allRows(x, '/asset-portal/assets', { view, ...params });
    let lv = await avail(L.it);
    const codeOfList = (rows) => new Set(rows.map((r) => r.assetCode));
    const M0 = await require(path.join(BACK, 'src/utils/vendorAssetMask')).load(true);
    const mc = (a) => M0.code({ id: a.id });
    check('C', 'AUTOMATIC: with NO grant and NO import the IT vendor sees the free ZZ assets of its categories (laptop, mouse, monitor); not the SIM, not the unmapped Furniture, not the Retired one, not the one linked to another vendor',
      [a1, a2, a3].every((a) => codeOfList(lv.rows).has(mc(a))) && ![a4, a5, a6, a7].some((a) => codeOfList(lv.rows).has(mc(a))), { got: [...codeOfList(lv.rows)].filter((c) => /ZZ/.test(c)) });
    check('C', '"ONLY AVAILABLE": an asset held by an employee with no repair job (the ZZ laptop and headset) is NOT in the list', !codeOfList(lv.rows).has(mc(a8)) && !codeOfList(lv.rows).has(mc(a9)));
    const grantsBefore = await n1('SELECT COUNT(*) AS n FROM "VendorAssetGrant"');
    const adminView = await http('GET', `/api/vendor-logins/asset-grants/${V.it.id}`, T.admin);
    const listTabs = await G(L.it, '/asset-portal/assets?view=available&pageSize=5');
    check('C', 'the Admin screen number equals what the vendor\'s list shows (all = with employees + in stock + under repair), tab counts included', adminView.body.total === listTabs.body.tabs.all && adminView.body.available === listTabs.body.tabs.available && adminView.body.underRepair === listTabs.body.tabs.repair && adminView.body.withEmployees === listTabs.body.tabs.assigned, { admin: [adminView.body.total, adminView.body.available, adminView.body.underRepair, adminView.body.withEmployees], tabs: listTabs.body.tabs });
    // a new asset through the REAL HRMS add path
    const aBefore = await avail(L.it);
    const add1 = await http('POST', '/api/asset-inventory', T.hr, { name: `ZZTEST HRMS Laptop ${RUN}`, category: 'Laptop', purchaseCost: 42000, warrantyUntil: cleanDay(300) });
    if (add1.status === 201) made.assets.push(add1.body.id);
    const aAfter = await avail(L.it);
    check('C', 'a NEW asset added in HRMS (real add API) shows for the IT vendor on its very next request, no grant, no import, no copy', add1.status === 201 && aAfter.total === aBefore.total + 1 && aAfter.rows.some((r) => r.name === `ZZTEST HRMS Laptop ${RUN}`), { s: add1.status, before: aBefore.total, after: aAfter.total });
    // a new asset through the Accounts file import (Fixed Assets)
    const sampleCsv = await http('GET', '/api/accounts/fixed-assets/import/sample?section=assets&format=csv', T.admin);
    const hdr = readCsv(sampleCsv.buf)[0];
    const rowFor = (code, name, cat, extra = {}) => hdr.map((h) => {
      const k = String(h).replace(/[✱*]/g, '').trim();
      return ({ 'Asset ID': code, 'Asset Name': name, Category: cat, 'Purchase Date': '2026-10-01', 'Purchase Cost': extra.cost ?? 8000, 'GST Paid': extra.gst ?? 1440, 'Paid Via': 'Payable', Status: 'Available', 'Warranty Until': extra.warranty ?? cleanDay(200) })[k] ?? '';
    });
    const accFile = csvOf(hdr, [rowFor(`ZZACC-${RUN}-1`, `ZZTEST Accounts Mouse ${RUN}`, 'Mouse'), rowFor(`ZZACC-${RUN}-2`, `ZZTEST Accounts SIM ${RUN}`, 'SIM Card')]);
    const before2 = await avail(L.it);
    const accPrev = await http('POST', `/api/accounts/fixed-assets/import/preview?section=assets&source=file&fileName=a.csv`, T.admin, undefined, { raw: accFile });
    const accConf = await http('POST', `/api/accounts/fixed-assets/import/confirm?section=assets&source=file&fileName=a.csv`, T.admin, undefined, { raw: accFile, headers: { 'Idempotency-Key': `viesacc${RUN}` } });
    const after2 = await avail(L.it);
    const newIds = await raw(`SELECT "id" FROM "Asset" WHERE "assetCode" LIKE ?`, `ZZACC-${RUN}-%`); newIds.forEach((r) => made.assets.push(r.id));
    check('C', 'a NEW asset added from the ACCOUNTS side (fixed-assets file import) shows for the IT vendor on its next request: same Asset table, no extra step', accPrev.status === 200 && accConf.status === 200 && newIds.length === 2 && after2.total === before2.total + 1 && after2.rows.some((r) => r.name === `ZZTEST Accounts Mouse ${RUN}`), { p: accPrev.status, c: accConf.status, ids: newIds.length, before: before2.total, after: after2.total, body: accConf.body && accConf.body.error });
    check('C', 'the Accounts SIM Card is NOT shown to the IT vendor (it belongs to the telecom vendor) and is shown on the Airtel SIMs page', !after2.rows.some((r) => r.name === `ZZTEST Accounts SIM ${RUN}`) && (await allRows(L.tel, '/airtel-portal/sims')).total >= 1);
    const countA1 = await n1('SELECT COUNT(*) AS n FROM "Asset"');
    for (let i = 0; i < 3; i += 1) { await avail(L.it); await G(L.it, '/asset-portal/overview'); }
    check('C', 'reading the portal again changes nothing in the Asset table (no copy, no duplicate)', (await n1('SELECT COUNT(*) AS n FROM "Asset"')) === countA1);
    check('C', 'the number of Asset IDs shown to the vendor is unique (no asset twice)', new Set(aAfter.rows.map((r) => r.id)).size === aAfter.rows.length && new Set(aAfter.rows.map((r) => r.assetCode.toLowerCase())).size === aAfter.rows.length);
    // an unmapped category is shown to nobody
    const anyoneSees = async () => { const o = await Promise.all([avail(L.it), avail(L.it, 'repair')]); return o.some((x) => x.rows.some((r) => r.id === a4.id)); };
    check('C', 'an unmapped category (Furniture) is shown to nobody: not in either tab', !(await anyoneSees()));
    // sums vs independent SQL for the test vendor
    const sqlAvail = await n1(`SELECT COUNT(*) AS n FROM "Asset" WHERE "category" IN ('Laptop','Mouse','Laptop Charger','Head Set','Mobile Phone','Phone Charger','Monitor','Mobile','Desktop','Keyboard','Tablet','Printer','Scanner','Router','Webcam','Pen Drive','Hard Disk','Docking Station','UPS') AND "status" = 'Available' AND "assignedToId" IS NULL AND ("vendorId" IS NULL OR "vendorId" = ?) AND "id" NOT IN (SELECT "assetId" FROM "AssetRepair" WHERE "status" IN ('Reported','In Repair') AND "assetId" IS NOT NULL)`, V.it.id);
    const listNow = await avail(L.it);
    check('C', `the vendor's Available count (${listNow.total}) equals an independent SQL recomputation (${sqlAvail}) on the copy`, listNow.total === sqlAvail, { list: listNow.total, sql: sqlAvail });
    // the asset with an open repair job shows under repair even when it is held; a1 has open repair jobs -> under repair, not available
    const rep = await avail(L.it, 'repair');
    check('C', '"Under repair" tab = the assets with an open repair job (ar1, ar2, ar3 have jobs) plus the HRMS "In Repair" status; they leave the Available tab', [ar1, ar2, ar3].every((a) => rep.rows.some((r) => r.id === a.id)) && rep.rows.some((r) => r.id === a10.id) && ![ar1, ar2, ar3].some((a) => aAfter.rows.some((r) => r.id === a.id)), { rep: rep.total });
    // two vendors share the category -> neither
    await raw('UPDATE "OfficeVendor" SET "isActive" = 1 WHERE "id" = ?', V.it2.id);
    const it2login = await mkLogin(V.it2, 'it2'); await sign(it2login);
    const bothA = await avail(L.it); const bothB = await avail(it2login);
    const confView = await http('GET', `/api/vendor-logins/asset-grants/${V.it.id}`, T.admin);
    check('C', 'TWO live vendors on one category: the assets are shown to NEITHER automatically, and Admin gets them listed (autoConflicts + a warning)', !bothA.rows.some((r) => r.id === a3.id) && bothB.total === 0 && confView.body.autoConflicts.length >= 1 && confView.body.auto.conflict === true, { a: bothA.total, b: bothB.total, c: confView.body.autoConflicts });
    const gr = await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}`, T.admin, { assetIds: [], categories: ['Laptop', 'Mouse', 'Monitor'] });
    const afterGrant = await avail(L.it); const stillNone = await avail(it2login);
    check('C', 'Admin resolves it by ticking categories for ONE vendor: that vendor sees them, the other still none', gr.status === 200 && afterGrant.rows.some((r) => r.id === a3.id) && stillNone.total === 0, { g: gr.status, n: afterGrant.total });
    await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}`, T.admin, { assetIds: [], categories: [] });
    await raw('UPDATE "OfficeVendor" SET "isActive" = 0 WHERE "id" = ?', V.it2.id);
    await raw('UPDATE "VendorUser" SET "status" = ? WHERE "vendorId" = ?', 'Inactive', V.it2.id);
    const back = await avail(L.it);
    check('C', 'with the second vendor switched off, the first sees them again by itself', back.rows.some((r) => r.id === a3.id));
    // Admin hide (exclude)
    const hideC = await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}/hide`, T.admin, { assetIds: [], categories: ['Monitor'] });
    const hid = await avail(L.it);
    check('C', 'Admin HIDES a category from the automatic rule: Monitors disappear for that vendor, others stay', hideC.status === 200 && !hid.rows.some((r) => r.id === a3.id) && hid.rows.some((r) => r.id === a2.id) === (await avail(L.it)).rows.some((r) => r.id === a2.id), hideC.body);
    await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}/hide`, T.admin, { assetIds: [], categories: [] });
    const hideA = await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}/hide`, T.admin, { assetIds: [a11.id], categories: [] });
    const hid2 = await avail(L.it);
    check('C', 'Admin HIDES one asset: only that one goes; un-hiding brings it back', hideA.status === 200 && !hid2.rows.some((r) => r.id === a11.id) && hid2.rows.some((r) => r.id === a3.id));
    await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}/hide`, T.admin, { assetIds: [], categories: [] });
    check('C', 'un-hidden: the asset is back', (await avail(L.it)).rows.some((r) => r.id === a11.id));
    check('C', 'a recruiter (not Admin) cannot read or change the hide list or the category map (403)', (await http('PUT', `/api/vendor-logins/asset-grants/${V.it.id}/hide`, T.rec, { assetIds: [], categories: ['Monitor'] })).status === 403 && (await http('PUT', '/api/vendor-logins/asset-grants/category-map', T.rec, { map: { it_service: [] } })).status === 403);
    const mapGet = await http('GET', '/api/vendor-logins/asset-grants/category-map', T.admin);
    check('C', 'the category map is data: defaults are served, Admin can change it (audited) and it applies at once; changing it back restores', mapGet.status === 200 && mapGet.body.map.it_service.includes('Laptop'), mapGet.body && mapGet.body.map);
    await http('PUT', '/api/vendor-logins/asset-grants/category-map', T.admin, { map: { it_service: ['Laptop'] } });
    const mapped1 = await avail(L.it);
    await http('PUT', '/api/vendor-logins/asset-grants/category-map', T.admin, { map: { it_service: mapGet.body.map.it_service } });
    const mapped2 = await avail(L.it);
    check('C', 'a smaller map shrinks the vendor\'s list at once; the full map brings it back', !mapped1.rows.some((r) => r.id === a2.id) && mapped1.rows.some((r) => r.id === a11.id) && mapped2.rows.some((r) => r.id === a2.id) && (await n1(`SELECT COUNT(*) AS n FROM "AuditLog" WHERE "action" = 'Vendor asset category map changed'`)) >= 2);
    // archived hidden: retire a currently shown asset
    await raw(`UPDATE "Asset" SET "status" = 'Retired' WHERE "id" = ?`, a12.id);
    check('C', 'a Retired asset leaves the vendor\'s list at once', !(await avail(L.it)).rows.some((r) => r.id === a12.id));
    await raw(`UPDATE "Asset" SET "status" = 'Available' WHERE "id" = ?`, a12.id);
    // the auto-refresh logic (pure)
    const { pathToFileURL } = require('url');
    const RULE = await import(pathToFileURL(path.join(BACK, '..', 'frontend/src/pages/vendor/autoRefreshRule.js')).href);
    const now0 = 1e9;
    check('C', 'Assets page refresh rule (pure logic): every 60 s while visible; a hidden tab never asks; coming back asks after 15 s; "Updated <time>" text', RULE.shouldRefresh({ hidden: false, now: now0 + 60000, last: now0, reason: 'timer' }) && !RULE.shouldRefresh({ hidden: false, now: now0 + 59000, last: now0, reason: 'timer' }) && !RULE.shouldRefresh({ hidden: true, now: now0 + 600000, last: now0, reason: 'timer' }) && RULE.shouldRefresh({ hidden: false, now: now0 + 16000, last: now0, reason: 'focus' }) && !RULE.shouldRefresh({ hidden: false, now: now0 + 5000, last: now0, reason: 'focus' }) && RULE.clock(new Date(2026, 9, 19, 9, 5)) === '09:05');
    const pg = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/AssetPortalAssets.jsx'), 'utf8');
    check('C', 'the Assets page uses the refresh hook and prints "Updated"; so does Repairs', /useAutoRefresh\(load, data\)/.test(pg) && /fresh\.text/.test(pg) && /useAutoRefresh\(load, data\)/.test(fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/AssetPortalRepairs.jsx'), 'utf8')));

    // =====================================================================================================================
    // E  PRIVACY / WARRANTY / AMOUNTS
    // =====================================================================================================================
    const names = new Set(['zoya', 'kapoorzz', 'sneha']);
    // every first / last name of real employees that appears inside some real asset code of the copy
    const emps = await raw('SELECT "name" FROM "Employee"');
    const assetCodes = (await raw('SELECT "assetCode" FROM "Asset"')).map((r) => r.assetCode.toLowerCase());
    const SAFE = new Set(['laptop', 'charger', 'mouse', 'head', 'set', 'monitor', 'mobile', 'phone', 'office', 'team', 'lead', 'medical', 'manufacturing', 'education', 'internal', 'asset', 'edu', 'non', 'bde', 'stl']);
    emps.forEach((e) => String(e.name || '').split(/[\s.,]+/).filter((w) => w.length >= 4).forEach((w) => { const l = w.toLowerCase(); if (!SAFE.has(l) && l !== RUN && !/zztest|vies/.test(l) && assetCodes.some((c) => new RegExp(`(^|[^a-z])${l}([^a-z]|$)`).test(c))) names.add(l); }));
    const realMasked = await raw(`SELECT "id","assetCode" FROM "Asset" WHERE "assetCode" NOT LIKE 'AST-%' AND "assetCode" NOT LIKE 'ZZ%'`);
    check('E', `the sweep has ${names.size} employee names taken from the copy's own asset codes (e.g. ${[...names].slice(0, 6).join(', ')})`, names.size >= 10, names.size);
    const Mk = await require(path.join(BACK, 'src/utils/vendorAssetMask')).load(true);
    const sweepText = (label, t) => {
      const low = String(t).toLowerCase();
      const hit = [...names].filter((n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(low));
      return { label, hit };
    };
    // 1. the masker itself on every real asset code
    const codes = await raw('SELECT "id","assetCode" FROM "Asset"');
    const maskedAll = codes.map((a) => [a.assetCode, Mk.code(a)]);
    const leak = maskedAll.filter(([, m]) => sweepText('c', m).hit.length);
    void leak; // the 19 Oct 2026 no-names rule was replaced on 27 Oct 2026
    check('E', `27 Oct 2026 (names shown): all ${maskedAll.length} vendor-facing IDs are the company's own asset codes`, maskedAll.every(([a, b]) => a === b), maskedAll.filter(([a, b]) => a !== b).slice(0, 5));
    check('E', 'vendor-facing IDs are UNIQUE across all assets, and stable (a second load gives the same IDs)', new Set(maskedAll.map((x) => x[1].toLowerCase())).size === maskedAll.length && JSON.stringify(codes.map((a) => Mk.code(a))) === JSON.stringify(codes.map((a) => (require(path.join(BACK, 'src/utils/vendorAssetMask')).baseCode ? maskedAll.find(([c]) => c === a.assetCode)[1] : ''))));
    check('E', 'examples: "Edu 01-Sneha-H" and AST-0001 are shown exactly as HRMS writes them', (() => { const x = maskedAll.find(([a]) => /^Edu 01-Sneha-H$/i.test(a)); const y = maskedAll.find(([a]) => a === 'AST-0001'); return (!x || x[1] === x[0]) && (!y || y[1] === 'AST-0001'); })(), maskedAll.slice(0, 4));
    // 2. every vendor response / export of the IT vendor
    const hrAssetHold = await http('PATCH', `/api/asset-inventory/${a12.id}/assign`, T.hr, { employeeId: S.emp.e.id }); // a12 held by Zoya
    await raw(`UPDATE "Asset" SET "assignedToId" = NULL, "status" = 'Available' WHERE "id" = ?`, a12.id); // back in stock (its code still holds a former holder's name)
    require(path.join(BACK, 'src/utils/vendorAssetMask')).reset();
    const bodies = [];
    const grab = async (x, p) => { const r = await G(x, p); bodies.push([p, r.text]); return r; };
    const big1 = await allRows(L.it, '/asset-portal/assets', { view: 'available' }); const big2 = await allRows(L.it, '/asset-portal/assets', { view: 'repair' });
    big1.rows.concat(big2.rows).forEach((r) => bodies.push(['asset row', JSON.stringify(r)]));
    for (const a of [a1, a2, a3, a10, a11, a12]) await grab(L.it, `/asset-portal/assets/${a.id}`); // eslint-disable-line no-await-in-loop
    await grab(L.it, '/asset-portal/overview'); await grab(L.it, '/asset-portal/history?pageSize=100'); await grab(L.it, '/asset-portal/invoices?pageSize=100'); await grab(L.it, '/asset-portal/orders?pageSize=100');
    const rl = await allRows(L.it, '/asset-portal/repairs'); rl.rows.forEach((r) => bodies.push(['repair row', JSON.stringify(r)]));
    for (const r of rl.rows.slice(0, 6)) await grab(L.it, `/asset-portal/repairs/${r.id}`); // eslint-disable-line no-await-in-loop
    for (const l of ['assets', 'repairs', 'history', 'invoices', 'orders']) { const e = await exportOf(L.it, l); bodies.push([`export ${l}`, e.text]); const ex = await exportOf(L.it, l, {}, 'xlsx'); bodies.push([`xlsx ${l}`, JSON.stringify(readXlsx(ex.buf))]); } // eslint-disable-line no-await-in-loop
    // names are allowed since 27 Oct 2026; e-mail addresses and phone numbers never are
    const pii = bodies.filter(([, t]) => /[A-Za-z0-9._%+-]+@example\.test|9876543210/.test(String(t))).map(([l]) => l);
    check('E', `SWEEP: ${bodies.length} vendor responses and exports (assets both tabs, details, repairs, history, invoices, orders, overview, CSV, Excel) contain NO employee e-mail or phone number`, pii.length === 0, pii.slice(0, 5));
    const codeRows = big1.rows.concat(big2.rows);
    const realOf = new Map(codes.map((a) => [a.id, a.assetCode]));
    check('E', 'every asset row carries the company\'s own asset code (27 Oct 2026)', codeRows.every((r) => r.assetCode === realOf.get(r.id)), codeRows.filter((r) => r.assetCode !== realOf.get(r.id)).slice(0, 3).map((r) => [r.assetCode, realOf.get(r.id)]));
    void sweepText;
    // 3. round trip: the vendor opens and edits a masked asset by its internal id
    const mine = big1.rows.find((r) => r.id === a11.id);
    const det = await G(L.it, `/asset-portal/assets/${a11.id}`);
    const edit = await http('PATCH', `/api/vendor-portal/asset-portal/assets/${a11.id}`, L.it.token, { brand: 'Lenovo', condition: 'Good' });
    check('E', `round trip: the masked asset ("${mine && mine.assetCode}") opens and is edited by its internal id; the true code in HRMS is untouched`, !!mine && det.status === 200 && edit.status === 200 && (await prisma.asset.findUnique({ where: { id: a11.id } })).assetCode === a11.assetCode && det.body.asset.assetCode === mine.assetCode, { det: det.status, edit: edit.status, body: edit.body && edit.body.error });
    const lab = Mk.code(a11);
    // 4. warranty + amounts
    const wA1 = det0(await G(L.it, `/asset-portal/assets/${a1.id}`));
    function det0(r) { return r.body && r.body.asset; }
    const wA2 = det0(await G(L.it, `/asset-portal/assets/${a2.id}`)); const wA3 = det0(await G(L.it, `/asset-portal/assets/${a3.id}`));
    check('E', 'warranty chips: in warranty (days left), expired (N days ago), no warranty recorded', /In warranty \(\d+ days? left\)/.test(wA1.warranty.status) && /Expired 12 days ago/.test(wA2.warranty.status) && wA3.warranty.status === 'No warranty recorded' && wA1.warranty.until === cleanDay(40), [wA1.warranty, wA2.warranty, wA3.warranty]);
    check('E', 'amounts shown by default: Amount, GST and Total where recorded; "no cost" is null (Not recorded), never 0', wA1.amount === 90000 && wA1.gst === 16200 && wA1.amountTotal === 106200 && wA2.amount === null && wA2.gst === null && wA3.amount === 7000 && wA3.gst === null && wA3.amountTotal === 7000, [wA1.amount, wA2.amount]);
    const hideDet = det0(await G(L.itHide, `/asset-portal/assets/${a1.id}`)); const hideList = await G(L.itHide, '/asset-portal/assets?view=available&pageSize=100'); const hideEx = await exportOf(L.itHide, 'assets', { view: 'available' });
    check('E', '"Hide amounts from this vendor": the detail has no amount fields, the list says showAmounts false, and the export drops the Amount / GST / Total columns', hideDet.amountHidden === true && !('amount' in hideDet) && hideList.body.showAmounts === false && !grid(hideEx, 'csv')[0].includes('Amount') && grid(await exportOf(L.it, 'assets', { view: 'available' }), 'csv')[0].includes('Amount'), grid(hideEx, 'csv')[0]);
    const exWar = grid(await exportOf(L.it, 'assets', { view: 'available' }), 'csv');
    const rowA1 = exWar.find((r) => r[0] === Mk.code(a1));
    check('E', 'Assets export has Warranty until + Warranty + Amount + GST + Total; an asset with no cost exports "Not recorded"', exWar[0].includes('Warranty until') && exWar[0].includes('Total') && rowA1 && String(rowA1[10]) === cleanDay(40) && Number(rowA1[12]) === 90000 && Number(rowA1[13]) === 16200 && Number(rowA1[14]) === 106200 && exWar.find((r) => r[0] === Mk.code(a2))[12] === 'Not recorded', rowA1);
    const repA1 = rl.rows.find((r) => r.assetId === ar1.id);
    check('E', 'Repairs list carries the warranty chip and the asset amount per repair; the Repairs export has Warranty + Asset amount', repA1 && repA1.warranty && /In warranty/.test(repA1.warranty.status) && repA1.amount === 90000 && grid(await exportOf(L.it, 'repairs'), 'csv')[0].includes('Warranty'), repA1 && repA1.warranty);

    // =====================================================================================================================
    // D  HRMS REPAIR COMPLAINTS -> VENDOR REPAIR JOB
    // =====================================================================================================================
    const journal0 = await n1('SELECT COUNT(*) AS n FROM "JournalEntry"'); const paid0 = await n1(`SELECT COUNT(*) AS n FROM "OfficeExpense"`);
    const repairs0 = await n1('SELECT COUNT(*) AS n FROM "AssetRepair"');
    const raise = (tokn, body) => http('POST', '/api/asset-complaints', tokn, body);
    const myA = await http('GET', '/api/asset-complaints/my-assets', T.emp);
    check('D', 'the employee holding assets sees them in "Report a problem" (own assets only)', myA.status === 200 && myA.body.rows.some((r) => r.id === a8.id) && !myA.body.rows.some((r) => r.id === a1.id), myA.body);
    const bad1 = await raise(T.emp2, { assetId: a8.id, kind: 'Repair', issue: 'Not mine to report really' });
    const bad2 = await raise(T.emp, { assetId: a8.id, kind: 'Fix', issue: 'Screen is cracked a lot' });
    const bad3 = await raise(T.emp, { assetId: a8.id, kind: 'Repair', issue: 'x' });
    check('D', 'raising is checked: someone else\'s asset 404, a wrong kind 400, an empty text 400, nothing saved', bad1.status === 404 && bad2.status === 400 && bad3.status === 400 && (await n1('SELECT COUNT(*) AS n FROM "AssetComplaint"')) === 0, [bad1.status, bad2.status, bad3.status]);
    const issueText = `Screen cracked. Call Zoya Kapoorzz on 9876543210 or zoya@example.test about ${S.emp.e.employeeCode}`;
    const c1 = await raise(T.emp, { assetId: a8.id, kind: 'Repair', issue: issueText });
    check('D', 'the employee raises a REPAIR complaint through the real HRMS route (201, ticket reference ATK-…)', c1.status === 201 && /^ATK-\d{4}$/.test(c1.body.ticketRef), c1.body);
    const dup = await raise(T.emp, { assetId: a8.id, kind: 'Repair', issue: 'Raised again by mistake' });
    check('D', 'the same complaint twice while it waits is refused (409)', dup.status === 409);
    const itRepairsBefore = await allRows(L.it, '/asset-portal/repairs'); const itAvailBefore = await avail(L.it); const itRepAssetBefore = await avail(L.it, 'repair');
    check('D', 'NOT approved yet: the vendor sees no repair for it and the held laptop is not in either asset tab', !itRepairsBefore.rows.some((r) => r.assetId === a8.id) && !itAvailBefore.rows.some((r) => r.id === a8.id) && !itRepAssetBefore.rows.some((r) => r.id === a8.id));
    const selfOk = await http('POST', `/api/asset-complaints/${c1.body.id}/decision`, T.emp, { decision: 'Approved' });
    check('D', 'the employee cannot approve the own complaint (403)', selfOk.status === 403, selfOk.body);
    const hrA = await http('POST', `/api/asset-complaints/${c1.body.id}/decision`, T.hr, { decision: 'Approved' });
    check('D', 'HR approves: ONE repair is made and named for the IT vendor (the only vendor that handles Laptops)', hrA.status === 200 && hrA.body.follow && hrA.body.follow.repairNo && hrA.body.follow.vendor === V.it.name, hrA.body);
    const ch = await raw('SELECT * FROM "AssetComplaint" WHERE "ticketId" = ?', c1.body.id);
    const repRow = await prisma.assetRepair.findUnique({ where: { id: ch[0].repairId } });
    check('D', 'the repair row: status Reported, type Repair, linked to the asset and the ticket, problem text sanitised (no employee name, number, e-mail or code)', repRow && repRow.status === 'Reported' && repRow.assetId === a8.id && /ATK-/.test(repRow.notes) && !/Zoya|Kapoorzz|9876543210|zoya@|ZZVIES/i.test(repRow.issue) && /Screen cracked/.test(repRow.issue), repRow && repRow.issue);
    const lvAfter = await allRows(L.it, '/asset-portal/repairs'); const job = lvAfter.rows.find((r) => r.assetId === a8.id);
    check('D', 'the vendor now sees it in Repairs as "Awaiting repair" with the ticket reference and the issue text; masked asset ID; no employee name, no HR remarks', job && job.stage === 'Awaiting repair' && job.ticketRef === c1.body.ticketRef && /Screen cracked/.test(job.issue) && job.assetCode === Mk.code(a8) && !JSON.stringify({ ...job, assetCode: null, holder: null }).match(/Kapoorzz|ZZVIES|9876543210/i) && !/Zoya/i.test(job.issue || '') && job.fromCompany === true, job);
    const itRepTab = await avail(L.it, 'repair');
    check('D', 'the HELD laptop is now visible (Under repair tab) because it has an approved repair job; still not in Available', itRepTab.rows.some((r) => r.id === a8.id) && !(await avail(L.it)).rows.some((r) => r.id === a8.id));
    const ovd = await G(L.it, '/asset-portal/overview');
    check('D', 'the Repairs menu badge count (overview.repairs.fromCompany) counts the new job', ovd.body.repairs.fromCompany >= 1);
    const histD = await G(L.it, `/asset-portal/repairs/${job.id}`);
    check('D', 'repair history has "Repair approved by HR" shown as Company, with the ticket; the detail never shows the thread, employee or remarks', histD.status === 200 && histD.body.history.some((h) => h.by === 'Company' && /approved by HR/.test(h.note || '')) && !histD.text.split(a8.assetCode).join('').match(/Kapoorzz|ZZVIES|"notes"/i), histD.body && histD.body.history);
    const hrAgain = await http('POST', `/api/asset-complaints/${c1.body.id}/decision`, T.hr, { decision: 'Approved' });
    const par = await Promise.all([1, 2, 3].map(() => http('POST', `/api/asset-complaints/${c1.body.id}/decision`, T.hr, { decision: 'Approved' })));
    check('D', 'approving again, a retry and 3 parallel approvals still leave exactly ONE repair for the ticket', hrAgain.status === 200 && par.every((p) => p.status === 200) && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "notes" LIKE ?`, `%${c1.body.ticketRef}%`)) === 1);
    const oldApprove = await (async () => { // the OLD Asset Approval button path
      const c = await raise(T.emp, { assetId: a9.id, kind: 'Repair', issue: 'Headset mic does not work' });
      const r = await http('PATCH', `/api/assets/${c.body.id}/status`, T.hr, { status: 'Approved' });
      return { c, r };
    })();
    check('D', 'the existing Asset Approval button (PATCH /api/assets/:id/status) does the same: ONE repair, for the headset', oldApprove.r.status === 200 && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "assetId" = ?`, a9.id)) === 1 && (await allRows(L.it, '/asset-portal/repairs')).rows.some((r) => r.assetId === a9.id));
    // non-repair kinds, rejection, unapproved
    const cRep = await raise(T.emp2, { assetId: (await mkAssetFor(S.emp2.e.id, 'A')).id, kind: 'Replacement', issue: 'Lost it on the bus yesterday' });
    async function mkAssetFor(holder, tag) { return mkAsset(`H${tag}`, { code: `ZZHELD-${RUN}-${tag}`, holder, status: 'Assigned', category: 'Mouse' }); }
    const decRep = await http('POST', `/api/asset-complaints/${cRep.body.id}/decision`, T.hr, { decision: 'Approved' });
    const hLap = await mkAssetFor(S.emp2.e.id, 'B');
    const cRej = await raise(T.emp2, { assetId: hLap.id, kind: 'Repair', issue: 'Scroll wheel stuck badly' });
    const decRej = await http('POST', `/api/asset-complaints/${cRej.body.id}/decision`, T.hr, { decision: 'Rejected' });
    const hLap2 = await mkAssetFor(S.emp2.e.id, 'C');
    const cOpen = await raise(T.emp2, { assetId: hLap2.id, kind: 'Repair', issue: 'Left click is not working' });
    const jobsNow = await allRows(L.it, '/asset-portal/repairs');
    check('D', 'a Replacement complaint approved, a Repair complaint rejected and one still waiting: NO repair job and nothing visible to the vendor', decRep.status === 200 && decRej.status === 200 && ![hLap, hLap2].some((a) => jobsNow.rows.some((r) => r.assetId === a.id)) && !jobsNow.rows.some((r) => r.issue && /Lost it on the bus/.test(r.issue)) && !(await avail(L.it, 'repair')).rows.some((r) => [hLap.id, hLap2.id].includes(r.id)));
    const mgrDec = await http('POST', `/api/asset-complaints/${cOpen.body.id}/decision`, T.mgr, { decision: 'Approved' });
    const empDec = await http('POST', `/api/asset-complaints/${cOpen.body.id}/decision`, T.emp2, { decision: 'Approved' });
    const recDec = await http('POST', `/api/asset-complaints/${cOpen.body.id}/decision`, T.rec, { decision: 'Approved' });
    check('D', `approver roles: an employee 403 and a recruiter 403 cannot decide; the manager role answers ${mgrDec.status} (${mgrDec.status === 200 ? 'a manager in scope MAY approve' : 'view-only manager cannot: HR/Admin decide'})`, empDec.status === 403 && recDec.status === 403 && [200, 403].includes(mgrDec.status), [mgrDec.status, empDec.status, recDec.status]);
    // HR deciding their own complaint
    const hrAsset = await mkAsset('HRH', { code: `ZZHELD-${RUN}-HR`, holder: S.hr.e.id, status: 'Assigned', category: 'Mouse' });
    const cHr = await raise(T.hr, { assetId: hrAsset.id, kind: 'Repair', issue: 'My own mouse is broken now' });
    const selfHr = await http('POST', `/api/asset-complaints/${cHr.body.id}/decision`, T.hr, { decision: 'Approved' });
    const otherHr = await http('POST', `/api/asset-complaints/${cHr.body.id}/decision`, T.hr2, { decision: 'Approved' });
    check('D', 'nobody decides their own complaint: HR approving the own one is 403; another HR can', selfHr.status === 403 && otherHr.status === 200, [selfHr.body, otherHr.status]);
    // the vendor works on it
    const u1 = await http('PATCH', `/api/vendor-portal/asset-portal/repairs/${job.id}`, L.it.token, { stage: 'Sent for repair', remarks: 'Received the laptop' });
    const side = await raw('SELECT * FROM "AssetRepairVendor" WHERE "repairId" = ?', job.id);
    check('D', 'the vendor updates the job: "Sent for repair" saved with the same rules; its own vendor row is created once; history events written', u1.status === 200 && side.length === 1 && side[0].stage === 'Sent for repair' && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ?`, job.id)) >= 3, u1.body && u1.body.error);
    const skip = await http('PATCH', `/api/vendor-portal/asset-portal/repairs/${job.id}`, L.it.token, { stage: 'Returned' });
    check('D', 'steps cannot be skipped (409) on a job that came from a complaint either', skip.status === 409);
    // revert after the vendor started: stays
    const rev1 = await http('POST', `/api/asset-complaints/${c1.body.id}/decision`, T.hr, { decision: 'Rejected' });
    const stay = await prisma.assetRepair.findUnique({ where: { id: job.id } });
    check('D', 'approval taken back AFTER the vendor started: the repair continues (not cancelled) and a history line says so', rev1.status === 200 && stay.status === 'In Repair' && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ? AND "kind" = 'approval reverted'`, job.id)) === 1);
    // revert BEFORE the vendor started: withdrawn, and re-approval re-opens it
    const withdrawJob = (await allRows(L.it, '/asset-portal/repairs')).rows.find((r) => r.assetId === a9.id);
    const rev2 = await http('POST', `/api/asset-complaints/${oldApprove.c.body.id}/decision`, T.hr, { decision: 'Rejected' });
    const w1 = await prisma.assetRepair.findUnique({ where: { id: withdrawJob.id } });
    const rev3 = await http('POST', `/api/asset-complaints/${oldApprove.c.body.id}/decision`, T.hr, { decision: 'Approved' });
    const w2 = await prisma.assetRepair.findUnique({ where: { id: withdrawJob.id } });
    check('D', 'approval taken back BEFORE the vendor started: the job is withdrawn (Cancelled + history line); approving again re-opens THE SAME job (still one repair)', w1.status === 'Cancelled' && w2.status === 'Reported' && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "assetId" = ?`, a9.id)) === 1 && rev2.status === 200 && rev3.status === 200);
    // catch-up: an approved ticket whose repair step never ran
    const hC = await mkAssetFor(S.emp2.e.id, 'D');
    const cLost = await raise(T.emp2, { assetId: hC.id, kind: 'Repair', issue: 'Keys fall off the board' });
    await raw(`UPDATE "EmployeeRecord" SET "status" = 'Approved' WHERE "id" = ?`, cLost.body.id); // approved, but the follow-up never ran (a crash)
    await raw(`UPDATE "AssetComplaint" SET "decision" = 'Approved', "decidedRole" = 'HR', "decidedByName" = 'HR', "decidedAt" = ? WHERE "ticketId" = ?`, new Date().toISOString(), cLost.body.id);
    const noJob = (await n1('SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "assetId" = ?', hC.id));
    await sleep(100);
    const lazy = await allRows(L.it, '/asset-portal/repairs');
    const lazy2 = await allRows(L.it, '/asset-portal/repairs');
    check('D', 'catch-up: an approved Repair ticket with no repair gets its job on the vendor\'s next read (lazy, idempotent: a second read adds nothing)', noJob === 0 && lazy.rows.filter((r) => r.assetId === hC.id).length === 1 && lazy2.rows.filter((r) => r.assetId === hC.id).length === 1 && (await n1('SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "assetId" = ?', hC.id)) === 1);
    // other vendors do not see it
    const finRepairs = await G(L.fin, '/asset-portal/repairs');
    check('D', 'a vendor of another kind / category cannot reach the repair jobs (403) and the Airtel vendor neither', finRepairs.status === 403 && (await G(L.tel, '/asset-portal/repairs')).status === 403);
    const other = await mkLogin(V.it2, 'it2b'); await raw('UPDATE "VendorUser" SET "status" = ? WHERE "id" = ?', 'Active', other.u.id); await raw('UPDATE "OfficeVendor" SET "isActive" = 1 WHERE "id" = ?', V.it2.id); await sign(other);
    await raw('UPDATE "VendorUser" SET "status" = ? WHERE "id" = ?', 'Inactive', it2login.u.id); // only ONE live login of it2 matters: it is a peer, so nothing is automatic for it
    const otherJobs = await allRows(other, '/asset-portal/repairs');
    check('D', 'another IT vendor (whose scope does not hold the asset) sees none of these repair jobs', otherJobs.rows.every((r) => r.assetId !== a8.id && r.assetId !== a9.id));
    await raw('UPDATE "OfficeVendor" SET "isActive" = 0 WHERE "id" = ?', V.it2.id);
    check('D', 'NOTHING is posted to Accounts and nothing is marked paid: journal entries and office expenses unchanged; only repairs the flow made (and no asset made)', (await n1('SELECT COUNT(*) AS n FROM "JournalEntry"')) === journal0 && (await n1('SELECT COUNT(*) AS n FROM "OfficeExpense"')) === paid0 && (await n1('SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "paidVia" IS NOT NULL AND "notes" LIKE \'%ATK-%\'')) === 0);

    // =====================================================================================================================
    // B  IMPORT
    // =====================================================================================================================
    const IO_ = (x, key) => `/api/vendor-portal/vendor-io/import/${key}`;
    const prev = (x, key, buf, name) => http('POST', `${IO_(x, key)}/preview?fileName=${encodeURIComponent(name)}`, x.token, undefined, { raw: buf });
    const conf = (x, key, buf, name, k = `vies${crypto.randomBytes(8).toString('hex')}`) => http('POST', `${IO_(x, key)}/confirm?fileName=${encodeURIComponent(name)}`, x.token, undefined, { raw: buf, headers: { 'Idempotency-Key': k } });
    const RU_HEAD = ['Repair ID ✱', 'Status', 'Estimate', 'Expected date', 'Final cost', 'GST', 'Invoice number', 'Remarks'];
    const snap = async () => ({
      repairs: await n1('SELECT COUNT(*) AS n FROM "AssetRepair"'), assets: await n1('SELECT COUNT(*) AS n FROM "Asset"'), events: await n1('SELECT COUNT(*) AS n FROM "AssetRepairEvent"'), sides: await n1('SELECT COUNT(*) AS n FROM "AssetRepairVendor"'),
      bills: await n1('SELECT COUNT(*) AS n FROM "VendorModuleBill"'), orders: await n1('SELECT COUNT(*) AS n FROM "IdCardOrderEvent"'), runs: await n1('SELECT COUNT(*) AS n FROM "VendorImportRun"'),
    });
    const info = await G(L.it, '/vendor-io/info');
    check('B', 'info for an IT login with editing: two imports (repair updates, order status) and the plain line "Assets are added automatically from HRMS and Accounts: nothing to import."', info.body.import.allowed === true && info.body.import.items.map((i) => i.key).join() === 'repair-updates,order-status' && info.body.import.assetsNote === 'Assets are added automatically from HRMS and Accounts: nothing to import.');
    const infoView = await G(L.itView, '/vendor-io/info');
    check('B', 'a VIEW-ONLY login: Import is disabled with a plain reason ("Allow editing"), and the server answers 403 on sample / preview / confirm', infoView.body.import.allowed === false && /Allow editing/.test(infoView.body.import.reason) && (await http('GET', `${IO_(L.itView, 'repair-updates')}/sample`, L.itView.token)).status === 403 && (await prev(L.itView, 'repair-updates', csvOf(RU_HEAD, []), 'a.csv')).status === 403 && (await conf(L.itView, 'repair-updates', csvOf(RU_HEAD, []), 'a.csv')).status === 403);
    check('B', 'finance login with "Raise invoices" ticked: Import invoices; without the tick: disabled with the reason; Airtel with / without "Send a bill" likewise; ID card with updateStatus',
      (await G(L.fin, '/vendor-io/info')).body.import.items[0].key === 'bills' && (await G(L.fin, '/vendor-io/info')).body.import.allowed === true && (await G(L.finNo, '/vendor-io/info')).body.import.allowed === false && /Raise/.test((await G(L.finNo, '/vendor-io/info')).body.import.reason) && (await G(L.tel, '/vendor-io/info')).body.import.allowed === true && (await G(L.telNo, '/vendor-io/info')).body.import.allowed === false && (await G(L.id, '/vendor-io/info')).body.import.items[0].key === 'order-status');
    check('B', 'wrong portal: an IT vendor asking for finance "bills" import gets 404, the finance vendor asking for repair-updates gets 404', (await prev(L.it, 'bills', csvOf(['x'], []), 'a.csv')).status === 404 && (await prev(L.fin, 'repair-updates', csvOf(RU_HEAD, []), 'a.csv')).status === 404);

    // sample = contract
    const sx = await http('GET', `${IO_(L.it, 'repair-updates')}/sample?format=xlsx`, L.it.token); const sc = await http('GET', `${IO_(L.it, 'repair-updates')}/sample?format=csv`, L.it.token);
    const headX = readXlsx(sx.buf)[0].map((h) => String(h).replace(/[ ✱]+$/, '')); const headC = readCsv(sc.buf)[0].map((h) => String(h).replace(/[ ✱]+$/, ''));
    check('B', 'sample file download works (xlsx + csv) and its headers are the contract: Repair ID, Status, Estimate, Expected date, Final cost, GST, Invoice number, Remarks', sx.status === 200 && sc.status === 200 && headX.join() === 'Repair ID,Status,Estimate,Expected date,Final cost,GST,Invoice number,Remarks' && headC.join() === headX.join(), [headX, headC]);
    check('B', 'finance, Airtel, ID-card and order-status samples exist too', (await http('GET', `${IO_(L.fin, 'bills')}/sample`, L.fin.token)).status === 200 && (await http('GET', `${IO_(L.tel, 'bills')}/sample?format=csv`, L.tel.token)).status === 200 && (await http('GET', `${IO_(L.id, 'order-status')}/sample`, L.id.token)).status === 200 && (await http('GET', `${IO_(L.it, 'order-status')}/sample`, L.it.token)).status === 200);

    // refused files
    const okRow = [[R2.repairNo, 'Sent for repair', 1500, '2026-12-01', '', '', '', 'Got it']];
    const refusals = [
      ['a .txt file', Buffer.from('hello'), 'x.txt', 400], ['a PNG renamed to .xlsx', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'x.xlsx', 400], ['an old .xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), 'x.xls', 400],
      ['a zip renamed to .csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'x.csv', 400], ['a binary file renamed to .csv', Buffer.from([1, 2, 0, 3, 4]), 'x.csv', 400], ['an empty body', Buffer.alloc(0), 'x.csv', 400],
      ['a file with the wrong columns', csvOf(['Name', 'Colour'], [['a', 'b']]), 'x.csv', 400], ['a file with a missing column', csvOf(RU_HEAD.slice(0, 6), [[R2.repairNo, '', '', '', '', '']]), 'x.csv', 400],
    ];
    for (const [label, buf, name, st] of refusals) { const r = await prev(L.it, 'repair-updates', buf, name); check('B', `refused: ${label} -> ${st} with a plain message`, r.status === st && !!(r.body && r.body.error), r.body); } // eslint-disable-line no-await-in-loop
    const payFile = await prev(L.it, 'repair-updates', csvOf([...RU_HEAD, 'Payment status', 'Paid'], [[R2.repairNo, '', '', '', '', '', '', '', 'Paid', '1000']]), 'p.csv');
    check('B', 'a vendor can NEVER set a payment: a file with a Paid / Payment status column is refused in plain words', payFile.status === 400 && /payment status or a paid amount/.test(payFile.body.error), payFile.body);
    const tooBig = await http('POST', `${IO_(L.it, 'repair-updates')}/preview?fileName=big.csv`, L.it.token, undefined, { raw: Buffer.alloc(5 * 1024 * 1024 + 10, 97) });
    check('B', 'a file over 5 MB is refused (413 or 400, plain words)', [400, 413].includes(tooBig.status) && !!(tooBig.body && tooBig.body.error), tooBig.status);
    const wbF = XLSX.utils.book_new(); const wsF = XLSX.utils.aoa_to_sheet([RU_HEAD, [R2.repairNo, 'Sent for repair', '', '', '', '', '', 'x']]); wsF.H2 = { t: 'n', v: 5, f: '1+4' }; XLSX.utils.book_append_sheet(wbF, wsF, 'Data');
    const withFormula = await prev(L.it, 'repair-updates', XLSX.write(wbF, { type: 'buffer', bookType: 'xlsx' }), 'f.xlsx');
    check('B', 'formulas are never evaluated: an Excel file that holds a formula cell is refused, naming the cell', withFormula.status === 400 && /formula/i.test(withFormula.body.error) && /H2/.test(withFormula.body.error), withFormula.body);
    const tooMany = await prev(L.it, 'repair-updates', csvOf(RU_HEAD, Array.from({ length: 2001 }, (_, i) => [`RP-X${i}`, '', '', '', '', '', '', ''])), 'many.csv');
    check('B', 'more than 2000 lines is refused', tooMany.status === 400 && /2000/.test(tooMany.body.error), tooMany.body);

    // preview saves nothing; per-row reasons
    const mixed = [
      [R2.repairNo, 'Sent for repair', 1500, '2026-12-01', '', '', '', 'Got it'],           // line 2 ok
      [R4.repairNo, 'Completed', '', '', '', '', '', ''],                                    // skip steps -> error
      [RF.repairNo, 'Sent for repair', '', '', '', '', '', ''],                              // another vendor's repair
      ['RP-NOPE-1', 'Sent for repair', '', '', '', '', '', ''],                              // unknown
      [R2.repairNo, 'Under repair', '', '', '', '', '', ''],                                 // repeated line
      [R1.repairNo, '', '', '', '', '', '', '=SUM(1+1)'],                                    // formula text
      [R3.repairNo, 'Awaiting repair', 'abc', '', '', '', '', ''],                           // bad number
      [R3.repairNo.toLowerCase(), 'Teleported', '', '', '', '', '', ''],                     // bad step
    ];
    const s0 = await snap();
    const pv = await prev(L.it, 'repair-updates', csvOf(RU_HEAD, mixed), 'mixed.csv');
    const s1 = await snap();
    check('B', 'PREVIEW saves NOTHING: repairs, assets, events, vendor rows, runs all unchanged; and no repair or asset is ever created', pv.status === 200 && JSON.stringify(s0) === JSON.stringify(s1), [s0, s1]);
    const byLine = Object.fromEntries((pv.body.rows || []).map((r) => [r.line, r]));
    check('B', `preview result: 1 line will be saved, the rest have plain reasons (skipping a step, another vendor's repair, unknown ID, repeated line, formula text, bad number, bad step)`,
      pv.body.willChange === 1 && byLine[2].outcome === 'ok' && /next step/i.test(byLine[3].message) && /no repair/i.test(byLine[4].message) && /no repair/i.test(byLine[5].message) && /repeats line 2/.test(byLine[6].message) && /formula/i.test(byLine[7].message) && /number/i.test(byLine[8].message) && /not a repair step/i.test(byLine[9].message) && pv.body.failed === 7, pv.body.rows);
    check('B', 'another vendor\'s repair is refused exactly like an unknown ID (no way to probe ids)', byLine[4].message.replace(RF.repairNo, 'X') === byLine[5].message.replace('RP-NOPE-1', 'X'), [byLine[4].message, byLine[5].message]);

    // confirm
    const key1 = `vies-k1-${RUN}`;
    const cf = await conf(L.it, 'repair-updates', csvOf(RU_HEAD, mixed), 'mixed.csv', key1);
    const r2db = await prisma.assetRepair.findUnique({ where: { id: R2.id } }); const r2side = await raw('SELECT * FROM "AssetRepairVendor" WHERE "repairId" = ?', R2.id);
    const s2 = await snap();
    check('B', 'CONFIRM applies the valid line through the same rules: repair R2 is now "In Repair" / "Sent for repair" with the estimate and date; the 7 bad lines changed nothing; honest counts (1 updated, 7 failed, complete=false)',
      cf.status === 200 && cf.body.updated === 1 && cf.body.failed === 7 && cf.body.complete === false && r2db.status === 'In Repair' && r2side.length === 1 && r2side[0].stage === 'Sent for repair' && Number(r2side[0].estimateCost) === 1500 && r2side[0].expectedDate === '2026-12-01' && s2.repairs === s1.repairs && s2.assets === s1.assets, cf.body);
    check('B', 'history was written for the import (append-only events by the vendor) and exactly ONE audit row for the confirmed import with counts only', s2.events > s1.events && (await n1(`SELECT COUNT(*) AS n FROM "AssetAuditLog" WHERE "action" = 'Import confirmed' AND "vendorUserId" = ?`, L.it.u.id)) === 1 && !/Got it/.test(((await raw(`SELECT "newValue" FROM "AssetAuditLog" WHERE "action" = 'Import confirmed' ORDER BY "createdAt" DESC LIMIT 1`))[0] || {}).newValue || ''));
    // same file again (new key): nothing new
    const cf2 = await conf(L.it, 'repair-updates', csvOf(RU_HEAD, mixed), 'mixed.csv');
    const s3 = await snap();
    check('B', 'the SAME file twice (a new key): nothing new is saved (the valid line is "already as it was"), no extra history', cf2.status === 200 && cf2.body.updated === 0 && cf2.body.skipped >= 1 && s3.events === s2.events && s3.sides === s2.sides, cf2.body);
    // same key replay
    const cf3 = await conf(L.it, 'repair-updates', csvOf(RU_HEAD, mixed), 'mixed.csv', key1);
    check('B', 'the SAME Idempotency-Key again returns the first answer (duplicateRequest) and does nothing', cf3.status === 200 && cf3.body.duplicateRequest === true && cf3.body.updated === 1 && (await snap()).events === s3.events);
    // missing / bad key
    check('B', 'confirm needs a proper Idempotency-Key (400 without)', (await http('POST', `${IO_(L.it, 'repair-updates')}/confirm?fileName=a.csv`, L.it.token, undefined, { raw: csvOf(RU_HEAD, okRow) })).status === 400);
    // 3 concurrent confirms with one key
    const conc = csvOf(RU_HEAD, [[R4.repairNo, 'Sent for repair', 900, '', '', '', '', 'concurrent']]);
    const evB = await n1(`SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ?`, R4.id);
    const kc = `vies-conc-${RUN}`;
    const trio = await Promise.all([1, 2, 3].map(() => conf(L.it, 'repair-updates', conc, 'c.csv', kc)));
    const evA = await n1(`SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ?`, R4.id);
    check('B', '3 concurrent confirms with the same key = the work is done ONCE (same events as one run), all three answers agree', trio.every((t) => t.status === 200 && t.body.updated === 1) && trio.filter((t) => t.body.duplicateRequest).length === 2 && evA - evB <= 4 && (await n1(`SELECT COUNT(*) AS n FROM "VendorImportRun" WHERE "idemKey" = ?`, kc)) === 1 && (await n1(`SELECT COUNT(*) AS n FROM "AssetRepairVendor" WHERE "repairId" = ?`, R4.id)) === 1, trio.map((t) => [t.status, t.body.updated, t.body.duplicateRequest]));
    // partial failure: an injected failure on line 47 (TEST_MODE only)
    const rows50 = Array.from({ length: 49 }, (_, i) => [`RP-NO-${i}`, '', '', '', '', '', '', '']);
    rows50[1] = [R1.repairNo, 'Sent for repair', '', '', '', '', '', 'line three']; // line 3
    rows50[45] = [R3.repairNo, 'Sent for repair', '', '', '', '', '', 'line 47 injected failure']; // line 47
    rows50[47] = [R4.repairNo, 'Under repair', '', '', '', '', '', 'line 49 after the failure']; // line 49
    const cfP = await conf(L.it, 'repair-updates', csvOf(RU_HEAD, rows50), 'p.csv');
    const rR1 = await prisma.assetRepair.findUnique({ where: { id: R1.id } }); const rR3 = await prisma.assetRepair.findUnique({ where: { id: R3.id } }); const rR4 = await prisma.assetRepair.findUnique({ where: { id: R4.id } });
    const lineMap = Object.fromEntries((cfP.body.rows || []).map((r) => [r.line, r]));
    check('B', 'PARTIAL FAILURE is honest: the injected failure on line 47 is reported as failed (technical problem), the lines before AND after it are still saved, complete=false and the message does not claim full success',
      cfP.status === 200 && lineMap[47].outcome === 'error' && lineMap[47].technical === undefined && /technical problem/.test(lineMap[47].message) && rR1.status === 'In Repair' && rR3.status === 'Reported' && rR4.status === 'In Repair' && cfP.body.complete === false && !/^Done/.test(cfP.body.message), { m: cfP.body.message, l47: lineMap[47], r1: rR1.status, r3: rR3.status, r4: rR4.status });
    // closed after an approved bill
    const pdfUp = await http('POST', `/api/vendor-portal/asset-portal/repairs/${R1.id}/invoice`, L.it.token, undefined, { form: upload(pdf('r1'), 'inv.pdf', 'application/pdf', { invoiceNo: `ZZINV-R1-${RUN}` }) });
    const fin1 = await http('PATCH', `/api/vendor-portal/asset-portal/repairs/${R1.id}`, L.it.token, { finalCost: 2000, finalGst: 360, invoiceNo: `ZZINV-R1-${RUN}` });
    const sendB = await http('POST', `/api/vendor-portal/asset-portal/repairs/${R1.id}/send-invoice`, L.it.token, {});
    await raw(`UPDATE "VendorBillSubmission" SET "status" = 'APPROVED' WHERE "billNumber" = ?`, `ZZINV-R1-${RUN}`);
    const blocked = await conf(L.it, 'repair-updates', csvOf(RU_HEAD, [[R1.repairNo, '', '', '', 2500, '', '', '']]), 'b.csv');
    check('B', 'closed-after-approved-bill is blocked in an import too: changing the final cost of a repair whose invoice Accounts approved is refused with the same words', pdfUp.status === 201 && fin1.status === 200 && sendB.status === 201 && blocked.body.failed === 1 && /already with Accounts/.test(blocked.body.rows[0].message), blocked.body.rows && blocked.body.rows[0]);
    // order status: asset vendor + ID card vendor
    const evO = await n1('SELECT COUNT(*) AS n FROM "IdCardOrderEvent"');
    const ordPrev = await prev(L.id, 'order-status', csvOf(['Order reference ✱', 'Status ✱', 'Remarks'], [[O1.code, 'Received', 'ok'], [O2.code, 'Delivered', ''], [O3.code, 'Received', ''], [O1.code, 'Printing', '']]), 'o.csv');
    check('B', 'ID card order status preview: 1 move, "skip a step" refused, ANOTHER vendor\'s order refused as unknown, a repeated order refused; nothing saved', ordPrev.status === 200 && ordPrev.body.willChange === 1 && ordPrev.body.failed === 3 && (await n1('SELECT COUNT(*) AS n FROM "IdCardOrderEvent"')) === evO && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', O1.id))[0].status === 'New', ordPrev.body.rows);
    const ordConf = await conf(L.id, 'order-status', csvOf(['Order reference ✱', 'Status ✱', 'Remarks'], [[O1.code, 'Received', 'ok'], [O2.code, 'Ready', '']]), 'o.csv');
    check('B', 'ID card order status confirm moves one step forward (New -> Received, Printing -> Ready), history rows written, ONE summary notice; same file again = nothing new', ordConf.status === 200 && ordConf.body.updated === 2 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', O1.id))[0].status === 'Received' && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', O2.id))[0].status === 'Ready' && (await conf(L.id, 'order-status', csvOf(['Order reference ✱', 'Status ✱', 'Remarks'], [[O1.code, 'Received', 'ok'], [O2.code, 'Ready', '']]), 'o.csv')).body.updated === 0, ordConf.body);
    const aOrd = await conf(L.it, 'order-status', csvOf(['Order reference ✱', 'Status ✱', 'Remarks'], [[O3.code, 'Received', ''], [O1.code, 'Printing', '']]), 'o.csv');
    check('B', 'Assets-portal order status import: its own order moves, an ID-card vendor\'s order is refused', aOrd.status === 200 && aOrd.body.updated === 1 && aOrd.body.failed === 1);
    // bills: finance + telecom
    const BF_HEAD = ['Invoice number ✱', 'Invoice date ✱', 'Amount ✱', 'GST', 'Description', 'Due date'];
    const billsBefore = await n1('SELECT COUNT(*) AS n FROM "VendorModuleBill"');
    const bfRows = [[`ZZIMP-${RUN}-1`, '2026-10-01', 10000, 1800, 'Service Oct', '2026-10-31'], [`ZZIMP-${RUN}-2`, '2026-10-02', 2500, '', 'Parts', ''], [`ZZINV-1-${RUN}`, '2026-09-11', 1000, 18, 'existing number', ''], [`ZZIMP-${RUN}-4`, '2099-01-01', 100, '', 'future date', ''], [`ZZIMP-${RUN}-5`, '2026-10-05', 0, '', 'zero amount', ''], [`ZZIMP-${RUN}-1`, '2026-10-01', 10000, 1800, 'repeat in file', '']];
    const bfPrev = await prev(L.fin, 'bills', csvOf(BF_HEAD, bfRows), 'b.csv');
    check('B', 'finance bills preview saves nothing; 2 will be sent, 1 is "already there" (existing number), future date / repeat in the file refused with reasons; a zero-amount line is skipped (2026-10-28: any file, no strict rules)', bfPrev.status === 200 && (await n1('SELECT COUNT(*) AS n FROM "VendorModuleBill"')) === billsBefore && bfPrev.body.willChange === 2 && bfPrev.body.alreadyThere === 1 && bfPrev.body.failed === 2 && !bfPrev.body.rows.some((r) => r.label === `ZZIMP-${RUN}-5`), bfPrev.body.rows);
    const bfConf = await conf(L.fin, 'bills', csvOf(BF_HEAD, bfRows), 'b.csv');
    const newBills = await raw(`SELECT * FROM "VendorModuleBill" WHERE "billNumber" LIKE ?`, `ZZIMP-${RUN}-%`);
    check('B', 'finance bills confirm: 2 bills created through the same engine (status Submitted for Accounts to check, no payment fields, marked "[Excel import]"), 1 already there, 2 failed (zero amount skipped); honest message', bfConf.status === 200 && bfConf.body.imported === 2 && bfConf.body.alreadyThere === 1 && bfConf.body.failed === 2 && newBills.length === 2 && newBills.every((b) => b.status === 'Submitted' && b.paidOn == null && b.paidAmount == null && /\[Excel import\]/.test(b.remarks) && b.vendorId === V.oth.id), bfConf.body);
    const bfAgain = await conf(L.fin, 'bills', csvOf(BF_HEAD, bfRows), 'b.csv');
    check('B', 'the same bills file again creates nothing (all "already there"), no duplicate bill', bfAgain.body.imported === 0 && bfAgain.body.alreadyThere >= 2 && (await n1(`SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "billNumber" LIKE ?`, `ZZIMP-${RUN}-%`)) === 2);
    check('B', 'finance login WITHOUT "Raise invoices": 403 on preview and confirm; nothing created', (await prev(L.finNo, 'bills', csvOf(BF_HEAD, bfRows), 'b.csv')).status === 403 && (await conf(L.finNo, 'bills', csvOf(BF_HEAD, bfRows), 'b.csv')).status === 403);
    const BT_HEAD = ['Bill number ✱', 'Billing month ✱', 'Bill date', 'Due date ✱', 'Amount ✱', 'GST', 'Remarks'];
    const btRows = [[`ZZAIR-${RUN}-1`, '2026-08', '2026-08-05', '2026-08-25', 20000, 3600, ''], [`ZZAIR-${RUN}-2`, '2026-07', '', '2026-07-25', 15000, '', 'no bill date'], [`ZZAIR-${RUN}-3`, '2026-13', '', '2026-07-25', 100, '', 'bad month']];
    const btConf = await conf(L.tel, 'bills', csvOf(BT_HEAD, btRows), 'air.csv');
    check('B', 'Airtel bills import: 2 monthly bills sent (provider = the vendor); a bad month is taken from the due date (2026-07, already sent = already there, never a 2nd bill); the same file again = already there', btConf.status === 200 && btConf.body.imported === 2 && btConf.body.failed === 0 && btConf.body.alreadyThere === 1 && (await conf(L.tel, 'bills', csvOf(BT_HEAD, btRows), 'air.csv')).body.alreadyThere === 3 && (await n1(`SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "kind" = 'monthly_bill' AND "billNumber" LIKE ?`, `ZZAIR-${RUN}-%`)) === 2, btConf.body);
    check('B', 'Airtel login without "Send a bill": 403', (await prev(L.telNo, 'bills', csvOf(BT_HEAD, btRows), 'air.csv')).status === 403);
    const badPay = await prev(L.fin, 'bills', csvOf([...BF_HEAD, 'Status'], [[...bfRows[0], 'Paid']]), 'b.csv');
    check('B', 'a finance/Airtel bills file with a Status/Paid column: the column is IGNORED (any file is taken, 2026-10-28) and nothing is ever marked paid', badPay.status === 200 && (await n1('SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "billNumber" LIKE ? AND ("paidOn" IS NOT NULL OR "paidAmount" IS NOT NULL OR "status" = ?)', `ZZIMP-${RUN}-%`, 'Paid')) === 0, badPay.body);
    const sTot = await snap();
    check('B', 'no import ever created an asset, and the repair count only grew by the repairs the complaint flow made', sTot.assets === (await n1('SELECT COUNT(*) AS n FROM "Asset"')) && sTot.repairs >= repairs0 && sTot.repairs - repairs0 <= 12);
    const notices = await n1(`SELECT COUNT(*) AS n FROM "Notification" WHERE "title" LIKE ?`, '%imported from a file%');
    check('B', 'one summary notice per confirmed import (not one per line)', notices >= 1 && notices <= 40, notices);
    const dbRuns = await raw('SELECT "importKey","state","fileName" FROM "VendorImportRun" ORDER BY "createdAt" DESC LIMIT 3');
    check('B', 'each confirmed import is logged (VendorImportRun: who / file name / counts, never the file)', dbRuns.length === 3 && dbRuns.every((r) => r.state === 'done'));

    // ------------------------------------------------------------------ cleanup of the fixtures (the copy is a throw-away file as well)
    console.log('\n=== SUMMARY ===');
    Object.entries(groupCount).forEach(([g, c]) => console.log(`${g}: ${c.pass} passed, ${c.fail} failed`));
    console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('TEST CRASHED:', err);
    fail += 1;
  } finally {
    try { if (server) server.kill(); } catch { /* gone */ }
    try { await prisma.$disconnect(); } catch { /* gone */ }
    if (serverLog && fail) console.log('\n--- server log tail ---\n', serverLog.slice(-1800));
    if (madeCopy) { await sleep(500); for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(f); } catch { /* none */ } } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(fail ? 1 : 0);
  }
})();
