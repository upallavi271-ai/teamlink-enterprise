// ---------------------------------------------------------------------------
// AUDIENCE — "Send to: Everyone / By department / Individual employee(s)".
//
// One rule for every Employee Services and Performance & Development form that
// sends something to people or assigns work to them (announcements, surveys,
// documents, targets, recognition, KT sessions, projects, shift roster,
// timesheet tasks). The browser's AudiencePicker produces
//
//   { mode: 'everyone' | 'departments' | 'individuals',
//     departments: string[], employeeIds: string[] }
//
// and resolveAudience() below turns it into the exact list of employees it
// reaches, INSIDE THE CALLER'S SCOPE (utils/scope.js employeeWhere()):
//
//   everyone     every active employee the caller may reach — for HR / Admin
//                that is the company, for a TL it is their team.
//   departments  one or MANY departments. Each must be one the caller's scope
//                reaches, or the whole request is refused with 403 — nothing
//                is silently dropped.
//   individuals  one or MANY employees. Every id must be inside the caller's
//                scope, or 403.
//
// Exited people (Relieved / Exited / Exit Process) are never reached — the
// same rule LMS assignment uses.
//
// deliver() is the "Also deliver via" half. In-app is always written. Email,
// SMS and WhatsApp are real (Administration -> Integrations; utils/messaging.js)
// and each is really sent when THAT channel is configured; a channel that is
// not configured records its rows as "Not sent — no provider" and transmits
// nothing.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { employeeWhere, scopeDepartments, scopeOf, OUT_OF_SCOPE } = require('./scope');
const { NOT_SYSTEM_EMPLOYEE } = require('./systemAccounts');

const EXITED = ['Relieved', 'Exited', 'Exit Process'];
const ACTIVE = { employmentStatus: { notIn: EXITED } };
const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
const NO_PROVIDER = 'Not sent — no provider';

// --- small parsers ----------------------------------------------------------
function list(value) {
  if (Array.isArray(value)) return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  if (typeof value === 'string' && value.trim()) {
    const t = value.trim();
    if (t.startsWith('[')) {
      try { return list(JSON.parse(t)); } catch { return []; }
    }
    return [...new Set(t.split(',').map((v) => v.trim()).filter(Boolean))];
  }
  return [];
}

const MODE_ALIASES = {
  everyone: 'everyone', all: 'everyone', 'all employees': 'everyone',
  departments: 'departments', department: 'departments', 'by department': 'departments',
  individuals: 'individuals', individual: 'individuals', employees: 'individuals',
};

// The audience a request asked for, or null when it asked for none (a legacy
// single-target call, which the caller then handles exactly as before).
function parseAudience(body) {
  const b = body || {};
  const a = (b.audience && typeof b.audience === 'object') ? b.audience : null;
  const rawMode = a ? a.mode : b.audienceMode;
  const departments = list(a ? a.departments : b.departments);
  const employeeIds = list(a ? a.employeeIds : b.employeeIds);
  if (!a && rawMode === undefined && !Array.isArray(b.departments) && !Array.isArray(b.employeeIds)) return null;
  let mode = MODE_ALIASES[String(rawMode || '').trim().toLowerCase()];
  if (!mode) mode = employeeIds.length ? 'individuals' : departments.length ? 'departments' : 'everyone';
  return {
    mode,
    departments: mode === 'departments' ? departments : [],
    employeeIds: mode === 'individuals' ? employeeIds : [],
  };
}

// The "Also deliver via" ticks. Accepts ['Email','SMS'] or {email:true,...}.
function parseChannels(value) {
  if (Array.isArray(value)) {
    return CHANNELS.filter((c) => value.map((v) => String(v).toLowerCase()).includes(c.toLowerCase()));
  }
  if (value && typeof value === 'object') {
    return CHANNELS.filter((c) => !!value[c.toLowerCase()] || !!value[c]);
  }
  return [];
}

// --- scope ------------------------------------------------------------------
const PICK = {
  id: true, name: true, employeeCode: true, department: true, designation: true,
  email: true, phone: true, userId: true, employmentStatus: true, team: true,
};

// Every active employee this login may reach.
async function reachableEmployees(user, narrow = {}) {
  return prisma.employee.findMany({
    // Super Admin is a system account: never in an "Everyone" / department fan-out.
    where: { AND: [employeeWhere(user), ACTIVE, narrow, NOT_SYSTEM_EMPLOYEE] },
    select: PICK,
    orderBy: { name: 'asc' },
  });
}

