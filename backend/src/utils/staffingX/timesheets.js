// ---------------------------------------------------------------------------
// CONTRACTOR TIMESHEETS (11.15) + BILLING FROM TIMESHEETS (06.12, see billing.js).
// One row per contractor per week (Monday first): the hours of each day and a note.
//   Draft      the contractor (candidate portal login) or their recruiter / TL is filling it in
//   Submitted  waiting for approval: the client (client portal login of that company with "decide" or "invoices") or a TeamLink
//              team lead - who may approve is an Admin setting (approval.mode). Whoever entered it can never approve it.
//   Approved   locked; the pay, cost and bill of the week are worked out from the rate of that week and kept on the row
//   Rejected   back to the contractor with the reason; they fix it and send it again
// An Admin can reopen an approved week that is not billed yet (with a reason). Reminders are OFF until an Admin switches them on.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');
const K = require('./contracts');

const roleOf = (u) => K.roleOf(u);
const isLeadRole = (u) => ['admin', 'tl', 'stl'].includes(roleOf(u)) || require('../scope').isBdeTl(u); // eslint-disable-line global-require
const kindOf = (u) => (roleOf(u) === 'candidate' ? 'Contractor' : roleOf(u) === 'client' ? 'Client' : 'TeamLink');

// What each audience may see of a week. The client: bill side. The contractor: own pay. BDE: bill side. Others: everything.
function shape(r, user, c) {
  const role = roleOf(user);
  const base = {
    id: r.id, applicationId: r.applicationId, weekStart: r.weekStart, weekEnd: S.addDays(r.weekStart, 6), hours: S.parse(r.hours, []), note: r.note || null,
    status: r.status, totalHours: Number(r.totalHours) || 0, regHours: Number(r.regHours) || 0, otHours: Number(r.otHours) || 0, daysWorked: S.num(r.daysWorked),
    submittedByKind: r.submittedByKind || null, submittedByName: r.submittedByName || null, submittedAt: r.submittedAt || null,
    decidedByKind: r.decidedByKind || null, decidedByName: r.decidedByName || null, decidedAt: r.decidedAt || null, rejectReason: r.rejectReason || null,
    billed: !!r.batchId, ...(c ? { name: c.name, client: c.client, clientId: c.clientId, requirement: c.requirement } : {}),
  };
  if (role === 'candidate') return { ...base, payAmount: r.payAmount == null ? null : Number(r.payAmount), billed: undefined };
  if (role === 'client' || !K.seesPay(user)) return { ...base, billAmount: r.billAmount == null ? null : Number(r.billAmount) };
  return { ...base, payAmount: r.payAmount == null ? null : Number(r.payAmount), costAmount: r.costAmount == null ? null : Number(r.costAmount), billAmount: r.billAmount == null ? null : Number(r.billAmount), margin: r.billAmount == null ? null : S.money(Number(r.billAmount) - Number(r.costAmount || 0)), batchId: r.batchId || null };
}

async function rowsFor(ids, { status = null, from = null, to = null } = {}) {
  if (!ids.length) return [];
  let sql = S.inList('SELECT * FROM "StfTimesheet" WHERE "applicationId" IN (?)', ids);
  const args = [...ids];
  if (status) { sql += ' AND "status" = ?'; args.push(status); }
  if (from) { sql += ' AND "weekStart" >= ?'; args.push(S.mondayOf(from)); }
  if (to) { sql += ' AND "weekStart" <= ?'; args.push(to); }
  return S.q(`${sql} ORDER BY "weekStart" DESC, "updatedAt" DESC LIMIT 3000`, ...args);
}

// the list for any audience (scope is the contractor list of that login)
async function list(user, { status = null, applicationId = null, from = null, to = null, clientId = null } = {}) {
  const cs = await K.list(user, { applicationId, clientId });
  const C = new Map(cs.map((c) => [c.applicationId, c]));
  const rows = await rowsFor(cs.map((c) => c.applicationId), { status, from, to });
  return { rows: rows.map((r) => shape(r, user, C.get(r.applicationId))), contractors: cs.length };
}

