#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RCS MESSAGING (rcssms.in) — service, queue, webhook and screens API. SANDBOX ONLY. rcssms.in is NEVER called: the provider is a small
// local stub server on 127.0.0.1 that answers in the documented shapes. This proves TeamLink's own code (request shape, chunks, error
// codes, token mode, queue pause / retry, webhook, logs, permissions, proof lock, SMS fallback). It proves NOTHING about the real account:
// that needs the founder's single real test send.
//
// The sandbox API must be started WITH the stub's address (the server reads RCS_* from its environment):
//   cd backend
//   RCS_BASE_URL=http://127.0.0.1:47311 TEST_MOCK_PORTS=47311 RCS_USERNAME=zzrcsuser RCS_PASSWORD=zz-rcs-pass-7 RCS_ID=230 \
//   RCS_SEND_APITYPE=1 RCS_PERSONAL_APITYPE=2 RCS_WEBHOOK_SECRET=zz-hook-secret RCS_CHUNK_DELAY_MS=0 RCS_RETRY_DELAY_MS=300 \
//   npm run sandbox -- --restart --detach --no-watch
//   TL_API=http://localhost:4011 node scripts/rcs-messaging-test.js
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');
const Z = require('./lib/zzfix')('RCS');

const PORT = Number(process.env.RCS_TEST_STUB_PORT) || 47311;
const USER = 'zzrcsuser'; const PASS = 'zz-rcs-pass-7'; const SECRET = 'zz-client-secret-3'; const HOOK = 'zz-hook-secret';
const GOT = [];
let MODE = 'ok'; // ok | noid | err:<code> | 503 | err30once | tokenless
let TOKENS = 0; let ERR30 = 0;
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    GOT.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/api/rcs/accesstoken')) { TOKENS += 1; return json({ access_token: `zz-token-${TOKENS}`, expires_in: 86400 }); }
    if (req.url.startsWith('/rcsapi/rcscreatetemplate.jsp')) return json({ status: 'PENDING', template_type: body && body.rcstype, templateid: `ZZTPL${GOT.length}`, type: 'template_approval' });
    if (MODE === '503') return json({ message: 'busy' }, 503);
    if (MODE.startsWith('err:')) return json({ error: { errorcode: MODE.slice(4), errordesc: `zz error with ${USER} ${PASS}` } });
    if (MODE === 'err30once' && ERR30 === 0) { ERR30 += 1; return json({ error: { errorcode: '30', errordesc: 'token expired' } }); }
    if (MODE === 'noid') return json({ status: 'ok' });
    const list = body && Array.isArray(body.messages) ? body.messages.map((m) => m.msisdn) : String((body && body.msisdn) || '').split(',').filter(Boolean);
    return json({ data: list.map((n, i) => ({ msgid: `ZZM${GOT.length}x${i}`, msisdn: `+${n}` })) });
  });
});
const last = () => GOT[GOT.length - 1];
const sendsOf = (from) => GOT.slice(from).filter((g) => /jsonapi\.jsp/.test(g.url));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 200)); } };

