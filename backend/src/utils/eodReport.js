// ---------------------------------------------------------------------------
// THE END-OF-DAY REPORT (user, 2026-10-10: "call report, team report, individual report:
// everything goes to the TL at the end of the day").
//
// At the set time (default 18:45 IST; Sunday / holidays skipped) every TL gets, for THEIR
// team (the TL a recruiter resolves to — utils/pendingWork.js directory):
//   1. the CALL REPORT        calls per recruiter, how they went, talk time, who was not called
//   2. the TEAM REPORT        the team's day vs the last working day and the month so far,
//                             the pending-work numbers, jobs with no profile sent today
//   3. the INDIVIDUAL REPORTS one compact block per recruiter, with a "no activity" flag
// as an HTML mail (+ plain text) with an Excel file attached, a bell notice with the headline
// numbers, and an in-app view (Reports → ATS → Daily report → End of day). The BDE TL gets the
// same for the BDE desk (client work, no recruiters, no candidate calls).
//
// NUMBERS ARE THE SCREENS' NUMBERS. Nothing here is counted a new way:
//   calls / mails / WhatsApp / follow-ups done / sent to TL / sent to client / interviews /
//   interviews done / offers / joined   utils/dailyReport.js — the Daily report screen, run as
//                                       the TL (his scope), cut to his team
//   month so far, joinings and target   the same report's month view + utils/recruiterJoinings.js
//   Waiting / Due today / Late          the dashboard's Team snapshot (utils/pendingWork.js)
// Added here: the call OUTCOMES (from the call records the app already writes: the Call button's
// quick log, the Contact dialog's "Save the call" and the TeamLink call-through result), SMS
// sent, selected / rejected / on hold moves of the day, and jobs with no profile sent today.
//
// There is NO recruiter-typed daily report in the app (the "daily report" is built from the
// work itself), so the individual block shows what the person DID and flags "no activity"; there
// is no "did not submit" list.
//
// PRIVACY. Names of people and jobs only: never a candidate's phone / e-mail / salary, never an
// internal note. The BDE report has no recruiter data. Scope is the server's: a TL reads only
// their own team's report (routes/pendingWork.js).
//
// STORED: each report is kept as a snapshot (AppSetting eod.<tlId>.<day>, 60 days) so past days
// show what was reported then — pending numbers cannot be rebuilt for a past day.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const NA = require('./nextAction');
const M = require('./reportMailHtml');
const PW = require('./pendingWork');
const { toXlsxBook } = require('./tabularExport');

const DAY_MS = 86400000;
const isTest = (s) => PW.TEST_RE.test(String(s || ''));
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const istHm = (v) => new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(11, 16);
const KEY = (tlId, day) => `eod.${tlId}.${day}`;
const KEEP_DAYS = 60;

// ---------------------------------------------------------------------------
// CALL OUTCOMES — the words the app really stores, grouped.
//   Quick log (Call button):  Answered · Interested · Not interested · Not picked · Busy · Switched off · Wrong number · Call back later
//   Contact dialog:           Answered · Not Answered · Busy · Switched Off · Wrong Number
//   Call through TeamLink:    "Call completed · talked 2 min 5 s" · "Not answered" · "The person's phone was busy" · "Call failed"
// ---------------------------------------------------------------------------
const CALL_GROUPS = [
  { id: 'connected', label: 'Connected (spoke)' },
  { id: 'interested', label: 'Interested' },
  { id: 'notInterested', label: 'Not interested' },
  { id: 'callBack', label: 'Call back requested' },
  { id: 'notAnswered', label: 'Not answered' },
  { id: 'busy', label: 'Busy' },
  { id: 'switchedOff', label: 'Switched off' },
  { id: 'wrongNumber', label: 'Wrong number' },
  { id: 'failed', label: 'Call did not go through' },
  { id: 'started', label: 'Started, result not reported yet' },
  { id: 'other', label: 'Other' },
];
function callOutcome(m) {
  const first = String(m.body || '').split(' — ')[0].split('\n')[0].trim().toLowerCase();
  const detail = String(m.statusDetail || '').toLowerCase();
  const t = first || detail;
  if (/not interested/.test(t)) return 'notInterested';
  if (/\binterested\b/.test(t)) return 'interested';
  if (/call ?back/.test(t)) return 'callBack';
  if (/wrong number/.test(t)) return 'wrongNumber';
  if (/switched off/.test(t)) return 'switchedOff';
  if (/not picked|not answered|no[- ]?answer|no response/.test(t) || /not answered|connected but not answered/.test(detail)) return 'notAnswered';
  if (/busy/.test(t) || /busy/.test(detail)) return 'busy';
  if (/answered|connected|spoke/.test(t) || /call completed/.test(detail)) return 'connected';
  if (/failed|did not start/.test(detail) || m.status === 'FAILED') return 'failed';
  if (m.template === 'CALL_THROUGH' && m.status === 'SENT') return 'started';
  return 'other';
}
const CONNECTED_SET = new Set(['connected', 'interested', 'notInterested', 'callBack']);
function talkSeconds(m) {
  const x = /talked (?:(\d+) min)?\s*(?:(\d+) s)?/i.exec(String(m.statusDetail || ''));
  return x ? (Number(x[1] || 0) * 60 + Number(x[2] || 0)) : 0;
}

// ---------------------------------------------------------------------------
// THE REPORT (a plain JSON snapshot; the mail, the Excel file and the screen all read it)
// ---------------------------------------------------------------------------
const DR_KEYS = ['calls', 'mails', 'whatsapp', 'followUps', 'sentTl', 'sentClient', 'interviews', 'attended', 'offers', 'joined', 'added', 'reviewed', 'feedback'];
const blankDr = () => Object.fromEntries(DR_KEYS.map((k) => [k, 0]));
const sumInto = (t, p) => DR_KEYS.forEach((k) => { t[k] += Number(p[k]) || 0; });

// The last working day before `day` (not a Sunday / holiday), at most a week back.
async function previousWorkingDay(day) {
  let d = addDays(day, -1);
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await PW.offDayReason(d))) return d;
    d = addDays(d, -1);
  }
  return addDays(day, -1);
}

