// ---------------------------------------------------------------------------
// PULSE HRMS SYNC (HRMS item 8, 2026-10-13) - by FILE.
//
// RESEARCH RESULT: PulseHRM publishes no public API or webhook documentation we can call (a web search
// finds only product listings; "API" appears as a marketing feature, with no endpoints, keys or
// events). We do not guess endpoints and never log in to it. The safe design is an IMPORT of Pulse's own
// "Leave History" export (.xlsx / .csv, the same columns utils/../scripts/load-pulsehrm*.js reads):
//
//   Employee ID, Employee Name, Department, Work Location, Date Of Application, Leave Type, Leave From,
//   Leave To, Half Day, Duration, Reason, Comments, ..., Approver, Approver Comments, Approved Date, ..., Status
//
// Each Pulse row is matched to a TeamLink request by employee id + leave type + from + to (+ half day):
//   Pulse Approved/Rejected/Cancelled and ours Pending   -> UPDATED to that status (approver + date from Pulse)
//   same status on both                                  -> unchanged
//   Pulse says Pending and ours is Pending               -> unchanged (genuinely open there too)
//   a different decided status on both                   -> skipped "conflict", HR decides
//   Pulse row we do not have                             -> CREATED (as its status, Source = Pulse sync, no notification)
//   our Pending that Pulse does not list (employees in the file only, older than N days)
//                                                        -> flagged "Only in TeamLink" (never changed or deleted)
// Nothing is sent to employees (one summary bell goes to HR). Every change has an audit row and an entry in
// the undo manifest (24 h). Balances: an update to Approved draws the days like a normal approval; CREATED history
// rows do not touch balances (the Leave Balances export is the source of truth for those).
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const prisma = require('../db');
const { logAudit } = require('./audit');
const leaveText = require('./leaveText');
const leaveMeta = require('./leaveMeta');
const genuine = require('./leaveGenuine');

const WF = 'leave';
const LAST_KEY = 'leave.pulse.last';
const RUN_KEY = (id) => `leave.pulse.sync.${id}`;
const UNDO_MS = 24 * 3600 * 1000;
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');
const LEFT = genuine.LEFT_STATUSES;

function toIso(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : ''; }
  const s = String(v).trim();
  let m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]*(\d{2,4})$/.exec(s);
  if (m && MON[m[2].toUpperCase()]) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(MON[m[2].toUpperCase()])}-${pad(m[1])}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s); if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}
const STATUS_MAP = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected', declined: 'Rejected', cancelled: 'Cancelled', canceled: 'Cancelled', withdrawn: 'Cancelled', revoked: 'Cancelled' };
const clean = (v) => String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// buffer -> { rows, problems }. Reads xlsx or csv.
function parseExport(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], problems: ['The file has no sheet.'] };
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  const rows = []; const problems = [];
  raw.forEach((r, i) => {
    const get = (...names) => { const k = Object.keys(r).find((x) => names.some((n) => norm(x) === norm(n))); return k === undefined ? '' : r[k]; };
    const code = clean(get('Employee ID', 'Employee Number', 'Employee Code'));
    if (!code && !clean(get('Leave From'))) return; // blank line
    const status = STATUS_MAP[clean(get('Status')).toLowerCase()] || null;
    const half = clean(get('Half Day', 'Half Day Type'));
    const dur = Number(get('Duration', 'Days'));
    rows.push({
      row: i + 2, code, name: clean(get('Employee Name', 'Name')), type: clean(get('Leave Type')),
      from: toIso(get('Leave From', 'From')), to: toIso(get('Leave To', 'To')) || toIso(get('Leave From', 'From')),
      appliedOn: toIso(get('Date Of Application', 'Applied On')), half: /first/i.test(half) ? 'First Half' : /second/i.test(half) ? 'Second Half' : (half && !/^(no|n|false|0)$/i.test(half) ? 'Half' : (dur === 0.5 ? 'Half' : '')),
      days: Number.isFinite(dur) && dur > 0 ? dur : null, reason: clean(get('Reason')), comments: clean(get('Comments')),
      approver: clean(get('Approver')), approverComments: clean(get('Approver Comments')), approvedOn: toIso(get('Approved Date')), status, rawStatus: clean(get('Status')),
    });
  });
  if (!rows.length) problems.push('No leave rows found. Upload the "Leave History" file exported from Pulse HRMS.');
  return { rows, problems };
}

