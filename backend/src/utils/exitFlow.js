// ---------------------------------------------------------------------------
// EMPLOYEE EXIT: ONE STATE MACHINE, ONE GUARD, ONE RECORD (HRMS spec items 6 + 7,
// user 2026-10-13).
//
//   "Notify the Super Admin when an employee's exit process is initiated. Require
//    the appropriate approval before finalizing the exit. Send reminders for
//    pending exit approvals and maintain exit status records."
//
// WHAT AN EXIT IS: one RESIGNATION record (EmployeeRecord) + its ApprovalStep
// chain (workflow 'resignation', ending at the Super Admin by default). Every way
// an exit starts - the employee's resignation form, HR 'Initiate exit', an Edit
// form status set to Exit Process / Notice Period - makes that one record, so
// there is one timeline, one list, one date (utils/exitDate.js).
//
//   STATE (EmployeeRecord.status)         employee status        who moves it
//   Pending Approval                      Active (or Exit Process set by HR)   the chain, step by step
//     -> Notice Period  (final approval)  Notice Period          the final approver (setting; Super Admin by default)
//     -> Relieved       (finalize)        Relieved / Exited      HR desk, ONLY with final approval AND the last
//                                                                 working day reached (or an early release)
//   Pending Approval / Notice Period
//     -> Rejected / Withdrawn             back to Active         the approver / the employee
//
// THE GUARD (canFinalizeExit + the Prisma middleware below) is the single place that
// refuses a leaving status that has no approved exit behind it - whatever route
// wrote it (Edit form, import, offboarding checklist, PATCH status, a direct API
// call). Scripts and background jobs run outside a web request and are not
// guarded (they carry their own real-DB guards); the one explicit exception for
// people is the audited Super Admin override 'Finalize without approval'.
//
// NOTHING IN THIS FILE RUNS AT LOAD except installing the (inert outside web
// requests) middleware. No timers, no sweeps.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const prisma = require('../db');
const { logAudit } = require('./audit');
const exitDate = require('./exitDate');
const sandbox = require('./sandbox');

const als = new AsyncLocalStorage();
const PENDING = 'Pending Approval';
const SERVING = ['Notice Period', 'Accepted'];
const FINAL_STATUSES = ['Relieved', 'Exited', 'Terminated'];
const NONFINAL_LEAVING = ['Exit Process', 'Notice Period'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const WF = 'resignation';
const SETTINGS_KEY = 'exit.settings';
const TEST_RE = /zztest|example\.test/i;
const named = (v) => (v && v !== 'NONE' ? v : null);
const dmy = exitDate.dmy;
const todayIso = () => require('./positions').today();

// The checklist the offboarding tracker opens with (the same list HR sees).
const EXIT_CHECKLIST = [
  'Exit interview scheduled',
  'Assets returned',
  'Access revoked',
  'Full & final settlement processed',
  'Experience letter issued',
];

// ---- web-request scope (set once in index.js) -------------------------------
function requestScope(req, res, next) { als.run({ req }, next); }
const store = () => als.getStore() || null;
// Run fn with the audited Super Admin override switched on for this request only.
function withOverride(fn) { return als.run({ ...(store() || {}), bypass: true }, fn); }
const actorOfRequest = () => { const s = store(); return s && s.req && s.req.user ? s.req.user : null; };

// ---- settings (AppSetting 'exit.settings') ----------------------------------
const FINAL_APPROVERS = [
  ['SUPER_ADMIN', 'Super Admin'],
  ['ADMIN', 'Admin (the HR desk)'],
  ['HR', 'HR'],
];
const DEFAULT_SETTINGS = { finalApprover: 'SUPER_ADMIN', reminderHours: 24 };
async function getSettings() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return {
      finalApprover: FINAL_APPROVERS.some(([k]) => k === v.finalApprover) ? v.finalApprover : DEFAULT_SETTINGS.finalApprover,
      reminderHours: Number.isFinite(Number(v.reminderHours)) && Number(v.reminderHours) >= 1 ? Math.min(720, Math.round(Number(v.reminderHours))) : DEFAULT_SETTINGS.reminderHours,
      autoRelieve: v.autoRelieve !== false, // the notice period ended -> Relieved by itself (utils/noticeAutoExit.js); ON unless switched off
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
async function saveSettings(patch, user) {
  const cur = await getSettings();
  const next = { ...cur };
  if (patch.finalApprover !== undefined) {
    if (!FINAL_APPROVERS.some(([k]) => k === patch.finalApprover)) throw new exitDate.ExitDateError(400, 'Pick Super Admin, Admin or HR as the final approver.');
    next.finalApprover = patch.finalApprover;
  }
  if (patch.reminderHours !== undefined) {
    const h = Number(patch.reminderHours);
    if (!Number.isFinite(h) || h < 1 || h > 720) throw new exitDate.ExitDateError(400, 'Remind after a whole number of hours between 1 and 720.');
    next.reminderHours = Math.round(h);
  }
  if (patch.autoRelieve !== undefined) next.autoRelieve = patch.autoRelieve !== false && patch.autoRelieve !== 'false';
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY }, update: { value, updatedById: user ? user.id : null, updatedByName: user ? (user.name || user.email) : null },
    create: { key: SETTINGS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? (user.name || user.email) : null },
  });
  await logAudit({
    userId: user ? user.id : null, actorName: user ? (user.name || user.email) : null, action: 'Exit approval settings changed',
    entity: 'AppSetting', entityId: SETTINGS_KEY, fromValue: JSON.stringify(cur), toValue: value,
  });
  return next;
}
// Which ladder rung ends an exit's approval ('SUPER_ADMIN' = the whole chain, the default).
async function finalLevel() {
  const s = await getSettings();
  return s.finalApprover === 'SUPER_ADMIN' ? null : 'HR';
}

