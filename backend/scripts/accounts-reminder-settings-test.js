#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHO GETS EACH ACCOUNTS REMINDER - THE ADMIN'S TABLE (founder follow-up, 2026-10-21). COPY DATABASE ONLY, NO REAL MESSAGE.
//   cd backend
//   node scripts/accounts-reminder-settings-test.js        makes its own VACUUM INTO copy of the real database (read-only on the source)
//
// Own throw-away API (port 4075, TEST_MODE, fake mail with capture) on the copy. Proves: the defaults (Purna Chandra by employee code TL309 + the
// Accountant role, daily summary 09:30 and 17:00, WhatsApp + Email + Bell), who may use the screen (Admin / Super Admin only), saving recipients (role,
// named people, person only), ways (no e-mail), On / Off, the plain validation messages (also server side), timing through the real scheduler,
// audit old -> new, a switched-off recipient (skipped, warning chip, one "No one will receive" notice), Reset to default, "Send me a test" (only the
// Admin who clicked), the earlier single tick as a preset, and the plain statuses (no WhatsApp number / no e-mail on file).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
let madeCopy = false;
if (!copy) {
  copy = path.join(os.tmpdir(), `ars-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4075);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `ars-uploads-${RUN}`);
const MAILS = path.join(os.tmpdir(), `ars-mail-${RUN}.jsonl`);
fs.mkdirSync(UPLOADS, { recursive: true });
fs.writeFileSync(MAILS, '');
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=120`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = UPLOADS;
process.env.TEST_MAIL_CAPTURE = MAILS;
process.env.ACCOUNTS_REMINDERS_ALLOW_TEST = '1'; // the test logins may take part (the real server never sets this)
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const groupCount = {};
const check = (g, n, ok, d) => {
  if (ok) pass += 1; else fail += 1;
  groupCount[g] = groupCount[g] || { pass: 0, fail: 0 }; groupCount[g][ok ? 'pass' : 'fail'] += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const PWD = (t) => `Qv#7${t}Lm!${RUN}9`;

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (opt.form) payload = opt.form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ZZTEST ${tag} ${RUN}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
const upload = (buf, name, type, fields = {}) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  fd.append('file', new Blob([buf], { type }), name);
  return fd;
};
const mailsSince = (mark) => fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(mark);
const mailCount = () => fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).length;
const addrOf = (s) => String(s || '').replace(/^.*</, '').replace(/>.*$/, '').trim().toLowerCase();

const made = { users: [], emps: [], vendors: [], vlogins: [] };

(async () => {
  let server; let serverLog = '';
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: UPLOADS, APP_BASE_URL: 'http://localhost:5183' } });
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    const AC = require(path.join(BACK, 'src/utils/accountsControl'));
    const AR = require(path.join(BACK, 'src/utils/accountsRecipients'));
    const PR = require(path.join(BACK, 'src/utils/proofReminders'));
    const RS = require(path.join(BACK, 'src/utils/accountsReminderSettings'));
    const VC = require(path.join(BACK, 'src/utils/vendorConfig'));

    // ------------------------------------------------------------------ fixtures
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra, emp = { phone: `98765${String(crypto.randomInt(10000, 99999))}` }, userExtra = {}) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST RS ${tag} ${RUN}`, email: `zz-rs-${tag}-${RUN}@example.test`, username: `zz-rs-${tag}-${RUN}@example.test`, ...extra, ...userExtra } });
      made.users.push(u.id);
      if (emp) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-RS-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', email: u.email || null, ...emp } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const adm = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const sa = await mk('super', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const acc1 = await mk('acc1', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const mgr = await mk('manager', { role: 'MANAGER', atsRole: 'MANAGER', accountsRole: 'MANAGER', atsAccess: true, accountsAccess: true });
    const hrp = await mk('hrperson', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true });
    const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true });
    const gone = await mk('inactive', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true, status: 'Inactive' });
    const ghost = await mk('nocontact', { role: 'EMPLOYEE', accountsAccess: true, accountsRole: 'NONE' }, null, { email: '' });
    const mailless = await mk('mailless', { role: 'EMPLOYEE', accountsAccess: true, accountsRole: 'MANAGER' }, { phone: '9876512345', email: null });
    const T = { adm: await tok(adm), sa: await tok(sa), acc: await tok(acc1), rec: await tok(rec), hr: await tok(hrp) };
    const saId = await resolveIdentity(sa.id);
    const purnaEmp = await prisma.employee.findFirst({ where: { employeeCode: 'TL309' }, select: { userId: true, phone: true } });
    const purna = await prisma.user.findUnique({ where: { id: purnaEmp.userId }, select: { id: true, name: true, email: true } });
    const realAdmins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { accountsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true } });
    const ADMINLIKE = [adm.id, sa.id, ...realAdmins.map((u) => u.id)];

    const rowsSince = (t, re, extra = {}) => prisma.notification.findMany({ where: { createdAt: { gte: t }, ...extra } }).then((rs) => rs.filter((n) => re.test(n.title || '')));
    const idsOf = (rows) => [...new Set(rows.map((n) => n.userId).filter(Boolean))];
    const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const get = async () => (await http('GET', '/api/accounts-reminders', T.adm)).body;
    const rowOf = async (key) => (await get()).rows.find((r) => r.key === key);
    const put = (key, body, token = T.adm) => http('PUT', `/api/accounts-reminders/${key}`, token, body);

    // vendor (finance) for the vendor-invoice reminder
    const IT = 'IT / Hardware / AMC / Service';
    const v = await prisma.officeVendor.create({ data: { name: `ZZTEST RS Vendor ${RUN}`, companyName: 'ZZTEST RS Co', isActive: true, category: IT, email: `zz-rs-v-${RUN}@example.test` } });
    made.vendors.push(v.id);
    const pw = `Qv#7fin${RUN}9`;
    const vu = await prisma.vendorUser.create({ data: { vendorId: v.id, name: 'ZZTEST Contact', email: `zz-rs-fin-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit: true, canViewCost: true } });
    made.vlogins.push(vu.id);
    const nowMs = Date.now();
    for (const k of ['invoices', 'payments']) await raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzrs${k}${vu.id}`.slice(0, 40), vu.id, k, '{}', nowMs, nowMs);
    const vlog = await http('POST', '/api/vendor-portal/login', null, { email: vu.email, password: pw });
    const VT = vlog.body && vlog.body.token;
    check('0', 'the finance vendor signed in', !!VT);
    let invNo = 0;
    const sendInvoice = async () => { invNo += 1; const r = await http('POST', '/api/vendor-portal/module-bills?kind=invoice', VT, undefined, { form: upload(pdf(`inv${invNo}`), `inv${invNo}.pdf`, 'application/pdf', { billNumber: `ZZRS-${RUN}-${invNo}`, billDate: new Date().toISOString().slice(0, 10), amount: '1200', gst: '216' }) }); await sleep(450); return r; };
    const whoGot = async (t, re) => { const rs = await rowsSince(t, re, { channel: null }); return idsOf(rs); };

    // ============================ S1 the defaults
    let g = await http('GET', '/api/accounts-reminders', T.adm);
    check('S1', 'the Admin opens the table: 10 reminders', g.status === 200 && g.body.rows.length === 10, g.status);
    const kinds = g.body.rows.map((r) => r.key);
    check('S1', 'every row is the default (not changed), ON, Accountant role as a role chip', g.body.rows.every((r) => !r.custom && r.on && r.roles.length === 1 && r.roles[0].code === 'ACCOUNTANT') || g.body.rows.filter((r) => r.key === 'proofDaily').every((r) => !r.custom), kinds);
    const withPurna = ['proofBell', 'proofDaily', 'vendorBill', 'vendorInvoice', 'repairInvoice', 'repairCost', 'partnerPayout', 'invoiceReady'];
    check('S1', 'Purna Chandra (TL309) is a named person chip on the 8 reminder rows that are about money notices and the daily summary, and on no other', g.body.rows.every((r) => (withPurna.includes(r.key) ? r.people.length === 1 && r.people[0].id === purna.id : r.people.length === 0)), g.body.rows.map((r) => [r.key, r.people.map((p) => p.name)]));
    const daily = g.body.rows.find((r) => r.key === 'proofDaily');
    check('S1', 'the daily summary defaults: ON, 09:30 and 17:00, WhatsApp + Email + Bell all on', daily.on && daily.timing.find((t) => t.id === 'time1').value === '09:30' && daily.timing.find((t) => t.id === 'time2').value === '17:00' && ['whatsapp', 'email', 'bell'].every((c) => daily.channels.find((x) => x.id === c && x.on)), { on: daily.on, timing: daily.timing.map((t) => t.value), ch: daily.channels.map((c) => [c.id, c.on]) });
    const vi = g.body.rows.find((r) => r.key === 'vendorInvoice');
    check('S1', 'a person with no Accounts access shows the plain caution chip (a warning, not a block)', vi.warnings.some((w) => w.includes(purna.name) && w.includes('Can receive the message but cannot open Accounts screens.')), vi.warnings);
    check('S1', 'a vendor row offers Bell (always) and Email only; the daily row offers WhatsApp, Email and Bell', vi.channels.map((c) => c.id).join() === 'bell,email' && vi.channels[0].fixed === true && daily.channels.map((c) => c.id).join() === 'whatsapp,email,bell');

    // ============================ S2 who may use the screen
    for (const [who, tk] of [['an Accountant', T.acc], ['a recruiter', T.rec], ['HR', T.hr]]) {
      const rr = [await http('GET', '/api/accounts-reminders', tk), await http('GET', '/api/accounts-reminders/people', tk), await put('vendorInvoice', { on: true, roles: ['ACCOUNTANT'] }, tk), await http('POST', '/api/accounts-reminders/vendorInvoice/reset', tk, {}), await http('POST', '/api/accounts-reminders/vendorInvoice/test', tk, {}), await http('PUT', '/api/accounts-reminders/preset', tk, { preset: 'also-admin' })];
      check('S2', `${who} cannot read or change anything (all 6 calls are 403)`, rr.every((x) => x.status === 403), rr.map((x) => x.status));
    }
    check('S2', 'no login = 401', (await http('GET', '/api/accounts-reminders', null)).status === 401);
    check('S2', 'nothing changed by those refused calls', (await rowOf('vendorInvoice')).custom === false);

    // ============================ S3 / S4 / S5 a vendor invoice, with the Admin's own choice
    let t = new Date(Date.now() - 20);
    let m = mailCount();
    let r = await sendInvoice();
    let got = await whoGot(t, /waiting for your check/);
    check('S3', 'default: the vendor invoice reaches Purna only (no Accountant exists yet besides acc1): Purna + the Accountant', r.status === 201 && sameSet(got, [purna.id, acc1.id]), got);
    r = await put('vendorInvoice', { on: true, roles: ['ACCOUNTANT'], people: [mgr.id] });
    check('S3', 'the Admin replaces Purna by a named Manager (Accountant role kept): saved (200)', r.status === 200, r.body);
    t = new Date(Date.now() - 20); m = mailCount();
    await sendInvoice();
    got = await whoGot(t, /waiting for your check/);
    const mails = mailsSince(m).filter((x) => /waiting for your check/.test(x.subject)).map((x) => addrOf(x.to));
    check('S3', 'now exactly the Accountant and the Manager get it (bell), Purna and the Admins do not', sameSet(got, [acc1.id, mgr.id]) && !ADMINLIKE.some((id) => got.includes(id)) && !got.includes(purna.id), got);
    check('S3', 'and the e-mail goes to those two addresses only', sameSet(mails, [acc1.email, mgr.email].map((e) => e.toLowerCase())), mails);
    r = await put('vendorInvoice', { roles: [], people: [mgr.id] });
    t = new Date(Date.now() - 20);
    await sendInvoice();
    got = await whoGot(t, /waiting for your check/);
    check('S4', 'person-only: no role, one named person: only that person gets it', r.status === 200 && sameSet(got, [mgr.id]), got);
    r = await put('vendorInvoice', { channels: ['bell'] });
    t = new Date(Date.now() - 20); m = mailCount();
    await sendInvoice();
    got = await whoGot(t, /waiting for your check/);
    check('S5', 'Email unticked: the bell still goes, no e-mail is sent to anyone', r.status === 200 && sameSet(got, [mgr.id]) && mailsSince(m).filter((x) => /waiting for your check/.test(x.subject)).length === 0, got);
    r = await put('vendorInvoice', { on: false });
    t = new Date(Date.now() - 20);
    await sendInvoice();
    check('S5', 'switched OFF: nothing is sent, and nobody is warned about "no one" (OFF is a choice)', (await rowsSince(t, /waiting for your check|No one will receive|No accountant/)).length === 0);

    // ============================ S6 validation
    const bad = async (key, body, text, label) => { const x = await put(key, body); check('S6', label, x.status === 400 && x.body.error === text || (x.status === 400 && x.body.error.startsWith(text)), [x.status, x.body]); };
    await bad('vendorBill', { on: true, roles: [], people: [] }, 'Choose at least one person or role.', 'ON with no role and no person: 400 "Choose at least one person or role."');
    await bad('proofDaily', { on: true, channels: [] }, 'Choose at least one way to send.', 'daily summary with no way to send: 400 "Choose at least one way to send."');
    await bad('proofDaily', { timing: { time1: '25:00' } }, 'Morning time (India time): write the time like 10:00', 'a time that is not a time: 400 with the field named');
    await bad('proofBell', { timing: { repeatDays: 0 } }, 'Do not remind about the same proof again for (days): a whole number from 1 to 30', 'days below the range: 400');
    await bad('proofBell', { timing: { repeatDays: 99 } }, 'Do not remind about the same proof again for (days): a whole number from 1 to 30', 'days above the range: 400');
    await bad('proofBell', { timing: { repeatDays: 'abc' } }, 'Do not remind about the same proof again for (days): a whole number from 1 to 30', 'days that are not a number: 400');
    await bad('nothing', { on: true }, 'Unknown reminder.', 'an unknown reminder: 400');
    await bad('vendorBill', { roles: ['KING'] }, 'One of the roles is not known.', 'an unknown role: 400');
    await bad('vendorInvoice', { channels: ['bell', 'whatsapp'] }, 'One of the ways to send is not available for this reminder.', 'a way the reminder does not have (WhatsApp on a vendor notice): 400');
    await bad('vendorBill', { roles: [], people: [gone.id] }, `${gone.name} is switched off, so cannot be chosen.`, 'a switched-off person cannot be chosen: 400');
    await bad('vendorBill', { roles: [], people: [ghost.id] }, `${ghost.name} has no WhatsApp number and no email on file`, 'a person with no WhatsApp number and no e-mail cannot be chosen: 400');
    await prisma.user.delete({ where: { id: ghost.id } }); made.users.splice(made.users.indexOf(ghost.id), 1); // only one login may have an empty e-mail
    r = await put('vendorBill', { roles: [], people: [hrp.id] });
    check('S6', 'a person with NO Accounts access (the HR person) can be chosen: saved, with the plain caution as a warning', r.status === 200 && r.body.warnings.some((w) => w.includes('Can receive the message but cannot open Accounts screens.')), r.body);
    const byRole = await http('PUT', '/api/accounts-reminders/vendorBill', T.adm, { on: true, roles: ['MANAGER'], people: [] });
    check('S6', 'a role the Admin did not name before (Manager) is fine', byRole.status === 200, byRole.body);

    // ============================ S7 audit
    const aud = await prisma.auditLog.findMany({ where: { action: 'Accounts reminder recipients changed', entityId: 'vendorInvoice' }, orderBy: { createdAt: 'asc' } });
    check('S7', 'every change is audited with old -> new, names only: Purna was replaced by the Manager', aud.length >= 3 && aud[0].fromValue.includes(purna.name) && aud[0].toValue.includes(mgr.name) , aud.slice(0, 1).map((a) => [a.fromValue, a.toValue]));

    // ============================ S8 timing
    r = await put('proofDaily', { on: true, timing: { time1: '08:15', time2: '16:45' } });
    const st = await PR.getSettings();
    check('S8', 'the Admin sets 08:15 and 16:45: the proof reminder\'s own settings follow (one source of truth)', r.status === 200 && st.time1 === '08:15' && st.time2 === '16:45' && st.enabled === true, st);
    const calls = [];
    const trs = { async whatsapp(x) { calls.push({ ch: 'WhatsApp', ...x }); return { ok: true }; }, async email(x) { calls.push({ ch: 'Email', ...x }); return { ok: true }; } };
    const recs = [{ key: 'expense:ZZ1', kind: 'expense', id: 'ZZ1', party: 'Vendor ZZ', ref: 'BILL-ZZ1', amount: 1500, paidOn: '2026-10-10', proofType: 'Expense bill', who: { ids: [acc1.id], own: true, name: 'x' } }];
    const dayOf = (n) => new Date(Date.now() + 330 * 60000 + (430 + n) * 86400000).toISOString().slice(0, 10);
    const tk = (day, hhmm) => PR.tick({ now: new Date(PR.atIst(day, hhmm)), transports: trs, pending: async () => recs, allowTest: true, extras: [] });
    await tk(dayOf(0), '08:00');
    check('S8', 'at 08:00 (before the new morning time) nothing is sent', calls.length === 0);
    await tk(dayOf(0), '08:20');
    check('S8', 'at 08:20 the morning round runs: the accountant gets WhatsApp + Email', calls.length === 2 && calls.every((c) => c.userId === acc1.id), calls.length);
    await tk(dayOf(0), '16:50');
    check('S8', 'at 16:50 the evening round runs (16:45)', calls.length === 4);
    r = await put('proofDaily', { timing: { time1: '09:30', time2: '17:00' } });

    // the bell's "do not remind again for N days"
    const data1 = await AC.buildControl(saId, { fresh: '1' });
    const key1 = data1.proof.records[0].key;
    await put('proofBell', { on: true, roles: ['ACCOUNTANT'], people: [] , timing: { repeatDays: 3 } });
    const mine = (tt) => rowsSince(tt, /Proof missing/);
    let tb = new Date(Date.now() - 20);
    const s1 = await AC.remind(saId, [key1]);
    check('S8', 'the bell reminder goes (repeat every 3 days)', s1.sent === 1 && (await mine(tb)).length === 1, s1);
    await prisma.notification.updateMany({ where: { createdAt: { gte: tb }, title: { startsWith: 'Proof missing' } }, data: { read: true, createdAt: new Date(Date.now() - 2 * 86400000) } });
    const s2 = await AC.remind(saId, [key1]);
    check('S8', 'two days later, read: with "3 days" it is NOT repeated (skipped)', s2.sent === 0 && s2.skipped === 1, s2);
    await put('proofBell', { timing: { repeatDays: 1 } });
    const s3 = await AC.remind(saId, [key1]);
    check('S8', 'with "1 day" the same proof is reminded again', s3.sent === 1, s3);
    await put('proofBell', { on: false });
    const s4 = await AC.remind(saId, [key1]);
    check('S8', 'bell reminder switched OFF: nothing is sent (honest "off" answer)', s4.sent === 0 && s4.off === true, s4);

    // ============================ S9 a deactivated recipient, and "no one will receive"
    await put('vendorBill', { on: true, roles: [], people: [mgr.id], channels: ['bell'] });
    let row = await rowOf('vendorBill');
    check('S9', 'before: one person, no warning chip', row.people.length === 1 && !row.warnings.some((w) => /switched off|No one will receive/.test(w)), row.warnings);
    await prisma.user.update({ where: { id: mgr.id }, data: { status: 'Inactive' } });
    row = await rowOf('vendorBill');
    check('S9', 'the person is switched off: the row shows a warning chip naming them, and "No one will receive this reminder"', row.warnings.some((w) => w.includes(`${mgr.name} is switched off`)) && row.warnings.some((w) => w.startsWith('No one will receive')) && row.people[0].active === false, row.warnings);
    check('S9', 'the resolver skips the switched-off person', (await VC.billReviewers('vendorBill')).length === 0);
    await sleep(300);
    const notes = await prisma.notification.findMany({ where: { title: 'No one will receive: Vendor bill is waiting for a check' } });
    const admIds = (await AR.admins({ allowTest: true })).map((u) => u.id);
    check('S9', 'each Admin got exactly ONE "No one will receive" notice', sameSet(idsOf(notes), admIds) && notes.length === admIds.length, notes.length);
    await VC.billReviewers('vendorBill');
    check('S9', 'asking again adds no second notice (deduplicated)', (await prisma.notification.count({ where: { title: 'No one will receive: Vendor bill is waiting for a check' } })) === admIds.length);
    await prisma.user.update({ where: { id: mgr.id }, data: { status: 'Active' } });

    // ============================ S10 reset
    r = await http('POST', '/api/accounts-reminders/vendorInvoice/reset', T.adm, {});
    row = await rowOf('vendorInvoice');
    check('S10', 'Reset to default: Purna + the Accountant role again, both ways on, ON, not "Changed"', r.status === 200 && !row.custom && row.on && row.people.length === 1 && row.people[0].id === purna.id && row.roles[0].code === 'ACCOUNTANT' && row.channels.every((c) => c.on), row);
    t = new Date(Date.now() - 20);
    await sendInvoice();
    check('S10', 'and a vendor invoice reaches them again', sameSet(await whoGot(t, /waiting for your check/), [purna.id, acc1.id]));
    check('S10', 'the reset is audited', !!(await prisma.auditLog.findFirst({ where: { action: 'Accounts reminder recipients reset to default', entityId: 'vendorInvoice' } })));

    // ============================ S11 "Send me a test"
    const tt0 = new Date(Date.now() - 20); const mm0 = mailCount();
    r = await http('POST', '/api/accounts-reminders/vendorInvoice/test', T.adm, {});
    await sleep(300);
    const testRows = await rowsSince(tt0, /\[TEST\]/);
    const testMails = mailsSince(mm0).filter((x) => /\[TEST\]/.test(x.subject));
    check('S11', '"Send me a test": a [TEST] bell for the Admin who clicked and nobody else', r.status === 200 && testRows.length >= 1 && testRows.every((n) => n.userId === adm.id), testRows.map((n) => n.userId));
    check('S11', 'and the [TEST] e-mail only to that Admin\'s own address (the Vendor emails switch is ON in the copy)', testMails.length === 1 && addrOf(testMails[0].to) === adm.email.toLowerCase(), testMails.map((x) => x.to));
    r = await http('POST', '/api/accounts-reminders/proofDaily/test', T.adm, {});
    check('S11', 'the daily summary test also answers 200 and reaches no one else', r.status === 200 && (await rowsSince(tt0, /\[TEST\]/)).every((n) => n.userId === adm.id));

    // ============================ S12 the earlier single tick, now a preset
    await http('PUT', '/api/accounts-reminders/preset', T.adm, { preset: 'accountant-only' });
    r = await http('PUT', '/api/accounts-reminders/preset', T.adm, { preset: 'also-admin' });
    const after = await get();
    check('S12', 'preset "Also the Admin and Super Admin": every money row now has Accountant, Admin and Super Admin roles, Purna stays', r.status === 200 && after.rows.filter((x) => !['agreementSigned'].includes(x.key)).every((x) => ['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN'].every((c) => x.roles.find((y) => y.code === c)) && (!withPurna.includes(x.key) || x.people.some((p) => p.id === purna.id))), after.rows.map((x) => [x.key, x.roles.map((y) => y.code).join('+')]).slice(0, 3));
    t = new Date(Date.now() - 20);
    await sendInvoice();
    const allAdmins = (await AR.admins({ allowTest: true })).map((u) => u.id);
    got = await whoGot(t, /waiting for your check/);
    check('S12', 'then a vendor invoice reaches Purna, the Accountant and every Admin / Super Admin', sameSet(got, [purna.id, acc1.id, ...allAdmins]), got.length);
    r = await http('PUT', '/api/accounts-reminders/preset', T.adm, { preset: 'accountant-only' });
    const back = await get();
    check('S12', 'preset "Use the default for all": every row is the default again', r.status === 200 && back.rows.every((x) => !x.custom || x.key === 'proofDaily'), back.rows.filter((x) => x.custom).map((x) => x.key));

    // ============================ S13 the plain statuses on the row
    await prisma.employee.update({ where: { employeeCode: 'TL309' }, data: { phone: null } });
    row = await rowOf('proofDaily');
    check('S13', 'no WhatsApp number on file: the row says so plainly with his name (never the number)', row.warnings.includes(`No WhatsApp number on file for ${purna.name}.`), row.warnings);
    await prisma.employee.update({ where: { employeeCode: 'TL309' }, data: { phone: purnaEmp.phone } });
    r = await put('proofDaily', { roles: ['ACCOUNTANT'], people: [mailless.id, purna.id] });
    await prisma.user.update({ where: { id: mailless.id }, data: { email: '' } });
    row = await rowOf('proofDaily');
    check('S13', 'no e-mail on file: the row says "No email on file for <name>."', r.status === 200 && row.warnings.includes(`No email on file for ${mailless.name}.`), row.warnings);
    await http('POST', '/api/accounts-reminders/proofDaily/reset', T.adm, {});
  } catch (e) {
    fail += 1;
    console.log(`FAIL  [crash] ${e && e.stack ? e.stack : e}`);
  } finally {
    try {
      const ids = made.users;
      const exec = async (fn) => { try { await fn(); } catch (e) { console.log('  cleanup step:', String(e.message).slice(0, 160)); } };
      await exec(() => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }, { recipient: { contains: `-${RUN}@` } }] } }));
      await exec(() => prisma.vendorBillSubmission.deleteMany({ where: { vendorId: { in: made.vendors } } }));
      await exec(() => raw('DELETE FROM "VendorModuleBill" WHERE "vendorId" IN (' + (made.vendors.map(() => '?').join(',') || "''") + ')', ...made.vendors));
      await exec(() => raw('DELETE FROM "VendorLoginModule" WHERE "vendorUserId" IN (' + (made.vlogins.map(() => '?').join(',') || "''") + ')', ...made.vlogins));
      await exec(() => prisma.vendorUser.deleteMany({ where: { id: { in: made.vlogins } } }));
      await exec(() => prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } }));
      await exec(() => raw('DELETE FROM "ProofReminderRun"'));
      await exec(() => prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'proofReminders.' } }, { key: 'accounts.reminderRecipients' }] } }));
      await exec(() => prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorName: { contains: 'ZZTEST RS' } }, { entityId: { in: ['vendorInvoice', 'vendorBill', 'proofDaily', 'proofBell'] }, entity: 'AccountsReminderSettings' }] } }));
      await exec(() => prisma.employee.deleteMany({ where: { id: { in: made.emps } } }));
      await exec(() => prisma.user.deleteMany({ where: { id: { in: ids } } }));
      const left = {
        users: await prisma.user.count({ where: { OR: [{ name: { contains: 'ZZTEST RS' } }, { id: { in: ids } }] } }),
        employees: await prisma.employee.count({ where: { name: { contains: 'ZZTEST RS' } } }),
        vendors: await prisma.officeVendor.count({ where: { name: { contains: 'ZZTEST RS' } } }),
        notes: await prisma.notification.count({ where: { OR: [{ title: { contains: 'ZZTEST' } }, { userId: { in: ids } }] } }),
        settings: await prisma.appSetting.count({ where: { key: { in: ['accounts.reminderRecipients'] } } }),
      };
      check('Z', 'every ZZTEST fixture of this run is gone from the copy', Object.values(left).every((n) => n === 0), left);
    } catch (e) { fail += 1; console.log(`FAIL  [cleanup] ${e.message}`); }
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(Object.entries(groupCount).map(([g2, c]) => `${g2}:${c.pass}/${c.pass + c.fail}`).join('  '));
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    if (server) server.kill();
    await sleep(500);
    if (madeCopy) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* ignore */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); fs.unlinkSync(MAILS); } catch { /* ignore */ }
    process.exit(fail ? 1 : 0);
  }
})();
