#!/usr/bin/env node
// ---------------------------------------------------------------------------
// COMPANY JOB PORTAL RULES TEST  (docs/second-company.md section 11)        node scripts/company-portal-test.js      (a few seconds, no server, no database)
//
// A separate company may run its own Job Portal, but never TeamLink's: the program adopts any portal that answers on its port, and the default ports and
// folders ARE TeamLink's. This checks, on the real code, that:
//   1. a company copy refuses to start a portal without ports, folders and a password of its own (and with TeamLink's 4323 / 5434);
//   2. TeamLink itself (no COMPANY_KEY) behaves exactly as before;
//   3. the settings check (company-check.js) accepts a company's own portal settings and rejects TeamLink's ports, secrets and folders;
//   4. the shell scripts are valid and the portal clean-up script is valid JavaScript.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACKEND, '..');
let passes = 0; let failures = 0;
const ok = (c, what, detail) => { if (c) { passes += 1; console.log(`  PASS  ${what}`); } else { failures += 1; console.log(`  FAIL  ${what}${detail ? `  -> ${detail}` : ''}`); } };
const heading = (t) => console.log(`\n== ${t}`);

const rand = (n = 64) => crypto.randomBytes(n / 2).toString('hex');
const good = {
  COMPANY_KEY: 'nish', JOB_PORTAL_EMBED: '1', JOB_PORTAL_PORT: '4324', JOB_PORTAL_PG_PORT: '5435', JOB_PORTAL_RUN_DIR: '/opt/company-nish/data/job-portal/run',
  JOBPORTAL__DEV_DB_DIR: '/opt/company-nish/data/job-portal/db', JOBPORTAL__DEV_PASSWORD: rand(32),
};

// run the module in a clean child so process.env is exactly what the case says
function enabledWith(env) {
  const r = spawnSync(process.execPath, ['-e', 'const m=require("./src/utils/jobPortalEmbed"); process.stdout.write(JSON.stringify({enabled:m.enabled(),why:m.companyPortalRefusal()}))'],
    { cwd: BACKEND, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 300) }; }
}

heading('1. a company copy refuses a portal that is not its own');
const cases = [
  ['no portal settings at all', { COMPANY_KEY: 'nish', JOB_PORTAL_EMBED: '1' }, /JOB_PORTAL_PORT/],
  ['TeamLink\'s web port 4323', { ...good, JOB_PORTAL_PORT: '4323' }, /4323/],
  ['TeamLink\'s database port 5434', { ...good, JOB_PORTAL_PG_PORT: '5434' }, /5434/],
  ['the same port twice', { ...good, JOB_PORTAL_PG_PORT: '4324' }, /differ/],
  ['no run folder', { ...good, JOB_PORTAL_RUN_DIR: '' }, /JOB_PORTAL_RUN_DIR/],
  ['no database folder', { ...good, JOBPORTAL__DEV_DB_DIR: '' }, /DEV_DB_DIR/],
  ['no demo-account password', { ...good, JOBPORTAL__DEV_PASSWORD: '' }, /DEV_PASSWORD/],
  ['a short demo-account password', { ...good, JOBPORTAL__DEV_PASSWORD: 'TeamLink@2026' }, /DEV_PASSWORD/],
];
for (const [label, env, re] of cases) {
  const r = enabledWith(env);
  ok(r.enabled === false && re.test(String(r.why)), `refused: ${label}`, JSON.stringify(r).slice(0, 200));
}
const g = enabledWith(good);
ok(g.enabled === true && g.why === null, 'a company with ports, folders and a password of its own may run its portal', JSON.stringify(g));
ok(enabledWith({ ...good, JOB_PORTAL_EMBED: '0' }).enabled === false, 'and "off" is still off');

heading('2. TeamLink is unchanged');
const tl = enabledWith({ JOB_PORTAL_EMBED: '1' });
ok(tl.enabled === true && tl.why === null, 'TeamLink (no COMPANY_KEY), embed on: enabled, default ports, no refusal', JSON.stringify(tl));
ok(enabledWith({ JOB_PORTAL_EMBED: '0' }).enabled === false, 'TeamLink, embed off: off');
ok(enabledWith({ NODE_ENV: 'production' }).enabled === false, 'TeamLink, production with nothing set: off (as before)');
ok(enabledWith({ NODE_ENV: 'development' }).enabled === true, 'a PC in development with nothing set: on (as before)');