// ---- who gets told ------------------------------------------------------------
const isTest = (...v) => TEST_RE.test(v.filter(Boolean).join(' '));
async function superAdmins({ allowTest = false } = {}) {
  const us = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }] },
    select: { id: true, name: true, email: true },
  });
  return us.filter((u) => allowTest || sandbox.isSandbox() || !isTest(u.name, u.email));
}
async function usersByIds(ids, { allowTest = false } = {}) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const us = await prisma.user.findMany({ where: { id: { in: list }, status: 'Active' }, select: { id: true, name: true, email: true } });
  return us.filter((u) => allowTest || sandbox.isSandbox() || !isTest(u.name, u.email));
}
// The employee's own TL and HR (and STL) from the approval ladder.
async function peopleAround(employee) {
  const workflow = require('./approvalWorkflow');
  const chain = await workflow.resolveChain(employee).catch(() => ({}));
  const pick = (lvl) => (chain[lvl] && chain[lvl].user ? chain[lvl].user.id : null);
  return { tl: pick('TL'), stl: pick('STL'), hr: pick('HR') };
}
const absolute = (p) => { try { return require('./pendingWork').absolute(p); } catch { return p; } };
const exitLink = (recordId) => `/employee-services?tab=resignation&exit=${recordId}`;

// Bell (always) + e-mail (when asked and the mail channel is set up) to each person ONCE per event key.
async function tell({ userIds, title, message, link, key, email = true, mailer = null, exceptUserId = null }) {
  const out = { told: [], skipped: [] };
  const users = await usersByIds(userIds);
  for (const u of users) {
    if (exceptUserId && u.id === exceptUserId) { out.skipped.push(u.id); continue; }
    const dedupe = `exit|${key}|${u.id}`;
    // eslint-disable-next-line no-await-in-loop
    const seen = await prisma.notification.findFirst({ where: { userId: u.id, channel: 'In-App', recipient: dedupe }, select: { id: true } });
    if (seen) { out.skipped.push(u.id); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message: `${message}${link ? `\nOpen: ${link}` : ''}`, channel: 'In-App', recipient: dedupe, status: 'Delivered' } });
    } catch (e) { out.skipped.push(u.id); continue; } // eslint-disable-line no-continue
    out.told.push(u.id);
    if (email && u.email) {
      let status;
      try {
        const send = mailer || require('./mailer').sendMail; // eslint-disable-line global-require
        // eslint-disable-next-line no-await-in-loop
        const r = await send({ to: u.email, subject: `TeamLink - ${title}`, text: `${message}${link ? `\n\nOpen: ${absolute(link)}` : ''}`, useEmployeeFrom: false, fromName: 'TeamLink HR' });
        status = r.ok ? 'Sent' : r.notConfigured ? 'Not sent - e-mail is not set up' : `Not sent - ${String(r.error || '').slice(0, 120)}`;
      } catch (err) { status = `Not sent - ${String(err && err.message).slice(0, 100)}`; }
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: u.id, title, message: message.slice(0, 1500), channel: 'Email', recipient: u.email, status, read: true } });
    }
  }
  return out;
}

// ---- THE GUARD ---------------------------------------------------------------
const stripTime = (d) => String(d || '').slice(0, 10);
// Can this person become Relieved / Exited now? { ok, code, message }.
async function canFinalizeExit(employeeId, { today = todayIso() } = {}) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, name: true } });
  const name = employee ? employee.name : 'This person';
  const live = (await exitDate.liveRecords([employeeId])).get(employeeId);
  if (!live) {
    return { ok: false, code: 'NO_EXIT', message: `${name} has no approved exit. Start the exit first (use "Initiate exit"), get it approved, then relieve them.` };
  }
  const { record, detail } = live;
  // History loaded from a file (already Relieved in the file) is a closed fact, not a new decision.
  if (record.status === 'Relieved') return { ok: true, code: 'ALREADY', record };
  if (record.status === PENDING) {
    const steps = await prisma.approvalStep.findMany({ where: { workflow: WF, recordId: record.id, status: 'Pending' } });
    const cur = steps[0];
    return { ok: false, code: 'NOT_APPROVED', record, message: `This exit is not approved yet: ${name}'s exit is still waiting for approval${cur ? ` (with ${cur.approverName || cur.level})` : ''}.` };
  }
  if (!SERVING.includes(record.status)) return { ok: false, code: 'NOT_APPROVED', record, message: `${name}'s exit is ${String(record.status).toLowerCase()}, so they cannot be relieved.` };
  const lwd = exitDate.dateOf(record, detail);
  if (lwd && lwd > today) {
    return { ok: false, code: 'BEFORE_LAST_DAY', record, lwd, message: `The last working day is ${dmy(lwd)}; use Early release to relieve ${name} now.` };
  }
  return { ok: true, code: 'OK', record, lwd };
}

class ExitBlocked extends Error {
  constructor(message, code) { super(message); this.status = 403; this.exitBlocked = true; this.code = code; }
}

