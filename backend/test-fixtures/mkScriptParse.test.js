// AI Marketing: a script pasted as CONTENT is read scene by scene, and no quotation marks or markdown reach the pictures or the voice-over (marketing/scriptParse.js + autostudio.js).
//   node backend/test-fixtures/mkScriptParse.test.js     (throw-away copy of prisma/sandbox.db; the AI writer is the labelled sample writer: nothing is sent to any AI service)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-script-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const SP = require('../src/marketing/scriptParse');
const Studio = require('../src/marketing/autostudio');
const Cfg = require('../src/marketing/settings');

const SCRIPT = [
  '**Scene 1 – Introduction (0–5 sec)**', '',
  'Visual: A professional dermatologist in a modern clinic, smiling and welcoming patients.', '',
  'Voiceover:', '"Is your skin troubling you? Are you worried about acne, pigmentation or hair fall?"', '',
  '**Scene 2 – Skin Problems (5–12 sec)**', '',
  'Visual: Close-up of a patient with acne, then a doctor explaining.', '',
  'Voiceover:', '“Acne and pigmentation are common, and the right care makes a difference.”', '',
  '**Scene 3 – Call to action**',
  'Visual: Clinic reception with a smiling team.',
  'Text on screen: Book a consultation',
  'Voiceover: "Visit our clinic today."',
].join('\n');
const clean = (s) => !/[*"“”«»_`]/.test(`${s.caption}${s.say}${s.imagePrompt}${s.search}`);

(async () => {
  // 1. a pasted script is read scene by scene
  const sc = SP.parseScript(SCRIPT);
  assert.ok(sc && sc.length === 3, JSON.stringify(sc));
  assert.equal(sc[0].caption, 'Is your skin troubling you?', 'the title on the screen is the first sentence spoken, without quotation marks');
  assert.equal(sc[0].say, 'Is your skin troubling you? Are you worried about acne, pigmentation or hair fall?', 'the whole voice-over is said, a line that starts on the next line included, no quotation marks');
  assert.ok(sc[0].imagePrompt.startsWith('A professional dermatologist in a modern clinic'), sc[0].imagePrompt);
  assert.equal(sc[0].search, 'professional dermatologist modern clinic', 'the footage is looked for from the visual');
  assert.equal(sc[1].say, 'Acne and pigmentation are common, and the right care makes a difference.', 'curly quotation marks go too');
  assert.equal(sc[2].caption, 'Book a consultation', 'a "Text on screen" line is the title when there is one');
  assert.equal(sc[2].say, 'Visit our clinic today.');
  assert.ok(sc.every(clean), 'no asterisks, labels or quotation marks anywhere');
  console.log('PASS a pasted script (Scene / Visual / Voiceover / Text on screen) is read scene by scene: say, title, picture and footage words; no labels, asterisks or quotation marks');

  // 2. content that is not a script is left to the line-by-line way
  assert.equal(SP.parseScript('Freshers welcome\nStaffing consultancy you can trust\nSend your CV today'), null);
  assert.equal(SP.parseScript('Scene 1: only one scene here\nVisual: a desk'), null, 'one scene is not a script');
  assert.equal(SP.parseScript(''), null);
  console.log('PASS ordinary lines, a single scene and an empty box are not treated as a script');

  // 3. plain(): marks and quotation marks go, apostrophes stay
  assert.equal(SP.plain('**"Hello,"** she said'), 'Hello, she said');
  assert.equal(SP.plain('“Smart quotes” and „low“ and «guillemets»'), 'Smart quotes and low and guillemets');
  assert.equal(SP.plain("Don't miss our clients’ day"), "Don't miss our clients’ day", 'an apostrophe is kept');
  assert.equal(SP.plain("'Walk-in drive'"), 'Walk-in drive', 'single quotes that wrap the whole text go');
  assert.equal(SP.plain(null), '');
  const t = SP.tidyScenes({ scenes: [{ caption: '"Hiring now"', say: '“We are hiring,” says the team.' }] });
  assert.deepEqual(t.scenes[0], { caption: 'Hiring now', say: 'We are hiring, says the team.' });
  console.log('PASS plain() and tidyScenes(): markdown and quotation marks removed, apostrophes kept');

  // 4. through the studio (the plan the screen asks for): the script's scenes win, the AI plan's own quotes are tidied too
  const AI = require('../src/marketing/ai'); await AI.ensure();
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), aiDailyPerUser: 200, aiMonthlyCap: 0 });
  const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  let r = await Studio.plan(admin, { kind: 'video', prompt: 'A skin care explainer for a dermatology clinic', content: SCRIPT, scenes: 4 });
  assert.ok(r.plan, JSON.stringify(r));
  assert.equal(r.plan.scenes.length, 3, 'the script has three scenes: the video has three scenes, not the four asked for');
  assert.equal(r.plan.scenes[0].say, sc[0].say); assert.equal(r.plan.scenes[2].caption, 'Book a consultation'); assert.ok(!r.plan.explain);
  assert.ok(r.plan.scenes.every(clean), JSON.stringify(r.plan.scenes));
  r = await Studio.plan(admin, { kind: 'video', prompt: 'We are hiring freshers for our staffing consultancy', content: '"Freshers welcome"\n“Staffing consultancy you can trust”\n**Send your CV today**', scenes: 3 });
  assert.deepEqual(r.plan.scenes.map((s) => s.caption), ['Freshers welcome', 'Staffing consultancy you can trust', 'Send your CV today'], 'plain lines keep their words, minus the quotation marks and asterisks');
  assert.ok(r.plan.scenes.every((s) => clean({ ...s, imagePrompt: '', search: '' })));
  console.log('PASS in the studio plan: a script gives its own scenes (voice-over, titles, footage words), plain lines lose their quotation marks and asterisks');

  console.log('script parse tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
