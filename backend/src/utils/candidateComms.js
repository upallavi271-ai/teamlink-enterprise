// ---------------------------------------------------------------------------
// Candidate communications — Email / SMS / WhatsApp.
//
// READ THIS BEFORE BELIEVING ANYTHING THIS MODULE SAYS ABOUT DELIVERY.
//
// There is NO mail, SMS or WhatsApp provider wired into this application. No
// SMTP host, no Twilio/MSG91 account, no WhatsApp Business API. Nothing here
// opens a socket to anybody. What this module does is the half that belongs in
// the app anyway:
//
//   * the TRIGGER  — a stage transition decides which templates fire;
//   * the RECORD   — one CandidateMessage row per channel, carrying channel,
//                    template, recipient, trigger, sender identity, status and
//                    timestamp, shown in the candidate's Communications tab.
//
// Every row is written with status NOT_SENT_NO_PROVIDER, sentAt = null and
// providerRef = null, and the UI labels it "Not sent — no provider". A row is
// evidence that the app decided to contact this person, never evidence that
// the person was contacted.
//
// WHAT A REAL INTEGRATION WOULD NEED (nothing below is implemented):
//   1. Credentials per channel, held in Administration → Integrations, not in
//      code: SMTP host/port/user/password or a transactional-email API key;
//      an SMS gateway key plus a registered sender ID and DLT template ids for
//      India; a WhatsApp Business phone-number id, permanent token and
//      Meta-APPROVED message templates (WhatsApp will not deliver free-form
//      text outside a 24-hour service window).
//   2. A sending worker that picks up NOT_SENT_NO_PROVIDER rows, calls the
//      provider, and writes back providerRef, sentAt and status
//      (SENT → DELIVERED → READ / FAILED) — so a provider outage retries
//      instead of losing the message.
//   3. A webhook endpoint per provider for those delivery callbacks, plus
//      bounce and opt-out handling (an unsubscribed or bounced address must
//      stop being written to).
//   4. Per-employee sending identity: sending "from" an employee's own address
//      requires that domain's SPF/DKIM/DMARC to authorise the provider, or the
//      mail is spam-foldered. The address itself already comes from the
//      employee record (see senderIdentity() below).
//
// SENDER IDENTITY
// The user's requirement: an employee's email is captured when the employee is
// added, and candidate messages from that employee go out through that same
// address. senderIdentity() therefore resolves Employee.email for the acting
// user and stores it on the row. There is no hardcoded from-address anywhere in
// this file — if an employee has no email on their record the row records that
// fact rather than substituting a default.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { stageLabel } = require('./atsVocab');

// The one honest status. Kept as a constant so no screen can invent "Sent".
const NOT_SENT = 'NOT_SENT_NO_PROVIDER';
const NOT_SENT_DETAIL = 'Recorded, not transmitted — this app has no Email/SMS/WhatsApp provider configured.';

// --- Templates -------------------------------------------------------------
// One entry per triggering stage. `channels` is which of Email / SMS / WhatsApp
// that transition uses. Bodies are plain text with {{tokens}} filled from the
// candidate, requirement and application.
const TEMPLATES = {
  AI_INTERVIEW_SCHEDULED: {
    key: 'AI_INTERVIEW_SCHEDULED',
    label: 'AI Interview Scheduled',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'Your AI screening interview for {{role}}',
    body: 'Hi {{name}}, your AI screening interview for {{role}} at {{client}} is scheduled. '
      + 'Please complete it before {{deadline}}. The AI interview is a screening aid only — '
      + 'a recruiter reviews every result.',
  },
  AI_INTERVIEW_REQUIRED: {
    key: 'AI_INTERVIEW_REQUIRED',
    label: 'AI Interview Invite',
    channels: ['Email', 'WhatsApp'],
    subject: 'Next step for {{role}}: AI screening interview',
    body: 'Hi {{name}}, the next step for {{role}} at {{client}} is a short AI screening interview. '
      + 'We will send you the link shortly.',
  },
  SHARED_WITH_CLIENT: {
    key: 'SHARED_WITH_CLIENT',
    label: 'Profile Shared with Client',
    channels: ['Email'],
    subject: 'Your profile has been shared for {{role}}',
    body: 'Hi {{name}}, your profile has been shared with the hiring team for {{role}}. '
      + 'We will come back to you as soon as we hear from them.',
  },
  INTERVIEW_SCHEDULED: {
    key: 'INTERVIEW_SCHEDULED',
    label: 'Interview Scheduled',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'Interview scheduled: {{role}}',
    body: 'Hi {{name}}, your interview for {{role}} at {{client}} is scheduled for {{interviewAt}} '
      + '({{mode}}). Interviewer: {{interviewer}}. Please confirm your availability.',
  },
  INTERVIEW_COMPLETED: {
    key: 'INTERVIEW_COMPLETED',
    label: 'Interview Completed',
    channels: ['Email'],
    subject: 'Thanks for attending the {{role}} interview',
    body: 'Hi {{name}}, thank you for attending the interview for {{role}}. '
      + 'We will share the outcome as soon as we have it.',
  },
  SELECTED: {
    key: 'SELECTED',
    label: 'Selected',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'Good news — you have been selected for {{role}}',
    body: 'Hi {{name}}, you have been selected for {{role}} at {{client}}. '
      + 'Your recruiter will call you with the next steps.',
  },
  OFFER: {
    key: 'OFFER',
    label: 'Offer Extended',
    channels: ['Email', 'WhatsApp'],
    subject: 'Your offer for {{role}}',
    body: 'Hi {{name}}, an offer for {{role}} at {{client}} is on its way to you. '
      + 'Please review it and let your recruiter know.',
  },
  OFFER_ACCEPTED: {
    key: 'OFFER_ACCEPTED',
    label: 'Joining Formalities',
    channels: ['Email'],
    subject: 'Joining formalities for {{role}}',
    body: 'Hi {{name}}, thank you for accepting the offer for {{role}}. '
      + 'Please keep your ID and education documents ready for onboarding.',
  },
  JOINED: {
    key: 'JOINED',
    label: 'Joining Confirmed',
    channels: ['Email', 'WhatsApp'],
    subject: 'Welcome aboard — {{role}}',
    body: 'Hi {{name}}, your joining for {{role}} at {{client}} is confirmed. '
      + 'Congratulations, and all the best.',
  },
  HOLD: {
    key: 'HOLD',
    label: 'Application on Hold',
    channels: ['Email'],
    subject: 'Update on your application for {{role}}',
    body: 'Hi {{name}}, your application for {{role}} is on hold for now. '
      + 'We will get back to you when there is movement.',
  },
  REJECTED: {
    key: 'REJECTED',
    label: 'Application Closed',
    channels: ['Email'],
    subject: 'Update on your application for {{role}}',
    body: 'Hi {{name}}, we will not be moving forward with your application for {{role}} on this '
      + 'occasion. Your profile stays with us for other roles.',
  },
};