// the weeks of one contractor: the last `weeks` weeks (with no row = "Not started")
async function weeksOf(user, applicationId, { weeks = 8 } = {}) {
  const c = await K.one(user, applicationId);
  if (!c) return { error: 'Contractor not found (or not in your scope).', status: 404 };
  const rows = await rowsFor([applicationId]);
  const M = new Map(rows.map((r) => [r.weekStart, r]));
  const thisWeek = S.mondayOf(new Date().toISOString().slice(0, 10));
  const out = [];
  for (let i = 0; i < Math.min(26, Math.max(1, weeks)); i += 1) {
    const w = S.addDays(thisWeek, -7 * i);
    if (c.startOn && S.addDays(w, 6) < c.startOn) break;
    const r = M.get(w);
    out.push(r ? shape(r, user, null) : { weekStart: w, weekEnd: S.addDays(w, 6), status: 'Not started', hours: [0, 0, 0, 0, 0, 0, 0], totalHours: 0 });
  }
  return { contractor: c, weeks: out };
}

async function contractorFor(user, applicationId) {
  const c = await K.one(user, applicationId);
  if (!c) return { error: 'Contractor not found (or not in your scope).', status: 404 };
  if (c.status === 'Ended') return { error: 'This contract has ended: no more timesheets.', status: 409 };
  return { c };
}
function checkWeek(c, weekStart) {
  if (!S.isDate(weekStart) || S.mondayOf(weekStart) !== weekStart) return 'Pick the week by its Monday (YYYY-MM-DD).';
  const thisWeek = S.mondayOf(new Date().toISOString().slice(0, 10));
  if (weekStart > thisWeek) return 'A week that has not started cannot have a timesheet yet.';
  if (c.startOn && S.addDays(weekStart, 6) < c.startOn) return `The contract starts on ${c.startOn}.`;
  if (c.endOn && weekStart > c.endOn) return `The contract ended on ${c.endOn}.`;
  return null;
}
function checkHours(c, hours, weekStart) {
  if (!Array.isArray(hours) || hours.length !== 7) return 'Give the hours of the seven days, Monday first.';
  for (let i = 0; i < 7; i += 1) {
    const v = Number(hours[i]);
    if (!Number.isFinite(v) || v < 0 || v > 24) return 'Each day is 0 to 24 hours.';
    const day = S.addDays(weekStart, i);
    if (v > 0 && ((c.startOn && day < c.startOn) || (c.endOn && day > c.endOn))) return `${day} is outside the contract (${c.startOn || '?'} to ${c.endOn || 'open'}).`;
  }
  return null;
}

