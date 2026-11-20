#!/usr/bin/env node
/**
 * THE JOINED / DROPPED FACT IS NEVER READ EMPTY (utils/joinedRule.js). A sync cache of "who dropped" used to be filled lazily: a request that read it
 * before the first load finished (right after a start, or after the TTL) counted dropped people as Joined (lifecycle test: Joined tile 1140 -> 1045).
 * Now an early middleware loads it before any route runs and one in-flight load is shared.
 * Checks, each on a freshly started server (SANDBOX ONLY, a COPY of the sandbox database that has dropped people):
 *   A  the VERY FIRST requests (Joining list, Joined funnel tile, My results, requirement History) already leave the dropped people out
 *   B  after the TTL ran out (JOINED_RULE_TTL_MS=1500) a change made behind the server's back shows on the next request
 *   C  10 concurrent first requests all agree
 *   D  the middleware never fails a request when the load errors (a broken table is survived, health answers)
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4301 node scripts/joined-race-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-joinedrace-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const BASE_PORT = Number(process.env.TEST_PORT) || 4301;
const env = (port) => ({
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(port), JWT_SECRET: 'joined-race-test', JOINED_RULE_TTL_MS: '1500', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
});
Object.assign(process.env, env(BASE_PORT));
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server = null;
let token = '';
let API = '';
const call = async (url) => {
  const r = await fetch(API + url, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
async function start(port) {
  API = `http://localhost:${port}/api`;
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: env(port), stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  return false;
}
async function stopServer() { if (server) { server.kill(); server = null; await sleep(1200); } }
async function finish(code) {
  await stopServer();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const raw = new DatabaseSync(COPY);
const dropped = () => raw.prepare("SELECT applicationId, requirementId, candidateName FROM JoiningRecord WHERE status = 'Dropped' AND COALESCE(hiringType,'') <> 'TeamLink Internal Hire'").all().filter((r) => !/zztest|example\.test/i.test(r.candidateName || ''));
const rowsOf = (b) => (Array.isArray(b) ? b : ((b && b.rows) || []));
const tile = (b, key) => ((b && (b.tiles || b.cards || b.funnel)) || []).find((t) => t.key === key || t.id === key);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  token = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const drops = dropped();
  if (!drops.length) { console.log('no dropped people in the sandbox copy'); await finish(2); return; }
  const dropSet = new Set(drops.map((d) => d.applicationId));
  const probe = drops[0];

  // the facts on a warm, settled server (the answer every first request must equal)
  if (!(await start(BASE_PORT))) { console.log('The server did not answer /api/health: a leftover process may hold the port; pick another TEST_PORT.'); await finish(2); return; }
  await sleep(2500);
  const warmFunnel = await call('/ats-reports/funnel');
  const warmMy = await call('/ats-reports/my-results');
  const warmJoining = await call('/ats/joining');
  const warmJoinedTile = JSON.stringify(warmFunnel.body && warmFunnel.body.tiles ? warmFunnel.body.tiles.map((t) => [t.key, t.value]) : warmFunnel.body);
  check('0 (baseline) a settled server answers and the Joining list flags the dropped people', warmFunnel.status === 200 && warmJoining.status === 200 && rowsOf(warmJoining.body).some((r) => dropSet.has(r.id) && r.leftAfterJoining === true), [warmFunnel.status, warmJoining.status]);
  await stopServer();

  // ===================================================================== A: the very first requests after a start
  if (!(await start(BASE_PORT + 1))) { console.log('server 2 did not start'); await finish(2); return; }
  const f1 = await call('/ats-reports/funnel');
  const j1 = await call('/ats/joining');
  const m1 = await call('/ats-reports/my-results');
  const h1 = await call(`/ats/history/requirement/${probe.requirementId}`);
  check('A1 the very first Joining list already marks every dropped person as left after joining', j1.status === 200 && rowsOf(j1.body).filter((r) => dropSet.has(r.id)).length > 0 && rowsOf(j1.body).filter((r) => dropSet.has(r.id)).every((r) => r.leftAfterJoining === true && r.stageLabel === 'Dropped'), rowsOf(j1.body).filter((r) => dropSet.has(r.id) && r.leftAfterJoining !== true).length);
  check('A2 the very first Joined funnel tile equals the settled one (dropped people are not counted as Joined)', JSON.stringify(f1.body && f1.body.tiles ? f1.body.tiles.map((t) => [t.key, t.value]) : f1.body) === warmJoinedTile, null);
  check('A3 the very first My results equals the settled one', m1.status === 200 && JSON.stringify(m1.body) === JSON.stringify(warmMy.body), null);
  const hRow = rowsOf(h1.body).find((r) => r.applicationId === probe.applicationId);
  check('A4 the very first requirement History shows the dropped person at Dropped', h1.status === 200 && (!hRow || hRow.stageLabel === 'Dropped') && (h1.body.dropSummary ? h1.body.dropSummary.leftAfterJoining >= 1 : true), hRow && hRow.stageLabel);

  // ===================================================================== B: after the TTL a change made behind the server's back shows
  const joinedRec = raw.prepare("SELECT id, applicationId FROM JoiningRecord WHERE status = 'Joined' AND COALESCE(hiringType,'') <> 'TeamLink Internal Hire' AND candidateName NOT LIKE '%ZZTEST%' LIMIT 1").get();
  const before = rowsOf((await call('/ats/joining')).body).find((r) => r.id === joinedRec.applicationId);
  check('B0 that person is Joined now', !!before && before.leftAfterJoining !== true, before && before.leftAfterJoining);
  raw.prepare("UPDATE JoiningRecord SET status = 'Dropped', droppedOn = ?, dropReason = 'Resigned', dropWithinGuarantee = 1 WHERE id = ?").run(new Date().toISOString().slice(0, 10), joinedRec.id);
  await sleep(2000); // longer than JOINED_RULE_TTL_MS (1500)
  const after = rowsOf((await call('/ats/joining')).body).find((r) => r.id === joinedRec.applicationId);
  check('B1 after the TTL the very next request already counts him as dropped (a fresh load, never a stale or empty set)', !!after && after.leftAfterJoining === true && after.stageLabel === 'Dropped', after && [after.leftAfterJoining, after.stageLabel]);
  raw.prepare("UPDATE JoiningRecord SET status = 'Joined', droppedOn = NULL, dropReason = NULL, dropWithinGuarantee = NULL WHERE id = ?").run(joinedRec.id);
  await sleep(2000);
  const back = rowsOf((await call('/ats/joining')).body).find((r) => r.id === joinedRec.applicationId);
  check('B2 ...and when it is undone behind the back, the next request after the TTL says Joined again', !!back && back.leftAfterJoining !== true, back && back.leftAfterJoining);
  await stopServer();

  // ===================================================================== C: ten concurrent first requests
  if (!(await start(BASE_PORT + 2))) { console.log('server 3 did not start'); await finish(2); return; }
  const urls = ['/ats-reports/funnel', '/ats/joining', '/ats-reports/funnel', '/ats/joining', '/ats-reports/my-results', '/ats-reports/funnel', '/ats/joining', '/ats-reports/my-results', '/ats-reports/funnel', '/ats/joining'];
  const outs = await Promise.all(urls.map((u) => call(u)));
  const funnels = outs.filter((_, i) => urls[i] === '/ats-reports/funnel').map((o) => JSON.stringify(o.body && o.body.tiles ? o.body.tiles.map((t) => [t.key, t.value]) : o.body));
  const joinings = outs.filter((_, i) => urls[i] === '/ats/joining');
  const mys = outs.filter((_, i) => urls[i] === '/ats-reports/my-results').map((o) => JSON.stringify(o.body));
  check('C1 ten concurrent first requests all answered 200', outs.every((o) => o.status === 200), outs.map((o) => o.status));
  check('C2 every concurrent funnel equals the settled one', funnels.every((f) => f === warmJoinedTile), funnels.map((f) => f.length));
  check('C3 every concurrent Joining list flags the dropped people', joinings.every((o) => rowsOf(o.body).filter((r) => dropSet.has(r.id)).every((r) => r.leftAfterJoining === true)), null);
  check('C4 every concurrent My results equals the settled one', mys.every((m) => m === JSON.stringify(warmMy.body)), null);
  await stopServer();

  // ===================================================================== D: a failing load never fails a request (and an empty answer is never trusted)
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.DATABASE_URL = 'file:C:/nonexistent-dir-zz/none.db';
    const JR = require('./src/utils/joinedRule');
    const mw = JR.middleware();
    let nexts = 0;
    const t0 = Date.now();
    Promise.all([1, 2, 3].map(() => new Promise((res) => mw({ path: '/ats/joining' }, {}, () => { nexts += 1; res(); })))).then(() => {
      let health = 0; mw({ path: '/health' }, {}, () => { health += 1; });
      console.log(JSON.stringify({ nexts, health, loaded: JR.isLoaded(), size: JR.stateKey(), ms: Date.now() - t0 }));
      process.exit(0);
    });
  `], { cwd: BACK, env: { ...process.env, DATABASE_URL: 'file:C:/nonexistent-dir-zz/none.db' }, encoding: 'utf8', timeout: 60000 });
  const res = JSON.parse(out.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop());
  check('D1 when the load fails, all three requests still go on (the middleware never fails a request) and /health is skipped', res.nexts === 3 && res.health === 1, res);
  check('D2 a failed load is never marked loaded (an empty set is not trusted; the next request tries again)', res.loaded === false, res);

  // ===================================================================== E: a load that fails ONCE (database busy at the start) is never cached as "nobody dropped"
  const out2 = execFileSync(process.execPath, ['-e', `
    const S = require('./src/joindrop/schema');
    const JR = require('./src/utils/joinedRule');
    const real = S.ensure;
    let calls = 0;
    S.ensure = async () => { calls += 1; return calls === 1 ? false : real(); };
    (async () => {
      await JR.refresh({ fresh: true });
      const afterBad = { loaded: JR.isLoaded(), n: JR.stateKey() };
      await JR.refresh();
      const afterGood = { loaded: JR.isLoaded(), n: JR.stateKey() };
      console.log(JSON.stringify({ afterBad, afterGood }));
      process.exit(0);
    })();
  `], { cwd: BACK, env: process.env, encoding: 'utf8', timeout: 60000 });
  const r2 = JSON.parse(out2.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop());
  check('E1 a failed first load is not trusted (not marked loaded, the next caller loads again)', r2.afterBad.loaded === false, r2);
  check('E2 ...and the next caller gets the real dropped people (not an empty set held for the TTL)', r2.afterGood.loaded === true && !/:0$/.test(r2.afterGood.n), r2);

  console.log(`
${total - failed}/${total} passed`);
  await finish(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); await finish(1); });