const halfOk = (pulseHalf, ours) => !pulseHalf || pulseHalf === 'Half' || !ours || ours.toLowerCase() === pulseHalf.toLowerCase();

// PLAN (read only). opts: { create: true, createPending: true, onlyDays: 7 }
async function plan(rows, { create = true, createPending = true, onlyDays = 7, now = new Date() } = {}) {
  const codes = [...new Set(rows.map((r) => r.code.toLowerCase()).filter(Boolean))];
  const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, employmentStatus: true, department: true, userId: true } });
  const empByCode = new Map(emps.map((e) => [String(e.employeeCode || '').toLowerCase(), e]));
  const known = codes.map((c) => empByCode.get(c)).filter(Boolean);
  const ours = known.length ? await prisma.leaveRequest.findMany({ where: { employeeId: { in: known.map((e) => e.id) } } }) : [];
  const byEmp = new Map();
  ours.forEach((l) => { if (!byEmp.has(l.employeeId)) byEmp.set(l.employeeId, []); byEmp.get(l.employeeId).push(l); });
  const stale = await genuine.getStaleDays();
  const cutoff = genuine.addDays(genuine.todayIso(now), -stale);
  const used = new Set();
  const items = [];
  const seenKeys = new Set();
  for (const r of rows) {
    const base = { row: r.row, code: r.code, name: r.name, type: r.type, from: r.from, end: r.to, half: r.half, pulseStatus: r.rawStatus };
    if (!r.status) { items.push({ ...base, action: 'skipped', reason: `Status "${r.rawStatus || '(blank)'}" is not Approved, Pending, Rejected or Cancelled`, r }); continue; }
    if (!r.type || !r.from || !r.to || r.to < r.from) { items.push({ ...base, action: 'skipped', reason: 'Leave type or dates missing / not understood', r }); continue; }
    const e = empByCode.get(r.code.toLowerCase());
    if (!e) { items.push({ ...base, action: 'skipped', reason: `Employee ${r.code} is not in TeamLink`, r }); continue; }
    const key = `${e.id}|${r.type}|${r.from}|${r.to}|${r.half || ''}`;
    if (seenKeys.has(key)) { items.push({ ...base, action: 'skipped', reason: 'Same row twice in the file', r }); continue; }
    seenKeys.add(key);
    const mine = (byEmp.get(e.id) || []).filter((l) => l.type === r.type && String(l.fromDate).slice(0, 10) === r.from && String(l.toDate).slice(0, 10) === r.to && halfOk(r.half, leaveText.halfOf(l)));
    // prefer an open one, then a decided one
    const hit = mine.find((l) => l.status === 'Pending') || mine.find((l) => !used.has(l.id)) || mine[0] || null;
    if (hit) {
      used.add(hit.id);
      const cur = hit.status === 'Cancellation Requested' ? 'Approved' : hit.status;
      if (cur === r.status) { items.push({ ...base, action: 'unchanged', reason: r.status === 'Pending' ? 'Still waiting in Pulse as well' : `Already ${r.status}`, leaveId: hit.id, employeeId: e.id, r }); continue; }
      if (hit.status === 'Pending' && r.status !== 'Pending') { items.push({ ...base, action: 'update', to: r.status, reason: `Pulse says ${r.status}${r.approver ? ` (${r.approver})` : ''}`, leaveId: hit.id, employeeId: e.id, r }); continue; }
      items.push({ ...base, action: 'skipped', reason: `Conflict: TeamLink says ${hit.status}, Pulse says ${r.status}. HR decides`, leaveId: hit.id, employeeId: e.id, r }); continue;
    }
    // a Pulse row TeamLink does not have
    if (!create) { items.push({ ...base, action: 'skipped', reason: 'Not in TeamLink (creating is switched off)', employeeId: e.id, r }); continue; }
    const overlap = (byEmp.get(e.id) || []).find((l) => l.type === r.type && ['Pending', 'Approved', 'Cancellation Requested'].includes(l.status) && String(l.fromDate).slice(0, 10) <= r.to && String(l.toDate).slice(0, 10) >= r.from && halfOk(r.half, leaveText.halfOf(l)));
    if (overlap && (r.status === 'Pending' || r.status === 'Approved')) { items.push({ ...base, action: 'skipped', reason: `Overlaps ${overlap.status} ${overlap.type} ${String(overlap.fromDate).slice(0, 10)}-${String(overlap.toDate).slice(0, 10)} in TeamLink (not created twice)`, leaveId: overlap.id, employeeId: e.id, r }); continue; }
    if (r.status === 'Pending') {
      if (!createPending) { items.push({ ...base, action: 'skipped', reason: 'Pending in Pulse, not in TeamLink (creating pending is switched off)', employeeId: e.id, r }); continue; }
      if (LEFT.includes(e.employmentStatus)) { items.push({ ...base, action: 'skipped', reason: `Pending in Pulse but ${e.name} has left`, employeeId: e.id, r }); continue; }
      if (r.to < cutoff) { items.push({ ...base, action: 'skipped', reason: `Pending in Pulse with dates older than ${stale} days: decide it in Pulse`, employeeId: e.id, r }); continue; }
    }
    items.push({ ...base, action: 'create', to: r.status, reason: `Not in TeamLink: create as ${r.status}`, employeeId: e.id, r });
  }
  // Only in TeamLink: our Pending (people in the file) that Pulse does not list at all
  const pend = await prisma.leaveRequest.findMany({ where: { status: 'Pending', employeeId: { in: known.map((e) => e.id) } }, include: { employee: { select: { name: true, employeeCode: true, employmentStatus: true } } } });
  const only = pend.filter((l) => !used.has(l.id) && new Date(l.createdAt).getTime() < now.getTime() - onlyDays * 86400000)
    .map((l) => ({ leaveId: l.id, code: l.employee.employeeCode, name: l.employee.name, type: l.type, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10), appliedOn: genuine.addDays(new Date(l.createdAt).toISOString().slice(0, 10), 0), employeeStatus: l.employee.employmentStatus }));
  const counts = { updated: 0, created: 0, unchanged: 0, onlyInTeamLink: only.length, skipped: 0 };
  items.forEach((i) => { if (i.action === 'update') counts.updated += 1; else if (i.action === 'create') counts.created += 1; else if (i.action === 'unchanged') counts.unchanged += 1; else counts.skipped += 1; });
  return { items, only, counts, fileRows: rows.length };
}

