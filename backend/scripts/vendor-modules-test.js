#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR MODULES TESTS (2026-10-14). SANDBOX ONLY (refuses anything else).
//
//   cd backend && node scripts/vendor-modules-apply-sandbox.js      (once: the new tables)
//   cd backend && TL_API=http://localhost:4011 node scripts/vendor-modules-test.js [--no-samples]
//
// 2026-10-19: the vendor portal shows exactly FOUR modules now (Dashboard, Invoices, Payments, Purchase Orders) and the server refuses
// every other vendor route. The portal API of the old modules (ID Card Orders, SIM, Monthly Bills, Office, Assets) is still in the code, so
// this suite runs against a server started with VENDOR_PORTAL_ALL_MODULES=1 (the roll-back switch that lifts the wall). Its group C checks the
// four-entry menu; the menu / wall themselves are proved in vendor-login-email-test.js (groups N, O, P).
// Builds ZZTEST VM fixtures in sandbox.db, drives the real API on 4011, prints PASS/FAIL per check and removes
// everything it made. The three SAMPLE vendors of Part 5 (Sample ID Cards Vendor, Airtel, Sample Office Rent Vendor)
// are the only rows kept (sandbox only; their secure links are printed, never emailed). --no-samples skips them.
// Groups: A category map + picker  B create login (one transaction) + legacy login  C portal nav + summaries
//         D module walls (403)     E vendor A vs B (IDOR)   F ID card orders   G SIM   H bills / payments
//         I edits take effect + switch off + preview + no password leaks   J staff doors
// ---------------------------------------------------------------------------
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API) || API.endsWith(':4045')) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another free sandbox port 4011-4099 (not 4045).'); process.exit(2); }
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.homedir(), '.teamlink-sandbox', 'uploads'); // where the sandbox API keeps files
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const attachments = require(path.join(BACK, 'src/utils/attachments'));
const CFG = require(path.join(BACK, 'src/config/vendorModules'));
const DB = require(path.join(BACK, 'src/utils/vmDb'));
const { createLoginAtomic } = require(path.join(BACK, 'src/utils/vendorLoginCreate'));

