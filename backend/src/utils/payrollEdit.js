// ---------------------------------------------------------------------------
// PAYROLL EDIT AND RECALCULATE (user spec 2026-10-13, item 5)
//
//   "Allow authorized users to edit generated payroll. Automatically recalculate
//    gross salary, deductions, net pay and CTC after changes. Maintain an audit log
//    of changes and restrict modifications according to payroll approval permissions."
//
// What this file owns (routes in routes/payrollRuns.js call it):
//   * the edit of ONE employee-month record (Draft / Pending only), through the one
//     shared calculation (utils/payrollCalc.js) - the server recomputes everything
//     and rejects totals that do not match;
//   * the edit STATE of a record (AppSetting 'payroll.edit:<recordId>'): which lines
//     are typed by hand, the added earning / deduction rows, the loan, the editors
//     (for maker-checker), the VERSIONS (before / after of every save), the archived
//     payslips a later change superseded;
//   * the audit rows: one per changed field (entity PayrollEditField) + a summary
//     row (entity EmployeePayrollRun) with before / after Gross, Deductions, Net, CTC;
//   * "Recalculate from attendance" (the engine's own numbers, compared first);
//   * the run's "Changes in this run" list for the approver;
//   * ADJUSTMENTS: a Paid / Posted / Approved / imported month is never rewritten, a
//     correction (arrears / recovery) is applied in the NEXT open month instead
//     (AppSetting 'payroll.adj:<month>'), with its own audit line.
//
// No schema change: everything extra lives in AppSetting (key/value) and AuditLog.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const E = require('./payrollEngine');
const PC = require('./payrollCycle');
const { payrollCalc, payrollCalcProblems, PAYROLL_CALC_AUTO } = require('./payrollCalc');
const { PT_SLAB, rulesFrom } = require('./salaryRules');
const { logAudit } = require('./audit');
const { monthLabel } = require('./attendanceMath');

const EDITABLE = ['DRAFT', 'PENDING_APPROVAL'];
const QUICK_REASONS = ['Attendance correction', 'Salary revision / arrears', 'Data entry mistake'];
const MAX_VERSIONS = 60;

const FIELD_LABELS = {
  stipend: 'Stipend', basic: 'Basic', hra: 'HRA', conveyance: 'Conveyance', specialAllowance: 'Special allowance', bonus: 'Bonus',
  incentive: 'Incentive', arrears: 'Other earnings', pfEmployee: 'PF (employee)', esiEmployee: 'ESI (employee)',
  professionalTax: 'Professional tax', tds: 'TDS', lopDeduction: 'LOP amount', loan: 'Loan / Advance', otherDeductions: 'Other deductions',
  workingDays: 'Working days', daysLop: 'LOP days', daysPresent: 'Days present', awlDays: 'Absent-without-leave days',
  pfEmployer: 'PF (employer)', esiEmployer: 'ESI (employer)', gratuity: 'Gratuity',
};
const COLUMN_FIELDS = ['workingDays', 'daysLop', 'daysPresent', 'basic', 'hra', 'conveyance', 'specialAllowance', 'bonus', 'incentive', 'arrears',
  'lopDeduction', 'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'otherDeductions', 'pfEmployer', 'esiEmployer', 'gratuity'];
const TOTAL_FIELDS = ['grossPay', 'earnedGross', 'totalDeductions', 'netPay'];
const TYPED_SCALARS = ['basic', 'hra', 'conveyance', 'specialAllowance', 'bonus', 'incentive', 'arrears', 'stipend', 'otherDeductions', 'loan',
  'workingDays', 'daysLop', 'daysPresent'];

class EditError extends E.PayrollError {}

const stateKey = (id) => `payroll.edit:${id}`;
const adjKey = (month) => `payroll.adj:${month}`;
const r0 = (n) => Math.round(Number(n) || 0);
const sumAmt = (list) => (list || []).reduce((n, x) => n + (Number(x.amount) || 0), 0);

function freshState() {
  return { v: 0, edited: false, manual: {}, loan: 0, extras: { earnings: [], deductions: [] }, awlDays: null, allowNegative: null, notes: '', editors: [], versions: [], payslipArchive: [] };
}
async function readState(id) {
  const row = await prisma.appSetting.findUnique({ where: { key: stateKey(id) } }).catch(() => null);
  if (!row) return freshState();
  try { return { ...freshState(), ...JSON.parse(row.value) }; } catch { return freshState(); }
}
async function readStates(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: ids.map(stateKey) } } }).catch(() => []);
  rows.forEach((r) => {
    try { out.set(r.key.slice('payroll.edit:'.length), { ...freshState(), ...JSON.parse(r.value) }); } catch { /* skip a broken row */ }
  });
  return out;
}
async function writeState(id, st, actor) {
  const value = JSON.stringify(st);
  const meta = actor ? { updatedById: actor.id || null, updatedByName: actor.name || null } : {};
  await prisma.appSetting.upsert({ where: { key: stateKey(id) }, update: { value, ...meta }, create: { key: stateKey(id), value, ...meta } });
}

// ---- Locks ---------------------------------------------------------------------
const isImported = (e) => !!(e.importNote || e.importedBreakup);
// null = editable; otherwise { code, message } in plain words.
function lockOf(entry) {
  const m = monthLabel(entry.month);
  if (isImported(entry)) return { code: 'IMPORTED', message: `${m} is an imported pay register month. It is read-only. Put a correction in the next open month as an adjustment.` };
  if (entry.status === 'PAID') return { code: 'PAID', message: `${m} is Paid. It cannot be changed. Add an adjustment for the next open month instead.` };
  if (entry.status === 'SYNCED_TO_ACCOUNTS') return { code: 'POSTED', message: `${m} is posted to Accounts. It cannot be changed. Add an adjustment for the next open month instead.` };
  if (entry.status === 'APPROVED') return { code: 'APPROVED', message: `${m} is Approved. Ask the Super Admin to reopen it.` };
  return null;
}

