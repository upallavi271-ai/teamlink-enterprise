// ---------------------------------------------------------------------------
// BUILT-IN MESSAGE WORDING — the wording that used to be hard-coded.
//
//   * the pipeline messages        utils/candidateComms.js TEMPLATES (the code
//                                  stays the source; this file reads it)
//   * the Contact-button purposes  utils/followups.js FOLLOWUP_TEMPLATES, with
//                                  the texts the Contact panel pre-fills
//   * the bulk-send starters       "New opening", "Profile update"
//   * a few purposes people asked for that had no wording yet (Application
//     received, Joining reminder, Client agreement link, Job alert)
//
// messageTemplates.ensureDefaults() saves these as version 1 the first time
// the Message templates tab is opened. They are only the starting point:
// nothing here is applied over a template somebody has edited.
// ---------------------------------------------------------------------------

const ALL = ['Email', 'SMS', 'WhatsApp'];

function fromStages() {
  // eslint-disable-next-line global-require
  const { TEMPLATES } = require('./candidateComms');
  const out = [];
  Object.values(TEMPLATES).forEach((t) => {
    t.channels.forEach((channel) => {
      out.push({ purpose: t.key, label: t.label, audience: 'candidate', channel, language: 'English', subject: t.subject, body: t.body });
    });
  });
  return out;
}

const FOLLOW_UPS = [
  ['FU_INTERVIEW_REMINDER', 'Interview Reminder', 'candidate', 'Reminder: your interview', 'Hi {{name}}, a reminder about your interview for {{role}} at {{client}}. Please confirm you are able to attend.'],
  ['FU_INTERVIEW_CONFIRMATION', 'Interview Confirmation', 'candidate', 'Your interview is confirmed', 'Hi {{name}}, your interview for {{role}} at {{client}} is confirmed. We will send the joining details shortly.'],
  ['FU_INTERVIEW_RESCHEDULE', 'Interview Reschedule', 'candidate', 'We need to move your interview', 'Hi {{name}}, we need to move your interview for {{role}} at {{client}}. Could you share a time that suits you?'],
  ['FU_DOCUMENT_REQUEST', 'Document Request', 'candidate', 'Documents we need from you', 'Hi {{name}}, could you send across your documents for {{role}} so we can proceed?'],
  ['FU_JOINING_CONFIRMATION', 'Joining Confirmation', 'candidate', 'Please confirm your joining', 'Hi {{name}}, confirming your joining for {{role}} at {{client}}. Please reply to confirm the date still works.'],
  ['FU_OFFER_FOLLOW_UP', 'Offer Follow-up', 'candidate', 'About your offer', 'Hi {{name}}, following up on the offer for {{role}} at {{client}}. Do let us know your decision.'],
  ['FU_CLIENT_CANDIDATE_SHARED', 'Candidate Shared', 'client', 'A profile for {{role}}', 'Hi {{name}}, we have shared a candidate profile for {{role}}. Please have a look and tell us what you think.'],
  ['FU_CLIENT_DECISION_REMINDER', 'Candidate Decision Reminder', 'client', 'Waiting for your decision on {{role}}', 'Hi {{name}}, a gentle reminder: we are waiting for your decision on the profiles shared for {{role}}.'],
  ['FU_CLIENT_FEEDBACK_REMINDER', 'Interview Feedback Reminder', 'client', 'Interview feedback for {{role}}', 'Hi {{name}}, could you share your feedback on the interview for {{role}}? It helps us move quickly.'],
  ['FU_CLIENT_JOINING_CONFIRMATION', 'Joining Confirmation (client)', 'client', 'Joining confirmation for {{role}}', 'Hi {{name}}, confirming the joining date for {{role}}. Please tell us if anything changes.'],
  ['FU_CLIENT_REQUIREMENT_FOLLOW_UP', 'Requirement Follow-up', 'client', 'About your job {{role}}', 'Hi {{name}}, a quick follow-up on your job {{role}}. Is the requirement still open, and is there anything to change?'],
];

