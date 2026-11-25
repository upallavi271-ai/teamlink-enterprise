// AI Marketing > client approval: the client asks for a change to the LOGO on a picture ("keep the logo top left and some bigger") -> TeamLink moves / resizes it by itself, with no AI model
// (marketing/revise.js logoRequest, images.js changeLogo / finishPic / fillRect, revision.js).
//   node backend/test-fixtures/mkLogoChange.test.js   (throw-away copy of prisma/sandbox.db and uploads; WhatsApp and the AI model are stand-ins: nothing real is called or sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-logo-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
const IMG_DIR = path.join(process.env.UPLOAD_DIR, 'mk-images'); fs.mkdirSync(IMG_DIR, { recursive: true });
const notify = require('../src/utils/notify'); const told = []; notify.notifyUsers = async (ids, m) => { told.push({ ids, ...m }); };
const sharp = require('sharp'); const S = require('../src/outreach/store');
const Rev = require('../src/marketing/revise'); const Img = require('../src/marketing/images'); const CR = require('../src/marketing/clientReview'); const R = require('../src/marketing/revision'); const Cfg = require('../src/marketing/settings');

const tells = []; const stubTell = async (u, id, b, base) => { tells.push({ id, ways: b.ways, base }); return { ok: 'Sent by WhatsApp.', sent: [{ way: 'WhatsApp', ok: true }] }; };
const raw = async (buf) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
const px = (R2, x, y) => { const i = (y * R2.w + x) * 3; return [R2.data[i], R2.data[i + 1], R2.data[i + 2]]; };
const whitish = (R2, x, y) => px(R2, x, y).every((v) => v >= 215); // the logo's soft white plate (90% white) over a dark photograph
const meanDiff = (A, B, x0, y0, w, h) => { let s = 0; let n = 0; for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) { const a = px(A, x, y); const b = px(B, x, y); s += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); n += 3; } return s / n; };

