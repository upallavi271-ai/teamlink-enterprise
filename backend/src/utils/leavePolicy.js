// ---------------------------------------------------------------------------
// LEAVE POLICY PIECES used by routes/leave.js:
//   * the TL approval rule (configurable, enforced on the server)
//   * Reassign — handing a pending request to another valid approver
//   * the month-wise balance (per employee and leave type, per leave year)
//   * "Approved by / Decided by" for a list row
//
// NO SCHEMA CHANGE. The TL rule is stored as one ApprovalLevelConfig row —
// the table that already holds the leave chain's per-level policy — under its
// own workflow key, so the chain's own rows are untouched:
//   workflow 'leave-tl-rule', level 'TL'
//   mode     'days'  → a TL may approve a request of at most `limit` days
//            'count' → a TL may approve at most `limit` requests per employee
//                      per calendar month (by the leave's start month)
//   slaHours → the limit (default 2)
//   active   → rule on / off
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { parse } = require('./leaveText');

const TL_RULE_KEY = { workflow: 'leave-tl-rule', level: 'TL' };
const TL_RULE_DEFAULT = { enabled: true, mode: 'days', limit: 2 };
const PRECOUNTED = 'Leave imported — days already counted in PulseHRM availed';
const REASSIGNED = 'Leave reassigned';

async function getTlRule() {
  const row = await prisma.approvalLevelConfig.findUnique({ where: { workflow_level: TL_RULE_KEY } });
  if (!row) return { ...TL_RULE_DEFAULT };
  return {
    enabled: row.active !== false,
    mode: row.mode === 'count' ? 'count' : 'days',
    limit: row.slaHours != null ? Number(row.slaHours) : TL_RULE_DEFAULT.limit,
  };
}

async function setTlRule({ enabled, mode, limit }) {
  const cur = await getTlRule();
  const next = {
    enabled: enabled === undefined ? cur.enabled : !!enabled,
    mode: mode === undefined ? cur.mode : (mode === 'count' ? 'count' : 'days'),
    limit: limit === undefined || limit === null || limit === '' ? cur.limit : Number(limit),
  };
  if (!Number.isFinite(next.limit) || next.limit < 0 || next.limit > 365) {
    const e = new Error('The TL approval limit must be a number between 0 and 365.'); e.status = 400; throw e;
  }
  // Stored in an Int column: whole days / whole requests.
  if (!Number.isInteger(next.limit)) {
    const e = new Error('The TL approval limit must be a whole number.'); e.status = 400; throw e;
  }
  await prisma.approvalLevelConfig.upsert({
    where: { workflow_level: TL_RULE_KEY },
    update: { mode: next.mode, slaHours: next.limit, active: next.enabled },
    create: { ...TL_RULE_KEY, seq: 0, mode: next.mode, slaHours: next.limit, active: next.enabled },
  });
  return getTlRule();
}

// Is this login deciding this request AS A TL? The chain's current step is at
// level TL and it is theirs — or, for a request with no chain, their HRMS role
// is TL.
function actingAsTl(user, pendingStep) {
  if (pendingStep) return pendingStep.level === 'TL' && pendingStep.approverUserId === user.id;
  const hrms = user.hrmsRole && user.hrmsRole !== 'NONE' ? user.hrmsRole : user.role;
  return hrms === 'TL';
}

const monthOf = (iso) => String(iso || '').slice(0, 7);
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Whether the TL may approve THIS request under the rule, and the note the
// screen shows when not.
async function evaluateTlRule(rule, request) {
  if (!rule.enabled) return { allowed: true, rule, note: null };
  if (rule.mode === 'days') {
    const days = Number(request.days != null ? request.days : 1);
    const allowed = days <= rule.limit;
    return {
      allowed,
      rule,
      note: allowed ? `Within the TL limit (${rule.limit} day${rule.limit === 1 ? '' : 's'}). A reason is required to approve.`
        : `More than ${rule.limit} day${rule.limit === 1 ? '' : 's'} — reassign to HR/Manager.`,
    };
  }
  // count: TL-level approvals for this employee in the leave's start month.
  const ym = monthOf(request.fromDate);
  const sameMonth = await prisma.leaveRequest.findMany({
    where: { employeeId: request.employeeId, fromDate: { startsWith: ym }, id: { not: request.id } },
    select: { id: true },
  });
  const used = sameMonth.length ? await prisma.approvalStep.count({
    where: { workflow: 'leave', level: 'TL', status: 'Approved', recordId: { in: sameMonth.map((r) => r.id) } },
  }) : 0;
  const allowed = used < rule.limit;
  return {
    allowed,
    rule,
    used,
    note: allowed
      ? `${used} of ${rule.limit} TL approvals used for this employee in ${monthLabel(ym)}. A reason is required to approve.`
      : `${used} of ${rule.limit} TL approvals already used for this employee in ${monthLabel(ym)} — reassign to HR/Manager.`,
  };
}

