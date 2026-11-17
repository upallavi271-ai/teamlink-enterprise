#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SECOND-COMPANY ISOLATION TEST  (docs/second-company.md)       node scripts/second-company-test.js  [--keep]
//
// Proves, on throw-away files only (never dev.db, never the real server), that a separate company's Super Admin gets EVERYTHING the
// application has and sees NOTHING of TeamLink:
//
//   A. builds two databases from the same migrations: "TeamLink" (the demo data the repo's seed makes: clients, candidates,
//      employees, attendance, invoices ...) and a brand-new company made by scripts/company-init.js;
//   B. looks INSIDE the new company's database: only the generic defaults + its one Super Admin; none of TeamLink's names or emails;
//   C. starts both servers and calls every screen's data request (every GET route without an id) as each Super Admin;
//      TeamLink's answers are the control (they must contain the demo names, so the check can see them); the new company's must not;
//   D. compares the permission matrix both Super Admins are given (this is what draws the menus): it must be identical;
//   E. the one-time password link works once, a weak password is refused, and each login only opens its own company;
//   F. the wrong-database guard: a company server pointed at TeamLink's database stops, and TeamLink's own server is unchanged;
//   G. the settings check (company-check.js) fails on shared settings and passes on separate ones.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'second-company-test-'));
const F = { base: 'zz-sc-base.db', tl: 'zz-sc-teamlink.db', nish: 'zz-sc-nish.db' };
const P = { tl: 4061, nish: 4062, guard: 4063, plain: 4064 };
const children = [];
let failures = 0;
let passes = 0;

const ok = (cond, what, detail) => {
  if (cond) { passes += 1; console.log(`  PASS  ${what}`); } else { failures += 1; console.log(`  FAIL  ${what}${detail ? `  -> ${detail}` : ''}`); }
};
const heading = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbPath = (k) => path.join(PRISMA, F[k]);
const dbUrl = (k) => `file:./${F[k]}`;

function cleanup() {
  for (const c of children) { try { if (c.pid) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } try { c.kill(); } catch { /* gone */ } }
  if (KEEP) { console.log(`(kept: ${TMP} and prisma/${Object.values(F).join(', prisma/')})`); return; }
  for (const k of Object.keys(F)) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dbPath(k) + sfx); } catch { /* none */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* none */ }
}

