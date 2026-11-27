// AI Marketing > client approval: the changes that need the picture AI (owner, 27 Nov: "yes, build both"): a NEW picture for a banner whose picture the AI made, and an AI-made picture edited with the
// free Cloudflare model (the picture itself as the reference).
//   node backend/test-fixtures/mkPictureChanges.test.js   (throw-away copy of prisma/sandbox.db and uploads; WhatsApp, the picture AI and Cloudflare are stand-ins: nothing real is called or sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-picchg-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
const UP = path.join(process.env.UPLOAD_DIR, 'mk-images'); fs.mkdirSync(UP, { recursive: true });
const notify = require('../src/utils/notify'); const told = []; notify.notifyUsers = async (ids, m) => { told.push({ ids, ...m }); };
const sharp = require('sharp'); const S = require('../src/outreach/store');
const Rev = require('../src/marketing/revise'); const Img = require('../src/marketing/images'); const CR = require('../src/marketing/clientReview'); const R = require('../src/marketing/revision'); const Cfg = require('../src/marketing/settings');
const AI = require('../src/marketing/ai');

const tells = []; const stubTell = async (u, id) => { tells.push(id); return { ok: 'Sent by WhatsApp.', sent: [{ way: 'WhatsApp', ok: true }] }; };
const solid = (w, h, background, parts = []) => sharp({ create: { width: w, height: h, channels: 3, background } }).composite(parts);
const block = async (w, h, background, left, top) => ({ input: await solid(w, h, background).png().toBuffer(), left, top });
const pixel = async (buf, x, y) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
const near = (a, b, d = 30) => a.every((v, i) => Math.abs(v - b[i]) <= d);

