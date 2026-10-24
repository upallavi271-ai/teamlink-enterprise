// ATS pipeline tools: move a candidate, shortlist, schedule / reschedule an interview.
// Each replays the app's own routes as the logged-in user:
//   PATCH /api/applications/:id/stage           (move, shortlist, schedule)
//   POST  /api/ats/interviews/:id/reschedule    (reschedule)
const { defineTool } = require('../registry');
const T = require('../lib/tooling');
const entities = require('../lib/entities');
const { problemOf } = require('../lib/http');
const { niceDate, niceTime, ymd } = require('../lib/dates');
const permissions = require('../../utils/permissions');
const { STAGE_LABELS, stageLabel, stageMoveProblem, INTERVIEW_MODES, REJECTED_BY, REJECTED_BY_LABEL } = require('../../utils/atsVocab');
const S = require('./_shared');

const HIGH_STAGES = ['REJECTED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'SHARED_WITH_CLIENT'];
const FLOW_STAGES = { OFFER: 1, OFFER_ACCEPTED: 2, JOINED: 3, HIRED: 4 };
const IMPACT_STAGE = 'Rejecting, selecting, sending to a client or making an offer affects the candidate and the client, so it always needs your Confirm.';

// The stage the user asked for: the one after "to / in / ki", else the last one named.
function targetStage(slots) {
  const st = slots.stages || [];
  if (!st.length) return null;
  const withPrep = st.filter((s) => s.afterPrep);
  return (withPrep.length ? withPrep[withPrep.length - 1] : st[st.length - 1]).code;
}

function whenFrom(slots, fallback = {}) {
  const date = (slots.dates && slots.dates[0]) || fallback.date || null;
  const time = slots.time || fallback.time || null;
  return { date, time };
}

function modeFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/\bonline\b|\bvideo\b|\bzoom\b|\bmeet\b|\bteams\b|\bgoogle meet\b/.test(t)) return 'Online';
  if (/in.?person|\boffice\b|\bface to face\b|\bf2f\b|\bwalk.?in\b|\bon.?site\b/.test(t)) return 'In Person';
  if (/telephonic|\bphone\b|\bcall\b/.test(t)) return 'Telephonic';
  return null;
}

// Pre-checks the route would make, so the user hears "no" BEFORE the confirm card.
async function moveRefusal(ctx, app, stage) {
  const refusal = await permissions.canMoveToStage(ctx.user, stage);
  if (refusal) {
    const allowed = await permissions.allowedStagesFor(ctx.user);
    return `Your role cannot move a candidate to "${stageLabel(stage)}". You can move people to: ${allowed.map(stageLabel).join(', ') || 'no step'}.`;
  }
  const isGlobal = permissions.stageGlobal(ctx.user);
  if (FLOW_STAGES[stage] && !isGlobal && !(['HOLD', 'REJECTED'].includes(app.stage))) {
    const cur = FLOW_STAGES[app.stage] || 0;
    if (FLOW_STAGES[stage] > cur) {
      return {
        OFFER: `${app.candidate}'s offer is made with "Prepare offer" on the candidate's profile - the team lead approves it and it is sent. I cannot skip that.`,
        OFFER_ACCEPTED: `${app.candidate}'s answer to the offer is recorded on the Offers screen. I cannot skip that.`,
        JOINED: `A joining is recorded on the Joining checklist (documents, joining date, the call, then Joined). I cannot skip that.`,
        HIRED: `A joining is recorded on the Joining checklist. I cannot skip that.`,
      }[stage];
    }
  }
  if (!isGlobal && !['HOLD', 'REJECTED'].includes(app.stage)) {
    const internal = app.client === 'TeamLink (internal)';
    const chain = stageMoveProblem(app.stage, stage, { internal });
    if (chain) return chain;
  }
  return null;
}

