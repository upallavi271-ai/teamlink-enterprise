// ---------------------------------------------------------------------------
// PLAN MY DAY (01.11, 2026-11-21) - "what should I do next?", ranked.
//
// The TASKS are found in code from this login's own scoped rows (core.ctxFor): follow-ups due, interviews today, offers
// waiting, joinings this week, client feedback to chase, candidates waiting for the team lead, requirements with nothing
// sent for 5 days. Each gets a score in code (how close to a joining, how late).
//
// The AI only RE-ORDERS them and says why in one line. It is sent a numbered list with the kind of task, the step, the
// days waiting and the job title - never a candidate's name, phone, e-mail or any id - at temperature 0, and its answer
// is checked: an unknown task number is ignored and a task it left out keeps its code place. When no AI answers, the
// code order is the plan.
// ---------------------------------------------------------------------------
const C = require('./core');
const M = require('./metrics');
const { atsViewRole } = require('../scope');

const LEADS = ['admin', 'mgmt', 'stl', 'tl'];
const KIND = {
  joining: { label: 'Confirm a joining', base: 90 },
  interview: { label: 'Interview today', base: 85 },
  offer: { label: 'Offer waiting for an answer', base: 75 },
  followup: { label: 'Follow-up due', base: 65 },
  feedback: { label: 'Client feedback to chase', base: 60 },
  review: { label: 'Waiting for your review', base: 55 },
  stalejob: { label: 'Requirement with nothing sent', base: 50 },
};

