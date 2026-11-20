#!/usr/bin/env node
/**
 * SCHEDULE A MESSAGE (founder 2026-11-20: "there must be an option to schedule ANY kind of message ... on the candidate's profile give a 'Schedule a message' tab").
 * A recruiter / team lead writes any message to one candidate and schedules it (WhatsApp / SMS / Email), sees scheduled / sent / failed / cancelled ones,
 * edits or cancels a waiting one. SANDBOX ONLY: a private server on a COPY of the sandbox database; nothing real is sent; the in-process worker gets a simulated clock.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4333 node scripts/sched-msg-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-schedmsg-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4333);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'schedmsg-test', INTEGRATION_SECRET_KEY: 'zz-schedmsg-test-integration-key', TL_COMM_SEND_LIMIT: '500',
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const CAT = require('../src/utils/adminCatalog');
const SR = require('../src/utils/scheduledReminders');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;
const istDay = (d) => new Date(new Date(d).getTime() + 330 * MIN).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const atIst = (day, hm) => new Date(`${day}T${hm}:00+05:30`);
const hm = (d) => new Date(new Date(d).getTime() + 330 * MIN).toISOString().slice(11, 16);
const ymdhm = (d) => `${istDay(d)} ${hm(d)}`;
const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const rowOf = async (id) => (await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', id))[0];
const bellsOf = (userId, like) => prisma.notification.findMany({ where: { userId, title: { contains: like } } });
const tomorrow = (h) => atIst(addDays(istDay(new Date()), 1), h).toISOString(); // always at least a few hours ahead
const inDays = (n, h) => atIst(addDays(istDay(new Date()), n), h).toISOString();
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sm ${tag} ${P}`, email: `sm.${tag}.${P}@sm-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const RECX = await mk('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' });
  const MGR = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const CLU = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT', atsAccess: true });
  const client = await prisma.client.create({ data: { name: `Sm Hospital ${P}`, location: 'Hyderabad', ownerDepartment: 'Medical', bdeOwner: BDE.name, clientType: 'Client' } });
  const REQ = await prisma.requirement.create({ data: { title: `Sm Staff Nurse ${P}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, openings: 3, skills: 'Nursing', experience: '2-5', location: 'Hyderabad', salary: '4L - 6L CTC', jobDescription: 'Nurses needed.' } });
  const clientM = await prisma.client.create({ data: { name: `Sm Factory ${P}`, location: 'Pune', ownerDepartment: 'Manufacturing', bdeOwner: BDE.name, clientType: 'Client' } });
  const REQM = await prisma.requirement.create({ data: { title: `Sm Fitter ${P}`, clientId: clientM.id, status: 'OPEN', department: 'Manufacturing', recruiterId: RECX.id, openings: 2, skills: 'Fitter', experience: '1-3', location: 'Pune', salary: '2L - 3L CTC', jobDescription: 'Fitters needed.' } });
  let seq = 0;
  const mkCand = (tag, data = {}) => { seq += 1; return prisma.candidate.create({ data: { name: `Sm ${tag} ${P}`, phone: `91${String(P % 100).padStart(2, '0')}${String(100000 + seq * 7).padStart(6, '0')}`.slice(0, 10), email: `sm.${tag}.${P}@sm-cand.in`, ...data } }); };
  const mkApp = (cand, req, data = {}) => prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: REC.id, offeredCtc: 450000, ...data } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = { A: await tok(adminRow.id), B: await tok(BDE.id), T: await tok(TL.id), R: await tok(REC.id), R2: await tok(REC2.id), X: await tok(RECX.id), M: await tok(MGR.id), C: await tok(CLU.id) };

  await setRow('email', { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'hr@zz-test.invalid', 'Default from name': 'TeamLink' });
  await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.display]: '+91 90000 00001', [CAT.WA_FIELDS.bulkTpl]: 'zz_general' });
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });
  await new Promise((r) => { setTimeout(r, 500); });

  const C1 = await mkCand('c1'); const A1 = await mkApp(C1, REQ);
  const base = (over = {}) => ({ channel: 'WhatsApp', sendAt: tomorrow('10:00'), body: 'Hi {name}, please call me back. - {recruiter}', ...over });
  const post = (cid, body, tk = T.R) => call('POST', `/ats/reminders/messages/candidate/${cid}`, body, tk);
  const get = (cid, tk = T.R, qs = '') => call('GET', `/ats/reminders/messages/candidate/${cid}${qs}`, null, tk);

  // ---------------------------------------------------------------- 1. create, list
  console.log('1. Scheduling a message and seeing it');
  const c1 = await post(C1.id, base({ applicationId: A1.id }));
  const row1 = c1.body && c1.body.message;
  check('the recruiter schedules a WhatsApp message for tomorrow 10:00: created, status planned, kind custom, words and time kept', c1.status === 201 && row1 && row1.status === 'planned' && row1.channel === 'WhatsApp' && ymdhm(row1.sendAt) === `${addDays(istDay(new Date()), 1)} 10:00` && /call me back/.test(row1.body), c1);
  const db1 = await rowOf(row1.id);
  check('it is a row of the same table as the automatic reminders (kind custom), with who made it and a history line', db1.kind === 'custom' && db1.createdById === REC.id && /Scheduled for/.test(db1.history) && db1.candidateId === C1.id && db1.applicationId === A1.id, db1);
  const aud = await prisma.auditLog.findMany({ where: { entity: 'Candidate', entityId: C1.id, action: 'Message scheduled to candidate' } });
  check('creating it is audited', aud.length === 1 && aud[0].userId === REC.id, aud.length);
  const l1 = await get(C1.id);
  check('the list shows it (full access, can create), with channels, templates, placeholders, hours and limits', l1.status === 200 && l1.body.access === 'full' && l1.body.canCreate === true && l1.body.messages.length === 1 && l1.body.counts.planned === 1 && l1.body.templates.length === 4
    && l1.body.placeholders.map((p) => p.key).join() === 'name,recruiter,company,requirement,client' && l1.body.hours.earliest === 7 && l1.body.hours.latest === 20 && l1.body.max === 20 && l1.body.maxLength === 1000
    && l1.body.channels.every((c) => c.offered) && l1.body.context.name === 'Sm' && l1.body.context.client === 'our client' && l1.body.context.requirement === REQ.title, l1.body);
  check('the 4 ready templates are follow-up call-back, document request, interview details, thank you', l1.body.templates.map((t) => t.key).join() === 'callback,documents,interview,thanks');
  const mail = await post(C1.id, base({ channel: 'Email', subject: 'Documents for {requirement}', body: 'Hello {name}, please send your documents. {recruiter}', sendAt: tomorrow('11:30') }));
  check('an email with its own subject is accepted (subject kept; a blank subject gets a default)', mail.status === 201 && mail.body.message.subject === 'Documents for {requirement}'
    && (await post(C1.id, base({ channel: 'Email', body: 'Second mail', sendAt: tomorrow('12:00') }))).body.message.subject === 'A message from TeamLink');
  const sms = await post(C1.id, base({ channel: 'SMS', body: 'Short SMS for {name}', sendAt: tomorrow('12:30') }));
  check('an SMS is accepted', sms.status === 201, sms.body);

  // ---------------------------------------------------------------- 2. refusals
  console.log('2. What is refused, and why');
  const refuse = async (name, body, status, re, extra = {}) => {
    const r = await post(extra.cid || C1.id, body, extra.tk);
    check(name, r.status === status && re.test((r.body && r.body.error) || ''), [r.status, r.body]);
    return r;
  };
  await refuse('a time in the past is refused', base({ sendAt: new Date(Date.now() - HOUR).toISOString() }), 400, /at least 5 minutes/);
  await refuse('a time less than 5 minutes ahead is refused', base({ sendAt: new Date(Date.now() + 2 * MIN).toISOString() }), 400, /at least 5 minutes/);
  await refuse('no time at all is refused', base({ sendAt: undefined }), 400, /date and time/);
  const early = await refuse('06:00 is refused (sending hours 07:00-20:00 India time) and the nearest allowed time is suggested', base({ sendAt: inDays(2, '06:00') }), 400, /between 07:00 and 20:00/);
  check('...the suggestion is 07:00 the same day', early.body.suggestion && ymdhm(early.body.suggestion.sendAt) === `${addDays(istDay(new Date()), 2)} 07:00`, early.body);
  const late = await refuse('21:30 is refused and the next morning 07:00 is suggested', base({ sendAt: inDays(2, '21:30') }), 400, /between 07:00 and 20:00/);
  check('...the suggestion is 07:00 the next day', late.body.suggestion && ymdhm(late.body.suggestion.sendAt) === `${addDays(istDay(new Date()), 3)} 07:00`, late.body);
  check('exactly 07:00 and exactly 20:00 are allowed', (await post(C1.id, base({ sendAt: inDays(2, '07:00'), body: 'at seven' }))).status === 201 && (await post(C1.id, base({ sendAt: inDays(2, '20:00'), body: 'at eight pm' }))).status === 201);
  await refuse('an empty message is refused', base({ body: '   ' }), 400, /Write the message/);
  await refuse('a message over 1000 characters is refused', base({ body: 'x'.repeat(1001) }), 400, /too long/);
  check('exactly 1000 characters is fine', (await post(C1.id, base({ body: 'y'.repeat(1000), sendAt: inDays(3, '09:00') }))).status === 201);
  await refuse('an unknown placeholder is refused', base({ body: 'Hi {firstname}' }), 400, /\{firstname\}/);
  await refuse('a template with an unfilled [write ...] part is refused', base({ body: 'Interview at [write date and time]' }), 400, /\[write/);
  await refuse('an unknown channel is refused', base({ channel: 'Telegram' }), 400, /WhatsApp, SMS or Email/);
  await refuse('the same message at the same time is not scheduled twice', base({ applicationId: A1.id }), 409, /already scheduled/);
  await refuse('an application that is not this candidate\'s is refused', base({ applicationId: 'nope', body: 'other app' }), 400, /application/);
  const CNoMail = await mkCand('nomail', { email: null }); await mkApp(CNoMail, REQ);
  const CNoPhone = await mkCand('nophone', { phone: null }); await mkApp(CNoPhone, REQ);
  await refuse('an email to a candidate with no email address is refused', base({ channel: 'Email' }), 409, /no email address/, { cid: CNoMail.id });
  await refuse('WhatsApp to a candidate with no mobile number is refused', base(), 409, /mobile number/, { cid: CNoPhone.id });
  await refuse('SMS to a candidate with no mobile number is refused', base({ channel: 'SMS' }), 409, /mobile number/, { cid: CNoPhone.id });
  check('an email to the candidate with no phone still works', (await post(CNoPhone.id, base({ channel: 'Email' }))).status === 201);
  const CDnc = await mkCand('dnc', { doNotContact: true }); await mkApp(CDnc, REQ);
  const CWd = await mkCand('withdrawn', { consentStatus: 'WITHDRAWN' }); await mkApp(CWd, REQ);
  await refuse('a do-not-contact candidate is refused with the reason', base(), 409, /do not contact/, { cid: CDnc.id });
  await refuse('a candidate who withdrew consent is refused', base(), 409, /withdrew consent/, { cid: CWd.id });
  const dncList = await get(CDnc.id);
  check('...and the screen says so up front (blocked)', dncList.body.blocked && /not to be contacted/.test(dncList.body.blocked), dncList.body.blocked);
  const CStop = await mkCand('stop'); await mkApp(CStop, REQ);
  const core = require('../src/utils/messagingCore');
  const e164Stop = core.normalizeMobile(CStop.phone).e164;
  await prisma.appSetting.create({ data: { key: `msg.optout.WhatsApp.${e164Stop}`, value: new Date().toISOString() } });
  await refuse('a candidate who replied STOP on WhatsApp is refused there', base(), 409, /replied STOP/, { cid: CStop.id });
  check('...but an email to the same person is still allowed', (await post(CStop.id, base({ channel: 'Email' }))).status === 201);
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' }, false);
  await new Promise((r) => { setTimeout(r, 300); });
  await refuse('a channel that is not connected is refused with the reason', base({ channel: 'SMS', body: 'sms while off' }), 409, /not connected/);
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' }, true);

  // ---------------------------------------------------------------- 3. limit of 20
  console.log('3. At most 20 waiting messages per candidate');
  const C20 = await mkCand('c20'); await mkApp(C20, REQ);
  let ok20 = 0;
  for (let i = 0; i < 20; i += 1) { // eslint-disable-line no-restricted-syntax
    const r = await post(C20.id, base({ sendAt: inDays(1 + (i % 10), `${String(8 + Math.floor(i / 10)).padStart(2, '0')}:${String((i % 10) * 5).padStart(2, '0')}`), body: `message number ${i}` })); // eslint-disable-line no-await-in-loop
    if (r.status === 201) ok20 += 1;
  }
  check('20 messages are accepted', ok20 === 20, ok20);
  await refuse('the 21st is refused with a clear message', base({ body: 'one too many', sendAt: inDays(12, '10:00') }), 409, /already 20 messages waiting/, { cid: C20.id });
  const first20 = (await q('SELECT "id" FROM "ScheduledReminder" WHERE "candidateId" = ? AND "kind" = \'custom\' ORDER BY "sendAt" LIMIT 1', C20.id))[0];
  check('after one is cancelled, a new one fits again', (await call('DELETE', `/ats/reminders/messages/${first20.id}`, null, T.R)).status === 200 && (await post(C20.id, base({ body: 'fits now', sendAt: inDays(12, '10:00') }))).status === 201);

  // ---------------------------------------------------------------- 4. edit and cancel
  console.log('4. Editing and cancelling a waiting message');
  const ed = await call('PATCH', `/ats/reminders/messages/${row1.id}`, { sendAt: tomorrow('15:00'), body: 'Hi {name}, new words. - {recruiter}' }, T.R);
  check('the time and the words of a waiting message can be changed; the history says what changed', ed.status === 200 && ymdhm(ed.body.message.sendAt) === `${addDays(istDay(new Date()), 1)} 15:00` && /new words/.test(ed.body.message.body) && ed.body.message.history.some((h) => /Time changed/.test(h.text) && /Words changed/.test(h.text)), ed);
  check('the edit is audited', (await prisma.auditLog.count({ where: { entity: 'Candidate', entityId: C1.id, action: 'Scheduled message changed' } })) === 1);
  const edBad = await call('PATCH', `/ats/reminders/messages/${row1.id}`, { sendAt: inDays(2, '22:00') }, T.R);
  check('an edit to a time outside the hours is refused with the nearest time', edBad.status === 400 && edBad.body.suggestion && /between 07:00 and 20:00/.test(edBad.body.error), edBad.body);
  check('an edit to an empty text, a past time or nothing at all is refused', (await call('PATCH', `/ats/reminders/messages/${row1.id}`, { body: '' }, T.R)).status === 400 && (await call('PATCH', `/ats/reminders/messages/${row1.id}`, { sendAt: new Date(Date.now() - HOUR).toISOString() }, T.R)).status === 400 && (await call('PATCH', `/ats/reminders/messages/${row1.id}`, {}, T.R)).status === 400);
  const edCh = await call('PATCH', `/ats/reminders/messages/${row1.id}`, { channel: 'Email', subject: 'New subject' }, T.R);
  check('the way can be changed too (WhatsApp to Email), and the subject then applies', edCh.status === 200 && edCh.body.message.channel === 'Email' && edCh.body.message.subject === 'New subject', edCh.body);
  const cx = await call('DELETE', `/ats/reminders/messages/${row1.id}`, { reason: 'Candidate already called back' }, T.R);
  const dbc = await rowOf(row1.id);
  check('cancelling: status cancelled with who and why, still in the list', cx.status === 200 && dbc.status === 'cancelled' && /Cancelled by Sm rec/.test(dbc.reason) && /already called back/.test(dbc.reason), cx.body);
  check('cancelling is audited', (await prisma.auditLog.count({ where: { entity: 'Candidate', entityId: C1.id, action: 'Scheduled message cancelled' } })) === 1);
  check('a cancelled message cannot be cancelled again or edited', (await call('DELETE', `/ats/reminders/messages/${row1.id}`, null, T.R)).status === 409 && (await call('PATCH', `/ats/reminders/messages/${row1.id}`, { body: 'x' }, T.R)).status === 409);
  const l2 = await get(C1.id);
  check('the list now shows it under cancelled', l2.body.counts.cancelled === 1 && l2.body.messages.some((m) => m.id === row1.id && m.status === 'cancelled'), l2.body.counts);

  // ---------------------------------------------------------------- 5. who may
  console.log('5. Who sees it and who may schedule');
  const own = await post(C1.id, base({ body: 'Own message for scope tests', sendAt: tomorrow('16:00') }));
  const ownId = own.body.message.id;
  check('another recruiter does not see this candidate: list 404, schedule 404', (await get(C1.id, T.R2)).status === 404 && (await post(C1.id, base({ body: 'sneaky' }), T.R2)).status === 404);
  check('another recruiter cannot edit or cancel a message of this candidate (404)', (await call('PATCH', `/ats/reminders/messages/${ownId}`, { body: 'hacked' }, T.R2)).status === 404 && (await call('DELETE', `/ats/reminders/messages/${ownId}`, null, T.R2)).status === 404 && (await rowOf(ownId)).status === 'planned');
  check('a recruiter of another department does not see it either', (await get(C1.id, T.X)).status === 404);
  const tlList = await get(C1.id, T.T);
  check('the team lead sees the team\'s messages with their words and may schedule', tlList.status === 200 && tlList.body.access === 'full' && tlList.body.messages.some((m) => m.id === ownId && /Own message/.test(m.body)) && tlList.body.canCreate === true, tlList.status);
  const tlMake = await post(C1.id, base({ body: 'Scheduled by the TL', sendAt: tomorrow('17:00') }), T.T);
  check('the TL schedules for a team candidate, and the recruiter sees it with the TL\'s name', tlMake.status === 201 && tlMake.body.message.createdBy === TL.name && (await get(C1.id)).body.messages.some((m) => m.createdBy === TL.name), tlMake.body);
  check('the TL can cancel it', (await call('DELETE', `/ats/reminders/messages/${tlMake.body.message.id}`, { reason: 'Not needed' }, T.T)).status === 200);
  check('the Manager and the Admin see the messages and may schedule', (await get(C1.id, T.M)).body.access === 'full' && (await get(C1.id, T.A)).body.access === 'full' && (await post(C1.id, base({ body: 'By the admin', sendAt: tomorrow('18:00') }), T.A)).status === 201 && (await post(C1.id, base({ body: 'By the manager', sendAt: tomorrow('18:30') }), T.M)).status === 201);
  // a BDE sees the candidate once it is with the BDE
  const CB = await mkCand('bde'); await mkApp(CB, REQ, { stage: 'WITH_BDE' });
  await post(CB.id, base({ body: 'Secret words for the recruiter', sendAt: tomorrow('09:00') }));
  const bl = await get(CB.id, T.B);
  check('the BDE sees only a COUNT: no words, no times, no list', bl.status === 200 && bl.body.access === 'count' && bl.body.counts.planned === 1 && bl.body.canCreate === false && !bl.body.messages && !JSON.stringify(bl.body).includes('Secret words'), bl);
  check('the BDE cannot schedule, edit or cancel', (await post(CB.id, base({ body: 'by bde' }), T.B)).status === 403
    && (await call('PATCH', `/ats/reminders/messages/${(await q('SELECT "id" FROM "ScheduledReminder" WHERE "candidateId" = ? AND "kind" = \'custom\'', CB.id))[0].id}`, { body: 'x' }, T.B)).status === 403
    && (await call('DELETE', `/ats/reminders/messages/${(await q('SELECT "id" FROM "ScheduledReminder" WHERE "candidateId" = ? AND "kind" = \'custom\'', CB.id))[0].id}`, null, T.B)).status === 403);
  const cl = await get(C1.id, T.C);
  check('a client login gets nothing (refused)', [401, 403].includes(cl.status) && !cl.body.messages && [401, 403].includes((await post(C1.id, base({ body: 'client' }), T.C)).status), cl);
  check('a request with no login is refused', (await get(C1.id, null)).status === 401);

  // ---------------------------------------------------------------- 6. automatic reminders in the same list
  console.log('6. The automatic reminders of the candidate show in the same place (read-only)');
  const CI = await mkCand('iv'); const AI = await mkApp(CI, REQ);
  const evDay = addDays(istDay(new Date()), 4);
  const bk = await call('POST', `/ats/interviews/${AI.id}/book`, { date: evDay, time: '12:00', mode: 'In Person', location: '5 Station Road, Hyderabad', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, T.B);
  const li = await get(CI.id);
  check('a booked interview\'s automatic reminders are listed with the label automatic, the way, the status and their words', bk.status === 200 && li.body.automatic.length >= 3 && li.body.automatic.every((a) => a.automatic === true && a.kind === 'interview' && a.channel && a.status && /Interview reminder/.test(a.label)) && /City Clinic/.test(li.body.automatic[0].text), [bk.status, li.body.automatic]);
  const lb = await get(CI.id, T.B);
  check('the BDE side sees only the number of automatic reminders', lb.body.access === 'count' && lb.body.automaticCount >= 3 && !lb.body.automatic, lb.body);

  // ---------------------------------------------------------------- 7. the worker
  console.log('7. Sending: the worker with a simulated clock');
  const seen = [];
  const messaging = require('../src/utils/messaging');
  const realSend = messaging.send;
  let failMode = null;
  messaging.send = async (channel, opts) => {
    seen.push({ channel, opts });
    if (failMode === 'transient') return { ok: false, outcome: 'Failed', transient: true, error: 'WhatsApp HTTP 503: try later' };
    if (failMode === 'hard') return { ok: false, outcome: 'Failed', transient: false, error: 'WhatsApp HTTP 400 (131026): message undeliverable' };
    if (failMode === 'credits') return { ok: false, outcome: 'Skipped', invalid: true, creditsBlocked: true, error: 'You have used all your WhatsApp credits for this month.' };
    return realSend(channel, opts);
  };
  // the messages made by the earlier sections are parked (cancelled) so each worker test below sees only its own rows
  await q("UPDATE \"ScheduledReminder\" SET \"status\" = 'cancelled', \"reason\" = 'parked by the test' WHERE \"kind\" = 'custom' AND \"status\" = 'planned'");
  const settings0 = await SR.loadSettings();
  check('the Admin switch for the automatic reminders is OFF (the default)', settings0.enabled === false);
  const CS = await mkCand('send'); const AS = await mkApp(CS, REQ);
  const sendAt = tomorrow('10:00');
  const mkMsg = async (cand, over = {}) => { const r = await post(cand.id, base({ ...over })); if (r.status !== 201) console.log('   (create failed)', r.status, r.body); return r.body.message; };
  const m1 = await mkMsg(CS, { applicationId: AS.id, body: 'Hi {name}, {recruiter} here about {requirement} at {client} ({company}).', sendAt });
  // an automatic reminder row, due at the same time: must stay untouched while the switch is OFF
  await q(`INSERT INTO "ScheduledReminder" ("id","applicationId","candidateId","kind","eventAt","sendAt","channel","templateKey","language","status","stepKey","createdAt","updatedAt")
    VALUES (?,?,?,?,?,?,?,?,?,'planned','D1@17:00',?,?)`, `rem_zz${P}`, AS.id, CS.id, 'interview', new Date(Date.parse(sendAt) + 2 * DAY).toISOString(), sendAt, 'WhatsApp', 'interview_offline', 'en', new Date().toISOString(), new Date().toISOString());
  const beforeCount = seen.length;
  const early1 = await SR.run({ now: new Date(Date.parse(sendAt) - 30 * MIN) });
  check('before its time nothing is sent', early1.sent === 0 && seen.length === beforeCount && (await rowOf(m1.id)).status === 'planned');
  const run1 = await SR.run({ now: new Date(Date.parse(sendAt) + MIN) });
  const dbS = await rowOf(m1.id);
  check('at its time, with the automatic switch OFF, the manual message IS sent (summary says off for automatic ones)', run1.off === true && run1.sent === 1 && dbS.status === 'sent' && dbS.providerRef && dbS.sentAt && dbS.deliveryStatus === 'Sent' && dbS.attempts === 1, [run1, dbS]);
  const waCall = seen.find((s) => s.channel === 'WhatsApp' && /here about/.test(s.opts.text));
  check('the placeholders are filled when it goes (first name, the recruiter, the job, "our client", TeamLink) and the STOP line is added', waCall && waCall.opts.text.startsWith(`Hi Sm, ${REC.name} here about ${REQ.title} at our client (TeamLink).`) && /Reply STOP to stop these messages\.$/.test(waCall.opts.text) && !waCall.opts.text.includes(client.name), waCall && waCall.opts.text);
  check('it goes as the CRM sends WhatsApp: outside the 24-hour window the general template with the message as its blank, credits charged to the person who scheduled it', waCall && waCall.opts.kind === 'bulk' && waCall.opts.vars[0] === waCall.opts.text && waCall.opts.actorUserId === REC.id && waCall.opts.meta.purpose === 'Scheduled message', waCall && waCall.opts);
  check('the sent text is kept on the row and the candidate\'s Communications gets a line with the provider id', dbS.message === waCall.opts.text && (await prisma.candidateMessage.count({ where: { candidateId: CS.id, template: 'SCHEDULED_MESSAGE', providerRef: dbS.providerRef } })) === 1);
  const autoRow = await rowOf(`rem_zz${P}`);
  check('the automatic reminder due at the same time stayed untouched (the switch is OFF for them)', autoRow.status === 'planned' && autoRow.attempts === 0);
  const sentN = seen.length;
  await SR.run({ now: new Date(Date.parse(sendAt) + 2 * MIN) });
  check('running the worker again sends nothing twice', seen.length === sentN);
  check('a sent message cannot be edited or cancelled any more', (await call('PATCH', `/ats/reminders/messages/${m1.id}`, { body: 'late' }, T.R)).status === 409 && (await call('DELETE', `/ats/reminders/messages/${m1.id}`, null, T.R)).status === 409);
  const dig = await bellsOf(REC.id, 'Reminders sent today');
  check('the person who scheduled it gets the day\'s digest line naming the candidate as "your message"', dig.length === 1 && /Sm send/.test(dig[0].message) && /your message/.test(dig[0].message), dig.map((d) => d.message));
  // sandbox no-op
  const sandboxRef = /sandbox/i.test(String(dbS.providerRef));
  check('on the test server the send is the sandbox no-op (provider id says sandbox) and the row is marked sent', sandboxRef || dbS.status === 'sent', dbS.providerRef);
  // email + sms paths
  const mEmail = await mkMsg(CS, { channel: 'Email', subject: 'Re {requirement}', body: 'Mail body for {name}', sendAt: tomorrow('11:00') });
  const mSms = await mkMsg(CS, { channel: 'SMS', body: 'Sms body for {name}', sendAt: tomorrow('11:10') });
  seen.length = 0;
  const runMail = await SR.run({ now: new Date(Date.parse(mSms.sendAt) + MIN) });
  const eC = seen.find((s) => s.channel === 'Email'); const sC = seen.find((s) => s.channel === 'SMS');
  check('an email goes with its subject filled (the job title) and no STOP line; an SMS goes with the STOP line', runMail.sent === 2 && eC && eC.opts.subject === `Re ${REQ.title}` && eC.opts.to === CS.email && !/STOP/.test(eC.opts.text) && sC && /Reply STOP/.test(sC.opts.text), [runMail, eC && eC.opts.subject]);
  // 24-hour window open: plain words
  const CW = await mkCand('window'); await mkApp(CW, REQ);
  await prisma.appSetting.upsert({ where: { key: `wa.window.91${CW.phone}` }, create: { key: `wa.window.91${CW.phone}`, value: new Date().toISOString() }, update: { value: new Date().toISOString() } });
  const mW = await mkMsg(CW, { body: 'Window is open', sendAt: tomorrow('13:00') });
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(mW.sendAt) + MIN) });
  const wC = seen.find((s) => s.channel === 'WhatsApp');
  check('inside the candidate\'s 24-hour window it goes as plain words (kind session, no template blank)', wC && wC.opts.kind === 'session' && !wC.opts.vars, wC && wC.opts);
  // quiet hours at send time
  const CQ = await mkCand('quiet'); await mkApp(CQ, REQ);
  const mQ = await mkMsg(CQ, { body: 'Late evening', sendAt: tomorrow('19:55') });
  seen.length = 0;
  const runQ = await SR.run({ now: new Date(Date.parse(mQ.sendAt) + 15 * MIN) }); // 20:10 India time
  check('a message that is due after 20:05 India time waits (quiet hours) and stays planned', runQ.deferred >= 1 && !seen.some((s) => /Late evening/.test(s.opts.text)) && (await rowOf(mQ.id)).status === 'planned', runQ);
  const runQ2 = await SR.run({ now: atIst(addDays(istDay(mQ.sendAt), 1), '07:30') });
  check('...and the next morning it is too late (more than 3 hours): skipped with the reason, and the person is told', (await rowOf(mQ.id)).status === 'skipped' && /Too late/.test((await rowOf(mQ.id)).reason) && (await bellsOf(REC.id, 'Scheduled message NOT sent')).length >= 1, [runQ2, await rowOf(mQ.id)]);
  // retries
  const CR = await mkCand('retry'); await mkApp(CR, REQ);
  const mR = await mkMsg(CR, { body: 'Retry me', sendAt: tomorrow('14:00') });
  let clock = Date.parse(mR.sendAt) + MIN;
  failMode = 'transient';
  await SR.run({ now: new Date(clock) });
  let dr = await rowOf(mR.id);
  check('a temporary failure: it stays planned, try 1 of 3 is noted and the next try is in 5 minutes', dr.status === 'planned' && dr.attempts === 1 && Date.parse(dr.nextAttemptAt) === clock + 5 * MIN && /Try 1 of 3/.test(dr.reason), dr);
  const nBefore = seen.length;
  await SR.run({ now: new Date(clock + MIN) });
  check('before the next try time it is not tried again', seen.length === nBefore);
  clock += 6 * MIN;
  await SR.run({ now: new Date(clock) });
  dr = await rowOf(mR.id);
  check('try 2 fails too: next in 30 minutes', dr.status === 'planned' && dr.attempts === 2 && Date.parse(dr.nextAttemptAt) === clock + 30 * MIN, dr);
  failMode = null;
  clock += 31 * MIN;
  await SR.run({ now: new Date(clock) });
  dr = await rowOf(mR.id);
  check('try 3 succeeds: sent, 3 attempts', dr.status === 'sent' && dr.attempts === 3, dr);
  // hard failure
  const CH = await mkCand('hard'); await mkApp(CH, REQ);
  const mH = await mkMsg(CH, { body: 'Will fail', sendAt: tomorrow('14:30') });
  failMode = 'hard';
  await SR.run({ now: new Date(Date.parse(mH.sendAt) + MIN) });
  const dh = await rowOf(mH.id);
  check('a hard failure: status failed with the provider\'s reason on the row, and the person who scheduled it gets a bell', dh.status === 'failed' && /undeliverable/.test(dh.reason) && (await bellsOf(REC.id, 'Scheduled message NOT sent')).some((b) => /Sm hard/.test(b.message)), dh);
  const lh = await get(CH.id);
  check('the list shows it as failed with the reason', lh.body.counts.failed === 1 && lh.body.messages[0].status === 'failed' && /undeliverable/.test(lh.body.messages[0].reason));
  check('a failed message cannot be edited (Send again schedules a new one)', (await call('PATCH', `/ats/reminders/messages/${mH.id}`, { body: 'x' }, T.R)).status === 409);
  const again = await post(CH.id, base({ body: 'Will fail', sendAt: tomorrow('15:30') }));
  check('Send again = a new scheduled message with the same words (the old failed one stays)', again.status === 201 && (await get(CH.id)).body.messages.length === 2);
  failMode = 'credits';
  const CC = await mkCand('credits'); await mkApp(CC, REQ);
  const mC = await mkMsg(CC, { body: 'No credits', sendAt: tomorrow('15:00') });
  await SR.run({ now: new Date(Date.parse(mC.sendAt) + MIN) });
  check('a person whose credits are used up: failed with the credits message', (await rowOf(mC.id)).status === 'failed' && /credits/.test((await rowOf(mC.id)).reason), await rowOf(mC.id));
  failMode = null;
  // STOP / do-not-contact AFTER scheduling
  const CL = await mkCand('later'); await mkApp(CL, REQ);
  const mL = await mkMsg(CL, { body: 'Will be opted out', sendAt: tomorrow('09:00') });
  const mL2 = await mkMsg(CL, { channel: 'Email', body: 'Will be do-not-contact', sendAt: tomorrow('09:10') });
  await prisma.appSetting.create({ data: { key: `msg.optout.WhatsApp.${core.normalizeMobile(CL.phone).e164}`, value: new Date().toISOString() } });
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(mL.sendAt) + MIN) });
  check('a candidate who replies STOP after scheduling is skipped at send, with the reason', (await rowOf(mL.id)).status === 'skipped' && /STOP/.test((await rowOf(mL.id)).reason) && !seen.some((s) => /opted out/.test(s.opts.text)), await rowOf(mL.id));
  await prisma.candidate.update({ where: { id: CL.id }, data: { doNotContact: true } });
  await SR.run({ now: new Date(Date.parse(mL2.sendAt) + MIN) });
  check('a candidate marked do-not-contact after scheduling is skipped at send, nothing goes', (await rowOf(mL2.id)).status === 'skipped' && /not to be contacted/.test((await rowOf(mL2.id)).reason) && !seen.some((s) => /do-not-contact/.test(s.opts.text)), await rowOf(mL2.id));
  // cancelled and edited rows
  const CE = await mkCand('edited'); await mkApp(CE, REQ);
  const mE = await mkMsg(CE, { body: 'Cancelled words', sendAt: tomorrow('08:00') });
  const mE2 = await mkMsg(CE, { body: 'Original words', sendAt: tomorrow('08:10') });
  await call('DELETE', `/ats/reminders/messages/${mE.id}`, { reason: 'changed my mind' }, T.R);
  await call('PATCH', `/ats/reminders/messages/${mE2.id}`, { body: 'Edited words' }, T.R);
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(mE2.sendAt) + MIN) });
  check('a cancelled message is never sent, and an edited one goes with its new words', !seen.some((s) => /Cancelled words/.test(s.opts.text)) && seen.some((s) => /Edited words/.test(s.opts.text) && !/Original/.test(s.opts.text)) && (await rowOf(mE.id)).status === 'cancelled' && (await rowOf(mE2.id)).status === 'sent');
  // the automatic switch ON: both kinds work and the manual one is not doubled
  await call('PUT', '/ats/reminders/settings', { enabled: true }, T.A);
  const CO = await mkCand('on'); await mkApp(CO, REQ);
  const mO = await mkMsg(CO, { body: 'With the switch on', sendAt: tomorrow('09:30') });
  seen.length = 0;
  const runOn = await SR.run({ now: new Date(Date.parse(mO.sendAt) + MIN) });
  check('with the switch ON the manual message is sent once as well', runOn.off === undefined && seen.filter((s) => /With the switch on/.test(s.opts.text)).length === 1 && (await rowOf(mO.id)).status === 'sent', runOn);
  await call('PUT', '/ats/reminders/settings', { enabled: false }, T.A);

  // ---------------------------------------------------------------- 8. delivery ticks, the dashboard card
  console.log('8. Delivery ticks and the "Reminders going out" card');
  const ref = (await rowOf(m1.id)).providerRef;
  await SR.applyDeliveryStatus(ref, 'DELIVERED', null, new Date());
  check('a delivered tick from the provider is kept (status delivered, listed under sent)', (await rowOf(m1.id)).deliveryStatus === 'Delivered' && (await rowOf(m1.id)).status === 'delivered' && (await get(CS.id)).body.counts.sent >= 1);
  await SR.applyDeliveryStatus(ref, 'FAILED', 'Number is not on WhatsApp', new Date());
  check('a failed report from the provider turns it to failed with the reason, and the person is told', (await rowOf(m1.id)).status === 'failed' && /not on WhatsApp/.test((await rowOf(m1.id)).reason) && (await bellsOf(REC.id, 'Scheduled message NOT sent')).some((b) => /Sm send/.test(b.message)));
  const up = await call('GET', '/ats/reminders/upcoming', null, T.R);
  check('the card counts the person\'s own messages apart from the automatic reminders (recruiter: own candidates only)', up.status === 200 && up.body.tomorrow.own >= 5 && up.body.tomorrow.automatic === 1 && up.body.rows.some((r) => r.kind === 'custom' && r.own === true && r.label === 'Your own message'), up.body);
  const upT = await call('GET', '/ats/reminders/upcoming', null, T.T);
  check('the team lead\'s card counts the team\'s messages too (scope team)', upT.status === 200 && upT.body.scope === 'team' && upT.body.tomorrow.own >= up.body.tomorrow.own && upT.body.rows.some((r) => r.kind === 'custom'), upT.body.tomorrow);
  const upX = await call('GET', '/ats/reminders/upcoming', null, T.X);
  check('a recruiter of another department sees none of these', upX.status === 200 && upX.body.tomorrow.own === 0 && !(upX.body.rows || []).some((r) => r.kind === 'custom'), upX.body.tomorrow);
  const upB = await call('GET', '/ats/reminders/upcoming', null, T.B);
  check('the BDE side gets numbers only (no rows)', upB.status === 200 && upB.body.countOnly === true && !upB.body.rows, upB.body);

  messaging.send = realSend;
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
