#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SMS PUSH PLATFORM (web.smsgw.in) — adapter + screens API. SANDBOX ONLY, NO REAL SMS: the provider is a mock HTTP server on 127.0.0.1.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/sms-push-platform-test.js
// Proves: the request is built from settings; a message counts as sent ONLY when the answer carries an id (an error word or an unreadable answer
// never looks sent); the password never leaves the server; Admin-only; templates with a DLT id only; bulk needs a confirm; the same message
// is not sent twice; delivery reports (key-checked) move the status; the dashboard / history / CSV are real counts.
// The sandbox "sms" integration row is put back at the end.
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');
const Z = require('./lib/zzfix')('SPT');

const PASS = 'zz-secret-pass-9';
const USER = 'zzuser';
const DLR = 'zz-dlr-secret';
const GOT = [];
const DLR_ASKED = [];
const DLR_REPLY = {};
let MODE = 'ok';
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // the Pull DLR API (manual): GET dlrresp.jsp?ackid=..., XML with one <dlrinfo> per message
    if (req.url.startsWith('/dlrresponse/dlrresp.jsp')) {
      DLR_ASKED.push(req.url);
      res.setHeader('content-type', 'text/xml');
      const ack = new URL(req.url, 'http://x').searchParams.get('ackid');
      res.end(DLR_REPLY[ack] || '<dlr></dlr>');
      return;
    }
    GOT.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    // the documented send reply: {data:{ackid, msgid:["<id>,<mobile>"]}}; a refusal {Error:{ErrorCode, ErrorDesc}}
    if (MODE === 'ok') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ackid: `AK${GOT.length}`, msgid: [`ZZ${GOT.length}ABC,9876543210`] } })); return; }
    res.setHeader('content-type', 'text/plain');
    if (MODE === 'err') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Error: { ErrorCode: '011', ErrorDesc: 'Invalid Mobile Number' } })); }
    else if (MODE === 'echo') res.end(`errordesc:bad login ${USER} ${PASS}`);
    else if (MODE === 'user') res.end('<errordesc:username doesnot exist or invalid or username wrongly encoded,errorcode:01 />');
    else res.end('OK');
  });
});

