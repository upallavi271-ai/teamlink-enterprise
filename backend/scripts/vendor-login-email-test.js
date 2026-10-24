#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR LOGIN EMAILS TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/vendor-login-email-test.js                       makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/vle-copy.db node scripts/vendor-login-email-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4071, TEST_MODE: the fake mail transport, no timers) on the copy. Every email the app hands to the
// transport is written to a capture file (TEST_MAIL_CAPTURE, utils/sandbox.js) so the test reads the real subject / text / HTML;
// TEST_MAIL_FAIL makes the transport refuse like a real provider. Nothing leaves the machine; addresses are *.example.test.
//
//   A  the switch / set-up problems keep the account and say so plainly (Vendor emails off, Email not set up)
//   B  Create login: account + ONE email; content (branding, name, company, login ID, portal address, link, expiry, support), no password,
//      no raw token in the database / API answers / audit / server log
//   C  double click, API retry, parallel Create = one account, one email (and Idempotency-Key)
//   D  the link: single use, expiry, tampered / short / old, parallel use, weak password keeps the link, login only after activation
//   E  a failure: the account stays, "Failed" with a plain reason, Retry works once (stale / parallel retries send nothing more)
//   F  Resend invitation (only before activation), Send password reset (only after), 409 / 400 rules
//   G  Edit email: waiting = same login + new invitation (old link dead); active = old email works until the new one is confirmed
//   H  Forgot password: no enumeration, rate limits, single use, only activated logins
//   I  who may do what (Admin / Super Admin yes; Accountant, Recruiter, HR, BDE, vendor no - server side)
//   J  accepted vs delivered (the provider's signed delivery report), bounce
//   K  the emails are editable Message templates (Admin only, the secure link cannot be removed)
//   L  audit rows + final sweep for passwords / tokens
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
  copy = path.join(os.tmpdir(), `vle-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4071);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const STARTED = new Date().toISOString(); // the copy may already hold real email rows; only this run's rows are checked
const CAPTURE = path.join(os.tmpdir(), `vle-mail-${RUN}.jsonl`);
const FAILFILE = path.join(os.tmpdir(), `vle-fail-${RUN}.json`);
const BASE = 'https://app.example.test';
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.APP_BASE_URL = BASE;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const MAIL = require(path.join(BACK, 'src/utils/vendorMail'));
const WH = require(path.join(BACK, 'src/outreach/webhook'));

let pass = 0; let fail = 0;
const check = (g, n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const PW = (t) => `Qv#7${t}Lm!${RUN}9`;

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const t0 = Date.now();
  let r;
  try { r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) }); } catch (e) { console.log(`   (request failed after ${Date.now() - t0} ms: ${method} ${p})`); throw e; }
  const text = await r.text();
  if (Date.now() - t0 > 4000) console.log(`   (slow request: ${method} ${p} took ${Date.now() - t0} ms)`);
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const tempOf = (m) => { const x = /Temporary password:\s*(\S+)/.exec(m.text); return x ? x[1] : null; };
const mails = () => (fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const mailsTo = (addr) => mails().filter((m) => m.to.map((x) => x.toLowerCase()).includes(String(addr).toLowerCase()));
const linkOf = (m) => { const x = /https?:\/\/[^\s"<>]*vendor-login\?(invite|verify)=([A-Za-z0-9_-]+)/.exec(m.text); return x ? { url: x[0], kind: x[1], token: x[2] } : null; };
const fail_on = (obj) => fs.writeFileSync(FAILFILE, JSON.stringify(obj));
const fail_off = () => { try { fs.unlinkSync(FAILFILE); } catch { /* none */ } };
async function waitMails(addr, n, ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (mailsTo(addr).length >= n) return true; await sleep(150); }
  return mailsTo(addr).length >= n;
}
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
// Is this text anywhere in these tables? (every text column)
async function dbHas(needle, tables) {
  const hits = [];
  for (const t of tables) {
    const cols = (await raw(`PRAGMA table_info("${t}")`)).map((c) => c.name);
    if (!cols.length) continue; // eslint-disable-line no-continue
    const where = cols.map((c) => `CAST("${c}" AS TEXT) LIKE '%' || ? || '%'`).join(' OR ');
    // eslint-disable-next-line no-await-in-loop
    const n = (await raw(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`, ...cols.map(() => needle)))[0].n;
    if (n) hits.push(t);
  }
  return hits;
}
const TABLES = ['VendorMailLog', 'VendorLoginToken', 'VendorEmailChange', 'AuditLog', 'AssetAuditLog', 'Notification', 'VendorUser', 'AppSetting', 'MessageTemplate', 'MessageTemplateVersion'];

const made = { users: [], vendors: [] };
let stuckMails = 0;
(async () => {
  let server; let serverLog = '';
  try {
    fs.writeFileSync(CAPTURE, '');
    server = spawn(process.execPath, ['src/index.js'], {
      cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), TEST_MAIL_CAPTURE: CAPTURE, TEST_MAIL_FAIL: FAILFILE, APP_BASE_URL: BASE },
    });
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    // ------------------------------------------------------------------ fixtures (the copy only)
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST VLE ${tag} ${RUN}`, email: `zz-vle-${tag}-${RUN}@example.test`, username: `zz-vle-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const uSuper = await mk('super', { role: 'SUPER_ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const uAcc = await mk('acc', { role: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const uRec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uHr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsAccess: true });
    const uBde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsAccess: true, atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, sup: uSuper, acc: uAcc, rec: uRec, hr: uHr, bde: uBde })) T[k] = await tok(u);

    const cnt = async () => {
      const q = {
        OfficeVendor: `SELECT COUNT(*) AS n FROM "OfficeVendor" WHERE "name" NOT LIKE 'ZZTEST VLE%'`,
        VendorUser: `SELECT COUNT(*) AS n FROM "VendorUser" WHERE "email" NOT LIKE 'zz-vle-%'`,
        OfficeExpense: `SELECT COUNT(*) AS n FROM "OfficeExpense" WHERE COALESCE("vendor",'') NOT LIKE 'ZZTEST VLE%'`,
        VendorBillSubmission: 'SELECT COUNT(*) AS n FROM "VendorBillSubmission"',
        VendorModuleBill: `SELECT COUNT(*) AS n FROM "VendorModuleBill" WHERE "billCode" NOT LIKE 'ZZ-%'`,
        VendorSharedDocument: `SELECT COUNT(*) AS n FROM "VendorSharedDocument" WHERE "title" NOT LIKE 'ZZ %'`,
        IdCardOrder: `SELECT COUNT(*) AS n FROM "IdCardOrder" WHERE "orderCode" NOT LIKE 'IDC-ZZ-%'`,
        Asset: 'SELECT COUNT(*) AS n FROM "Asset"', AssetRepair: 'SELECT COUNT(*) AS n FROM "AssetRepair"', Invoice: 'SELECT COUNT(*) AS n FROM "Invoice"', Client: 'SELECT COUNT(*) AS n FROM "Client"',
      };
      const out = {};
      for (const [k, sql] of Object.entries(q)) out[k] = (await raw(sql))[0].n; // eslint-disable-line no-await-in-loop
      return out;
    };
    const countsStart = await cnt();
    const mkVendor = async (tag, extra = {}) => {
      const v = await prisma.officeVendor.create({ data: { name: `ZZTEST VLE Vendor ${tag} ${RUN}`, companyName: `ZZTEST Company ${tag} ${RUN}`, isActive: true, category: 'Internet', ...extra } });
      made.vendors.push(v.id); return v;
    };
    const V1 = await mkVendor('One');
    const V2 = await mkVendor('Two');
    const addr = (t) => `zz-vle-${t}-${RUN}@example.test`;
    const create = (body, token = T.admin, headers) => http('POST', '/api/vendor-logins', token, body, { headers });
    const getRow = async (id) => ((await http('GET', '/api/vendor-logins', T.admin)).body.rows || []).find((r) => r.id === id);
    const vlogin = (email, password) => http('POST', '/api/vendor-portal/login', null, { email, password });

    // Email provider: configured in the COPY only (the fake transport never opens a socket). Vendor emails switch: OFF at first.
    const emailValues = JSON.stringify({ 'SMTP host': 'smtp.example.test', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'From address': 'noreply@teamlink.example.test', 'Default from name': 'TeamLink' });
    await prisma.integration.upsert({ where: { id: 'email' }, update: { enabled: true, connected: true, state: 'Connected', values: emailValues }, create: { id: 'email', enabled: true, connected: true, state: 'Connected', values: emailValues } });
    await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: false }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: false }) } });

    // =============================================================== A  set-up problems
    let r = await http('GET', '/api/vendor-logins', T.admin);
    check('A', 'the list says Vendor emails are off (plain reason, not ready)', r.status === 200 && r.body.mail && r.body.mail.ready === false && r.body.mail.code === 'EMAILS_OFF' && /switched off/i.test(r.body.mail.problem), r.body && r.body.mail);
    const eA = addr('a');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Setup Contact', email: eA });
    const LA = r.body && r.body.login;
    check('A', 'Create with the switch OFF: login saved, invitation Failed with the plain reason, nothing mailed', r.status === 201 && LA && LA.invitation.status === 'failed' && LA.invitation.failCode === 'EMAILS_OFF' && /switched off/i.test(LA.invitation.reason) && mailsTo(eA).length === 0 && r.body.emailed === false, r.body);
    check('A', 'the account is kept: Waiting for activation', LA.accountStatus === 'waiting' && LA.accountText === 'Waiting for activation' && LA.canRetry === true && LA.canResend === true && LA.canSendReset === false, LA);
    check('A', 'email not set up -> a one-time backup link is offered, clearly labelled (and it really is a link)', typeof r.body.inviteLink === 'string' && /vendor-login\?invite=/.test(r.body.inviteLink) && /not set up/i.test(r.body.backupLinkNote), Object.keys(r.body));
    const backupToken = decodeURIComponent(String(r.body.inviteLink).split('invite=')[1]);
    r = await http('GET', '/api/vendor-logins', T.admin);
    check('A', 'the backup link is NOT in the list afterwards (shown once)', !r.text.includes(backupToken), 'token found');
    r = await http('PUT', '/api/vendor-logins/settings', T.admin, { emailsEnabled: true, supportEmail: 'support@teamlink.example.test', supportPhone: '+91 90000 00000' });
    check('A', 'Admin switches Vendor emails on and sets the support contact', r.status === 200 && r.body.emailsEnabled === true && r.body.supportEmail === 'support@teamlink.example.test', r.body);
    r = await http('PUT', '/api/vendor-logins/settings', T.admin, { supportEmail: 'not an email' });
    check('A', 'a wrong support email is refused', r.status === 400, r.body);
    // Email provider switched off in Integrations -> "Email is not set up"
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: false } });
    const eA2 = addr('a2');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Setup Two', email: eA2 });
    check('A', 'Email (SMTP) not set up -> Invitation Failed "Email is not set up", account preserved, nothing mailed', r.status === 201 && r.body.login.invitation.failCode === 'NOT_SET_UP' && /Email is not set up/.test(r.body.login.invitation.reason) && mailsTo(eA2).length === 0 && !!(await prisma.vendorUser.findUnique({ where: { email: eA2 } })), r.body.login && r.body.login.invitation);
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: true } });
    r = await http('POST', `/api/vendor-logins/${r.body.login.id}/invitation/retry`, T.admin, {});
    check('A', 'the Admin fixes the set-up and presses Retry: ONE email goes out', r.status === 200 && r.body.emailed === true && mailsTo(eA2).length === 1 && r.body.login.invitation.status === 'sent', r.body);
    r = await http('GET', '/api/vendor-logins', T.admin);
    check('A', 'readiness now reads ready (test mode shown honestly)', r.body.mail.ready === true && r.body.mail.testMode === true && r.body.mail.portalUrl === `${BASE}/vendor-login`, r.body.mail);
    // the first (failed) login of this group: retry too
    r = await http('POST', `/api/vendor-logins/${LA.id}/invitation/retry`, T.admin, { attemptId: LA.invitation.id });
    check('A', 'the first login (failed while the switch was off) is mailed by Retry', r.status === 200 && mailsTo(eA).length === 1, r.body);

    // =============================================================== B  create + content
    const eB = addr('b');
    const CONTACT = "ZZTEST Anita O'Neil & Sons";
    const before = mails().length;
    r = await create({ vendorId: V1.id, name: CONTACT, email: eB });
    const LB = r.body && r.body.login;
    check('B', 'Create login answers 201 with the login and an honest invitation state', r.status === 201 && LB && LB.id && r.body.created === true && r.body.emailed === true && LB.invitation.status === 'sent' && /Test mode/i.test(LB.invitation.text), r.body);
    check('B', 'exactly ONE email, to the vendor\'s registered email', mails().length === before + 1 && mailsTo(eB).length === 1, mails().length - before);
    const mB = mailsTo(eB)[0];
    const linkB = linkOf(mB);
    check('B', 'subject carries the TeamLink Consultants brand; sender name is the brand; Reply-To is the support contact', /TeamLink Consultants/.test(mB.subject) && /TeamLink Consultants/.test(mB.from) && /support@teamlink\.example\.test/.test(mB.replyTo), { s: mB.subject, f: mB.from, rt: mB.replyTo });
    check('B', 'text: vendor name, company, login ID, Vendor Portal URL, secure link, expiry (3 days) and the support contact', mB.text.includes(CONTACT) && mB.text.includes(V1.name) && mB.text.includes(eB) && mB.text.includes(`${BASE}/vendor-login`) && !!linkB && /3 days/.test(mB.text) && /stop working on/.test(mB.text) && /support@teamlink\.example\.test/.test(mB.text) && /\+91 90000 00000/.test(mB.text), mB.text);
    check('B', 'text: instructions to set the password and sign in; "ignore it if you did not expect this"', /set your own password/i.test(mB.text) && /sign in/i.test(mB.text) && /did not expect this email/i.test(mB.text) && /never send a permanent password/i.test(mB.text));
    check('B', 'the link is absolute, from the configured address, and the token is a 43-character random value', !!linkB && linkB.url.startsWith(`${BASE}/vendor-login?invite=`) && linkB.token.length === 43, linkB && linkB.url);
    check('B', 'HTML twin: brand header, button, the plain address under it, support, escaped special characters', /TeamLink Consultants/.test(mB.html) && /Set my password/.test(mB.html) && mB.html.includes(linkB.url) && /mailto:support@teamlink\.example\.test/.test(mB.html), mB.html.slice(0, 400));
    check('B', 'HTML: the ampersand in the name is escaped, no raw script', mB.html.includes('&amp; Sons') && !/<script/i.test(mB.html), mB.html.slice(0, 300));
    const tempB = tempOf(mB);
    check('B', 'the email shows the LOGIN ID, a TEMPORARY password (12 readable characters, no look-alikes) and the secure link', mB.text.includes(`Your login ID: ${eB}`) && !!tempB && tempB.length === 12 && !/[0O1lI]/.test(tempB) && /[A-Z]/.test(tempB) && /[a-z]/.test(tempB) && /\d/.test(tempB) && /[^A-Za-z0-9]/.test(tempB) && !!linkB, [tempB, mB.text]);
    check('B', 'the email says it is temporary, that you choose your own, and offers the link as the other way (Option 1 / Option 2)', /Temporary password:/.test(mB.text) && /Option 1/.test(mB.text) && /Option 2/.test(mB.text) && /Forgot password/i.test(mB.text) && /never send a permanent password/i.test(mB.text), mB.text);
    check('B', 'the HTML shows the temporary password in its own highlighted box', mB.html.includes(tempB.replace(/&/g, '&amp;')) && /Consolas/.test(mB.html));
    const rowB = (await raw('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?', LB.id));
    check('B', 'the log keeps the attempt: accepted (time set), delivery NOT claimed, test mode noted, provider reference stored', rowB.length === 1 && rowB[0].status === 'accepted' && !!rowB[0].acceptedAt && rowB[0].deliveredAt === null && rowB[0].mode === 'test' && !!rowB[0].providerRef && rowB[0].kind === 'invite' && rowB[0].attemptNo === 1, rowB);
    check('B', 'the log row holds no link, no token and no body', !JSON.stringify(rowB).includes(linkB.token) && !('body' in rowB[0]) && !('text' in rowB[0]));
    const tokRows = await prisma.vendorLoginToken.findMany({ where: { vendorUserId: LB.id } });
    check('B', 'only the sha256 of the token is stored; the token row is the one linked from the log', tokRows.length === 1 && tokRows[0].tokenHash === sha(linkB.token) && tokRows[0].purpose === 'invite' && rowB[0].tokenId === tokRows[0].id, tokRows);
    const exp = new Date(tokRows[0].expiresAt).getTime() - Date.now();
    check('B', 'the invitation link expires in about 72 hours', exp > 71.5 * 3600000 && exp < 72.1 * 3600000, exp / 3600000);
    const hits = await dbHas(linkB.token, TABLES);
    check('B', 'the raw token is in NO table (token / log / audit / notification / settings)', hits.length === 0, hits);
    const userRow = await prisma.vendorUser.findUnique({ where: { id: LB.id } });
    check('B', 'only the bcrypt HASH of the temporary password is stored (it checks out), it must be changed at first sign-in, and it expires with the invitation (~72 h)', /^\$2[aby]\$/.test(userRow.passwordHash) && bcrypt.compareSync(tempB, userRow.passwordHash) && userRow.mustChangePassword === true && !userRow.passwordChangedAt && Math.abs(new Date(userRow.tempPasswordExpiresAt).getTime() - new Date(tokRows[0].expiresAt).getTime()) < 2000, [userRow.tempPasswordExpiresAt, tokRows[0].expiresAt]);
    check('B', 'the create answer has no token, no hash, no password field and not the temporary password', !r.text.includes(linkB.token) && !r.text.includes(tempB) && !/"passwordHash"|"tokenHash"|"password"|"tempPassword"/.test(r.text), Object.keys(r.body));
    r = await http('GET', '/api/vendor-logins', T.admin);
    const rowList = r.body.rows.find((x) => x.id === LB.id);
    check('B', 'the Admin list shows Invitation + Account status columns', rowList && rowList.invitation.status === 'sent' && rowList.accountStatus === 'waiting' && rowList.accountText === 'Waiting for activation' && rowList.emailConfirmed === false, rowList && [rowList.invitation, rowList.accountStatus]);
    check('B', 'the list never carries a token or a link', !r.text.includes(linkB.token) && !/vendor-login\?invite=/.test(r.text));
    const lg = await vlogin(eB, 'Anything!1234');
    check('B', 'a wrong password for this login ID still gets the generic answer', lg.status === 401 && lg.body.error === 'Invalid credentials.', lg.body);
    check('B', 'the login ID is the vendor email (the app\'s existing rule), stored in lower case', userRow.email === eB.toLowerCase());
    const audB = await prisma.assetAuditLog.findMany({ where: { vendorUserId: LB.id } });
    const actsB = audB.map((a) => a.action);
    check('B', 'audit (vendor history): login created + welcome email accepted, with who and when', actsB.includes('Vendor login created') && actsB.includes('Welcome email accepted by the mail server') && audB.every((a) => a.actorName), actsB);
    const audB2 = await prisma.auditLog.findMany({ where: { entityId: LB.id } });
    check('B', 'audit (central log): the same events, no link inside', audB2.some((a) => /Welcome email accepted/.test(a.action)) && !JSON.stringify(audB2).includes(linkB.token));
    const bells = await prisma.notification.findMany({ where: { recipient: eB } });
    check('B', 'the email is also noted in Administration > Notifications (channel Email, status, no body)', bells.length === 1 && bells[0].channel === 'Email' && bells[0].status === 'Sent' && !JSON.stringify(bells).includes(linkB.token), bells);

    // =============================================================== C  duplicates
    const nUsers0 = await prisma.vendorUser.count({ where: { email: eB } });
    r = await create({ vendorId: V1.id, name: CONTACT, email: eB });
    check('C', 'Create again (same vendor, same email) returns the SAME login: 200, created false, no second account', r.status === 200 && r.body.created === false && r.body.duplicate === true && r.body.login.id === LB.id && (await prisma.vendorUser.count({ where: { email: eB } })) === nUsers0, r.body);
    check('C', '...and no second email', mailsTo(eB).length === 1);
    r = await create({ vendorId: V1.id, name: CONTACT, email: eB.toUpperCase() });
    check('C', 'the same email in capitals is the same login too', r.status === 200 && r.body.login.id === LB.id && mailsTo(eB).length === 1, r.body);
    r = await create({ vendorId: V2.id, name: 'ZZTEST Other', email: eB });
    check('C', 'the same email for ANOTHER vendor is refused (the database also has a unique email)', r.status === 400 && /already uses this email/i.test(r.body.error), r.body);
    const eC = addr('c');
    const par = await Promise.all(Array.from({ length: 6 }, () => create({ vendorId: V1.id, name: 'ZZTEST Parallel', email: eC })));
    const codes = par.map((x) => x.status).sort().join(',');
    check('C', 'six Create presses at the same moment: ONE account', (await prisma.vendorUser.count({ where: { email: eC } })) === 1 && par.every((x) => [200, 201].includes(x.status)) && par.filter((x) => x.status === 201).length === 1, [codes, par.map((x) => (x.body && x.body.error) || x.text.slice(0, 100))]);
    await sleep(300);
    check('C', '...and ONE welcome email, ONE attempt row', mailsTo(eC).length === 1 && (await raw('SELECT * FROM "VendorMailLog" WHERE "toEmail" = ?', eC)).length === 1, mailsTo(eC).length);
    r = await http('POST', '/api/vendor-logins', T.admin, { vendorId: V1.id, name: 'ZZTEST Key', email: addr('c2') }, { headers: { 'Idempotency-Key': 'bad key!' } });
    check('C', 'a malformed Idempotency-Key is refused', r.status === 400, r.body);
    const eC3 = addr('c3');
    const k1 = await create({ vendorId: V1.id, name: 'ZZTEST Key Two', email: eC3 }, T.admin, { 'Idempotency-Key': `key-${RUN}-0001` });
    const k2 = await create({ vendorId: V1.id, name: 'ZZTEST Key Two', email: eC3 }, T.admin, { 'Idempotency-Key': `key-${RUN}-0001` });
    check('C', 'the same Idempotency-Key twice: one account, one email', k1.status === 201 && k2.status === 200 && k2.body.login.id === k1.body.login.id && mailsTo(eC3).length === 1);
    check('C', 'DB level: a second login row with the same email cannot exist', await prisma.vendorUser.create({ data: { vendorId: V1.id, name: 'x', email: eB, passwordHash: 'x' } }).then(() => false, (e) => e.code === 'P2002'));
    check('C', 'DB level: a second log row with the same attempt key cannot exist', await raw('INSERT INTO "VendorMailLog" ("id","vendorUserId","kind","attemptNo","dedupeKey","toEmail","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)', `x${RUN}`, LB.id, 'invite', 9, rowB[0].dedupeKey, eB, new Date().toISOString(), new Date().toISOString()).then(() => false, () => true));

    // =============================================================== D  the link
    r = await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkB.token)}`);
    check('D', 'opening the link shows who it is for: company, name, login ID (no secrets)', r.status === 200 && r.body.valid && r.body.vendorName === V1.name && r.body.loginId === eB && r.body.name === CONTACT && !/hash|token/i.test(JSON.stringify(Object.keys(r.body))), r.body);
    const tamper = linkB.token.slice(0, -1) + (linkB.token.endsWith('A') ? 'B' : 'A');
    r = await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(tamper)}`);
    check('D', 'a tampered link is refused (404, same words as an unknown one)', r.status === 404 && /not valid or has expired/i.test(r.body.error), r.body);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: tamper, newPassword: PW('a'), confirmPassword: PW('a') });
    check('D', 'a tampered link cannot set a password', r.status === 400 && r.body.linkProblem === true, r.body);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: 'short', newPassword: PW('a'), confirmPassword: PW('a') });
    check('D', 'a too-short token is refused', r.status === 400, r.body);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkB.token, newPassword: 'weak', confirmPassword: 'weak' });
    check('D', 'a weak password is refused with the vendor rules and the link stays valid', r.status === 400 && r.body.field === 'newPassword' && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkB.token)}`)).status === 200, r.body);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkB.token, newPassword: PW('b1'), confirmPassword: PW('b2') });
    check('D', 'two different passwords are refused', r.status === 400 && r.body.field === 'confirmPassword', r.body);
    const pwB = PW('Bee');
    const accs = await Promise.all([1, 2, 3].map(() => http('POST', '/api/vendor-portal/invite/accept', null, { token: linkB.token, newPassword: pwB, confirmPassword: pwB })));
    check('D', 'three parallel uses of the link: exactly ONE wins', accs.filter((x) => x.status === 200).length === 1 && accs.filter((x) => x.status === 400).length === 2, accs.map((x) => x.status));
    const win = accs.find((x) => x.status === 200);
    check('D', 'activation signs the vendor in (token) with no password in the answer', !!win.body.token && !win.text.includes(pwB), Object.keys(win.body));
    r = await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkB.token)}`);
    check('D', 'the used link is dead (single use)', r.status === 404);
    r = await vlogin(eB, pwB);
    check('D', 'after activation the vendor signs in with login ID + password', r.status === 200 && !!r.body.token && r.body.vendor.mustChangePassword === false, r.body);
    r = await vlogin(eB, 'Wrong!pass12345');
    check('D', 'a wrong password still fails', r.status === 401);
    const after = await prisma.vendorUser.findUnique({ where: { id: LB.id } });
    check('D', 'the chosen password is stored with the app\'s own bcrypt hash, never in clear', /^\$2[aby]\$/.test(after.passwordHash) && !!after.passwordChangedAt && after.mustChangePassword === false && (await dbHas(pwB, TABLES)).length === 0, (await dbHas(pwB, TABLES)));
    let rowAfter = await getRow(LB.id);
    check('D', 'Admin list now: Account Active, Invitation Used, email confirmed', rowAfter.accountStatus === 'active' && rowAfter.invitation.status === 'used' && rowAfter.invitation.text === 'Used' && rowAfter.emailConfirmed === true, [rowAfter.accountStatus, rowAfter.invitation]);
    // expiry
    const eD = addr('d');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Expiry', email: eD });
    const LD = r.body.login; const linkD = linkOf(mailsTo(eD)[0]);
    await prisma.vendorLoginToken.update({ where: { tokenHash: sha(linkD.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    r = await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkD.token)}`);
    check('D', 'an expired link is refused', r.status === 404);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkD.token, newPassword: PW('d'), confirmPassword: PW('d') });
    check('D', 'an expired link cannot set a password', r.status === 400 && r.body.linkProblem === true);
    rowAfter = await getRow(LD.id);
    check('D', 'the Admin list says Expired, and offers Resend', rowAfter.invitation.status === 'expired' && rowAfter.invitation.text === 'Expired' && rowAfter.canResend === true, rowAfter.invitation);

    // =============================================================== E  failure + retry
    const eE = addr('e');
    fail_on({ message: '550 5.1.1 mailbox unavailable', responseCode: 550 });
    r = await create({ vendorId: V1.id, name: 'ZZTEST Failure', email: eE });
    const LE = r.body.login;
    check('E', 'the mail server refuses: login KEPT, 201, Invitation Failed with a plain reason', r.status === 201 && LE.invitation.status === 'failed' && LE.invitation.text === 'Failed' && /did not accept the email/i.test(LE.invitation.reason) && r.body.emailed === false && mailsTo(eE).length === 0, r.body);
    check('E', 'no backup link for a mail-server error (only when email is not set up)', !r.body.inviteLink && !/vendor-login\?invite=/.test(r.text));
    const failedRow = (await raw('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?', LE.id))[0];
    check('E', 'the log keeps the provider\'s words (no link), status failed, code REJECTED', failedRow.status === 'failed' && failedRow.failCode === 'REJECTED' && /550/.test(failedRow.providerDetail) && failedRow.acceptedAt === null && !!failedRow.failedAt, failedRow);
    check('E', 'the account exists exactly once', (await prisma.vendorUser.count({ where: { email: eE } })) === 1);
    fail_on({ message: 'connect ETIMEDOUT', code: 'ETIMEDOUT' });
    r = await http('POST', `/api/vendor-logins/${LE.id}/invitation/retry`, T.admin, { attemptId: LE.invitation.id });
    check('E', 'a timeout reads "could not be reached just now" (code TEMPORARY), second attempt recorded', r.status === 200 && r.body.login.invitation.failCode === 'TEMPORARY' && /could not be reached/i.test(r.body.login.invitation.reason) && r.body.login.invitation.attemptNo === 2, r.body.login && r.body.login.invitation);
    const stale = r.body.login.invitation;
    fail_off();
    // the SAME retry request twice (same Idempotency-Key = a network retry / double submit): ONE email
    const rt = await Promise.all([1, 2].map(() => http('POST', `/api/vendor-logins/${LE.id}/invitation/retry`, T.admin, { attemptId: stale.id }, { headers: { 'Idempotency-Key': `retry-${RUN}-same` } })));
    await sleep(300);
    check('E', 'the same Retry request twice (same key): ONE email goes out', mailsTo(eE).length === 1 && rt.some((x) => x.body && x.body.emailed === true), rt.map((x) => x.status));
    check('E', '...and the repeat is told "nothing was sent again" (no error)', rt.every((x) => x.status === 200) && rt.some((x) => x.body.duplicate === true), rt.map((x) => x.body && x.body.message));
    // FOUNDER RULE: a deliberate click is a NEW attempt, a NEW email, even when the last one worked
    r = await http('POST', `/api/vendor-logins/${LE.id}/invitation/retry`, T.admin, {}, { headers: { 'Idempotency-Key': `retry-${RUN}-new1` } });
    check('E', 'a deliberate Retry click after a success still sends a new email (not swallowed)', r.status === 200 && r.body.emailed === true && mailsTo(eE).length === 2 && !r.body.duplicate, [r.status, mailsTo(eE).length, r.body.message]);
    const rowsE = await raw('SELECT "attemptNo","status" FROM "VendorMailLog" WHERE "vendorUserId" = ? ORDER BY "attemptNo"', LE.id);
    check('E', 'attempts are numbered 1 (refused), 2 (timeout), 3 (accepted), 4 (accepted); never skipped, never repeated', rowsE.length === 4 && rowsE[0].status === 'failed' && rowsE[1].status === 'failed' && rowsE[2].status === 'accepted' && rowsE[3].status === 'accepted' && rowsE.map((x) => x.attemptNo).join() === '1,2,3,4', rowsE);
    const linkE = linkOf(mailsTo(eE)[1]);
    check('E', 'only the newest link works; the older mail\'s link is dead', !!linkE && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkE.token)}`)).status === 200 && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkOf(mailsTo(eE)[0]).token)}`)).status === 404);
    check('E', 'the server log never shows the link or token', !serverLog.includes(linkE.token) && !serverLog.includes(linkB.token) && !serverLog.includes('vendor-login?invite='));
    // stale "sending" row (the server died mid-send) -> Failed, retry allowed
    const eE2 = addr('e2');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Stuck', email: eE2 });
    await raw('UPDATE "VendorMailLog" SET "status" = \'sending\', "createdAt" = ?, "acceptedAt" = NULL WHERE "vendorUserId" = ?', new Date(Date.now() - 10 * 60000).toISOString(), r.body.login.id);
    stuckMails += 1; // this one email WAS handed to the transport; the test then rewrote its row to look interrupted
    rowAfter = await getRow(r.body.login.id);
    check('E', 'an attempt stuck in "sending" for minutes shows Failed (interrupted) and can be retried', rowAfter.invitation.status === 'failed' && rowAfter.invitation.failCode === 'INTERRUPTED' && rowAfter.canRetry === true, rowAfter.invitation);

    // =============================================================== F  resend / reset rules
    const eF = addr('f');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Resend', email: eF });
    const LF = r.body.login; const link1 = linkOf(mailsTo(eF)[0]);
    r = await http('POST', `/api/vendor-logins/${LF.id}/resend-invitation`, T.admin, {});
    check('F', 'Resend invitation (not activated yet): a NEW email with a NEW link', r.status === 200 && r.body.emailed === true && mailsTo(eF).length === 2 && r.body.login.invitation.attemptNo === 2, r.body);
    const link2 = linkOf(mailsTo(eF)[1]);
    check('F', 'the old link is dead, the new one works', link2.token !== link1.token && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(link1.token)}`)).status === 404 && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(link2.token)}`)).status === 200);
    const dbl = await Promise.all([1, 2].map(() => http('POST', `/api/vendor-logins/${LF.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `resend-${RUN}-1` } })));
    await sleep(300);
    check('F', 'a double click on Resend (same key): only ONE more email', mailsTo(eF).length === 3 && dbl.every((x) => x.status === 200), mailsTo(eF).length);
    r = await http('POST', `/api/vendor-logins/${LF.id}/send-reset`, T.admin, {});
    check('F', 'Send password reset on a login that has NOT activated: refused (409)', r.status === 409 && r.body.code === 'NOT_ACTIVE_YET', r.body);
    const link3 = linkOf(mailsTo(eF)[2]);
    const pwF = PW('Eff');
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: link3.token, newPassword: pwF, confirmPassword: pwF });
    check('F', 'the vendor activates through the newest link', r.status === 200);
    r = await http('POST', `/api/vendor-logins/${LF.id}/resend-invitation`, T.admin, {});
    check('F', 'Resend invitation on an ACTIVATED login: 409, nothing sent', r.status === 409 && r.body.code === 'ALREADY_ACTIVE' && mailsTo(eF).length === 3, r.body);
    r = await http('POST', `/api/vendor-logins/${LF.id}/invitation/retry`, T.admin, {});
    check('F', 'Retry on an ACTIVATED login: 409 too', r.status === 409);
    r = await http('GET', '/api/vendor-logins', T.admin);
    const rowF = r.body.rows.find((x) => x.id === LF.id);
    check('F', 'for an activated login the list offers Send password reset, not an invitation (canResend off, canSendReset on)', rowF.canSendReset === true && rowF.canResend === false && rowF.accountStatus === 'active', [rowF.canSendReset, rowF.canResend, rowF.accountStatus]);
    r = await http('POST', `/api/vendor-logins/${LF.id}/invite`, T.admin, {});
    check('F', 'the older single button on an activated login now sends a reset (one email)', r.status === 200 && mailsTo(eF).length === 4, r.status);
    const resetLink0 = linkOf(mailsTo(eF)[3]);
    check('F', 'that email is the reset wording with a link that lasts about 24 hours', /reset/i.test(mailsTo(eF)[3].subject) && !!resetLink0 && resetLink0.kind === 'invite');
    r = await http('POST', `/api/vendor-logins/${LF.id}/send-reset`, T.admin, {});
    check('F', 'Send password reset (active): 200, ONE email, login keeps working meanwhile', r.status === 200 && r.body.emailed === true && mailsTo(eF).length === 5 && (await vlogin(eF, pwF)).status === 200, r.body);
    const rl = linkOf(mailsTo(eF)[4]);
    check('F', 'the reset email says "reset", has the login ID, the portal URL and the link; no password', /reset/i.test(mailsTo(eF)[4].subject) && mailsTo(eF)[4].text.includes(eF) && mailsTo(eF)[4].text.includes(`${BASE}/vendor-login`) && !!rl && !/password\s*[:=]\s*\S+/i.test(mailsTo(eF)[4].text));
    check('F', 'the earlier reset link died when the newer one was made', (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(resetLink0.token)}`)).status === 404);
    const pwF2 = PW('Eff2');
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: rl.token, newPassword: pwF2, confirmPassword: pwF2 });
    check('F', 'the reset link sets a new password once; the old password stops working, the new one works', r.status === 200 && (await vlogin(eF, pwF)).status === 401 && (await vlogin(eF, pwF2)).status === 200);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: rl.token, newPassword: PW('Eff3'), confirmPassword: PW('Eff3') });
    check('F', 'the used reset link cannot be used again', r.status === 400);
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkOf(mailsTo(eF)[0]).token, newPassword: PW('Eff4'), confirmPassword: PW('Eff4') });
    check('F', 'an old invitation link cannot be used after activation', r.status === 400);
    // switched off
    const eF2 = addr('f2');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Off', email: eF2, status: 'Inactive' });
    check('F', 'a login created switched off gets no email and says why; Resend is refused until it is switched on', r.status === 201 && mailsTo(eF2).length === 0 && /switched off/i.test(r.body.login.invitation.reason), r.body.login && r.body.login.invitation);
    r = await http('POST', `/api/vendor-logins/${r.body.login.id}/resend-invitation`, T.admin, {});
    check('F', '...Resend on a switched-off login: 400', r.status === 400 && mailsTo(eF2).length === 0, r.body);

    // =============================================================== G  edit email
    const eG = addr('g'); const eG2 = addr('g2');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Edit Waiting', email: eG });
    const LG = r.body.login; const gOld = linkOf(mailsTo(eG)[0]);
    const countBefore = await prisma.vendorUser.count({ where: { vendorId: V1.id } });
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG2.toUpperCase() });
    check('G', 'edit the email of a WAITING login: same account, new address (lower-cased), no duplicate account', r.status === 200 && r.body.login.id === LG.id && r.body.login.email === eG2 && (await prisma.vendorUser.count({ where: { vendorId: V1.id } })) === countBefore && (await prisma.vendorUser.count({ where: { email: eG } })) === 0, r.body);
    await sleep(200);
    check('G', 'the NEW address gets a new invitation (login ID = the new email); the old address gets nothing more', mailsTo(eG2).length === 1 && mailsTo(eG).length === 1 && mailsTo(eG2)[0].text.includes(eG2) && !mailsTo(eG2)[0].text.includes(eG));
    check('G', 'the old link is dead and the new one works', (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(gOld.token)}`)).status === 404 && (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(linkOf(mailsTo(eG2)[0]).token)}`)).status === 200);
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eB });
    check('G', 'an email that another login already uses is refused', r.status === 400 && /already uses/i.test(r.body.error), r.body);
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: 'nope' });
    check('G', 'a malformed email is refused', r.status === 400, r.body);
    const histG = await http('GET', `/api/vendor-logins/${LG.id}/emails`, T.admin);
    check('G', 'the email history lists both attempts (status only, no link)', histG.status === 200 && histG.body.rows.length === 2 && histG.body.rows.every((x) => x.toEmail) && !/invite=/.test(histG.text), histG.body.rows && histG.body.rows.length);
    // active vendor: change needs the vendor's confirmation
    const pwG = PW('Gee');
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkOf(mailsTo(eG2)[0]).token, newPassword: pwG, confirmPassword: pwG });
    check('G', '(the edited login is activated by the vendor)', r.status === 200);
    const eG3 = addr('g3');
    const nMailsOld = mailsTo(eG2).length;
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG3 });
    check('G', 'edit the email of an ACTIVE login: the login email does NOT change yet', r.status === 200 && r.body.login.email === eG2 && r.body.emailChange === 'active', r.body);
    await sleep(200);
    const vm = mailsTo(eG3);
    check('G', 'a confirmation email goes to the NEW address only (verify link, new address named, old email named)', vm.length === 1 && mailsTo(eG2).length === nMailsOld && /confirm/i.test(vm[0].subject) && vm[0].text.includes(eG3) && vm[0].text.includes(eG2) && linkOf(vm[0]) && linkOf(vm[0]).kind === 'verify', vm.map((x) => x.subject));
    r = await http('GET', '/api/vendor-logins', T.admin);
    const rowG = r.body.rows.find((x) => x.id === LG.id);
    check('G', 'Admin sees "waiting for the vendor to confirm" with the new address; the old email is still the login', rowG.pendingEmail && rowG.pendingEmail.newEmail === eG3 && rowG.email === eG2 && rowG.pendingEmail.expired === false, rowG.pendingEmail);
    check('G', 'the OLD email keeps working for sign-in until the new one is confirmed', (await vlogin(eG2, pwG)).status === 200 && (await vlogin(eG3, pwG)).status === 401);
    const verTok = linkOf(vm[0]).token;
    check('G', 'only the sha256 of the verify token is stored', (await raw('SELECT * FROM "VendorEmailChange" WHERE "vendorUserId" = ?', LG.id)).every((x) => x.tokenHash === sha(verTok) || x.status !== 'pending') && (await dbHas(verTok, TABLES)).length === 0);
    r = await http('GET', `/api/vendor-portal/email/verify/${encodeURIComponent(verTok)}`);
    check('G', 'opening the verify link shows the new address and a masked old one', r.status === 200 && r.body.newEmail === eG3 && /\*/.test(r.body.currentEmail) && !r.body.currentEmail.includes(eG2), r.body);
    // a second change replaces the first
    const eG4 = addr('g4');
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG4 });
    await sleep(200);
    check('G', 'a newer change replaces the older one: the first verify link is dead', r.status === 200 && (await http('GET', `/api/vendor-portal/email/verify/${encodeURIComponent(verTok)}`)).status === 404 && mailsTo(eG4).length === 1);
    r = await http('POST', `/api/vendor-logins/${LG.id}/email-change/cancel`, T.admin, {});
    check('G', 'Admin can cancel the waiting change; its link dies', r.status === 200 && r.body.login.pendingEmail === null && (await http('GET', `/api/vendor-portal/email/verify/${encodeURIComponent(linkOf(mailsTo(eG4)[0]).token)}`)).status === 404, r.body);
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG4 });
    await sleep(200);
    const vTok2 = linkOf(mailsTo(eG4)[1]).token;
    const confs = await Promise.all([1, 2].map(() => http('POST', '/api/vendor-portal/email/verify/confirm', null, { token: vTok2 })));
    check('G', 'confirming (two clicks at once): exactly ONE wins, the login ID becomes the new email', confs.filter((x) => x.status === 200).length === 1 && (await prisma.vendorUser.findUnique({ where: { id: LG.id } })).email === eG4, confs.map((x) => x.status));
    check('G', 'after confirming: the new email signs in with the SAME password; the old one no longer does', (await vlogin(eG4, pwG)).status === 200 && (await vlogin(eG2, pwG)).status === 401);
    check('G', 'the confirm link is single use', (await http('POST', '/api/vendor-portal/email/verify/confirm', null, { token: vTok2 })).status === 400);
    check('G', 'still ONE account for this vendor contact (no duplicate was ever made)', (await prisma.vendorUser.count({ where: { id: LG.id } })) === 1 && (await prisma.vendorUser.count({ where: { name: 'ZZTEST Edit Waiting' } })) === 1);
    // expired verify + taken in the meantime
    const eG5 = addr('g5');
    r = await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG5 });
    await sleep(200);
    const vTok3 = linkOf(mailsTo(eG5)[0]).token;
    await raw('UPDATE "VendorEmailChange" SET "expiresAt" = ? WHERE "tokenHash" = ?', new Date(Date.now() - 1000).toISOString(), sha(vTok3));
    check('G', 'an expired confirm link is refused', (await http('POST', '/api/vendor-portal/email/verify/confirm', null, { token: vTok3 })).status === 400);
    rowAfter = await getRow(LG.id);
    check('G', '...and Admin sees the pending change as expired', rowAfter.pendingEmail && rowAfter.pendingEmail.expired === true, rowAfter.pendingEmail);
    const eG6 = addr('g6');
    await http('PATCH', `/api/vendor-logins/${LG.id}`, T.admin, { email: eG6 });
    await sleep(200);
    const vTok4 = linkOf(mailsTo(eG6)[0]).token;
    await create({ vendorId: V2.id, name: 'ZZTEST Took It', email: eG6 });
    const tk = await http('POST', '/api/vendor-portal/email/verify/confirm', null, { token: vTok4 });
    check('G', 'if another login took the new email meanwhile, confirming is refused (409) and nothing changes', tk.status === 409 && (await prisma.vendorUser.findUnique({ where: { id: LG.id } })).email === eG4, tk.body);

    // =============================================================== H  forgot password
    const eH = addr('h');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Forgetful', email: eH });
    const LH = r.body.login; const hInv = linkOf(mailsTo(eH)[0]);
    const pwH = PW('Aitch');
    await http('POST', '/api/vendor-portal/invite/accept', null, { token: hInv.token, newPassword: pwH, confirmPassword: pwH });
    const ipH = '10.77.0.1';
    const f1 = await http('POST', '/api/vendor-portal/forgot-password', null, { email: eH }, { ip: ipH });
    const f2 = await http('POST', '/api/vendor-portal/forgot-password', null, { email: `nobody-${RUN}@example.test` }, { ip: ipH });
    const f3 = await http('POST', '/api/vendor-portal/forgot-password', null, { email: 'not-an-email' }, { ip: ipH });
    check('H', 'NO enumeration: a known email, an unknown email and garbage get the identical answer', f1.status === 200 && f2.status === 200 && f3.status === 200 && f1.text === f2.text && f2.text === f3.text && /If this email belongs/.test(f1.text), [f1.text, f2.text]);
    check('H', '...and the answer is conditional ("If this email belongs...") - it never says a link WAS sent', /^If this email/.test(f1.body.message) && !/not found|no such|unknown/i.test(f1.text));
    check('H', 'the known, activated vendor gets ONE reset email (reset wording, 1 hour, login ID, portal URL)', await waitMails(eH, 2) && mailsTo(eH).length === 2 && /reset/i.test(mailsTo(eH)[1].subject) && /1 hour/.test(mailsTo(eH)[1].text) && mailsTo(eH)[1].text.includes(eH) && mailsTo(eH)[1].text.includes(`${BASE}/vendor-login`), mailsTo(eH).length);
    check('H', 'nothing was mailed for the unknown address', mailsTo(`nobody-${RUN}@example.test`).length === 0);
    const hl = linkOf(mailsTo(eH)[1]);
    const lifeMs = new Date((await prisma.vendorLoginToken.findUnique({ where: { tokenHash: sha(hl.token) } })).expiresAt).getTime() - Date.now();
    check('H', 'the forgot-password link lasts 1 hour', lifeMs > 55 * 60000 && lifeMs <= 61 * 60000, lifeMs / 60000);
    check('H', 'asking for a reset does NOT lock the vendor out: the old password still works', (await vlogin(eH, pwH)).status === 200);
    const pwH2 = PW('Aitch2');
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: hl.token, newPassword: pwH2, confirmPassword: pwH2 });
    check('H', 'the reset link sets a new password; a second use fails', r.status === 200 && (await http('POST', '/api/vendor-portal/invite/accept', null, { token: hl.token, newPassword: PW('x1'), confirmPassword: PW('x1') })).status === 400 && (await vlogin(eH, pwH2)).status === 200 && (await vlogin(eH, pwH)).status === 401);
    // per-login limit: 3 emails an hour; ips differ so only the per-login limit bites
    const base0 = mailsTo(eH).length;
    for (let i = 0; i < 5; i += 1) { await http('POST', '/api/vendor-portal/forgot-password', null, { email: eH }); await sleep(250); }
    await sleep(800);
    const sentNow = mailsTo(eH).length - base0;
    check('H', 'rate limit per login: at most 3 reset emails an hour (the rest are skipped quietly)', sentNow === 2 || sentNow === 3, sentNow);
    // (1 reset above already counted in this hour -> 3 total)
    const limited = await prisma.assetAuditLog.count({ where: { vendorUserId: LH.id, action: 'Password reset request limited' } });
    check('H', '...and the limit is written in the vendor history', limited >= 1, limited);
    // per network limit (429)
    let got429 = false;
    for (let i = 0; i < 14 && !got429; i += 1) { const x = await http('POST', '/api/vendor-portal/forgot-password', null, { email: `x${i}-${RUN}@example.test` }, { ip: '10.88.0.9' }); if (x.status === 429) got429 = true; }
    check('H', 'rate limit per network: too many requests from one place get 429', got429);
    // waiting / switched off / deleted get nothing
    const eH2 = addr('h2');
    await create({ vendorId: V1.id, name: 'ZZTEST Not Active', email: eH2 });
    const nW = mailsTo(eH2).length;
    await http('POST', '/api/vendor-portal/forgot-password', null, { email: eH2 });
    await sleep(700);
    check('H', 'a login that never activated gets no reset email (it needs the invitation)', mailsTo(eH2).length === nW);
    const eH3 = addr('h3');
    const r3 = await create({ vendorId: V1.id, name: 'ZZTEST Gone', email: eH3 });
    const pwH3 = PW('Aitch3');
    await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkOf(mailsTo(eH3)[0]).token, newPassword: pwH3, confirmPassword: pwH3 });
    await http('POST', `/api/vendor-logins/${r3.body.login.id}/deactivate`, T.admin, {});
    const nG = mailsTo(eH3).length;
    await http('POST', '/api/vendor-portal/forgot-password', null, { email: eH3 });
    await sleep(700);
    check('H', 'a switched-off login gets no reset email', mailsTo(eH3).length === nG);

    // =============================================================== I  who may do what
    const targetId = LF.id;
    const calls = [
      ['GET', '/api/vendor-logins'], ['POST', '/api/vendor-logins', { vendorId: V1.id, name: 'ZZTEST No', email: addr('no') }],
      ['POST', `/api/vendor-logins/${targetId}/resend-invitation`, {}], ['POST', `/api/vendor-logins/${targetId}/invitation/retry`, {}],
      ['POST', `/api/vendor-logins/${targetId}/send-reset`, {}], ['PATCH', `/api/vendor-logins/${targetId}`, { email: addr('no2') }],
      ['POST', `/api/vendor-logins/${targetId}/email-change/cancel`, {}], ['GET', `/api/vendor-logins/${targetId}/emails`], ['PUT', '/api/vendor-logins/settings', { emailsEnabled: false }],
    ];
    const nMail = mails().length;
    for (const [who, label] of [['acc', 'Accountant (no vendor-login grant)'], ['rec', 'Recruiter'], ['hr', 'HR'], ['bde', 'BDE']]) {
      const codesI = [];
      for (const [m, p, b] of calls) { const x = await http(m, p, T[who], b); codesI.push(x.status); } // eslint-disable-line no-await-in-loop
      check('I', `${label}: every create / resend / retry / reset / edit / settings call is refused (403)`, codesI.every((c) => c === 403), codesI);
    }
    const vt = (await vlogin(eF, pwF2)).body.token;
    const codesV = [];
    for (const [m, p, b] of calls) { const x = await http(m, p, vt, b); codesV.push(x.status); } // eslint-disable-line no-await-in-loop
    check('I', 'a VENDOR login cannot reach any of them (403 from the portal wall)', codesV.every((c) => c === 403), codesV);
    const codesN = [];
    for (const [m, p, b] of calls.slice(0, 3)) { const x = await http(m, p, null, b); codesN.push(x.status); } // eslint-disable-line no-await-in-loop
    check('I', 'no sign-in at all: 401', codesN.every((c) => c === 401), codesN);
    check('I', 'the refused calls sent no email and made no login', mails().length === nMail && (await prisma.vendorUser.count({ where: { email: addr('no') } })) === 0);
    const eI = addr('i');
    r = await create({ vendorId: V1.id, name: 'ZZTEST By Super', email: eI }, T.sup);
    check('I', 'Super Admin can create, and the email goes out', r.status === 201 && mailsTo(eI).length === 1, r.status);
    r = await http('POST', `/api/vendor-logins/${r.body.login.id}/resend-invitation`, T.sup, {});
    check('I', 'Super Admin can resend', r.status === 200 && mailsTo(eI).length === 2);
    r = await http('PUT', '/api/vendor-logins/settings', T.acc, { emailsEnabled: true });
    check('I', 'only Admin / Super Admin change the Vendor emails settings', r.status === 403);
    r = await http('GET', '/api/vendor-logins/settings', T.admin);
    check('I', 'settings show the readiness + the four emails with their template purposes', r.status === 200 && r.body.mail && r.body.emails.length === 4 && r.body.emails.some((e) => e.purpose === 'VENDOR_WELCOME') && r.body.supportPhone === '+91 90000 00000', r.body.emails);

    // =============================================================== J  accepted vs delivered
    const eJ = addr('j');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Delivered', email: eJ });
    const LJ = r.body.login;
    const jr = (await raw('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?', LJ.id))[0];
    check('J', 'right after sending: accepted by the mail server, delivery NOT confirmed (separate fields)', !!jr.acceptedAt && jr.deliveredAt === null && jr.status === 'accepted');
    const live = MAIL.viewOf({ ...jr, mode: 'live' }, null);
    check('J', 'live wording: "Sent" + "Delivery not confirmed by the provider" (never "Delivered")', live.status === 'sent' && live.text === 'Sent' && /Delivery not confirmed by the provider/.test(live.detail), live);
    const hook = (events) => {
      const rawBody = JSON.stringify({ events });
      const ts = String(Math.floor(Date.now() / 1000));
      return fetch(`${API}/api/public/outreach/webhook/email`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outreach-timestamp': ts, 'x-outreach-signature': WH.sign(ts, rawBody), 'X-Forwarded-For': randIp() }, body: rawBody }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    };
    const bad = await fetch(`${API}/api/public/outreach/webhook/email`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-outreach-timestamp': String(Math.floor(Date.now() / 1000)), 'x-outreach-signature': 'a'.repeat(64) }, body: '{}' });
    check('J', 'an unsigned / wrongly signed delivery report is refused (401)', bad.status === 401);
    let w = await hook([{ eventId: `zz-${RUN}-d1`, type: 'delivered', providerRef: jr.providerRef }]);
    if (w.status === 503) {
      // the campaigns tables are not in this copy: apply the same event directly through the same code path
      const direct = await MAIL.applyProviderEvent({ type: 'delivered', providerRef: jr.providerRef }, Date.now());
      check('J', '(the signed webhook is not ready in this copy; the delivery report was applied directly)', direct.updated === 'delivered', direct);
    } else check('J', 'the provider\'s signed delivery report is accepted', w.status === 200 && w.body.updated >= 1, w);
    const jr2 = (await raw('SELECT * FROM "VendorMailLog" WHERE "id" = ?', jr.id))[0];
    check('J', 'now it is Delivered: deliveredAt set, acceptedAt kept', jr2.status === 'delivered' && !!jr2.deliveredAt && jr2.acceptedAt === jr.acceptedAt, jr2);
    rowAfter = await getRow(LJ.id);
    check('J', 'Admin sees "Delivered" (provider-confirmed)', rowAfter.invitation.status === 'delivered' && rowAfter.invitation.text === 'Delivered' && /confirmed delivery/.test(rowAfter.invitation.detail), rowAfter.invitation);
    if (w.status !== 503) {
      w = await hook([{ eventId: `zz-${RUN}-d1`, type: 'delivered', providerRef: jr.providerRef }]);
      check('J', 'the same report twice changes nothing (duplicate ignored)', w.status === 200 && w.body.duplicates === 1, w);
    }
    r = await create({ vendorId: V1.id, name: 'ZZTEST Bounced', email: addr('j2') });
    const jb = (await raw('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?', r.body.login.id))[0];
    const bn = w.status === 503 ? await MAIL.applyProviderEvent({ type: 'bounce', bounceType: 'hard', providerRef: jb.providerRef }, Date.now()) : (await hook([{ eventId: `zz-${RUN}-b1`, type: 'bounce', bounceType: 'hard', providerRef: jb.providerRef }])).body;
    rowAfter = await getRow(r.body.login.id);
    check('J', 'a hard bounce from the provider turns the invitation into Failed (bounced) and offers Retry', rowAfter.invitation.status === 'failed' && rowAfter.invitation.failCode === 'BOUNCED' && rowAfter.canRetry === true && /bounced/i.test(rowAfter.invitation.text + rowAfter.invitation.reason), [bn, rowAfter.invitation]);
    const late = await MAIL.applyProviderEvent({ type: 'delivered', providerRef: jb.providerRef }, Date.now());
    check('J', 'a late "delivered" never undoes a bounce', (await raw('SELECT "status" FROM "VendorMailLog" WHERE "id" = ?', jb.id))[0].status === 'bounced', late);
    const soft = await MAIL.applyProviderEvent({ type: 'bounce', bounceType: 'soft', providerRef: jr.providerRef }, Date.now());
    check('J', 'a late soft bounce never undoes a delivery', (await raw('SELECT "status" FROM "VendorMailLog" WHERE "id" = ?', jr.id))[0].status === 'delivered', soft);
    check('J', 'a report for an unknown message changes nothing', (await MAIL.applyProviderEvent({ type: 'delivered', providerRef: '<nothing@x>' }, Date.now())).unmatched === true);

    // =============================================================== K  templates
    r = await http('GET', '/api/messaging/templates', T.admin);
    const tpl = (r.body.templates || []).filter((t) => t.audience === 'vendor');
    check('K', 'the four vendor emails exist as Message templates (audience Vendors) with the built-in wording', tpl.length === 4 && ['VENDOR_WELCOME', 'VENDOR_PASSWORD_RESET', 'VENDOR_EMAIL_VERIFY', 'VENDOR_EMAIL_CHANGED'].every((p) => tpl.some((t) => t.purpose === p && t.channel === 'Email' && t.builtIn)), tpl.map((t) => t.purpose));
    const welcome = tpl.find((t) => t.purpose === 'VENDOR_WELCOME');
    check('K', 'the saved welcome template carries the temporary-password line (an unedited built-in follows the current wording)', /{{tempPassword}}/.test(welcome.body) && /{{setupLink}}/.test(welcome.body), welcome.body);
    r = await http('PUT', `/api/messaging/templates/${welcome.id}`, T.admin, { body: 'Hi {{name}} no link here' });
    check('K', 'wording that drops the secure link (or the temporary password) is refused', r.status === 400 && /must keep the \{\{setupLink\}\}/.test(r.body.error), r.body);
    r = await http('PUT', `/api/messaging/templates/${welcome.id}`, T.hr, { body: `${welcome.body}\nHR edit` });
    check('K', 'HR (who may edit other templates) cannot change a vendor email: 403', r.status === 403 && /Only an Admin/.test(r.body.error), r.body);
    const mark = `ZZMARK${RUN}`;
    r = await http('PUT', `/api/messaging/templates/${welcome.id}`, T.admin, { subject: `${mark} Welcome {{company}}`, body: `${welcome.body}\n${mark} custom line for {{vendorCompany}}` });
    check('K', 'Admin edits the welcome wording (new version)', r.status === 200 && r.body.version === 2, r.body);
    const eK = addr('k');
    await create({ vendorId: V1.id, name: 'ZZTEST Template', email: eK });
    check('K', 'the next welcome email uses the edited wording (subject + body + company filled in)', mailsTo(eK).length === 1 && mailsTo(eK)[0].subject.startsWith(mark) && mailsTo(eK)[0].text.includes(`${mark} custom line for ${V1.name}`) && !!linkOf(mailsTo(eK)[0]), mailsTo(eK)[0] && mailsTo(eK)[0].subject);
    r = await http('POST', `/api/messaging/templates/${welcome.id}/restore`, T.admin, { version: 1 });
    check('K', 'Admin can restore the built-in wording', r.status === 200, r.body);
    r = await http('GET', '/api/messaging/templates/tokens', T.admin);
    check('K', 'the editor offers the vendor details (login ID, portal address, secure link, expiry, support)', ['loginId', 'portalUrl', 'setupLink', 'expiresOn', 'supportLine', 'vendorCompany'].every((k) => r.body.tokens.some((t) => t.key === k)));

    // =============================================================== M  account words
    await prisma.vendorUser.update({ where: { id: LB.id }, data: { lockedUntil: new Date(Date.now() + 600000) } });
    check('M', 'a locked login shows "Locked"', (await getRow(LB.id)).accountText === 'Locked');
    await prisma.vendorUser.update({ where: { id: LB.id }, data: { lockedUntil: null } });
    await http('POST', `/api/vendor-logins/${LB.id}/deactivate`, T.admin, {});
    check('M', 'a switched-off login shows "Switched off"', (await getRow(LB.id)).accountText === 'Switched off');
    await http('POST', `/api/vendor-logins/${LB.id}/activate`, T.admin, {});
    check('M', 'switched on again: "Active"', (await getRow(LB.id)).accountText === 'Active');
    r = await http('GET', '/api/vendor-logins?account=waiting', T.admin);
    check('M', 'the Account filter works with counts', r.body.rows.every((x) => x.accountStatus === 'waiting') && r.body.facets.account.some((f) => f.value === 'waiting' && f.count >= 1), r.body.facets.account);

    // =============================================================== T  the temporary password (founder: "the vendor must see BOTH login ID and password")
    const eT = addr('t');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Temp One', email: eT });
    const LT = r.body.login; const mT = mailsTo(eT)[0]; const tT = tempOf(mT); const lkT = linkOf(mT);
    check('T', 'the welcome email carries login ID + temporary password + secure link together', !!tT && mT.text.includes(eT) && !!lkT, mT.text.slice(0, 400));
    let lg2 = await vlogin(eT, tT);
    check('T', 'the vendor can sign in AT ONCE with login ID + temporary password, and is told a new password is required', lg2.status === 200 && lg2.body.vendor.mustChangePassword === true && lg2.body.landing === '/vendor/dashboard', lg2.body);
    const tokT = lg2.body.token;
    r = await http('GET', '/api/vendor-portal/me', tokT);
    check('T', '/me works (so the screen can ask for the new password) and shows the forced change', r.status === 200 && r.body.mustChangePassword === true, r.body);
    r = await http('GET', '/api/vendor-portal/records/overview', tokT);
    check('T', 'until the password is changed NO data is served (403 "set a new password first")', r.status === 403 && r.body.mustChangePassword === true, r.body);
    const pwT = PW('Tee');
    r = await http('POST', '/api/vendor-portal/change-password', tokT, { currentPassword: tT, newPassword: tT, confirmPassword: tT });
    check('T', 'the temporary password cannot be kept as the new password', r.status === 400, r.body);
    r = await http('POST', '/api/vendor-portal/change-password', tokT, { currentPassword: tT, newPassword: pwT, confirmPassword: pwT });
    check('T', 'the vendor chooses their own password: done', r.status === 200, r.body);
    check('T', 'the temporary password stops working at once; the new one works', (await vlogin(eT, tT)).status === 401 && (await vlogin(eT, pwT)).status === 200);
    check('T', 'the unused invitation link dies too (activated now)', (await http('GET', `/api/vendor-portal/invite/${encodeURIComponent(lkT.token)}`)).status === 404);
    rowAfter = await getRow(LT.id);
    check('T', 'the login is now Active (activated), invitation Used', rowAfter.accountStatus === 'active' && rowAfter.invitation.label === 'Account Active' && rowAfter.activated === true, [rowAfter.accountStatus, rowAfter.invitation.label]);
    check('T', 'the vendor history says the account was activated by replacing the temporary password', (await prisma.assetAuditLog.findMany({ where: { vendorUserId: LT.id } })).some((a) => /Account activated/.test(a.action)));
    // expired temporary password
    const eT2 = addr('t2');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Temp Two', email: eT2 });
    const tT2 = tempOf(mailsTo(eT2)[0]);
    await prisma.vendorUser.update({ where: { id: r.body.login.id }, data: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
    check('T', 'an EXPIRED temporary password is refused (generic 401)', (await vlogin(eT2, tT2)).status === 401);
    r = await http('POST', `/api/vendor-logins/${r.body.login.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `t2-${RUN}-1` } });
    const tT2b = tempOf(mailsTo(eT2)[1]);
    check('T', '...and a new invitation brings a NEW temporary password that works; the expired one stays dead', tT2b !== tT2 && (await vlogin(eT2, tT2b)).status === 200 && (await vlogin(eT2, tT2)).status === 401);
    // replaced by Resend
    const eT3 = addr('t3');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Temp Three', email: eT3 });
    const tA = tempOf(mailsTo(eT3)[0]);
    await http('POST', `/api/vendor-logins/${r.body.login.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `t3-${RUN}-1` } });
    const tB = tempOf(mailsTo(eT3)[1]);
    check('T', 'Resend makes a NEW temporary password; the old one is rejected, the new one works', !!tB && tB !== tA && (await vlogin(eT3, tA)).status === 401 && (await vlogin(eT3, tB)).status === 200);
    // replaced by Edit email (waiting)
    const eT4 = addr('t4'); const eT4b = addr('t4b');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Temp Four', email: eT4 });
    const t4a = tempOf(mailsTo(eT4)[0]);
    await http('PATCH', `/api/vendor-logins/${r.body.login.id}`, T.admin, { email: eT4b });
    await sleep(200);
    const t4b = tempOf(mailsTo(eT4b)[0]);
    check('T', 'Edit email (not activated) sends a NEW temporary password to the new address; the old one works for neither address', !!t4b && t4b !== t4a && (await vlogin(eT4, t4a)).status === 401 && (await vlogin(eT4b, t4a)).status === 401 && (await vlogin(eT4b, t4b)).status === 200);
    // the link first: the temporary password dies
    const eT5 = addr('t5');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Temp Five', email: eT5 });
    const t5 = tempOf(mailsTo(eT5)[0]); const l5 = linkOf(mailsTo(eT5)[0]);
    const pw5 = PW('Fiv');
    await http('POST', '/api/vendor-portal/invite/accept', null, { token: l5.token, newPassword: pw5, confirmPassword: pw5 });
    check('T', 'setting a password through the link kills the temporary password', (await vlogin(eT5, t5)).status === 401 && (await vlogin(eT5, pw5)).status === 200);
    // never a permanent password: the reset email has none
    const rsMail = mailsTo(eF).find((m) => /reset/i.test(m.subject));
    check('T', 'a password-reset email carries a link only - never a password', !!rsMail && tempOf(rsMail) === null && !/Temporary password/i.test(rsMail.text));

    // =============================================================== Q  every deliberate click sends (founder rule)
    const eQ = addr('q');
    r = await create({ vendorId: V1.id, name: 'ZZTEST Clicks', email: eQ });
    const LQ = r.body.login;
    for (let i = 1; i <= 3; i += 1) {
      r = await http('POST', `/api/vendor-logins/${LQ.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `q-${RUN}-click${i}` } });
      check('Q', `click ${i}: a NEW email goes to the vendor (not swallowed)`, r.status === 200 && r.body.emailed === true && !r.body.duplicate && mailsTo(eQ).length === 1 + i, [r.status, mailsTo(eQ).length, r.body.message]);
    }
    const qm = mailsTo(eQ); const qt = qm.map(tempOf); const ql = qm.map(linkOf);
    check('Q', '3 clicks + the first = 4 emails with 4 DIFFERENT temporary passwords and 4 different links', new Set(qt).size === 4 && new Set(ql.map((x) => x.token)).size === 4 && qt.every(Boolean), qt.length);
    const alive = await Promise.all(ql.map((x) => http('GET', `/api/vendor-portal/invite/${encodeURIComponent(x.token)}`)));
    check('Q', 'only the LATEST link works', alive.map((x) => x.status).join() === '404,404,404,200', alive.map((x) => x.status));
    const olds = await Promise.all(qt.slice(0, 3).map((t) => vlogin(eQ, t)));
    check('Q', 'only the LATEST temporary password works; the three older ones are rejected', olds.every((x) => x.status === 401) && (await vlogin(eQ, qt[3])).status === 200);
    check('Q', 'the account count stays ONE however many times it was sent', (await prisma.vendorUser.count({ where: { email: eQ } })) === 1 && (await raw('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?', LQ.id)).length === 4);
    rowAfter = await getRow(LQ.id);
    check('Q', 'the Admin list shows the attempt count (4) and the last attempt time', rowAfter.emailAttempts === 4 && !!rowAfter.lastAttempt && !!rowAfter.lastAttempt.at && rowAfter.invitation.attemptNo === 4, [rowAfter.emailAttempts, rowAfter.lastAttempt]);
    // the SAME request twice (a double submit, same key) = one email
    const same = await Promise.all([1, 2].map(() => http('POST', `/api/vendor-logins/${LQ.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `q-${RUN}-dup` } })));
    await sleep(300);
    check('Q', 'the SAME request twice (same key): ONE email', mailsTo(eQ).length === 5 && same.every((x) => x.status === 200), mailsTo(eQ).length);
    // the rate limit: 10 Admin-requested emails per login per hour, said plainly
    let blocked = null; let sends = 0;
    for (let i = 0; i < 12 && !blocked; i += 1) {
      const x = await http('POST', `/api/vendor-logins/${LQ.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `q-${RUN}-rate${i}` } });
      if (x.status === 429) blocked = x; else sends += 1;
    }
    check('Q', 'beyond 10 emails in an hour the click is refused with a plain message and the minutes to wait (429)', !!blocked && blocked.body.code === 'TOO_MANY_INVITATIONS' && /^Too many invitations in a short time/.test(blocked.body.error) && /try again in \d+ minutes?/.test(blocked.body.error) && blocked.body.retryAfterMinutes >= 1, blocked && blocked.body);
    check('Q', '...exactly 10 emails were sent in that hour and the refused click sent nothing', mailsTo(eQ).length === 10 && sends === 5, [mailsTo(eQ).length, sends]);
    await raw('UPDATE "VendorMailLog" SET "createdAt" = ? WHERE "vendorUserId" = ?', new Date(Date.now() - 2 * 3600000).toISOString(), LQ.id);
    r = await http('POST', `/api/vendor-logins/${LQ.id}/resend-invitation`, T.admin, {}, { headers: { 'Idempotency-Key': `q-${RUN}-after` } });
    check('Q', 'after the hour the Admin can send again', r.status === 200 && r.body.emailed === true && mailsTo(eQ).length === 11, r.body);
    const src = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/admin/VendorLoginActions.jsx'), 'utf8');
    check('Q', 'screen: the Send / Resend / Retry buttons are disabled while a request is on its way, and every click has its own fresh key', /disabled=\{!!busy\}/.test(src) && /if \(busy\) return;/.test(src) && /'Idempotency-Key': newKey\(\)/.test(src) && /randomUUID/.test(src));
    check('Q', 'screen: Send invitation / Resend invitation only before activation; Send password reset only after; Edit email always', /live && !row\.activated/.test(src) && /live && row\.activated/.test(src) && /Edit email/.test(src) && /neverSent \? 'Send invitation' : 'Resend invitation'/.test(src));
    // G addition: the previous address is told after a confirmed change
    check('G', 'the PREVIOUS address got a security notice after the change was confirmed (no link, names the new login ID)', await waitMails(eG2, nMailsOld + 1) && (() => { const n = mailsTo(eG2).find((m) => /was changed/i.test(m.subject)); return !!n && n.text.includes(eG4) && !linkOf(n) && tempOf(n) === null; })(), mailsTo(eG2).map((m) => m.subject));

    // =============================================================== N  the vendor portal has exactly four modules
    const CFGM = require(path.join(BACK, 'src/config/vendorModules'));
    const { pathToFileURL } = require('url');
    const FE = await import(pathToFileURL(path.join(BACK, '..', 'frontend/src/pages/vendor/vendorNav.js')).href);
    const NAMES = ['Dashboard', 'Bills & Invoices', 'Payments & Outstanding', 'Services & Agreements'];
    check('N', 'server menu config: exactly 4 entries - Dashboard, Invoices, Payments, Purchase Orders', CFGM.PORTAL_NAV.length === 4 && CFGM.PORTAL_NAV.map((n) => n.label).join() === NAMES.join(), CFGM.PORTAL_NAV);
    check('N', 'screen menu config (desktop AND mobile): the same 4 entries, same routes', FE.VENDOR_NAV_DESKTOP.length === 4 && FE.VENDOR_NAV_MOBILE.length === 4 && JSON.stringify(FE.VENDOR_NAV_DESKTOP) === JSON.stringify(FE.VENDOR_NAV_MOBILE) && JSON.stringify(FE.VENDOR_NAV.map((n) => [n.key, n.label, n.route])) === JSON.stringify(CFGM.PORTAL_NAV.map((n) => [n.key, n.label, n.route])));
    check('N', 'route guard (pure logic): the removed pages and any unknown address go to the Dashboard; the four routes stay', ['/vendor', '/vendor/', '/vendor/assets', '/vendor/documents', '/vendor/profile', '/vendor/m/office', '/vendor/notifications', '/vendor/support', '/vendor/settings'].every((p) => FE.vendorRouteFor(p) === '/vendor/dashboard' && CFGM.portalRouteFor(p) === '/vendor/dashboard') && FE.VENDOR_NAV.every((n) => FE.vendorRouteFor(n.route) === n.route && FE.vendorRouteFor(`${n.route}/`) === n.route));
    const appSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/App.jsx'), 'utf8');
    check('N', 'App.jsx: routes exist for the 4 modules only; /vendor/* and /vendor go to the Dashboard; no assets / documents / profile / module route', ['dashboard', 'invoices', 'payments', 'services'].every((x) => appSrc.includes(`path="/vendor/${x}"`)) && !/path="\/vendor\/(assets|documents|profile|m\/)/.test(appSrc) && /path="\/vendor\/\*" element=\{<Navigate to="\/vendor\/dashboard"/.test(appSrc) && /path="\/vendor" element=\{<Navigate to="\/vendor\/dashboard"/.test(appSrc));
    const shellSrc = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/vendor/VendorShell.jsx'), 'utf8');
    check('N', 'the portal frame has no fallback menu with the old pages and shows only Change password + Logout as utilities', !/Your assets|Your details|Bills and payments/.test(shellSrc) && /VENDOR_NAV/.test(shellSrc) && /Change password/.test(shellSrc) && /Logout/.test(shellSrc));

    // =============================================================== O  the vendor's own records only
    const mkActive = async (vendor, tag) => {
      const pw = PW(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Rec ${tag}`, email: addr(tag), passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date() } });
      const l = await vlogin(u.email, pw);
      return { u, pw, token: l.body.token, landing: l.body.landing };
    };
    const W1 = await mkActive(V1, 'rec1'); const W2 = await mkActive(V2, 'rec2');
    check('O', 'vendor login lands on the Dashboard', W1.landing === '/vendor/dashboard' && W2.landing === '/vendor/dashboard', [W1.landing, W2.landing]);
    r = await http('GET', '/api/vendor-portal/me', W1.token);
    check('O', '/me gives the 4-entry menu and no extra modules (desktop = mobile)', r.status === 200 && r.body.nav.map((n) => n.label).join() === NAMES.join() && (r.body.core || []).length === 0 && r.body.modules.length === 4, r.body.nav);
    const now = Date.now();
    const modBill = (vendor, user, o) => raw(
      'INSERT INTO "VendorModuleBill" ("id","billCode","vendorId","vendorUserId","kind","billNumber","billDate","amount","gst","total","status","paidOn","paidAmount","paymentRef","paymentMode","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      `zzmb${o.n}${RUN}`, `ZZ-${o.n}${RUN}`.slice(0, 20), vendor.id, user.id, 'invoice', o.no, o.date, o.amount, o.gst, o.total, o.status, o.paidOn || null, o.paidAmount == null ? null : o.paidAmount, o.ref || null, o.mode || null, now, now,
    );
    await modBill(V1, W1.u, { n: 'A', no: `ZZ-INV-A-${RUN}`, date: '2026-09-01', amount: 1000, gst: 180, total: 1180, status: 'Paid', paidOn: '2026-09-25', paidAmount: 1180, ref: 'UTR-A', mode: 'Bank Transfer' });
    await modBill(V1, W1.u, { n: 'B', no: `ZZ-INV-B-${RUN}`, date: '2026-09-02', amount: 2000, gst: 360, total: 2360, status: 'Paid', paidOn: '2026-09-26', paidAmount: 1000, ref: 'UTR-B', mode: 'UPI' });
    await modBill(V1, W1.u, { n: 'C', no: `ZZ-INV-C-${RUN}`, date: '2026-09-03', amount: 500, gst: 90, total: 590, status: 'Approved' });
    await modBill(V1, W1.u, { n: 'D', no: `ZZ-INV-D-${RUN}`, date: '2026-09-04', amount: 100, gst: 0, total: 100, status: 'Rejected' });
    await modBill(V1, W1.u, { n: 'E', no: `ZZ-INV-E-${RUN}`, date: '2026-09-05', amount: 500, gst: 0, total: 500, status: 'Submitted' });
    await modBill(V2, W2.u, { n: 'F', no: `ZZ-INV-F-${RUN}`, date: '2026-09-06', amount: 777, gst: 0, total: 777, status: 'Paid', paidOn: '2026-09-27', paidAmount: 777, ref: 'UTR-F', mode: 'Cheque' });
    const mkExp = (v, o) => prisma.officeExpense.create({ data: { category: 'Vendor bill', monthlyAmount: o.total, gstAmount: o.gst, tdsAmount: o.tds || 0, vendor: v.name, vendorId: v.id, billNumber: o.no, expenseDate: o.date, approvalStatus: o.status, paymentDate: o.payDate || null, paymentMode: 'Bank Transfer', entryKind: 'expense' } });
    await mkExp(V1, { no: `ZZ-ACC-P-${RUN}`, date: '2026-09-10', total: 5900, gst: 900, tds: 100, status: 'PAID', payDate: '2026-09-20' });
    await mkExp(V1, { no: `ZZ-ACC-Q-${RUN}`, date: '2026-09-11', total: 1180, gst: 180, status: 'APPROVED' });
    await mkExp(V2, { no: `ZZ-ACC-R-${RUN}`, date: '2026-09-12', total: 321, gst: 0, status: 'APPROVED' });
    // INDEPENDENT recomputation (plain arithmetic from the fixtures above, not the app's code)
    const E1 = { total: 7, paid: 2, pending: 4, rejected: 1, outstanding: 1360 + 590 + 500 + 1180, received: 1180 + 1000 + 5800, billed: 1180 + 2360 + 590 + 500 + 5800 + 1180, payCount: 3 };
    r = await http('GET', '/api/vendor-portal/records/overview', W1.token);
    const o1 = r.body;
    check('O', 'Dashboard totals equal the independently recomputed ones: 7 invoices, 2 paid, 4 pending, outstanding 3630, received 7980', r.status === 200 && o1.invoices.total === E1.total && o1.invoices.paid === E1.paid && o1.invoices.pending === E1.pending && o1.invoices.rejected === E1.rejected && o1.invoices.outstanding === E1.outstanding && o1.payments.received === E1.received && o1.payments.count === E1.payCount && o1.invoices.billed === E1.billed, o1.invoices);
    check('O', 'the partly paid invoice (paid 1000 of 2360) is counted ONCE: 1000 in payments, 1360 in outstanding - never both as paid', o1.payments.recent.some((p) => p.amount === 1000 && p.status === 'Partially Paid') && o1.invoices.received === 7980 && o1.invoices.outstanding - (590 + 500 + 1180) === 1360);
    r = await http('GET', '/api/vendor-portal/records/invoices?pageSize=100', W1.token);
    check('O', 'Invoices list: 7 rows, summary agrees with the Dashboard, rows carry no other vendor\'s data', r.status === 200 && r.body.rows.length === 7 && r.body.summary.outstanding === E1.outstanding && r.body.summary.received === E1.received && !r.text.includes(`ZZ-INV-F-${RUN}`) && !r.text.includes(`ZZ-ACC-R-${RUN}`), r.body.summary);
    const accPaid = r.body.rows.find((x) => x.invoiceNo === `ZZ-ACC-P-${RUN}`);
    check('O', 'an Accounts bill shows the existing rules: amount 5900 + GST - TDS 100 = receives 5800, paid, outstanding 0', accPaid && accPaid.netPayable === 5800 && accPaid.tds === 100 && accPaid.paid === true && accPaid.outstanding === 0 && accPaid.paymentDate === '2026-09-20', accPaid);
    r = await http('GET', '/api/vendor-portal/records/invoices?status=unpaid', W1.token);
    check('O', 'filter Pending: exactly the 4 unpaid live invoices', r.body.total === 4 && r.body.rows.every((x) => !x.paid && !['REJECTED', 'WITHDRAWN'].includes(x.status)), r.body.total);
    r = await http('GET', '/api/vendor-portal/records/invoices?status=paid', W1.token);
    check('O', 'filter Paid: the 2 fully paid ones', r.body.total === 2 && r.body.rows.every((x) => x.paid), r.body.total);
    r = await http('GET', `/api/vendor-portal/records/invoices?q=${encodeURIComponent(`INV-C-${RUN}`)}`, W1.token);
    check('O', 'search by invoice number', r.body.total === 1 && r.body.rows[0].invoiceNo === `ZZ-INV-C-${RUN}`, r.body.total);
    r = await http('GET', '/api/vendor-portal/records/invoices?sort=amount&dir=asc&pageSize=5&page=2', W1.token);
    check('O', 'sorting + paging on the server: page 2 of 2 holds the last 2 of 7 by amount', r.body.page === 2 && r.body.pages === 2 && r.body.rows.length === 2 && r.body.rows[0].netPayable <= r.body.rows[1].netPayable, [r.body.page, r.body.rows.length]);
    r = await http('GET', '/api/vendor-portal/records/invoices?from=2026-09-02&to=2026-09-03', W1.token);
    check('O', 'date filter', r.body.total === 2 && r.body.rows.every((x) => x.date >= '2026-09-02' && x.date <= '2026-09-03'), r.body.total);
    r = await http('GET', '/api/vendor-portal/records/payments', W1.token);
    check('O', 'Payments list: 3 payments totalling 7980, each tied to its invoice, methods filter offered', r.body.total === 3 && r.body.summary.received === 7980 && r.body.rows.every((x) => x.invoiceNo && x.date) && r.body.methods.includes('UPI'), r.body.summary);
    r = await http('GET', '/api/vendor-portal/records/payments?method=UPI', W1.token);
    check('O', 'Payments filter by method', r.body.total === 1 && r.body.rows[0].reference === 'UTR-B', r.body.rows);
    const payKey = (await http('GET', '/api/vendor-portal/records/payments', W1.token)).body.rows[0].key;
    r = await http('GET', `/api/vendor-portal/records/payments/${encodeURIComponent(payKey)}`, W1.token);
    check('O', 'Payment detail', r.status === 200 && r.body.payment.key === payKey, r.body);
    const invKey = (await http('GET', '/api/vendor-portal/records/invoices', W1.token)).body.rows[0].key;
    r = await http('GET', `/api/vendor-portal/records/invoices/${encodeURIComponent(invKey)}`, W1.token);
    check('O', 'Invoice detail', r.status === 200 && r.body.invoice.key === invKey, r.body);
    r = await http('GET', '/api/vendor-portal/records/invoices?pageSize=100', W2.token);
    check('O', 'Vendor 2 sees only its OWN 2 invoices (321 owed, 777 paid) and none of vendor 1\'s', r.body.total === 2 && r.body.summary.outstanding === 321 && r.body.summary.received === 777 && !r.text.includes(`ZZ-INV-A-${RUN}`) && !r.text.includes(`ZZ-ACC-P-${RUN}`), r.body.summary);
    // purchase orders: shared documents + orders placed with the vendor
    const upload = async (vendorId, title, docType) => {
      const fd = new FormData();
      fd.append('title', title); fd.append('docType', docType); fd.append('note', 'ZZ note'); fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'zz-po.pdf');
      const x = await fetch(`${API}/api/vendor-master/${vendorId}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${T.admin}`, 'X-Forwarded-For': randIp() }, body: fd });
      return { status: x.status, body: await x.json().catch(() => null) };
    };
    const po1 = await upload(V1.id, `ZZ PO-1 ${RUN}`, 'Purchase order');
    const ag1 = await upload(V1.id, `ZZ Agreement ${RUN}`, 'Agreement');
    const po2 = await upload(V2.id, `ZZ PO-2 ${RUN}`, 'Purchase order');
    check('O', 'fixtures: purchase-order documents shared by the company (through the existing Admin endpoint)', po1.status === 201 && ag1.status === 201 && po2.status === 201, [po1.status, po2.status]);
    await raw('INSERT INTO "IdCardOrder" ("id","orderCode","vendorId","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzord${RUN}`, `IDC-ZZ-${RUN}`, V1.id, 'Printing', now, now);
    await raw('INSERT INTO "IdCardOrderLine" ("id","orderId","employeeId","employeeName","cardType","createdAt") VALUES (?,?,?,?,?,?)', `zzl1${RUN}`, `zzord${RUN}`, 'e1', 'ZZ One', 'New', now);
    await raw('INSERT INTO "IdCardOrderLine" ("id","orderId","employeeId","employeeName","cardType","createdAt") VALUES (?,?,?,?,?,?)', `zzl2${RUN}`, `zzord${RUN}`, 'e2', 'ZZ Two', 'New', now);
    r = await http('GET', '/api/vendor-portal/records/purchase-orders', W1.token);
    check('O', 'Purchase Orders list: vendor 1 sees its PO document and its order (not the Agreement, not vendor 2\'s PO)', r.status === 200 && r.body.total === 2 && r.body.rows.some((x) => x.poNumber === `ZZ PO-1 ${RUN}`) && r.body.rows.some((x) => x.poNumber === `IDC-ZZ-${RUN}`) && !r.text.includes('Agreement') && !r.text.includes('PO-2') && r.body.summary.count === 2, r.body.rows && r.body.rows.map((x) => x.poNumber));
    const ord = r.body.rows.find((x) => x.poNumber === `IDC-ZZ-${RUN}`);
    r = await http('GET', `/api/vendor-portal/records/purchase-orders/${encodeURIComponent(ord.id)}`, W1.token);
    check('O', 'PO detail: items with quantity 2, status In printing, unknown price shown as empty (nothing invented)', r.status === 200 && r.body.purchaseOrder.items[0].quantity === 2 && r.body.purchaseOrder.statusText === 'In printing' && r.body.purchaseOrder.items[0].unitPrice === null, r.body);
    r = await http('GET', '/api/vendor-portal/records/purchase-orders', W2.token);
    check('O', 'Vendor 2 sees only its own PO', r.body.total === 1 && r.body.rows[0].poNumber === `ZZ PO-2 ${RUN}`, r.body.rows);
    const po1doc = await prisma.vendorSharedDocument.findFirst({ where: { vendorId: V1.id, title: `ZZ PO-1 ${RUN}` } });
    // ownership of files
    r = await http('POST', '/api/vendor-portal/download-link', W1.token, { kind: 'shared', id: po1doc.id });
    const own = r;
    check('O', 'downloads: the owner gets a signed, expiring link ...', r.status === 200 && /\/api\/vendor-portal\/files\//.test(r.body.url) && r.body.expiresInSeconds <= 180, r.body);
    const fileRes = await fetch(`${API}${own.body.url}`, { headers: { 'X-Forwarded-For': randIp() } });
    check('O', '... which opens the file', fileRes.status === 200 && (await fileRes.arrayBuffer()).byteLength > 10);
    r = await http('POST', '/api/vendor-portal/download-link', W2.token, { kind: 'shared', id: po1doc.id });
    check('O', 'another vendor asking for it gets 403 (same as a missing file)', r.status === 403, r.body);
    const badUrl = own.body.url.slice(0, -2) + (own.body.url.endsWith('AA') ? 'BB' : 'AA');
    check('O', 'a tampered link is refused (403)', (await fetch(`${API}${badUrl}`, { headers: { 'X-Forwarded-For': randIp() } })).status === 403);
    const v1bill = (await raw('SELECT "id" FROM "VendorModuleBill" WHERE "vendorId" = ? LIMIT 1', V1.id))[0];
    r = await http('POST', '/api/vendor-portal/download-link', W2.token, { kind: 'module-bill', id: v1bill.id });
    check('O', 'another vendor asking for vendor 1\'s invoice file: 403', r.status === 403, r.body);
    r = await http('POST', '/api/vendor-portal/download-link', W2.token, { kind: 'po-challan', id: `zzord${RUN}` });
    check('O', 'another vendor asking for vendor 1\'s order challan: 403', r.status === 403);
    // ID manipulation
    r = await http('GET', `/api/vendor-portal/records/invoices/${encodeURIComponent(invKey)}`, W2.token);
    check('O', 'IDOR: vendor 2 opening vendor 1\'s invoice key -> 403 (same words as a missing one)', r.status === 403, r.body);
    r = await http('GET', `/api/vendor-portal/records/invoices/${encodeURIComponent('mod:does-not-exist')}`, W2.token);
    check('O', '...and a key that does not exist answers the same', r.status === 403 && r.body.error === 'Forbidden. This is not yours.');
    r = await http('GET', `/api/vendor-portal/records/payments/${encodeURIComponent(payKey)}`, W2.token);
    check('O', 'IDOR: payment key of another vendor -> 403', r.status === 403);
    r = await http('GET', `/api/vendor-portal/records/purchase-orders/${encodeURIComponent(ord.id)}`, W2.token);
    check('O', 'IDOR: purchase order of another vendor -> 403', r.status === 403);
    r = await http('GET', `/api/vendor-portal/records/invoices?vendorId=${V1.id}&vendorUserId=${W1.u.id}&pageSize=100`, W2.token);
    check('O', 'vendor id / user id in the QUERY are ignored: vendor 2 still gets only its own', r.body.total === 2 && !r.text.includes(`ZZ-INV-A-${RUN}`), r.body.total);
    r = await http('GET', `/api/vendor-portal/records/overview?vendorId=${V1.id}`, W2.token);
    check('O', 'vendor id in the query of the Dashboard is ignored too', r.body.invoices.total === 2 && r.body.payments.received === 777, r.body.invoices);
    r = await http('POST', '/api/vendor-portal/records/invoices', W2.token, { vendorId: V1.id, total: 1 });
    check('O', 'nothing under /records accepts a write (POST -> 403)', r.status === 403);
    r = await http('PATCH', `/api/vendor-portal/records/invoices/${encodeURIComponent(invKey)}`, W1.token, { total: 1 });
    check('O', '...nor PATCH / DELETE (read only)', r.status === 403 && (await http('DELETE', `/api/vendor-portal/records/invoices/${encodeURIComponent(invKey)}`, W1.token)).status === 403);
    r = await http('GET', '/api/vendor-portal/records/overview', null);
    check('O', 'no sign-in: 401', r.status === 401);
    r = await http('GET', '/api/vendor-portal/records/overview', T.admin);
    check('O', 'a STAFF token is not a vendor session: 401 / 403', [401, 403].includes(r.status), r.status);

    // =============================================================== P  the wall: the removed modules are gone from the API too, and the rest of the app is out of reach
    const wall = ['/assets', '/assets/x', '/documents', '/profile', '/id-card-orders', '/sim', '/office', '/expenses', '/payments', '/bills/x', '/dashboard', '/invoices', '/module-bills/x/zzz'];
    const wres = [];
    for (const p of wall) { const x = await http('GET', `/api/vendor-portal${p}`, W1.token); wres.push([p, x.status, x.body && x.body.notAvailable]); } // eslint-disable-line no-await-in-loop
    check('P', 'vendor API paths of the removed modules answer 403 "not available" (assets, documents, profile, ID cards, SIM, office, expenses, old payments, old invoices ...)', wres.filter(([p]) => p !== '/module-bills/x/zzz').every(([, s, na]) => s === 403 && na === true), wres);
    for (const [m, p] of [['POST', '/api/vendor-portal/assets/x/bills'], ['PATCH', '/api/vendor-portal/assets/x'], ['POST', '/api/vendor-portal/id-card-orders/x/status']]) {
      r = await http(m, p, W1.token, {});
      check('P', `${m} ${p.replace('/api/vendor-portal', '')} is not available either`, r.status === 403 && r.body.notAvailable === true, r.body);
    }
    check('P', 'sign-in, activation, forgot-password and confirm-email stay public', (await http('GET', '/api/vendor-portal/status')).status === 200 && (await http('POST', '/api/vendor-portal/forgot-password', null, { email: 'x@example.test' })).status === 200);
    const staffApis = ['/api/vendor-logins', '/api/vendor-master', '/api/employees', '/api/candidates', '/api/invoices', '/api/clients', '/api/admin/users', '/api/office-expenses/vendors', '/api/payroll', '/api/requirements', '/api/auth/me'];
    const sres = [];
    for (const p of staffApis) { const x = await http('GET', p, W1.token); sres.push([p, x.status]); } // eslint-disable-line no-await-in-loop
    check('P', 'a vendor session cannot reach Admin / HRMS / ATS / Accounts / recruiter APIs (all 403)', sres.every(([, s]) => s === 403), sres);
    const nsres = [];
    for (const p of staffApis.slice(0, 5)) { const x = await http('GET', p, null); nsres.push(x.status); } // eslint-disable-line no-await-in-loop
    check('P', 'and without any sign-in those staff APIs say 401', nsres.every((s) => s === 401), nsres);

    // =============================================================== R  nothing else changed
    const sha256f = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(BACK, '..', f))).digest('hex');
    const BASE_HASH = {
      'frontend/src/nav.js': '709e288db8797bb6e2c4f853794c23fd2873bcdf13a286ed697d0f416041ef88',
      'frontend/src/permissions.js': '99b0679c4cad6fbaba5e52a96f965ef869641082383eb85c627a3c1ef5209c26',
      'backend/src/utils/permissions.js': '5b2940a6f51ee1731b18d845ef451236a34cd5bee2c5421510643eabcba0f150',
      'backend/src/utils/roleRegistry.js': 'edd0d8a1fbf04b026555b5689a56d39f947e8adeb1edf5f445f51b5575f1a3a5',
      'backend/src/utils/roleAccess.js': '871b71ad5f51b473e9b96395e5ead597c99710140a9182bab8491dea88a3342c',
      'backend/src/middleware/auth.js': '933958ac29b47e33652890a4d0ba7970d3311fbfec45cfcb3b50826215ddc3a4', // re-baselined 2026-10-21: per-login sign-out check (separate logins on one email)
      'backend/src/utils/identity.js': 'cc1df23ec6859dad4920a476440e87ee48cfe04f29637a0543f951c48f5145c8', // re-baselined 2026-10-21: extra-login Employee link (email-only identity)
    };
    check('R', 'staff navigation (Admin / Accounts / HRMS / ATS) and the permission engine are byte-for-byte the files they were before this work (hash baseline taken before the vendor changes)', Object.entries(BASE_HASH).every(([f, h]) => sha256f(f) === h), Object.entries(BASE_HASH).filter(([f, h]) => sha256f(f) !== h).map(([f]) => f));
    r = await http('GET', '/api/vendor-master', T.admin);
    check('R', 'Admin still opens the vendor list; Accountant still reaches Office vendors; Recruiter is still refused', r.status === 200 && (await http('GET', '/api/office-expenses/vendors', T.acc)).status === 200 && (await http('GET', '/api/vendor-master', T.rec)).status === 403);
    const countsEnd = await cnt();
    check('R', 'existing vendors, vendor logins, bills, shared documents, orders, assets, repairs, invoices and clients are all still there (row counts before = after, test rows excluded)', JSON.stringify(countsEnd) === JSON.stringify(countsStart), [countsStart, countsEnd]);

    // =============================================================== L  final sweep
    const allMails = mails();
    const allTokens = allMails.map(linkOf).filter(Boolean).map((l) => l.token);
    let leaked = 0;
    for (const t of allTokens) { if ((await dbHas(t, TABLES)).length) leaked += 1; }
    check('L', `none of the ${allTokens.length} raw tokens that were emailed is stored anywhere in the database`, leaked === 0, leaked);
    check('L', 'none of them appears in the server log', allTokens.every((t) => !serverLog.includes(t)));
    const tempPws = [...new Set(allMails.filter((m) => tempOf(m)).map((m) => tempOf(m)))];
    const chosenPws = [pwB, pwF, pwF2, pwG, pwH, pwH2, pwH3];
    let chosenLeak = 0; let tempLeak = 0;
    for (const p of chosenPws) { if ((await dbHas(p, TABLES)).length || serverLog.includes(p) || allMails.some((m) => m.text.includes(p) || m.html.includes(p))) chosenLeak += 1; }
    for (const t of tempPws) { if ((await dbHas(t, TABLES)).length || serverLog.includes(t) || allMails.filter((m) => m.text.includes(t)).length !== 1) tempLeak += 1; }
    check('L', 'passwords the vendors chose appear in no table, no log and no email', chosenLeak === 0, chosenLeak);
    check('L', `each of the ${tempPws.length} temporary passwords appears in exactly ONE email and in no table, audit row, notification or server log`, tempLeak === 0 && tempPws.length >= 10, [tempLeak, tempPws.length]);
    check('L', 'only the welcome (invitation) emails carry a password line, exactly one (temporary); reset / confirmation / notice emails carry none', allMails.every((m) => { const n = (m.text.match(/password\s*:\s*\S/gi) || []).length; return /Welcome/i.test(m.subject) || m.subject.startsWith(mark) ? n === 1 : n === 0; }), allMails.filter((m) => (m.text.match(/password\s*:\s*\S/gi) || []).length && !/Welcome/i.test(m.subject)).map((m) => m.subject));
    check('L', 'every email has a plain-text twin AND an HTML body', allMails.every((m) => m.text.length > 100 && /<html/i.test(m.html)));
    check('L', 'every email has the brand, the support contact and the "automatic email" footer', allMails.filter((m) => !m.subject.startsWith(mark)).every((m) => /TeamLink Consultants/.test(m.html) && /support@teamlink\.example\.test/.test(m.html) && /automatic email/i.test(m.html)));
    check('L', 'sender is the company mailbox with the brand name (never a person)', allMails.every((m) => /^TeamLink Consultants <noreply@teamlink\.example\.test>$/.test(m.from)), allMails[0] && allMails[0].from);
    const dedupe = await raw('SELECT "dedupeKey", COUNT(*) AS n FROM "VendorMailLog" GROUP BY "dedupeKey" HAVING n > 1');
    check('L', 'no attempt key is used twice', dedupe.length === 0);
    const sentRows = await raw(`SELECT COUNT(*) AS n FROM "VendorMailLog" WHERE "status" IN ('accepted','delivered','bounced') AND "toEmail" LIKE 'zz-vle-%'`);
    const mailedAddrs = allMails.length;
    const perAddr = await raw(`SELECT "toEmail", COUNT(*) AS n FROM "VendorMailLog" WHERE "status" IN ('accepted','delivered','bounced') AND "toEmail" LIKE 'zz-vle-%' GROUP BY "toEmail"`);
    const mismatch = perAddr.filter((p) => mailsTo(p.toEmail).length !== p.n).map((p) => `${p.toEmail}: rows ${p.n}, mails ${mailsTo(p.toEmail).length}`);
    check('L', 'every accepted attempt has exactly one captured email (nothing sent without a record, no record without a send)', sentRows[0].n + stuckMails === mailedAddrs, [sentRows[0].n, stuckMails, mailedAddrs, mismatch]);
    check('L', 'the vendor master data was not touched by any of this (name / email / phone of the test vendors)', (await prisma.officeVendor.findUnique({ where: { id: V1.id } })).email === null);
  } catch (err) {
    fail += 1; console.error('FAIL  test crashed:', err && err.stack ? err.stack : err);
  } finally {
    if (server) { try { server.kill(); } catch { /* ignore */ } }
    await sleep(500);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    for (const f of [CAPTURE, FAILFILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    if (madeCopy && !process.env.KEEP_COPY) { for (const x of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(x); } catch { /* none */ } } }
    if (fail) {
      const errs = serverLog.split('\n').filter((l) => /error|P\d{4}|locked|timed out/i.test(l)).slice(0, 12);
      if (errs.length) console.log(`\n--- server log (errors) ---\n${errs.join('\n')}`);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
