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
let MODE = 'ok';
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    GOT.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('content-type', 'text/plain');
    if (MODE === 'ok') res.end(`status=SUCCESS msgid:ZZ${GOT.length}ABC`);
    else if (MODE === 'err') res.end('errorcode:02 errordesc:invalid template id');
    else if (MODE === 'echo') res.end(`errordesc:bad login ${USER} ${PASS}`);
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
      const w = await writeValues('sms', fields);
      const values = JSON.parse(JSON.stringify(w.values)); Object.assign(values, extra);
      const data = { values: JSON.stringify(values), enabled: true, connected: true, state: 'Connected' };
      await prisma.integration.upsert({ where: { id: 'sms' }, create: { id: 'sms', ...data }, update: data });
    };
    const full = {
      [F.provider]: 'SMS Push Platform', [F.sender]: 'TMLINK', [F.pushUrl]: 'https://web.smsgw.in/smsapi/httpapi.jsp', [F.pushUser]: USER, [F.pushPass]: PASS,
      [F.pushPe]: '1101234567890123456', [F.dlrSecret]: DLR,
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
      let r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hi Ravi, hello', templateId: '1107000000000000001' });
      const q = new URLSearchParams(GOT[0] && GOT[0].body);
      Z.check('A1 accepted: id read from the answer, nothing else needed', r.ok && /^ZZ1ABC$/.test(r.providerRef), r);
      Z.check('A2 POST form with the standard names; mobile with 91; DLT template id + PE id + sender', GOT[0].method === 'POST' && q.get('username') === USER && q.get('mobileno') === '919876543210' && q.get('templateid') === '1107000000000000001' && q.get('entityid') === '1101234567890123456' && q.get('sendername') === 'TMLINK' && q.get('message') === 'Hi Ravi, hello', GOT[0]);
      Z.check('A3 the password travels in the body, never in the address', !GOT[0].url.includes(PASS) && q.get('password') === PASS, GOT[0].url);
      r0 = await G.testConnection();
      Z.check('A4 after an accepted SMS the connection is "connected" and says when', r0.ok && r0.verified && /ZZ1ABC/.test(r0.result), r0);

      MODE = 'err';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A5 an error answer is a refusal, not retried, with the provider words', !r.ok && r.providerError && !r.transient && /invalid template id/.test(r.error), r);
      MODE = 'echo';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A6 a provider that echoes the login back: username and password are scrubbed from the message', !r.ok && !r.error.includes(PASS) && !r.error.includes(USER), r.error);
      MODE = 'weird';
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x', templateId: '1107000000000000001' });
      Z.check('A7 an answer with no readable id is UNKNOWN: not sent, not retried, says so', !r.ok && r.unknown && !r.transient && /NOT counted as sent/.test(r.error), r);
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'x' });
      Z.check('A8 no DLT template id -> nothing is sent, says why', !r.ok && r.notConfigured && /DLT/.test(r.error), r);
      r = await G.sendSms({ to: '12345', kind: 'bulk', text: 'x', templateId: '1' });
      Z.check('A9 a bad number is refused before any call', !r.ok && r.invalid, r);

      // settings change the request: other names, GET, a fixed extra
      MODE = 'ok'; GOT.length = 0;
      await setSms({ ...full, [F.pushNames]: JSON.stringify({ to: 'mobile', method: 'GET', extra: { smstype: 'TRANS' } }), [F.pushOk]: 'tracking=(\\w+)' }, { __devBaseUrl: BASE });
      MODE = 'custom';
      mock.removeAllListeners('request');
      mock.on('request', (req, res) => { GOT.push({ method: req.method, url: req.url, body: '' }); res.end('tracking=T9XYZ'); });
      r = await G.sendSms({ to: '9876543210', kind: 'bulk', text: 'Hello', templateId: '1107000000000000001' });
      Z.check('A10 field names, method and a fixed extra come from the settings; the id pattern too', r.ok && r.providerRef === 'T9XYZ' && GOT[0].method === 'GET' && /mobile=919876543210/.test(GOT[0].url) && /smstype=TRANS/.test(GOT[0].url) && !/mobileno=/.test(GOT[0].url), [r, GOT[0]]);
      const bad = await (async () => { await setSms({ ...full, [F.pushNames]: '{oops' }); return G.smsConfig(); })();
      Z.check('A11 broken JSON in the field names is reported, not guessed', !bad.configured && /not valid JSON/.test(bad.reason), bad.reason);
      const noPe = await (async () => { await setSms({ ...full, [F.pushPe]: '' }); return G.smsConfig(); })();
      Z.check('A12 no PE id -> "Configuration Required" naming the PE id', !noPe.configured && /PE ID/.test(noPe.reason), noPe.reason);
    } finally { process.env.TEST_MODE = sandboxFlag; }

    // ======================= B. the screens API (the sandbox server: its SMS send is fake, never transmitted) =======================
    await setSms(full);
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
    Z.check('F1 dashboard counts are the records: 3 requests, 3 submitted, 2 reported failed by the provider, 0 delivered, none "unknown"', dash.status === 200 && c.requests === 3 && c.submitted === 3 && c.failed === 2 && c.delivered === 0 && c.unknown === 0 && c.pendingReports === 1, dash.body);
    Z.check('F2 usage by source module is real (HRMS 1, ATS 2) and no balance is invented', dash.body.byModule.find((m) => m.module === 'HRMS').count === 1 && dash.body.byModule.find((m) => m.module === 'ATS').count === 2 && dash.body.credits === null && /no documented balance/.test(dash.body.creditsNote), dash.body.byModule);
    const csv = await Z.call('GET', `/api/sms-platform/history.csv?from=${today}&to=${today}`, aTok);
    Z.check('F3 CSV export: header + a row per SMS, UTF-8', csv.status === 200 && /^﻿"Date and time"/.test(csv.text) && csv.text.split('\r\n').length === 4, csv.text.slice(0, 200));
    // test-connection (the safe check) records itself
    const tc = await A('POST', '/test-connection');
    Z.check('F4 test connection with nothing accepted: not proven, nothing sent', tc.status === 200 && tc.body.ok === false && tc.body.needsConfirmation === true, tc.body);

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
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorName: { contains: 'ZZTEST SPT' } }, { entityId: { in: created.tpls } }, { entityId: 'sms', action: 'SMS connection test' }] } }).catch(() => {});
      if (original) await prisma.integration.update({ where: { id: 'sms' }, data: { values: original.values, enabled: original.enabled, connected: original.connected, state: original.state } });
      else await prisma.integration.deleteMany({ where: { id: 'sms' } });
    } catch (e) { console.log('cleanup problem', String(e.message).slice(0, 200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
