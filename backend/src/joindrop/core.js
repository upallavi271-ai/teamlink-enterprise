// ---------------------------------------------------------------------------
// JOINING & DROP - THE RULES (one place; routes and hooks only call these).
//
//   recordJoined()        a candidate JOINED: one live JoiningRecord per application (never a second), history row, people told.
//                         Called from utils/joining.js onApplicationJoined (every road to "Joined": the Joining checklist, the pipeline move,
//                         the client's own "the candidate joined" in the portal) and by the one-time backfill (no notices).
//   correctJoining()      fix date / place / designation / pay / reporting person (audited; old -> new kept in the history).
//   reportDrop()          a joined candidate left. Client (their own people only), Recruiter / TL / BDE / HR / Admin. Needs the day and a reason.
//                         Also does what the older "Left the job" button did (Application.joiningStatus, Pipeline history, partner payout),
//                         so every old screen keeps telling the truth.
//   decide()              the client's choice: replacement needed / not needed / decide later. Staff may enter it on the client's behalf
//                         (marked "entered by <name> on behalf"). Tells the recruiter, TL, BDE and HR at once; makes the tasks.
//   linkReplacement() / closeReplacement()   the new candidate for the same job; closed when that person joins.
//   reopen()              a drop reported by mistake: back to Joined, with a reason, the same people told. Nothing is ever deleted.
//
// RECRUITER JOININGS ARE NOT TOUCHED. utils/recruiterJoinings.js still counts an application whose step is Joined, by the joining day on the
// application. A drop here leaves the step and the application's joining day exactly as they were (no double count, no silent change to a past
// incentive decision); utils/recruiterJoinings.js only READS this table to add a note, and a drop that follows an incentive decision is flagged
// "dropAfterIncentive" for HR.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./schema');
const V = require('./vocab');
const N = require('./notify');
const SET = require('./settings');
const { logAudit } = require('../utils/audit');

const id = (p) => `${p}${crypto.randomBytes(10).toString('hex')}`;
const JOINED_STAGES = ['JOINED', 'HIRED'];
const sandbox = () => require('../utils/sandbox').isSandbox(); // eslint-disable-line global-require
const isTestPerson = (s) => !sandbox() && /zztest|example\.test/i.test(String(s || ''));

class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

let readyP = null;
let backfillRunning = null;
async function ready() {
  const ok = await S.ensure();
  if (!ok) throw new Bad('Joining records are not available right now. Please try again in a minute.', 503);
  return true;
}

// --- loading ------------------------------------------------------------------------------
const APP_INCLUDE = {
  candidate: { select: { id: true, name: true } },
  requirement: { include: { client: true } },
  followUps: { orderBy: { createdAt: 'asc' } },
  stageEvents: { orderBy: { createdAt: 'asc' } },
};
const loadApp = (appId) => prisma.application.findUnique({ where: { id: appId }, include: APP_INCLUDE });

const isoDay = (v) => (V.isDay(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);
const istDay = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) : null);
// The day this application joined, from what is already on file (the same order the ATS reports use). null = not on file.
function joinDayOf(app) {
  const direct = isoDay(app.joiningDate) || istDay(app.joinedAt);
  if (direct) return direct;
  const ev = [...(app.stageEvents || [])].reverse().find((e) => JOINED_STAGES.includes(e.toStage) && !JOINED_STAGES.includes(e.fromStage));
  return ev ? istDay(ev.createdAt) : null;
}

async function peopleOf(app) {
  try {
    const workers = require('../utils/workers'); // eslint-disable-line global-require
    const dir = await workers.loadDirectory();
    const r = app.requirement || {};
    const at = workers.attribute({
      recruiterId: r.recruiterId, tlId: r.tlId, tl: r.tl, bdeId: r.bdeId, positionCode: r.positionCode,
    }, app.followUps || [], app.stageEvents || [], dir.person);
    return {
      recruiterUserId: at.recruiter ? at.recruiter.userId || null : null,
      recruiterName: at.recruiter ? at.recruiter.label : null,
      tlUserId: at.tl ? at.tl.userId || null : null,
      tlName: at.tl ? at.tl.label : null,
      bdeUserId: at.bde ? at.bde.userId || null : null,
      bdeName: at.bde ? at.bde.label : (r.client && r.client.bdeOwner) || null,
      seat: at.seat || null,
    };
  } catch (e) { console.error('[join-drop] people:', e.message); return {}; } // eslint-disable-line no-console
}

// THE REPLACEMENT (GUARANTEE) PERIOD, decided once per placement and written on the record:
//   1. the client's own period (the structured days on the client: "90 Days", "3 Months") - AGREEMENT
//   2. else the standard days an Admin set in the Joining and drop settings (30 unless changed) - DEFAULT
// Start = the joining day; end = start + days. We keep the start, the end, the days and HOW it was decided; never the agreement's text.
async function guaranteeOf(app, joinedOn) {
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const r = app.requirement || {};
  if (J.isInternalHire(app, r)) return { days: null, startOn: null, endsOn: null, source: null };
  const { guaranteeDaysOf } = require('../utils/workflowFlow'); // eslint-disable-line global-require
  let days = guaranteeDaysOf(r.client && r.client.guaranteePeriod);
  let source = 'AGREEMENT';
  if (days == null) { days = (await SET.get()).defaultGuaranteeDays; source = 'DEFAULT'; }
  return {
    days, startOn: joinedOn || null, endsOn: joinedOn && days > 0 ? V.addDays(joinedOn, days) : null, source,
  };
}

const get = (recordId) => S.one('SELECT * FROM "JoiningRecord" WHERE "id" = ?', recordId);
const byApplication = (appId) => S.one('SELECT * FROM "JoiningRecord" WHERE "applicationId" = ?', appId);

async function addEvent({
  record, kind, actor, from, onBehalf = false, summary, oldValue, newValue, note,
}) {
  const row = {
    id: id('je'), recordId: record.id, applicationId: record.applicationId, candidateId: record.candidateId, at: V.nowIso(), kind,
    byId: actor && actor.id ? actor.id : null, byName: actor ? (actor.name || null) : 'TeamLink',
    byRole: actor ? (actor.atsRole && actor.atsRole !== 'NONE' ? actor.atsRole : actor.role) || null : null,
    fromWhere: from || null, onBehalf: onBehalf ? 1 : 0, summary: V.cleanLong(summary, 500),
    oldValue: oldValue ? JSON.stringify(oldValue).slice(0, 4000) : null, newValue: newValue ? JSON.stringify(newValue).slice(0, 4000) : null,
    note: note ? V.cleanLong(note, 1000) : null,
  };
  await S.run(
    'INSERT INTO "JoiningEvent" ("id","recordId","applicationId","candidateId","at","kind","byId","byName","byRole","fromWhere","onBehalf","summary","oldValue","newValue","note") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.recordId, row.applicationId, row.candidateId, row.at, row.kind, row.byId, row.byName, row.byRole, row.fromWhere, row.onBehalf, row.summary, row.oldValue, row.newValue, row.note,
  );
  return row;
}

