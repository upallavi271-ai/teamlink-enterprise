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
  let r = await ideaAssist(admin, { kind: 'video' }); assert.equal(r.status, 400); assert.ok(/title or some content first/i.test(r.error), r.error);
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
  assert.equal(r.idea, 'Topic: A friendly hiring post for freshers\nPoints:\n- Staffing consultancy, join us, apply today\n- Freshers welcome', 'markdown and quotes are removed; a paragraph answer is laid out as Topic / Points, the missing point comes from the content the person wrote');
  const q = seen[0];
  for (const t of ['Title: Hiring freshers', 'Heading: We are hiring', 'Content the person wrote:\nFreshers welcome', 'It is for: Rao Hospital', 'They want: a short video']) assert.ok(q.prompt.includes(t), `the prompt lacks "${t}": ${q.prompt}`);
  for (const t of ['Topic:', 'Points:', 'Mood:', 'Call to action:', 'BASE the topic and the points on that content', '5 to 8 short lines']) assert.ok(q.system.includes(t), `the instructions lack "${t}": ${q.system}`);
  assert.ok(q.system.includes('a short video') && q.system.includes('Never use these words: cheap') && /NEVER invent prices/.test(q.system), q.system);
  assert.ok(!q.prompt.includes('already wrote'), 'nothing was typed in the box, so no earlier text is sent');
  assert.equal(q.lim.timeoutMs, 40000, 'the AI gets 40 seconds, under the web server limit');
  r = await ideaAssist(admin, { kind: 'post', title: 'Republic Day' }); assert.ok(seen[1].prompt.includes('They want: a picture post') && seen[1].system.includes('a picture post'), seen[1].prompt);
  console.log('PASS model path: video and picture post, the prompt carries the title, heading, content and client; markdown and quotes are removed; the 40 second limit is set');

  // 4b. SEVERAL lines (owner, 24 Nov): the topic and the points, built from the CONTENT the person wrote; bullets of any kind become "- ", markdown and stray quotes go, line breaks stay
  const longContent = `${'Scene 1: Is your skin troubling you? Acne, pigmentation or hair fall. '.repeat(10)}\nScene 2: A dermatologist explains the cause.\nLAST-LINE-OF-CONTENT-MARKER`;
  answer = { idea: '**Topic:** A skin care explainer video for people troubled by acne.\n**Points:**\n• Acne has simple causes\n* Pigmentation can be treated\n1. See a dermatologist early\nMood: calm and caring\n\n\nCall to action: Book a visit' };
  const sk = { id: 'u-multi', name: 'Multi Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
  r = await ideaAssist(sk, { kind: 'video', title: 'Skin care', content: longContent });
  assert.equal(r.idea, 'Topic: A skin care explainer video for people troubled by acne.\nPoints:\n- Acne has simple causes\n- Pigmentation can be treated\n- See a dermatologist early\nMood: calm and caring\nCall to action: Book a visit', r.idea);
  assert.ok(r.idea.split('\n').length >= 6, 'several lines, not one');
  assert.ok(seen[seen.length - 1].prompt.includes('LAST-LINE-OF-CONTENT-MARKER') && seen[seen.length - 1].prompt.includes('Scene 2: A dermatologist explains the cause.\nLAST-LINE'), 'the whole content (up to 1200 characters, line by line) is sent, not just its first 300');
  answer = { idea: ['Topic: A short video about walk-in interviews.', 'Points:', '- Bring your CV', '- Come to our office'] }; r = await ideaAssist(sk, { kind: 'video', title: 'Walk-in' });
  assert.equal(r.idea, 'Topic: A short video about walk-in interviews.\nPoints:\n- Bring your CV\n- Come to our office', 'a list of lines is accepted');
  answer = { idea: { topic: 'A post about resume tips for job seekers', points: ['Keep it to one page', 'Use clear headings'], mood: 'helpful and simple', cta: 'Send your CV today' } }; r = await ideaAssist(sk, { kind: 'post', title: 'Resume tips' });
  assert.equal(r.idea, 'Topic: A post about resume tips for job seekers\nPoints:\n- Keep it to one page\n- Use clear headings\nMood: helpful and simple\nCall to action: Send your CV today', 'an answer given as topic / points / mood / cta is laid out the same way');
  answer = { idea: `Topic: ${'A long topic sentence. '.repeat(8)}\nPoints:\n${Array.from({ length: 12 }, (_, i) => `- Point number ${i + 1} ${'with some detail '.repeat(3)}`).join('\n')}\nMood: calm` };
  r = await ideaAssist(sk, { kind: 'video', title: 'Long answer' });
  assert.ok(r.idea.length <= 780 && r.idea.startsWith('Topic:') && !r.idea.endsWith('Mood: calm') && /\n- Point number \d+ with some detail with some detail with some detail$/.test(r.idea), `too long answers are cut at a whole line: ${r.idea.length} ${JSON.stringify(r.idea.slice(-60))}`);
  // 4c. the model answered in ONE PARAGRAPH (what the live server's small model did on 24 Nov): it is laid out as Topic / Points, never handed back as one line
  answer = { idea: 'At TeamLink, we connect freshers with growing companies. We offer training and a supportive environment. Our goal is to help you grow in your career. Send your CV today.' };
  const sk2 = { id: 'u-multi2', name: 'Layout Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; // a person of their own: the one-minute counter of the calls above does not count
  r = await ideaAssist(sk2, { kind: 'video', title: 'Hiring freshers', content: 'Freshers welcome\nSend your CV today' });
  assert.equal(r.idea, 'Topic: At TeamLink, we connect freshers with growing companies\nPoints:\n- We offer training and a supportive environment\n- Our goal is to help you grow in your career\n- Send your CV today', r.idea);
  assert.ok(r.idea.split('\n').length >= 5, 'a paragraph becomes several lines');
  answer = { idea: 'A friendly hiring video for freshers.' }; // one sentence only: the points come from the voice-over lines of the pasted script
  r = await ideaAssist(sk2, { kind: 'video', title: 'Hiring freshers', content: '**Scene 1 – Intro**\nVisual: a recruiter in an office\nVoiceover: "Are you a fresher looking for your first job?"\n**Scene 2 – Offer**\nVisual: graduates in training\nVoiceover: "We connect freshers with growing companies."\n**Scene 3 – Action**\nVisual: a CV on a laptop\nText on screen: Send your CV today' });
  assert.equal(r.idea, 'Topic: A friendly hiring video for freshers\nPoints:\n- Are you a fresher looking for your first job\n- We connect freshers with growing companies\n- Send your CV today', r.idea);
  answer = { idea: 'Topic: Already laid out\nPoints:\n- One\n- Two\nMood: calm' }; r = await ideaAssist(sk2, { kind: 'video', title: 'Hiring freshers' });
  assert.equal(r.idea, 'Topic: Already laid out\nPoints:\n- One\n- Two\nMood: calm', 'an answer that already has the layout is left exactly as it is');
  assert.ok(/Do NOT answer with one paragraph/.test(seen[seen.length - 1].system) && /Example of the layout/.test(seen[seen.length - 1].system), 'the model is shown the layout with an example and told not to answer in one paragraph');
  console.log('PASS a one-paragraph answer is laid out as Topic / Points (from its own sentences, else from the content); a laid-out answer is left alone; the model gets an example');

  console.log('PASS several lines: topic, points, mood and call to action, built from the whole content; bullets are normalised, a list or object answer is laid out the same, a too-long answer is cut at a whole line');

  // 5. what is already in the box is kept and improved (a title is not needed then)
  r = await ideaAssist(admin, { kind: 'video', idea: 'Walk-in drive on Saturday for nurses' });
  assert.ok(r.idea && seen[seen.length - 1].prompt.includes('already wrote this in the idea box (keep its facts, improve and complete it in the layout above):\nWalk-in drive on Saturday for nurses'), seen[2].prompt);
  console.log('PASS the words already in the box are sent to be kept and improved');

  // 6. a client project: its client and brief are used, and the client is who it is for; no title needed
  const made = await P.create(admin, { clientName: 'Sunrise Dental', occasion: 'Free check-up camp', brief: 'A free dental check-up camp on Sunday at our clinic. Show a smiling family.', deliverable: 'image', platforms: ['facebook'] });
  assert.ok(made.project, JSON.stringify(made));
  r = await ideaAssist(admin, { kind: 'post', projectId: made.project.id });
  assert.ok(r.idea, JSON.stringify(r));
  const pq = seen[seen.length - 1];
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
