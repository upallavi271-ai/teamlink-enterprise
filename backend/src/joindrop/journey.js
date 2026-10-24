// ---------------------------------------------------------------------------
// THE CANDIDATE'S JOURNEY (read-only) - ONE milestone list for one application, derived from what is already on file:
//   Candidate / Application (created, source), ApplicationStageEvent (every move, who, when), InterviewEvent + the interview fields on the
//   application (scheduled / moved / completed, round, mode, interviewer, place), InterviewFeedback (outcome; the client's own feedback),
//   OfferVersion + the offer fields (offer made / accepted), and the JoiningRecord + its history (joined, dropped, the client's decision).
//
// RULES
//   * A date that is not in the data is never invented: a step that clearly happened (a later step exists) but has no date shows "Not recorded";
//     a step that simply has not come yet shows "Not yet".
//   * Each milestone: label, day, the exact time, who did it, a plain detail, a state (Done / Not yet / Not recorded).
//   * Between the key milestones the elapsed days are shown ("BDE to client: 2 days").
//   * An internal hire has no BDE / client steps: they are left out (not shown as pending).
//   * The BDE team never gets the internal panel's scores or feedback words, only the outcome the pipeline already shows (Selected / Rejected / Hold).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./vocab');
const S = require('./schema');

const IST = 330 * 60000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const dayOnly = (s) => (V.isDay(String(s || '').slice(0, 10)) ? String(s).slice(0, 10) : null);
const firstEv = (evs, pred) => (evs || []).find(pred) || null;
const lastEv = (evs, pred) => [...(evs || [])].reverse().find(pred) || null;

