// ---------------------------------------------------------------------------
// /api/monitoring - EMPLOYEE MONITORING (2026-11-04, utils/monitoring.js has the rules and the privacy notes).
//
// THE DESKTOP AGENT (no browser login; "Authorization: Device <token>" after registering):
//   POST /devices/register   { email, password, deviceName, os, acceptPolicyVersion? }   the employee's own TeamLink login.
//                            -> 412 { consentRequired, policyVersion, policyText } until they accept the notice, then
//                            -> { deviceToken, settings }  (the token is shown once; only its hash is kept)
//                            { setupCode, deviceName, os, acceptPolicyVersion? }   the same with a one-time code from TeamLink
//   POST /activity           { records: [{ appName, windowTitle, start, end, isIdle }] }   every 1-5 minutes
//   POST /heartbeat          -> { settings, consentRequired }   updates last seen
//   POST /live               { currentApp, title, idle }   the moment the app or tab changes (at most every 2 seconds)
// THE SCREENS (a TeamLink login; HR / Admin see everyone, anybody else only themselves):
//   GET  /overview?date=                         the Live Dashboard: HR / Admin everyone, a TL / STL / Manager their team
//   GET  /live                                   what changes by the second, for the same reach: the page reads it every 2 seconds
//   GET  /employee/:id?from=&to=                 the same reach, or :id = me (a look at someone else is audited)
//   GET  /reports?from=&to=&department=&view=employee|daily|team&format=   the same reach (format=xlsx|csv|pdf: the file)
//   GET  /usage?from=&to=&department=            top apps, top websites, the productive split
//   GET  /alerts?from=&to=                       long idle, agent stopped, no signal, low activity: the same reach
//   GET  /audit?from=&to=                        HR / Admin: who looked at what, exports, settings, PCs
//   GET/POST/PUT/DELETE /app-categories          HR / Admin (GET: + apps seen with no category)
//   GET/PUT /settings                            HR / Admin (GET is open to everyone: work hours and the notice)
//   GET  /devices, PUT /devices/:id/deactivate   Super Admin, Admin, IT Admin act; HR looks; an employee their own PCs
//   PUT  /devices/:id/approve                    Super Admin, Admin, IT Admin: a new PC, when approval is switched on
//   GET/POST/DELETE /overrides                   HR / Admin: other rules for a department or an employee, night shifts, not monitored
//   GET  /attendance-suggestions, POST .../approve, .../dismiss   HR / Admin: an empty day filled from PC activity
//   GET  /me, POST /me/consent                   my notice, my consent, my PCs
//   POST /setup-code { employeeId? }              a one-time code for the agent: HR / Admin for anyone, an employee for themselves
//   GET  /people?q=                              HR / Admin: find an employee for a code
//   GET  /agent?kind=exe                         the setup file holding the PC agent (.cmd, or .exe), for any TeamLink login
//   GET  /agent-script                           (a PC) the agent itself, for auto-update
// The general API limit counts an agent per device (utils/apiRateLimit.js), with its own strict limits.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity } = require('../utils/identity');
const { ipOf } = require('../utils/clientIp');
const { logAudit } = require('../utils/audit');
const M = require('../utils/monitoring');

const router = express.Router();
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicSettings = (s) => ({
  workStart: s.workStart, workEnd: s.workEnd, breakStart: s.breakStart, breakEnd: s.breakEnd, idleThresholdMinutes: s.idleThresholdMinutes, retentionDays: s.retentionDays,
  screenshotsEnabled: false, policyVersion: s.policyVersion,
  alertsEnabled: !!s.alertsEnabled, longIdleMinutes: s.longIdleMinutes, offlineMinutes: s.offlineMinutes, lowActivityHours: s.lowActivityHours,
});
// what only the Settings tab shows
const fullSettings = (s) => ({
  ...publicSettings(s), policyText: s.policyText, unauthorizedApps: s.unauthorizedApps || '', alertEmail: !!s.alertEmail, trackTitles: s.trackTitles !== false,
  reportEnabled: !!s.reportEnabled, reportFrequency: s.reportFrequency || 'daily', reportEmails: s.reportEmails || '', autoUpdate: s.autoUpdate !== false, deviceApproval: !!s.deviceApproval, itAdminIds: s.itAdminIds || '',
});

