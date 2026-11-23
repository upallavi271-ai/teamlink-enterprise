#!/usr/bin/env node
/**
 * CREDENTIALS VAULT (founder 2026-11-21): every company login in one place, encrypted, Super Admin only unless granted, Excel import.
 * Checks: encryption at rest (the database files hold no plaintext), default access (only the Super Admin), Role Catalog grant,
 * per-person grant, the employee-own switch, reveal needs a fresh password check and leaves an audit row, 5 wrong = lock, rate limit,
 * the list never carries a secret, import (template, header variants, column choice, masked preview, refusals, duplicates, choice,
 * apply, undo, the file is never stored), export with / without passwords + audit, other roles 403, bulk actions, no secret in logs.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database. Every value below is fake.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4400 node scripts/vault-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-vault-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-vault-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4400;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'vault-test', UPLOAD_DIR: UPLOADS,
  INTEGRATION_SECRET_KEY: 'fake-vault-test-key-not-a-real-secret', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text };
};
const fileCall = async (url, token, buf, name, fields = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(API + url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* none */ }
  return { status: r.status, body: j, text };
};
const blobCall = async (method, url, body, token, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
let server; let serverOut = '';
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}
const RUN = `${process.pid}${Date.now().toString(36).slice(-4)}`;
// every secret here is fake and unique to this run, so a search of the database files finds only this run's values
const PW = { sa: `Vz-Login-Sa-${RUN}`, emp: `Vz-Login-Emp-${RUN}`, plain: (n) => `Fake-Pass-${n}-${RUN}-Zq` };
const dbBytes = () => Buffer.concat(['', '-wal'].map((s) => { try { return fs.readFileSync(COPY + s); } catch { return Buffer.alloc(0); } }));
const filesUnder = (dir) => { const out = []; const walk = (d) => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } list.forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); }); }; walk(dir); return out; };
const sheet = (aoa, name = 'Logins') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
const readBook = (buf) => { const wb = XLSX.read(buf, { type: 'buffer' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }); };

