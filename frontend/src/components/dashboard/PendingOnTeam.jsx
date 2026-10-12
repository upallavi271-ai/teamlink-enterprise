import { Link } from 'react-router-dom';
import '../team/pendingWork.css';

// ---------------------------------------------------------------------------
// DASHBOARD -> "Pending on my team" (widget type 'chain', from GET /dashboard/ats/home).
//   Waiting for you           approvals / offers / follow-ups that are the viewer's to do
//   Waiting on your people    the same, sitting with someone on the team
// Each row: what, who it is with, a coloured "waiting 2 days" tag, an Open link.
// Orange under a day (and 1 day), red from 2 days.
// ---------------------------------------------------------------------------

const KIND_WORD = { approval: 'Approval', offer: 'Offer', followup: 'Follow-up' };

// red when the wait is 2 days or more, orange otherwise.
export function waitTone(waited) {
  const m = /(\d+)\s*(day|week|month)/i.exec(String(waited || ''));
  if (!m) return 'orange';
  const n = Number(m[1]);
  if (/week|month/i.test(m[2])) return 'red';
  return n >= 2 ? 'red' : 'orange';
}

function Row({ r }) {
  return (
    <li className="pwk-pot-row">
      <div className="pwk-pot-main">
        <span className="pwk-pot-kind">{KIND_WORD[r.kind] || 'Pending'}</span>
        {' '}
        <span>{r.text}</span>
        {r.waitingOn && <span className="small-muted">{` · with ${r.waitingOn}`}</span>}
      </div>
      {r.waited && <span className={`pwk-tag pwk-tag-${waitTone(r.waited)}`}>{`waiting ${r.waited}`}</span>}
      {r.to && <Link className="btn btn-sm" to={r.to}>Open</Link>}
    </li>
  );
}

function Group({ title, rows }) {
  if (!rows.length) return null;
  return (
    <div className="pwk-pot-group">
      <div className="pwk-pot-title">{`${title} (${rows.length})`}</div>
      <ul className="pwk-pot-list">{rows.map((r) => <Row key={r.id} r={r} />)}</ul>
    </div>
  );
}

export default function PendingOnTeam({ w }) {
  const rows = w.rows || [];
  const mine = rows.filter((r) => r.mine);
  const team = rows.filter((r) => !r.mine);
  return (
    <div className="panel ah-panel">
      <div className="panel-head"><h3>{w.title || 'Pending on my team'}</h3></div>
      <div className="pwk-pot">
        {!rows.length ? (
          <div className="pwk-pot-zero"><span className="pwk-tick" aria-hidden="true">✓</span> {w.zero || 'Nothing is pending on your team.'}</div>
        ) : (
          <>
            <Group title="Waiting for you" rows={mine} />
            <Group title="Waiting on your people" rows={team} />
            {w.more > 0 && <div className="small-muted">{`and ${w.more} more.`}</div>}
          </>
        )}
      </div>
    </div>
  );
}
