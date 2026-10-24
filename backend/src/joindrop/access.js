// ---------------------------------------------------------------------------
// JOINING & DROP - WHO MAY SEE AND DO WHAT, and the shape each viewer receives.
//
//   admin     Super Admin / Admin            everything
//   mgmt      Manager / Assistant Manager    sees their scope (the Joining screen's rule); acts only where the Role Catalog lets them
//   bde       BDE and the BDE team lead      their clients' records; NEVER the candidate's phone / email, never the pay
//   tl / stl  team leads                     their team's records
//   recruiter the recruiter                  their own records
//   hr        the HR desk                    client placements too (names, dates, reasons only) while the Admin switch is ON; no pay, no contact
//   accounts  Accounts                       reads (scope as the Joining screen); acts on nothing
//   client    a client login                 ONLY its own company's candidates, plain words, no people's names, no pay
//
// Records are visible to staff only if the APPLICATION is visible to them (utils/scope.js applicationWhere: the one rule everywhere).
// The agreement rule: a TL / STL / Recruiter / HR login never reads the word "agreement" or any agreement text: they get only the number of days,
// worded "from the client's terms".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./vocab');
const SET = require('./settings');
const S = require('./schema');
const { applicationWhere } = require('../utils/scope');
const scope = require('../utils/scope');

const isClientLogin = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT') && !!u.clientId;

function kindOf(user) {
  if (!user) return 'none';
  if (isClientLogin(user)) return 'client';
  if (user.hrDesk) return 'hr';
  let v = 'none';
  try { v = scope.clientViewRole(user); } catch { v = 'none'; }
  return v || 'none';
}

const blind = (user) => { try { return require('../utils/agreementPrivacy').blindTo(user); } catch { return false; } }; // eslint-disable-line global-require

async function engine(user, action) {
  try { return !!(await require('../middleware/auth').can(user, 'ats', 'interviews', 'Joining', action)); } catch { return false; } // eslint-disable-line global-require
}

const ACT_KINDS = ['admin', 'mgmt', 'tl', 'stl', 'recruiter', 'bde'];
const LEAD_KINDS = ['admin', 'bde', 'tl', 'stl'];

// What this login may DO (not about one record). hrOn = the Admin switch "HR sees the records".
// THE HR SIDE is a short list of people (settings.hrPeople: employee codes, default TL309), not "all HR": a login on the list is treated as HR
// (names, dates, reasons only), any other HR-desk login gets no access at all, whatever its role.
const listedHr = (user, s) => !!user && !!user.employeeCode && s.hrPeople.includes(String(user.employeeCode).toUpperCase());
async function rights(user) {
  let kind = kindOf(user);
  const s = await SET.get();
  const listed = kind !== 'client' && kind !== 'admin' && listedHr(user, s);
  if (listed) kind = 'hr';
  else if (kind === 'hr') kind = 'none';
  const edit = kind === 'client' ? false : await engine(user, 'edit');
  const exportOk = kind === 'client' ? true : await engine(user, 'export') || kind === 'hr';
  const flags = (() => { try { return require('../utils/clientRedact').privacyFlagsFor(user); } catch { return null; } })(); // eslint-disable-line global-require
  return {
    kind,
    hrOn: listed,
    record: edit && ACT_KINDS.includes(kind),
    report: (edit && ACT_KINDS.includes(kind)) || (kind === 'hr' && listed),
    decide: edit && LEAD_KINDS.includes(kind),
    reopen: edit && LEAD_KINDS.includes(kind),
    cancelTask: edit && LEAD_KINDS.includes(kind),
    openTask: edit && LEAD_KINDS.includes(kind),
    link: edit && ACT_KINDS.includes(kind),
    notice: (edit && LEAD_KINDS.includes(kind)) || (kind === 'hr' && listed),
    export: !!exportOk,
    seePay: !(flags && (flags.bde || flags.contact)) && kind !== 'client' && kind !== 'hr',
    seeAgreementWords: kind === 'client' || !blind(user),
    admin: kind === 'admin',
    settings: s,
  };
}

// May this login open this record?
async function canSee(user, rec, r) {
  const rt = r || await rights(user);
  if (rt.kind === 'client') return rec.clientId === user.clientId && rec.hiringType !== 'TeamLink Internal Hire' && require('../utils/clientPortalTypes').hasCap(user, 'VIEW'); // eslint-disable-line global-require
  if (rt.kind === 'admin') return true;
  if (rt.kind === 'none') return false;
  if (rt.kind === 'hr' && rt.hrOn && rec.hiringType !== 'TeamLink Internal Hire') return true;
  const hit = await prisma.application.findFirst({ where: { id: rec.applicationId, ...applicationWhere(user) }, select: { id: true } });
  return !!hit;
}

