#!/usr/bin/env node
// Runs every acceptance suite ONE AT A TIME against the sandbox (http://localhost:4011), with a per-suite timeout,
// cleans ZZTEST rows between suites (scripts/qa/zz-clean.js, sandbox only), writes backend/test-results/latest.md,
// exits non-zero if any suite failed.
//   node scripts/run-all-tests.js                 all suites
//   node scripts/run-all-tests.js pending-work    only suites whose name contains the text (several args allowed)
//   TL_SUITE_TIMEOUT=900 (seconds, default 600)   TL_SKIP=a,b  skip suites by substring
const fs = require('fs'); const path = require('path'); const { spawn, spawnSync } = require('child_process');
const BACK = path.resolve(__dirname, '..');
const API = process.env.TL_API || 'http://localhost:4011';
if (/:4010\b/.test(API)) { console.error('Refusing to run against the real server (4010).'); process.exit(2); }
const OUT = path.join(BACK, 'test-results'); const LOGS = path.join(OUT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const TIMEOUT = Number(process.env.TL_SUITE_TIMEOUT || 600) * 1000;
const NOT_SUITES = /^(zz-pwreset-test)$/; // placeholder for suites that need extra setup
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /-test[0-9]*\.js$/.test(f)).map((f) => path.join(dir, f)) : []);
let suites = [...list(path.join(BACK, 'scripts')), ...list(path.join(BACK, 'scripts', 'qa'))].filter((f) => !NOT_SUITES.test(path.basename(f, '.js')));
const only = process.argv.slice(2); const skip = (process.env.TL_SKIP || '').split(',').filter(Boolean);
if (only.length) suites = suites.filter((f) => only.some((o) => f.includes(o)));
suites = suites.filter((f) => !skip.some((s) => f.includes(s)));

// Suites that need a smaller sweep / longer clock on a full-size copy of the real data.
const SUITE_ENV = { 'agreement-privacy-test': { AP_ROLES: process.env.AP_ROLES || 'tl,rec' } };
const SUITE_TIMEOUT = { 'agreement-privacy-test': 1200, 'recruiter-own-reports-test': 900 };
function health() { try { return spawnSync(process.execPath, ['-e', "fetch('" + API + "/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeout: 8000 }).status === 0; } catch { return false; } }
function ensureSandbox() {
  if (health()) return true;
  console.log('  sandbox down: restarting (kept data)...');
  spawnSync(process.execPath, [path.join(BACK, 'scripts/sandbox.js'), '--stop'], { cwd: BACK });
  spawnSync(process.execPath, [path.join(BACK, 'scripts/sandbox.js'), '--detach', '--frontend', '--keep', '--no-watch'], { cwd: BACK, timeout: 120000 });
  for (let i = 0; i < 30; i += 1) { if (health()) return true; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']); }
  return false;
}
function parse(text) {
  let pass = 0; let fail = 0; const failed = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(PASS|ok|✓|\[PASS\]|OK)\b/.test(line)) pass += 1;
    else if (/^\s*(FAIL|not ok|✗|\[FAIL\]|FAILED)\b/.test(line)) { fail += 1; if (failed.length < 12) failed.push(line.trim().slice(0, 140)); }
  }
  const m = text.match(/(\d+)\s+pass(?:ed)?\D{1,20}(\d+)\s+fail/i) || null;
  if (m && !pass && !fail) { pass = Number(m[1]); fail = Number(m[2]); }
  return { pass, fail, failed };
}
function clean() { return spawnSync(process.execPath, [path.join(BACK, 'scripts/qa/zz-clean.js')], { cwd: BACK, encoding: 'utf8' }).stdout.trim(); }
function run(file) {
  return new Promise((resolve) => {
    const name = path.relative(path.join(BACK, 'scripts'), file).split(path.sep).join('/').replace(/\.js$/, '');
    const logFile = path.join(LOGS, name.replace(/\//g, '__') + '.log');
    ensureSandbox();
    const base = path.basename(file, '.js');
    const t0 = Date.now(); let buf = ''; let timedOut = false;
    const p = spawn(process.execPath, [file], { cwd: BACK, env: { ...process.env, TL_API: API, NODE_PATH: path.join(BACK, 'node_modules'), TL_TARGET_QUIET: '1', ...(SUITE_ENV[base] || {}) } });
    p.stdout.on('data', (d) => { buf += d; }); p.stderr.on('data', (d) => { buf += d; });
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, (SUITE_TIMEOUT[base] ? SUITE_TIMEOUT[base] * 1000 : TIMEOUT));
    p.on('close', (code) => {
      clearTimeout(timer); fs.writeFileSync(logFile, buf);
      const r = parse(buf);
      const status = timedOut ? 'TIMEOUT' : (code === 0 && r.fail === 0 ? 'PASS' : 'FAIL');
      resolve({ name, code, status, ...r, secs: Math.round((Date.now() - t0) / 1000) });
    });
  });
}
(async () => {
  console.log(`Running ${suites.length} suites one at a time against ${API}`);
  clean();
  const results = [];
  for (const f of suites) {
    const r = await run(f); results.push(r);
    console.log(`${r.status.padEnd(7)} ${r.name}  pass=${r.pass} fail=${r.fail} exit=${r.code} ${r.secs}s`);
    clean();
  }
  const bad = results.filter((r) => r.status !== 'PASS');
  let md = `# Test results (latest)\n\nRun: ${new Date().toISOString()}  against ${API}\n\nSuites passed: ${results.length - bad.length}/${results.length}\n\n| Suite | Pass | Fail | Status | Secs | Exit |\n|---|---|---|---|---|---|\n`;
  for (const r of results) md += `| ${r.name} | ${r.pass} | ${r.fail} | ${r.status} | ${r.secs} | ${r.code} |\n`;
  if (bad.length) { md += '\n## Failing lines\n'; for (const r of bad) md += `\n**${r.name}**\n${r.failed.map((l) => `- ${l}`).join('\n') || '- (no FAIL lines; see log)'}\n`; }
  fs.writeFileSync(path.join(OUT, 'latest.md'), md);
  console.log(`\n${results.length - bad.length}/${results.length} suites passed. Summary: test-results/latest.md`);
  process.exit(bad.length ? 1 : 0);
})();
