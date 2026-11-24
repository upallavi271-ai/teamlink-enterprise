#!/usr/bin/env node
/**
 * CRM WAVE E (2026-11-24): AI, mobile, activities & follow-ups - one section per gap ID (crm-gaps-E.tsv).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; Google, Microsoft, Zoom and the OCR program are stand-ins on this
 * machine (nothing real is called, nobody is messaged).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4400 node scripts/crm-E-test.js
 */
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-E-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = Number(process.env.TEST_PORT) || 4400;
const STUB = PORT + 57;
const API = `http://localhost:${PORT}/api`;
const SB = `http://localhost:${STUB}`;
// the OCR stand-in: "--version", "--list-langs", then the text of a visiting card
const OCR = path.join(os.tmpdir(), `zz-crm-E-ocr-${process.pid}.js`);
fs.writeFileSync(OCR, `const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('tesseract 5.3.0'); process.exit(0); }
if (a[0] === '--list-langs') { console.log('List of available languages (1):\\neng'); process.exit(0); }
console.log('Kiran Varma\\nHR Manager\\nZzcardco Technologies Pvt Ltd\\n+91 98480 22334\\nkiran.varma@zzcardco.in\\nwww.zzcardco.in\\nMadhapur, Hyderabad - 500081');
`);
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-E-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'crm-E-test-secret-key', APP_BASE_URL: `http://localhost:${PORT}`, OCR_TESSERACT_BIN: OCR,
  CRM_GOOGLE_AUTH_URL: `${SB}/g/auth`, CRM_GOOGLE_TOKEN_URL: `${SB}/g/token`, CRM_GOOGLE_API: `${SB}/g/api`, CRM_MS_LOGIN: `${SB}/ms`, CRM_MS_GRAPH: `${SB}/msg`,
  CRM_ZOOM_OAUTH: `${SB}/zoom/oauth`, TEST_MOCK_PORTS: String(STUB), CRM_ZOOM_API: `${SB}/zoom/api`, GROQ_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '', AI_PROVIDER: 'none',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');
const IS = require('../src/utils/integrationStore');
const WK = require('../src/crm/workPlus');
const SIG = require('../src/crm/aiSignals');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const call = async (method, url, body, token, raw) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': 'image/jpeg' } : { 'Content-Type': 'application/json' }) };
  const r = await fetch(API + url, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined), redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, location: r.headers.get('location') };
};
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const RUN = process.pid;
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ E ${tag}`, email: `zz.crme.${tag}.${RUN}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const id = (p) => `${p}_zze${Math.random().toString(36).slice(2, 12)}`;

// ---- the stand-in Google / Microsoft / Zoom ----------------------------------------------------------------------------------------
const stub = { events: new Map(), ms: new Map(), calls: [], zoom: 0 };
let evSeq = 0;
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
const stubServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, SB);
  const body = await readBody(req);
  stub.calls.push(`${req.method} ${u.pathname}`);
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/g/token') {
    const f = new URLSearchParams(body);
    if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: `gat-${Date.now()}`, refresh_token: 'grt', expires_in: 3600, id_token: idToken('zz.rep@gmail.test') });
  }
  if (u.pathname.startsWith('/g/api/calendars/primary/events')) {
    const evId = decodeURIComponent(u.pathname.split('/events/')[1] || '');
    if (req.method === 'GET') return json(200, { items: [...stub.events.values()] });
    if (req.method === 'POST') {
      evSeq += 1; const e = { id: `gev${evSeq}`, status: 'confirmed', updated: new Date().toISOString(), ...JSON.parse(body || '{}') };
      if (u.searchParams.get('conferenceDataVersion') === '1') e.hangoutLink = `https://meet.google.com/zz-${evSeq}`;
      stub.events.set(e.id, e); return json(200, e);
    }
    if (req.method === 'PATCH') { const e = { ...(stub.events.get(evId) || { id: evId }), ...JSON.parse(body || '{}'), updated: new Date().toISOString() }; stub.events.set(evId, e); return json(200, e); }
    if (req.method === 'DELETE') { stub.events.delete(evId); res.writeHead(204); return res.end(); }
  }
  if (/^\/ms\/[^/]+\/oauth2\/v2\.0\/token$/.test(u.pathname)) return json(200, { access_token: `mat-${Date.now()}`, refresh_token: 'mrt', expires_in: 3600 });
  if (u.pathname === '/msg/me') return json(200, { mail: 'zz.rep@outlook.test' });
  if (u.pathname === '/msg/me/calendarView') return json(200, { value: [...stub.ms.values()] });
  if (u.pathname.startsWith('/msg/me/events')) {
    if (req.method === 'POST') { evSeq += 1; const e = { id: `mev${evSeq}`, ...JSON.parse(body || '{}') }; if (e.isOnlineMeeting) e.onlineMeeting = { joinUrl: `https://teams.microsoft.com/l/meetup-join/zz${evSeq}` }; stub.ms.set(e.id, e); return json(201, e); }
    const evId = decodeURIComponent(u.pathname.split('/events/')[1] || '');
    if (req.method === 'PATCH') { stub.ms.set(evId, { ...(stub.ms.get(evId) || { id: evId }), ...JSON.parse(body || '{}') }); return json(200, stub.ms.get(evId)); }
    if (req.method === 'DELETE') { stub.ms.delete(evId); res.writeHead(204); return res.end(); }
  }
  if (u.pathname === '/zoom/oauth') return req.headers.authorization === `Basic ${Buffer.from('zcid:zsecret').toString('base64')}` ? json(200, { access_token: 'zat' }) : json(401, { reason: 'bad' });
  if (u.pathname === '/zoom/api/users/me/meetings') { stub.zoom += 1; const j = JSON.parse(body || '{}'); return json(201, { id: 900 + stub.zoom, join_url: `https://zoom.us/j/9000${stub.zoom}`, topic: j.topic, start_time: j.start_time }); }
  return json(404, { error: 'stub: no such path' });
});

