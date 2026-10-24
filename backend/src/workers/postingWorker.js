// ---------------------------------------------------------------------------
// THE POSTING WORKER: a SEPARATE Node process (npm run posting-worker). It is NEVER started by src/index.js.
//
//   node src/workers/postingWorker.js            poll the queue every 5 s until stopped (Ctrl+C / SIGTERM: finishes
//                                                the run in progress, puts nothing half-done back wrongly, exits 0)
//   node src/workers/postingWorker.js --once     process at most ONE due entry, then exit
//   node src/workers/postingWorker.js --drain    process every entry that is due now, then exit (tests)
//
// SAFETY: it refuses to run against the real development database (prisma/dev.db) unless the environment sets
// TL_ALLOW_REAL_POSTING=1, so a stray start can never post anything. Real posting also needs the per-portal switch ON.
// ---------------------------------------------------------------------------
require('dotenv').config();
const os = require('os');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function refuseRealDb() {
  // (decided from the environment alone: the database is not even opened before this answer)
  const file = String(process.env.DATABASE_URL || '').replace(/^file:/, '').replace(/[?#].*$/, '').replace(/["']/g, '');
  if (/^dev\.db$/i.test(require('path').basename(file)) && process.env.TL_ALLOW_REAL_POSTING !== '1') { // eslint-disable-line global-require
    console.error('[posting-worker] REFUSING TO START: DATABASE_URL points at the real development database (dev.db). Set TL_ALLOW_REAL_POSTING=1 to allow real posting on purpose.'); // eslint-disable-line no-console
    return true;
  }
  return false;
}

async function main() {
  if (refuseRealDb()) process.exit(2);
  const D = require('../jobPublish/db'); // eslint-disable-line global-require
  const Q = require('../jobPublish/queue'); // eslint-disable-line global-require
  const S = require('../jobPublish/settings'); // eslint-disable-line global-require
  const svc = require('../jobPublish/service'); // eslint-disable-line global-require
  const runner = require('../jobPublish/runner'); // eslint-disable-line global-require
  const diag = require('../jobPublish/diagnostics'); // eslint-disable-line global-require
  if (!(await D.supported())) { console.error(`[posting-worker] ${D.NOT_READY}`); process.exit(3); } // eslint-disable-line no-console
  const workerId = `worker-${os.hostname()}-${process.pid}`;
  const shutdown = { requested: false };
  ['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => { shutdown.requested = true; console.log(`[posting-worker] ${s}: finishing the current run, then exiting`); })); // eslint-disable-line no-console
  console.log(`[posting-worker] ${workerId} started (${has('--once') ? 'once' : has('--drain') ? 'drain' : 'polling'})`); // eslint-disable-line no-console
  const lim = await S.limits(null);
  let current = null;
  const beat = () => S.beat({ pid: process.pid, host: os.hostname(), current }).catch(() => {});
  let handled = 0;
  for (;;) {
    if (shutdown.requested) break;
    await beat();
    await svc.sweepExpiry().catch(() => {});
    await require('../jobDist/tracker').maybeSweep().catch(() => {}); // eslint-disable-line global-require
    await diag.sweepPictures().then((r) => { if (r && r.removed) console.log(`[posting-worker] cleaned ${r.removed} old picture(s) (older than ${r.days} days)`); }).catch(() => {}); // eslint-disable-line no-console
    const { entry, blocked } = await Q.claim({ workerId });
    if (!entry) {
      if (has('--once') || has('--drain')) { if (blocked.length) console.log(`[posting-worker] waiting: ${blocked.map((b) => `${b.portal} (${b.reason})`).join('; ')}`); break; } // eslint-disable-line no-console
      await new Promise((r) => setTimeout(r, lim.pollMs));
      continue; // eslint-disable-line no-continue
    }
    current = { id: entry.id, portal: entry.portal, action: entry.action };
    await beat();
    console.log(`[posting-worker] ${entry.action} ${entry.portal} (${entry.id})`); // eslint-disable-line no-console
    // eslint-disable-next-line no-await-in-loop
    const out = await runner.processEntry(entry, { workerId, shutdown });
    console.log(`[posting-worker] -> ${out.state}${out.code ? ` ${out.code}` : ''}`); // eslint-disable-line no-console
    current = null;
    handled += 1;
    if (has('--once')) break;
  }
  await S.beat({ pid: process.pid, host: os.hostname(), current: null, stopped: true }).catch(() => {});
  console.log(`[posting-worker] stopped (${handled} handled)`); // eslint-disable-line no-console
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error('[posting-worker] fatal', e); process.exit(1); }); // eslint-disable-line no-console
module.exports = { refuseRealDb };