// ---------------------------------------------------------------------------
// REASSIGN
// ---------------------------------------------------------------------------
// Who a pending request may be handed to: the approvers further up ITS OWN
// chain who actually gate it (the TL's STL, HR, Super Admin — Manager and
// Assistant Manager are view-only rungs and never gate), plus every active HR
// and Super Admin login. Never the applicant, never the current owner.
// Test / demo logins (ZZTEST, example.test) are never offered for a real
// applicant's request.
const isTempAccount = (...vals) => vals.some((v) => /zztest|example\.test/i.test(String(v || '')));
async function reassignTargets(steps, applicantUserId, { allowTemp = false } = {}) {
  const current = steps.find((s) => s.status === 'Pending');
  if (!current) return [];
  const out = new Map();
  steps.filter((s) => s.seq > current.seq && s.approverUserId && ['TL', 'STL', 'HR', 'SUPER_ADMIN'].includes(s.level))
    .forEach((s) => out.set(s.approverUserId, { userId: s.approverUserId, name: s.approverName, level: s.level, onChain: true, stepId: s.id }));
  const desk = await prisma.user.findMany({
    where: {
      status: 'Active',
      hrmsAccess: true,
      OR: [{ hrmsRole: { in: ['HR', 'SUPER_ADMIN'] } }, { AND: [{ hrmsRole: null }, { role: { in: ['HR', 'SUPER_ADMIN'] } }] }],
    },
    select: { id: true, name: true, role: true, hrmsRole: true },
    orderBy: { name: 'asc' },
  });
  desk.forEach((u) => {
    if (out.has(u.id)) return;
    const level = (u.hrmsRole || u.role) === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'HR';
    out.set(u.id, { userId: u.id, name: u.name, level, onChain: false });
  });
  [current.approverUserId, applicantUserId].filter(Boolean).forEach((id) => out.delete(id));
  if (!allowTemp) [...out.values()].filter((t) => isTempAccount(t.name)).forEach((t) => out.delete(t.userId));
  const label = { TL: 'TL', STL: 'STL', HR: 'HR', SUPER_ADMIN: 'Super Admin' };
  return [...out.values()].map((t) => ({ ...t, label: `${t.name} — ${label[t.level] || t.level}${t.onChain ? ' (on this request\'s chain)' : ''}` }));
}

// Hand the current step to `target`. If the target already holds a later
// step on this chain, the steps in between are bypassed and theirs becomes
// current; otherwise a new step for them takes the current one's place.
async function performReassign(recordId, steps, target, actor, reason) {
  const current = steps.find((s) => s.status === 'Pending');
  const now = new Date();
  const actorName = actor.name || actor.email;
  const note = `Reassigned to ${target.name} by ${actorName}: ${reason}`;
  const ops = [prisma.approvalStep.update({
    where: { id: current.id },
    data: { status: 'Skipped', actedAt: now, actedByUserId: actor.id, actedByName: actorName, note },
  })];
  const later = target.onChain ? steps.find((s) => s.id === target.stepId) : null;
  if (later) {
    steps.filter((s) => s.seq > current.seq && s.seq < later.seq && ['Waiting', 'Visibility'].includes(s.status) && s.mode === 'required')
      .forEach((s) => ops.push(prisma.approvalStep.update({ where: { id: s.id }, data: { status: 'Skipped', note: `Bypassed — reassigned to ${target.name} by ${actorName}` } })));
    ops.push(prisma.approvalStep.update({
      where: { id: later.id },
      data: { status: 'Pending', mode: 'required', activatedAt: now, dueAt: later.slaHours ? new Date(now.getTime() + later.slaHours * 3600000) : null, note: `Reassigned from ${current.approverName || current.level} by ${actorName}: ${reason}` },
    }));
  } else {
    const u = await prisma.user.findUnique({ where: { id: target.userId }, select: { id: true, name: true, atsDepartment: true } });
    ops.push(prisma.approvalStep.create({
      data: {
        workflow: 'leave', recordId, level: target.level, seq: current.seq, mode: 'required', slaHours: current.slaHours,
        approverUserId: u.id, approverName: u.name, approverDepartment: u.atsDepartment || null,
        status: 'Pending', activatedAt: now, dueAt: current.slaHours ? new Date(now.getTime() + current.slaHours * 3600000) : null,
        note: `Reassigned from ${current.approverName || current.level} by ${actorName}: ${reason}`,
      },
    }));
  }
  await prisma.$transaction(ops);
  return { from: current.approverName || current.level, fromLevel: current.level, to: target.name, toLevel: target.level };
}