// ---- Rules (what the editor's recalculation uses) ---------------------------------
function rulesFromVersion(version, policy, payMode) {
  const v = version || {};
  const stipend = (payMode || v.payMode) === 'Stipend';
  const r = rulesFrom(policy || {});
  const baseGrossRef = stipend ? Math.round(Number(v.stipend) || 0)
    : (Number(v.basic) || 0) + (Number(v.hra) || 0) + (Number(v.bonus) || 0) + (Number(v.specialAllowance) || 0) + (Number(v.conveyance) || 0);
  return {
    payMode: stipend ? 'Stipend' : 'Package',
    pf: {
      employeeFull: Number(v.employeePf) || 0, employerFull: Number(v.employerPf) || 0, gratuityFull: Number(v.gratuity) || 0, basicRef: Number(v.basic) || 0,
      empPct: r.employeePfPctOfBasic, empCap: r.employeePfMonthlyCap, erPct: r.employerPfPctOfBasic, erCap: r.employerPfMonthlyCap, gratuityPct: r.gratuityPctOfBasic,
    },
    esi: {
      enabled: !policy || policy.esiEnabled !== false,
      ceiling: policy && policy.esiGrossCeiling != null ? Number(policy.esiGrossCeiling) : 21000,
      empPct: policy && policy.esiEmployeePct != null ? Number(policy.esiEmployeePct) : 0.75,
      erPct: policy && policy.esiEmployerPct != null ? Number(policy.esiEmployerPct) : 3.25,
      applicable: v.esiApplicable === true || v.esiApplicable === false ? v.esiApplicable : null,
    },
    pt: { slab: PT_SLAB, versionMax: Number(v.professionalTax) || 0, baseGrossRef },
    tds: { fixed: v.tds === null || v.tds === undefined ? null : Math.round(Number(v.tds) || 0), pct: Number((policy && policy.tdsDefaultPctOfGross) || 0) },
  };
}
async function rulesFor(entry) {
  const [version, policy] = await Promise.all([
    entry.salaryVersionId ? prisma.salaryStructureVersion.findUnique({ where: { id: entry.salaryVersionId } }) : null,
    E.getPolicy(),
  ]);
  return { rules: rulesFromVersion(version, policy, entry.payMode), version };
}

// ---- Components of a stored record -> the calc's input ---------------------------------
function componentsOf(entry, state) {
  const st = state || freshState();
  const earn = (st.extras && st.extras.earnings) || [];
  const ded = (st.extras && st.extras.deductions) || [];
  const loan = Math.max(0, r0(st.loan));
  const stipend = entry.payMode === 'Stipend' ? Math.max(0, r0(entry.grossPay) - r0(entry.incentive) - r0(entry.arrears)) : 0;
  return {
    workingDays: Number(entry.workingDays) || 0, daysLop: Number(entry.daysLop) || 0, daysPresent: Number(entry.daysPresent) || 0,
    basic: r0(entry.basic), hra: r0(entry.hra), conveyance: r0(entry.conveyance), specialAllowance: r0(entry.specialAllowance), bonus: r0(entry.bonus),
    incentive: r0(entry.incentive), stipend,
    arrears: Math.max(0, r0(entry.arrears) - sumAmt(earn)),
    extraEarn: earn.map((x) => x.amount),
    otherDeductions: Math.max(0, r0(entry.otherDeductions) - loan - sumAmt(ded)),
    loan, extraDed: ded.map((x) => x.amount),
    lopDeduction: r0(entry.lopDeduction), pfEmployee: r0(entry.pfEmployee), esiEmployee: r0(entry.esiEmployee), professionalTax: r0(entry.professionalTax),
    tds: r0(entry.tds), pfEmployer: r0(entry.pfEmployer), esiEmployer: r0(entry.esiEmployer), gratuity: r0(entry.gratuity),
    manual: { ...(st.manual || {}) },
  };
}

// Lines whose stored figure is not what the rule gives (a typed / imported figure): kept as they are.
function driftOf(c, rules) {
  const auto = payrollCalc({ ...c, manual: {} }, rules);
  const drift = {};
  PAYROLL_CALC_AUTO.forEach((k) => { if (!(c.manual || {})[k] && auto[k] !== c[k]) drift[k] = true; });
  return drift;
}

const totalsOfRow = (x) => ({
  grossPay: r0(x.grossPay), earnedGross: r0(x.earnedGross), totalDeductions: r0(x.totalDeductions), netPay: r0(x.netPay),
  ctc: r0(x.earnedGross) + r0(x.pfEmployer) + r0(x.esiEmployer) + r0(x.gratuity),
});
const fieldsOfRow = (x, state) => {
  const f = {};
  COLUMN_FIELDS.forEach((k) => { f[k] = Number(x[k]) || 0; });
  f.loan = Math.max(0, r0(state && state.loan));
  return f;
};