const RUN = Date.now().toString(36);
const NOSAMPLES = process.argv.includes('--no-samples');
const results = [];
const made = { users: [], vendors: [], logins: [], employees: [], assets: [], files: [], orders: [], bills: [], sims: [] };
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`);
}
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
async function rfetch(url, opt) {
  for (let i = 0; ; i += 1) {
    try { return await fetch(url, opt); } catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
async function call(method, p, { token, body, form, headers } = {}) {
  const h = { 'X-Forwarded-For': randIp(), ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await rfetch(`${API}/api${p}`, { method, headers: h, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, headers: r.headers };
}
const staffTok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pdfForm = (fields, name = 'zztest-doc.pdf') => {
  const fd = new FormData();
  Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, String(v)));
  fd.append('file', new Blob([PDF], { type: 'application/pdf' }), name);
  return fd;
};
const PW = (t) => `Zz!${RUN}${t}Aa9x`;
const tokenOf = (link) => decodeURIComponent(String(link).split('invite=')[1] || '');
const ym = (offset = 0) => { const d = new Date(); d.setMonth(d.getMonth() + offset); return d.toISOString().slice(0, 7); };
const today = () => new Date().toISOString().slice(0, 10);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const leaks = []; // every JSON body we saw: scanned for passwords at the end
const seen = (r) => { if (r && r.text) leaks.push(r.text); return r; };

async function main() {
  // ============================ A. category map ===========================================
  const cm = (k) => CFG.modulesForCategory(k);
  check('A', 'Office Rent / Building -> Office, Expenses, Invoices, Payments', same(cm('office_rent'), ['office', 'expenses', 'invoices', 'payments']));
  check('A', 'ID Cards -> ID Card Orders, Invoices, Payments', same(cm('id_cards'), ['id_card_orders', 'invoices', 'payments']));
  check('A', 'Airtel SIM / Telecom -> SIM and Connections, Monthly Bills, Invoices, Payments', same(cm('telecom'), ['sim_connections', 'monthly_bills', 'invoices', 'payments']));
  check('A', 'IT / Hardware / AMC / Service -> Assets, Invoices, Payments', same(cm('it_service'), ['assets', 'invoices', 'payments']));
  check('A', 'Other / Custom -> Invoices, Payments', same(cm('other'), ['invoices', 'payments']));
  const alias = { 'Office Rent': 'office_rent', Rent: 'office_rent', Building: 'office_rent', 'ID Cards': 'id_cards', 'id card': 'id_cards', 'Airtel SIM': 'telecom', Airtel: 'telecom', Telecom: 'telecom', 'Internet & phone': 'telecom', IT: 'it_service', Hardware: 'it_service', AMC: 'it_service', Service: 'it_service', 'Laptop AMC': 'it_service', Other: 'other', Custom: 'other' };
  check('A', 'aliases map to the right category', Object.entries(alias).every(([t, k]) => CFG.resolveCategory(t) === k), Object.entries(alias).filter(([t, k]) => CFG.resolveCategory(t) !== k));
  check('A', 'unknown / empty category -> Other (safe default)', CFG.resolveCategory('Stationery') === 'other' && CFG.resolveCategory('') === 'other' && CFG.resolveCategory(null) === 'other' && CFG.resolveCategory('zzz qqq') === 'other');
  check('A', 'defaults: Assets starts view-only, other modules start on', CFG.defaultPermissions('assets').canEdit === false && CFG.defaultPermissions('assets').canViewCost === false && CFG.defaultPermissions('id_card_orders').updateStatus === true);

  const mk = async (label, data) => {
    const u = await prisma.user.create({ data: { name: `ZZTEST VM ${label}`, email: `zztest.vm.${label.toLowerCase()}.${RUN}@example.test`, passwordHash: crypto.randomBytes(24).toString('hex'), status: 'Active', ...data } });
    made.users.push(u.id); return u;
  };
  const admin = await mk('Admin', { role: 'ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
  const hr = await mk('HR', { role: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsAccess: false, accountsAccess: false });
  const acct = await mk('Accountant', { role: 'ACCOUNTANT', accountsAccess: true, accountsRole: 'ACCOUNTANT', hrmsAccess: false, atsAccess: false });
  const rec = await mk('Recruiter', { role: 'RECRUITER', atsAccess: true, hrmsAccess: false, accountsAccess: false, atsRole: 'RECRUITER' });
  const A = staffTok(admin); const HR = staffTok(hr); const AC = staffTok(acct); const R = staffTok(rec);

  // DATA: the founder has switched Vendor emails ON in the real database. This suite expects the default (emails OFF: the link is shown to pass on by hand); the saved value is put back at the end.
  made.emailsBefore = await prisma.appSetting.findUnique({ where: { key: 'vendorPortal.settings' } });
  await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: false }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: false }) } });
  check('A', 'the vendor tables are in the sandbox (apply the migration first)', await DB.ready(), 'run: node scripts/vendor-modules-apply-sandbox.js');
  if (!(await DB.ready())) throw new Error('migration not applied to the sandbox');

  // ============================ A. the vendor dropdown source ================================
  const before = (await call('GET', '/vendor-logins/vendor-picker', { token: A })).body;
  check('A', 'vendor-picker answers (vendors, total, registry)', Array.isArray(before.vendors) && typeof before.totalVendors === 'number' && before.registry && before.registry.modules.length === 9, before); // 9 since 2026-10-19: the Admin tick "Airtel Bills" (Airtel Bills Portal) joined the eight
  const realCount = await prisma.officeVendor.count({ where: { NOT: { name: { startsWith: 'ZZTEST' } } } });
  console.log(`INFO  vendors in the sandbox copy of the real database before this test: ${realCount} (the real dev.db has 0, that is why the dropdown was empty)`);

  // ============================ fixtures: vendors with categories ==========================
  const mkVendor = async (label, category, extra = {}) => {
    const r = await call('POST', '/vendor-master', { token: A, body: { name: `ZZTEST VM ${label} ${RUN}`, category, contactPerson: `ZZTEST Contact ${label}`, email: `vm.${label.toLowerCase().replace(/\W/g, '')}.${RUN}@example.test`, ...extra } });
    if (r.status !== 201) throw new Error(`vendor ${label}: ${r.status} ${r.text}`);
    made.vendors.push(r.body.vendor.id); return r.body.vendor;
  };
  const vId = await mkVendor('IDCards', 'ID Cards');
  const vId2 = await mkVendor('IDCards Two', 'id card');
  const vTel = await mkVendor('Telecom', 'Airtel SIM / Telecom');
  const vRent = await mkVendor('Rent', 'Office Rent');
  const vIt = await mkVendor('IT', 'IT / Hardware / AMC / Service');
  const vOther = await mkVendor('Misc', 'Stationery');
  check('A', 'a vendor added in the Vendor Master carries its category key', vId.categoryKey === 'id_cards' && vTel.categoryKey === 'telecom' && vOther.categoryKey === 'other', [vId.categoryKey, vTel.categoryKey, vOther.categoryKey]);

  let pick = (await call('GET', '/vendor-logins/vendor-picker', { token: A })).body;
  const pv = (id) => pick.vendors.find((x) => x.id === id);
  check('A', 'the picker lists the vendors from the Vendor Master with name, category, contact, email', pv(vId.id) && pv(vId.id).category === 'ID Cards' && pv(vId.id).categoryKey === 'id_cards' && pv(vId.id).contactPerson && pv(vId.id).email, pv(vId.id));
  check('A', 'sorted A-Z (case-insensitive)', pick.vendors.every((x, i, a) => !i || a[i - 1].name.localeCompare(x.name, undefined, { sensitivity: 'base' }) <= 0));
  check('A', 'vendors without a login are not marked "Login exists"', pv(vId.id).hasLogin === false);
  // an inactive vendor is not offered
  const vOff = await mkVendor('Off', 'Other');
  let r = await call('POST', `/vendor-master/${vOff.id}/deactivate`, { token: A, body: { reason: 'zztest' } });
  pick = (await call('GET', '/vendor-logins/vendor-picker', { token: A })).body;
  check('A', 'only ACTIVE vendors are offered', r.status === 200 && !pv(vOff.id) && pick.totalVendors >= pick.vendors.length + 1, r.body);
  r = await call('GET', '/vendor-logins/category-preview?category=Airtel', { token: A });
  check('A', 'category-preview says what the portal would get', r.status === 200 && r.body.key === 'telecom' && r.body.modules.includes('SIM and Connections'), r.body);
  r = await call('GET', '/vendor-logins/vendor-picker', { token: R });
  check('A', 'a Recruiter cannot read the picker (403)', r.status === 403, r.status);

  // ============================ B. create login: one transaction =============================
  const logins = {};
  const mkLogin = async (key, vendor, modules, perms, extra = {}) => {
    const email = `vm.login.${key}.${RUN}@example.test`;
    const body = { vendorId: vendor.id, name: `ZZTEST VM ${key}`, email, ...(modules ? { modules, permissions: perms || {} } : {}), ...extra };
    const c = seen(await call('POST', '/vendor-logins', { token: A, body }));
    if (c.status !== 201) return { error: c };
    made.logins.push(c.body.login.id);
    const acc = seen(await call('POST', '/vendor-portal/invite/accept', { body: { token: tokenOf(c.body.inviteLink), newPassword: PW(key), confirmPassword: PW(key) } }));
    return { id: c.body.login.id, email, row: c.body.login, link: c.body.inviteLink, created: c, token: acc.body && acc.body.token, accept: acc, vendor };
  };
  const L = {
    id: await mkLogin('idcards', vId, CFG.modulesForCategory('id_cards')),
    id2: await mkLogin('idcards2', vId2, CFG.modulesForCategory('id_cards')),
    tel: await mkLogin('telecom', vTel, CFG.modulesForCategory('telecom')),
    rent: await mkLogin('rent', vRent, CFG.modulesForCategory('office_rent')),
    it: await mkLogin('it', vIt, CFG.modulesForCategory('it_service'), { assets: { canEdit: true, canViewCost: false } }),
    other: await mkLogin('other', vOther, CFG.modulesForCategory('other')),
    legacy: await mkLogin('legacy', await mkVendor('Legacy', 'Internet'), null),
  };
  Object.assign(logins, L);
  check('B', 'Create login saves modules + permissions and returns a secure link (201)', L.id.created.status === 201 && L.id.link && /vendor-login\?invite=/.test(L.id.link) && same(L.id.row.modules, ['id_card_orders', 'invoices', 'payments']) && L.id.row.modulesConfigured === true, L.id.error || L.id.row);
  check('B', 'the vendor sets their own password through the link and gets a session', !!L.id.token && L.id.accept.status === 200, L.id.accept.body);
  check('B', 'saved ticks come back on the login row (module permissions)', L.it.row.modulePermissions.assets.canEdit === true && L.it.row.canEdit === true && L.it.row.canViewCost === false, L.it.row);
  const dbMods = await DB.q('SELECT "moduleKey","permissionsJson" FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [L.tel.id]);
  check('B', 'module rows are in the database for the login', dbMods.length === 4 && dbMods.some((m) => m.moduleKey === 'sim_connections'), dbMods);
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: vRent.id, name: 'x', email: `vm.nomods.${RUN}@example.test`, modules: [] } });
  check('B', 'no module ticked is refused with a plain message', r.status === 400 && /at least one module/i.test(r.body.error), r.body);
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: vRent.id, name: 'x', email: `vm.badmods.${RUN}@example.test`, modules: ['nope', 'evil'] } });
  check('B', 'unknown module keys are ignored: nothing valid ticked = refused', r.status === 400, r.body);
  // Assets not ticked: no asset scope / permissions saved
  const rentLogin = await prisma.vendorUser.findUnique({ where: { id: L.rent.id }, include: { access: true } });
  check('B', 'Assets not ticked: no asset access rows and no asset permissions are saved', rentLogin.access.length === 0 && rentLogin.canEdit === false && rentLogin.canViewCost === false);
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: vRent.id, name: 'x', email: `vm.assetsoff.${RUN}@example.test`, modules: ['invoices'], assetIds: ['whatever'], categories: ['Laptop'], canEdit: true, canViewCost: true } });
  if (r.status === 201) made.logins.push(r.body.login.id);
  const sneak = r.status === 201 ? await prisma.vendorUser.findUnique({ where: { id: r.body.login.id }, include: { access: true } }) : null;
  check('B', 'asset fields sent without the Assets module are not stored', r.status === 201 && sneak.access.length === 0 && !sneak.canEdit && !sneak.canViewCost, r.body);

  // rollback: a failure after the modules are written leaves NOTHING behind
  const beforeCounts = { u: await prisma.vendorUser.count(), m: (await DB.one('SELECT COUNT(*) AS n FROM "VendorLoginModule"')).n, t: await prisma.vendorLoginToken.count() };
  let threw = false;
  try {
    await createLoginAtomic({ vendor: await prisma.officeVendor.findUnique({ where: { id: vRent.id } }), name: 'ZZTEST VM rollback', email: `vm.rollback.${RUN}@example.test`, status: 'Active', user: admin, actorName: 'ZZTEST', modules: { keys: ['invoices'], perms: { invoices: CFG.defaultPermissions('invoices') } }, assetIds: [], categories: [], toLink: [] }, { afterModules: async () => { throw new Error('boom'); } });
  } catch (e) { threw = /boom/.test(e.message); }
  const afterCounts = { u: await prisma.vendorUser.count(), m: (await DB.one('SELECT COUNT(*) AS n FROM "VendorLoginModule"')).n, t: await prisma.vendorLoginToken.count() };
  check('B', 'a failure after the modules are saved rolls the whole login back (no user, no modules, no link)', threw && JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), { beforeCounts, afterCounts });
  threw = false;
  try {
    await createLoginAtomic({ vendor: await prisma.officeVendor.findUnique({ where: { id: vRent.id } }), name: 'ZZTEST VM rollback2', email: `vm.rollback2.${RUN}@example.test`, status: 'Active', user: admin, actorName: 'ZZTEST', modules: { keys: ['invoices'], perms: { invoices: CFG.defaultPermissions('invoices') } }, assetIds: [], categories: [], toLink: [] }, { beforeCommit: async () => { throw new Error('late'); } });
  } catch (e) { threw = /late/.test(e.message); }
  check('B', 'a failure at the very end (after the secure link) also leaves nothing behind', threw && (await prisma.vendorUser.count()) === beforeCounts.u && (await prisma.vendorLoginToken.count()) === beforeCounts.t);

  // legacy login (no modules sent) keeps today's behaviour
  const leg = await call('GET', '/vendor-portal/me', { token: L.legacy.token });
  check('B', 'an old-style login (no module rows) still works: /me ok, lands as before', leg.status === 200 && leg.body.modulesConfigured === false && same(leg.body.nav.map((n) => n.key), ['dashboard', 'invoices', 'payments', 'services']) && leg.body.landing === '/vendor/dashboard', leg.body); // 2026-10-19: the four-module menu and the Dashboard landing for every login
  check('B', 'old-style login: assets list + invoices list still served', (await call('GET', '/vendor-portal/assets', { token: L.legacy.token })).status === 200 && (await call('GET', '/vendor-portal/invoices', { token: L.legacy.token })).status === 200);
  check('B', 'old-style login: documents and profile still served', (await call('GET', '/vendor-portal/documents', { token: L.legacy.token })).status === 200 && (await call('GET', '/vendor-portal/profile', { token: L.legacy.token })).status === 200);
  check('B', 'old-style login: new modules are 403', (await call('GET', '/vendor-portal/id-card-orders', { token: L.legacy.token })).status === 403 && (await call('GET', '/vendor-portal/sim', { token: L.legacy.token })).status === 403);
  r = await call('POST', '/vendor-portal/module-bills?kind=invoice', { token: L.legacy.token, form: pdfForm({ billNumber: 'L-1', billDate: today(), amount: '100' }) });
  check('B', 'old-style login cannot raise a new-style invoice (it never could send one from the list)', r.status === 403, r.body);
  const legRow = (await call('GET', '/vendor-logins', { token: A })).body.rows.find((x) => x.id === L.legacy.id);
  check('B', 'the admin list shows an old login as "as before" with its two modules', legRow && legRow.modulesConfigured === false && same(legRow.modules, ['assets', 'invoices']), legRow);

  // ============================ C. portal nav + summaries ====================================
  const me = {};
  for (const k of ['id', 'tel', 'rent', 'it', 'other']) { me[k] = seen(await call('GET', '/vendor-portal/me', { token: L[k].token })); }
  // 2026-10-19 (founder): EVERY vendor portal has exactly four modules - Dashboard, Invoices, Payments, Purchase Orders. The per-category menus
  // (ID Card Orders, SIM, Monthly Bills, Office, Assets ...) are gone from the menu and /me; what the Admin ticks for a login is still stored and audited.
  // The exact menu, the screen routes and the server wall are proved in vendor-login-email-test.js (groups N, O, P).
  const FOUR = ['dashboard', 'invoices', 'payments', 'services'];
  const FOUR_LABELS = ['Dashboard', 'Bills & Invoices', 'Payments & Outstanding', 'Services & Agreements'];
  // 2026-10-19 (type-aware portal): the finance vendors (telecom, office rent, other) keep EXACTLY the four modules; an ID card vendor gets the ID Card Vendor Portal
  // and an IT / hardware vendor the Assets Vendor Portal (their menus and routes are proved in idcard-vendor-portal-test.js / assets-vendor-portal-test.js).
  const ID_KEYS = ['idcard_dashboard', 'idcard_requests', 'idcard_pending', 'idcard_completed', 'idcard_delivered'];
  const AS_KEYS = ['asset_dashboard', 'asset_assets', 'asset_orders', 'asset_repairs', 'asset_history', 'asset_invoices'];
  check('C', 'the finance vendors (telecom, office rent, other) get the SAME four-entry menu landing on the Dashboard; the ID card vendor its ID Card portal menu; the IT vendor its Assets portal menu', ['tel', 'rent', 'other'].every((k) => me[k].status === 200 && same(me[k].body.nav.map((n) => n.key), FOUR) && same(me[k].body.nav.map((n) => n.label), FOUR_LABELS) && me[k].body.landing === '/vendor/dashboard') && same(me.id.body.nav.map((n) => n.key), ID_KEYS) && me.id.body.landing === '/vendor/idcard-portal/dashboard' && same(me.it.body.nav.map((n) => n.key), AS_KEYS) && me.it.body.landing === '/vendor/asset-portal/dashboard', ['id', 'tel', 'rent', 'it', 'other'].map((k) => me[k].body.nav && me[k].body.nav.map((n) => n.key)));
  check('C', '/me carries no module of the old per-category menus (no ID Card Orders, SIM, Monthly Bills, Office, Expenses, Assets)', ['id', 'tel', 'rent', 'it', 'other'].every((k) => !(me[k].body.modules || []).some((m) => ['id_card_orders', 'sim_connections', 'monthly_bills', 'office', 'expenses', 'assets'].includes(m.key))), ['id', 'tel', 'rent', 'it', 'other'].map((k) => (me[k].body.modules || []).map((m) => m.key)));
  check('C', 'every entry of the menu carries a label and a route', ['id', 'tel', 'rent'].every((k) => me[k].body.nav.every((n) => n.label && n.route)), me.id.body.nav);

  // ============================ employees + an order =========================================
  const emp = async (label, bg, photo) => {
    const e = await prisma.employee.create({ data: { employeeCode: `ZZVM${label}${RUN}`.slice(0, 30), name: `ZZTEST VM Emp ${label}`, designation: 'Tester', department: 'QA', bloodGroup: bg, email: `zz.vm.emp.${label.toLowerCase()}.${RUN}@example.test`, employmentStatus: 'Active' } });
    made.employees.push(e.id);
    let doc = null;
    if (photo) {
      const st = attachments.store({ data: PNG, contentType: 'image/png', filename: 'p.png' });
      made.files.push(st.billFile);
      doc = await prisma.employeeDocument.create({ data: { employeeId: e.id, docType: 'Photo', docName: 'Profile photo', file: st.billFile, fileName: 'p.png', mime: 'image/png', size: PNG.length, uploadedBy: 'ZZTEST' } });
    }
    return { e, doc };
  };
  const e1 = await emp('One', 'O+', true); const e2 = await emp('Two', 'B+', false); const e3 = await emp('Three', 'A-', true);
  r = await call('GET', '/id-card-orders/employees?q=ZZTEST VM Emp', { token: A });
  check('F', 'HR picker: type-to-search employees with name, ID, designation, department, blood group and photo flag', r.status === 200 && r.body.employees.length >= 3 && r.body.employees.find((x) => x.id === e1.e.id).hasPhoto === true && r.body.employees.find((x) => x.id === e2.e.id).hasPhoto === false && r.body.employees[0].bloodGroup, r.body);
  r = await call('GET', '/id-card-orders/vendors', { token: A });
  check('F', 'order vendors = vendors with the ID Card Orders module (or category ID Cards)', r.status === 200 && r.body.vendors.some((v) => v.id === vId.id && v.hasPortal) && r.body.vendors.some((v) => v.id === vId2.id) && !r.body.vendors.some((v) => v.id === vTel.id), r.body);
  r = await call('POST', '/id-card-orders', { token: A, body: { vendorId: vId.id, cardType: 'New', lines: [{ employeeId: e1.e.id, cardType: 'New' }, { employeeId: e2.e.id, cardType: 'Replacement' }], note: 'ZZTEST VM order A' } });
  const orderA = r.body && r.body.order;
  if (orderA) made.orders.push(orderA.id);
  check('F', 'HR places an order: code ICO-nnnn, status New, 2 lines', r.status === 201 && /^ICO-\d{4}$/.test(orderA.orderCode) && orderA.status === 'New' && orderA.lineCount === 2, r.body);
  const detA = (await call('GET', `/id-card-orders/${orderA.id}`, { token: A })).body;
  const l1 = detA.lines.find((l) => l.employeeId === e1.e.id);
  check('F', 'each line keeps the employee name, ID, designation, department, blood group and photo', l1 && l1.employeeName === e1.e.name && l1.employeeCode === e1.e.employeeCode && l1.designation === 'Tester' && l1.department === 'QA' && l1.bloodGroup === 'O+' && l1.hasPhoto === true && detA.lines.find((l) => l.employeeId === e2.e.id).cardType === 'Replacement', detA.lines);
  r = await call('POST', '/id-card-orders', { token: A, body: { vendorId: vId2.id, cardType: 'Lost', employeeIds: [e3.e.id], note: 'ZZTEST VM order B' } });
  const orderB = r.body && r.body.order;
  if (orderB) made.orders.push(orderB.id);
  check('F', 'a second order for ANOTHER ID card vendor (Vendor B)', r.status === 201 && orderB.lineCount === 1, r.body);
  r = await call('POST', '/id-card-orders', { token: A, body: { vendorId: vId.id, employeeIds: [] } });
  check('F', 'an order without employees is refused', r.status === 400, r.body);

  // ============================ F. vendor side of the order =================================
  const IDt = L.id.token; const ID2t = L.id2.token;
  r = seen(await call('GET', '/vendor-portal/id-card-orders', { token: IDt }));
  check('F', 'the vendor sees ITS order only (list)', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].id === orderA.id && r.body.rows[0].nextStatus === 'Received', r.body);
  r = seen(await call('GET', `/vendor-portal/id-card-orders/${orderA.id}`, { token: IDt }));
  check('F', 'order detail: lines, history, permissions', r.status === 200 && r.body.lines.length === 2 && r.body.canUpdate && r.body.canDownload && r.body.history.length >= 1, r.body);
  // status flow
  const st = async (t, id, s, remarks) => call('POST', `/vendor-portal/id-card-orders/${id}/status`, { token: t, body: { status: s, remarks } });
  r = await st(IDt, orderA.id, 'Printing');
  check('F', 'status cannot skip a step (New -> Printing refused, 409)', r.status === 409 && r.body.expected === 'Received', r.body);
  r = await st(IDt, orderA.id, 'Delivered');
  check('F', 'status cannot jump to Delivered', r.status === 409, r.body);
  r = await st(IDt, orderA.id, 'Received', 'got the data');
  check('F', 'New -> Received works', r.status === 200 && r.body.order.status === 'Received', r.body);
  r = await st(IDt, orderA.id, 'New');
  check('F', 'status cannot go back (Received -> New refused)', r.status === 409, r.body);
  r = await st(IDt, orderA.id, 'Received');
  check('F', 'the same status twice is refused', r.status === 409, r.body);
  r = await st(IDt, orderA.id, 'Nonsense');
  check('F', 'a made-up status is refused (400)', r.status === 400, r.body);
  r = await st(IDt, orderA.id, 'Printing', 'photo unclear for 2 employees');
  check('F', 'Received -> Printing works', r.status === 200 && r.body.order.status === 'Printing', r.body);
  const evs = await DB.q('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt"', [orderA.id]);
  check('F', 'every change is recorded (events with who and the remark)', evs.filter((e) => e.actorKind === 'Vendor').length === 2 && evs.some((e) => /photo unclear/.test(e.note || '')), evs);
  const aud = await prisma.assetAuditLog.findMany({ where: { vendorUserId: L.id.id, action: 'ID card order status changed' } });
  check('F', 'every status change is audited with old and new value', aud.length === 2 && aud.some((a) => a.oldValue === 'Received' && a.newValue === 'Printing'), aud.length);
  // notifications + tasks to the company
  const notes = await prisma.notification.findMany({ where: { userId: admin.id, title: { contains: orderA.orderCode } } });
  check('F', 'the company is notified at every change (bell to the order creator)', notes.length >= 2 && notes.some((n) => /Printing/.test(n.title)), notes.map((n) => n.title));
  const tasks = await prisma.task.findMany({ where: { assigneeId: admin.id, name: { startsWith: `ID cards ${orderA.orderCode}` } } });
  check('F', 'a task for the order creator tracks the order (one task, updated in place)', tasks.length === 1 && /Printing/.test(tasks[0].name) && tasks[0].status === 'In Progress', tasks);
  // proof + remarks
  const proofFd = pdfForm({ remarks: 'photo unclear for 2 employees' }, 'challan.pdf');
  r = await call('POST', `/vendor-portal/id-card-orders/${orderA.id}/proof`, { token: IDt, form: proofFd });
  check('F', 'the vendor uploads a delivery challan / proof with a remark (201)', r.status === 201 && r.body.order.hasChallan === true && /unclear/.test(r.body.order.vendorRemarks), r.body);
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/challan`, { token: IDt });
  check('F', 'the vendor can open its own challan back', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF');
  r = await call('POST', `/vendor-portal/id-card-orders/${orderA.id}/proof`, { token: IDt, body: { remarks: '' } });
  check('F', 'proof with neither file nor remark is refused', r.status === 400, r.body);
  r = await call('GET', `/id-card-orders/${orderA.id}/challan`, { token: A });
  check('F', 'HR can open the challan too', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF');
  // CSV + ZIP scoped to the vendor's own order
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/lines.csv`, { token: IDt });
  check('F', 'CSV: own order lines only (employee data), not another vendor\'s', r.status === 200 && r.text.includes(e1.e.employeeCode) && r.text.includes('O+') && r.text.includes('Replacement') && !r.text.includes(e3.e.employeeCode) && /text\/csv/.test(r.headers.get('content-type')), r.text.slice(0, 300));
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/photos.zip`, { token: IDt });
  const zipText = r.buf.toString('latin1');
  check('F', 'ZIP: a real zip with the csv and ONLY the photos of this order\'s people', r.status === 200 && r.buf.slice(0, 2).toString() === 'PK' && zipText.includes(`${orderA.orderCode}.csv`) && zipText.includes(e1.e.employeeCode) && !zipText.includes(e3.e.employeeCode) && (zipText.match(/photos\//g) || []).length >= 2, zipText.slice(0, 120));
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/lines/${detA.lines.find((l) => l.employeeId === e1.e.id).id}/photo`, { token: IDt });
  check('F', 'a person\'s photo is served through the authenticated vendor route', r.status === 200 && /image\/png/.test(r.headers.get('content-type')) && r.buf.length === PNG.length, r.status);
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/lines/${detA.lines.find((l) => l.employeeId === e2.e.id).id}/photo`, { token: IDt });
  check('F', 'no photo on file = 404, not a crash', r.status === 404);
  r = await call('GET', `/vendor-portal/id-card-orders/${orderA.id}/photos.zip`, { token: ID2t });
  check('F', 'another vendor cannot download this order\'s ZIP (403)', r.status === 403, r.status);
  // deliver
  await st(IDt, orderA.id, 'Ready'); r = await st(IDt, orderA.id, 'Delivered');
  check('F', 'Ready -> Delivered; then nothing more', r.status === 200 && r.body.order.status === 'Delivered' && (await st(IDt, orderA.id, 'Delivered')).status === 409);
  const tasks2 = await prisma.task.findMany({ where: { assigneeId: admin.id, name: { startsWith: `ID cards ${orderA.orderCode}` } } });
  check('F', 'the task is completed when the order is Delivered', tasks2.length === 1 && tasks2[0].status === 'Completed', tasks2);
  r = await call('GET', `/id-card-orders/${orderA.id}`, { token: A });
  check('F', 'HR sees the new status, the history and the vendor remark', r.body.order.status === 'Delivered' && r.body.history.length >= 5 && /unclear/.test(r.body.order.vendorRemarks), r.body.history && r.body.history.length);

  // ============================ E. vendor A vs vendor B =========================================
  const E = [
    ['GET order', 'GET', `/vendor-portal/id-card-orders/${orderB.id}`],
    ['POST status', 'POST', `/vendor-portal/id-card-orders/${orderB.id}/status`, { status: 'Received' }],
    ['GET csv', 'GET', `/vendor-portal/id-card-orders/${orderB.id}/lines.csv`],
    ['GET zip', 'GET', `/vendor-portal/id-card-orders/${orderB.id}/photos.zip`],
    ['GET challan', 'GET', `/vendor-portal/id-card-orders/${orderB.id}/challan`],
    ['POST proof', 'POST', `/vendor-portal/id-card-orders/${orderB.id}/proof`, { remarks: 'hack' }],
  ];
  for (const [name, m, p, b] of E) {
    // eslint-disable-next-line no-await-in-loop
    const x = await call(m, p, { token: IDt, body: b });
    check('E', `Vendor A cannot reach Vendor B's order by id: ${name} -> 403`, x.status === 403, x.status);
  }
  r = await call('GET', '/vendor-portal/id-card-orders', { token: IDt });
  check('E', 'Vendor A\'s list never contains Vendor B\'s order', !r.body.rows.some((o) => o.id === orderB.id));
  check('E', 'Vendor B did not change either: its order is still New', (await DB.one('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', [orderB.id])).status === 'New');

  // ============================ G. SIM =======================================================
  const SIMt = L.tel.token;
  r = await call('POST', '/sim-connections', { token: A, body: { vendorId: vTel.id, mobileNumber: '9000000001', simSerial: 'ZZ-ICCID-1', plan: 'Postpaid 499', employeeId: e1.e.id } });
  const sim1 = r.body && r.body.sim; if (sim1) made.sims.push(sim1.id);
  check('G', 'the company adds a number (number, serial, plan, holder)', r.status === 201 && sim1.employeeName.includes(e1.e.name) && sim1.status === 'Active', r.body);
  r = await call('POST', '/sim-connections', { token: A, body: { vendorId: vTel.id, mobileNumber: '9000000001' } });
  check('G', 'the same number twice for one vendor is refused (409)', r.status === 409, r.body);
  r = await call('POST', '/sim-connections', { token: A, body: { vendorId: vTel.id, mobileNumber: '12' } });
  check('G', 'a short number is refused with a plain message', r.status === 400, r.body);
  const sim2r = await call('POST', '/sim-connections', { token: A, body: { vendorId: vTel.id, mobileNumber: '9000000002', plan: 'Postpaid 299' } });
  if (sim2r.body && sim2r.body.sim) made.sims.push(sim2r.body.sim.id);
  r = await call('POST', '/sim-connections/requests', { token: A, body: { vendorId: vTel.id, kind: 'replacement', simId: sim1.id, details: 'SIM damaged' } });
  const sreq = r.body && r.body.request;
  check('G', 'the company raises a request (replacement SIM) with a code', r.status === 201 && /^SRQ-\d{4}$/.test(sreq.requestCode) && sreq.status === 'Open', r.body);
  r = await call('POST', '/sim-connections/requests', { token: A, body: { vendorId: vTel.id, kind: 'port_out' } });
  check('G', 'a port-out request needs a number', r.status === 400, r.body);
  r = seen(await call('GET', '/vendor-portal/sim', { token: SIMt }));
  check('G', 'the vendor sees its numbers, summary and requests', r.status === 200 && r.body.rows.length === 2 && r.body.summary.total === 2 && r.body.requests.length === 1 && r.body.requests[0].simNumber === '9000000001', r.body);
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: SIMt, body: { status: 'Suspended' } });
  check('G', 'the vendor marks a SIM Suspended', r.status === 200 && r.body.sim.status === 'Suspended', r.body);
  const simAud = await prisma.assetAuditLog.findMany({ where: { vendorUserId: L.tel.id, action: 'SIM status changed' } });
  check('G', 'the SIM status change is audited (old and new)', simAud.length === 1 && simAud[0].oldValue === 'Active' && simAud[0].newValue === 'Suspended' && simAud[0].status === '9000000001', simAud);
  const simNotes = await prisma.notification.findMany({ where: { userId: admin.id, title: { contains: '9000000001' } } });
  check('G', 'the company is notified of the SIM change', simNotes.length >= 1, simNotes.length);
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: SIMt, body: { status: 'Nonsense' } });
  check('G', 'a bad SIM status is refused', r.status === 400);
  r = await call('POST', `/vendor-portal/sim/requests/${sreq.id}/update`, { token: SIMt, body: { status: 'In progress', note: 'SIM dispatched' } });
  check('G', 'the vendor moves the request forward with a note; the company is told', r.status === 200 && r.body.request.status === 'In progress' && (await prisma.notification.count({ where: { userId: admin.id, title: { contains: sreq.requestCode } } })) >= 1, r.body);
  r = await call('POST', `/vendor-portal/sim/requests/${sreq.id}/update`, { token: SIMt, body: { status: 'Open' } });
  check('G', 'a request cannot go back to Open', r.status === 409);
  r = await call('POST', `/vendor-portal/sim/requests/${sreq.id}/update`, { token: SIMt, body: { status: 'Done', note: 'activated' } });
  check('G', 'In progress -> Done', r.status === 200 && r.body.request.status === 'Done');
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: SIMt, body: { status: 'Disconnected' } });
  check('G', 'the vendor disconnects a SIM', r.status === 200 && r.body.sim.status === 'Disconnected');
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: SIMt, body: { status: 'Active' } });
  check('G', 'a Disconnected SIM cannot be switched on again from the portal (409)', r.status === 409, r.body);
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: L.rent.token });
  check('G', 'another vendor (no SIM module) gets 403 on a SIM id', r.status === 403);
  // vendor B of telecom: a second telecom login cannot touch the first one's SIMs
  const vTel2 = await mkVendor('Telecom Two', 'Telecom');
  const Ltel2 = await mkLogin('telecom2', vTel2, CFG.modulesForCategory('telecom'));
  r = await call('POST', `/vendor-portal/sim/${sim1.id}/status`, { token: Ltel2.token, body: { status: 'Active' } });
  check('E', 'Vendor B (also telecom) cannot change Vendor A\'s SIM by id (403)', r.status === 403, r.status);
  r = await call('POST', `/vendor-portal/sim/requests/${sreq.id}/update`, { token: Ltel2.token, body: { status: 'Done' } });
  check('E', 'Vendor B cannot update Vendor A\'s SIM request by id (403)', r.status === 403);
  r = await call('GET', '/vendor-portal/sim', { token: Ltel2.token });
  check('E', 'Vendor B sees none of Vendor A\'s numbers or requests', r.body.rows.length === 0 && r.body.requests.length === 0);
  // import from SIM Card assets: preview first, then only the ticked
  const simAsset = await prisma.asset.create({ data: { assetCode: `ZZVM-SIM-${RUN}`.slice(0, 30), name: 'ZZTEST VM Airtel SIM · 9111222233', category: 'SIM Card', assetType: 'Airtel · ICCID 89910009236877030ZZ', status: 'Assigned', assignedToId: e3.e.id } });
  made.assets.push(simAsset.id);
  const simAsset2 = await prisma.asset.create({ data: { assetCode: `ZZVM-SIM2-${RUN}`.slice(0, 30), name: 'ZZTEST VM SIM no number here', category: 'SIM Card', status: 'Available' } });
  made.assets.push(simAsset2.id);
  const countBefore = (await DB.one('SELECT COUNT(*) AS n FROM "SimConnection"')).n;
  r = await call('GET', `/sim-connections/import-preview?vendorId=${vTel.id}`, { token: A });
  const prow = r.body.rows && r.body.rows.find((x) => x.assetId === simAsset.id);
  const prow2 = r.body.rows && r.body.rows.find((x) => x.assetId === simAsset2.id);
  check('G', 'import PREVIEW lists SIM Card assets with number, serial, holder and what will happen', r.status === 200 && r.body.dryRun === true && prow && prow.mobileNumber === '9111222233' && /ICCID|89910009236877030ZZ/.test(prow.simSerial || '') && prow.action === 'import' && prow.employeeName.includes(e3.e.name), r.body.summary);
  check('G', 'an asset with no 10-digit number is skipped with a reason', prow2 && prow2.action === 'skip' && /No 10-digit/.test(prow2.why));
  check('G', 'the preview wrote nothing', (await DB.one('SELECT COUNT(*) AS n FROM "SimConnection"')).n === countBefore);
  const assetHistBefore = (await prisma.asset.findUnique({ where: { id: simAsset.id } })).history;
  r = await call('POST', '/sim-connections/import', { token: A, body: { vendorId: vTel.id, assetIds: [simAsset.id] } });
  const imported = await DB.one('SELECT * FROM "SimConnection" WHERE "assetId" = ?', [simAsset.id]);
  if (imported) made.sims.push(imported.id);
  check('G', 'import creates ONLY the ticked row, linked to its Asset row', r.status === 201 && r.body.imported === 1 && imported && imported.mobileNumber === '9111222233' && imported.vendorId === vTel.id && imported.employeeId === e3.e.id, r.body);
  check('G', 'the Asset row itself is not changed by the import', (await prisma.asset.findUnique({ where: { id: simAsset.id } })).history === assetHistBefore);
  r = await call('POST', '/sim-connections/import', { token: A, body: { vendorId: vTel.id, assetIds: [simAsset.id] } });
  check('G', 'importing the same asset again is refused (nothing to import)', r.status === 400, r.body);
  r = await call('GET', '/sim-connections', { token: R });
  check('G', 'a Recruiter cannot open the company SIM list (403)', r.status === 403, r.status);

  // ============================ H. bills + payments ==============================================
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, form: pdfForm({ billNumber: `AT-${RUN}`, period: ym(0), amount: '1500', gst: '270', dueDate: today(), lines: JSON.stringify([{ number: '9000000001', amount: 499 }, { number: '9000000002', amount: 299 }]), remarks: 'ZZTEST VM' }, 'bill.pdf') });
  const mb = r.body && r.body.bill; if (mb) made.bills.push(mb.id);
  check('H', 'the telecom vendor uploads a monthly bill (number, period, amount, due date, PDF, per-number lines)', r.status === 201 && mb.kind === 'monthly_bill' && mb.total === 1770 && mb.statusText === 'Pending' && mb.lines.length === 2 && /^VM-\d{5}$/.test(mb.billCode), r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, form: pdfForm({ billNumber: `AT-${RUN}`, period: ym(-1), amount: '10', dueDate: today() }) });
  check('H', 'the same bill number twice is refused (409)', r.status === 409, r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, form: pdfForm({ billNumber: `AT2-${RUN}`, period: ym(0), amount: '10', dueDate: today() }) });
  check('H', 'a second bill for the same month is refused (409)', r.status === 409, r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, form: pdfForm({ billNumber: 'X', period: 'oct', amount: '10', dueDate: today() }) });
  check('H', 'a bad month is refused with the field named', r.status === 400 && r.body.field === 'period', r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, form: pdfForm({ billNumber: 'Y', period: ym(-2), amount: '-5', dueDate: today() }) });
  check('H', 'a negative amount is refused', r.status === 400, r.body);
  const idem = `zztest-${RUN}-idem`;
  const f1 = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, headers: { 'Idempotency-Key': idem }, form: pdfForm({ billNumber: `AT3-${RUN}`, period: ym(-3), amount: '20', dueDate: today() }) });
  const f2 = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt, headers: { 'Idempotency-Key': idem }, form: pdfForm({ billNumber: `AT3-${RUN}`, period: ym(-3), amount: '20', dueDate: today() }) });
  if (f1.body && f1.body.bill) made.bills.push(f1.body.bill.id);
  check('H', 'sending the same form twice (same Idempotency-Key) makes ONE bill', f1.status === 201 && f2.status === 201 && f2.body.duplicateRequest === true && f1.body.bill.id === f2.body.bill.id);
  r = await call('GET', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt });
  check('H', 'the vendor sees its monthly bills with status Pending', r.status === 200 && r.body.rows.find((b) => b.id === mb.id).statusText === 'Pending' && r.body.canRaise === true, r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=monthly_bill', { token: L.rent.token, form: pdfForm({ billNumber: 'Z', period: ym(0), amount: '10', dueDate: today() }) });
  check('D', 'a vendor without Monthly Bills cannot upload one (403)', r.status === 403, r.body);
  // staff review
  r = await call('GET', '/vendor-module-bills?status=Submitted', { token: AC });
  check('H', 'Accounts sees the bill waiting (vendor, month, number, total, per-number lines)', r.status === 200 && r.body.rows.some((b) => b.id === mb.id && b.vendorName && b.lines.length === 2 && b.periodLabel), r.body);
  r = await call('POST', `/vendor-module-bills/${mb.id}/paid`, { token: AC, body: { paidOn: today(), reference: 'UTR1' } });
  check('H', 'a bill cannot be paid before it is approved (409)', r.status === 409, r.body);
  r = await call('POST', `/vendor-module-bills/${mb.id}/approve`, { token: AC });
  check('H', 'Accounts approves it', r.status === 200 && r.body.bill.status === 'Approved');
  r = await call('GET', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt });
  check('H', 'the vendor sees Approved', r.body.rows.find((b) => b.id === mb.id).statusText === 'Approved');
  r = await call('POST', `/vendor-module-bills/${mb.id}/paid`, { token: AC, body: { paidOn: today(), amount: '1770' } });
  check('H', 'paying needs the payment reference no.', r.status === 400 && r.body.field === 'reference', r.body);
  r = await call('POST', `/vendor-module-bills/${mb.id}/paid`, { token: AC, body: { paidOn: today(), amount: '1770', reference: `UTR-${RUN}`, mode: 'UPI' } });
  check('H', 'Accounts marks it paid (date, amount, reference)', r.status === 200 && r.body.bill.status === 'Paid' && r.body.bill.paymentRef === `UTR-${RUN}`, r.body);
  r = await call('GET', '/vendor-portal/module-bills?kind=monthly_bill', { token: SIMt });
  check('H', 'the vendor sees Paid with the reference', r.body.rows.find((b) => b.id === mb.id).statusText === 'Paid');
  r = seen(await call('GET', '/vendor-portal/payments', { token: SIMt }));
  check('H', 'Payments: history with date, amount, reference no.', r.status === 200 && r.body.rows.some((p) => p.reference === `UTR-${RUN}` && p.amount === 1770 && p.date === today()) && r.body.total >= 1770, r.body);
  r = await call('POST', `/vendor-module-bills/${mb.id}/reject`, { token: AC, body: { reason: 'zz' } });
  check('H', 'a paid bill cannot be rejected (409)', r.status === 409 || r.status === 400, r.status);
  // invoice against an order: quantity x rate
  r = await call('POST', '/vendor-portal/module-bills?kind=invoice', { token: IDt, form: pdfForm({ billNumber: `INV-${RUN}`, billDate: today(), quantity: '2', rate: '75.5', gst: '27.18', orderId: orderA.id, remarks: 'ZZTEST VM' }, 'inv.pdf') });
  const inv = r.body && r.body.bill; if (inv) made.bills.push(inv.id);
  check('H', 'ID cards vendor sends an invoice against its order (quantity x rate + GST)', r.status === 201 && inv.amount === 151 && inv.total === 178.18 && inv.orderId === orderA.id && inv.statusText === 'Submitted', r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=invoice', { token: IDt, form: pdfForm({ billNumber: `INV2-${RUN}`, billDate: today(), amount: '10', orderId: orderB.id }) });
  check('E', 'an invoice cannot point at ANOTHER vendor\'s order (400)', r.status === 400 && r.body.field === 'orderId', r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=invoice', { token: IDt, form: pdfForm({ billNumber: `INV3-${RUN}`, billDate: '2999-01-01', amount: '10' }) });
  check('H', 'a future invoice date is refused', r.status === 400 && r.body.field === 'billDate', r.body);
  r = await call('GET', `/id-card-orders/${orderA.id}`, { token: A });
  check('F', 'HR sees the invoice on the order', r.body.bills.some((b) => b.id === inv.id), r.body.bills);
  r = await call('POST', `/vendor-module-bills/${inv.id}/reject`, { token: AC, body: { reason: 'wrong rate' } });
  check('H', 'Accounts rejects with a reason', r.status === 200 && r.body.bill.status === 'Rejected');
  r = await call('GET', '/vendor-portal/module-bills?kind=invoice', { token: IDt });
  check('H', 'the vendor sees Rejected and the reason', r.body.rows.find((b) => b.id === inv.id).rejectionReason === 'wrong rate');
  r = await call('POST', `/vendor-module-bills/${inv.id}/reject`, { token: AC, body: { reason: '' } });
  check('H', 'a rejection needs a reason', r.status === 400 || r.status === 409);
  // vendor B cannot read A's bill by id
  r = await call('GET', `/vendor-portal/module-bills/${inv.id}/document`, { token: ID2t });
  check('E', 'Vendor B cannot download Vendor A\'s invoice file by id (403)', r.status === 403, r.status);
  r = await call('GET', `/vendor-portal/module-bills/${mb.id}/document`, { token: Ltel2.token });
  check('E', 'Vendor B cannot download Vendor A\'s monthly bill file by id (403)', r.status === 403);
  r = await call('GET', '/vendor-portal/module-bills?kind=invoice', { token: ID2t });
  check('E', 'Vendor B\'s invoice list is empty (never A\'s)', r.status === 200 && r.body.rows.length === 0);
  r = await call('GET', '/vendor-portal/payments', { token: Ltel2.token });
  check('E', 'Vendor B sees none of Vendor A\'s payments', r.status === 200 && r.body.rows.length === 0);
  // office receipts + expenses
  r = await call('POST', '/vendor-portal/office/receipts', { token: L.rent.token, form: pdfForm({ remarks: 'October rent receipt' }, 'rent.pdf') });
  const rc = r.body && r.body.bill; if (rc) made.bills.push(rc.id);
  check('H', 'the office vendor uploads a receipt', r.status === 201 && rc.kind === 'receipt' && rc.statusText === 'Received', r.body);
  r = await call('GET', '/vendor-portal/office', { token: L.rent.token });
  check('H', 'Office: history + receipts + upload right', r.status === 200 && Array.isArray(r.body.rows) && r.body.receipts.length === 1 && r.body.canUpload === true, r.body);
  r = await call('GET', '/vendor-portal/expenses', { token: L.rent.token });
  check('H', 'Expenses: entries + summary', r.status === 200 && Array.isArray(r.body.rows) && r.body.summary, r.body);
  r = await call('POST', '/vendor-portal/office/receipts', { token: L.id.token, form: pdfForm({}, 'x.pdf') });
  check('D', 'a vendor without Office cannot upload a receipt (403)', r.status === 403);

  // ============================ D. module walls ===================================================
  const forbid = async (who, label, list) => {
    for (const [m, p, b] of list) {
      // eslint-disable-next-line no-await-in-loop
      const x = await call(m, p, { token: who, body: b });
      check('D', `${label}: ${m} ${p.replace(/[a-z0-9]{20,}/g, ':id')} -> 403`, x.status === 403, x.status);
    }
  };
  const idP = '/vendor-portal/id-card-orders';
  const ghost = 'zzghostid00000000000000';
  await forbid(L.rent.token, 'Office rent vendor (no ID cards / SIM / monthly bills / assets)', [
    ['GET', idP], ['GET', `${idP}/${orderA.id}`], ['POST', `${idP}/${orderA.id}/status`, { status: 'Received' }], ['POST', `${idP}/${orderA.id}/proof`, { remarks: 'x' }],
    ['GET', `${idP}/${orderA.id}/lines.csv`], ['GET', `${idP}/${orderA.id}/photos.zip`], ['GET', `${idP}/${orderA.id}/lines/${ghost}/photo`], ['GET', `${idP}/${orderA.id}/challan`],
    ['GET', '/vendor-portal/sim'], ['POST', `/vendor-portal/sim/${sim1.id}/status`, { status: 'Active' }], ['POST', `/vendor-portal/sim/requests/${sreq.id}/update`, { status: 'Done' }],
    ['GET', '/vendor-portal/module-bills?kind=monthly_bill'], ['POST', '/vendor-portal/module-bills?kind=monthly_bill', {}],
    ['GET', '/vendor-portal/assets'], ['GET', `/vendor-portal/assets/${ghost}`], ['GET', '/vendor-portal/dashboard'], ['POST', `/vendor-portal/assets/${ghost}/bills`, {}], ['PATCH', `/vendor-portal/bills/${ghost}`, {}],
  ]);
  await forbid(L.id.token, 'ID cards vendor (no Office / Expenses / SIM / monthly bills / assets)', [
    ['GET', '/vendor-portal/office'], ['GET', '/vendor-portal/expenses'], ['GET', '/vendor-portal/sim'], ['GET', '/vendor-portal/module-bills?kind=monthly_bill'], ['GET', '/vendor-portal/assets'], ['GET', '/vendor-portal/dashboard'],
  ]);
  await forbid(L.tel.token, 'Telecom vendor (no ID cards / Office / Expenses / assets)', [
    ['GET', idP], ['GET', `${idP}/${orderA.id}`], ['GET', '/vendor-portal/office'], ['GET', '/vendor-portal/expenses'], ['GET', '/vendor-portal/assets'],
  ]);
  await forbid(L.it.token, 'IT vendor (no ID cards / SIM / Office / monthly bills)', [['GET', idP], ['GET', '/vendor-portal/sim'], ['GET', '/vendor-portal/office'], ['GET', '/vendor-portal/module-bills?kind=monthly_bill']]);
  check('D', 'granted modules are served: IT vendor assets 200, rent vendor office/expenses/payments 200, ID vendor payments 200', (await call('GET', '/vendor-portal/assets', { token: L.it.token })).status === 200 && (await call('GET', '/vendor-portal/office', { token: L.rent.token })).status === 200 && (await call('GET', '/vendor-portal/expenses', { token: L.rent.token })).status === 200 && (await call('GET', '/vendor-portal/payments', { token: L.id.token })).status === 200);
  check('D', 'invoices module: ID vendor 200, Other vendor 200', (await call('GET', '/vendor-portal/module-bills?kind=invoice', { token: L.id.token })).status === 200 && (await call('GET', '/vendor-portal/module-bills?kind=invoice', { token: L.other.token })).status === 200);
  // unticked permission inside a granted module
  const permLogin = await mkLogin('perms', vId, ['id_card_orders', 'payments'], { id_card_orders: { updateStatus: false, download: false, uploadProof: false }, payments: { viewHistory: false } });
  const orderC = (await call('POST', '/id-card-orders', { token: A, body: { vendorId: vId.id, employeeIds: [e1.e.id] } })).body.order;
  made.orders.push(orderC.id);
  await forbid(permLogin.token, 'ID cards login with every permission unticked', [
    ['POST', `${idP}/${orderC.id}/status`, { status: 'Received' }], ['GET', `${idP}/${orderC.id}/lines.csv`], ['GET', `${idP}/${orderC.id}/photos.zip`], ['POST', `${idP}/${orderC.id}/proof`, { remarks: 'x' }], ['GET', '/vendor-portal/payments'],
  ]);
  check('D', 'with the permissions off the order can still be READ (view is the module itself)', (await call('GET', `${idP}/${orderC.id}`, { token: permLogin.token })).body.canUpdate === false);
  // vendor token vs staff API + staff token vs vendor API
  check('D', 'a vendor token cannot reach any staff API (403)', (await call('GET', '/id-card-orders', { token: L.id.token })).status === 403 && (await call('GET', '/sim-connections', { token: L.id.token })).status === 403 && (await call('GET', '/vendor-module-bills', { token: L.id.token })).status === 403);
  check('D', 'a staff token cannot use the vendor API (401)', (await call('GET', '/vendor-portal/id-card-orders', { token: A })).status === 401);

  // ============================ I. edits take effect on the next load ============================
  const tel = L.tel;
  r = await call('PATCH', `/vendor-logins/${tel.id}`, { token: A, body: { modules: ['sim_connections', 'invoices', 'payments', 'id_card_orders'], permissions: { sim_connections: { updateStatus: true, handleRequests: true } } } });
  check('I', 'admin edits modules (adds ID Card Orders, drops Monthly Bills)', r.status === 200 && same(r.body.login.modules, ['sim_connections', 'invoices', 'payments', 'id_card_orders']), r.body);
  r = await call('GET', '/vendor-portal/me', { token: tel.token });
  // 2026-10-19: ticking ID Card Orders for a login whose modules Admin set makes it an ID card vendor (utils/vendorKind.js): its NEXT /me is the ID Card portal menu.
  check('I', 'the vendor NEXT /me follows the ticks: with ID Card Orders ticked (no Assets) the menu is the ID Card portal menu', r.status === 200 && r.body.kind === 'idcards' && same(r.body.nav.map((n) => n.key), ['idcard_dashboard', 'idcard_requests', 'idcard_pending', 'idcard_completed', 'idcard_delivered']), r.body.nav);
  check('I', 'a dropped module is 403 on its very next call', (await call('GET', '/vendor-portal/module-bills?kind=monthly_bill', { token: tel.token })).status === 403 && (await call('GET', idP, { token: tel.token })).status === 200);
  const log = await prisma.assetAuditLog.findMany({ where: { vendorUserId: tel.id, action: 'Permission changed', field: 'Modules' } });
  check('I', 'the module change is audited (old and new)', log.length === 1 && /Monthly Bills/.test(log[0].oldValue) && /ID Card Orders/.test(log[0].newValue), log);
  r = await call('PATCH', `/vendor-logins/${L.id.id}`, { token: A, body: { modules: ['id_card_orders', 'invoices', 'payments'], permissions: { id_card_orders: { updateStatus: true, download: false, uploadProof: true } } } });
  check('I', 'a permission tick can be changed alone', r.status === 200 && r.body.login.modulePermissions.id_card_orders.download === false, r.body);
  check('I', 'the unticked permission is refused on the very next call', (await call('GET', `${idP}/${orderA.id}/lines.csv`, { token: IDt })).status === 403 && (await call('GET', `${idP}/${orderA.id}`, { token: IDt })).body.canDownload === false);
  r = await call('PATCH', `/vendor-logins/${L.id.id}`, { token: A, body: { modules: [] } });
  check('I', 'saving with no module is refused', r.status === 400, r.body);
  r = await call('PATCH', `/vendor-logins/${L.legacy.id}`, { token: A, body: { modules: ['assets', 'invoices'], permissions: { assets: { canEdit: false, canViewCost: false } } } });
  check('I', 'an old login can be saved with modules: it becomes configured', r.status === 200 && r.body.login.modulesConfigured === true, r.body);
  // preview: read only
  r = await call('POST', `/vendor-logins/${L.id.id}/open-portal`, { token: A });
  const handoff = r.body && r.body.token;
  r = seen(await call('POST', '/vendor-portal/preview/redeem', { body: { token: handoff } }));
  const PV = r.body && r.body.token;
  check('I', 'Preview portal: a single-use handoff gives a preview session', r.status === 200 && !!PV && r.body.landing === '/vendor/idcard-portal/dashboard', r.body); // 2026-10-19: an ID card vendor lands on its own Dashboard
  check('I', 'the handoff cannot be used twice', (await call('POST', '/vendor-portal/preview/redeem', { body: { token: handoff } })).status === 404);
  r = await call('GET', '/vendor-portal/me', { token: PV });
  check('I', 'preview /me carries the admin name (the banner reads "Preview as <vendor>") and the same nav', r.status === 200 && !!r.body.preview && r.body.nav.length >= 4, r.body);
  r = await call('POST', `${idP}/${orderC.id}/status`, { token: PV, body: { status: 'Received' } });
  check('I', 'preview is READ-ONLY: a status change is refused (403 preview)', r.status === 403 && r.body.preview === true, r.body);
  r = await call('POST', '/vendor-portal/module-bills?kind=invoice', { token: PV, form: pdfForm({ billNumber: 'PV', billDate: today(), amount: '5' }) });
  check('I', 'preview cannot send an invoice either (403)', r.status === 403 && r.body.preview === true);
  r = await call('POST', `${idP}/${orderC.id}/proof`, { token: PV, body: {} });
  check('I', 'preview cannot upload a proof (403)', r.status === 403);
  check('I', 'preview can read (list + detail)', (await call('GET', idP, { token: PV })).status === 200 && (await call('GET', `${idP}/${orderC.id}`, { token: PV })).status === 200);
  check('I', 'the order was not changed by the preview attempts', (await DB.one('SELECT "status" FROM "IdCardOrder" WHERE "id" = ?', [orderC.id])).status === 'New');
  // switch off
  r = await call('POST', `/vendor-logins/${L.id2.id}/deactivate`, { token: A });
  check('I', 'switching a login off signs it out at once (next call 401)', r.status === 200 && (await call('GET', '/vendor-portal/me', { token: L.id2.token })).status === 401 && (await call('GET', idP, { token: L.id2.token })).status === 401);
  r = await call('POST', '/vendor-portal/login', { body: { email: L.id2.email, password: PW('idcards2') } });
  check('I', 'a switched-off login cannot sign in (401; with the right password it says the login is switched off)', r.status === 401 && r.body.code === 'SWITCHED_OFF' && /switched off/i.test(r.body.error), r.body);
  r = await call('POST', `/vendor-master/${vRent.id}/deactivate`, { token: A, body: { reason: 'zztest' } });
  check('I', 'switching the VENDOR off blocks every login of it immediately', r.status === 200 && (await call('GET', '/vendor-portal/me', { token: L.rent.token })).status === 401);

  // ============================ I. no password ever ==============================================
  const bad = leaks.filter((t) => /passwordHash|"password"|\$2[aby]\$\d\d\$|newPassword/i.test(t));
  check('I', 'no response (create, list, /me, orders, SIM, bills, payments) ever carries a password or hash', bad.length === 0, bad.slice(0, 1).map((t) => t.slice(0, 200)));
  const listTxt = (await call('GET', '/vendor-logins', { token: A })).text;
  const optTxt = (await call('GET', '/vendor-logins/options', { token: A })).text;
  check('I', 'the admin login list and options carry no password either', !/passwordHash|"password"|\$2[aby]\$/.test(listTxt + optTxt));
  check('I', 'the create response has the secure link and no password field', L.it.created.body.inviteLink && !('password' in L.it.created.body) && !('tempPassword' in L.it.created.body), Object.keys(L.it.created.body));

  // ============================ J. staff doors ===================================================
  check('J', 'ID card orders: Admin and HR in, Recruiter and Accountant out', (await call('GET', '/id-card-orders', { token: A })).status === 200 && (await call('GET', '/id-card-orders', { token: HR })).status === 200 && (await call('GET', '/id-card-orders', { token: R })).status === 403 && (await call('GET', '/id-card-orders', { token: AC })).status === 403);
  check('J', 'vendor invoices review: Accountant and Admin in, HR and Recruiter out', (await call('GET', '/vendor-module-bills', { token: AC })).status === 200 && (await call('GET', '/vendor-module-bills', { token: A })).status === 200 && (await call('GET', '/vendor-module-bills', { token: R })).status === 403 && (await call('GET', '/vendor-module-bills', { token: HR })).status === 403);
  check('J', 'Add vendor login: a Recruiter cannot create a login (403)', (await call('POST', '/vendor-logins', { token: R, body: { vendorId: vRent.id, name: 'x', email: 'x@example.test' } })).status === 403);
  r = await call('GET', '/id-card-orders?status=Delivered', { token: HR });
  check('J', 'HR list filters by step and shows the vendor name', r.status === 200 && r.body.rows.some((o) => o.id === orderA.id && o.vendorName), r.body);

  // ============================ Part 5: the three sample vendors (sandbox only) =====================
  if (!NOSAMPLES) await samples(A);
}

async function samples(A) {
  console.log('\n=== PART 5 SAMPLE VENDORS (sandbox only; links are NOT emailed) ===');
  const defs = [
    ['Sample ID Cards Vendor', 'ID Cards', 'id_cards', 'ID Cards Contact', 'idcards@sample-vendor.test'],
    ['Airtel', 'Airtel SIM / Telecom', 'telecom', 'Airtel Account Manager', 'airtel@sample-vendor.test'],
    ['Sample Office Rent Vendor', 'Office Rent', 'office_rent', 'Rent Contact', 'rent@sample-vendor.test'],
  ];
  for (const [name, category, key, contact, email] of defs) {
    let v = await prisma.officeVendor.findFirst({ where: { name } });
    if (!v) {
      const r = await call('POST', '/vendor-master', { token: A, body: { name, category, contactPerson: contact, email } });
      if (r.status !== 201) { console.log(`  ${name}: could not add (${r.status} ${r.text.slice(0, 120)})`); continue; }
      v = r.body.vendor;
    }
    const existing = await prisma.vendorUser.findFirst({ where: { vendorId: v.id, deletedAt: null } });
    let link;
    if (!existing) {
      const r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: v.id, name: contact, email, modules: CFG.modulesForCategory(key), permissions: {} } });
      link = r.status === 201 ? r.body.inviteLink : `(login not created: ${r.status} ${r.text.slice(0, 120)})`;
    } else {
      const r = await call('POST', `/vendor-logins/${existing.id}/invite`, { token: A, body: {} });
      link = r.status === 200 ? r.body.inviteLink : `(could not make a new link: ${r.status})`;
    }
    console.log(`  ${name} [${category}] modules: ${CFG.modulesForCategory(key).map((k) => CFG.MODULES[k].label).join(', ')}\n    secure link: ${link}`);
  }
}

