#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CANDIDATE LOGIN BY RCS (utils/rcsCandidateLogin.js, routes/rcs.js /candidate-login*, routes/jobPortalBridge.js /rcs-login).
// SANDBOX ONLY. rcssms.in is a local stub on 127.0.0.1; nothing real is ever called. Every row made is ZZTEST and removed at the end.
//
// Start the sandbox API with the stub's address (the server reads these from its environment):
//   cd backend
//   RCS_BASE_URL=http://127.0.0.1:47321 TEST_MOCK_PORTS=47321 RCS_USERNAME=zzrcsuser RCS_PASSWORD=zz-rcs-pass-7 RCS_ID=230 RCS_SEND_APITYPE=1 \
//   RCS_WEBHOOK_SECRET=zz-hook-secret RCS_CHUNK_DELAY_MS=0 JOB_PORTAL_PUSH_SECRET=zz-bridge-secret INTEGRATION_SECRET_KEY=zz-integration-key-for-tests \
//   npm run sandbox -- --port=4031 --restart --detach --no-watch
//   TL_API=http://localhost:4031 node scripts/rcs-candidate-login-test.js
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');
const Z = require('./lib/zzfix')('RCSLOGIN');

const PORT = Number(process.env.RCS_LOGIN_STUB_PORT) || 47321;
const ENV = {
  RCS_BASE_URL: `http://127.0.0.1:${PORT}`, RCS_USERNAME: 'zzrcsuser', RCS_PASSWORD: 'zz-rcs-pass-7', RCS_ID: '230', RCS_SEND_APITYPE: '1', RCS_AUTH_MODE: 'password',
  RCS_WEBHOOK_SECRET: 'zz-hook-secret', RCS_CHUNK_DELAY_MS: '0', JOB_PORTAL_PUSH_SECRET: 'zz-bridge-secret', INTEGRATION_SECRET_KEY: 'zz-integration-key-for-tests', TEST_MOCK_PORTS: String(PORT),
};
const BRIDGE = ENV.JOB_PORTAL_PUSH_SECRET;
const GOT = [];
let MODE = 'ok';
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    GOT.push({ url: req.url, body });
    const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/rcsapi/rcscreatetemplate.jsp')) return json({ status: 'PENDING', templateid: `ZZLOGTPL${GOT.length}` });
    if (MODE === '503') return json({ message: 'busy' }, 503);
    if (MODE.startsWith('err:')) return json({ Error: { ErrorCode: MODE.slice(4), ErrorDesc: 'Incorrect Username Password' } });
    const list = String((body && body.msisdn) || '').split(',').filter(Boolean);
    return json({ data: list.map((n, i) => ({ msgid: `ZZLM${GOT.length}x${i}`, msisdn: `+${n}` })) });
  });
});
const sends = (from) => GOT.slice(from).filter((g) => /jsonapi\.jsp/.test(g.url));
const NUM = ['9876500001', '9876500002', '9876500003', '9876500004', '9876500005'];
const MSISDN = NUM.map((n) => `91${n}`);
const PASSWORDS = ['Tmp-ZZ-1a', 'Tmp-ZZ-2b', 'Tmp-ZZ-3c', 'Tmp-ZZ-4d', 'Tmp-ZZ-5e', 'Tmp-ZZ-6f', 'Tmp-ZZ-7g', 'Tmp-ZZ-8h'];
const LINK = 'https://teamlink.teamlinks.in/jobs/#/login/candidate';
const SEEN_TEXT = []; // every API answer, to prove no password is ever handed back

