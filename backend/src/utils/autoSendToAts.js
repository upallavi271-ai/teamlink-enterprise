// ---------------------------------------------------------------------------
// THE 65% RULE: A JOB PORTAL CANDIDATE GOES INTO THE ATS BY ITSELF (founder 2026-10-30: "candidate 65 percent kante ekkuvaa ai score
// and resume anii over all score oste automatic gaa push avalii ats loo kii"; he chose: BOTH the AI interview score and the resume
// score 65% or more -> Shortlisted, no recruiter click).
//
// An application still in the Job Portal screening (utils/preAtsScreening.js: Duplicate Check -> Resume Score -> AI Interview ->
// Recruiter Review -> Send to ATS) is checked whenever the Job Portal sync brings it in or updates its AI interview
// (utils/jobPortalBridge.js fullSync, utils/mailImports.js):
//   - the duplicate check and the resume score are run for it when nobody has yet (recorded as the system, like a recruiter's);
//   - AI interview Completed with a score >= 65 AND resume score >= 65 AND no duplicate to sort out (candidateDupes.gateCheck)
//     -> Sent to ATS at "Approved by recruiter" (the ATS's Shortlisted; the portal reads it as 'shortlisted'), with the reason on
//        its history, the requirement's recruiter / TL told, and the Job Portal marked "Pushed to ATS" (via auto_screening).
//   - anything short of that stays in the screening for the recruiter, exactly as before. Nothing is ever moved back.
// AUTO_ATS_MIN_SCORE (backend .env) changes the 65.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const MIN = () => Math.max(1, Math.min(100, Number(process.env.AUTO_ATS_MIN_SCORE) || 65));
const SYSTEM = { id: null, name: 'TeamLink (65% rule)', atsRole: 'SYSTEM' };

async function event(app, action, comment, toStage) {
  const r = app.requirement;
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage: toStage || app.stage,
      action, comment: comment ? String(comment).slice(0, 2000) : null,
      actorUserId: null, actorName: SYSTEM.name, actorRole: 'SYSTEM',
      requirementId: app.requirementId, requirementTitle: r ? r.title : null, clientId: r ? r.clientId : null,
      clientName: r && r.internal ? 'TeamLink Internal' : (r && r.client && r.client.name) || null,
    },
  });
}