// Calls and other contacts of the day for a set of senders.
async function contactsOf(day, userIds) {
  const gte = istStart(day);
  const lt = istStart(addDays(day, 1));
  const msgs = await prisma.candidateMessage.findMany({
    where: { createdAt: { gte, lt }, trigger: 'Manual', senderUserId: { in: userIds }, channel: { in: ['Call', 'Email', 'WhatsApp', 'SMS'] } },
    select: { candidateId: true, channel: true, createdAt: true, senderUserId: true, body: true, status: true, statusDetail: true, template: true },
  });
  const by = new Map(userIds.map((id) => [id, {
    calls: 0, outcomes: {}, candidates: new Set(), talkSeconds: 0, lastCallAt: null, mails: 0, whatsapp: 0, sms: 0,
  }]));
  msgs.forEach((m) => {
    const e = by.get(m.senderUserId);
    if (!e) return;
    if (m.channel === 'Call') {
      e.calls += 1;
      const o = callOutcome(m);
      e.outcomes[o] = (e.outcomes[o] || 0) + 1;
      e.candidates.add(m.candidateId);
      e.talkSeconds += talkSeconds(m);
      if (!e.lastCallAt || m.createdAt > e.lastCallAt) e.lastCallAt = m.createdAt;
    } else if (m.channel === 'Email') e.mails += 1;
    else if (m.channel === 'WhatsApp') e.whatsapp += 1;
    else if (m.channel === 'SMS') e.sms += 1;
  });
  return by;
}

// Follow-ups owned by the team that are due today (done / not done), and who got no call although due.
async function followUpsToday(day, userIds, calledToday) {
  const rows = await prisma.applicationFollowUp.findMany({
    where: { ownerUserId: { in: userIds }, dueDate: { lte: `${day}￿` }, OR: [{ completedAt: null }, { completedAt: { gte: istStart(day) } }], application: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } } },
    select: { ownerUserId: true, candidateId: true, dueDate: true, completedAt: true, application: { select: { candidate: { select: { name: true } } } } },
  });
  const out = new Map(userIds.map((id) => [id, { dueToday: 0, doneOfDue: 0, openDue: 0, notCalled: [] }]));
  rows.forEach((f) => {
    const e = out.get(f.ownerUserId);
    const due = String(f.dueDate || '').slice(0, 10);
    if (!e || !due) return;
    if (due === day) { e.dueToday += 1; if (f.completedAt) e.doneOfDue += 1; }
    if (!f.completedAt) {
      e.openDue += 1;
      const called = calledToday.get(f.ownerUserId);
      if (!(called && called.candidates.has(f.candidateId))) e.notCalled.push((f.application && f.application.candidate && f.application.candidate.name) || '—');
    }
  });
  return out;
}

// Selected / rejected / on hold moves of the day by real people, steps moved forward, per attributed recruiter.
function movesOf(world, day, userIds) {
  const from = istStart(day).getTime();
  const to = from + DAY_MS;
  const out = new Map(userIds.map((id) => [id, { selected: 0, rejected: 0, hold: 0, stepsMoved: 0 }]));
  world.rows.forEach((x) => {
    const rec = x.who && x.who.recruiter && x.who.recruiter.userId;
    x.evs.forEach((e) => {
      if (!e.actor || e.at < from || e.at >= to || e.from === e.to) return;
      const mover = out.get(e.actor);
      if (mover) mover.stepsMoved += 1;
      const owner = out.get(rec);
      if (!owner) return;
      if (e.to === 'SELECTED') owner.selected += 1;
      else if (e.to === 'REJECTED') owner.rejected += 1;
      else if (e.to === 'HOLD') owner.hold += 1;
    });
  });
  return out;
}

// Live jobs of the team with nobody sent to the client today.
function jobsNoSubmissionToday(world, day, userIds) {
  const from = istStart(day).getTime();
  const to = from + DAY_MS;
  const ids = new Set(userIds);
  const sentToday = new Set();
  world.rows.forEach((x) => { if (x.evs.some((e) => ['SHARED_WITH_CLIENT', 'TL_REVIEW'].includes(e.to) && e.actor && e.at >= from && e.at < to)) sentToday.add(x.a.requirementId); });
  const V = require('./atsVocab'); // eslint-disable-line global-require
  return world.reqs.filter((r) => V.REQUIREMENT_LIVE_STATUSES.includes(r.status) && !r.internal && !sentToday.has(r.id)
    && [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())].some((id) => id && ids.has(id)))
    .map((r) => ({ requirementId: r.id, job: r.title, client: (r.client && r.client.name) || '—' }));
}

