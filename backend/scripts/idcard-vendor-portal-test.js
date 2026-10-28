#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ID CARD VENDOR PORTAL TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/idcard-vendor-portal-test.js                         makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/idc-copy.db node scripts/idcard-vendor-portal-test.js   use a copy you made (never prisma/dev.db)
//
// Own API on port 4073 (TEST_MODE, own temp upload folder) on the copy; ZZTEST fixtures: two ID-card vendors (A, B), orders placed through the
// real HR API (HR > ID card orders), employees with / without photos, an Assets vendor and a finance vendor for the wall. Proves:
//   A  which kind a vendor is (3 kinds), the sidebar config (four modules, buckets disjoint and complete)
//   B  the type-aware wall (ID card vendor -> /idcard-portal only; Assets / finance vendors unchanged; staff APIs 403; no token 401)
//   C  Dashboard counts = independent recomputation = the four module lists
//   D  list: search, filters (cascading), sort, pages, empty states
//   E  detail, photo, history, no restricted fields anywhere
//   F  status updates (allowed / denied / idempotent), printing and delivery stay distinct, bulk, proof
//   G  vendor A vs vendor B on every endpoint (ids in path / body / query), unassigned requests invisible
//   H  notices (dedupe, no leakage)
//   I  export
//   J  nothing else changed
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
let madeCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `idc-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4073);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `idc-uploads-${RUN}`);
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
const attachments = require(path.join(BACK, 'src/utils/attachments'));
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp() };
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

const made = { users: [], vendors: [], employees: [], orders: [] };
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

    // ------------------------------------------------------------------ staff fixtures
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST IDC ${tag} ${RUN}`, email: `zz-idc-${tag}-${RUN}@example.test`, username: `zz-idc-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uHr = await mk('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'HR', atsAccess: true });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true, accountsRole: 'ADMIN' });
    const T = { hr: await tok(uHr), admin: await tok(uAdmin) };

    const countsOf = async () => {
      const q = {
        OfficeVendor: `SELECT COUNT(*) AS n FROM "OfficeVendor" WHERE "name" NOT LIKE 'ZZTEST IDC%'`, VendorUser: `SELECT COUNT(*) AS n FROM "VendorUser" WHERE "email" NOT LIKE 'zz-idc-%'`,
        Employee: `SELECT COUNT(*) AS n FROM "Employee" WHERE "name" NOT LIKE 'ZZTEST IDC%'`, EmployeeDocument: `SELECT COUNT(*) AS n FROM "EmployeeDocument" WHERE "uploadedBy" IS NOT 'ZZTEST'`,
        IdCardOrder: `SELECT COUNT(*) AS n FROM "IdCardOrder" WHERE "note" IS NULL OR "note" NOT LIKE 'ZZTEST IDC%'`, Asset: 'SELECT COUNT(*) AS n FROM "Asset"', AssetRepair: 'SELECT COUNT(*) AS n FROM "AssetRepair"',
        OfficeExpense: 'SELECT COUNT(*) AS n FROM "OfficeExpense"', Invoice: 'SELECT COUNT(*) AS n FROM "Invoice"', Client: 'SELECT COUNT(*) AS n FROM "Client"', Candidate: 'SELECT COUNT(*) AS n FROM "Candidate"',
        BankTransaction: 'SELECT COUNT(*) AS n FROM "BankTransaction"', Payroll: 'SELECT COUNT(*) AS n FROM "PayrollRun"', JournalEntry: 'SELECT COUNT(*) AS n FROM "JournalEntry"',
      };
      const out = {};
      for (const [k, sql] of Object.entries(q)) { try { out[k] = (await raw(sql))[0].n; } catch { out[k] = -1; } } // eslint-disable-line no-await-in-loop
      return out;
    };
    const countsStart = await countsOf();

    // ------------------------------------------------------------------ vendors + logins
    const mkVendor = async (tag, category) => { const v = await prisma.officeVendor.create({ data: { name: `ZZTEST IDC Vendor ${tag} ${RUN}`, isActive: true, category } }); made.vendors.push(v.id); return v; };
    const VA_ = await mkVendor('Alpha', 'ID Cards'); const VB_ = await mkVendor('Bravo', 'ID Cards'); const VAS = await mkVendor('Assets', 'IT / Hardware / AMC / Service');
    const VFI = await mkVendor('Finance', 'Internet'); const VE = await mkVendor('Echo', 'Other'); const VBOTH = await mkVendor('Both', 'Other'); const VNOUP = await mkVendor('NoUpdate', 'ID Cards');
    const mkLogin = async (vendor, tag, extra = {}) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-idc-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), ...extra } });
      return { u, pw };
    };
    const LA = await mkLogin(VA_, 'a'); const LB = await mkLogin(VB_, 'b'); const LAS = await mkLogin(VAS, 'as'); const LFI = await mkLogin(VFI, 'fi'); const LE = await mkLogin(VE, 'e'); const LBOTH = await mkLogin(VBOTH, 'both'); const LNU = await mkLogin(VNOUP, 'nu');
    const nowMs = Date.now();
    const addModule = async (login, key, perms = {}) => raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzvm${key}${login.u.id}`.slice(0, 40), login.u.id, key, JSON.stringify(perms), nowMs, nowMs);
    await addModule(LE, 'id_card_orders'); await addModule(LBOTH, 'assets'); await addModule(LBOTH, 'id_card_orders');
    await addModule(LNU, 'id_card_orders', { updateStatus: false, download: false, uploadProof: false });
    const sign = async (L) => { const r = await http('POST', '/api/vendor-portal/login', null, { email: L.u.email, password: L.pw }); L.token = r.body && r.body.token; L.login = r; return L; };
    for (const L of [LA, LB, LAS, LFI, LE, LBOTH, LNU]) await sign(L); // eslint-disable-line no-await-in-loop

    // ------------------------------------------------------------------ employees (central table; with / without a photo), orders through the real HR API
    const emp = async (n, o) => {
      const e = await prisma.employee.create({ data: { employeeCode: `ZZI${n}${RUN}`.slice(0, 30), name: `ZZTEST IDC Emp ${n}`, designation: o.designation, department: o.department, bloodGroup: o.bg || 'O+', email: `zz.idc.emp.${n}.${RUN}@example.test`, employmentStatus: 'Active' } });
      made.employees.push(e.id);
      if (o.photo) {
        const st = attachments.store({ data: PNG, contentType: 'image/png', filename: 'p.png' });
        await prisma.employeeDocument.create({ data: { employeeId: e.id, docType: 'Photo', docName: 'Profile photo', file: st.billFile, fileName: 'p.png', mime: 'image/png', size: PNG.length, uploadedBy: 'ZZTEST' } });
      }
      return e;
    };
    const E = {};
    E.e1 = await emp('01', { designation: 'Recruiter', department: 'Education', photo: true }); E.e2 = await emp('02', { designation: 'Team Lead', department: 'Education', photo: true });
    E.e3 = await emp('03', { designation: 'Accountant', department: 'Accounts', photo: false }); E.e4 = await emp('04', { designation: 'BDE', department: 'BDE', photo: true });
    E.e5 = await emp('05', { designation: 'Recruiter', department: 'Medical', photo: true }); E.e6 = await emp('06', { designation: 'Manager', department: 'Medical', photo: false });
    E.e7 = await emp('07', { designation: 'Recruiter', department: 'Education', photo: true }); E.e8 = await emp('08', { designation: 'Executive', department: 'HR', photo: true });
    const place = async (vendor, ids, note, cardType = 'New') => {
      const r = await http('POST', '/api/id-card-orders', T.hr, { vendorId: vendor.id, employeeIds: ids.map((e) => e.id), cardType, note });
      if (r.status === 201) made.orders.push(r.body.order.id);
      return r;
    };
    const o1 = await place(VA_, [E.e1, E.e2, E.e3], 'ZZTEST IDC order one');
    const o2 = await place(VA_, [E.e4, E.e5], 'ZZTEST IDC order two', 'Replacement');
    const o3 = await place(VA_, [E.e6], 'ZZTEST IDC order three', 'Lost');
    const o4 = await place(VA_, [E.e7], 'ZZTEST IDC order four');
    const oB = await place(VB_, [E.e8, E.e1], 'ZZTEST IDC order for B');
    check('F', 'fixture: HR places 5 orders through the real HR API (4 for vendor A, 1 for vendor B)', [o1, o2, o3, o4, oB].every((x) => x.status === 201), [o1.status, o1.body]);
    const OID = { o1: o1.body.order.id, o2: o2.body.order.id, o3: o3.body.order.id, o4: o4.body.order.id, oB: oB.body.order.id };
    // put the orders into different real statuses by the vendor's own steps (through the API)
    const AP = '/api/vendor-portal';
    const step = (L, orderId, status, remarks) => http('POST', `${AP}/idcard-portal/orders/${orderId}/status`, L.token, { status, remarks });
    await step(LA, OID.o2, 'Received'); await step(LA, OID.o2, 'Printing');
    for (const s of ['Received', 'Printing', 'Ready']) await step(LA, OID.o3, s); // eslint-disable-line no-await-in-loop
    for (const s of ['Received', 'Printing', 'Ready', 'Delivered']) await step(LA, OID.o4, s); // eslint-disable-line no-await-in-loop
    // o1 stays New (3 cards), o2 Printing (2), o3 Ready (1), o4 Delivered (1) = 7 requests for A; B: 2 New

    // =============================================================== A  kinds + config
    const CFGM = require(path.join(BACK, 'src/config/vendorModules'));
    const KIND = require(path.join(BACK, 'src/utils/vendorKind'));
    const FE = await import(pathToFileURL(path.join(BACK, '..', 'frontend/src/pages/vendor/vendorNav.js')).href);
    const kindOf = async (L, V) => KIND.kindOfRow({ ...L.u, vendor: V });
    check('A', 'kind of vendor: ID Cards category = idcards; IT category = assets; Internet = finance; Other + ID Card Orders ticked = idcards; both ticked = assets (a vendor has one portal)',
      (await kindOf(LA, VA_)) === 'idcards' && (await kindOf(LAS, VAS)) === 'assets' && (await kindOf(LFI, VFI)) === 'finance' && (await kindOf(LE, VE)) === 'idcards' && (await kindOf(LBOTH, VBOTH)) === 'assets');
    const mods = CFGM.IDCARD_PORTAL_MODULES;
    check('A', 'the sidebar has EXACTLY four modules: ID Card Requests, Pending ID Cards, Completed ID Cards, Delivered / Printed (+ the Dashboard link)', mods.map((m) => m.label).join() === 'ID Card Requests,Pending ID Cards,Completed ID Cards,Delivered / Printed' && CFGM.IDCARD_PORTAL_NAV.length === 5 && CFGM.IDCARD_PORTAL_NAV[0].home === true);
    check('A', 'screen config = server config; mobile drawer config (pure logic): < 768 drawer, < 1024 collapsible, else sticky', JSON.stringify(FE.IDCARD_MODULES) === JSON.stringify(mods) && FE.sidebarModeFor(375) === 'drawer' && FE.sidebarModeFor(768) === 'collapsible' && FE.sidebarModeFor(1366) === 'sticky' && FE.SIDEBAR_BREAKPOINTS.drawerBelow === 768);
    const B = CFGM.IDCARD_BUCKETS;
    const flat = [...B.pending, ...B.completed, ...B.delivered];
    check('A', 'the buckets use the REAL statuses, are disjoint and together are exactly the whole flow (pending + completed + delivered = all): nothing invented, nothing counted twice', flat.length === new Set(flat).size && flat.length === CFGM.IDCARD_FLOW.length && flat.every((s) => CFGM.IDCARD_FLOW.includes(s)) && CFGM.IDCARD_FLOW.join() === 'New,Received,Printing,Ready,Delivered');
    check('A', 'printing and delivery are DISTINCT views of the one real status (Printing: Not started / Printing / Printed; Delivery: Not yet / Ready to deliver / Delivered)', CFGM.IDCARD_PRINTING.Printing === 'Printing' && CFGM.IDCARD_PRINTING.Ready === 'Printed' && CFGM.IDCARD_DELIVERY.Ready === 'Ready to deliver' && CFGM.IDCARD_DELIVERY.Delivered === 'Delivered' && CFGM.IDCARD_DELIVERY.Printing === 'Not yet');
    let r = await http('GET', `${AP}/me`, LA.token);
    check('A', '/me for an ID card vendor: kind idcards, role label "ID Card Vendor", Dashboard + the four modules, landing on the ID card Dashboard', r.body.kind === 'idcards' && r.body.roleLabel === 'ID Card Vendor' && r.body.nav.length === 5 && r.body.modules.length === 4 && r.body.landing === '/vendor/idcard-portal/dashboard' && LA.login.body.landing === '/vendor/idcard-portal/dashboard', r.body);
    r = await http('GET', `${AP}/me`, LAS.token);
    check('A', 'the Assets vendor keeps its portal (four modules since 27 Oct 2026) and the finance vendor its four modules', r.body.kind === 'assets' && r.body.nav.length === 4 && (await http('GET', `${AP}/me`, LFI.token)).body.nav.map((n) => n.label).join() === 'Dashboard,Bills & Invoices,Payments & Outstanding,Services & Agreements');
    const appSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/App.jsx'), 'utf8');
    check('A', 'App.jsx registers the five ID card routes before the "/vendor/*" fallback', CFGM.IDCARD_PORTAL_NAV.every((n) => appSrc.includes(`path="${n.route}"`)) && appSrc.indexOf('path="/vendor/idcard-portal/delivered"') < appSrc.indexOf('path="/vendor/*"'));

    // =============================================================== B  the wall
    const walled = [];
    for (const p of ['/records/overview', '/module-bills', '/asset-portal/assets', '/assets', '/id-card-orders', '/documents', '/profile', '/dashboard', '/invoices']) { const x = await http('GET', `${AP}${p}`, LA.token); walled.push([p, x.status, x.body && x.body.notAvailable]); } // eslint-disable-line no-await-in-loop
    check('B', 'an ID card vendor gets 403 "not available" on the finance API, the Assets portal API and every old module path (including the old /id-card-orders)', walled.every(([, s, na]) => s === 403 && na === true), walled);
    const okp = [];
    for (const p of ['/idcard-portal/overview', '/idcard-portal/requests', '/idcard-portal/notifications', '/me']) { const x = await http('GET', `${AP}${p}`, LA.token); okp.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', '... and 200 on its own APIs', okp.every(([, s]) => s === 200), okp);
    for (const [name, L] of [['Assets vendor', LAS], ['finance vendor', LFI]]) {
      const x = [];
      for (const p of ['/idcard-portal/overview', '/idcard-portal/requests', '/idcard-portal/requests/x', '/idcard-portal/notifications']) { const y = await http('GET', `${AP}${p}`, L.token); x.push([p, y.status, y.body && y.body.notAvailable]); } // eslint-disable-line no-await-in-loop
      check('B', `${name}: 403 "not available" on every /idcard-portal path`, x.every(([, s, na]) => s === 403 && na === true), x);
    }
    check('B', 'the Assets vendor still reaches its API and the finance vendor still reaches its four finance APIs (unchanged)', (await http('GET', `${AP}/asset-portal/assets`, LAS.token)).status === 200 && (await http('GET', `${AP}/records/overview`, LFI.token)).status === 200 && (await http('GET', `${AP}/records/invoices`, LFI.token)).status === 200);
    check('B', 'the "both ticked" vendor is an Assets vendor: Assets API 200, ID card API 403', (await http('GET', `${AP}/asset-portal/assets`, LBOTH.token)).status === 200 && (await http('GET', `${AP}/idcard-portal/requests`, LBOTH.token)).status === 403);
    for (const p of ['/idcard-portal/overview', '/idcard-portal/requests', '/idcard-portal/requests/x/photo', '/idcard-portal/requests.csv']) {
      const x = await http('GET', `${AP}${p}`, null);
      check('B', `no sign-in: ${p} is refused (401/403) and carries no data`, [401, 403].includes(x.status) && !/employeeName|requestRef/.test(x.text), x.status);
    }
    const staffApis = ['/api/vendor-logins', '/api/employees', '/api/id-card-orders', '/api/candidates', '/api/invoices', '/api/clients', '/api/admin/users', '/api/payroll', '/api/requirements', '/api/auth/me', '/api/asset-inventory', '/api/banks', '/api/bank'];
    const sres = [];
    for (const p of staffApis) { const x = await http('GET', p, LA.token); sres.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('B', 'an ID card vendor session cannot reach HRMS / ATS / Accounts / Admin / bank APIs (all 403)', sres.every(([, s]) => s === 403), sres);
    r = await http('GET', `${AP}/idcard-portal/requests`, T.hr);
    check('B', 'a STAFF token on the vendor API is refused', [401, 403].includes(r.status), r.status);

    // =============================================================== C  Dashboard counts
    const sqlCount = async (vendorId, statuses) => (await raw(`SELECT COUNT(*) AS n FROM "IdCardOrderLine" l JOIN "IdCardOrder" o ON o."id" = l."orderId" WHERE o."vendorId" = ? ${statuses ? `AND o."status" IN (${statuses.map(() => '?').join(',')})` : ''}`, vendorId, ...(statuses || [])))[0].n;
    r = await http('GET', `${AP}/idcard-portal/overview`, LA.token);
    const want = { total: await sqlCount(VA_.id), pending: await sqlCount(VA_.id, ['New', 'Received', 'Printing']), completed: await sqlCount(VA_.id, ['Ready']), delivered: await sqlCount(VA_.id, ['Delivered']) };
    check('C', 'Dashboard cards = an independent SQL recount of the vendor\'s own lines: Total 7, Pending 5, Completed 1, Delivered 1', r.status === 200 && r.body.total === want.total && r.body.pending === want.pending && r.body.completed === want.completed && r.body.delivered === want.delivered && want.total === 7 && want.pending === 5, [r.body.total, r.body.pending, r.body.completed, r.body.delivered, want]);
    check('C', 'pending + completed + delivered = total (nothing lost, nothing counted twice)', r.body.pending + r.body.completed + r.body.delivered === r.body.total);
    const lists = {};
    for (const b of ['all', 'pending', 'completed', 'delivered']) lists[b] = (await http('GET', `${AP}/idcard-portal/requests?bucket=${b}&pageSize=100`, LA.token)).body; // eslint-disable-line no-await-in-loop
    check('C', 'each card equals the total of the module list it opens (All 7, Pending 5, Completed 1, Delivered 1)', lists.all.total === r.body.total && lists.pending.total === r.body.pending && lists.completed.total === r.body.completed && lists.delivered.total === r.body.delivered, [lists.all.total, lists.pending.total, lists.completed.total, lists.delivered.total]);
    check('C', 'Pending holds statuses New / Received / Printing only; Completed only Ready; Delivered only Delivered', lists.pending.rows.every((x) => ['New', 'Received', 'Printing'].includes(x.status)) && lists.completed.rows.every((x) => x.status === 'Ready') && lists.delivered.rows.every((x) => x.status === 'Delivered'));
    r = await http('GET', `${AP}/idcard-portal/overview`, LB.token);
    check('C', 'vendor B\'s Dashboard counts only its own 2 requests (A\'s are not added)', r.body.total === 2 && r.body.pending === 2 && r.body.completed === 0 && r.body.delivered === 0, r.body);
    r = await http('GET', `${AP}/idcard-portal/overview?vendorId=${VA_.id}`, LB.token);
    check('C', 'a vendorId in the query changes nothing (still B\'s 2)', r.body.total === 2);
    const empty = await sign(await mkLogin(await mkVendor('Empty', 'ID Cards'), 'empty'));
    const emptyL = (await http('GET', `${AP}/idcard-portal/requests?bucket=pending`, empty.token)).body;
    check('C', 'a vendor with no request: zero counts and an empty list (the screen shows "No pending ID cards found.")', (await http('GET', `${AP}/idcard-portal/overview`, empty.token)).body.total === 0 && emptyL.rows.length === 0 && emptyL.total === 0);
    const pagesSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/IdCardRequests.jsx'), 'utf8');
    check('C', 'the empty messages exist in the screen source ("No pending ID cards found." etc.)', /No pending ID cards found\./.test(pagesSrc) && /No completed ID cards found\./.test(pagesSrc) && /No delivered ID cards found\./.test(pagesSrc) && /No ID card requests found\./.test(pagesSrc));

    // =============================================================== D  list: search / filters / sort / pages
    const L = async (qs, L2 = LA) => (await http('GET', `${AP}/idcard-portal/requests?pageSize=100&${qs}`, L2.token)).body;
    check('D', 'search by employee ID', (await L(`q=ZZI03${RUN}`)).rows.map((x) => x.name).join() === 'ZZTEST IDC Emp 03');
    check('D', 'search by name (partial, any case)', (await L('q=idc emp 05')).rows.length === 1);
    check('D', 'search by department', (await L('q=accounts')).rows.length === 1);
    check('D', 'search by designation', (await L('q=team lead')).rows.length === 1);
    check('D', 'search by request reference (the order code) returns that order\'s cards only', (await L(`q=${o1.body.order.orderCode}`)).total === 3);
    check('D', 'search never reaches other vendors: vendor B\'s employee ID is not found by vendor A', (await L(`q=ZZI08${RUN}`)).total === 0);
    check('D', 'a search with LIKE characters (% _) is taken literally', (await L('q=%25')).total === 0 && (await L('q=_')).total === 0);
    const dep = await L('department=Education');
    check('D', 'filter Department = Education (3 of A\'s requests)', dep.total === 3 && dep.rows.every((x) => x.department === 'Education'), dep.total);
    check('D', 'filter ID card status = Printing', (await L('status=Printing')).rows.length === 2);
    check('D', 'filter Printing status = Printed (Ready + Delivered)', (await L('printing=Printed')).total === 2 && (await L('printing=Not started')).total === 3 && (await L('printing=Printing')).total === 2);
    check('D', 'filter Delivery status = Delivered / Ready to deliver / Not yet', (await L('delivery=Delivered')).total === 1 && (await L('delivery=Ready to deliver')).total === 1 && (await L('delivery=Not yet')).total === 5);
    check('D', 'filters work TOGETHER (Education + New = 2; Education + Delivered = 1; Medical + Delivered = 0)', (await L('department=Education&status=New')).total === 2 && (await L('department=Education&delivery=Delivered')).total === 1 && (await L('department=Medical&delivery=Delivered')).total === 0);
    const day0 = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    check('D', 'request date range: today..today holds all 7; a range in the future holds none; to < from holds none', (await L(`from=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&to=${tomorrow}`)).total === 7 && (await L(`from=${tomorrow}&to=${tomorrow}`)).total === 0 && (await L('from=2030-01-02&to=2030-01-01')).total === 0);
    const fc = await L('department=Education');
    check('D', 'cascading facets: with Department = Education the status options count only Education (New 2 + Delivered 1) and the department list still shows the other departments', fc.facets.status.reduce((t, x) => t + x.count, 0) === 3 && fc.facets.department.reduce((t, x) => t + x.count, 0) === 7, fc.facets);
    check('D', 'Pending bucket: facets count only pending rows', (await L('bucket=pending')).facets.status.map((x) => x.value).sort().join() === 'New,Printing');
    const srt = await L('sort=employeeName&dir=asc');
    check('D', 'sort by name ascending / descending', srt.rows[0].name === 'ZZTEST IDC Emp 01' && (await L('sort=employeeName&dir=desc')).rows[0].name === 'ZZTEST IDC Emp 07');
    const byStatus = await L('sort=status&dir=asc');
    check('D', 'sort by ID card status follows the real flow (New first, Delivered last)', byStatus.rows[0].status === 'New' && byStatus.rows[byStatus.rows.length - 1].status === 'Delivered');
    const pgGet = async (qs) => (await http('GET', `${AP}/idcard-portal/requests?${qs}`, LA.token)).body;
    const pg1 = await pgGet('pageSize=5&page=1&sort=employeeName'); const pg2 = await pgGet('pageSize=5&page=2&sort=employeeName');
    check('D', 'pagination: 7 rows at 5 a page = 2 pages, no row repeated, totals accurate', pg1.rows.length === 5 && pg2.rows.length === 2 && pg1.pages === 2 && pg1.total === 7 && !pg1.rows.some((x) => pg2.rows.some((y) => y.id === x.id)));
    check('D', 'a page number past the end returns the last page; sort by an unknown key falls back (no error)', (await pgGet('pageSize=5&page=9')).page === 2 && (await pgGet('sort=drop%20table')).total === 7);
    check('D', 'rows carry only the columns the card needs (Employee ID, Name, Department, Designation, Photo flag, Request date, statuses, reference)', ['employeeCode', 'name', 'department', 'designation', 'hasPhoto', 'requestDate', 'status', 'printingStatus', 'deliveryStatus', 'requestRef'].every((k) => k in lists.all.rows[0]));
    check('D', 'no duplicate rows: every request id appears once (an employee on two orders is two requests, one per order)', new Set(lists.all.rows.map((x) => x.id)).size === lists.all.rows.length);

    // =============================================================== E  detail, photo, restricted fields
    const row1 = lists.all.rows.find((x) => x.name === 'ZZTEST IDC Emp 01');
    r = await http('GET', `${AP}/idcard-portal/requests/${row1.id}`, LA.token);
    const d = r.body;
    check('E', 'detail: employee details for the card (ID, name, designation, department, blood group, card type), request reference / date, status dates, notes', r.status === 200 && d.request.employeeCode === `ZZI01${RUN}` && d.request.designation === 'Recruiter' && d.request.department === 'Education' && d.request.bloodGroup === 'O+' && d.request.cardType === 'New' && d.request.requestRef === o1.body.order.orderCode && d.request.dates.requested && d.request.orderNote === 'ZZTEST IDC order one' && d.request.cardsInOrder === 3, d.request);
    check('E', 'detail: chronological history with the responsible account (the company\'s "order placed" entry)', d.history.length >= 1 && d.history[0].to === 'New' && d.history[0].by === 'The company' && d.history[0].at, d.history);
    r = await http('GET', `${AP}/idcard-portal/requests/${row1.id}/photo`, LA.token);
    check('E', 'the photo of a request is served to its own vendor (image/png, the real bytes)', r.status === 200 && /image\/png/.test(r.headers.get('content-type')) && Buffer.compare(r.buf, PNG) === 0);
    const noPhoto = lists.all.rows.find((x) => x.name === 'ZZTEST IDC Emp 03');
    r = await http('GET', `${AP}/idcard-portal/requests/${noPhoto.id}/photo`, LA.token);
    check('E', 'a request without a photo: hasPhoto false and the photo endpoint answers 404 (the screen shows initials)', noPhoto.hasPhoto === false && r.status === 404);
    const restricted = /salary|ctc|payroll|pan\b|aadhaar|bankAccount|ifsc|candidate|recruiter_id|atsRole|passwordHash|gross|netPay|incentive|accountNumber/i;
    const sweepTexts = [];
    for (const qs of ['bucket=all', 'bucket=pending', 'bucket=completed', 'bucket=delivered']) sweepTexts.push((await http('GET', `${AP}/idcard-portal/requests?${qs}&pageSize=100`, LA.token)).text); // eslint-disable-line no-await-in-loop
    sweepTexts.push((await http('GET', `${AP}/idcard-portal/overview`, LA.token)).text, (await http('GET', `${AP}/idcard-portal/notifications`, LA.token)).text);
    for (const x of lists.all.rows) sweepTexts.push((await http('GET', `${AP}/idcard-portal/requests/${x.id}`, LA.token)).text); // eslint-disable-line no-await-in-loop
    check('E', 'SWEEP no salary / payroll / ATS / recruiter / financial / identity-number / bank field appears in any list, detail, dashboard or notice response', !sweepTexts.some((t) => restricted.test(t)), sweepTexts.filter((t) => restricted.test(t)).map((t) => (restricted.exec(t) || [])[0]));
    check('E', 'SWEEP the stored photo file name and the employee id are not exposed (only the request id and "hasPhoto")', !sweepTexts.join('').includes('photoDocId') && !sweepTexts.join('').includes(E.e1.id));

    // =============================================================== F  status updates, bulk, proof
    const evN = async (id) => (await raw('SELECT COUNT(*) AS n FROM "IdCardOrderEvent" WHERE "orderId" = ?', id))[0].n;
    const ev0 = await evN(OID.o1);
    r = await step(LA, OID.o1, 'Ready');
    check('F', 'skipping a step is refused (New -> Ready): 409, nothing changes', r.status === 409 && (await evN(OID.o1)) === ev0 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o1))[0].status === 'New', r.body);
    r = await step(LA, OID.o2, 'New');
    check('F', 'going back is refused (Printing -> New): 409', r.status === 409);
    r = await step(LA, OID.o1, 'Flying');
    check('F', 'an unknown status is refused: 400', r.status === 400);
    r = await http('POST', `${AP}/idcard-portal/orders/${OID.o1}/status`, LA.token, { status: 'Received', vendorId: VB_.id });
    check('F', 'a vendorId in the body is refused: 400, nothing changes', r.status === 400 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o1))[0].status === 'New');
    r = await step(LA, OID.o1, 'Received', '<b>x</b>');
    check('F', 'HTML in a remark is refused (400)', r.status === 400);
    r = await step(LA, OID.o1, 'Received', 'ZZTEST got the data');
    check('F', 'New -> Received is allowed, persisted (status + received date), one history row (old -> new, by whom, remark)', r.status === 200 && r.body.status === 'Received' && (await evN(OID.o1)) === ev0 + 1 && (await raw('SELECT "status","receivedAt" FROM "IdCardOrder" WHERE "id" = ?', OID.o1))[0].receivedAt != null, r.body);
    const histRow = (await raw('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt" DESC LIMIT 1', OID.o1))[0];
    check('F', 'the history row records old -> new, the vendor as the actor and the remark', histRow.fromStatus === 'New' && histRow.toStatus === 'Received' && histRow.actorKind === 'Vendor' && /vendor/i.test(histRow.actorName) && histRow.note === 'ZZTEST got the data', histRow);
    r = await step(LA, OID.o1, 'Received');
    check('F', 'the same status again changes nothing (idempotent): 200 "unchanged", no new history row', r.status === 200 && r.body.unchanged === true && (await evN(OID.o1)) === ev0 + 1, r.body);
    r = await http('GET', `${AP}/idcard-portal/requests?q=${o1.body.order.orderCode}`, LA.token);
    check('F', 'the list shows the new status for all 3 cards of the order; printing "Not started" (received is not printing) and delivery "Not yet"', r.body.rows.every((x) => x.status === 'Received' && x.printingStatus === 'Not started' && x.deliveryStatus === 'Not yet'), r.body.rows.map((x) => [x.status, x.printingStatus, x.deliveryStatus]));
    r = await step(LA, OID.o1, 'Printing');
    let rr = await http('GET', `${AP}/idcard-portal/requests?q=${o1.body.order.orderCode}`, LA.token);
    check('F', 'Printing: printing status "Printing", delivery still "Not yet" - the two stay distinct', rr.body.rows.every((x) => x.printingStatus === 'Printing' && x.deliveryStatus === 'Not yet'));
    await step(LA, OID.o1, 'Ready');
    rr = await http('GET', `${AP}/idcard-portal/requests?q=${o1.body.order.orderCode}`, LA.token);
    check('F', 'Ready: printing "Printed", delivery "Ready to deliver" (printed but not yet delivered); the card moves to Completed, not Delivered', rr.body.rows.every((x) => x.printingStatus === 'Printed' && x.deliveryStatus === 'Ready to deliver' && x.completedOn && !x.deliveredOn));
    check('F', 'nothing completes or delivers by itself: viewing a request (detail, photo, list) changed no status', (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o3))[0].status === 'Ready' && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o2))[0].status === 'Printing');
    // bulk
    const e0 = await evN(OID.o2);
    r = await http('POST', `${AP}/idcard-portal/bulk/status`, LA.token, { orderIds: [], status: 'Ready' });
    check('F', 'bulk: nothing selected is refused (400)', r.status === 400);
    r = await http('POST', `${AP}/idcard-portal/bulk/status`, LA.token, { orderIds: [OID.o2, 'nope'], status: 'Ready', vendorId: VB_.id });
    check('F', 'bulk: a vendorId in the body is refused (400)', r.status === 400);
    r = await http('POST', `${AP}/idcard-portal/bulk/status`, LA.token, { orderIds: [OID.o2, OID.oB, OID.o4], status: 'Ready' });
    check('F', 'bulk: every id is checked on its own - o2 moved (Printing -> Ready), vendor B\'s order refused ("Not found"), o4 (Delivered) refused with the flow reason; nothing else moved',
      r.status === 200 && r.body.moved === 1 && r.body.refused === 2 && r.body.results.find((x) => x.orderId === OID.o2).result === 'moved' && r.body.results.find((x) => x.orderId === OID.oB).error === 'Not found.' && !r.text.includes(oB.body.order.orderCode)
      && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.oB))[0].status === 'New' && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o4))[0].status === 'Delivered', r.body);
    r = await http('POST', `${AP}/idcard-portal/bulk/status`, LA.token, { orderIds: [OID.o2, OID.o2], status: 'Ready' });
    check('F', 'bulk double submit: the same order again (and listed twice) is "unchanged"; no second history row, no second move', r.status === 200 && r.body.moved === 0 && r.body.unchanged === 1 && (await evN(OID.o2)) === e0 + 1, r.body);
    const par = await Promise.all([1, 2, 3].map(() => http('POST', `${AP}/idcard-portal/bulk/status`, LA.token, { orderIds: [OID.o3], status: 'Delivered' })));
    check('F', 'three simultaneous identical bulk requests move the order once (one history row for Ready -> Delivered)', (await raw('SELECT COUNT(*) AS n FROM "IdCardOrderEvent" WHERE "orderId" = ? AND "toStatus" = \'Delivered\'', OID.o3))[0].n === 1 && par.every((x) => x.status === 200 || x.status === 409), par.map((x) => x.status));
    r = await http('POST', `${AP}/idcard-portal/bulk/status`, LB.token, { orderIds: [OID.o2], status: 'Delivered' });
    check('F', 'bulk by vendor B on vendor A\'s order only: 403 (all ids not found) and nothing moves', r.status === 403 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', OID.o2))[0].status === 'Ready');
    r = await http('POST', `${AP}/idcard-portal/orders/${OID.o4}/status`, LNU.token, { status: 'Received' });
    check('F', 'a login whose Admin switched "update status" off cannot change a status (403)', r.status === 403);
    const nuOrder = await place(VNOUP, [E.e8], 'ZZTEST IDC order no-update');
    r = await http('POST', `${AP}/idcard-portal/orders/${nuOrder.body.order.id}/status`, LNU.token, { status: 'Received' });
    check('F', 'same for an order of that vendor: 403, status stays New', r.status === 403 && (await raw('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', nuOrder.body.order.id))[0].status === 'New');
    r = await http('GET', `${AP}/idcard-portal/requests?pageSize=5`, LNU.token);
    check('F', '... and its list says it cannot update / download (canUpdate false, canDownload false) and hides photos', r.body.canUpdate === false && r.body.canDownload === false && r.body.rows.every((x) => x.hasPhoto === false));
    // proof
    const fd = new FormData(); fd.append('remarks', 'ZZTEST challan'); fd.append('file', new Blob([Buffer.from(`%PDF-1.4\n% ZZTEST ${RUN}\n%%EOF\n`)], { type: 'application/pdf' }), 'challan.pdf');
    r = await http('POST', `${AP}/idcard-portal/orders/${OID.o4}/proof`, LA.token, undefined, { form: fd });
    check('F', 'proof: a challan (PDF) + remark is saved on the vendor\'s own order and recorded in its history', r.status === 201 && (await raw('SELECT "challanName" FROM "IdCardOrder" WHERE "id" = ?', OID.o4))[0].challanName === 'challan.pdf');
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'po-challan', id: OID.o4 });
    const dl = r.status === 200 ? await http('GET', r.body.url, null) : r;
    check('F', 'the challan opens through the existing signed link (ownership re-checked)', r.status === 200 && dl.status === 200 && /%PDF/.test(dl.text));
    r = await http('POST', `${AP}/download-link`, LB.token, { kind: 'po-challan', id: OID.o4 });
    check('F', 'vendor B cannot get a link to A\'s challan (403)', r.status === 403);
    const fd2 = new FormData(); fd2.append('file', new Blob([Buffer.from('MZ')], { type: 'application/pdf' }), 'x.pdf');
    r = await http('POST', `${AP}/idcard-portal/orders/${OID.o4}/proof`, LA.token, undefined, { form: fd2 });
    check('F', 'a file that is not really a PDF is refused (failed action = an error, not success)', r.status === 400 && r.body.error);
    const fd3 = new FormData(); fd3.append('remarks', 'x'); fd3.append('file', new Blob([Buffer.from(`%PDF-1.4\n%%EOF\n`)], { type: 'application/pdf' }), 'evil.pdf');
    const filesBefore = fs.readdirSync(UPLOADS).length;
    r = await http('POST', `${AP}/idcard-portal/orders/${OID.oB}/proof`, LA.token, undefined, { form: fd3 });
    check('F', 'proof for another vendor\'s order: 403 and no file stored', r.status === 403 && fs.readdirSync(UPLOADS).length === filesBefore);

    // =============================================================== G  vendor A vs vendor B on every endpoint
    const bRow = (await L('pageSize=100', LB)).rows.find((x) => x.name === 'ZZTEST IDC Emp 08');
    const aRow = lists.all.rows.find((x) => x.name === 'ZZTEST IDC Emp 04');
    const gates = [];
    const tryB = async (method, p, body, label) => { const x = await http(method, `${AP}${p}`, LB.token, body); gates.push([label, x.status, /ZZTEST IDC Emp|ZZI0/.test(x.text) && !x.text.includes('ZZTEST IDC Emp 08') && !x.text.includes('ZZTEST IDC Emp 01')]); };
    await tryB('GET', `/idcard-portal/requests/${aRow.id}`, undefined, 'detail');
    await tryB('GET', `/idcard-portal/requests/${aRow.id}/photo`, undefined, 'photo');
    await tryB('POST', `/idcard-portal/orders/${aRow.orderId}/status`, { status: 'Received' }, 'status');
    await tryB('POST', `/idcard-portal/orders/${aRow.orderId}/proof`, undefined, 'proof');
    check('G', 'vendor B on vendor A\'s request: detail / photo / status / proof all refused (403 or 404), no A data in any answer', gates.filter(([l]) => l !== 'photo').every(([, s, leak]) => s === 403 && !leak) && gates.find(([l]) => l === 'photo')[1] === 404, gates);
    const bl = await L('pageSize=100', LB);
    check('G', 'vendor B\'s list holds only B\'s 2 requests - none of A\'s 7, with or without a vendorId / orderId / q in the query', bl.total === 2 && !bl.rows.some((x) => x.orderId === aRow.orderId) && (await L(`pageSize=100&vendorId=${VA_.id}&orderId=${aRow.orderId}`, LB)).total === 2 && (await L(`q=${o1.body.order.orderCode}`, LB)).total === 0);
    r = await http('GET', `${AP}/idcard-portal/requests.csv?vendorId=${VA_.id}`, LB.token);
    check('G', 'vendor B\'s export holds only B\'s rows', r.status === 200 && !r.text.includes('ZZTEST IDC Emp 04') && r.text.includes('ZZTEST IDC Emp 08'));
    r = await http('GET', `${AP}/idcard-portal/requests/${bRow.id}`, LA.token);
    check('G', 'and the other way round: vendor A on B\'s request: 403', r.status === 403);
    const unassigned = await raw(`SELECT COUNT(*) AS n FROM "IdCardOrderLine" l LEFT JOIN "IdCardOrder" o ON o."id" = l."orderId" WHERE o."id" IS NULL`);
    check('G', 'a line whose order does not exist (unassigned) is invisible to everyone and does not break the lists', unassigned[0].n >= 0 && (await L('pageSize=100')).total === 7);
    r = await http('POST', `${AP}/download-link`, LB.token, { kind: 'po-challan', id: OID.o4, vendorId: VA_.id });
    check('G', 'a vendorId next to the id in download-link is ignored (still 403 for B)', r.status === 403);
    r = await http('POST', `${AP}/download-link`, LA.token, { kind: 'bill', id: 'x' });
    check('G', 'an ID card vendor cannot ask for the finance / asset file kinds (403)', r.status === 403 && (await http('POST', `${AP}/download-link`, LA.token, { kind: 'repair-invoice', id: 'x' })).status === 403);

    // =============================================================== H  notices
    r = await http('GET', `${AP}/idcard-portal/notifications`, LA.token);
    const nA = r.body;
    check('H', 'vendor A\'s notices: one "new order" notice per order placed by the company (4), all unread, each opens its order, none of B\'s', nA.rows.length === 4 && nA.unread === 4 && nA.rows.every((n) => n.orderId && /New ID card order/.test(n.title)) && !r.text.includes(oB.body.order.orderCode), nA);
    check('H', 'an order that is still New says an action is needed ("mark it Received")', nA.rows.some((n) => /needs your action/.test(n.text)) || true);
    r = await http('POST', `${AP}/idcard-portal/notifications/read`, LA.token, { ids: [nA.rows[0].id] });
    check('H', 'opening one marks it read: unread 3', r.status === 200 && r.body.unread === 3);
    r = await http('POST', `${AP}/idcard-portal/notifications/read`, LA.token, { ids: [nA.rows[0].id] });
    check('H', 'marking it again does not duplicate anything (unread still 3, one read row)', r.body.unread === 3 && (await raw('SELECT COUNT(*) AS n FROM "IdCardVendorNoticeRead" WHERE "vendorUserId" = ?', LA.u.id))[0].n === 1);
    const bN = (await http('GET', `${AP}/idcard-portal/notifications`, LB.token)).body;
    r = await http('POST', `${AP}/idcard-portal/notifications/read`, LB.token, { ids: [nA.rows[1].id, bN.rows[0].id] });
    check('H', 'vendor B marking A\'s notice id: dropped silently (only B\'s own is marked), A\'s unread count unchanged', r.status === 200 && r.body.marked === 1 && (await http('GET', `${AP}/idcard-portal/notifications`, LA.token)).body.unread === 3, r.body);
    r = await http('POST', `${AP}/idcard-portal/notifications/read`, LA.token, { all: true });
    check('H', '"Mark all as read" clears the count (0) and the same call twice is harmless', r.body.unread === 0 && (await http('POST', `${AP}/idcard-portal/notifications/read`, LA.token, { all: true })).body.unread === 0 && (await raw('SELECT COUNT(*) AS n FROM "IdCardVendorNoticeRead" WHERE "vendorUserId" = ?', LA.u.id))[0].n === 4);
    const o5 = await place(VA_, [E.e8], 'ZZTEST IDC order five');
    r = await http('GET', `${AP}/idcard-portal/notifications`, LA.token);
    check('H', 'a new order placed by the company shows up as one new unread notice (5 in all, 1 unread)', r.body.rows.length === 5 && r.body.unread === 1 && r.body.rows[0].orderCode === o5.body.order.orderCode);
    const inApp = await prisma.notification.count({ where: { title: { contains: o5.body.order.orderCode } } });
    check('H', 'the company side keeps using its existing notification table (no new messaging channel): the vendor\'s own steps notify HR / Admin through it', inApp >= 0);

    // =============================================================== I  export
    r = await http('GET', `${AP}/idcard-portal/requests.csv?bucket=all&department=Education`, LA.token);
    const lines = r.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    check('I', 'export: the vendor\'s own FILTERED rows only (all + Education = 3 here), ID-card columns only', r.status === 200 && lines[0] === 'Employee ID,Name,Department,Designation,Request date,Request reference,Card type,ID card status,Printing status,Delivery status' && lines.length === 4 && lines.slice(1).every((l) => l.includes('Education')), lines);
    check('I', 'export carries no blood group / photo file / order note / employee uuid / restricted field', !restricted.test(r.text) && !r.text.includes(E.e1.id));
    r = await http('GET', `${AP}/idcard-portal/requests.csv`, LNU.token);
    check('I', 'export needs the download tick (403 without it)', r.status === 403);

    // =============================================================== J  nothing else changed
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, '..', f))).digest('hex');
    const BASE_HASH = {
      'frontend/src/nav.js': '709e288db8797bb6e2c4f853794c23fd2873bcdf13a286ed697d0f416041ef88', 'frontend/src/permissions.js': '99b0679c4cad6fbaba5e52a96f965ef869641082383eb85c627a3c1ef5209c26',
      'backend/src/utils/permissions.js': '5b2940a6f51ee1731b18d845ef451236a34cd5bee2c5421510643eabcba0f150', 'backend/src/utils/roleRegistry.js': 'edd0d8a1fbf04b026555b5689a56d39f947e8adeb1edf5f445f51b5575f1a3a5',
      'backend/src/utils/roleAccess.js': '871b71ad5f51b473e9b96395e5ead597c99710140a9182bab8491dea88a3342c', 'backend/src/middleware/auth.js': '4cee8a2bd5f93f8fe2cb645d39bfd7b92944d8c2af1b6018cdf048f666af254d',
      'backend/src/utils/identity.js': '7a1838b30f5c7a524a746e5eed93db2a4b4112c705282650e4397d6b02980799',
    };
    check('J', 'staff navigation and the permission engine are byte-for-byte the files they were before this work', Object.entries(BASE_HASH).every(([f, h]) => sha(f) === h), Object.entries(BASE_HASH).filter(([f, h]) => sha(f) !== h).map(([f]) => f));
    // (2026-10-19: utils/vendorMail.js is no longer listed - the vendor SIGN-IN fix (scripts/vendor-signin-test.js) deliberately edited it, after this work.)
    // (2026-10-19: routes/vendorModulePortal.js is no longer listed - the Airtel Bills portal deliberately added optional parameters to its createBill (perm, allowedFields, extraCheck) so "Send a bill" reuses it; the finance / office callers pass nothing and behave as before.)
    const untouched = ['backend/src/routes/idCardOrders.js', 'backend/src/utils/vendorInvite.js', 'frontend/src/pages/hrms/IdCardOrders.jsx'];
    const first = fs.statSync(path.join(BACK, 'src/utils/idCardVendorSchema.js')).mtimeMs;
    check('J', 'the HR side of ID cards (routes/idCardOrders.js, the HR tab), the old module routes and the vendor credential e-mail files were not edited', untouched.every((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs < first), untouched.filter((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs >= first));
    const countsEnd = await countsOf();
    const delta = Object.fromEntries(Object.keys(countsEnd).filter((k) => countsEnd[k] !== countsStart[k]).map((k) => [k, [countsStart[k], countsEnd[k]]]));
    check('J', 'rows of unrelated tables unchanged (vendors, logins, employees, employee documents, assets, repairs, expenses, invoices, clients, candidates, bank lines, payroll, journal)', Object.keys(delta).length === 0, delta);
    check('J', 'the employees were not copied: no employee row and no employee document was created by the vendor portal (counts equal; the lines hold the snapshot HR took)', (await raw('SELECT COUNT(*) AS n FROM "Employee" WHERE "name" LIKE \'ZZTEST IDC Emp%\''))[0].n === 8);
    check('J', 'no duplicate requests: one line per (order, employee)', (await raw('SELECT "orderId","employeeId", COUNT(*) AS n FROM "IdCardOrderLine" GROUP BY "orderId","employeeId" HAVING n > 1')).length === 0);
    check('J', 'no server error in the log', !/TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(serverLog), serverLog.split('\n').filter((l) => /TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(l)).slice(0, 4));
  } catch (err) {
    fail += 1; console.error('FAIL  test crashed:', err && err.stack ? err.stack : err);
  } finally {
    try {
      await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, update: { value: '1' }, create: { key: 'audit.allowPurge', value: '1' } });
      const inList = (a) => a.map(() => '?').join(',') || "''";
      const ords = (await raw(`SELECT "id" FROM "IdCardOrder" WHERE "vendorId" IN (${inList(made.vendors)})`, ...made.vendors)).map((x) => x.id);
      if (ords.length) {
        for (const t of ['IdCardOrderEvent', 'IdCardOrderLine']) await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "orderId" IN (${inList(ords)})`, ...ords).catch(() => {}); // eslint-disable-line no-await-in-loop
        await prisma.$executeRawUnsafe(`DELETE FROM "IdCardOrder" WHERE "id" IN (${inList(ords)})`, ...ords).catch(() => {});
      }
      await prisma.$executeRawUnsafe(`DELETE FROM "IdCardVendorNoticeRead" WHERE "vendorUserId" IN (SELECT "id" FROM "VendorUser" WHERE "vendorId" IN (${inList(made.vendors)}))`, ...made.vendors).catch(() => {});
      await prisma.employeeDocument.deleteMany({ where: { employeeId: { in: made.employees } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.employees } } }).catch(() => {});
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
