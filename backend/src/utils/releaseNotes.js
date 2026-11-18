// ---------------------------------------------------------------------------
// APP VERSION AND RELEASE NOTES (ATS audit 2026-11-18, Q16).
//
//   GET /api/version        { version, releasedAt, apiVersion, notes: [{ version, date, title, items[] }] }   (no sign-in needed: it names no data)
//   every API answer carries   X-TeamLink-Version: <version>   and   X-TeamLink-Api: v1
//   /api/v1/...             is the SAME API as /api/... (so an outside system can pin to v1 now; a later breaking change becomes /api/v2).
//   The browser shows the version in the footer and "What's new" lists the notes below.
//
// WHEN YOU SHIP SOMETHING PEOPLE WILL NOTICE: add one entry at the TOP of NOTES (newest first) and raise `version`. Semantic versioning:
// the first number for a change that breaks something outside, the second for a new feature, the third for a fix.
// ---------------------------------------------------------------------------
const API_VERSION = 'v1';

const NOTES = [
  {
    version: '1.5.1', date: '2026-11-18', title: 'Agents no longer time out',
    items: [
      'BDE Agent sends the model only what the question needs (exact counts always, details for the part you asked about), so answers stay inside the free AI limits and the candidate count is exact (it showed 1,500 because the list was capped).',
      'When the free AI plan is at its limit the agents wait the few seconds it asks, then try its smaller model, and always answer or explain within 40 seconds instead of ending in "TeamLink took too long".',
    ],
  },
  {
    version: '1.5.0', date: '2026-11-18', title: 'One pipeline per industry',
    items: [
      'Administration > Company Setup > Pipeline & checks > Industry pipelines: each department (Medical, Education, Manufacturing, IT ...) can switch off the steps it does not use, and a step can need a TL / STL / Manager / Admin to approve. Nothing changes until an Admin sets it.',
      'A candidate cannot be moved into a step its department does not use; the Move step list does not offer it. Anyone below the approval level who tries gets stopped and the approvers are told.',
      'The BDE Agent is now a button in the top bar (BDE, BDE TL, Super Admin and Developer logins), no longer floating over the page.',
    ],
  },
  {
    version: '1.4.0', date: '2026-11-18', title: 'Agents, audit fixes and webhooks',
    items: [
      'CRM Agent, CRM Meeting Agent (prep brief and notes to summary) and BDE Agent, answering from your own data through a free fast AI (Administration > Integrations > Fast AI).',
      'Resume reader: current CTC, expected CTC, notice period, RTF files, confidence per field, what is missing, and skills grouped as technical / soft / domain.',
      'AI Assistant finds candidates in plain words ("Find 10 Java developers in Hyderabad") and the best candidates for a requirement.',
      'A requirement put on hold or closed moves its active candidates to Hold and closes their follow-ups; reopening brings them back.',
      'Referral bonus is proposed automatically when a referred person joins (Referrals > Bonus rules).',
      'Candidate: professional registration (council, number, valid till, verification), alternate phone, native place, languages, super-specialisation, eligibility tests; hospital bed capacity on clients.',
      'Duplicate check also uses name + date of birth + qualification. Data quality lists wrong e-mails, phones and dates.',
      'Outgoing webhooks (Administration > Integrations > Webhooks): signed, retried, public https only.',
      'Every filter shows its overall count ("All departments (19)"). Filters are remembered when you leave a page and come back.',
      'Fixed: editing a candidate source no longer overwrites the first source.',
    ],
  },
];

const VERSION = NOTES[0].version;

// the response headers, for every request
function headers(req, res, next) {
  res.setHeader('X-TeamLink-Version', VERSION);
  res.setHeader('X-TeamLink-Api', API_VERSION);
  next();
}

// /api/v1/x -> /api/x (the same API under a version prefix an outside system can pin to)
function versionPrefix(req, res, next) {
  if (req.url === '/api/v1' || req.url.startsWith('/api/v1/') || req.url.startsWith('/api/v1?')) req.url = `/api${req.url.slice('/api/v1'.length)}`;
  next();
}

function info() {
  return { version: VERSION, releasedAt: NOTES[0].date, apiVersion: API_VERSION, notes: NOTES };
}

module.exports = { VERSION, API_VERSION, NOTES, headers, versionPrefix, info };