// The departments this login may pick under "By department". A company-wide
// HRMS login gets every department; a scoped lead gets their own department
// list plus any department their reachable people sit in (a direct report
// filed elsewhere), and nothing more.
async function allowedDepartments(user, reachable) {
  const all = (await prisma.department.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map((d) => d.name);
  const scoped = scopeDepartments(user);
  if (scoped === undefined) return all;
  const people = reachable || await reachableEmployees(user);
  const set = new Set([...scoped.filter((d) => all.includes(d)), ...people.map((p) => p.department).filter(Boolean)]);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function labelFor(aud, employees) {
  if (aud.mode === 'everyone') return 'All Employees';
  if (aud.mode === 'departments') {
    return aud.departments.length === 1 ? `${aud.departments[0]} Department` : aud.departments.join(', ');
  }
  const names = employees.map((e) => e.name);
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

// { ok, employees, label, audience } or { ok: false, status, error }.
async function resolveAudience(user, aud) {
  if (!aud) return { ok: false, status: 400, error: 'Choose who this is for.' };
  const reachable = await reachableEmployees(user);

  if (aud.mode === 'departments') {
    if (!aud.departments.length) return { ok: false, status: 400, error: 'Pick at least one department.' };
    const allowed = await allowedDepartments(user, reachable);
    const outside = aud.departments.filter((d) => !allowed.includes(d));
    if (outside.length) {
      return { ok: false, status: 403, error: `${OUT_OF_SCOPE.error}: ${outside.join(', ')}` };
    }
    const employees = reachable.filter((e) => aud.departments.includes(e.department));
    return { ok: true, employees, label: labelFor(aud, employees), audience: aud };
  }

  if (aud.mode === 'individuals') {
    if (!aud.employeeIds.length) return { ok: false, status: 400, error: 'Pick at least one employee.' };
    // Scope first (ignoring employment status) so an out-of-scope id is a 403,
    // then the exited rule, so an exited pick is reported, not a scope error.
    const inScope = await prisma.employee.findMany({
      where: { AND: [employeeWhere(user), { id: { in: aud.employeeIds } }] },
      select: { id: true },
    });
    if (inScope.length !== aud.employeeIds.length) {
      const n = aud.employeeIds.length - inScope.length;
      return { ok: false, status: 403, error: `${OUT_OF_SCOPE.error}: ${n} of the selected employee(s) cannot be reached by your login.` };
    }
    const byId = new Map(reachable.map((e) => [e.id, e]));
    const employees = aud.employeeIds.map((id) => byId.get(id)).filter(Boolean);
    if (!employees.length) return { ok: false, status: 400, error: 'Every selected employee has left the company.' };
    return { ok: true, employees, label: labelFor(aud, employees), audience: aud };
  }

  // "Everyone" from a SCOPED login means everyone in their scope, not the
  // company — so the row is stored against their departments, and a TL's
  // "everyone" never becomes a company-wide notice.
  const scoped = scopeDepartments(user);
  if (scoped !== undefined) {
    const allowed = await allowedDepartments(user, reachable);
    return {
      ok: true,
      employees: reachable,
      label: allowed.length === 1 ? `${allowed[0]} Department` : `Everyone in ${allowed.join(', ')}`,
      audience: { mode: 'everyone', departments: [], employeeIds: [], scopedDepartments: allowed },
    };
  }
  return { ok: true, employees: reachable, label: labelFor(aud, reachable), audience: { mode: 'everyone', departments: [], employeeIds: [] } };
}

// The columns a targeted row stores: comma-separated departments and a JSON
// array of employee ids, both NULL for "everyone".
function storedColumns(aud) {
  if (aud && aud.mode === 'everyone' && Array.isArray(aud.scopedDepartments) && aud.scopedDepartments.length) {
    return { departments: aud.scopedDepartments.join(','), employeeIds: null };
  }
  return {
    departments: aud && aud.mode === 'departments' && aud.departments.length ? aud.departments.join(',') : null,
    employeeIds: aud && aud.mode === 'individuals' && aud.employeeIds.length ? JSON.stringify(aud.employeeIds) : null,
  };
}

// What the viewer needs to decide "does this targeted row reach me / my
// scope": their own employee id and department, plus — for a lead — the set of
// employee ids and departments their scope covers. `global` short-circuits.
async function viewerContext(user) {
  const s = scopeOf(user);
  const scoped = scopeDepartments(user);
  const global = scoped === undefined;
  const ctx = {
    global,
    selfOnly: !!(user.caps && user.caps.hrmsSelfOnly),
    userId: user.id,
    employeeId: s.employeeId || null,
    department: user.department || null,
    departments: new Set(global ? [] : scoped),
    employeeIds: new Set(s.employeeId ? [s.employeeId] : []),
  };
  if (!global && !ctx.selfOnly) {
    const people = await prisma.employee.findMany({ where: employeeWhere(user), select: { id: true, department: true } });
    people.forEach((p) => { ctx.employeeIds.add(p.id); if (p.department) ctx.departments.add(p.department); });
  }
  if (ctx.selfOnly) {
    // An employee's own reach is their own record and their own department.
    ctx.departments = new Set(ctx.department ? [ctx.department] : []);
  }
  return ctx;
}

// Does a row carrying (departments, employeeIds) reach this viewer?
// `legacy` answers for a row with neither column set (targeted the old way).
function reaches(ctx, row, legacy = () => true) {
  if (ctx.global) return true;
  if (row.createdById && row.createdById === ctx.userId) return true;
  if (row.postedById && row.postedById === ctx.userId) return true;
  const depts = list(row.departments);
  const ids = list(row.employeeIds);
  if (!depts.length && !ids.length) return legacy(row);
  if (ids.length) return ids.some((id) => ctx.employeeIds.has(id));
  return depts.some((d) => ctx.departments.has(d));
}

// Does a targeted row reach ONE employee (used to refuse an acknowledgement /
// response from someone it was not sent to)?
function reachesEmployee(row, employee) {
  const depts = list(row.departments);
  const ids = list(row.employeeIds);
  if (!depts.length && !ids.length) return true;
  if (ids.length) return !!employee && ids.includes(employee.id);
  return !!employee && depts.includes(employee.department);
}

// --- delivery ---------------------------------------------------------------
// Addresses at reserved test domains (RFC 2606 / 6761) are never handed to the
// provider — they cannot be delivered, and test fixtures use them.
function reservedTestAddress(addr) {
  return /@([^@]+\.)?(example\.(com|net|org)|example|test|invalid|localhost)$/i.test(String(addr || '').trim());
}

async function sendQueued(rows, { subject, text, senderEmail, senderName }) {
  // eslint-disable-next-line global-require
  const messaging = require('./messaging');
  for (const row of rows) {
    // One retry for a transient failure; the per-channel rate limit lives in
    // messaging.send().
    // eslint-disable-next-line no-await-in-loop
    let result = await messaging.send(row.channel || 'Email', { to: row.recipient, kind: 'bulk', subject, text, vars: [text], senderEmail, senderName });
    if (!result.ok && result.transient) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 3000); });
      // eslint-disable-next-line no-await-in-loop
      result = await messaging.send(row.channel || 'Email', { to: row.recipient, kind: 'bulk', subject, text, vars: [text], senderEmail, senderName });
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.update({
      where: { id: row.id },
      data: { status: result.ok ? 'Sent' : `Failed — ${String(result.error || 'provider refused').slice(0, 160)}` },
    }).catch(() => {});
  }
}

