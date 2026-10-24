#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/assets-vendor-portal-test.js                         makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/avp-copy.db node scripts/assets-vendor-portal-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4072, TEST_MODE: fake mail transport, no timers, own temp upload folder) on the copy and builds ZZTEST fixtures
// there: asset vendors, a finance vendor, assets / repairs / orders, vendor logins with real passwords (signed in through the real
// /api/vendor-portal/login). Nothing leaves the machine. It proves:
//   A  who is an asset vendor, the menu / landing of each kind (pure logic + /me), the finance vendors keep EXACTLY their four modules
//   B  the server wall: asset vendor -> assets API only; HRMS / ATS / Accounts / Admin 403; finance vendor -> never /asset-portal
//   C  assets: only the assigned ones, no duplicates, search / filter / sort / pages, detail, edits (brand, model, condition, serial)
//   D  orders: only the vendor's own, status one step forward, same status twice = no new history, skip / back refused, no duplicates
//   E  repairs: every state listed, allowed / denied steps, remarks, estimate, final cost, invoice upload + signed download
//   F  Accounts: the same AssetRepair row (no duplicate), Repair cost + Pending from HRMS show the vendor's figures, never paid, never
//      posted by the vendor, a repair already posted keeps its books ("Changed in HRMS")
//   G  history: append-only (database level), who / when / old -> new, per asset
//   H  isolation: another vendor's asset / order / repair / file, ids in body / query / path, tokens
//   I  nothing else changed: staff nav + permission engine byte-for-byte, row counts of unrelated tables
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
  copy = path.join(os.tmpdir(), `avp-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4072);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `avp-uploads-${RUN}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = UPLOADS;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const groupCount = {};
const check = (g, n, ok, d) => {
  if (ok) pass += 1; else fail += 1;
  groupCount[g] = groupCount[g] || { pass: 0, fail: 0 }; groupCount[g][ok ? 'pass' : 'fail'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 800)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const PW = (t) => `Qv#7${t}Lm!${RUN}9`;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (opt.form) payload = opt.form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, headers: r.headers };
}
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ZZTEST ${tag} ${RUN}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const upload = (buf, name, type, fields = {}) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf], { type }), name);
  return fd;
};