// The columns an edit writes (all derived from the calc result).
function columnsOf(res, c) {
  return {
    workingDays: res.workingDays, daysLop: res.daysLop, daysPresent: Math.max(0, Math.min(res.workingDays, Number(c.daysPresent) || 0)),
    basic: res.basic, hra: res.hra, conveyance: res.conveyance, specialAllowance: res.specialAllowance, bonus: res.bonus, incentive: res.incentive,
    arrears: res.arrears, grossPay: res.grossPay, lopDeduction: res.lopDeduction, earnedGross: res.earnedGross,
    pfEmployee: res.pfEmployee, esiEmployee: res.esiEmployee, professionalTax: res.professionalTax, tds: res.tds,
    otherDeductions: res.otherDeductions, totalDeductions: res.totalDeductions, netPay: res.netPay,
    pfEmployer: res.pfEmployer, esiEmployer: res.esiEmployer, gratuity: res.gratuity,
  };
}

// ---- The editor's payload ---------------------------------------------------------------
async function editorPayload(entry, access) {
  const state = await readState(entry.id);
  const { rules } = await rulesFor(entry);
  const base = componentsOf(entry, state);
  const drift = driftOf(base, rules);
  const manual = { ...state.manual, ...drift };
  const c = { ...base, manual };
  const snap = await E.readSnapshot(entry.month);
  const awl = snap && snap.people && snap.people[entry.employeeId] ? snap.people[entry.employeeId].awl : null;
  const lock = lockOf(entry);
  const cyc = await PC.cycleFor(entry.month).catch(() => null);
  return {
    entry: {
      id: entry.id, month: entry.month, status: entry.status, statusLabel: E.STATUS_LABEL[entry.status], payMode: entry.payMode,
      employee: entry.employee ? { id: entry.employee.id, name: entry.employee.name, employeeCode: entry.employee.employeeCode, department: entry.employee.department } : null,
      attendanceSource: entry.attendanceSource,
    },
    lock, canEdit: !!(access && access.edit) && !lock,
    components: {
      ...c,
      extraEarn: undefined, extraDed: undefined,
      earnings: (state.extras.earnings || []).map((x) => ({ ...x })),
      deductions: (state.extras.deductions || []).map((x) => ({ ...x })),
      awlDays: awl ? Number(awl.days) || 0 : null,
    },
    drift: Object.keys(drift),
    rules,
    awl: awl ? { days: awl.days || 0, halfDays: awl.halfDays || 0, perDay: awl.perDay, perHalf: awl.perHalf, lop: awl.lop || 0, dates: awl.dates || [] } : null,
    stored: totalsOfRow(entry),
    edited: !!state.edited, allowNegative: state.allowNegative || null, notes: state.notes || '',
    editors: state.editors, version: state.v, quickReasons: QUICK_REASONS, fieldLabels: FIELD_LABELS,
    cycle: cyc ? { label: cyc.label, rangeText: cyc.rangeText, days: cyc.days } : null,
  };
}

// ---- Parse + validate a save --------------------------------------------------------------
function cleanLines(raw, kind) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((x) => {
    if (!x || x.adj) return; // adjustment lines are never taken from the client
    const label = String(x.label == null ? '' : x.label).trim().slice(0, 60);
    const amount = Number(x.amount);
    if (!label) throw new EditError(400, `Give every added ${kind} a name.`);
    if (!Number.isFinite(amount) || amount < 0) throw new EditError(400, `The amount of "${label}" must be a number from 0 up.`);
    out.push({ id: String(x.id || `l${Date.now().toString(36)}${out.length}`), label, amount: r0(amount) });
  });
  if (out.length > 20) throw new EditError(400, 'At most 20 added lines.');
  return out;
}

async function nameOfEmp(entry) {
  if (entry.employee && entry.employee.name) return entry.employee.name;
  const e = await prisma.employee.findUnique({ where: { id: entry.employeeId }, select: { name: true } });
  return e ? e.name : entry.employeeId;
}

function diffFields(before, after) {
  const changes = [];
  Object.keys(FIELD_LABELS).forEach((k) => {
    if (before[k] === undefined && after[k] === undefined) return;
    const a = Number(before[k]) || 0; const b = Number(after[k]) || 0;
    if (a !== b) changes.push({ field: k, label: FIELD_LABELS[k], old: a, new: b });
  });
  return changes;
}
function diffLines(kind, before, after) {
  const out = [];
  const bm = new Map((before || []).map((x) => [x.id, x]));
  const am = new Map((after || []).map((x) => [x.id, x]));
  am.forEach((x, id) => {
    const o = bm.get(id);
    if (!o) out.push({ field: `${kind}:${x.label}`, label: `${kind === 'earn' ? 'Added earning' : 'Added deduction'}: ${x.label}`, old: 0, new: x.amount });
    else if (o.amount !== x.amount || o.label !== x.label) out.push({ field: `${kind}:${x.label}`, label: `${kind === 'earn' ? 'Earning' : 'Deduction'}: ${o.label === x.label ? x.label : `${o.label} -> ${x.label}`}`, old: o.amount, new: x.amount });
  });
  bm.forEach((x, id) => { if (!am.has(id)) out.push({ field: `${kind}:${x.label}`, label: `${kind === 'earn' ? 'Removed earning' : 'Removed deduction'}: ${x.label}`, old: x.amount, new: 0 }); });
  return out;
}

async function archivePayslip(entry, state, byName, reason) {
  if (!entry.payslipId) return;
  const slip = await prisma.payslip.findUnique({ where: { id: entry.payslipId } }).catch(() => null);
  if (!slip) return;
  const stamp = new Date(slip.generatedAt).toISOString();
  if ((state.payslipArchive || []).some((p) => p.generatedAt === stamp)) return;
  state.payslipArchive.push({
    at: new Date().toISOString(), byName, reason: reason || null, slipId: slip.id, generatedAt: stamp, superseded: true,
    gross: slip.gross, deductions: slip.deductions, netPay: slip.netPay, basic: slip.basic, hra: slip.hra, allowances: slip.allowances,
    incentive: slip.incentive, esiEmployee: slip.esiEmployee, tds: slip.tds, otherDeductions: slip.otherDeductions, lopDays: slip.lopDays, lopDeduction: slip.lopDeduction,
    professionalTax: slip.professionalTax, employeePf: slip.employeePf,
  });
}

