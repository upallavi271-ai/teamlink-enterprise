#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CLIENT'S DASHBOARD (2026-11-25): acceptance test. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4063 node scripts/client-dashboard-test.js
//
// What it proves (marketing/clientPhone.js dashboard(), marketing/clientServices.js forClient(), routes/portalPosts.js GET /dashboard):
//   A  the numbers: posts of the month by where they stand (waiting / approved / posted / changes asked), the waiting posts, the same after the client answers one
//   B  platforms and dates: a message names its channels, a posted picture names the account it went out on; every post sits on a day of the month; the month can be changed
//   C  the plan: the plan, its period and what is delivered against what it promises; NO price, notes, contact or team names
//   D  only the login's own company: another company's posts and plan never show; a billing-only client, a staff login and nobody signed in are refused
//   E  the login of this kind opens on the dashboard (/client-home)
// Builds ZZTEST fixtures in sandbox.db and removes them again. Nothing real is sent (TEST_MODE).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4063 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const DB = path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db');
if (!/sandbox\.db$/i.test(DB) || !fs.existsSync(DB)) { console.error('Refusing: this test only runs against prisma/sandbox.db.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;

const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const S = require(path.join(BACK, 'src/outreach/store'));
const Content = require(path.join(BACK, 'src/marketing/content'));
const Img = require(path.join(BACK, 'src/marketing/images'));
const CR = require(path.join(BACK, 'src/marketing/clientReview'));
const IP = require(path.join(BACK, 'src/marketing/itemPlan'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const P = '/api/portal/client/posts';
const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 2, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };

(async () => {
  const made = { users: [], clients: [], plans: [], content: [], images: [], reviews: [] };
  try {
    // ---------------------------------------------------------------- fixtures
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    check('0 the sandbox copy has a Super Admin', !!sa);
    await prisma.user.update({ where: { id: sa.id }, data: { passwordHash: 'x' } });
    const saId = await resolveIdentity(sa.id);
    const clientA = await prisma.client.create({ data: { name: `ZZTEST Dash A ${RUN}`, agreementStatus: 'DRAFT' } });
    const clientB = await prisma.client.create({ data: { name: `ZZTEST Dash B ${RUN}`, agreementStatus: 'DRAFT' } });
    made.clients.push(clientA.id, clientB.id);
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => { const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ${tag} ${RUN}`, email: `zz-db-${tag}-${RUN}@example.test`, username: `zz-db-${tag}-${RUN}@example.test`, ...extra } }); made.users.push(u.id); return u; };
    const cA = await mkUser('clienta', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientA.id, portalPerms: 'CREATIVE', portalType: 'MARKETING' });
    const cB = await mkUser('clientb', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientB.id, portalPerms: 'CREATIVE', portalType: 'MARKETING' });
    const cBill = await mkUser('clientbill', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientA.id, portalPerms: 'INVOICES', portalType: 'BILLING' });
    const rec = await mkUser('recruiter', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { a: await mint(cA), b: await mint(cB), bill: await mint(cBill), rec: await mint(rec), sa: await mint(sa) };

    // a plan for company A only (made the way the team does it)
    const pr = await http('POST', '/api/outreach/gs/marketing/services/plans', T.sa, { clientName: clientA.name, plan: 'growth', months: 6, startDate: istDay(Date.now()), contactName: `ZZTEST Owner ${RUN}`, contactPhone: '9999900001', notes: `ZZTEST secret note ${RUN}` });
    const planId = pr.body && pr.body.plan && pr.body.plan.id; if (planId) made.plans.push(planId);
    check('1 a Growth plan for company A', pr.status < 300 && !!planId, pr.body);

    // posts, made the way the team does it
    const words = async (title, text, channels) => { const r = await Content.create(saId, { title, brief: 'zz test', channels, texts: Object.fromEntries(channels.map((c) => [c, text])) }); if (r.error) throw new Error(r.error); made.content.push(r.item.id); return r.item.id; };
    const png = Img.samplePng('1:1', '#0a74bd', '#22333b');
    const pic = async (title) => { const r = await Img.saveUpload(saId, png, 'image/png', { title }); if (r.error) throw new Error(r.error); made.images.push(r.item.id); return r.item.id; };
    const send = async (kind, itemId, who, withId = true) => { const r = await CR.create(saId, { kind, itemId, mode: 'decide', clientName: who.name, clientId: withId ? who.id : undefined, contactName: 'ZZTEST Contact', days: 14 }); if (r.error) throw new Error(r.error); made.reviews.push(r.review.id); return r.review.id; };
    const t1 = `ZZTEST Diwali words ${RUN}`; const t2 = `ZZTEST Approved picture ${RUN}`; const t3 = `ZZTEST Rejected picture ${RUN}`; const t4 = `ZZTEST Posted picture ${RUN}`; const t6 = `ZZTEST Name only picture ${RUN}`; const tb = `ZZTEST Other company words ${RUN}`;
    const r1 = await send('content', await words(t1, 'Wishing you a bright Diwali.', ['facebook', 'instagram']), clientA);
    const img2 = await pic(t2); const r2 = await send('image', img2, clientA);
    const img3 = await pic(t3); const r3 = await send('image', img3, clientA);
    const img4 = await pic(t4); const r4 = await send('image', img4, clientA);
    const img6 = await pic(t6); const r6 = await send('image', img6, clientA, false); // no company id on the row: matched by the company name
    await send('content', await words(tb, 'Another company.', ['facebook']), clientB);
    check('2 the client answers: approve two pictures, reject one with a reason', (await http('POST', `${P}/${r2}/decision`, T.a, { decision: 'approve' })).status === 200
      && (await http('POST', `${P}/${r4}/decision`, T.a, { decision: 'approve' })).status === 200
      && (await http('POST', `${P}/${r3}/decision`, T.a, { decision: 'reject', comment: 'Please change the colours.' })).status === 200);
    // the picture r4 went out on Facebook (what the posting plan records when it posts after the client approves)
    await IP.ensure();
    const nowMs = Date.now();
    await S.run('INSERT INTO "OmniMkItemPlan" (id, itemId, accounts, caption, state, result, createdAt, updatedAt, postedAt) VALUES (?,?,?,?,?,?,?,?,?)', `zzipl-${RUN}`, img4, JSON.stringify([{ accountId: 'zz-acc', platform: 'facebook', name: `ZZTEST Page ${RUN}` }]), 'Words', 'posted', JSON.stringify([{ name: `ZZTEST Page ${RUN}`, platform: 'facebook', ok: true, url: 'https://example.test/p/1' }]), nowMs, nowMs, nowMs);

    // ---------------------------------------------------------------- A: the numbers
    const g = await http('GET', `${P}/dashboard`, T.a);
    const d = g.body || {};
    check('A1 the dashboard opens (200) for the company\'s client login', g.status === 200 && d.company === clientA.name, g.body && { s: g.status, e: g.body.error });
    check('A2 it is for the current month and says today', /^\d{4}-\d{2}$/.test(d.month) && d.month === istDay(nowMs).slice(0, 7) && d.today === istDay(nowMs), { m: d.month, t: d.today });
    check('A3 the month\'s numbers: 5 posts, 2 waiting, 1 approved, 1 posted, 1 changes asked', d.counts && d.counts.total === 5 && d.counts.waiting === 2 && d.counts.approved === 1 && d.counts.posted === 1 && d.counts.changes === 1, d.counts);
    check('A4 the numbers of now agree', d.now && d.now.waiting === 2 && d.now.posted === 1, d.now);
    check('A5 the waiting posts are listed for the "needs you" box', Array.isArray(d.waiting) && d.waiting.length === 2 && d.waiting.some((x) => x.title === t1) && d.waiting.some((x) => x.title === t6), d.waiting);
    check('A6 the greeting uses the person\'s first word', typeof d.hello === 'string' && d.hello === 'ZZTEST', d.hello);
    // the client answers one more from the list and the dashboard moves
    check('A7 answering a waiting post from its page moves it on the dashboard', (await http('POST', `${P}/${r6}/decision`, T.a, { decision: 'approve' })).status === 200
      && await (async () => { const d2 = (await http('GET', `${P}/dashboard`, T.a)).body; return d2.counts.waiting === 1 && d2.counts.approved === 2; })());

    // ---------------------------------------------------------------- B: platforms and dates
    const pl = (k) => (d.platforms || []).find((x) => x.platform === k);
    check('B1 Facebook has 2 posts (the message and the picture that went out on it), 1 of them posted', pl('facebook') && pl('facebook').total === 2 && pl('facebook').posted === 1, d.platforms);
    check('B2 Instagram has the 1 message that names it', pl('instagram') && pl('instagram').total === 1 && pl('instagram').waiting === 1, d.platforms);
    check('B3 the platforms are worded for a person (Facebook, Instagram)', pl('facebook') && pl('facebook').word === 'Facebook' && pl('instagram').word === 'Instagram', d.platforms);
    check('B3b posts with no platform chosen yet are counted too ("Not chosen yet"), so the bars add up', pl('none') && pl('none').total === 3 && pl('none').word === 'Not chosen yet', d.platforms);
    const po = (t) => (d.posts || []).find((x) => x.title === t);
    check('B4 every post has a day inside the month', (d.posts || []).length === 5 && d.posts.every((x) => x.day && x.day.startsWith(d.month)), d.posts && d.posts.map((x) => x.day));
    check('B5 a posted picture says when it was posted and where (the link included)', po(t4) && po(t4).status === 'posted' && po(t4).day === istDay(Date.parse(po(t4).postedAt)) && po(t4).postedOn.length === 1 && /example\.test/.test(po(t4).postedOn[0].url), po(t4));
    check('B6 a rejected picture keeps the client\'s own reason', po(t3) && po(t3).status === 'changes' && /colours/.test(po(t3).comment), po(t3));
    check('B7 a message lists the channels it is for', po(t1) && po(t1).platforms.map((x) => x.key).sort().join() === 'facebook,instagram', po(t1));
    const back = (await http('GET', `${P}/dashboard?month=${prevMonth(d.month)}`, T.a)).body;
    check('B8 another month can be asked for: last month has no posts', back && back.month === prevMonth(d.month) && back.counts.total === 0 && back.posts.length === 0 && back.platforms.length === 0, back && back.counts);
    check('B9 the waiting box does not depend on the month (the post is still waiting)', back && back.waiting.length === 1);
    const bad = (await http('GET', `${P}/dashboard?month=2026-13`, T.a)).body;
    check('B10 a month that is not a month is read as this month', bad && bad.month === d.month, bad && bad.month);
    check('B11 the months to step through include this one', Array.isArray(d.months) && d.months.includes(d.month), d.months);

    // ---------------------------------------------------------------- C: the plan
    check('C1 the plan: Growth, its period and 6 months', d.plan && d.plan.label === 'Growth' && d.plan.months === 6 && /^\d{4}-\d{2}-\d{2}$/.test(d.plan.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(d.plan.endDate) && d.plan.state === 'running', d.plan);
    const postsRow = d.plan && d.plan.progress.find((x) => x.item === 'posts');
    check('C2 what is delivered against what the plan promises (12 posts a month on Growth)', !!postsRow && postsRow.quota === 12 && typeof postsRow.done === 'number' && postsRow.pct >= 0, d.plan && d.plan.progress);
    check('C3 it says what the plan includes', d.plan && Array.isArray(d.plan.includes) && d.plan.includes.length > 0);
    const raw = g.text;
    check('C4 no price, note, contact or team name of the plan reaches the client', !/pricePaid|"price"|ZZTEST secret note|9999900001|createdByName|contactPhone|"notes"/.test(raw), raw.match(/pricePaid|"price"|ZZTEST secret note|9999900001|createdByName|contactPhone|"notes"/));
    check('C5 no token, secret or error text in the answer', !/accessToken|refreshToken|secret|"error"/i.test(raw.replace(/ZZTEST secret note/g, '')), raw.match(/accessToken|refreshToken|secret|"error"/i));
    check('C6 the accounts block is there (a list, may be empty) and posting state is told', Array.isArray(d.accounts) && typeof d.postingOn === 'boolean');

    // ---------------------------------------------------------------- D: only the login's own company, and who may
    const gb = await http('GET', `${P}/dashboard`, T.b);
    check('D1 company B sees only its own post and no plan', gb.status === 200 && gb.body.counts.total === 1 && gb.body.posts[0].title === tb && gb.body.plan === null, gb.body && { c: gb.body.counts, p: gb.body.plan });
    check('D2 company A never sees company B\'s post', !(d.posts || []).some((x) => x.title === tb) && !(d.waiting || []).some((x) => x.title === tb));
    check('D3 a billing-only client login is refused (403)', (await http('GET', `${P}/dashboard`, T.bill)).status === 403);
    check('D4 a staff login is refused (403)', (await http('GET', `${P}/dashboard`, T.rec)).status === 403 && (await http('GET', `${P}/dashboard`, T.sa)).status === 403);
    check('D5 nobody signed in: refused (401)', (await http('GET', `${P}/dashboard`, null)).status === 401);

    // ---------------------------------------------------------------- E: the first page
    const idA = await resolveIdentity(cA.id);
    check('E1 the login opens on the dashboard (/client-home)', idA.landingPath === '/client-home', idA.landingPath);
  } catch (e) {
    check('the test ran to the end', false, e.stack || e.message);
  } finally {
    // ---------------------------------------------------------------- clean up
    try {
      if (made.images.length) await S.run(`DELETE FROM "OmniMkItemPlan" WHERE itemId IN (${made.images.map(() => '?').join(',')})`, ...made.images).catch(() => {});
      if (made.reviews.length) await S.run(`DELETE FROM "OmniMkClientReview" WHERE id IN (${made.reviews.map(() => '?').join(',')})`, ...made.reviews);
      if (made.content.length) await S.run(`DELETE FROM "OmniMkContent" WHERE id IN (${made.content.map(() => '?').join(',')})`, ...made.content);
      if (made.images.length) await S.run(`DELETE FROM "OmniMkImage" WHERE id IN (${made.images.map(() => '?').join(',')})`, ...made.images);
      if (made.plans.length) { await S.run(`DELETE FROM "OmniMkOnboarding" WHERE planId IN (${made.plans.map(() => '?').join(',')})`, ...made.plans).catch(() => {}); await S.run(`DELETE FROM "OmniMkClientPlan" WHERE id IN (${made.plans.map(() => '?').join(',')})`, ...made.plans); }
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } });
      await prisma.notification.deleteMany({ where: { title: { contains: 'ZZTEST' } } });
      await prisma.notification.deleteMany({ where: { message: { contains: 'ZZTEST' } } });
      await prisma.portalRequest.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
    } catch (e) { console.log(`(clean-up: ${e.message})`); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
