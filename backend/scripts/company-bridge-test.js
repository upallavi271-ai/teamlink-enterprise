#!/usr/bin/env node
// ---------------------------------------------------------------------------
// COMPANY SWITCHER TEST  (docs/second-company.md section 9)        node scripts/company-bridge-test.js  [--keep]
//
// On throw-away files only. Builds a TeamLink-style database (the repo's demo data) and a brand-new company, starts both servers with the
// switcher set up, and checks:
//   1. the setup script makes the key files, never prints the private key, and hands the company only the PUBLIC key;
//   2. only a real Super Admin sees the "Companies" menu and can ask for a pass; nobody else, nothing without sign-in;
//   3. the pass opens the company as its "TeamLink owner" (Super Admin of THAT company), which is empty and holds none of TeamLink's data;
//   4. a pass works once; an expired, long-lived, tampered, forged, wrong-company or garbage pass is refused (never a server error);
//   5. there is no way from the company into TeamLink: TeamLink answers "not found" to a pass, the company's token is worthless there;
//   6. the company's own admin cannot lock the owner out; TeamLink's database gets nothing but one audit line; no pass is ever written down.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const PRISMA = path.join(BACKEND, 'prisma');
const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'company-bridge-test-'));
const F = { base: 'zz-sc-bridge-base.db', tl: 'zz-sc-bridge-teamlink.db', nish: 'zz-sc-bridge-nish.db' };
const P = { tl: 4071, nish: 4072, bare: 4073 };
const children = [];
let failures = 0; let passes = 0;
const ok = (c, what, detail) => { if (c) { passes += 1; console.log(`  PASS  ${what}`); } else { failures += 1; console.log(`  FAIL  ${what}${detail ? `  -> ${detail}` : ''}`); } };
const heading = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbPath = (k) => path.join(PRISMA, F[k]);
const dbUrl = (k) => `file:./${F[k]}`;