const statusIn = (data) => {
  if (!data || data.employmentStatus === undefined) return undefined;
  const v = data.employmentStatus;
  return typeof v === 'object' && v !== null ? v.set : v;
};
let installed = false;
function install() {
  if (installed || typeof prisma.$use !== 'function') return;
  installed = true;
  prisma.$use(async (params, next) => {
    if (params.model !== 'Employee' || !['update', 'updateMany', 'upsert'].includes(params.action)) return next(params);
    const args = params.args || {};
    const st = statusIn(params.action === 'upsert' ? args.update : args.data);
    if (st === undefined || !FINAL_STATUSES.includes(st)) return next(params);
    const s = store();
    // Outside a web request (scripts, workers): not guarded here.
    if (!s || !s.req) return next(params);
    if (s.bypass) return next(params);
    const user = s.req.user || null;
    if (params.runInTransaction) {
      // A transaction holds the database, so nothing can be read from here. Transactions are only used by the
      // file imports (Employee Services > Import resignations): the HR desk may load history that way, audited.
      if (user && exitDate.isHrDesk(user)) return next(params);
      throw new ExitBlocked('Only HR or the Super Admin can finish an exit from an import.', 'IMPORT_NOT_HR');
    }
    let rows = [];
    if (params.action === 'update' || params.action === 'upsert') {
      const where = args.where || {};
      rows = await prisma.employee.findMany({ where, select: { id: true, employmentStatus: true } });
    } else {
      rows = await prisma.employee.findMany({ where: args.where || {}, select: { id: true, employmentStatus: true } });
    }
    const direct = await deskDirect(user);
    for (const r of rows) {
      if (r.employmentStatus === st || FINAL_STATUSES.includes(r.employmentStatus)) continue; // nothing new is being finalised
      if (direct) {
        // HR desk: no approval needed. Never your own record; never a Super Admin / Admin login unless you are a Super Admin.
        // eslint-disable-next-line no-await-in-loop
        const e = await prisma.employee.findUnique({ where: { id: r.id }, select: { id: true, name: true, userId: true } });
        if (e && ((user.employeeId && user.employeeId === e.id) || (e.userId && e.userId === user.id))) throw new ExitBlocked('Nobody can relieve their own record. Ask another HR person or the Super Admin.', 'SELF');
        if (e && e.userId) {
          // eslint-disable-next-line no-await-in-loop
          const tu = await prisma.user.findUnique({ where: { id: e.userId }, select: { role: true, hrmsRole: true, atsRole: true, accountsRole: true } });
          if (isTopAccount(tu) && !(user.role === 'SUPER_ADMIN' && !user.hrSuper)) throw new ExitBlocked(`${e.name} has a Super Admin or Admin login. Only a Super Admin can relieve them.`, 'TOP_ACCOUNT');
        }
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const v = await canFinalizeExit(r.id);
      if (!v.ok) throw new ExitBlocked(v.message, v.code);
    }
    return next(params);
  });
}
install();

// ---- applying the outcomes (moved here from routes/resignations.js) -----------
async function hrConfig() {
  let cfg = await prisma.hrConfig.findFirst();
  if (!cfg) cfg = await prisma.hrConfig.create({ data: {} });
  return cfg;
}
function noticeEnd(fromDate, days) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const clean = (v, max = 4000) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };

async function applyApproval(record, user, { lastWorkingDate } = {}) {
  const detail = await prisma.resignationDetail.findUnique({ where: { recordId: record.id } });
  const days = (detail && detail.noticePeriodDays != null) ? detail.noticePeriodDays : (await hrConfig()).noticePeriodDays;
  const lwd = (lastWorkingDate && ISO.test(lastWorkingDate) && lastWorkingDate)
    || (detail && detail.requestedLastWorkingDate)
    || record.date
    || noticeEnd((detail && detail.resignationDate) || new Date().toISOString().slice(0, 10), days);
  const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status: 'Notice Period', date: lwd } });
  if (detail) await prisma.resignationDetail.update({ where: { id: detail.id }, data: { approvedLastWorkingDate: lwd } });
  const employee = await prisma.employee.findUnique({ where: { id: record.employeeId } });
  await prisma.employee.update({
    where: { id: record.employeeId },
    data: {
      employmentStatus: 'Notice Period',
      offboardingStatus: 'Serving Notice',
      offboardingTasks: employee && employee.offboardingTasks
        ? undefined
        : JSON.stringify(EXIT_CHECKLIST.map((task) => ({ task, completed: false }))),
    },
  });
  await logAudit({
    userId: user.id, actorName: user.name || user.email, action: 'Resignation approved — employee on notice', entity: 'EmployeeRecord', entityId: record.id,
    fromValue: employee ? employee.employmentStatus : null, toValue: `Notice Period (last working day ${lwd})`,
  });
  return updated;
}

async function applyRejection(record, user, reason) {
  const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status: 'Rejected' } });
  // The person goes back to Active when the exit had moved them into Notice Period / Exit Process.
  const employee = await prisma.employee.findUnique({ where: { id: record.employeeId }, select: { employmentStatus: true } });
  if (SERVING.includes(record.status) || (employee && NONFINAL_LEAVING.includes(employee.employmentStatus))) {
    await prisma.employee.update({ where: { id: record.employeeId }, data: { employmentStatus: 'Active', offboardingStatus: null } });
  }
  await logAudit({ userId: user.id, actorName: user.name || user.email, action: 'Resignation rejected', entity: 'EmployeeRecord', entityId: record.id, fromValue: record.status, toValue: 'Rejected', reason: reason || undefined });
  return updated;
}

async function closeChain(recordId, note) {
  const workflow = require('./approvalWorkflow');
  await prisma.approvalStep.updateMany({
    where: { workflow: WF, recordId, status: { in: [workflow.STEP_STATUS.PENDING, workflow.STEP_STATUS.WAITING] } },
    data: { status: workflow.STEP_STATUS.SKIPPED, note },
  });
}

