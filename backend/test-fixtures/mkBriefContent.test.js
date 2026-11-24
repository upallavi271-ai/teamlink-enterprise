// AI Marketing: a video written FROM THE CLIENT'S BRIEF when nobody types an idea (marketing/briefContent.js + autostudio.plan).
//   node backend/test-fixtures/mkBriefContent.test.js   (throw-away copy of prisma/sandbox.db; no AI service is called)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-brief-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const AS = require('../src/marketing/autostudio');
const BC = require('../src/marketing/briefContent');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
let pass = 0; const ok = (n) => { pass += 1; console.log(`PASS  ${n}`); };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const mk = async (b) => { const r = await P.create(admin, { clientName: 'Dr Rao Dental Clinic', contactName: 'Dr Rao', contactPhone: '+919000000002', contactEmail: 'rao@clientcheck.in', occasion: 'Dental care', brief: 'We are a dental clinic. We want videos that help our patients look after their teeth.', deliverable: 'video', accept: true, ...b }); assert.ok(r.project, JSON.stringify(r)); return r.project; };

  // 1. the profile comes from the words of the brief
  assert.equal(BC.profileOf('dermatologist skin hair clinic').id, 'skin');
  assert.equal(BC.profileOf('dental clinic, orthodontics').id, 'dental');
  assert.equal(BC.profileOf('we run a software company').id, 'general'); ok('the kind of client is read from the brief');

  // 2. no idea typed + a client project: the plan is written from the brief
  const p = await mk();
  const r = await AS.plan(admin, { projectId: p.id, kind: 'video', scenes: 5 });
  assert.ok(r.plan && r.fromBrief === true, JSON.stringify(r).slice(0, 300)); ok('with no idea typed, a client project writes the video from its brief');
  assert.equal(r.plan.scenes.length, 5); assert.ok(r.plan.scenes.every((s) => s.caption && s.imagePrompt && s.search)); ok('every scene has its words, a picture description and photo search words');
  const words = r.plan.scenes.map((s) => s.caption).join(' ');
  assert.ok(/brush|teeth|dentist|floss|smile|sugar|cavit/i.test(words) && !/sample caption|test writer/i.test(r.plan.caption)); ok('the points are useful to the client\'s own patients (dental care), not an advertisement');
  assert.ok(/not a substitute for a doctor/i.test(r.plan.caption) && !/cure|guarantee|100%|before and after/i.test(`${words} ${r.plan.caption}`)); ok('a health client gets the "see a doctor" line and no cure / guarantee wording');
  assert.ok(!/(?:₹|rs\.?\s?\d|\b\d{10}\b|https?:\/\/)/i.test(`${words} ${r.plan.caption}`)); ok('nothing is invented: no price, phone number or link');
  assert.ok(/dent|tooth|teeth|smil|clinic/i.test(r.plan.scenes.map((s) => s.search).join(' '))); ok('the stock-photo search words match the client');
  assert.equal(r.plan.who, 'Dr Rao Dental Clinic'); assert.ok(r.plan.hashtags.length >= 1); ok('the client is the brand; hashtags are made');

  // 2b. STARTER CONTENT is written the moment the project is made, shown on the project, and used when asked
  assert.ok(p.draft && p.draft.headline && p.draft.scenes.length === 4 && p.draft.caption && p.draft.hashtags.length, JSON.stringify(p.draft)); ok('the starter content is written as soon as the project is created');
  assert.ok(/brush|teeth|dentist|floss|smile|sugar|cavit|dental/i.test(p.draft.scenes.join(' '))); ok('it is about the client (dental care for a dental clinic)');
  const used = await AS.plan(admin, { projectId: p.id, kind: 'video', scenes: 4, useDraft: true });
  assert.ok(used.fromBrief && used.plan.headline === p.draft.headline && used.plan.scenes[1].caption === p.draft.scenes[1]); ok('the video is made from that same starter content when asked (what the team read is what is made)');
  const other = await AS.plan(admin, { projectId: p.id, kind: 'video', scenes: 5, useDraft: true });
  assert.equal(other.plan.scenes.length, 5); ok('a different number of scenes is written fresh, never cut or stretched');
  const edited = await P.update(admin, p.id, { clientName: 'Dr Rao Skin Care', occasion: 'Skin care month', brief: 'We are a dermatology clinic. Please make videos about sunscreen and moisturising for families.', contactName: 'Dr Rao', contactPhone: '+919000000002', source: p.source, deliverable: 'video' });
  assert.ok(edited.project && /skin/i.test(edited.project.draft.headline + edited.project.draft.scenes.join(' ')), JSON.stringify(edited).slice(0, 300)); ok('when the brief changes, the starter content follows it');

  // 2c. A PERSON EXPLAINING: every scene has a spoken line, warmer and longer than the words on screen
  assert.ok(r.plan.scenes.every((s) => s.say && s.say.length > s.caption.length - 5), JSON.stringify(r.plan.scenes.map((s) => s.say))); ok('every scene has a spoken line for the voice-over');
  assert.ok(/Dr Rao Dental Clinic/.test(r.plan.scenes[0].say) && /^(Hello|Namaste)/.test(r.plan.scenes[0].say)); ok('the first line greets and names the client');
  const lastSay = r.plan.scenes[r.plan.scenes.length - 1].say;
  assert.ok(/speak to your doctor/i.test(lastSay) && /Book a check-up/.test(lastSay)); ok('the last line invites the viewer (and, for a doctor, says to see a doctor)');
  assert.ok(r.plan.scenes.slice(1, -1).every((s) => /^(Here is|Next|Another|And one|Please also)/.test(s.say) && !/\.\s[a-z]/.test(s.say))); ok('the middle lines read like speech, one point each, with proper sentences');
  const typed = await AS.plan(admin, { projectId: p.id, kind: 'video', scenes: 3, content: 'Free skin check this Sunday\nBring your old reports\nCall to book' });
  assert.ok(typed.plan.scenes[0].say.includes('Free skin check this Sunday')); ok('the typed words are what is said, as they were written');

  // 2d. IDEAS READ FROM THE BRIEF (what the client listed becomes clickable ideas) and a video on ONE topic
  const listBrief = 'A dermatologist helps diagnose and treat various skin and hair problems, including: - Acne and pimples - Pigmentation and dark spots - Hair fall and dandruff - Eczema and skin allergies - Fungal infections - Wrinkles and ageing skin - Skin rashes and infection';
  assert.deepEqual(BC.topicsOf(listBrief).slice(0, 3), ['Acne and pimples', 'Pigmentation and dark spots', 'Hair fall and dandruff']); ok('what the client listed in the brief is read as separate items (the intro sentence is skipped)');
  const ideas = BC.ideasFor({ who: 'teamlink opc', occasion: 'Dermatologist', brief: listBrief });
  assert.ok(ideas.length >= 5 && ideas.every((i) => i.label && i.idea && i.heading) && /Acne/.test(ideas[0].idea) && /see a doctor/.test(ideas[0].idea)); ok('every listed thing becomes a ready video idea');
  const hair = BC.buildPlan({ who: 'teamlink opc', occasion: 'Dermatologist', brief: listBrief, n: 4, focus: ideas.find((i) => /Hair/.test(i.label)).idea });
  assert.ok(/hair/i.test(hair.headline) && hair.scenes.slice(1, -1).every((x) => /hair|protein|wash|dandruff|scalp|shampoo/i.test(x.caption)) && /hair|scalp/i.test(hair.scenes[1].search)); ok('a video on one topic has that topic\'s own tips and photo words, not generic ones');
  const lb = await mk({ clientName: 'Listing Skin Clinic', occasion: 'Dermatologist', brief: listBrief });
  const gd = await P.get(admin, lb.id);
  assert.ok(gd.ideas.length >= 5 && gd.project.draft && gd.project.draft.headline); ok('opening a project returns the ideas and its starter content');
  await S.run('UPDATE "OmniMkProject" SET draftPlan = NULL WHERE id = ?', lb.id);
  const gd2 = await P.get(admin, lb.id);
  assert.ok(gd2.project.draft && gd2.project.draft.headline); ok('an older project with no starter content gets it the first time its page is opened');
  const typedIdea = await AS.plan(admin, { projectId: lb.id, kind: 'video', scenes: 4, prompt: ideas.find((i) => /Eczema/.test(i.label)).idea, heading: 'Eczema and skin allergies' });
  assert.ok(!typedIdea.fromBrief && /moistur|soap|scratch|itch|allerg/i.test(JSON.stringify(typedIdea.plan.scenes))); ok('a clicked idea makes a video about THAT topic');

  // 2e. EXPLAINER: a skin client's video explains each problem (signs, home care, how the doctor helps)
  const ov = await AS.plan(admin, { projectId: lb.id, kind: 'video', scenes: 6 });
  assert.ok(ov.plan.explain === true && ov.plan.scenes.length === 6, JSON.stringify(ov.plan.scenes.map((x) => x.caption))); ok('with no idea typed, a skin client gets an explainer (greeting, one scene per problem, call to action)');
  assert.ok(ov.plan.scenes.slice(1, -1).every((x) => x.bullets.length === 3 && x.bullets[0].label === 'Signs' && x.say.length > 120)); ok('each problem scene has three rows (signs, at home, doctor) and a spoken explanation');
  const deep = await AS.plan(admin, { projectId: lb.id, kind: 'video', scenes: 4, prompt: ideas.find((i) => /Acne/.test(i.label)).idea });
  assert.ok(deep.plan.explain && deep.plan.scenes.length === 5 && /what you may see/i.test(deep.plan.scenes[1].caption) && /doctor/i.test(deep.plan.scenes[3].caption)); ok('one clicked problem becomes a deep dive: greeting, what you may see, what helps, how the doctor helps, call to action');
  assert.ok(!/cure|guarantee|100%|permanent|before and after/i.test(JSON.stringify(deep.plan.scenes) + JSON.stringify(ov.plan.scenes))); ok('the explainer never promises a cure or a result');
  assert.ok(ov.plan.scenes.every((x) => x.bullets.every((b) => b.text.length <= 70))); ok('every row is short enough for the picture');
  const nonSkin = await AS.plan(admin, { projectId: (await mk({ clientName: 'Bright Smile Dental', occasion: 'Dental care', brief: 'We are a dental clinic. We want videos about brushing and check-ups for families.' })).id, kind: 'video', scenes: 4 });
  assert.ok(!nonSkin.plan.explain && nonSkin.plan.scenes.length === 4); ok('other kinds of client keep the tips video until their own topics are written');

  // 2f. WHAT IS POSTED: the caption, or the starter content's caption, and the writer's hashtags when the words have none
  const rowP = (await S.q('SELECT * FROM "OmniMkProject" WHERE id = ?', p.id))[0];
  const posted1 = P.captionWithTags({ ...rowP, caption: '' });
  assert.ok(posted1.length > 20 && /#\w+/.test(posted1)); ok('with no caption written, the post carries the starter content words and hashtags');
  const own = P.captionWithTags({ ...rowP, caption: 'Our own words' });
  assert.ok(/^Our own words\n\n#\w+/.test(own) && (own.match(/#/g) || []).length <= 8); ok('a caption without hashtags gets the writer\'s hashtags added (at most 8)');
  assert.equal(P.captionWithTags({ ...rowP, caption: 'Already tagged #Dental' }), 'Already tagged #Dental'); ok('a caption that already has hashtags is left exactly as written');

  // 3. what a person types still wins
  const r2 = await AS.plan(admin, { projectId: p.id, kind: 'video', scenes: 4, prompt: 'Free skin check camp this Sunday at our clinic', heading: 'Free skin check camp' });
  assert.ok(!r2.fromBrief && r2.plan.headline === 'Free skin check camp'); ok('the person\'s own idea and heading still win over the brief');

  // 4. a non-medical client uses its own brief sentences
  const g = await mk({ clientName: 'Sri Sai Software', occasion: 'Hiring freshers', brief: 'We build billing software for small shops. We want to hire fresh graduates this month. Walk in with your resume.' });
  const r3 = await AS.plan(admin, { projectId: g.id, kind: 'video', scenes: 4 });
  assert.ok(r3.fromBrief && r3.plan.scenes.length === 4); ok('a non-medical client is written from its own brief too');
  assert.ok(!/not a substitute for a doctor/i.test(r3.plan.caption)); ok('the doctor line is only for health clients');

  // 5. no project, no idea: still the old message
  const e = await AS.plan(admin, { kind: 'video' });
  assert.ok(e.error && e.status === 400); ok('no project and no idea: the same plain error as before');

  console.log(`\n${pass} checks passed`);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