heading('3. the settings check (company-check.js)');
const fs = require('fs');
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'company-portal-test-'));
const home = '/opt/company-nish/home';
const base = [
  'COMPANY_KEY=nish', `COMPANY_HOME=${home}`, 'PORT=4012', 'DATABASE_URL="file:/opt/company-nish/data/nish.db"', `JWT_SECRET=${rand()}`, `INTEGRATION_SECRET_KEY=${rand()}`, 'APP_BASE_URL=https://nish.example.org',
  'UPLOAD_DIR=/opt/company-nish/data/uploads', 'ATS_IO_DIR=/opt/company-nish/data/ats-io', 'MESSAGE_JOB_DIR=/opt/company-nish/data/message-jobs', 'BACKUP_DIR=/opt/company-nish/data/backups',
  'TL_QR_SESSION_DIR=/opt/company-nish/data/qr', 'AI_VOICE_LIVE_FILE=/opt/company-nish/data/live-calls.json',
  'GREENSTART_ENABLED=false', 'GREENSTART_SUPERVISE=false', 'GREENSTART_AUTOSTART=false', 'JOB_PORTAL_SYNC_SECRETS_PLACEHOLDER',
];
const tlEnv = path.join(TMP, 'tl.env');
const tlSecrets = { GREENSTART_SSO_SECRET: rand(), JOB_PORTAL_SYNC_TOKEN: rand(), JOB_PORTAL_PUSH_SECRET: rand(), JOBPORTAL__AUTH_SECRET: rand(), JOBPORTAL__INTEGRATION_SECRET_KEY: rand() };
fs.writeFileSync(tlEnv, ['PORT=4010', 'DATABASE_URL="file:./dev.db"', `JWT_SECRET=${rand()}`, `INTEGRATION_SECRET_KEY=${rand()}`, 'APP_BASE_URL=https://teamlink.teamlinks.in', 'UPLOAD_DIR=/root/.teamlink-uploads',
  ...Object.entries(tlSecrets).map(([k, v]) => `${k}=${v}`)].join('\n'));