async function writeAudit({ entry, actor, ip, reason, changes, before, after, kind }) {
  const empName = await nameOfEmp(entry);
  const label = (l) => `${l} · ${empName} · ${monthLabel(entry.month)} · source Payroll edit · IP ${ip || '-'}`;
  const rows = changes.map((ch) => ({
    userId: actor.id || null, actorName: actor.name, action: kind === 'recalculated' ? 'Payroll recalculated from attendance' : (kind === 'adjustment' ? 'Payroll adjustment applied' : 'Payroll edit'),
    entity: 'PayrollEditField', entityId: entry.id, field: ch.field, fieldLabel: label(ch.label),
    fromValue: String(ch.old), toValue: String(ch.new), reason: reason || null,
  }));
  if (rows.length) await prisma.auditLog.createMany({ data: rows }).catch(() => {});
  const f = (t) => `Gross ${t.grossPay} | Deductions ${t.totalDeductions} | Net ${t.netPay} | CTC ${t.ctc}`;
  await logAudit({
    userId: actor.id || null, actorName: actor.name,
    action: kind === 'recalculated' ? 'Payroll recalculated from attendance (summary)' : kind === 'adjustment' ? 'Payroll adjustment applied (summary)' : 'Payroll edited (summary)',
    entity: 'EmployeePayrollRun', entityId: entry.id, field: 'payrollEdit', fieldLabel: label('Summary'),
    fromValue: f(before), toValue: f(after), reason: reason || null,
  });
}

// Common tail of a save: version, state, audit, month run, snapshot.
async function commit({ entry, state, res, c, lines, loan, manual, kind, actor, ip, reason, awlDays, allowNegative, notes, resetManual }) {
  const before = totalsOfRow(entry);
  const beforeFields = { ...fieldsOfRow(entry, state), awlDays: state.awlDays };
  const cols = columnsOf(res, c);
  const fresh = await prisma.employeePayrollRun.findUnique({ where: { id: entry.id } });
  if (!fresh || !EDITABLE.includes(fresh.status) || fresh.status !== entry.status) throw new EditError(409, 'This record changed while you were editing - close the editor and open it again.');
  // two saves at once (a double click, two people): the second one sees a newer version and is refused
  const latestState = await readState(entry.id);
  if ((latestState.v || 0) !== (state.v || 0)) throw new EditError(409, 'This record was just changed by someone else - close the editor and open it again.');
  const data = { ...cols, calculatedBy: actor.name, calculatedAt: new Date() };
  if (fresh.status === 'PENDING_APPROVAL') Object.assign(data, { status: 'DRAFT', submittedBy: null, submittedAt: null, rejectionReason: `Edited by ${actor.name}${reason ? `: ${reason}` : ''}`.slice(0, 500) });
  // optimistic lock: only if nobody saved this record since the editor read it (updatedAt)
  const u = await prisma.employeePayrollRun.updateMany({ where: { id: entry.id, status: fresh.status, updatedAt: entry.updatedAt }, data });
  if (!u.count) throw new EditError(409, 'This record changed while you were editing - close the editor and open it again.');
  const updated = await prisma.employeePayrollRun.findUnique({ where: { id: entry.id }, include: { employee: true } });

  const nextState = { ...state };
  nextState.manual = resetManual ? {} : manual;
  nextState.loan = loan;
  nextState.extras = lines;
  nextState.allowNegative = allowNegative || null;
  if (notes !== undefined) nextState.notes = notes;
  nextState.edited = kind === 'recalculated' ? false : true;
  if (awlDays !== undefined && awlDays !== null) nextState.awlDays = awlDays;
  if (!nextState.editors.includes(actor.id)) nextState.editors = [...nextState.editors, actor.id];
  const afterFields = { ...fieldsOfRow(updated, nextState), awlDays: nextState.awlDays };
  const changes = [
    ...diffFields({ ...beforeFields }, { ...afterFields }),
    ...diffLines('earn', state.extras.earnings, lines.earnings),
    ...diffLines('ded', state.extras.deductions, lines.deductions),
  ];
  const after = totalsOfRow(updated);
  const versions = [...(state.versions || [])];
  if (!versions.length) {
    versions.push({ n: 0, kind: 'calculated', at: new Date(entry.calculatedAt || entry.createdAt || Date.now()).toISOString(), byName: entry.calculatedBy || 'Payroll calculation', reason: 'As calculated', after: { fields: beforeFields, totals: before, lines: state.extras } });
  }
  nextState.v = (state.v || 0) + 1;
  nextState.versions = [...versions, {
    n: nextState.v, kind, at: new Date().toISOString(), byId: actor.id || null, byName: actor.name, ip: ip || null, reason: reason || null,
    changes, before: { totals: before }, after: { fields: afterFields, totals: after, lines },
  }];
  if (nextState.versions.length > MAX_VERSIONS) nextState.versions = [nextState.versions[0], ...nextState.versions.slice(-(MAX_VERSIONS - 1))];
  await archivePayslip(entry, nextState, actor.name, reason);
  await writeState(entry.id, nextState, actor);
  await writeAudit({ entry: updated, actor, ip, reason, changes, before, after, kind });
  await updateSnapshotAwl(updated, awlDays, res);
  await E.refreshMonthRun(entry.month);
  return { entry: updated, result: res, changes, before, after, version: nextState.v };
}

