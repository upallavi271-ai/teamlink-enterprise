#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ATTENDANCE ALERT EMAILS: "Send at once" / "Daily email only" / "Do not email" (founder, 2026-10-15). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/attendance-alert-mail-test.js
//
// ZZTEST AM people: A (no check-in), B (on time, checked out), C (late, no check-out), D (no check-out), E (approved leave),
// F (not joined yet), G (relieved). Mail goes through a captured mailer (never a socket). The two settings rows are restored.
//
//   D  defaults: Send at once, master switch OFF
//   O  master OFF: honest status "Not sent: emails are switched off by Admin", nothing handed to the mailer
//   N  Send at once: exactly one email per person per event per day, existing wording, idempotent over two ticks
//   Q  quiet people: leave / not joined / relieved / on-time get nothing
//   W  Daily email only: parked ("Waiting for the daily email"), one daily email later
//   X  Do not email: no email at all, bell still delivered; per-event override
//   M  mail not set up / no address / failed -> plain statuses; retry with backoff, give up, resend
//   F  no flood on switching ON; "Send the waiting ones now" is capped and needs a confirm
//   R  role gates (employee refused; HR / Admin allowed) and the honest status in the log route
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('AM');
const { prisma, call, check, RUN } = Z;
const path = require('path');

const HN = require(path.join(Z.BACK, 'src/utils/hrmsNotify'));
const AA = require(path.join(Z.BACK, 'src/utils/attendanceAlerts'));
const D = require(path.join(Z.BACK, 'src/utils/attendanceDays'));