// The subset of rows this login may open (scope checked in chunks of the application ids).
async function visible(user, rows, r) {
  const rt = r || await rights(user);
  if (rt.kind === 'admin') return rows;
  if (rt.kind === 'client') return rows.filter((x) => x.clientId === user.clientId && x.hiringType !== 'TeamLink Internal Hire');
  if (rt.kind === 'none') return [];
  const out = [];
  let rest = rows;
  if (rt.kind === 'hr' && rt.hrOn) { out.push(...rows.filter((x) => x.hiringType !== 'TeamLink Internal Hire')); rest = rows.filter((x) => x.hiringType === 'TeamLink Internal Hire'); }
  const ok = new Set();
  for (let i = 0; i < rest.length; i += 400) {
    const chunk = rest.slice(i, i + 400).map((x) => x.applicationId);
    // eslint-disable-next-line no-await-in-loop
    const hit = await prisma.application.findMany({ where: { id: { in: chunk }, ...applicationWhere(user) }, select: { id: true } });
    hit.forEach((h) => ok.add(h.id));
  }
  out.push(...rest.filter((x) => ok.has(x.applicationId)));
  return out;
}

// --- the guarantee, in words -------------------------------------------------------------------------------------------------------------
function guaranteeLine(rec, rt) {
  if (rec.hiringType === 'TeamLink Internal Hire') return { headline: 'Not applicable (an internal hire)', source: '' };
  if (rec.guaranteeDays == null) return { headline: 'Not set', source: '' };
  if (rec.guaranteeDays === 0) return { headline: 'No replacement period', source: rt.kind === 'client' ? 'as in your agreement' : (rt.seeAgreementWords ? 'from the agreement' : 'from the client\'s terms') };
  let src;
  if (rec.guaranteeSource === 'DEFAULT') src = rt.kind === 'client' ? `${rec.guaranteeDays} days (our standard period)` : `default ${rec.guaranteeDays} days`;
  else if (rt.kind === 'client') src = `${rec.guaranteeDays} days from your agreement`;
  else src = `${rt.seeAgreementWords ? 'from the agreement' : 'from the client\'s terms'}: ${rec.guaranteeDays} days`;
  return { headline: `Guarantee until ${V.dmy(rec.guaranteeEndsOn)} - ${src}`, source: src };
}

// A task's state in plain words from the Task row (the source of truth for done / cancelled).
async function taskStates(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.task.findMany({ where: { id: { in: list } }, select: { id: true, name: true, status: true, endDate: true, assigneeName: true } });
  return new Map(rows.map((t) => [t.id, t]));
}
const taskWord = (t, rec) => {
  if (!t) return rec.replacementTaskState || null;
  if (t.status === 'Cancelled' || rec.replacementTaskState === 'Cancelled') return 'Cancelled';
  if (['Completed', 'Closed'].includes(t.status)) return 'Done';
  if (t.status === 'Not Started') return 'Open';
  return t.status;
};

const nameOf = (rec) => rec.candidateName;