const EXTRA = [
  ['BULK_NEW_OPENING', 'New opening', 'candidate', ALL, 'A new job that matches your profile', 'Hi {{firstName}}, we have a new opening that matches your profile. Reply if you would like the details. - {{recruiterName}}, {{company}}'],
  ['BULK_PROFILE_UPDATE', 'Profile update', 'candidate', ALL, 'Please update your details', 'Hi {{firstName}}, please reply with your current CTC, expected CTC and notice period so we can keep your profile current. - {{recruiterName}}, {{company}}'],
  ['APPLICATION_RECEIVED', 'Application received', 'candidate', ALL, 'We received your application for {{role}}', 'Hi {{name}}, thank you for applying for {{role}}. We have received your application and a recruiter will contact you soon. - {{company}}'],
  ['JOINING_REMINDER', 'Joining reminder', 'candidate', ALL, 'Your joining date for {{role}}', 'Hi {{name}}, a reminder that your joining for {{role}} at {{client}} is on {{joiningDate}}. Please reply if you need anything. - {{recruiterName}}'],
  ['JOB_ALERT', 'Job alert', 'candidate', ALL, 'A job for you: {{role}}', 'Hi {{firstName}}, a new job for you: {{role}}. See it and apply here: {{jobLink}} - {{company}}'],
  ['EMPLOYEE_NOTICE', 'General notice', 'employee', ALL, 'A notice from {{company}}', 'Hi {{firstName}}, a notice from {{recruiterName}}, {{company}}: '],
  ['EMPLOYEE_REMINDER', 'Reminder', 'employee', ALL, 'A reminder from {{company}}', 'Hi {{firstName}}, a reminder from {{recruiterName}}: please complete the pending item. Thank you.'],
  ['CLIENT_PAYMENT_REMINDER', 'Payment reminder', 'client', ALL, 'A reminder about your payment to {{company}}', 'Hi {{firstName}}, a gentle reminder about the payment due to {{company}} for the placement at {{client}}. If you have already paid, please ignore this message and share the payment details. Thank you. - {{recruiterName}}'],
  ['CLIENT_INVOICE_NOTICE', 'Invoice notice', 'client', ALL, 'Your invoice from {{company}}', 'Hi {{firstName}}, we have sent you the invoice for the placement at {{client}}. Please let us know if anything needs to change. Thank you. - {{recruiterName}}, {{company}}'],
  ['CLIENT_AGREEMENT_LINK', 'Client agreement link', 'client', ALL, 'Your agreement with {{company}}', 'Hi {{name}}, your agreement with {{company}} is ready. Please read and sign it here: {{agreementLink}}'],
];

let cache = null;
function list() {
  if (cache) return cache;
  const out = [...fromStages()];
  FOLLOW_UPS.forEach(([purpose, label, audience, subject, body]) => {
    ALL.forEach((channel) => out.push({ purpose, label, audience, channel, language: 'English', subject, body }));
  });
  EXTRA.forEach(([purpose, label, audience, channels, subject, body]) => {
    channels.forEach((channel) => out.push({ purpose, label, audience, channel, language: 'English', subject, body }));
  });
  // Automatic stage messages: starter wording for the steps that sent nothing before (all OFF by default).
  // eslint-disable-next-line global-require
  require('./autoMessageDefaults').list().forEach((d) => out.push(d));
  // Interview booked / moved / cancelled and the reminders before it (utils/interviewMessageDefaults.js).
  // eslint-disable-next-line global-require
  require('./interviewMessageDefaults').list().forEach((d) => out.push(d));
  // Candidate joined / dropped and the client's replacement decision (joindrop/messageDefaults.js).
  // eslint-disable-next-line global-require
  require('../joindrop/messageDefaults').list().forEach((d) => out.push(d));
  // The emails a vendor gets: welcome + set password, password reset, new email address (utils/vendorMessageDefaults.js).
  // eslint-disable-next-line global-require
  require('./vendorMessageDefaults').list().forEach((d) => out.push(d));
  // eslint-disable-next-line global-require
  require('./messageScripts').SCRIPTS.forEach((s) => out.push({ purpose: s.purpose, label: s.label, audience: s.audience, channel: 'Call', language: 'English', subject: '', body: s.body }));
  cache = out;
  return out;
}

const find = (purpose, channel) => list().find((d) => d.purpose === purpose && d.channel === channel) || null;

module.exports = { list, find };