// The key dates of many applications at once (the Joining list and the report, CSV): one query for all stage events.
async function keyDates(appIds) {
  const out = new Map();
  if (!appIds.length) return out;
  const evs = await prisma.applicationStageEvent.findMany({
    where: { applicationId: { in: appIds } },
    select: { applicationId: true, toStage: true, createdAt: true, actorSide: true },
    orderBy: { createdAt: 'asc' },
  });
  const apps = await prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, createdAt: true, interviewAt: true, offerDate: true, offerAcceptedAt: true, joiningDate: true } });
  const ie = await prisma.interviewEvent.findMany({ where: { applicationId: { in: appIds }, status: { in: ['SCHEDULED', 'RESCHEDULED'] } }, select: { applicationId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
  const by = new Map();
  evs.forEach((e) => { if (!by.has(e.applicationId)) by.set(e.applicationId, []); by.get(e.applicationId).push(e); });
  const ieBy = new Map();
  ie.forEach((e) => { if (!ieBy.has(e.applicationId)) ieBy.set(e.applicationId, e); });
  apps.forEach((a) => {
    const list = by.get(a.id) || [];
    const at = (stage) => { const e = firstEv(list, (x) => x.toStage === stage); return e ? istDay(e.createdAt) : null; };
    out.set(a.id, {
      cameOn: istDay(a.createdAt),
      bdeOn: at('WITH_BDE') || at('BDE_APPROVED'),
      sentToClientOn: at('SHARED_WITH_CLIENT'),
      firstInterviewOn: ieBy.has(a.id) ? istDay(ieBy.get(a.id).createdAt) : at('INTERVIEW_SCHEDULED'),
      offerOn: at('OFFER') || dayOnly(a.offerDate),
      offerAcceptedOn: at('OFFER_ACCEPTED') || istDay(a.offerAcceptedAt),
    });
  });
  return out;
}

// opts: { forBde }
async function journey(applicationId, { forBde = false } = {}) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      candidate: { select: { id: true, name: true, createdAt: true, source: true, firstSource: true } },
      requirement: { select: { id: true, title: true, internal: true, hiringType: true, clientId: true, client: { select: { name: true } } } },
      stageEvents: { orderBy: { createdAt: 'asc' } },
      interviewEvents: { orderBy: { createdAt: 'asc' } },
      interviewFeedbacks: true,
      offerVersions: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!app) return null;
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const internal = J.isInternalHire(app, app.requirement);
  const evs = app.stageEvents || [];
  const rec = await S.one('SELECT * FROM "JoiningRecord" WHERE "applicationId" = ?', applicationId);
  const events = rec ? await S.rows('SELECT * FROM "JoiningEvent" WHERE "recordId" = ? ORDER BY "at" ASC', rec.id) : [];
  const ms = [];
  const add = (m) => ms.push({
    key: m.key, label: m.label, at: m.at || null, day: m.at ? istDay(m.at) : (m.day || null), who: m.who || null, detail: m.detail || null, phase: m.phase, state: m.at || m.day ? 'Done' : (m.state || 'Not yet'),
  });
  const stage = (to, p) => firstEv(evs, (e) => e.toStage === to && (!p || p(e)));
  const who = (e) => (e ? [e.actorName, e.actorSide === 'Client' ? '(client)' : ''].filter(Boolean).join(' ') || null : null);

  // 1 came to us
  const cand = app.candidate;
  add({
    key: 'came', label: 'Candidate came to us', at: iso(cand.createdAt), who: null, phase: 'Start',
    detail: `Source: ${cand.firstSource || cand.source || 'Not recorded'}`,
  });
  add({
    key: 'added', label: 'Added to this requirement in ATS', at: iso(app.createdAt), who: who(evs[0]), phase: 'Start',
    detail: `${app.source || 'Source not recorded'}${app.applicationMethod ? ` · ${app.applicationMethod}` : ''}`,
  });
  if (app.portalImportedAt) add({ key: 'portal', label: 'Sent to ATS from the job portal', at: iso(app.portalImportedAt), phase: 'Start' });
  if (!internal) {
    const bde = stage('WITH_BDE') || stage('BDE_APPROVED');
    add({ key: 'bde', label: 'Reached the BDE', at: iso(bde && bde.createdAt), who: who(bde), phase: 'BDE', state: 'Not yet' });
    const sent = stage('SHARED_WITH_CLIENT');
    add({ key: 'client', label: 'Sent to the client', at: iso(sent && sent.createdAt), who: who(sent), phase: 'Client', state: 'Not yet' });
    const screen = stage('CLIENT_SHORTLISTED') || firstEv(evs, (e) => e.actorSide === 'Client');
    add({
      key: 'screening', label: "Client's screening decision", at: iso(screen && screen.createdAt), who: who(screen), phase: 'Client', state: 'Not yet',
      detail: screen ? (screen.action || null) : null,
    });
    const cf = (app.interviewFeedbacks || []).find((f) => f.kind === 'Client');
    if (cf) add({ key: 'clientFeedback', label: "Client's interview feedback", at: iso(cf.updatedAt || cf.createdAt), who: cf.submittedBy || null, phase: 'Interview', detail: `Client says: ${cf.recommendation}` });
  }
  // interviews
  const sched = (app.interviewEvents || []).filter((e) => ['SCHEDULED', 'RESCHEDULED'].includes(e.status));
  const done = (app.interviewEvents || []).filter((e) => e.status === 'COMPLETED');
  sched.forEach((e, i) => {
    add({
      key: `interview-${e.id}`, label: e.status === 'RESCHEDULED' ? 'Interview moved' : (i === 0 ? 'Interview scheduled' : 'Another interview scheduled'), at: iso(e.createdAt), who: e.by || null, phase: 'Interview',
      detail: [e.toSlot ? `For ${istDay(e.toSlot) ? V.dmy(istDay(e.toSlot)) : e.toSlot}${/T\d/.test(e.toSlot) ? ` at ${new Date(new Date(e.toSlot).getTime() + IST).toISOString().slice(11, 16)}` : ''}` : null, e.fromSlot ? `Earlier: ${e.fromSlot}` : null, e.reason || null].filter(Boolean).join(' · ') || null,
    });
  });
  if (!sched.length) {
    const ev = stage('INTERVIEW_SCHEDULED');
    add({ key: 'interview-first', label: 'Interview scheduled', at: iso(ev && ev.createdAt), who: who(ev), phase: 'Interview', state: app.interviewAt ? 'Not recorded' : 'Not yet', detail: app.interviewAt ? `For ${V.dmy(istDay(app.interviewAt))}` : null });
  }
  if (app.interviewAt) {
    add({
      key: 'interview-now', label: `Current interview: round ${app.interviewRound || 1}`, at: iso(app.interviewAt), who: app.interviewer || null, phase: 'Interview',
      detail: [app.interviewType, app.interviewMode, app.interviewLocation ? `at ${app.interviewLocation}` : null, app.interviewer ? `with ${app.interviewer}` : null, `status ${String(app.interviewStatus || 'SCHEDULED').toLowerCase().replace(/_/g, ' ')}`].filter(Boolean).join(' · '),
    });
  }
  const complete = done.length ? done[done.length - 1] : null;
  const completeStage = stage('INTERVIEW_COMPLETED');
  const completeAt = (complete && complete.createdAt) || app.interviewCompletedAt || (completeStage && completeStage.createdAt);
  const internalFb = (app.interviewFeedbacks || []).find((f) => f.kind === 'Internal');
  add({
    key: 'interviewDone', label: 'Interview completed', at: iso(completeAt), who: (complete && complete.by) || who(completeStage), phase: 'Interview', state: 'Not yet',
    detail: internalFb ? `Outcome: ${internalFb.recommendation}${forBde ? '' : ''}` : (app.interviewResult ? `Result: ${app.interviewResult}` : null),
  });
  const sel = stage('SELECTED');
  add({ key: 'selected', label: 'Selected', at: iso(sel && sel.createdAt), who: who(sel), phase: 'Offer', state: 'Not yet' });
  const offerEv = stage('OFFER');
  const offerV = (app.offerVersions || [])[0];
  add({
    key: 'offer', label: 'Offer made', at: iso((offerEv && offerEv.createdAt) || (offerV && offerV.createdAt)) || null, day: dayOnly(app.offerDate), who: who(offerEv) || (offerV && offerV.createdByName) || null, phase: 'Offer', state: 'Not yet',
  });
  const accEv = stage('OFFER_ACCEPTED');
  const accV = (app.offerVersions || []).find((v) => v.status === 'Accepted' && v.signedAt);
  add({ key: 'accepted', label: 'Offer accepted', at: iso((accEv && accEv.createdAt) || app.offerAcceptedAt || (accV && accV.signedAt)), who: who(accEv), phase: 'Offer', state: 'Not yet' });
  if (app.joiningDate) add({ key: 'joinDate', label: 'Joining date set', day: dayOnly(app.joiningDate), phase: 'Joining', detail: 'The date planned for joining' });
  // joined / dropped
  const jEv = firstEv(events, (e) => ['JOINED', 'REJOINED'].includes(e.kind));
  const joinedStage = stage('JOINED');
  const joinedDay = rec && rec.joinedOn ? rec.joinedOn : (dayOnly(app.joiningDate) && ['JOINED', 'HIRED'].includes(app.stage) ? dayOnly(app.joiningDate) : (joinedStage ? istDay(joinedStage.createdAt) : null));
  add({
    key: 'joined', label: 'Joined', day: joinedDay, at: null, who: (jEv && jEv.byName) || who(joinedStage), phase: 'Joining',
    state: ['JOINED', 'HIRED'].includes(app.stage) ? 'Not recorded' : 'Not yet',
    detail: rec ? [rec.location ? `at ${rec.location}` : 'place not recorded', rec.designation].filter(Boolean).join(' · ') : null,
  });
  if (rec && rec.status === 'Dropped') {
    add({ key: 'dropped', label: 'Dropped', day: rec.droppedOn, who: rec.dropReportedByName ? `${rec.dropReportedByName}${rec.dropReportedFrom ? ` (${rec.dropReportedFrom})` : ''}` : null, phase: 'After joining', detail: `Reason: ${rec.dropReason || 'Not recorded'}` });
    if (rec.replacementDecision) {
      add({
        key: 'decision', label: 'Replacement decision', at: rec.replacementDecidedAt, who: rec.replacementOnBehalf ? `${rec.replacementDecidedByName} (on the client's behalf)` : rec.replacementDecidedByName, phase: 'After joining',
        detail: V.DECISIONS[rec.replacementDecision].label,
      });
    }
  }
  // A step with no date, while a later step has one, did happen: "Not recorded" rather than "Not yet".
  let lastDone = -1;
  ms.forEach((m, i) => { if (m.state === 'Done') lastDone = i; });
  ms.forEach((m, i) => { if (m.state === 'Not yet' && i < lastDone && !['joined'].includes(m.key)) m.state = 'Not recorded'; });
  // elapsed days between the key steps
  const dayOf = (k) => { const m = ms.find((x) => x.key === k && x.state === 'Done'); return m ? m.day : null; };
  const lastInterview = (() => { const x = [...ms].reverse().find((m) => /^interviewDone$/.test(m.key) && m.state === 'Done'); return x ? x.day : null; })();
  const pairs = [
    ['bde', 'Came to us to BDE', dayOf('came')], ['client', 'BDE to client', dayOf('bde')],
    ['interview-first', 'Client to first interview', dayOf('client')], ['offer', 'Interview to offer', lastInterview],
    ['accepted', 'Offer to accepted', dayOf('offer')], ['joined', 'Accepted to joined', dayOf('accepted')], ['dropped', 'Joined to drop', dayOf('joined')],
  ];
  pairs.forEach(([key, label, from]) => {
    const m = ms.find((x) => (key === 'interview-first' ? /^interview-/.test(x.key) && x.state === 'Done' : x.key === key) && x.state === 'Done');
    if (m && from && m.day) m.elapsed = { label, days: Math.max(0, V.daysBetween(from, m.day)) };
  });
  const dates = {
    cameOn: dayOf('added') || dayOf('came'), bdeOn: dayOf('bde'), sentToClientOn: dayOf('client'),
    firstInterviewOn: (ms.find((x) => /^interview-/.test(x.key) && x.state === 'Done') || {}).day || null,
    offerOn: dayOf('offer'), offerAcceptedOn: dayOf('accepted'), joinedOn: dayOf('joined'), droppedOn: dayOf('dropped'),
  };
  return {
    applicationId, candidateName: cand.name, jobTitle: app.requirement && app.requirement.title, internal, milestones: ms, dates, source: cand.firstSource || cand.source || null,
  };
}

module.exports = { journey, keyDates };