// ---------------------------------------------------------------------------
// BUILD — the recruiting team of one TL.
// ---------------------------------------------------------------------------
async function buildTeamReport({ tlId, day, viewer = null, collected = null }) {
  const DR = require('./dailyReport'); // eslint-disable-line global-require
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const RJ = require('./recruiterJoinings'); // eslint-disable-line global-require
  const vw = await PW.pickViewer(viewer);
  const c = collected || await PW.collectTeams({ viewer: vw, only: tlId });
  const team = c.teams.get(tlId);
  if (!team) return { error: 'This team lead has no recruiters.' };
  const tlUser = (await PW.usersById([tlId])).get(tlId) || { id: tlId, name: team.tl.name };
  const tlViewer = await resolveIdentity(tlId);
  const ids = team.blocks.map((b) => b.userId);
  const keys = new Set(ids.map((id) => `u:${id}`));
  const month = day.slice(0, 7);
  const prevDay = await previousWorkingDay(day);
  const [today, yest, mtd, contacts, adminLoad, board] = await Promise.all([
    DR.dayReport(tlViewer, { day, fresh: '1' }),
    DR.dayReport(tlViewer, { day: prevDay }),
    DR.monthReport(tlViewer, { month }),
    contactsOf(day, ids),
    AH.pendingLoad(vw),
    RJ.monthBoard(month).catch(() => null),
  ]);
  const personOf = (res, id) => (res.status === 200 ? (res.body.people.find((p) => p.key === `u:${id}`) || blankDr()) : blankDr());
  const fus = await followUpsToday(day, ids, contacts);
  const moves = movesOf(adminLoad.world, day, ids);
  const jobs = jobsNoSubmissionToday(adminLoad.world, day, ids);

  const total = blankDr();
  const totalPrev = blankDr();
  const totalMtd = blankDr();
  const people = team.blocks.map((b) => {
    const dr = personOf(today, b.userId);
    const dp = personOf(yest, b.userId);
    const dm = mtd.status === 200 ? (mtd.body.people.find((p) => p.key === `u:${b.userId}`) || blankDr()) : blankDr();
    sumInto(total, dr); sumInto(totalPrev, dp); sumInto(totalMtd, dm);
    const ct = contacts.get(b.userId);
    const connected = Object.entries(ct.outcomes).reduce((n, [k, v]) => n + (CONNECTED_SET.has(k) ? v : 0), 0);
    const fu = fus.get(b.userId);
    const mv = moves.get(b.userId);
    const row = board ? board.rows.find((r) => r.userId === b.userId) : null;
    const myJobs = jobs.filter((j) => adminLoad.world.reqs.some((r) => r.id === j.requirementId && [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())].includes(b.userId)));
    const callTotal = ct.calls;
    const active = !!(callTotal || dr.followUps || mv.stepsMoved || dr.mails || dr.whatsapp || ct.sms || dr.sentTl || dr.sentClient || dr.interviews || dr.added || dr.joined);
    return {
      userId: b.userId,
      name: b.name,
      department: b.department,
      calls: {
        total: callTotal,
        connected,
        notConnected: callTotal - connected,
        outcomes: ct.outcomes,
        candidates: ct.candidates.size,
        talkMinutes: Math.round(ct.talkSeconds / 60),
        lastCallAt: ct.lastCallAt ? istHm(ct.lastCallAt) : null,
        dueNotCalled: fu.notCalled.length,
        dueNotCalledNames: fu.notCalled.slice(0, 5),
      },
      other: { mails: dr.mails || ct.mails, whatsapp: dr.whatsapp || ct.whatsapp, sms: ct.sms },
      stepsMoved: mv.stepsMoved,
      sentTl: dr.sentTl || 0,
      sentClient: dr.sentClient || 0,
      interviews: dr.interviews || 0,
      interviewsDone: dr.attended || 0,
      selected: mv.selected,
      offers: dr.offers || 0,
      joined: dr.joined || 0,
      rejected: mv.rejected,
      hold: mv.hold,
      followUps: { done: dr.followUps || 0, dueToday: fu.dueToday, doneOfDue: fu.doneOfDue, openDue: fu.openDue },
      pending: { waiting: b.counts.waiting, late: b.counts.late, dueToday: b.counts.dueToday, notMoving: b.counts.notMoving, jobsNoProfile: b.counts.jobsNoSubmission },
      lateItems: b.items.filter((i) => i.status === 'late').slice(0, 5).map((i) => ({ candidate: i.candidate, job: i.job, step: i.step, daysLate: i.daysLate })),
      jobsNoSubmissionToday: myJobs.length,
      joinTarget: row ? { joinings: row.joinings, target: row.target } : null,
      active,
      noActivity: !active,
    };
  });

  const callTeam = { total: 0, connected: 0, notConnected: 0, candidates: 0, talkMinutes: 0, outcomes: {} };
  people.forEach((p) => {
    callTeam.total += p.calls.total; callTeam.connected += p.calls.connected; callTeam.notConnected += p.calls.notConnected;
    callTeam.candidates += p.calls.candidates; callTeam.talkMinutes += p.calls.talkMinutes;
    Object.entries(p.calls.outcomes).forEach(([k, v]) => { callTeam.outcomes[k] = (callTeam.outcomes[k] || 0) + v; });
  });
  const sum = (f) => people.reduce((n, p) => n + f(p), 0);
  const pend = PW.totalsOf(team.blocks);
  const joinRows = board ? board.rows.filter((r) => ids.includes(r.userId)) : [];
  const t = {
    calls: callTeam.total,
    callsConnected: callTeam.connected,
    mails: total.mails,
    whatsapp: total.whatsapp,
    sms: sum((p) => p.other.sms),
    followUpsDone: total.followUps,
    followUpsDueToday: sum((p) => p.followUps.dueToday),
    followUpsOpenDue: sum((p) => p.followUps.openDue),
    sentTl: total.sentTl,
    sentClient: total.sentClient,
    interviews: total.interviews,
    interviewsDone: total.attended,
    selected: sum((p) => p.selected),
    offers: total.offers,
    joined: total.joined,
    rejected: sum((p) => p.rejected),
    hold: sum((p) => p.hold),
    stepsMoved: sum((p) => p.stepsMoved),
    jobsNoSubmission: jobs.length,
  };
  const quietDay = !people.some((p) => p.active) && !pend.waiting;
  return {
    version: 1,
    kind: 'recruiting',
    day,
    generatedAt: new Date().toISOString(),
    tl: { id: tlId, name: tlUser.name },
    scope: `${team.blocks.length} recruiter${team.blocks.length === 1 ? '' : 's'}`,
    team: {
      totals: t,
      previous: { day: prevDay, calls: totalPrev.calls, sentTl: totalPrev.sentTl, sentClient: totalPrev.sentClient, interviews: totalPrev.interviews, interviewsDone: totalPrev.attended, offers: totalPrev.offers, joined: totalPrev.joined, followUpsDone: totalPrev.followUps, mails: totalPrev.mails, whatsapp: totalPrev.whatsapp },
      month: { month, calls: totalMtd.calls, sentClient: totalMtd.sentClient, interviews: totalMtd.interviews, joined: totalMtd.joined, followUpsDone: totalMtd.followUps },
      joiningTarget: joinRows.length ? { joinings: joinRows.reduce((n, r) => n + (r.joinings || 0), 0), target: joinRows.reduce((n, r) => n + (r.target || 0), 0) } : null,
      pending: { late: pend.late, dueToday: pend.dueToday, waiting: pend.waiting, notMoving: pend.notMoving, followUpsLate: pend.followUpsLate, jobsNoProfile: pend.jobsNoSubmission },
      slaBreaches: pend.late,
      jobsNoSubmissionList: jobs.slice(0, 10),
    },
    calls: { team: callTeam, groups: CALL_GROUPS },
    people,
    noActivity: people.filter((p) => p.noActivity).map((p) => p.name),
    quiet: quietDay,
    pendingNote: 'Waiting, Due today and Late are the numbers of the dashboard Team snapshot, taken when this report was made.',
    missingDailyNote: 'TeamLink has no recruiter-typed daily report: each block shows the work the person did. "No activity" means no call, no step moved, no follow-up and no message today.',
  };
}

