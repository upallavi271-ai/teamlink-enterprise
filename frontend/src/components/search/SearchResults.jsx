import { Link } from 'react-router-dom';
import { drawerTarget } from './historyOpen.jsx';

// ---------------------------------------------------------------------------
// THE ONE RESULT COMPONENT. The top bar's dropdown, the dashboard bar's dropdown and the full results page all draw a result with <ResultRow>.
// A result opens its COMPLETE HISTORY (`to`); the plain record is one click away (`recordTo`, "Open record"). Nothing here decides what a login may
// see: the server never sends a record the login may not open.
// ---------------------------------------------------------------------------
export const TYPE_WORD = {
  person: 'PERSON', employee: 'EMPLOYEE', client: 'CLIENT', requirement: 'REQUIREMENT', candidate: 'CANDIDATE', interview: 'INTERVIEW', offer: 'OFFER', joining: 'JOINING',
  invoice: 'INVOICE', agreement: 'AGREEMENT', followup: 'FOLLOW-UP', document: 'DOCUMENT', task: 'TASK',
};
export const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');

const numbers = (r) => {
  if (r.type === 'candidate') return [[r.applications, 'applications'], [r.selected, 'selected now'], [r.joined, 'joined'], [r.rejected, 'rejected']];
  if (r.type === 'requirement' && r.headline) return [[r.headline.shared, 'shared'], [r.headline.selected, 'selected'], [r.headline.joined, 'joined'], [r.headline.dropped, 'dropped']];
  if (r.type === 'client' && r.requirements !== undefined) return [[r.requirements, 'requirements'], [r.open, 'open']];
  return [];
};

export function ResultRow({
  r, active = false, compact = false, onOpen, id, onHover,
}) {
  const nums = compact ? [] : numbers(r);
  // a plain click opens the history in the drawer over this page; Ctrl / Shift / middle click keeps the link's own way (a new tab with the full page)
  const openHere = (e) => {
    if (!onOpen || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !drawerTarget(r)) return;
    e.preventDefault();
    onOpen(r);
  };
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={`sr-row${active ? ' on' : ''}${compact ? ' compact' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={compact ? (e) => { e.preventDefault(); if (onOpen) onOpen(r); } : undefined}
    >
      <div className="sr-main">
        <span className="sr-type">{TYPE_WORD[r.type] || String(r.type).toUpperCase()}</span>
        {compact ? <span className="sr-name">{r.title || r.name}</span> : <Link className="sr-name" to={r.to} onClick={openHere}>{r.title || r.name}</Link>}
        {r.code && <span className="sr-code">{r.code}</span>}
      </div>
      {r.sub && <div className="sr-sub">{r.sub}</div>}
      {!compact && r.via && r.via.length > 0 && <div className="sr-sub">Found in: {r.via.join(', ')}</div>}
      {!compact && r.matchedOldName && <div className="sr-sub">Found by an old name of the client</div>}
      {!compact && (
        <div className="sr-actions">
          {nums.length > 0 && <span className="sr-nums">{nums.map(([n, l]) => <span key={l}><b>{fmtN(n)}</b> {l}</span>)}</span>}
          <Link className="btn btn-sm btn-primary" to={r.to} onClick={openHere}>Open history</Link>
          {r.recordTo && <Link className="btn btn-sm" to={r.recordTo}>Open record</Link>}
        </div>
      )}
    </div>
  );
}

// the groups as a list (the full page draws one tab at a time; the dropdown draws them all, compact)
export function GroupRows({
  groups, compact = false, active = -1, onOpen, startIndex = 0, idPrefix = 'sr-opt', onHover,
}) {
  let i = startIndex - 1;
  return groups.map((g) => (
    <div className="sr-group" key={g.id}>
      <div className="sr-head"><span className="sr-gtitle">{g.title}</span><span className="sr-count">{g.more ? `${fmtN(g.count)}+` : fmtN(g.count)}</span></div>
      {g.rows.map((r) => {
        i += 1;
        const idx = i;
        return <ResultRow key={`${g.id}-${r.id}`} r={r} compact={compact} active={idx === active} id={`${idPrefix}-${idx}`} onOpen={onOpen ? (row) => onOpen(row, g) : undefined} onHover={onHover ? () => onHover(idx) : undefined} />;
      })}
    </div>
  ));
}