(async () => {
  const admin = await require('../src/db').user.findFirst({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] } }); assert.ok(admin, 'the test database has an active admin');
  await Img.ensure(); await CR.ensure(); await R.ensure(); await AI.ensure(); R.hooks.waitMs = 0; R.hooks.tell = stubTell;
  const itemRow = async (id) => (await S.q('SELECT * FROM "OmniMkImage" WHERE id = ?', id))[0];
  const specOf = async (id) => JSON.parse((await itemRow(id)).spec);
  const fileOf = async (id) => path.join(UP, (await itemRow(id)).file);
  const mkClient = async (id) => { const rv = await CR.create(admin, { kind: 'image', itemId: id, mode: 'decide', clientName: 'Picture Test Co', contactName: 'Asha', contactPhone: '+919000000010', contactEmail: '', days: 7 }); assert.ok(rv.review, JSON.stringify(rv)); return rv.review; };
  const says = async (rv, text) => { const out = await CR.publicDecide(CR.tokenOf(rv.id), { decision: 'changes', name: 'Asha', comment: text }, '1.2.3.4'); assert.ok(out.ok, JSON.stringify(out)); };
  const picture = async ({ style = 'photo', prompt = 'a smiling dentist with a patient in a bright clinic', aspect = '16:9', buf, headline = null, withLogo = 0, model = '@cf/black-forest-labs/flux-2-klein-4b', base = null }) => {
    const id = S.newId('im'); const file = `${id}.jpg`; fs.writeFileSync(path.join(UP, file), buf);
    if (base) fs.writeFileSync(path.join(UP, `${id}.base.jpg`), base);
    await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, headline, style, aspect, model, withLogo, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'Test picture', prompt, headline, style, aspect, model, withLogo, file, 'image/jpeg', buf.length, 'draft', admin.id, admin.name, Date.now(), Date.now());
    return id;
  };

  // ---- 1. reading the client's words ----
  const ai = { headline: 'Healthy smiles', photoItemId: 'x', heroAi: true, layout: 'showcase' };
  let o = Rev.interpret(ai, 'please change the picture');
  assert.deepEqual([o.changes.map((c) => c.key), o.unclear, o.spec.heroRedo], [['photo'], [], 'please change the picture'], JSON.stringify(o));
  for (const words of ['show a female dentist in the picture', 'the photo should have a smiling child', 'remove the mask from the picture', 'make the background in the image blue']) { o = Rev.interpret(ai, words); assert.ok(o.spec.heroRedo && o.changes.length === 1 && o.changes[0].key === 'photo' && !o.spec.colors && o.spec.photoItemId === 'x', `${words}: ${JSON.stringify(o)}`); }
  o = Rev.interpret(ai, 'In the photo show a female dentist. Make it green.'); assert.deepEqual(o.changes.map((c) => c.key), ['photo', 'colors'], JSON.stringify(o));
  for (const words of ['remove the picture', 'we do not want this picture', 'the picture is not needed']) { o = Rev.interpret(ai, words); assert.ok(!o.spec.heroRedo && o.spec.photoItemId === '', `${words}: ${JSON.stringify(o)}`); }
  for (const words of ['make the theme blue', 'the headline should be Bright Smiles']) assert.ok(!Rev.interpret(ai, words).spec.heroRedo, words);
  const stock = { headline: 'Healthy smiles', heroSearch: 'dentist', heroN: 0 };
  o = Rev.interpret(stock, 'remove the mask from the picture'); assert.deepEqual([o.changes.length, o.unclear.length, o.spec.heroSearch], [0, 1, 'dentist'], 'a stock photo is not removed because something IN it should go');
  o = Rev.interpret(stock, 'change the picture'); assert.deepEqual([o.spec.heroN, o.spec.heroRedo], [1, undefined], 'a stock photo: the next one, as before');
  o = Rev.interpret({ headline: 'Healthy smiles', photoItemId: 'own' }, 'change the picture'); assert.deepEqual([o.changes.length, o.unclear.length], [0, 1], 'a person\'s own picture stays a person\'s job');
  assert.ok(Rev.variation(ai).spec.heroRedo, 'a new design makes a new AI picture');
  o = Rev.applyAi(ai, { confidence: 0.9, changes: [{ field: 'photo', action: 'set', value: 'a dentist waving' }] }); assert.equal(o.spec.heroRedo, 'a dentist waving');
  console.log('PASS reading the words: a request about an AI-made banner picture asks for a new one; "remove the picture" still removes it; stock and own pictures behave as before');

  // ---- 2. the banner: a new AI picture, the same words ----
  const heroBuf = await solid(1344, 768, '#2a6f97', [await block(400, 300, '#f4a261', 100, 100)]).jpeg().toBuffer();
  const heroId = await picture({ buf: heroBuf });
  const banner = async () => { const m = await Img.createBanner(admin, { size: '16:9', layout: 'showcase', headline: 'Healthy smiles', headline2: 'for the family', sub: 'Gentle care', chip: 'teamlink.in', photoItemId: heroId, title: 'Dental banner' }); assert.ok(m.item, JSON.stringify(m)); return { id: m.item.id, rv: await mkClient(m.item.id) }; };
  let t = await banner(); const original = fs.readFileSync(await fileOf(t.id)); const spec0 = await specOf(t.id);
  const asks = []; const colours = ['#9b2226', '#386641', '#5a189a', '#bc6c25'];
  R.hooks.makeFn = async (asked) => { asks.push(asked); return solid(1344, 768, colours[(asks.length - 1) % colours.length], [await block(500, 300, '#ffffff', 300, 200)]).png().toBuffer(); };
  await says(t.rv, 'please change the picture, show a female dentist'); let x = await R.run(t.rv.id);
  assert.ok(x.revised, JSON.stringify(x)); assert.deepEqual([x.version, x.revision.status, x.revision.method], [2, 'sent', 'rules']);
  assert.ok(asks.length === 1 && asks[0].startsWith('a smiling dentist with a patient in a bright clinic. The client asks for this:') && asks[0].includes('female dentist'), asks[0]);
  let spec = await specOf(t.id);
  assert.deepEqual([spec.headline, spec.headline2, spec.sub, spec.chip], [spec0.headline, spec0.headline2, spec0.sub, spec0.chip], 'the wording is exactly as before');
  assert.ok(spec.heroFile === `${t.id}.hero-v1` && spec.heroWishes.length === 1 && !('heroRedo' in spec) && !('heroAi' in spec), JSON.stringify(spec));
  assert.ok(fs.existsSync(path.join(UP, spec.heroFile)) && !fs.readFileSync(await fileOf(t.id)).equals(original) && fs.readFileSync((await Img.versionFile(admin, t.id, 0)).path).equals(original));
  await says(t.rv, 'the picture should show a child too'); x = await R.run(t.rv.id); spec = await specOf(t.id);
  assert.ok(x.revised && x.version === 3 && asks[1].includes('female dentist') && asks[1].includes('child') && spec.heroWishes.length === 2 && spec.heroFile === `${t.id}.hero-v2`, `${asks[1]} ${JSON.stringify(x)}`);
  await says(t.rv, 'make it green'); x = await R.run(t.rv.id); assert.ok(x.revised && asks.length === 2 && (await specOf(t.id)).heroFile === `${t.id}.hero-v2`, 'a change that does not name the picture keeps the new picture');
  console.log('PASS the banner: a new picture from the first description and the client\'s words, the wording unchanged, versions kept; other changes keep that picture');

  // no new picture can be made
  R.hooks.makeFn = async () => { throw new AI.AiMkError('Cloudflare sent no picture back.', 422, 'refused'); };
  t = await banner(); const o2 = fs.readFileSync(await fileOf(t.id)); await says(t.rv, 'change the picture'); const sent = tells.length; x = await R.run(t.rv.id);
  assert.deepEqual([x.revision.status, tells.length === sent, fs.readFileSync(await fileOf(t.id)).equals(o2)], ['needs-person', true, true]); assert.ok(/new picture could not be made/i.test(x.revision.error), x.revision.error);
  t = await banner(); await says(t.rv, 'make it green. change the picture'); x = await R.run(t.rv.id);
  assert.ok(x.revised && (await specOf(t.id)).colors.primary === '#15803d' && x.revision.unclear.some((u) => /the new picture/.test(u)) && !x.revision.summary.join(' ').includes('new picture'), JSON.stringify(x.revision));
  R.hooks.makeFn = null; t = await banner(); await says(t.rv, 'change the picture'); x = await R.run(t.rv.id); assert.ok(x.revision.status === 'needs-person' && /not available|sandbox|connected/i.test(x.revision.error), x.revision.error);
  R.hooks.makeFn = async () => solid(1344, 768, '#023047', [await block(500, 300, '#ffb703', 200, 200)]).png().toBuffer();
  t = await banner(); await says(t.rv, 'we do not like it, please redo it from scratch'); x = await R.run(t.rv.id); assert.ok(x.revised && x.revision.classification === 'new_design' && (await specOf(t.id)).heroFile.endsWith('.hero-v1'), JSON.stringify(x));
  console.log('PASS no picture: nothing is sent for a picture-only request, other changes still go and the picture is left for a person; a new design makes a new picture too');
  R.hooks.makeFn = null;

  // ---- 3. an AI-made picture with the free Cloudflare model ----
  const store = require('../src/utils/integrationStore'); const sandbox = require('../src/utils/sandbox');
  const realRead = store.readConfig; const realAllow = sandbox.allowAi; const realFetch = global.fetch; const realLogo = Cfg.getLogo;
  store.readConfig = async (id) => (id === 'ai-cloudflare' ? { values: { 'Cloudflare account ID': 'c'.repeat(32), 'Workers AI API token': 'tok-secret' }, missingKey: false } : { values: {}, missingKey: false });
  sandbox.allowAi = () => true;
  const logoPng = await solid(200, 200, '#ff00ff').png().toBuffer(); Cfg.getLogo = async () => ({ dataUrl: `data:image/png;base64,${logoPng.toString('base64')}` });
  const clean = await solid(1024, 1024, '#4c956c', [await block(300, 300, '#fefee3', 100, 100)]).jpeg({ quality: 95 }).toBuffer();
  const withLogo = await sharp(clean).composite([await block(190, 190, '#ff00ff', 808, 808)]).jpeg({ quality: 95 }).toBuffer();
  const photoId = await picture({ aspect: '1:1', buf: withLogo, base: clean, withLogo: 1 });
  const calls = []; let reply = async (ref) => sharp(ref).resize(1024, 1024).modulate({ brightness: 1.3 }).png().toBuffer();
  global.fetch = async (url, init) => {
    const form = init.body; const blob = form.get('input_image_0'); const ref = Buffer.from(await blob.arrayBuffer());
    calls.push({ url, auth: init.headers.Authorization, prompt: form.get('prompt'), width: form.get('width'), height: form.get('height'), ref });
    const out = await reply(ref);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ success: true, result: { image: out.toString('base64') } }), arrayBuffer: async () => out };
  };
  let rv = await mkClient(photoId); await says(rv, 'make the wall brighter'); x = await R.run(rv.id);
  assert.ok(x.revised, JSON.stringify(x)); assert.deepEqual([x.revision.status, x.revision.method, x.revision.kind, calls.length], ['sent', 'ai-edit', 'picture', 1]);
  const c = calls[0];
  assert.equal(c.url, `https://api.cloudflare.com/client/v4/accounts/${'c'.repeat(32)}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`); assert.equal(c.auth, 'Bearer tok-secret');
  assert.ok(c.prompt.startsWith('Image 0 is the current picture. Edit image 0 and change only this: make the wall brighter.') && /Keep everything else the same/.test(c.prompt) && /no logos/.test(c.prompt), c.prompt); assert.deepEqual([c.width, c.height], ['1024', '1024']);
  const rm = await sharp(c.ref).metadata(); assert.ok(rm.width < 512 && rm.height < 512, `the reference is under 512: ${rm.width}x${rm.height}`);
  assert.ok(near(await pixel(c.ref, rm.width - 30, rm.height - 30), [76, 149, 108]), 'the picture is sent WITHOUT the logo');
  const after = fs.readFileSync(await fileOf(photoId)); const am = await sharp(after).metadata(); assert.deepEqual([am.width, am.height, am.format], [1024, 1024, 'jpeg']);
  assert.ok(near(await pixel(after, 1024 - 80, 1024 - 80), [255, 0, 255]), 'TeamLink put the logo back, in the same corner, in its own colour');
  assert.ok(!near(await pixel(after, 600, 600), [76, 149, 108], 12), 'the picture itself changed');
  assert.ok(near(await pixel(fs.readFileSync(path.join(UP, `${photoId}.base.jpg`)), 1024 - 80, 1024 - 80), await pixel(after, 600, 600)), 'the changed picture without its logo is kept for the next change');
  assert.ok(fs.readFileSync((await Img.versionFile(admin, photoId, 0)).path).equals(withLogo), 'the original is kept');
  const used = await S.q('SELECT provider, ok FROM "OmniMkAiUsage" WHERE module = ? AND task = ?', 'images', 'edit'); assert.ok(used.some((u) => u.provider === 'cloudflare' && S.num(u.ok) === 1));
  console.log('PASS Cloudflare editing: the picture without the logo (under 512) and the client\'s words are sent; same size; the logo is put back exactly; the original is kept');

  // what the free model is not asked to do
  const before = calls.length;
  for (const [words, why] of [['change the phone number to 90000 11111', /words on the picture/], ['please write Free Checkup on it', /words on the picture/], ['remove the logo', /about the logo/]]) {
    const id = await picture({ aspect: '1:1', buf: withLogo, base: clean, withLogo: 1 }); const r = await mkClient(id); await says(r, words); const y = await R.run(r.id);
    assert.ok(y.revision.status === 'needs-person' && why.test(y.revision.error), `${words}: ${y.revision.error}`);
  }
  const worded = await picture({ aspect: '1:1', buf: clean, headline: 'Free checkup' }); const wr = await mkClient(worded); await says(wr, 'make the wall brighter'); const y = await R.run(wr.id); assert.ok(y.revision.status === 'needs-person' && /words drawn into it/.test(y.revision.error), y.revision.error);
  assert.equal(calls.length, before, 'Cloudflare is not asked');
  reply = async () => Buffer.from('not a picture'); let id = await picture({ aspect: '1:1', buf: clean }); rv = await mkClient(id); await says(rv, 'make the wall darker'); x = await R.run(rv.id); assert.ok(x.revision.status === 'needs-person' && fs.readFileSync(await fileOf(id)).equals(clean), JSON.stringify(x.revision));
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }) });
  id = await picture({ aspect: '1:1', buf: clean }); rv = await mkClient(id); await says(rv, 'make the wall darker'); x = await R.run(rv.id); assert.ok(x.revision.status === 'failed' && /free daily allowance/.test(x.revision.error) && fs.readFileSync(await fileOf(id)).equals(clean), JSON.stringify(x.revision));
  store.readConfig = realRead; sandbox.allowAi = realAllow; global.fetch = realFetch; Cfg.getLogo = realLogo;
  console.log('PASS not done by the free model: words, the logo, a picture with words drawn in; a broken answer is never sent; a used-up allowance is said and the original stays');

  console.log('picture changes tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
