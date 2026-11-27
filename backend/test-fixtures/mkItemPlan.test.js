// AI Marketing > AI Images > "post after the client approves" (marketing/itemPlan.js, clientReview.js, postItem.js publishItem).
//   node backend/test-fixtures/mkItemPlan.test.js   (throw-away copy of prisma/sandbox.db and uploads; the social accounts, the publisher, WhatsApp and the team's bells are stand-ins: NOTHING is posted or sent anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plan-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
const IMG_DIR = path.join(process.env.UPLOAD_DIR, 'mk-images'); fs.mkdirSync(IMG_DIR, { recursive: true });
const notify = require('../src/utils/notify'); const told = []; notify.notifyUsers = async (ids, m) => { told.push({ ids, ...m }); }; // the team's bells are recorded (patched BEFORE the modules read it)
const S = require('../src/outreach/store');
const SA = require('../src/utils/socialAccounts'); const Pub = require('../src/marketing/publisher');
const Cfg = require('../src/marketing/settings'); const Img = require('../src/marketing/images'); const CR = require('../src/marketing/clientReview'); const Plan = require('../src/marketing/itemPlan'); const PI = require('../src/marketing/postItem'); const R = require('../src/marketing/revision');

const SITE = 'https://example-teamlink.test';
// stand-ins: fb1 / bad (Facebook), ig1 (Instagram), x1 (X), th1 (Threads: not postable from here), yt1 (YouTube: videos only), gone (not connected any more)
const PLATFORM = { fb1: 'facebook', bad: 'facebook', ig1: 'instagram', x1: 'x', th1: 'threads', yt1: 'youtube' }; const dead = new Set(['gone']);
SA.withToken = async (id) => (dead.has(id) || !PLATFORM[id] ? null : { account: { platform: PLATFORM[id], name: `Page ${id}` }, token: 't' });
const posted = []; const failIds = new Set();
Pub.publish = async (targets, media, caption) => { posted.push({ ids: targets.map((t) => t.accountId), media, caption }); return targets.map((t) => (failIds.has(t.accountId) ? { accountId: t.accountId, ok: false, name: t.name, platform: t.platform, error: 'The page refused it' } : { accountId: t.accountId, ok: true, name: t.name, platform: t.platform, url: `https://p.test/${t.accountId}` })); };
const tells = []; R.hooks.tell = async (u, id, b, base) => { tells.push({ id, ways: b.ways, base }); return { ok: 'Sent by WhatsApp.', sent: [{ way: 'WhatsApp', ok: true }] }; }; R.hooks.waitMs = 1;
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => { setTimeout(r, 50); }); } return false; };

