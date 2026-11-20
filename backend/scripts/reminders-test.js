#!/usr/bin/env node
/**
 * SCHEDULED REMINDERS TO THE CANDIDATE: an offline / online interview and a joining (founder 2026-11-20: "scheduled messages ... the TL and the recruiter look at
 * the times and the number; once scheduled it must also DISPLAY in the TL's and the recruiter's logins").
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; nothing real is sent (the senders are the sandbox's fake ones, and the in-process worker
 * is given a simulated clock).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4281 node scripts/reminders-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-reminders-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4281);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'reminders-test', INTEGRATION_SECRET_KEY: 'zz-reminders-test-integration-key', TL_COMM_SEND_LIMIT: '500',
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
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
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
const rowsOf = (appId, kind) => q('SELECT * FROM "ScheduledReminder" WHERE "applicationId" = ? AND "kind" = ? ORDER BY "sendAt"', appId, kind);
const live = (rows) => rows.filter((r) => r.status !== 'cancelled');
const bellsOf = (userId, like) => prisma.notification.findMany({ where: { userId, title: { contains: like } } });
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  await prisma.employee.upsert({ where: { userId: adminRow.id }, create: { employeeCode: `ZZ-RM-ADM-${P}`, name: adminRow.name, userId: adminRow.id, email: 'admin.rm@rm-test.in', phone: '9000000002', designation: 'Employee', employmentStatus: 'Active', department: 'Admin' }, update: { phone: '9000000002', email: 'admin.rm@rm-test.in' } }).catch(() => null);
  const mk = (tag, data) => prisma.user.create({ data: { name: `Rm ${tag} ${P}`, email: `rm.${tag}.${P}@rm-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const RECX = await mk('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' });
  const MGR = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const client = await prisma.client.create({ data: { name: `Rm Hospital ${P}`, location: 'Hyderabad', ownerDepartment: 'Medical', bdeOwner: BDE.name, clientType: 'Client' } });
  const mkReq = (title, extra = {}) => prisma.requirement.create({ data: { title, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, openings: 3, skills: 'Nursing', experience: '2-5', location: 'Hyderabad', salary: '4L - 6L CTC', jobDescription: 'Nurses needed. Salary 4L to 6L.', ...extra } });
  const REQ = await mkReq(`Rm Staff Nurse ${P}`);
  const REQ2 = await mkReq(`Rm Ward Nurse ${P}`);
  let phoneSeq = 0;
  const mkCand = async (tag, data = {}) => {
    phoneSeq += 1;
    const { languagesKnown, ...rest } = data;
    const c = await prisma.candidate.create({ data: { name: `Rm ${tag} ${P}`, phone: `90000${String(P % 100).padStart(2, '0')}${String(10 + phoneSeq).padStart(3, '0')}`, email: `rm.${tag}.${P}@rm-cand.in`, ...rest } });
    if (languagesKnown && /telugu/i.test(languagesKnown)) {
      // the candidate's saved language (the AI calling module's own table): Telugu
      await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "AiCallPref" ("candidateId" TEXT PRIMARY KEY, "language" TEXT, "source" TEXT, "updatedAt" TEXT)');
      await prisma.$executeRawUnsafe('INSERT OR REPLACE INTO "AiCallPref" ("candidateId","language","source","updatedAt") VALUES (?,?,?,?)', c.id, 'Telugu', 'recruiter', new Date().toISOString());
    }
    return c;
  };
  const mkApp = (cand, req, data = {}) => prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: REC.id, offeredCtc: 450000, ...data } });
  const toks = {};
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  toks.A = await tok(adminRow.id); toks.B = await tok(BDE.id); toks.T = await tok(TL.id); toks.R = await tok(REC.id); toks.R2 = await tok(REC2.id); toks.X = await tok(RECX.id); toks.M = await tok(MGR.id);

  // ---------------------------------------------------------------- 1. the times (pure, a fixed clock)
  console.log('1. The plan: times, dropping, hours');
  const plan = (eventAt, steps, now) => SR.computePlan({ eventAt, steps: steps || SR.DEFAULT_STEPS.interview, now, earliestHour: 7, latestHour: 20 });
  const d0 = '2026-11-24';
  const p3 = plan(atIst('2026-11-27', '11:00'), null, atIst(d0, '09:00'));
  check('3 days ahead: the 3 default steps at 2 days before 10:00, 1 day before 17:00, 2 hours before (09:00)', p3.plan.length === 3 && p3.plan.map((p) => ymdhm(p.sendAt)).join('|') === '2026-11-25 10:00|2026-11-26 17:00|2026-11-27 09:00', p3.plan.map((p) => ymdhm(p.sendAt)));
  const p5 = plan(atIst(d0, '14:00'), null, atIst(d0, '09:00'));
  check('booked 5 hours ahead the same day: only the steps that still fit (2 hours before = 12:00) + the details at once (09:00)', p5.plan.map((p) => `${p.stepKey}@${hm(p.sendAt)}`).join('|') === 'NOW@09:00|H2@12:00', p5.plan.map((p) => `${p.stepKey}@${hm(p.sendAt)}`));
  const p15 = plan(atIst(d0, '10:30'), null, atIst(d0, '09:00'));
  check('the interview is sooner than the last step (90 minutes): that step is dropped, the details go at once', p15.plan.map((p) => p.stepKey).join('|') === 'NOW' && p15.dropped.some((x) => x.stepKey === 'H2'), p15);
  const pEarly = plan(atIst('2026-11-26', '08:00'), null, atIst(d0, '09:00'));
  check('an 08:00 interview: "2 hours before" would be 06:00, so it goes at 07:00 (never before 07:00)', pEarly.plan.some((p) => p.stepKey === 'H2' && ymdhm(p.sendAt) === '2026-11-26 07:00'), pEarly.plan.map((p) => ymdhm(p.sendAt)));
  const pLate = plan(atIst('2026-11-26', '22:30'), [{ hours: 1 }, { days: 1, at: '22:00' }], atIst(d0, '09:00'));
  check('a 22:30 interview: 1 hour before and a 22:00 day-before step are held to 20:00 (never after 20:00)', pLate.plan.every((p) => hm(p.sendAt) <= '20:00') && pLate.plan.length === 2, pLate.plan.map((p) => ymdhm(p.sendAt)));
  check('0 messages is allowed (nothing planned), and the editor keeps at most 5', plan(atIst('2026-11-27', '11:00'), [], atIst(d0, '09:00')).plan.length === 0 && SR.computePlan({ eventAt: atIst('2026-12-27', '11:00'), steps: [1, 2, 3, 4, 5].map((n) => ({ days: n, at: '10:00' })), now: atIst(d0, '09:00') }).plan.length === 5);
  const pJ = SR.computePlan({ eventAt: atIst('2026-11-30', '09:30'), steps: SR.DEFAULT_STEPS.joining, now: atIst(d0, '09:00') });
  check('a joining: 2 days before 10:00, 1 day before 17:00 and the morning of the joining at 08:00', pJ.plan.map((p) => ymdhm(p.sendAt)).join('|') === '2026-11-28 10:00|2026-11-29 17:00|2026-11-30 08:00', pJ.plan.map((p) => ymdhm(p.sendAt)));

  // ---------------------------------------------------------------- 2. the switches (all OFF by default)
  console.log('2. The Admin switches');
  const s0 = (await call('GET', '/ats/reminders/settings', null, toks.A)).body;
  check('the switch is OFF by default; channels all allowed; hours 07:00-20:00; the client is not named', s0.settings.enabled === false && s0.settings.earliestHour === 7 && s0.settings.latestHour === 20 && s0.settings.nameClient === false && s0.canEdit === true, s0.settings);
  check('only an Admin changes the settings, the words and sends the test', (await call('PUT', '/ats/reminders/settings', { enabled: true }, toks.T)).status === 403 && (await call('PUT', '/ats/reminders/templates', { templates: {} }, toks.R)).status === 403 && (await call('POST', '/ats/reminders/test', {}, toks.T)).status === 403);
  check('the hours are checked (latest after earliest)', (await call('PUT', '/ats/reminders/settings', { earliestHour: 12, latestHour: 9 }, toks.A)).status === 400);
  check('not more than 5 messages per event in a schedule', (await call('PUT', '/ats/reminders/settings', { schedule: { interview: [1, 2, 3, 4, 5, 6].map((n) => ({ days: n, at: '10:00' })) } }, toks.A)).status === 400);

  // the channels (what the CRM does: the Integrations rows)
  await setRow('email', { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'hr@zz-test.invalid', 'Default from name': 'TeamLink' });
  await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.display]: '+91 90000 00001', [CAT.WA_FIELDS.bulkTpl]: 'zz_general' });
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });
  await new Promise((r) => { setTimeout(r, 500); });

  // ---------------------------------------------------------------- 3. booking an offline interview
  console.log('3. Booking an offline interview 3 days ahead (the BDE books)');
  const C1 = await mkCand('cand1', { languagesKnown: 'English, Hindi' });
  const A1 = await mkApp(C1, REQ);
  const evDay = addDays(istDay(new Date()), 3);
  const details = { venueName: 'Apollo Hospital, Block B', mapLink: 'https://maps.app.goo.gl/zzvenue', contactName: 'Ms Rani (HR)', contactPhone: '9000000099' };
  const sug = await call('POST', '/ats/reminders/suggest', { applicationId: A1.id, kind: 'interview', date: evDay, time: '11:00', mode: 'In Person', details: { ...details, address: '12 MG Road, Hyderabad 500001' } }, toks.R);
  check('the booking window asks for the plan: 3 steps pre-ticked, a channel each, a language, the live preview with the venue', sug.status === 200 && sug.body.steps.length === 3 && sug.body.steps.every((s) => s.checked && s.channel && s.language && /Apollo Hospital/.test(s.text) && /12 MG Road/.test(s.text)), sug.body);
  const sugB = await call('POST', '/ats/reminders/suggest', { applicationId: A1.id, kind: 'interview', date: evDay, time: '11:00', mode: 'In Person' }, toks.B);
  check('the BDE booking window shows the times and ways but never the message text', sugB.status === 200 && sugB.body.steps.length === 3 && sugB.body.steps.every((s) => s.text === null) && sugB.body.canSeeText === false, sugB.body);
  const bk = await call('POST', `/ats/interviews/${A1.id}/book`, { date: evDay, time: '11:00', mode: 'In Person', location: '12 MG Road, Hyderabad 500001', panel: [{ userId: REC.id }], details }, toks.B);
  check('the interview is booked and the answer carries the reminder plan (3 messages)', bk.status === 200 && bk.body.reminders && bk.body.reminders.count === 3, bk.body && (bk.body.error || bk.body.reminders));
  const r1 = live(await rowsOf(A1.id, 'interview'));
  const want = [`${addDays(evDay, -2)} 10:00`, `${addDays(evDay, -1)} 17:00`, `${evDay} 09:00`];
  check('3 planned messages at the right India times: 2 days before 10:00, 1 day before 17:00, 2 hours before', r1.length === 3 && r1.every((r) => r.status === 'planned') && r1.map((r) => ymdhm(r.sendAt)).join('|') === want.join('|'), r1.map((r) => ymdhm(r.sendAt)));
  const panelR = await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.R);
  const ki = panelR.body.kinds.interview;
  const t0 = ki.rows[0].text;
  check('the message has the first name, the role, the date and time, venue, full address, map link, contact and what to carry', /Hi Rm,/.test(t0) && /Staff Nurse/.test(t0) && /Apollo Hospital, Block B/.test(t0) && /12 MG Road, Hyderabad 500001/.test(t0) && /maps\.app\.goo\.gl\/zzvenue/.test(t0) && /Ms Rani \(HR\) - 9000000099/.test(t0) && /Please carry: ID proof, updated resume/.test(t0) && /11:00 AM/.test(t0) && /Reply STOP to stop these messages/.test(t0), t0);
  check('the client is not named (our client) and no salary / CTC ever appears', /our client/.test(t0) && !t0.includes(client.name) && ki.rows.every((r) => !/salary|ctc|4L|6L|450000|lpa/i.test(r.text)), t0);
  const recBells = await bellsOf(REC.id, 'Reminders scheduled');
  const tlBells = await bellsOf(TL.id, 'Reminders scheduled');
  check('the recruiter and the team lead each get the "Reminders scheduled" bell exactly once', recBells.length === 1 && tlBells.length === 1, [recBells.length, tlBells.length]);
  check('the bell says who, what, where and the 3 times', /Reminders scheduled for Rm cand1/.test(recBells[0].message) && /offline at Apollo Hospital, Block B/.test(recBells[0].message) && /3 messages: .*10:00.*17:00.*09:00/.test(recBells[0].message) && /switched off/.test(recBells[0].message), recBells[0] && recBells[0].message);
  const again = await SR.sync(A1.id, { actor: { id: BDE.id, name: BDE.name }, event: 'booked', kind: 'interview' });
  const sameSteps = await call('PUT', `/ats/reminders/application/${A1.id}/details`, { kind: 'interview', details }, toks.R);
  check('saving the same slot again makes no duplicates and rings no second bell', live(await rowsOf(A1.id, 'interview')).length === 3 && (await bellsOf(REC.id, 'Reminders scheduled')).length === 1 && (await bellsOf(TL.id, 'Reminders scheduled')).length === 1 && sameSteps.status === 200 && !again.error, [again, sameSteps.status]);
  // an explicit plan with the same steps through the service: still no duplicate rows
  const fresh1 = await prisma.application.findUnique({ where: { id: A1.id } });
  await SR.sync(A1.id, { actor: { id: REC.id, name: REC.name }, event: 'changed', kind: 'interview', steps: r1.map((r) => ({ stepKey: r.stepKey, sendAt: r.sendAt, channel: r.channel, language: r.language })) });
  check('an explicit plan with the same steps changes nothing (idempotent)', live(await rowsOf(A1.id, 'interview')).length === 3 && fresh1.interviewAt.toISOString() === r1[0].eventAt, live(await rowsOf(A1.id, 'interview')).length);

  // ---------------------------------------------------------------- 4. who sees it
  console.log('4. Who sees it, who edits it');
  const panelT = await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.T);
  const panelM = await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.M);
  const panelA = await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.A);
  const panelB = await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.B);
  check('the recruiter, the TL, the Manager and the Admin see the 3 messages with their text', [panelR, panelT, panelM, panelA].every((p) => p.status === 200 && p.body.kinds.interview.rows.length === 3 && p.body.kinds.interview.rows[0].text), [panelR.status, panelT.status, panelM.status, panelA.status]);
  check('the BDE side sees only the count (3 planned), never a message text, history or reason', panelB.status === 200 && panelB.body.kinds.interview.countOnly === true && panelB.body.kinds.interview.counts.total === 3 && panelB.body.kinds.interview.rows.length === 0 && !JSON.stringify(panelB.body).includes('Apollo Hospital'), panelB.body);
  check('a recruiter of another department cannot even see it', (await call('GET', `/ats/reminders/application/${A1.id}`, null, toks.X)).status === 404);
  check('the Manager only looks (cannot change), and a recruiter of another department cannot', (await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { channel: 'Email' }, toks.M)).status === 403 && [403, 404].includes((await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { channel: 'Email' }, toks.X)).status));
  check('the panel says what the switch is: not sent while reminders are switched off', panelR.body.switchOn === false && /switched off/.test(panelR.body.switchNote), panelR.body.switchNote);

  // ---------------------------------------------------------------- 5. editing the plan
  console.log('5. Editing: time, skip with a reason, add one, channel');
  const newT = atIst(addDays(evDay, -2), '12:30');
  const e1 = await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { sendAt: newT.toISOString() }, toks.R);
  check('the recruiter changes a time (kept as history, with who)', e1.status === 200 && ymdhm(e1.body.row.sendAt) === ymdhm(newT) && e1.body.row.editedBy === REC.name && e1.body.row.history.some((h) => /Time changed/.test(h.text)), e1.body);
  check('a time after the interview, in the past, or outside 07:00-20:00 is refused', (await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { sendAt: atIst(evDay, '12:00').toISOString() }, toks.R)).status === 400 && (await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { sendAt: new Date(Date.now() - HOUR).toISOString() }, toks.R)).status === 400 && (await call('PATCH', `/ats/reminders/rows/${r1[0].id}`, { sendAt: atIst(addDays(evDay, -2), '23:00').toISOString() }, toks.R)).status === 400);
  check('skipping needs a short reason', (await call('PATCH', `/ats/reminders/rows/${r1[1].id}`, { skip: true }, toks.T)).status === 400);
  const sk = await call('PATCH', `/ats/reminders/rows/${r1[1].id}`, { skip: true, reason: 'Candidate already confirmed by phone' }, toks.T);
  check('the TL skips one with a reason (status skipped, who, why)', sk.status === 200 && sk.body.row.status === 'skipped' && /already confirmed by phone/.test(sk.body.row.reason) && sk.body.row.editedBy === TL.name, sk.body);
  const ad = await call('POST', `/ats/reminders/application/${A1.id}/rows`, { kind: 'interview', sendAt: atIst(addDays(evDay, -1), '10:00').toISOString(), channel: 'Email' }, toks.R);
  check('the recruiter adds one more message by hand (by Email)', ad.status === 201 && ad.body.row.channel === 'Email' && ad.body.row.createdBy === REC.name, ad.body);
  check('a channel that does not reach the candidate is refused', (await call('PATCH', `/ats/reminders/rows/${r1[2].id}`, { channel: 'Pigeon' }, toks.R)).status === 400);
  const audits = await prisma.auditLog.findMany({ where: { entityId: A1.id, action: { contains: 'Scheduled message' } } });
  check('every change, skip and addition is in the audit log with who and why', audits.length >= 3 && audits.some((a) => /Pigeon/.test(a.action) === false) && audits.some((a) => a.reason && /confirmed by phone/.test(a.reason)), audits.map((a) => a.action));

  // ---------------------------------------------------------------- 6. reschedule and cancel
  console.log('6. Rescheduling and cancelling the interview');
  const before = live(await rowsOf(A1.id, 'interview')).filter((r) => r.status === 'planned');
  const newDay = addDays(evDay, 2);
  const rs = await call('POST', `/ats/interviews/${A1.id}/reschedule`, { interviewAt: atIst(newDay, '15:00').toISOString(), reason: 'Client asked for a later day' }, toks.A);
  check('rescheduled', rs.status === 200, rs.body);
  const after = await rowsOf(A1.id, 'interview');
  const moved = after.filter((r) => r.status === 'planned');
  check('the unsent steps moved with the interview (same row ids, new times), with a history line', moved.length === before.length && before.every((b) => moved.some((m) => m.id === b.id)) && moved.every((m) => m.eventAt === atIst(newDay, '15:00').toISOString()) && moved.some((m) => /Moved with the interview/.test(m.history)), moved.map((m) => [m.stepKey, ymdhm(m.sendAt)]));
  check('the 2-days step now falls on the new day minus 2 at 10:00, the 2-hours step at 13:00, the hand-added one keeps its distance; the skipped one stays skipped', moved.some((m) => m.stepKey === 'D2@10:00' && ymdhm(m.sendAt) === `${addDays(newDay, -2)} 10:00`) && moved.some((m) => m.stepKey === 'H2' && ymdhm(m.sendAt) === `${newDay} 13:00`) && moved.some((m) => /^X/.test(m.stepKey)) && after.some((r) => r.stepKey === 'D1@17:00' && r.status === 'skipped'), after.map((m) => [m.stepKey, m.status, ymdhm(m.sendAt)]));
  check('the recruiter and the TL are told once that the reminders moved', (await bellsOf(REC.id, 'Reminders moved')).length === 1 && (await bellsOf(TL.id, 'Reminders moved')).length === 1);
  const cn = await call('POST', `/ats/interviews/${A1.id}/cancel`, { reason: 'Client withdrew the opening' }, toks.A);
  const cancelled = await rowsOf(A1.id, 'interview');
  check('cancelled: every unsent message is cancelled with the reason', cn.status === 200 && cancelled.filter((r) => r.status === 'planned').length === 0 && cancelled.filter((r) => r.status === 'cancelled').length >= 3 && cancelled.some((r) => /cancelled/i.test(r.reason || '')), cancelled.map((r) => [r.status, r.reason]));
  check('the recruiter and the TL are told that the reminders were cancelled', (await bellsOf(REC.id, 'Reminders cancelled')).length === 1 && (await bellsOf(TL.id, 'Reminders cancelled')).length === 1);
  const pc = await call('GET', `/ats/reminders/interview/${A1.id}`, null, toks.R);
  check('the interview calendar window: the interview has no live reminders and says why', pc.status === 200 && pc.body.interview.live === false && /cancelled/i.test(pc.body.interview.endedBecause || ''), pc.body);

  // ---------------------------------------------------------------- 7. joining
  console.log('7. A joining date');
  const C2 = await mkCand('cand2', { languagesKnown: 'Telugu' });
  const A2 = await mkApp(C2, REQ, { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted', documentsStatus: 'Verified', interviewStatus: 'FEEDBACK_SUBMITTED', interviewAt: new Date(Date.now() - 5 * DAY) });
  const jDay = addDays(istDay(new Date()), 6);
  const jd = await call('POST', `/ats/joining/${A2.id}/schedule`, { joiningDate: jDay, details: { venueName: 'Apollo Hospital HR Block', address: '12 MG Road, Hyderabad', contactName: 'Mr Kiran', contactPhone: '9000000055', hrContact: 'HR Rani 9000000056', reportingTime: '09:00' } }, toks.A);
  const j1 = live(await rowsOf(A2.id, 'joining'));
  check('joining date set: 3 messages (2 days before 10:00, 1 day before 17:00, the morning of the joining 08:00)', jd.status === 200 && j1.length === 3 && j1.map((r) => ymdhm(r.sendAt)).join('|') === `${addDays(jDay, -2)} 10:00|${addDays(jDay, -1)} 17:00|${jDay} 08:00`, [jd.status, jd.body && jd.body.error, j1.map((r) => ymdhm(r.sendAt))]);
  const jp = (await call('GET', `/ats/reminders/application/${A2.id}`, null, toks.T)).body.kinds.joining;
  check('the joining message has the reporting date and time, place, address, contact, HR contact and the documents to bring', jp.rows[0] && /రిపోర్టింగ్: /.test(jp.rows[0].text) && /9:00 AM/.test(jp.rows[0].text) && /Apollo Hospital HR Block/.test(jp.rows[0].text) && /Mr Kiran - 9000000055/.test(jp.rows[0].text) && /HR Rani 9000000056/.test(jp.rows[0].text) && /certificates/.test(jp.rows[0].text), jp.rows[0] && jp.rows[0].text);
  check('a Telugu-speaking candidate gets the Telugu words (and the STOP line)', j1.every((r) => r.language === 'te') && /[ఀ-౿]/.test(jp.rows[0].text) && /STOP/.test(jp.rows[0].text), jp.rows[0] && jp.rows[0].text);
  check('the recruiter and the TL got the joining plan bell', (await bellsOf(REC.id, 'Reminders scheduled: Rm cand2')).length === 1 && (await bellsOf(TL.id, 'Reminders scheduled: Rm cand2')).length === 1);
  const jd2 = await call('POST', `/ats/joining/${A2.id}/schedule`, { joiningDate: addDays(jDay, 3) }, toks.A);
  const j2 = live(await rowsOf(A2.id, 'joining'));
  check('the joining date moved: the unsent messages moved with it (still 3, new days)', jd2.status === 200 && j2.length === 3 && j2.some((r) => r.stepKey === 'D0@08:00' && ymdhm(r.sendAt) === `${addDays(jDay, 3)} 08:00`) && j2.some((r) => r.stepKey === 'D2@10:00' && ymdhm(r.sendAt) === `${addDays(jDay, 1)} 10:00`), j2.map((r) => [r.stepKey, ymdhm(r.sendAt)]));
  const nj = await call('POST', `/ats/joining/${A2.id}/not-joined`, { reason: 'Took another job' }, toks.A);
  const j3 = await rowsOf(A2.id, 'joining');
  check('the person dropped: all joining messages are cancelled (dropped)', nj.status === 200 && j3.filter((r) => r.status === 'planned').length === 0 && j3.some((r) => /dropped/i.test(r.reason || '')), [nj.status, nj.body && nj.body.error, j3.map((r) => [r.status, r.reason])]);

  // ---------------------------------------------------------------- 8. the worker
  console.log('8. The sending worker (a simulated clock)');
  const seen = [];
  const messaging = require('../src/utils/messaging');
  const realSend = messaging.send;
  let failMode = null;
  messaging.send = async (channel, opts) => {
    seen.push({ channel, opts });
    if (failMode === 'transient') return { ok: false, outcome: 'Failed', transient: true, error: 'WhatsApp HTTP 503: try later' };
    if (failMode === 'hard') return { ok: false, outcome: 'Failed', transient: false, error: 'WhatsApp HTTP 400 (131026): message undeliverable' };
    return realSend(channel, opts);
  };
  const C3 = await mkCand('cand3');
  const A3 = await mkApp(C3, REQ);
  const day3 = addDays(istDay(new Date()), 4);
  await call('POST', `/ats/interviews/${A3.id}/book`, { date: day3, time: '12:00', mode: 'In Person', location: '5 Station Road, Hyderabad', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, toks.B);
  const p3rows = live(await rowsOf(A3.id, 'interview'));
  check('setup: a plan of 3 for the worker tests', p3rows.length === 3, p3rows.length);
  const offRun = await SR.run({ now: new Date(Date.parse(p3rows[0].sendAt) + MIN) });
  check('with the switch OFF nothing goes out, and the plan is still there', offRun.off === true && seen.length === 0 && (await rowsOf(A3.id, 'interview')).every((r) => r.status === 'planned'));
  const sw = await call('PUT', '/ats/reminders/settings', { enabled: true, channels: { SMS: false } }, toks.A);
  check('the Admin turns reminders ON (and SMS off for the company)', sw.status === 200 && sw.body.settings.enabled === true && sw.body.settings.channels.SMS === false, sw.body);
  const nowA = new Date(Date.parse(p3rows[0].sendAt) + MIN);
  const run1 = await SR.run({ now: nowA });
  const row1 = (await rowsOf(A3.id, 'interview')).find((r) => r.id === p3rows[0].id);
  const waCall = seen.find((s) => s.channel === 'WhatsApp' && /City Clinic/.test(s.opts.text));
  check('the due message goes once: sent, with a provider id; outside the 24-hour window it is the general template with the message as its blank', run1.sent === 1 && row1.status === 'sent' && row1.providerRef && row1.sentAt && waCall && waCall.opts.kind === 'bulk' && Array.isArray(waCall.opts.vars) && waCall.opts.vars[0] === waCall.opts.text && waCall.opts.automatic === true, [run1, row1.status, waCall && waCall.opts.kind]);
  const sentCount = seen.length;
  const run2 = await SR.run({ now: nowA });
  check('running the worker again sends nothing twice', run2.sent === 0 && seen.length === sentCount && (await rowsOf(A3.id, 'interview')).filter((r) => r.status === 'sent').length === 1);
  const log = await prisma.candidateMessage.findMany({ where: { candidateId: C3.id, template: 'REMINDER_INTERVIEW' } });
  check('the message is also on the candidate\'s Communications with its provider id', log.length === 1 && log[0].providerRef === row1.providerRef && /City Clinic/.test(log[0].body), log.length);
  const dig = await bellsOf(REC.id, 'Reminders sent today');
  const tlDig = await bellsOf(TL.id, 'Reminders sent today');
  check('the recruiter and the TL get ONE digest line for the day (not a bell per message)', dig.length === 1 && tlDig.length === 1 && /Rm cand3/.test(dig[0].message), [dig.length, tlDig.length]);
  // inside the 24-hour window: plain words
  await prisma.appSetting.upsert({ where: { key: `wa.window.91${C3.phone}` }, create: { key: `wa.window.91${C3.phone}`, value: new Date().toISOString() }, update: { value: new Date().toISOString() } });
  seen.length = 0;
  const nowB = new Date(Date.parse(row1.sendAt) + 3 * HOUR); // later the same day: the digest line is updated, not doubled
  await prisma.$executeRawUnsafe('UPDATE "ScheduledReminder" SET "sendAt" = ? WHERE "id" = ?', new Date(nowB.getTime() - MIN).toISOString(), p3rows[1].id);
  await SR.run({ now: nowB });
  const waOpen = seen.find((s) => s.channel === 'WhatsApp');
  check('inside the 24-hour window the same message goes as plain words (kind "session", no template blank)', !!waOpen && waOpen.opts.kind === 'session' && !waOpen.opts.vars, waOpen && waOpen.opts);
  check('the digest line is updated (2 sent), not a second bell', (await bellsOf(REC.id, 'Reminders sent today')).length === 1 && /Reminders sent today: 2/.test((await bellsOf(REC.id, 'Reminders sent today'))[0].title));
  // delivery ticks
  const ref1 = row1.providerRef;
  await SR.applyDeliveryStatus(ref1, 'DELIVERED', null, new Date());
  const afterD = (await rowsOf(A3.id, 'interview')).find((r) => r.id === row1.id);
  check('the delivery report comes back as a Delivered chip (and never goes backwards on a late "sent")', afterD.deliveryStatus === 'Delivered' && afterD.status === 'delivered' && (await SR.applyDeliveryStatus(ref1, 'SENT', null, new Date())) === 0 && (await rowsOf(A3.id, 'interview')).find((r) => r.id === row1.id).deliveryStatus === 'Delivered');
  await SR.applyDeliveryStatus(ref1, 'FAILED', 'Number not on WhatsApp', new Date());
  const failedD = (await rowsOf(A3.id, 'interview')).find((r) => r.id === row1.id);
  check('a later "failed" report wins, keeps the provider\'s words and rings the recruiter and TL', failedD.deliveryStatus === 'Failed' && failedD.status === 'failed' && /Number not on WhatsApp/.test(failedD.reason) && (await bellsOf(REC.id, 'Reminder NOT sent')).length === 1 && (await bellsOf(TL.id, 'Reminder NOT sent')).length === 1);

  // skips: done, cancelled, rejected, opt-out, test person, passed time
  console.log('9. Skips');
  const mkPlanApp = async (tag, candData, offsetDays = 4) => {
    const c = await mkCand(tag, candData);
    const a = await mkApp(c, REQ2);
    const day = addDays(istDay(new Date()), offsetDays);
    await call('POST', `/ats/interviews/${a.id}/book`, { date: day, time: '12:00', mode: 'In Person', location: 'Skip Street', panel: [{ userId: REC.id }], details: { venueName: 'Skip Hall' } }, toks.B);
    const rows = live(await rowsOf(a.id, 'interview'));
    return { c, a, rows, day };
  };
  const skipRun = async (x, mutate) => {
    await mutate(x);
    seen.length = 0;
    await SR.run({ now: new Date(Date.parse(x.rows[0].sendAt) + MIN) });
    const rs = await rowsOf(x.a.id, 'interview');
    return { rs, sent: seen.filter((s) => s.opts.text && /Skip Hall/.test(s.opts.text)).length };
  };
  const sDone = await mkPlanApp('done', {});
  const rDone = await skipRun(sDone, (x) => prisma.application.update({ where: { id: x.a.id }, data: { interviewStatus: 'FEEDBACK_SUBMITTED', stage: 'INTERVIEW_COMPLETED' } }));
  check('interview already done: every planned message is skipped with the reason, nothing sent', rDone.sent === 0 && rDone.rs.filter((r) => r.status === 'skipped').length === 3 && /done/i.test(rDone.rs[0].reason), rDone.rs.map((r) => [r.status, r.reason]));
  const sCan = await mkPlanApp('can', {});
  const rCan = await skipRun(sCan, (x) => prisma.application.update({ where: { id: x.a.id }, data: { interviewStatus: 'CANCELLED' } }));
  check('interview cancelled behind the scenes: skipped (cancelled), nothing sent', rCan.sent === 0 && rCan.rs.every((r) => r.status === 'skipped' && /cancelled/i.test(r.reason)), rCan.rs.map((r) => [r.status, r.reason]));
  const sRej = await mkPlanApp('rej', {});
  const rRej = await skipRun(sRej, (x) => prisma.application.update({ where: { id: x.a.id }, data: { stage: 'REJECTED' } }));
  check('candidate rejected: skipped, nothing sent', rRej.sent === 0 && rRej.rs.every((r) => r.status === 'skipped' && /rejected/i.test(r.reason)), rRej.rs.map((r) => [r.status, r.reason]));
  const sStop = await mkPlanApp('stop', {});
  const rStop = await skipRun(sStop, (x) => prisma.appSetting.create({ data: { key: `msg.optout.WhatsApp.91${x.c.phone}`, value: JSON.stringify({ at: new Date().toISOString(), text: 'STOP' }) } }));
  check('the candidate replied STOP: that message is skipped (opted out), none sent', rStop.sent === 0 && rStop.rs.filter((r) => r.status === 'skipped' && /STOP/i.test(r.reason)).length >= 1, rStop.rs.map((r) => [r.status, r.reason]));
  const sDnc = await mkPlanApp('dnc', {});
  const rDnc = await skipRun(sDnc, (x) => prisma.candidate.update({ where: { id: x.c.id }, data: { doNotContact: true } }));
  check('do-not-contact: skipped', rDnc.sent === 0 && rDnc.rs[0].status === 'skipped' && /not to be contacted/i.test(rDnc.rs[0].reason), rDnc.rs.map((r) => [r.status, r.reason]));
  const sTest = await mkPlanApp('zztest', {});
  await prisma.candidate.update({ where: { id: sTest.c.id }, data: { name: `ZZTEST Person ${P}` } });
  seen.length = 0;
  const realEnv = { a: process.env.TEST_MODE, b: process.env.TEAMLINK_SANDBOX };
  delete process.env.TEST_MODE; delete process.env.TEAMLINK_SANDBOX; // the REAL server's rule: a test person is never messaged
  await SR.run({ now: new Date(Date.parse(sTest.rows[0].sendAt) + MIN) });
  process.env.TEST_MODE = realEnv.a; process.env.TEAMLINK_SANDBOX = realEnv.b;
  const rTest = await rowsOf(sTest.a.id, 'interview');
  check('a test person is skipped on the real server', rTest[0].status === 'skipped' && /test person/i.test(rTest[0].reason) && !seen.some((s) => /Skip Hall/.test(s.opts.text || '')), rTest.map((r) => [r.status, r.reason]));
  const sPass = await mkPlanApp('pass', {});
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(sPass.rows[0].eventAt) + 5 * MIN) });
  const rPass = await rowsOf(sPass.a.id, 'interview');
  check('the interview time has passed: nothing is sent, all skipped (time passed)', rPass.every((r) => r.status === 'skipped' && /passed/i.test(r.reason)) && !seen.some((s) => /Skip Hall/.test(s.opts.text || '')), rPass.map((r) => [r.status, r.reason]));
  const sLate = await mkPlanApp('late', {});
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(sLate.rows[0].sendAt) + 4 * HOUR) });
  check('a step that is more than 3 hours late (the switch was off) is not sent any more', (await rowsOf(sLate.a.id, 'interview'))[0].status === 'skipped' && !seen.some((s) => /Skip Hall/.test(s.opts.text || '')));
  const sNight = await mkPlanApp('night', {});
  await prisma.$executeRawUnsafe('UPDATE "ScheduledReminder" SET "sendAt" = ? WHERE "id" = ?', atIst(addDays(istDay(new Date()), 1), '19:50').toISOString(), sNight.rows[0].id);
  seen.length = 0;
  const nightRun = await SR.run({ now: atIst(addDays(istDay(new Date()), 1), '20:30') });
  check('nothing goes after 20:00 India time (it waits)', !seen.some((s) => /Skip Hall/.test(s.opts.text || '')) && nightRun.deferred >= 1, nightRun);

  // retries
  console.log('10. Retries and failures');
  const sRetry = await mkPlanApp('retry', {});
  failMode = 'transient';
  let clock = Date.parse(sRetry.rows[0].sendAt) + MIN;
  await SR.run({ now: new Date(clock) });
  let rr = (await rowsOf(sRetry.a.id, 'interview'))[0];
  check('a temporary failure is tried again later (try 1 of 3), still planned, with the reason', rr.status === 'planned' && Number(rr.attempts) === 1 && Date.parse(rr.nextAttemptAt) > clock && /Try 1 of 3 failed/.test(rr.reason), rr);
  await SR.run({ now: new Date(clock + 2 * MIN) });
  check('before the back-off is over nothing is tried again', Number((await rowsOf(sRetry.a.id, 'interview'))[0].attempts) === 1);
  clock += 6 * MIN;
  await SR.run({ now: new Date(clock) });
  rr = (await rowsOf(sRetry.a.id, 'interview'))[0];
  check('second try fails too (try 2 of 3)', Number(rr.attempts) === 2 && rr.status === 'planned');
  clock += 31 * MIN;
  await SR.run({ now: new Date(clock) });
  rr = (await rowsOf(sRetry.a.id, 'interview'))[0];
  check('after 3 tries it FAILS with a clear reason', rr.status === 'failed' && Number(rr.attempts) === 3 && /503/.test(rr.reason) && /3 tries/.test(rr.reason), rr);
  const failBells = (await bellsOf(REC.id, 'Reminder NOT sent')).filter((b) => /Rm retry/.test(b.message));
  const failBellsT = (await bellsOf(TL.id, 'Reminder NOT sent')).filter((b) => /Rm retry/.test(b.message));
  check('the failure rings the recruiter and the TL at once, once, with the reason', failBells.length === 1 && failBellsT.length === 1 && /503/.test(failBells[0].message), failBells.map((b) => b.message));
  const sHard = await mkPlanApp('hard', {});
  failMode = 'hard';
  await SR.run({ now: new Date(Date.parse(sHard.rows[0].sendAt) + MIN) });
  const rh = (await rowsOf(sHard.a.id, 'interview'))[0];
  check('a refusal that retrying cannot fix fails at once (no retries) with the provider\'s reason', rh.status === 'failed' && Number(rh.attempts) === 1 && /131026/.test(rh.reason), rh);
  failMode = null;
  const sn = await call('POST', `/ats/reminders/rows/${rh.id}/send-now`, null, toks.R);
  check('"Send now" on a failed message tries it again (and it goes)', sn.status === 200 && sn.body.ok === true && sn.body.row.status === 'sent', sn.body);
  check('"Send now" is for people who may edit: the Manager is refused', (await call('POST', `/ats/reminders/rows/${rh.id}/send-now`, null, toks.M)).status === 403);

  // one message per candidate per event time
  console.log('11. One message per candidate per event time');
  const CD = await mkCand('twin');
  const AD1 = await mkApp(CD, REQ); const AD2 = await mkApp(CD, REQ2);
  const dayT = addDays(istDay(new Date()), 5);
  await call('POST', `/ats/interviews/${AD1.id}/book`, { date: dayT, time: '12:00', mode: 'In Person', location: 'Twin Street', panel: [{ userId: REC.id }], details: { venueName: 'Twin Hall' } }, toks.B);
  await call('POST', `/ats/interviews/${AD2.id}/book`, { date: dayT, time: '12:00', mode: 'In Person', location: 'Twin Street', panel: [{ userId: REC.id }], details: { venueName: 'Twin Hall' } }, toks.B);
  const tw = [...live(await rowsOf(AD1.id, 'interview')), ...live(await rowsOf(AD2.id, 'interview'))];
  seen.length = 0;
  await SR.run({ now: new Date(Date.parse(tw[0].sendAt) + MIN) });
  const twSent = seen.filter((s) => /Twin Hall/.test(s.opts.text || ''));
  const twRows = [...(await rowsOf(AD1.id, 'interview')), ...(await rowsOf(AD2.id, 'interview'))].filter((r) => r.stepKey === 'D2@10:00');
  check('two overlapping plans for the same person and event time send ONE message (the other is skipped as covered)', tw.length === 6 && twSent.length === 1 && twRows.filter((r) => r.status === 'sent').length === 1 && twRows.filter((r) => r.status === 'skipped' && /already went/.test(r.reason)).length === 1, [twSent.length, twRows.map((r) => [r.status, r.reason])]);

  // ---------------------------------------------------------------- 12. dashboard card
  console.log('12. The dashboard card "Reminders going out"');
  const today = istDay(new Date());
  const CU = await mkCand('card');
  const AU = await mkApp(CU, REQ);
  await call('POST', `/ats/interviews/${AU.id}/book`, { date: addDays(today, 4), time: '12:00', mode: 'In Person', location: 'Card Road', panel: [{ userId: REC.id }], details: { venueName: 'Card Hall' } }, toks.B);
  const cardRows = live(await rowsOf(AU.id, 'interview'));
  await prisma.$executeRawUnsafe('UPDATE "ScheduledReminder" SET "sendAt" = ? WHERE "id" = ?', atIst(today, '23:30').toISOString(), cardRows[0].id);
  await prisma.$executeRawUnsafe('UPDATE "ScheduledReminder" SET "sendAt" = ?, "status" = \'failed\', "reason" = \'No mobile number\' WHERE "id" = ?', atIst(addDays(today, 1), '10:00').toISOString(), cardRows[1].id);
  const upR = (await call('GET', '/ats/reminders/upcoming', null, toks.R)).body;
  const upT = (await call('GET', '/ats/reminders/upcoming', null, toks.T)).body;
  const upB = (await call('GET', '/ats/reminders/upcoming', null, toks.B)).body;
  const upA = (await call('GET', '/ats/reminders/upcoming', null, toks.A)).body;
  const upX = (await call('GET', '/ats/reminders/upcoming', null, toks.X)).body;
  check('the recruiter\'s card: today and tomorrow counts, how many failed, and the list (candidate, event, message time, channel, status)', upR.scope === 'own' && upR.today.total >= 1 && upR.tomorrow.failed >= 1 && upR.rows.some((r) => r.candidate === `Rm card ${P}` && r.day === 'today' && r.channel && r.status) && upR.rows.some((r) => r.candidate === `Rm card ${P}` && r.day === 'tomorrow' && r.status === 'failed'), upR);
  check('the TL sees the team\'s, the Admin everything, a recruiter of another department none of it', upT.scope === 'team' && upT.rows.some((r) => r.candidate === `Rm card ${P}`) && upA.scope === 'all' && upA.rows.some((r) => r.candidate === `Rm card ${P}`) && !(upX.rows || []).some((r) => r.candidate === `Rm card ${P}`));
  check('the BDE side sees only the numbers on the card, never a list', upB.countOnly === true && !upB.rows && upB.today.total >= 1, upB);

  // ---------------------------------------------------------------- 13. the words, the test button
  console.log('13. The words and the test message');
  const tpl = await call('PUT', '/ats/reminders/templates', { templates: { interview_offline: { en: 'Hi {{first_name}}, {{lead}} Come to {{venue}}, {{address}} at {{time}} on {{date}}. {{unknown_thing}}' } } }, toks.A);
  check('an Admin cannot save a placeholder that does not exist', tpl.status === 400 && /unknown_thing/.test(tpl.body.error), tpl.body);
  const tpl2 = await call('PUT', '/ats/reminders/templates', { templates: { interview_offline: { en: 'Hello {{first_name}}, {{lead}}\nCome to {{venue}}, {{address}} at {{time}} on {{date}}.\nReply STOP to stop these messages.' } } }, toks.A);
  const pv = await call('POST', '/ats/reminders/preview', { applicationId: A3.id, kind: 'interview', eventAt: atIst(addDays(istDay(new Date()), 9), '11:00').toISOString(), mode: 'In Person', details: { venueName: 'New Hall', address: '9 New Road' }, sendAt: new Date().toISOString(), language: 'en', stepKey: 'D2@10:00' }, toks.R);
  check('an edited English template is used by the preview', tpl2.status === 200 && pv.status === 200 && /^Hello Rm,/.test(pv.body.text) && /Come to New Hall, 9 New Road at 11:00 AM/.test(pv.body.text), pv.body);
  const pvTe = await call('POST', '/ats/reminders/preview', { applicationId: A3.id, kind: 'interview', eventAt: atIst(addDays(istDay(new Date()), 9), '11:00').toISOString(), mode: 'In Person', details: { venueName: 'New Hall', address: '9 New Road' }, sendAt: new Date().toISOString(), language: 'te', stepKey: 'D1@17:00' }, toks.R);
  check('the Telugu words are used when Telugu is picked (and the English edit does not touch them)', /[ఀ-౿]/.test(pvTe.body.text) && /New Hall/.test(pvTe.body.text) && !/^Hello/.test(pvTe.body.text), pvTe.body);
  const ts = await call('POST', '/ats/reminders/test', { kind: 'interview', mode: 'offline', channel: 'Email', language: 'en' }, toks.A);
  const tsw = await call('POST', '/ats/reminders/test', { kind: 'joining', mode: 'offline', channel: 'WhatsApp', language: 'te' }, toks.A);
  check('"Send me a test reminder" sends the preview to the Admin\'s own mail / phone (marked TEST), never to a candidate', ts.status === 200 && ts.body.ok && tsw.status === 200 && tsw.body.ok && tsw.body.to === '•••0002' && ts.body.to === 'a•••@rm-test.in', [ts.body, tsw.body]);
  const stS = (await call('GET', '/ats/reminders/settings', null, toks.R)).body;
  check('every login can read how the channels stand (SMS shown, not offered when not ready)', Array.isArray(stS.channels) && stS.channels.length === 3, stS.channels);

  messaging.send = realSend;
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