// "Who finally approves" = HR / Admin: once the HR rung (or anything above it) approves, the rest is not needed.
async function applyFinalLevelRule(recordId, result, user) {
  const workflow = require('./approvalWorkflow');
  const fin = await finalLevel();
  if (!fin || !result || result.complete || result.direct) return result;
  const seqOf = (lvl) => (workflow.LEVEL_BY_ID[lvl] ? workflow.LEVEL_BY_ID[lvl].seq : null);
  const done = seqOf(result.level);
  if (done == null || done < seqOf(fin)) return result;
  await closeChain(recordId, `Not needed — the final approver for an exit is set to ${fin === 'HR' ? 'HR' : fin}`);
  await logAudit({ userId: user.id, actorName: user.name || user.email, action: 'Exit approval finished at the final approver', entity: 'EmployeeRecord', entityId: recordId, toValue: fin });
  return { ...result, complete: true, outcome: 'Approved', nextLevel: null };
}

// ---- STARTING AN EXIT ----------------------------------------------------------
// The one record + chain for exits that do NOT come from the resignation form
// (HR 'Initiate exit', the Edit form status). Returns { record, detail, created, pending }.
async function startExit({ employee, by, source, reason = 'Other', reasonOther = null, lastWorkingDate = null, note = null }) {
  const live = (await exitDate.liveRecords([employee.id])).get(employee.id);
  if (live && live.record.status !== 'Relieved') return { record: live.record, detail: live.detail, created: false };
  const workflow = require('./approvalWorkflow');
  const chain = require('./chainRoute');
  const cfg = await hrConfig();
  const today = new Date().toISOString().slice(0, 10);
  const days = cfg.noticePeriodDays;
  const lwd = lastWorkingDate && ISO.test(lastWorkingDate) ? lastWorkingDate : noticeEnd(today, days);
  const info = { dept: employee.department || null };
  let reportingManager = null;
  if (employee.reportingManagerId) {
    const m = await prisma.employee.findUnique({ where: { id: employee.reportingManagerId }, select: { name: true } });
    reportingManager = m ? m.name : null;
  }
  const record = await prisma.employeeRecord.create({
    data: {
      type: 'RESIGNATION', employeeId: employee.id, title: reason === 'Other' ? `Other: ${reasonOther || source}`.slice(0, 200) : reason,
      detail: note, date: lwd, status: PENDING, raisedBy: by ? (by.name || by.email) : null,
    },
  });
  const nowClock = new Date();
  const detail = await prisma.resignationDetail.create({
    data: {
      recordId: record.id, employeeId: employee.id, employeeCode: employee.employeeCode || null, employeeName: employee.name,
      department: info.dept, designation: employee.designation || null, reportingManager: reportingManager || employee.tl || employee.stl || null,
      resignationDate: today, resignationTime: `${String(nowClock.getHours()).padStart(2, '0')}:${String(nowClock.getMinutes()).padStart(2, '0')}`,
      source, requestedLastWorkingDate: lwd, reason, reasonOther, comments: note, noticePeriodDays: days,
      submittedByUserId: by ? by.id : null, submittedByName: by ? (by.name || by.email) : 'System',
    },
  });
  await logAudit({ userId: by ? by.id : null, actorName: by ? (by.name || by.email) : null, action: 'Resignation submitted', entity: 'EmployeeRecord', entityId: record.id, fromValue: employee.employmentStatus, toValue: PENDING, reason: source });
  const started = await chain.raise(WF, { recordId: record.id, employee });
  let saved = record;
  if (!started.pending) saved = await applyApproval(record, by || { id: null, name: 'System' });
  await notifyInitiated({ record: saved, detail, employee, by });
  return { record: saved, detail, created: true, pending: started.pending, workflow };
}

// Make the single record for somebody who is ALREADY leaving by status alone (no record on file).
async function ensureExitRecord(employee, by, { status } = {}) {
  const live = (await exitDate.liveRecords([employee.id])).get(employee.id);
  // An OLD relieved exit of somebody who has since rejoined (utils/rejoin.js) is history, not this person's exit.
  if (live && !(live.record.status === 'Relieved' && !FINAL_STATUSES.includes(employee.employmentStatus))) return live;
  const final = FINAL_STATUSES.includes(employee.employmentStatus);
  const st = status || (final ? 'Relieved' : 'Notice Period');
  // ON NOTICE WITH NO RESIGNATION ON FILE (founder, 2026-10-23): the notice is counted from today, for the policy's days (45), so the day count and the
  // automatic exit (utils/noticeAutoExit.js) work. HR can change the last working day afterwards (utils/exitDate.js setExitDate).
  const serving = SERVING.includes(st);
  const noticeDays = serving ? (await hrConfig()).noticePeriodDays : null;
  // 2026-10-26 (founder): "actual ga employee resignation pettina date nunchi notice period count ayyi last working day display avvali" - the
  // day a screen first opened this person is NOT their resignation date. With no resignation on file the date stays empty ("not set")
  // until HR / the Super Admin enters it; the last working day then follows as resignation date + notice days (exit dates editor).
  const lwdDefault = null;
  const record = await prisma.employeeRecord.create({
    data: {
      type: 'RESIGNATION', employeeId: employee.id, title: 'Exit recorded by HR', status: st, date: lwdDefault, raisedBy: by ? (by.name || by.email) : null,
      detail: 'Recorded from Exit date: no resignation was filed in TeamLink for this person.',
    },
  });
  const nowClock = new Date();
  const detail = await prisma.resignationDetail.create({
    data: {
      recordId: record.id, employeeId: employee.id, employeeCode: employee.employeeCode || null, employeeName: employee.name,
      department: employee.department || null, designation: employee.designation || null,
      resignationDate: '', resignationTime: null,
      source: 'Recorded by HR from the exit date', reason: 'Other', reasonOther: 'Recorded by HR', noticePeriodDays: noticeDays,
      ...(serving ? { requestedLastWorkingDate: lwdDefault, approvedLastWorkingDate: lwdDefault } : {}),
      submittedByUserId: by ? by.id : null, submittedByName: by ? (by.name || by.email) : 'System',
    },
  });
  await logAudit({ userId: by ? by.id : null, actorName: by ? (by.name || by.email) : null, action: 'Exit record created for a person already leaving', entity: 'EmployeeRecord', entityId: record.id, toValue: st });
  return { record, detail };
}