// Close the open approval steps of a request when Pulse decided it. Returns the steps' previous state for undo.
async function closeSteps(leaveId, decision, byName, note) {
  const steps = await prisma.approvalStep.findMany({ where: { workflow: WF, recordId: leaveId, status: { in: ['Pending', 'Waiting', 'Visibility'] } } });
  const before = steps.map((s) => ({ id: s.id, status: s.status, actedAt: s.actedAt, actedByName: s.actedByName, note: s.note }));
  for (const s of steps) {
    const st = s.status === 'Pending' ? (decision === 'Approved' ? 'Approved' : 'Rejected') : 'Skipped';
    // eslint-disable-next-line no-await-in-loop
    await prisma.approvalStep.update({ where: { id: s.id }, data: { status: st, actedAt: new Date(), actedByName: byName, note } });
  }
  return before;
}

async function apply(rows, user, opts = {}) {
  const pl = await plan(rows, opts);
  const syncId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const manifest = [];
  const results = [];
  const leaveCharge = require('./leaveCharge'); // eslint-disable-line global-require
  const by = user ? (user.name || user.email) : 'Pulse sync';
  for (const it of pl.items) {
    const res = { row: it.row, code: it.code, name: it.name, type: it.type, from: it.from, to: it.end, pulseStatus: it.pulseStatus, action: it.action, reason: it.reason };
    try {
      if (it.action === 'update') {
        const cur = await prisma.leaveRequest.findUnique({ where: { id: it.leaveId } });
        if (!cur || cur.status !== 'Pending') { res.action = 'skipped'; res.reason = 'Changed in TeamLink since the preview'; results.push(res); continue; } // eslint-disable-line no-continue
        const r = it.r;
        const decidedAt = r.approvedOn ? new Date(`${r.approvedOn}T12:00:00`) : new Date();
        const decidedBy = `${r.approver || 'Pulse HRM'} (Pulse)`;
        const data = { status: it.to, decidedAt, decidedBy };
        if (it.to === 'Approved') data.approvalReason = r.approverComments || null; else if (it.to === 'Rejected') data.rejectReason = r.approverComments || 'Rejected in Pulse HRMS';
        const before = { status: cur.status, decidedAt: cur.decidedAt, decidedBy: cur.decidedBy, approvalReason: cur.approvalReason, rejectReason: cur.rejectReason };
        const prevMeta = await leaveMeta.getMeta(cur.id);
        const stepsBefore = await closeSteps(cur.id, it.to, decidedBy, `Decided in Pulse HRMS (${it.to}) - synced by ${by}`);
        const upd = await prisma.leaveRequest.update({ where: { id: cur.id }, data });
        let charged = false;
        if (it.to === 'Approved') {
          const pre = await prisma.auditLog.findFirst({ where: { entity: 'LeaveRequest', entityId: cur.id, action: 'Leave imported — days already counted in PulseHRM availed' }, select: { id: true } });
          if (!pre) { try { await leaveCharge.onApprove(upd, user ? user.id : null); charged = true; } catch (e) { res.note = `balance not moved: ${e.message}`; } }
        }
        await leaveMeta.setMeta(cur.id, { source: (prevMeta && prevMeta.source) || 'TeamLink', pulseStatus: it.to, pulseBy: r.approver || null, pulseAt: r.approvedOn || null, syncId });
        await logAudit({ userId: user ? user.id : null, actorName: by, action: 'Leave updated from Pulse sync', entity: 'LeaveRequest', entityId: cur.id, fromValue: 'Pending', toValue: it.to, reason: `Pulse row ${it.row}${r.approver ? `, approver ${r.approver}` : ''}` });
        manifest.push({ kind: 'update', leaveId: cur.id, before, stepsBefore, charged, prevMeta });
      } else if (it.action === 'create') {
        const r = it.r;
        const e = await prisma.employee.findUnique({ where: { id: it.employeeId } });
        const status = it.to;
        const days = r.half ? 0.5 : (r.days || Math.max(1, Math.round((new Date(`${r.to}T00:00:00Z`) - new Date(`${r.from}T00:00:00Z`)) / 86400000) + 1));
        const reason = leaveText.compose({ reason: r.reason, comments: r.comments, details: [['Half day', r.half && r.half !== 'Half' ? r.half : null], ['Source', 'Pulse HRM sync']] });
        const decided = status !== 'Pending';
        const row = await prisma.leaveRequest.create({
          data: {
            employeeId: e.id, type: r.type, fromDate: r.from, toDate: r.to, days, reason, status,
            ...(r.appliedOn ? { createdAt: new Date(`${r.appliedOn}T09:00:00`) } : {}),
            ...(decided ? { decidedAt: r.approvedOn ? new Date(`${r.approvedOn}T12:00:00`) : new Date(), decidedBy: `${r.approver || 'Pulse HRM'} (Pulse)`, approvalReason: status === 'Approved' ? (r.approverComments || null) : null, rejectReason: status === 'Rejected' ? (r.approverComments || 'Rejected in Pulse HRMS') : null } : {}),
          },
        });
        if (!decided) { try { await require('./approvalWorkflow').start({ workflow: WF, recordId: row.id, employee: e, applicantUserId: e.userId || null, applicantName: e.name }); } catch (err) { res.note = `chain not started: ${err.message}`; } } // eslint-disable-line global-require
        await leaveMeta.setMeta(row.id, { source: 'Pulse sync', pulseStatus: status, pulseBy: r.approver || null, pulseAt: r.approvedOn || null, syncId });
        await logAudit({ userId: user ? user.id : null, actorName: by, action: 'Leave created from Pulse sync', entity: 'LeaveRequest', entityId: row.id, toValue: `${status} ${r.type} ${r.from}-${r.to}`, reason: `Pulse row ${it.row}` });
        manifest.push({ kind: 'create', leaveId: row.id, status });
        res.leaveId = row.id;
      }
    } catch (err) { res.action = 'skipped'; res.reason = `Error: ${err.message}`; }
    results.push(res);
  }
  const counts = { updated: 0, created: 0, unchanged: 0, onlyInTeamLink: pl.only.length, skipped: 0 };
  results.forEach((x) => { if (x.action === 'update') counts.updated += 1; else if (x.action === 'create') counts.created += 1; else if (x.action === 'unchanged') counts.unchanged += 1; else counts.skipped += 1; });
  const at = new Date().toISOString();
  await prisma.appSetting.upsert({ where: { key: RUN_KEY(syncId) }, update: { value: JSON.stringify({ syncId, at, by, counts, results, only: pl.only, manifest }) }, create: { key: RUN_KEY(syncId), value: JSON.stringify({ syncId, at, by, counts, results, only: pl.only, manifest }) } });
  const last = JSON.stringify({ syncId, at, by, byId: user ? user.id : null, counts, undone: false });
  await prisma.appSetting.upsert({ where: { key: LAST_KEY }, update: { value: last }, create: { key: LAST_KEY, value: last } });
  // ONE summary bell to HR, never one per employee
  await summaryBell(counts, by, user).catch(() => {});
  return { syncId, at, counts, results, only: pl.only };
}

