#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL AI MARKETING, PHASE 1 TEST (2026-11-11): shared AI layer + brand voice + AI Content + approval + usage + audit.
// SANDBOX ONLY: talks to the running sandbox API (npm run sandbox -- --detach, http://localhost:4011) and to its throw-away database
// (prisma/sandbox.db). It refuses to run against anything else. Nothing real is sent; the sandbox blocks every outbound call and AI is the offline sample writer.
//   cd backend && node scripts/omni-mk-content-test.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const DB = path.resolve(process.env.SANDBOX_DB || path.join(BACK, 'prisma', 'sandbox.db'));
if (!/sandbox\.db$/i.test(DB) || !fs.existsSync(DB)) { console.error('Refusing: this test only runs against prisma/sandbox.db (npm run sandbox).'); process.exit(2); }
const API = process.env.SANDBOX_API || 'http://127.0.0.1:4011';
if (!/:4011\b/.test(API)) { console.error('Refusing: the sandbox API is on :4011.'); process.exit(2); }
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const A0 = require(path.join(BACK, 'src/outreach/access'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
const RUN = Date.now().toString(36);
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const G = '/api/outreach/gs/marketing';

(async () => {
  const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
  const live = { employee: { is: { employmentStatus: 'Active' } } };
  const sa = await first({ role: 'SUPER_ADMIN' });
  let tl = null; let tlDept = '';
  for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 30 })) { // eslint-disable-line no-await-in-loop
    const id = await resolveIdentity(c.id); // eslint-disable-line no-await-in-loop
    const d = A0.departmentsOf(id);
    if (A0.kind(id) === 'tl' && d && d.length === 1) { tl = c; tlDept = d[0]; break; }
  }
  const bde = await first({ atsRole: 'BDE', ...live });
  const rec = await first({ atsRole: 'RECRUITER', ...live });
  check('0 the copy has a Super Admin, a Team Lead with one department, a BDE and a recruiter', !!(sa && tl && tlDept && bde && rec), { sa: !!sa, tl: !!tl, bde: !!bde, rec: !!rec });
  // sandbox copy only (guarded above): real logins still on a starting password are blocked by the API until they change it, so give the four a throw-away hash
  await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, rec].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
  const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
  const mk = async (tag, extra = {}) => prisma.user.create({ data: { ...base, name: `ZZTEST ${tag} ${RUN}`, email: `zz-mk-${tag}-${RUN}@example.test`, username: `zz-mk-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', ...extra } });
  const m1 = await mk('mkt1'); const m2 = await mk('mkt2');
  const client = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT' });
  const permRow = await prisma.appSetting.findUnique({ where: { key: 'omni.permissions' } });
  const perm = permRow ? JSON.parse(permRow.value) : {};
  const ids = new Set([...(perm.marketingUserIds || []), m1.id, m2.id]);
  await prisma.appSetting.upsert({ where: { key: 'omni.permissions' }, create: { key: 'omni.permissions', value: JSON.stringify({ ...perm, marketingUserIds: [...ids] }) }, update: { value: JSON.stringify({ ...perm, marketingUserIds: [...ids] }) } });
  await new Promise((r) => setTimeout(r, 11000)); // the server refreshes the Marketing list every 10 seconds
  const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), rec: await tokenOf(rec), m1: await tokenOf(m1), m2: await tokenOf(m2), client: await tokenOf(client) };
  const reset = async () => { await http('PUT', `${G}/settings`, T.sa, { aiDailyPerUser: 60, aiMonthlyCap: 0, selfApprove: true }); };
  await reset();

  // ============================================================ A: who gets in
  for (const k of ['client', 'rec', 'bde']) check(`A1 ${k} is refused (403) on AI Marketing`, (await http('GET', `${G}/meta`, T[k])).status === 403);
  check('A2 no login is refused (401)', (await http('GET', `${G}/meta`)).status === 401);
  const me = async (k) => (await http('GET', '/api/outreach/me', T[k])).body || {};
  const meSa = await me('sa'); const meM = await me('m1');
  const pSa = meSa.pages || []; const pM = meM.pages || []; const pTl = (await me('tl')).pages || [];
  check('A3 Super Admin and Marketing get all five AI Marketing tabs', ['mkhome', 'mkcontent', 'mkapprove', 'mkbrand', 'mkusage'].every((p) => pSa.includes(p) && pM.includes(p)), { sa: meSa.error || pSa.length, m: meM.error || pM.length, kind: meM.kind });
  check('A4 a Team Lead gets only the home and Approvals tabs', pTl.includes('mkhome') && pTl.includes('mkapprove') && !pTl.includes('mkcontent') && !pTl.includes('mkbrand') && !pTl.includes('mkusage'), pTl);
  check('A5 a Team Lead cannot write with AI (403) and cannot read usage (403)', (await http('POST', `${G}/generate`, T.tl, { brief: 'x'.repeat(30), channels: ['sms'] })).status === 403 && (await http('GET', `${G}/usage`, T.tl)).status === 403);

  // ============================================================ B: meta
  const meta = await http('GET', `${G}/meta`, T.sa);
  // 2026-11-13: module 7 Content Calendar is live too (marketing/calendar.js); the five others are still planned
  const liveIds = (meta.body.modules || []).filter((m) => m.status === 'live').map((m) => m.id).sort().join(',');
  check('B1 seven modules: AI Content and Content Calendar live, the other five planned', meta.status === 200 && meta.body.modules.length === 7 && liveIds === 'calendar,content' && meta.body.modules.filter((m) => m.status === 'planned').length === 5, meta.text.slice(0, 200));
  check('B2 the other 24 names are on the menu', Array.isArray(meta.body.later) && meta.body.later.length === 24, meta.body.later && meta.body.later.length);
  check('B3 text AI is the labelled sample writer in the sandbox; image / video / audio are "not connected"', meta.body.ai.text.demo === true && meta.body.ai.text.ready && ['image', 'video', 'audio'].every((c) => meta.body.ai[c].ready === false), meta.body.ai);
  check('B4 channels include RCS with its limit', meta.body.channels.some((c) => c.key === 'rcs' && c.limit === 1000) && meta.body.channels.length === 8);

  // ============================================================ C: brand voice
  const noBrand = await http('POST', `${G}/generate`, T.m1, { brief: 'We are running a hiring drive for engineers in Hyderabad.', channels: ['sms'] });
  const hadBrand = (await http('GET', `${G}/brand`, T.m1)).body.brand.brandName;
  if (!hadBrand) check('C1 no brand voice yet: the AI refuses with a plain sentence (400 NO_BRAND)', noBrand.status === 400 && noBrand.body.code === 'NO_BRAND', noBrand.text);
  check('C2 a Team Lead cannot change the brand voice (403)', (await http('PUT', `${G}/brand`, T.tl, { brandName: 'X' })).status === 403);
  check('C3 a brand needs a name (400)', (await http('PUT', `${G}/brand`, T.m1, { brandName: '  ' })).status === 400);
  const bsave = await http('PUT', `${G}/brand`, T.m1, { brandName: 'TeamLink', about: 'Recruitment and HR services', voice: 'Warm, clear, no jargon', tone: 'Warm & confident', language: 'English', cta: 'Reply YES to talk to us', signOff: 'Team TeamLink', doWords: 'talent, partner', avoidWords: 'guarantee, free', samples: ['We find the right people, fast.'] });
  check('C4 Marketing saves the brand voice', bsave.status === 200 && bsave.body.brand.brandName === 'TeamLink' && bsave.body.brand.avoidWords.length === 2, bsave.text.slice(0, 200));
  check('C5 a bad tone is refused (400)', (await http('PUT', `${G}/brand`, T.m1, { brandName: 'TeamLink', tone: 'Sarcastic' })).status === 400);

  // ============================================================ D: AI writing
  check('D1 a one-word brief is refused (400)', (await http('POST', `${G}/generate`, T.m1, { brief: 'hi', channels: ['sms'] })).status === 400);
  check('D2 no channel is refused (400)', (await http('POST', `${G}/generate`, T.m1, { brief: 'Hiring drive for engineers this weekend.', channels: [] })).status === 400);
  const chans = ['whatsapp', 'sms', 'email', 'rcs', 'instagram', 'x'];
  const gen = await http('POST', `${G}/generate`, T.m1, { brief: 'We are running a free hiring drive for engineers in Hyderabad this Saturday. Walk in with your resume.', goal: 'Hiring', audience: 'engineers', channels: chans, variants: 3 });
  check('D3 three versions come back, each with a text for every channel', gen.status === 200 && gen.body.variants.length === 3 && gen.body.variants.every((v) => chans.every((k) => v.texts[k])), gen.text.slice(0, 300));
  const LIM = Object.fromEntries(meta.body.channels.map((c) => [c.key, c.limit]));
  check('D4 every text is inside its channel limit', gen.body.variants.every((v) => chans.every((k) => v.texts[k].length <= LIM[k])));
  const v1 = gen.body.variants[0];
  check('D5 WhatsApp, SMS and RCS end with the opt-out line; email has the unsubscribe tag; the email has a subject', /Reply STOP to opt out$/i.test(v1.texts.whatsapp) && /Reply STOP to opt out$/i.test(v1.texts.sms) && /STOP/i.test(v1.texts.rcs) && /\{\{unsubscribe\}\}/.test(v1.texts.email) && !!v1.subject, v1);
  check('D6 the answer says it is the sandbox sample writer (demo true), never passed off as real AI', gen.body.ai.demo === true && /sample/i.test(String(gen.body.ai.model)), gen.body.ai);
  check('D7 a brand "never say" word is flagged ("free" in the brief reaches the text)', gen.body.variants.some((v) => Object.values(v.flags || {}).some((f) => f.includes('free'))), gen.body.variants.map((v) => v.flags));
  const rv = await http('POST', `${G}/revise`, T.m1, { channel: 'sms', text: v1.texts.sms, instruction: 'shorter' });
  check('D8 "make it shorter" rewrites one channel and still ends with the opt-out line', rv.status === 200 && rv.body.text.length <= v1.texts.sms.length && /STOP/i.test(rv.body.text), rv.text.slice(0, 200));
  check('D9 revise needs an instruction (400) and a real channel (400)', (await http('POST', `${G}/revise`, T.m1, { channel: 'sms', text: 'hello there', instruction: '' })).status === 400 && (await http('POST', `${G}/revise`, T.m1, { channel: 'fax', text: 'hello', instruction: 'shorter' })).status === 400);

  // ============================================================ E: drafts and approval
  const body = { title: `ZZTEST Hiring drive ${RUN}`, brief: 'Walk-in hiring drive for engineers', goal: 'Hiring', audience: 'engineers', cta: 'Reply YES', tone: 'Warm & confident', language: 'English', channels: chans, texts: v1.texts, subject: v1.subject, variants: gen.body.variants, ai: gen.body.ai };
  const over = await http('POST', `${G}/items`, T.m1, { ...body, texts: { ...v1.texts, x: 'y'.repeat(400) } });
  check('E1 a text over its channel limit is refused (400)', over.status === 400, over.text.slice(0, 160));
  check('E2 a draft with no text is refused (400)', (await http('POST', `${G}/items`, T.m1, { ...body, texts: {} })).status === 400);
  const c1 = await http('POST', `${G}/items`, T.m1, body);
  check('E3 Marketing saves a draft: status draft, mine, can edit and submit, cannot approve', c1.status === 200 && c1.body.item.status === 'draft' && c1.body.item.mine && c1.body.item.canEdit && c1.body.item.canSubmit && !c1.body.item.canApprove, c1.text.slice(0, 200));
  const id = c1.body.item.id;
  const ed = await http('PUT', `${G}/items/${id}`, T.m1, { texts: { ...v1.texts, whatsapp: `${v1.texts.whatsapp}\n\nSee you there!`.slice(0, 1024) } });
  check('E4 the writer edits the draft', ed.status === 200 && /See you there/.test(ed.body.item.texts.whatsapp), ed.text.slice(0, 160));
  check('E5 another Marketing login (no department) sees the draft; a Team Lead does not (404)', (await http('GET', `${G}/items/${id}`, T.m2)).status === 200 && (await http('GET', `${G}/items/${id}`, T.tl)).status === 404);
  check('E6 the draft is NOT in the Content Library yet', !((await http('GET', '/api/outreach/gs/studio/content', T.sa)).body.items || []).some((x) => x.name === body.title));
  const sub = await http('POST', `${G}/items/${id}/submit`, T.m1);
  check('E7 send for approval: status waiting', sub.status === 200 && sub.body.item.status === 'waiting' && !sub.body.item.canEdit, sub.text.slice(0, 200));
  check('E8 the writer cannot approve their own content (403)', (await http('POST', `${G}/items/${id}/approve`, T.m1, {})).status === 403);
  check('E9 another Marketing login cannot approve (403)', (await http('POST', `${G}/items/${id}/approve`, T.m2, {})).status === 403);
  check('E10 a waiting item cannot be edited (403) or deleted (409)', (await http('PUT', `${G}/items/${id}`, T.m1, { title: 'x' })).status === 403 && (await http('DELETE', `${G}/items/${id}`, T.m1)).status === 409);
  check('E11 sending back needs a note (400)', (await http('POST', `${G}/items/${id}/reject`, T.sa, { note: 'no' })).status === 400);
  const rej = await http('POST', `${G}/items/${id}/reject`, T.sa, { note: 'Please remove the word free.' });
  check('E12 the Admin sends it back with a note: status changes, note kept, still not in the Library', rej.status === 200 && rej.body.item.status === 'changes' && /remove the word free/.test(rej.body.item.note), rej.text.slice(0, 200));
  check('E13 the writer fixes it and sends it again', (await http('PUT', `${G}/items/${id}`, T.m1, { title: body.title })).status === 200 && (await http('POST', `${G}/items/${id}/submit`, T.m1)).status === 200);
  const apr = await http('POST', `${G}/items/${id}/approve`, T.sa, { note: 'Good to go.' });
  check('E14 the Admin approves: status approved, in the Library, not self-approved', apr.status === 200 && apr.body.item.status === 'approved' && apr.body.item.inLibrary && !apr.body.item.selfApproved && !!apr.body.item.libraryId, apr.text.slice(0, 250));
  const lib = await http('GET', `/api/outreach/gs/studio/content/${apr.body.item.libraryId}`, T.sa);
  check('E15 the Content Library has the approved words for WhatsApp, SMS and Email (RCS stays here)', lib.status === 200 && lib.body.content.adaptations.whatsapp && lib.body.content.adaptations.sms && lib.body.content.adaptations.email && !lib.body.content.adaptations.rcs, lib.text.slice(0, 250));
  check('E16 the campaign screens can read it (the Library list shows it)', ((await http('GET', '/api/outreach/gs/studio/content', T.sa)).body.items || []).some((x) => x.id === apr.body.item.libraryId));
  const ed2 = await http('PUT', `${G}/items/${id}`, T.m1, { texts: { ...v1.texts, sms: `${v1.texts.sms}`.slice(0, 400) } });
  check('E17 changing approved content withdraws the approval (back to draft) and takes the Library copy away', ed2.status === 200 && ed2.body.item.status === 'draft' && ed2.body.withdrawn === true && (await http('GET', `/api/outreach/gs/studio/content/${apr.body.item.libraryId}`, T.sa)).status === 404, ed2.text.slice(0, 200));

  // department rule: a Team Lead approves content of their own department, never their own
  const dItem = await http('POST', `${G}/items`, T.sa, { ...body, title: `ZZTEST Dept ${RUN}`, department: tlDept });
  check('E18 an Admin saves content for a department', dItem.status === 200 && dItem.body.item.department.toLowerCase() === tlDept.toLowerCase(), dItem.text.slice(0, 200));
  await http('POST', `${G}/items/${dItem.body.item.id}/submit`, T.sa);
  const tlView = await http('GET', `${G}/items/${dItem.body.item.id}`, T.tl);
  check('E19 that department\'s Team Lead sees it and may approve it', tlView.status === 200 && tlView.body.item.canApprove === true, tlView.text.slice(0, 200));
  const tlApr = await http('POST', `${G}/items/${dItem.body.item.id}/approve`, T.tl, { note: '' });
  check('E20 the Team Lead approves; approved by the Team Lead (not self-approved)', tlApr.status === 200 && tlApr.body.item.status === 'approved' && !tlApr.body.item.selfApproved, tlApr.text.slice(0, 200));
  const adminOwn = await http('POST', `${G}/items`, T.sa, { ...body, title: `ZZTEST Own ${RUN}` });
  await http('POST', `${G}/items/${adminOwn.body.item.id}/submit`, T.sa);
  const selfApr = await http('POST', `${G}/items/${adminOwn.body.item.id}/approve`, T.sa, {});
  check('E21 an Admin may approve their own content, and it is recorded as self-approved', selfApr.status === 200 && selfApr.body.item.selfApproved === true, selfApr.text.slice(0, 200));
  await http('PUT', `${G}/settings`, T.sa, { selfApprove: false });
  const own2 = await http('POST', `${G}/items`, T.sa, { ...body, title: `ZZTEST Own2 ${RUN}` });
  await http('POST', `${G}/items/${own2.body.item.id}/submit`, T.sa);
  check('E22 with the Admin switch off, an Admin cannot approve their own content (403)', (await http('POST', `${G}/items/${own2.body.item.id}/approve`, T.sa, {})).status === 403);
  await reset();
  const list = await http('GET', `${G}/items?status=approved`, T.sa);
  check('E23 the list filters by status', list.status === 200 && list.body.items.every((x) => x.status === 'approved') && list.body.items.length >= 2, list.text.slice(0, 160));
  const ov = await http('GET', `${G}/overview`, T.sa);
  check('E24 the overview counts drafts / waiting / approved and the AI use of the month', ov.status === 200 && ov.body.counts.approved >= 2 && ov.body.counts.waiting >= 1 && ov.body.usage.month >= 2 && ov.body.brandReady === true, ov.text.slice(0, 250));
  check('E25 a draft can be deleted by its writer', (await http('DELETE', `${G}/items/${id}`, T.m1)).status === 200 && (await http('GET', `${G}/items/${id}`, T.m1)).status === 404);

  // ============================================================ F: usage + limits
  const us = await http('GET', `${G}/usage`, T.sa);
  check('F1 usage log: Admin sees everybody, with who / task / provider; failures are logged too', us.status === 200 && us.body.scope === 'all' && us.body.recent.length >= 3 && us.body.recent.every((r) => r.provider) && us.body.summary.byModule.length >= 1 && us.body.canEdit, us.text.slice(0, 250));
  const um = await http('GET', `${G}/usage`, T.m1);
  check('F2 Marketing sees only their own lines and cannot edit limits', um.status === 200 && um.body.scope === 'mine' && um.body.recent.every((r) => r.userName.includes('mkt1')) && !um.body.canEdit && (await http('PUT', `${G}/settings`, T.m1, { aiDailyPerUser: 5 })).status === 403, um.text.slice(0, 250));
  check('F3 a silly limit is refused (400)', (await http('PUT', `${G}/settings`, T.sa, { aiDailyPerUser: -4 })).status === 400);
  const used = (await http('GET', `${G}/usage`, T.m2)).body.summary.today;
  await http('PUT', `${G}/settings`, T.sa, { aiDailyPerUser: used + 1 });
  const ok1 = await http('POST', `${G}/generate`, T.m2, { brief: 'Reminder: payroll cut-off is on the 25th.', channels: ['sms'], variants: 1 });
  const lim = await http('POST', `${G}/generate`, T.m2, { brief: 'Reminder: payroll cut-off is on the 25th.', channels: ['sms'], variants: 1 });
  check('F4 the per-person daily limit stops the next AI request (429, plain words)', ok1.status === 200 && lim.status === 429 && /today/i.test(lim.body.error), [ok1.status, lim.status, lim.text.slice(0, 160)]);
  await http('PUT', `${G}/settings`, T.sa, { aiDailyPerUser: 0 });
  check('F5 limit 0 switches AI off for everybody (403)', (await http('POST', `${G}/generate`, T.m1, { brief: 'Reminder: payroll cut-off is on the 25th.', channels: ['sms'] })).status === 403);
  await http('PUT', `${G}/settings`, T.sa, { aiDailyPerUser: 60, aiMonthlyCap: 1 });
  check('F6 the company monthly limit stops AI for everybody (429)', (await http('POST', `${G}/generate`, T.m1, { brief: 'Reminder: payroll cut-off is on the 25th.', channels: ['sms'] })).status === 429);
  await reset();

  // ============================================================ G: audit + sandbox safety
  const rows = await prisma.auditLog.findMany({ where: { action: { startsWith: 'Omni-Channel AI Marketing' } }, orderBy: { createdAt: 'desc' }, take: 80 });
  const acts = new Set(rows.map((r) => r.action));
  check('G1 the audit trail has the brand change, drafts, send for approval, approval, send back, withdrawal, self-approval and limits', ['brand voice changed', 'content saved', 'content sent for approval', 'content approved', 'content sent back', 'approved content changed (approval withdrawn)', 'content self-approved by an Admin', 'AI limits changed'].every((w) => [...acts].some((a) => a.endsWith(w))), [...acts]);
  check('G2 audit lines carry words and ids, never a phone number or an email address', rows.every((r) => !/\b\d{10}\b/.test(`${r.toValue || ''}`) && !/@[a-z0-9-]+\.[a-z]/i.test(`${r.toValue || ''}`)));
  const own = await prisma.$queryRawUnsafe("SELECT COUNT(*) AS n FROM \"OmniMkAiUsage\" WHERE provider = 'demo'");
  const notDemo = await prisma.$queryRawUnsafe("SELECT COUNT(*) AS n FROM \"OmniMkAiUsage\" WHERE provider IS NOT NULL AND provider <> 'demo'");
  check('G3 in the sandbox every AI call was the offline sample writer (nothing left the machine)', Number(own[0].n) >= 3 && Number(notDemo[0].n) === 0, { demo: Number(own[0].n), other: Number(notDemo[0].n) });
  const notices = await prisma.notification.count({ where: { title: { contains: 'AI content' }, createdAt: { gte: new Date(Date.now() - 3600000) } } });
  check('G4 approvers and writers got in-app notices (titles only)', notices >= 2, notices);

  // clean up what this run made (the test logins; the sandbox copy is throw-away anyway)
  await prisma.$executeRawUnsafe("DELETE FROM \"OmniMkContent\" WHERE title LIKE 'ZZTEST%'");
  await prisma.$executeRawUnsafe("UPDATE \"OmniStudioContent\" SET deletedAt = 1 WHERE name LIKE 'ZZTEST%'");
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(3); });