// ---------------------------------------------------------------------------
// BUILD — the BDE desk of the BDE TL (client work, no recruiters, no candidate calls).
// ---------------------------------------------------------------------------
async function buildBdeReport({ tlId, day, viewer = null }) {
  const CW = require('./clientWork'); // eslint-disable-line global-require
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const settings = await PW.getSettings();
  const tlUser = (await PW.usersById([tlId])).get(tlId);
  if (!tlUser) return { error: 'No such team lead.' };
  const bdeTlViewer = await resolveIdentity(tlId);
  const TW = require('./teamWorkload'); // eslint-disable-line global-require
  const world = await TW.teamWorld(bdeTlViewer);
  const testViewer = isTest(`${bdeTlViewer.name || ''} ${bdeTlViewer.email || ''}`);
  const bdes = world.people.filter((p) => p.roleGroup === 'BDE' && p.status === 'Active' && (testViewer || !isTest(p.name)));
  const ids = bdes.map((p) => p.id);
  const load = await AH.pendingLoad(bdeTlViewer, { by: 'bde' });
  const from = istStart(day);
  const to = istStart(addDays(day, 1));
  const [audits, evs, fus, feedback] = await Promise.all([
    prisma.auditLog.findMany({ where: { userId: { in: ids }, createdAt: { gte: from, lt: to }, OR: [{ entity: 'Client' }, { action: { startsWith: 'Requirement requested' } }] }, select: { userId: true, action: true, entity: true } }),
    prisma.applicationStageEvent.findMany({ where: { actorUserId: { in: ids }, createdAt: { gte: from, lt: to } }, select: { actorUserId: true, toStage: true, fromStage: true } }),
    prisma.applicationFollowUp.findMany({ where: { completedById: { in: ids }, completedAt: { gte: from, lt: to } }, select: { completedById: true } }),
    prisma.interviewFeedback.findMany({ where: { submittedById: { in: ids }, kind: 'Client', createdAt: { gte: from, lt: to } }, select: { submittedById: true } }),
  ]);
  const people = [];
  for (const p of bdes) {
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(p.id).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    const pend = id ? await CW.bdePending(id, { settings }) : null;
    const mine = audits.filter((a) => a.userId === p.id);
    const ev = evs.filter((e) => e.actorUserId === p.id && e.fromStage !== e.toStage);
    const g = load.people.find((e) => e.userId === p.id);
    const row = {
      userId: p.id,
      name: p.name,
      seat: p.seatLabel || null,
      clientContacts: mine.filter((a) => /call|message|whatsapp|sms|mail/i.test(a.action)).length,
      clientNotes: mine.filter((a) => a.action === 'Client note').length,
      agreementsSent: mine.filter((a) => /agreement.*(sent|link)|link.*sent/i.test(a.action)).length,
      sentToClient: ev.filter((e) => e.toStage === 'SHARED_WITH_CLIENT').length,
      interviewsSet: ev.filter((e) => e.toStage === 'INTERVIEW_SCHEDULED').length,
      clientFeedbackSaved: feedback.filter((f) => f.submittedById === p.id).length,
      followUpsDone: fus.filter((f) => f.completedById === p.id).length,
      stepsMoved: ev.length,
      pending: pend ? pend.counts : {},
      pendingTotal: pend ? pend.total : 0,
      waiting: g ? g.pending.length : 0,
      late: g ? g.overdue.length : 0,
      dueToday: g ? g.dueToday.length : 0,
    };
    row.active = !!(row.clientContacts || row.clientNotes || row.agreementsSent || row.sentToClient || row.interviewsSet || row.clientFeedbackSaved || row.followUpsDone || row.stepsMoved);
    row.noActivity = !row.active;
    people.push(row);
  }
  const sum = (k) => people.reduce((n, p) => n + (p[k] || 0), 0);
  return {
    version: 1,
    kind: 'bde',
    day,
    generatedAt: new Date().toISOString(),
    tl: { id: tlId, name: tlUser.name },
    scope: `${people.length} client manager${people.length === 1 ? '' : 's'} (BDE desk)`,
    team: {
      totals: {
        clientContacts: sum('clientContacts'), clientNotes: sum('clientNotes'), agreementsSent: sum('agreementsSent'), sentToClient: sum('sentToClient'),
        interviewsSet: sum('interviewsSet'), clientFeedbackSaved: sum('clientFeedbackSaved'), followUpsDone: sum('followUpsDone'), stepsMoved: sum('stepsMoved'),
      },
      pending: { late: sum('late'), dueToday: sum('dueToday'), waiting: sum('waiting'), clientWork: sum('pendingTotal') },
      previous: null, month: null, joiningTarget: null,
    },
    calls: null,
    people,
    noActivity: people.filter((p) => p.noActivity).map((p) => p.name),
    quiet: !people.some((p) => p.active) && !sum('pendingTotal'),
    pendingNote: 'Waiting, Due today and Late are the numbers of the BDE team on the dashboard. Client work waiting is the BDE digest.',
  };
}

// ---------------------------------------------------------------------------
// RENDER — HTML, text, Excel
// ---------------------------------------------------------------------------
const delta = (a, b) => (b === null || b === undefined ? '' : (a === b ? 'same' : `${a > b ? '+' : ''}${a - b}`));

