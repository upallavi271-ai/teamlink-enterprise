// ---------------------------------------------------------------------------
// AUTOMATIC STAGE MESSAGES - the built-in wording for the steps that had NO
// message before (so a manager can switch them on and the words already exist).
//
// PURE: no requires. utils/messageDefaults.js adds these to the built-in list
// the first time the Message templates screen is opened; they are only a
// starting point and are OFF by default (utils/autoMessageRules.js).
//
// Wording rules: friendly, short, no promises, never the client's name (the
// {{client}} detail is filled with "our client"), nothing about internal steps.
// ---------------------------------------------------------------------------

const ALL = ['Email', 'SMS', 'WhatsApp'];

// stage code -> [purpose key, label, email subject, body]
const STAGE_TEMPLATES = {
  RECRUITER_REVIEW: ['STAGE_RECRUITER_REVIEW', 'Profile being reviewed', 'We are reviewing your profile for {{role}}',
    'Hi {{firstName}}, our team is now reviewing your profile for {{role}}. We will tell you the next step soon. - {{recruiterName}}'],
  RECRUITER_APPROVED: ['STAGE_RECRUITER_APPROVED', 'Profile cleared first check', 'Good news about {{role}}',
    'Hi {{firstName}}, your profile for {{role}} has cleared our first check. We will tell you the next step soon. - {{recruiterName}}'],
  TL_REVIEW: ['STAGE_TL_REVIEW', 'Profile in final check', 'Your profile for {{role}} is being checked',
    'Hi {{firstName}}, your profile for {{role}} is in our final internal check. We will get back to you soon. - {{recruiterName}}'],
  WITH_BDE: ['STAGE_WITH_BDE', 'Profile with the hiring side', 'Your profile for {{role}} is moving ahead',
    'Hi {{firstName}}, your profile for {{role}} is moving ahead on our side. We will tell you the next step soon. - {{recruiterName}}'],
  BDE_APPROVED: ['STAGE_BDE_APPROVED', 'Profile ready to share', 'Your profile for {{role}} is ready',
    'Hi {{firstName}}, your profile for {{role}} is ready to be shared with the hiring team. - {{recruiterName}}'],
  CLIENT_REVIEW: ['STAGE_CLIENT_REVIEW', 'Hiring team is checking', 'The hiring team is checking your profile',
    'Hi {{firstName}}, the hiring team is checking your profile for {{role}}. We will come back to you as soon as we hear. - {{recruiterName}}'],
  CLIENT_SHORTLISTED: ['STAGE_CLIENT_SHORTLISTED', 'Shortlisted', 'You are shortlisted for {{role}}',
    'Hi {{firstName}}, good news: the hiring team has shortlisted you for {{role}}. We will share the interview details soon. - {{recruiterName}}'],
  AI_INTERVIEW_COMPLETED: ['STAGE_AI_INTERVIEW_COMPLETED', 'AI interview received', 'We received your AI interview',
    'Hi {{firstName}}, thank you for completing the AI screening interview for {{role}}. A recruiter will review it and come back to you. - {{recruiterName}}'],
  HIRED: ['STAGE_HIRED', 'Welcome to the team', 'Welcome - {{role}}',
    'Hi {{firstName}}, welcome to the team for {{role}}. Congratulations, and all the best. - {{recruiterName}}'],
};

// stage code -> the purpose key a rule uses when it has no wording of its own.
// NEW reuses the "Application received" starter that already exists.
const EXTRA_PURPOSE = {
  NEW: 'APPLICATION_RECEIVED',
  ...Object.fromEntries(Object.entries(STAGE_TEMPLATES).map(([stage, t]) => [stage, t[0]])),
};

function list() {
  const out = [];
  Object.values(STAGE_TEMPLATES).forEach(([purpose, label, subject, body]) => {
    ALL.forEach((channel) => out.push({ purpose, label, audience: 'candidate', channel, language: 'English', subject, body }));
  });
  return out;
}

module.exports = { STAGE_TEMPLATES, EXTRA_PURPOSE, list };
