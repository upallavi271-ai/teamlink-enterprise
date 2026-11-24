import { t as tr } from '../../i18n.jsx'; // Telugu / Hindi when chosen (ATS wave 2 Z, 13.06)
import './ui.css';

// ---------------------------------------------------------------------------
// Helpful empty states (review #3 §22): say what is empty AND what to do.
//
//   <EmptyState icon="🎉" title="No pending actions" hint="You're all caught up." />
//   <EmptyState title="No activity for this date range."
//               hint="Try changing the date range or view today's activity."
//               action={<button className="btn" onClick={…}>View today</button>} />
// ---------------------------------------------------------------------------
export default function EmptyState({ icon = '🗂️', title, hint, action, compact = false }) {
  return (
    <div className={`empty-st${compact ? ' compact' : ''}`}>
      <div className="empty-st-icon" aria-hidden="true">{icon}</div>
      <div className="empty-st-title">{typeof title === 'string' ? tr(title) : title}</div>
      {hint && <div className="empty-st-hint">{typeof hint === 'string' ? tr(hint) : hint}</div>}
      {action && <div className="empty-st-action">{action}</div>}
    </div>
  );
}