// ---- NOTIFICATIONS ---------------------------------------------------------------
function exitSummaryLine(employee, detail, lwd) {
  const role = [employee.department, employee.designation].filter(Boolean).join(' / ') || 'no department';
  const reason = detail ? (detail.reason === 'Other' && detail.reasonOther ? `Other: ${detail.reasonOther}` : detail.reason) : 'not stated';
  return `${employee.name}${employee.employeeCode ? ` (${employee.employeeCode})` : ''}, ${role}, proposed last working day ${lwd ? dmy(lwd) : 'not set'}, reason ${reason}`;
}
// Exit INITIATED: the Super Admin(s) hear at once (bell + e-mail); the employee's TL and HR too. Once per event.
async function notifyInitiated({ record, detail, employee, by, mailer = null }) {
  try {
    const lwd = exitDate.dateOf(record, detail);
    const around = await peopleAround(employee);
    const sas = await superAdmins({ allowTest: isTest(employee.name, employee.email) });
    const line = exitSummaryLine(employee, detail, lwd);
    const link = exitLink(record.id);
    const exceptUserId = by ? by.id : null;
    // The Super Admin(s): bell + e-mail.
    const a = await tell({
      userIds: sas.map((u) => u.id), title: `Exit initiated: ${employee.name}`, message: `Exit initiated: ${line}: review in TeamLink.`, link,
      key: `${record.id}:initiated:sa`, email: true, mailer, exceptUserId,
    });
    // TL and HR (bell + e-mail), not the people already told above.
    const b = await tell({
      userIds: [around.tl, around.hr].filter((id) => id && !a.told.includes(id) && !sas.some((s) => s.id === id)),
      title: `Exit initiated: ${employee.name}`, message: `Exit initiated: ${line}.`, link, key: `${record.id}:initiated:team`, email: true, mailer, exceptUserId,
    });
    return { superAdmins: a.told.length, team: b.told.length };
  } catch (err) { console.error('[exitFlow] initiation notice failed:', err && err.message); return null; } // eslint-disable-line no-console
}
// The next approver's turn (bell, once per step).
async function notifyTurn({ recordId, employee, detail, lwd }) {
  try {
    const cur = await prisma.approvalStep.findFirst({ where: { workflow: WF, recordId, status: 'Pending' }, orderBy: { seq: 'asc' } });
    if (!cur || !cur.approverUserId) return null;
    return await tell({
      userIds: [cur.approverUserId], title: `Exit approval waiting for you: ${employee.name}`,
      message: `Exit approval waiting for you: ${exitSummaryLine(employee, detail, lwd)}.`, link: exitLink(recordId), key: `${recordId}:turn:${cur.id}`, email: false,
    });
  } catch (err) { console.error('[exitFlow] turn notice failed:', err && err.message); return null; } // eslint-disable-line no-console
}
async function notifyDecided({ record, employee, detail, approved, by, note }) {
  try {
    const around = await peopleAround(employee);
    const sas = await superAdmins({ allowTest: isTest(employee.name, employee.email) });
    const lwd = exitDate.dateOf(record, detail);
    const title = approved ? `Exit approved: ${employee.name}` : `Exit rejected: ${employee.name}`;
    const message = approved
      ? `${employee.name}'s exit was approved by ${by ? by.name || by.email : 'the approver'}. Last working day ${lwd ? dmy(lwd) : 'not set'}.`
      : `${employee.name}'s exit was rejected by ${by ? by.name || by.email : 'the approver'}${note ? `: ${note}` : ''}. ${employee.name} stays on as before.`;
    const ids = [employee.userId, around.tl, around.hr, ...sas.map((s) => s.id)];
    return await tell({ userIds: ids, title, message, link: exitLink(record.id), key: `${record.id}:decided:${approved ? 'yes' : 'no'}`, email: true, exceptUserId: by ? by.id : null });
  } catch (err) { console.error('[exitFlow] decision notice failed:', err && err.message); return null; } // eslint-disable-line no-console
}

