// ---------------------------------------------------------------------------
// HR WATCH  (founder, 2026-10-16)
//
//   "Divya Sri Sivatmika is HR and her TL is Purna Chandra Sekhar. Whatever Divya DOES,
//    Purna must be told by NOTIFICATION so Purna knows."
//
// ONE small, data-driven watch list in the AppSetting 'hr-watch':
//     [ { "actorEmployeeCode": "TL517", "notifyEmployeeCodes": ["TL309"], "includeSuperAdmins": false } ]
//   * the actor's team lead (reporting manager) is the default when notifyEmployeeCodes is left out;
//   * nobody is hard-coded; an empty / missing setting = nothing is watched and nothing is slowed down.
//
// HOW (no route is edited):
//   1. utils/audit.js (logAudit / logFieldChanges) calls onAudit() after every audit row. A write by a watched
//      person becomes ONE bell notification for each person to tell.
//   2. middleware/auth.js calls lookup() + enter() for each request. For a watched person only, a request that
//      WROTE something (POST / PUT / PATCH / DELETE, or a file export) but raised no audit row is told from the
//      response instead ("Divya (HR): changed Attendance"). A request that raised an audit row is never told twice.
// Noise control: the same person + same action within 2 minutes = ONE notification that is UPDATED with a count
// (and moved to the top, unread again). The actor is never told about themselves. Never throws, never awaited by
// the action; a failure is logged once. The notification is written with prisma directly, never through logAudit,
// so it cannot trigger another notification. No amounts, passwords or tokens are ever put in the text.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const prisma = require('../db');

const SETTINGS_KEY = 'hr-watch';
const WINDOW_MS = Number(process.env.HR_WATCH_WINDOW_MS || 2 * 60 * 1000);
const CACHE_MS = 15000;
const als = new AsyncLocalStorage();

// ---- the list ---------------------------------------------------------------
function clean(v) {
  const raw = Array.isArray(v) ? v : (v && Array.isArray(v.entries) ? v.entries : []);
  const seen = new Set();
  const up = (x) => String(x || '').trim();
  return raw
    .map((e) => ({
      actorEmployeeCode: up(e && e.actorEmployeeCode),
      notifyEmployeeCodes: Array.isArray(e && e.notifyEmployeeCodes) ? e.notifyEmployeeCodes.map(up).filter(Boolean) : [],
      includeSuperAdmins: !!(e && e.includeSuperAdmins),
    }))
    .filter((e) => e.actorEmployeeCode && !seen.has(e.actorEmployeeCode.toUpperCase()) && seen.add(e.actorEmployeeCode.toUpperCase()));
}

let cache = null; // Map actorUserId -> { actorName, first, label, targets: [userId] }
let cacheAt = 0;
let loading = null;
function invalidate() { cache = null; loading = null; }

const empByCode = async (code) => (await prisma.employee.findFirst({ where: { employeeCode: code } }))
  || (await prisma.employee.findFirst({ where: { employeeCode: String(code).toUpperCase() } }));

async function activeUserIds(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return [];
  const us = await prisma.user.findMany({ where: { id: { in: list }, status: 'Active' }, select: { id: true } });
  return us.map((u) => u.id);
}

function firstNameOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.find((p) => p.length > 1) || parts[0] || 'Someone';
}

