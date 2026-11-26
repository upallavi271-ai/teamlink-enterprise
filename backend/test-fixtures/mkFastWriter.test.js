// AI Marketing: THE FAST WRITER (marketing/fastText.js) behind the writing buttons: AI Content (draft, rewrite), the calendar plan, the email and message writers, the client brief, the SEO article and
// the video / post script. Owner, 26 Nov: "yes, switch them".
//   node backend/test-fixtures/mkFastWriter.test.js     (throw-away copy of prisma/sandbox.db; the AI services are stand-ins: nothing is sent to any AI service)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-fast-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const Cfg = require('../src/marketing/settings');
const AI = require('../src/marketing/ai');
const FT = require('../src/marketing/fastText');
const Img = require('../src/marketing/images');
const sandbox = require('../src/utils/sandbox');

let n = 0;
const person = () => { n += 1; return { id: `u-fw-${n}`, name: 'Fast Writer Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }; }; // a person each: the one-minute counter never counts across cases

(async () => {
  await Img.ensure(); await require('../src/marketing/projects').ensure(); await AI.ensure();
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), aiDailyPerUser: 200, aiMonthlyCap: 0 });
  const real = await require('../src/db').user.findFirst({ select: { id: true } });
  await Cfg.saveBrand({ ...(await Cfg.getBrand()), brandName: 'TeamLink Digital', tone: 'Friendly', avoidWords: [], language: 'English' }, { id: real ? real.id : 'u-admin', name: 'Test Admin' });

  // 1. is it ready? only with a saved card, and only while writing is inside its half of the free allowance
  assert.equal((await FT.status()).ready, false, 'the test sandbox makes no outside calls');
  const realCf = { ...Img.cloudflareText }; const realAllow = sandbox.allowAi;
  sandbox.allowAi = () => true;
  Img.cloudflareText.config = async () => ({ key: '', account: '' });
  assert.equal((await FT.status()).ready, false, 'no card saved');
  Img.cloudflareText.config = async () => ({ key: 'test-token', account: 'b'.repeat(32) });
  assert.equal((await FT.status()).ready, true);
  const model = FT.MODEL.split('/').pop();
  const row = (o) => S.run('INSERT INTO "OmniMkAiUsage" (id, at, userId, module, task, provider, model, ok, inChars, outChars, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('au'), o.at || Date.now(), 'u-x', o.module || 'content', 'draft', o.provider || 'cloudflare', o.model || model, 1, o.inChars || 0, o.outChars || 0, 10);
  await row({ outChars: 400000, at: Date.now() - 2 * 86400000 }); await row({ outChars: 400000, module: 'images', model: 'flux-2-klein-4b (Cloudflare, free)' });
  assert.equal(await FT.usedToday(), 0, 'earlier days and the pictures are not counted');
  await row({ inChars: 3000, outChars: 3000 }); assert.equal(await FT.usedToday(), Math.round((1000 * 24545 + 1000 * 77273) / 1e6));
  await row({ outChars: 200000 });
  const full = await FT.status(); assert.ok(!full.ready && /half of the free daily allowance/.test(full.reason), JSON.stringify(full));
  await S.run('DELETE FROM "OmniMkAiUsage"');
  Object.assign(Img.cloudflareText, realCf); sandbox.allowAi = realAllow;
  console.log('PASS ready only with a saved card and inside half the free daily allowance; earlier days and pictures are not counted');

  // 2. reading the answer
  assert.deepEqual(FT.read('{"variants":[{"angle":"A","texts":{"sms":"line one\nline two"}},]}'), { variants: [{ angle: 'A', texts: { sms: 'line one\nline two' } }] }, 'real line breaks and a trailing comma are repaired');
  assert.deepEqual(FT.read('Sure!\n```json\n{"ideas":[]}\n```'), { ideas: [] });
  assert.equal(FT.read('Here are some ideas for you.'), null, 'plain words are no answer to a task that needs the object');
  assert.deepEqual(FT.read('The client wants a video.', 'brief'), { brief: 'The client wants a video.' });
  assert.equal(FT.read('{"variants":[{"angle":', 'brief'), null, 'a cut-off answer is never shown');
  console.log('PASS the answer is read (fences, line breaks, trailing commas); plain words only where the task is one piece of text');

  // 3. generate: own: true falls back to the app's own model; without it the caller decides; both tries are logged
  const slow = []; let slowAnswer = { ok: 'own' };
  AI.register('text', { id: 'stub', usable: () => true, async status() { return { ready: true, provider: 'stub', model: 'stub-1', reason: '' }; }, async json(system, prompt, lim) { slow.push({ system, prompt, lim }); if (typeof slowAnswer === 'function') return slowAnswer(); return slowAnswer; } });
  AI.register('text', { id: 'demo', usable: () => false, async status() { return { ready: true, provider: 'demo', model: 'x', reason: '' }; } });
  const fast = []; let fastAnswer = () => ({ ok: 'fast' });
  FT.status = async () => ({ ready: true, provider: 'cloudflare', model: 'fast-model', reason: '' });
  FT.json = async (system, prompt, opts) => { fast.push({ system, prompt, opts }); return fastAnswer(system); };
  const call = (u, more) => AI.generate({ user: u, module: 'content', task: 'draft', system: 'S', prompt: 'P', ...more });
  let r = await call(person(), { fast: { own: true, maxTokens: 99, ms: 5000 } });
  assert.ok(r.provider === 'cloudflare' && r.result.ok === 'fast' && slow.length === 0 && fast[0].opts.maxTokens === 99 && fast[0].opts.ms === 5000, JSON.stringify(r));
  r = await call(person(), {}); assert.ok(r.provider === 'stub' && fast.length === 1, 'a task not marked fast is as before');
  r = await call(person(), { fast: { own: true }, json: false }).catch((e) => e); assert.equal(fast.length, 1, 'plain-text tasks never go to the fast writer');
  fastAnswer = () => { throw new AI.AiMkError('Cloudflare did not answer in time. Try again.', 503, 'unreachable'); };
  slow.length = 0; const u3 = person();
  r = await call(u3, { fast: { own: true } });
  assert.ok(r.provider === 'stub' && r.result.ok === 'own' && slow.length === 1 && slow[0].lim.timeoutMs > 50000 && slow[0].lim.timeoutMs <= 55000, JSON.stringify(slow[0].lim));
  await call(person(), { fast: { own: true }, quickMs: 40000 }); assert.equal(slow[1].lim.timeoutMs, 40000, 'a shorter limit of the caller stays');
  const e = await call(person(), { fast: { plain: 'idea' } }).catch((x) => x); assert.ok(e.fast === true && e.code === 'unreachable', String(e.message)); assert.equal(slow.length, 2);
  slowAnswer = () => { throw new AI.AiMkError('The AI model did not answer.', 503, 'failed'); };
  const both = await call(person(), { fast: { own: true } }).catch((x) => x); assert.ok(!both.fast && /did not answer/.test(both.message));
  const logged = await S.q('SELECT provider, ok FROM "OmniMkAiUsage" WHERE userId = ? ORDER BY at', u3.id);
  assert.deepEqual(logged.map((x) => `${x.provider}:${S.num(x.ok)}`).sort(), ['cloudflare:0', 'stub:1']);
  console.log('PASS own: a miss falls back to the app\'s own model inside the 60 seconds; without it the caller decides; both tries are logged');

  // 4. every writing button asks the fast writer first and uses what it writes
  fastAnswer = (system) => {
    if (system.includes('<email subject, or empty>')) return { variants: [{ angle: 'Direct', subject: 'Hello', texts: { whatsapp: 'Fast WhatsApp words', sms: 'Fast SMS words', email: 'Fast email words', rcs: 'Fast RCS words' } }] };
    if (system.includes('You edit marketing messages')) return { text: 'Fast rewrite' };
    if (system.includes('"ideas"')) return { ideas: [{ day: 1, title: 'Fast idea', text: 'Fast post words' }] };
    if (system.includes('You write the BRIEF')) return { brief: 'Fast brief: the client wants a warm video about the offer; prices to be confirmed.' };
    if (system.includes('SEO-friendly website articles')) return { title: 'Fast article', metaTitle: 'Fast', metaDescription: 'Fast article', markdown: '# Fast article\n\nThese are the fast words of an article about the business and its services.' };
    if (system.includes('"subjects"')) return { subjects: [{ angle: 'Role', text: 'Nurses wanted in Hyderabad' }], bodies: [{ angle: 'Short', text: 'Hi {{name}}, we are hiring nurses. Reply to apply.' }] };
    if (system.includes('"variants"')) return { variants: [{ angle: 'Short', texts: { whatsapp: 'Hi {{name}}, we are hiring. Reply to apply.' } }] };
    return { title: 'Fast script', headline: 'Fast headline', tagline: 'Fast', caption: 'Fast caption', cta: 'Apply', scenes: [{ caption: 'Fast scene one', say: 'Fast scene one' }, { caption: 'Fast scene two', say: 'Fast scene two' }, { caption: 'Fast scene three', say: 'Fast three' }] };
  };
  slowAnswer = () => { throw new Error('the slow model must not be asked'); };
  const used = async (label, fn) => { const before = fast.length; const out = await fn(); assert.ok(!out.error, `${label}: ${out.error}`); assert.ok(fast.length > before, `${label} did not ask the fast writer`); assert.ok(fast[fast.length - 1].opts.own === true && fast[fast.length - 1].opts.maxTokens >= 700, `${label}: ${JSON.stringify(fast[fast.length - 1].opts)}`); return out; };
  const Content = require('../src/marketing/content');
  let o = await used('AI Content draft', () => Content.generate(person(), { brief: 'We are hiring staff nurses in Hyderabad this month.', channels: ['whatsapp', 'sms'], variants: 1 }));
  assert.ok(JSON.stringify(o.variants).includes('Fast WhatsApp words') && o.ai.provider === 'cloudflare', JSON.stringify(o).slice(0, 400));
  o = await used('AI Content rewrite', () => Content.revise(person(), { channel: 'whatsapp', text: 'We are hiring nurses.', instruction: 'shorter please' }));
  assert.ok(o.text.includes('Fast rewrite'));
  o = await used('calendar plan', () => require('../src/marketing/calendar').plan(person(), { days: 1, perDay: 1, platforms: ['facebook'] }));
  assert.equal(o.ideas[0].text, 'Fast post words');
  o = await used('client brief', () => require('../src/marketing/projects').briefAssist(person(), { clientName: 'Rao Hospital', occasion: 'Health camp' }));
  assert.ok(o.brief.startsWith('Fast brief') && o.provider === 'cloudflare');
  o = await used('SEO article', () => require('../src/marketing/seoContent').article(person(), { topic: 'Nursing jobs in Hyderabad', facts: { name: 'TeamLink', city: 'Hyderabad', services: 'Recruitment' } }));
  assert.equal(o.article.title, 'Fast article');
  o = await used('video script', () => require('../src/marketing/autostudio').plan(person(), { kind: 'video', prompt: 'A hiring video for staff nurses in Hyderabad' }));
  assert.ok(o.plan.title === 'Fast script' && o.plan.headline === 'Fast headline' && o.provider === 'cloudflare', JSON.stringify(o).slice(0, 400));
  // the email and message writers are about an open job: a stand-in job (the sandbox database has none open)
  require('../src/outreach/campaigns').validate = async () => ({ requirement: { id: 'req-stand-in', title: 'Staff Nurse', location: 'Hyderabad', department: '', openings: 3 } });
  o = await used('message writer', () => require('../src/marketing/messaging').write(person(), { channels: ['whatsapp'], jobId: 'req-stand-in', variants: 1 }));
  assert.ok(o.variants[0].texts.whatsapp.includes('hiring') && o.ai.provider === 'cloudflare', JSON.stringify(o).slice(0, 400));
  o = await used('email writer', () => require('../src/marketing/emailmk').write(person(), { jobId: 'req-stand-in' }));
  assert.ok(o.subjects.length && o.bodies.length && o.ai.provider === 'cloudflare', JSON.stringify(o).slice(0, 400));
  console.log('PASS AI Content (draft, rewrite), calendar plan, client brief, SEO article, video script and the message and email writers ask the fast writer first and use its words');

  console.log('fast writer tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
