// ---------------------------------------------------------------------------
// Starts ./host.mjs (the Job Portal) as an independent background process and
// exits at once.
//
// Why a launcher: nodemon restarts the main backend on Windows with
// `taskkill /pid <backend> /T /F`, which kills the whole process TREE. A child
// started straight from the backend would be killed by force on every code
// edit - and an embedded database killed by force can lose its last writes.
// Started from here, the portal's parent is this launcher, which has already
// exited, so a backend restart does not touch it. It stops CLEANLY on its own
// when the backend's heartbeat stops (see host.mjs).
//
// Everything is hidden (windowsHide) and detached; output goes to the log file
// passed in JP_LOG. Never opens a console window.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = process.env.JP_LOG;
const host = path.join(__dirname, 'host.mjs');

let out = 'ignore';
if (logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    // Keep the log small: one previous copy.
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
  } catch { /* keep appending */ }
  out = fs.openSync(logFile, 'a');
}

const child = spawn(process.execPath, [host], {
  cwd: process.env.JP_ROOT || path.join(__dirname, '..', 'job_portal-main'),
  env: process.env,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', out, out],
});
child.unref();
// The host writes its own pid file (JP_PIDFILE); this line is for a person.
process.stdout.write(`${child.pid}\n`, () => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