async function update(recordId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return get(recordId);
  const sets = keys.map((k) => `"${k}" = ?`).join(', ');
  await S.run(`UPDATE "JoiningRecord" SET ${sets}, "updatedAt" = ? WHERE "id" = ?`, ...keys.map((k) => (patch[k] === undefined ? null : patch[k])), V.nowIso(), recordId);
  return get(recordId);
}

// ===========================================================================================
// JOINED
// ===========================================================================================
// info: { joinedOn, location, designation, employmentType, offeredCtc, reportingPerson, reportingContact, notes } - all optional here;
// a day that is not a real day is ignored (the hook never refuses a joining that already happened).
async function recordJoined({
  applicationId, actor = null, info = {}, via = null, ctx = {}, quiet = false, backfill = false,
}) {
  await ready();
  const app = await loadApp(applicationId);
  if (!app || !JOINED_STAGES.includes(app.stage)) return null;
  if (!backfill && isTestPerson(app.candidate && app.candidate.name)) return null;
  const req = app.requirement || {};
  const client = req.client || {};
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const internal = J.isInternalHire(app, req);
  const people = await peopleOf(app);
  const typed = (v, n = 160) => V.clean(v, n) || null;
  const asDay = (v) => (V.isDay(v) && !require('../utils/joining').dateYearProblem(v) ? v : null); // eslint-disable-line global-require
  const existing = await byApplication(applicationId);

  const fields = (joinedOn, g) => {
    return {
      candidateName: app.candidate ? app.candidate.name : null,
      requirementId: app.requirementId,
      jobTitle: req.title || null,
      jobCode: req.reqCode || null,
      clientId: internal ? null : (req.clientId || null),
      clientName: internal ? 'TeamLink Internal' : (client.name || null),
      department: req.department || null,
      hiringType: J.hiringTypeOf(app, req),
      guaranteeDays: g.days,
      guaranteeStartOn: g.startOn,
      guaranteeEndsOn: g.endsOn,
      guaranteeSource: g.source,
    };
  };

  if (!existing) {
    const joinedOn = asDay(info.joinedOn) || joinDayOf(app) || (backfill ? null : V.todayIst());
    // A new joining: the place defaults from the job, then the client (editable). A backfill never invents a place.
    const location = backfill ? typed(info.location, 120) : (typed(info.location, 120) || typed(req.location, 120) || typed(client.location, 120));
    const f = fields(joinedOn, await guaranteeOf(app, joinedOn));
    const now = V.nowIso();
    const rec = {
      id: id('jr'), applicationId, candidateId: app.candidateId, ...f, status: 'Joined', joinedOn, location,
      designation: typed(info.designation, 120) || req.title || null,
      offeredCtc: Number(info.offeredCtc) > 0 ? Number(info.offeredCtc) : (Number(app.offeredCtc) > 0 ? Number(app.offeredCtc) : null),
      employmentType: typed(info.employmentType, 60) || req.employmentType || null,
      reportingPerson: typed(info.reportingPerson, 120), reportingContact: typed(info.reportingContact, 160),
      ...people,
      notes: info.notes ? V.cleanLong(info.notes, 1500) : null,
      recordedById: actor && actor.id ? actor.id : null,
      recordedByName: backfill ? 'Copied from the existing records' : (actor ? actor.name : 'TeamLink'),
      recordedByRole: backfill ? null : (actor ? (actor.atsRole && actor.atsRole !== 'NONE' ? actor.atsRole : actor.role) : null),
      recordedVia: via || (backfill ? 'Backfill' : 'Joined step'),
      backfilled: backfill ? 1 : 0,
      createdAt: now, updatedAt: now,
    };
    const cols = Object.keys(rec);
    const n = await S.run(`INSERT OR IGNORE INTO "JoiningRecord" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => (rec[c] === undefined ? null : rec[c])));
    if (!Number(n)) return { record: await byApplication(applicationId), created: false };
    const record = await get(rec.id);
    const ev = await addEvent({
      record, kind: V.KINDS.JOINED === 'Joined' ? 'JOINED' : 'JOINED', actor: backfill ? null : actor, from: backfill ? 'Backfill' : (via || null),
      summary: backfill
        ? `Copied from the existing records${joinedOn ? `: joined on ${V.dmy(joinedOn)}` : ' (the joining day was not recorded)'}${location ? '' : '. Place not recorded.'}`
        : `Joined on ${V.dmy(joinedOn)} at ${location || 'a place not recorded yet'}`,
      newValue: { joinedOn, location, designation: rec.designation },
    });
    await closeReplacementIfLinked(applicationId, actor, ctx);
    let told = null;
    if (!quiet && !backfill) {
      told = await N.tell({ moment: 'join', record, ev, ctx });
      await audit(actor, 'Joining recorded', record, `Joined on ${V.dmy(joinedOn)}`);
    }
    return { record, event: ev, created: true, told };
  }

  // A record already exists.
  if (existing.status === 'Joined') {
    // Fill what is still empty (never overwrite what a person typed).
    const patch = {};
    const given = {
      location: typed(info.location, 120), designation: typed(info.designation, 120), employmentType: typed(info.employmentType, 60),
      reportingPerson: typed(info.reportingPerson, 120), reportingContact: typed(info.reportingContact, 160),
      offeredCtc: Number(info.offeredCtc) > 0 ? Number(info.offeredCtc) : null,
    };
    Object.entries(given).forEach(([k, v]) => { if (v != null && (existing[k] == null || existing[k] === '')) patch[k] = v; });
    const day = asDay(info.joinedOn);
    if (day && !existing.joinedOn) { patch.joinedOn = day; const g = await guaranteeOf(app, day); Object.assign(patch, { guaranteeDays: g.days, guaranteeStartOn: g.startOn, guaranteeEndsOn: g.endsOn, guaranteeSource: g.source }); }
    if (!Object.keys(patch).length) return { record: existing, created: false };
    const record = await update(existing.id, patch);
    const ev = await addEvent({ record, kind: 'DETAILS_ADDED', actor, from: via || null, summary: `Joining details added: ${Object.keys(patch).join(', ')}`, newValue: patch });
    return { record, event: ev, created: false };
  }
  // Dropped before and now Joined again: the drop is kept in the history, the record is live again.
  const oldDrop = dropSnapshot(existing);
  const day = asDay(info.joinedOn) || joinDayOf(app) || existing.joinedOn || V.todayIst();
  const g = await guaranteeOf(app, day);
  const record = await update(existing.id, {
    status: 'Joined', joinedOn: day, guaranteeDays: g.days, guaranteeStartOn: g.startOn, guaranteeEndsOn: g.endsOn, guaranteeSource: g.source, ...clearDrop(),
  });
  const ev = await addEvent({
    record, kind: 'REJOINED', actor, from: via || null, summary: `Joined again on ${V.dmy(day)} (the earlier drop is kept in the history)`, oldValue: oldDrop, newValue: { joinedOn: day },
  });
  let told = null;
  if (!quiet) told = await N.tell({ moment: 'join', record, ev, ctx });
  return { record, event: ev, created: false, told };
}

function dropSnapshot(r) {
  return {
    droppedOn: r.droppedOn, lastWorkingDay: r.lastWorkingDay, dropReason: r.dropReason, dropReasonDetail: r.dropReasonDetail,
    dropReportedByName: r.dropReportedByName, dropReportedFrom: r.dropReportedFrom, dropWithinGuarantee: r.dropWithinGuarantee,
    replacementDecision: r.replacementDecision, replacementComment: r.replacementComment, replacementExpectedOn: r.replacementExpectedOn,
    replacementStatus: r.replacementStatus, replacementApplicationId: r.replacementApplicationId,
  };
}
const clearDrop = () => ({
  droppedOn: null, lastWorkingDay: null, dropReason: null, dropReasonDetail: null, dropReportedById: null, dropReportedByName: null, dropReportedByRole: null,
  dropReportedFrom: null, dropReportedAt: null, dropWithinGuarantee: null, dropDaysSinceJoining: null, dropAfterIncentive: 0,
  replacementDecision: null, replacementComment: null, replacementExpectedOn: null, replacementProfileNotes: null, replacementDecidedAt: null,
  replacementDecidedById: null, replacementDecidedByName: null, replacementOnBehalf: 0, replacementStatus: null, replacementApplicationId: null, replacementLinkedAt: null,
});

async function audit(actor, action, record, to, reason) {
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor ? undefined : 'TeamLink', action, entity: 'JoiningRecord', entityId: record.id,
    toValue: String(to || '').slice(0, 300), reason: reason ? String(reason).slice(0, 500) : undefined,
  });
}

// ===========================================================================================
// CORRECT THE JOINING DETAILS
// ===========================================================================================
const EDITABLE = {
  joinedOn: 'Joined on', location: 'Place', designation: 'Designation', employmentType: 'Employment type', offeredCtc: 'Pay (CTC)',
  reportingPerson: 'Reporting person', reportingContact: 'Reporting contact', notes: 'Notes',
};
async function correctJoining(recordId, patch, actor, { from = null, reason = null } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const next = {};
  const p = patch || {};
  if (p.joinedOn !== undefined) {
    if (!V.isDay(p.joinedOn)) throw new Bad('Enter the day the candidate joined.');
    const yr = J.dateYearProblem(p.joinedOn, 'joining day');
    if (yr) throw new Bad(yr);
    if (p.joinedOn > V.todayIst()) throw new Bad('The joining day cannot be a day that has not come yet.');
    if (rec.status === 'Dropped' && rec.droppedOn && p.joinedOn > rec.droppedOn) throw new Bad('The joining day cannot be after the day the candidate dropped.');
    next.joinedOn = p.joinedOn;
  }
  const text = (k, n) => { if (p[k] !== undefined) next[k] = V.clean(p[k], n) || null; };
  text('location', 120); text('designation', 120); text('employmentType', 60); text('reportingPerson', 120); text('reportingContact', 160);
  if (p.notes !== undefined) next.notes = V.cleanLong(p.notes, 1500) || null;
  if (p.offeredCtc !== undefined) {
    if (p.offeredCtc === '' || p.offeredCtc === null) next.offeredCtc = null;
    else if (!(Number(p.offeredCtc) > 0) || Number(p.offeredCtc) > 1e9) throw new Bad('The pay must be a number, for example 480000.');
    else next.offeredCtc = Number(p.offeredCtc);
  }
  if ('location' in next && !next.location) throw new Bad('The place cannot be left empty. Type the city or branch where the candidate joined.');
  const changed = Object.keys(next).filter((k) => String(next[k] == null ? '' : next[k]) !== String(rec[k] == null ? '' : rec[k]));
  if (!changed.length) throw new Bad('Nothing was changed.', 409);
  // A value that was already recorded and is now changed needs a reason (the history says why).
  const overwritten = changed.filter((k) => rec[k] != null && rec[k] !== '');
  if (overwritten.length && V.clean(reason, 300).length < 3) throw new Bad('Say in a few words why you are changing it (it is kept in the history).');
  const full = { ...next };
  if (changed.includes('joinedOn')) {
    const app = await loadApp(rec.applicationId);
    // Same source as before: only the dates move with the joining day.
    const days = rec.guaranteeDays;
    const g = app && !rec.guaranteeSource ? await guaranteeOf(app, next.joinedOn) : { days, startOn: next.joinedOn, endsOn: days > 0 ? V.addDays(next.joinedOn, days) : null, source: rec.guaranteeSource };
    full.guaranteeDays = g.days; full.guaranteeStartOn = g.startOn; full.guaranteeEndsOn = g.endsOn; full.guaranteeSource = g.source;
    if (rec.status === 'Dropped' && rec.droppedOn) {
      full.dropDaysSinceJoining = V.daysBetween(next.joinedOn, rec.droppedOn);
      full.dropWithinGuarantee = g.endsOn ? (rec.droppedOn <= g.endsOn ? 1 : 0) : null;
    }
  }
  const was = {}; const now = {};
  changed.forEach((k) => { was[k] = rec[k]; now[k] = next[k]; });
  const record = await update(recordId, full);
  const blankBefore = overwritten.length === 0;
  const ev = await addEvent({
    record, kind: blankBefore ? 'DETAILS_ADDED' : 'JOINING_CORRECTED', actor, from,
    summary: `${blankBefore ? 'Joining details added' : 'Joining details corrected'}: ${changed.map((k) => `${EDITABLE[k]}: ${was[k] == null || was[k] === '' ? 'Not recorded' : (k === 'joinedOn' ? V.dmy(was[k]) : was[k])} -> ${k === 'joinedOn' ? V.dmy(now[k]) : (now[k] == null ? 'Not recorded' : now[k])}`).join('; ')}`,
    oldValue: was, newValue: now, note: reason,
  });
  await audit(actor, 'Joining details corrected', record, changed.join(', '), reason);
  return { record, event: ev };
}

// ===========================================================================================
// DROP
// ===========================================================================================
function checkDropInput(rec, b, { editing = false } = {}) {
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const out = {};
  const today = V.todayIst();
  if (!V.isDay(b.droppedOn)) throw new Bad('Enter the day the candidate dropped.');
  const yr = J.dateYearProblem(b.droppedOn, 'drop day');
  if (yr) throw new Bad(yr);
  if (b.droppedOn > today) throw new Bad('The drop day cannot be a day that has not come yet.');
  if (rec.joinedOn && b.droppedOn < rec.joinedOn) throw new Bad(`The drop day cannot be before the joining day (${V.dmy(rec.joinedOn)}).`);
  out.droppedOn = b.droppedOn;
  if (b.lastWorkingDay !== undefined && b.lastWorkingDay !== null && b.lastWorkingDay !== '') {
    if (!V.isDay(b.lastWorkingDay)) throw new Bad('The last working day is not a date.');
    if (rec.joinedOn && b.lastWorkingDay < rec.joinedOn) throw new Bad(`The last working day cannot be before the joining day (${V.dmy(rec.joinedOn)}).`);
    if (b.lastWorkingDay > today) throw new Bad('The last working day cannot be a day that has not come yet.');
    out.lastWorkingDay = b.lastWorkingDay;
  } else out.lastWorkingDay = null;
  const reason = V.reasonOf(b.reason);
  if (!reason) throw new Bad('Choose why the candidate dropped, or type your own reason.');
  const detail = V.cleanLong(b.reasonDetail !== undefined ? b.reasonDetail : b.details, 1000) || null;
  if (reason === V.OTHER_REASON && !detail) throw new Bad('You chose "Other". Please type the reason in the details box.');
  out.dropReason = reason; out.dropReasonDetail = detail;
  void editing;
  return out;
}

function guaranteeFlags(rec, droppedOn) {
  const days = rec.joinedOn ? V.daysBetween(rec.joinedOn, droppedOn) : null;
  const within = rec.guaranteeEndsOn ? (droppedOn <= rec.guaranteeEndsOn ? 1 : 0) : (rec.guaranteeDays === 0 ? 0 : null);
  return { dropDaysSinceJoining: days, dropWithinGuarantee: within };
}

async function afterIncentive(rec) {
  try {
    if (!rec.recruiterUserId || !rec.joinedOn) return 0;
    const emp = await prisma.employee.findFirst({ where: { userId: rec.recruiterUserId }, select: { id: true } });
    if (!emp) return 0;
    const d = await prisma.recruiterJoiningDecision.findFirst({ where: { employeeId: emp.id, month: rec.joinedOn.slice(0, 7), decision: 'INCENTIVE' }, select: { id: true } });
    return d ? 1 : 0;
  } catch { return 0; }
}

// The older "Left the job" behaviour, kept so every old screen (Replacement due, guarantee running, partner payout) agrees with this one.
async function legacyLeft({ app, rec, droppedOn, reason, actor, within, from }) {
  try {
    if (!app) return;
    const J = require('../utils/joining'); // eslint-disable-line global-require
    if (J.isInternalHire(app, app.requirement)) return;
    const V2 = require('../utils/atsVocab'); // eslint-disable-line global-require
    const LEFT = [V2.JOINING_REPLACEMENT_DUE, V2.JOINING_REPLACED, V2.JOINING_LEFT_AFTER_GUARANTEE];
    if (LEFT.includes(app.joiningStatus)) return;
    const inside = within === 1;
    const status = inside ? V2.JOINING_REPLACEMENT_DUE : V2.JOINING_LEFT_AFTER_GUARANTEE;
    await prisma.application.update({ where: { id: app.id }, data: { joiningStatus: status } });
    const r = app.requirement || {};
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage: app.stage,
        action: inside
          ? `Left within the guarantee (${(r.client && r.client.guaranteePeriod) || 'period'}${rec.guaranteeEndsOn ? `, to ${rec.guaranteeEndsOn}` : ''}): replacement due`
          : `Left after the guarantee${rec.guaranteeEndsOn ? ` (ended ${rec.guaranteeEndsOn})` : ''}: no replacement owed`,
        comment: `Left on ${droppedOn}: ${reason}`.slice(0, 2000),
        actorUserId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'TeamLink', actorRole: actor ? (actor.atsRole || actor.role) : null,
        actorSide: from === 'Client login' ? 'Client' : 'Internal',
        requirementId: app.requirementId, requirementTitle: r.title || null, clientId: r.clientId || null, clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      },
    });
    try {
      const PT = require('../utils/partners'); // eslint-disable-line global-require
      await PT.onLeft({ applicationId: app.id, inside, leftOn: droppedOn, reason, user: actor });
      await PT.syncSubmission(app.id, { userId: actor && actor.id ? actor.id : null, note: `Left on ${droppedOn}: ${reason}` });
    } catch { /* partners are optional */ }
  } catch (e) { console.error('[join-drop] legacy left:', e.message); } // eslint-disable-line no-console
}

async function reportDrop(recordId, body, actor, { from, ctx = {} } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.hiringType === 'TeamLink Internal Hire') throw new Bad('An internal hire who leaves is an HRMS exit (resignation), not a client drop. Use the exit steps in HRMS.', 409);
  if (rec.status === 'Dropped') throw new Bad('A drop is already recorded for this candidate. Use "Correct the drop details" to change it.', 409);
  const b = body || {};
  const f = checkDropInput(rec, b);
  const flags = guaranteeFlags(rec, f.droppedOn);
  const app = await loadApp(rec.applicationId);
  const incentive = await afterIncentive(rec);
  const patch = {
    status: 'Dropped', ...f, ...flags, dropAfterIncentive: incentive,
    dropReportedById: actor && actor.id ? actor.id : null, dropReportedByName: actor ? actor.name : 'TeamLink',
    dropReportedByRole: actor ? (actor.atsRole && actor.atsRole !== 'NONE' ? actor.atsRole : actor.role) || null : null,
    dropReportedFrom: from || null, dropReportedAt: V.nowIso(),
    replacementDecision: null, replacementComment: null, replacementExpectedOn: null, replacementProfileNotes: null, replacementDecidedAt: null,
    replacementDecidedById: null, replacementDecidedByName: null, replacementOnBehalf: 0, replacementStatus: null, replacementApplicationId: null, replacementLinkedAt: null,
  };
  const record = await update(recordId, patch);
  const ev = await addEvent({
    record, kind: 'DROP_REPORTED', actor, from,
    summary: `Drop reported: dropped on ${V.dmy(f.droppedOn)}. Reason: ${f.dropReason}${f.dropReasonDetail ? ` (${f.dropReasonDetail.slice(0, 120)})` : ''}. ${N.withinWords(record)}.`,
    newValue: { droppedOn: f.droppedOn, lastWorkingDay: f.lastWorkingDay, reason: f.dropReason, withinGuarantee: flags.dropWithinGuarantee, daysSinceJoining: flags.dropDaysSinceJoining },
  });
  await audit(actor, 'Drop reported', record, `${f.droppedOn}: ${f.dropReason}`, f.dropReasonDetail);
  await legacyLeft({ app, rec: record, droppedOn: f.droppedOn, reason: f.dropReason + (f.dropReasonDetail ? ` - ${f.dropReasonDetail}` : ''), actor, within: flags.dropWithinGuarantee, from });
  const told = await N.tell({ moment: 'drop', record, ev, ctx });
  if (incentive) {
    // HR: a drop after the recruiter's incentive was decided for that month. A flag and a bell - the decision itself is never changed.
    try {
      const hr = await N.peopleFor(record);
      const { notifyUsers } = require('../utils/notify'); // eslint-disable-line global-require
      await notifyUsers(hr.hr.map((p) => p.userId), {
        title: `Drop after incentive: ${record.candidateName} (${record.recruiterName || 'recruiter'})`,
        message: `${record.candidateName} dropped from ${record.clientName || 'the client'} on ${V.dmy(record.droppedOn)}. An incentive was decided for ${record.recruiterName || 'the recruiter'} for ${String(record.joinedOn).slice(0, 7)}. Nothing was changed - please review.\nOpen: ${N.OPEN(record)}`,
      });
    } catch (e) { console.error('[join-drop] hr flag:', e.message); } // eslint-disable-line no-console
  }
  // INSIDE the replacement period: the "Find a replacement" task opens AT ONCE (the client's yes / no stays pending).
  // OUTSIDE it nothing opens by itself: only a suggestion that the BDE / TL / Admin can see (shape() -> suggestion).
  let tasks = [];
  if (flags.dropWithinGuarantee === 1) {
    const t = await ensureReplacementTask(recordId, actor, { ev, why: 'drop' });
    if (t && t.task) tasks = [{ taskId: t.task.id, what: t.task.name, reused: !!t.reused }];
  }
  return { record: await get(recordId), event: ev, told, tasks, afterIncentive: !!incentive };
}

async function correctDrop(recordId, body, actor, { from = null } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('No drop is recorded for this candidate.', 409);
  const b = body || {};
  if (V.clean(b.correctionReason, 300).length < 3) throw new Bad('Say in a few words why you are correcting it (it is kept in the history).');
  const f = checkDropInput(rec, { droppedOn: b.droppedOn || rec.droppedOn, lastWorkingDay: b.lastWorkingDay !== undefined ? b.lastWorkingDay : rec.lastWorkingDay, reason: b.reason || rec.dropReason, reasonDetail: b.reasonDetail !== undefined ? b.reasonDetail : rec.dropReasonDetail }, { editing: true });
  const flags = guaranteeFlags(rec, f.droppedOn);
  const was = {}; const now = {};
  const diff = { droppedOn: f.droppedOn, lastWorkingDay: f.lastWorkingDay, dropReason: f.dropReason, dropReasonDetail: f.dropReasonDetail };
  Object.keys(diff).forEach((k) => { if (String(diff[k] == null ? '' : diff[k]) !== String(rec[k] == null ? '' : rec[k])) { was[k] = rec[k]; now[k] = diff[k]; } });
  if (!Object.keys(now).length) throw new Bad('Nothing was changed.', 409);
  const record = await update(recordId, { ...f, ...flags });
  const ev = await addEvent({
    record, kind: 'DROP_CORRECTED', actor, from,
    summary: `Drop details corrected: ${Object.keys(now).map((k) => `${k === 'droppedOn' ? 'Dropped on' : (k === 'lastWorkingDay' ? 'Last working day' : (k === 'dropReason' ? 'Reason' : 'Details'))}: ${was[k] == null || was[k] === '' ? 'Not recorded' : (/On$|Day$/.test(k) ? V.dmy(was[k]) : was[k])} -> ${now[k] == null || now[k] === '' ? 'Not recorded' : (/On$|Day$/.test(k) ? V.dmy(now[k]) : now[k])}`).join('; ')}`,
    oldValue: was, newValue: now, note: b.correctionReason,
  });
  await audit(actor, 'Drop details corrected', record, Object.keys(now).join(', '), b.correctionReason);
  return { record, event: ev };
}

// ===========================================================================================
// THE CLIENT'S REPLACEMENT DECISION
// ===========================================================================================
async function decide(recordId, body, actor, { from, onBehalf = false, ctx = {} } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('This candidate has not dropped, so there is nothing to decide yet.', 409);
  const b = body || {};
  const key = String(b.decision || '').toUpperCase();
  if (!V.DECISIONS[key]) throw new Bad('Choose one: We need a replacement, No replacement needed, or We will decide later.');
  const comment = V.cleanLong(b.comment, 1000) || null;
  let expectedOn = null;
  if (b.expectedOn !== undefined && b.expectedOn !== null && b.expectedOn !== '') {
    if (!V.isDay(b.expectedOn)) throw new Bad('The expected date is not a date.');
    if (rec.droppedOn && b.expectedOn < rec.droppedOn) throw new Bad('The expected date cannot be before the day the candidate dropped.');
    expectedOn = b.expectedOn;
  }
  if (key !== 'NEEDED') expectedOn = null;
  const profile = key === 'NEEDED' ? (V.cleanLong(b.profileNotes, 800) || null) : null;
  if (rec.replacementDecision === key && (rec.replacementComment || null) === comment && (rec.replacementExpectedOn || null) === expectedOn && (rec.replacementProfileNotes || null) === profile) {
    throw new Bad('This is already saved. Change the choice or the comment if something is different.', 409);
  }
  const old = { decision: rec.replacementDecision, comment: rec.replacementComment, expectedOn: rec.replacementExpectedOn, status: rec.replacementStatus };
  let status = rec.replacementStatus;
  if (key === 'NEEDED') status = [V.REPL.LINKED, V.REPL.CLOSED].includes(status) ? status : V.REPL.REQUESTED;
  else if (key === 'NOT_NEEDED') status = V.REPL.NOT_NEEDED;
  else status = [V.REPL.LINKED, V.REPL.CLOSED].includes(status) ? status : null;
  const record = await update(recordId, {
    replacementDecision: key, replacementComment: comment, replacementExpectedOn: expectedOn, replacementProfileNotes: profile,
    replacementDecidedAt: V.nowIso(), replacementDecidedById: actor && actor.id ? actor.id : null, replacementDecidedByName: actor ? actor.name : null,
    replacementOnBehalf: onBehalf ? 1 : 0, replacementStatus: status,
  });
  const ev = await addEvent({
    record, kind: 'CLIENT_DECISION', actor, from, onBehalf,
    summary: `${onBehalf ? `Entered by ${actor.name} on the client's behalf: ` : 'The client decided: '}${V.DECISIONS[key].label}${comment ? `. Comment: ${comment.slice(0, 160)}` : ''}${expectedOn ? `. Expected by ${V.dmy(expectedOn)}` : ''}`,
    oldValue: old, newValue: { decision: key, comment, expectedOn, status },
  });
  await audit(actor, onBehalf ? 'Replacement decision entered on the client\'s behalf' : 'Replacement decision by the client', record, V.DECISIONS[key].label, comment);
  const told = await N.tell({ moment: 'decision', record, ev, ctx });
  let tasks = [];
  if (key === 'NEEDED') {
    // the same ONE replacement task (opened by the drop itself when it was inside the period); only created here if it is not there
    const t = await ensureReplacementTask(recordId, actor, { ev, why: 'client' });
    if (t && t.task) tasks = [{ taskId: t.task.id, what: t.task.name, reused: !!t.reused }];
  } else if (key === 'NOT_NEEDED' && record.dropWithinGuarantee === 1) tasks = await N.tasksFor({ kind: 'credit', record, by: actor, ev });
  return { record: await get(recordId), event: ev, told, tasks };
}

// ===========================================================================================
// THE REPLACEMENT CANDIDATE
// ===========================================================================================
async function linkReplacement(recordId, newApplicationId, actor, { from = null } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('Only a dropped candidate has a replacement to link.', 409);
  if (rec.replacementDecision !== 'NEEDED') throw new Bad('The client has not asked for a replacement. Ask the client, or record their answer first.', 409);
  if ([V.REPL.CLOSED].includes(rec.replacementStatus)) throw new Bad('This replacement is already closed.', 409);
  const app = await prisma.application.findUnique({ where: { id: String(newApplicationId || '') }, include: { candidate: { select: { id: true, name: true } } } });
  if (!app) throw new Bad('Choose the new candidate from the list.', 404);
  if (app.requirementId !== rec.requirementId) throw new Bad('The replacement must be a candidate on the same requirement.', 409);
  if (app.id === rec.applicationId || app.candidateId === rec.candidateId) throw new Bad('The replacement must be a different person.', 409);
  const old = { replacementApplicationId: rec.replacementApplicationId, replacementStatus: rec.replacementStatus };
  const record = await update(recordId, { replacementApplicationId: app.id, replacementStatus: V.REPL.LINKED, replacementLinkedAt: V.nowIso() });
  const ev = await addEvent({
    record, kind: 'REPLACEMENT_LINKED', actor, from, summary: `Replacement candidate linked: ${app.candidate ? app.candidate.name : 'a new candidate'}`, oldValue: old, newValue: { replacementApplicationId: app.id },
  });
  await audit(actor, 'Replacement candidate linked', record, app.candidate ? app.candidate.name : app.id);
  // If that person has already joined, this closes the replacement straight away.
  if (JOINED_STAGES.includes(app.stage)) await closeReplacementIfLinked(app.id, actor, {});
  return { record: await get(recordId), event: ev };
}

async function setLegacyReplaced(applicationId) {
  try {
    const V2 = require('../utils/atsVocab'); // eslint-disable-line global-require
    const a = await prisma.application.findUnique({ where: { id: applicationId }, select: { id: true, joiningStatus: true } });
    if (a && a.joiningStatus === V2.JOINING_REPLACEMENT_DUE) await prisma.application.update({ where: { id: a.id }, data: { joiningStatus: V2.JOINING_REPLACED } });
  } catch (e) { console.error('[join-drop] legacy replaced:', e.message); } // eslint-disable-line no-console
}

// The linked replacement joined -> the replacement is closed (and the old "Replacement due" becomes "Replaced").
async function closeReplacementIfLinked(joinedApplicationId, actor, ctx) {
  void ctx;
  try {
    const open = await S.rows('SELECT * FROM "JoiningRecord" WHERE "replacementApplicationId" = ? AND "replacementStatus" = ?', joinedApplicationId, V.REPL.LINKED);
    for (const rec of open) {
      // eslint-disable-next-line no-await-in-loop
      const record = await update(rec.id, { replacementStatus: V.REPL.CLOSED });
      // eslint-disable-next-line no-await-in-loop
      await addEvent({ record, kind: 'REPLACEMENT_CLOSED', actor, from: 'The replacement joined', summary: 'The replacement candidate joined: the replacement is closed.', oldValue: { replacementStatus: V.REPL.LINKED }, newValue: { replacementStatus: V.REPL.CLOSED } });
      // eslint-disable-next-line no-await-in-loop
      await setLegacyReplaced(rec.applicationId);
    }
  } catch (e) { console.error('[join-drop] close replacement:', e.message); } // eslint-disable-line no-console
}

async function closeReplacement(recordId, note, actor, { from = null } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped' || ![V.REPL.REQUESTED, V.REPL.LINKED].includes(rec.replacementStatus)) throw new Bad('There is no open replacement to close.', 409);
  const record = await update(recordId, { replacementStatus: V.REPL.CLOSED });
  const ev = await addEvent({ record, kind: 'REPLACEMENT_CLOSED', actor, from, summary: 'Replacement closed by hand.', oldValue: { replacementStatus: rec.replacementStatus }, newValue: { replacementStatus: V.REPL.CLOSED }, note });
  await setLegacyReplaced(rec.applicationId);
  await audit(actor, 'Replacement closed', record, 'Closed', note);
  return { record, event: ev };
}

// ===========================================================================================
// A DROP REPORTED BY MISTAKE
// ===========================================================================================
async function reopen(recordId, reason, actor, { from = null, ctx = {} } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('This candidate is not shown as dropped.', 409);
  if ([V.REPL.LINKED, V.REPL.CLOSED].includes(rec.replacementStatus)) throw new Bad('A replacement candidate was already added, so the drop cannot be withdrawn here. Ask an Admin.', 409);
  if (V.clean(reason, 300).length < 5) throw new Bad('Say why the drop was wrong (a few words). It is kept in the history.');
  const old = dropSnapshot(rec);
  const record = await update(recordId, { status: 'Joined', ...clearDrop() });
  const ev = await addEvent({
    record, kind: 'DROP_REOPENED', actor, from, summary: `The drop reported for ${V.dmy(rec.droppedOn)} was withdrawn: ${V.cleanLong(reason, 200)}`, oldValue: old, newValue: { status: 'Joined' }, note: reason,
  });
  await audit(actor, 'Drop withdrawn (wrongly reported)', record, 'Joined', reason);
  try {
    const V2 = require('../utils/atsVocab'); // eslint-disable-line global-require
    const a = await prisma.application.findUnique({ where: { id: rec.applicationId }, select: { id: true, joiningStatus: true } });
    if (a && [V2.JOINING_REPLACEMENT_DUE, V2.JOINING_LEFT_AFTER_GUARANTEE].includes(a.joiningStatus)) await prisma.application.update({ where: { id: a.id }, data: { joiningStatus: 'Joined' } });
  } catch (e) { console.error('[join-drop] legacy reopen:', e.message); } // eslint-disable-line no-console
  // the replacement task of a drop that never happened is cancelled (it is moot); it stays in the list as Cancelled
  await cancelTaskRow(rec, 'The drop was withdrawn (reported by mistake)', actor);
  const told = await N.tell({ moment: 'withdrawn', record: await get(recordId), ev, ctx });
  return { record: await get(recordId), event: ev, told };
}

// ===========================================================================================
// THE REPLACEMENT TASK (one live task per drop; never a duplicate)
// ===========================================================================================
const LIVE_TASK = (t) => t && !['Completed', 'Cancelled', 'Closed'].includes(t.status);
async function ensureReplacementTask(recordId, actor, { ev = null, why = 'drop' } = {}) {
  const rec = await get(recordId);
  if (!rec || rec.status !== 'Dropped') return null;
  const dueOn = rec.replacementExpectedOn || V.addDays(V.todayIst(), 7);
  const who = rec.candidateName || 'the candidate';
  const client = rec.clientName || 'the client';
  const name = `Find a replacement for ${who} at ${client} by ${V.dmy(dueOn)}`.slice(0, 200);
  const description = `${who} dropped from ${client} (${rec.jobTitle || 'job'}) on ${V.dmy(rec.droppedOn)}. Reason: ${rec.dropReason || 'not recorded'}. ${N.withinWords(rec)}.${rec.replacementComment ? ` Client says: ${rec.replacementComment}` : ''}${rec.replacementProfileNotes ? ` Profile wanted: ${rec.replacementProfileNotes}` : ''}\nThe client's yes / no is still pending until they answer. Open: ${N.OPEN(rec)}`.slice(0, 1500);
  if (rec.replacementTaskId) {
    const t = await prisma.task.findUnique({ where: { id: rec.replacementTaskId } }).catch(() => null);
    if (LIVE_TASK(t)) {
      // a corrected / re-reported drop, a double click, the client's answer: the same task, brought up to date
      const t2 = (t.name !== name || t.endDate !== dueOn)
        ? await prisma.task.update({ where: { id: t.id }, data: { name, endDate: dueOn, description } }) : t;
      return { task: t2, reused: true };
    }
  }
  const ppl = await N.peopleFor(rec);
  const assignee = ppl.recruiter[0] || ppl.tl[0] || null;
  if (!assignee) return { task: null, problem: 'No recruiter or team lead is on this requirement, so no task could be made.' };
  const t = await N.makeTask({ name, description, assignee, by: actor, endDate: dueOn, department: rec.department });
  if (!t) {
    // makeTask refused only because an open task with this name and person already exists: that one is the live task
    const live = await prisma.task.findFirst({ where: { name, assigneeId: assignee.userId, status: { notIn: ['Completed', 'Cancelled', 'Closed'] } } });
    if (live) { await update(recordId, { replacementTaskId: live.id, replacementTaskState: 'Open', replacementTaskCancelReason: null }); return { task: live, reused: true }; }
    return { task: null };
  }
  await update(recordId, { replacementTaskId: t.id, replacementTaskState: 'Open', replacementTaskCancelReason: null, replacementTaskCancelledByName: null, replacementTaskCancelledAt: null });
  if (ev) await N.logTaskNotice({ record: rec, ev, task: t, assignee });
  void why;
  return { task: t, reused: false, created: true };
}

async function cancelTaskRow(rec, reason, actor) {
  if (!rec.replacementTaskId) return null;
  const t = await prisma.task.findUnique({ where: { id: rec.replacementTaskId } }).catch(() => null);
  if (!LIVE_TASK(t)) return null;
  await prisma.task.update({ where: { id: t.id }, data: { status: 'Cancelled', description: `${t.description || ''}\nCancelled by ${actor ? actor.name : 'TeamLink'}: ${V.clean(reason, 200)}`.slice(0, 1500) } });
  await update(rec.id, {
    replacementTaskState: 'Cancelled', replacementTaskCancelReason: V.clean(reason, 300), replacementTaskCancelledByName: actor ? actor.name : 'TeamLink', replacementTaskCancelledAt: V.nowIso(),
  });
  return t;
}

// BDE / TL / Admin cancel it (with a reason, audited, the same people told). The caller (the route) has already checked who may.
async function cancelReplacementTask(recordId, reason, actor, { from = null, ctx = {} } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (V.clean(reason, 300).length < 5) throw new Bad('Say why the replacement task is not needed (a few words). It is kept in the history.');
  const t = await cancelTaskRow(rec, reason, actor);
  if (!t) throw new Bad('There is no open replacement task for this candidate.', 409);
  const record = await get(recordId);
  const ev = await addEvent({
    record, kind: 'REPLACEMENT_TASK_CANCELLED', actor, from, summary: `The replacement task was cancelled: ${V.cleanLong(reason, 200)}`, oldValue: { replacementTaskState: 'Open' }, newValue: { replacementTaskState: 'Cancelled' }, note: reason,
  });
  await audit(actor, 'Replacement task cancelled', record, t.name, reason);
  const told = await N.tell({ moment: 'taskCancelled', record, ev, ctx });
  return { record, event: ev, told };
}

// Outside the replacement period nothing opens by itself; an authorized person can still open the task by hand.
async function openReplacementTask(recordId, actor, { from = null } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('Only a dropped candidate can have a replacement task.', 409);
  if (rec.replacementTaskState === 'Open') throw new Bad('A replacement task is already open for this candidate.', 409);
  const r = await ensureReplacementTask(recordId, actor, { why: 'manual' });
  if (!r || !r.task) throw new Bad((r && r.problem) || 'The task could not be made.', 409);
  const record = await get(recordId);
  const ev = await addEvent({ record, kind: 'REPLACEMENT_TASK_OPENED', actor, from, summary: `A replacement task was opened by hand: ${r.task.name}`, newValue: { taskId: r.task.id } });
  await audit(actor, 'Replacement task opened by hand', record, r.task.name);
  return { record, event: ev, task: r.task };
}

// ===========================================================================================
// READ HELPERS
// ===========================================================================================
async function history(recordId) {
  return S.rows('SELECT * FROM "JoiningEvent" WHERE "recordId" = ? ORDER BY "at" ASC, "id" ASC', recordId);
}
async function notices(recordId) {
  return S.rows('SELECT "eventId","party","channel","recipientName","status","detail","createdAt" FROM "JoinDropNotice" WHERE "recordId" = ? ORDER BY "createdAt" ASC', recordId);
}

// A joined application with no record yet (an old row, an import): make one from what is on file, quietly.
async function ensureForApplication(appId) {
  await ready();
  const have = await byApplication(appId);
  if (have) return have;
  const r = await recordJoined({ applicationId: appId, backfill: true, quiet: true });
  return r && r.record ? r.record : byApplication(appId);
}

// ONE-TIME BACKFILL of every application that is already Joined (and the people the older "Left the job" button already marked).
// From what is on file only: the joining day (joining date, joined time or the move into Joined), the job's title / type, the people, the client's
// guarantee. The place is never guessed: it shows "Not recorded" with an Add details button. No notice is sent for any of it.
const BACKFILL_KEY = 'joindrop-backfill';
async function backfillOnce({ force = false } = {}) {
  await ready();
  if (!force) {
    const done = await prisma.appSetting.findUnique({ where: { key: BACKFILL_KEY } }).catch(() => null);
    if (done) return { skipped: true };
  }
  if (backfillRunning) return backfillRunning;
  backfillRunning = (async () => {
    const out = { made: 0, dropped: 0, skipped: 0 };
    const apps = await prisma.application.findMany({ where: { stage: { in: JOINED_STAGES } }, select: { id: true } });
    const have = new Set((await S.rows('SELECT "applicationId" FROM "JoiningRecord"')).map((r) => r.applicationId));
    for (const a of apps) {
      if (have.has(a.id)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await recordJoined({ applicationId: a.id, backfill: true, quiet: true });
      if (!r || !r.created) { out.skipped += 1; continue; } // eslint-disable-line no-continue
      out.made += 1;
      // eslint-disable-next-line no-await-in-loop
      const app = await loadApp(a.id);
      const V2 = require('../utils/atsVocab'); // eslint-disable-line global-require
      if (app && [V2.JOINING_REPLACEMENT_DUE, V2.JOINING_REPLACED, V2.JOINING_LEFT_AFTER_GUARANTEE].includes(app.joiningStatus)) {
        const ev = [...(app.stageEvents || [])].reverse().find((e) => /^Left (within|after) the guarantee/i.test(e.action || ''));
        const m = ev && /Left on (\d{4}-\d{2}-\d{2}):\s*(.*)$/s.exec(ev.comment || '');
        const droppedOn = m ? m[1] : (ev ? istDay(ev.createdAt) : null);
        const reasonText = m ? V.clean(m[2], 300) : '';
        const rec = r.record;
        const flags = droppedOn && rec.joinedOn ? guaranteeFlags(rec, droppedOn) : { dropWithinGuarantee: null, dropDaysSinceJoining: null };
        // eslint-disable-next-line no-await-in-loop
        const record = await update(rec.id, {
          status: 'Dropped', droppedOn, dropReason: reasonText || 'Not recorded', dropReportedByName: ev ? ev.actorName : null, dropReportedFrom: 'Backfill', dropReportedAt: ev ? new Date(ev.createdAt).toISOString() : null,
          ...flags, replacementStatus: app.joiningStatus === V2.JOINING_REPLACED ? V.REPL.CLOSED : (app.joiningStatus === V2.JOINING_REPLACEMENT_DUE ? V.REPL.REQUESTED : null),
        });
        // eslint-disable-next-line no-await-in-loop
        await addEvent({ record, kind: 'DROP_REPORTED', actor: null, from: 'Backfill', summary: `Copied from the older "Left the job" record${droppedOn ? `: left on ${V.dmy(droppedOn)}` : ' (the day was not recorded)'}. Reason: ${reasonText || 'Not recorded'}.`, newValue: { droppedOn } });
        out.dropped += 1;
      }
    }
    await prisma.appSetting.upsert({ where: { key: BACKFILL_KEY }, create: { key: BACKFILL_KEY, value: JSON.stringify({ at: V.nowIso(), ...out }) }, update: { value: JSON.stringify({ at: V.nowIso(), ...out }) } });
    return out;
  })().finally(() => { backfillRunning = null; });
  return backfillRunning;
}

// HR / an authorized person reviews the notice, may edit it, and sends it by hand. Consent, a recipient and the STOP list still apply;
// the Candidate emails master switch is honoured (off = recorded, not sent). Every outcome is in the notice log and the Audit Log.
async function sendCandidateNotice(recordId, body, actor, { from = null, ctx = {} } = {}) {
  await ready();
  const rec = await get(recordId);
  if (!rec) throw new Bad('That joining record was not found.', 404);
  if (rec.status !== 'Dropped') throw new Bad('There is no drop to tell the candidate about.', 409);
  const b = body || {};
  const channels = (Array.isArray(b.channels) ? b.channels : []).filter((c) => ['Email', 'WhatsApp'].includes(c));
  if (!channels.length) throw new Bad('Choose Email or WhatsApp.');
  const edited = { subject: b.subject, body: b.body };
  const ev = await addEvent({
    record: rec, kind: 'CANDIDATE_NOTICE', actor, from, summary: `A drop notice was sent to the candidate by hand (${channels.join(' + ')})`, newValue: { channels },
  });
  const out = await N.sendNoticeByHand({ record: rec, ev, channels, edited, ctx });
  const said = out.candidate.map((c) => `${c.channel}: ${c.status}`).join('; ') || 'nothing could be sent';
  await audit(actor, 'Drop notice to the candidate (by hand)', rec, said);
  return { record: rec, event: ev, result: out.candidate, problems: out.problems };
}

module.exports = {
  sendCandidateNotice,
  Bad, ready, readyP, JOINED_STAGES, loadApp, get, byApplication, history, notices, addEvent, update,
  recordJoined, correctJoining, reportDrop, correctDrop, decide, linkReplacement, closeReplacement, reopen,
  ensureForApplication, backfillOnce, joinDayOf, guaranteeOf, peopleOf, EDITABLE,
  ensureReplacementTask, cancelReplacementTask, openReplacementTask, LIVE_TASK,
};
