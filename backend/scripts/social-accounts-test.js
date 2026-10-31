// Social Media accounts (utils/socialAccounts.js, 2026-10-31): many Facebook Pages, their Instagram accounts, Threads profiles, one default
// each - with a stand-in Facebook / Threads server, on a COPY of the database (dev.db itself is never used):
//   node scripts/social-accounts-test.js <copy.db>      (make the copy with VACUUM INTO)
const path = require('path');
const B = path.resolve(__dirname, '..').split(path.sep).join('/');
require(`${B}/node_modules/dotenv`).config({ path: `${B}/.env` });
if (!process.argv[2] || /dev\.db$/.test(process.argv[2])) { console.error('Give a COPY of the database'); process.exit(2); }
process.env.DATABASE_URL = `file:${process.argv[2]}`;
const http = require('http');

// stand-in Graph: Page A has Instagram, Page B none, Page C (another login) has Instagram; Threads accepts "TH-good..." tokens
const IG = { 'page-a': { id: 'ig-a', username: 'teamlink_a', name: 'TeamLink A' }, 'page-c': { id: 'ig-c', username: 'teamlink_c', name: 'TeamLink C' } };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  const tok = u.searchParams.get('access_token') || '';
  if (u.pathname === '/threads/me') {
    if (!tok.startsWith('TH-good')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token' } })); }
    return res.end(JSON.stringify({ id: `th-${tok.slice(-3)}`, username: `tl_${tok.slice(-3)}` }));
  }
  const page = u.pathname.replace(/^\/fb\//, '');
  if (!tok.startsWith('tok-')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'bad page token' } })); }
  return res.end(JSON.stringify(IG[page] ? { id: page, instagram_business_account: IG[page] } : { id: page }));
});

(async () => {
  await new Promise((r) => srv.listen(48911, '127.0.0.1', r));
  process.env.TL_FACEBOOK_GRAPH_BASE = 'http://127.0.0.1:48911/fb';
  process.env.TL_THREADS_GRAPH_BASE = 'http://127.0.0.1:48911/threads';
  const prisma = require(`${B}/src/db`);
  const SA = require(`${B}/src/utils/socialAccounts`);
  const { readConfig } = require(`${B}/src/utils/integrationStore`);
  await prisma.appSetting.deleteMany({ where: { key: 'social.accounts' } });
  const user = { id: 'u1', name: 'Tester' };
  let pass = 0; let fail = 0;
  const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (c) pass += 1; else fail += 1; };
  const saved = [];
  const saveFacebook = async (u, page) => { saved.push(page); return { ok: true, words: 'ok' }; };

  // a fresh list (whatever the copy had as an old single connection may be adopted; start from what list() says)
  const before = await SA.list();
  const fb0 = before.facebook.length;

  const r1 = await SA.addFacebookPages(user, [{ id: 'page-a', name: 'Page A', token: 'tok-a' }, { id: 'page-b', name: 'Page B', token: 'tok-b' }]);
  ok('two Pages connected at once', r1.added.length === 2);
  ok('the Instagram account linked to Page A is found by itself', r1.instagram.length === 1 && r1.instagram[0].username === 'teamlink_a');
  ok('Page B is reported as having no Instagram', r1.instagramMissing.some((x) => /Page B/.test(x)));
  if (r1.needDefault) await SA.setDefault(user, r1.firstId, { saveFacebook });
  let l = await SA.list();
  ok('exactly one default Facebook Page', l.facebook.filter((a) => a.isDefault).length === 1);
  ok('the screen list carries no token', !JSON.stringify(l).includes('tok-') && !JSON.stringify(l).includes('tokenEnc'));

  const r2 = await SA.addFacebookPages(user, [{ id: 'page-c', name: 'Page C (other login)', token: 'tok-c' }], { viaLogin: 'other' });
  l = await SA.list();
  ok('a Page from another Facebook login is added, the default stays', l.facebook.length === fb0 + 3 && !r2.needDefault);
  ok('two Instagram accounts now, one default', l.instagram.length === 2 && l.instagram.filter((a) => a.isDefault).length === 1);

  const c = l.facebook.find((a) => a.externalId === 'page-c');
  saved.length = 0;
  const d = await SA.setDefault(user, c.id, { saveFacebook });
  l = await SA.list();
  ok('making Page C the default goes through the old one-Page save with its own token', d.ok && saved.length === 1 && saved[0].id === 'page-c' && saved[0].access_token === 'tok-c');
  ok('Page C is the only default now', l.facebook.filter((a) => a.isDefault).map((a) => a.externalId).join() === 'page-c');

  const a = l.facebook.find((x) => x.externalId === 'page-a');
  const rm = await SA.remove(user, a.id);
  l = await SA.list();
  ok('removing Page A takes its Instagram account with it', rm.removed === 2 && !l.instagram.some((x) => x.username === 'teamlink_a'));
  const rmc = await SA.remove(user, c.id);
  ok('removing the default Page names the next one to become default', rmc.wasDefault && !!rmc.nextDefault);

  const th1 = await SA.addThreads(user, 'TH-good-token-0000000xx1');
  ok('a Threads profile is checked and added; the first one should become default', th1.ok && th1.account.name === '@tl_xx1' && th1.makeDefault);
  await SA.setDefault(user, th1.account.id, {});
  const cfg = await readConfig('social');
  ok('the default Threads token is written where Omni-Channel reads it', cfg.values['Threads access token'] === 'TH-good-token-0000000xx1' && cfg.values['Threads profile'] === '@tl_xx1');
  const th2 = await SA.addThreads(user, 'TH-good-token-0000000xx2');
  ok('a second Threads profile is added without taking the default', th2.ok && !th2.makeDefault);
  const bad = await SA.addThreads(user, 'TH-bad-token-zzzzzzzzzz');
  ok('a token Threads refuses is refused in words', bad.error && /did not accept/.test(bad.error));
  l = await SA.list();
  ok('two Threads profiles, one default', l.threads.length === 2 && l.threads.filter((x) => x.isDefault).length === 1);

  // Edit: rename, a new token that belongs to the same account, a token of another account refused
  const th = (await SA.list()).threads.find((x) => x.isDefault);
  const e1 = await SA.edit(user, th.id, { name: 'Jobs on Threads' });
  ok('Edit renames an account', e1.ok && e1.account.name === 'Jobs on Threads' && !e1.tokenChanged);
  const e2 = await SA.edit(user, th.id, { name: 'Jobs on Threads', token: 'TH-good-token-9999999xx1' });
  const cfg2 = await readConfig('social');
  ok('Edit with a new token of the same profile saves it, and the default reaches Omni-Channel', e2.ok && e2.tokenChanged && cfg2.values['Threads access token'] === 'TH-good-token-9999999xx1');
  const e3 = await SA.edit(user, th.id, { token: 'TH-good-token-0000000xx2' });
  ok('Edit refuses a token of another profile', e3.error && /another Threads profile/.test(e3.error));
  const e4 = await SA.edit(user, th.id, { name: '   ' });
  ok('Edit refuses an empty name', e4.error && /Type a name/.test(e4.error));
  const ri = await SA.refreshInstagram(user);
  ok('Find Instagram again checks every remaining Page', typeof ri.found === 'number');

  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  srv.close(); await prisma.$disconnect(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
