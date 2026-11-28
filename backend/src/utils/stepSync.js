// ---------------------------------------------------------------------------
// ONE FACT, EVERY SCREEN (founder 2026-11-28: "oka particular candidate - interview complete ithey, adhi annitilo update avvali,
// interview complete indhi ani, okka interview calendar lo ney kaadhu; same alaagey, oka particular candidate join ithey, adhi annitilo
// update avvali").
//
// Every screen reads one of three things about a person on a requirement: the STEP (Application.stage - Candidates & Pipeline, the
// dashboard, reports), the INTERVIEW (Application.interviewStatus - the Interview Calendar) and the JOINING (joiningStatus / joinedAt /
// the Joining record - Joinings, report cards). Whatever screen, import or tool writes one of them, this hook brings the others along,
// right after the write, in the same request:
//
//   interview done        interviewStatus becomes Completed / Waiting for feedback / Feedback given while the step is still before
//                         "Interview done" (New ... Sent to client, Interview booked)  ->  the step moves to "Interview done", with
//                         its history row (so the dashboard and reports count it).
//   step moved on         the step becomes Interview done / Selected / Offer / Joined while the calendar still has that interview
//                         as booked (and its time has passed)  ->  the calendar marks it done.
//   joined                the step becomes Joined (or Hired)  ->  joining status "Joined" and the joining date are filled in
//                         where they are missing (a recorded drop / left status is never overwritten).
//
// Nothing ever moves BACK, a Rejected / Hold / Joined step is never changed by an interview status, and the hook's own writes do not
// come back into it. The Joining record and the other open applications of a joined person are handled where they always were
// (joindrop / utils/joinedElsewhere.js).
// ---------------------------------------------------------------------------
const DONE_IV = ['COMPLETED', 'PENDING_FEEDBACK', 'FEEDBACK_SUBMITTED'];
const BEFORE_DONE = [
  'NEW', 'AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED', 'TL_REVIEW',
  'WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'INTERVIEW_SCHEDULED',
];
const PAST_INTERVIEW_STAGES = ['INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const BOOKED_IV = [null, 'SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
const JOINED = ['JOINED', 'HIRED'];
const LEFT_OR_JOINED = ['Joined', 'Dropped', 'Replacement Due', 'Replaced', 'Left after Guarantee', 'Left After Guarantee'];
const WATCH = ['stage', 'interviewStatus', 'joiningStatus', 'joinedAt', 'joiningDate', 'interviewAt'];
const SELECT = { id: true, candidateId: true, requirementId: true, stage: true, interviewStatus: true, interviewAt: true, joiningStatus: true, joinedAt: true, joiningDate: true };

const busy = new Set();
const valOf = (v) => (v && typeof v === 'object' && !(v instanceof Date) && 'set' in v ? v.set : v);

// What the three facts say together, and the writes that make them agree. Pure: easy to test.
function plan(a, now = Date.now()) {
  const data = {};
  let move = null;
  if (DONE_IV.includes(a.interviewStatus) && BEFORE_DONE.includes(a.stage)) {
    data.stage = 'INTERVIEW_COMPLETED';
    move = { from: a.stage, to: 'INTERVIEW_COMPLETED' };
  }
  const stage = data.stage || a.stage;
  const ivAt = a.interviewAt ? new Date(a.interviewAt).getTime() : null;
  if (PAST_INTERVIEW_STAGES.includes(stage) && ivAt && ivAt <= now && BOOKED_IV.includes(a.interviewStatus || null)) data.interviewStatus = 'COMPLETED';
  if (JOINED.includes(stage)) {
    if (!a.joiningStatus || !LEFT_OR_JOINED.includes(a.joiningStatus)) data.joiningStatus = 'Joined';
    if (!a.joinedAt) {
      const d = a.joiningDate && /^\d{4}-\d{2}-\d{2}/.test(a.joiningDate) ? new Date(`${a.joiningDate.slice(0, 10)}T09:30:00+05:30`) : null;
      data.joinedAt = d && !Number.isNaN(d.getTime()) ? d : new Date(now);
    }
  }
  return { data, move };
}

async function apply(prisma, id, { actor = null, why = null } = {}) {
  const a = await prisma.application.findUnique({ where: { id }, select: SELECT });
  if (!a) return null;
  const { data, move } = plan(a);
  if (!Object.keys(data).length) return null;
  busy.add(id);
  try {
    await prisma.application.update({ where: { id }, data });
    if (move) {
      const r = await prisma.requirement.findUnique({ where: { id: a.requirementId }, select: { title: true, clientId: true, client: { select: { name: true } } } }).catch(() => null);
      await prisma.applicationStageEvent.create({ data: {
        applicationId: id, candidateId: a.candidateId, fromStage: move.from, toStage: move.to, action: 'Interview completed',
        comment: why || 'The interview was marked done, so the step moved to Interview done everywhere.',
        actorName: actor || 'TeamLink', actorSide: 'Internal', actorRole: 'System',
        requirementId: a.requirementId, requirementTitle: r ? r.title : null, clientId: r ? r.clientId : null, clientName: r && r.client ? r.client.name : null,
      } }).catch((e) => console.error('[step-sync] history', e.message)); // eslint-disable-line no-console
    }
    return { id, data, move };
  } finally { busy.delete(id); }
}

function hook(prisma) {
  prisma.$use(async (params, next) => {
    const result = await next(params);
    if (params.model !== 'Application' || !['update', 'upsert', 'create'].includes(params.action)) return result;
    const data = params.action === 'upsert' ? { ...(params.args.create || {}), ...(params.args.update || {}) } : (params.args && params.args.data) || {};
    if (!WATCH.some((k) => valOf(data[k]) !== undefined)) return result;
    const id = (result && result.id) || (params.args && params.args.where && params.args.where.id);
    if (!id || busy.has(id)) return result;
    try { await apply(prisma, id); } catch (err) { console.error('[step-sync]', err && err.message); } // eslint-disable-line no-console
    return result;
  });
}

module.exports = { hook, plan, apply, DONE_IV, BEFORE_DONE };
