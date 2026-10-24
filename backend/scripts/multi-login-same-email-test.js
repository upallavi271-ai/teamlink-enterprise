#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SEPARATE LOGINS ON ONE EMAIL - TEST (2026-10-21). COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/multi-login-same-email-test.js           makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/x.db node scripts/multi-login-same-email-test.js     use a copy you made (never prisma/dev.db)
//   TEST_PORT=4072  (free port 4011-4099, not 4010 / 4045)       KEEP_DB=1  keep the copy afterwards
//
// It drives the REAL HTTP API of a throw-away server (fake mail transport, every message captured) and, for the upgrade, the REAL command
// scripts/multi-login-upgrade.js on the copy. Everything it makes is ZZTEST and lives only in the copy.
//
//   A  baseline: the existing logins and their lookups, checksums of every table
//   B  the database BEFORE the upgrade (the old one-login-per-email rule): plain messages, nothing breaks
//   C  the upgrade command: dry-run changes nothing, apply, apply twice, undo, inline-rule rebuild; nothing else changes
//   D  Admin makes three separate logins on one email; same Employee; Admin-only panel
//   E  activation: one mail each, bound to its own login; three different passwords
//   F  each login opens only its own modules (API 403s)
//   G  sign-in by EMAIL only: shared email (one match / several matches -> Choose your account), unknown = wrong password
//   H  lockout is per account
//   I  password reset / change touches only one login; forgot-password by shared email
//   J  switch off / sign out / permissions are per login
//   K  concurrency, Login 1 / Login 2, the wait, no secrets in Admin answers
//   L  notices: one e-mail / one WhatsApp per person, a bell per login
//   M  every existing account still signs in the old way; client portal login
//   N  the SAME email as a staff login AND a vendor / partner login (the one login page)
//   O  nothing person-facing says Login ID
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
const { DatabaseSync } = require('node:sqlite');
const fwd = (p) => p.split(path.sep).join('/');
if (!copy) {
  copy = path.join(os.tmpdir(), `mlse-${Date.now().toString(36)}.db`);
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${fwd(copy).replace(/'/g, "''")}'`);
  src.close();
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4072);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const CAPTURE = path.join(os.tmpdir(), `mlse-mail-${RUN}.jsonl`);
const BACKUPS = path.join(os.tmpdir(), `mlse-backups-${RUN}`);
const BASE = 'https://app.example.test';
const DB_URL = `file:${fwd(path.resolve(copy))}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.APP_BASE_URL = BASE;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const LA = require(path.join(BACK, 'src/utils/loginAccounts'));

let pass = 0; let fail = 0;
const check = (g, n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LF = String.fromCharCode(10);
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const PW = (t) => `Qv#7${t}Lm!${RUN}9`;

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const t0 = Date.now();
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(90000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, ms: Date.now() - t0 };
}
const mails = () => (fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, 'utf8').split(LF).filter(Boolean).map((l) => JSON.parse(l)) : []);
const mailsTo = (addr) => mails().filter((m) => m.to.map((x) => x.toLowerCase()).includes(String(addr).toLowerCase()));
async function waitMails(addr, n, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (mailsTo(addr).length >= n) return true; await sleep(150); }
  return mailsTo(addr).length >= n;
}
const linkOf = (m) => { const x = /(https?:\/\/\S+\/(?:set-password\/|new-password\?token=)([a-f0-9]{64}))/.exec(m.text); return x ? { url: x[1], token: x[2] } : null; };
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- checksums of every table, read straight from the file (the server is idle when this is called) -----------------------------------
function checksums(file, { skip = [] } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  const out = {};
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const t of tables) {
      if (skip.includes(t)) continue; // eslint-disable-line no-continue
      const h = crypto.createHash('sha256'); let n = 0;
      for (const row of db.prepare(`SELECT * FROM "${t}"`).iterate()) { h.update(JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? String(v) : v))); n += 1; }
      out[t] = `${n}:${h.digest('hex').slice(0, 16)}`;
    }
  } finally { db.close(); }
  return out;
}
function userRowsWithout(file, dropCols) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM "User" ORDER BY id').all();
    return rows.map((r) => { const o = { ...r }; dropCols.forEach((c) => delete o[c]); return JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)); });
  } finally { db.close(); }
}
function dbq(file, sql, ...p) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...p); } finally { db.close(); }
}
const diffTables = (a, b) => Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t]);