// ---- FINALIZE ---------------------------------------------------------------------
// Relieve / Exit the person. Callers have already passed canFinalizeExit (or the audited override).
async function finalize({ record, employee, user, status = 'Relieved', note = null, override = false }) {
  const rec = await prisma.employeeRecord.update({ where: { id: record.id }, data: { status: 'Relieved' } });
  await prisma.approvalStep.updateMany({ where: { workflow: WF, recordId: record.id, status: { in: ['Pending', 'Waiting'] } }, data: { status: 'Skipped', note: override ? 'Closed by the Super Admin override' : 'Not reached - the exit was finished' } });
  const body = { employmentStatus: status, offboardingStatus: 'Cleared' };
  if (override) await withOverride(() => prisma.employee.update({ where: { id: employee.id }, data: body }));
  else await prisma.employee.update({ where: { id: employee.id }, data: body });
  const openFnf = await prisma.fnfRequest.findFirst({ where: { employeeId: employee.id, status: 'Pending' } });
  const lwd = exitDate.dateOf(rec, null) || new Date().toISOString().slice(0, 10);
  if (!openFnf) await prisma.fnfRequest.create({ data: { employeeId: employee.id, lastWorkingDate: lwd } });
  await logAudit({
    userId: user.id, actorName: user.name || user.email, action: `Resignation ${status === 'Exited' ? 'Exited' : 'Relieved'}`, entity: 'EmployeeRecord', entityId: record.id,
    fromValue: record.status, toValue: status, reason: note || undefined,
  });
  // HR SUPER ACCESS (utils/hrSuper.js): a delegate finishing an exit is reported to every Super Admin.
  if (user && user.hrSuper) {
    try {
      const sas = await superAdmins({ allowTest: isTest(employee.name, employee.email) || isTest(user.name, user.email) });
      await tell({
        userIds: sas.map((s) => s.id), exceptUserId: user.id, email: false, key: `${record.id}:finalized-by-hr:${Date.now()}`,
        title: `Exit finished by Internal HR: ${employee.name}`,
        message: `${user.name || user.email} (${user.hrSuper.label || 'Internal HR'}) marked ${employee.name} as ${status}${note ? `. Note: ${note}` : ''}.`, link: exitLink(record.id),
      });
    } catch (e) { console.error('[exitFlow] finalize notice failed:', e && e.message); } // eslint-disable-line no-console
  }
  return rec;
}

// ---- RELIEVE NOW: the HR desk finishes an exit in ONE step, no approval chain ----------------------
// Founder, 2026-10-15: "For Relieved and Exited NO approvals are ever needed. HR must be able to directly mark an
// employee Exited or Relieved." This is the NORMAL path for the HR desk / Internal HR / Admin / Super Admin.
// The setting (AppSetting 'exit.hrDirectRelieve') is ON by default and stays only as an emergency OFF switch (Admin / Super Admin).
// ONE database transaction writes the exit record (made if none), the employee status and the settlement
// request; the seat and notifications follow from it. A pending resignation request is closed as "Completed by HR".
const DIRECT_KEY = 'exit.hrDirectRelieve';
const DIRECT_MARK = 'HR direct relieve (approval skipped)';
async function getDirectRelieve() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: DIRECT_KEY } });
    if (!row) return { enabled: true, updatedByName: null, updatedAt: null, isDefault: true };
    const v = JSON.parse(row.value || '{}');
    return { enabled: v.enabled !== false, updatedByName: row.updatedByName || null, updatedAt: row.updatedAt || null, isDefault: false };
  } catch { return { enabled: true, updatedByName: null, updatedAt: null, isDefault: true }; }
}
async function saveDirectRelieve(enabled, user) {
  const cur = await getDirectRelieve();
  const value = JSON.stringify({ enabled: !!enabled });
  const who = user ? (user.name || user.email) : null;
  await prisma.appSetting.upsert({
    where: { key: DIRECT_KEY }, update: { value, updatedById: user ? user.id : null, updatedByName: who },
    create: { key: DIRECT_KEY, value, updatedById: user ? user.id : null, updatedByName: who },
  });
  await logAudit({
    userId: user ? user.id : null, actorName: who, action: 'Exit setting changed: HR may relieve directly', entity: 'AppSetting', entityId: DIRECT_KEY,
    fromValue: cur.enabled ? 'On' : 'Off', toValue: enabled ? 'On' : 'Off',
  });
  return getDirectRelieve();
}

const isTopAccount = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].some((r) => [u.role, u.hrmsRole, u.atsRole, u.accountsRole].includes(r));
// A plain refusal { status, error, code } or null when this actor may relieve this person on this date.
async function relieveNowRefusal({ employee, actor, reason, lastWorkingDate, status = 'Relieved' }) {
  const name = employee.name;
  if (!actor || !exitDate.isHrDesk(actor)) return { status: 403, error: 'Only HR, an Admin or the Super Admin can relieve someone directly.' };
  const setting = await getDirectRelieve();
  if (!setting.enabled) {
    const v = await canFinalizeExit(employee.id);
    return { status: 409, code: v.code || 'DIRECT_OFF', error: v.ok ? 'Relieving directly is switched off. Use "Finish exit" on the exit record.' : v.message };
  }
  const own = (actor.employeeId && actor.employeeId === employee.id) || (employee.userId && employee.userId === actor.id);
  if (own) return { status: 403, error: 'Nobody can relieve their own record. Ask another HR person or the Super Admin.' };
  if (FINAL_STATUSES.includes(employee.employmentStatus)) {
    const rel = await prisma.employeeRecord.findFirst({ where: { employeeId: employee.id, type: 'RESIGNATION', status: 'Relieved' }, orderBy: { updatedAt: 'desc' }, select: { date: true, updatedAt: true } });
    const on = (rel && exitDate.isoDay(rel.date)) || exitDate.isoDay(employee.updatedAt && new Date(employee.updatedAt).toISOString());
    return { status: 409, error: `${name} is already ${employee.employmentStatus === 'Exited' ? 'exited' : 'relieved'}${on ? ` (on ${dmy(on)})` : ''}.`, code: 'ALREADY' };
  }
  if (employee.userId) {
    const u = await prisma.user.findUnique({ where: { id: employee.userId }, select: { role: true, hrmsRole: true, atsRole: true, accountsRole: true } });
    if (isTopAccount(u) && !(actor.role === 'SUPER_ADMIN' && !actor.hrSuper)) {
      return { status: 403, error: `${name} has a Super Admin or Admin login. Only a Super Admin can relieve them.` };
    }
  }
  if (!clean(reason, 200) || String(reason).trim().length < 2) return { status: 400, error: 'Pick or type a reason.' };
  if (!lastWorkingDate || !exitDate.realDate(lastWorkingDate)) return { status: 400, error: 'Pick the last working day.' };
  if (lastWorkingDate > todayIso()) return { status: 400, error: 'Pick today or an earlier date.' };
  const joined = employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : null;
  if (joined && lastWorkingDate < joined) return { status: 400, error: `The last working day cannot be before the joining date (${dmy(joined)}).` };
  if (!['Relieved', 'Exited'].includes(status)) return { status: 400, error: 'Choose Exited or Relieved.' };
  return null;
}

