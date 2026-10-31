#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A JOB GOES TO EVERY CONNECTED SOCIAL ACCOUNT (founder 2026-10-31: "social media lo anni accounts ki post avvali").
// No database and nothing real: a local fake Threads API, the account list and the AppSetting store are stand-ins in memory.
//   node scripts/job-social-accounts-test.js
//   1. Post: the default account AND every other connected account get the job; an expired account is left out
//   2. Post again: nothing is sent twice
//   3. An account connected later gets the job on the next Post (only that one)
//   4. Dry run: lists the accounts, sends nothing
//   5. One account failing (bad token) is said by name; the others still get it
//   6. Telegram (no extra accounts) is unchanged
// ---------------------------------------------------------------------------
const path = require('path');
const http = require('http');

const BACK = path.resolve(__dirname, '..');
let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };

// ---- stand-ins: the database (AppSetting only) and the social account list ----
const store = new Map();
const fakeDb = {
  appSetting: {
    findUnique: async ({ where }) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null),
    upsert: async ({ where, update, create }) => { store.set(where.key, (store.has(where.key) ? update : create).value); return {}; },
  },
};
const stub = (rel, exp) => { const p = require.resolve(path.join(BACK, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('src/db', fakeDb);
let accounts = [];
stub('src/utils/socialAccounts', { readAll: async () => accounts, tokenOf: (a) => a.token || '' });
stub('src/jobPublish/settings', { get: async () => null });

const posts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const f = new URLSearchParams(body);
    const token = f.get('access_token');
    const acc = decodeURIComponent(req.url.split('/')[1] || '');
    res.setHeader('Content-Type', 'application/json');
    if (token === 'bad') { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } })); return; }
    if (req.url.endsWith('/threads')) { res.end(JSON.stringify({ id: `c-${acc}` })); return; }
    if (req.url.endsWith('/threads_publish')) { posts.push(acc); res.end(JSON.stringify({ id: `p-${acc}-${posts.length}` })); return; }
    res.statusCode = 404; res.end('{}');
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TL_THREADS_GRAPH_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.TL_API_STRICT_LOCAL = '1';
  const Threads = require(path.join(BACK, 'src/portals/threads/ThreadsAdapter'));
  const log = { info: async () => {}, error: async () => {} };
  const make = () => {
    const a = new Threads({ portal: 'threads', creds: { username: 'main', password: 't-main' }, log, ctx: {} });
    a.kit = async () => ({ text: 'Staff Nurse job in Hyderabad. Apply: https://x/j/1', chars: 48 });
    return a;
  };
  accounts = [
    { id: 'A', platform: 'threads', externalId: 'main', isDefault: true, name: 'TeamLink Jobs', token: 't-main' },
    { id: 'B', platform: 'threads', externalId: 'acc2', isDefault: false, name: 'TeamLink Careers', token: 't2' },
    { id: 'C', platform: 'threads', externalId: 'acc3', isDefault: false, name: 'TeamLink Hyderabad', token: 't3' },
    { id: 'D', platform: 'threads', externalId: 'acc4', isDefault: false, name: 'Old profile', token: 't4', expiresAt: '2020-01-01T00:00:00Z' },
    { id: 'E', platform: 'facebook', externalId: 'page9', isDefault: false, name: 'A Facebook Page', token: 'p9' },
  ];

  const r1 = await make().run('PUBLISH', {}, { requirementId: 'R1' });
  check('S1 Post: the default account and every other connected Threads account get the job', r1.ok && posts.join(',') === 'main,acc2,acc3', posts);
  check('S2 ...the expired account and other platforms are left out', !posts.includes('acc4') && !posts.includes('page9'), posts);
  check('S3 ...the note names the extra accounts', /Also posted to 2 more accounts: TeamLink Careers, TeamLink Hyderabad/.test(r1.note), r1.note);
  check('S4 ...each account result is returned', Array.isArray(r1.accounts) && r1.accounts.length === 2 && r1.accounts.every((x) => x.ok && x.postId), r1.accounts);

  const before = posts.length;
  const r2 = await make().run('PUBLISH', { live: true, portalJobId: r1.portalJobId }, { requirementId: 'R1' });
  check('S5 Post again: nothing is sent twice', r2.ok && r2.alreadyPosted && posts.length === before, [posts.length, before, r2.note]);

  accounts.push({ id: 'F', platform: 'threads', externalId: 'acc5', isDefault: false, name: 'New profile', token: 't5' });
  const r3 = await make().run('PUBLISH', { live: true, portalJobId: r1.portalJobId }, { requirementId: 'R1' });
  check('S6 An account connected later gets the job on the next Post (only that one)', posts.slice(before).join(',') === 'acc5' && /Also posted to 1 more account: New profile/.test(r3.note), [posts.slice(before), r3.note]);

  const n = posts.length;
  const r4 = await make().run('PUBLISH', {}, { requirementId: 'R2', dryRun: true });
  check('S7 Dry run: lists the accounts and sends nothing', r4.dryRun && posts.length === n && /would also go to 3 more accounts/.test(r4.note), r4.note);

  accounts.find((a) => a.id === 'C').token = 'bad';
  const r5 = await make().run('PUBLISH', {}, { requirementId: 'R3' });
  check('S8 One account failing is said by name; the others still get it', r5.ok && /Not done on TeamLink Hyderabad/.test(r5.note) && /Also posted to 2 more accounts/.test(r5.note), r5.note);
  check('S9 The token never shows in the note', !/t-main|t2|t5|access_token=/.test(r5.note), r5.note);

  const Tg = require(path.join(BACK, 'src/portals/telegram/TelegramAdapter'));
  const tg = new Tg({ portal: 'telegram', creds: { username: '@c', password: 'x' }, log, ctx: {} });
  check('S10 Telegram has no extra accounts (unchanged)', (await tg.otherAccounts()).length === 0);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
