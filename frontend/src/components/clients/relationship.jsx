import { Link } from 'react-router-dom';
import { inr } from '../../utils/csv';
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
  if (!n) return <span className="clrel-zero">0</span>;
  return to
    ? <Link to={to} title={title} onClick={(e) => e.stopPropagation()}>{n.toLocaleString('en-IN')}</Link>
    : <span title={title}>{n.toLocaleString('en-IN')}</span>;
}

// The header strip on Client Detail. `onTab(key)` switches the detail tab.
// A number the server did not send for this role (clients role spec §5: no
// pipeline numbers for Accounts, no guarantee for a TL, no amounts for a
// BDE) draws no card; a card links only to a tab in `tabs` (when given).
export function RelationshipStrip({ s, onTab, guaranteePeriod, tabs = null }) {
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
  const inv = s.invoiceSummary;
  const invSub = !inv ? null
    : inv.outstanding !== undefined
      ? (inv.outstanding > 0 ? `${inr(inv.outstanding)} outstanding${inv.overdue ? ` · ${inv.overdue} overdue` : ''}` : 'nothing outstanding')
      : (inv.count ? `${inv.status || '—'} · ${inv.paid} paid · ${inv.pending} pending` : 'none raised');
  return (
    <div className="clhead-strip">
      {card('req', 'Active Requirements', s.activeRequirements ?? 0, `of ${s.totalRequirements ?? 0} total`, 'requirements')}
      {has('candidatesSubmitted') && card('sub', 'Candidates Submitted', s.candidatesSubmitted ?? 0, 'shared with the client', 'candidates')}
      {has('clientInterviews') && card('int', 'Client Interviews', s.clientInterviews ?? 0, null, 'interviews')}
      {has('selectedCount') && card('sel', 'Selected', s.selectedCount ?? 0, null, 'selected')}
      {card('join', 'Joined', s.joinedCount ?? 0, null, 'selected')}
      {has('pendingDecisions') && card('pend', 'Pending Decisions', s.pendingDecisions ?? 0,
        `${s.awaitingDecision ?? 0} profile · ${s.awaitingFeedback ?? 0} feedback`, 'candidates')}
      {inv && card('inv', 'Invoices', inv.count, invSub, 'invoices')}
      {has('guaranteeDays') && card('gua', 'Replacement / Guarantee', guaranteePeriod || '—',
        s.inGuarantee ? `${s.inGuarantee} joining(s) in guarantee${s.guaranteeEnds ? ` · first ends ${shortDate(s.guaranteeEnds)}` : ''}` : 'none in guarantee now', 'replacements')}
      {card('last', 'Last Activity', s.lastActivityAt ? shortDate(s.lastActivityAt) : '—',
        [s.lastActivityBy, s.lastActivityWhat].filter(Boolean).join(' · ') || null, 'activity')}
    </div>
  );
}
