// ---------------------------------------------------------------------------
// Candidate communications — Email / SMS / WhatsApp.
//
// READ THIS BEFORE BELIEVING ANYTHING THIS MODULE SAYS ABOUT DELIVERY.
//
// WHAT IS REAL NOW
//   EMAIL is real. Administration → Integrations → Email (SMTP) holds the
//   host, port, encryption, username and password (encrypted at rest — see
//   utils/secrets.js). utils/mailWorker.js picks the rows up, hands them to
//   nodemailer and writes back the provider's own message id, sentAt and
//   status. A row reaches SENT only when the provider accepted it.
//
// WHAT IS STILL NOT
//   SMS and WhatsApp. There is no Twilio/MSG91 account and no WhatsApp
//   Business API, so those rows keep status NOT_SENT_NO_PROVIDER and the UI
//   keeps labelling them "Not sent — no provider". That remains TRUE, and it
//   is the correct state for EMAIL too whenever the SMTP channel is not
//   configured. A row is evidence that the app decided to contact this
//   person; only SENT is evidence that the person was contacted.
//
// STILL MISSING FOR EMAIL (honest list):
//   * delivery/bounce webhooks — the worker knows the provider ACCEPTED the
//     message, not that the mailbox received it. There is no DELIVERED or
//     READ state, and nothing here claims one.
//   * opt-out / suppression handling: a bounced or unsubscribed address is
//     not yet stopped from being written to again.
//   * SMS and WhatsApp, as above.
//
// SENDER IDENTITY
// The user's requirement: an employee's email is captured when the employee is
// added, and candidate messages from that employee go out through that same
// address. senderIdentity() resolves Employee.email for the acting user and
// stores it on the row; utils/mailer.js then carries it into the envelope as
// the header From with Reply-To, over an authenticated envelope sender. There
// is no hardcoded from-address anywhere in this file — if an employee has no
// email on their record the row records that fact rather than substituting a
// default. Per-employee From addresses need SPF/DKIM/DMARC on that employee's
// domain; the README says so.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { stageLabel } = require('./atsVocab');

// The honest "nothing was transmitted" status. Kept as a constant so no screen
// can invent "Sent"; only the worker, having heard from a provider, may.
const NOT_SENT = 'NOT_SENT_NO_PROVIDER';
const NOT_SENT_DETAIL = 'Recorded, not transmitted — this app has no Email/SMS/WhatsApp provider configured.';

// --- Templates -------------------------------------------------------------
// One entry per triggering stage. `channels` is which of Email / SMS / WhatsApp
// that transition uses. Bodies are plain text with {{tokens}} filled from the
// candidate, requirement and application.
const TEMPLATES = {
  // STAGE MESSAGES ON EVERY CHANNEL (founder 2026-11-10: "candidate aa stage lo unnaro aa stage ki mail vellali ... ATS ki move ayite you are
  // shortlisted, client interview ki adigithe 2nd round interview, client reject chesthe rejected, shortlist ayite shortlisted, joining date ki
  // follow-ups ... mails ante mails aa kaadu whatsapp, sms kuda povali"). SENT_TO_ATS is not a pipeline stage: it is the moment a Job Portal
  // candidate leaves the screening for the ATS (routes/jobPortal.js Send to ATS, utils/autoSendToAts.js the 65% rule).
  SENT_TO_ATS: {
    key: 'ATS_SHORTLISTED',
    label: 'You are shortlisted',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'You are shortlisted for {{role}}',
    body: 'Hi {{name}}, good news: you are shortlisted for {{role}}. Our recruiter will contact you about the next round. - TeamLink',
  },
  CLIENT_SHORTLISTED: {
    key: 'STAGE_CLIENT_SHORTLISTED',
    label: 'Shortlisted',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'You are shortlisted for {{role}}',
    body: 'Hi {{firstName}}, good news: the hiring team has shortlisted you for {{role}}. We will share the interview details soon. - {{recruiterName}}',
  },
  AI_INTERVIEW_SCHEDULED: {
    key: 'AI_INTERVIEW_SCHEDULED',
    label: 'AI Interview Scheduled',
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'Your AI screening interview for {{role}}',
    body: 'Hi {{name}}, your AI screening interview for {{role}} at {{client}} is scheduled. '
      + 'Please complete it before {{deadline}}. Start it here: {{aiInterviewLink}} (sign in, open My Applications, '
      + 'press Attend AI Interview). The AI interview is a screening aid only — a recruiter reviews every result.',
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
    // {{interviewName}} = "2nd round interview" after the AI interview (the 1st round), else "interview"
    subject: 'Your {{interviewName}}: {{role}}',
    body: 'Hi {{name}}, your {{interviewName}} for {{role}} at {{client}} is scheduled for {{interviewAt}} '
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
    channels: ['Email', 'SMS', 'WhatsApp'],
    subject: 'Update on your application for {{role}}',
    body: 'Hi {{name}}, we will not be moving forward with your application for {{role}} on this '
      + 'occasion. Your profile stays with us for other roles.',
  },
};

