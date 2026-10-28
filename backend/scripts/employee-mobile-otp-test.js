#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EMPLOYEE MOBILE OTP over the saved SMS Gateway (founder 2026-10-28: "Test SMS works, but mobile verification says
// No SMS gateway is configured / Something went wrong"). NO REAL SMS: the provider is a mock HTTP server on 127.0.0.1.
// Runs in-process on a COPY of the database (refuses dev.db):
//   TL_TEST_DB=C:/path/copy.db node scripts/employee-mobile-otp-test.js
// Proves: My Profile reads the SAME saved SMS Push Platform settings the Test SMS uses; a missing OTP template / an
// unproven gateway is said plainly and nothing is sent; the code reaches the provider with the OTP DLT template and the
// approved text; a refusal or an unreadable answer is NOT "sent" and leaves no code outstanding; one code a minute;
// the code from the SMS verifies the mobile; the log carries a ref but never the code, the number or the login.
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const DB = String(process.env.TL_TEST_DB || '');
if (!DB || /(^|[\\/])dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to a COPY of the database (never dev.db).'); process.exit(2); }
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
delete process.env.TEAMLINK_SANDBOX;
process.env.SMS_PUSH_DLR_PULL = 'off';

const USER = 'zzotpuser';
const PASS = 'zz-otp-pass-7';
const OTP_TPL = '1107000000000000999';
const BULK_TPL = '1107000000000000111';
const GOT = [];
let MODE = 'ok';
const mock = http.createServer((req, res) => {
  GOT.push({ method: req.method, url: req.url });
  if (MODE === 'ok') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ackid: `AK${GOT.length}`, msgid: [`OTP${GOT.length}X,9000000000`] } })); return; }
  if (MODE === 'err') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Error: { ErrorCode: '011', ErrorDesc: 'Invalid Mobile Number' } })); return; }
  res.end('OK'); // an answer with no id
});

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
};

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.TL_DEV_MESSAGING_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

  const prisma = require(path.join(BACK, 'src/db'));
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const store = require(path.join(BACK, 'src/utils/integrationStore'));
  const { SMS_FIELDS: F } = require(path.join(BACK, 'src/utils/adminCatalog'));
  const express = require(path.join(BACK, 'node_modules/express'));

  // the person: a real employee row of the COPY (a ZZTEST name is refused by the SMS layer outside the sandbox); put back at the end
  const emp = await prisma.employee.findFirst({ where: { userId: { not: null }, employmentStatus: 'Active', NOT: { name: { contains: 'ZZTEST' } } } });
  const user = await prisma.user.findUnique({ where: { id: emp.userId } });
  const empBefore = { ...emp };
  const smsBefore = await prisma.integration.findUnique({ where: { id: 'sms' } });
  const proofBefore = await prisma.appSetting.findMany({ where: { key: { in: ['smsgw.accepted', 'smsgw.dlrSeen'] } } });
  const token = jwt.sign(tokenPayload(await resolveIdentity(user.id)), process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/employees', require(path.join(BACK, 'src/routes/employees')));
  app.use((err, req, res, next) => { res.status(500).json({ error: 'Something went wrong', why: err.message }); }); // eslint-disable-line no-unused-vars
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const API = `http://127.0.0.1:${srv.address().port}/api/employees`;
  const call = async (method, p, body) => {
    const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.2.3' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: json || {} };
  };
  const logs = [];
  const info = console.info;
  console.info = (...a) => { logs.push(a.join(' ')); };
  // the Configure form's save: writeValues works the values out, the route stores them
  const save = async (incoming) => { const w = await store.writeValues('sms', incoming); await prisma.integration.update({ where: { id: 'sms' }, data: { values: JSON.stringify(w.values) } }); };
  // a request line for a FAIL detail, the login blanked out
  const shown = (u) => String(u || '').replace(/(username|password)=[^&]*/g, '$1=***');
  const pending = async () => (await prisma.employee.findUnique({ where: { id: emp.id } })).verifyOtpHash;
  const noCooldown = () => prisma.employee.update({ where: { id: emp.id }, data: { verifyOtpExpiresAt: new Date(Date.now() - 60000) } });
  const prove = async (on) => {
    await prisma.appSetting.deleteMany({ where: { key: { in: ['smsgw.accepted', 'smsgw.dlrSeen'] } } });
    if (on) {
      await prisma.appSetting.create({ data: { key: 'smsgw.accepted', value: JSON.stringify({ at: new Date().toISOString(), ref: 'T1' }) } });
      await prisma.appSetting.create({ data: { key: 'smsgw.dlrSeen', value: JSON.stringify({ at: new Date().toISOString() }) } });
    }
  };
  const MOBILE = '9000000000';

  try {
    // the SMS Push Platform settings, saved the way the Integrations form saves them (Provider box left at MSG91, as seen live)
    await save({
      [F.provider]: 'MSG91', [F.pushUser]: USER, [F.pushPass]: PASS, [F.pushSender]: 'TMLINK', [F.pushPe]: '1201160000000000001',
      [F.pushBulkTpl]: BULK_TPL, [F.pushOtpTpl]: '', [F.pushOtpText]: '',
    });
    await prisma.integration.update({ where: { id: 'sms' }, data: { enabled: true, connected: true, state: 'Connected' } });
    await prove(false);

    // A. the Test SMS path (Administration -> Integrations -> SMS Gateway, proving: true) uses these settings
    const sms = require(path.join(BACK, 'src/utils/smsGateway'));
    const t = await sms.sendSms({ to: MOBILE, kind: 'bulk', text: 'TeamLink test', vars: ['TeamLink test'], proving: true });
    check('A1 Test SMS goes to SMS Push Platform with the Bulk template (the same saved settings)', t.ok && t.provider === 'SMSGW' && GOT.length === 1 && GOT[0].url.includes(`template_id=${BULK_TPL}`), [t, GOT.map((g) => shown(g.url))]);

    // B. My Profile
    const me = await call('GET', '/me');
    const ch = me.body.channels && me.body.channels.sms;
    check('B1 My Profile no longer says "No SMS gateway is configured" when SMS Push Platform is connected', ch && ch.configured && !/No SMS gateway/i.test(ch.reason || ''), ch);
    check('B2 with no OTP DLT Template ID it says exactly which field to fill', ch && !ch.deliverable && /OTP DLT Template ID/.test(ch.reason) && /SMS Push Platform: DLT Template ID — OTP/.test(ch.reason), ch);
    let r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    check('B3 "Send the code" without the OTP template: 409 with that reason (not "Something went wrong"), nothing sent, no code made', r.status === 409 && /OTP DLT Template ID/.test(r.body.error) && GOT.length === 1 && !(await pending()), r);

    await save({ [F.pushOtpTpl]: OTP_TPL, [F.pushOtpText]: 'Your TeamLink OTP is {code}. Valid for {minutes} minutes.' });
    r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    check('B4 Test SMS accepted but no delivery report yet (gateway not proven): refused in plain words, nothing more sent, no code left', r.status === 409 && /no delivery report/i.test(r.body.error) && GOT.length === 1 && !(await pending()), r);

    await prove(true);
    r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    const sent = GOT[GOT.length - 1];
    const q = sent ? new URL(sent.url, 'http://x').searchParams : new URLSearchParams();
    const code = (/OTP is (\d{6})\./.exec(q.get('text') || '') || [])[1];
    check('B5 the code reaches the provider: 200 delivered, ref returned', r.status === 200 && r.body.delivered === true && /^V/.test(r.body.ref || '') && GOT.length === 2, r);
    check('B6 it goes with the OTP DLT template, sender, PE id and the approved text', q.get('template_id') === OTP_TPL && q.get('from') === 'TMLINK' && q.get('pe_id') === '1201160000000000001' && !!code && q.get('text') === `Your TeamLink OTP is ${code}. Valid for 10 minutes.`, sent && shown(sent.url));
    check('B7 the code is never in the answer to the browser', !JSON.stringify(r.body).includes(code), r.body);
    r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    check('B8 a second press within a minute: 429, no second SMS', r.status === 429 && GOT.length === 2, r);
    r = await call('POST', '/me/verify/confirm', { otp: code });
    const after = await prisma.employee.findUnique({ where: { id: emp.id } });
    check('B9 the code from the SMS verifies the mobile', r.status === 200 && r.body.verified === true && !!after.mobileVerifiedAt && after.phone === MOBILE, r);

    // C. the provider refuses / answers without an id: never "sent", no code left outstanding
    MODE = 'err';
    r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    check('C1 provider refusal: 502 with the provider\'s reason (code 011), no code left', r.status === 502 && /refused it \(code 011\)/.test(r.body.error) && /^V/.test(r.body.ref || '') && !(await pending()), r);
    MODE = 'unknown';
    await noCooldown();
    r = await call('POST', '/me/verify/start', { kind: 'MOBILE', mobile: MOBILE });
    check('C2 an answer with no message id is NOT counted as sent', r.status === 502 && /NOT counted as sent/.test(r.body.error) && !(await pending()), r);

    // D. channel switched off
    await prisma.integration.update({ where: { id: 'sms' }, data: { enabled: false } });
    const me2 = await call('GET', '/me');
    check('D1 switched off: My Profile says so and where to fix it', /switched off/i.test(me2.body.channels.sms.reason) && /Integrations → SMS Gateway/.test(me2.body.channels.sms.reason), me2.body.channels.sms);

    // E. safe log
    const all = logs.join('\n');
    check('E1 the log has the correlation ref, config lookup and provider outcome', /\[verify-otp V\w+\] config sms/.test(all) && /outcome=Sent providerRef=/.test(all) && /outcome=Failed/.test(all), all);
    check('E2 the log never has the code, the full number, the username or the password', !all.includes(code) && !all.includes(MOBILE) && !all.includes(USER) && !all.includes(PASS), all);
  } finally {
    console.info = info;
    await prisma.employee.update({
      where: { id: emp.id },
      data: {
        phone: empBefore.phone, mobileVerified: empBefore.mobileVerified, mobileVerifiedAt: empBefore.mobileVerifiedAt, verifyKind: empBefore.verifyKind, verifyTarget: empBefore.verifyTarget,
        verifyLast4: empBefore.verifyLast4, verifyOtpHash: empBefore.verifyOtpHash, verifyOtpExpiresAt: empBefore.verifyOtpExpiresAt, verifyOtpAttempts: empBefore.verifyOtpAttempts,
      },
    });
    if (smsBefore) {
      await prisma.integration.update({ where: { id: 'sms' }, data: { values: smsBefore.values, enabled: smsBefore.enabled, connected: smsBefore.connected, state: smsBefore.state } });
    }
    await prisma.appSetting.deleteMany({ where: { key: { in: ['smsgw.accepted', 'smsgw.dlrSeen'] } } });
    for (const p of proofBefore) await prisma.appSetting.create({ data: { key: p.key, value: p.value } }); // eslint-disable-line no-await-in-loop
    srv.close(); mock.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