async function build() {
  const out = new Map();
  let entries = [];
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    entries = row ? clean(JSON.parse(row.value)) : [];
  } catch { entries = []; }
  for (const e of entries) {
    // eslint-disable-next-line no-await-in-loop
    const actor = await empByCode(e.actorEmployeeCode).catch(() => null);
    if (!actor || !actor.userId) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { id: true, name: true, hrmsRole: true, atsRole: true, role: true } }).catch(() => null);
    if (!user) continue; // eslint-disable-line no-continue
    let ids = [];
    if (e.notifyEmployeeCodes.length) {
      for (const c of e.notifyEmployeeCodes) {
        // eslint-disable-next-line no-await-in-loop
        const t = await empByCode(c).catch(() => null);
        if (t && t.userId) ids.push(t.userId);
      }
    } else if (actor.reportingManagerId) {
      // eslint-disable-next-line no-await-in-loop
      const m = await prisma.employee.findUnique({ where: { id: actor.reportingManagerId }, select: { userId: true } }).catch(() => null);
      if (m && m.userId) ids.push(m.userId);
    } else if (actor.tl) {
      // eslint-disable-next-line no-await-in-loop
      const ms = await prisma.employee.findMany({ where: { name: actor.tl, userId: { not: null } }, select: { userId: true } }).catch(() => []);
      if (ms.length === 1) ids.push(ms[0].userId);
    }
    if (e.includeSuperAdmins) {
      // eslint-disable-next-line no-await-in-loop
      const sas = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }] }, select: { id: true } }).catch(() => []);
      ids = ids.concat(sas.map((s) => s.id));
    }
    // eslint-disable-next-line no-await-in-loop
    const targets = (await activeUserIds(ids)).filter((id) => id !== user.id);
    const label = user.hrmsRole === 'HR' || user.atsRole === 'HR' ? 'HR' : (actor.designation || 'Team');
    out.set(user.id, { actorName: user.name, first: firstNameOf(user.name), label, targets });
  }
  return out;
}

// The watch entry of a login, or null. Cached; never throws.
async function lookup(userId) {
  try {
    if (!userId) return null;
    if (!cache || Date.now() - cacheAt > CACHE_MS) {
      if (!loading) loading = build().then((m) => { cache = m; cacheAt = Date.now(); loading = null; return m; }).catch((e) => { loading = null; throw e; });
      await loading;
    }
    const w = cache ? cache.get(userId) : null;
    return w && w.targets.length ? w : null;
  } catch (e) { warnOnce('lookup', e); return null; }
}

// ---- wording ----------------------------------------------------------------
const ENTITY_LABEL = {
  LeaveRequest: 'Leave request', LeaveBalance: 'Leave balances', AttendanceRegularization: 'Regularization', LatePermission: 'Late-coming request',
  Attendance: 'Attendance', EmployeePayrollRun: 'Payroll of', PayrollRun: 'Payroll run', Payslip: 'Payslip', Employee: 'Employee', EmployeeRecord: 'Exit record',
  Announcement: 'Announcement', Document: 'Document', Holiday: 'Holiday', Task: 'Task', Asset: 'Asset',
};
const NAME_MODEL = { LeaveRequest: 'leaveRequest', AttendanceRegularization: 'attendanceRegularization', LatePermission: 'latePermission', Attendance: 'attendance', EmployeePayrollRun: 'employeePayrollRun', Payslip: 'payslip' };
const LINK = {
  Employee: (id) => `/employees/${id}`, LeaveRequest: () => '/leave', LeaveBalance: () => '/leave', AttendanceRegularization: () => '/attendance', LatePermission: () => '/attendance',
  Attendance: () => '/attendance', EmployeePayrollRun: () => '/payroll', PayrollRun: () => '/payroll', Payslip: () => '/payroll', Announcement: () => '/employee-services', Document: () => '/employee-services',
  Holiday: () => '/leave', EmployeeRecord: () => '/employee-services?tab=resignation',
};
const labelOf = (entity) => ENTITY_LABEL[entity] || String(entity || '').replace(/([a-z])([A-Z])/g, '$1 $2');
// Words that mean the value could be a secret or a pay figure: the value is left out.
const SENSITIVE = /payroll|salary|ctc|payslip|password|token|secret|\bkey\b|bank|incentive|otp|voucher/i;
// Audit rows that are not an action on data (sign-in, reads, the "act as" log).
const SKIP_ACTION = /^(signed in|sign-in|failed sign-in|verification code|password changed|password reset|payslip downloaded|act as|login re-derived|login scope followed|view as)/i;

async function targetName(entity, entityId) {
  if (!entityId) return null;
  try {
    if (entity === 'Employee') {
      const e = await prisma.employee.findUnique({ where: { id: entityId }, select: { name: true } });
      return e ? e.name : null;
    }
    const model = NAME_MODEL[entity];
    if (!model || !prisma[model]) return null;
    const r = await prisma[model].findUnique({ where: { id: entityId }, select: { employeeId: true } });
    if (!r) return null;
    const e = await prisma.employee.findUnique({ where: { id: r.employeeId }, select: { name: true } });
    return e ? e.name : null;
  } catch { return null; }
}