(async () => {
  const admin = await require('../src/db').user.findFirst({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] } }); assert.ok(admin, 'the test database has an active admin');
  await Img.ensure(); await CR.ensure(); await R.ensure(); await Plan.ensure(); await PI.ensure();
  const allow = async (on) => Cfg.saveSettings({ ...(await Cfg.getSettings()), autoPostAllowed: on });
  const planRow = async (itemId) => (await S.q('SELECT * FROM "OmniMkItemPlan" WHERE itemId = ?', itemId))[0];
  const itemRow = async (id) => (await S.q('SELECT * FROM "OmniMkImage" WHERE id = ?', id))[0];
  const histOf = async (itemId) => S.q('SELECT * FROM "OmniMkItemPost" WHERE itemId = ? ORDER BY at ASC', itemId);
  const banner = async (over = {}) => { const m = await Img.createBanner(admin, { size: '16:9', layout: 'showcase', headline: 'Hire the right people', headline2: 'in Hyderabad', sub: 'Fast hiring for hospitals', chip: 'teamlink.in', audienceTitle: 'Who it is for:', audience: 'Job seekers', services: ['Nurses', 'IT Engineers'], title: `Plan banner ${Math.random().toString(36).slice(2, 6)}`, ...over }); assert.ok(m.item, JSON.stringify(m)); return m.item; };
  const mkReview = async (item, phone = '+919000000009') => { const out = await CR.create(admin, { kind: 'image', itemId: item.id, mode: 'decide', clientName: 'Plan Test Co', contactName: 'Sanjana', contactPhone: phone, contactEmail: '', days: 7 }); assert.ok(out.review, JSON.stringify(out)); await S.run('UPDATE "OmniMkClientReview" SET site = ? WHERE id = ?', SITE, out.review.id); return out.review; };
  const viewOf = async (rv) => CR.publicView(CR.tokenOf(rv.id));
  const decide = async (rv, o = {}) => CR.publicDecide(CR.tokenOf(rv.id), { decision: o.decision || 'approve', name: 'Sanjana', comment: o.comment || '', ...(o.allow ? { allowPosting: true, planKey: o.key } : {}) }, '1.2.3.4');
  const ARM = { accountIds: ['fb1', 'ig1'] };
  const setup = async (over = {}, arm = ARM) => { const item = await banner(over); const a = await Plan.arm(admin, (await Img.rawRow(item.id)), arm); assert.ok(a.plan, JSON.stringify(a)); const rv = await mkReview(item); const v = await viewOf(rv); return { item, rv, v, key: v.item.post && v.item.post.key }; };

  // ---- 1 the words: written from the banner's own words, nothing invented ----
  const b0 = await banner({ title: 'Words banner' }); const row0 = await Img.rawRow(b0.id); const sg = Plan.suggest(row0, await Cfg.getBrand());
  for (const w of ['Hire the right people in Hyderabad.', 'Fast hiring for hospitals.', 'Our services: Nurses, IT Engineers.', 'Who it is for: Job seekers.', 'Visit teamlink.in']) assert.ok(sg.caption.includes(w), `the caption has "${w}": ${sg.caption}`);
  assert.ok(sg.hashtags.length >= 3 && sg.hashtags.every((t) => /^#[\p{L}\p{N}]+$/u.test(t)) && sg.hashtags.includes('#Hyderabad') && sg.hashtags.includes('#Nurses'), sg.hashtags.join(' '));
  assert.ok(sg.text.endsWith(sg.hashtags.join(' ')), 'the hashtags follow the caption');
  const allowedWords = new Set(`${row0.spec} our services who it is for visit`.toLowerCase().match(/[\p{L}\p{N}]+/gu)); const stray = sg.caption.toLowerCase().match(/[\p{L}\p{N}]+/gu).filter((w) => !allowedWords.has(w)); assert.deepEqual(stray, [], `no word that is not on the banner (nothing invented): ${stray.join(', ')}`);
  assert.ok(!/\d/.test(sg.caption), 'no number, price or offer appears that the banner does not have');
  const sg2 = Plan.suggest({ ...row0, spec: JSON.stringify({ ...JSON.parse(row0.spec), sub: 'Create a premium, professional corporate marketing banner for TeamLink' }) }, {}); assert.ok(!/premium/i.test(sg2.caption), 'an instruction to a designer is never used as words');
  console.log('PASS the caption and hashtags come from the banner\'s own words: headline, sub-line, services, who it is for, website; no word, number or offer that is not on it; a designer\'s instruction is left out');

  // ---- 2 setting the plan: Admin switch, connected accounts only, X length, who may ----
  await allow(false); let r = await Plan.arm(admin, await Img.rawRow(b0.id), ARM); assert.deepEqual([r.status, r.code], [409, 'auto_off']);
  await allow(true);
  assert.ok((await Plan.arm(admin, await Img.rawRow(b0.id), { accountIds: ['gone'] })).error.includes('connect the account first'), 'an account that is not connected cannot be picked');
  assert.equal((await Plan.arm(admin, await Img.rawRow(b0.id), { accountIds: ['fb1', 'th1'] })).status, 400, 'Threads cannot be posted to from here');
  assert.ok(/YouTube takes videos only/.test((await Plan.arm(admin, await Img.rawRow(b0.id), { accountIds: ['yt1'] })).error), 'a picture is never planned for YouTube');
  assert.equal((await Plan.arm(admin, await Img.rawRow(b0.id), { accountIds: [] })).status, 400);
  assert.equal((await Plan.arm(admin, await Img.rawRow(b0.id), { accountIds: ['x1'], caption: 'x'.repeat(300) })).status, 400, 'X takes 280 characters');
  assert.equal((await Plan.arm({ id: 'someone-else', name: 'Other', role: 'EMPLOYEE', atsRole: 'EMPLOYEE' }, await Img.rawRow(b0.id), ARM)).status, 403, 'only the person who made it, or an Admin');
  r = await Plan.arm(admin, await Img.rawRow(b0.id), ARM); assert.equal(r.plan.state, 'armed'); assert.equal(r.plan.label, 'Will post after the client approves'); assert.deepEqual(r.plan.accounts.map((a) => a.accountId), ['fb1', 'ig1']); assert.equal(r.plan.caption, sg.text, 'with no words typed, the written ones are used');
  const cols = (await S.q('PRAGMA table_info("OmniMkItemPlan")')).map((c) => c.name.toLowerCase()); assert.ok(!cols.some((c) => /pass|user(name)?$|login|token|secret|cookie/.test(c)), `nothing like a password or token is stored: ${cols.join(',')}`);
  const att = await Plan.attach([{ id: b0.id }, { id: 'none' }]); assert.ok(att[0].plan && att[0].plan.switchOn && !att[1].plan, 'the card gets the plan');
  console.log('PASS the plan: needs the Admin switch, connected Facebook / Instagram / X accounts only ("connect the account first"), X length, only the maker or an Admin; no username or password column exists');

  // ---- 3 what the client sees and the message: the exact picture, accounts and words ----
  const F = await setup({ title: 'Flow A' }); assert.ok(F.v.item.post && F.v.item.post.when === 'with', 'the review page carries the accounts and the exact words'); assert.deepEqual(F.v.item.post.accounts.map((a) => a.name), ['Page fb1', 'Page ig1']); assert.equal(F.v.item.post.caption, (await planRow(F.item.id)).caption);
  assert.ok(!('createdById' in F.v.item.post) && !('state' in F.v.item.post), 'the client page gets only the accounts and the words');
  const note = await Plan.clientNote(F.item.id, `${SITE}/client-review/abc`, 0); assert.ok(note.includes('Page fb1 (Facebook), Page ig1 (Instagram)') && note.includes(F.v.item.post.caption) && note.includes('tick the box') && /Approve button here approves the picture only/.test(note), 'the WhatsApp text names the accounts, gives the exact words, says where to tick, and that the Approve button does not post');
  const cut = await Plan.clientNote(F.item.id, `${SITE}/client-review/abc`, 420); assert.ok(cut.length <= 440 && cut.includes('all the words are on the link') && cut.includes('tick the box'), 'a long caption is cut for the WhatsApp picture caption and says the rest is on the link');
  console.log('PASS the client sees the accounts and the exact words (nothing else of the plan) on the review page and in the WhatsApp text, with where to tick');

  // ---- 4 approve WITH the client's own tick: posted by itself, that version only ----
  Plan.kick.force = true; posted.length = 0; told.length = 0;
  let out = await decide(F.rv, { allow: true, key: F.key }); assert.ok(out.ok && /being posted/.test(out.ok), JSON.stringify(out));
  assert.ok(await until(async () => (await planRow(F.item.id)).state === 'posted'), `posted by itself: ${JSON.stringify(await planRow(F.item.id))}`); Plan.kick.force = false;
  let pr = await planRow(F.item.id); assert.deepEqual([pr.consentBy, pr.consentVersion], ['Sanjana', 1]); assert.ok(S.num(pr.consentAt) > 0 && JSON.parse(pr.consentIds).join() === 'fb1,ig1' && pr.consentCaption === pr.caption, 'the permission is saved with name, time, accounts and the exact words');
  assert.equal(posted.length, 1); assert.deepEqual(posted[0].ids, ['fb1', 'ig1']); assert.equal(posted[0].caption, pr.caption, 'the words that went out are the words the client saw'); assert.ok(posted[0].media.url.startsWith(SITE) && fs.existsSync(posted[0].media.path), 'the picture file is the one on the server');
  assert.ok(fs.readFileSync(posted[0].media.path).equals(fs.readFileSync(path.join(IMG_DIR, (await itemRow(F.item.id)).file))), 'the file posted is the file the client approved');
  assert.equal((await histOf(F.item.id)).length, 2, 'one history row per account'); assert.ok(told.some((t) => /^Posted:/.test(t.title)), 'the team gets a bell on posted'); assert.ok(told.some((t) => /approved/.test(t.title) && /allowed posting/.test(t.message)));
  const done = await Plan.summary(F.item.id); assert.equal(done.state, 'posted'); assert.deepEqual(done.results.map((x) => [x.name, x.ok, x.url]), [['Page fb1', true, 'https://p.test/fb1'], ['Page ig1', true, 'https://p.test/ig1']]);
  assert.deepEqual(await Plan.run(F.item.id), { skipped: 'state posted' }, 'nothing is posted twice'); assert.equal((await Plan.retry(admin, await Img.rawRow(F.item.id))).status, 409); assert.equal(posted.length, 1);
  assert.equal((await decide(F.rv, { allow: true, key: F.key })).status, 409, 'a repeated tap on the same link does nothing'); assert.equal(posted.length, 1);
  console.log('PASS approve with the client\'s own tick: posted by itself on exactly the accounts and words shown, the file they approved, history per account, bell, audit; a second run, Retry or tap posts nothing more');

  // ---- 5 approve WITHOUT a tick (the WhatsApp Approve button): approved, NOT posted; the link still lets them allow it ----
  const G = await setup({ title: 'Flow B' }); posted.length = 0; told.length = 0;
  const btn = await CR.answerByButton(G.rv.id, true, '9000000009', null); assert.equal(btn.note, 'approved'); assert.ok(btn.reply.includes(`${SITE}/client-review/`) && /until you allow it/.test(btn.reply), 'the reply on WhatsApp says how to allow the posting');
  assert.equal((await itemRow(G.item.id)).status, 'approved'); assert.equal((await planRow(G.item.id)).state, 'consent'); assert.deepEqual(await Plan.run(G.item.id), { skipped: 'state consent' }); assert.equal(posted.length, 0, 'a tap alone never posts');
  assert.ok(told.some((t) => /did NOT tick/.test(t.message)), 'the team is told it was not posted and why');
  const later = await viewOf(G.rv); assert.equal(later.review.status, 'approved'); assert.equal(later.item.post.when, 'later');
  assert.equal((await CR.publicAllowPosting(CR.tokenOf(G.rv.id), { name: 'Sanjana', allowPosting: false, planKey: later.item.post.key })).status, 400, 'no tick, no permission');
  assert.equal((await CR.publicAllowPosting(CR.tokenOf(G.rv.id), { name: 'Sanjana', allowPosting: true, planKey: 'wrong' })).status, 409, 'a tick that does not match the words shown is refused');
  assert.equal((await CR.publicAllowPosting(CR.tokenOf(G.rv.id), { name: '', allowPosting: true, planKey: later.item.post.key })).status, 400);
  Plan.kick.force = true; out = await CR.publicAllowPosting(CR.tokenOf(G.rv.id), { name: 'Sanjana', allowPosting: true, planKey: later.item.post.key }); assert.ok(out.ok, JSON.stringify(out)); assert.ok(await until(async () => (await planRow(G.item.id)).state === 'posted')); Plan.kick.force = false;
  assert.deepEqual(posted[0].ids, ['fb1', 'ig1']); assert.equal((await planRow(G.item.id)).consentBy, 'Sanjana');
  assert.equal((await CR.publicAllowPosting(CR.tokenOf(G.rv.id), { name: 'Sanjana', allowPosting: true, planKey: later.item.post.key })).status, 409, 'allowed once; asking again does nothing'); assert.equal(posted.length, 1);
  console.log('PASS the Approve button on WhatsApp approves but does not post (the team is told); the client can allow it afterwards on the same link, with a matching tick; then it posts once');

  // ---- 6 suggestions with the approval, no plan, the Admin switch, a tick that is stale ----
  const H = await setup({ title: 'Flow C' }); posted.length = 0; out = await decide(H.rv, { allow: true, key: H.key, comment: 'looks good but make the font bigger next time' }); assert.ok(out.ok && !/being posted/.test(out.ok));
  assert.equal((await planRow(H.item.id)).state, 'review'); assert.deepEqual(await Plan.run(H.item.id), { skipped: 'state review' }); assert.equal(posted.length, 0, 'approved with suggestions: the team reads them first, nothing is posted by itself');
  const N = await banner({ title: 'No plan' }); const nrv = await mkReview(N); assert.ok(!(await viewOf(nrv)).item.post, 'no plan: the client is asked nothing'); out = await decide(nrv, { allow: true, key: 'x' }); assert.ok(out.ok); assert.equal(posted.length, 0); assert.equal(await planRow(N.id), undefined);
  const O = await setup({ title: 'Flow D' }); await allow(false); assert.ok(!(await viewOf(O.rv)).item.post, 'the Admin switch is off: the client is not asked for a permission that cannot be used'); out = await decide(O.rv, { allow: true, key: O.key }); assert.ok(out.ok); assert.equal((await planRow(O.item.id)).state, 'consent'); assert.ok(told.some((t) => /switched off posting/.test(t.message))); await allow(true);
  const Q = await setup({ title: 'Flow E' }); await Plan.arm(admin, await Img.rawRow(Q.item.id), { accountIds: ['fb1'], caption: 'New words the client has not read' }); out = await decide(Q.rv, { allow: true, key: Q.key });
  assert.equal(out.status, 409); assert.ok(/changed while this page was open/.test(out.error), 'the words changed while the page was open: the tick is refused, the client reads them again'); assert.equal((await S.q('SELECT status FROM "OmniMkClientReview" WHERE id = ?', Q.rv.id))[0].status, 'sent', 'and the picture is still waiting for their answer');
  assert.equal(posted.length, 0);
  console.log('PASS approved with suggestions: not posted; no plan: nothing asked or posted; Admin switch off: not posted and said so; words changed while the page was open: the tick is refused');

  // ---- 7 changes asked: no consent; the next version posts, not the original ----
  const V = await setup({ title: 'Flow F' }, { accountIds: ['fb1'] }); posted.length = 0; tells.length = 0;
  const original = fs.readFileSync(path.join(IMG_DIR, (await itemRow(V.item.id)).file)); const cap1 = (await planRow(V.item.id)).caption;
  out = await CR.publicDecide(CR.tokenOf(V.rv.id), { decision: 'changes', name: 'Sanjana', comment: 'the headline should be Hiring nurses today', allowPosting: true, planKey: V.key }, '1.2.3.4'); assert.ok(out.ok);
  let pl = await planRow(V.item.id); assert.ok(!pl.consentAt && pl.state === 'armed' || pl.state === 'armed', 'asking for changes never gives permission'); assert.equal(posted.length, 0);
  const x = await R.run(V.rv.id); assert.ok(x.revised, JSON.stringify(x)); assert.equal(tells.length, 1, 'the new version was sent on the same link');
  pl = await planRow(V.item.id); assert.equal(pl.state, 'armed'); assert.ok(!pl.consentAt, 'the old permission is spent'); assert.notEqual(pl.caption, cap1, 'words the team never edited follow the changed banner'); assert.ok(/Hiring nurses today/i.test(pl.caption), pl.caption);
  const v2 = await viewOf(V.rv); assert.equal(v2.item.version, 2); assert.ok(v2.item.post && v2.item.post.when === 'with' && v2.item.post.caption === pl.caption, 'the client sees version 2 with the NEW words');
  Plan.kick.force = true; out = await decide(V.rv, { allow: true, key: v2.item.post.key }); assert.ok(out.ok); assert.ok(await until(async () => (await planRow(V.item.id)).state === 'posted')); Plan.kick.force = false;
  pl = await planRow(V.item.id); assert.equal(pl.consentVersion, 2); assert.equal(posted.length, 1); const sentFile = fs.readFileSync(posted[0].media.path); assert.ok(sentFile.equals(fs.readFileSync(path.join(IMG_DIR, (await itemRow(V.item.id)).file))) && !sentFile.equals(original), 'the approved version 2 was posted, never the original'); assert.equal(posted[0].caption, pl.caption);
  console.log('PASS changes asked: no permission from that answer; the new version is shown with the new words and its own tick; the approved version 2 is what posts, never the original');

  // ---- 8 the checks before a post: picture changed, Admin switch, newer request, accounts, a hand post ----
  const prime = async (name, arm = ARM) => { const s = await setup({ title: name }, arm); await decide(s.rv, { allow: true, key: s.key }); assert.equal((await planRow(s.item.id)).state, 'consented'); return s; }; // consented, not posted yet (the sandbox does not start the post by itself)
  posted.length = 0; told.length = 0;
  let c = await prime('Check A'); fs.appendFileSync(path.join(IMG_DIR, (await itemRow(c.item.id)).file), 'x'); await S.run('UPDATE "OmniMkImage" SET bytes = bytes + 1 WHERE id = ?', c.item.id); out = await Plan.run(c.item.id); assert.equal(out.state, 'blocked'); assert.ok(/changed after the client allowed posting/.test(out.reason)); assert.equal(posted.length, 0, 'the picture changed after the tick: not posted');
  c = await prime('Check B'); await allow(false); out = await Plan.run(c.item.id); assert.ok(out.state === 'blocked' && /switched off posting/.test(out.reason)); await allow(true); out = await Plan.retry(admin, await Img.rawRow(c.item.id), SITE); assert.equal(out.state, 'posted', 'Retry after the Admin switched it on again posts'); assert.equal(posted.length, 1);
  c = await prime('Check C'); const openRv = await CR.create(admin, { kind: 'image', itemId: c.item.id, clientName: 'Plan Test Co', contactPhone: '+919000000009', days: 7 }); assert.ok(openRv.review, JSON.stringify(openRv)); const open = openRv.review; out = await Plan.run(c.item.id); assert.ok(out.state === 'blocked' && /newer request/.test(out.reason), 'a newer request to the client is open: nothing is posted'); await S.run(`UPDATE "OmniMkClientReview" SET status = 'revoked' WHERE id = ?`, open.id); void open;
  c = await prime('Check D'); await S.run('UPDATE "OmniMkClientReview" SET site = NULL WHERE itemId = ?', c.item.id); await S.run('UPDATE "OmniMkItemPlan" SET site = NULL WHERE itemId = ?', c.item.id); const saved = process.env.APP_BASE_URL; delete process.env.APP_BASE_URL; out = await Plan.run(c.item.id); assert.ok(out.state === 'blocked' && /https address/.test(out.reason), 'Facebook / Instagram need the site\'s https address'); process.env.APP_BASE_URL = saved || ''; out = await Plan.retry(admin, await Img.rawRow(c.item.id), SITE); assert.equal(out.state, 'posted', 'Retry from the live site posts');
  c = await prime('Check E'); dead.add('ig1'); posted.length = 0; out = await Plan.run(c.item.id); dead.delete('ig1'); assert.equal(out.state, 'failed'); assert.deepEqual(posted.map((p) => p.ids), [['fb1']], 'the account that is still connected is posted'); assert.ok(out.reason.includes('connect the account first'), out.reason);
  out = await Plan.retry(admin, await Img.rawRow(c.item.id), SITE); assert.equal(out.state, 'posted'); assert.deepEqual(posted.map((p) => p.ids), [['fb1'], ['ig1']], 'Retry posts only the account that did not go out (fb1 is not posted again)');
  c = await prime('Check F'); posted.length = 0; const manual = await PI.postItem(admin, c.item.id, { accountIds: ['fb1'], caption: 'by hand', confirm: true }, SITE); assert.ok(manual.posted); out = await Plan.run(c.item.id); assert.equal(out.state, 'posted'); assert.deepEqual(posted.map((p) => p.ids), [['fb1'], ['ig1']], 'an account a person already posted to after the client allowed it is not posted again');
  console.log('PASS the checks: a changed picture, the Admin switch, a newer open request, no https address, a disconnected account (the others still post), a post made by hand: each held back or skipped, with the reason, and Retry posts only what is missing');

  // ---- 9 a failure: never marked posted, why per account, Retry only the failed one, bells, history ----
  PLATFORM.bad = 'facebook'; const FF = await prime('Fail flow', { accountIds: ['fb1', 'bad'] }); posted.length = 0; told.length = 0; failIds.add('bad');
  out = await Plan.run(FF.item.id); assert.equal(out.state, 'failed'); let sm = await Plan.summary(FF.item.id); assert.equal(sm.state, 'failed'); assert.ok(!sm.postedAt, 'a failure is never marked posted'); assert.deepEqual(sm.results.map((x) => [x.name, x.ok, x.error]), [['Page fb1', true, ''], ['Page bad', false, 'The page refused it']]); assert.ok(sm.canRetry);
  assert.ok(told.some((t) => /^Posting failed/.test(t.title) && t.message.includes('Page bad: The page refused it') && /posted on Page fb1/.test(t.message)), 'the team gets a bell on the failure, per account');
  assert.deepEqual((await histOf(FF.item.id)).map((h) => [h.accountId, S.num(h.ok)]), [['fb1', 1], ['bad', 0]]); posted.length = 0;
  out = await Plan.retry(admin, await Img.rawRow(FF.item.id), SITE); assert.equal(out.state, 'failed'); assert.deepEqual(posted.map((p) => p.ids), [['bad']], 'Retry posts only the account that failed'); failIds.delete('bad'); posted.length = 0;
  out = await Plan.retry(admin, await Img.rawRow(FF.item.id), SITE); assert.equal(out.state, 'posted'); assert.deepEqual(posted.map((p) => p.ids), [['bad']]); assert.equal((await histOf(FF.item.id)).filter((h) => S.num(h.ok) === 1).length, 2, 'each account has exactly one good post');
  const [r1, r2] = await Promise.all([prime('Race flow').then((s) => Promise.all([Plan.run(s.item.id), Plan.run(s.item.id)]))]).then((a) => a[0]); posted.length = 0; void r1; void r2;
  const RR = await prime('Race two', { accountIds: ['fb1'] }); posted.length = 0; const both = await Promise.all([Plan.run(RR.item.id), Plan.run(RR.item.id), Plan.retry(admin, await Img.rawRow(RR.item.id), SITE)]); assert.equal(posted.length, 1, `three at once post once (${JSON.stringify(both.map((b) => b.state || b.skipped || b.error))})`);
  const SS = await prime('Stuck flow'); await S.run(`UPDATE "OmniMkItemPlan" SET state = 'posting', updatedAt = ? WHERE itemId = ?`, Date.now() - 20 * 60000, SS.item.id); sm = await Plan.summary(SS.item.id); assert.ok(sm.state === 'failed' && /stopped part-way|did not start/.test(sm.reason) && sm.canRetry, 'a post the server stopped in the middle shows as failed with Retry'); posted.length = 0; out = await Plan.retry(admin, await Img.rawRow(SS.item.id), SITE); assert.equal(out.state, 'posted');
  console.log('PASS a failure: never marked posted, why per account, bell to the team, Retry posts only the failed account, no account is posted twice (also when run three times at once); a stopped post shows as failed with Retry');

  // ---- 10 editing the plan after the client allowed it cancels the permission; switching it off ----
  const E = await prime('Edit flow'); await Plan.arm(admin, await Img.rawRow(E.item.id), { accountIds: ['fb1'] }); pl = await planRow(E.item.id); assert.equal(pl.state, 'armed'); assert.ok(!pl.consentAt && !pl.consentCaption, 'a changed plan cancels the earlier permission: the client has to allow the new words'); assert.deepEqual(await Plan.run(E.item.id), { skipped: 'state armed' });
  const same = await prime('Same flow'); await Plan.arm(admin, await Img.rawRow(same.item.id), ARM); assert.equal((await planRow(same.item.id)).state, 'consented', 'saving the same plan again keeps the permission');
  const offp = await setup({ title: 'Off flow' }); assert.ok((await Plan.clear(admin, await Img.rawRow(offp.item.id))).ok); assert.equal(await planRow(offp.item.id), undefined); assert.ok(!(await viewOf(offp.rv)).item.post);
  assert.equal((await Plan.clear(admin, await Img.rawRow(F.item.id))).status, 409, 'a plan that already posted cannot be switched off');
  console.log('PASS editing the plan cancels the permission, saving it unchanged keeps it, switching it off removes it from the client page; a posted plan stays as the record');

  console.log('ALL PASS mkItemPlan');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