const own = (extra) => [...base.filter((l) => l !== 'JOB_PORTAL_SYNC_SECRETS_PLACEHOLDER'), ...extra].join('\n');
const goodPortal = [
  'JOB_PORTAL_EMBED=1', 'JOB_PORTAL_PORT=4324', 'JOB_PORTAL_PG_PORT=5435', 'JOB_PORTAL_RUN_DIR=/opt/company-nish/data/job-portal/run',
  `JOB_PORTAL_SYNC_TOKEN=${rand()}`, `JOB_PORTAL_PUSH_SECRET=${rand()}`, `JOBPORTAL__AUTH_SECRET=${rand()}`, `JOBPORTAL__INTEGRATION_SECRET_KEY=${rand()}`, `JOBPORTAL__DEV_PASSWORD=${rand(32)}`,
  'JOBPORTAL__DEV_DB_DIR=/opt/company-nish/data/job-portal/db', 'JOBPORTAL__STORAGE_LOCAL_DIR=/opt/company-nish/data/job-portal/storage',
];
const check = (name, lines) => {
  const f = path.join(TMP, name); fs.writeFileSync(f, lines);
  const r = spawnSync(process.execPath, ['scripts/company-check.js', '--env', f, '--home', home, '--teamlink-env', tlEnv], { cwd: BACKEND, encoding: 'utf8' });
  return { status: r.status, fails: (r.stdout.match(/^FAIL.*$/gm) || []), out: r.stdout };
};
const c0 = check('off.env', own(['JOB_PORTAL_EMBED=0']));
ok(c0.status === 0, 'portal off (JOB_PORTAL_EMBED=0): passes', c0.fails.join(' | '));
const c1 = check('own.env', own(goodPortal));
ok(c1.status === 0 && /Job Portal is this company/.test(c1.out), 'a portal with ports, folders and secrets of the company\'s own: passes', c1.fails.join(' | '));
const c2 = check('tlports.env', own(goodPortal.map((l) => l.replace('JOB_PORTAL_PORT=4324', 'JOB_PORTAL_PORT=4323'))));
ok(c2.status === 1 && c2.fails.some((l) => /4323/.test(l)), 'TeamLink\'s web port 4323: rejected', c2.fails.join(' | '));
const c3 = check('tlsecret.env', own(goodPortal.filter((l) => !l.startsWith('JOB_PORTAL_SYNC_TOKEN=')).concat([`JOB_PORTAL_SYNC_TOKEN=${tlSecrets.JOB_PORTAL_SYNC_TOKEN}`])));
ok(c3.status === 1 && c3.fails.some((l) => /JOB_PORTAL_SYNC_TOKEN differs/.test(l)), 'TeamLink\'s sync token reused: rejected', c3.fails.join(' | '));
const c4 = check('tlauth.env', own(goodPortal.filter((l) => !l.startsWith('JOBPORTAL__AUTH_SECRET=')).concat([`JOBPORTAL__AUTH_SECRET=${tlSecrets.JOBPORTAL__AUTH_SECRET}`])));
ok(c4.status === 1 && c4.fails.some((l) => /JOBPORTAL__AUTH_SECRET differs/.test(l)), 'TeamLink\'s portal secret reused: rejected');
const c5 = check('tlfolder.env', own(goodPortal.map((l) => l.replace('JOBPORTAL__DEV_DB_DIR=/opt/company-nish/data/job-portal/db', 'JOBPORTAL__DEV_DB_DIR=/opt/teamlink-enterprise/job-portal-app/job_portal-main/var'))));
ok(c5.status === 1 && c5.fails.some((l) => /DEV_DB_DIR/.test(l)), 'TeamLink\'s portal database folder: rejected', c5.fails.join(' | '));
const c6 = check('weak.env', own(goodPortal.map((l) => l.replace(/^JOBPORTAL__DEV_PASSWORD=.*/, 'JOBPORTAL__DEV_PASSWORD=TeamLink@2026'))));
ok(c6.status === 1 && c6.fails.some((l) => /own|DEV_PASSWORD|refuses/.test(l)), 'the portal\'s well-known demo password: rejected', c6.fails.join(' | '));
const c7 = check('nohome.env', own(goodPortal).split('\n').filter((l) => !l.startsWith('COMPANY_HOME=')).join('\n'));
ok(c7.status === 1 && c7.fails.some((l) => /COMPANY_HOME/.test(l)), 'a company without COMPANY_HOME: rejected', c7.fails.join(' | '));
const c8 = check('roothome.env', own(goodPortal).replace(`COMPANY_HOME=${home}`, 'COMPANY_HOME=/root'));
ok(c8.status === 1 && c8.fails.some((l) => /COMPANY_HOME/.test(l)), 'COMPANY_HOME pointing at /root (TeamLink\'s home folder): rejected', c8.fails.join(' | '));

