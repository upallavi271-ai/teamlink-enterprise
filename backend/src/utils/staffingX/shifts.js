// ---------------------------------------------------------------------------
// SHIFT SCHEDULING FOR PLACED TEMP STAFF (11.17).
// A shift is a day, a start and an end time (an end before the start runs past midnight) at a client, for a role / place.
//   Open      nobody yet: "Fill" suggests the client's contractors who are free
//   Booked    a contractor is on it            Done   worked            Cancelled   kept for the record
// Conflicts are checked on every booking:
//   STOP  the person already has a shift that overlaps; the day is outside their contract; the contract has ended
//   WARN  less than 8 hours of rest between two shifts; more than 60 hours booked in that week
// Telling the contractor (a bell in their portal + their recruiter) is OFF until an Admin switches it on (shifts.notify).
// ---------------------------------------------------------------------------
const S = require('./store');
const K = require('./contracts');

const STATES = ['Open', 'Booked', 'Done', 'Cancelled'];
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
// [start, end] in minutes from the epoch day, so shifts on different days compare
function span(s) {
  const base = Math.round(Date.parse(`${s.day}T00:00:00Z`) / 60000);
  const a = base + mins(s.start);
  let b = base + mins(s.end);
  if (b <= a) b += 24 * 60; // past midnight
  return [a, b];
}
const lengthOf = (s) => { const [a, b] = span(s); return S.money((b - a) / 60); };

function conflictsOf(shift, others, contractor) {
  const stop = []; const warn = [];
  if (contractor) {
    if (contractor.ended) stop.push(`${contractor.name}'s contract has ended.`);
    if (contractor.startOn && shift.day < contractor.startOn) stop.push(`${contractor.name}'s contract starts on ${contractor.startOn}.`);
    if (contractor.endOn && shift.day > contractor.endOn) stop.push(`${contractor.name}'s contract ends on ${contractor.endOn}.`);
  }
  const [a, b] = span(shift);
  let weekMins = b - a;
  const wk = S.mondayOf(shift.day);
  others.filter((o) => o.id !== shift.id && ['Booked', 'Done'].includes(o.status)).forEach((o) => {
    const [c, d] = span(o);
    if (c < b && a < d) stop.push(`Overlaps the shift on ${o.day} ${o.start}-${o.end}.`);
    else if ((c >= b && c - b < 480) || (a >= d && a - d < 480)) warn.push(`Less than 8 hours of rest next to the shift on ${o.day} ${o.start}-${o.end}.`);
    if (S.mondayOf(o.day) === wk) weekMins += d - c;
  });
  if (weekMins > 60 * 60) warn.push(`${Math.round(weekMins / 60)} hours booked in the week of ${wk} (more than 60).`);
  return { stop, warn };
}

const view = (s, C) => {
  const c = s.applicationId ? C.get(s.applicationId) : null;
  return { id: s.id, applicationId: s.applicationId || null, name: c ? c.name : null, clientId: s.clientId, client: c ? c.client : null, requirementId: s.requirementId || null, day: s.day, start: s.start, end: s.end, hours: lengthOf(s), role: s.role || null, location: s.location || null, status: s.status, note: s.note || null, byName: s.byName || null };
};

// the shifts this login may see: those of its contractors, and the open shifts of their clients (Admin: all)
async function list(user, { from = null, to = null, clientId = null, applicationId = null } = {}) {
  const f = S.isDate(from) ? from : S.mondayOf(new Date().toISOString().slice(0, 10));
  const t = S.isDate(to) ? to : S.addDays(f, 13);
  const cs = await K.list(user, { clientId: clientId || null });
  const C = new Map(cs.map((c) => [c.applicationId, c]));
  const clients = [...new Set(cs.map((c) => c.clientId))];
  const all = K.roleOf(user) === 'admin';
  let rows = await S.q('SELECT * FROM "StfShift" WHERE "day" >= ? AND "day" <= ? ORDER BY "day","start"', f, t);
  rows = rows.filter((s) => (s.applicationId ? C.has(s.applicationId) : (all || clients.includes(s.clientId))) && (!clientId || s.clientId === clientId) && (!applicationId || s.applicationId === applicationId));
  // a contractor's names for Admin rows outside its own list are filled from the rows themselves
  return { from: f, to: t, rows: rows.map((s) => view(s, C)), contractors: cs.filter((c) => !c.ended).map((c) => ({ applicationId: c.applicationId, name: c.name, clientId: c.clientId, client: c.client })) };
}

