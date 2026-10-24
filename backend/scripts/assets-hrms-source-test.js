#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - ASSETS COME FROM HRMS (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/assets-hrms-source-test.js                           makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/ahs-copy.db node scripts/assets-hrms-source-test.js  use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4077, TEST_MODE) on the copy, builds ZZTEST fixtures there (two asset vendors + two look-alike vendors, assets with and
// without vendor info, a repair, an invoice) and proves that the Assets Vendor Portal reads the company's REAL HRMS asset rows:
//   A  the careful name match (unit): case, spaces, punctuation, Pvt / Ltd words; nothing fuzzy
//   B  which assets a vendor gets: linked, bought-from name, repaired-by name, bill invoice number; NOT ambiguous, NOT partial, NOT another vendor's
//   C  Admin's choice: one asset, a whole category (a new asset in it follows), revoke; unique keys; audited; the count preview = what the vendor sees
//   D  the vendor sees exactly that, ids = HRMS ids, brand / model / serial from HRMS, department only, an independent recomputation agrees
//   E  isolation: another vendor / unknown id / ids in the query or body (IDOR); the Admin API is closed to vendors and to non-Admins
//   F  no leaks: no employee detail, no bank / cost / history fields in any response; cost shown only with "Show purchase value"
//   G  nothing created or copied: Asset row count unchanged, no duplicate id or code; the real (non-ZZ) register stays invisible until granted
//   H  Accounts reads the same HRMS rows (Register, Pending from HRMS, Repair cost, Asset summary)
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
  copy = path.join(os.tmpdir(), `ahs-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4077);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `ahs-uploads-${RUN}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
if (/dev\.db/i.test(DB_URL)) { console.error('Refusing: the database path looks like dev.db.'); process.exit(2); }
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = UPLOADS;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const HS = require(path.join(BACK, 'src/utils/assetHrmsScope'));

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
async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

const made = { users: [], vendors: [], assets: [], repairs: [], expenses: [] };
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

    // ------------------------------------------------------------------ staff
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AHS ${tag} ${RUN}`, email: `zz-ahs-${tag}-${RUN}@example.test`, username: `zz-ahs-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true, accountsRole: 'ADMIN' });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const T = { admin: await tok(uAdmin), rec: await tok(uRec) };

    // ================================================================ A  the careful name match (pure)
    const K = HS.nameKey;
    check('A', 'case, spaces, punctuation and company words do not matter: "Sai Laptop Care Pvt. Ltd." = "SAI  laptop care" = "Sai-Laptop Care Private Limited"', K('Sai Laptop Care Pvt. Ltd.') === 'sai laptop care' && K('SAI  laptop care') === 'sai laptop care' && K('Sai-Laptop Care Private Limited') === 'sai laptop care');
    check('A', '"&" and "and" are the same word', K('R & D Services LLP') === K('R and D Services'));
    check('A', 'a partial name is NOT equal ("Sai Laptop" vs "Sai Laptop Care")', K('Sai Laptop') !== K('Sai Laptop Care'));
    check('A', 'nothing meaningful left = no key (so it can never match): "Pvt Ltd", "", "  ", "ab"', ['Pvt Ltd', '', '   ', 'ab', null].every((x) => K(x) === ''));
    check('A', 'brand / model / serial are read from the HRMS type text and nothing else',
      JSON.stringify(HS.parseType('JABRA HSC027 · SN 00118040642W26K · Tag TL-H-HR')) === JSON.stringify({ descriptor: 'JABRA HSC027', brand: 'JABRA', model: 'HSC027', serial: '00118040642W26K' })
      && HS.parseType('Airtel · ICCID 8991000923687703004U').serial === '8991000923687703004U' && HS.parseType('Plantronics').brand === 'Plantronics' && HS.parseType('Plantronics').model === null && HS.parseType(null).brand === null);
    const src = fs.readFileSync(path.join(BACK, 'src/routes/assetInventory.js'), 'utf8');
    const m = /const SEAT_DEPARTMENTS = (\{[^}]*\});/.exec(src);
    // eslint-disable-next-line no-new-func
    const theirs = m ? new Function(`return ${m[1]}`)() : null;
    check('A', 'the seat-code -> department table is the same as the HRMS asset screen\'s', theirs && JSON.stringify(theirs) === JSON.stringify(HS.SEAT_DEPARTMENTS) && HS.deptOfSeat('BDE EDU-1') === 'BDE' && HS.deptOfSeat('R&D-3') === 'R&D' && HS.deptOfSeat('EDU-8') === 'Education' && HS.deptOfSeat('') === null);

    // ================================================================ fixtures
    const IT = 'IT / Hardware / AMC / Service';
    const mkVendor = async (tag, name, extra = {}) => {
      const v = await prisma.officeVendor.create({ data: { name: `${name}`, isActive: true, category: IT, ...extra } });
      made.vendors.push(v.id); return v;
    };
    const V1 = await mkVendor('1', `ZZTEST AHS Sai Laptop Care Pvt Ltd ${RUN}`);
    const V2 = await mkVendor('2', `ZZTEST AHS Bravo Services ${RUN}`);
    const V3 = await mkVendor('3', `ZZTEST AHS Twin One ${RUN}`);
    const V4 = await mkVendor('4', `ZZTEST AHS Twin One Ltd ${RUN}`);
    const mkLogin = async (vendor, tag, { canEdit = true, canViewCost = false } = {}) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-ahs-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit, canViewCost } });
      return { u, pw };
    };
    const L1 = await mkLogin(V1, 'v1'); const L1c = await mkLogin(V1, 'v1cost', { canViewCost: true }); const L2 = await mkLogin(V2, 'v2'); const L3 = await mkLogin(V3, 'v3');
    const sign = async (L) => { const r = await http('POST', '/api/vendor-portal/login', null, { email: L.u.email, password: L.pw }); L.token = r.body && r.body.token; return L; };
    for (const L of [L1, L1c, L2, L3]) await sign(L); // eslint-disable-line no-await-in-loop
    const AP = '/api/vendor-portal/asset-portal';

    const emp = await prisma.employee.findFirst({ where: { NOT: { email: null } }, select: { id: true, name: true, email: true, phone: true, employeeCode: true, department: true } });
    const mkAsset = async (n, o) => {
      const a = await prisma.asset.create({ data: { assetCode: `ZZAH-${RUN}-${n}`, name: `ZZTEST Asset ${n}`, category: o.category || 'ZZ Laptop', status: o.status || 'Available', vendorId: o.vendorId || null, vendor: o.vendor || null, invoiceNo: o.invoiceNo || null, assetType: o.assetType || null, serialNumber: o.serial || null, purchaseCost: o.cost || null, purchaseDate: '2026-01-10', location: o.location || null, assignedToId: o.holder || null, history: JSON.stringify([{ at: '2026-01-01 10:00', by: 'HR', text: 'ZZTEST history line must not leak' }]) } });
      made.assets.push(a.id); return a;
    };
    const a1 = await mkAsset(1, { vendorId: V1.id, assetType: 'ACME X1 · SN SNA1' + RUN + ' · Tag T1', location: 'EDU-1', status: 'Assigned', holder: emp && emp.id, cost: 12345.67 });
    const a2 = await mkAsset(2, { vendor: `zztest ahs  SAI laptop care ${RUN}` });
    const a3 = await mkAsset(3, { vendor: `ZZTEST AHS Sai Laptop Care Private Limited. ${RUN}` });
    const a4 = await mkAsset(4, { vendor: `ZZTEST AHS Twin One ${RUN}` });
    const a5 = await mkAsset(5, { vendor: 'ZZTEST AHS Sai Laptop' });
    const a6 = await mkAsset(6, { category: 'ZZ Printer' });
    const a7 = await mkAsset(7, { category: 'ZZ Mouse' });
    const a8 = await mkAsset(8, { category: 'ZZ Cat' });
    const a9 = await mkAsset(9, { category: 'ZZ Cat', serial: `SERIAL-NINE-${RUN}` });
    const a10 = await mkAsset(10, { category: 'ZZ Cat', status: 'Retired' });
    const a11 = await mkAsset(11, { vendorId: V2.id, vendor: `ZZTEST AHS Sai Laptop Care Pvt Ltd ${RUN}`, category: 'ZZ Laptop' }); // linked to V2, text says V1: stays V2's
    const a12 = await mkAsset(12, { category: 'ZZ Other' }); // nobody's
    const a13 = await mkAsset(13, { vendor: `ZZTEST AHS Bravo Services ${RUN}`, invoiceNo: `ZZINV-${RUN}-13`, cost: 777.77, category: 'ZZ Laptop' });
    const a14 = await mkAsset(14, { invoiceNo: `ZZ-INV/${RUN}/14`, category: 'ZZ Laptop' });
    const a6vend = await mkAsset(15, { category: 'ZZ Printer' });
    // a bill Accounts booked against V2 carries a14's invoice number (spelled differently)
    const ex = await prisma.officeExpense.create({ data: { category: 'ZZTEST', monthlyAmount: 100, vendorId: V2.id, billNumber: `zz-inv ${RUN} 14`, vendor: V2.name, expenseDate: '2026-02-01' } });
    made.expenses.push(ex.id);
    const mkRepair = async (n, assetId, vendor, status = 'Reported') => {
      const row = await prisma.assetRepair.create({ data: { repairNo: `RP-ZZAH${RUN}-${n}`, assetId, issue: `ZZTEST issue ${n}`, vendor, status, dateReported: '2026-09-01' } });
      made.repairs.push(row.id); return row;
    };
    const rep6 = await mkRepair('6', a6vend.id, `ZZTEST  AHS SAI  LAPTOP CARE ${RUN}`); // repaired by V1 (upper case, double space)
    const rep1blank = await mkRepair('1', a1.id, null); // a1 is V1's, no vendor named yet
    const rep1V2 = await mkRepair('2', a1.id, V2.name); // a1 sent to V2
    await http('GET', `${AP}/overview`, L1.token); // the portal creates its own tables on first use

    const allRows = async (L, qs = '') => { const r = await http('GET', `${AP}/assets?view=all&pageSize=100${qs}`, L.token); return r; };
    const idsOf = (r) => (r.body && r.body.rows ? r.body.rows.map((x) => x.id) : []);
    const assetTotalStart = (await raw('SELECT COUNT(*) AS n FROM "Asset"'))[0].n;
    const realStart = (await raw(`SELECT COUNT(*) AS n FROM "Asset" WHERE "assetCode" NOT LIKE 'ZZAH-%'`))[0].n;

    // ================================================================ B  which assets a vendor gets (no grants yet)
    let r = await allRows(L1);
    let ids = idsOf(r);
    check('B', 'vendor 1 sees exactly: a1 (linked), a2 + a3 (bought from "Sai Laptop Care" - case / Pvt / punctuation differ), a6vend (repaired by "SAI  LAPTOP CARE")',
      r.status === 200 && sameSet(ids, [a1.id, a2.id, a3.id, a6vend.id]), ids.length);
    check('B', 'it does NOT see: the ambiguous name (a4), the partial name (a5), an asset linked to vendor 2 (a11, even though its text names vendor 1), vendor 2\'s supplier / bill assets, an asset nobody has', ![a4, a5, a11, a13, a14, a12, a6, a7, a8, a9].some((a) => ids.includes(a.id)));
    check('B', 'it sees NONE of the real company register (every non-ZZ asset of this copy stays out of sight until it is linked or granted)', !r.body.rows.some((x) => !String(x.assetCode).startsWith('ZZAH-')));
    r = await allRows(L2); ids = idsOf(r);
    check('B', 'vendor 2 sees exactly: a11 (linked), a13 (bought from it by name), a14 (a bill booked against it carries the invoice number, spelled differently), a1 (the company sent a1 to it for repair)', sameSet(ids, [a11.id, a13.id, a14.id, a1.id]), ids.length);
    r = await allRows(L3); ids = idsOf(r);
    check('B', 'vendor 3 (a name that another vendor also has, after the clean-up) gets NOTHING by name: a4 is not given to either twin', ids.length === 0);
    const sc1 = await HS.preview({ vendorId: V1.id });
    const sc3 = await HS.preview({ vendorId: V3.id }); const sc4 = await HS.preview({ vendorId: V4.id });
    check('B', 'the ambiguous name is LISTED for Admin for both twins, with both candidates, and given to neither', sc3.ambiguous.some((x) => x.assetId === a4.id && x.candidates.length === 2) && sc4.ambiguous.some((x) => x.assetId === a4.id) && sc3.total === 0 && sc4.total === 0, sc3.ambiguous);
    check('B', 'the partial name is LISTED as "possible" for vendor 1 and not given', sc1.possible.some((x) => x.assetId === a5.id) && !sc1.rows.some((x) => x.id === a5.id), sc1.possible);
    check('B', 'every automatic asset carries its reason', sc1.rows.find((x) => x.id === a1.id).reasons.includes('linked') && sc1.rows.find((x) => x.id === a2.id).reasons.includes('supplier') && sc1.rows.find((x) => x.id === a6vend.id).reasons.includes('repaired') && sc1.rows.every((x) => x.reasonText.length), sc1.rows.map((x) => [x.assetCode, x.reasons]));
    check('B', 'an archived (Retired) asset is never shown', !(await allRows(L1)).body.rows.some((x) => x.id === a10.id));

    // ================================================================ D  what the vendor sees of an asset
    r = await allRows(L1);
    const row1 = r.body.rows.find((x) => x.id === a1.id);
    check('D', 'the portal id is the HRMS id and the asset code is the HRMS code (the same row, not a copy)', row1 && row1.id === a1.id && row1.assetCode === a1.assetCode);
    check('D', 'brand, model and serial number come from what HRMS holds in the asset type ("ACME X1 · SN ...")', row1.brand === 'ACME' && row1.model === 'X1' && row1.serialNumber === `SNA1${RUN}`, row1);
    check('D', 'name, category, condition, assigned vendor and status are all on the row', row1.name === a1.name && row1.category === 'ZZ Laptop' && 'condition' in row1 && row1.assignedVendor === V1.name && row1.status === 'Assigned');
    check('D', 'the department is shown (the seat EDU-1 = Education or the holder\'s department), not who holds it', typeof row1.department === 'string' && row1.department.length > 0, row1.department);
    check('D', 'the raw HRMS type text with its tag is not shown, only the type', !r.text.includes('Tag T1') && row1.assetType === 'ACME X1');
    const d1 = await http('GET', `${AP}/assets/${a1.id}`, L1.token);
    check('D', 'asset detail opens for a linked asset and lists its repairs: the blank one and not the one sent to vendor 2', d1.status === 200 && d1.body.repairs.some((x) => x.id === rep1blank.id) && !d1.body.repairs.some((x) => x.id === rep1V2.id) && d1.body.canEdit === true, d1.body && d1.body.repairs && d1.body.repairs.length);
    r = await http('GET', `${AP}/repairs?pageSize=100`, L1.token);
    check('D', 'vendor 1\'s repairs: the one that names it (rep6, any case) and the blank one on its own asset; not the one that names vendor 2', r.status === 200 && sameSet(r.body.rows.map((x) => x.id), [rep6.id, rep1blank.id]), r.body.rows && r.body.rows.map((x) => x.repairNo));
    r = await http('GET', `${AP}/repairs?pageSize=100`, L2.token);
    check('D', 'vendor 2 sees the repair that names it and not vendor 1\'s', r.status === 200 && sameSet(r.body.rows.map((x) => x.id), [rep1V2.id]), r.body.rows && r.body.rows.map((x) => x.repairNo));

    // ================================================================ C  Admin's choice
    const G = '/api/vendor-logins/asset-grants';
    let g = await http('GET', `${G}/${V1.id}`, T.admin);
    check('C', 'Admin\'s picture for vendor 1: "will see N" equals what the vendor sees, with the list and the reasons', g.status === 200 && g.body.total === 4 && g.body.rows.length === 4 && g.body.byReason.linked === 1 && g.body.byReason.supplier === 2 && g.body.byReason.repaired === 1 && g.body.byReason.admin === 0, g.body);
    check('C', 'the category list for the checklist carries counts of the real HRMS categories', g.body.categories.some((c) => c.value === 'ZZ Cat' && c.count === 2) && g.body.categories.some((c) => c.value === 'Laptop'), g.body.categories.slice(0, 4));
    let pv = await http('POST', `${G}/${V1.id}/preview`, T.admin, { assetIds: [a7.id], categories: ['ZZ Cat'] });
    check('C', 'the preview of UNSAVED ticks counts them live (4 + a7 + the 2 live ZZ Cat assets = 7) and saves nothing', pv.status === 200 && pv.body.total === 7 && (await raw('SELECT COUNT(*) AS n FROM "VendorAssetGrant" WHERE "vendorId" = ?', V1.id))[0].n === 0, pv.body && pv.body.total);
    r = await allRows(L1);
    check('C', 'before saving, the vendor still sees 4', r.body.total === 4);
    let put = await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [a7.id], categories: ['ZZ Cat'] });
    check('C', 'saving the ticks works and says how many the vendor will see', put.status === 200 && put.body.total === 7 && /7 assets/.test(put.body.message), put.body);
    r = await allRows(L1); ids = idsOf(r);
    check('C', 'the portal now shows a7 (chosen asset) and a8 + a9 (chosen category), not the retired one; the count equals Admin\'s preview', sameSet(ids, [a1.id, a2.id, a3.id, a6vend.id, a7.id, a8.id, a9.id]) && r.body.total === put.body.total, ids.length);
    const a15 = await mkAsset(16, { category: 'ZZ Cat' });
    check('C', 'a NEW asset added to a chosen category follows by itself', idsOf(await allRows(L1)).includes(a15.id));
    check('C', 'another vendor sees none of what was granted to vendor 1', !idsOf(await allRows(L2)).some((i) => [a7, a8, a9, a15].some((a) => a.id === i)) && !idsOf(await allRows(L3)).length);
    put = await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [a7.id], categories: ['ZZ Cat'] });
    check('C', 'saving the same ticks again changes nothing and makes no duplicate row', put.status === 200 && put.body.changed === 0 && (await raw('SELECT COUNT(*) AS n FROM "VendorAssetGrant" WHERE "vendorId" = ?', V1.id))[0].n === 2);
    let dupOk = false;
    try { await raw('INSERT INTO "VendorAssetGrant" ("id","vendorId","kind","assetId","category","grantKey","grantedAt") VALUES (?,?,?,?,?,?,?)', `zzdup${RUN}`, V1.id, 'asset', a7.id, null, HS.assetKey(a7.id), new Date().toISOString()); } catch { dupOk = true; }
    check('C', 'the database itself refuses a second identical grant (unique key)', dupOk);
    const aud = await raw(`SELECT "action","field","newValue","oldValue","actorName","role" FROM "AssetAuditLog" WHERE "vendorId" = ? AND "action" LIKE 'Asset access%' ORDER BY "createdAt"`, V1.id);
    check('C', 'every add is audited with who, what and the asset code / category', aud.filter((x) => x.action === 'Asset access granted').length === 2 && aud.some((x) => x.newValue === a7.assetCode) && aud.some((x) => x.newValue === 'ZZ Cat') && aud.every((x) => x.role === 'Admin' && x.actorName), aud);
    // a category name in other letters is the same category; an unknown one / an unknown asset id is refused
    check('C', 'an unknown category or asset id is refused and nothing is stored', (await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [], categories: ['No Such Category'] })).status === 400 && (await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: ['nope'], categories: [] })).status === 400 && (await raw('SELECT COUNT(*) AS n FROM "VendorAssetGrant" WHERE "vendorId" = ?', V1.id))[0].n === 2);
    const srch = await http('GET', `${G}/${V1.id}/search?q=${encodeURIComponent(`ZZAH-${RUN}-9`)}`, T.admin);
    check('C', 'type-to-search finds an HRMS asset by code and says whether it is ticked / in a ticked category', srch.status === 200 && srch.body.rows.some((x) => x.assetId === a9.id && x.inCategory === true), srch.body);
    check('C', 'search by serial number also works', (await http('GET', `${G}/${V1.id}/search?q=SERIAL-NINE-${RUN}`, T.admin)).body.rows.some((x) => x.assetId === a9.id));
    // revoke the single asset and the category
    put = await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [], categories: [] });
    r = await allRows(L1); ids = idsOf(r);
    check('C', 'removing the ticks takes the assets away at once (same request after the save)', put.status === 200 && put.body.changed === 2 && sameSet(ids, [a1.id, a2.id, a3.id, a6vend.id]) && (await http('GET', `${AP}/assets/${a7.id}`, L1.token)).status === 403 && (await http('GET', `${AP}/assets/${a8.id}`, L1.token)).status === 403, ids.length);
    const aud2 = await raw(`SELECT "action" FROM "AssetAuditLog" WHERE "vendorId" = ? AND "action" = 'Asset access removed'`, V1.id);
    check('C', 'every removal is audited too', aud2.length === 2, aud2);
    // a grant on a real HRMS category: reads the company's real rows by their own ids
    const realCat = (await raw(`SELECT "category", COUNT(*) AS n FROM "Asset" WHERE "assetCode" NOT LIKE 'ZZAH-%' AND "status" NOT IN ('Retired','Sold','Written off') GROUP BY "category" ORDER BY n DESC`))[0];
    if (realCat) {
      put = await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [], categories: [realCat.category] });
      r = await allRows(L1);
      const realIds = (await raw(`SELECT "id" FROM "Asset" WHERE "category" = ? AND (("status" = 'Available' AND "assignedToId" IS NULL) OR "status" = 'In Repair')`, realCat.category)).map((x) => x.id);
      const seenReal = idsOf(r).filter((i) => realIds.includes(i));
      check('G', `granting the real HRMS category "${realCat.category}" shows the real rows: the ${realIds.length} that are free in stock or under repair (the others are held by employees and are not shown: founder decision 2026-10-19); an independent SQL count agrees`, seenReal.length === realIds.length && sameSet(seenReal, realIds), [seenReal.length, realIds.length]);
      const pageRows = [];
      for (let p = 1; p <= r.body.pages; p += 1) pageRows.push(...(await http('GET', `${AP}/assets?view=all&pageSize=100&page=${p}`, L1.token)).body.rows); // eslint-disable-line no-await-in-loop
      check('G', 'over all pages every asset appears once (no duplicate id, no duplicate code) and the count equals the total', pageRows.length === r.body.total && new Set(pageRows.map((x) => x.id)).size === pageRows.length && new Set(pageRows.map((x) => x.assetCode)).size === pageRows.length, [pageRows.length, r.body.total]);
      await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [], categories: [] });
    }

    // ================================================================ E  isolation
    for (const [what, aid] of [['vendor 2\'s asset', a11.id], ['an asset nobody has', a12.id], ['a retired asset', a10.id], ['the twin\'s ambiguous asset', a4.id], ['an unknown id', 'nope-nope']]) {
      r = await http('GET', `${AP}/assets/${aid}`, L1.token);
      check('E', `vendor 1 opening ${what}: 403, no asset detail in the answer`, r.status === 403 && !/assetCode/.test(r.text), r.status);
    }
    r = await http('GET', `${AP}/assets/${a1.id}`, L2.token);
    check('E', 'vendor 2 opening vendor 1\'s linked asset (a1): the company sent it to vendor 2 for repair, so it opens read-only (cannot be edited)', r.status === 200 && r.body.canEdit === false, r.body && r.body.canEdit);
    r = await http('PATCH', `${AP}/assets/${a1.id}`, L2.token, { brand: 'Hacked' });
    check('E', 'vendor 2 cannot edit vendor 1\'s asset even though it is here for a repair (403)', r.status === 403 && (await raw('SELECT * FROM "AssetVendorInfo" WHERE "assetId" = ?', a1.id)).length === 0, r.body);
    r = await http('PATCH', `${AP}/assets/${a11.id}`, L1.token, { brand: 'Hacked' });
    check('E', 'vendor 1 cannot edit vendor 2\'s asset (403)', r.status === 403, r.body);
    r = await http('PATCH', `${AP}/assets/${a6vend.id}`, L1.token, { brand: 'Nope' });
    check('E', 'an asset that is with vendor 1 for a repair only cannot have its details changed (403)', r.status === 403, r.body);
    r = await http('PATCH', `${AP}/assets/${a2.id}`, L1.token, { brand: 'Dell', model: 'E5470', condition: 'Good' });
    check('E', 'an asset bought from vendor 1 can be edited by a login that may edit: brand, model, condition saved in the side table (no new asset)', r.status === 200 && r.body.changed.length === 3 && (await raw('SELECT COUNT(*) AS n FROM "AssetVendorInfo" WHERE "assetId" = ?', a2.id))[0].n === 1, r.body);
    r = await http('GET', `${AP}/assets?vendorId=${V2.id}&vendorUserId=${L2.u.id}&assetId=${a11.id}`, L1.token);
    check('E', 'a vendorId / vendorUserId / assetId in the query is ignored', r.status === 200 && !idsOf(r).includes(a11.id));
    r = await http('GET', `${AP}/repairs/${rep1V2.id}`, L1.token);
    check('E', 'vendor 1 opening the repair that names vendor 2: 403', r.status === 403);
    r = await http('PATCH', `${AP}/repairs/${rep1V2.id}`, L1.token, { stage: 'Sent for repair' });
    check('E', 'vendor 1 changing that repair: 403 and nothing changed', r.status === 403 && (await prisma.assetRepair.findUnique({ where: { id: rep1V2.id } })).status === 'Reported', r.body);
    r = await http('GET', `${G}/${V1.id}`, L1.token);
    check('E', 'a vendor token cannot reach the Admin screen', r.status === 403 || r.status === 401, r.status);
    r = await http('GET', `${G}/${V1.id}`, T.rec); const r2 = await http('PUT', `${G}/${V1.id}`, T.rec, { assetIds: [a12.id], categories: [] });
    check('E', 'a recruiter (not Admin) cannot read or change it (403), and nothing was stored', r.status === 403 && r2.status === 403 && (await raw('SELECT COUNT(*) AS n FROM "VendorAssetGrant" WHERE "vendorId" = ?', V1.id))[0].n === 0);
    r = await http('GET', `${G}/${V1.id}`, null);
    check('E', 'signed out: 401', r.status === 401);
    r = await http('PUT', `${G}/nope-vendor`, T.admin, { assetIds: [], categories: [] });
    check('E', 'a vendor id that does not exist: 404', r.status === 404);

    // ================================================================ F  no leaks
    const sweep = [];
    for (const [name, resp] of [['list', await allRows(L1)], ['detail', await http('GET', `${AP}/assets/${a1.id}`, L1.token)], ['overview', await http('GET', `${AP}/overview`, L1.token)], ['repairs', await http('GET', `${AP}/repairs?pageSize=100`, L1.token)], ['invoices', await http('GET', `${AP}/invoices`, L1.token)]]) {
      const t = resp.text;
      const bad = [];
      if (emp) {
        if (emp.name && emp.name.length >= 4 && t.includes(emp.name)) bad.push('employee name');
        if (emp.email && t.includes(emp.email)) bad.push('employee email');
        if (emp.phone && String(emp.phone).length >= 8 && t.includes(String(emp.phone))) bad.push('employee phone');
        if (emp.employeeCode && t.includes(`"${emp.employeeCode}"`)) bad.push('employee code');
      }
      for (const key of ['"assignedTo"', '"assignedToId"', 'assignedByName', 'bankAccount', 'accountNumber', 'ifsc', 'paidBankAccountId', 'paidVia', 'gstPaid', 'purchaseCost', 'salvageValue', 'depreciation', 'history":"[', 'must not leak', V2.name]) if (t.includes(key)) bad.push(key);
      sweep.push([name, bad]);
    }
    check('F', 'no employee detail, bank / cost / depreciation / history text and no other vendor\'s name in the list, detail, overview, repairs or invoices answers', sweep.every(([, b]) => !b.length), sweep.filter(([, b]) => b.length));
    const dc = await http('GET', `${AP}/assets/${a1.id}`, L1c.token);
    const lc = await allRows(L1c);
    check('F', 'purchase value is shown only to a login with "Show purchase value"', dc.status === 200 && Number(dc.body.asset.amount) === 12345.67 && lc.body.rows.find((x) => x.id === a1.id).amount === 12345.67 && row1.amount === 12345.67 && !('purchaseCost' in row1)); // amounts are shown by default now
    const d13 = await http('GET', `${AP}/assets/${a14.id}`, L2.token);
    check('F', 'an asset bought from the vendor shows the invoice number even without the cost; the cost stays hidden', d13.status === 200 && d13.body.asset.invoiceNo === a14.invoiceNo && !('purchaseCost' in d13.body.asset), d13.body && d13.body.asset);
    const d2cat = await mkAsset(17, { category: 'ZZ Laptop', invoiceNo: 'SOMEONE-ELSES-INV', cost: 4321 });
    await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [d2cat.id], categories: [] });
    const dg = await http('GET', `${AP}/assets/${d2cat.id}`, L1.token);
    check('F', 'an asset only chosen by Admin (maybe bought from someone else) does NOT show its purchase invoice number (the amount is shown by default)', dg.status === 200 && !dg.text.includes('SOMEONE-ELSES-INV') && dg.body.asset.amount === 4321, dg.body && dg.body.purchase);
    await http('PUT', `${G}/${V1.id}`, T.admin, { assetIds: [], categories: [] });

    // ================================================================ G  nothing created or copied
    const assetTotalEnd = (await raw('SELECT COUNT(*) AS n FROM "Asset"'))[0].n;
    const created = made.assets.length;
    check('G', 'no asset row was created by the portal or the Admin screen (only the ZZ fixtures exist beyond the start count)', assetTotalEnd - assetTotalStart === created - 15, [assetTotalStart, assetTotalEnd, created]);
    check('G', 'the real (non-ZZ) register is untouched in count', (await raw(`SELECT COUNT(*) AS n FROM "Asset" WHERE "assetCode" NOT LIKE 'ZZAH-%'`))[0].n === realStart);
    check('G', 'asset codes are unique across the table (no duplicate)', (await raw('SELECT COUNT(*) AS n FROM (SELECT "assetCode" FROM "Asset" GROUP BY "assetCode" HAVING COUNT(*) > 1)'))[0].n === 0);
    check('G', 'the portal keeps no copy of an asset: its only asset-side tables are the vendor\'s note (one row per asset id) and Admin\'s grant', (await raw(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('AssetCopy','VendorAsset','PortalAsset')`))[0].n === 0 && (await raw('SELECT COUNT(*) AS n FROM (SELECT "assetId" FROM "AssetVendorInfo" GROUP BY "assetId" HAVING COUNT(*) > 1)'))[0].n === 0);
    check('G', 'the older "Asset.vendorId" and the free-text "vendor" of the HRMS rows were not changed by reading (a2 still has no vendorId)', (await prisma.asset.findUnique({ where: { id: a2.id } })).vendorId === null && (await prisma.asset.findUnique({ where: { id: a2.id } })).vendor === `zztest ahs  SAI laptop care ${RUN}`);

    // ================================================================ H  Accounts takes the same HRMS rows
    const A = require(path.join(BACK, 'src/utils/assetPosting'));
    const loaded = await A.loadAssets();
    check('H', 'Accounts\' asset loader reads EVERY HRMS Asset row (the number equals the table count)', loaded.length === (await raw('SELECT COUNT(*) AS n FROM "Asset"'))[0].n);
    const reg = await http('GET', '/api/accounts/fixed-assets/register', T.admin);
    check('H', 'Accounts > Fixed Assets > Assets lists all of them', reg.status === 200 && reg.body.rows.length === loaded.length && reg.body.totals.count === loaded.length, reg.body && reg.body.totals);
    const sum = await http('GET', '/api/accounts/fixed-assets/summary', T.admin);
    check('H', 'Asset summary counts all of them across the categories', sum.status === 200 && sum.body.totals.assets === loaded.length, sum.body && sum.body.totals);
    const pend = await http('GET', '/api/accounts/fixed-assets/pending?all=1', T.admin);
    const withCost = (await raw('SELECT COUNT(*) AS n FROM "Asset" WHERE "purchaseCost" > 0'))[0].n;
    check('H', 'Pending from HRMS has one purchase row for every HRMS asset that has a purchase cost', pend.status === 200 && pend.body.rows.filter((x) => x.kind === 'purchase').length === withCost, [pend.body && pend.body.rows.filter((x) => x.kind === 'purchase').length, withCost]);
    const rc = await http('GET', '/api/accounts/fixed-assets/repair-cost', T.admin);
    check('H', 'Repair cost lists the assets that have a repair (our ZZ repairs are there: they are HRMS AssetRepair rows)', rc.status === 200 && rc.body.rows.some((x) => x.assetId === a1.id), rc.body && rc.body.totals);

    // ================================================================ I  the setup
    const S = require(path.join(BACK, 'src/utils/assetVendorSchema'));
    S.reset(); const once = await S.ensure(); S.reset(); const twice = await S.ensure();
    check('I', 'the table is created by itself and creating it twice is harmless', once === true && twice === true && (await raw(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'VendorAssetGrant'`))[0].n === 1);
    const mdir = path.join(BACK, 'prisma/migrations/20261019180000_vendor_asset_grants');
    check('I', 'the additive migration has a rollback that drops only this table', fs.existsSync(path.join(mdir, 'migration.sql')) && /DROP TABLE IF EXISTS "VendorAssetGrant"/.test(fs.readFileSync(path.join(mdir, 'rollback.sql'), 'utf8')) && !/ALTER TABLE|DROP TABLE IF EXISTS "(?!VendorAssetGrant)/.test(fs.readFileSync(path.join(mdir, 'migration.sql'), 'utf8')));
    check('I', 'no server error in the log', !/TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(serverLog), serverLog.split('\n').filter((l) => /TypeError|ReferenceError|SQLITE_ERROR|Unhandled/.test(l)).slice(0, 5));
  } catch (err) {
    fail += 1; console.error('FAIL  test crashed:', err && err.stack ? err.stack : err);
  } finally {
    try {
      const inList = (a) => a.map(() => '?').join(',') || "''";
      await prisma.$executeRawUnsafe(`DELETE FROM "VendorAssetGrant" WHERE "vendorId" IN (${inList(made.vendors)})`, ...made.vendors).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "AssetVendorInfo" WHERE "assetId" IN (${inList(made.assets)})`, ...made.assets).catch(() => {});
      await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, update: { value: '1' }, create: { key: 'audit.allowPurge', value: '1' } });
      await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairEvent" WHERE "repairId" IN (${inList(made.repairs)})`, ...made.repairs).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM "AssetRepairVendor" WHERE "repairId" IN (${inList(made.repairs)})`, ...made.repairs).catch(() => {});
      await prisma.assetRepair.deleteMany({ where: { id: { in: made.repairs } } }).catch(() => {});
      await prisma.assetAuditLog.deleteMany({ where: { OR: [{ assetId: { in: made.assets } }, { vendorId: { in: made.vendors } }] } }).catch(() => {});
      await prisma.officeExpense.deleteMany({ where: { id: { in: made.expenses } } }).catch(() => {});
      await prisma.assetAuditLog.deleteMany({ where: { vendorId: { in: made.vendors } } }).catch(() => {});
      await prisma.vendorSession.deleteMany({ where: { vendorUser: { vendorId: { in: made.vendors } } } }).catch(() => {});
      await prisma.vendorUser.deleteMany({ where: { vendorId: { in: made.vendors } } }).catch(() => {});
      await prisma.asset.deleteMany({ where: { id: { in: made.assets } } }).catch(() => {});
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } }).catch(() => {});
      await prisma.appSetting.deleteMany({ where: { key: 'audit.allowPurge' } });
      const left = (await raw(`SELECT (SELECT COUNT(*) FROM "Asset" WHERE "assetCode" LIKE 'ZZAH-%') AS a, (SELECT COUNT(*) FROM "OfficeVendor" WHERE "name" LIKE 'ZZTEST AHS%') AS v, (SELECT COUNT(*) FROM "AssetRepair" WHERE "repairNo" LIKE 'RP-ZZAH%') AS r`))[0];
      check('I', 'clean-up: every ZZTEST fixture of this run is removed (assets, vendors, repairs)', left.a === 0 && left.v === 0 && left.r === 0, left);
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
