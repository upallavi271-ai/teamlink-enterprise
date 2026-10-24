#!/usr/bin/env node
// ---------------------------------------------------------------------------
// UNIFIED LOGIN TEST (2026-10-14). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/unified-login-test.js
//
// The main login page (/login) signs staff in through POST /api/auth/login and,
// only when that answers 401, tries POST /api/vendor-portal/login (the vendor
// server decides). This script drives exactly those two endpoints and checks
// the vendor rules. Every password is generated here, kept in memory, never
// printed. Everything it makes is ZZTEST and is removed at the end.
//   UI=<dir>  optional: leaves the fixtures up, writes ui-creds.json into <dir>
//             and waits for <dir>/ui-done before cleaning (for browser checks).
// ---------------------------------------------------------------------------
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (API !== 'http://localhost:4011') { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox).'); process.exit(2); }
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
const prisma = require(path.join(BACK, 'src/db'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));

const RUN = Date.now().toString(36);
const made = { users: [], vendors: [], logins: [], assets: [] };
let pass = 0; let fail = 0;
function check(group, name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`);
}
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const rpw = () => `Zz!${crypto.randomBytes(9).toString('base64url')}9aA`;
async function rfetch(url, opt) {
  for (let i = 0; ; i += 1) {
    try { return await fetch(url, opt); } catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
async function call(method, p, { token, body, ip } = {}) {
  const h = { 'X-Forwarded-For': ip || randIp() };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await rfetch(`${API}/api${p}`, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json };
}
const staffLogin = (email, password) => call('POST', '/auth/login', { body: { email, password } });
const vendorLogin = (email, password) => call('POST', '/vendor-portal/login', { body: { email, password } });
// What the Login page does.
async function unified(email, password) {
  const s = await staffLogin(email, password);
  if (s.status === 200) return { kind: 'staff', staff: s };
  if (s.status !== 401) return { kind: 'error', status: s.status, body: s.body };
  const v = await vendorLogin(email, password);
  if (v.status === 200) return { kind: 'vendor', vendor: v };
  return { kind: 'refused', error: s.body && s.body.error, status: v.status };
}

async function main() {
  const pw = {};
  const mkStaff = async (label, data) => {
    pw[label] = rpw();
    const u = await prisma.user.create({ data: { name: `ZZTEST UL ${label}`, email: `zztest.ul.${label}.${RUN}@example.test`, passwordHash: await bcrypt.hash(pw[label], 10), status: 'Active', ...data } });
    made.users.push(u.id); return u;
  };
  const admin = await mkStaff('admin', { role: 'ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
  const rec = await mkStaff('recruiter', { role: 'RECRUITER', atsAccess: true, atsRole: 'RECRUITER' });
  const bde = await mkStaff('bde', { role: 'BDE', atsAccess: true, atsRole: 'BDE' });
  const tl = await mkStaff('tl', { role: 'TL', atsAccess: true, atsRole: 'TL' });

  const mkVendor = async (label, active = true) => {
    const v = await prisma.officeVendor.create({ data: { name: `ZZTEST UL Vendor ${label} ${RUN}`, isActive: active } });
    made.vendors.push(v.id); return v;
  };
  const vA = await mkVendor('A'); const vB = await mkVendor('B'); const vOff = await mkVendor('Off', false);
  const mkAsset = async (code, vendor, category) => {
    const a = await prisma.asset.create({ data: { assetCode: `ZZTEST-UL-${code}-${RUN}`, name: `ZZTEST UL asset ${code}`, category, vendorId: vendor ? vendor.id : null } });
    made.assets.push(a.id); return a;
  };
  const aA1 = await mkAsset('A1', vA, 'Laptop'); const aA2 = await mkAsset('A2', vA, 'Printer'); const aB1 = await mkAsset('B1', vB, 'Laptop');
  const mkVU = async (label, vendor, extra = {}) => {
    pw[label] = rpw();
    const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST UL ${label}`, email: `zztest.ul.${label}.${RUN}@example.test`, passwordHash: await bcrypt.hash(pw[label], 10), status: 'Active', mustChangePassword: false, canEdit: true, ...extra } });
    made.logins.push(u.id); return u;
  };
  const vuA = await mkVU('vendora', vA); const vuB = await mkVU('vendorb', vB);
  const vuNone = await mkVU('noassets', vA);
  const vuTemp = await mkVU('temp', vA, { mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 86400000) });
  const vuExp = await mkVU('expired', vA, { mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() - 86400000) });
  await mkVU('inactive', vA, { status: 'Inactive' });
  await mkVU('deleted', vA, { deletedAt: new Date() });
  await mkVU('vendoroff', vOff);
  await prisma.vendorAssetAccess.create({ data: { vendorUserId: vuA.id, assetId: aA1.id } });
  await prisma.vendorAssetAccess.create({ data: { vendorUserId: vuB.id, assetId: aB1.id } });
  // vuTemp is assigned a whole category; vuNone nothing.
  await prisma.vendorAssetAccess.create({ data: { vendorUserId: vuTemp.id, category: 'Printer' } });
  const em = (l) => `zztest.ul.${l}.${RUN}@example.test`;

  // ---- 2. valid vendor credentials through the unified flow -----------------
  let u = await unified(em('vendora'), pw.vendora);
  check('2', 'valid vendor email+password on the main login flow -> vendor session (staff says 401, vendor says 200)', u.kind === 'vendor' && !!u.vendor.body.token, u);
  check('2', 'landing is /vendor/assets when the login has assets', u.kind === 'vendor' && u.vendor.body.landing === '/vendor/assets', u.vendor && u.vendor.body);
  const TA = u.vendor.body.token;
  u = await unified(em('noassets'), pw.noassets);
  check('2', 'landing is /vendor/invoices when the login has no assets', u.kind === 'vendor' && u.vendor.body.landing === '/vendor/invoices', u.vendor && u.vendor.body);
  const sRaw = await staffLogin(em('vendora'), pw.vendora);
  check('2', 'the staff login itself still refuses a vendor email (no staff token ever issued)', sRaw.status === 401 && !sRaw.body.token, sRaw);

  // ---- 3. session survives (refresh = /me with the same token) --------------
  let r = await call('GET', '/vendor-portal/me', { token: TA });
  check('3', 'refresh keeps the session (/me with the same token)', r.status === 200 && r.body.email === em('vendora') && r.body.landing === '/vendor/assets', r);

  // ---- 4. only assigned assets; vendor A vs vendor B ------------------------
  r = await call('GET', '/vendor-portal/assets', { token: TA });
  const codes = (r.body && r.body.rows || []).map((x) => x.assetCode);
  check('4', 'vendor A list = only the assigned asset (A1), not A2 (same vendor, not ticked) and not B1', r.status === 200 && codes.length === 1 && codes[0] === aA1.assetCode, codes);
  for (const [label, a] of [['B1 (other vendor)', aB1], ['A2 (own vendor, not ticked)', aA2]]) {
    r = await call('GET', `/vendor-portal/assets/${a.id}`, { token: TA });
    check('4', `GET asset ${label} by id -> 403, no data`, r.status === 403 && !(r.body && r.body.assetCode), r);
    r = await call('PATCH', `/vendor-portal/assets/${a.id}`, { token: TA, body: { serialNumber: 'HACK' } });
    check('4', `PATCH asset ${label} -> 403`, r.status === 403, r);
  }
  const fresh = await prisma.asset.findUnique({ where: { id: aB1.id } });
  check('4', 'vendor B asset untouched', fresh.serialNumber == null);
  r = await call('GET', '/vendor-portal/assets?vendorId=' + vB.id + '&q=B1', { token: TA });
  check('4', 'a vendorId / search in the query cannot widen the list', r.status === 200 && (r.body.rows || []).every((x) => x.assetCode === aA1.assetCode), r);
  u = await unified(em('vendorb'), pw.vendorb);
  r = await call('GET', '/vendor-portal/assets', { token: u.vendor.body.token });
  check('4', 'vendor B sees only B1', (r.body.rows || []).map((x) => x.assetCode).join() === aB1.assetCode, r);
  r = await call('GET', `/vendor-portal/assets/${aA1.id}`, { token: u.vendor.body.token });
  check('4', 'vendor B cannot open vendor A asset by id', r.status === 403, r);

  // ---- 5. generic errors ------------------------------------------------------
  const wrongPw = await unified(em('vendora'), `${pw.vendora}x`);
  const noUser = await unified(`zztest.ul.nobody.${RUN}@example.test`, rpw());
  check('5', 'wrong password -> refused, no token', wrongPw.kind === 'refused', wrongPw);
  check('5', 'unknown email -> refused, no token', noUser.kind === 'refused', noUser);
  check('5', 'both give the same text the page shows (the staff text), same status', wrongPw.error === noUser.error && wrongPw.status === noUser.status && wrongPw.error === 'Invalid email or password', [wrongPw, noUser]);

  // ---- 6. inactive / deactivated / deleted / expired --------------------------
  for (const [label, why] of [['inactive', 'switched-off login'], ['deleted', 'deleted login'], ['vendoroff', 'switched-off vendor'], ['expired', 'expired temporary password']]) {
    const x = await unified(em(label), pw[label]);
    check('6', `${why} with the RIGHT password -> refused, same generic text`, x.kind === 'refused' && x.error === noUser.error, x);
  }
  // deactivating a live login ends its live session at once
  r = await call('GET', '/vendor-portal/me', { token: u.vendor.body.token });
  await prisma.vendorUser.update({ where: { id: vuB.id }, data: { status: 'Inactive' } });
  r = await call('GET', '/vendor-portal/me', { token: u.vendor.body.token });
  check('6', 'a login switched off while signed in is signed out on the next request', r.status === 401, r);
  await prisma.vendorUser.update({ where: { id: vuB.id }, data: { status: 'Active' } });

  // ---- 7. staff keep their normal redirects -----------------------------------
  const land = {};
  for (const [label, user] of [['admin', admin], ['recruiter', rec], ['bde', bde], ['tl', tl]]) {
    const x = await unified(em(label), pw[label]);
    land[label] = x.kind === 'staff' ? x.staff.body.user.landingPath : x.kind;
    check('7', `${label}: staff sign-in still works and lands on its own page (${land[label]}), never /vendor`, x.kind === 'staff' && !!x.staff.body.token && !/vendor/.test(land[label]) && x.staff.body.user.id === user.id, x);
  }
  const wrongStaff = await unified(em('admin'), `${pw.admin}x`);
  check('7', 'staff wrong password -> same generic text (and no vendor session)', wrongStaff.kind === 'refused' && wrongStaff.error === noUser.error, wrongStaff);

  // ---- 8. token separation -----------------------------------------------------
  const TS = (await staffLogin(em('admin'), pw.admin)).body.token;
  for (const p of ['/auth/me', '/employees', '/clients', '/asset-inventory', '/vendor-logins', '/office-expenses/vendors']) {
    r = await call('GET', p, { token: TA });
    check('8', `vendor token on staff API ${p} -> 403 (vendor guard)`, r.status === 403, r.status);
  }
  for (const p of ['/vendor-portal/me', '/vendor-portal/assets', '/vendor-portal/invoices']) {
    r = await call('GET', p, { token: TS });
    check('8', `staff (Admin) token on vendor API ${p} -> 401`, r.status === 401, r.status);
  }
  r = await call('GET', '/vendor-portal/assets');
  check('8', 'no token on vendor API -> 401', r.status === 401, r.status);
  r = await call('POST', '/vendor-portal/login', { body: { email: em('vendora'), password: pw.vendora, role: 'ADMIN', vendorId: vB.id } });
  check('8', 'extra role / vendorId fields in the login body change nothing (still vendor A)', r.status === 200 && r.body.vendor.email === em('vendora') && !r.body.user, r.body && r.body.vendor);

  // ---- 9. logout revokes -------------------------------------------------------
  r = await call('POST', '/vendor-portal/logout', { token: TA });
  check('9', 'logout answers ok', r.status === 200, r);
  r = await call('GET', '/vendor-portal/me', { token: TA });
  check('9', 'the old token is refused after logout (server-side revoke)', r.status === 401 && r.body.vendorSignedOut === true, r);
  const sess = await prisma.vendorSession.findMany({ where: { vendorUserId: vuA.id, revokedReason: 'logout' } });
  check('9', 'the session row is marked revoked', sess.length >= 1);

  // ---- 10. must change password -----------------------------------------------
  u = await unified(em('temp'), pw.temp);
  check('10', 'temporary-password vendor can sign in and is told to change the password', u.kind === 'vendor' && u.vendor.body.vendor.mustChangePassword === true, u);
  const TT = u.vendor.body.token;
  r = await call('GET', '/vendor-portal/assets', { token: TT });
  check('10', 'before changing it, the portal data is locked (403 mustChangePassword)', r.status === 403 && r.body.mustChangePassword === true, r);
  r = await call('GET', '/vendor-portal/me', { token: TT });
  check('10', '/me works (so the page can show the change step)', r.status === 200 && r.body.mustChangePassword === true, r);
  const np = rpw();
  r = await call('POST', '/vendor-portal/change-password', { token: TT, body: { currentPassword: pw.temp, newPassword: np, confirmPassword: np } });
  check('10', 'change-password with the temporary one + a strong new one -> ok', r.status === 200, r);
  r = await call('GET', '/vendor-portal/assets', { token: TT });
  check('10', 'after the change the portal opens', r.status === 200, r);
  u = await unified(em('temp'), np);
  check('10', 'the new password signs in; landing = assets (category access)', u.kind === 'vendor' && u.vendor.body.landing === '/vendor/assets' && !u.vendor.body.vendor.mustChangePassword, u);
  u = await unified(em('temp'), pw.temp);
  check('10', 'the old temporary password no longer works', u.kind === 'refused', u);

  // ---- 11. dashboard counts = DB, live sync, assignment revoke ------------------
  u = await unified(em('vendora'), pw.vendora);
  const TA2 = u.vendor.body.token;
  const aA3 = await mkAsset('A3', vA, 'Laptop'); const aA4 = await mkAsset('A4', vA, 'Laptop'); const aA5 = await mkAsset('A5', vA, 'Laptop');
  await prisma.asset.update({ where: { id: aA3.id }, data: { status: 'In Repair' } });
  await prisma.asset.update({ where: { id: aA4.id }, data: { status: 'Retired' } });
  await prisma.assetRepair.create({ data: { repairNo: `ZZ-UL-${RUN}-1`, assetId: aA1.id, status: 'Completed', issue: 'ZZTEST UL' } });
  await prisma.assetRepair.create({ data: { repairNo: `ZZ-UL-${RUN}-2`, assetId: aA5.id, status: 'In Repair', issue: 'ZZTEST UL' } });
  const accRows = [aA3, aA4, aA5].map((a) => ({ vendorUserId: vuA.id, assetId: a.id }));
  for (const d of accRows) await prisma.vendorAssetAccess.create({ data: d });
  r = await call('GET', '/vendor-portal/dashboard', { token: TA2 });
  // A1 Available (completed repair), A3 In Repair, A4 Retired (archived), A5 Available with open repair
  check('11', 'dashboard counts equal the DB: total 3, active 2, under repair 2, repair completed 1, returned/retired 1', r.status === 200 && r.body.total === 3 && r.body.active === 2 && r.body.underRepair === 2 && r.body.repairCompleted === 1 && r.body.returned === 1, r.body);
  const dbTotal = await prisma.asset.count({ where: { vendorId: vA.id, id: { in: [aA1.id, aA3.id, aA5.id] } } });
  check('11', 'total matches a direct DB count of the ticked, live assets', dbTotal === r.body.total);
  r = await call('GET', '/vendor-portal/dashboard', { token: (await unified(em('vendorb'), pw.vendorb)).vendor.body.token });
  check('11', 'vendor B dashboard counts only vendor B (1 asset)', r.body.total === 1, r.body);
  r = await call('GET', '/vendor-portal/dashboard', { token: TS });
  check('11', 'staff token refused on the dashboard API', r.status === 401, r.status);
  await prisma.asset.update({ where: { id: aA1.id }, data: { name: 'ZZTEST UL renamed by admin', location: 'ZZTEST floor 2' } });
  r = await call('GET', `/vendor-portal/assets/${aA1.id}`, { token: TA2 });
  check('11', 'live sync: an Admin edit to the asset shows on the vendor\'s next fetch', r.status === 200 && r.body.asset.name === 'ZZTEST UL renamed by admin' && r.body.asset.location === 'ZZTEST floor 2', r.body && r.body.asset);
  check('11', 'asset detail never carries employee assignment or cost (canViewCost off)', !('assignedToId' in r.body.asset) && !('purchaseCost' in r.body.asset) && !('assignedTo' in r.body.asset), Object.keys(r.body.asset));
  await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: vuA.id, assetId: aA5.id } });
  r = await call('GET', `/vendor-portal/assets/${aA5.id}`, { token: TA2 });
  check('11', 'removing an assignment revokes access on the very next request (403)', r.status === 403, r);
  r = await call('GET', '/vendor-portal/assets', { token: TA2 });
  check('11', 'and it is gone from the list', !(r.body.rows || []).some((x) => x.id === aA5.id), r.body && r.body.total);
  await prisma.vendorAssetAccess.create({ data: { vendorUserId: vuA.id, assetId: aA5.id } });
  r = await call('GET', `/vendor-portal/assets/${aA5.id}`, { token: TA2 });
  check('11', 'adding it back opens it at once', r.status === 200, r);

  // ---- 12. Admin preview handoff -------------------------------------------------
  r = await call('POST', `/vendor-logins/${vuA.id}/open-portal`, { token: (await staffLogin(em('recruiter'), pw.recruiter)).body.token });
  check('12', 'a non-admin staff login (recruiter) cannot mint a handoff token', r.status === 403, r);
  r = await call('POST', `/vendor-logins/${vuA.id}/open-portal`, { token: TA2 });
  check('12', 'a vendor token cannot mint a handoff token', r.status === 403, r);
  r = await call('POST', `/vendor-logins/${vuA.id}/open-portal`, { token: TS });
  const HT = r.body && r.body.token;
  check('12', 'Admin mints a handoff token', r.status === 200 && !!HT && r.body.expiresInSeconds === 60, r);
  const stored = HT ? await prisma.vendorLoginToken.findFirst({ where: { vendorUserId: vuA.id, purpose: 'preview' }, orderBy: { createdAt: 'desc' } }) : null;
  check('12', 'only a hash is stored, expiry <= 61 s', stored && stored.tokenHash !== HT && new Date(stored.expiresAt).getTime() - Date.now() <= 61000);
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: HT, newPassword: rpw(), confirmPassword: 'x' } });
  check('12', 'a preview token cannot be used as an invite / password-reset link', r.status >= 400 && r.status < 500, r.status);
  r = await call('POST', '/vendor-portal/preview/redeem', { body: { token: HT } });
  check('12', 'redeem works once and gives a vendor session marked as preview', r.status === 200 && !!r.body.token && !!r.body.preview, r);
  const PT = r.body && r.body.token;
  const r2 = await call('POST', '/vendor-portal/preview/redeem', { body: { token: HT } });
  check('12', 'the same token a second time is refused (single use)', r2.status === 404, r2);
  r = await call('GET', '/vendor-portal/me', { token: PT });
  check('12', '/me says Admin preview (the banner text source) and names the vendor', r.status === 200 && !!r.body.preview && r.body.vendorName === vA.name, r.body);
  r = await call('GET', '/vendor-portal/assets', { token: PT });
  check('12', 'the preview sees exactly the vendor\'s authorised assets', r.status === 200 && (r.body.rows || []).length === 3, r.body && r.body.total);
  r = await call('GET', `/vendor-portal/assets/${aB1.id}`, { token: PT });
  check('12', 'the preview cannot see another vendor\'s asset', r.status === 403, r);
  r = await call('PATCH', `/vendor-portal/assets/${aA1.id}`, { token: PT, body: { serialNumber: 'PREVIEWHACK' } });
  check('12', 'the preview cannot change data even though this login may edit (403)', r.status === 403 && r.body.preview === true, r);
  r = await call('GET', '/employees', { token: PT });
  check('12', 'the preview token is still refused on staff APIs', r.status === 403, r.status);
  check('12', 'audit rows exist: link made, link used', (await prisma.auditLog.count({ where: { entityId: vuA.id, action: { in: ['Vendor portal preview link made', 'Vendor portal opened as Admin preview'] } } })) >= 2);
  r = await call('POST', `/vendor-logins/${vuA.id}/open-portal`, { token: TS });
  await prisma.vendorLoginToken.updateMany({ where: { vendorUserId: vuA.id, purpose: 'preview', usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const r3 = await call('POST', '/vendor-portal/preview/redeem', { body: { token: r.body.token } });
  check('12', 'an expired handoff token is refused', r3.status === 404, r3);
  r = await call('POST', '/vendor-portal/logout', { token: PT });
  const r4 = await call('GET', '/vendor-portal/me', { token: PT });
  check('12', 'logout of the preview ends it server-side', r.status === 200 && r4.status === 401, [r.status, r4.status]);
  const inactiveOpen = await call('POST', `/vendor-logins/${(await prisma.vendorUser.findFirst({ where: { email: em('inactive') } })).id}/open-portal`, { token: TS });
  check('12', 'no preview for a switched-off login', inactiveOpen.status === 400, inactiveOpen);

  // ---- lockout ------------------------------------------------------------------
  const ipx = randIp();
  let last;
  for (let i = 0; i < 6; i += 1) last = await call('POST', '/vendor-portal/login', { body: { email: em('noassets'), password: `bad${i}` }, ip: ipx });
  r = await call('POST', '/vendor-portal/login', { body: { email: em('noassets'), password: pw.noassets }, ip: randIp() });
  check('5', 'existing lockout still works: 5 wrong passwords lock the login, even the right password is refused with the same text', r.status === 401 && r.body.error === 'Invalid credentials.', [last.status, r.status, r.body]);
}

async function cleanup() {
  const ids = (a) => ({ in: a.length ? a : ['__none__'] });
  await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, create: { key: 'audit.allowPurge', value: '1' }, update: { value: '1' } });
  try {
    await prisma.vendorSession.deleteMany({ where: { vendorUserId: ids(made.logins) } });
    await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: ids(made.logins) } });
    await prisma.vendorLoginToken.deleteMany({ where: { vendorUserId: ids(made.logins) } });
    await prisma.vendorUser.deleteMany({ where: { id: ids(made.logins) } });
    await prisma.assetAuditLog.deleteMany({ where: { OR: [{ vendorId: ids(made.vendors) }, { vendorUserId: ids(made.logins) }, { actorName: { contains: 'ZZTEST' } }, { assetId: ids(made.assets) }] } });
    await prisma.assetRepair.deleteMany({ where: { assetId: ids(made.assets) } });
    await prisma.asset.deleteMany({ where: { id: ids(made.assets) } });
    await prisma.officeVendor.deleteMany({ where: { id: ids(made.vendors) } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: ids(made.users) }, { entityId: ids([...made.logins, ...made.vendors, ...made.users]) }, { actorName: { contains: 'ZZTEST' } }, { toValue: { contains: 'zztest.ul.' } }, { toValue: { contains: 'ZZTEST UL' } }] } });
    await prisma.notification.deleteMany({ where: { userId: ids(made.users) } });
    await prisma.user.deleteMany({ where: { id: ids(made.users) } });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: 'audit.allowPurge' } });
  }
  const left = {
    users: await prisma.user.count({ where: { email: { contains: 'zztest.ul.' } } }),
    vendors: await prisma.officeVendor.count({ where: { name: { contains: 'ZZTEST UL' } } }),
    logins: await prisma.vendorUser.count({ where: { email: { contains: 'zztest.ul.' } } }),
    assets: await prisma.asset.count({ where: { assetCode: { contains: 'ZZTEST-UL' } } }),
    audit: await prisma.auditLog.count({ where: { OR: [{ actorName: { contains: 'ZZTEST UL' } }, { toValue: { contains: 'zztest.ul.' } }] } }),
  };
  console.log('CLEANUP leftover rows (sandbox):', JSON.stringify(left));
}

(async () => {
  try { await main(); } catch (e) { fail += 1; console.error('ERROR', e && e.stack || e); }
  try { await cleanup(); } catch (e) { console.error('cleanup failed', e && e.message); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