// The interview a candidate is invited to: after the AI interview (the 1st round) the client's is the 2nd round.
function interviewNameOf(application) {
  return application && String(application.aiInterviewStatus || '').toLowerCase() === 'completed' ? '2nd round interview' : 'interview';
}

// Fills {{tokens}} through the Message templates renderer; a detail nobody has stays "—" as before.
// The AI interview message always carries its link, also when an Admin's saved wording has none (2026-11-03).
function withAiLink(key, body, link) {
  if (key !== 'AI_INTERVIEW_SCHEDULED' || !link || String(body || '').includes(link)) return body;
  return `${body}\n\nStart your AI interview: ${link}`;
}

function fill(text, tokens) {
  // eslint-disable-next-line global-require
  return require('./messageTemplates').render(text, tokens, { blank: '—' }).text;
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
  application, candidate, requirement, fromStage, toStage, user, comment, stageEventId, silent,
}) {
  // silent: imports and historical loads never message anybody (no row, no log).
  if (silent) return [];
  // A Job Portal applicant sees the new stage on the portal right away (utils/jobPortalBridge.js pushStagesSoon), not at the hourly sync.
  if (application && (application.source === 'TeamLink Job Portal' || application.portalImportedAt)) {
    try { require('./jobPortalBridge').pushStagesSoon(); } catch { /* the hourly sync still carries it */ } // eslint-disable-line global-require
  }
  // SELECTED: the confirmation mail is written by itself and waits for the TL's Send (utils/selectionMail.js,
  // founder 2026-11-04). It takes the place of the automatic "Selected" message, so nothing goes by itself.
  if (toStage === 'SELECTED' && candidate) {
    try {
      // eslint-disable-next-line global-require
      await require('./selectionMail').onSelected({ application, candidate, requirement, user });
      return [];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[selection-mail] could not write the mail, using the old path:', err && err.message);
    }
  }
  // AUTOMATIC STAGE MESSAGES (utils/autoMessages.js): once an Admin / HR has saved the rules the
  // scheduling engine owns this move (one scheduled row per move, rules, caps, quiet hours ...).
  // Before that - and on any error - the code below runs exactly as it always did.
  try {
    // eslint-disable-next-line global-require
    const handled = await require('./autoMessages').handleStageMove({
      application, candidate, requirement, fromStage, toStage, user, comment, stageEventId,
    });
    if (handled && handled.handled) return handled.rows || [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auto-messages] could not schedule, using the old path:', err && err.message);
  }
  const template = TEMPLATES[toStage];
  if (!template || !candidate) return [];
  // EVERY PIPELINE MESSAGE FOLLOWS THE ONE "CANDIDATE EMAILS" SWITCH
  // (utils/interviewNotices.js, OFF by default; e2e gap 4, 2026-10-03). While
  // it is off the message is still recorded — "Not sent — candidate emails are
  // switched off" — so it shows on Communications, but nothing is queued for
  // the real SMTP / SMS / WhatsApp.
  // eslint-disable-next-line global-require
  const IN = require('./interviewNotices');
  const switchedOn = await IN.candidateEmailsOn();

  const sender = await senderIdentity(user);
  const tokens = {
    name: candidate.name,
    role: requirement ? requirement.title : '—',
    // CANDIDATES NEVER SEE THE CLIENT'S NAME (the same rule as utils/autoMessages.js tokensFor).
    client: requirement ? (requirement.internal ? 'TeamLink Internal' : 'our client') : '—',
    interviewAt: application && application.interviewAt
      ? new Date(application.interviewAt).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
      : 'a time we will confirm',
    mode: (application && application.interviewMode) || 'to be confirmed',
    interviewer: (application && application.interviewer) || 'to be confirmed',
    deadline: (application && application.aiInterviewDeadline) || 'the date in your invite',
    aiInterviewLink: require('./messageContext').appTokens({ requirement: requirement || {} }).aiInterviewLink || '', // eslint-disable-line global-require
    sender: sender.senderName || '—',
    firstName: String(candidate.name || '').trim().split(/\s+/)[0] || candidate.name,
    recruiterName: sender.senderName || 'TeamLink',
    interviewName: interviewNameOf(application),
  };

  const trigger = `Stage change: ${stageLabel(fromStage) || 'New'} → ${toStage === 'SENT_TO_ATS' ? 'Sent to ATS (shortlisted)' : stageLabel(toStage)}`;

  // Is there a live provider for this channel right now? Only Email can have
  // one. If there is, the row is QUEUED and the worker will really send it;
  // if there is not, it keeps the honest "recorded, not transmitted" state.
  // eslint-disable-next-line global-require
  const { emailConfig } = require('./mailer');
  let emailLive = false;
  try { emailLive = (await emailConfig()).configured; } catch { emailLive = false; }

  const liveCache = {};
  async function channelLive(ch) {
    if (liveCache[ch] === undefined) {
      try {
        // eslint-disable-next-line global-require
        liveCache[ch] = !!(await require('./messaging').channelStatus())[ch].configured;
      } catch { liveCache[ch] = false; }
    }
    return liveCache[ch];
  }
  const rows = [];
  let queuedAnEmail = false;
  for (const channel of template.channels) {
    const recipient = recipientFor(channel, candidate);
    // THE WORDING comes from Administration → Company Setup → Message templates (the
    // built-in text above is the fallback, and what the templates start as).
    // eslint-disable-next-line no-await-in-loop, global-require
    const tpl = (await require('./messageTemplates').resolve({ purpose: template.key, channel })) || template;
    // SMS / WhatsApp are real channels too now (utils/messaging.js): a row is
    // QUEUED when ITS channel is configured, and the worker sends it.
    // eslint-disable-next-line no-await-in-loop
    const live = switchedOn && !!recipient && (channel === 'Email' ? emailLive : await channelLive(channel));
    // eslint-disable-next-line no-nested-ternary
    const detail = !switchedOn ? `${IN.SWITCHED_OFF_DETAIL}.` : live
      ? 'Queued for sending.'
      : (recipient
        ? NOT_SENT_DETAIL
        : `${NOT_SENT_DETAIL} No ${channel === 'Email' ? 'email address' : 'phone number'} on this candidate's record.`);
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
        subject: channel === 'Email' ? fill(tpl.subject, tokens) : null,
        sendSpec: channel === 'Email' ? null : IN.sendSpecFor(tpl, channel, tokens),
        body: withAiLink(template.key, fill(tpl.body, tokens), tokens.aiInterviewLink),
        // eslint-disable-next-line no-nested-ternary
        status: !switchedOn ? IN.SWITCHED_OFF : (live ? 'QUEUED' : NOT_SENT),
        statusDetail: detail,
        stageFrom: fromStage || null,
        stageTo: toStage,
        ...sender,
      },
    });
    if (live) queuedAnEmail = true;
    rows.push(row);
  }
  // Hand the queue to the worker now rather than waiting for its next tick.
  if (queuedAnEmail) {
    // eslint-disable-next-line global-require
    require('./mailWorker').kick();
  }
  // Note: the recruiter's transition `comment` is deliberately NOT used here.
  // It is internal, it is recorded on the pipeline-history event, and it is
  // never pasted into a candidate-facing message.
  return rows;
}