(async () => {
  const { prisma } = Z;
  const START = new Date();
  await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${PORT}`;
  // nothing in THIS process may reach anything but the stub and the sandbox API
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => { const h = new URL(String(u)).hostname; if (!['127.0.0.1', 'localhost'].includes(h)) throw new Error(`blocked ${h}`); return realFetch(u, o); };
  const RCS_SETTING_KEYS = ['rcs.settings', 'rcs.queue.paused', 'rcs.proven', 'rcs.accepted', 'rcs.webhook.raw', 'rcs.webhook.rejected'];
  const savedSettings = await prisma.appSetting.findMany({ where: { key: { in: RCS_SETTING_KEYS } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: RCS_SETTING_KEYS } } });
  const made = { tplIds: [], batchRefs: [] };
  try {
    await Z.preclean();
    // ======================= A. the service, in this process, against the stub =======================
    Object.assign(process.env, { RCS_BASE_URL: BASE, RCS_USERNAME: USER, RCS_PASSWORD: PASS, RCS_ID: '230', RCS_AUTH_MODE: 'password', RCS_CLIENT_SECRET: '', RCS_SEND_APITYPE: '', RCS_PERSONAL_APITYPE: '', RCS_CHUNK_DELAY_MS: '0' });
    const S = require(path.join(Z.BACK, 'src/utils/rcsService'));
    const n = S.cleanNumbers(['9876543210', '+91 98765 43210', '12345', '09876543211', '919876543212', '5876543210', '']);
    Z.check('A1 numbers: digits only, 10 digits get 91, a leading 0 goes, duplicates and invalid ones are left out', n.valid.join(',') === '919876543210,919876543211,919876543212' && n.duplicate.length === 1 && n.invalid.length === 2, n);

    let g0 = GOT.length;
    let r = await S.sendChunk({ rcstype: 'BASIC', templateid: '22SVkoeCBF', numbers: ['919876543210'], variables: { var1: 'Ravi' } });
    Z.check('A2 apitype not set: refused, NOTHING sent (the 1 / 2 mismatch must be confirmed first)', !r.ok && r.errorCode === 'APITYPE' && GOT.length === g0, r);

    process.env.RCS_SEND_APITYPE = '1'; process.env.RCS_PERSONAL_APITYPE = '2';
    g0 = GOT.length;
    r = await S.sendChunk({ rcstype: 'RICH', templateid: '22SVkoeCBF', numbers: ['919876543210', '919876543211'], variables: { var1: 'Ravi', var2: 'Nurse' }, buttonUrl: 'https://x.test/a', imageUrl: 'https://x.test/i.png' });
    const s1 = last();
    Z.check('A3 the send request is the documented one: POST /rcsapi/jsonapi.jsp?apitype=<setting>, username, password, rcstype, rcsid, msisdn "a,b", variables [{var1,var2}], templateid, button [{url}], cardMedia [{fileUrl}]',
      GOT.length === g0 + 1 && s1.method === 'POST' && s1.url === '/rcsapi/jsonapi.jsp?apitype=1' && s1.body.username === USER && s1.body.password === PASS && s1.body.rcstype === 'RICH' && s1.body.rcsid === '230'
      && s1.body.msisdn === '919876543210,919876543211' && JSON.stringify(s1.body.variables) === '[{"var1":"Ravi","var2":"Nurse"}]' && s1.body.templateid === '22SVkoeCBF'
      && JSON.stringify(s1.body.button) === '[{"url":"https://x.test/a"}]' && JSON.stringify(s1.body.cardMedia) === '[{"fileUrl":"https://x.test/i.png"}]', s1 && { url: s1.url, body: { ...s1.body, password: '(hidden)' } });
    Z.check('A4 the reply {data:[{msgid, msisdn:"+91..."}]} is read per number', r.ok && S.idsByNumber(['919876543210', '919876543211'], r.items).size === 2, r);

    const codes = {};
    for (const c of ['13', '10', '15', '21', '22', '23', '24', '18']) { MODE = `err:${c}`; codes[c] = await S.sendChunk({ rcstype: 'BASIC', templateid: 'T1', numbers: ['919876543210'], variables: {} }); } // eslint-disable-line no-await-in-loop
    MODE = 'ok';
    Z.check('A5 every documented error code -> not sent, its plain words; the login never appears in the error or the provider answer',
      Object.entries(codes).every(([c, x]) => !x.ok && x.errorCode === c && x.error === S.ERRORS[c] && !`${x.error}${x.said}`.includes(PASS) && !`${x.error}${x.said}`.includes(USER)), Object.fromEntries(Object.entries(codes).map(([c, x]) => [c, [x.errorCode, x.error, x.said]])));
    MODE = 'noid';
    r = await S.sendChunk({ rcstype: 'BASIC', templateid: 'T1', numbers: ['919876543210'], variables: {} });
    MODE = 'ok';
    Z.check('A6 an answer without a msgid is NOT sent (unknown)', !r.ok && r.unknown && r.errorCode === 'UNKNOWN', r);

    g0 = GOT.length;
    const many = Array.from({ length: 1203 }, (_, i) => `9${String(100000000 + i)}`);
    const big = await S.sendRcs({ rcstype: 'BASIC', templateid: 'T1', numbers: [...many, many[0]], variables: { var1: 'x' } });
    const sizes = sendsOf(g0).map((x) => x.body.msisdn.split(',').length);
    Z.check('A7 1203 numbers (+1 repeat) go as 3 requests of 500 / 500 / 203, the repeat once', sizes.join('/') === '500/500/203' && big.accepted.length === 1203 && big.duplicate.length === 1, { sizes, acc: big.accepted.length });

    g0 = GOT.length;
    const pr = await S.sendRcsPersonalized([{ msisdn: '9876543210', templateid: 'T2', variables: [{ var1: 'Ravi' }], buttonUrl: 'https://x.test/r' }, { msisdn: '9876543211', templateid: 'T2', variables: [{ var1: 'Sita' }] }, { msisdn: 'bad', templateid: 'T2' }]);
    const p1 = last();
    Z.check('A8 personalized: POST /rcsapimtpl/jsonapi.jsp?apitype=<setting>, {username, password, rcsid, messages:[{msisdn, templateid, variables, button}]}',
      p1.url === '/rcsapimtpl/jsonapi.jsp?apitype=2' && p1.body.rcsid === '230' && p1.body.password === PASS && p1.body.messages.length === 2 && p1.body.messages[0].msisdn === '919876543210'
      && JSON.stringify(p1.body.messages[0].variables) === '[{"var1":"Ravi"}]' && JSON.stringify(p1.body.messages[0].button) === '[{"url":"https://x.test/r"}]' && !p1.body.messages[1].button && pr.accepted.length === 2 && pr.invalid.length === 1, p1 && p1.body && p1.body.messages);

    // token mode
    Object.assign(process.env, { RCS_AUTH_MODE: 'token', RCS_CLIENT_SECRET: SECRET, RCS_TOKEN_METHOD: 'GET' });
    S.forgetToken(); g0 = GOT.length; TOKENS = 0; MODE = 'err30once'; ERR30 = 0;
    r = await S.sendChunk({ rcstype: 'BASIC', templateid: 'T1', numbers: ['919876543210'], variables: {} });
    const calls = GOT.slice(g0);
    const tok = calls.filter((x) => x.url.startsWith('/api/rcs/accesstoken'));
    const snd = calls.filter((x) => /jsonapi/.test(x.url));
    Z.check('A9 token mode: Basic base64(username:clientSecret) with the configured method; Bearer on the send, no password; error 30 -> one new token and one repeat',
      r.ok && tok.length === 2 && tok[0].method === 'GET' && tok[0].headers.authorization === `Basic ${Buffer.from(`${USER}:${SECRET}`).toString('base64')}`
      && snd.length === 2 && snd[0].headers.authorization === 'Bearer zz-token-1' && snd[1].headers.authorization === 'Bearer zz-token-2' && snd.every((x) => !('password' in x.body)), { r, tok: tok.map((x) => x.method), snd: snd.map((x) => x.headers.authorization) });
    g0 = GOT.length; MODE = 'ok';
    await S.sendChunk({ rcstype: 'BASIC', templateid: 'T1', numbers: ['919876543210'], variables: {} });
    Z.check('A10 the token is kept (no new token for the next send within 24 h)', GOT.slice(g0).filter((x) => x.url.startsWith('/api/rcs/accesstoken')).length === 0);
    Object.assign(process.env, { RCS_AUTH_MODE: 'password', RCS_CLIENT_SECRET: '', RCS_TOKEN_METHOD: '' });

    const ct = await S.createTemplate('RICH', { cname: 'ZZ Rich', description: 'Hi {#var1#}', media_url: 'https://x.test/a.png', mediaheight: 'medium', cardorientation: 'vertical', title: 'Hello', reply: [{ text: 'Yes' }], action: [{ type: 'plain_dial', text: 'Call us', phone: '+919876543210' }, { type: 'plain_open_url', text: 'Open', url: 'https://x.test' }] });
    const c1 = last();
    Z.check('A11 create RICH template: POST /rcsapi/rcscreatetemplate.jsp with rcstype, rcsid, cname, description, media_url, mediaheight, cardorientation, title, reply, action -> templateid + PENDING',
      ct.ok && ct.status === 'PENDING' && /^ZZTPL/.test(ct.templateid) && c1.url === '/rcsapi/rcscreatetemplate.jsp' && c1.body.rcstype === 'RICH' && c1.body.mediaheight === 'Medium' && c1.body.cardorientation === 'Vertical' && c1.body.action.length === 2 && c1.body.reply[0].text === 'Yes', { ct, body: c1 && { ...c1.body, password: '(hidden)' } });
    const bad = await S.createTemplate('RICH', { cname: 'ZZ', description: 'x', media_url: 'http://not-https' });
    Z.check('A12 a wrong template form is refused before any call', !bad.ok && bad.invalid);

    process.env.RCS_BASE_URL = 'https://web.rcssms.in';
    g0 = GOT.length;
    r = await S.sendChunk({ rcstype: 'BASIC', templateid: '22SVkoeCBF', numbers: ['919876543210'], variables: {} });
    Z.check('A13 TEST SANDBOX + the real address: refused, never sent, never "success"', !r.ok && r.errorCode === 'SANDBOX' && GOT.length === g0, r);
    process.env.RCS_BASE_URL = BASE;

    // ======================= B. the API on the sandbox server (started with the stub address) =======================
    const sup = await Z.mkUser('sup', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'Recruiter' });
    const sTok = await Z.mint(sup); const rTok = await Z.mint(rec);
    const st0 = await Z.call('GET', '/api/rcs/status', sTok);
    if (!st0.body || !st0.body.config || st0.body.config.host !== `127.0.0.1:${PORT}`) {
      Z.check('B0 the sandbox API runs with the stub address (start it as the header says)', false, st0.body && st0.body.config);
      throw new Error('sandbox not started with the RCS stub settings');
    }
    Z.check('B1 status (Admin): set up, both apitypes shown, no secret in the answer, many-at-once locked', st0.status === 200 && st0.body.config.configured && st0.body.config.sendApiType === '1' && st0.body.may.bulk === false && !JSON.stringify(st0.body).includes(PASS) && !JSON.stringify(st0.body).includes(HOOK), st0.body);
    const rs0 = await Z.call('GET', '/api/rcs/status', rTok);
    const rsend = await Z.call('POST', '/api/rcs/send', rTok, { audience: 'candidates', ids: ['x'], templateId: 'x' });
    Z.check('B2 a Recruiter not on the "who may send" list: no Send RCS, 403', rs0.body.may.send === false && rsend.status === 403, [rs0.body, rsend.status]);

    // templates
    const reg = await Z.call('POST', '/api/rcs/templates/register', sTok, { templateId: '22SVkoeCBF', name: 'ZZTEST RCS approved', rcstype: 'BASIC', status: 'APPROVED', varCount: 1, module: 'ATS', description: 'Hi {#var1#}, a new job for you', fallback: { text: 'Hi {var1}, a new job for you - TeamLink', dltTemplateId: '1107000000000000001' } });
    made.tplIds.push(reg.body && reg.body.id);
    const mk = await Z.call('POST', '/api/rcs/templates', sTok, { rcstype: 'BASIC', cname: 'ZZTEST RCS basic', description: 'Hello {#var1#}', module: 'HRMS' });
    made.tplIds.push(mk.body && mk.body.id);
    Z.check('B3 add an approved rcssms.in template by id; make a BASIC template on the provider -> saved PENDING with its templateid', reg.status === 201 && reg.body.status === 'APPROVED' && mk.status === 201 && mk.body.status === 'PENDING' && /^ZZTPL/.test(mk.body.templateId), [reg.body, mk.body]);
    const nope = await Z.call('POST', '/api/rcs/templates', rTok, { rcstype: 'BASIC', cname: 'x', description: 'y' });
    Z.check('B4 only an Admin makes templates', nope.status === 403);
    // webhook: template approval
    const wbad = await Z.call('POST', '/api/webhooks/rcs?token=wrong', null, { templateid: mk.body.templateId, status: 'APPROVED' });
    let t2 = await prisma.rcsTemplate.findUnique({ where: { id: mk.body.id } });
    Z.check('B5 webhook with a wrong token: 200, nothing changes', wbad.status === 200 && t2.status === 'PENDING', [wbad.status, wbad.body, t2.status]);
    const wok = await Z.call('POST', `/api/webhooks/rcs?token=${HOOK}`, null, { templateid: mk.body.templateId, status: 'APPROVED' });
    t2 = await prisma.rcsTemplate.findUnique({ where: { id: mk.body.id } });
    const raw = await Z.call('GET', '/api/rcs/webhook-raw', sTok);
    Z.check('B6 webhook approval {templateid, status} -> APPROVED; the raw payload is kept first (without the token)', wok.status === 200 && t2.status === 'APPROVED' && raw.body.length >= 1 && raw.body[0].body.includes(mk.body.templateId) && !JSON.stringify(raw.body).includes(HOOK), [wok.body, t2.status]);
    const lst = await Z.call('GET', '/api/rcs/templates?approved=1&module=ATS', sTok);
    Z.check('B7 the send screen gets APPROVED templates of the module (and the all-module ones)', lst.status === 200 && lst.body.some((x) => x.templateId === '22SVkoeCBF') && !lst.body.some((x) => x.module === 'HRMS'), lst.body.map((x) => [x.templateId, x.module, x.status]));

    // people
    const mkC = async (tag, phone, extra = {}) => { const c = await prisma.candidate.create({ data: { name: `ZZTEST RCS ${tag} ${Z.RUN}`, email: `zz-rcs-${tag}-${Z.RUN}@example.test`, phone, location: 'ZZ', ...extra } }); Z.made.cands.push(c.id); return c; };
    const cA = await mkC('Asha', '9811100001'); const cB = await mkC('Bala', '+91 98111 00002'); const cDup = await mkC('Dup', '09811100001');
    const cBad = await mkC('Bad', '12345'); const cNo = await mkC('Stop', '9811100005', { consentStatus: 'WITHDRAWN', doNotContact: true });
    const ids = [cA.id, cB.id, cDup.id, cBad.id, cNo.id];
    const ck = await Z.call('POST', '/api/rcs/check', sTok, { audience: 'candidates', ids, templateId: reg.body.id });
    Z.check('B8 check: 2 can get it; repeat number, invalid number, do-not-contact left out with a reason; numbers masked', ck.status === 200 && ck.body.canSend === 2 && ck.body.counts.duplicate === 1 && ck.body.counts.no_phone === 1 && ck.body.counts.no_consent === 1 && ck.body.bulkLocked === true && !JSON.stringify(ck.body).includes('9811100001'), ck.body);
    const locked = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids, templateId: reg.body.id, variables: { var1: 'Asha' } });
    Z.check('B9 many at once BEFORE a real single test send: refused, nothing queued', locked.status === 409 && locked.body.bulkLocked && (await prisma.rcsMessageLog.count({ where: { templateId: '22SVkoeCBF', module: 'ATS' } })) === 0, locked.body);
    const one = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids: [cA.id], templateId: reg.body.id, variables: { var1: 'Asha' } });
    if (one.body && one.body.batchId) made.batchRefs.push(one.body.batchId);
    const oneDone = one.body && one.body.batchId && await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${one.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; });
    Z.check('B10 ONE person may be sent before the proof; the queue sends it, the log row has the msgid', one.status === 202 && oneDone && oneDone.counts.sent === 1, [one.body, oneDone]);

    // the single test send = the proof
    g0 = GOT.length;
    const ts = await Z.call('POST', '/api/rcs/test-send', sTok, { number: '9811100009', templateId: '22SVkoeCBF', rcstype: 'BASIC', variables: { var1: 'Test' } });
    const tlog = ts.body && ts.body.logId ? await prisma.rcsMessageLog.findUnique({ where: { id: ts.body.logId } }) : null;
    Z.check('B11 Admin test send: the provider answer is shown (login blanked), the log row is saved as sent with the msgid, and it proves THIS address', ts.status === 200 && ts.body.ok && /^ZZM/.test(ts.body.msgId) && /HTTP 200/.test(ts.body.providerAnswer) && !ts.body.providerAnswer.includes(PASS) && tlog && tlog.status === 'sent' && tlog.msgId === ts.body.msgId && ts.body.proven, ts.body);
    const rts = await Z.call('POST', '/api/rcs/test-send', rTok, { number: '9811100009', templateId: '22SVkoeCBF', rcstype: 'BASIC' });
    Z.check('B12 only an Admin makes a test send', rts.status === 403);

    // bulk, same words
    g0 = GOT.length;
    const bulk = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids, templateId: reg.body.id, variables: { var1: 'friend' } });
    if (bulk.body && bulk.body.batchId) made.batchRefs.push(bulk.body.batchId);
    const bDone = bulk.body && bulk.body.batchId && await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${bulk.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; });
    const bReq = sendsOf(g0)[0];
    Z.check('B13 after the proof: 2 queued (3 left out), ONE request "919811100001,919811100002" with the same variables, both logged sent', bulk.status === 202 && bulk.body.queued === 2 && bulk.body.leftOut === 3 && bDone && bDone.counts.sent === 2 && bReq && bReq.body.msisdn.split(',').sort().join(',') === '919811100001,919811100002' && JSON.stringify(bReq.body.variables) === '[{"var1":"friend"}]', [bulk.body, bDone, bReq && bReq.body && bReq.body.msisdn]);

    // personal ({name})
    g0 = GOT.length;
    const pers = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids: [cA.id, cB.id], templateId: reg.body.id, variables: { var1: 'Hi {firstName}' } });
    if (pers.body && pers.body.batchId) made.batchRefs.push(pers.body.batchId);
    const pDone = pers.body && pers.body.batchId && await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${pers.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; });
    const pReq = sendsOf(g0)[0];
    Z.check('B14 {firstName} in a blank -> the per-person address, each person their own name', pDone && pDone.counts.sent === 2 && pReq && pReq.url === '/rcsapimtpl/jsonapi.jsp?apitype=2' && pReq.body.messages[0].variables[0].var1 === 'Hi ZZTEST' && pReq.body.messages.every((m) => m.templateid === '22SVkoeCBF'), pReq && pReq.body);

    // webhook DLR
    const logs = await prisma.rcsMessageLog.findMany({ where: { requestRef: bulk.body.batchId }, orderBy: { msisdn: 'asc' } });
    const d1 = await Z.call('POST', `/api/webhooks/rcs?token=${HOOK}`, null, { data: [{ msgid: logs[0].msgId, msisdn: `+${logs[0].msisdn}`, status: 'DELIVERED' }, { msgid: logs[1].msgId, status: 'failed', reason: 'not an RCS phone' }] });
    // a body that is not valid JSON under a JSON content type, then a real form post: both 200, both read
    const d2 = await Z.call('POST', `/api/webhooks/rcs?token=${HOOK}`, null, `msgid=${logs[0].msgId}&status=failed`);
    const d2f = await realFetch(`${Z.API}/api/webhooks/rcs?token=${HOOK}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `msgid=${logs[0].msgId}&status=undelivered` });
    const d2fb = await d2f.json();
    const after = await prisma.rcsMessageLog.findMany({ where: { requestRef: bulk.body.batchId }, orderBy: { msisdn: 'asc' } });
    Z.check('B15 DLR by msgid: delivered / failed (with the reason); a later "failed" never undoes "delivered"; a form-encoded report is read too', d1.status === 200 && d1.body.delivered === 1 && d1.body.failed === 1 && d2.status === 200 && d2.body.unchanged === 1 && d2f.status === 200 && d2fb.unchanged === 1 && after[0].status === 'delivered' && after[0].deliveredAt && after[1].status === 'failed' && /not an RCS phone/.test(after[1].errorText), [d1.body, d2.body, d2fb, after.map((l) => [l.status, l.errorText])]);
    const d3 = await Z.call('POST', `/api/webhooks/rcs?token=${HOOK}`, null, { something: 'else' });
    Z.check('B16 an unknown payload: 200, kept raw, nothing changed', d3.status === 200 && d3.body.unknown >= 1);

    // error 23 -> pause
    MODE = 'err:23';
    const c23 = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids: [cA.id, cB.id], templateId: reg.body.id, variables: { var1: 'x' } });
    if (c23.body && c23.body.batchId) made.batchRefs.push(c23.body.batchId);
    const paused = await until(async () => { const s = await Z.call('GET', '/api/rcs/status', sTok); return s.body.queue.paused ? s.body : null; });
    const waitingRows = await prisma.rcsMessageLog.count({ where: { requestRef: c23.body.batchId, status: 'queued' } });
    const note = await until(() => prisma.notification.findFirst({ where: { userId: sup.id, title: 'RCS paused: no credit' } }));
    Z.check('B17 error 23 (no credit): the queue PAUSES, the numbers stay queued (not failed), the Admin is told', !!paused && waitingRows === 2 && !!note, [paused && paused.queue, waitingRows, !!note]);
    MODE = 'ok';
    const resumed = await Z.call('POST', '/api/rcs/queue/resume', sTok, {});
    const rDone = await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${c23.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; });
    Z.check('B18 Resume after credit is added: they go', resumed.status === 200 && rDone && rDone.counts.sent === 2, [resumed.body, rDone]);

    // 503 -> 2 retries -> failed (+ SMS fallback, switched on)
    await Z.call('PUT', '/api/rcs/settings', sTok, { smsFallback: true, fallbackHours: 24 });
    MODE = '503'; g0 = GOT.length;
    const c5 = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'candidates', ids: [cA.id], templateId: reg.body.id, variables: { var1: 'Asha' } });
    if (c5.body && c5.body.batchId) made.batchRefs.push(c5.body.batchId);
    const fDone = await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${c5.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; }, 20000);
    MODE = 'ok';
    const fLog = await prisma.rcsMessageLog.findFirst({ where: { requestRef: c5.body.batchId } });
    Z.check('B19 HTTP 503: tried 3 times in all (2 retries), then failed', fDone && fDone.counts.failed === 1 && sendsOf(g0).length === 3 && fLog.status === 'failed', [fDone, sendsOf(g0).length]);
    Z.check('B20 SMS fallback on: the failed RCS went to the EXISTING SMS gateway (its own result on the same row, with the filled SMS text)', fLog && ['sent', 'failed'].includes(fLog.fallbackStatus) && fLog.fallbackAt, fLog && [fLog.fallbackStatus, fLog.fallbackError]);
    // 24 h not delivered
    const old = await prisma.rcsMessageLog.findFirst({ where: { requestRef: c23.body.batchId, status: 'sent' } });
    await prisma.rcsMessageLog.update({ where: { id: old.id }, data: { sentAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const sw = await Z.call('POST', '/api/rcs/fallback/run', sTok, {});
    const oldAfter = await prisma.rcsMessageLog.findUnique({ where: { id: old.id } });
    Z.check('B21 sent but not delivered for 24 h -> SMS fallback tried once', sw.status === 200 && sw.body.checked >= 1 && oldAfter.fallbackStatus && oldAfter.fallbackStatus !== 'skipped', [sw.body, oldAfter.fallbackStatus, oldAfter.fallbackError]);
    await Z.call('PUT', '/api/rcs/settings', sTok, { smsFallback: false });

    // logs
    const lg = await Z.call('GET', '/api/rcs/logs?module=ATS&q=9811100002', sTok);
    const lgf = await Z.call('GET', '/api/rcs/logs?status=failed', sTok);
    const csv = await Z.call('GET', '/api/rcs/logs.csv?module=ATS', sTok);
    Z.check('B22 message log: filter by module + search by number; status filter; numbers masked; CSV export', lg.status === 200 && lg.body.total >= 1 && lg.body.rows.every((x) => x.number.endsWith('0002') && x.number.startsWith('xxxxxx')) && lgf.body.rows.every((x) => x.status === 'Failed') && csv.status === 200 && /Message id/.test(csv.text) && !csv.text.includes('919811100002'), [lg.body.total, lgf.body.total]);

    // per-person permission
    await Z.call('PUT', '/api/rcs/settings', sTok, { allowedUserIds: [rec.id] });
    const rs1 = await Z.call('GET', '/api/rcs/status', rTok);
    const rOut = await Z.call('POST', '/api/rcs/check', rTok, { audience: 'candidates', ids: [cA.id], templateId: reg.body.id });
    const rLogs = await Z.call('GET', '/api/rcs/logs', rTok);
    Z.check('B23 an Admin ticks the Recruiter: they may send, but only to people in their own access (this one is outside); they see only their own log rows; no settings', rs1.body.may.send === true && rs1.body.may.admin === false && !rs1.body.webhook && rOut.status === 200 && rOut.body.counts.outside === 1 && rLogs.status === 200 && rLogs.body.total === 0, [rs1.body, rOut.body, rLogs.body.total]);
    await Z.call('PUT', '/api/rcs/settings', sTok, { allowedUserIds: [] });

    // HRMS employee
    const emp = await prisma.employee.create({ data: { employeeCode: `ZZTEST-RCS-E-${Z.RUN}`.slice(0, 40), name: `ZZTEST RCS Emp ${Z.RUN}`, designation: 'Employee', employmentStatus: 'Active', phone: '9811100007' } });
    Z.made.emps.push(emp.id);
    const tplH = await prisma.rcsTemplate.update({ where: { id: mk.body.id }, data: { bodyJson: JSON.stringify({ ...JSON.parse((await prisma.rcsTemplate.findUnique({ where: { id: mk.body.id } })).bodyJson), varCount: 1 }) } });
    const eSend = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'employees', ids: [emp.id], templateId: tplH.id, variables: { var1: 'team' } });
    if (eSend.body && eSend.body.batchId) made.batchRefs.push(eSend.body.batchId);
    const eDone = eSend.body && eSend.body.batchId && await until(async () => { const b = await Z.call('GET', `/api/rcs/batches/${eSend.body.batchId}`, sTok); return b.body && b.body.status === 'done' ? b.body : null; });
    const eLog = eSend.body && await prisma.rcsMessageLog.findFirst({ where: { requestRef: eSend.body.batchId } });
    Z.check('B24 HRMS employees: Send RCS works, logged with module HRMS', eSend.status === 202 && eDone && eDone.counts.sent === 1 && eLog.module === 'HRMS' && eLog.msisdn === '919811100007', [eSend.body, eDone]);
    const missing = await Z.call('POST', '/api/rcs/send', sTok, { audience: 'employees', ids: [emp.id], templateId: tplH.id, variables: {} });
    Z.check('B25 an empty blank is refused before anything is queued', missing.status === 400 && /blank 1/i.test(missing.body.error), missing.body);

    // no secret anywhere
    const everything = JSON.stringify([st0.body, ts.body, lg.body, raw.body, (await Z.call('GET', '/api/rcs/status', sTok)).body, csv.text]);
    Z.check('B26 the RCS password / client secret / webhook token appear in no answer and no log row', !everything.includes(PASS) && !everything.includes(HOOK) && (await prisma.rcsMessageLog.count({ where: { OR: [{ errorText: { contains: PASS } }, { errorText: { contains: USER } }] } })) === 0);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    try {
      stub.close();
      const tpls = await prisma.rcsTemplate.findMany({ where: { OR: [{ id: { in: made.tplIds.filter(Boolean) } }, { name: { contains: 'ZZTEST RCS' } }] }, select: { id: true } });
      await prisma.rcsMessageLog.deleteMany({ where: { OR: [{ requestRef: { in: made.batchRefs } }, { createdAt: { gte: START }, OR: [{ personName: { contains: 'ZZTEST RCS' } }, { personName: 'Admin test send' }] }] } });
      await prisma.rcsBatch.deleteMany({ where: { OR: [{ id: { in: made.batchRefs } }, { createdBy: { contains: 'ZZTEST RCS' } }] } });
      await prisma.rcsTemplate.deleteMany({ where: { id: { in: tpls.map((t) => t.id) } } });
      await prisma.notification.deleteMany({ where: { title: 'RCS paused: no credit', createdAt: { gte: START } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorName: { contains: 'ZZTEST RCS' } }, { entity: { in: ['Rcs', 'RcsTemplate', 'RcsBatch', 'RcsMessageLog'] }, createdAt: { gte: START } }] } });
      // the SMS fallback's own communication records (sandbox: never transmitted)
      const recs = await prisma.appSetting.findMany({ where: { key: { startsWith: 'comm.m.' }, updatedAt: { gte: START } }, select: { key: true, value: true } });
      const mine = recs.filter((x) => String(x.value).includes('RCS_FALLBACK') || String(x.value).includes('ZZTEST RCS'));
      const refs = mine.map((x) => { try { return JSON.parse(x.value).providerRef; } catch { return null; } }).filter(Boolean);
      await prisma.appSetting.deleteMany({ where: { key: { in: [...mine.map((x) => x.key), ...refs.map((x) => `comm.ref.${x}`)] } } });
      await prisma.appSetting.deleteMany({ where: { key: { in: RCS_SETTING_KEYS } } });
      for (const s of savedSettings) await prisma.appSetting.create({ data: { key: s.key, value: s.value } }); // eslint-disable-line no-await-in-loop
    } catch (e) { console.log('cleanup problem', String(e.message).slice(0, 200)); }
    const left = await Z.cleanup().catch((e) => { console.log('cleanup problem', String(e.message).slice(0, 160)); return null; });
    const rcsLeft = await prisma.rcsMessageLog.count({ where: { OR: [{ personName: { contains: 'ZZTEST' } }, { requestRef: { in: made.batchRefs } }] } }) + await prisma.rcsTemplate.count({ where: { name: { contains: 'ZZTEST' } } }) + await prisma.rcsBatch.count({ where: { id: { in: made.batchRefs } } });
    Z.check('Z1 every ZZTEST row is gone (people, RCS templates, logs, batches)', left && Object.values(left).every((v) => v === 0) && rcsLeft === 0, [left, rcsLeft]);
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
