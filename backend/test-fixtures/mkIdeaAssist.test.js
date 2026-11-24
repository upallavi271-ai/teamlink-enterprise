// AI Marketing: "✨ AI Assist" on the YOUR IDEA OR CONCEPT box (AI Images and AI Video): the AI writes the idea from the title (marketing/ideaAssist.js).
//   node backend/test-fixtures/mkIdeaAssist.test.js     (throw-away copy of prisma/sandbox.db; the AI model is a stand-in: nothing is sent to any AI service)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-idea-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const Cfg = require('../src/marketing/settings');
const { ideaAssist } = require('../src/marketing/ideaAssist');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  await require('../src/marketing/images').ensure(); await P.ensure();
  const AI = require('../src/marketing/ai');
  await AI.ensure();
  const setLimits = async (v) => Cfg.saveSettings({ ...(await Cfg.getSettings()), ...v });
  await setLimits({ aiDailyPerUser: 200, aiMonthlyCap: 0 });

  // 1. it needs a topic: a title, or a few words in the box
  let r = await ideaAssist(admin, { kind: 'video' }); assert.equal(r.status, 400); assert.ok(/title first/i.test(r.error), r.error);
  r = await ideaAssist(admin, { kind: 'post', title: ' ', idea: 'ab' }); assert.equal(r.status, 400);
  console.log('PASS it asks for a title (or a few words) first');

  // 2. a login that may not use AI Marketing is refused
  r = await ideaAssist({ id: 'u-none', name: 'Nobody', role: 'CANDIDATE' }, { kind: 'video', title: 'Hiring freshers' }); assert.equal(r.status, 403);
  console.log('PASS a login without AI Marketing is refused');

  // 3. in the test sandbox the answer is the marked sample, never passed off as AI
  r = await ideaAssist(admin, { kind: 'video', title: 'Hiring freshers' });
  assert.ok(r.idea && /^SAMPLE/.test(r.idea) && r.idea.includes('Hiring freshers') && r.demo === true, JSON.stringify(r));
  console.log('PASS sandbox: a clearly marked sample from the same title');

  // 4. the real model path (a stand-in model that records what it was asked)
  const seen = []; let answer = { idea: '"**A friendly hiring post** for freshers.\nStaffing consultancy, join us, apply today."' };
  AI.register('text', { id: 'stub', usable: () => true, async status() { return { ready: true, provider: 'stub', model: 'stub-1', reason: '' }; }, async json(system, prompt, lim) { seen.push({ system, prompt, lim }); if (typeof answer === 'function') return answer(); return answer; } });
  AI.register('text', { id: 'demo', usable: () => false, async status() { return { ready: true, provider: 'demo', model: 'x', reason: '' }; } }); // the sample writer steps aside
  await Cfg.saveBrand({ ...(await Cfg.getBrand()), brandName: 'TeamLink Digital', tone: 'Friendly', avoidWords: ['cheap'], language: 'English' }, admin);
  r = await ideaAssist(admin, { kind: 'video', title: 'Hiring freshers', heading: 'We are hiring', content: 'Freshers welcome', clientName: 'Rao Hospital' });
  assert.ok(r.idea && !r.demo && r.provider === 'stub', JSON.stringify(r));
  assert.equal(r.idea, 'A friendly hiring post for freshers. Staffing consultancy, join us, apply today.', 'markdown, quotes and line breaks are removed');
  const q = seen[0];
  for (const t of ['Title: Hiring freshers', 'Heading: We are hiring', 'Content the person wrote: Freshers welcome', 'It is for: Rao Hospital', 'They want: a short video']) assert.ok(q.prompt.includes(t), `the prompt lacks "${t}": ${q.prompt}`);
  assert.ok(q.system.includes('a short video') && q.system.includes('Never use these words: cheap') && /NEVER invent prices/.test(q.system), q.system);
  assert.ok(!q.prompt.includes('already wrote'), 'nothing was typed in the box, so no earlier text is sent');
  assert.equal(q.lim.timeoutMs, 40000, 'the AI gets 40 seconds, under the web server limit');
  r = await ideaAssist(admin, { kind: 'post', title: 'Republic Day' }); assert.ok(seen[1].prompt.includes('They want: a picture post') && seen[1].system.includes('a picture post'), seen[1].prompt);
  console.log('PASS model path: video and picture post, the prompt carries the title, heading, content and client; markdown and quotes are removed; the 40 second limit is set');

  // 5. what is already in the box is kept and improved (a title is not needed then)
  r = await ideaAssist(admin, { kind: 'video', idea: 'Walk-in drive on Saturday for nurses' });
  assert.ok(r.idea && seen[2].prompt.includes('already wrote this in the idea box (keep its facts, improve and complete it):\nWalk-in drive on Saturday for nurses'), seen[2].prompt);
  console.log('PASS the words already in the box are sent to be kept and improved');

  // 6. a client project: its client and brief are used, and the client is who it is for; no title needed
  const made = await P.create(admin, { clientName: 'Sunrise Dental', occasion: 'Free check-up camp', brief: 'A free dental check-up camp on Sunday at our clinic. Show a smiling family.', deliverable: 'image', platforms: ['facebook'] });
  assert.ok(made.project, JSON.stringify(made));
  r = await ideaAssist(admin, { kind: 'post', projectId: made.project.id });
  assert.ok(r.idea, JSON.stringify(r));
  const pq = seen[3];
  for (const t of ['Client project: Sunrise Dental, Free check-up camp', "The client's brief: A free dental check-up camp on Sunday", 'It is for: Sunrise Dental']) assert.ok(pq.prompt.includes(t), `the prompt lacks "${t}": ${pq.prompt}`);
  assert.ok(!/About the company/.test(pq.system), 'the client, not our company, is the brand');
  r = await ideaAssist(admin, { kind: 'post', projectId: 'prj-does-not-exist' }); assert.equal(r.status, 400, 'an unknown project is just "no topic"');
  console.log('PASS a client project: its client and brief are used and no title is needed; an unknown project is a plain "type a title"');

  // 7. a word the brand avoids is flagged (not silently dropped)
  answer = { idea: 'A cheap looking hiring post for freshers, simple and warm.' };
  r = await ideaAssist(admin, { kind: 'video', title: 'Hiring freshers' }); assert.deepEqual(r.flags, ['cheap']);
  console.log('PASS words the brand avoids are flagged');

  // 8. an empty, failed or slow answer is an error in words, nothing is filled in
  const err = { id: 'u-err', name: 'Error Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; // a person of their own, so the one-minute counter of the calls above does not count
  answer = { idea: 'ok' }; r = await ideaAssist(err, { kind: 'video', title: 'Hiring freshers' }); assert.equal(r.status, 502); assert.ok(r.error && !r.idea);
  answer = () => { throw new AI.AiMkError('The AI model did not answer.', 503, 'failed'); }; r = await ideaAssist(err, { kind: 'video', title: 'Hiring freshers' }); assert.equal(r.status, 503); assert.ok(/did not answer/.test(r.error));
  answer = () => { throw new AI.AiMkError('timed out', 504, 'timeout'); }; r = await ideaAssist(err, { kind: 'video', title: 'Hiring freshers' }); assert.equal(r.status, 504); assert.ok(/slow right now/.test(r.error), r.error);
  console.log('PASS an empty, failed or slow answer is an error in words, nothing is filled in');

  // 9. each call is logged as a "studio / idea" request, and the person's daily and one-minute limits apply
  const rows = await S.q('SELECT module, task, ok FROM "OmniMkAiUsage" WHERE module = ? AND task = ?', 'studio', 'idea');
  assert.ok(rows.length >= 6 && rows.some((x) => S.num(x.ok) === 1) && rows.some((x) => S.num(x.ok) === 0), JSON.stringify(rows.length));
  answer = { idea: 'A warm hiring post for freshers, friendly and simple.' };
  const lim = { id: 'u-limit', name: 'Limit Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; // a person of their own, so the one-minute counter of the other calls does not count
  await setLimits({ aiDailyPerUser: 0 }); r = await ideaAssist(lim, { kind: 'video', title: 'Hiring' }); assert.equal(r.status, 403); assert.ok(/switched off/i.test(r.error), r.error);
  await setLimits({ aiDailyPerUser: 1 }); r = await ideaAssist(lim, { kind: 'video', title: 'Hiring' }); assert.ok(r.idea, JSON.stringify(r));
  r = await ideaAssist(lim, { kind: 'video', title: 'Hiring' }); assert.equal(r.status, 429); assert.ok(/AI requests for today/.test(r.error), r.error);
  await setLimits({ aiDailyPerUser: 200 }); const flood = { id: 'u-flood', name: 'Flood Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; let blocked = null;
  for (let i = 0; i < 12 && !blocked; i += 1) { const x = await ideaAssist(flood, { kind: 'video', title: 'Hiring' }); if (x.error) blocked = x; } // eslint-disable-line no-await-in-loop
  assert.ok(blocked && blocked.status === 429 && /Too many AI requests in one minute/.test(blocked.error), JSON.stringify(blocked));
  console.log('PASS logged as studio/idea; the off switch, the daily limit and the one-minute limit apply');

  console.log('idea assist tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