// save (Draft) and optionally submit. user: the contractor's candidate login or a staff login (recruiter / TL / Admin).
async function save(user, applicationId, { weekStart, hours, note, submit = false } = {}) {
  const role = roleOf(user);
  if (role === 'client') return { error: 'The client approves timesheets; it does not fill them in.', status: 403 };
  if (role === 'bde') return { error: 'The BDE team does not fill in timesheets.', status: 403 };
  const { c, error, status } = await contractorFor(user, applicationId);
  if (error) return { error, status };
  const wErr = checkWeek(c, weekStart);
  if (wErr) return { error: wErr };
  const hErr = checkHours(c, hours, weekStart);
  if (hErr) return { error: hErr };
  const before = (await S.q('SELECT * FROM "StfTimesheet" WHERE "applicationId" = ? AND "weekStart" = ?', applicationId, weekStart))[0] || null;
  if (before && !['Draft', 'Rejected'].includes(before.status)) return { error: `This week is ${before.status.toLowerCase()} and can no longer be changed.`, status: 409 };
  const m = K.calc(null, hours, c.weeklyHours);
  if (submit && m.total <= 0 && !S.clean(note, 500)) return { error: 'No hours this week? Say why in the note (leave, client holiday ...).' };
  const kind = kindOf(user);
  const id = before ? before.id : S.newId();
  const st = submit ? 'Submitted' : 'Draft';
  await S.x(`INSERT INTO "StfTimesheet" ("id","applicationId","clientId","weekStart","hours","note","status","totalHours","regHours","otHours","daysWorked",
    "submittedByKind","submittedById","submittedByName","submittedAt","rejectReason","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("applicationId","weekStart") DO UPDATE SET "hours"=excluded."hours","note"=excluded."note","status"=excluded."status","totalHours"=excluded."totalHours",
    "regHours"=excluded."regHours","otHours"=excluded."otHours","daysWorked"=excluded."daysWorked","submittedByKind"=excluded."submittedByKind","submittedById"=excluded."submittedById",
    "submittedByName"=excluded."submittedByName","submittedAt"=excluded."submittedAt","updatedAt"=excluded."updatedAt"`,
  id, applicationId, c.clientId, weekStart, JSON.stringify(m.hours), S.clean(note, 500), st, m.total, m.reg, m.ot, m.days,
  kind, user.id, user.name, submit ? S.now() : null, null, S.now(), S.now());
  if (submit) {
    await require('../audit').logAudit({ userId: user.id, action: 'Timesheet submitted', entity: 'Application', entityId: applicationId, toValue: `week of ${weekStart}: ${m.total} h (${kind})` }); // eslint-disable-line global-require
    await tellApprovers(c, weekStart, m.total).catch(() => {});
  }
  const row = (await S.q('SELECT * FROM "StfTimesheet" WHERE "id" = ?', id))[0];
  return { ok: true, timesheet: shape(row, user, null) };
}

// a submitted week goes back to Draft (only the side that sent it, before anyone decided)
async function recall(user, id) {
  const r = (await S.q('SELECT * FROM "StfTimesheet" WHERE "id" = ?', String(id || '')))[0];
  if (!r) return { error: 'Timesheet not found.', status: 404 };
  if (!(await K.one(user, r.applicationId))) return { error: 'Timesheet not found (or not in your scope).', status: 404 };
  if (r.status !== 'Submitted') return { error: 'Only a submitted week can be taken back.', status: 409 };
  if (roleOf(user) === 'client') return { error: 'The client approves or rejects.', status: 403 };
  await S.x('UPDATE "StfTimesheet" SET "status"=\'Draft\',"submittedAt"=NULL,"updatedAt"=? WHERE "id"=?', S.now(), r.id);
  return { ok: true };
}

