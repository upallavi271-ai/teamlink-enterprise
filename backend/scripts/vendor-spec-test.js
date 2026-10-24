#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR SPEC ACCEPTANCE TESTS (2026-10-09). SANDBOX ONLY (refuses anything else).
//
//   cd backend && TL_API=http://localhost:4011 node scripts/vendor-spec-test.js
//
// Builds ZZTEST fixtures in sandbox.db, drives the real API on 4011, prints
// PASS/FAIL per check and removes everything it made (the AssetAuditLog
// break-glass setting 'audit.allowPurge' is set only for the cleanup and
// removed again). Groups map to the spec's acceptance tests:
//   A1 Admin adds a vendor            A2 Accounts adds a vendor (same master)
//   A3 duplicate prevention (vendors) A4 soft delete / deactivation
//   A5 vendor invoices + payments     A6 invite / reset links, lockout, sessions
//   A7 vendor token on staff APIs     A8 Vendor A vs Vendor B (IDOR), signed downloads
//   A9 Accounts keep their workflows  A10 Add Client in Invoices
//   A11 audit trail, journal posting, DB-level append-only
// ---------------------------------------------------------------------------
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API) || API.endsWith(':4045')) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another free sandbox port 4011-4099 (not 4045).'); process.exit(2); }
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).replace(/\\/g, '/')}`;
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const SIGNED = require(path.join(BACK, 'src/utils/vendorSigned'));
const attachments = require(path.join(BACK, 'src/utils/attachments'));

const RUN = Date.now().toString(36);
const results = [];
const made = { users: [], vendors: [], logins: [], clients: [], invoices: [], expenses: [], docs: [], files: [] };
const pwTokens = {};
const saved = { journal: null, emails: null };
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
async function call(method, p, { token, body, form, ip, headers, raw } = {}) {
  const h = { 'X-Forwarded-For': ip || randIp(), ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await rfetch(`${API}${raw ? '' : '/api'}${p}`, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const staffTok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const pdfForm = (fields, name = 'zztest-doc.pdf') => {
  const fd = new FormData();
  Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, String(v)));
  fd.append('file', new Blob([PDF], { type: 'application/pdf' }), name);
  return fd;
};
const PW = (t) => `Zz!${RUN}${t}Aa9x`;
const tokenOf = (link) => decodeURIComponent(String(link).split('invite=')[1] || '');
const today = () => new Date().toISOString().slice(0, 10);
// Valid-checksum GSTINs (same state / different PANs) built with the app's own checker.
const { checkGstin, gstinCheckChar } = require(path.join(BACK, 'src/utils/gstin'));
function gstinFor(pan10, stateCode = '36', entity = '1') {
  const body = `${stateCode}${pan10}${entity}Z`;
  return body + gstinCheckChar(body);
}

async function main() {
  const mk = async (label, data) => {
    const u = await prisma.user.create({ data: { name: `ZZTEST SPEC ${label}`, email: `zztest.spec.${label.toLowerCase()}.${RUN}@example.test`, passwordHash: crypto.randomBytes(24).toString('hex'), status: 'Active', ...data } });
    made.users.push(u.id); return u;
  };
  const admin = await mk('Admin', { role: 'ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
  const acct = await mk('Accountant', { role: 'ACCOUNTANT', accountsAccess: true, accountsRole: 'ACCOUNTANT', hrmsAccess: false, atsAccess: false });
  const rec = await mk('Recruiter', { role: 'RECRUITER', atsAccess: true, hrmsAccess: false, accountsAccess: false, atsRole: 'RECRUITER' });
  const A = staffTok(admin); const AC = staffTok(acct); const R = staffTok(rec);
  saved.journal = await prisma.appSetting.findUnique({ where: { key: 'vendor.journalPosting' } });
  saved.emails = await prisma.appSetting.findUnique({ where: { key: 'vendorPortal.settings' } });
  // DATA: the founder has switched Vendor emails ON in the real database. This suite is about the default (emails OFF: the link is shown to pass on by hand), so start from OFF; cleanup() puts the saved value back.
  await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: false }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: false }) } });

  // =================== A1 / A2 — one master, two doors ======================
  const gA = gstinFor('ABCPZ1234F');
  check('A1', 'test GSTIN passes the app checksum', checkGstin(gA).ok, checkGstin(gA));
  let r = await call('POST', '/vendor-master', { token: A, body: { name: `ZZTEST Vendor Alpha ${RUN}`, companyName: 'Alpha Services Pvt Ltd', contactPerson: 'Asha', email: `Alpha.${RUN}@Example.test`, phone: '+91 98480 11111', gstin: gA.toLowerCase(), pan: 'ABCPZ1234F', category: 'Internet', paymentTerms: 'Net 30', address: '1 Test Road' } });
  const VA = r.body && r.body.vendor;
  check('A1', 'Admin adds a vendor (201, VEN code, all fields kept)', r.status === 201 && VA && /^VEN-\d{4}$/.test(VA.vendorCode) && VA.gstin === gA && VA.pan === 'ABCPZ1234F' && VA.category === 'Internet' && VA.companyName === 'Alpha Services Pvt Ltd', r.body);
  if (VA) made.vendors.push(VA.id);
  r = await call('POST', '/office-expenses/vendors', { token: AC, body: { name: `ZZTEST Vendor Beta ${RUN}`, companyName: 'Beta Co', contactPerson: 'Bala', email: `beta.${RUN}@example.test`, phone: '9848022222', gstin: gstinFor('BCDPZ2345G', '36'), pan: 'BCDPZ2345G', category: 'Rent' } });
  const VB = r.body;
  check('A2', 'Accounts adds a vendor through Office & Accounts (same master, VEN code, new fields)', r.status === 201 && /^VEN-\d{4}$/.test(VB.vendorCode) && VB.pan === 'BCDPZ2345G' && VB.category === 'Rent' && VB.source === 'Office', r.body);
  if (VB && VB.id) made.vendors.push(VB.id);
  r = await call('GET', '/vendor-master', { token: A });
  check('A2', 'a vendor added in Office shows in Admin → Vendors (one master)', r.status === 200 && r.body.rows.some((x) => x.id === VB.id) && r.body.rows.some((x) => x.id === VA.id), r.status);
  r = await call('GET', '/office-expenses/vendors', { token: AC });
  check('A1', 'a vendor added by Admin shows in the Office vendor list', r.status === 200 && r.body.some((x) => x.id === VA.id));
  r = await call('PATCH', `/vendor-master/${VA.id}`, { token: A, body: { paymentTerms: 'Net 45', category: 'Internet & phone' } });
  check('A1', 'Admin edits a vendor (old/new audited)', r.status === 200 && r.body.vendor.paymentTerms === 'Net 45' && !!(await prisma.assetAuditLog.findFirst({ where: { vendorId: VA.id, action: 'Vendor edited', field: 'paymentTerms', oldValue: 'Net 30', newValue: 'Net 45', ip: { not: null } } })), r.body);
  r = await call('GET', `/vendor-master/${VA.id}`, { token: A });
  check('A1', 'Admin opens one vendor: details, logins, bills, documents', r.status === 200 && r.body.vendor.id === VA.id && Array.isArray(r.body.invoices) && Array.isArray(r.body.logins) && Array.isArray(r.body.documents) && r.body.invoiceSummary, r.status);
  r = await call('GET', '/vendor-master?q=alpha&status=Active', { token: A });
  check('A1', 'search + status filter with counts', r.body.rows.length >= 1 && r.body.rows.every((x) => x.isActive) && r.body.facets.status.length >= 1);

  // =================== A3 — duplicates =======================================
  const dupBody = (o) => ({ name: `ZZTEST Dup ${crypto.randomBytes(3).toString('hex')}`, ...o });
  for (const [label, who, ep] of [['Admin', A, '/vendor-master'], ['Accounts', AC, '/office-expenses/vendors']]) {
    r = await call('POST', ep, { token: who, body: dupBody({ gstin: gA.toLowerCase() }) });
    check('A3', `${label}: same GSTIN (other letter case) is refused and names the existing vendor`, r.status === 409 && r.body.blocking && (r.body.vendor || {}).id === VA.id && /VEN-\d+/.test(r.body.error), r.body);
    r = await call('POST', ep, { token: who, body: dupBody({ pan: 'abcpz1234f' }) });
    check('A3', `${label}: same PAN refused`, r.status === 409 && r.body.blocking && r.body.vendor.id === VA.id, r.body);
    r = await call('POST', ep, { token: who, body: dupBody({ email: `  ALPHA.${RUN}@example.test ` }) });
    check('A3', `${label}: same email (case / spaces ignored) refused`, r.status === 409 && r.body.blocking && r.body.vendor.id === VA.id, r.body);
    r = await call('POST', ep, { token: who, body: { name: `  zztest   VENDOR alpha ${RUN} ` } });
    check('A3', `${label}: same name in another letter case refused`, r.status === 409 && r.body.blocking && /already exists/.test(r.body.error), r.body);
  }
  r = await call('POST', '/vendor-master', { token: A, body: dupBody({ phone: '098480 11111' }) });
  check('A3', 'same phone = a WARNING that names the vendor (not blocked)', r.status === 409 && r.body.warning === true && r.body.vendor.id === VA.id, r.body);
  r = await call('POST', '/vendor-master', { token: A, body: dupBody({ phone: '098480 11111', confirmDuplicate: true }) });
  check('A3', 'the warning can be confirmed: saved', r.status === 201, r.body);
  if (r.body && r.body.vendor) made.vendors.push(r.body.vendor.id);
  r = await call('POST', '/vendor-master', { token: A, body: { name: `ZZTEST Vendor Alpha ${RUN} Pvt Ltd` } });
  check('A3', 'same name apart from Pvt / Ltd = a warning', r.status === 409 && r.body.warning === true, r.body);
  r = await call('POST', '/vendor-master', { token: A, body: dupBody({ gstin: 'BAD' }) });
  check('A3', 'bad GSTIN refused with the field named', r.status === 400 && r.body.field === 'gstin', r.body);
  r = await call('POST', '/vendor-master', { token: A, body: dupBody({ gstin: gstinFor('ZZZPZ9999Z', '36'), pan: 'ABCPZ1234F' }) });
  check('A3', 'PAN that does not match the GSTIN refused', r.status === 400 && r.body.field === 'pan', r.body);
  r = await call('PATCH', `/vendor-master/${VB.id}`, { token: A, body: { email: `alpha.${RUN}@example.test` } });
  check('A3', 'edit: changing to another vendor\'s email refused', r.status === 409 && r.body.vendor.id === VA.id, r.body);

  // =================== A9 — who may do what ==================================
  r = await call('GET', '/vendor-master', { token: AC });
  check('A9', 'plain Accountant cannot open Admin Vendor Management (403)', r.status === 403, r.status);
  r = await call('GET', '/vendor-master', { token: R });
  check('A9', 'Recruiter cannot open Vendor Management (403)', r.status === 403, r.status);
  r = await call('POST', '/office-expenses/vendors', { token: R, body: { name: `ZZTEST rec ${RUN}` } });
  check('A9', 'Recruiter cannot add a vendor (403)', r.status === 403, r.status);
  r = await call('POST', '/vendor-logins', { token: AC, body: { vendorId: VA.id, name: 'x', email: `zztest.x.${RUN}@example.test` } });
  check('A9', 'Accountant cannot create vendor logins (403)', r.status === 403, r.status);
  r = await call('PUT', '/vendor-master/journal-posting/status', { token: AC, body: { enabled: true } });
  check('A9', 'Accountant cannot flip the journal-posting switch (403)', r.status === 403, r.status);
  r = await call('GET', '/vendor-bills', { token: AC });
  check('A9', 'Accountant keeps "Bills from vendors" (200)', r.status === 200, r.status);
  r = await call('GET', '/office-expenses', { token: AC });
  check('A9', 'Accountant keeps Office expenses (200)', r.status === 200, r.status);
  r = await call('GET', '/invoices', { token: AC });
  check('A9', 'Accountant keeps the Invoices register (200)', r.status === 200, r.status);

  // =================== A6 — logins: invite links =============================
  const aEmail = `zztest.spec.va.${RUN}@example.test`;
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: VA.id, name: 'ZZTEST VA Contact', email: aEmail, emailLink: true } });
  const LA = r.body && r.body.login;
  check('A6', 'create login = a secure link; no password set or returned', r.status === 201 && r.body.inviteLink && /vendor-login\?invite=/.test(r.body.inviteLink) && !r.body.tempPassword && !r.body.password && !/passwordHash/.test(r.text), r.body);
  if (LA) made.logins.push(LA.id);
  check('A6', 'emailing is OFF by default: nothing sent, and the message never says a password was mailed', r.body.emailed === false);
  const dbTok = await prisma.vendorLoginToken.findFirst({ where: { vendorUserId: LA.id } });
  const rawTok = tokenOf(r.body.inviteLink);
  check('A6', 'only the sha256 of the link token is stored (raw token not in the DB)', dbTok && dbTok.tokenHash !== rawTok && dbTok.tokenHash === crypto.createHash('sha256').update(rawTok).digest('hex'));
  check('A6', 'link expiry is ~72 h', dbTok && Math.abs(new Date(dbTok.expiresAt) - Date.now() - 72 * 3600000) < 120000);
  r = await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: 'anything-at-all-1A!' } });
  check('A6', 'before the link is used the login cannot sign in (generic 401)', r.status === 401 && r.body.error === 'Invalid credentials.');
  r = await call('GET', `/vendor-portal/invite/${encodeURIComponent(rawTok)}`);
  check('A6', 'the link checks out (vendor name + email, no secrets)', r.status === 200 && r.body.valid && r.body.email === aEmail && !/hash/i.test(r.text), r.body);
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok, newPassword: 'weak', confirmPassword: 'weak' } });
  const stillValid = await call('GET', `/vendor-portal/invite/${encodeURIComponent(rawTok)}`);
  check('A6', 'a weak password is refused and does NOT burn the link', r.status === 400 && stillValid.status === 200, r.body);
  const pwA = PW('A');
  // two parallel accepts: exactly one wins (atomic single use)
  const [x1, x2] = await Promise.all([
    call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok, newPassword: pwA, confirmPassword: pwA } }),
    call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok, newPassword: pwA, confirmPassword: pwA } }),
  ]);
  check('A6', 'single use: two simultaneous opens → exactly one succeeds', [x1.status, x2.status].filter((s) => s === 200).length === 1, [x1.status, x2.status]);
  const okAcc = x1.status === 200 ? x1 : x2;
  const TA = okAcc.body && okAcc.body.token;
  r = await call('GET', `/vendor-portal/invite/${encodeURIComponent(rawTok)}`);
  check('A6', 'a used link is dead (generic 404)', r.status === 404);
  const dbA = await prisma.vendorUser.findUnique({ where: { id: LA.id } });
  check('A6', 'vendor chose the password: bcrypt hash, no forced change left, temp expiry cleared', /^\$2[aby]\$10\$/.test(dbA.passwordHash) && dbA.mustChangePassword === false && dbA.tempPasswordExpiresAt === null);
  r = await call('GET', '/vendor-portal/me', { token: TA });
  check('A6', 'the new session works (/me)', r.status === 200 && r.body.email === aEmail, r.status);
  r = await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: pwA } });
  check('A6', 'sign in with the chosen password', r.status === 200 && !!r.body.token);
  // expired link
  r = await call('POST', `/vendor-logins/${LA.id}/invite`, { token: A, body: {} });
  const rawTok2 = tokenOf(r.body.inviteLink);
  check('A6', 'a later link is a RESET link for a login that signed in; it signs open sessions out', r.status === 200 && r.body.purpose === 'reset' && (await call('GET', '/vendor-portal/me', { token: TA })).status === 401, r.body);
  await prisma.vendorLoginToken.updateMany({ where: { vendorUserId: LA.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 60000) } });
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok2, newPassword: PW('A2'), confirmPassword: PW('A2') } });
  check('A6', 'an expired link is refused (generic message)', r.status === 400 && r.body.linkProblem === true, r.body);
  r = await call('POST', `/vendor-logins/${LA.id}/invite`, { token: A, body: {} });
  const rawTok3 = tokenOf(r.body.inviteLink);
  r = await call('POST', `/vendor-logins/${LA.id}/invite`, { token: A, body: {} });
  const rawTok4 = tokenOf(r.body.inviteLink);
  const old = await call('GET', `/vendor-portal/invite/${encodeURIComponent(rawTok3)}`);
  check('A6', 'making a new link cancels the older unused one', old.status === 404 && (await call('GET', `/vendor-portal/invite/${encodeURIComponent(rawTok4)}`)).status === 200);
  const pwA2 = PW('A3');
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok4, newPassword: pwA2, confirmPassword: pwA2 } });
  check('A6', 'reset by link: new password works, the OLD password stops working', r.status === 200 && (await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: pwA } })).status === 401 && (await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: pwA2 } })).status === 200);
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: rawTok4, newPassword: PW('A4'), confirmPassword: PW('A4') } });
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: 'not-a-real-token-xxxxxxxxxxxxxxxxxxxxxx', newPassword: PW('A4'), confirmPassword: PW('A4') } });
  check('A6', 'a made-up token gets the same generic refusal', r.status === 400 && r.body.error === 'This link is not valid or has expired. Ask your contact for a new one.');
  // lockout on a fresh login (B) — 5 wrong passwords
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: VB.id, name: 'ZZTEST VB Contact', email: `zztest.spec.vb.${RUN}@example.test` } });
  const LB = r.body.login; made.logins.push(LB.id);
  const pwB = PW('B');
  r = await call('POST', '/vendor-portal/invite/accept', { body: { token: tokenOf(r.body.inviteLink), newPassword: pwB, confirmPassword: pwB } });
  const TB = r.body && r.body.token;
  check('A6', 'second vendor signs in via its own link', r.status === 200 && !!TB, r.body);
  const lockEmail = `zztest.spec.lock.${RUN}@example.test`;
  r = await call('POST', '/vendor-logins', { token: A, body: { vendorId: VB.id, name: 'ZZTEST Lock', email: lockEmail, password: PW('L'), status: 'Active' } });
  const LL = r.body && r.body.login; if (LL) made.logins.push(LL.id);
  r = await call('POST', `/vendor-logins/${LL.id}/reset-password`, { token: A, body: { autoPassword: true, emailPassword: true } });
  check('A6', 'older temp-password reset never emails the password', r.status === 200 && r.body.emailed === false && !/emailed to|sent to/i.test(r.body.message));
  await call('POST', `/vendor-logins/${LL.id}/reset-password`, { token: A, body: { autoPassword: false, password: PW('L') } });
  let last;
  for (let i = 0; i < 5; i += 1) last = await call('POST', '/vendor-portal/login', { body: { email: lockEmail, password: 'Wrong!Pass1x' } });
  r = await call('POST', '/vendor-portal/login', { body: { email: lockEmail, password: PW('L') } });
  // 2026-10-19: a lock is now NAMED (the same words for a real and an unknown login ID, right or wrong password), so the vendor knows to wait.
  check('A6', '5 wrong passwords lock the login; even the right password is refused (401, and the lock is named with the minutes)', last.status === 401 && last.body.code === 'LOCKED' && r.status === 401 && r.body.code === 'LOCKED' && /paused for [0-9]+ more minutes?/.test(r.body.error) && !r.body.token, [last.status, r.status, r.body]);
  check('A6', 'lockout audited with IP', !!(await prisma.assetAuditLog.findFirst({ where: { vendorUserId: LL.id, action: 'Login locked', ip: { not: null } } })));
  // rate limit: one network hammering one account
  const sameIp = randIp(); let got429 = false;
  for (let i = 0; i < 14 && !got429; i += 1) { const x = await call('POST', '/vendor-portal/login', { ip: sameIp, body: { email: `zztest.rl.${RUN}@example.test`, password: 'x' } }); if (x.status === 429) got429 = true; }
  check('A6', 'repeated sign-in tries from one network are rate-limited (429)', got429);
  const inviteIp = randIp(); let inv429 = false;
  for (let i = 0; i < 26 && !inv429; i += 1) { const x = await call('GET', `/vendor-portal/invite/${crypto.randomBytes(24).toString('base64url')}`, { ip: inviteIp }); if (x.status === 429) inv429 = true; }
  check('A6', 'guessing invite links is rate-limited (429)', inv429);

  // =================== A4 — soft delete / deactivation =======================
  r = await call('DELETE', `/vendor-master/${VB.id}`, { token: A });
  check('A4', 'there is no hard-delete route for a vendor (404/405)', [404, 405].includes(r.status), r.status);
  check('A4', 'the vendor row still exists', !!(await prisma.officeVendor.findUnique({ where: { id: VB.id } })));
  r = await call('POST', `/vendor-master/${VB.id}/deactivate`, { token: A, body: {} });
  check('A4', 'switching off needs a reason (400)', r.status === 400 && r.body.field === 'reason', r.body);
  const sessB = await call('GET', '/vendor-portal/me', { token: TB });
  r = await call('POST', `/vendor-master/${VB.id}/deactivate`, { token: A, body: { reason: 'ZZTEST contract ended' } });
  const after = await call('GET', '/vendor-portal/me', { token: TB });
  check('A4', 'deactivating the vendor kills its open session AT ONCE (401)', sessB.status === 200 && r.status === 200 && after.status === 401, [sessB.status, r.status, after.status]);
  r = await call('POST', '/vendor-portal/login', { body: { email: `zztest.spec.vb.${RUN}@example.test`, password: pwB } });
  check('A4', 'a deactivated vendor cannot sign in (401; with the right password the reason is named)', r.status === 401 && r.body.code === 'VENDOR_OFF' && /switched off/i.test(r.body.error), r.body);
  const rowB = await prisma.officeVendor.findUnique({ where: { id: VB.id } });
  check('A4', 'who / when / why recorded', rowB.isActive === false && rowB.deactivatedAt && rowB.deactivatedById === admin.id && /contract ended/.test(rowB.deactivationReason));
  r = await call('POST', '/office-expenses/vendors', { token: AC, body: { name: `zztest vendor beta ${RUN}` } });
  check('A4', 'a switched-off vendor\'s name is still taken (no duplicate)', r.status === 409);
  r = await call('POST', `/vendor-master/${VB.id}/activate`, { token: A, body: {} });
  check('A4', 'can be switched on again', r.status === 200 && r.body.vendor.isActive === true);
  // single login deactivation → session dead at once
  r = await call('POST', '/vendor-portal/login', { body: { email: `zztest.spec.vb.${RUN}@example.test`, password: pwB } });
  const TB2 = r.body.token;
  await call('POST', `/vendor-logins/${LB.id}/deactivate`, { token: A, body: {} });
  r = await call('GET', '/vendor-portal/me', { token: TB2 });
  check('A4', 'deactivating one login ends its session at once (401)', r.status === 401);
  await call('POST', `/vendor-logins/${LB.id}/activate`, { token: A, body: {} });
  r = await call('POST', '/vendor-portal/login', { body: { email: `zztest.spec.vb.${RUN}@example.test`, password: pwB } });
  const TBx = r.body.token;

  // =================== A5 — vendor invoices, payments, documents ============
  r = await call('GET', '/office-expenses/categories', { token: A });
  const cat = (r.body.find((c) => c.isActive) || {}).name;
  const mkBill = async (vendor, extra) => {
    const x = await call('POST', '/office-expenses', {
      token: AC,
      body: { category: cat, expenseDate: today(), baseAmount: 10000, gstAmount: 1800, tdsAmount: 200, vendor, billNumber: `ZZ-${crypto.randomBytes(3).toString('hex')}`, recurring: false, ...extra },
    });
    if (x.body && x.body.id) made.expenses.push(x.body.id);
    return x;
  };
  let e1 = await mkBill(`  zztest VENDOR ALPHA ${RUN}`);
  check('A5', 'a bill booked with the vendor\'s name (any case) is linked by ID and snapshotted', e1.status === 201 && (await prisma.officeExpense.findUnique({ where: { id: e1.body.id } })).vendorId === VA.id, e1.body);
  const dbE1 = await prisma.officeExpense.findUnique({ where: { id: e1.body.id } });
  check('A5', 'snapshot: name, GSTIN, PAN, address copied onto the bill', dbE1.vendor === VA.name && dbE1.vendorGstin === gA && dbE1.vendorPan === 'ABCPZ1234F' && dbE1.vendorAddress === '1 Test Road', dbE1);
  await call('PATCH', `/vendor-master/${VA.id}`, { token: A, body: { address: '2 New Road' } });
  const dbE1b = await prisma.officeExpense.findUnique({ where: { id: e1.body.id } });
  check('A5', 'editing the master later does NOT rewrite the old bill (snapshot)', dbE1b.vendorAddress === '1 Test Road');
  const e2 = await mkBill(`ZZTEST Vendor Beta ${RUN}`);
  const e3 = await mkBill('ZZTEST Free Text Vendor ' + RUN);
  check('A5', 'a bill for a name that is not in the master stays free text (no link)', e3.status === 201 && (await prisma.officeExpense.findUnique({ where: { id: e3.body.id } })).vendorId === null);
  // older free-text bills linked by Admin
  const old1 = await prisma.officeExpense.create({ data: { category: cat, monthlyAmount: 5900, gstAmount: 900, tdsAmount: 100, expenseDate: today(), vendor: `ZZTEST OLD TEXT ${RUN}`, billNumber: 'OLD-1', approvalStatus: 'PENDING', paidStatus: 'Unpaid', recurring: false } });
  made.expenses.push(old1.id);
  r = await call('POST', '/vendor-master', { token: A, body: { name: `zztest old text ${RUN}` } });
  const VO = r.body.vendor; made.vendors.push(VO.id);
  r = await call('GET', `/vendor-master/${VO.id}/unlinked-bills`, { token: A });
  check('A5', 'Admin sees the older bills typed with this vendor\'s name', r.body.rows.length === 1 && r.body.rows[0].id === old1.id, r.body);
  r = await call('POST', `/vendor-master/${VO.id}/link-bills`, { token: A, body: { all: true } });
  check('A5', 'Admin links them (nothing automatic)', r.status === 200 && r.body.linked === 1 && (await prisma.officeExpense.findUnique({ where: { id: old1.id } })).vendorId === VO.id, r.body);
  r = await call('POST', `/vendor-master/${VO.id}/link-bills`, { token: A, body: { expenseIds: [e3.body.id] } });
  check('A5', 'a bill with another vendor name cannot be linked to this vendor', r.status === 400);
  // payment
  r = await call('PATCH', `/office-expenses/${e1.body.id}/status`, { token: A, body: { action: 'mark_paid', paymentDate: today(), paymentMode: 'Bank Transfer' } });
  check('A5', 'Accounts marks the bill paid (existing workflow unchanged)', r.status === 200, r.body);
  r = await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: pwA2 } }); pwTokens.A = r.body.token;
  r = await call('GET', '/vendor-portal/invoices', { token: pwTokens.A });
  const mine = r.body && r.body.rows ? r.body.rows : [];
  const row1 = mine.find((x) => x.billNumber === dbE1.billNumber);
  check('A5', 'Vendor A sees its own bill: amount, GST, TDS, net, paid, date, outstanding', r.status === 200 && row1 && row1.amount === 10000 && row1.gst === 1800 && row1.tds === 200 && row1.netPayable === 11600 && row1.paid === true && row1.paymentDate === today() && row1.outstanding === 0 && row1.paidAmount === 11600, row1 || r.body);
  check('A5', 'summary: billed / paid / outstanding / TDS', r.body.summary.invoiced === 11600 && r.body.summary.paid === 11600 && r.body.summary.outstanding === 0 && r.body.summary.tds === 200, r.body.summary);
  check('A5', 'the vendor sees ONLY its own bills (none of B\'s / unlinked / free-text)', mine.every((x) => [dbE1.billNumber].includes(x.billNumber)) && mine.length === 1, mine.map((x) => x.billNumber));
  check('A5', 'vendor rows carry no internal fields (no approver / ledger / expense code / journal)', !/approvedBy|expenseCode|journal|ledger|createdById|paidById|remarks/i.test(JSON.stringify(r.body)), Object.keys(mine[0] || {}));
  const eU = await mkBill(`ZZTEST Vendor Alpha ${RUN}`, { gstAmount: 0, tdsAmount: 0 });
  r = await call('GET', '/vendor-portal/invoices?status=unpaid', { token: pwTokens.A });
  const un = r.body.rows.find((x) => x.paid === false);
  check('A5', 'a pending bill shows as still to be paid with the outstanding amount', un && un.outstanding === 10000 && un.statusText.includes('waiting for payment'), r.body.rows);
  r = await call('GET', '/vendor-portal/invoices', { token: TBx });
  check('A5', 'Vendor B sees only B\'s bill, not A\'s', r.body.rows.length === 1 && r.body.rows[0].billNumber === (await prisma.officeExpense.findUnique({ where: { id: e2.body.id } })).billNumber, r.body.rows);
  r = await call('GET', '/vendor-portal/profile', { token: pwTokens.A });
  check('A5', 'profile shows own details only (no notes, no ids of others)', r.status === 200 && r.body.vendor.name === VA.name && r.body.vendor.gstin === gA && !('notes' in r.body.vendor), r.body);
  // shared documents
  r = await call('POST', `/vendor-master/${VA.id}/documents`, { token: A, form: pdfForm({ title: 'ZZTEST Agreement', docType: 'Agreement' }) });
  const DA = r.body && r.body.document;
  check('A5', 'Admin shares a document with Vendor A', r.status === 201 && DA, r.body);
  if (DA) made.docs.push(DA.id);
  r = await call('POST', `/vendor-master/${VB.id}/documents`, { token: A, form: pdfForm({ title: 'ZZTEST B only', docType: 'Other' }) });
  const DB = r.body && r.body.document; if (DB) made.docs.push(DB.id);
  r = await call('POST', `/vendor-master/${VA.id}/documents`, { token: A, form: pdfForm({ title: 'bad' }, 'evil.exe') });
  check('A5', 'only PDF / JPG / PNG can be shared (exe refused)', r.status === 400);
  r = await call('GET', '/vendor-portal/documents', { token: pwTokens.A });
  check('A5', 'Vendor A lists its shared documents (not B\'s)', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].id === DA.id && !/file/i.test(Object.keys(r.body.rows[0]).join(',')), r.body);

  // =================== A8 — IDOR + signed downloads ===========================
  r = await call('POST', '/vendor-portal/download-link', { token: pwTokens.A, body: { kind: 'shared', id: DA.id } });
  const urlA = r.body && r.body.url;
  check('A8', 'Vendor A gets a signed link for its document (3-minute expiry)', r.status === 200 && /^\/api\/vendor-portal\/files\//.test(urlA) && r.body.expiresInSeconds === 180, r.body);
  const open = await call('GET', urlA.replace(/^\/api/, ''), { });
  check('A8', 'the link opens with NO header, returns the file as an attachment', open.status === 200 && /attachment/.test(open.headers.get('content-disposition') || '') && open.text.startsWith('%PDF'), [open.status, open.headers.get('content-disposition')]);
  check('A8', 'the download is logged (who, IP, document)', !!(await prisma.assetAuditLog.findFirst({ where: { vendorId: VA.id, action: 'Document downloaded', documentName: 'zztest-doc.pdf', ip: { not: null } } })));
  r = await call('POST', '/vendor-portal/download-link', { token: pwTokens.A, body: { kind: 'shared', id: DB.id } });
  check('A8', 'IDOR: Vendor A asks for Vendor B\'s document → 403', r.status === 403, r.body);
  r = await call('POST', '/vendor-portal/download-link', { token: TBx, body: { kind: 'shared', id: DA.id } });
  check('A8', 'IDOR: Vendor B asks for Vendor A\'s document → 403', r.status === 403, r.body);
  r = await call('POST', '/vendor-portal/download-link', { token: pwTokens.A, body: { kind: 'shared', id: 'nope' } });
  check('A8', 'a document that does not exist gives the same 403 (ids cannot be probed)', r.status === 403);
  r = await call('POST', '/vendor-portal/download-link', { token: pwTokens.A, body: { kind: 'bill', id: 'someone-elses' } });
  check('A8', 'IDOR on a bill id → 403', r.status === 403);
  const tamper = urlA.replace(/^\/api/, '').slice(0, -3) + 'AAA';
  check('A8', 'a tampered link is refused (403)', (await call('GET', tamper)).status === 403);
  // forge: a token signed for A but pointing at B's vendor / doc
  const sidA = (await prisma.vendorSession.findFirst({ where: { vendorUserId: LA.id, revokedAt: null }, orderBy: { createdAt: 'desc' } })).id;
  const forged = SIGNED.sign({ k: 'shared', id: DB.id, vid: VA.id, vuid: LA.id, sid: sidA }).token;
  check('A8', 'a correctly signed token for a document that is not the vendor\'s is refused', (await call('GET', `/vendor-portal/files/${forged}`)).status === 403);
  const expired = SIGNED.sign({ k: 'shared', id: DA.id, vid: VA.id, vuid: LA.id, sid: sidA }, -10).token;
  check('A8', 'an expired link is refused (403)', (await call('GET', `/vendor-portal/files/${expired}`)).status === 403);
  const good = SIGNED.sign({ k: 'shared', id: DA.id, vid: VA.id, vuid: LA.id, sid: sidA }).token;
  check('A8', 'sanity: that same good token works', (await call('GET', `/vendor-portal/files/${good}`)).status === 200);
  const rB = await call('POST', '/vendor-portal/download-link', { token: TBx, body: { kind: 'shared', id: DB.id } });
  await call('POST', '/vendor-portal/logout', { token: TBx });
  check('A8', 'after the vendor signs out, its unexpired link no longer opens', (await call('GET', rB.body.url.replace(/^\/api/, ''))).status === 403);
  r = await call('POST', `/vendor-logins/${LA.id}/deactivate`, { token: A, body: {} });
  check('A8', 'deactivated login: even an unexpired signed link dies at once', (await call('GET', `/vendor-portal/files/${good}`)).status === 403);
  check('A8', 'deactivated login: its session is 401 at once', (await call('GET', '/vendor-portal/invoices', { token: pwTokens.A })).status === 401);
  await call('POST', `/vendor-logins/${LA.id}/activate`, { token: A, body: {} });
  r = await call('DELETE', `/vendor-master/${VA.id}/documents/${DA.id}`, { token: A });
  r = await call('POST', '/vendor-portal/login', { body: { email: aEmail, password: pwA2 } }); pwTokens.A = r.body.token;
  check('A8', 'a document Admin stopped sharing disappears from the vendor', (await call('GET', '/vendor-portal/documents', { token: pwTokens.A })).body.rows.length === 0 && (await call('POST', '/vendor-portal/download-link', { token: pwTokens.A, body: { kind: 'shared', id: DA.id } })).status === 403);

  // =================== A7 — a vendor token on every staff area ==============
  const probes = ['/vendor-master', '/vendor-logins', '/office-expenses', '/office-expenses/vendors', '/bank', '/journal', '/journal/accounts', '/ledger', '/reports', '/reports/profit-loss', '/invoices', '/invoice-clients', '/clients', '/admin/users', '/admin', '/employees', '/dashboard', '/vendor-bills', '/auth/me', '/candidates', '/payroll', '/audit', '/accounts-import'];
  const bad = [];
  for (const p of probes) {
    for (const m of ['GET', 'POST']) {
      // eslint-disable-next-line no-await-in-loop
      const x = await call(m, p, { token: pwTokens.A, body: m === 'POST' ? {} : undefined });
      if (x.status !== 403) bad.push(`${m} ${p} -> ${x.status}`);
    }
  }
  check('A7', `vendor token gets 403 on ${probes.length * 2} staff calls (admin / expenses / bank / journal / ledger / reports / invoices / clients …)`, bad.length === 0, bad);
  const forgedVendorJwt = jwt.sign({ typ: 'vendor', vuid: LA.id, jti: 'x' }, 'wrong-secret', { audience: 'vendor-portal' });
  check('A7', 'a forged vendor token is refused on a staff route (403) and on the portal (401)', (await call('GET', '/office-expenses', { token: forgedVendorJwt })).status === 403 && (await call('GET', '/vendor-portal/invoices', { token: forgedVendorJwt })).status === 401);
  check('A7', 'a staff token is refused by the vendor portal (401)', (await call('GET', '/vendor-portal/invoices', { token: A })).status === 401);
  const hook = await call('POST', '/webhooks/sms/zz1', { token: pwTokens.A, body: {} });
  check('A7', 'vendor token on the public webhook mount is also 403', hook.status === 403, hook.status);
  const jr = await call('GET', '/journal', { token: pwTokens.A });
  check('A7', 'vendors never see journals / ledgers (403, no data)', jr.status === 403 && !/debit|credit/i.test(jr.text));

  // =================== A10 — Add Client in Invoices ===========================
  const cName = `ZZTEST Client Gamma ${RUN}`;
  const cG = gstinFor('CDEPZ3456H', '36');
  r = await call('GET', '/invoice-clients', { token: AC });
  check('A10', 'Accountant: client dropdown loads real clients from the central table', r.status === 200 && r.body.rows.length > 5 && r.body.rows[0].id && 'gstin' in r.body.rows[0], r.status);
  const realClient = r.body.rows.find((c) => c.name);
  r = await call('GET', `/invoice-clients/${realClient.id}`, { token: AC });
  check('A10', 'selecting a client returns its saved details', r.status === 200 && r.body.client.id === realClient.id && 'billingAddress' in r.body.client && 'email' in r.body.client, r.body);
  r = await call('POST', '/invoice-clients', { token: R, body: { clientName: 'x' } });
  check('A10', 'Recruiter cannot add a client from Invoices (403)', r.status === 403, r.status);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: cName, company: 'Gamma Industries Pvt Ltd', contactName: 'Gina', email: `gina.${RUN}@gamma-zztest.example.test`, phone: '9848033333', billingAddress: '9 Billing Lane, Hyderabad', gstin: cG.toLowerCase() } });
  const CG = r.body && r.body.client;
  check('A10', 'Accountant adds a client: 201, CLI auto ID, draft, marked as from Invoices', r.status === 201 && /^CLI-?\d+/.test(CG.clientCode) && CG.isDraft && CG.fromInvoices && CG.gstin === cG, r.body);
  if (CG) made.clients.push(CG.id);
  const dbC = await prisma.client.findUnique({ where: { id: CG.id } });
  check('A10', 'in the CENTRAL Client table: agreement DRAFT, no BDE, no owner dept (ATS cannot use it for jobs yet)', dbC.agreementStatus === 'DRAFT' && dbC.clientSource === 'Invoices (Accounts)' && !dbC.bdeOwner && !dbC.ownerDepartment && !dbC.agreementActivatedAt, dbC);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: 'ZZTEST other', gstin: cG } });
  check('A10', 'duplicate GSTIN blocked, names the existing client', r.status === 409 && r.body.blocking && r.body.duplicates[0].id === CG.id && /CLI-?\d+/.test(r.body.error), r.body);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: cName.toUpperCase() } });
  check('A10', 'duplicate name (other letter case) blocked', r.status === 409 && r.body.blocking, r.body);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: `ZZTEST Delta ${RUN}`, email: `GINA.${RUN}@gamma-zztest.example.test` } });
  check('A10', 'same email = a warning naming the client; confirming saves', r.status === 409 && r.body.warning === true && r.body.duplicates[0].id === CG.id, r.body);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: `ZZTEST Delta ${RUN}`, email: `GINA.${RUN}@gamma-zztest.example.test`, confirmDuplicate: true } });
  check('A10', 'confirmed duplicate-warning client saved', r.status === 201, r.body);
  if (r.body && r.body.client) made.clients.push(r.body.client.id);
  r = await call('POST', '/invoice-clients', { token: AC, body: { clientName: `ZZTEST Bad ${RUN}`, gstin: '12345' } });
  check('A10', 'bad GSTIN / format errors in plain words with the field named', r.status === 400 && r.body.field === 'gstin', r.body);
  r = await call('PATCH', `/invoice-clients/${CG.id}`, { token: AC, body: { contactName: 'Gina R', billingAddress: '10 New Lane' } });
  check('A10', 'Accountant can correct a draft client made from Invoices', r.status === 200 && r.body.client.contactName === 'Gina R', r.body);
  r = await call('PATCH', `/invoice-clients/${realClient.id}`, { token: AC, body: { contactName: 'Hacker' } });
  check('A10', 'but NOT an ATS client (403): the ATS rules stay in Clients', r.status === 403, r.body);
  const inv = await call('POST', '/invoices', { token: AC, body: { clientId: CG.id, invoiceDate: today(), amount: 50000, gstApplicable: 'Yes', gstType: 'CGST_SGST', gstPercent: 18, gst: 9000, tdsApplicable: 'Yes', tdsPercent: 10, tdsBase: 'base', tds: 5000 } });
  if (inv.body && inv.body.id) made.invoices.push(inv.body.id);
  check('A10', 'a manual invoice for that client: maths unchanged (50000 + 9000 − 5000)', inv.status === 201 && inv.body.amount === 50000 && inv.body.gst === 9000 && inv.body.tds === 5000 && inv.body.total === 54000 && inv.body.outstanding === 54000, inv.body);
  const bad2 = await call('POST', '/invoices', { token: AC, body: { clientId: CG.id, invoiceDate: today(), amount: 50000, gstApplicable: 'Yes', gstType: 'CGST_SGST', gstPercent: 18, gst: 1 } });
  check('A10', 'a GST amount that disagrees with its % is still refused', bad2.status === 400, bad2.body);
  r = await call('GET', '/invoices', { token: AC });
  check('A10', 'invoice register and filters still load', r.status === 200);
  const atsReq = await call('GET', `/clients/${CG.id}`, { token: A });
  check('A10', 'Admin sees the draft in Clients (to complete it); it is DRAFT there too', atsReq.status === 200 && (atsReq.body.agreementStatus || (atsReq.body.client || {}).agreementStatus) === 'DRAFT', atsReq.status);

  // =================== A11 — audit, DB-level append-only, journal ============
  let blockedUpdate = false; let blockedDelete = false;
  const anyAudit = await prisma.assetAuditLog.findFirst({ where: { vendorId: VA.id } });
  try { await prisma.assetAuditLog.update({ where: { id: anyAudit.id }, data: { action: 'tampered' } }); } catch (e) { blockedUpdate = /append-only/.test(String(e.message)); }
  try { await prisma.assetAuditLog.delete({ where: { id: anyAudit.id } }); } catch (e) { blockedDelete = /append-only/.test(String(e.message)); }
  check('A11', 'DB-level: an audit row cannot be changed (trigger refuses UPDATE)', blockedUpdate);
  check('A11', 'DB-level: an audit row cannot be deleted (trigger refuses DELETE)', blockedDelete);
  const rows = await prisma.assetAuditLog.findMany({ where: { vendorId: VA.id } });
  check('A11', 'audit rows carry who, when, IP, action and old/new values', rows.length > 3 && rows.every((x) => x.actorName && x.createdAt && x.action) && rows.some((x) => x.ip) && rows.some((x) => x.oldValue && x.newValue));
  check('A11', 'no password, token or hash in any audit text', !rows.some((x) => [rawTok, rawTok2, rawTok4, pwA, pwA2].some((sec) => `${x.oldValue}${x.newValue}${x.status}${x.documentName}`.includes(sec)) || /\$2[aby]\$|invite=/.test(`${x.oldValue}${x.newValue}${x.status}`)));
  check('A11', 'the invite token is nowhere in the central audit log either', !(await prisma.auditLog.findFirst({ where: { OR: [{ toValue: { contains: rawTok } }, { toValue: { contains: 'invite=' } }] } })));
  // journal posting
  r = await call('GET', '/vendor-master/journal-posting/status', { token: A });
  check('A11', 'journal posting is OFF by default', r.status === 200 && r.body.enabled === false);
  let jcount = await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: 'vendor-' } } });
  await call('PATCH', `/office-expenses/${eU.body.id}/status`, { token: A, body: { action: 'mark_paid', paymentDate: today() } });
  check('A11', 'while OFF, paying a vendor bill posts nothing to the journal', (await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: 'vendor-' } } })) === jcount);
  r = await call('PUT', '/vendor-master/journal-posting/status', { token: A, body: { enabled: true } });
  check('A11', 'Admin switches posting ON (audited)', r.status === 200 && r.body.enabled === true && !!(await prisma.assetAuditLog.findFirst({ where: { action: 'Vendor journal posting switched on' } })));
  r = await call('POST', '/vendor-master/journal-posting/sync', { token: A, body: {} });
  check('A11', 'catch-up run posts the vendor-linked bills', r.status === 200 && r.body.posted >= 2, r.body);
  const jb = await prisma.journalEntry.findUnique({ where: { idempotencyKey: `vendor-bill:${e1.body.id}` }, include: { lines: true } });
  const jp = await prisma.journalEntry.findUnique({ where: { idempotencyKey: `vendor-pay:${e1.body.id}` }, include: { lines: true } });
  const sum = (j, k) => j.lines.reduce((t, l) => t + l[k], 0);
  const line = (j, code, k) => j.lines.filter((l) => l.accountCode === code).reduce((t, l) => t + l[k], 0);
  check('A11', 'bill entry: Dr expense 10000 + Dr input GST 1800 / Cr vendor payable 11600 + Cr TDS payable 200 (balanced)', jb && line(jb, '5500', 'debit') === 10000 && line(jb, '1400', 'debit') === 1800 && line(jb, '2300', 'credit') === 11600 && line(jb, '2260', 'credit') === 200 && sum(jb, 'debit') === sum(jb, 'credit'), jb && jb.lines.map((l) => `${l.accountCode} ${l.debit}/${l.credit}`));
  check('A11', 'payment entry: Dr vendor payable 11600 / Cr bank 11600', jp && line(jp, '2300', 'debit') === 11600 && line(jp, '1100', 'credit') === 11600, jp && jp.lines.map((l) => `${l.accountCode} ${l.debit}/${l.credit}`));
  check('A11', 'unlinked / free-text bills are NOT posted', !(await prisma.journalEntry.findUnique({ where: { idempotencyKey: `vendor-bill:${e3.body.id}` } })));
  const n1 = await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: 'vendor-' } } });
  await call('POST', '/vendor-master/journal-posting/sync', { token: A, body: {} });
  check('A11', 'posting is idempotent: a second run adds nothing', (await prisma.journalEntry.count({ where: { idempotencyKey: { startsWith: 'vendor-' } } })) === n1);
  const portalRows = await call('GET', '/vendor-portal/invoices', { token: pwTokens.A });
  check('A11', 'the vendor still sees no journal data after posting', !/journal|ledger|debit|credit|5500|2300/i.test(portalRows.text));
  r = await call('PUT', '/vendor-master/journal-posting/status', { token: A, body: { enabled: false } });
  check('A11', 'switch OFF again works', r.body.enabled === false);

  // =================== migration script (copy of the sandbox) ===============
  await migrationChecks(check);

  await cleanup(saved.journal, saved.emails);
  const failed = results.filter((x) => !x.ok);
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

async function migrationChecks(chk) {
  const { execFileSync } = require('child_process');
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')), { readOnly: true });
  const copy = path.join(BACK, 'prisma', `zztest-mig-${RUN}.db`);
  src.exec(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`); src.close();
  const out = path.join(require('os').tmpdir(), `zztest-mig-${RUN}`);
  fs.mkdirSync(out, { recursive: true });
  const run = (extra) => execFileSync(process.execPath, [path.join(BACK, 'scripts', 'vendor-master-migrate.js'), '--db', path.basename(copy), '--out', out, ...extra], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: undefined } });
  try {
    const db = new DatabaseSync(copy);
    // Fixtures that live ONLY in the throw-away copy.
    const ins = db.prepare('INSERT INTO "OfficeExpense" ("id","category","monthlyAmount","vendor","expenseDate","paidStatus","approvalStatus","recurring","gstAmount","tdsAmount","entryKind","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const mkE = (id, v) => ins.run(id, 'Misc', 1000, v, '2026-09-01', 'Unpaid', 'PENDING', 0, 0, 0, 'expense', new Date().toISOString());
    db.exec('DELETE FROM "OfficeExpense" WHERE 1=1; DELETE FROM "VendorBillSubmission"; DELETE FROM "VendorSharedDocument"; DELETE FROM "VendorLoginToken"; DELETE FROM "VendorSession"; DELETE FROM "VendorAssetAccess"; DELETE FROM "VendorUser"; UPDATE "Asset" SET "vendorId" = NULL; DELETE FROM "OfficeVendor";');
    mkE('zm1', 'ZZTEST Migrate Clean'); mkE('zm2', 'zztest migrate clean'); mkE('zm3', 'ZZTEST Acme Traders'); mkE('zm4', 'ZZTEST Acme Traders Pvt Ltd');
    mkE('zm5', 'HDFC Bank'); mkE('zm6', null); mkE('zm7', 'ZZTEST Naukri / LinkedIn');
    db.close();
    const dry = run([]);
    const after1 = new DatabaseSync(copy, { readOnly: true });
    chk('MIG', 'dry run writes nothing (no master rows, no links)', after1.prepare('SELECT COUNT(*) c FROM "OfficeVendor"').get().c === 0 && after1.prepare('SELECT COUNT(*) c FROM "OfficeExpense" WHERE "vendorId" IS NOT NULL').get().c === 0);
    after1.close();
    chk('MIG', 'dry run: case variants are ONE candidate; a bank and blank are "not a vendor"; Pvt Ltd twin and "A / B" go to review', /Would CREATE 1 \|/.test(dry) && /NOT A VENDOR 1/.test(dry) && /NEED ADMIN REVIEW 3/.test(dry) && /blank - no vendor typed\): 1 bill/.test(dry) && /HDFC Bank: 1 bill/.test(dry) && /Same name apart from Pvt/.test(dry) && /TWO vendors/.test(dry), dry);
    const app = run(['--apply']);
    const db2 = new DatabaseSync(copy, { readOnly: true });
    const vend = db2.prepare('SELECT * FROM "OfficeVendor"').all();
    chk('MIG', 'apply: creates only the clear vendor (VEN code, source Migration), links both spellings, review ones untouched', vend.length === 1 && /^VEN-/.test(vend[0].vendorCode) && vend[0].source === 'Migration' && db2.prepare('SELECT COUNT(*) c FROM "OfficeExpense" WHERE "vendorId"=?').get(vend[0].id).c === 2 && db2.prepare('SELECT COUNT(*) c FROM "OfficeExpense" WHERE "vendorId" IS NOT NULL').get().c === 2, vend);
    chk('MIG', 'apply keeps the free-text vendor name on the bill as typed', db2.prepare('SELECT "vendor" v FROM "OfficeExpense" WHERE "id"=\'zm2\'').get().v === 'zztest migrate clean');
    db2.close();
    const bak = fs.readdirSync(path.join(BACK, 'prisma')).filter((f) => f.startsWith(`${path.basename(copy)}.bak-vendor-master-`));
    chk('MIG', 'a full backup copy was made before writing', bak.length === 1);
    const manifest = fs.readdirSync(out).find((f) => f.endsWith('.manifest.json'));
    const undo = run(['--undo', path.join(out, manifest)]);
    const db3 = new DatabaseSync(copy, { readOnly: true });
    chk('MIG', 'undo: vendors removed, bills unlinked, back to the start', /UNDONE: 2 bill\(s\) unlinked, 1 vendor\(s\) removed/.test(undo) && db3.prepare('SELECT COUNT(*) c FROM "OfficeVendor"').get().c === 0 && db3.prepare('SELECT COUNT(*) c FROM "OfficeExpense" WHERE "vendorId" IS NOT NULL').get().c === 0, undo);
    db3.close();
    let refused = false;
    try { execFileSync(process.execPath, [path.join(BACK, 'scripts', 'vendor-master-migrate.js'), '--db', 'dev.db', '--apply', '--out', out], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { refused = e.status === 3; }
    chk('MIG', '--apply on the real dev.db is REFUSED', refused);
    for (const f of fs.readdirSync(path.join(BACK, 'prisma'))) if (f.startsWith(path.basename(copy))) { try { fs.unlinkSync(path.join(BACK, 'prisma', f)); } catch { /* wal */ } }
  } catch (e) {
    chk('MIG', 'migration script ran', false, e.stderr || e.message);
    for (const f of fs.readdirSync(path.join(BACK, 'prisma'))) if (f.startsWith(path.basename(copy))) { try { fs.unlinkSync(path.join(BACK, 'prisma', f)); } catch { /* ignore */ } }
  }
}

async function cleanup(settingBefore, emailsBefore) {
  const ids = (a) => ({ in: a.length ? a : ['__none__'] });
  // break-glass for the append-only audit table: set only for this cleanup
  await prisma.appSetting.upsert({ where: { key: 'audit.allowPurge' }, create: { key: 'audit.allowPurge', value: '1' }, update: { value: '1' } });
  try {
    const vendorIds = (await prisma.officeVendor.findMany({ where: { OR: [{ name: { contains: 'ZZTEST' } }, { id: ids(made.vendors) }] }, select: { id: true } })).map((v) => v.id);
    const logins = (await prisma.vendorUser.findMany({ where: { OR: [{ email: { contains: 'example.test' } }, { vendorId: ids(vendorIds) }] }, select: { id: true } })).map((v) => v.id);
    const docs = await prisma.vendorSharedDocument.findMany({ where: { vendorId: ids(vendorIds) } });
    docs.forEach((d) => attachments.remove(d.file));
    await prisma.vendorSharedDocument.deleteMany({ where: { vendorId: ids(vendorIds) } });
    await prisma.vendorBillSubmission.deleteMany({ where: { vendorId: ids(vendorIds) } });
    await prisma.vendorLoginToken.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorSession.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: ids(logins) } });
    await prisma.vendorUser.deleteMany({ where: { id: ids(logins) } });
    const exps = (await prisma.officeExpense.findMany({ where: { OR: [{ id: ids(made.expenses) }, { vendorId: ids(vendorIds) }, { vendor: { contains: 'ZZTEST' } }] }, select: { id: true } })).map((e) => e.id);
    const je = (await prisma.journalEntry.findMany({ where: { OR: exps.flatMap((id) => [{ idempotencyKey: `vendor-bill:${id}` }, { idempotencyKey: `vendor-pay:${id}` }]) }, select: { id: true } })).map((j) => j.id);
    await prisma.journalLine.deleteMany({ where: { journalEntryId: ids(je) } });
    await prisma.journalEntry.deleteMany({ where: { id: ids(je) } });
    await prisma.officeExpense.deleteMany({ where: { id: ids(exps) } });
    await prisma.officeVendor.deleteMany({ where: { id: ids(vendorIds) } });
    const invs = (await prisma.invoice.findMany({ where: { OR: [{ id: ids(made.invoices) }, { client: { name: { contains: 'ZZTEST' } } }] }, select: { id: true } })).map((i) => i.id);
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: ids(invs) } });
    await prisma.invoice.deleteMany({ where: { id: ids(invs) } });
    const cl = (await prisma.client.findMany({ where: { OR: [{ id: ids(made.clients) }, { name: { contains: 'ZZTEST' } }] }, select: { id: true } })).map((c) => c.id);
    await prisma.clientAlias.deleteMany({ where: { clientId: ids(cl) } }).catch(() => {});
    await prisma.client.deleteMany({ where: { id: ids(cl) } });
    await prisma.assetAuditLog.deleteMany({ where: { OR: [{ vendorId: ids(vendorIds) }, { vendorUserId: ids(logins) }, { actorName: { contains: 'ZZTEST' } }, { changedById: ids(made.users) }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: ids(made.users) }, { entityId: ids([...vendorIds, ...logins, ...exps, ...cl, ...invs]) }, { actorName: { contains: 'ZZTEST' } }, { toValue: { contains: 'ZZTEST' } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: ids(made.users) }, { recipient: { contains: 'example.test' } }] } });
    for (const [key, before] of [['vendor.journalPosting', settingBefore], ['vendorPortal.settings', emailsBefore]]) {
      if (before) await prisma.appSetting.update({ where: { key }, data: { value: before.value, updatedByName: before.updatedByName, updatedById: before.updatedById } }).catch(() => {});
      else await prisma.appSetting.deleteMany({ where: { key } });
    }
    await prisma.user.deleteMany({ where: { id: ids(made.users) } });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: 'audit.allowPurge' } });
  }
  const left = {
    users: await prisma.user.count({ where: { email: { contains: 'zztest.spec' } } }),
    vendors: await prisma.officeVendor.count({ where: { name: { contains: 'ZZTEST' } } }),
    logins: await prisma.vendorUser.count({ where: { email: { contains: 'zztest' } } }),
    expenses: await prisma.officeExpense.count({ where: { vendor: { contains: 'ZZTEST' } } }),
    clients: await prisma.client.count({ where: { name: { contains: 'ZZTEST' } } }),
    audit: await prisma.assetAuditLog.count({ where: { actorName: { contains: 'ZZTEST' } } }),
    breakGlassLeftOn: await prisma.appSetting.count({ where: { key: 'audit.allowPurge' } }),
  };
  console.log('CLEANUP left:', JSON.stringify(left));
  const fail = Object.values(left).some((n) => n > 0);
  results.push({ group: 'CLEAN', name: 'no ZZTEST rows left, break-glass setting removed', ok: !fail });
  console.log(`${fail ? 'FAIL' : 'PASS'}  [CLEAN] no ZZTEST rows left, break-glass setting removed`);
}

main().catch(async (e) => {
  console.error('TEST SCRIPT ERROR', e && e.stack || e);
  try { await cleanup(saved.journal, saved.emails); } catch (c) { console.error('cleanup failed', c && c.message); }
  process.exit(1);
});