(async () => {
  const admin = await require('../src/db').user.findFirst({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] } }); assert.ok(admin, 'the test database has an active admin');

  // ---- 1 the client's words ----
  const lr = (t) => Rev.logoRequest(t);
  assert.deepEqual(lr('the teamlink logo is too short and it is right bottom placed keep it top left and some bigger'), { pos: 'top-left', factor: 1.4, add: false, rest: [] }, 'the owner\'s own words: where it IS (right bottom) is not where it must go (top left)');
  assert.equal(lr('Please move the logo from the bottom right to the top left').pos, 'top-left');
  assert.equal(lr('logo should be at the top right corner, not bottom right').pos, 'top-right');
  assert.deepEqual([lr('make the logo much bigger').pos, lr('make the logo much bigger').factor], ['', 1.8]);
  assert.equal(lr('put the logo bottom left and make it smaller').factor, 0.75);
  assert.deepEqual(lr('logo is small. Move it to the left top. Also change the heading to Hello').rest, ['Also change the heading to Hello'], 'what is not about the logo is left for a person, never guessed');
  assert.equal(lr('remove the logo'), null, 'taking the logo off is not done here'); assert.equal(lr('make the background brighter'), null); assert.equal(lr('the logo is nice'), null);
  console.log('PASS the client\'s words about the logo are read: the place it must go, not the place it is now; how much bigger / smaller; anything else is left for a person');

  // ---- 2 an older picture (no clean copy was kept): logo bottom right at the usual size, made by the old code ----
  const W = 1344; const H = 756;
  const photoRaw = Buffer.alloc(W * H * 3); let seed = 42; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const i = (y * W + x) * 3; const n = (rnd() - 0.5) * 8; photoRaw[i] = Math.max(0, Math.min(255, 30 + x / W * 50 + n)); photoRaw[i + 1] = Math.max(0, Math.min(255, 60 + y / H * 60 + n)); photoRaw[i + 2] = Math.max(0, Math.min(255, 90 + n)); }
  const photo = await sharp(photoRaw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer(); // a dark teal photograph with a little grain
  const logoPng = await sharp({ create: { width: 360, height: 120, channels: 4, background: { r: 30, g: 64, b: 175, alpha: 1 } } }).composite([{ input: await sharp({ create: { width: 200, height: 30, channels: 4, background: '#f59e0b' } }).png().toBuffer(), left: 80, top: 45 }]).png().toBuffer();
  await Cfg.saveLogo({ dataUrl: `data:image/png;base64,${logoPng.toString('base64')}`, name: 'logo.png', at: Date.now() });
  const fin = await Img.finishPic(photo, '16:9', { mime: 'image/png', b64: logoPng.toString('base64') });
  assert.ok(fin.withLogo && fin.clean, 'finishing a picture with a logo also hands back the picture WITHOUT the logo');
  const cleanRaw = await raw(fin.clean); const finRaw = await raw(fin.buf);
  assert.ok(meanDiff(cleanRaw, finRaw, 0, 0, 200, 200) < 3, 'away from the logo the finished picture is the clean one');
  await Img.ensure(); await CR.ensure(); await R.ensure(); // the tables are made on first use
  const mkRow = async (o = {}) => { const id = S.newId('im'); const file = `${id}.jpg`; fs.writeFileSync(path.join(IMG_DIR, file), o.buf || fin.buf); await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, model, withLogo, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, o.title || 'Professional digital marketing hero artwork', 'a hero', 'photo', '16:9', o.model || 'flux-2-klein-4b', o.withLogo === 0 ? 0 : 1, file, 'image/jpeg', (o.buf || fin.buf).length, 'draft', admin.id, admin.name, Date.now(), Date.now()); return { id, file }; };
  const mkClient = async (item, phone = '+919000000009') => { const rv = await CR.create(admin, { kind: 'image', itemId: item.id, mode: 'decide', clientName: 'Logo Test Co', contactName: 'Sanjana', contactPhone: phone, contactEmail: '', days: 7 }); assert.ok(rv.review, JSON.stringify(rv)); return rv.review; };
  const says = async (rv, text) => { const out = await CR.publicDecide(CR.tokenOf(rv.id), { decision: 'changes', name: 'Sanjana', comment: text }, '1.2.3.4'); assert.ok(out.ok, JSON.stringify(out)); return out; };
  const itemRow = async (id) => (await S.q('SELECT * FROM "OmniMkImage" WHERE id = ?', id))[0];
  const fileRaw = async (id) => raw(fs.readFileSync(path.join(IMG_DIR, (await itemRow(id)).file)));
  R.hooks.tell = stubTell; R.hooks.waitMs = 1; let aiCalls = 0; R.hooks.editFn = async () => { aiCalls += 1; throw new Error('the AI picture model must not be used for the logo'); };

  const legacy = await mkRow(); const before = await raw(fin.buf);
  const OLD = { left: 1185, top: 678, w: 140, h: 59 }; // the usual plate: 16% of 756 = 121 px wide logo (121x40) + 19 px padding, 19 px from the edges
  assert.ok(whitish(before, OLD.left + 3, OLD.top + 3) && whitish(before, OLD.left + OLD.w - 4, OLD.top + OLD.h - 4), 'the old logo plate is bottom right');
  const rv1 = await mkClient({ id: legacy.id }); await says(rv1, 'the teamlink logo is too short and it is right bottom placed keep it top left and some bigger');
  let x = await R.run(rv1.id); assert.ok(x.revised, JSON.stringify(x)); assert.equal(aiCalls, 0, 'no AI model was asked');
  assert.deepEqual([x.revision.status, x.revision.method], ['sent', 'rules']); assert.ok(/Moved the logo to the top left and made it 40% bigger/.test(x.changes.join(' ')), x.changes.join(' '));
  assert.ok(/filled with the picture's own surrounding colours/.test(x.changes.join(' ')), 'an older picture: it says honestly that the old spot was filled from the colours around it');
  assert.equal(tells.length, 1); assert.deepEqual(tells[0].ways, ['whatsapp']);
  const after = await fileRaw(legacy.id); const meta = await sharp(path.join(IMG_DIR, legacy.file)).metadata(); assert.deepEqual([meta.width, meta.height, meta.format], [W, H, 'jpeg'], 'same size and format');
  const NEW = { left: 19, top: 19, w: 188, h: 75 }; // 16% x 1.4 = 169 px wide logo (169x56) + 19 padding, 19 px from the top left
  assert.ok(whitish(after, NEW.left + 3, NEW.top + 3) && whitish(after, NEW.left + NEW.w - 4, NEW.top + NEW.h - 4), 'the logo plate is at the top left now');
  assert.ok(!whitish(after, NEW.left + NEW.w + 8, NEW.top + 10) && !whitish(after, NEW.left + 10, NEW.top + NEW.h + 8), 'and it is not larger than the size asked for: 1.4 times the old one');
  assert.ok(!whitish(after, OLD.left + 3, OLD.top + 3) && !whitish(after, OLD.left + OLD.w - 4, OLD.top + OLD.h - 4), 'the old logo is gone from the bottom right');
  assert.ok(meanDiff(after, cleanRaw, OLD.left - 3, OLD.top - 3, OLD.w + 6, OLD.h + 6) < 14, `the old spot looks like the picture around it (mean difference ${meanDiff(after, cleanRaw, OLD.left - 3, OLD.top - 3, OLD.w + 6, OLD.h + 6).toFixed(1)} from the photograph that was there)`);
  assert.ok(meanDiff(after, cleanRaw, 300, 200, 600, 300) < 4, 'the rest of the picture is untouched');
  if (process.env.DUMP_DIR) { fs.mkdirSync(process.env.DUMP_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.DUMP_DIR, 'before.jpg'), fin.buf); fs.copyFileSync(path.join(IMG_DIR, legacy.file), path.join(process.env.DUMP_DIR, 'after.jpg')); } // look at it by eye: DUMP_DIR=some-folder
  let row = await itemRow(legacy.id); let spec = JSON.parse(row.spec); assert.deepEqual([spec.rev, spec.logo.pos, spec.logo.scale], [1, 'top-left', 1.4]);
  assert.ok(fs.existsSync(path.join(IMG_DIR, `${legacy.id}.base.jpg`)), 'the picture without its logo is kept from now on');
  assert.ok(fs.readFileSync((await Img.versionFile(admin, legacy.id, 0)).path).equals(fin.buf), 'the original stays as version 0');
  assert.equal(row.withLogo, 1); assert.ok(told.some((t) => /Changed and sent again/.test(t.title)));
  console.log('PASS an older picture: the logo moved to the top left and made 40% bigger by TeamLink itself (no AI), the old spot filled from the colours around it and said so, the rest untouched, same size and format, version 0 kept, sent again');

  // ---- 3 the second change uses the clean copy: nothing is filled twice, the photograph comes back under the old spot ----
  const baseBefore = fs.readFileSync(path.join(IMG_DIR, `${legacy.id}.base.jpg`));
  const rv2 = await mkClient({ id: legacy.id }); await says(rv2, 'please move the logo to the bottom left corner');
  x = await R.run(rv2.id); assert.ok(x.revised, JSON.stringify(x)); assert.ok(/Moved the logo to the bottom left\./.test(x.changes.join(' ')) && !/filled/.test(x.changes.join(' ')), x.changes.join(' '));
  assert.ok(fs.readFileSync(path.join(IMG_DIR, `${legacy.id}.base.jpg`)).equals(baseBefore), 'the clean copy is not touched by the second change');
  const a2 = await fileRaw(legacy.id); const BL = { left: 19, top: 756 - 75 - 19 };
  assert.ok(whitish(a2, BL.left + 3, BL.top + 3) && whitish(a2, BL.left + 188 - 4, BL.top + 75 - 4), 'the logo is at the bottom left now, the same size as before');
  assert.ok(!whitish(a2, NEW.left + 3, NEW.top + 3), 'the top left is back to the picture'); assert.ok(meanDiff(a2, cleanRaw, 0, 0, 260, 140) < 4, 'the photograph under the earlier place is exact (from the clean copy)');
  assert.equal(JSON.parse((await itemRow(legacy.id)).spec).rev, 2);
  const rv3 = await mkClient({ id: legacy.id }); await says(rv3, 'the logo is too big'); x = await R.run(rv3.id); assert.ok(x.revised && /Made the logo 25% smaller/.test(x.changes.join(' ')), x.changes.join(' ') + JSON.stringify(x.revision));
  const rv4 = await mkClient({ id: legacy.id }); await says(rv4, 'put the logo at the bottom left'); x = await R.run(rv4.id); assert.equal(x.revision.status, 'needs-person', 'asked for what is already so: a person is told, nothing is sent'); assert.ok(/already at the bottom left/.test(x.revision.error), x.revision.error);
  console.log('PASS a second change: the clean copy is used (nothing filled twice, the photograph is exact again under the old spot), smaller works, a request for what is already so is not sent');

  // ---- 4 a picture with no logo: "add our logo top right" ----
  const nolog = await mkRow({ withLogo: 0, buf: photo, title: 'No logo yet' }); const rv5 = await mkClient({ id: nolog.id }); await says(rv5, 'please add our logo on the top right');
  x = await R.run(rv5.id); assert.ok(x.revised, JSON.stringify(x)); assert.ok(/Put the logo at the top right/.test(x.changes.join(' ')));
  const n1 = await fileRaw(nolog.id); assert.ok(whitish(n1, W - 140 - 19 + 3, 19 + 3), 'the logo is at the top right'); assert.equal((await itemRow(nolog.id)).withLogo, 1);
  const rv6 = await mkClient({ id: nolog.id }); await says(rv6, 'move the logo to the top left'); x = await R.run(rv6.id); assert.ok(x.revised); assert.ok(!whitish(await fileRaw(nolog.id), W - 140 - 19 + 3, 19 + 3), 'moving it again leaves no trace at the top right');
  console.log('PASS a picture with no logo: the logo is put where the client asked, and moves cleanly afterwards');

  // ---- 5 not done by rule: the picture AI drew the logo itself; the logo on a banner; words about other things ----
  const drawn = await mkRow({ model: 'gemini-2.5-flash-image', title: 'Logo drawn by Gemini' }); assert.ok(Img.logoWhy(await itemRow(drawn.id)), 'a logo the AI model drew cannot be moved by code');
  const asks = []; R.hooks.editFn = async (text, orig) => { asks.push(text); return sharp(orig).modulate({ brightness: 1.2 }).jpeg().toBuffer(); };
  const rv7 = await mkClient({ id: drawn.id }); await says(rv7, 'logo is small, make it bigger'); x = await R.run(rv7.id); assert.ok(x.revised && asks.length === 1 && x.revision.method === 'ai-edit', 'such a picture still goes to the picture AI, as before');
  R.hooks.editFn = null; const rv8 = await mkClient({ id: drawn.id }); await says(rv8, 'logo should be top left'); x = await R.run(rv8.id); assert.equal(x.revision.status, 'needs-person'); assert.ok(/not available|not connected|sandbox|AI/i.test(x.revision.error));
  console.log('PASS a logo drawn by the AI model still goes to the picture AI (or to a person), as before');
  const mixed = await mkRow({ title: 'Mixed request' }); const rv9 = await mkClient({ id: mixed.id }); await says(rv9, 'logo is small. Move it to the top right. Also change the heading to Hello'); x = await R.run(rv9.id);
  assert.ok(x.revised && /top right/.test(x.changes.join(' ')), JSON.stringify(x)); assert.deepEqual(x.unclear, ['Also change the heading to Hello'], 'what it could not do is said, not guessed'); assert.ok(told.some((t) => /could not do/.test(t.message)), 'the team is told which part was not done');
  console.log('PASS a request with something else in it: the logo is done, the rest is listed as not done');

  // ---- 6 "Try again" on Changes Requested ----
  R.hooks.editFn = null; const rv10 = await mkClient({ id: drawn.id }); await says(rv10, 'logo is too small'); x = await R.run(rv10.id); assert.equal(x.revision.status, 'needs-person');
  asks.length = 0; R.hooks.editFn = async (text, orig) => { asks.push(text); return sharp(orig).modulate({ brightness: 1.2 }).jpeg().toBuffer(); };
  const retried = await R.retryJob(admin, x.revision.id); assert.ok(retried.revised, JSON.stringify(retried)); assert.equal(asks.length, 1, 'Try again ran the same client request once more');
  const again = await R.retryJob(admin, x.revision.id); assert.ok(again.error && /already been dealt with|Only a failed/.test(again.error), 'once it is dealt with, Try again does nothing');
  console.log('PASS Try again on "Changes Requested": the same client request is run once more; a request already dealt with is refused');

  // ---- 7 new pictures keep the clean copy ----
  const made = await Img.create(admin, { prompt: 'a team meeting in a bright office', style: 'photo', aspect: '16:9', n: 1, withLogo: true, title: 'Base copy test' }, { wait: true });
  assert.ok(made && !made.error, JSON.stringify(made)); const items = made.items || (made.job && made.job.items) || []; assert.ok(items.length, JSON.stringify(made).slice(0, 300));
  const newId = items[0].id; assert.ok(fs.existsSync(path.join(IMG_DIR, `${newId}.base.jpg`)), 'a picture made with the logo keeps the picture without it beside it');
  const rv11 = await mkClient({ id: newId }); await says(rv11, 'keep the logo at the top left and bigger'); x = await R.run(rv11.id); assert.ok(x.revised, JSON.stringify(x)); assert.ok(!/filled/.test(x.changes.join(' ')), 'with a clean copy nothing is filled in');
  console.log('PASS a new picture keeps its clean copy: the logo moves with nothing filled in');
  console.log('ALL PASS mkLogoChange');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
