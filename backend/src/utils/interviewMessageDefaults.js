// ---------------------------------------------------------------------------
// INTERVIEW MESSAGE WORDING (user, 2026-10-10): what the candidate is told when an interview is
// BOOKED, MOVED or CANCELLED, and the reminders that go before it. Read by messageDefaults.js, so
// the words appear in Administration -> Company Setup -> Message templates (and can be edited
// there; a saved edit always wins over these starter words).
//
// Rules for the wording:
//   * never the client's name: {{client}} is filled with "our client" for every candidate message
//     (utils/messageContext.js), the same rule the automatic stage messages follow;
//   * plain words, the same facts every time: round, when, where (link or address), interviewer,
//     who to ask ({{interviewContact}} = the job's recruiter), and "reply OK to confirm";
//   * nothing about internal steps or why an interview was cancelled.
// ---------------------------------------------------------------------------

const ALL = ['Email', 'SMS', 'WhatsApp'];

const FACTS = 'Round: {{interviewRound}}\nWhen: {{interviewAt}}\nWhere: {{interviewWhere}}\nInterviewer: {{interviewer}}';

// purpose, label, email subject, short text (SMS + WhatsApp), email text
const ROWS = [
  ['INTERVIEW_BOOKED', 'Interview booked', 'Your interview for {{role}} is booked: {{interviewAt}}',
    `Hi {{firstName}}, your interview for {{role}} at {{client}} is booked.\n${FACTS}\nPlease reply OK to confirm. Questions? {{interviewContact}}\n- TeamLink`,
    `Hi {{name}},\n\nYour interview for {{role}} at {{client}} is booked.\n\n${FACTS}\n\nPlease reply OK to confirm that you can come. If you cannot make it, tell us as early as you can: {{interviewContact}}.\n\n- TeamLink`],
  ['INTERVIEW_MOVED', 'Interview moved', 'Your interview for {{role}} has a new time: {{interviewAt}}',
    `Hi {{firstName}}, your interview for {{role}} at {{client}} has a new time.\n${FACTS}\nPlease reply OK to confirm. Questions? {{interviewContact}}\n- TeamLink`,
    `Hi {{name}},\n\nYour interview for {{role}} at {{client}} has a new time.\n\n${FACTS}\n\nPlease reply OK to confirm the new time. If it does not suit you, tell us: {{interviewContact}}.\n\n- TeamLink`],
  ['INTERVIEW_CANCELLED', 'Interview cancelled', 'Your interview for {{role}} on {{interviewAt}} is cancelled',
    'Hi {{firstName}}, your interview for {{role}} at {{client}} on {{interviewAt}} is cancelled. We will tell you the new time soon. Questions? {{interviewContact}}\n- TeamLink',
    'Hi {{name}},\n\nYour interview for {{role}} at {{client}} on {{interviewAt}} is cancelled. We will tell you the new time soon.\n\nQuestions? {{interviewContact}}.\n\n- TeamLink'],
  ['INTERVIEW_REMIND_DAY', 'Interview reminder (1 day before)', 'Reminder: your interview for {{role}} is on {{interviewDate}}',
    `Hi {{firstName}}, a reminder: your interview for {{role}} is coming up.\n${FACTS}\nReply OK to confirm, or tell us now if you need a new time: {{interviewContact}}\n{{prepNote}}\n- TeamLink`,
    `Hi {{name}},\n\nA reminder: your interview for {{role}} is coming up.\n\n${FACTS}\n\nPlease reply OK to confirm. If you cannot come, tell us now so we can find a new time: {{interviewContact}}.\n\n{{prepNote}}\n\n- TeamLink`],
  ['INTERVIEW_REMIND_HOUR', 'Interview reminder (1 hour)', 'Your interview for {{role}} starts in 1 hour',
    `Hi {{firstName}}, your interview for {{role}} starts in 1 hour.\nWhen: {{interviewAt}}\nWhere: {{interviewWhere}}\nInterviewer: {{interviewer}}\nCannot come? Call now: {{interviewContact}}\n- TeamLink`,
    `Hi {{name}},\n\nYour interview for {{role}} starts in 1 hour.\n\nWhen: {{interviewAt}}\nWhere: {{interviewWhere}}\nInterviewer: {{interviewer}}\n\nIf there is any problem, call us now: {{interviewContact}}.\n\n- TeamLink`],
  ['INTERVIEW_REMIND_NOW', 'Interview reminder (15 minutes, with link)', 'Your interview starts in 15 minutes - join here',
    'Hi {{firstName}}, your interview for {{role}} starts in 15 minutes.\nJoin here: {{interviewWhere}}\nInterviewer: {{interviewer}}\nAll the best! - TeamLink',
    'Hi {{name}},\n\nYour interview for {{role}} starts in 15 minutes.\n\nJoin here: {{interviewWhere}}\nInterviewer: {{interviewer}}\n\nAll the best!\n\n- TeamLink'],
];

// What to say on the phone (the Call window).
const SCRIPTS = [
  ['INTERVIEW_BOOKED', 'Interview booked', [
    'Say hello: "Hi {{firstName}}, this is {{recruiterName}} from {{company}}."',
    'Tell them: interview for {{role}} at {{client}}, round {{interviewRound}}, on {{interviewAt}}.',
    'Where: {{interviewWhere}}. Interviewer: {{interviewer}}.',
    'Ask them to confirm they can come. If not, ask for a better time and note it.']],
  ['INTERVIEW_MOVED', 'Interview moved', [
    'Say hello: "Hi {{firstName}}, this is {{recruiterName}} from {{company}}."',
    'Say sorry: the interview for {{role}} has a new time: {{interviewAt}}.',
    'Where: {{interviewWhere}}. Ask them to confirm the new time.']],
  ['INTERVIEW_CANCELLED', 'Interview cancelled', [
    'Say hello: "Hi {{firstName}}, this is {{recruiterName}} from {{company}}."',
    'Tell them kindly: the interview for {{role}} on {{interviewAt}} is cancelled.',
    'Say you will tell them the new time soon. Ask if they have any question.']],
];

function list() {
  const out = [];
  ROWS.forEach(([purpose, label, subject, short, mail]) => {
    ALL.forEach((channel) => out.push({
      purpose, label, audience: 'candidate', channel, language: 'English', subject, body: channel === 'Email' ? mail : short,
    }));
  });
  SCRIPTS.forEach(([purpose, label, lines]) => out.push({
    purpose, label, audience: 'candidate', channel: 'Call', language: 'English', subject: '', body: lines.join('\n'),
  }));
  return out;
}

// event of an interview -> the purpose key of its message.
const PURPOSE_OF = {
  scheduled: 'INTERVIEW_BOOKED', rescheduled: 'INTERVIEW_MOVED', cancelled: 'INTERVIEW_CANCELLED',
  reminder_day: 'INTERVIEW_REMIND_DAY', reminder_hour: 'INTERVIEW_REMIND_HOUR', reminder_now: 'INTERVIEW_REMIND_NOW',
};
const LABEL_OF = Object.fromEntries(ROWS.map(([purpose, label]) => [purpose, label]));
const PURPOSES = ROWS.map((r) => r[0]);

module.exports = { list, PURPOSE_OF, LABEL_OF, PURPOSES, ROWS };
