import { Link } from 'react-router-dom';
import './clients.css';

// ---------------------------------------------------------------------------
// §9 — the client's business relationship, shared by the Clients list and the
// Client Detail header. Every number is computed by the server
// (routes/clients.js clientWorkload) in the viewer's own scope.
// ---------------------------------------------------------------------------

// "26 Sep" (this year) / "26 Sep 2025".
export function shortDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
}

// "26 Sep · Kiran Kumar" (spec §6 style).
export function lastActivityText(c) {
  if (!c || !c.lastActivityAt) return '';
  return [shortDate(c.lastActivityAt), c.lastActivityBy].filter(Boolean).join(' · ');
}

// A count that links to the tab that lists those rows; a zero is quiet.
export function RelNum({ value, to, title }) {
  const n = Number(value) || 0;
  // Never a bare zero (simplicity checklist #8): a quiet dash instead.
  if (!n) return <span className="clrel-zero" title="None yet">—</span>;
  return to
    ? <Link to={to} title={title} onClick={(e) => e.stopPropagation()}>{n.toLocaleString('en-IN')}</Link>
    : <span title={title}>{n.toLocaleString('en-IN')}</span>;
}

// The header strip on Client Detail. `onTab(key)` switches the detail tab.
// A number the server did not send for this role (clients role spec §5: no
// pipeline numbers for Accounts, no guarantee for a TL, no amounts for a
// BDE) draws no card; a card links only to a tab in `tabs` (when given).
export function RelationshipStrip({ s, onTab, tabs = null }) {
  if (!s) return null;
  const has = (k) => s[k] !== undefined;
  const linkable = (t) => (t && (!tabs || tabs.includes(t)) ? t : null);
  const card = (key, label, value, sub, rawTab) => {
    const tab = linkable(rawTab);
    return (
    tab
      ? (
        <button type="button" key={key} className="clhead-card" onClick={() => onTab(tab)} title={`Open ${label}`}>
          <span className="k">{label}</span><span className="v">{value}</span>{sub ? <span className="s">{sub}</span> : null}
        </button>
      )
      : (
        <div key={key} className="clhead-card">
          <span className="k">{label}</span><span className="v">{value}</span>{sub ? <span className="s">{sub}</span> : null}
        </div>
      )
    );
  };
  // Spec 6 + simplicity checklist: five plain numbers, and a number that is
  // zero is not drawn at all (never a bare zero). Pending decisions, invoices,
  // guarantee and last activity live in their own tabs.
  const cards = [
    card('req', 'Open jobs', s.activeRequirements, s.totalRequirements ? `of ${s.totalRequirements} jobs` : null, 'requirements'),
    has('candidatesSubmitted') && s.candidatesSubmitted ? card('sub', 'People sent', s.candidatesSubmitted, null, 'candidates') : null,
    has('clientInterviews') && s.clientInterviews ? card('int', 'Interviews', s.clientInterviews, null, 'interviews') : null,
    has('selectedCount') && s.selectedCount ? card('sel', 'Selected', s.selectedCount, null, 'selected') : null,
    s.joinedCount ? card('join', 'Joined', s.joinedCount, null, 'selected') : null,
  ].filter((x, k) => x && (k > 0 || s.activeRequirements));
  if (!cards.length) return null;
  return (
    <div className="clhead-strip">
      {cards}
    </div>
  );
}
