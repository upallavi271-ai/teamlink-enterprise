import StatusChip from '../ui/StatusChip.jsx';
import './followups.css';

// ---------------------------------------------------------------------------
// "WAS THIS CANDIDATE FOLLOWED UP?" at a glance (spec 2026-10-03, C1).
//
// Reads the fields GET /api/candidates already puts on every row (backend
// utils/followupVisibility.js contactStatus): lastContactAt, lastContactDays,
// lastContactMode, lastContactBy, contactBadge {key,label,tone,why}.
//
//   <LastContactCell row={row} />   "2 days ago" · or red "Never" · + badge
//   lastContactText(row)            the words alone ("Today", "Never", …)
//   CONTACT_FILTER_OPTIONS          the Filters-panel choices (?contact=)
// ---------------------------------------------------------------------------

export const CONTACT_FILTER_OPTIONS = [
  { value: 'never', label: 'Never contacted' },
  { value: 'stale3', label: 'Not contacted in 3 days' },
  { value: 'overdue', label: 'Late follow-ups' },
];

// Badge colours: red problem, orange waiting, green done.
const TONE = { red: 'red', orange: 'amber', green: 'green' };

export function daysAgoText(days) {
  if (days === null || days === undefined) return 'Never';
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

export function lastContactText(row) {
  if (!row || !row.lastContactAt) return 'Never';
  return daysAgoText(row.lastContactDays);
}

const MODE_WORD = { Call: 'Call', Email: 'Mail', WhatsApp: 'WhatsApp', SMS: 'SMS', 'In Person': 'Met' };

export function ContactBadge({ badge }) {
  if (!badge) return null;
  return <StatusChip tone={TONE[badge.tone] || 'grey'} title={badge.why || undefined}>{badge.label}</StatusChip>;
}

export default function LastContactCell({ row, showBadge = true, showBy = false }) {
  if (!row) return null;
  const never = !row.lastContactAt;
  const when = lastContactText(row);
  const title = never ? 'Nobody has called, mailed or WhatsApped this person yet'
    : `${new Date(row.lastContactAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${row.lastContactMode ? ` · ${MODE_WORD[row.lastContactMode] || row.lastContactMode}` : ''}${row.lastContactBy ? ` · ${row.lastContactBy}` : ''}`;
  return (
    <span className="fux-last" title={title}>
      <span className={`fux-last-when${never ? ' is-never' : ''}`}>{when}</span>
      {showBy && !never && (row.lastContactMode || row.lastContactBy) && (
        <span className="fux-last-by">{[MODE_WORD[row.lastContactMode] || row.lastContactMode, row.lastContactBy].filter(Boolean).join(' · ')}</span>
      )}
      {showBadge && <ContactBadge badge={row.contactBadge} />}
    </span>
  );
}