// THE SHAPE EACH VIEWER GETS. Picked field by field (nothing is spread from the row).
// Key names avoid the ones the client / candidate guards treat as markers (guaranteePeriod, contactName, gst ...).
function shape(rec, rt, { tasks = null, today = V.todayIst() } = {}) {
  if (!rec) return null;
  const client = rt.kind === 'client';
  const dropped = rec.status === 'Dropped';
  const g = guaranteeLine(rec, rt);
  const daysSince = rec.joinedOn ? V.daysBetween(rec.joinedOn, dropped && rec.droppedOn ? rec.droppedOn : today) : null;
  const inGuarantee = !dropped && rec.guaranteeEndsOn ? today <= rec.guaranteeEndsOn : null;
  const task = tasks && rec.replacementTaskId ? tasks.get(rec.replacementTaskId) : null;
  const missing = [];
  if (!rec.joinedOn) missing.push('joinedOn');
  if (!rec.location) missing.push('location');
  if (!rec.reportingPerson && !client) missing.push('reportingPerson');
  const out = {
    id: rec.id,
    applicationId: rec.applicationId,
    candidateId: client ? undefined : rec.candidateId,
    candidateName: nameOf(rec),
    jobTitle: rec.jobTitle,
    jobCode: rec.jobCode,
    clientId: rec.clientId,
    clientName: rec.clientName,
    department: client ? undefined : rec.department,
    hiringType: rec.hiringType,
    status: rec.status,
    joinedOn: rec.joinedOn,
    location: rec.location,
    designation: rec.designation,
    employmentType: rec.employmentType,
    reportingPerson: rec.reportingPerson,
    reportingContact: rec.reportingContact,
    guaranteeDays: rec.guaranteeDays,
    guaranteeStartOn: rec.guaranteeStartOn || rec.joinedOn,
    guaranteeEndsOn: rec.guaranteeEndsOn,
    guaranteeHow: rec.guaranteeSource === 'DEFAULT' ? 'DEFAULT' : (rec.guaranteeSource ? 'CLIENT_TERMS' : null),
    guaranteeLine: g.headline,
    guaranteeSourceWords: g.source,
    daysSinceJoining: daysSince,
    inGuarantee,
    missing,
    needsDetails: missing.includes('joinedOn') || missing.includes('location'),
    droppedOn: rec.droppedOn,
    lastWorkingDay: rec.lastWorkingDay,
    dropReason: rec.dropReason,
    dropReasonDetail: rec.dropReasonDetail,
    dropReportedFrom: rec.dropReportedFrom,
    dropReportedAt: rec.dropReportedAt,
    dropReportedByName: client ? (rec.dropReportedFrom === 'Client login' ? 'You' : 'TeamLink') : rec.dropReportedByName,
    dropWithinGuarantee: rec.dropWithinGuarantee,
    dropDaysSinceJoining: rec.dropDaysSinceJoining,
    replacementDecision: rec.replacementDecision,
    replacementDecisionWords: rec.replacementDecision ? V.DECISIONS[rec.replacementDecision].label : null,
    replacementComment: rec.replacementComment,
    replacementExpectedOn: rec.replacementExpectedOn,
    replacementProfileNotes: rec.replacementProfileNotes,
    replacementDecidedAt: rec.replacementDecidedAt,
    replacementDecidedByName: client ? (rec.replacementOnBehalf ? 'TeamLink (on your behalf)' : 'You') : rec.replacementDecidedByName,
    replacementOnBehalf: !!rec.replacementOnBehalf,
    replacementStatus: rec.replacementStatus,
    replacementLinkedAt: client ? undefined : rec.replacementLinkedAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (client) {
    // the client is told the plain fact, never who at TeamLink holds it
    out.replacementTold = !!rec.replacementDecidedAt;
    out.replacementTaskState = undefined;
    return clean(out);
  }
  Object.assign(out, {
    recruiterName: rec.recruiterName, tlName: rec.tlName, bdeName: rec.bdeName, seat: rec.seat,
    recordedByName: rec.recordedByName, recordedVia: rec.recordedVia, backfilled: !!rec.backfilled,
    notes: rec.notes,
    replacementApplicationId: rec.replacementApplicationId,
    replacementTask: rec.replacementTaskId ? {
      id: rec.replacementTaskId, state: taskWord(task, rec), name: task ? task.name : null, dueOn: task ? task.endDate : null, assignee: task ? task.assigneeName : null,
      cancelReason: rec.replacementTaskCancelReason, cancelledBy: rec.replacementTaskCancelledByName, cancelledAt: rec.replacementTaskCancelledAt,
    } : null,
    dropAfterIncentive: !!rec.dropAfterIncentive,
  });
  if (rt.seePay) out.offeredCtc = rec.offeredCtc;
  // OUTSIDE the period: nothing opened by itself - a suggestion for the people who can open it.
  if (dropped && rec.dropWithinGuarantee === 0 && !rec.replacementTaskId && (rt.openTask)) {
    out.suggestion = `This drop is outside the replacement period${rec.guaranteeEndsOn ? ` (it ended on ${V.dmy(rec.guaranteeEndsOn)})` : ''}, so no replacement task was opened. If the client still wants a replacement, you can open one.`;
  }
  return clean(out);
}
const clean = (o) => { Object.keys(o).forEach((k) => { if (o[k] === undefined) delete o[k]; }); return o; };

module.exports = {
  kindOf, rights, canSee, visible, shape, taskStates, guaranteeLine, isClientLogin, blind, ACT_KINDS, LEAD_KINDS, S,
};
