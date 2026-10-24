// ---------------------------------------------------------------------------
// HR SENSITIVE ACTIONS  (founder, 2026-10-14)
//
//   "... ALL access like a Super Admin, but whenever they DELETE, EXPORT or IMPORT
//    something, a NOTIFICATION goes out."
//
// ONE generic watcher for EVERY route, mounted from the guard layer (middleware/auth.js
// requireAuth, only for a login with HR super access: identity.hrSuper, utils/hrSuper.js).
// No route is edited by hand. After the response it decides, from the route method + path
// patterns and the RESPONSE (file headers), whether the request was
//   * a DELETE       (HTTP DELETE, or a POST/PUT/PATCH on a /delete /remove /purge /clear path)
//   * an EXPORT      (Excel / CSV / PDF / zip download, or an /export /download path)
//   * an IMPORT      (/import, /bulk, /upload paths and multipart bulk uploads)
// and, when it succeeded (HTTP < 400, not a preview / dry run), tells every active Super Admin:
//   bell notification + task + audit row (entity 'HrSensitive') + e-mail (setting
//   'Email Super Admins about HR delete/export/import', default ON; honest status when mail is off).
// Wording: "Divya (Internal HR) exported Payroll register for Sep 2026 (36 rows)".
// A real Super Admin is never watched. Same person + module + kind within 5 minutes = ONE
// notification, whose count is bumped (a burst).
//
// ROUTE_REGISTRY below lists routes the generic patterns would mis-name or miss (found by
// scripts/hr-super-coverage.js); `coverage()` is what the report counts.
// Never throws: an alert is a side effect of the action, not the action.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const WINDOW_MS = Number(process.env.HR_ALERT_WINDOW_MS || 5 * 60 * 1000);
const TEST_RE = /zztest|example\.test/i;
const isTest = (u) => !!u && (TEST_RE.test(String(u.name || '')) || TEST_RE.test(String(u.email || '')));

// ---- which module a path belongs to ----------------------------------------
// [prefix (relative to /api), label]; the first match wins.
const MODULES = [
  ['/payroll', 'Payroll'], ['/payslips', 'Payroll'], ['/incentives', 'Incentives'], ['/salary-vouchers', 'Payroll'],
  ['/attendance', 'Attendance'], ['/iclock', 'Attendance'], ['/shift-roster', 'Shift roster'], ['/shift-patterns', 'Shift patterns'],
  ['/leave', 'Leave'], ['/late-permissions', 'Late coming'], ['/timesheet', 'Timesheet'],
  ['/employees', 'Employees'], ['/employee-fields', 'Employees'], ['/kt', 'Employees'], ['/targets', 'Employees'],
  ['/resignations', 'Exit'], ['/exit-center', 'Exit'], ['/disciplinary', 'Disciplinary'], ['/recognition', 'Recognition'],
  ['/assets', 'Assets'], ['/asset-inventory', 'Assets'], ['/stationery', 'Stationery'], ['/expenses', 'Expenses'],
  ['/documents', 'Documents'], ['/announcements', 'Announcements'], ['/helpdesk', 'Helpdesk'],
  ['/lms', 'LMS'], ['/performance', 'Performance'], ['/surveys', 'Surveys'], ['/projects', 'Projects'], ['/tasks', 'Tasks'],
  ['/hrms', 'HRMS'], ['/insights', 'HRMS reports'], ['/approvals', 'Approvals'],
  ['/clients', 'Clients'], ['/client-merge', 'Clients'], ['/invoice-clients', 'Clients'], ['/agreement', 'Agreements'],
  ['/candidates', 'Candidates'], ['/candidate-resumes', 'Candidates'], ['/candidate-duplicates', 'Candidates'],
  ['/requirements', 'Requirements'], ['/job-', 'Requirements'], ['/applications', 'Candidates'], ['/ats-io', 'ATS import/export'],
  ['/ats-reports', 'ATS reports'], ['/ats-report-pack', 'ATS reports'], ['/ats-daily', 'ATS reports'], ['/ats', 'ATS'],
  ['/reports', 'Reports'], ['/dashboard', 'Dashboard'], ['/role-performance', 'Reports'],
  ['/invoices', 'Invoices'], ['/accounts', 'Accounts'], ['/accounts-import', 'Accounts'], ['/bank', 'Bank'], ['/banks', 'Bank'],
  ['/credit-notes', 'Credit notes'], ['/office-expenses', 'Expenses'], ['/vendor', 'Vendors'], ['/partners', 'Partners'], ['/partner-payouts', 'Partners'],
  ['/positions', 'Org structure'], ['/admin/departments', 'Departments & teams'], ['/admin/teams', 'Departments & teams'],
  ['/admin/org-structure', 'Org structure'], ['/admin/users', 'Users'], ['/admin/integrations', 'Integrations'], ['/admin', 'Administration'],
  ['/io', 'Data import/export'], ['/data-import', 'Data import'], ['/messaging', 'Messages'], ['/outreach', 'Outreach'], ['/comm', 'Messages'],
  ['/masters', 'Master lists'], ['/sourcing', 'Sourcing'], ['/portal', 'Portal'], ['/id-card-orders', 'ID cards'], ['/sim-connections', 'SIM connections'],
];
function moduleOf(p) {
  for (const [prefix, label] of MODULES) if (p === prefix || p.startsWith(`${prefix}/`) || (prefix.endsWith('-') && p.startsWith(prefix))) return label;
  const seg = String(p).split('/').filter(Boolean)[0];
  return seg ? seg.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'TeamLink';
}