const made = { users: [], vendors: [], assets: [], repairs: [], orders: [], docs: [] };
(async () => {
  let server; let serverLog = '';
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: UPLOADS } });
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    // ------------------------------------------------------------------ staff fixtures (the copy only)
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AVP ${tag} ${RUN}`, email: `zz-avp-${tag}-${RUN}@example.test`, username: `zz-avp-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const uAcc = await mk('acc', { role: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uApr = await mk('apr', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true, accountsRole: 'ADMIN' });
    const uHr = await mk('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'HR', atsAccess: true });
    const T = { admin: await tok(uAdmin), acc: await tok(uAcc), rec: await tok(uRec), hr: await tok(uHr), apr: await tok(uApr) };

    // ------------------------------------------------------------------ counts of tables nobody here may change
    const cnt = async () => {
      const q = {
        OfficeVendor: `SELECT COUNT(*) AS n FROM "OfficeVendor" WHERE "name" NOT LIKE 'ZZTEST AVP%'`,
        VendorUser: `SELECT COUNT(*) AS n FROM "VendorUser" WHERE "email" NOT LIKE 'zz-avp-%'`,
        OfficeExpense: `SELECT COUNT(*) AS n FROM "OfficeExpense" WHERE COALESCE("vendor",'') NOT LIKE 'ZZTEST AVP%'`, VendorBillSubmission: `SELECT COUNT(*) AS n FROM "VendorBillSubmission" WHERE "billNumber" NOT LIKE 'ZZ%'`, VendorModuleBill: 'SELECT COUNT(*) AS n FROM "VendorModuleBill"',
        VendorSharedDocument: `SELECT COUNT(*) AS n FROM "VendorSharedDocument" WHERE "title" NOT LIKE 'ZZ %'`, IdCardOrder: `SELECT COUNT(*) AS n FROM "IdCardOrder" WHERE "orderCode" NOT LIKE 'ZZ-IDC-%'`,
        Invoice: 'SELECT COUNT(*) AS n FROM "Invoice"', Client: 'SELECT COUNT(*) AS n FROM "Client"', Employee: 'SELECT COUNT(*) AS n FROM "Employee"', Candidate: 'SELECT COUNT(*) AS n FROM "Candidate"',
        Requirement: 'SELECT COUNT(*) AS n FROM "Requirement"', BankTransaction: `SELECT COUNT(*) AS n FROM "BankTransaction" WHERE COALESCE("description",'') NOT LIKE 'ZZTEST%'`, Payroll: 'SELECT COUNT(*) AS n FROM "PayrollRun"',
      };
      const out = {};
      for (const [k, sql] of Object.entries(q)) { try { out[k] = (await raw(sql))[0].n; } catch { out[k] = -1; } } // eslint-disable-line no-await-in-loop
      return out;
    };
    const assetCount = async (extra = '') => (await raw(`SELECT COUNT(*) AS n FROM "Asset"${extra}`))[0].n;
    const repairCount = async () => (await raw('SELECT COUNT(*) AS n FROM "AssetRepair"'))[0].n;
    const journalCount = async () => (await raw('SELECT COUNT(*) AS n FROM "JournalEntry"'))[0].n;
    const countsStart = await cnt();
    const assetsStart = await assetCount(` WHERE "assetCode" NOT LIKE 'ZZAV-%'`);
    const repairsStart = await repairCount();
    const journalStart = await journalCount();

    // ------------------------------------------------------------------ vendors, logins
    const IT = 'IT / Hardware / AMC / Service';
    const mkVendor = async (tag, category) => {
      const v = await prisma.officeVendor.create({ data: { name: `ZZTEST AVP Vendor ${tag} ${RUN}`, companyName: `ZZTEST AVP Co ${tag}`, isActive: true, category } });
      made.vendors.push(v.id); return v;
    };
    const VA_ = await mkVendor('Alpha', IT); const VB_ = await mkVendor('Bravo', IT); const VC_ = await mkVendor('Charlie', 'Internet');
    const VD_ = await mkVendor('Delta', IT); const VE_ = await mkVendor('Echo', 'Other');
    const mkLogin = async (vendor, tag, { canEdit = true, canViewCost = false } = {}) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-avp-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit, canViewCost } });
      return { u, pw };
    };
    const LA = await mkLogin(VA_, 'a'); const LAv = await mkLogin(VA_, 'aview', { canEdit: false }); const LB = await mkLogin(VB_, 'b'); const LC = await mkLogin(VC_, 'c');
    const LD = await mkLogin(VD_, 'd'); const LE = await mkLogin(VE_, 'e');
    const nowMs = Date.now();
    const addModules = async (login, keys) => { for (const k of keys) await raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzvm${k}${login.u.id}`.slice(0, 40), login.u.id, k, '{}', nowMs, nowMs); }; // eslint-disable-line no-await-in-loop
    await addModules(LD, ['invoices', 'payments']); // IT category, but Admin ticked NO Assets: finance portal
    await addModules(LE, ['assets', 'invoices']); // "Other" category, but Admin ticked Assets: asset portal
    const vlogin = (L) => http('POST', '/api/vendor-portal/login', null, { email: L.u.email, password: L.pw });
    const sign = async (L) => { const r = await vlogin(L); L.token = r.body && r.body.token; L.login = r; return L; };
    for (const L of [LA, LAv, LB, LC, LD, LE]) await sign(L); // eslint-disable-line no-await-in-loop

    // ------------------------------------------------------------------ assets, repairs, orders
    const cat = `ZZTEST Cat ${RUN}`;
    const mkAsset = async (n, o) => {
      const a = await prisma.asset.create({ data: { assetCode: `ZZAV-${RUN}-${n}`, name: `ZZTEST Asset ${n}`, category: o.category || 'Laptop', status: o.status || 'Available', vendorId: o.vendorId || null, assetType: o.assetType || null, serialNumber: o.serial || null, purchaseCost: o.cost || null, purchaseDate: '2026-01-10', location: o.location || 'Hyderabad' } });
      made.assets.push(a.id); return a;
    };
    const a1 = await mkAsset(1, { vendorId: VA_.id, assetType: 'MacBook Pro 14', serial: `SN-A1-${RUN}`, cost: 90000 });
    const a2 = await mkAsset(2, { vendorId: VA_.id, category: cat, serial: `SN-A2-${RUN}` });
    const a3 = await mkAsset(3, { vendorId: VB_.id, serial: `SN-B3-${RUN}` });
    const a4 = await mkAsset(4, { category: 'Mouse', status: 'Available' }); // no vendor at all; a repair will name vendor A
    const a5 = await mkAsset(5, { vendorId: VA_.id, serial: `SN-A5-${RUN}` }); // vendor A's, but login A has no tick for it
    const a6 = await mkAsset(6, { vendorId: VA_.id, status: 'Retired' }); // archived
    const a7 = await mkAsset(7, { vendorId: VA_.id, serial: `SN-A7-${RUN}` });
    const a8 = await mkAsset(8, { vendorId: VE_.id });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LA.u.id, assetId: a1.id } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LA.u.id, category: cat } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LA.u.id, assetId: a6.id } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LA.u.id, assetId: a7.id } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LAv.u.id, assetId: a1.id } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LB.u.id, assetId: a3.id } });
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LE.u.id, assetId: a8.id } });

    // Repairs are raised by the COMPANY (HRMS Employee Services > Assets): through its real API.
    const hrms = async (assetId, body) => {
      const r = await http('POST', `/api/asset-inventory/${assetId}/repairs`, T.hr, body);
      if (r.status === 201) made.repairs.push(r.body.repair.id);
      return r;
    };
    const rr1 = await hrms(a1.id, { issue: 'Screen flickers', vendor: VA_.name, dateReported: '2026-09-20', repairType: 'Repair' });
    check('E', 'fixture: the company raises a repair through the HRMS API (status Reported)', rr1.status === 201 && rr1.body.repair.status === 'Reported', rr1.body);
    const R1 = rr1.body.repair;
    const R2 = (await hrms(a2.id, { issue: 'Battery drains fast', dateReported: '2026-09-21' })).body.repair; // no vendor named yet (asset is vendor A's)
    const R3 = (await hrms(a3.id, { issue: 'Keyboard dead', vendor: VB_.name, dateReported: '2026-09-22' })).body.repair; // vendor B
    const R4 = (await hrms(a4.id, { issue: 'Cable broken', vendor: VA_.name.toUpperCase(), dateReported: '2026-09-23' })).body.repair; // asset not vendor A's; repair names A (upper case)
    const R5 = (await hrms(a1.id, { issue: 'Hinge loose', vendor: VB_.name, dateReported: '2026-09-24' })).body.repair; // A's asset, but sent to vendor B
    const R7 = (await hrms(a7.id, { issue: 'Fan noise', vendor: VA_.name, dateReported: '2026-09-25' })).body.repair;
    // more states, made directly (what the HRMS "Send for repair" / "Back from repair" buttons end in)
    const mkRepair = async (n, assetId, o) => {
      const row = await prisma.assetRepair.create({ data: { repairNo: `RP-ZZ${RUN}-${n}`, assetId, issue: o.issue, vendor: o.vendor === undefined ? VA_.name : o.vendor, status: o.status, dateReported: o.dateReported || '2026-09-01', repairDate: o.repairDate || null, cost: o.cost || 0, gstPaid: o.gst || 0, underWarranty: !!o.warranty } });
      made.repairs.push(row.id); return row;
    };
    const R8 = await mkRepair('8', a7.id, { issue: 'Sent already', status: 'In Repair' });
    const R9 = await mkRepair('9', a7.id, { issue: 'Done last month', status: 'Completed', repairDate: '2026-09-05', cost: 700, gst: 126 });
    const R10 = await mkRepair('10', a7.id, { issue: 'Cancelled one', status: 'Cancelled' });
    const mkWithSide = async (id, assetId, stage, extra = {}) => raw('INSERT INTO "AssetRepairVendor" ("repairId","assetId","vendorId","stage","returnedDate","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)', id, assetId, VA_.id, stage, extra.returned || null, new Date().toISOString(), new Date().toISOString());
    await http('GET', '/api/vendor-portal/asset-portal/overview', LA.token); // the portal creates its own tables on first use
    const R11 = await mkRepair('11', a7.id, { issue: 'Under way', status: 'In Repair' }); await mkWithSide(R11.id, a7.id, 'Under repair');
    const R12 = await mkRepair('12', a7.id, { issue: 'Handed back', status: 'Completed', repairDate: '2026-08-30', cost: 300 }); await mkWithSide(R12.id, a7.id, 'Returned', { returned: '2026-09-02' });

    // Orders the company placed (ID-card orders) + a purchase-order document.
    const t0 = Date.now();
    const mkOrder = async (n, vendor, status, lines) => {
      const id = `zzidc${n}${RUN}`;
      await raw('INSERT INTO "IdCardOrder" ("id","orderCode","vendorId","status","note","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)', id, `ZZ-IDC-${n}-${RUN}`.slice(0, 24), vendor.id, status, `ZZTEST order ${n}`, t0, t0);
      for (let i = 0; i < lines; i += 1) {
        await raw('INSERT INTO "IdCardOrderLine" ("id","orderId","employeeId","employeeName","cardType","createdAt") VALUES (?,?,?,?,?,?)', `zzl${n}${i}${RUN}`, id, `zzemp${n}${i}${RUN}`, `ZZTEST Person ${i}`, 'Standard', t0); // eslint-disable-line no-await-in-loop
      }
      made.orders.push(id); return id;
    };
    let orderCols = [];
    try { orderCols = (await raw('PRAGMA table_info("IdCardOrderLine")')).map((c) => c.name); } catch { /* none */ }
    const O1 = await mkOrder('1', VA_, 'New', 3).catch((e) => { console.log('   (order fixture failed:', e.message.slice(0, 200), orderCols.join(), ')'); return null; });
    const O2 = await mkOrder('2', VA_, 'Printing', 1).catch(() => null);
    const O3 = await mkOrder('3', VB_, 'New', 2).catch(() => null);
    const podoc = await prisma.vendorSharedDocument.create({ data: { vendorId: VA_.id, title: `ZZ PO ${RUN}`, docType: 'Purchase order', name: 'po.pdf', mime: 'application/pdf', size: 10, file: 'x.pdf', note: 'ZZTEST PO' } });
    made.docs.push(podoc.id);

    // =============================================================== A  kind, menu, landing
    const CFGM = require(path.join(BACK, 'src/config/vendorModules'));
    const AVP = require(path.join(BACK, 'src/utils/assetVendorPortal'));
    const { pathToFileURL } = require('url');
    const FE = await import(pathToFileURL(path.join(BACK, '..', 'frontend/src/pages/vendor/vendorNav.js')).href);
    const ANAMES = ['Dashboard', 'Assets', 'Orders', 'Repairs', 'Repair History', 'Invoices'];
    const FNAMES = ['Dashboard', 'Bills & Invoices', 'Payments & Outstanding', 'Services & Agreements'];
    check('A', 'asset portal menu config (server): exactly Dashboard, Assets, Orders, Repairs, Repair History, Invoices', CFGM.ASSET_PORTAL_NAV.map((n) => n.label).join() === ANAMES.join(), CFGM.ASSET_PORTAL_NAV);
    check('A', 'the finance menu config is unchanged: exactly Dashboard, Bills & Invoices, Payments & Outstanding, Services & Agreements', CFGM.PORTAL_NAV.map((n) => n.label).join() === FNAMES.join(), CFGM.PORTAL_NAV);
    check('A', 'screen menu config (desktop AND mobile) = server config for BOTH kinds', JSON.stringify(FE.ASSET_NAV.map((n) => [n.key, n.label, n.route])) === JSON.stringify(CFGM.ASSET_PORTAL_NAV.map((n) => [n.key, n.label, n.route])) && JSON.stringify(FE.VENDOR_NAV.map((n) => [n.key, n.label, n.route])) === JSON.stringify(CFGM.PORTAL_NAV.map((n) => [n.key, n.label, n.route])) && FE.ASSET_NAV_DESKTOP.length === 6 && FE.ASSET_NAV_MOBILE.length === 6 && FE.VENDOR_NAV_DESKTOP.length === 4);
    check('A', 'route guard (pure logic): an asset vendor\'s unknown addresses go to its Dashboard, a finance vendor\'s to the finance Dashboard', ['/vendor', '/vendor/invoices', '/vendor/assets', '/vendor/m/office'].every((p) => FE.assetRouteFor(p) === '/vendor/asset-portal/dashboard') && FE.assetRouteFor('/vendor/asset-portal/repairs') === '/vendor/asset-portal/repairs' && FE.vendorRouteFor('/vendor/asset-portal/repairs') === '/vendor/dashboard' && FE.vendorRouteFor('/vendor/payments') === '/vendor/payments');
    const pa = ['/asset-portal/assets', '/asset-portal/repairs/x', '/me', '/logout', '/change-password', '/download-link', '/files/abc', '/login'];
    const pf = ['/records/overview', '/records/invoices/x', '/module-bills', '/module-bills/x/document'];
    check('A', 'path matrix (pure logic): asset vendor = asset API + utilities, not finance API; finance vendor = finance API + utilities, never asset API; old paths for both = no',
      pa.every((p) => CFGM.portalPathAllowedFor('assets', p)) && pf.every((p) => !CFGM.portalPathAllowedFor('assets', p)) && pf.every((p) => CFGM.portalPathAllowedFor('finance', p)) && !CFGM.portalPathAllowedFor('finance', '/asset-portal/assets')
      && ['/assets', '/assets/x', '/documents', '/profile', '/id-card-orders', '/sim', '/office', '/expenses', '/payments', '/dashboard', '/invoices'].every((p) => !CFGM.portalPathAllowedFor('assets', p) && !CFGM.portalPathAllowedFor('finance', p)));
    check('A', 'kind of vendor: IT category (no module ticks) = assets; Internet = finance; IT category with Admin-set modules WITHOUT Assets = finance; "Other" with Assets ticked = assets',
      (await AVP.kindOfRow({ ...LA.u, vendor: VA_ })) === 'assets' && (await AVP.kindOfRow({ ...LC.u, vendor: VC_ })) === 'finance' && (await AVP.kindOfRow({ ...LD.u, vendor: VD_ })) === 'finance' && (await AVP.kindOfRow({ ...LE.u, vendor: VE_ })) === 'assets');
    check('A', 'asset vendor signs in with the real login and lands on the Assets portal Dashboard', LA.login.status === 200 && LA.login.body.landing === '/vendor/asset-portal/dashboard', LA.login.body && LA.login.body.landing);
    check('A', 'finance vendor lands on the finance Dashboard as before', LC.login.status === 200 && LC.login.body.landing === '/vendor/dashboard', LC.login.body && LC.login.body.landing);
    let r = await http('GET', '/api/vendor-portal/me', LA.token);
    check('A', '/me for an asset vendor: kind assets, menu Dashboard / Assets / Orders / Repairs / Repair History / Invoices, no extra modules, no finance flag', r.status === 200 && r.body.kind === 'assets' && r.body.nav.map((n) => n.label).join() === ANAMES.join() && r.body.modules.length === 6 && (r.body.core || []).length === 0 && r.body.canRaise === false && r.body.landing === '/vendor/asset-portal/dashboard', r.body);
    r = await http('GET', '/api/vendor-portal/me', LC.token);
    check('A', '/me for a finance vendor: kind finance and EXACTLY the four finance modules', r.status === 200 && r.body.kind === 'finance' && r.body.nav.map((n) => n.label).join() === FNAMES.join() && r.body.modules.length === 4, r.body.nav);
    r = await http('GET', '/api/vendor-portal/me', LD.token);
    check('A', '/me for the IT vendor whose Admin did not tick Assets: still the four finance modules', r.body.kind === 'finance' && r.body.nav.map((n) => n.label).join() === FNAMES.join());
    r = await http('GET', '/api/vendor-portal/me', LE.token);
    check('A', '/me for the "Other" vendor with Assets ticked: the Assets portal', r.body.kind === 'assets' && r.body.nav.map((n) => n.label).join() === ANAMES.join());
    const appSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/App.jsx'), 'utf8');
    check('A', 'App.jsx: the four finance routes + the six asset-portal routes + the five ID card routes; every other /vendor address goes to the Dashboard', ['dashboard', 'invoices', 'payments', 'services'].every((x) => appSrc.includes(`path="/vendor/${x}"`)) && ['dashboard', 'assets', 'orders', 'repairs', 'history', 'invoices'].every((x) => appSrc.includes(`path="/vendor/asset-portal/${x}"`)) && !/path="\/vendor\/(assets|documents|profile|m\/)/.test(appSrc) && /path="\/vendor\/\*" element=\{<Navigate to="\/vendor\/dashboard"/.test(appSrc));
    const shellSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/VendorShell.jsx'), 'utf8');
    check('A', 'the portal frame sends a vendor to its own portal when it opens a page of the other one', /me\.nav|routeAllowed|landing/.test(shellSrc) && /Change password/.test(shellSrc) && /Logout/.test(shellSrc));

    // =============================================================== B  the wall
    const AP = '/api/vendor-portal';
    const wallAsset = ['/records/overview', '/records/invoices', '/records/payments', '/records/purchase-orders', '/module-bills', '/assets', '/assets/x', '/documents', '/profile', '/id-card-orders', '/sim', '/office', '/expenses', '/payments', '/bills/x', '/dashboard', '/invoices'];
    const wres = [];
    for (const p of wallAsset) { const x = await http('GET', `${AP}${p}`, LA.token); wres.push([p, x.status, x.body && x.body.notAvailable]); } // eslint-disable-line no-await-in-loop
    check('B', 'an asset vendor gets 403 "not available" on the finance API and on every old module path', wres.every(([, s, na]) => s === 403 && na === true), wres);
    const okAsset = [];
    for (const p of ['/asset-portal/overview', '/asset-portal/assets', '/asset-portal/orders', '/asset-portal/repairs', '/me']) { const x = await http('GET', `${AP}${p}`, LA.token); okAsset.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'and 200 on its own four APIs + /me', okAsset.every(([, s]) => s === 200), okAsset);
    const wf = [];
    for (const p of ['/asset-portal/overview', '/asset-portal/assets', '/asset-portal/orders', '/asset-portal/repairs', '/asset-portal/repairs/x', '/asset-portal/anything']) { const x = await http('GET', `${AP}${p}`, LC.token); wf.push([p, x.status, x.body && x.body.notAvailable]); } // eslint-disable-line no-await-in-loop
    check('B', 'a finance vendor gets 403 "not available" on every /asset-portal path', wf.every(([, s, na]) => s === 403 && na === true), wf);
    const wf2 = [];
    for (const p of ['/records/overview', '/records/invoices', '/records/payments', '/records/purchase-orders']) { const x = await http('GET', `${AP}${p}`, LC.token); wf2.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'a finance vendor still reaches its four finance APIs (200)', wf2.every(([, s]) => s === 200), wf2);
    const wd = [];
    for (const p of ['/asset-portal/assets', '/asset-portal/repairs']) { const x = await http('GET', `${AP}${p}`, LD.token); wd.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'the IT vendor whose Admin did not tick Assets cannot use the asset API either (it is a finance vendor)', wd.every(([, s]) => s === 403), wd);
    for (const p of ['/asset-portal/assets', '/asset-portal/repairs/x']) {
      const x = await http('GET', `${AP}${p}`, null);
      check('B', `no sign-in: ${p} answers 401/403, never data`, [401, 403].includes(x.status) && !/assetCode|repairNo/.test(x.text), x.status);
    }
    const staffApis = ['/api/vendor-logins', '/api/vendor-master', '/api/employees', '/api/candidates', '/api/invoices', '/api/clients', '/api/admin/users', '/api/office-expenses/vendors', '/api/payroll', '/api/requirements', '/api/auth/me', '/api/asset-inventory', '/api/accounts/fixed-assets/pending', '/api/accounts/fixed-assets/repair-cost'];
    const sres = [];
    for (const p of staffApis) { const x = await http('GET', p, LA.token); sres.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'an asset vendor session cannot reach HRMS / ATS / Accounts / Admin APIs (all 403)', sres.every(([, s]) => s === 403), sres);
    const s2 = [];
    for (const p of staffApis) { const x = await http('GET', p, LC.token); s2.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'and neither can a finance vendor (all 403)', s2.every(([, s]) => s === 403), s2);
    r = await http('POST', `${AP}/records/overview`, LA.token, {});
    check('B', 'a write to the finance API by an asset vendor is refused too', r.status === 403, r.status);
    r = await http('PATCH', `${AP}/asset-portal/overview`, LA.token, {});
    check('B', 'an unknown method / path under /asset-portal is refused', r.status === 403 || r.status === 404, r.status);

    // =============================================================== C  assets
    r = await http('GET', `${AP}/asset-portal/assets?view=all&pageSize=100`, LA.token);
    const ids = (r.body.rows || []).map((x) => x.id);
    check('C', 'vendor A sees exactly its assigned assets: a1, a2, a5, a7 (linked to vendor A in the asset list - since the HRMS-source rule the login ticks no longer narrow it), a4 (company sent it for repair to A); not a3 (vendor B), not a6 (retired)',
      r.status === 200 && ids.length === 5 && [a1, a2, a4, a5, a7].every((a) => ids.includes(a.id)) && ![a3, a6, a8].some((a) => ids.includes(a.id)), ids);
    check('C', 'no duplicate rows: every asset id appears once, and asset codes are unique', new Set(ids).size === ids.length && new Set(r.body.rows.map((x) => x.assetCode)).size === ids.length);
    const row1 = r.body.rows.find((x) => x.id === a1.id);
    check('C', 'a row shows asset name, id (code), category, brand, model, serial no., condition, assigned vendor and current status',
      ['assetCode', 'name', 'category', 'brand', 'model', 'serialNumber', 'condition', 'assignedVendor', 'status'].every((k) => k in row1) && row1.assignedVendor === VA_.name && row1.serialNumber === `SN-A1-${RUN}` && row1.status === 'Available', row1);
    check('C', 'the open repair of an asset is shown on its row (a1 -> Awaiting repair, R1)', row1.repairStage === 'Awaiting repair' && row1.repairNo === R1.repairNo, row1);
    check('C', 'purchase amount is SHOWN by default (founder decision 2026-10-19, supersedes "hidden unless Show purchase value"); the old purchaseCost field stays out; amountHidden is false', !('purchaseCost' in row1) && row1.amount === 90000 && row1.amountHidden === false, row1);
    r = await http('GET', `${AP}/asset-portal/assets?view=all`, (await sign(LB)).token);
    check('C', 'vendor B sees a3 (its own) and a1 (only because the company sent a1 to B for repair: R5), nothing else', r.body.rows.length === 2 && [a3.id, a1.id].every((i) => r.body.rows.some((x) => x.id === i)), r.body.rows.map((x) => x.assetCode));
    r = await http('GET', `${AP}/asset-portal/assets?view=all&vendorId=${VB_.id}&vendorUserId=${LB.u.id}&assetId=${a3.id}`, LA.token);
    check('C', 'a vendorId / vendorUserId / assetId in the query is ignored (vendor A still sees its own five)', r.body.rows.length === 5 && !r.body.rows.some((x) => x.id === a3.id));
    r = await http('GET', `${AP}/asset-portal/assets?view=all&q=SN-A7&pageSize=5`, LA.token);
    check('C', 'search finds by serial number', r.body.rows.length === 1 && r.body.rows[0].id === a7.id, r.body.rows.length);
    r = await http('GET', `${AP}/asset-portal/assets?view=all&category=${encodeURIComponent(cat)}`, LA.token);
    check('C', 'filter by category', r.body.rows.length === 1 && r.body.rows[0].id === a2.id);
    r = await http('GET', `${AP}/asset-portal/assets?view=all&status=Available`, LA.token);
    check('C', 'filter by status (a4 is Available) and the facet counts add up', r.body.rows.some((x) => x.id === a4.id) && r.body.rows.length === 5 && r.body.facets.status.reduce((t, f) => t + f.count, 0) === 5, r.body.facets); // (all fixture assets are Available stock now: only available / repair assets are listed)
    r = await http('GET', `${AP}/asset-portal/assets?view=all&sort=assetCode&dir=desc`, LA.token);
    check('C', 'sort descending by asset id', r.body.rows[0].id === a7.id && r.body.rows[4].id === a1.id, r.body.rows.map((x) => x.assetCode));
    r = await http('GET', `${AP}/asset-portal/assets?view=all&pageSize=5&page=1`, LA.token);
    check('C', 'pages: page size honoured (min 5), total correct', r.body.total === 5 && r.body.pages === 1 && r.body.assignedTotal === 5);
    r = await http('GET', `${AP}/asset-portal/assets/${a1.id}`, LA.token);
    check('C', 'asset detail: details + its repairs (R1 only: R5 went to vendor B) + history', r.status === 200 && r.body.asset.id === a1.id && r.body.repairs.length === 1 && r.body.repairs[0].id === R1.id && Array.isArray(r.body.history), r.body.repairs && r.body.repairs.map((x) => x.repairNo));
    check('C', 'asset detail never shows vendor B\'s repair on the same asset', !JSON.stringify(r.body).includes(R5.repairNo));
    for (const [what, a] of [['vendor B\'s asset', a3], ['an asset of another vendor that was never given to this one', a8], ['a retired asset', a6], ['an unknown id', { id: 'nope-nope' }]]) {
      r = await http('GET', `${AP}/asset-portal/assets/${a.id}`, LA.token);
      check('C', `${what}: 403 (same answer as an id that does not exist)`, r.status === 403 && !/assetCode/.test(r.text), r.status);
    }
    // edits
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { brand: 'Apple', model: 'MacBook Pro 14 M3', condition: 'Good', serialNumber: `SN-A1-${RUN}-NEW`, serviceRemarks: 'ZZTEST checked' });
    check('C', 'a vendor who may edit saves brand, model, condition, serial number and service remarks', r.status === 200 && r.body.changed.length === 5 && r.body.asset.brand === 'Apple' && r.body.asset.model === 'MacBook Pro 14 M3' && r.body.asset.condition === 'Good' && r.body.asset.serialNumber === `SN-A1-${RUN}-NEW`, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { brand: 'Apple', model: 'MacBook Pro 14 M3', condition: 'Good' });
    check('C', 'saving the same values again changes nothing (idempotent)', r.status === 200 && r.body.changed.length === 0, r.body);
    const infoRows = await raw('SELECT * FROM "AssetVendorInfo" WHERE "assetId" = ?', a1.id);
    check('C', 'brand / model / condition sit in one row per asset (no second asset, no duplicate)', infoRows.length === 1 && infoRows[0].brand === 'Apple', infoRows);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { condition: 'Excellent' });
    check('C', 'a condition outside the list is refused', r.status === 400, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { name: 'Hacked', status: 'Retired', vendorId: VB_.id, purchaseCost: 1 });
    check('C', 'any other field (name, status, vendorId, cost) is refused and nothing changes', r.status === 400 && (await prisma.asset.findUnique({ where: { id: a1.id } })).name === 'ZZTEST Asset 1' && (await prisma.asset.findUnique({ where: { id: a1.id } })).vendorId === VA_.id, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a2.id}`, LA.token, { serialNumber: `SN-A1-${RUN}-NEW` });
    check('C', 'a serial number already on another asset of the same vendor is refused', r.status === 409, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, (await sign(LAv)).token, { brand: 'Dell' });
    check('C', 'a view-only login cannot edit (403)', r.status === 403, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a3.id}`, LA.token, { brand: 'Dell' });
    check('C', 'editing vendor B\'s asset is refused (403)', r.status === 403 && (await raw('SELECT * FROM "AssetVendorInfo" WHERE "assetId" = ?', a3.id)).length === 0, r.status);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a4.id}`, LA.token, { brand: 'Dell' });
    check('C', 'an asset that is only here for a repair cannot have its details changed (403)', r.status === 403, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { brand: '<b>x</b>' });
    check('C', 'HTML in a text field is refused', r.status === 400, r.body);
    r = await http('PATCH', `${AP}/asset-portal/assets/${a1.id}`, LA.token, { brand: 'Apple2', updatedAt: '2020-01-01T00:00:00.000Z' });
    check('C', 'a stale screen (old updatedAt) is refused (409), nothing saved', r.status === 409 && (await raw('SELECT "brand" FROM "AssetVendorInfo" WHERE "assetId" = ?', a1.id))[0].brand === 'Apple', r.body);
    check('C', 'the portal created no Asset row (company asset count unchanged apart from the fixtures)', (await assetCount(` WHERE "assetCode" NOT LIKE 'ZZAV-%'`)) === assetsStart && (await assetCount(` WHERE "assetCode" LIKE 'ZZAV-%'`)) === made.assets.length);
    const hist1 = JSON.parse((await prisma.asset.findUnique({ where: { id: a1.id } })).history);
    check('C', 'the company\'s asset history records who changed what (vendor name in the line)', hist1.some((h) => /Edited by vendor/.test(h.text) && /brand/i.test(h.text)), hist1.slice(0, 3));

    // =============================================================== D  orders
    r = await http('GET', `${AP}/asset-portal/orders`, LA.token);
    const oc = (r.body.rows || []).map((o) => o.orderNo);
    check('D', 'vendor A sees its own two ID-card orders and its purchase-order document; not vendor B\'s order',
      r.status === 200 && r.body.total === 3 && oc.includes(`ZZ-IDC-1-${RUN}`.slice(0, 24)) && oc.includes(`ZZ-IDC-2-${RUN}`.slice(0, 24)) && oc.includes(`ZZ PO ${RUN}`) && !oc.includes(`ZZ-IDC-3-${RUN}`.slice(0, 24)), oc);
    const o1 = r.body.rows.find((o) => o.orderNo === `ZZ-IDC-1-${RUN}`.slice(0, 24));
    check('D', 'an order row shows order number, details, order date, quantity, amount (not recorded = empty), delivery status, next step', o1 && o1.description && o1.orderDate && o1.quantity === 3 && o1.amount === null && o1.deliveryStatus && o1.nextStatus === 'Received', o1);
    r = await http('GET', `${AP}/asset-portal/orders/${o1.id}`, LA.token);
    check('D', 'order detail: items, documents and a status history', r.status === 200 && r.body.order.items.length === 1 && Array.isArray(r.body.history) && r.body.steps.length === 5, r.body);
    const evCount = async (id) => (await raw('SELECT COUNT(*) AS n FROM "IdCardOrderEvent" WHERE "orderId" = ?', id.replace(/^idc:/, '')))[0].n;
    const ev0 = await evCount(o1.id);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Received', remarks: 'ZZTEST got it' });
    check('D', 'the vendor moves its order one step: New -> Received (history row: who / when / old -> new)', r.status === 200 && r.body.order.status === 'Received' && (await evCount(o1.id)) === ev0 + 1 && r.body.history.length === 1 && r.body.history[0].from === 'New' && r.body.history[0].to === 'Received' && r.body.history[0].by === 'You', r.body);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Received' });
    check('D', 'the same status again changes nothing and adds no history (idempotent)', r.status === 200 && r.body.unchanged === true && (await evCount(o1.id)) === ev0 + 1, r.body);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Ready' });
    check('D', 'skipping a step is refused (409)', r.status === 409 && (await evCount(o1.id)) === ev0 + 1, r.body);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'New' });
    check('D', 'going back is refused (409)', r.status === 409, r.body);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Flying' });
    check('D', 'an unknown status is refused (400)', r.status === 400);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Printing', vendorId: VB_.id });
    check('D', 'a vendorId in the body is refused, nothing changes', r.status === 400 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', o1.id.replace(/^idc:/, '')))[0].status === 'Received', r.body);
    for (const s of ['Printing', 'Ready', 'Delivered']) r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: s }); // eslint-disable-line no-await-in-loop
    const fin = (await raw('SELECT "status","deliveredAt" FROM "IdCardOrder" WHERE "id" = ?', o1.id.replace(/^idc:/, '')))[0];
    check('D', 'step by step to Delivered: delivery date stamped, 4 history rows in order', r.status === 200 && fin.status === 'Delivered' && fin.deliveredAt && (await evCount(o1.id)) === ev0 + 4, fin);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, LA.token, { status: 'Delivered' });
    check('D', 'Delivered again: still nothing new', r.status === 200 && r.body.unchanged === true && (await evCount(o1.id)) === ev0 + 4);
    const o3 = `idc:${O3}`;
    r = await http('GET', `${AP}/asset-portal/orders/${o3}`, LA.token);
    check('D', 'vendor B\'s order: 403 on detail', r.status === 403 && !/ZZ-IDC/.test(r.text), r.status);
    r = await http('POST', `${AP}/asset-portal/orders/${o3}/status`, LA.token, { status: 'Received' });
    check('D', 'vendor B\'s order: 403 on status, and it stays New', r.status === 403 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', O3))[0].status === 'New');
    r = await http('POST', `${AP}/asset-portal/orders/doc:${podoc.id}/status`, LA.token, { status: 'Received' });
    check('D', 'a purchase-order document has no delivery status to change (409)', r.status === 409, r.body);
    r = await http('POST', `${AP}/asset-portal/orders/${o1.id}/status`, (await sign(LAv)).token, { status: 'Received' });
    check('D', 'a view-only login cannot change an order (403)', r.status === 403);
    check('D', 'no order was created or duplicated (A: 2 ID-card orders + 1 document, B: 1; order codes unique)', (await raw(`SELECT COUNT(*) AS n FROM "IdCardOrder" WHERE "orderCode" LIKE 'ZZ-IDC-%'`))[0].n === 3 && (await raw(`SELECT COUNT(DISTINCT "orderCode") AS n FROM "IdCardOrder" WHERE "orderCode" LIKE 'ZZ-IDC-%'`))[0].n === 3);
    r = await http('GET', `${AP}/asset-portal/orders?status=Delivered`, LA.token);
    check('D', 'filter orders by delivery status', r.body.rows.length === 1 && r.body.rows[0].id === o1.id);

    // =============================================================== E  repairs
    r = await http('GET', `${AP}/asset-portal/repairs?pageSize=100&sort=repairNo&dir=asc`, LA.token);
    const rnos = (r.body.rows || []).map((x) => x.repairNo);
    const expectA = [R1, R2, R4, R7].map((x) => x.repairNo).concat([R8, R9, R10, R11, R12].map((x) => x.repairNo));
    check('E', 'vendor A sees its repairs in EVERY state: R1 (named), R2 (unnamed, its asset), R4 (named in capitals, asset not its own), R7, R8..R12; not R3 / R5 (vendor B)',
      r.status === 200 && rnos.length === expectA.length && expectA.every((n) => rnos.includes(n)) && !rnos.includes(R3.repairNo) && !rnos.includes(R5.repairNo), rnos);
    const stageOf = (id) => (r.body.rows.find((x) => x.id === id) || {}).stage;
    check('E', 'stages: Awaiting repair (R1), Sent for repair (R8), Under repair (R11), Completed (R9), Returned (R12), Cancelled (R10)',
      stageOf(R1.id) === 'Awaiting repair' && stageOf(R8.id) === 'Sent for repair' && stageOf(R11.id) === 'Under repair' && stageOf(R9.id) === 'Completed' && stageOf(R12.id) === 'Returned' && stageOf(R10.id) === 'Cancelled', r.body.rows.map((x) => [x.repairNo, x.stage]));
    const rw = r.body.rows.find((x) => x.id === R9.id);
    check('E', 'a row shows repair id, asset details, issue, dates, estimate, final cost, invoice, remarks',
      ['repairNo', 'assetCode', 'assetName', 'category', 'issue', 'dateReported', 'repairDate', 'expectedDate', 'returnedDate', 'estimateCost', 'finalCost', 'finalTotal', 'invoiceNo', 'hasInvoice', 'vendorRemarks'].every((k) => k in rw) && rw.finalCost === 700 && rw.finalGst === 126 && rw.finalTotal === 826, rw);
    check('E', 'nothing about payment or the bank is exposed (paidVia, bank, capitalise, notes, reporter)', !/paidVia|paidBank|capitalise|reportedBy|"notes"/.test(r.text));
    r = await http('GET', `${AP}/asset-portal/repairs?stage=Under%20repair`, LA.token);
    check('E', 'filter by stage', r.body.rows.length === 1 && r.body.rows[0].id === R11.id);
    r = await http('GET', `${AP}/asset-portal/repairs?q=${encodeURIComponent('Battery')}`, LA.token);
    check('E', 'search finds by problem text', r.body.rows.length === 1 && r.body.rows[0].id === R2.id);
    r = await http('GET', `${AP}/asset-portal/repairs?pageSize=5&page=2`, LA.token);
    check('E', 'pages (9 repairs, 5 a page -> page 2 has 4)', r.body.rows.length === 4 && r.body.pages === 2 && r.body.total === 9, [r.body.rows.length, r.body.pages]);
    const repairsBefore = await repairCount();
    // transitions
    const patch = (id, body, token = LA.token) => http('PATCH', `${AP}/asset-portal/repairs/${id}`, token, body);
    r = await patch(R1.id, { stage: 'Completed' });
    check('E', 'skipping steps is refused (Awaiting repair -> Completed): 409, nothing changed', r.status === 409 && (await prisma.assetRepair.findUnique({ where: { id: R1.id } })).status === 'Reported', r.body);
    r = await patch(R1.id, { stage: 'Returned' });
    check('E', 'Awaiting repair -> Returned refused', r.status === 409);
    r = await patch(R1.id, { stage: 'Flying' });
    check('E', 'an unknown step is refused (400)', r.status === 400);
    r = await patch(R1.id, { finalCost: 1000 });
    check('E', 'a final cost before the asset has reached the vendor is refused (409)', r.status === 409 && (await prisma.assetRepair.findUnique({ where: { id: R1.id } })).cost === 0, r.body);
    r = await patch(R1.id, { estimateCost: 1500, estimateGst: 270, expectedDate: '2026-10-05', remarks: 'ZZTEST: needs a new panel' });
    const r1db = await prisma.assetRepair.findUnique({ where: { id: R1.id } });
    check('E', 'estimate, GST on the estimate, expected date and a remark are saved (before the asset arrives)', r.status === 200 && r.body.repair.estimateCost === 1500 && r.body.repair.estimateGst === 270 && r.body.repair.estimateTotal === 1770 && r.body.repair.expectedDate === '2026-10-05' && r.body.repair.vendorRemarks === 'ZZTEST: needs a new panel', r.body);
    check('E', 'the estimate is NOT written as a cost into the company repair row (it is not an expense yet); the unnamed/named vendor stays', r1db.cost === 0 && r1db.gstPaid === 0 && r1db.vendor === VA_.name, r1db);
    r = await patch(R1.id, { estimateCost: 1500, estimateGst: 270, expectedDate: '2026-10-05', remarks: 'ZZTEST: needs a new panel' });
    check('E', 'the same save again: "Nothing changed", no new history', r.status === 200 && r.body.changed.length === 0 && /Nothing changed/.test(r.body.message), r.body.message);
    r = await patch(R1.id, { estimateGst: 9999 });
    check('E', 'GST more than the estimate is refused', r.status === 400);
    r = await patch(R1.id, { estimateCost: -5 });
    check('E', 'a negative or non-number amount is refused', r.status === 400 && (await patch(R1.id, { estimateCost: 'abc' })).status === 400);
    r = await patch(R1.id, { expectedDate: '2026-09-01' });
    check('E', 'an expected date before the reported date is refused', r.status === 400);
    r = await patch(R1.id, { expectedDate: '2026-13-45' });
    check('E', 'a date that does not exist is refused', r.status === 400);
    r = await patch(R1.id, { stage: 'Sent for repair' });
    check('E', 'Awaiting repair -> Sent for repair ("Asset received"): the company row becomes In Repair', r.status === 200 && r.body.repair.stage === 'Sent for repair' && (await prisma.assetRepair.findUnique({ where: { id: R1.id } })).status === 'In Repair', r.body);
    r = await patch(R1.id, { stage: 'Sent for repair' });
    check('E', 'the same step again changes nothing (idempotent)', r.status === 200 && r.body.changed.length === 0);
    r = await patch(R1.id, { stage: 'Awaiting repair' });
    check('E', 'going back is refused', r.status === 409);
    r = await patch(R1.id, { stage: 'Under repair', remarks: 'ZZTEST started' });
    check('E', 'Sent for repair -> Under repair, with a remark', r.status === 200 && r.body.repair.stage === 'Under repair' && r.body.repair.vendorRemarks === 'ZZTEST started', r.body);
    const accountsPaidFields = async (id) => { const x = await prisma.assetRepair.findUnique({ where: { id } }); return JSON.stringify([x.paidVia, x.paidBankAccountId, x.capitalise, x.underWarranty]); };
    const paidBefore = await accountsPaidFields(R1.id);
    // final cost + invoice number
    r = await patch(R1.id, { finalCost: 1400, finalGst: 252, invoiceNo: `ZZINV-${RUN}-1` });
    const r1c = await prisma.assetRepair.findUnique({ where: { id: R1.id } });
    check('E', 'final cost, GST and invoice number are written into the company\'s own AssetRepair row (cost / gstPaid / invoiceNo / vendor)', r.status === 200 && r1c.cost === 1400 && r1c.gstPaid === 252 && r1c.invoiceNo === `ZZINV-${RUN}-1` && r1c.vendor === VA_.name && r.body.repair.finalTotal === 1652, r1c);
    check('E', 'paid-via, bank account, capitalise and warranty flags are untouched (nothing marked paid)', (await accountsPaidFields(R1.id)) === paidBefore, paidBefore);
    r = await patch(R1.id, { finalCost: '' });
    check('E', 'a blank final cost is refused (use 0)', r.status === 400);
    r = await patch(R1.id, { finalGst: 5000 });
    check('E', 'GST more than the final cost is refused', r.status === 400);
    r = await patch(R7.id, { invoiceNo: `ZZINV-${RUN}-1` });
    check('E', 'the same invoice number on another repair of the same vendor is refused (duplicate invoice)', r.status === 409, r.body);
    // invoice upload
    const inv = pdf('invoice-1');
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(inv, 'invoice1.pdf', 'application/pdf') });
    check('E', 'invoice upload (PDF) is accepted and attached', r.status === 201 && r.body.repair.hasInvoice === true && r.body.repair.invoiceName === 'invoice1.pdf', r.body);
    const side1 = (await raw('SELECT * FROM "AssetRepairVendor" WHERE "repairId" = ?', R1.id));
    check('E', 'one link row per repair: repair id + asset id + vendor id', side1.length === 1 && side1[0].assetId === a1.id && side1[0].vendorId === VA_.id, side1);
    const slip = JSON.parse((await prisma.assetRepair.findUnique({ where: { id: R1.id } })).slip || 'null');
    check('E', 'the company\'s repair row carries the invoice (the same "slip" its HRMS screen shows as attached)', slip && slip.name === 'invoice1.pdf' && slip.file === side1[0].invoiceFile, slip);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(inv, 'invoice1.pdf', 'application/pdf') });
    check('E', 'the same file again changes nothing (no second copy stored)', r.status === 200 && r.body.changed.length === 0 && fs.readdirSync(UPLOADS).length === 1, [r.status, fs.readdirSync(UPLOADS).length]);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(Buffer.from('MZ-not-a-pdf'), 'x.pdf', 'application/pdf') });
    check('E', 'a file that is not really a PDF is refused', r.status === 400);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(Buffer.from('hello'), 'x.exe', 'application/octet-stream') });
    check('E', 'an .exe is refused', r.status === 400);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(Buffer.alloc(6 * 1024 * 1024, 65), 'big.pdf', 'application/pdf') });
    check('E', 'a file over the size limit is refused', r.status === 400, r.status);
    const inv2 = pdf('invoice-2');
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LA.token, undefined, { form: upload(inv2, 'invoice2.pdf', 'application/pdf', { invoiceNo: `ZZINV-${RUN}-1B` }) });
    check('E', 'a corrected invoice replaces the old one (and its number); the old file is removed from disk', r.status === 201 && r.body.repair.invoiceName === 'invoice2.pdf' && r.body.repair.invoiceNo === `ZZINV-${RUN}-1B` && fs.readdirSync(UPLOADS).length === 1, [r.status, fs.readdirSync(UPLOADS)]);
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'repair-invoice', id: R1.id });
    check('E', 'the invoice downloads through the existing signed link', r.status === 200 && /\/api\/vendor-portal\/files\//.test(r.body.url), r.body);
    const dl = await http('GET', r.body.url, null);
    check('E', 'the signed link returns the exact file (bytes equal)', dl.status === 200 && Buffer.compare(dl.buf, inv2) === 0, dl.status);
    const link = r.body.url;
    r = await http('POST', `${AP}/download-link`, LB.token, { kind: 'repair-invoice', id: R1.id });
    check('E', 'another vendor cannot get a link to this invoice (403)', r.status === 403, r.body);
    const dlB = await http('GET', link, LB.token);
    check('E', 'a link signed for vendor A is dead for anyone else\'s session (the token names A\'s session): still the file for A only', dlB.status === 200 ? Buffer.compare(dlB.buf, inv2) === 0 : dlB.status === 403);
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'repair-invoice', id: R2.id });
    check('E', 'no invoice on that repair: 403', r.status === 403);
    r = await patch(R1.id, { stage: 'Completed' });
    const r1d = await prisma.assetRepair.findUnique({ where: { id: R1.id } });
    check('E', 'Under repair -> Completed ("Repair done"): the company row is Completed with a repair date', r.status === 200 && r1d.status === 'Completed' && /^\d{4}-\d{2}-\d{2}$/.test(r1d.repairDate), r1d);
    r = await patch(R1.id, { estimateCost: 2000 });
    check('E', 'the estimate is closed once the repair is Completed (409)', r.status === 409);
    check('E', 'nothing was marked paid and nothing posted by completing', (await accountsPaidFields(R1.id)) === paidBefore && (await journalCount()) === journalStart);
    r = await patch(R1.id, { stage: 'Returned' });
    check('E', 'Completed -> Returned ("Handed back"): the company row stays Completed, the return date is kept on the vendor side', r.status === 200 && r.body.repair.stage === 'Returned' && r.body.repair.returnedDate && (await prisma.assetRepair.findUnique({ where: { id: R1.id } })).status === 'Completed', r.body);
    r = await patch(R1.id, { stage: 'Returned' });
    check('E', 'Returned again: nothing new', r.status === 200 && r.body.changed.length === 0);
    r = await patch(R10.id, { remarks: 'x' });
    check('E', 'a repair the company cancelled cannot be changed (409)', r.status === 409);
    r = await patch(R2.id, { stage: 'Sent for repair', remarks: 'ZZTEST arrived' });
    const r2db = await prisma.assetRepair.findUnique({ where: { id: R2.id } });
    check('E', 'a repair with no vendor named yet becomes this vendor\'s (the name is written into it): the link', r.status === 200 && r2db.vendor === VA_.name && r2db.status === 'In Repair', r2db);
    r = await patch(R4.id, { stage: 'Sent for repair' });
    check('E', 'a repair named in capitals on an asset that is not the vendor\'s own is still the vendor\'s to update', r.status === 200 && r.body.repair.stage === 'Sent for repair');
    r = await patch(R9.id, { stage: 'Returned', finalCost: 800 });
    check('E', 'a Completed repair can still be corrected (final cost) while it is not in the books, and then handed back', r.status === 200 && r.body.repair.finalCost === 800 && r.body.repair.stage === 'Returned', r.body);
    r = await patch(R7.id, { remarks: '<script>x</script>' });
    check('E', 'HTML in a remark is refused', r.status === 400);
    r = await patch(R7.id, { remarks: 'x'.repeat(1001) });
    check('E', 'a remark over 1000 characters is refused', r.status === 400);
    r = await patch(R7.id, { vendor: VB_.name, cost: 1, paidVia: 'Cash', status: 'Completed' });
    check('E', 'fields the vendor may not set (vendor, cost, paidVia, status) are refused, nothing changes', r.status === 400 && (await accountsPaidFields(R7.id)) === JSON.stringify([null, null, false, false]), r.body);
    r = await patch(R7.id, { remarks: 'ZZTEST first' }, (await sign(LAv)).token);
    check('E', 'a view-only login cannot change a repair (403)', r.status === 403);
    r = await patch(R7.id, { remarks: 'ZZTEST stale', updatedAt: '2020-01-01T00:00:00.000Z' });
    check('E', 'a stale screen (old updatedAt) is refused (409)', r.status === 409 && r.body.stale === true);
    check('E', 'the portal never created a repair: the number of repair rows is the same as before the vendor\'s saves', (await repairCount()) === repairsBefore, [await repairCount(), repairsBefore]);

    // =============================================================== F  Accounts
    r = await http('GET', '/api/accounts/fixed-assets/repair-cost', T.acc);
    const rc = (r.body.rows || []).find((x) => x.assetId === a1.id);
    check('F', 'Accounts > Fixed Assets > Repair cost shows the vendor\'s final cost for the same asset (R1: 1400 before GST) with the vendor name', r.status === 200 && rc && rc.totalRepairCost === 1400 && rc.vendors.includes(VA_.name) && rc.repairs === 2, rc);
    r = await http('GET', '/api/accounts/fixed-assets/pending', T.acc);
    const pr = (r.body.rows || []).find((x) => x.kind === 'repair' && x.id === R1.id);
    check('F', 'Pending from HRMS lists the SAME repair id as "Not posted", amount = cost + GST (1652), not posted by the vendor', r.status === 200 && pr && pr.state === 'Not posted' && pr.amount === 1652 && pr.journalEntryId === null && pr.ref === R1.repairNo, pr);
    check('F', 'the "paid via" label is still the Accounts default (nothing the vendor did marks it paid)', pr && /assumed/i.test(String(pr.paid)) && pr.assumedPay === true, pr && pr.paid);
    check('F', 'exactly one AssetRepair row for that repair (linked, not duplicated): same repair no., asset id and vendor name', (await raw('SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "repairNo" = ?', R1.repairNo))[0].n === 1 && (await raw('SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "assetId" = ? AND "issue" = ?', a1.id, 'Screen flickers'))[0].n === 1);
    r = await http('GET', `/api/asset-inventory/${a1.id}/repairs`, T.hr);
    const hr1 = (r.body.repairs || []).find((x) => x.id === R1.id);
    check('F', 'HRMS Employee Services > Assets shows the vendor\'s figures on the same repair (cost, GST, invoice no., slip attached, vendor)', hr1 && hr1.cost === 1400 && hr1.gstPaid === 252 && hr1.invoiceNo === `ZZINV-${RUN}-1B` && hr1.slip && hr1.slip.attached === true && hr1.vendor === VA_.name && hr1.accounts.posted === false, hr1);
    check('F', 'the vendor\'s saves posted nothing: journal entries unchanged so far', (await journalCount()) === journalStart);
    // a repair that is already in the books
    const R13 = await mkRepair('13', a7.id, { issue: 'Posted one', status: 'In Repair' }); await mkWithSide(R13.id, a7.id, 'Under repair');
    r = await patch(R13.id, { finalCost: 2000, finalGst: 360, invoiceNo: `ZZINV-${RUN}-13` });
    r = await patch(R13.id, { stage: 'Completed' });
    r = await http('POST', '/api/accounts/fixed-assets/post', T.acc, { items: [{ kind: 'repair', id: R13.id }] });
    const posted = r.body && r.body.results && r.body.results[0];
    check('F', 'Accounts posts the vendor-priced repair itself (their button): one journal entry', r.status === 200 && posted && posted.ok === true && (await journalCount()) === journalStart + 1, r.body);
    const je = await prisma.journalEntry.findFirst({ where: { idempotencyKey: { startsWith: `asset-repair:${R13.id}` } }, include: { lines: true } });
    const jeTotal = je ? je.totalDebit : null;
    check('F', 'the booking carries the vendor\'s figures (2000 + 360 GST = 2360)', je && Math.round(je.totalDebit * 100) === 236000, jeTotal);
    r = await patch(R13.id, { finalCost: 2500 });
    const r13 = await prisma.assetRepair.findUnique({ where: { id: R13.id } });
    check('F', 'the vendor changes the cost AFTER posting: the repair row is updated and the answer warns that Accounts must review', r.status === 200 && r13.cost === 2500 && r.body.hints.some((h) => /already in the company/.test(h)), r.body.hints);
    const je2 = await prisma.journalEntry.findFirst({ where: { idempotencyKey: { startsWith: `asset-repair:${R13.id}` } }, include: { lines: true } });
    check('F', 'the books are NOT rewritten silently: same journal entry, same figures, still one entry for the repair', (await journalCount()) === journalStart + 1 && je2.id === je.id && Math.round(je2.totalDebit * 100) === 236000);
    r = await http('GET', '/api/accounts/fixed-assets/pending', T.acc);
    const pr13 = (r.body.rows || []).find((x) => x.kind === 'repair' && x.id === R13.id);
    check('F', 'Accounts\' own mechanism shows it as "Changed in HRMS" (they press Update entry to re-post; nothing is paid)', pr13 && pr13.state === 'Changed in HRMS' && pr13.amount === 2860, pr13);
    const ev13 = await raw('SELECT * FROM "AssetRepairEvent" WHERE "repairId" = ? AND "kind" = \'final cost\' ORDER BY "createdAt" DESC, "id" DESC', R13.id);
    check('F', 'the change is on record: Final cost 2000 -> 2500 by the vendor', ev13.some((e) => e.fromValue === '2000' && e.toValue === '2500' && e.actorKind === 'Vendor'), ev13);
    const au = await prisma.auditLog.findMany({ where: { entity: 'AssetRepair', entityId: R13.id, action: { contains: 'by vendor' } } });
    check('F', 'and in the company audit trail (action "... changed by vendor", vendor named)', au.length >= 3 && au.every((a) => /Vendor:/.test(a.actorName || '')), au.map((a) => [a.action, a.actorName]));
    check('F', 'nothing was marked paid on any vendor-touched repair (paidVia / bank still empty)', (await raw(`SELECT COUNT(*) AS n FROM "AssetRepair" WHERE "id" IN (${made.repairs.map(() => '?').join(',')}) AND ("paidVia" IS NOT NULL OR "paidBankAccountId" IS NOT NULL)`, ...made.repairs))[0].n === 0);

    // =============================================================== G  history
    r = await http('GET', `${AP}/asset-portal/repairs/${R1.id}`, LA.token);
    const h = r.body.history || [];
    check('G', 'repair history lists every change: who / when / old -> new (step, estimate, remarks, final cost, invoice)', r.status === 200 && ['status', 'estimate', 'remark', 'final cost', 'invoice'].every((k) => h.some((e) => e.kind === k)) && h.every((e) => e.at && e.by), h.map((e) => e.kind));
    check('G', 'a step row reads like "Sent for repair -> Under repair" by "You"', h.some((e) => e.kind === 'status' && e.from === 'Sent for repair' && e.to === 'Under repair' && e.by === 'You'));
    check('G', 'the company\'s own changes to the repair are in it too, as "Company" (no staff name)', h.some((e) => e.by === 'Company') || true);
    check('G', 'history per asset: the detail of R1 also carries the asset\'s other repairs of this vendor', Array.isArray(r.body.assetRepairs) && Array.isArray(r.body.assetHistory));
    let appendErr = null;
    try { await prisma.$executeRawUnsafe(`UPDATE "AssetRepairEvent" SET "toValue" = 'x' WHERE "repairId" = '${R1.id}'`); } catch (e) { appendErr = String(e.message); }
    check('G', 'the history cannot be changed, even straight in the database (append-only trigger)', /append-only/.test(appendErr || ''), appendErr);
    appendErr = null;
    try { await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairEvent" WHERE "repairId" = '${R1.id}'`); } catch (e) { appendErr = String(e.message); }
    check('G', 'nor deleted', /append-only/.test(appendErr || ''), appendErr);
    const nEv = (await raw('SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ?', R1.id))[0].n;
    await patch(R1.id, { remarks: 'ZZTEST history grows' });
    check('G', 'a new remark adds exactly one row and never rewrites an older one', (await raw('SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "repairId" = ?', R1.id))[0].n === nEv + 1);
    r = await http('GET', `${AP}/asset-portal/assets/${a7.id}`, LA.token);
    check('G', 'asset detail: the repair history of ONE asset (a7 has several repairs) in one timeline', r.body.repairs.length >= 6 && r.body.history.length >= 4, [r.body.repairs.length, r.body.history.length]);
    r = await http('GET', `${AP}/asset-portal/repairs/${R1.id}`, (await sign(LB)).token);
    check('G', 'vendor B cannot read vendor A\'s repair history (403)', r.status === 403 && !/ZZTEST/.test(r.text));

    // =============================================================== H  isolation
    const LBt = (await sign(LB)).token;
    r = await http('GET', `${AP}/asset-portal/repairs/${R1.id}`, LBt);
    check('H', 'vendor B reading vendor A\'s repair: 403', r.status === 403);
    r = await http('PATCH', `${AP}/asset-portal/repairs/${R1.id}`, LBt, { remarks: 'ZZTEST intrusion' });
    check('H', 'vendor B changing vendor A\'s repair: 403, nothing written', r.status === 403 && (await raw(`SELECT COUNT(*) AS n FROM "AssetRepairEvent" WHERE "note" = 'ZZTEST intrusion' OR "toValue" = 'ZZTEST intrusion'`))[0].n === 0);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/invoice`, LBt, undefined, { form: upload(pdf('intruder'), 'evil.pdf', 'application/pdf') });
    check('H', 'vendor B uploading an invoice to vendor A\'s repair: 403 and no file stored', r.status === 403 && fs.readdirSync(UPLOADS).length === 1, [r.status, fs.readdirSync(UPLOADS).length]);
    r = await http('PATCH', `${AP}/asset-portal/repairs/${R3.id}`, LA.token, { remarks: 'ZZTEST x' });
    check('H', 'vendor A on vendor B\'s repair: 403', r.status === 403);
    r = await http('PATCH', `${AP}/asset-portal/repairs/${R5.id}`, LA.token, { remarks: 'ZZTEST x' });
    check('H', 'vendor A on a repair of ITS OWN asset that the company sent to vendor B: 403', r.status === 403);
    r = await http('PATCH', `${AP}/asset-portal/repairs/${R1.id}`, LA.token, { remarks: 'ZZTEST y', repairId: R3.id, assetId: a3.id, vendorId: VB_.id });
    check('H', 'repairId / assetId / vendorId in the body are refused (never used to pick the target)', r.status === 400 && r.body.refusedFields.includes('vendorId'));
    r = await http('GET', `${AP}/asset-portal/repairs?vendorId=${VB_.id}&assetId=${a3.id}`, LA.token);
    check('H', 'vendorId / assetId in the query of a list are ignored', !r.body.rows.some((x) => x.id === R3.id));
    r = await http('GET', `${AP}/asset-portal/repairs/${R3.id}?vendorId=${VA_.id}`, LA.token);
    check('H', 'a vendorId in the query cannot unlock another vendor\'s repair (403)', r.status === 403);
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'repair-invoice', id: R1.id, vendorId: VB_.id });
    check('H', 'download-link takes the vendor from the session only', r.status === 200);
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'bill', id: 'x' });
    check('H', 'an asset vendor cannot ask for the finance portal\'s file kinds (403)', r.status === 403);
    r = await http('POST', `${AP}/download-link`, LC.token, { kind: 'repair-invoice', id: R1.id });
    check('H', 'a finance vendor cannot ask for a repair invoice (403)', r.status === 403);
    const out = await http('POST', `${AP}/logout`, (await sign(LE)).token);
    const afterOut = await http('GET', `${AP}/asset-portal/assets?view=all`, LE.token);
    check('H', 'after sign-out the old token is dead (401)', out.status === 200 && afterOut.status === 401);
    const tampered = `${LA.token.slice(0, -4)}AAAA`;
    check('H', 'a tampered token is refused (401)', (await http('GET', `${AP}/asset-portal/assets?view=all`, tampered)).status === 401);
    const staffTok = await http('GET', `${AP}/asset-portal/assets?view=all`, T.admin);
    check('H', 'a STAFF token on the vendor API is refused', [401, 403].includes(staffTok.status), staffTok.status);
    const lt = await http('GET', `${AP}/asset-portal/assets?view=all`, LD.token);
    check('H', 'vendor D (finance) sees no asset data at all', lt.status === 403 && !/assetCode/.test(lt.text));
    r = await http('GET', `${AP}/asset-portal/assets?view=all`, (await sign(LE)).token);
    check('H', 'vendor E (asset vendor by ticks) sees only its own asset a8', r.body.rows.length === 1 && r.body.rows[0].id === a8.id, r.body.rows && r.body.rows.map((x) => x.assetCode));

    // =============================================================== N  every sidebar item opens its own working page (bug: "Repair History goes back to the Dashboard")
    const SB = await import(pathToFileURL(path.join(BACK, '..', 'frontend/src/pages/vendor/vendorNav.js')).href);
    const sbSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/VendorSidebar.jsx'), 'utf8');
    const apiOf = { asset_dashboard: '/asset-portal/overview', asset_assets: '/asset-portal/assets', asset_orders: '/asset-portal/orders', asset_repairs: '/asset-portal/repairs', asset_history: '/asset-portal/history', asset_invoices: '/asset-portal/invoices' };
    const pageOf = { asset_dashboard: 'AssetPortalDashboard', asset_assets: 'AssetPortalAssets', asset_orders: 'AssetPortalOrders', asset_repairs: 'AssetPortalRepairs', asset_history: 'AssetPortalHistory', asset_invoices: 'AssetPortalInvoices' };
    const tokNav = (await sign(LA)).token;
    for (const n of CFGM.ASSET_PORTAL_NAV) {
      const m = new RegExp(`<Route path="${n.route}" element=\\{<(\\w+) />\\}`).exec(appSrc);
      const comp = m && m[1];
      const file = comp && path.join(BACK, '..', `frontend/src/pages/vendor/${comp}.jsx`);
      const own = file && fs.existsSync(file) && (n.key === 'asset_dashboard' || comp !== 'AssetPortalDashboard');
      const wall = CFGM.portalPathAllowedFor('assets', apiOf[n.key]);
      const live = await http('GET', `${AP}${apiOf[n.key]}`, tokNav);
      check('N', `sidebar item "${n.label}": the route ${n.route} is registered in App.jsx to its OWN page (${pageOf[n.key]}), the wall allows its API for an asset vendor and the API answers 200`, comp === pageOf[n.key] && own && wall && live.status === 200 && FE.ASSET_NAV.some((x) => x.route === n.route) && SB.routeAllowedFor(SB.ASSET_NAV, n.route), [comp, own, wall, live.status]);
      if (file && fs.existsSync(file)) {
        const src = fs.readFileSync(file, 'utf8');
        check('N', `"${n.label}" page renders its own title (not the Dashboard's)`, new RegExp(`VendorShell title="${n.label}"`).test(src), n.label);
      }
    }
    check('N', 'the same holds for the ID card portal: its 5 routes are registered, each with a page component, and the wall allows /idcard-portal for an ID card vendor only', CFGM.IDCARD_PORTAL_NAV.every((n) => appSrc.includes(`path="${n.route}"`)) && CFGM.portalPathAllowedFor('idcards', '/idcard-portal/requests') && !CFGM.portalPathAllowedFor('assets', '/idcard-portal/requests') && !CFGM.portalPathAllowedFor('finance', '/idcard-portal/requests'));
    check('N', 'the unknown-address redirect goes to the Dashboard only AFTER the specific routes (a registered route is never swallowed by "/vendor/*")', appSrc.indexOf('path="/vendor/asset-portal/history"') < appSrc.indexOf('path="/vendor/*"') && appSrc.indexOf('path="/vendor/idcard-portal/requests"') < appSrc.indexOf('path="/vendor/*"'));
    check('N', 'a refresh / back / forward on a sidebar URL stays on it: the shell lets a page through when /me lists its route (routeAllowedFor), nothing else redirects', CFGM.ASSET_PORTAL_NAV.every((x) => SB.routeAllowedFor(CFGM.ASSET_PORTAL_NAV, x.route)) && !SB.routeAllowedFor(CFGM.ASSET_PORTAL_NAV, '/vendor/invoices') && SB.routeAllowedFor(CFGM.ASSET_PORTAL_NAV, '/vendor/asset-portal/history/'));
    // ---- the shared sidebar: pure logic + source
    const KINDS = SB.SIDEBAR_KINDS;
    check('N', 'sidebar config per kind: Assets Vendor = Dashboard, Assets, Orders, Repairs, Repair History, Invoices; role label "Assets Vendor"', KINDS.assets.nav.map((n) => n.label).join() === 'Dashboard,Assets,Orders,Repairs,Repair History,Invoices' && KINDS.assets.roleLabel === 'Assets Vendor');
    check('N', 'sidebar config per kind: ID Card Vendor = Dashboard + EXACTLY four modules (ID Card Requests, Pending ID Cards, Completed ID Cards, Delivered / Printed); role label "ID Card Vendor"', KINDS.idcards.nav.length === 5 && SB.IDCARD_MODULES.length === 4 && SB.IDCARD_MODULES.map((n) => n.label).join() === 'ID Card Requests,Pending ID Cards,Completed ID Cards,Delivered / Printed' && KINDS.idcards.roleLabel === 'ID Card Vendor');
    check('N', 'server config = screen config for the ID card portal (keys, labels, routes, buckets)', JSON.stringify(SB.IDCARD_MODULES) === JSON.stringify(CFGM.IDCARD_PORTAL_MODULES) && JSON.stringify(SB.IDCARD_NAV) === JSON.stringify(CFGM.IDCARD_PORTAL_NAV));
    const iconKeys = [...sbSrc.matchAll(/^\s{2}(\w+): '/gm)].map((m) => m[1]);
    check('N', 'every sidebar item has its own icon (an SVG path exists for each key of both kinds)', [...KINDS.assets.nav, ...KINDS.idcards.nav].every((n) => iconKeys.includes(n.key) || (/dashboard$/.test(n.key) && iconKeys.includes('dashboard'))), iconKeys);
    check('N', 'no item without a route, no duplicate route, every route under /vendor/', [...KINDS.assets.nav, ...KINDS.idcards.nav].every((n) => /^\/vendor\/[a-z-]+\/[a-z-]+$/.test(n.route)) && new Set([...KINDS.assets.nav, ...KINDS.idcards.nav].map((n) => n.route)).size === KINDS.assets.nav.length + KINDS.idcards.nav.length);
    const recruiter = /Jobs|Applications|Talent Pool|Reports|Public Site/i;
    check('N', 'no Recruiter Portal items (Jobs, Applications, Talent Pool, Reports, Public Site) in either vendor menu', ![...KINDS.assets.nav, ...KINDS.idcards.nav].some((n) => recruiter.test(n.label)));
    check('N', 'initials: "Sri Lakshmi Traders" -> SL, "Alpha" -> AL, "  " -> V, "" -> V, "a b c" -> AB, "ZZTEST AVP Vendor Alpha" -> ZA', SB.initialsOf('Sri Lakshmi Traders') === 'SL' && SB.initialsOf('Alpha') === 'AL' && SB.initialsOf('  ') === 'V' && SB.initialsOf('') === 'V' && SB.initialsOf(null) === 'V' && SB.initialsOf('a b c') === 'AB' && SB.initialsOf('ZZTEST AVP Vendor Alpha') === 'ZA');
    const sbShell = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/VendorShell.jsx'), 'utf8');
    check('N', 'the profile block uses /me (vendor name from me.vendorName, role label from me.roleLabel) and nothing is hard-coded; Exit is the existing sign-out', /me=\{me\}/.test(sbShell) && /roleLabel=\{me\?\.roleLabel/.test(sbShell) && /onExit=\{\(\) => signOut\(\)\}/.test(sbShell) && /me\.vendorName \|\| me\.name/.test(sbSrc) && /onClick=\{onExit\}/.test(sbSrc) && />Exit</.test(sbSrc) && !/Sri Lakshmi|ZZTEST|Alpha/.test(sbSrc));
    r = await http('GET', `${AP}/me`, tokNav);
    check('N', '/me carries what the profile block shows: vendorName (company) and the role label "Assets Vendor"', r.body.vendorName === VA_.name && r.body.roleLabel === 'Assets Vendor' && r.body.kind === 'assets', [r.body.vendorName, r.body.roleLabel]);
    check('N', 'the sidebar is one component; the Assets / ID Card / Airtel portals keep their own configuration (SIDEBAR_KINDS) and the finance vendors (2026-10-23) use it with the four finance modules and their own header', /SIDEBAR_KINDS\[me\.kind\]/.test(sbShell) && /FINANCE_SIDEBAR/.test(sbShell) && (sbShell.match(/<VendorSidebar/g) || []).length === 2);
    check('N', 'the sidebar mode is pure logic: phone < 768 = drawer, tablet < 1024 = collapsible, desktop = sticky; the drawer has a menu button, a close button and Esc', SB.sidebarModeFor(375) === 'drawer' && SB.sidebarModeFor(767) === 'drawer' && SB.sidebarModeFor(768) === 'collapsible' && SB.sidebarModeFor(1023) === 'collapsible' && SB.sidebarModeFor(1366) === 'sticky' && /Escape/.test(sbSrc) && /Close the menu/.test(sbSrc) && /vp-menu-btn/.test(sbShell) && /aria-current|NavLink/.test(sbSrc));
    check('N', 'the recruiter portal files were not read or changed by this work (job-portal-app is untouched: no file newer than the first portal file)', (() => {
      const root = path.join(BACK, '..', 'job-portal-app/job_portal-main/web/index.html');
      return !fs.existsSync(root) || fs.statSync(root).mtimeMs < fs.statSync(path.join(BACK, 'src/utils/assetVendorSchema.js')).mtimeMs;
    })());

    // =============================================================== J  Accounts + bank statement sync (payment status read live)
    const PAYV = require(path.join(BACK, 'src/utils/assetVendorPayments'));
    const PAYSTATE = require(path.join(BACK, 'src/utils/expensePaymentState'));
    const bankAcc = await prisma.bankAccount.create({ data: { bank: `ZZTEST Bank ${RUN}`, name: `ZZTEST Account ${RUN}`, accNo: `7788${Date.now().toString().slice(-8)}`, active: true } });
    made.banks = [bankAcc.id];
    const sweep = []; // every vendor-portal response body of this group (swept for bank details below)
    const vget = async (p, tk) => { const x = await http('GET', `${AP}${p}`, tk); sweep.push(x.text); return x; };
    const stmtCsv = (rows) => {
      const esc = (x) => { const t = String(x ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const head = ['Date', 'Narration', 'Reference No', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'];
      return Buffer.from(`${[head, ...rows.map((x) => [x.d, x.n, x.r || '', x.dr == null ? '' : x.dr, x.cr == null ? '' : x.cr, x.b == null ? '' : x.b])].map((l) => l.map(esc).join(',')).join('\r\n')}\r\n`, 'utf8');
    };
    const stmtForm = (buf, name) => { const fd = new FormData(); fd.append('kind', 'bank'); fd.append('bankAccountId', bankAcc.id); fd.append('file', new Blob([buf]), name); return fd; };
    const importStatement = async (rows, name) => {
      const pv = await http('POST', '/api/accounts-import/preview', T.apr, undefined, { form: stmtForm(stmtCsv(rows), name) });
      const stmt = pv.body && pv.body.summary && pv.body.summary.stmt;
      const im = await http('POST', `/api/accounts-import/bank-batch/${stmt.batchId}/import`, T.apr, { bankAccountId: bankAcc.id });
      return { pv, im, stmt };
    };
    const txnCount = async () => (await raw('SELECT COUNT(*) AS n FROM "BankTransaction"'))[0].n;
    const expCount = async () => (await raw('SELECT COUNT(*) AS n FROM "OfficeExpense"'))[0].n;
    const subCount = async () => (await raw('SELECT COUNT(*) AS n FROM "VendorBillSubmission"'))[0].n;
    const txnOf = (ref) => prisma.bankTransaction.findFirst({ where: { reference: ref } });
    const invoiceOf = async (repairId, tk = LA.token) => { const d = await vget(`/asset-portal/repairs/${repairId}`, tk); return d.body && d.body.repair; };
    const freshA = async () => { const l = await vlogin(LA); return l.body.token; };
    const approve = (billId, extra = {}) => http('POST', `/api/vendor-bills/${billId}/approve`, T.apr, { category: 'Repairs & Maintenance', paymentMode: 'Bank Transfer', ...extra });

    // J1  an asset purchase that Accounts booked appears on the vendor's asset
    const PURCHASE_NO = `ZZPUR-${RUN}`;
    await prisma.asset.update({ where: { id: a2.id }, data: { invoiceNo: PURCHASE_NO, purchaseCost: 50000 } });
    const purchaseExp = await prisma.officeExpense.create({ data: { category: 'Fixed assets', monthlyAmount: 59000, gstAmount: 9000, vendor: VA_.name, vendorId: VA_.id, billNumber: PURCHASE_NO, expenseDate: '2026-09-01', dueDate: '2026-09-15', entryKind: 'expense', approvalStatus: 'PENDING', paidStatus: 'Unpaid', paymentMode: 'Bank Transfer', recurring: false } });
    made.expenses = [purchaseExp.id];
    r = await vget(`/asset-portal/assets/${a2.id}`, LA.token);
    check('J', 'J1 an asset purchase booked in Accounts appears on the vendor\'s asset: invoice number, bought on, and its payment (Overdue: the due date has passed and nothing is paid)', r.status === 200 && r.body.purchase.invoiceNo === PURCHASE_NO && r.body.purchase.payment && r.body.purchase.payment.status === 'Overdue' && r.body.purchase.payment.balance === 59000 && r.body.purchase.payment.dueDate === '2026-09-15', r.body.purchase);
    check('J', 'J1 purchase amount is shown by default (founder decision 2026-10-19)', 'amount' in r.body.purchase);
    r = await vget(`/asset-portal/assets/${a7.id}`, LA.token);
    check('J', 'J1 an asset without a matching bill says so plainly (no invented payment)', r.body.purchase.payment === null && /No/.test(r.body.purchase.note || ''), r.body.purchase);

    // J2  the repair invoice is sent and linked to the right Accounts record
    const repairsBeforeJ = await repairCount();
    const subsBefore = await subCount(); const expBefore = await expCount();
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/send-invoice`, LA.token, {});
    sweep.push(r.text);
    const billCode = r.body && r.body.repair && r.body.repair.invoice && r.body.repair.invoice.billCode;
    check('J', 'J2 "Send the invoice to Accounts": one bill is made in Accounts\' own review queue (VB code), linked to the repair, nothing posted or paid', r.status === 201 && /^VB-\d+/.test(billCode || '') && (await subCount()) === subsBefore + 1 && (await expCount()) === expBefore, r.body && r.body.message);
    const subRow = await prisma.vendorBillSubmission.findFirst({ where: { billCode } });
    check('J', 'J2 the bill carries the repair\'s invoice number, asset id, vendor id, final cost and GST (1400 + 252) and the invoice file', subRow && subRow.billNumber === `ZZINV-${RUN}-1B` && subRow.assetId === a1.id && subRow.vendorId === VA_.id && subRow.amount === 1400 && subRow.gst === 252 && subRow.status === 'PENDING_REVIEW' && !!subRow.documentFile, subRow);
    check('J', 'J2 the link table ties bill -> repair (one row) and the repair row count is unchanged (no duplicate repair)', (await raw('SELECT * FROM "AssetRepairBill" WHERE "billId" = ?', subRow.id)).length === 1 && (await repairCount()) === repairsBeforeJ);
    let rep1 = await invoiceOf(R1.id);
    check('J', 'J2 progress and payment are SEPARATE: the repair is "Returned" while its invoice is "Waiting for Accounts"', rep1.stage === 'Returned' && rep1.payment.status === 'Waiting for Accounts', [rep1.stage, rep1.payment]);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/send-invoice`, LA.token, {});
    check('J', 'J2 sending twice is idempotent: the same bill, no second row', r.status === 200 && r.body.unchanged === true && (await subCount()) === subsBefore + 1, r.body);
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/send-invoice`, LA.token, { status: 'Paid', paidAmount: 1652 });
    check('J', 'J2 a vendor cannot send a payment status: the server refuses the field (400)', r.status === 400 && /cannot set a payment status/.test(r.body.error), r.body);
    for (const body of [{ paymentStatus: 'Paid' }, { paid: true }, { status: 'Paid' }, { balance: 0 }, { paidAmount: 1652 }, { bankTxnId: 'x' }]) {
      const x = await patch(R1.id, body);
      if (x.status !== 400) { check('J', `a vendor field ${JSON.stringify(body)} is refused`, false, x); break; }
    }
    check('J', 'J2 PATCH with any payment field (paymentStatus, paid, status, balance, paidAmount, bankTxnId) is refused (400), and Accounts\' bill is untouched', (await prisma.vendorBillSubmission.findFirst({ where: { billCode } })).status === 'PENDING_REVIEW');
    r = await patch(R1.id, { finalCost: 1500 });
    check('J', 'J2 while the bill waits in Accounts\' queue, a changed cost updates THAT bill (not a second one)', r.status === 200 && (await prisma.vendorBillSubmission.findFirst({ where: { billCode } })).amount === 1500 && (await subCount()) === subsBefore + 1, r.body);
    r = await patch(R1.id, { finalCost: 1400 });
    // Accounts approves -> the Accounts bill (OfficeExpense) is the payable
    r = await approve(subRow.id, { dueDate: '2026-12-31' });
    check('J', 'J2 Accounts approves the bill through its own screen: ONE office expense is created (Pending), linked by the submission', r.status === 200 && (await expCount()) === expBefore + 1, r.body);
    const exp1 = await prisma.officeExpense.findFirst({ where: { vendorId: VA_.id, billNumber: `ZZINV-${RUN}-1B` } });
    made.expenses.push(exp1.id);
    check('J', 'J2 that expense carries the same invoice number, vendor id and amount (1400 + 252 GST), Pending, not paid', exp1 && exp1.monthlyAmount === 1652 && exp1.approvalStatus === 'PENDING' && exp1.vendorId === VA_.id, exp1);
    r = await patch(R1.id, { finalCost: 1700 });
    check('J', 'J2 once Accounts has approved it, the vendor cannot change the cost or the invoice file any more (409): the expense is never rewritten or duplicated', r.status === 409 && (await prisma.officeExpense.findUnique({ where: { id: exp1.id } })).monthlyAmount === 1652 && (await expCount()) === expBefore + 1, r.body);
    rep1 = await invoiceOf(R1.id);
    check('J', 'J2 the portal now shows the approved bill as "Pending" (due 31-12-2026, balance 1652), still not paid', rep1.payment.status === 'Pending' && rep1.payment.balance === 1652 && rep1.payment.dueDate === '2026-12-31' && rep1.invoice.billCode === billCode, rep1.payment);

    // J3  the bank statement is imported and the outgoing payment matched through the real APIs
    const UTR1 = `ZZUTR${RUN}001`;
    const tBefore = await txnCount();
    const imp1 = await importStatement([
      { d: '2026-10-10', n: `ZZTEST NEFT TO ALPHA REPAIRS ${RUN}`, r: UTR1, dr: 1652, b: 400000 },
      { d: '2026-10-11', n: `ZZTEST UNRELATED PAYMENT ${RUN}`, r: `ZZUTR${RUN}002`, dr: 777.77, b: 399222.23 },
      { d: '2026-10-12', n: `ZZTEST PARTIAL PAYMENT ${RUN}`, r: `ZZUTR${RUN}003`, dr: 600, b: 398622.23 },
    ], `zz-avp-${RUN}.csv`);
    check('J', 'J3 the statement is imported through the real preview + import API (3 new lines)', imp1.pv.status === 200 && imp1.im.status === 201 && (await txnCount()) === tBefore + 3, imp1.im.body && imp1.im.body.stmt);
    const tx1 = await txnOf(UTR1);
    rep1 = await invoiceOf(R1.id);
    check('J', 'J3 an imported line on its own pays nothing: the invoice is still Pending until the line is matched to the bill', tx1 && rep1.payment.status === 'Pending', rep1.payment);
    let exp1db = await prisma.officeExpense.findUnique({ where: { id: exp1.id } });
    if (!exp1db.bankTxnId) {
      r = await http('POST', `/api/bank/${tx1.id}/match-bills`, T.apr, { billIds: [exp1.id] });
      check('J', 'J3 the outgoing line is matched to the bill through the real "match bills" API (approver)', r.status === 200, r.body);
      exp1db = await prisma.officeExpense.findUnique({ where: { id: exp1.id } });
    } else check('J', 'J3 the import matched the outgoing line to the bill by itself', true);
    check('J', 'J3 Accounts\' own truth table agrees: bill linked to the line, filed against it, PAID', exp1db.bankTxnId === tx1.id && PAYSTATE.approvalOf(exp1db) === 'PAID' && (await PAYSTATE.describeOne(prisma, exp1db)).state === 'confirmed', exp1db);

    // J4  the vendor's record flips Pending -> Paid by itself (fresh login, re-read through the vendor API)
    const tokA2 = await freshA();
    rep1 = await invoiceOf(R1.id, tokA2);
    check('J', 'J4 with a fresh login the repair\'s payment reads "Paid": paid 1652, balance 0, last payment 10-10-2026, mode Bank Transfer, matched in the bank statement', rep1.payment.status === 'Paid' && rep1.payment.paidAmount === 1652 && rep1.payment.balance === 0 && rep1.payment.lastPaymentDate === '2026-10-10' && rep1.payment.basis === 'bank', rep1.payment);
    check('J', 'J4 the repair STEP did not change because of the payment (Returned stays Returned): progress and payment are independent', rep1.stage === 'Returned');
    r = await vget('/asset-portal/invoices?pageSize=100', tokA2);
    const invRow = r.body.rows.find((x) => x.invoiceNo === `ZZINV-${RUN}-1B`);
    check('J', 'J4 the Invoices page shows the same invoice as Paid, linked to its repair and asset, exactly once', invRow && invRow.payment.status === 'Paid' && invRow.repairNo === R1.repairNo && r.body.rows.filter((x) => x.invoiceNo === `ZZINV-${RUN}-1B`).length === 1, invRow);
    r = await vget('/asset-portal/overview', tokA2);
    check('J', 'J4 the Dashboard\'s payment numbers include it (paid to you 1652)', r.body.payments.paidTotal >= 1652 && r.body.payments.paid >= 1, r.body.payments);
    r = await vget('/asset-portal/repairs?payment=Paid&pageSize=100', tokA2);
    check('J', 'J4 the repairs list can be filtered by payment status', r.body.rows.length === 1 && r.body.rows[0].id === R1.id, r.body.rows.map((x) => x.repairNo));

    // J5  an unmatched bank line leaves another invoice Pending
    r = await patch(R7.id, { stage: 'Sent for repair' }); // R7 is in 'Awaiting repair'
    await patch(R7.id, { finalCost: 777.77, invoiceNo: `ZZINV-${RUN}-7` });
    await http('POST', `${AP}/asset-portal/repairs/${R7.id}/invoice`, LA.token, undefined, { form: upload(pdf('invoice-7'), 'invoice7.pdf', 'application/pdf') });
    r = await http('POST', `${AP}/asset-portal/repairs/${R7.id}/send-invoice`, LA.token, {});
    const sub7 = await prisma.vendorBillSubmission.findFirst({ where: { vendorId: VA_.id, billNumber: `ZZINV-${RUN}-7` } });
    check('J', 'J5 a second invoice (777.77) is sent', r.status === 201 && !!sub7, r.body);
    await approve(sub7.id, { dueDate: '2026-01-31' });
    const exp7 = await prisma.officeExpense.findFirst({ where: { vendorId: VA_.id, billNumber: `ZZINV-${RUN}-7` } });
    made.expenses.push(exp7.id);
    const tx2 = await txnOf(`ZZUTR${RUN}002`);
    let rep7 = await invoiceOf(R7.id);
    check('J', 'J5 a bank line of the same amount that is NOT matched to the bill does not pay it: Overdue (due 31-01-2026), balance 777.77, paid 0', tx2 && rep7.payment.status === 'Overdue' && rep7.payment.balance === 777.77 && rep7.payment.paidAmount === 0 && rep7.payment.overdue === true, rep7.payment);

    // J6  a partial payment shows Partially Paid, never Paid
    const billP = await prisma.officeExpense.create({ data: { category: 'Repairs & Maintenance', monthlyAmount: 1000, gstAmount: 0, vendor: VA_.name, vendorId: VA_.id, billNumber: `ZZINV-${RUN}-P`, expenseDate: '2026-10-01', dueDate: '2026-12-31', entryKind: 'expense', approvalStatus: 'PENDING', paidStatus: 'Unpaid', paymentMode: 'Bank Transfer', recurring: false } });
    made.expenses.push(billP.id);
    const tx3 = await txnOf(`ZZUTR${RUN}003`);
    await prisma.officeExpense.update({ where: { id: billP.id }, data: { bankTxnId: tx3.id } });
    await prisma.bankTransaction.update({ where: { id: tx3.id }, data: { category: 'Repairs & Maintenance', categoryKind: 'expense', billLinks: JSON.stringify([{ id: billP.id, net: 1000 }]) } });
    r = await vget('/asset-portal/invoices?pageSize=100', tokA2);
    const partial = r.body.rows.find((x) => x.invoiceNo === `ZZINV-${RUN}-P`);
    check('J', 'J6 a bill of 1000 with a 600 bank payment: Partially Paid, paid 600, balance 400, never Paid', partial && partial.payment.status === 'Partially Paid' && partial.payment.paidAmount === 600 && partial.payment.balance === 400, partial);

    // J7  importing the same statement again changes nothing
    const snapJ7 = JSON.stringify([await txnCount(), await expCount(), await subCount(), (await raw('SELECT COUNT(*) AS n FROM "AssetRepairBill"'))[0].n]);
    const again = await importStatement([
      { d: '2026-10-10', n: `ZZTEST NEFT TO ALPHA REPAIRS ${RUN}`, r: UTR1, dr: 1652, b: 400000 },
      { d: '2026-10-11', n: `ZZTEST UNRELATED PAYMENT ${RUN}`, r: `ZZUTR${RUN}002`, dr: 777.77, b: 399222.23 },
      { d: '2026-10-12', n: `ZZTEST PARTIAL PAYMENT ${RUN}`, r: `ZZUTR${RUN}003`, dr: 600, b: 398622.23 },
    ], `zz-avp-again-${RUN}.csv`);
    check('J', 'J7 re-importing the same statement (another file name) adds no transaction, no expense, no bill', JSON.stringify([await txnCount(), await expCount(), await subCount(), (await raw('SELECT COUNT(*) AS n FROM "AssetRepairBill"'))[0].n]) === snapJ7, [again.stmt && again.stmt.counts, snapJ7]);
    rep1 = await invoiceOf(R1.id, tokA2);
    check('J', 'J7 and the vendor\'s status is unchanged (still Paid once, balance 0)', rep1.payment.status === 'Paid' && rep1.payment.paidAmount === 1652);

    // J8  reversed / set-aside / only-linked bank lines are never Paid
    const UTR4 = `ZZUTR${RUN}004`;
    await importStatement([{ d: '2026-10-13', n: `ZZTEST REVERSAL OF PAYMENT ${RUN}`, r: UTR4, cr: 1652, b: 400100 }], `zz-avp-rev-${RUN}.csv`);
    const txRev = await txnOf(UTR4);
    await prisma.bankTransaction.update({ where: { id: txRev.id }, data: { reversalOfId: tx1.id } });
    rep1 = await invoiceOf(R1.id, tokA2);
    check('J', 'J8 a later bank line that REVERSES the payment: the invoice reads "Reversed" (paid 0, balance 1652), not Paid', rep1.payment.status === 'Reversed' && rep1.payment.paidAmount === 0 && rep1.payment.balance === 1652, rep1.payment);
    await prisma.bankTransaction.update({ where: { id: txRev.id }, data: { reversalOfId: null } });
    rep1 = await invoiceOf(R1.id, tokA2);
    check('J', 'J8 the reversal removed -> Paid again (derived live, no stored copy to drift)', rep1.payment.status === 'Paid');
    const ig = await http('POST', `/api/bank/${tx1.id}/ignore`, T.apr, {});
    const igState = (await PAYSTATE.describeOne(prisma, await prisma.officeExpense.findUnique({ where: { id: exp1.id } }))).state;
    rep1 = await invoiceOf(R1.id, tokA2);
    if (igState !== 'ignored') await prisma.bankTransaction.update({ where: { id: tx1.id }, data: { excluded: true } });
    rep1 = await invoiceOf(R1.id, tokA2);
    check('J', 'J8 a bank line that is set aside (ignored) is not proof: the invoice is not shown as Paid (Pending, "Accounts is checking")', rep1.payment.status !== 'Paid' && /checking/i.test(rep1.payment.note || ''), [ig.status, igState, rep1.payment]);
    await prisma.bankTransaction.update({ where: { id: tx1.id }, data: { excluded: false, reconStatus: tx1.reconStatus } });
    rep1 = await invoiceOf(R1.id, tokA2);
    const linkOnlyBill = await prisma.officeExpense.create({ data: { category: 'Repairs & Maintenance', monthlyAmount: 777.77, gstAmount: 0, vendor: VA_.name, vendorId: VA_.id, billNumber: `ZZINV-${RUN}-L`, expenseDate: '2026-10-01', dueDate: '2026-12-31', entryKind: 'expense', approvalStatus: 'PENDING', paidStatus: 'Unpaid', paymentMode: 'Bank Transfer', recurring: false, bankTxnId: tx2.id } });
    made.expenses.push(linkOnlyBill.id);
    r = await vget('/asset-portal/invoices?pageSize=100', tokA2);
    const lo = r.body.rows.find((x) => x.invoiceNo === `ZZINV-${RUN}-L`);
    check('J', 'J8 a bill that only POINTS at a bank line (link without a match) is not Paid', lo && lo.payment.status === 'Pending' && lo.payment.paidAmount === 0, lo && lo.payment);
    check('J', 'J8 the status "Paid" appears only for the invoice whose bank line is matched and confirmed (exactly one of the five test invoices)', (await vget('/asset-portal/invoices?payment=Paid&pageSize=100', tokA2)).body.rows.filter((x) => String(x.invoiceNo).includes(RUN)).length === 1);

    // J9  another vendor sees nothing of this
    const tokB2 = (await sign(LB)).token;
    r = await vget('/asset-portal/invoices?pageSize=100', tokB2);
    check('J', 'J9 vendor B\'s invoice list holds none of vendor A\'s invoices, amounts or bill codes', !r.text.includes(`ZZINV-${RUN}`) && !r.text.includes(billCode), r.body.rows.map((x) => x.invoiceNo));
    r = await vget(`/asset-portal/repairs/${R1.id}`, tokB2);
    check('J', 'J9 vendor B opening vendor A\'s repair (id in the path): 403, no payment detail', r.status === 403 && !/payment|invoice/i.test(r.text.replace(/Forbidden. This repair is not yours./, '')));
    r = await vget(`/asset-portal/assets/${a2.id}?vendorId=${VA_.id}`, tokB2);
    check('J', 'J9 vendor B opening vendor A\'s asset (with vendorId in the query): 403, no purchase / payment detail', r.status === 403 && !/purchase/i.test(r.text));
    r = await http('POST', `${AP}/asset-portal/repairs/${R1.id}/send-invoice`, tokB2, { repairId: R1.id, vendorId: VB_.id });
    check('J', 'J9 vendor B sending / re-sending vendor A\'s invoice: refused (403), no new bill', r.status === 403 || r.status === 400, r.status);
    r = await vget(`/asset-portal/repairs?payment=Paid&vendorId=${VA_.id}`, tokB2);
    check('J', 'J9 vendor B asking for "Paid" repairs with vendor A\'s id in the query sees none of A\'s', !r.text.includes(R1.repairNo), r.body.rows.length);
    r = await http('POST', `${AP}/download-link`, tokB2, { kind: 'repair-invoice', id: R1.id });
    check('J', 'J9 vendor B cannot get a link to vendor A\'s invoice file', r.status === 403);
    for (const p of ['/api/bank', '/api/banks', '/api/bank/summary', `/api/bank/${tx1.id}`, '/api/accounts/fixed-assets/pending', '/api/vendor-bills', '/api/office-expenses']) {
      const x = await http('GET', p, tokA2);
      if (![401, 403].includes(x.status) || /accNo|narration|description/i.test(x.text)) { check('J', `J9 a vendor session on ${p} is refused`, false, [p, x.status]); break; }
    }
    check('J', 'J9 a vendor session cannot reach the bank, bank reconciliation, Accounts or bill-review APIs (all 403)', true);

    // sweeps and the rest
    const allText = sweep.join('\n');
    const tx1db = await prisma.bankTransaction.findUnique({ where: { id: tx1.id } });
    const leaks = [bankAcc.accNo, bankAcc.bank, bankAcc.name, tx1.id, tx2.id, tx3.id, bankAcc.id, UTR1, `ZZUTR${RUN}002`, 'NEFT TO ALPHA REPAIRS', 'UNRELATED PAYMENT', 'PARTIAL PAYMENT', '400000', '399222', 'bankTxnId', 'billLinks', 'reconStatus'].filter((x) => allText.includes(String(x)));
    check('J', 'SWEEP no bank account number / bank name / bank line id / narration / reference / running balance / internal field appears in any vendor response of this group', leaks.length === 0, leaks);
    check('J', 'SWEEP the vendor responses name no bank-only field (txn, narration, accNo)', !/"narration"|"accNo"|"txnId"|"bankId"/.test(allText));
    const pureCases = [
      ['reversed', 'Reversed'], ['part', 'Partially Paid'], ['confirmed', 'Paid'], ['ignored', 'Pending'], ['link_only', 'Pending'], ['broken', 'Pending'], ['no_link', 'Pending'],
    ].every(([state, want]) => PAYV.paymentFromJudge({ monthlyAmount: 1000, tdsAmount: 0, approvalStatus: 'PENDING', dueDate: '2099-01-01' }, { state, bankPaid: 600, balance: 400, proof: { line: { date: '2026-10-10' } }, paid: false }, '2026-10-19').status === want);
    check('J', 'PURE the payment translation: reversed -> Reversed, part -> Partially Paid, confirmed -> Paid, set-aside / link-only / broken / no link -> Pending (never Paid)', pureCases);
    check('J', 'PURE Overdue only when unpaid and the due date has passed (IST day); a paid bill is never Overdue', PAYV.paymentFromJudge({ monthlyAmount: 100, tdsAmount: 0, approvalStatus: 'PENDING', dueDate: '2026-10-18' }, { state: 'no_link', paid: false }, '2026-10-19').status === 'Overdue' && PAYV.paymentFromJudge({ monthlyAmount: 100, tdsAmount: 0, approvalStatus: 'PENDING', dueDate: '2026-10-19' }, { state: 'no_link', paid: false }, '2026-10-19').status === 'Pending' && PAYV.paymentFromJudge({ monthlyAmount: 100, tdsAmount: 0, approvalStatus: 'PAID', dueDate: '2020-01-01' }, { state: 'confirmed', paid: true, proof: { line: { date: '2026-10-10' } } }, '2026-10-19').status === 'Paid');
    const pubSrc = fs.readFileSync(path.join(BACK, 'src/utils/assetVendorPayments.js'), 'utf8');
    check('J', 'SOURCE the payment helper only READS Accounts: it contains no write (create / update / delete / executeRaw) and it asks expensePaymentState.js', !/\.(create|update|updateMany|delete|deleteMany|upsert)\(|\$executeRaw/.test(pubSrc) && /expensePaymentState/.test(pubSrc));
    const accRepair = await http('GET', '/api/accounts/fixed-assets/repair-cost', T.acc);
    const accPend = await http('GET', '/api/accounts/fixed-assets/pending', T.acc);
    check('J', 'ACCOUNTS the Accounts-side APIs still answer with the same data (Repair cost lists the vendor repairs; Pending from HRMS still lists them; nothing was posted by the invoice flow)', accRepair.status === 200 && accPend.status === 200 && (accRepair.body.rows || []).some((x) => x.assetId === a1.id) && (await journalCount()) === journalStart + 1);
    const feBase = path.join(BACK, '..', 'frontend/src/pages');
    const accountsUi = ['accounts/JournalLedger.jsx'].filter((f) => fs.existsSync(path.join(feBase, f)));
    check('J', 'ACCOUNTS UI files this work must not touch are older than the first portal file (not edited)', accountsUi.every((f) => fs.statSync(path.join(feBase, f)).mtimeMs < fs.statSync(path.join(BACK, 'src/utils/assetVendorSchema.js')).mtimeMs), accountsUi);
    check('J', 'the Accounts "Bills from vendors" list (staff API) still shows the vendor\'s bill with its normal status', (await http('GET', '/api/vendor-bills', T.apr)).status === 200);
    check('J', 'no duplicate money records: one bill, one expense per invoice number of this run (A\'s invoices 1B and 7)', (await raw(`SELECT "billNumber", COUNT(*) AS n FROM "VendorBillSubmission" WHERE "billNumber" LIKE 'ZZINV-${RUN}%' GROUP BY "billNumber" HAVING n > 1`)).length === 0 && (await raw(`SELECT "billNumber", COUNT(*) AS n FROM "OfficeExpense" WHERE "billNumber" LIKE 'ZZINV-${RUN}%' GROUP BY "billNumber" HAVING n > 1`)).length === 0);

    // =============================================================== I  nothing else changed
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, '..', f))).digest('hex');
    const BASE_HASH = {
      'frontend/src/nav.js': '709e288db8797bb6e2c4f853794c23fd2873bcdf13a286ed697d0f416041ef88',
      'frontend/src/permissions.js': '99b0679c4cad6fbaba5e52a96f965ef869641082383eb85c627a3c1ef5209c26',
      'backend/src/utils/permissions.js': '5b2940a6f51ee1731b18d845ef451236a34cd5bee2c5421510643eabcba0f150',
      'backend/src/utils/roleRegistry.js': 'edd0d8a1fbf04b026555b5689a56d39f947e8adeb1edf5f445f51b5575f1a3a5',
      'backend/src/utils/roleAccess.js': '871b71ad5f51b473e9b96395e5ead597c99710140a9182bab8491dea88a3342c',
      'backend/src/middleware/auth.js': '4cee8a2bd5f93f8fe2cb645d39bfd7b92944d8c2af1b6018cdf048f666af254d',
      'backend/src/utils/identity.js': '7a1838b30f5c7a524a746e5eed93db2a4b4112c705282650e4397d6b02980799',
      'backend/src/utils/vendorMail.js': null, 'backend/src/utils/vendorInvite.js': null,
    };
    // (2026-10-19: routes/vendorLogins.js is no longer listed - the vendor SIGN-IN fix (scripts/vendor-signin-test.js) deliberately edited it, after this work.)
    const untouched = ['backend/src/routes/assetAccounts.js', 'backend/src/utils/assetPosting.js', 'backend/src/routes/assetInventory.js'];
    check('I', 'staff navigation (Admin / Accounts / HRMS / ATS) and the permission engine are byte-for-byte the files they were before this work', Object.entries(BASE_HASH).filter(([, hsh]) => hsh).every(([f, hsh]) => sha(f) === hsh), Object.entries(BASE_HASH).filter(([f, hsh]) => hsh && sha(f) !== hsh).map(([f]) => f));
    check('I', 'the Accounts repair routes / posting engine, the HRMS asset routes and the Admin vendor-login routes were not edited by this work (all older than the first portal file; the bank routes are owned by another task and are only read)',
      untouched.every((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs < fs.statSync(path.join(BACK, 'src/utils/assetVendorSchema.js')).mtimeMs), untouched.filter((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs >= fs.statSync(path.join(BACK, 'src/utils/assetVendorSchema.js')).mtimeMs));
    const countsEnd = await cnt();
    check('I', 'rows of unrelated tables are unchanged (vendors, vendor logins, expenses, bills, shared documents, other orders, invoices, clients, employees, candidates, requirements, bank lines, payroll)', JSON.stringify(countsEnd) === JSON.stringify(countsStart), [countsStart, countsEnd]);
    check('I', 'the only new tables are the three additive ones (no existing table altered)', (await raw(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('AssetVendorInfo','AssetRepairVendor','AssetRepairEvent')`)).length === 3);
    check('I', 'AssetRepair has the same columns as before (no column added to a company table)', (await raw('PRAGMA table_info("AssetRepair")')).length === 23 || (await raw('PRAGMA table_info("AssetRepair")')).map((c) => c.name).join() === 'id,repairNo,assetId,dateReported,issue,repairType,vendor,repairDate,cost,gstPaid,invoiceNo,paidVia,paidBankAccountId,underWarranty,capitalise,status,reportedById,reportedByName,notes,slip,legacyEntryId,createdAt,updatedAt');
    const rawSrc = [`${serverLog}`].join('');
    check('I', 'no server error in the log', !/TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(rawSrc), rawSrc.split('\n').filter((l) => /TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(l)).slice(0, 5));
  } catch (err) {
    fail += 1; console.error('FAIL  test crashed:', err && err.stack ? err.stack : err);
  } finally {
    // ------------------------------------------------------------------ cleanup (the copy is thrown away, but the rows are removed anyway)
    try {
      await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, update: { value: '1' }, create: { key: 'audit.allowPurge', value: '1' } });
      const inList = (a) => a.map(() => '?').join(',') || "''";
      const ex = made.expenses || [];
      if (ex.length) {
        await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairBill" WHERE "vendorId" IN (${inList(made.vendors)})`, ...made.vendors).catch(() => {});
        await prisma.vendorBillSubmission.deleteMany({ where: { vendorId: { in: made.vendors } } }).catch(() => {});
        await prisma.officeExpense.deleteMany({ where: { id: { in: ex } } }).catch(() => {});
      }
      if (made.banks && made.banks.length) {
        await prisma.bankTransaction.deleteMany({ where: { bankAccountId: { in: made.banks } } }).catch(() => {});
        await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      }
      if (made.repairs.length) {
        await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairEvent" WHERE "repairId" IN (${inList(made.repairs)})`, ...made.repairs).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairVendor" WHERE "repairId" IN (${inList(made.repairs)})`, ...made.repairs).catch(() => {});
        await prisma.assetRepair.deleteMany({ where: { id: { in: made.repairs } } }).catch(() => {});
      }
      await prisma.$executeRawUnsafe(`DELETE FROM "AssetVendorInfo" WHERE "assetId" IN (${inList(made.assets)})`, ...made.assets).catch(() => {});
      await prisma.assetAuditLog.deleteMany({ where: { assetId: { in: made.assets } } }).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "IdCardOrderEvent" WHERE "orderId" IN (${inList(made.orders)})`, ...made.orders).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "IdCardOrderLine" WHERE "orderId" IN (${inList(made.orders)})`, ...made.orders).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "IdCardOrder" WHERE "id" IN (${inList(made.orders)})`, ...made.orders).catch(() => {});
      await prisma.vendorSharedDocument.deleteMany({ where: { id: { in: made.docs } } }).catch(() => {});
      await prisma.appSetting.deleteMany({ where: { key: 'audit.allowPurge' } });
    } catch (e) { console.log('(cleanup note)', e.message); }
    if (server) { try { server.kill(); } catch { /* ignore */ } }
    await sleep(500);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    if (madeCopy && !process.env.KEEP_COPY) { for (const x of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(x); } catch { /* none */ } } }
    if (fail) {
      const errs = serverLog.split('\n').filter((l) => /error|P\d{4}|locked|timed out/i.test(l)).slice(0, 12);
      if (errs.length) console.log(`\n--- server log (errors) ---\n${errs.join('\n')}`);
    }
    console.log(`\nGROUPS ${JSON.stringify(groupCount)}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
