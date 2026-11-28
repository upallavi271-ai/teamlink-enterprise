// ---------------------------------------------------------------------------
// SEND THE CLIENT'S FEEDBACK (founder 2026-11-28): "client tho interview ipoyyaka, BDE feedback edit chestharu, save chesi, send
// click chesthey, ahh feedback BDE TL ki, ahh respective TL ki, ahh respective recruiter ki vellali. appudu ahh candidate ki kuda
// vellali, mail through, & also ahh respective recruiter kuda candidate ki inform chestharu."
//
// One press (POST /ats/interviews/:id/feedback/send), after the feedback is saved:
//   * the BDE TL(s), the candidate's team lead and the candidate's recruiter: a bell notice (it also pops up on screen) with the
//     decision and the feedback words, and a mail while interview mails are switched on (Interviews > the e-mail switch);
//   * the candidate: a short mail with the decision only (never the internal remarks or a salary figure), through the same
//     candidate-message queue as every other candidate mail (the "Candidate emails" switch decides whether it really goes);
//   * the recruiter: an open follow-up task due today, "Tell <name> the client's feedback" - they call / WhatsApp the person;
//   * the interview's history: "Feedback sent" (who sent it, to whom).
// Sending again is allowed (a corrected feedback): every press is recorded.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const IST = 330 * 60000;
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const LEFT = ['Exited', 'Relieved', 'Terminated', 'Exit Process', 'Absconded'];

// the feedback as the screens show it: the client's record first, else the panel's, else the interview's own words
function feedbackOf(app) {
  const list = app.interviewFeedbacks || [];
  const fb = list.find((f) => f.kind === 'Client') || list.find((f) => f.kind === 'Internal') || null;
  const text = String((fb && fb.overall) || app.interviewFeedback || '').replace(/\s+/g, ' ').trim();
  const rec = String((fb && fb.recommendation) || app.interviewResult || '').trim();
  return { text, rec };
}
const decisionOf = (rec) => (/reject|not selected/i.test(rec) ? 'Rejected' : /select|recommend|hire/i.test(rec) ? 'Selected' : rec ? 'Hold' : '');

async function activeUsers(ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: want }, status: 'Active' }, select: { id: true, name: true, email: true } });
  const emps = await prisma.employee.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { userId: true, employmentStatus: true } });
  const left = new Set(emps.filter((e) => LEFT.includes(e.employmentStatus)).map((e) => e.userId));
  return users.filter((u) => !left.has(u.id));
}

// who is told: the BDE TL(s), the candidate's team lead, the candidate's recruiter
async function recipientsOf(app) {
  const r = app.requirement || {};
  // the candidate's own recruiter; one who has left -> the job's recruiter now
  const recruiterIds = [app.ownerRecruiterId, r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim())].filter(Boolean);
  // the team lead of THIS candidate: the one on their latest follow-up (it follows the recruiter's seat), else the job's
  const lastFu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, tlUserId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { tlUserId: true } });
  const tlId = (lastFu && lastFu.tlUserId) || r.tlId || null;
  const bdeTls = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', atsDepartment: 'BDE' }, select: { id: true } });
  const live = await activeUsers(recruiterIds);
  const recruiter = recruiterIds.map((id) => live.find((u) => u.id === id)).find(Boolean);
  const [tl] = await activeUsers([tlId]);
  const bdeTl = await activeUsers(bdeTls.map((u) => u.id));
  return { recruiter: recruiter || null, tl: tl || null, bdeTl };
}

function candidateMail(app, decision, recruiter) {
  const cName = (app.candidate && app.candidate.name) || 'there';
  const college = (app.requirement && app.requirement.client && app.requirement.client.name) || 'the college';
  const job = (app.requirement && app.requirement.title) || 'the position';
  const who = recruiter ? `${recruiter.name}, your recruiter at TeamLink,` : 'Your recruiter at TeamLink';
  const lines = {
    Selected: [`Good news: ${college} has selected you after your interview for ${job}.`, `${who} will call you shortly with the next steps.`],
    Rejected: [`Thank you for attending the interview with ${college} for ${job}.`, 'This time the college has decided not to go ahead.', `${who} will stay in touch about other openings that suit you.`],
    Hold: [`${college} has shared its feedback on your interview for ${job}.`, `${who} will call you with the details.`],
  }[decision] || [`${college} has shared its feedback on your interview for ${job}.`, `${who} will call you with the details.`];
  const subject = decision === 'Selected' ? `You are selected - ${college}` : `Your interview with ${college}`;
  return { subject, body: [`Hi ${cName},`, '', ...lines, '', '— TeamLink'].join('\n') };
}