defineTool({
  name: 'move_candidate_stage',
  module: 'ats',
  label: 'Move a candidate to another step',
  description: 'Move one candidate on one requirement to another step of the hiring process.',
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate (their name).' },
    stage: { type: 'stage', required: true, description: 'The step to move to (Interview, Hold, Rejected ...).' },
    reason: { type: 'text', required: false, description: 'Needed for Hold and Rejected.' },
  },
  permission: { product: 'ats', module: 'candidates', feature: 'Applications', action: 'view' },
  confirm: (p) => (HIGH_STAGES.includes(p.stage) ? 'always' : 'default'),
  impact: IMPACT_STAGE,
  examples: ['Move Rahul to Interview', 'Put Rahul in Interview', "Change Rahul's stage to Interview", 'Rahul ni interview ki move cheyyi'],
  async validate(ctx, input) {
    const picked = await S.pickApplication(ctx, input, { question: 'Which candidate do you want to move?', needOpen: true });
    if (picked.ret) return picked.ret;
    const app = picked.one;
    const stage = (input.choices && input.choices.stage) || targetStage(input.slots);
    if (!stage || !STAGE_LABELS[stage]) {
      const allowed = (await permissions.allowedStagesFor(ctx.user)).filter((s) => s !== app.stage);
      if (!allowed.length) return T.refuse('Your role cannot move candidates between steps.');
      return T.clarify(`Which step should ${app.candidate} move to? Now at "${app.stageLabel}".`, {
        need: 'stage',
        options: allowed.slice(0, 6).map((s) => ({ label: stageLabel(s), choice: { stage: s, application: app.id } })),
      });
    }
    if (stage === 'INTERVIEW_SCHEDULED') return T.redirect('schedule_interview', { choices: { application: app.id } });
    if (stage === app.stage) return T.refuse(`${app.candidate} is already at "${app.stageLabel}" on ${app.requirement || 'that requirement'}. Nothing to change.`);

    const params = { applicationId: app.id, stage, expectedFrom: app.stage };
    let reasonLine = null;
    if (stage === 'REJECTED') {
      const side = (input.choices && input.choices.rejectedBy) || T.sideSaid(input.text) || T.sideSaid(input.slots.answers && input.slots.answers.rejectedBy);
      if (!side) {
        return T.clarify(`Whose decision was it to reject ${app.candidate}?`, {
          need: 'rejectedBy',
          options: REJECTED_BY.map((s) => ({ label: REJECTED_BY_LABEL[s], choice: { rejectedBy: s, application: app.id, stage: 'REJECTED' } })),
        });
      }
      const reason = T.reasonText(input, 'reason');
      if (!reason) return T.clarify(`Why is ${app.candidate} being rejected? (one short reason)`, { need: 'reason' });
      params.rejectedBy = side;
      params.reasonCategory = 'Other';
      params.reasonDetail = reason;
      reasonLine = `${REJECTED_BY_LABEL[side]} decision - ${reason}`;
    } else if (stage === 'HOLD') {
      const reason = T.reasonText(input, 'reason');
      if (!reason) return T.clarify(`Why is ${app.candidate} going on hold?`, { need: 'reason' });
      params.comment = reason;
      params.reasonDetail = reason;
      reasonLine = reason;
    } else {
      const c = T.reasonText(input, 'comment');
      if (c) params.comment = c;
    }
    return T.done({
      params,
      summary: `Move ${app.candidate} (${app.requirement || 'job'}) from ${app.stageLabel} to ${stageLabel(stage)}.`,
      display: T.card('Move Candidate', [
        ['Candidate', app.candidate], ['Requirement', app.requirement], ['Client', app.client],
        ['Current', app.stageLabel], ['New', stageLabel(stage)], ['Reason', reasonLine],
      ]),
    });
  },
  async rules(ctx, params) {
    const app = await entities.applicationById(ctx.user, params.applicationId);
    if (!app) return { ok: false, message: 'I cannot find that candidate in your list any more. Nothing was changed.' };
    if (app.stage !== params.expectedFrom) {
      return { ok: false, message: `${app.candidate} is now at "${app.stageLabel}", not where it was when I asked you. Nothing was changed - ask again if you still want it.` };
    }
    const why = await moveRefusal(ctx, app, params.stage);
    return why ? { ok: false, message: why } : { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/applications/${encodeURIComponent(p.applicationId)}/stage`, {
      stage: p.stage,
      comment: p.comment || undefined,
      rejectedBy: p.rejectedBy || undefined,
      reasonCategory: p.reasonCategory || undefined,
      reasonDetail: p.reasonDetail || undefined,
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that move.') };
    return { ok: true, message: `Moved to ${stageLabel(p.stage)}.`, data: r.data };
  },
  async verify(ctx, p) {
    const a = await entities.applicationById(ctx.user, p.applicationId);
    const ok = !!a && a.stage === p.stage;
    return { ok, message: ok ? `${a.candidate} is now at ${a.stageLabel}.` : 'The step on the record is different from what was asked.', evidence: a ? { stage: a.stage } : null };
  },
  audit: (p) => `Moved application ${p.applicationId} to ${p.stage}`,
});

defineTool({
  name: 'shortlist_candidate',
  module: 'ats',
  label: 'Shortlist a candidate',
  description: 'Shortlist a candidate: approve them from screening, or record the client shortlisting them.',
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate (their name).' },
  },
  permission: { product: 'ats', module: 'candidates', feature: 'Applications', action: 'view' },
  confirm: 'default',
  examples: ['Shortlist Rahul', 'Please shortlist candidate Priya for the Java requirement', 'Rahul ni shortlist cheyyi'],
  async validate(ctx, input) {
    const picked = await S.pickApplication(ctx, input, { question: 'Which candidate do you want to shortlist?', needOpen: true });
    if (picked.ret) return picked.ret;
    const app = picked.one;
    const allowed = await permissions.allowedStagesFor(ctx.user);
    let stage = null;
    if (['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(app.stage)) stage = 'CLIENT_SHORTLISTED';
    else if (['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW'].includes(app.stage)) stage = 'RECRUITER_APPROVED';
    if (!stage) {
      return T.refuse(`${app.candidate} is at "${app.stageLabel}". Shortlisting applies when a candidate is being screened (it approves them) or after the client has seen them. Tell me which step to move them to instead.`);
    }
    if (!allowed.includes(stage)) {
      return T.refuse(`Your role cannot shortlist at this point (${app.candidate} is at "${app.stageLabel}"; the next step is "${stageLabel(stage)}", which is not part of your role).`);
    }
    return T.done({
      params: { applicationId: app.id, stage, expectedFrom: app.stage },
      summary: `Shortlist ${app.candidate} (${app.requirement || 'job'}): move from ${app.stageLabel} to ${stageLabel(stage)}.`,
      display: T.card('Shortlist Candidate', [
        ['Candidate', app.candidate], ['Requirement', app.requirement], ['Client', app.client], ['Current', app.stageLabel], ['New', stageLabel(stage)],
      ]),
    });
  },
  async rules(ctx, params) {
    const app = await entities.applicationById(ctx.user, params.applicationId);
    if (!app) return { ok: false, message: 'I cannot find that candidate in your list any more. Nothing was changed.' };
    if (app.stage !== params.expectedFrom) return { ok: false, message: `${app.candidate} is now at "${app.stageLabel}". Nothing was changed - ask again.` };
    const why = await moveRefusal(ctx, app, params.stage);
    return why ? { ok: false, message: why } : { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/applications/${encodeURIComponent(p.applicationId)}/stage`, { stage: p.stage });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Shortlisted - now at ${stageLabel(p.stage)}.`, data: r.data };
  },
  async verify(ctx, p) {
    const a = await entities.applicationById(ctx.user, p.applicationId);
    const ok = !!a && a.stage === p.stage;
    return { ok, message: ok ? `${a.candidate} is now at ${a.stageLabel}.` : 'The step on the record is different.', evidence: a ? { stage: a.stage } : null };
  },
  audit: (p) => `Shortlisted application ${p.applicationId} -> ${p.stage}`,
});

defineTool({
  name: 'schedule_interview',
  module: 'ats',
  label: 'Schedule an interview',
  description: 'Book an interview date and time for a candidate on a requirement.',
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate (their name).' },
    date: { type: 'date', required: true, description: 'The interview day.' },
    time: { type: 'time', required: true, description: 'The interview time.' },
    mode: { type: 'enum', required: false, description: 'Online, In Person or Telephonic.' },
  },
  permission: { product: 'ats', module: 'interviews', feature: 'Schedule Interview', action: 'create' },
  confirm: 'always',
  impact: 'Scheduling an interview tells the candidate and the panel, so it always needs your Confirm.',
  examples: ["Schedule Rahul's interview tomorrow at 3pm", 'Book an interview for Priya on Friday at 11'],
  async validate(ctx, input) {
    const picked = await S.pickApplication(ctx, input, { question: 'Whose interview should I schedule?', needOpen: true });
    if (picked.ret) return picked.ret;
    const app = picked.one;
    if (app.stage === 'INTERVIEW_SCHEDULED') return T.redirect('reschedule_interview', { choices: { application: app.id } });
    const { date, time } = whenFrom(input.slots);
    if (!date) return T.clarify(`On which day is ${app.candidate}'s interview?`, { need: 'when' });
    if (!time) return T.clarify(`At what time on ${niceDate(date)}?`, { need: 'when' });
    if (date < ctx.today) return T.refuse(`${niceDate(date)} is in the past. Tell me a day from today onwards.`);
    const mode = INTERVIEW_MODES.includes(input.choices && input.choices.mode) ? input.choices.mode : modeFrom(input.text);
    return T.done({
      params: { applicationId: app.id, when: `${date}T${time}`, mode, expectedFrom: app.stage },
      summary: `Schedule ${app.candidate}'s interview for ${app.requirement || 'the requirement'} on ${niceDate(date)} at ${niceTime(time)}${mode ? ` (${mode})` : ''}.`,
      display: T.card('Schedule Interview', [
        ['Candidate', app.candidate], ['Requirement', app.requirement], ['Client', app.client], ['Current', app.stageLabel],
        ['Date', niceDate(date)], ['Time', niceTime(time)], ['Mode', mode],
      ]),
    });
  },
  async rules(ctx, params) {
    const app = await entities.applicationById(ctx.user, params.applicationId);
    if (!app) return { ok: false, message: 'I cannot find that candidate in your list any more. Nothing was changed.' };
    if (app.stage !== params.expectedFrom) return { ok: false, message: `${app.candidate} is now at "${app.stageLabel}". Nothing was changed - ask again.` };
    if (params.when.slice(0, 10) < ymd(new Date())) return { ok: false, message: 'That day has passed. Nothing was changed.' };
    const why = await moveRefusal(ctx, app, 'INTERVIEW_SCHEDULED');
    return why ? { ok: false, message: why } : { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/applications/${encodeURIComponent(p.applicationId)}/stage`, {
      stage: 'INTERVIEW_SCHEDULED', interviewAt: `${p.when}:00`, interviewMode: p.mode || undefined,
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Interview scheduled for ${niceDate(p.when.slice(0, 10))} at ${niceTime(p.when.slice(11))}.`, data: r.data };
  },
  async verify(ctx, p) {
    const a = await entities.applicationById(ctx.user, p.applicationId);
    const got = a && a.interviewAt ? new Date(a.interviewAt) : null;
    const want = new Date(`${p.when}:00`);
    const ok = !!a && a.stage === 'INTERVIEW_SCHEDULED' && !!got && Math.abs(got - want) < 60000;
    return { ok, message: ok ? `${a.candidate}'s interview is booked.` : 'The interview on the record is different from what was asked.', evidence: a ? { stage: a.stage, interviewAt: a.interviewAt } : null };
  },
  audit: (p) => `Scheduled interview for application ${p.applicationId} at ${p.when}`,
});

