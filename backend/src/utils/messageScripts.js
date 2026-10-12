// CALL SCRIPTS: what to say on the phone. Shown in the Call window; never sent.
// [purpose, label, audience, lines of the script]. The {{details}} are filled
// from the person's real record, like any other message template.
const SCRIPTS = [
  ['FU_INTERVIEW_REMINDER', 'Interview Reminder', 'candidate', [
    'Say hello: "Hi {{firstName}}, this is {{recruiterName}} from {{company}}."',
    'Remind them: interview for {{role}} at {{client}} on {{interviewAt}}.',
    'Ask: can you attend? Do you know the place or link? ({{venue}} {{meetingLink}})',
    'If not: ask for a better time and note it.']],
  ['FU_INTERVIEW_CONFIRMATION', 'Interview Confirmation', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Confirm: interview for {{role}} at {{client}} on {{interviewAt}} ({{mode}}).',
    'Ask them to keep ID and resume ready.']],
  ['FU_INTERVIEW_RESCHEDULE', 'Interview Reschedule', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Say sorry: the interview for {{role}} needs a new time.',
    'Ask which day and time suit them. Note it and confirm back.']],
  ['FU_DOCUMENT_REQUEST', 'Document Request', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Explain: we need your documents for {{role}} to go ahead.',
    'Ask which ones they have and when they can send them (WhatsApp is fine).']],
  ['FU_JOINING_CONFIRMATION', 'Joining Confirmation', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Confirm the joining for {{role}} at {{client}} on {{joiningDate}}.',
    'Ask: any problem with the date? Is the notice period done?']],
  ['FU_OFFER_FOLLOW_UP', 'Offer Follow-up', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Ask about the offer for {{role}} at {{client}} ({{offerCtc}}).',
    'Listen for doubts. Note their decision and when they will confirm.']],
  ['INTERVIEW_SCHEDULED', 'Interview Scheduled', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Tell them: interview for {{role}} at {{client}} on {{interviewAt}} ({{mode}}), interviewer {{interviewer}}.',
    'Ask them to confirm.']],
  ['BULK_NEW_OPENING', 'New opening', 'candidate', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Tell them about the new opening. Ask: are you looking for a change? Current CTC, expected CTC, notice period?',
    'Offer to send the details on WhatsApp.']],
  ['FU_CLIENT_DECISION_REMINDER', 'Candidate Decision Reminder', 'client', [
    'Say hello: "Hi {{firstName}}, {{recruiterName}} from {{company}}."',
    'Ask about the profiles shared for {{role}}: any decision? Any feedback?',
    'Note the answer and agree a date to call again.']],
];

module.exports = { SCRIPTS: SCRIPTS.map(([purpose, label, audience, lines]) => ({ purpose, label, audience, body: lines.join('\n') })) };
