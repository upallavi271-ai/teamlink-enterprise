import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { PanelPad, EmptyMini } from '../../components/proto.jsx';

// ---------------------------------------------------------------------------
// THE FOLLOW-UP DASHBOARD (§21-§25) and DO THIS NOW (§27).
//
// The shape of this page is decided by the SERVER, from the caller's role —
// /followups/dashboard answers with `mine` for everybody, `team` for a lead,
// `health` for an admin and `escalation` for a Super Admin. Asking the browser
// to choose would be a lie, because a recruiter requesting the admin view
// would still only be answered about their own scope.
//
// DO THIS NOW IS FIRST AND IT IS SHORT. The whole point of §27 is that a user
// should not have to go looking for their own work: at most five things, most
// overdue first, each with one button.
// ---------------------------------------------------------------------------

const TONE = {
  Overdue: 'fu-overdue',
  'Due Today': 'fu-due',
  Upcoming: 'fu-upcoming',
  Completed: 'fu-done',
};
const DOT = {
  Overdue: '🔴', 'Due Today': '🟠', Upcoming: '🟡', Completed: '🟢',
};

function Tiles({ t }) {
  return (
    <div className="fu-tiles">
      {[
        ['Overdue', t.overdue], ['Due Today', t.dueToday],
        ['Upcoming', t.upcoming], ['Completed', t.completed],
      ].map(([label, n]) => (
        <div className={`fu-tile ${TONE[label]}`} key={label}>
          <span className="fu-tile-n">{n}</span>
          <span className="fu-tile-l">{DOT[label]} {label}</span>
        </div>
      ))}
    </div>
  );
}

function Rows({ rows, empty }) {
  if (!rows.length) return <EmptyMini>{empty}</EmptyMini>;
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>Due</th>
            <th>Person</th>
            <th>Purpose</th>
            <th style={{ width: 110 }}>Method</th>
            <th style={{ width: 120 }}>Status</th>
            <th style={{ width: 110 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.applicationId}>
              <td className="cell-muted">
                {f.dueDate || '—'}{f.dueTime ? ` ${f.dueTime}` : ''}
              </td>
              <td className="row-link">
                <Link to={`/candidates/${f.candidateId}`}>{f.candidateName}</Link>
                <div className="small-muted" style={{ fontSize: 11 }}>{f.requirementTitle}</div>
              </td>
              <td className="cell-muted">{f.purpose || f.nextAction}</td>
              <td className="cell-muted">{f.contactMode || '—'}</td>
              <td><span className={`fu-chip ${TONE[f.status]}`}>{DOT[f.status]} {f.status}</span></td>
              <td>
                <Link className="btn btn-sm btn-primary" to={`/candidates/${f.candidateId}`}>
                  {f.status === 'Upcoming' ? 'View' : 'Contact'}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FollowUps() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get('/followups/dashboard')
      .then((r) => setData(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Follow-ups are not included in your role’s permissions.'));
  }, []);
  useEffect(load, [load]);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading follow-ups…</div>;

  return (
    <div>
      <div className="breadcrumb">ATS / Follow-ups</div>
      <div className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <div className="page-sub">
            <b className="scope-tag">Scope: {data.scope}</b>
            {' · '}Who to contact, why, and by when.
          </div>
        </div>
      </div>

      {/* §27 — first, short, and each one has a button. */}
      <div className="card section do-now">
        <h3>🔴 Do This Now</h3>
        {data.doThisNow.length === 0
          ? <EmptyMini>Nothing is overdue or due today. Your upcoming work is below.</EmptyMini>
          : (
            <ol className="do-now-list">
              {data.doThisNow.map((d) => (
                <li key={d.applicationId}>
                  <span className="do-now-what">
                    <b>{d.what}</b>
                    <span className="small-muted"> — {d.why}</span>
                  </span>
                  <span className={`fu-chip ${TONE[d.status]}`}>{DOT[d.status]} {d.status}{d.due ? ` · ${d.due}` : ''}</span>
                  <Link className="btn btn-sm btn-primary" to={`/candidates/${d.candidateId}`}>Contact</Link>
                </li>
              ))}
            </ol>
          )}
      </div>

      {/* §21 */}
      <PanelPad style={{ marginTop: 14 }}>
        <h3>My Follow-ups</h3>
        <Tiles t={data.mine} />
        <Rows rows={data.mine.rows} empty="Nothing assigned to you right now." />
      </PanelPad>

      {/* §22 / §23 — who has not followed up, answered directly. */}
      {data.team && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>{data.team.label}</h3>
          <Tiles t={data.team} />
          {data.team.owners.length === 0
            ? <EmptyMini>Nobody else has follow-ups in your scope.</EmptyMini>
            : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Owner</th><th style={{ width: 120 }}>Role</th>
                      <th style={{ width: 110 }}>🔴 Overdue</th>
                      <th style={{ width: 110 }}>🟠 Due Today</th>
                      <th style={{ width: 110 }}>🟡 Upcoming</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.team.owners.map((o) => (
                      <tr key={o.ownerUserId || o.owner}>
                        <td><b>{o.owner}</b></td>
                        <td className="cell-muted">{o.ownerRole}</td>
                        <td className={o.overdue ? 'fu-num-bad' : 'cell-muted'}>{o.overdue}</td>
                        <td className="cell-muted">{o.dueToday}</td>
                        <td className="cell-muted">{o.upcoming}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </PanelPad>
      )}

      {/* §24 */}
      {data.health && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>Follow-up Health</h3>
          <Tiles t={data.health} />
          <div className="small-muted">
            <b>{data.health.unassigned}</b> unassigned
            {' · '}
            <b>{data.health.escalated}</b> escalated past their owner.
            {data.health.unassigned > 0 && ' An unassigned follow-up is the one that will certainly be missed.'}
          </div>
        </PanelPad>
      )}

      {/* §25 — only genuinely unresolved items are on the ladder. */}
      {data.escalation && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>Escalation Monitor</h3>
          <div className="fu-ladder">
            {data.escalation.map((r) => (
              <div className={`fu-rung${r.count ? ' has-any' : ''}`} key={r.level}>
                <span className="fu-rung-n">{r.count}</span>
                <span className="fu-rung-l">
                  Level {r.level} — {r.label}
                  {r.afterDays ? <span className="small-muted"> · after {r.afterDays}d</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            A follow-up leaves this ladder when it is completed. Escalating tells somebody else — it never moves
            the work, and the original owner stays responsible.
          </div>
        </PanelPad>
      )}
    </div>
  );
}