async function updateSnapshotAwl(entry, awlDays, res) {
  if (awlDays === undefined || awlDays === null) return;
  const key = `payroll.snapshot:${entry.month}`;
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return;
  let cur; try { cur = JSON.parse(row.value); } catch { return; }
  const p = cur.people && cur.people[entry.employeeId];
  if (!p || !p.awl) return;
  const perDay = Number(p.awl.perDay) || 0; const perHalf = Number(p.awl.perHalf) || 0;
  const days = Math.max(0, Number(awlDays) || 0);
  const halfDays = Number(p.awl.halfDays) || 0;
  const lop = Math.round((days * perDay + halfDays * perHalf) * 100) / 100;
  p.awl = days || halfDays ? { ...p.awl, days, lop } : null;
  p.edited = true;
  await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify(cur) } }).catch(() => {});
}

// ---- SAVE -------------------------------------------------------------------------------------------
async function saveEdit({ entry, body, actor, ip }) {
  const lock = lockOf(entry);
  if (lock) throw new EditError(409, lock.message, { code: lock.code });
  const reason = String((body && body.reason) || '').trim();
  if (reason.length < 3) throw new EditError(400, 'Say why you are changing this payroll (at least 3 letters).');
  const state = await readState(entry.id);
  const { rules } = await rulesFor(entry);
  const cur = componentsOf(entry, state);
  const drift = driftOf(cur, rules);
  const fields = (body && body.fields) || {};
  const c = { ...cur };
  TYPED_SCALARS.forEach((k) => { if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') c[k] = Number(fields[k]); });
  // manual flags: the client sends the full map; a flag only means something for the auto lines
  const wantManual = body && body.manual && typeof body.manual === 'object' ? body.manual : { ...state.manual, ...drift };
  const manual = {};
  PAYROLL_CALC_AUTO.forEach((k) => { if (wantManual[k]) manual[k] = true; });
  c.manual = manual;
  PAYROLL_CALC_AUTO.forEach((k) => {
    if (manual[k] && fields[k] !== undefined && fields[k] !== null && fields[k] !== '') c[k] = Number(fields[k]);
    else if (manual[k]) c[k] = cur[k];
  });
  // added rows; adjustment lines are kept as they are
  const keepEarn = (state.extras.earnings || []).filter((x) => x.adj);
  const keepDed = (state.extras.deductions || []).filter((x) => x.adj);
  const lines = {
    earnings: [...keepEarn, ...cleanLines(body.earnings, 'earning')],
    deductions: [...keepDed, ...cleanLines(body.deductions, 'deduction')],
  };
  c.extraEarn = lines.earnings.map((x) => x.amount);
  c.extraDed = lines.deductions.map((x) => x.amount);
  if (fields.loan !== undefined && fields.loan !== null && fields.loan !== '') c.loan = Number(fields.loan);
  const loan = Math.max(0, r0(c.loan));
  const allowNegative = String((body && body.allowNegativeReason) || '').trim() || null;
  if (body && body.allowNegative && !allowNegative) throw new EditError(400, 'Say why net pay is allowed to go below 0.');
  const res = payrollCalc(c, rules);
  const problems = payrollCalcProblems(c, res, { allowNegativeReason: allowNegative });
  if (problems.length) throw new EditError(422, problems[0].message, { problems });

  // AWL days: only when the record has them; the LOP days field already carries their effect
  let awlDays;
  if (fields.awlDays !== undefined && fields.awlDays !== null && fields.awlDays !== '') {
    const snap = await E.readSnapshot(entry.month);
    const a = snap && snap.people && snap.people[entry.employeeId] ? snap.people[entry.employeeId].awl : null;
    if (!a) throw new EditError(400, 'This employee has no absent-without-leave days this month.');
    awlDays = Number(fields.awlDays);
    if (!Number.isFinite(awlDays) || awlDays < 0 || awlDays > res.daysLop || (awlDays * 2) % 1) throw new EditError(422, 'Absent-without-leave days must be a number from 0 up to the LOP days.');
  }

  // NEVER trust the client's totals: they must equal what the server just worked out.
  const sent = body && body.totals;
  const mine = totalsOfRow(res);
  if (!sent || ['grossPay', 'totalDeductions', 'netPay', 'ctc'].some((k) => !Number.isFinite(Number(sent[k])))) {
    throw new EditError(400, 'The totals are missing. Reload the page and try again.');
  }
  if (['grossPay', 'totalDeductions', 'netPay', 'ctc'].some((k) => Math.round(Number(sent[k])) !== mine[k])) {
    throw new EditError(422, 'The totals on your screen do not match the payroll calculation. Nothing was saved. Reload the page and try again.', { code: 'TOTALS_MISMATCH', server: mine });
  }
  // nothing to save?
  const same = COLUMN_FIELDS.every((k) => (Number(entry[k]) || 0) === (Number(columnsOf(res, c)[k]) || 0))
    && loan === (state.loan || 0)
    && JSON.stringify(lines) === JSON.stringify(state.extras)
    && JSON.stringify(manual) === JSON.stringify(state.manual)
    && (awlDays === undefined);
  if (same) throw new EditError(400, 'Nothing was changed.');
  return commit({ entry, state, res, c, lines, loan, manual, kind: 'edit', actor, ip, reason, awlDays, allowNegative, notes: body && body.notes !== undefined ? String(body.notes).slice(0, 500) : undefined });
}

// ---- Recalculate from attendance ---------------------------------------------------------------------
async function engineCompare(entry) {
  const lock = lockOf(entry);
  if (lock) throw new EditError(409, lock.message, { code: lock.code });
  const row = await E.engineRowFor(entry.employeeId, entry.month);
  if (!row) throw new EditError(409, `There is no salary structure effective in ${monthLabel(entry.month)}.`);
  const state = await readState(entry.id);
  const cur = { ...fieldsOfRow(entry, state) };
  const next = { ...fieldsOfRow(row, { loan: 0 }) };
  const changes = diffFields(cur, next);
  const ct = totalsOfRow(entry); const nt = totalsOfRow(row);
  return { row, changes, before: ct, after: nt, same: !changes.length && !state.edited };
}
async function applyEngine({ entry, actor, ip, reason }) {
  const why = String(reason || '').trim() || 'Recalculated from attendance';
  const cmp = await engineCompare(entry);
  const state = await readState(entry.id);
  const { rules } = await rulesFor(entry);
  const row = cmp.row;
  const lines = row.lines || { earnings: [], deductions: [] };
  const c = {
    ...componentsOf({ ...row, payMode: entry.payMode, arrears: row.arrears, otherDeductions: row.otherDeductions }, { ...freshState(), extras: lines }),
    manual: {},
  };
  const res = payrollCalc(c, rules);
  // The engine row wins for the figures the engine itself decides (caps on TDS / other deductions).
  const merged = { ...res, tds: row.tds, otherDeductions: row.otherDeductions, totalDeductions: row.totalDeductions, netPay: row.netPay, grossPay: row.grossPay, earnedGross: row.earnedGross };
  const out = await commit({ entry, state, res: merged, c: { ...c, daysPresent: row.daysPresent }, lines, loan: 0, manual: {}, kind: 'recalculated', actor, ip, reason: why, resetManual: true });
  return out;
}

// ---- History -----------------------------------------------------------------------------------------
async function historyOf(entry) {
  const [state, audit] = await Promise.all([
    readState(entry.id),
    prisma.auditLog.findMany({ where: { entityId: entry.id, entity: { in: ['PayrollEditField', 'EmployeePayrollRun'] } }, orderBy: { createdAt: 'asc' }, select: { action: true, entity: true, field: true, fieldLabel: true, fromValue: true, toValue: true, actorName: true, reason: true, createdAt: true } }),
  ]);
  return {
    version: state.v, edited: state.edited, editors: state.editors,
    versions: state.versions.map((v) => ({ n: v.n, kind: v.kind, at: v.at, byName: v.byName, ip: v.ip || null, reason: v.reason || null, changes: v.changes || [], before: v.before || null, after: v.after || null })),
    audit,
    superseded: state.payslipArchive || [],
  };
}

// ---- Changes in this run (for the approver) -------------------------------------------------------------
async function changesInRun(month, employeeWhere) {
  const entries = await prisma.employeePayrollRun.findMany({ where: { month, employee: employeeWhere }, include: { employee: { select: { id: true, name: true, employeeCode: true, department: true } } } });
  const states = await readStates(entries.map((e) => e.id));
  const rows = [];
  entries.forEach((e) => {
    const st = states.get(e.id);
    if (!st || !st.versions || st.versions.length < 2) return;
    const first = st.versions[0].after.totals;
    const last = st.versions[st.versions.length - 1];
    const now = totalsOfRow(e);
    const delta = {}; ['grossPay', 'totalDeductions', 'netPay', 'ctc'].forEach((k) => { delta[k] = now[k] - first[k]; });
    rows.push({
      entryId: e.id, employeeId: e.employeeId, name: e.employee.name, employeeCode: e.employee.employeeCode, department: e.employee.department, status: e.status,
      statusLabel: E.STATUS_LABEL[e.status], edits: st.versions.length - 1, lastBy: last.byName, lastAt: last.at, lastReason: last.reason,
      editors: [...new Set(st.versions.slice(1).map((v) => v.byName))], before: first, after: now, delta,
      changes: st.versions.slice(1).flatMap((v) => (v.changes || []).map((ch) => ({ ...ch, byName: v.byName, at: v.at, reason: v.reason }))),
    });
  });
  const tot = { employees: rows.length, before: { grossPay: 0, totalDeductions: 0, netPay: 0, ctc: 0 }, after: { grossPay: 0, totalDeductions: 0, netPay: 0, ctc: 0 }, delta: { grossPay: 0, totalDeductions: 0, netPay: 0, ctc: 0 } };
  rows.forEach((r) => ['grossPay', 'totalDeductions', 'netPay', 'ctc'].forEach((k) => { tot.before[k] += r.before[k]; tot.after[k] += r.after[k]; tot.delta[k] += r.delta[k]; }));
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { month, rows, totals: tot };
}

// Maker-checker: the person who edited a record cannot approve it.
async function makerCheckerBlock(entry, userId) {
  const st = await readState(entry.id);
  if (userId && st.editors && st.editors.includes(userId)) {
    return 'You edited this payroll, so another approver must approve it (the person who edits cannot approve the same payroll).';
  }
  return null;
}
async function editedIds(ids) {
  const m = await readStates(ids);
  const out = new Set();
  m.forEach((st, id) => { if (st.edited) out.add(id); });
  return out;
}

// ---- Adjustments (Paid / Posted / Approved / imported months are never rewritten) -----------------------
async function readAdj(month) {
  const row = await prisma.appSetting.findUnique({ where: { key: adjKey(month) } }).catch(() => null);
  if (!row) return [];
  try { const a = JSON.parse(row.value); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function adjustmentsFor(month) {
  const list = await readAdj(month);
  const map = new Map();
  list.filter((a) => !a.cancelled).forEach((a) => {
    const m = map.get(a.employeeId) || { earn: [], ded: [] };
    const line = { id: `adj-${a.id}`, label: a.label, amount: a.amount, adj: a.id, sourceMonth: a.sourceMonth };
    (a.kind === 'RECOVERY' ? m.ded : m.earn).push(line);
    map.set(a.employeeId, m);
  });
  return map;
}
// Adds a month's adjustment lines to one engine row (pure; no lines = the row unchanged).
function applyAdjustments(c, version, policy, adj) {
  if (!adj || (!adj.earn.length && !adj.ded.length)) return { row: c, lines: { earnings: [], deductions: [] } };
  const rules = rulesFromVersion(version, policy, c.payMode);
  const comps = {
    workingDays: c.workingDays, daysLop: c.daysLop, basic: c.basic, hra: c.hra, bonus: c.bonus, specialAllowance: c.specialAllowance, conveyance: c.conveyance,
    incentive: c.incentive, stipend: c.payMode === 'Stipend' ? c.grossPay - c.incentive : 0, arrears: 0, extraEarn: adj.earn.map((x) => x.amount),
    otherDeductions: c.otherDeductions, loan: 0, extraDed: adj.ded.map((x) => x.amount), manual: {},
  };
  const res = payrollCalc(comps, rules);
  const row = {
    ...c, arrears: res.arrears, grossPay: res.grossPay, lopDeduction: res.lopDeduction, earnedGross: res.earnedGross,
    pfEmployee: res.pfEmployee, esiEmployee: res.esiEmployee, professionalTax: res.professionalTax, tds: res.tds,
    otherDeductions: res.otherDeductions, totalDeductions: res.totalDeductions, netPay: res.netPay,
    pfEmployer: res.pfEmployer, esiEmployer: res.esiEmployer, gratuity: res.gratuity,
  };
  return { row, lines: { earnings: adj.earn, deductions: adj.ded } };
}

// After calculateMonth wrote rows: refresh each record's state (engine baseline + its adjustment lines).
async function afterCalculate(rows, adjMap, actor) {
  const ids = rows.filter((r) => r.id).map((r) => r.id);
  const states = await readStates(ids);
  for (const r of rows) {
    if (!r.id) continue;
    const st = states.get(r.id);
    const adj = adjMap.get(r.employeeId);
    const lines = { earnings: adj ? adj.earn : [], deductions: adj ? adj.ded : [] };
    if (!st && !lines.earnings.length && !lines.deductions.length) continue;
    const next = { ...(st || freshState()), manual: {}, loan: 0, extras: lines, edited: false };
    // eslint-disable-next-line no-await-in-loop
    await writeState(r.id, next, actor);
  }
}

async function nextOpenMonth(employeeId, sourceMonth) {
  let m = sourceMonth;
  for (let i = 0; i < 24; i += 1) {
    m = PC.addMonths(m, 1);
    // eslint-disable-next-line no-await-in-loop
    const e = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId, month: m } } });
    // eslint-disable-next-line no-await-in-loop
    const run = e ? null : await prisma.payrollRun.findUnique({ where: { month: m } });
    const legacyLocked = run && ['Processing', 'Paid'].includes(run.status) && !(await prisma.employeePayrollRun.count({ where: { month: m } }));
    const anyLocked = !e && !legacyLocked ? await prisma.employeePayrollRun.count({ where: { month: m, status: { notIn: EDITABLE } } }) : 0;
    if (!(e && (lockOf(e) || false)) && !legacyLocked && !anyLocked) return m;
  }
  throw new EditError(409, 'No open payroll month was found for this adjustment.');
}