(async () => {
  const { prisma } = Z;
  const listen = () => new Promise((r) => mock.listen(0, '127.0.0.1', r));
  await listen();
  const BASE = `http://127.0.0.1:${mock.address().port}`;
  const created = { tpls: [], keys: [] };
  const original = await prisma.integration.findUnique({ where: { id: 'sms' } });
  try {
    const CAT = require(path.join(Z.BACK, 'src/utils/adminCatalog'));
    const F = CAT.SMS_FIELDS;
    const { writeValues } = require(path.join(Z.BACK, 'src/utils/integrationStore'));
    const setSms = async (fields, extra = {}) => {
      // the whole form, as the screen sends it (a field not sent keeps its stored value since 2026-10-27)
      const blank = Object.fromEntries(CAT.integrationById('sms').fields.map(([l]) => [l, '']));
      const w = await writeValues('sms', { ...blank, ...fields });
      const values = JSON.parse(JSON.stringify(w.values)); Object.assign(values, extra);
      const data = { values: JSON.stringify(values), enabled: true, connected: true, state: 'Connected' };
      await prisma.integration.upsert({ where: { id: 'sms' }, create: { id: 'sms', ...data }, update: data });
    };
    const full = {
      // the shared Sender ID belongs to MSG91 / Fast2SMS / Twilio: SMS Push Platform must use its own (TMLINK), never OTHERX
      [F.provider]: 'SMS Push Platform', [F.sender]: 'OTHERX', [F.pushSender]: 'TMLINK', [F.pushUrl]: 'https://web.smsgw.in/smsapi/httpapi.jsp', [F.pushUser]: USER, [F.pushPass]: PASS,
      [F.pushPe]: '1101234567890123456', [F.pushBulkTpl]: '1107000000000000001', [F.dlrSecret]: DLR,
    };
    const clearAccepted = () => prisma.appSetting.deleteMany({ where: { key: { in: ['smsgw.accepted', 'smspush.lasttest'] } } });
    await clearAccepted();

    // ======================= A. the adapter (in this process, pointed at the mock) =======================
    await setSms(full, { __devBaseUrl: BASE });
    const G = require(path.join(Z.BACK, 'src/utils/smsGateway'));
    const sandboxFlag = process.env.TEST_MODE; process.env.TEST_MODE = ''; // this process only: let the adapter really talk to the mock
    try {
      let r0 = await G.testConnection();
      Z.check('A0 before any accepted SMS: "not proven", no call made, says what to do', !r0.ok && r0.needsConfirmation && /Send test SMS/.test(r0.result) && GOT.length === 0, r0);
      const held = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Automatic ATS text', templateId: '1107000000000000001' });
      Z.check('G0 before a real test SMS was accepted, an automatic SMS is held: not sent, no call made, says to send a Test SMS', !held.ok && held.notProven && held.notConfigured && GOT.length === 0 && /Test SMS/.test(held.error), [held, GOT.length]);
      let r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hi Ravi, hello', templateId: '1107000000000000001', proving: true });
      const q = new URL(GOT[0].url, 'http://x').searchParams;
      Z.check('A1 accepted: the documented reply is read (msgid ZZ1ABC, ackid AK1 kept for the delivery report)', r.ok && r.providerRef === 'ZZ1ABC' && r.ackId === 'AK1', r);
      Z.check('A2 httpapi.jsp = the manual\'s GET form, the DOCUMENTED names in the address: username, password, to (10 digits), from, text, pe_id, template_id; its own Sender ID', GOT[0].method === 'GET' && /\/smsapi\/httpapi\.jsp\?/.test(GOT[0].url) && !GOT[0].body && q.get('username') === USER && q.get('to') === '9876543210' && q.get('template_id') === '1107000000000000001' && q.get('pe_id') === '1101234567890123456' && q.get('from') === 'TMLINK' && q.get('text') === 'Hi Ravi, hello' && !q.has('coding'), GOT[0]);
      Z.check('A3 the username goes exactly as typed (no spaces, encoded once), the password as its own "password" parameter', q.get('username') === USER && q.get('password') === PASS && (GOT[0].url.match(/username=/g) || []).length === 1, GOT[0].url.replace(PASS, '***'));
      // the manual's JSON form: POST jsonapi.jsp with a JSON body, "to" as a list
      await setSms({ ...full, [F.pushUrl]: 'https://web.smsgw.in/smsapi/jsonapi.jsp' }, { __devBaseUrl: BASE });
      GOT.length = 0;
      const rj = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hi Ravi, hello', templateId: '1107000000000000001' });
      let jb = null; try { jb = JSON.parse(GOT[0].body); } catch { jb = null; }
      Z.check('A3b jsonapi.jsp: POST with a JSON body {username, password, from, to:[number], text, pe_id, template_id}, nothing in the address', rj.ok && GOT[0].method === 'POST' && /jsonapi\.jsp$/.test(GOT[0].url) && jb && jb.username === USER && jb.password === PASS && Array.isArray(jb.to) && jb.to[0] === '9876543210' && jb.pe_id === '1101234567890123456', [rj.ok, GOT[0] && GOT[0].method, GOT[0] && GOT[0].url]);
      await setSms(full, { __devBaseUrl: BASE });
      GOT.length = 0;
      await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hi Ravi, hello', templateId: '1107000000000000001' });
      r0 = await G.testConnection();
      Z.check('A4 after an accepted SMS the connection is "connected" and says when', r0.ok && r0.verified && /ZZ1ABC/.test(r0.result), r0);

      MODE = 'err';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A5 the documented refusal {Error:{ErrorCode 011}} is a refusal, not retried, in plain words with the code', !r.ok && r.providerError && !r.transient && /code 011/.test(r.error) && /mobile number is not valid/.test(r.error), r);
      Z.check('A5b the provider\'s own answer comes back word for word with the refusal (for the screen)', !!r.providerResponse && /011/.test(r.providerResponse) && !r.providerResponse.includes(PASS), r.providerResponse);
      MODE = 'user';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A5c the live refusal "username doesnot exist ... wrongly encoded": shown word for word with the HTTP status, plus what to check (never the username itself)', !r.ok && /HTTP 200/.test(r.providerResponse || '') && /username doesnot exist/.test(r.providerResponse) && /API username/.test(r.error) && /"username" parameter/.test(r.error) && !r.error.includes(USER) && !r.error.includes(PASS), [r.error, r.providerResponse]);
      MODE = 'echo';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A6 a provider that echoes the login back: username and password are scrubbed from the message', !r.ok && !r.error.includes(PASS) && !r.error.includes(USER), r.error);
      MODE = 'weird';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A7 an answer with no readable id is UNKNOWN: not sent, not retried, says so', !r.ok && r.unknown && !r.transient && /NOT counted as sent/.test(r.error), r);
      await setSms({ ...full, [F.pushBulkTpl]: '' }, { __devBaseUrl: BASE });
      GOT.length = 0;
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x' });
      Z.check('A8 no DLT template id (none on the message, no Bulk / General id set) -> nothing is sent, says why', GOT.length === 0 && !r.ok && r.notConfigured && /DLT/.test(r.error), r);
      await setSms(full, { __devBaseUrl: BASE });
      r = await G.sendSms({ to: '12345', kind: 'bulk', text: 'x', templateId: '1' });
      Z.check('A9 a bad number is refused before any call', !r.ok && r.invalid, r);

      // Unicode (Telugu) goes with coding=2 (the manual)
      MODE = 'ok'; GOT.length = 0;
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'నమస్తే రవి', templateId: '1107000000000000001' });
      const qu = new URL(GOT[0].url, 'http://x').searchParams;
      Z.check('A13 Telugu text is sent as Unicode: coding=2, the text unchanged', r.ok && qu.get('coding') === '2' && qu.get('text') === 'నమస్తే రవి', [r, GOT[0] && GOT[0].body]);
      // the campaign template: with no template of its own, a bulk SMS uses the SMS Push Platform Bulk / General DLT id (not OTP / link)
      GOT.length = 0;
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Campaign words' });
      Z.check('A14 a campaign SMS without its own template uses the Bulk / General DLT Template ID', r.ok && new URL(GOT[0].url, 'http://x').searchParams.get('template_id') === '1107000000000000001', GOT[0] && GOT[0].url.replace(PASS, '***'));

      // ---- the Pull DLR API --------------------------------------------------------------------------------------------------
      DLR_REPLY.AK1 = '<dlr><dlrinfo><msgid>ZZ1ABC,9876543210</msgid><ackid>AK1</ackid><mob>9876543210</mob><dlrdesc>DELIVRD</dlrdesc></dlrinfo></dlr>';
      DLR_REPLY.AK2 = '<dlr><dlrinfo><msgid>ZZ2ABC</msgid><ackid>AK2</ackid><dlrdesc>SUBMITTED</dlrdesc></dlrinfo></dlr>';
      let pd = await G.pullDelivery('AK1');
      Z.check('A15 the Pull DLR API is asked with the ackid only (no login in the address) and DELIVRD reads as delivered', pd.ok && pd.reports.length === 1 && pd.reports[0].msgid === 'ZZ1ABC' && pd.reports[0].status === 'delivered' && /ackid=AK1$/.test(DLR_ASKED[0]) && !DLR_ASKED[0].includes(PASS) && !DLR_ASKED[0].includes(USER), [pd, DLR_ASKED]);
      pd = await G.pullDelivery('AK2');
      Z.check('A16 SUBMITTED is not a delivery report: nothing is reported', pd.ok && pd.reports.length === 0, pd);
      // a record kept with its ackid moves to Delivered only through the provider's report
      const store = require(path.join(Z.BACK, 'src/channels/store'));
      const DLRJ = require(path.join(Z.BACK, 'src/utils/smsPushDlr'));
      const recRef = `ZZPULL${Z.RUN}`;
      await store.record({ channel: 'SMS', provider: 'sms.gateway', to: '+919876543210', template: 'ZZTEST SPT pull', status: 'sent', providerRef: recRef, ackId: `AKP${Z.RUN}` });
      DLR_REPLY[`AKP${Z.RUN}`] = `<dlr><dlrinfo><msgid>${recRef}</msgid><dlrdesc>UNDELIV</dlrdesc></dlrinfo></dlr>`;
      const po = await DLRJ.pullOne(await store.byRef(recRef));
      const after = await store.byRef(recRef);
      Z.check('A17 pulling one record: UNDELIV from the provider marks it Failed, the try is counted', po.asked && po.applied === 1 && after.status === 'failed' && after.dlrPullCount === 1, [po, after && after.status, after && after.dlrPullCount]);
      if (after && after._key) await prisma.appSetting.deleteMany({ where: { key: { in: [after._key, `comm.ref.${recRef}`] } } }); // not counted on the dashboard below

      // settings change the request: other names, GET, a fixed extra
      MODE = 'ok'; GOT.length = 0;
      await setSms({ ...full, [F.pushNames]: JSON.stringify({ to: 'mobile', method: 'GET', extra: { smstype: 'TRANS' } }), [F.pushOk]: 'tracking=(\\w+)' }, { __devBaseUrl: BASE });
      MODE = 'custom';
      mock.removeAllListeners('request');
      mock.on('request', (req, res) => { GOT.push({ method: req.method, url: req.url, body: '' }); res.end('tracking=T9XYZ'); });
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hello', templateId: '1107000000000000001' });
      Z.check('A10 field names, method and a fixed extra come from the settings; the id pattern too', r.ok && r.providerRef === 'T9XYZ' && GOT[0].method === 'GET' && /mobile=9876543210/.test(GOT[0].url) && /smstype=TRANS/.test(GOT[0].url) && !/[?&]to=/.test(GOT[0].url), [r, GOT[0]]);
      const bad = await (async () => { await setSms({ ...full, [F.pushNames]: '{oops' }); return G.smsConfig(); })();
      Z.check('A11 broken JSON in the field names is reported, not guessed', !bad.configured && /not valid JSON/.test(bad.reason), bad.reason);
      const noPe = await (async () => { await setSms({ ...full, [F.pushPe]: '' }); return G.smsConfig(); })();
      Z.check('A12 no PE id -> "Configuration Required" naming the PE id', !noPe.configured && /PE ID/.test(noPe.reason), noPe.reason);
      const cfgOf = async (vals) => { await setSms({ ...full, ...vals }); return G.smsConfig(); };
      // founder 2026-10-27: the provider's own HTTP API endpoint may be its own public https domain; never http, an IP or an internal name
      let c1 = await cfgOf({ [F.pushUrl]: 'https://sms.provider-example.com/smsapi/httpapi.jsp' });
      Z.check('A18 the provider\'s own public https endpoint is accepted', c1.configured, c1.reason);
      const refused = [];
      for (const u of ['http://web.smsgw.in/smsapi/httpapi.jsp', 'https://10.0.0.5/smsapi/httpapi.jsp', 'https://localhost/x', 'https://sms.internal/x', 'https://user:pw@web.smsgw.in/x', 'not a url']) {
        const c = await cfgOf({ [F.pushUrl]: u });
        if (!c.configured && /HTTP API endpoint/.test(c.reason)) refused.push(u);
      }
      Z.check('A18b plain http, a bare IP, localhost, an internal name, a login in the address, or no address: refused (the password never goes there)', refused.length === 6, refused);
      // founder 2026-10-27: every SMS Push field filled in, but the Provider box still said MSG91 (its pre-filled value) -> "No API key"
      c1 = await cfgOf({ [F.provider]: 'MSG91' });
      Z.check('G1 Provider box left at MSG91 + the SMS Push Platform username and password filled in: it IS SMS Push Platform (no API key asked)', c1.configured && c1.provider === 'SMSGW' && c1.providerInferred && !/API key/.test(c1.reason), [c1.provider, c1.reason]);
      c1 = await cfgOf({ [F.provider]: 'MSG91', [F.key]: 'msg91-real-key' });
      Z.check('G2 a provider with its own API key is never overridden', c1.provider === 'MSG91' && !c1.providerInferred, c1.provider);
      await setSms(full, { [F.key]: '' }); // the MSG91 key typed for G2 goes again (a blank secret box keeps the stored one)
      c1 = await cfgOf({ [F.pushSender]: '' });
      Z.check('A19 no SMS Push Sender ID -> not configured; the other provider\'s Sender ID is never borrowed', !c1.configured && /own Sender ID/.test(c1.reason), c1.reason);
      c1 = await cfgOf({ [F.pushBulkTpl]: 'one var: the message' });
      Z.check('A20 a template id that is words (a description), not digits, is reported', !c1.configured && /digits only/.test(c1.reason), c1.reason);
      c1 = await cfgOf({ [F.pushBulkTpl]: '1101234567890123456' });
      Z.check('A21 the PE ID typed as the template id is caught (they are different numbers)', !c1.configured && /same number/.test(c1.reason), c1.reason);
      c1 = await cfgOf({ [F.pushLinkTpl]: '', [F.pushOtpTpl]: '' });
      Z.check('A22 empty Agreement-link / OTP template ids do not stop a campaign-only setup', c1.configured, c1.reason);
      // a value saved from the old form's greyed hint reads as "not set"
      await setSms({ ...full }, { [F.pushUser]: 'SMS Push Platform only' });
      c1 = await G.smsConfig();
      Z.check('A23 "SMS Push Platform only" (the old greyed hint) is never used as the username', !c1.configured && c1.push.user === '' && /API username/.test(c1.reason), c1.push.user);
      // the form's hint sent back as a value is stored as empty, and a provider's settings the form did not send are kept
      await setSms({ ...full, [F.key]: 'zz-msg91-key', [F.bulkTpl]: '1207000000000000002' });
      const w2 = await writeValues('sms', { [F.provider]: 'SMS Push Platform', [F.pushBulkTpl]: CAT.integrationById('sms').fields.find(([l]) => l === F.pushBulkTpl)[1] });
      Z.check('A24 saving keeps MSG91\'s template / key when the form did not send them, and never stores a hint as a value', w2.values[F.bulkTpl] === '1207000000000000002' && /enc:v1:/.test(w2.values[F.key] || '') && w2.values[F.pushBulkTpl] === '', [w2.values[F.bulkTpl], w2.values[F.pushBulkTpl]]);
    } finally { process.env.TEST_MODE = sandboxFlag; }

    // ======================= B. the screens API (the sandbox server: its SMS send is fake, never transmitted) =======================
    await setSms(full, { [F.key]: '' });
    await clearAccepted();
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'Recruiter' });
    const aTok = await Z.mint(admin); const rTok = await Z.mint(rec);
    const A = (m, p, b) => Z.call(m, `/api/sms-platform${p}`, aTok, b);

    const nr = await Z.call('GET', '/api/sms-platform/overview', rTok);
    Z.check('B1 a Recruiter is refused (403) on every SMS Push Platform screen', nr.status === 403, nr.status);
    const ov = await A('GET', '/overview');
    Z.check('B2 overview: configured but "Not connected" until the provider has accepted an SMS', ov.status === 200 && ov.body.configured && ov.body.state === 'Not connected' && ov.body.isPush && ov.body.peId === '1101234567890123456', ov.body);
    Z.check('B3 no secret in the overview (the password only as "set")', !JSON.stringify(ov.body).includes(PASS) && ov.body.hasPassword === true && !JSON.stringify(ov.body).includes(DLR));
    Z.check('B4 the report address is shown with a placeholder, not the secret', /\/api\/webhooks\/sms\/smsgw\?key=<your delivery-report secret>/.test(ov.body.reportAddress), ov.body.reportAddress);

    const mkTpl = async (name, dlt) => {
      const t = await prisma.messageTemplate.create({ data: { purpose: `CUSTOM_ZZTEST_SPT_${name}_${Z.RUN}`.toUpperCase(), purposeLabel: `ZZTEST SPT ${name}`, audience: 'candidate', channel: 'SMS', language: 'English', name: `ZZTEST SPT ${name} ${Z.RUN}`, body: 'Hello {{name}}, this is a TeamLink test.', active: true, isDefault: false, dltTemplateId: dlt, senderId: dlt ? 'TMLINK' : null } });
      created.tpls.push(t.id); return t;
    };
    const tOk = await mkTpl('ok', '1107000000000000009'); const tNo = await mkTpl('nodlt', null);

    const day0 = new Date().toISOString().slice(0, 10);
    const b0 = (await A('GET', `/dashboard?from=${day0}&to=${day0}`)).body.counts || { requests: 0, submitted: 0, failed: 0, delivered: 0, unknown: 0, pendingReports: 0 };
    let r = await A('POST', '/send', { recipients: [{ mobile: '9876543210', name: 'Ravi' }] });
    Z.check('C1 no template -> refused (an arbitrary message is never assumed approved)', r.status === 400 && /approved template/i.test(r.body.error), r.body);
    r = await A('POST', '/send', { templateId: tNo.id, recipients: [{ mobile: '9876543210', name: 'Ravi' }] });
    Z.check('C2 a template without a DLT id -> refused, says where to add it', r.status === 400 && /DLT Template ID/.test(r.body.error), r.body);
    r = await A('POST', '/preview', { templateId: tOk.id, recipientName: 'Ravi' });
    Z.check('C3 preview shows the exact words, characters and parts', r.status === 200 && r.body.text === 'Hello Ravi, this is a TeamLink test.' && r.body.chars === 36 && r.body.segments === 1 && r.body.dltTemplateId === '1107000000000000009', r.body);

    const key = `zz-key-${Z.RUN}`;
    r = await A('POST', '/send', { templateId: tOk.id, module: 'HRMS', idempotencyKey: key, recipients: [{ mobile: '9876543210', name: 'Ravi' }] });
    const ref1 = r.body.results && r.body.results[0] && r.body.results[0].providerRef;
    Z.check('C4 a single send is "Submitted" (not Delivered) with the provider reference', r.status === 200 && r.body.results[0].status === 'Submitted' && !!ref1, r.body);
    const again = await A('POST', '/send', { templateId: tOk.id, module: 'HRMS', idempotencyKey: key, recipients: [{ mobile: '9876543210', name: 'Ravi' }] });
    Z.check('C5 the same request key again is NOT sent again (a double click)', again.status === 200 && again.body.repeated === true, again.body);
    r = await A('POST', '/send', { templateId: tOk.id, module: 'HRMS', recipients: [{ mobile: '9876543210', name: 'Ravi' }] });
    Z.check('C6 the same words to the same number a moment later are skipped', r.status === 200 && r.body.results[0].status === 'Skipped' && /not sent again/.test(r.body.results[0].error), r.body);

    r = await A('POST', '/send', { templateId: tOk.id, module: 'ATS', recipients: [{ mobile: '9876543211', name: 'A' }, { mobile: '9876543212', name: 'B' }] });
    Z.check('C7 several recipients need a confirm (409 CONFIRM_BULK)', r.status === 409 && r.body.code === 'CONFIRM_BULK' && r.body.count === 2, r.body);
    r = await A('POST', '/send', { templateId: tOk.id, module: 'ATS', confirm: true, recipients: [{ mobile: '9876543211', name: 'A' }, { mobile: '9876543212', name: 'B' }, { mobile: '9876543211', name: 'A' }, { mobile: 'abc' }, { mobile: '12345' }] });
    Z.check('C8 confirmed bulk: 2 submitted, a repeated number once, bad numbers skipped with reasons', r.status === 200 && r.body.counts.Submitted === 2 && r.body.counts.Skipped === 3, r.body.counts);
    r = await A('POST', '/send', { templateId: tOk.id, confirm: true, recipients: Array.from({ length: 501 }, (_, i) => ({ mobile: `98765${String(10000 + i)}` })) });
    Z.check('C9 more than the limit at once is refused', r.status === 400 && /At most 500/.test(r.body.error), r.body.error);

    // ---- history and detail -------------------------------------------------------------------------------------------------
    const today = new Date().toISOString().slice(0, 10);
    let h = await A('GET', `/history?from=${today}&to=${today}&module=HRMS`);
    const row = h.body.rows && h.body.rows.find((x) => x.providerRef === ref1);
    Z.check('D1 history has the SMS with module, template, preview, sender id, provider id; submission Submitted, delivery Submitted', h.status === 200 && row && row.module === 'HRMS' && /ZZTEST SPT ok/.test(row.template) && row.preview === 'Hello Ravi, this is a TeamLink test.' && row.senderId === 'TMLINK' && row.submission === 'Submitted' && row.delivery === 'Submitted', h.body);
    h = await A('GET', `/history?from=${today}&to=${today}&q=9876543211`);
    Z.check('D2 filter by recipient number works', h.body.total === 1, h.body.total);

    // ---- delivery reports -----------------------------------------------------------------------------------------------------
    const dlr = (ref, st, q = `?key=${DLR}`, extra = {}) => Z.call('POST', `/api/webhooks/sms/smsgw${q}`, null, { MsgId: ref, Status: st, ...extra });
    let d = await dlr(ref1, 'DELIVRD', '?key=wrong');
    Z.check('E1 a delivery report with the wrong key is refused (403)', d.status === 403, d.status);
    d = await dlr(ref1, 'garbage-status');
    h = await A('GET', `/history?from=${today}&to=${today}&module=HRMS`);
    Z.check('E2 an unreadable status changes nothing', h.body.rows.find((x) => x.providerRef === ref1).delivery === 'Submitted');
    d = await dlr(ref1, 'DELIVRD');
    h = await A('GET', `/history?from=${today}&to=${today}&module=HRMS`);
    Z.check('E3 DELIVRD from the provider -> Delivered', d.status === 200 && h.body.rows.find((x) => x.providerRef === ref1).delivery === 'Delivered', [d.status, d.body]);
    await dlr(ref1, 'UNDELIV');
    h = await A('GET', `/history?from=${today}&to=${today}&module=HRMS`);
    Z.check('E4 "undelivered" after "delivered": a failure report always wins (the provider said so), the submission stays Submitted', h.body.rows.find((x) => x.providerRef === ref1).delivery === 'Failed' && h.body.rows.find((x) => x.providerRef === ref1).submission === 'Submitted');
    const refB = (await A('GET', `/history?from=${today}&to=${today}&module=ATS`)).body.rows.map((x) => x.providerRef).filter(Boolean)[0];
    d = await dlr(refB, 'FAILED', `?key=${DLR}`, { ErrorDesc: 'Number in DND' });
    const det = await A('GET', `/history/detail?ref=${encodeURIComponent(refB)}`);
    Z.check('E5 a failure report keeps the provider words; detail shows the status ticks', det.status === 200 && det.body.delivery === 'Failed' && /DND/.test(det.body.error || '') && det.body.history.length >= 2, det.body);

    // ---- dashboard + export ---------------------------------------------------------------------------------------------------
    const dash = await A('GET', `/dashboard?from=${today}&to=${today}`);
    const c = dash.body.counts;
    Z.check('F1 dashboard counts are the records: 3 requests, 3 submitted, 2 reported failed by the provider, 0 delivered, none "unknown"', dash.status === 200 && c.requests - b0.requests === 3 && c.submitted - b0.submitted === 3 && c.failed - b0.failed === 2 && c.delivered - b0.delivered === 0 && c.unknown - b0.unknown === 0 && c.pendingReports - b0.pendingReports === 1, [c, b0]);
    Z.check('F2 usage by source module is real (HRMS 1, ATS 2) and no balance is invented', dash.body.byModule.find((m) => m.module === 'HRMS').count === 1 && dash.body.byModule.find((m) => m.module === 'ATS').count === 2 && dash.body.credits === null && /no documented balance/.test(dash.body.creditsNote), dash.body.byModule);
    const csv = await Z.call('GET', `/api/sms-platform/history.csv?from=${today}&to=${today}`, aTok);
    Z.check('F3 CSV export: header + a row per SMS, UTF-8', csv.status === 200 && /^﻿"Date and time"/.test(csv.text) && csv.text.split('\r\n').length === 4 + b0.requests, csv.text.slice(0, 200));
    // test-connection (the safe check) records itself
    const tc = await A('POST', '/test-connection');
    Z.check('F4 test connection with nothing accepted: not proven, nothing sent', tc.status === 200 && tc.body.ok === false && tc.body.needsConfirmation === true, tc.body);

    // ---- Test SMS on Integrations > SMS Gateway (the sandbox server never transmits) --------------------------------------------------
    // Integrations > SMS Gateway is a Super Admin screen (administration · Integrations · configure)
    const sup = await Z.mkUser('sup', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
    const sTok = await Z.mint(sup);
    const tsBody = { to: '9876543299', text: `ZZTEST SPT test words ${Z.RUN}` };
    // SAVE & CONNECT checks the settings on the server; the channel is switched on ONLY when they pass (founder 2026-10-27)
    const blankForm = Object.fromEntries(CAT.integrationById('sms').fields.map(([l]) => [l, '']));
    const sv1 = await Z.call('PUT', '/api/admin/integrations/sms/configure', sTok, { values: { ...blankForm, ...full, [F.pushPe]: '' } });
    const row1 = await prisma.integration.findUnique({ where: { id: 'sms' } });
    Z.check('V1 Save with a problem (no PE ID): saved, but NOT switched on; the screen is told what to fix', sv1.status === 422 && sv1.body.saved === true && /PE ID/.test(sv1.body.error) && row1.enabled === false && row1.connected === false, [sv1.status, sv1.body.error, row1.enabled]);
    const rc = await Z.call('POST', '/api/admin/integrations/sms/connect', sTok, {});
    Z.check('V2 Reconnect is refused too while the settings have a problem', rc.status === 422 && /PE ID/.test(rc.body.error || ''), [rc.status, rc.body.error]);
    const sv2 = await Z.call('PUT', '/api/admin/integrations/sms/configure', sTok, { values: { ...blankForm, ...full } });
    const row2 = await prisma.integration.findUnique({ where: { id: 'sms' } });
    Z.check('V3 Save with everything right: switched on; no API key / auth token was asked for', sv2.status === 200 && row2.enabled === true && row2.connected === true, [sv2.status, sv2.body.error, row2.enabled]);
    await setSms(full, { [F.key]: '' }); // a blank secret box keeps the stored key: clear any MSG91 key this database copy carries
    const sv3 = await Z.call('PUT', '/api/admin/integrations/sms/configure', sTok, { values: { ...blankForm, ...full, [F.provider]: 'MSG91' } });
    const row3 = await prisma.integration.findUnique({ where: { id: 'sms' } });
    const stored3 = (await require(path.join(Z.BACK, 'src/utils/integrationStore')).readConfig('sms')).values[F.provider];
    Z.check('V4 Save with the Provider box at MSG91 and the SMS Push login filled: saved as SMS Push Platform and switched on', sv3.status === 200 && row3.enabled === true && stored3 === 'SMS Push Platform', [sv3.status, sv3.body.error, stored3]);
    const tcon = await Z.call('POST', '/api/admin/integrations/sms/test', sTok, {});
    const row4 = await prisma.integration.findUnique({ where: { id: 'sms' } });
    Z.check('V5 Test connection on SMS Push Platform says "send a Test SMS" and does NOT mark it Reconnect Required', tcon.status === 200 && /Test SMS/i.test(tcon.body.result || '') && row4.state !== 'Reconnect Required', [tcon.status, tcon.body.result, row4.state]);
    const ts = await Z.call('POST', '/api/admin/integrations/sms/test-message', sTok, tsBody);
    Z.check('H1 Test SMS: the provider accepted it -> "Accepted by Provider — Delivery Pending" (never "Delivered")', ts.status === 200 && ts.body.status === 'Accepted by Provider — Delivery Pending' && !/Delivered\b/.test(ts.body.status.replace('Delivery Pending', '')), ts.body);
    const row5 = await prisma.integration.findUnique({ where: { id: 'sms' } });
    Z.check('V6 an accepted Test SMS marks the channel Connected', ts.status === 200 && row5.state === 'Connected' && row5.connected === true, [ts.status, row5.state]);
    const ts2 = await Z.call('POST', '/api/admin/integrations/sms/test-message', sTok, tsBody);
    Z.check('H2 the same test again within a minute is refused (a double click never sends two SMS)', ts2.status === 409 && ts2.body.outcome === 'Duplicate', [ts2.status, ts2.body]);
    const ts3 = await Z.call('POST', '/api/admin/integrations/sms/test-message', rTok, { to: '9876543298', text: 'x' });
    Z.check('H3 a Recruiter cannot send a Test SMS (403)', ts3.status === 403, ts3.status);
    const integ = await Z.call('GET', '/api/admin/integrations', sTok);
    const smsCard = (Array.isArray(integ.body) ? integ.body : (integ.body.channels || integ.body.integrations || [])).find((x) => x.id === 'sms');
    Z.check('H4 the SMS Gateway card carries the provider dropdown (4 providers), the hints and the per-provider fields; no password', !!smsCard && (smsCard.choices[F.provider] || []).join(',') === 'MSG91,Fast2SMS,Twilio,SMS Push Platform' && smsCard.hints.includes(F.pushUser) && smsCard.byProvider.groups['SMS Push Platform'].includes(F.pushSender) && !JSON.stringify(smsCard).includes(PASS), smsCard && Object.keys(smsCard));

    // ---- no secret anywhere -----------------------------------------------------------------------------------------------------------
    const everything = JSON.stringify([ov.body, h.body, dash.body, det.body, tc.body]);
    Z.check('G1 the API password and the report secret appear in no answer', !everything.includes(PASS) && !everything.includes(DLR));
    const stored = await prisma.integration.findUnique({ where: { id: 'sms' } });
    Z.check('G2 the password is stored encrypted, not in clear', !stored.values.includes(PASS) && /enc:v1:/.test(stored.values), stored.values.slice(0, 120));
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    try {
      mock.close();
      await prisma.messageTemplate.deleteMany({ where: { id: { in: created.tpls } } }).catch(() => {});
      await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'smspush.' } }, { key: 'smsgw.accepted' }, { key: { startsWith: 'webhook.seen.sms' } }] } }).catch(() => {});
      // the communication records this test made (found by the template name they carry)
      const recs = await prisma.appSetting.findMany({ where: { key: { startsWith: 'comm.m.' } }, select: { key: true, value: true } });
      const mine = recs.filter((x) => String(x.value).includes('ZZTEST SPT'));
      const refs = mine.map((x) => { try { return JSON.parse(x.value).providerRef; } catch { return null; } }).filter(Boolean);
      await prisma.appSetting.deleteMany({ where: { key: { in: [...mine.map((x) => x.key), ...refs.map((x) => `comm.ref.${x}`)] } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorName: { contains: 'ZZTEST SPT' } }, { entityId: { in: created.tpls } }, { entityId: 'sms', action: 'SMS connection test' }, { entityId: 'sms', action: 'SMS test message' }] } }).catch(() => {});
      if (original) await prisma.integration.update({ where: { id: 'sms' }, data: { values: original.values, enabled: original.enabled, connected: original.connected, state: original.state } });
      else await prisma.integration.deleteMany({ where: { id: 'sms' } });
    } catch (e) { console.log('cleanup problem', String(e.message).slice(0, 200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