(async () => {
  const { prisma } = Z;
  Object.assign(process.env, ENV);
  await new Promise((r) => stub.listen(PORT, '127.0.0.1', r));
  const call = async (...a) => { const r = await Z.call(...a); SEEN_TEXT.push(r.text); return r; };
  const portal = (to, vars) => call('POST', '/api/public/job-portal/rcs-login', null, { to, vars }, { 'x-job-portal-secret': BRIDGE });
  const v = (n, pw, extra = {}) => ({ candidate_name: 'ZZTEST RCSLOGIN Ravi Kumar', login_email: n, temporary_password: pw, portal_link: LINK, ...extra });
  const KEYS = ['rcs.candidateLogin'];
  const saved = await prisma.appSetting.findMany({ where: { key: { in: KEYS } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
  const made = { tpl: [] };
  try {
    await Z.preclean();
    await prisma.rcsMessageLog.deleteMany({ where: { msisdn: { in: MSISDN } } });
    const sup = await Z.mkUser('sup', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', hrmsAccess: true, atsAccess: true, accountsAccess: true });
    const rec = await Z.mkUser('rec', { role: 'RECRUITER', atsRole: 'RECRUITER' });
    const ST = await Z.mint(sup); const RT = await Z.mint(rec);
    const cand = await prisma.candidate.create({ data: { name: 'ZZTEST RCSLOGIN Ravi Kumar', phone: `+91 ${NUM[0]}` } });
    const dnc = await prisma.candidate.create({ data: { name: 'ZZTEST RCSLOGIN No Contact', phone: NUM[3], doNotContact: true } });
    const ni = await prisma.candidate.create({ data: { name: 'ZZTEST RCSLOGIN Not Interested', phone: NUM[4], interestStatus: 'NOT_INTERESTED' } });
    Z.made.cands.push(cand.id, dnc.id, ni.id);
    const code = `CAN-${cand.id.slice(-8).toUpperCase()}`;

    // ---- the door from the portal ----
    let g0 = GOT.length;
    let r = await call('POST', '/api/public/job-portal/rcs-login', null, { to: NUM[0], vars: v(NUM[0], PASSWORDS[0]) }, { 'x-job-portal-secret': 'wrong' });
    Z.check('C1 the portal door needs the bridge secret (401, nothing sent)', r.status === 401 && sends(g0).length === 0, [r.status, r.body]);
    r = await portal(NUM[0], v(NUM[0], PASSWORDS[0]));
    const st0 = await call('GET', '/api/rcs/candidate-login', ST);
    Z.check('C2 no template chosen yet: NOT sent, the reason is kept for the Admin (one line + count), nothing reaches rcssms.in',
      r.status === 200 && !r.body.ok && r.body.status === 'skipped' && /No RCS template/.test(r.body.reason) && sends(g0).length === 0 && st0.body.skipped && /No RCS template/.test(st0.body.skipped.reason) && !st0.body.ready, [r.body, st0.body.skipped]);

    // ---- the template ----
    const carousel = await prisma.rcsTemplate.create({ data: { templateId: 'ZZLOGCAR', name: 'ZZTEST RCSLOGIN carousel', rcsType: 'RICHCASOUREL', bodyJson: '{}', status: 'APPROVED' } });
    const tpl = await prisma.rcsTemplate.create({ data: { templateId: 'ZZLOGIN1', name: 'ZZTEST RCSLOGIN login', rcsType: 'BASIC', bodyJson: JSON.stringify({ description: 'Hi {#var1#} {#var2#} {#var3#} {#var4#} {#var5#}', varCount: 5 }), status: 'PENDING', module: 'ATS' } });
    made.tpl.push(carousel.id, tpl.id);
    r = await call('PUT', '/api/rcs/candidate-login', ST, { templateId: carousel.id });
    const r2 = await call('PUT', '/api/rcs/candidate-login', ST, { map: { candidate_name: 'var1', login_id: 'var2' } });
    const r3 = await call('PUT', '/api/rcs/candidate-login', RT, { templateId: tpl.id });
    Z.check('C3 a carousel is refused, the map needs Login ID + Temporary password, only an Admin changes it', r.status === 400 && r2.status === 400 && /Temporary password/.test(r2.body.error) && r3.status === 403, [r.status, r2.status, r3.status]);
    r = await call('PUT', '/api/rcs/candidate-login', ST, { on: true, templateId: tpl.id });
    g0 = GOT.length;
    const w = await portal(NUM[0], v(NUM[0], PASSWORDS[0]));
    Z.check('C4 the template is still waiting for approval: the screen says so, the login is NOT sent', r.status === 200 && /waiting for rcssms.in approval/.test(r.body.blocker) && !r.body.ready && w.body.status === 'skipped' && /waiting/.test(w.body.reason) && sends(g0).length === 0, [r.body.blocker, w.body]);

    await prisma.rcsTemplate.update({ where: { id: tpl.id }, data: { status: 'APPROVED' } });
    g0 = GOT.length;
    r = await portal(NUM[0], v(NUM[0], PASSWORDS[0]));
    const s1 = sends(g0)[0];
    Z.check('C5 approved: the login is SENT right away - the approved template id, the number, var1..var5 = name, Candidate ID, login, temporary password, link',
      r.body.ok && r.body.status === 'sent' && /^ZZLM/.test(r.body.msgId) && sends(g0).length === 1 && s1.body.templateid === 'ZZLOGIN1' && s1.body.msisdn === MSISDN[0]
      && JSON.stringify(s1.body.variables) === JSON.stringify([{ var1: 'ZZTEST', var2: code, var3: NUM[0], var4: PASSWORDS[0], var5: LINK }]), [r.body, s1 && s1.body.variables]);
    const row1 = await prisma.rcsMessageLog.findUnique({ where: { id: r.body.logId } });
    const seal1 = await prisma.appSetting.findUnique({ where: { key: `rcs.loginSeal.${row1.id}` } });
    const secrets = require(path.join(Z.BACK, 'src/utils/secrets'));
    const anyPlain = await prisma.appSetting.findMany({ where: { value: { contains: PASSWORDS[0] } } });
    const logsPlain = await prisma.rcsMessageLog.count({ where: { OR: [{ variablesJson: { contains: PASSWORDS[0] } }, { requestRef: { contains: PASSWORDS[0] } }, { errorText: { contains: PASSWORDS[0] } }] } });
    Z.check('C6 the history row: ATS, the candidate, Sent with the msgid; the password is dots in the row and only ENCRYPTED in the seal (never plain text anywhere)',
      row1.module === 'ATS' && row1.entityId === cand.id && row1.status === 'sent' && row1.msgId === r.body.msgId && row1.requestRef.startsWith('login:') && row1.variablesJson.includes('••••••')
      && !!seal1 && secrets.isEncrypted(JSON.parse(seal1.value).sealed) && !seal1.value.includes(PASSWORDS[0]) && anyPlain.length === 0 && logsPlain === 0 && row1.fallbackStatus === 'skipped', { row1: { ...row1, variablesJson: row1.variablesJson }, seal: !!seal1, anyPlain: anyPlain.length });

    g0 = GOT.length;
    r = await portal(NUM[0], v(NUM[0], PASSWORDS[0]));
    const n1 = await prisma.rcsMessageLog.count({ where: { msisdn: MSISDN[0] } });
    Z.check('C7 the same account event again: "duplicate", NOT sent twice, still one row', r.body.status === 'duplicate' && sends(g0).length === 0 && n1 === 1, [r.body, n1]);

    // delivery report + the seal goes
    let wh = await call('POST', `/api/webhooks/rcs?token=${ENV.RCS_WEBHOOK_SECRET}`, null, { msgid: row1.msgId, status: 'DELIVERED' });
    const L = require(path.join(Z.BACK, 'src/utils/rcsCandidateLogin'));
    await L.sweep();
    const row1b = await prisma.rcsMessageLog.findUnique({ where: { id: row1.id } });
    const seal1b = await prisma.appSetting.findUnique({ where: { key: `rcs.loginSeal.${row1.id}` } });
    let hist = await call('GET', '/api/rcs/candidate-login/history', ST);
    const h1 = hist.body.rows.find((x) => x.id === row1.id);
    Z.check('C8 rcssms.in\'s report -> Delivered (history shows it, with the Candidate ID); the encrypted password is removed once delivered',
      wh.status === 200 && row1b.status === 'delivered' && !!row1b.deliveredAt && !seal1b && h1 && h1.status === 'Delivered' && h1.candidateId === code && h1.number === 'xxxxxx0001' && !h1.canRetry, [row1b.status, !!seal1b, h1]);

    // ---- a failure, and Retry with the SAME password ----
    MODE = 'err:022';
    r = await portal(NUM[1], v(NUM[1], PASSWORDS[1], { candidate_name: '' }));
    MODE = 'ok';
    hist = await call('GET', '/api/rcs/candidate-login/history?status=failed', ST);
    const f1 = hist.body.rows.find((x) => x.id === r.body.logId);
    Z.check('C9 rcssms.in refused it: Failed with its reason and code; Retry is offered (password still kept, encrypted)',
      r.body.status === 'failed' && f1 && f1.status === 'Failed' && f1.errorCode === '22' && /login|password|username/i.test(f1.error) && f1.canRetry && f1.candidateId === null, [r.body, f1]);
    const rr = await call('POST', `/api/rcs/candidate-login/${f1.id}/retry`, RT);
    g0 = GOT.length;
    const ok2 = await call('POST', `/api/rcs/candidate-login/${f1.id}/retry`, ST);
    const s2 = sends(g0)[0];
    const row2 = await prisma.rcsMessageLog.findUnique({ where: { id: f1.id } });
    Z.check('C10 Retry: someone not allowed to send RCS gets 403; the Admin\'s Retry sends the SAME password again and the row becomes Sent (2 tries)',
      rr.status === 403 && ok2.status === 200 && ok2.body.ok && s2 && s2.body.variables[0].var4 === PASSWORDS[1] && s2.body.variables[0].var1 === 'Candidate' && row2.status === 'sent' && row2.attempts === 2, [rr.status, ok2.body, s2 && s2.body.variables, row2.status, row2.attempts]);
    const again = await call('POST', `/api/rcs/candidate-login/${f1.id}/retry`, ST);
    Z.check('C11 Retry of a message that is not Failed: refused (409)', again.status === 409, [again.status, again.body]);

    // a newer login makes the older password useless
    MODE = 'err:022';
    const old = await portal(NUM[2], v(NUM[2], PASSWORDS[2]));
    MODE = 'ok';
    const newer = await portal(NUM[2], v(NUM[2], PASSWORDS[3]));
    g0 = GOT.length;
    const stale = await call('POST', `/api/rcs/candidate-login/${old.body.logId}/retry`, ST);
    Z.check('C12 a newer login was sent to that number: Retry of the older one is refused (its password no longer works), nothing sent',
      old.body.status === 'failed' && newer.body.status === 'sent' && stale.status === 409 && /newer login/.test(stale.body.error) && sends(g0).length === 0, [old.body.status, newer.body.status, stale.body]);

    // ---- rcssms.in could not be reached: tried again by itself ----
    MODE = '503';
    const busy = await portal(NUM[1], v(NUM[1], PASSWORDS[4]));
    MODE = 'ok';
    const sealB = JSON.parse((await prisma.appSetting.findUnique({ where: { key: `rcs.loginSeal.${busy.body.logId}` } })).value);
    await prisma.rcsMessageLog.update({ where: { id: busy.body.logId }, data: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });
    g0 = GOT.length;
    const sw = await L.sweep();
    const rowB = await prisma.rcsMessageLog.findUnique({ where: { id: busy.body.logId } });
    Z.check('C13 rcssms.in busy (HTTP 503): Failed, marked for the automatic retry; the 10-minute pass sends it (same password) -> Sent',
      busy.body.status === 'failed' && sealB.auto === true && sw.retried >= 1 && rowB.status === 'sent' && sends(g0).some((s) => s.body.variables[0].var4 === PASSWORDS[4]), [busy.body, sealB.auto, sw, rowB.status]);

    // ---- never-contact rules + the switch ----
    g0 = GOT.length;
    const d1 = await portal(NUM[3], v(NUM[3], PASSWORDS[5]));
    const d2 = await portal(NUM[4], v(NUM[4], PASSWORDS[6]));
    Z.check('C14 do-not-contact and Not Interested candidates never get the RCS login', d1.body.status === 'skipped' && /not to be contacted/.test(d1.body.reason) && d2.body.status === 'skipped' && /Not Interested/.test(d2.body.reason) && sends(g0).length === 0, [d1.body, d2.body]);
    await call('PUT', '/api/rcs/candidate-login', ST, { on: false });
    g0 = GOT.length;
    const off = await portal(NUM[1], v(NUM[1], PASSWORDS[7]));
    await call('PUT', '/api/rcs/candidate-login', ST, { on: true });
    const msg = await portal(NUM[1], { candidate_name: 'x', portal_link: LINK, login_email: '', temporary_password: '' });
    Z.check('C15 switched off: not sent; a message without a password is not a login', off.body.status === 'off' && msg.body.status === 'skipped' && sends(g0).length === 0, [off.body, msg.body]);

    // ---- Resend new login: permissions, and in the sandbox the portal is never reached ----
    const rs1 = await call('POST', `/api/rcs/candidate-login/${row1.id}/resend`, RT);
    const rs2 = await call('POST', `/api/rcs/candidate-login/${row1.id}/resend`, ST);
    const hr = await call('GET', '/api/rcs/candidate-login/history', RT);
    Z.check('C16 Resend new login: 403 for someone not allowed to send RCS (history too); the Admin\'s goes to the Job Portal (in the sandbox it honestly says the portal was not reached)',
      rs1.status === 403 && hr.status === 403 && rs2.status === 422 && /Job Portal could not be reached/.test(rs2.body.error), [rs1.status, hr.status, rs2.status, rs2.body]);
    await call('PUT', '/api/rcs/settings', ST, { allowedUserIds: [rec.id] });
    const hr2 = await call('GET', '/api/rcs/candidate-login/history', RT);
    const st2 = await call('GET', '/api/rcs/candidate-login', RT);
    Z.check('C17 a person an Admin ticked may see the history, but not change the settings', hr2.status === 200 && st2.status === 403, [hr2.status, st2.status]);
    await call('PUT', '/api/rcs/settings', ST, { allowedUserIds: [] });

    // ---- the ready-made template ----
    g0 = GOT.length;
    r = await call('POST', '/api/rcs/candidate-login/template', ST);
    const made1 = GOT.slice(g0).find((g) => g.url.startsWith('/rcsapi/rcscreatetemplate.jsp'));
    if (r.body && r.body.template) made.tpl.push(r.body.template.id);
    Z.check('C18 "Send the ready template": a BASIC template with {#var1#}..{#var5#} goes to rcssms.in, is saved WAITING and chosen for the login (nothing sent until approved)',
      r.status === 201 && made1 && made1.body.rcstype === 'BASIC' && ['{#var1#}', '{#var2#}', '{#var3#}', '{#var4#}', '{#var5#}'].every((x) => made1.body.description.includes(x))
      && r.body.template.status === 'PENDING' && /waiting/.test(r.body.blocker), [r.status, r.body && r.body.blocker, made1 && made1.body.description]);

    const leaked = SEEN_TEXT.filter((t) => PASSWORDS.some((p) => String(t || '').includes(p)));
    const general = await call('GET', '/api/rcs/logs?module=ATS', ST);
    Z.check('C19 no answer of the API (history, settings, logs, retry, the portal door) ever contains a password', leaked.length === 0 && !PASSWORDS.some((p) => general.text.includes(p)), leaked.map((t) => String(t).slice(0, 120)));
  } catch (e) {
    Z.check('no crash', false, e && e.stack);
  } finally {
    const ids = (await prisma.rcsMessageLog.findMany({ where: { msisdn: { in: MSISDN } }, select: { id: true } })).map((x) => x.id);
    await prisma.appSetting.deleteMany({ where: { key: { in: ids.map((id) => `rcs.loginSeal.${id}`) } } });
    await prisma.rcsMessageLog.deleteMany({ where: { id: { in: ids } } });
    await prisma.rcsTemplate.deleteMany({ where: { OR: [{ id: { in: made.tpl } }, { name: { contains: 'ZZTEST RCSLOGIN' } }, { templateId: { startsWith: 'ZZLOGTPL' } }] } });
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
    for (const s of saved) await prisma.appSetting.create({ data: s }); // eslint-disable-line no-await-in-loop
    await prisma.auditLog.deleteMany({ where: { actorName: { contains: 'ZZTEST RCSLOGIN' } } }).catch(() => {});
    const left = await Z.cleanup();
    const rest = await prisma.rcsMessageLog.count({ where: { msisdn: { in: MSISDN } } });
    Z.check('cleanup: every ZZTEST row is gone', (!left || !Object.values(left).some((n) => n > 0)) && rest === 0, { left, rest });
    stub.close();
    await Z.finish();
  }
})();