(async () => {
  const hash = async (p) => bcrypt.hash(p, 8);
  const mk = async (tag, data, emp) => {
    const u = await prisma.user.create({ data: { name: `Vz ${tag} ${RUN}`, email: `vz.${tag}.${RUN}@vz-test.in`, username: `vz.${tag}.${RUN}@vz-test.in`, passwordHash: await hash(tag === 'sa' ? PW.sa : PW.emp), status: 'Active', hrmsRole: 'NONE', passwordChangedAt: new Date(Date.now() - 3600e3), passwordResetRequired: false, ...data } });
    if (emp) await prisma.employee.create({ data: { employeeCode: `VZ-${tag}-${RUN}`.toUpperCase(), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } });
    return u;
  };
  const sa = await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, accountsAccess: true, accountsRole: 'ADMIN' });
  const mgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsAccess: true, atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const acct = await mk('acct', { role: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { department: 'IT' });
  const empA = await mk('empa', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE' }, { department: 'Sales' });
  const empB = await mk('empb', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE' }, { department: 'IT' });
  const empARow = await prisma.employee.findFirst({ where: { userId: empA.id } });
  const twin1 = await prisma.employee.create({ data: { employeeCode: `VZ-T1-${RUN}`, name: `Vz Twin ${RUN}`, designation: 'Employee', employmentStatus: 'Active', department: 'IT' } });
  const twin2 = await prisma.employee.create({ data: { employeeCode: `VZ-T2-${RUN}`, name: `Vz Twin ${RUN}`, designation: 'Employee', employmentStatus: 'Active', department: 'HR' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; if (process.env.TEST_DEBUG) process.stdout.write(d); });
  server.stderr.on('data', (d) => { serverOut += d; if (process.env.TEST_DEBUG) process.stderr.write(d); });
  let up = false;
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1000); });
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const [k, u] of Object.entries({ sa, admin, mgr, acct, rec, empA, empB })) T[k] = await tok(u); // eslint-disable-line no-await-in-loop
  const V = '/credentials-vault';
  const reauth = async (t, pw) => call('POST', `${V}/reauth`, { password: pw }, t);
  const reveal = (t, id, ticket, body = { field: 'password', purpose: 'show' }) => call('POST', `${V}/credentials/${id}/reveal`, body, t, ticket ? { 'X-Vault-Reauth': ticket } : {});
  const plaintexts = [];
  const noSecret = (text) => !plaintexts.some((p) => String(text).includes(p)) && !String(text).includes('enc:v1:');

  // ---- default access ------------------------------------------------------------------------------------------------
  const meSa = await call('GET', `${V}/me`, null, T.sa);
  check('Super Admin: the vault is open with every right and the key is set', meSa.status === 200 && meSa.body.open && meSa.body.rights.reveal && meSa.body.rights.settings && meSa.body.keyConfigured, meSa.body);
  for (const k of ['admin', 'mgr', 'acct', 'rec', 'empA']) {
    // eslint-disable-next-line no-await-in-loop
    const m = await call('GET', `${V}/me`, null, T[k]); const l = await call('GET', `${V}/credentials`, null, T[k]);
    check(`default: ${k} cannot open the vault (me.open false, list 403)`, m.status === 200 && !m.body.open && l.status === 403, { me: m.body, list: l.status });
  }
  const meAuth = await call('GET', '/auth/me', null, T.sa);
  check('/auth/me tells the menu the Super Admin may open it; an Admin gets null', meAuth.body && meAuth.body.credentialsVault && meAuth.body.credentialsVault.open && (await call('GET', '/auth/me', null, T.admin)).body.credentialsVault === null);

  // ---- create + encryption at rest -----------------------------------------------------------------------------------
  plaintexts.push(PW.plain(1), PW.plain(2), PW.plain(3), `PIN-${RUN}-4711`);
  const c1 = await call('POST', `${V}/credentials`, { platform: 'naukri.com', label: 'Naukri IT', loginUrl: 'www.example.com/login', username: `vz.naukri.${RUN}@example.test`, password: PW.plain(1), extra: { pin: `PIN-${RUN}-4711` }, assignedEmployeeIds: [empARow.id], department: 'IT', renewalDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) }, T.sa);
  check('Super Admin adds a login: 201, platform tidied to "Naukri", URL given https://, the answer has no secret', c1.status === 201 && c1.body.credential.platform === 'Naukri' && c1.body.credential.loginUrl.startsWith('https://') && c1.body.credential.password === '••••••••' && noSecret(c1.text), c1.body);
  const id1 = c1.body.credential.id;
  const c2 = await call('POST', `${V}/credentials`, { platform: 'Hostinger', username: `vz.host.${RUN}@example.test`, password: PW.plain(2) }, T.sa);
  const id2 = c2.body.credential.id;
  check('a second login (Hostinger)', c2.status === 201);
  check('a duplicate platform + username is refused (409)', (await call('POST', `${V}/credentials`, { platform: 'Naukri', username: `VZ.NAUKRI.${RUN}@example.test`, password: 'x' }, T.sa)).status === 409);
  check('a javascript: login URL is refused', (await call('POST', `${V}/credentials`, { platform: 'Other', username: `vz.js.${RUN}`, loginUrl: 'javascript:alert(1)' }, T.sa)).status === 400);
  const raw = await prisma.$queryRawUnsafe('SELECT "passwordEnc","extraEnc" FROM "Credential" WHERE "id" = ?', id1);
  check('at rest the password and the PIN are AES-GCM ciphertext (enc:v1:...)', raw[0].passwordEnc.startsWith('enc:v1:') && raw[0].extraEnc.startsWith('enc:v1:') && !raw[0].passwordEnc.includes(PW.plain(1)));
  await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(FULL)').catch(() => {});
  check('the database files (db + wal) hold no plaintext password or PIN anywhere', !plaintexts.some((p) => dbBytes().includes(Buffer.from(p))));

  // ---- the list never carries a secret ------------------------------------------------------------------------------------
  const list = await call('GET', `${V}/credentials`, null, T.sa);
  check('list: masked, hasPassword / hasExtra flags, no secret and no ciphertext in the whole answer', list.status === 200 && list.body.rows.some((r) => r.id === id1 && r.password === '••••••••' && r.hasExtra && r.extraKinds === 'PIN') && noSecret(list.text) && !/passwordEnc|extraEnc/.test(list.text), list.text.slice(0, 300));
  const det = await call('GET', `${V}/credentials/${id1}`, null, T.sa);
  check('details: no secret, a history with "login added"', det.status === 200 && noSecret(det.text) && det.body.history.some((h) => h.action === 'create'));
  check('expiring soon: the Naukri login renews in 10 days', list.body.rows.find((r) => r.id === id1).renewalState === 'soon');

  // ---- reveal needs re-auth --------------------------------------------------------------------------------------------
  const r0 = await reveal(T.sa, id1, null);
  check('reveal without the password check: 401 REAUTH_NEEDED', r0.status === 401 && r0.body.code === 'REAUTH_NEEDED' && noSecret(r0.text), r0.body);
  check('reveal with a made-up ticket: 401', (await reveal(T.sa, id1, 'f'.repeat(64))).status === 401);
  const bad = await reauth(T.sa, 'not-my-password');
  check('a wrong TeamLink password at the check: 401 with tries left', bad.status === 401 && bad.body.code === 'REAUTH_WRONG' && bad.body.triesLeft === 4, bad.body);
  const ok = await reauth(T.sa, PW.sa);
  check('the right password gives a 5-minute ticket (and resets the wrong count)', ok.status === 200 && ok.body.token && ok.body.minutes === 5, ok.body);
  const TK = ok.body.token;
  const r1 = await reveal(T.sa, id1, TK);
  check('Show: the password, for 30 seconds', r1.status === 200 && r1.body.value === PW.plain(1) && r1.body.seconds === 30, r1.body);
  const rx = await reveal(T.sa, id1, TK, { field: 'extra', purpose: 'copy' });
  check('Copy the extra secret: the PIN comes back as { pin }', rx.status === 200 && rx.body.value.pin === `PIN-${RUN}-4711`, rx.body);
  const acc = await prisma.$queryRawUnsafe('SELECT * FROM "CredentialAccess" WHERE "credentialId" = ? AND "action" IN (\'show_password\',\'copy_extra\') AND "userId" = ?', id1, sa.id);
  check('every reveal / copy is in the access log with who, which login, when and the IP', acc.length === 2 && acc.every((a) => a.ip && a.at && a.userName === sa.name && a.credentialName.includes('Naukri')), acc);
  const aud = await prisma.auditLog.findMany({ where: { entity: 'Credential', entityId: id1 } });
  check('...and in the audit log ("password shown"), with no secret in any audit row', aud.some((a) => /password shown/.test(a.action)) && noSecret(JSON.stringify(aud)), aud.map((a) => a.action));
  const log = await call('GET', `${V}/access-log`, null, T.sa);
  check('"Who opened what" lists the reveal', log.status === 200 && log.body.rows.some((r) => r.action === 'show_password' && r.credentialId === id1 && r.userName === sa.name));
  await prisma.$executeRawUnsafe('UPDATE "CredentialVaultReauth" SET "expiresAt" = ? WHERE "userId" = ?', new Date(Date.now() - 1000).toISOString(), sa.id);
  check('after 5 minutes the ticket no longer works (401)', (await reveal(T.sa, id1, TK)).status === 401);

  // ---- Role Catalog grant (per role) ------------------------------------------------------------------------------------
  const rc = await call('PUT', '/admin/role-catalog/ACCOUNTANT/modules/administration/features', { enabled: true, features: { 'Credentials Vault': { view: true } } }, T.sa);
  check('Super Admin ticks Role Catalog > Administration > Credentials Vault > View for Accountant', rc.status === 200, rc.body);
  const la = await call('GET', `${V}/credentials`, null, T.acct);
  check('the Accountant now sees the list, masked', la.status === 200 && la.body.rows.length >= 2 && noSecret(la.text));
  const tkAcct = (await reauth(T.acct, PW.emp)).body.token;
  check('...but View alone does not Show a password (403)', (await reveal(T.acct, id1, tkAcct)).status === 403);
  check('...nor add, export or import (403)', (await call('POST', `${V}/credentials`, { platform: 'Zoho', username: `vz.z.${RUN}` }, T.acct)).status === 403
    && (await blobCall('POST', `${V}/export`, {}, T.acct)).status === 403 && (await call('GET', `${V}/import/template`, null, T.acct)).status === 403);
  await call('PUT', '/admin/role-catalog/ACCOUNTANT/modules/administration/features', { enabled: true, features: { 'Credentials Vault': { view: true, approve: true } } }, T.sa);
  const ra = await reveal(T.acct, id1, tkAcct);
  check('ticking Approve (= Show / Copy) lets the Accountant reveal', ra.status === 200 && ra.body.value === PW.plain(1), ra.body);
  const rcm = await call('PUT', '/admin/role-catalog/MANAGER/modules/administration/features', { enabled: true, features: { 'Credentials Vault': { view: true } } }, T.sa);
  const lm = await call('GET', `${V}/credentials`, null, T.mgr);
  const tkM = (await reauth(T.mgr, PW.emp)).body.token;
  check('Manager granted View: sees the list but still cannot reveal or change (view-only)', rcm.status === 200 && lm.status === 200 && (await reveal(T.mgr, id1, tkM)).status === 403 && (await call('PUT', `${V}/credentials/${id1}`, { label: 'x' }, T.mgr)).status === 403);
  await call('PUT', '/admin/role-catalog/MANAGER/modules/administration/features', { enabled: true, features: { 'Credentials Vault': { view: true, approve: true } } }, T.sa);
  check('a Manager stays view-only even with Approve ticked in Role Catalog (no reveal)', (await reveal(T.mgr, id1, tkM)).status === 403);
  await call('PUT', `${V}/grants/${mgr.id}`, { rights: { view: true, reveal: true } }, T.sa);
  check('...a per-person grant from the Super Admin is what lets that one Manager reveal', (await reveal(T.mgr, id1, tkM)).body.value === PW.plain(1));
  check('an Admin cannot grant per-person access (Super Admin only)', (await call('PUT', `${V}/grants/${empB.id}`, { rights: { view: true } }, T.admin)).status === 403);

  // ---- per-person grant -----------------------------------------------------------------------------------------------
  const g = await call('PUT', `${V}/grants/${empB.id}`, { rights: { view: true, reveal: true } }, T.sa);
  check('Super Admin gives one person (an employee) See + Show on the Access tab', g.status === 200 && g.body.rights.view && g.body.rights.reveal && !g.body.rights.manage);
  const lb = await call('GET', `${V}/credentials`, null, T.empB);
  check('that person sees the whole list', lb.status === 200 && lb.body.rows.length >= 2);
  check('...and cannot delete (no manage right)', (await call('DELETE', `${V}/credentials/${id2}`, null, T.empB)).status === 403);
  check('the grants list shows the person', (await call('GET', `${V}/grants`, null, T.sa)).body.grants.some((x) => x.userId === empB.id));

  // ---- the employee-own switch ---------------------------------------------------------------------------------------
  check('own switch OFF (default): the assigned employee cannot open the vault', !(await call('GET', `${V}/me`, null, T.empA)).body.open && (await call('GET', `${V}/credentials`, null, T.empA)).status === 403);
  await call('PUT', `${V}/credentials/${id1}`, { employeeCanSee: true }, T.sa);
  const meA = await call('GET', `${V}/me`, null, T.empA);
  const lA = await call('GET', `${V}/credentials`, null, T.empA);
  check('own switch ON: the employee sees ONLY the login assigned to them', meA.body.open && meA.body.ownOnly && lA.status === 200 && lA.body.rows.length === 1 && lA.body.rows[0].id === id1 && noSecret(lA.text), lA.body);
  const tkA = (await reauth(T.empA, PW.emp)).body.token;
  check('...and may reveal it after the password check', (await reveal(T.empA, id1, tkA)).body.value === PW.plain(1));
  check('...but not another login (403) nor its details (403)', (await reveal(T.empA, id2, tkA)).status === 403 && (await call('GET', `${V}/credentials/${id2}`, null, T.empA)).status === 403);
  check('...nor the access log or the import (403)', (await call('GET', `${V}/access-log`, null, T.empA)).status === 403 && (await call('GET', `${V}/import/template`, null, T.empA)).status === 403);

  // ---- other roles: 403 everywhere -----------------------------------------------------------------------------------
  const recCalls = [['GET', `${V}/credentials`], ['GET', `${V}/credentials/${id1}`], ['POST', `${V}/credentials`], ['PUT', `${V}/credentials/${id1}`], ['DELETE', `${V}/credentials/${id1}`],
    ['POST', `${V}/credentials/bulk`], ['POST', `${V}/reauth`], ['POST', `${V}/credentials/${id1}/reveal`], ['GET', `${V}/access-log`], ['GET', `${V}/grants`], ['GET', `${V}/import/template`], ['POST', `${V}/import/apply`], ['POST', `${V}/export`]];
  const recSt = [];
  for (const [m, u] of recCalls) recSt.push((await call(m, u, {}, T.rec)).status); // eslint-disable-line no-await-in-loop
  check('a Recruiter gets 403 from every vault endpoint', recSt.every((s) => s === 403), recSt);
  const admSt = [];
  for (const [m, u] of recCalls) admSt.push((await call(m, u, {}, T.admin)).status); // eslint-disable-line no-await-in-loop
  check('an Admin (not granted) gets 403 from every vault endpoint', admSt.every((s) => s === 403), admSt);

  // ---- lockout after 5 wrong ------------------------------------------------------------------------------------------
  const tkB = (await reauth(T.empB, PW.emp)).body.token;
  const wrong = [];
  for (let i = 0; i < 5; i += 1) wrong.push((await reauth(T.empB, `wrong-${i}`)).status); // eslint-disable-line no-await-in-loop
  check('5 wrong passwords: 401 x4 then 423 (locked)', JSON.stringify(wrong) === JSON.stringify([401, 401, 401, 401, 423]), wrong);
  check('while locked even the right password is refused (423)', (await reauth(T.empB, PW.emp)).status === 423);
  const lockedReveal = await reveal(T.empB, id1, tkB);
  check('...and an earlier ticket stops working (423 VAULT_LOCKED)', lockedReveal.status === 423 && lockedReveal.body.code === 'VAULT_LOCKED', lockedReveal.body);
  check('the lock is in the access log', (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CredentialAccess" WHERE "userId" = ? AND "action" = \'locked\'', empB.id))[0].n > 0);
  await prisma.$executeRawUnsafe('UPDATE "CredentialVaultLock" SET "lockedUntil" = ? WHERE "userId" = ?', new Date(Date.now() - 1000).toISOString(), empB.id);
  const unlock = await reauth(T.empB, PW.emp);
  check('after 15 minutes the right password works again', unlock.status === 200);

  // ---- import ---------------------------------------------------------------------------------------------------------
  const tpl = await blobCall('GET', `${V}/import/template`, null, T.sa);
  const tplRows = tpl.status === 200 ? readBook(tpl.buf) : [];
  check('the template has the 10 columns in order', JSON.stringify(tplRows[0]) === JSON.stringify(['Platform', 'Label', 'Login URL', 'Username / Email', 'Password', 'Employee (name / code / email)', 'Department', 'Notes', 'Renewal date', 'Extra secret']), tplRows[0]);
  const tplPrev = await fileCall(`${V}/import/preview`, T.sa, tpl.buf, 'template.xlsx');
  check('the template itself previews as 2 example rows skipped, nothing to import', tplPrev.status === 200 && tplPrev.body.counts.skipped === 2 && tplPrev.body.counts.ready === 0, tplPrev.body && tplPrev.body.counts);
  plaintexts.push(PW.plain(10), PW.plain(11), PW.plain(12), PW.plain(13), PW.plain(14), PW.plain(15), `Recovery-${RUN}-abc`);
  const empACode = `VZ-EMPA-${RUN}`.toUpperCase();
  const variantSheet = sheet([
    ['Portal', 'User ID', 'Pwd', 'Assigned To', 'Dept', 'Remarks', 'Expiry', 'PIN'],
    ['Shine', `vz.shine.${RUN}@example.test`, PW.plain(10), empACode, '', 'shared login', '31-12-2027', `Recovery-${RUN}-abc`],
    ['LinkedIn', `vz.li.${RUN}@example.test`, PW.plain(11), `Vz Twin ${RUN}`, 'IT', '', '', ''],
    ['Indeed', '', PW.plain(12), '', '', '', '', ''],
    ['Zoho', `vz.zoho.${RUN}@example.test`, PW.plain(13), 'Nobody Such Person', '', '', '', ''],
    ['Naukri', `vz.naukri.${RUN}@example.test`, PW.plain(14), '', '', '', '', ''],
    ['shine.com', `VZ.SHINE.${RUN}@example.test`, PW.plain(15), '', '', '', '', ''],
  ]);
  const before = filesUnder(UPLOADS).length;
  const pv = await fileCall(`${V}/import/preview`, T.sa, variantSheet, `old-logins-${RUN}.xlsx`);
  const m = pv.body && Object.fromEntries((pv.body.mapping || []).map((x) => [x.key, x.columnName]));
  check('header variants are matched by name (Portal, User ID, Pwd, Assigned To, Dept, Remarks, Expiry, PIN)', pv.status === 200 && m.platform === 'Portal' && m.username === 'User ID' && m.password === 'Pwd' && m.employee === 'Assigned To' && m.department === 'Dept' && m.notes === 'Remarks' && m.renewal === 'Expiry' && m.extra === 'PIN', m);
  const st = pv.body && Object.fromEntries(pv.body.rows.map((r) => [r.row, r]));
  check('preview: 1 Ready, 1 Needs a choice, 4 Refused', pv.body && pv.body.counts.ready === 1 && pv.body.counts.choice === 1 && pv.body.counts.refused === 4, pv.body && pv.body.counts);
  check('Ready: the employee by code, the department taken from the employee, the renewal date read', st && st[2].status === 'ready' && st[2].employees[0].id === empARow.id && st[2].department === 'Sales' && st[2].renewalDate === '2027-12-31', st && st[2]);
  check('Needs a choice: two employees with the same name, both offered', st && st[3].status === 'choice' && st[3].choices[0].options.length === 2);
  check('Refused: missing username / unknown employee / already in the vault / duplicate in the file', st && /Username/.test(st[4].reasons.join()) && /No employee/.test(st[5].reasons.join()) && /Already in the vault/.test(st[6].reasons.join()) && /Same platform and username as row 2/.test(st[7].reasons.join()), st && [st[4].reasons, st[5].reasons, st[6].reasons, st[7].reasons]);
  check('the preview shows every password MASKED and carries no secret', pv.body && pv.body.rows.every((r) => !r.hasPassword || r.password === '••••••••') && noSecret(pv.text));
  const bRow = await prisma.$queryRawUnsafe('SELECT "payload" FROM "CredentialImportBatch" WHERE "id" = ?', pv.body.batchId);
  check('the waiting preview keeps the secrets only encrypted', bRow[0].payload.includes('enc:v1:') && !plaintexts.some((p) => bRow[0].payload.includes(p)));
  check('the uploaded file is not stored anywhere under UPLOAD_DIR', filesUnder(UPLOADS).length === before && !filesUnder(UPLOADS).some((f) => { try { return fs.readFileSync(f).includes(Buffer.from(PW.plain(10))); } catch { return false; } }));
  const ck = await call('POST', `${V}/import/check`, { batchId: pv.body.batchId, choices: { [st[3].choices[0].key]: twin2.id } }, T.sa);
  check('choosing which "Vz Twin" makes the row Ready (2 ready)', ck.status === 200 && ck.body.counts.ready === 2 && noSecret(ck.text), ck.body && ck.body.counts);
  check('another person cannot apply this preview (Accountant has no import right: 403)', (await call('POST', `${V}/import/apply`, { batchId: pv.body.batchId }, T.acct)).status === 403);
  const ap = await call('POST', `${V}/import/apply`, { batchId: pv.body.batchId, choices: { [st[3].choices[0].key]: twin2.id } }, T.sa);
  check('Apply imports the 2 Ready rows', ap.status === 200 && ap.body.created === 2 && noSecret(ap.text), ap.body);
  const imp = await prisma.$queryRawUnsafe('SELECT * FROM "Credential" WHERE "importBatchId" = ?', pv.body.batchId);
  check('imported rows are encrypted, assigned and tagged with the batch', imp.length === 2 && imp.every((r) => r.passwordEnc.startsWith('enc:v1:')) && imp.some((r) => r.assignedEmployeeIds.includes(twin2.id)) && imp.some((r) => r.extraEnc && r.extraEnc.startsWith('enc:v1:')));
  const after = await prisma.$queryRawUnsafe('SELECT "payload","status" FROM "CredentialImportBatch" WHERE "id" = ?', pv.body.batchId);
  check('after Apply the batch keeps no payload at all', after[0].payload === null && after[0].status === 'applied');
  const shineId = imp.find((r) => r.platform === 'Shine').id;
  const tk2 = (await reauth(T.sa, PW.sa)).body.token;
  check('an imported password reveals to the exact value', (await reveal(T.sa, shineId, tk2)).body.value === PW.plain(10));
  check('applying the same preview twice is refused (409)', (await call('POST', `${V}/import/apply`, { batchId: pv.body.batchId }, T.sa)).status === 409);
  check('the import is in the access log', (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CredentialAccess" WHERE "action" = \'import\' AND "userId" = ?', sa.id))[0].n > 0);
  // a sheet whose username column has an unknown header: "Which column is which"
  const odd = sheet([['Site name', 'Handle', 'Secret word'], ['Gmail', `vz.gm.${RUN}@example.test`, PW.plain(3)]]);
  const pm = await fileCall(`${V}/import/preview`, T.sa, odd, 'odd.xlsx');
  check('an unknown header asks which column is which (needsMapping, Username / Email missing)', pm.status === 200 && pm.body.needsMapping && pm.body.missing.includes('Username / Email') && noSecret(pm.text), pm.body);
  const pm2 = await fileCall(`${V}/import/preview`, T.sa, odd, 'odd.xlsx', { mapping: JSON.stringify({ platform: 0, username: 1, password: 2 }) });
  check('...and with the columns chosen it previews 1 Ready', pm2.status === 200 && !pm2.body.needsMapping && pm2.body.counts.ready === 1 && noSecret(pm2.text), pm2.body && pm2.body.counts);
  // SMART IMPORT (founder 2026-11-23): a team's own workbook - one sheet per platform, two logins on one row, a sheet without a header row,
  // a phone-numbers sheet with no password, a person who is not an employee
  const book = (() => {
    const wb = XLSX.utils.book_new();
    const add = (aoa, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    add([['Account', 'Password', 'Mobile Number'], [`sm.nk.${RUN}@example.test`, PW.plain(21), '9000000001']], 'Naukri Logins');
    add([['Recruiter', 'Position', 'VC Dail Logins', 'Password', 'User Login', 'Password'], ['Nobody Fakename', 'Recruiter', `80${RUN.slice(-4)}1`, PW.plain(22), `edu${RUN}`, PW.plain(23)]], 'Vici Dial Credentials');
    add([['Recrutiers Names', 'Position', 'Present Mobile Numbers Using'], ['Nobody Fakename', 'Recruiter', '9000000002']], 'Mobile Numbers');
    add([[], ['Shine', 'Nobody Fakename', `smshine_${RUN}`, PW.plain(24), '9000000003']], "Shine Login's");
    // a one-word name before the e-mail must not be taken for the login (the e-mail is the login, the next cell the password)
    add([['Naukri Logins', 'Ravikiran', `nk2.${RUN}@example.test`, PW.plain(26), `nk2.${RUN}@example.test`]], 'Naukri Old');
    add([['Name', 'Position', 'Mail ID', 'Password', 'Recovery Mail'], ['Nobody Fakename', 'TL', `sm.gm.${RUN}@gmail.com`, PW.plain(25), 'rec@example.test']], 'GMail Credentials');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();
  const sp = await fileCall(`${V}/import/preview`, T.sa, book, 'team-workbook.xlsx');
  const sr = (sp.body && sp.body.rows) || [];
  const plat = (p) => sr.filter((r) => r.platform === p);
  check('smart import: every sheet is read, no column picking asked', sp.status === 200 && !sp.body.needsMapping && Array.isArray(sp.body.smartSheets) && sp.body.sheet === 'All sheets' && noSecret(sp.text), sp.body && (sp.body.smartSheets || sp.body.missing));
  check('smart import: the platform comes from the sheet name (Naukri, ViciDial, Shine, Gmail)', plat('Naukri').length === 2 && plat('ViciDial').length === 2 && plat('Shine').length === 1 && plat('Gmail').length === 1, sr.map((r) => r.platform));
  check('smart import: two logins on one row (VC Dail login + User login) become two logins', plat('ViciDial').some((r) => /VC Dail Logins/.test(r.label)) && plat('ViciDial').some((r) => /User Login/.test(r.label)));
  check('smart import: a sheet without a header row is read by what its cells look like', !!plat('Shine')[0] && plat('Shine')[0].username === `smshine_${RUN}` && plat('Shine')[0].hasPassword);
  check('smart import: a phone-numbers sheet with no password is skipped, not guessed', (sp.body.smartSheets || []).some((x) => x.name === 'Mobile Numbers' && x.skipped));
  check('smart import: a person who is not an employee is kept (Position as the label, the name in the notes), not refused', sr.length === 6 && sr.every((r) => r.status === 'ready') && !!plat('Gmail')[0] && plat('Gmail')[0].label === 'TL' && /Person: Nobody Fakename/.test(plat('Gmail')[0].notes), sr.map((r) => [r.where, r.status, r.label, r.reasons]));
  check('smart import: rows say which sheet and row they came from', sr.every((r) => /· row \d+$/.test(r.where || '')), sr.map((r) => r.where));
  const sa2 = await call('POST', `${V}/import/apply`, { batchId: sp.body.batchId }, T.sa);
  check('smart import: Import adds all 6 logins', sa2.status === 200 && sa2.body.created === 6, sa2.body);
  check('smart import: a one-word name is not the login - the e-mail is', plat('Naukri').some((r) => r.username === `nk2.${RUN}@example.test`) &&!plat('Naukri').some((r) => r.username === 'Ravikiran'));
  const vcRow = (await prisma.$queryRawUnsafe('SELECT "id" FROM "Credential" WHERE "importBatchId" = ? AND "label" LIKE ?', sp.body.batchId, '%User Login%'))[0];
  const tkS = (await reauth(T.sa, PW.sa)).body.token;
  check('smart import: the second password of the row reveals to its own exact value', !!vcRow && (await reveal(T.sa, vcRow.id, tkS)).body.value === PW.plain(23));
  await call('POST', `${V}/import/batches/${sp.body.batchId}/undo`, null, T.sa);
  // short names from a team sheet find the HRMS employee (founder 2026-11-23)
  const VX = require('../src/utils/credentialVault');
  const ixT = { all: [
    { id: 'e1', name: 'Sneha Bharghavi Bapanapalli', department: 'Education', employmentStatus: 'Active' },
    { id: 'e2', name: 'Uma S', department: 'Education', employmentStatus: 'Active' },
    { id: 'e3', name: 'Sailaja Bongu', department: 'BDE', employmentStatus: 'Active' },
    { id: 'e4', name: 'Renuka A', department: 'Education', employmentStatus: 'Active' },
    { id: 'e5', name: 'Gonda Renuka', department: 'BDE', employmentStatus: 'Active' },
    { id: 'e6', name: 'Old Sneha', department: 'Education', employmentStatus: 'Relieved' },
  ] };
  const one = (raw, dept) => VX.fuzzyEmployees(ixT, raw, dept).map((e) => e.id).join(',');
  check('short names find the HRMS employee: B.Sneha, S.Uma, sailaja.b', one('B.Sneha') === 'e1' && one('S.Uma') === 'e2' && one('sailaja.b') === 'e3', [one('B.Sneha'), one('S.Uma'), one('sailaja.b')]);
  check('two people with the name: the department decides, otherwise both stay (nobody is guessed)', one('Renuka', 'BDE') === 'e5' && one('Renuka') === 'e4,e5', [one('Renuka', 'BDE'), one('Renuka')]);
  // a team's sectioned sheet (founder 2026-11-23, "R&D Login Credentials"): Account Type per row, section rows with an emp code,
  // who uses it in a column without a header ("HR" = a team), a second login column when the e-mail is empty, the file name = department
  const sec = sheet([
    ['Account Type', 'Username / Email', 'Password', 'Username / Login', 'emp code'],
    ['Team X1', '', '', '', '9999', 'Ravi Kiranx'],
    ['Webmail', `sec.a.${RUN}@example.test`, PW.plain(31), '', '', 'Ravi Kiranx'],
    ['cPanel', '', PW.plain(32), `cpx${RUN}`, '', 'HR'],
    ['facebook', `phone ${RUN}1`, PW.plain(33), '', '', 'HR'],
    ['', `phone ${RUN}2`, PW.plain(34), '', '', 'HR'],
    ['website admin page', `sec.b.${RUN}@tmlink.in`, PW.plain(35), '', '', 'HR'],
  ], 'Sheet1');
  const sv = await fileCall(`${V}/import/preview`, T.sa, sec, 'R&D Login Credentials.xlsx');
  const sx = (sv.body && sv.body.rows) || [];
  check('sectioned sheet: read the smart way, the section row is not a login', sv.status === 200 && sv.body.sheet === 'All sheets' && sx.length === 5 && noSecret(sv.text), sx.map((r) => [r.where, r.platform, r.label]));
  check('sectioned sheet: the section names the label (Team X1), "HR" in the who column = Used by HR', sx[0] && sx[0].label === 'Team X1' && sx.slice(1).every((r) => r.label === 'Used by HR'), sx.map((r) => r.label));
  check('sectioned sheet: Account Type is the platform, an empty one repeats the row above, a named one is kept as written', sx[2] && sx[2].platform === 'Meta' && sx[3] && sx[3].platform === 'Meta' && sx[4] && sx[4].platform === 'website admin page', sx.map((r) => r.platform));
  check('sectioned sheet: an empty e-mail takes the Username / Login column (cPanel)', sx[1] && sx[1].platform === 'cPanel' && sx[1].username === `cpx${RUN}`, sx[1]);
  check('sectioned sheet: the file name gives the department (R&D) when nobody is matched', sx.every((r) => r.department === 'R&D'), sx.map((r) => r.department));
  // undo
  await prisma.$executeRawUnsafe('UPDATE "Credential" SET "updatedAt" = ? WHERE "id" = ?', new Date(Date.now() + 5000).toISOString(), shineId); // somebody changed it since
  const un = await call('POST', `${V}/import/batches/${pv.body.batchId}/undo`, null, T.sa);
  check('Undo removes the untouched imported row and keeps the one changed since', un.status === 200 && un.body.removed === 1 && un.body.kept === 1, un.body);
  check('the batches list shows it undone', (await call('GET', `${V}/import/batches`, null, T.sa)).body.batches.some((b) => b.id === pv.body.batchId && b.status === 'undone'));

  // ---- export ---------------------------------------------------------------------------------------------------------
  const ex = await blobCall('POST', `${V}/export`, { filters: {} }, T.sa);
  const exRows = ex.status === 200 ? readBook(ex.buf) : [];
  check('export (default): .xlsx, no Password column, no secret in the file', ex.status === 200 && /\.xlsx/.test(ex.headers.get('content-disposition') || '') && !exRows[0].includes('Password') && !plaintexts.some((p) => JSON.stringify(exRows).includes(p)) && exRows.length >= 3, exRows[0]);
  const exF = await blobCall('POST', `${V}/export`, { filters: { platform: ['Hostinger'] } }, T.sa);
  check('export follows the filters (Hostinger only)', readBook(exF.buf).slice(1).every((r) => r[0] === 'Hostinger') && readBook(exF.buf).length >= 2);
  const exN = await blobCall('POST', `${V}/export`, { withPasswords: true, confirmText: 'yes' }, T.sa);
  check('export WITH passwords without typing "I understand": 400', exN.status === 400);
  const exR = await blobCall('POST', `${V}/export`, { withPasswords: true, confirmText: 'I understand' }, T.sa);
  check('...with the words but no fresh password check: 401', exR.status === 401);
  const tk3 = (await reauth(T.sa, PW.sa)).body.token;
  const exP = await blobCall('POST', `${V}/export`, { withPasswords: true, confirmText: 'I understand' }, T.sa, { 'X-Vault-Reauth': tk3 });
  const exPRows = exP.status === 200 ? readBook(exP.buf) : [];
  check('...with both: the file has Password and Extra secret columns with the real values', exP.status === 200 && exPRows[0].includes('Password') && JSON.stringify(exPRows).includes(PW.plain(1)) && JSON.stringify(exPRows).includes(`PIN-${RUN}-4711`), exPRows[0]);
  const exLog = await prisma.$queryRawUnsafe('SELECT "action" FROM "CredentialAccess" WHERE "userId" = ? AND "action" IN (\'export\',\'export_with_passwords\')', sa.id);
  const exAud = await prisma.auditLog.findMany({ where: { userId: sa.id, action: { contains: 'exported' } } });
  check('both exports are recorded (access log + audit), the audit without a secret', exLog.some((r) => r.action === 'export') && exLog.some((r) => r.action === 'export_with_passwords') && exAud.some((a) => /WITH passwords/.test(a.action)) && noSecret(JSON.stringify(exAud)));
  check('the person with See + Show but no export right cannot export (403)', (await blobCall('POST', `${V}/export`, {}, T.empB)).status === 403);

  // ---- edit, bulk ------------------------------------------------------------------------------------------------------
  const before2 = await prisma.$queryRawUnsafe('SELECT "passwordEnc","lastRotatedAt" FROM "Credential" WHERE "id" = ?', id2);
  const e1 = await call('PUT', `${V}/credentials/${id2}`, { label: 'Main site', password: '' }, T.sa);
  const after2 = await prisma.$queryRawUnsafe('SELECT "passwordEnc" FROM "Credential" WHERE "id" = ?', id2);
  check('edit with the password box empty keeps the saved password', e1.status === 200 && after2[0].passwordEnc === before2[0].passwordEnc);
  const e2 = await call('PUT', `${V}/credentials/${id2}`, { password: PW.plain(2) + 'b' }, T.sa);
  plaintexts.push(`${PW.plain(2)}b`);
  check('a new password is encrypted and the "last changed" date moves', e2.status === 200 && e2.body.credential.lastRotatedAt && noSecret(e2.text));
  check('bulk disable', (await call('POST', `${V}/credentials/bulk`, { ids: [id2], action: 'disable' }, T.sa)).body.done === 1 && (await prisma.$queryRawUnsafe('SELECT "status" FROM "Credential" WHERE "id" = ?', id2))[0].status === 'disabled');
  check('bulk assign adds the employee', (await call('POST', `${V}/credentials/bulk`, { ids: [id2], action: 'assign', employeeIds: [twin1.id] }, T.sa)).body.done === 1 && (await prisma.$queryRawUnsafe('SELECT "assignedEmployeeIds" FROM "Credential" WHERE "id" = ?', id2))[0].assignedEmployeeIds.includes(twin1.id));
  check('bulk delete without the confirm is refused (400)', (await call('POST', `${V}/credentials/bulk`, { ids: [id2], action: 'delete' }, T.sa)).status === 400);
  check('bulk delete with the confirm removes it', (await call('POST', `${V}/credentials/bulk`, { ids: [id2], action: 'delete', confirm: true }, T.sa)).body.done === 1 && !(await prisma.$queryRawUnsafe('SELECT "id" FROM "Credential" WHERE "id" = ?', id2)).length);
  check('the deleted login\'s history stays in "Who opened what"', (await call('GET', `${V}/access-log`, { }, T.sa)).body.rows.some((r) => r.credentialId === id2 && r.action === 'delete'));

  // ---- rate limit -----------------------------------------------------------------------------------------------------
  const tkR = (await reauth(T.empB, PW.emp)).body.token;
  let hit = 0; let n = 0;
  for (let i = 0; i < 35 && !hit; i += 1) { n += 1; const r = await reveal(T.empB, id1, tkR); if (r.status === 429) hit = n; } // eslint-disable-line no-await-in-loop
  check('reveals are rate-limited (30 in ten minutes, then 429)', hit > 0 && hit <= 31, { hit, n });

  // ---- no secret in the server's own output -----------------------------------------------------------------------------
  await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(FULL)').catch(() => {});
  check('the database files still hold no plaintext secret after import / edit / export', !plaintexts.some((p) => dbBytes().includes(Buffer.from(p))));
  check('the server log never printed a secret', !plaintexts.some((p) => serverOut.includes(p)));
  const allAudit = await prisma.auditLog.findMany({ where: { OR: [{ entity: 'Credential' }, { action: { startsWith: 'Credentials vault' } }] } });
  check('no audit row carries a secret', allAudit.length > 5 && noSecret(JSON.stringify(allAudit)));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