// ---- classification ---------------------------------------------------------
const NOT_GET = (m) => !['GET', 'HEAD', 'OPTIONS'].includes(m);
const DELETE_PATH = /(^|\/)(delete|remove|purge|bulk-delete|delete-all|wipe|clear|clear-all|erase)(\/|$)/i;
const EXPORT_PATH = /(^|\/|\.)(export|exports|export-all|download|download-all|xlsx|csv)(\/|\.|$)|\.(xlsx|csv|xls|zip)$/i;
const IMPORT_PATH = /(^|\/)(import|imports|bulk-import|bulk-upload|bulk-load|bulk|upload|upload-file|load|history-import|import-[\w-]+|[\w]+-import|apply-import|commit-import)(\/|$)/i;
const PREVIEW_PATH = /(^|\/)(preview|dry-run|dryrun|validate|check|template|templates|sample|mapping|plan|analyse|analyze)(\/|$)/i;
// a single attached file is not a bulk import
const SINGLE_FILE = /(photo|avatar|picture|resume|cv|attachment|attachments|document|documents|logo|signature|stamp|proof|receipt|material|media|image|screenshot|invoice-file|bill|voucher-file|agreement|offer)(\/|$|-)/i;
// A change to someone's pay structure (founder, 2026-10-14): alerted by employee id only, never an amount.
const SALARY_PATH = /^\/payroll\/(structure|ctc-settings)(\/|$)|\/salary-structure|\/salary-templates?(\/|$)|\/salary-versions?(\/|$)/i;
const NOUN_SKIP = new Set(['export', 'exports', 'download', 'downloads', 'xlsx', 'csv', 'pdf', 'import', 'imports', 'bulk', 'upload', 'delete', 'remove', 'all', 'global', 'file', 'management', 'run', 'apply']);