// ---------------------------------------------------------------------------
// MONTH-WISE BALANCE
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function daysInMonthPortion(fromDate, toDate) {
  // Calendar days of [from, to] falling in each YYYY-MM.
  const out = {};
  const a = new Date(`${fromDate}T00:00:00Z`); const b = new Date(`${(toDate || fromDate)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) { out[monthOf(fromDate)] = 1; return out; }
  for (let d = new Date(a); d <= b; d = new Date(d.getTime() + 86400000)) {
    const k = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
// A request's days spread over the months it touches, in proportion to the
// calendar days in each (a half day lands whole in its month).
function allocate(request) {
  const days = Number(request.days != null ? request.days : 1);
  const portions = daysInMonthPortion(request.fromDate, request.toDate);
  const keys = Object.keys(portions).sort();
  if (keys.length === 1) return { [keys[0]]: days };
  const span = keys.reduce((s, k) => s + portions[k], 0);
  const out = {}; let given = 0;
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? Math.round((days - given) * 100) / 100 : Math.round((days * portions[k] / span) * 100) / 100;
    out[k] = v; given += v;
  });
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

// One employee, one leave year (calendar year), every active leave type.
//   credited: a monthly type (unit 'month') credits its cap each month; a
//   yearly type credits the entitlement on record (LeaveBalance.total) in the
//   first month of the CURRENT leave year — the balances on file are this
//   year's. For another year the entitlement is not on record, so nothing is
//   credited and the table says so.
function monthlyFor({ year, types, balances, requests, currentYear, currentMonth }) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);
  return types.map((t) => {
    const bal = balances.find((b) => b.type === t.name) || null;
    const mine = requests.filter((r) => r.type === t.name);
    const taken = {}; const pending = {};
    mine.forEach((r) => {
      const bucket = r.status === 'Approved' ? taken : (r.status === 'Pending' ? pending : null);
      if (!bucket) return;
      Object.entries(allocate(r)).forEach(([k, v]) => { bucket[k] = (bucket[k] || 0) + v; });
    });
    let creditKnown = true;
    const credited = {};
    if (t.unit === 'unpaid') {
      // nothing is credited for an unpaid type
    } else if (t.unit === 'month') {
      months.forEach((k, i) => { if (year < currentYear || (year === currentYear && i + 1 <= currentMonth)) credited[k] = Number(t.cap || 0); });
    } else if (year === currentYear) {
      credited[months[0]] = bal ? Number(bal.total || 0) : Number(t.cap || 0);
    } else {
      creditKnown = false;
    }
    let running = 0;
    const rows = months.map((k) => {
      const opening = round2(running);
      const c = credited[k] || 0; const tk = round2(taken[k] || 0); const pe = round2(pending[k] || 0);
      running = opening + c - tk;
      return { month: k, label: monthLabel(k), opening, credited: c, taken: tk, pending: pe, closing: round2(running) };
    });
    const takenYear = round2(rows.reduce((s, r) => s + r.taken, 0));
    const pendingYear = round2(rows.reduce((s, r) => s + r.pending, 0));
    return {
      type: t.name, code: t.code, unit: t.unit, cap: t.cap,
      creditKnown,
      months: rows,
      totals: { credited: round2(rows.reduce((s, r) => s + r.credited, 0)), taken: takenYear, pending: pendingYear, closing: rows[11].closing },
      onRecord: bal && year === currentYear ? { total: bal.total, taken: bal.taken, remaining: Math.max(0, bal.total - bal.taken) } : null,
      reconcileNote: bal && year === currentYear && Math.abs(bal.taken - takenYear) > 1e-9
        ? `Balance on record counts ${bal.taken} day(s) taken; approved requests in ${year} add up to ${takenYear}. The difference is days the PulseHRM export counted (e.g. pending leave) or leave taken outside this history.`
        : null,
    };
  });
}

// "Approved by / Decided by" for a list row.
function decisionInfo(request, wfSummary) {
  const text = parse(request.reason);
  if (request.status === 'Pending') {
    const owner = wfSummary && (wfSummary.currentOwnerName || null);
    return {
      state: 'Pending',
      by: owner || text.details.Approver || null,
      level: wfSummary ? wfSummary.currentLabel || null : null,
      at: null,
      comment: null,
    };
  }
  return {
    state: request.status,
    by: request.decidedBy || null,
    level: null,
    at: request.decidedAt ? new Date(request.decidedAt).toISOString() : null,
    comment: request.approvalReason || request.rejectReason || text.details['Approver comments'] || null,
  };
}

module.exports = {
  getTlRule, setTlRule, actingAsTl, evaluateTlRule, TL_RULE_DEFAULT,
  reassignTargets, performReassign, REASSIGNED, PRECOUNTED,
  monthlyFor, allocate, decisionInfo, monthLabel, isTempAccount,
};
