#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AIRTEL BILLS PORTAL TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/airtel-bills-portal-test.js                          makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/abp-copy.db node scripts/airtel-bills-portal-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4083, TEST_MODE: fake mail transport, no timers, own temp upload folder) on the copy, builds ZZTEST fixtures there
// (staff users, vendors, vendor logins signed in through the real /api/vendor-portal/login, Airtel bills booked through the real Accounts API,
// bank statements imported through the real /api/bank/import, matched through the real /api/bank/:id/match-bills and the auto-reconcile API)
// and proves, with the REAL Airtel data of the copy as well as ZZTEST fixtures:
//   A  pure logic: the menu (exactly Bills, Monthly History, SIMs), who is a telecom vendor, the wall, masking, status words, seat departments
//   B  /me + the wall on the server: telecom vendor -> /airtel-portal only; every other kind and staff API refused; other kinds cannot enter
//   R  the REAL data of the copy: the real Airtel bills and SIMs as they are in the database (counts recomputed independently), "Not recorded"
//   S  SIMs: read only, the same SIM assets (no duplicates), masked numbers, department only, filters
//   P  payment flow: bill recorded -> Pending -> Accounts pays -> statement imported -> matched -> Paid with the verified date; unmatched; partial; reversed
//   D  duplicate statement import: no second line / bill / payment, status unchanged;   O  overdue and due soon, one alert per bill
//   M  monthly history = an independent recomputation; gap months; totals only for bills linked in Accounts
//   X  send a bill: duplicate rules (invoice number, month + amount, Accounts), no second expense, folded into the Accounts bill
//   Z  security: a vendor cannot set a status, other vendors' bills (IDOR), response sweep (full numbers, bank account, narration, bank ids)
//   I  nothing else changed: Accounts rows untouched by reading, staff navigation byte-for-byte, no new table, row counts
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const FE = path.resolve(BACK, '..', 'frontend');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
let madeCopy = false;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `abp-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4083);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `abp-uploads-${RUN}`);
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
const CFG = require(path.join(BACK, 'src/config/vendorModules'));
const ATB = require(path.join(BACK, 'src/utils/airtelBillsPortal'));
const AP = require(path.join(BACK, 'src/utils/airtelBillPayments'));
const ACC = require(path.join(BACK, 'src/utils/accounts'));
const KIND = require(path.join(BACK, 'src/utils/vendorKind'));

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
  if (opt.form) payload = opt.form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
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
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = ACC.istDay();
const ymOf = (iso) => iso.slice(0, 7);
const rs2 = (n) => Math.round(n * 100) / 100;
const ymOfStr = (d) => String(d).slice(0, 7);

const made = { users: [], vendors: [], vusers: [], expenses: [], banks: [], assets: [], modbills: [], conns: [] };
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

    // ================================================================== staff fixtures (the copy only)
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ABP ${tag} ${RUN}`, email: `zz-abp-${tag}-${RUN}@example.test`, username: `zz-abp-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true, accountsRole: 'ADMIN' });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uHr = await mk('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'HR', atsAccess: true });
    const T = { admin: await tok(uAdmin), rec: await tok(uRec), hr: await tok(uHr) };

    // ================================================================== counts of things this work must not change
    const cnt = async () => {
      const q = {
        OfficeVendor: `SELECT COUNT(*) AS n FROM "OfficeVendor" WHERE "name" NOT LIKE 'ZZTEST ABP%'`, VendorUser: `SELECT COUNT(*) AS n FROM "VendorUser" WHERE "email" NOT LIKE 'zz-abp-%'`,
        OfficeExpense: `SELECT COUNT(*) AS n FROM "OfficeExpense" WHERE COALESCE("vendor",'') NOT LIKE 'ZZTEST ABP%'`, VendorBillSubmission: 'SELECT COUNT(*) AS n FROM "VendorBillSubmission"', VendorModuleBill: `SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "billNumber" NOT LIKE 'ZZABP%'`,
        Asset: `SELECT COUNT(*) AS n FROM "Asset" WHERE "assetCode" NOT LIKE 'ZZABP-%'`, SimConnection: `SELECT COUNT(*) AS n FROM "SimConnection" WHERE "mobileNumber" NOT LIKE '9000%'`, SimRequest: 'SELECT COUNT(*) AS n FROM "SimRequest"',
        Invoice: 'SELECT COUNT(*) AS n FROM "Invoice"', Client: 'SELECT COUNT(*) AS n FROM "Client"', Employee: 'SELECT COUNT(*) AS n FROM "Employee"', Candidate: 'SELECT COUNT(*) AS n FROM "Candidate"',
        BankTransaction: `SELECT COUNT(*) AS n FROM "BankTransaction" WHERE COALESCE("bankAccountId",'') NOT IN (SELECT "id" FROM "BankAccount" WHERE "bank" LIKE 'ZZTEST ABP%')`, BankAccount: `SELECT COUNT(*) AS n FROM "BankAccount" WHERE COALESCE("bank",'') NOT LIKE 'ZZTEST%'`, Payroll: 'SELECT COUNT(*) AS n FROM "PayrollRun"',
      };
      const out = {};
      for (const [k, sql] of Object.entries(q)) { try { out[k] = (await raw(sql))[0].n; } catch { out[k] = -1; } } // eslint-disable-line no-await-in-loop
      return out;
    };
    const countsStart = await cnt();
    const tablesStart = (await raw(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)).map((r) => r.name);

    // ================================================================== A. pure logic
    const NAV3 = ['Bills', 'Monthly History', 'SIMs'];
    check('A', 'the server menu of the Airtel Bills portal is EXACTLY Bills, Monthly History, SIMs (no Orders, Repairs, Assets, Dashboard...)', JSON.stringify(CFG.TELECOM_PORTAL_NAV.map((n) => n.label)) === JSON.stringify(NAV3), CFG.TELECOM_PORTAL_NAV);
    let FEN;
    {
      const esb = require(path.join(FE, 'node_modules', 'esbuild'));
      const out = path.join(os.tmpdir(), `abp-${RUN}-nav.cjs`);
      esb.buildSync({ entryPoints: [path.join(FE, 'src/pages/vendor/vendorNav.js')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error' });
      FEN = require(out);
    }
    check('A', 'the frontend menu (vendorNav.js TELECOM_NAV) is the SAME list as the server\'s (key, label, route)', JSON.stringify(FEN.TELECOM_NAV) === JSON.stringify(CFG.TELECOM_PORTAL_NAV), [FEN.TELECOM_NAV, CFG.TELECOM_PORTAL_NAV]);
    check('A', 'the sidebar configuration for the telecom kind uses the same menu and the role label "Airtel Bills Vendor"', FEN.SIDEBAR_KINDS.telecom && FEN.SIDEBAR_KINDS.telecom.nav === FEN.TELECOM_NAV && FEN.SIDEBAR_KINDS.telecom.roleLabel === 'Airtel Bills Vendor' && CFG.ROLE_LABEL.telecom === 'Airtel Bills Vendor', FEN.SIDEBAR_KINDS.telecom);
    check('A', 'the other kinds\' menus are unchanged (finance 4, Assets 5 since 28 Oct 2026, ID card 5) and the telecom pages are not in them', CFG.PORTAL_NAV.length === 4 && CFG.ASSET_PORTAL_NAV.length === 5 && CFG.IDCARD_PORTAL_NAV.length === 5 && ![...CFG.PORTAL_NAV, ...CFG.ASSET_PORTAL_NAV, ...CFG.IDCARD_PORTAL_NAV].some((n) => /airtel/.test(n.route)));
    check('A', 'route guard: any other address of a telecom vendor goes to Bills; its three pages stay', ['/vendor/dashboard', '/vendor/airtel-portal/orders', '/vendor'].every((p) => CFG.telecomPortalRouteFor(p) === CFG.TELECOM_PORTAL_HOME) && CFG.TELECOM_PORTAL_NAV.every((n) => CFG.telecomPortalRouteFor(n.route) === n.route) && FEN.telecomRouteFor('/vendor/x') === '/vendor/airtel-portal/bills');
    // the wall (pure)
    const P = (k, p) => CFG.portalPathAllowedFor(k, p);
    check('A', 'wall: a telecom vendor may call /airtel-portal/* and the shared utilities (me, logout, change-password, download-link, files)', ['/airtel-portal/bills', '/airtel-portal/overview', '/me', '/logout', '/change-password', '/download-link', '/files/abc'].every((p) => P('telecom', p)));
    check('A', 'wall: a telecom vendor may NOT call the finance API (/records, /module-bills), /asset-portal or /idcard-portal', ['/records/invoices', '/module-bills', '/asset-portal/assets', '/idcard-portal/requests', '/assets', '/bills', '/documents'].every((p) => !P('telecom', p)));
    check('A', 'wall: finance, Assets and ID-card vendors may NOT call /airtel-portal', ['finance', 'assets', 'idcards'].every((k) => !P(k, '/airtel-portal/bills')));
    check('A', 'wall: the other kinds reach exactly what they reached before (finance /records, Assets /asset-portal, ID card /idcard-portal)', P('finance', '/records/invoices') && P('assets', '/asset-portal/assets') && P('idcards', '/idcard-portal/requests') && !P('assets', '/records/invoices') && !P('idcards', '/asset-portal/assets') && !P('finance', '/asset-portal/assets'));
    check('A', 'a vendor-master category "Airtel SIM / Telecom" resolves to the telecom category; the old telecom module defaults are unchanged', CFG.resolveCategory('Airtel SIM / Telecom') === 'telecom' && JSON.stringify(CFG.modulesForCategory('telecom')) === JSON.stringify(['sim_connections', 'monthly_bills', 'invoices', 'payments']));
    check('A', 'the Admin tick list has an "Airtel Bills" tick with one permission "Send a bill"; no other module changed its permissions', CFG.MODULES.airtel_bills && CFG.MODULES.airtel_bills.label === 'Airtel Bills' && CFG.MODULES.airtel_bills.permissions.map((p) => p.key).join() === 'sendBill,download' && CFG.MODULES.assets.permissions.length === 4 && CFG.MODULES.id_card_orders.permissions.length === 3);
    // masking
    check('A', 'masking: 9963418222 -> 99xxxxxx22, +91 98765 43210 -> 98xxxxxx10, a short value is hidden, empty stays empty', ATB.maskNumber('9963418222') === '99xxxxxx22' && ATB.maskNumber('+91 98765 43210') === '98xxxxxx10' && ATB.maskNumber('123') === 'xxx' && ATB.maskNumber('') === null, [ATB.maskNumber('9963418222'), ATB.maskNumber('+91 98765 43210')]);
    check('A', 'masking inside text: a 10-digit number in a remark is masked, a longer reference keeps the last 4, an amount like 21845.34 is not touched', ATB.maskText('call 9963418222 now') === 'call 99xxxxxx22 now' && !/9963418222/.test(ATB.maskText('x 99634 18222 y')) && ATB.maskText('Rs 21845.34 invoice 1234') === 'Rs 21845.34 invoice 1234', [ATB.maskText('call 9963418222 now'), ATB.maskText('x 99634 18222 y')]);
    check('A', 'masked reference: UTR123456789 -> ••••6789; a reference shorter than 8 characters is not shown at all', AP.maskRef('UTR123456789') === '\u2022\u2022\u2022\u20226789' && AP.maskRef('AB12') === null && AP.maskRef(null) === null);
    // the seat table is the Assets inventory's, not a different rule
    const invSrc = fs.readFileSync(path.join(BACK, 'src/routes/assetInventory.js'), 'utf8');
    const tbl = /const SEAT_DEPARTMENTS = (\{[^}]*\});/.exec(invSrc);
    check('A', 'seat codes -> department: the portal uses the SAME table as the HRMS asset screen (routes/assetInventory.js), first word decides', !!tbl && JSON.stringify(Function(`return ${tbl[1]}`)()) === JSON.stringify(ATB.SEAT_DEPARTMENTS) && ATB.deptOfSeat('BDE EDU-1') === 'BDE' && ATB.deptOfSeat('EDU-5') === 'Education' && ATB.deptOfSeat('MED TL') === 'Medical' && ATB.deptOfSeat('Unassigned') === null && ATB.deptOfSeat('WhatsApp line') === null);
    // the status words, from synthetic judged states (pure)
    {
      const bill = (o = {}) => ({ id: 'x', monthlyAmount: 1000, gstAmount: 0, tdsAmount: 0, approvalStatus: 'PENDING', paidStatus: 'Unpaid', dueDate: null, bankTxnId: null, ...o });
      const J = (state, paid, extra = {}) => ({ state, paid, bankPaid: 0, balance: paid ? 0 : 1000, needsApprover: false, inconsistent: false, proof: { line: null }, ...extra });
      const line = (o = {}) => ({ date: '2026-10-05', reference: 'UTR998877665544', amount: 1000, ...o });
      const t = '2026-10-19';
      const a = AP.fromExpense(bill(), J('no_link', false), t);
      check('A', 'status: no payment and no due date = Pending (not overdue, not due soon)', a.status === 'Pending' && !a.overdue && !a.dueSoon && a.paymentDate === null, a);
      const b = AP.fromExpense(bill({ dueDate: '2026-10-18' }), J('no_link', false), t);
      check('A', 'status: due date passed (IST day) and unpaid = Overdue; due today is NOT overdue', b.status === 'Overdue' && b.overdue === true && AP.fromExpense(bill({ dueDate: '2026-10-19' }), J('no_link', false), t).status === 'Pending', [b.status, AP.fromExpense(bill({ dueDate: '2026-10-19' }), J('no_link', false), t).status]);
      const c = AP.fromExpense(bill({ dueDate: '2026-10-22' }), J('no_link', false), t);
      check('A', 'status: due within 7 days = due soon (3 days); due in 8 days = not due soon; a paid bill is never due soon', c.dueSoon === true && c.daysToDue === 3 && AP.fromExpense(bill({ dueDate: '2026-10-27' }), J('no_link', false), t).dueSoon === false && AP.fromExpense(bill({ dueDate: '2026-10-22', approvalStatus: 'PAID', paidStatus: 'Paid' }), J('no_link', true), t).dueSoon === false);
      const d = AP.fromExpense(bill({ approvalStatus: 'PAID', paidStatus: 'Paid', paymentDate: '2026-10-05' }), J('no_link', true), t);
      check('A', 'status: Paid in Accounts with NO matched bank line = "Paid by Accounts" (not "Paid"), not verified, no reference, never overdue', d.status === 'Paid by Accounts' && d.verified === false && d.reference === null && d.overdue === false && d.paymentDate === '2026-10-05', d);
      const e = AP.fromExpense(bill({ approvalStatus: 'PAID', paidStatus: 'Paid', bankTxnId: 'L' }), J('confirmed', true, { bankPaid: 1000, proof: { line: line() } }), t);
      check('A', 'status: bank line matched to the bill (money out) = Paid, verified, with the statement date and a MASKED reference (••••5544)', e.status === 'Paid' && e.verified === true && e.paymentDate === '2026-10-05' && e.reference === '\u2022\u2022\u2022\u20225544' && !JSON.stringify(e).includes('UTR998877665544'), e);
      const f = AP.fromExpense(bill({ bankTxnId: 'L' }), J('confirmed', false, { bankPaid: 1000, needsApprover: true, inconsistent: true, proof: { line: line() } }), t);
      check('A', 'status: money left the bank and the line is matched, the bill still waits for an approver = Paid (the bank is the proof), amount paid in full, balance 0', f.status === 'Paid' && f.verified === true && f.paidAmount === 1000 && f.balance === 0, f);
      const g = AP.fromExpense(bill({ dueDate: '2026-10-01' }), J('part', false, { bankPaid: 400, balance: 600, proof: { line: line({ amount: 400 }) } }), t);
      check('A', 'status: part payment = Partially Paid with the paid and the balance from the bank line; late + partly paid keeps the late flag', g.status === 'Partially Paid' && g.paidAmount === 400 && g.balance === 600 && g.overdue === true, g);
      const h = AP.fromExpense(bill({ bankTxnId: 'L' }), J('reversed', false, { proof: { line: line() } }), t);
      check('A', 'status: reversed bank payment = Reversed (not Paid), balance = the whole bill, no payment date, no reference', h.status === 'Reversed' && h.balance === 1000 && h.paymentDate === null && h.reference === null, h);
      for (const st of ['ignored', 'link_only', 'broken']) {
        const x = AP.fromExpense(bill({ bankTxnId: 'L' }), J(st, false, { proof: { line: line() } }), t);
        check('A', `status: a bank line that is ${st === 'ignored' ? 'set aside' : (st === 'link_only' ? 'only linked, not matched' : 'broken')} is NOT a payment: Pending (never Paid)`, (x.status === 'Pending' || (st === 'link_only' && x.status === 'Under Review' /* 2026-10-28 Stage E */)) && x.verified === false && x.reference === null, x);
      }
      const m = AP.fromModuleBill({ status: 'Paid', total: 500, paidAmount: 500, paidOn: '2026-10-02', dueDate: '2026-10-10' }, t);
      check('A', 'status: a sent bill Accounts typed "Paid" by hand (no bank statement) is "Paid by Accounts", never "Paid"; a sent bill not yet booked = Waiting for Accounts', m.status === 'Paid by Accounts' && m.verified === false && AP.fromModuleBill({ status: 'Submitted', total: 500, dueDate: '2026-10-01' }, t).status === 'Waiting for Accounts' && AP.fromModuleBill({ status: 'Submitted', total: 500, dueDate: '2026-10-01' }, t).overdue === false, [m.status]);
      check('A', 'month roll-up: the worst status wins (Overdue > Reversed > Pending > Partially Paid > Paid by Accounts > Paid); empty = null', AP.rollup(['Paid', 'Overdue', 'Pending']) === 'Overdue' && AP.rollup(['Paid', 'Paid by Accounts']) === 'Paid by Accounts' && AP.rollup(['Paid', 'Partially Paid']) === 'Partially Paid' && AP.rollup([]) === null);
    }

    // ================================================================== vendors, logins
    const mkVendor = async (tag, name, category) => {
      const v = await prisma.officeVendor.create({ data: { name: name || `ZZTEST ABP Vendor ${tag} ${RUN}`, companyName: `ZZTEST ABP Co ${tag}`, isActive: true, category: category === undefined ? null : category } });
      made.vendors.push(v.id); return v;
    };
    const mkLogin = async (vendor, tag) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-abp-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit: false, canViewCost: false } });
      made.vusers.push(u.id);
      return { u, pw };
    };
    const nowMs = Date.now();
    const addModules = async (login, keys, perms = {}) => { for (const k of keys) await raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzabp${k}${login.u.id}`.slice(0, 44), login.u.id, k, JSON.stringify(perms[k] || {}), nowMs, nowMs); }; // eslint-disable-line no-await-in-loop
    const vlogin = (L) => http('POST', '/api/vendor-portal/login', null, { email: L.u.email, password: L.pw });
    const sign = async (L) => { const r = await vlogin(L); L.token = r.body && r.body.token; L.login = r; return L; };

    // Airtel vendor 1 (the one under test): name has the provider word, the Admin ticked Airtel Bills (+ Send a bill); vendor 1b: same vendor, a second login WITHOUT the send tick
    const V1 = await mkVendor('Airtel', `ZZTEST ABP Airtel Mobile ${RUN}`);
    const V2 = await mkVendor('Jio', `ZZTEST ABP Jio Fiber ${RUN}`);
    const VF = await mkVendor('Finance', null, 'Other');
    const VAs = await mkVendor('Assets', null, 'IT / Hardware / AMC / Service');
    const VId = await mkVendor('IdCard', null, 'ID Cards');
    const VCat = await mkVendor('TelecomCat', null, 'Airtel SIM / Telecom'); // category only, no module rows
    const VCat2 = await mkVendor('TelecomCatTicked', null, 'Airtel SIM / Telecom'); // category says telecom, Admin ticked only the four finance modules
    const L1 = await mkLogin(V1, 't1'); const L1n = await mkLogin(V1, 't1n'); const L2 = await mkLogin(V2, 't2');
    const LF = await mkLogin(VF, 'fin'); const LAs = await mkLogin(VAs, 'ast'); const LId = await mkLogin(VId, 'idc'); const LCat = await mkLogin(VCat, 'cat'); const LCat2 = await mkLogin(VCat2, 'cat2');
    await addModules(L1, ['airtel_bills', 'invoices'], { airtel_bills: { sendBill: true } });
    await addModules(L1n, ['airtel_bills'], { airtel_bills: { sendBill: false } });
    await addModules(L2, ['airtel_bills'], { airtel_bills: { sendBill: true } });
    await addModules(LF, ['invoices', 'payments']);
    await addModules(LAs, ['assets', 'airtel_bills']); // Assets wins
    await addModules(LId, ['id_card_orders', 'airtel_bills']); // ID card wins
    await addModules(LCat2, CFG.modulesForCategory('telecom')); // the four old telecom ticks, no Airtel Bills tick -> finance, as before
    for (const L of [L1, L1n, L2, LF, LAs, LId, LCat, LCat2]) await sign(L); // eslint-disable-line no-await-in-loop
    check('B', 'fixture: every vendor login signs in through the real /api/vendor-portal/login', [L1, L1n, L2, LF, LAs, LId, LCat, LCat2].every((L) => L.token), [L1, L1n, L2, LF, LAs, LId, LCat, LCat2].map((L) => L.login.status));

    // ---- who is a telecom vendor (the decision rule, on the real function and on /me)
    const kindOf = async (L) => KIND.kindOfRow({ ...(await prisma.vendorUser.findUnique({ where: { id: L.u.id } })), vendorId: L.u.vendorId });
    const kinds = { t1: await kindOf(L1), t2: await kindOf(L2), fin: await kindOf(LF), ast: await kindOf(LAs), idc: await kindOf(LId), cat: await kindOf(LCat), cat2: await kindOf(LCat2) };
    check('B', 'kind rule: "Airtel Bills" ticked = telecom; Assets or ID Cards ticked as well = they win (one portal per vendor)', kinds.t1 === 'telecom' && kinds.t2 === 'telecom' && kinds.ast === 'assets' && kinds.idc === 'idcards', kinds);
    check('B', 'kind rule: the vendor-master CATEGORY never makes a telecom vendor (category "Airtel SIM / Telecom" with no module rows stays finance, as before; a login with the four old telecom ticks stays finance); only the Admin tick does', kinds.cat === 'finance' && kinds.cat2 === 'finance' && kinds.fin === 'finance', kinds);
    const me = {};
    for (const [k, L] of Object.entries({ t1: L1, t1n: L1n, t2: L2, fin: LF, ast: LAs, idc: LId, cat: LCat, cat2: LCat2 })) me[k] = await http('GET', '/api/vendor-portal/me', L.token); // eslint-disable-line no-await-in-loop
    check('B', '/me of a telecom vendor: kind telecom, role label, EXACTLY the three pages, landing = Bills, canSend follows the tick', me.t1.status === 200 && me.t1.body.kind === 'telecom' && me.t1.body.roleLabel === 'Airtel Bills Vendor' && JSON.stringify(me.t1.body.nav.map((n) => n.label)) === JSON.stringify(NAV3) && me.t1.body.landing === '/vendor/airtel-portal/bills' && me.t1.body.canSend === true && me.t1n.body.canSend === false && me.cat.body.kind === 'finance', [me.t1.body.kind, me.t1.body.nav, me.t1.body.landing]);
    check('B', '/me of the other kinds is unchanged: finance 4 pages, Assets 5 (since 28 Oct 2026), ID card 5; none carries an Airtel page', me.fin.body.kind === 'finance' && me.fin.body.nav.length === 4 && me.ast.body.kind === 'assets' && me.ast.body.nav.length === 5 && me.idc.body.kind === 'idcards' && me.idc.body.nav.length === 5 && me.cat2.body.kind === 'finance' && [me.fin, me.ast, me.idc, me.cat2].every((r) => !/airtel/i.test(JSON.stringify(r.body.nav))), [me.fin.body.kind, me.ast.body.kind, me.idc.body.kind, me.cat2.body.kind]);
    const sign2 = await http('POST', '/api/vendor-portal/login', null, { email: L1.u.email, password: L1.pw });
    check('B', 'the sign-in answer sends a telecom vendor to Bills', sign2.status === 200 && sign2.body.landing === '/vendor/airtel-portal/bills', sign2.body && sign2.body.landing);

    // ---- the wall on the server
    const A = '/api/vendor-portal/airtel-portal';
    const wallOk = await Promise.all(['/overview', '/bills', '/history', '/sims'].map((p) => http('GET', `${A}${p}`, L1.token)));
    check('B', 'a telecom vendor reaches overview, bills, history and sims (200)', wallOk.every((r) => r.status === 200), wallOk.map((r) => r.status));
    const outsiders = await Promise.all([LF, LAs, LId, LCat2].map((L) => http('GET', `${A}/bills`, L.token)));
    check('B', 'finance, Assets and ID-card vendors cannot reach /airtel-portal (403)', outsiders.every((r) => r.status === 403), outsiders.map((r) => r.status));
    const nonAir = await Promise.all(['/records/invoices', '/records/overview', '/module-bills', '/asset-portal/assets', '/idcard-portal/requests', '/assets', '/bills', '/documents', '/dashboard'].map((p) => http('GET', `/api/vendor-portal${p}`, L1.token)));
    check('B', 'a telecom vendor cannot reach the finance API, /asset-portal, /idcard-portal or the old module APIs (all 403)', nonAir.every((r) => r.status === 403), nonAir.map((r) => r.status));
    const staffApis = await Promise.all(['/api/bank', '/api/bank/accounts', '/api/office-expenses', '/api/office-expenses/ledger', '/api/invoices', '/api/employees', '/api/candidates', '/api/admin/users', '/api/asset-inventory', '/api/vendor-logins', '/api/hrms/dashboard', '/api/accounts-import/bank-batches'].map((p) => http('GET', p, L1.token)));
    check('B', 'a telecom vendor token is refused on Accounts / bank / HRMS / ATS / Admin APIs (every one 401 or 403)', staffApis.every((r) => [401, 403].includes(r.status)), staffApis.map((r) => r.status));
    const noTok = await http('GET', `${A}/bills`, null);
    const badTok = await http('GET', `${A}/bills`, 'not-a-token');
    check('B', 'no token or a bad token = 401 on the Airtel API', noTok.status === 401 && badTok.status === 401, [noTok.status, badTok.status]);
    const staffTok = await http('GET', `${A}/bills`, T.admin);
    check('B', 'a STAFF token (even Admin) cannot read the vendor Airtel API (401/403)', [401, 403].includes(staffTok.status), staffTok.status);
    {
      // the Admin screen's own API: the "Airtel Bills" tick is in the registry, can be saved on a login, and changes the portal the login gets
      const reg = await http('GET', '/api/vendor-logins/registry', T.admin);
      const mod = reg.body && (reg.body.modules || []).find((m) => m.key === 'airtel_bills');
      check('B', 'the Admin vendor-login screen lists the "Airtel Bills" tick (registry) with its one permission; the other modules and categories are as before', reg.status === 200 && !!mod && mod.label === 'Airtel Bills' && mod.permissions.length === 2 && mod.permissions[0].key === 'sendBill' && reg.body.modules.length === 9 && reg.body.modules.filter((m) => m.key !== 'airtel_bills').length === 8 && reg.body.categories.length === 5, [reg.status, reg.body && reg.body.modules && reg.body.modules.map((m) => m.key)]);
      const VAdm = await mkVendor('AdminMade', null, null);
      const cr = await http('POST', '/api/vendor-logins', T.admin, { vendorId: VAdm.id, name: 'ZZTEST ABP Admin Made', email: `zz-abp-adm-${RUN}@example.test`, modules: ['airtel_bills'], permissions: { airtel_bills: { sendBill: false } } });
      if (cr.body && cr.body.login) made.vusers.push(cr.body.login.id);
      const kAfter = cr.body && cr.body.login ? await KIND.kindOfRow({ ...(await prisma.vendorUser.findUnique({ where: { id: cr.body.login.id } })), vendorId: VAdm.id }) : null;
      check('B', 'Admin creates a login on a vendor with NO category and ticks only "Airtel Bills": it is saved (module row + permission) and that login is a telecom vendor', cr.status === 201 && kAfter === 'telecom' && (await raw('SELECT "moduleKey","permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', cr.body.login.id)).some((m) => m.moduleKey === 'airtel_bills' && /"sendBill":false/.test(m.permissionsJson)), [cr.status, kAfter]);
      const up = cr.body && cr.body.login ? await http('PATCH', `/api/vendor-logins/${cr.body.login.id}`, T.admin, { modules: ['invoices', 'payments'] }) : null;
      const kAfter2 = cr.body && cr.body.login ? await KIND.kindOfRow({ ...(await prisma.vendorUser.findUnique({ where: { id: cr.body.login.id } })), vendorId: VAdm.id }) : null;
      check('B', 'Admin takes the tick off again: the login goes back to the plain finance portal (nothing is stored on the vendor)', up && up.status === 200 && kAfter2 === 'finance', [up && up.status, kAfter2]);
    }
    check('B', 'a vendor id in the query or body is never read: ?vendorId=<other vendor> returns the caller\'s own (empty) set', (await http('GET', `${A}/bills?vendorId=${V1.id}&vendorUserId=${L1.u.id}`, L2.token)).body.all === 0);
    const unknown = await http('GET', `${A}/nothing-here`, L1.token);
    check('B', 'an unknown path under /airtel-portal is refused (403)', unknown.status === 403, unknown.status);

    // every vendor response is kept for the privacy sweep at the end
    const swept = [];
    const vh = async (L, method, p, body, opt) => { const r = await http(method, p, L.token, body, opt); swept.push({ p, text: r.text, status: r.status }); return r; };

    // ================================================================== R. the REAL Airtel data of the copy
    const realV = await prisma.officeVendor.findFirst({ where: { name: 'Airtel Mobile Bill' } });
    check('R', 'the real vendor "Airtel Mobile Bill" exists in the database copy (the founder\'s vendor)', !!realV, null);
    const LR = await mkLogin(realV, 'real'); // a ZZTEST login on the REAL vendor, in the copy only
    await addModules(LR, ['airtel_bills'], { airtel_bills: { sendBill: false } });
    await sign(LR);
    const dbBills = await raw(`SELECT * FROM "OfficeExpense" WHERE "vendor" = 'Airtel Mobile Bill' AND COALESCE("entryKind",'expense') <> 'hand' AND COALESCE("approvalStatus",'') <> 'REJECTED' ORDER BY "expenseDate" DESC`);
    const rl = await vh(LR, 'GET', `${A}/bills?pageSize=100`);
    check('R', `the real Airtel bills of the database are listed: same count as the OfficeExpense rows of "Airtel Mobile Bill" (${dbBills.length})`, rl.status === 200 && rl.body.total === dbBills.length && dbBills.length >= 5 && rl.body.all === dbBills.length, [rl.status, rl.body && rl.body.total, dbBills.length]);
    const byInv = new Map((rl.body.rows || []).map((r) => [r.invoiceNo, r]));
    const sameFields = dbBills.every((d) => { const r = byInv.get(d.billNumber); return r && r.total === rs2(d.monthlyAmount) && r.tax === rs2(d.gstAmount) && r.amount === rs2(d.monthlyAmount - d.gstAmount) && r.billDate === d.expenseDate && r.dueDate === (d.dueDate || null) && r.accountsRef === d.expenseCode && r.provider === 'Airtel'; });
    check('R', 'every real bill carries the database values exactly: invoice no., bill date, amount before tax, tax, total, due date, Accounts reference, provider Airtel', sameFields, dbBills.map((d) => [d.billNumber, byInv.get(d.billNumber)]).slice(0, 2));
    const wantStatus = (d) => (d.approvalStatus === 'PAID' && !d.bankTxnId ? 'Paid by Accounts' : ((d.dueDate && d.dueDate < TODAY) ? 'Overdue' : 'Pending'));
    check('R', 'status of each real bill matches an independent reading of the database (paid in Accounts, no bank line = "Paid by Accounts"; unpaid + due date passed = Overdue; else Pending)', dbBills.every((d) => (byInv.get(d.billNumber) || {}).payment && byInv.get(d.billNumber).payment.status === wantStatus(d)), dbBills.map((d) => [d.billNumber, d.approvalStatus, d.dueDate, wantStatus(d), (byInv.get(d.billNumber) || {}).payment && byInv.get(d.billNumber).payment.status]));
    const real5 = rl.body.rows || [];
    check('R', 'no invented value: billing period, additional charges, payment reference are null ("Not recorded") on the real bills; a due date is shown only where the database has one', real5.every((r) => r.period === null && r.periodLabel === null && r.additionalCharges === null && r.payment.reference === null) && real5.filter((r) => r.dueDate).length === dbBills.filter((d) => d.dueDate).length, real5.map((r) => [r.invoiceNo, r.period, r.dueDate]));
    check('R', 'no bank line exists for the real bills, so none is "Paid" (bank-verified): the portal does not call them Paid', real5.every((r) => r.payment.status !== 'Paid') && real5.every((r) => r.payment.verified === false));
    const rd = await vh(LR, 'GET', `${A}/bills/${encodeURIComponent(real5[0].key)}`);
    check('R', 'the bill detail carries every field of the spec (provider, invoice, bill date, due date, amount, tax, additional charges, total payable, payment status/date/reference, document flag) and a history list', rd.status === 200 && ['provider', 'invoiceNo', 'billDate', 'dueDate', 'amount', 'tax', 'additionalCharges', 'total', 'payable', 'payment', 'hasDocument', 'period', 'accountsRef'].every((k) => k in rd.body.bill) && Array.isArray(rd.body.history), Object.keys((rd.body && rd.body.bill) || {}));
    const rm = await vh(LR, 'GET', `${A}/history?pageSize=100`);
    const mths = (rm.body.rows || []).filter((r) => !r.noBill).map((r) => r.month).sort();
    check('R', `monthly history of the real bills: one row per bill month (${[...new Set(dbBills.map((d) => ymOfStr(d.expenseDate)))].sort().join(', ')}), months without a bill are "No bill recorded", never zero rupees`, rm.status === 200 && JSON.stringify(mths) === JSON.stringify([...new Set(dbBills.map((d) => ymOfStr(d.expenseDate)))].sort()) && (rm.body.rows || []).filter((r) => r.noBill).every((r) => r.billAmount === null && r.paidAmount === null && r.outstanding === null && r.status === null), mths);
    const sumDb = rs2(dbBills.reduce((t, d) => t + d.monthlyAmount, 0));
    check('R', `monthly totals equal an independent sum of the database: billed ${sumDb} for all real bills`, rm.body.totals.billed === sumDb, [rm.body.totals, sumDb]);
    const ro = await vh(LR, 'GET', `${A}/overview`);
    check('R', 'overview: bills count, overdue count and the alert list agree with the bills (the real overdue bill raises exactly one "Overdue" alert)', ro.status === 200 && ro.body.bills.count === dbBills.length && ro.body.bills.overdue === dbBills.filter((d) => wantStatus(d) === 'Overdue').length && ro.body.alerts.filter((a) => a.kind === 'overdue').length === ro.body.bills.overdue && new Set(ro.body.alerts.map((a) => a.key)).size === ro.body.alerts.length, [ro.body.bills, ro.body.alerts]);

    // ================================================================== S. SIMs (read only, the same assets)
    const simsDb = await raw(`SELECT a."id",a."assetCode",a."name",a."status",a."location",a."assignedToId",e."department" AS "dept" FROM "Asset" a LEFT JOIN "Employee" e ON e."id" = a."assignedToId" WHERE a."category" = 'SIM Card' AND a."status" NOT IN ('Retired','Sold','Written off') AND a."assetCode" NOT LIKE 'ZZABP-%'`);
    const assetsBefore = (await raw('SELECT COUNT(*) AS n FROM "Asset"'))[0].n;
    const connBefore = (await raw('SELECT COUNT(*) AS n FROM "SimConnection"'))[0].n;
    const sl = await vh(LR, 'GET', `${A}/sims?pageSize=100`);
    check('S', `the SIM list is the company's SIM assets: same count as the database (${simsDb.length} Airtel SIM assets)`, sl.status === 200 && sl.body.total === simsDb.length && sl.body.all === simsDb.length && simsDb.length >= 50, [sl.status, sl.body && sl.body.total, simsDb.length]);
    const digits = (n) => (/(\d{10})/.exec(n) || [])[1];
    const simByRef = new Map((sl.body.rows || []).map((r) => [r.simRef, r]));
    // 2026-10-29 (founder): the FULL 10-digit number is shown (it was masked 98xxxxxx21 before); the holder is still never named.
    check('S', 'every SIM shows its asset reference (AST-xxxx) and its FULL 10-digit number; the same asset appears once (no duplicates)', simsDb.every((d) => { const r = simByRef.get(d.assetCode); return r && r.number === digits(d.name); }) && simByRef.size === simsDb.length, simsDb.slice(0, 2).map((d) => [d.assetCode, simByRef.get(d.assetCode)]));
    const deptWant = (d) => d.dept || ATB.deptOfSeat(d.location) || null;
    check('S', "department (the holder's department, else the seat's): equals an independent reading", simsDb.every((d) => (simByRef.get(d.assetCode) || {}).department === deptWant(d)), simsDb.filter((d) => (simByRef.get(d.assetCode) || {}).department !== deptWant(d)).slice(0, 3));
    // 2026-10-29 (founder): WHO uses the SIM now is shown - HRMS's current holder, name + employee ID only (no phone / email)
    const holders = await prisma.asset.findMany({ where: { id: { in: simsDb.map((d) => d.id) } }, select: { assetCode: true, assignedToId: true, assignedTo: { select: { name: true, employeeCode: true } } } });
    check('S', 'used by (now): every SIM shows exactly HRMS\'s current holder (name + employee ID), "nobody" when in stock; no phone or email in the answer', holders.every((h) => { const r = simByRef.get(h.assetCode) || {}; return h.assignedToId ? (r.usedBy && r.usedBy.name === h.assignedTo.name && r.usedBy.employeeCode === (h.assignedTo.employeeCode || null)) : r.usedBy === null; }) && !/"phone"|"email"|"mobileNumber"/i.test(sl.text), holders.filter((h) => { const r = simByRef.get(h.assetCode) || {}; return h.assignedToId ? !(r.usedBy && r.usedBy.name === h.assignedTo.name) : r.usedBy !== null; }).slice(0, 3));
    check('S', 'in use / in stock follows the asset (Assigned = in use, Available = in stock)', simsDb.every((d) => (simByRef.get(d.assetCode) || {}).status === (d.status === 'Assigned' ? 'In use' : 'In stock')) && sl.body.summary.inUse === simsDb.filter((d) => d.assignedToId).length, sl.body.summary);
    const dep = (sl.body.facets.department || [])[0];
    const sf = await vh(LR, 'GET', `${A}/sims?department=${encodeURIComponent(dep.value)}&pageSize=100`);
    check('S', `department filter: the rows are exactly that department's SIMs (${dep.value} ${dep.count})`, sf.status === 200 && sf.body.total === simsDb.filter((d) => (deptWant(d) || 'Not recorded') === dep.value).length && sf.body.rows.every((r) => (r.department || 'Not recorded') === dep.value));
    const q1 = simsDb[0]; const full1 = digits(q1.name);
    const sq = await vh(LR, 'GET', `${A}/sims?q=${full1}`);
    const spaced = `+91 ${full1.slice(0, 5)} ${full1.slice(5)}`;
    check('S', 'search by the FULL number (also typed as "+91 99634 18222") or by the SIM reference finds exactly that SIM', sq.body.rows.length === 1 && sq.body.rows[0].simRef === q1.assetCode && (await vh(LR, 'GET', `${A}/sims?q=${encodeURIComponent(spaced)}`)).body.rows.some((r) => r.simRef === q1.assetCode) && (await vh(LR, 'GET', `${A}/sims?q=${q1.assetCode}`)).body.rows.length === 1, [sq.body.rows.map((r) => r.simRef)]);
    check('S', 'the SIM count is the number of UNIQUE SIM numbers (not bill rows, not a page): summary total = distinct numbers of the Airtel SIM assets', sl.body.summary.total === new Set(simsDb.map((d) => digits(d.name)).filter(Boolean)).size, [sl.body.summary.total]);
    const writes = await Promise.all([['POST', '/sims', { number: '9000000001' }], ['PATCH', `/sims/${q1.id}`, { status: 'Active' }], ['PUT', `/sims/${q1.id}`, {}], ['DELETE', `/sims/${q1.id}`, undefined]].map(([m, p, b]) => vh(LR, m, A + p, b)));
    check('S', 'the SIM list is read only: POST / PATCH / PUT / DELETE on /sims are refused (403)', writes.every((r) => r.status === 403), writes.map((r) => r.status));
    check('S', 'no SIM record was created or changed: the Asset and SimConnection tables have the same number of rows after all these calls', (await raw('SELECT COUNT(*) AS n FROM "Asset"'))[0].n === assetsBefore && (await raw('SELECT COUNT(*) AS n FROM "SimConnection"'))[0].n === connBefore);
    const otherSims = await vh(L2, 'GET', `${A}/sims`);
    check('S', 'a telecom vendor of another provider (Jio) does not get the Airtel SIMs', otherSims.status === 200 && otherSims.body.total === 0, otherSims.body.total);
    {
      // a SIM connection row (the HRMS copy) only supplies the Active / Suspended / Disconnected word
      const a = simsDb.find((d) => d.status === 'Assigned');
      const t = Date.now();
      await raw('INSERT INTO "SimConnection" ("id","vendorId","mobileNumber","simSerial","status","assetId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)', `zzabpconn${RUN}`, realV.id, digits(a.name), null, 'Suspended', a.id, t, t);
      made.conns.push(`zzabpconn${RUN}`);
      const r = await vh(LR, 'GET', `${A}/sims?q=${a.assetCode}`);
      check('S', 'a SimConnection row linked to the asset only supplies the status word (Suspended); still ONE row for that SIM', r.body.rows.length === 1 && r.body.rows[0].status === 'Suspended', r.body.rows);
      await raw('DELETE FROM "SimConnection" WHERE "id" = ?', `zzabpconn${RUN}`);
    }

    // ================================================================== P. the payment flow, through the real Accounts and bank APIs
    const bankA = await prisma.bankAccount.create({ data: { bank: `ZZTEST ABP Bank ${RUN}`, name: 'ZZTEST ABP', accNo: '777766665555', active: true } });
    made.banks.push(bankA.id);
    const BANK_ACC_NO = '777766665555';
    let seq = 0;
    const bookBill = async (o = {}) => {
      seq += 1;
      const base = o.base == null ? 10000 : o.base;
      const body = {
        category: 'Airtel Bill', vendor: o.vendor || V1.name, expenseDate: o.billDate || addDays(TODAY, -40), baseAmount: base, gstAmount: o.gst == null ? rs2(base * 0.18) : o.gst, billNumber: o.invoice === undefined ? `ZZABPINV${RUN}S${String(seq).padStart(3, "0")}` : o.invoice,
        description: `ZZTEST ABP bill ${seq}`, paymentMode: 'Bank Transfer', recurring: false, ...(o.dueDate !== undefined ? { dueDate: o.dueDate } : { dueDate: addDays(TODAY, 20) }),
      };
      const r = await http('POST', '/api/office-expenses', T.admin, body);
      if (r.status !== 201 && r.status !== 200) console.log('   (bill not created)', r.status, JSON.stringify(r.body).slice(0, 300));
      const id = r.body && (r.body.id || (r.body.expense && r.body.expense.id));
      if (id) made.expenses.push(id);
      return { r, id, body };
    };
    const portalBill = async (L, id) => { const r = await vh(L, 'GET', `${A}/bills/${encodeURIComponent(`exp:${id}`)}`); return r.body && r.body.bill; };
    const accountsPays = (id, paymentDate) => http('PATCH', `/api/office-expenses/${id}/status`, T.admin, { action: 'mark_paid', paymentDate });
    const importRows = (rows, file) => http('POST', '/api/bank/import', T.admin, { transactions: rows, bankAccountId: bankA.id, file: file || `zzabp-${RUN}-${rows.length}.csv` });
    const D = (n) => addDays(TODAY, n);
    let lseq = 0;
    const row = (o) => { lseq += 1; return { date: o.date, description: o.desc, reference: o.ref === undefined ? `HDFC${RUN}A${String(lseq).padStart(3, '0')}` : o.ref, type: o.type || 'Debit', amount: o.amount, balance: o.balance === undefined ? 487312.55 + lseq : o.balance }; };
    const lineBy = async (needle) => prisma.bankTransaction.findFirst({ where: { bankAccountId: bankA.id, description: { contains: needle } } });
    const expNow = (id) => prisma.officeExpense.findUnique({ where: { id } });
    const narr = (extra) => `NEFT-${V1.name.toUpperCase()}-${extra}`;
    const snapAcc = async () => JSON.stringify({
      e: await prisma.officeExpense.findMany({ orderBy: { id: 'asc' }, select: { id: true, approvalStatus: true, paidStatus: true, bankTxnId: true, paymentDate: true, monthlyAmount: true, billNumber: true, dueDate: true, vendorId: true } }),
      t: await prisma.bankTransaction.findMany({ orderBy: { id: 'asc' }, select: { id: true, reconStatus: true, billLinks: true, createdBillId: true, category: true, amount: true, reversalOfId: true } }),
      p: await prisma.invoicePayment.count(),
    });

    // ---- P1..P4: the founder's chain, bill -> shows in the portal -> Accounts pays -> statement imported -> engine matches -> Paid
    const B1 = await bookBill({});
    check('P', 'Accounts books an Airtel bill through its own screen API; the vendor master link is made by NAME (vendorId set): the bill is the provider\'s, no second system', (B1.r.status === 201 || B1.r.status === 200) && !!B1.id && (await expNow(B1.id)).vendorId === V1.id, [B1.r.status, B1.r.body]);
    const p1 = await portalBill(L1, B1.id);
    check('P', 'the new bill shows in the portal at once: Pending, 11800 total (10000 + 1800 tax), the due date, the invoice no., the Accounts reference; no payment date, no reference, not verified', p1 && p1.payment.status === 'Pending' && p1.total === 11800 && p1.amount === 10000 && p1.tax === 1800 && p1.dueDate === D(20) && p1.invoiceNo === B1.body.billNumber && !!p1.accountsRef && p1.payment.paymentDate === null && p1.payment.reference === null && p1.payment.verified === false, p1);
    const pay1 = await accountsPays(B1.id, D(-3));
    const p1b = await portalBill(L1, B1.id);
    check('P', 'Accounts processes the payment with its own workflow (Mark as Paid): the portal says "Paid by Accounts" - NOT "Paid" - because no bank statement line is matched yet', pay1.status === 200 && p1b.payment.status === 'Paid by Accounts' && p1b.payment.verified === false && p1b.payment.reference === null && p1b.payment.paymentDate === D(-3), [pay1.status, p1b.payment]);
    const imp1 = await importRows([row({ date: D(-3), desc: narr('BILL PAYMENT'), amount: 11800, ref: `HDFC${RUN}A001` })]);
    const L1line = await lineBy(`NEFT-${V1.name.toUpperCase()}-BILL PAYMENT`);
    const p1c = await portalBill(L1, B1.id);
    check('P', 'the statement is imported through the real import API; the existing engine matches the outgoing line to the bill (vendor in the narration, exact amount, date within tolerance); the bank line points back to the bill', imp1.status === 201 && imp1.body.imported === 1 && imp1.body.autoPosted === 1 && (await expNow(B1.id)).bankTxnId === L1line.id && (L1line.billLinks || '').includes(B1.id), [imp1.status, imp1.body.imported, imp1.body.autoPosted]);
    check('P', 'ONLY NOW the portal says Paid: verified, the paid amount in full, balance 0, the payment date of the statement line, and the MASKED reference (••••A001)', p1c.payment.status === 'Paid' && p1c.payment.verified === true && p1c.payment.basis === 'bank' && p1c.payment.paidAmount === 11800 && p1c.payment.balance === 0 && p1c.payment.paymentDate === D(-3) && p1c.payment.reference === '••••A001', p1c.payment);
    check('P', 'the portal never shows the bank\'s reference, line id, narration or balance of that payment', !JSON.stringify(p1c).includes(`HDFC${RUN}`) && !JSON.stringify(p1c).includes(L1line.id) && !/NEFT-/.test(JSON.stringify(p1c)) && !JSON.stringify(p1c).includes('48731'));
    const h1 = await vh(L1, 'GET', `${A}/bills/${encodeURIComponent(`exp:${B1.id}`)}`);
    check('P', 'bill history (audit): the bill recorded, the status change, and the bank match - plain words, who = Accounts / Bank statement, no staff names, no bank detail', h1.body.history.length >= 3 && h1.body.history.some((x) => /recorded in Accounts/.test(x.what)) && h1.body.history.some((x) => /Status changed from Pending to Paid/.test(x.what)) && h1.body.history.some((x) => /bank payment of .* is matched/.test(x.what)) && h1.body.history.every((x) => ['Accounts', 'Bank statement', 'You'].includes(x.by)) && !/ZZTEST ABP admin|HDFC/.test(h1.text), h1.body.history);

    // ---- P5: a bill still Pending, a bank transaction of the same amount exists: NOT Paid; then the approver matches it with the existing "Match bills"
    const B2 = await bookBill({ base: 5000, billDate: D(-20), dueDate: D(5) });
    const imp2 = await importRows([row({ date: D(-2), desc: narr('NEFT PAYMENT'), amount: 5900, ref: `HDFC${RUN}A002` })]);
    const L2line = await lineBy('NEFT PAYMENT');
    const p2a = await portalBill(L1, B2.id);
    check('P', 'a bank line of the same amount exists but the bill is not matched to it: the portal keeps Pending (a bank transaction alone never makes a bill Paid); due in 5 days = due soon', imp2.status === 201 && !(await expNow(B2.id)).bankTxnId && p2a.payment.status === 'Pending' && p2a.payment.verified === false && p2a.payment.dueSoon === true && p2a.payment.daysToDue === 5, [imp2.body.autoPosted, p2a.payment]);
    const m2 = await http('POST', `/api/bank/${L2line.id}/match-bills`, T.admin, { billIds: [B2.id] });
    const p2b = await portalBill(L1, B2.id);
    check('P', 'the approver matches the line to the bill with the existing "Match bills": Accounts records it Paid, the portal says Paid (verified) with the statement date', m2.status === 200 && p2b.payment.status === 'Paid' && p2b.payment.verified === true && p2b.payment.paymentDate === D(-2) && p2b.payment.paidAmount === 5900, [m2.status, p2b.payment]);

    // ---- P6: an unmatched same-amount line next to an overdue bill
    const B3 = await bookBill({ base: 3000, billDate: D(-30), dueDate: D(-1) });
    const imp3 = await importRows([row({ date: D(-1), desc: 'UPI-SOMEBODY ELSE-GROCERIES', amount: 3540, ref: `HDFC${RUN}A003` })]);
    const L3line = await lineBy('SOMEBODY ELSE');
    const p3 = await portalBill(L1, B3.id);
    check('P', 'an unmatched line of exactly the same amount does not pay the bill: Overdue (due date passed), not verified, no payment date; the line stays Unmatched in Accounts', imp3.status === 201 && p3.payment.status === 'Overdue' && p3.payment.overdue === true && p3.payment.verified === false && p3.payment.paymentDate === null && p3.payment.balance === 3540 && !(await expNow(B3.id)).bankTxnId && L3line.reconStatus === 'Unmatched', [p3.payment, L3line && L3line.reconStatus]);

    // ---- P7: partial payment. The truth table supports it (a matched line smaller than the bill), but today's bank screens refuse to create one
    // (Match bills stops at a bill bigger than the line), so the state is built the way the old Match bills left it, in the COPY.
    const B4 = await bookBill({ base: 20000, billDate: D(-25), dueDate: D(-3) });
    await importRows([row({ date: D(-2), desc: 'UPI-SOMEBODY ELSE-PART PAYMENT', amount: 10000, ref: `HDFC${RUN}A004` })]);
    const L4line = await lineBy('PART PAYMENT');
    await prisma.bankTransaction.update({ where: { id: L4line.id }, data: { category: 'Airtel Bill', categoryKind: 'expense', vendor: V1.name, billLinks: JSON.stringify([{ id: B4.id, approvalStatus: 'PENDING', paidStatus: 'Unpaid', paidAt: null, paidById: null, paymentDate: null, net: 23600 }]) } });
    await prisma.officeExpense.update({ where: { id: B4.id }, data: { bankTxnId: L4line.id } });
    const p4 = await portalBill(L1, B4.id);
    check('P', 'a part payment (the matched line is 10000 of a 23600 bill): Partially Paid, paid 10000, balance 13600, the line\'s date, a masked reference; the bill is also late, so the late flag stays', p4.payment.status === 'Partially Paid' && p4.payment.paidAmount === 10000 && p4.payment.balance === 13600 && p4.payment.paymentDate === D(-2) && p4.payment.reference === '••••A004' && p4.payment.overdue === true && p4.payment.verified === false, p4.payment);

    // ---- P8: a returned (failed / reversed) payment. The app has no screen that reverses a vendor payment (its "Reverse" is for money received),
    // so the state is written the way the truth table reads it: the debit is Reversed and a later credit line reverses it.
    const B5 = await bookBill({ base: 7000, billDate: D(-12), dueDate: D(10) });
    await accountsPays(B5.id, D(-4));
    await importRows([row({ date: D(-4), desc: narr('DEBIT'), amount: 8260, ref: `HDFC${RUN}A005` })]);
    const L5line = await lineBy('-DEBIT');
    const p5a = await portalBill(L1, B5.id);
    check('P', 'a second bill takes the whole chain the same way (Accounts pays, the statement is imported, the engine matches) and shows Paid with the masked reference (••••A005)', p5a.payment.status === 'Paid' && p5a.payment.verified && p5a.payment.reference === '••••A005', p5a.payment);
    await importRows([row({ date: D(-1), desc: 'UPI-BANK-RETURN OF PAYMENT', amount: 8260, type: 'Credit', ref: `HDFC${RUN}A006` })]);
    const L5rev = await lineBy('RETURN OF PAYMENT');
    await prisma.bankTransaction.update({ where: { id: L5line.id }, data: { reconStatus: 'Reversed', ignoredReason: 'returned by the bank' } });
    await prisma.bankTransaction.update({ where: { id: L5rev.id }, data: { reconStatus: 'Reversed', reversalOfId: L5line.id, matched: true } });
    const p5b = await portalBill(L1, B5.id);
    check('P', 'the bank returned the money: the portal says Reversed (never Paid), no payment date, no reference, the whole bill is outstanding again', p5b.payment.status === 'Reversed' && p5b.payment.verified === false && p5b.payment.paymentDate === null && p5b.payment.reference === null && p5b.payment.balance === 8260, p5b.payment);

    // ---- P9: Accounts undoes the match with its own "unmatch": the bill falls back to what Accounts alone says
    const B6 = await bookBill({ base: 4000, billDate: D(-9), dueDate: D(15) });
    await accountsPays(B6.id, D(-5));
    await importRows([row({ date: D(-5), desc: narr('UNDO TEST'), amount: 4720, ref: `HDFC${RUN}A007` })]);
    const L6line = await lineBy('UNDO TEST');
    const p6a = await portalBill(L1, B6.id);
    const un = await http('POST', `/api/bank/${L6line.id}/uncategorise`, T.admin, {});
    const p6b = await portalBill(L1, B6.id);
    check('P', 'Accounts undoes the bank match with its own "Undo": the bill falls back to what Accounts alone says = "Paid by Accounts" (the verified Paid is gone because the bank proof is gone)', p6a.payment.status === 'Paid' && un.status === 200 && p6b.payment.status === 'Paid by Accounts' && p6b.payment.verified === false && p6b.payment.reference === null, [un.status, p6a.payment.status, p6b.payment.status]);
    // the line is filed again by the engine's reconsider pass (or by hand) -> verified again
    const m6 = await http('POST', `/api/bank/${L6line.id}/match-bills`, T.admin, { billIds: [B6.id] });
    const p6c = await portalBill(L1, B6.id);
    check('P', 'matched again by hand: Paid (verified) again, one bank line, no duplicate', m6.status === 200 && p6c.payment.status === 'Paid' && p6c.payment.verified === true && (await prisma.bankTransaction.count({ where: { bankAccountId: bankA.id, description: { contains: 'UNDO TEST' } } })) === 1, [m6.status, p6c.payment]);

    // ---- P10: the statement arrives BEFORE the bill is booked: the existing engine files the payment as its own Accounts bill (one record, paid, proof = the line)
    const expCountBefore10 = await prisma.officeExpense.count({ where: { vendor: V1.name } });
    const imp10 = await importRows([row({ date: D(-6), desc: narr('NO BILL YET'), amount: 2360, ref: `HDFC${RUN}A010` })]);
    const L10line = await lineBy('NO BILL YET');
    const filed = await prisma.officeExpense.findMany({ where: { bankTxnId: L10line.id } });
    filed.forEach((e) => made.expenses.push(e.id));
    const rows10 = await vh(L1, 'GET', `${A}/bills?pageSize=100`);
    const mine10 = rows10.body.rows.find((r) => filed[0] && r.key === `exp:${filed[0].id}`);
    check('P', 'a payment with no bill yet is filed by the existing Accounts engine as ONE Accounts bill (paid, the bank line is its proof, the vendor kept by NAME only - which is why the portal also reads bills by the exact vendor name); the portal shows it once, Paid and verified, invoice number "Not recorded"', imp10.status === 201 && filed.length === 1 && !!mine10 && mine10.payment.status === 'Paid' && mine10.payment.verified === true && mine10.invoiceNo === null && mine10.total === 2360 && (await prisma.officeExpense.count({ where: { vendor: V1.name } })) === expCountBefore10 + 1, [imp10.status, filed.length, !!mine10, mine10 && mine10.invoiceNo, mine10 && mine10.total, expCountBefore10]);

    // ================================================================== D. importing the same statement again
    const before = await snapAcc();
    const countsBeforeD = { t: await prisma.bankTransaction.count(), e: await prisma.officeExpense.count(), a: await prisma.auditLog.count({ where: { entity: 'OfficeExpense' } }) };
    const statuses = async () => JSON.stringify((await vh(L1, 'GET', `${A}/bills?pageSize=100`)).body.rows.map((r) => [r.key, r.payment.status, r.payment.paidAmount, r.payment.balance, r.payment.paymentDate, r.payment.reference]));
    const stBefore = await statuses();
    const sameRows = [row({ date: D(-3), desc: narr('BILL PAYMENT'), amount: 11800, ref: `HDFC${RUN}A001` }), row({ date: D(-2), desc: narr('NEFT PAYMENT'), amount: 5900, ref: `HDFC${RUN}A002` }), row({ date: D(-6), desc: narr('NO BILL YET'), amount: 2360, ref: `HDFC${RUN}A010` })];
    // the very same lines (same date, amount and reference; the balance the first time was 487312.55 + n, so give the bank's own balances back)
    const orig = await prisma.bankTransaction.findMany({ where: { bankAccountId: bankA.id, reference: { in: sameRows.map((x) => x.reference) } } });
    sameRows.forEach((x) => { const o = orig.find((t) => t.reference === x.reference); x.balance = o ? o.balance : x.balance; });
    const rep1 = await importRows(sameRows, `zzabp-${RUN}-again.csv`);
    const rep2 = await importRows(sameRows, `zzabp-${RUN}-again2.csv`);
    check('D', 'importing the same lines again (twice): nothing is saved - 0 imported, every line reported as a duplicate', rep1.status === 201 && rep1.body.imported === 0 && rep1.body.duplicates === 3 && rep2.body.imported === 0 && rep2.body.duplicates === 3, [rep1.body.imported, rep1.body.duplicates, rep2.body.imported]);
    check('D', 'no second bank line, no second Accounts bill, no payment record, no status or link changed (full snapshot of every bill and line is identical)', (await snapAcc()) === before && (await prisma.bankTransaction.count()) === countsBeforeD.t && (await prisma.officeExpense.count()) === countsBeforeD.e, null);
    check('D', 'the portal shows exactly the same statuses, paid amounts, balances, dates and references after the re-import', (await statuses()) === stBefore, null);
    check('D', 'the re-import wrote no audit row on any Accounts bill (no noisy audit)', (await prisma.auditLog.count({ where: { entity: 'OfficeExpense' } })) === countsBeforeD.a);
    const overlap = await importRows([...sameRows, row({ date: D(-1), desc: 'UPI-SOMEBODY ELSE-NEW LINE', amount: 99.5, ref: `HDFC${RUN}A011` })], `zzabp-${RUN}-overlap.csv`);
    check('D', 'an overlapping statement (3 old lines + 1 new): only the new line is saved', overlap.status === 201 && overlap.body.imported === 1 && overlap.body.duplicates === 3 && (await statuses()) === stBefore, [overlap.body.imported, overlap.body.duplicates]);

    // ================================================================== L. the list: search, filters, sort, pages (vendor 1 now has many bills)
    const allV1 = (await vh(L1, 'GET', `${A}/bills?pageSize=100`)).body;
    const pg1 = await vh(L1, 'GET', `${A}/bills?pageSize=5&page=1`);
    const pg2 = await vh(L1, 'GET', `${A}/bills?pageSize=5&page=2`);
    check('L', `pages: pageSize 5 gives ${pg1.body.pages} pages for ${allV1.total} bills; page 2 holds different bills; the page numbers and totals agree`, pg1.body.rows.length === 5 && pg1.body.total === allV1.total && pg1.body.pages === Math.ceil(allV1.total / 5) && pg2.body.page === 2 && pg2.body.rows.every((r) => !pg1.body.rows.some((x) => x.key === r.key)), [pg1.body.pages, allV1.total]);
    const facetPaid = (allV1.facets.status.find((x) => x.value === 'Paid') || {}).count;
    const fPaid = await vh(L1, 'GET', `${A}/bills?status=Paid&pageSize=100`);
    check('L', 'status filter: "Paid" returns exactly the bills the facet counted, all verified', fPaid.body.total === facetPaid && fPaid.body.rows.every((r) => r.payment.status === 'Paid' && r.payment.verified), [fPaid.body.total, facetPaid]);
    check('L', 'status filter + the facet counts agree with an independent group-by of the list', allV1.facets.status.every((f) => allV1.rows.filter((r) => r.payment.status === f.value).length === f.count));
    const byTotalAsc = await vh(L1, 'GET', `${A}/bills?sort=total&dir=asc&pageSize=100`);
    const tt = byTotalAsc.body.rows.map((r) => r.total);
    check('L', 'sort by total ascending is really ascending; descending is the reverse', tt.every((v, i) => i === 0 || tt[i - 1] <= v) && JSON.stringify((await vh(L1, 'GET', `${A}/bills?sort=total&dir=desc&pageSize=100`)).body.rows.map((r) => r.total)) === JSON.stringify([...tt].reverse()), tt);
    const qInv = await vh(L1, 'GET', `${A}/bills?q=${encodeURIComponent(B2.body.billNumber)}`);
    check('L', 'search by invoice number finds that one bill; search by Accounts reference finds it; a nonsense word finds nothing', qInv.body.total === 1 && qInv.body.rows[0].key === `exp:${B2.id}` && (await vh(L1, 'GET', `${A}/bills?q=${encodeURIComponent((await portalBill(L1, B2.id)).accountsRef)}`)).body.total === 1 && (await vh(L1, 'GET', `${A}/bills?q=zzznothing`)).body.total === 0);
    const ym40 = ymOf(D(-40));
    const byMonth = await vh(L1, 'GET', `${A}/bills?period=${ym40}&pageSize=100`);
    check('L', `billing-period filter ${ym40}: only that month's bills, and it matches the facet`, byMonth.body.rows.length > 0 && byMonth.body.rows.every((r) => r.billMonth === ym40) && byMonth.body.total === allV1.facets.month.find((m) => m.value === ym40).count);
    const rngFrom = await vh(L1, 'GET', `${A}/bills?from=${ymOf(D(-10))}&to=${ymOf(D(-10))}&pageSize=100`);
    check('L', 'month range filter (from = to = this month) keeps only that month; a bad month value is ignored, not an error', rngFrom.status === 200 && rngFrom.body.rows.every((r) => r.billMonth === ymOf(D(-10))) && (await vh(L1, 'GET', `${A}/bills?from=garbage&period=%27%3B--`)).status === 200);
    check('L', 'the summary on the list equals an independent sum of the rows that count (Accounts-linked, not a duplicate): billed, paid, outstanding', (() => { const l = allV1.rows.filter((r) => r.linked && r.counted); return allV1.summary.count === l.length && allV1.summary.billed === rs2(l.reduce((t, r) => t + r.payable, 0)) && allV1.summary.paid === rs2(l.reduce((t, r) => t + r.payment.paidAmount, 0)) && allV1.summary.outstanding === rs2(l.reduce((t, r) => t + r.payment.balance, 0)); })(), allV1.summary);
    const pt = allV1.rows.find((r) => r.key === `exp:${B4.id}`);
    check('P', 'the part payment is outstanding 13600 in the list totals (counted once as paid 10000), never as fully paid', pt.payment.paidAmount === 10000 && pt.payment.balance === 13600 && allV1.summary.outstanding >= 13600, [pt.payment, allV1.summary]);

    // ================================================================== O. overdue, due soon, alerts - a vendor whose bills we control completely
    const V3 = await mkVendor('Alerts', `ZZTEST ABP Airtel Alerts ${RUN}`);
    const L3 = await mkLogin(V3, 't3');
    await addModules(L3, ['airtel_bills'], { airtel_bills: { sendBill: true } });
    await sign(L3);
    const bk3 = (o) => bookBill({ vendor: V3.name, ...o });
    const o1 = await bk3({ base: 2000, billDate: D(-40), dueDate: D(-5) });
    const o2 = await bk3({ base: 2100, billDate: D(-20), dueDate: D(2) });
    const o3 = await bk3({ base: 2200, billDate: D(-20), dueDate: D(0) });
    const o4 = await bk3({ base: 2300, billDate: D(-20), dueDate: D(7) });
    const o5 = await bk3({ base: 2400, billDate: D(-20), dueDate: D(8) });
    const o6 = await bk3({ base: 2500, billDate: D(-20), dueDate: D(40) });
    const o7 = await bk3({ base: 2600, billDate: D(-40), dueDate: D(-10) });
    await accountsPays(o7.id, D(-9));
    const o8 = await bk3({ base: 1000, billDate: D(-20), dueDate: D(5) });
    await accountsPays(o8.id, D(-2));
    const o9 = await bk3({ base: 1500, billDate: D(-50), dueDate: D(-25) });
    await accountsPays(o9.id, D(-30));
    const narr3 = (x) => `NEFT-${V3.name.toUpperCase()}-${x}`;
    await importRows([row({ date: D(-2), desc: narr3('PAID 8'), amount: 1180 }), row({ date: D(-30), desc: narr3('PAID 9'), amount: 1770 })], `zzabp-${RUN}-v3.csv`);
    const dup1 = await bk3({ base: 2700, billDate: D(-20), dueDate: D(-3), invoice: `ZZABPDUP${RUN}` });
    const dup2 = await bk3({ base: 2700, billDate: D(-19), dueDate: D(-3), invoice: `ZZABPDUP${RUN}` });
    const ov3 = await vh(L3, 'GET', `${A}/overview`);
    const bl3 = (await vh(L3, 'GET', `${A}/bills?pageSize=100`)).body;
    const st3 = (id) => (bl3.rows.find((r) => r.key === `exp:${id}`) || {}).payment;
    check('O', 'overdue = due date passed and unpaid (IST day): the -5 days bill is Overdue; due today is NOT overdue; due in 8 and 40 days are plain Pending', st3(o1.id).status === 'Overdue' && st3(o3.id).status === 'Pending' && st3(o5.id).status === 'Pending' && st3(o6.id).status === 'Pending' && st3(o3.id).overdue === false, [o1, o3, o5, o6].map((o) => st3(o.id) && st3(o.id).status));
    check('O', 'due soon = unpaid and due within 7 days (today counts): +2, 0 and +7 days yes; +8 and +40 days no', st3(o2.id).dueSoon && st3(o3.id).dueSoon && st3(o4.id).dueSoon && !st3(o5.id).dueSoon && !st3(o6.id).dueSoon && !st3(o1.id).dueSoon, [o2, o3, o4, o5, o6].map((o) => st3(o.id).dueSoon));
    check('O', 'a bill Accounts has paid is never overdue or due soon, whatever its due date (-10 days)', st3(o7.id).status === 'Paid by Accounts' && !st3(o7.id).overdue && !st3(o7.id).dueSoon);
    check('O', 'two verified payments (2 days ago, 30 days ago) are both Paid with their statement dates', st3(o8.id).status === 'Paid' && st3(o8.id).paymentDate === D(-2) && st3(o9.id).status === 'Paid' && st3(o9.id).paymentDate === D(-30), [st3(o8.id), st3(o9.id)]);
    const alertKeys = (k) => ov3.body.alerts.filter((a) => a.kind === k).map((a) => a.key).sort();
    check('O', 'alerts: overdue = the one overdue bill; due soon = the three bills due within 7 days; payment confirmed = only the payment of the last 14 days (not the 30-day-old one)', JSON.stringify(alertKeys('overdue')) === JSON.stringify([`exp:${o1.id}`, `exp:${dup1.id}`].sort()) && JSON.stringify(alertKeys('due_soon')) === JSON.stringify([`exp:${o2.id}`, `exp:${o3.id}`, `exp:${o4.id}`, `exp:${o8.id}`].filter((k) => k !== `exp:${o8.id}`).sort()) && JSON.stringify(alertKeys('paid')) === JSON.stringify([`exp:${o8.id}`]), [alertKeys('overdue'), alertKeys('due_soon'), alertKeys('paid')]);
    const keys3 = ov3.body.alerts.map((a) => a.key);
    check('O', 'no duplicate alerts: one alert per bill, even for the same invoice booked twice in Accounts (the second copy is flagged as a duplicate and does not speak)', new Set(keys3).size === keys3.length && !keys3.includes(`exp:${dup2.id}`), keys3);
    const ov3b = await vh(L3, 'GET', `${A}/overview`);
    check('O', 'asking again gives the same alerts (nothing is stored, nothing is sent twice); the order is overdue, due soon, payment confirmed', JSON.stringify(ov3b.body.alerts) === JSON.stringify(ov3.body.alerts) && ['overdue', 'due_soon', 'paid'].join() === [...new Set(ov3.body.alerts.map((a) => a.kind))].join());
    const d2row = bl3.rows.find((r) => r.key === `exp:${dup2.id}`);
    check('O', 'the same invoice number and amount booked twice in Accounts: both stay visible, the second is marked "duplicate of" the first and is NOT counted in the totals', !!d2row && d2row.duplicateOf && d2row.counted === false && bl3.rows.find((r) => r.key === `exp:${dup1.id}`).counted === true && bl3.summary.count === bl3.rows.filter((r) => r.linked && r.counted).length, d2row);
    check('O', 'overview numbers agree with the rows: pending, overdue, due soon, paid, paid by Accounts counts', ov3.body.bills.paid === 2 && ov3.body.bills.paidByAccounts === 1 && ov3.body.bills.overdue === 2 && ov3.body.bills.dueSoon === 3 && ov3.body.bills.pending === 5 && ov3.body.bills.count === 10, ov3.body.bills);

    // ================================================================== M. monthly history = an independent recomputation
    const V4 = await mkVendor('History', `ZZTEST ABP Airtel History ${RUN}`);
    const L4 = await mkLogin(V4, 't4');
    await addModules(L4, ['airtel_bills']);
    await sign(L4);
    const monthDay = (k, day) => { const d = new Date(`${TODAY.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - k); return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`; };
    const bk4 = (o) => bookBill({ vendor: V4.name, ...o });
    const hA = await bk4({ base: 10000, billDate: monthDay(4, 10), dueDate: monthDay(4, 25) });
    const hB = await bk4({ base: 5000, billDate: monthDay(4, 12), dueDate: monthDay(4, 28) });
    await accountsPays(hB.id, monthDay(4, 20));
    const hC = await bk4({ base: 3000, billDate: monthDay(2, 15), dueDate: D(10) });
    const hm = await vh(L4, 'GET', `${A}/history?pageSize=100`);
    const ymA = monthDay(4, 10).slice(0, 7); const ymC = monthDay(2, 15).slice(0, 7);
    const expectedMonths = []; for (let k = 4; k >= 0; k -= 1) expectedMonths.push(monthDay(k, 1).slice(0, 7));
    const byM = new Map((hm.body.rows || []).map((r) => [r.month, r]));
    check('M', `one row for every month from the first bill (${ymA}) to this month: ${expectedMonths.join(', ')}; months without a bill are "No bill recorded"`, JSON.stringify((hm.body.rows || []).map((r) => r.month).sort()) === JSON.stringify(expectedMonths) && expectedMonths.filter((m) => m !== ymA && m !== ymC).every((m) => byM.get(m).noBill && byM.get(m).billAmount === null && byM.get(m).status === null), (hm.body.rows || []).map((r) => [r.month, r.noBill]));
    const mA = byM.get(ymA);
    check('M', `month ${ymA}: two bills (11800 unpaid + 5900 paid by Accounts): billed 17700, paid 5900, outstanding 11800, status = the worst (Overdue), the earliest due date, both invoice numbers`, mA.bills === 2 && mA.billAmount === 17700 && mA.paidAmount === 5900 && mA.outstanding === 11800 && mA.status === 'Overdue' && mA.dueDate === monthDay(4, 25) && mA.invoiceNos.length === 2 && mA.invoiceNos.includes(hA.body.billNumber), mA);
    const mC = byM.get(ymC);
    check('M', `month ${ymC}: one pending bill 3540 due in 10 days: billed 3540, paid 0, outstanding 3540, Pending`, mC.bills === 1 && mC.billAmount === 3540 && mC.paidAmount === 0 && mC.outstanding === 3540 && mC.status === 'Pending' && mC.dueDate === D(10), mC);
    check('M', 'totals equal an independent recomputation of the three bills: billed 21240, paid 5900, outstanding 15340, 2 months with bills', hm.body.totals.billed === 21240 && hm.body.totals.paid === 5900 && hm.body.totals.outstanding === 15340 && hm.body.totals.months === 2, hm.body.totals);
    // the independent oracle straight from the database
    {
      const dbx = await prisma.officeExpense.findMany({ where: { vendorId: V4.id } });
      const bill = dbx.reduce((t, e) => t + e.monthlyAmount - e.tdsAmount, 0);
      const paid = dbx.filter((e) => e.approvalStatus === 'PAID').reduce((t, e) => t + e.monthlyAmount - e.tdsAmount, 0);
      check('M', 'the same totals straight from the OfficeExpense rows of the database', rs2(bill) === hm.body.totals.billed && rs2(paid) === hm.body.totals.paid && rs2(bill - paid) === hm.body.totals.outstanding, [bill, paid]);
    }
    const hf1 = await vh(L4, 'GET', `${A}/history?period=${ymA}`);
    const hf2 = await vh(L4, 'GET', `${A}/history?status=Overdue&pageSize=100`);
    const hf3 = await vh(L4, 'GET', `${A}/history?from=${ymC}&pageSize=100`);
    const hf4 = await vh(L4, 'GET', `${A}/history?q=${encodeURIComponent(hC.body.billNumber)}`);
    const hfAsc = await vh(L4, 'GET', `${A}/history?sort=month&dir=asc&pageSize=100`);
    check('M', 'filters: by period (one month), by status (Overdue = one month), from-month (this month and later), by invoice number; sort by month ascending', hf1.body.rows.length === 1 && hf2.body.rows.length === 1 && hf2.body.rows[0].month === ymA && hf3.body.rows.every((r) => r.month >= ymC) && hf4.body.rows.length === 1 && hf4.body.rows[0].month === ymC && JSON.stringify(hfAsc.body.rows.map((r) => r.month)) === JSON.stringify(expectedMonths), [hf1.body.rows.length, hf2.body.rows.length, hf4.body.rows.length]);
    check('M', 'another vendor\'s months never mix in: vendor 1\'s history has none of these invoice numbers, vendor 4\'s has none of vendor 1\'s', !JSON.stringify((await vh(L1, 'GET', `${A}/history?pageSize=100`)).body).includes(hA.body.billNumber) && !JSON.stringify(hm.body).includes(B1.body.billNumber));

    // ================================================================== X. send a bill (the existing monthly-bill upload) + duplicate rules
    const curYm = TODAY.slice(0, 7);
    const modCount = async () => (await raw('SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "vendorId" = ?', V1.id))[0].n;
    const expCount = async () => (await raw('SELECT COUNT(*) AS n FROM "OfficeExpense"'))[0].n;
    const send = (L, f, opt = {}) => {
      const fd = upload(opt.file || pdf('airtel'), opt.name || 'airtel-bill.pdf', opt.type || 'application/pdf', f);
      return vh(L, 'POST', `${A}/bills`, undefined, { form: fd, headers: opt.headers });
    };
    const usageNum = (/(\d{10})/.exec(simsDb[0].name) || [])[1]; // a real SIM of the copy: its own charge line on the sent bill (SIM-wise usage, 2026-10-29)
    const fields = (o = {}) => ({ billNumber: `ZZABPSEND${RUN}A`, period: curYm, dueDate: D(15), billDate: D(-1), amount: '8000', gst: '1440', remarks: 'ref 9963418222 call me', lines: JSON.stringify([{ number: usageNum, amount: 450 }]), ...o });
    const listBefore = (await vh(L1, 'GET', `${A}/bills?pageSize=100`)).body;
    const ovBefore = (await vh(L1, 'GET', `${A}/overview`)).body;
    const expBefore = await expCount(); const modBefore = await modCount();
    const x1 = await send(L1, fields({ billNumber: B1.body.billNumber, period: ymOf(D(-70)) }));
    check('X', 'a bill whose invoice number Accounts already holds is refused (409, says Accounts has it); nothing is saved', x1.status === 409 && /Accounts already has bill/.test(x1.body.error) && (await modCount()) === modBefore, [x1.status, x1.body]);
    const x2 = await send(L1, fields({ billNumber: `ZZABPSEND${RUN}B`, amount: '7000', gst: '1260', period: ymOf(D(-12)) }));
    check('X', 'the same month AND the same amount as a bill in Accounts (different invoice number) is refused (409)', x2.status === 409 && /same amount/.test(x2.body.error) && (await modCount()) === modBefore, [x2.status, x2.body]);
    const x3 = await send(L1, fields({ status: 'Paid' }));
    const x3b = await send(L1, fields({ paidOn: D(-1), paymentRef: 'X' }));
    const x3c = await send(L1, fields({ vendorId: V2.id }));
    check('X', 'a vendor cannot set a status or a payment while sending: status / paidOn / paymentRef / vendorId are refused (400 with the refused field names); nothing is saved', x3.status === 400 && x3.body.refusedFields.includes('status') && x3b.status === 400 && x3b.body.refusedFields.includes('paidOn') && x3c.status === 400 && x3c.body.refusedFields.includes('vendorId') && (await modCount()) === modBefore, [x3.status, x3b.status, x3c.status]);
    const idemKey = `abp-${RUN}-key-0001`;
    const x4 = await send(L1, fields(), { headers: { 'Idempotency-Key': idemKey } });
    check('X', 'a valid bill is sent (201): the answer holds only the bill\'s own fields, the remark as typed (full number since 2026-10-29), the status is "Waiting for Accounts"', x4.status === 201 && x4.body.bill.billNumber === `ZZABPSEND${RUN}A` && x4.body.bill.total === 9440 && x4.body.bill.status === 'Waiting for Accounts' && x4.body.bill.remarks === 'ref 9963418222 call me' && !/vendorId|vendorUserId|reviewed|idempotency/i.test(x4.text), x4.body);
    if (x4.body && x4.body.bill) made.modbills.push(x4.body.bill.billCode);
    const x4r = await send(L1, fields(), { headers: { 'Idempotency-Key': idemKey } });
    check('X', 'the same click sent again (same Idempotency-Key) saves nothing new', x4r.status === 201 && x4r.body.duplicateRequest === true && (await modCount()) === modBefore + 1, [x4r.status, x4r.body && x4r.body.duplicateRequest]);
    const x5 = await send(L1, fields());
    const x5b = await send(L1, fields({ billNumber: `ZZABPSEND${RUN}C`, amount: '123', gst: '0' }));
    check('X', 'the same invoice number again is refused (409); another bill for the same month is refused (409, the existing monthly rule)', x5.status === 409 && /already sent/.test(x5.body.error) && x5b.status === 409 && /already sent/.test(x5b.body.error) && (await modCount()) === modBefore + 1, [x5.status, x5.body, x5b.status, x5b.body]);
    check('X', 'sending creates NO Accounts expense (Accounts books the payable itself): OfficeExpense has the same number of rows', (await expCount()) === expBefore);
    const afterSend = (await vh(L1, 'GET', `${A}/bills?pageSize=100`)).body;
    const sentRow = afterSend.rows.find((r) => r.source === 'Sent by you');
    // ---- SIM-wise monthly usage + full-number search (2026-10-29), from what the bills really hold
    const uOk = (await vh(L1, 'GET', `${A}/history?sim=${usageNum}&period=${curYm}`)).body.simUsage;
    // the month's total bill amount, read independently from the bill list: every bill of that month (a bill Accounts holds twice counts once)
    const monthTotal = (ym) => Math.round(afterSend.rows.filter((r) => r.billMonth === ym && r.payment.status !== 'Rejected' && (r.linked ? r.counted : true)).reduce((t, r) => t + r.total, 0) * 100) / 100;
    check('U', 'SIM-wise usage: the SIM + this month shows ITS charge line from the bill (450), the month\'s total bill amount (an independent sum of that month\'s bills), nothing estimated', !!uOk && uOk.available === true && uOk.usageTotal === 450 && uOk.billTotal === monthTotal(curYm) && uOk.sim && uOk.sim.number === usageNum && uOk.bills.some((b) => b.lines.length === 1 && b.lines[0].amount === 450 && b.billTotal === 9440), [uOk && uOk.usageTotal, uOk && uOk.billTotal, monthTotal(curYm)]);
    const totalOnly = afterSend.rows.find((r) => r.source === 'Accounts' && !(r.lines || []).length && r.billMonth && r.billMonth !== curYm);
    if (totalOnly) {
      const uNo = (await vh(L1, 'GET', `${A}/history?sim=${usageNum}&period=${totalOnly.billMonth}`)).body.simUsage;
      check('U', 'a month whose bill has no per-SIM lines: usage NOT available, a clear message naming that bill and its total; no number made up', !!uNo && uNo.available === false && /total only/.test(uNo.message) && uNo.usageTotal === undefined && uNo.billTotal === monthTotal(totalOnly.billMonth) && uNo.message.includes(String(totalOnly.invoiceNo || 'bill')), [uNo && uNo.message, uNo && uNo.billTotal, monthTotal(totalOnly.billMonth)]);
    }
    const uNone = (await vh(L1, 'GET', `${A}/history?sim=${usageNum}&period=2019-01`)).body.simUsage;
    check('U', 'a month with no bill at all: "There is no Airtel bill for ..."', !!uNone && uNone.available === false && /no Airtel bill/.test(uNone.message), uNone);
    const byNum = (await vh(L1, 'GET', `${A}/bills?q=${encodeURIComponent(`+91 ${usageNum}`)}`)).body;
    check('U', 'the Bills search box finds a bill by the FULL SIM number (typed with +91), and the bill shows that number in full', byNum.rows.length === 1 && byNum.rows[0].source === 'Sent by you' && byNum.rows[0].lines.some((l) => l.number === usageNum), byNum.rows.map((r) => [r.invoiceNo, r.lines]));
    check('X', 'the sent bill is listed once as "Sent by you": Waiting for Accounts, billing period and due date as the vendor typed them, the remark as typed, NOT counted in the money totals (Accounts does not hold it yet)', afterSend.total === listBefore.total + 1 && !!sentRow && sentRow.payment.status === 'Waiting for Accounts' && sentRow.linked === false && sentRow.period === curYm && sentRow.dueDate === D(15) && sentRow.total === 9440 && sentRow.remarks === 'ref 9963418222 call me' && JSON.stringify(afterSend.summary) === JSON.stringify(listBefore.summary), [sentRow, afterSend.summary, listBefore.summary]);
    const ovAfter = (await vh(L1, 'GET', `${A}/overview`)).body;
    check('X', 'the overview money (billed / paid / outstanding) is unchanged by a bill that is only sent; the count of bills not yet in Accounts is 1', JSON.stringify(ovAfter.money) === JSON.stringify(ovBefore.money) && ovAfter.bills.notInAccounts === 1 && ovAfter.bills.waiting === 1, [ovAfter.money, ovAfter.bills]);
    const acct = await http('GET', '/api/vendor-module-bills', T.admin);
    check('X', 'Accounts sees it in its existing review list "Vendor invoices and monthly bills" (the same queue as before)', acct.status === 200 && acct.body.rows.some((r) => r.billNumber === `ZZABPSEND${RUN}A` && r.status === 'Submitted'), acct.status);
    const noSend = await Promise.all([send(L1n, fields({ billNumber: 'ZZABPN1' })), send(LR, fields({ billNumber: 'ZZABPN2' })), send(LF, fields({ billNumber: 'ZZABPN3' })), send(LAs, fields({ billNumber: 'ZZABPN4' })), send(LCat, fields({ billNumber: 'ZZABPN5' }))]);
    check('X', 'without the "Send a bill" tick (or not a telecom vendor) nothing can be sent: 403 for the no-tick login, the real-vendor login, the category-only login, and the finance / Assets vendors (wall)', noSend.every((r) => r.status === 403), noSend.map((r) => r.status));
    // Accounts books the same invoice -> ONE row (folded), enriched with what only the vendor's bill holds
    const rowsBeforeFold = afterSend.total;
    const fold = await bookBill({ base: 8000, gst: 1440, billDate: D(-1), dueDate: null, invoice: `ZZABPSEND${RUN}A` });
    const afterFold = (await vh(L1, 'GET', `${A}/bills?pageSize=100`)).body;
    const same = afterFold.rows.filter((r) => r.invoiceNo === `ZZABPSEND${RUN}A`);
    check('X', 'Accounts then books that very invoice: the portal shows ONE bill, not two - the Accounts row, with the billing period, the due date and the VM- code from the bill the vendor sent', afterFold.total === rowsBeforeFold && same.length === 1 && same[0].key === `exp:${fold.id}` && same[0].sentByYou === true && same[0].period === curYm && same[0].dueDate === D(15) && /^VM-\d{5}$/.test(same[0].billCode) && same[0].linked === true && same[0].payment.status === 'Pending', same);
    check('X', 'and now it counts in the totals (Accounts holds it): billed +9440', afterFold.summary.count === afterSend.summary.count + 1 && rs2(afterFold.summary.billed - afterSend.summary.billed) === 9440, [afterSend.summary, afterFold.summary]);
    // a sent bill Accounts typed Paid by hand in its review list (no bank statement) is "Paid by Accounts", never "Paid"
    const x6 = await send(L1, fields({ billNumber: `ZZABPSEND${RUN}D`, period: ymOf(D(-95)), dueDate: D(-80), amount: '6000', gst: '1080', remarks: '' }));
    const x6id = x6.body && x6.body.bill && (await raw('SELECT "id" FROM "VendorModuleBill" WHERE "billCode" = ?', x6.body.bill.billCode))[0].id;
    const w6a = (await vh(L1, 'GET', `${A}/bills?q=ZZABPSEND${RUN}D`)).body.rows[0];
    check('X', 'a sent bill whose due date has passed but which Accounts has not booked yet is "Waiting for Accounts" (not Overdue: nothing is owed in Accounts yet)', x6.status === 201 && w6a.payment.status === 'Waiting for Accounts' && w6a.payment.overdue === false, w6a && w6a.payment);
    await http('POST', `/api/vendor-module-bills/${x6id}/approve`, T.admin, {});
    const w6b = (await vh(L1, 'GET', `${A}/bills?q=ZZABPSEND${RUN}D`)).body.rows[0];
    await http('POST', `/api/vendor-module-bills/${x6id}/paid`, T.admin, { paidOn: D(-70), reference: 'MANUAL-REF-77', amount: 7080, mode: 'Bank Transfer' });
    const w6c = (await vh(L1, 'GET', `${A}/bills?q=ZZABPSEND${RUN}D`)).body.rows[0];
    check('X', 'Accounts approves it (Pending, overdue by its due date), then types "Paid" by hand: the portal says "Paid by Accounts", NOT "Paid" - no bank statement has confirmed it - and shows no reference', w6b.payment.status === 'Overdue' && w6c.payment.status === 'Paid by Accounts' && w6c.payment.verified === false && w6c.payment.reference === null && !JSON.stringify(w6c).includes('MANUAL-REF-77') && w6c.payment.paymentDate === D(-70), [w6b.payment.status, w6c.payment]);

    // ================================================================== Q. the bill copy (signed download with an ownership check)
    const att = await http('POST', `/api/office-expenses/${B2.id}/proof`, T.admin, undefined, { form: upload(pdf('bill-copy'), 'airtel-invoice.pdf', 'application/pdf') });
    const dl = await vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B2.id}` });
    const got = dl.body && dl.body.url ? await http('GET', dl.body.url, null) : null;
    check('Q', 'Accounts attaches the bill copy; the vendor asks for a signed link with its bill key and downloads the same bytes (the link works without a header, is signed and short-lived)', att.status === 200 && dl.status === 200 && !!got && got.status === 200 && Buffer.compare(got.buf, pdf('bill-copy')) === 0 && /pdf/.test(got.headers.get('content-type')) && dl.body.expiresInSeconds > 0, [att.status, dl.status, got && got.status]);
    const sentId = (await raw('SELECT "id" FROM "VendorModuleBill" WHERE "billCode" = ?', x4.body.bill.billCode))[0].id;
    const dl2 = await vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `mod:${x6id}` });
    const got2 = dl2.body && dl2.body.url ? await http('GET', dl2.body.url, null) : null;
    const dl3 = await vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${fold.id}` });
    const got3 = dl3.body && dl3.body.url ? await http('GET', dl3.body.url, null) : null;
    check('Q', 'a bill the vendor sent (not yet in Accounts) downloads its own file; once Accounts books it, the same file opens through the Accounts row it was folded into (and the old mod: key is gone: one bill, one key)', dl2.status === 200 && got2 && Buffer.compare(got2.buf, pdf('airtel')) === 0 && dl3.status === 200 && got3 && Buffer.compare(got3.buf, pdf('airtel')) === 0 && (await vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `mod:${sentId}` })).status === 403);
    const denied = await Promise.all([
      vh(L2, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B2.id}` }), vh(L2, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `mod:${x6id}` }),
      vh(LF, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B2.id}` }), vh(LAs, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B2.id}` }), vh(LId, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B2.id}` }),
      vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${o1.id}` }), vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: 'exp:nonsense' }), vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'airtel-bill', id: `exp:${B1.id}` }),
      vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'module-bill', id: sentId }), vh(L1, 'POST', '/api/vendor-portal/download-link', { kind: 'bill', id: B2.id }),
    ]);
    check('Q', 'ownership: another telecom vendor, a finance / Assets / ID-card vendor, another vendor\'s bill, an unknown key, a bill without a file, and the finance file kinds are all refused (403)', denied.every((r) => r.status === 403), denied.map((r) => r.status));
    const tokenOnly = dl.body.url.split('/').pop();
    const forged = await http('GET', `/api/vendor-portal/files/${tokenOnly.slice(0, -3)}abc`, null);
    check('Q', 'a tampered download link does not open (403)', forged.status === 403, forged.status);

    // ================================================================== Z. security
    const snapZ = await snapAcc();
    const bkey = `exp:${B1.id}`;
    const wr = await Promise.all([
      vh(L1, 'POST', `${A}/bills/${encodeURIComponent(bkey)}`, { status: 'Paid' }), vh(L1, 'PATCH', `${A}/bills/${encodeURIComponent(bkey)}`, { paymentStatus: 'Paid', paid: true }), vh(L1, 'PUT', `${A}/bills/${encodeURIComponent(bkey)}`, { paidOn: D(-1), utr: 'X' }),
      vh(L1, 'DELETE', `${A}/bills/${encodeURIComponent(bkey)}`), vh(L1, 'PATCH', `${A}/bills/${encodeURIComponent(bkey)}`, { dueDate: D(30) }), vh(L1, 'POST', `${A}/overview`, { status: 'Paid' }), vh(L1, 'POST', `${A}/history`, {}),
    ]);
    check('Z', 'a vendor cannot set a bill paid or change a status: a status / paid / payment field answers 400 with the field names; any other write on a bill answers 405; writes on overview / history are refused', wr[0].status === 400 && wr[0].body.refusedFields.includes('status') && wr[1].status === 400 && wr[1].body.refusedFields.includes('paymentStatus') && wr[2].status === 400 && wr[3].status === 405 && wr[4].status === 405 && wr[5].status === 403 && wr[6].status === 403, wr.map((r) => r.status));
    check('Z', 'after all of that no Accounts bill, bank line or payment changed (full snapshot identical) and the bill still says what Accounts says', (await snapAcc()) === snapZ && (await portalBill(L1, B1.id)).payment.status === 'Paid');
    const idorA = await vh(L2, 'GET', `${A}/bills/${encodeURIComponent(bkey)}`);
    const idorB = await vh(L2, 'GET', `${A}/bills/${encodeURIComponent('exp:doesnotexist')}`);
    check('Z', 'IDOR: another vendor asking for my bill by its key gets 403 - exactly the answer for a key that does not exist', idorA.status === 403 && JSON.stringify(idorA.body) === JSON.stringify(idorB.body), [idorA.status, idorB.status]);
    const idorC = await vh(L1, 'GET', `${A}/bills/${encodeURIComponent(`exp:${o1.id}`)}`);
    const idorD = await vh(L4, 'GET', `${A}/bills/${encodeURIComponent(`mod:${sentId}`)}`);
    check('Z', 'IDOR: vendor 1 cannot open vendor 3\'s bill, vendor 4 cannot open vendor 1\'s sent bill (403), and a key in another shape (../, other prefix, SQL) is 403 too', idorC.status === 403 && idorD.status === 403 && (await Promise.all(['../x', 'rep:1', 'exp:%27%20OR%201=1--', `exp:${B1.id}%00`].map((k) => vh(L1, 'GET', `${A}/bills/${k}`)))).every((r) => r.status === 403), [idorC.status, idorD.status]);
    const q2 = await vh(L2, 'GET', `${A}/bills?vendorId=${V1.id}&vendorUserId=${L1.u.id}&sim=AST-0146`);
    const hq2 = await vh(L2, 'GET', `${A}/history?vendorId=${V1.id}`);
    check('Z', 'a vendor id / vendor user id in the query changes nothing: vendor 2 still sees only its own (nothing)', q2.body.all === 0 && hq2.body.rows.length === 0 && !q2.text.includes(B1.body.billNumber));
    // the sweep: every response a vendor got during this whole run
    const allTxt = swept.map((x) => x.text).join('\n');
    const simNumbers = [...new Set(simsDb.map((d) => digits(d.name)).filter(Boolean))];
    const unrelated = await bookBill({ vendor: `ZZTEST ABP Unrelated Vendor ${RUN}`, base: 77777, invoice: `ZZABPUNREL${RUN}`, billDate: D(-5), dueDate: D(-1) });
    await vh(L1, 'GET', `${A}/bills?pageSize=100`); await vh(L1, 'GET', `${A}/history?pageSize=100`); await vh(L1, 'GET', `${A}/overview`); await vh(L1, 'GET', `${A}/sims?pageSize=100`); await vh(LR, 'GET', `${A}/sims?pageSize=100`);
    const allTxt2 = swept.map((x) => x.text).join('\n');
    const bankLineIds = (await prisma.bankTransaction.findMany({ where: { bankAccountId: bankA.id }, select: { id: true } })).map((t) => t.id);
    const leaks = [];
    // 2026-10-29: full SIM numbers are SHOWN on purpose (founder) - so they are no longer a leak; everything else below still is.
    check('Z', 'the full SIM numbers are shown (the portal\'s own SIMs, 2026-10-29)', simNumbers.some((n) => allTxt2.includes(n)), simNumbers.length);
    [[BANK_ACC_NO, 'bank account number'], ['ZZTEST ABP Bank', 'bank name'], ['SOMEBODY ELSE', 'a narration'], ['UPI-BANK-RETURN', 'a narration'], ['NEFT-', 'a narration'], [`HDFC${RUN}`, 'a bank reference'], ['487312', 'a bank balance'], [`ZZABPUNREL${RUN}`, 'an unrelated expense'], ['77777', 'an unrelated amount'], ['ZZTEST ABP Unrelated', 'an unrelated vendor'], ['ZZTEST ABP admin', 'a staff name'], [V1.id, 'a vendor id'], [L1.u.id, 'a login id'], ['"bankTxnId"', 'bankTxnId'], ['"narration"', 'narration'], ['"accNo"', 'accNo'], ['"bankAccountId"', 'bankAccountId'], ['"vendorId":', 'vendorId'], ['"vendorUserId":', 'vendorUserId'], ['"passwordHash":', 'passwordHash']].forEach(([t, why]) => { if (allTxt2.includes(t)) leaks.push(`${why} (${t})`); });
    bankLineIds.filter((id) => allTxt2.includes(id)).forEach((id) => leaks.push(`bank line id ${id}`));
    check('Z', `PRIVACY SWEEP over ${swept.length} vendor responses: no bank account number or bank name, no statement narration / reference / balance / line id (${bankLineIds.length} ids checked), no unrelated company expense, no staff name, no internal id`, leaks.length === 0, leaks);
    const others = [[L1, V1], [L2, V2], [L3, V3], [L4, V4]];
    const cross = [];
    for (const [L, V] of others) {
      const txt = swept.filter((x) => true).length ? '' : '';
      const mine = (await vh(L, 'GET', `${A}/bills?pageSize=100`)).text;
      const others2 = [[B1.body.billNumber, V1], [o1.body.billNumber, V3], [hA.body.billNumber, V4]].filter(([, ov]) => ov !== V);
      others2.forEach(([inv]) => { if (mine.includes(inv)) cross.push(`${V.name} sees ${inv}`); });
    }
    check('Z', 'no vendor ever sees another vendor\'s invoice numbers (4 vendors cross-checked)', cross.length === 0, cross);
    check('Z', 'the portal sent the same data to the same login twice: no random or per-request value leaks (two reads of the bill list are identical apart from nothing)', JSON.stringify((await vh(L3, 'GET', `${A}/bills?pageSize=100`)).body) === JSON.stringify((await vh(L3, 'GET', `${A}/bills?pageSize=100`)).body));

    // ================================================================== I. reading changes nothing
    const snapI = await snapAcc();
    const auditBefore = await prisma.auditLog.count();
    const tableCounts = async () => { const out = {}; for (const t of tablesStart.filter((n) => !/^(sqlite_|VendorSession|Notification)/.test(n))) { try { out[t] = (await raw(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n; } catch { out[t] = -1; } } return out; }; // eslint-disable-line no-await-in-loop
    const tcBefore = await tableCounts();
    for (const L of [L1, L2, L3, L4, LR]) { for (const p of ['/overview', '/bills?pageSize=100', '/history?pageSize=100', '/sims?pageSize=100']) await vh(L, 'GET', A + p); } // eslint-disable-line no-await-in-loop
    await vh(L1, 'GET', `${A}/bills/${encodeURIComponent(bkey)}`);
    check('I', 'a burst of portal reads (5 logins x 4 pages + a bill detail) writes nothing: every Accounts bill and bank line is identical, no audit row, no row added to any table', (await snapAcc()) === snapI && (await prisma.auditLog.count()) === auditBefore && JSON.stringify(await tableCounts()) === JSON.stringify(tcBefore), null);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, '..', f))).digest('hex');
    const BASE_HASH = {
      'frontend/src/nav.js': '709e288db8797bb6e2c4f853794c23fd2873bcdf13a286ed697d0f416041ef88',
      'frontend/src/permissions.js': '99b0679c4cad6fbaba5e52a96f965ef869641082383eb85c627a3c1ef5209c26',
      'backend/src/utils/permissions.js': '5b2940a6f51ee1731b18d845ef451236a34cd5bee2c5421510643eabcba0f150',
      'backend/src/utils/roleRegistry.js': 'edd0d8a1fbf04b026555b5689a56d39f947e8adeb1edf5f445f51b5575f1a3a5',
      'backend/src/utils/roleAccess.js': '871b71ad5f51b473e9b96395e5ead597c99710140a9182bab8491dea88a3342c',
      'backend/src/middleware/auth.js': '4cee8a2bd5f93f8fe2cb645d39bfd7b92944d8c2af1b6018cdf048f666af254d',
      'backend/src/utils/identity.js': '7a1838b30f5c7a524a746e5eed93db2a4b4112c705282650e4397d6b02980799',
    };
    check('I', 'staff navigation (Admin / Accounts / HRMS / ATS) and the permission engine are byte-for-byte the files they were before this work', Object.entries(BASE_HASH).every(([f, h]) => sha(f) === h), Object.entries(BASE_HASH).filter(([f, h]) => sha(f) !== h).map(([f]) => f));
    const untouched = ['backend/src/routes/office.js', 'backend/src/routes/bank.js', 'backend/src/routes/bankAuto.js', 'backend/src/routes/bankRecon.js', 'backend/src/utils/expensePaymentState.js', 'backend/src/utils/assetVendorPayments.js', 'backend/src/routes/assetInventory.js', 'backend/src/routes/vendorPortalRecords.js'];
    const mine = ['backend/src/utils/airtelBillsPortal.js', 'backend/src/utils/airtelBillPayments.js', 'backend/src/routes/airtelBillsPortal.js'];
    const firstMine = Math.min(...mine.map((f) => fs.statSync(path.join(BACK, '..', f)).birthtimeMs));
    check('I', 'the Accounts office / bank / reconciliation routes, the payment truth table (both helpers), the finance portal records route and the HRMS asset routes were not edited by this work (all last saved before the first Airtel portal file was created)', untouched.every((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs < firstMine), untouched.filter((f) => fs.statSync(path.join(BACK, '..', f)).mtimeMs >= firstMine));
    const countsEnd = await cnt();
    check('I', 'rows of unrelated tables are unchanged (vendors, vendor logins, expenses, bills, SIM assets, SIM connections, invoices, clients, employees, candidates, bank lines, bank accounts, payroll)', JSON.stringify(countsEnd) === JSON.stringify(countsStart), [countsStart, countsEnd]);
    const tablesEnd = (await raw(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)).map((r) => r.name);
    const newTables = tablesEnd.filter((n) => !tablesStart.includes(n) && !/^(BankStmt|BankTxnKey|sqlite_sequence)/.test(n));
    check('I', 'the portal added no table and no column (the bank-statement duplicate tables are created by the existing Accounts import itself)', newTables.length === 0 && tablesStart.every((n) => tablesEnd.includes(n)), newTables);
    const rawSrc = `${serverLog}`;
    check('I', 'no server error in the log of the throw-away server', !/TypeError|ReferenceError|SQLITE_ERROR|Unhandled|Cannot read/.test(rawSrc), rawSrc.split('\n').filter((l) => /TypeError|ReferenceError|SQLITE_ERROR|Unhandled|Cannot read/.test(l)).slice(0, 5));
    {
      const { DatabaseSync } = require('node:sqlite');
      const real = new DatabaseSync(REAL, { readOnly: true });
      const n = real.prepare(`SELECT (SELECT COUNT(*) FROM "OfficeVendor" WHERE "name" LIKE 'ZZTEST ABP%') + (SELECT COUNT(*) FROM "OfficeExpense" WHERE COALESCE("vendor",'') LIKE 'ZZTEST ABP%') + (SELECT COUNT(*) FROM "VendorUser" WHERE "email" LIKE 'zz-abp-%') + (SELECT COUNT(*) FROM "BankAccount" WHERE COALESCE("bank",'') LIKE 'ZZTEST ABP%') AS n`).get().n;
      real.close();
      check('I', 'the REAL database (read-only) holds no ZZTEST ABP row: this test never wrote to it', Number(n) === 0, n);
    }

  } catch (err) {
    fail += 1; console.error('FAIL  test crashed:', err && err.stack ? err.stack : err);
  } finally {
    try {
      await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, update: { value: '1' }, create: { key: 'audit.allowPurge', value: '1' } });
      const inList = (a) => a.map(() => '?').join(',') || "''";
      if (made.vusers.length) {
        await prisma.$executeRawUnsafe(`DELETE FROM "VendorLoginModule" WHERE "vendorUserId" IN (${inList(made.vusers)})`, ...made.vusers).catch(() => {});
        await prisma.vendorSession.deleteMany({ where: { vendorUserId: { in: made.vusers } } }).catch(() => {});
        await prisma.vendorUser.deleteMany({ where: { id: { in: made.vusers } } }).catch(() => {});
      }
      // the rows this run made in the COPY (the copy is thrown away anyway; the real database is never opened for writing)
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorModuleBill" WHERE "vendorId" IN (${inList(made.vendors)})`, ...made.vendors).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "SimConnection" WHERE "id" IN (${inList(made.conns)})`, ...made.conns).catch(() => {});
      const exps = await prisma.officeExpense.findMany({ where: { OR: [{ id: { in: made.expenses } }, { vendor: { startsWith: 'ZZTEST ABP' } }, { billNumber: { startsWith: 'ZZABP' } }] }, select: { id: true } }).catch(() => []);
      const lines = made.banks.length ? await prisma.bankTransaction.findMany({ where: { bankAccountId: { in: made.banks } }, select: { id: true } }).catch(() => []) : [];
      for (const t of ['ReconProposal', 'ReconEvent']) await prisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "txnId" IN (${inList(lines.map((l) => l.id))})`, ...lines.map((l) => l.id)).catch(() => {}); // eslint-disable-line no-await-in-loop
      await prisma.officeExpense.deleteMany({ where: { id: { in: exps.map((e) => e.id) } } }).catch(() => {});
      if (made.banks.length) {
        await prisma.$executeRawUnsafe(`DELETE FROM "BankTxnKey" WHERE "bankAccountId" IN (${inList(made.banks)})`, ...made.banks).catch(() => {});
        await prisma.bankTransaction.deleteMany({ where: { bankAccountId: { in: made.banks } } }).catch(() => {});
        await prisma.bankAccount.deleteMany({ where: { id: { in: made.banks } } }).catch(() => {});
      }
      await prisma.auditLog.deleteMany({ where: { entity: 'OfficeExpense', entityId: { in: exps.map((e) => e.id) } } }).catch(() => {});
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
      await prisma.vendorBillSubmission.deleteMany({ where: { vendorId: { in: made.vendors } } }).catch(() => {});
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
