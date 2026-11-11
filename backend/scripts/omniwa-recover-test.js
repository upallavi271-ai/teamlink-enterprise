#!/usr/bin/env node
/**
 * WhatsApp AI agent (omniwa/agent.js): a turn interrupted by a restart is asked again, and a turn that stops before the model leaves a trace.
 * SANDBOX ONLY: works on a COPY of the database (VACUUM INTO a temp file); nothing real is read back, sent or changed, and no model is called.
 *   node scripts/omniwa-recover-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || [path.join(BACK, 'prisma', 'sandbox.db'), path.join(BACK, 'prisma', 'dev.db')].find((f) => fs.existsSync(f));
if (!SOURCE) { console.log('No database to copy (prisma/sandbox.db or prisma/dev.db).'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `zz-omniwa-recover-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
process.env.JWT_SECRET = 'omniwa-recover-test';

let failed = 0; let total = 0;
const ok = (name, cond, extra = '') => { total += 1; if (!cond) failed += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

(async () => {
  const S = require('../src/outreach/store');
  const A = require('../src/omniwa/agent');
  const { ensure } = require('../src/omniwa/schema');
  await ensure();
  const now = Date.now();
  const mkConv = async (id, extra = {}) => {
    await S.run('INSERT INTO "OmniWaConv" (id, e164, personType, name, createdAt, updatedAt, mode, state, collected, runningAt) VALUES (?,?,?,?,?,?,\'ai\',\'active\',?,?)',
      id, `9199${Math.floor(Math.random() * 1e8)}`, 'CANDIDATE', 'Test', now, now, extra.collected || '{}', extra.runningAt === undefined ? null : extra.runningAt);
  };
  const mkMsg = (id, convId, dir, at, consumedAt) => S.run('INSERT INTO "OmniWaMessage" (id, e164, convId, direction, body, status, at, consumedAt, createdAt) VALUES (?,?,?,?,?,?,?,?,?)', id, '919900000000', convId, dir, 'Hi', 'received', at, consumedAt, at);

  // 1. interrupted 5 minutes ago, messages consumed at that moment, nothing answered -> asked again
  const t1 = now - 5 * 60000;
  await mkConv('t_a', { runningAt: t1 }); await mkMsg('m_a1', 't_a', 'IN', t1 - 3000, t1); await mkMsg('m_a2', 't_a', 'IN', t1 - 2000, t1);
  // 2. an answer went out after the turn started -> left alone
  await mkConv('t_b', { runningAt: t1 }); await mkMsg('m_b1', 't_b', 'IN', t1 - 3000, t1); await mkMsg('m_b2', 't_b', 'OUT', t1 + 1000, null);
  // 3. already retried twice -> not again (no restart loop)
  await mkConv('t_c', { runningAt: t1, collected: JSON.stringify({ interruptedRetries: 2 }) }); await mkMsg('m_c1', 't_c', 'IN', t1 - 3000, t1);
  // 4. too old (3 hours) -> cleared, not answered now
  const old = now - 3 * 3600000;
  await mkConv('t_d', { runningAt: old }); await mkMsg('m_d1', 't_d', 'IN', old - 3000, old);
  // 5. not running at all -> untouched
  await mkConv('t_e'); await mkMsg('m_e1', 't_e', 'IN', now - 60000, now - 55000);

  const res = await A.recoverInterrupted(now);
  const by = Object.fromEntries(res.map((r) => [r.id, r]));
  const conv = async (id) => (await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', id))[0];
  const unconsumed = async (id) => (await S.q('SELECT COUNT(*) AS n FROM "OmniWaMessage" WHERE convId = ? AND direction = \'IN\' AND consumedAt IS NULL', id))[0].n;

  let c = await conv('t_a');
  ok('interrupted turn: asked again (pending set, run cleared)', by.t_a && by.t_a.recovered && c.pendingAt != null && c.runningAt == null);
  ok('interrupted turn: both messages are waiting again', Number(await unconsumed('t_a')) === 2);
  ok('interrupted turn: the retry is counted', JSON.parse(c.collected).interruptedRetries === 1);
  c = await conv('t_b');
  ok('answered turn: not asked again', by.t_b && !by.t_b.recovered && c.pendingAt == null && Number(await unconsumed('t_b')) === 0);
  c = await conv('t_c');
  ok('tried twice already: not asked a third time', by.t_c && !by.t_c.recovered && c.pendingAt == null && c.runningAt == null);
  c = await conv('t_d');
  ok('too old: cleared, not answered now', by.t_d && !by.t_d.recovered && c.runningAt == null && c.pendingAt == null);
  c = await conv('t_e');
  ok('not running: untouched', !by.t_e && c.pendingAt == null && c.runningAt == null);

  // a turn that stops before the model leaves a trace: AI switched off on a COPY of the settings
  await S.run('UPDATE "OmniWaAiConfig" SET enabled = 0 WHERE id = \'main\'');
  await S.run('INSERT INTO "OmniWaConv" (id, e164, personType, name, createdAt, updatedAt, mode, state, collected, pendingAt) VALUES (?,?,?,?,?,?,\'ai\',\'active\',\'{}\',?)', 't_f', '919911111111', 'CANDIDATE', 'Test', now, now, now - 60000);
  await mkMsg('m_f1', 't_f', 'IN', now - 61000, null);
  const turn = await A.tick(now + 10000, { force: true });
  const runs = await S.q('SELECT outcome FROM "OmniWaAiRun" WHERE convId = \'t_f\'');
  ok('AI switched off: the turn is written to the AI log', runs.length === 1 && runs[0].outcome === 'skipped_off', runs.map((r) => r.outcome).join(','));
  ok('AI switched off: nothing was sent', Number((await S.q('SELECT COUNT(*) AS n FROM "OmniWaMessage" WHERE convId = \'t_f\' AND direction = \'OUT\''))[0].n) === 0);
  void turn;

  console.log(`\n${total - failed}/${total} passed`);
  try { fs.unlinkSync(COPY); } catch { /* temp file */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e && e.stack || e); try { fs.unlinkSync(COPY); } catch { /* temp file */ } process.exit(1); });
