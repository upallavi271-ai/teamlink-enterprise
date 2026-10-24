// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - WRITTEN FOLLOW-UPS (email / WhatsApp), through the SHARED services.
//
// After a shortlist or interview call a short written message can follow, with the SAME verified details the call used
// (the real interview record: date and time in India time, format, approved link or place). Rules:
//   * OFF unless the Admin ticked "Send a written follow-up by email / on WhatsApp" in AI Calling settings
//   * email goes through the candidate message queue (it also respects the company-wide "Candidate emails" switch)
//   * WhatsApp goes through utils/messaging.js and ONLY when a WhatsApp provider is configured; otherwise nothing is sent
//   * nobody who was the wrong person, asked not to be contacted, or is on the do-not-contact list gets a message
//   * the text never says selected / hired / offered, and never promises anything
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./scripts');
const P = require('./policy');

const TZ_WORD = 'IST';

function whenWords(at) {
  return `${S.dateWords(at, 'English')} at ${S.timeWords(at, 'English').replace(/\s*IST$/, '')} ${TZ_WORD}`;
}

// The text, built from the database only.
function compose(row, ctx, res) {
  const c = ctx.candidate; const r = ctx.requirement; const a = ctx.app;
  const first = S.clean(String(c.name || '').split(/\s+/)[0], 40) || 'there';
  const IM = require('../utils/interviewMeet'); // eslint-disable-line global-require
  const lines = [`Hello ${first},`];
  if (row.purpose === 'Shortlist Notification') {
    lines.push(`This is a message from TeamLink Consultants about your call with our AI recruitment assistant. You have been shortlisted for the ${S.clean(r.title)} position.`);
    if (a.interviewAt && P.LIVE_INTERVIEW.includes(String(a.interviewStatus || ''))) lines.push(`Your interview is on ${whenWords(a.interviewAt)}.`);
    else lines.push('The team will share the next steps and any interview details later.');
    lines.push('Being shortlisted is one step in the process. It does not guarantee a final decision.');
  } else if (row.purpose.startsWith('Interview')) {
    if (!a.interviewAt || !P.LIVE_INTERVIEW.includes(String(a.interviewStatus || ''))) return null;
    lines.push(`This is a message from TeamLink Consultants about your interview for the ${S.clean(r.title)} position.`);
    lines.push(`When: ${whenWords(a.interviewAt)}.`);
    const kind = S.MODE_KIND(a.interviewMode);
    if (kind === 'online') {
      const chk = a.interviewMeetingLink ? IM.checkLink(a.interviewMeetingLink) : { ok: false };
      lines.push(chk.ok ? `Format: online. Join here: ${chk.url}` : 'Format: online. The recruiter will send you the meeting link.');
    } else if (kind === 'in_person') lines.push(`Format: in person${a.interviewLocation ? ` at ${S.clean(a.interviewLocation, 160)}` : '. The recruiter will share the address'}.`);
    else if (kind === 'phone') lines.push('Format: on the phone.');
    if (res.outcome === 'Reschedule Requested') lines.push('We have noted your request to change the time. The interview stays as above until the recruiter confirms a change.');
  } else {
    return null; // screening: no written message
  }
  lines.push('', 'Reply to this message if you have a question.', '', '— TeamLink Consultants');
  return lines.join('\n');
}

async function afterCall(row, ctx, res, s) {
  if (!s.writtenEmail && !s.writtenWhatsapp) return { sent: false, why: 'off' };
  if (res.wrongPerson || !res.identityConfirmed || res.doNotCallRequested) return { sent: false, why: 'not for this person' };
  if (!['Shortlist Notification', 'Interview Notification', 'Interview Reminder'].includes(row.purpose)) return { sent: false, why: 'screening' };
  if (row.purpose === 'Shortlist Notification' && res.outcome === 'Not Interested') return { sent: false, why: 'declined' };
  const text = compose(row, ctx, res);
  if (!text || S.hasForbidden(text.replace(ctx.requirement.title || '\u0000', ''))) return { sent: false, why: 'no safe text' };
  const out = { email: null, whatsapp: null };
  const label = `AI call follow-up: ${row.purpose}`;
  if (s.writtenEmail && ctx.candidate.email) {
    const IN = require('../utils/interviewNotices'); // eslint-disable-line global-require
    const msg = await IN.queueCandidateEmail({ ...ctx.app, candidate: ctx.candidate }, {
      template: 'AI_CALL_FOLLOWUP', label, subject: `${S.clean(ctx.requirement.title)} - ${row.purpose === 'Shortlist Notification' ? 'update' : 'interview details'}`, body: text, actor: null,
    });
    out.email = msg ? msg.status : 'skipped';
  }
  if (s.writtenWhatsapp && ctx.candidate.phone) {
    const messaging = require('../utils/messaging'); // eslint-disable-line global-require
    const st = await messaging.channelStatus();
    if (st.WhatsApp && st.WhatsApp.configured) {
      const m = require('../utils/messagingCore').normalizeMobile(ctx.candidate.phone);
      if (m.ok) {
        const r = await messaging.send('WhatsApp', { to: m.e164, kind: 'bulk', text, vars: [text] });
        out.whatsapp = r.outcome;
        await prisma.candidateMessage.create({
          data: {
            candidateId: ctx.candidate.id, applicationId: ctx.app.id, channel: 'WhatsApp', template: 'AI_CALL_FOLLOWUP', templateLabel: label, trigger: 'AI call',
            recipient: row.toMask || '', body: text, status: r.ok ? 'SENT' : 'FAILED', statusDetail: String(r.ok ? 'Sent after an AI call' : (r.error || r.outcome)).slice(0, 300),
            providerRef: r.providerRef || null, senderName: 'AI assistant', sentAt: r.ok ? new Date() : null,
          },
        }).catch(() => null);
      }
    } else out.whatsapp = 'not configured';
  }
  return { sent: true, ...out };
}

module.exports = { compose, afterCall, whenWords };