// Writes the in-app notification for every recipient with a login, plus one
// row per ticked channel, and returns an honest summary:
//   { inApp, Email: { queued, notSent, noAddress }, SMS: {...}, WhatsApp: {...} }
async function deliver({ employees, channels = [], title, message, by, exceptUserId }) {
  const summary = { recipients: employees.length, inApp: 0 };
  const inApp = employees.filter((e) => e.userId && e.userId !== exceptUserId);
  if (inApp.length) {
    await prisma.$transaction(inApp.map((e) => prisma.notification.create({
      data: { userId: e.userId, title, message: message || null, channel: 'In-App', recipient: e.name, status: 'Delivered' },
    })));
    summary.inApp = inApp.length;
  }

  let liveStatus = { Email: { configured: false }, SMS: { configured: false }, WhatsApp: { configured: false } };
  if (channels.length) {
    try {
      // eslint-disable-next-line global-require
      liveStatus = await require('./messaging').channelStatus();
    } catch { /* treated as not configured */ }
  }

  const queued = [];
  for (const channel of channels) {
    const s = { queued: 0, notSent: 0, noAddress: 0 };
    const rows = employees.map((e) => {
      const recipient = channel === 'Email' ? (e.email || '').trim() : (e.phone || '').trim();
      let status;
      if (!recipient) { status = `Not sent — no ${channel === 'Email' ? 'email address' : 'phone number'}`; s.noAddress += 1; }
      else if (!liveStatus[channel] || !liveStatus[channel].configured) { status = NO_PROVIDER; s.notSent += 1; }
      else if (channel === 'Email' && reservedTestAddress(recipient)) { status = 'Not sent — reserved test address'; s.notSent += 1; }
      else { status = 'Queued'; s.queued += 1; }
      return { channel, recipient: recipient || e.name, status, title, message: message || null };
    });
    if (rows.length) {
      // No userId: these are the delivery log, not a second bell entry. The
      // in-app row above is what the recipient sees.
      // eslint-disable-next-line no-await-in-loop
      const created = await prisma.$transaction(rows.map((data) => prisma.notification.create({ data })));
      created.filter((r) => r.status === 'Queued').forEach((r) => queued.push(r));
    }
    summary[channel] = s;
  }

  if (queued.length) {
    const sender = by ? { senderEmail: by.email || undefined, senderName: by.name || undefined } : {};
    setImmediate(() => { sendQueued(queued, { subject: title, text: message || title, ...sender }).catch(() => {}); });
  }
  return summary;
}