async function createAdjustment({ employeeId, sourceMonth, kind, amount, label, reason, actor, ip }) {
  if (!E.isMonth(sourceMonth)) throw new EditError(400, 'Pick the month the correction is for.');
  const k = String(kind || '').toUpperCase();
  if (!['ARREARS', 'RECOVERY'].includes(k)) throw new EditError(400, 'Choose Arrears (pay more) or Recovery (take back).');
  const amt = r0(amount);
  if (!(Number(amount) > 0) || amt < 1 || amt > 10000000) throw new EditError(400, 'The amount must be a number above 0.');
  const text = String(label || '').trim().slice(0, 60) || (k === 'ARREARS' ? 'Arrears' : 'Recovery');
  const why = String(reason || '').trim();
  if (why.length < 3) throw new EditError(400, 'Say why this adjustment is needed (at least 3 letters).');
  const src = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId, month: sourceMonth } }, include: { employee: true } });
  if (!src) throw new EditError(404, `${monthLabel(sourceMonth)} has no payroll record for this employee.`);
  if (!lockOf(src)) throw new EditError(409, `${monthLabel(sourceMonth)} is still open for this employee. Use Edit instead of an adjustment.`);
  const target = await nextOpenMonth(employeeId, sourceMonth);
  const list = await readAdj(target);
  const adj = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, employeeId, kind: k, amount: amt, label: text, reason: why,
    sourceMonth, targetMonth: target, createdById: actor.id || null, createdBy: actor.name, createdAt: new Date().toISOString(), ip: ip || null, cancelled: false,
  };
  list.push(adj);
  await prisma.appSetting.upsert({ where: { key: adjKey(target) }, update: { value: JSON.stringify(list) }, create: { key: adjKey(target), value: JSON.stringify(list) } });
  await logAudit({
    userId: actor.id || null, actorName: actor.name, action: 'Payroll adjustment added', entity: 'PayrollAdjustment', entityId: adj.id,
    field: k, fieldLabel: `${text} · ${src.employee.name} · ${monthLabel(sourceMonth)} -> ${monthLabel(target)} · IP ${ip || '-'}`,
    fromValue: monthLabel(sourceMonth), toValue: `${k === 'ARREARS' ? '+' : '-'}${amt} in ${monthLabel(target)}`, reason: why,
  });
  // already a record in the target month? put the line in it now (the payslip / voucher of the source month stay untouched)
  let applied = false;
  const tgt = await prisma.employeePayrollRun.findUnique({ where: { employeeId_month: { employeeId, month: target } }, include: { employee: true } });
  if (tgt && !lockOf(tgt)) { await appendAdjustmentLine(tgt, adj, actor, ip); applied = true; }
  return { adjustment: adj, targetMonth: target, applied };
}
async function appendAdjustmentLine(entry, adj, actor, ip) {
  const state = await readState(entry.id);
  const { rules } = await rulesFor(entry);
  const cur = componentsOf(entry, state);
  const drift = driftOf(cur, rules);
  const line = { id: `adj-${adj.id}`, label: adj.label, amount: adj.amount, adj: adj.id, sourceMonth: adj.sourceMonth };
  const lines = { earnings: [...state.extras.earnings], deductions: [...state.extras.deductions] };
  if (adj.kind === 'RECOVERY') lines.deductions.push(line); else lines.earnings.push(line);
  const c = { ...cur, manual: { ...state.manual, ...drift }, extraEarn: lines.earnings.map((x) => x.amount), extraDed: lines.deductions.map((x) => x.amount) };
  const res = payrollCalc(c, rules);
  return commit({ entry, state, res, c, lines, loan: state.loan || 0, manual: c.manual, kind: 'adjustment', actor, ip, reason: `Adjustment from ${monthLabel(adj.sourceMonth)}: ${adj.label}` });
}
async function listAdjustments({ month = null, employeeId = null, sourceMonth = null }) {
  const out = [];
  if (month) out.push(...await readAdj(month));
  else {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'payroll.adj:' } } });
    rows.forEach((r) => { try { out.push(...JSON.parse(r.value)); } catch { /* skip */ } });
  }
  return out.filter((a) => (!employeeId || a.employeeId === employeeId) && (!sourceMonth || a.sourceMonth === sourceMonth));
}