async function tasksFor(user) {
  const ctx = await C.ctxFor(user, {});
  const t0 = C.today();
  const week = C.addDays(t0, 7);
  const lead = LEADS.includes(atsViewRole(user));
  const out = [];
  const names = await C.namesOf(ctx.apps.map((x) => x.a.candidateId));
  const job = (x) => M.reqLabel(x.req);
  const candLink = (x) => `/candidates/${x.a.candidateId}`;
  ctx.apps.forEach((x) => {
    if (!x.inPipeline || x.joined) return;
    const who = names.get(x.a.candidateId) || 'Candidate';
    const iv = C.istDay(x.a.interviewAt);
    const jd = C.isoDay(x.a.joiningDate);
    if (jd && jd >= t0 && jd <= week && x.reached('accepted')) {
      out.push({ kind: 'joining', who, job: job(x), client: x.req.clientName, step: 'Offer accepted', days: C.dayDiff(t0, jd), detail: `joins on ${jd}`, open: candLink(x), score: KIND.joining.base + (7 - C.dayDiff(t0, jd)) * 2 });
    } else if (iv === t0) {
      out.push({ kind: 'interview', who, job: job(x), client: x.req.clientName, step: 'Interview', days: 0, detail: 'interview today - confirm the person is ready', open: candLink(x), score: KIND.interview.base });
    } else if (x.pipe.id === 'offer' && x.daysInStage >= 2) {
      out.push({ kind: 'offer', who, job: job(x), client: x.req.clientName, step: 'Offer', days: x.daysInStage, detail: `offer out for ${x.daysInStage} days`, open: candLink(x), score: KIND.offer.base + Math.min(20, x.daysInStage) });
    } else if (x.pipe.id === 'client_review' && x.daysInStage >= 3) {
      out.push({ kind: 'feedback', who, job: job(x), client: x.req.clientName, step: 'With client', days: x.daysInStage, detail: `with the client for ${x.daysInStage} days`, open: candLink(x), score: KIND.feedback.base + Math.min(20, x.daysInStage) });
    } else if (lead && x.pipe.id === 'tl_review' && x.daysInStage >= 1) {
      out.push({ kind: 'review', who, job: job(x), client: x.req.clientName, step: 'Check by team lead', days: x.daysInStage, detail: `waiting ${x.daysInStage} days for the team lead`, open: candLink(x), score: KIND.review.base + Math.min(20, x.daysInStage) });
    }
  });
  // follow-ups that are MINE, due today or late
  const byApp = new Map(ctx.apps.map((x) => [x.id, x]));
  ctx.followUps.forEach((f) => {
    if (f.completedAt || !f.dueDate || f.dueDate > t0) return;
    if (f.ownerUserId && f.ownerUserId !== user.id) return;
    if (!f.ownerUserId) return;
    const x = byApp.get(f.applicationId);
    if (!x) return;
    const late = Math.max(0, C.dayDiff(f.dueDate, t0));
    out.push({
      kind: 'followup', who: names.get(x.a.candidateId) || 'Candidate', job: job(x), client: x.req.clientName, step: (x.pipe && x.pipe.label) || '', days: late,
      detail: `${f.nextAction ? `${String(f.nextAction).slice(0, 80)} - ` : ''}${late ? `${late} day${late === 1 ? '' : 's'} late` : 'due today'}`, open: '/ats/followups', score: KIND.followup.base + Math.min(25, late * 3),
    });
  });
  // requirements still open with nothing new for 5 days
  const lastAdd = new Map();
  ctx.apps.forEach((x) => { const d = C.istDay(x.a.createdAt); if (!lastAdd.has(x.req.id) || d > lastAdd.get(x.req.id)) lastAdd.set(x.req.id, d); });
  ctx.reqs.filter((r) => M.LIVE.includes(r.status)).forEach((r) => {
    const last = lastAdd.get(r.id) || C.istDay(r.createdAt);
    const idle = C.dayDiff(last, t0);
    if (idle < 5) return;
    out.push({ kind: 'stalejob', who: '', job: M.reqLabel(r), client: r.clientName, step: 'Sourcing', days: idle, detail: `nothing added for ${idle} days`, open: `/requirements/${r.id}`, score: KIND.stalejob.base + Math.min(20, Math.floor(idle / 2)) });
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 40).map((t, i) => ({ ...t, id: `T${i + 1}`, label: KIND[t.kind].label }));
}

const codeWhy = (t) => ({
  joining: 'A joining this week: a confirmed date protects the placement.',
  interview: 'Happening today: a no-show loses the slot.',
  offer: 'An offer left waiting is the most common reason people drop.',
  followup: 'You promised this follow-up; late ones cool the candidate.',
  feedback: 'Clients forget: a nudge now gets the interview booked.',
  review: 'Your team is waiting for you before they can send this person.',
  stalejob: 'Nothing sent recently: the client may give it to another agency.',
}[t.kind]);

async function plan(user, { ai = true } = {}) {
  const tasks = await tasksFor(user);
  let order = null; let via = 'code'; let note = '';
  if (ai && tasks.length > 1) {
    try {
      const fastAi = require('../fastAi'); // eslint-disable-line global-require
      const facts = tasks.map((t) => `${t.id} | ${t.label} | step: ${t.step} | ${t.days} day(s) | job: ${String(t.job).slice(0, 60)}`).join('\n');
      const system = 'You help a recruiter at a staffing agency plan their day. Order the tasks so the ones most likely to protect or create a joining come first; late work before fresh work. Use only the tasks given. Reply with JSON only: {"order":[{"id":"T1","why":"one short plain-English reason"}]} with at most 8 items.';
      const r = await fastAi.chat(system, [{ role: 'user', content: `Tasks:\n${facts}` }], { json: true, temperature: 0, maxTokens: 500, fallbackToApp: false, deadlineMs: 15000, timeoutMs: 12000 });
      const m = /\{[\s\S]*\}/.exec(String(r.text || ''));
      const parsed = m ? JSON.parse(m[0]) : null;
      const ids = new Set(tasks.map((t) => t.id));
      const list = parsed && Array.isArray(parsed.order) ? parsed.order.filter((o) => o && ids.has(o.id)) : [];
      if (list.length) { order = list; via = r.provider; }
    } catch (e) { note = 'The AI did not answer, so the plan is in the usual order.'; }
  }
  let ranked;
  if (order) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const seen = new Set();
    ranked = order.filter((o) => { if (seen.has(o.id)) return false; seen.add(o.id); return true; }).map((o) => ({ ...byId.get(o.id), why: String(o.why || '').replace(/[\r\n]+/g, ' ').slice(0, 160) || codeWhy(byId.get(o.id)) }));
    tasks.forEach((t) => { if (!seen.has(t.id)) ranked.push({ ...t, why: codeWhy(t) }); });
  } else ranked = tasks.map((t) => ({ ...t, why: codeWhy(t) }));
  return { tasks: ranked.slice(0, 12), total: tasks.length, via: via === 'code' ? 'Ranked by TeamLink rules' : `Ranked by AI (${via})`, note };
}

module.exports = { plan, tasksFor };