// =============================================================== the agent
router.post('/devices/register', wrap(async (req, res) => {
  const b = req.body || {};
  // a one-time code from TeamLink, or the employee's own email and password
  const setupCode = String(b.setupCode || '').trim();
  let who;
  if (setupCode) {
    const c = await M.readSetupCode(setupCode);
    if (!c) return fail(res, 401, 'This set-up code is wrong or has expired. Get a new one from TeamLink.');
    const emp = await prisma.employee.findUnique({ where: { id: c.employeeId }, select: { id: true, name: true, employmentStatus: true } });
    if (!emp || ['Exited', 'Relieved', 'Terminated'].includes(emp.employmentStatus)) return fail(res, 403, 'This employee is not active.');
    who = { employeeId: emp.id, name: emp.name, userId: null };
  } else {
    const email = String(b.email || '').trim();
    const pw = String(b.password || '');
    if (!email || !pw) return fail(res, 400, 'Type your TeamLink email and password.');
    const { isLocked, MAX_FAILED_LOGINS, LOCK_MINUTES } = require('../utils/passwordPolicy'); // eslint-disable-line global-require
    const { accounts } = await require('../utils/loginAccounts').resolveIdentifier(email); // eslint-disable-line global-require
    // the same rules as the website's sign-in: a locked login says so, and wrong tries lock it
    if (accounts.length && accounts.every(isLocked)) {
      const until = accounts.map((u) => new Date(u.lockedUntil).getTime()).sort((a, b) => a - b)[0];
      const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
      return fail(res, 423, `This login is locked after too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const matched = [];
    for (const u of accounts) {
      // eslint-disable-next-line no-await-in-loop
      if (!isLocked(u) && u.passwordHash && await bcrypt.compare(pw, u.passwordHash)) matched.push(u);
    }
    if (!matched.length) {
      if (accounts.length === 1) {
        const failed = (accounts[0].failedLoginCount || 0) + 1;
        const lock = failed >= MAX_FAILED_LOGINS;
        await prisma.user.update({ where: { id: accounts[0].id }, data: lock ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLoginCount: failed } }).catch(() => {});
      }
      await logAudit({ action: 'Monitoring agent: wrong sign-in', entity: 'User', toValue: email.slice(0, 120), reason: `IP ${ipOf(req)}` }).catch(() => {});
      return fail(res, 401, 'The email or password is not right. Use the same email and password as the TeamLink website.');
    }
    // several logins on one email and password: the one with an employee record (a PC belongs to an employee)
    let user = matched[0];
    let idn = await resolveIdentity(user.id);
    for (const u of matched.slice(1)) {
      if (idn && idn.employeeId) break;
      // eslint-disable-next-line no-await-in-loop
      const other = await resolveIdentity(u.id);
      if (other && other.employeeId) { user = u; idn = other; }
    }
    if (!idn || (idn.status && idn.status !== 'Active') || require('../utils/leftLogin').hasLeft(idn)) return fail(res, 403, 'This login is not active.'); // eslint-disable-line global-require
    if (user.failedLoginCount) await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } }).catch(() => {});
    if (!idn.employeeId) return fail(res, 403, 'This is a service login with no employee record. Sign in with the TeamLink login of the employee who uses this PC.');
    who = { employeeId: idn.employeeId, name: idn.name, userId: user.id };
  }
  const s = await M.settings();
  // NO HIDDEN MODE: the employee accepts the notice (this version) before the PC is registered
  if (!(await M.hasConsent(who.employeeId, s.policyVersion))) {
    if (Number(b.acceptPolicyVersion) !== s.policyVersion) return fail(res, 412, 'Please read and accept the monitoring notice first.', { consentRequired: true, policyVersion: s.policyVersion, policyText: s.policyText });
    await M.recordConsent(who.employeeId, s.policyVersion, ipOf(req), 'Agent');
  }
  const { token, device } = await M.registerDevice({ employeeId: who.employeeId, deviceName: b.deviceName, os: b.os });
  if (setupCode) await M.endSetupCode(setupCode); // one use
  await logAudit({ userId: who.userId, actorName: who.name, action: setupCode ? 'Monitoring: PC registered with a set-up code' : 'Monitoring: PC registered', entity: 'MonitoringDevice', entityId: device.id, toValue: `${device.deviceName} · ${who.name}` }).catch(() => {});
  return res.status(201).json({ deviceToken: token, deviceId: device.id, employee: who.name, settings: publicSettings(s) });
}));

const agent = wrap(async (req, res, next) => {
  const d = await M.deviceOf(req);
  if (!d) return fail(res, 401, 'This PC is not registered, or it was switched off by HR. Register it again.');
  req.device = d;
  return next();
});
router.post('/activity', agent, wrap(async (req, res) => {
  const out = await M.ingest(req.device, (req.body || {}).records);
  if (out.error) return res.status(out.status).json(out);
  return res.json({ saved: out.saved, skipped: out.skipped });
}));
router.post('/heartbeat', agent, wrap(async (req, res) => {
  await M.heartbeat(req.device, req.body || {});
  const s = await M.settings();
  const consent = await M.hasConsent(req.device.employeeId, s.policyVersion);
  const mine = M.effective(s, await M.overrideIndex(), req.device.employee || { id: req.device.employeeId });
  const body = req.body || {};
  const update = s.autoUpdate !== false && M.needsUpdate(body.agentVersion) ? { version: M.latestAgent().version, sha256: M.latestAgent().sha256 } : undefined;
  return res.json({ settings: { ...publicSettings(s), ...mine }, consentRequired: !consent, update, ...(consent ? {} : { policyText: s.policyText }) });
}));
// agent 2.5: the minutes in which one key / button was pressed over and over (utils/monitoringInput.js) - never what was typed
router.post('/input', agent, wrap(async (req, res) => res.json(await require('../utils/monitoringInput').save(req.device, (req.body || {}).minutes)))); // eslint-disable-line global-require
// agent 2.6: how many times each key / button today (letter and number keys as one count each)
router.post('/input-counts', agent, wrap(async (req, res) => { const b = req.body || {}; const out = await require('../utils/monitoringInput').addCounts(req.device, b.day, b.counts); return out.status ? res.status(out.status).json(out) : res.json(out); })); // eslint-disable-line global-require
// agent 2.7: the same counts by app / website and hour (letter and number keys still one count each)
router.post('/input-breakdown', agent, wrap(async (req, res) => { const b = req.body || {}; const out = await require('../utils/monitoringInput').addBuckets(req.device, b.day, b.rows); return out.status ? res.status(out.status).json(out) : res.json(out); })); // eslint-disable-line global-require
router.post('/live', agent, wrap(async (req, res) => { await M.liveUpdate(req.device, req.body || {}); res.json({ ok: true }); }));
// auto-update: the agent script itself; the PC checks its hash against the heartbeat before using it
router.get('/agent-script', agent, wrap(async (req, res) => {
  res.set('Content-Type', 'application/octet-stream');
  res.send(M.latestAgent().bytes);
}));
// a new notice accepted on the PC itself
router.post('/consent', agent, wrap(async (req, res) => {
  const s = await M.settings();
  if (Number((req.body || {}).policyVersion) !== s.policyVersion) return fail(res, 409, 'The notice has changed; read the new one.', { policyVersion: s.policyVersion, policyText: s.policyText });
  await M.recordConsent(req.device.employeeId, s.policyVersion, ipOf(req), 'Agent');
  return res.json({ ok: true });
}));

// =============================================================== the screens
router.use(requireAuth);
// clients, candidates and other outside logins have no monitoring at all
router.use((req, res, next) => (['CLIENT', 'CANDIDATE'].includes(req.user.role) ? fail(res, 403, 'This is not part of your login.') : next()));
const teamOnly = wrap(async (req, res, next) => {
  req.access = await M.accessOf(req.user);
  if (!req.access.admin && !req.access.lead) return fail(res, 403, 'You can see your own activity under My activity.');
  return next();
});
const adminOnly = (req, res, next) => (M.isMonitorAdmin(req.user) ? next() : fail(res, 403, 'Employee monitoring is for HR and Admin. You can see your own activity under My activity.'));
const L = require('../utils/monitoringLinks');

router.get('/overview', teamOnly, wrap(async (req, res) => res.json(await M.overview(req.query.date, req.access))));
router.get('/live', teamOnly, wrap(async (req, res) => res.json(await M.liveRows(req.access))));

router.get('/employee/:id', wrap(async (req, res) => {
  const id = req.params.id === 'me' ? req.user.employeeId : req.params.id;
  if (!id) return fail(res, 404, 'Your login has no employee record.');
  const access = await M.accessOf(req.user);
  if (access.ids && !access.ids.includes(id)) return fail(res, 403, 'You can see only your own activity.');
  const out = await M.employeeDetail(id, req.query.from, req.query.to);
  if (!out) return fail(res, 404, 'Employee not found.');
  if (id !== req.user.employeeId) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Monitoring: looked at the activity of', entity: 'Monitoring', entityId: id, toValue: `${out.employee.name} · ${out.from} to ${out.to}` }).catch(() => {});
  return res.json(out);
}));

// one key / button of one person: where (app / website) and when (hour) - a click on it in Keys and buttons pressed
router.get('/employee/:id/key-detail', wrap(async (req, res) => {
  const id = req.params.id === 'me' ? req.user.employeeId : req.params.id;
  if (!id) return fail(res, 404, 'Your login has no employee record.');
  const access = await M.accessOf(req.user);
  if (access.ids && !access.ids.includes(id)) return fail(res, 403, 'You can see only your own activity.');
  const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const from = valid(req.query.from) ? req.query.from : today;
  const to = valid(req.query.to) ? req.query.to : from;
  const out = await require('../utils/monitoringInput').keyDetail(id, from, to, req.query.key); // eslint-disable-line global-require
  return out.status ? res.status(out.status).json(out) : res.json(out);
}));

router.get('/reports', teamOnly, wrap(async (req, res) => {
  const view = ['daily', 'team', 'payroll'].includes(req.query.view) ? req.query.view : 'employee';
  if (view === 'payroll' && !req.access.admin) return fail(res, 403, 'The payroll reference is for HR and Admin.');
  const out = await M.reportRows(req.query.from, req.query.to, req.query.department || '', req.access, view);
  const KIT = require('../utils/exportKit'); // eslint-disable-line global-require
  const format = req.query.format ? KIT.formatOf(req.query) : null;
  if (!format) return res.json(out);
  const pct = (v) => (v == null ? '' : `${v}%`);
  const tm = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }) : '');
  const nums = (r) => [r.activeHours, r.idleHours, r.breakHours, r.productiveHours, r.unproductiveHours, pct(r.productivity)];
  const tail = ['Active hours', 'Idle hours', 'Break hours', 'Productive hours', 'Unproductive hours', 'Productivity'];
  const table = {
    // founder 2026-11-10: the Moved / Sent / Calls / Messages columns removed ("remove this")
    employee: [['Employee', 'Code', 'Department', 'Days', ...tail], (r) => [r.name, r.code || '', r.department || '', r.days, ...nums(r)]],
    daily: [['Date', 'Day type', 'Employee', 'Code', 'Department', 'Login', 'Logout', ...tail], (r) => [r.day, r.dayType || 'Working day', r.name, r.code || '', r.department || '', tm(r.login), tm(r.logout), ...nums(r)]],
    payroll: [['Employee', 'Code', 'Department', 'Working days', 'Days on PC', 'Leave days', 'Days with neither', 'Active hours', 'Productive hours', 'Idle hours', 'Productivity'], (r) => [r.name, r.code || '', r.department || '', r.workingDays, r.pcDays, r.leaveDays, r.noPcDays, r.activeHours, r.productiveHours, r.idleHours, pct(r.productivity)]],
    team: [['Department', 'Employees', ...tail], (r) => [r.name, r.employees, ...nums(r)]],
  }[view];
  return KIT.sendTable(req, res, {
    format, name: `employee-monitoring-${view}-${out.from}-to-${out.to}`, title: `Employee monitoring ${out.from} to ${out.to}${req.query.department ? ` · ${req.query.department}` : ''}`,
    headers: table[0], rows: out.rows.map(table[1]),
    sheet: 'Monitoring', entity: 'ActivityLog', what: 'Employee monitoring report', scope: req.query.department || 'All departments', period: { from: out.from, to: out.to }, screen: 'Employee Monitoring',
  });
}));

router.get('/usage', teamOnly, wrap(async (req, res) => res.json(await M.usage(req.query.from, req.query.to, req.query.department || '', req.access))));

router.get('/alerts', teamOnly, wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const to = day.test(String(req.query.to || '')) ? String(req.query.to) : M.todayIst();
  const from = day.test(String(req.query.from || '')) ? String(req.query.from) : to;
  res.json(await require('../utils/monitoringAlerts').list(from, to, req.access)); // eslint-disable-line global-require
}));

// --- tasks vs work (founder 2026-11-10): the HRMS tasks and Timesheet Checklist of a day beside what was open on the PC, with a match %
router.get('/task-match', teamOnly, wrap(async (req, res) => res.json(await require('../utils/monitoringTasks').taskMatch(req.query.from, req.query.to, req.access)))); // eslint-disable-line global-require
// --- attendance from the PC (founder 2026-11-10): present / half day / absent by the active hours, with the percentage
router.get('/pc-attendance', teamOnly, wrap(async (req, res) => {
  const q = req.query;
  const out = await L.pcAttendance(q.from, q.to, req.access, { department: q.department || '', team: q.team || '', mark: q.mark || '', band: q.band || '' });
  const KIT = require('../utils/exportKit'); // eslint-disable-line global-require
  const format = req.query.format ? KIT.formatOf(req.query) : null;
  if (!format) return res.json(out);
  const pct = (v) => (v == null ? '' : `${v}%`);
  const days = req.query.view === 'days';
  return KIT.sendTable(req, res, {
    format, name: `pc-attendance-${days ? 'days' : 'employees'}-${out.from}-to-${out.to}`, title: `Present or absent from the PC ${out.from} to ${out.to}${[q.department, q.team, q.mark].filter(Boolean).length ? ` · ${[q.department, q.team, q.mark].filter(Boolean).join(' · ')}` : ''}`,
    headers: days ? ['Date', 'Employee', 'Code', 'Department', 'First', 'Last', 'Active hours', 'Work hours', 'Active %', 'From the PC']
      : ['Employee', 'Code', 'Department', 'Working days', 'Present', 'Half day', 'Absent', 'On leave', 'Attendance %', 'Active hours', 'Work hours', 'Active %'],
    rows: days ? out.days.map((r) => [r.day, r.name, r.code || '', r.department || '', r.first || '', r.last || '', r.activeHours, r.workHours, pct(r.pct), r.mark])
      : out.people.map((r) => [r.name, r.code || '', r.department || '', r.days, r.present, r.halfDays, r.absent, r.leave, pct(r.attendancePct), r.activeHours, r.workHours, pct(r.pct)]),
    sheet: 'PC attendance', entity: 'ActivityLog', what: 'Present or absent from the PC', scope: q.department || 'All departments', period: { from: out.from, to: out.to }, screen: 'Employee Monitoring',
  });
}));
// --- attendance suggestions: HR approves, and only an empty day is filled
router.get('/attendance-suggestions', adminOnly, wrap(async (req, res) => res.json(await L.suggestions(req.query.from, req.query.to, null))));
router.post('/attendance-suggestions/approve', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await L.approveSuggestion(req.user, null, String(b.employeeId || ''), String(b.day || ''), String(b.status || ''));
  return out.error ? fail(res, out.status, out.error) : res.json({ ok: true, message: out.message });
}));
router.post('/attendance-suggestions/dismiss', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await L.dismissSuggestion(req.user, String(b.employeeId || ''), String(b.day || ''));
  return out.error ? fail(res, out.status, out.error) : res.json({ ok: true, message: out.message });
}));

// --- different rules for a department or an employee
router.get('/overrides', adminOnly, wrap(async (req, res) => res.json({ rows: await M.listOverrides() })));
router.post('/overrides', adminOnly, wrap(async (req, res) => {
  const out = await M.saveOverride(req.user, req.body || {});
  return out.error ? fail(res, out.status, out.error) : res.status(201).json({ ok: true, row: out.row, message: 'Saved.' });
}));
router.delete('/overrides/:id', adminOnly, wrap(async (req, res) => { await M.removeOverride(req.user, req.params.id); res.json({ ok: true }); }));

router.get('/audit', adminOnly, wrap(async (req, res) => res.json(await M.auditRows(req.query.from, req.query.to))));

// --- app categories
router.get('/app-categories', teamOnly, wrap(async (req, res) => {
  const [rows, unset, depts] = await Promise.all([
    prisma.appCategory.findMany({ orderBy: [{ department: 'asc' }, { appName: 'asc' }] }), M.uncategorised(),
    prisma.employee.findMany({ where: { department: { not: null } }, select: { department: true }, distinct: ['department'] }),
  ]);
  res.json({ rows, uncategorised: req.access.admin ? unset : [], canEdit: req.access.admin, categories: M.CATEGORIES, departments: depts.map((d) => d.department).filter(Boolean).sort() });
}));
const catBody = (b) => {
  const appName = String(b.appName || '').trim().toLowerCase().replace(/\.exe$/, '').slice(0, 80);
  const kind = b.kind === 'site' ? 'site' : 'app';
  const department = String(b.department || '').trim().slice(0, 80);
  const category = String(b.category || '').toLowerCase();
  if (!appName) return { error: 'Write the app (like chrome or excel) or a website word (like youtube).' };
  if (!M.CATEGORIES.includes(category)) return { error: 'Pick productive, neutral or unproductive.' };
  return { appName, kind, category, department };
};
router.post('/app-categories', adminOnly, wrap(async (req, res) => {
  const c = catBody(req.body || {});
  if (c.error) return fail(res, 400, c.error);
  const row = await prisma.appCategory.upsert({ where: { appName_department: { appName: c.appName, department: c.department } }, create: { ...c, setBy: req.user.name || null }, update: { kind: c.kind, category: c.category, setBy: req.user.name || null } });
  return res.status(201).json(row);
}));
router.put('/app-categories/:id', adminOnly, wrap(async (req, res) => {
  const cur = await prisma.appCategory.findUnique({ where: { id: req.params.id } });
  if (!cur) return fail(res, 404, 'Not found.');
  const c = catBody({ ...cur, ...(req.body || {}) });
  if (c.error) return fail(res, 400, c.error);
  return res.json(await prisma.appCategory.update({ where: { id: cur.id }, data: { ...c, setBy: req.user.name || null } }));
}));
router.delete('/app-categories/:id', adminOnly, wrap(async (req, res) => {
  await prisma.appCategory.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
}));

// --- settings
router.get('/settings', wrap(async (req, res) => {
  const s = await M.settings();
  const it = M.isItIn(s, req.user);
  const hr = M.isMonitorAdmin(req.user);
  const itIds = String(s.itAdminIds || '').split(',').filter(Boolean);
  const itAdmins = hr && itIds.length ? await prisma.employee.findMany({ where: { id: { in: itIds } }, select: { id: true, name: true } }) : [];
  res.json({
    itAdmins,
    ...(hr ? fullSettings(s) : { ...publicSettings(s), policyText: s.policyText, ...(it ? { autoUpdate: s.autoUpdate !== false, deviceApproval: !!s.deviceApproval } : {}) }),
    updatedBy: s.updatedBy || null, updatedAt: s.updatedAt || null, canEdit: hr, canAgent: M.isSuper(req.user) || it, canChooseIt: M.isSuper(req.user),
    ...(hr ? { latestAgent: M.latestAgent().version } : {}),
  });
}));
router.put('/settings', wrap(async (req, res, next) => (M.isMonitorAdmin(req.user) || await M.isIt(req.user) ? next() : fail(res, 403, 'Settings are for HR, Admin and IT Admin.'))), wrap(async (req, res) => {
  // IT Admin: the agent's settings and nothing else
  const body = M.isMonitorAdmin(req.user) ? (req.body || {}) : { autoUpdate: (req.body || {}).autoUpdate, deviceApproval: (req.body || {}).deviceApproval };
  const out = await M.saveSettings(req.user, body);
  if (out.error) return fail(res, out.status, out.error);
  return res.json({ ...fullSettings(out.settings), message: out.newVersion ? 'Saved. The notice changed, so every employee accepts it again before more is recorded.' : 'Saved.' });
}));

// --- devices
router.get('/devices', wrap(async (req, res) => {
  const admin = M.isMonitorAdmin(req.user) || await M.isIt(req.user);
  if (!admin && !req.user.employeeId) return res.json({ rows: [] });
  // a lead looks at people on the Live Dashboard; Devices is HR / Admin's, and each employee's own PCs
  const rows = await prisma.monitoringDevice.findMany({
    where: admin ? {} : { employeeId: req.user.employeeId },
    orderBy: [{ isActive: 'desc' }, { lastSeenAt: 'desc' }],
    select: { id: true, deviceName: true, os: true, agentVersion: true, registeredAt: true, lastSeenAt: true, isActive: true, approved: true, employee: { select: { id: true, name: true, employeeCode: true, department: true } } },
  });
  const now = Date.now();
  res.json({ rows: rows.map((d) => ({ ...d, online: d.isActive && d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 3 * 60000, outdated: M.needsUpdate(d.agentVersion) })), latestAgent: M.latestAgent().version, canManage: await M.canManageDevices(req.user) });
}));
router.put('/devices/:id/deactivate', wrap(async (req, res) => {
  const d = await prisma.monitoringDevice.findUnique({ where: { id: req.params.id } });
  if (!d) return fail(res, 404, 'Not found.');
  if (!(await M.canManageDevices(req.user)) && d.employeeId !== req.user.employeeId) return fail(res, 403, 'Only the Super Admin, Admin, IT Admin or the employee can switch this PC off.');
  await prisma.monitoringDevice.update({ where: { id: d.id }, data: { isActive: false } });
  await logAudit({ userId: req.user.id, action: 'Monitoring: PC switched off', entity: 'MonitoringDevice', entityId: d.id, toValue: d.deviceName }).catch(() => {});
  res.json({ ok: true, message: `${d.deviceName} no longer sends activity. It can be registered again from the agent.` });
}));

router.put('/devices/:id/approve', wrap(async (req, res) => {
  if (!(await M.canManageDevices(req.user))) return fail(res, 403, 'Only the Super Admin, Admin or IT Admin approves a PC.');
  const d = await prisma.monitoringDevice.update({ where: { id: req.params.id }, data: { approved: true } }).catch(() => null);
  if (!d) return fail(res, 404, 'Not found.');
  await logAudit({ userId: req.user.id, action: 'Monitoring: PC approved', entity: 'MonitoringDevice', entityId: d.id, toValue: d.deviceName }).catch(() => {});
  return res.json({ ok: true, message: `${d.deviceName} is approved.` });
}));

// --- attendance: "PC activity" (first / last activity of each day), beside the marked times - it never changes them
//     GET /pc-activity?from=&to=   HR / Admin: everyone; anybody else: their own days. -> { rows: { "<employeeId>|<day>": { first, last } } }
router.get('/pc-activity', wrap(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = day.test(String(req.query.from || '')) ? String(req.query.from) : M.todayIst();
  const to = day.test(String(req.query.to || '')) ? String(req.query.to) : from;
  const access = await M.accessOf(req.user);
  const ids = access.ids || [...new Set((await prisma.activityLog.findMany({ where: { day: { gte: from, lte: to } }, select: { employeeId: true }, distinct: ['employeeId'] })).map((x) => x.employeeId))];
  const map = await M.pcActivity(ids, from, to);
  res.json({ rows: Object.fromEntries(map) });
}));

// --- a one-time set-up code for the agent
router.post('/setup-code', wrap(async (req, res) => {
  const id = String((req.body || {}).employeeId || '') || req.user.employeeId;
  if (!id) return fail(res, 400, 'Pick the employee.');
  if (!M.isMonitorAdmin(req.user) && id !== req.user.employeeId) return fail(res, 403, 'You can get a code only for yourself.');
  const emp = await prisma.employee.findUnique({ where: { id }, select: { id: true, name: true, employmentStatus: true } });
  if (!emp || ['Exited', 'Relieved', 'Terminated'].includes(emp.employmentStatus)) return fail(res, 404, 'This employee is not active.');
  const out = await M.newSetupCode(id, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Monitoring: set-up code made', entity: 'Monitoring', entityId: id, toValue: emp.name }).catch(() => {});
  return res.status(201).json({ ...out, employee: emp.name });
}));
router.get('/people', wrap(async (req, res, next) => (M.isMonitorAdmin(req.user) ? next() : fail(res, 403, 'This is for HR and Admin.'))), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ rows: [] });
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated'] }, OR: [{ name: { contains: q } }, { employeeCode: { contains: q } }] },
    select: { id: true, name: true, employeeCode: true, department: true }, orderBy: { name: 'asc' }, take: 12,
  });
  return res.json({ rows });
}));

// --- the agent itself: any TeamLink login downloads it from Settings / My activity (it records nothing until its own set-up)
router.get('/agent', wrap(async (req, res) => {
  const exe = req.query.kind === 'exe' ? M.agentInstaller() : null;
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="TeamLinkMonitorSetup.${exe ? 'exe' : 'cmd'}"`);
  res.send(exe || Buffer.from(M.agentSetupFile(), 'utf8'));
}));

// --- me
router.get('/me', wrap(async (req, res) => {
  const s = await M.settings();
  const id = req.user.employeeId;
  const consents = id ? await prisma.monitoringConsent.findMany({ where: { employeeId: id }, orderBy: { acceptedAt: 'desc' } }) : [];
  res.json({
    hasEmployee: !!id, isAdmin: M.isMonitorAdmin(req.user), isLead: (await M.accessOf(req.user)).lead, isIt: M.isItIn(s, req.user), canManageDevices: await M.canManageDevices(req.user), settings: publicSettings(s), policyText: s.policyText,
    accepted: consents.some((c) => c.policyVersion === s.policyVersion), consents,
  });
}));
router.post('/me/consent', wrap(async (req, res) => {
  if (!req.user.employeeId) return fail(res, 404, 'Your login has no employee record.');
  const s = await M.settings();
  if (Number((req.body || {}).policyVersion) !== s.policyVersion) return fail(res, 409, 'The notice has changed; read the new one.');
  await M.recordConsent(req.user.employeeId, s.policyVersion, ipOf(req), 'Web');
  res.json({ ok: true, message: 'Thank you. You accepted the monitoring notice.' });
}));

module.exports = router;
