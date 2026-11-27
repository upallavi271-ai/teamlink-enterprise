// AI Marketing > AI Images > Poster (owner, 27 Nov: "we have to create like this, or better, for my clients automatically"): contact details saved once, the AI writes the words, TeamLink draws the
// poster, and a client's change requests redraw it.
//   node backend/test-fixtures/mkPoster.test.js   (throw-away copy of prisma/sandbox.db and uploads; the AI writer, the picture AI and WhatsApp are stand-ins: nothing real is called or sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-poster-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
const UP = path.join(process.env.UPLOAD_DIR, 'mk-images'); fs.mkdirSync(UP, { recursive: true });
require('../src/utils/notify').notifyUsers = async () => {};
const sharp = require('sharp'); const S = require('../src/outreach/store');
const Img = require('../src/marketing/images'); const Rev = require('../src/marketing/revise'); const R = require('../src/marketing/revision'); const CR = require('../src/marketing/clientReview');
const P = require('../src/marketing/projects'); const Cfg = require('../src/marketing/settings'); const AI = require('../src/marketing/ai'); const Kit = require('../src/marketing/posterKit');

const person = (id) => ({ id, name: 'Poster Tester', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
const pic = (w, h, background, box) => sharp({ create: { width: w, height: h, channels: 3, background } }).composite(box ? [{ input: { create: { width: Math.round(w / 3), height: Math.round(h / 2), channels: 3, background: box } }, left: Math.round(w / 3), top: Math.round(h / 4) }] : []).jpeg().toBuffer();

(async () => {
  const admin = await require('../src/db').user.findFirst({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] } }); assert.ok(admin);
  await Img.ensure(); await CR.ensure(); await R.ensure(); await AI.ensure(); await P.ensure(); R.hooks.waitMs = 0; const tells = []; R.hooks.tell = async (u, id) => { tells.push(id); return { ok: 'Sent', sent: [{ way: 'WhatsApp', ok: true }] }; };
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), aiDailyPerUser: 200, aiMonthlyCap: 0 });
  await Cfg.saveBrand({ ...(await Cfg.getBrand()), brandName: 'TeamLink Consultants', tagline: 'Your Recruitment Partner', website: 'https://www.tmlink.in/', contact: 'hr@teamlinkcs.com | 90323 21414', tone: 'Friendly', avoidWords: [], language: 'English' }, admin);

  // ---- 1. contact details: from the brand kit at first, then what was saved; one set for us and one per client project ----
  let k = await Kit.getKit(admin, '');
  assert.deepEqual([k.saved, k.kit.companyName, k.kit.website, k.kit.email, k.kit.phone], [false, 'TeamLink Consultants', 'www.tmlink.in', 'hr@teamlinkcs.com', '90323 21414'], JSON.stringify(k));
  await Kit.saveKit(admin, '', { location: 'Kukatpally, Hyderabad', phone: '90323 21414' });
  const made = await P.create(admin, { clientName: 'Rao Dental Care', occasion: 'Free check-up camp', brief: 'A free dental check-up camp on Sunday at our clinic.', deliverable: 'image', platforms: ['facebook'] }); assert.ok(made.project, JSON.stringify(made));
  const pid = made.project.id;
  k = await Kit.getKit(admin, pid); assert.deepEqual([k.key, k.kit.companyName, k.kit.phone, k.kit.email, k.kit.website], [`project:${pid}`, 'Rao Dental Care', '', '', ''], 'a client never gets our own contact details');
  await Kit.saveKit(admin, pid, { phone: '90000 11111', location: 'Miyapur' });
  assert.deepEqual([(await Kit.getKit(admin, pid)).kit.phone, (await Kit.getKit(admin, '')).kit.phone, (await Kit.getKit(admin, '')).kit.location], ['90000 11111', '90323 21414', 'Kukatpally, Hyderabad']);
  await Kit.saveKit(admin, pid, { location: '' }); assert.equal((await Kit.getKit(admin, pid)).kit.location, '', 'an emptied detail stays empty');
  assert.equal((await Kit.getKit(admin, 'prj-nope')).status, 404); assert.equal((await Kit.getKit({ id: 'x', role: 'CANDIDATE' }, '')).status, 403);
  console.log('PASS contact details: from the brand kit at first, saved once, separate for each client, never ours on a client');

  // ---- 2. the words ----
  const asked = []; let answer;
  AI.register('text', { id: 'stub', usable: () => true, async status() { return { ready: true, provider: 'stub', model: 'stub-1', reason: '' }; }, async json(system, prompt) { asked.push({ system, prompt }); if (typeof answer === 'function') return answer(); return answer; } });
  AI.register('text', { id: 'demo', usable: () => false, async status() { return { ready: true, provider: 'demo', model: 'x', reason: '' }; } });
  answer = { headline: 'Medical', headline2: 'Recruitment', sub: 'Hiring Indian Doctors & Staff Nurses', roles: ['Doctors', 'Staff Nurses'], services: ['Requirement Understanding', 'Candidate Sourcing', 'Screening', 'Call 99999 99999', 'Guaranteed Joining'], motto: 'We turn hiring challenges', motto2: 'to Right Connections', cta: 'Partner with TeamLink', closing: 'Visit www.fake.com for a 50% discount', heroPrompt: 'Four Indian doctors and nurses in a hospital corridor', secondPrompt: 'A handshake', caption: 'We help hospitals hire doctors and nurses.', hashtags: ['#Hiring', 'medical jobs'] };
  let r = await Kit.write(person('u-p1'), { idea: 'Medical recruitment: hiring Indian doctors and staff nurses', tagline: 'Your Recruitment Partner for a Better Tomorrow' });
  assert.ok(r.poster, JSON.stringify(r)); let p = r.poster;
  assert.deepEqual([p.headline, p.headline2, p.sub, p.motto, p.motto2, p.cta], ['Medical', 'Recruitment', 'Hiring Indian Doctors & Staff Nurses', 'We turn hiring challenges', 'to Right Connections', 'Partner with TeamLink']);
  assert.deepEqual([p.roles, p.posterKey, p.servicesTitle], [[], 'own', 'Our Services']); assert.deepEqual(p.services, ['Requirement Understanding', 'Candidate Sourcing', 'Screening'], 'an invented number or promise is dropped');
  assert.equal(p.closing, '', 'a made-up link and discount never reach the poster');
  assert.deepEqual([p.companyName, p.tagline, p.phone, p.location, p.website, p.email], ['TeamLink Consultants', 'Your Recruitment Partner for a Better Tomorrow', '90323 21414', 'Kukatpally, Hyderabad', 'www.tmlink.in', 'hr@teamlinkcs.com'], 'contact details are the saved ones');
  assert.ok(/^Four Indian doctors and nurses in a hospital corridor\. At most two people/.test(p.heroPrompt) && /no text, no letters/.test(p.heroPrompt) && !('secondPrompt' in p) && /at most two people/.test(asked[0].system), p.heroPrompt);
  assert.deepEqual(p.hashtags, ['#Hiring', '#medicaljobs']); assert.ok(/NEVER invent phone numbers/.test(asked[0].system) && asked[0].prompt.includes('Business: TeamLink Consultants'));
  assert.equal((await Kit.getKit(admin, '')).kit.tagline, 'Your Recruitment Partner for a Better Tomorrow', 'what was typed on the screen is saved');
  r = await Kit.write(person('u-p2'), { idea: 'Free dental check-up camp on Sunday', projectId: pid, services: 'Consultation, Cleaning, Braces, Root Canal, Implants, Whitening, Seventh', motto: 'Because every smile', cta: 'Book your visit' });
  p = r.poster; assert.deepEqual([p.services, p.motto, p.cta, p.companyName, p.phone, p.posterKey], [['Consultation', 'Cleaning', 'Braces', 'Root Canal', 'Implants', 'Whitening'], 'Because every smile', 'Book your visit', 'Rao Dental Care', '90000 11111', `project:${pid}`], 'the services the person typed are used exactly, up to six');
  assert.ok(/No logo is saved for Rao Dental Care/.test(r.note), r.note);
  answer = () => { throw new AI.AiMkError('timed out', 504, 'timeout'); };
  r = await Kit.write(person('u-p3'), { idea: 'Topic: Walk-in interviews for staff nurses', heading: 'Walk-in Interviews', content: 'This Saturday at our office\nBring your CV\nCarry ID proof' });
  assert.ok(r.poster && /busy right now/.test(r.note), JSON.stringify(r)); assert.deepEqual([r.poster.headline, r.poster.headline2, r.poster.sub, r.poster.services], ['Walk-in', 'Interviews', 'This Saturday at our office', ['Bring your CV', 'Carry ID proof']]);
  assert.equal((await Kit.write(person('u-p4'), { idea: '' })).status, 400);
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), aiDailyPerUser: 0 }); assert.equal((await Kit.write(person('u-p5'), { idea: 'A hiring poster' })).status, 403); await Cfg.saveSettings({ ...(await Cfg.getSettings()), aiDailyPerUser: 200 });
  console.log('PASS the words: from the AI, invented numbers / links / promises dropped, the person\'s own kept, saved contacts used, plain words when the AI is busy');

  // ---- 2b. a CLIENT BUSINESS: its own logo (kept as it is), its own colour and details; never ours ----
  const ours = { teal: [15, 143, 128], magenta: [255, 0, 255] };
  const png = async (w, h, parts) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
  const box = async (w, h, rgb, left, top) => ({ input: await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer(), left, top });
  const url = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  await Cfg.saveLogo(Cfg.cleanLogo({ dataUrl: url(await png(300, 100, [await box(260, 80, ours.magenta, 20, 10)])) }).value); // OUR brand logo
  const clientLogo = await png(360, 120, [await box(300, 90, ours.teal, 30, 15)]);
  assert.equal(await Kit.colorOf(clientLogo), '#0f8f80', 'the colour is read from the logo');
  assert.equal((await Kit.saveKit(admin, '', { business: 'Smile Dental', logoDataUrl: 'data:image/png;base64,AAAA' })).status, 400, 'a file that is not a picture is refused');
  let c = await Kit.getKit(admin, '', 'Smile Dental'); assert.deepEqual([c.key, c.kit.companyName, c.kit.phone, c.kit.website, c.logo], ['biz:smile-dental', 'Smile Dental', '', '', ''], 'a new client has nothing of ours');
  answer = { headline: 'Healthy', headline2: 'Smiles', sub: 'Gentle dental care', services: ['Cleaning'], heroPrompt: 'A dentist with a child', caption: 'Gentle dental care.' };
  r = await Kit.write(person('u-c1'), { idea: 'A dental clinic poster', business: 'Smile Dental', logoDataUrl: url(clientLogo), phone: '91111 22222', services: 'Cleaning, Braces, Implants, Root Canal' });
  assert.deepEqual([r.poster.posterKey, r.poster.companyName, r.poster.phone, r.logo === url(clientLogo), /No logo/.test(r.note || '')], ['biz:smile-dental', 'Smile Dental', '91111 22222', true, false], JSON.stringify(r.note));
  c = await Kit.getKit(admin, '', 'Smile Dental'); assert.deepEqual([c.saved, c.kit.phone, c.logo === url(clientLogo)], [true, '91111 22222', true]); assert.ok(c.businesses.includes('Smile Dental'), 'listed for next time');
  assert.equal((await Kit.getKit(admin, '')).kit.phone, '90323 21414', 'our own details are untouched');
  const near = (a, b, d = 12) => a.every((v, i) => Math.abs(v - b[i]) <= d);
  const colours = async (file) => { const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true }); let teal = 0; let magenta = 0; for (let y = 0; y < 230; y += 1) for (let x = 0; x < info.width; x += 1) { const i = (y * info.width + x) * 3; const px = [data[i], data[i + 1], data[i + 2]]; if (near(px, ours.teal)) teal += 1; if (near(px, ours.magenta, 40)) magenta += 1; } return { teal, magenta, at: (x, y) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; } }; };
  const mk = async (over) => { const x = await Img.createBanner(admin, { layout: 'poster', size: '4:5', headline: 'Healthy', headline2: 'Smiles', services: ['Cleaning', 'Braces', 'Implants', 'Root Canal', 'Whitening', 'Check-up'], servicesTitle: 'Our Services', title: 'client', ...over }); assert.ok(x.item, JSON.stringify(x)); const row0 = (await S.q('SELECT file, spec, withLogo FROM "OmniMkImage" WHERE id = ?', x.item.id))[0]; return { id: x.item.id, withLogo: row0.withLogo, spec: JSON.parse(row0.spec), file: path.join(UP, row0.file) }; };
  let made1 = await mk({ posterKey: 'biz:smile-dental' }); let seenC = await colours(made1.file);
  assert.ok(seenC.teal > 20000 && seenC.magenta === 0, `the client's own logo, in its own colour, large; never ours: ${JSON.stringify({ teal: seenC.teal, magenta: seenC.magenta })}`);
  assert.deepEqual([made1.spec.posterKey, made1.spec.companyName, made1.spec.tagline, made1.spec.cta, made1.spec.footer], ['biz:smile-dental', 'Smile Dental', '', '', ''], 'nothing of our brand is filled in');
  made1 = await mk({ posterKey: 'biz:nobody-saved', companyName: 'Nobody Clinic' }); seenC = await colours(made1.file); assert.deepEqual([seenC.magenta, Number(made1.withLogo)], [0, 0], 'a client without a logo gets its name, never our logo');
  made1 = await mk({ posterKey: 'own' }); seenC = await colours(made1.file); assert.ok(seenC.magenta > 5000, 'our own poster carries our logo');
  // a very pale logo is set on a dark plate so it can be read
  await Kit.saveKit(admin, '', { business: 'White Logo Co', logoDataUrl: url(await png(360, 120, [await box(220, 60, [255, 255, 255], 70, 30)])) });
  made1 = await mk({ posterKey: 'biz:white-logo-co' }); const pale = await colours(made1.file); const beside = pale.at(540 - 245, 70); assert.ok(beside[0] < 110 && beside[2] < 170, `a dark plate behind a pale logo: ${beside}`);
  // a client change request keeps the client's logo
  const cv = await CR.create(admin, { kind: 'image', itemId: (await mk({ posterKey: 'biz:smile-dental' })).id, mode: 'decide', clientName: 'Smile Dental', contactName: 'Anu', contactPhone: '+919000000012', contactEmail: '', days: 7 }); assert.ok(cv.review, JSON.stringify(cv));
  await CR.publicDecide(CR.tokenOf(cv.review.id), { decision: 'changes', name: 'Anu', comment: 'please remove the services' }, '1.2.3.4');
  const changed = await R.run(cv.review.id); assert.ok(changed.revised, JSON.stringify(changed)); const after = (await S.q('SELECT file, spec FROM "OmniMkImage" WHERE id = ?', cv.review.itemId || changed.revision.itemId))[0];
  const kept = await colours(path.join(UP, after.file)); assert.ok(kept.teal > 20000 && kept.magenta === 0 && JSON.parse(after.spec).services.length === 0);
  console.log('PASS a client business: its own logo kept as it is and shown large (a pale one on a dark plate), its colour and details saved; never our logo or details; changes keep it');

  // ---- 3. the poster itself ----
  const row = async (buf, prompt) => { const id = S.newId('im'); fs.writeFileSync(path.join(UP, `${id}.jpg`), buf); await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, model, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'photo', prompt, 'photo', '16:9', 'flux', `${id}.jpg`, 'image/jpeg', buf.length, 'draft', admin.id, admin.name, Date.now(), Date.now()); return id; };
  const hero = await row(await pic(1344, 768, '#2a6f97', '#f4a261'), 'doctors and nurses in a hospital'); const hands = await row(await pic(1344, 768, '#8d99ae', '#ef233c'), 'a handshake');
  const body = { layout: 'poster', size: '4:5', headline: 'Medical', headline2: 'Recruitment', sub: 'Hiring Doctors & Nurses', roles: ['Doctors', 'Staff Nurses', 'Techs', 'Four'], services: ['Understand', 'Source', 'Screen', 'Shortlist', 'Interview', 'Six'], motto: 'We turn challenges', motto2: 'to Connections', cta: 'Partner with us', phone: '90323 21414', location: 'Kukatpally', chip: 'www.tmlink.in', email: 'hr@teamlinkcs.com', closing: 'Build a stronger team', photoItemId: hero, photo2ItemId: hands, title: 'Medical poster' };
  const b = await Img.createBanner(admin, body); assert.ok(b.item, JSON.stringify(b));
  const itemRow = async (id) => (await S.q('SELECT * FROM "OmniMkImage" WHERE id = ?', id))[0]; const specOf = async (id) => JSON.parse((await itemRow(id)).spec);
  const fileOf = async (id) => path.join(UP, (await itemRow(id)).file);
  const m = await sharp(await fileOf(b.item.id)).metadata(); assert.deepEqual([m.width, m.height], [1080, 1350]);
  let spec = await specOf(b.item.id);
  assert.deepEqual([spec.layout, spec.roles.length, spec.motto, spec.phone, spec.location, spec.email, spec.closing, spec.heroFile, spec.hero2File], ['poster', 3, 'We turn challenges', '90323 21414', 'Kukatpally', 'hr@teamlinkcs.com', 'Build a stronger team', `${b.item.id}.hero`, `${b.item.id}.hero2`]);
  assert.ok(fs.existsSync(path.join(UP, spec.hero2File)));
  for (const size of ['1:1', '9:16', '16:9']) { const x = await Img.createBanner(admin, { ...body, size, title: size }); assert.ok(x.item, `${size}: ${JSON.stringify(x)}`); const mm = await sharp(await fileOf(x.item.id)).metadata(); assert.ok(mm.width >= 1080 && mm.height >= 1080); }
  const bare = await Img.createBanner(admin, { layout: 'poster', size: '4:5', headline: 'Only a headline', title: 'bare' }); assert.ok(bare.item, JSON.stringify(bare));
  const plain = await Img.createBanner(admin, { size: '16:9', layout: 'showcase', headline: 'An ordinary banner', title: 'plain' }); const ps = await specOf(plain.item.id); assert.ok(!('phone' in ps) && !('roles' in ps), 'other banners are unchanged');
  console.log('PASS the poster: portrait, square and story sizes (a wide one is drawn as a showcase), both photographs kept beside it, an almost empty one still draws');

  // ---- 4. a client's changes ----
  const sp = { layout: 'poster', headline: 'Medical', phone: '90323 21414', email: 'hr@teamlinkcs.com', location: 'Kukatpally', chip: 'www.tmlink.in', photoItemId: hero, photo2ItemId: hands, hero2File: 'x.hero2', heroAi: true };
  let o = Rev.interpret(sp, 'please change the phone number to 98480 12345'); assert.deepEqual([o.spec.phone, o.changes.map((c) => c.key)], ['98480 12345', ['phone']], JSON.stringify(o));
  o = Rev.interpret(sp, 'the email id should be jobs@teamlinkcs.com'); assert.deepEqual([o.spec.email, o.spec.location], ['jobs@teamlinkcs.com', 'Kukatpally'], JSON.stringify(o));
  o = Rev.interpret(sp, 'change the address to Miyapur, Hyderabad'); assert.equal(o.spec.location, 'Miyapur, Hyderabad', JSON.stringify(o));
  o = Rev.interpret(sp, 'the website should be www.teamlink.in'); assert.equal(o.spec.chip, 'www.teamlink.in', JSON.stringify(o));
  o = Rev.interpret(sp, 'change the handshake picture'); assert.ok(!o.spec.heroRedo && o.changes.length === 0 && /second picture has to be changed by hand/.test(o.unclear[0]), JSON.stringify(o));
  o = Rev.interpret(sp, 'remove the handshake picture'); assert.ok(o.spec.photo2ItemId === '' && o.spec.hero2File === '' && o.spec.photoItemId === hero && !o.spec.heroRedo, JSON.stringify(o));
  o = Rev.interpret(sp, 'change the picture, show only nurses'); assert.ok(o.spec.heroRedo, JSON.stringify(o));
  const rv = await CR.create(admin, { kind: 'image', itemId: b.item.id, mode: 'decide', clientName: 'Poster Co', contactName: 'Asha', contactPhone: '+919000000011', contactEmail: '', days: 7 }); assert.ok(rv.review, JSON.stringify(rv));
  const says = async (text) => { const out = await CR.publicDecide(CR.tokenOf(rv.review.id), { decision: 'changes', name: 'Asha', comment: text }, '1.2.3.4'); assert.ok(out.ok, JSON.stringify(out)); };
  const before = fs.readFileSync(await fileOf(b.item.id)); await says('please change the phone number to 98480 12345'); let x = await R.run(rv.review.id);
  assert.ok(x.revised, JSON.stringify(x)); spec = await specOf(b.item.id); assert.deepEqual([spec.phone, spec.hero2File, spec.layout], ['98480 12345', `${b.item.id}.hero2`, 'poster']); assert.ok(!fs.readFileSync(await fileOf(b.item.id)).equals(before));
  const kept2 = fs.readFileSync(path.join(UP, spec.hero2File));
  R.hooks.makeFn = async () => pic(1344, 768, '#386641', '#ffffff'); await says('change the picture, show only nurses'); x = await R.run(rv.review.id);
  assert.ok(x.revised && x.version === 3, JSON.stringify(x)); spec = await specOf(b.item.id); assert.ok(spec.heroFile === `${b.item.id}.hero-v2` && fs.readFileSync(path.join(UP, spec.hero2File)).equals(kept2) && spec.phone === '98480 12345', JSON.stringify(spec));
  console.log('PASS change requests: phone, e-mail, address and website exactly as the client typed; the main picture made again; the second one is a person\'s job (or removed)');

  console.log('poster tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
