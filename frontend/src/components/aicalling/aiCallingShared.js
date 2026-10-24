// Exotel AI Calling - words and small helpers shared by the AI Calling screens.
// Plain words only. "Requirement" (not job) inside the ATS.

export const PURPOSES = [
  { key: 'Screening', label: 'Screening call', hint: 'Ask if the candidate is interested in the requirement' },
  { key: 'Shortlist Notification', label: 'Tell them they are shortlisted', hint: 'Only for candidates at the shortlisted step' },
  { key: 'Interview Notification', label: 'Tell them the interview time', hint: 'Uses the real booked interview' },
  { key: 'Interview Reminder', label: 'Interview reminder', hint: 'Reminds them of the booked interview' },
];
export const purposeLabel = (k) => (PURPOSES.find((p) => p.key === k) || { label: k }).label;

export const STATUS_WORDS = {
  queued: 'Waiting', calling: 'On the phone', completed: 'Done', failed: 'Failed', busy: 'Busy', 'no-answer': 'No answer', cancelled: 'Cancelled',
};
export const STATUS_CLASS = {
  queued: 'pending', calling: 'interview', completed: 'active', failed: 'rejected', busy: 'hold', 'no-answer': 'hold', cancelled: 'new',
};
export const statusWord = (s) => STATUS_WORDS[s] || s;

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}
export function minutes(sec) {
  if (sec == null) return '';
  const n = Number(sec);
  if (!Number.isFinite(n)) return '';
  return n >= 60 ? `${Math.floor(n / 60)} min ${n % 60} s` : `${n} s`;
}
export const errorOf = (err, fallback) => (err && err.response && err.response.data && err.response.data.error) || fallback;

// the same event the offer host listens to (after a Shortlisted move or an interview booking)
export const OFFER_EVENT = 'tl:ai-offer-check';