// True when this person is on the HR desk and the emergency switch is still ON (the normal state).
async function deskDirect(user) { return !!user && exitDate.isHrDesk(user) && (await getDirectRelieve()).enabled; }
// Does the whole thing. Throws ExitDateError for refusals; returns { recordId, status, lastWorkingDate, seats, told }.
const relieving = new Set();
async function relieveNow({ employee, user, reason, remarks = null, lastWorkingDate, status = 'Relieved', testFail = false }) {
  const bad = await relieveNowRefusal({ employee, actor: user, reason, lastWorkingDate, status });
  if (bad) throw new exitDate.ExitDateError(bad.status, bad.error, bad.code ? { code: bad.code } : {});
  if (relieving.has(employee.id)) throw new exitDate.ExitDateError(409, `${employee.name} is already being saved. Please wait a moment.`);
  relieving.add(employee.id);
  try {
  const why = clean(reason, 200);
  const note = clean(remarks, 400);
  const who = user.name || user.email;
  const lwd = lastWorkingDate;
  const wasStatus = employee.employmentStatus;
  const live = (await exitDate.liveRecords([employee.id])).get(employee.id);
  const existingReasons = await (async () => {
    try { return await require('../routes/resignations').formConfig(); } catch { return { reasons: [] }; } // eslint-disable-line global-require
  })();
  const isListed = (existingReasons.reasons || []).includes(why);
  const detailReason = isListed ? why : 'Other';
  const detailOther = isListed ? null : why;
  const markText = `Marked ${status} by HR (${who}) on ${new Date().toISOString().slice(0, 10)}. Reason: ${why}.${note ? ` Remarks: ${note}` : ''}`;
  let recordId;
  let priorRecordStatus = null;
  await prisma.$transaction(async (tx) => {
    let rec;
    if (live) {
      priorRecordStatus = live.record.status;
      rec = await tx.employeeRecord.update({ where: { id: live.record.id }, data: { status: 'Relieved', date: lwd, detail: [live.record.detail, markText].filter(Boolean).join('\n').slice(0, 1900) } });
      if (live.detail) {
        await tx.resignationDetail.update({ where: { id: live.detail.id }, data: { approvedLastWorkingDate: lwd, source: DIRECT_MARK, exitComments: markText.slice(0, 900) } });
      } else {
        await tx.resignationDetail.create({ data: { recordId: rec.id, employeeId: employee.id, employeeCode: employee.employeeCode || null, employeeName: employee.name, department: employee.department || null, designation: employee.designation || null, resignationDate: todayIso(), source: DIRECT_MARK, reason: detailReason, reasonOther: detailOther, comments: note, approvedLastWorkingDate: lwd, submittedByUserId: user.id, submittedByName: who } });
      }
    } else {
      rec = await tx.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: employee.id, title: detailReason === 'Other' ? `Other: ${why}`.slice(0, 200) : why, detail: markText.slice(0, 1900), date: lwd, status: 'Relieved', raisedBy: who } });
      await tx.resignationDetail.create({ data: { recordId: rec.id, employeeId: employee.id, employeeCode: employee.employeeCode || null, employeeName: employee.name, department: employee.department || null, designation: employee.designation || null, resignationDate: todayIso(), requestedLastWorkingDate: lwd, approvedLastWorkingDate: lwd, source: DIRECT_MARK, reason: detailReason, reasonOther: detailOther, comments: note, exitComments: markText.slice(0, 900), submittedByUserId: user.id, submittedByName: who } });
    }
    recordId = rec.id;
    await tx.approvalStep.updateMany({ where: { workflow: WF, recordId: rec.id, status: { in: ['Pending', 'Waiting'] } }, data: { status: 'Skipped', note: `Completed by HR - ${who} marked the person ${status}` } });
    await withOverride(() => tx.employee.update({ where: { id: employee.id }, data: { employmentStatus: status, offboardingStatus: 'Cleared' } }));
    const openFnf = await tx.fnfRequest.findFirst({ where: { employeeId: employee.id, status: 'Pending' } });
    if (openFnf) { if (exitDate.isoDay(openFnf.lastWorkingDate) !== lwd) await tx.fnfRequest.update({ where: { id: openFnf.id }, data: { lastWorkingDate: lwd } }); } else await tx.fnfRequest.create({ data: { employeeId: employee.id, lastWorkingDate: lwd } });
    const base = { userId: user.id, actorName: who, entity: 'EmployeeRecord', entityId: rec.id };
    await tx.auditLog.create({ data: { ...base, action: 'Resignation Relieved', fromValue: priorRecordStatus || '(no exit on record)', toValue: status, reason: `Marked ${status} by HR: ${why}` } });
    await tx.auditLog.create({ data: { ...base, action: 'Exit finalized WITHOUT approval (HR direct relieve)', fromValue: wasStatus, toValue: status, reason: `HR marked ${employee.name} ${status} directly, reason ${why}, last working day ${lwd}, by ${who}`.slice(0, 480) } });
    await tx.auditLog.create({ data: { userId: user.id, actorName: who, entity: 'Employee', entityId: employee.id, field: 'employmentStatus', fieldLabel: 'Status', action: `Employee marked ${status} by HR`, fromValue: wasStatus, toValue: status, reason: `${why}; last working day ${lwd}` } });
    if (testFail) throw new Error('Forced failure (test)');
  }, { timeout: 20000, maxWait: 10000 });
  // After the commit: the seat ends on the chosen day (the same helper the normal flow's middleware uses).
  let seats = [];
  try { seats = await require('./seatRelease').releaseSeatsOf(employee.id, { date: lwd, source: 'last working day on the exit record (HR direct relieve)', reason: 'Relieved', userId: user.id, actorName: who }); } catch (e) { console.error('[exitFlow] seat release failed:', e && e.message); } // eslint-disable-line no-console
  // Tell every active Super Admin: bell + task + e-mail when mail is set up (the e-mail row says honestly what happened).
  let told = 0;
  try {
    const sas = (await superAdmins({ allowTest: isTest(employee.name, employee.email) || isTest(user.name, user.email) })).filter((s) => s.id !== user.id);
    const text = `${employee.name} was marked ${status} by ${who}. Reason: ${why}. Last working day ${dmy(lwd)}.`;
    const out = await tell({ userIds: sas.map((s) => s.id), title: `${employee.name} was marked ${status}`, message: text, link: exitLink(recordId), key: `${recordId}:relieve-now:${Date.now()}`, email: true });
    told = out.told.length;
    for (const a of sas.filter((s) => out.told.includes(s.id))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.task.create({ data: { name: `Info: ${employee.name} was marked ${status} by HR`.slice(0, 190), department: 'HR', description: text, status: 'Not Started', priority: 'Medium', assigneeId: a.id, assignedById: user.id, assigneeName: a.name, assignedByName: `${who} (HR)` } }).catch(() => null);
    }
  } catch (e) { console.error('[exitFlow] relieve-now notice failed:', e && e.message); } // eslint-disable-line no-console
  return { recordId, status, lastWorkingDate: lwd, seats, told };
  } finally { relieving.delete(employee.id); }
}