async function summaryBell(counts, by, user) {
  const hr = await prisma.user.findMany({ where: { status: 'Active', OR: [{ hrmsRole: 'HR' }, { AND: [{ hrmsRole: null }, { role: 'HR' }] }] }, select: { id: true, name: true, email: true } });
  const ids = new Set(hr.filter((u) => !/zztest|example\.test/i.test(`${u.name} ${u.email}`) || (user && u.id === user.id)).map((u) => u.id));
  if (user) ids.add(user.id);
  const message = `${by} synced leave with Pulse: ${counts.updated} updated, ${counts.created} created, ${counts.unchanged} unchanged, ${counts.onlyInTeamLink} only in TeamLink, ${counts.skipped} skipped.\nOpen: /leave?tab=pulse`;
  for (const userId of ids) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId, title: 'Leave synced with Pulse', message, channel: 'In-App', status: 'Delivered' } });
  }
}

async function lastSync() {
  const row = await prisma.appSetting.findUnique({ where: { key: LAST_KEY } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    return { ...v, undoable: !v.undone && Date.now() - new Date(v.at).getTime() < UNDO_MS };
  } catch { return null; }
}
async function getRun(syncId) {
  const row = await prisma.appSetting.findUnique({ where: { key: RUN_KEY(syncId) } });
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

// UNDO the last sync (within 24 h). A created request is removed only if still as created; an updated one goes back to Pending.
async function undoLast(user) {
  const last = await lastSync();
  if (!last) return { error: 'There is no sync to undo.' };
  if (last.undone) return { error: 'That sync was already undone.' };
  if (!last.undoable) return { error: 'The undo window (24 hours) has passed.' };
  const run = await getRun(last.syncId);
  if (!run) return { error: 'The undo record is missing.' };
  const leaveCharge = require('./leaveCharge'); // eslint-disable-line global-require
  let reverted = 0; let removed = 0; const kept = [];
  for (const m of run.manifest.slice().reverse()) {
    if (m.kind === 'update') {
      const cur = await prisma.leaveRequest.findUnique({ where: { id: m.leaveId } });
      if (!cur) continue; // eslint-disable-line no-continue
      if (m.charged) { try { await leaveCharge.onCancel(cur, user ? user.id : null); } catch { /* ledger already moved */ } }
      await prisma.leaveRequest.update({ where: { id: m.leaveId }, data: { status: m.before.status, decidedAt: m.before.decidedAt, decidedBy: m.before.decidedBy, approvalReason: m.before.approvalReason, rejectReason: m.before.rejectReason } });
      for (const s of m.stepsBefore) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.approvalStep.update({ where: { id: s.id }, data: { status: s.status, actedAt: s.actedAt, actedByName: s.actedByName, note: s.note } }).catch(() => {});
      }
      if (m.prevMeta) await leaveMeta.setMeta(m.leaveId, { ...m.prevMeta, pulseStatus: null, pulseBy: null, pulseAt: null, syncId: null }); else await leaveMeta.clearMeta(m.leaveId);
      await logAudit({ userId: user ? user.id : null, actorName: user && user.name, action: 'Leave Pulse sync undone', entity: 'LeaveRequest', entityId: m.leaveId, fromValue: 'synced', toValue: m.before.status });
      reverted += 1;
    } else if (m.kind === 'create') {
      const cur = await prisma.leaveRequest.findUnique({ where: { id: m.leaveId } });
      if (!cur) continue; // eslint-disable-line no-continue
      const acted = await prisma.approvalStep.count({ where: { workflow: WF, recordId: m.leaveId, status: { in: ['Approved', 'Rejected'] }, mode: { not: 'applicant' } } });
      if (cur.status !== m.status || acted) { kept.push(m.leaveId); continue; } // eslint-disable-line no-continue
      await prisma.approvalStep.deleteMany({ where: { workflow: WF, recordId: m.leaveId } });
      await prisma.leaveRequest.delete({ where: { id: m.leaveId } });
      await leaveMeta.clearMeta(m.leaveId);
      await prisma.appSetting.deleteMany({ where: { key: `leave.early.${m.leaveId}` } });
      await logAudit({ userId: user ? user.id : null, actorName: user && user.name, action: 'Leave Pulse sync undone (created request removed)', entity: 'LeaveRequest', entityId: m.leaveId });
      removed += 1;
    }
  }
  await prisma.appSetting.update({ where: { key: LAST_KEY }, data: { value: JSON.stringify({ ...last, undone: true, undoneAt: new Date().toISOString(), undoneBy: user ? user.name : null }) } });
  return { reverted, removed, kept: kept.length };
}

function resultCsv(run) {
  const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Row', 'Employee ID', 'Name', 'Leave type', 'From', 'To', 'Pulse status', 'Result', 'Why'];
  const lines = [head.map(esc).join(',')];
  run.results.forEach((r) => lines.push([r.row, r.code, r.name, r.type, r.from, r.to, r.pulseStatus, ({ update: 'Updated', create: 'Created', unchanged: 'Unchanged', skipped: 'Skipped' })[r.action] || r.action, r.reason].map(esc).join(',')));
  (run.only || []).forEach((o) => lines.push(['', o.code, o.name, o.type, o.from, o.to, '(not in Pulse file)', 'Only in TeamLink', `Pending since ${o.appliedOn}; HR to decide`].map(esc).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// HR reminder when the last sync is older than 7 days. INERT unless the pending-approval master switch is on (called from chainAlerts.run only then).
async function maybeRemindHr({ now = new Date(), dryRun = false } = {}) {
  const last = await lastSync();
  const ageDays = last ? (now.getTime() - new Date(last.at).getTime()) / 86400000 : null;
  if (last && ageDays < 7) return { reminded: 0 };
  if (dryRun) return { reminded: 0, due: true };
  const hr = await prisma.user.findMany({ where: { status: 'Active', OR: [{ hrmsRole: 'HR' }, { AND: [{ hrmsRole: null }, { role: 'HR' }] }] }, select: { id: true, name: true, email: true } });
  const title = 'Leave not synced with Pulse for over a week';
  const since = new Date(now); since.setHours(0, 0, 0, 0);
  let n = 0;
  for (const u of hr.filter((x) => !/zztest|example\.test/i.test(`${x.name} ${x.email}`))) {
    // eslint-disable-next-line no-await-in-loop
    const seen = await prisma.notification.findFirst({ where: { userId: u.id, title, createdAt: { gte: since } }, select: { id: true } });
    if (seen) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: u.id, title, message: `${last ? `Last sync: ${last.at.slice(0, 10)} by ${last.by}.` : 'It has not been synced yet.'} Upload Pulse's latest Leave History.\nOpen: /leave?tab=pulse`, channel: 'In-App', status: 'Delivered' } });
    n += 1;
  }
  return { reminded: n };
}

module.exports = { parseExport, plan, apply, lastSync, getRun, undoLast, resultCsv, maybeRemindHr, toIso };