function recruitingRows(r) {
  const t = r.team.totals;
  const p = r.team.previous || {};
  const m = r.team.month || {};
  const tg = r.team.joiningTarget;
  const pd = r.team.pending;
  return [
    ['Calls made', t.calls, p.calls, m.calls],
    ['Calls connected', t.callsConnected, null, null],
    ['Mails to candidates', t.mails, p.mails, null],
    ['WhatsApp to candidates', t.whatsapp, p.whatsapp, null],
    ['SMS to candidates', t.sms, null, null],
    ['Follow-ups done', t.followUpsDone, p.followUpsDone, m.followUpsDone],
    ['Follow-ups due today', t.followUpsDueToday, null, null],
    ['Moved to team lead check', t.sentTl, p.sentTl, null],
    ['Sent to client', t.sentClient, p.sentClient, m.sentClient],
    ['Interviews fixed', t.interviews, p.interviews, m.interviews],
    ['Interviews done', t.interviewsDone, p.interviewsDone, null],
    ['Selected', t.selected, null, null],
    ['Offers', t.offers, p.offers, null],
    ['Joined', t.joined, p.joined, m.joined],
    ['Rejected', t.rejected, null, null],
    ['On hold', t.hold, null, null],
    ['Steps moved (all)', t.stepsMoved, null, null],
    ['Jobs with no profile sent today', t.jobsNoSubmission, null, null],
    ['Late (SLA broken) now', pd.late, null, null],
    ['Due today now', pd.dueToday, null, null],
    ['Waiting now', pd.waiting, null, null],
    ...(tg ? [['Joinings this month vs target', `${tg.joinings} of ${tg.target}`, null, null]] : []),
  ];
}
const bdeRows = (r) => {
  const t = r.team.totals;
  const pd = r.team.pending;
  return [
    ['Client contacts logged (calls, messages)', t.clientContacts],
    ['Client notes added', t.clientNotes],
    ['Agreements sent', t.agreementsSent],
    ['Candidates sent to clients', t.sentToClient],
    ['Client interviews fixed', t.interviewsSet],
    ['Client feedback saved', t.clientFeedbackSaved],
    ['Follow-ups done', t.followUpsDone],
    ['Steps moved (all)', t.stepsMoved],
    ['Client work waiting now', pd.clientWork],
    ['Late now', pd.late],
    ['Due today now', pd.dueToday],
    ['Waiting now', pd.waiting],
  ];
};

function headline(r) {
  if (r.kind === 'bde') {
    const t = r.team.totals;
    return `${t.sentToClient} sent to clients · ${t.interviewsSet} interviews fixed · ${t.clientContacts} client contacts · ${r.team.pending.clientWork} client items waiting · ${r.team.pending.late} late`;
  }
  const t = r.team.totals;
  return `${t.calls} calls (${t.callsConnected} connected) · ${t.sentClient} sent to client · ${t.interviews} interviews · ${t.joined} joined · ${r.team.pending.late} late · ${r.team.pending.waiting} waiting`;
}

function renderText(r, base = '') {
  const L = [];
  L.push(`End-of-day report — ${PW.niceDay(r.day)}`, `${r.tl.name}'s ${r.kind === 'bde' ? 'BDE desk' : 'team'} (${r.scope})`, '');
  if (r.quiet) {
    L.push('No activity was recorded today and nothing is waiting.');
    return L.join('\n');
  }
  L.push(headline(r), '');
  if (r.kind === 'bde') {
    L.push('TEAM REPORT');
    bdeRows(r).forEach(([k, v]) => L.push(`  ${k}: ${v}`));
    L.push('', 'INDIVIDUAL REPORTS (BDE)');
    r.people.forEach((p) => L.push(`  ${p.name}${p.seat ? ` (${p.seat})` : ''}: ${p.noActivity ? 'no activity today' : `${p.clientContacts} client contacts, ${p.sentToClient} sent to clients, ${p.interviewsSet} interviews fixed, ${p.followUpsDone} follow-ups`}; waiting ${p.pendingTotal} client items`));
  } else {
    const prev = r.team.previous;
    L.push(`TEAM REPORT (vs ${prev ? PW.niceDay(prev.day) : 'the last working day'}, and the month so far)`);
    recruitingRows(r).forEach(([k, v, pv, mv]) => L.push(`  ${k}: ${v}${pv !== null && pv !== undefined ? ` (before: ${pv}, ${delta(v, pv)})` : ''}${mv !== null && mv !== undefined ? ` · month ${mv}` : ''}`));
    L.push('', 'CALL REPORT');
    L.push(`  Team: ${r.calls.team.total} calls, ${r.calls.team.connected} connected, ${r.calls.team.candidates} candidates called, ${r.calls.team.talkMinutes} min talk time`);
    r.people.forEach((p) => {
      const o = Object.entries(p.calls.outcomes).map(([k, v]) => `${(CALL_GROUPS.find((g) => g.id === k) || {}).label || k} ${v}`).join(', ');
      L.push(`  ${p.name}: ${p.calls.total} calls${p.calls.total ? ` (${p.calls.connected} connected${o ? `; ${o}` : ''}; last at ${p.calls.lastCallAt || '—'})` : ''}${p.calls.dueNotCalled ? `; ${p.calls.dueNotCalled} due for a call, not called` : ''}`);
    });
    L.push('', 'INDIVIDUAL REPORTS');
    r.people.forEach((p) => L.push(`  ${p.name}: ${p.noActivity ? 'NO ACTIVITY TODAY. ' : ''}steps moved ${p.stepsMoved}, sent to client ${p.sentClient}, interviews ${p.interviews}, selected ${p.selected}, joined ${p.joined}; waiting ${p.pending.waiting}, late ${p.pending.late}; follow-ups due and not done ${p.followUps.openDue}`));
  }
  if (r.noActivity.length) L.push('', `No activity today: ${r.noActivity.join(', ')}`);
  L.push('', `Open in TeamLink: ${base ? `${base}` : ''}/reports/ats?tab=daily&view=eod&day=${r.day}`);
  return L.join('\n');
}

