// ---------------------------------------------------------------------------
// THE JOB PORTAL SCREENING — the steps BEFORE the ATS (the actual workflow,
// 2026-09-29):
//
//   Candidate Applications → Duplicate Check → Resume Parsing / Score
//     → AI Interview → AI Interview Score → Recruiter Review → SEND TO ATS
//
// An application is in this screening while it came in through the portal
// (or HR sourcing) and has not been Sent to ATS — atsVocab.isPreAtsApplication.
// No new stage codes and no schema change:
//   Duplicate Check     an ApplicationStageEvent whose action starts with
//                       DUPLICATE_CHECK_ACTION (the result is in the action /
//                       comment). Uses the Candidate Master's own
//                       normalisation (utils/candidateDedupe.js). Nothing is
//                       merged here — a merge stays a Super Admin / Admin act
//                       on Candidates → Duplicates.
//   Resume Score        Application.resumeScore / matchScore from the existing
//                       matcher (utils/matching.js computeMatch) + an event
//                       whose action starts with RESUME_SCORE_ACTION.
//   AI Interview        the existing AI stages: AI_INTERVIEW_SCHEDULED, then
//                       AI_INTERVIEW_COMPLETED with aiInterviewScore /
//                       aiInterviewFeedback (never mixed with client feedback).
//   Recruiter Review    RECRUITER_REVIEW while still in the screening.
//   Send to ATS         Application.portalImportedAt / portalImportedBy + an
//                       event whose action starts with SENT_TO_ATS_ACTION.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { phoneKeys, emailKey } = require('./candidateDedupe');
const {
  DUPLICATE_CHECK_ACTION, RESUME_SCORE_ACTION, SENT_TO_ATS_ACTION, isPreAtsApplication,
} = require('./atsVocab');

async function screenEvents(applicationIds) {
  if (!applicationIds.length) return [];
  return prisma.applicationStageEvent.findMany({
    where: {
      applicationId: { in: applicationIds },
      OR: [
        { action: { startsWith: DUPLICATE_CHECK_ACTION } },
        { action: { startsWith: RESUME_SCORE_ACTION } },
        { action: { startsWith: SENT_TO_ATS_ACTION } },
      ],
    },
    select: { applicationId: true, action: true, comment: true, createdAt: true, actorName: true },
    orderBy: { createdAt: 'desc' },
  });
}

// Where one application stands in the screening, and what (if anything)
// still stops it being Sent to ATS.
function screeningOf(app, events) {
  const mine = (events || []).filter((e) => e.applicationId === app.id);
  const dup = mine.find((e) => e.action.startsWith(DUPLICATE_CHECK_ACTION));
  const scoreEv = mine.find((e) => e.action.startsWith(RESUME_SCORE_ACTION));
  const sent = mine.find((e) => e.action.startsWith(SENT_TO_ATS_ACTION));
  const resumeScore = app.resumeScore != null ? app.resumeScore : null;
  const aiDone = app.aiInterviewStatus === 'Completed' && app.aiInterviewScore != null;
  const aiManual = app.aiInterviewStatus === 'Manual Review Requested';
  const blockers = [];
  if (!dup) blockers.push('Run the duplicate check');
  if (resumeScore == null && !scoreEv) blockers.push('Score the resume');
  if (!aiDone && !aiManual) blockers.push('Complete the AI interview (or request a manual review)');
  if (!['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(app.stage)) blockers.push('Open the recruiter review');
  let step = 'duplicate_check';
  if (dup) step = 'resume_score';
  if (dup && (resumeScore != null || scoreEv)) step = 'ai_interview';
  if (app.stage === 'AI_INTERVIEW_COMPLETED') step = 'ai_score';
  if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(app.stage)) step = 'recruiter_review';
  if (app.stage === 'REJECTED') step = 'rejected';
  if (app.stage === 'HOLD') step = 'hold';
  return {
    preAts: isPreAtsApplication(app),
    step,
    duplicateChecked: !!dup,
    duplicateResult: dup ? dup.action.replace(`${DUPLICATE_CHECK_ACTION} — `, '') : null,
    duplicateDetail: dup ? dup.comment : null,
    resumeScored: resumeScore != null || !!scoreEv,
    resumeScore,
    aiInterviewStatus: app.aiInterviewStatus || null,
    aiInterviewScore: app.aiInterviewScore != null ? app.aiInterviewScore : null,
    sentToAtsAt: app.portalImportedAt || (sent ? sent.createdAt : null),
    sentBy: sent ? sent.actorName : null,
    readyToSend: isPreAtsApplication(app) && blockers.length === 0,
    blockers: isPreAtsApplication(app) ? blockers : [],
  };
}

// The duplicate check itself: other candidates sharing a normalised phone or
// email (strong — "same person"), or the exact same name (possible — a hint
// only; 24k real candidates share plenty of common names).
async function findDuplicates(candidate) {
  const pk = phoneKeys(candidate.phone);
  const ek = emailKey(candidate.email);
  const or = [...pk.map((k) => ({ phone: { contains: k } })), ...(ek ? [{ email: { contains: ek } }] : [])];
  const contact = or.length
    ? await prisma.candidate.findMany({
      where: { AND: [{ id: { not: candidate.id } }, { OR: or }] },
      select: { id: true, name: true, phone: true, email: true },
      take: 20,
    })
    : [];
  const strong = contact.filter((c) => {
    const samePhone = phoneKeys(c.phone).some((k) => pk.includes(k));
    const sameEmail = ek && emailKey(c.email) === ek;
    return samePhone || sameEmail;
  }).map((c) => ({
    id: c.id,
    name: c.name,
    strength: 'strong',
    reasons: [
      phoneKeys(c.phone).some((k) => pk.includes(k)) ? 'same phone' : null,
      ek && emailKey(c.email) === ek ? 'same email' : null,
    ].filter(Boolean),
  }));
  const name = String(candidate.name || '').trim();
  let possible = [];
  if (name.length >= 3) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, name FROM "Candidate" WHERE lower(trim(name)) = lower(?) AND id <> ? LIMIT 10',
      name, candidate.id,
    );
    possible = rows.filter((r) => !strong.some((s) => s.id === r.id))
      .map((r) => ({ id: r.id, name: r.name, strength: 'possible', reasons: ['same name'] }));
  }
  return { strong, possible };
}

module.exports = { screenEvents, screeningOf, findDuplicates };
