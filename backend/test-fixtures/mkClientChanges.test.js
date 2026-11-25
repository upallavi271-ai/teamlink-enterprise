// AI Marketing > client approval: "the client asked for changes" -> TeamLink changes the picture and sends it again by itself (marketing/revise.js, revision.js, images.js versions, clientReview.js reopen).
//   node backend/test-fixtures/mkClientChanges.test.js   (throw-away copy of prisma/sandbox.db and uploads; WhatsApp, the AI models and the stock photos are stand-ins: nothing real is called or sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-changes-'));
const tmp = path.join(work, 'copy.db'); fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });
const notify = require('../src/utils/notify'); const told = []; notify.notifyUsers = async (ids, m) => { told.push({ ids, ...m }); }; // the team's notices are recorded
const sharp = require('sharp'); const S = require('../src/outreach/store');
const Rev = require('../src/marketing/revise'); const Img = require('../src/marketing/images'); const CR = require('../src/marketing/clientReview'); const R = require('../src/marketing/revision'); const Cfg = require('../src/marketing/settings'); const B = require('../src/marketing/banner');

const FEEDBACK = 'the link should be in one line and under the line a recruitment and staffing consultancy. u gave create a premium, professional corporate… as a prompt itself';
const showcase = (o = {}) => ({ size: '16:9', layout: 'showcase', headline: 'A recruitment and', headline2: 'staffing consultancy.', sub: 'Create a premium, professional corporate marketing banner for TeamLink Consultants (OPC) Pvt.', chip: 'https://teamlink.teamlinks.in', chipPos: 'bottom', audienceTitle: 'Who it is for:', audience: 'Job seekers in health care and IT sector', services: [], plans: [], colors: {}, rev: 0, handled: [], ...o });
const tells = []; const stubTell = async (u, id, b, base) => { tells.push({ id, ways: b.ways, base }); return { ok: 'Sent by WhatsApp.', sent: [{ way: 'WhatsApp', ok: true }] }; };
const raw = async (buf) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
const near = (R2, x, y, c, d = 14) => { const i = (y * R2.w + x) * 4; return Math.abs(R2.data[i] - c[0]) < d && Math.abs(R2.data[i + 1] - c[1]) < d && Math.abs(R2.data[i + 2] - c[2]) < d; };
// the website pill: the rows that hold a long run of the accent colour (text is thin: its runs are short), then the rows of dark text inside it
function pill(R2, x0, x1, y0, y1, accent = [251, 191, 36]) {
  const rows = []; for (let y = y0; y < y1; y += 1) { let run = 0; let best = 0; let sx = 0; let bx = 0; for (let x = x0; x < x1; x += 1) { if (near(R2, x, y, accent)) { if (!run) sx = x; run += 1; if (run > best) { best = run; bx = sx; } } else run = 0; } if (best >= 220) rows.push({ y, x: bx, len: best }); }
  if (!rows.length) return null;
  const top = rows[0].y; const bottom = rows[rows.length - 1].y; const minX = Math.min(...rows.map((r) => r.x)); const maxX = Math.max(...rows.map((r) => r.x + r.len));
  const dark = []; for (let y = top; y <= bottom; y += 1) for (let x = minX + 90; x < maxX - Math.round((bottom - top + 1) * 0.6); x += 1) { const i = (y * R2.w + x) * 4; if (R2.data[i] < 90 && R2.data[i + 1] < 90 && R2.data[i + 2] < 100) { dark.push(y); break; } }
  return { top, bottom, minX, maxX, height: bottom - top + 1, band: dark.length ? dark[dark.length - 1] - dark[0] + 1 : 0 };
}