// approve / reject. user: a client login of that company, or a TeamLink lead (approval.mode decides).
async function decide(user, id, { approve, reason } = {}) {
  const r = (await S.q('SELECT * FROM "StfTimesheet" WHERE "id" = ?', String(id || '')))[0];
  if (!r) return { error: 'Timesheet not found.', status: 404 };
  const c = await K.one(user, r.applicationId);
  if (!c) return { error: 'Timesheet not found (or not in your scope).', status: 404 };
  const role = roleOf(user);
  const mode = await S.setting('approval.mode');
  if (role === 'client') {
    if (c.clientId !== user.clientId) return { error: 'Timesheet not found.', status: 404 };
    if (mode === 'tl') return { error: 'TeamLink approves these timesheets for your company.', status: 403 };
    const CT = require('../clientPortalTypes'); // eslint-disable-line global-require
    if (!CT.hasCap(user, 'DECIDE') && !CT.hasCap(user, 'INVOICES')) return { error: 'Your login can look at timesheets but not approve them. Ask your TeamLink contact.', status: 403 };
  } else {
    if (role === 'mgmt') return { error: 'Your ATS login is view only: you can look, not change.', status: 403 };
    if (!isLeadRole(user)) return { error: 'A team lead, the client or an Admin approves timesheets.', status: 403 };
    if (mode === 'client' && role !== 'admin') return { error: 'The client approves these timesheets (Admin setting).', status: 403 };
  }
  if (r.status !== 'Submitted') return { error: `This week is ${String(r.status).toLowerCase()}, not waiting for approval.`, status: 409 };
  if (r.submittedById && r.submittedById === user.id) return { error: 'You entered this timesheet, so someone else must approve it.', status: 403 };
  const kind = role === 'client' ? 'Client' : 'TeamLink';
  if (!approve) {
    const why = S.clean(reason, 300);
    if (!why) return { error: 'Say what is wrong, so the contractor can fix it.' };
    await S.x('UPDATE "StfTimesheet" SET "status"=\'Rejected\',"decidedByKind"=?,"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"rejectReason"=?,"updatedAt"=? WHERE "id"=?', kind, user.id, user.name, S.now(), why, S.now(), r.id);
    await require('../audit').logAudit({ userId: user.id, action: 'Timesheet rejected', entity: 'Application', entityId: r.applicationId, toValue: `week of ${r.weekStart}`, reason: why }); // eslint-disable-line global-require
    return { ok: true, status: 'Rejected' };
  }
  const rates = (await K.rateRows([r.applicationId])).get(r.applicationId) || [];
  const rate = K.rateFor(rates, r.weekStart);
  const m = K.calc(rate, S.parse(r.hours, []), c.weeklyHours);
  await S.x('UPDATE "StfTimesheet" SET "status"=\'Approved\',"decidedByKind"=?,"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"rejectReason"=NULL,"rateId"=?,"payAmount"=?,"costAmount"=?,"billAmount"=?,"regHours"=?,"otHours"=?,"updatedAt"=? WHERE "id"=?',
    kind, user.id, user.name, S.now(), rate ? rate.id : null, m.pay, m.cost, m.bill, m.reg, m.ot, S.now(), r.id);
  await require('../audit').logAudit({ userId: user.id, action: 'Timesheet approved', entity: 'Application', entityId: r.applicationId, toValue: `week of ${r.weekStart}: ${m.total} h by ${kind}${rate ? '' : ' (no rate yet)'}` }); // eslint-disable-line global-require
  return { ok: true, status: 'Approved', noRate: !rate };
}

async function reopen(user, id, reason) {
  if (roleOf(user) !== 'admin') return { error: 'Only a Super Admin or an Admin reopens an approved week.', status: 403 };
  const r = (await S.q('SELECT * FROM "StfTimesheet" WHERE "id" = ?', String(id || '')))[0];
  if (!r) return { error: 'Timesheet not found.', status: 404 };
  if (r.status !== 'Approved') return { error: 'Only an approved week is reopened.', status: 409 };
  if (r.batchId) return { error: 'This week is in a billing batch. Cancel the batch first.', status: 409 };
  const why = S.clean(reason, 300);
  if (!why) return { error: 'Say why the week is reopened.' };
  await S.x('UPDATE "StfTimesheet" SET "status"=\'Draft\',"payAmount"=NULL,"costAmount"=NULL,"billAmount"=NULL,"rateId"=NULL,"decidedByName"=NULL,"decidedAt"=NULL,"submittedAt"=NULL,"updatedAt"=? WHERE "id"=?', S.now(), r.id);
  await require('../audit').logAudit({ userId: user.id, action: 'Timesheet reopened', entity: 'Application', entityId: r.applicationId, toValue: `week of ${r.weekStart}`, reason: why }); // eslint-disable-line global-require
  return { ok: true };
}

