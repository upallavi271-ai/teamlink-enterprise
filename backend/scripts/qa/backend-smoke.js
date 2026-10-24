#!/usr/bin/env node
// STARTUP SMOKE: starts a fresh copy of the backend on a spare port (4012) with the sandbox environment (TEST_MODE, sandbox.db),
// checks /api/health, then calls ~40 key GET routes as each ZZTEST role (tokens from ui-users.js). Any 5xx or a call over 30 s fails.
//   node scripts/qa/backend-smoke.js
const path = require('path'); const fs = require('fs'); const { spawn, spawnSync } = require('child_process');
const BACK = path.resolve(__dirname, '..', '..');
const PORT = 4012; const API = `http://localhost:${PORT}`;
const TOK = path.join(BACK, 'test-results', 'ui-tokens.json');
const ROUTES = [
  '/api/health', '/api/auth/me', '/api/dashboard/ats/home', '/api/dashboard/ats', '/api/dashboard/today', '/api/clients/', '/api/clients/meta', '/api/clients/agreement-links/summary',
  '/api/requirements/', '/api/requirements/summary', '/api/requirements/posting-sources', '/api/requirements/picker', '/api/candidates/?page=1&pageSize=20', '/api/candidates/sources/',
  '/api/candidates/duplicates/summary', '/api/candidates/board', '/api/followups/', '/api/followups/dashboard', '/api/ats/calendar', '/api/ats/offers',
  '/api/pending-work/settings', '/api/reports/ats', '/api/employees/me', '/api/employees/management', '/api/attendance/dashboard', '/api/attendance/punch-log',
  '/api/leave/', '/api/leave/pulse/status', '/api/leave/types', '/api/payroll/runs', '/api/payroll/cycle', '/api/payroll/entries', '/api/resignations',
  '/api/users', '/api/admin/role-catalog', '/api/integrations', '/api/accounts/chart-of-accounts', '/api/dashboard/accounts', '/api/tasks',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (!fs.existsSync(TOK)) spawnSync(process.execPath, [path.join(__dirname, 'ui-users.js'), TOK], { cwd: BACK, env: { ...process.env, TL_API: 'http://localhost:4011' }, stdio: 'inherit' });
  const tokens = JSON.parse(fs.readFileSync(TOK, 'utf8')).tokens;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT), DATABASE_URL: 'file:./sandbox.db', TEST_MODE: '1', TEAMLINK_SANDBOX: '1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`${API}/api/health`)).ok; } catch { await sleep(1000); } }
  console.log(up ? `PASS  backend started and /api/health answered in ${Math.round((Date.now() - t0) / 1000)} s` : 'FAIL  backend did not start');
  let bad = up ? 0 : 1; let total = 0;
  if (up) {
    for (const [role, tok] of Object.entries(tokens)) {
      const issues = []; let n = 0;
      for (const r of ROUTES) {
        const s = Date.now(); let st = 0;
        try { const res = await fetch(API + r, { headers: { Authorization: `Bearer ${tok}` } }); st = res.status; await res.text(); } catch (e) { st = -1; }
        n += 1; total += 1;
        if (st >= 500 || st === -1) issues.push(`${r} -> ${st}`);
        else if (Date.now() - s > 30000) issues.push(`${r} slow ${Date.now() - s} ms`);
      }
      if (issues.length) { bad += 1; console.log(`FAIL  ${role}: ${issues.join('; ')}`); } else console.log(`PASS  ${role}: ${n} routes, no 5xx`);
    }
  }
  if (bad) console.log(['--- server log tail ---', ...log.split(/\r?\n/).slice(-25)].join(' | '));
  child.kill();
  if (/FATAL|UnhandledPromiseRejection/.test(log)) { bad += 1; console.log('FAIL  fatal text in the server log'); }
  console.log(`${total} calls, ${bad ? bad + ' problem(s)' : 'no problems'}`);
  process.exit(bad ? 1 : 0);
})();