function renderHtml(r, base = '') {
  const title = `End-of-day report — ${PW.niceDay(r.day)}`;
  const link = `${base}/reports/ats?tab=daily&view=eod&day=${r.day}`;
  if (r.quiet) return M.page(title, `${M.p(`${r.tl.name}'s ${r.kind === 'bde' ? 'BDE desk' : 'team'}: no activity was recorded today and nothing is waiting.`)}${M.button(link, 'Open the report')}`);
  let inner = M.p(`${r.tl.name}'s ${r.kind === 'bde' ? 'BDE desk' : 'team'} · ${r.scope}`);
  if (r.kind === 'bde') {
    const t = r.team.totals;
    inner += M.stats([
      { label: 'Sent to clients', value: t.sentToClient, tone: 'blue' },
      { label: 'Interviews fixed', value: t.interviewsSet, tone: 'blue' },
      { label: 'Client items waiting', value: r.team.pending.clientWork, tone: r.team.pending.clientWork ? 'orange' : 'green' },
      { label: 'Late', value: r.team.pending.late, tone: r.team.pending.late ? 'red' : 'green' },
    ]);
    inner += M.h2('Team report') + M.table(['', 'Today'], bdeRows(r), { right: [1] });
    inner += M.h2('Individual reports') + M.table(['Client manager (BDE)', 'Contacts', 'Sent to clients', 'Interviews', 'Waiting'], r.people.map((p) => [
      { html: `<b>${M.esc(p.name)}</b>${p.seat ? `<div style="color:#6b7280;font-size:11px">${M.esc(p.seat)}</div>` : ''}${p.noActivity ? `<div>${M.pill('No activity today', 'orange')}</div>` : ''}` },
      p.clientContacts, p.sentToClient, p.interviewsSet, p.pendingTotal,
    ]), { right: [1, 2, 3, 4] });
  } else {
    const t = r.team.totals;
    inner += M.stats([
      { label: 'Calls', value: t.calls, tone: 'blue' },
      { label: 'Sent to client', value: t.sentClient, tone: 'blue' },
      { label: 'Interviews', value: t.interviews, tone: 'blue' },
      { label: 'Joined', value: t.joined, tone: t.joined ? 'green' : 'grey' },
      { label: 'Late', value: r.team.pending.late, tone: r.team.pending.late ? 'red' : 'green' },
    ]);
    const prev = r.team.previous;
    inner += M.h2('Team report') + M.p(`Today against ${prev ? PW.niceDay(prev.day) : 'the last working day'} and the month so far.`);
    inner += M.table(['', 'Today', 'Before', 'Change', 'Month'], recruitingRows(r).map(([k, v, pv, mv]) => [k, v, pv === null || pv === undefined ? '' : pv, pv === null || pv === undefined ? '' : delta(v, pv), mv === null || mv === undefined ? '' : mv]), { right: [1, 2, 3, 4] });
    inner += M.h2('Call report');
    inner += M.p(`${r.calls.team.total} calls, ${r.calls.team.connected} connected, ${r.calls.team.candidates} different candidates, ${r.calls.team.talkMinutes} minutes of talk time.`);
    inner += M.table(['Recruiter', 'Calls', 'Spoke', 'Not reached', 'Interested', 'Last call', 'Due, not called'], r.people.map((p) => [
      p.name, p.calls.total, p.calls.connected, p.calls.notConnected, p.calls.outcomes.interested || 0, p.calls.lastCallAt || '—', p.calls.dueNotCalled,
    ]), { right: [1, 2, 3, 4, 6] });
    const outcomes = CALL_GROUPS.filter((g) => r.calls.team.outcomes[g.id]).map((g) => `${g.label} ${r.calls.team.outcomes[g.id]}`).join(' · ');
    if (outcomes) inner += M.p(outcomes);
    inner += M.h2('Individual reports');
    inner += r.people.map((p) => `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;margin:6px 0"><tr><td style="padding:8px 10px;font-size:13px"><b>${M.esc(p.name)}</b>${p.noActivity ? ` ${M.pill('No activity today', 'orange')}` : ''}
<div style="color:#374151;margin-top:3px">Calls ${p.calls.total} (${p.calls.connected} spoke) · steps moved ${p.stepsMoved} · sent to client ${p.sentClient} · interviews ${p.interviews} · selected ${p.selected} · joined ${p.joined}</div>
<div style="color:#374151">Waiting ${p.pending.waiting} · late ${M.esc(p.pending.late)} · follow-ups due, not done ${p.followUps.openDue}${p.jobsNoSubmissionToday ? ` · jobs with no profile sent today ${p.jobsNoSubmissionToday}` : ''}</div>
${p.lateItems.length ? `<div style="color:#b91c1c;font-size:12px;margin-top:3px">Late: ${p.lateItems.map((i) => `${M.esc(i.candidate)} (${M.esc(i.step)}, ${i.daysLate}d)`).join('; ')}</div>` : ''}</td></tr></table>`).join('');
  }
  if (r.noActivity.length) inner += M.p(`No activity today: ${r.noActivity.join(', ')}.`);
  inner += M.p(r.pendingNote) + M.button(link, 'Open the full report');
  return M.page(title, inner, { footer: 'The Excel file with every table is attached. The numbers are the same as on your screens.' });
}

function workbook(r) {
  const sheets = [];
  if (r.kind === 'bde') {
    sheets.push({ name: 'Team report', headers: ['What', 'Today'], rows: bdeRows(r) });
    sheets.push({
      name: 'Individual',
      headers: ['Client manager (BDE)', 'Seat', 'Client contacts', 'Client notes', 'Agreements sent', 'Sent to clients', 'Interviews fixed', 'Client feedback saved', 'Follow-ups done', 'Steps moved', 'Client work waiting', 'Waiting', 'Due today', 'Late', 'Activity'],
      rows: r.people.map((p) => [p.name, p.seat || '', p.clientContacts, p.clientNotes, p.agreementsSent, p.sentToClient, p.interviewsSet, p.clientFeedbackSaved, p.followUpsDone, p.stepsMoved, p.pendingTotal, p.waiting, p.dueToday, p.late, p.noActivity ? 'No activity' : 'Active']),
    });
    return sheets;
  }
  sheets.push({
    name: 'Team report',
    headers: ['What', 'Today', `Before (${r.team.previous ? r.team.previous.day : ''})`, 'Change', `Month so far (${r.team.month ? r.team.month.month : ''})`],
    rows: recruitingRows(r).map(([k, v, pv, mv]) => [k, v, pv === null || pv === undefined ? '' : pv, pv === null || pv === undefined ? '' : delta(v, pv), mv === null || mv === undefined ? '' : mv]),
  });
  sheets.push({
    name: 'Call report',
    headers: ['Recruiter', 'Calls', 'Spoke (connected)', 'Not reached', ...CALL_GROUPS.map((g) => g.label), 'Candidates called', 'Talk time (min)', 'Last call', 'Due for a call, not called', 'Mails', 'WhatsApp', 'SMS'],
    rows: [
      ...r.people.map((p) => [p.name, p.calls.total, p.calls.connected, p.calls.notConnected, ...CALL_GROUPS.map((g) => p.calls.outcomes[g.id] || 0), p.calls.candidates, p.calls.talkMinutes, p.calls.lastCallAt || '', p.calls.dueNotCalled, p.other.mails, p.other.whatsapp, p.other.sms]),
      ['Team', r.calls.team.total, r.calls.team.connected, r.calls.team.notConnected, ...CALL_GROUPS.map((g) => r.calls.team.outcomes[g.id] || 0), r.calls.team.candidates, r.calls.team.talkMinutes, '', r.people.reduce((n, p) => n + p.calls.dueNotCalled, 0), r.team.totals.mails, r.team.totals.whatsapp, r.team.totals.sms],
    ],
  });
  sheets.push({
    name: 'Individual',
    headers: ['Recruiter', 'Calls', 'Spoke', 'Steps moved', 'Sent to team lead', 'Sent to client', 'Interviews fixed', 'Interviews done', 'Selected', 'Offers', 'Joined', 'Rejected', 'On hold', 'Follow-ups done', 'Follow-ups due today', 'Follow-ups due, not done', 'Waiting', 'Due today', 'Late', 'Jobs with no profile sent', 'Activity'],
    rows: r.people.map((p) => [p.name, p.calls.total, p.calls.connected, p.stepsMoved, p.sentTl, p.sentClient, p.interviews, p.interviewsDone, p.selected, p.offers, p.joined, p.rejected, p.hold, p.followUps.done, p.followUps.dueToday, p.followUps.openDue, p.pending.waiting, p.pending.dueToday, p.pending.late, p.pending.jobsNoProfile, p.noActivity ? 'No activity' : 'Active']),
  });
  sheets.push({
    name: 'Late items',
    headers: ['Recruiter', 'Candidate', 'Job', 'Step', 'Days late'],
    rows: r.people.flatMap((p) => p.lateItems.map((i) => [p.name, i.candidate, i.job, i.step, i.daysLate])),
  });
  return sheets;
}
const toXlsx = (r) => toXlsxBook(workbook(r));

// ---------------------------------------------------------------------------
// STORE / READ the snapshots
// ---------------------------------------------------------------------------
async function saveSnapshot(r) {
  const value = JSON.stringify(r);
  await prisma.appSetting.upsert({ where: { key: KEY(r.tl.id, r.day) }, update: { value }, create: { key: KEY(r.tl.id, r.day), value } });
}
async function readSnapshot(tlId, day) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(tlId, day) } }).catch(() => null);
  try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; }
}
async function listDays(tlId) {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: `eod.${tlId}.` } }, select: { key: true, updatedAt: true }, orderBy: { key: 'desc' }, take: 90 });
  return rows.map((x) => x.key.split('.').pop());
}
async function pruneSnapshots(day) {
  const cut = addDays(day, -KEEP_DAYS);
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'eod.' } }, select: { key: true } }).catch(() => []);
  const old = rows.filter((x) => x.key.split('.').pop() < cut).map((x) => x.key);
  if (old.length) await prisma.appSetting.deleteMany({ where: { key: { in: old } } }).catch(() => null);
}