defineTool({
  name: 'reschedule_interview',
  module: 'ats',
  label: 'Reschedule an interview',
  description: "Change the date or time of a candidate's booked interview.",
  parameters: {
    candidate: { type: 'person', required: true, description: 'The candidate (their name).' },
    date: { type: 'date', required: false, description: 'The new day (kept if you only give a time).' },
    time: { type: 'time', required: false, description: 'The new time (kept if you only give a day).' },
    reason: { type: 'text', required: false, description: 'Why it is moving.' },
  },
  permission: { product: 'ats', module: 'interviews', feature: 'Schedule Interview', action: 'create' },
  confirm: 'always',
  impact: 'Rescheduling tells the candidate and the panel of the new time, so it always needs your Confirm.',
  examples: ["Reschedule Rahul's interview to Friday 4pm", "Postpone Priya's interview to tomorrow"],
  async validate(ctx, input) {
    const picked = await S.pickApplication(ctx, input, { question: 'Whose interview should I move?' });
    if (picked.ret) return picked.ret;
    const app = picked.one;
    if (app.stage !== 'INTERVIEW_SCHEDULED' || !app.interviewAt) {
      return T.refuse(`${app.candidate} has no booked interview on ${app.requirement || 'that requirement'} (now at "${app.stageLabel}"), so there is nothing to move. Say "schedule an interview for ${app.candidate}" instead.`);
    }
    const cur = new Date(app.interviewAt);
    const curDate = ymd(cur);
    const curTime = `${String(cur.getHours()).padStart(2, '0')}:${String(cur.getMinutes()).padStart(2, '0')}`;
    const { date, time } = whenFrom(input.slots);
    if (!date && !time) return T.clarify(`${app.candidate}'s interview is on ${niceDate(curDate)} at ${niceTime(curTime)}. What is the new day and time?`, { need: 'when' });
    const newDate = date || curDate;
    const newTime = time || curTime;
    if (newDate < ctx.today) return T.refuse(`${niceDate(newDate)} is in the past. Tell me a day from today onwards.`);
    if (newDate === curDate && newTime === curTime) return T.refuse('That is the same day and time as now. Nothing to change.');
    const reason = T.reasonText(input, 'reason') || 'Time changed at the user\'s request';
    return T.done({
      params: { applicationId: app.id, when: `${newDate}T${newTime}`, reason, expectedAt: app.interviewAt ? new Date(app.interviewAt).toISOString() : null },
      summary: `Move ${app.candidate}'s interview from ${niceDate(curDate)} ${niceTime(curTime)} to ${niceDate(newDate)} ${niceTime(newTime)}.`,
      display: T.card('Reschedule Interview', [
        ['Candidate', app.candidate], ['Requirement', app.requirement], ['Client', app.client],
        ['Now', `${niceDate(curDate)} at ${niceTime(curTime)}`], ['New', `${niceDate(newDate)} at ${niceTime(newTime)}`], ['Reason', reason],
      ]),
    });
  },
  async rules(ctx, params) {
    const app = await entities.applicationById(ctx.user, params.applicationId);
    if (!app || app.stage !== 'INTERVIEW_SCHEDULED') return { ok: false, message: 'That interview is no longer booked. Nothing was changed.' };
    if (params.expectedAt && app.interviewAt && new Date(app.interviewAt).toISOString() !== params.expectedAt) {
      return { ok: false, message: 'The interview time changed since I asked you. Nothing was changed - ask again.' };
    }
    if (params.when.slice(0, 10) < ymd(new Date())) return { ok: false, message: 'That day has passed. Nothing was changed.' };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post(`/ats/interviews/${encodeURIComponent(p.applicationId)}/reschedule`, { interviewAt: `${p.when}:00`, reason: p.reason });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Interview moved to ${niceDate(p.when.slice(0, 10))} at ${niceTime(p.when.slice(11))}.`, data: r.data };
  },
  async verify(ctx, p) {
    const a = await entities.applicationById(ctx.user, p.applicationId);
    const got = a && a.interviewAt ? new Date(a.interviewAt) : null;
    const ok = !!got && Math.abs(got - new Date(`${p.when}:00`)) < 60000;
    return { ok, message: ok ? 'The new time is on the interview record.' : 'The interview time on the record is different.', evidence: a ? { interviewAt: a.interviewAt } : null };
  },
  audit: (p) => `Rescheduled interview for application ${p.applicationId} to ${p.when}`,
});
