#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ACCOUNTS REMINDERS GO TO THE ACCOUNTANT, NOT THE ADMIN (founder, 2026-10-19). COPY DATABASE ONLY, NO REAL MESSAGE.
//   cd backend
//   node scripts/accounts-reminders-recipients-test.js                     makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/arr-copy.db node scripts/accounts-reminders-recipients-test.js   use a copy you made (never prisma/dev.db)
//
// Starts its OWN API (port 4076, TEST_MODE: fake mail transport with capture, no timers, temp upload folder) on the copy, builds ZZTEST
// fixtures there and fires EVERY Accounts reminder kind for real (scheduler functions in this process, routes on the throw-away API):
//   K1 proof reminder, in-app (accountsControl.remind)        K2 proof reminder, daily WhatsApp + e-mail (proofReminders.tick)
//   K3 vendor invoice waiting (module-bills route)             K4 vendor asset bill waiting (assets/:id/bills route)
//   K5 repair cost / invoice changed ("Changed in HRMS" hint)   K6 repair invoice sent to Accounts (send-invoice route)
//   K7 partner payout to approve (partners.onJoined)           K8 invoice ready (clientTrack.onInvoiceDraft)
// and proves, for each: the Accountant logins get it once, Admin / Super Admin / everyone else get none, a rerun adds nothing,
// a deactivated Accountant is skipped; with no Accountant the Admin gets ONE "No accountant is set up" notice (deduped) and not the
// reminders; the founder's "also send to the Admin" opt-in works and is off by default; non-Accounts events still reach their old people.
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
  copy = path.join(os.tmpdir(), `arr-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
  madeCopy = true;
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4076);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const UPLOADS = path.join(os.tmpdir(), `arr-uploads-${RUN}`);
const MAILS = path.join(os.tmpdir(), `arr-mail-${RUN}.jsonl`);
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

const made = { users: [], emps: [], vendors: [], vlogins: [], assets: [], repairs: [], partners: [], clients: [], reqs: [], cands: [], apps: [], invoices: [] };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const GUARDED = [
  'src/utils/permissions.js', 'src/utils/identity.js', 'src/utils/roleAccess.js', 'src/utils/roleRegistry.js', 'src/utils/scope.js',
  '../frontend/src/nav.js', '../frontend/src/permissions.js',
].map((f) => path.join(BACK, f)).filter((f) => fs.existsSync(f));

(async () => {
  let server; let serverLog = '';
  const hashBefore = Object.fromEntries(GUARDED.map((f) => [f, sha(f)]));
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: UPLOADS, APP_BASE_URL: 'http://localhost:5183', VENDOR_PORTAL_ALL_MODULES: '1' } }); // the vendor-portal wall (2026-10-19) hides the old asset-bill route; its documented test switch lifts it so K4 can be fired
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    const AC = require(path.join(BACK, 'src/utils/accountsControl'));
    const AR = require(path.join(BACK, 'src/utils/accountsRecipients'));
    const PR = require(path.join(BACK, 'src/utils/proofReminders'));
    const PARTNERS = require(path.join(BACK, 'src/utils/partners'));
    const CT = require(path.join(BACK, 'src/utils/clientTrack'));
    const VC = require(path.join(BACK, 'src/utils/vendorConfig'));

    // ------------------------------------------------------------------ the facts about the real data (copy)
    const realAcc = await prisma.user.count({ where: { status: 'Active', OR: [{ accountsRole: 'ACCOUNTANT' }, { role: 'ACCOUNTANT' }] } });
    const realAdmins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { accountsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true, name: true } });
    console.log(`INFO  real data (copy): ${realAcc} Accountant login(s); Admin / Super Admin logins: ${realAdmins.map((u) => u.name).join(', ')}`);
    check('0', 'the copy has NO Accountant login (the real situation), so the first scenarios are "no accountant"', realAcc === 0, realAcc);

    // ------------------------------------------------------------------ fixtures
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mk = async (tag, extra, emp = true) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ARR ${tag} ${RUN}`, email: `zz-arr-${tag}-${RUN}@example.test`, username: `zz-arr-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (emp) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-ARR-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', email: u.email, phone: `98765${String(crypto.randomInt(10000, 99999))}` } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const adm = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const sa = await mk('super', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true });
    const hr = await mk('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'HR', atsAccess: true });
    const emp = await mk('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const T = { adm: await tok(adm), sa: await tok(sa) };
    const saId = await resolveIdentity(sa.id);
    const ADMINLIKE = [adm.id, sa.id, ...realAdmins.map((u) => u.id)];
    const OTHERS = [rec.id, hr.id, emp.id];
    const newAcc = async (tag, extra = {}) => mk(tag, { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true, ...extra });

    // rows written since `t` (a Date) for the titles that match `re`
    const rowsSince = (t, re, extra = {}) => prisma.notification.findMany({ where: { createdAt: { gte: t }, ...extra } }).then((rs) => rs.filter((n) => re.test(n.title || '')));
    const perUser = (rows) => rows.reduce((m, n) => { m[n.userId] = (m[n.userId] || 0) + 1; return m; }, {});
    const idsOf = (rows) => [...new Set(rows.map((n) => n.userId).filter(Boolean))];
    const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const none = (rows, ids) => rows.filter((n) => ids.includes(n.userId)).length === 0;
    const RE_NOACC = /No accountant is set up/;

    // ====================================================================================================================
    // A0. THE DEFAULT (founder, 2026-10-21): Purna Chandra (employee code TL309) + the Accountant role. The real data has no Accountant, so Purna
    //     alone gets everything, and the Admin is NOT told "no accountant" (that notice is only for "nobody at all").
    // ====================================================================================================================
    const purnaEmp = await prisma.employee.findFirst({ where: { employeeCode: 'TL309' }, select: { userId: true, phone: true } });
    const purna = await prisma.user.findUnique({ where: { id: purnaEmp.userId }, select: { id: true, name: true, email: true, status: true } });
    check('A0', 'TL309 is found by employee code: an active login (HR) with a WhatsApp number and an e-mail on file, and NO Accounts access', purna.status === 'Active' && !!purnaEmp.phone && !!purna.email && !(await resolveIdentity(purna.id)).products.accounts);
    const tA0 = new Date(Date.now() - 20);
    const d0 = await AC.buildControl(saId, { fresh: '1' });
    const rec0 = d0.proof.records;
    const keys0 = rec0.slice(0, 3).map((x) => x.key);
    check('A0', "default desk: every missing proof is Purna's to hear about (the Accountant role has nobody yet)", rec0.length >= 3 && rec0.every((x) => sameSet(x.who.ids, [purna.id])), rec0.slice(0, 2).map((x) => x.who));
    const rem0 = await AC.remind(saId, keys0);
    const k0 = await rowsSince(tA0, /Proof missing/);
    check('A0', 'K1 default: Purna gets the 3 bells; no Admin, Super Admin or other HR gets any', rem0.sent === 3 && k0.length === 3 && sameSet(idsOf(k0), [purna.id]) && none(k0, [...ADMINLIKE, ...OTHERS]), { rem0, per: perUser(k0) });
    check('A0', 'no "No accountant is set up" notice while Purna is active (it is only for nobody at all)', (await rowsSince(tA0, RE_NOACC)).length === 0);
    await PR.saveSettings({ enabled: true, time1: '09:30', time2: '17:00' }, adm, { allowTest: true });
    const dayPlus = (n) => new Date(Date.now() + 330 * 60000 + (420 + n) * 86400000).toISOString().slice(0, 10);
    const dayA0 = dayPlus(0);
    const calls0 = [];
    const tr0 = { async whatsapp(m) { calls0.push({ ch: 'WhatsApp', ...m }); return { ok: true }; }, async email(m) { calls0.push({ ch: 'Email', ...m }); return { ok: true }; } };
    const extra0 = [{ key: 'vendorWaiting', line: 'Vendor bills and invoices still waiting for a check: 2 (oldest sent 01 Oct 2026).', where: 'Office & Accounts, Bills from vendors' }];
    const tick0 = (day, hhmm) => PR.tick({ now: new Date(PR.atIst(day, hhmm)), transports: tr0, pending: async () => rec0, allowTest: true, extras: extra0 });
    const tBell = new Date(Date.now() - 20);
    const m930 = await tick0(dayA0, '09:30');
    check('A0', 'the 09:30 IST round runs by itself (default ON, no button): WhatsApp and Email captured for Purna only', m930.rounds.length === 1 && m930.rounds[0].slot === 'first' && calls0.length === 2 && calls0.every((c) => c.userId === purna.id) && sameSet(calls0.map((c) => c.ch), ['WhatsApp', 'Email']), { rounds: m930.rounds.map((x) => x.slot), n: calls0.length });
    const bells0 = await rowsSince(tBell, /payment proofs? (is|are) missing/);
    check('A0', "the same round put one bell in Purna's bell, nobody else's", bells0.length === 1 && bells0[0].userId === purna.id);
    const txt = `${calls0.map((c) => c.text).join('\n')}\n${bells0[0].message}`;
    check('A0', 'his digest is the plain information version: counts, oldest first, what else is waiting, NO link, no "Open", no instruction to upload', /for your information/.test(txt) && /missing \(Rs/.test(txt) && /Also waiting for Accounts:/.test(txt) && /Vendor bills and invoices still waiting/.test(txt) && !/Open:|https?:|accounts\/dashboard|Office & Accounts, Bills/.test(txt) && !/upload|log in/i.test(txt), txt.slice(0, 300));
    check('A0', 'his mail uses the information subject', calls0.find((c) => c.ch === 'Email').subject === 'Accounts daily summary: pending items');
    await tick0(dayA0, '09:40');
    check('A0', 'the same round again (a second tick): nothing more is sent', calls0.length === 2);
    const m1700 = await tick0(dayA0, '17:00');
    check('A0', 'the 17:00 IST round is its own round: Purna again, WhatsApp + Email', m1700.rounds.length === 1 && m1700.rounds[0].slot === 'second' && calls0.length === 4 && calls0.every((c) => c.userId === purna.id));
    await tick0(dayA0, '17:30');
    check('A0', 'the 17:00 round again: nothing more', calls0.length === 4);
    const dC = dayPlus(1);
    await tick0(dC, '10:45');
    check('A0', 'a server that was down at 09:30 and is back at 10:45 sends the missed round once (grace 2 hours)', calls0.length === 6 && (await raw('SELECT "slot" FROM "ProofReminderRun" WHERE "runDate" = ?', dC)).every((x) => x.slot === 'first'));
    await tick0(dC, '10:50');
    check('A0', 'and not twice', calls0.length === 6);
    const dLate = dayPlus(2);
    await tick0(dLate, '11:45');
    check('A0', 'back after the grace window (11:45): the 09:30 round is not sent', calls0.length === 6 && (await raw('SELECT 1 FROM "ProofReminderRun" WHERE "runDate" = ?', dLate)).length === 0);
    const dEmpty = dayPlus(3);
    const nBefore = calls0.length;
    await PR.tick({ now: new Date(PR.atIst(dEmpty, '09:30')), transports: tr0, pending: async () => [], allowTest: true, extras: [] });
    check('A0', 'nothing pending and nothing else waiting: no empty message, no row', calls0.length === nBefore && (await raw('SELECT 1 FROM "ProofReminderRun" WHERE "runDate" = ?', dEmpty)).length === 0);
    // missing WhatsApp number: plain status with his name, the e-mail still goes, the number is never printed
    await prisma.employee.update({ where: { employeeCode: 'TL309' }, data: { phone: null } });
    const dNoPhone = dayPlus(4);
    const nb = calls0.length;
    await tick0(dNoPhone, '09:30');
    const rowsNP = await raw('SELECT "channel","status","error" FROM "ProofReminderRun" WHERE "runDate" = ? ORDER BY "channel"', dNoPhone);
    const waRow = rowsNP.find((x) => x.channel === 'WhatsApp'); const emRow = rowsNP.find((x) => x.channel === 'Email');
    check('A0', 'no WhatsApp number on file: plain status "No WhatsApp number on file for <name>", and the e-mail still went', waRow && waRow.status === 'failed' && waRow.error === `No WhatsApp number on file for ${purna.name}` && emRow && emRow.status === 'sent' && calls0.length === nb + 1, rowsNP);
    await prisma.employee.update({ where: { employeeCode: 'TL309' }, data: { phone: purnaEmp.phone } });
    const setPurna = (status) => prisma.user.update({ where: { id: purna.id }, data: { status } });
    await setPurna('Inactive');

    // ====================================================================================================================
    // A. NO ACCOUNTANT AT ALL (the real situation). Nobody gets the reminder; the Admin is told ONCE.
    // ====================================================================================================================
    // the copy comes from a server that has already shown the Admins this notice once: start from none, to count what THIS run writes
    await prisma.notification.deleteMany({ where: { title: 'No accountant is set up' } });
    const tA = new Date(Date.now() - 20);
    const mailA = mailCount();
    const keys3 = [];
    let records = [];
    {
      const t0 = Date.now();
      const data = await AC.buildControl(saId, { fresh: '1' });
      records = data.proof.records;
      console.log(`INFO  proof-missing records on the copy: ${records.length} (read in ${Date.now() - t0} ms)`);
      keys3.push(...records.slice(0, 3).map((r) => r.key));
      check('A1', 'with no Accountant the proof records have NOBODY to tell (they are no longer owned by an Admin / Super Admin)', records.length >= 3 && records.every((r) => r.who.ids.length === 0 && r.who.name === 'No accountant set'), records.slice(0, 2).map((r) => r.who));
      check('A1', 'the Accounts dashboard lists no accountants', data.proof.accountants.length === 0, data.proof.accountants);
    }
    const remA = await AC.remind(saId, keys3);
    check('A2', 'K1 "Remind accountant" with no Accountant: nothing sent, 3 counted as "no accountant"', remA.sent === 0 && remA.noAccountant === 3, remA);
    check('A2', 'K1 no "Proof missing" bell reaches any Admin / Super Admin / other person', (await rowsSince(tA, /Proof missing/)).length === 0);
    const noteA1 = await rowsSince(tA, RE_NOACC);
    const expectedAdmins = (await AR.admins({ allowTest: true })).map((u) => u.id);
    check('A3', 'each active Admin / Super Admin login got EXACTLY ONE "No accountant is set up" notice', sameSet(idsOf(noteA1), expectedAdmins) && noteA1.length === expectedAdmins.length && expectedAdmins.length >= 5, { got: noteA1.length, want: expectedAdmins.length });
    check('A3', 'the notice says plainly what is wrong and what to do', /could not be delivered/.test(noteA1[0].message) && /Accountant role/.test(noteA1[0].message) && !/draft/i.test(noteA1[0].message), noteA1[0].message);
    check('A3', 'nobody who is not an Admin / Super Admin got that notice', none(noteA1, [...OTHERS]));

    // K2 with no Accountant
    await PR.saveSettings({ enabled: true }, adm, { allowTest: true });
    const dayA = new Date(Date.now() + 330 * 60000 + 401 * 86400000).toISOString().slice(0, 10);
    const callsA = [];
    const trA = { async whatsapp(m) { callsA.push({ ch: 'WhatsApp', ...m }); return { ok: true }; }, async email(m) { callsA.push({ ch: 'Email', ...m }); return { ok: true }; } };
    const tickA = await PR.tick({ now: new Date(PR.atIst(dayA, '10:05')), transports: trA, pending: async () => records, allowTest: true });
    check('A4', 'K2 daily WhatsApp / e-mail with no Accountant: not one message is sent (not to the Admin either)', callsA.length === 0 && tickA.rounds.length === 1 && tickA.rounds[0].people === 0 && tickA.rounds[0].noAccountant === records.length, { calls: callsA.length, round: tickA.rounds[0] && { people: tickA.rounds[0].people, noAcc: tickA.rounds[0].noAccountant } });
    const runsA = await raw('SELECT "userName","status","error" FROM "ProofReminderRun" WHERE "runDate" = ?', dayA);
    check('A4', 'K2 the run log says "No accountant set" with the reason', runsA.length === 2 && runsA.every((r) => r.userName === 'No accountant set' && r.status === 'failed' && /no Accountant to tell/.test(r.error)), runsA);

    // K3 with no Accountant: the vendor still sends; nobody is told, the Admin is not mailed
    // (vendors/logins are built below; the "no accountant" vendor-bill check is done right after they exist)

    // ---- vendor fixtures (finance vendor = module invoices; asset vendor = legacy IT login)
    const IT = 'IT / Hardware / AMC / Service';
    const mkVendor = async (tag, category) => {
      const v = await prisma.officeVendor.create({ data: { name: `ZZTEST ARR Vendor ${tag} ${RUN}`, companyName: `ZZTEST ARR Co ${tag}`, isActive: true, category, email: `zz-arr-v${tag}-${RUN}@example.test` } });
      made.vendors.push(v.id); return v;
    };
    const VF = await mkVendor('Fin', IT); const VAS = await mkVendor('Asset', IT); const VOLD = await mkVendor('Old', 'Internet');
    const mkLogin = async (vendor, tag) => {
      const pw = PWD(tag);
      const u = await prisma.vendorUser.create({ data: { vendorId: vendor.id, name: `ZZTEST Contact ${tag}`, email: `zz-arr-${tag}-${RUN}@example.test`, passwordHash: bcrypt.hashSync(pw, 10), status: 'Active', mustChangePassword: false, passwordChangedAt: new Date(), canEdit: true, canViewCost: true } });
      made.vlogins.push(u.id); return { u, pw };
    };
    const LF = await mkLogin(VF, 'fin'); const LA = await mkLogin(VAS, 'asset'); const LO = await mkLogin(VOLD, 'old');
    const nowMs = Date.now();
    for (const k of ['invoices', 'payments']) await raw('INSERT INTO "VendorLoginModule" ("id","vendorUserId","moduleKey","permissionsJson","createdAt","updatedAt") VALUES (?,?,?,?,?,?)', `zzarr${k}${LF.u.id}`.slice(0, 40), LF.u.id, k, '{}', nowMs, nowMs);
    for (const L of [LF, LA, LO]) { const r = await http('POST', '/api/vendor-portal/login', null, { email: L.u.email, password: L.pw }); L.token = r.body && r.body.token; }
    check('0', 'vendor logins signed in (finance vendor with Invoices, asset vendor)', !!LF.token && !!LA.token);
    // an asset the asset vendor can see + a repair the vendor is working on
    const asset = await prisma.asset.create({ data: { assetCode: `ZZAR-${RUN}-1`, name: 'ZZTEST ARR Laptop', category: 'Laptop', status: 'Assigned', vendorId: VAS.id, purchaseDate: '2026-01-10', location: 'Hyderabad' } });
    made.assets.push(asset.id);
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LA.u.id, assetId: asset.id } });
    // an old-style (finance) vendor login with an asset: the only kind that sends a bill from the assets list
    const assetOld = await prisma.asset.create({ data: { assetCode: `ZZAR-${RUN}-2`, name: 'ZZTEST ARR Printer', category: 'Printer', status: 'Assigned', vendorId: VOLD.id, purchaseDate: '2026-01-10', location: 'Hyderabad' } });
    made.assets.push(assetOld.id);
    await prisma.vendorAssetAccess.create({ data: { vendorUserId: LO.u.id, assetId: assetOld.id } });
    await http('GET', '/api/vendor-portal/asset-portal/overview', LA.token); // the portal creates its own tables on first use
    const mkRepair = async (n) => {
      const row = await prisma.assetRepair.create({ data: { repairNo: `RP-ZZAR${RUN}-${n}`, assetId: asset.id, issue: 'ZZTEST screen', vendor: VAS.name, status: 'In Repair', dateReported: '2026-09-01', repairDate: null, cost: 0, gstPaid: 0, underWarranty: false } });
      made.repairs.push(row.id);
      await raw('INSERT INTO "AssetRepairVendor" ("repairId","assetId","vendorId","stage","returnedDate","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)', row.id, asset.id, VAS.id, 'Under repair', null, new Date().toISOString(), new Date().toISOString());
      return row;
    };
    const RP1 = await mkRepair('1'); const RP2 = await mkRepair('2');

    const sendModuleInvoice = (n) => http('POST', '/api/vendor-portal/module-bills?kind=invoice', LF.token, undefined, { form: upload(pdf(`inv${n}`), `inv${n}.pdf`, 'application/pdf', { billNumber: `ZZARR-${RUN}-${n}`, billDate: new Date().toISOString().slice(0, 10), amount: '1200', gst: '216' }) });
    const tA3 = new Date(Date.now() - 20); const mA3 = mailCount();
    let r = await sendModuleInvoice('0');
    check('A5', 'K3 the vendor can still send an invoice (201) while there is no Accountant', r.status === 201, r.body);
    await sleep(400);
    check('A5', 'K3 with no Accountant: no "waiting for your check" bell to anyone, no mail to the Admin', (await rowsSince(tA3, /waiting for your check/)).length === 0 && mailsSince(mA3).filter((m) => /waiting for your check/.test(m.subject)).length === 0);
    check('A5', 'K3 and still exactly ONE "No accountant is set up" notice per Admin (deduped across all the reminders so far)', (await rowsSince(tA, RE_NOACC)).length === expectedAdmins.length);
    // read it: not repeated inside 7 days; repeated after 8 days
    await prisma.notification.updateMany({ where: { createdAt: { gte: tA }, title: 'No accountant is set up' }, data: { read: true } });
    await AC.remind(saId, keys3);
    check('A6', 'after the Admin READ the notice, a new try inside 7 days does not repeat it', (await rowsSince(tA, RE_NOACC)).length === expectedAdmins.length);
    await prisma.notification.updateMany({ where: { createdAt: { gte: tA }, title: 'No accountant is set up' }, data: { createdAt: new Date(Date.now() - 8 * 86400000) } });
    await AC.remind(saId, keys3);
    const after8 = await prisma.notification.count({ where: { title: 'No accountant is set up', userId: { in: expectedAdmins } } });
    check('A6', 'after 8 days (read, still no Accountant) it is sent again, once', after8 === expectedAdmins.length * 2, after8);

    // ====================================================================================================================
    // B. TWO ACCOUNTANTS (+ one deactivated). Every reminder kind reaches them, once, and nobody else.
    // ====================================================================================================================
    await setPurna('Active');
    const acc1 = await newAcc('acc1'); const acc2 = await newAcc('acc2');
    const accOff = await newAcc('accoff', { status: 'Inactive' });
    const ACC = [acc1.id, acc2.id];
    const ACCP = [...ACC, purna.id]; // the DEFAULT recipients now: Purna Chandra (TL309) + every Accountant-role login
    const team = await AR.reminderRecipients({ kind: 'vendorInvoice', allowTest: true });
    check('B0', 'the default recipient list is exactly Purna Chandra (TL309) + the two active Accountants (the deactivated one and every Admin are out)', sameSet(team.users.map((u) => u.id), ACCP) && !team.alsoAdmin, team.users.map((u) => u.name));
    const keys = records.slice(0, 3).map((x) => x.key);
    await prisma.notification.deleteMany({ where: { userId: purna.id, title: { startsWith: 'Proof missing' } } }); // the A0 bells (unread, under a day old) would be skipped

    // ---- K1
    const tK1 = new Date(Date.now() - 20);
    const remB = await AC.remind(saId, keys);
    const k1 = await rowsSince(tK1, /Proof missing/);
    check('B1', 'K1 each of the 3 records: one in-app reminder per Accountant (9 rows with Purna), sent = 3', remB.sent === 3 && k1.length === 9 && sameSet(idsOf(k1), ACCP) && Object.values(perUser(k1)).every((n) => n === 3), { remB, per: perUser(k1) });
    check('B1', 'K1 Admin, Super Admin (test + real), the deactivated Accountant and other staff get NONE', none(k1, [...ADMINLIKE, accOff.id, ...OTHERS]));
    const remB2 = await AC.remind(saId, keys);
    check('B1', 'K1 pressing it again: no duplicate (skipped = 3, rows still 9)', remB2.sent === 0 && remB2.skipped === 3 && (await rowsSince(tK1, /Proof missing/)).length === 9, remB2);
    const tPlain = records.find((x) => !keys.includes(x.key));
    const fresh = await AC.buildControl(saId, { fresh: '1' });
    check('B1', 'the Accounts dashboard now names the Accountants as the desk', fresh.proof.accountants.length === 3 && fresh.proof.records.every((x) => x.who.ids.every((id) => ACCP.includes(id))), fresh.proof.accountants);

    // ---- K2 (default pending = the real Proof reminder list, read fresh)
    const dayB = new Date(Date.now() + 330 * 60000 + 402 * 86400000).toISOString().slice(0, 10);
    const callsB = [];
    const trB = { async whatsapp(m) { callsB.push({ ch: 'WhatsApp', ...m }); return { ok: true }; }, async email(m) { callsB.push({ ch: 'Email', ...m }); return { ok: true }; } };
    const tickB = await PR.tick({ now: new Date(PR.atIst(dayB, '10:05')), transports: trB, allowTest: true });
    const k2users = [...new Set(callsB.map((c) => c.userId))];
    check('B2', 'K2 the daily round read the real list and messaged Purna and the two Accountants only', tickB.rounds.length === 1 && tickB.rounds[0].pending > 0 && sameSet(k2users, ACCP), { pending: tickB.rounds[0] && tickB.rounds[0].pending, users: k2users });
    check('B2', 'K2 each of the three got exactly one WhatsApp and one e-mail', ACCP.every((id) => callsB.filter((c) => c.userId === id && c.ch === 'WhatsApp').length === 1 && callsB.filter((c) => c.userId === id && c.ch === 'Email').length === 1) && callsB.length === 6, callsB.length);
    check('B2', 'K2 the wording is the existing wording ("Dear Accountant" mail, "Hello Accountant" WhatsApp)', callsB.filter((c) => c.ch === 'Email' && ACC.includes(c.userId)).every((c) => c.text.startsWith(PR.MAIL_HEAD) && c.subject === PR.MAIL_SUBJECT) && callsB.filter((c) => c.ch === 'WhatsApp' && ACC.includes(c.userId)).every((c) => c.text.startsWith(PR.WA_HEAD)));
    const purnaCalls = callsB.filter((c) => c.userId === purna.id);
    check('B2', 'K2 Purna has no Accounts access: his WhatsApp and e-mail are the plain information version, with NO link and no instruction to open Accounts', purnaCalls.length === 2 && purnaCalls.every((c) => !/Open:|https?:|accounts\/dashboard/i.test(c.text) && !/upload|log in/i.test(c.text)) && purnaCalls.every((c) => /for your information/.test(c.text)), purnaCalls.map((c) => c.text.slice(0, 160)));
    check('B2', 'K2 the e-mail goes to the Accountants\' own addresses; none to an Admin / Super Admin address', callsB.filter((c) => c.ch === 'Email').every((c) => [acc1.email, acc2.email, purna.email].includes(c.to)));
    const runsB = await raw('SELECT "userId","channel","status" FROM "ProofReminderRun" WHERE "runDate" = ?', dayB);
    check('B2', 'K2 the run log has 9 rows (WhatsApp, Email, Bell for each of the three), all accepted', runsB.length === 9 && runsB.every((x) => ACCP.includes(x.userId) && x.status === 'sent'), runsB);
    const callsB1 = callsB.length;
    await PR.tick({ now: new Date(PR.atIst(dayB, '10:20')), transports: trB, pending: async () => fresh.proof.records, allowTest: true });
    await PR.runNow({ user: adm, slot: 'first', now: new Date(PR.atIst(dayB, '10:30')), transports: trB, pending: async () => fresh.proof.records, allowTest: true });
    check('B2', 'K2 running the scheduler again (and "Send now") the same day sends nothing more (idempotent)', callsB.length === callsB1, callsB.length - callsB1);

    // ---- K3 finance vendor invoice
    const t3 = new Date(Date.now() - 20); const m3 = mailCount();
    r = await sendModuleInvoice('1');
    await sleep(500);
    const k3 = await rowsSince(t3, /waiting for your check/, { channel: null });
    const k3mail = mailsSince(m3).filter((m) => /waiting for your check/.test(m.subject));
    check('B3', 'K3 vendor invoice: bell to both Accountants, once each, to nobody else', r.status === 201 && sameSet(idsOf(k3), ACCP) && k3.length === 3 && none(k3, [...ADMINLIKE, accOff.id, ...OTHERS]), { status: r.status, per: perUser(k3) });
    check('B3', 'K3 the e-mail (Vendor emails switch ON in the copy) went to the two Accountant addresses only', k3mail.length === 3 && sameSet(k3mail.map((m) => addrOf(m.to)), [acc1.email, acc2.email, purna.email].map((e) => e.toLowerCase())), k3mail.map((m) => m.to));
    // deactivate Accountant 2 for the next one
    await prisma.user.update({ where: { id: acc2.id }, data: { status: 'Inactive' } });
    const t3b = new Date(Date.now() - 20); const m3b = mailCount();
    r = await sendModuleInvoice('2');
    await sleep(500);
    const k3b = await rowsSince(t3b, /waiting for your check/, { channel: null });
    check('B3', 'K3 a deactivated Accountant is skipped: the next invoice reaches Accountant 1 and Purna only (bell and e-mail)', sameSet(idsOf(k3b), [acc1.id, purna.id]) && k3b.length === 2 && mailsSince(m3b).filter((m) => /waiting/.test(m.subject)).length === 2, { per: perUser(k3b) });
    await prisma.user.update({ where: { id: acc2.id }, data: { status: 'Active' } });

    // ---- K4 asset bill
    const t4 = new Date(Date.now() - 20); const m4 = mailCount();
    r = await http('POST', `/api/vendor-portal/assets/${assetOld.id}/bills`, LO.token, undefined, { form: upload(pdf('assetbill'), 'bill.pdf', 'application/pdf', { billNumber: `ZZARR-AB-${RUN}`, billDate: '2026-09-20', amount: '5000', gst: '900', tds: '0' }) });
    await sleep(500);
    const k4 = await rowsSince(t4, /waiting for your check/, { channel: null });
    check('B4', 'K4 vendor asset bill: bell to Purna and both Accountants once, nobody else; e-mail only to them', r.status === 201 && sameSet(idsOf(k4), ACCP) && k4.length === 3 && none(k4, [...ADMINLIKE, accOff.id, ...OTHERS]) && mailsSince(m4).filter((m) => /waiting/.test(m.subject)).every((m) => [acc1.email, acc2.email, purna.email].map((e) => e.toLowerCase()).includes(addrOf(m.to))), { status: r.status, body: r.body && r.body.error, per: perUser(k4) });

    // ---- K5 + K6 repair
    const t5 = new Date(Date.now() - 20);
    const patch = (id, body) => http('PATCH', `/api/vendor-portal/asset-portal/repairs/${id}`, LA.token, body);
    r = await patch(RP1.id, { finalCost: 1400, finalGst: 252, invoiceNo: `ZZARINV-${RUN}-1` });
    await sleep(400);
    const k5 = await rowsSince(t5, /vendor cost \/ invoice/, { channel: null });
    check('B5', 'K5 vendor cost / invoice change ("Changed in HRMS" review): both Accountants once; no Admin / Super Admin', r.status === 200 && sameSet(idsOf(k5), ACCP) && k5.length === 3 && none(k5, [...ADMINLIKE, accOff.id, ...OTHERS]), { status: r.status, body: r.body && r.body.error, per: perUser(k5) });
    const t6 = new Date(Date.now() - 20);
    r = await http('POST', `/api/vendor-portal/asset-portal/repairs/${RP1.id}/invoice`, LA.token, undefined, { form: upload(pdf('repinv'), 'rep.pdf', 'application/pdf', { invoiceNo: `ZZARINV-${RUN}-1` }) });
    const up = r.status;
    r = await http('POST', `/api/vendor-portal/asset-portal/repairs/${RP1.id}/send-invoice`, LA.token, {});
    await sleep(400);
    const k6 = await rowsSince(t6, /waiting for your check/, { channel: null });
    check('B6', 'K6 repair invoice sent to Accounts: both Accountants once; no Admin / Super Admin', up < 300 && r.status === 201 && sameSet(idsOf(k6), ACCP) && k6.length === 3 && none(k6, [...ADMINLIKE, accOff.id, ...OTHERS]), { up, status: r.status, body: r.body && r.body.error, per: perUser(k6) });
    r = await http('POST', `/api/vendor-portal/asset-portal/repairs/${RP1.id}/send-invoice`, LA.token, {});
    await sleep(300);
    check('B6', 'K6 sending the same invoice twice makes no second notice', (await rowsSince(t6, /waiting for your check/, { channel: null })).length === 3, r.status);

    // ---- K7 partner payout to approve
    const t7 = new Date(Date.now() - 20);
    const partner = await prisma.partner.create({ data: { name: `ZZTEST ARR Partner ${RUN}`, code: `ZZPRT-${RUN}`.slice(0, 20), feeType: 'FIXED', feeFixed: 10000, email: `zz-arr-partner-${RUN}@example.test`, guaranteeDays: 30 } });
    made.partners.push(partner.id);
    const client = await prisma.client.create({ data: { name: `ZZTEST ARR Client ${RUN}`, location: 'ZZ', clientType: 'Client' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `ZZTEST ARR Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', openings: 1 } });
    made.reqs.push(req.id);
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST ARR Cand ${RUN}`, email: `zz-arr-cand-${RUN}@example.test`, phone: '9800011111', location: 'ZZ' } });
    made.cands.push(cand.id);
    const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'JOINED', partnerId: partner.id, joiningDate: '2026-10-10', offeredCtc: 600000 } });
    made.apps.push(app.id);
    const inv = await prisma.invoice.create({ data: { clientId: client.id, candidateId: cand.id, requirementId: req.id, amount: 50000, status: 'Pending', invoiceDate: '2026-10-11', invoiceNumber: `ZZARR-INV-${RUN}` } });
    made.invoices.push(inv.id);
    const payout = await PARTNERS.onJoined({ applicationId: app.id, invoice: inv, userId: adm.id });
    await sleep(200);
    const k7 = await rowsSince(t7, /Partner payout to approve/);
    check('B7', 'K7 partner payout to approve: both Accountants once; no Admin / Super Admin', !!payout && sameSet(idsOf(k7), ACCP) && k7.length === 3 && none(k7, [...ADMINLIKE, accOff.id, ...OTHERS]), { payout: !!payout, per: perUser(k7) });
    await PARTNERS.onJoined({ applicationId: app.id, invoice: inv, userId: adm.id });
    check('B7', 'K7 called again for the same joining: no second payout, no second notice', (await rowsSince(t7, /Partner payout to approve/)).length === 3);

    // ---- K8 invoice ready (was already Accountant-only; same rule, plus the one Admin warning when there is no Accountant)
    const t8 = new Date(Date.now() - 20);
    const appFull = await prisma.application.findUnique({ where: { id: app.id }, include: { candidate: true, requirement: { include: { client: true } } } });
    await CT.onInvoiceDraft({ application: { ...appFull, joiningDate: '2026-10-10' }, existing: appFull, invoice: inv, userId: adm.id });
    const k8 = await rowsSince(t8, /Invoice ready/);
    check('B8', 'K8 "Invoice ready": Purna and both Accountants once; no Admin / Super Admin / other person', k8.length === 3 && sameSet(idsOf(k8), ACCP) && none(k8, [...ADMINLIKE, accOff.id, ...OTHERS]), perUser(k8));
    await prisma.user.updateMany({ where: { id: { in: ACCP } }, data: { status: 'Inactive' } });
    const tNo = new Date(Date.now() - 20);
    const inv2 = await prisma.invoice.create({ data: { clientId: client.id, candidateId: cand.id, requirementId: req.id, amount: 1, status: 'Pending', invoiceDate: '2026-10-11', invoiceNumber: `ZZARR-INV2-${RUN}` } });
    made.invoices.push(inv2.id);
    const warnsBefore = await prisma.notification.count({ where: { title: 'No accountant is set up', userId: { in: expectedAdmins } } });
    await CT.onInvoiceDraft({ application: { ...appFull, joiningDate: '2026-10-10' }, existing: appFull, invoice: inv2, userId: adm.id });
    const warnsAfter = await prisma.notification.count({ where: { title: 'No accountant is set up', userId: { in: expectedAdmins } } });
    check('B8', 'K8 with every Accountant AND Purna switched off: nobody (not the Admin) gets "Invoice ready", and the Admin warning is not repeated', (await rowsSince(tNo, /Invoice ready/)).length === 0 && warnsAfter === warnsBefore, { warnsBefore, warnsAfter });
    await prisma.user.updateMany({ where: { id: { in: ACCP } }, data: { status: 'Active' } });

    // ====================================================================================================================
    // C. THE FOUNDER'S OWN OPT-IN: "Also send to the Admin" (off by default)
    // ====================================================================================================================
    let st = await http('GET', '/api/proof-reminders/status', T.adm);
    check('C1', 'the switch is OFF by default and the Proof reminder card reports it', st.status === 200 && st.body.settings.alsoAdmin === false && st.body.mayRun === true, st.body && st.body.settings);
    const tAccTok = await tok(acc1);
    r = await http('PUT', '/api/proof-reminders/settings', tAccTok, { alsoAdmin: true });
    check('C2', 'an Accountant cannot switch the Admin on (403) and nothing changes', r.status === 403 && !(await AR.alsoAdmin()), r.body);
    r = await http('PUT', '/api/proof-reminders/settings', T.adm, { alsoAdmin: true });
    check('C3', 'the Admin can (200); it is audited', r.status === 200 && r.body.settings.alsoAdmin === true && (await AR.alsoAdmin()) && !!(await prisma.auditLog.findFirst({ where: { action: 'Proof reminder settings changed', toValue: { contains: 'Admin also gets Accounts reminders OFF -> ON' } } })), r.body);
    const tC = new Date(Date.now() - 20);
    r = await sendModuleInvoice('3');
    await sleep(500);
    const kC = await rowsSince(tC, /waiting for your check/, { channel: null });
    const wantC = [acc1.id, acc2.id, purna.id, ...(await AR.admins({ allowTest: true })).map((u) => u.id)];
    check('C4', 'switched ON: the Accountants AND every active Admin / Super Admin get the vendor-invoice notice, once each', r.status === 201 && sameSet(idsOf(kC), wantC) && kC.length === wantC.length, { got: kC.length, want: wantC.length });
    r = await http('PUT', '/api/proof-reminders/settings', T.adm, { alsoAdmin: false });
    const tC2 = new Date(Date.now() - 20);
    r = await sendModuleInvoice('4');
    await sleep(500);
    const kC2 = await rowsSince(tC2, /waiting for your check/, { channel: null });
    check('C5', 'switched OFF again: back to the Accountants only', sameSet(idsOf(kC2), ACCP) && kC2.length === 3 && none(kC2, ADMINLIKE), perUser(kC2));

    // ====================================================================================================================
    // D. NOTHING ELSE MOVED: non-Accounts reminders still reach their old people
    // ====================================================================================================================
    // D1 agreement renewal reminder = owners + Admins (not Accounts-owned): the real Super Admins of the copy still get it, the Accountants do not
    const AL = require(path.join(BACK, 'src/utils/agreementLifecycle'));
    const tD = new Date(Date.now() - 20);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const cl = await prisma.client.create({ data: { name: `ZZTEST ARR Renew ${RUN}`, location: 'ZZ', clientType: 'Client', agreementStatus: 'ACTIVE', agreementId: `ZZ-AG-${RUN}`, agreementStart: '2025-10-01', agreementEnd: in7 } });
    made.clients.push(cl.id);
    await AL.sweepExpiry({ onlyClientIds: [cl.id] });
    const d1 = await rowsSince(tD, /agreement (expires|renews)/);
    const realSa = (await prisma.user.findMany({ where: { id: { in: realAdmins.map((u) => u.id) } }, select: { id: true } })).map((u) => u.id);
    check('D1', 'agreement renewal reminder (BDE / Admin side, not Accounts): the real Super Admins still get exactly one each', realSa.length >= 1 && realSa.every((id) => d1.filter((n) => n.userId === id).length === 1), perUser(d1));
    check('D1', 'agreement renewal reminder: the Accountants do not get it (as before)', none(d1, ACC));
    // D2 overdue task bell goes to the assignee, as before
    const HN = require(path.join(BACK, 'src/utils/hrmsNotify'));
    const dday = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const task = await prisma.task.create({ data: { name: `ZZTEST ARR late task ${RUN}`, assigneeId: emp.id, assigneeName: emp.name, assignedById: adm.id, assignedByName: adm.name, startDate: dday(-10), endDate: dday(-3), status: 'In Progress' } }).catch((e) => ({ error: e.message }));
    if (task.error) check('D2', 'overdue task fixture could be made', false, task.error);
    else {
      made.task = task.id;
      const tT = new Date(Date.now() - 20);
      await HN.reminders({ testMode: true, scope: { userIds: [emp.id, adm.id] }, settings: { ...(await HN.getSettings()), emailsOn: false } });
      const d2 = await rowsSince(tT, /Task overdue/, { channel: 'In-App' });
      check('D2', 'overdue task reminder (HRMS): the assignee gets exactly one; the Accountants and Admin do not get it', d2.length === 1 && d2[0].userId === emp.id, perUser(d2));
    }
    // D3 the permission engine and the nav files are byte-for-byte what they were when this run started
    const hashAfter = Object.fromEntries(GUARDED.map((f) => [f, sha(f)]));
    check('D3', 'permission engine / identity / role files and the staff nav + permissions are unchanged during the run (hash snapshot)', GUARDED.every((f) => hashBefore[f] === hashAfter[f]), GUARDED.map((f) => path.basename(f)));
    // D4 Admin still SEES and ACTS on the Accounts screens (permissions unchanged)
    const dues = await http('GET', '/api/office-expenses/due-dates', T.adm);
    const dues2 = await http('GET', '/api/office-expenses/due-dates', tAccTok);
    const run = await http('POST', '/api/proof-reminders/test', T.adm, {});
    check('D4', 'Admin still opens the Accounts due dates (200) and the Proof reminder screen; the Accountant too', dues.status === 200 && dues2.status === 200 && st.status === 200, [dues.status, dues2.status]);
    check('D4', 'Admin can still use the manual buttons (a test to self returns a normal answer, not 403)', run.status !== 403, run.status);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  [crash] ${e && e.stack ? e.stack : e}`);
  } finally {
    // ---------------------------------------------------------------- clean up the fixtures and prove nothing is left
    try {
      const ids = made.users;
      const exec = async (fn) => { try { await fn(); } catch (e) { console.log('  cleanup step:', String(e.message).slice(0, 160)); } };
      await exec(() => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }, { recipient: { contains: `-${RUN}@` } }] } }));
      await exec(() => prisma.task.deleteMany({ where: { name: { contains: 'ZZTEST ARR' } } }));
      await exec(() => raw('DELETE FROM "AssetRepairBill" WHERE "repairId" IN (SELECT id FROM "AssetRepair" WHERE "repairNo" LIKE ?)', `RP-ZZAR${RUN}%`));
      await exec(() => raw('DELETE FROM "AssetRepairVendor" WHERE "assetId" IN (SELECT id FROM "Asset" WHERE "assetCode" LIKE ?)', 'ZZAR-%'));
      await exec(() => prisma.vendorBillSubmission.deleteMany({ where: { vendorId: { in: made.vendors } } }));
      await exec(() => raw('DELETE FROM "VendorModuleBill" WHERE "vendorId" IN (' + (made.vendors.map(() => '?').join(',') || "''") + ')', ...made.vendors));
      await exec(() => raw('DELETE FROM "VendorLoginModule" WHERE "vendorUserId" IN (' + (made.vlogins.map(() => '?').join(',') || "''") + ')', ...made.vlogins));
      await exec(() => prisma.vendorAssetAccess.deleteMany({ where: { vendorUserId: { in: made.vlogins } } }));
      await exec(() => prisma.assetRepair.deleteMany({ where: { id: { in: made.repairs } } }));
      await exec(() => prisma.asset.deleteMany({ where: { id: { in: made.assets } } }));
      await exec(() => prisma.vendorUser.deleteMany({ where: { id: { in: made.vlogins } } }));
      await exec(() => prisma.partnerPayout.deleteMany({ where: { partnerId: { in: made.partners } } }));
      await exec(() => prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } }));
      await exec(() => prisma.application.deleteMany({ where: { id: { in: made.apps } } }));
      await exec(() => prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }));
      await exec(() => prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } }));
      await exec(() => prisma.partner.deleteMany({ where: { id: { in: made.partners } } }));
      await exec(() => prisma.client.deleteMany({ where: { name: { contains: 'ZZTEST ARR' } } }));
      await exec(() => prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } }));
      await exec(() => raw('DELETE FROM "ProofReminderRun"'));
      await exec(() => prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'proofReminders.' } }] } }));
      await exec(() => prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorName: { contains: 'ZZTEST ARR' } }, { reason: { contains: 'ZZTEST ARR' } }, { toValue: { contains: 'ZZTEST ARR' } }, { toValue: { contains: 'Admin also gets Accounts reminders' } }] } }));
      await exec(() => prisma.employee.deleteMany({ where: { id: { in: made.emps } } }));
      await exec(() => prisma.user.deleteMany({ where: { id: { in: ids } } }));
      const left = {
        users: await prisma.user.count({ where: { OR: [{ name: { contains: 'ZZTEST ARR' } }, { id: { in: ids } }] } }),
        employees: await prisma.employee.count({ where: { name: { contains: 'ZZTEST ARR' } } }),
        vendors: await prisma.officeVendor.count({ where: { name: { contains: 'ZZTEST ARR' } } }),
        assets: await prisma.asset.count({ where: { assetCode: { startsWith: 'ZZAR-' } } }),
        notes: await prisma.notification.count({ where: { OR: [{ title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }, { userId: { in: ids } }] } }),
        proofSettings: await prisma.appSetting.count({ where: { key: { startsWith: 'proofReminders.' } } }),
      };
      check('Z', 'every ZZTEST fixture of this run is gone from the copy', Object.values(left).every((n) => n === 0), left);
    } catch (e) { fail += 1; console.log(`FAIL  [cleanup] ${e.message}`); }
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(Object.entries(groupCount).map(([g, c]) => `${g}:${c.pass}/${c.pass + c.fail}`).join('  '));
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    if (server) server.kill();
    await sleep(500);
    if (madeCopy) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(copy + sfx); } catch { /* ignore */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); fs.unlinkSync(MAILS); } catch { /* ignore */ }
    process.exit(fail ? 1 : 0);
  }
})();