// "Email: 12 queued · SMS: recorded, not sent (no provider)" — for the screen.
function describeDelivery(summary) {
  if (!summary) return '';
  const parts = [`In-app: ${summary.inApp || 0}`];
  CHANNELS.forEach((c) => {
    const s = summary[c];
    if (!s) return;
    if (c === 'Email') {
      const bits = [];
      if (s.queued) bits.push(`${s.queued} queued`);
      if (s.notSent) bits.push(`${s.notSent} not sent`);
      if (s.noAddress) bits.push(`${s.noAddress} without an address`);
      parts.push(`Email: ${bits.join(', ') || 'none'}`);
    } else if (s.queued) {
      parts.push(`${c}: ${s.queued} queued${s.notSent ? `, ${s.notSent} not sent` : ''}${s.noAddress ? ` · ${s.noAddress} without a number` : ''}`);
    } else {
      parts.push(`${c}: recorded, not sent (no provider)${s.noAddress ? ` · ${s.noAddress} without a number` : ''}`);
    }
  });
  return parts.join(' · ');
}

// The picker's option lists, already held to the caller's scope.
async function audienceOptions(user) {
  const employees = await reachableEmployees(user);
  const departments = await allowedDepartments(user, employees);
  let email = { configured: false, host: null };
  try {
    // eslint-disable-next-line global-require
    const cfg = await require('./mailer').emailConfig();
    email = { configured: cfg.configured, host: cfg.configured ? cfg.host : null };
  } catch { /* not configured */ }
  let live = null;
  try {
    // eslint-disable-next-line global-require
    live = await require('./messaging').channelStatus();
  } catch { live = null; }
  const other = (c) => (live && live[c] && live[c].configured
    ? { connected: true, note: `Connected (${live[c].detail || c})` }
    : { connected: false, note: 'not connected — will be recorded, not sent' });
  return {
    departments,
    employees: employees.map((e) => ({
      id: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department,
      designation: e.designation, hasLogin: !!e.userId, userId: e.userId || null,
    })),
    channels: {
      Email: { connected: email.configured, note: email.configured ? `Connected (${email.host})` : 'not connected — will be recorded, not sent' },
      SMS: other('SMS'),
      WhatsApp: other('WhatsApp'),
    },
    scope: { global: scopeDepartments(user) === undefined },
  };
}

module.exports = {
  EXITED,
  CHANNELS,
  list,
  parseAudience,
  parseChannels,
  reachableEmployees,
  allowedDepartments,
  resolveAudience,
  storedColumns,
  viewerContext,
  reaches,
  reachesEmployee,
  deliver,
  describeDelivery,
  audienceOptions,
  reservedTestAddress,
};
