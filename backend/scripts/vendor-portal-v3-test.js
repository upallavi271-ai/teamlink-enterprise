#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE VENDOR PORTAL, 2026-10-23: Dashboard / Bills & Invoices / Payments & Outstanding / Services & Agreements. SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/vendor-portal-v3-test.js
//   Links the Accounts bills of the sandbox COPY to their vendors (the one-time fix), signs in as ARV / Zoho / Tata Tel / HT Media, and checks:
//   four modules in order, the numbers (real data, reconciling across the three screens), GST detail, filters, honest empty states,
//   vendor isolation (other vendors' ids, direct API calls), the hook that links tomorrow's bills, and that the protected files are untouched.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SB_FILE = path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db');
const SBX = `file:${SB_FILE.split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
const ip = () => `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': ip(), 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const FOUR = ['Dashboard', 'Bills & Invoices', 'Payments & Outstanding', 'Services & Agreements'];

(async () => {
  const made = { users: [], expenses: [] };
  try {
    // ---- the one-time link, on the sandbox copy ----
    const out = execFileSync(process.execPath, [path.join(BACK, 'scripts', 'link-expenses-to-vendors.js'), '--db', SB_FILE, '--apply'], { cwd: BACK, encoding: 'utf8' });
    console.log(`INFO  ${(out.match(/Would be linked: \d+/) || ['link script ran'])[0]}`);
    const byName = async (needle) => prisma.officeVendor.findFirst({ where: { name: { contains: needle } } });
    const V = { arv: await byName('ARV'), zoho: await byName('ZOHO'), tata: await byName('Tata'), ht: await byName('HT Media') };
    check('V0 the four vendor master records exist', Object.values(V).every(Boolean), Object.keys(V).filter((k) => !V[k]));
    const login = async (v, tag) => {
      const pw = `Qv#7${tag}Lm!${RUN}9`;
      const u = await prisma.vendorUser.create({ data: { vendorId: v.id, name: `ZZTEST PV ${tag}`, email: `zz-pv-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date() } });
      made.users.push(u.id);
      const r = await http('POST', '/api/vendor-portal/login', null, { email: u.email, password: pw });
      return { v, token: r.body && r.body.token, status: r.status };
    };
    const A = await login(V.arv, 'arv'); const Z = await login(V.zoho, 'zoho'); const T = await login(V.tata, 'tata'); const H = await login(V.ht, 'ht');
    check('V1 all four vendors can sign in', [A, Z, T, H].every((x) => x.token), [A, Z, T, H].map((x) => x.status));

    // ---- a Zoho bill with GST detail, overdue, covering three months (made through prisma: the db.js hook links it) ----
    const mk = async (data) => { const e = await prisma.officeExpense.create({ data }); made.expenses.push(e.id); return e; };
    const zb = await mk({ category: 'ZZTEST Subscription', vendor: 'zoho corporation pvt ltd', vendorGstin: '29AAACZ1234A1Z5', monthlyAmount: 118, gstAmount: 18, gstRatePct: 18, gstTreatment: 'CGST+SGST (within state)', expenseDate: '2026-01-10', dueDate: '2026-01-25', monthsCovered: 3, frequency: 'Quarterly', billNumber: `ZZ-${RUN}`, approvalStatus: 'APPROVED', paidStatus: 'Unpaid', entryKind: 'expense', description: 'ZZTEST Zoho One' });
    check('H1 the hook linked a new bill written as "zoho corporation pvt ltd" to Zoho by id', zb.vendorId === V.zoho.id, zb.vendorId);
    const nm = await mk({ category: 'ZZTEST', vendor: 'Zoho Corporation Services', monthlyAmount: 5, entryKind: 'expense' });
    check('H2 a similar-looking but different name is NOT linked', !nm.vendorId, nm.vendorId);
    const re = await prisma.officeExpense.update({ where: { id: nm.id }, data: { vendor: 'ARV WORKSPACES LLP' } });
    check('H3 editing the vendor text to an exact vendor name links it (ARV)', re.vendorId === V.arv.id, re.vendorId);
    const re2 = await prisma.officeExpense.update({ where: { id: nm.id }, data: { vendor: 'Some Unknown Shop' } });
    check('H4 re-pointing it to a name that matches no vendor removes the old link', !re2.vendorId, re2.vendorId);
    const re3 = await prisma.officeExpense.update({ where: { id: nm.id }, data: { vendor: 'Some Unknown Shop', vendorId: V.tata.id } });
    check('H5 an explicit vendorId (a portal-approved bill) is never overridden by the hook', re3.vendorId === V.tata.id, re3.vendorId);
    await prisma.officeExpense.update({ where: { id: nm.id }, data: { vendorId: null } });

    // ---- 4 modules, in order ----
    for (const [label, who] of [['ARV', A], ['Zoho', Z], ['Tata', T], ['HT', H]]) {
      const me = await http('GET', '/api/vendor-portal/me', who.token);
      check(`N1 ${label}: kind finance and exactly the four modules in order`, me.body && me.body.kind === 'finance' && me.body.nav.map((n) => n.label).join('|') === FOUR.join('|') && me.body.nav.length === 4, me.body && me.body.nav);
      check(`N2 ${label}: /me names the registered company`, me.body && me.body.vendorName === who.v.name, me.body && me.body.vendorName);
    }
    const meA = await http('GET', '/api/vendor-portal/me', A.token);
    check('N3 routes: /vendor/dashboard, /vendor/invoices, /vendor/payments, /vendor/services', meA.body.nav.map((n) => n.route).join() === '/vendor/dashboard,/vendor/invoices,/vendor/payments,/vendor/services', meA.body.nav);

    // ---- the real data: ARV ----
    const expARV = await prisma.officeExpense.findMany({ where: { vendorId: V.arv.id, entryKind: { not: 'hand' }, NOT: { approvalStatus: 'REJECTED' } } });
    const ovA = (await http('GET', '/api/vendor-portal/records/overview', A.token)).body;
    check('D1 ARV dashboard shows its real invoices (count equals the Accounts bills linked to ARV)', ovA && ovA.invoices.total === expARV.length && expARV.length >= 9, [ovA && ovA.invoices.total, expARV.length]);
    const listA = (await http('GET', '/api/vendor-portal/records/invoices?pageSize=100', A.token)).body;
    check('D2 Bills & Invoices lists them all with number, date and amount', listA.total === expARV.length && listA.rows.every((r) => r.invoiceNo && r.netPayable != null), [listA.total, expARV.length]);
    const payA = (await http('GET', '/api/vendor-portal/records/payments?pageSize=100', A.token)).body;
    const sumRows = (k) => R2(listA.rows.reduce((t, r) => t + (r.status === 'REJECTED' || r.status === 'WITHDRAWN' ? 0 : r[k]), 0));
    check('D3 billed = paid + outstanding, and the three screens agree', ovA.invoices.billed === sumRows('netPayable') && ovA.invoices.billed === R2(payA.summary.paid + payA.summary.outstanding) && ovA.invoices.outstanding === payA.summary.outstanding && ovA.payments.received === payA.summary.paid, { ov: ovA.invoices, pay: payA.summary });
    check('D4 payments are not double counted (sum of payments = sum of invoice paid parts)', R2(payA.rows.reduce((t, p) => t + p.amount, 0)) === R2(listA.rows.reduce((t, r) => t + r.paidAmount, 0)) || payA.total > payA.rows.length, null);
    const expSum = R2(expARV.reduce((t, e) => t + (Number(e.monthlyAmount) - Number(e.tdsAmount || 0)), 0));
    check('D5 the invoice total equals the Accounts records (amount minus TDS)', ovA.invoices.billed === expSum, [ovA.invoices.billed, expSum]);
    check('D6 the GSTIN of the vendor master record is shown where a bill has none', listA.rows.every((r) => r.gstin) && listA.rows[0].gstin === V.arv.gstin, listA.rows[0] && listA.rows[0].gstin);
    check('D7 every invoice has a payment status from the allowed set', listA.rows.every((r) => ['Paid', 'Unpaid', 'Partially Paid', 'Overdue', 'Pending Verification', 'Rejected', 'Withdrawn'].includes(r.payStatus)), listA.rows.map((r) => r.payStatus));

    // ---- Zoho's GST bill ----
    const listZ = (await http('GET', '/api/vendor-portal/records/invoices?pageSize=100', Z.token)).body;
    const zr = listZ.rows.find((r) => r.invoiceNo === `ZZ-${RUN}`);
    check('G1 the new Zoho bill is in Zoho\'s list', !!zr, listZ.rows.map((r) => r.invoiceNo));
    check('G2 taxable 100, GST 18, CGST 9, SGST 9, IGST not available', zr && zr.taxable === 100 && zr.gst === 18 && zr.cgst === 9 && zr.sgst === 9 && zr.igst === null, zr && { t: zr.taxable, g: zr.gst, c: zr.cgst, s: zr.sgst, i: zr.igst });
    check('G3 billing period "Jan 2026 to Mar 2026", covered until 31 Mar 2026', zr && zr.period === 'Jan 2026 to Mar 2026' && zr.coveredUntil === '2026-03-31', zr && [zr.period, zr.coveredUntil]);
    check('G4 past its due date and unpaid = Overdue, with the days late', zr && zr.payStatus === 'Overdue' && zr.overdue && zr.daysOverdue > 0, zr && [zr.payStatus, zr.daysOverdue]);
    check('G5 GSTIN of the bill is shown', zr && zr.gstin === '29AAACZ1234A1Z5', zr && zr.gstin);
    const ovZ = (await http('GET', '/api/vendor-portal/records/overview', Z.token)).body;
    check('G6 dashboard counts the overdue invoice and lists it under needs attention', ovZ.overdue.count >= 1 && ovZ.actions.some((a) => /overdue/.test(a.text)), ovZ.overdue);
    const fOver = (await http('GET', '/api/vendor-portal/records/invoices?status=overdue', Z.token)).body;
    check('G7 the Overdue filter returns only overdue invoices', fOver.rows.length >= 1 && fOver.rows.every((r) => r.overdue), fOver.rows.map((r) => r.payStatus));
    const fCat = (await http('GET', '/api/vendor-portal/records/invoices?category=ZZTEST%20Subscription', Z.token)).body;
    check('G8 the category filter works', fCat.rows.length === 1 && fCat.rows[0].invoiceNo === `ZZ-${RUN}`, fCat.rows.length);
    const fPer = (await http('GET', '/api/vendor-portal/records/invoices?period=2026-01', Z.token)).body;
    check('G9 the billing-period filter works', fPer.rows.some((r) => r.invoiceNo === `ZZ-${RUN}`), fPer.rows.length);
    const fSearch = (await http('GET', `/api/vendor-portal/records/invoices?q=${encodeURIComponent(`ZZ-${RUN}`)}`, Z.token)).body;
    check('G10 search by invoice number works', fSearch.rows.length === 1, fSearch.rows.length);
    const sortAsc = (await http('GET', '/api/vendor-portal/records/invoices?sort=amount&dir=asc', A.token)).body;
    check('G11 sort by amount works', sortAsc.rows.every((r, i, a) => i === 0 || a[i - 1].netPayable <= r.netPayable), sortAsc.rows.map((r) => r.netPayable));
    const pg = (await http('GET', '/api/vendor-portal/records/invoices?pageSize=5&page=2', A.token)).body;
    check('G12 pagination works (page 2 of ARV with 5 per page)', pg.page === 2 && pg.pageSize === 5 && pg.pages >= 2 && pg.rows.length > 0, [pg.page, pg.pages, pg.rows.length]);
    const payZ = (await http('GET', '/api/vendor-portal/records/payments', Z.token)).body;
    check('P1 Payments & Outstanding lists the outstanding Zoho invoice with its days late', payZ.outstanding.some((o) => o.invoiceNo === `ZZ-${RUN}` && o.overdue) && payZ.summary.overdue.count >= 1, payZ.outstanding);

    // ---- services & agreements ----
    const svA = (await http('GET', '/api/vendor-portal/records/services', A.token)).body;
    check('S1 ARV: services come from its own bills (at least one service, with bills and a last-bill date)', svA.services.length >= 1 && svA.services.every((s) => s.bills >= 1 && s.lastBilled), svA.services);
    check('S2 no additional charges are invented (none exist in the app)', Array.isArray(svA.charges) && svA.charges.length === 0, svA.charges);
    const svZ = (await http('GET', '/api/vendor-portal/records/services', Z.token)).body;
    const zs = svZ.services.find((s) => s.name === 'ZZTEST Subscription');
    check('S3 Zoho: the subscription shows billing period, covered-until and outstanding', zs && zs.billingPeriod === 'Quarterly' && zs.coveredUntil === '2026-03-31' && zs.outstanding === 118, zs);
    const doc = await prisma.vendorSharedDocument.create({ data: { vendorId: V.tata.id, title: `ZZTEST Agreement ${RUN}`, docType: 'Agreement', name: 'a.pdf', mime: 'application/pdf', size: 3, file: 'none', note: 'zz', sharedById: 'zz', sharedByName: 'zz' } }).catch((e) => ({ err: e.message }));
    if (doc.err) console.log('INFO  (skipping S4/S5: could not create a shared document:', doc.err.slice(0, 100), ')');
    else {
      made.doc = doc.id;
      const svT = (await http('GET', '/api/vendor-portal/records/services', T.token)).body;
      check('S4 Tata sees the agreement the company shared with it', svT.agreements.some((a) => a.title === `ZZTEST Agreement ${RUN}`), svT.agreements);
      const svA2 = (await http('GET', '/api/vendor-portal/records/services', A.token)).body;
      check('S5 ARV does NOT see Tata\'s agreement', !svA2.agreements.some((a) => a.title === `ZZTEST Agreement ${RUN}`), svA2.agreements);
    }

    // ---- isolation ----
    const zKey = zr && zr.key;
    const x1 = await http('GET', `/api/vendor-portal/records/invoices/${encodeURIComponent(zKey)}`, A.token);
    check('I1 ARV cannot open a Zoho invoice by its key (403)', x1.status === 403, x1.status);
    const x2 = await http('GET', `/api/vendor-portal/records/invoices/${encodeURIComponent(zKey)}`, T.token);
    check('I2 Tata cannot open a Zoho invoice by its key (403)', x2.status === 403, x2.status);
    const x3 = await http('GET', `/api/vendor-portal/records/payments/${encodeURIComponent(`pay:${zKey}`)}`, A.token);
    check('I3 ARV cannot open a Zoho payment by its key (403)', x3.status === 403, x3.status);
    const x4 = await http('GET', `/api/vendor-portal/records/overview?vendorId=${V.zoho.id}`, A.token);
    check('I4 a vendorId in the query is ignored (ARV still gets ARV\'s numbers)', x4.body && x4.body.invoices.total === ovA.invoices.total, x4.body && x4.body.invoices.total);
    const x5 = await http('GET', `/api/vendor-portal/records/invoices?vendorId=${V.zoho.id}&pageSize=100`, A.token);
    check('I5 ... and for the invoice list too', x5.body && !x5.body.rows.some((r) => r.invoiceNo === `ZZ-${RUN}`) && x5.body.total === listA.total, x5.body && x5.body.total);
    check('I6 no row of ARV\'s list belongs to another vendor (ids checked against the database)', (await prisma.officeExpense.count({ where: { id: { in: listA.rows.filter((r) => String(r.key).startsWith('exp:')).map((r) => r.key.slice(4)) }, NOT: { vendorId: V.arv.id } } })) === 0);
    const tList = (await http('GET', '/api/vendor-portal/records/invoices?pageSize=100', T.token)).body;
    check('I7 Tata and ARV lists share no invoice key', !tList.rows.some((r) => listA.rows.some((a) => a.key === r.key)), null);
    const w1 = await http('GET', '/api/vendor-portal/records/overview', null);
    check('I8 no token = 401', w1.status === 401, w1.status);
    const w2 = await http('GET', '/api/clients', A.token);
    check('I9 a vendor token cannot read the company\'s clients', w2.status === 401 || w2.status === 403, w2.status);
    const w3 = await http('GET', '/api/vendor-portal/assets', A.token);
    check('I10 a finance vendor cannot reach the Assets portal API', w3.status === 403, w3.status);
    const w4 = await http('POST', '/api/vendor-portal/records/invoices', A.token, { invoiceNo: 'x' });
    check('I11 a vendor cannot write to the records (403)', w4.status === 403 || w4.status === 404, w4.status);
    const w5 = await http('POST', `/api/vendor-portal/download-link`, A.token, { kind: 'shared', id: made.doc || 'x' });
    check('I12 ARV cannot get a download link for another vendor\'s shared document', w5.status === 403 || w5.status === 404, w5.status);

    // ---- an honest empty state ----
    const emptyV = await prisma.officeVendor.create({ data: { name: `ZZTEST Empty Vendor ${RUN}` } });
    made.emptyVendor = emptyV.id;
    const E = await login(emptyV, 'empty');
    const ovE = (await http('GET', '/api/vendor-portal/records/overview', E.token)).body;
    check('E1 a vendor with no records gets zeros, empty lists, and no invented data', ovE.invoices.total === 0 && ovE.invoices.billed === 0 && ovE.payments.count === 0 && ovE.upcoming.length === 0 && ovE.recentInvoices.length === 0, ovE && ovE.invoices);
    const svE = (await http('GET', '/api/vendor-portal/records/services', E.token)).body;
    check('E2 Services & Agreements is empty (no agreements, services, orders or charges)', svE.counts.agreements === 0 && svE.counts.services === 0 && svE.counts.orders === 0 && svE.counts.charges === 0, svE.counts);

    // ---- protected modules ----
    // The files of the Assets and ID Card vendor portals. Fingerprints (first 16 hex of sha256) taken on 2026-10-23 and re-taken on 2026-10-27 after the Assets Vendor Portal master prompt (Stage B) changed them on purpose, before this change was
    // finished: none of these files was opened for editing (their modified times are all older than that day). A later, deliberate change to one
    // of them must update the fingerprint here on purpose.
    const crypto = require('crypto');
    const PROTECTED = {
      'backend/src/utils/assetVendorPortal.js': 'cbb4e109bf963202', 'backend/src/utils/assetVendorSchema.js': '36885129121f5a71', 'backend/src/utils/assetVendorPayments.js': 'f6dcf91f4837e22b',
      'backend/src/routes/assetVendorPortal.js': '44f18812895e6ea4', 'backend/src/utils/idCardVendorPortal.js': '2de6eaeaa555740e', 'backend/src/utils/idCardVendorSchema.js': '2360fa92de971bc9',
      'backend/src/routes/idCardVendorPortal.js': '78ef0b2a86059b29', 'frontend/src/pages/vendor/AssetPortalDashboard.jsx': 'c95042b12d3b76d6', 'frontend/src/pages/vendor/AssetPortalAssets.jsx': '6bb9b24fb4ef5bf5',
      'frontend/src/pages/vendor/AssetPortalOrders.jsx': 'b9c15f82fd994d08', 'frontend/src/pages/vendor/AssetPortalRepairs.jsx': 'b7be964e04367c76', 'frontend/src/pages/vendor/AssetPortalHistory.jsx': 'b1cd8fe92f31e849',
      'frontend/src/pages/vendor/AssetPortalInvoices.jsx': '2e317fa913fec19d', 'frontend/src/pages/vendor/IdCardDashboard.jsx': '25ed6866b9ca93f2', 'frontend/src/pages/vendor/IdCardRequests.jsx': '22aa6a87f326d520',
      'frontend/src/pages/vendor/idCardCommon.jsx': '856a1e8b8684bfe5', 'frontend/src/pages/vendor/assetPortalCommon.jsx': 'ccf2b13a8a5ec0c8',
    };
    const moved = Object.entries(PROTECTED).filter(([rel, want]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, '..', rel))).digest('hex').slice(0, 16) !== want).map(([rel]) => rel);
    check('X1 the Assets and ID Card portal files (17 files, backend + frontend) are exactly as they were', moved.length === 0, moved);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    try { if (made.doc) await prisma.vendorSharedDocument.delete({ where: { id: made.doc } }); } catch { /* */ }
    try { await prisma.vendorSession.deleteMany({ where: { vendorUserId: { in: made.users } } }); } catch { /* */ }
    try { await prisma.vendorUser.deleteMany({ where: { id: { in: made.users } } }); } catch (e) { console.log('cleanup users', e.message.slice(0, 120)); }
    try { await prisma.officeExpense.deleteMany({ where: { id: { in: made.expenses } } }); } catch (e) { console.log('cleanup expenses', e.message.slice(0, 120)); }
    try { if (made.emptyVendor) await prisma.officeVendor.delete({ where: { id: made.emptyVendor } }); } catch { /* */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
