import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { PanelPad, EmptyMini } from '../../components/proto.jsx';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../../components/HierarchyFilter.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';

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

// FILTERS (user notes #1 / #11, review #3 §14 / §21 / §22).
//   Page level   Department → Section → TL → Recruiter (HierarchyFilter — a
//                recruiter sees no levels; a TL only their own recruiters),
//                sent to the server, so every panel below narrows together.
//   My Follow-ups  Search · Status · Method | More: Stage · Client (client desk
//                only) · Due date range, Sort, 25/50/100 rows.
//   Team table   Search owner · Role, 25/50/100 rows.
const MINE_SORTS = [
  { key: 'urgent', label: 'Most urgent first', cmp: null },
  { key: 'due', label: 'Due date — soonest', cmp: (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) },
  { key: 'dueLate', label: 'Due date — latest', cmp: (a, b) => String(b.dueDate || '').localeCompare(String(a.dueDate || '')) },
  { key: 'name', label: 'Candidate A–Z', cmp: (a, b) => String(a.candidateName || '').localeCompare(String(b.candidateName || '')) },
];

function Rows({ rows, empty }) {
  if (!rows.length) return empty && typeof empty === 'object' ? empty : <EmptyMini>{empty}</EmptyMini>;
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
  const { user } = useAuth();
  const clientDesk = can(user, null, 'clients', 'Client List', 'view');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [hier, setHier] = useState(EMPTY_HIERARCHY);
  const tree = useHierarchy();
  const hierKey = JSON.stringify(toParams(hier, tree.data));
  const lv = (tree.data && tree.data.viewer && tree.data.viewer.levels) || {};
  const showHier = !!(lv.department || lv.section || lv.tl || lv.recruiter);

  const load = useCallback(() => {
    api.get('/followups/dashboard', { params: { rows: 'all', ...JSON.parse(hierKey) } })
      .then((r) => { setData(r.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Follow-ups are not included in your role’s permissions.'));
  }, [hierKey]);
  useEffect(load, [load]);

  const mineLf = useListFilters((data && data.mine && data.mine.rows) || [], [
    { key: 'q', type: 'search', placeholder: 'Search candidate, requirement or purpose…', get: (f) => `${f.candidateName || ''} ${f.requirementTitle || ''} ${f.requirementCode || ''} ${f.purpose || f.nextAction || ''}` },
    { key: 'status', label: 'Status', primary: true, get: (f) => f.status, options: ['Overdue', 'Due Today', 'Upcoming', 'Completed'] },
    { key: 'method', label: 'Method', primary: true, get: (f) => f.contactMode },
    { key: 'stage', label: 'Stage', get: (f) => f.stageLabel },
    { key: 'client', label: 'Client', get: (f) => f.clientName, show: clientDesk },
    { key: 'due', type: 'daterange', label: 'Due date', get: (f) => f.dueDate },
  ], { sorts: MINE_SORTS });
  const minePage = usePaged(mineLf.rows);

  const teamLf = useListFilters((data && data.team && data.team.owners) || [], [
    { key: 'q', type: 'search', placeholder: 'Search owner…', get: (o) => o.owner },
    { key: 'role', label: 'Role', primary: true, get: (o) => o.ownerRole },
  ], {
    sorts: [
      { key: 'overdue', label: 'Most overdue first', cmp: null },
      { key: 'name', label: 'Owner A–Z', cmp: (a, b) => String(a.owner || '').localeCompare(String(b.owner || '')) },
    ],
  });
  const teamPage = usePaged(teamLf.rows);

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
        {/* Template · Import · Export: every follow-up in your scope
            (GET /followups) and follow-up updates recorded as the dialog does. */}
        <AtsDataTools module="followups" kinds={['followups']} onImported={load} />
      </div>

      {/* Department → Section → TL → Recruiter — draws nothing for a login
          that only sees its own follow-ups. Narrows every panel below. */}
      {showHier && (
        <div className="filter-row">
          <HierarchyFilter value={hier} onChange={setHier} />
        </div>
      )}
      <FilterChips filters={hierarchyChips(hier, tree.data, setHier)} onClearAll={() => setHier(EMPTY_HIERARCHY)} />

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
        <ListFilterBar lf={mineLf} storageKey="fu-mine" noun="follow-ups" />
        <Rows
          rows={minePage.slice}
          empty={mineLf.activeCount ? <ListEmpty lf={mineLf} noun="follow-ups" /> : 'Nothing assigned to you right now.'}
        />
        {mineLf.rows.length > 0 && <Pager page={minePage} noun="follow-ups" />}
      </PanelPad>

      {/* §22 / §23 — who has not followed up, answered directly. */}
      {data.team && (
        <PanelPad style={{ marginTop: 14 }}>
          <h3>{data.team.label}</h3>
          <Tiles t={data.team} />
          {data.team.owners.length > 0 && <ListFilterBar lf={teamLf} storageKey="fu-team" noun="owners" />}
          {data.team.owners.length === 0
            ? <EmptyMini>Nobody else has follow-ups in your scope.</EmptyMini>
            : teamLf.rows.length === 0 ? <ListEmpty lf={teamLf} noun="owners" /> : (
              <>
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
                    {teamPage.slice.map((o) => (
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
              <Pager page={teamPage} noun="owners" />
              </>
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