// ---------------------------------------------------------------------------------------------------
async function cleanup() {
  const ids = (a) => ({ in: a.length ? a : ['__none__'] });
  await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, create: { key: 'audit.allowPurge', value: '1' }, update: { value: '1' } });
  try {
    const vendorRows = await prisma.officeVendor.findMany({ where: { name: { startsWith: 'ZZTEST VM' } }, select: { id: true } });
    const vendorIds = [...new Set([...made.vendors, ...vendorRows.map((v) => v.id)])];
    const loginRows = await prisma.vendorUser.findMany({ where: { OR: [{ vendorId: ids(vendorIds) }, { email: { contains: `${RUN}@example.test` } }] }, select: { id: true } });
    const logins = [...new Set([...made.logins, ...loginRows.map((l) => l.id)])];
    const orders = await DB.q('SELECT "id","challanFile" FROM "IdCardOrder" WHERE "vendorId" IN (' + vendorIds.map(() => '?').join(',') + ')', vendorIds.length ? vendorIds : ['__none__']);
    const bills = await DB.q('SELECT "id","documentFile" FROM "VendorModuleBill" WHERE "vendorId" IN (' + vendorIds.map(() => '?').join(',') + ')', vendorIds.length ? vendorIds : ['__none__']);
    for (const f of [...orders.map((o) => o.challanFile), ...bills.map((b) => b.documentFile), ...made.files]) if (f) attachments.remove(f);
    for (const o of orders) { await DB.run('DELETE FROM "IdCardOrderLine" WHERE "orderId" = ?', [o.id]); await DB.run('DELETE FROM "IdCardOrderEvent" WHERE "orderId" = ?', [o.id]); }
    for (const t of ['IdCardOrder', 'SimConnection', 'SimRequest', 'VendorModuleBill']) { for (const v of vendorIds) await DB.run(`DELETE FROM "${t}" WHERE "vendorId" = ?`, [v]); } // eslint-disable-line no-await-in-loop
    for (const l of logins) await DB.run('DELETE FROM "VendorLoginModule" WHERE "vendorUserId" = ?', [l]); // eslint-disable-line no-await-in-loop
    await prisma.task.deleteMany({ where: { OR: [{ assigneeId: ids(made.users) }, { assignedById: ids(made.users) }] } });
    await prisma.vendorSharedDocument.deleteMany({ where: { vendorId: ids(vendorIds) } });
    await prisma.vendorBillSubmission.deleteMany({ where: { vendorId: ids(vendorIds) } });
    await prisma.vendorLoginToken.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorSession.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorUser.deleteMany({ where: { id: ids(logins) } });
    await prisma.officeVendor.deleteMany({ where: { id: ids(vendorIds) } });
    await prisma.employeeDocument.deleteMany({ where: { employeeId: ids(made.employees) } });
    await prisma.employee.deleteMany({ where: { id: ids(made.employees) } });
    await prisma.asset.deleteMany({ where: { id: ids(made.assets) } });
    await prisma.assetAuditLog.deleteMany({ where: { OR: [{ vendorId: ids(vendorIds) }, { vendorUserId: ids(logins) }, { actorName: { contains: 'ZZTEST' } }, { changedById: ids(made.users) }, { assetId: ids(made.assets) }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: ids(made.users) }, { entityId: ids([...vendorIds, ...logins, ...made.orders, ...made.sims, ...made.bills]) }, { actorName: { contains: 'ZZTEST' } }, { toValue: { contains: 'ZZTEST' } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: ids(made.users) }, { recipient: { contains: 'example.test' } }] } });
    await prisma.user.deleteMany({ where: { id: ids(made.users) } });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: 'audit.allowPurge' } });
    // put the Vendor-emails setting back as it was
    if (made.emailsBefore) await prisma.appSetting.update({ where: { key: 'vendorPortal.settings' }, data: { value: made.emailsBefore.value } }).catch(() => {});
    else if (made.emailsBefore === null) await prisma.appSetting.deleteMany({ where: { key: 'vendorPortal.settings' } });
  }
  const left = {
    vendors: await prisma.officeVendor.count({ where: { name: { startsWith: 'ZZTEST' } } }),
    users: await prisma.user.count({ where: { email: { contains: 'zztest.vm.' } } }),
    employees: await prisma.employee.count({ where: { name: { startsWith: 'ZZTEST VM' } } }),
    orders: (await DB.one('SELECT COUNT(*) AS n FROM "IdCardOrder" WHERE "note" LIKE \'ZZTEST VM%\'')).n,
    breakGlassLeftOn: await prisma.appSetting.count({ where: { key: 'audit.allowPurge' } }),
  };
  console.log('CLEANUP', JSON.stringify(left));
  return left;
}

main().then(async () => {
  let left = null;
  try { left = await cleanup(); } catch (c) { console.error('cleanup failed', c && c.stack); }
  const fail = results.filter((x) => !x.ok);
  const groups = {};
  results.forEach((x) => { groups[x.group] = groups[x.group] || { pass: 0, fail: 0 }; groups[x.group][x.ok ? 'pass' : 'fail'] += 1; });
  console.log(`\n${results.length - fail.length}/${results.length} passed`, JSON.stringify(groups));
  if (left && (left.vendors || left.users || left.employees || left.orders || left.breakGlassLeftOn)) console.log('LEFTOVER ROWS', left);
  await prisma.$disconnect();
  process.exit(fail.length ? 1 : 0);
}).catch(async (e) => {
  console.error('TEST CRASHED', e && e.stack);
  try { await cleanup(); } catch (c) { console.error('cleanup failed', c && c.message); }
  await prisma.$disconnect();
  process.exit(1);
});
