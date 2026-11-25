#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENT LOGIN ON THE PHONE ("Social posts" login, 2026-11-25): acceptance test. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4063 node scripts/client-phone-test.js
//
// What it proves (marketing/clientPhone.js, routes/portalPosts.js, routes/portalLogins.js):
//   A  staff create a "Social posts" client login from the web app (Client 360 > Portal access): the one-time set-your-password link flow, no password in any answer, allowed even when the
//      company has no Active agreement (every other login type still needs one); the person sets a password from the link and signs in
//   B  the client sees ONLY its own company's posts (matched by company id, or by company name when the row has no id), never another company's, a billing-only client and staff are refused
//   C  approve / reject: a rejection needs a reason; the answer is saved under the login's own name, the sender gets a bell, the staff list shows the decision, one answer only
//   D  "My social accounts": the accounts linked to the company only, read only, no token / error text, counts per account
//   E  nothing else is open to the login (staff routes answer 403), and the other client types / roles are unchanged
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
const Cfg = require(path.join(BACK, 'src/marketing/settings'));
const { encryptSecret } = require(path.join(BACK, 'src/utils/secrets'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const P = '/api/portal/client/posts';

(async () => {
  const made = { users: [], clients: [], content: [], images: [], reviews: [] };
  const savedSocial = await prisma.appSetting.findUnique({ where: { key: 'social.accounts' } });
  const savedMap = await Cfg.getClientAccounts();
  try {
    // ---------------------------------------------------------------- fixtures
    const clientA = await prisma.client.create({ data: { name: `ZZTEST Social Client A ${RUN}`, agreementStatus: 'DRAFT' } });
    const clientB = await prisma.client.create({ data: { name: `ZZTEST Social Client B ${RUN}`, agreementStatus: 'ACTIVE' } });
    made.clients.push(clientA.id, clientB.id);
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => { const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ${tag} ${RUN}`, email: `zz-cp-${tag}-${RUN}@example.test`, username: `zz-cp-${tag}-${RUN}@example.test`, ...extra } }); made.users.push(u.id); return u; };
    const cA = await mkUser('clienta', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientA.id, portalPerms: 'CREATIVE', portalType: 'MARKETING' });
    const cB = await mkUser('clientb', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientB.id, portalPerms: 'CREATIVE', portalType: 'MARKETING' });
    const cMixed = await mkUser('clientmixed', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientA.id, portalPerms: 'VIEW,CREATIVE', portalType: 'CUSTOM' });
    const cBill = await mkUser('clientbill', { role: 'CLIENT', atsRole: 'CLIENT', clientId: clientA.id, portalPerms: 'INVOICES', portalType: 'BILLING' });
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    check('0 the sandbox copy has a Super Admin', !!sa);
    await prisma.user.update({ where: { id: sa.id }, data: { passwordHash: 'x' } });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { a: await mint(cA), b: await mint(cB), mixed: await mint(cMixed), bill: await mint(cBill), sa: await mint(sa) };
    const saId = await resolveIdentity(sa.id);

    // ---------------------------------------------------------------- A: staff create the login
    const em = `zz-cp-new-${RUN}@example.test`;
    const clientC = await prisma.client.create({ data: { name: `ZZTEST Social Client C ${RUN}`, agreementStatus: 'DRAFT' } }); // a company with no logins yet and no Active agreement (a company may have 3 logins: clientA already uses them)
    made.clients.push(clientC.id);
    const add = await http('POST', `/api/portal/logins/client/${clientC.id}/users`, T.sa, { name: `ZZTEST New Social ${RUN}`, email: em, portalPerms: ['CREATIVE'] });
    check('A1 staff add a "Social posts" login for a client whose agreement is NOT active (201)', add.status === 201 && add.body && add.body.created === true, add.body);
    const nu = await prisma.user.findFirst({ where: { email: em } });
    if (nu) made.users.push(nu.id);
    check('A2 it is a CLIENT login of that company with the Social posts type and only the creative tick', !!nu && nu.role === 'CLIENT' && nu.clientId === clientC.id && nu.portalType === 'MARKETING' && nu.portalPerms === 'CREATIVE', nu && { role: nu.role, t: nu.portalType, p: nu.portalPerms });
    check('A3 no password in the answer; a one-time set-password link (or a mailed note) is', !/password["']?\s*:\s*["'][^"']{6,}/i.test(JSON.stringify(add.body || {})) && (add.body.link ? /\/set-password\/[0-9a-f]{64}$/.test(add.body.link) : /sent/i.test(add.body.message)), add.body);
    check('A4 the stored password is not a usable one (the person must set their own)', !!nu && nu.passwordHash !== 'x' && String(nu.passwordHash).length > 20 && !!nu.setPasswordTokenHash);
    const other = await http('POST', `/api/portal/logins/client/${clientC.id}/users`, T.sa, { name: `ZZTEST Reviewer ${RUN}`, email: `zz-cp-rev-${RUN}@example.test`, portalType: 'REVIEWER' });
    check('A5 any OTHER login type is still refused while the agreement is not active (409)', other.status === 409 && /agreement/i.test((other.body && other.body.error) || ''), other.body);
    const tok = add.body && add.body.link ? add.body.link.split('/set-password/')[1] : null;
    if (tok) {
      const set = await http('POST', `/api/public/set-password/${tok}`, null, { password: `Zz-Social-${RUN}-7!` });
      check('A6 the person sets their own password from the one-time link', set.status === 200, set.body);
      const reuse = await http('POST', `/api/public/set-password/${tok}`, null, { password: `Zz-Social-${RUN}-8!` });
      check('A7 the link works once only', reuse.status >= 400, reuse.status);
      const login = await http('POST', '/api/auth/login', null, { email: em, password: `Zz-Social-${RUN}-7!` });
      const lt = login.body && (login.body.token || (login.body.data && login.body.data.token));
      check('A8 and signs in', login.status === 200 && !!lt, { s: login.status, b: login.body && Object.keys(login.body) });
      if (lt) {
        const me = await http('GET', '/api/auth/me', lt);
        const u = me.body && (me.body.user || me.body);
        check('A9 /auth/me: a CLIENT of that company whose only tick is the creative one', me.status === 200 && u.role === 'CLIENT' && u.clientId === clientC.id && Array.isArray(u.portalCaps) && u.portalCaps.length === 1 && u.portalCaps[0] === 'CREATIVE', u && { r: u.role, c: u.portalCaps });
        check('A10 the new login can open its (empty) post list', (await http('GET', P, lt)).status === 200);
        check('A11 the login opens on its posts (/client-posts)', login.body && login.body.user && login.body.user.landingPath === '/client-posts', login.body && login.body.user && login.body.user.landingPath);
      }
    } else check('A6-A10 skipped: no link in the answer (mail was sent)', false, add.body);

    // ---------------------------------------------------------------- posts for client A and B, made the way the team does it
    const words = async (title, text) => { const r = await Content.create(saId, { title, brief: 'zz test', channels: ['facebook'], texts: { facebook: text } }); if (r.error) throw new Error(r.error); made.content.push(r.item.id); return r.item.id; };
    const png = Img.samplePng('1:1', '#0a74bd', '#22333b');
    const pic = async (title) => { const r = await Img.saveUpload(saId, png, 'image/png', { title }); if (r.error) throw new Error(r.error); made.images.push(r.item.id); return r.item.id; };
    const send = async (kind, itemId, who, withId = true) => { const r = await CR.create(saId, { kind, itemId, mode: 'decide', clientName: who.name, clientId: withId ? who.id : undefined, contactName: 'ZZTEST Contact', days: 14 }); if (r.error) throw new Error(r.error); made.reviews.push(r.review.id); return r.review.id; };
    const w1 = await send('content', await words(`ZZTEST Diwali words ${RUN}`, 'Wishing you a bright Diwali from all of us.'), clientA);
    const w2 = await send('content', await words(`ZZTEST Offer words ${RUN}`, 'Our new service is open this month.'), clientA, false); // no company id on the row: matched by the company name
    const p1 = await send('image', await pic(`ZZTEST Picture ${RUN}`), clientA);
    const wB = await send('content', await words(`ZZTEST Other company words ${RUN}`, 'This one is for the other company only.'), clientB);
    await new Promise((r) => setTimeout(r, 400));
    const bell = await prisma.notification.findMany({ where: { userId: { in: [cA.id, cB.id, cMixed.id, cBill.id] } } });
    check('B0 the company\'s client logins got a bell for each post sent (A and the mixed login, not B, not billing-only)', bell.filter((n) => n.userId === cA.id).length === 3 && bell.filter((n) => n.userId === cMixed.id).length === 3 && !bell.some((n) => n.userId === cB.id && /ZZTEST (Diwali|Offer|Picture)/.test(n.message || '')) && !bell.some((n) => n.userId === cBill.id), bell.map((n) => `${n.userId.slice(-4)}:${n.title}`));
    check('B0b the bell opens the client\'s own screen', bell.some((n) => /Open: \/client-posts/.test(n.message || '')));

    // ---------------------------------------------------------------- B: only its own company
    const la = await http('GET', P, T.a);
    check('B1 client A lists its 3 posts waiting (2 words, 1 picture), found by company id and by company name', la.status === 200 && la.body.counts.waiting === 3 && la.body.waiting.length === 3 && la.body.waiting.every((x) => x.needsYou) && la.body.company === clientA.name, la.body && la.body.counts);
    check('B2 none of them is company B\'s', !JSON.stringify(la.body).includes('Other company words') && !la.body.waiting.some((x) => x.id === wB));
    check('B3 the picture card has a file address, a words card has a preview', la.body.waiting.some((x) => x.kind === 'picture' && /\/api\/public\/mk-review\/.+\/file$/.test(x.thumb)) && la.body.waiting.some((x) => x.kind === 'words' && /Diwali/.test(x.preview)));
    const lb = await http('GET', P, T.b);
    check('B4 client B sees only its own post', lb.status === 200 && lb.body.waiting.length === 1 && lb.body.waiting[0].id === wB && !JSON.stringify(lb.body).includes('Diwali'), lb.body && lb.body.waiting);
    check('B5 client A cannot open B\'s post (404) nor answer it (404)', (await http('GET', `${P}/${wB}`, T.a)).status === 404 && (await http('POST', `${P}/${wB}/decision`, T.a, { decision: 'approve' })).status === 404);
    check('B6 a billing-only client (no creative tick) is refused (403)', (await http('GET', P, T.bill)).status === 403 && (await http('GET', `${P}/accounts`, T.bill)).status === 403);
    check('B7 staff are told this is for client logins (403); no login is 401', (await http('GET', P, T.sa)).status === 403 && (await http('GET', P)).status === 401);
    const pv = await http('GET', `${P}/${p1}`, T.a);
    check('B8 one picture post opens: file address, company, no staff fields', pv.status === 200 && pv.body.kind === 'picture' && /\/file/.test(pv.body.fileUrl) && pv.body.status === 'sent' && pv.body.company === clientA.name && !/createdBy|department|contactEmail|clientId/.test(JSON.stringify(pv.body)), pv.body);
    const wv = await http('GET', `${P}/${w1}`, T.a);
    check('B9 a words post opens with its text', wv.status === 200 && wv.body.kind === 'words' && /bright Diwali/.test(JSON.stringify(wv.body.words)), wv.body);
    const file = await http('GET', pv.body.fileUrl, null);
    check('B10 the picture itself loads (public, token-keyed file address)', file.status === 200, file.status);

    // ---------------------------------------------------------------- C: approve / reject
    check('C1 a rejection without a reason is refused (400)', (await http('POST', `${P}/${w1}/decision`, T.a, { decision: 'reject' })).status === 400 && (await http('POST', `${P}/${w1}/decision`, T.a, { decision: 'reject', comment: 'no' })).status === 400);
    check('C2 a wrong word is refused (400)', (await http('POST', `${P}/${w1}/decision`, T.a, { decision: 'maybe' })).status === 400);
    const rej = await http('POST', `${P}/${w1}/decision`, T.a, { decision: 'reject', comment: 'Please make the greeting shorter' });
    check('C3 reject with a reason works (200)', rej.status === 200 && /team/i.test((rej.body && rej.body.ok) || ''), rej.body);
    const r1 = (await S.q('SELECT * FROM "OmniMkClientReview" WHERE id = ?', w1))[0];
    check('C4 the review is "changes" with the reason, under the login\'s OWN name, marked as from the client login', r1 && r1.status === 'changes' && r1.comment === 'Please make the greeting shorter' && r1.decidedByName === cA.name && /client login/.test(r1.decidedIp || ''), r1 && { s: r1.status, c: r1.comment, n: r1.decidedByName, ip: r1.decidedIp });
    const staffBell = await prisma.notification.findMany({ where: { userId: sa.id, title: { contains: 'asked for changes' } }, orderBy: { createdAt: 'desc' }, take: 3 });
    check('C5 the sender (staff) got a bell with the client\'s reason', staffBell.some((n) => /greeting shorter/.test(n.message || '')), staffBell.map((n) => n.message));
    const staffList = await http('GET', '/api/outreach/gs/marketing/client-reviews', T.sa);
    const row = staffList.body && (staffList.body.reviews || []).find((x) => x.id === w1);
    check('C6 staff see the decision in the web app (AI Marketing > client reviews): changes asked, the reason, who answered', !!row && row.status === 'changes' && row.comment === 'Please make the greeting shorter' && row.decidedByName === cA.name, row);
    const item1 = (await S.q('SELECT status FROM "OmniMkContent" WHERE id = ?', r1 ? r1.itemId : '')).map((x) => x.status)[0];
    check('C7 the words go back to the writer (status changes)', item1 === 'changes', item1);
    const again = await http('POST', `${P}/${w1}/decision`, T.a, { decision: 'approve' });
    check('C8 one answer only (409)', again.status === 409, again.body);
    const appr = await http('POST', `${P}/${w2}/decision`, T.a, { decision: 'approve', comment: 'Looks great' });
    check('C9 approve works (200)', appr.status === 200 && /approval/i.test((appr.body && appr.body.ok) || ''), appr.body);
    const r2 = (await S.q('SELECT * FROM "OmniMkClientReview" WHERE id = ?', w2))[0];
    const i2 = (await S.q('SELECT status FROM "OmniMkContent" WHERE id = ?', r2.itemId))[0];
    check('C10 approved under the login\'s own name; the words are approved for the team', r2.status === 'approved' && r2.decidedByName === cA.name && i2.status === 'approved', { r: r2.status, i: i2 });
    const apprP = await http('POST', `${P}/${p1}/decision`, T.a, { decision: 'approve' });
    check('C11 approve a picture works (200)', apprP.status === 200, apprP.body);
    const aud = await prisma.auditLog.findMany({ where: { action: 'Omni-Channel AI Marketing: client answered from their login', actorName: { contains: cA.name } } });
    check('C12 each answer is in the audit log with the client person\'s own name', aud.length >= 3 && aud.some((x) => /rejected/.test(x.toValue || '')) && aud.some((x) => /approved/.test(x.toValue || '')), aud.map((x) => x.toValue));
    const la2 = await http('GET', P, T.a);
    check('C13 the lists move: nothing waiting, 3 answered (1 asked changes, 2 approved)', la2.body.counts.waiting === 0 && la2.body.done.length === 3 && la2.body.counts.changes === 1 && la2.body.counts.approved === 2, la2.body.counts);
    check('C14 the rejected one shows the client\'s own words back', la2.body.done.some((x) => x.status === 'changes' && x.comment === 'Please make the greeting shorter'));
    check('C15 company B\'s post is still waiting and untouched', (await http('GET', P, T.b)).body.waiting.length === 1);

    // ---------------------------------------------------------------- D: my social accounts
    const mkAcc = (platform, name, extra = {}) => ({ id: `zz-${platform}-${RUN}`, platform, externalId: `ext-${platform}-${RUN}`, name, username: platform === 'instagram' ? `zz_${RUN}` : null, parentName: platform === 'instagram' ? `ZZTEST Page ${RUN}` : null, isDefault: false, status: 'Connected', tokenEnc: encryptSecret('zz-secret-token'), error: 'secret failure detail', connectedByName: 'ZZ Staff', connectedAt: new Date().toISOString(), ...extra });
    const accs = [mkAcc('facebook', `ZZTEST Page ${RUN}`), mkAcc('instagram', `ZZTEST Insta ${RUN}`, { status: 'Expired' }), mkAcc('x', `ZZTEST Other Company X ${RUN}`)];
    const cur = savedSocial ? JSON.parse(savedSocial.value) : [];
    await prisma.appSetting.upsert({ where: { key: 'social.accounts' }, create: { key: 'social.accounts', value: JSON.stringify([...cur, ...accs]) }, update: { value: JSON.stringify([...cur, ...accs]) } });
    await Cfg.saveClientAccounts({ ...savedMap, [`c:${clientA.id}`]: { accountIds: [accs[0].id, accs[1].id], by: 'ZZ', at: new Date().toISOString() }, [`c:${clientB.id}`]: { accountIds: [accs[2].id], by: 'ZZ', at: new Date().toISOString() } });
    const ac = await http('GET', `${P}/accounts`, T.a);
    check('D1 client A sees its 2 linked accounts (a Page and an Instagram) and not company B\'s', ac.status === 200 && ac.body.accounts.length === 2 && !JSON.stringify(ac.body).includes('Other Company X'), ac.body && ac.body.accounts);
    const fb = ac.body.accounts.find((x) => x.platform === 'facebook'); const ig = ac.body.accounts.find((x) => x.platform === 'instagram');
    check('D2 the Page is Connected, the expired Instagram says it needs attention', fb && fb.connected === true && ig && ig.connected === false && /reconnected/.test(ig.statusWords) && ig.pageName.startsWith('ZZTEST Page'), { fb, ig });
    check('D3 no token, no error text, no staff names leave the server', !/zz-secret-token|tokenEnc|secret failure|ZZ Staff|connectedBy|externalId|"id"/.test(JSON.stringify(ac.body)), JSON.stringify(ac.body).slice(0, 300));
    check('D4 the counts match the posts: 0 waiting, 2 approved, 0 posted', ac.body.counts.waiting === 0 && ac.body.counts.approved === 2 && ac.body.counts.posted === 0, ac.body.counts);
    const acb = await http('GET', `${P}/accounts`, T.b);
    check('D5 client B sees only its own account', acb.body.accounts.length === 1 && /Other Company X/.test(acb.body.accounts[0].name));
    check('D6 read only: nothing on the accounts route can change anything (POST / PUT / DELETE answer 404)', (await http('POST', `${P}/accounts`, T.a, {})).status === 404 && (await http('DELETE', `${P}/accounts`, T.a)).status === 404 && (await http('PUT', `${P}/accounts`, T.a, {})).status === 404);

    // ---------------------------------------------------------------- E: nothing else is open
    for (const p of ['/api/outreach/gs/marketing/meta', '/api/clients', '/api/employees', '/api/admin/users', '/api/portal/logins/client/' + clientA.id, '/api/outreach/gs/marketing/client-reviews']) {
      const r = await http('GET', p, T.a); // eslint-disable-line no-await-in-loop
      check(`E1 the Social posts login is walled off from ${p} (403)`, r.status === 403, r.status);
    }
    check('E2 it cannot answer through the staff review routes either (403)', (await http('POST', '/api/outreach/gs/marketing/client-reviews', T.a, { kind: 'content', itemId: 'x' })).status === 403);
    check('E3 a client with other ticks (VIEW + creative) keeps My Portal and also reaches the posts', (await http('GET', '/api/portal/client', T.mixed)).status === 200 && (await http('GET', P, T.mixed)).status === 200);
    const meMixed = (await http('GET', '/api/auth/me', T.mixed)).body || {}; const meBill = (await http('GET', '/api/auth/me', T.bill)).body || {};
    check('E3b the landing page of the other client types is unchanged (not /client-posts)', meMixed.landingPath !== '/client-posts' && meBill.landingPath !== '/client-posts' && !!meMixed.landingPath, { mixed: meMixed.landingPath, bill: meBill.landingPath });
    const pres = await http('GET', `/api/portal/logins/client/${clientB.id}`, T.sa);
    check('E4 Client 360 > Portal access offers the new "Social posts" start, the other three are unchanged', pres.status === 200 && ['REVIEWER', 'VIEWER', 'BILLING', 'MARKETING'].every((k) => (pres.body.types || []).some((t) => t.value === k)) && (pres.body.types || []).find((t) => t.value === 'MARKETING').perms.join() === 'CREATIVE' && (pres.body.types || []).find((t) => t.value === 'REVIEWER').perms.join() === 'VIEW,AGREEMENT,REQUEST,DECIDE,INTERVIEW,FEEDBACK', pres.body && pres.body.types);
  } catch (e) {
    check('the test ran to the end', false, e.stack || e.message);
  } finally {
    // ---------------------------------------------------------------- clean up
    try {
      if (made.reviews.length) await S.run(`DELETE FROM "OmniMkClientReview" WHERE id IN (${made.reviews.map(() => '?').join(',')})`, ...made.reviews);
      if (made.content.length) await S.run(`DELETE FROM "OmniMkContent" WHERE id IN (${made.content.map(() => '?').join(',')})`, ...made.content);
      if (made.images.length) await S.run(`DELETE FROM "OmniMkImage" WHERE id IN (${made.images.map(() => '?').join(',')})`, ...made.images);
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } });
      await prisma.notification.deleteMany({ where: { title: { contains: 'ZZTEST' } } });
      await prisma.notification.deleteMany({ where: { message: { contains: 'ZZTEST' } } });
      await prisma.portalRequest.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      if (savedSocial) await prisma.appSetting.update({ where: { key: 'social.accounts' }, data: { value: savedSocial.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'social.accounts' } });
      await Cfg.saveClientAccounts(savedMap);
    } catch (e) { console.log(`(clean-up: ${e.message})`); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
