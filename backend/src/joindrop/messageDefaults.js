// ---------------------------------------------------------------------------
// JOINING & DROP - starter wording for the Message templates hub (Administration -> Company Setup -> Message templates).
// Read by utils/messageDefaults.js; an Admin / HR / TL edits it there (a saved edit always wins over these words).
//
//   JOINING_CONFIRMED        email   "X joined" - to the client, the recruiter, the TL, the BDE and HR
//   JOINING_WELCOME          email + WhatsApp   the candidate's own welcome / confirmation (never the client's name)
//   CANDIDATE_DROPPED        email   "X dropped" - to the client (when someone else reported it), the recruiter, the TL, the BDE and HR
//   DROP_CANDIDATE_NOTICE    email + WhatsApp   the candidate, only if an Admin switches it on (sensitive)
//   REPLACEMENT_DECISION     email   "the client decided: ..." - to the recruiter, the TL, the BDE and HR
//
// Tokens are filled by joindrop/notify.js: {{name}} is the person READING the message; {{candidate}} is the candidate it is about.
// Never the candidate's phone, email or pay. Never the word "Draft".
// ---------------------------------------------------------------------------
const ROWS = [
  {
    purpose: 'JOINING_CONFIRMED', label: 'Candidate joined (to client and team)', audience: 'client', channels: ['Email'],
    subject: '{{candidate}} joined {{client}} on {{joinedOn}}',
    body: 'Hi {{firstName}},\n\n{{candidate}} has joined {{client}} as {{role}}.\n\nJoined on: {{joinedOn}}\nPlace: {{joinLocation}}\n\n{{openLink}}\n\n- TeamLink',
  },
  {
    purpose: 'JOINING_WELCOME', label: 'Joining welcome (to the candidate)', audience: 'candidate', channels: ['Email', 'WhatsApp'],
    subject: 'Congratulations on joining as {{role}}',
    body: 'Hi {{firstName}}, congratulations! TeamLink has noted that you joined {{client}} as {{role}} on {{joinedOn}} at {{joinLocation}}. We wish you all the best. If any detail is wrong, please reply and tell us. - TeamLink',
  },
  {
    purpose: 'CANDIDATE_DROPPED', label: 'Joined candidate dropped (to client and team)', audience: 'employee', channels: ['Email'],
    subject: '{{candidate}} dropped from {{client}} ({{droppedOn}})',
    body: 'Hi {{firstName}},\n\n{{candidate}} has dropped from {{client}} ({{role}}).\n\nJoined on: {{joinedOn}}\nDropped on: {{droppedOn}}\nReason: {{dropReason}}\n{{dropDetails}}Replacement period: {{withinGuarantee}}\nReported by: {{reportedBy}}\n\n{{openLink}}\n\n- TeamLink',
  },
  {
    purpose: 'DROP_CANDIDATE_NOTICE', label: 'Drop notice (to the candidate)', audience: 'candidate', channels: ['Email', 'WhatsApp'],
    subject: 'About your work as {{role}}',
    body: 'Hi {{firstName}}, we have a note that your work as {{role}} with our client ended on {{droppedOn}}. If this is not right, please reply and tell us. We are here to help you find your next role. - TeamLink',
  },
  {
    purpose: 'REPLACEMENT_DECISION', label: 'Client decided about a replacement (to the team)', audience: 'employee', channels: ['Email'],
    subject: '{{client}}: {{decision}} for {{candidate}}',
    body: 'Hi {{firstName}},\n\n{{client}} has decided about {{candidate}} ({{role}}), who dropped on {{droppedOn}}.\n\nDecision: {{decision}}\nReason for the drop: {{dropReason}}\nClient comment: {{decisionNote}}\nExpected replacement by: {{expectedOn}}\n\n{{openLink}}\n\n- TeamLink',
  },
];

function list() {
  const out = [];
  ROWS.forEach((r) => r.channels.forEach((channel) => out.push({
    purpose: r.purpose, label: r.label, audience: r.audience, channel, language: 'English', subject: r.subject, body: r.body,
  })));
  return out;
}

const find = (purpose, channel) => ROWS.find((r) => r.purpose === purpose && r.channels.includes(channel)) || null;

module.exports = { ROWS, list, find };
