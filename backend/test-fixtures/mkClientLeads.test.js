// AI Marketing > Client plans > Leads (marketing/clientLeads.js, routes/mkLeadPublic.js): the client's enquiry page, leads by form and by hand, button presses, the spreadsheet and the monthly report.
//   node backend/test-fixtures/mkClientLeads.test.js     (runs on a throw-away copy of prisma/sandbox.db and a local server; nothing real is touched, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-leads-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const express = require('express');
const CS = require('../src/marketing/clientServices');
const L = require('../src/marketing/clientLeads');
const Mrep = require('../src/marketing/monthlyReport');
const S = require('../src/outreach/store');
const { resetRateLimits } = require('../src/utils/publicRateLimit');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const stranger = { id: 'u-stranger', name: 'Other Team', role: 'EMPLOYEE', atsRole: 'RECRUITER', department: 'No Such Department' };
const count = async (table) => S.num((await S.q(`SELECT COUNT(*) AS n FROM "${table}"`))[0].n);
let server;

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const month = CS.istMonth(); const today = CS.istDay();
  // the table as the first release made it (no "clientSees" yet): it must be upgraded in place
  await S.run('CREATE TABLE IF NOT EXISTS "OmniMkLeadPage" ("planId" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "isOn" INTEGER NOT NULL DEFAULT 0, "heading" TEXT, "phone" TEXT, "whatsapp" TEXT, "privacyContact" TEXT, "updatedById" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)');
  const made = await CS.createPlan(admin, { clientName: 'Lead <Test> Clinic', plan: 'premium', months: 1, startDate: today, industry: 'Clinic', department: 'Medical' });
  assert.ok(made.plan, JSON.stringify(made)); const id = made.plan.id;

  // 1. the page settings
  let d = await L.forPlan(admin, id, month); assert.deepEqual([d.page.on, d.page.path, d.counts.total, d.leads.length], [false, '', 0, 0]);
  assert.equal(await L.reportCounts(id, month), null, 'no tracking: no section in the report');
  assert.match((await L.savePage(admin, id, { on: true, phone: '9999900000' })).error, /privacy contact/i);
  assert.match((await L.savePage(admin, id, { phone: 'call me' })).error, /call number/i);
  assert.match((await L.savePage(admin, id, { whatsapp: '12345' })).error, /WhatsApp number/i);
  assert.match((await L.savePage(admin, id, { privacyContact: 'someone' })).error, /privacy contact/i);
  assert.equal((await L.savePage(stranger, id, { on: false })).status, 404, 'another department cannot touch it');
  let saved = await L.savePage(admin, id, { on: false, phone: '99999 00000', privacyContact: 'privacy@example.com' });
  assert.ok(saved.page && /^\/api\/public\/mk-lead\/[a-f0-9]{32}$/.test(saved.page.path), JSON.stringify(saved));
  const token = saved.page.path.split('/').pop();
  assert.equal(await L.publicPage(token), null, 'switched off: not shown');
  saved = await L.savePage(admin, id, { on: true, phone: '99999 00000', privacyContact: 'privacy@example.com', heading: 'Book a <visit>' });
  assert.deepEqual([saved.page.on, saved.page.phone, saved.page.path.split('/').pop()], [true, '919999900000', token], 'the link stays the same');
  assert.equal(L.phoneDigits('+91 98765-43210'), '919876543210'); assert.equal(L.phoneDigits('098765 43210'), '919876543210'); assert.equal(L.phoneDigits('98765'), ''); assert.equal(L.phoneDigits('9876543210 x'), '');
  assert.equal(await L.publicPage('0'.repeat(32)), null); assert.equal(await L.publicPage('../etc'), null);
  console.log('PASS page settings: privacy contact needed to switch on, numbers checked, other departments refused, one lasting link, off or unknown = not shown');

  // 2. the public page over HTTP
  const app = express(); app.use(express.json()); app.use('/api/public/mk-lead', require('../src/routes/mkLeadPublic'));
  await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
  const base = `http://127.0.0.1:${server.address().port}/api/public/mk-lead`;
  const get = (u) => fetch(base + u, { redirect: 'manual' });
  const post = (u, body) => fetch(base + u, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  let res = await get(`/${token}?s=facebook`); let html = await res.text();
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.ok(html.includes('Book a &lt;visit&gt;') && !html.includes('Book a <visit>') && !html.includes('Lead <Test>'), 'every word is escaped');
  assert.ok(html.includes('href="tel:+919999900000"') && !html.includes('wa.me'), 'only the buttons that have a number');
  assert.ok(html.includes('I agree that Lead &lt;Test&gt; Clinic may contact me') && html.includes('privacy@example.com') && html.includes('name="consent"'));
  assert.deepEqual([await count('OmniMkClientLead'), await count('OmniMkLeadPress')], [0, 0], 'opening the page records nothing');
  assert.equal((await get(`/${'a'.repeat(32)}`)).status, 404);
  res = await post(`/${token}?s=facebook`, { name: 'Ravi "R" <b>', phone: '9876543210', message: 'Need <script>x</script>' }); html = await res.text();
  assert.equal(res.status, 400); assert.ok(/tick the permission box/i.test(html) && html.includes('Ravi &quot;R&quot; &lt;b&gt;') && !html.includes('<script>x'), 'the typed words come back, escaped');
  res = await post(`/${token}`, { name: 'A', phone: '9876543210', consent: 'yes' }); assert.equal(res.status, 400);
  res = await post(`/${token}`, { name: 'Ravi', phone: '12', consent: 'yes' }); assert.equal(res.status, 400);
  res = await post(`/${token}`, { name: 'Ravi', phone: '9876543210', email: 'nope', consent: 'yes' }); assert.equal(res.status, 400);
  res = await post(`/${token}`, { name: 'Robot', phone: '9876500000', consent: 'yes', website: 'http://spam' }); assert.equal(res.status, 303);
  assert.equal(await count('OmniMkClientLead'), 0, 'refused and robot forms save nothing');
  resetRateLimits();
  res = await post(`/${token}?s=facebook`, { name: 'Ravi', phone: '98765 43210', message: '=HYPERLINK("x")', consent: 'yes' });
  assert.deepEqual([res.status, res.headers.get('location')], [303, `/api/public/mk-lead/${token}?s=facebook&done=1`]);
  assert.ok((await (await get(`/${token}?s=facebook&done=1`)).text()).includes('We have your enquiry'));
  res = await post(`/${token}?s=google`, { name: 'Someone Else', phone: '+91 9876543210', message: 'Second message', consent: 'yes' }); assert.equal(res.status, 303);
  d = await L.forPlan(admin, id, month); assert.equal(d.leads.length, 1, 'the same phone in a month is one lead'); let lead = d.leads[0];
  assert.deepEqual([lead.name, lead.phone, lead.source, lead.how, lead.status, lead.times], ['Ravi', '919876543210', 'facebook', 'form', 'new', 2], 'the first name and source are kept');
  assert.ok(lead.message.includes('Second message'));
  const row = (await S.q('SELECT consentText, consentAt FROM "OmniMkClientLead"'))[0]; assert.ok(row.consentText.includes('may contact me') && row.consentAt, 'the words agreed to are saved');
  res = await post(`/${token}?s=evil"><x`, { name: 'Sita', phone: '9876500001', consent: 'yes' }); assert.equal(res.headers.get('location'), `/api/public/mk-lead/${token}?s=direct&done=1`, 'an unknown source is "direct"');
  resetRateLimits(); let last = 0; for (let i = 0; i < 11; i += 1) last = (await post(`/${token}`, { name: 'X', phone: '1' })).status; assert.equal(last, 429, 'a flood from one network is stopped'); resetRateLimits();
  console.log('PASS public page: escaped, nothing saved on open, permission tick needed, robot box, one lead per phone per month, source kept, flood limit');

  // 3. the team's bell has no personal details
  const bells = []; const page = await L.publicPage(token);
  const out = await L.publicSubmit(page, 'instagram', { name: 'Private Person', phone: '9876500002', message: 'secret words', consent: 'yes' }, { recipients: async () => ['u1'], notify: async (to, m) => bells.push({ to, ...m }) });
  assert.ok(out.ok); await L.publicSubmit(page, 'instagram', { name: 'Private Person', phone: '9876500002', consent: 'yes' }, { recipients: async () => ['u1'], notify: async (to, m) => bells.push({ to, ...m }) });
  assert.equal(bells.length, 1, 'one bell per new enquiry'); assert.ok(/New enquiry: Lead <Test> Clinic/.test(bells[0].title) && /Instagram/.test(bells[0].message));
  assert.ok(!/Private|9876500002|secret/.test(bells[0].title + bells[0].message));
  console.log('PASS bell: once per new enquiry, no name, number or message in it');

  // 4. button presses
  assert.equal((await post(`/${token}/press?s=instagram`, { button: 'call' })).status, 204);
  await post(`/${token}/press`, { button: 'whatsapp' }); await post(`/${token}/press`, { button: 'other' });
  d = await L.forPlan(admin, id, month); assert.deepEqual([d.counts.callPresses, d.counts.whatsappPresses], [1, 0], 'a button the page does not have is not counted');
  await L.savePage(admin, id, { on: true, phone: '9999900000', whatsapp: '8888800000', privacyContact: '9999900000' });
  html = await (await get(`/${token}?s=website`)).text(); assert.ok(html.includes('https://wa.me/918888800000'));
  await post(`/${token}/press?s=website`, { button: 'whatsapp' });
  d = await L.forPlan(admin, id, month); assert.equal(d.counts.whatsappPresses, 1);
  console.log('PASS presses: Call and WhatsApp counted only when pressed and only when the page has them');

  // 5. the team's own leads and the work on them
  assert.match((await L.addByHand(admin, id, {})).error, /name or the phone/i); assert.match((await L.addByHand(admin, id, { phone: 'abc' })).error, /phone number/i);
  assert.equal((await L.addByHand(stranger, id, { name: 'No' })).status, 404);
  const hand = await L.addByHand(admin, id, { name: '+Walk In', source: 'walkin', message: 'came to the desk' }); assert.ok(hand.ok);
  assert.equal((await L.setLead(admin, id, hand.id, { status: 'gone' })).status, 400); assert.equal((await L.setLead(stranger, id, hand.id, { status: 'customer' })).status, 404);
  const other = await CS.createPlan(admin, { clientName: 'Second Client', plan: 'basic', months: 1, startDate: today });
  assert.equal((await L.setLead(admin, other.plan.id, hand.id, { status: 'customer' })).status, 404, 'a lead cannot be reached through another client');
  assert.equal((await L.removeLead(admin, other.plan.id, hand.id)).status, 404);
  assert.ok((await L.setLead(admin, id, hand.id, { status: 'customer', note: 'joined' })).ok);
  d = await L.forPlan(admin, id, month); assert.deepEqual([d.counts.total, d.counts.form, d.counts.hand, d.counts.customers, d.counts.waiting], [4, 3, 1, 1, 3]);
  assert.equal(d.leads.find((x) => x.id === hand.id).note, 'joined');
  assert.equal((await L.forPlan(stranger, id, month)).status, 404); assert.equal((await L.forPlan(admin, other.plan.id, month)).leads.length, 0, 'each client sees only its own');
  const file = await L.csv(admin, id, month); assert.ok(file.csv.startsWith('﻿"Date and time (India)"') && /^leads-Lead-Test-Clinic-\d{4}-\d{2}\.csv$/.test(file.name), file.name);
  assert.ok(file.csv.includes('"\'+Walk In"') && file.csv.includes('"\'=HYPERLINK(""x"")'), 'a spreadsheet never runs a lead\'s words');
  assert.equal((await L.csv(stranger, id, month)).status, 404);
  console.log('PASS team leads: added by hand, status and note, only through their own client, spreadsheet safe');

  // 6. the monthly report
  let rep = await Mrep.build(admin, id, month); assert.ok(rep.report, JSON.stringify(rep).slice(0, 300));
  assert.ok(rep.report.html.includes('Enquiries tracked by TeamLink') && rep.report.text.includes('- Enquiries recorded: 4') && rep.report.text.includes('- Call button presses: 1') && rep.report.text.includes('- Became customers: 1') && rep.report.text.includes('- Came from Walk-in: 1'), rep.report.text);
  assert.ok(rep.report.improve.some((x) => x === '3 enquiries are still marked New: contact those people.'), rep.report.improve.join(' | '));
  assert.ok(!/Ravi|9876543210/.test(rep.report.html), 'the report carries counts, not people');
  const rep2 = await Mrep.build(admin, other.plan.id, month); assert.ok(!rep2.report.html.includes('Enquiries tracked by TeamLink'));
  assert.ok((await L.removeLead(admin, id, hand.id)).ok); assert.equal((await L.forPlan(admin, id, month)).counts.total, 3);
  assert.equal(S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkClientLead" WHERE id = ?', hand.id))[0].n), 0, 'deleted for good');
  console.log('PASS monthly report: counts and the "contact them" line, no personal details; delete is for good');

  // 7. an ended plan closes its page
  await CS.updatePlan(admin, id, { status: 'ended' });
  assert.equal(await L.publicPage(token), null); assert.equal((await get(`/${token}`)).status, 404);
  assert.match((await L.savePage(admin, id, { on: true, privacyContact: '9999900000' })).error, /has ended/i);
  console.log('PASS ended plan: the page closes and cannot be switched on');

  // 8. the signed-in routes are wired
  const api = express(); api.use(express.json()); api.use((req, _res, next) => { req.user = admin; next(); }); api.use('/m', require('../src/routes/omniGsMarketing'));
  const s2 = await new Promise((ok) => { const s = api.listen(0, '127.0.0.1', () => ok(s)); });
  const A = `http://127.0.0.1:${s2.address().port}/m/services/plans/${other.plan.id}/leads`;
  const send = (method, u, body) => fetch(u, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await send('PUT', `${A}/page`, { on: true, privacyContact: '9999900000' })).status, 200);
  const added = await (await send('POST', A, { name: 'Route Lead' })).json(); assert.ok(added.ok, JSON.stringify(added));
  assert.equal((await send('PUT', `${A}/${added.id}`, { status: 'contacted' })).status, 200);
  const listed = await (await fetch(`${A}?month=${month}`)).json(); assert.deepEqual([listed.leads.length, listed.leads[0].status], [1, 'contacted']);
  const dl = await fetch(`${A}.csv?month=${month}`); assert.ok(dl.status === 200 && /text\/csv/.test(dl.headers.get('content-type')) && /attachment/.test(dl.headers.get('content-disposition')) && (await dl.text()).includes('Route Lead'));
  assert.equal((await send('DELETE', `${A}/${added.id}`)).status, 200);
  s2.close();
  console.log('PASS routes: page, add, change, list, download and delete work behind the sign-in');

  // 9. the client's own view: only when the team switched it on, only their own company
  const prisma = require('../src/db');
  const mineCo = await prisma.client.create({ data: { name: 'Lead <Test> Clinic' } });
  let seen = await L.forClientLogin(mineCo, month); assert.deepEqual([seen.shared, seen.leads, seen.counts], [false, undefined, undefined], 'off until the team ticks it');
  await L.addByHand(admin, id, { name: 'Shared Person', phone: '9876500077', source: 'phone', message: 'call back' });
  const shared = (await L.forPlan(admin, id, month)).leads.find((x) => x.name === 'Shared Person'); await L.setLead(admin, id, shared.id, { status: 'contacted', note: 'TEAM ONLY NOTE' });
  assert.equal((await L.savePage(admin, id, { on: false, privacyContact: '9999900000', clientSees: true })).page.clientSees, true);
  assert.equal((await L.savePage(admin, id, { on: false, privacyContact: '9999900000' })).page.clientSees, true, 'a save without the tick keeps it');
  seen = await L.forClientLogin(mineCo, month); assert.ok(seen.shared && seen.counts.total >= 1 && seen.leads.some((x) => x.name === 'Shared Person' && x.statusWords === 'Contacted' && x.phone === '919876500077'), JSON.stringify(seen).slice(0, 300));
  assert.ok(!/TEAM ONLY NOTE|addedByName|Test Admin|"note"/.test(JSON.stringify(seen)), 'no team notes or team names');
  assert.equal((await L.forClientLogin(mineCo, '2020-01')).leads.length, 0);
  const otherCo = await prisma.client.create({ data: { name: 'Somebody Else Ltd' } });
  seen = await L.forClientLogin(otherCo, month); assert.deepEqual([seen.shared, seen.leads], [false, undefined], 'another company sees nothing');
  const twin = await prisma.client.create({ data: { name: '  lead <test> clinic ' } });
  seen = await L.forClientLogin(mineCo, month); assert.deepEqual([seen.shared, seen.leads], [false, undefined], 'two companies with one name: nothing is shown to either');
  assert.equal((await L.forClientLogin(twin, month)).shared, false); await prisma.client.delete({ where: { id: twin.id } });
  console.log('PASS client view: off until ticked, own company only, nothing for a same-name company, no team notes or names');

  // 10. the client's route: a signed-in client with the creative tick only
  const auth = require('../src/middleware/auth'); let who = null; auth.requireAuth = (req, _res, next) => { req.user = who; next(); };
  const portal = express(); portal.use(express.json()); portal.use('/p', require('../src/routes/portalPosts'));
  const s3 = await new Promise((ok) => { const s = portal.listen(0, '127.0.0.1', () => ok(s)); }); const P = `http://127.0.0.1:${s3.address().port}/p/leads?month=${month}`;
  who = { id: 'u-c1', role: 'CLIENT', clientId: mineCo.id, portalPerms: 'CREATIVE' }; let rr = await fetch(P); let jj = await rr.json();
  assert.equal(rr.status, 200, JSON.stringify(jj)); assert.equal(rr.headers.get('cache-control'), 'no-store'); assert.ok(jj.shared && jj.leads.length >= 1);
  who = { id: 'u-c2', role: 'CLIENT', clientId: otherCo.id, portalPerms: 'CREATIVE' }; jj = await (await fetch(`${P}&clientId=${mineCo.id}&company=Lead`)).json(); assert.equal(jj.shared, false, 'the address cannot ask for another company');
  who = { id: 'u-c3', role: 'CLIENT', clientId: mineCo.id, portalPerms: 'INVOICES' }; assert.equal((await fetch(P)).status, 403, 'without the creative tick');
  who = admin; assert.equal((await fetch(P)).status, 403, 'staff use their own screen');
  s3.close();
  console.log('PASS client route: own company from the login only, the tick is needed, staff and others refused');

  server.close(); console.log('ALL PASS'); process.exit(0);
})().catch((e) => { console.error(e); if (server) server.close(); process.exit(1); });