function run(cmdArgs, env, label) {
  const r = spawnSync(process.execPath, cmdArgs, { cwd: BACKEND, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) { console.log(`  FAIL  ${label}\n${(r.stdout || '').slice(-1200)}\n${(r.stderr || '').slice(-1200)}`); failures += 1; throw new Error(`${label} failed`); }
  return r;
}

// ---- the route list: a tiny preload that records every GET route the app has, once it has started listening --------------------------
const PRELOAD = path.join(TMP, 'routes-preload.cjs');
fs.writeFileSync(PRELOAD, `
const app = require(${JSON.stringify(path.join(BACKEND, 'node_modules', 'express', 'lib', 'application'))});
const fs = require('fs');
const listen = app.listen;
const SEG = '(?:[^\\\\\\\\/?()$|]|\\\\\\\\[.\\\\-_])+';
const MOUNT = new RegExp('^\\\\^((?:\\\\\\\\\\\\/' + SEG + ')*)\\\\\\\\\\\\/\\\\?\\\\(\\\\?=\\\\\\\\\\\\/\\\\|\\\\$\\\\)$');
function prefix(layer) {
  if (layer.keys && layer.keys.length) return null;
  if (layer.regexp && layer.regexp.fast_slash) return '';
  const m = MOUNT.exec(layer.regexp.source);
  return m ? m[1].replace(/\\\\\\//g, '/').replace(/\\\\([.\\-_])/g, '$1') : null;
}
function walk(stack, pre, out) {
  for (const l of stack) {
    if (l.route) {
      const p = l.route.path;
      if (typeof p === 'string' && l.route.methods.get) out.add((pre + (p === '/' ? '' : p)) || '/');
    } else if (l.name === 'router' && l.handle && l.handle.stack) {
      const x = prefix(l);
      if (x !== null) walk(l.handle.stack, pre + x, out);
    }
  }
}
app.listen = function () {
  try {
    const out = new Set();
    walk(this._router.stack, '', out);
    fs.writeFileSync(process.env.ROUTES_FILE, JSON.stringify([...out].sort()));
  } catch (e) { fs.writeFileSync(process.env.ROUTES_FILE + '.err', String(e && e.stack)); }
  return listen.apply(this, arguments);
};
`);

function serverEnv(which, extra = {}) {
  const dirs = path.join(TMP, `files-${which}`);
  return {
    PORT: String(P[which] || extra.PORT), DATABASE_URL: dbUrl(extra.db || which), TEST_MODE: '1', TEAMLINK_SANDBOX: '1', NODE_ENV: 'development',
    JWT_SECRET: crypto.createHash('sha256').update(`secret-${which}`).digest('hex'),
    INTEGRATION_SECRET_KEY: crypto.createHash('sha256').update(`integ-${which}`).digest('hex'),
    APP_BASE_URL: `http://localhost:${P[which] || extra.PORT}`,
    UPLOAD_DIR: path.join(dirs, 'uploads'), ATS_IO_DIR: path.join(dirs, 'ats-io'), MESSAGE_JOB_DIR: path.join(dirs, 'message-jobs'), BACKUP_DIR: path.join(dirs, 'backups'),
    ROUTES_FILE: path.join(TMP, `routes-${which}.json`),
    NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD).slice(1, -1)}`,
    MAIL_WORKER_INTERVAL_MS: '0', GREENSTART_ENABLED: 'false', GREENSTART_SUPERVISE: 'false', GREENSTART_AUTOSTART: 'false', JOB_PORTAL_EMBED: '0', JOB_PORTAL_SYNC_INTERVAL_MS: '0',
    ...extra.env,
  };
}

function start(which, extra = {}) {
  const log = fs.openSync(path.join(TMP, `server-${which}.log`), 'a');
  const c = spawn(process.execPath, ['src/index.js'], { cwd: BACKEND, env: { ...process.env, ...serverEnv(which, extra) }, stdio: ['ignore', log, log], windowsHide: true });
  c.exitInfo = null;
  c.on('exit', (code) => { c.exitInfo = { code }; });
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
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// ---- text found inside a database (for the "look inside" check) ------------------------------------------------------------------------------
function textValues(file, tables, colMap) {
  const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
  const db = new DatabaseSync(file, { readOnly: true });
  const out = new Map(); // value -> where
  const names = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '_prisma_migrations'").all().map((r) => r.name);
  for (const t of names) {
    if (tables && !tables.includes(t)) continue;
    const cols = db.prepare(`pragma table_info("${t}")`).all().filter((c) => /char|text|clob|string/i.test(c.type) || c.type === '').map((c) => c.name).filter((c) => !colMap || !colMap[t] || colMap[t].includes(c));
    for (const c of cols) {
      let rows = [];
      try { rows = db.prepare(`select distinct "${c}" as v from "${t}" where typeof("${c}")='text' limit 3000`).all(); } catch { rows = []; }
      for (const r of rows) { const v = String(r.v || '').trim(); if (v && !out.has(v)) out.set(v, `${t}.${c}`); }
    }
  }
  db.close();
  return out;
}

const specific = (v) => v.length >= 8 && v.length <= 80 && /[A-Za-z]/.test(v) && (/\s/.test(v) || /@/.test(v)) && !/^[\d\s.,:/-]+$/.test(v) && !/^\{|^\[|^https?:/.test(v);

async function main() {
  console.log(`temp folder: ${TMP}`);
  const PRISMA_CLI = path.join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js');

  heading('A. two databases from the same migrations');
  for (const k of Object.keys(F)) for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dbPath(k) + sfx); } catch { /* none */ } }
  run([PRISMA_CLI, 'migrate', 'deploy'], { DATABASE_URL: dbUrl('base') }, 'migrate the base database');
  fs.copyFileSync(dbPath('base'), dbPath('tl'));
  fs.copyFileSync(dbPath('base'), dbPath('nish'));
  run(['prisma/seed.js'], { DATABASE_URL: dbUrl('tl'), TEST_MODE: '1' }, 'seed the TeamLink-style demo data');
  const linkFile = path.join(TMP, 'nish-first-login.txt');
  const init = run(['scripts/company-init.js', '--key', 'nish', '--name', 'NISHTECHNOLOGIES INDIA PVT LTD', '--admin-name', 'Test Super Admin', '--admin-email', 'nish-admin@example.test',
    '--skip-migrate', '--strict', '--link-file', linkFile, '--app-url', `http://localhost:${P.nish}`], { DATABASE_URL: dbUrl('nish') }, 'create the new company');
  ok(/created in/.test(init.stdout), 'company-init created the new company', init.stdout.slice(-300));
  ok(!/https?:\/\/\S+new-password\?token=/.test(init.stdout + init.stderr), 'company-init never prints the password link or any password');
  ok(fs.existsSync(linkFile) && /new-password\?token=[a-f0-9]{64}/.test(fs.readFileSync(linkFile, 'utf8')), 'the one-time link is in its private file');

  // company-init must refuse to touch an existing company or TeamLink's own file names
  const again = spawnSync(process.execPath, ['scripts/company-init.js', '--key', 'nish', '--name', 'X', '--admin-name', 'Y', '--admin-email', 'y@example.test', '--skip-migrate'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: dbUrl('nish') }, encoding: 'utf8' });
  ok(again.status === 2 && /already has/.test(again.stderr), 'company-init refuses to run on a database that already has logins', again.stderr.slice(0, 160));
  const dev = spawnSync(process.execPath, ['scripts/company-init.js', '--key', 'nish', '--name', 'X', '--admin-name', 'Y', '--admin-email', 'y@example.test'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: 'file:./dev.db' }, encoding: 'utf8' });
  ok(dev.status === 2 && /dev\.db/.test(dev.stderr), 'company-init refuses a database called dev.db (TeamLink\'s live file name)');

  heading('B. inside the new company\'s database');
  const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
  const nishDb = new DatabaseSync(dbPath('nish'), { readOnly: true });
  const cnt = (t) => nishDb.prepare(`select count(*) c from "${t}"`).get().c;
  ok(cnt('User') === 1 && cnt('Employee') === 1 && cnt('Company') === 1, 'exactly one login, one employee, one company row');
  for (const t of ['Client', 'Candidate', 'Application', 'Requirement', 'Invoice', 'Attendance', 'LeaveRequest', 'PayrollRun', 'Payslip', 'InterviewEvent', 'OfficeExpense', 'BankTransaction', 'Department', 'Team', 'Announcement', 'Asset', 'JoiningCategoryTarget', 'AuditLog']) {
    ok(cnt(t) === 0, `${t} is empty`, `${cnt(t)} row(s)`);
  }
  const su = nishDb.prepare('select role, hrmsAccess, atsAccess, accountsAccess from "User"').get();
  ok(su.role === 'SUPER_ADMIN' && su.hrmsAccess === 1 && su.atsAccess === 1 && su.accountsAccess === 1, 'the one login is a Super Admin with HRMS, ATS and Accounts');
  { const roles = nishDb.prepare('select designation from "DesignationRole" order by position').all().map((r) => r.designation);
    ok(['Super Admin', 'HR', 'Manager', 'Assistant Manager', 'STL', 'TL', 'Employee', 'Accountant'].every((x) => roles.includes(x)) && roles.length === 8, 'the 8 standard roles of the program are there, so Add employee offers more than HR', roles.join(', ')); }
  nishDb.close();
  // every specific text (names, emails, titles) that TeamLink's data has, looked for in the new company's database
  const dataTables = ['User', 'Client', 'Candidate', 'Employee', 'Requirement', 'Department', 'Team', 'Project', 'Course', 'Announcement', 'Survey', 'PolicyDocument', 'Asset', 'OfficeExpense', 'Invoice', 'BankTransaction', 'Holiday', 'LeaveType', 'ShiftPattern', 'SalaryStructure', 'HrConfig', 'EmployeeRecord', 'InterviewEvent'];
  // The names to look for: only columns that identify a person, a customer or a piece of work (a policy called "Leave Policy" or the
  // words "Assistant Manager" are also written in the program itself, so they prove nothing either way).
  const MARKER_COLS = { User: ['name', 'email'], Employee: ['name', 'email', 'personalEmail'], Candidate: ['name', 'email', 'currentCompany'],
    Client: ['name', 'legalName', 'contactName', 'contactEmail', 'billingContactEmail', 'recruitmentContactEmail', 'accountManager', 'bdeOwner'],
    Requirement: ['title'], Project: ['name'], Course: ['title'], Survey: ['title'], Asset: ['name'], OfficeExpense: ['vendor'], Invoice: ['invoiceNumber'] };
  const tlText = textValues(dbPath('tl'), dataTables);
  const tlMarkText = textValues(dbPath('tl'), Object.keys(MARKER_COLS), MARKER_COLS);
  const nishText = textValues(dbPath('nish'));
  // what every company gets from the migrations alone (chart of accounts, expense categories, ...) is not "TeamLink's data"
  const baseText = textValues(dbPath('base'));
  // a name that is also written in the program's own text (an example sentence, a default title) proves nothing either way
  const sourceText = (() => {
    const parts = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.js$/.test(e.name)) parts.push(fs.readFileSync(p, 'utf8')); } };
    walk(path.join(BACKEND, 'src'));
    return parts.join('\n');
  })();
  const markers = [...tlMarkText.keys()].filter((v) => specific(v) && !nishText.has(v) && !baseText.has(v) && !/@example\.(com|org|net)$/i.test(v) && !sourceText.includes(v));
  ok(markers.length > 50, `TeamLink's data gives ${markers.length} names / emails / titles to look for`, 'too few markers to be a real test');
  // two words the application itself writes into every employee row: the Super Admin's designation and the default shift
  const OWN_WORDS = new Set(['Super Admin', 'General (9:00 AM – 6:00 PM)']);
  const inside = [...tlText.keys()].filter((v) => specific(v) && !baseText.has(v) && !OWN_WORDS.has(v) && nishText.has(v));
  ok(inside.length === 0, 'none of TeamLink\'s names, emails or titles exist in the new company\'s database', inside.slice(0, 5).join(' | '));

  heading('E1. the Super Admin chooses a password with the one-time link');
  const link = fs.readFileSync(linkFile, 'utf8').match(/new-password\?token=([a-f0-9]{64})/)[1];
  const goodPw = `Zz${crypto.randomBytes(9).toString('base64url')}!7q`; // in memory only, never printed
  const srvTl = start('tl');
  const srvNish = start('nish', { env: { COMPANY_KEY: 'nish' } });
  const [hTl, hNish] = await Promise.all([waitHealth(P.tl), waitHealth(P.nish)]);
  ok(hTl && hTl.ok === true && hTl.company === undefined, 'TeamLink-style server is up and its health answer is unchanged ({ok:true})', JSON.stringify(hTl));
  ok(hNish && hNish.ok === true && hNish.company === 'nish', 'the new company\'s server is up and says which company it is', JSON.stringify(hNish));
  ok(srvTl.exitInfo === null && srvNish.exitInfo === null, 'both servers are still running');

  const check1 = await call(P.nish, 'GET', `/api/auth/reset-password/check?token=${link}`);
  ok(check1.status === 200, 'the link is recognised', `${check1.status} ${check1.text.slice(0, 100)}`);
  const weak = await call(P.nish, 'POST', '/api/auth/reset-password', { body: { token: link, password: 'password', confirmPassword: 'password' } });
  ok(weak.status === 400, 'a weak password is refused', `${weak.status}`);
  const set = await call(P.nish, 'POST', '/api/auth/reset-password', { body: { token: link, password: goodPw, confirmPassword: goodPw } });
  ok(set.status === 200, 'the Super Admin chooses a strong password with the link', `${set.status} ${set.text.slice(0, 120)}`);
  const reuse = await call(P.nish, 'POST', '/api/auth/reset-password', { body: { token: link, password: `${goodPw}x`, confirmPassword: `${goodPw}x` } });
  ok(reuse.status === 410, 'the same link cannot be used a second time', `${reuse.status}`);

  heading('E2. each login only opens its own company');
  const lg = await call(P.nish, 'POST', '/api/auth/login', { body: { email: 'nish-admin@example.test', password: goodPw } });
  ok(lg.status === 200 && lg.json && lg.json.token, 'the new Super Admin signs in to the new company', `${lg.status}`);
  const nishTok = lg.json && lg.json.token;
  const lt = await call(P.tl, 'POST', '/api/auth/login', { body: { email: 'admin@teamlink.test', password: 'password123' } });
  ok(lt.status === 200 && lt.json && lt.json.token, 'the TeamLink-style Super Admin signs in to TeamLink', `${lt.status}`);
  const tlTok = lt.json && lt.json.token;
  const x1 = await call(P.tl, 'POST', '/api/auth/login', { body: { email: 'nish-admin@example.test', password: goodPw } });
  ok(x1.status === 401, 'the new company\'s Super Admin cannot sign in to TeamLink', `${x1.status}`);
  // (TeamLink's own sign-in attempts against the new company are tried AFTER the sweep below: a failed sign-in is written to the audit log
  //  with the typed address, and the sweep must not mistake that for TeamLink data.)
  const x3 = await call(P.nish, 'GET', '/api/employees', { token: tlTok });
  ok(x3.status === 401, 'a TeamLink sign-in token is worthless on the new company\'s server', `${x3.status}`);
  const x4 = await call(P.tl, 'GET', '/api/employees', { token: nishTok });
  ok(x4.status === 401, 'a new-company sign-in token is worthless on TeamLink\'s server', `${x4.status}`);

  heading('D. every menu and module is there (the permission matrix both Super Admins are given)');
  const meN = await call(P.nish, 'GET', '/api/auth/me', { token: nishTok });
  const meT = await call(P.tl, 'GET', '/api/auth/me', { token: tlTok });
  ok(meN.status === 200 && meT.status === 200, 'both /api/auth/me answered');
  const accN = meN.json.access; const accT = meT.json.access;
  const modulesN = Object.keys(accN || {}); const modulesT = Object.keys(accT || {});
  ok(modulesN.length > 20, `the new Super Admin is given ${modulesN.length} modules`, `${modulesN.length}`);
  ok(JSON.stringify(accN) === JSON.stringify(accT), 'the permission matrix is identical to TeamLink\'s Super Admin (same modules, same features, same actions)',
    `new=${modulesN.length} modules, teamlink=${modulesT.length}; only in one: ${[...modulesN.filter((m) => !modulesT.includes(m)), ...modulesT.filter((m) => !modulesN.includes(m))].slice(0, 6).join(',')}`);
  const pN = meN.json.products || {}; const pT = meT.json.products || {};
  ok(pN.hrms && pN.ats && pN.accounts && JSON.stringify(pN) === JSON.stringify(pT), 'HRMS, ATS and Accounts are all open, same as TeamLink', JSON.stringify(pN));
  ok(meN.json.role === 'SUPER_ADMIN' && JSON.stringify(meN.json.workflow.allowedStages) === JSON.stringify(meT.json.workflow.allowedStages), 'role Super Admin, the same pipeline stages');
  ok(meN.json.passwordStatus && meN.json.passwordStatus.mustChange === false, 'no "change your password" gate after the Super Admin chose one');

  heading('C. every screen\'s data request, as each Super Admin');
  const routesOf = (w) => JSON.parse(fs.readFileSync(path.join(TMP, `routes-${w}.json`), 'utf8'));
  let routes = [];
  try { routes = routesOf('nish'); } catch { ok(false, 'the route list was written by the preload', fs.existsSync(`${path.join(TMP, 'routes-nish.json')}.err`) ? fs.readFileSync(`${path.join(TMP, 'routes-nish.json')}.err`, 'utf8').slice(0, 300) : 'missing'); }
  const skip = /logout|\/health|\/stream|\/events$|\/sse|\/download|\/file\/|\/webhooks?\b|oauth|callback|\/connect/i;
  const todo = routes.filter((r) => r.startsWith('/api') && !/[:*()]/.test(r) && !skip.test(r));
  ok(todo.length > 150, `${todo.length} data requests found to try (of ${routes.length} GET routes; the rest need an id or are downloads / sign-in callbacks)`, `${todo.length}`);
  async function sweep(port, token) {
    const out = new Map(); let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < todo.length) {
        const url = todo[i]; i += 1;
        try { const r = await call(port, 'GET', url, { token }); out.set(url, { status: r.status, text: r.text.slice(0, 400000), json: r.json }); } catch (e) { out.set(url, { status: 0, text: String(e.message), json: null }); }
      }
    }));
    return out;
  }
  const [swN, swT] = [await sweep(P.nish, nishTok), await sweep(P.tl, tlTok)];
  // A request made in the first seconds after start-up can be told "not ready yet" (the same on TeamLink); ask those once more after the 15 s the program waits.
  // A request made in the first seconds of a brand-new database can fail ONCE: the program sets up a few of its own tables the first time a screen needs
  // them, and two screens opening at the same instant can both try ("duplicate column name", "not installed yet"). TeamLink's own database was set up long
  // ago, so it never happens there. Every such answer is asked again once, one at a time; a screen that still fails is a real failure.
  const retry = [swN, swT].map((m, k) => todo.filter((u) => m.get(u) && m.get(u).status >= 500).map((u) => [k, u]));
  if (retry[0].length || retry[1].length) {
    if ([...retry[0], ...retry[1]].some(([k, u]) => /not installed on this database yet|Starting up/.test((k === 0 ? swN : swT).get(u).text))) await sleep(16000);
    for (const [k, u] of [...retry[0], ...retry[1]]) { const r = await call(k === 0 ? P.nish : P.tl, 'GET', u, { token: k === 0 ? nishTok : tlTok }); (k === 0 ? swN : swT).set(u, { status: r.status, text: r.text.slice(0, 400000), json: r.json }); }
    console.log(`  (${retry[0].length + retry[1].length} request(s) failed once right after the database was created, and were asked again: ${[...retry[0], ...retry[1]].map(([k, u]) => `${k === 0 ? 'new' : 'tl'}:${u}`).join(', ')})`);
  }
  const answered = (m) => [...m.values()].filter((v) => v.status === 200).length;
  console.log(`  (answered 200: new company ${answered(swN)}, TeamLink-style ${answered(swT)} of ${todo.length})`);
  const hits = (m) => { const found = new Map(); for (const [url, v] of m) { if (v.status !== 200) continue; for (const mk of markers) if (v.text.includes(mk)) { if (!found.has(mk)) found.set(mk, []); found.get(mk).push(url); } } return found; };
  const seenT = hits(swT); const seenN = hits(swN);
  ok(seenT.size >= 15, `control: TeamLink-style answers do contain its demo names (${seenT.size} different ones found), so the check can see them`, `${seenT.size}`);
  ok(seenN.size === 0, 'NOT ONE TeamLink name, email or title appears in any answer given to the new company\'s Super Admin',
    [...seenN].slice(0, 5).map(([mk, urls]) => `"${mk}" in ${urls[0]}`).join(' | '));
  // INFORMATION ONLY: words that are TeamLink's own business lines. They are not database rows, so the check above cannot see them; a screen that
  // draws them from a default written in the program (for example the vacancy plan) would show them to a brand-new company.
  { const FLAVOUR = ['Edu-A-', 'Education', 'Medical', 'Manufacturing', 'TeamLink'];
    const flav = new Map();
    for (const [url, v] of swN) { if (v.status !== 200) continue; for (const w of FLAVOUR) if (v.text.includes(w)) { if (!flav.has(w)) flav.set(w, []); flav.get(w).push(url); } }
    console.log(`  (information) TeamLink's own business words in the new company's answers: ${flav.size ? [...flav].map(([w, u]) => `"${w}" in ${u.length} (${u.slice(0, 4).join(', ')})`).join(' | ') : 'none'})`);
    ok(!(flav.get('Edu-A-') || []).length, 'the vacancy plan (Education Team A / Team B seat names) is not given to the new company', (flav.get('Edu-A-') || []).join(','));
  }
  // counts on the main lists
  const listLen = (r) => (r && r.json ? (Array.isArray(r.json) ? r.json.length : (Array.isArray(r.json.items) ? r.json.items.length : (Array.isArray(r.json.rows) ? r.json.rows.length : (Array.isArray(r.json.data) ? r.json.data.length : null)))) : null);
  const lists = ['/api/clients', '/api/candidates', '/api/requirements', '/api/applications', '/api/invoices', '/api/employees', '/api/attendance', '/api/leave-requests', '/api/payroll/runs', '/api/announcements', '/api/assets', '/api/departments', '/api/interviews'];
  console.log('  list sizes (new company / TeamLink-style):');
  for (const u of lists) { const a = swN.get(u); const b = swT.get(u); if (a || b) console.log(`    ${u.padEnd(26)} ${String(a ? `${a.status} len=${listLen(a)}` : '-').padEnd(16)} ${b ? `${b.status} len=${listLen(b)}` : '-'}`); }
  const sized = lists.filter((u) => swN.get(u) && swN.get(u).status === 200 && listLen(swN.get(u)) !== null);
  const bigger = sized.filter((u) => listLen(swN.get(u)) > (u === '/api/employees' ? 1 : 0));
  ok(sized.length >= 5, `${sized.length} main lists could be measured`, sized.join(','));
  ok(bigger.length === 0, 'every main list is empty in the new company (the Super Admin themself is the one employee)', bigger.map((u) => `${u}=${listLen(swN.get(u))}`).join(', '));
  // screens that work on TeamLink but break on an empty company
  const broken = todo.filter((u) => swT.get(u) && swT.get(u).status === 200 && swN.get(u) && swN.get(u).status >= 500);
  ok(broken.length === 0, 'no screen that works on TeamLink fails (5xx) on the empty company', broken.slice(0, 8).map((u) => `${u} ${swN.get(u).text.slice(0, 80)}`).join(' | '));
  // A refusal that only says "there is no team lead / team yet" is the right answer for a company with nobody in it; anything else is a real refusal.
  const EMPTY_OK = /not in your area|no team|no team lead|nothing to/i;
  const denied = todo.filter((u) => swT.get(u) && swT.get(u).status === 200 && swN.get(u) && [401, 403].includes(swN.get(u).status));
  const realDenied = denied.filter((u) => !EMPTY_OK.test(swN.get(u).text));
  ok(realDenied.length === 0, 'no screen that opens for TeamLink\'s Super Admin is refused to the new Super Admin', realDenied.slice(0, 8).map((u) => `${u} ${swN.get(u).text.slice(0, 80)}`).join(' | '));
  if (denied.length) console.log(`  (refused only because the company has no team lead yet: ${denied.filter((u) => EMPTY_OK.test(swN.get(u).text)).join(', ')})`);
  if (broken.length) { try { const lg2 = fs.readFileSync(path.join(TMP, 'server-nish.log'), 'utf8'); console.log(`  nish server log tail:\n${lg2.slice(-1800)}`); } catch { /* none */ } }

  heading('E3. TeamLink\'s logins do not exist in the new company (tried after the sweep)');
  const x2 = await call(P.nish, 'POST', '/api/auth/login', { body: { email: 'admin@teamlink.test', password: 'password123' } });
  ok(x2.status === 401, 'TeamLink\'s Super Admin cannot sign in to the new company', `${x2.status}`);
  const staff = ['superadmin@teamlink.com', 'hr@teamlink.com', 'kiran@teamlink.test', 'recruiter@teamlink.test'];
  let anyStaff = 0;
  for (const em of staff) { const r = await call(P.nish, 'POST', '/api/auth/login', { body: { email: em, password: 'password123' } }); if (r.status === 200) anyStaff += 1; }
  ok(anyStaff === 0, 'none of TeamLink\'s staff logins exist in the new company', `${anyStaff} signed in`);
  fs.writeFileSync(path.join(TMP, 'sweep-summary.json'), JSON.stringify({ routes: routes.length, tried: todo.length, nish: Object.fromEntries([...swN].map(([k, v]) => [k, v.status])), tl: Object.fromEntries([...swT].map(([k, v]) => [k, v.status])) }, null, 1));

  heading('F. the wrong-database guard');
  const g = start('guard', { db: 'tl', env: { COMPANY_KEY: 'nish', PORT: String(P.guard) } });
  for (let i = 0; i < 60 && g.exitInfo === null; i += 1) await sleep(500);
  ok(g.exitInfo && g.exitInfo.code === 78, 'a company server pointed at TeamLink\'s database STOPS (exit 78) and never serves', JSON.stringify(g.exitInfo));
  const gl = fs.readFileSync(path.join(TMP, 'server-guard.log'), 'utf8');
  ok(/STOPPED: this server is set up for company "nish"/.test(gl), 'and it says why, in plain words');
  const plain = start('plain', { db: 'tl', env: { PORT: String(P.plain) } });
  const hp = await waitHealth(P.plain);
  ok(hp && JSON.stringify(hp) === '{"ok":true}', 'a server without COMPANY_KEY (TeamLink, every PC) behaves exactly as before', JSON.stringify(hp));
  void plain;

  heading('G. the settings check');
  const goodEnv = path.join(TMP, 'good.env'); const badEnv = path.join(TMP, 'bad.env'); const tlEnv = path.join(TMP, 'tl.env');
  const home = path.join(TMP, 'nish-home');
  fs.writeFileSync(tlEnv, ['PORT=4010', 'DATABASE_URL="file:./dev.db"', 'JWT_SECRET=' + 'a'.repeat(64), 'INTEGRATION_SECRET_KEY=' + 'b'.repeat(64), 'APP_BASE_URL=https://teamlink.teamlinks.in', 'UPLOAD_DIR=/root/.teamlink-uploads'].join('\n'));
  fs.writeFileSync(goodEnv, ['COMPANY_KEY=nish', 'PORT=4012', 'DATABASE_URL="file:./nish.db"', 'JWT_SECRET=' + 'c'.repeat(64), 'INTEGRATION_SECRET_KEY=' + 'd'.repeat(64), 'APP_BASE_URL=https://nish.example.org',
    `UPLOAD_DIR=${home}/data/uploads`, `ATS_IO_DIR=${home}/data/ats-io`, `MESSAGE_JOB_DIR=${home}/data/message-jobs`, `BACKUP_DIR=${home}/data/backups`, `TL_QR_SESSION_DIR=${home}/data/qr`, `AI_VOICE_LIVE_FILE=${home}/data/live-calls`,
    'GREENSTART_ENABLED=false', 'GREENSTART_SUPERVISE=false', 'GREENSTART_AUTOSTART=false', 'JOB_PORTAL_EMBED=0', 'JOB_PORTAL_SYNC_INTERVAL_MS=0'].join('\n'));
  fs.writeFileSync(badEnv, ['PORT=4010', 'DATABASE_URL="file:./dev.db"', 'JWT_SECRET=' + 'a'.repeat(64), 'INTEGRATION_SECRET_KEY=change-this-to-a-long-random-string', 'APP_BASE_URL=https://teamlink.teamlinks.in'].join('\n'));
  const cg = spawnSync(process.execPath, ['scripts/company-check.js', '--env', goodEnv, '--home', home, '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  ok(cg.status === 0, 'separate settings pass every line', cg.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
  const cb = spawnSync(process.execPath, ['scripts/company-check.js', '--env', badEnv, '--home', '/root', '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  ok(cb.status === 1 && (cb.stdout.match(/^FAIL/gm) || []).length >= 8, 'TeamLink\'s own settings are rejected line by line', `${(cb.stdout.match(/^FAIL/gm) || []).length} failures`);
  const cx = spawnSync(process.execPath, ['scripts/company-check.js', '--env', goodEnv, '--home', '/root', '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  ok(cx.status === 1 && /FAIL  HOME points/.test(cx.stdout), 'a copy that still uses the shared /root home folder is rejected');
  // the Companies menu settings (docs/second-company.md section 9): TeamLink's PUBLIC key and a link back pass; a company that could make passes itself fails
  const brOk = path.join(TMP, 'bridge-ok.env'); const brBad = path.join(TMP, 'bridge-bad.env');
  fs.writeFileSync(brOk, `${fs.readFileSync(goodEnv, 'utf8')}
COMPANY_BRIDGE_PUBLIC_KEY_FILE=${home}/config/bridge-public.pem
COMPANY_BRIDGE_HOME_URL=https://teamlink.teamlinks.in
`);
  fs.writeFileSync(brBad, `${fs.readFileSync(goodEnv, 'utf8')}
COMPANY_BRIDGE_DIR=${home}/bridge
COMPANY_BRIDGE_PUBLIC_KEY_FILE=/root/.teamlink-company-bridge/private.pem
`);
  const cbo = spawnSync(process.execPath, ['scripts/company-check.js', '--env', brOk, '--home', home, '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  ok(cbo.status === 0, 'the Companies menu settings (the public key of TeamLink and a link back to it) pass the check', (cbo.stdout.match(/^FAIL.*$/gm) || []).join(' | '));
  const cbb = spawnSync(process.execPath, ['scripts/company-check.js', '--env', brBad, '--home', home, '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  ok(cbb.status === 1 && /cannot make passes/.test(cbb.stdout) && /public key file is this company/.test(cbb.stdout), 'a company that is set up to make passes, or uses the private key of TeamLink, is rejected');
}

(async () => {
  let crashed = null;
  try { await main(); } catch (e) { crashed = e; failures += 1; console.log(`\nTEST STOPPED: ${e && e.stack ? e.stack : e}`); }
  cleanup();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed${crashed ? ' (stopped early)' : ''}`);
  process.exit(failures === 0 ? 0 : 1);
})();