async function personShifts(applicationId) { return S.q('SELECT * FROM "StfShift" WHERE "applicationId" = ? AND "status" IN (\'Booked\',\'Done\')', applicationId); }

async function notify(user, shift, contractor, what) {
  if (!(await S.setting('shifts.notify')) || !contractor) return false;
  const prisma = require('../../db'); // eslint-disable-line global-require
  const logins = await prisma.user.findMany({ where: { candidateId: contractor.candidateId, status: 'Active' }, select: { id: true } });
  const ids = [...logins.map((l) => l.id), contractor.ownerRecruiterId].filter(Boolean);
  if (!ids.length) return false;
  await require('../notify').notifyUsers(ids, { title: `Shift ${what}`, message: `${contractor.name}: ${shift.day} ${shift.start}-${shift.end}${shift.location ? ` at ${shift.location}` : ''} (${contractor.client}).`, exceptUserId: user.id }); // eslint-disable-line global-require
  await S.x('UPDATE "StfShift" SET "notifiedAt"=? WHERE "id"=?', S.now(), shift.id);
  return true;
}

// create one shift, or the same shift on several days (repeat: number of days, 1-31)
async function create(user, body) {
  const b = body || {};
  if (!S.isDate(b.day)) return { error: 'Pick the day (YYYY-MM-DD).' };
  if (!isTime(b.start) || !isTime(b.end) || b.start === b.end) return { error: 'Give the start and end time (HH:MM). An end before the start runs past midnight.' };
  const cs = await K.list(user);
  let contractor = null; let clientId = S.clean(b.clientId, 60);
  if (b.applicationId) {
    contractor = cs.find((c) => c.applicationId === b.applicationId) || null;
    if (!contractor) return { error: 'Contractor not found (or not in your scope).', status: 404 };
    clientId = contractor.clientId;
  }
  if (!clientId || (!cs.some((c) => c.clientId === clientId) && K.roleOf(user) !== 'admin')) return { error: 'Pick a client that has your contractors.', status: 404 };
  const repeat = Math.max(1, Math.min(31, Number(b.repeat) || 1));
  const made = []; const warnings = [];
  const existing = contractor ? await personShifts(contractor.applicationId) : [];
  for (let i = 0; i < repeat; i += 1) {
    const s = { id: S.newId(), day: S.addDays(b.day, i), start: b.start, end: b.end, status: contractor ? 'Booked' : 'Open' };
    if (contractor) {
      const cf = conflictsOf(s, [...existing, ...made], contractor);
      if (cf.stop.length) return { error: `Not booked: ${cf.stop.join(' ')}`, conflicts: cf, status: 409, made: made.length };
      warnings.push(...cf.warn);
    }
    made.push(s);
  }
  for (const s of made) {
    // eslint-disable-next-line no-await-in-loop
    await S.x('INSERT INTO "StfShift" ("id","applicationId","clientId","requirementId","day","start","end","role","location","status","note","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      s.id, contractor ? contractor.applicationId : null, clientId, contractor ? contractor.requirementId : (S.clean(b.requirementId, 60) || null), s.day, s.start, s.end, S.clean(b.role, 80), S.clean(b.location, 120), s.status, S.clean(b.note, 300), user.name, S.now());
  }
  if (contractor) await notify(user, made[0], contractor, repeat > 1 ? `booked (${repeat} days from ${b.day})` : 'booked');
  await require('../audit').logAudit({ userId: user.id, action: contractor ? 'Shift booked' : 'Open shift added', entity: 'StfShift', entityId: made[0].id, toValue: `${b.day} ${b.start}-${b.end}${repeat > 1 ? ` x${repeat}` : ''}${contractor ? ` · ${contractor.name}` : ''}` }); // eslint-disable-line global-require
  return { ok: true, ids: made.map((s) => s.id), warnings: [...new Set(warnings)] };
}

async function shiftInScope(user, id) {
  const s = (await S.q('SELECT * FROM "StfShift" WHERE "id" = ?', String(id || '')))[0];
  if (!s) return null;
  const all = K.roleOf(user) === 'admin';
  const cs = await K.list(user);
  if (s.applicationId ? !cs.some((c) => c.applicationId === s.applicationId) && !all : !cs.some((c) => c.clientId === s.clientId) && !all) return null;
  return { s, cs };
}

// people who can take an open shift: the client's active contractors without a stop
async function suggestions(user, id) {
  const got = await shiftInScope(user, id);
  if (!got) return { error: 'Shift not found (or not in your scope).', status: 404 };
  const { s, cs } = got;
  const out = [];
  for (const c of cs.filter((x) => x.clientId === s.clientId && !x.ended)) {
    // eslint-disable-next-line no-await-in-loop
    const cf = conflictsOf(s, await personShifts(c.applicationId), c);
    out.push({ applicationId: c.applicationId, name: c.name, free: !cf.stop.length, why: [...cf.stop, ...cf.warn] });
  }
  out.sort((a, b) => Number(b.free) - Number(a.free) || a.why.length - b.why.length);
  return { rows: out };
}

async function update(user, id, body) {
  const got = await shiftInScope(user, id);
  if (!got) return { error: 'Shift not found (or not in your scope).', status: 404 };
  const { s, cs } = got;
  const b = body || {};
  const next = { ...s };
  if (b.status && !STATES.includes(b.status)) return { error: `Status: ${STATES.join(', ')}.` };
  if (b.applicationId !== undefined) {
    if (b.applicationId) {
      const c = cs.find((x) => x.applicationId === b.applicationId && x.clientId === s.clientId);
      if (!c) return { error: 'Pick a contractor of this client.', status: 404 };
      next.applicationId = c.applicationId; next.requirementId = c.requirementId; next.status = 'Booked';
    } else { next.applicationId = null; next.status = 'Open'; }
  }
  if (b.day !== undefined) { if (!S.isDate(b.day)) return { error: 'Pick the day.' }; next.day = b.day; }
  if (b.start !== undefined) { if (!isTime(b.start)) return { error: 'Start time is HH:MM.' }; next.start = b.start; }
  if (b.end !== undefined) { if (!isTime(b.end)) return { error: 'End time is HH:MM.' }; next.end = b.end; }
  if (b.status) next.status = b.status;
  if (b.status === 'Booked' && !next.applicationId) return { error: 'Pick who works the shift first.' };
  let warnings = [];
  const contractor = next.applicationId ? cs.find((x) => x.applicationId === next.applicationId) : null;
  if (contractor && ['Booked', 'Done'].includes(next.status)) {
    const cf = conflictsOf(next, await personShifts(contractor.applicationId), contractor);
    if (cf.stop.length) return { error: `Not saved: ${cf.stop.join(' ')}`, conflicts: cf, status: 409 };
    warnings = cf.warn;
  }
  await S.x('UPDATE "StfShift" SET "applicationId"=?,"requirementId"=?,"day"=?,"start"=?,"end"=?,"status"=?,"role"=?,"location"=?,"note"=? WHERE "id"=?',
    next.applicationId, next.requirementId, next.day, next.start, next.end, next.status,
    b.role !== undefined ? S.clean(b.role, 80) : s.role, b.location !== undefined ? S.clean(b.location, 120) : s.location, b.note !== undefined ? S.clean(b.note, 300) : s.note, s.id);
  const changedPerson = next.applicationId && next.applicationId !== s.applicationId;
  if (contractor && (changedPerson || next.day !== s.day || next.start !== s.start || next.end !== s.end || (next.status === 'Cancelled' && s.status !== 'Cancelled'))) {
    await notify(user, next, contractor, next.status === 'Cancelled' ? 'cancelled' : changedPerson ? 'booked' : 'changed');
  }
  await require('../audit').logAudit({ userId: user.id, action: 'Shift changed', entity: 'StfShift', entityId: s.id, fromValue: `${s.day} ${s.start}-${s.end} ${s.status}`, toValue: `${next.day} ${next.start}-${next.end} ${next.status}${contractor ? ` · ${contractor.name}` : ''}` }); // eslint-disable-line global-require
  return { ok: true, warnings };
}

async function remove(user, id) {
  const got = await shiftInScope(user, id);
  if (!got) return { error: 'Shift not found (or not in your scope).', status: 404 };
  if (got.s.status !== 'Open') return { error: 'Only an open shift is deleted; cancel a booked one instead (it stays on record).', status: 409 };
  await S.x('DELETE FROM "StfShift" WHERE "id" = ?', got.s.id);
  return { ok: true };
}

module.exports = { STATES, span, lengthOf, conflictsOf, list, create, suggestions, update, remove };