function fill(text, tokens) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (tokens[k] == null || tokens[k] === '' ? '—' : String(tokens[k])));
}

// Which address or number a channel is addressed to. No fallbacks invented: an
// SMS with no phone number on file is recorded with an empty recipient and a
// status detail saying so, rather than quietly disappearing.
function recipientFor(channel, candidate) {
  if (channel === 'Email') return candidate.email || '';
  return candidate.phone || '';
}

// --- Sender identity -------------------------------------------------------
// "When an employee is added, an email address is captured; candidate messages
// from that employee must go out through that same address."
//
// So: the acting user's EMPLOYEE record supplies the from-address. The User row
// is only a fallback for logins that carry no employee record (an admin seeded
// without one). Nothing here falls back to a company-wide default address.
async function senderIdentity(user) {
  if (!user) {
    return { senderName: null, senderEmail: null, senderSourceNote: 'No acting user' };
  }
  let employee = null;
  try {
    employee = await prisma.employee.findUnique({ where: { userId: user.id } });
  } catch {
    employee = null;
  }
  if (employee && employee.email) {
    return {
      senderUserId: user.id,
      senderEmployeeId: employee.id,
      senderName: employee.name || user.name,
      senderEmail: employee.email,
      senderSourceNote: `Employee record ${employee.employeeCode || employee.id}`,
    };
  }
  if (employee && !employee.email) {
    return {
      senderUserId: user.id,
      senderEmployeeId: employee.id,
      senderName: employee.name || user.name,
      senderEmail: user.email || null,
      senderSourceNote: `Employee record ${employee.employeeCode || employee.id} has no email — fell back to the login address`,
    };
  }
  return {
    senderUserId: user.id,
    senderEmployeeId: null,
    senderName: user.name || null,
    senderEmail: user.email || null,
    senderSourceNote: 'No employee record for this login — used the login address',
  };
}

// --- The trigger -----------------------------------------------------------
// Called by routes/applications.js on every stage transition. Returns the rows
// it wrote (possibly none — most transitions are internal and the candidate is
// not told about them).
async function recordStageCommunications({
  application, candidate, requirement, fromStage, toStage, user, comment,
}) {
  const template = TEMPLATES[toStage];
  if (!template || !candidate) return [];

  const sender = await senderIdentity(user);
  const tokens = {
    name: candidate.name,
    role: requirement ? requirement.title : '—',
    client: requirement ? (requirement.internal ? 'TeamLink Internal' : (requirement.client && requirement.client.name) || '—') : '—',
    interviewAt: application && application.interviewAt
      ? new Date(application.interviewAt).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
      : 'a time we will confirm',
    mode: (application && application.interviewMode) || 'to be confirmed',
    interviewer: (application && application.interviewer) || 'to be confirmed',
    deadline: (application && application.aiInterviewDeadline) || 'the date in your invite',
    sender: sender.senderName || '—',
  };

  const trigger = `Stage change: ${stageLabel(fromStage) || 'New'} → ${stageLabel(toStage)}`;
  const rows = [];
  for (const channel of template.channels) {
    const recipient = recipientFor(channel, candidate);
    const detail = recipient
      ? NOT_SENT_DETAIL
      : `${NOT_SENT_DETAIL} No ${channel === 'Email' ? 'email address' : 'phone number'} on this candidate's record.`;
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.candidateMessage.create({
      data: {
        candidateId: candidate.id,
        applicationId: application ? application.id : null,
        channel,
        template: template.key,
        templateLabel: template.label,
        trigger,
        recipient,
        subject: channel === 'Email' ? fill(template.subject, tokens) : null,
        body: fill(template.body, tokens),
        status: NOT_SENT,
        statusDetail: detail,
        stageFrom: fromStage || null,
        stageTo: toStage,
        ...sender,
      },
    });
    rows.push(row);
  }
  // Note: the recruiter's transition `comment` is deliberately NOT used here.
  // It is internal, it is recorded on the pipeline-history event, and it is
  // never pasted into a candidate-facing message.
  return rows;
}

module.exports = {
  TEMPLATES,
  NOT_SENT,
  NOT_SENT_DETAIL,
  senderIdentity,
  recordStageCommunications,
};
