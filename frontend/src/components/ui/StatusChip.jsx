import './ui.css';

// ---------------------------------------------------------------------------
// ONE COLOUR PER MEANING, EVERYWHERE — the user's five (ATS layout v3,
// 2026-10-03; supersedes the four-colour rule):
//
//   green   Good / Joined            (selected, joined, approved, done, active, open)
//   yellow  Pending                  (any review, hold, waiting, feedback pending, draft)
//   red     Late / Rejected          (overdue, late, rejected, no show, failed)
//   blue    In process               (new, applied, scheduled, interview, shared, sent)
//   grey    Closed                   (closed, cancelled, inactive, relieved)
//
// Use <StatusChip status="TL Review" /> or statusTone('TL Review') for a
// custom element. Pass tone="…" to force one when the word alone is not enough
// (e.g. a due date that is overdue). Older tone names keep working:
// amber / orange / warn / pending -> yellow, good -> green, bad -> red,
// info / new -> blue (normTone below).
// ---------------------------------------------------------------------------
const RULES = [
  // Narrow phrases that the broad words below would misread.
  ['green', /feedback (submitted|received|in)\b/i],
  ['red', /overdue|\blate\b|reject|no[\s_-]?show|fail|declin|absconded|termination|dropout|blacklist|expired/i],
  ['grey', /closed|cancel|inactive|relieved|exited|resigned|archived|withdrawn|on hold by client|no action|not applicable/i],
  // Pending = waiting on somebody. "Interview Completed" is a pipeline stage
  // meaning "waiting for feedback", so it is yellow, not green.
  // "Check by recruiter / team lead / client manager" are the review steps.
  ['yellow', /review|check by|pending|hold|waiting|feedback|await|draft|due today|rescheduled|agreement check|negotiat|interview completed|interview done|client decides/i],
  // In process = moving, nobody is stuck.
  ['blue', /in progress|started|\bsent\b|shared|with client|client checking|sourcing/i],
  ['green', /ready to send|select|join|hired|complete|active|open|approved|accepted|present|paid|\bsigned|done|offer/i],
  ['blue', /new|upcoming|applied|schedul|confirm|sourced|shortlist|today|interview|assigned|available|process/i],
];

const ALIAS = {
  green: 'green', good: 'green', success: 'green', ok: 'green',
  yellow: 'yellow', amber: 'yellow', orange: 'yellow', warn: 'yellow', warning: 'yellow', pending: 'yellow',
  red: 'red', bad: 'red', danger: 'red', late: 'red', error: 'red',
  blue: 'blue', info: 'blue', new: 'blue', process: 'blue',
  grey: 'grey', gray: 'grey', muted: 'grey', closed: 'grey',
};
// Any tone name in use -> one of the five ('' / unknown -> null).
export function normTone(tone) {
  return ALIAS[String(tone || '').toLowerCase()] || null;
}

export function statusTone(status) {
  const s = String(status || '').trim();
  if (!s) return 'grey';
  for (const [tone, re] of RULES) if (re.test(s)) return tone;
  return 'grey';
}

export default function StatusChip({ status, tone, children, title, className = '' }) {
  const t = normTone(tone) || statusTone(status);
  return (
    <span className={`st-chip st-${t} ${className}`} title={title || undefined}>
      {children || status || '—'}
    </span>
  );
}