function cleanup() {
  for (const c of children) { try { if (c.pid) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } try { c.kill(); } catch { /* gone */ } }
  if (KEEP) { console.log(`(kept: ${TMP})`); return; }
  for (const k of Object.keys(F)) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dbPath(k) + sfx); } catch { /* none */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* none */ }
}
function run(cmdArgs, env, label) {
  const r = spawnSync(process.execPath, cmdArgs, { cwd: BACKEND, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) { console.log(`  FAIL  ${label}\n${(r.stdout || '').slice(-1200)}\n${(r.stderr || '').slice(-1200)}`); failures += 1; throw new Error(`${label} failed`); }
  return r;
}

const KEYDIR = path.join(TMP, 'tl-bridge');
const PUBFILE = path.join(TMP, 'bridge-public.pem');
function serverEnv(which, extra = {}) {
  const dirs = path.join(TMP, `files-${which}`);
  const port = P[which];
  return {
    PORT: String(port), DATABASE_URL: dbUrl(which === 'bare' ? 'tl' : which), TEST_MODE: '1', TEAMLINK_SANDBOX: '1', NODE_ENV: 'development',
    JWT_SECRET: crypto.createHash('sha256').update(`secret-${which}`).digest('hex'),
    INTEGRATION_SECRET_KEY: crypto.createHash('sha256').update(`integ-${which}`).digest('hex'),
    APP_BASE_URL: `http://localhost:${port}`,
    UPLOAD_DIR: path.join(dirs, 'uploads'), ATS_IO_DIR: path.join(dirs, 'ats-io'), MESSAGE_JOB_DIR: path.join(dirs, 'message-jobs'), BACKUP_DIR: path.join(dirs, 'backups'),
    COMPANY_BRIDGE_ENTER_MAX: '500', MAIL_WORKER_INTERVAL_MS: '0', GREENSTART_ENABLED: 'false', GREENSTART_SUPERVISE: 'false', GREENSTART_AUTOSTART: 'false', JOB_PORTAL_EMBED: '0', JOB_PORTAL_SYNC_INTERVAL_MS: '0',
    ...extra,
  };
}
function start(which, extra) {
  const log = fs.openSync(path.join(TMP, `server-${which}.log`), 'a');
  const c = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND, env: { ...process.env, ...serverEnv(which, extra) }, stdio: ['ignore', log, log], windowsHide: true });
  children.push(c);
  return c;
}
async function waitHealth(port, ms = 90000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return r.json(); } catch { /* not yet */ }
    await sleep(500);
  }
  return null;
}
async function call(port, method, url, { token, body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const arr = (j) => (Array.isArray(j) ? j : (j && typeof j === 'object' ? (Object.values(j).find((v) => Array.isArray(v)) || []) : []));
const passOf = (url) => decodeURIComponent(String(url).split('#p=')[1] || '');
const b64u = (b) => Buffer.from(b).toString('base64url');

async function main() {
  console.log(`temp folder: ${TMP}`);
  const PRISMA_CLI = path.join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js');

  heading('A. databases, key files, servers');
  for (const k of Object.keys(F)) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dbPath(k) + sfx); } catch { /* none */ } }
  run([PRISMA_CLI, 'migrate', 'deploy'], { DATABASE_URL: dbUrl('base') }, 'migrate the base database');
  fs.copyFileSync(dbPath('base'), dbPath('tl'));
  fs.copyFileSync(dbPath('base'), dbPath('nish'));
  run(['prisma/seed.js'], { DATABASE_URL: dbUrl('tl'), TEST_MODE: '1' }, 'seed the TeamLink-style demo data');
  run(['scripts/company-init.js', '--key', 'nish', '--name', 'NISHTECHNOLOGIES INDIA PVT LTD', '--admin-name', 'Test Super Admin', '--admin-email', 'nish-admin@example.test',
    '--skip-migrate', '--strict', '--link-file', path.join(TMP, 'link.txt'), '--app-url', `http://localhost:${P.nish}`], { DATABASE_URL: dbUrl('nish') }, 'create the new company');

  const setup = spawnSync(process.execPath, ['scripts/company-bridge-setup.js', '--dir', KEYDIR, '--key', 'nish', '--name', 'NISHTECHNOLOGIES INDIA PVT LTD', '--url', `http://localhost:${P.nish}`, '--public-out', PUBFILE], { cwd: BACKEND, encoding: 'utf8' });
  ok(setup.status === 0, 'the setup script runs', setup.stderr);
  ok(!/PRIVATE KEY/.test(setup.stdout + setup.stderr), 'the setup script never prints the private key');
  const pem = fs.readFileSync(path.join(KEYDIR, 'private.pem'), 'utf8');
  ok(/BEGIN PRIVATE KEY/.test(pem), 'TeamLink\'s signing key is in its own folder');
  const pub = fs.readFileSync(PUBFILE, 'utf8');
  ok(/BEGIN PUBLIC KEY/.test(pub) && !/PRIVATE/.test(pub), 'the company is given the PUBLIC key only');
  ok(JSON.parse(fs.readFileSync(path.join(KEYDIR, 'companies.json'), 'utf8'))[0].key === 'nish', 'the company is in the menu list');
  const again = spawnSync(process.execPath, ['scripts/company-bridge-setup.js', '--dir', KEYDIR, '--key', 'nish', '--name', 'NISH', '--url', `http://localhost:${P.nish}`, '--public-out', PUBFILE], { cwd: BACKEND, encoding: 'utf8' });
  ok(again.status === 0 && fs.readFileSync(path.join(KEYDIR, 'private.pem'), 'utf8') === pem && fs.readFileSync(PUBFILE, 'utf8') === pub, 'running the setup again keeps the same key (nothing breaks)');

  start('tl', { COMPANY_BRIDGE_DIR: KEYDIR });
  start('nish', { COMPANY_KEY: 'nish', COMPANY_BRIDGE_PUBLIC_KEY_FILE: PUBFILE, COMPANY_BRIDGE_HOME_URL: `http://localhost:${P.tl}` });
  start('bare', { COMPANY_BRIDGE_DIR: path.join(TMP, 'nothing-here') });
  const [hT, hN, hB] = await Promise.all([waitHealth(P.tl), waitHealth(P.nish), waitHealth(P.bare)]);
  ok(hT && hN && hB, 'TeamLink-style (switcher set up), the company, and a TeamLink-style server with nothing set up are all up', JSON.stringify([hT, hN, hB]));

  // the TeamLink-side people
  const login = async (port, email, password) => { const r = await call(port, 'POST', '/api/auth/login', { body: { email, password } }); return r.status === 200 && r.json ? r.json.token : null; };
  const superTok = await login(P.tl, 'admin@teamlink.test', 'password123');
  ok(!!superTok, 'TeamLink\'s Super Admin signs in');
  let staffTok = null; let staffWho = '';
  for (const em of ['hr@teamlink.com', 'kiran@teamlink.test', 'recruiter@teamlink.test', 'manager@teamlink.test', 'employee@teamlink.test', 'accountant@teamlink.test']) {
    // eslint-disable-next-line no-await-in-loop
    const t = await login(P.tl, em, 'password123');
    if (t) { // eslint-disable-next-line no-await-in-loop
      const me = await call(P.tl, 'GET', '/api/auth/me', { token: t });
      if (me.json && me.json.role !== 'SUPER_ADMIN') { staffTok = t; staffWho = `${em} (${me.json.role})`; break; }
    }
  }
  ok(!!staffTok, `a TeamLink login that is not a Super Admin was found (${staffWho})`);
  const tlUsersBefore = (() => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbPath('tl'), { readOnly: true }); const n = d.prepare('select count(*) c from "User"').get().c; d.close(); return n; })();

  heading('B. who sees the Companies menu, who can open a company');
  ok((await call(P.tl, 'GET', '/api/company-bridge/companies')).status === 401, 'the list needs a sign-in');
  ok((await call(P.tl, 'POST', '/api/company-bridge/open/nish')).status === 401, 'asking for a pass needs a sign-in');
  const lstStaff = await call(P.tl, 'GET', '/api/company-bridge/companies', { token: staffTok });
  ok(lstStaff.status === 200 && lstStaff.json.companies.length === 0, 'a login that is not a Super Admin sees an empty list', lstStaff.text.slice(0, 120));
  const opStaff = await call(P.tl, 'POST', '/api/company-bridge/open/nish', { token: staffTok });
  ok(opStaff.status === 403, 'a login that is not a Super Admin cannot ask for a pass', `${opStaff.status}`);
  const lst = await call(P.tl, 'GET', '/api/company-bridge/companies', { token: superTok });
  ok(lst.status === 200 && lst.json.companies.length === 1 && lst.json.companies[0].key === 'nish' && !/localhost|http/.test(lst.text), 'the Super Admin sees the company in the list (name only, no address, no secret)', lst.text.slice(0, 160));
  const none = await call(P.tl, 'POST', '/api/company-bridge/open/nope', { token: superTok });
  ok(none.status === 404, 'a company that is not set up cannot be opened', `${none.status}`);
  const bareTok = await login(P.bare, 'admin@teamlink.test', 'password123');
  const bareList = await call(P.bare, 'GET', '/api/company-bridge/companies', { token: bareTok });
  ok(bareList.status === 200 && bareList.json.companies.length === 0, 'a TeamLink server with nothing set up shows no menu at all');
  ok((await call(P.bare, 'POST', '/api/company-bridge/open/nish', { token: bareTok })).status === 404, 'and cannot make a pass');

  heading('C. the pass opens the company, empty, as its TeamLink owner');
  const op = await call(P.tl, 'POST', '/api/company-bridge/open/nish', { token: superTok });
  ok(op.status === 200 && op.json.url && op.json.url.startsWith(`http://localhost:${P.nish}/bridge#p=`), 'the Super Admin gets the company address with a pass after the # sign', op.text.slice(0, 160));
  const pass = passOf(op.json.url);
  const ent = await call(P.nish, 'POST', '/api/company-bridge/enter', { body: { pass } });
  ok(ent.status === 200 && ent.json.token, 'the company signs them in', `${ent.status} ${ent.text.slice(0, 160)}`);
  const ownerTok = ent.json && ent.json.token;
  ok(ent.json && ent.json.homeUrl === `http://localhost:${P.tl}`, 'and tells the screens where "Back to TeamLink" goes');
  const me = await call(P.nish, 'GET', '/api/auth/me', { token: ownerTok });
  ok(me.status === 200 && me.json.role === 'SUPER_ADMIN' && /\(TeamLink owner\)$/.test(me.json.name) && /@bridge\.invalid$/.test(me.json.email), 'they are the company\'s Super Admin, named as the TeamLink owner', `${me.json && me.json.role} ${me.json && me.json.name}`);
  const meT = await call(P.tl, 'GET', '/api/auth/me', { token: superTok });
  ok(JSON.stringify(me.json.access) === JSON.stringify(meT.json.access) && Object.keys(me.json.access).length > 20, 'with every menu and module, the same as TeamLink\'s Super Admin');
  ok(me.json.passwordStatus && me.json.passwordStatus.mustChange === false, 'no "change your password" gate (there is no password)');
  const st = await call(P.nish, 'GET', '/api/company-bridge/status', { token: ownerTok });
  ok(st.json && st.json.viaBridge === true && st.json.homeUrl === `http://localhost:${P.tl}`, 'the company knows this visit came from TeamLink');
  const stT = await call(P.tl, 'GET', '/api/company-bridge/status', { token: superTok });
  ok(stT.json && stT.json.viaBridge === false && stT.json.homeUrl === null, 'TeamLink itself never shows "Back to TeamLink"');
  let leaked = 0; const mine = [];
  for (const u of ['/api/clients', '/api/candidates', '/api/requirements', '/api/applications', '/api/invoices', '/api/announcements', '/api/assets']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call(P.nish, 'GET', u, { token: ownerTok });
    const len = r.json ? arr(r.json).length : -1;
    mine.push(`${u}=${r.status}/${len}`);
    if (r.status === 200 && len > 0) leaked += 1;
  }
  ok(leaked === 0, 'the company\'s clients, candidates, requirements, applications, invoices, announcements and assets are all empty for the owner', mine.join(' '));
  const empT = await call(P.tl, 'GET', '/api/employees', { token: superTok });
  const empN = await call(P.nish, 'GET', '/api/employees', { token: ownerTok });
  const names = arr(empT.json).map((e) => e && e.name).filter((n) => n && n.length > 6);
  ok(names.length > 5 && !names.some((n) => empN.text.includes(n)), `none of TeamLink's ${names.length} employee names appear in the company's employee list`);
  const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
  const nd = new DatabaseSync(dbPath('nish'), { readOnly: true });
  ok(nd.prepare('select count(*) c from "Employee"').get().c === 1, 'the company\'s headcount is still just its own admin (the owner has no employee record)');
  ok(nd.prepare('select count(*) c from "User"').get().c === 2, 'exactly one extra login exists in the company: the owner');
  nd.close();

  heading('D. a pass works once; bad passes are refused (never a server error)');
  const replay = await call(P.nish, 'POST', '/api/company-bridge/enter', { body: { pass } });
  ok(replay.status === 401, 'the same pass cannot be used twice', `${replay.status}`);
  process.env.COMPANY_BRIDGE_DIR = KEYDIR;
  const CB = require('../src/utils/companyBridge'); // eslint-disable-line global-require
  const company = { key: 'nish' }; const who = { id: 'u-1', email: 'a@b.test', name: 'X' };
  const refused = async (text, label) => { const r = await call(P.nish, 'POST', '/api/company-bridge/enter', { body: { pass: text } }); ok(r.status === 401 && !/token/.test(r.text), label, `${r.status} ${r.text.slice(0, 100)}`); };
  await refused(CB.signPass(company, who, Date.now() - 10 * 60000), 'a pass older than 2 minutes is refused');
  await refused(CB.signPass(company, who, Date.now() + 10 * 60000), 'a pass from the future is refused');
  const priv = crypto.createPrivateKey(pem);
  const craft = (over) => { const iat = Math.floor(Date.now() / 1000); const body = b64u(JSON.stringify({ v: 1, iss: 'teamlink', aud: 'nish', sub: 'u-2', email: 'c@d.test', name: 'Y', iat, exp: iat + 60, jti: crypto.randomBytes(8).toString('hex'), ...over })); return `${body}.${b64u(crypto.sign(null, Buffer.from(body), priv))}`; };
  ok((await call(P.nish, 'POST', '/api/company-bridge/enter', { body: { pass: craft({}) } })).status === 200, 'control: a correctly built pass is accepted (so the refusals below are about the fault, not the shape)');
  await refused(craft({ exp: Math.floor(Date.now() / 1000) + 3600 }), 'a pass that claims to live an hour is refused');
  await refused(craft({ aud: 'someone-else' }), 'a pass made for another company is refused');
  await refused(craft({ iss: 'nish' }), 'a pass from another issuer is refused');
  await refused(craft({ v: 2 }), 'a pass of another version is refused');
  const good = CB.signPass(company, who);
  const [pl, sg] = good.split('.');
  const edited = JSON.parse(Buffer.from(pl, 'base64url').toString('utf8')); edited.name = 'Somebody Else';
  await refused(`${b64u(JSON.stringify(edited))}.${sg}`, 'a pass whose text was changed is refused');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  { const iat = Math.floor(Date.now() / 1000); const body = b64u(JSON.stringify({ v: 1, iss: 'teamlink', aud: 'nish', sub: 'u-3', iat, exp: iat + 60, jti: 'x1' })); await refused(`${body}.${b64u(crypto.sign(null, Buffer.from(body), other))}`, 'a pass signed with some other key is refused'); }
  await refused(`${pl}.${b64u(crypto.randomBytes(64))}`, 'a pass with a made-up signature is refused');
  await refused('', 'an empty pass is refused');
  await refused('not.a.pass.at.all', 'a garbage pass is refused');
  await refused('x'.repeat(5000), 'a huge pass is refused');
  const nobody = await call(P.nish, 'POST', '/api/company-bridge/enter', {});
  ok(nobody.status === 401, 'no pass at all is refused', `${nobody.status}`);

  heading('E. there is no way from the company into TeamLink');
  const intoTl = await call(P.tl, 'POST', '/api/company-bridge/enter', { body: { pass: CB.signPass({ key: 'nish' }, who) } });
  ok(intoTl.status === 404, 'TeamLink answers "not found" to a pass: it has no door that takes one', `${intoTl.status}`);
  const x = await call(P.tl, 'GET', '/api/employees', { token: ownerTok });
  ok(x.status === 401, 'the owner\'s company token is worthless on TeamLink\'s server', `${x.status}`);
  const y = await call(P.nish, 'GET', '/api/employees', { token: superTok });
  ok(y.status === 401, 'and TeamLink\'s token is worthless on the company\'s server', `${y.status}`);
  const asOwner = await call(P.tl, 'POST', '/api/company-bridge/open/nish', { token: ownerTok });
  ok(asOwner.status === 401, 'the owner cannot ask TeamLink for a pass');

  heading('F. the company\'s own admin cannot lock the owner out');
  const wr = new DatabaseSync(dbPath('nish'));
  wr.exec("PRAGMA busy_timeout=5000; update \"User\" set status='Disabled', role='EMPLOYEE', hrmsRole='EMPLOYEE', atsRole='NONE', accountsRole='NONE' where email like 'teamlink-owner+%'");
  wr.close();
  const op2 = await call(P.tl, 'POST', '/api/company-bridge/open/nish', { token: superTok });
  const ent2 = await call(P.nish, 'POST', '/api/company-bridge/enter', { body: { pass: passOf(op2.json.url) } });
  const me2 = ent2.json && ent2.json.token ? await call(P.nish, 'GET', '/api/auth/me', { token: ent2.json.token }) : null;
  ok(ent2.status === 200 && me2 && me2.json.role === 'SUPER_ADMIN' && me2.json.status === 'Active', 'a disabled, demoted owner login is made a working Super Admin again at the next visit', `${ent2.status} ${me2 && me2.json && me2.json.role}`);
  const sameOwner = new DatabaseSync(dbPath('nish'), { readOnly: true });
  ok(sameOwner.prepare('select count(*) c from "User" where email = ?').get(CB.ownerEmail(meT.json.id)).c === 1, 'it is the same single owner login for this Super Admin, not a new one each visit');
  sameOwner.close();

  heading('G. what was written down');
  const td = new DatabaseSync(dbPath('tl'), { readOnly: true });
  ok(td.prepare('select count(*) c from "User"').get().c === tlUsersBefore, 'TeamLink\'s database has no new login');
  ok(td.prepare("select count(*) c from \"User\" where email like '%bridge.invalid'").get().c === 0, 'and no owner login (that exists only inside the company)');
  const opened = td.prepare("select count(*) c from \"AuditLog\" where action like 'Opened company%'").get().c;
  ok(opened >= 2, `TeamLink wrote an audit line each time a company was opened (${opened})`);
  const anyPass = (db, probe) => { const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((r) => r.name); let n = 0; for (const t of tables) { const cols = db.prepare(`pragma table_info("${t}")`).all().map((c) => c.name); for (const c of cols) { try { n += db.prepare(`select count(*) c from "${t}" where typeof("${c}")='text' and "${c}" like ?`).get(`%${probe}%`).c; } catch { /* skip */ } } } return n; };
  const probe = pass.slice(0, 40);
  ok(anyPass(td, probe) === 0, 'no pass text is stored anywhere in TeamLink\'s database');
  td.close();
  const nd2 = new DatabaseSync(dbPath('nish'), { readOnly: true });
  ok(anyPass(nd2, probe) === 0, 'and none in the company\'s database');
  ok(nd2.prepare("select count(*) c from \"AuditLog\" where action like 'Signed in from TeamLink%'").get().c >= 1, 'the company recorded each visit ("Signed in from TeamLink")');
  ok(nd2.prepare("select count(*) c from \"AuditLog\" where action like 'Company switcher: pass refused'").get().c >= 5, 'and each refused pass');
  nd2.close();
  const logs = ['tl', 'nish', 'bare'].map((k) => fs.readFileSync(path.join(TMP, `server-${k}.log`), 'utf8')).join('\n');
  ok(!logs.includes(probe), 'no pass appears in any server log');
  ok(!/UnhandledPromiseRejection|TypeError|ReferenceError/.test(logs), 'no server error was logged by any bad pass', (logs.match(/(UnhandledPromiseRejection|TypeError|ReferenceError)[^\n]*/) || [''])[0]);
}

(async () => {
  let crashed = null;
  try { await main(); } catch (e) { crashed = e; failures += 1; console.log(`\nTEST STOPPED: ${e && e.stack ? e.stack : e}`); }
  cleanup();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed${crashed ? ' (stopped early)' : ''}`);
  process.exit(failures === 0 ? 0 : 1);
})();
