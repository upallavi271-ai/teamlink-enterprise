#!/usr/bin/env node
/**
 * ADVANCED MESSAGE SCHEDULER (founder 2026-11-20): one-time / recurring schedules to one or many candidates, the ATS triggers and stop rules,
 * the Scheduled Messages page, every message tracked (scheduled / sent / delivered / failed). utils/messageSchedules.js, routes/messageSchedules.js.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; nothing real is sent; the worker runs in this process with a simulated clock and a
 * stand-in provider (messaging.send) so failures and delivery reports can be simulated.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4400 node scripts/sched-adv-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-schedadv-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'sms', 'sms-android', 'telephony')");
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4400);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'schedadv-test', INTEGRATION_SECRET_KEY: 'zz-schedadv-test-integration-key', TL_COMM_SEND_LIMIT: '500',
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const CAT = require('../src/utils/adminCatalog');
const SR = require('../src/utils/scheduledReminders');
const MS = require('../src/utils/messageSchedules');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 900)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j, type: r.headers.get('content-type') };
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
const wdIst = (d) => new Date(new Date(d).getTime() + 330 * MIN).getUTCDay();
const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const TODAY = istDay(new Date());
const D = (n) => addDays(TODAY, n); // day n from today (India time)
const occ = (sid) => q('SELECT * FROM "ScheduledReminder" WHERE "scheduleId" = ? ORDER BY "sendAt"', sid);
const sched = async (sid) => (await q('SELECT * FROM "MessageSchedule" WHERE "id" = ?', sid))[0];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 8 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (tag, data) => prisma.user.create({ data: { name: `Sa ${tag} ${P}`, email: `sa.${tag}.${P}@sa-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const REC2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const RECX = await mk('recx', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' });
  const MGR = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const CLU = await mk('client', { role: 'CLIENT', atsRole: 'CLIENT', atsAccess: true });
  const client = await prisma.client.create({ data: { name: `Sa Hospital ${P}`, location: 'Hyderabad', ownerDepartment: 'Medical', bdeOwner: BDE.name, clientType: 'Client' } });
  const REQ = await prisma.requirement.create({ data: { title: `Sa Staff Nurse ${P}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, openings: 9, skills: 'Nursing', experience: '2-5', location: 'Hyderabad', salary: '4L - 6L CTC', jobDescription: 'Nurses needed.' } });
  const REQ2 = await prisma.requirement.create({ data: { title: `Sa ICU Nurse ${P}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: REC.id, tlId: TL.id, bdeId: BDE.id, openings: 9, skills: 'Nursing', experience: '2-5', location: 'Hyderabad', salary: '4L - 6L CTC', jobDescription: 'ICU nurses needed.' } });
  const clientM = await prisma.client.create({ data: { name: `Sa Factory ${P}`, location: 'Pune', ownerDepartment: 'Manufacturing', bdeOwner: BDE.name, clientType: 'Client' } });
  const REQM = await prisma.requirement.create({ data: { title: `Sa Fitter ${P}`, clientId: clientM.id, status: 'OPEN', department: 'Manufacturing', recruiterId: RECX.id, openings: 2, skills: 'Fitter', experience: '1-3', location: 'Pune', salary: '2L - 3L CTC', jobDescription: 'Fitters needed.' } });
  let seq = 0;
  const phoneOf = () => { seq += 1; return `7${String(P % 1000).padStart(3, '0')}${String(seq * 37 + 100000).slice(-6)}`; };
  const mkCand = (tag, data = {}) => prisma.candidate.create({ data: { name: `Sa ${tag} ${P}`, phone: phoneOf(), email: `sa.${tag}.${P}@sa-cand.in`, ...data } });
  const mkApp = (cand, req, data = {}) => prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'INTERVIEW_SCHEDULED', ownerRecruiterId: req === REQM ? RECX.id : REC.id, offeredCtc: 450000, ...data } });

  // ---------------------------------------------------------------- 0. a message scheduled BEFORE this feature (no schedule): adopted at start-up
  await SR.ensure();
  const CLEG = await mkCand('legacy'); const ALEG = await mkApp(CLEG, REQ);
  const legacyAt = atIst(D(3), '10:00').toISOString();
  const tnow = new Date().toISOString();
  await q(`INSERT INTO "ScheduledReminder" ("id","applicationId","candidateId","kind","eventAt","sendAt","channel","templateKey","language","status","stepKey","createdById","createdBy","createdAt","updatedAt","notifyIds","history","body")
    VALUES (?,?,?,'custom',?,?,'WhatsApp','custom','en','planned','MSG',?,?,?,?,?,'[]',?)`, `rem_leg${P}`, ALEG.id, CLEG.id, legacyAt, legacyAt, REC.id, REC.name, tnow, tnow, REC.id, 'Old message before the upgrade');
  const legacyRows = Number((await q('SELECT COUNT(*) AS n FROM "ScheduledReminder" WHERE "kind" = \'custom\'', ))[0].n);

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await sleep(500); } // eslint-disable-line no-await-in-loop
  await sleep(1100);
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
  const T = { A: await tok(adminRow.id), B: await tok(BDE.id), T: await tok(TL.id), R: await tok(REC.id), R2: await tok(REC2.id), X: await tok(RECX.id), M: await tok(MGR.id), C: await tok(CLU.id) };
  await setRow('email', { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'hr@zz-test.invalid', 'Default from name': 'TeamLink' });
  await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.display]: '+91 90000 00001', [CAT.WA_FIELDS.bulkTpl]: 'zz_general' });
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });
  await sleep(500);

  const mkS = (cids, over = {}, tk = T.R) => call('POST', '/ats/scheduled-messages', { candidateIds: Array.isArray(cids) ? cids : [cids], channel: 'WhatsApp', body: 'Hi {name}, this is {recruiter} about {requirement}.', kind: 'recurring', frequency: 'daily', startDate: D(1), startTime: '10:00', endMode: 'count', totalCount: 5, ...over }, tk);
  const sidOf = (r) => r.body && r.body.created && r.body.created[0] && r.body.created[0].scheduleId;

  console.log('0. Messages scheduled before the upgrade are kept (adopted as one-time schedules)');
  const opt = await call('GET', '/ats/scheduled-messages/options', null, T.R); // first use: the tables and the adoption
  await MS.ensure();
  const legRow = (await q('SELECT "id","scheduleId","seq","idemKey","status","sendAt","body" FROM "ScheduledReminder" WHERE "id" = ?', `rem_leg${P}`))[0];
  const legS = legRow && legRow.scheduleId ? await sched(legRow.scheduleId) : null;
  check('the old waiting message got a one-time schedule around it: same time, same words, still planned, nothing else changed', opt.status === 200 && legS && legS.kind === 'one-time' && legS.status === 'upcoming' && legS.startAt === legacyAt && legRow.status === 'planned' && legRow.sendAt === legacyAt && legRow.body === 'Old message before the upgrade' && legRow.idemKey === `${legS.id}#1`, [legRow, legS]);
  const again = await MS.migrateExisting();
  check('the adoption is idempotent: run again it adopts nothing, and no message row was added or removed', again === 0 && Number((await q('SELECT COUNT(*) AS n FROM "ScheduledReminder" WHERE "kind" = \'custom\''))[0].n) === legacyRows && Number((await q('SELECT COUNT(*) AS n FROM "MessageSchedule" WHERE "sourceRowId" = ?', `rem_leg${P}`))[0].n) === 1);
  check('the options give the time zones (India first), the limits (1-100 messages, 100 planned per candidate) and the 07:00-20:00 window', opt.body.timezones[0].value === 'Asia/Kolkata' && opt.body.limits.maxOccurrences === 100 && opt.body.limits.maxPlannedPerCandidate === 100 && opt.body.hours.windowStart === '07:00' && opt.body.hours.windowEnd === '20:00', opt.body);

  // ---------------------------------------------------------------- 1. patterns
  console.log('1. One-time, daily, weekly, monthly and custom schedules: exactly the planned times');
  const C1 = await mkCand('c1'); const A1 = await mkApp(C1, REQ);
  const one = await mkS(C1.id, { kind: 'one-time', startDate: D(2), startTime: '11:30', body: 'One time words' });
  const oneId = sidOf(one);
  const oneOcc = oneId ? await occ(oneId) : [];
  check('a one-time schedule: 1 message at 11:30 India time on the day picked, status Upcoming, linked to the application and its requirement and recruiter', one.status === 201 && oneOcc.length === 1 && istDay(oneOcc[0].sendAt) === D(2) && hm(oneOcc[0].sendAt) === '11:30' && (await sched(oneId)).status === 'upcoming' && (await sched(oneId)).applicationId === A1.id && (await sched(oneId)).requirementId === REQ.id && (await sched(oneId)).recruiterId === REC.id, [one.body, oneOcc]);
  const daily = await mkS(C1.id, { body: 'Daily words for {name}' });
  const dailyId = sidOf(daily);
  const dOcc = await occ(dailyId);
  check('daily x 5 from tomorrow 10:00: 5 messages on 5 days in a row at 10:00, numbered 1-5 with their own keys', daily.status === 201 && dOcc.length === 5 && dOcc.every((o, i) => istDay(o.sendAt) === D(1 + i) && hm(o.sendAt) === '10:00' && Number(o.seq) === i + 1 && o.idemKey === `${dailyId}#${i + 1}`), dOcc.map((o) => [o.sendAt, o.seq]));
  check('...and the summary the screen gets is the same plan: first, last, total 5, India time', daily.body.summary.total === 5 && istDay(daily.body.summary.first) === D(1) && istDay(daily.body.summary.last) === D(5) && /IST/.test(daily.body.summary.timezoneLabel) && daily.body.summary.lines.some((l) => l[0] === 'Last message'), daily.body.summary);
  const weekly = await mkS(C1.id, { frequency: 'weekly', weekdays: [1, 3], totalCount: 4, body: 'Weekly words' });
  const wOcc = await occ(sidOf(weekly));
  check('weekly on Mon and Wed x 4: 4 messages, only on Mondays and Wednesdays, in order', weekly.status === 201 && wOcc.length === 4 && wOcc.every((o) => [1, 3].includes(wdIst(o.sendAt))) && wOcc.every((o, i) => i === 0 || o.sendAt > wOcc[i - 1].sendAt), wOcc.map((o) => o.sendAt));
  const monthly = await mkS(C1.id, { frequency: 'monthly', monthDay: 31, totalCount: 3, body: 'Monthly words' });
  const mOcc = await occ(sidOf(monthly));
  const lastDay = (iso) => { const d = new Date(iso); const t = new Date(d.getTime() + 330 * MIN); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); };
  check('monthly on the 31st x 3: each on the 31st, or on the LAST day of a shorter month, in 3 months in a row', monthly.status === 201 && mOcc.length === 3 && mOcc.every((o) => Number(istDay(o.sendAt).slice(8)) === Math.min(31, lastDay(o.sendAt))) && mOcc.some((o) => lastDay(o.sendAt) < 31), mOcc.map((o) => o.sendAt));
  check('...and the summary says so (short months use the last day)', /fewer than 31 days it goes on the last day/.test(monthly.body.summary.notes.join(' ')), monthly.body.summary.notes);
  const hours = await mkS(C1.id, { frequency: 'custom', intervalValue: 5, intervalUnit: 'hours', startTime: '08:00', totalCount: 6, body: 'Every five hours' });
  const hOcc = await occ(sidOf(hours));
  check('custom every 5 hours from 08:00 x 6: 08, 13, 18 then the next day 09, 14, 19 (times outside 07:00-20:00 left out, not counted)', hours.status === 201 && hOcc.map((o) => `${istDay(o.sendAt) === D(1) ? 'd1' : 'd2'} ${hm(o.sendAt)}`).join(',') === 'd1 08:00,d1 13:00,d1 18:00,d2 09:00,d2 14:00,d2 19:00', hOcc.map((o) => o.sendAt));
  const until = await mkS(C1.id, { frequency: 'custom', intervalValue: 2, intervalUnit: 'days', endMode: 'until', endDate: D(9), totalCount: undefined, body: 'Every two days until' });
  const uOcc = await occ(sidOf(until));
  check('custom every 2 days until a date (9 days on): 5 messages, the last one on or before the end date', until.status === 201 && uOcc.length === 5 && istDay(uOcc[4].sendAt) === D(9) && until.body.summary.total === 5, uOcc.map((o) => o.sendAt));
  const weeks = await mkS(C1.id, { frequency: 'custom', intervalValue: 1, intervalUnit: 'weeks', totalCount: 3, body: 'Every week words' });
  const kOcc = await occ(sidOf(weeks));
  check('custom every 1 week x 3: 7 days apart', weeks.status === 201 && kOcc.length === 3 && istDay(kOcc[1].sendAt) === D(8) && istDay(kOcc[2].sendAt) === D(15), kOcc.map((o) => o.sendAt));
  const dubai = await mkS(C1.id, { timezone: 'Asia/Dubai', totalCount: 2, body: 'Dubai words' });
  const dbOcc = await occ(sidOf(dubai));
  check('a time zone other than India: 10:00 in Dubai is 11:30 India time', dubai.status === 201 && dbOcc.length === 2 && hm(dbOcc[0].sendAt) === '11:30', dbOcc.map((o) => o.sendAt));
  const prev = await call('POST', '/ats/scheduled-messages/preview', { kind: 'recurring', frequency: 'daily', startDate: D(1), startTime: '10:00', endMode: 'count', totalCount: 5 }, T.R);
  check('the live summary (preview) is computed by the engine: Start, Time 10:00 AM, Frequency Daily, Total 5, Last message, Timezone IST', prev.status === 200 && prev.body.ok && prev.body.summary.lines.map((l) => l[0]).join() === 'Start,Time,Frequency,Total,Last message,Timezone' && prev.body.summary.lines[1][1] === '10:00 AM' && prev.body.summary.lines[3][1] === '5 messages', prev.body);

  // ---------------------------------------------------------------- 2. validation
  console.log('2. What is refused');
  const refuse = async (name, over, re, status = 400) => { const r = await mkS(C1.id, { body: `refused ${Math.random()}`, ...over }); check(name, r.status === status && re.test((r.body && r.body.error) || ''), [r.status, r.body && r.body.error]); };
  await refuse('a start in the past', { startDate: D(-1) }, /no past dates|at least 5 minutes/);
  await refuse('an end date before the start', { endMode: 'until', endDate: D(0) }, /end date must be on or after/);
  await refuse('0 messages', { totalCount: 0 }, /1 to 100/);
  await refuse('101 messages', { totalCount: 101 }, /1 to 100/);
  await refuse('weekly with no weekday', { frequency: 'weekly', weekdays: [] }, /at least one weekday/);
  await refuse('monthly on day 32', { frequency: 'monthly', monthDay: 32 }, /1 to 31/);
  await refuse('a sending window outside 07:00-20:00', { windowStart: '06:00', windowEnd: '20:00' }, /inside 07:00-20:00/);
  await refuse('a start time outside the sending window', { startTime: '21:00' }, /inside the sending window/);
  await refuse('a start time outside a narrower window', { windowStart: '09:00', windowEnd: '12:00', startTime: '13:00' }, /inside the sending window \(09:00-12:00/);
  await refuse('an end date that would make more than 100 messages', { frequency: 'custom', intervalValue: 1, intervalUnit: 'hours', endMode: 'until', endDate: D(30) }, /more than 100 messages/);
  await refuse('an unknown time zone', { timezone: 'Mars/Base' }, /time zone/);
  await refuse('no message words', { body: '  ' }, /Write the message/);
  // duplicate prevention
  const dupA = await mkS(C1.id, { body: 'Same words twice', startDate: D(4) });
  const dupB = await mkS(C1.id, { body: 'Same words twice', startDate: D(4) });
  check('duplicate prevention: the same candidate + way + words + first time is refused the second time', dupA.status === 201 && dupB.status === 409 && /already scheduled/.test(dupB.body.error), dupB.body);
  const idemA = await mkS(C1.id, { body: 'Idempotent words', startDate: D(5), idempotencyKey: `k-${P}` });
  const idemB = await mkS(C1.id, { body: 'Idempotent words', startDate: D(5), idempotencyKey: `k-${P}` });
  check('the same request sent twice (a double click, a retry) with its idempotency key makes ONE schedule', idemA.status === 201 && idemB.status === 201 && sidOf(idemA) === sidOf(idemB) && idemB.body.created[0].repeated === true && Number((await q('SELECT COUNT(*) AS n FROM "MessageSchedule" WHERE "body" = ?', 'Idempotent words'))[0].n) === 1, [idemA.body, idemB.body]);
  // max 100 planned per candidate
  const CMAX = await mkCand('max'); await mkApp(CMAX, REQ);
  const big1 = await mkS(CMAX.id, { totalCount: 60, body: 'Sixty' });
  const big2 = await mkS(CMAX.id, { totalCount: 41, body: 'Forty one' });
  check('at most 100 planned messages per candidate: 60 + 41 is refused, 60 + 40 fits', big1.status === 201 && big2.status === 409 && /most is 100 per candidate/.test(big2.body.error) && (await mkS(CMAX.id, { totalCount: 40, body: 'Forty' })).status === 201, big2.body);
  const bigOcc = await occ(sidOf(big1));
  check('a long schedule (60 messages) is planned in a rolling window: 20 messages waiting at a time, the rest added as they go', bigOcc.length === 20 && Number(bigOcc[19].seq) === 20, bigOcc.length);

  // ---------------------------------------------------------------- 3. many candidates
  console.log('3. Many candidates at once: one schedule each; out of scope and opted-out ones refused / skipped one by one');
  const C2 = await mkCand('c2'); await mkApp(C2, REQ);
  const C3 = await mkCand('c3'); await mkApp(C3, REQ2);
  const CX = await mkCand('outside'); await mkApp(CX, REQM);
  const CDNC = await mkCand('dnc', { doNotContact: true }); await mkApp(CDNC, REQ);
  const CSTOP = await mkCand('stop'); await mkApp(CSTOP, REQ);
  const core = require('../src/utils/messagingCore');
  await prisma.appSetting.create({ data: { key: `msg.optout.WhatsApp.${core.normalizeMobile(CSTOP.phone).e164}`, value: new Date().toISOString() } });
  const many = await mkS([C2.id, C3.id, CX.id, CDNC.id, CSTOP.id], { body: 'Hello all {name}', totalCount: 3 });
  const createdIds = (many.body.created || []).map((c) => c.candidateId);
  check('2 of 5 are scheduled, each with its own schedule (its own progress and stop rules)', many.status === 201 && createdIds.length === 2 && createdIds.includes(C2.id) && createdIds.includes(C3.id) && new Set(many.body.created.map((c) => c.scheduleId)).size === 2, many.body);
  const ref = (many.body.refused || []).find((r) => r.candidateId === CX.id);
  check('the candidate outside the recruiter\'s scope is refused with the reason, and the name is NOT revealed', ref && /outside your scope/.test(ref.reason) && !ref.name && !JSON.stringify(many.body).includes(CX.name), many.body.refused);
  const sk = many.body.skipped || [];
  check('the do-not-contact and the STOP candidates are skipped with their reasons', sk.length === 2 && sk.some((s) => s.candidateId === CDNC.id && /not to be contacted/.test(s.reason)) && sk.some((s) => s.candidateId === CSTOP.id && /replied STOP/.test(s.reason)), sk);
  check('the result says it in one line (2 scheduled, 2 skipped, 1 refused)', /2 scheduled, 2 skipped, 1 refused/.test(many.body.message), many.body.message);

  // ---------------------------------------------------------------- 4. scope
  console.log('4. Who sees what');
  const lr = await call('GET', '/ats/scheduled-messages', null, T.R);
  check('the recruiter\'s page lists their own candidates\' schedules with the 13 facts (name, mobile, email, job, recruiter, way, first, next, total, sent, delivered, failed, last sent, created by)', lr.status === 200 && lr.body.rows.some((r) => r.id === dailyId) && (() => { const r = lr.body.rows.find((x) => x.id === dailyId); return r.candidate.name === C1.name && r.candidate.phone && r.candidate.email && r.requirement === REQ.title && r.recruiter === REC.name && r.channel === 'WhatsApp' && r.firstAt && r.nextAt && r.totalPlanned === 5 && r.counts.sent === 0 && r.counts.delivered === 0 && r.counts.failed === 0 && r.lastSentAt === null && r.createdBy === REC.name && r.frequencyLabel === 'Daily x 5'; })(), lr.body.rows && lr.body.rows.find((x) => x.id === dailyId));
  const l2 = await call('GET', '/ats/scheduled-messages', null, T.R2);
  check('another recruiter of the same department does not see them (own candidates only), nor open one (404)', l2.status === 200 && !l2.body.rows.some((r) => r.candidateId === C1.id) && (await call('GET', `/ats/scheduled-messages/${dailyId}`, null, T.R2)).status === 404 && (await call('POST', `/ats/scheduled-messages/${dailyId}/pause`, {}, T.R2)).status === 404);
  check('a recruiter of another department neither', !(await call('GET', '/ats/scheduled-messages', null, T.X)).body.rows.some((r) => r.candidateId === C1.id));
  const lt = await call('GET', '/ats/scheduled-messages', null, T.T);
  check('the team lead sees the team\'s schedules (scope team)', lt.status === 200 && lt.body.scope === 'team' && lt.body.rows.some((r) => r.id === dailyId), lt.body.scope);
  check('the Manager and the Admin see all (scope all)', (await call('GET', '/ats/scheduled-messages', null, T.M)).body.scope === 'all' && (await call('GET', '/ats/scheduled-messages', null, T.A)).body.rows.some((r) => r.id === dailyId));
  const lb = await call('GET', '/ats/scheduled-messages', null, T.B);
  check('the BDE gets COUNTS only: no rows, no words, no phone numbers', lb.status === 200 && lb.body.countOnly === true && !lb.body.rows && lb.body.counts.total >= 1 && !JSON.stringify(lb.body).includes('Daily words') && !JSON.stringify(lb.body).includes(C1.phone), lb.body);
  const lbOne = await call('GET', `/ats/scheduled-messages/${dailyId}`, null, T.B);
  check('...a BDE opening one schedule sees no words, no phone, no provider ids', lbOne.status === 200 && lbOne.body.access === 'count' && !lbOne.body.schedule.body && !lbOne.body.schedule.candidate.phone && lbOne.body.occurrences.every((o) => !o.providerMessageId && !o.text), lbOne.body);
  check('...and the BDE cannot schedule, pause or export', (await mkS(C1.id, { body: 'by bde' }, T.B)).status === 403 && (await call('POST', `/ats/scheduled-messages/${dailyId}/pause`, {}, T.B)).status === 403 && (await call('GET', '/ats/scheduled-messages/export?format=xlsx', null, T.B)).status === 403);
  check('a client login gets nothing (403), no login 401', (await call('GET', '/ats/scheduled-messages', null, T.C)).status === 403 && (await call('GET', '/ats/scheduled-messages', null, null)).status === 401 && [401, 403].includes((await mkS(C1.id, { body: 'by client' }, T.C)).status));

  // ---------------------------------------------------------------- 5. the page: filters, tabs, export
  console.log('5. The Scheduled Messages page: cards, tabs, filters, Excel');
  const lAll = await call('GET', '/ats/scheduled-messages', null, T.A);
  check('the cards: Total, Completed, Upcoming, Failed, Active, Paused, Cancelled', ['total', 'completed', 'upcoming', 'failed', 'active', 'paused', 'cancelled'].every((k) => typeof lAll.body.counts[k] === 'number') && lAll.body.counts.upcoming >= 10, lAll.body.counts);
  const fEmail = await call('GET', '/ats/scheduled-messages?channel=Email', null, T.R);
  const fCand = await call('GET', `/ats/scheduled-messages?candidate=${encodeURIComponent('Sa c2')}`, null, T.R);
  const fReq = await call('GET', `/ats/scheduled-messages?requirement=${REQ2.id}`, null, T.R);
  const fRec = await call('GET', `/ats/scheduled-messages?recruiter=${REC.id}`, null, T.T);
  const fRange = await call('GET', `/ats/scheduled-messages?from=${D(14)}&to=${D(16)}`, null, T.R);
  const fStatus = await call('GET', '/ats/scheduled-messages?status=upcoming,paused', null, T.R);
  check('filters: channel (none by Email yet), candidate search, requirement, recruiter, date range, status (several at once)', fEmail.body.rows.length === 0 && fCand.body.rows.length >= 1 && fCand.body.rows.every((r) => r.candidate.name === C2.name)
    && fReq.body.rows.length === 1 && fReq.body.rows[0].candidateId === C3.id && fRec.body.rows.length >= 10 && fRec.body.rows.every((r) => r.recruiterId === REC.id)
    && fRange.body.rows.some((r) => r.id === sidOf(weeks)) && !fRange.body.rows.some((r) => r.id === oneId) && fStatus.body.rows.every((r) => ['upcoming', 'paused'].includes(r.status)), [fEmail.body.rows.length, fCand.body.rows.length, fReq.body.rows.length, fRec.body.rows.length, fRange.body.rows.map((r) => [r.frequencyLabel, r.firstAt]), fStatus.body.rows.map((r) => r.status), sidOf(weeks), fCand.body.rows.map((r) => r.candidate.name), C2.name]);
  check('the filters offer their values with counts (recruiter, requirement, channel, status)', lr.body.facets.recruiter.some((f) => f.value === REC.id && f.count >= 1) && lr.body.facets.requirement.some((f) => f.value === REQ.id) && lr.body.facets.channel.length === 3 && lr.body.facets.status.length === 6);
  const xl = await fetch(`${API}/ats/scheduled-messages/export?format=xlsx&channel=WhatsApp`, { headers: { Authorization: `Bearer ${T.R}` } });
  const xlBuf = Buffer.from(await xl.arrayBuffer());
  check('Excel download of the filtered list (an .xlsx file), audited', xl.status === 200 && /spreadsheet|octet/.test(xl.headers.get('content-type') || '') && xlBuf.slice(0, 2).toString() === 'PK' && (await prisma.auditLog.count({ where: { userId: REC.id, action: { contains: 'Scheduled messages' } } })) >= 1, [xl.status, xl.headers.get('content-type')]);

  // ---------------------------------------------------------------- 6. the worker: sending, retries, restart, delivery, windows
  console.log('6. Sending (worker with a simulated clock and a stand-in provider)');
  const seen = [];
  const messaging = require('../src/utils/messaging');
  const realSend = messaging.send;
  let failMode = null;
  let refSeq = 0;
  messaging.send = async (channel, opts) => {
    seen.push({ channel, opts });
    if (failMode === 'transient') return { ok: false, outcome: 'Failed', transient: true, error: 'WhatsApp HTTP 503: try later' };
    refSeq += 1;
    return { ok: true, outcome: 'Sent', providerRef: `wamid.zz${P}x${refSeq}`, response: 'accepted (stand-in provider)' };
  };
  // the schedules of the sections above are parked so each worker test sees only its own
  const park = async () => {
    await q("UPDATE \"MessageSchedule\" SET \"status\" = 'cancelled', \"stopReason\" = 'parked by the test' WHERE \"status\" IN ('upcoming','active','paused')");
    await q("UPDATE \"ScheduledReminder\" SET \"status\" = 'cancelled', \"reason\" = 'parked by the test' WHERE \"kind\" = 'custom' AND \"status\" = 'planned'");
  };
  await park();
  const sentTo = (cand) => seen.filter((s) => (s.opts.meta && s.opts.meta.personId) === cand.id);
  const t1 = atIst(D(1), '10:00').getTime();
  const CW = await mkCand('worker'); await mkApp(CW, REQ);
  const w5 = await mkS(CW.id, { body: 'Daily for {name} from {recruiter}' });
  const w5Id = sidOf(w5);
  const run = (ms) => SR.run({ now: new Date(ms) });
  await run(t1 - 30 * MIN);
  check('before its time nothing goes', sentTo(CW).length === 0);
  await run(t1 + MIN);
  let o5 = await occ(w5Id);
  check('at its time message 1 goes (even with the automatic reminders switch OFF); the schedule is Active, 1 / 5', sentTo(CW).length === 1 && o5[0].status === 'sent' && o5[0].sentAt && (await sched(w5Id)).status === 'active', o5.map((o) => o.status));
  check('the placeholders are filled when it goes and the STOP line is added; the credits are the scheduler\'s (meta carries the message key)', /^Daily for Sa from Sa rec/.test(sentTo(CW)[0].opts.text) && /Reply STOP/.test(sentTo(CW)[0].opts.text) && sentTo(CW)[0].opts.actorUserId === REC.id && sentTo(CW)[0].opts.meta.idempotencyKey === `${w5Id}#1`, sentTo(CW)[0].opts);
  check('SENT means the provider accepted it: status sent, provider id kept, NOT delivered (no delivery time yet)', o5[0].status === 'sent' && o5[0].providerRef === `wamid.zz${P}x${refSeq}` && !o5[0].deliveredAt && o5[0].deliveryStatus === 'Sent' && (await call('GET', `/ats/scheduled-messages/${w5Id}`, null, T.R)).body.schedule.counts.delivered === 0, o5[0]);
  await run(t1 + 2 * MIN);
  check('the worker run again sends nothing twice', sentTo(CW).length === 1);
  // the provider's delivery report (a simulated callback through utils/messageDelivery.applyStatus, the webhook path)
  const MD = require('../src/utils/messageDelivery');
  await MD.applyStatus({ channel: 'WhatsApp', providerRef: o5[0].providerRef, status: 'delivered', at: new Date(t1 + 3 * MIN).toISOString() });
  o5 = await occ(w5Id);
  const g5 = await call('GET', `/ats/scheduled-messages/${w5Id}`, null, T.R);
  check('DELIVERED only after the provider\'s delivery report: status delivered with its delivery time; the schedule counts 1 delivered', o5[0].status === 'delivered' && o5[0].deliveredAt && g5.body.schedule.counts.delivered === 1 && g5.body.occurrences[0].deliveredAt && g5.body.occurrences[0].providerMessageId === o5[0].providerRef, [o5[0], g5.body.schedule.counts]);
  const cm = await prisma.candidateMessage.findMany({ where: { candidateId: CW.id, template: 'SCHEDULED_MESSAGE' } });
  check('the candidate\'s communication history has the message: "Scheduled message 1 of 5 (Daily x 5)", with the provider id and the delivered tick', cm.length === 1 && cm[0].templateLabel === 'Scheduled message 1 of 5 (Daily x 5)' && cm[0].providerRef === o5[0].providerRef && cm[0].status === 'DELIVERED', cm.map((m) => [m.templateLabel, m.status]));
  const hist = await call('GET', `/ats/scheduled-messages/candidate/${CW.id}`, null, T.R);
  check('the candidate\'s schedule history lists every message: scheduled, sent, delivered time, provider id, status, reason, tries', hist.status === 200 && hist.body.occurrences.length === 5 && hist.body.occurrences.some((o) => o.status === 'delivered' && o.sentAt && o.deliveredAt && o.providerMessageId && o.attempts === 1 && o.scheduleLabel === 'Daily x 5'), hist.body.occurrences && hist.body.occurrences.slice(-1));
  // pause / resume
  await run(t1 + DAY + MIN);
  check('message 2 goes the next day (2 / 5)', sentTo(CW).length === 2);
  const pz = await call('POST', `/ats/scheduled-messages/${w5Id}/pause`, { reason: 'Candidate on leave' }, T.R);
  check('Pause: the schedule is Paused, its waiting messages are taken out, the sent ones stay', pz.status === 200 && pz.body.schedule.status === 'paused' && pz.body.occurrences.length === 2 && pz.body.occurrences.every((o) => ['sent', 'delivered'].includes(o.status)) && pz.body.schedule.nextAt === null, pz.body);
  await run(t1 + 2 * DAY + MIN);
  check('while paused nothing goes', sentTo(CW).length === 2);
  const rz = await call('POST', `/ats/scheduled-messages/${w5Id}/resume`, {}, T.R);
  const rzP = rz.body.occurrences.filter((o) => o.status === 'planned');
  check('Resume: the 3 remaining messages are planned again (5 in all), Active', rz.status === 200 && rz.body.schedule.status === 'active' && rzP.length === 3 && rz.body.schedule.totalPlanned === 5, rz.body.occurrences.map((o) => [o.status, o.scheduledAt]));
  await run(Date.parse(rzP[0].scheduledAt) + MIN);
  check('...and they go again (3 / 5)', sentTo(CW).length === 3);
  check('pause and resume are audited', (await prisma.auditLog.count({ where: { entityId: CW.id, action: { in: ['Message schedule paused', 'Message schedule resumed'] } } })) === 2);
  // edit: the waiting ones are planned again, the sent ones stay
  const ed = await call('PATCH', `/ats/scheduled-messages/${w5Id}`, { body: 'New words for {name}', startDate: istDay(rzP[1].scheduledAt), startTime: '11:00' }, T.R);
  const edOcc = await occ(w5Id);
  check('Edit (words + time): the 3 sent messages keep their time and words; the 2 waiting ones are planned again at 11:00 with the new words; still 5 in all', ed.status === 200 && edOcc.length === 5 && edOcc.filter((o) => ['sent', 'delivered'].includes(o.status)).length === 3 && edOcc.filter((o) => o.status === 'planned').every((o) => hm(o.sendAt) === '11:00' && o.body === 'New words for {name}') && edOcc.filter((o) => o.status === 'planned').length === 2 && edOcc.filter((o) => o.status !== 'planned').every((o) => /Daily for/.test(o.message || '')), edOcc.map((o) => [o.status, o.sendAt, o.body]));
  check('an edit cannot make the total less than what has gone (3)', (await call('PATCH', `/ats/scheduled-messages/${w5Id}`, { totalCount: 3 }, T.R)).status === 400);
  check('an edit to a past start is refused', (await call('PATCH', `/ats/scheduled-messages/${w5Id}`, { startDate: D(-2), startTime: '10:00' }, T.R)).status === 400);
  // cancel
  const cx = await call('POST', `/ats/scheduled-messages/${w5Id}/cancel`, { reason: 'Joined elsewhere' }, T.R);
  check('Cancel: the schedule is Cancelled with who and why; its waiting messages are cancelled with the reason; nothing more goes', cx.status === 200 && cx.body.schedule.status === 'cancelled' && /Cancelled by Sa rec.*Joined elsewhere/.test(cx.body.schedule.stopReason) && cx.body.occurrences.filter((o) => o.status === 'cancelled').length === 2, cx.body.schedule);
  await run(t1 + 9 * DAY);
  check('...and the worker sends none of them', sentTo(CW).length === 3);
  check('a cancelled schedule cannot be paused, resumed or edited', (await call('POST', `/ats/scheduled-messages/${w5Id}/pause`, {}, T.R)).status === 409 && (await call('POST', `/ats/scheduled-messages/${w5Id}/resume`, {}, T.R)).status === 409 && (await call('PATCH', `/ats/scheduled-messages/${w5Id}`, { body: 'x' }, T.R)).status === 409);

  // until manually stopped: the rolling window is extended by the worker
  await park();
  const CMAN = await mkCand('manual'); await mkApp(CMAN, REQ);
  const man = await mkS(CMAN.id, { endMode: 'manual', totalCount: undefined, startTime: '09:00', body: 'Until stopped' });
  const manId = sidOf(man);
  const manOcc0 = await occ(manId);
  check('until manually stopped: only the next 14 days are planned (at most 20), the summary says it goes on until stopped', man.status === 201 && manOcc0.length >= 13 && manOcc0.length <= 15 && man.body.summary.manual === true && man.body.summary.total === null, [manOcc0.length, man.body.summary]);
  await run(atIst(D(12), '09:01').getTime());
  const manOcc1 = await occ(manId);
  const maxSeq = Math.max(...manOcc1.map((o) => Number(o.seq)));
  check('12 days on, the worker has planned more (the window rolls on), still at most 20 waiting; the missed ones were not sent late', maxSeq > manOcc0.length + 5 && manOcc1.filter((o) => o.status === 'planned').length <= 20 && sentTo(CMAN).length === 1 && manOcc1.filter((o) => o.status === 'skipped').length >= 10, [maxSeq, manOcc1.length, sentTo(CMAN).length]);
  const mstop = await call('POST', `/ats/scheduled-messages/${manId}/cancel`, { reason: 'Stopped by hand' }, T.R);
  check('stopping it by hand ends it: nothing waiting any more', mstop.body.schedule.status === 'cancelled' && !(await occ(manId)).some((o) => o.status === 'planned'));

  // retries
  await park();
  const CRT = await mkCand('retry'); await mkApp(CRT, REQ);
  const rt = await mkS(CRT.id, { kind: 'one-time', startTime: '14:00', body: 'Retry me' });
  const rtId = sidOf(rt);
  const tr = atIst(D(1), '14:00').getTime() + MIN;
  failMode = 'transient';
  await run(tr);
  let rtO = (await occ(rtId))[0];
  check('a temporary failure: it stays waiting, try 1 of 3 noted, the next try in 5 minutes', rtO.status === 'planned' && Number(rtO.attempts) === 1 && Date.parse(rtO.nextAttemptAt) === tr + 5 * MIN && /Try 1 of 3/.test(rtO.reason), rtO);
  failMode = null;
  await run(tr + 6 * MIN);
  rtO = (await occ(rtId))[0];
  check('the next try goes: sent after 2 tries; the one-time schedule is Completed', rtO.status === 'sent' && Number(rtO.attempts) === 2 && (await sched(rtId)).status === 'completed', [rtO.status, rtO.attempts, (await sched(rtId)).status]);

  // restart recovery
  await park();
  const CRA = await mkCand('restartA'); await mkApp(CRA, REQ);
  const CRB = await mkCand('restartB'); await mkApp(CRB, REQ);
  const ra = sidOf(await mkS(CRA.id, { kind: 'one-time', startTime: '15:00', body: 'Restart A' }));
  const rb = sidOf(await mkS(CRB.id, { kind: 'one-time', startTime: '15:00', body: 'Restart B' }));
  const old = new Date(Date.now() - 20 * MIN).toISOString();
  await q('UPDATE "ScheduledReminder" SET "status" = \'sending\', "claimedAt" = ?, "providerCallAt" = NULL, "updatedAt" = ? WHERE "scheduleId" = ?', old, old, ra);
  await q('UPDATE "ScheduledReminder" SET "status" = \'sending\', "claimedAt" = ?, "providerCallAt" = ?, "updatedAt" = ? WHERE "scheduleId" = ?', old, old, old, rb);
  const trs = atIst(D(1), '15:00').getTime() + MIN;
  await run(trs);
  await run(trs + MIN);
  const raO = (await occ(ra))[0]; const rbO = (await occ(rb))[0];
  check('restart: a message left "sending" before the provider was called goes once (it never left)', raO.status === 'sent' && sentTo(CRA).length === 1 && /Picked up again after a restart/.test(raO.history), raO);
  check('restart: a message left "sending" after the provider call started is NEVER sent again by itself (failed, with the reason)', rbO.status === 'failed' && sentTo(CRB).length === 0 && /may or may not have reached/.test(rbO.reason) && (await sched(rb)).status === 'failed', [rbO, (await sched(rb)).status]);

  // the quiet window
  await park();
  const CQ = await mkCand('quiet'); await mkApp(CQ, REQ);
  const qs = sidOf(await mkS(CQ.id, { kind: 'one-time', startTime: '11:55', windowStart: '09:00', windowEnd: '12:00', body: 'Quiet window' }));
  await run(atIst(D(1), '12:10').getTime());
  check('a message due inside its window but found after the window closed (12:10 > 12:00) waits; it is not sent outside the window', sentTo(CQ).length === 0 && (await occ(qs))[0].status === 'planned');
  await run(atIst(D(1), '12:04').getTime());
  check('...inside the window (with the 5 minutes grace) it goes', sentTo(CQ).length === 1);

  // ---------------------------------------------------------------- 7. the existing candidate tab still works and shows the schedules
  console.log('7. The candidate tab "Schedule a message" keeps working');
  const CT = await mkCand('tab'); const AT = await mkApp(CT, REQ);
  const tabOne = await call('POST', `/ats/reminders/messages/candidate/${CT.id}`, { channel: 'WhatsApp', sendAt: atIst(D(1), '10:00').toISOString(), body: 'Tab one-time', applicationId: AT.id }, T.R);
  const tabRow = tabOne.body && tabOne.body.message && (await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', tabOne.body.message.id))[0];
  check('a one-time message from the tab (as today) is also a one-time schedule', tabOne.status === 201 && tabRow.scheduleId && (await sched(tabRow.scheduleId)).kind === 'one-time', tabOne.body);
  const tabRec = await mkS(CT.id, { body: 'Tab recurring', totalCount: 3 });
  const tl = await call('GET', `/ats/reminders/messages/candidate/${CT.id}`, null, T.R);
  check('the tab lists the one-time message as before and the repeating schedule apart (its 3 messages are not mixed into the one-time list)', tl.status === 200 && tl.body.messages.length === 1 && tl.body.messages[0].body === 'Tab one-time' && tl.body.schedules.length === 1 && tl.body.schedules[0].id === sidOf(tabRec) && tl.body.advanced && tl.body.advanced.limits.maxOccurrences === 100, [tl.body.messages && tl.body.messages.length, tl.body.schedules]);
  const tEd = await call('PATCH', `/ats/reminders/messages/${tabRow.id}`, { sendAt: atIst(D(1), '16:00').toISOString() }, T.R);
  check('editing the one-time message on the tab moves its schedule too', tEd.status === 200 && hm((await sched(tabRow.scheduleId)).startAt) === '16:00');
  const recRow = (await occ(sidOf(tabRec)))[0];
  check('one message of a repeating schedule cannot be edited alone (edit the schedule), but can be cancelled alone', (await call('PATCH', `/ats/reminders/messages/${recRow.id}`, { body: 'x' }, T.R)).status === 409 && (await call('DELETE', `/ats/reminders/messages/${recRow.id}`, { reason: 'skip one' }, T.R)).status === 200 && (await sched(sidOf(tabRec))).status === 'upcoming');
  await call('DELETE', `/ats/reminders/messages/${tabRow.id}`, { reason: 'not needed' }, T.R);
  check('cancelling the one-time message on the tab cancels its schedule', (await sched(tabRow.scheduleId)).status === 'cancelled');

  // ---------------------------------------------------------------- 8. ATS triggers + stop rules
  console.log('8. The ATS triggers (all OFF by default) and the stop rules');
  const tg = await call('GET', '/ats/scheduled-messages/triggers', null, T.R);
  const ON6 = ['response_followup', 'interview_confirmation', 'interview_followup', 'client_feedback', 'document_request', 'selection'];
  check('the triggers are listed; six are ON by default (founder 2026-11-20), application received / initial follow-up / interview and joining reminders OFF', tg.status === 200 && tg.body.definitions.length === 10 && Object.entries(tg.body.triggers).every(([k, t]) => t.enabled === ON6.includes(k)) && tg.body.canEdit === false, tg.body.triggers);
  check('only an Admin may change them', (await call('PUT', '/ats/scheduled-messages/triggers', { triggers: { application_followup: { enabled: true } } }, T.R)).status === 403);
  check('an unknown placeholder in a trigger message is refused', (await call('PUT', '/ats/scheduled-messages/triggers', { triggers: { selection: { body: 'Hi {nam}' } } }, T.A)).status === 400);
  // OFF: nothing is made
  const COFF = await mkCand('off');
  const addOff = await call('POST', '/applications', { candidateId: COFF.id, requirementId: REQ.id, overrideReason: 'Test candidate for the scheduler' }, T.A);
  check('while the triggers are OFF, adding a candidate to a requirement makes no automatic message', addOff.status < 300 && Number((await q('SELECT COUNT(*) AS n FROM "MessageSchedule" WHERE "candidateId" = ?', COFF.id))[0].n) === 0, addOff.body);
  const on = await call('PUT', '/ats/scheduled-messages/triggers', { triggers: { application_received: { enabled: true }, application_followup: { enabled: true, delay: { value: 1, unit: 'days' }, every: { value: 2, unit: 'days' }, count: 3 }, interview_confirmation: { enabled: true }, interview_reminder: { enabled: true }, joining_reminder: { enabled: true }, document_request: { enabled: true }, client_feedback: { enabled: true } } }, T.A);
  check('the Admin switches some on (saved and audited)', on.status === 200 && on.body.triggers.application_followup.enabled === true && on.body.triggers.selection.enabled === true && (await prisma.auditLog.count({ where: { action: 'Automatic candidate messages changed' } })) >= 1, on.body);
  // response stop rule
  const CRP = await mkCand('reply');
  const addR = await call('POST', '/applications', { candidateId: CRP.id, requirementId: REQ.id, overrideReason: 'Test candidate for the scheduler' }, T.A);
  const trgRows = await q('SELECT * FROM "MessageSchedule" WHERE "candidateId" = ? ORDER BY "createdAt"', CRP.id);
  const recv = trgRows.find((s) => s.trigger === 'application_received');
  const fol = trgRows.find((s) => s.trigger === 'application_followup');
  check('adding a candidate makes "Application received" (one-time, at once) and "Initial follow-up" (every 2 days x 3 from tomorrow)', addR.status < 300 && recv && recv.kind === 'one-time' && fol && fol.kind === 'recurring' && Number(fol.totalCount) === 3 && (await occ(fol.id)).length === 3, trgRows.map((s) => [s.trigger, s.kind]));
  const again2 = await MS.onApplicationCreated({ id: addR.body.id || addR.body.application?.id || trgRows[0].applicationId }, { id: adminRow.id, name: 'x' });
  check('the trigger is idempotent: the same event again makes nothing new', Array.isArray(again2) && again2.length === 0 && Number((await q('SELECT COUNT(*) AS n FROM "MessageSchedule" WHERE "candidateId" = ?', CRP.id))[0].n) === 2);
  const manualR = sidOf(await mkS(CRP.id, { body: 'A manual one for the replier', totalCount: 2 }, T.A));
  const dl = await MD.applyInbound({ channel: 'WhatsApp', from: `+91${CRP.phone}`, text: 'Yes I am interested', id: `wamid.in${P}`, at: new Date().toISOString() });
  await sleep(300);
  const folAfter = await sched(fol.id);
  check('THE CANDIDATE REPLIED (an inbound WhatsApp): the no-response follow-up is Completed with the reason; its waiting messages are cancelled', dl && dl.candidateId === CRP.id && folAfter.status === 'completed' && /candidate replied/i.test(folAfter.stopReason) && (await occ(fol.id)).every((o) => o.status !== 'planned'), [dl, folAfter.status, folAfter.stopReason]);
  check('...the unrelated schedules of the same candidate are NOT touched (the manual one, the "Application received")', (await sched(manualR)).status === 'upcoming' && ['upcoming', 'completed'].includes((await sched(recv.id)).status) && !(await sched(recv.id)).stopReason, [(await sched(manualR)).status, (await sched(recv.id)).status]);
  // interview: booking, rescheduling, rejected
  const CI = await mkCand('iv'); const AI = await mkApp(CI, REQ, { stage: 'CLIENT_SHORTLISTED' }); const AI2 = await mkApp(CI, REQ2, { stage: 'CLIENT_SHORTLISTED' });
  const evDay = D(4);
  const bk = await call('POST', `/ats/interviews/${AI.id}/book`, { date: evDay, time: '12:00', mode: 'In Person', location: '5 Station Road, Hyderabad', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, T.B);
  const ivRows = async (appId) => q('SELECT * FROM "MessageSchedule" WHERE "applicationId" = ? AND "trigger" IN (\'interview_confirmation\',\'interview_reminder\') ORDER BY "startAt"', appId);
  const iv1 = await ivRows(AI.id);
  check('booking an interview makes the confirmation (at once) and the reminders 1 day and 1 hour before (each its own schedule, linked to the interview)', bk.status === 200 && iv1.length === 3 && iv1.filter((s) => s.trigger === 'interview_reminder').length === 2 && iv1.every((s) => s.interviewId && s.interviewId.startsWith(`${AI.id}@`)) && iv1.some((s) => hm(s.startAt) === '11:00' && istDay(s.startAt) === evDay), [bk.status, iv1.map((s) => [s.trigger, s.startAt])]);
  const ivMsg = (await occ(iv1.find((s) => s.trigger === 'interview_confirmation').id))[0];
  check('the interview message has the interview date and time written in', /interview for .* is booked for .* at 12:00 PM/.test(ivMsg.body), ivMsg.body);
  await call('POST', `/ats/interviews/${AI2.id}/book`, { date: evDay, time: '15:00', mode: 'In Person', location: '5 Station Road, Hyderabad', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, T.B);
  const manualI = sidOf(await mkS(CI.id, { body: 'Manual for the interview candidate', totalCount: 2 }, T.A));
  const newSlot = atIst(D(5), '15:00');
  const rs = await call('POST', `/ats/interviews/${AI.id}/reschedule`, { interviewAt: newSlot.toISOString(), reason: 'Client asked for a later day' }, T.A);
  const iv2 = await ivRows(AI.id);
  const oldOnes = iv2.filter((s) => iv1.some((o) => o.id === s.id));
  const newOnes = iv2.filter((s) => !iv1.some((o) => o.id === s.id));
  check('INTERVIEW RESCHEDULED: the old confirmation and reminders are cancelled with the reason; new ones are made for the new time', rs.status === 200 && oldOnes.every((s) => s.status === 'cancelled' && /rescheduled/.test(s.stopReason)) && newOnes.length === 3 && newOnes.every((s) => s.triggerAnchor === newSlot.toISOString()) && newOnes.some((s) => s.trigger === 'interview_reminder' && istDay(s.startAt) === D(4)), [rs.status, iv2.map((s) => [s.trigger, s.status, s.triggerAnchor])]);
  const rj = await call('PATCH', `/applications/${AI.id}/stage`, { stage: 'REJECTED', rejectedBy: 'Client', reasonCategory: 'Other', reasonDetail: 'Client said no', comment: 'zz' }, T.A);
  const iv3 = await ivRows(AI.id);
  check('REJECTED: that application\'s interview messages are cancelled with the reason', rj.status === 200 && iv3.filter((s) => newOnes.some((n) => n.id === s.id)).every((s) => s.status === 'cancelled' && /rejected/.test(s.stopReason)), [rj.status, rj.body && rj.body.error, iv3.map((s) => [s.status, s.stopReason])]);
  check('...the OTHER application\'s interview messages and the manual schedule are NOT touched', (await ivRows(AI2.id)).every((s) => s.status === 'upcoming') && (await ivRows(AI2.id)).length === 3 && (await sched(manualI)).status === 'upcoming');
  // withdrawn: that application's schedules (the manual one linked to it too); not the other application's
  const CWD = await mkCand('withdraw'); const AW1 = await mkApp(CWD, REQ, { stage: 'CLIENT_SHORTLISTED' }); const AW2 = await mkApp(CWD, REQ2, { stage: 'CLIENT_SHORTLISTED' });
  await call('POST', `/ats/interviews/${AW1.id}/book`, { date: D(4), time: '12:00', mode: 'In Person', location: '5 Station Road', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, T.B);
  const mW1 = sidOf(await mkS(CWD.id, { body: 'Manual linked to AW1', totalCount: 2, applicationId: AW1.id }, T.A));
  const mW2 = sidOf(await mkS(CWD.id, { body: 'Manual linked to AW2', totalCount: 2, applicationId: AW2.id }, T.A));
  const wd = await call('PATCH', `/applications/${AW1.id}/stage`, { stage: 'REJECTED', rejectedBy: 'Candidate', reasonCategory: 'Not Interested', reasonDetail: 'Candidate withdrew', comment: 'zz' }, T.A);
  const w1Rows = await q('SELECT * FROM "MessageSchedule" WHERE "applicationId" = ?', AW1.id);
  check('WITHDREW: every schedule of that application stops (its interview messages and the manual one linked to it), with the reason', wd.status === 200 && w1Rows.length >= 4 && w1Rows.every((s) => s.status === 'cancelled' && /withdrew/.test(s.stopReason)) && (await sched(mW1)).status === 'cancelled', [wd.status, w1Rows.map((s) => [s.trigger, s.status, s.stopReason])]);
  check('...the manual schedule of the candidate\'s OTHER application goes on', (await sched(mW2)).status === 'upcoming');
  // joining reminders: made when the joining date is set, completed when the candidate joins
  const CJ = await mkCand('join'); const AJ = await mkApp(CJ, REQ, { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted', documentsStatus: 'Verified', interviewStatus: 'FEEDBACK_SUBMITTED', interviewAt: new Date(Date.now() - 5 * DAY) });
  const manualJ = sidOf(await mkS(CJ.id, { body: 'Manual for the joiner', totalCount: 2 }, T.A));
  const jd = await call('POST', `/ats/joining/${AJ.id}/schedule`, { joiningDate: D(6), details: { venueName: 'HR Block', address: '12 MG Road', contactName: 'Mr Kiran', contactPhone: '9000000055', reportingTime: '09:00' } }, T.A);
  const jRows = await q('SELECT * FROM "MessageSchedule" WHERE "applicationId" = ? AND "trigger" = \'joining_reminder\'', AJ.id);
  check('setting the joining date makes the joining reminders (2 days and 1 day before)', jd.status === 200 && jRows.length === 2 && jRows.every((s) => s.status === 'upcoming'), [jd.status, jd.body && jd.body.error, jRows.length]);
  const jn = await call('POST', `/ats/joining/${AJ.id}/joined`, { joinedAt: D(0) }, T.A);
  const jAfter = await q('SELECT * FROM "MessageSchedule" WHERE "applicationId" = ? AND "trigger" = \'joining_reminder\'', AJ.id);
  check('JOINED (Mark joined): the joining reminders are Completed ("The candidate joined"); the manual schedule is not touched', jn.status === 200 && jAfter.length === 2 && jAfter.every((s) => s.status === 'completed' && /joined/.test(s.stopReason)) && (await sched(manualJ)).status === 'upcoming', [jn.status, jn.body && jn.body.error, jAfter.map((s) => [s.status, s.stopReason])]);
  // documents: a request every 2 days until the documents are received
  const CDOC = await mkCand('docs'); const ADOC = await mkApp(CDOC, REQ, { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted', documentsStatus: 'Pending' });
  await call('POST', `/ats/offers/${ADOC.id}/documents`, { documentsStatus: 'Pending' }, T.A);
  const docS = (await q('SELECT * FROM "MessageSchedule" WHERE "applicationId" = ? AND "trigger" = \'document_request\'', ADOC.id))[0];
  check('documents pending: a document request every 2 days (at most 5) is made', docS && docS.kind === 'recurring' && Number(docS.intervalValue) === 2 && docS.intervalUnit === 'days' && (await occ(docS.id)).length === 5, docS);
  const dr = await call('POST', `/ats/offers/${ADOC.id}/documents`, { documentsStatus: 'Submitted' }, T.A);
  check('documents received: the document requests are Completed with the reason', dr.status === 200 && (await sched(docS.id)).status === 'completed' && /documents were received/.test((await sched(docS.id)).stopReason), [dr.status, await sched(docS.id)]);
  // a trigger switched off later: its waiting messages do not go (checked again when due)
  await park();
  const CTO = await mkCand('trigoff');
  await call('POST', '/applications', { candidateId: CTO.id, requirementId: REQ.id, overrideReason: 'Test candidate for the scheduler' }, T.A);
  const toF = (await q('SELECT * FROM "MessageSchedule" WHERE "candidateId" = ? AND "trigger" = \'application_followup\'', CTO.id))[0];
  await call('PUT', '/ats/scheduled-messages/triggers', { triggers: { application_followup: { enabled: false } } }, T.A);
  const toO = (await occ(toF.id))[0];
  await run(Date.parse(toO.sendAt) + MIN);
  check('a trigger switched off by the Admin: its waiting message does not go, the schedule is cancelled with the reason', sentTo(CTO).filter((s) => /call me back/.test(s.opts.text)).length === 0 && (await sched(toF.id)).status === 'cancelled' && /switched the automatic/.test((await sched(toF.id)).stopReason), await sched(toF.id));
  // the existing automatic interview reminders keep working as they are
  const CAR = await mkCand('autorem'); const AAR = await mkApp(CAR, REQ);
  const bkA = await call('POST', `/ats/interviews/${AAR.id}/book`, { date: D(4), time: '12:00', mode: 'In Person', location: '5 Station Road', panel: [{ userId: REC.id }], details: { venueName: 'City Clinic' } }, T.B);
  const arRows = await q('SELECT * FROM "ScheduledReminder" WHERE "applicationId" = ? AND "kind" = \'interview\'', AAR.id);
  const up = await call('GET', '/ats/reminders/upcoming', null, T.R);
  check('the existing automatic interview reminders are still planned as before (kind interview), and the dashboard card still answers', bkA.status === 200 && arRows.length >= 3 && up.status === 200, [bkA.status, arRows.length, up.status]);

  messaging.send = realSend;
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
