// ---------------------------------------------------------------------------
// RUN LOGGER: every line goes to PostingLog (the screen) AND a plain log file (the machine), both scrubbed of the
// secrets this run holds (the username, the password) and of anything that looks like one.
//
//   const log = createLogger({ queueId, requirementId, portal, secrets: [username, password] });
//   log.info('login', 'Signed in');
//   await log.step('fill', async () => { ... })     times the step, logs "fill: ok (123 ms)" or the error
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../utils/sandbox');
const L = require('../jobPublish/logs');

function fileDir() {
  if (process.env.TL_PORTAL_LOG_DIR) return path.resolve(process.env.TL_PORTAL_LOG_DIR);
  const home = os.homedir() || os.tmpdir();
  return sandbox.isSandbox() ? path.join(home, '.teamlink-sandbox', 'portal-logs') : path.join(home, '.teamlink-portal-logs');
}
let dirReady = false;
function toFile(line) {
  try {
    const dir = fileDir();
    if (!dirReady) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); dirReady = true; }
    fs.appendFileSync(path.join(dir, `posting-${new Date().toISOString().slice(0, 10)}.log`), `${line}\n`);
  } catch { /* the file log is a convenience */ }
}

function createLogger({ queueId = null, requirementId = null, portal, secrets = [] }) {
  const held = [...secrets];
  const out = {
    addSecret(v) { if (v && String(v).length >= 3) held.push(String(v)); },
    async write(level, step, message, extra = {}) {
      const msg = L.scrub(message, held);
      toFile(`${new Date().toISOString()} ${level} [${portal}] ${queueId || '-'} ${step}: ${msg}`);
      await L.write({
        queueId, requirementId, portal, step, level, message: msg, screenshotPath: extra.screenshotPath || null, durationMs: extra.durationMs, secrets: held,
      });
    },
    info(step, message, extra) { return out.write('INFO', step, message, extra); },
    warn(step, message, extra) { return out.write('WARN', step, message, extra); },
    error(step, message, extra) { return out.write('ERROR', step, message, extra); },
    async step(name, fn) {
      const t0 = Date.now();
      try {
        const v = await fn();
        await out.info(name, 'ok', { durationMs: Date.now() - t0 });
        return v;
      } catch (err) {
        await out.error(name, `failed: ${String(err && err.message).split('\n')[0].slice(0, 300)}`, { durationMs: Date.now() - t0 });
        throw err;
      }
    },
  };
  return out;
}

module.exports = { createLogger, fileDir };
