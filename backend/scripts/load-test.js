#!/usr/bin/env node
/**
 * LOAD TEST (ATS audit 159 / 160, founder 2026-11-17): N people at once opening the busiest screens' APIs, for a fixed time.
 * Reports requests/second, p50 / p95 / p99 response time and errors per endpoint and in total.
 * Run ONLY against a sandbox / local server, never production:
 *   API=http://localhost:4091/api TOKEN=<a sandbox admin token> USERS=100 SECONDS=30 node scripts/load-test.js
 */
const API = process.env.API || 'http://localhost:4091/api';
const TOKEN = process.env.TOKEN;
const USERS = Number(process.env.USERS || 100);
const SECONDS = Number(process.env.SECONDS || 30);
if (!TOKEN) { console.error('TOKEN is required'); process.exit(2); }
if (/teamlinks\.in|72\.61\.233\.104/.test(API)) { console.error('Refusing to load-test production.'); process.exit(2); }

const PATHS = (process.env.PATHS || '/auth/me,/candidates?page=1&pageSize=25,/requirements?page=1&pageSize=25,/clients,/ats/interviews?page=1,/notifications?limit=20').split(',');
const stats = new Map(PATHS.map((p) => [p, { ok: 0, err: 0, times: [] }]));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function user(i, until) {
  let k = i;
  while (Date.now() < until) {
    const p = PATHS[k % PATHS.length]; k += 1;
    const t = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(API + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
      // eslint-disable-next-line no-await-in-loop
      await r.arrayBuffer();
      const s = stats.get(p);
      s.times.push(Date.now() - t);
      if (r.status >= 500 || r.status === 429) s.err += 1; else s.ok += 1;
    } catch { stats.get(p).err += 1; }
  }
}

(async () => {
  console.log(`load test: ${USERS} users at once for ${SECONDS}s against ${API}`);
  const start = Date.now(); const until = start + SECONDS * 1000;
  await Promise.all(Array.from({ length: USERS }, (_, i) => user(i, until)));
  const secs = (Date.now() - start) / 1000;
  let all = []; let ok = 0; let err = 0;
  console.log('\nendpoint | requests | errors | p50 ms | p95 ms | p99 ms');
  for (const [p, s] of stats) {
    all = all.concat(s.times); ok += s.ok; err += s.err;
    console.log(`${p} | ${s.ok + s.err} | ${s.err} | ${pct(s.times, 50)} | ${pct(s.times, 95)} | ${pct(s.times, 99)}`);
  }
  const summary = { users: USERS, seconds: Math.round(secs), requests: ok + err, perSecond: Math.round((ok + err) / secs), errors: err, errorPct: Math.round((err / Math.max(1, ok + err)) * 1000) / 10, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99) };
  console.log(`\nTOTAL ${JSON.stringify(summary)}`);
})();
