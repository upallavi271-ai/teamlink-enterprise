/**
 * TeamLink.Enterprise — the Job Portal HOST (runs in the portal's own process).
 *
 * The Job Portal in ../job_portal-main is the customer's application and is
 * kept EXACTLY as supplied: no file in it is edited. This host is the whole
 * embedding layer on the portal side:
 *
 *   1. It runs the portal's own entry point, tools/dev-server.mjs (embedded
 *      PostgreSQL in var/dev-db, or a real server when DATABASE_URL is set),
 *      unchanged - same migrations, same API, same web/ folder.
 *   2. Just before the portal app starts listening it puts ONE router in
 *      front of it: the TeamLink.Enterprise server-to-server sync
 *      (./teamlink-integration.mjs, routes /api/integrations/teamlink/*,
 *      token-guarded). It also binds the port to 127.0.0.1 only: browsers
 *      reach the portal through the main app's /jobs, never on its own port.
 *   3. It watches the main backend's heartbeat file. A nodemon restart of the
 *      main backend is a few seconds and the portal keeps running through it;
 *      when the main backend is STOPPED (no heartbeat for JP_HEARTBEAT_GRACE_MS,
 *      default 90 s, or "stop" written into the file) the portal shuts down
 *      CLEANLY - the dev server's own SIGTERM handler, which checkpoints and
 *      closes the embedded database, so no write is lost.
 *
 * Started by backend/src/utils/jobPortalEmbed.js through ./launcher.cjs.
 * Environment (set by the supervisor):
 *   JP_ROOT        the portal folder (job_portal-main)
 *   JP_PORT        the internal port (default 4323)
 *   JP_HEARTBEAT   the heartbeat file the main backend touches
 *   JP_PIDFILE     where this process writes { pid, port, startedAt }
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

const ROOT = resolve(process.env.JP_ROOT || join(import.meta.dirname, '..', 'job_portal-main'));
const PORT = parseInt(process.env.JP_PORT, 10) || 4323;
const HEARTBEAT = process.env.JP_HEARTBEAT || '';
const GRACE_MS = parseInt(process.env.JP_HEARTBEAT_GRACE_MS, 10) || 90_000;
const PIDFILE = process.env.JP_PIDFILE || '';
const BIND = process.env.JP_BIND || '127.0.0.1';

const log = (...a) => console.log(new Date().toISOString(), '[host]', ...a);

/* ---- 1. the TeamLink router, in front of the portal app ------------- */
// The portal's own express (api/node_modules) - the same module instance its
// createApp() uses, so the patch below sees the portal app's listen().
const apiRequire = createRequire(join(ROOT, 'api', 'package.json'));
const express = apiRequire('express');
const { teamlinkFrontRouter } = await import(pathToFileURL(join(import.meta.dirname, 'teamlink-integration.mjs')).href);

const originalListen = express.application.listen;
express.application.listen = function listen(port, ...rest) {
  // Once, for the portal app only (dev-server.mjs: app.listen(PORT, cb)).
  express.application.listen = originalListen;
  const front = teamlinkFrontRouter({ root: ROOT, express });
  this.use(front);
  // Move it from the end of the stack to just after express's own two init
  // layers (query, expressInit): ahead of the portal's routes and its
  // /api 404, behind nothing else. Nothing in the portal app is replaced.
  const stack = this._router.stack;
  stack.splice(2, 0, stack.pop());
  const cb = rest.find((x) => typeof x === 'function');
  log(`TeamLink sync routes mounted; binding ${BIND}:${port}`);
  return originalListen.call(this, port, BIND, cb);
};

/* ---- 2. heartbeat watchdog ----------------------------------------- */
let stopping = false;
function stopCleanly(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${why}`);
  try { if (PIDFILE && existsSync(PIDFILE)) unlinkSync(PIDFILE); } catch { /* gone */ }
  // dev-server.mjs registered process.on('SIGTERM', stop): close the HTTP
  // server, the pool, checkpoint + close the embedded database, exit 0.
  process.emit('SIGTERM');
  // If its handler never exits (it always should), do not hang forever.
  setTimeout(() => process.exit(0), 20_000).unref();
}
if (HEARTBEAT) {
  const startedAt = Date.now();
  setInterval(() => {
    let st = null;
    try { st = statSync(HEARTBEAT); } catch { /* not written yet */ }
    if (st) {
      let body = '';
      try { body = readFileSync(HEARTBEAT, 'utf8'); } catch { /* racing a write */ }
      if (/^stop\b/.test(body)) return stopCleanly('the main backend asked the portal to stop');
      if (Date.now() - st.mtimeMs > GRACE_MS) return stopCleanly(`no heartbeat from the main backend for ${Math.round((Date.now() - st.mtimeMs) / 1000)} s`);
    } else if (Date.now() - startedAt > GRACE_MS) {
      return stopCleanly('no heartbeat file');
    }
    return undefined;
  }, 5000).unref();
}
process.on('uncaughtException', (err) => { log('uncaught:', err && err.stack ? err.stack : err); });

/* ---- ONE process per database --------------------------------------- *
 * The embedded engine (PGlite in var/dev-db) must never be opened by two
 * processes at once. A second portal - this host started twice, or an old
 * standalone `node tools/dev-server.mjs 4323` - would hold the web port and
 * the database socket port, so both are checked BEFORE the database is
 * opened, and this process leaves if either is taken. */
const net = await import('node:net');
const portFree = (p) => new Promise((resolveFree) => {
  const srv = net.createServer();
  srv.once('error', () => resolveFree(false));
  srv.once('listening', () => srv.close(() => resolveFree(true)));
  srv.listen(p, '127.0.0.1');
});
const PG_PORT = parseInt(process.env.PG_PORT, 10) || 5434;
for (const [p, what] of [[PORT, 'web'], ...(process.env.DATABASE_URL ? [] : [[PG_PORT, 'database socket']])]) {
  // eslint-disable-next-line no-await-in-loop
  if (!(await portFree(p))) {
    log(`port ${p} (${what}) is already in use — another Job Portal is running on this database; not starting a second one.`);
    process.exit(3);
  }
}
// Only now, as the one process allowed to open the database.
if (PIDFILE) {
  writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString(), root: ROOT }));
  process.on('exit', () => { try { if (existsSync(PIDFILE) && JSON.parse(readFileSync(PIDFILE, 'utf8')).pid === process.pid) unlinkSync(PIDFILE); } catch { /* ignore */ } });
}

/* ---- 3. the portal itself, unchanged ------------------------------- */
// dev-server.mjs reads its port from argv[2] and everything else from the
// environment / ../job_portal-main/.env, exactly as `node tools/dev-server.mjs`.
process.chdir(ROOT);
process.argv[2] = String(PORT);
log(`starting the Job Portal from ${ROOT} on internal port ${PORT}`);
await import(pathToFileURL(join(ROOT, 'tools', 'dev-server.mjs')).href);
