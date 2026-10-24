// TeamLink helper (NOT part of the Green Start zip). A tiny "dead-man switch" for the parts the TeamLink backend started.
//
// The TeamLink backend touches a heartbeat file every 5 seconds. A restart of the backend (nodemon, a code edit) takes a few seconds, so the
// parts keep running through it. If the heartbeat goes quiet for a long time (the backend was closed or killed) or says "stop", this program
// stops every part the backend started, in reverse order (entrance, worker, server, Redis, then the database cleanly with pg_ctl) and exits.
// It never touches parts that a person started with start-green-start.cmd (those have no pid file of ours).
//
// Started by the supervisor with the path of a JSON settings file { heartbeat, pidDir, order, pgCtl, pgData, maxAgeMs, checkMs, logFile, redisCli, redisSecretFile, redisStateFile }.
// With a second argument `--once` it stops everything right now and exits (used by the admin Stop button and when the backend is stopped for real).
// No packages, plain Node, about 30 MB of memory.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const maxAge = Number(cfg.maxAgeMs) || 120000;
const every = Number(cfg.checkMs) || 10000;
const log = (m) => { try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} [watchdog] ${m}\n`); } catch { /* no log */ } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = (part) => { try { return JSON.parse(fs.readFileSync(path.join(cfg.pidDir, `${part}.pid`), 'utf8')); } catch { return null; } };

function killTree(pid) {
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}

function stopAll(why) {
  log(`stopping Green Start parts: ${why}`);
  for (const part of [...cfg.order].reverse()) {
    const p = readPid(part);
    if (!p || !p.pid) continue;
    if (part === 'redis' && cfg.redisCli && fs.existsSync(cfg.redisCli)) {
      // ask Redis to save its small snapshot and stop itself (password via the environment, never on the command line)
      let port = 6379; let pw = '';
      try { port = JSON.parse(fs.readFileSync(cfg.redisStateFile, 'utf8')).port || 6379; } catch { /* default */ }
      try { pw = fs.readFileSync(cfg.redisSecretFile, 'utf8').trim(); } catch { /* none */ }
      spawnSync(cfg.redisCli, ['-h', '127.0.0.1', '-p', String(port), 'shutdown', 'save'], { stdio: 'ignore', windowsHide: true, timeout: 15000, env: { ...process.env, REDISCLI_AUTH: pw } });
    }
    if (part === 'db' && cfg.pgCtl && fs.existsSync(cfg.pgCtl)) {
      spawnSync(cfg.pgCtl, ['stop', '-D', cfg.pgData, '-m', 'fast', '-w', '-t', '30'], { stdio: 'ignore', windowsHide: true, timeout: 45000 });
    }
    if (alive(p.pid)) killTree(p.pid);
    try { fs.unlinkSync(path.join(cfg.pidDir, `${part}.pid`)); } catch { /* gone */ }
  }
}
const dropSelf = () => { try { const j = JSON.parse(fs.readFileSync(path.join(cfg.pidDir, 'watchdog.pid'), 'utf8')); if (j.pid === process.pid) fs.unlinkSync(path.join(cfg.pidDir, 'watchdog.pid')); } catch { /* gone */ } };

if (process.argv[3] === '--once') { stopAll('requested'); process.exit(0); }
try { fs.writeFileSync(path.join(cfg.pidDir, 'watchdog.pid'), JSON.stringify({ pid: process.pid, startedAt: Date.now() })); } catch { /* ignore */ }
log('started');
const timer = setInterval(() => {
  let text = ''; let age = Infinity;
  try { text = fs.readFileSync(cfg.heartbeat, 'utf8'); age = Date.now() - fs.statSync(cfg.heartbeat).mtimeMs; } catch { /* no heartbeat file */ }
  // nothing left to watch: leave
  if (!cfg.order.some((part) => { const p = readPid(part); return p && p.pid && alive(p.pid); })) { log('nothing left to watch, leaving'); clearInterval(timer); dropSelf(); process.exit(0); }
  if (/^stop\b/.test(text)) { stopAll('the backend asked for a stop'); clearInterval(timer); dropSelf(); process.exit(0); }
  if (age > maxAge) { stopAll(`the TeamLink backend has been silent for ${Math.round(age / 1000)} s`); clearInterval(timer); dropSelf(); process.exit(0); }
}, every);