(async () => {
  await Z.preclean();
  const mails = [];
  let behaviour = 'ok';
  const mailer = async (m) => {
    mails.push(m);
    if (behaviour === 'notconfigured') return { ok: false, notConfigured: true, error: 'No SMTP host.' };
    if (behaviour === 'fail') return { ok: false, error: 'connection reset (boom)', transient: true };
    return { ok: true, providerRef: 'captured' };
  };
  const origHN = await prisma.integration.findUnique({ where: { id: HN.STORE_ID } });
  const origAA = await prisma.integration.findUnique({ where: { id: AA.STORE_ID } });
  const restore = async () => {
    for (const [id, orig] of [[HN.STORE_ID, origHN], [AA.STORE_ID, origAA]]) {
      if (orig) await prisma.integration.upsert({ where: { id }, update: { values: orig.values, enabled: orig.enabled, state: orig.state, lastSync: orig.lastSync }, create: orig });
      else await prisma.integration.deleteMany({ where: { id } });
    }
  };
  try {
    await prisma.integration.deleteMany({ where: { id: HN.STORE_ID } });
    const today = D.localDate(new Date());
    const tomorrow = new Date(Date.now() + 86400000 + 330 * 60000).toISOString().slice(0, 10);
    const now = new Date(`${today}T19:30:00`);
    const emp = { designation: 'Employee' };
    const uAdmin = await Z.mkUser('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', hrmsAccess: true }, { designation: 'Admin' });
    const uTl = await Z.mkUser('tl', { role: 'TL', hrmsRole: 'TL', hrmsAccess: true }, { designation: 'TL' });
    const uHr = await Z.mkUser('hr', { role: 'HR', hrmsRole: 'HR', hrmsAccess: true }, { designation: 'HR' });
    const A = await Z.mkUser('a', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, emp);
    const B = await Z.mkUser('b', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, emp);
    const C = await Z.mkUser('c', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, emp);
    const Dd = await Z.mkUser('d', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, emp);
    const E = await Z.mkUser('e', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, emp);
    const F = await Z.mkUser('f', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { ...emp, dateOfJoining: new Date(`${tomorrow}T00:00:00.000Z`) });
    const G = await Z.mkUser('g', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true }, { ...emp, employmentStatus: 'Relieved' });
    const users = { A, B, C, D: Dd, E, F, G };
    const empOf = {};
    for (const [k, u] of Object.entries(users)) empOf[k] = await prisma.employee.findFirst({ where: { userId: u.id } });
    const scope = { employeeIds: Object.values(empOf).map((e) => e.id), userIds: [...Object.values(users).map((u) => u.id)] };
    const punch = (k, time, direction = 'In') => prisma.attendancePunch.create({ data: { employeeId: empOf[k].id, date: today, time, direction, method: 'Web Check-in', source: 'Web' } });
    await punch('B', '09:00'); await punch('B', '18:30', 'Out'); // on time, checked out
    await punch('C', '10:30'); // late, never checked out
    await punch('D', '09:00'); // on time, never checked out
    await prisma.leaveRequest.create({ data: { employeeId: empOf.E.id, type: 'Casual', fromDate: today, toDate: today, days: 1, status: 'Approved' } });
    const T = {};
    for (const [k, u] of Object.entries({ A, admin: uAdmin, hr: uHr, tl: uTl })) T[k] = await Z.mint(u);
    const override = { goLiveAt: '2020-01-01T00:00:00.000Z', inApp: true, email: true };
    const wipe = () => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: scope.userIds } }, { recipient: { contains: 'zz-am-' } }] } });
    const tick = () => AA.run({ now, testMode: true, scope, mailer, override });
    const emailRows = () => prisma.notification.findMany({ where: { channel: 'Email', recipient: { contains: 'zz-am-' } }, orderBy: { createdAt: 'asc' } });
    const to = (u) => mails.filter((m) => m.to === u.email);
    const reset = async () => { await wipe(); mails.length = 0; };
    const settle = (patch) => HN.saveSettings(patch, uAdmin.id);

    // ---- D defaults --------------------------------------------------------------------------------
    const s0 = await HN.getSettings();
    check('D1 default: attendance alert emails are "Send at once"', s0.mailMode === 'now' && HN.modeOf(s0, 'missingCheckIn') === 'now' && HN.modeOf(s0, 'lateLogin') === 'now' && HN.modeOf(s0, 'missingCheckOut') === 'now', s0.mailMode);
    check('D2 default: the master switch "Notification emails" is OFF (nothing ships ON)', s0.emailsOn === false && s0.emailsOnAt === null, s0);
    check('D3 leave decisions share the pipeline and stay "at once"; tasks stay daily', HN.modeOf(s0, 'leaveDecision') === 'now' && HN.modeOf(s0, 'latePermission') === 'now' && HN.modeOf(s0, 'taskDue') === 'daily', null);

    // ---- O master OFF ---------------------------------------------------------------------------------
    await reset();
    const o1 = await tick();
    let rows = await emailRows();
    check('O1 master OFF: the alerts exist (A no check-in, C late + no check-out, D no check-out) and nothing reached the mailer', o1.events === 4 && mails.length === 0, [o1.events, mails.length, o1.byType]);
    check('O2 every email line says "Not sent: emails are switched off by Admin" - never "waiting for the daily email"', rows.length === 4 && rows.every((r) => r.status === HN.EMAILS_OFF), rows.map((r) => r.status));
    const bells = await prisma.notification.count({ where: { channel: 'In-App', status: 'Delivered', userId: { in: scope.userIds } } });
    check('O3 the in-app row is still Delivered (4 alerts)', bells === 4, bells);
    await tick();
    check('O4 a second tick adds nothing (one row per person per event per day)', (await emailRows()).length === 4, null);

    // ---- N send at once ---------------------------------------------------------------------------------
    await reset();
    const on = await settle({ emailsOn: true });
    check('N0 switching ON remembers the moment (emailsOnAt)', !!on.settings.emailsOn && !!on.settings.emailsOnAt, on.settings.emailsOnAt);
    const n1 = await tick();
    rows = await emailRows();
    check('N1 Send at once: exactly 4 emails (A 1, C 2, D 1), each to its own person', mails.length === 4 && to(A).length === 1 && to(C).length === 2 && to(Dd).length === 1 && n1.emails === 4, [mails.length, to(A).length, to(C).length, to(Dd).length]);
    check('N2 the existing wording is kept (missing check-in text, shift start 09:00, regularization hint)', /No check-in has been recorded for you today/.test(to(A)[0].text) && /your shift started at 09:00/.test(to(A)[0].text) && /Attendance → Regularization/.test(to(A)[0].text) && /^TeamLink — Missing check-in — /.test(to(A)[0].subject), to(A)[0] && to(A)[0].text);
    check('N3 C got the late text and the missing check-out text; D the missing check-out text', to(C).some((m) => /Your first check-in today/.test(m.text)) && to(C).some((m) => /no check-out has been recorded/.test(m.text)) && /no check-out has been recorded/.test(to(Dd)[0].text), null);
    check('N4 the log line says plainly "Sent" on every row', rows.length === 4 && rows.every((r) => r.status === 'Sent'), rows.map((r) => r.status));
    await tick(); await tick();
    check('N5 idempotent: two more ticks send nothing more (retries never double-send)', mails.length === 4 && (await emailRows()).length === 4, mails.length);
    const dig = await HN.sendDigests({ now, mailer, testMode: true, scope, settings: await HN.getSettings() });
    check('N6 the daily email has nothing to add (no copy of what was already sent)', dig.emails === 0 && mails.length === 4, dig);

    // ---- Q quiet people -----------------------------------------------------------------------------------
    check('Q1 approved leave, not joined yet, relieved, and an on-time person get NO alert and NO email', [E, F, G, B].every((u) => to(u).length === 0) && !(await prisma.notification.count({ where: { userId: { in: [E.id, F.id, G.id, B.id] } } })), null);

    // ---- W daily email only -------------------------------------------------------------------------------------
    await reset();
    await settle({ mailMode: 'daily' });
    await tick();
    rows = await emailRows();
    check('W1 Daily email only: nothing is sent now; 4 lines wait with the honest status "Waiting for the daily email"', mails.length === 0 && rows.length === 4 && rows.every((r) => r.status === HN.WAITING), [mails.length, rows.map((r) => r.status)]);
    const sw = await HN.getSettings();
    check('W2 the log shows "Waiting for the daily email" only because the mode is daily and emails are ON', rows.every((r) => HN.displayStatus(r, sw) === HN.WAITING), null);
    const d2 = await HN.sendDigests({ now, mailer, testMode: true, scope, settings: sw });
    check('W3 at the daily time ONE email per person goes (C gets one email with both items)', d2.emails === 3 && mails.length === 3 && /\(2\)/.test(to(C)[0].subject), [d2, mails.map((m) => m.subject)]);
    await settle({ emailsOn: false });
    await reset();
    await tick();
    rows = await emailRows();
    const swOff = await HN.getSettings();
    check('W4 daily mode while the master switch is OFF also says "Not sent: emails are switched off by Admin"', rows.length === 4 && rows.every((r) => HN.displayStatus(r, swOff) === HN.EMAILS_OFF), rows.map((r) => r.status));
    const legacy = { channel: 'Email', status: HN.WAITING, createdAt: new Date() };
    check('W5 an OLD waiting line is shown as switched off too while the switch is OFF', HN.displayStatus(legacy, swOff) === HN.EMAILS_OFF, null);

    // ---- X do not email --------------------------------------------------------------------------------------------
    await reset();
    await settle({ emailsOn: true, mailMode: 'off' });
    await tick();
    check('X1 Do not email: no email, no Email line; the bell still gets its 4 alerts', mails.length === 0 && (await emailRows()).length === 0 && (await prisma.notification.count({ where: { channel: 'In-App', userId: { in: scope.userIds } } })) === 4, null);
    await reset();
    await settle({ mailMode: 'daily', events: { missingCheckIn: { mode: 'now' }, lateLogin: { mode: 'off' } } });
    await tick();
    rows = await emailRows();
    check('X2 per-event choices win: missing check-in at once (A mailed), late coming not emailed, check-out waits for the daily email', to(A).length === 1 && to(C).length === 0 && rows.filter((r) => r.status === HN.WAITING).length === 2 && !rows.some((r) => /Late login/.test(r.title)), rows.map((r) => `${r.title}:${r.status}`));
    const badMode = await HN.saveSettings({ mailMode: 'sometimes' }, uAdmin.id);
    check('X3 a wrong choice is refused in plain words', /Send at once/.test(badMode.error || ''), badMode);
    await settle({ mailMode: 'now', events: { missingCheckIn: { mode: '' }, lateLogin: { mode: '' } } });

    // ---- M statuses, retry, resend -----------------------------------------------------------------------------------
    await reset();
    behaviour = 'notconfigured';
    await tick();
    rows = await emailRows();
    check('M1 mail not set up: every line says "Not sent: mail is not set up"', rows.length === 4 && rows.every((r) => r.status === HN.NOT_SET_UP), rows.map((r) => r.status));
    await reset();
    const noAddr = await HN.notify('missingCheckIn', { userId: A.id, name: 'ZZTEST AM A', email: null }, { title: `Missing check-in — ZZTEST AM ${today}`, message: 'x' }, { now, mailer });
    check('M2 no email address: "Not sent: no email address" (the bell still goes)', noAddr.email === HN.NO_ADDRESS && noAddr.inApp === true, noAddr);
    await reset();
    behaviour = 'fail';
    await tick();
    rows = await emailRows();
    check('M3 the provider fails: "Failed: <reason> (will retry, 3 left)" and the bell is unaffected', rows.length === 4 && rows.every((r) => /^Failed: connection reset \(boom\) \(will retry, 3 left\)$/.test(r.status)), rows.map((r) => r.status));
    const base = Date.now();
    const at = (min) => new Date(base + min * 60000);
    const sOn = await HN.getSettings();
    let r1 = await HN.retryFailed({ now: at(1), mailer, testMode: true, scope, settings: sOn });
    check('M4 backoff: nothing is retried after 1 minute', r1.tried === 0, r1);
    r1 = await HN.retryFailed({ now: at(6), mailer, testMode: true, scope, settings: sOn });
    rows = await emailRows();
    check('M5 retry 1 after 5 minutes: still failing -> "2 left"', r1.tried === 4 && rows.every((r) => /will retry, 2 left/.test(r.status)), [r1, rows[0].status]);
    r1 = await HN.retryFailed({ now: at(7), mailer, testMode: true, scope, settings: sOn });
    check('M6 not again before the next backoff (20 minutes)', r1.tried === 0, r1);
    await HN.retryFailed({ now: at(21), mailer, testMode: true, scope, settings: sOn });
    await HN.retryFailed({ now: at(81), mailer, testMode: true, scope, settings: sOn });
    rows = await emailRows();
    check('M7 after the 3rd retry it gives up in plain words', rows.every((r) => /gave up after 3 retries/.test(r.status)), rows[0].status);
    const before = mails.length;
    await HN.retryFailed({ now: at(500), mailer, testMode: true, scope, settings: sOn });
    check('M8 a given-up line is never retried again', mails.length === before, null);
    const failedRow = rows[0];
    const rs = await HN.resend(failedRow.id, { mailer: async (m) => { mails.push(m); return { ok: true }; }, by: uAdmin.id });
    const fresh = await prisma.notification.findUnique({ where: { id: failedRow.id } });
    check('M9 Resend sends the same text again and the line becomes "Sent"', rs.status === 'Sent' && fresh.status === 'Sent' && mails[mails.length - 1].text === failedRow.message, rs);
    const rs2 = await HN.resend(failedRow.id, { mailer, by: uAdmin.id });
    check('M10 a line that is already Sent cannot be resent', rs2.code === 400, rs2);
    // success on a retry
    await reset(); behaviour = 'fail';
    await HN.notify('missingCheckIn', { userId: A.id, name: A.name, email: A.email }, { title: `Missing check-in — ${today} ZZTEST AM`, message: 'x' }, { now, mailer });
    behaviour = 'ok';
    const rr = await HN.retryFailed({ now: at(6), mailer, testMode: true, scope, settings: sOn });
    check('M11 a retry that works makes the line "Sent"', rr.sent === 1 && (await emailRows())[0].status === 'Sent', rr);

    // ---- F no flood / waiting ones ---------------------------------------------------------------------------------------
    await reset(); behaviour = 'ok';
    await settle({ emailsOn: false });
    await tick();
    check('F1 emails OFF: 4 alerts recorded, none sent', mails.length === 0 && (await emailRows()).length === 4, null);
    await settle({ emailsOn: true });
    const mid = await HN.run({ now, mailer, testMode: true, scope, force: true });
    await tick();
    check('F2 switching ON does not flood: the old alerts stay unsent (no digest, no retry, no re-send by the next tick)', mails.length === 0 && (!mid.digests || mid.digests.emails === 0), [mails.length, mid]);
    const waiting = await HN.waitingOnes({ now, testMode: true, scope });
    check('F3 the Admin can see how many are waiting (4) and who', waiting.length === 4, waiting.length);
    const q = await call('GET', '/api/attendance/notify-queue', T.admin);
    check('F4 GET /attendance/notify-queue answers for Admin with a cap and lists', q.status === 200 && q.body.cap === 100 && Array.isArray(q.body.failed), q.body);
    const noConfirm = await call('POST', '/api/attendance/notify-send-waiting', T.admin, {});
    check('F5 "Send the waiting ones now" needs the confirm', noConfirm.status === 400, noConfirm.body);
    const c1 = await HN.sendWaiting({ now, mailer, testMode: true, scope, cap: 3, by: uAdmin.id });
    check('F6 capped per run: 3 sent, 1 still waiting', c1.sent === 3 && c1.left === 1 && mails.length === 3, c1);
    const c2 = await HN.sendWaiting({ now, mailer, testMode: true, scope, cap: 3, by: uAdmin.id });
    check('F7 the next press sends the last one; then nothing is waiting', c2.sent === 1 && c2.left === 0 && (await HN.waitingOnes({ now, testMode: true, scope })).length === 0 && mails.length === 4, c2);
    await settle({ emailsOn: false });
    const off = await HN.sendWaiting({ now, mailer, testMode: true, scope });
    check('F8 with the master switch OFF the button refuses in plain words', /OFF/.test(off.error || ''), off);
    await settle({ emailsOn: true });

    // ---- leave decision shares the pipeline ----------------------------------------------------------------------------------
    await reset();
    await settle({ mailMode: 'daily' });
    const ld = await HN.notify('leaveDecision', { userId: A.id, name: A.name, email: A.email }, { title: `Leave approved — ZZTEST AM ${today}`, message: 'ok' }, { now, mailer });
    check('L1 even with "Daily email only" a leave decision still goes at once', ld.email === 'Sent' && mails.length === 1, ld);
    await settle({ mailMode: 'now' });

    // ---- R role gates and the honest log -----------------------------------------------------------------------------------------
    const get = (t) => call('GET', '/api/attendance/notify-settings', t);
    const eg = await get(T.A);
    check('R1 an employee cannot open the settings, the queue, the test mail, the resend or the send-waiting', eg.status === 403
      && (await call('GET', '/api/attendance/notify-queue', T.A)).status === 403
      && (await call('PUT', '/api/attendance/notify-settings', T.A, { mailMode: 'off' })).status === 403
      && (await call('POST', '/api/attendance/notify-test-mail', T.A)).status === 403
      && (await call('POST', '/api/attendance/notify-resend/x', T.A)).status === 403
      && (await call('POST', '/api/attendance/notify-send-waiting', T.A, { confirm: true })).status === 403, eg.status);
    const ag = await get(T.admin);
    check('R2 Admin sees the settings with the mail status, the choice and the events\' modes', ag.status === 200 && ag.body.settings.mailMode === 'now' && ag.body.mail && typeof ag.body.mail.configured === 'boolean' && ag.body.events.find((e) => e.key === 'missingCheckIn').mode === 'now' && ag.body.events.find((e) => e.key === 'missingCheckIn').attendance === true, ag.body);
    const hq = await call('GET', '/api/attendance/notify-queue', T.hr);
    const hr404 = await call('POST', '/api/attendance/notify-resend/nope', T.hr);
    check('R3 the HR desk sees the emails that did not go out and can Resend; it cannot change settings or press send-waiting; a team lead cannot even see the list', hq.status === 200 && hr404.status === 404
      && (await get(T.hr)).status === 403 && (await call('POST', '/api/attendance/notify-send-waiting', T.hr, { confirm: true })).status === 403
      && (await call('GET', '/api/attendance/notify-queue', T.tl)).status === 403, [hq.status, hr404.status]);
    const put = await call('PUT', '/api/attendance/notify-settings', T.admin, { mailMode: 'daily' });
    const putBad = await call('PUT', '/api/attendance/notify-settings', T.admin, { mailMode: 'x' });
    check('R4 Admin can save the choice; a wrong one is refused with a plain message', put.status === 200 && put.body.settings.mailMode === 'daily' && putBad.status === 400 && /Send at once/.test(putBad.body.error), [put.status, putBad.body]);
    await call('PUT', '/api/attendance/notify-settings', T.admin, { mailMode: 'now' });
    const tm = await call('POST', '/api/attendance/notify-test-mail', T.admin);
    check('R5 "Send a test email to me" answers in plain words (sent, or exactly why not) - never a crash', [200, 409, 502].includes(tm.status) && !!(tm.body.message || tm.body.error), [tm.status, tm.body]);
    // the log route
    await reset();
    await settle({ emailsOn: false });
    await prisma.notification.create({ data: { userId: A.id, title: `Missing check-in — ${today} ZZTEST AM`, message: 'x', channel: 'Email', recipient: A.email, status: HN.WAITING, read: true } });
    const log = await call('GET', '/api/admin/notifications?page=1&pageSize=20', T.A);
    check('R6 the Notifications log (Recipient / Channel / Event / Status) shows the honest status for a row waiting while emails are OFF', log.status === 200 && log.body.rows.length === 1 && log.body.rows[0].status === HN.EMAILS_OFF, log.body && log.body.rows);
    await settle({ emailsOn: true });
    const log2 = await call('GET', '/api/admin/notifications?page=1&pageSize=20', T.A);
    check('R7 emails ON and the row older than the switch-on: "Not sent: recorded before emails were switched on"', log2.body.rows[0].status === 'Not sent: recorded before emails were switched on', log2.body.rows[0].status);
  } catch (e) {
    console.error(e);
    Z.check('CRASH: the test stopped on an error', false, e && e.message);
  } finally {
    await restore();
    await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: Z.made.emps } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: Z.made.emps } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { OR: [{ recipient: { contains: 'zz-am-' } }, { title: { contains: 'ZZTEST AM' } }] } }).catch(() => {});
    const left = await Z.cleanup();
    const stray = await prisma.notification.count({ where: { OR: [{ recipient: { contains: 'zz-am-' } }, { title: { contains: 'ZZTEST AM' } }] } });
    Z.check('Z cleanup: no ZZTEST AM row is left (users, notifications, audit)', Object.values(left).every((n) => n === 0) && stray === 0, left);
    await Z.finish();
  }
})();
