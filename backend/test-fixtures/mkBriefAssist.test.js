// AI Marketing: the AI writes THE BRIEF of a client request from the client and the topic (marketing/projects.js briefAssist).
//   node backend/test-fixtures/mkBriefAssist.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-brief-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const Cfg = require('../src/marketing/settings');
const SA = require('../src/utils/socialAccounts');
const Pub = require('../src/marketing/publisher');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const SITE = 'https://example-teamlink.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// stand-ins: every account id is "connected" except 'gone'; the publisher only records what it was asked to post
SA.withToken = async (id) => (id === 'gone' ? null : { account: { platform: 'facebook', name: `Page ${id}` }, token: 't' });
const posted = [];
Pub.publish = async (targets, media, caption) => { posted.push({ targets, media, caption }); return targets.map((t) => ({ accountId: t.accountId, ok: true, name: t.name, platform: t.platform, url: `https://facebook.test/${t.accountId}` })); };

const allow = async (autoPostAllowed) => Cfg.saveSettings({ ...(await Cfg.getSettings()), autoPostAllowed });
const kinds = async (id) => (await S.q('SELECT kind FROM "OmniMkProjectEvent" WHERE projectId = ? ORDER BY at ASC', id)).map((x) => x.kind);
const stateOf = async (id) => (await P.get(admin, id)).project;
async function makeItem(title) {
  const id = S.newId('im'); const file = `${id}.png`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', file), PNG);
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, title, 'p', 'photo', '1:1', file, 'image/png', PNG.length, 'draft', admin.id, admin.name, Date.now(), Date.now());
  return id;
}
// a project with one option, accepted and ready to send (no phone and no email: nothing is ever sent to a person)
async function ready(clientName) {
  const r = await P.create(admin, { clientName, occasion: 'Diwali offer', brief: 'A Diwali offer poster for our sweet shop', deliverable: 'image', platforms: ['facebook'] });
  assert.ok(r.project, JSON.stringify(r));
  const id = r.project.id;
  assert.ok((await P.accept(admin, id)).ok);
  assert.ok((await P.setOptions(admin, id, { items: [{ itemId: await makeItem('pic') }] })).ok);
  return id;
}
const send = async (id, body = {}) => { const out = await P.send(admin, id, body, SITE); assert.ok(out.ok, JSON.stringify(out)); return stateOf(id); };
const approve = async (id, comment = '') => {
  const opt = (await P.get(admin, id)).options.find((o) => o.stage === 'presented');
  const out = await P.clientApprove(P.tokenOf(id), { optionId: opt.id, name: 'Ravi Kumar', comment, via: 'test' });
  assert.ok(out.ok, JSON.stringify(out));
};
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  await require('../src/marketing/images').ensure(); await P.ensure();
  const AI = require('../src/marketing/ai');
  await AI.ensure();
  const setLimits = async (v) => Cfg.saveSettings({ ...(await Cfg.getSettings()), ...v });
  await setLimits({ aiDailyPerUser: 200, aiMonthlyCap: 0 });
  const asks = (over = {}) => ({ clientName: 'Rao Hospital', occasion: 'Doctors Day wishes', deliverable: 'both', platforms: ['facebook', 'instagram'], brief: '', ...over });

  // 1. it needs the client and the topic
  let r = await P.briefAssist(admin, asks({ clientName: '' })); assert.equal(r.status, 400); assert.ok(/company name/i.test(r.error), r.error);
  r = await P.briefAssist(admin, asks({ occasion: ' ' })); assert.equal(r.status, 400); assert.ok(/what it is for/i.test(r.error), r.error);
  console.log('PASS it asks for the client and the topic first');

  // 2. a login that may not use AI Marketing is refused
  r = await P.briefAssist({ id: 'u-none', name: 'Nobody', role: 'CANDIDATE' }, asks()); assert.equal(r.status, 403);
  console.log('PASS a login without AI Marketing is refused');

  // 3. in the test sandbox the answer is the marked sample, never passed off as AI
  r = await P.briefAssist(admin, asks());
  assert.ok(r.brief && /^SAMPLE/.test(r.brief) && r.brief.includes('Rao Hospital') && r.brief.includes('Doctors Day wishes') && r.demo === true, JSON.stringify(r));
  console.log('PASS sandbox: a clearly marked sample from the same client and topic');

  // 4. the real model path (a stand-in model that records what it was asked)
  const seen = []; let answer = { brief: '**Rao Hospital** would like a warm Doctors Day greeting.\nShow gratitude, no offers. Date and hospital logo: to be confirmed with the client.' };
  AI.register('text', { id: 'stub', usable: () => true, async status() { return { ready: true, provider: 'stub', model: 'stub-1', reason: '' }; }, async json(system, prompt, lim) { seen.push({ system, prompt, lim }); if (typeof answer === 'function') return answer(); return answer; } });
  AI.register('text', { id: 'demo', usable: () => false, async status() { return { ready: true, provider: 'demo', model: 'x', reason: '' }; } }); // the sample writer steps aside
  await Cfg.saveBrand({ ...(await Cfg.getBrand()), brandName: 'TeamLink Digital', tone: 'Friendly', avoidWords: ['cheap'], language: 'English' }, admin);
  r = await P.briefAssist(admin, asks());
  assert.ok(r.brief && !r.demo && r.provider === 'stub', JSON.stringify(r));
  assert.ok(!r.brief.includes('**'), 'markdown is removed'); assert.ok(r.brief.startsWith('Rao Hospital would like'), r.brief);
  const q = seen[0];
  for (const t of ['Client (company): Rao Hospital', 'What it is for: Doctors Day wishes', 'They want: a video and pictures', 'To be posted on: Facebook, Instagram']) assert.ok(q.prompt.includes(t), `the prompt lacks "${t}": ${q.prompt}`);
  assert.ok(q.system.includes('TeamLink Digital') && q.system.includes('Friendly') && q.system.includes('Never use these words: cheap'), q.system);
  assert.ok(/NEVER invent prices/.test(q.system) && /to be confirmed with the client/.test(q.system), 'the no-invented-facts rule is in the instructions');
  assert.ok(!q.prompt.includes('already wrote'), 'nothing was typed, so no earlier text is sent');
  console.log('PASS model path: the prompt carries the client, the topic, what they want, where it is posted and the brand rules; markdown is removed');

  // 5. what the team already typed is sent to be kept and completed
  r = await P.briefAssist(admin, asks({ brief: 'Use the new logo. Hospital opening hours 9 to 5.' }));
  assert.ok(seen[1].prompt.includes('already wrote this (keep its facts, complete and improve it):\nUse the new logo. Hospital opening hours 9 to 5.'), seen[1].prompt);
  console.log('PASS the team\'s own words are sent to be kept and completed');

  // 6. a word the brand avoids is flagged (not silently dropped)
  answer = { brief: 'Rao Hospital wants a cheap looking greeting. Message to be confirmed with the client.' };
  r = await P.briefAssist(admin, asks()); assert.deepEqual(r.flags, ['cheap']);
  console.log('PASS words the brand avoids are flagged');

  // 7. an empty or unreadable answer is an error in words, nothing is filled in
  answer = { brief: 'ok' }; r = await P.briefAssist(admin, asks()); assert.equal(r.status, 502); assert.ok(r.error && !r.brief);
  answer = () => { throw new AI.AiMkError('The AI model did not answer.', 503, 'failed'); }; r = await P.briefAssist(admin, asks()); assert.equal(r.status, 503); assert.ok(/did not answer/.test(r.error));
  console.log('PASS an empty or failed answer is an error, nothing is filled in');

  // 8. each call is logged as a "projects / brief" request, and the person's daily limit applies
  const rows = await S.q('SELECT module, task, ok FROM "OmniMkAiUsage" WHERE module = ? AND task = ?', 'projects', 'brief');
  assert.ok(rows.length >= 5 && rows.some((x) => S.num(x.ok) === 1) && rows.some((x) => S.num(x.ok) === 0), JSON.stringify(rows.length));
  answer = { brief: 'Rao Hospital wants a warm greeting. Details to be confirmed with the client.' };
  const lim = { id: 'u-limit', name: 'Limit Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; // a person of their own, so the one-minute counter of the other calls does not count
  await setLimits({ aiDailyPerUser: 0 }); r = await P.briefAssist(lim, asks()); assert.equal(r.status, 403); assert.ok(/switched off/i.test(r.error), r.error);
  await setLimits({ aiDailyPerUser: 1 }); r = await P.briefAssist(lim, asks()); assert.ok(r.brief, JSON.stringify(r));
  r = await P.briefAssist(lim, asks()); assert.equal(r.status, 429); assert.ok(/AI requests for today/.test(r.error), r.error);
  // and a flood in one minute is stopped by the shared rate limit
  await setLimits({ aiDailyPerUser: 200 }); const flood = { id: 'u-flood', name: 'Flood Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; let blocked = null;
  for (let i = 0; i < 12 && !blocked; i += 1) { const x = await P.briefAssist(flood, asks()); if (x.error) blocked = x; } // eslint-disable-line no-await-in-loop
  assert.ok(blocked && blocked.status === 429 && /Too many AI requests in one minute/.test(blocked.error), JSON.stringify(blocked));
  console.log('PASS logged as projects/brief; the off switch, the daily limit and the one-minute limit apply');

  // 9. the AI gets 40 seconds (the web server gives up at 60) and a miss is said in words, not as a gateway error
  assert.equal(seen[0].lim && seen[0].lim.timeoutMs, 40000, 'the model is asked to answer within 40 seconds');
  const rate = { id: 'u-slow', name: 'Slow Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
  answer = () => { throw new AI.AiMkError('The local AI took too long to answer.', 504, 'timeout'); };
  r = await P.briefAssist(rate, asks()); assert.equal(r.status, 504); assert.equal(r.code, 'timeout'); assert.ok(/The AI is slow right now\. Try again in a moment, or write the brief yourself\./.test(r.error), r.error); assert.ok(!r.brief);
  console.log('PASS the AI gets 40 seconds and a miss is a plain message');

  console.log('mkBriefAssist: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