function safeValue(ev) {
  const v = String(ev.toValue === undefined || ev.toValue === null ? '' : ev.toValue).replace(/\s+/g, ' ').trim();
  if (!v || /^[{[]/.test(v)) return '';
  if (SENSITIVE.test(`${ev.action} ${ev.entity || ''} ${v}`)) return '';
  return v.slice(0, 80);
}
function targetText(ev, name) {
  const lab = ev.entity ? labelOf(ev.entity) : '';
  if (!lab) return '';
  return name ? (/of$/.test(lab) ? `${lab} ${name}` : `${lab} of ${name}`) : lab;
}
function sentence(w, ev, name, n, people, windowMin) {
  const who = `${w.first} (${w.label})`;
  if (n > 1) {
    if (/^attendance marked/i.test(ev.action)) return `${who} marked attendance for ${people || n} ${(people || n) === 1 ? 'person' : 'people'} (${n} entries in the last ${windowMin} min).`;
    return `${who}: ${ev.action} - ${n} times in the last ${windowMin} min${targetText(ev, name) ? ` (latest: ${targetText(ev, name)})` : ''}.`;
  }
  const t = targetText(ev, name);
  const val = safeValue(ev);
  return `${who}: ${ev.action}${t ? ` - ${t}` : ''}${val ? ` (${val})` : ''}.`;
}

// ---- the burst book + the write ---------------------------------------------
const bursts = new Map(); // key -> { at, n, ids: Map(userId->noteId), names:Set }
const chains = new Map();
function resetForTests() { bursts.clear(); chains.clear(); cache = null; loading = null; warned.clear(); }
const warned = new Set();
function warnOnce(what, e) {
  if (warned.has(what)) return;
  warned.add(what);
  // eslint-disable-next-line no-console
  console.error('[hrWatch] %s failed (the action itself was not affected): %s', what, e && e.message);
}

async function record(ev) {
  const w = await lookup(ev.actorUserId);
  if (!w) return null;
  const targets = w.targets.filter((id) => id !== ev.actorUserId);
  if (!targets.length) return null;
  const key = `${ev.actorUserId}|${ev.entity || ev.module || ''}|${ev.action}`;
  const run = (chains.get(key) || Promise.resolve()).then(() => recordOne(w, ev, key, targets));
  chains.set(key, run.catch(() => null));
  return run;
}

async function recordOne(w, ev, key, targets) {
  try {
    const now = Date.now();
    const name = await targetName(ev.entity, ev.entityId);
    const link = ev.link || (ev.entity && LINK[ev.entity] ? LINK[ev.entity](ev.entityId) : null);
    const windowMin = Math.max(1, Math.round(WINDOW_MS / 60000));
    let b = bursts.get(key);
    if (b && now - b.at < WINDOW_MS) {
      b.n += 1;
      b.at = now;
      if (name) b.names.add(name);
      const text = sentence(w, ev, name, b.n, b.names.size, windowMin);
      for (const [, noteId] of b.ids) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.update({
          where: { id: noteId },
          data: { title: `${w.first} (${w.label}): ${ev.action} x${b.n}`.slice(0, 190), message: `${text}${link ? `\nOpen: ${link}` : ''}`, read: false, createdAt: new Date() },
        }).catch((e) => warnOnce('update', e));
      }
      return { first: false, n: b.n };
    }
    b = { at: now, n: 1, ids: new Map(), names: new Set(name ? [name] : []) };
    const text = sentence(w, ev, name, 1, 1, windowMin);
    const users = await prisma.user.findMany({ where: { id: { in: targets } }, select: { id: true, name: true } });
    for (const u of users) {
      // eslint-disable-next-line no-await-in-loop
      const note = await prisma.notification.create({
        data: { userId: u.id, title: `${w.first} (${w.label}): ${ev.action}`.slice(0, 190), message: `${text}${link ? `\nOpen: ${link}` : ''}`, channel: 'In-App', recipient: u.name, status: 'Sent' },
      });
      b.ids.set(u.id, note.id);
    }
    bursts.set(key, b);
    if (bursts.size > 500) { for (const [k, v] of bursts) if (now - v.at > WINDOW_MS) bursts.delete(k); }
    return { first: true, n: 1, notified: users.length };
  } catch (e) { warnOnce('notify', e); return null; }
}

// ---- hook 1: the central audit helper ----------------------------------------
// row: the logAudit arguments. Returns nothing; never throws; the caller does not wait.
function onAudit(row) {
  try {
    const store = als.getStore();
    if (store) store.fired = true;
    if (!row || !row.userId || !row.action || SKIP_ACTION.test(String(row.action))) return;
    if (row.entity === 'HrSensitive') return;
    const ev = { actorUserId: row.userId, action: String(row.action).trim(), entity: row.entity || null, entityId: row.entityId || null, toValue: row.toValue };
    // ONE request = ONE notification: a single approval writes several audit rows ("Leave approved at ...", "Leave approved");
    // they are collected and the clearest one is reported when the request ends.
    if (store && !store.flushed) { store.events.push(ev); return; }
    fire(ev);
  } catch (e) { warnOnce('hook', e); }
}
function fire(ev) { setImmediate(() => { Promise.resolve().then(() => record(ev)).catch((e) => warnOnce('hook', e)); }); }
// The clearest event of a request, per actor: one about a known record (leave request, employee ...) wins; the last such one.
function flush(store) {
  if (store.flushed) return;
  store.flushed = true;
  const byActor = new Map();
  for (const ev of store.events) {
    const cur = byActor.get(ev.actorUserId);
    const rank = ENTITY_LABEL[ev.entity] ? 1 : 0;
    if (!cur || rank >= cur.rank) byActor.set(ev.actorUserId, { rank, ev });
  }
  for (const { ev } of byActor.values()) fire(ev);
}

// ---- hook 2: writes that raise no audit row (request level) -------------------
const NOT_GET = (m) => !['GET', 'HEAD', 'OPTIONS'].includes(m);
const NOISE_PATH = /^\/(auth|notifications|admin\/notifications|me|assistant|agent|comm|conversations|messaging\/(read|seen|typing))(\/|$)|\/(read|seen|heartbeat|ping|presence|popups|preview|dry-run|validate|check|search|track|touch)(\/|$)/i;
const VERB = { delete: 'Deleted', export: 'Exported', import: 'Imported', salary: 'Edited' };

// Async part: is this login watched? (a cached read) -> w or null
const enterLookup = lookup;
// Sync part, called right after lookup() says yes: marks the request and reports it when it finishes.
function enter(req, res) {
  if (req._hrWatch) return;
  const store = { fired: false, flushed: false, events: [] };
  req._hrWatch = store;
  als.enterWith(store);
  res.on('close', () => flush(store)); // after 'finish'; also covers a dropped connection
  res.on('finish', () => {
    try {
      flush(store);
      if (store.fired || !req.user || res.statusCode >= 400) return;
      const alert = require('./hrSensitiveAlert'); // eslint-disable-line global-require
      const p = require('./hrSuper').pathOf(req); // eslint-disable-line global-require
      const method = String(req.method || '').toUpperCase();
      if (NOISE_PATH.test(p)) return;
      const kind = alert.classify({
        method, path: p, contentType: res.getHeader('content-type'), disposition: res.getHeader('content-disposition'), query: req.query,
        hasExportRows: res.getHeader('x-export-rows') !== undefined, multipart: /multipart\/form-data/i.test(String(req.headers['content-type'] || '')), status: res.statusCode,
      });
      if (!kind && !NOT_GET(method)) return;
      const module = alert.moduleOf(p);
      const action = kind === 'salary' ? 'Edited salary settings' : kind ? `${VERB[kind]} ${module} data` : `Changed ${module}`;
      const ev = { actorUserId: req.user.id, action, entity: null, entityId: null, module };
      setImmediate(() => { Promise.resolve().then(() => record(ev)).catch((e) => warnOnce('hook', e)); });
    } catch (e) { warnOnce('finish', e); }
  });
}

module.exports = {
  SETTINGS_KEY, WINDOW_MS, clean, invalidate, lookup: enterLookup, enter, onAudit, record, sentence, resetForTests, firstNameOf,
};