// ---- SEND BACK -----------------------------------------------------------------------
async function sendBack({ recordId, user, note }) {
  const workflow = require('./approvalWorkflow');
  const steps = await workflow.loadSteps(WF, recordId);
  const cur = steps.find((s) => s.status === 'Pending');
  if (!cur) throw new exitDate.ExitDateError(409, 'This exit is not waiting for a decision.');
  const sa = workflow.isSuperAdmin(user);
  if (!(cur.approverUserId === user.id || sa)) throw new exitDate.ExitDateError(403, `This exit is with ${cur.approverName || cur.level}. Only they (or the Super Admin) can send it back.`);
  const text = String(note || '').trim();
  if (text.length < 3) throw new exitDate.ExitDateError(400, 'Say what needs to change before sending it back.');
  const prev = steps.filter((s) => s.seq < cur.seq && s.status === 'Approved' && s.mode !== 'applicant').sort((a, b) => b.seq - a.seq)[0] || null;
  const who = user.name || user.email;
  if (prev) {
    const now = new Date();
    await prisma.approvalStep.update({ where: { id: cur.id }, data: { status: 'Waiting', note: `Sent back by ${who}: ${text}`, activatedAt: null, dueAt: null } });
    await prisma.approvalStep.update({ where: { id: prev.id }, data: { status: 'Pending', activatedAt: now, actedAt: null, actedByUserId: null, actedByName: null, note: `Sent back by ${who}: ${text}`, direct: false } });
  }
  await logAudit({ userId: user.id, actorName: who, action: 'Exit sent back', entity: 'EmployeeRecord', entityId: recordId, fromValue: cur.level, toValue: prev ? prev.level : 'the person who started it', reason: text });
  return { to: prev ? { level: prev.level, name: prev.approverName, userId: prev.approverUserId } : null, from: cur };
}

module.exports = {
  PENDING, SERVING, FINAL_STATUSES, NONFINAL_LEAVING, WF, EXIT_CHECKLIST, FINAL_APPROVERS,
  requestScope, withOverride, store, actorOfRequest, install, ExitBlocked,
  getSettings, saveSettings, finalLevel, canFinalizeExit,
  hrConfig, noticeEnd, clean, applyApproval, applyRejection, closeChain, applyFinalLevelRule,
  startExit, ensureExitRecord, notifyInitiated, notifyTurn, notifyDecided, tell, superAdmins, peopleAround, exitLink,
  finalize, sendBack, exitSummaryLine, isTest, stripTime, named,
  deskDirect, getDirectRelieve, saveDirectRelieve, relieveNowRefusal, relieveNow, DIRECT_KEY, DIRECT_MARK, isTopAccount,
};