// ---------------------------------------------------------------------------
// SEND — one report to its TL (+ copies); dedupe once a day unless `force`.
// ---------------------------------------------------------------------------
async function sendReport(report, { settings, tlUser, mailer = null, testMode = false, dryRun = false, copies = true, out = null } = {}) {
  const base = PW.absolute('');
  const title = `End-of-day report — ${PW.niceDay(report.day)}`;
  const text = renderText(report, base);
  const html = renderHtml(report, base);
  const attachments = settings.eod.excel && !report.quiet ? [{ filename: `end-of-day-${report.day}-${report.tl.name.replace(/[^A-Za-z0-9]+/g, '-')}.xlsx`, content: toXlsx(report), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] : [];
  const bell = report.quiet ? 'No activity today and nothing waiting.' : `${headline(report)}.${report.noActivity.length ? ` No activity: ${report.noActivity.slice(0, 3).join(', ')}${report.noActivity.length > 3 ? '…' : ''}.` : ''}`;
  const openPath = `/reports/ats?tab=daily&view=eod&day=${report.day}`;
  const res = { to: tlUser.name, delivered: null, copies: 0 };
  res.delivered = await PW.deliver({ settings, user: tlUser, title, bell, text, html, attachments, openPath, key: `pwr|eod|${report.day}`, mailer, dryRun, testMode, out });
  if (copies) {
    const { stls, managers } = await PW.stlsAndManagers(tlUser.atsDepartment || report.dept || (report.people[0] && report.people[0].department));
    const list = [...(settings.eod.copyStl ? stls : []), ...(settings.eod.copyManager ? managers : [])].filter((u) => u.id !== tlUser.id && (testMode || !isTest(`${u.name} ${u.email}`)));
    for (const u of list) {
      // eslint-disable-next-line no-await-in-loop
      await PW.deliver({ settings, user: u, title: `Copy: ${report.tl.name}'s ${title}`, bell, text: `Copy of ${report.tl.name}'s report.\n\n${text}`, html, attachments, openPath, key: `pwr|eod-copy|${report.day}`, mailer, dryRun, testMode, out });
      res.copies += 1;
    }
  }
  return res;
}

let EOD_RUNNING = false;
async function runAll({ now = new Date(), viewer = null, mailer = null, testMode = false, dryRun = false, force = false, only = null, people = null } = {}) {
  const settings = await PW.getSettings({ fresh: true });
  const day = PW.dayOfIst(now);
  const out = { day, sent: 0, bell: 0, emails: 0, emailsNotSent: 0, duplicates: 0, skippedQuiet: 0, off: 0, teams: [] };
  if (!(settings.enabled && settings.eod.enabled) && !force) return { ...out, skipped: 'The end-of-day report is switched off.' };
  const off = await PW.offDayReason(day);
  if (off && !force) return { ...out, skipped: `${off}: no end-of-day report today.` };
  if (EOD_RUNNING && !dryRun) return { ...out, skipped: 'already running' };
  EOD_RUNNING = !dryRun;
  try {
    const vw = await PW.pickViewer(viewer);
    if (!vw) return { ...out, skipped: 'No Super Admin login to read the company with.' };
    const c = await PW.collectTeams({ viewer: vw, only, people });
    const tlUsers = await PW.usersById([...c.teams.keys()]);
    for (const [tlId, team] of c.teams.entries()) {
      const row = { tl: team.tl.name, status: '' };
      out.teams.push(row);
      const tlUser = tlUsers.get(tlId);
      if (!tlUser) { row.status = 'no login'; continue; } // eslint-disable-line no-continue
      if (settings.eod.offTls.includes(tlId) && !force) { row.status = 'switched off for this team lead'; out.off += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!dryRun && !force && !(await PW.claim(day, 'eod', tlId))) { row.status = 'already sent today'; out.duplicates += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const report = await buildTeamReport({ tlId, day, viewer: vw, collected: { ...c, teams: new Map([[tlId, team]]) } });
      if (report.error) { row.status = report.error; continue; } // eslint-disable-line no-continue
      if (report.quiet && settings.eod.quiet === 'skip') { row.status = 'no activity (skipped)'; out.skippedQuiet += 1; continue; } // eslint-disable-line no-continue
      if (!dryRun) await saveSnapshot(report); // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      row.delivered = await sendReport(report, { settings, tlUser, mailer, testMode, dryRun, out });
      row.status = dryRun ? 'would send' : (report.quiet ? 'sent (no activity)' : 'sent');
      if (!dryRun) out.sent += 1;
    }
    // The BDE TL(s): the BDE desk.
    const CW = require('./clientWork'); // eslint-disable-line global-require
    const bdeStaff = await CW.bdePeople();
    for (const t of bdeStaff.filter((p) => p.isTl && (testMode || !isTest(`${p.user.name} ${p.user.email}`)))) {
      if (people || (only && only !== t.user.id)) continue; // eslint-disable-line no-continue
      const row = { tl: t.user.name, status: '', bde: true };
      out.teams.push(row);
      if (settings.eod.offTls.includes(t.user.id) && !force) { row.status = 'switched off for this team lead'; out.off += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!dryRun && !force && !(await PW.claim(day, 'eod', t.user.id))) { row.status = 'already sent today'; out.duplicates += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const report = await buildBdeReport({ tlId: t.user.id, day, viewer: vw });
      if (report.error) { row.status = report.error; continue; } // eslint-disable-line no-continue
      if (report.quiet && settings.eod.quiet === 'skip') { row.status = 'no activity (skipped)'; out.skippedQuiet += 1; continue; } // eslint-disable-line no-continue
      if (!dryRun) await saveSnapshot(report); // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      row.delivered = await sendReport(report, { settings, tlUser: t.user, mailer, testMode, dryRun, copies: false, out });
      row.status = dryRun ? 'would send' : 'sent';
      if (!dryRun) out.sent += 1;
    }
    if (!dryRun) await pruneSnapshots(day).catch(() => null);
    return out;
  } finally {
    if (!dryRun) EOD_RUNNING = false;
  }
}

// "Send now" / "Send again": one team lead, today or a past day, no dedupe (the caller decided).
async function sendNow({ tlId, day = null, viewer = null, mailer = null, testMode = false, toSelfOnly = false, requester = null }) {
  const settings = await PW.getSettings({ fresh: true });
  const useDay = day || PW.dayOfIst(new Date());
  const tlUser = (await PW.usersById([tlId])).get(tlId);
  if (!tlUser) return { status: 404, body: { error: 'No such team lead.' } };
  const report = await loadOrBuild({ tlId, day: useDay, viewer, fresh: !day || useDay === PW.dayOfIst(new Date()) });
  if (report.error) return { status: 400, body: { error: report.error } };
  await saveSnapshot(report);
  const target = toSelfOnly && requester ? requester : tlUser;
  const out = {};
  const r = await sendReport(report, { settings: { ...settings, bell: true }, tlUser: target, mailer, testMode: testMode || isTest(`${target.name} ${target.email}`), copies: !toSelfOnly, out });
  return { status: 200, body: { ok: true, day: useDay, sentTo: target.name, delivered: r.delivered, copies: r.copies } };
}

// Build a report for a TL / day: today's is built now; a past day's comes from its snapshot, else is
// rebuilt from the records (everything but the pending numbers is a record of that day).
async function loadOrBuild({ tlId, day, viewer = null, fresh = false }) {
  if (!fresh) {
    const snap = await readSnapshot(tlId, day);
    if (snap) return snap;
  }
  const vw = await PW.pickViewer(viewer);
  const CW = require('./clientWork'); // eslint-disable-line global-require
  const people = await CW.bdePeople();
  const isBdeTl = people.some((p) => p.isTl && p.user.id === tlId);
  const report = isBdeTl ? await buildBdeReport({ tlId, day, viewer: vw }) : await buildTeamReport({ tlId, day, viewer: vw });
  if (!report.error && day !== PW.dayOfIst(new Date())) report.rebuilt = true;
  return report;
}

module.exports = {
  CALL_GROUPS, callOutcome, talkSeconds, buildTeamReport, buildBdeReport, renderText, renderHtml, workbook, toXlsx, headline,
  saveSnapshot, readSnapshot, listDays, loadOrBuild, sendReport, sendNow, runAll, previousWorkingDay, KEY,
};
