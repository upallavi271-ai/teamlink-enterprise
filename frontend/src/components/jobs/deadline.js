// A requirement's DEADLINE (user 2026-10-03): the Target date, else the
// Closing date. "12 Oct · 5 days left"; red when late (not closed);
// "No deadline" when neither is set. Used by the Jobs list and the
// requirement detail's summary strip.
export function deadlineInfo(r) {
  const raw = (r && (r.targetDate || r.closingDate)) || '';
  const d = /^\d{4}-\d{2}-\d{2}/.test(raw) ? new Date(`${raw.slice(0, 10)}T00:00:00`) : null;
  if (!d || Number.isNaN(d.getTime())) return { text: 'No deadline', none: true };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const closed = r.status === 'CLOSED';
  let left;
  if (closed) left = 'closed';
  else if (days < 0) left = `${-days} day${days === -1 ? '' : 's'} late`;
  else if (days === 0) left = 'due today';
  else left = `${days} day${days === 1 ? '' : 's'} left`;
  return { text: `${day} · ${left}`, overdue: !closed && days < 0, soon: !closed && days >= 0 && days <= 7 };
}

export const DEADLINE_LABEL = {
  overdue: 'Late', week: 'Next 7 days', month: 'Next 30 days', none: 'No deadline',
};