let server;
async function stop(code) {
  if (server) server.kill();
  stubServer.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(OCR); } catch { /* none */ } process.exit(code); }, 800);
}
async function saveIntegration(cid, values) {
  const { values: v } = await IS.writeValues(cid, values);
  await prisma.integration.update({ where: { id: cid }, data: { values: JSON.stringify(v) } });
}

(async () => {
  await DB.ensure();
  await require('../src/crm/plusE').ensure();
  await new Promise((r) => { stubServer.listen(STUB, r); });
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const O = await mkUser('outsider', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const tk = { A: await tokenOf(A.id), B: await tokenOf(B.id), M: await tokenOf(M.id), X: await tokenOf(X.id), O: await tokenOf(O.id) };

  // HISTORY TO LEARN FROM: 16 converted leads that were Hot, replied and met; 14 junk / lost leads that were Cold with no phone and silence.
  const now = new Date().toISOString();
  const ins = async (table, row) => { const cols = Object.keys(row); await DB.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c])); };
  for (let i = 0; i < 30; i += 1) {
    const good = i < 16;
    const lid = id('lead');
    // eslint-disable-next-line no-await-in-loop
    await ins('CrmLead', { id: lid, company: `ZZE Hist Lead ${i} ${RUN}`, contactName: good ? 'Person' : null, phone: good ? `90000${String(10000 + i)}` : null, email: good ? `h${i}.${RUN}@zzhist.test` : null, source: good ? 'Referral' : 'Import', rating: good ? 'Hot' : 'Cold', status: good ? 'Converted' : 'Junk', stage: good ? 'Won' : 'Lost', ownerId: A.id, ownerName: A.name, createdAt: now, updatedAt: now });
    for (let k = 0; k < (good ? 4 : 0); k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ins('CrmActivity', { id: id('act'), kind: k === 0 ? 'meeting' : 'call', subject: k === 1 ? 'Replied on WhatsApp' : 'Talked', note: k === 0 ? 'Meeting held' : 'ok', at: now, leadId: lid, byId: A.id, byName: A.name, createdAt: now });
    }
  }
  // 10 won deals (decision maker, proposal, many contacts logged), 8 lost (nothing)
  for (let i = 0; i < 18; i += 1) {
    const good = i < 10;
    const acc = id('acc'); const did = id('deal');
    // eslint-disable-next-line no-await-in-loop
    await ins('CrmAccount', { id: acc, name: `ZZE Hist Acc ${i} ${RUN}`, kind: good ? 'Client' : 'Prospect', ownerId: A.id, ownerName: A.name, createdAt: now, updatedAt: now });
    // eslint-disable-next-line no-await-in-loop
    if (good) await ins('CrmContact', { id: id('con'), accountId: acc, name: 'Boss', role: 'Decision maker', ownerId: A.id, createdAt: now, updatedAt: now });
    const when = new Date(Date.now() - (i % 6) * 30 * 86400000).toISOString();
    // eslint-disable-next-line no-await-in-loop
    await ins('CrmDeal', { id: did, title: `ZZE Hist Deal ${i} ${RUN}`, accountId: acc, stage: good ? 'Won' : 'Lost', value: 100000, probability: good ? 100 : 0, wonAt: good ? when : null, lostAt: good ? null : when, ownerId: A.id, ownerName: A.name, createdAt: new Date(Date.parse(when) - 20 * 86400000).toISOString(), updatedAt: now });
    // eslint-disable-next-line no-await-in-loop
    if (good) await ins('CrmProposal', { id: id('prop'), number: `ZZ-${i}`, dealId: did, accountId: acc, dataJson: '{}', status: 'Accepted', createdAt: now, updatedAt: now });
    for (let k = 0; k < (good ? 5 : 1); k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ins('CrmActivity', { id: id('act'), kind: k === 0 ? 'meeting' : 'call', subject: 'Talked', note: 'x', at: now, dealId: did, accountId: acc, byId: A.id, byName: A.name, createdAt: now });
    }
  }
  await saveIntegration('zoom', { 'Account ID': 'zacc', 'Client ID': 'zcid', 'Client secret': 'zsecret' });
  await saveIntegration('crm-calendar', { 'Google Client ID': 'gcid', 'Google Client secret': 'gsecret', 'Microsoft Client ID': 'mcid', 'Microsoft Client secret': 'msecret' });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [{ userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own }, { userId: M.id, name: M.name, role: 'manager' }] }, tk.X);
  check('setup: two Salespeople and a Sales manager on the CRM list', put.status === 200, put.body);
  await new Promise((r) => { setTimeout(r, 400); });

  console.log('Access and the switches');
  check('a BDE who is not on the CRM list cannot reach any new path', (await call('GET', '/crm/pluse/ai/forecast', null, tk.O)).status === 403 && (await call('GET', '/crm/pluse/visits', null, tk.O)).status === 403 && (await call('GET', '/crm/pluse/plus-settings', null, tk.O)).status === 403);
  check('no login = 401', (await call('GET', '/crm/pluse/ai/model')).status === 401);
  const ps = await call('GET', '/crm/pluse/plus-settings', null, tk.A);
  check('everything automatic starts OFF (calendar sync, call auto-link, unusual-change alert); the offline copy is on', ps.status === 200 && ps.body.settings.calendarSync === false && ps.body.settings.autoLinkCalls === false && ps.body.settings.anomalyAlerts === false && ps.body.settings.offlineCopy === true, ps.body);
  check('a Salesperson and a Sales manager cannot change the switches, an Admin can', (await call('PUT', '/crm/pluse/plus-settings', { calendarSync: true }, tk.A)).status === 403 && (await call('PUT', '/crm/pluse/plus-settings', { calendarSync: true }, tk.M)).status === 403);

  const lead = (await call('POST', '/crm/leads', { company: `ZZE Open Hot ${RUN}`, contactName: 'Asha Rao', phone: '9876501234', email: `asha.${RUN}@zzopen.test`, source: 'Referral', rating: 'Hot', force: true }, tk.A)).body.lead;
  const coldLead = (await call('POST', '/crm/leads', { company: `ZZE Open Cold ${RUN}`, source: 'Import', rating: 'Cold', force: true }, tk.A)).body.lead;
  const leadB = (await call('POST', '/crm/leads', { company: `ZZE B Lead ${RUN}`, phone: '9876509999', force: true }, tk.B)).body.lead;
  check('setup: leads for A and B', lead && coldLead && leadB);
  await call('POST', '/crm/activities', { kind: 'whatsapp', subject: 'Replied on WhatsApp', note: 'Yes interested, send the proposal', leadId: lead.id }, tk.A);
  await call('POST', '/crm/activities', { kind: 'meeting', subject: 'Intro meeting', note: 'Meeting held, they agreed to a pilot', leadId: lead.id }, tk.A);

  console.log('09.01 Predictive lead scoring (learned)');
  const pHot = await call('GET', `/crm/pluse/ai/predict/lead/${lead.id}`, null, tk.A);
  const pCold = await call('GET', `/crm/pluse/ai/predict/lead/${coldLead.id}`, null, tk.A);
  check('the model learned from the closed leads (ready, samples >= 30, an honest accuracy)', pHot.status === 200 && pHot.body.model.ready && pHot.body.model.samples >= 30 && pHot.body.model.accuracy >= 60, pHot.body && pHot.body.model);
  check('a Hot lead that replied and met scores far above a Cold silent one', pHot.body.probability > 60 && pCold.body.probability < 40 && pHot.body.probability > pCold.body.probability, [pHot.body.probability, pCold.body.probability]);
  check('the score comes with plain reasons (what raises it / what lowers it)', pHot.body.reasons.up.length > 0 && pCold.body.reasons.down.length > 0 && typeof pHot.body.reasons.up[0].why === 'string', pHot.body.reasons);
  check('B cannot read the score of A\'s lead', (await call('GET', `/crm/pluse/ai/predict/lead/${lead.id}`, null, tk.B)).status === 404);
  check('a Salesperson cannot make the AI learn again; a Sales manager can', (await call('POST', '/crm/pluse/ai/train', {}, tk.A)).status === 403 && (await call('POST', '/crm/pluse/ai/train', {}, tk.M)).status === 200);

  console.log('09.02 Deal win probability');
  const acc = (await call('POST', '/crm/accounts', { name: `ZZE Open Acc ${RUN}`, force: true }, tk.A)).body.account;
  await call('POST', '/crm/contacts', { accountId: acc.id, name: 'Decider', role: 'Decision maker', force: true }, tk.A);
  const deal = (await call('POST', '/crm/deals', { title: `ZZE Open Deal ${RUN}`, accountId: acc.id, value: 300000, expectedClose: ymd(10), force: true }, tk.A)).body.deal;
  const acc2 = (await call('POST', '/crm/accounts', { name: `ZZE Bare Acc ${RUN}`, force: true }, tk.A)).body.account;
  const bare = (await call('POST', '/crm/deals', { title: `ZZE Bare Deal ${RUN}`, accountId: acc2.id, value: 100000, force: true }, tk.A)).body.deal;
  for (let i = 0; i < 4; i += 1) await call('POST', '/crm/activities', { kind: 'call', subject: 'Spoke to HR', note: 'positive', dealId: deal.id }, tk.A); // eslint-disable-line no-await-in-loop
  await call('POST', '/crm/activities', { kind: 'meeting', subject: 'Met', note: 'good meeting', dealId: deal.id }, tk.A);
  const pd = await call('GET', `/crm/pluse/ai/predict/deal/${deal.id}`, null, tk.A);
  const pb = await call('GET', `/crm/pluse/ai/predict/deal/${bare.id}`, null, tk.A);
  check('a deal gets a learned win chance joined with its stage %', pd.status === 200 && pd.body.model.ready && pd.body.modelProbability != null && pd.body.stageProbability != null && pd.body.probability != null, pd.body);
  check('the worked deal with a decision maker beats the bare one', pd.body.probability > pb.body.probability, [pd.body, pb.body]);
  check('a deal\'s reasons are given', pd.body.reasons.up.length + pd.body.reasons.down.length > 0, pd.body.reasons);

  console.log('09.07 AI forecasting');
  const fc = await call('GET', '/crm/pluse/ai/forecast', null, tk.A);
  const m0 = fc.body && fc.body.months && fc.body.months[0];
  check('three months forecast, each with likely / low / high, the AI pipeline part and the stage-weighted number to compare', fc.status === 200 && fc.body.months.length === 3 && m0.forecast >= m0.low && m0.high >= m0.forecast && 'stageWeighted' in m0, fc.body && fc.body.months);
  check('the open deals are in it by their learned chance (the worked deal counts more than its value x 0)', fc.body.top.some((t) => t.id === deal.id && t.chance === pd.body.probability), fc.body.top);
  check('12 months of history, a trend and a plain-English story', fc.body.history.length === 12 && Array.isArray(fc.body.story) && /likely/.test(fc.body.story[0]), fc.body.story);
  const fcB = await call('GET', '/crm/pluse/ai/forecast', null, tk.B);
  check('B\'s forecast has only B\'s deals', fcB.status === 200 && !fcB.body.top.some((t) => t.id === deal.id), fcB.body.top);
  const fcAi = await call('GET', '/crm/pluse/ai/forecast?ai=1', null, tk.A);
  check('asking for the AI words with no AI set up still answers (the story stays, the reason is given)', fcAi.status === 200 && fcAi.body.story.length > 0 && (fcAi.body.aiText || fcAi.body.aiError), fcAi.body.aiError);

  console.log('09.10 Sentiment / intent');
  check('code reads tone: "not interested" is Negative (not Positive)', SIG.sentimentOf('Sorry, we are not interested right now').label === 'Negative' && SIG.sentimentOf('Sorry, we are not interested right now').intent === 'Not interested');
  check('price concern and meeting intent are found', SIG.sentimentOf('Your fee is too expensive, can you give a discount?').intent === 'Price concern' && SIG.sentimentOf('Great, call me tomorrow to schedule a meeting').intent === 'Wants a meeting');
  const sen = await call('GET', `/crm/pluse/ai/sentiment/lead/${lead.id}`, null, tk.A);
  check('a record shows its mood and each customer line with a label', sen.status === 200 && sen.body.mood.label === 'Positive' && sen.body.items.length >= 2 && sen.body.items.every((x) => x.sentiment && x.sentiment.label), sen.body);
  await call('POST', '/crm/activities', { kind: 'call', subject: 'Call outcome', note: 'They said it is too costly and not interested now', leadId: lead.id }, tk.A);
  const sen2 = await call('GET', `/crm/pluse/ai/sentiment/lead/${lead.id}`, null, tk.A);
  check('a new negative line turns the trend ("cooling down") and the latest intent', sen2.body.items[0].sentiment.label === 'Negative' && sen2.body.mood.trend === 'cooling down', sen2.body.mood);
  check('B cannot read A\'s lead sentiment', (await call('GET', `/crm/pluse/ai/sentiment/lead/${lead.id}`, null, tk.B)).status === 404);

  console.log('09.12 AI data entry / field extraction');
  const sig = `Hi,\nPlease share your recruitment rates for 5 Java developers. Budget around 3 lakh.\n\nRegards,\nPriya Menon\nTalent Acquisition Manager\nZzsoft Solutions Pvt Ltd\n+91 99887 76655 | priya.menon@zzsoft.co.in\nwww.zzsoft.co.in, Bengaluru`;
  const ex = await call('POST', '/crm/pluse/ai/extract', { text: sig }, tk.A);
  const L = ex.body && ex.body.lead;
  check('a pasted mail signature becomes lead fields (company, person, designation, phone, email, city)', ex.status === 200 && /Zzsoft Solutions/i.test(L.company) && L.contactName === 'Priya Menon' && /Manager/.test(L.designation) && L.phone === '9988776655' && L.email === 'priya.menon@zzsoft.co.in' && L.city === 'Bengaluru', L);
  check('...and the money and the website are read too', L.expectedValue === 300000 && /zzsoft\.co\.in/.test(L.notes || ''), L);
  const fill = await call('POST', `/crm/pluse/ai/fill/lead/${coldLead.id}`, { text: sig }, tk.A);
  check('for a lead already there only its EMPTY fields are suggested (the company stays)', fill.status === 200 && fill.body.suggest.phone === '9988776655' && !('company' in fill.body.suggest), fill.body);
  check('B cannot get suggestions for A\'s lead', (await call('POST', `/crm/pluse/ai/fill/lead/${coldLead.id}`, { text: sig }, tk.B)).status === 404);
  const dfill = await call('POST', `/crm/pluse/ai/fill/deal/${bare.id}`, { text: 'Next step: send the agreement. They will decide by 15/12/2030.' }, tk.A);
  check('a deal gets its next step and close date from a mail', dfill.status === 200 && /agreement/.test(dfill.body.suggest.nextStep || '') && dfill.body.suggest.expectedClose === '2030-12-15', dfill.body);
  check('an empty paste is refused', (await call('POST', '/crm/pluse/ai/extract', { text: '' }, tk.A)).status === 400);

  console.log('14.04 Business-card scanner');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]);
  const cardR = await call('POST', '/crm/pluse/ai/card', null, tk.A, jpg);
  check('a photo of a card is read (OCR) into lead fields', cardR.status === 200 && /Zzcardco Technologies/i.test(cardR.body.lead.company) && cardR.body.lead.contactName === 'Kiran Varma' && cardR.body.lead.phone === '9848022334' && cardR.body.lead.city === 'Hyderabad' && /visiting card/.test(cardR.body.lead.notes), cardR.body);
  check('a file that is not a JPG / PNG is refused with a plain reason', (await call('POST', '/crm/pluse/ai/card', null, tk.A, Buffer.alloc(400, 7))).status === 400);
  check('an outsider cannot use the card reader', (await call('POST', '/crm/pluse/ai/card', null, tk.O, jpg)).status === 403);

  console.log('09.13 Anomaly / trend detection');
  // 8 normal weeks of ~10 calls each for A, then last week nothing
  const monday = (() => { const d = new Date(`${ymd(0)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; })();
  for (let w = 2; w <= 9; w += 1) {
    for (let k = 0; k < 10; k += 1) {
      const at = new Date(monday.getTime() - w * 7 * 86400000 + 86400000 * 2 + k * 3600000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      await ins('CrmActivity', { id: id('act'), kind: 'call', subject: 'Weekly call', note: 'x', at, leadId: lead.id, byId: A.id, byName: A.name, createdAt: at });
    }
  }
  const an = await call('GET', '/crm/pluse/ai/anomalies', null, tk.M);
  check('the manager sees "calls ... fell" for last week, with the usual number', an.status === 200 && an.body.alerts.some((a) => a.metric === 'work' && a.direction === 'down' && a.usual >= 5), an.body.alerts);
  check('...and the per-salesperson drop names A', an.body.alerts.some((a) => a.metric === 'ownerWork' && a.text.includes(A.name)), an.body.alerts.map((a) => a.text));
  const anA = await call('GET', '/crm/pluse/ai/anomalies', null, tk.A);
  check('A sees only their own numbers (no per-person lines)', anA.status === 200 && anA.body.scope === 'mine' && !anA.body.alerts.some((a) => a.metric === 'ownerWork'), anA.body.alerts);
  check('the Monday alert to the managers does nothing while its switch is off', (await SIG.alertManagers()) === 0);

  console.log('09.05 Call summaries');
  const BC = require('../src/browsercall/schema');
  await BC.ensure();
  const bcid = id('bc');
  await BC.run('INSERT INTO "BrowserCall" ("id", "token", "candidateId", "userId", "userName", "toNumber", "extension", "status", "startAt", "talkSec", "summaryText", "recordingStatus", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', bcid, bcid, 'zz-cand', A.id, A.name, '+91 98765 01234', '9001', 'completed', now, 185, 'Asked for rates for 5 developers; wants a call on Monday.', 'done', now, now);
  const bcOther = id('bc');
  await BC.run('INSERT INTO "BrowserCall" ("id", "token", "candidateId", "userId", "userName", "toNumber", "extension", "status", "startAt", "talkSec", "summaryText", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', bcOther, bcOther, 'zz-cand', M.id, M.name, '9876501234', '9002', 'completed', now, 60, 'Manager call', now, now);
  const rc = await call('GET', `/crm/pluse/calls/lead/${lead.id}`, null, tk.A);
  check('a recorded browser call to the lead\'s number is listed on the lead with its summary', rc.status === 200 && rc.body.calls.some((c) => c.id === bcid && /rates/.test(c.summary) && c.onTimeline === false), rc.body);
  check('a Salesperson sees only their own recorded calls; the manager sees both', !rc.body.calls.some((c) => c.id === bcOther) && (await call('GET', `/crm/pluse/calls/lead/${lead.id}`, null, tk.M)).body.calls.length >= 2);
  const lk = await call('POST', `/crm/pluse/calls/${bcid}/link`, { kind: 'lead', id: lead.id }, tk.A);
  const lk2 = await call('POST', `/crm/pluse/calls/${bcid}/link`, { kind: 'lead', id: lead.id }, tk.A);
  const tl = await call('GET', `/crm/leads/${lead.id}`, null, tk.A);
  check('"Add to timeline" writes the call (3 min) with its summary, once', lk.status === 200 && lk2.body.already === true && tl.body.activities.filter((a) => /^Recorded call \(3 min\)/.test(a.subject || '')).length === 1, tl.body.activities.map((a) => a.subject));
  check('a call that is not to this record\'s numbers cannot be linked to it', (await call('POST', `/crm/pluse/calls/${bcid}/link`, { kind: 'lead', id: coldLead.id }, tk.A)).status === 404);
  const cs = await call('POST', `/crm/pluse/ai/call-summary/lead/${lead.id}`, { text: 'Spoke to Asha. They are interested in 5 Java developers. Price is a bit high for them. I will send the proposal tomorrow and call back next week.', save: true, durationSec: 240 }, tk.A);
  check('a salesperson\'s call notes become a summary, a next step and a date (code when no AI), saved as the call with its minutes', cs.status === 200 && cs.body.summary && cs.body.nextDate && cs.body.saved && cs.body.saved.activityId && cs.body.saved.taskId, cs.body);
  const actRow = await DB.one('SELECT "subject", "durationSec" FROM "CrmActivity" WHERE "id" = ?', cs.body.saved.activityId);
  check('...the timeline line says "Call summary (4 min)"', actRow && actRow.subject === 'Call summary (4 min)' && actRow.durationSec === 240, actRow);
  check('B cannot save a call summary on A\'s lead', (await call('POST', `/crm/pluse/ai/call-summary/lead/${lead.id}`, { text: 'Some long enough call notes here', save: true }, tk.B)).status === 404);
  check('recorded calls are not written by themselves while the switch is off', (await SIG.autoLinkCalls()) === 0);

  console.log('05.08 Recurring tasks');
  const t1 = await call('POST', '/crm/tasks', { title: 'Weekly check-in', dueDate: ymd(0), type: 'Call', repeat: 'weekly', repeatUntil: ymd(30), leadId: lead.id }, tk.A);
  check('a follow-up can repeat every week until a date', t1.status === 200 && t1.body.task.repeatRule === 'weekly' && t1.body.task.repeatUntil === ymd(30), t1.body);
  const d1 = await call('POST', `/crm/tasks/${t1.body.task.id}/done`, { outcome: 'Spoke' }, tk.A);
  check('done -> the next one is made by itself a week later', d1.status === 200 && d1.body.repeated && d1.body.repeated.dueDate === ymd(7) && d1.body.repeated.repeatRule === 'weekly', d1.body.repeated);
  const sk = await call('POST', `/crm/pluse/tasks/${d1.body.repeated.id}/skip`, {}, tk.A);
  check('"skip this one" closes it and makes the one after', sk.status === 200 && sk.body.next && sk.body.next.dueDate === ymd(14), sk.body);
  check('B cannot skip / change A\'s repeating follow-up', (await call('POST', `/crm/pluse/tasks/${sk.body.next.id}/skip`, {}, tk.B)).status === 404 && (await call('POST', `/crm/pluse/tasks/${sk.body.next.id}/repeat`, { repeat: null }, tk.B)).status === 404);
  const stopR = await call('POST', `/crm/pluse/tasks/${sk.body.next.id}/repeat`, { repeat: null }, tk.A);
  const d3 = await call('POST', `/crm/tasks/${sk.body.next.id}/done`, { outcome: 'Spoke' }, tk.A);
  check('"stop repeating" ends the series', stopR.status === 200 && !d3.body.repeated, d3.body);
  check('the series stops at its "until" date', WK.nextFrom('2026-01-31', 'monthly', '2026-01-01') === '2026-02-28' && WK.nextDate('2026-11-28', 'weekdays') === '2026-11-30' && WK.nextFrom('2026-01-01', 'daily', '2026-01-05') === '2026-01-05');
  check('a rule that does not exist is not stored', (await call('POST', '/crm/tasks', { title: 'x', dueDate: ymd(1), repeat: 'hourly', leadId: lead.id }, tk.A)).body.task.repeatRule == null);
  const late = await call('POST', '/crm/tasks', { title: 'Daily standup', dueDate: ymd(0), repeat: 'daily', leadId: lead.id }, tk.A);
  await DB.run('UPDATE "CrmTask" SET "dueDate" = ? WHERE "id" = ?', ymd(-5), late.body.task.id);
  const dl = await call('POST', `/crm/tasks/${late.body.task.id}/done`, {}, tk.A);
  check('a late daily one skips ahead to today, not five days of back-log', dl.body.repeated && dl.body.repeated.dueDate === ymd(0), dl.body.repeated);

  console.log('05.11 Video meeting integration');
  const mt = (await call('POST', '/crm/tasks', { title: 'Demo meeting', dueDate: ymd(2), dueTime: '15:00', type: 'Meeting', leadId: lead.id }, tk.A)).body.task;
  const vp = await call('GET', '/crm/pluse/video/providers', null, tk.A);
  check('the providers say what is ready (Zoom app saved; Meet / Teams need the person\'s calendar)', vp.status === 200 && vp.body.providers.find((p) => p.id === 'zoom').ready && !vp.body.providers.find((p) => p.id === 'meet').ready, vp.body.providers);
  const zv = await call('POST', `/crm/pluse/tasks/${mt.id}/video`, { provider: 'zoom' }, tk.A);
  check('"Create video meeting" with Zoom makes a real Zoom meeting (stand-in) and keeps its link on the follow-up', zv.status === 200 && /^https:\/\/zoom\.us\/j\//.test(zv.body.url) && stub.zoom === 1, zv.body);
  const zv2 = await call('POST', `/crm/pluse/tasks/${mt.id}/video`, { provider: 'zoom' }, tk.A);
  check('pressing it again gives the same link (no second meeting)', zv2.body.already === true && stub.zoom === 1);
  const tasksNow = await call('GET', '/crm/tasks?when=upcoming&all=1', null, tk.A);
  check('the follow-up list carries the meeting link', tasksNow.body.tasks.some((t) => t.id === mt.id && t.meetingUrl === zv.body.url && t.meetingProvider === 'Zoom'));
  const mt2 = (await call('POST', '/crm/tasks', { title: 'Teams call', dueDate: ymd(3), dueTime: '11:30', type: 'Meeting', leadId: lead.id }, tk.A)).body.task;
  const tv = await call('POST', `/crm/pluse/tasks/${mt2.id}/video`, { provider: 'teams' }, tk.A);
  check('Teams without a joined calendar or company account says what to do (nothing made)', tv.status === 409 && /Join your Microsoft/i.test(tv.body.error), tv.body);
  check('B cannot make a meeting on A\'s follow-up', (await call('POST', `/crm/pluse/tasks/${mt2.id}/video`, { provider: 'zoom' }, tk.B)).status === 404);

  console.log('05.04 Two-way calendar sync (Google / Microsoft)');
  const cs0 = await call('GET', '/crm/pluse/calendar/connect/google', null, tk.A);
  check('while calendar sync is off, joining a calendar is refused with the reason', cs0.status === 409 && /off/i.test(cs0.body.error), cs0.body);
  check('an Admin turns calendar sync on', (await call('PUT', '/crm/pluse/plus-settings', { calendarSync: true }, tk.X)).status === 200);
  const stx = await call('GET', '/crm/pluse/calendar/status', null, tk.X);
  check('the Admin sees the redirect address to register with Google / Microsoft', stx.body.redirect && /\/api\/crm\/pluse\/calendar\/callback\/google$/.test(stx.body.redirect.google) && stx.body.providers.google.configured, stx.body);
  const cu = await call('GET', '/crm/pluse/calendar/connect/google', null, tk.A);
  const authUrl = new URL(cu.body.url);
  check('"Join Google Calendar" opens Google\'s own consent page (calendar.events, offline, a signed state)', cu.status === 200 && authUrl.origin === SB && /calendar\.events/.test(authUrl.searchParams.get('scope')) && authUrl.searchParams.get('access_type') === 'offline' && authUrl.searchParams.get('state'), cu.body);
  const bad = await call('GET', `/crm/pluse/calendar/callback/google?code=good-code&state=${encodeURIComponent('forged.state')}`);
  check('a forged state is refused (nothing joined)', bad.status === 302 && /calendar=failed/.test(bad.location), bad.location);
  // a follow-up with a time and one without, before joining
  const ft = (await call('POST', '/crm/tasks', { title: 'Call the CFO', dueDate: ymd(1), dueTime: '10:00', leadId: lead.id }, tk.A)).body.task;
  const cb = await call('GET', `/crm/pluse/calendar/callback/google?code=good-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`);
  check('Google sends the person back: joined, tokens kept encrypted', cb.status === 302 && /calendar=connected/.test(cb.location), cb.location);
  const linkRow = await DB.one('SELECT * FROM "CrmCalendarLink" WHERE "userId" = ? AND "provider" = \'google\'', A.id);
  check('the token is stored encrypted, with the account\'s email', linkRow && /^enc:v1:/.test(linkRow.accessEnc) && linkRow.email === 'zz.rep@gmail.test', linkRow && linkRow.email);
  // an event of their own with a lead as attendee
  stub.events.set('own1', { id: 'own1', status: 'confirmed', summary: 'Lunch with Asha', start: { dateTime: `${ymd(1)}T13:00:00+05:30` }, end: { dateTime: `${ymd(1)}T14:00:00+05:30` }, attendees: [{ email: `asha.${RUN}@zzopen.test` }] });
  const sy = await call('POST', '/crm/pluse/calendar/sync', {}, tk.A);
  const outRows = await DB.all('SELECT "eventId" FROM "CrmCalendarEvent" WHERE "userId" = ? AND "provider" = \'google\' AND "direction" = \'out\' AND "deleted" = 0', A.id);
  check('Sync now (after the sync made at joining): the open follow-ups are on Google once each, their own event is read', sy.status === 200 && outRows.length >= 2 && new Set(outRows.map((r) => r.eventId)).size === outRows.length && outRows.every((r) => stub.events.has(r.eventId)) && sy.body.result.google.busy >= 1, [sy.body, outRows.length]);
  const mapped = await DB.one('SELECT * FROM "CrmCalendarEvent" WHERE "taskId" = ? AND "direction" = \'out\'', ft.id);
  const gev = mapped && stub.events.get(mapped.eventId);
  check('the 10:00 follow-up is a 10:00 India-time event (30 minutes), nobody invited', gev && gev.start.dateTime === `${ymd(1)}T10:00:00+05:30` && /T10:30:00\+05:30$/.test(gev.end.dateTime) && !gev.attendees, gev);
  // moved in Google -> moves in the CRM
  stub.events.set(gev.id, { ...gev, start: { dateTime: `${ymd(2)}T16:30:00+05:30` }, end: { dateTime: `${ymd(2)}T17:00:00+05:30` } });
  await call('POST', '/crm/pluse/calendar/sync', {}, tk.A);
  const moved = await DB.one('SELECT "dueDate", "dueTime" FROM "CrmTask" WHERE "id" = ?', ft.id);
  check('moved in Google Calendar -> the CRM follow-up moves (two-way)', moved.dueDate === ymd(2) && moved.dueTime === '16:30', moved);
  // moved in the CRM -> moves in Google
  await call('POST', `/crm/tasks/${ft.id}/snooze`, { dueDate: ymd(4), dueTime: '09:15' }, tk.A);
  const s2 = await call('POST', '/crm/pluse/calendar/sync', {}, tk.A);
  check('moved in the CRM -> the Google event moves', s2.body.result.google.updated >= 1 && stub.events.get(gev.id).start.dateTime === `${ymd(4)}T09:15:00+05:30`, stub.events.get(gev.id).start);
  // done in the CRM -> off the calendar
  await call('POST', `/crm/tasks/${ft.id}/done`, { outcome: 'Spoke' }, tk.A);
  const s3 = await call('POST', '/crm/pluse/calendar/sync', {}, tk.A);
  check('done in the CRM -> taken off the calendar', s3.body.result.google.removed >= 1 && !stub.events.has(gev.id), s3.body);
  const busy = await call('GET', `/crm/pluse/calendar/busy?from=${ymd(0)}&to=${ymd(7)}`, null, tk.A);
  check('their own calendar event shows as busy in the CRM, joined to the lead by the attendee\'s email', busy.status === 200 && busy.body.events.some((e) => e.title === 'Lunch with Asha' && e.leadId === lead.id), busy.body.events);
  check('B sees nothing of A\'s calendar', (await call('GET', `/crm/pluse/calendar/busy?from=${ymd(0)}&to=${ymd(7)}`, null, tk.B)).body.events.length === 0);
  // Meet through the joined Google calendar
  const mv = await call('POST', `/crm/pluse/tasks/${mt2.id}/video`, { provider: 'meet' }, tk.A);
  check('05.11: with Google joined, "Google Meet" makes a Meet link on the person\'s own calendar', mv.status === 200 && /^https:\/\/meet\.google\.com\//.test(mv.body.url), mv.body);
  // Microsoft too
  const mu = await call('GET', '/crm/pluse/calendar/connect/microsoft', null, tk.B);
  const mstate = new URL(mu.body.url).searchParams.get('state');
  const mcb = await call('GET', `/crm/pluse/calendar/callback/microsoft?code=x&state=${encodeURIComponent(mstate)}`);
  check('Microsoft: the consent page, then joined with the mailbox address', mu.status === 200 && /Calendars\.ReadWrite/.test(new URL(mu.body.url).searchParams.get('scope')) && /calendar=connected/.test(mcb.location), mcb.location);
  await call('POST', '/crm/tasks', { title: 'B call', dueDate: ymd(1), dueTime: '12:00', leadId: leadB.id }, tk.B);
  const msy = await call('POST', '/crm/pluse/calendar/sync', {}, tk.B);
  check('B\'s follow-up goes to the Outlook calendar in India Standard Time', msy.status === 200 && [...stub.ms.values()].some((e) => e.start && e.start.dateTime === `${ymd(1)}T12:00:00` && e.start.timeZone === 'India Standard Time'), [...stub.ms.values()].map((e) => e.start));
  const disc = await call('DELETE', '/crm/pluse/calendar/microsoft', null, tk.B);
  check('disconnecting removes the link', disc.status === 200 && !(await DB.one('SELECT "id" FROM "CrmCalendarLink" WHERE "userId" = ? AND "provider" = \'microsoft\'', B.id)));

  console.log('05.12 Field visit / check-in with location');
  const ci = await call('POST', '/crm/pluse/visits/check-in', { kind: 'lead', id: lead.id, lat: 17.4486, lng: 78.3908, accuracy: 25 }, tk.A);
  check('check in at a lead with the location', ci.status === 200 && ci.body.visit.inLat === 17.4486 && /maps\.google\.com\/\?q=17\.4486,78\.3908/.test(ci.body.visit.inMap), ci.body);
  check('a second check-in while one is open is refused', (await call('POST', '/crm/pluse/visits/check-in', { kind: 'lead', id: coldLead.id }, tk.A)).status === 409);
  check('B cannot check in at A\'s lead', (await call('POST', '/crm/pluse/visits/check-in', { kind: 'lead', id: lead.id }, tk.B)).status === 404);
  check('B cannot check out A\'s visit', (await call('POST', `/crm/pluse/visits/${ci.body.visit.id}/check-out`, {}, tk.B)).status === 404);
  await DB.run('UPDATE "CrmVisit" SET "inAt" = ? WHERE "id" = ?', new Date(Date.now() - 42 * 60000).toISOString(), ci.body.visit.id);
  const co = await call('POST', `/crm/pluse/visits/${ci.body.visit.id}/check-out`, { lat: 17.4490, lng: 78.3911, outcome: 'Meeting held', note: 'Met the HR head, wants rates' }, tk.A);
  check('check out: minutes spent, outcome and note', co.status === 200 && co.body.visit.minutes >= 41 && co.body.visit.outcome === 'Meeting held', co.body);
  const vt = (await call('GET', `/crm/leads/${lead.id}`, null, tk.A)).body.activities.find((a) => /^Field visit at /.test(a.subject || ''));
  check('the timeline has one Visit line with the time spent and both map links', vt && /Visit of 4\d min/.test(vt.note) && /Checked in: https:\/\/maps/.test(vt.note) && /Checked out: https:\/\/maps/.test(vt.note), vt);
  const vm = await call('GET', '/crm/pluse/visits', null, tk.M);
  const va = await call('GET', '/crm/pluse/visits', null, tk.B);
  check('the manager sees today\'s visits of the team; B sees none of A\'s', vm.body.visits.some((v) => v.id === ci.body.visit.id) && !va.body.visits.some((v) => v.id === ci.body.visit.id));
  await call('PUT', '/crm/pluse/plus-settings', { visitNeedsLocation: true }, tk.X);
  await new Promise((r) => { setTimeout(r, 200); });
  check('when the Admin asks for the location, a check-in without it is refused', (await call('POST', '/crm/pluse/visits/check-in', { kind: 'lead', id: coldLead.id }, tk.A)).status === 400);

  console.log('14.05 Mobile call logging');
  const pc = await call('POST', '/crm/pluse/phone-call', { kind: 'lead', id: coldLead.id, outcome: 'No answer', durationSec: 14 }, tk.A);
  check('a call from the phone is logged with its measured length and the outcome', pc.status === 200 && pc.body.activity.subject === 'Call from the phone: No answer (14 sec)' && pc.body.durationSec === 14, pc.body);
  const pc2 = await call('POST', '/crm/pluse/phone-call', { kind: 'lead', id: coldLead.id, outcome: 'Spoke', durationSec: 330, note: 'Wants a call next week', followUp: { dueDate: ymd(7) } }, tk.A);
  const coldNow = (await call('GET', `/crm/leads/${coldLead.id}`, null, tk.A)).body.lead;
  check('a 5-minute "Spoke" call moves a New lead to Contacted and sets the next follow-up', pc2.body.activity.subject === 'Call from the phone: Spoke (6 min)' && pc2.body.task && coldNow.status !== 'New', [pc2.body.activity.subject, coldNow.status]);
  check('B cannot log a call on A\'s lead', (await call('POST', '/crm/pluse/phone-call', { kind: 'lead', id: coldLead.id, outcome: 'Spoke' }, tk.B)).status === 404);

  console.log('14.01 / 14.03 Mobile app and offline (the server side)');
  const mani = JSON.parse(fs.readFileSync(path.join(BACK, '..', 'frontend', 'public', 'tl-app.webmanifest'), 'utf8'));
  check('the installable app has CRM shortcuts (Follow-ups, new lead)', mani.shortcuts.some((s) => /\/crm\/followups/.test(s.url)) && mani.shortcuts.some((s) => /\/crm\/leads/.test(s.url)), mani.shortcuts);
  const sw = fs.readFileSync(path.join(BACK, '..', 'frontend', 'public', 'tl-app-sw.js'), 'utf8');
  check('the app worker keeps the CRM screen for no-signal use, network first (never an old screen when online)', /tl-app-crm-shell/.test(sw) && /\/crm/.test(sw) && /fetch\(req\)/.test(sw));
  check('the offline copy switch can be turned off by an Admin', (await call('PUT', '/crm/pluse/plus-settings', { offlineCopy: false }, tk.X)).body.settings.offlineCopy === false);

  console.log('09.14 AI voice calling agent (needs the service switched on)');
  const ap = await call('GET', '/crm/autopilot', null, tk.M);
  check('the CRM side of the AI call is there (autopilot step "AI call"), off by default', ap.status === 200 && ap.body.settings && ap.body.settings.on === false && ap.body.settings.steps.some((s) => s.channel === 'call'), ap.body && ap.body.settings && ap.body.settings.steps);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.stack); await stop(1); });
