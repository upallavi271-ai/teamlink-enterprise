// ---------------------------------------------------------------------------
// ATS PLUS background work (market wave 2026-11-21), started by index.js outside the sandbox only. Each piece does nothing that reaches
// a person until an Admin switches it on (BD outreach mails, webhook / Slack / Teams deliveries, the retention purge); the status page's
// health sample is internal.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const PIECES = [['bd', 'startWorker'], ['integrations', 'startWorker'], ['status', 'startSampler'], ['privacy', 'startRetention']];
function start() {
  if (require('../sandbox').isSandbox()) return; // eslint-disable-line global-require
  PIECES.forEach(([file, fn]) => {
    if (!fs.existsSync(path.join(__dirname, `${file}.js`))) return;
    try {
      const mod = require(`./${file}`); // eslint-disable-line global-require, import/no-dynamic-require
      if (typeof mod[fn] === 'function') mod[fn]();
    } catch (e) { console.error(`[ats-plus] ${file}: ${e.message}`); }
  });
}
module.exports = { start };