// the hours of a week taken from the booked shifts (a starting point for the timesheet)
async function fromShifts(user, applicationId, weekStart) {
  const c = await K.one(user, applicationId);
  if (!c) return { error: 'Contractor not found (or not in your scope).', status: 404 };
  if (!S.isDate(weekStart)) return { error: 'Pick the week.' };
  const rows = await S.q('SELECT * FROM "StfShift" WHERE "applicationId" = ? AND "day" >= ? AND "day" <= ? AND "status" IN (\'Booked\',\'Done\')', applicationId, weekStart, S.addDays(weekStart, 6));
  const hours = [0, 0, 0, 0, 0, 0, 0];
  rows.forEach((s) => { const i = Math.round((Date.parse(`${s.day}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 864e5); if (i >= 0 && i < 7) hours[i] = S.money(hours[i] + require('./shifts').lengthOf(s)); }); // eslint-disable-line global-require
  return { hours, shifts: rows.length };
}

// ---- who is told -----------------------------------------------------------------------------------------------------------
// The approvers get a bell in TeamLink when a week is submitted (in-app only, never an outside message): the client logins of the
// company that may approve, or the team lead of the job.
async function tellApprovers(c, weekStart, total) {
  if (!(await S.setting('timesheets.notifyApprovers'))) return;
  const mode = await S.setting('approval.mode');
  const { notifyUsers } = require('../notify'); // eslint-disable-line global-require
  const ids = [];
  if (mode !== 'tl') {
    const cl = await prisma.user.findMany({ where: { clientId: c.clientId, status: 'Active', OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] }, select: { id: true, role: true, atsRole: true, clientId: true, portalPerms: true, portalType: true } });
    const CT = require('../clientPortalTypes'); // eslint-disable-line global-require
    cl.filter((u) => CT.hasCap(u, 'DECIDE') || CT.hasCap(u, 'INVOICES')).forEach((u) => ids.push(u.id));
  }
  if (mode !== 'client') {
    const req = await prisma.requirement.findUnique({ where: { id: c.requirementId }, select: { tlId: true } });
    if (req && req.tlId) ids.push(req.tlId);
  }
  if (ids.length) await notifyUsers(ids, { title: 'Timesheet waiting for approval', message: `${c.name} sent the timesheet for the week of ${weekStart} (${total} hours). Open: ${mode === 'tl' ? '/ats/contract-staff?tab=timesheets' : '/client-portal'}` });
}

// ---- reminders (OFF by default) -------------------------------------------------------------------------------------------------
// Active contractors with no submitted / approved week for LAST week.
async function missing(user) {
  const lastWeek = S.addDays(S.mondayOf(new Date().toISOString().slice(0, 10)), -7);
  const cs = (await K.list(user)).filter((c) => !c.ended && (!c.startOn || c.startOn <= S.addDays(lastWeek, 6)));
  const rows = await rowsFor(cs.map((c) => c.applicationId), { from: lastWeek, to: lastWeek });
  const done = new Set(rows.filter((r) => ['Submitted', 'Approved'].includes(r.status)).map((r) => r.applicationId));
  return { weekStart: lastWeek, rows: cs.filter((c) => !done.has(c.applicationId)).map((c) => ({ applicationId: c.applicationId, candidateId: c.candidateId, name: c.name, client: c.client, ownerRecruiterId: c.ownerRecruiterId })) };
}
async function sendReminders(user, { force = false } = {}) {
  if (!(await S.setting('timesheets.reminders'))) return { error: 'Timesheet reminders are switched off (Contract staff > Settings).', status: 409, sent: 0 };
  const m = await missing(user);
  const key = `reminders.sent.${m.weekStart}`;
  if (!force && (await S.setting(key))) return { ok: true, sent: 0, already: true, weekStart: m.weekStart };
  const { notifyUsers } = require('../notify'); // eslint-disable-line global-require
  let sent = 0;
  for (const r of m.rows) {
    // eslint-disable-next-line no-await-in-loop
    const logins = await prisma.user.findMany({ where: { candidateId: r.candidateId, status: 'Active' }, select: { id: true } });
    const ids = [...logins.map((l) => l.id), r.ownerRecruiterId].filter(Boolean);
    if (!ids.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(ids, { title: 'Timesheet missing', message: `The timesheet of ${r.name} for the week of ${m.weekStart} is not in yet. Please fill it in and send it.` });
    sent += 1;
  }
  await S.saveSetting(key, '1', user);
  return { ok: true, sent, weekStart: m.weekStart, missing: m.rows.length };
}

module.exports = { shape, list, weeksOf, save, recall, decide, reopen, fromShifts, missing, sendReminders, rowsFor };