// ---- run the real upgrade command on a copy -------------------------------------------------------------------------------------------
function upgrade(file, args = [], env = {}) {
  const r = spawnSync(process.execPath, ['scripts/multi-login-upgrade.js', ...args], {
    cwd: BACK, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, DATABASE_URL: `file:${fwd(path.resolve(file))}`, TL_BACKUP_DIR: BACKUPS, TEST_MODE: '1', ...env },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const made = { users: [], employees: [], extraFiles: [] };
(async () => {
  let server; let serverLog = '';
  try {
    fs.writeFileSync(CAPTURE, '');
    fs.mkdirSync(BACKUPS, { recursive: true });
    const startServer = async () => {
      server = spawn(process.execPath, ['src/index.js'], {
        cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), TEST_MAIL_CAPTURE: CAPTURE, APP_BASE_URL: BASE },
      });
      server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
      let healthy = false;
      for (let i = 0; i < 90 && !healthy; i += 1) {
        try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
      }
      if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }
    };
    await startServer();

    // ============================================================ A  baseline
    const realUsers = await prisma.user.findMany({ select: { id: true, email: true, role: true, status: true, passwordHash: true } });
    check('A', `the copy holds the existing logins (${realUsers.length})`, realUsers.length > 0);
    // (the live server numbered ONE real login by itself in an earlier version of this work; the number is an internal column nobody sees)
    const idsBefore = (await raw('SELECT COUNT(*) n FROM "User" WHERE "loginId" IS NOT NULL').catch(() => [{ n: 0 }]))[0].n;
    const idxBefore = await LA.emailIndex();
    check('A', 'the copy still has the old rule: User_email_key is a stand-alone UNIQUE index (droppable)', idxBefore.unique && idxBefore.kind === 'standalone' && idxBefore.name === 'User_email_key', idxBefore);

    // ---- fixtures (the copy only)
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active', passwordChangedAt: new Date() };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ML ${tag} ${RUN}`, email: `zz-ml-${tag}-${RUN}@example.test`, username: `zz-ml-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const tok = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
    const uSA = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const uPlain = await mkUser('plain', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true });
    const T = await tok(uSA);
    const TP = await tok(uPlain);
    const SHARED = `zz-ml-shared-${RUN}@example.test`;
    const emp = await prisma.employee.create({ data: { employeeCode: `ZZML${RUN.toUpperCase()}`, name: `ZZTEST Multi Person ${RUN}`, email: SHARED, phone: `9${String(crypto.randomInt(100000000, 999999999))}`, department: 'Education', designation: 'Recruiter', employmentStatus: 'Active' } });
    made.employees.push(emp.id);
    const emailValues = JSON.stringify({ 'SMTP host': 'smtp.example.test', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'From address': 'noreply@teamlink.example.test', 'Default from name': 'TeamLink' });
    await prisma.integration.upsert({ where: { id: 'email' }, update: { enabled: true, connected: true, state: 'Connected', values: emailValues }, create: { id: 'email', enabled: true, connected: true, state: 'Connected', values: emailValues } });
    const empCountBefore = await prisma.employee.count();

    // ============================================================ B  before the upgrade (the old one-login-per-email rule is still in the database)
    {
      const st = await http('GET', '/api/admin/logins/status', T);
      check('B', 'status says "several logins on one email" is OFF and the rule is a stand-alone index', st.status === 200 && st.body.multiLoginOn === false && st.body.emailRule === 'standalone' && st.body.canSwitchOn === true, st.body);
      check('B', 'the status answer mentions no Login ID', !/login ?id/i.test(st.text), st.text);
      check('B', 'a non-admin cannot read the status (403)', (await http('GET', '/api/admin/logins/status', TP)).status === 403);
      const first = await http('POST', '/api/admin/users', T, { name: `ZZTEST Multi Person ${RUN}`, email: SHARED, role: 'EMPLOYEE', employeeId: emp.id, sendActivation: true, atsAccess: true, atsRole: 'RECRUITER', hrmsAccess: false, accountsAccess: false });
      check('B', 'Admin creates the main login (Recruiter) with an activation link instead of a typed password', first.status === 201 && first.body.activation && first.body.activation.sent === true && !('loginId' in first.body), [first.status, first.text.slice(0, 300)]);
      globalThis.L1 = first.body;
      made.users.push(first.body.id);
      const again = await http('POST', '/api/admin/users', T, { name: 'ZZTEST Dup', email: SHARED.toUpperCase(), role: 'EMPLOYEE', sendActivation: true, atsAccess: true, atsRole: 'RECRUITER' });
      check('B', 'a second login on the same email WITHOUT the tick is refused (409) and the panel data is returned (role, department, status)', again.status === 409 && again.body.code === 'EMAIL_HAS_LOGINS' && again.body.existing.length === 1 && /Recruiter/.test(again.body.existing[0].role) && again.body.existing[0].department === 'Education', again.body);
      const ext = await http('POST', '/api/admin/users', T, { name: 'ZZTEST Dup', email: SHARED, role: 'EMPLOYEE', employeeId: emp.id, additionalLogin: true, accountsAccess: true, accountsRole: 'ACCOUNTANT' });
      check('B', 'with the tick but the old rule still in the database: a plain message, 409, never a 500', ext.status === 409 && ext.body.code === 'MULTI_LOGIN_OFF' && /one-time upgrade/i.test(ext.body.error) && !/P2002|Unique constraint|prisma/i.test(JSON.stringify(ext.body)), ext.body);
      check('B', 'nothing was created by the refused attempts', (await prisma.user.count({ where: { email: SHARED } })) === 1);
      check('B', 'only a Super Admin can switch it on (403 for others)', (await http('POST', '/api/admin/logins/upgrade', TP, {})).status === 403);
    }

    // ============================================================ C  the upgrade command
    await prisma.$disconnect();
    await sleep(500);
    {
      const skipLive = ['AuditLog', 'AppSetting', 'Notification'];
      const sums0 = checksums(copy, { skip: skipLive });
      const u0 = userRowsWithout(copy, ['loginId']);
      const dry = upgrade(copy, []);
      check('C', 'dry-run (the default) exits 0 and says what it WOULD do', dry.code === 0 && /DRY RUN/i.test(dry.out) && /users|logins/i.test(dry.out), dry.out.slice(0, 500));
      check('C', 'dry-run prints counts only: no email address, no hash, no Login ID talk', !/@/.test(dry.out) && !/\$2[aby]\$/.test(dry.out) && !/login ?id/i.test(dry.out), dry.out.slice(0, 300));
      check('C', 'dry-run changed nothing: every table identical', diffTables(sums0, checksums(copy, { skip: skipLive })).length === 0);
      check('C', 'dry-run made no backup and kept the old one-login-per-email index', fs.readdirSync(BACKUPS).length === 0 && dbq(copy, 'PRAGMA index_list("User")').some((i) => i.name === 'User_email_key' && i.unique === 1));
      const refuse = upgrade(REAL, ['--apply'], { DATABASE_URL: `file:${fwd(REAL)}` });
      check('C', 'the real database is refused without --really-real and TL_ALLOW_REAL_APPLY (exit 2, nothing opened)', refuse.code === 2 && /refus/i.test(refuse.out), refuse.out.slice(0, 300));
      const refuse2 = upgrade(REAL, ['--apply', '--really-real'], { DATABASE_URL: `file:${fwd(REAL)}`, TL_ALLOW_REAL_APPLY: '' });
      check('C', '... and still refused with --really-real alone', refuse2.code === 2, refuse2.out.slice(0, 200));

      const ap = upgrade(copy, ['--apply']);
      check('C', 'apply exits 0 and reports a backup and an undo manifest, with no Login ID talk', ap.code === 0 && /backup/i.test(ap.out) && /undo/i.test(ap.out) && !/login ?id/i.test(ap.out), ap.out.slice(0, 600));
      const files = fs.readdirSync(BACKUPS);
      const bak = files.find((f) => f.endsWith('.db'));
      const man = files.find((f) => f.endsWith('.json'));
      check('C', 'a backup copy and an undo manifest were written', !!bak && !!man, files);
      if (bak) check('C', 'the backup opens and holds the same users as before', dbq(path.join(BACKUPS, bak), 'SELECT COUNT(*) n FROM "User"')[0].n === u0.length);
      const idxAfter = dbq(copy, 'PRAGMA index_list("User")');
      check('C', 'the one-login-per-email index is gone; a plain (non-unique) email lookup index exists', !idxAfter.some((i) => i.name === 'User_email_key') && idxAfter.some((i) => i.name === 'User_email_lower_idx' && i.unique === 0), idxAfter.map((i) => `${i.name}:${i.unique}`));
      check('C', 'no login was numbered by the upgrade (nothing hands out IDs any more)', dbq(copy, 'SELECT COUNT(*) n FROM "User" WHERE "loginId" IS NOT NULL')[0].n === idsBefore);
      const sums2 = checksums(copy, { skip: [...skipLive, 'User', 'EmployeeLogin', 'LoginIdCounter'] });
      const sums0b = { ...sums0 }; delete sums0b.User;
      check('C', 'all other tables are byte-for-byte unchanged (counts + checksums of every row)', diffTables(sums0b, sums2).filter((t) => !['EmployeeLogin', 'LoginIdCounter'].includes(t)).length === 0, diffTables(sums0b, sums2));
      check('C', 'every User row is unchanged (same email, role, password hash ...)', JSON.stringify(u0) === JSON.stringify(userRowsWithout(copy, ['loginId'])));
      const ap2 = upgrade(copy, ['--apply']);
      check('C', 'apply a second time: nothing to do, no new backup, no change', ap2.code === 0 && /nothing to do|already/i.test(ap2.out) && fs.readdirSync(BACKUPS).length === files.length, ap2.out.slice(0, 300));
      {
        const w = new DatabaseSync(copy);
        const s1 = w.prepare('SELECT email FROM "User" WHERE email LIKE ? LIMIT 1').get('zz-ml-plain-%');
        w.prepare("INSERT INTO \"User\" (id, name, email, passwordHash, role, updatedAt) VALUES (?, ?, ?, 'x', 'EMPLOYEE', CURRENT_TIMESTAMP)").run(`zzdup${RUN}`, 'ZZTEST dup', s1.email);
        w.close();
        const sumsDup = checksums(copy, { skip: skipLive });
        const bad = upgrade(copy, ['--undo', path.join(BACKUPS, man)]);
        check('C', 'undo is REFUSED while two logins share an email, and changes nothing', bad.code !== 0 && /share|more than one/i.test(bad.out) && diffTables(sumsDup, checksums(copy, { skip: skipLive })).length === 0, bad.out.slice(0, 300));
        const w2 = new DatabaseSync(copy);
        w2.prepare('DELETE FROM "User" WHERE id = ?').run(`zzdup${RUN}`);
        w2.close();
      }
      const und = upgrade(copy, ['--undo', path.join(BACKUPS, man)]);
      check('C', 'undo exits 0: the one-login-per-email rule is back', und.code === 0, und.out.slice(0, 400));
      check('C', 'after undo User_email_key is a UNIQUE index again', dbq(copy, 'PRAGMA index_list("User")').some((i) => i.name === 'User_email_key' && i.unique === 1));
      const sums3 = checksums(copy, { skip: [...skipLive, 'EmployeeLogin', 'LoginIdCounter'] });
      check('C', 'after undo every table matches the start', diffTables(sums0, sums3).filter((t) => !['EmployeeLogin', 'LoginIdCounter'].includes(t)).length === 0, diffTables(sums0, sums3));
      const ap3 = upgrade(copy, ['--apply']);
      check('C', 'apply works again after an undo', ap3.code === 0 && !dbq(copy, 'PRAGMA index_list("User")').some((i) => i.name === 'User_email_key'), ap3.out.slice(0, 300));

      // the same database, with the rule written INSIDE the User table definition (needs a table rebuild)
      const inl = path.join(os.tmpdir(), `mlse-inline-${RUN}.db`);
      made.extraFiles.push(inl);
      {
        const s = new DatabaseSync(REAL, { readOnly: true });
        s.exec(`VACUUM INTO '${fwd(inl)}'`); s.close();
        const U2 = require(path.join(BACK, 'src/utils/multiLoginUpgrade'));
        const db = new DatabaseSync(inl);
        const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='User'").get().sql;
        db.exec('DROP INDEX "User_email_key"'); db.close();
        U2.rebuildUserTable(inl, { newSql: oldSql.replace('"email" TEXT NOT NULL,', '"email" TEXT NOT NULL UNIQUE,') });
        check('C', 'a test copy with the rule INSIDE the table definition is made (UNIQUE autoindex, origin u)', dbq(inl, 'PRAGMA index_list("User")').some((i) => i.origin === 'u' && i.unique === 1));
      }
      const skipI = ['User', 'EmployeeLogin', 'LoginIdCounter'];
      const inlSums0 = checksums(inl, { skip: skipI });
      const inlUsers0 = userRowsWithout(inl, ['loginId']);
      const dryI = upgrade(inl, []);
      check('C', 'dry-run on it says the table has to be rebuilt (and changes nothing)', dryI.code === 0 && /rebuild/i.test(dryI.out) && diffTables(inlSums0, checksums(inl, { skip: skipI })).length === 0, dryI.out.slice(0, 400));
      const noFlag = upgrade(inl, ['--apply']);
      check('C', 'apply without --allow-rebuild is refused (the server must be stopped for a rebuild) and nothing changes', noFlag.code !== 0 && /allow-rebuild/i.test(noFlag.out) && JSON.stringify(userRowsWithout(inl, ['loginId'])) === JSON.stringify(inlUsers0), noFlag.out.slice(0, 300));
      const rb = upgrade(inl, ['--apply', '--allow-rebuild']);
      check('C', 'apply --allow-rebuild rebuilds the User table (exit 0)', rb.code === 0 && /rebuil/i.test(rb.out), rb.out.slice(0, 600));
      const rbIdx = dbq(inl, 'PRAGMA index_list("User")');
      check('C', 'afterwards no unique rule on email remains; users and every other table intact', !rbIdx.some((i) => i.unique === 1 && i.origin === 'u') && JSON.stringify(userRowsWithout(inl, ['loginId'])) === JSON.stringify(inlUsers0) && diffTables(inlSums0, checksums(inl, { skip: skipI })).length === 0, rbIdx.map((i) => `${i.name}:${i.origin}`));
      check('C', 'foreign keys are all still valid after the rebuild', dbq(inl, 'PRAGMA foreign_key_check').length === 0);
    }

    await prisma.$connect();
    LA.resetForTests();
    // ============================================================ D  three separate logins on one email
    const L1 = globalThis.L1;
    {
      const st = await http('GET', '/api/admin/logins/status', T);
      check('D', 'status now says ON', st.status === 200 && st.body.multiLoginOn === true, st.body);
      check('D', 'the main login keeps working as the main login (Employee.userId unchanged)', (await prisma.employee.findUnique({ where: { id: emp.id } })).userId === L1.id);
      const mk2 = await http('POST', '/api/admin/users', T, { name: `ZZTEST Multi Person ${RUN}`, email: SHARED, role: 'EMPLOYEE', employeeId: emp.id, additionalLogin: true, accountsAccess: true, accountsRole: 'ACCOUNTANT' });
      const mk3 = await http('POST', '/api/admin/users', T, { name: `ZZTEST Multi Person ${RUN}`, email: SHARED.toUpperCase(), role: 'EMPLOYEE', employeeId: emp.id, additionalLogin: true, hrmsAccess: true, hrmsRole: 'HR' });
      check('D', 'Admin creates a second (Accounts) and third (HR) login on the same email: 201 each', mk2.status === 201 && mk3.status === 201, [mk2.status, mk2.text.slice(0, 200), mk3.status, mk3.text.slice(0, 200)]);
      globalThis.L2 = mk2.body; globalThis.L3 = mk3.body;
      made.users.push(mk2.body.id, mk3.body.id);
      check('D', 'three different accounts on one email; no Login ID is shown anywhere in the answers', new Set([L1.id, mk2.body.id, mk3.body.id]).size === 3 && ![L1, mk2.body, mk3.body].some((b) => 'loginId' in b), null);
      check('D', 'no second Employee record was made (count unchanged)', (await prisma.employee.count()) === empCountBefore);
      const links = await raw('SELECT userId, employeeId FROM "EmployeeLogin" WHERE employeeId = ?', emp.id);
      check('D', 'both extra logins point at the SAME Employee; Employee.userId stays on the main login', links.length === 2 && links.every((l) => l.employeeId === emp.id) && (await prisma.employee.findUnique({ where: { id: emp.id } })).userId === L1.id, links);
      check('D', 'the new logins are NOT created with a typed password (activation link instead) and carry only what was ticked', mk2.body.activation.sent === true && mk2.body.products.accounts === true && mk2.body.products.ats === false && mk2.body.products.hrms === false && mk3.body.products.hrms === true && mk3.body.products.accounts === false, [mk2.body.products, mk3.body.products]);
      check('D', 'the answer names the role of each login (plain label)', /Recruiter/.test(L1.roleLabel) && /Accountant/.test(mk2.body.roleLabel) && /HR/.test(mk3.body.roleLabel), [L1.roleLabel, mk2.body.roleLabel, mk3.body.roleLabel]);
      const panel = await http('GET', `/api/admin/logins/by-email?email=${encodeURIComponent(SHARED)}&employeeId=${emp.id}`, T);
      check('D', 'the existing-logins panel lists all three: role, department, employee, status, created (Admin)', panel.status === 200 && panel.body.count === 3 && panel.body.accounts.every((a) => a.role && a.department === 'Education' && a.employeeName && a.status && a.createdAt) && panel.body.multiLoginOn === true, panel.body);
      check('D', 'the panel shows no Login ID and never a password, hash or token', !/login ?id|passwordHash|setPassword|\$2[aby]\$|token/i.test(panel.text), panel.text.slice(0, 200));
      check('D', 'a non-admin cannot read the panel (403)', (await http('GET', `/api/admin/logins/by-email?email=${encodeURIComponent(SHARED)}`, TP)).status === 403);
      const noEmpTick = await http('POST', '/api/admin/users', T, { name: 'ZZTEST Other', email: SHARED, role: 'EMPLOYEE', additionalLogin: true, hrmsAccess: true, hrmsRole: 'EMPLOYEE' });
      check('D', 'a separate login on an employee\'s email without choosing that employee is refused (no duplicate employee, no unlinked login)', noEmpTick.status === 409 && noEmpTick.body.code === 'PICK_EMPLOYEE', noEmpTick.body);
      check('D', 'a separate login with nothing ticked is refused (nothing is granted because an email exists)', (await http('POST', '/api/admin/users', T, { name: 'ZZTEST None', email: SHARED, role: 'EMPLOYEE', employeeId: emp.id, additionalLogin: true })).status === 400);
      check('D', 'an Admin cannot type a password for a separate login (the person sets it)', (await http('POST', '/api/admin/users', T, { name: 'ZZTEST Pw', email: SHARED, role: 'EMPLOYEE', employeeId: emp.id, additionalLogin: true, atsAccess: true, atsRole: 'RECRUITER', password: 'Typed#Pass99' })).status === 400);
      check('D', 'a non-admin cannot create logins (403)', (await http('POST', '/api/admin/users', TP, { name: 'x', email: `zz-x-${RUN}@example.test`, role: 'EMPLOYEE', additionalLogin: true })).status === 403);
      const list = await http('GET', '/api/admin/users', T);
      const rows3 = (list.body || []).filter((u) => u.email.toLowerCase() === SHARED.toLowerCase());
      check('D', 'the Users list shows roleLabel and how many logins share the email; no Login ID', list.status === 200 && rows3.length === 3 && rows3.every((u) => u.loginsOnEmail === 3 && u.roleLabel && !('loginId' in u) && u.employeeId === emp.employeeCode) && rows3.filter((u) => u.isExtraLogin).length === 2);
    }

    // ============================================================ E  activation: one mail each, bound to its own login
    const L = [globalThis.L1, globalThis.L2, globalThis.L3];
    const pw = [PW('a'), PW('b'), PW('c')];
    {
      await waitMails(SHARED, 3);
      const ms = mailsTo(SHARED);
      check('E', 'three activation mails reached the shared mailbox (one per login)', ms.length === 3, ms.map((m) => m.subject));
      const per = ['Recruiter', 'Accountant', 'HR'].map((r) => ms.find((m) => m.subject.includes(r)));
      check('E', 'each mail names its own login by role and department, and only that one', per.every(Boolean) && /Recruiter.*Education/.test(per[0].text) && /Accountant.*Education/.test(per[1].text) && /HR.*Education/.test(per[2].text) && !/Accountant|HR \(/.test(per[0].text.split('Choose your own')[0]) , per.map((m) => m && m.subject));
      check('E', 'no mail mentions a Login ID', ms.every((m) => !/login ?id|TL-LOGIN/i.test(m.text) && !/login ?id|TL-LOGIN/i.test(m.html)), null);
      const links = per.map((m) => linkOf(m));
      check('E', 'each mail has its own single-use link; no password in it', links.every(Boolean) && new Set(links.map((x) => x.token)).size === 3 && per.every((m) => !/password:\s*\S+/i.test(m.text)), links);
      const info = await http('GET', `/api/public/set-password/${links[1].token}`);
      check('E', 'the set-password page is told which login it is for (role + department) and that there are other logins', info.status === 200 && /Accountant/.test(info.body.role) && info.body.hasOtherLogins === true && !('loginId' in info.body), info.body);
      const hashB0 = (await prisma.user.findUnique({ where: { id: L[1].id } })).passwordHash;
      const hashC0 = (await prisma.user.findUnique({ where: { id: L[2].id } })).passwordHash;
      const setA = await http('POST', `/api/public/set-password/${links[0].token}`, null, { password: pw[0] });
      check('E', 'link A sets the password of login A', setA.status === 200 && !('loginId' in setA.body), setA.body);
      check('E', 'link A changed NOTHING on login B or C', (await prisma.user.findUnique({ where: { id: L[1].id } })).passwordHash === hashB0 && (await prisma.user.findUnique({ where: { id: L[2].id } })).passwordHash === hashC0);
      check('E', 'link A cannot be used twice', (await http('POST', `/api/public/set-password/${links[0].token}`, null, { password: PW('zz') })).status >= 400);
      // the hint (never a refusal): A's password typed for B
      const hintYes = await http('POST', `/api/public/set-password/${links[1].token}/check`, null, { password: pw[0] });
      const hintNo = await http('POST', `/api/public/set-password/${links[1].token}/check`, null, { password: pw[1] });
      check('E', 'typing another login\'s password on B\'s link: the page is told "already used by your other login" (a hint, not a refusal)', hintYes.status === 200 && hintYes.body.sameAsOther === true && hintNo.body.sameAsOther === false, [hintYes.body, hintNo.body]);
      const setBsame = await http('POST', `/api/public/set-password/${links[1].token}`, null, { password: pw[0] });
      check('E', '... and saving it anyway still works (the choose-your-account step handles it)', setBsame.status === 200, setBsame.body);
      // B is changed to its own password through a fresh link by the Admin (the person keeps a different password for each)
      const act = await http('POST', `/api/admin/logins/${L[1].id}/send-activation`, T, {});
      check('E', 'Admin sends B a fresh link: the mail names only B\'s role', act.status === 200 && act.body.sent === true && !('loginId' in act.body), act.body);
      await sleep(500);
      const lastB = mailsTo(SHARED).slice(-1)[0];
      const linkB2 = linkOf(lastB);
      check('E', '... the mail says "Accountant", not the others', /Accountant/.test(lastB.subject) && !/Recruiter|HR \(/.test(lastB.subject), lastB.subject);
      const setB = await http('POST', `/api/public/set-password/${linkB2.token}`, null, { password: pw[1] });
      const setC = await http('POST', `/api/public/set-password/${links[2].token}`, null, { password: pw[2] });
      check('E', 'B and C choose their own passwords through their own links', setB.status === 200 && setC.status === 200, [setB.body, setC.body]);
      const hs = await prisma.user.findMany({ where: { id: { in: L.map((l) => l.id) } }, select: { id: true, passwordHash: true } });
      check('E', 'three separate password hashes (never copied from one account to another)', new Set(hs.map((h) => h.passwordHash)).size === 3);
    }

    // ============================================================ F  each login opens only its own modules (sign-in by EMAIL only)
    {
      const login = (p) => http('POST', '/api/auth/login', null, { email: SHARED, password: p });
      const sA = await login(pw[0]); const sB = await login(pw[1]); const sC = await login(pw[2]);
      check('F', 'sign-in by email + password works for each login (one match each: no question asked)', [sA, sB, sC].every((s) => s.status === 200 && s.body.token && !s.body.chooseAccount), [sA.status, sB.status, sC.status, sA.text.slice(0, 200)]);
      const tA = sA.body.token; const tB = sB.body.token; const tC = sC.body.token;
      check('F', 'each session is its own account with its own products', sA.body.user.id === L[0].id && sB.body.user.id === L[1].id && sC.body.user.id === L[2].id
        && sA.body.user.products.ats && !sA.body.user.products.accounts && !sA.body.user.products.hrms
        && sB.body.user.products.accounts && !sB.body.user.products.ats && !sB.body.user.products.hrms
        && sC.body.user.products.hrms && !sC.body.user.products.ats && !sC.body.user.products.accounts);
      check('F', 'role per product: Recruiter in ATS only / Accountant in Accounts only / HR in HRMS only', sA.body.user.productRoles.ats === 'RECRUITER' && sA.body.user.productRoles.accounts === 'NONE' && sB.body.user.productRoles.accounts === 'ACCOUNTANT' && sB.body.user.productRoles.ats === 'NONE' && sC.body.user.productRoles.hrms === 'HR' && sC.body.user.productRoles.accounts === 'NONE');
      check('F', 'the session answers carry no Login ID', ![sA, sB, sC].some((s) => 'loginId' in s.body.user) && !/login ?id/i.test(JSON.stringify(sA.body.user)));
      check('F', 'the extra logins carry the person\'s employee context but nothing derived from the designation', sB.body.user.extraLogin === true && sC.body.user.extraLogin === true && sA.body.user.extraLogin === false && sB.body.user.employeeId === emp.id);
      const probe = async (token, p) => (await http('GET', p, token)).status;
      const grid = { A: [], B: [], C: [] };
      for (const [k, t] of [['A', tA], ['B', tB], ['C', tC]]) for (const p of ['/api/invoices', '/api/candidates', '/api/employees']) grid[k].push(await probe(t, p)); // eslint-disable-line no-await-in-loop
      check('F', 'Recruiter login: ATS candidates open (200); invoices and employee master are refused (403)', grid.A[1] === 200 && grid.A[0] === 403 && grid.A[2] === 403, grid.A);
      check('F', 'Accounts login: invoices open (200); candidates and employee master are refused (403)', grid.B[0] === 200 && grid.B[1] === 403 && grid.B[2] === 403, grid.B);
      check('F', 'HR login: employee master opens (200); invoices and candidates are refused (403)', grid.C[2] === 200 && grid.C[0] === 403 && grid.C[1] === 403, grid.C);
      check('F', 'none of the three can open Administration -> Users (403): an email is not admin power', (await probe(tA, '/api/admin/users')) === 403 && (await probe(tB, '/api/admin/users')) === 403 && (await probe(tC, '/api/admin/users')) === 403);
      const me = await http('GET', '/api/auth/me', tB);
      check('F', '/me of the Accounts login is its own account', me.status === 200 && me.body.id === L[1].id);
    }

    // ============================================================ G  sign-in by the shared EMAIL
    {
      const ip = randIp();
      const em = (e, p) => http('POST', '/api/auth/login', null, { email: e, password: p }, { ip });
      const one = await em(SHARED, pw[0]);
      check('G', 'ONE account on the email matches: signs in (1 of 3 logins)', one.status === 200 && one.body.user.id === L[0].id, [one.status, one.text.slice(0, 200)]);
      const spaced = await em(`  ${SHARED.toUpperCase()}  `, pw[0]);
      check('G', 'typing is forgiving: capitals and spaces around the email', spaced.status === 200 && spaced.body.user.id === L[0].id, spaced.status);
      // make C use B's password (as a person might): the question appears
      await http('POST', `/api/admin/users/${L[2].id}/reset-password`, T, { password: pw[1] });
      const two = await em(SHARED, pw[1]);
      check('G', 'two logins hold the same password: "Choose your account" (200), no token yet', two.status === 200 && two.body.chooseAccount === true && !two.body.token && !two.body.user, two.text.slice(0, 300));
      const accts = (two.body && two.body.accounts) || [];
      check('G', 'the list shows only role + department of the two that match (not the Recruiter one), nothing else', accts.length === 2 && accts.every((a) => Object.keys(a).sort().join() === 'choice,label') && accts.some((a) => /Accountant/.test(a.label) && /Education/.test(a.label)) && accts.some((a) => /HR/.test(a.label) && /Education/.test(a.label)) && !accts.some((a) => /Recruiter/.test(a.label)), accts);
      const leak = JSON.stringify(two.body);
      check('G', 'no name, phone, employee code, e-mail address or Login ID in that answer', !leak.includes(emp.name) && !leak.includes(emp.phone) && !leak.includes(emp.employeeCode) && !leak.includes('@') && !/ZZTEST/i.test(leak) && !/login ?id|TL-LOGIN/i.test(leak), leak.slice(0, 300));
      const selTok = two.body.selectionToken;
      const ch = (t, c, o = {}) => http('POST', '/api/auth/login/choose', null, { selectionToken: t, choice: c }, { ip, ...o });
      const wrongBrowser = await ch(selTok, '0', { ip: randIp() });
      check('G', 'the choice only works from the same browser/address that proved the password', wrongBrowser.status === 401 && wrongBrowser.body.code === 'CHOICE_INVALID', wrongBrowser.body);
      check('G', 'a position that was not in the list cannot be chosen', (await ch(selTok, '7')).status === 401);
      check('G', 'a tampered token is refused', (await ch(`${selTok.slice(0, -3)}${selTok.endsWith('AAA') ? 'BBB' : 'AAA'}`, '0')).status === 401);
      const hrPick = accts.find((a) => /HR/.test(a.label)).choice;
      const chosen = await ch(selTok, hrPick);
      check('G', 'choosing signs in as exactly the chosen login (HR), with its own session', chosen.status === 200 && chosen.body.user.id === L[2].id && chosen.body.user.products.hrms && !chosen.body.user.products.accounts, [chosen.status, chosen.text.slice(0, 200)]);
      check('G', 'the choice token works once only', (await ch(selTok, hrPick)).status === 401);
      const realNow = Date.now;
      let expTok;
      try {
        Date.now = () => realNow() - 6 * 60 * 1000;
        const fakeReq = { headers: { 'user-agent': 'node', 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } };
        expTok = LA.makeSelectionToken([{ id: L[1].id, passwordHash: (await prisma.user.findUnique({ where: { id: L[1].id } })).passwordHash }], fakeReq, 'x').token;
      } finally { Date.now = realNow; }
      const exp = await ch(expTok, '0', { headers: { 'user-agent': 'node' } });
      check('G', 'a token older than 5 minutes is refused', exp.status === 401 && exp.body.code === 'CHOICE_EXPIRED', exp.body);
      // a reset between the question and the answer voids the question
      const two2 = await em(SHARED, pw[1]);
      await http('POST', `/api/admin/users/${L[2].id}/reset-password`, T, { password: pw[2] });
      const voided = await ch(two2.body.selectionToken, two2.body.accounts.find((a) => /HR/.test(a.label)).choice);
      check('G', 'if that password is changed before the person answers, the choice is void', voided.status === 401, voided.status);
      // wrong / unknown / a Login-ID-looking text
      const wrongShared = await em(SHARED, 'Wrong#Pass1234');
      const unknown = await em(`nobody-${RUN}@example.test`, 'Wrong#Pass1234');
      check('G', 'wrong password on the shared email = the same answer as an unknown email (status, body)', wrongShared.status === 401 && unknown.status === 401 && JSON.stringify(wrongShared.body) === JSON.stringify(unknown.body), [wrongShared.body, unknown.body]);
      const looks = await em('TL-LOGIN-101', pw[0]);
      check('G', 'a typed "TL-LOGIN-101" is just an unknown email: the same generic failure', looks.status === 401 && JSON.stringify(looks.body) === JSON.stringify(unknown.body), looks.body);
      const t1 = []; const t2 = [];
      for (let i = 0; i < 3; i += 1) { t1.push((await em(SHARED, 'Wrong#Pass1234')).ms); t2.push((await em(`nobody${i}-${RUN}@example.test`, 'Wrong#Pass1234')).ms); }
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      check('G', 'about the same work and time for a shared email and for an unknown one', Math.abs(avg(t1) - avg(t2)) < 900, [avg(t1), avg(t2)]);
    }

    // ============================================================ H  lockout is per account
    {
      const SOLO = `zz-ml-solo-${RUN}@example.test`;
      const soloPw = PW('s');
      const uSolo = await mkUser('solo', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, email: SOLO, passwordHash: await bcrypt.hash(soloPw, 4) });
      const ip = randIp();
      const statuses = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await http('POST', '/api/auth/login', null, { email: SOLO, password: `Bad#Pass${i}xx` }, { ip })).status);
      check('H', 'an email with ONE login: 5 wrong tries, then that login is locked (423)', statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 423, statuses);
      check('H', 'while locked even the right password is refused (423)', (await http('POST', '/api/auth/login', null, { email: SOLO, password: soloPw }, { ip })).status === 423);
      const sib = [await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[1] }, { ip }), await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[2] }, { ip })];
      check('H', 'other people\'s logins are not affected', sib.every((s) => s.status === 200), sib.map((s) => s.status));
      void uSolo;
      // the shared email: wrong tries are not attributable to one login, so they lock NOBODY
      const sh = [];
      for (let i = 0; i < 6; i += 1) sh.push((await http('POST', '/api/auth/login', null, { email: SHARED, password: `Nope#Pass${i}yy` }, { ip })).status);
      const after = await prisma.user.findMany({ where: { id: { in: L.map((l) => l.id) } }, select: { lockedUntil: true, failedLoginCount: true } });
      check('H', 'six wrong tries on the shared email: plain 401s that lock NO login and count against NO login', sh.every((s) => s === 401) && after.every((r) => !r.lockedUntil && r.failedLoginCount === 0), [sh, after]);
      // one login of the three locked (as the single-login rule would): the others still sign in
      await prisma.user.update({ where: { id: L[0].id }, data: { lockedUntil: new Date(Date.now() + 600000) } });
      const others = [await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[1] }, { ip }), await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[2] }, { ip })];
      check('H', 'with one login of the email locked, the other two still sign in by email', others.every((s) => s.status === 200), others.map((s) => s.status));
      await prisma.user.update({ where: { id: L[0].id }, data: { lockedUntil: null, failedLoginCount: 0 } });
    }

    // ============================================================ I  reset and change touch one login only
    {
      const hashes = async () => Object.fromEntries((await prisma.user.findMany({ where: { id: { in: L.map((l) => l.id) } }, select: { id: true, passwordHash: true } })).map((r) => [r.id, r.passwordHash]));
      const h0 = await hashes();
      const before = mailsTo(SHARED).length;
      const unknownReq = await http('POST', '/api/auth/forgot-password', null, { email: `ghost-${RUN}@example.test` });
      const sharedReq = await http('POST', '/api/auth/forgot-password', null, { email: SHARED });
      check('I', 'forgot-password gives the SAME answer for the shared email and for an unknown one', sharedReq.status === 200 && unknownReq.status === 200 && JSON.stringify(sharedReq.body) === JSON.stringify(unknownReq.body), [sharedReq.body, unknownReq.body]);
      const idReq = await http('POST', '/api/auth/forgot-password', null, { email: 'TL-LOGIN-101' });
      check('I', 'a "TL-LOGIN-101" is not accepted here either (it is not an email)', idReq.status === 400, idReq.body);
      await waitMails(SHARED, before + 1); await sleep(800);
      const resetMails = mailsTo(SHARED).slice(before);
      check('I', 'ONE e-mail goes to the shared mailbox (not one per login)', resetMails.length === 1, resetMails.map((m) => m.subject));
      const rm = resetMails[0];
      const items = [...rm.text.matchAll(/Your (.+?) login\s+Reset link: \S+new-password\?token=([a-f0-9]{64})/g)].map((m) => ({ label: m[1], token: m[2] }));
      check('I', 'it lists each login by role and department with its OWN link, nothing confidential, no Login ID', items.length === 3 && ['Recruiter', 'Accountant', 'HR'].every((r) => items.some((x) => x.label.startsWith(r) && /Education/.test(x.label))) && new Set(items.map((x) => x.token)).size === 3 && !rm.text.includes(emp.name) && !rm.text.includes(emp.phone) && !/login ?id|TL-LOGIN/i.test(rm.text + rm.html), items.map((x) => x.label));
      const linkA = items.find((x) => /^Recruiter/.test(x.label));
      const linkB = items.find((x) => /^Accountant/.test(x.label));
      const chk = await http('GET', `/api/auth/reset-password/check?token=${linkA.token}`);
      check('I', 'the reset page check leaks no e-mail / account detail', chk.status === 200 && !chk.text.includes('@'), chk.text.slice(0, 200));
      const newA = PW('a2');
      const resetA = await http('POST', '/api/auth/reset-password', null, { token: linkA.token, password: newA, confirmPassword: newA });
      check('I', 'link A resets the password of login A', resetA.status === 200, resetA.body);
      const h1 = await hashes();
      check('I', 'only A\'s hash changed; B and C untouched', h1[L[0].id] !== h0[L[0].id] && h1[L[1].id] === h0[L[1].id] && h1[L[2].id] === h0[L[2].id]);
      const sign = (p) => http('POST', '/api/auth/login', null, { email: SHARED, password: p });
      const [signA2, signAold, signB, signC] = [await sign(newA), await sign(pw[0]), await sign(pw[1]), await sign(pw[2])];
      check('I', 'A signs in with the new password, not the old; B and C still use theirs', signA2.status === 200 && signA2.body.user.id === L[0].id && signAold.status === 401 && signB.status === 200 && signC.status === 200, [signA2.status, signAold.status, signB.status, signC.status]);
      pw[0] = newA;
      check('I', 'link A works once', (await http('POST', '/api/auth/reset-password', null, { token: linkA.token, password: PW('a3') })).status === 410);
      check('I', 'link B is still valid (A\'s reset did not burn it)', (await http('GET', `/api/auth/reset-password/check?token=${linkB.token}`)).status === 200);
      // the hint on the reset page
      const hint = await http('POST', '/api/auth/reset-password/same-check', null, { token: linkB.token, password: pw[2] });
      check('I', 'the reset page hint: "already used by your other login" is told for C\'s password, not for a new one', hint.status === 200 && hint.body.sameAsOther === true && (await http('POST', '/api/auth/reset-password/same-check', null, { token: linkB.token, password: PW('fresh') })).body.sameAsOther === false, hint.body);
      // self-service change on A leaves siblings alone
      const tokA = (await sign(pw[0])).body.token;
      const newA2 = PW('a4');
      const chg = await http('POST', '/api/auth/change-password', tokA, { currentPassword: pw[0], newPassword: newA2, confirmPassword: newA2 });
      pw[0] = newA2;
      const h2 = await hashes();
      check('I', 'a self-service password change on A changes only A', chg.status === 200 && h2[L[1].id] === h1[L[1].id] && h2[L[2].id] === h1[L[2].id] && h2[L[0].id] !== h1[L[0].id], chg.body);
      const newC = PW('c9');
      const adminReset = await http('POST', `/api/admin/users/${L[2].id}/reset-password`, T, { password: newC });
      const h3 = await hashes();
      check('I', 'an Admin reset of C leaves A and B alone', adminReset.status === 200 && h3[L[0].id] === h2[L[0].id] && h3[L[1].id] === h2[L[1].id] && h3[L[2].id] !== h2[L[2].id], adminReset.body);
      pw[2] = newC;
      check('I', 'B is unaffected', (await sign(pw[1])).status === 200);
      const sa = await http('POST', `/api/admin/logins/${L[1].id}/send-activation`, T, {});
      await sleep(500);
      const lastM = mailsTo(SHARED).slice(-1)[0];
      check('I', 'Admin sends a fresh link to ONE login: the mail names only that login\'s role', sa.status === 200 && sa.body.sent === true && !sa.body.link && /Accountant/.test(lastM.subject) && !/Recruiter|HR/.test(lastM.subject), lastM && lastM.subject);
      check('I', 'B\'s current password keeps working until the new link is used', (await sign(pw[1])).status === 200);
    }

    // ============================================================ J  switch off / sign out / permissions are per login
    {
      const signin = async (i) => (await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[i] })).body.token;
      const tA = await signin(0); let tB = await signin(1); const tC = await signin(2);
      const ok = async (t) => (await http('GET', '/api/auth/me', t)).status;
      check('J', 'before: all three sessions work', (await ok(tA)) === 200 && (await ok(tB)) === 200 && (await ok(tC)) === 200);
      const off = await http('POST', `/api/admin/users/${L[1].id}/toggle-status`, T, {});
      check('J', 'Admin switches off login B (Accounts)', off.status === 200 && off.body.status === 'Inactive', off.body);
      const bS = await ok(tB);
      check('J', 'B\'s open session is refused at once', bS === 403 || bS === 401, bS);
      const bSign = await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[1] });
      check('J', 'B cannot sign in while off (plain message); A and C keep working on the same email', bSign.status === 403 && /inactive/i.test(bSign.body.error) && (await ok(tA)) === 200 && (await ok(tC)) === 200, bSign.body);
      check('J', 'the shared email still signs in as A while B is off', (await http('POST', '/api/auth/login', null, { email: SHARED, password: pw[0] })).body.user.id === L[0].id);
      const on = await http('POST', `/api/admin/users/${L[1].id}/toggle-status`, T, {});
      check('J', 'switching B on again works (same password)', on.status === 200 && (await ok(tB)) === 200, on.body);
      await sleep(1100);
      const rev = await http('POST', `/api/admin/logins/${L[1].id}/revoke`, T, {});
      check('J', 'Revoke on B: switched off and signed out (answer has no Login ID)', rev.status === 200 && rev.body.status === 'Inactive' && !('loginId' in rev.body), rev.body);
      const revS = await http('GET', '/api/auth/me', tB);
      check('J', 'B\'s older session is refused after revoke', revS.status === 403 || revS.status === 401, revS.status);
      await http('POST', `/api/admin/users/${L[1].id}/toggle-status`, T, {});
      const revS2 = await http('GET', '/api/auth/me', tB);
      check('J', '... the old token stays dead once B is on again (401, LOGIN_REVOKED)', revS2.status === 401 && revS2.body.code === 'LOGIN_REVOKED', revS2.body);
      tB = await signin(1);
      check('J', 'B signs in afresh and works; A and C never noticed', (await ok(tB)) === 200 && (await ok(tA)) === 200 && (await ok(tC)) === 200);
      check('J', 'an Admin cannot revoke their own login (409)', (await http('POST', `/api/admin/logins/${uSA.id}/revoke`, T, {})).status === 409);
      check('J', 'a non-admin cannot revoke (403)', (await http('POST', `/api/admin/logins/${L[1].id}/revoke`, TP, {})).status === 403);
      const meBefore = (await http('GET', '/api/auth/me', tB)).body.productRoles;
      const edit = await http('PUT', `/api/admin/users/${L[0].id}`, T, { hrmsAccess: true, hrmsRole: 'EMPLOYEE' });
      const meA = (await http('GET', '/api/auth/me', tA)).body.products;
      const meB = (await http('GET', '/api/auth/me', tB)).body;
      const meC = (await http('GET', '/api/auth/me', tC)).body;
      check('J', 'giving A an HRMS role changes A only; B and C keep exactly their modules', edit.status === 200 && meA.hrms === true && JSON.stringify(meB.productRoles) === JSON.stringify(meBefore) && meB.products.hrms === false && meC.products.accounts === false && meC.products.ats === false, [edit.status, meA, meB.products, meC.products]);
    }

    // ============================================================ K  concurrency, "Login 1 / Login 2", the wait, no secrets
    {
      const emp5 = await prisma.employee.create({ data: { employeeCode: `ZZMC${RUN.toUpperCase()}`, name: `ZZTEST Parallel ${RUN}`, email: `zz-ml-par-${RUN}@example.test`, department: 'Education', designation: 'Recruiter', employmentStatus: 'Active' } });
      made.employees.push(emp5.id);
      const parEmail = `zz-ml-par-${RUN}@example.test`;
      const mainP = await http('POST', '/api/admin/users', T, { name: `ZZTEST Parallel ${RUN}`, email: parEmail, role: 'EMPLOYEE', employeeId: emp5.id, sendActivation: true, atsAccess: true, atsRole: 'RECRUITER' });
      made.users.push(mainP.body.id);
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => http('POST', '/api/admin/users', T, { name: `ZZTEST Parallel ${RUN} ${i}`, email: parEmail, role: 'EMPLOYEE', employeeId: emp5.id, additionalLogin: true, hrmsAccess: true, hrmsRole: 'EMPLOYEE' })));
      results.forEach((r) => r.body && r.body.id && made.users.push(r.body.id));
      check('K', 'five logins created at the same moment: five 201 and five different accounts', results.every((r) => r.status === 201) && new Set(results.map((r) => r.body.id)).size === 5, results.map((r) => r.status));
      // two of them get the SAME password; their question reads "(Login 1)" / "(Login 2)" by creation order
      const same = PW('par');
      await http('POST', `/api/admin/users/${results[0].body.id}/reset-password`, T, { password: same });
      await http('POST', `/api/admin/users/${results[1].body.id}/reset-password`, T, { password: same });
      const q2 = await http('POST', '/api/auth/login', null, { email: parEmail, password: same });
      const labels = ((q2.body && q2.body.accounts) || []).map((a) => a.label);
      check('K', 'two logins with the same role + department and the same password are told apart as "Login 1" / "Login 2" (oldest first)', q2.body.chooseAccount === true && labels.length === 2 && /\(Login 1\)$/.test(labels[0]) && /\(Login 2\)$/.test(labels[1]), labels);
      const ipK = randIp();
      const waitCodes = [];
      for (let i = 0; i < 11; i += 1) waitCodes.push((await http('POST', '/api/auth/login', null, { email: parEmail, password: `Nope#Pass${i}yy` }, { ip: ipK })).status);
      check('K', 'ten wrong tries on a shared e-mail: 401 each; the eleventh is told to wait (429)', waitCodes.slice(0, 10).every((s) => s === 401) && waitCodes[10] === 429, waitCodes);
      const parRows = await prisma.user.findMany({ where: { email: parEmail }, select: { lockedUntil: true, failedLoginCount: true } });
      check('K', '... and none of the six logins on it is locked or counted', parRows.length === 6 && parRows.every((r) => !r.lockedUntil && r.failedLoginCount === 0), parRows);
      const list = await http('GET', '/api/admin/users', T);
      const logs = await http('GET', `/api/admin/logins/by-email?email=${encodeURIComponent(SHARED)}`, T);
      const blob = list.text + logs.text;
      check('K', 'Admin answers never contain a password, hash or reset token', !/\$2[aby]\$/.test(blob) && !/"passwordHash"|"setPasswordTokenHash"|"token"/.test(blob) && !blob.includes(pw[0]) && !blob.includes(pw[1]));
      check('K', 'no password appears in the audit trail', (await raw('SELECT COUNT(*) n FROM "AuditLog" WHERE toValue LIKE ? OR reason LIKE ?', `%${pw[1]}%`, `%${pw[1]}%`))[0].n === 0);
      const hits = [];
      for (const t of ['User', 'AppSetting', 'AuditLog', 'Notification']) {
        const cols = (await raw(`PRAGMA table_info("${t}")`)).map((c) => c.name);
        const where = cols.map((c) => `instr(CAST("${c}" AS TEXT), ?) > 0`).join(' OR ');
        if ((await raw(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`, ...cols.map(() => pw[1])))[0].n) hits.push(t);
      }
      check('K', 'a password is nowhere in the database in clear', hits.length === 0, hits);
      const actMails = mails().filter((m) => /Set your TeamLink password/.test(m.subject));
      check('K', 'activation mails never carry a password', actMails.length >= 3 && actMails.every((m) => !m.text.includes(pw[0]) && !m.text.includes(pw[1])), actMails.length);
    }

    // ============================================================ L  one e-mail, one WhatsApp, a bell per login
    {
      process.env.TEST_MAIL_CAPTURE = CAPTURE;
      const SD = require(path.join(BACK, 'src/utils/shareDedupe'));
      const mailer = require(path.join(BACK, 'src/utils/mailer'));
      const wa = require(path.join(BACK, 'src/utils/whatsappCloud'));
      const CAT = require(path.join(BACK, 'src/utils/adminCatalog'));
      const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
      const w = await writeValues('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.bulkTpl]: 'zz_bulk' });
      await prisma.integration.upsert({ where: { id: 'whatsapp' }, create: { id: 'whatsapp', values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected', error: null } });
      SD.forget();
      const subj = `ZZTEST notice ${RUN}`;
      const n0 = mailsTo(SHARED).length;
      const hn = require(path.join(BACK, 'src/utils/hrmsNotify'));
      const settings = { events: { leaveDecision: { inApp: true, email: true, mode: 'now' } }, mailMode: 'now', emailsOn: true, digestTime: '19:00', reminderTime: '09:30', taskDueDays: 1 };
      for (const l of L) await hn.notify('leaveDecision', { userId: l.id, name: emp.name, email: SHARED }, { title: subj, message: 'Your leave was approved.' }, { settings }); // eslint-disable-line no-await-in-loop
      await sleep(400);
      const bells = await prisma.notification.findMany({ where: { title: subj, channel: 'In-App' }, select: { userId: true } });
      check('L', 'HRMS notifier called for all three logins of one person: the mailbox gets ONE e-mail', mailsTo(SHARED).length - n0 === 1);
      check('L', '... and each login has its OWN bell notice', new Set(bells.map((b) => b.userId)).size === 3, bells.length);
      const n1 = mailsTo(SHARED).length;
      const direct = [];
      for (let i = 0; i < 3; i += 1) direct.push(await mailer.sendMail({ to: SHARED, subject: `ZZTEST direct ${RUN}`, text: 'Same message for all three logins.', useEmployeeFrom: false })); // eslint-disable-line no-await-in-loop
      await sleep(300);
      check('L', 'the same message handed to the mailer three times for a shared address is sent ONCE (the others report ok, deduped)', mailsTo(SHARED).length - n1 === 1 && direct.every((d) => d.ok) && direct.filter((d) => d.deduped).length === 2, direct);
      const solo = `zz-ml-nolo-${RUN}@example.test`;
      const n2 = mailsTo(solo).length;
      for (let i = 0; i < 2; i += 1) await mailer.sendMail({ to: solo, subject: `ZZTEST solo ${RUN}`, text: 'Same message twice to someone with ONE login.', useEmployeeFrom: false }); // eslint-disable-line no-await-in-loop
      await sleep(300);
      check('L', 'control: the same message twice to an address with ONE login is NOT held back (two e-mails)', mailsTo(solo).length - n2 === 2);
      const diff = mailsTo(SHARED).length;
      await mailer.sendMail({ to: SHARED, subject: `ZZTEST direct ${RUN}`, text: 'A different text for the same address.', useEmployeeFrom: false });
      await sleep(300);
      check('L', 'a different message to the shared address still goes', mailsTo(SHARED).length - diff === 1);
      SD.forget();
      const wa1 = await wa.sendWhatsApp({ to: emp.phone, kind: 'bulk', text: `ZZTEST wa ${RUN}` });
      const wa2 = await wa.sendWhatsApp({ to: emp.phone, kind: 'bulk', text: `ZZTEST wa ${RUN}` });
      const wa3 = await wa.sendWhatsApp({ to: emp.phone, kind: 'bulk', text: `ZZTEST wa ${RUN}` });
      check('L', 'the same WhatsApp to the person\'s mobile three times: sent once, the others deduped', wa1.ok && !wa1.deduped && wa2.deduped === true && wa3.deduped === true, [wa1, wa2, wa3]);
      const other = await wa.sendWhatsApp({ to: '9876501234', kind: 'bulk', text: `ZZTEST wa ${RUN}` });
      const other2 = await wa.sendWhatsApp({ to: '9876501234', kind: 'bulk', text: `ZZTEST wa ${RUN}` });
      check('L', 'control: a number with ONE person is never held back', other.ok && !other.deduped && other2.ok && !other2.deduped, [other, other2]);
      const key = 'mail|zz-fail@example.test|abc';
      check('L', 'a failed send gives its mark back (so a retry is not mistaken for a repeat)', SD.claim(key) === true && SD.claim(key) === false && (SD.release(key), SD.claim(key) === true));
      check('L', 'uniqueRecipients keeps one entry per e-mail and per mobile', SD.uniqueRecipients([{ email: 'A@x.com' }, { email: 'a@X.com' }, { email: 'b@x.com', mobile: '98765 43210' }, { email: 'c@x.com', mobile: '+91 9876543210' }]).length === 2);
    }

    // ============================================================ M  everything that existed before still works
    {
      const all = await prisma.user.findMany({ where: { id: { notIn: made.users } }, select: { id: true, email: true, status: true, role: true, name: true } });
      const known = await bcrypt.hash('Legacy#Pass77x', 4);
      await prisma.user.updateMany({ where: { id: { in: all.map((u) => u.id) } }, data: { passwordHash: known, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
      const outcome = { ok: 0, refused: 0, other: [], why: {} };
      let sameAccount = true; let noIds = true;
      for (const u of all) {
        // eslint-disable-next-line no-await-in-loop
        const r = await http('POST', '/api/auth/login', null, { email: u.email, password: 'Legacy#Pass77x' });
        if (r.status === 200) {
          outcome.ok += 1;
          if (r.body.user.id !== u.id) sameAccount = false;
          if ('loginId' in r.body.user) noIds = false;
        } else if (r.status === 403) { outcome.refused += 1; const k = String(r.body && r.body.error).replace(/[0-9]+/g, 'n').slice(0, 70); outcome.why[k] = (outcome.why[k] || 0) + 1; } else outcome.other.push([r.status]);
      }
      console.log(`      (refused for: ${JSON.stringify(outcome.why)})`);
      check('M', `all ${all.length} existing logins: signing in by e-mail gives the same account as before (${outcome.ok} in, ${outcome.refused} refused for their own reasons: off / left / no access)`, outcome.other.length === 0 && sameAccount && outcome.ok > 0, outcome);
      check('M', '... none of them needed (or was given) a Login ID', noIds && (await raw('SELECT COUNT(*) n FROM "User" WHERE "loginId" IS NOT NULL'))[0].n === idsBefore);
      check('M', 'the request shape { email, password } works exactly as before', [200, 403].includes((await http('POST', '/api/auth/login', null, { email: all.find((u) => u.status === 'Active').email, password: 'Legacy#Pass77x' })).status));
      check('M', 'a request without a password is still a 400', (await http('POST', '/api/auth/login', null, { email: 'x@y.z' })).status === 400);
      const client = await prisma.client.findFirst({ select: { id: true } });
      if (client) {
        const cu = await prisma.user.create({ data: { ...base, passwordHash: await bcrypt.hash('Client#Pass77x', 4), name: `ZZTEST ML client ${RUN}`, email: `zz-ml-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT', atsAccess: true, clientId: client.id, portalType: 'REVIEWER' } });
        made.users.push(cu.id);
        const cr = await http('POST', '/api/auth/login', null, { email: cu.email, password: 'Client#Pass77x' });
        check('M', 'a client portal login still signs in by e-mail (role CLIENT, its own landing)', cr.status === 200 && cr.body.user.role === 'CLIENT' && cr.body.user.landingPath === '/client-portal', [cr.status, cr.text.slice(0, 200)]);
        check('M', 'a client login still cannot open staff APIs (403)', (await http('GET', '/api/admin/users', cr.body.token)).status === 403);
      }
      const hash = await http('POST', '/api/vendor-portal/login', null, { email: `nobody-${RUN}@example.test`, password: 'x' });
      check('M', 'the vendor sign-in is a separate system and still answers (401, not a server error)', [401, 400, 429].includes(hash.status), hash.status);
    }

    // ============================================================ N  the SAME email as a staff login AND a vendor / partner login
    {
      const VSE = `zz-ml-vs-${RUN}@example.test`;
      const vsPw = PW('vs');
      const uVS = await mkUser('vs', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, email: VSE, passwordHash: await bcrypt.hash(vsPw, 4) });
      await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: true, supportEmail: 'support@teamlink.example.test', supportPhone: '+91 90000 00000' }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: true, supportEmail: 'support@teamlink.example.test', supportPhone: '+91 90000 00000' }) } });
      const vendor = await prisma.officeVendor.create({ data: { name: `ZZTEST ML Vendor ${RUN}`, companyName: `ZZTEST ML Company ${RUN}`, isActive: true, category: 'Internet' } });
      const n0 = mailsTo(VSE).length;
      const mkV = await http('POST', '/api/vendor-logins', T, { vendorId: vendor.id, name: 'ZZTEST ML Vendor Contact', email: VSE });
      check('N', 'Admin creates a vendor login on an email that is a staff login: 201, no "staff login" error', mkV.status === 201 && !/staff login/i.test(mkV.text), [mkV.status, mkV.text.slice(0, 300)]);
      await waitMails(VSE, n0 + 1);
      const vmail = mailsTo(VSE).slice(n0).find((m) => /Temporary password/i.test(m.text));
      const vTemp = vmail && (/Temporary password:\s*(\S+)/.exec(vmail.text) || [])[1];
      check('N', 'the vendor welcome e-mail was captured (login ID line and temporary password)', !!vmail && !!vTemp && /Your login ID:\s*\S+/.test(vmail.text), vmail && vmail.subject);
      const vendorTwo = await prisma.officeVendor.create({ data: { name: `ZZTEST ML Vendor Two ${RUN}`, companyName: `ZZTEST ML Company Two ${RUN}`, isActive: true, category: 'Internet' } });
      const mkV2 = await http('POST', '/api/vendor-logins', T, { vendorId: vendorTwo.id, name: 'ZZTEST ML Vendor Two', email: VSE });
      check('N', '"Another vendor login already uses this email" still holds between two VENDOR logins', mkV2.status === 400 && /Another vendor login/.test(JSON.stringify(mkV2.body)), [mkV2.status, mkV2.body]);
      // the ONE login page: the staff sign-in first, then (on a plain 401) the vendor sign-in
      const page = async (email, password, ipIn) => {
        const ip = ipIn || randIp(); // (a new device each time: the vendor sign-in allows 10 tries per device and email in 15 minutes)
        const s = await http('POST', '/api/auth/login', null, { email, password }, { ip });
        if (s.status === 200 && s.body.chooseAccount) return { via: 'choose', staff: s };
        if (s.status !== 401) return { via: 'staff', staff: s };
        const v = await http('POST', '/api/vendor-portal/login', null, { email, password }, { ip });
        return { via: v.status === 200 ? 'vendor' : 'none', staff: s, vendor: v };
      };
      const vendorRow = () => prisma.vendorUser.findFirst({ where: { email: VSE } });
      const staffRow = () => prisma.user.findUnique({ where: { id: uVS.id } });
      const ipV = randIp();
      const seq = [];
      for (let i = 0; i < 10; i += 1) seq.push(await page(VSE, vTemp)); // eslint-disable-line no-await-in-loop
      check('N', 'the vendor signs in through the one-page sequence (staff attempt, then vendor) 10 times in a row: every time the vendor session', seq.every((r) => r.via === 'vendor' && r.vendor.body.token), seq.map((r) => r.via));
      const sr = await staffRow(); const vr = await vendorRow();
      check('N', '... the staff account has 0 failed attempts and is not locked', sr.failedLoginCount === 0 && !sr.lockedUntil, [sr.failedLoginCount, sr.lockedUntil]);
      check('N', '... the vendor is not locked and has 0 failed attempts', vr.failedLoginAttempts === 0 && !vr.lockedUntil, [vr.failedLoginAttempts, vr.lockedUntil]);
      const st = await page(VSE, vsPw);
      check('N', 'the staff person signs in with the staff password: the STAFF workspace (not the vendor\'s)', st.via === 'staff' && st.staff.status === 200 && st.staff.body.user.id === uVS.id && !!st.staff.body.token, [st.via, st.staff.status]);
      // wrong passwords: counted against nobody on a shared email
      const bad = [];
      for (let i = 0; i < 6; i += 1) bad.push(await page(VSE, `Wrong#Pass${i}zz`)); // eslint-disable-line no-await-in-loop
      const sr2 = await staffRow(); const vr2 = await vendorRow();
      check('N', 'six wrong passwords through the one page: refused every time, and NOBODY is locked or counted (staff or vendor)', bad.every((r) => r.via === 'none' && r.staff.status === 401) && sr2.failedLoginCount === 0 && !sr2.lockedUntil && vr2.failedLoginAttempts === 0 && !vr2.lockedUntil, [bad.map((r) => r.via), sr2.failedLoginCount, vr2.failedLoginAttempts]);
      check('N', 'a wrong password is the same plain answer as an unknown email', JSON.stringify(bad[0].staff.body) === JSON.stringify((await http('POST', '/api/auth/login', null, { email: `nobody-${RUN}@example.test`, password: 'Wrong#Pass9zz' }, { ip: ipV })).body));
      // the same password on both: the question
      const keepHash = (await staffRow()).passwordHash;
      await prisma.user.update({ where: { id: uVS.id }, data: { passwordHash: await bcrypt.hash(vTemp, 4) } });
      const both = await http('POST', '/api/auth/login', null, { email: VSE, password: vTemp }, { ip: ipV });
      const bl = (both.body.accounts || []).map((a) => a.label);
      check('N', 'the SAME password on the staff and the vendor login: "Choose your account" with "Staff - <role> (<department>)" and "Vendor - <company>"', both.status === 200 && both.body.chooseAccount === true && bl.length === 2 && bl.some((l) => /^Staff - /.test(l)) && bl.some((l) => /^Vendor - ZZTEST ML Vendor/.test(l)) && !JSON.stringify(both.body).includes('@'), bl);
      const vIdx = both.body.accounts.find((a) => /^Vendor - /.test(a.label)).choice;
      const sIdx = both.body.accounts.find((a) => /^Staff - /.test(a.label)).choice;
      const chV = await http('POST', '/api/auth/login/choose', null, { selectionToken: both.body.selectionToken, choice: vIdx }, { ip: ipV });
      check('N', 'choosing the vendor hands over to the vendor sign-in (no staff token), which then signs the vendor in', chV.status === 200 && chV.body.useVendor === true && !chV.body.token && (await http('POST', '/api/vendor-portal/login', null, { email: VSE, password: vTemp })).status === 200, chV.body);
      const both2 = await http('POST', '/api/auth/login', null, { email: VSE, password: vTemp }, { ip: ipV });
      const chS = await http('POST', '/api/auth/login/choose', null, { selectionToken: both2.body.selectionToken, choice: both2.body.accounts.find((a) => /^Staff - /.test(a.label)).choice }, { ip: ipV });
      check('N', 'choosing the staff login opens the staff workspace', chS.status === 200 && chS.body.user.id === uVS.id, [chS.status, chS.text.slice(0, 120)]);
      void sIdx;
      await prisma.user.update({ where: { id: uVS.id }, data: { passwordHash: keepHash } });
      // forgot-password / reset
      const staffHashBefore = (await staffRow()).passwordHash;
      const vHashBefore = (await vendorRow()).passwordHash;
      const mBefore = mailsTo(VSE).length;
      await prisma.vendorUser.update({ where: { id: (await vendorRow()).id }, data: { passwordChangedAt: new Date() } }); // (the vendor has chosen a password: only then does forgot-password mail)
      const vf = await http('POST', '/api/vendor-portal/forgot-password', null, { email: VSE });
      await waitMails(VSE, mBefore + 1); await sleep(600);
      const vMails = mailsTo(VSE).slice(mBefore);
      check('N', 'vendor forgot-password: the vendor gets ITS mail; no staff reset mail; the staff account and password are untouched', vf.status === 200 && vMails.length >= 1 && !vMails.some((m) => /Reset your TeamLink password/.test(m.subject)) && (await staffRow()).passwordHash === staffHashBefore && !(await prisma.appSetting.findUnique({ where: { key: `pwreset:u:${uVS.id}` } })), vMails.map((m) => m.subject));
      const m2 = mailsTo(VSE).length;
      await http('POST', '/api/auth/forgot-password', null, { email: VSE });
      await waitMails(VSE, m2 + 1); await sleep(600);
      const sm = mailsTo(VSE).slice(m2);
      const linkS = sm.map((m) => linkOf(m)).find(Boolean);
      check('N', 'staff forgot-password on that email: the staff reset mail only, and the vendor password is untouched', sm.length === 1 && /Reset your TeamLink password/.test(sm[0].subject) && (await vendorRow()).passwordHash === vHashBefore, sm.map((m) => m.subject));
      const rs = await http('POST', '/api/auth/reset-password', null, { token: linkS.token, password: PW('vs2'), confirmPassword: PW('vs2') });
      check('N', 'resetting the staff password changes only the staff row; the vendor still signs in with its own password', rs.status === 200 && (await vendorRow()).passwordHash === vHashBefore && (await http('POST', '/api/vendor-portal/login', null, { email: VSE, password: vTemp })).status === 200);
      const vsNew = PW('vs2');
      // switched off / locked
      await prisma.vendorUser.update({ where: { id: (await vendorRow()).id }, data: { status: 'Inactive' } });
      const off = await page(VSE, vTemp);
      const stillStaff = await page(VSE, vsNew);
      check('N', 'vendor switched off: the vendor is refused; the staff login is not affected', off.via === 'none' && stillStaff.via === 'staff' && stillStaff.staff.status === 200 && (await staffRow()).failedLoginCount === 0);
      await prisma.vendorUser.update({ where: { id: (await vendorRow()).id }, data: { status: 'Active' } });
      await prisma.user.update({ where: { id: uVS.id }, data: { lockedUntil: new Date(Date.now() + 600000) } });
      const vWhileStaffLocked = await page(VSE, vTemp);
      check('N', 'staff login locked: the vendor still signs in through the one page (the staff lock does not block it)', vWhileStaffLocked.via === 'vendor', vWhileStaffLocked.via);
      await prisma.user.update({ where: { id: uVS.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
      // partner on the same email
      const partner = await prisma.partner.create({ data: { name: `ZZTEST ML Partner ${RUN}`, email: `zz-ml-partner-${RUN}@example.test` } });
      const mkP = await http('POST', '/api/partners/logins', T, { partnerId: partner.id, name: 'ZZTEST ML Partner Contact', email: VSE });
      check('N', 'Admin creates a PARTNER login on the same staff email: 201, no "staff login" error', mkP.status === 201 && !/staff login/i.test(mkP.text), [mkP.status, mkP.text.slice(0, 300)]);
      const mkP2 = await http('POST', '/api/partners/logins', T, { partnerId: partner.id, name: 'ZZTEST ML Partner Two', email: VSE });
      check('N', '"Another partner login already uses this email" still holds between two PARTNER logins', mkP2.status === 400 && /Another partner login/.test(JSON.stringify(mkP2.body)), [mkP2.status, mkP2.body]);
      check('N', 'the staff login and the vendor login are unaffected by the partner login', (await page(VSE, vsNew)).via === 'staff' && (await page(VSE, vTemp)).via === 'vendor');
      await http('POST', `/api/partners/logins/${mkP.body.login.id}/deactivate`, T, {});
      check('N', 'switching the partner login off changes nothing for the staff login', (await page(VSE, vsNew)).via === 'staff');
      // the edit-email window of a vendor login accepts a staff email too
      const vendor2 = await prisma.officeVendor.create({ data: { name: `ZZTEST ML Vendor B ${RUN}`, companyName: `ZZTEST ML Company B ${RUN}`, isActive: true, category: 'Internet' } });
      const mkV3 = await http('POST', '/api/vendor-logins', T, { vendorId: vendor2.id, name: 'ZZTEST ML Vendor B Contact', email: `zz-ml-vb-${RUN}@example.test` });
      const patchV = mkV3.body && mkV3.body.login ? await http('PATCH', `/api/vendor-logins/${mkV3.body.login.id}`, T, { email: SHARED }) : { status: 0, text: 'no login' };
      check('N', 'Edit email on a vendor login to a staff email is no longer refused as "a staff login"', !/staff login/i.test(patchV.text || ''), [patchV.status, (patchV.text || '').slice(0, 200)]);
    }

    // ============================================================ O  nothing person-facing says "Login ID"
    {
      check('O', 'no captured e-mail of this whole run mentions a Login ID or TL-LOGIN', mails().filter((m) => !/Your login ID:/.test(m.text)).every((m) => !/TL-LOGIN|login ID/i.test(m.text + m.html)), mails().filter((m) => /TL-LOGIN/i.test(m.text)).map((m) => m.subject));
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const FE = path.resolve(BACK, '..', 'frontend', 'src');
      const hits = walk(FE).filter((f) => /\.(jsx?|css)$/.test(f) && !/vendor/i.test(f)).filter((f) => /Login ID|loginId|TL-LOGIN/.test(fs.readFileSync(f, 'utf8')));
      check('O', 'the staff screens (frontend/src, vendor-portal files left out) never say "Login ID" and never use a loginId', hits.length === 0, hits.map((f) => path.relative(FE, f)));
      check('O', 'the server log has no error trace from this run', !/TypeError|ReferenceError|SqliteError|Unhandled|PrismaClient(Known|Unknown)RequestError/.test(serverLog), serverLog.split(LF).filter((l) => /TypeError|ReferenceError|SqliteError|Unhandled|PrismaClient/.test(l)).slice(0, 4));
    }
  } catch (err) {
    fail += 1;
    console.log(`FAIL  [crash] ${err && err.stack ? err.stack : err}`);
  } finally {
    try { if (server) server.kill(); } catch { /* gone */ }
    try { await prisma.$disconnect(); } catch { /* closed */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (!process.env.KEEP_DB && !process.env.COPY_DB) {
      for (const f of [copy, `${copy}-wal`, `${copy}-shm`, ...made.extraFiles, CAPTURE]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
      try { fs.rmSync(BACKUPS, { recursive: true, force: true }); } catch { /* gone */ }
    } else console.log(`kept: ${copy}`);
    process.exit(fail ? 1 : 0);
  }
})();