function lc(h) { return String(h || '').toLowerCase(); }
function classify({ method, path, contentType, disposition, query, hasExportRows, multipart, status }) {
  if (status >= 400) return null;
  const ct = lc(contentType);
  const cd = lc(disposition);
  const attachment = cd.includes('attachment');
  const spreadsheet = /spreadsheetml|ms-excel|text\/csv|application\/zip|x-zip/.test(ct);
  const pdfFile = /application\/pdf/.test(ct) && attachment;
  // salary structure edit (before delete: removing a salary version is an edit of the structure)
  if (NOT_GET(method) && SALARY_PATH.test(path)) return 'salary';
  // delete
  if (method === 'DELETE' || (NOT_GET(method) && DELETE_PATH.test(path))) return 'delete';
  // import (before export: an import answers JSON)
  if (NOT_GET(method) && !PREVIEW_PATH.test(path) && (IMPORT_PATH.test(path) || (multipart && !SINGLE_FILE.test(path)))) return 'import';
  // export
  if (spreadsheet || pdfFile || hasExportRows || (attachment && !/^image\//.test(ct)) || (method === 'GET' && EXPORT_PATH.test(path) && attachment)) return 'export';
  return null;
}

// ---- the registry: routes the patterns above would mis-name or miss ----------
// { method, re, kind, module, what }  Filled from scripts/hr-super-coverage.js; checked first.
const ROUTE_REGISTRY = [
  { method: 'POST', re: /^\/employees\/bulk-import(\/commit|\/apply)?\/?$/, kind: 'import', module: 'Employees', what: 'Employee import' },
  { method: 'POST', re: /^\/attendance\/(punches\/)?import(-history)?\/?$/, kind: 'import', module: 'Attendance', what: 'Attendance import' },
  { method: 'POST', re: /^\/leave\/(balances\/)?import\/?$/, kind: 'import', module: 'Leave', what: 'Leave import' },
  { method: 'POST', re: /^\/payroll\/[\w/-]*import\/?$/, kind: 'import', module: 'Payroll', what: 'Payroll import' },
  { method: 'POST', re: /^\/io\/[^/]+\/import\/?$/, kind: 'import', module: 'Data import/export', what: 'Data import' },
  { method: 'POST', re: /^\/ats-io\/import\/[\w-]+\/?$/, kind: 'import', module: 'ATS import/export', what: 'ATS import' },
  { method: 'POST', re: /^\/accounts-import(\/|$)/, kind: 'import', module: 'Accounts', what: 'Accounts import' },
  { method: 'POST', re: /^\/data-import(\/|$)/, kind: 'import', module: 'Data import', what: 'Data import' },
  { method: 'POST', re: /^\/(asset-inventory|assets)\/[\w/-]*import\/?$/, kind: 'import', module: 'Assets', what: 'Asset import' },
  { method: 'POST', re: /^\/employees\/export(\/global)?(\.xlsx)?\/?$/, kind: 'export', module: 'Employees', what: 'Employee export' },
  { method: 'POST', re: /^\/employees\/management\/tl-wise\.xlsx\/?$/, kind: 'export', module: 'Employees', what: 'TL-wise employee export' },
];
function registryHit(method, path) { return ROUTE_REGISTRY.find((r) => r.method === method && r.re.test(path)) || null; }

// ---- pretty bits ------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function periodText(q = {}) {
  const m = String(q.month || q.period || '').match(/^(\d{4})-(\d{2})/);
  if (m) return ` for ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
  if (q.from && q.to) return ` from ${q.from} to ${q.to}`;
  if (q.date) return ` for ${q.date}`;
  return '';
}
function nounOf(p) {
  const segs = String(p).split('/').filter(Boolean).map((s) => s.replace(/\.(xlsx|csv|pdf|zip)$/i, ''));
  for (let i = segs.length - 1; i > 0; i -= 1) {
    const s = segs[i];
    if (NOUN_SKIP.has(s.toLowerCase()) || /^[0-9a-f-]{8,}$/i.test(s) || /^c[a-z0-9]{20,}$/i.test(s) || /^[A-Z0-9_]{1,6}$/.test(s)) continue;
    return s.replace(/[-_]+/g, ' ');
  }
  return '';
}
function filtersText(q = {}) {
  const o = {};
  Object.keys(q || {}).forEach((k) => { if (!/token|password|secret|key/i.test(k) && q[k] !== '' && q[k] !== undefined) o[k] = String(q[k]).slice(0, 60); });
  const s = JSON.stringify(o);
  return s === '{}' ? 'none' : s.slice(0, 300);
}
function summarize(b) {
  if (b === null || b === undefined) return {};
  if (Array.isArray(b)) return { count: b.length };
  if (typeof b !== 'object') return {};
  const n = (...ks) => { for (const k of ks) { const v = b[k]; if (typeof v === 'number') return v; if (Array.isArray(v)) return v.length; } return undefined; };
  const dry = b.dryRun === true || b.dry === true || b.preview === true || b.mode === 'preview' || b.committed === false;
  return {
    dry,
    count: n('count', 'deleted', 'removed', 'total', 'rows', 'imported', 'items', 'results'),
    created: n('created', 'inserted', 'added'), updated: n('updated', 'changed'), skipped: n('skipped', 'failed', 'rejected'),
  };
}

// ---- the people to tell -----------------------------------------------------
async function recipients(actor, cfg) {
  const where = [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }];
  if (cfg.notifyAdmins) where.push({ role: 'ADMIN' });
  const rows = await prisma.user.findMany({ where: { status: 'Active', OR: where }, select: { id: true, name: true, email: true, role: true } });
  const t = isTest(actor);
  return rows.filter((u) => u.id !== actor.id && (t ? isTest(u) : !isTest(u)));
}

// ---- the burst book (in memory; the audit rows are the record) ---------------
const bursts = new Map(); // key -> { at, n, rows, auditId, notes:[{id,userId}], tasks:[ids], text }
function resetForTests() { bursts.clear(); }

const VERB = { delete: 'deleted', export: 'exported', import: 'imported', salary: 'edited' };
const TITLE = { delete: 'Internal HR deleted something', export: 'Internal HR exported data', import: 'Internal HR imported data', salary: 'Internal HR edited a salary structure' };

function sentence(ev, n, rows) {
  const who = `${ev.actorName} (${ev.label})`;
  let s = `${who} ${VERB[ev.kind]} ${ev.what}`;
  const bits = [];
  if (rows !== null && rows !== undefined) bits.push(`${rows} ${rows === 1 ? 'row' : 'rows'}`);
  else if (ev.kind === 'export') bits.push('file');
  if (ev.kind === 'import' && (ev.created || ev.updated)) bits.push(`${ev.created || 0} new, ${ev.updated || 0} updated`);
  if (n > 1) bits.push(`${n} times in ${Math.round(WINDOW_MS / 60000)} min`);
  if (bits.length) s += ` (${bits.join(', ')})`;
  return `${s}.`;
}

async function emailAdmins(actor, cfg, admins, text, subject) {
  const out = { sent: 0, status: 'off' };
  try {
    if (!cfg.emailSuperAdmins) return out;
    if (isTest(actor) || String(process.env.DATA_IO_EMAIL || '').toLowerCase() === 'off') { out.status = 'skipped (test)'; return out; }
    const mailer = require('./mailer'); // eslint-disable-line global-require
    for (const r of admins) {
      if (!r.email || mailer.isReservedTestAddress(r.email)) continue;
      // eslint-disable-next-line no-await-in-loop
      const sent = await mailer.sendMail({ to: r.email, subject, text, useEmployeeFrom: false });
      out.sent += sent.ok ? 1 : 0;
      out.status = sent.ok ? 'sent' : (sent.notConfigured ? 'not sent: no email provider set up' : `failed: ${String(sent.error || '').slice(0, 100)}`);
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: null, title: subject.slice(0, 190), message: text.slice(0, 4000), channel: 'Email', recipient: r.email, status: out.status } }).catch(() => {});
    }
  } catch (e) { out.status = `failed: ${e && e.message}`; }
  return out;
}

// Events of the same burst key are handled ONE AT A TIME (a burst of requests finishes at nearly the same moment),
// so the second sees the first's entry and only bumps the count.
const chains = new Map();
function record(ev) {
  const key = `${ev.actorId}|${ev.module}|${ev.kind}${ev.kind === 'salary' ? `|${ev.what}` : ''}`;
  const run = (chains.get(key) || Promise.resolve()).then(() => recordOne(ev));
  chains.set(key, run.catch(() => null).then(() => { if (chains.get(key) === undefined) return; }));
  return run;
}

// Records one event. Returns { first, n, notified } and never throws.
async function recordOne(ev) {
  try {
    const hrSuper = require('./hrSuper'); // eslint-disable-line global-require
    const cfg = await hrSuper.settings();
    const key = `${ev.actorId}|${ev.module}|${ev.kind}${ev.kind === 'salary' ? `|${ev.what}` : ''}`;
    const now = Date.now();
    const rows = (v) => (v === undefined || v === null ? null : Number(v));
    let b = bursts.get(key);
    if (b && now - b.at < WINDOW_MS) {
      b.n += 1;
      b.rows = (b.rows === null && rows(ev.count) === null) ? null : (b.rows || 0) + (rows(ev.count) || 0);
      const text = sentence(ev, b.n, b.rows);
      await prisma.auditLog.update({ where: { id: b.auditId }, data: { toValue: text, reason: `filters: ${ev.filters}; IP ${ev.ip}; ${b.n} times` } }).catch(() => {});
      for (const x of b.notes) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.update({ where: { id: x }, data: { message: text } }).catch(() => {});
      }
      for (const t of b.tasks) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.task.update({ where: { id: t }, data: { description: text } }).catch(() => {});
      }
      return { first: false, n: b.n };
    }
    const admins = await recipients({ id: ev.actorId, name: ev.actorName, email: ev.actorEmail }, cfg);
    const text = sentence(ev, 1, rows(ev.count));
    const audit = await prisma.auditLog.create({
      data: {
        userId: ev.actorId, actorName: ev.actorName, action: `HR ${ev.kind} — ${ev.module}`, entity: 'HrSensitive', entityId: ev.entityId || null,
        field: ev.kind, fieldLabel: ev.module, toValue: text, reason: `filters: ${ev.filters}; IP ${ev.ip}; 1 time`,
      },
    });
    b = { at: now, n: 1, rows: rows(ev.count), auditId: audit.id, notes: [], tasks: [] };
    for (const a of admins) {
      // eslint-disable-next-line no-await-in-loop
      const note = await prisma.notification.create({ data: { userId: a.id, title: TITLE[ev.kind], message: text, channel: 'In-App', recipient: a.name, status: 'Sent' } });
      b.notes.push(note.id);
      // eslint-disable-next-line no-await-in-loop
      const task = await prisma.task.create({
        data: {
          name: `Check: ${ev.actorName} ${VERB[ev.kind]} ${ev.what}`.slice(0, 190), department: 'HR', description: text, status: 'Not Started', priority: 'Medium',
          assigneeId: a.id, assignedById: ev.actorId, assigneeName: a.name, assignedByName: 'TeamLink (HR sensitive action)',
        },
      }).catch(() => null);
      if (task) b.tasks.push(task.id);
    }
    bursts.set(key, b);
    const mail = await emailAdmins({ id: ev.actorId, name: ev.actorName, email: ev.actorEmail }, cfg, admins, text, `TeamLink: ${text.replace(/\.$/, '')}`);
    if (mail.status !== 'off') await prisma.auditLog.update({ where: { id: audit.id }, data: { reason: `filters: ${ev.filters}; IP ${ev.ip}; 1 time; e-mail: ${mail.status}` } }).catch(() => {});
    return { first: true, n: 1, notified: admins.length, mail: mail.status };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[hrSensitiveAlert] %s', e && e.message);
    return { first: false, n: 0, error: e && e.message };
  }
}

// ---- the hook ---------------------------------------------------------------
// Another helper (utils/dataIoNotify.js) knows the exact screen and row count: it leaves them here.
function note(req, info) {
  if (!req || !req.user || !req.user.hrSuper || !req._hsWatched) return false;
  req._hsInfo = { ...(req._hsInfo || {}), ...info };
  return true;
}

function watch(req, res) {
  if (req._hsWatched) return;
  req._hsWatched = true;
  const origJson = res.json.bind(res);
  res.json = (body) => { try { req._hsBody = summarize(body); } catch { /* ignore */ } return origJson(body); };
  res.on('finish', () => {
    (async () => {
      try {
        const hrSuper = require('./hrSuper'); // eslint-disable-line global-require
        const user = req.user;
        if (!user || !user.hrSuper) return;
        const method = String(req.method || '').toUpperCase();
        const p = hrSuper.pathOf(req);
        const reg = registryHit(method, p);
        const body = req._hsBody || {};
        if (body.dry) return;
        const ct = res.getHeader('content-type');
        const multipart = /multipart\/form-data/i.test(String(req.headers['content-type'] || ''));
        const kind = (reg && !PREVIEW_PATH.test(p) && res.statusCode < 400 ? reg.kind : null) || classify({
          method, path: p, contentType: ct, disposition: res.getHeader('content-disposition'), query: req.query,
          hasExportRows: res.getHeader('x-export-rows') !== undefined, multipart, status: res.statusCode,
        });
        if (!kind) return;
        const hint = req._hsInfo || {};
        if (kind === 'salary') {
          const m = p.match(/^\/payroll\/structure\/([^/]+)\/?$/);
          let what = 'salary settings';
          if (m && !/^versions$/.test(m[1])) {
            const emp = await prisma.employee.findUnique({ where: { id: m[1] }, select: { employeeCode: true } }).catch(() => null);
            what = `salary structure of ${emp && emp.employeeCode ? emp.employeeCode : 'an employee'}`;
          } else if (/structure\/versions/.test(p)) what = 'a salary structure version';
          else if (/ctc-settings/.test(p)) what = 'the company CTC settings';
          await record({
            kind, module: 'Payroll', what, count: null, actorId: user.id, actorName: user.name || user.email, actorEmail: user.email,
            label: user.hrSuper.label || 'Internal HR', filters: 'none', ip: require('./clientIp').ipOf(req), // eslint-disable-line global-require
          });
          return;
        }
        const module = hint.module || (reg && reg.module) || moduleOf(p);
        const noun = nounOf(p);
        const base = (reg && reg.what) || (noun && noun.toLowerCase() !== module.toLowerCase() ? `${module} ${noun}` : module);
        const what = hint.what || `${base}${periodText(req.query)}`;
        const xr = res.getHeader('x-export-rows');
        const count = hint.count !== undefined ? hint.count : (xr !== undefined ? Number(xr) : (kind === 'delete' ? (body.count !== undefined ? body.count : 1) : body.count));
        await record({
          kind, module, what, count, created: hint.created !== undefined ? hint.created : body.created, updated: hint.updated !== undefined ? hint.updated : body.updated,
          actorId: user.id, actorName: user.name || user.email, actorEmail: user.email, label: user.hrSuper.label || 'Internal HR',
          filters: filtersText(req.query), ip: require('./clientIp').ipOf(req), entityId: hint.entityId || null, // eslint-disable-line global-require
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[hrSensitiveAlert] watch: %s', e && e.message);
      }
    })();
  });
}

module.exports = {
  WINDOW_MS, MODULES, ROUTE_REGISTRY, moduleOf, classify, registryHit, nounOf, periodText, record, note, watch, resetForTests, sentence,
};