(async () => {
  const admin = await require('../src/db').user.findFirst({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] } }); assert.ok(admin, 'the test database has an active admin');
  await Img.ensure(); await CR.ensure(); await R.ensure(); R.hooks.waitMs = 0; R.hooks.tell = stubTell;

  // ---- 1. reading the client's words ----
  let o = Rev.interpret(showcase(), FEEDBACK);
  assert.deepEqual(o.changes.map((c) => c.key), ['chipPos', 'chipOneLine', 'sub'], JSON.stringify(o)); assert.deepEqual(o.unclear, []);
  assert.deepEqual([o.spec.chipPos, o.spec.sub, o.spec.headline, o.spec.headline2, o.spec.audience, o.spec.chip], ['under-headline', '', 'A recruitment and', 'staffing consultancy.', 'Job seekers in health care and IT sector', 'https://teamlink.teamlinks.in'], 'only what was named changes');
  assert.ok(/under the headline/.test(o.summary[0]) && /one line/.test(o.summary[1]) && /Create a premium/.test(o.summary[2]));
  const note = Rev.clientNote(o); assert.ok(/^We have made the changes you asked for\./.test(note) && /Please look at it again\.$/.test(note) && note.length <= 400);
  const two = (fb, s = showcase()) => Rev.interpret(s, fb);
  o = two('Change "recruitment" to "hiring".'); assert.deepEqual([o.changes.length, o.spec.headline], [1, 'A hiring and']);
  o = two('the headline should be Hire Faster Today'); assert.equal(o.spec.headline, 'Hire Faster Today');
  o = two('the website link should be www.teamlink.in'); assert.equal(o.spec.chip, 'www.teamlink.in');
  o = two('please remove the website link'); assert.equal(o.spec.chip, ''); o = two('remove who it is for'); assert.deepEqual([o.spec.audience, o.spec.audienceTitle], ['', '']);
  o = two('write Hiring instead of Recruitment'); assert.equal(o.spec.headline, 'A Hiring and'); o = two('make it green'); assert.equal(o.spec.colors.primary, '#15803d'); assert.ok(/green/.test(o.summary[0]));
  o = two('change the picture', showcase({ heroSearch: 'office', heroN: 19 })); assert.equal(o.spec.heroN, 0, 'the next stock picture, wrapping round'); o = two('change the picture'); assert.deepEqual([o.changes.length, o.unclear.length], [0, 1]); assert.ok(/chosen by a person/.test(o.unclear[0]), 'a picture a person chose cannot be swapped by itself');
  o = two('the link should be under the picture'); assert.deepEqual([o.changes.length, o.spec.chipPos], [0, 'bottom']); o = two('the link under the headline', showcase({ layout: 'split', chip: '' })); assert.ok(o.unclear[0].includes('no website link'));
  o = two('I do not understand this at all'); assert.deepEqual([o.changes.length, o.unclear.length], [0, 1]); o = two('రంగు మార్చండి'); assert.equal(o.changes.length, 0, 'words in another language are not guessed');
  o = two('Change "Zebra" to "Lion"'); assert.deepEqual([o.changes.length, o.unclear.length], [0, 1], 'words that are not on the banner are not changed');
  o = two('the link in one line. make it blue. the colours are nice'); assert.deepEqual(o.changes.map((c) => c.key), ['chipOneLine', 'colors']); assert.equal(o.unclear.length, 1, 'a part with no request stays unclear and is said');
  assert.deepEqual([Rev.classify('please redo this from scratch'), Rev.classify('we do not like it, a completely different design'), Rev.classify(FEEDBACK)], ['new_design', 'new_design', 'correction']);
  const nd = Rev.variation(showcase({ heroSearch: 'office' })); assert.ok(nd.spec.colors.primary && nd.spec.heroN === 1 && nd.spec.chipPos === 'under-headline' && /new design with the same words/.test(nd.summary[0]) && nd.spec.headline === 'A recruitment and', 'a new design keeps the words');
  console.log('PASS reading the words: the real feedback (link under the headline, one line, the instruction text removed), change X to Y, set the headline / link, remove parts, a colour, another stock picture, a new-design request; unclear parts are never guessed');

  // the AI reads only what the rules left unclear, and everything it says is checked
  const ai = (ans) => ({ ask: async () => ans });
  o = await Rev.understand(showcase(), 'please make the heading sound friendlier', ai({ classification: 'correction', confidence: 0.9, changes: [{ field: 'headline', action: 'set', value: 'Hire the right people' }, { field: 'logo', action: 'clear' }, { field: 'headline2', action: 'set', value: 'Create a premium banner for us' }, { field: 'sub', action: 'set', value: '<script>x</script>Fast hiring' }], unclear: [] }));
  assert.deepEqual([o.method, o.spec.headline, o.spec.headline2, o.spec.sub], ['ai', 'Hire the right people', 'staffing consultancy.', 'xFast hiring'], 'a field the banner does not have, and an instruction used as text, are ignored; markup is stripped');
  assert.equal(o.changes.length, 2);
  o = await Rev.understand(showcase(), 'make it nicer', ai({ confidence: 0.4, changes: [{ field: 'headline', action: 'set', value: 'Something else' }] })); assert.deepEqual([o.changes.length, o.spec.headline], [0, 'A recruitment and'], 'a doubtful AI answer is ignored');
  o = await Rev.understand(showcase(), 'make it nicer', { ask: async () => { throw new Error('AI is not ready'); } }); assert.equal(o.changes.length, 0); assert.equal(o.method, 'rules');
  let asked = 0; o = await Rev.understand(showcase(), 'make it blue', { ask: async () => { asked += 1; return null; } }); assert.deepEqual([asked, o.changes.length], [0, 1], 'the AI is not asked when the rules understood everything');
  o = await Rev.understand(showcase(), 'make it blue. make the heading friendlier', ai({ confidence: 0.8, changes: [{ field: 'headline', action: 'set', value: 'Friendly hiring' }], unclear: [] })); assert.deepEqual([o.method, o.changes.length, o.spec.colors.primary, o.spec.headline], ['rules+ai', 2, '#1d4ed8', 'Friendly hiring']);
  o = await Rev.understand(showcase(), 'we want something else entirely', ai({ classification: 'new_design', confidence: 0.9, changes: [] })); assert.equal(o.classification, 'new_design');
  console.log('PASS the AI step: asked only when the rules left something unclear, only the banner\'s own fields, no instruction or markup as text, a doubtful answer ignored, no AI ready = the rules stand');

  // ---- 2. the banner itself: the link on ONE line, and where it sits ----
  const draw = (o2 = {}) => B.makeBanner({ size: '16:9', layout: 'showcase', headline: 'A recruitment and', headline2: 'staffing consultancy.', sub: '', chip: 'https://teamlink.teamlinks.in', audienceTitle: 'Who it is for:', audience: 'Job seekers in health care and IT sector', services: [], plans: [], colors: { primary: '#0f766e', accent: '#fbbf24' }, companyName: 'TeamLink', ...o2 });
  const bottom = await draw({ chipPos: 'bottom' }); const under = await draw({ chipPos: 'under-headline' });
  assert.deepEqual([bottom.w, bottom.h, under.w, under.h], [1920, 1080, 1920, 1080], 'the same size');
  const rb = await raw(bottom.buf); const ru = await raw(under.buf);
  const pb = pill(rb, Math.round(rb.w * 0.5), rb.w, Math.round(rb.h * 0.7), rb.h); const pu = pill(ru, 0, Math.round(ru.w * 0.5), Math.round(ru.h * 0.12), Math.round(ru.h * 0.62));
  assert.ok(pb && pb.height >= 60 && pb.band > 8 && pb.band <= pb.height * 0.58, `bottom pill: ${JSON.stringify(pb)}`); assert.ok(pu && pu.height >= 40 && pu.band > 8 && pu.band <= pu.height * 0.58, `under-headline pill: ${JSON.stringify(pu)}`);
  assert.ok(pb.maxX - pb.minX > 330, 'the pill grew to the whole address'); assert.ok(pu.minX < ru.w * 0.1 && pu.bottom < ru.h * 0.62, 'the link sits right under the headline, at the left'); assert.ok(pb.top > rb.h * 0.7, 'the other placement stays at the bottom');
  const longer = await raw((await draw({ chip: 'https://teamlink.teamlinks.in/recruitment-and-staffing-for-hospitals', chipPos: 'bottom' })).buf); const pl = pill(longer, Math.round(longer.w * 0.45), longer.w, Math.round(longer.h * 0.7), longer.h); assert.ok(pl && pl.band <= pl.height * 0.58, 'even a very long address stays on one line (the text shrinks)');
  console.log('PASS the banner: the website link is one line (the pill grows to the address, long ones shrink), it can sit right under the headline or stay at the bottom, same size');

  // ---- 3. a banner keeps its look, and a picture changed after a client request keeps every version ----
  const made = await Img.createBanner(admin, { size: '16:9', layout: 'showcase', headline: 'A recruitment and', headline2: 'staffing consultancy.', sub: 'Create a premium, professional corporate marketing banner for TeamLink Consultants (OPC) Pvt.', chip: 'https://teamlink.teamlinks.in', audienceTitle: 'Who it is for:', audience: 'Job seekers in health care and IT sector', title: 'TeamLink Consultants · 1' });
  assert.ok(made.item, JSON.stringify(made)); assert.ok(made.warnings.length === 1 && /looked like an instruction/.test(made.warnings[0]), 'text that is an instruction to a designer is left out of the banner, with a warning');
  const spec0 = JSON.parse((await S.q('SELECT spec FROM "OmniMkImage" WHERE id = ?', made.item.id))[0].spec); assert.deepEqual([spec0.sub, spec0.chip, spec0.chipPos, spec0.rev, spec0.layout, spec0.headline2], ['', 'https://teamlink.teamlinks.in', 'bottom', 0, 'showcase', 'staffing consultancy.'], 'the look is kept with the picture'); assert.equal(made.item.version, 1);
  const item0 = made.item; const file0 = path.join(process.env.UPLOAD_DIR, 'mk-images', `${item0.id}.png`); const original = fs.readFileSync(file0);
  assert.deepEqual(Img.looksLikePrompt('Create a premium banner for X'), true); assert.equal(Img.looksLikePrompt('Hire faster with TeamLink'), false);
  const noop = await Img.reviseBanner(admin, item0.id, { ...spec0 }, 'x', R.validate); assert.deepEqual([noop.code, /no visible difference/.test(noop.error), fs.readFileSync(file0).equals(original)], ['invalid', true, true], 'a change that changes nothing is refused and the picture is untouched');
  assert.ok((await Img.versionFile(admin, item0.id, 0)).path.endsWith(`${item0.id}.png`) && (await Img.versionFile(admin, item0.id, 1)) === null, 'before any change there is only the original');
  console.log('PASS versions begin: the look is saved with the banner, instruction text is left out with a warning, a change that changes nothing is refused');

  // ---- 4. the whole job: client asks, TeamLink changes it and sends it again on the SAME link ----
  const mkClient = async (item, phone = '+919000000009') => { const rv = await CR.create(admin, { kind: 'image', itemId: item.id, mode: 'decide', clientName: 'Change Test Co', contactName: 'Sanjana', contactPhone: phone, contactEmail: '', days: 7 }); assert.ok(rv.review, JSON.stringify(rv)); return rv.review; };
  const says = async (rv, text, how = 'changes') => { const out = await CR.publicDecide(CR.tokenOf(rv.id), { decision: how, name: 'Sanjana', comment: text }, '1.2.3.4'); assert.ok(out.ok, JSON.stringify(out)); return out; };
  const review = await mkClient(item0); const token = CR.tokenOf(review.id); const itemRow = async (id) => (await S.q('SELECT * FROM "OmniMkImage" WHERE id = ?', id))[0];
  assert.equal((await itemRow(item0.id)).status, 'waiting');
  await says(review, `${FEEDBACK.split('.')[0]}. please remove the small text`);
  const r1 = await R.run(review.id); assert.ok(r1.revised, JSON.stringify(r1)); assert.deepEqual([r1.version, r1.revision.status, r1.revision.label, r1.revision.method, tells.length], [2, 'sent', 'Waiting for Client Approval', 'rules', 1]);
  assert.deepEqual(r1.changes.length, 2, 'the link under the headline and one line; the sub-line was already gone, so there is nothing to remove');
  assert.equal(CR.tokenOf(review.id), token, 'the SAME client link'); const rvRow = await CR.rowOf(review.id); assert.deepEqual([rvRow.status, rvRow.comment, rvRow.decidedAt, /We have made the changes you asked for/.test(rvRow.message)], ['sent', null, null, true], 'the link is open again, with the message for the client');
  const pv = await CR.publicView(token); assert.deepEqual([pv.review.status, pv.item.version, /We have made the changes/.test(pv.review.message)], ['sent', 2, true]);
  const it1 = await itemRow(item0.id); const spec1 = JSON.parse(it1.spec); assert.deepEqual([it1.status, spec1.rev, spec1.chipPos, /^Version 2 /.test(it1.note)], ['waiting', 1, 'under-headline', true]); assert.ok(!fs.readFileSync(file0).equals(original), 'the latest picture is the new one');
  assert.ok(fs.readFileSync((await Img.versionFile(admin, item0.id, 0)).path).equals(original), 'version 0 is the original, byte for byte'); assert.ok(fs.readFileSync((await Img.versionFile(admin, item0.id, 1)).path).equals(fs.readFileSync(file0)), 'the latest version is the current picture'); assert.equal(await Img.versionFile(admin, item0.id, 2), null);
  const sized = await sharp(file0).metadata(); assert.deepEqual([sized.width, sized.height], [1920, 1080], 'same size');
  assert.ok(told.some((t) => /Changed and sent again/.test(t.title) && /version 2/.test(t.title)), 'the sender is told');
  const pubFile = await CR.publicFile(token); assert.ok(fs.readFileSync(pubFile.path).equals(fs.readFileSync(file0)), 'the client\'s link shows the newest version');
  assert.deepEqual(await R.run(review.id), { skipped: 'not a client request for changes' }, 'the link is open again, so there is nothing to change until the client answers (a repeat is harmless)');
  console.log('PASS the job: the client\'s answer changes the banner (link under the headline, one line), version 2 is saved with the original kept, the SAME link shows it and the client is sent it again, the sender is told');

  // round 2 and 3 on the same link; the history shows each; approval ends it
  await says(review, 'make it green'); const r2 = await R.run(review.id); assert.deepEqual([r2.version, r2.revision.status, tells.length], [3, 'sent', 2]); assert.equal(JSON.parse((await itemRow(item0.id)).spec).colors.primary, '#15803d');
  await says(review, 'Change "Job seekers" to "Freshers"'); const r3 = await R.run(review.id); assert.equal(r3.version, 4); assert.equal(JSON.parse((await itemRow(item0.id)).spec).audience, 'Freshers in health care and IT sector');
  const h = await R.history(admin, item0.id); assert.deepEqual([h.version, h.revisions.length, h.revisions.map((x) => x.version), h.revisions.map((x) => x.status)], [4, 3, [2, 3, 4], ['sent', 'sent', 'sent']]); assert.ok(h.revisions[0].feedback.includes('the link should be in one line') && h.revisions[1].feedback === 'make it green' && h.revisions[2].summary[0].includes('Freshers'));
  for (let k = 0; k <= 3; k += 1) assert.ok((await Img.versionFile(admin, item0.id, k)), `version ${k} is available`); assert.ok(fs.readFileSync((await Img.versionFile(admin, item0.id, 0)).path).equals(original), 'the original is still there after three changes');
  const att = (await R.attach([{ id: item0.id, status: 'waiting' }]))[0].revision; assert.deepEqual([att.version, att.label, att.count, att.feedback], [4, 'Waiting for Client Approval', 3, 'Change "Job seekers" to "Freshers"']);
  const fin = await CR.publicDecide(token, { decision: 'approve', name: 'Sanjana', comment: '' }, '1.2.3.4'); assert.ok(fin.ok); assert.equal((await R.attach([{ id: item0.id, status: 'approved' }]))[0].revision.label, 'Approved'); assert.equal((await itemRow(item0.id)).status, 'approved');
  console.log('PASS repeating until approved: three rounds on the same link, the history lists each with the client\'s words and what was done, every version stays available, the client\'s approval ends it');

  // ---- 5. what is NOT sent ----
  const fresh = async (over = {}) => { const m = await Img.createBanner(admin, { size: '16:9', layout: 'showcase', headline: 'Hire the right people', headline2: 'in Hyderabad', sub: 'Fast hiring for hospitals', chip: 'teamlink.in', audience: 'Job seekers', title: 'Test banner', ...over }); assert.ok(m.item, JSON.stringify(m)); const rv = await mkClient(m.item); return { item: m.item, rv, file: path.join(process.env.UPLOAD_DIR, 'mk-images', `${m.item.id}.png`) }; };
  const before = (await Promise.all([1])).length; const sentBefore = tells.length;
  // not understood: nothing is sent, the original is untouched, a person is told
  let t = await fresh(); const orig2 = fs.readFileSync(t.file); await says(t.rv, 'I do not like how it feels, please look again'); let x = await R.run(t.rv.id);
  assert.deepEqual([x.revision.status, x.revision.label, tells.length === sentBefore, fs.readFileSync(t.file).equals(orig2)], ['needs-person', 'Changes Requested', true, true]); assert.ok(told.some((n) => /please change it/.test(n.title) && /could not turn/.test(n.message)));
  assert.deepEqual(await R.run(t.rv.id), { skipped: 'already handled' }, 'the same answer is not looked at twice');
  // the placeholder reason (the client tapped Reject on WhatsApp): wait for the real words; then the reply starts the job
  t = await fresh(); await says(t.rv, '(reason asked on WhatsApp)'); assert.deepEqual(await R.run(t.rv.id), { skipped: 'the client has not said what to change yet' });
  CR.kick.force = true; R.hooks.tell = async (u, id, b) => { tells.push({ id, ways: b.ways }); return { ok: 'Sent', sent: [] }; };
  const sentN = tells.length; await CR.setReasonByReply(t.rv.id, 'make it purple'); for (let i = 0; i < 60 && tells.length === sentN; i += 1) await new Promise((r) => setTimeout(r, 100)); assert.equal(tells.length, sentN + 1, 'the reply started the job by itself'); assert.equal(JSON.parse((await itemRow(t.item.id)).spec).colors.primary, '#6d28d9');
  // the web answer starts it by itself too
  t = await fresh(); const sentM = tells.length; await says(t.rv, 'remove the website link'); for (let i = 0; i < 60 && tells.length === sentM; i += 1) await new Promise((r) => setTimeout(r, 100)); assert.equal(tells.length, sentM + 1, 'the web answer started the job by itself'); assert.equal(JSON.parse((await itemRow(t.item.id)).spec).chip, '');
  CR.kick.force = false; R.hooks.tell = stubTell;
  // the same client answer twice: one job
  t = await fresh(); await says(t.rv, 'make it red'); const jobs = await Promise.all([R.run(t.rv.id), R.run(t.rv.id)]); assert.equal(jobs.filter((j) => j.revised).length, 1, 'two events for one answer make one picture'); assert.equal((await S.q('SELECT COUNT(*) AS n FROM "OmniMkRevision" WHERE itemId = ?', t.item.id))[0].n.toString(), '1');
  // a temporary failure is tried again; a lasting one is "Revision Failed", the original stays and Try again works
  const realRevise = Img.reviseBanner; let calls = 0; Img.reviseBanner = async (...a) => { calls += 1; if (calls < 3) return { error: 'The picture service did not answer in time.', status: 503 }; return realRevise(...a); };
  t = await fresh(); await says(t.rv, 'make it orange'); x = await R.run(t.rv.id); assert.deepEqual([x.revised, calls, x.revision.attempts], [true, 3, 3], 'two temporary failures, then it worked');
  Img.reviseBanner = async () => { calls += 1; return { error: 'The picture service did not answer in time.', status: 503 }; };
  t = await fresh(); const orig3 = fs.readFileSync(t.file); await says(t.rv, 'make it maroon'); const sent3 = tells.length; x = await R.run(t.rv.id); assert.deepEqual([x.failed !== undefined, x.revision.status, x.revision.label, tells.length === sent3, fs.readFileSync(t.file).equals(orig3), (await itemRow(t.item.id)).status], [true, 'failed', 'Revision Failed', true, true, 'changes']); // the item stays "Changes needed" with the client's words, the original untouched assert.ok(told.some((n) => /Revision failed/.test(n.title)));
  Img.reviseBanner = realRevise; const again = await R.retryJob(admin, x.revision.id); assert.ok(again.revised, JSON.stringify(again)); assert.equal(tells.length, sent3 + 1, 'Try again made it and sent it'); assert.deepEqual((await S.q('SELECT status FROM "OmniMkRevision" WHERE itemId = ? ORDER BY createdAt', t.item.id)).map((q) => q.status), ['failed', 'sent']);
  // made but the message could not be sent: kept, a person is told, the newest version is on the link, Try again sends it
  t = await fresh(); await says(t.rv, 'make it black'); R.hooks.tell = async () => ({ error: 'WhatsApp is not connected.' }); x = await R.run(t.rv.id); assert.deepEqual([x.revision.status, x.revision.label, x.sent.error], ['completed', 'Revision Completed', 'WhatsApp is not connected.']); assert.equal((await CR.rowOf(t.rv.id)).status, 'sent'); assert.ok(told.some((n) => /made, not sent/.test(n.title)));
  R.hooks.tell = stubTell; const resent = await R.retryJob(admin, x.revision.id); assert.ok(resent.ok, JSON.stringify(resent)); assert.equal((await rowOf(x.revision.id)).status, 'sent');
  // no way to reach the client
  t = await fresh(); await S.run('UPDATE "OmniMkClientReview" SET contactPhone = NULL, contactEmail = NULL WHERE id = ?', t.rv.id); await says(t.rv, 'make it blue'); const sentNo = tells.length; x = await R.run(t.rv.id); assert.deepEqual([x.revised, x.sent, tells.length === sentNo], [true, null, true]); assert.ok(told.some((n) => /no WhatsApp number or email/.test(n.message)));
  // switched off in AI usage
  const cur = await Cfg.getSettings(); await Cfg.saveSettings(Cfg.cleanSettings({ autoRevise: false }, cur).value); assert.equal((await Cfg.getSettings()).autoRevise, false); t = await fresh(); await says(t.rv, 'make it blue'); assert.deepEqual(await R.run(t.rv.id), { skipped: 'switched off' }); await Cfg.saveSettings(Cfg.cleanSettings({ autoRevise: true }, cur).value); assert.equal((await Cfg.getSettings()).autoRevise, true);
  // a banner made before changes were possible (no saved look), the round limit, a client who asked for a new design
  t = await fresh(); await S.run('UPDATE "OmniMkImage" SET spec = NULL WHERE id = ?', t.item.id); await says(t.rv, 'make it blue'); x = await R.run(t.rv.id); assert.deepEqual([x.revision.status, /before TeamLink could change banners/.test(x.revision.error)], ['needs-person', true]);
  t = await fresh(); const sp = JSON.parse((await itemRow(t.item.id)).spec); await Img.saveSpec(t.item.id, { ...sp, rev: R.MAX_ROUNDS }); await says(t.rv, 'make it blue'); x = await R.run(t.rv.id); assert.deepEqual([x.revision.status, /automatically 10 times/.test(x.revision.error)], ['needs-person', true]);
  t = await fresh(); await says(t.rv, 'we do not like it, please redo it from scratch'); x = await R.run(t.rv.id); assert.deepEqual([x.revised, x.revision.classification, x.version], [true, 'new_design', 2]); assert.ok(/new design with the same words/.test(x.changes[0]) && JSON.parse((await itemRow(t.item.id)).spec).headline === 'Hire the right people', 'a new-design request is a new version with the same words and a new look');
  // an AI answer used for what the rules did not understand
  R.hooks.ask = async () => ({ classification: 'correction', confidence: 0.85, changes: [{ field: 'headline', action: 'set', value: 'Hire the best people' }], unclear: [] });
  t = await fresh(); await says(t.rv, 'please make the heading more exciting'); x = await R.run(t.rv.id); assert.deepEqual([x.revised, x.revision.method], [true, 'ai']); assert.equal(JSON.parse((await itemRow(t.item.id)).spec).headline, 'Hire the best people'); R.hooks.ask = async () => { throw new Error('AI is not ready'); };
  console.log('PASS not sent: not understood, the placeholder reason, a repeat of one answer, temporary failures retried, a lasting failure (original kept, Try again), a message that could not be sent, no contact, switched off, an old banner, the round limit; a new design is a new version; the AI is used only for what the rules missed');

  // ---- the photograph is kept, and the site address the link was sent from is used again ----
  t = await fresh(); await S.run('UPDATE "OmniMkClientReview" SET site = ? WHERE id = ?', 'https://tl.example', t.rv.id); await says(t.rv, 'make it red'); x = await R.run(t.rv.id); assert.ok(x.revised); assert.equal(tells[tells.length - 1].base, 'https://tl.example', 'the link is sent again from the site address kept when it was first sent');
  const Stock = require('../src/marketing/stockclips'); const photoA = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2a9d8f' } }).jpeg().toBuffer(); const photoB = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#e76f51' } }).jpeg().toBuffer(); const searches = [];
  Stock.photo = async (u, q) => { searches.push(q); return { buf: q.n === 0 ? photoA : photoB, mime: 'image/jpeg' }; };
  const hb = await fresh({ heroSearch: 'recruitment office', heroN: 0 }); assert.equal(searches.length, 1); const hspec = JSON.parse((await itemRow(hb.item.id)).spec); const heroPath = (s) => path.join(process.env.UPLOAD_DIR, 'mk-images', s.heroFile);
  assert.equal(hspec.heroFile, `${hb.item.id}.hero`); assert.ok(fs.readFileSync(heroPath(hspec)).equals(photoA), 'the exact photograph is kept beside the banner');
  await says(hb.rv, 'make it green'); x = await R.run(hb.rv.id); assert.ok(x.revised); assert.equal(searches.length, 1, 'a change that does not name the photograph does not search again: the SAME photograph is used'); assert.equal(JSON.parse((await itemRow(hb.item.id)).spec).heroFile, hspec.heroFile);
  await says(hb.rv, 'change the picture'); x = await R.run(hb.rv.id); assert.ok(x.revised, JSON.stringify(x)); assert.deepEqual([searches.length, searches[1].n], [2, 1], 'asked for another picture: the next stock photograph'); const h2 = JSON.parse((await itemRow(hb.item.id)).spec); assert.ok(fs.readFileSync(heroPath(h2)).equals(photoB), 'the new photograph is kept for the next change');
  Stock.photo = async () => ({ error: 'The photo source is down', status: 503 }); await says(hb.rv, 'make it blue'); x = await R.run(hb.rv.id); assert.ok(x.revised, 'a change still works when the stock photo source is down, because the photograph was kept'); assert.equal(searches.length, 2);
  console.log('PASS the photograph: kept beside the banner, reused by every change that does not name it (no new search, even when the photo source is down), another one only when asked; the link is sent again from the site address kept when it was first sent');

  // ---- 6. AI pictures (not banners): the picture itself is the reference ----
  const photoId = S.newId('im'); const pfile = `${photoId}.jpg`; const pbuf = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2a6f97' } }).composite([{ input: await sharp({ create: { width: 300, height: 200, channels: 3, background: '#f4a261' } }).png().toBuffer(), left: 100, top: 100 }]).jpeg({ quality: 90 }).toBuffer(); fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', pfile), pbuf);
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', photoId, 'AI office photo', 'an office', 'photo', '4:3', pfile, 'image/jpeg', pbuf.length, 'draft', admin.id, admin.name, Date.now(), Date.now());
  const prv = await mkClient({ id: photoId }); await says(prv, 'make the wall behind the desk brighter, keep everything else');
  const asks = []; R.hooks.editFn = async (text, orig) => { asks.push({ text, orig }); return sharp(orig).modulate({ brightness: 1.25 }).resize(640, 480).jpeg().toBuffer(); }; // the picture AI: a different size on purpose
  x = await R.run(prv.id); assert.ok(x.revised, JSON.stringify(x)); assert.deepEqual([asks.length, /Change ONLY what is asked here: make the wall behind the desk brighter/.test(asks[0].text), /Keep everything else exactly as it is/.test(asks[0].text), asks[0].orig.equals(pbuf)], [1, true, true, true], 'the original is the reference and the instruction says to change only what was asked');
  const pm = await sharp(path.join(process.env.UPLOAD_DIR, 'mk-images', pfile)).metadata(); assert.deepEqual([pm.width, pm.height, pm.format], [800, 600, 'jpeg'], 'same size and format as the original'); assert.ok(fs.readFileSync((await Img.versionFile(admin, photoId, 0)).path).equals(pbuf), 'the original picture stays as version 0');
  assert.equal(x.revision.kind, 'picture'); assert.equal(x.revision.method, 'ai-edit'); assert.equal((await CR.rowOf(prv.id)).status, 'sent');
  R.hooks.editFn = async () => Buffer.from('not a picture'); const p2 = await mkClient({ id: photoId }); await says(p2, 'make the desk bigger'); x = await R.run(p2.id); assert.deepEqual([x.revision.status, x.revision.label], ['needs-person', 'Changes Requested'], 'a result that is not a picture is never sent'); assert.ok(/not a picture|damaged|picture/i.test(x.revision.error));
  R.hooks.editFn = async () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer(); const p3 = await mkClient({ id: photoId }); await says(p3, 'make the desk bigger please'); x = await R.run(p3.id); assert.equal(x.revision.status, 'needs-person'); assert.ok(/blank/.test(x.revision.error), 'a blank result is refused');
  R.hooks.editFn = null; const p4 = await mkClient({ id: photoId }); await says(p4, 'make the desk smaller please'); x = await R.run(p4.id); assert.equal(x.revision.status, 'needs-person'); assert.ok(/not available|not connected|sandbox/i.test(x.revision.error), 'with no picture AI connected, a person is told instead');
  const p5 = await mkClient({ id: photoId }); await says(p5, 'we want a completely different picture'); x = await R.run(p5.id); assert.deepEqual([x.revision.status, x.revision.classification], ['needs-person', 'new_design']); assert.ok(/new picture/.test(x.revision.error));
  console.log('PASS AI pictures: the picture is the reference with an instruction to change only what was asked, same size and format, the original kept as version 0, a result that is not a picture or is blank is never sent, no picture AI or a new-picture request goes to a person');

  console.log('client changes tests: all passed');
  process.exit(0);
  async function rowOf(id) { return (await S.q('SELECT * FROM "OmniMkRevision" WHERE id = ?', id))[0]; }
})().catch((e) => { console.error(e); process.exit(1); });