// The sentence the Communications tab prints above the table. It has to tell
// the truth about the CURRENT configuration, not a compile-time assumption.
async function commsNote() {
  let email = { configured: false, reason: '' };
  try {
    // eslint-disable-next-line global-require
    email = await require('./mailer').emailConfig();
  } catch { email = { configured: false, reason: '' }; }
  let status = null;
  try {
    // eslint-disable-next-line global-require
    status = await require('./messaging').channelStatus();
  } catch { status = null; }
  const live = status ? ['SMS', 'WhatsApp'].filter((c) => status[c].configured) : [];
  const off = ['SMS', 'WhatsApp'].filter((c) => !live.includes(c));
  const others = `${live.length ? ` ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} connected and sent the same way.` : ''}${off.length ? ` ${off.join(' and ')} ${off.length > 1 ? 'have' : 'has'} no provider configured, so those rows stay recorded but not transmitted.` : ''}`;
  if (email.configured) {
    return `Email is connected (${email.host}) and these messages are really sent — a row reaches "Sent" only when the provider accepted it, and carries the provider's message id.${others}`;
  }
  return live.length ? `Email has no provider configured.${others}` : NOT_SENT_DETAIL;
}

// How a status code reads on screen. One place, so no screen can invent a
// label for a state the worker never writes.
const STATUS_LABELS = {
  NOT_SENT_NO_PROVIDER: 'Not sent — no provider',
  NOT_SENT_SWITCHED_OFF: 'Not sent — candidate emails are switched off',
  NOT_SENT_BLOCKED: 'Not sent — blocked (see the reason)',
  QUEUED: 'Queued',
  RETRY: 'Retrying',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  RECEIVED: 'Reply received',
  FAILED: 'Failed',
};

module.exports = {
  TEMPLATES,
  NOT_SENT,
  NOT_SENT_DETAIL,
  STATUS_LABELS,
  commsNote,
  senderIdentity,
  recordStageCommunications,
};