async function sendFeedback(applicationId, actor) {
  const N = require('./interviewNotices'); // eslint-disable-line global-require
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { candidate: true, requirement: { include: { client: true } }, interviewFeedbacks: true },
  });
  if (!app) return { status: 404, error: 'Interview not found' };
  const { text, rec } = feedbackOf(app);
  if (!text && !rec) return { status: 409, error: 'There is no feedback to send yet. Save the feedback first.' };
  const decision = decisionOf(rec);
  const cName = (app.candidate && app.candidate.name) || 'The candidate';
  const college = (app.requirement && app.requirement.client && app.requirement.client.name) || 'the client';
  const job = (app.requirement && app.requirement.title) || 'the requirement';
  const { recruiter, tl, bdeTl } = await recipientsOf(app);

  // 1. the team: bell (pops up) + mail while interview mails are on
  const people = [];
  const add = (u, as) => { if (u && u.id !== (actor && actor.id) && !people.some((p) => p.id === u.id) && !N.skipPerson(`${u.name} ${u.email}`)) people.push({ ...u, as }); };
  bdeTl.forEach((u) => add(u, 'BDE TL'));
  add(tl, 'Team lead');
  add(recruiter, 'Recruiter');
  const title = `Client feedback: ${cName} - ${decision || 'feedback in'}`;
  const words = [`${college} · ${job}`, `Interview ${N.when(app.interviewAt)}`, `Decision: ${decision || '—'}`, text ? `Feedback: ${text}` : null,
    recruiter ? `${recruiter.name}: please tell ${cName} (a task is on your follow-ups).` : null, `Sent by ${actor ? actor.name : 'TeamLink'}`].filter(Boolean);
  for (const p of people) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: p.id, title, message: `${words.join(' · ')}\nOpen: /ats/calendar`, channel: 'In-App', recipient: `fbsend|${app.id}`, status: 'Sent' } });
  }
  let mails = 0;
  const mailsOn = (await N.loadSettings().catch(() => ({}))).enabled === true;
  if (mailsOn) {
    for (const p of people.filter((x) => x.email)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await N.mailTo(p.email, title, ['Hello,', '', ...words, '', 'Open TeamLink → Interviews for the details.', '', '— TeamLink'].join('\n'));
      if (r && r.ok) mails += 1;
    }
  }

  // 2. the candidate: the decision only, through the candidate-message queue
  let candidate = 'not sent';
  if (decision) {
    const m = candidateMail(app, decision, recruiter);
    const row = await N.queueCandidateEmail(app, { template: 'INTERVIEW_FEEDBACK', label: 'Interview feedback', subject: m.subject, body: m.body, actor });
    candidate = row ? (row.status === 'QUEUED' ? 'mail queued' : (row.statusDetail || row.status)) : 'not sent (no candidate)';
  }

  // 3. the recruiter's task: tell the candidate
  let task = false;
  if (recruiter) {
    const { chainSnapshot, resolveNames } = require('./followups'); // eslint-disable-line global-require
    const names = await resolveNames([app.requirement]).catch(() => null);
    const snap = chainSnapshot(app, app.requirement, names);
    await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId,
        ...snap, ownerUserId: recruiter.id, ownerName: recruiter.name, ownerRole: 'Recruiter',
        purpose: 'Interview feedback', nextAction: `Tell ${cName} the client's feedback (${decision || 'feedback in'})`,
        nextStep: `Tell ${cName} the client's feedback`, dueDate: todayIst(), contactMode: 'Call',
        notes: [`${college} · ${job}`, `Decision: ${decision || '—'}`, text ? `Feedback: ${text}` : null, `Sent by ${actor ? actor.name : 'TeamLink'}`].filter(Boolean).join('\n'),
        createdById: actor ? actor.id : null, createdByName: actor ? actor.name : 'TeamLink',
      },
    });
    task = true;
  }

  // 4. the history
  const to = people.map((p) => `${p.name} (${p.as})`).join(', ');
  await prisma.interviewEvent.create({ data: { applicationId: app.id, status: 'FEEDBACK_SENT', reason: `Feedback sent to ${to || 'nobody on the team'}; candidate: ${candidate}`, by: actor ? actor.name : 'TeamLink' } });
  try {
    await require('./audit').logAudit({ userId: actor ? actor.id : null, actorName: actor ? actor.name : null, action: 'Interview feedback sent', entity: 'Application', entityId: app.id, toValue: `${decision || '—'} · ${to || 'nobody'} · candidate ${candidate}`.slice(0, 500) }); // eslint-disable-line global-require
  } catch { /* the trail only */ }
  return { status: 200, decision, people: people.map((p) => ({ name: p.name, as: p.as })), mails, mailsOn, candidate, task, recruiter: recruiter ? recruiter.name : null };
}

module.exports = { sendFeedback, recipientsOf, feedbackOf, candidateMail };
