#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SMS TEMPLATES BOTH WAYS WITH OMNI-CHANNEL (utils/smsOmniSync.js). Runs on a COPY of the database (VACUUM INTO a temp file; the real
// one is only read). Green Start is a small local stub on 127.0.0.1 answering in its own shapes ({success, data}, the template wire form
// with dltTemplateId / senderId). Neither Green Start nor the SMS provider is ever called.
//   cd backend && node scripts/sms-omni-templates-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PrismaClient } = require('@prisma/client');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stubModule = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };

// ---- the Omni-Channel stub: two workspaces, SMS templates in its wire form ----
const WS = [{ id: 'ws-main', name: 'Teamlink Medical' }, { id: 'ws-edu', name: 'Teamlink Education' }];
const TPL = {
  'ws-main': [
    { id: 'g1', name: 'ZZTEST SMSOMNI interview', channel: 'sms', status: 'approved', language: 'en', body: 'Dear {#var#}, your interview is at {#var#}. TeamLink', dltTemplateId: '1707990000000000001', senderId: 'TMLINK' },
    { id: 'g2', name: 'ZZTEST SMSOMNI waiting for DLT', channel: 'sms', status: 'pending', language: 'en', body: 'No id yet {#var#}' },
    { id: 'g3', name: 'ZZTEST SMSOMNI same id as TeamLink', channel: 'sms', status: 'approved', language: 'en', body: 'Omni wording', dltTemplateId: '1707990000000000099' },
    { id: 'g4', name: 'ZZTEST SMSOMNI whatsapp', channel: 'whatsapp', status: 'approved', body: 'not sms', dltTemplateId: '1707990000000000555' },
  ],
  'ws-edu': [],
};
const POSTS = [];
let DOWN = false;
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (DOWN) return json({ success: false, error: { message: 'down' } }, 503);
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/api/v1/auth/teamlink') return json({ success: true, data: { accessToken: 'zz-gs-token' } });
    if (req.headers.authorization !== 'Bearer zz-gs-token') return json({ success: false, error: { message: 'no token' } }, 401);
    if (req.method === 'GET' && u.pathname === '/api/v1/workspaces') return json({ success: true, data: WS });
    const ws = req.headers['x-workspace-id'];
    if (req.method === 'GET' && u.pathname === '/api/v1/templates') {
      const items = (TPL[ws] || []).filter((t) => t.channel === u.searchParams.get('channel'));
      return json({ success: true, data: { items, total: items.length, page: 1, pageSize: 100 } });
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/templates') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      POSTS.push({ ws, body });
      if ((TPL[ws] || []).some((t) => t.name === body.name)) return json({ success: false, error: { message: 'A template with this name already exists' } }, 409);
      (TPL[ws] = TPL[ws] || []).push({ id: `n${POSTS.length}`, status: 'approved', ...body });
      return json({ success: true, data: { id: `n${POSTS.length}` } }, 201);
    }
    return json({ success: false, error: { message: `stub: ${req.method} ${u.pathname}` } }, 404);
  });
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-smsomni-'));
  const copy = path.join(tmp, 'copy.db').replace(/\\/g, '/');
  const real = new PrismaClient();
  await real.$executeRawUnsafe(`VACUUM INTO '${copy}'`);
  await real.$disconnect();
  process.env.DATABASE_URL = `file:${copy}`;
  process.env.GREENSTART_ENABLED = 'true';
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.GREENSTART_API_PORT = String(stub.address().port);
  stubModule('../src/utils/greenStartSso', { secretSet: () => true, ssoEmail: async () => 'company@example.test', EMAIL_RE: /@/, greenStartTicket: () => 'zz-ticket' });
  stubModule('../src/utils/sandbox', { isSandbox: () => true });
  const prisma = require('../src/db');
  const S = require('../src/utils/smsOmniSync');
  const mine = [];
  try {
    // TeamLink's own SMS templates: one with a DLT id (goes to Omni-Channel), one whose id Omni-Channel also has, one without an id
    const mk = (data) => prisma.messageTemplate.create({ data: { purpose: 'CUSTOM_ZZTEST_SMSOMNI', purposeLabel: 'ZZTEST SMSOMNI', audience: 'candidate', channel: 'SMS', language: 'English', isDefault: false, builtIn: false, version: 1, ...data } });
    mine.push(await mk({ name: 'ZZTEST SMSOMNI offer', body: 'Hi {#var#}, your offer letter is ready. TeamLink', dltTemplateId: '1707990000000000010', senderId: 'TMLINK' }));
    mine.push(await mk({ name: 'ZZTEST SMSOMNI own', body: 'TeamLink wording', dltTemplateId: '1707990000000000099' }));
    mine.push(await mk({ name: 'ZZTEST SMSOMNI no id', body: 'No DLT id here' }));

    let r = await S.pull({ why: 'test' });
    ok('the run finished and says what it did', r.ok === true && /SMS template/.test(r.words), r.words);
    const fromOmni = await prisma.messageTemplate.findMany({ where: { purpose: S.OMNI_PURPOSE, dltTemplateId: { startsWith: '1707990000' } } });
    ok('an Omni-Channel SMS template with a DLT id came into TeamLink (one row)', fromOmni.length === 1 && fromOmni[0].dltTemplateId === '1707990000000000001' && fromOmni[0].senderId === 'TMLINK');
    ok('...as a Message template, channel SMS, active, not the default of any automatic message', fromOmni[0].channel === 'SMS' && fromOmni[0].active && !fromOmni[0].isDefault && fromOmni[0].purposeLabel === 'From Omni-Channel');
    ok('a template waiting for DLT (no id) and a WhatsApp one were not taken in', !(await prisma.messageTemplate.findFirst({ where: { name: { in: ['ZZTEST SMSOMNI waiting for DLT', 'ZZTEST SMSOMNI whatsapp'] } } })));
    const own = await prisma.messageTemplate.findUnique({ where: { id: mine[1].id } });
    ok('the same DLT id made in TeamLink is never overwritten', own.body === 'TeamLink wording' && r.alreadyHere >= 1);
    const sentMain = POSTS.filter((p) => p.ws === 'ws-main').map((p) => p.body.dltTemplateId);
    const sentEdu = POSTS.filter((p) => p.ws === 'ws-edu').map((p) => p.body.dltTemplateId);
    ok('TeamLink templates went to Omni-Channel: to the workspace that lacked them only', sentMain.includes('1707990000000000010') && !sentMain.includes('1707990000000000099'), sentMain.join(','));
    ok('...and to every other workspace (both with an id; none without)', sentEdu.includes('1707990000000000010') && sentEdu.includes('1707990000000000099') && POSTS.every((p) => p.body.dltTemplateId), sentEdu.join(','));
    const b = POSTS.find((p) => p.body.dltTemplateId === '1707990000000000010').body;
    ok('...in Omni-Channel\'s SMS shape (channel sms, language, variables counted, sender kept)', b.channel === 'sms' && b.language === 'en' && b.variables === 1 && b.senderId === 'TMLINK' && b.name === 'ZZTEST SMSOMNI offer');
    ok('the one that came from Omni-Channel was not sent back', !POSTS.some((p) => p.body.dltTemplateId === '1707990000000000001'));

    const before = POSTS.length;
    r = await S.pull({ why: 'test again' });
    ok('a second run adds nothing twice (no duplicates either side)', POSTS.length === before && r.added === 0 && (await prisma.messageTemplate.count({ where: { dltTemplateId: '1707990000000000001' } })) === 1, r.words);

    TPL['ws-main'][0].body = 'Dear {#var#}, your interview is now at {#var#}. TeamLink';
    r = await S.pull({ why: 'changed in omni' });
    const changed = await prisma.messageTemplate.findFirst({ where: { dltTemplateId: '1707990000000000001' }, include: { versions: true } });
    ok('wording changed in Omni-Channel is copied, with a new version kept', changed.body.includes('is now at') && changed.version === 2 && changed.versions.length === 2 && r.updated === 1);

    await prisma.messageTemplate.delete({ where: { id: changed.id } });
    await S.forget(changed.dltTemplateId);
    r = await S.pull({ why: 'after delete' });
    ok('an Omni-Channel template an Admin deleted here does not come back', !(await prisma.messageTemplate.findFirst({ where: { dltTemplateId: '1707990000000000001' } })) && r.removedHere === 1);

    DOWN = true;
    r = await S.pull({ why: 'omni down' });
    ok('Omni-Channel not answering: a plain reason, nothing thrown', r.ok === false && r.words.length > 0, r.words);
    DOWN = false;
    const last = await S.lastPull();
    ok('the last run is kept for the screen', last && last.why === 'omni down');
  } finally {
    await prisma.$disconnect().catch(() => {});
    stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