heading('5. a company copy never issues passes and keeps its own home folder (found on the live server, 2026-11-17)');
// a real key folder, made the way TeamLink's server makes it
const keyDir = path.join(TMP, 'tl-bridge');
const setup = spawnSync(process.execPath, ['scripts/company-bridge-setup.js', '--dir', keyDir, '--key', 'nish', '--name', 'NISH', '--url', 'https://nish.example.org'], { cwd: BACKEND, encoding: 'utf8' });
ok(setup.status === 0, 'a key folder was made for the test', setup.stderr);
const menuWith = (env) => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./src/utils/companyBridge").companiesForMenu()))'], { cwd: BACKEND, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return `error: ${(r.stderr || '').slice(0, 200)}`; }
};
const tlMenu = menuWith({ COMPANY_BRIDGE_DIR: keyDir });
ok(Array.isArray(tlMenu) && tlMenu.length === 1 && tlMenu[0].key === 'nish', 'control: TeamLink (no COMPANY_KEY) reads the key folder and lists the company', JSON.stringify(tlMenu));
const coMenu = menuWith({ COMPANY_KEY: 'nish', COMPANY_BRIDGE_DIR: keyDir });
ok(Array.isArray(coMenu) && coMenu.length === 0, 'a company copy that can SEE the key folder still lists nothing: it cannot make a pass', JSON.stringify(coMenu));
const homeOf = (env) => {
  const r = spawnSync(process.execPath, ['-e', 'require("./src/utils/companyGuard"); process.stdout.write(process.env.HOME || "")'], { cwd: BACKEND, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return r.stdout;
};
ok(homeOf({ COMPANY_KEY: 'nish', COMPANY_HOME: '/opt/company-nish/home', HOME: '/root' }) === '/opt/company-nish/home', 'a company copy started with HOME=/root takes its own home folder (COMPANY_HOME)');
ok(homeOf({ COMPANY_KEY: 'nish', HOME: '/root' }) === '/root', 'without COMPANY_HOME nothing changes (older company copies)');
ok(homeOf({ COMPANY_HOME: '/opt/company-nish/home', HOME: '/root' }) === '/root', 'TeamLink (no COMPANY_KEY) never changes its home folder');

heading('5b. Green Start (Omni-Channel): a company copy uses only its OWN Green Start');
const greenOf = (env) => {
  const r = spawnSync(process.execPath, ['-e', 'require("./src/utils/companyGuard"); process.stdout.write(String(process.env.GREENSTART_ENABLED))'], { cwd: BACKEND, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return r.stdout;
};
ok(greenOf({ COMPANY_KEY: 'nish' }) === 'false', 'a company copy with Green Start left on by default is switched off (the defaults are TeamLink ports)');
ok(greenOf({ COMPANY_KEY: 'nish', GREENSTART_API_PORT: '4020' }) === 'false', 'a company copy pointing at port 4020 (the Green Start of TeamLink) is switched off');
ok(greenOf({ COMPANY_KEY: 'nish', GREENSTART_API_PORT: '4021' }) === 'undefined', 'a company copy with an API port of its own keeps Green Start on');
ok(greenOf({ COMPANY_KEY: 'nish', GREENSTART_ENABLED: 'false' }) === 'false', 'explicitly off stays off');
ok(greenOf({}) === 'undefined' && greenOf({ GREENSTART_API_PORT: '4020' }) === 'undefined', 'TeamLink (no COMPANY_KEY): nothing changes');
const NL = String.fromCharCode(10);
const greenBase = own(goodPortal).split(NL).filter((l) => !l.startsWith('GREENSTART_ENABLED=')).join(NL);
const greenLines = (over = {}) => [`GREENSTART_ENABLED=true`, `GREENSTART_API_PORT=${over.api || 4021}`, `GREENSTART_REDIS_PORT=${over.redis || 6380}`, `GREENSTART_SSO_SECRET=${over.secret || rand()}`].join(NL);
const g1 = check('green-own.env', greenBase + NL + greenLines());
ok(g1.status === 0, 'its own Green Start (own ports and secret): passes the settings check', g1.fails.join(' | '));
const g2 = check('green-4020.env', greenBase + NL + greenLines({ api: 4020 }));
ok(g2.status === 1 && g2.fails.some((l) => /4020/.test(l)), 'TeamLink API port 4020: rejected', g2.fails.join(' | '));
const g3 = check('green-redis.env', greenBase + NL + greenLines({ redis: 6379 }));
ok(g3.status === 1 && g3.fails.some((l) => /6379/.test(l)), 'TeamLink Redis port 6379: rejected', g3.fails.join(' | '));
const g4 = check('green-secret.env', greenBase + NL + greenLines({ secret: tlSecrets.GREENSTART_SSO_SECRET }));
ok(g4.status === 1 && g4.fails.some((l) => /GREENSTART_SSO_SECRET differs/.test(l)), 'TeamLink\'s own Green Start sign-in secret reused: rejected', g4.fails.join(' | '));
const g5 = check('green-weak.env', greenBase + NL + greenLines({ secret: 'short' }));
ok(g5.status === 1, 'a short sign-in secret: rejected', g5.fails.join(' | '));

heading('6. the scripts are valid');
for (const f of ['company-deploy.sh', 'company-install.sh', 'company-sync.sh', 'company-portal-install.sh', 'company-green-install.sh', 'company-green-smtp.sh', 'company-green-sync.sh']) {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'deploy', 'vps', 'company', f)], { encoding: 'utf8' });
  ok(r.status === 0, `bash -n ${f}`, (r.stderr || '').slice(0, 160));
}
const init = fs.readFileSync(path.join(ROOT, 'deploy', 'vps', 'company', 'company-portal-init.mjs'), 'utf8');
const chk = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: init, encoding: 'utf8' });
ok(chk.status === 0, 'company-portal-init.mjs is valid JavaScript', (chk.stderr || '').slice(0, 160));
ok(/delete from users where lower\(email\) = any\(\$1\)/.test(init) && /refuse|throw new Error\('the portal has/.test(init), 'the clean-up removes only the two demo logins and refuses a portal that holds more');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* none */ }
console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILED'}: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