// -> { sent: true, ... } | { sent: false, why }
async function check(applicationId, { portalAppId = null } = {}) {
  const V = require('./atsVocab'); // eslint-disable-line global-require
  const S = require('./preAtsScreening'); // eslint-disable-line global-require
  let app = await prisma.application.findUnique({ where: { id: applicationId }, include: { requirement: { include: { client: true } }, candidate: true } });
  if (!app || !V.isPreAtsApplication(app)) return { sent: false, why: 'not in the Job Portal screening' };
  if (['REJECTED', 'HOLD'].includes(app.stage)) return { sent: false, why: `stage ${app.stage}` };
  const min = MIN();
  // the AI interview first: without a finished score >= 65 nothing else needs doing now
  if (!(app.aiInterviewStatus === 'Completed' && app.aiInterviewScore != null && app.aiInterviewScore >= min)) {
    return { sent: false, why: app.aiInterviewScore != null ? `AI interview ${app.aiInterviewScore}% (needs ${min}%)` : 'AI interview not finished' };
  }
  let events = await S.screenEvents([app.id]);
  let st = S.screeningOf(app, events);
  // the duplicate check, when nobody ran it
  if (!st.duplicateChecked) {
    const found = await S.findDuplicates(app.candidate);
    const n = found.strong.length;
    await event(app, `${V.DUPLICATE_CHECK_ACTION} — ${n ? `${n} possible duplicate${n > 1 ? 's' : ''} on file` : 'clear'}`,
      found.strong.map((d) => `${d.name} (${d.reasons.join(', ')})`).join('; ') || null);
  }
  // the resume score, when nobody scored it (the same matcher and the same columns as the screening's Score button)
  if (app.resumeScore == null) {
    const { computeMatch } = require('./matching'); // eslint-disable-line global-require
    const match = computeMatch(app.candidate, app.requirement);
    const resumeScore = app.candidate.resumeScore != null ? app.candidate.resumeScore : match.overall;
    await prisma.application.update({ where: { id: app.id }, data: { matchScore: match.overall, resumeScore } });
    await event(app, `${V.RESUME_SCORE_ACTION} — ${resumeScore}% (match ${match.overall}%)`, null);
    app = { ...app, matchScore: match.overall, resumeScore };
  }
  if (!(app.resumeScore >= min)) return { sent: false, why: `resume ${app.resumeScore}% (needs ${min}%)` };
  // a duplicate to sort out stops the automatic move, as it stops the button (utils/candidateDupes.js)
  const dupHold = await require('./candidateDupes').gateCheck(app, 'TL_REVIEW').catch(() => null); // eslint-disable-line global-require
  if (dupHold) return { sent: false, why: 'a possible duplicate must be sorted out first' };
  events = await S.screenEvents([app.id]);
  st = S.screeningOf(app, events);
  if (/possible duplicate/.test(String(st.duplicateResult || ''))) return { sent: false, why: 'the duplicate check found a possible duplicate' };

  // SEND: the same columns as the recruiter's Send to ATS (routes/jobPortal.js sendToAts), landing at Approved by recruiter
  const { hiringTypeOf } = require('./joining'); // eslint-disable-line global-require
  const internal = hiringTypeOf(app, app.requirement) === 'TeamLink Internal Hire';
  const source = app.source || app.candidate.source;
  const why = `AI interview ${app.aiInterviewScore}% and resume ${app.resumeScore}% (both ${min}% or more)`;
  const moved = await prisma.application.updateMany({
    where: { id: app.id, portalImportedAt: null },
    data: { portalImportedAt: new Date(), stage: 'RECRUITER_APPROVED', hiringType: hiringTypeOf(app, app.requirement), source, firstSource: app.firstSource || source },
  });
  if (!moved.count) return { sent: false, why: 'already sent' };
  await event(app, `${V.SENT_TO_ATS_ACTION} — automatically (${internal ? 'HR Review' : 'Shortlisted'})`, `${why}. Duplicate check: ${st.duplicateResult || 'clear'}.`, 'RECRUITER_APPROVED');
  await logAudit({ action: 'Job Portal application sent to ATS automatically (65% rule)', entity: 'Application', entityId: app.id, fromValue: 'Job Portal screening', toValue: why });
  const r = app.requirement;
  try {
    await require('./notify').notifyUsers([r.recruiterId, r.tlId, app.ownerRecruiterId].filter(Boolean), { // eslint-disable-line global-require
      title: `${app.candidate.name} is in the ATS (Shortlisted)`,
      message: `${why} · ${r.title}`,
    });
  } catch { /* the move is saved; a bell that did not ring is not a failure */ }
  // the Job Portal shows it too: Shortlisted + "Pushed to ATS"
  if (portalAppId) {
    try {
      const { portalFetch } = require('./jobPortalBridge'); // eslint-disable-line global-require
      await portalFetch('/integrations/teamlink/applications/stages', {
        method: 'POST', timeoutMs: 20000,
        body: { updates: [{ id: portalAppId, stage: 'shortlisted', note: `TeamLink ATS: ${why}`, pushed: { via: 'auto_screening', score: Math.min(app.aiInterviewScore, app.resumeScore) } }] },
      });
    } catch (err) { console.error(`[auto-ats] the Job Portal was not updated for ${portalAppId}: ${err.message}`); }
  }
  return { sent: true, why };
}

// Never throws (the sync carries on).
function checkQuietly(applicationId, opts) { return check(applicationId, opts).catch((e) => ({ sent: false, why: e.message })); }

module.exports = { check, checkQuietly, MIN };
