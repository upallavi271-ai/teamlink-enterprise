import './ui.css';

// ---------------------------------------------------------------------------
// ONE COLOUR PER MEANING, EVERYWHERE (ATS review #3 §24).
//
//   blue    New / Upcoming           (new, applied, scheduled, confirmed)
//   amber   Waiting / Pending        (any review, hold, feedback pending)
//   green   Completed / Active / Selected / Joined / Open
//   red     Overdue / Rejected / No Show / Failed
//   grey    Inactive / Closed / Cancelled / Relieved
//
// Use <StatusChip status="TL Review" /> or statusTone('TL Review') for a
// custom element. Pass tone="…" to force one when the word alone is not enough
// (e.g. a due date that is overdue).
// ---------------------------------------------------------------------------
const RULES = [
  // Narrow phrases that the broad words below would misread.
  ['green', /feedback (submitted|received)/i],
  ['red', /overdue|reject|no[\s_-]?show|fail|declin|absconded|termination|dropout|blacklist|expired/i],
  ['grey', /closed|cancel|inactive|relieved|exited|resigned|archived|withdrawn|on hold by client|no action|not applicable/i],
  // "Interview Completed" is a pipeline stage meaning "waiting for feedback",
  // so it is amber, not green like a finished task.
  ['amber', /review|pending|hold|waiting|feedback|await|draft|due today|rescheduled|in progress|started|sent|shared|agreement check|negotiat|interview completed|sourcing/i],
  ['green', /select|join|hired|complete|active|open|approved|accepted|present|paid|\bsigned|done|offer/i],
  ['blue', /new|upcoming|applied|schedul|confirm|sourced|shortlist|today|interview|assigned|available/i],
];

export function statusTone(status) {
  const s = String(status || '').trim();
  if (!s) return 'grey';
  for (const [tone, re] of RULES) if (re.test(s)) return tone;
  return 'grey';
}

export default function StatusChip({ status, tone, children, title, className = '' }) {
  const t = tone || statusTone(status);
  return (
    <span className={`st-chip st-${t} ${className}`} title={title || undefined}>
      {children || status || '—'}
    </span>
  );
}