// ---- Payslip lines (labelled added rows) and the admin-only edit info ----------------------------------
// Written when a payslip is issued (utils/payrollEngine.js writePayslip), so an issued payslip keeps its own lines.
function payslipLinesOf(entry, state) {
  const st = state || freshState();
  const earn = (st.extras && st.extras.earnings) || [];
  const ded = (st.extras && st.extras.deductions) || [];
  const loan = Math.max(0, r0(st.loan));
  const out = { earnings: [], deductions: [] };
  const fixedArrears = Math.max(0, r0(entry.arrears) - sumAmt(earn));
  if (fixedArrears > 0) out.earnings.push({ label: 'Arrears', amount: fixedArrears });
  earn.forEach((x) => { if (x.amount > 0) out.earnings.push({ label: x.label, amount: x.amount }); });
  const fixedOther = Math.max(0, r0(entry.otherDeductions) - loan - sumAmt(ded));
  if (fixedOther > 0) out.deductions.push({ label: 'Other Deductions', amount: fixedOther });
  if (loan > 0) out.deductions.push({ label: 'Loan / Advance', amount: loan });
  ded.forEach((x) => { if (x.amount > 0) out.deductions.push({ label: x.label, amount: x.amount }); });
  return out;
}
async function snapshotPayslipLines(slip, entry) {
  try {
    const st = await readState(entry.id);
    if (!st.versions.length && !(st.extras.earnings.length || st.extras.deductions.length || st.loan)) return; // untouched record: nothing to keep
    const value = JSON.stringify(payslipLinesOf(entry, st));
    const key = `payroll.payslipLines:${slip.id}`;
    await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  } catch { /* the payslip stands without the label split */ }
}
async function payslipLines(slipId) {
  const row = await prisma.appSetting.findUnique({ where: { key: `payroll.payslipLines:${slipId}` } }).catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
// For Admin / HR only (never shown to the employee): was this payroll edited, and which older payslips were superseded.
async function editInfoFor(slip) {
  if (!slip.payrollEntryId) return null;
  const st = await readState(slip.payrollEntryId);
  const last = st.versions.length > 1 ? st.versions[st.versions.length - 1] : null;
  if (!last && !(st.payslipArchive || []).length) return null;
  return { edited: st.edited || st.versions.length > 1, versions: Math.max(0, st.versions.length - 1), lastBy: last ? last.byName : null, lastAt: last ? last.at : null, lastReason: last ? last.reason : null, superseded: st.payslipArchive || [] };
}

module.exports = {
  payslipLinesOf, snapshotPayslipLines, payslipLines, editInfoFor,
  EDITABLE, QUICK_REASONS, FIELD_LABELS, EditError,
  readState, readStates, lockOf, isImported, rulesFromVersion, rulesFor, componentsOf, driftOf, editorPayload, saveEdit,
  engineCompare, applyEngine, historyOf, changesInRun, makerCheckerBlock, editedIds,
  adjustmentsFor, applyAdjustments, afterCalculate, createAdjustment, listAdjustments, nextOpenMonth, totalsOfRow,
};
